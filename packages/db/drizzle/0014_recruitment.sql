-- =============================================================================
-- M9 — Recruitment. `ATS-1`…`ATS-19`, plus the structural half of `HR-16`.
--
-- Three things in this migration are load-bearing beyond the tables:
--
--  1. **`candidates.delete_after` and `candidates.last_interaction_at`**
--     (`ATS-18`). `/api/cron/retention` currently reports, on every run:
--     *"Not yet purged, because the mechanism does not exist: applicant and
--     candidate data (ATS-18) — no `candidates` table."* These two columns and
--     the partial index below are what that job needs, and they are shaped to
--     match `employees.delete_after` exactly so the existing purge reasons
--     about both tables the same way.
--
--  2. **`recruitment_costs.borne_by`** (`HR-16`). A CHECK with one permitted
--     value. Article 6 of Federal Decree-Law 33/2021 prohibits charging or
--     recovering recruitment fees from a worker, and the PRD asks for that to
--     be structurally impossible rather than validated. There is no
--     `charged_to_worker` column, no `recoverable` flag, no `deduct_from_salary`
--     amount, and `borne_by` cannot hold anything but `employer`. A
--     worker-borne recruitment cost is not a row that fails validation; it is a
--     row no path can write, including a hand-typed UPDATE during an incident.
--
--  3. **`applications.outcome_*`** (`ATS-16`). "This applicant was never told"
--     is normally invisible, because nothing is written when nothing happens.
--     These columns make the absence a queryable state: an application is owed
--     an outcome when `status <> 'active' AND outcome_sent_at IS NULL`, and
--     overdue when `outcome_due_at` has passed. `applications_outcome_owed_idx`
--     is a partial index on exactly that predicate.
--
-- Every tenant-scoped table below carries `tenant_id` as its first column, so
-- the generic loop in sql/rls.sql picks it up and applies FORCE ROW LEVEL
-- SECURITY plus the tenant policy without a line being written here. Re-run
-- sql/rls.sql after this migration; verify-rls.sql check 9 fails if you forget.
--
-- The unauthenticated application path does NOT write through these grants —
-- see `app_public_submit_application` in sql/public-functions.sql.
-- =============================================================================

-- ── ATS-1: requisitions ─────────────────────────────────────────────────────
CREATE TABLE "job_requisitions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Internal identity, allocated by app_next_reference('REQ', year). Separate
	-- from public_slug because the identity must never change and the URL will.
	"reference" varchar(32) NOT NULL,
	"public_slug" varchar(120) NOT NULL,
	"title" varchar(160) NOT NULL,
	-- A catalogue service slug, so a requisition, a technician's skill and a
	-- job all name the trade with the same string.
	"trade" varchar(64) NOT NULL,
	"grade" varchar(24) DEFAULT 'technician' NOT NULL,
	"headcount" integer DEFAULT 1 NOT NULL,
	"contract_type" varchar(16) DEFAULT 'full_time' NOT NULL,
	"location_city" varchar(80) DEFAULT 'Dubai' NOT NULL,
	"location_area" varchar(120),
	-- Fils. Published in JobPosting structured data when set, which makes it a
	-- public commitment — hence the both-or-neither CHECK below.
	"salary_band_min_minor" bigint,
	"salary_band_max_minor" bigint,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"min_experience_years" integer,
	"required_certifications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"responsibilities" text,
	-- ATS-6. Physical requirements are stated in the advert and confirmed with
	-- one yes/no on the form. There is nowhere on the applicant record to store
	-- a health answer, and that is deliberate.
	"physical_requirements" text,
	"opens_at" timestamp with time zone,
	"closes_at" timestamp with time zone,
	"hiring_manager_user_id" uuid,
	"status" varchar(24) DEFAULT 'draft' NOT NULL,
	-- ATS-1 names an approval state. An approval with no record of who granted
	-- it is a status badge, so publishing requires both of these to be set.
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "job_requisitions_status" CHECK (
		"status" IN ('draft', 'pending_approval', 'open', 'on_hold', 'filled', 'cancelled')
	),
	CONSTRAINT "job_requisitions_contract_type" CHECK (
		"contract_type" IN ('full_time', 'part_time', 'temporary')
	),
	CONSTRAINT "job_requisitions_headcount" CHECK ("headcount" >= 1),
	-- Both ends of the band or neither. A half-set band renders as "from AED 0"
	-- in a Google Jobs result, which is a salary claim nobody made.
	CONSTRAINT "job_requisitions_salary_band" CHECK (
		("salary_band_min_minor" IS NULL) = ("salary_band_max_minor" IS NULL)
		AND (
			"salary_band_min_minor" IS NULL
			OR "salary_band_min_minor" <= "salary_band_max_minor"
		)
	),
	-- Publishing requires an approval. ATS-1 makes approval a state; this makes
	-- it a gate, so a draft cannot reach the careers site by a status update.
	CONSTRAINT "job_requisitions_open_requires_approval" CHECK (
		"status" <> 'open' OR "approved_at" IS NOT NULL
	)
);
--> statement-breakpoint

