import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { writeAuditNote } from "./staff";
import {
  MATERIAL_SOURCES,
  UserFacingError,
  isMaterialSource,
  toDecimalString,
  type MaterialSource,
} from "@meridian/core";

/**
 * The job card, and the gate on completing a job (`JOB-15`).
 *
 * ── THE REQUIREMENT, IN FULL ────────────────────────────────────────────────
 *
 * "Job cannot be marked complete without: outcome code, at least one 'after'
 * photo (or an explicit reason-coded exemption), materials recorded or
 * explicitly 'none', and labour time. Enforced in the domain layer, not the
 * UI."
 *
 * `0024` and `domain/outcomes.ts` built the outcome half. The other three were
 * enforced nowhere at all, so a job could reach `work_complete` carrying no
 * photo, no parts and no time — and every one of those is unrecoverable
 * afterwards, because nobody reconstructs in March what a van carried on a
 * Tuesday in January.
 *
 * ── WHY THE LAST SENTENCE OF THE REQUIREMENT IS THE LOAD-BEARING ONE ────────
 *
 * "Enforced in the domain layer, not the UI." `M11` is a React Native field app
 * (`ADR 0009`) that will reach these same records through an API. A required
 * attribute on a form input protects nothing from it, and neither does a check
 * in a server action that only one of two clients calls. So the refusal lives
 * in `assertJobCardComplete` below, `recordJobOutcome` calls it inside the same
 * transaction that would otherwise perform the transition, and a job that fails
 * the check leaves that transaction with nothing written.
 *
 * ── WHAT "LABOUR TIME" KEYS OFF, AND WHY NOT THE OTHER CANDIDATES ───────────
 *
 * `job_visits.work_minutes`, an integer column that has existed since `0000`
 * and that nothing has ever written.
 *
 * The two alternatives were considered and rejected:
 *
 *   * `attendance_events` is a clock-in and clock-out stream per technician. It
 *     answers "was this person at work today", not "how long did this job
 *     take": a technician on four jobs in a day produces one pair of events and
 *     no way to divide the day between them. It is also the wrong grain for
 *     costing, which is the thing labour time is for here.
 *
 *   * `overtime_records`, written by `recordWorkedDay` for `HR-8`, is per
 *     employee per calendar day and computes rate bands and the 48-hour week
 *     from it. Feeding job labour into it would put two different questions in
 *     one table and make payroll depend on whether a job card was filled in.
 *
 * These are deliberately **not** two homes for the same number. Job labour is
 * per visit and priced against the job; paid hours are per person and per day
 * and priced against a contract of employment. A technician's day can hold four
 * jobs' labour and one day's pay, and nothing here reads or writes the payroll
 * side. Whether the two should ever be reconciled is a real question and it is
 * not answered here.
 *
 * ── WHY ZERO MINUTES IS A LEGAL ANSWER ──────────────────────────────────────
 *
 * The gate asks that labour time be *recorded*, not that it be positive. A
 * `no_access` visit is a real outcome — a large share of real visits, per the
 * note in `outcomes.ts` — and the honest labour figure for it is zero: the
 * technician travelled, could not get in, and spent no time on the tools.
 * Demanding a positive number would produce a fabricated one, and this is the
 * same distinction the materials clause makes explicit: a recorded zero is a
 * fact, a null is nobody having filled the section in.
 */

// ── The exemption vocabulary (JOB-15) ───────────────────────────────────────

/**
 * The list every tenant starts with.
 *
 * Seeded rather than left to an administrator, for the reason `seed.ts` gives
 * about job outcomes: a controlled list that ships empty is a picker with
 * nothing in it, and the operator faced with one writes the reason into the
 * note field instead — which is the free text the table exists to prevent, and
 * `JOB-15` says "reason-coded" precisely to forbid it.
 *
 * Five entries, each a situation that genuinely produces no photograph. None of
 * them is "forgot", because that is not an exemption: it is the gap the gate
 * exists to catch.
 */
export const STANDARD_PHOTO_EXEMPTION_REASONS: readonly {
  code: string;
  label: string;
  description: string;
  sortOrder: number;
}[] = [
  {
    code: "nothing_visible",
    label: "Nothing visible to photograph",
    description:
      "The work is inside a sealed unit, a duct, a wall or a buried run, and a photograph would show a closed panel.",
    sortOrder: 10,
  },
  {
    code: "photography_prohibited",
    label: "Photography prohibited on site",
    description:
      "Security, government, data-centre or landlord rules forbid cameras in the area worked in.",
    sortOrder: 20,
  },
  {
    code: "customer_refused",
    label: "Customer refused photography",
    description: "The occupier or building management declined to have the area photographed.",
    sortOrder: 30,
  },
  {
    code: "no_access_to_work",
    label: "Never reached the work",
    description:
      "The visit ended before the work area was reached — no key, no permit, blocked route — so there was nothing to photograph.",
    sortOrder: 40,
  },
  {
    code: "unsafe_to_photograph",
    label: "Unsafe to photograph",
    description:
      "Live plant, confined space or height work where stopping to take a photograph would have been the hazard.",
    sortOrder: 50,
  },
];

export interface PhotoExemptionReason {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly isActive: boolean;
}

/**
 * The picker, or the whole list.
 *
 * ── WHY THE DEFAULT DIFFERS FROM `listJobOutcomeCodes` ──────────────────────
 *
 * That one returns everything unless asked otherwise, because its first caller
 * was the administration screen. This one defaults to active only, because its
 * first caller is a picker — and a retired reason offered in a picker is the
 * bug retirement exists to prevent. Both call sites here pass the flag
 * explicitly anyway, so neither depends on remembering which way it falls.
 */
export async function listPhotoExemptionReasons(
  tx: TenantScopedTx,
  options: { activeOnly?: boolean } = {},
): Promise<readonly PhotoExemptionReason[]> {
  const rows = await tx
    .select({
      id: schema.jobPhotoExemptionReasons.id,
      code: schema.jobPhotoExemptionReasons.code,
      label: schema.jobPhotoExemptionReasons.label,
      description: schema.jobPhotoExemptionReasons.description,
      isActive: schema.jobPhotoExemptionReasons.isActive,
      sortOrder: schema.jobPhotoExemptionReasons.sortOrder,
    })
    .from(schema.jobPhotoExemptionReasons)
    .where(
      options.activeOnly === false
        ? sql`true`
        : eq(schema.jobPhotoExemptionReasons.isActive, true),
    )
    .orderBy(
      asc(schema.jobPhotoExemptionReasons.sortOrder),
      asc(schema.jobPhotoExemptionReasons.label),
    );

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    isActive: r.isActive,
  }));
}

/**
 * Add a reason, or reword one that is already there (`ADM-10`).
 *
 * `on conflict do update` and `is_active = true`, matching
 * `addJobOutcomeCode`: adding a code that exists is how an administrator
 * corrects a label, and adding back one they retired is how they un-retire it.
 * Neither is an error worth showing them.
 */
export async function addPhotoExemptionReason(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    code: string;
    label: string;
    description?: string | null;
    sortOrder?: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into job_photo_exemption_reasons
      (tenant_id, code, label, description, sort_order)
    values (
      ${ctx.tenantId}::uuid,
      ${input.code},
      ${input.label},
      ${input.description ?? null},
      ${input.sortOrder ?? 100}
    )
    on conflict (tenant_id, code) do update
      set label = excluded.label,
          description = excluded.description,
          sort_order = excluded.sort_order,
          is_active = true
  `);
}

/**
 * Retire or restore a reason. Never delete one.
 *
 * There is no delete, and there is deliberately nowhere to add one.
 * `job_card_declarations` carries a composite foreign key to this table with
 * ON DELETE restrict, so a reason cited by a completed job cannot be removed
 * without rewriting that job — and a retired reason must keep rendering on
 * every job card that already names it. Retirement takes it out of the picker
 * and leaves the history alone, which is what the restrict is there to force.
 */
export async function setPhotoExemptionReasonActive(
  tx: TenantScopedTx,
  reasonId: string,
  isActive: boolean,
): Promise<void> {
  await tx.execute(sql`
    update job_photo_exemption_reasons set is_active = ${isActive} where id = ${reasonId}::uuid
  `);
}

/**
 * Install the standard list for a tenant that has none.
 *
 * `on conflict do nothing`, so running it against a tenant that already has the
 * list is a no-op and an administrator's reworded label survives it. Returns
 * how many rows were actually inserted, via `returning` rather than a driver's
 * row count — `installStandardJobOutcomes` explains why that distinction
 * matters when the number is shown to an operator.
 */
export async function installStandardPhotoExemptionReasons(
  tx: TenantScopedTx,
  ctx: TenantContext,
): Promise<number> {
  let added = 0;
  for (const reason of STANDARD_PHOTO_EXEMPTION_REASONS) {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into job_photo_exemption_reasons
        (tenant_id, code, label, description, sort_order)
      values (
        ${ctx.tenantId}::uuid,
        ${reason.code},
        ${reason.label},
        ${reason.description},
        ${reason.sortOrder}
      )
      on conflict (tenant_id, code) do nothing
      returning id
    `)) as unknown as { id: string }[];
    if (inserted.length > 0) added++;
  }
  return added;
}

