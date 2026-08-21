import { randomBytes, createHash } from "node:crypto";
import { and, eq, desc, sql, inArray, isNull } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  computeTotals,
  toMinor,
  toDecimalString,
  UAE_VAT_BASIS_POINTS,
  type LineInput,
  UserFacingError,
  company,
  apportionLines,
  unitCodeFor,
  defaultInvoiceVariant,
  issuanceClock,
  dubaiDateKey,
  ISSUANCE_ALERT_DAYS,
  LATE_ISSUANCE_PENALTY,
  type InvoiceVariant,
  type TaxDocumentDraft,
} from "@meridian/core";

/**
 * Quotes, invoices and payments.
 *
 * Two rules run through everything here:
 *
 *  1. **Totals are stored, never recomputed on read.** A quote a customer has
 *     seen must keep showing the number they saw, even if a price list changes
 *     next week. Recomputing on read silently rewrites history, which is
 *     exactly the number that ends up disputed.
 *  2. **Arithmetic happens in integer minor units** (see @meridian/core/money).
 *     No float goes anywhere near a total.
 */

// ── References ───────────────────────────────────────────────────────────────

async function nextReference(tx: TenantScopedTx, prefix: string, year: number): Promise<string> {
  // Allocated by the database, not by counting rows here: two accountants
  // raising an invoice in the same second would otherwise read the same count
  // and collide on the unique index. See `sql/reference.sql`.
  const rows = await tx.execute<{ reference: string }>(
    sql`select app_next_reference(${prefix}, ${year}) as reference`,
  );
  const reference = rows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a document reference");
  return reference;
}

// ── Quotes ───────────────────────────────────────────────────────────────────

export type QuoteStatus =
  | "draft"
  | "sent"
  | "viewed"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded";

export const QUOTE_STATUS_LABEL: Readonly<Record<QuoteStatus, string>> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
  superseded: "Superseded",
};

export interface DraftLine {
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  /** Decimal string as entered, e.g. "150.00". */
  readonly unitPrice: string;
  readonly serviceSlug?: string | undefined;
}

/** Create a draft quote against a job, with its lines and computed totals. */
export async function createQuote(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    title: string;
    lines: readonly DraftLine[];
    discount?: string | undefined;
    validForDays?: number;
    notes?: string | undefined;
  },
): Promise<{ quoteId: string; reference: string; totalMinor: number }> {
  if (input.lines.length === 0) throw new UserFacingError("A quote needs at least one line");

  const jobRows = await tx
    .select({
      customerId: schema.jobs.customerId,
      propertyId: schema.jobs.propertyId,
      serviceSlug: schema.jobs.serviceSlug,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const job = jobRows[0];
  if (!job) throw new Error("Job not found in this tenant");

  const lineInputs: LineInput[] = input.lines.map((l) => ({
    quantity: l.quantity,
    unitPriceMinor: toMinor(l.unitPrice),
  }));

  const totals = computeTotals({
    lines: lineInputs,
    discountMinor: input.discount ? toMinor(input.discount) : 0,
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  const reference = await nextReference(tx, "QUO", new Date().getFullYear());
  const validUntil = new Date(Date.now() + (input.validForDays ?? 30) * 24 * 60 * 60 * 1000);

  const [quote] = await tx
    .insert(schema.quotes)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: job.customerId,
      propertyId: job.propertyId,
      jobId: input.jobId,
      title: input.title,
      status: "draft",
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: toDecimalString(totals.discountMinor),
      taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      validUntil,
      notes: input.notes ?? null,
      preparedById: ctx.userId ?? null,
    })
    .returning({ id: schema.quotes.id });

  if (!quote) throw new Error("Failed to create quote");

  await tx.insert(schema.quoteLines).values(
    input.lines.map((l, i) => ({
      tenantId: ctx.tenantId,
      quoteId: quote.id,
      position: i + 1,
      serviceSlug: l.serviceSlug ?? job.serviceSlug,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: toDecimalString(toMinor(l.unitPrice)),
      lineTotal: toDecimalString(lineInputs[i] ? computeTotals({ lines: [lineInputs[i]!], taxRateBasisPoints: 0 }).subtotalMinor : 0),
    })),
  );

  return { quoteId: quote.id, reference, totalMinor: totals.totalMinor };
}

/**
 * Mark a quote sent and mint its approval token.
 *
 * The raw token is returned once, for the link. Only its hash is stored, so a
 * database read cannot be turned into the ability to approve someone's quote.
 */
export async function sendQuote(
  tx: TenantScopedTx,
  quoteId: string,
): Promise<{ token: string }> {
  const token = randomBytes(32).toString("base64url");

  const updated = await tx
    .update(schema.quotes)
    .set({
      status: "sent",
      sentAt: new Date(),
      approvalTokenHash: createHash("sha256").update(token).digest("hex"),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.quotes.id, quoteId), eq(schema.quotes.status, "draft")))
    .returning({ id: schema.quotes.id });

  if (updated.length === 0) throw new UserFacingError("Only a draft quote can be sent");
  return { token };
}

/**
 * Record a customer's decision.
 *
 * Guarded on the current status so a decided quote cannot be flipped later, and
 * so a double-submitted approval is a no-op rather than a second decision.
 */
export async function decideQuote(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { quoteId: string; decision: "approved" | "rejected"; reason?: string | undefined },
): Promise<void> {
  const updated = await tx
    .update(schema.quotes)
    .set({
      status: input.decision,
      decidedAt: new Date(),
      rejectionReason: input.decision === "rejected" ? (input.reason ?? null) : null,
      // Burn the token. Approval links are single use.
      approvalTokenHash: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.quotes.id, input.quoteId),
        inArray(schema.quotes.status, ["sent", "viewed"]),
      ),
    )
    .returning({ id: schema.quotes.id });

  if (updated.length === 0) {
    throw new UserFacingError("This quote is no longer awaiting a decision");
  }

  // No `job_events` row is written here on purpose. That table is a job STATUS
  // transition log, and a quote decision is not a job status - writing
  // "quote_approved" into `to_status` would corrupt every query that reads the
  // status timeline. The decision is already captured twice: on the quote row
  // itself (`decided_at`, `rejection_reason`) and in `audit_log`, which the
  // database trigger writes for `quotes` automatically.
  void ctx;
}

/**
 * Everything a "quote sent" notification needs, in one query.
 *
 * Lives here rather than in the notify package because notify depends on db;
 * the reverse would be a cycle. The app layer joins the two.
 */
