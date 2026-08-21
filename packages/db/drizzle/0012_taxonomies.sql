-- The controlled vocabularies (`ADM-10`), and lead attribution (`DB-5`,
-- `LEAD-4`).
--
-- 0008 built the calendar half of `ADM-10`. This is the other half: the lists
-- that decide what an operator is *allowed to say* about a lead, a visit or a
-- price. Every one of them is administrator-maintained for the same reason the
-- holiday list is — a taxonomy that needs a deploy is a taxonomy that stops
-- being edited, and a taxonomy nobody edits gets worked around in the notes
-- field.
--
-- ── WHY A LIST RATHER THAN A TEXT COLUMN, IN EACH CASE ──────────────────────
--
-- Every table here replaces something that would otherwise be free text, and in
-- every case the free-text version is not merely untidy — it destroys the only
-- output the field was collected for:
--
--   * A lost-reason typed by hand gives you "price", "too expensive", "Price",
--     "cost" and "budget" for one reason, and the funnel report that was the
--     entire point of asking cannot group them (`LEAD-6`).
--   * A fault typed by hand cannot answer "how many times has this chiller
--     model failed the same way", which is what turns service history into
--     reliability data, PPM justification and tender evidence (`JOB-14`). The
--     PRD is blunt that this is the mistake that cannot be retrofitted: the
--     history is already written by the time anyone wants the answer.
--   * An outcome typed by hand hides `no_access` and `customer_not_home`, which
--     are a large share of real visits and are the ones worth counting
--     (`JOB-13`).
--   * A price typed into a quote line from memory is the difference between a
--     rate card and a rumour (`QTE-4`).
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
--
-- `ADM-10` also names services, exclusion lists and certification schemes.
-- Services and their exclusions are the source of sixty statically generated
-- public pages and of every piece of JSON-LD the site publishes; they live in
-- `packages/core/src/catalog.ts` and are compiled into the build, so moving
-- them into a table is a change to how the public site is rendered rather than
-- a new admin screen, and it is not attempted here. Certification schemes
-- belong with the workforce compliance work that owns `technician_certifications`.

CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint

-- ── Lead disposition reasons (LEAD-6) ───────────────────────────────────────
--
-- `applies_to` exists because "lost" and "dormant" are not the same question.
-- Lost is "this will not happen" — price, competitor, scope. Dormant is "not
-- now" — budget year, tenant moving out, waiting on the landlord. Offering one
-- list for both produces leads marked lost for a reason that means paused, and
-- a pipeline that undercounts the work still available to it.
CREATE TABLE "lead_disposition_reasons" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Stable machine key. Reports group on this, so the label can be reworded
	-- for clarity without every historical lead changing category underneath a
	-- chart somebody has been reading for a year.
	"code" varchar(48) NOT NULL,
	"label" varchar(120) NOT NULL,
	"applies_to" varchar(8) DEFAULT 'both' NOT NULL,
	-- When to pick this one rather than the neighbouring one. Two reasons that
	-- overlap get used interchangeably, and then neither number means anything.
	"guidance" varchar(240),
	"sort_order" integer DEFAULT 100 NOT NULL,
	-- Retirement, not deletion. A reason still attached to last quarter's lost
	-- leads cannot be removed without rewriting last quarter, so the screen
	-- deactivates instead: it disappears from the picker and stays in the data.
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_disposition_reasons_applies_to" CHECK (
		"applies_to" IN ('lost', 'dormant', 'both')
	)
);
--> statement-breakpoint

-- ── Fault codes (JOB-14) ────────────────────────────────────────────────────
--
-- One table with a `kind` discriminator rather than three tables, because the
-- three parts have identical shape, identical lifecycle and one screen. Three
-- tables would triple the CRUD surface to express a difference that is one
-- word long — and would make the obvious next question ("which causes follow
-- this symptom") a three-way join instead of a self-join.
--
-- `service_slug` is nullable and null means "every service". A blocked drain is
-- a plumbing symptom; "no power" is not. Scoping the list is what keeps the
-- technician's picker at six options rather than two hundred, and a picker with
-- two hundred options is a picker where everybody chooses the first entry.
CREATE TABLE "fault_codes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(8) NOT NULL,
	"code" varchar(48) NOT NULL,
	"label" varchar(160) NOT NULL,
	"description" varchar(400),
	"service_slug" varchar(64),
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fault_codes_kind" CHECK ("kind" IN ('symptom', 'cause', 'remedy'))
);
--> statement-breakpoint

-- ── Job outcome codes (JOB-13) ──────────────────────────────────────────────
--
-- `jobs.outcome_code` has existed since 0005 as a bare varchar with nothing
-- behind it, which meant the column could hold anything and the seven outcomes
-- the PRD names existed only in prose. This is the list it points at.
--
-- The two booleans are the reason this is a table and not an enum. `no_access`
-- and `return_visit_required` are not failures to be tidied away — they are a
-- large share of real visits, and the scheduler needs to know which outcomes
-- leave work owing (`requires_return_visit`) and which end the job
-- (`is_terminal`) without a hardcoded list of exceptions in three screens.
CREATE TABLE "job_outcome_codes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Matches `jobs.outcome_code`, which is varchar(32).
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	"is_terminal" boolean DEFAULT true NOT NULL,
	"requires_return_visit" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Rate card (QTE-4, source for WEB-16) ────────────────────────────────────
