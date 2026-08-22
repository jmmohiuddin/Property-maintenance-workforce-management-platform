import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  numeric,
  date,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { idCol, timestamps, money, currencyCol } from "./_shared";
import { tenants, users } from "./tenancy";
import { customers, properties } from "./crm";
import { jobs } from "./operations";
import { invoices } from "./commerce";
import { subcontractors } from "./hr";

/**
 * Projects — `PRJ-1`…`PRJ-9`. Fit-out, installation and renovation work.
 *
 * ── WHY THIS IS NOT A COLUMN ON `jobs` ──────────────────────────────────────
 *
 * A job is one visit with one invoice at the end. Everything in this file
 * exists because a fit-out breaks one or other half of that sentence:
 *
 *   * `project_milestones` raises an invoice against **no completed job at
 *     all** (`PRJ-3`). The existing model — `createInvoiceFromJob`, which
 *     refuses anything not signed off — cannot express a 30% mobilisation
 *     payment, and that is the requirement's own diagnosis.
 *   * `project_phases` produce jobs rather than being them (`PRJ-2`). The link
 *     is `project_phase_jobs` and not a `phase_id` column on `jobs`, because a
 *     job raised for a phase is an ordinary job in every other respect and the
 *     dispatch board, the SLA clock and the job card must not have to learn
 *     about projects to keep working.
 *   * `project_retention` holds money that has already been invoiced and will
 *     not arrive for a year (`PRJ-5`). There is nowhere on an invoice to say
 *     that.
 *
 * ── THE MONEY CONVENTION ────────────────────────────────────────────────────
 *
 * Every amount is `money()` — `numeric(14,2)` — at rest and integer minor units
 * in code, exactly as invoices and contracts are. `INV-8` is the rule and this
 * module is not an exception to it: a project value stored differently from the
 * invoices raised against it would need a conversion at every join, and a
 * conversion at every join is a rounding error waiting for a busy afternoon.
 *
 * Percentages are basis points, following `contract_terms.discount_rate_basis_points`.
 * 500 = 5%. A retention rate stored as 0.05 is a float multiplying a contract
 * value, and the result is a figure the client disputes.
 *
 * ── THE DAY-VALUED COLUMNS ──────────────────────────────────────────────────
 *
 * `starts_on`, `target_completion_on`, `practical_completion_on`,
 * `defects_liability_ends_on`, permit dates, snag target dates and retention
 * due dates are `date`, never `timestamptz`. They are days, and a day stored as
 * an instant is read back through whatever offset the reader is in. Migration
 * 0021 fixed exactly this on `assets.warranty_expiry` and the note there
 * applies verbatim: the error runs in the expensive direction. A permit that
 * expired yesterday reads as valid for four more hours; a retention release
 * that fell due today reads as not yet due.
 */

// ── PRJ-1: the container ─────────────────────────────────────────────────────

/**
 * A project: the commercial container everything else in this file hangs off.
 *
 * `contract_value` is the **awarded** value and never moves. Variations are
 * rows in `project_variations`, and the reason they are not an adjustment to
 * this column is `PRJ-4`'s whole point: the difference between the awarded
 * value and what the job is now worth is the number a fit-out contractor most
 * needs to see, and folding it into one column destroys it. The current value
 * is `contract_value + sum(approved variations)`, computed, and the unapproved
 * total is reported beside it rather than inside it.
 */