// ── Reading the card ────────────────────────────────────────────────────────

/**
 * The six kinds `job_attachments.kind` accepts. The database agrees (`0025`,
 * widened to a sixth value by `0034`).
 *
 * `photo_recommendation` (`FLD-12`) is filed only by `job_note/upsert` in
 * `domain/field.ts`, in the same transaction as the recommendation text it
 * illustrates — never a general-purpose "other" bucket, and never counted
 * towards `JOB-15`'s after-photo gap (`getJobCard` below reads `photo_after`
 * only, on purpose: a sales observation is not evidence the work was done).
 */
export const JOB_ATTACHMENT_KINDS = [
  "photo_before",
  "photo_after",
  "signature",
  "document",
  "video",
  "photo_recommendation",
] as const;
export type JobAttachmentKind = (typeof JOB_ATTACHMENT_KINDS)[number];

export interface JobPhoto {
  readonly id: string;
  readonly kind: JobAttachmentKind;
  readonly storageKey: string;
  readonly caption: string | null;
  readonly capturedAt: Date | null;
  readonly visitId: string | null;
}

export interface JobMaterialLine {
  readonly id: string;
  readonly sku: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  /** Integer minor units, never a float. Null when no cost was entered. */
  readonly unitCostMinor: number | null;
  readonly unitPriceMinor: number | null;
  readonly currency: string;
  readonly isBillable: boolean;
  readonly visitId: string | null;
}

export interface JobVisitLabour {
  readonly visitId: string;
  readonly sequence: number;
  readonly technicianName: string;
  /** Null means nobody has filled it in. Zero means no time on the tools. */
  readonly workMinutes: number | null;
  readonly travelMinutes: number | null;
}

export interface JobSignature {
  readonly id: string;
  readonly signedByName: string;
  readonly signedByRole: string | null;
  readonly storageKey: string;
  readonly satisfactionRating: number | null;
  readonly comments: string | null;
  readonly signedAt: Date;
  /** Where the `FLD-14` copy was sent. Null on a signature captured before 0037. */
  readonly signerEmail: string | null;
  /** The wording the signer agreed to, and its version (`FLD-13`). */
  readonly consentVersion: string | null;
  readonly consentText: string | null;
}

/** Which of `JOB-15`'s conditions is not yet met. */
export type JobCardGap = "after_photo" | "materials" | "labour";

export interface JobCard {
  readonly jobId: string;
  readonly photos: readonly JobPhoto[];
  readonly afterPhotoCount: number;
  readonly photoExemption: {
    readonly reasonCode: string;
    readonly reasonLabel: string;
    readonly note: string | null;
    readonly declaredAt: Date;
  } | null;
  readonly materials: readonly JobMaterialLine[];
  readonly materialsNone: { readonly note: string | null; readonly declaredAt: Date } | null;
  readonly labour: readonly JobVisitLabour[];
  /** Sum over the visits where it was recorded. Null when none were. */
  readonly labourMinutes: number | null;
  readonly signature: JobSignature | null;
  /** Empty when the job may be completed. */
  readonly gaps: readonly JobCardGap[];
}

/**
 * Everything `JOB-15` gates on, in one call.
 *
 * Read as one function rather than four so that the screen and the gate cannot
 * disagree about what is outstanding: `assertJobCardComplete` calls this and
 * refuses on `gaps`, and the panel renders the same `gaps` as a checklist. A
 * checklist computed separately from the check is a checklist that eventually
 * says "ready" about a job the server refuses.
 */
export async function getJobCard(tx: TenantScopedTx, jobId: string): Promise<JobCard> {
  const attachments = await tx
    .select({
      id: schema.jobAttachments.id,
      kind: schema.jobAttachments.kind,
      storageKey: schema.jobAttachments.storageKey,
      caption: schema.jobAttachments.caption,
      capturedAt: schema.jobAttachments.capturedAt,
      visitId: schema.jobAttachments.visitId,
    })
    .from(schema.jobAttachments)
    .where(and(eq(schema.jobAttachments.jobId, jobId), isNull(schema.jobAttachments.deletedAt)))
    .orderBy(asc(schema.jobAttachments.createdAt));

  const photos: JobPhoto[] = attachments.map((a) => ({
    id: a.id,
    kind: a.kind as JobAttachmentKind,
    storageKey: a.storageKey,
    caption: a.caption,
    capturedAt: a.capturedAt,
    visitId: a.visitId,
  }));

  const materialRows = await tx
    .select({
      id: schema.jobMaterials.id,
      sku: schema.jobMaterials.sku,
      description: schema.jobMaterials.description,
      quantity: schema.jobMaterials.quantity,
      unit: schema.jobMaterials.unit,
      unitCost: schema.jobMaterials.unitCost,
      unitPrice: schema.jobMaterials.unitPrice,
      currency: schema.jobMaterials.currency,
      isBillable: schema.jobMaterials.isBillable,
      visitId: schema.jobMaterials.visitId,
    })
    .from(schema.jobMaterials)
    .where(and(eq(schema.jobMaterials.jobId, jobId), isNull(schema.jobMaterials.deletedAt)))
    .orderBy(asc(schema.jobMaterials.createdAt));

  const materials: JobMaterialLine[] = materialRows.map((m) => ({
    id: m.id,
    sku: m.sku,
    description: m.description,
    quantity: m.quantity,
    unit: m.unit,
    unitCostMinor: m.unitCost === null ? null : Math.round(Number(m.unitCost) * 100),
    unitPriceMinor: m.unitPrice === null ? null : Math.round(Number(m.unitPrice) * 100),
    currency: m.currency,
    isBillable: m.isBillable,
    visitId: m.visitId,
  }));

  // Left, not inner, on the reason: an exemption recorded before somebody
  // retired the code must still render. Retiring a vocabulary entry rewrites
  // the picker, never the history.
  const declarationRows = await tx
    .select({
      kind: schema.jobCardDeclarations.kind,
      reasonCode: schema.jobCardDeclarations.reasonCode,
      reasonLabel: schema.jobPhotoExemptionReasons.label,
      note: schema.jobCardDeclarations.note,
      createdAt: schema.jobCardDeclarations.createdAt,
    })
    .from(schema.jobCardDeclarations)
    .leftJoin(
      schema.jobPhotoExemptionReasons,
      and(
        eq(schema.jobPhotoExemptionReasons.tenantId, schema.jobCardDeclarations.tenantId),
        eq(schema.jobPhotoExemptionReasons.code, schema.jobCardDeclarations.reasonCode),
      ),
    )
    .where(eq(schema.jobCardDeclarations.jobId, jobId))
    .orderBy(asc(schema.jobCardDeclarations.createdAt));

  const exemptionRow = declarationRows.find((d) => d.kind === "photo_exempt");
  const materialsNoneRow = declarationRows.find((d) => d.kind === "materials_none");

  const visitRows = await tx
    .select({
      visitId: schema.jobVisits.id,
      sequence: schema.jobVisits.sequence,
      technicianName: schema.technicians.fullName,
      workMinutes: schema.jobVisits.workMinutes,
      travelMinutes: schema.jobVisits.travelMinutes,
    })
    .from(schema.jobVisits)
    .innerJoin(schema.technicians, eq(schema.technicians.id, schema.jobVisits.technicianId))
    .where(eq(schema.jobVisits.jobId, jobId))
    .orderBy(asc(schema.jobVisits.sequence));

  const labour: JobVisitLabour[] = visitRows.map((v) => ({
    visitId: v.visitId,
    sequence: v.sequence,
    technicianName: v.technicianName,
    workMinutes: v.workMinutes,
    travelMinutes: v.travelMinutes,
  }));

  const recorded = labour.filter((l) => l.workMinutes !== null);
  const labourMinutes =
    recorded.length === 0 ? null : recorded.reduce((sum, l) => sum + (l.workMinutes ?? 0), 0);

  const signatureRows = await tx
    .select({
      id: schema.jobSignoffs.id,
      signedByName: schema.jobSignoffs.signedByName,
      signedByRole: schema.jobSignoffs.signedByRole,
      storageKey: schema.jobSignoffs.signatureStorageKey,
      satisfactionRating: schema.jobSignoffs.satisfactionRating,
      comments: schema.jobSignoffs.comments,
      signedAt: schema.jobSignoffs.signedAt,
      signerEmail: schema.jobSignoffs.signerEmail,
      consentVersion: schema.jobSignoffs.consentVersion,
      consentText: schema.jobSignoffs.consentText,
    })
    .from(schema.jobSignoffs)
    .where(and(eq(schema.jobSignoffs.jobId, jobId), isNull(schema.jobSignoffs.deletedAt)))
    .orderBy(desc(schema.jobSignoffs.signedAt))
    .limit(1);

  const signature = signatureRows[0] ?? null;

  const afterPhotoCount = photos.filter((p) => p.kind === "photo_after").length;

  const gaps: JobCardGap[] = [];
  if (afterPhotoCount === 0 && !exemptionRow) gaps.push("after_photo");
  if (materials.length === 0 && !materialsNoneRow) gaps.push("materials");
  if (labourMinutes === null) gaps.push("labour");

  return {
    jobId,
    photos,
    afterPhotoCount,
    photoExemption: exemptionRow
      ? {
          reasonCode: exemptionRow.reasonCode ?? "",
          // The code itself when the row it named has been deleted outright,
          // which the ON DELETE restrict foreign key makes very hard — but a
          // blank line on a completed job card would be worse than a bare code.
          reasonLabel: exemptionRow.reasonLabel ?? exemptionRow.reasonCode ?? "Exempt",
          note: exemptionRow.note,
          declaredAt: exemptionRow.createdAt,
        }
      : null,
    materials,
    materialsNone: materialsNoneRow
      ? { note: materialsNoneRow.note, declaredAt: materialsNoneRow.createdAt }
      : null,
    labour,
    labourMinutes,
    signature: signature
      ? {
          id: signature.id,
          signedByName: signature.signedByName,
          signedByRole: signature.signedByRole,
          storageKey: signature.storageKey,
          satisfactionRating: signature.satisfactionRating,
          comments: signature.comments,
          signedAt: signature.signedAt,
          signerEmail: signature.signerEmail,
          consentVersion: signature.consentVersion,
          consentText: signature.consentText,
        }
      : null,
    gaps,
  };
}

