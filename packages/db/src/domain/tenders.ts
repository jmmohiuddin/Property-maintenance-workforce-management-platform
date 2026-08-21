import { sql, and, eq, isNull, inArray } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  ACCREDITATION_LABEL,
  type AccreditationKind,
} from "../schema/compliance";
import {
  UserFacingError,
  TENDER_OUTCOMES,
  TENDER_OUTCOME_LABEL,
  isClosedOutcome,
  toMinor,
  toDecimalString,
  type TenderOutcome,
  type TenderPackDocument,
} from "@meridian/core";
import { resolveCompanyIdentity } from "./reference";
import { requiredRowDate } from "./_rows";

/**
 * Tenders (`CON-11`) and the data a tender pack is assembled from (`CON-12`).
 *
 * ── WHAT THIS MODULE REFUSES TO BE ──────────────────────────────────────────
 *
 * A second lead pipeline. `leads.ts` is 1,400 lines of stage transitions,
 * follow-up scheduling and disposition, all of it organised around where a
 * conversation got to. None of it applies here and none of it is repeated:
 * a tender has a closing date somebody else published, and the only ordering
 * this file ever produces is `submission_deadline - current_date` ascending.
 * `tenderQueue` has no other sort and takes no sort argument, which is the
 * design rather than an omission.
 *
 * ── DAYS ARE STRINGS, END TO END ────────────────────────────────────────────
 *
 * `submission_deadline`, `decision_date`, `submitted_on`, `decided_on` and
 * every accreditation expiry read here are `YYYY-MM-DD` from the database to
 * the screen and back, never `Date`. Anything derived from them — days left,
 * expired or not — is computed by Postgres against `current_date`.
 *
 * The reason is one-directional. A day round-tripped through a JS `Date` moves
 * by the reader's UTC offset, and for Dubai (UTC+4) that always moves it
 * *earlier*: a certificate expiring on 1 September becomes 31 August 20:00 UTC,
 * and a naive comparison reports it as expired a day early — or, if the
 * arithmetic runs the other way, reports an expired certificate as valid for
 * the first four hours of every day. The second is the one that puts a lapsed
 * insurance certificate into a tender pack, so it is the one the whole feature
 * is arranged to make impossible.
 */

// ── The controlled vocabularies (CON-11, following ADM-10) ───────────────────

export interface StandardTenderSource {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly sortOrder: number;
}

/**
 * The four channels `CON-11` names, and the authority for them from here on.
 *
 * Seeded rather than left to the operator for the reason `STANDARD_ASSET_
 * CATEGORIES` is: a tenant whose picker is empty on day one records a channel
 * that is free text with extra steps, and it cannot be corrected later because
 * the history is written by the time anyone wants to group by it.
 */
export const STANDARD_TENDER_SOURCES: readonly StandardTenderSource[] = [
  {
    code: "oa_management_company",
    label: "OA management company",
    description:
      "The managing agent for an Owners Association, running the RERA-mandated three-bid process.",
    sortOrder: 10,
  },
  {
    code: "developer",
    label: "Developer",
    description: "A developer tendering maintenance for a building it still holds or has just handed over.",
    sortOrder: 20,
  },
  {
    code: "property_manager",
    label: "Property manager",
    description: "A landlord's agent tendering for a single building or a small portfolio.",
    sortOrder: 30,
  },
  {
    code: "government_esupply",
    label: "Government eSupply portal",
    description:
      "A government or semi-government body's electronic procurement portal. Deadlines are hard and the portal closes itself.",
    sortOrder: 40,
  },
];

export interface StandardTenderOutcomeReason {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly appliesTo: "won" | "lost" | "both";
  readonly sortOrder: number;
}

/**
 * Why bids are won and lost.
 *
 * Chosen to make the *actionable* losses distinguishable from the rest, which
 * is the only reason to hold this vocabulary at all. "Undercut on price" and
 * "the pack was incomplete" are both losses, and only one of them is a thing
 * the company can fix — and the second is precisely what `CON-12` exists to
 * eliminate, so it needs to be countable.
 */
export const STANDARD_TENDER_OUTCOME_REASONS: readonly StandardTenderOutcomeReason[] = [
  {
    code: "price",
    label: "Price",
    description: "Undercut, or priced above the budget the issuer had.",
    appliesTo: "both",
    sortOrder: 10,
  },
  {
    code: "technical_score",
    label: "Technical score",
    description: "The method statement, plant list or PPM schedule scored above or below the others.",
    appliesTo: "both",
    sortOrder: 20,
  },
  {
    code: "relationship",
    label: "Existing relationship",
    description: "The issuer already knew the company, or already knew somebody else.",
    appliesTo: "both",
    sortOrder: 30,
  },
  {
    code: "incumbent_retained",
    label: "Incumbent retained",
    description: "The existing contractor kept the work. Common where the three-bid process is a formality.",
    appliesTo: "lost",
    sortOrder: 40,
  },
  {
    code: "missing_accreditation",
    label: "Missing accreditation",
    description:
      "Disqualified for an accreditation the company does not hold or could not evidence. The one CON-12 is meant to make impossible.",
    appliesTo: "lost",
    sortOrder: 50,
  },
  {
    code: "incomplete_pack",
    label: "Incomplete submission",
    description:
      "The pack was short of something the issuer asked for. Also the one CON-12 is meant to make impossible.",
    appliesTo: "lost",
    sortOrder: 60,
  },
  {
    code: "late_submission",
    label: "Submitted late",
    description: "Missed the closing date. The failure the deadline queue exists to prevent.",
    appliesTo: "lost",
    sortOrder: 70,
  },
  {
    code: "capacity",
    label: "Capacity",
    description: "The issuer judged the workforce too small for the portfolio, or the company withdrew for the same reason.",
    appliesTo: "both",
    sortOrder: 80,
  },
  {
    code: "scope_changed",
    label: "Scope withdrawn or changed",
    description: "The issuer cancelled, re-tendered, or changed the scope beyond what was bid.",
    appliesTo: "lost",
    sortOrder: 90,
  },
  {
    code: "other",
    label: "Other",
    description: "Anything the list does not cover. Write the reason in the note.",
    appliesTo: "both",
    sortOrder: 100,
  },
];