export const projects = pgTable(
  "projects",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** `PRJ-2026-00001`, from `app_next_reference`. Never counted in code. */
    reference: varchar("reference", { length: 32 }).notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "restrict" }),
    /**
     * Nullable, and that is a real state rather than laziness. A tender is
     * priced before the unit is identified — "one of the retail units on the
     * ground floor" — and refusing to record the project until the address is
     * settled would mean the pipeline lives in a spreadsheet until award.
     */
    propertyId: uuid("property_id").references(() => properties.id, { onDelete: "set null" }),
    name: varchar("name", { length: 200 }).notNull(),
    /** The scope of works as agreed. Read at every dispute about a variation. */
    scope: text("scope"),
    contractValue: money("contract_value").notNull().default("0"),
    currency: currencyCol(),
    status: varchar("status", { length: 24 }).notNull().default("quoted"),
    startsOn: date("starts_on"),
    targetCompletionOn: date("target_completion_on"),
    /**
     * `PRJ-5` / `PRJ-7`. The date the client took possession. Written by the
     * transition into `practical_completion` and by nothing else, so it cannot
     * disagree with the status — and the whole retention and defects-liability
     * clock is measured from it.
     */
    practicalCompletionOn: date("practical_completion_on"),
    /** Twelve months from practical completion by default. `PRJ-5`. */
    defectsLiabilityDays: smallint("defects_liability_days").notNull().default(365),
    defectsLiabilityEndsOn: date("defects_liability_ends_on"),
    /**
     * `PRJ-5`. Withheld from every invoice raised against this project.
     * Basis points: 500 = 5%, and the migration caps it at 1,000 because a
     * retention above 10% is not a term this market uses — it is a typo where
     * somebody meant basis points and typed a percentage.
     */
    retentionBasisPoints: integer("retention_basis_points").notNull().default(500),
    projectManagerId: uuid("project_manager_id").references(() => users.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("projects_tenant_reference_key").on(t.tenantId, t.reference),
    index("projects_tenant_status_idx").on(t.tenantId, t.status, t.targetCompletionOn),
    index("projects_customer_idx").on(t.tenantId, t.customerId),
  ],
);

// ── PRJ-2: phases ────────────────────────────────────────────────────────────

/**
 * A phase of work: planned dates, a trade, a dependency and a weight.
 *
 * The weight is what makes a completion percentage mean anything. Phases are
 * not the same size — first fix is six weeks, handover cleaning is a day — so a
 * project reported as "four of eight phases complete" is a project whose
 * schedule is about to be a surprise. `weight_basis_points` across a project's
 * live phases is meant to total 10,000; `phaseWeightGap` in core reports the
 * shortfall rather than the database refusing it, because a plan is incomplete
 * for as long as somebody is typing it.
 */
export const projectPhases = pgTable(
  "project_phases",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sequence: smallint("sequence").notNull().default(1),
    name: varchar("name", { length: 160 }).notNull(),
    /** Catalogue slug for the trade this phase belongs to, where one fits. */
    serviceSlug: varchar("service_slug", { length: 64 }),
    plannedStartOn: date("planned_start_on"),
    plannedEndOn: date("planned_end_on"),
    actualStartOn: date("actual_start_on"),
    actualEndOn: date("actual_end_on"),
    /**
     * The phase this one cannot start before. Self-referential, nullable, and
     * `ON DELETE SET NULL` rather than cascade: deleting "first fix" must not
     * silently delete "second fix" along with the jobs and costs booked to it.
     */
    dependsOnPhaseId: uuid("depends_on_phase_id").references((): AnyPgColumn => projectPhases.id, {
      onDelete: "set null",
    }),
    weightBasisPoints: integer("weight_basis_points").notNull().default(0),
    percentComplete: smallint("percent_complete").notNull().default(0),
    status: varchar("status", { length: 16 }).notNull().default("planned"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_phases_sequence_key").on(t.tenantId, t.projectId, t.sequence),
    index("project_phases_project_idx").on(t.tenantId, t.projectId),
  ],
);

/**
 * `PRJ-2`: "phases produce Jobs for daily execution."
 *
 * A link table rather than a `phase_id` column on `jobs`, and the reason is
 * ownership rather than tidiness. `schema/operations.ts` is the dispatch
 * board's table: the SLA clock, the outdoor-work ban, the job card and the
 * portal all read it, and a job raised for a phase is an ordinary job to every
 * one of them. Adding a column there would mean the projects module could break
 * dispatch; this way it cannot.
 *
 * The unique index on `job_id` is what makes the link a link and not a fan-out:
 * one job belongs to at most one phase, so summing a phase's jobs cannot
 * double-count.
 */
