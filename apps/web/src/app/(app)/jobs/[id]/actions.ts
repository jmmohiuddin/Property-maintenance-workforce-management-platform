"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  withTenant,
  transitionJob,
  assignTechnician,
  recordJobOutcome,
  recordProductEvent,
  createQuote,
  reviseQuote,
  sendQuote,
  getQuoteForNotification,
  getVisitForNotification,
  createInvoiceFromJob,
  getInvoiceForNotification,
  jobContractScope,
  quoteOutOfScopeWork,
  raiseReturnVisit,
  ASSIGNMENT_WARNING_LABEL,
  recordJobAttachment,
  recordJobMaterial,
  declareNoMaterials,
  recordPhotoExemption,
  recordVisitLabour,
  type AssignmentWarningType,
  type DraftLine,
} from "@meridian/db";
import { enqueue, dispatchPending } from "@meridian/notify";
import { sendCustomerNotification } from "@/lib/customer-notifications";
import {
  amendJobSheet,
  materialiseInvoiceDocument,
  materialiseQuoteDocument,
  sealJobSheet,
} from "@meridian/docs";
import { MAX_OBJECT_BYTES, objectStore, sniffContentType } from "@meridian/files";
import {
  InvalidTransitionError,
  absoluteUrl,
  formatDuration,
  formatMoney,
  fromDubai,
  toMinor,
  type JobStatus,
} from "@meridian/core";
import { requirePermission } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Render and store the document a just-issued record stands for (`TRD §7.6`).
 *
 * ── WHY THIS IS OUTSIDE THE BUSINESS TRANSACTION, AND CANNOT FAIL THE ACTION ─
 *
 * The invoice is the legal event; the PDF is a copy of it. Rendering inside the
 * transaction would mean a missing Commercial Register number rolling back an
 * invoice for work that was genuinely supplied — which would leave the job
 * uninvoiced, the 14-day clock (`INV-5`) still running, and the AED 2,500 still
 * accruing. So the artefact is produced afterwards and a failure is reported
 * rather than thrown.
 *
 * Not producing it is a real gap, not a silent one: the reason comes back as a
 * sentence appended to the operator's confirmation, and it is the same list
 * `assertRenderable` would give them. And nothing is lost by the delay — the
 * download route materialises on first request, so the document appears as soon
 * as whatever was missing is configured.
 */
async function materialise(
  tenantId: string,
  userId: string,
  render: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>,
  context: string,
): Promise<string | null> {
  try {
    await withTenant({ tenantId, userId, actorKind: "user" }, render);
    return null;
  } catch (error) {
    return userMessage(
      error,
      "The document could not be produced; it will be generated the next time somebody downloads it.",
      context,
    );
  }
}

export interface ActionState {
  error?: string;
  ok?: string;
  /**
   * `QTE-9`. A quote was created or revised but at least one line describes
   * work outside the ten DET-licensed activities. Separate from `error`
   * because it never blocked the save — see `licensedActivityWarnings` in
   * `@meridian/db` for why quoting out-of-licence work is warned about rather
   * than refused.
   */
  warning?: string;
}

/**
 * Move a job to a new status.
 *
 * The transition graph is enforced in the domain layer, so an invalid move is
 * rejected here even though the UI only renders buttons for legal ones. The UI
 * is a convenience; this is the check.
 *
 * One move is not offered from here: `work_complete`. It is legal in the graph
 * and it stays legal — the cron sweeps and the field app will both need it —
 * but on this screen it goes through `recordOutcomeAction`, which cannot
 * complete the work without an outcome code (`JOB-13`). A job that reached
 * `work_complete` with a null outcome is a job whose outcome is unrecoverable,
 * and `G11` is computed from exactly that column.
 */
export async function changeStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const to = String(formData.get("to") ?? "") as JobStatus;
  const note = String(formData.get("note") ?? "").trim();

  if (to === "work_complete") {
    return {
      error:
        "Completing the work needs an outcome. Use the Outcome panel — it records what happened " +
        "and completes the job in one step.",
    };
  }

  try {
    requirePermission(session.principal, to === "closed" ? "jobs:close" : "jobs:update");
  } catch {
    return { error: "Your role cannot make this change." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        transitionJob(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, to, note: note || undefined },
        ),
    );
  } catch (error) {
    if (error instanceof InvalidTransitionError) return { error: error.message };
    return { error: userMessage(error, "Could not change status.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/dispatch");
  revalidatePath("/jobs");
  return { ok: "Status updated." };
}

/**
 * A `datetime-local` field, read as Dubai wall-clock time.
 *
 * The browser sends a naive `YYYY-MM-DDTHH:mm` with no zone in it, so somebody
 * has to decide what zone it meant. It meant the dispatcher's, and every
 * dispatcher of this system is in Asia/Dubai — which is UTC+4 with no daylight
 * saving, ever, so `fromDubai` is exact rather than approximate. Parsing it
 * with `new Date()` would instead use the SERVER's zone, and a server in UTC
 * would move every scheduled visit four hours earlier: an outdoor job booked
 * for 16:00 would be stored as 12:00 and land inside the summer midday ban.
 */
function dubaiDateTime(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!parts) return null;
  const [, year, month, day, hour, minute] = parts;
  return fromDubai(Number(year), Number(month), Number(day), Number(hour) * 60 + Number(minute));
}

