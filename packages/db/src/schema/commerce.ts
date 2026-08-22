import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  timestamp,
  uuid,
  jsonb,
  numeric,
  date,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  idCol,
  timestamps,
  money,
  currencyCol,
  quoteStatus,
  contractStatus,
  invoiceStatus,
  paymentMethod,
} from "./_shared";
import { tenants, users } from "./tenancy";
import { customers, properties, leads } from "./crm";
import { jobs } from "./operations";

export const quotes = pgTable(
  "quotes",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 32 }).notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    title: varchar("title", { length: 240 }).notNull(),
    status: quoteStatus("status").notNull().default("draft"),
    /** Sums of the lines. Stored, not computed on read — the numbers on a sent
     *  quote must never change because a line's price was later edited. */
    subtotal: money("subtotal").notNull().default("0"),
    discountAmount: money("discount_amount").notNull().default("0"),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull().default(500),
    taxAmount: money("tax_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    currency: currencyCol(),
    validUntil: timestamp("valid_until", { withTimezone: true }),
    termsText: text("terms_text"),
    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    /** Portal approval token — single-use, hashed. */
    approvalTokenHash: text("approval_token_hash"),
    supersedesQuoteId: uuid("supersedes_quote_id"),
    /**
     * `QTE-5`. Basis points, matching `contract_terms.discount_rate_basis_points`
     * — set only when `discountAmount` came from a contract rate rather than
     * being typed in by an operator. Null means the discount (if any) is manual.
     */
    discountBasisPoints: integer("discount_basis_points"),
    /**
     * Where `discountAmount` came from, in words a customer-facing document can
     * show beside the figure — the contract reference and rate, snapshotted at
     * creation so a later contract renegotiation cannot rewrite what this quote
     * says it applied. Null when the discount is manual or there is none.
     */
    discountSource: varchar("discount_source", { length: 160 }),
    /** Provenance when a draft was AI-generated: model, prompt hash, confidence. */
    aiGeneration: jsonb("ai_generation"),

    // QTE-3 / DB-2. The rendered quotation and the hash of its bytes.
    //
    // Stored rather than re-rendered, for the reason TRD §7.6 gives: the
    // customer accepted a specific document, and a template change six months
    // later must not alter what they can be shown to have agreed to. Both
    // columns are set together and neither can be changed afterwards — the
    // 0010 migration holds both rules.
    pdfStorageKey: text("pdf_storage_key"),
    pdfSha256: varchar("pdf_sha256", { length: 64 }),
    pdfRenderedAt: timestamp("pdf_rendered_at", { withTimezone: true }),

    preparedById: uuid("prepared_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("quotes_tenant_reference_key").on(t.tenantId, t.reference),
    index("quotes_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("quotes_customer_idx").on(t.tenantId, t.customerId),
    // QTE-10: walking a revision chain (who superseded whom) without a scan.
    index("quotes_supersedes_idx").on(t.tenantId, t.supersedesQuoteId),
  ],
);

export const quoteLines = pgTable(
  "quote_lines",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "cascade" }),
    position: smallint("position").notNull().default(1),
    serviceSlug: varchar("service_slug", { length: 64 }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("1"),
    unit: varchar("unit", { length: 24 }).notNull().default("ea"),
    unitPrice: money("unit_price").notNull().default("0"),
    lineTotal: money("line_total").notNull().default("0"),
    isOptional: boolean("is_optional").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("quote_lines_quote_idx").on(t.tenantId, t.quoteId, t.position)],
);

/**
 * An AMC or FM contract. `visitsPerYear` and `coveredServices` are what the PPM
 * generator reads to create scheduled jobs, so they are columns rather than
 * free text in the contract document.
 */