export interface TenderVocabularyRow {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface TenderOutcomeReasonRow extends TenderVocabularyRow {
  readonly appliesTo: string;
}

/**
 * Install the standard vocabularies for a tenant.
 *
 * `on conflict do nothing`, so re-running adds nothing and an operator's edit
 * to a label survives. Returns how many rows were actually written, which is
 * what makes "installing them again is a no-op" testable rather than assumed.
 */
export async function installStandardTenderVocabularies(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
): Promise<number> {
  const sources = await tx
    .insert(schema.tenderOpportunitySources)
    .values(
      STANDARD_TENDER_SOURCES.map((s) => ({
        tenantId: ctx.tenantId,
        code: s.code,
        label: s.label,
        description: s.description,
        sortOrder: s.sortOrder,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.tenderOpportunitySources.id });

  const reasons = await tx
    .insert(schema.tenderOutcomeReasons)
    .values(
      STANDARD_TENDER_OUTCOME_REASONS.map((r) => ({
        tenantId: ctx.tenantId,
        code: r.code,
        label: r.label,
        description: r.description,
        appliesTo: r.appliesTo,
        sortOrder: r.sortOrder,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: schema.tenderOutcomeReasons.id });

  return sources.length + reasons.length;
}

/** The opportunity-source picker. `activeOnly` for a form, everything for admin. */
export async function listTenderSources(
  tx: TenantScopedTx,
  options?: { activeOnly?: boolean },
): Promise<readonly TenderVocabularyRow[]> {
  const activeOnly = options?.activeOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    code: string;
    label: string;
    description: string | null;
    sort_order: number;
    is_active: boolean;
  }>(sql`
    select id, code, label, description, sort_order, is_active
      from tender_opportunity_sources
     where (${activeOnly}::boolean is false or is_active)
     order by sort_order, label
  `)) as unknown as {
    id: string;
    code: string;
    label: string;
    description: string | null;
    sort_order: number;
    is_active: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  }));
}

/**
 * The outcome-reason picker, filtered to the outcome being recorded.
 *
 * `appliesTo: "both"` rows appear under either. A caller that passes nothing
 * gets the whole list, which is what the administration screen wants.
 */
export async function listTenderOutcomeReasons(
  tx: TenantScopedTx,
  options?: { for?: "won" | "lost"; activeOnly?: boolean },
): Promise<readonly TenderOutcomeReasonRow[]> {
  const scope = options?.for ?? null;
  const activeOnly = options?.activeOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    code: string;
    label: string;
    description: string | null;
    applies_to: string;
    sort_order: number;
    is_active: boolean;
  }>(sql`
    select id, code, label, description, applies_to, sort_order, is_active
      from tender_outcome_reasons
     where (${activeOnly}::boolean is false or is_active)
       and (${scope}::text is null or applies_to = ${scope}::text or applies_to = 'both')
     order by sort_order, label
  `)) as unknown as {
    id: string;
    code: string;
    label: string;
    description: string | null;
    applies_to: string;
    sort_order: number;
    is_active: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    appliesTo: r.applies_to,
    sortOrder: r.sort_order,
    isActive: r.is_active,
  }));
}

// ── The pipeline ─────────────────────────────────────────────────────────────

