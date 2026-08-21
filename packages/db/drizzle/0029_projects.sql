-- Projects: fit-out, installation and renovation work (`PRJ-1`...`PRJ-9`).
--
-- ── WHY THIS MODULE EXISTS AT ALL ───────────────────────────────────────────
--
-- A job is one visit with one invoice at the end of it. A fit-out is eight
-- weeks, five trades, four staged payments and a snag list, and the half that
-- breaks first is the money: the invoicing model is one job, one invoice, and a
-- 30% mobilisation payment has no completed job behind it and never will. The
-- requirement's own words are that milestone billing is "the mechanism the
-- current invoicing model cannot express". That is PRJ-3, and it is the reason
-- these tables exist rather than a flag on jobs.
--
-- ── THE THREE NUMBERS THAT DECIDE WHETHER A FIT-OUT MAKES MONEY ─────────────
--
-- Variations, retention and cost. All three are invisible in most contractors'
-- systems and all three run in the same direction -- they make the job look
-- more profitable than it is:
--
--   * Unrecorded variations are work done and never billed. The standard way a
--     fit-out contractor loses money is not a bad price; it is forty small
--     changes nobody wrote down.
--   * Retention is 5-10% of every invoice the client keeps. It is earned
--     revenue in somebody else's bank account, released only if asked for.
--   * Cost is the one nothing else in this schema records at all -- see the
--     note on labour_cost_rates below.
--
-- ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
--
-- No subcontractors table, and no reference to one. HR-19 builds that register
-- in migration 0032, which runs AFTER this file -- so the three things here
-- that point at it (the project_subcontracts engagement table and the
-- subcontractor_id columns on project_snags and project_costs) cannot have
-- their foreign keys declared here. The columns are created below; the table
-- and the constraints are 0033_project_subcontracts.sql, which is this same
-- module's work split at the dependency rather than duplicated across it.
--
-- HR-19 already built that register, with the trade licence, the liability and
-- workmen's-compensation policies, their expiries and the Dubai Law No. 7 of
-- 2025 approval reference, watched by the
-- same compliance sweep that watches employee documents. PRJ-9 asks for that
-- organisation engaged against a project scope; the engagement points at that
-- register rather than copying it. Two registers that disagreed about whether a
-- licence was current would be worse than one.
--
-- No phase_id column on jobs. A job raised for a phase is an ordinary job to
-- the dispatch board, the SLA clock, the job card and the portal, and none of
-- them should have to learn about projects to keep working. The link is
-- project_phase_jobs, and its unique index on job_id is what stops a phase's
-- job count fanning out.
--
-- ── DAY-VALUED COLUMNS ARE date, NOT timestamptz ────────────────────────────
--
-- Start dates, target completion, practical completion, the end of the defects
-- liability period, permit expiries, snag target dates and retention due dates
-- are all days. Migration 0021 made this correction on assets.warranty_expiry
-- and the reasoning applies unchanged: a day stored as an instant is read back
-- through whatever offset the reader is in, and the error runs in the expensive
-- direction. A permit that expired yesterday reads as valid for four more
-- hours, in front of an inspector, on a site the permit was the authority for.
--
-- ── MONEY ───────────────────────────────────────────────────────────────────
--
-- numeric(14,2) at rest and integer minor units in code, exactly as invoices
-- and contracts are (INV-8). Percentages are basis points, following
-- contract_terms.discount_rate_basis_points: 500 = 5%.