/**
 * Assign a technician, creating a visit and dispatching the job.
 *
 * ── JOB-10: WHERE THE OVERRIDE IS ACTUALLY ENFORCED ────────────────────────
 *
 * Not here. This action collects the reason and passes it on; `assignTechnician`
 * recomputes the warnings inside the transaction and refuses the assignment if
 * one of them is unanswered. That split matters: a form rendered thirty seconds
 * ago does not know a certificate expired at midnight, so a check that lives in
 * the action — let alone in the browser — is an affordance rather than a
 * control. The TRD is explicit that the rule belongs in the domain layer.
 *
 * What this action owes the domain layer is the dispatcher's words, and the
 * warning they were looking at when they typed them.
 */
export async function assign(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const technicianId = String(formData.get("technicianId") ?? "");
  const score = Number(formData.get("score") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  const overrideWarningType = String(formData.get("overrideWarningType") ?? "").trim();
  const overrideReason = String(formData.get("overrideReason") ?? "").trim();
  const startRaw = String(formData.get("scheduledStart") ?? "").trim();
  const endRaw = String(formData.get("scheduledEnd") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:assign");
  } catch {
    return { error: "Your role cannot assign technicians." };
  }

  if (!technicianId) return { error: "Choose a technician." };

  const scheduledStart = startRaw ? dubaiDateTime(startRaw) : null;
  const scheduledEnd = endRaw ? dubaiDateTime(endRaw) : null;
  if (startRaw && !scheduledStart) return { error: "That start time could not be read." };
  if (endRaw && !scheduledEnd) return { error: "That end time could not be read." };
  if (scheduledStart && scheduledEnd && scheduledEnd <= scheduledStart) {
    return { error: "The visit has to end after it starts." };
  }

  let unreachable = false;
  let overrode: readonly { type: string; detail: string }[] = [];

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        const result = await assignTechnician(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            jobId,
            technicianId,
            scheduledStart: scheduledStart ?? undefined,
            scheduledEnd: scheduledEnd ?? undefined,
            // Recorded so the optimiser can later be measured against the
            // dispatcher rather than simply trusted.
            method: "suggested",
            score: Number.isFinite(score) ? score : undefined,
            reason: reason || undefined,
            overrideWarningType: overrideWarningType || undefined,
            overrideReason: overrideReason || undefined,
          },
        );
        overrode = result.overrode;
        const visitId = result.visitId;

        // Same transaction as the assignment: a technician is never told about
        // a visit that did not survive the commit.
        const detail = await getVisitForNotification(tx, visitId);
        if (!detail) return;

        const enqueued = await enqueue(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            channel: "email",
            template: "job_assigned",
            to: detail.technicianEmail ?? "",
            recipientUserId: detail.technicianUserId ?? undefined,
            subject: { table: "job_visits", id: visitId },
            payload: {
              technicianName: detail.technicianName,
              jobReference: detail.jobReference,
              jobTitle: detail.jobTitle,
              propertyName: detail.propertyName,
              propertyArea: detail.propertyArea,
              scheduledStart: detail.scheduledStart,
              accessInstructions: detail.accessInstructions,
            },
          },
        );
        if ("skipped" in enqueued) unreachable = true;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not assign.", "jobs") };
  }

  await dispatchPending(session.principal.tenantId);

  // JOB-10, the counting half. `job_visits.override_reason` is the record; this
  // is what makes the override countable in the weekly report without reading
  // every visit row. Best-effort and outside the transaction, per TRD 7.3: an
  // analytics write must never roll back a dispatch that has already happened.
  if (overrode.length > 0) {
    try {
      await withTenant(
        { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
        (tx) =>
          recordProductEvent(tx, {
            tenantId: session.principal.tenantId,
            eventName: "assignment_warning_overridden",
            entityType: "jobs",
            entityId: jobId,
            properties: {
              warnings: overrode.map((w) => w.type),
              technicianId,
            },
          }),
      );
    } catch {
      // Swallowed on purpose, and it is the only thing in this file that is.
      // The dispatch is done and the reason is on the visit; losing the
      // analytics row is a gap in a chart, not a gap in the record.
    }
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/dispatch");
  revalidatePath("/technicians");

  const overrideNote =
    overrode.length > 0
      ? ` Override recorded against ${overrode
          .map((w) => ASSIGNMENT_WARNING_LABEL[w.type as AssignmentWarningType] ?? w.type)
          .join(", ")
          .toLowerCase()}.`
      : "";

  return {
    ok:
      (unreachable
        ? "Assigned. No email went out — this technician has no address on file, so tell them by phone."
        : "Technician assigned and notified.") + overrideNote,
  };
}

/**
 * Record the outcome of the work and complete it (`JOB-13`, `JOB-14`).
 *
 * ── WHY COMPLETION LIVES HERE AND NOT ON THE STATUS BUTTONS ────────────────
 *
 * Because a job that reached `work_complete` without an outcome is a job whose
 * outcome is gone: nobody remembers in March what happened on a Tuesday in
 * January, and `G11` — first-time fix rate — has no numerator without it. The
 * status panel therefore stops offering "Work complete" as a bare move, and
 * this action is the only door. The domain layer holds the same line: the
 * transition happens inside `recordJobOutcome`, in the transaction that writes
 * the outcome, so the two states cannot disagree.
 *
 * `jobs:update` rather than a new permission. Recording what happened on a job
 * is updating a job, and inventing a permission for it would leave every
 * existing role unable to complete work until somebody remembered to grant it.
 */
export async function recordOutcomeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const outcomeCode = String(formData.get("outcomeCode") ?? "").trim();
  const visitId = String(formData.get("visitId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const symptomCodeId = String(formData.get("symptomCodeId") ?? "").trim();
  const causeCodeId = String(formData.get("causeCodeId") ?? "").trim();
  const remedyCodeId = String(formData.get("remedyCodeId") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot record job outcomes." };
  }

  if (!outcomeCode) return { error: "Choose what happened on the visit." };

  let label = "";
  let requiresReturnVisit = false;
  let transitioned = false;

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        const result = await recordJobOutcome(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            jobId,
            outcomeCode,
            visitId: visitId || null,
            note: note || null,
            symptomCodeId: symptomCodeId || null,
            causeCodeId: causeCodeId || null,
            remedyCodeId: remedyCodeId || null,
          },
        );
        label = result.outcomeLabel;
        requiresReturnVisit = result.requiresReturnVisit;
        transitioned = result.transitioned;
      },
    );
  } catch (error) {
    if (error instanceof InvalidTransitionError) return { error: error.message };
    return { error: userMessage(error, "Could not record the outcome.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/dispatch");
  revalidatePath("/jobs");

  // Three sentences for three different situations, because "saved" would hide
  // the one that still needs doing. An outcome that leaves work owing is the
  // requirement's actual point: no access and return-visit-required are a large
  // share of real visits and are not failures to be tidied away.
  const moved = transitioned ? " The job is now work complete and awaiting sign-off." : "";
  const owing = requiresReturnVisit
    ? " This outcome leaves work owing — assign a return visit."
    : "";
  return { ok: `Recorded as ${label}.${moved}${owing}` };
}

/**
 * Raise the return visit an outcome left owing (`JOB-13`'s `requiresReturnVisit`,
 * wired to `jobs.parent_job_id` / `jobs.is_revisit`).
 *
 * The gate lives in `raiseReturnVisit` itself, not here: it refuses unless the
 * job's own recorded outcome calls for one. This action only supplies who is
 * asking and which job, and reads the refusal back as a plain sentence — the
 * button that reaches this one is only ever offered by `outcome-panel.tsx`
 * when `recordedOutcome.requiresReturnVisit` is true, but the server check is
 * the actual control, matching every other guard in this file.
 */
export async function raiseReturnVisitAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const parentJobId = String(formData.get("jobId") ?? "");

  try {
    requirePermission(session.principal, "jobs:create");
  } catch {
    return { error: "Your role cannot raise a return visit." };
  }

  let reference = "";

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        const result = await raiseReturnVisit(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { parentJobId },
        );
        reference = result.reference;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not raise the return visit.", "jobs") };
  }

  revalidatePath(`/jobs/${parentJobId}`);
  revalidatePath("/jobs");
  revalidatePath("/dispatch");

  return {
    ok: `${reference} raised as a return visit for this job, and linked back to it.`,
  };
}

