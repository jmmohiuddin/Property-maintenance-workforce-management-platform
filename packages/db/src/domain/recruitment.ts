import { and, asc, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { db, type TenantScopedTx, type TenantContext } from "../index";
import * as schema from "../schema";
import { writeAuditNote } from "./staff";
import { requiredRowDate, rowDate } from "./_rows";
import {
  CANDIDATE_GRADES,
  CERTIFICATION_EXPIRY_WINDOW_DAYS,
  DEFAULT_PIPELINE,
  DISPOSITION_BY_CODE,
  MAX_PIPELINE_STAGES,
  OUTCOME_MINIMUM_DELAY_HOURS,
  TALENT_POOL_RECONFIRM_DAYS,
  UserFacingError,
  blockedState,
  isDownloadable,
  outcomeMessage,
  phoneLocalDigits,
  type Availability,
  type BlockedOn,
  type CandidateGrade,
  type ContractType,
  type ExperienceBand,
  type PublicRequisition,
  type RequisitionStatus,
  type ScanStatus,
  type TalentPoolCertFilter,
  type VisaStatus,
} from "@meridian/core";

/**
 * Recruitment — M9, `ATS-1`…`ATS-19`.
 *
 * ── THE ONE THING THIS MODULE EXISTS TO PREVENT ─────────────────────────────
 *
 * An applicant who is never told anything. `ATS-16` targets 100% (`G14`);
 * around 65% of applicants never or rarely hear back, and roughly 80% say they
 * would not reapply to a company that ghosted them. In a referral-driven trades
 * market that is not a courtesy problem, it is a supply problem.
 *
 * The reason every ATS misses this target is not that recruiters are careless.
 * It is that **"nobody replied to this person" is not normally a state a
 * database holds** — nothing is written when nothing happens, so there is
 * nothing to query, nothing to report, and the whole obligation rests on
 * somebody remembering at the end of a busy week.
 *
 * So the design rule for this file is: *the absence must be a row*.
 *
 *   * Every application is born with `outcome_due_at` set from the promise the
 *     applicant was shown. There is no path that creates one without a clock.
 *   * `closeApplication` is the only way out of `active`, and it always
 *     composes and schedules an outcome. There is no `sendMessage: false`
 *     parameter, because a parameter that can be false is a parameter that will
 *     be false at 18:40 on a Thursday.
 *   * `outcomeAccountability` reports the gap, including the applicants who
 *     have **no reachable channel** — a bucket most systems would quietly
 *     count as satisfied.
 *
 * ── THE OTHER STRUCTURAL RULE: `HR-16` ──────────────────────────────────────
 *
 * Recruitment costs are never charged to or recovered from a worker, directly
 * or indirectly (Article 6, Federal Decree-Law 33/2021). There is no
 * candidate-payable field in the schema, `recruitment_costs.borne_by` is
 * CHECK-ed to a single value, and `recordRecruitmentCost` below takes no
 * argument that could express one. It is not validated; it is unrepresentable.
 */

// ── The public surface (no session, no tenant GUC) ──────────────────────────

/**
 * Every one of these goes through a `SECURITY DEFINER` function.
 *
 * An unauthenticated visitor has no tenant context, so RLS denies them
 * everything — which is correct, and is why the bootstrap has to be explicit.
 * What is deliberately *not* done here is what the quote form does: resolve the
 * tenant and then open a `withTenant()` transaction. That works, and it means
 * an anonymous HTTP request carries the tenant's full row-level-security scope
 * for the rest of its transaction. For an applicant record holding a phone
 * number and certificate numbers, the narrower surface is worth the extra SQL.
 *
 * See `sql/public-functions.sql`.
 */

type PublicRoleRow = {
  public_slug: string;
  title: string;
  trade: string;
  grade: string;
  contract_type: string;
  headcount: number;
  location_city: string;
  location_area: string | null;
  min_experience_years: number | null;
  summary: string | null;
  responsibilities: string | null;
  physical_requirements: string | null;
  required_certifications: unknown;
  salary_band_min_minor: string | number | null;
  salary_band_max_minor: string | number | null;
  currency: string;
  opens_at: string | Date | null;
  closes_at: string | Date | null;
};

function toPublicRequisition(row: PublicRoleRow): PublicRequisition {
  const certifications = Array.isArray(row.required_certifications)
    ? row.required_certifications.filter((c): c is string => typeof c === "string")
    : [];

  return {
    slug: row.public_slug,
    title: row.title,
    trade: row.trade,
    grade: row.grade as CandidateGrade,
    contractType: row.contract_type as ContractType,
    headcount: Number(row.headcount),
    city: row.location_city,
    area: row.location_area,
    minExperienceYears: row.min_experience_years === null ? null : Number(row.min_experience_years),
    summary: row.summary,
    responsibilities: row.responsibilities,
    physicalRequirements: row.physical_requirements,
    requiredCertifications: certifications,
    salaryMinMinor: row.salary_band_min_minor === null ? null : Number(row.salary_band_min_minor),
    salaryMaxMinor: row.salary_band_max_minor === null ? null : Number(row.salary_band_max_minor),
    currency: row.currency,
    opensAt: row.opens_at ? new Date(row.opens_at) : null,
    closesAt: row.closes_at ? new Date(row.closes_at) : null,
  };
}

/** Open roles for the careers site (`ATS-2`). Published fields only. */
export async function listPublicRoles(tenantId: string): Promise<readonly PublicRequisition[]> {
  const rows = (await db.execute<PublicRoleRow>(
    sql`select * from app_public_open_roles(${tenantId})`,
  )) as unknown as PublicRoleRow[];
  return rows.map(toPublicRequisition);
}

export async function getPublicRole(
  tenantId: string,
  slug: string,
): Promise<PublicRequisition | null> {
  const roles = await listPublicRoles(tenantId);
  return roles.find((r) => r.slug === slug) ?? null;
}

export interface PublicApplicationInput {
  readonly roleSlug: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly trade: string;
  readonly grade: CandidateGrade;
  readonly experienceBand: ExperienceBand;
  readonly currentLocation: string;
  readonly availability: Availability;
  readonly hasDrivingLicence: boolean;
  readonly essentialFunctions: "yes" | "discuss";
  readonly certificates: readonly {
    scheme: string;
    certificateNo?: string | undefined;
    level?: string | undefined;
    issuingBody?: string | undefined;
    /** `YYYY-MM`. */
    expiresOn: string;
  }[];
  readonly talentPoolConsent: boolean;
  readonly source?: string | undefined;
}

export interface SubmittedApplication {
  readonly applicationId: string;
  readonly candidateId: string;
  readonly reference: string;
  readonly statusToken: string;
  readonly outcomeDueAt: Date;
  /** True when this was a re-submission of a live application, not a new one. */
  readonly wasExisting: boolean;
}

/**
 * Does this error, or anything it wraps, carry this SQLSTATE?
 *
 * Drizzle wraps driver errors, and a future version may wrap them again. Depth
 * is bounded so a self-referential `cause` cannot spin.
 */
function isSqlState(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (typeof current === "object" && "code" in current && (current as { code?: unknown }).code === code) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export class RoleClosedError extends UserFacingError {
  constructor() {
    super(
      "This role is no longer accepting applications. Have a look at the other open roles — we hire regularly.",
    );
    this.name = "RoleClosedError";
  }
}

/**
 * Record a public application (`ATS-3`).
 *
 * The whole unit of work happens inside one `SECURITY DEFINER` call: match or
 * create the candidate, write the application, write the certificates, write
 * the consent row, write the activity event. Either all of it lands or none of
 * it does, and no tenant GUC is ever set on the anonymous request.
 *
 * The acknowledgement (`ATS-14`) is deliberately **not** sent from here. It is
 * swept by `/api/cron/recruitment`, which runs as `system` with a real tenant
 * context. That is slower by minutes and durable by construction: an
 * acknowledgement fired best-effort from the request is an acknowledgement lost
 * whenever the request dies between the commit and the enqueue, and the
 * applicant has no way of knowing it happened.
 */
export async function submitApplication(
  tenantId: string,
  input: PublicApplicationInput,
): Promise<SubmittedApplication> {
  const certificates = input.certificates.map((c) => ({
    scheme: c.scheme,
    certificateNo: c.certificateNo ?? null,
    level: c.level ?? null,
    issuingBody: c.issuingBody ?? null,
    expiresOn: c.expiresOn,
  }));

  /*
   * `out_`-prefixed, matching the function's OUT parameters. They are prefixed
   * there because plpgsql cannot disambiguate a bare `candidate_id` between an
   * OUT parameter and a table column, and `ON CONFLICT (candidate_id, …)` is a
   * position where a column name cannot be qualified.
   */
  let rows: {
    out_application_id: string;
    out_candidate_id: string;
    out_reference: string;
    out_status_token: string;
    out_outcome_due_at: string | Date;
    out_was_existing: boolean;
  }[];

  try {
    rows = (await db.execute(sql`
      select * from app_public_submit_application(
        ${tenantId},
        ${input.roleSlug},
        ${input.fullName},
        ${input.phone},
        ${input.email},
        ${input.trade},
        ${input.grade},
        ${input.experienceBand},
        ${input.currentLocation},
        ${input.availability},
        ${input.hasDrivingLicence},
        ${input.essentialFunctions},
        ${JSON.stringify(certificates)}::jsonb,
        ${input.talentPoolConsent},
        ${input.source ?? "careers_site"}
      )
    `)) as unknown as typeof rows;
  } catch (error) {
    // `no_data_found` (SQLSTATE P0002) is the function's way of saying the role
    // closed between the page render and the submit, which is an ordinary race
    // on a vacancy that is being filled. Everything else is ours.
    //
    // The chain has to be walked. Drizzle wraps the driver error in a
    // `DrizzleQueryError`, so the SQLSTATE is on `cause`, not on the object
    // thrown — an earlier version checked only the top level, never matched,
    // and told an applicant "something went wrong on our side" when the honest
    // answer was "this role has been filled, here are the others". The test
    // that applies to a non-existent role is what caught it.
    if (isSqlState(error, "P0002")) throw new RoleClosedError();
    throw error;
  }

  const row = rows[0];
  if (!row) throw new Error("Application submission returned no row");

  return {
    applicationId: row.out_application_id,
    candidateId: row.out_candidate_id,
    reference: row.out_reference,
    statusToken: row.out_status_token,
    outcomeDueAt: new Date(row.out_outcome_due_at),
    wasExisting: row.out_was_existing,
  };
}

export interface ApplicantStatusView {
  readonly reference: string;
  readonly roleTitle: string;
  readonly roleSlug: string;
  readonly candidateFirstName: string;
  readonly appliedAt: string;
  readonly status: "active" | "archived" | "hired";
  readonly outcomeDueAt: string;
  readonly outcomeSentAt: string | null;
  readonly outcomeMessage: string | null;
  readonly blockedOn: BlockedOn;
  readonly blockedNote: string | null;
  readonly currentStageSequence: number | null;
  readonly stages: readonly { name: string; sequence: number; reached: boolean }[];
}

/**
 * What the applicant sees at `/careers/application/<token>` (`ATS-16`).
 *
 * No account, because an account is a password a tradesperson will not create
 * for one application, and a password nobody creates is a status page nobody
 * reads. One random token, one application, read-only.
 */
export async function applicationStatusByToken(
  token: string,
): Promise<ApplicantStatusView | null> {
  if (!token || token.length < 32) return null;

  const rows = (await db.execute<{ app_public_application_status: ApplicantStatusView | null }>(
    sql`select app_public_application_status(${token})`,
  )) as unknown as { app_public_application_status: ApplicantStatusView | null }[];

  return rows[0]?.app_public_application_status ?? null;
}

// ── ATS-1: requisitions ─────────────────────────────────────────────────────

export interface RequisitionRow {
  readonly id: string;
  readonly reference: string;
  readonly publicSlug: string;
  readonly title: string;
  readonly trade: string;
  readonly grade: string;
  readonly headcount: number;
  readonly contractType: string;
  readonly locationCity: string;
  readonly locationArea: string | null;
  readonly status: RequisitionStatus;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
  readonly approvedAt: Date | null;
  readonly hiringManagerUserId: string | null;
}

const requisitionColumns = {
  id: schema.jobRequisitions.id,
  reference: schema.jobRequisitions.reference,
  publicSlug: schema.jobRequisitions.publicSlug,
  title: schema.jobRequisitions.title,
  trade: schema.jobRequisitions.trade,
  grade: schema.jobRequisitions.grade,
  headcount: schema.jobRequisitions.headcount,
  contractType: schema.jobRequisitions.contractType,
  locationCity: schema.jobRequisitions.locationCity,
  locationArea: schema.jobRequisitions.locationArea,
  status: schema.jobRequisitions.status,
  opensAt: schema.jobRequisitions.opensAt,
  closesAt: schema.jobRequisitions.closesAt,
  approvedAt: schema.jobRequisitions.approvedAt,
  hiringManagerUserId: schema.jobRequisitions.hiringManagerUserId,
};

export async function listRequisitions(
  tx: TenantScopedTx,
  options?: { includeClosed?: boolean },
): Promise<readonly RequisitionRow[]> {
  const rows = await tx
    .select(requisitionColumns)
    .from(schema.jobRequisitions)
    .where(
      options?.includeClosed
        ? isNull(schema.jobRequisitions.deletedAt)
        : and(
            isNull(schema.jobRequisitions.deletedAt),
            sql`${schema.jobRequisitions.status} not in ('cancelled', 'filled')`,
          ),
    )
    .orderBy(desc(schema.jobRequisitions.createdAt));

  return rows as RequisitionRow[];
}

export async function getRequisition(
  tx: TenantScopedTx,
  requisitionId: string,
): Promise<RequisitionRow | null> {
  const rows = await tx
    .select(requisitionColumns)
    .from(schema.jobRequisitions)
    .where(eq(schema.jobRequisitions.id, requisitionId))
    .limit(1);
  return (rows[0] as RequisitionRow | undefined) ?? null;
}

/**
 * Turn a title into a URL segment, then make it unique in the tenant.
 *
 * Two "AC Technician" requisitions six months apart are normal, and the second
 * one must not silently take over the first one's URL — an indexed careers page
 * that starts pointing at a different vacancy is worse than a 404.
 */
async function uniquePublicSlug(tx: TenantScopedTx, title: string): Promise<string> {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "role";

  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const clash = await tx
      .select({ id: schema.jobRequisitions.id })
      .from(schema.jobRequisitions)
      .where(eq(schema.jobRequisitions.publicSlug, candidate))
      .limit(1);
    if (clash.length === 0) return candidate;
  }
  throw new UserFacingError("Could not find a free web address for this role. Rename it slightly.");
}

export interface CreateRequisitionInput {
  readonly title: string;
  readonly trade: string;
  readonly grade: CandidateGrade;
  readonly headcount: number;
  readonly contractType: ContractType;
  readonly locationCity: string;
  readonly locationArea?: string | undefined;
  readonly minExperienceYears?: number | undefined;
  readonly requiredCertifications?: readonly string[] | undefined;
  readonly salaryBandMinMinor?: number | undefined;
  readonly salaryBandMaxMinor?: number | undefined;
  readonly summary?: string | undefined;
  readonly responsibilities?: string | undefined;
  /** `ATS-6`: physical requirements belong in the advert, never on the form. */
  readonly physicalRequirements?: string | undefined;
  readonly closesAt?: Date | undefined;
  readonly hiringManagerUserId?: string | undefined;
}

/**
 * Create a requisition and its pipeline in one transaction (`ATS-1`, `ATS-7`).
 *
 * The stages are created here rather than lazily on first application, because
 * a requisition with no pipeline is a board with no columns — and the moment
 * anyone notices is the moment the first applicant has already arrived and has
 * nowhere to be.
 */
export async function createRequisition(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: CreateRequisitionInput,
): Promise<{ requisitionId: string; reference: string; publicSlug: string }> {
  const title = input.title.trim();
  if (title.length < 3) throw new UserFacingError("Give the role a title.");
  if (input.headcount < 1) throw new UserFacingError("A requisition needs at least one position.");

  const bandGiven =
    input.salaryBandMinMinor !== undefined || input.salaryBandMaxMinor !== undefined;
  if (bandGiven && (input.salaryBandMinMinor === undefined || input.salaryBandMaxMinor === undefined)) {
    // The database CHECK would refuse this anyway. Refusing here means the
    // person filling in the form is told which half is missing.
    throw new UserFacingError(
      "Give both ends of the salary band or neither. A half-set band is published as “from AED 0”.",
    );
  }

  const rows = await tx.execute<{ reference: string }>(
    sql`select app_next_reference('REQ', ${new Date().getFullYear()}) as reference`,
  );
  const reference = (rows as unknown as { reference: string }[])[0]?.reference;
  if (!reference) throw new Error("Could not allocate a requisition reference");

  const publicSlug = await uniquePublicSlug(tx, title);

  const [row] = await tx
    .insert(schema.jobRequisitions)
    .values({
      tenantId: ctx.tenantId,
      reference,
      publicSlug,
      title,
      trade: input.trade,
      grade: input.grade,
      headcount: input.headcount,
      contractType: input.contractType,
      locationCity: input.locationCity,
      locationArea: input.locationArea ?? null,
      minExperienceYears: input.minExperienceYears ?? null,
      requiredCertifications: [...(input.requiredCertifications ?? [])],
      salaryBandMinMinor: input.salaryBandMinMinor ?? null,
      salaryBandMaxMinor: input.salaryBandMaxMinor ?? null,
      summary: input.summary ?? null,
      responsibilities: input.responsibilities ?? null,
      physicalRequirements: input.physicalRequirements ?? null,
      closesAt: input.closesAt ?? null,
      hiringManagerUserId: input.hiringManagerUserId ?? null,
      status: "draft",
    })
    .returning({ id: schema.jobRequisitions.id });

  if (!row) throw new Error("Failed to create requisition");

  await tx.insert(schema.requisitionStages).values(
    DEFAULT_PIPELINE.slice(0, MAX_PIPELINE_STAGES).map((stage, index) => ({
      tenantId: ctx.tenantId,
      requisitionId: row.id,
      name: stage.name,
      stageType: stage.stageType,
      sequence: index + 1,
    })),
  );

  return { requisitionId: row.id, reference, publicSlug };
}

/**
 * Approve, then publish (`ATS-1`, `ATS-2`).
 *
 * Two steps rather than one because they are two decisions by two people: a
 * hiring manager approves a headcount, and somebody publishes an advert. The
 * database refuses `status = 'open'` without an `approved_at`, so publishing
 * cannot be reached by a status update that skipped the approval.
 */
export async function approveRequisition(
  tx: TenantScopedTx,
  ctx: TenantContext,
  requisitionId: string,
): Promise<void> {
  const requisition = await getRequisition(tx, requisitionId);
  if (!requisition) throw new UserFacingError("That role was not found.");
  if (requisition.approvedAt) return;

  await tx
    .update(schema.jobRequisitions)
    .set({ status: "pending_approval", approvedById: ctx.userId ?? null, approvedAt: new Date() })
    .where(eq(schema.jobRequisitions.id, requisitionId));

  await writeAuditNote(tx, ctx, {
    tableName: "job_requisitions",
    recordId: requisitionId,
    action: "approved",
    detail: { rule: "ATS-1", reference: requisition.reference },
  });
}

export async function publishRequisition(
  tx: TenantScopedTx,
  ctx: TenantContext,
  requisitionId: string,
): Promise<void> {
  const requisition = await getRequisition(tx, requisitionId);
  if (!requisition) throw new UserFacingError("That role was not found.");
  if (!requisition.approvedAt) {
    throw new UserFacingError(
      "This role has not been approved yet. A headcount reaches the careers site only after somebody has signed off on it.",
    );
  }

  const now = new Date();
  await tx
    .update(schema.jobRequisitions)
    .set({ status: "open", publishedAt: now, opensAt: requisition.opensAt ?? now })
    .where(eq(schema.jobRequisitions.id, requisitionId));

  await writeAuditNote(tx, ctx, {
    tableName: "job_requisitions",
    recordId: requisitionId,
    action: "published",
    detail: { rule: "ATS-2", slug: requisition.publicSlug },
  });
}

/**
 * Close a role.
 *
 * Refuses while anyone is still live on it, and says how many. Closing a
 * requisition with eleven people sitting in Screening is how eleven people
 * never hear anything — the board stops being looked at and the rows stay
 * `active`, so they never even appear in the outcome report. Archive them (with
 * a reason, which sends them a message) and then close.
 */
export async function closeRequisition(
  tx: TenantScopedTx,
  ctx: TenantContext,
  requisitionId: string,
  status: "filled" | "cancelled" = "filled",
): Promise<void> {
  const live = await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from applications
     where requisition_id = ${requisitionId}
       and status = 'active'
       and deleted_at is null
  `);
  const remaining = (live as unknown as { count: number }[])[0]?.count ?? 0;

  if (remaining > 0) {
    throw new UserFacingError(
      `${remaining} ${remaining === 1 ? "applicant is" : "applicants are"} still live on this role. ` +
        `Archive them with a reason first — each one sends them an outcome. Closing the role now would leave them waiting indefinitely.`,
    );
  }

  await tx
    .update(schema.jobRequisitions)
    .set({ status, closedAt: new Date() })
    .where(eq(schema.jobRequisitions.id, requisitionId));

  await writeAuditNote(tx, ctx, {
    tableName: "job_requisitions",
    recordId: requisitionId,
    action: "closed",
    detail: { rule: "ATS-1", status },
  });
}

// ── The pipeline board (`ATS-7`, `ATS-8`) ───────────────────────────────────

export interface RequisitionPipelineStage {
  readonly id: string;
  readonly name: string;
  readonly stageType: string;
  readonly sequence: number;
}

export interface PipelineCard {
  readonly applicationId: string;
  readonly reference: string;
  readonly candidateId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly grade: string;
  readonly experienceBand: string;
  readonly currentLocation: string;
  readonly stageId: string | null;
  readonly stageEnteredAt: Date;
  readonly blockedOn: BlockedOn;
  readonly blockedNote: string | null;
  /** Computed, never stored: the state is a function of time (`ATS-8`). */
  readonly tone: "green" | "amber" | "red";
  readonly toneLabel: string;
  readonly daysInStage: number;
  readonly appliedAt: Date;
  /** `ATS-4`: an expired certificate is visible before the trade check, not after. */
  readonly expiredCertifications: number;
}

export interface ArchivedSummary {
  readonly dispositionReasonCode: string;
  readonly label: string;
  readonly count: number;
}

export interface PipelineBoard {
  readonly requisition: RequisitionRow;
  readonly stages: readonly RequisitionPipelineStage[];
  readonly cards: readonly PipelineCard[];
  readonly archived: readonly ArchivedSummary[];
  readonly archivedTotal: number;
  /** `ATS-16`. Front and centre, not on a reports tab. */
  readonly owedAnOutcome: number;
}

export async function getPipelineBoard(
  tx: TenantScopedTx,
  requisitionId: string,
): Promise<PipelineBoard | null> {
  const requisition = await getRequisition(tx, requisitionId);
  if (!requisition) return null;

  const stages = (await tx
    .select({
      id: schema.requisitionStages.id,
      name: schema.requisitionStages.name,
      stageType: schema.requisitionStages.stageType,
      sequence: schema.requisitionStages.sequence,
    })
    .from(schema.requisitionStages)
    .where(
      and(
        eq(schema.requisitionStages.requisitionId, requisitionId),
        isNull(schema.requisitionStages.deletedAt),
      ),
    )
    .orderBy(asc(schema.requisitionStages.sequence))) as RequisitionPipelineStage[];

  // One query, with the expired-certificate count folded in. Fetching cards and
  // then N certificate counts would be the classic board that gets slower with
  // every applicant, on the screen that is open all day.
  const raw = (await tx.execute<{
    application_id: string;
    reference: string;
    candidate_id: string;
    full_name: string;
    phone: string;
    email: string | null;
    grade: string;
    experience_band: string;
    current_location: string;
    stage_id: string | null;
    stage_entered_at: string;
    blocked_on: string;
    blocked_note: string | null;
    applied_at: string;
    expired_certifications: number;
  }>(sql`
    select a.id                as application_id,
           a.reference,
           c.id                as candidate_id,
           c.full_name,
           c.phone,
           c.email,
           c.grade,
           c.experience_band,
           c.current_location,
           a.current_stage_id  as stage_id,
           a.stage_entered_at,
           a.blocked_on,
           a.blocked_note,
           a.applied_at,
           (select count(*)::int
              from candidate_certifications cc
             where cc.candidate_id = c.id
               and cc.deleted_at is null
               and cc.expires_on < (now() at time zone 'Asia/Dubai')::date) as expired_certifications
      from applications a
      join candidates c on c.id = a.candidate_id
     where a.requisition_id = ${requisitionId}
       and a.status = 'active'
       and a.deleted_at is null
     order by a.stage_entered_at
  `)) as unknown as {
    application_id: string;
    reference: string;
    candidate_id: string;
    full_name: string;
    phone: string;
    email: string | null;
    grade: string;
    experience_band: string;
    current_location: string;
    stage_id: string | null;
    stage_entered_at: string;
    blocked_on: string;
    blocked_note: string | null;
    applied_at: string;
    expired_certifications: number;
  }[];

  const cards: PipelineCard[] = raw.map((r) => {
    const stageEnteredAt = new Date(r.stage_entered_at);
    const state = blockedState({ blockedOn: r.blocked_on as BlockedOn, stageEnteredAt });
    return {
      applicationId: r.application_id,
      reference: r.reference,
      candidateId: r.candidate_id,
      fullName: r.full_name,
      phone: r.phone,
      email: r.email,
      grade: r.grade,
      experienceBand: r.experience_band,
      currentLocation: r.current_location,
      stageId: r.stage_id,
      stageEnteredAt,
      blockedOn: r.blocked_on as BlockedOn,
      blockedNote: r.blocked_note,
      tone: state.tone,
      toneLabel: state.label,
      daysInStage: state.days,
      appliedAt: new Date(r.applied_at),
      expiredCertifications: Number(r.expired_certifications),
    };
  });

  const archivedRows = (await tx.execute<{ code: string; count: number }>(sql`
    select coalesce(disposition_reason_code, 'other') as code, count(*)::int as count
      from applications
     where requisition_id = ${requisitionId}
       and status = 'archived'
       and deleted_at is null
     group by 1
     order by 2 desc
  `)) as unknown as { code: string; count: number }[];

  const owedRows = (await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from applications
     where requisition_id = ${requisitionId}
       and status <> 'active'
       and outcome_sent_at is null
       and deleted_at is null
  `)) as unknown as { count: number }[];

  return {
    requisition,
    stages,
    cards,
    archived: archivedRows.map((r) => ({
      dispositionReasonCode: r.code,
      label: DISPOSITION_BY_CODE[r.code]?.label ?? r.code,
      count: Number(r.count),
    })),
    archivedTotal: archivedRows.reduce((sum, r) => sum + Number(r.count), 0),
    owedAnOutcome: owedRows[0]?.count ?? 0,
  };
}

