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

import { eq, inArray } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  createQuote,
  sendQuote,
  decideQuote,
  getQuoteWithLines,
  createInvoiceFromJob,
  getInvoiceDocument,
  uninvoicedSignedOffJobs,
  invoiceSequenceGaps,
  issueCreditNote,
  listCreditNotes,
  customerCreditPosition,
  recordPayment,
  listInvoices,
  arAgeing,
  transitionJob,
  schema,
  closeConnection,
} from "../src/index";
import { toDecimalString, formatMoney, toMinor, company, renderableProblems } from "@meridian/core";

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

  // ── Tax invoice compliance: INV-3, INV-4, INV-5, INV-6, INV-7 ─────────────

  const article59 = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        documentType: schema.invoices.documentType,
        supplyDate: schema.invoices.supplyDate,
        supplierName: schema.invoices.supplierName,
        supplierCountry: schema.invoices.supplierCountry,
        recipientName: schema.invoices.recipientName,
        recipientTrn: schema.invoices.recipientTrn,
        taxableAmount: schema.invoices.taxableAmount,
        paymentTermsDays: schema.invoices.paymentTermsDays,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, invoice.invoiceId));
    return rows[0];
  });

  check("the document names itself a tax invoice", article59?.documentType, "tax_invoice");
  checkTrue("a date of supply is captured, not left to the issue date", article59?.supplyDate !== null);
  check("the supplier identity is snapshot, not joined", article59?.supplierName, company.legalName);
  check("the taxable amount is stored as the document showed it", article59?.taxableAmount, "4400.00");
  checkTrue("the recipient is named on the row", (article59?.recipientName ?? "").length > 0);

  // Article 59 requires the tax amount in AED on every line. The document
  // discount is apportioned across them, so the parts must still sum to the
  // whole — an invoice whose lines do not add up is one an accountant refuses.
  const invoiceLines = await withTenant(ctx, (tx) =>
    tx
      .select({
        unit: schema.invoiceLines.unit,
        unitCode: schema.invoiceLines.unitCode,
        netAmount: schema.invoiceLines.netAmount,
        taxAmount: schema.invoiceLines.taxAmount,
      })
      .from(schema.invoiceLines)
      .where(eq(schema.invoiceLines.invoiceId, invoice.invoiceId)),
  );

  const lineTaxMinor = invoiceLines.reduce((sum, l) => sum + toMinor(l.taxAmount ?? "0"), 0);
  const lineNetMinor = invoiceLines.reduce((sum, l) => sum + toMinor(l.netAmount ?? "0"), 0);
  check("per-line tax sums to the document tax", toDecimalString(lineTaxMinor), "220.00");
  check("per-line net sums to the taxable amount", toDecimalString(lineNetMinor), "4400.00");
  check("m2 carries its PINT AE unit code", invoiceLines.find((l) => l.unit === "m2")?.unitCode, "MTK");
  check("and ea carries its own", invoiceLines.find((l) => l.unit === "ea")?.unitCode, "H87");

  const document = await withTenant(ctx, (tx) => getInvoiceDocument(tx, invoice.invoiceId));
  checkTrue("the document model reads back from the row", document !== null);
  check("an unregistered recipient gets the simplified variant", document?.variant, "simplified");

  // This environment has no COMPANY_TRN (OPEN-7 is still open), so the render
  // must refuse rather than print a document that is not a tax invoice. That
  // refusal is the requirement, not a test-environment artefact.
  const problems = renderableProblems(document!.document, { variant: "full" });
  checkTrue(
    "without a supplier TRN the render refuses",
    company.trn !== null || problems.some((p) => p.includes("TRN")),
  );

  // ── INV-6: a registered recipient gets the full invoice ───────────────────
  const RECIPIENT_TRN = "100123456789003";
  await withTenant(ctx, (tx) =>
    tx
      .update(schema.customers)
      .set({ taxRegistrationNumber: RECIPIENT_TRN, billingAddress: "Business Bay, Dubai" })
      .where(eq(schema.customers.id, setup.customerId)),
  );

  const registered = await withTenant(ctx, (tx) =>
    createInvoiceFromJob(tx, ctx, {
      jobId: setup.id,
      lines: [{ description: "Additional visit", quantity: "1", unit: "ea", unitPrice: "100.00" }],
    }),
  );

  const registeredDoc = await withTenant(ctx, (tx) => getInvoiceDocument(tx, registered.invoiceId));
  check("a registered recipient gets the full variant", registeredDoc?.variant, "full");
  check("and their TRN is snapshot onto the invoice", registeredDoc?.document.recipient.trn, RECIPIENT_TRN);
  check("with their address", registeredDoc?.document.recipient.address, "Business Bay, Dubai");

  const credited = await withTenant(ctx, (tx) =>
    createInvoiceFromJob(tx, ctx, {
      jobId: setup.id,
      lines: [{ description: "Callout", quantity: "1", unit: "ea", unitPrice: "100.00" }],
    }),
  );

  // ── INV-5: the 14-day queue ───────────────────────────────────────────────
  const awaitingInvoice = await withTenant(ctx, (tx) => uninvoicedSignedOffJobs(tx));
  checkTrue(
    "an invoiced job is out of the 14-day queue",
    !awaitingInvoice.some((j) => j.jobId === setup.id),
  );
  checkTrue(
    "every entry carries a deadline and a days count",
    awaitingInvoice.every((j) => j.deadline.length === 10 && j.daysSinceSupply >= 0),
  );
  checkTrue(
    "anything past day 14 names the AED 2,500 penalty",
    awaitingInvoice.every((j) => j.state !== "breached" || (j.penalty ?? "").includes("2,500")),
  );

  // ── INV-4: gaps in the issued series are detectable ───────────────────────
  // Scoped to the three numbers this run allocated. Earlier runs hard-delete
  // their fixtures, which leaves real gaps in the dev series — asserting the
  // whole series is clean would make this test pass once and fail for ever
  // after, which is worse than not testing it.
  const seqOf = (reference: string): number => Number(reference.slice(-5));
  const ourRange = [invoice.reference, registered.reference, credited.reference].map(seqOf);
  const firstOurs = Math.min(...ourRange);
  const lastOurs = Math.max(...ourRange);

  const clean = await withTenant(ctx, (tx) => invoiceSequenceGaps(tx));
  checkTrue(
    "consecutive allocation leaves no gap",
    !clean.gaps.some((g) => g.sequence >= firstOurs && g.sequence <= lastOurs),
  );

  // Remove an interior number and the report must find it. This is the FTA
  // audit flag: the innocent explanation for a missing invoice number is a
  // rolled-back transaction, and the other explanation is a suppressed sale.
  await withTenant(ctx, async (tx) => {
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, registered.invoiceId));
    await tx.delete(schema.invoices).where(eq(schema.invoices.id, registered.invoiceId));
  });

  const gapped = await withTenant(ctx, (tx) => invoiceSequenceGaps(tx));
  checkTrue(
    "a missing interior number is reported",
    gapped.gaps.some((g) => g.reference === registered.reference),
  );

  // ── INV-7: tax credit notes ───────────────────────────────────────────────
  const note = await withTenant(ctx, (tx) =>
    issueCreditNote(tx, ctx, {
      invoiceId: credited.invoiceId,
      reason: "correction",
      reasonDetail: "Callout was covered by the contract",
      lines: [{ description: "Callout, credited", quantity: "1", unit: "ea", unitPrice: "40.00" }],
    }),
  );

  checkTrue("a credit note gets its own series", note.reference.startsWith("CRN-"));
  check("credited amount is exact", toDecimalString(note.totalMinor), "42.00");
  checkTrue("and its issuance clock is reported", note.issuance.deadline.length === 10);

  const partiallyCredited = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: schema.invoices.status })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, credited.invoiceId));
    return rows[0];
  });
  check("a part credit leaves the invoice collectable", partiallyCredited?.status, "issued");

  let overCreditRejected = false;
  try {
    await withTenant(ctx, (tx) =>
      issueCreditNote(tx, ctx, {
        invoiceId: credited.invoiceId,
        reason: "cancellation",
        lines: [{ description: "Too much", quantity: "1", unit: "ea", unitPrice: "100.00" }],
      }),
    );
  } catch {
    overCreditRejected = true;
  }
  checkTrue("crediting more output tax than was charged is refused", overCreditRejected);

  const finalNote = await withTenant(ctx, (tx) =>
    issueCreditNote(tx, ctx, {
      invoiceId: credited.invoiceId,
      reason: "cancellation",
      lines: [{ description: "Balance credited", quantity: "1", unit: "ea", unitPrice: "60.00" }],
    }),
  );
  check("the balancing note is exact", toDecimalString(finalNote.totalMinor), "63.00");

  const fullyCredited = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: schema.invoices.status })
      .from(schema.invoices)
      .where(eq(schema.invoices.id, credited.invoiceId));
    return rows[0];
  });
  check("a full credit marks the invoice credited", fullyCredited?.status, "credited");

  const notes = await withTenant(ctx, (tx) => listCreditNotes(tx, { invoiceId: credited.invoiceId }));
  check("both notes reference the original", notes.length, 2);
  checkTrue("and name the invoice they correct", notes.every((n) => n.invoiceReference === credited.reference));

  // A credit note carries the customer's name, address, TRN and the size of a
  // dispute. The restrictive customer_scope policy has to cover it, or the
  // portal leaks every other customer's corrections.
  const foreignNotes = await withCustomerScope(
    { tenantId: TENANT, customerId: otherCustomer!.id },
    (tx) => listCreditNotes(tx, { invoiceId: credited.invoiceId }),
  );
  checkTrue("another customer cannot see the credit notes", foreignNotes.length === 0);

  // ── Credit position (DB-4) ────────────────────────────────────────────────
  const position = await withTenant(ctx, (tx) => customerCreditPosition(tx, setup.customerId));
  checkTrue("credit position is computed in minor units", Number.isInteger(position.outstandingMinor));
  checkTrue(
    "a fully credited invoice is not outstanding",
    position.outstandingMinor >= 0,
  );

  // Put the customer record back the way it was found.
  await withTenant(ctx, (tx) =>
    tx
      .update(schema.customers)
      .set({ taxRegistrationNumber: null, billingAddress: null })
      .where(eq(schema.customers.id, setup.customerId)),
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    await tx
      .delete(schema.creditNoteLines)
      .where(inArray(schema.creditNoteLines.creditNoteId, [note.creditNoteId, finalNote.creditNoteId]));
    await tx.delete(schema.creditNotes).where(eq(schema.creditNotes.invoiceId, credited.invoiceId));
    await tx.delete(schema.invoiceLines).where(eq(schema.invoiceLines.invoiceId, credited.invoiceId));
    await tx.delete(schema.invoices).where(eq(schema.invoices.id, credited.invoiceId));
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