--
-- Versioned by period, not overwritten in place. The question this table has to
-- answer is "what did we charge for this on that date", because a quote issued
-- in March and queried in July is only defensible if March's price can still be
-- produced. A single mutable price answers "what do we charge now" and silently
-- rewrites every past quotation the moment somebody edits it.
--
-- So `code` is the identity of the priced thing and a row is one *version* of
-- it. Raising a price closes the current period and opens a new one; nothing is
-- ever updated in place except to correct a period that has not started.
CREATE TABLE "rate_card_items" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Stable across versions. Two rows with the same code and band are the same
	-- price at two different times, which is what makes history queryable.
	"code" varchar(48) NOT NULL,
	"service_slug" varchar(64) NOT NULL,
	"label" varchar(160) NOT NULL,
	-- Closed list rather than free text, and this one is genuinely structural:
	-- the quote builder multiplies by quantity, and "hr" / "hour" / "Hour"
	-- sitting side by side is both an arithmetic hazard and a published rate
	-- card that reads as though nobody checked it.
	"unit" varchar(16) NOT NULL,
	"rate_band" varchar(16) DEFAULT 'standard' NOT NULL,
	-- numeric(14,2) at rest, integer minor units in code. See packages/core/src/money.ts;
	-- no float touches a price at any point between this column and a quotation.
	"unit_price" numeric(14, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	-- "Minimum one hour", "minimum two points". The commonest cause of an
	-- argument about an invoice that the rate card could have prevented.
	"min_quantity" numeric(12, 3),
	"notes" varchar(400),
	-- `WEB-16`. A rate card has internal lines nobody publishes — subcontracted
	-- work at cost, contract-only pricing — so publication is a per-line
	-- decision rather than a property of the table.
	"is_published" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	-- Null means still current. Half-open at the end: a period that ends on the
	-- day the next one starts must not both apply on that day.
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_card_items_band" CHECK (
		"rate_band" IN ('standard', 'after_hours', 'emergency', 'weekend')
	),
	CONSTRAINT "rate_card_items_unit" CHECK (
		"unit" IN ('hour', 'visit', 'point', 'item', 'm2', 'metre', 'day', 'month')
	),
	-- A negative price is a credit and belongs on a credit note, not on a rate
	-- card. Zero is allowed: "included in the callout" is a real rate card line.
	CONSTRAINT "rate_card_items_price" CHECK ("unit_price" >= 0),
	CONSTRAINT "rate_card_items_min_quantity" CHECK (
		"min_quantity" IS NULL OR "min_quantity" > 0
	),
	CONSTRAINT "rate_card_items_period" CHECK (
		"effective_to" IS NULL OR "effective_to" > "effective_from"
	),
	-- The constraint that makes history trustworthy. Two overlapping periods for
	-- one code and band means "what did we charge on 3 March" has two answers
	-- and the winner is decided by row order — which is how a customer and an
	-- accountant end up quoting different numbers from the same table. Postgres
	-- refuses the overlap instead.
	--
	-- `tenant_id` is inside the key, so a conflict can only ever be raised
	-- against a row in the operator's own tenant; the error cannot reveal that
	-- another tenant priced anything at all.
	CONSTRAINT "rate_card_items_no_overlap" EXCLUDE USING gist (
		"tenant_id" WITH =,
		"code" WITH =,
		"rate_band" WITH =,
		daterange("effective_from", "effective_to", '[)') WITH &&
	)
);
--> statement-breakpoint