/**
 * Move an application to another stage (`ATS-7`).
 *
 * Moving forward clears the blocked flag: whatever we or they were waiting for
 * has happened, and a card that carries "waiting on the candidate" into the
 * next column is a red dot nobody trusts after the third time.
 *
 * `ATS-19` lives here too, quietly: there is no argument that could set a
 * score, and there is no automatic move. Every transition is a person.
 */
export async function moveApplicationStage(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { applicationId: string; toStageId: string; note?: string | undefined },
): Promise<void> {
  const rows = await tx
    .select({
      id: schema.applications.id,
      status: schema.applications.status,
      currentStageId: schema.applications.currentStageId,
      requisitionId: schema.applications.requisitionId,
      candidateId: schema.applications.candidateId,
    })
    .from(schema.applications)
    .where(eq(schema.applications.id, input.applicationId))
    .limit(1);

  const application = rows[0];
  if (!application) throw new UserFacingError("That application was not found.");
  if (application.status !== "active") {
    throw new UserFacingError(
      "This application has already been closed. Reopen it before moving it to another stage.",
    );
  }

  const stage = await tx
    .select({ id: schema.requisitionStages.id, requisitionId: schema.requisitionStages.requisitionId })
    .from(schema.requisitionStages)
    .where(eq(schema.requisitionStages.id, input.toStageId))
    .limit(1);

  if (!stage[0] || stage[0].requisitionId !== application.requisitionId) {
    throw new UserFacingError("That stage does not belong to this role.");
  }

  const now = new Date();
  await tx
    .update(schema.applications)
    .set({
      currentStageId: input.toStageId,
      stageEnteredAt: now,
      blockedOn: "none",
      blockedNote: null,
      blockedSince: null,
      updatedAt: now,
    })
    .where(eq(schema.applications.id, input.applicationId));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId: input.applicationId,
    eventType: "stage_changed",
    fromStageId: application.currentStageId,
    toStageId: input.toStageId,
    note: input.note?.trim() || null,
    actorUserId: ctx.userId ?? null,
    actorKind: "user",
  });

  await touchCandidate(tx, application.candidateId);
}