/** `TND-2026-00001`. Allocated by the same SECURITY DEFINER counter as everything else. */
export async function nextTenderReference(
  tx: TenantScopedTx,
  year = new Date().getFullYear(),
): Promise<string> {
  const rows = (await tx.execute<{ reference: string }>(
    sql`select app_next_reference('TND', ${year}) as reference`,
  )) as unknown as { reference: string }[];

  const reference = rows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a tender reference");
  return reference;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar day, or a refusal naming the field.
 *
 * Validated rather than parsed. `new Date("2026-09-31")` is a real Date object
 * for 1 October, and a deadline silently moved a day is the failure this whole
 * feature is arranged around.
 */
function requireDay(value: string, field: string): string {
  const trimmed = value.trim();
  if (!DAY_PATTERN.test(trimmed)) {
    throw new UserFacingError(`${field} must be a calendar date, as YYYY-MM-DD.`);
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== trimmed) {
    throw new UserFacingError(`${trimmed} is not a real date.`);
  }
  return trimmed;
}

export interface CreateTenderInput {
  readonly title: string;
  readonly issuingBody: string;
  readonly opportunitySourceId: string;
  /** `YYYY-MM-DD`. The one field with no default and no way round it. */
  readonly submissionDeadline: string;
  readonly decisionDate?: string | undefined;
  readonly budgetCycle?: string | undefined;
  readonly portalReference?: string | undefined;
  readonly customerId?: string | undefined;
  readonly scopeOfWork?: string | undefined;
  readonly competitorsKnown?: number | undefined;
  readonly competitorNotes?: string | undefined;
  readonly bidValueMinor?: number | undefined;
  readonly notes?: string | undefined;
  readonly propertyIds?: readonly string[] | undefined;
}

/**
 * Record a tender.
 *
 * The deadline is required and the scope is not, because the deadline is the
 * fact that decays: an opportunity noticed on a Thursday and written up the
 * following week is an opportunity whose closing date has already moved four
 * days closer. Everything else can be filled in afterwards.
 */
export async function createTender(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: CreateTenderInput,
): Promise<{ id: string; reference: string }> {
  const title = input.title.trim();
  if (title.length < 3) throw new UserFacingError("Give the tender a title.");

  const issuingBody = input.issuingBody.trim();
  if (issuingBody.length < 2) {
    throw new UserFacingError("Name the organisation that issued the tender.");
  }

  const deadline = requireDay(input.submissionDeadline, "The submission deadline");
  const decisionDate = input.decisionDate ? requireDay(input.decisionDate, "The decision date") : null;

  if (decisionDate && decisionDate < deadline) {
    throw new UserFacingError(
      "The decision date is before the submission deadline. One of the two is wrong.",
    );
  }

  const reference = await nextTenderReference(tx, Number(deadline.slice(0, 4)));

  const [row] = await tx
    .insert(schema.tenders)
    .values({
      tenantId: ctx.tenantId,
      reference,
      title,
      issuingBody,
      opportunitySourceId: input.opportunitySourceId,
      customerId: input.customerId ?? null,
      portalReference: input.portalReference?.trim() || null,
      submissionDeadline: deadline,
      decisionDate,
      budgetCycle: input.budgetCycle?.trim() || null,
      scopeOfWork: input.scopeOfWork?.trim() || null,
      competitorsKnown: input.competitorsKnown ?? null,
      competitorNotes: input.competitorNotes?.trim() || null,
      bidValue: input.bidValueMinor === undefined ? null : toDecimalString(input.bidValueMinor),
      notes: input.notes?.trim() || null,
      ownerId: ctx.userId ?? null,
    })
    .returning({ id: schema.tenders.id, reference: schema.tenders.reference });

  if (!row) throw new Error("Could not record the tender.");

  if (input.propertyIds && input.propertyIds.length > 0) {
    await setTenderProperties(tx, ctx, row.id, input.propertyIds);
  }

  return row;
}

export interface UpdateTenderInput {
  readonly title?: string | undefined;
  readonly issuingBody?: string | undefined;
  readonly opportunitySourceId?: string | undefined;
  readonly submissionDeadline?: string | undefined;
  readonly decisionDate?: string | null | undefined;
  readonly budgetCycle?: string | null | undefined;
  readonly portalReference?: string | null | undefined;
  readonly scopeOfWork?: string | null | undefined;
  readonly competitorsKnown?: number | null | undefined;
  readonly competitorNotes?: string | null | undefined;
  readonly bidValueMinor?: number | null | undefined;
  readonly notes?: string | null | undefined;
}

/** Edit a tender. Anything not named is left alone. */
export async function updateTender(
  tx: TenantScopedTx,
  tenderId: string,
  input: UpdateTenderInput,
): Promise<void> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.title !== undefined) {
    const title = input.title.trim();
    if (title.length < 3) throw new UserFacingError("Give the tender a title.");
    patch["title"] = title;
  }
  if (input.issuingBody !== undefined) {
    const body = input.issuingBody.trim();
    if (body.length < 2) throw new UserFacingError("Name the organisation that issued the tender.");
    patch["issuingBody"] = body;
  }
  if (input.opportunitySourceId !== undefined) {
    patch["opportunitySourceId"] = input.opportunitySourceId;
  }
  if (input.submissionDeadline !== undefined) {
    patch["submissionDeadline"] = requireDay(input.submissionDeadline, "The submission deadline");
  }
  if (input.decisionDate !== undefined) {
    patch["decisionDate"] = input.decisionDate
      ? requireDay(input.decisionDate, "The decision date")
      : null;
  }
  if (input.budgetCycle !== undefined) patch["budgetCycle"] = input.budgetCycle?.trim() || null;
  if (input.portalReference !== undefined) {
    patch["portalReference"] = input.portalReference?.trim() || null;
  }
  if (input.scopeOfWork !== undefined) patch["scopeOfWork"] = input.scopeOfWork?.trim() || null;
  if (input.competitorsKnown !== undefined) patch["competitorsKnown"] = input.competitorsKnown;
  if (input.competitorNotes !== undefined) {
    patch["competitorNotes"] = input.competitorNotes?.trim() || null;
  }
  if (input.bidValueMinor !== undefined) {
    patch["bidValue"] = input.bidValueMinor === null ? null : toDecimalString(input.bidValueMinor);
  }
  if (input.notes !== undefined) patch["notes"] = input.notes?.trim() || null;

  await tx.update(schema.tenders).set(patch).where(eq(schema.tenders.id, tenderId));

  // Checked after the write rather than before, so a caller moving both dates
  // in one call is not refused for the intermediate state.
  const [row] = await tx
    .select({
      deadline: schema.tenders.submissionDeadline,
      decision: schema.tenders.decisionDate,
    })
    .from(schema.tenders)
    .where(eq(schema.tenders.id, tenderId))
    .limit(1);

  if (row?.decision && row.deadline && row.decision < row.deadline) {
    throw new UserFacingError(
      "The decision date is before the submission deadline. One of the two is wrong.",
    );
  }
}

/**
 * Replace the buildings a tender is priced for.
 *
 * Replace rather than append, because the scope of a tender is a list somebody
 * reads off the issuer's document and re-reads when it is amended — and an
 * append-only setter turns "they dropped tower 3" into a building that is still
 * priced in the pack.
 */
export async function setTenderProperties(
  tx: TenantScopedTx,
  ctx: TenantContext,
  tenderId: string,
  propertyIds: readonly string[],
): Promise<number> {
  const unique = [...new Set(propertyIds.filter(Boolean))];

  await tx.delete(schema.tenderProperties).where(eq(schema.tenderProperties.tenderId, tenderId));

  if (unique.length === 0) return 0;

  // Read back through the tenant boundary before writing. A property id from a
  // form is caller input, and the foreign key alone would let a row referencing
  // another tenant's building fail confusingly at the constraint rather than
  // clearly here.
  const found = await tx
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(and(inArray(schema.properties.id, unique), isNull(schema.properties.deletedAt)));

  if (found.length !== unique.length) {
    throw new UserFacingError("One of those buildings is not in this tenant's property register.");
  }

  await tx.insert(schema.tenderProperties).values(
    found.map((p) => ({ tenantId: ctx.tenantId, tenderId, propertyId: p.id })),
  );

  return found.length;
}

