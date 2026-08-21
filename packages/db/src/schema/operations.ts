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
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import {
  idCol,
  timestamps,
  money,
  currencyCol,
  jobStatus,
  jobPriority,
  jobSource,
  visitStatus,
} from "./_shared";
import { tenants, users } from "./tenancy";
import { customers, properties, propertyUnits, assets } from "./crm";
import { technicians } from "./workforce";

/**
 * A job is one unit of work owed to a customer. It may take several visits
 * (parts on order, no access, multi-day works), which is why `job_visits` is a
 * separate table rather than a scheduled_at column on the job.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Sequential, tenant-scoped, human-quotable: "JOB-2026-04821". */
    reference: varchar("reference", { length: 32 }).notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "restrict" }),
    unitId: uuid("unit_id").references(() => propertyUnits.id, { onDelete: "set null" }),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    /** Catalogue slug — the taxonomy the website, dispatch and pricing share. */
    serviceSlug: varchar("service_slug", { length: 64 }).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    status: jobStatus("status").notNull().default("submitted"),
    priority: jobPriority("priority").notNull().default("p3_standard"),
    source: jobSource("source").notNull().default("web_quote"),
    contractId: uuid("contract_id"),
    projectId: uuid("project_id"),
    quoteId: uuid("quote_id"),
    /**
     * DB-6. Drives the summer midday ban (JOB-6).
     *
     * The ban applies to work in direct sun, not to a trade: painting a
     * stairwell is indoors, painting an elevation is not. Flagging per job
     * rather than per service is what lets the scheduler refuse the second and
     * allow the first — and getting it wrong in the permissive direction costs
     * AED 5,000 per worker.
     */
    isOutdoor: boolean("is_outdoor").notNull().default(false),
    /** JOB-13. Controlled list, set when the visit ends. */
    outcomeCode: varchar("outcome_code", { length: 32 }),
    /** SLA clock. Breach reporting compares actuals against these two. */
    respondByAt: timestamp("respond_by_at", { withTimezone: true }),
    resolveByAt: timestamp("resolve_by_at", { withTimezone: true }),
    firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    estimatedMinutes: integer("estimated_minutes"),
    actualMinutes: integer("actual_minutes"),
    quotedAmount: money("quoted_amount"),
    finalAmount: money("final_amount"),
    currency: currencyCol(),
    /** True when the work is covered by contract and not separately billable. */
    isContractCovered: boolean("is_contract_covered").notNull().default(false),
    requiresQuoteApproval: boolean("requires_quote_approval").notNull().default(false),
    customerRating: smallint("customer_rating"),
    customerFeedback: text("customer_feedback"),
    /** Set when a previous job for the same fault was reopened. */
    parentJobId: uuid("parent_job_id"),
    isRevisit: boolean("is_revisit").notNull().default(false),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /** AI triage output: suggested trade, priority, duration, and why. */
    aiTriage: jsonb("ai_triage"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("jobs_tenant_reference_key").on(t.tenantId, t.reference),
    // The dispatch board's primary query.
    index("jobs_board_idx").on(t.tenantId, t.status, t.priority, t.scheduledFor),
    index("jobs_customer_idx").on(t.tenantId, t.customerId, t.createdAt),
    index("jobs_property_idx").on(t.tenantId, t.propertyId),
    index("jobs_service_idx").on(t.tenantId, t.serviceSlug),
    index("jobs_sla_idx").on(t.tenantId, t.resolveByAt, t.status),
    index("jobs_contract_idx").on(t.tenantId, t.contractId),
  ],
);

