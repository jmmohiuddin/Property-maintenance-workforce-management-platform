-- The work injury register and the HSE record set -- HR-11 and HR-12.
--
-- Two requirements, one migration, because they are one loop: an injury is
-- investigated, the risk assessment is rewritten, the rewrite is briefed in a
-- toolbox talk, and the PPE the talk names is issued and dated. Splitting them
-- across two migrations would have left work_injuries.rams_id pointing at a
-- table that did not exist yet.
--
-- == HR-11: the 48-hour clock, and why it is an instant ======================
--
-- Article 37 of Federal Decree-Law No. 33 of 2021 obliges the employer to
-- notify the competent authorities of a work injury or occupational disease and
-- to bear the cost of treatment; the Implementing Regulation obliges the
-- employer to keep a register of both. MOHRE_INJURY_NOTIFICATION_HOURS in
-- packages/core is the window this system enforces, and the honest limits of
-- that number are written on the constant rather than here.
--
-- The clock runs on became_known_at, an instant, because 48 hours is 48 hours
-- in any timezone -- rounding it to a calendar day would either give away eight
-- hours or take fourteen. Dubai's day is used for the REGISTER: occurred_on is
-- a stored date column carrying the Dubai calendar day of occurred_at.
--
-- occurred_on is stored rather than generated because "at time zone
-- 'Asia/Dubai'" is STABLE and not IMMUTABLE, so Postgres refuses it in a
-- generated column -- and deriving it at read time from whatever timezone the
-- session carries is the defect this repository has now hit eight times. A
-- night-shift injury at 01:00 Dubai is 21:00 UTC the previous evening. Filed
-- under the session's day it lands in the wrong month of the register, and on
-- the 1st of January in the wrong year.
--
-- == HR-11: the FK that is deliberately NOT a cascade ========================
--
-- Every other child of employees in this schema cascades, because HR-15 only
-- purges an employee seven years after termination and everything downstream is
-- a payroll record with the same seven-year floor.
--
-- An injury record is not. An occupational disease can be diagnosed a decade
-- after the exposure and a compensation claim can be brought long after the
-- employment ended, so a register that vanished with the employee would destroy
-- the evidence in the dispute it exists to settle. Keeping a named person's
-- health information for ever is what the HR-15 clock exists to prevent. ON
-- DELETE SET NULL satisfies both: the register entry survives the purge as an
-- OSH statistic and the link to the person is severed by the purge itself.
--
-- work_injuries is also added to RETENTION_PROTECTED_TABLES in
-- domain/retention.ts, so nothing deletes the row directly either.
--
-- == HR-11: what is NOT in this table =======================================
--
-- No diagnosis, no treatment, no medication, no hospital, no treating doctor,
-- no body part, no nationality, no fitness-to-return opinion. Each of those is
-- health or protected-characteristic data about an identifiable person that the
-- statutory register and a MOHRE notification do not require. medical_report_key
-- is a pointer to a file in object storage under the same access control as any
-- other employee document -- the register knows a report exists, not what it
-- says. The rejection reasons are recorded per field in schema/compliance.ts.
--
-- police_reference has no countdown behind it on purpose. A serious injury or a
-- death must be reported to the police immediately, and "immediately" is not a
-- countdown; a 48-hour bar beside that field would read as permission to wait
-- two days.
--
-- == HR-12: what is here, and the one thing that is not =====================
--
-- RAMS, toolbox talks with named attendance, and PPE issue. IRATA rope-access
-- certification is NOT here, and that is the design decision rather than an
-- omission: technician_certifications already holds a per-person certification
-- with an issuer, a reference, an expiry and required_for_services, and
-- assignmentWarnings already raises certification_expired against it, which
-- WARNING_REQUIRES_OVERRIDE marks as needing a recorded reason before an
-- assignment goes through. The nightly compliance sweep already sends
-- certification_expiring before it lapses. A second certification table would
-- have produced two answers to "is this ticket current", and the second answer
-- is always the stale one -- and it would have been invisible to the dispatch
-- gate, which is the only place the answer changes anybody's behaviour.
--
-- == The two different retention answers on one parent ======================
--
-- work_injuries.employee_id is ON DELETE SET NULL. toolbox_talk_attendees and
-- ppe_issues are ON DELETE CASCADE. That is not an inconsistency: an attendance
-- record and a PPE issue are ordinary personal data with no statutory life
-- beyond the employment, and they should go with the HR-15 purge. An injury
-- record is evidence in a claim that outlives it.
--
-- == RLS ====================================================================
--
-- Five new tables, every one carrying tenant_id, so the generic loop in
-- sql/rls.sql covers them the next time it runs. work_injuries is ALSO added to
-- the `audited` array in that file -- it is at least as sensitive as the
-- payroll tables added there, and "who edited the injury record, and when" is
-- precisely the question asked after a claim is disputed. The other four are
-- not: a toolbox-talk attendance list is not the sort of record whose edit
-- history anybody asks for, and audit volume that buys nothing crowds out the
-- rows that matter.
--
-- Re-run the WHOLE sql/ list in README order after this migration -- never
-- rls.sql alone, because it ends with a blanket GRANT that public-functions.sql
-- then revokes for rate_limits. Then confirm verify-rls reports 14/14.

