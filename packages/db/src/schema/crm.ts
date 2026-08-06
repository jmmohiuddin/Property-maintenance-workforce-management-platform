import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  uuid,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol, timestamps, money, currencyCol, propertyType, leadStage, assetCondition } from "./_shared";
import { tenants, users } from "./tenancy";

/**
 * A customer is the paying entity — a developer, an owners association, a
 * property management company, a hotel group, or a private individual.
 * Properties hang off customers; jobs hang off properties.
 */
export const customers = pgTable(
  "customers",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Human-readable, tenant-unique. Appears on invoices and job cards. */
    code: varchar("code", { length: 32 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    isCompany: boolean("is_company").notNull().default(true),
    industry: varchar("industry", { length: 80 }),
    taxRegistrationNumber: varchar("trn", { length: 32 }),
    billingEmail: varchar("billing_email", { length: 200 }),
    phone: varchar("phone", { length: 24 }),
    /** Days. Drives invoice due dates and the overdue report. */
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    creditLimit: money("credit_limit"),
    currency: currencyCol(),
    accountManagerId: uuid("account_manager_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("customers_tenant_code_key").on(t.tenantId, t.code),
    index("customers_tenant_name_idx").on(t.tenantId, t.name),
  ],
);

export const customerContacts = pgTable(
  "customer_contacts",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    role: varchar("role", { length: 80 }),
    email: varchar("email", { length: 200 }),
    phone: varchar("phone", { length: 24 }),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Receives job status notifications for this customer's properties. */
    notifyOnJobs: boolean("notify_on_jobs").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("customer_contacts_customer_idx").on(t.tenantId, t.customerId)],
);

/** A building, villa, tower or site. The unit of dispatch geography. */
export const properties = pgTable(
  "properties",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    name: varchar("name", { length: 200 }).notNull(),
    type: propertyType("type").notNull().default("apartment"),
    addressLine: text("address_line").notNull(),
    area: varchar("area", { length: 120 }),
    city: varchar("city", { length: 80 }).notNull(),
    country: varchar("country", { length: 2 }).notNull().default("AE"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** Gate codes, parking, security desk process, escort requirements. */
    accessInstructions: text("access_instructions"),
    floors: integer("floors"),
    unitCount: integer("unit_count"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("properties_tenant_customer_idx").on(t.tenantId, t.customerId),
    index("properties_tenant_city_idx").on(t.tenantId, t.city),
    // Dispatch queries "nearest technician to this property" constantly.
    index("properties_geo_idx").on(t.lat, t.lng),
  ],
);

/** Individual apartment/office within a property, where jobs are unit-level. */
export const propertyUnits = pgTable(
  "property_units",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 40 }).notNull(),
    floor: varchar("floor", { length: 16 }),
    occupantName: varchar("occupant_name", { length: 160 }),
    occupantPhone: varchar("occupant_phone", { length: 24 }),
    ...timestamps,
  },
  (t) => [uniqueIndex("property_units_ref_key").on(t.tenantId, t.propertyId, t.reference)],
);

/**
 * Asset register. Building maintenance and AMC pricing both depend on knowing
 * what plant exists, so this is a first-class table rather than a JSON blob.
 */
export const assets = pgTable(
  "assets",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => propertyUnits.id, { onDelete: "set null" }),
    tag: varchar("tag", { length: 48 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    /** Matches a catalogue service slug, e.g. "hvac-ac-maintenance". */
    serviceSlug: varchar("service_slug", { length: 64 }),
    manufacturer: varchar("manufacturer", { length: 120 }),
    model: varchar("model", { length: 120 }),
    serialNumber: varchar("serial_number", { length: 120 }),
    location: varchar("location", { length: 160 }),
    installedOn: timestamp("installed_on", { withTimezone: true }),
    warrantyExpiresOn: timestamp("warranty_expires_on", { withTimezone: true }),
    condition: assetCondition("condition").notNull().default("good"),
    /** Days between planned maintenance visits for this asset. */
    ppmIntervalDays: integer("ppm_interval_days"),
    lastServicedAt: timestamp("last_serviced_at", { withTimezone: true }),
    nextServiceDueAt: timestamp("next_service_due_at", { withTimezone: true }),
    specs: jsonb("specs").notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("assets_tenant_tag_key").on(t.tenantId, t.tag),
    index("assets_property_idx").on(t.tenantId, t.propertyId),
    // Drives the "what PPM is due" job generator.
    index("assets_due_idx").on(t.tenantId, t.nextServiceDueAt),
  ],
);

/** Pre-sale pipeline. Converts to a customer + quote when qualified. */
export const leads = pgTable(
  "leads",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    companyName: varchar("company_name", { length: 200 }),
    email: varchar("email", { length: 200 }),
    phone: varchar("phone", { length: 24 }),
    /** Catalogue slug the enquiry came in against. */
    serviceSlug: varchar("service_slug", { length: 64 }),
    city: varchar("city", { length: 80 }),
    area: varchar("area", { length: 120 }),
    propertyTypeGuess: propertyType("property_type_guess"),
    stage: leadStage("stage").notNull().default("new"),
    /** 0–100, produced by the AI lead-scoring job. Null until scored. */
    score: integer("score"),
    scoreReason: text("score_reason"),
    estimatedValue: money("estimated_value"),
    currency: currencyCol(),
    source: varchar("source", { length: 64 }).notNull().default("website"),
    /** utm_source / medium / campaign / gclid, kept for attribution reporting. */
    attribution: jsonb("attribution").notNull().default({}),
    message: text("message"),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    convertedCustomerId: uuid("converted_customer_id").references(() => customers.id, { onDelete: "set null" }),
    lostReason: text("lost_reason"),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("leads_tenant_stage_idx").on(t.tenantId, t.stage),
    index("leads_followup_idx").on(t.tenantId, t.nextFollowUpAt),
    index("leads_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

/** Every outbound/inbound touch, so history survives staff turnover. */
export const communications = pgTable(
  "communications",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "cascade" }),
    jobId: uuid("job_id"),
    channel: varchar("channel", { length: 24 }).notNull(),
    direction: varchar("direction", { length: 8 }).notNull(),
    subject: varchar("subject", { length: 240 }),
    body: text("body"),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    /** True when generated by an AI agent rather than a person. */
    isAutomated: boolean("is_automated").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index("communications_customer_idx").on(t.tenantId, t.customerId, t.occurredAt),
    index("communications_lead_idx").on(t.tenantId, t.leadId, t.occurredAt),
    index("communications_job_idx").on(t.tenantId, t.jobId),
  ],
);