ALTER TABLE "job_requisitions"
	ADD CONSTRAINT "job_requisitions_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "job_requisitions"
	ADD CONSTRAINT "job_requisitions_hiring_manager_fk"
	FOREIGN KEY ("hiring_manager_user_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "job_requisitions"
	ADD CONSTRAINT "job_requisitions_approved_by_fk"
	FOREIGN KEY ("approved_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint

CREATE UNIQUE INDEX "job_requisitions_reference_key" ON "job_requisitions" ("tenant_id", "reference");--> statement-breakpoint
CREATE UNIQUE INDEX "job_requisitions_slug_key" ON "job_requisitions" ("tenant_id", "public_slug");--> statement-breakpoint
CREATE INDEX "job_requisitions_public_idx" ON "job_requisitions" ("tenant_id", "status", "closes_at") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "job_requisitions_trade_idx" ON "job_requisitions" ("tenant_id", "trade", "status");--> statement-breakpoint

-- ── ATS-7: the pipeline, per requisition, capped at twelve ──────────────────
--
-- `stage_type` is the semantic; `name` is the label. Reporting groups on the
-- type so a tenant can rename "Trade check" to "Bench test" without splitting
-- every historical funnel chart in two.
--
-- `site_trial` is a first-class type. It is the trades equivalent of a
-- technical assessment, it is absent from every generic ATS's defaults, and a
-- pipeline that models it as a generic interview cannot answer the only
-- question the stage exists to ask.
CREATE TABLE "requisition_stages" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"stage_type" varchar(24) NOT NULL,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "requisition_stages_type" CHECK (
		"stage_type" IN (
			'applied', 'screening', 'trade_check', 'site_trial',
			'interview', 'offer', 'onboarding', 'hired'
		)
	),
	-- ATS-7 caps the pipeline at 12. Enforced here rather than in a form: a
	-- twenty-stage pipeline is how a board stops fitting on a screen and starts
	-- being maintained in a spreadsheet instead.
	CONSTRAINT "requisition_stages_cap" CHECK ("sequence" BETWEEN 1 AND 12)
);
--> statement-breakpoint

ALTER TABLE "requisition_stages"
	ADD CONSTRAINT "requisition_stages_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "requisition_stages"
	ADD CONSTRAINT "requisition_stages_requisition_fk"
	FOREIGN KEY ("requisition_id") REFERENCES "job_requisitions"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE UNIQUE INDEX "requisition_stages_sequence_key" ON "requisition_stages" ("requisition_id", "sequence");--> statement-breakpoint
CREATE INDEX "requisition_stages_requisition_idx" ON "requisition_stages" ("tenant_id", "requisition_id", "sequence");--> statement-breakpoint

-- ── ATS-11 / ATS-12 / ATS-18: the person ────────────────────────────────────
--
-- WHAT IS NOT HERE, AND WHY THE ABSENCE IS THE FEATURE (ATS-6):
--
--   date of birth · nationality · ethnicity · religion · marital status ·
--   children · gender · photograph · health or disability status
--
-- None of them is asked on the form, and none of them has a column to be
-- written into by an importer, an integration or a future screen.
-- `over_eighteen` is the only age fact, and it is a boolean rather than a date
-- because a date is a birth date wearing a different name.
--
-- Also absent: any score, rank or rating column (ATS-19). No automated
-- ranking, scoring or auto-rejection. Cheap to honour now; very expensive to
-- unwind once a chart depends on the number.
CREATE TABLE "candidates" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" varchar(160) NOT NULL,
	-- The primary identifier in this market (ATS-3). Always present; email is
	-- the optional one, which is the inversion this workforce needs.
	"phone" varchar(24) NOT NULL,
	-- ATS-11. The loose matcher compares local digits, ignoring the country
	-- code: +971 50 123 4567, 0501234567 and 971501234567 are one person.
	--
	-- GENERATED, not application-maintained. A matcher is only as good as its
	-- worst writer, and an importer that forgets this column produces a
	-- candidate who matches nobody — silently, which is the worst way for
	-- duplicate detection to fail.
	"phone_local_digits" varchar(9)
		GENERATED ALWAYS AS (right(regexp_replace("phone", '[^0-9]', '', 'g'), 9)) STORED,
	"email" varchar(200),
	"primary_trade" varchar(64) NOT NULL,
	"grade" varchar(24) DEFAULT 'technician' NOT NULL,
	"experience_band" varchar(16) NOT NULL,
	-- ATS-5. Logistics, never a screen. This is "can we book a trade test next
	-- week or does this need an entry permit first", not a right-to-work check.
	"current_location" varchar(16) NOT NULL,
	"current_area" varchar(120),
	"has_driving_licence" boolean DEFAULT false NOT NULL,
	"over_eighteen" boolean DEFAULT true NOT NULL,
	-- ATS-5. Captured at Trade Check, from everyone shortlisted, used for permit
	-- and timeline planning only. Null until then, and the public submission
	-- function has no argument that can set it.
	"visa_status" varchar(40),
	"visa_current_sponsor" varchar(160),
	"notes" text,
	-- ATS-11. Nothing is deleted by a merge. The merged row stays and points at
	-- the survivor, so both activity feeds remain readable.
	"merged_into_candidate_id" uuid,
	"converted_technician_id" uuid,
	-- ── Retention (ATS-18) ──────────────────────────────────────────────────
	-- Six months from the last meaningful interaction. Reset by an explicit
	-- touch, never by an ordinary write: a sweep that updated this column would
	-- postpone its own deletion forever.
	"last_interaction_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- pre_contractual | consent | employee. Three different clocks, and this is
	-- what stops them being confused for one another. The default basis is the
	-- pre-contractual negotiation exception under Federal Decree-Law 45/2021
	-- Article 4, which covers the recruitment purpose and expires with it.
	"retention_basis" varchar(24) DEFAULT 'pre_contractual' NOT NULL,
	-- Same type and nullability as employees.delete_after, on purpose: one
	-- purge job, one shape of predicate, one index strategy.
	"delete_after" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candidates_location" CHECK ("current_location" IN ('in_uae', 'outside_uae')),
	CONSTRAINT "candidates_experience_band" CHECK (
		"experience_band" IN ('under_2', '2_to_5', '5_to_10', 'over_10')
	),
	CONSTRAINT "candidates_grade" CHECK (
		"grade" IN ('helper', 'technician', 'senior_technician', 'charge_hand', 'supervisor')
	),
	CONSTRAINT "candidates_retention_basis" CHECK (
		"retention_basis" IN ('pre_contractual', 'consent', 'employee')
	),
	CONSTRAINT "candidates_visa_status" CHECK (
		"visa_status" IS NULL OR "visa_status" IN (
			'own_or_spouse_sponsored', 'employment_transferable',
			'employment_requires_cancellation', 'outside_uae_entry_permit', 'visit_visa'
		)
	),
	-- ATS-6, at the database. Under-18s are not recorded at all rather than
	-- recorded and filtered, so there is no row describing a minor's trade
	-- history sitting in this table waiting for a retention job.
	CONSTRAINT "candidates_over_eighteen" CHECK ("over_eighteen")
);
--> statement-breakpoint