/** The bid went in. A fact with a date, deliberately not an outcome. */
export async function markTenderSubmitted(
  tx: TenantScopedTx,
  tenderId: string,
  input: { submittedOn: string; bidValueMinor?: number | undefined },
): Promise<void> {
  const day = requireDay(input.submittedOn, "The submission date");

  const [row] = await tx
    .select({ deadline: schema.tenders.submissionDeadline, outcome: schema.tenders.outcome })
    .from(schema.tenders)
    .where(eq(schema.tenders.id, tenderId))
    .limit(1);

  if (!row) throw new UserFacingError("That tender is not in this tenant.");
  if (isClosedOutcome(row.outcome)) {
    throw new UserFacingError(
      `This tender is already recorded as ${TENDER_OUTCOME_LABEL[row.outcome as TenderOutcome] ?? row.outcome}.`,
    );
  }

  // Recorded, not refused. A bid submitted after the closing date happens — a
  // portal extension, a hand delivery accepted late — and the honest record of
  // it is the one that makes "did we miss deadlines this year" answerable.
  await tx
    .update(schema.tenders)
    .set({
      submittedOn: day,
      ...(input.bidValueMinor === undefined ? {} : { bidValue: toDecimalString(input.bidValueMinor) }),
      updatedAt: new Date(),
    })
    .where(eq(schema.tenders.id, tenderId));
}

/**
 * Record what happened (`CON-11`: outcome **and** reason).
 *
 * The reason is required for a loss and optional for a win, which is not
 * squeamishness — it is where the value is. "We lost" is a number; "we lost
 * four to an incomplete submission" is the sentence that funds fixing the pack.
 */
export async function recordTenderOutcome(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    tenderId: string;
    outcome: TenderOutcome;
    reasonId?: string | undefined;
    note?: string | undefined;
    decidedOn?: string | undefined;
  },
): Promise<void> {
  if (!TENDER_OUTCOMES.includes(input.outcome)) {
    throw new UserFacingError(`"${input.outcome}" is not a tender outcome.`);
  }

  if (input.outcome === "lost" && !input.reasonId) {
    throw new UserFacingError(
      "A lost tender needs a reason. Counting losses without them tells you the number and not the fix.",
    );
  }

  const decidedOn = input.decidedOn ? requireDay(input.decidedOn, "The decision date") : null;

  if (input.reasonId) {
    const [reason] = await tx
      .select({ id: schema.tenderOutcomeReasons.id, appliesTo: schema.tenderOutcomeReasons.appliesTo })
      .from(schema.tenderOutcomeReasons)
      .where(eq(schema.tenderOutcomeReasons.id, input.reasonId))
      .limit(1);

    if (!reason) throw new UserFacingError("That outcome reason is not in this tenant's list.");

    if (
      (input.outcome === "won" || input.outcome === "lost") &&
      reason.appliesTo !== "both" &&
      reason.appliesTo !== input.outcome
    ) {
      throw new UserFacingError(
        `That reason is recorded as applying to a ${reason.appliesTo} tender, not a ${input.outcome} one.`,
      );
    }
  }

  await tx
    .update(schema.tenders)
    .set({
      outcome: input.outcome,
      outcomeReasonId: input.reasonId ?? null,
      outcomeNote: input.note?.trim() || null,
      decidedOn,
      decidedById: ctx.userId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.tenders.id, input.tenderId));
}

// ── The queue (CON-11: sorted by days until deadline, always) ────────────────

export interface TenderQueueRow {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly issuingBody: string;
  readonly sourceLabel: string;
  readonly submissionDeadline: string;
  readonly decisionDate: string | null;
  readonly budgetCycle: string | null;
  /** `submission_deadline - current_date`, computed by Postgres. Negative is overdue. */
  readonly daysRemaining: number;
  readonly submittedOn: string | null;
  readonly outcome: string;
  readonly outcomeReasonLabel: string | null;
  readonly bidValueMinor: number | null;
  readonly currency: string;
  readonly competitorsKnown: number | null;
  readonly propertyCount: number;
  readonly packPreparedOn: string | null;
}

/**
 * The tender queue.
 *
 * Takes no sort argument. `CON-11` says *always*, and an ordering that a caller
 * can change is an ordering that will be changed — most plausibly to "newest
 * first", which is the shape of every other list in this application and the
 * one that buries a tender closing on Thursday under three recorded yesterday.
 *
 * Open tenders first, then closed ones, each block by deadline ascending. An
 * overdue-and-still-pending tender therefore sorts to the very top and stays
 * there until somebody records what happened to it: it does not quietly drop
 * off the list, which is the failure the queue exists to prevent.
 */
