import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  date,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol, timestamps, money, currencyCol } from "./_shared";
import { tenants, users } from "./tenancy";
import { customers, properties } from "./crm";

/**
 * Tenders (`CON-11`) and the packs assembled for them (`CON-12`).
 *
 * ── WHY THIS IS NOT THE LEADS TABLE ─────────────────────────────────────────
 *
 * `leads` has a `stage` enum and every index on it is `(tenant_id, stage,
 * created_at)`. That is the right shape for a conversation somebody is working:
 * where it got to decides what happens next.
 *
 * A tender has a closing date published by somebody else. Nothing moves it, and
 * a bid finished the day after is worth nothing at all — so there is no stage
 * column here, and the one index that matters is
 * `(tenant_id, submission_deadline)`. `CON-11`: *deadline-driven, not
 * stage-driven — a tender queue sorts by days until deadline, always.* If a
 * stage column ever appears in this file, that sentence has been lost.
 *
 * ── WHY THE DAY COLUMNS ARE `date` AND NOT `timestamptz` ────────────────────
 *
 * `submission_deadline`, `decision_date` and `submitted_on` are days. The same
 * argument migration 0021 makes for `warranty_expires_on` applies here and
 * lands harder: a deadline stored as an instant is read back through the
 * reader's offset, and in Dubai a tender closing on 1 September reads as
 * closing on 31 August for four hours out of every twenty-four. On a warranty
 * that authorises a repair somebody will not pay for; on a tender deadline it
 * files the bid a day late.
 *
 * Every "days until deadline" number in this feature is therefore
 * `submission_deadline - current_date` computed in Postgres, and never
 * arithmetic on a JavaScript `Date`.
 */

// ── The vocabularies (following ADM-10) ──────────────────────────────────────

/**
 * Where the opportunity came from (`CON-11`).
 *
 * A table rather than a varchar for the reason `asset_categories` is one: the
 * question this column exists to answer is asked across rows — *which channel
 * is worth staffing before next budget season* — and a channel typed by hand
 * gives "OA", "O.A.", "owners assoc" and "management company" for one thing.
 * By the time anybody asks, the history is already written.
 */
export const tenderOpportunitySources = pgTable(
  "tender_opportunity_sources",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Stable machine key. Reports group on this, so a label can be reworded. */
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 400 }),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tender_opportunity_sources_code_key").on(t.tenantId, t.code),
    index("tender_opportunity_sources_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);

/**
 * Why a bid was won or lost (`CON-11`).
 *
 * Scoped by `applies_to` so a picker can offer the reasons that make sense for
 * the outcome being recorded — "undercut on price" is a losing reason and
 * "incumbent's contract ended badly" is a winning one, and a single flat list
 * makes both look like the other's options.
 *
 * The precedent is `lead_disposition_reasons`, which has the same shape and
 * exists for the same reason: "why did we lose" answered in free text is a
 * question with no answer at the end of the year.
 */
export const tenderOutcomeReasons = pgTable(
  "tender_outcome_reasons",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 400 }),
    /** `won` | `lost` | `both`. Which outcomes may cite this reason. */
    appliesTo: varchar("applies_to", { length: 8 }).notNull().default("lost"),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("tender_outcome_reasons_code_key").on(t.tenantId, t.code),
    index("tender_outcome_reasons_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);

// ── The pipeline ─────────────────────────────────────────────────────────────

export const tenders = pgTable(
  "tenders",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    reference: varchar("reference", { length: 32 }).notNull(),
    title: varchar("title", { length: 240 }).notNull(),

    /**
     * The organisation that published the tender, as it appears on the
     * document. Free text on purpose and required: an OA management company
     * inviting three bids is very often not a customer yet, and refusing to
     * record the tender until somebody creates a customer record for a body the
     * company may never work for is how tenders end up in a spreadsheet.
     */
    issuingBody: varchar("issuing_body", { length: 200 }).notNull(),
    /** Set once the issuer is a real account. Optional, and usually later. */
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),

    opportunitySourceId: uuid("opportunity_source_id")
      .notNull()
      .references(() => tenderOpportunitySources.id, { onDelete: "restrict" }),
    /** The reference the issuer's portal knows this by. eSupply, Etimad, an OA's own. */
    portalReference: varchar("portal_reference", { length: 64 }),

    /**
     * The spine of this whole feature. Not null, because a tender with no
     * closing date cannot be queued, and a queue is what `CON-11` asks for.
     */
    submissionDeadline: date("submission_deadline").notNull(),
    /** When the issuer says it will decide. Days, not instants. */
    decisionDate: date("decision_date"),
    /**
     * The issuer's budget year, as they write it: "2027", "FY2027-28".
     * `CON-11`'s point is that OA work is won *before* budget season, so this
     * is what the "which cycle are we bidding into" report groups on.
     */
    budgetCycle: varchar("budget_cycle", { length: 16 }),

    scopeOfWork: text("scope_of_work"),

    /** How many other bidders are known to be in. Null means unknown, not zero. */
    competitorsKnown: smallint("competitors_known"),
    /** Who they are, where anybody found out. Free text; intelligence, not data. */
    competitorNotes: text("competitor_notes"),

    /** What was bid. Integer minor units in code, `numeric(14,2)` at rest. */
    bidValue: money("bid_value"),
    currency: currencyCol(),

    /** The day the bid actually went in. Distinct from the outcome. */
    submittedOn: date("submitted_on"),

    /** `pending` | `won` | `lost` | `withdrawn` | `no_bid`. Never a stage. */
    outcome: varchar("outcome", { length: 16 }).notNull().default("pending"),
    outcomeReasonId: uuid("outcome_reason_id").references(() => tenderOutcomeReasons.id, {
      onDelete: "restrict",
    }),
    outcomeNote: text("outcome_note"),
    decidedOn: date("decided_on"),
    decidedById: uuid("decided_by_id").references(() => users.id, { onDelete: "set null" }),

    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tenders_tenant_reference_key").on(t.tenantId, t.reference),
    // THE index. The queue reads it and nothing else, in this order, always.
    index("tenders_deadline_idx").on(t.tenantId, t.outcome, t.submissionDeadline),
    // "What did we win and lose this budget cycle, and why" — the review the
    // outcome vocabulary exists for.
    index("tenders_cycle_idx").on(t.tenantId, t.budgetCycle, t.outcome),
    index("tenders_customer_idx").on(t.tenantId, t.customerId),
  ],
);

