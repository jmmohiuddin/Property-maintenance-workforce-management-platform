import {
  pgTable,
  varchar,
  boolean,
  date,
  index,
  integer,
  numeric,
  smallint,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { currencyCol, idCol, money } from "./_shared";
import { tenants } from "./tenancy";

/**
 * Administrator-maintained reference data (`ADM-10`).
 *
 * The taxonomies that change on a cabinet announcement rather than on a release
 * schedule. Every one of them used to be a code change, which meant a holiday
 * announced on a Thursday was a deploy on a Sunday — or, more often, was simply
 * not entered and the scheduler carried on booking work through Eid.
 *
 * ── WHAT IS NOT A COLUMN HERE ───────────────────────────────────────────────
 *
 * The summer midday ban, the Ramadan reduction and the statutory hour maxima.
 * They are constants in `DEFAULT_CALENDAR` and are read from there on every
 * load, so there is no row anybody can edit and no screen that could offer to.
 * A statutory rule with a per-worker fine attached should not be reachable by a
 * form post, and the cheapest way to guarantee that is to give it nowhere to be
 * stored. See `loadWorkingCalendar` in `../domain/reference.ts`.
 */

const referenceTimestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * UAE public holidays, as `JOB-6` rule 3 requires them: data, never computed.
 *
 * Islamic-calendar dates depend on moon sighting and are confirmed a day or two
 * ahead. An arithmetic Hijri calendar is usually right, and "usually right" is
 * the wrong property for the rule that decides whether thirty people travel to
 * a site.
 */
export const publicHolidays = pgTable(
  "public_holidays",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** `YYYY-MM-DD`, the same key shape `WorkingCalendar.publicHolidays` uses. */
    holidayDate: date("holiday_date").notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    /** Where the date came from, so next year's administrator can trust it. */
    sourceNote: varchar("source_note", { length: 200 }),
    ...referenceTimestamps,
  },
  (t) => [uniqueIndex("public_holidays_date_key").on(t.tenantId, t.holidayDate)],
);

/**
 * Ramadan, stored as a period rather than as thirty days.
 *
 * The start moves when the moon is not sighted, and moving a period is one edit
 * where moving thirty rows is thirty chances to leave one behind.
 */
export const ramadanPeriods = pgTable(
  "ramadan_periods",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** "Ramadan 1447". Shown in the admin list so two years are distinguishable. */
    label: varchar("label", { length: 80 }).notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    sourceNote: varchar("source_note", { length: 200 }),
    ...referenceTimestamps,
  },
  (t) => [uniqueIndex("ramadan_periods_start_key").on(t.tenantId, t.startsOn)],
);

/**
 * The working week (`OPEN-8`).
 *
 * `tenant_id` is both the first column and the primary key. A tenant has one
 * working week; a second row would be a second answer to a question with one,
 * and the load path would have to pick between them by row order.
 */
export const calendarSettings = pgTable("calendar_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  /** 0 = Sunday … 6 = Saturday, matching `DubaiTime.weekday` exactly. */
  weekendDays: smallint("weekend_days")
    .array()
    .notNull()
    .default(sql`'{6,0}'::smallint[]`),
  openMinute: integer("open_minute").notNull().default(8 * 60),
  closeMinute: integer("close_minute").notNull().default(18 * 60),
  /**
   * A floor, not a setting. The database CHECK refuses anything under the
   * statutory hour, so the only direction this can be moved is more generous.
   */
  minBreakMinutes: integer("min_break_minutes").notNull().default(60),
  ...referenceTimestamps,
});

// ── Controlled vocabularies (ADM-10) ────────────────────────────────────────
//
// The calendar above answers "when may we work". Everything below answers "what
// may an operator say happened", which is the same problem one layer up: a
// field with no list behind it is a field that ends up holding five spellings
// of one answer, and the report the field was collected for cannot group them.

/**
 * Why a lead was lost or parked (`LEAD-6`).
 *
 * The stage change refuses free text — see `setLeadStage` in
 * `../domain/leads.ts`, and the `leads_disposition_required` CHECK behind it.
 * That is the requirement taken literally: the reason field is the entire
 * reason the funnel is analytically useful, and "too expensive" typed five
 * different ways is five categories with one lead in each.
 */
