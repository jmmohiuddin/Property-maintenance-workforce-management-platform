import { and, asc, eq, sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { transitionJob } from "./jobs";
import { assertJobCardComplete } from "./jobcard";
import { UserFacingError, type JobStatus } from "@meridian/core";
import { FAULT_CODE_KINDS, type FaultCodeKind } from "./reference";

/**
 * Outcome and fault capture (`JOB-13`, `JOB-14`).
 *
 * ── WHAT WAS MISSING, AND WHY IT MATTERED ───────────────────────────────────
 *
 * The vocabularies have existed since `0012_taxonomies`: `job_outcome_codes`
 * seeded with the seven outcomes `JOB-13` names, `fault_codes` with a
 * symptom / cause / remedy discriminator, and an administrator screen for both.
 * What did not exist was anything that *wrote* to them. `jobs.outcome_code` has
 * been a nullable varchar since `0005` and nothing has ever set it, there was
 * no column at all for a fault code, and the admin screen said so in as many
 * words: "choosing an outcome on a job is part of the field app and is not
 * built yet".
 *
 * That gap is not cosmetic. `G11` — first-time-fix rate, target above 85% — is
 * defined as jobs closed on the first visit over all reactive jobs, and the
 * only thing that can distinguish the two is the outcome code. Without capture
 * the metric has no numerator. And `JOB-14` is blunter still: a fault typed by
 * hand cannot answer "how many times has this model failed the same way", which
 * is the entire argument for the taxonomy existing, and the PRD calls it the
 * mistake that cannot be retrofitted — by the time somebody wants the answer,
 * the history is already written.
 *
 * ── WHY COMPLETION IS ONE CALL AND NOT TWO ──────────────────────────────────
 *
 * `recordJobOutcome` moves the job to `work_complete` in the same transaction
 * that records the outcome. Two separate actions would mean a job that is
 * complete with no outcome — which is the state `JOB-15` exists to forbid, and
 * the state that is unfixable afterwards because nobody can remember in March
 * what happened on a Tuesday in January.
 *
 * ── AND WHY THE OTHER THREE CONDITIONS ARE CHECKED HERE TOO (JOB-15) ────────
 *
 * The outcome is one of four things `JOB-15` names, and for a while it was the
 * only one anybody enforced: a job could reach `work_complete` carrying no
 * photograph, no parts and no time. `assertJobCardComplete` in `./jobcard`
 * holds the other three, and it is called from inside this transaction — the
 * one that would otherwise perform the transition — so a refusal writes
 * nothing at all. See that module for what "labour time" keys off and why a
 * check in the completion form would have protected nothing.
 */

// ── Fault coding (JOB-14) ───────────────────────────────────────────────────

export interface RecordedFaultCode {
  readonly id: string;
  readonly kind: FaultCodeKind;
  readonly code: string;
  readonly label: string;
  readonly visitId: string | null;
}

export interface JobOutcomeCapture {
  readonly outcomeCode: string | null;
  readonly outcomeLabel: string | null;
  readonly isTerminal: boolean | null;
  readonly requiresReturnVisit: boolean | null;
  readonly faultCodes: readonly RecordedFaultCode[];
}

/** What has been recorded against this job so far. Null outcome means nothing. */
export async function getJobOutcome(
  tx: TenantScopedTx,
  jobId: string,
): Promise<JobOutcomeCapture> {
  const rows = await tx
    .select({
      outcomeCode: schema.jobs.outcomeCode,
      label: schema.jobOutcomeCodes.label,
      isTerminal: schema.jobOutcomeCodes.isTerminal,
      requiresReturnVisit: schema.jobOutcomeCodes.requiresReturnVisit,
    })
    .from(schema.jobs)
    // Left, not inner: an outcome recorded before somebody deactivated the code
    // must still render. Retiring a vocabulary entry rewrites the picker, never
    // the history.
    .leftJoin(
      schema.jobOutcomeCodes,
      and(
        eq(schema.jobOutcomeCodes.tenantId, schema.jobs.tenantId),
        eq(schema.jobOutcomeCodes.code, schema.jobs.outcomeCode),
      ),
    )
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  const job = rows[0];

  const faults = await tx
    .select({
      id: schema.jobFaultCodes.id,
      kind: schema.jobFaultCodes.kind,
      code: schema.faultCodes.code,
      label: schema.faultCodes.label,
      visitId: schema.jobFaultCodes.visitId,
    })
    .from(schema.jobFaultCodes)
    .innerJoin(schema.faultCodes, eq(schema.faultCodes.id, schema.jobFaultCodes.faultCodeId))
    .where(eq(schema.jobFaultCodes.jobId, jobId))
    .orderBy(asc(schema.jobFaultCodes.createdAt));

  return {
    outcomeCode: job?.outcomeCode ?? null,
    outcomeLabel: job?.label ?? null,
    isTerminal: job?.isTerminal ?? null,
    requiresReturnVisit: job?.requiresReturnVisit ?? null,
    faultCodes: faults.map((f) => ({
      id: f.id,
      kind: f.kind as FaultCodeKind,
      code: f.code,
      label: f.label,
      visitId: f.visitId,
    })),
  };
}

/** Statuses from which recording an outcome and completing the work is legal. */
const COMPLETABLE_STATUSES: readonly JobStatus[] = ["on_site", "work_complete"];

export interface RecordOutcomeInput {
  readonly jobId: string;
  /** From `job_outcome_codes`, active. Never free text (`JOB-13`). */
  readonly outcomeCode: string;
  /**
   * `JOB-14`, by `fault_codes.id` per part. All three are optional
   * individually: a `no_access` visit diagnosed nothing, and demanding a cause
   * for it would produce a fabricated one — which is worse than a gap, because
   * a gap is visible and a fabrication is not.
   */
  readonly symptomCodeId?: string | null;
  readonly causeCodeId?: string | null;
  readonly remedyCodeId?: string | null;
  /** Which visit produced this. Optional: a single-visit job needs no choice. */
  readonly visitId?: string | null;
  /** The technician's words. Recorded alongside the codes, never instead. */
  readonly note?: string | null;
  /** False when the caller only wants to correct a recorded outcome. */
  readonly completeWork?: boolean;
}

export interface RecordOutcomeResult {
  readonly outcomeCode: string;
  readonly outcomeLabel: string;
  readonly requiresReturnVisit: boolean;
  readonly transitioned: boolean;
}

/**
 * Record what happened on the visit, and complete the work (`JOB-13`, `JOB-14`).
 *
 * Every value is verified against the tenant's own vocabulary before it is
 * written. That check is the entire point of the tables: a code the picker does
 * not offer is either a stale form or a hand-crafted POST, and accepting one
 * puts a value in `outcome_code` that no report can group. The database agrees
 * — `0024` adds a foreign key from `jobs (tenant_id, outcome_code)` — but the
 * message a person can act on comes from here.
 */
export async function recordJobOutcome(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RecordOutcomeInput,
): Promise<RecordOutcomeResult> {
  const jobRows = await tx
    .select({ status: schema.jobs.status, serviceSlug: schema.jobs.serviceSlug })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const job = jobRows[0];
  // RLS makes "not found" and "another tenant's job" indistinguishable here,
  // which is the intended behaviour.
  if (!job) throw new Error(`Job ${input.jobId} not found in this tenant`);

  const status = job.status as JobStatus;
  if (!COMPLETABLE_STATUSES.includes(status)) {
    throw new UserFacingError(
      `An outcome is recorded when the work ends. This job is ${status.replace(/_/g, " ")}, ` +
        `so move it to on site first.`,
    );
  }

  const outcomeRows = await tx
    .select({
      code: schema.jobOutcomeCodes.code,
      label: schema.jobOutcomeCodes.label,
      isActive: schema.jobOutcomeCodes.isActive,
      requiresReturnVisit: schema.jobOutcomeCodes.requiresReturnVisit,
    })
    .from(schema.jobOutcomeCodes)
    .where(eq(schema.jobOutcomeCodes.code, input.outcomeCode))
    .limit(1);

  const outcome = outcomeRows[0];
  if (!outcome) {
    throw new UserFacingError(
      `"${input.outcomeCode}" is not one of this company's job outcomes. ` +
        `The list is maintained under Admin → Reference data → Job outcomes.`,
    );
  }
  if (!outcome.isActive) {
    throw new UserFacingError(
      `"${outcome.label}" has been retired and cannot be recorded on new work. ` +
        `Choose a current outcome, or reactivate it under Admin → Reference data.`,
    );
  }

  // The visit, if one was named, has to belong to this job. A visit id from
  // another job would file the diagnosis against the wrong work.
  if (input.visitId) {
    const visitRows = await tx
      .select({ id: schema.jobVisits.id })
      .from(schema.jobVisits)
      .where(and(eq(schema.jobVisits.id, input.visitId), eq(schema.jobVisits.jobId, input.jobId)))
      .limit(1);
    if (!visitRows[0]) throw new UserFacingError("That visit does not belong to this job.");
  }

  const chosen: { kind: FaultCodeKind; id: string }[] = [];
  if (input.symptomCodeId) chosen.push({ kind: "symptom", id: input.symptomCodeId });
  if (input.causeCodeId) chosen.push({ kind: "cause", id: input.causeCodeId });
  if (input.remedyCodeId) chosen.push({ kind: "remedy", id: input.remedyCodeId });

  for (const pick of chosen) {
    const rows = await tx
      .select({
        id: schema.faultCodes.id,
        kind: schema.faultCodes.kind,
        label: schema.faultCodes.label,
        isActive: schema.faultCodes.isActive,
        serviceSlug: schema.faultCodes.serviceSlug,
      })
      .from(schema.faultCodes)
      .where(eq(schema.faultCodes.id, pick.id))
      .limit(1);

    const code = rows[0];
    if (!code) throw new UserFacingError("One of the fault codes no longer exists. Reload and try again.");
    if (code.kind !== pick.kind) {
      // A remedy recorded as a cause is silent nonsense in every later query:
      // it groups, it charts, and it is wrong.
      throw new UserFacingError(
        `"${code.label}" is a ${code.kind}, not a ${pick.kind}. Reload the job and choose again.`,
      );
    }
    if (!code.isActive) {
      throw new UserFacingError(`"${code.label}" has been retired. Choose a current ${pick.kind}.`);
    }
    // Null `service_slug` means every service, which is why this is not an
    // equality test: "no power at the isolator" is a symptom on any job.
    if (code.serviceSlug !== null && code.serviceSlug !== job.serviceSlug) {
      throw new UserFacingError(
        `"${code.label}" does not apply to ${job.serviceSlug} work. Reload the job and choose again.`,
      );
    }
  }

  // JOB-15, before anything is written. The transaction would roll back either
  // way, but checking here means the refusal names what the job card is
  // missing rather than arriving after a partial write, and it means a
  // *correction* to an already-complete job is never blocked by it: the gate
  // applies to the move into `work_complete`, not to editing what is recorded
  // about a job that already made the move.
  const willComplete = (input.completeWork ?? true) && status === "on_site";
  if (willComplete) await assertJobCardComplete(tx, input.jobId);

  await tx
    .update(schema.jobs)
    .set({ outcomeCode: outcome.code, updatedAt: new Date() })
    .where(eq(schema.jobs.id, input.jobId));

  // Replace rather than accumulate. Recording an outcome twice is a correction,
  // and a correction that leaves the first diagnosis in place would show a job
  // with two causes — which reads as a two-fault job to every report that
  // counts them.
  await tx.delete(schema.jobFaultCodes).where(eq(schema.jobFaultCodes.jobId, input.jobId));

  for (const pick of chosen) {
    await tx.insert(schema.jobFaultCodes).values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      visitId: input.visitId ?? null,
      faultCodeId: pick.id,
      kind: pick.kind,
      note: input.note ?? null,
      recordedById: ctx.userId ?? null,
    });
  }

  // The technician's own words go on the visit they belong to, beside the
  // codes rather than instead of them. `outcome_note` has existed since 0000
  // and, like `outcome_code`, nothing has ever written it.
  if (input.note && input.visitId) {
    await tx
      .update(schema.jobVisits)
      .set({ outcomeNote: input.note })
      .where(eq(schema.jobVisits.id, input.visitId));
  }

  let transitioned = false;
  if (willComplete) {
    await transitionJob(tx, ctx, {
      jobId: input.jobId,
      to: "work_complete",
      note: `Outcome: ${outcome.label}${input.note ? ` — ${input.note}` : ""}`,
    });
    transitioned = true;
  }

  return {
    outcomeCode: outcome.code,
    outcomeLabel: outcome.label,
    requiresReturnVisit: outcome.requiresReturnVisit,
    transitioned,
  };
}

