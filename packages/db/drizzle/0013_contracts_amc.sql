-- M3 — contracts and AMC (`CON-1`…`CON-10`).
--
-- `contracts`, `contract_properties` and `contract_visits` have existed since
-- 0000 and have never had a row in them. The TRD calls that "the largest single
-- gap between the schema and the product", and it is: an AMC is the business
-- model this company runs on, and until now the system could describe one but
-- could not operate one.
--
-- This migration adds the four things the existing tables cannot express, and
-- deliberately adds nothing else:
--
--   * `contract_terms`        — the operational half of the contract: coverage
--                               type, discount rate, PPM lead time and window.
--   * `contract_entitlements` — visits per service family per year, and the
--                               consumed counter `CON-5` decrements.
--   * `contract_exclusions`   — the machine-readable carve-outs `CON-6` matches.
--   * `contract_documents`    — `CON-10`, versioned rather than overwritten.
--   * `contract_renewal_notices` — which rung of the `CON-9` ladder was sent.
--
-- ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
--
-- No new columns on `contracts` or `contract_visits`. `contracts.exclusions`
-- and `contracts.covered_services` stay as the customer-facing JSONB lists they
-- are; the tables above are the operable form of the same facts, and the domain
-- layer writes both from one input so they cannot drift.
--
-- `contract_visits.due_on` remains the single target date. The *window*
-- `CON-3` requires is `due_on ± contract_terms.ppm_window_days`, computed
-- rather than stored, because two stored bounds and a stored midpoint are three
-- facts that can disagree and only one of them is ever edited.
--
-- ── TENANCY ─────────────────────────────────────────────────────────────────
--
-- Every table below carries `tenant_id`. The policy loop in `sql/rls.sql` keys
-- on the presence of that column, so re-running that file after this migration
-- gives all five tables `FORCE ROW LEVEL SECURITY` and the standard isolation
-- policy. No policy is hand-written here, and none should be.

CREATE TABLE IF NOT EXISTS "contract_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"coverage_type" varchar(24) DEFAULT 'comprehensive' NOT NULL,
	"payment_terms_days" smallint DEFAULT 30 NOT NULL,
	"discount_rate_basis_points" integer DEFAULT 1500 NOT NULL,
	"callouts_per_year" smallint,
	"ppm_lead_time_days" smallint DEFAULT 21 NOT NULL,
	"ppm_window_days" smallint DEFAULT 7 NOT NULL,
	"ppm_generated_through" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "contract_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"service_slug" varchar(64) NOT NULL,
	"label" varchar(120) NOT NULL,
	"visits_per_year" smallint DEFAULT 1 NOT NULL,
	"consumed_visits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "contract_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"code" varchar(64) NOT NULL,
	"label" varchar(160) NOT NULL,
	"description" text,
	"is_standard" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "contract_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"title" varchar(240) NOT NULL,
	"storage_key" text NOT NULL,
	"version" smallint DEFAULT 1 NOT NULL,
	"mime_type" varchar(80),
	"size_bytes" integer,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "contract_renewal_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"band" smallint NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- `ON DELETE cascade` from the contract in every case. None of these rows means
-- anything without the contract they belong to, and a consumed-visit counter
-- orphaned from its contract is worse than absent: it is a number that will
-- eventually be reported against something.

ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_contract_id_fk"
	FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade;--> statement-breakpoint

ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_contract_id_fk"
	FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade;--> statement-breakpoint

ALTER TABLE "contract_exclusions" ADD CONSTRAINT "contract_exclusions_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_exclusions" ADD CONSTRAINT "contract_exclusions_contract_id_fk"
	FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade;--> statement-breakpoint

ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_contract_id_fk"
	FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_uploaded_by_id_fk"
	FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null;--> statement-breakpoint

ALTER TABLE "contract_renewal_notices" ADD CONSTRAINT "contract_renewal_notices_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_renewal_notices" ADD CONSTRAINT "contract_renewal_notices_contract_id_fk"
	FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "contract_renewal_notices" ADD CONSTRAINT "contract_renewal_notices_recipient_user_id_fk"
	FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade;--> statement-breakpoint

-- ── Constraints ─────────────────────────────────────────────────────────────

-- `CON-1` names exactly two contract types and they differ in who carries parts
-- risk. A third value would be a third pricing model nobody has priced.
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_coverage_type_check"
	CHECK ("coverage_type" IN ('comprehensive', 'labour_only'));--> statement-breakpoint