/** One technician attendance at a job. Multiple visits per job is the norm. */
export const jobVisits = pgTable(
  "job_visits",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "restrict" }),
    sequence: smallint("sequence").notNull().default(1),
    status: visitStatus("status").notNull().default("assigned"),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    enRouteAt: timestamp("en_route_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    arrivalLat: doublePrecision("arrival_lat"),
    arrivalLng: doublePrecision("arrival_lng"),
    withinGeofence: boolean("within_geofence"),
    travelMinutes: integer("travel_minutes"),
    workMinutes: integer("work_minutes"),
    /** Why the visit did not complete: no access, parts, customer deferred. */
    outcomeNote: text("outcome_note"),
    /**
     * How this assignment was made. Distinguishing AI from human assignment is
     * what lets us measure whether the optimiser is actually beating the
     * dispatcher before we trust it with more of the board.
     */
    assignmentMethod: varchar("assignment_method", { length: 24 }).notNull().default("manual"),
    assignmentScore: doublePrecision("assignment_score"),
    assignmentReason: text("assignment_reason"),
    /**
     * JOB-10. What warning was overridden, and why.
     *
     * The audit found overrides were silent, and a silent override is
     * indistinguishable from a mistake. Overriding is often the right call — a
     * technician twelve minutes away whose certificate expires in twelve days
     * is usually the correct answer — but it is a decision, and it is recorded
     * as one so it can be reviewed and counted.
     */
    overrideWarningType: varchar("override_warning_type", { length: 48 }),
    overrideReason: text("override_reason"),
    assignedById: uuid("assigned_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("job_visits_seq_key").on(t.tenantId, t.jobId, t.sequence),
    index("job_visits_tech_window_idx").on(t.tenantId, t.technicianId, t.scheduledStart),
    index("job_visits_status_idx").on(t.tenantId, t.status),
  ],
);

/** The digital job card: what the technician found and did, in their words. */
export const jobReports = pgTable(
  "job_reports",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "cascade" }),
    faultFound: text("fault_found"),
    workCarriedOut: text("work_carried_out"),
    recommendation: text("recommendation"),
    /** Technician's own words, before AI cleanup. Never overwritten. */
    rawNotes: text("raw_notes"),
    /** Customer-facing summary generated from rawNotes. Reviewable, not silent. */
    aiSummary: text("ai_summary"),
    aiSummaryApprovedById: uuid("ai_summary_approved_by_id").references(() => users.id, { onDelete: "set null" }),
    followUpRequired: boolean("follow_up_required").notNull().default(false),
    followUpReason: text("follow_up_reason"),
    ...timestamps,
  },
  (t) => [index("job_reports_job_idx").on(t.tenantId, t.jobId)],
);

/** Photos, documents and signatures. Files live in object storage; keys here. */
export const jobAttachments = pgTable(
  "job_attachments",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "set null" }),
    /** "photo_before" | "photo_after" | "signature" | "document" | "video" */
    kind: varchar("kind", { length: 24 }).notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: varchar("mime_type", { length: 80 }),
    sizeBytes: integer("size_bytes"),
    caption: text("caption"),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    capturedLat: doublePrecision("captured_lat"),
    capturedLng: doublePrecision("captured_lng"),
    uploadedById: uuid("uploaded_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("job_attachments_job_idx").on(t.tenantId, t.jobId, t.kind)],
);

/** Signature capture, kept separate because it carries legal weight. */
export const jobSignoffs = pgTable(
  "job_signoffs",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "set null" }),
    signedByName: varchar("signed_by_name", { length: 160 }).notNull(),
    signedByRole: varchar("signed_by_role", { length: 80 }),
    signatureStorageKey: text("signature_storage_key").notNull(),
    satisfactionRating: smallint("satisfaction_rating"),
    comments: text("comments"),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    signedLat: doublePrecision("signed_lat"),
    signedLng: doublePrecision("signed_lng"),
    ipAddress: varchar("ip_address", { length: 45 }),
    ...timestamps,
  },
  (t) => [index("job_signoffs_job_idx").on(t.tenantId, t.jobId)],
);

/** Parts and consumables consumed on a job — feeds costing and reordering. */
export const jobMaterials = pgTable(
  "job_materials",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "set null" }),
    sku: varchar("sku", { length: 64 }),
    description: varchar("description", { length: 240 }).notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("1"),
    unit: varchar("unit", { length: 16 }).notNull().default("ea"),
    unitCost: money("unit_cost"),
    unitPrice: money("unit_price"),
    currency: currencyCol(),
    isBillable: boolean("is_billable").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("job_materials_job_idx").on(t.tenantId, t.jobId)],
);

/** Status transitions, so "why did this job sit for three days" is answerable. */
export const jobEvents = pgTable(
  "job_events",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    fromStatus: varchar("from_status", { length: 32 }),
    toStatus: varchar("to_status", { length: 32 }).notNull(),
    note: text("note"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** "user" | "system" | "ai" | "customer" — who or what caused the change. */
    actorKind: varchar("actor_kind", { length: 16 }).notNull().default("user"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_events_job_time_idx").on(t.tenantId, t.jobId, t.occurredAt)],
);