/**
 * Record who is holding this up (`ATS-8`).
 *
 * The structured signal that the time-in-stage fallback exists to substitute
 * for. Both are needed: this is accurate when somebody records it, and the
 * fallback is what stops a board of untouched cards showing all green.
 */
export async function setBlockedOn(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { applicationId: string; blockedOn: BlockedOn; note?: string | undefined },
): Promise<void> {
  const now = new Date();
  await tx
    .update(schema.applications)
    .set({
      blockedOn: input.blockedOn,
      blockedNote: input.note?.trim().slice(0, 200) || null,
      blockedSince: input.blockedOn === "none" ? null : now,
      updatedAt: now,
    })
    .where(eq(schema.applications.id, input.applicationId));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId: input.applicationId,
    eventType: "blocked_changed",
    note: input.note?.trim() || null,
    payload: { blockedOn: input.blockedOn },
    actorUserId: ctx.userId ?? null,
    actorKind: "user",
  });
}

/** `ATS-5`. Trade Check only, uniformly, planning only — never a filter. */
export async function setVisaStatus(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { candidateId: string; visaStatus: VisaStatus; currentSponsor?: string | undefined },
): Promise<void> {
  await tx
    .update(schema.candidates)
    .set({
      visaStatus: input.visaStatus,
      visaCurrentSponsor: input.currentSponsor?.trim() || null,
      lastInteractionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.candidates.id, input.candidateId));

  await writeAuditNote(tx, ctx, {
    tableName: "candidates",
    recordId: input.candidateId,
    action: "visa_status_recorded",
    // The status itself is not copied into the audit detail. It is exactly the
    // sort of field an audit trail is asked to prove was never used as a
    // filter, and a log of every value it has ever held is not evidence of that.
    detail: { rule: "ATS-5", stage: "trade_check" },
  });
}

// ── ATS-16: the outcome, which is the point ─────────────────────────────────

export interface CloseApplicationInput {
  readonly applicationId: string;
  /** From the controlled list. Free text here destroys the module's analytics. */
  readonly dispositionCode: string;
  /** Added to the message, never a substitute for the code. */
  readonly note?: string | undefined;
  readonly addToTalentPool?: boolean | undefined;
  /**
   * Hours to hold the message before it becomes sendable (`ATS-15`).
   *
   * Clamped to a floor of 24 rather than validated, because the floor is the
   * requirement and a caller that passes 0 is a caller that has misunderstood
   * it, not one that should be refused.
   */
  readonly delayHours?: number | undefined;
}

/**
 * Archive an application, and schedule the message that tells the applicant.
 *
 * ── WHY THERE IS NO WAY TO SKIP THE MESSAGE ─────────────────────────────────
 *
 * `ATS-16` targets 100%. The wireframe draws "Send outcome message" as a
 * ticked, required checkbox; a required checkbox is a checkbox, and this
 * function is what makes it a fact. There is no `sendMessage: false`, no
 * `silent: true`, and no code path from `active` to `archived` that does not
 * pass through here — the database CHECK
 * `applications_archived_needs_reason` refuses the alternative.
 *
 * The message is *scheduled*, not sent (`ATS-15`). It sits for at least
 * twenty-four hours and can be cancelled in that window, because decisions
 * genuinely change: the first choice takes another offer on Tuesday and
 * Monday's rejection is suddenly the hire. A delivered message cannot be
 * withdrawn.
 *
 * A human sends it after any human interaction. This function refuses to mark
 * an outcome auto-sendable past Screening, so an archive from Trade Check
 * onwards produces a message waiting for a person, not one leaving on a timer.
 */
export async function closeApplication(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: CloseApplicationInput,
): Promise<{ outcomeScheduledAt: Date; message: string; requiresHumanSend: boolean }> {
  const reason = DISPOSITION_BY_CODE[input.dispositionCode];
  if (!reason) {
    throw new UserFacingError(
      "Choose a reason from the list. The reason is what writes the message this applicant receives, so there is no unspecified option.",
    );
  }

  const rows = (await tx.execute<{
    id: string;
    status: string;
    candidate_id: string;
    current_stage_id: string | null;
    stage_type: string | null;
    full_name: string;
    email: string | null;
    primary_trade: string;
    title: string;
  }>(sql`
    select a.id, a.status, a.candidate_id, a.current_stage_id,
           s.stage_type, c.full_name, c.email, c.primary_trade, r.title
      from applications a
      join candidates c on c.id = a.candidate_id
      join job_requisitions r on r.id = a.requisition_id
      left join requisition_stages s on s.id = a.current_stage_id
     where a.id = ${input.applicationId}
       and a.deleted_at is null
     limit 1
  `)) as unknown as {
    id: string;
    status: string;
    candidate_id: string;
    current_stage_id: string | null;
    stage_type: string | null;
    full_name: string;
    email: string | null;
    primary_trade: string;
    title: string;
  }[];

  const application = rows[0];
  if (!application) throw new UserFacingError("That application was not found.");
  if (application.status !== "active") {
    throw new UserFacingError("This application has already been closed.");
  }

  const now = new Date();
  const delayHours = Math.max(input.delayHours ?? OUTCOME_MINIMUM_DELAY_HOURS, OUTCOME_MINIMUM_DELAY_HOURS);
  const scheduledAt = new Date(now.getTime() + delayHours * 3_600_000);

  const message = outcomeMessage({
    candidateFirstName: application.full_name.split(" ")[0] ?? application.full_name,
    roleTitle: application.title,
    dispositionCode: input.dispositionCode,
    extraNote: input.note,
  });

  /*
   * `ATS-15` / `ATS-19`. Automated rejection is permitted only at the earliest
   * stages; after any human interaction a human must send. So the message is
   * composed either way — the recruiter never has to write it from scratch —
   * but past Screening it waits for somebody to press send rather than leaving
   * on a timer.
   */
  const stageType = application.stage_type ?? "applied";
  const requiresHumanSend =
    !reason.autoSendable || !["applied", "screening"].includes(stageType);

  await tx
    .update(schema.applications)
    .set({
      status: "archived",
      dispositionReasonCode: input.dispositionCode,
      dispositionNote: input.note?.trim() || null,
      archivedAtStageId: application.current_stage_id,
      archivedAt: now,
      blockedOn: "none",
      blockedNote: null,
      blockedSince: null,
      outcomeMessage: message,
      // Null when a human must send it. The accountability report treats a null
      // schedule exactly like an unsent one — because it is.
      outcomeScheduledAt: requiresHumanSend ? null : scheduledAt,
      outcomeCancelledAt: null,
      updatedAt: now,
    })
    .where(eq(schema.applications.id, input.applicationId));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId: input.applicationId,
    eventType: "archived",
    fromStageId: application.current_stage_id,
    note: input.note?.trim() || null,
    payload: {
      dispositionCode: input.dispositionCode,
      requiresHumanSend,
      scheduledFor: requiresHumanSend ? null : scheduledAt.toISOString(),
    },
    actorUserId: ctx.userId ?? null,
    actorKind: "user",
  });

  /*
   * `ATS-13`. Candidates archived from late stages are strong prospects, and
   * the disposition reason is what says so — "role filled" and "salary
   * expectation" are people we would take tomorrow under different
   * circumstances; "failed trade check" is not.
   *
   * Consent is still required and is still the candidate's to give. What is
   * recorded here is a staff intention, with `consent_source` saying exactly
   * that, and the re-confirmation cycle asks the candidate directly.
   */
  if (input.addToTalentPool) {
    if (!reason.talentPoolCandidate) {
      throw new UserFacingError(
        "This disposition reason is not one to keep somebody on file for. Pick another reason, or leave the talent pool unticked.",
      );
    }
    await tx
      .insert(schema.talentPoolMembers)
      .values({
        tenantId: ctx.tenantId,
        candidateId: application.candidate_id,
        poolKey: application.primary_trade,
        consentCapturedAt: now,
        consentSource: "staff_recorded",
        reconfirmDueAt: new Date(now.getTime() + TALENT_POOL_RECONFIRM_DAYS * 86_400_000),
        addedReason: input.dispositionCode,
      })
      .onConflictDoNothing();
  }

  await touchCandidate(tx, application.candidate_id);

  return { outcomeScheduledAt: scheduledAt, message, requiresHumanSend };
}

/**
 * Use the window (`ATS-15`).
 *
 * Cancelling does not discharge the obligation — the application stays archived
 * with no outcome sent, and therefore stays in the accountability report until
 * somebody either reopens it or sends a different message. That is deliberate:
 * a cancel that quietly cleared the row would turn the safety valve into the
 * ghosting mechanism.
 */
export async function cancelScheduledOutcome(
  tx: TenantScopedTx,
  ctx: TenantContext,
  applicationId: string,
): Promise<void> {
  const updated = await tx
    .update(schema.applications)
    .set({ outcomeScheduledAt: null, outcomeCancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.applications.id, applicationId), isNull(schema.applications.outcomeSentAt)))
    .returning({ id: schema.applications.id });

  if (updated.length === 0) {
    throw new UserFacingError(
      "That message has already gone out. It cannot be recalled — reply to the applicant directly.",
    );
  }

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId,
    eventType: "outcome_cancelled",
    note: "Scheduled outcome cancelled before sending",
    actorUserId: ctx.userId ?? null,
    actorKind: "user",
  });
}