-- A discount is a discount. 10000 basis points would price out-of-scope work at
-- zero, which is the exact outcome `CON-6` exists to prevent.
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_discount_range_check"
	CHECK ("discount_rate_basis_points" >= 0 AND "discount_rate_basis_points" < 10000);--> statement-breakpoint

-- Consumption never runs backwards, and a negative counter would read as
-- remaining entitlement the customer does not have.
--
-- Only `contract_entitlements` carries a counter. There is no
-- `consumed_callouts` column: a consumed callout is not an event, it is a
-- description of a job (`contract_id is not null and source <> 'contract_ppm'`)
-- and is derived at read time. See the comment on `callouts_per_year` in
-- src/schema/contracts.ts for why a stored copy of that number would drift.
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_consumed_check"
	CHECK ("consumed_visits" >= 0);--> statement-breakpoint
ALTER TABLE "contract_entitlements" ADD CONSTRAINT "contract_entitlements_visits_check"
	CHECK ("visits_per_year" > 0);--> statement-breakpoint

-- A lead time of zero would mean a planned visit becomes a job on the morning
-- it is due, with nobody assigned. The window has the same problem inverted: a
-- window of zero is a fixed date, which is what `CON-3` exists to replace.
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_lead_time_check"
	CHECK ("ppm_lead_time_days" > 0 AND "ppm_lead_time_days" <= 180);--> statement-breakpoint
ALTER TABLE "contract_terms" ADD CONSTRAINT "contract_terms_window_check"
	CHECK ("ppm_window_days" > 0 AND "ppm_window_days" <= 60);--> statement-breakpoint

-- The `CON-9` ladder, and only the `CON-9` ladder. A band nobody sends is a row
-- that makes the idempotency index stop meaning anything.
ALTER TABLE "contract_renewal_notices" ADD CONSTRAINT "contract_renewal_notices_band_check"
	CHECK ("band" IN (90, 60, 30, 7));--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────

-- The 1:1. Without it a second terms row would silently double every
-- entitlement query that joins through it.
CREATE UNIQUE INDEX IF NOT EXISTS "contract_terms_contract_key"
	ON "contract_terms" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_terms_tenant_idx"
	ON "contract_terms" USING btree ("tenant_id");--> statement-breakpoint

-- One entitlement per service per contract. This key is also what
-- `contract_visits.service_slug` links through, which is why that table needs
-- no entitlement_id column.
CREATE UNIQUE INDEX IF NOT EXISTS "contract_entitlements_key"
	ON "contract_entitlements" USING btree ("tenant_id","contract_id","service_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_entitlements_contract_idx"
	ON "contract_entitlements" USING btree ("tenant_id","contract_id");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "contract_exclusions_key"
	ON "contract_exclusions" USING btree ("tenant_id","contract_id","code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_exclusions_contract_idx"
	ON "contract_exclusions" USING btree ("tenant_id","contract_id");--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "contract_documents_version_key"
	ON "contract_documents" USING btree ("tenant_id","contract_id","kind","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_documents_contract_idx"
	ON "contract_documents" USING btree ("tenant_id","contract_id");--> statement-breakpoint

-- The idempotency guarantee behind `CON-9`. Schedulers double-fire; this index
-- is what makes the second fire a no-op instead of a second email.
CREATE UNIQUE INDEX IF NOT EXISTS "contract_renewal_notices_key"
	ON "contract_renewal_notices" USING btree ("tenant_id","contract_id","band","recipient_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_renewal_notices_contract_idx"
	ON "contract_renewal_notices" USING btree ("tenant_id","contract_id");--> statement-breakpoint

-- ── The PPM materialisation query's index ───────────────────────────────────
--
-- `/api/cron/contracts` asks, every run: which planned visits are inside their
-- lead time and have no job yet? That predicate is
-- `status = 'planned' AND job_id IS NULL AND due_on <= now() + lead`, and the
-- existing `contract_visits_due_idx (tenant_id, due_on, status)` cannot serve
-- it well — it has no way to skip the visits that already became jobs, which
-- after a few months of operation is nearly all of them.
--
-- Partial on `job_id IS NULL`, so the index holds only the rows the scheduler
-- can still act on and shrinks as the schedule is worked through.
CREATE INDEX IF NOT EXISTS "contract_visits_pending_idx"
	ON "contract_visits" USING btree ("tenant_id","due_on")
	WHERE "job_id" IS NULL AND "deleted_at" IS NULL;
