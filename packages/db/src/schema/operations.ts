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
import { faultCodes } from "./reference";

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

/**
 * The three-part fault diagnosis recorded against a job (`JOB-14`).
 *
 * ── WHY A ROW PER PART AND NOT THREE COLUMNS ON `jobs` ──────────────────────
 *
 * Three columns would have been less code. They would also have said that a
 * job has exactly one symptom, forever — and the multi-visit case `JOB-12`
 * exists for is precisely the one where that is false: a chiller that trips on
 * Monday for a blocked filter and on Thursday for a failed contactor is two
 * diagnoses, and flattening it to one is the loss the taxonomy was built to
 * prevent. `visit_id` is what keeps them apart, and it is nullable because a
 * single-visit job has no choice to make.
 *
 * `fault_code_id` is a real foreign key with `ON DELETE restrict`, matching how
 * `lead_disposition_reasons` is referenced: a code cited by last quarter's work
 * cannot be deleted without rewriting last quarter, so the admin screen
 * deactivates instead — it disappears from the picker and stays in the data.
 *
 * `kind` is denormalised from `fault_codes.kind` deliberately. It is what the
 * unique index groups on, so "one symptom, one cause, one remedy per visit" is
 * a constraint the database holds rather than a rule the application remembers.
 */
export const jobFaultCodes = pgTable(
  "job_fault_codes",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "set null" }),
    faultCodeId: uuid("fault_code_id")
      .notNull()
      .references(() => faultCodes.id, { onDelete: "restrict" }),
    /** `symptom` | `cause` | `remedy`, copied from the code it points at. */
    kind: varchar("kind", { length: 8 }).notNull(),
    /** The technician's words. Beside the codes, never instead of them. */
    note: text("note"),
    recordedById: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
    // Written out rather than the shared `timestamps` spread, because this
    // table has no soft delete and should not gain one. Re-recording a
    // diagnosis replaces it; a `deleted_at` column would leave the superseded
    // symptom in the table for every reliability query that forgot to filter,
    // which is the one query this table exists to answer correctly.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("job_fault_codes_job_idx").on(t.tenantId, t.jobId),
    // The reliability question this table exists to answer runs the other way:
    // "how many times has this code been recorded", not "what did this job
    // have". Without this index that query is a sequential scan over every
    // diagnosis ever made.
    index("job_fault_codes_code_idx").on(t.tenantId, t.faultCodeId, t.createdAt),
  ],
);

/**
 * Why an "after" photo is missing, from a controlled list (`JOB-15`).
 *
 * ── WHY A TABLE AND NOT A TEXT FIELD ────────────────────────────────────────
 *
 * `JOB-15` says "an explicit reason-coded exemption", and the wording is the
 * requirement. A free-text box collects "n/a", "-", "camera", "phone died" and
 * "no photo needed" for the same situation, and nobody can then answer the only
 * question worth asking of this data: are photos missing because the work is
 * genuinely unphotographable, or because one crew has learnt that typing
 * anything gets them past the gate? A code groups; a sentence does not.
 *
 * ── WHY IT LIVES HERE AND NOT IN `reference.ts` ─────────────────────────────
 *
 * The vocabularies in `reference.ts` are the ones an administrator maintains on
 * a screen — holidays, rate cards, disposition reasons, fault codes. This list
 * is read by exactly one thing, the completion gate below, and it sits beside
 * the tables that gate reads.
 */
export const jobPhotoExemptionReasons = pgTable(
  "job_photo_exemption_reasons",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Stable machine key. Reports group on this, so labels can be reworded. */
    code: varchar("code", { length: 48 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 400 }),
    sortOrder: integer("sort_order").notNull().default(100),
    /** Retirement, never deletion — completed jobs still cite this row. */
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_photo_exemption_reasons_code_key").on(t.tenantId, t.code),
    index("job_photo_exemption_reasons_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);

/**
 * The assertions a job card carries that are absences rather than records
 * (`JOB-15`).
 *
 * ── THE DISTINCTION THIS TABLE EXISTS FOR ───────────────────────────────────
 *
 * `JOB-15` asks for "materials recorded or explicitly none". An empty
 * `job_materials` cannot tell those apart: no rows means either no parts were
 * fitted or nobody filled the section in, and those two have opposite meanings
 * for job costing, for stock reordering and for a warranty argument six months
 * later. So "none were used" is written down as a fact somebody asserted, with
 * their name and the time on it, and the gate reads the assertion rather than
 * inferring from silence.
 *
 * The photo exemption is the same shape — a technician saying "there is nothing
 * to photograph, and here is the reason from the list" — so it is the same
 * table with a `kind` discriminator, the way `job_fault_codes` carries symptom,
 * cause and remedy in one table rather than three.
 */
export const jobCardDeclarations = pgTable(
  "job_card_declarations",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    visitId: uuid("visit_id").references(() => jobVisits.id, { onDelete: "set null" }),
    /** `materials_none` | `photo_exempt`. */
    kind: varchar("kind", { length: 16 }).notNull(),
    /**
     * From `job_photo_exemption_reasons.code`, and only on a `photo_exempt`
     * row. A `materials_none` declaration has no reason to give: "no parts were
     * used" is the whole of it.
     */
    reasonCode: varchar("reason_code", { length: 48 }),
    /** What the code does not say. Beside it, never instead of it. */
    note: text("note"),
    declaredById: uuid("declared_by_id").references(() => users.id, { onDelete: "set null" }),
    // Written out rather than the shared `timestamps` spread, for the reason
    // `job_fault_codes` gives: this table has no soft delete and should not
    // gain one. A withdrawn declaration is deleted, because a soft-deleted one
    // would keep satisfying any gate that forgot to filter — which is the one
    // query this table exists to answer correctly.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("job_card_declarations_job_idx").on(t.tenantId, t.jobId),
    // `job_card_declarations_one_per_kind` — one declaration of each kind per
    // job, per visit — is a unique index over an expression and so lives in
    // `0025_job_card.sql` only, the way `job_fault_codes_one_per_kind` does.
    // Without it a form submitted twice records that no materials were used
    // twice, and a count of exempted jobs then depends on how many times
    // somebody pressed save.
  ],
);
