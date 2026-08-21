import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { writeAuditNote } from "./staff";
import { UserFacingError, toDecimalString } from "@meridian/core";

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

  await requireJob(tx, input.jobId);
  await requireVisitOnJob(tx, input.jobId, input.visitId);

  const inserted = await tx
    .insert(schema.jobMaterials)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      sku: input.sku?.trim() || null,
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
    detail: { jobId: input.jobId, description, quantity: input.quantity, sku: input.sku ?? null },
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
  },
): Promise<{ id: string }> {
  const name = input.signedByName.trim();
  if (!name) throw new UserFacingError("A signature needs the name of the person who gave it.");
  if (!input.signatureStorageKey.trim()) {
    throw new Error("A signature needs a storage key; the image is written before the row is.");
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