/** What each gap says to the person who has to close it. */
const GAP_SENTENCE: Readonly<Record<JobCardGap, string>> = {
  after_photo:
    "an 'after' photograph, or a reason from the exemption list saying why there is none",
  materials: "the parts used, or a declaration that none were",
  labour: "the time on the tools, against a visit",
};

/**
 * Refuse to complete a job whose card is not finished (`JOB-15`).
 *
 * Called by `recordJobOutcome` inside the transaction that would otherwise move
 * the job to `work_complete`, so a refusal leaves nothing written — not the
 * outcome, not the fault codes, not the transition. That is deliberate: a
 * half-recorded completion is the state the requirement exists to forbid.
 *
 * The message names everything outstanding rather than the first thing found.
 * A gate that reveals one missing item per attempt turns a two-minute job into
 * three round trips, and the technician is standing in a plant room.
 */
export async function assertJobCardComplete(tx: TenantScopedTx, jobId: string): Promise<void> {
  const card = await getJobCard(tx, jobId);
  if (card.gaps.length === 0) return;

  const missing = card.gaps.map((g) => GAP_SENTENCE[g]);
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;

  throw new UserFacingError(
    `This job cannot be completed yet. Its job card still needs ${list}. ` +
      `Fill those in on the job card panel, then record the outcome again.`,
  );
}

// ── Write paths ─────────────────────────────────────────────────────────────

/**
 * The visit named, if one was, has to belong to this job.
 *
 * A visit id from another job files the photograph, the part or the hour
 * against the wrong work — and against another customer's job card, which is
 * the version of that mistake that reaches an invoice.
 */
async function requireVisitOnJob(
  tx: TenantScopedTx,
  jobId: string,
  visitId: string | null | undefined,
): Promise<void> {
  if (!visitId) return;
  const rows = await tx
    .select({ id: schema.jobVisits.id })
    .from(schema.jobVisits)
    .where(and(eq(schema.jobVisits.id, visitId), eq(schema.jobVisits.jobId, jobId)))
    .limit(1);
  if (!rows[0]) throw new UserFacingError("That visit does not belong to this job.");
}

/** The job exists in this tenant. RLS makes "missing" and "theirs" the same. */
async function requireJob(tx: TenantScopedTx, jobId: string): Promise<void> {
  const rows = await tx
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);
  if (!rows[0]) throw new Error(`Job ${jobId} not found in this tenant`);
}

export interface RecordAttachmentInput {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly kind: JobAttachmentKind;
  /** Where `packages/files` put the bytes. This module never holds bytes. */
  readonly storageKey: string;
  readonly mimeType?: string | null;
  readonly sizeBytes?: number | null;
  readonly caption?: string | null;
  readonly capturedAt?: Date | null;
  readonly capturedLat?: number | null;
  readonly capturedLng?: number | null;
}

/**
 * File a photograph, document or video against a job.
 *
 * The bytes are stored by the caller and only the key arrives here, which is
 * how `packages/files` is arranged everywhere else in this codebase: the store
 * has no `url()` method (`SEC-8`), so a key is not a link and recording one
 * leaks nothing.
 */
export async function recordJobAttachment(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RecordAttachmentInput,
): Promise<{ id: string }> {
  if (!JOB_ATTACHMENT_KINDS.includes(input.kind)) {
    throw new UserFacingError(`"${input.kind}" is not a kind of attachment this system stores.`);
  }
  if (!input.storageKey.trim()) {
    throw new Error("An attachment needs a storage key; the bytes are written before the row is.");
  }

  await requireJob(tx, input.jobId);
  await assertJobCardUnlocked(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  const inserted = await tx
    .insert(schema.jobAttachments)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      kind: input.kind,
      storageKey: input.storageKey,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      caption: input.caption ?? null,
      capturedAt: input.capturedAt ?? new Date(),
      capturedLat: input.capturedLat ?? null,
      capturedLng: input.capturedLng ?? null,
      uploadedById: ctx.userId ?? null,
    })
    .returning({ id: schema.jobAttachments.id });

  const row = inserted[0];
  if (!row) throw new Error("The attachment row was not written");

  await writeAuditNote(tx, ctx, {
    tableName: "job_attachments",
    recordId: row.id,
    // `audit_log.action` is varchar(16). Anything longer is a runtime failure
    // on every call, and no test would have to be wrong for it to happen.
    action: "photo",
    detail: { jobId: input.jobId, kind: input.kind, storageKey: input.storageKey },
  });

  return { id: row.id };
}

export interface RecordMaterialInput {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly sku?: string | null;
  readonly description: string;
  /** Decimal string, because `numeric(12,3)` is not a float and 0.1 is not 0.1. */
  readonly quantity: string;
  readonly unit?: string;
  /** Integer minor units (fils). Never a decimal, never a float. */
  readonly unitCostMinor?: number | null;
  readonly unitPriceMinor?: number | null;
  readonly currency?: string;
  readonly isBillable?: boolean;
  /**
   * `FLD-9`: where the part came from. One of `MATERIAL_SOURCES`.
   *
   * Optional here and nullable in the column, because the web console's
   * material form has never collected it. Undefined means "not recorded"; it
   * does NOT mean van stock, and nothing below supplies a default.
   */
  readonly source?: MaterialSource | null;
  /** `FLD-9`. Null for anything without one, which is most consumables. */
  readonly serialNumber?: string | null;
}

