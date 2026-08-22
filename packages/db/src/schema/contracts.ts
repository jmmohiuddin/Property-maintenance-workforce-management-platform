import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol, timestamps } from "./_shared";
import { tenants, users } from "./tenancy";
import { contracts } from "./commerce";

/**
 * The AMC term sheet, its entitlements, its exclusions and its paperwork.
 *
 * `CON-1`…`CON-10`. The `contracts`, `contract_properties` and
 * `contract_visits` tables already existed in `commerce.ts` — they carry the
 * commercial header (who, when, how much, which properties, which planned
 * dates). Nothing here duplicates them.
 *
 * ── WHY THE TERMS ARE A SEPARATE TABLE ──────────────────────────────────────
 *
 * `contract_terms` is one row per contract, and a reasonable first reaction is
 * that it should be columns on `contracts`. The reason it is not:
 *
 * `contracts` is the row that invoices, jobs and the customer portal all join
 * to. What it carries is the *commercial* fact — this customer, this term, this
 * annual value. What is here is the *operational* contract: what counts as
 * covered, at what discount out-of-scope work is quoted, how far ahead a
 * planned visit becomes a job. Those are read by the scheduler and the scope
 * check and by nothing else, and they change on a different clock — a
 * discount rate is renegotiated mid-term far more often than a term start moves.
 *
 * The 1:1 is enforced by a unique index on `contract_id`, so a join through it
 * can never fan out.
 *
 * ── WHY ENTITLEMENTS AND EXCLUSIONS ARE ROWS, NOT JSON ──────────────────────
 *
 * `contracts.covered_services` and `contracts.exclusions` are JSONB arrays and
 * stay as they are — they are the customer-facing list, shown verbatim in the
 * portal. But `CON-5` decrements a *counter* per service family, and `CON-6`
 * matches a *code*. A counter inside a JSONB array cannot be incremented
 * concurrently without rewriting the whole document, and two technicians
 * closing two visits in the same second would lose one of the decrements
 * silently. A row per entitlement makes that an ordinary `UPDATE … SET
 * consumed_visits = consumed_visits + 1`, which is atomic.
 */

/**
 * `CON-1`, `CON-2`, `CON-6`: the operational half of the contract.
 *
 * One row per contract, created with it.
 */
export const contractTerms = pgTable(
  "contract_terms",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    /**
     * `comprehensive` — labour, parts and consumables included.
     * `labour_only` — parts billed separately.
     *
     * `CON-1`. The two models that exist in this market, and they differ in who
     * carries parts risk, which is the thing that decides whether an AMC makes
     * money. A CHECK constraint in the migration keeps it to these two.
     */
    coverageType: varchar("coverage_type", { length: 24 }).notNull().default("comprehensive"),
    /** Days from invoice to due date. `CON-1`. */
    paymentTermsDays: smallint("payment_terms_days").notNull().default(30),
    /**
     * `CON-2`. Discount on out-of-scope work, in basis points.
     *
     * Basis points rather than a percentage for the same reason money is minor
     * units: 15% stored as 0.15 is a float, and a float that multiplies a price
     * eventually produces a total the customer disputes. 1500 = 15%.
     */
    discountRateBasisPoints: integer("discount_rate_basis_points").notNull().default(1500),
    /**
     * Callout entitlement per year. NULL means unlimited, which is a real and
     * common term — not a missing value.
     *
     * There is deliberately no `consumed_callouts` counter beside it, and the
     * asymmetry with `contract_entitlements.consumed_visits` is the point.
     *
     * A consumed *visit* is a fact about the PPM schedule: a `contract_visits`
     * row was completed, and that event happens once. A consumed *callout* is
     * not an event at all — it is a description of a job, namely one against
     * this contract that did not come from the schedule
     * (`contract_id is not null and source <> 'contract_ppm'`). That is
     * derivable from `jobs`, so `getContract` derives it.
     *
     * Storing it instead would need resetting every contract year, would
     * double-count on any retry, and would disagree with the job list the
     * moment a job was cancelled or reassigned — and the number a customer
     * argues about at renewal is the last place to want a cached copy that can
     * drift from the rows it was counted from.
     */
    calloutsPerYear: smallint("callouts_per_year"),
    /**
     * `CON-4`. How far ahead of its target date a planned visit becomes a real
     * job. Default 21 days, configurable because a chiller service needs
     * mobilising sooner than a filter change.
     */
    ppmLeadTimeDays: smallint("ppm_lead_time_days").notNull().default(21),
    /**
     * `CON-3`. Half-width of the target window, in days.
     *
     * A window is what makes a schedule survivable: a visit missed on Tuesday
     * because the van broke down is still on schedule on Thursday, and a
     * schedule that reports otherwise is a schedule people stop reading.
     */
    ppmWindowDays: smallint("ppm_window_days").notNull().default(7),
    /**
     * How far the PPM schedule has been generated to.
     *
     * Makes generation idempotent and resumable: re-running it for a contract
     * whose visits already exist does nothing, and extending a term generates
     * only the new tail. A scheduler that double-fires must not double-book.
     */
    ppmGeneratedThrough: timestamp("ppm_generated_through", { withTimezone: true }),
    /** When the contract went live and its schedule was generated. */
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // The 1:1. Without it a second terms row would silently double every
    // entitlement query that joins through it.
    uniqueIndex("contract_terms_contract_key").on(t.contractId),
    index("contract_terms_tenant_idx").on(t.tenantId),
  ],
);