export async function tenderQueue(
  tx: TenantScopedTx,
  options?: { includeClosed?: boolean; limit?: number },
): Promise<readonly TenderQueueRow[]> {
  const includeClosed = options?.includeClosed ?? false;
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 500);

  const rows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    issuing_body: string;
    source_label: string;
    submission_deadline: string;
    decision_date: string | null;
    budget_cycle: string | null;
    days_remaining: number;
    submitted_on: string | null;
    outcome: string;
    outcome_reason_label: string | null;
    bid_value: string | null;
    currency: string;
    competitors_known: number | null;
    property_count: number;
    pack_prepared_on: string | null;
  }>(sql`
    select t.id,
           t.reference,
           t.title,
           t.issuing_body,
           s.label as source_label,
           t.submission_deadline,
           t.decision_date,
           t.budget_cycle,
           -- Day arithmetic in SQL, as date minus date. Subtracting a JS Date
           -- at midnight from new Date() and flooring gives 29 for a deadline
           -- 30 days out, because the partial day is discarded -- and on a
           -- deadline queue an off-by-one in the pessimistic direction is the
           -- least bad version of a bug that also has an optimistic one.
           (t.submission_deadline - current_date)::int as days_remaining,
           t.submitted_on,
           t.outcome,
           r.label as outcome_reason_label,
           t.bid_value,
           t.currency,
           t.competitors_known,
           (select count(*)::int from tender_properties tp
             where tp.tender_id = t.id) as property_count,
           (select max(p.prepared_on) from tender_packs p
             where p.tender_id = t.id) as pack_prepared_on
      from tenders t
      join tender_opportunity_sources s on s.id = t.opportunity_source_id
      left join tender_outcome_reasons r on r.id = t.outcome_reason_id
     where t.deleted_at is null
       and (${includeClosed}::boolean or t.outcome = 'pending')
     order by (t.outcome <> 'pending'), t.submission_deadline, t.reference
     limit ${limit}
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    issuing_body: string;
    source_label: string;
    submission_deadline: string;
    decision_date: string | null;
    budget_cycle: string | null;
    days_remaining: number;
    submitted_on: string | null;
    outcome: string;
    outcome_reason_label: string | null;
    bid_value: string | null;
    currency: string;
    competitors_known: number | null;
    property_count: number;
    pack_prepared_on: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    issuingBody: r.issuing_body,
    sourceLabel: r.source_label,
    submissionDeadline: r.submission_deadline,
    decisionDate: r.decision_date,
    budgetCycle: r.budget_cycle,
    daysRemaining: Number(r.days_remaining),
    submittedOn: r.submitted_on,
    outcome: r.outcome,
    outcomeReasonLabel: r.outcome_reason_label,
    bidValueMinor: r.bid_value === null ? null : toMinor(r.bid_value),
    currency: r.currency,
    competitorsKnown: r.competitors_known === null ? null : Number(r.competitors_known),
    propertyCount: Number(r.property_count),
    packPreparedOn: r.pack_prepared_on,
  }));
}

export interface TenderPropertyRow {
  readonly propertyId: string;
  readonly name: string;
  readonly addressLine: string;
  readonly area: string | null;
  readonly city: string;
  readonly type: string;
  readonly assetCount: number;
}

export interface TenderPackRow {
  readonly id: string;
  readonly preparedOn: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly pageCount: number;
  readonly byteSize: number;
  readonly manifest: string;
  readonly createdAt: Date;
}

export interface TenderDetail extends TenderQueueRow {
  readonly opportunitySourceId: string;
  readonly portalReference: string | null;
  readonly scopeOfWork: string | null;
  readonly competitorNotes: string | null;
  readonly outcomeNote: string | null;
  readonly decidedOn: string | null;
  readonly customerId: string | null;
  readonly customerName: string | null;
  readonly notes: string | null;
  readonly properties: readonly TenderPropertyRow[];
  readonly packs: readonly TenderPackRow[];
}

/** One tender, with everything the screen shows. */
export async function getTender(tx: TenantScopedTx, tenderId: string): Promise<TenderDetail | null> {
  const rows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    issuing_body: string;
    opportunity_source_id: string;
    source_label: string;
    portal_reference: string | null;
    submission_deadline: string;
    decision_date: string | null;
    budget_cycle: string | null;
    days_remaining: number;
    scope_of_work: string | null;
    competitors_known: number | null;
    competitor_notes: string | null;
    submitted_on: string | null;
    outcome: string;
    outcome_reason_label: string | null;
    outcome_note: string | null;
    decided_on: string | null;
    bid_value: string | null;
    currency: string;
    customer_id: string | null;
    customer_name: string | null;
    notes: string | null;
  }>(sql`
    select t.id, t.reference, t.title, t.issuing_body,
           t.opportunity_source_id, s.label as source_label,
           t.portal_reference, t.submission_deadline, t.decision_date, t.budget_cycle,
           (t.submission_deadline - current_date)::int as days_remaining,
           t.scope_of_work, t.competitors_known, t.competitor_notes,
           t.submitted_on, t.outcome, r.label as outcome_reason_label,
           t.outcome_note, t.decided_on, t.bid_value, t.currency,
           t.customer_id, c.name as customer_name, t.notes
      from tenders t
      join tender_opportunity_sources s on s.id = t.opportunity_source_id
      left join tender_outcome_reasons r on r.id = t.outcome_reason_id
      left join customers c on c.id = t.customer_id
     where t.id = ${tenderId}::uuid
       and t.deleted_at is null
     limit 1
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    issuing_body: string;
    opportunity_source_id: string;
    source_label: string;
    portal_reference: string | null;
    submission_deadline: string;
    decision_date: string | null;
    budget_cycle: string | null;
    days_remaining: number;
    scope_of_work: string | null;
    competitors_known: number | null;
    competitor_notes: string | null;
    submitted_on: string | null;
    outcome: string;
    outcome_reason_label: string | null;
    outcome_note: string | null;
    decided_on: string | null;
    bid_value: string | null;
    currency: string;
    customer_id: string | null;
    customer_name: string | null;
    notes: string | null;
  }[];

  const t = rows[0];
  if (!t) return null;

  const properties = await tenderPropertyRows(tx, tenderId);
  const packs = await listTenderPacks(tx, tenderId);

  return {
    id: t.id,
    reference: t.reference,
    title: t.title,
    issuingBody: t.issuing_body,
    opportunitySourceId: t.opportunity_source_id,
    sourceLabel: t.source_label,
    portalReference: t.portal_reference,
    submissionDeadline: t.submission_deadline,
    decisionDate: t.decision_date,
    budgetCycle: t.budget_cycle,
    daysRemaining: Number(t.days_remaining),
    scopeOfWork: t.scope_of_work,
    competitorsKnown: t.competitors_known === null ? null : Number(t.competitors_known),
    competitorNotes: t.competitor_notes,
    submittedOn: t.submitted_on,
    outcome: t.outcome,
    outcomeReasonLabel: t.outcome_reason_label,
    outcomeNote: t.outcome_note,
    decidedOn: t.decided_on,
    bidValueMinor: t.bid_value === null ? null : toMinor(t.bid_value),
    currency: t.currency,
    customerId: t.customer_id,
    customerName: t.customer_name,
    notes: t.notes,
    propertyCount: properties.length,
    packPreparedOn: packs[0]?.preparedOn ?? null,
    properties,
    packs,
  };
}

async function tenderPropertyRows(
  tx: TenantScopedTx,
  tenderId: string,
): Promise<readonly TenderPropertyRow[]> {
  const rows = (await tx.execute<{
    property_id: string;
    name: string;
    address_line: string;
    area: string | null;
    city: string;
    type: string;
    asset_count: number;
  }>(sql`
    select p.id as property_id, p.name, p.address_line, p.area, p.city, p.type::text as type,
           (select count(*)::int from assets a
             where a.property_id = p.id and a.deleted_at is null) as asset_count
      from tender_properties tp
      join properties p on p.id = tp.property_id
     where tp.tender_id = ${tenderId}::uuid
       and p.deleted_at is null
     order by p.name
  `)) as unknown as {
    property_id: string;
    name: string;
    address_line: string;
    area: string | null;
    city: string;
    type: string;
    asset_count: number;
  }[];

  return rows.map((r) => ({
    propertyId: r.property_id,
    name: r.name,
    addressLine: r.address_line,
    area: r.area,
    city: r.city,
    type: r.type,
    assetCount: Number(r.asset_count),
  }));
}

