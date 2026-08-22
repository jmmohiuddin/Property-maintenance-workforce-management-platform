"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  withTenant,
  convertLeadToJob,
  convertCustomerCandidates,
  setLeadStage,
  logCommunication,
  setLeadFollowUp,
  linkDuplicateLead,
} from "@meridian/db";
import {
  priorityForUrgency,
  isCommunicationChannel,
  isCommunicationOutcome,
  LEAD_STAGE_LABEL,
  type LeadStage,
} from "@meridian/core";
import { STAGE_CHOICES } from "./stage-choices";
import { requirePermission } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface ConvertState {
  error?: string;
}

/** One customer this lead might already be, as the convert form renders it. */
export interface ConvertCandidateView {
  customerId: string;
  name: string;
  phone: string | null;
  email: string | null;
  isStrict: boolean;
  isLinked: boolean;
}

export interface CandidateState {
  candidates?: ConvertCandidateView[];
  error?: string;
}

/**
 * The customers this lead may already be (`LEAD-5`), for the convert form.
 *
 * Loaded when the form is opened rather than with the list. A leads page shows
 * twenty-five rows and somebody converts one of them; running the matcher for
 * all twenty-five to answer a question about one is twenty-four indexed queries
 * nobody reads. Opening the form is the moment the answer is needed, and it is
 * before the decision rather than after it.
 *
 * This is a convenience, not the guard. `convertLeadToJob` runs the same check
 * inside the transaction that creates the customer, so a form that never called
 * this — or called it and was overtaken — is refused there.
 */
export async function loadConvertCandidates(leadId: string): Promise<CandidateState> {
  const session = await requireSession();

  try {
    requirePermission(session.principal, "customers:read");
  } catch {
    return { error: "Your role cannot read customers." };
  }

  if (!leadId) return { error: "No lead selected." };

  try {
    const candidates = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) => convertCustomerCandidates(tx, leadId),
    );
    return { candidates: candidates.map((c) => ({ ...c })) };
  } catch (error) {
    return { error: userMessage(error, "Could not check for existing customers.", "leads") };
  }
}

/**
 * Convert a lead into a customer, property and job.
 *
 * Permission is checked here, not only in the UI. The page hides this form for
 * roles that cannot convert, but hiding a form is not authorisation - a POST
 * can be sent directly.
 *
 * `customerId` and `createNewCustomer` are the operator's answer to the
 * duplicate check (`LEAD-5`), and neither is inferred here: an absent answer is
 * passed on as an absent answer so the domain refuses it. Defaulting
 * `createNewCustomer` to true in this layer would silently restore the bug the
 * check exists to stop.
 */
export async function convertLead(_prev: ConvertState, formData: FormData): Promise<ConvertState> {
  const session = await requireSession();

  try {
    requirePermission(session.principal, "jobs:create");
    requirePermission(session.principal, "customers:write");
  } catch {
    return { error: "Your role cannot convert leads." };
  }

  const leadId = String(formData.get("leadId") ?? "");
  const propertyName = String(formData.get("propertyName") ?? "").trim();
  const addressLine = String(formData.get("addressLine") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const urgency = String(formData.get("urgency") ?? "this-week");
  const customerId = String(formData.get("customerId") ?? "").trim();
  const createNewCustomer = formData.get("createNewCustomer") === "1";

  if (!leadId || !propertyName || !addressLine || !title) {
    return { error: "Property name, address and job title are all required." };
  }

  let jobId: string;
  try {
    const result = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) =>
        convertLeadToJob(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            leadId,
            propertyName,
            addressLine,
            title,
            priority: priorityForUrgency(urgency),
            customerId: customerId || undefined,
            createNewCustomer,
          },
        ),
    );
    jobId = result.jobId;
  } catch (error) {
    return { error: userMessage(error, "Conversion failed.", "leads") };
  }

  revalidatePath("/leads");
  revalidatePath("/customers");
  revalidatePath("/dispatch");
  redirect(`/jobs/${jobId}`);
}