export const contracts = pgTable(
  "contracts",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 32 }).notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 240 }).notNull(),
    /** "amc" | "facility_management" | "building_maintenance" | "workforce_supply" */
    kind: varchar("kind", { length: 32 }).notNull().default("amc"),
    status: contractStatus("status").notNull().default("draft"),
    startsOn: timestamp("starts_on", { withTimezone: true }).notNull(),
    endsOn: timestamp("ends_on", { withTimezone: true }).notNull(),
    annualValue: money("annual_value").notNull().default("0"),
    currency: currencyCol(),
    /** "monthly" | "quarterly" | "annually" | "on_completion" */
    billingFrequency: varchar("billing_frequency", { length: 24 }).notNull().default("annually"),
    visitsPerYear: smallint("visits_per_year").notNull().default(4),
    /** Catalogue slugs covered by this contract. */
    coveredServices: jsonb("covered_services").notNull().default([]),
    /** Explicit carve-outs, shown verbatim to the customer in the portal. */
    exclusions: jsonb("exclusions").notNull().default([]),
    includesEmergencyCallouts: boolean("includes_emergency_callouts").notNull().default(true),
    /** SLA targets in minutes, by priority. Drives job respond_by/resolve_by. */
    slaTargets: jsonb("sla_targets").notNull().default({}),
    autoRenew: boolean("auto_renew").notNull().default(false),
    renewalNoticeDays: smallint("renewal_notice_days").notNull().default(30),
    renewedFromContractId: uuid("renewed_from_contract_id"),
    documentStorageKey: text("document_storage_key"),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    /** AI contract review output: extracted obligations, risk flags. Advisory. */
    aiAnalysis: jsonb("ai_analysis"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contracts_tenant_reference_key").on(t.tenantId, t.reference),
    index("contracts_tenant_status_idx").on(t.tenantId, t.status),
    // Drives the renewals dashboard and the auto-renewal notice job.
    index("contracts_expiry_idx").on(t.tenantId, t.endsOn, t.status),
    index("contracts_customer_idx").on(t.tenantId, t.customerId),
  ],
);

/** Which properties a contract covers, and at what visit frequency. */
export const contractProperties = pgTable(
  "contract_properties",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    visitsPerYear: smallint("visits_per_year"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("contract_properties_key").on(t.tenantId, t.contractId, t.propertyId)],
);

/**
 * The planned PPM calendar. Rows are created ahead of time so the schedule is
 * visible and adjustable, then linked to a real job when generated.
 */