// ── The pack's inputs (CON-12) ───────────────────────────────────────────────

/** One certificate the pack has to attach, and where its bytes live. */
export interface PackEvidence {
  readonly accreditationId: string;
  /**
   * Which entry in the document's accreditation list this is the file for.
   *
   * An index rather than a name, because two rows can legitimately share one —
   * a company holding ISO 9001 for two scopes, or a policy renewed under the
   * same name — and matching evidence to entries by name would attach one
   * certificate to both and leave the other looking unevidenced.
   */
  readonly position: number;
  readonly kind: string;
  readonly kindLabel: string;
  readonly name: string;
  readonly referenceNo: string | null;
  readonly issuingBody: string | null;
  readonly grade: string | null;
  readonly expiresOn: string | null;
  readonly storageKey: string;
}

export interface TenderPackInputs {
  /**
   * The document, shaped but not yet judged.
   *
   * The type is real — the compiler checks the object built below against it —
   * but the type is only the *shape*. Whether the pack may be produced at all
   * is `assertTenderPackRenderable`'s decision: expiries against the pack date,
   * the four required accreditations, a non-empty plant list and rate card. That
   * lives in `@meridian/core` so the refusal is testable without a database and
   * unavoidable in the renderer, and it is deliberately not repeated here.
   */
  readonly document: TenderPackDocument;
  /** Certificates to attach, in the order they appear in the document. */
  readonly evidence: readonly PackEvidence[];
  readonly preparedOn: string;
}

/**
 * Everything a tender pack is assembled from, read live (`CON-12`).
 *
 * ── WHY EVERY PART OF THIS IS A QUERY ───────────────────────────────────────
 *
 * `CON-12`: *assembled from the company accreditation register (`HR-14`) so it
 * is always current.* That is the requirement and it is not satisfied by
 * copying the register into the tender when the tender is created. A pack built
 * in September from a snapshot taken in June contains June's licence and June's
 * insurance, and the whole artefact is a claim about today.
 *
 * So there is no denormalised copy anywhere in `tenders.ts`: the scope of work
 * is the tender's own text, and the plant list, the rates, the accreditations
 * and the reference contracts are read from `assets`, `rate_card_items`,
 * `company_accreditations` and `contracts` at the moment of assembly. What is
 * frozen is the *output* — the rendered PDF and its hash — which is the correct
 * thing to freeze, because it is what was submitted.
 *
 * `preparedOn` is the pinned business date. Every expiry is judged against it,
 * the rate card is read as at it, and `packages/docs` writes it into the PDF's
 * metadata so the same pack renders to the same bytes.
 */
export async function tenderPackInputs(
  tx: TenantScopedTx,
  tenderId: string,
  options?: { preparedOn?: string },
): Promise<TenderPackInputs> {
  const preparedOn = options?.preparedOn
    ? requireDay(options.preparedOn, "The pack date")
    : await businessToday(tx);

  const tender = await getTender(tx, tenderId);
  if (!tender) throw new UserFacingError("That tender is not in this tenant.");

  const identity = await resolveCompanyIdentity(tx);

  const propertyIds = tender.properties.map((p) => p.propertyId);
  const assets = propertyIds.length > 0 ? await packAssets(tx, propertyIds) : [];
  const rates = await packRates(tx, preparedOn);
  const { accreditations, evidence } = await packAccreditations(tx);
  const referenceContracts = await packReferenceContracts(tx, tenderId);

  const document = {
    reference: tender.reference,
    title: tender.title,
    preparedOn,
    issuingBody: tender.issuingBody,
    opportunitySourceLabel: tender.sourceLabel,
    portalReference: tender.portalReference,
    budgetCycle: tender.budgetCycle,
    submissionDeadline: tender.submissionDeadline,
    decisionDate: tender.decisionDate,
    supplier: {
      name: identity.legalName,
      trn: identity.trn,
      // Assembled here and each part dropped when unset — `company.ts`'s rule.
      // A pack with no street line reads as incomplete; one with a placeholder
      // street line is a false statement on a document a stranger evaluates.
      address:
        [identity.address.street, identity.address.city, identity.address.country]
          .filter(Boolean)
          .join(", ") || null,
      phone: identity.phone,
      email: identity.email,
      licenceNumber: identity.licenceNumber,
      crNumber: identity.crNumber,
    },
    scopeOfWork: tender.scopeOfWork ?? "",
    properties: tender.properties.map((p) => ({
      name: p.name,
      addressLine: p.addressLine,
      area: p.area,
      city: p.city,
      typeLabel: humanise(p.type),
    })),
    // Copied into mutable arrays. The helpers above return `readonly` lists,
    // which is right for a caller that must not edit them and wrong for the
    // schema's inferred type — zod infers a mutable array, and a `readonly` one
    // is not assignable to it.
    assets: [...assets],
    rates: [...rates],
    accreditations: [...accreditations],
    referenceContracts: [...referenceContracts],
    currency: tender.currency,
    bidValueMinor: tender.bidValueMinor,
  };

  return { document, evidence, preparedOn };
}

/** Today, as Postgres sees it. One clock for the whole assembly. */
async function businessToday(tx: TenantScopedTx): Promise<string> {
  const rows = (await tx.execute<{ today: string }>(
    sql`select to_char(current_date, 'YYYY-MM-DD') as today`,
  )) as unknown as { today: string }[];

  const today = rows[0]?.today;
  if (!today) throw new Error("Could not read the current date");
  return today;
}

/** The per-asset PPM schedule, from the register (`CON-13`). */
async function packAssets(
  tx: TenantScopedTx,
  propertyIds: readonly string[],
): Promise<
  readonly {
    propertyName: string;
    tag: string;
    name: string;
    category: string;
    manufacturer: string | null;
    model: string | null;
    serialNumber: string | null;
    location: string | null;
    installedOn: string | null;
    ppmIntervalDays: number | null;
  }[]