export const projectPhaseJobs = pgTable(
  "project_phase_jobs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id")
      .notNull()
      .references(() => projectPhases.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_phase_jobs_job_key").on(t.tenantId, t.jobId),
    index("project_phase_jobs_phase_idx").on(t.tenantId, t.phaseId),
    index("project_phase_jobs_project_idx").on(t.tenantId, t.projectId),
  ],
);

// ── PRJ-3: milestone billing ─────────────────────────────────────────────────

/**
 * A payment milestone: a value, a trigger, and the invoice it raised.
 *
 * `invoice_id` is the idempotency guarantee, not a convenience. "A reached
 * milestone raises an invoice" is a sentence somebody will click twice, and the
 * second click must be a no-op rather than a second tax invoice with a
 * sequential number on it — an invoice raised in error cannot be deleted, only
 * credited, and a credit note is a document the customer sees.
 *
 * `ON DELETE SET NULL` on that reference, so a voided invoice leaves the
 * milestone reachable rather than deleting the record of what was billed.
 */
export const projectMilestones = pgTable(
  "project_milestones",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Optional. A mobilisation payment belongs to the project, not a phase. */
    phaseId: uuid("phase_id").references(() => projectPhases.id, { onDelete: "set null" }),
    sequence: smallint("sequence").notNull().default(1),
    name: varchar("name", { length: 160 }).notNull(),
    /** Tax-exclusive. VAT is applied when the invoice is raised, after discount. */
    value: money("value").notNull().default("0"),
    /** "date" | "percent_complete" | "client_sign_off". */
    triggerKind: varchar("trigger_kind", { length: 24 }).notNull().default("client_sign_off"),
    triggerOn: date("trigger_on"),
    triggerPercent: smallint("trigger_percent"),
    /** "pending" | "reached" | "invoiced" | "cancelled". */
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    reachedAt: timestamp("reached_at", { withTimezone: true }),
    reachedById: uuid("reached_by_id").references(() => users.id, { onDelete: "set null" }),
    /** How the trigger was satisfied, for the sign-off case a query cannot judge. */
    reachedNote: text("reached_note"),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_milestones_sequence_key").on(t.tenantId, t.projectId, t.sequence),
    index("project_milestones_project_idx").on(t.tenantId, t.projectId, t.status),
  ],
);

// ── PRJ-4: variation orders ──────────────────────────────────────────────────

/**
 * A change to scope, with its own value and approval state.
 *
 * The value is signed: an omission is a negative variation and is every bit as
 * real as an addition. Storing only additions and handling omissions by editing
 * the contract value would lose the record of what changed, which is the one
 * thing a final account argument needs.
 *
 * The state matters more than the value. `PRJ-4` requires unapproved variations
 * to be "visible and total separately", because an instructed-but-unapproved
 * variation is labour and material going out of the door against nothing — and
 * it is invisible in every other view: not in the contract value, not on an
 * invoice, only on the site.
 */