/**
 * Record one part or consumable used on the job (`JOB-15`).
 *
 * Recording a line withdraws any standing "no materials were used" declaration
 * in the same transaction. Leaving both on file would mean a job card that
 * says, at the same time, that a compressor was fitted and that nothing was —
 * and every count of exempted jobs would then be reading a contradiction.
 */
export async function recordJobMaterial(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RecordMaterialInput,
): Promise<{ id: string }> {
  const description = input.description.trim();
  if (!description) throw new UserFacingError("A material line needs a description.");

  const quantity = Number(input.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new UserFacingError("A material line needs a quantity greater than zero.");
  }

  // Refused rather than dropped. The column is CHECKed, so an unknown value
  // would fail at the driver with a constraint name and no explanation; this
  // is the same refusal with a sentence attached. It is deliberately NOT a
  // silent coercion to null — that is the exact failure this whole change
  // exists to undo, and reintroducing it one layer up would be worse, because
  // the value would now be dropped by code that visibly knows about it.
  const source = input.source ?? null;
  if (source !== null && !isMaterialSource(source)) {
    throw new UserFacingError(
      `"${source}" is not somewhere a part can come from. Expected one of: ` +
        `${MATERIAL_SOURCES.join(", ")}.`,
    );
  }

  await requireJob(tx, input.jobId);
  await assertJobCardUnlocked(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  const inserted = await tx
    .insert(schema.jobMaterials)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      sku: input.sku?.trim() || null,
      source,
      serialNumber: input.serialNumber?.trim() || null,
      description,
      quantity: input.quantity,
      unit: input.unit?.trim() || "ea",
      unitCost:
        input.unitCostMinor === null || input.unitCostMinor === undefined
          ? null
          : toDecimalString(input.unitCostMinor),
      unitPrice:
        input.unitPriceMinor === null || input.unitPriceMinor === undefined
          ? null
          : toDecimalString(input.unitPriceMinor),
      ...(input.currency ? { currency: input.currency } : {}),
      isBillable: input.isBillable ?? true,
    })
    .returning({ id: schema.jobMaterials.id });

  const row = inserted[0];
  if (!row) throw new Error("The material row was not written");

  await tx
    .delete(schema.jobCardDeclarations)
    .where(
      and(
        eq(schema.jobCardDeclarations.jobId, input.jobId),
        eq(schema.jobCardDeclarations.kind, "materials_none"),
      ),
    );

  await writeAuditNote(tx, ctx, {
    tableName: "job_materials",
    recordId: row.id,
    action: "material",
    detail: {
      jobId: input.jobId,
      description,
      quantity: input.quantity,
      sku: input.sku ?? null,
      // `FLD-9`. On the audit row as well as the column, because provenance is
      // the thing a warranty argument reaches for and the argument arrives
      // after somebody has edited or voided the job card.
      source,
      serialNumber: input.serialNumber?.trim() || null,
    },
  });

  return { id: row.id };
}

/**
 * Declare that no parts were used (`JOB-15`).
 *
 * This is the clause's whole point. An empty `job_materials` cannot tell "no
 * parts were fitted" from "nobody filled this in", and the two have opposite
 * meanings for costing, for reordering and for a warranty argument six months
 * later. So the absence is written down as something a named person asserted at
 * a known time, and the gate reads the assertion rather than inferring from
 * silence.
 *
 * Refused when material lines exist, rather than silently contradicting them.
 */
export async function declareNoMaterials(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { jobId: string; visitId?: string | null; note?: string | null },
): Promise<void> {
  await requireJob(tx, input.jobId);
  await assertJobCardUnlocked(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  const existing = await tx
    .select({ id: schema.jobMaterials.id })
    .from(schema.jobMaterials)
    .where(and(eq(schema.jobMaterials.jobId, input.jobId), isNull(schema.jobMaterials.deletedAt)))
    .limit(1);

  if (existing[0]) {
    throw new UserFacingError(
      "Parts are already recorded on this job, so it cannot also be declared as using none. " +
        "Remove the lines first if they were entered by mistake.",
    );
  }

  await tx
    .insert(schema.jobCardDeclarations)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      kind: "materials_none",
      reasonCode: null,
      note: input.note?.trim() || null,
      declaredById: ctx.userId ?? null,
    })
    // Re-declaring is not an error and not a second row. The unique index in
    // `0025` is what makes this idempotent rather than a rule remembered here.
    .onConflictDoNothing();

  await writeAuditNote(tx, ctx, {
    tableName: "job_card_declarations",
    recordId: input.jobId,
    // 14 characters. `audit_log.action` is varchar(16).
    action: "materials_none",
    detail: { jobId: input.jobId, visitId: input.visitId ?? null, note: input.note ?? null },
  });
}

/**
 * Record why there is no "after" photograph (`JOB-15`).
 *
 * The reason is checked against the tenant's own vocabulary before it is
 * written, for the same reason `recordJobOutcome` checks the outcome code: a
 * code the picker does not offer came from a stale form or a hand-crafted POST,
 * and accepting one puts a value in the column that no report can group. The
 * database agrees — `0025` adds a composite foreign key — but the sentence a
 * person can act on comes from here.
 */
export async function recordPhotoExemption(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { jobId: string; visitId?: string | null; reasonCode: string; note?: string | null },
): Promise<{ reasonCode: string; reasonLabel: string }> {
  await requireJob(tx, input.jobId);
  await assertJobCardUnlocked(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  const reasonRows = await tx
    .select({
      code: schema.jobPhotoExemptionReasons.code,
      label: schema.jobPhotoExemptionReasons.label,
      isActive: schema.jobPhotoExemptionReasons.isActive,
    })
    .from(schema.jobPhotoExemptionReasons)
    .where(eq(schema.jobPhotoExemptionReasons.code, input.reasonCode))
    .limit(1);

  const reason = reasonRows[0];
  if (!reason) {
    throw new UserFacingError(
      `"${input.reasonCode}" is not one of this company's photo exemption reasons. ` +
        `An exemption has to come from the list — that is what "reason-coded" means.`,
    );
  }
  if (!reason.isActive) {
    throw new UserFacingError(
      `"${reason.label}" has been retired and cannot be used on new work. Choose a current reason.`,
    );
  }

  const photos = await tx
    .select({ id: schema.jobAttachments.id })
    .from(schema.jobAttachments)
    .where(
      and(
        eq(schema.jobAttachments.jobId, input.jobId),
        eq(schema.jobAttachments.kind, "photo_after"),
        isNull(schema.jobAttachments.deletedAt),
      ),
    )
    .limit(1);

  if (photos[0]) {
    throw new UserFacingError(
      "This job already has an 'after' photograph, so there is nothing to exempt it from.",
    );
  }

  await tx
    .insert(schema.jobCardDeclarations)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      kind: "photo_exempt",
      reasonCode: reason.code,
      note: input.note?.trim() || null,
      declaredById: ctx.userId ?? null,
    })
    .onConflictDoNothing();

  await writeAuditNote(tx, ctx, {
    tableName: "job_card_declarations",
    recordId: input.jobId,
    // 12 characters. `audit_log.action` is varchar(16).
    action: "photo_exempt",
    detail: { jobId: input.jobId, reasonCode: reason.code, note: input.note ?? null },
  });

  return { reasonCode: reason.code, reasonLabel: reason.label };
}

/**
 * Record the time a visit took (`JOB-15`).
 *
 * `work_minutes` and `travel_minutes` on `job_visits`, which have been in the
 * schema since `0000` and which nothing has ever written. See the note at the
 * top of this file for why labour lives here and not in `attendance_events` or
 * the `HR-8` worked-day records, and why zero is a legal answer.
 */