> {
  const rows = (await tx.execute<{
    property_name: string;
    tag: string;
    name: string;
    category: string;
    manufacturer: string | null;
    model: string | null;
    serial_number: string | null;
    location: string | null;
    installed_on: string | null;
    ppm_interval_days: number | null;
  }>(sql`
    select p.name as property_name,
           a.tag, a.name,
           coalesce(c.label, 'Unclassified') as category,
           a.manufacturer, a.model, a.serial_number, a.location,
           a.installed_on,
           -- The asset's own interval, falling back to the kind's standard.
           -- A blank column in the pack reads as "we did not survey this";
           -- the kind's interval is the one the register itself prefills with.
           coalesce(a.ppm_interval_days, c.default_ppm_interval_days) as ppm_interval_days
      from assets a
      join properties p on p.id = a.property_id
      left join asset_categories c on c.id = a.category_id
     -- Bound as one array parameter, not expanded into placeholders. Drizzle's
     -- template tag turns a bare JavaScript array into ($1, $2), which Postgres
     -- rejects on the right of ANY; the precedent is createContract.
     --
     -- No backticks in here, ever. This comment sits inside a tagged template
     -- literal, so one backtick closes it and the failure surfaces as a syntax
     -- error dozens of lines further down, in code that is perfectly fine.
     where a.property_id = any(${sql`array[${sql.join(
       propertyIds.map((id) => sql`${id}`),
       sql`, `,
     )}]::uuid[]`})
       and a.deleted_at is null
     order by p.name, c.sort_order nulls last, a.tag
  `)) as unknown as {
    property_name: string;
    tag: string;
    name: string;
    category: string;
    manufacturer: string | null;
    model: string | null;
    serial_number: string | null;
    location: string | null;
    installed_on: string | null;
    ppm_interval_days: number | null;
  }[];

  return rows.map((r) => ({
    propertyName: r.property_name,
    tag: r.tag,
    name: r.name,
    category: r.category,
    manufacturer: r.manufacturer,
    model: r.model,
    serialNumber: r.serial_number,
    location: r.location,
    installedOn: r.installed_on,
    ppmIntervalDays: r.ppm_interval_days === null ? null : Number(r.ppm_interval_days),
  }));
}

const RATE_BAND_LABELS: Readonly<Record<string, string>> = {
  standard: "Standard hours",
  after_hours: "After hours",
  emergency: "Emergency call-out",
  weekend: "Weekend",
};

/**
 * The priced schedule of rates, as it stood on the pack date.
 *
 * `effective_from <= preparedOn < effective_to` — the half-open period the rate
 * card is versioned on, which is how a pack submitted in March can still be
 * reproduced in September at March's prices. Every band is included, published
 * or not: `is_published` governs the public website (`WEB-16`), and a tender is
 * a priced offer to one evaluator rather than a public price list.
 */
async function packRates(
  tx: TenantScopedTx,
  preparedOn: string,
): Promise<
  readonly {
    code: string;
    label: string;
    unit: string;
    rateBandLabel: string;
    unitPriceMinor: number;
    minQuantity: string | null;
    notes: string | null;
  }[]
> {
  const rows = (await tx.execute<{
    code: string;
    label: string;
    unit: string;
    rate_band: string;
    unit_price: string;
    min_quantity: string | null;
    notes: string | null;
  }>(sql`
    select code, label, unit, rate_band, unit_price, min_quantity, notes
      from rate_card_items
     where effective_from <= ${preparedOn}::date
       and (effective_to is null or effective_to > ${preparedOn}::date)
     order by service_slug, code, rate_band
  `)) as unknown as {
    code: string;
    label: string;
    unit: string;
    rate_band: string;
    unit_price: string;
    min_quantity: string | null;
    notes: string | null;
  }[];

  return rows.map((r) => ({
    code: r.code,
    label: r.label,
    unit: r.unit,
    rateBandLabel: RATE_BAND_LABELS[r.rate_band] ?? humanise(r.rate_band),
    unitPriceMinor: toMinor(r.unit_price),
    minQuantity: r.min_quantity,
    notes: r.notes,
  }));
}

/**
 * The company accreditation register (`HR-14`), live.
 *
 * Everything marked for inclusion is returned — including anything expired,
 * which is the point. Filtering expired rows out here would produce a pack that
 * silently lacked its insurance certificate, and the whole design of `CON-12`
 * is that the pack refuses loudly instead. The refusal is
 * `assertTenderPackRenderable`'s job and it needs to see the expired row to
 * name it.
 */
async function packAccreditations(tx: TenantScopedTx): Promise<{
  accreditations: readonly {
    kind: string;
    kindLabel: string;
    name: string;
    referenceNo: string | null;
    issuingBody: string | null;
    grade: string | null;
    issuedOn: string | null;
    expiresOn: string | null;
    hasDocument: boolean;
    documentSha256: string | null;
  }[];
  evidence: readonly PackEvidence[];
}> {
  const rows = (await tx.execute<{
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    issuing_body: string | null;
    grade: string | null;
    issued_at: string | null;
    expires_at: string | null;
    storage_key: string | null;
  }>(sql`
    select id, kind, name, reference_no, issuing_body, grade, issued_at, expires_at, storage_key
      from company_accreditations
     where deleted_at is null
       and tender_pack_include
     order by kind, expires_at desc nulls last, name
  `)) as unknown as {
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    issuing_body: string | null;
    grade: string | null;
    issued_at: string | null;
    expires_at: string | null;
    storage_key: string | null;
  }[];

  const accreditations = rows.map((r) => ({
    kind: r.kind,
    kindLabel: ACCREDITATION_LABEL[r.kind as AccreditationKind] ?? humanise(r.kind),
    name: r.name,
    referenceNo: r.reference_no,
    issuingBody: r.issuing_body,
    grade: r.grade,
    issuedOn: r.issued_at,
    expiresOn: r.expires_at,
    hasDocument: Boolean(r.storage_key),
    // Filled in by the renderer once the bytes have been read, because the hash
    // that belongs in the manifest is the hash of what was actually attached.
    documentSha256: null as string | null,
  }));

  const evidence: PackEvidence[] = rows
    .map((r, position) => ({ ...r, position }))
    .filter((r): r is typeof r & { storage_key: string } => Boolean(r.storage_key))
    .map((r) => ({
      accreditationId: r.id,
      position: r.position,
      kind: r.kind,
      kindLabel: ACCREDITATION_LABEL[r.kind as AccreditationKind] ?? humanise(r.kind),
      name: r.name,
      referenceNo: r.reference_no,
      issuingBody: r.issuing_body,
      grade: r.grade,
      expiresOn: r.expires_at,
      storageKey: r.storage_key,
    }));

  return { accreditations, evidence };
}