-- ── PRJ-1: the container ────────────────────────────────────────────────────
CREATE TABLE "projects" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	-- Nullable, and a real state. A tender is priced before the unit is
	-- identified -- "one of the retail units on the ground floor" -- and
	-- refusing the record until the address settles keeps the pipeline in a
	-- spreadsheet until award.
	"property_id" uuid,
	"name" varchar(200) NOT NULL,
	"scope" text,
	-- The AWARDED value. It never moves. Variations are rows in
	-- project_variations, because the difference between what was awarded and
	-- what the job is now worth is the number PRJ-4 exists to keep visible, and
	-- folding it into this column destroys it.
	"contract_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"status" varchar(24) DEFAULT 'quoted' NOT NULL,
	"starts_on" date,
	"target_completion_on" date,
	-- Written by the transition into practical_completion and by nothing else,
	-- so it cannot disagree with the status. The retention and defects-liability
	-- clocks are both measured from it.
	"practical_completion_on" date,
	"defects_liability_days" smallint DEFAULT 365 NOT NULL,
	"defects_liability_ends_on" date,
	"retention_basis_points" integer DEFAULT 500 NOT NULL,
	"project_manager_id" uuid,
	"notes" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	-- The status machine, at the database. The graph is enforced in the domain
	-- layer; this is the floor under it, so a direct SQL fix during an incident
	-- cannot leave a project in a status no screen can render.
	CONSTRAINT "projects_status" CHECK ("status" IN (
		'quoted', 'awarded', 'mobilising', 'on_site', 'snagging',
		'practical_completion', 'defects_liability', 'closed', 'cancelled'
	)),
	-- 10% is the top of what this market uses. A number above it is a
	-- percentage typed where basis points were meant, and it would withhold a
	-- hundred times too much from every invoice on the project.
	CONSTRAINT "projects_retention_range" CHECK (
		"retention_basis_points" BETWEEN 0 AND 1000
	),
	CONSTRAINT "projects_defects_period" CHECK ("defects_liability_days" >= 0),
	CONSTRAINT "projects_dates" CHECK (
		"starts_on" IS NULL OR "target_completion_on" IS NULL
		OR "target_completion_on" >= "starts_on"
	)
);
--> statement-breakpoint

ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_project_manager_id_users_id_fk" FOREIGN KEY ("project_manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "projects_tenant_reference_key" ON "projects" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "projects_tenant_status_idx" ON "projects" USING btree ("tenant_id","status","target_completion_on");--> statement-breakpoint
CREATE INDEX "projects_customer_idx" ON "projects" USING btree ("tenant_id","customer_id");--> statement-breakpoint

-- ── PRJ-2: phases ───────────────────────────────────────────────────────────
CREATE TABLE "project_phases" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" smallint DEFAULT 1 NOT NULL,
	"name" varchar(160) NOT NULL,
	"service_slug" varchar(64),
	"planned_start_on" date,
	"planned_end_on" date,
	"actual_start_on" date,
	"actual_end_on" date,
	-- ON DELETE SET NULL, not cascade. Deleting "first fix" must not silently
	-- delete "second fix" along with every job and cost booked against it.
	"depends_on_phase_id" uuid,
	-- Basis points of the whole project, so the live phases are meant to total
	-- 10,000. Weighted rather than counted because phases are not the same size:
	-- first fix is six weeks and handover cleaning is a day, and "four of eight
	-- phases done, so 50%" is a schedule about to be a surprise. The shortfall
	-- is reported on screen rather than refused here -- a plan is incomplete for
	-- as long as somebody is typing it.
	"weight_basis_points" integer DEFAULT 0 NOT NULL,
	"percent_complete" smallint DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'planned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_phases_status" CHECK ("status" IN ('planned', 'in_progress', 'complete', 'cancelled')),
	CONSTRAINT "project_phases_weight" CHECK ("weight_basis_points" BETWEEN 0 AND 10000),
	CONSTRAINT "project_phases_percent" CHECK ("percent_complete" BETWEEN 0 AND 100),
	CONSTRAINT "project_phases_dates" CHECK (
		"planned_start_on" IS NULL OR "planned_end_on" IS NULL
		OR "planned_end_on" >= "planned_start_on"
	),
	-- A phase cannot depend on itself. The longer cycles this does not catch are
	-- refused in the domain layer; this one is the typo, and it is the one that
	-- makes a dependency chase loop forever.
	CONSTRAINT "project_phases_no_self_dependency" CHECK ("depends_on_phase_id" <> "id")
);
--> statement-breakpoint

ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phases" ADD CONSTRAINT "project_phases_depends_on_phase_id_project_phases_id_fk" FOREIGN KEY ("depends_on_phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_phases_sequence_key" ON "project_phases" USING btree ("tenant_id","project_id","sequence");--> statement-breakpoint
CREATE INDEX "project_phases_project_idx" ON "project_phases" USING btree ("tenant_id","project_id");--> statement-breakpoint