ALTER TABLE "candidates"
	ADD CONSTRAINT "candidates_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "candidates"
	ADD CONSTRAINT "candidates_merged_into_fk"
	FOREIGN KEY ("merged_into_candidate_id") REFERENCES "candidates"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "candidates"
	ADD CONSTRAINT "candidates_converted_technician_fk"
	FOREIGN KEY ("converted_technician_id") REFERENCES "technicians"("id") ON DELETE set null;
--> statement-breakpoint

-- DB-8: the two duplicate-detection lookups.
CREATE INDEX "candidates_phone_local_idx" ON "candidates" ("tenant_id", "phone_local_digits");--> statement-breakpoint
CREATE INDEX "candidates_email_idx" ON "candidates" ("tenant_id", lower("email"));--> statement-breakpoint
CREATE INDEX "candidates_trade_idx" ON "candidates" ("tenant_id", "primary_trade", "grade");--> statement-breakpoint
-- The purge's predicate and nothing else, partial so it stays small on a table
-- where most live rows have no date set. Mirrors employees_retention_idx.
CREATE INDEX "candidates_retention_idx" ON "candidates" ("delete_after") WHERE "delete_after" IS NOT NULL;--> statement-breakpoint

-- ── ATS-4: certifications as structured records ─────────────────────────────
--
-- `expires_on` is NOT NULL and that is the entire point of the table. Expiry is
-- the field everyone forgets, and the day it matters is the day a dispatch is
-- refused under HR-9 — by which time the certificate is on file, unusable, and
-- nobody can say when it lapsed.
--
-- The column names line up field-for-field with technician_certifications so
-- that hireCandidate's copy is a mapping rather than a translation (ATS-17: no
-- re-keying).
CREATE TABLE "candidate_certifications" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"scheme" varchar(120) NOT NULL,
	"certificate_no" varchar(80),
	"level" varchar(40),
	"issuing_body" varchar(160),
	"issued_on" date,
	"expires_on" date NOT NULL,
	"evidence_storage_key" text,
	"verified_by_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "candidate_certifications"
	ADD CONSTRAINT "candidate_certifications_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "candidate_certifications"
	ADD CONSTRAINT "candidate_certifications_candidate_fk"
	FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "candidate_certifications"
	ADD CONSTRAINT "candidate_certifications_verified_by_fk"
	FOREIGN KEY ("verified_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint

CREATE INDEX "candidate_certifications_candidate_idx" ON "candidate_certifications" ("tenant_id", "candidate_id");--> statement-breakpoint
CREATE INDEX "candidate_certifications_expiry_idx" ON "candidate_certifications" ("tenant_id", "expires_on");--> statement-breakpoint

-- ── ATS-9 / ATS-10: uploaded files ──────────────────────────────────────────
--
-- The scan gate is a column, not an inference, because "has this been scanned"
-- must survive a page reload, a second server and a redeploy. Downloads are
-- refused for anything that is not `clean` or `skipped`, and `skipped` means a
-- deployment has explicitly said it has no scanner rather than that one was
-- tried and gave up.
--
-- There is no `id_document` kind. No identity documents are collected before a
-- conditional offer; those live on the employee record, after the hire.
CREATE TABLE "candidate_documents" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"application_id" uuid,
	"kind" varchar(24) NOT NULL,
	"storage_key" text NOT NULL,
	"filename" varchar(200),
	-- Sniffed from magic bytes by packages/files, never taken from the client.
	"content_type" varchar(80) NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"scan_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"scanned_at" timestamp with time zone,
	"scanner_note" varchar(200),
	-- ATS-10. Parse failure is a frequent, first-class state: trades CVs are
	-- often photographs. The original file is retained always, and
	-- parser_version is what makes reprocessing possible later.
	"parse_status" varchar(16) DEFAULT 'not_attempted' NOT NULL,
	"parser_version" varchar(40),
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "candidate_documents_kind" CHECK ("kind" IN ('cv', 'certificate', 'other')),
	CONSTRAINT "candidate_documents_scan_status" CHECK (
		"scan_status" IN ('pending', 'clean', 'infected', 'skipped')
	),
	CONSTRAINT "candidate_documents_parse_status" CHECK (
		"parse_status" IN ('not_attempted', 'parsed', 'failed', 'unsupported')
	),
	-- ATS-9 caps a CV at 10 MB and certificate evidence at 20 MB. The wider cap
	-- is enforced here; the per-kind cap is enforced at the upload path where
	-- the kind is known.
	CONSTRAINT "candidate_documents_size" CHECK ("size_bytes" > 0 AND "size_bytes" <= 20971520)
);
--> statement-breakpoint