export const projectVariations = pgTable(
  "project_variations",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** `VO-2026-00007`, allocated the same way every other document number is. */
    reference: varchar("reference", { length: 32 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: text("description"),
    /** Signed, tax-exclusive. Negative is an omission. */
    value: money("value").notNull().default("0"),
    /** "draft" | "submitted" | "approved" | "rejected" | "withdrawn". */
    approvalState: varchar("approval_state", { length: 16 }).notNull().default("draft"),
    /** Who instructed it on site, in their words. The audit trail of a verbal. */
    instructedBy: varchar("instructed_by", { length: 160 }),
    instructedOn: date("instructed_on"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedById: uuid("decided_by_id").references(() => users.id, { onDelete: "set null" }),
    /** The client's own approval reference — what gets the variation paid. */
    clientReference: varchar("client_reference", { length: 64 }),
    decisionReason: text("decision_reason"),
    /** Days added to the programme. A variation costs time as well as money. */
    programmeImpactDays: smallint("programme_impact_days").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_variations_reference_key").on(t.tenantId, t.reference),
    index("project_variations_project_idx").on(t.tenantId, t.projectId, t.approvalState),
  ],
);

// ── PRJ-5: retention ─────────────────────────────────────────────────────────

/**
 * Money withheld from an invoice, and when it comes back.
 *
 * **Two rows per invoice**, one per release stage, rather than one row with two
 * dates. The requirement asks for "its own due-date tracking and reminders",
 * and a stage is the unit that falls due: the first half is released on
 * practical completion, the second twelve months later, and they are chased,
 * released and written off independently. One row with two nullable date pairs
 * would make "what retention is overdue" a query with a CASE in it, and every
 * reminder would have to re-derive which half it was talking about.
 *
 * `due_on` is nullable until practical completion is recorded, because until
 * then the date genuinely is not known — it is derived from a completion that
 * has not happened. A row with a null due date is retention *held*; a row with
 * a due date in the past is retention somebody should be chasing today.
 */
export const projectRetention = pgTable(
  "project_retention",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /**
     * The invoice the money was withheld from. `ON DELETE RESTRICT`: retention
     * is a claim on a specific document and losing the link would leave a
     * balance nobody can evidence.
     */
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "restrict" }),
    milestoneId: uuid("milestone_id").references(() => projectMilestones.id, {
      onDelete: "set null",
    }),
    /** "practical_completion" | "defects_liability". */
    stage: varchar("stage", { length: 24 }).notNull(),
    /** Withheld from the TAX-EXCLUSIVE amount. VAT was declared on the full value. */
    amount: money("amount").notNull().default("0"),
    basisPoints: integer("basis_points").notNull().default(500),
    /** "held" | "due" | "released" | "written_off". */
    status: varchar("status", { length: 16 }).notNull().default("held"),
    /** Null until practical completion fixes the clock. */
    dueOn: date("due_on"),
    releasedOn: date("released_on"),
    /** The invoice raised to collect it, where one was. */
    releaseInvoiceId: uuid("release_invoice_id").references(() => invoices.id, {
      onDelete: "set null",
    }),
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    // One row per invoice per stage. This is what makes withholding idempotent:
    // raising the same milestone invoice twice cannot withhold twice.
    uniqueIndex("project_retention_stage_key").on(t.tenantId, t.invoiceId, t.stage),
    index("project_retention_project_idx").on(t.tenantId, t.projectId, t.status),
    // The chase list: what is due, oldest first.
    index("project_retention_due_idx").on(t.tenantId, t.status, t.dueOn),
  ],
);

// ── PRJ-6: the permit register ───────────────────────────────────────────────

/**
 * Who issues permits. A controlled vocabulary, seeded, `ADM-10`'s pattern.
 *
 * "DM", "Dubai Municipality" and "Dubai Muncipality" are three answers to a
 * question that has one, and the question — which authority is holding this
 * project up — is asked across rows and across projects. Retirement is
 * `is_active`, never deletion: an authority named on an issued permit cannot be
 * removed without rewriting the register.
 */