/**
 * The three pickers a completion form needs, in one call.
 *
 * Scoped to the job's own service, because a picker with two hundred options is
 * a picker where everybody chooses the first entry — which is the failure mode
 * a controlled vocabulary is supposed to prevent, arriving by a different road.
 */
export async function faultCodeOptions(
  tx: TenantScopedTx,
  serviceSlug: string,
): Promise<Readonly<Record<FaultCodeKind, readonly { id: string; code: string; label: string }[]>>> {
  const rows = await tx
    .select({
      id: schema.faultCodes.id,
      kind: schema.faultCodes.kind,
      code: schema.faultCodes.code,
      label: schema.faultCodes.label,
      sortOrder: schema.faultCodes.sortOrder,
      serviceSlug: schema.faultCodes.serviceSlug,
    })
    .from(schema.faultCodes)
    .where(
      and(
        eq(schema.faultCodes.isActive, true),
        sql`(${schema.faultCodes.serviceSlug} is null or ${schema.faultCodes.serviceSlug} = ${serviceSlug})`,
      ),
    )
    .orderBy(asc(schema.faultCodes.sortOrder), asc(schema.faultCodes.label));

  const out: Record<FaultCodeKind, { id: string; code: string; label: string }[]> = {
    symptom: [],
    cause: [],
    remedy: [],
  };
  for (const row of rows) {
    const kind = row.kind as FaultCodeKind;
    if (!FAULT_CODE_KINDS.includes(kind)) continue;
    out[kind].push({ id: row.id, code: row.code, label: row.label });
  }
  return out;
}