-- ── PRJ-2: "phases produce Jobs for daily execution" ────────────────────────
--
-- A link table, not a column on jobs. schema/operations.ts is the dispatch
-- board's table and a job raised for a phase is an ordinary job to every reader
-- of it; adding a column there would mean this module could break dispatch.
--
-- The unique index on job_id is what makes this a link rather than a fan-out:
-- one job belongs to at most one phase, so summing a phase's jobs cannot
-- double-count. That is the same bug the dispatch board had with multi-visit
-- jobs, and it is cheaper to make impossible than to find.
CREATE TABLE "project_phase_jobs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "project_phase_jobs" ADD CONSTRAINT "project_phase_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phase_jobs" ADD CONSTRAINT "project_phase_jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phase_jobs" ADD CONSTRAINT "project_phase_jobs_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_phase_jobs" ADD CONSTRAINT "project_phase_jobs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_phase_jobs_job_key" ON "project_phase_jobs" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "project_phase_jobs_phase_idx" ON "project_phase_jobs" USING btree ("tenant_id","phase_id");--> statement-breakpoint
CREATE INDEX "project_phase_jobs_project_idx" ON "project_phase_jobs" USING btree ("tenant_id","project_id");--> statement-breakpoint

-- ── PRJ-3: milestone billing ────────────────────────────────────────────────
--
-- invoice_id is the idempotency guarantee, not a convenience. "A reached
-- milestone raises an invoice" is a sentence somebody will click twice, and the
-- second click has to be a no-op rather than a second tax invoice with a
-- sequential number on it: an invoice raised in error cannot be deleted, only
-- credited, and a credit note is a document the customer has to reconcile.
CREATE TABLE "project_milestones" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	-- Optional. A mobilisation payment belongs to the project, not to a phase.
	"phase_id" uuid,
	"sequence" smallint DEFAULT 1 NOT NULL,
	"name" varchar(160) NOT NULL,
	-- Tax-exclusive. VAT is applied when the invoice is raised, after discount.
	"value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"trigger_kind" varchar(24) DEFAULT 'client_sign_off' NOT NULL,
	"trigger_on" date,
	"trigger_percent" smallint,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reached_at" timestamp with time zone,
	"reached_by_id" uuid,
	-- How the trigger was satisfied. The only evidence there is for the
	-- client_sign_off case, which no query can decide.
	"reached_note" text,
	"invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_milestones_trigger_kind" CHECK ("trigger_kind" IN ('date', 'percent_complete', 'client_sign_off')),
	CONSTRAINT "project_milestones_status" CHECK ("status" IN ('pending', 'reached', 'invoiced', 'cancelled')),
	CONSTRAINT "project_milestones_percent" CHECK (
		"trigger_percent" IS NULL OR "trigger_percent" BETWEEN 1 AND 100
	),
	-- Each trigger needs the field it is evaluated against. Without it the
	-- milestone can only ever be reached by somebody overriding it, which is a
	-- silent downgrade of a dated milestone into a discretionary one.
	CONSTRAINT "project_milestones_trigger_field" CHECK (
		("trigger_kind" = 'date' AND "trigger_on" IS NOT NULL)
		OR ("trigger_kind" = 'percent_complete' AND "trigger_percent" IS NOT NULL)
		OR "trigger_kind" = 'client_sign_off'
	),
	-- A milestone marked invoiced with no invoice behind it is a payment
	-- everybody believes was raised and nobody sent.
	CONSTRAINT "project_milestones_invoiced_has_invoice" CHECK (
		"status" <> 'invoiced' OR "invoice_id" IS NOT NULL
	)
);
--> statement-breakpoint

ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_reached_by_id_users_id_fk" FOREIGN KEY ("reached_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_milestones_sequence_key" ON "project_milestones" USING btree ("tenant_id","project_id","sequence");--> statement-breakpoint
CREATE INDEX "project_milestones_project_idx" ON "project_milestones" USING btree ("tenant_id","project_id","status");--> statement-breakpoint