export async function recordVisitLabour(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    visitId: string;
    workMinutes: number;
    travelMinutes?: number | null;
  },
): Promise<void> {
  await requireJob(tx, input.jobId);
  await assertJobCardUnlocked(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  if (!Number.isInteger(input.workMinutes) || input.workMinutes < 0) {
    throw new UserFacingError("Time on the tools is a whole number of minutes, and not negative.");
  }
  // A single visit longer than sixteen hours is a data-entry error rather than
  // a shift — and the `HR-8` limits exist precisely so nobody works one.
  if (input.workMinutes > 16 * 60) {
    throw new UserFacingError(
      "More than sixteen hours on one visit is a data-entry error. Split it across visits.",
    );
  }
  if (
    input.travelMinutes !== null &&
    input.travelMinutes !== undefined &&
    (!Number.isInteger(input.travelMinutes) ||
      input.travelMinutes < 0 ||
      input.travelMinutes > 16 * 60)
  ) {
    throw new UserFacingError("Travel time is a whole number of minutes between zero and sixteen hours.");
  }

  await tx
    .update(schema.jobVisits)
    .set({
      workMinutes: input.workMinutes,
      ...(input.travelMinutes === undefined ? {} : { travelMinutes: input.travelMinutes }),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobVisits.id, input.visitId));

  await writeAuditNote(tx, ctx, {
    tableName: "job_visits",
    recordId: input.visitId,
    action: "labour",
    detail: {
      jobId: input.jobId,
      workMinutes: input.workMinutes,
      travelMinutes: input.travelMinutes ?? null,
    },
  });
}

/**
 * The customer's signature on the work (`OPS-6`).
 *
 * Not one of `JOB-15`'s four conditions, and deliberately not gated on: the
 * requirement lists outcome, photo, materials and labour, and adding a fifth
 * condition of my own would mean a technician who cannot find anybody to sign
 * — an empty villa, a night shift in a plant room — cannot close the job at
 * all. It is built because `job_signoffs` has carried a comment about its legal
 * weight since `0000` with no reader and no writer anywhere in the repository,
 * and a signature nobody can capture is not evidence of anything.
 */
export async function recordJobSignature(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    visitId?: string | null;
    signedByName: string;
    signedByRole?: string | null;
    /** Where `packages/files` put the signature image. */
    signatureStorageKey: string;
    satisfactionRating?: number | null;
    comments?: string | null;
    /**
     * Where the contemporaneous copy goes (`FLD-13`, `FLD-14`).
     *
     * Captured at the pad rather than taken from the customer record, because
     * the person signing at a site is frequently not the person the invoices go
     * to. Optional, because a signer who declines to give an address must still
     * be able to sign — `sealJobSheet` falls back to the customer's billing
     * address and reports when there was nowhere at all to send the copy.
     */
    signerEmail?: string | null;
    /**
     * The consent statement rendered above the pad (`FLD-13`), versioned.
     *
     * Both halves or neither. A version with no text is a pointer into a table
     * that will have moved by the time anybody follows it; text with no version
     * cannot be grouped when the wording changes and somebody needs to know
     * which signatures were given under which. The pair is what makes the row
     * self-describing, and it is what the sheet prints and the digest covers.
     */
    consentVersion?: string | null;
    consentText?: string | null;
  },
): Promise<{ id: string }> {
  const name = input.signedByName.trim();
  if (!name) throw new UserFacingError("A signature needs the name of the person who gave it.");
  if (!input.signatureStorageKey.trim()) {
    throw new Error("A signature needs a storage key; the image is written before the row is.");
  }

  const consentVersion = input.consentVersion?.trim() || null;
  const consentText = input.consentText?.trim() || null;
  if (Boolean(consentVersion) !== Boolean(consentText)) {
    throw new Error(
      "A consent statement is a version and its text together. Half of one records what somebody " +
        "agreed to in a form nobody can read back.",
    );
  }

  const signerEmail = input.signerEmail?.trim().toLowerCase() || null;
  // Deliberately shallow. A full address grammar here would reject real
  // addresses at a signature pad, and the queue reports an undeliverable
  // message honestly; what this catches is the field having collected a name or
  // a phone number, which would silently send the copy nowhere.
  if (signerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(signerEmail)) {
    throw new UserFacingError(
      `"${input.signerEmail?.trim()}" is not an email address. The signed copy has to go somewhere.`,
    );
  }
  if (
    input.satisfactionRating !== null &&
    input.satisfactionRating !== undefined &&
    (!Number.isInteger(input.satisfactionRating) ||
      input.satisfactionRating < 1 ||
      input.satisfactionRating > 5)
  ) {
    throw new UserFacingError("A satisfaction rating is a whole number from one to five.");
  }

  await requireJob(tx, input.jobId);
  await assertJobCardUnlocked(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  const inserted = await tx
    .insert(schema.jobSignoffs)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      signedByName: name,
      signedByRole: input.signedByRole?.trim() || null,
      signatureStorageKey: input.signatureStorageKey,
      satisfactionRating: input.satisfactionRating ?? null,
      comments: input.comments?.trim() || null,
      signerEmail,
      consentVersion,
      consentText,
    })
    .returning({ id: schema.jobSignoffs.id });

  const row = inserted[0];
  if (!row) throw new Error("The signature row was not written");

  await writeAuditNote(tx, ctx, {
    tableName: "job_signoffs",
    recordId: row.id,
    action: "signature",
    detail: { jobId: input.jobId, signedByName: name, storageKey: input.signatureStorageKey },
  });

  return { id: row.id };
}

// ── The signed job sheet (FLD-14) ───────────────────────────────────────────

/**
 * `FLD-14`, and what it turns a signature into.
 *
 * "Store a SHA-256 hash of the exact rendered job sheet that was on screen at
 * the moment of signing, plus an immutable PDF snapshot of it. Without this the
 * signature proves nothing, because 'signed a job sheet' is meaningless if the
 * job sheet is mutable afterwards. After signature the job record is locked;
 * corrections happen only as a new, linked, reason-coded amendment. Written to
 * versioned, immutable object storage. A copy is emailed to the customer
 * immediately."
 *
 * The rendering, the hashing, the storing and the email are in
 * `@meridian/docs` — `job-sheet.ts` and `job-sheet-seal.ts` — because they need
 * a PDF writer, an object store and the notification queue, and none of those
 * belong in the database package. What lives here is the part that has to be
 * true regardless of which client is calling: what the sheet is made of, the
 * row that records it, and **the lock**.
 *
 * ── WHY THE LOCK IS HERE AND NOT IN A FORM ──────────────────────────────────
 *
 * The same reason `JOB-15`'s gate ended up on `transitionJob` itself. The field
 * app reaches these rows through an API, so a rule living in a React component
 * protects nothing from the client that matters most. `assertJobCardUnlocked`
 * below is called by every write path in this file, and `0037` puts triggers on
 * the underlying tables as the backstop for the caller that has not been
 * written yet.
 *
 * ── WHY AN AMENDMENT DOES NOT UNLOCK ANYTHING ───────────────────────────────
 *
 * "Corrections happen only as a new, linked, reason-coded amendment" is
 * satisfied by a second document, not by a temporary unlock. Unlock-edit-reseal
 * would leave the first artefact — the one the customer holds, the one whose
 * hash was recorded — evidencing a position the business no longer claims. That
 * is the mutable job sheet the requirement exists to forbid, arrived at by a
 * more respectable-looking route.
 */

/**
 * The list every tenant starts with.
 *
 * Seeded rather than left to an administrator, for the reason
 * `STANDARD_PHOTO_EXEMPTION_REASONS` gives: a controlled list that ships empty
 * is a picker with nothing in it, and the operator faced with one writes the
 * reason into the note field instead — which is the free text the vocabulary
 * exists to prevent, and `FLD-14` says "reason-coded" precisely to forbid it.
 *
 * Six entries. Each is a genuinely different thing to have gone wrong, because
 * the question this vocabulary is for is *which* of them is happening: a
 * company amending sheets because parts were mis-recorded has a stock problem,
 * one amending them because the work was described wrongly has a training
 * problem, and one amending them because the customer disputes what they signed
 * has neither — it has a dispute, and it needs to be countable separately.
 *
 * There is no "other". An amendment vocabulary with an escape hatch collects
 * every amendment in the escape hatch within a quarter.
 */