ALTER TABLE "candidate_documents"
	ADD CONSTRAINT "candidate_documents_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "candidate_documents"
	ADD CONSTRAINT "candidate_documents_candidate_fk"
	FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE INDEX "candidate_documents_candidate_idx" ON "candidate_documents" ("tenant_id", "candidate_id");--> statement-breakpoint
CREATE INDEX "candidate_documents_scan_idx" ON "candidate_documents" ("tenant_id", "scan_status");--> statement-breakpoint

-- ── ATS-12 / ATS-16: the application ────────────────────────────────────────
--
-- Three axes, kept separate:
--   current_stage_id        where it is
--   status                  whether it is live
--   disposition_reason_code why it ended, and archived_at_stage_id where
--
-- archived_at_stage_id looks redundant next to current_stage_id and is not.
-- Funnel conversion — "we lose people at trade check" — is unanswerable without
-- it and cannot be reconstructed later, because the fact was never recorded.
--
-- ── THE OUTCOME COLUMNS ─────────────────────────────────────────────────────
--
-- ATS-16 targets 100% of applicants receiving an outcome (G14). The reason
-- every ATS misses it is not carelessness: "nobody replied to this person" is
-- normally not a state a database holds, because nothing is written when
-- nothing happens. So there is nothing to query, nothing to report, and the
-- whole thing rests on somebody remembering.
--
-- outcome_due_at is set at INSERT from the promise the applicant is shown on
-- the confirmation screen, so the screen and the counter read the same number.
-- outcome_sent_at is the only column that discharges the obligation. Everything
-- between them is ATS-15's cancellable window.
CREATE TABLE "applications" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(32) NOT NULL,
	"candidate_id" uuid NOT NULL,
	"requisition_id" uuid NOT NULL,
	"current_stage_id" uuid,
	"stage_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"disposition_reason_code" varchar(48),
	"disposition_note" text,
	"archived_at_stage_id" uuid,
	"archived_at" timestamp with time zone,
	-- ATS-8. The cheapest high-value feature in the module: in a market where a
	-- good AC technician holds three offers, "who is blocking this" is the only
	-- question that matters. Falls back to time-in-stage when nothing structured
	-- has been recorded — see blockedState() in packages/core.
	"blocked_on" varchar(16) DEFAULT 'none' NOT NULL,
	"blocked_note" varchar(200),
	"blocked_since" timestamp with time zone,
	"availability" varchar(24),
	-- ATS-6. A job question with two answers, one of which is "I'd like to
	-- discuss it". Never a health question, and never a filter.
	"essential_functions" varchar(16),
	"source" varchar(32) DEFAULT 'careers_site' NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- ATS-14. The immediate acknowledgement, which is not the outcome.
	"acknowledged_at" timestamp with time zone,
	"outcome_due_at" timestamp with time zone NOT NULL,
	"outcome_scheduled_at" timestamp with time zone,
	"outcome_message" text,
	"outcome_channel" varchar(16),
	"outcome_cancelled_at" timestamp with time zone,
	"outcome_sent_at" timestamp with time zone,
	"outcome_notification_id" uuid,
	-- The applicant's own tracking link. No account, because an account is a
	-- password a tradesperson will not create for one application.
	"status_token" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "applications_status" CHECK ("status" IN ('active', 'archived', 'hired')),
	CONSTRAINT "applications_blocked_on" CHECK ("blocked_on" IN ('none', 'candidate', 'us')),
	CONSTRAINT "applications_essential_functions" CHECK (
		"essential_functions" IS NULL OR "essential_functions" IN ('yes', 'discuss')
	),
	CONSTRAINT "applications_availability" CHECK (
		"availability" IS NULL OR "availability" IN
			('immediate', 'two_weeks', 'one_month', 'two_months_plus')
	),
	-- ATS-16, at the database. An application cannot leave `active` without a
	-- disposition reason and the stage it died at. This is the backstop behind
	-- closeApplication(), not the message anyone should have to read: without
	-- it, "archived" with a null reason is a rejection nobody can explain and
	-- an applicant nobody can write to, because the reason is what composes the
	-- message.
	CONSTRAINT "applications_archived_needs_reason" CHECK (
		"status" <> 'archived'
		OR ("disposition_reason_code" IS NOT NULL AND "archived_at_stage_id" IS NOT NULL)
	),
	-- A sent outcome must have been composed first. Catches an UPDATE that
	-- stamps outcome_sent_at to clear a report without a message existing.
	CONSTRAINT "applications_sent_outcome_has_message" CHECK (
		"outcome_sent_at" IS NULL OR "outcome_message" IS NOT NULL
	)
);
--> statement-breakpoint