-- ── HR-11: the work injury register ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "work_injuries" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(32) NOT NULL,
	-- Nullable, and severed rather than cascaded. See the header.
	"employee_id" uuid,
	-- Frozen, and it survives the purge that nulls employee_id above. A
	-- pseudonymous internal reference rather than a name; it maps to nothing
	-- once employees is gone, and purgeExpiredEmployees already writes exactly
	-- this value into audit_log -- so this is what ties a surviving register
	-- entry to the audit row that recorded the purge.
	"employee_no" varchar(32),
	"kind" varchar(24) DEFAULT 'work_injury' NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	-- Dubai's calendar day for occurred_at. Written by the domain layer from
	-- the Dubai key; never DEFAULT current_date, which is the session's day.
	"occurred_on" date NOT NULL,
	-- The clock starts HERE, not at occurred_at. Equal to it for an injury
	-- somebody witnessed; later for an occupational disease, which arrives as a
	-- diagnosis. A clock started at an exposure ten years ago would report every
	-- such record as an immediate statutory breach on the day it was entered,
	-- which would teach everybody to stop entering them.
	"became_known_at" timestamp with time zone NOT NULL,
	"severity" varchar(24) NOT NULL,
	"cause" varchar(32) NOT NULL,
	"location" varchar(200),
	"job_id" uuid,
	"description" text NOT NULL,
	"days_lost" integer,
	"mohre_notified_at" timestamp with time zone,
	"mohre_reference" varchar(64),
	"insurer_notified_at" timestamp with time zone,
	"insurer_claim_reference" varchar(64),
	"police_reference" varchar(64),
	"medical_report_key" text,
	"investigation_completed_on" date,
	"corrective_action" text,
	"rams_id" uuid,
	"recorded_by_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "work_injuries_kind_check"
	  CHECK ("kind" IN ('work_injury', 'occupational_disease')),
	CONSTRAINT "work_injuries_severity_check"
	  CHECK ("severity" IN ('first_aid', 'medical_treatment', 'lost_time', 'serious', 'fatal')),
	-- A positive list, mirroring INJURY_CAUSES in packages/core. The list is
	-- the maintenance trades' mechanisms -- height, live fittings, plant rooms,
	-- refrigerant -- and it carries `other` because a cause vocabulary that
	-- rejects a real accident is a vocabulary that stops the record being
	-- written at all. That is the opposite call from LAWFUL_DEDUCTION_KINDS,
	-- where an unlisted value is an unlawful act wearing a different label.
	CONSTRAINT "work_injuries_cause_check"
	  CHECK ("cause" IN (
	    'fall_from_height', 'fall_same_level', 'electrical', 'struck_by_object',
	    'caught_in_machinery', 'manual_handling', 'hand_tool', 'chemical_exposure',
	    'refrigerant_exposure', 'confined_space', 'heat_illness', 'road_traffic',
	    'fire_explosion', 'other'
	  )),
	-- The employer cannot have learned of an injury before it happened. Both
	-- feed the 48-hour clock and getting them the wrong way round would start
	-- the countdown in the past.
	CONSTRAINT "work_injuries_known_order_check"
	  CHECK ("became_known_at" >= "occurred_at"),
	-- Lost time is counted in whole days and cannot be negative.
	CONSTRAINT "work_injuries_days_lost_check"
	  CHECK ("days_lost" IS NULL OR "days_lost" >= 0),
	-- A reference without a notification instant, or the other way round, is a
	-- half-recorded notification -- and the half that gets read is whichever one
	-- the screen happens to show. The clock reads mohre_notified_at, so a
	-- reference typed in without it would leave the record alarming for ever
	-- while somebody insists it was reported.
	CONSTRAINT "work_injuries_mohre_pair_check"
	  CHECK ("mohre_reference" IS NULL OR "mohre_notified_at" IS NOT NULL)
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "work_injuries" ADD CONSTRAINT "work_injuries_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "work_injuries" ADD CONSTRAINT "work_injuries_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "work_injuries" ADD CONSTRAINT "work_injuries_job_id_fk"
   FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "work_injuries" ADD CONSTRAINT "work_injuries_recorded_by_id_fk"
   FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "work_injuries_reference_key"
  ON "work_injuries" USING btree ("tenant_id", "reference");--> statement-breakpoint