/** Reopen an archived application. Clears the disposition; keeps the history. */
export async function reopenApplication(
  tx: TenantScopedTx,
  ctx: TenantContext,
  applicationId: string,
): Promise<void> {
  const rows = await tx
    .select({
      status: schema.applications.status,
      outcomeSentAt: schema.applications.outcomeSentAt,
      archivedAtStageId: schema.applications.archivedAtStageId,
    })
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);

  const application = rows[0];
  if (!application) throw new UserFacingError("That application was not found.");
  if (application.status === "hired") {
    throw new UserFacingError("A hired application cannot be reopened.");
  }

  const now = new Date();
  await tx
    .update(schema.applications)
    .set({
      status: "active",
      currentStageId: application.archivedAtStageId,
      stageEnteredAt: now,
      dispositionReasonCode: null,
      dispositionNote: null,
      archivedAtStageId: null,
      archivedAt: null,
      outcomeScheduledAt: null,
      // The message is kept when it has already been sent — it is what the
      // applicant was told, and a reopened application whose history says
      // nothing was sent would be a lie in the activity feed.
      outcomeMessage: application.outcomeSentAt ? undefined : null,
      updatedAt: now,
    })
    .where(eq(schema.applications.id, applicationId));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId,
    eventType: "reopened",
    actorUserId: ctx.userId ?? null,
    actorKind: "user",
  });
}

export interface OutcomeToSend {
  readonly applicationId: string;
  readonly reference: string;
  readonly candidateId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string;
  readonly roleTitle: string;
  readonly message: string;
  readonly statusToken: string;
}

/**
 * Outcomes whose cancellable window has closed (`ATS-15`).
 *
 * Read by `/api/cron/recruitment`, which enqueues each through `notify` and
 * then calls `markOutcomeSent`. Deliberately not sent from the archive action:
 * a message dispatched inside the request that archived the row is a message
 * that cannot be cancelled, which is the requirement inverted.
 */
export async function dueOutcomes(
  tx: TenantScopedTx,
  limit = 100,
): Promise<readonly OutcomeToSend[]> {
  const rows = (await tx.execute<{
    application_id: string;
    reference: string;
    candidate_id: string;
    full_name: string;
    email: string | null;
    phone: string;
    title: string;
    outcome_message: string;
    status_token: string;
  }>(sql`
    select a.id as application_id, a.reference, c.id as candidate_id, c.full_name,
           c.email, c.phone, r.title, a.outcome_message, a.status_token
      from applications a
      join candidates c on c.id = a.candidate_id
      join job_requisitions r on r.id = a.requisition_id
     where a.outcome_sent_at is null
       and a.outcome_cancelled_at is null
       and a.outcome_scheduled_at is not null
       and a.outcome_scheduled_at <= now()
       and a.outcome_message is not null
       and a.deleted_at is null
     order by a.outcome_scheduled_at
     limit ${limit}
  `)) as unknown as {
    application_id: string;
    reference: string;
    candidate_id: string;
    full_name: string;
    email: string | null;
    phone: string;
    title: string;
    outcome_message: string;
    status_token: string;
  }[];

  return rows.map((r) => ({
    applicationId: r.application_id,
    reference: r.reference,
    candidateId: r.candidate_id,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    roleTitle: r.title,
    message: r.outcome_message,
    statusToken: r.status_token,
  }));
}

/** The one write that discharges the `ATS-16` obligation. */
export async function markOutcomeSent(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { applicationId: string; channel: string; notificationId?: string | undefined },
): Promise<void> {
  await tx
    .update(schema.applications)
    .set({
      outcomeSentAt: new Date(),
      outcomeChannel: input.channel,
      outcomeNotificationId: input.notificationId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.applications.id, input.applicationId));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId: input.applicationId,
    eventType: "outcome_sent",
    payload: { channel: input.channel },
    actorKind: "system",
  });
}

export interface PendingAcknowledgement {
  readonly applicationId: string;
  readonly reference: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly phone: string;
  readonly roleTitle: string;
  readonly statusToken: string;
  readonly outcomeDueAt: Date;
}

/** `ATS-14`. Applications that have not yet been acknowledged. */
export async function pendingAcknowledgements(
  tx: TenantScopedTx,
  limit = 100,
): Promise<readonly PendingAcknowledgement[]> {
  const rows = (await tx.execute<{
    application_id: string;
    reference: string;
    full_name: string;
    email: string | null;
    phone: string;
    title: string;
    status_token: string;
    outcome_due_at: string;
  }>(sql`
    select a.id as application_id, a.reference, c.full_name, c.email, c.phone,
           r.title, a.status_token, a.outcome_due_at
      from applications a
      join candidates c on c.id = a.candidate_id
      join job_requisitions r on r.id = a.requisition_id
     where a.acknowledged_at is null
       and a.deleted_at is null
     order by a.applied_at
     limit ${limit}
  `)) as unknown as {
    application_id: string;
    reference: string;
    full_name: string;
    email: string | null;
    phone: string;
    title: string;
    status_token: string;
    outcome_due_at: string;
  }[];

  return rows.map((r) => ({
    applicationId: r.application_id,
    reference: r.reference,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    roleTitle: r.title,
    statusToken: r.status_token,
    outcomeDueAt: new Date(r.outcome_due_at),
  }));
}

export async function markAcknowledged(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { applicationId: string; channel: string | null },
): Promise<void> {
  await tx
    .update(schema.applications)
    .set({ acknowledgedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.applications.id, input.applicationId));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId: input.applicationId,
    eventType: "acknowledged",
    // `null` channel is recorded rather than skipped. It means the applicant
    // gave a phone number, no SMS transport exists, and the confirmation screen
    // was the only acknowledgement they got — which is a real gap and is
    // counted as one by `outcomeAccountability`.
    payload: { channel: input.channel },
    note: input.channel ? null : "No reachable channel: no email address and no SMS transport",
    actorKind: "system",
  });
}

/**
 * `G14`. The number the module is judged on.
 *
 * ── WHY EVERY BUCKET IS REPORTED SEPARATELY ─────────────────────────────────
 *
 * A single "response rate" percentage can be made to look good three different
 * ways, and every one of them hides an applicant who is still waiting:
 *
 *   * counting only *archived* applications ignores everyone abandoned in
 *     `active` on a role that was quietly closed;
 *   * counting a *scheduled* message as sent ignores every one that was
 *     cancelled and never replaced;
 *   * counting an applicant with **no reachable channel** as satisfied ignores
 *     the fact that nothing reached them at all.
 *
 * So all of them are returned. `unreachable` in particular is a number most
 * systems would never surface, and it is the one that says the SMS/WhatsApp
 * transport (`ATS-14`) is still missing.
 */
export interface OutcomeAccountability {
  readonly totalApplications: number;
  readonly closed: number;
  readonly outcomeSent: number;
  /** Closed, no outcome sent, promise not yet expired. */
  readonly awaiting: number;
  /** Closed, no outcome sent, promise expired. The failure state. */
  readonly overdue: number;
  /** Still `active` and past the promised date — nobody has decided anything. */
  readonly staleActive: number;
  /** No email address, and no non-email transport exists. Cannot be told. */
  readonly unreachable: number;
  /** Composed and waiting for a human to press send (`ATS-15`). */
  readonly awaitingHumanSend: number;
  /** Sent ÷ closed, as a whole percentage. `G14` target is 100. */
  readonly responseRatePercent: number;
  readonly oldestOverdueDays: number;
}

export async function outcomeAccountability(
  tx: TenantScopedTx,
  options?: { days?: number },
): Promise<OutcomeAccountability> {
  const days = options?.days ?? 365;

  const rows = (await tx.execute<{
    total: number;
    closed: number;
    sent: number;
    awaiting: number;
    overdue: number;
    stale_active: number;
    unreachable: number;
    awaiting_human: number;
    oldest_overdue_days: number | null;
  }>(sql`
    select count(*)::int as total,
           count(*) filter (where status <> 'active')::int as closed,
           count(*) filter (where outcome_sent_at is not null)::int as sent,
           count(*) filter (
             where status <> 'active' and outcome_sent_at is null and outcome_due_at >= now()
           )::int as awaiting,
           count(*) filter (
             where status <> 'active' and outcome_sent_at is null and outcome_due_at < now()
           )::int as overdue,
           count(*) filter (where status = 'active' and outcome_due_at < now())::int as stale_active,
           count(*) filter (where outcome_sent_at is null and c.email is null)::int as unreachable,
           count(*) filter (
             where status = 'archived' and outcome_sent_at is null
               and outcome_scheduled_at is null and outcome_message is not null
           )::int as awaiting_human,
           max(
             case when status <> 'active' and outcome_sent_at is null and outcome_due_at < now()
                  then extract(day from now() - outcome_due_at)::int end
           ) as oldest_overdue_days
      from applications a
      join candidates c on c.id = a.candidate_id
     where a.deleted_at is null
       and a.applied_at >= now() - make_interval(days => ${days})
  `)) as unknown as {
    total: number;
    closed: number;
    sent: number;
    awaiting: number;
    overdue: number;
    stale_active: number;
    unreachable: number;
    awaiting_human: number;
    oldest_overdue_days: number | null;
  }[];

  const r = rows[0];
  const closed = Number(r?.closed ?? 0);
  const sent = Number(r?.sent ?? 0);

  return {
    totalApplications: Number(r?.total ?? 0),
    closed,
    outcomeSent: sent,
    awaiting: Number(r?.awaiting ?? 0),
    overdue: Number(r?.overdue ?? 0),
    staleActive: Number(r?.stale_active ?? 0),
    unreachable: Number(r?.unreachable ?? 0),
    awaitingHumanSend: Number(r?.awaiting_human ?? 0),
    // 100 when nothing has been closed yet. An empty denominator is not a
    // failure, and reporting 0% on a new deployment would train people to
    // ignore the number before it ever meant anything.
    responseRatePercent: closed === 0 ? 100 : Math.round((sent / closed) * 100),
    oldestOverdueDays: Number(r?.oldest_overdue_days ?? 0),
  };
}

export interface OwedOutcome {
  readonly applicationId: string;
  readonly reference: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly roleTitle: string;
  readonly status: string;
  readonly dispositionReasonCode: string | null;
  readonly outcomeDueAt: Date;
  readonly daysOverdue: number;
  readonly hasMessage: boolean;
  readonly reachable: boolean;
}

/**
 * The list behind the number. Named people, not a percentage.
 *
 * A dashboard tile saying "94%" is a statistic; this is six people with names
 * and phone numbers who are still waiting, which is what actually gets them
 * answered. Ordered oldest promise first.
 */
export async function applicationsOwedAnOutcome(
  tx: TenantScopedTx,
  limit = 100,
): Promise<readonly OwedOutcome[]> {
  const rows = (await tx.execute<{
    application_id: string;
    reference: string;
    full_name: string;
    phone: string;
    email: string | null;
    title: string;
    status: string;
    disposition_reason_code: string | null;
    outcome_due_at: string;
    days_overdue: number;
    has_message: boolean;
  }>(sql`
    select a.id as application_id, a.reference, c.full_name, c.phone, c.email,
           r.title, a.status, a.disposition_reason_code, a.outcome_due_at,
           greatest(0, extract(day from now() - a.outcome_due_at)::int) as days_overdue,
           (a.outcome_message is not null) as has_message
      from applications a
      join candidates c on c.id = a.candidate_id
      join job_requisitions r on r.id = a.requisition_id
     where a.outcome_sent_at is null
       and a.outcome_due_at < now()
       and a.deleted_at is null
     order by a.outcome_due_at
     limit ${limit}
  `)) as unknown as {
    application_id: string;
    reference: string;
    full_name: string;
    phone: string;
    email: string | null;
    title: string;
    status: string;
    disposition_reason_code: string | null;
    outcome_due_at: string;
    days_overdue: number;
    has_message: boolean;
  }[];

  return rows.map((r) => ({
    applicationId: r.application_id,
    reference: r.reference,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    roleTitle: r.title,
    status: r.status,
    dispositionReasonCode: r.disposition_reason_code,
    outcomeDueAt: new Date(r.outcome_due_at),
    daysOverdue: Number(r.days_overdue),
    hasMessage: r.has_message,
    reachable: r.email !== null,
  }));
}

// ── ATS-11: duplicates ──────────────────────────────────────────────────────

export interface DuplicateSuggestion {
  readonly candidateId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly createdAt: Date;
  readonly matchedOn: "phone" | "email" | "both";
  readonly applications: number;
}

/**
 * People who might be this person (`ATS-11`).
 *
 * The loose matcher: phone **or** email, phone compared on local digits so
 * `+971 50 123 4567` and `0501234567` are the same number. It *suggests*; it
 * never links. A false positive that merges two brothers who share a phone is
 * expensive to undo and impossible to notice.
 */