export async function getQuoteForNotification(
  tx: TenantScopedTx,
  quoteId: string,
): Promise<{
  quoteId: string;
  reference: string;
  title: string;
  total: string;
  currency: string;
  validUntil: Date | null;
  customerName: string;
  customerEmail: string | null;
} | null> {
  const rows = await tx
    .select({
      quoteId: schema.quotes.id,
      reference: schema.quotes.reference,
      title: schema.quotes.title,
      total: schema.quotes.total,
      currency: schema.quotes.currency,
      validUntil: schema.quotes.validUntil,
      customerName: schema.customers.name,
      customerEmail: schema.customers.billingEmail,
    })
    .from(schema.quotes)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.quotes.customerId))
    .where(eq(schema.quotes.id, quoteId))
    .limit(1);

  return rows[0] ?? null;
}

export interface QuoteRow {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly status: QuoteStatus;
  readonly total: string;
  readonly currency: string;
  readonly validUntil: Date | null;
  readonly createdAt: Date;
  readonly customerName: string;
  readonly jobId: string | null;
}

export async function listQuotes(
  tx: TenantScopedTx,
  options?: { jobId?: string; limit?: number },
): Promise<readonly QuoteRow[]> {
  const rows = await tx
    .select({
      id: schema.quotes.id,
      reference: schema.quotes.reference,
      title: schema.quotes.title,
      status: schema.quotes.status,
      total: schema.quotes.total,
      currency: schema.quotes.currency,
      validUntil: schema.quotes.validUntil,
      createdAt: schema.quotes.createdAt,
      customerName: schema.customers.name,
      jobId: schema.quotes.jobId,
    })
    .from(schema.quotes)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.quotes.customerId))
    .where(
      options?.jobId
        ? and(isNull(schema.quotes.deletedAt), eq(schema.quotes.jobId, options.jobId))
        : isNull(schema.quotes.deletedAt),
    )
    .orderBy(desc(schema.quotes.createdAt))
    .limit(options?.limit ?? 100);

  return rows.map((r) => ({ ...r, status: r.status as QuoteStatus }));
}

export async function getQuoteWithLines(
  tx: TenantScopedTx,
  quoteId: string,
): Promise<
  | (QuoteRow & {
      subtotal: string;
      discountAmount: string;
      taxAmount: string;
      taxRateBasisPoints: number;
      notes: string | null;
      lines: readonly {
        position: number;
        description: string;
        quantity: string;
        unit: string;
        unitPrice: string;
        lineTotal: string;
      }[];
    })
  | null
> {
  const rows = await tx
    .select({
      id: schema.quotes.id,
      reference: schema.quotes.reference,
      title: schema.quotes.title,
      status: schema.quotes.status,
      subtotal: schema.quotes.subtotal,
      discountAmount: schema.quotes.discountAmount,
      taxAmount: schema.quotes.taxAmount,
      taxRateBasisPoints: schema.quotes.taxRateBasisPoints,
      total: schema.quotes.total,
      currency: schema.quotes.currency,
      validUntil: schema.quotes.validUntil,
      createdAt: schema.quotes.createdAt,
      notes: schema.quotes.notes,
      customerName: schema.customers.name,
      jobId: schema.quotes.jobId,
    })
    .from(schema.quotes)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.quotes.customerId))
    .where(eq(schema.quotes.id, quoteId))
    .limit(1);

  const quote = rows[0];
  if (!quote) return null;

  const lines = await tx
    .select({
      position: schema.quoteLines.position,
      description: schema.quoteLines.description,
      quantity: schema.quoteLines.quantity,
      unit: schema.quoteLines.unit,
      unitPrice: schema.quoteLines.unitPrice,
      lineTotal: schema.quoteLines.lineTotal,
    })
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quoteId))
    .orderBy(schema.quoteLines.position);

  return { ...quote, status: quote.status as QuoteStatus, lines };
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export type InvoiceStatus =
  | "draft"
  | "issued"
  | "part_paid"
  | "paid"
  | "overdue"
  | "written_off"
  | "credited";

export const INVOICE_STATUS_LABEL: Readonly<Record<InvoiceStatus, string>> = {
  draft: "Draft",
  issued: "Issued",
  part_paid: "Part paid",
  paid: "Paid",
  overdue: "Overdue",
  written_off: "Written off",
  credited: "Credited",
};

/**
 * The supplier block, as it stands right now.
 *
 * Read once, at issue, and written onto the invoice row. `company.ts` is
 * configuration — it changes when a licence renews or the office moves — and an
 * invoice is a legal artefact that must keep saying what it said. Reading it at
 * render time instead would rewrite every historical document the next time an
 * environment variable changed, invisibly, because the new values would look
 * every bit as plausible as the old ones.
 *
 * Unset values stay null. `DED-000000` on a tax invoice is worse than no
 * licence line at all, and `assertPublishableIdentity` already refuses
 * placeholders in production.
 */
function supplierSnapshot(): {
  supplierName: string;
  supplierTrn: string | null;
  supplierAddress: string | null;
  supplierLicenceNumber: string | null;
  supplierCrNumber: string | null;
  supplierPhone: string | null;
  supplierEmail: string | null;
  supplierCountry: string;
} {
  const a = company.address;
  // Only when there is a street. "Dubai, United Arab Emirates" is a region, not
  // an address, and Article 59 asks for an address.
  const address = a.street ? [a.street, a.city, a.region, a.country].filter(Boolean).join(", ") : null;

  return {
    supplierName: company.legalName,
    supplierTrn: company.trn,
    supplierAddress: address,
    supplierLicenceNumber: company.licenceNumber,
    supplierCrNumber: company.crNumber,
    supplierPhone: company.phone,
    supplierEmail: company.email,
    supplierCountry: a.countryCode,
  };
}

/** The date of supply, in Dubai, for a service job. */
async function supplyDateForJob(
  tx: TenantScopedTx,
  jobId: string,
  fallback: Date,
): Promise<string> {
  // The customer's signature is the moment of supply for a service, not the
  // moment somebody got round to the paperwork. INV-5's 14-day clock runs from
  // this date, so taking it from `issued_on` would make every invoice look
  // punctual by construction.
  const rows = await tx
    .select({ signedAt: schema.jobSignoffs.signedAt })
    .from(schema.jobSignoffs)
    .where(eq(schema.jobSignoffs.jobId, jobId))
    .orderBy(schema.jobSignoffs.signedAt)
    .limit(1);

  return dubaiDateKey(rows[0]?.signedAt ?? fallback);
}