ALTER TABLE "applications"
	ADD CONSTRAINT "applications_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "applications"
	ADD CONSTRAINT "applications_candidate_fk"
	FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE cascade;
--> statement-breakpoint
-- restrict, not cascade. Deleting a requisition out from under twenty-four
-- applications would destroy the record of twenty-four people we owe an answer.
ALTER TABLE "applications"
	ADD CONSTRAINT "applications_requisition_fk"
	FOREIGN KEY ("requisition_id") REFERENCES "job_requisitions"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "applications"
	ADD CONSTRAINT "applications_current_stage_fk"
	FOREIGN KEY ("current_stage_id") REFERENCES "requisition_stages"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "applications"
	ADD CONSTRAINT "applications_archived_stage_fk"
	FOREIGN KEY ("archived_at_stage_id") REFERENCES "requisition_stages"("id") ON DELETE set null;
--> statement-breakpoint

ALTER TABLE "candidate_documents"
	ADD CONSTRAINT "candidate_documents_application_fk"
	FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE set null;
--> statement-breakpoint

CREATE UNIQUE INDEX "applications_reference_key" ON "applications" ("tenant_id", "reference");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_status_token_key" ON "applications" ("status_token");--> statement-breakpoint
-- ATS-12. One LIVE application per person per role. Partial, so re-applying
-- after an archived attempt is permitted — which is what ATS-12 asks for, with
-- the prior outcome surfaced rather than the new application refused.
CREATE UNIQUE INDEX "applications_live_key" ON "applications" ("candidate_id", "requisition_id") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX "applications_pipeline_idx" ON "applications" ("tenant_id", "requisition_id", "status", "current_stage_id");--> statement-breakpoint
CREATE INDEX "applications_candidate_idx" ON "applications" ("tenant_id", "candidate_id");--> statement-breakpoint
-- THE ATS-16 INDEX. Covers the entire accountability query: everyone owed an
-- outcome, oldest promise first.
CREATE INDEX "applications_outcome_owed_idx" ON "applications" ("tenant_id", "outcome_due_at") WHERE "outcome_sent_at" IS NULL;--> statement-breakpoint