export async function duplicateSuggestions(
  tx: TenantScopedTx,
  candidateId: string,
): Promise<readonly DuplicateSuggestion[]> {
  const rows = (await tx.execute<{
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
    created_at: string;
    matched_on: string;
    applications: number;
  }>(sql`
    with subject as (
      select phone_local_digits, lower(email) as email
        from candidates where id = ${candidateId}
    )
    select c.id, c.full_name, c.phone, c.email, c.created_at,
           case
             when c.phone_local_digits = s.phone_local_digits and lower(c.email) = s.email then 'both'
             when c.phone_local_digits = s.phone_local_digits then 'phone'
             else 'email'
           end as matched_on,
           (select count(*)::int from applications a where a.candidate_id = c.id) as applications
      from candidates c, subject s
     where c.id <> ${candidateId}
       and c.deleted_at is null
       and c.merged_into_candidate_id is null
       and (
             c.phone_local_digits = s.phone_local_digits
             or (s.email is not null and lower(c.email) = s.email)
           )
     order by c.created_at
     limit 10
  `)) as unknown as {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
    created_at: string;
    matched_on: string;
    applications: number;
  }[];

  return rows.map((r) => ({
    candidateId: r.id,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    createdAt: new Date(r.created_at),
    matchedOn: r.matched_on as "phone" | "email" | "both",
    applications: Number(r.applications),
  }));
}

/**
 * Merge two candidate records (`ATS-11`).
 *
 * Three rules, all from the requirement, all load-bearing:
 *
 *  1. **The older profile wins** on candidate-level data. It is the one with
 *     the longer history attached and the one a recruiter has already looked
 *     at, and picking "most recent" instead means a typo in today's form
 *     silently overwrites a name somebody verified last year.
 *  2. **Application-level data is preserved per application.** Stage, source,
 *     attachments and disposition move across untouched. Collapsing two
 *     applications into one would destroy exactly the history the merge exists
 *     to unify.
 *  3. **Nothing is deleted.** The merged row stays, pointing at the survivor,
 *     and both activity feeds remain readable. A merge that deletes is a merge
 *     that cannot be undone when it turns out to have been two brothers.
 */
export async function mergeCandidates(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { survivorId: string; mergedId: string },
): Promise<{ applicationsMoved: number }> {
  if (input.survivorId === input.mergedId) {
    throw new UserFacingError("That is the same record.");
  }

  const rows = await tx
    .select({
      id: schema.candidates.id,
      createdAt: schema.candidates.createdAt,
      mergedInto: schema.candidates.mergedIntoCandidateId,
    })
    .from(schema.candidates)
    .where(sql`${schema.candidates.id} in (${input.survivorId}, ${input.mergedId})`);

  if (rows.length !== 2) throw new UserFacingError("One of those candidates was not found.");
  if (rows.some((r) => r.mergedInto !== null)) {
    throw new UserFacingError("One of those records has already been merged.");
  }

  // Rule 1, enforced rather than trusted. The caller names a survivor; if it is
  // the newer record the merge is refused rather than quietly reversed, because
  // silently doing the opposite of what a button said is worse than refusing.
  const oldest = rows.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
  if (oldest.id !== input.survivorId) {
    throw new UserFacingError(
      "The older profile is the one that survives a merge — it carries the history somebody has already verified. Merge the other way round.",
    );
  }

  const moved = await tx
    .update(schema.applications)
    .set({ candidateId: input.survivorId, updatedAt: new Date() })
    .where(eq(schema.applications.candidateId, input.mergedId))
    .returning({ id: schema.applications.id });

  await tx
    .update(schema.candidateCertifications)
    .set({ candidateId: input.survivorId })
    .where(eq(schema.candidateCertifications.candidateId, input.mergedId));

  await tx
    .update(schema.candidateDocuments)
    .set({ candidateId: input.survivorId })
    .where(eq(schema.candidateDocuments.candidateId, input.mergedId));

  await tx
    .update(schema.candidates)
    .set({ mergedIntoCandidateId: input.survivorId, updatedAt: new Date() })
    .where(eq(schema.candidates.id, input.mergedId));

  for (const application of moved) {
    await tx.insert(schema.applicationEvents).values({
      tenantId: ctx.tenantId,
      applicationId: application.id,
      eventType: "merged",
      note: "Moved here by a candidate merge",
      payload: { from: input.mergedId, into: input.survivorId },
      actorUserId: ctx.userId ?? null,
      actorKind: "user",
    });
  }

  await writeAuditNote(tx, ctx, {
    tableName: "candidates",
    recordId: input.survivorId,
    action: "merged",
    detail: { rule: "ATS-11", mergedId: input.mergedId, applicationsMoved: moved.length },
  });

  return { applicationsMoved: moved.length };
}

// ── ATS-17: the conversion that justifies the module ────────────────────────

export interface HireInput {
  readonly applicationId: string;
  readonly employeeCode: string;
  readonly contractStart: Date;
  readonly contractEnd?: Date | undefined;
  readonly probationEnd?: Date | undefined;
  readonly noticePeriodDays?: number | undefined;
  readonly basicSalaryMinor?: number | undefined;
  readonly baseCity?: string | undefined;
}

export interface HireResult {
  readonly technicianId: string;
  readonly employeeId: string;
  readonly certificationsCarried: number;
  /** Rendered on the confirmation. `HR-16` is stated where money is discussed. */
  readonly notice: string;
}

/**
 * Hire, in one action, with nothing re-keyed (`ATS-17`).
 *
 * *"The conversion is the point of the whole module."* Identity, trade, grade,
 * certifications **with their expiry dates**, and documents all carry across in
 * one transaction. The expiry dates are the part that matters: a certification
 * retyped by hand loses its expiry roughly as often as somebody is in a hurry,
 * and the consequence surfaces months later as a refused dispatch under `HR-9`
 * — or, worse, as a permitted one.
 *
 * `HR-16` is why this function takes no cost, fee, bond or repayment argument.
 * The visa, permit and medical are the employer's, and there is nothing here
 * that could record them otherwise.
 */
export async function hireCandidate(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: HireInput,
): Promise<HireResult> {
  const rows = (await tx.execute<{
    id: string;
    status: string;
    candidate_id: string;
    requisition_id: string;
    full_name: string;
    phone: string;
    email: string | null;
    primary_trade: string;
    grade: string;
    converted_technician_id: string | null;
    title: string;
  }>(sql`
    select a.id, a.status, a.candidate_id, a.requisition_id,
           c.full_name, c.phone, c.email, c.primary_trade, c.grade,
           c.converted_technician_id, r.title
      from applications a
      join candidates c on c.id = a.candidate_id
      join job_requisitions r on r.id = a.requisition_id
     where a.id = ${input.applicationId}
       and a.deleted_at is null
     limit 1
  `)) as unknown as {
    id: string;
    status: string;
    candidate_id: string;
    requisition_id: string;
    full_name: string;
    phone: string;
    email: string | null;
    primary_trade: string;
    grade: string;
    converted_technician_id: string | null;
    title: string;
  }[];

  const application = rows[0];
  if (!application) throw new UserFacingError("That application was not found.");
  if (application.status !== "active") {
    throw new UserFacingError("Only a live application can be converted to a hire.");
  }
  if (application.converted_technician_id) {
    throw new UserFacingError("This candidate already has a technician record.");
  }

  const employeeCode = input.employeeCode.trim();
  if (!employeeCode) throw new UserFacingError("Give the new employee a staff number.");

  const now = new Date();

  const [technician] = await tx
    .insert(schema.technicians)
    .values({
      tenantId: ctx.tenantId,
      employeeCode,
      fullName: application.full_name,
      phone: application.phone,
      email: application.email,
      employment: "direct",
      primaryTrade: application.primary_trade,
      grade: application.grade,
      baseCity: input.baseCity ?? "Dubai",
      joinedOn: input.contractStart,
      isActive: true,
    })
    .returning({ id: schema.technicians.id });

  if (!technician) throw new Error("Failed to create the technician record");

  // The primary trade becomes a dispatchable skill straight away. A technician
  // with no skills row is invisible to the assignment engine, which is a hire
  // that cannot be sent to work — and nothing in the UI would explain why.
  await tx
    .insert(schema.technicianSkills)
    .values({
      tenantId: ctx.tenantId,
      technicianId: technician.id,
      serviceSlug: application.primary_trade,
      proficiency: 3,
    })
    .onConflictDoNothing();

  // ── The part ATS-17 exists for: certifications, with their expiry ─────────
  const certifications = await tx
    .select({
      scheme: schema.candidateCertifications.scheme,
      certificateNo: schema.candidateCertifications.certificateNo,
      issuingBody: schema.candidateCertifications.issuingBody,
      issuedOn: schema.candidateCertifications.issuedOn,
      expiresOn: schema.candidateCertifications.expiresOn,
    })
    .from(schema.candidateCertifications)
    .where(
      and(
        eq(schema.candidateCertifications.candidateId, application.candidate_id),
        isNull(schema.candidateCertifications.deletedAt),
      ),
    );

  if (certifications.length > 0) {
    await tx.insert(schema.technicianCertifications).values(
      certifications.map((c) => ({
        tenantId: ctx.tenantId,
        technicianId: technician.id,
        name: c.scheme,
        issuer: c.issuingBody,
        reference: c.certificateNo,
        issuedOn: c.issuedOn ? new Date(c.issuedOn) : null,
        // The whole reason this function exists rather than a form somebody
        // retypes. `expires_on` is not null on the candidate record, so it is
        // never null here either.
        expiresOn: new Date(c.expiresOn),
        requiredForServices: [application.primary_trade],
      })),
    );
  }

  const [employee] = await tx
    .insert(schema.employees)
    .values({
      tenantId: ctx.tenantId,
      technicianId: technician.id,
      employeeNo: employeeCode,
      fullName: application.full_name,
      // UAE private-sector contracts are fixed-term only since Federal
      // Decree-Law 33/2021.
      contractType: "fixed_term",
      contractStart: input.contractStart.toISOString().slice(0, 10),
      contractEnd: input.contractEnd?.toISOString().slice(0, 10) ?? null,
      probationEnd: input.probationEnd?.toISOString().slice(0, 10) ?? null,
      noticePeriodDays: input.noticePeriodDays ?? 30,
      basicSalaryMinor: input.basicSalaryMinor ?? null,
      status: "active",
    })
    .returning({ id: schema.employees.id });

  if (!employee) throw new Error("Failed to create the employment record");

  await tx
    .update(schema.applications)
    .set({
      status: "hired",
      // A hire IS an outcome, and the most welcome one. Stamping it here is
      // what stops every successful hire sitting permanently in the "owed an
      // outcome" report — and, more importantly, stops that report being
      // dismissed as noisy and then ignored when it is right.
      outcomeMessage: `Hi ${application.full_name.split(" ")[0]}, welcome aboard — your offer for ${application.title} has been accepted and your start date is set.`,
      outcomeSentAt: now,
      outcomeChannel: "in_person",
      blockedOn: "none",
      blockedNote: null,
      blockedSince: null,
      updatedAt: now,
    })
    .where(eq(schema.applications.id, input.applicationId));

  await tx
    .update(schema.candidates)
    .set({
      convertedTechnicianId: technician.id,
      // ATS-18. The applicant clock stops here and HR-15's longer one takes
      // over on the employee record. Leaving `pre_contractual` in place would
      // have the retention job delete a serving employee's candidate history
      // six months into their employment.
      retentionBasis: "employee",
      deleteAfter: null,
      lastInteractionAt: now,
      updatedAt: now,
    })
    .where(eq(schema.candidates.id, application.candidate_id));

  await tx.insert(schema.applicationEvents).values({
    tenantId: ctx.tenantId,
    applicationId: input.applicationId,
    eventType: "hired",
    note: `Converted to technician ${employeeCode}`,
    payload: { technicianId: technician.id, certificationsCarried: certifications.length },
    actorUserId: ctx.userId ?? null,
    actorKind: "user",
  });

  await writeAuditNote(tx, ctx, {
    tableName: "applications",
    recordId: input.applicationId,
    action: "hired",
    detail: {
      rule: "ATS-17",
      technicianId: technician.id,
      employeeId: employee.id,
      certificationsCarried: certifications.length,
    },
  });

  return {
    technicianId: technician.id,
    employeeId: employee.id,
    certificationsCarried: certifications.length,
    notice:
      "Recruitment, visa and permit costs are the employer's and may never be recovered from this employee (HR-16). " +
      "This employee cannot be dispatched until the work permit, residence visa, Emirates ID, medical fitness certificate " +
      "and health insurance are all recorded and valid (HR-9).",
  };
}

// ── HR-16 ───────────────────────────────────────────────────────────────────