/**
 * Raise an invoice against a job.
 *
 * Everything Article 59 requires is captured here, at the one moment all of it
 * is knowable: the supplier and recipient identity as they stand today, the
 * date of supply from the customer's signature, and per-line tax in AED.
 *
 * The per-line tax is apportioned rather than computed line by line, because
 * the discount is a document-level amount. `apportionLines` distributes it and
 * its VAT with a largest-remainder split, so the lines sum to the document
 * totals exactly — an invoice whose lines do not add up to its total is one an
 * accountant refuses, and correctly.
 *
 * The invoice is issued, not drafted. A tax invoice with a sequential number on
 * it is a document, not a workspace: allocating a number to something that may
 * never be issued puts a gap in the series, and a gap is an FTA audit flag.
 */
export async function createInvoiceFromJob(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    lines: readonly DraftLine[];
    discount?: string | undefined;
    /** ISO date. Overrides the sign-off date where supply genuinely differs. */
    supplyDate?: string | undefined;
    /** The customer's own reference, which is what gets an invoice paid. */
    buyerReference?: string | undefined;
    purchaseOrderReference?: string | undefined;
    /** Article 59: required together where an amount originates elsewhere. */
    sourceCurrency?: string | undefined;
    exchangeRate?: string | undefined;
    exchangeRateSource?: string | undefined;
  },
): Promise<{ invoiceId: string; reference: string; totalMinor: number }> {
  if (input.lines.length === 0) throw new UserFacingError("An invoice needs at least one line");

  // Both or neither. Half an exchange-rate disclosure reads as an omission to
  // an auditor, and the database constraint says the same thing.
  if (Boolean(input.sourceCurrency) !== Boolean(input.exchangeRate)) {
    throw new UserFacingError(
      "Give both the source currency and the exchange rate, or neither — Article 59 requires the rate wherever an amount originates in another currency.",
    );
  }

  const jobRows = await tx
    .select({
      customerId: schema.jobs.customerId,
      status: schema.jobs.status,
      serviceSlug: schema.jobs.serviceSlug,
      completedAt: schema.jobs.completedAt,
      customerName: schema.customers.name,
      trn: schema.customers.taxRegistrationNumber,
      billingAddress: schema.customers.billingAddress,
      billingCity: schema.customers.billingCity,
      billingCountry: schema.customers.billingCountry,
      terms: schema.customers.paymentTermsDays,
    })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.jobs.customerId))
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const job = jobRows[0];
  if (!job) throw new Error("Job not found in this tenant");

  // Invoicing work nobody has signed for is how disputes start.
  if (!["signed_off", "invoiced", "closed"].includes(job.status)) {
    throw new UserFacingError(
      `This job is "${job.status}". Invoice only after the customer has signed off the work.`,
    );
  }

  const lineInputs: LineInput[] = input.lines.map((l) => ({
    quantity: l.quantity,
    unitPriceMinor: toMinor(l.unitPrice),
  }));

  const { lines: apportioned, totals } = apportionLines({
    lines: lineInputs,
    discountMinor: input.discount ? toMinor(input.discount) : 0,
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  const reference = await nextReference(tx, "INV", new Date().getFullYear());
  const issuedOn = new Date();
  const dueOn = new Date(issuedOn.getTime() + (job.terms ?? 30) * 24 * 60 * 60 * 1000);
  const supplyDate = input.supplyDate ?? (await supplyDateForJob(tx, input.jobId, job.completedAt ?? issuedOn));

  const recipientAddress =
    [job.billingAddress, job.billingCity].filter(Boolean).join(", ") || null;

  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      tenantId: ctx.tenantId,
      reference,
      documentType: "tax_invoice",
      customerId: job.customerId,
      jobId: input.jobId,
      status: "issued",
      issuedOn,
      dueOn,
      supplyDate,
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: toDecimalString(totals.discountMinor),
      taxableAmount: toDecimalString(totals.subtotalMinor - totals.discountMinor),
      taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      amountPaid: "0.00",
      ...supplierSnapshot(),
      recipientName: job.customerName,
      recipientTrn: job.trn,
      recipientAddress,
      recipientCountry: job.billingCountry ?? "AE",
      paymentTermsDays: job.terms ?? 30,
      buyerReference: input.buyerReference ?? null,
      purchaseOrderReference: input.purchaseOrderReference ?? null,
      sourceCurrency: input.sourceCurrency ?? null,
      exchangeRate: input.exchangeRate ?? null,
      exchangeRateSource: input.exchangeRateSource ?? null,
      issuedById: ctx.userId ?? null,
    })
    .returning({ id: schema.invoices.id });

  if (!invoice) throw new Error("Failed to create invoice");

  await tx.insert(schema.invoiceLines).values(
    input.lines.map((l, i) => {
      const share = apportioned[i];
      return {
        tenantId: ctx.tenantId,
        invoiceId: invoice.id,
        jobId: input.jobId,
        position: i + 1,
        serviceSlug: l.serviceSlug ?? job.serviceSlug,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitCode: unitCodeFor(l.unit),
        unitPrice: toDecimalString(toMinor(l.unitPrice)),
        lineTotal: toDecimalString(share?.lineTotalMinor ?? 0),
        discountAmount: toDecimalString(share?.discountMinor ?? 0),
        netAmount: toDecimalString(share?.netMinor ?? 0),
        taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
        taxAmount: toDecimalString(share?.taxMinor ?? 0),
      };
    }),
  );

  return { invoiceId: invoice.id, reference, totalMinor: totals.totalMinor };
}

/**
 * Record a payment and update the invoice.
 *
 * Status is derived from amounts rather than passed in, so "paid" can never
 * disagree with the sum of the payments. Gateway payments carry a provider id
 * with a unique index, which makes webhook replay a no-op rather than a
 * duplicate.
 */
