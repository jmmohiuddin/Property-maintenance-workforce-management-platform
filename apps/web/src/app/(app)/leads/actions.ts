"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withTenant, convertLeadToJob } from "@meridian/db";
import { priorityForUrgency } from "@meridian/core";
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
