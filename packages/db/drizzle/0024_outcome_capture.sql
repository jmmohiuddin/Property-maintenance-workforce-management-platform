-- Outcome and fault capture (JOB-13, JOB-14).
--
-- 0012 built the vocabularies: job_outcome_codes seeded with the seven
-- outcomes JOB-13 names, and fault_codes with the symptom / cause / remedy
-- discriminator JOB-14 asks for. What it did not build was anywhere to record
-- a choice. jobs.outcome_code has been a nullable varchar since 0005 with
-- nothing writing to it and nothing constraining it, and there has never been
-- a column of any kind for a fault code.
--
-- ── WHY THIS IS NOT COSMETIC ────────────────────────────────────────────────
--
-- G11 is first-time fix rate, target above 85 percent, defined as jobs closed
-- on the first visit over all reactive jobs. The only thing that can tell those
-- apart is the outcome code, so without capture the metric has no numerator and
-- the target cannot be reported against at all.
--
-- JOB-14 is the harder one to retrofit. A fault typed into a notes field cannot
-- answer "how many times has this model failed the same way", which is the
-- whole argument for a taxonomy: PPM justification, reliability data and tender
-- evidence all come from that one question. By the time somebody wants the
-- answer the history is already written, and no amount of later work recovers
-- what was never coded.

-- ── The diagnosis (JOB-14) ──────────────────────────────────────────────────
--
-- A row per part rather than three columns on jobs. Three columns would have
-- been less code and would also have declared that a job has exactly one
-- symptom forever, which is false for precisely the case JOB-12 exists for: a
-- chiller that trips on Monday for a blocked filter and on Thursday for a
-- failed contactor is two diagnoses, and flattening them to one loses the thing
-- the taxonomy was built to keep.
CREATE TABLE "job_fault_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	-- Null for a single-visit job, which has no choice to make.
	"visit_id" uuid,
	"fault_code_id" uuid NOT NULL,
	-- Denormalised from fault_codes.kind so the uniqueness rule below is a
	-- constraint the database holds rather than a rule the application
	-- remembers. Kept honest by the check further down.
	"kind" varchar(8) NOT NULL,
	-- The technician's own words. Beside the codes, never instead of them: the
	-- codes are what a report groups on, and the sentence is what a person reads
	-- when the grouping surprises them.
	"note" text,
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_fault_codes_kind" CHECK ("kind" IN ('symptom', 'cause', 'remedy'))
);
--> statement-breakpoint

ALTER TABLE "job_fault_codes" ADD CONSTRAINT "job_fault_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_fault_codes" ADD CONSTRAINT "job_fault_codes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_fault_codes" ADD CONSTRAINT "job_fault_codes_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ON DELETE restrict, matching how lead_disposition_reasons is referenced. A
-- code cited by last quarter's work cannot be deleted without rewriting last
-- quarter, so the admin screen deactivates instead: the code leaves the picker
-- and stays in the data.
ALTER TABLE "job_fault_codes" ADD CONSTRAINT "job_fault_codes_fault_code_id_fault_codes_id_fk" FOREIGN KEY ("fault_code_id") REFERENCES "public"."fault_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_fault_codes" ADD CONSTRAINT "job_fault_codes_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "job_fault_codes_job_idx" ON "job_fault_codes" USING btree ("tenant_id","job_id");--> statement-breakpoint

-- The reliability question runs the other way round from the job screen: not
-- "what did this job have" but "how many times has this code been recorded".
-- Without this index that query is a sequential scan over every diagnosis ever
-- made, which is the query the table exists to serve.
CREATE INDEX "job_fault_codes_code_idx" ON "job_fault_codes" USING btree ("tenant_id","fault_code_id","created_at");--> statement-breakpoint

-- One symptom, one cause and one remedy per visit. The coalesce is what makes
-- the rule apply to the job-level diagnosis too: a null visit is one bucket
-- rather than an exemption, and without it a job could accumulate four causes
-- through repeated submissions of the same form.
CREATE UNIQUE INDEX "job_fault_codes_one_per_kind" ON "job_fault_codes"
	USING btree ("tenant_id","job_id", (COALESCE("visit_id", '00000000-0000-0000-0000-000000000000'::uuid)), "kind");--> statement-breakpoint

-- ── The outcome, constrained at last (JOB-13) ───────────────────────────────
--
-- jobs.outcome_code could hold anything: a typo, a value from another
-- company's vocabulary, a sentence. The application checks before it writes,
-- but the application is one of several ways a row gets updated, and this is
-- the requirement that says the list is controlled.
--
-- NOT VALID, deliberately, and for the same reason 0012 used it on the lead
-- disposition check: every insert and update from here on is verified, and
-- rows written before there was a list to choose from are left alone rather
-- than blocking the migration or being back-filled with a guess. A back-filled
-- outcome is indistinguishable from one somebody chose, and the first
-- first-time-fix number drawn from it would be wrong in a way nothing could
-- detect.
--
-- The reference is the composite (tenant_id, code), not the code alone. Two
-- tenants may both define an outcome called partial and they are different
-- rows; a single-column reference would let one company's job cite another
-- company's vocabulary entry.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_outcome_code_fk"
	FOREIGN KEY ("tenant_id", "outcome_code")
	REFERENCES "public"."job_outcome_codes"("tenant_id", "code")
	ON DELETE restrict ON UPDATE cascade NOT VALID;