/** Create a draft quotation from the job detail panel. */
export async function createQuoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const title = String(formData.get("title") ?? "").trim();

  try {
    requirePermission(session.principal, "quotes:create");
  } catch {
    return { error: "Your role cannot create quotations." };
  }

  let lines: DraftLine[];
  try {
    // The client sends its line array as JSON in a hidden field. Parsed and
    // validated here rather than trusted: the totals are recomputed server-side
    // from these values, so a tampered payload changes the price.
    const parsed: unknown = JSON.parse(String(formData.get("lines") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    lines = parsed
      .map((l) => l as Record<string, unknown>)
      .filter((l) => String(l["description"] ?? "").trim() !== "")
      .map((l) => ({
        description: String(l["description"]).trim(),
        quantity: String(l["quantity"] ?? "1").trim() || "1",
        unit: String(l["unit"] ?? "ea").trim() || "ea",
        unitPrice: String(l["unitPrice"] ?? "0").trim() || "0",
      }));
  } catch {
    return { error: "Could not read the quote lines." };
  }

  if (lines.length === 0) return { error: "Add at least one line with a description." };
  if (!title) return { error: "Give the quotation a title." };

  let warnings: readonly string[] = [];

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        createQuote(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, title, lines },
        ),
    );
    warnings = result.warnings;
  } catch (error) {
    return { error: userMessage(error, "Could not create the quotation.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return {
    ok: "Draft quotation created. Send it when you are ready.",
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

/**
 * Quote work the contract does not cover (`CON-6`).
 *
 * ── WHY THIS IS A SEPARATE ACTION FROM `createQuoteAction` ─────────────────
 *
 * Because the price is not the operator's to set. `quoteOutOfScopeWork` applies
 * the contract's own discount, computed from the contract rather than typed
 * into the form, and refuses outright if the work turns out to be covered —
 * quoting covered work bills the customer twice for one entitlement. A plain
 * quote does neither of those things, so routing out-of-scope work through it
 * would lose both.
 *
 * The verdict is recomputed here from the OBSERVATIONS the form submits — which
 * exclusion was matched, whether parts were needed — and never from a verdict
 * the client claims. The page shows a verdict too; that one is a display, and
 * this is the decision.
 *
 * No notification and no product event, matching `createQuoteAction`: a draft
 * quote is not announced until `sendQuoteAction` sends it, and creating one
 * does not move the job's status. The audit row is written by the trigger on
 * `quotes`, `quote_lines` and `jobs` — all three are in the `audited` list in
 * sql/rls.sql — so there is nothing to record by hand.
 */
export async function quoteOutOfScopeAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  // Submitted so it can be checked, not so it can be trusted. See below.
  const claimedContractId = String(formData.get("contractId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const requiresParts = formData.get("requiresParts") !== null;
  const matchedExclusionCodes = formData
    .getAll("exclusionCode")
    .map((c) => String(c).trim())
    .filter((c) => c !== "");

  // The existing permission, deliberately. What this action produces IS a
  // quote, and `quotes:create` already says who may produce one.
  try {
    requirePermission(session.principal, "quotes:create");
  } catch {
    return { error: "Your role cannot create quotations." };
  }

  let lines: DraftLine[];
  try {
    // Same hand-parsed convention as `createQuoteAction` above. The totals are
    // recomputed server-side from these values, so a tampered payload changes
    // what is stored and not what is charged.
    const parsed: unknown = JSON.parse(String(formData.get("lines") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    lines = parsed
      .map((l) => l as Record<string, unknown>)
      .filter((l) => String(l["description"] ?? "").trim() !== "")
      .map((l) => ({
        description: String(l["description"]).trim(),
        quantity: String(l["quantity"] ?? "1").trim() || "1",
        unit: String(l["unit"] ?? "ea").trim() || "ea",
        unitPrice: String(l["unitPrice"] ?? "0").trim() || "0",
      }));
  } catch {
    return { error: "Could not read the quote lines." };
  }

  if (lines.length === 0) return { error: "Add at least one line with a description." };
  if (!title) return { error: "Give the quotation a title." };

  let reference = "";
  let totalMinor = 0;
  let wrongContract = false;

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        // The state check. The contract this job is actually linked to is read
        // from the job, and the hidden field is compared against it rather than
        // used — a tampered id would otherwise price the work at another
        // contract's discount and match another contract's exclusions.
        const scope = await jobContractScope(tx, jobId);
        if (!scope || scope.contractId !== claimedContractId) {
          wrongContract = true;
          return;
        }

        const result = await quoteOutOfScopeWork(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            contractId: scope.contractId,
            jobId,
            title,
            lines,
            // The observations, not a verdict. `quoteOutOfScopeWork` runs the
            // scope check itself on these and refuses if the answer is
            // "covered". The service comes from the job rather than the form
            // for the same reason the contract does.
            scope: { serviceSlug: scope.serviceSlug, matchedExclusionCodes, requiresParts },
          },
        );
        reference = result.reference;
        totalMinor = result.totalMinor;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not raise the out-of-scope quote.", "jobs") };
  }

  if (wrongContract) {
    return { error: "This job is not linked to that contract. Reload the page and try again." };
  }

  revalidatePath(`/jobs/${jobId}`);

  return {
    ok:
      `${reference} raised for ${formatMoney(totalMinor)} at the contract discount. The job is ` +
      "no longer contract-covered, so the invoice run will not skip it. Send the quotation when " +
      "you are ready.",
  };
}

/** Send a draft quote, making it visible and decidable in the customer portal. */
export async function sendQuoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const quoteId = String(formData.get("quoteId") ?? "");

  try {
    requirePermission(session.principal, "quotes:send");
  } catch {
    return { error: "Your role cannot send quotations." };
  }

  let queuedWithoutAddress = false;
  let optedOut = false;

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        await sendQuote(tx, quoteId);

        // Queued in the SAME transaction as the status change. If sendQuote
        // rolls back, the notification goes with it - we never tell a customer
        // about a quote that was not actually sent.
        const detail = await getQuoteForNotification(tx, quoteId);
        if (!detail) return;

        // POR-5, through the one door. This used to call `enqueue` directly
        // with `detail.customerEmail`, which got both halves wrong: it never
        // looked at the customer's preferences, so an account that had switched
        // quote emails off received every one of them (permanently, because the
        // ledger row it wrote made the quote look announced and the sweep never
        // revisited it); and it emailed the billing address alone, so a contact
        // flagged `notify_on_jobs` heard about the quote from the cron sweep
        // and never from the screen that actually sent it.
        const outcome = await sendCustomerNotification(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            event: "quote_awaiting_decision",
            customerId: detail.customerId,
            customerName: detail.customerName,
            subjectTable: "quotes",
            subjectId: quoteId,
            reference: detail.reference,
            title: detail.title,
            detail: null,
            amount: detail.total,
            currency: detail.currency,
            occursAt: null,
            occursEndAt: detail.validUntil,
          },
        );
        // Three distinct facts, kept apart. "Nothing queued and not muted" is
        // a missing email address, which is somebody's to fix; "muted" is the
        // customer's own choice and nobody's to fix.
        optedOut = outcome.muted;
        queuedWithoutAddress = !outcome.muted && outcome.queued === 0;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not send the quotation.", "jobs") };
  }

  // Delivery happens outside the transaction: a provider timing out must not
  // roll back the quote it was announcing.
  await dispatchPending(session.principal.tenantId);

  // QTE-3. Rendered at the moment of sending, because from here on the customer
  // can accept it — and what they accepted has to be the document that was in
  // front of them, not a re-render from whatever the price list says later.
  const documentProblem = await materialise(
    session.principal.tenantId,
    session.principal.userId,
    (tx) =>
      materialiseQuoteDocument(tx, quoteId, {
        acceptUrl: absoluteUrl(`/portal/quotes/${quoteId}`),
      }),
    "quote-document",
  );

  revalidatePath("/jobs");
  revalidatePath(`/jobs/${String(formData.get("jobId") ?? "")}`);

  // Three outcomes, three sentences. Telling an operator "the customer has been
  // emailed" when the customer switched quote emails off would be a lie they
  // would repeat to the customer.
  const sent = optedOut
    ? "Sent. It is visible in the customer portal. No email went out — this customer has switched off quotation emails."
    : queuedWithoutAddress
      ? "Sent. It is visible in the customer portal, but no email went out because this customer has no billing email on file."
      : "Sent. The customer has been emailed and can approve or decline it in their portal.";

  return { ok: documentProblem ? `${sent} ${documentProblem}` : sent };
}

/**
 * Raise a new version of a quote, retiring the old one (`QTE-10`).
 *
 * `reviseQuote` itself is the authority on which states may be revised — see
 * its docstring in `packages/db/src/domain/commerce.ts`. This action exists
 * only to read the session, parse the form and translate a refusal into a
 * sentence; `quotes:create` is the permission because what this produces IS a
 * new quote.
 */
export async function reviseQuoteAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const quoteId = String(formData.get("quoteId") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  try {
    requirePermission(session.principal, "quotes:create");
  } catch {
    return { error: "Your role cannot create quotations." };
  }

  let lines: DraftLine[];
  try {
    const parsed: unknown = JSON.parse(String(formData.get("lines") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    lines = parsed
      .map((l) => l as Record<string, unknown>)
      .filter((l) => String(l["description"] ?? "").trim() !== "")
      .map((l) => ({
        description: String(l["description"]).trim(),
        quantity: String(l["quantity"] ?? "1").trim() || "1",
        unit: String(l["unit"] ?? "ea").trim() || "ea",
        unitPrice: String(l["unitPrice"] ?? "0").trim() || "0",
      }));
  } catch {
    return { error: "Could not read the quote lines." };
  }

  if (lines.length === 0) return { error: "Add at least one line with a description." };

  let reference = "";
  let warnings: readonly string[] = [];

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        reviseQuote(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            quoteId,
            title: title || undefined,
            lines,
            reason: reason || undefined,
          },
        ),
    );
    reference = result.reference;
    warnings = result.warnings;
  } catch (error) {
    return { error: userMessage(error, "Could not revise the quotation.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);

  return {
    ok: `${reference} raised as the new version. The previous quote is kept on file, marked superseded.`,
    warning: warnings.length > 0 ? warnings.join(" ") : undefined,
  };
}

/**
 * Raise the invoice for a signed-off job.
 *
 * The domain refuses to invoice work the customer has not signed for, so this
 * action can be offered optimistically and let the guard speak for itself.
 */
export async function raiseInvoiceAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");

  try {
    requirePermission(session.principal, "invoices:create");
  } catch {
    return { error: "Your role cannot raise invoices." };
  }

  let lines: DraftLine[];
  try {
    const parsed: unknown = JSON.parse(String(formData.get("lines") ?? "[]"));
    if (!Array.isArray(parsed)) throw new Error("not an array");
    lines = parsed
      .map((l) => l as Record<string, unknown>)
      .filter((l) => String(l["description"] ?? "").trim() !== "")
      .map((l) => ({
        description: String(l["description"]).trim(),
        quantity: String(l["quantity"] ?? "1").trim() || "1",
        unit: String(l["unit"] ?? "ea").trim() || "ea",
        unitPrice: String(l["unitPrice"] ?? "0").trim() || "0",
      }));
  } catch {
    return { error: "Could not read the invoice lines." };
  }

  if (lines.length === 0) return { error: "Add at least one line with a description." };

  let reference = "";
  let invoiceId = "";
  let unreachable = false;
  let optedOut = false;

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        const invoice = await createInvoiceFromJob(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, lines },
        );
        reference = invoice.reference;
        invoiceId = invoice.invoiceId;

        // The invoice is created already issued, so the customer must hear about
        // it in the same transaction that created it — through
        // `sendCustomerNotification`, which is the only thing that knows
        // whether they want to hear about it and who at the account to tell.
        // Sending from here without asking was the whole of the POR-5 bug: this
        // is the highest-volume of the seven events, and an opted-out customer
        // received every invoice email permanently, because the ledger row this
        // wrote also told the sweep the invoice had been announced.
        const detail = await getInvoiceForNotification(tx, invoice.invoiceId);
        if (!detail) return;

        const outcome = await sendCustomerNotification(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            event: "invoice_issued",
            customerId: detail.customerId,
            customerName: detail.customerName,
            subjectTable: "invoices",
            subjectId: invoice.invoiceId,
            // The sweep uses the reference for both, because an invoice has no
            // title of its own. Matched here so the two paths produce the same
            // email rather than two similar ones.
            reference: detail.reference,
            title: detail.reference,
            detail: null,
            amount: detail.total,
            currency: detail.currency,
            occursAt: detail.dueOn,
            occursEndAt: null,
          },
        );
        optedOut = outcome.muted;
        unreachable = !outcome.muted && outcome.queued === 0;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not raise the invoice.", "jobs") };
  }

  await dispatchPending(session.principal.tenantId);

  // INV-3. The tax invoice is created already issued, so the artefact is
  // produced now rather than left until somebody asks for it — the document is
  // what the customer's accounts department files, and the SHA-256 recorded
  // against it is what makes a reprint two years from now provably the same
  // document.
  const documentProblem = await materialise(
    session.principal.tenantId,
    session.principal.userId,
    (tx) => materialiseInvoiceDocument(tx, invoiceId),
    "invoice-document",
  );

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/invoices");
  revalidatePath("/portal");

  const raised = optedOut
    ? `${reference} raised. No email went out — this customer has switched off invoice emails. It is in their portal.`
    : unreachable
      ? `${reference} raised. No email went out — this customer has no billing email on file.`
      : `${reference} raised and emailed to the customer.`;

  return { ok: documentProblem ? `${raised} ${documentProblem}` : raised };
}