export interface StageState {
  error?: string;
  success?: string;
}

/**
 * Move a lead through the funnel (`LEAD-6`).
 *
 * The reason for a lost or dormant lead is not validated here. It is validated
 * in `setLeadStage`, which resolves it against the tenant's own list and
 * refuses the change if it is retired, missing or belongs to the other stage —
 * and behind that, the database refuses the row outright. Repeating the rule in
 * this action would give it two homes and eventually two behaviours; what this
 * layer owns is permission, and turning the domain's refusal into a sentence.
 */
export async function changeLeadStage(
  _prev: StageState,
  formData: FormData,
): Promise<StageState> {
  const session = await requireSession();

  try {
    requirePermission(session.principal, "customers:write");
  } catch {
    return { error: "Your role cannot change a lead's stage." };
  }

  const leadId = String(formData.get("leadId") ?? "");
  const stage = String(formData.get("stage") ?? "");
  const dispositionReasonId = String(formData.get("dispositionReasonId") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!leadId) return { error: "No lead selected." };
  // Won is absent deliberately: a lead becomes won by being converted, which
  // creates the customer, the property and the job in one transaction. A stage
  // dropdown that could set it would produce won leads with nothing behind them.
  if (!STAGE_CHOICES.some((choice) => choice.value === stage)) {
    return { error: "That is not a stage a lead can be moved to here." };
  }

  try {
    await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) =>
        setLeadStage(tx, leadId, stage as LeadStage, {
          dispositionReasonId: dispositionReasonId || undefined,
          note: note || undefined,
        }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not change the stage.", "leads") };
  }

  revalidatePath("/leads");
  return { success: `Moved to ${LEAD_STAGE_LABEL[stage as LeadStage]}.` };
}

// ── LEAD-9. The communications log ──────────────────────────────────────────

export interface LogState {
  error?: string;
  success?: string;
}

/**
 * Log a call, a message or a visit against a lead (`LEAD-9`).
 *
 * ── ONE CLICK AND ONE SENTENCE ─────────────────────────────────────────────
 *
 * That phrase is in the requirement and it is the acceptance criterion. The
 * `communications` table has existed since the first migration and has never
 * held a row, which is what happens to a log that costs more than writing on a
 * pad. So the only required field here is the sentence: channel defaults,
 * direction defaults, the time defaults to now, and the follow-up date is
 * derived from the outcome rather than asked for.
 *
 * The follow-up default is the part that earns its keep. A call logged with no
 * next step is a lead dropped by accident, and asking for a date is the second
 * click that stops the first one happening.
 */
