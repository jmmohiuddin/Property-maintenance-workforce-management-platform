"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  transitionJob,
  assignTechnician,
  createQuote,
  sendQuote,
  getQuoteForNotification,
  getVisitForNotification,
  createInvoiceFromJob,
  getInvoiceForNotification,
  jobContractScope,
  quoteOutOfScopeWork,
  type DraftLine,
} from "@meridian/db";
import { enqueue, dispatchPending } from "@meridian/notify";
import { sendCustomerNotification } from "@/lib/customer-notifications";
import { materialiseInvoiceDocument, materialiseQuoteDocument } from "@meridian/docs";
import { InvalidTransitionError, absoluteUrl, formatMoney, type JobStatus } from "@meridian/core";
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
}

/**
 * Move a job to a new status.
 *
 * The transition graph is enforced in the domain layer, so an invalid move is
 * rejected here even though the UI only renders buttons for legal ones. The UI
 * is a convenience; this is the check.
 */
export async function changeStatus(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const to = String(formData.get("to") ?? "") as JobStatus;
  const note = String(formData.get("note") ?? "").trim();

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

/** Assign a technician, creating a visit and dispatching the job. */
export async function assign(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const jobId = String(formData.get("jobId") ?? "");
  const technicianId = String(formData.get("technicianId") ?? "");
  const score = Number(formData.get("score") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  try {
    requirePermission(session.principal, "jobs:assign");
  } catch {
    return { error: "Your role cannot assign technicians." };
  }

  if (!technicianId) return { error: "Choose a technician." };

  let unreachable = false;

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      async (tx) => {
        const { visitId } = await assignTechnician(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            jobId,
            technicianId,
            // Recorded so the optimiser can later be measured against the
            // dispatcher rather than simply trusted.
            method: "suggested",
            score: Number.isFinite(score) ? score : undefined,
            reason: reason || undefined,
          },
        );

        // Same transaction as the assignment: a technician is never told about
        // a visit that did not survive the commit.
        const detail = await getVisitForNotification(tx, visitId);
        if (!detail) return;

        const result = await enqueue(
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
        if ("skipped" in result) unreachable = true;
      },
    );
  } catch (error) {
    return { error: userMessage(error, "Could not assign.", "jobs") };
  }

  await dispatchPending(session.principal.tenantId);

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/dispatch");
  revalidatePath("/technicians");
  return {
    ok: unreachable
      ? "Assigned. No email went out — this technician has no address on file, so tell them by phone."
      : "Technician assigned and notified.",
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

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        createQuote(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { jobId, title, lines },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not create the quotation.", "jobs") };
  }

  revalidatePath(`/jobs/${jobId}`);
  return { ok: "Draft quotation created. Send it when you are ready." };
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