-- ── PRJ-4: variation orders ─────────────────────────────────────────────────
--
-- The value is SIGNED. An omission is a negative variation and is every bit as
-- real as an addition; handling omissions by editing the contract value instead
-- would lose the record of what changed, which is the first thing a final
-- account argument asks for.
CREATE TABLE "project_variations" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"approval_state" varchar(16) DEFAULT 'draft' NOT NULL,
	-- Who instructed it on site, in their words. The audit trail of a verbal
	-- instruction, which is how most variations actually start.
	"instructed_by" varchar(160),
	"instructed_on" date,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_id" uuid,
	-- The client's own approval reference. It is what gets the variation paid.
	"client_reference" varchar(64),
	"decision_reason" text,
	-- A variation costs time as well as money, and the time is what turns into a
	-- delay claim against us if nobody recorded that we asked for it.
	"programme_impact_days" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_variations_state" CHECK ("approval_state" IN ('draft', 'submitted', 'approved', 'rejected', 'withdrawn')),
	-- A variation with no value is a note. Recording it as a variation makes the
	-- unapproved total look busier than it is and hides the ones that matter.
	CONSTRAINT "project_variations_nonzero" CHECK ("value" <> 0)
);
--> statement-breakpoint

ALTER TABLE "project_variations" ADD CONSTRAINT "project_variations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variations" ADD CONSTRAINT "project_variations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_variations" ADD CONSTRAINT "project_variations_decided_by_id_users_id_fk" FOREIGN KEY ("decided_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_variations_reference_key" ON "project_variations" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "project_variations_project_idx" ON "project_variations" USING btree ("tenant_id","project_id","approval_state");--> statement-breakpoint

-- ── PRJ-5: retention ────────────────────────────────────────────────────────
--
-- TWO ROWS PER INVOICE, one per release stage, rather than one row with two
-- dates. The requirement asks for "its own due-date tracking and reminders",
-- and a stage is the unit that falls due: the first half is released on
-- practical completion, the second twelve months later, and they are chased,
-- released and written off independently. One row with two nullable date pairs
-- would make "what retention is overdue" a query with a CASE in it, and every
-- reminder would have to re-derive which half it was talking about.
--
-- due_on is nullable until practical completion is recorded, because until then
-- the date genuinely is not knowable -- it is derived from a completion that
-- has not happened. A row with a null due date is retention held; a row with a
-- due date in the past is retention somebody should be chasing today.
--
-- The amount is withheld from the TAX-EXCLUSIVE value. Retention is a deduction
-- from the consideration, not from the VAT: the VAT was accounted for on the
-- full value at the tax point and is owed to the FTA whether or not the client
-- has paid it. Withholding a share of the gross would under-declare output tax,
-- which is the expensive direction of this error.
CREATE TABLE "project_retention" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	-- ON DELETE RESTRICT. Retention is a claim on a specific document, and
	-- losing the link would leave a balance nobody can evidence.
	"invoice_id" uuid NOT NULL,
	"milestone_id" uuid,
	"stage" varchar(24) NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"basis_points" integer DEFAULT 500 NOT NULL,
	"status" varchar(16) DEFAULT 'held' NOT NULL,
	"due_on" date,
	"released_on" date,
	"release_invoice_id" uuid,
	"last_reminded_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_retention_stage_values" CHECK ("stage" IN ('practical_completion', 'defects_liability')),
	CONSTRAINT "project_retention_status" CHECK ("status" IN ('held', 'due', 'released', 'written_off')),
	CONSTRAINT "project_retention_basis_range" CHECK ("basis_points" BETWEEN 0 AND 1000),
	-- Released with no date is money the ledger says came back on no particular
	-- day, which is the state a reconciliation cannot resolve.
	CONSTRAINT "project_retention_released_has_date" CHECK (
		"status" <> 'released' OR "released_on" IS NOT NULL
	)
);
--> statement-breakpoint