export const permitAuthorities = pgTable(
  "permit_authorities",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 400 }),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("permit_authorities_code_key").on(t.tenantId, t.code),
    index("permit_authorities_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);

/**
 * A permit against a project (`PRJ-6`).
 *
 * `is_required` is the flag the hard block reads: a project may not enter
 * `on_site` while a permit marked required is not approved. It defaults to true
 * because the failure mode of the alternative is one-sided — a permit entered
 * and not flagged is a permit that stops blocking, and the whole reason to
 * enter it was that it blocks.
 *
 * `expires_on` is a `date`. A permit is valid for a calendar day, and this is
 * the exact column where an offset shift reports an expired permit as still
 * valid — in front of an inspector, on a site the permit was the authority for.
 */
export const projectPermits = pgTable(
  "project_permits",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** `ON DELETE RESTRICT`: an authority in use cannot be deleted out from under it. */
    authorityId: uuid("authority_id")
      .notNull()
      .references(() => permitAuthorities.id, { onDelete: "restrict" }),
    permitType: varchar("permit_type", { length: 120 }).notNull(),
    referenceNumber: varchar("reference_number", { length: 80 }),
    /** "not_applied" | "applied" | "approved" | "rejected" | "expired". */
    status: varchar("status", { length: 16 }).notNull().default("not_applied"),
    isRequired: boolean("is_required").notNull().default(true),
    appliedOn: date("applied_on"),
    approvedOn: date("approved_on"),
    expiresOn: date("expires_on"),
    feePaid: money("fee_paid").notNull().default("0"),
    /** Object-storage key for the permit itself. Files never live in Postgres. */
    documentStorageKey: text("document_storage_key"),
    notes: text("notes"),
    /**
     * `PRJ-6`. When the expiry chase last went out about this permit. NULL is
     * "never asked" and sorts first. See 0036 for why this is one timestamp
     * rather than a ladder of rungs.
     */
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("project_permits_project_idx").on(t.tenantId, t.projectId, t.status),
    index("project_permits_expiry_idx").on(t.tenantId, t.expiresOn),
  ],
);

// ── PRJ-7: the snag list ─────────────────────────────────────────────────────

