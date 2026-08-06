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
    /** Provenance when a draft was AI-generated: model, prompt hash, confidence. */
    aiGeneration: jsonb("ai_generation"),
    preparedById: uuid("prepared_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("quotes_tenant_reference_key").on(t.tenantId, t.reference),
    index("quotes_tenant_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("quotes_customer_idx").on(t.tenantId, t.customerId),
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
    /** Tax registration number captured at issue time, not read from the
     *  customer record — a reissued invoice must show the historical TRN. */
    customerTrn: varchar("customer_trn", { length: 32 }),
    pdfStorageKey: text("pdf_storage_key"),
    notes: text("notes"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
    reminderCount: smallint("reminder_count").notNull().default(0),
    writtenOffReason: text("written_off_reason"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("invoices_tenant_reference_key").on(t.tenantId, t.reference),
    index("invoices_tenant_status_idx").on(t.tenantId, t.status, t.dueOn),
    index("invoices_customer_idx").on(t.tenantId, t.customerId),
    // The overdue/AR ageing report.
    index("invoices_ageing_idx").on(t.tenantId, t.dueOn, t.status),
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