export const contractVisits = pgTable(
  "contract_visits",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    dueOn: timestamp("due_on", { withTimezone: true }).notNull(),
    serviceSlug: varchar("service_slug", { length: 64 }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** "planned" | "generated" | "completed" | "skipped" */
    status: varchar("status", { length: 16 }).notNull().default("planned"),
    skippedReason: text("skipped_reason"),
    ...timestamps,
  },
  (t) => [
    index("contract_visits_due_idx").on(t.tenantId, t.dueOn, t.status),
    index("contract_visits_contract_idx").on(t.tenantId, t.contractId),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 32 }).notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    contractId: uuid("contract_id").references(() => contracts.id, { onDelete: "set null" }),
    quoteId: uuid("quote_id").references(() => quotes.id, { onDelete: "set null" }),
    status: invoiceStatus("status").notNull().default("draft"),
    issuedOn: timestamp("issued_on", { withTimezone: true }),
    dueOn: timestamp("due_on", { withTimezone: true }),
    subtotal: money("subtotal").notNull().default("0"),
    discountAmount: money("discount_amount").notNull().default("0"),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull().default(500),
    taxAmount: money("tax_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    amountPaid: money("amount_paid").notNull().default("0"),
    currency: currencyCol(),

    // ── Article 59 / PINT AE (INV-3, INV-9, DB-3) ──────────────────────────
    //
    // The supplier and recipient blocks are SNAPSHOTS taken at issue, not joins
    // to the customer record or reads of `company.ts`. An invoice is a legal
    // artefact: reprinting a 2026 document after the office moves or the TRN is
    // reissued must still show what it showed in 2026, and deriving it from
    // current configuration would rewrite history invisibly.

    /** "tax_invoice". The words Article 59 requires on the face of the
     *  document. Simplified is a rendering variant decided from the recipient's
     *  TRN and the consideration (INV-6), never a stored second kind. */
    documentType: varchar("document_type", { length: 24 }).notNull().default("tax_invoice"),
    /** Date of supply. Required alongside the issue date where they differ, and
     *  the date INV-5's 14-day clock runs from. ISO date string. */
    supplyDate: date("supply_date"),

    supplierName: varchar("supplier_name", { length: 200 }),
    supplierTrn: varchar("supplier_trn", { length: 15 }),
    supplierAddress: text("supplier_address"),
    supplierLicenceNumber: varchar("supplier_licence_number", { length: 32 }),
    supplierCrNumber: varchar("supplier_cr_number", { length: 32 }),
    supplierPhone: varchar("supplier_phone", { length: 24 }),
    supplierEmail: varchar("supplier_email", { length: 200 }),
    supplierCountry: varchar("supplier_country", { length: 2 }).notNull().default("AE"),

    recipientName: varchar("recipient_name", { length: 200 }),
    /** Null means the recipient is not VAT-registered, which is what permits a
     *  simplified invoice at any value under INV-6. */
    recipientTrn: varchar("recipient_trn", { length: 15 }),
    recipientAddress: text("recipient_address"),
    recipientCountry: varchar("recipient_country", { length: 2 }).notNull().default("AE"),

    /** Tax-exclusive amount after discount. Stored rather than derived for the
     *  same reason the other totals are: it is what the document said. */
    taxableAmount: money("taxable_amount").notNull().default("0"),

    /** Article 59 requires the rate where any amount originates in another
     *  currency. The rate that applied on the date of supply cannot be looked
     *  up afterwards, so it is captured or it is lost. */
    sourceCurrency: varchar("source_currency", { length: 3 }),
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }),
    exchangeRateSource: varchar("exchange_rate_source", { length: 80 }),

    /** UNCL5305. "S" standard-rated, "Z" zero-rated, "E" exempt. */
    taxCategoryCode: varchar("tax_category_code", { length: 4 }).notNull().default("S"),
    /** UNCL4461. "30" is credit transfer. PINT AE mandatory. */
    paymentMeansCode: varchar("payment_means_code", { length: 4 }).notNull().default("30"),
    paymentTermsDays: smallint("payment_terms_days"),

    /** The customer's own reference. An owners association will not pay an
     *  invoice that does not quote it back at them. */
    buyerReference: varchar("buyer_reference", { length: 64 }),
    purchaseOrderReference: varchar("purchase_order_reference", { length: 64 }),

    issuedById: uuid("issued_by_id").references(() => users.id, { onDelete: "set null" }),

    // INV-3 / DB-2. `pdf_storage_key` has existed since 0000 and nothing wrote
    // to it (`TD-14`); 0010 gives it the hash that makes the artefact
    // evidential and the trigger that makes both write-once.
    pdfStorageKey: text("pdf_storage_key"),
    pdfSha256: varchar("pdf_sha256", { length: 64 }),
    pdfRenderedAt: timestamp("pdf_rendered_at", { withTimezone: true }),

    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    reminderCount: smallint("reminder_count").notNull().default(0),
    writtenOffReason: text("written_off_reason"),
    /**
     * When the business stopped pursuing this debt (`0031`).
     *
     * Its position in the customer's statement ledger, which is why it is a
     * column of its own and not `updated_at`: that timestamp moves on a
     * re-rendered PDF or a reminder count, and a write-off filed at the wrong
     * date makes the running balance wrong for every row after it.
     *
     * `invoices_written_off_date` makes it compulsory whenever `status` is
     * `written_off`, so the ledger can never carry an undated write-off.
     */
    writtenOffAt: timestamp("written_off_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoices_tenant_reference_key").on(t.tenantId, t.reference),
    index("invoices_tenant_status_idx").on(t.tenantId, t.status, t.dueOn),
    index("invoices_customer_idx").on(t.tenantId, t.customerId),
    // The overdue/AR ageing report.
    index("invoices_ageing_idx").on(t.tenantId, t.dueOn, t.status),
    // INV-4's gap report reads the issued series in reference order.
    index("invoices_series_idx").on(t.tenantId, t.documentType, t.reference),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    position: smallint("position").notNull().default(1),
    serviceSlug: varchar("service_slug", { length: 64 }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("1"),
    unit: varchar("unit", { length: 24 }).notNull().default("ea"),
    unitPrice: money("unit_price").notNull().default("0"),
    lineTotal: money("line_total").notNull().default("0"),

    // Article 59 requires the tax rate and the tax amount IN AED on every line,
    // which the original table omitted.
    //
    // Nullable on purpose. Lines written before 0007 have no per-line tax, and
    // apportioning a document-level discount across them retrospectively would
    // put numbers on a reprint that were never on the original. A null is
    // refused by the render check in core, which is the honest outcome; a
    // default of zero would instead assert that no tax was charged.
    discountAmount: money("discount_amount"),
    netAmount: money("net_amount"),
    taxRateBasisPoints: integer("tax_rate_basis_points"),
    taxAmount: money("tax_amount"),
    taxCategoryCode: varchar("tax_category_code", { length: 4 }).notNull().default("S"),
    /** UN/ECE Rec 20 code — "MTK", "HUR", "H87". PINT AE will not accept the
     *  human-readable `unit`, and the customer will not read the code. */
    unitCode: varchar("unit_code", { length: 8 }),
    /** Which job this line billed, so a disputed line opens the job it came
     *  from and the screen can group lines by job. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.tenantId, t.invoiceId, t.position)],
);

export const payments = pgTable(
  "payments",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    amount: money("amount").notNull(),
    currency: currencyCol(),
    method: paymentMethod("method").notNull().default("bank_transfer"),
    reference: varchar("reference", { length: 120 }),
    gatewayProvider: varchar("gateway_provider", { length: 40 }),
    gatewayPaymentId: varchar("gateway_payment_id", { length: 120 }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    recordedById: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("payments_invoice_idx").on(t.tenantId, t.invoiceId),
    // Gateway webhooks retry; this makes replay a no-op rather than a duplicate.
    uniqueIndex("payments_gateway_key").on(t.tenantId, t.gatewayProvider, t.gatewayPaymentId),
  ],
);

/**
 * Tax credit notes (`INV-7`).
 *
 * Any reduction in output tax — a return, a post-issue discount, a cancellation
 * or a correction — requires a credit note, issued within 14 days, referencing
 * the original invoice, in its own sequential series.
 *
 * ── WHY THIS IS NOT A NEGATIVE ROW IN `invoices` ────────────────────────────
 *
 * Every query over `invoices` today assumes each row is money owed to the
 * business: AR ageing, the overdue sweep, the reminder cron, the gap report
 * over the INV series. A negative-signed second document type would change what
 * all of them mean at once, and the first symptom would be an ageing report
 * that quietly stopped reconciling.
 *
 * This does not contradict `INV-6`'s "never a second object". That rule is
 * about the simplified invoice — the *same* document rendered with fewer
 * fields, abolished in 2027. A credit note is a different legal document with
 * its own mandatory series and its own 14-day clock. Both tables feed one
 * document model in `@meridian/core`, so there is still one renderer and one
 * validation schema.
 */
export const creditNotes = pgTable(
  "credit_notes",
  {
    // tenant_id first, so the generic policy loop in sql/rls.sql covers this
    // table the moment it is re-run rather than when somebody remembers.
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Own series, "CRN". Sharing the INV series would put gaps in it, and a
     *  gap in the invoice sequence is an FTA audit flag (`INV-4`). */
    reference: varchar("reference", { length: 32 }).notNull(),
    documentType: varchar("document_type", { length: 24 }).notNull().default("tax_credit_note"),
    /** Article 60 requires the reference to the original invoice. */
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    status: varchar("status", { length: 16 }).notNull().default("issued"),
    /** "return" | "discount" | "cancellation" | "correction". Mandatory —
     *  output tax reduced without a recorded cause is exactly the entry an
     *  auditor asks about, and reconstructing it two years later is guesswork. */
    reason: varchar("reason", { length: 32 }).notNull(),
    reasonDetail: text("reason_detail"),
    issuedOn: timestamp("issued_on", { withTimezone: true }),
    /** The date of the event being credited. The 14-day clock runs from here. */
    supplyDate: date("supply_date"),

    subtotal: money("subtotal").notNull().default("0"),
    discountAmount: money("discount_amount").notNull().default("0"),
    taxableAmount: money("taxable_amount").notNull().default("0"),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull().default(500),
    taxAmount: money("tax_amount").notNull().default("0"),
    /** Positive, like the invoice it credits. The sign lives in the document
     *  type, not in the number: a stored negative gets double-negated the first
     *  time somebody writes `total - credited`, and it looks right. */
    total: money("total").notNull().default("0"),
    currency: currencyCol(),
    sourceCurrency: varchar("source_currency", { length: 3 }),
    exchangeRate: numeric("exchange_rate", { precision: 18, scale: 6 }),
    exchangeRateSource: varchar("exchange_rate_source", { length: 80 }),
    taxCategoryCode: varchar("tax_category_code", { length: 4 }).notNull().default("S"),

    supplierName: varchar("supplier_name", { length: 200 }),
    supplierTrn: varchar("supplier_trn", { length: 15 }),
    supplierAddress: text("supplier_address"),
    supplierLicenceNumber: varchar("supplier_licence_number", { length: 32 }),
    supplierCrNumber: varchar("supplier_cr_number", { length: 32 }),
    supplierPhone: varchar("supplier_phone", { length: 24 }),
    supplierEmail: varchar("supplier_email", { length: 200 }),
    supplierCountry: varchar("supplier_country", { length: 2 }).notNull().default("AE"),

    recipientName: varchar("recipient_name", { length: 200 }),
    recipientTrn: varchar("recipient_trn", { length: 15 }),
    recipientAddress: text("recipient_address"),
    recipientCountry: varchar("recipient_country", { length: 2 }).notNull().default("AE"),

    // INV-7. Same pair as the invoice: a credit note is a tax document in its
    // own right and carries its own artefact.
    pdfStorageKey: text("pdf_storage_key"),
    pdfSha256: varchar("pdf_sha256", { length: 64 }),
    pdfRenderedAt: timestamp("pdf_rendered_at", { withTimezone: true }),

    issuedById: uuid("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("credit_notes_tenant_reference_key").on(t.tenantId, t.reference),
    index("credit_notes_invoice_idx").on(t.tenantId, t.invoiceId),
    index("credit_notes_customer_idx").on(t.tenantId, t.customerId, t.issuedOn),
  ],
);

export const creditNoteLines = pgTable(
  "credit_note_lines",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    creditNoteId: uuid("credit_note_id")
      .notNull()
      .references(() => creditNotes.id, { onDelete: "cascade" }),
    position: smallint("position").notNull().default(1),
    serviceSlug: varchar("service_slug", { length: 64 }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("1"),
    unit: varchar("unit", { length: 24 }).notNull().default("ea"),
    unitCode: varchar("unit_code", { length: 8 }),
    unitPrice: money("unit_price").notNull().default("0"),
    lineTotal: money("line_total").notNull().default("0"),
    // Not nullable here, unlike invoice_lines: this table has no history to be
    // honest about. Every row it will ever hold is written by code that knows
    // the per-line tax.
    discountAmount: money("discount_amount").notNull().default("0"),
    netAmount: money("net_amount").notNull().default("0"),
    taxRateBasisPoints: integer("tax_rate_basis_points").notNull().default(500),
    taxAmount: money("tax_amount").notNull().default("0"),
    taxCategoryCode: varchar("tax_category_code", { length: 4 }).notNull().default("S"),
    ...timestamps,
  },
  (t) => [index("credit_note_lines_note_idx").on(t.tenantId, t.creditNoteId, t.position)],
);