-- The hourly clock's exact predicate: records MOHRE has not been told about.
-- Partial, because the answer is almost always "none" and a full scan of a
-- register that only grows would be the entire cost of the job.
CREATE INDEX IF NOT EXISTS "work_injuries_unnotified_idx"
  ON "work_injuries" USING btree ("tenant_id", "became_known_at")
  WHERE "mohre_notified_at" IS NULL AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "work_injuries_employee_idx"
  ON "work_injuries" USING btree ("tenant_id", "employee_id");--> statement-breakpoint
-- The register in date order, on Dubai's day. This index is the reason the
-- column exists rather than being computed from occurred_at at read time.
CREATE INDEX IF NOT EXISTS "work_injuries_day_idx"
  ON "work_injuries" USING btree ("tenant_id", "occurred_on");--> statement-breakpoint

-- ── HR-12: risk assessments and method statements ───────────────────────────
CREATE TABLE IF NOT EXISTS "hse_rams" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" varchar(32) NOT NULL,
	"title" varchar(200) NOT NULL,
	"kind" varchar(24) DEFAULT 'rams' NOT NULL,
	"trade_slug" varchar(64),
	"service_slug" varchar(64),
	"job_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"status" varchar(16) DEFAULT 'draft' NOT NULL,
	"approved_by_id" uuid,
	"approved_on" date,
	-- The column this table exists for. A RAMS pack that exists is not evidence
	-- of anything; a pack that was reviewed against how the work is actually
	-- done is. Compared against Dubai's day, everywhere.
	"review_due_on" date,
	"hazards" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"storage_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "hse_rams_kind_check"
	  CHECK ("kind" IN ('risk_assessment', 'method_statement', 'rams')),
	CONSTRAINT "hse_rams_status_check"
	  CHECK ("status" IN ('draft', 'approved', 'superseded', 'withdrawn')),
	CONSTRAINT "hse_rams_version_check"
	  CHECK ("version" >= 1),
	-- An approved pack has an approval date. Without this, "approved" is a
	-- status somebody set, and the review clock has nothing to count from.
	CONSTRAINT "hse_rams_approval_check"
	  CHECK ("status" <> 'approved' OR "approved_on" IS NOT NULL),
	CONSTRAINT "hse_rams_review_order_check"
	  CHECK ("review_due_on" IS NULL OR "approved_on" IS NULL OR "review_due_on" > "approved_on")
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "hse_rams" ADD CONSTRAINT "hse_rams_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "hse_rams" ADD CONSTRAINT "hse_rams_job_id_fk"
   FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "hse_rams" ADD CONSTRAINT "hse_rams_approved_by_id_fk"
   FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Added here rather than as a drizzle `.references()`, matching what 0015 did
