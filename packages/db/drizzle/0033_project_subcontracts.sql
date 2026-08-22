-- The subcontractor engagement (`PRJ-9`), split out of 0029 by a dependency.
--
-- ── WHY THIS IS A SEPARATE FILE ─────────────────────────────────────────────
--
-- Everything here points at `subcontractors`, and that table is created by
-- HR-19 in migration 0032 -- after 0029, where the rest of the projects module
-- lives. Migrations are applied in filename order, so declaring these foreign
-- keys in 0029 would fail on any database built from scratch and succeed on
-- every developer machine that happened to have run 0032 already. That is the
-- worst shape a migration bug takes: green locally, red on the first clean
-- deploy.
--
-- The alternative -- creating a second `subcontractors` table here -- is the
-- one thing this module has been careful not to do. HR-19's own note says why:
-- two registers that disagreed about whether a trade licence was current would
-- be worse than one, and the way that happens is each module growing its own
-- copy of the organisation. So the module is split at the dependency instead.
--
-- ── WHAT PRJ-9 ASKS FOR, AND WHICH HALF IS HERE ────────────────────────────
--
-- "A subcontractor is an organisation with a licence, insurance, accreditations
-- and expiry dates" -- that is 0032's table, and it is watched by the same
-- compliance sweep that watches employee documents, because a subcontractor's
-- worker on our site with an expired permit is our exposure under Article 60
-- whoever pays them.
--
-- "engaged against a project scope with its own payment terms" -- that is this
-- file.

-- ── PRJ-9: the engagement, not the register ─────────────────────────────────
--
-- client_approval_state lives on the engagement and not on the subcontractor
-- because the approval is per engagement: Dubai Law No. 7 of 2025 requires the
-- employer's prior approval before subcontracting within the contracting
-- sector, and an approval given for one project says nothing about the next.
-- It defaults to 'pending' and never to 'not_required' -- a field that defaults
-- to "not required" is a field that is always "not required".
CREATE TABLE "project_subcontracts" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"subcontractor_id" uuid NOT NULL,
	"phase_id" uuid,
	"scope" text NOT NULL,
	-- Committed cost. It counts against the margin from the day it is signed,
	-- not from the day the first invoice arrives.
	"value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"payment_terms_days" smallint DEFAULT 30 NOT NULL,
	"retention_basis_points" integer DEFAULT 0 NOT NULL,
	"client_approval_state" varchar(16) DEFAULT 'pending' NOT NULL,
	"client_approved_on" date,
	"client_approval_reference" varchar(64),
	"starts_on" date,
	"ends_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "project_subcontracts_approval" CHECK ("client_approval_state" IN ('not_required', 'pending', 'approved', 'refused')),
	CONSTRAINT "project_subcontracts_value" CHECK ("value" >= 0),
	CONSTRAINT "project_subcontracts_retention" CHECK ("retention_basis_points" BETWEEN 0 AND 1000)
);
--> statement-breakpoint

ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_subcontractor_id_subcontractors_id_fk" FOREIGN KEY ("subcontractor_id") REFERENCES "public"."subcontractors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_subcontracts" ADD CONSTRAINT "project_subcontracts_phase_id_project_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."project_phases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "project_subcontracts_key" ON "project_subcontracts" USING btree ("tenant_id","project_id","subcontractor_id","scope");--> statement-breakpoint
CREATE INDEX "project_subcontracts_project_idx" ON "project_subcontracts" USING btree ("tenant_id","project_id");--> statement-breakpoint
CREATE INDEX "project_subcontracts_sub_idx" ON "project_subcontracts" USING btree ("tenant_id","subcontractor_id");--> statement-breakpoint

-- ── The two soft references from 0029, now that the register exists ────────
--
-- The columns were created in 0029; only the constraints wait for this file.
-- ON DELETE SET NULL on both: retiring a subcontractor must not delete the
-- snags raised against them or the costs booked to them. What they did happened.
ALTER TABLE "project_snags" ADD CONSTRAINT "project_snags_subcontractor_id_subcontractors_id_fk" FOREIGN KEY ("subcontractor_id") REFERENCES "public"."subcontractors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_costs" ADD CONSTRAINT "project_costs_subcontractor_id_subcontractors_id_fk" FOREIGN KEY ("subcontractor_id") REFERENCES "public"."subcontractors"("id") ON DELETE set null ON UPDATE no action;