export async function recordPayment(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    invoiceId: string;
    amount: string;
    method?: "card" | "bank_transfer" | "cash" | "cheque" | "online_gateway" | "credit_note";
    reference?: string | undefined;
    gatewayProvider?: string | undefined;
    gatewayPaymentId?: string | undefined;
  },
): Promise<{ amountPaidMinor: number; status: InvoiceStatus }> {
  const rows = await tx
    .select({ total: schema.invoices.total, amountPaid: schema.invoices.amountPaid })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, input.invoiceId))
    .limit(1);

  const invoice = rows[0];
  if (!invoice) throw new Error("Invoice not found in this tenant");

  const paymentMinor = toMinor(input.amount);
  if (paymentMinor <= 0) throw new UserFacingError("A payment must be a positive amount");

  await tx.insert(schema.payments).values({
    tenantId: ctx.tenantId,
    invoiceId: input.invoiceId,
    amount: toDecimalString(paymentMinor),
    method: input.method ?? "bank_transfer",
    reference: input.reference ?? null,
    gatewayProvider: input.gatewayProvider ?? null,
    gatewayPaymentId: input.gatewayPaymentId ?? null,
    recordedById: ctx.userId ?? null,
  });

  const totalMinor = toMinor(invoice.total);
  const amountPaidMinor = toMinor(invoice.amountPaid) + paymentMinor;
  const status: InvoiceStatus =
    amountPaidMinor >= totalMinor ? "paid" : amountPaidMinor > 0 ? "part_paid" : "issued";

  await tx
    .update(schema.invoices)
    .set({ amountPaid: toDecimalString(amountPaidMinor), status, updatedAt: new Date() })
    .where(eq(schema.invoices.id, input.invoiceId));

  return { amountPaidMinor, status };
}

export interface InvoiceRow {
  readonly id: string;
  readonly reference: string;
  readonly status: InvoiceStatus;
  readonly total: string;
  readonly amountPaid: string;
  readonly currency: string;
  readonly issuedOn: Date | null;
  readonly dueOn: Date | null;
  readonly customerName: string;
  /** Negative when overdue. */
  readonly daysUntilDue: number | null;
}