// ── The job card (JOB-15) ───────────────────────────────────────────────────

/**
 * Capture, so the gate can be satisfied by somebody who is not in a plant room.
 *
 * `JOB-15`'s four conditions are enforced in `assertJobCardComplete`, which is
 * in the domain layer where the field app (`M11`) will reach it. These actions
 * are the web half: without them the gate would be a wall, because nothing in
 * this application has ever written `job_attachments`, `job_materials`,
 * `job_signoffs` or `job_visits.work_minutes`.
 *
 * Every one follows the shape the file already uses — `FormData` read by hand
 * rather than through zod, matching `recordOutcomeAction` above rather than
 * introducing a second convention for one action.
 */

/** A minutes field, read from a text input. Null when it is not a number. */
function wholeMinutes(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^\d{1,4}$/.test(trimmed)) return null;
  return Number(trimmed);
}

/**
 * Store an uploaded image and file it against the job.
 *
 * The bytes go to `packages/files` first and the row afterwards, the same order
 * the careers page uses. A failure between the two leaves an object with no
 * row, which the retention sweep already looks for; the other order would leave
 * a row pointing at bytes that are not there, and that is the failure that
 * shows an operator a broken photograph on a signed job card.
 */
async function storeJobImage(
  jobId: string,
  prefix: string,
  file: File | null,
): Promise<{ key: string; contentType: string; sizeBytes: number } | { error: string }> {
  if (!file || file.size === 0) return { error: "Choose a photograph to upload." };
  if (file.size > MAX_OBJECT_BYTES) {
    return { error: "That image is larger than 25 MB. Send a smaller one." };
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = sniffContentType(bytes);
  if (!contentType || !contentType.startsWith("image/")) {
    // Sniffed from the bytes, never taken from the browser's word. A file the
    // sniffer does not recognise is refused rather than stored as "probably a
    // photo" — see the note at the top of `packages/files/src/sniff.ts`.
    return { error: "That file is not an image this system can store. Send a PNG, JPEG or HEIC." };
  }

  const key = `jobs/${jobId}/${prefix}-${randomUUID()}.${contentType.split("/")[1]}`;
  const stored = await objectStore().put({ key, body: bytes, declaredContentType: contentType });
  return { key: stored.key, contentType: stored.contentType, sizeBytes: stored.sizeBytes };
}

export async function uploadJobPhotoAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const visitId = String(formData.get("visitId") ?? "").trim();
  const caption = String(formData.get("caption") ?? "").trim();
  const kindRaw = String(formData.get("kind") ?? "photo_after").trim();

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot add photographs to a job." };
  }

  if (kindRaw !== "photo_after" && kindRaw !== "photo_before") {
    return { error: "A job photograph is either a before or an after shot." };
  }
  const kind: "photo_after" | "photo_before" = kindRaw;

  const file = formData.get("photo");
  const stored = await storeJobImage(
    jobId,
    kind === "photo_after" ? "after" : "before",
    file instanceof File ? file : null,
  );
  if ("error" in stored) return { error: stored.error };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        recordJobAttachment(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            jobId,
            visitId: visitId || null,
            kind,
            storageKey: stored.key,
            mimeType: stored.contentType,
            sizeBytes: stored.sizeBytes,
            caption: caption || null,
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not attach that photograph.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: kind === "photo_after" ? "After photograph attached." : "Before photograph attached." };
}