-- for employment_contract_terms.renewed_from_id: the referenced table is
-- declared after the referencing one in schema/compliance.ts, and this codebase
-- resolves that by putting the constraint in SQL rather than by relying on a
-- lazy callback across a temporal dead zone.
DO $$ BEGIN
 ALTER TABLE "work_injuries" ADD CONSTRAINT "work_injuries_rams_id_fk"
   FOREIGN KEY ("rams_id") REFERENCES "public"."hse_rams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "hse_rams_reference_key"
  ON "hse_rams" USING btree ("tenant_id", "reference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hse_rams_review_idx"
  ON "hse_rams" USING btree ("tenant_id", "review_due_on")
  WHERE "status" = 'approved' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hse_rams_trade_idx"
  ON "hse_rams" USING btree ("tenant_id", "trade_slug");--> statement-breakpoint

-- ── HR-12: toolbox talks, and who was actually at one ───────────────────────
CREATE TABLE IF NOT EXISTS "toolbox_talks" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Dubai's day, written from the Dubai key. Never DEFAULT current_date.
	"held_on" date NOT NULL,
	"topic" varchar(200) NOT NULL,
	"rams_id" uuid,
	"job_id" uuid,
	"presented_by_id" uuid,
	"presenter_name" varchar(160),
	"duration_minutes" integer,
	"storage_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "toolbox_talks_duration_check"
	  CHECK ("duration_minutes" IS NULL OR "duration_minutes" > 0),
	-- Somebody gave the talk. A talk with no presenter of either kind is a
	-- calendar entry, and the question after an incident is who briefed it.
	CONSTRAINT "toolbox_talks_presenter_check"
	  CHECK ("presented_by_id" IS NOT NULL OR "presenter_name" IS NOT NULL)
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_rams_id_fk"
   FOREIGN KEY ("rams_id") REFERENCES "public"."hse_rams"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_job_id_fk"
   FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talks" ADD CONSTRAINT "toolbox_talks_presented_by_id_fk"
   FOREIGN KEY ("presented_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "toolbox_talks_day_idx"
  ON "toolbox_talks" USING btree ("tenant_id", "held_on");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "toolbox_talks_rams_idx"
  ON "toolbox_talks" USING btree ("tenant_id", "rams_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "toolbox_talk_attendees" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"toolbox_talk_id" uuid NOT NULL,
	-- CASCADE, unlike work_injuries.employee_id. An attendance record is
	-- ordinary personal data with no statutory life beyond the employment; it
	-- should go with the HR-15 purge. See the header.
	"employee_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talk_attendees" ADD CONSTRAINT "toolbox_talk_attendees_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talk_attendees" ADD CONSTRAINT "toolbox_talk_attendees_talk_id_fk"
   FOREIGN KEY ("toolbox_talk_id") REFERENCES "public"."toolbox_talks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "toolbox_talk_attendees" ADD CONSTRAINT "toolbox_talk_attendees_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "toolbox_talk_attendee_key"
  ON "toolbox_talk_attendees" USING btree ("toolbox_talk_id", "employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "toolbox_talk_attendee_employee_idx"
  ON "toolbox_talk_attendees" USING btree ("tenant_id", "employee_id");--> statement-breakpoint

-- ── HR-12: PPE issue ────────────────────────────────────────────────────────
--
-- There is no cost column, and there must not be one. PPE is provided at the
-- employer's expense; LAWFUL_DEDUCTION_KINDS is a positive list with a CHECK
-- behind it, so recovering PPE from a wage is already unrepresentable -- but a
-- cost column here would be the first step towards somebody entering it as
-- damage_recovery, which that list does admit.
CREATE TABLE IF NOT EXISTS "ppe_issues" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"item_kind" varchar(24) NOT NULL,
	"item_description" varchar(160),
	"size" varchar(24),
	"quantity" integer DEFAULT 1 NOT NULL,
	"issued_on" date NOT NULL,
	-- Fall-arrest equipment has a shelf life and an inspection interval, and a
	-- harness past its date comes out of service whether or not it looks fine.
	"replace_due_on" date,
	"acknowledged_at" timestamp with time zone,
	"issued_by_id" uuid,
	"returned_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "ppe_issues_item_kind_check"
	  CHECK ("item_kind" IN (
	    'head', 'eye', 'hearing', 'respiratory', 'hand', 'foot', 'body',
	    'fall_arrest', 'electrical', 'high_visibility'
	  )),
	CONSTRAINT "ppe_issues_quantity_check"
	  CHECK ("quantity" > 0),
	CONSTRAINT "ppe_issues_replace_order_check"
	  CHECK ("replace_due_on" IS NULL OR "replace_due_on" > "issued_on"),
	CONSTRAINT "ppe_issues_return_order_check"
	  CHECK ("returned_on" IS NULL OR "returned_on" >= "issued_on")
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "ppe_issues" ADD CONSTRAINT "ppe_issues_issued_by_id_fk"
   FOREIGN KEY ("issued_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "ppe_issues_employee_idx"
  ON "ppe_issues" USING btree ("tenant_id", "employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ppe_issues_replacement_idx"
  ON "ppe_issues" USING btree ("tenant_id", "replace_due_on")
  WHERE "returned_on" IS NULL AND "deleted_at" IS NULL;
