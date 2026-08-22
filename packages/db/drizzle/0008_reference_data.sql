-- Reference data an administrator maintains, so a taxonomy change stops being a
-- deploy (`ADM-10`).
--
-- The half of this that matters most is the calendar. `DEFAULT_CALENDAR` in
-- packages/core ships with `publicHolidays: {}` and `ramadanPeriods: []`, and
-- that emptiness is deliberate — a hardcoded holiday list goes stale in January
-- and then silently schedules work on Eid. Honest-but-empty is only the right
-- default if somebody can fill it in without an engineer, which is what these
-- tables are for. `calendarWarnings()` is already reporting the gap; until now
-- there was nowhere to put the answer.
--
-- ── WHAT DELIBERATELY HAS NO COLUMN ─────────────────────────────────────────
--
-- The summer midday ban, the Ramadan two-hour reduction, the 8/48-hour maxima
-- and the five-hour break interval are statutory. None of them gets a column
-- here, and that is the enforcement mechanism: a value with no column cannot be
-- edited by any screen, cannot be weakened by a careless UPDATE, and cannot be
-- reached by a future migration without somebody writing it down. They stay in
-- `DEFAULT_CALENDAR` as constants and are read from there on every load.
--
-- `min_break_minutes` is the one exception, and it is a floor rather than a
-- setting: the CHECK below refuses anything under the statutory hour, so the
-- only direction it can move is more generous.
--
-- ── COMPANY IDENTITY IS NOT HERE ────────────────────────────────────────────
--
-- `ADM-9` needs no table. Identity overrides live in `tenants.settings`, under
-- the `identity` key, because `packages/core` has zero runtime dependencies and
-- therefore cannot read a database at all — the field app imports it. The
-- resolution order (database override first, environment configuration behind
-- it) is applied at the edge in `packages/db/src/domain/reference.ts`, which is
-- the layer that is allowed to know what a database is.

-- ── Public holidays (ADM-10, JOB-6 rule 3) ──────────────────────────────────
--
-- Keyed by date because that is how `WorkingCalendar.publicHolidays` is keyed:
-- `YYYY-MM-DD` → name. Islamic-calendar holidays are announced annually by the
-- cabinet and confirmed by moon sighting, so they cannot be computed — an
-- arithmetic Hijri calendar gets them *usually* right, and "usually right" is
-- the wrong property for a rule that decides whether thirty people work.
CREATE TABLE "public_holidays" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holiday_date" date NOT NULL,
	"name" varchar(120) NOT NULL,
	-- Where the date came from — "WAM, 12 Jan 2026" — so next year's
	-- administrator can tell a confirmed date from a guess.
	"source_note" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Ramadan (ADM-10, JOB-6 rule 2) ──────────────────────────────────────────
--
-- A period rather than a set of dates: the statutory reduction applies to the
-- whole month, and storing thirty rows would make "shift the start by a day
-- because the moon was not sighted" a thirty-row edit instead of a one-row one.
CREATE TABLE "ramadan_periods" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(80) NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"source_note" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- An inverted period matches no dates at all, so `isRamadan()` would quietly
	-- return false for the entire month and nobody would see an error.
	CONSTRAINT "ramadan_periods_order" CHECK ("ends_on" >= "starts_on")
);
--> statement-breakpoint

-- ── Working calendar settings (OPEN-8) ──────────────────────────────────────
--
-- One row per tenant, `tenant_id` as both first column and primary key: there
-- is exactly one working week and a second row would mean two answers to a
-- question that has one.
CREATE TABLE "calendar_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	-- 0 = Sunday … 6 = Saturday, matching `DubaiTime.weekday` so no translation
	-- happens between here and the predicate that reads it. Saturday–Sunday is
	-- the common private-sector arrangement (OPEN-8), not an assumption.
	"weekend_days" smallint[] DEFAULT '{6,0}' NOT NULL,
	"open_minute" integer DEFAULT 480 NOT NULL,
	"close_minute" integer DEFAULT 1080 NOT NULL,
	-- Statutory floor, never a ceiling. See the header.
	"min_break_minutes" integer DEFAULT 60 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_settings_hours" CHECK (
		"open_minute" >= 0 AND "close_minute" <= 1440 AND "open_minute" < "close_minute"
	),
	-- Every day a weekend means `nextWorkingWindow()` searches two years and then
	-- throws, which surfaces as a failed page load somewhere unrelated to the
	-- screen that caused it. Refuse it at the point of entry instead.
	CONSTRAINT "calendar_settings_weekend" CHECK (
		"weekend_days" <@ ARRAY[0,1,2,3,4,5,6]::smallint[]
		AND cardinality("weekend_days") <= 6
	),
	CONSTRAINT "calendar_settings_break" CHECK ("min_break_minutes" >= 60)
);
--> statement-breakpoint

ALTER TABLE "public_holidays" ADD CONSTRAINT "public_holidays_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ramadan_periods" ADD CONSTRAINT "ramadan_periods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_settings" ADD CONSTRAINT "calendar_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- One holiday per date, and the index the year-at-a-time load path scans.
-- Two rows for 2 December would put two names in a map keyed by date, and which
-- one survived would depend on row order.
CREATE UNIQUE INDEX "public_holidays_date_key" ON "public_holidays" USING btree ("tenant_id","holiday_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ramadan_periods_start_key" ON "ramadan_periods" USING btree ("tenant_id","starts_on");