-- ── The activity feed (ATS-11) ──────────────────────────────────────────────
CREATE TABLE "application_events" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"note" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" uuid,
	"actor_kind" varchar(16) DEFAULT 'user' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_events_actor_kind" CHECK (
		"actor_kind" IN ('user', 'candidate', 'system')
	)
);
--> statement-breakpoint

ALTER TABLE "application_events"
	ADD CONSTRAINT "application_events_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "application_events"
	ADD CONSTRAINT "application_events_application_fk"
	FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "application_events"
	ADD CONSTRAINT "application_events_actor_fk"
	FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint

CREATE INDEX "application_events_application_idx" ON "application_events" ("tenant_id", "application_id", "occurred_at");--> statement-breakpoint

-- ── ATS-13: the talent pool ─────────────────────────────────────────────────
--
-- A candidate is IN A POOL, not IN A STAGE. Modelling the pool as a pipeline
-- stage is the mistake that makes it useless: it fills a column that represents
-- live work with people nobody is currently considering.
--
-- Its own lawful basis, and this table is where that basis lives.
-- consent_captured_at is NOT NULL, so there is no path that adds somebody
-- without recording when they agreed. reconfirm_due_at is what stops the pool
-- rotting — a tradesperson's availability and certification validity go stale
-- in weeks, and a pool nobody re-confirms is a list of people who have all
-- found other work.
CREATE TABLE "talent_pool_members" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"pool_key" varchar(64) NOT NULL,
	"consent_captured_at" timestamp with time zone NOT NULL,
	"consent_source" varchar(32) NOT NULL,
	"consent_withdrawn_at" timestamp with time zone,
	"reconfirm_due_at" timestamp with time zone NOT NULL,
	"reconfirmed_at" timestamp with time zone,
	"added_reason" varchar(48),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "talent_pool_consent_source" CHECK (
		"consent_source" IN ('application_form', 'staff_recorded')
	)
);
--> statement-breakpoint