ALTER TABLE "lead_disposition_reasons" ADD CONSTRAINT "lead_disposition_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fault_codes" ADD CONSTRAINT "fault_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_outcome_codes" ADD CONSTRAINT "job_outcome_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_card_items" ADD CONSTRAINT "rate_card_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "lead_disposition_reasons_code_key" ON "lead_disposition_reasons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "lead_disposition_reasons_pick_idx" ON "lead_disposition_reasons" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "fault_codes_code_key" ON "fault_codes" USING btree ("tenant_id","kind","code");--> statement-breakpoint
CREATE INDEX "fault_codes_pick_idx" ON "fault_codes" USING btree ("tenant_id","kind","is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "job_outcome_codes_code_key" ON "job_outcome_codes" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "rate_card_items_lookup_idx" ON "rate_card_items" USING btree ("tenant_id","service_slug","rate_band","effective_from");--> statement-breakpoint

-- ── Lead attribution (DB-5, LEAD-4) ─────────────────────────────────────────
--
-- Ten service pages, ten area pages, JSON-LD on every one of them and an
-- llms.txt exist to produce enquiries, and until these columns exist nothing
-- records which of them produced any. That is the whole of `LEAD-4`: without
-- attribution the answer-engine investment cannot be evaluated, so it is
-- defended on faith and cut on faith.
--
-- The `attribution` JSONB column stays. Structured columns are what a funnel
-- report can group by; the blob is where the unanticipated goes — `gclid`,
-- `msclkid`, a user agent, whatever the next advertising platform invents —
-- and losing that would trade one gap for another.
ALTER TABLE "leads" ADD COLUMN "channel" varchar(24) DEFAULT 'website' NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_source" varchar(120);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_medium" varchar(120);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "utm_campaign" varchar(160);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "landing_page" varchar(512);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "referrer" varchar(512);--> statement-breakpoint
-- `LEAD-4` asks specifically which number was called, because that is how a
-- tracked number on one page is told apart from the number printed on a van.
ALTER TABLE "leads" ADD COLUMN "called_number" varchar(32);--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "disposition_reason_id" uuid;--> statement-breakpoint

-- A CHECK rather than a lookup table, unlike everything above it. The channel
-- list is not a taxonomy an administrator tunes — notification routing, the
-- 30-second manual create form and the funnel columns are all written against
-- these values, so adding one is a code change whichever way it is stored.
-- `LEAD-1` names them: web form, phone, WhatsApp, walk-in, referral, contract
-- enquiry, aggregator.
ALTER TABLE "leads" ADD CONSTRAINT "leads_channel" CHECK (
	"channel" IN (
		'website', 'phone', 'whatsapp', 'walk_in', 'referral',
		'contract_enquiry', 'aggregator', 'portal', 'other'
	)
);--> statement-breakpoint

-- Carried across from the older, looser `source` column where the two agree.
-- `source` is left in place and still written: it is read by existing code, and
-- a migration that quietly repurposes a column other queries depend on is how a
-- report starts returning nothing for reasons nobody can find.
UPDATE "leads"
   SET "channel" = "source"
 WHERE "source" IN (
	'website', 'phone', 'whatsapp', 'walk_in', 'referral',
	'contract_enquiry', 'aggregator', 'portal'
 );--> statement-breakpoint

ALTER TABLE "leads" ADD CONSTRAINT "leads_disposition_reason_fk"
	FOREIGN KEY ("disposition_reason_id") REFERENCES "public"."lead_disposition_reasons"("id")
	ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- `LEAD-6`, enforced where it cannot be argued with. A lead in `lost` or
-- `dormant` carries a coded reason or it does not exist.
--
-- NOT VALID, and that is the point rather than a compromise. It means: every
-- insert and every update from now on is checked, and the lost leads already
-- sitting in the table — captured before there was a list to choose from — are
-- left alone rather than blocking the migration or being back-filled with a
-- guess. A back-filled reason is indistinguishable from one somebody chose, and
-- the first report drawn from it would be wrong in a way nothing could detect.
ALTER TABLE "leads" ADD CONSTRAINT "leads_disposition_required" CHECK (
	"stage" NOT IN ('lost', 'dormant') OR "disposition_reason_id" IS NOT NULL
) NOT VALID;--> statement-breakpoint

-- The index the funnel report reads: leads by channel over a period.
CREATE INDEX "leads_channel_idx" ON "leads" USING btree ("tenant_id","channel","created_at");--> statement-breakpoint
CREATE INDEX "leads_campaign_idx" ON "leads" USING btree ("tenant_id","utm_campaign") WHERE "utm_campaign" IS NOT NULL;--> statement-breakpoint

-- ── The seven outcome codes JOB-13 names ────────────────────────────────────
--
-- Seeded for every tenant that already exists, because these seven are
-- prescribed by the requirement rather than chosen by the operator, and an
-- empty list on the day this ships would mean the first completed job has
-- nothing valid to record. A tenant created after this migration gets them from
-- `STANDARD_JOB_OUTCOMES` in packages/db/src/domain/reference.ts, which the
-- admin screen offers as one button; that constant is the authority from here
-- on and this list is a copy of it frozen at migration time.
INSERT INTO "job_outcome_codes"
	("tenant_id", "code", "label", "description", "is_terminal", "requires_return_visit", "sort_order")
SELECT t."id", v."code", v."label", v."description", v."is_terminal", v."requires_return_visit", v."sort_order"
  FROM "tenants" t
 CROSS JOIN (VALUES
	('completed', 'Completed', 'Work finished on this visit. Nothing outstanding.', true, false, 10),
	('partial', 'Partially complete', 'Some of the scope was done; the rest is still owed.', false, true, 20),
	('return_visit_required', 'Return visit required', 'Parts on order, another trade needed, or the work does not fit one visit.', false, true, 30),
	('no_access', 'No access', 'Could not reach the work: no key, no permit, blocked area.', false, true, 40),
	('customer_not_home', 'Customer not home', 'Nobody on site at the agreed time.', false, true, 50),
	('aborted_unsafe', 'Aborted — unsafe', 'Stopped on safety grounds. Records why the visit produced no work.', false, true, 60),
	('quote_required', 'Quote required', 'Scope is larger than the visit; priced rather than carried out.', true, false, 70)
 ) AS v("code", "label", "description", "is_terminal", "requires_return_visit", "sort_order")
 ON CONFLICT DO NOTHING;
