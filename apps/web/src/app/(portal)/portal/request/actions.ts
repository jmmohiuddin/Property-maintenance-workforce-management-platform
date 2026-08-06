"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withCustomerScope, createPortalRequest } from "@meridian/db";
import { getService, priorityForUrgency, type JobPriority } from "@meridian/core";
import { enqueue, dispatchPending } from "@meridian/notify";
import { requirePortalSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface RequestState {
  error?: string;
}

/**
 * Raise a job from the portal.
 *
 * The customer's chosen urgency is a *request*, not a setting: it maps to a
 * priority which operations may revise at triage. Letting a customer set their
 * own SLA would make every request a P1.
 */
export async function raiseRequest(_prev: RequestState, formData: FormData): Promise<RequestState> {
  const session = await requirePortalSession();

  const propertyId = String(formData.get("propertyId") ?? "");
  const serviceSlug = String(formData.get("serviceSlug") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const urgency = String(formData.get("urgency") ?? "this-week");

  if (!propertyId) return { error: "Choose which property this is about." };
  if (!getService(serviceSlug)) return { error: "Choose what kind of work it is." };
  if (title.length < 5) return { error: "Give us a short description of the problem." };

  // Emergencies must go to the phone line, not a form nobody is watching at 2am.
  const requestedPriority: JobPriority =
    urgency === "emergency" ? "p2_urgent" : priorityForUrgency(urgency);

  let reference: string;

  try {
    const result = await withCustomerScope(
      {
        tenantId: session.principal.tenantId,
        customerId: session.customerId,
        userId: session.principal.userId,
        actorKind: "customer",
      },
      async (tx) => {
        const created = await createPortalRequest(
          tx,
          {
            tenantId: session.principal.tenantId,
            customerId: session.customerId,
            userId: session.principal.userId,
          },
          { propertyId, serviceSlug, title, description: description || undefined, requestedPriority },
        );

        await enqueue(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            channel: "email",
            template: "request_received",
            to: session.user.email,
            recipientUserId: session.principal.userId,
            subject: { table: "jobs", id: created.jobId },
            payload: {
              customerName: session.user.fullName,
              jobReference: created.reference,
              jobTitle: title,
            },
          },
        );

        return created;
      },
    );
    reference = result.reference;
  } catch (error) {
    return { error: userMessage(error, "Could not raise the request.", "request") };
  }

  await dispatchPending(session.principal.tenantId);

  revalidatePath("/portal");
  revalidatePath("/dispatch");
  redirect(`/portal?raised=${encodeURIComponent(reference)}`);
}