ALTER TABLE "talent_pool_members"
	ADD CONSTRAINT "talent_pool_members_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "talent_pool_members"
	ADD CONSTRAINT "talent_pool_members_candidate_fk"
	FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE UNIQUE INDEX "talent_pool_members_key" ON "talent_pool_members" ("candidate_id", "pool_key");--> statement-breakpoint
CREATE INDEX "talent_pool_members_pool_idx" ON "talent_pool_members" ("tenant_id", "pool_key", "reconfirm_due_at");--> statement-breakpoint

-- ── HR-16: the structural prohibition ───────────────────────────────────────
--
-- Article 6 of Federal Decree-Law 33/2021 prohibits charging or collecting
-- recruitment and employment fees from a worker, directly or indirectly. The
-- PRD asks for this to be structurally impossible — "not a validation message,
-- an absence of the field".
--
-- Read the column list for what is NOT here: no charged_to_worker, no
-- recoverable, no deduct_from_salary, no repayment_months, no bond. And
-- `borne_by` accepts exactly one value.
--
-- The single-valued column is deliberate rather than pointless. A table with no
-- bearer column asserts nothing; this one asserts, in the schema, in a form
-- both a reviewer and the database check, that the employer pays. A migration
-- that ever wanted to charge a worker would have to drop a named constraint,
-- which is a line in a diff somebody has to justify.
CREATE TABLE "recruitment_costs" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requisition_id" uuid,
	"candidate_id" uuid,
	"kind" varchar(32) NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"borne_by" varchar(16) DEFAULT 'employer' NOT NULL,
	"incurred_on" date NOT NULL,
	"note" text,
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	-- HR-16. One permitted value. This is the constraint the requirement asks
	-- for, and packages/db/test/recruitment.test.ts proves it refuses 'worker'.
	CONSTRAINT "recruitment_costs_borne_by_employer" CHECK ("borne_by" = 'employer'),
	CONSTRAINT "recruitment_costs_kind" CHECK (
		"kind" IN ('agency_fee', 'visa_and_permit', 'medical', 'emirates_id',
		           'travel', 'advertising', 'other')
	),
	-- Non-negative. A negative cost is a recovery, and a recovery from a worker
	-- is the thing this table exists to make unrepresentable.
	CONSTRAINT "recruitment_costs_amount" CHECK ("amount_minor" >= 0)
);
--> statement-breakpoint

ALTER TABLE "recruitment_costs"
	ADD CONSTRAINT "recruitment_costs_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "recruitment_costs"
	ADD CONSTRAINT "recruitment_costs_requisition_fk"
	FOREIGN KEY ("requisition_id") REFERENCES "job_requisitions"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "recruitment_costs"
	ADD CONSTRAINT "recruitment_costs_candidate_fk"
	FOREIGN KEY ("candidate_id") REFERENCES "candidates"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "recruitment_costs"
	ADD CONSTRAINT "recruitment_costs_recorded_by_fk"
	FOREIGN KEY ("recorded_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint

CREATE INDEX "recruitment_costs_requisition_idx" ON "recruitment_costs" ("tenant_id", "requisition_id");--> statement-breakpoint
CREATE INDEX "recruitment_costs_candidate_idx" ON "recruitment_costs" ("tenant_id", "candidate_id");