/** The trades a snag is assigned to. Seeded; same argument as `asset_categories`. */
export const snagTrades = pgTable(
  "snag_trades",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /** Matches a catalogue service slug where the trade is one we sell. */
    serviceSlug: varchar("service_slug", { length: 64 }),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("snag_trades_code_key").on(t.tenantId, t.code),
    index("snag_trades_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);

/**
 * A snag: location, trade, photo, responsible party, target date, evidence.
 *
 * `severity` is load-bearing rather than descriptive: `critical` is what stops
 * practical completion being recorded (`PRJ-7`), and nothing else does. That
 * line is drawn at critical and not at "any open snag" deliberately — practical
 * completion has never meant an empty snag list, and a rule demanding one gets
 * worked around by downgrading everything to minor, which destroys the only
 * field that made the list worth keeping.
 *
 * `closure_photo_storage_key` is the evidence half. A snag closed with a note
 * saying "done" is a snag that will be raised again at handover by somebody
 * standing in front of it.
 */
export const projectSnags = pgTable(
  "project_snags",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id").references(() => projectPhases.id, { onDelete: "set null" }),
    /** Sequential within the project. "Snag 47" is how it is referred to on site. */
    sequence: integer("sequence").notNull().default(1),
    /** Where in the building. Free text on purpose: "Level 3, meeting room 2, east wall". */
    locationText: varchar("location_text", { length: 200 }).notNull(),
    /** `ON DELETE RESTRICT`: a trade with snags against it cannot be deleted. */
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => snagTrades.id, { onDelete: "restrict" }),
    /** "critical" | "major" | "minor". */
    severity: varchar("severity", { length: 16 }).notNull().default("minor"),
    description: text("description").notNull(),
    /** "us" | "subcontractor" | "client" | "consultant" | "supplier". */
    responsibleParty: varchar("responsible_party", { length: 16 }).notNull().default("us"),
    /** `HR-19`'s register, not a copy of it. See the note above `project_subcontracts`. */
    subcontractorId: uuid("subcontractor_id").references(() => subcontractors.id, {
      onDelete: "set null",
    }),
    targetOn: date("target_on"),
    /** "open" | "in_progress" | "closed" | "rejected". */
    status: varchar("status", { length: 16 }).notNull().default("open"),
    photoStorageKey: text("photo_storage_key"),
    closurePhotoStorageKey: text("closure_photo_storage_key"),
    closureNote: text("closure_note"),
    raisedById: uuid("raised_by_id").references(() => users.id, { onDelete: "set null" }),
    raisedBy: varchar("raised_by", { length: 160 }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedById: uuid("closed_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_snags_sequence_key").on(t.tenantId, t.projectId, t.sequence),
    // The completion gate reads this: open criticals for one project.
    index("project_snags_gate_idx").on(t.tenantId, t.projectId, t.status, t.severity),
    index("project_snags_target_idx").on(t.tenantId, t.status, t.targetOn),
  ],
);

// ── PRJ-9: the subcontractor register ────────────────────────────────────────

/**
 * ── WHERE THE SUBCONTRACTOR REGISTER LIVES ─────────────────────────────────
 *
 * Not here. `HR-19` already built `subcontractors` in `schema/hr.ts`, with the
 * trade licence, the liability and workmen's-compensation policies, their
 * expiry dates and the Law No. 7 of 2025 approval reference — watched by the
 * same compliance sweep that watches employee documents, because a
 * subcontractor's worker on our site with an expired permit is our exposure
 * under Article 60 whoever pays them.
 *
 * `PRJ-9` asks for that organisation "engaged against a project scope with its
 * own payment terms". The engagement is what belongs here; the organisation
 * does not. Two registers that disagreed about whether a licence was current
 * would be worse than one, and the way that happens is each module growing its
 * own copy — which is exactly what the note on that table warns against.
 */

/**
 * An engagement of a subcontractor against a project scope (`PRJ-9`).
 *
 * `client_approval_state` is here and not on `subcontractors` because the
 * approval is per engagement, not per organisation: Dubai Law No. 7 of 2025
 * requires the employer's prior approval before subcontracting within the
 * contracting sector, and an approval given for one project says nothing about
 * the next.
 */
export const projectSubcontracts = pgTable(
  "project_subcontracts",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subcontractorId: uuid("subcontractor_id")
      .notNull()
      .references(() => subcontractors.id, { onDelete: "restrict" }),
    phaseId: uuid("phase_id").references(() => projectPhases.id, { onDelete: "set null" }),
    scope: text("scope").notNull(),
    /** Committed cost. Counts against margin from the day it is signed. */
    value: money("value").notNull().default("0"),
    paymentTermsDays: smallint("payment_terms_days").notNull().default(30),
    retentionBasisPoints: integer("retention_basis_points").notNull().default(0),
    /** "not_required" | "pending" | "approved" | "refused". Law No. 7 of 2025. */
    clientApprovalState: varchar("client_approval_state", { length: 16 })
      .notNull()
      .default("pending"),
    clientApprovedOn: date("client_approved_on"),
    clientApprovalReference: varchar("client_approval_reference", { length: 64 }),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    notes: text("notes"),
    /**
     * `PRJ-9`. When the approval chase last went out about this engagement.
     * NULL is "never asked". The default on `client_approval_state` is
     * `pending` precisely so an engagement cannot slip through unrecorded, and
     * this column is what turns that default into something anybody hears
     * about.
     */
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("project_subcontracts_key").on(t.tenantId, t.projectId, t.subcontractorId, t.scope),
    index("project_subcontracts_project_idx").on(t.tenantId, t.projectId),
    index("project_subcontracts_sub_idx").on(t.tenantId, t.subcontractorId),
    // The chase list: unapproved engagements, least recently asked about first.
    index("project_subcontracts_approval_idx").on(
      t.tenantId,
      t.clientApprovalState,
      t.lastRemindedAt,
    ),
  ],
);

// ── PRJ-8: cost tracking ─────────────────────────────────────────────────────