export const STANDARD_JOB_SHEET_AMENDMENT_REASONS: readonly {
  code: string;
  label: string;
  description: string;
  sortOrder: number;
}[] = [
  {
    code: "materials_misrecorded",
    label: "Parts recorded wrongly",
    description:
      "A part, quantity or unit on the signed sheet does not match what was actually fitted or consumed.",
    sortOrder: 10,
  },
  {
    code: "labour_misrecorded",
    label: "Time recorded wrongly",
    description: "The time on the tools or travelling was entered incorrectly against the visit.",
    sortOrder: 20,
  },
  {
    code: "work_described_wrongly",
    label: "Work described wrongly",
    description:
      "The description of the fault or of the work carried out does not match what was done.",
    sortOrder: 30,
  },
  {
    code: "wrong_outcome_or_fault_code",
    label: "Wrong outcome or fault code",
    description: "The outcome, reported fault or diagnosed fault on the sheet is the wrong code.",
    sortOrder: 40,
  },
  {
    code: "customer_dispute",
    label: "Customer disputes what was signed",
    description:
      "The customer has challenged the record after signing and the company's position is being stated on file.",
    sortOrder: 50,
  },
  {
    code: "signed_in_error",
    label: "Signed against the wrong job or by the wrong person",
    description:
      "The sheet was signed against a job it does not describe, or by somebody without authority to accept the work.",
    sortOrder: 60,
  },
];

export interface JobSheetAmendmentReason {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly isActive: boolean;
}

/** The picker, or the whole list. Active only by default — see `listPhotoExemptionReasons`. */
export async function listJobSheetAmendmentReasons(
  tx: TenantScopedTx,
  options: { activeOnly?: boolean } = {},
): Promise<readonly JobSheetAmendmentReason[]> {
  const rows = await tx
    .select({
      id: schema.jobSheetAmendmentReasons.id,
      code: schema.jobSheetAmendmentReasons.code,
      label: schema.jobSheetAmendmentReasons.label,
      description: schema.jobSheetAmendmentReasons.description,
      isActive: schema.jobSheetAmendmentReasons.isActive,
    })
    .from(schema.jobSheetAmendmentReasons)
    .where(
      options.activeOnly === false
        ? sql`true`
        : eq(schema.jobSheetAmendmentReasons.isActive, true),
    )
    .orderBy(
      asc(schema.jobSheetAmendmentReasons.sortOrder),
      asc(schema.jobSheetAmendmentReasons.label),
    );

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    isActive: r.isActive,
  }));
}

/** Add a reason, or reword one that is already there (`ADM-10`). */
export async function addJobSheetAmendmentReason(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { code: string; label: string; description?: string | null; sortOrder?: number },
): Promise<void> {
  await tx.execute(sql`
    insert into job_sheet_amendment_reasons
      (tenant_id, code, label, description, sort_order)
    values (
      ${ctx.tenantId}::uuid,
      ${input.code},
      ${input.label},
      ${input.description ?? null},
      ${input.sortOrder ?? 100}
    )
    on conflict (tenant_id, code) do update
      set label = excluded.label,
          description = excluded.description,
          sort_order = excluded.sort_order,
          is_active = true
  `);
}

/**
 * Retire or restore a reason. Never delete one.
 *
 * `job_sheets` carries a composite foreign key to this table with ON DELETE
 * restrict, so a reason cited by a sealed amendment cannot be removed without
 * rewriting that amendment — and a sealed amendment cannot be rewritten at all.
 */
export async function setJobSheetAmendmentReasonActive(
  tx: TenantScopedTx,
  reasonId: string,
  isActive: boolean,
): Promise<void> {
  await tx.execute(sql`
    update job_sheet_amendment_reasons set is_active = ${isActive} where id = ${reasonId}::uuid
  `);
}

