"use server";

import { revalidatePath } from "next/cache";
import { withCustomerScope, decideQuote } from "@meridian/db";
import { requirePortalSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface DecisionState {
  error?: string;
}

/**
 * Record a customer's decision on a quotation.
 *
 * Runs through `withCustomerScope`, so the update is restricted by Postgres to
 * this customer's quotes. A tampered `quoteId` naming another customer's quote
 * matches zero rows and `decideQuote` throws - the boundary is the database,
 * not a check in this function.
 */
export async function decide(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const session = await requirePortalSession();

  const quoteId = String(formData.get("quoteId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();

  if (decision !== "approved" && decision !== "rejected") {
    return { error: "Choose approve or decline." };
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
        decideQuote(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { quoteId, decision, reason: reason || undefined },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not record your decision.", "quotes") };
  }

  revalidatePath(`/portal/quotes/${quoteId}`);
  revalidatePath("/portal");
  return {};
}