/**
 * Record a hiring cost. The employer's, always.
 *
 * Look at the signature: there is no `bearer`, no `chargeToWorker`, no
 * `recoverOverMonths`, no `bond`. `borne_by` is set to `employer` here and the
 * database CHECK permits nothing else, so `HR-16` is not a rule this function
 * applies — it is a rule the type and the table together make it impossible to
 * break, including from an importer that never calls this function at all.
 */
export async function recordRecruitmentCost(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    kind: string;
    amountMinor: number;
    incurredOn: Date;
    requisitionId?: string | undefined;
    candidateId?: string | undefined;
    note?: string | undefined;
  },
): Promise<{ costId: string }> {
  if (input.amountMinor < 0) {
    // A negative cost is a recovery, and a recovery is the thing HR-16
    // prohibits. Refused with the reason rather than stored as a credit.
    throw new UserFacingError(
      "A recruitment cost cannot be negative. Recovering a hiring cost from a worker is prohibited (HR-16); correct the original entry instead.",
    );
  }

  const [row] = await tx
    .insert(schema.recruitmentCosts)
    .values({
      tenantId: ctx.tenantId,
      requisitionId: input.requisitionId ?? null,
      candidateId: input.candidateId ?? null,
      kind: input.kind,
      amountMinor: input.amountMinor,
      borneBy: "employer",
      incurredOn: input.incurredOn.toISOString().slice(0, 10),
      note: input.note?.trim() || null,
      recordedById: ctx.userId ?? null,
    })
    .returning({ id: schema.recruitmentCosts.id });

  if (!row) throw new Error("Failed to record the recruitment cost");
  return { costId: row.id };
}

// ── ATS-18: retention ───────────────────────────────────────────────────────

/**
 * Push the retention clock out (`ATS-18`).
 *
 * Called on every *meaningful* interaction — a stage change, a message, a
 * document — and deliberately not from a trigger. A trigger on UPDATE would
 * fire on the retention sweep's own writes and on every unrelated column
 * change, so a row would postpone its own deletion indefinitely and the purge
 * would report zero deletions forever while looking entirely healthy.
 */
export async function touchCandidate(tx: TenantScopedTx, candidateId: string): Promise<void> {
  await tx.execute(sql`
    update candidates
       set last_interaction_at = now(),
           -- Six months from this interaction, unless the candidate is now an
           -- employee (HR-15's clock owns them) or has given consent for the
           -- talent pool (twelve months, re-confirmed every ninety days).
           delete_after = case
             when retention_basis = 'employee' then null
             when retention_basis = 'consent'
               then ((now() at time zone 'Asia/Dubai')::date + interval '12 months')::date
             else ((now() at time zone 'Asia/Dubai')::date + interval '6 months')::date
           end,
           updated_at = now()
     where id = ${candidateId}
  `);
}

/**
 * The shape `packages/db/src/domain/retention.ts` already uses.
 *
 * Duplicated here rather than imported so this module does not depend on the
 * retention module's export list, which is owned elsewhere. It is structurally
 * identical, and `purgeExpiredCandidates` returns it so the existing cron route
 * can push it into the same array as `purgeExpiredEmployees`.
 */
export interface CandidatePurgeOutcome {
  readonly table: string;
  readonly rule: string;
  readonly deleted: number;
  readonly heldForFinancialFloor: number;
  readonly orphanedStorageKeys: readonly string[];
}

/**
 * Delete applicant data past its retention date (`ATS-18`).
 *
 * This is the function `/api/cron/retention` says does not exist. Its warning
 * reads, on every run: *"Not yet purged, because the mechanism does not exist:
 * applicant and candidate data (ATS-18) — no `candidates` table."* There is one
 * now, with the columns that job's query shape expects.
 *
 * ── WHAT IT WILL NOT DELETE, AND WHY EACH EXCLUSION IS THERE ────────────────
 *
 *  * **A candidate who became an employee.** `retention_basis = 'employee'`.
 *    Their record is subject to `HR-15`'s two-year post-termination clock and,
 *    behind that, the seven-year financial floor — `employees` holds payroll
 *    data, and payroll data is tax data. Deleting the candidate history of a
 *    serving employee six months into their employment is the exact failure
 *    this column exists to prevent.
 *  * **A live applicant.** An application still `active` means a decision is
 *    outstanding, and deleting somebody mid-process both loses the decision and
 *    guarantees they never hear back — turning a retention job into the
 *    ghosting mechanism.
 *  * **A consented talent-pool member whose consent stands.** Different lawful
 *    basis, different clock, withdrawable at any time.
 *
 * ── WHAT IS REPORTED RATHER THAN HIDDEN ────────────────────────────────────
 *
 * `orphanedStorageKeys`. The database row goes; the CV in object storage does
 * not, because nothing in this codebase can delete from object storage yet
 * (`OPS-6`). Saying "40 applicant records purged" without saying that their CVs
 * are still on disk would be a false statement about a data-protection
 * obligation. The keys come back so the route can print them.
 *
 * No financial floor applies to an applicant record — there is nothing on it a
 * tax audit could ask for — so `heldForFinancialFloor` is 0 and is returned
 * only so the shape matches the rest of the purge.
 */
export async function purgeExpiredCandidates(
  tx: TenantScopedTx,
  ctx: TenantContext,
  options?: { batchLimit?: number },
): Promise<CandidatePurgeOutcome> {
  const limit = options?.batchLimit ?? 5_000;

  // Collected before the cascade removes them. `candidate_documents` is
  // ON DELETE CASCADE, so these keys become unrecoverable one statement later.
  const keyRows = (await tx.execute<{ storage_key: string }>(sql`
    select d.storage_key
      from candidate_documents d
      join candidates c on c.id = d.candidate_id
     where c.delete_after is not null
       and c.delete_after < (now() at time zone 'Asia/Dubai')::date
       and c.retention_basis <> 'employee'
       and c.converted_technician_id is null
       and not exists (
             select 1 from applications a
              where a.candidate_id = c.id and a.status = 'active' and a.deleted_at is null
           )
       and not exists (
             select 1 from talent_pool_members t
              where t.candidate_id = c.id and t.consent_withdrawn_at is null
           )
  `)) as unknown as { storage_key: string }[];

  const deleted = (await tx.execute<{ id: string }>(sql`
    with doomed as (
      select c.id
        from candidates c
       where c.delete_after is not null
         and c.delete_after < (now() at time zone 'Asia/Dubai')::date
         -- Became an employee: HR-15's clock owns them now.
         and c.retention_basis <> 'employee'
         and c.converted_technician_id is null
         -- A decision is still outstanding. Deleting here would guarantee this
         -- person never hears back, which is the failure ATS-16 exists to stop.
         and not exists (
               select 1 from applications a
                where a.candidate_id = c.id and a.status = 'active' and a.deleted_at is null
             )
         -- Consent is a different lawful basis with a different clock.
         and not exists (
               select 1 from talent_pool_members t
                where t.candidate_id = c.id and t.consent_withdrawn_at is null
             )
       order by c.delete_after
       limit ${limit}
    )
    delete from candidates c
     using doomed d
     where c.id = d.id
    returning c.id
  `)) as unknown as { id: string }[];

  if (deleted.length > 0) {
    // One summary row. The identifiers are recorded; the name, phone number and
    // certificate numbers that were on those rows are not — an audit trail that
    // preserves the data a purge removed has not purged anything.
    await writeAuditNote(tx, ctx, {
      tableName: "candidates",
      action: "retention_purge",
      detail: {
        rule: "ATS-18",
        rowsDeleted: deleted.length,
        lawfulBasis: "pre_contractual (Federal Decree-Law 45/2021, Article 4)",
        cascaded: "applications, candidate_certifications, candidate_documents, application_events",
        batchLimit: limit,
        truncatedByBatchLimit: deleted.length === limit,
        orphanedStorageKeys: keyRows.length,
      },
    });
  }

  return {
    table: "candidates",
    rule: "ATS-18",
    deleted: deleted.length,
    heldForFinancialFloor: 0,
    orphanedStorageKeys: keyRows.map((r) => r.storage_key),
  };
}

/**
 * `ATS-13`. Pool members whose consent needs re-confirming.
 *
 * The pool's other killer feature, certification-expiry alerting, is the query
 * below it — a pool member whose ticket lapsed last month is not a prospect,
 * they are a phone call.
 */
export async function talentPoolNeedingReconfirmation(
  tx: TenantScopedTx,
  limit = 100,
): Promise<readonly { candidateId: string; fullName: string; phone: string; poolKey: string; dueAt: Date }[]> {
  const rows = (await tx.execute<{
    candidate_id: string;
    full_name: string;
    phone: string;
    pool_key: string;
    reconfirm_due_at: string;
  }>(sql`
    select t.candidate_id, c.full_name, c.phone, t.pool_key, t.reconfirm_due_at
      from talent_pool_members t
      join candidates c on c.id = t.candidate_id
     where t.consent_withdrawn_at is null
       and t.reconfirm_due_at <= now()
       and t.deleted_at is null
       and c.deleted_at is null
     order by t.reconfirm_due_at
     limit ${limit}
  `)) as unknown as {
    candidate_id: string;
    full_name: string;
    phone: string;
    pool_key: string;
    reconfirm_due_at: string;
  }[];

  return rows.map((r) => ({
    candidateId: r.candidate_id,
    fullName: r.full_name,
    phone: r.phone,
    poolKey: r.pool_key,
    dueAt: new Date(r.reconfirm_due_at),
  }));
}

export interface TalentPoolExpiry {
  readonly candidateId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly scheme: string;
  /**
   * `YYYY-MM-DD`, as a string, all the way to the screen.
   *
   * Never a Date. This is a day-valued column, and a day put through a JS Date
   * moves by the local UTC offset — in the direction that reports a ticket
   * which lapsed yesterday as still valid, which is the exact failure this
   * whole query exists to catch.
   */
  readonly expiresOn: string;
  /** Already gone, rather than going. Decided by Postgres, in Asia/Dubai. */
  readonly lapsed: boolean;
}

/**
 * `ATS-13`'s killer feature: pool members whose certification has lapsed.
 *
 * Called by the recruitment cron, which counts it and warns on it, and by the
 * pool screen, which names them. It was written before either existed, and an
 * alert nothing calls is the same thing as no alert — see the note on the cron
 * route about why it fires there and not only on a screen.
 */
export async function talentPoolExpiringCertifications(
  tx: TenantScopedTx,
  withinDays = CERTIFICATION_EXPIRY_WINDOW_DAYS,
): Promise<readonly TalentPoolExpiry[]> {
  const rows = (await tx.execute<{
    candidate_id: string;
    full_name: string;
    phone: string;
    scheme: string;
    expires_on: string;
    lapsed: boolean;
  }>(sql`
    select distinct on (cc.id)
           c.id as candidate_id, c.full_name, c.phone, cc.scheme,
           to_char(cc.expires_on, 'YYYY-MM-DD') as expires_on,
           (cc.expires_on < (now() at time zone 'Asia/Dubai')::date) as lapsed
      from candidate_certifications cc
      join candidates c on c.id = cc.candidate_id
      join talent_pool_members t on t.candidate_id = c.id and t.consent_withdrawn_at is null
     where cc.deleted_at is null
       and c.deleted_at is null
       and cc.expires_on <= (now() at time zone 'Asia/Dubai')::date + make_interval(days => ${withinDays})
     order by cc.id, cc.expires_on
  `)) as unknown as {
    candidate_id: string;
    full_name: string;
    phone: string;
    scheme: string;
    expires_on: string;
    lapsed: boolean;
  }[];

  return rows.map((r) => ({
    candidateId: r.candidate_id,
    fullName: r.full_name,
    phone: r.phone,
    scheme: r.scheme,
    expiresOn: r.expires_on,
    lapsed: r.lapsed,
  }));
}

export interface TalentPoolMemberRow {
  readonly candidateId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly primaryTrade: string;
  readonly poolKey: string;
  readonly addedReason: string | null;
  readonly consentCapturedAt: Date;
  readonly reconfirmDueAt: Date;
  readonly reconfirmedAt: Date | null;
  /** The consent is stale now, not at some point in the future. */
  readonly reconfirmDue: boolean;
  readonly certificationCount: number;
  readonly lapsedCount: number;
  readonly expiringCount: number;
  /** `YYYY-MM-DD` or null. A day, kept as a day — see `TalentPoolExpiry`. */
  readonly earliestExpiry: string | null;
}

/**
 * Browse the pool (`ATS-13`).
 *
 * ── WHY THERE ARE EXACTLY TWO FILTERS ───────────────────────────────────────
 *
 * Trade, and whether the person's ticket is still good. Those are the two
 * questions somebody staffing a job on Sunday morning actually asks, and a pool
 * that cannot answer them is a table nobody opens twice.
 *
 * What is not here: a relevance score, a ranking, a match percentage, a
 * "strength" (`ATS-19`). The order is by consequence — lapsed certificates
 * first, then ones about to lapse, then consents that have gone stale — and a
 * human reads the list. Ordering *is* a judgement, so it is one that can be
 * stated in a sentence and argued with, rather than a number nobody can audit.
 *
 * Certifications are counted in the same statement rather than fetched per row,
 * because the whole point is a list somebody scans.
 */
