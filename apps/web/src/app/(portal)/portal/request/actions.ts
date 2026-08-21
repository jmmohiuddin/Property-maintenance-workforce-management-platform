"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withCustomerScope, createPortalRequest, customerAccountName } from "@meridian/db";
import { getService, priorityForUrgency, type JobPriority } from "@meridian/core";
import { dispatchPending } from "@meridian/notify";
import { sendCustomerNotification } from "@/lib/customer-notifications";
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

        // ── WHO HEARS ABOUT THIS, AND WHY IT IS NOT THE PERSON WHO ASKED ────
        //
        // This used to go to `session.user.email` — the portal login's own
        // address — while the sweep sent the same event to the account's
        // notify-flagged contacts and its billing address. Two recipient rules
        // for one event, and the account-level one is the right one: `POR-5` is
        // a preference held by the *customer*, not by whoever happens to be
        // signed in, and the person raising a request from a shared handover
        // account is very often not the person who wants the paperwork. The
        // codebase already argued this, in `customerNotificationRecipients`: a
        // portal login is an identity for reading the account, not a
        // subscription, and someone who could only stop these emails by giving
        // up their access has not really been given the choice `POR-5`
        // promises.
        //
        // Nothing is lost to the requester: the confirmation with the reference
        // is on the screen they land on before any email would have arrived.
        //
        // `sendCustomerNotification` is the one door. It consults the opt-out,
        // resolves the same recipients the sweep would, and enqueues inside
        // this transaction so a request that rolls back is never acknowledged.
        const accountName = await customerAccountName(tx, session.customerId);
        if (accountName) {
          await sendCustomerNotification(
            tx,
            { tenantId: session.principal.tenantId, userId: session.principal.userId },
            {
              event: "request_received",
              customerId: session.customerId,
              customerName: accountName,
              subjectTable: "jobs",
              subjectId: created.jobId,
              reference: created.reference,
              title,
              detail: null,
              amount: null,
              currency: null,
              occursAt: null,
              occursEndAt: null,
            },
          );
        }

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
