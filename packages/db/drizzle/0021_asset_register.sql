-- The asset register (`CON-13`).
--
-- ── WHAT WAS ALREADY HERE ───────────────────────────────────────────────────
--
-- The assets table has existed since migration 0000 with no domain code, no
-- screen and no row in it. TRD section 6.2 rules on all fourteen such tables
-- and its verdict on this one is Build, not reshape and not drop: it is "the
-- basis of per-asset PPM and commercial tender pricing". Its logical model
-- there names tenant_id, property_id, category, make, model, serial_no,
-- location_text, install_date, warranty_expiry, last_service_at and
-- next_service_due.
--
-- Nine of those eleven already existed as columns. This migration adds the
-- tenth -- category -- and narrows two that were declared as the wrong type.
-- Nothing is dropped and nothing is renamed, because everything already there
-- was right.
--
-- ── WHY category IS A TABLE AND NOT A varchar ───────────────────────────────
--
-- Same argument as fault_codes and job_outcome_codes in 0012, and it lands
-- harder here. The register exists to answer questions asked across rows --
-- how many chillers are we contracted to maintain, what does servicing one
-- cost, how often does this model fail -- and those are the numbers a
-- commercial AMC is priced from and a tender is evaluated on. A kind typed by
-- hand gives "chiller", "Chiller", "chiler" and "AC plant" for one thing, and
-- the question stops having an answer. It cannot be retrofitted: by the time
-- anybody asks, the history is already written.
--
-- ── WHY THE DAY COLUMNS CHANGE TYPE ─────────────────────────────────────────
--
-- install_date and warranty_expiry are days, not instants, and were declared
-- timestamptz. A day stored as an instant is read back through whatever offset
-- the reader is in: a warranty expiring on 1 July is stored as 30 June 20:00
-- UTC, and a check against today reports an expired warranty as still valid for
-- four hours out of every twenty-four. That error runs in the expensive
-- direction -- it authorises a repair as covered that the manufacturer will
-- refuse to pay for. As date, the value read is the value written, and the
-- comparison happens in Postgres against current_date.
--
-- last_service_at and next_service_due stay timestamptz. A PPM visit is
-- scheduled to a time and the dispatch board reads them as instants.

-- ── The vocabulary (CON-13, following ADM-10) ───────────────────────────────
CREATE TABLE "asset_categories" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Stable machine key. Reports group on this, so a label can be reworded for
	-- clarity without every historical asset changing category underneath a
	-- figure somebody has been quoting to a client for a year.
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	-- Which trade services this kind of plant. Matches a catalogue service slug,
	-- so the register and the job it produces agree about who is being sent.
	"service_slug" varchar(64),
	-- The PPM period an asset of this kind gets unless the register overrides
	-- it. Belongs to the kind rather than the asset for the same reason the kind
	-- is a list at all: a lift is inspected monthly and a water tank cleaned
	-- twice a year whoever happens to be entering it.
	"default_ppm_interval_days" integer,
	"sort_order" integer DEFAULT 100 NOT NULL,
	-- Retirement, not deletion. A kind still attached to installed plant cannot
	-- be removed without rewriting the register.
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_categories_ppm_interval" CHECK (
		"default_ppm_interval_days" IS NULL OR "default_ppm_interval_days" > 0
	)
);
--> statement-breakpoint

ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "asset_categories_code_key" ON "asset_categories" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "asset_categories_pick_idx" ON "asset_categories" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint

-- ── The register points at it ───────────────────────────────────────────────
ALTER TABLE "assets" ADD COLUMN "category_id" uuid;--> statement-breakpoint

ALTER TABLE "assets" ADD CONSTRAINT "assets_category_fk"
	FOREIGN KEY ("category_id") REFERENCES "public"."asset_categories"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Nullable in the column, required by a check -- and NOT VALID, which is the
