-- Phase 1 — workforce compliance, and the columns the hard block needs.
--
--   HR-5    employee_documents. Passport, residence visa, Emirates ID, MOHRE
--           work permit, medical fitness, health insurance — each with an
--           expiry and a `blocking` flag.
--   HR-9    The hard block itself is a query over that table. Deploying a
--           worker without a valid permit carries AED 100,000 to AED 1,000,000
--           since the 2024 amendment to Article 60, multiplied by headcount in
--           fictitious-employment cases. This is the requirement that most
--           justifies building the system at all.
--   HR-14   company_accreditations. The trade licence and its 23 Jan 2027
--           expiry currently have nothing watching them.
--   JOB-10  Assignment overrides become recorded decisions. The audit found
--           they were silent, and a silent override is indistinguishable from
--           a mistake.
--   DB-6    jobs.is_outdoor, which is what makes the summer midday ban
--           enforceable per job rather than per service.

-- ── Employees ───────────────────────────────────────────────────────────────
-- Extends `technicians` rather than replacing it: a technician may exist
-- without an employee record, because subcontracted and manpower-supplied
-- labour is real and the system has to be able to represent it. The employment
-- record is the part that carries statutory obligations.
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid,
	"employee_no" varchar(32),
	"full_name" varchar(160) NOT NULL,
	"contract_type" varchar(24) DEFAULT 'fixed_term' NOT NULL,
	"contract_start" date,
	"contract_end" date,
	"probation_end" date,
	"notice_period_days" integer DEFAULT 30 NOT NULL,
	-- Basic salary only, in fils. Gratuity accrues on basic and excludes
	-- housing, transport, utilities and furniture allowances (HR-13), so the
	-- two are stored apart rather than as one "salary" that would quietly
	-- inflate every end-of-service calculation.
	"basic_salary_minor" bigint,
	"allowances" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mohre_person_code" varchar(32),
	"wps_iban" varchar(34),
	"status" varchar(24) DEFAULT 'active' NOT NULL,
	"terminated_at" timestamp with time zone,
	-- HR-15: employee records are retained at least 2 years after termination
	-- (Labour Law Art. 13), payroll and tax records 7 years (INV-15). The purge
	-- job reads this column; retention as a job, not a policy document.
	"delete_after" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

-- ── Employee documents ──────────────────────────────────────────────────────
CREATE TABLE "employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	-- passport | residence_visa | emirates_id | work_permit | medical_fitness
	-- | health_insurance | driving_licence | other
	"kind" varchar(32) NOT NULL,
	"reference_no" varchar(64),
	"issued_at" date,
	"expires_at" date,
	"storage_key" text,
	-- THE column that makes HR-9 enforceable in one query rather than as a
	-- special case per document type. `true` means an expiry hard-blocks
	-- dispatch. Defaulting to false is deliberate: a new document type is a
	-- warning until somebody decides it is a wall, and that decision needs the
	-- statutory penalty named (see the design document's hard-block rule).
	"blocking" boolean DEFAULT false NOT NULL,
	"verified_by_id" uuid,
	"verified_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

-- ── Company accreditations ──────────────────────────────────────────────────
-- Distinct from individual certifications: these belong to the establishment.
-- trade_licence | dewa_enrolment | dm_classification | iso_cert |
-- liability_insurance | workmen_comp | worker_protection | other
CREATE TABLE "company_accreditations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"name" varchar(160) NOT NULL,
	"reference_no" varchar(64),
	"issuing_body" varchar(160),
	"grade" varchar(32),
	"issued_at" date,
	"expires_at" date,
	"storage_key" text,
	"renewal_owner_user_id" uuid,
	-- CON-12: the tender pack is assembled from this table so it is never
	-- stale. A certificate excluded here simply does not appear in the pack.
	"tender_pack_include" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_documents" ADD CONSTRAINT "employee_documents_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_accreditations" ADD CONSTRAINT "company_accreditations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_accreditations" ADD CONSTRAINT "company_accreditations_renewal_owner_user_id_users_id_fk" FOREIGN KEY ("renewal_owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── Indexes (DB-8) ──────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "employees_tenant_no_key" ON "employees" USING btree ("tenant_id","employee_no");--> statement-breakpoint
CREATE INDEX "employees_technician_idx" ON "employees" USING btree ("tenant_id","technician_id");--> statement-breakpoint
CREATE INDEX "employees_retention_idx" ON "employees" USING btree ("delete_after") WHERE "delete_after" IS NOT NULL;--> statement-breakpoint
-- The hard-block query: "which employees have an expired blocking document?"
-- Partial on `blocking` because that is the only subset it ever asks about.
CREATE INDEX "employee_documents_blocking_expiry_idx" ON "employee_documents" USING btree ("tenant_id","expires_at") WHERE "blocking" AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "employee_documents_employee_idx" ON "employee_documents" USING btree ("tenant_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employee_documents_kind_key" ON "employee_documents" USING btree ("employee_id","kind") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "company_accreditations_expiry_idx" ON "company_accreditations" USING btree ("tenant_id","expires_at");--> statement-breakpoint

-- ── DB-6: the outdoor flag ──────────────────────────────────────────────────
-- The summer midday ban applies to work in direct sun, not to a trade. Painting
-- a stairwell is indoors; painting an elevation is not. Without a per-job flag
-- the rule can only be applied per service, which would either block indoor
-- work needlessly or let outdoor work through — and the second one costs
-- AED 5,000 per worker.
ALTER TABLE "jobs" ADD COLUMN "is_outdoor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- JOB-13: controlled outcome codes. Nullable until the job ends.
ALTER TABLE "jobs" ADD COLUMN "outcome_code" varchar(32);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "project_id" uuid;--> statement-breakpoint

-- Dispatch board's primary ordering, per TRD §4.4.
CREATE INDEX "jobs_sla_response_idx" ON "jobs" USING btree ("tenant_id","status","respond_by_at");--> statement-breakpoint

-- ── DB-7 / JOB-10: overrides become decisions ───────────────────────────────
-- A dispatcher who overrides a warning is making a judgement call, and those
-- are legitimate — a technician twelve minutes away with a certificate expiring
-- in twelve days is often the right answer. What is not legitimate is doing it
-- invisibly, because then it cannot be reviewed, counted, or distinguished
-- from someone who did not read the warning.
ALTER TABLE "job_visits" ADD COLUMN "override_warning_type" varchar(48);--> statement-breakpoint
ALTER TABLE "job_visits" ADD COLUMN "override_reason" text;
--> statement-breakpoint

-- ── ADM-1: the `hr` role ────────────────────────────────────────────────────
-- §5.2 adds a seventh staff persona. The rule the PRD sets alongside it is the
-- part worth keeping: every role must have at least one screen it alone can
-- reach, and any role that fails that test at implementation time is deleted
-- from the enum in the same commit. `hr` earns its place with the recruitment
-- pipeline (M9) and the workforce compliance board (M10).
--
-- IF NOT EXISTS so re-running this file against an existing database is safe.
-- Note that a new enum value cannot be USED in the same transaction that adds
-- it; psql applies each statement autocommitted, so this is fine here and would
-- not be inside an explicit BEGIN.
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'hr';