/**
 * What an hour of somebody's time costs us.
 *
 * ── WHY THIS TABLE IS A LANDMARK ────────────────────────────────────────────
 *
 * Until this migration there was **no cost concept anywhere in this schema**.
 * Everything recorded a price — what the customer pays — and nothing recorded a
 * cost, which is why `CON-8`'s renewal screen states plainly that the system
 * records price and not cost and that a margin would therefore be estimated
 * rather than measured. This is the first row of the other half.
 *
 * Rates are versioned by `effective_from` rather than edited in place, because
 * a cost recorded last March must keep the rate that applied last March. A
 * table that is edited in place silently rewrites the margin on every closed
 * project the next time somebody gives the electricians a rise.
 *
 * The rate is nevertheless only a *default*: `project_costs` stores the hourly
 * cost it actually used, captured at entry. A historical cost that re-derives
 * its rate on every read is a historical cost that changes.
 */
export const labourCostRates = pgTable(
  "labour_cost_rates",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** A trade or grade: "electrician", "helper", "supervisor". */
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /**
     * Fully-loaded cost per hour: wage, accommodation, transport, visa
     * amortisation, insurance. Not the wage. A margin computed against basic
     * pay alone is roughly a third too optimistic in this market, which is
     * worse than no margin at all because it is believed.
     */
    hourlyCost: money("hourly_cost").notNull().default("0"),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("labour_cost_rates_key").on(t.tenantId, t.code, t.effectiveFrom),
    index("labour_cost_rates_pick_idx").on(t.tenantId, t.isActive, t.code),
  ],
);

/**
 * The project cost ledger (`PRJ-8`): labour, materials, subcontract, plant.
 *
 * One row per cost event, never a running total on `projects`. A stored total
 * has to be maintained by every path that books a cost, and the path somebody
 * forgets is the one that makes the margin wrong in the direction nobody
 * checks.
 *
 * `is_committed` separates money spent from money promised. A subcontract
 * signed for AED 180,000 is gone whether or not the invoice has arrived, and a
 * margin that improves every time a supplier is slow to invoice reports the
 * opposite of the truth. Both are summed against the margin; they are reported
 * separately so the cash position is still readable.
 *
 * `job_id` is nullable and is the hook the rest of the system will eventually
 * hang off: a phase produces jobs, labour is worked on jobs, and a cost booked
 * to a job is a cost that can also be summed per contract. Nothing outside this
 * module reads it yet — that is `CON-8`'s work, not this migration's.
 */
export const projectCosts = pgTable(
  "project_costs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    phaseId: uuid("phase_id").references(() => projectPhases.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    subcontractorId: uuid("subcontractor_id").references(() => subcontractors.id, {
      onDelete: "set null",
    }),
    /** "labour" | "materials" | "subcontractor" | "plant_hire" | "other". */
    category: varchar("category", { length: 16 }).notNull(),
    description: varchar("description", { length: 240 }).notNull(),
    incurredOn: date("incurred_on").notNull(),
    /** Hours for labour, quantity for materials and plant. Three decimals. */
    quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("1"),
    unit: varchar("unit", { length: 24 }).notNull().default("ea"),
    /** The rate as it was on the day. Captured, never re-derived. */
    unitCost: money("unit_cost").notNull().default("0"),
    /** quantity × unit_cost, stored so a report never recomputes it differently. */
    amount: money("amount").notNull().default("0"),
    /** Committed but not yet incurred: an order placed, a subcontract signed. */
    isCommitted: boolean("is_committed").notNull().default(false),
    /** Supplier invoice or delivery-note number. The evidence for the figure. */
    supplierReference: varchar("supplier_reference", { length: 64 }),
    recordedById: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("project_costs_project_idx").on(t.tenantId, t.projectId, t.category),
    index("project_costs_incurred_idx").on(t.tenantId, t.incurredOn),
    index("project_costs_job_idx").on(t.tenantId, t.jobId),
  ],
);
