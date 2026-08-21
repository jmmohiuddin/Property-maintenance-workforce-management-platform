"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant, convertLeadToJob, setLeadStage } from "@meridian/db";
import { priorityForUrgency, LEAD_STAGE_LABEL, type LeadStage } from "@meridian/core";
import { STAGE_CHOICES } from "./stage-choices";
import { requirePermission } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface ConvertState {
  error?: string;
}

/**
 * Convert a lead into a customer, property and job.
 *
 * Permission is checked here, not only in the UI. The page hides this form for
 * roles that cannot convert, but hiding a form is not authorisation - a POST
 * can be sent directly.
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
          },
        ),
    );
    jobId = result.jobId;
  } catch (error) {
    return { error: userMessage(error, "Conversion failed.", "leads") };
  }

  revalidatePath("/leads");
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