-- point rather than a compromise. It means every insert and every update from
-- here on carries a kind, while any row that predates the vocabulary is left
-- alone rather than blocking the migration or being back-filled with a guess.
-- A guessed category is indistinguishable from one somebody chose, and the
-- first tender priced off it would be wrong in a way nothing could detect.
-- This table should have no rows anywhere -- it has never had a writer -- so in
-- practice the constraint is fully enforced from today. The precedent is
-- leads_disposition_required in 0012.
ALTER TABLE "assets" ADD CONSTRAINT "assets_category_required" CHECK (
	"category_id" IS NOT NULL
) NOT VALID;--> statement-breakpoint

-- ── The two day-valued columns, narrowed ────────────────────────────────────
--
-- USING the Dubai wall-clock day, not the UTC one. If any row did exist, the
-- day its operator meant is the day they saw on the screen.
ALTER TABLE "assets"
	ALTER COLUMN "installed_on" TYPE date
	USING ("installed_on" AT TIME ZONE 'Asia/Dubai')::date;--> statement-breakpoint
ALTER TABLE "assets"
	ALTER COLUMN "warranty_expires_on" TYPE date
	USING ("warranty_expires_on" AT TIME ZONE 'Asia/Dubai')::date;--> statement-breakpoint

ALTER TABLE "assets" ADD CONSTRAINT "assets_warranty_after_install" CHECK (
	"warranty_expires_on" IS NULL OR "installed_on" IS NULL
	OR "warranty_expires_on" >= "installed_on"
);--> statement-breakpoint

CREATE INDEX "assets_category_idx" ON "assets" USING btree ("tenant_id","category_id");--> statement-breakpoint
-- The index the warranty question reads. It is the same shape as
-- employee_documents_blocking_expiry_idx, because it is the same question asked
-- about a different subject: what expires, and when.
CREATE INDEX "assets_warranty_idx" ON "assets" USING btree ("tenant_id","warranty_expires_on");--> statement-breakpoint

-- ── The seven kinds CON-13 names ────────────────────────────────────────────
--
-- Seeded for every tenant that already exists, because these seven are written
-- into the requirement rather than chosen by the operator, and an empty picker
-- on the day this ships means the first asset registered gets a kind that is
-- really free text with extra steps -- the exact failure the table exists to
-- prevent. A tenant created after this migration gets them from
-- STANDARD_ASSET_CATEGORIES in packages/db/src/domain/assets.ts, which is the
-- authority from here on; this list is a copy of it frozen at migration time.
--
-- The intervals are the UAE norms these kinds are actually maintained on: lifts
-- monthly, water tanks on the six-month cleaning cycle, boards on an annual
-- inspection, HVAC plant quarterly. They are defaults the register can override
-- per asset, not rules.
--
-- ON CONFLICT DO NOTHING so re-running is a no-op and an operator's edit to a
-- label survives it.
INSERT INTO "asset_categories"
	("tenant_id", "code", "label", "description", "service_slug", "default_ppm_interval_days", "sort_order")
SELECT t."id", v."code", v."label", v."description", v."service_slug", v."ppm", v."sort_order"
  FROM "tenants" t
 CROSS JOIN (VALUES
	('chiller', 'Chiller', 'Central cooling plant. The single most expensive item on most AMCs.', 'hvac-installation-maintenance', 90, 10),
	('split_unit', 'Split unit', 'Wall, ducted or cassette split serving one space.', 'hvac-installation-maintenance', 90, 20),
	('fcu', 'Fan coil unit (FCU)', 'Chilled-water terminal unit. Usually one per apartment or zone.', 'hvac-installation-maintenance', 90, 30),
	('pump', 'Pump', 'Water, booster, drainage, chilled-water or fire pump.', 'electromechanical-installation', 180, 40),
	('water_tank', 'Water tank', 'Potable or storage tank. Cleaning and testing is on a six-month cycle.', 'building-cleaning', 180, 50),
	('distribution_board', 'Distribution board (DB)', 'Main or sub distribution board, including its thermographic inspection.', 'electrical-fittings-repair', 365, 60),
	('lift', 'Lift', 'Passenger or goods lift. Inspected monthly and by a third party annually.', 'electromechanical-installation', 30, 70)
 ) AS v("code", "label", "description", "service_slug", "ppm", "sort_order")
 ON CONFLICT DO NOTHING;