export async function logLeadCommunication(
  _prev: LogState,
  formData: FormData,
): Promise<LogState> {
  const session = await requireSession();

  try {
    requirePermission(session.principal, "customers:write");
  } catch {
    return { error: "Your role cannot log communications." };
  }

  const leadId = String(formData.get("leadId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  const channel = String(formData.get("channel") ?? "call");
  const direction = String(formData.get("direction") ?? "outbound");
  const outcome = String(formData.get("outcome") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!leadId && !customerId) return { error: "Nothing selected to log against." };
  if (!body) return { error: "Say what happened, in a sentence." };

  // Every coded field is narrowed before it reaches the domain. These arrive
  // from a form post, and the database CHECK behind them raises a constraint
  // violation nobody can act on — narrowing turns that into a sentence, and
  // makes the value the right union type for the rest of the path.
  if (!isCommunicationChannel(channel)) return { error: "Pick how you contacted them." };
  // Narrowed to the union here rather than checked and then passed as a string:
  // the point of the guard is that everything downstream has the type, and
  // `outcome || undefined` after a boolean check keeps `string`.
  if (outcome !== "" && !isCommunicationOutcome(outcome)) {
    return { error: "Pick what came of it." };
  }
  const codedOutcome = outcome === "" ? undefined : outcome;

  try {
    await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) =>
        logCommunication(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            leadId: leadId || undefined,
            customerId: customerId || undefined,
            channel,
            direction: direction === "inbound" ? "inbound" : "outbound",
            body,
            outcome: codedOutcome,
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not log that.", "leads") };
  }

  // Only what this touched. A customer-side log has nothing to say to the leads
  // list, and revalidating it would throw away a cached page to no effect.
  if (leadId) {
    revalidatePath("/leads");
    revalidatePath(`/leads/${leadId}`);
  }
  if (customerId) revalidatePath(`/customers/${customerId}`);
  return { success: "Logged." };
}

/**
 * Set or clear a lead's follow-up date.
 *
 * An empty date clears it, deliberately and visibly. "No follow-up" is a valid
 * decision — it is what `not_interested` means — and the alternative is a lead
 * carrying a date nobody intends to act on, which is what makes an overdue
 * queue stop being read.
 */
export async function setFollowUp(_prev: LogState, formData: FormData): Promise<LogState> {
  const session = await requireSession();

  try {
    requirePermission(session.principal, "customers:write");
  } catch {
    return { error: "Your role cannot change follow-ups." };
  }

  const leadId = String(formData.get("leadId") ?? "");
  const raw = String(formData.get("nextFollowUpAt") ?? "").trim();
  if (!leadId) return { error: "No lead selected." };

  let next: Date | null = null;
  if (raw) {
    // `<input type="date">` yields "2026-08-24", which `new Date()` reads as
    // midnight UTC — 04:00 in Dubai. That is the right end of the day to land
    // on for a follow-up queue read in the morning, and it is stated here
    // because the alternative reading (04:00 the previous day) is what happens
    // if this is ever "corrected" to a local-time constructor.
    next = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(next.getTime())) return { error: "That is not a date." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) => setLeadFollowUp(tx, leadId, next),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not set the follow-up.", "leads") };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return { success: next ? "Follow-up set." : "Follow-up cleared." };
}

// ── LEAD-5. Merge or link ───────────────────────────────────────────────────

/**
 * Record that this enquiry is one we already have (`LEAD-5`).
 *
 * ── WHY THIS IS A LINK AND NOT A MERGE ─────────────────────────────────────
 *
 * A merge copies fields, repoints children and deletes a row, and at least one
 * part of it is always wrong: the older record has the better address, the
 * newer one has the current phone. Both rows stay here. The duplicate points at
 * the original, the communications log follows the pointer so the history
 * arrives with the enquiry, and the pipeline stops double-counting because the
 * duplicate is closed with a coded reason.
 *
 * A wrong link is undone by clearing a column. A wrong merge is undone from a
 * backup.
 */
export async function linkDuplicate(_prev: LogState, formData: FormData): Promise<LogState> {
  const session = await requireSession();

  try {
    requirePermission(session.principal, "customers:write");
  } catch {
    return { error: "Your role cannot link leads." };
  }

  const leadId = String(formData.get("leadId") ?? "");
  const duplicateOfLeadId = String(formData.get("duplicateOfLeadId") ?? "").trim();
  const matchedCustomerId = String(formData.get("matchedCustomerId") ?? "").trim();
  const dispositionReasonId = String(formData.get("dispositionReasonId") ?? "").trim();

  if (!leadId) return { error: "No lead selected." };
  if (!duplicateOfLeadId && !matchedCustomerId) {
    return { error: "Choose the lead or the customer this is a duplicate of." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        linkDuplicateLead(tx, {
          leadId,
          duplicateOfLeadId: duplicateOfLeadId || undefined,
          matchedCustomerId: matchedCustomerId || undefined,
          dispositionReasonId: dispositionReasonId || undefined,
        }),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not link that.", "leads") };
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${leadId}`);
  return { success: dispositionReasonId ? "Linked and closed as a duplicate." : "Linked." };
}