export async function exemptAfterPhotoAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const reasonCode = String(formData.get("reasonCode") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot exempt a job from the photograph requirement." };
  }

  if (!reasonCode) return { error: "Choose the reason there is no photograph." };

  let label = "";
  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        const result = await recordPhotoExemption(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, reasonCode, note: note || null },
        );
        label = result.reasonLabel;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the exemption.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: `Recorded: no after photograph — ${label}.` };
}

export async function addJobMaterialAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const visitId = String(formData.get("visitId") ?? "").trim();
  const sku = String(formData.get("sku") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const quantity = String(formData.get("quantity") ?? "").trim();
  const unit = String(formData.get("unit") ?? "").trim();
  const unitCost = String(formData.get("unitCost") ?? "").trim();
  const isBillable = String(formData.get("isBillable") ?? "") === "on";

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot record materials." };
  }

  if (!description) return { error: "Name the part or consumable." };
  if (!/^\d+(\.\d{1,3})?$/.test(quantity)) {
    return { error: "Quantity is a number, to at most three decimal places." };
  }
  if (unitCost && !/^\d+(\.\d{1,2})?$/.test(unitCost)) {
    return { error: "Unit cost is an amount in AED, to at most two decimal places." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        recordJobMaterial(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            jobId,
            visitId: visitId || null,
            sku: sku || null,
            description,
            quantity,
            unit: unit || "ea",
            // Minor units all the way down. The form collects AED because that
            // is what a person reads off a delivery note.
            unitCostMinor: unitCost ? toMinor(unitCost) : null,
            isBillable,
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record that material.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: `Recorded ${quantity} ${unit || "ea"} of ${description}.` };
}

export async function declareNoMaterialsAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const note = String(formData.get("note") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot record materials." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        declareNoMaterials(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, note: note || null },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record that no materials were used.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: "Recorded: no parts or consumables were used." };
}

export async function recordLabourAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const visitId = String(formData.get("visitId") ?? "").trim();
  const workMinutes = wholeMinutes(String(formData.get("workMinutes") ?? ""));
  const travelMinutes = wholeMinutes(String(formData.get("travelMinutes") ?? ""));

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot record labour time." };
  }

  if (!visitId) return { error: "Labour time is recorded against a visit." };
  if (workMinutes === null) {
    // Zero is accepted deliberately: a visit that never reached the work spent
    // no time on the tools, and demanding a positive number would collect a
    // made-up one. Empty is what is refused.
    return { error: "Enter the time on the tools, in whole minutes. Zero is a valid answer." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        recordVisitLabour(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, visitId, workMinutes, travelMinutes },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the labour time.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: `Recorded ${formatDuration(workMinutes)} on the tools.` };
}

