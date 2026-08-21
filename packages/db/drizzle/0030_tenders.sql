-- Tenders and tender packs (`CON-11`, `CON-12`).
--
-- ── WHY THIS IS NOT A SECOND leads TABLE ────────────────────────────────────
--
-- leads carries a stage enum and is indexed on (tenant_id, stage, created_at),
-- because for a lead the organising fact is where the conversation got to.
--
-- A tender has a closing date somebody else published. Nothing anybody does
-- moves it, and a bid finished the day after is worth nothing at all. CON-11
-- states the consequence in one sentence -- deadline-driven, not stage-driven,
-- a tender queue sorts by days until deadline, always -- and it is held here
-- structurally: there is no stage column, and the index the queue reads is
-- (tenant_id, outcome, submission_deadline). If a stage column ever lands in
-- this table, the requirement has been lost.
--
-- ── WHY THE DAY COLUMNS ARE date ────────────────────────────────────────────
--
-- submission_deadline, decision_date, submitted_on, decided_on and prepared_on
-- are days, not instants. Migration 0021 makes this argument for an asset
-- warranty; it lands harder here. A deadline stored as timestamptz is read back
-- through the reader's offset, and in Dubai (UTC+4) a tender closing on
-- 1 September is stored as 31 August 20:00 UTC -- so a comparison against
-- "today" reports the tender as closed a day early, or, running the other way,
-- reports a lapsed insurance certificate as valid for the first four hours of
-- every day. The second error is the one that puts an expired certificate into
-- a tender pack, which is the specific failure CON-12 exists to prevent.
--
-- As date, the value read is the value written and every comparison happens in
-- Postgres against current_date.
--
-- ── WHY THE PACK IS A ROW AND NOT A COLUMN ──────────────────────────────────
--
-- CON-12's pack is assembled from live data, which means it is different every
-- time it is built: a renewed licence, a rate card that has moved, a chiller
-- replaced. What was submitted has to stay reproducible exactly as submitted,
-- because in a dispute over a RERA three-bid process the question is what the
-- bidder claimed on the day. So tender_packs is one row per tender per business
-- date, holding the storage key, the SHA-256 and the manifest of what was
-- attached -- and prepared_on is the pinned date the PDF's own metadata carries,
-- which is what makes the same pack render to the same bytes.

-- ── The vocabularies (CON-11, following ADM-10) ─────────────────────────────
CREATE TABLE "tender_opportunity_sources" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Stable machine key. Reports group on this, so a label can be reworded
	-- without every historical tender changing channel underneath a figure.
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	"sort_order" integer DEFAULT 100 NOT NULL,
	-- Retirement, not deletion. A channel still cited by a recorded tender
	-- cannot be removed without rewriting the history.
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "tender_outcome_reasons" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	-- Which outcomes may cite this reason: won, lost, or both. A single flat
	-- list makes a losing reason look like an option for a win.
	"applies_to" varchar(8) DEFAULT 'lost' NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tender_outcome_reasons_applies_to" CHECK (
		"applies_to" IN ('won', 'lost', 'both')
	)
);
--> statement-breakpoint

ALTER TABLE "tender_opportunity_sources" ADD CONSTRAINT "tender_opportunity_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_outcome_reasons" ADD CONSTRAINT "tender_outcome_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "tender_opportunity_sources_code_key" ON "tender_opportunity_sources" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "tender_opportunity_sources_pick_idx" ON "tender_opportunity_sources" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "tender_outcome_reasons_code_key" ON "tender_outcome_reasons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "tender_outcome_reasons_pick_idx" ON "tender_outcome_reasons" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint

-- ── The pipeline ───────────────────────────────────────────────────────────
CREATE TABLE "tenders" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(32) NOT NULL,
	"title" varchar(240) NOT NULL,
	-- The organisation that published the tender, as it appears on the
	-- document. Free text and required: an OA management company inviting three
	-- bids is usually not a customer yet, and refusing to record the tender
	-- until somebody creates a customer record for a body the company may never
	-- work for is how tenders end up in a spreadsheet instead.
	"issuing_body" varchar(200) NOT NULL,
	-- Set later, if the issuer becomes an account.
	"customer_id" uuid,
	"opportunity_source_id" uuid NOT NULL,
	-- What the issuer's own portal knows this by: eSupply, Etimad, an OA's ref.
	"portal_reference" varchar(64),
	-- The spine. NOT NULL, because a tender with no closing date cannot be
	-- queued and a queue is what CON-11 asks for.
	"submission_deadline" date NOT NULL,
	"decision_date" date,
	-- The issuer's budget year as they write it: 2027, FY2027-28. CON-11's
	-- point is that OA work is won before budget season, so this is what the
	-- "which cycle are we bidding into" review groups on.
	"budget_cycle" varchar(16),
	"scope_of_work" text,
	-- How many other bidders are known to be in. NULL means unknown, which is
	-- not the same as zero and must not be stored as it.
	"competitors_known" smallint,
	"competitor_notes" text,
	-- numeric(14,2) at rest, integer minor units in code. Never a float.
	"bid_value" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	-- The day the bid actually went in. Deliberately separate from the outcome:
	-- "we sent it and have not heard" and "we did not send it" are different
	-- states, and collapsing them records a lost bid as a missed deadline.
	"submitted_on" date,
	"outcome" varchar(16) DEFAULT 'pending' NOT NULL,
	"outcome_reason_id" uuid,
	"outcome_note" text,
	"decided_on" date,
	"decided_by_id" uuid,
	"owner_id" uuid,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenders_outcome" CHECK (
		"outcome" IN ('pending', 'won', 'lost', 'withdrawn', 'no_bid')
	),
	-- A decision cannot precede the closing date. Enforced here as well as in
	-- the domain layer because the pack prints both and an evaluator reads them.
	CONSTRAINT "tenders_decision_after_deadline" CHECK (
		"decision_date" IS NULL OR "decision_date" >= "submission_deadline"
	),
	-- A lost tender carries a reason. CON-11 asks for "outcome + reason", and
	-- the reason is where the value is: "we lost" is a number, "we lost four to
	-- an incomplete submission" is the sentence that funds fixing the pack.
	CONSTRAINT "tenders_loss_needs_reason" CHECK (
		"outcome" <> 'lost' OR "outcome_reason_id" IS NOT NULL
	),
	-- Unknown is NULL, and a recorded count is a real one.
	CONSTRAINT "tenders_competitors_non_negative" CHECK (
		"competitors_known" IS NULL OR "competitors_known" >= 0
	)
);
--> statement-breakpoint

ALTER TABLE "tenders" ADD CONSTRAINT "tenders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- ON DELETE restrict, like every other controlled vocabulary in this schema: a
-- channel still cited by a recorded tender cannot be deleted out from under it.
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_opportunity_source_id_fk" FOREIGN KEY ("opportunity_source_id") REFERENCES "public"."tender_opportunity_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_outcome_reason_id_fk" FOREIGN KEY ("outcome_reason_id") REFERENCES "public"."tender_outcome_reasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenders" ADD CONSTRAINT "tenders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "tenders_tenant_reference_key" ON "tenders" USING btree ("tenant_id","reference");--> statement-breakpoint
-- THE index. The queue reads this one, in this order, and takes no sort
-- argument -- see domain/tenders.ts for why that is the design and not an
-- omission.
CREATE INDEX "tenders_deadline_idx" ON "tenders" USING btree ("tenant_id","outcome","submission_deadline");--> statement-breakpoint
CREATE INDEX "tenders_cycle_idx" ON "tenders" USING btree ("tenant_id","budget_cycle","outcome");--> statement-breakpoint
CREATE INDEX "tenders_customer_idx" ON "tenders" USING btree ("tenant_id","customer_id");--> statement-breakpoint

-- ── The buildings a tender is priced for ───────────────────────────────────
--
-- Rows rather than a property_id column, because an OA tender is routinely for
-- a portfolio -- three towers under one management company -- and the per-asset
-- PPM schedule in the pack is the union of their registers. Same shape as
-- contract_properties, which is the same relationship one step later.
CREATE TABLE "tender_properties" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "tender_properties" ADD CONSTRAINT "tender_properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_properties" ADD CONSTRAINT "tender_properties_tender_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_properties" ADD CONSTRAINT "tender_properties_property_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "tender_properties_key" ON "tender_properties" USING btree ("tenant_id","tender_id","property_id");--> statement-breakpoint
CREATE INDEX "tender_properties_property_idx" ON "tender_properties" USING btree ("tenant_id","property_id");--> statement-breakpoint

-- ── The assembled pack (CON-12) ────────────────────────────────────────────
CREATE TABLE "tender_packs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tender_id" uuid NOT NULL,
	-- The pinned business date. Written into the PDF's creation and
	-- modification dates, and the date every expiry in the pack was judged
	-- against. Same input, same date, same bytes -- which is the only thing that
	-- makes the stored hash below mean anything.
	"prepared_on" date NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"page_count" integer NOT NULL,
	"byte_size" integer NOT NULL,
	-- What went in: every attached certificate with its own hash, and the
	-- warnings the operator was shown. Kept so "what evidence did we submit" is
	-- answerable without opening the PDF.
	"manifest" text NOT NULL,
	"prepared_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tender_packs_sha256_hex" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tender_packs_pages_positive" CHECK ("page_count" > 0)
);
--> statement-breakpoint

