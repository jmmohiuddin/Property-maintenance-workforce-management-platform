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
 * Raise an invoice against a job.
 *
 * The customer's tax registration number is copied onto the invoice at issue
 * time rather than read from the customer record on display. A reissued or
 * reprinted invoice has to show the TRN that applied when it was raised, not
 * whatever the customer record says today.
 */
export async function createInvoiceFromJob(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { jobId: string; lines: readonly DraftLine[]; discount?: string | undefined },
): Promise<{ invoiceId: string; reference: string; totalMinor: number }> {
  if (input.lines.length === 0) throw new UserFacingError("An invoice needs at least one line");

  const jobRows = await tx
    .select({
      customerId: schema.jobs.customerId,
      status: schema.jobs.status,
      serviceSlug: schema.jobs.serviceSlug,
      trn: schema.customers.taxRegistrationNumber,
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

  const totals = computeTotals({
    lines: lineInputs,
    discountMinor: input.discount ? toMinor(input.discount) : 0,
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  const reference = await nextReference(tx, "INV", new Date().getFullYear());
  const issuedOn = new Date();
  const dueOn = new Date(issuedOn.getTime() + (job.terms ?? 30) * 24 * 60 * 60 * 1000);

  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: job.customerId,
      jobId: input.jobId,
      status: "issued",
      issuedOn,
      dueOn,
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: toDecimalString(totals.discountMinor),
      taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      amountPaid: "0.00",
      customerTrn: job.trn,
    })
    .returning({ id: schema.invoices.id });

  if (!invoice) throw new Error("Failed to create invoice");

  await tx.insert(schema.invoiceLines).values(
    input.lines.map((l, i) => ({
      tenantId: ctx.tenantId,
      invoiceId: invoice.id,
      position: i + 1,
      serviceSlug: l.serviceSlug ?? job.serviceSlug,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: toDecimalString(toMinor(l.unitPrice)),
      lineTotal: toDecimalString(lineInputs[i] ? computeTotals({ lines: [lineInputs[i]!], taxRateBasisPoints: 0 }).subtotalMinor : 0),
    })),
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
      total: schema.invoices.total,
      amountPaid: schema.invoices.amountPaid,
      dueOn: schema.invoices.dueOn,
      status: schema.invoices.status,
    })
    .from(schema.invoices)
    .where(isNull(schema.invoices.deletedAt));

  let currentMinor = 0;
  let days1to30Minor = 0;
  let days31to60Minor = 0;
  let days61PlusMinor = 0;

  for (const r of rows) {
    if (r.status === "paid" || r.status === "written_off" || r.status === "credited") continue;
    const outstanding = toMinor(r.total) - toMinor(r.amountPaid);
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