/**
 * Take the customer's signature, and seal the job sheet with it (`FLD-14`).
 *
 * ── WHY THIS IS ONE ACTION AND NOT TWO ──────────────────────────────────────
 *
 * There used to be a `captureSignatureAction` that stored an image and a name
 * and did nothing else, and the field app's own source described what that was
 * worth: *"a signature captured by this app today would prove that somebody
 * drew on a screen and nothing about what they were agreeing to."* Leaving that
 * path in place beside a sealing one would leave two ways to sign a job, one of
 * which produces evidence and one of which does not — and the one that does not
 * is the easier call to make.
 *
 * So there is one path. It renders the sheet, hashes it, stores an immutable
 * snapshot, writes the signature, locks the card and queues the customer's copy
 * — all inside a single transaction, in `sealJobSheet`.
 *
 * ── WHAT `presentedSha256` IS DOING IN A FORM ───────────────────────────────
 *
 * It is the digest of the sheet **this page displayed**. The server re-derives
 * it from the record at the moment of signing and refuses if the two differ.
 * Without it, an operator could have the sheet open in one tab while somebody
 * else adds a part in another, and the signature would be recorded against a
 * document nobody ever saw. The refusal says to show the sheet again, which is
 * the correct instruction rather than an apology.
 */
export async function captureSignatureAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const visitId = String(formData.get("visitId") ?? "").trim();
  const signedByName = String(formData.get("signedByName") ?? "").trim();
  const signedByRole = String(formData.get("signedByRole") ?? "").trim();
  const signerEmail = String(formData.get("signerEmail") ?? "").trim();
  const comments = String(formData.get("comments") ?? "").trim();
  const ratingRaw = String(formData.get("satisfactionRating") ?? "").trim();
  const presentedSha256 = String(formData.get("presentedSha256") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot capture a sign-off." };
  }

  if (!signedByName) return { error: "Record the name of the person signing." };
  if (!presentedSha256) {
    return {
      error:
        "This form was opened before the job sheet was ready. Reload the job and open the sheet " +
        "again — a signature has to be given to a sheet somebody has seen.",
    };
  }
  const satisfactionRating = ratingRaw ? Number(ratingRaw) : null;
  if (satisfactionRating !== null && !Number.isInteger(satisfactionRating)) {
    return { error: "A satisfaction rating is a whole number from one to five." };
  }

  const file = formData.get("signature");
  const stored = await storeJobImage(jobId, "signature", file instanceof File ? file : null);
  if ("error" in stored) {
    return { error: "Attach the signature image — a name alone is not a signature." };
  }

  let sealed: Awaited<ReturnType<typeof sealJobSheet>>;
  try {
    sealed = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        sealJobSheet(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            jobId,
            visitId: visitId || null,
            signedByName,
            signedByRole: signedByRole || null,
            signerEmail: signerEmail || null,
            signatureStorageKey: stored.key,
            satisfactionRating,
            comments: comments || null,
            presentedSha256,
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record the sign-off.", "jobs") };
  }

  // Outside the transaction, deliberately. A provider timing out must not roll
  // back a signature that has already been given — the ledger row is queued
  // either way and the next drain picks it up.
  await dispatchPending(session.principal.tenantId);

  revalidatePath(`/jobs/${jobId}`);
  return {
    ok:
      `Signed by ${signedByName}. Job sheet ${sealed.reference} is sealed and the job card is ` +
      `now locked.` + (sealed.copyProblem ? ` ${sealed.copyProblem}` : " A copy has been emailed."),
  };
}

/**
 * Correct a signed job sheet, without touching it (`FLD-14`).
 *
 * The card stays locked and the original sheet stays on file with its digest
 * intact. What this produces is a second document that says what was wrong and
 * what the position now is. That is the whole of "corrections happen only as a
 * new, linked, reason-coded amendment" — an unlock-and-edit would leave the
 * copy in the customer's inbox evidencing a position the business no longer
 * holds.
 */
export async function amendJobSheetAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const reasonCode = String(formData.get("reasonCode") ?? "").trim();
  const detail = String(formData.get("detail") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:update");
  } catch {
    return { error: "Your role cannot amend a signed job sheet." };
  }

  if (!reasonCode) return { error: "Choose why the sheet is being amended." };

  try {
    const amendment = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        amendJobSheet(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, reasonCode, detail },
        ),
    );
    revalidatePath(`/jobs/${jobId}`);
    return {
      ok: `Amendment ${amendment.reference} raised. The signed sheet is unchanged, as it must be.`,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not raise the amendment.", "jobs") };
  }
}