ALTER TABLE "project_retention" ADD CONSTRAINT "project_retention_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_retention" ADD CONSTRAINT "project_retention_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_retention" ADD CONSTRAINT "project_retention_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_retention" ADD CONSTRAINT "project_retention_milestone_id_project_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."project_milestones"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_retention" ADD CONSTRAINT "project_retention_release_invoice_id_invoices_id_fk" FOREIGN KEY ("release_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- One row per invoice per stage. This is what makes withholding idempotent:
-- a retried milestone invoice cannot withhold the same money twice, and two
-- claims on one invoice is a balance nobody can reconcile against it.
CREATE UNIQUE INDEX "project_retention_stage_key" ON "project_retention" USING btree ("tenant_id","invoice_id","stage");--> statement-breakpoint
CREATE INDEX "project_retention_project_idx" ON "project_retention" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
-- The chase list: what is due, oldest first.
CREATE INDEX "project_retention_due_idx" ON "project_retention" USING btree ("tenant_id","status","due_on");--> statement-breakpoint

-- ── PRJ-6: the permit register ──────────────────────────────────────────────
--
-- The authority is a controlled vocabulary for the same reason asset_categories
-- and job_outcome_codes are: "DM", "Dubai Municipality" and "Dubai Muncipality"
-- are three answers to a question that has one, and the question -- which
-- authority is holding this project up -- is asked across rows and across
-- projects. It cannot be retrofitted: by the time anybody asks, the history is
-- already written.
CREATE TABLE "permit_authorities" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	"sort_order" integer DEFAULT 100 NOT NULL,
	-- Retirement, not deletion. An authority named on an issued permit cannot be
	-- removed without rewriting the register.
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "permit_authorities" ADD CONSTRAINT "permit_authorities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "permit_authorities_code_key" ON "permit_authorities" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "permit_authorities_pick_idx" ON "permit_authorities" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint

CREATE TABLE "project_permits" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"authority_id" uuid NOT NULL,
	"permit_type" varchar(120) NOT NULL,
	"reference_number" varchar(80),
	"status" varchar(16) DEFAULT 'not_applied' NOT NULL,
	-- Defaults true. The failure mode of the alternative is one-sided: a permit
	-- entered and not flagged is a permit that stops blocking, and the reason to
	-- enter it was that it blocks.
	"is_required" boolean DEFAULT true NOT NULL,
	"applied_on" date,
	"approved_on" date,
	-- date, not timestamptz. This is the exact column where an offset shift
	-- reports an expired permit as still valid.
	"expires_on" date,
	"fee_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"document_storage_key" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_permits_status" CHECK ("status" IN ('not_applied', 'applied', 'approved', 'rejected', 'expired')),
	CONSTRAINT "project_permits_approved_has_date" CHECK (
		"status" <> 'approved' OR "approved_on" IS NOT NULL
	)
);
--> statement-breakpoint

ALTER TABLE "project_permits" ADD CONSTRAINT "project_permits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_permits" ADD CONSTRAINT "project_permits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_permits" ADD CONSTRAINT "project_permits_authority_id_permit_authorities_id_fk" FOREIGN KEY ("authority_id") REFERENCES "public"."permit_authorities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "project_permits_project_idx" ON "project_permits" USING btree ("tenant_id","project_id","status");--> statement-breakpoint
CREATE INDEX "project_permits_expiry_idx" ON "project_permits" USING btree ("tenant_id","expires_on");--> statement-breakpoint

-- ── PRJ-7: the snag list ────────────────────────────────────────────────────
CREATE TABLE "snag_trades" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	-- Matches a catalogue service slug where the trade is one we sell, so that
	-- "who has the most open snags" and "who do we send" are the same answer.
	"service_slug" varchar(64),
	"sort_order" integer DEFAULT 100 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "snag_trades" ADD CONSTRAINT "snag_trades_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "snag_trades_code_key" ON "snag_trades" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "snag_trades_pick_idx" ON "snag_trades" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint

-- severity is load-bearing rather than descriptive: 'critical' is what stops
-- practical completion being recorded, and nothing else does. The line is drawn
-- at critical and not at "any open snag" deliberately -- practical completion
-- has never meant an empty snag list, and a rule demanding one gets worked
-- around within a week by downgrading everything to minor, which destroys the
-- only field that made the list worth keeping.
CREATE TABLE "project_snags" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"phase_id" uuid,
	-- Sequential within the project. "Snag 47" is how it is referred to on site.
	"sequence" integer DEFAULT 1 NOT NULL,
	"location_text" varchar(200) NOT NULL,
	"trade_id" uuid NOT NULL,
	"severity" varchar(16) DEFAULT 'minor' NOT NULL,
	"description" text NOT NULL,
	"responsible_party" varchar(16) DEFAULT 'us' NOT NULL,
	-- Its foreign key is added in 0033, once HR-19's register exists. See the
	-- note at the head of this file.
	"subcontractor_id" uuid,
	"target_on" date,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"photo_storage_key" text,
	"closure_photo_storage_key" text,
	"closure_note" text,
	"raised_by_id" uuid,
	"raised_by" varchar(160),
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_snags_severity" CHECK ("severity" IN ('critical', 'major', 'minor')),
	CONSTRAINT "project_snags_status" CHECK ("status" IN ('open', 'in_progress', 'closed', 'rejected')),
	CONSTRAINT "project_snags_party" CHECK ("responsible_party" IN ('us', 'subcontractor', 'client', 'consultant', 'supplier')),
	-- A snag closed with nothing behind it is one that gets raised again at
	-- handover by somebody standing in front of it. The note is required; the
	-- photograph is not, because some snags -- a missing certificate, a wrong
	-- door number -- genuinely have nothing to photograph, and a gate with no
	-- legitimate way past it is a gate somebody widens permanently.
	CONSTRAINT "project_snags_closed_has_evidence" CHECK (
		"status" NOT IN ('closed', 'rejected') OR "closure_note" IS NOT NULL
	)
);
--> statement-breakpoint

ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_trade_id_snag_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."snag_trades"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_raised_by_id_users_id_fk" FOREIGN KEY ("raised_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_snags_sequence_key" ON "project_snags" USING btree ("tenant_id","project_id","sequence");--> statement-breakpoint
-- The completion gate reads exactly this: open criticals for one project.
CREATE INDEX "project_snags_gate_idx" ON "project_snags" USING btree ("tenant_id","project_id","status","severity");--> statement-breakpoint
CREATE INDEX "project_snags_target_idx" ON "project_snags" USING btree ("tenant_id","status","target_on");--> statement-breakpoint

-- ── PRJ-8: cost tracking ────────────────────────────────────────────────────
--
-- ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
--
-- Until this migration there was NO COST CONCEPT ANYWHERE in this schema. Every
-- table recorded a price -- what the customer pays -- and nothing recorded a
-- cost. That absence is why the AMC renewal screen says in as many words that
-- the system records price and not cost, and that a renewal margin would
-- therefore be estimated rather than measured. These two tables are the first
-- rows of the other half.
--
-- Rates are versioned by effective_from rather than edited in place, because a
-- cost recorded last March must keep the rate that applied last March. A table
-- edited in place silently rewrites the margin on every closed project the next
-- time somebody gives the electricians a rise.
CREATE TABLE "labour_cost_rates" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(32) NOT NULL,
	"label" varchar(120) NOT NULL,
	-- FULLY LOADED cost per hour: wage, accommodation, transport, visa
	-- amortisation, insurance. Not the wage. A margin computed against basic pay
	-- alone is roughly a third too optimistic in this market, which is worse
	-- than no margin at all because it is believed.
	"hourly_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "labour_cost_rates_cost" CHECK ("hourly_cost" >= 0),
	CONSTRAINT "labour_cost_rates_window" CHECK (
		"effective_to" IS NULL OR "effective_to" >= "effective_from"
	)
);
--> statement-breakpoint

ALTER TABLE "labour_cost_rates" ADD CONSTRAINT "labour_cost_rates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "labour_cost_rates_key" ON "labour_cost_rates" USING btree ("tenant_id","code","effective_from");--> statement-breakpoint
CREATE INDEX "labour_cost_rates_pick_idx" ON "labour_cost_rates" USING btree ("tenant_id","is_active","code");--> statement-breakpoint

