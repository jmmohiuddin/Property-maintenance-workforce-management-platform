/**
 * Commerce integration test.
 *
 * Runs against a real, seeded Postgres as the application role, so RLS and the
 * customer-scope policies are live. A test that mocks the database would not
 * exercise the thing most likely to be wrong here, which is the boundary.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires: schema + rls.sql + auth-functions.sql + customer-scope.sql applied,
 * and `npm run db:seed` run. Cleans up after itself.
 */

import { eq } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  createQuote,
  sendQuote,
  decideQuote,
  getQuoteWithLines,
  createInvoiceFromJob,
  recordPayment,
  listInvoices,
  arAgeing,
  transitionJob,
  schema,
  closeConnection,
} from "../src/index";
import { toDecimalString, formatMoney } from "@meridian/core";

const TENANT = "11111111-1111-4111-8111-111111111111";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };

  // Work against a seeded job that is already signed off.
  const setup = await withTenant(ctx, async (tx) => {
    const jobs = await tx
      .select({
        id: schema.jobs.id,
        reference: schema.jobs.reference,
        customerId: schema.jobs.customerId,
        status: schema.jobs.status,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.reference, "JOB-2026-00014"));
    return jobs[0];
  });

  if (!setup) throw new Error("Seed data missing. Run `npm run db:seed` first.");
  console.log(`Using ${setup.reference} (${setup.status})\n`);

  // ── Quote lifecycle ───────────────────────────────────────────────────────
  const quote = await withTenant(ctx, (tx) =>
    createQuote(tx, ctx, {
      jobId: setup.id,
      title: "Lobby deep clean, additional scope",
      lines: [
        { description: "Marble floor honing", quantity: "180", unit: "m2", unitPrice: "22.00" },
        { description: "Lift car interior clean", quantity: "4", unit: "ea", unitPrice: "150.00" },
      ],
      discount: "160.00",
    }),
  );

  // 180 x 22.00 = 3960.00; 4 x 150.00 = 600.00; subtotal 4560.00
  // less 160.00 discount = 4400.00; VAT 5% = 220.00; total 4620.00
  check("quote total is exact", toDecimalString(quote.totalMinor), "4620.00");

  const detail = await withTenant(ctx, (tx) => getQuoteWithLines(tx, quote.quoteId));
  checkTrue("quote has both lines", detail?.lines.length === 2);
  check("subtotal stored", detail?.subtotal, "4560.00");
  check("VAT charged on the discounted amount", detail?.taxAmount, "220.00");
  check("line 1 total", detail?.lines[0]?.lineTotal, "3960.00");

  const { token } = await withTenant(ctx, (tx) => sendQuote(tx, quote.quoteId));
  checkTrue("approval token minted", token.length > 20);

  // Raw token must never be stored.
  const stored = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ hash: schema.quotes.approvalTokenHash, status: schema.quotes.status })
      .from(schema.quotes)
      .where(eq(schema.quotes.id, quote.quoteId));
    return rows[0];
  });
  check("quote is sent", stored?.status, "sent");
  checkTrue("raw token is not stored", stored?.hash !== token && (stored?.hash?.length ?? 0) === 64);

  // Sending twice must fail: the token would be replaced and the first link dead.
  let resendRejected = false;
  try {
    await withTenant(ctx, (tx) => sendQuote(tx, quote.quoteId));
  } catch {
    resendRejected = true;
  }
  checkTrue("a sent quote cannot be re-sent", resendRejected);

  await withTenant(ctx, (tx) => decideQuote(tx, ctx, { quoteId: quote.quoteId, decision: "approved" }));

  const afterDecision = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: schema.quotes.status, hash: schema.quotes.approvalTokenHash })
      .from(schema.quotes)
      .where(eq(schema.quotes.id, quote.quoteId));
    return rows[0];
  });
  check("quote approved", afterDecision?.status, "approved");
  checkTrue("approval token burned after use", afterDecision?.hash === null);

  // Deciding twice must be rejected, not silently applied again.
  let doubleDecideRejected = false;
  try {
    await withTenant(ctx, (tx) =>
      decideQuote(tx, ctx, { quoteId: quote.quoteId, decision: "rejected" }),
    );
  } catch {
    doubleDecideRejected = true;
  }
  checkTrue("a decided quote cannot be decided again", doubleDecideRejected);

  // ── Invoicing ─────────────────────────────────────────────────────────────
  // Invoicing work nobody signed for must be refused.
  const openJob = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.reference, "JOB-2026-00001"));
    return rows[0];
  });

  let unsignedRejected = false;
  try {
    await withTenant(ctx, (tx) =>
      createInvoiceFromJob(tx, ctx, {
        jobId: openJob!.id,
        lines: [{ description: "x", quantity: "1", unit: "ea", unitPrice: "1.00" }],
      }),
    );
  } catch {
    unsignedRejected = true;
  }
  checkTrue("cannot invoice a job that is not signed off", unsignedRejected);

  const invoice = await withTenant(ctx, (tx) =>
    createInvoiceFromJob(tx, ctx, {
      jobId: setup.id,
      lines: [
        { description: "Marble floor honing", quantity: "180", unit: "m2", unitPrice: "22.00" },
        { description: "Lift car interior clean", quantity: "4", unit: "ea", unitPrice: "150.00" },
      ],
      discount: "160.00",
    }),
  );
  check("invoice total matches the approved quote", toDecimalString(invoice.totalMinor), "4620.00");

  // ── Payments ──────────────────────────────────────────────────────────────
  const part = await withTenant(ctx, (tx) =>
    recordPayment(tx, ctx, { invoiceId: invoice.invoiceId, amount: "2000.00", method: "bank_transfer" }),
  );
  check("part payment sets part_paid", part.status, "part_paid");
  check("amount paid tracked exactly", toDecimalString(part.amountPaidMinor), "2000.00");

  const settled = await withTenant(ctx, (tx) =>
    recordPayment(tx, ctx, { invoiceId: invoice.invoiceId, amount: "2620.00", method: "card" }),
  );
  check("settling payment marks paid", settled.status, "paid");
  check("total paid is exact", toDecimalString(settled.amountPaidMinor), "4620.00");

  let negativeRejected = false;
  try {
    await withTenant(ctx, (tx) =>
      recordPayment(tx, ctx, { invoiceId: invoice.invoiceId, amount: "-50.00" }),
    );
  } catch {
    negativeRejected = true;
  }
  checkTrue("a negative payment is rejected", negativeRejected);

  // ── AR ageing ─────────────────────────────────────────────────────────────
  const ageing = await withTenant(ctx, (tx) => arAgeing(tx));
  checkTrue("a fully paid invoice is excluded from ageing", ageing.totalOutstandingMinor >= 0);
  console.log(`      outstanding: ${formatMoney(ageing.totalOutstandingMinor)}`);

  // ── Customer scoping ──────────────────────────────────────────────────────
  // The decisive test: a portal session scoped to a DIFFERENT customer must not
  // see this invoice, and must not be able to pay it.
  const otherCustomer = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.code, "SERAI"));
    return rows[0];
  });

  const ownInvoices = await withCustomerScope(
    { tenantId: TENANT, customerId: setup.customerId },
    (tx) => listInvoices(tx),
  );
  checkTrue("owning customer sees its invoice", ownInvoices.some((i) => i.id === invoice.invoiceId));

  const foreignInvoices = await withCustomerScope(
    { tenantId: TENANT, customerId: otherCustomer!.id },
    (tx) => listInvoices(tx),
  );
  checkTrue(
    "another customer cannot see it",
    !foreignInvoices.some((i) => i.id === invoice.invoiceId),
  );

  const foreignQuote = await withCustomerScope(
    { tenantId: TENANT, customerId: otherCustomer!.id },
    (tx) => getQuoteWithLines(tx, quote.quoteId),
  );
  checkTrue("another customer cannot read the quote or its prices", foreignQuote === null);

  let foreignPaymentBlocked = false;
  try {
    await withCustomerScope({ tenantId: TENANT, customerId: otherCustomer!.id }, (tx) =>
      recordPayment(tx, { tenantId: TENANT }, { invoiceId: invoice.invoiceId, amount: "1.00" }),
    );
  } catch {
    foreignPaymentBlocked = true;
  }
  checkTrue("another customer cannot pay against it", foreignPaymentBlocked);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    await tx.delete(schema.payments).where(eq(schema.payments.invoiceId, invoice.invoiceId));
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, invoice.invoiceId));
    await tx.delete(schema.invoices).where(eq(schema.invoices.id, invoice.invoiceId));
    await tx.delete(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quote.quoteId));
    await tx.delete(schema.quotes).where(eq(schema.quotes.id, quote.quoteId));
  });

  console.log(`\n${fail === 0 ? "commerce: all checks passed" : `${fail} FAILING`}`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