const CONTRACT_KIND_LABELS: Readonly<Record<string, string>> = {
  amc: "Annual maintenance contract",
  facility_management: "Facility management",
  building_maintenance: "Building maintenance",
  workforce_supply: "Workforce supply",
};

/**
 * Reference contracts.
 *
 * Live rows from `contracts`, not testimonials: an evaluator can ring the
 * client named on one. Active first, then the most recently ended, because a
 * contract that ended four years ago is a weaker reference than one running
 * now and the ordering should say so.
 *
 * The tender's own issuer is excluded where they are already a customer. Citing
 * a body's own contract back to it as a reference reads as padding.
 */
async function packReferenceContracts(
  tx: TenantScopedTx,
  tenderId: string,
): Promise<
  readonly {
    reference: string;
    customerName: string;
    kindLabel: string;
    startsOn: string;
    endsOn: string;
    annualValueMinor: number;
    propertyCount: number;
    statusLabel: string;
  }[]
> {
  const rows = (await tx.execute<{
    reference: string;
    customer_name: string;
    kind: string;
    starts_on: string;
    ends_on: string;
    annual_value: string;
    property_count: number;
    status: string;
  }>(sql`
    select c.reference,
           cu.name as customer_name,
           c.kind,
           to_char(c.starts_on at time zone 'Asia/Dubai', 'YYYY-MM-DD') as starts_on,
           to_char(c.ends_on at time zone 'Asia/Dubai', 'YYYY-MM-DD') as ends_on,
           c.annual_value,
           (select count(*)::int from contract_properties cp
             where cp.contract_id = c.id) as property_count,
           c.status::text as status
      from contracts c
      join customers cu on cu.id = c.customer_id
     where c.deleted_at is null
       and c.status in ('active', 'expired', 'renewed')
       and c.customer_id is distinct from (
             select t.customer_id from tenders t where t.id = ${tenderId}::uuid)
     order by (c.status <> 'active'), c.ends_on desc
     limit 12
  `)) as unknown as {
    reference: string;
    customer_name: string;
    kind: string;
    starts_on: string;
    ends_on: string;
    annual_value: string;
    property_count: number;
    status: string;
  }[];

  return rows.map((r) => ({
    reference: r.reference,
    customerName: r.customer_name,
    kindLabel: CONTRACT_KIND_LABELS[r.kind] ?? humanise(r.kind),
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    annualValueMinor: toMinor(r.annual_value),
    propertyCount: Number(r.property_count),
    statusLabel: humanise(r.status),
  }));
}

// ── The assembled artefact ───────────────────────────────────────────────────

/** Packs assembled for this tender, newest first. */
export async function listTenderPacks(
  tx: TenantScopedTx,
  tenderId: string,
): Promise<readonly TenderPackRow[]> {
  const rows = (await tx.execute<{
    id: string;
    prepared_on: string;
    storage_key: string;
    sha256: string;
    page_count: number;
    byte_size: number;
    manifest: string;
    created_at: string;
  }>(sql`
    select id, prepared_on, storage_key, sha256, page_count, byte_size, manifest, created_at
      from tender_packs
     where tender_id = ${tenderId}::uuid
     order by prepared_on desc, created_at desc
  `)) as unknown as {
    id: string;
    prepared_on: string;
    storage_key: string;
    sha256: string;
    page_count: number;
    byte_size: number;
    manifest: string;
    created_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    preparedOn: r.prepared_on,
    storageKey: r.storage_key,
    sha256: r.sha256,
    pageCount: Number(r.page_count),
    byteSize: Number(r.byte_size),
    manifest: r.manifest,
    createdAt: requiredRowDate(r.created_at),
  }));
}

/** The pack already assembled on this business date, if there is one. */
export async function tenderPackOn(
  tx: TenantScopedTx,
  tenderId: string,
  preparedOn: string,
): Promise<TenderPackRow | null> {
  const packs = await listTenderPacks(tx, tenderId);
  return packs.find((p) => p.preparedOn === preparedOn) ?? null;
}

/**
 * Record an assembled pack.
 *
 * `on conflict do nothing` on `(tenant_id, tender_id, prepared_on)`, then read
 * back. Two operators pressing the button in the same second would otherwise
 * race, and the loser would fail an action that had done nothing wrong — the
 * same guard `materialiseInvoiceDocument` uses, for the same reason. Because
 * the render is deterministic, both produced identical bytes anyway.
 */
export async function recordTenderPack(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    tenderId: string;
    preparedOn: string;
    storageKey: string;
    sha256: string;
    pageCount: number;
    byteSize: number;
    manifest: string;
  },
): Promise<TenderPackRow> {
  await tx
    .insert(schema.tenderPacks)
    .values({
      tenantId: ctx.tenantId,
      tenderId: input.tenderId,
      preparedOn: input.preparedOn,
      storageKey: input.storageKey,
      sha256: input.sha256,
      pageCount: input.pageCount,
      byteSize: input.byteSize,
      manifest: input.manifest,
      preparedById: ctx.userId ?? null,
    })
    .onConflictDoNothing();

  const stored = await tenderPackOn(tx, input.tenderId, input.preparedOn);
  if (!stored) throw new Error("Could not record the tender pack.");
  return stored;
}

/** `oa_management_company` → `Oa management company`. A last resort, not a label. */
function humanise(value: string): string {
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