export async function listInvoices(
  tx: TenantScopedTx,
  options?: { limit?: number; now?: Date; jobId?: string },
): Promise<readonly InvoiceRow[]> {
  const now = options?.now ?? new Date();

  const rows = await tx
    .select({
      id: schema.invoices.id,
      reference: schema.invoices.reference,
      status: schema.invoices.status,
      total: schema.invoices.total,
      amountPaid: schema.invoices.amountPaid,
      currency: schema.invoices.currency,
      issuedOn: schema.invoices.issuedOn,
      dueOn: schema.invoices.dueOn,
      customerName: schema.customers.name,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
    .where(
      options?.jobId
        ? and(isNull(schema.invoices.deletedAt), eq(schema.invoices.jobId, options.jobId))
        : isNull(schema.invoices.deletedAt),
    )
    .orderBy(desc(schema.invoices.issuedOn))
    .limit(options?.limit ?? 200);

  return rows.map((r) => ({
    ...r,
    status: r.status as InvoiceStatus,
    daysUntilDue: r.dueOn
      ? Math.round((r.dueOn.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null,
  }));
}

/**
 * Accounts receivable ageing.
 *
 * Computed from the invoice rows rather than by a stored status, because
 * "overdue" is a function of today's date and drifts the moment a status column
 * stops being updated by a nightly job nobody is watching.
 */
export async function arAgeing(
  tx: TenantScopedTx,
  now: Date = new Date(),
): Promise<{
  currentMinor: number;
  days1to30Minor: number;
  days31to60Minor: number;
  days61PlusMinor: number;
  totalOutstandingMinor: number;
}> {
  const rows = await tx
    .select({
      id: schema.invoices.id,
      total: schema.invoices.total,
      amountPaid: schema.invoices.amountPaid,
      dueOn: schema.invoices.dueOn,
      status: schema.invoices.status,
    })
    .from(schema.invoices)
    .where(isNull(schema.invoices.deletedAt));

  // A partly credited invoice is still collectable for the remainder, so the
  // credit is netted off the balance rather than removing the invoice from the
  // report. Only a full credit flips the status, and the status filter below
  // handles that case.
  const creditRows = await tx
    .select({ invoiceId: schema.creditNotes.invoiceId, total: schema.creditNotes.total })
    .from(schema.creditNotes)
    .where(isNull(schema.creditNotes.deletedAt));

  const creditedByInvoice = new Map<string, number>();
  for (const c of creditRows) {
    creditedByInvoice.set(c.invoiceId, (creditedByInvoice.get(c.invoiceId) ?? 0) + toMinor(c.total));
  }

  let currentMinor = 0;
  let days1to30Minor = 0;
  let days31to60Minor = 0;
  let days61PlusMinor = 0;

  for (const r of rows) {
    if (r.status === "paid" || r.status === "written_off" || r.status === "credited") continue;
    const outstanding =
      toMinor(r.total) - toMinor(r.amountPaid) - (creditedByInvoice.get(r.id) ?? 0);
    if (outstanding <= 0) continue;

    const overdueDays = r.dueOn
      ? Math.floor((now.getTime() - r.dueOn.getTime()) / (24 * 60 * 60 * 1000))
      : 0;

    if (overdueDays <= 0) currentMinor += outstanding;
    else if (overdueDays <= 30) days1to30Minor += outstanding;
    else if (overdueDays <= 60) days31to60Minor += outstanding;
    else days61PlusMinor += outstanding;
  }

  return {
    currentMinor,
    days1to30Minor,
    days31to60Minor,
    days61PlusMinor,
    totalOutstandingMinor: currentMinor + days1to30Minor + days31to60Minor + days61PlusMinor,
  };
}

/**
 * Everything the invoice-issued email needs, in one read.
 *
 * Separate from `listInvoices` because a notification must not depend on a
 * list query's filters or ordering ever changing.
 */
export async function getInvoiceForNotification(
  tx: TenantScopedTx,
  invoiceId: string,
): Promise<{
  reference: string;
  total: string;
  currency: string;
  dueOn: Date | null;
  customerName: string;
  customerEmail: string | null;
} | null> {
  const rows = await tx
    .select({
      reference: schema.invoices.reference,
      total: schema.invoices.total,
      currency: schema.invoices.currency,
      dueOn: schema.invoices.dueOn,
      customerName: schema.customers.name,
      customerEmail: schema.customers.billingEmail,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);

  return rows[0] ?? null;
}

// ── The tax invoice document (INV-3, INV-6) ──────────────────────────────────

export interface InvoiceDetail {
  readonly invoiceId: string;
  readonly customerId: string;
  readonly jobId: string | null;
  readonly status: InvoiceStatus;
  readonly issuedOn: Date | null;
  readonly dueOn: Date | null;
  readonly amountPaidMinor: number;
  readonly creditedMinor: number;
  readonly outstandingMinor: number;
  readonly pdfStorageKey: string | null;
  readonly notes: string | null;
  /** Which of the two renderings applies. `INV-6` — one object, two layouts. */
  readonly variant: InvoiceVariant;
  /** Everything on the face of the document, ready for validation and render. */
  readonly document: TaxDocumentDraft;
}

/**
 * One invoice, as the document it is.
 *
 * Reads only from the invoice row, never from `customers` or `company.ts`. The
 * identity was snapshot at issue precisely so that a reprint two years later is
 * the same document, and joining back to the live customer record here would
 * undo that in the one place it matters most.
 *
 * The customer join that does happen is for `customerId` and navigation, not
 * for anything that appears on the document.
 */
export async function getInvoiceDocument(
  tx: TenantScopedTx,
  invoiceId: string,
): Promise<InvoiceDetail | null> {
  const rows = await tx
    .select({
      id: schema.invoices.id,
      reference: schema.invoices.reference,
      documentType: schema.invoices.documentType,
      customerId: schema.invoices.customerId,
      jobId: schema.invoices.jobId,
      status: schema.invoices.status,
      issuedOn: schema.invoices.issuedOn,
      dueOn: schema.invoices.dueOn,
      supplyDate: schema.invoices.supplyDate,
      subtotal: schema.invoices.subtotal,
      discountAmount: schema.invoices.discountAmount,
      taxableAmount: schema.invoices.taxableAmount,
      taxRateBasisPoints: schema.invoices.taxRateBasisPoints,
      taxAmount: schema.invoices.taxAmount,
      total: schema.invoices.total,
      amountPaid: schema.invoices.amountPaid,
      currency: schema.invoices.currency,
      sourceCurrency: schema.invoices.sourceCurrency,
      exchangeRate: schema.invoices.exchangeRate,
      supplierName: schema.invoices.supplierName,
      supplierTrn: schema.invoices.supplierTrn,
      supplierAddress: schema.invoices.supplierAddress,
      supplierLicenceNumber: schema.invoices.supplierLicenceNumber,
      supplierCrNumber: schema.invoices.supplierCrNumber,
      supplierPhone: schema.invoices.supplierPhone,
      supplierEmail: schema.invoices.supplierEmail,
      supplierCountry: schema.invoices.supplierCountry,
      recipientName: schema.invoices.recipientName,
      recipientTrn: schema.invoices.recipientTrn,
      recipientAddress: schema.invoices.recipientAddress,
      recipientCountry: schema.invoices.recipientCountry,
      pdfStorageKey: schema.invoices.pdfStorageKey,
      notes: schema.invoices.notes,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, invoiceId))
    .limit(1);

  const inv = rows[0];
  if (!inv) return null;

  const lineRows = await tx
    .select({
      position: schema.invoiceLines.position,
      description: schema.invoiceLines.description,
      quantity: schema.invoiceLines.quantity,
      unit: schema.invoiceLines.unit,
      unitCode: schema.invoiceLines.unitCode,
      unitPrice: schema.invoiceLines.unitPrice,
      lineTotal: schema.invoiceLines.lineTotal,
      discountAmount: schema.invoiceLines.discountAmount,
      netAmount: schema.invoiceLines.netAmount,
      taxRateBasisPoints: schema.invoiceLines.taxRateBasisPoints,
      taxAmount: schema.invoiceLines.taxAmount,
      taxCategoryCode: schema.invoiceLines.taxCategoryCode,
      jobReference: schema.jobs.reference,
    })
    .from(schema.invoiceLines)
    .leftJoin(schema.jobs, eq(schema.jobs.id, schema.invoiceLines.jobId))
    .where(eq(schema.invoiceLines.invoiceId, invoiceId))
    .orderBy(schema.invoiceLines.position);

  const totalMinor = toMinor(inv.total);
  const amountPaidMinor = toMinor(inv.amountPaid);
  const creditedMinor = await creditedTotalMinor(tx, invoiceId);

  const document: TaxDocumentDraft = {
    documentType: inv.documentType === "tax_credit_note" ? "tax_credit_note" : "tax_invoice",
    reference: inv.reference,
    issueDate: inv.issuedOn ? dubaiDateKey(inv.issuedOn) : null,
    supplyDate: inv.supplyDate,
    dueDate: inv.dueOn ? dubaiDateKey(inv.dueOn) : null,
    supplier: {
      name: inv.supplierName,
      trn: inv.supplierTrn,
      address: inv.supplierAddress,
      country: inv.supplierCountry,
      phone: inv.supplierPhone,
      email: inv.supplierEmail,
      licenceNumber: inv.supplierLicenceNumber,
      crNumber: inv.supplierCrNumber,
    },
    recipient: {
      name: inv.recipientName,
      trn: inv.recipientTrn,
      address: inv.recipientAddress,
      country: inv.recipientCountry,
    },
    currency: inv.currency,
    sourceCurrency: inv.sourceCurrency,
    exchangeRate: inv.exchangeRate,
    lines: lineRows.map((l) => ({
      position: l.position,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitCode: l.unitCode,
      unitPriceMinor: toMinor(l.unitPrice),
      lineTotalMinor: toMinor(l.lineTotal),
      // Null, not zero. These lines predate 0007 and never carried per-line
      // tax; a zero here would assert that no tax was charged on them.
      discountMinor: l.discountAmount === null ? null : toMinor(l.discountAmount),
      netMinor: l.netAmount === null ? null : toMinor(l.netAmount),
      taxRateBasisPoints: l.taxRateBasisPoints,
      taxMinor: l.taxAmount === null ? null : toMinor(l.taxAmount),
      taxCategoryCode: l.taxCategoryCode,
      jobReference: l.jobReference,
    })),
    subtotalMinor: toMinor(inv.subtotal),
    discountMinor: toMinor(inv.discountAmount),
    taxableMinor: toMinor(inv.taxableAmount),
    taxRateBasisPoints: inv.taxRateBasisPoints,
    taxMinor: toMinor(inv.taxAmount),
    totalMinor,
    creditedInvoiceReference: null,
    creditReason: null,
  };

  return {
    invoiceId: inv.id,
    customerId: inv.customerId,
    jobId: inv.jobId,
    status: inv.status as InvoiceStatus,
    issuedOn: inv.issuedOn,
    dueOn: inv.dueOn,
    amountPaidMinor,
    creditedMinor,
    outstandingMinor: Math.max(0, totalMinor - amountPaidMinor - creditedMinor),
    pdfStorageKey: inv.pdfStorageKey,
    notes: inv.notes,
    variant: defaultInvoiceVariant(inv.recipientTrn),
    document,
  };
}

// ── The 14-day issuance clock (INV-5) ────────────────────────────────────────

export interface UninvoicedSupply {
  readonly jobId: string;
  readonly jobReference: string;
  readonly jobTitle: string;
  readonly customerId: string;
  readonly customerName: string;
  /** ISO date, in Dubai. The customer's signature is the moment of supply. */
  readonly supplyDate: string;
  readonly daysSinceSupply: number;
  readonly daysRemaining: number;
  readonly deadline: string;
  readonly state: "within_window" | "approaching" | "breached";
  readonly penalty: string | null;
}

/**
 * Signed-off jobs with no invoice, and how long they have been that way.
 *
 * `INV-5`. A tax invoice must be issued within 14 days of the date of supply,
 * and failing to carries AED 2,500 — per invoice, so a quiet fortnight in
 * accounts is a five-figure number rather than an embarrassment.
 *
 * The alert fires at day 10 rather than day 14. Four days of margin, because
 * raising an invoice needs a person, that person takes leave, and an alert that
 * arrives on the deadline has already failed.
 *
 * Day counting happens in SQL as date arithmetic in Asia/Dubai rather than by
 * subtracting timestamps in JavaScript. Two reasons: flooring a millisecond
 * difference reports thirteen days for a supply that happened fourteen days ago
 * at 18:00, and this database does not run in Dubai — casting a timestamptz to
 * a date without naming the zone silently uses the server's, which is how a
 * deadline slips by a day without anyone touching the code.
 */
export async function uninvoicedSignedOffJobs(
  tx: TenantScopedTx,
  options?: { alertFromDays?: number },
): Promise<readonly UninvoicedSupply[]> {
  const rows = (await tx.execute<{
    job_id: string;
    job_reference: string;
    job_title: string;
    customer_id: string;
    customer_name: string;
    supply_date: string;
    days_since_supply: number;
  }>(sql`
    select j.id             as job_id,
           j.reference      as job_reference,
           j.title          as job_title,
           c.id             as customer_id,
           c.name           as customer_name,
           s.supply_date,
           ((now() at time zone 'Asia/Dubai')::date - s.supply_date)::int as days_since_supply
      from jobs j
      join customers c on c.id = j.customer_id
      join lateral (
             select (min(signed_at) at time zone 'Asia/Dubai')::date as supply_date
               from job_signoffs
              where job_id = j.id and deleted_at is null
           ) s on s.supply_date is not null
     where j.status = 'signed_off'::job_status
       and j.deleted_at is null
       and not exists (
             select 1 from invoices i
              where i.job_id = j.id and i.deleted_at is null
           )
     order by s.supply_date
  `)) as unknown as {
    job_id: string;
    job_reference: string;
    job_title: string;
    customer_id: string;
    customer_name: string;
    supply_date: string;
    days_since_supply: number;
  }[];

  const alertFrom = options?.alertFromDays ?? ISSUANCE_ALERT_DAYS;

  return rows.map((r) => {
    // The clock is recomputed in core rather than trusted from the SQL day
    // count, so the rule lives in exactly one place. The SQL count is what the
    // ordering and the index are for.
    const clock = issuanceClock(r.supply_date, addDubaiDays(r.supply_date, r.days_since_supply));
    return {
      jobId: r.job_id,
      jobReference: r.job_reference,
      jobTitle: r.job_title,
      customerId: r.customer_id,
      customerName: r.customer_name,
      supplyDate: r.supply_date,
      daysSinceSupply: clock.daysSinceSupply,
      daysRemaining: clock.daysRemaining,
      deadline: clock.deadline,
      state:
        clock.state === "within_window" && clock.daysSinceSupply >= alertFrom
          ? "approaching"
          : clock.state,
      penalty: clock.daysSinceSupply >= alertFrom ? LATE_ISSUANCE_PENALTY : null,
    };
  });
}

function addDubaiDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// TODO(INV-5): call `uninvoicedSignedOffJobs` from the daily compliance sweep in
// `apps/web/src/app/api/cron/compliance/route.ts` and alert on anything at or
// past `ISSUANCE_ALERT_DAYS`. Left unwired here only because that route is being
// edited concurrently; the query and its thresholds are finished.

// ── Sequence gap detection (INV-4) ───────────────────────────────────────────

export interface SequenceGap {
  /** The missing number, formatted the way the series formats them. */
  readonly reference: string;
  readonly sequence: number;
}

export interface SequenceReport {
  readonly prefix: string;
  readonly year: number;
  readonly issuedCount: number;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  /** Numbers absent from the issued series. An FTA audit flag. */
  readonly gaps: readonly SequenceGap[];
  /**
   * Numbers the counter handed out that never reached a document.
   *
   * Not the same fault as a gap and not an error. `sql/reference.sql` is
   * explicit that a number may be skipped on rollback — a gap is a question an
   * accountant can answer, a duplicate is one they cannot. This is reported so
   * the answer is available before an auditor asks for it.
   */
  readonly allocatedNotIssued: number;
}

/**
 * Gaps in the issued document series (`INV-4`).
 *
 * A gap is an audit flag because the obvious explanation for a missing invoice
 * number is a suppressed sale. The usual innocent explanation — a rolled-back
 * transaction — is real, which is exactly why this needs to be a report someone
 * can run and answer from, rather than a question asked for the first time
 * during an audit two years later.
 *
 * Soft-deleted rows count as issued. Their number was on a document that left
 * the building; hiding it from the report would manufacture a gap.
 */
export async function invoiceSequenceGaps(
  tx: TenantScopedTx,
  options?: { year?: number; prefix?: string },
): Promise<SequenceReport> {
  const year = options?.year ?? new Date().getFullYear();
  const prefix = options?.prefix ?? "INV";
  const pattern = `${prefix}-${year}-%`;

  const issuedRows = (await tx.execute<{ sequence: number }>(sql`
    select (regexp_match(reference, '(\\d+)$'))[1]::int as sequence
      from invoices
     where reference like ${pattern}
       and status <> 'draft'
     order by 1
  `)) as unknown as { sequence: number }[];

  const counterRows = (await tx.execute<{ last_value: number }>(sql`
    select last_value
      from reference_counters
     where prefix = ${prefix} and year = ${year}
  `)) as unknown as { last_value: number }[];

  const issued = issuedRows.map((r) => Number(r.sequence)).filter((n) => Number.isFinite(n));
  const seen = new Set(issued);
  const first = issued.length > 0 ? Math.min(...issued) : null;
  const last = issued.length > 0 ? Math.max(...issued) : null;

  const gaps: SequenceGap[] = [];
  if (first !== null && last !== null) {
    for (let n = first; n <= last; n++) {
      if (!seen.has(n)) {
        gaps.push({ sequence: n, reference: `${prefix}-${year}-${String(n).padStart(5, "0")}` });
      }
    }
  }

  const allocated = counterRows[0]?.last_value ?? 0;

  return {
    prefix,
    year,
    issuedCount: issued.length,
    firstSequence: first,
    lastSequence: last,
    gaps,
    allocatedNotIssued: Math.max(0, Number(allocated) - (last ?? 0)),
  };
}

// ── Tax credit notes (INV-7) ─────────────────────────────────────────────────

export type CreditReason = "return" | "discount" | "cancellation" | "correction";

export const CREDIT_REASON_LABEL: Readonly<Record<CreditReason, string>> = {
  return: "Return",
  discount: "Post-issue discount",
  cancellation: "Cancellation",
  correction: "Correction",
};

/** What has already been credited against an invoice, in minor units. */
async function creditedTotalMinor(tx: TenantScopedTx, invoiceId: string): Promise<number> {
  const rows = await tx
    .select({ total: schema.creditNotes.total })
    .from(schema.creditNotes)
    .where(and(eq(schema.creditNotes.invoiceId, invoiceId), isNull(schema.creditNotes.deletedAt)));

  return rows.reduce((sum, r) => sum + toMinor(r.total), 0);
}

/**
 * Issue a tax credit note against an invoice (`INV-7`).
 *
 * Required for any reduction in output tax — a return, a discount agreed after
 * issue, a cancellation, a correction — within 14 days, referencing the
 * original, in its own sequential series.
 *
 * ── WHY THE IDENTITY COMES FROM THE INVOICE, NOT FROM CONFIGURATION ─────────
 *
 * A credit note corrects a specific document and has to agree with it. If the
 * office moved between the invoice and the correction, the credit note carrying
 * the *new* address would leave a customer holding two documents that appear to
 * come from two different companies. So the supplier and recipient blocks are
 * copied from the invoice row, not re-read from `company.ts`.
 *
 * ── WHY LATE ISSUANCE IS REPORTED AND NOT REFUSED ──────────────────────────
 *
 * Past day 14 the penalty has already been incurred. Refusing the credit note
 * at that point would leave output tax overstated on the VAT return as well —
 * two failures instead of one. The caller gets the clock and decides.
 */
export async function issueCreditNote(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    invoiceId: string;
    reason: CreditReason;
    reasonDetail?: string | undefined;
    lines: readonly DraftLine[];
    discount?: string | undefined;
    /** ISO date of the event being credited. Defaults to the invoice's supply date. */
    supplyDate?: string | undefined;
  },
): Promise<{
  creditNoteId: string;
  reference: string;
  totalMinor: number;
  issuance: ReturnType<typeof issuanceClock>;
}> {
  if (input.lines.length === 0) throw new UserFacingError("A credit note needs at least one line");

  const rows = await tx
    .select({
      id: schema.invoices.id,
      reference: schema.invoices.reference,
      customerId: schema.invoices.customerId,
      total: schema.invoices.total,
      currency: schema.invoices.currency,
      supplyDate: schema.invoices.supplyDate,
      taxRateBasisPoints: schema.invoices.taxRateBasisPoints,
      taxCategoryCode: schema.invoices.taxCategoryCode,
      sourceCurrency: schema.invoices.sourceCurrency,
      exchangeRate: schema.invoices.exchangeRate,
      exchangeRateSource: schema.invoices.exchangeRateSource,
      supplierName: schema.invoices.supplierName,
      supplierTrn: schema.invoices.supplierTrn,
      supplierAddress: schema.invoices.supplierAddress,
      supplierLicenceNumber: schema.invoices.supplierLicenceNumber,
      supplierCrNumber: schema.invoices.supplierCrNumber,
      supplierPhone: schema.invoices.supplierPhone,
      supplierEmail: schema.invoices.supplierEmail,
      supplierCountry: schema.invoices.supplierCountry,
      recipientName: schema.invoices.recipientName,
      recipientTrn: schema.invoices.recipientTrn,
      recipientAddress: schema.invoices.recipientAddress,
      recipientCountry: schema.invoices.recipientCountry,
    })
    .from(schema.invoices)
    .where(eq(schema.invoices.id, input.invoiceId))
    .limit(1);

  const invoice = rows[0];
  if (!invoice) throw new Error("Invoice not found in this tenant");

  const lineInputs: LineInput[] = input.lines.map((l) => ({
    quantity: l.quantity,
    unitPriceMinor: toMinor(l.unitPrice),
  }));

  const { lines: apportioned, totals } = apportionLines({
    lines: lineInputs,
    discountMinor: input.discount ? toMinor(input.discount) : 0,
    taxRateBasisPoints: invoice.taxRateBasisPoints,
  });

  // Crediting more than was charged reverses output tax that was never
  // declared. The VAT return would not reconcile, and the discrepancy would
  // surface as a query from the FTA rather than as an error here.
  const invoiceTotalMinor = toMinor(invoice.total);
  const alreadyCredited = await creditedTotalMinor(tx, input.invoiceId);
  if (alreadyCredited + totals.totalMinor > invoiceTotalMinor) {
    throw new UserFacingError(
      `This would credit more than ${invoice.reference} charged. ` +
        `Invoice total ${toDecimalString(invoiceTotalMinor)}, already credited ${toDecimalString(alreadyCredited)}, ` +
        `this note ${toDecimalString(totals.totalMinor)}.`,
    );
  }

  const reference = await nextReference(tx, "CRN", new Date().getFullYear());
  const issuedOn = new Date();
  const supplyDate = input.supplyDate ?? invoice.supplyDate ?? dubaiDateKey(issuedOn);

  const [note] = await tx
    .insert(schema.creditNotes)
    .values({
      tenantId: ctx.tenantId,
      reference,
      documentType: "tax_credit_note",
      invoiceId: input.invoiceId,
      customerId: invoice.customerId,
      status: "issued",
      reason: input.reason,
      reasonDetail: input.reasonDetail ?? null,
      issuedOn,
      supplyDate,
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: toDecimalString(totals.discountMinor),
      taxableAmount: toDecimalString(totals.subtotalMinor - totals.discountMinor),
      taxRateBasisPoints: invoice.taxRateBasisPoints,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      currency: invoice.currency,
      sourceCurrency: invoice.sourceCurrency,
      exchangeRate: invoice.exchangeRate,
      exchangeRateSource: invoice.exchangeRateSource,
      taxCategoryCode: invoice.taxCategoryCode,
      supplierName: invoice.supplierName,
      supplierTrn: invoice.supplierTrn,
      supplierAddress: invoice.supplierAddress,
      supplierLicenceNumber: invoice.supplierLicenceNumber,
      supplierCrNumber: invoice.supplierCrNumber,
      supplierPhone: invoice.supplierPhone,
      supplierEmail: invoice.supplierEmail,
      supplierCountry: invoice.supplierCountry,
      recipientName: invoice.recipientName,
      recipientTrn: invoice.recipientTrn,
      recipientAddress: invoice.recipientAddress,
      recipientCountry: invoice.recipientCountry,
      issuedById: ctx.userId ?? null,
    })
    .returning({ id: schema.creditNotes.id });

  if (!note) throw new Error("Failed to create credit note");

  await tx.insert(schema.creditNoteLines).values(
    input.lines.map((l, i) => {
      const share = apportioned[i];
      return {
        tenantId: ctx.tenantId,
        creditNoteId: note.id,
        position: i + 1,
        serviceSlug: l.serviceSlug ?? null,
        description: l.description,
        quantity: l.quantity,
        unit: l.unit,
        unitCode: unitCodeFor(l.unit),
        unitPrice: toDecimalString(toMinor(l.unitPrice)),
        lineTotal: toDecimalString(share?.lineTotalMinor ?? 0),
        discountAmount: toDecimalString(share?.discountMinor ?? 0),
        netAmount: toDecimalString(share?.netMinor ?? 0),
        taxRateBasisPoints: invoice.taxRateBasisPoints,
        taxAmount: toDecimalString(share?.taxMinor ?? 0),
        taxCategoryCode: invoice.taxCategoryCode,
      };
    }),
  );

  // Only a full credit changes the invoice's status. A partial one leaves it
  // collectable, and `arAgeing` nets the credit off the outstanding balance
  // instead — marking a part-credited invoice "credited" would drop the rest of
  // the debt out of the ageing report entirely.
  if (alreadyCredited + totals.totalMinor >= invoiceTotalMinor) {
    await tx
      .update(schema.invoices)
      .set({ status: "credited", updatedAt: new Date() })
      .where(eq(schema.invoices.id, input.invoiceId));
  }

  return {
    creditNoteId: note.id,
    reference,
    totalMinor: totals.totalMinor,
    issuance: issuanceClock(supplyDate, dubaiDateKey(issuedOn)),
  };
}

export interface CreditNoteRow {
  readonly id: string;
  readonly reference: string;
  readonly invoiceReference: string;
  readonly reason: CreditReason;
  readonly reasonDetail: string | null;
  readonly total: string;
  readonly currency: string;
  readonly issuedOn: Date | null;
  readonly customerName: string;
}

export async function listCreditNotes(
  tx: TenantScopedTx,
  options?: { invoiceId?: string; limit?: number },
): Promise<readonly CreditNoteRow[]> {
  const scope = options?.invoiceId
    ? and(isNull(schema.creditNotes.deletedAt), eq(schema.creditNotes.invoiceId, options.invoiceId))
    : isNull(schema.creditNotes.deletedAt);

  const rows = await tx
    .select({
      id: schema.creditNotes.id,
      reference: schema.creditNotes.reference,
      invoiceReference: schema.invoices.reference,
      reason: schema.creditNotes.reason,
      reasonDetail: schema.creditNotes.reasonDetail,
      total: schema.creditNotes.total,
      currency: schema.creditNotes.currency,
      issuedOn: schema.creditNotes.issuedOn,
      customerName: schema.customers.name,
    })
    .from(schema.creditNotes)
    .innerJoin(schema.invoices, eq(schema.invoices.id, schema.creditNotes.invoiceId))
    .innerJoin(schema.customers, eq(schema.customers.id, schema.creditNotes.customerId))
    .where(scope)
    .orderBy(desc(schema.creditNotes.issuedOn))
    .limit(options?.limit ?? 100);

  return rows.map((r) => ({ ...r, reason: r.reason as CreditReason }));
}

// ── Credit position (DB-4, LEAD-10) ──────────────────────────────────────────

export interface CreditPosition {
  /** Null means no limit has been set, which is not the same as a limit of zero. */
  readonly creditLimitMinor: number | null;
  readonly outstandingMinor: number;
  /** Null when there is no limit to have headroom against. */
  readonly headroomMinor: number | null;
  readonly overLimit: boolean;
}

/**
 * A customer's credit limit and what is currently drawn against it.
 *
 * The limit is stored as `numeric(14,2)` like every other amount and converted
 * here, which is why there is no `credit_limit_minor` column: two columns
 * holding the same amount in two scales is how an off-by-one-hundred bug gets
 * written, and nothing fails when the two disagree.
 *
 * Written-off debt is excluded, and issued credit notes are netted off, so this
 * answers "how much would we be exposed to if we took this job" rather than
 * "what does the ledger add up to".
 */
export async function customerCreditPosition(
  tx: TenantScopedTx,
  customerId: string,
): Promise<CreditPosition> {
  const customerRows = await tx
    .select({ creditLimit: schema.customers.creditLimit })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);

  const invoiceRows = await tx
    .select({
      id: schema.invoices.id,
      total: schema.invoices.total,
      amountPaid: schema.invoices.amountPaid,
      status: schema.invoices.status,
    })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.customerId, customerId), isNull(schema.invoices.deletedAt)));

  const creditRows = await tx
    .select({ invoiceId: schema.creditNotes.invoiceId, total: schema.creditNotes.total })
    .from(schema.creditNotes)
    .where(and(eq(schema.creditNotes.customerId, customerId), isNull(schema.creditNotes.deletedAt)));

  const creditedByInvoice = new Map<string, number>();
  for (const c of creditRows) {
    creditedByInvoice.set(c.invoiceId, (creditedByInvoice.get(c.invoiceId) ?? 0) + toMinor(c.total));
  }

  let outstandingMinor = 0;
  for (const i of invoiceRows) {
    if (i.status === "paid" || i.status === "written_off" || i.status === "credited") continue;
    const owed = toMinor(i.total) - toMinor(i.amountPaid) - (creditedByInvoice.get(i.id) ?? 0);
    if (owed > 0) outstandingMinor += owed;
  }

  const limit = customerRows[0]?.creditLimit;
  const creditLimitMinor = limit === null || limit === undefined ? null : toMinor(limit);

  return {
    creditLimitMinor,
    outstandingMinor,
    headroomMinor: creditLimitMinor === null ? null : creditLimitMinor - outstandingMinor,
    overLimit: creditLimitMinor !== null && outstandingMinor > creditLimitMinor,
  };
}