/** Install the standard list for a tenant that has none. `on conflict do nothing`. */
export async function installStandardJobSheetAmendmentReasons(
  tx: TenantScopedTx,
  ctx: TenantContext,
): Promise<number> {
  let added = 0;
  for (const reason of STANDARD_JOB_SHEET_AMENDMENT_REASONS) {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into job_sheet_amendment_reasons
        (tenant_id, code, label, description, sort_order)
      values (
        ${ctx.tenantId}::uuid,
        ${reason.code},
        ${reason.label},
        ${reason.description},
        ${reason.sortOrder}
      )
      on conflict (tenant_id, code) do nothing
      returning id
    `)) as unknown as { id: string }[];
    if (inserted.length > 0) added++;
  }
  return added;
}

/** One sealed sheet — the original, or an amendment linked to it. */
export interface JobSheetRow {
  readonly id: string;
  readonly jobId: string;
  readonly visitId: string | null;
  readonly kind: "original" | "amendment";
  readonly reference: string;
  readonly sequence: number;
  readonly signoffId: string | null;
  readonly sheetFormat: string;
  readonly contentSha256: string;
  readonly storageKey: string;
  readonly pdfSha256: string;
  readonly businessDate: string;
  /** The `recordedOfflineAt` line the digest covers, verbatim. */
  readonly recordedAtText: string;
  readonly amendsSheetId: string | null;
  readonly amendmentReasonCode: string | null;
  /** From the vocabulary, left-joined: a retired reason still renders. */
  readonly amendmentReasonLabel: string | null;
  readonly amendmentDetail: string | null;
  readonly sealedAt: Date;
}

/**
 * Every sheet on a job, original first.
 *
 * Ordered by `sequence` rather than by `sealed_at`. Two amendments raised in
 * the same second would otherwise render in an order that depends on how the
 * timestamps rounded, and the numbered sequence is the thing the references
 * (`-A1`, `-A2`) are built from.
 */
export async function listJobSheets(
  tx: TenantScopedTx,
  jobId: string,
): Promise<readonly JobSheetRow[]> {
  const rows = await tx
    .select({
      id: schema.jobSheets.id,
      jobId: schema.jobSheets.jobId,
      visitId: schema.jobSheets.visitId,
      kind: schema.jobSheets.kind,
      reference: schema.jobSheets.reference,
      sequence: schema.jobSheets.sequence,
      signoffId: schema.jobSheets.signoffId,
      sheetFormat: schema.jobSheets.sheetFormat,
      contentSha256: schema.jobSheets.contentSha256,
      storageKey: schema.jobSheets.storageKey,
      pdfSha256: schema.jobSheets.pdfSha256,
      businessDate: schema.jobSheets.businessDate,
      recordedAtText: schema.jobSheets.recordedAtText,
      amendsSheetId: schema.jobSheets.amendsSheetId,
      amendmentReasonCode: schema.jobSheets.amendmentReasonCode,
      // Left, not inner: an amendment raised before somebody retired the code
      // must still render. Retiring a vocabulary entry rewrites the picker,
      // never the history.
      amendmentReasonLabel: schema.jobSheetAmendmentReasons.label,
      amendmentDetail: schema.jobSheets.amendmentDetail,
      sealedAt: schema.jobSheets.sealedAt,
    })
    .from(schema.jobSheets)
    .leftJoin(
      schema.jobSheetAmendmentReasons,
      and(
        eq(schema.jobSheetAmendmentReasons.tenantId, schema.jobSheets.tenantId),
        eq(schema.jobSheetAmendmentReasons.code, schema.jobSheets.amendmentReasonCode),
      ),
    )
    .where(eq(schema.jobSheets.jobId, jobId))
    .orderBy(asc(schema.jobSheets.sequence));

  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    visitId: r.visitId,
    kind: r.kind as "original" | "amendment",
    reference: r.reference,
    sequence: r.sequence,
    signoffId: r.signoffId,
    sheetFormat: r.sheetFormat,
    contentSha256: r.contentSha256,
    storageKey: r.storageKey,
    pdfSha256: r.pdfSha256,
    businessDate: r.businessDate,
    recordedAtText: r.recordedAtText,
    amendsSheetId: r.amendsSheetId,
    amendmentReasonCode: r.amendmentReasonCode,
    amendmentReasonLabel: r.amendmentReasonLabel,
    amendmentDetail: r.amendmentDetail,
    sealedAt: r.sealedAt,
  }));
}

/** The signed original, or null when this job has never been signed off. */
export async function getSealedJobSheet(
  tx: TenantScopedTx,
  jobId: string,
): Promise<JobSheetRow | null> {
  const sheets = await listJobSheets(tx, jobId);
  return sheets.find((s) => s.kind === "original") ?? null;
}

/**
 * Refuse to change a job card that has been signed for (`FLD-14`).
 *
 * Called by every write path in this file. The refusal names the sheet, because
 * "this job is locked" without a reference is a sentence that leaves the
 * operator with nowhere to go — and the next thing they need is the document,
 * so that they can decide whether an amendment is warranted.
 *
 * `0037` puts the same rule on the tables themselves. That is not redundancy
 * for its own sake: this function produces the sentence, and the trigger
 * produces the guarantee. A caller written next year that does not know this
 * function exists still cannot write.
 */
export async function assertJobCardUnlocked(tx: TenantScopedTx, jobId: string): Promise<void> {
  const sealed = await getSealedJobSheet(tx, jobId);
  if (!sealed) return;

  throw new UserFacingError(
    `This job was signed off on job sheet ${sealed.reference} and its card is locked. ` +
      `What was signed cannot be changed — that is what makes the signature worth anything. ` +
      `Record a reason-coded amendment instead; it is filed alongside the original, which stands.`,
  );
}

export interface RecordJobSheetInput {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly kind: "original" | "amendment";
  readonly reference: string;
  readonly sequence: number;
  readonly signoffId?: string | null;
  readonly sheetFormat: string;
  readonly contentSha256: string;
  readonly storageKey: string;
  readonly pdfSha256: string;
  /** `YYYY-MM-DD`, Dubai. Never derived from `new Date().toISOString()`. */
  readonly businessDate: string;
  /** The `recordedOfflineAt` line that went into `contentSha256`, verbatim. */
  readonly recordedAtText: string;
  readonly amendsSheetId?: string | null;
  readonly amendmentReasonCode?: string | null;
  readonly amendmentDetail?: string | null;
}

/**
 * Write the row that records a sealed sheet.
 *
 * Called from `@meridian/docs` inside the same transaction as the signature, so
 * a sheet cannot exist without the signature it seals and a signature cannot
 * exist without the sheet that gives it meaning. The bytes are already in
 * object storage by the time this runs — see the order-of-operations note in
 * `issue.ts`, which applies here for the same reason: the object store is not
 * transactional and the database is.
 *
 * Inserting this row is what locks the card. Every statement after it in the
 * same transaction that touches the card is refused by `0037`'s triggers, which
 * is correct and is why the signature row is written first.
 */
export async function recordJobSheet(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RecordJobSheetInput,
): Promise<{ id: string }> {
  if (!/^[0-9a-f]{64}$/.test(input.contentSha256) || !/^[0-9a-f]{64}$/.test(input.pdfSha256)) {
    // Checked here as well as by the CHECK constraint, because the failure this
    // catches is an upper-case digest from a client library — which compares
    // unequal to every digest this system stores and would surface much later
    // as a signature that cannot be verified.
    throw new Error("A job sheet digest is 64 lower-case hex characters");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate)) {
    throw new Error("A job sheet's business date is a YYYY-MM-DD calendar date");
  }

  await requireJob(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  // Deliberately NOT `assertJobCardUnlocked`. This is the one write in this
  // file that is legitimate on a locked job: an amendment exists precisely
  // because the card is locked, and refusing it here would leave a signed sheet
  // with no correction mechanism at all — which is the state `FLD-14` is
  // written to get out of. The original is protected by
  // `job_sheets_one_original`, so this cannot quietly re-seal a job either.
  const inserted = await tx
    .insert(schema.jobSheets)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      kind: input.kind,
      reference: input.reference,
      sequence: input.sequence,
      signoffId: input.signoffId ?? null,
      sheetFormat: input.sheetFormat,
      contentSha256: input.contentSha256,
      storageKey: input.storageKey,
      pdfSha256: input.pdfSha256,
      businessDate: input.businessDate,
      recordedAtText: input.recordedAtText,
      amendsSheetId: input.amendsSheetId ?? null,
      amendmentReasonCode: input.amendmentReasonCode ?? null,
      amendmentDetail: input.amendmentDetail?.trim() || null,
      sealedById: ctx.userId ?? null,
    })
    .returning({ id: schema.jobSheets.id });

  const row = inserted[0];
  if (!row) throw new Error("The job sheet row was not written");

  await writeAuditNote(tx, ctx, {
    tableName: "job_sheets",
    recordId: row.id,
    // 11 characters. `audit_log.action` is varchar(16), and a longer literal
    // fails at runtime on every call.
    action: input.kind === "original" ? "sheet_seal" : "sheet_amend",
    detail: {
      jobId: input.jobId,
      reference: input.reference,
      contentSha256: input.contentSha256,
      pdfSha256: input.pdfSha256,
      storageKey: input.storageKey,
      amendmentReasonCode: input.amendmentReasonCode ?? null,
    },
  });

  return { id: row.id };
}

/**
 * Check an amendment reason against the tenant's own vocabulary.
 *
 * The same shape as `recordPhotoExemption`'s check and for the same reason: a
 * code the picker does not offer came from a stale form or a hand-crafted POST,
 * and accepting one puts a value in the column that no report can group. The
 * database agrees — `0037` adds a composite foreign key — but the sentence a
 * person can act on comes from here.
 */
export async function resolveJobSheetAmendmentReason(
  tx: TenantScopedTx,
  reasonCode: string,
): Promise<{ code: string; label: string }> {
  const rows = await tx
    .select({
      code: schema.jobSheetAmendmentReasons.code,
      label: schema.jobSheetAmendmentReasons.label,
      isActive: schema.jobSheetAmendmentReasons.isActive,
    })
    .from(schema.jobSheetAmendmentReasons)
    .where(eq(schema.jobSheetAmendmentReasons.code, reasonCode))
    .limit(1);

  const reason = rows[0];
  if (!reason) {
    throw new UserFacingError(
      `"${reasonCode}" is not one of this company's job sheet amendment reasons. ` +
        `An amendment has to come from the list — that is what "reason-coded" means.`,
    );
  }
  if (!reason.isActive) {
    throw new UserFacingError(
      `"${reason.label}" has been retired and cannot be used on new amendments. Choose a current reason.`,
    );
  }
  return { code: reason.code, label: reason.label };
}

/**
 * Everything the job sheet renders, in one read.
 *
 * One function rather than five, for the same reason `getJobCard` is one
 * function: the sheet that is presented for signature and the sheet that is
 * hashed have to be built from the same query, or the digest describes a
 * document nobody saw.
 *
 * The `content` half is exactly the field set the canonicalisation covers, and
 * its member order is part of a contract shared with `apps/field`. See
 * `JobSheetContent` in `@meridian/docs`.
 */
export interface JobSheetSource {
  readonly jobId: string;
  readonly jobReference: string;
  readonly jobTitle: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly customerEmail: string | null;
  readonly propertyAddress: string;
  readonly reportedFault: string;
  readonly diagnosedFault: string;
  readonly workCarriedOut: string;
  readonly materials: readonly { description: string; quantity: string; unit: string }[];
  readonly labourMinutes: number;
  /**
   * When the work this sheet describes was recorded, as an ISO instant.
   *
   * Derived from the record — the visit's completion, then its arrival, then
   * the job's completion, then the job's creation — and never from the clock at
   * the moment of rendering. That distinction is load-bearing: the digest is
   * computed over this value, so a render-time clock would give the same
   * unchanged record a different digest every second and make the comparison in
   * `sealJobSheet` impossible to satisfy from a browser.
   *
   * A handset overrides it with the device clock reading it actually displayed,
   * because on that path the value the customer saw is the one the hash has to
   * cover. `ADR 0004` is why there are two clocks at all.
   */
  readonly recordedAt: string;
  readonly outcomeLabel: string;
  readonly technicianName: string;
  readonly photoCounts: readonly { label: string; count: number }[];
  readonly declarations: readonly { label: string; note: string | null }[];
  readonly visits: readonly {
    sequence: number;
    technicianName: string;
    workMinutes: number | null;
    travelMinutes: number | null;
  }[];
}

/** How each attachment kind is described to a customer on the sheet. */
const ATTACHMENT_KIND_LABEL: Readonly<Record<string, string>> = {
  photo_before: "'before' photograph",
  photo_after: "'after' photograph",
  photo_recommendation: "photograph of recommended further work",
  signature: "signature image",
  document: "document",
  video: "video",
};

