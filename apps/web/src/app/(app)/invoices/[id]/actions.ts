"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  recordPayment,
  issueCreditNote,
  type CreditReason,
} from "@meridian/db";
import { requirePermission } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface ActionState {
  error?: string;
  ok?: string;
}

const CREDIT_REASONS: readonly CreditReason[] = ["return", "discount", "cancellation", "correction"];

/** Record a payment against an invoice. */
export async function recordPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = String(formData.get("amount") ?? "").trim();
  const method = String(formData.get("method") ?? "bank_transfer");
  const reference = String(formData.get("reference") ?? "").trim();

  try {
    requirePermission(session.principal, "invoices:create");
  } catch {
    return { error: "Your role cannot record payments." };
  }

  if (!amount) return { error: "Enter the amount received." };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        recordPayment(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            invoiceId,
            amount,
            method: method as "bank_transfer",
            reference: reference || undefined,
          },
        ),
    );

    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/invoices");
    return { ok: result.status === "paid" ? "Payment recorded. Invoice settled." : "Payment recorded." };
  } catch (error) {
    return { error: userMessage(error, "Could not record the payment.", "invoices") };
  }
}

/**
 * Issue a tax credit note (`INV-7`).
 *
 * Gated on `invoices:void` rather than `invoices:create`: a credit note reduces
 * output tax already declared, which is a different decision from raising an
 * invoice and belongs with the people who can void one.
 */
export async function issueCreditNoteAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  const invoiceId = String(formData.get("invoiceId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const reasonDetail = String(formData.get("reasonDetail") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const amount = String(formData.get("amount") ?? "").trim();

  try {
    requirePermission(session.principal, "invoices:void");
  } catch {
    return { error: "Your role cannot issue credit notes." };
  }

  if (!CREDIT_REASONS.includes(reason as CreditReason)) {
    return { error: "Choose why output tax is being reduced." };
  }
  if (!amount) return { error: "Enter the amount to credit, excluding VAT." };
  if (!description) return { error: "Describe what is being credited." };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        issueCreditNote(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            invoiceId,
            reason: reason as CreditReason,
            reasonDetail: reasonDetail || undefined,
            lines: [{ description, quantity: "1", unit: "ea", unitPrice: amount }],
          },
        ),
    );

    revalidatePath(`/invoices/${invoiceId}`);
    revalidatePath("/invoices");

    // The clock is surfaced rather than swallowed. Past day 14 the AED 2,500
    // has already been incurred and somebody needs to know it happened.
    return {
      ok:
        result.issuance.state === "breached"
          ? `${result.reference} issued, but more than 14 days after the supply it corrects. ${result.issuance.penalty}`
          : `${result.reference} issued.`,
    };
  } catch (error) {
    return { error: userMessage(error, "Could not issue the credit note.", "invoices") };
  }
}
