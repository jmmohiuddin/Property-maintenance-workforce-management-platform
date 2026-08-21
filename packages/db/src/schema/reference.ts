import {
  pgTable,
  varchar,
  date,
  integer,
  smallint,
  timestamp,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol } from "./_shared";
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