export async function getJobSheetSource(
  tx: TenantScopedTx,
  jobId: string,
): Promise<JobSheetSource> {
  const jobRows = await tx
    .select({
      id: schema.jobs.id,
      reference: schema.jobs.reference,
      title: schema.jobs.title,
      description: schema.jobs.description,
      outcomeCode: schema.jobs.outcomeCode,
      outcomeLabel: schema.jobOutcomeCodes.label,
      completedAt: schema.jobs.completedAt,
      createdAt: schema.jobs.createdAt,
      customerId: schema.customers.id,
      customerName: schema.customers.name,
      customerEmail: schema.customers.billingEmail,
      propertyName: schema.properties.name,
      propertyAddressLine: schema.properties.addressLine,
      propertyArea: schema.properties.area,
      propertyCity: schema.properties.city,
    })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.jobs.customerId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.jobs.propertyId))
    // Left, not inner: an outcome recorded before somebody deactivated the code
    // must still render on the sheet.
    .leftJoin(
      schema.jobOutcomeCodes,
      and(
        eq(schema.jobOutcomeCodes.tenantId, schema.jobs.tenantId),
        eq(schema.jobOutcomeCodes.code, schema.jobs.outcomeCode),
      ),
    )
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  const job = jobRows[0];
  if (!job) throw new Error(`Job ${jobId} not found in this tenant`);

  const faultRows = await tx
    .select({
      kind: schema.jobFaultCodes.kind,
      label: schema.faultCodes.label,
      code: schema.faultCodes.code,
    })
    .from(schema.jobFaultCodes)
    .innerJoin(schema.faultCodes, eq(schema.faultCodes.id, schema.jobFaultCodes.faultCodeId))
    .where(eq(schema.jobFaultCodes.jobId, jobId))
    .orderBy(asc(schema.jobFaultCodes.createdAt));

  // `FLD-6` keeps the reported fault and the diagnosed fault as separate
  // fields, and the sheet keeps them separate too. Collapsing them would hide
  // the single most useful comparison on the document: what the customer
  // thought was wrong against what was actually wrong.
  const reported = faultRows.filter((f) => f.kind === "symptom").map((f) => f.label);
  const diagnosed = faultRows.filter((f) => f.kind === "cause").map((f) => f.label);
  const remedies = faultRows.filter((f) => f.kind === "remedy").map((f) => f.label);

  const card = await getJobCard(tx, jobId);

  // When the work was recorded, from the record. See `JobSheetSource.recordedAt`
  // for why this must not be the render clock.
  const timingRows = await tx
    .select({
      completedAt: schema.jobVisits.completedAt,
      arrivedAt: schema.jobVisits.arrivedAt,
      sequence: schema.jobVisits.sequence,
    })
    .from(schema.jobVisits)
    .where(eq(schema.jobVisits.jobId, jobId))
    .orderBy(desc(schema.jobVisits.sequence))
    .limit(1);
  const lastVisit = timingRows[0];
  const recordedAt =
    lastVisit?.completedAt ?? lastVisit?.arrivedAt ?? job.completedAt ?? job.createdAt;

  const photoCounts = Object.entries(
    card.photos.reduce<Record<string, number>>((acc, p) => {
      acc[p.kind] = (acc[p.kind] ?? 0) + 1;
      return acc;
    }, {}),
  )
    // Sorted by kind so the same job always produces the same sentence. An
    // insertion-ordered object would make the rendered bytes depend on the
    // order rows came back, which is exactly what determinism forbids.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([kind, count]) => ({ label: ATTACHMENT_KIND_LABEL[kind] ?? kind, count }));

  const declarations: { label: string; note: string | null }[] = [];
  if (card.photoExemption) {
    declarations.push({
      label: `No 'after' photograph — ${card.photoExemption.reasonLabel}`,
      note: card.photoExemption.note,
    });
  }
  if (card.materialsNone) {
    declarations.push({
      label: "No parts or consumables were used",
      note: card.materialsNone.note,
    });
  }

  // The job's own description is what the customer reported; the remedy codes
  // and the technician's report are what was done. Both are joined rather than
  // picked between, because a sheet that silently prefers one source is a sheet
  // whose content depends on which fields happened to be filled in.
  const reportRows = await tx
    .select({
      workCarriedOut: schema.jobReports.workCarriedOut,
      faultFound: schema.jobReports.faultFound,
    })
    .from(schema.jobReports)
    .where(and(eq(schema.jobReports.jobId, jobId), isNull(schema.jobReports.deletedAt)))
    .orderBy(asc(schema.jobReports.createdAt));

  // `ai_summary` is deliberately not read here. It is a generated customer-
  // facing paraphrase that `M11` requires a human to approve, and a sheet the
  // customer signs must carry what the technician wrote, not a rewrite of it.
  const workCarriedOut = [
    ...reportRows.map((r) => [r.workCarriedOut, r.faultFound].filter(Boolean).join(" ")),
    ...remedies,
  ]
    .filter((s) => s && s.trim())
    .join(" ")
    .trim();

  return {
    jobId,
    jobReference: job.reference,
    jobTitle: job.title,
    customerId: job.customerId,
    customerName: job.customerName,
    customerEmail: job.customerEmail,
    propertyAddress: [job.propertyName, job.propertyAddressLine, job.propertyArea, job.propertyCity]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(", "),
    reportedFault: reported.length > 0 ? reported.join("; ") : job.description?.trim() || job.title,
    diagnosedFault: diagnosed.length > 0 ? diagnosed.join("; ") : "Not coded",
    workCarriedOut: workCarriedOut || job.title,
    materials: card.materials.map((m) => ({
      description: m.description,
      quantity: m.quantity,
      unit: m.unit,
    })),
    // Zero, not null. `JOB-15` has already refused a job card with no labour
    // recorded at all, and the sheet cannot carry a null into a hash that has
    // to be reproducible on a handset.
    labourMinutes: card.labourMinutes ?? 0,
    recordedAt: recordedAt.toISOString(),
    outcomeLabel: job.outcomeLabel ?? job.outcomeCode ?? "Not recorded",
    technicianName:
      card.labour.map((l) => l.technicianName).join(", ") || "Not recorded",
    photoCounts,
    declarations,
    visits: card.labour.map((l) => ({
      sequence: l.sequence,
      technicianName: l.technicianName,
      workMinutes: l.workMinutes,
      travelMinutes: l.travelMinutes,
    })),
  };
}

/**
 * Delete sealed sheets, deliberately.
 *
 * `0037` puts a trigger on `job_sheets` that refuses UPDATE outright and
 * refuses DELETE unless the transaction has said it means to purge. This is the
 * only place in the codebase that says it, and it exists so that the two
 * callers which legitimately need it — the development seed's clear-down, and
 * the retention purge that will one day age out closed jobs and their objects
 * together — go through one function rather than each remembering a GUC name.
 *
 * It is not a correction mechanism and must never be used as one. A signed
 * sheet that is wrong is corrected by `amendJobSheet` in `@meridian/docs`; a
 * signed sheet that is deleted takes with it the only evidence of what a
 * customer agreed to.
 *
 * `set_config(..., true)` — transaction-local, the same third argument
 * `withTenant` relies on for `app.tenant_id`. Without it the setting would
 * survive on the pooled connection and the next checkout would inherit
 * permission to delete signed job sheets, which is the failure this whole
 * arrangement is trying to avoid.
 */
export async function purgeJobSheets(
  tx: TenantScopedTx,
  where: { jobId?: string } = {},
): Promise<void> {
  await tx.execute(sql`select set_config('app.job_sheet_purge', 'on', true)`);
  try {
    if (where.jobId) {
      await tx.delete(schema.jobSheets).where(eq(schema.jobSheets.jobId, where.jobId));
    } else {
      await tx.delete(schema.jobSheets);
    }
  } finally {
    // Cleared even on the way out of a failure. The transaction-local scope
    // already bounds it, and turning it off explicitly means the rest of this
    // transaction cannot delete a sheet it did not intend to.
    await tx.execute(sql`select set_config('app.job_sheet_purge', 'off', true)`);
  }
}