export const leadDispositionReasons = pgTable(
  "lead_disposition_reasons",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Stable machine key. Reports group on this, so labels can be reworded. */
    code: varchar("code", { length: 48 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    /**
     * `lost` | `dormant` | `both`. Lost is "this will not happen"; dormant is
     * "not now". One list for both produces leads marked lost for a reason that
     * meant paused, and a pipeline that undercounts itself.
     */
    appliesTo: varchar("applies_to", { length: 8 }).notNull().default("both"),
    guidance: varchar("guidance", { length: 240 }),
    sortOrder: integer("sort_order").notNull().default(100),
    /** Retirement, never deletion — historical leads still point at this row. */
    isActive: boolean("is_active").notNull().default(true),
    ...referenceTimestamps,
  },
  (t) => [
    uniqueIndex("lead_disposition_reasons_code_key").on(t.tenantId, t.code),
    index("lead_disposition_reasons_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);

/**
 * The symptom / cause / remedy taxonomy (`JOB-14`).
 *
 * One table with a `kind` discriminator rather than three: identical shape,
 * identical lifecycle, one screen. Three tables would triple the CRUD surface
 * to express a one-word difference, and would turn "which causes follow this
 * symptom" into a three-way join instead of a self-join.
 *
 * `serviceSlug` null means every service. A picker with two hundred options is
 * a picker where everybody chooses the first entry.
 */
export const faultCodes = pgTable(
  "fault_codes",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** `symptom` | `cause` | `remedy`. */
    kind: varchar("kind", { length: 8 }).notNull(),
    code: varchar("code", { length: 48 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    description: varchar("description", { length: 400 }),
    serviceSlug: varchar("service_slug", { length: 64 }),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...referenceTimestamps,
  },
  (t) => [
    uniqueIndex("fault_codes_code_key").on(t.tenantId, t.kind, t.code),
    index("fault_codes_pick_idx").on(t.tenantId, t.kind, t.isActive, t.sortOrder),
  ],
);

/**
 * What `jobs.outcome_code` is allowed to contain (`JOB-13`).
 *
 * The column has existed since 0005 with nothing behind it. The two booleans
 * are why this is a table rather than an enum: the scheduler needs to know
 * which outcomes leave work owing and which end the job, without a hardcoded
 * list of exceptions repeated in three screens.
 */
export const jobOutcomeCodes = pgTable(
  "job_outcome_codes",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Matches `jobs.outcome_code`, which is varchar(32). */
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 400 }),
    /** Does the job end here, or is something still owed to the customer? */
    isTerminal: boolean("is_terminal").notNull().default(true),
    requiresReturnVisit: boolean("requires_return_visit").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...referenceTimestamps,
  },
  (t) => [uniqueIndex("job_outcome_codes_code_key").on(t.tenantId, t.code)],
);

/**
 * The rate card (`QTE-4`), and the source of the published schedule of rates
 * (`WEB-16`).
 *
 * A row is one *version* of a priced thing, not the priced thing itself:
 * `code` is the identity and `effectiveFrom`/`effectiveTo` are the period.
 * The question this has to answer is "what did we charge for this on that
 * date", because a quotation issued in March and queried in July is only
 * defensible if March's price can still be produced.
 *
 * The overlap is refused by a gist exclusion constraint rather than by
 * application code — see the migration. Two periods covering one day means the
 * answer depends on row order, which is how a customer and an accountant end up
 * quoting different numbers from the same table.
 */
export const rateCardItems = pgTable(
  "rate_card_items",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    code: varchar("code", { length: 48 }).notNull(),
    serviceSlug: varchar("service_slug", { length: 64 }).notNull(),
    label: varchar("label", { length: 160 }).notNull(),
    /** `hour` | `visit` | `point` | `item` | `m2` | `metre` | `day` | `month`. */
    unit: varchar("unit", { length: 16 }).notNull(),
    /** `standard` | `after_hours` | `emergency` | `weekend`. */
    rateBand: varchar("rate_band", { length: 16 }).notNull().default("standard"),
    /** `numeric(14,2)` at rest, integer minor units in code. Never a float. */
    unitPrice: money("unit_price").notNull(),
    currency: currencyCol(),
    minQuantity: numeric("min_quantity", { precision: 12, scale: 3 }),
    notes: varchar("notes", { length: 400 }),
    /** `WEB-16`. Publication is per line: not every rate is a public rate. */
    isPublished: boolean("is_published").notNull().default(false),
    effectiveFrom: date("effective_from").notNull(),
    /** Null means still current. Half-open, so periods can meet but not overlap. */
    effectiveTo: date("effective_to"),
    ...referenceTimestamps,
  },
  (t) => [
    index("rate_card_items_lookup_idx").on(
      t.tenantId,
      t.serviceSlug,
      t.rateBand,
      t.effectiveFrom,
    ),
  ],
);