/**
 * The buildings a tender is priced for.
 *
 * Separate rows rather than a `property_id` column because an OA tender is
 * routinely for a portfolio — three towers under one management company — and
 * the per-asset PPM schedule in the pack is the union of their registers. The
 * shape follows `contract_properties`, which is the same relationship one step
 * later in the same story.
 */
export const tenderProperties = pgTable(
  "tender_properties",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => properties.id, { onDelete: "cascade" }),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("tender_properties_key").on(t.tenantId, t.tenderId, t.propertyId),
    index("tender_properties_property_idx").on(t.tenantId, t.propertyId),
  ],
);

/**
 * A pack that was assembled (`CON-12`).
 *
 * ── WHY THE ARTEFACT IS KEPT RATHER THAN REBUILT ────────────────────────────
 *
 * The same argument `issue.ts` makes about a quotation, one step stronger. The
 * pack is *assembled from live data* — that is the requirement — which means
 * rebuilding it next month produces a different document: a renewed licence
 * number, a rate card that has moved, a chiller that has been replaced. What
 * was submitted has to remain producible exactly as submitted, because in a
 * dispute over a RERA three-bid process the question is what the bidder claimed
 * on the day, not what is true now.
 *
 * So `prepared_on` is stored and pinned: it is the pack's business date, the
 * date written into the PDF's metadata, and the date every expiry in it was
 * judged against. Re-materialising returns the stored key and renders nothing.
 *
 * `sha256` is the evidence. It means something only because the render is
 * deterministic — see `packages/docs/src/layout.ts`.
 */
export const tenderPacks = pgTable(
  "tender_packs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    /** The pinned business date. Same input, same date, same bytes. */
    preparedOn: date("prepared_on").notNull(),
    storageKey: text("storage_key").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    pageCount: integer("page_count").notNull(),
    byteSize: integer("byte_size").notNull(),
    /**
     * What went in: every attached certificate with its own hash, and the
     * warnings the operator was shown. Kept so "what evidence did we submit"
     * is answerable without opening the PDF.
     */
    manifest: text("manifest").notNull(),
    preparedById: uuid("prepared_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One pack per tender per business date. Re-assembling on the same day is a
    // no-op that returns the stored artefact; assembling again after a licence
    // renewal is a new, dated pack sitting beside the one that was submitted.
    uniqueIndex("tender_packs_day_key").on(t.tenantId, t.tenderId, t.preparedOn),
    index("tender_packs_tender_idx").on(t.tenantId, t.tenderId, t.preparedOn),
  ],
);
