"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  recordPayment,
  issueCreditNote,
  type CreditReason,
} from "@meridian/db";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Writes against a single invoice (`INV-6`, `INV-7`).
 *
 * Both authorise through `requireSessionWith`, the same way every other module
 * does, rather than taking any signed-in session and checking a permission
 * afterwards. The difference is not style: `requireSessionWith` goes through
 * `requireStaffSession`, so a portal `customer` — who holds `invoices:read` and
 * can therefore hold a valid session on an invoice URL — is refused by the
 * staff boundary as well as by the permission. Relying on the permission alone
 * left one check between a customer session and the accounts-receivable ledger.
 */

export interface ActionState {
  error?: string;
  ok?: string;
}

const CREDIT_REASONS: readonly CreditReason[] = ["return", "discount", "cancellation", "correction"];

/**
 * The methods a person may record by hand.
 *
 * A positive list, and it is deliberately NOT the whole `payment_method` enum.
 * `credit_note` is a method the system writes for itself when a credit note is
 * issued; accepting it here would let a posted form settle an invoice as
 * "credited" with no credit note behind it — no `INV-7` document, no 14-day
 * clock, and output tax reduced on the strength of a dropdown value nobody
 * chose. The select on this screen offers exactly these five.
 */
const PAYMENT_METHODS = ["bank_transfer", "cheque", "cash", "card", "online_gateway"] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Record a payment against an invoice (`INV-6`).
 *
 * `payments:record`, not `invoices:create`. The two happen to be held by the
 * same three roles today, which is exactly why the wrong one survived here: it
 * tests identically until a tenant uses `permission_overrides` to take
 * "may bank money against a customer's account" away from someone who still
 * raises invoices, at which point the override silently does nothing.
 */
export async function recordPaymentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSessionWith("payments:record");

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const amount = String(formData.get("amount") ?? "").trim();
  const method = String(formData.get("method") ?? "bank_transfer").trim();
  const reference = String(formData.get("reference") ?? "").trim();

  if (!invoiceId) return { error: "Which invoice?" };
  if (!amount) return { error: "Enter the amount received." };
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
    return { error: "Choose how the money was received." };
  }

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
            method: method as PaymentMethod,
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
  const session = await requireSessionWith("invoices:void");

  const invoiceId = String(formData.get("invoiceId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const reasonDetail = String(formData.get("reasonDetail") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const amount = String(formData.get("amount") ?? "").trim();

  if (!invoiceId) return { error: "Which invoice?" };
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