export async function listTalentPool(
  tx: TenantScopedTx,
  filter: {
    poolKey?: string | undefined;
    certifications?: TalentPoolCertFilter | undefined;
    limit?: number | undefined;
  } = {},
): Promise<readonly TalentPoolMemberRow[]> {
  const poolKey = filter.poolKey?.trim() || null;
  const certificates = filter.certifications ?? "any";
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);

  // Written as SQL fragments rather than as a filter over the fetched rows: a
  // filter applied after LIMIT returns a short page of the wrong thing, and the
  // person reading it has no way of telling.
  const having =
    certificates === "lapsed"
      ? sql`having count(cc.id) filter (where cc.expires_on < (now() at time zone 'Asia/Dubai')::date) > 0`
      : certificates === "expiring"
        ? sql`having count(cc.id) filter (
                 where cc.expires_on >= (now() at time zone 'Asia/Dubai')::date
                   and cc.expires_on <= (now() at time zone 'Asia/Dubai')::date
                        + make_interval(days => ${CERTIFICATION_EXPIRY_WINDOW_DAYS})
               ) > 0`
        : certificates === "valid"
          ? sql`having count(cc.id) > 0
                   and count(cc.id) filter (where cc.expires_on < (now() at time zone 'Asia/Dubai')::date) = 0`
          : certificates === "none"
            ? sql`having count(cc.id) = 0`
            : sql``;

  type Row = {
    candidate_id: string;
    full_name: string;
    phone: string;
    email: string | null;
    primary_trade: string;
    pool_key: string;
    added_reason: string | null;
    consent_captured_at: string;
    reconfirm_due_at: string;
    reconfirmed_at: string | null;
    reconfirm_due: boolean;
    certification_count: number;
    lapsed_count: number;
    expiring_count: number;
    earliest_expiry: string | null;
  };

  const rows = (await tx.execute<Row>(sql`
    select c.id as candidate_id, c.full_name, c.phone, c.email, c.primary_trade,
           t.pool_key, t.added_reason,
           t.consent_captured_at, t.reconfirm_due_at, t.reconfirmed_at,
           (t.reconfirm_due_at <= now()) as reconfirm_due,
           count(cc.id)::int as certification_count,
           count(cc.id) filter (
             where cc.expires_on < (now() at time zone 'Asia/Dubai')::date
           )::int as lapsed_count,
           count(cc.id) filter (
             where cc.expires_on >= (now() at time zone 'Asia/Dubai')::date
               and cc.expires_on <= (now() at time zone 'Asia/Dubai')::date
                    + make_interval(days => ${CERTIFICATION_EXPIRY_WINDOW_DAYS})
           )::int as expiring_count,
           to_char(min(cc.expires_on), 'YYYY-MM-DD') as earliest_expiry
      from talent_pool_members t
      join candidates c on c.id = t.candidate_id
      left join candidate_certifications cc
             on cc.candidate_id = c.id and cc.deleted_at is null
     where t.consent_withdrawn_at is null
       and t.deleted_at is null
       and c.deleted_at is null
       and (${poolKey}::text is null or t.pool_key = ${poolKey}::text)
     group by c.id, c.full_name, c.phone, c.email, c.primary_trade,
              t.pool_key, t.added_reason, t.consent_captured_at,
              t.reconfirm_due_at, t.reconfirmed_at
     ${having}
     order by (count(cc.id) filter (
                where cc.expires_on < (now() at time zone 'Asia/Dubai')::date
              ) > 0) desc,
              (count(cc.id) filter (
                where cc.expires_on >= (now() at time zone 'Asia/Dubai')::date
                  and cc.expires_on <= (now() at time zone 'Asia/Dubai')::date
                       + make_interval(days => ${CERTIFICATION_EXPIRY_WINDOW_DAYS})
              ) > 0) desc,
              (t.reconfirm_due_at <= now()) desc,
              c.full_name
     limit ${limit}
  `)) as unknown as Row[];

  return rows.map((r) => ({
    candidateId: r.candidate_id,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    primaryTrade: r.primary_trade,
    poolKey: r.pool_key,
    addedReason: r.added_reason,
    consentCapturedAt: requiredRowDate(r.consent_captured_at),
    reconfirmDueAt: requiredRowDate(r.reconfirm_due_at),
    reconfirmedAt: rowDate(r.reconfirmed_at),
    reconfirmDue: r.reconfirm_due,
    certificationCount: Number(r.certification_count ?? 0),
    lapsedCount: Number(r.lapsed_count ?? 0),
    expiringCount: Number(r.expiring_count ?? 0),
    earliestExpiry: r.earliest_expiry,
  }));
}

/**
 * Record that somebody re-confirmed their consent (`ATS-13`).
 *
 * ── WHY THIS WAS THE MISSING HALF ───────────────────────────────────────────
 *
 * `reconfirm_due_at` was set on the way in and read by the alert, and nothing
 * anywhere wrote `reconfirmed_at`. So the cycle had a start and an alarm and no
 * way to finish: every member who came due stayed due for ever, the list only
 * grew, and the one honest response left was to stop looking at it.
 *
 * This is the finish. It is not an automated consent — the clock is reset by a
 * person who has just spoken to the candidate, which is the only thing that
 * makes the record true. There is no bulk version and there will not be one.
 *
 * A withdrawn consent is refused rather than quietly revived, because the two
 * are not the same fact and the difference is the lawful basis for holding the
 * row at all.
 */
export async function reconfirmTalentPoolMember(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { candidateId: string; poolKey: string; note?: string | undefined },
): Promise<{ fullName: string; nextDueAt: Date }> {
  type StateRow = {
    id: string;
    full_name: string;
    consent_withdrawn_at: string | null;
  };

  const state = (await tx.execute<StateRow>(sql`
    select t.id, c.full_name, t.consent_withdrawn_at
      from talent_pool_members t
      join candidates c on c.id = t.candidate_id
     where t.candidate_id = ${input.candidateId}::uuid
       and t.pool_key = ${input.poolKey}
       and t.deleted_at is null
       and c.deleted_at is null
     limit 1
  `)) as unknown as StateRow[];

  const member = state[0];
  if (!member) {
    throw new UserFacingError("That person is not in this pool.");
  }
  if (member.consent_withdrawn_at) {
    throw new UserFacingError(
      "This person withdrew their consent. Re-confirming is not the same thing as asking again — " +
        "they have to be added back through a new conversation.",
    );
  }

  type UpdatedRow = { reconfirm_due_at: string };
  const updated = (await tx.execute<UpdatedRow>(sql`
    update talent_pool_members
       set reconfirmed_at = now(),
           reconfirm_due_at = now() + make_interval(days => ${TALENT_POOL_RECONFIRM_DAYS}),
           updated_at = now()
     where id = ${member.id}::uuid
    returning reconfirm_due_at
  `)) as unknown as UpdatedRow[];

  const nextDueAt = requiredRowDate(updated[0]?.reconfirm_due_at);

  // Consent is the lawful basis for holding this row, so when it was last
  // confirmed and by whom is a fact somebody may have to produce. No trigger
  // can capture it: the event is a phone call.
  await writeAuditNote(tx, ctx, {
    tableName: "talent_pool_members",
    recordId: member.id,
    // Sixteen characters, because that is what audit_log.action is. Not
    // "consent_reconfirmed", which is clearer and does not fit.
    action: "reconfirmed",
    detail: {
      rule: "ATS-13",
      poolKey: input.poolKey,
      candidateId: input.candidateId,
      nextDueAt: nextDueAt.toISOString(),
      lawfulBasis: "consent (Federal Decree-Law 45/2021)",
      ...(input.note ? { note: input.note } : {}),
    },
  });

  await touchCandidate(tx, input.candidateId);

  return { fullName: member.full_name, nextDueAt };
}

/**
 * Withdraw a pool consent (`ATS-13`, `ATS-18`).
 *
 * ── WHY THIS EXISTS, GIVEN NOTHING ASKED FOR IT ─────────────────────────────
 *
 * `consent_withdrawn_at` was read in four places — the pool list, the
 * re-confirmation alert, the expiry alert and the retention purge — and written
 * in none. It is the same shape of gap as `reconfirmed_at`: a column the system
 * makes decisions on that no path in the product can set.
 *
 * It matters more than the other one, because consent is the *only* lawful
 * basis holding these rows and withdrawal is the right that comes with it. A
 * pool somebody can join and never leave is not a consented pool.
 *
 * ── AND WHY IT TOUCHES THE RETENTION CLOCK ──────────────────────────────────
 *
 * `touchCandidate` reads `retention_basis` to decide the clock: twelve months
 * on `consent`, six on everything else. Flipping `consent_withdrawn_at` alone
 * would leave the basis saying `consent`, so the next interaction of any kind
 * would renew a twelve-month retention on a consent that had been withdrawn —
 * the row outliving the permission for it, quietly, via a column nobody was
 * looking at.
 *
 * So the basis moves back, but only when no *other* pool consent survives (a
 * person can sit in several pools), and never for somebody who became an
 * employee — `HR-15` owns that clock and this has no business touching it.
 *
 * The new `delete_after` is counted from the existing `last_interaction_at`,
 * not from now. Withdrawing consent must not be able to *extend* how long the
 * record is kept, which is what re-using `touchCandidate` here would do.
 */