/**
 * `CON-2` / `CON-5`: scheduled visits per service family per year, and how many
 * have been consumed.
 *
 * The counter lives here rather than being derived from completed jobs on
 * purpose. A derived count answers "how many contract jobs closed against this
 * service", which is not the same question: a visit consumed and later
 * cancelled, a goodwill visit outside entitlement, and a job re-opened for the
 * same fault all make the two numbers diverge — and the number the customer
 * argues about at renewal is the one we told them, not the one a query
 * recomputes afterwards.
 */
export const contractEntitlements = pgTable(
  "contract_entitlements",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    /** Catalogue slug — the taxonomy the website, dispatch and pricing share. */
    serviceSlug: varchar("service_slug", { length: 64 }).notNull(),
    /** What the customer sees. "AC service", not "hvac-installation-maintenance". */
    label: varchar("label", { length: 120 }).notNull(),
    visitsPerYear: smallint("visits_per_year").notNull().default(1),
    consumedVisits: integer("consumed_visits").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    // One entitlement per service per contract. This is also the key
    // `contract_visits.service_slug` links through, which is why there is no
    // entitlement_id column on that table.
    uniqueIndex("contract_entitlements_key").on(t.tenantId, t.contractId, t.serviceSlug),
    index("contract_entitlements_contract_idx").on(t.tenantId, t.contractId),
  ],
);

/**
 * `CON-2` / `CON-6`: the machine-readable exclusion list.
 *
 * The TRD is explicit that this is a table rather than prose *because* `CON-6`
 * depends on it — work matching an exclusion cannot be silently absorbed into a
 * comprehensive contract, and a paragraph in an annexe cannot be matched
 * against.
 */
export const contractExclusions = pgTable(
  "contract_exclusions",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    /** Stable identifier from `STANDARD_AMC_EXCLUSIONS`, or a tenant's own. */
    code: varchar("code", { length: 64 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    /** Shown verbatim to the customer in the portal, so it is written for them. */
    description: text("description"),
    /** False for a carve-out negotiated on this contract alone. */
    isStandard: boolean("is_standard").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contract_exclusions_key").on(t.tenantId, t.contractId, t.code),
    index("contract_exclusions_contract_idx").on(t.tenantId, t.contractId),
  ],
);

/**
 * `CON-10`: signed contract PDF, scope annexe, asset register, insurance
 * certificates — attached, versioned, retrievable.
 *
 * Versioned rather than replaced. `contracts.document_storage_key` holds one
 * key and overwriting it loses the document that was actually signed; "which
 * version of the scope annexe was in force in March" is a question a dispute
 * asks, and a single key answers it with the wrong document.
 */
export const contractDocuments = pgTable(
  "contract_documents",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    /** `signed_contract` | `scope_annexe` | `asset_register` | `insurance` | `other` */
    kind: varchar("kind", { length: 32 }).notNull(),
    title: varchar("title", { length: 240 }).notNull(),
    /** Object-storage key. Files never live in Postgres. */
    storageKey: text("storage_key").notNull(),
    version: smallint("version").notNull().default(1),
    mimeType: varchar("mime_type", { length: 80 }),
    sizeBytes: integer("size_bytes"),
    uploadedById: uuid("uploaded_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contract_documents_version_key").on(t.tenantId, t.contractId, t.kind, t.version),
    index("contract_documents_contract_idx").on(t.tenantId, t.contractId),
  ],
);

/**
 * `CON-9`: which renewal reminders have already been sent, to whom.
 *
 * The reason this is a table and not a `last_reminded_at` column: the ladder is
 * T-90 / T-60 / T-30 / T-7 and each rung is a different message to a possibly
 * different person. A single timestamp cannot express "the owner got the 90-day
 * notice but the account manager joined afterwards and has had none".
 *
 * The unique index is the idempotency guarantee. Schedulers double-fire; the
 * insert is what makes the second fire a no-op rather than a second email. The
 * notification ledger's suppression window (`recentlyNotified`) is a ceiling on
 * frequency, not a record of which rung was reached — a 60-day notice sent
 * yesterday must not be re-sent in a month when the contract crosses 30 days,
 * and a time-based gate cannot tell those two apart.
 */
export const contractRenewalNotices = pgTable(
  "contract_renewal_notices",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contracts.id, { onDelete: "cascade" }),
    /** 90, 60, 30 or 7. Constrained in the migration. */
    band: smallint("band").notNull(),
    /**
     * NOT NULL, and that is load-bearing rather than tidy. Postgres treats
     * NULLs as distinct in a unique index, so a nullable recipient would let
     * the same band be recorded any number of times and the idempotency
     * guarantee below would quietly not exist.
     */
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("contract_renewal_notices_key").on(
      t.tenantId,
      t.contractId,
      t.band,
      t.recipientUserId,
    ),
    index("contract_renewal_notices_contract_idx").on(t.tenantId, t.contractId),
  ],
);