ALTER TABLE "tender_packs" ADD CONSTRAINT "tender_packs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_packs" ADD CONSTRAINT "tender_packs_tender_id_fk" FOREIGN KEY ("tender_id") REFERENCES "public"."tenders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tender_packs" ADD CONSTRAINT "tender_packs_prepared_by_id_users_id_fk" FOREIGN KEY ("prepared_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- One pack per tender per business date. Re-assembling on the same day returns
-- the stored artefact and renders nothing; assembling again after a licence
-- renewal is a new, dated pack sitting beside the one that was submitted.
CREATE UNIQUE INDEX "tender_packs_day_key" ON "tender_packs" USING btree ("tenant_id","tender_id","prepared_on");--> statement-breakpoint
CREATE INDEX "tender_packs_tender_idx" ON "tender_packs" USING btree ("tenant_id","tender_id","prepared_on");--> statement-breakpoint

-- ── The four channels CON-11 names ─────────────────────────────────────────
--
-- Seeded for every tenant that already exists, for the reason the asset kinds
-- in 0021 are: these four are written into the requirement rather than chosen
-- by the operator, and an empty picker on the day this ships means the first
-- tender recorded gets a channel that is free text with extra steps -- the
-- exact failure a controlled vocabulary exists to prevent.
--
-- A tenant created after this migration gets them from
-- STANDARD_TENDER_SOURCES in packages/db/src/domain/tenders.ts, which is the
-- authority from here on; this list is a copy frozen at migration time.
INSERT INTO "tender_opportunity_sources" ("tenant_id", "code", "label", "description", "sort_order")
SELECT t."id", v."code", v."label", v."description", v."sort_order"
  FROM "tenants" t
 CROSS JOIN (VALUES
	('oa_management_company', 'OA management company', 'The managing agent for an Owners Association, running the RERA-mandated three-bid process.', 10),
	('developer', 'Developer', 'A developer tendering maintenance for a building it still holds or has just handed over.', 20),
	('property_manager', 'Property manager', 'A landlord''s agent tendering for a single building or a small portfolio.', 30),
	('government_esupply', 'Government eSupply portal', 'A government or semi-government body''s electronic procurement portal. Deadlines are hard and the portal closes itself.', 40)
 ) AS v("code", "label", "description", "sort_order")
 ON CONFLICT DO NOTHING;--> statement-breakpoint

-- ── Why bids are won and lost ──────────────────────────────────────────────
--
-- Chosen so the actionable losses are distinguishable from the rest, which is
-- the only reason to hold this vocabulary. "Undercut on price" and "the pack
-- was incomplete" are both losses and only the second is a thing the company
-- can fix -- and it is precisely what CON-12 exists to eliminate, so it has to
-- be countable.
INSERT INTO "tender_outcome_reasons" ("tenant_id", "code", "label", "description", "applies_to", "sort_order")
SELECT t."id", v."code", v."label", v."description", v."applies_to", v."sort_order"
  FROM "tenants" t
 CROSS JOIN (VALUES
	('price', 'Price', 'Undercut, or priced above the budget the issuer had.', 'both', 10),
	('technical_score', 'Technical score', 'The method statement, plant list or PPM schedule scored above or below the others.', 'both', 20),
	('relationship', 'Existing relationship', 'The issuer already knew the company, or already knew somebody else.', 'both', 30),
	('incumbent_retained', 'Incumbent retained', 'The existing contractor kept the work. Common where the three-bid process is a formality.', 'lost', 40),
	('missing_accreditation', 'Missing accreditation', 'Disqualified for an accreditation the company does not hold or could not evidence. The one CON-12 is meant to make impossible.', 'lost', 50),
	('incomplete_pack', 'Incomplete submission', 'The pack was short of something the issuer asked for. Also the one CON-12 is meant to make impossible.', 'lost', 60),
	('late_submission', 'Submitted late', 'Missed the closing date. The failure the deadline queue exists to prevent.', 'lost', 70),
	('capacity', 'Capacity', 'The issuer judged the workforce too small for the portfolio, or the company withdrew for the same reason.', 'both', 80),
	('scope_changed', 'Scope withdrawn or changed', 'The issuer cancelled, re-tendered, or changed the scope beyond what was bid.', 'lost', 90),
	('other', 'Other', 'Anything the list does not cover. Write the reason in the note.', 'both', 100)
 ) AS v("code", "label", "description", "applies_to", "sort_order")
 ON CONFLICT DO NOTHING;