-- One row per cost event, never a running total on projects. A stored total has
-- to be maintained by every path that books a cost, and the path somebody
-- forgets is the one that makes the margin wrong in the direction nobody
-- checks.
--
-- is_committed separates money spent from money promised. A subcontract signed
-- for AED 180,000 is gone whether or not the invoice has arrived, and a margin
-- that improves every time a supplier is slow to invoice reports the opposite
-- of the truth. Both count against the margin; they are reported separately so
-- the cash position is still readable.
--
-- job_id is the hook the rest of the system will eventually hang off: a phase
-- produces jobs, labour is worked on jobs, and a cost booked to a job is a cost
-- that can also be summed per contract. Nothing outside the projects module
-- reads it yet -- that is CON-8's work, not this migration's.
CREATE TABLE "project_costs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"phase_id" uuid,
	"job_id" uuid,
	-- Foreign key added in 0033, as above.
	"subcontractor_id" uuid,
	"category" varchar(16) NOT NULL,
	"description" varchar(240) NOT NULL,
	"incurred_on" date NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" varchar(24) DEFAULT 'ea' NOT NULL,
	-- The rate as it was on the day. Captured, never re-derived: a historical
	-- cost that re-derives its rate on every read is a historical cost that
	-- changes, and a closed project's margin must not move.
	"unit_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"is_committed" boolean DEFAULT false NOT NULL,
	"supplier_reference" varchar(64),
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_costs_category" CHECK ("category" IN ('labour', 'materials', 'subcontractor', 'plant_hire', 'other'))
);
--> statement-breakpoint

ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "project_costs_project_idx" ON "project_costs" USING btree ("tenant_id","project_id","category");--> statement-breakpoint
CREATE INDEX "project_costs_incurred_idx" ON "project_costs" USING btree ("tenant_id","incurred_on");--> statement-breakpoint
CREATE INDEX "project_costs_job_idx" ON "project_costs" USING btree ("tenant_id","job_id");--> statement-breakpoint

-- ── The vocabularies, seeded for every tenant that already exists ───────────
--
-- Seeded here as well as in seed.ts because a vocabulary table that ships empty
-- leaves the operator an empty picker on the day this migration lands, and an
-- empty picker is free text with extra steps -- which is the exact failure the
-- table exists to prevent, and it cannot be retrofitted once the history is
-- written. This repo has had that bug before.
--
-- A tenant created after this migration gets them from
-- STANDARD_PERMIT_AUTHORITIES and STANDARD_SNAG_TRADES in
-- packages/core/src/project.ts, which is the authority from here on; these
-- lists are a copy of those frozen at migration time.
--
-- ON CONFLICT DO NOTHING so re-running is a no-op and an operator's edit to a
-- label survives it.
INSERT INTO "permit_authorities" ("tenant_id", "code", "label", "description", "sort_order")
SELECT t."id", v."code", v."label", v."description", v."sort_order"
  FROM "tenants" t
 CROSS JOIN (VALUES
	('dm', 'Dubai Municipality', 'Building completion, fit-out and modification permits for most of Dubai outside the free zones.', 10),
	('dda', 'Dubai Development Authority (DDA)', 'The authority for TECOM, Media City, Internet City, Studio City and Dubai Design District.', 20),
	('trakhees', 'Trakhees (Ports, Customs and Free Zone Corporation)', 'Palm Jumeirah, Dubai World Central, Jebel Ali and the other PCFC jurisdictions.', 30),
	('dewa', 'Dubai Electricity and Water Authority (DEWA)', 'Electrical connection, meter, and any work on the incoming supply. NOC before energisation.', 40),
	('dcd', 'Dubai Civil Defence', 'Fire and life safety approval -- detection, suppression, escape routes. The approval most often on the critical path.', 50),
	('building_management', 'Building management / owners association', 'Not a government authority, but the fit-out NOC, working-hours consent and lift booking that gate site access.', 60)
 ) AS v("code", "label", "description", "sort_order")
 ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO "snag_trades" ("tenant_id", "code", "label", "service_slug", "sort_order")
SELECT t."id", v."code", v."label", v."service_slug", v."sort_order"
  FROM "tenants" t
 CROSS JOIN (VALUES
	('electrical', 'Electrical', 'electrical-fittings-repair', 10),
	('plumbing', 'Plumbing and drainage', 'plumbing-sanitary', 20),
	('hvac', 'HVAC', 'hvac-installation-maintenance', 30),
	('joinery', 'Joinery and carpentry', 'carpentry', 40),
	('painting', 'Painting and decoration', 'painting', 50),
	('flooring', 'Flooring', 'tiling', 60),
	('ceiling', 'Ceilings and partitions', 'false-ceilings', 70),
	('glazing', 'Glazing and aluminium', NULL, 80),
	('fire_safety', 'Fire and life safety', NULL, 90),
	('cleaning', 'Cleaning and making good', 'building-cleaning', 100)
 ) AS v("code", "label", "service_slug", "sort_order")
 ON CONFLICT DO NOTHING;