export async function withdrawTalentPoolConsent(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { candidateId: string; poolKey: string; reason?: string | undefined },
): Promise<{ fullName: string; retentionBasis: string; remainingPools: number }> {
  type StateRow = {
    id: string;
    full_name: string;
    retention_basis: string;
    consent_withdrawn_at: string | null;
  };

  const state = (await tx.execute<StateRow>(sql`
    select t.id, c.full_name, c.retention_basis, t.consent_withdrawn_at
      from talent_pool_members t
      join candidates c on c.id = t.candidate_id
     where t.candidate_id = ${input.candidateId}::uuid
       and t.pool_key = ${input.poolKey}
       and t.deleted_at is null
       and c.deleted_at is null
     limit 1
  `)) as unknown as StateRow[];

  const member = state[0];
  if (!member) throw new UserFacingError("That person is not in this pool.");
  if (member.consent_withdrawn_at) {
    throw new UserFacingError("This consent has already been withdrawn.");
  }

  await tx.execute(sql`
    update talent_pool_members
       set consent_withdrawn_at = now(),
           updated_at = now()
     where id = ${member.id}::uuid
  `);

  const remaining = (await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from talent_pool_members
     where candidate_id = ${input.candidateId}::uuid
       and consent_withdrawn_at is null
       and deleted_at is null
  `)) as unknown as { count: number }[];

  const remainingPools = Number(remaining[0]?.count ?? 0);
  let retentionBasis = member.retention_basis;

  if (remainingPools === 0 && member.retention_basis === "consent") {
    // Counted from the last interaction rather than from now, so a withdrawal
    // can only ever shorten the retention. Employees are excluded by the basis
    // check itself: theirs never reads consent.
    await tx.execute(sql`
      update candidates
         set retention_basis = 'pre_contractual',
             delete_after = ((last_interaction_at at time zone 'Asia/Dubai')::date
                              + interval '6 months')::date,
             updated_at = now()
       where id = ${input.candidateId}::uuid
         and retention_basis = 'consent'
    `);
    retentionBasis = "pre_contractual";
  }

  // Sixteen characters is the limit on audit_log.action, which rules out
  // "consent_withdrawn". The detail below carries what the name cannot.
  await writeAuditNote(tx, ctx, {
    tableName: "talent_pool_members",
    recordId: member.id,
    action: "withdrawn",
    detail: {
      rule: "ATS-13",
      poolKey: input.poolKey,
      candidateId: input.candidateId,
      remainingPools,
      retentionBasis,
      retentionClockShortened: retentionBasis === "pre_contractual" && member.retention_basis === "consent",
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });

  return { fullName: member.full_name, retentionBasis, remainingPools };
}

// ── Candidate detail (wireframe §5.2) ───────────────────────────────────────

export interface CandidateDetail {
  readonly applicationId: string;
  readonly reference: string;
  readonly candidateId: string;
  readonly fullName: string;
  readonly phone: string;
  readonly email: string | null;
  readonly primaryTrade: string;
  readonly grade: string;
  readonly experienceBand: string;
  readonly currentLocation: string;
  readonly availability: string | null;
  readonly essentialFunctions: string | null;
  readonly visaStatus: VisaStatus | null;
  readonly visaCurrentSponsor: string | null;
  readonly status: string;
  readonly stageId: string | null;
  readonly stageName: string | null;
  readonly stageType: string | null;
  readonly stageEnteredAt: Date;
  readonly blockedOn: BlockedOn;
  readonly blockedNote: string | null;
  readonly tone: "green" | "amber" | "red";
  readonly toneLabel: string;
  readonly appliedAt: Date;
  readonly outcomeDueAt: Date;
  readonly outcomeSentAt: Date | null;
  readonly outcomeScheduledAt: Date | null;
  readonly outcomeMessage: string | null;
  readonly dispositionReasonCode: string | null;
  readonly requisitionId: string;
  readonly roleTitle: string;
  readonly statusToken: string;
  readonly certifications: readonly {
    id: string;
    scheme: string;
    certificateNo: string | null;
    issuingBody: string | null;
    expiresOn: Date;
    expired: boolean;
    verifiedAt: Date | null;
  }[];
  readonly documents: readonly {
    id: string;
    kind: string;
    filename: string | null;
    scanStatus: ScanStatus;
    parseStatus: string;
    sizeBytes: number;
    uploadedAt: Date;
    downloadable: boolean;
  }[];
  readonly events: readonly {
    id: string;
    eventType: string;
    note: string | null;
    occurredAt: Date;
    actorKind: string;
  }[];
  /** `ATS-12`. Prior applications, surfaced prominently. */
  readonly priorApplications: readonly {
    reference: string;
    roleTitle: string;
    status: string;
    dispositionReasonCode: string | null;
    appliedAt: Date;
  }[];
  readonly duplicates: readonly DuplicateSuggestion[];
}

type CandidateDetailRow = {
  application_id: string;
  reference: string;
  status: string;
  current_stage_id: string | null;
  stage_entered_at: string;
  blocked_on: string;
  blocked_note: string | null;
  availability: string | null;
  essential_functions: string | null;
  applied_at: string;
  outcome_due_at: string;
  outcome_sent_at: string | null;
  outcome_scheduled_at: string | null;
  outcome_message: string | null;
  disposition_reason_code: string | null;
  status_token: string;
  candidate_id: string;
  full_name: string;
  phone: string;
  email: string | null;
  primary_trade: string;
  grade: string;
  experience_band: string;
  current_location: string;
  visa_status: string | null;
  visa_current_sponsor: string | null;
  requisition_id: string;
  title: string;
  stage_name: string | null;
  stage_type: string | null;
};

export async function getCandidateDetail(
  tx: TenantScopedTx,
  applicationId: string,
): Promise<CandidateDetail | null> {
  const rows = (await tx.execute<CandidateDetailRow>(sql`
    select a.id as application_id, a.reference, a.status, a.current_stage_id, a.stage_entered_at,
           a.blocked_on, a.blocked_note, a.availability, a.essential_functions,
           a.applied_at, a.outcome_due_at, a.outcome_sent_at, a.outcome_scheduled_at,
           a.outcome_message, a.disposition_reason_code, a.status_token,
           c.id as candidate_id, c.full_name, c.phone, c.email, c.primary_trade, c.grade,
           c.experience_band, c.current_location, c.visa_status, c.visa_current_sponsor,
           r.id as requisition_id, r.title,
           s.name as stage_name, s.stage_type
      from applications a
      join candidates c on c.id = a.candidate_id
      join job_requisitions r on r.id = a.requisition_id
      left join requisition_stages s on s.id = a.current_stage_id
     where a.id = ${applicationId}
       and a.deleted_at is null
     limit 1
  `)) as unknown as CandidateDetailRow[];

  const row = rows[0];
  if (!row) return null;

  const candidateId = row.candidate_id;
  const stageEnteredAt = new Date(row.stage_entered_at);
  const state = blockedState({ blockedOn: row.blocked_on as BlockedOn, stageEnteredAt });

  const certifications = await tx
    .select({
      id: schema.candidateCertifications.id,
      scheme: schema.candidateCertifications.scheme,
      certificateNo: schema.candidateCertifications.certificateNo,
      issuingBody: schema.candidateCertifications.issuingBody,
      expiresOn: schema.candidateCertifications.expiresOn,
      verifiedAt: schema.candidateCertifications.verifiedAt,
    })
    .from(schema.candidateCertifications)
    .where(
      and(
        eq(schema.candidateCertifications.candidateId, candidateId),
        isNull(schema.candidateCertifications.deletedAt),
      ),
    )
    .orderBy(asc(schema.candidateCertifications.expiresOn));

  const documents = await tx
    .select({
      id: schema.candidateDocuments.id,
      kind: schema.candidateDocuments.kind,
      filename: schema.candidateDocuments.filename,
      scanStatus: schema.candidateDocuments.scanStatus,
      parseStatus: schema.candidateDocuments.parseStatus,
      sizeBytes: schema.candidateDocuments.sizeBytes,
      uploadedAt: schema.candidateDocuments.uploadedAt,
    })
    .from(schema.candidateDocuments)
    .where(
      and(
        eq(schema.candidateDocuments.candidateId, candidateId),
        isNull(schema.candidateDocuments.deletedAt),
      ),
    )
    .orderBy(desc(schema.candidateDocuments.uploadedAt));

  const events = await tx
    .select({
      id: schema.applicationEvents.id,
      eventType: schema.applicationEvents.eventType,
      note: schema.applicationEvents.note,
      occurredAt: schema.applicationEvents.occurredAt,
      actorKind: schema.applicationEvents.actorKind,
    })
    .from(schema.applicationEvents)
    .where(eq(schema.applicationEvents.applicationId, applicationId))
    .orderBy(desc(schema.applicationEvents.occurredAt))
    .limit(50);

  const prior = (await tx.execute<{
    reference: string;
    title: string;
    status: string;
    disposition_reason_code: string | null;
    applied_at: string;
  }>(sql`
    select a.reference, r.title, a.status, a.disposition_reason_code, a.applied_at
      from applications a
      join job_requisitions r on r.id = a.requisition_id
     where a.candidate_id = ${candidateId}
       and a.id <> ${applicationId}
       and a.deleted_at is null
     order by a.applied_at desc
     limit 10
  `)) as unknown as {
    reference: string;
    title: string;
    status: string;
    disposition_reason_code: string | null;
    applied_at: string;
  }[];

  const today = new Date().toISOString().slice(0, 10);

  return {
    applicationId,
    reference: row.reference,
    candidateId,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    primaryTrade: row.primary_trade,
    grade: row.grade,
    experienceBand: row.experience_band,
    currentLocation: row.current_location,
    availability: row.availability,
    essentialFunctions: row.essential_functions,
    visaStatus: (row.visa_status as VisaStatus | null) ?? null,
    visaCurrentSponsor: row.visa_current_sponsor,
    status: row.status,
    stageId: row.current_stage_id,
    stageName: row.stage_name,
    stageType: row.stage_type,
    stageEnteredAt,
    blockedOn: row.blocked_on as BlockedOn,
    blockedNote: row.blocked_note,
    tone: state.tone,
    toneLabel: state.label,
    appliedAt: new Date(row.applied_at),
    outcomeDueAt: new Date(row.outcome_due_at),
    outcomeSentAt: row.outcome_sent_at ? new Date(row.outcome_sent_at) : null,
    outcomeScheduledAt: row.outcome_scheduled_at ? new Date(row.outcome_scheduled_at) : null,
    outcomeMessage: row.outcome_message,
    dispositionReasonCode: row.disposition_reason_code,
    requisitionId: row.requisition_id,
    roleTitle: row.title,
    statusToken: row.status_token,
    certifications: certifications.map((c) => ({
      id: c.id,
      scheme: c.scheme,
      certificateNo: c.certificateNo,
      issuingBody: c.issuingBody,
      expiresOn: new Date(c.expiresOn),
      expired: c.expiresOn < today,
      verifiedAt: c.verifiedAt,
    })),
    documents: documents.map((d) => ({
      id: d.id,
      kind: d.kind,
      filename: d.filename,
      scanStatus: d.scanStatus as ScanStatus,
      parseStatus: d.parseStatus,
      sizeBytes: d.sizeBytes,
      uploadedAt: d.uploadedAt,
      // `ATS-9`. Computed here rather than in the template, so a second screen
      // showing the same file cannot forget the gate — and computed by the
      // *same function the download route uses*, so the link a recruiter is
      // shown and the refusal they would get are one decision rather than two
      // copies of one that can drift apart.
      downloadable: isDownloadable(d.scanStatus as ScanStatus),
    })),
    events,
    priorApplications: prior.map((p) => ({
      reference: p.reference,
      roleTitle: p.title,
      status: p.status,
      dispositionReasonCode: p.disposition_reason_code,
      appliedAt: new Date(p.applied_at),
    })),
    duplicates: await duplicateSuggestions(tx, candidateId),
  };
}

/**
 * Attach an uploaded file to a candidate (`ATS-9`).
 *
 * The bytes are written by `packages/files`, which sniffs the content type from
 * magic bytes and refuses anything outside its allowlist — SVG and HTML among
 * them, by construction rather than by an extension check. This function
 * records what was stored; it never decides what may be stored.
 */
export async function attachCandidateDocument(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    candidateId: string;
    applicationId?: string | undefined;
    kind: "cv" | "certificate" | "other";
    storageKey: string;
    filename: string | null;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    scanStatus: ScanStatus;
  },
): Promise<{ documentId: string }> {
  const [row] = await tx
    .insert(schema.candidateDocuments)
    .values({
      tenantId: ctx.tenantId,
      candidateId: input.candidateId,
      applicationId: input.applicationId ?? null,
      kind: input.kind,
      storageKey: input.storageKey,
      filename: input.filename,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      scanStatus: input.scanStatus,
      scannedAt: input.scanStatus === "pending" ? null : new Date(),
      scannerNote:
        input.scanStatus === "skipped"
          ? "No antivirus provider is configured for this deployment"
          : null,
      // `ATS-10`. Nothing parses CVs yet, and saying "not attempted" is the
      // honest value — "failed" would imply a parser ran.
      parseStatus: "not_attempted",
    })
    .returning({ id: schema.candidateDocuments.id });

  if (!row) throw new Error("Failed to record the uploaded document");

  if (input.applicationId) {
    await tx.insert(schema.applicationEvents).values({
      tenantId: ctx.tenantId,
      applicationId: input.applicationId,
      eventType: "document_added",
      note: input.filename,
      payload: { kind: input.kind, scanStatus: input.scanStatus },
      actorUserId: ctx.userId ?? null,
      actorKind: ctx.userId ? "user" : "candidate",
    });
  }

  await touchCandidate(tx, input.candidateId);
  return { documentId: row.id };
}

export interface CandidateDocumentForDownload {
  readonly documentId: string;
  readonly candidateId: string;
  readonly applicationId: string | null;
  readonly kind: string;
  readonly storageKey: string;
  readonly filename: string | null;
  readonly scanStatus: ScanStatus;
}

/**
 * One candidate document, with its storage key, for the download route
 * (`ATS-9`).
 *
 * ── WHY THIS IS NOT PART OF `getCandidateDetail` ────────────────────────────
 *
 * `getCandidateDetail` deliberately omits `storage_key` from its document
 * shape, so that a Server Component rendering a candidate never holds one and
 * cannot leak one into the HTML it sends. That omission is only worth anything
 * if the key is fetched somewhere narrower, by something that needs it — which
 * is this, called by exactly one route.
 *
 * Keyed on the document id alone, and not on the application. A document
 * belongs to a *candidate*; `application_id` is nullable, because a CV can be
 * attached to somebody who is in the talent pool and has no live application.
 * A route nested under an application would be unable to address those files at
 * all. The id is a uuid and row-level security scopes it to the tenant, so a
 * document id from another tenant simply does not resolve.
 *
 * The scan status is returned, not judged. The gate is `isDownloadable`, and
 * the route applies it to what this returns.
 */
export async function getCandidateDocumentForDownload(
  tx: TenantScopedTx,
  documentId: string,
): Promise<CandidateDocumentForDownload | null> {
  const [row] = await tx
    .select({
      id: schema.candidateDocuments.id,
      candidateId: schema.candidateDocuments.candidateId,
      applicationId: schema.candidateDocuments.applicationId,
      kind: schema.candidateDocuments.kind,
      storageKey: schema.candidateDocuments.storageKey,
      filename: schema.candidateDocuments.filename,
      scanStatus: schema.candidateDocuments.scanStatus,
    })
    .from(schema.candidateDocuments)
    .where(
      and(
        eq(schema.candidateDocuments.id, documentId),
        isNull(schema.candidateDocuments.deletedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    documentId: row.id,
    candidateId: row.candidateId,
    applicationId: row.applicationId,
    kind: row.kind,
    storageKey: row.storageKey,
    filename: row.filename,
    scanStatus: row.scanStatus as ScanStatus,
  };
}

/** Grades, exported for the forms, so the picker cannot drift from the CHECK. */
export const RECRUITMENT_GRADES = CANDIDATE_GRADES;

/** Used by the tests and the duplicate panel; re-exported so callers need one import. */
export { phoneLocalDigits, isNotNull };
