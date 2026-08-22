"use server";

import { revalidatePath } from "next/cache";
import { withCustomerScope, setCustomerNotificationPreference } from "@meridian/db";
import { isCustomerNotificationEvent } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface PreferenceState {
  error?: string;
  saved?: string;
}

/**
 * Turn one notification on or off (`POR-5`).
 *
 * ── WHY THE EVENT NAME IS NARROWED AND NOT TRUSTED ────────────────────────
 *
 * `event` arrives from a form post, so it is whatever the client sent. The
 * database CHECK from 0016 would reject an unknown value, but the error it
 * raises is a constraint violation the customer cannot act on. Narrowing here
 * turns that into a sentence, and — the part that matters — makes the value a
 * `CustomerNotificationEvent` before it reaches the domain, so the compiler
 * checks the rest of the path.
 *
 * The customer id comes from the session and never from the form. That is the
 * whole of the authorisation here: `withCustomerScope` is opened on
 * `session.customerId`, and the RESTRICTIVE policy's WITH CHECK means a write
 * naming any other customer is rejected by Postgres rather than by this
 * function.
 */
export async function setPreference(
  _prev: PreferenceState,
  formData: FormData,
): Promise<PreferenceState> {
  const session = await requirePortalSession();

  const event = String(formData.get("event") ?? "");
  // The checkbox is absent from the post when unchecked, which is how HTML
  // forms work and is exactly the trap: reading it as `Boolean(get("enabled"))`
  // is right, reading a hidden field next to it is not.
  const isEnabled = formData.get("isEnabled") === "on";

  if (!isCustomerNotificationEvent(event)) {
    return { error: "That is not one of the notifications you can change." };
  }

  try {
    await withCustomerScope(
      {
        tenantId: session.principal.tenantId,
        customerId: session.customerId,
        userId: session.principal.userId,
        actorKind: "customer",
      },
      (tx) =>
        setCustomerNotificationPreference(
          tx,
          {
            tenantId: session.principal.tenantId,
            customerId: session.customerId,
            userId: session.principal.userId,
          },
          { event, isEnabled },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not save that.", "portal-notifications") };
  }

  revalidatePath("/portal/notifications");
  return { saved: event };
}
