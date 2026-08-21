-- The employment lifecycle — `HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`.
--
-- 0005 built the compliance register: who is employed, which documents they
-- hold, and which of those stop a dispatch. That answers "may this person work
-- today". This migration answers the other half — "on what terms, for how many
-- hours, at what rate, and were they paid by the 1st" — which is where every
-- remaining row of PRD §11.3 with a penalty attached lives.
--
-- ── WHAT EACH TABLE IS FOR, AND WHY IT IS A TABLE ───────────────────────────
--
--   * `employment_contract_terms` — because a fixed-term contract that runs
--     past its end date auto-renews on the same terms by operation of law, and
--     the day after the end date there are two facts to hold: the term that was
--     signed and the term that is now running. The four columns already on
--     `employees` can hold one of them. Overwriting them loses the signed dates
--     — the evidence in exactly the dispute the auto-renewal rule exists to
--     settle — and leaving them alone renders an employed person as "contract
--     expired", which `HR-4` names as the thing people get wrong.
--
--   * `leave_balances` — deliberately NOT a balance. Entitlement is computed
--     from the service dates and days taken are counted from `leave_requests`;
--     this holds only carry-over and deliberate adjustments, which are facts
--     nothing can derive. A stored `days_taken` drifts the first time a leave
--     request is cancelled by an UPDATE that forgets to decrement it, and the
--     stored number is the one that gets paid out.
--
--   * `overtime_records` — because `HR-8` requires hours *by rate band*, and
--     "the system computes; it does not disburse" only means anything if the
--     computation can be re-read months later when it is challenged.
--
--   * `wage_cycles` / `wage_payments` — `HR-17`, the highest-frequency
--     compliance obligation in the business. Wages for the previous month are
--     due on the 1st and at least 85% of total wages due must be transferred by
--     then. Missing it costs, in order: the ability to hire (day 5), money and a
--     category downgrade (day 11), automatic labour disputes (day 16) and
--     possibly a travel ban (day 21).
--
--   * `salary_deductions` — and its CHECK constraint, which is the real point
--     of the table. See below.
--
-- ── THE ONLY CONSTRAINT IN THIS FILE THAT IS A REQUIREMENT ──────────────────
--
-- `HR-6` says the health insurance premium **may not be deducted from salary**,
-- and `HR-16` says recruitment costs may **never** be recovered from a worker.
-- Both are stated as structural — "must be impossible", not "must be
-- discouraged". A validator in a server action is not impossible: it is one
-- `psql` session, one script, or one future code path away from not existing.
--
-- So `salary_deductions.kind` carries a CHECK against a **positive** list.
-- A negative list of forbidden kinds would have been defeated by the first
-- person to record the premium as "other"; with a positive list, a kind that is
-- not named cannot be stored at all, by anyone, through any route. The same
-- list appears in `packages/core/src/employment.ts` and drives the refusal
-- message in `recordSalaryDeduction`, so the database, the domain and the form
-- cannot disagree without a test failing.
--
-- ── RETENTION ───────────────────────────────────────────────────────────────
--
-- Every table here except `leave_balances` holds pay data, which makes it a tax
-- record under `INV-15`. The seven-year financial floor in
-- `packages/db/src/domain/retention.ts` must cover them; the two-year `HR-15`
-- employee clock must never delete them first.
--
-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- Every table below carries `tenant_id` as its first column, so the generic
-- loop at the top of `sql/rls.sql` covers all six with no hand-written policy.
-- Re-run the `sql/` files in README order after this migration.

-- ── HR-6: health insurance cover on the employment record ───────────────────
--
-- The plan tier, the insurer and the employer's premium. No expiry column:
-- `health_insurance` is already one of the five blocking document kinds in
-- `employee_documents` and carries the expiry that hard-blocks a dispatch. A
-- second expiry here would be a second source of truth, and the one that is
-- wrong is always the one somebody reads.
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "health_plan" varchar(24);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "health_insurer" varchar(120);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "health_policy_no" varchar(64);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "health_premium" numeric(14, 2);--> statement-breakpoint

-- Workers under AED 4,000/month require an Essential Benefits Plan. Anything
-- outside the two tiers is a typo, and a typo here silently defeats the check.
ALTER TABLE "employees" DROP CONSTRAINT IF EXISTS "employees_health_plan_check";--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_health_plan_check"
  CHECK ("health_plan" IS NULL OR "health_plan" IN ('essential_benefits', 'standard'));--> statement-breakpoint

-- ── HR-4: contract terms ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "employment_contract_terms" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	-- 1 for the signed contract, 2 for its first renewal, and so on.
	"sequence" integer DEFAULT 1 NOT NULL,
	"starts_on" date NOT NULL,
	-- Nullable so a defective contract can be RECORDED rather than being
	-- unrepresentable and therefore invisible. `assessContract` reports the
	-- absence as a statutory defect; a NOT NULL here would have meant the
	-- system simply never knew about the contracts that have no end date.
	"ends_on" date,
	"probation_ends_on" date,
	"notice_period_days" integer DEFAULT 30 NOT NULL,
	"basic_salary" numeric(14, 2),
	"allowances" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"working_pattern" varchar(160),
	-- `signed` is a human act; `auto_renewed` is the law's. Storing which is
	-- what lets the UI say "this renewed because work continued" instead of
	-- presenting a term nobody remembers agreeing to.
	"origin" varchar(16) DEFAULT 'signed' NOT NULL,
	"renewed_from_id" uuid,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"storage_key" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "contract_terms_origin_check"
	  CHECK ("origin" IN ('signed', 'auto_renewed', 'amended')),
	CONSTRAINT "contract_terms_status_check"
	  CHECK ("status" IN ('draft', 'active', 'superseded', 'ended')),
	-- A term that ends before it starts is not a data-entry preference.
	CONSTRAINT "contract_terms_order_check"
	  CHECK ("ends_on" IS NULL OR "ends_on" > "starts_on"),
	-- Probation is capped at six months and is non-extendable. Enforced here as
	-- well as in `assessContract` because this one has a hard boundary the
	-- database can express, and a contract with a nine-month probation clause
	-- is void in that clause whether or not the UI that created it still exists.
	CONSTRAINT "contract_terms_probation_check"
	  CHECK (
	    "probation_ends_on" IS NULL
	    OR ("probation_ends_on" > "starts_on" AND "probation_ends_on" <= "starts_on" + INTERVAL '6 months')
	  ),
	-- 30–90 days post-probation. Outside that range the clause is unenforceable,
	-- which in practice means the employer's notice is the one that fails.
	CONSTRAINT "contract_terms_notice_check"
	  CHECK ("notice_period_days" BETWEEN 30 AND 90)
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "employment_contract_terms" ADD CONSTRAINT "employment_contract_terms_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "employment_contract_terms" ADD CONSTRAINT "employment_contract_terms_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "employment_contract_terms" ADD CONSTRAINT "employment_contract_terms_renewed_from_id_fk"
   FOREIGN KEY ("renewed_from_id") REFERENCES "public"."employment_contract_terms"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "contract_terms_sequence_key"
  ON "employment_contract_terms" USING btree ("tenant_id", "employee_id", "sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_terms_employee_idx"
  ON "employment_contract_terms" USING btree ("tenant_id", "employee_id", "starts_on");--> statement-breakpoint
-- The nightly renewal sweep's exact predicate. Without it the job scans every
-- term ever recorded, every night, and a job that gets slow gets switched off.
CREATE INDEX IF NOT EXISTS "contract_terms_expiry_idx"
  ON "employment_contract_terms" USING btree ("tenant_id", "ends_on")
  WHERE "status" = 'active' AND "deleted_at" IS NULL;--> statement-breakpoint

-- ── HR-7: leave carry-over and adjustments ──────────────────────────────────
CREATE TABLE IF NOT EXISTS "leave_balances" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"leave_year_start" date NOT NULL,
	"carried_over_days" integer DEFAULT 0 NOT NULL,
	-- Signed. Taking days away needs the same recorded reason as adding them.
	"adjustment_days" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"adjusted_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "leave_balances_carry_check" CHECK ("carried_over_days" >= 0),
	-- An adjustment with no reason is indistinguishable from a mistake when it
	-- is challenged, and leave adjustments are challenged at termination.
	CONSTRAINT "leave_balances_reason_check"
	  CHECK ("adjustment_days" = 0 OR ("reason" IS NOT NULL AND length(btrim("reason")) > 0))
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "leave_balances" ADD CONSTRAINT "leave_balances_adjusted_by_id_fk"
   FOREIGN KEY ("adjusted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "leave_balances_year_key"
  ON "leave_balances" USING btree ("tenant_id", "employee_id", "leave_year_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leave_balances_employee_idx"
  ON "leave_balances" USING btree ("tenant_id", "employee_id");--> statement-breakpoint

-- ── HR-17: the WPS wage cycle ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "wage_cycles" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- First day of the month the wages are FOR. 2026-08-01 is August's pay.
	"period_month" date NOT NULL,
	-- Stored rather than derived from `period_month`. Ministerial Resolution
	-- No. 340 of 2026 moved this deadline from "within 15 days" to "the 1st",
	-- and history must not move with it: a cycle from May 2026 was due on a
	-- different day and must keep saying so.
	"due_on" date NOT NULL,
	-- Both totals are columns rather than sums over `wage_payments`, because
	-- the 85% test is against *total wages due* — including people whose line
	-- never made it into the file. A sum over the rows that exist can only ever
	-- report 100%, which is the one answer that must not be possible.
	"total_due" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total_transferred" numeric(14, 2) DEFAULT '0' NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"paid_employee_count" integer DEFAULT 0 NOT NULL,
	"file_prepared_on" date,
	"confirmed_on" date,
	"transfer_reference" varchar(64),
	"confirmed_by_id" uuid,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "wage_cycles_status_check"
	  CHECK ("status" IN ('open', 'file_prepared', 'transferred', 'closed')),
	CONSTRAINT "wage_cycles_period_check"
	  CHECK (date_trunc('month', "period_month") = "period_month"),
	CONSTRAINT "wage_cycles_amounts_check"
	  CHECK ("total_due" >= 0 AND "total_transferred" >= 0),
	-- "Transferred" with no bank reference is an assertion, not a record, and
	-- it is the assertion an inspector asks to see evidence for first.
	CONSTRAINT "wage_cycles_reference_check"
	  CHECK ("confirmed_on" IS NULL OR ("transfer_reference" IS NOT NULL AND length(btrim("transfer_reference")) > 0))
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "wage_cycles" ADD CONSTRAINT "wage_cycles_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "wage_cycles" ADD CONSTRAINT "wage_cycles_confirmed_by_id_fk"
   FOREIGN KEY ("confirmed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "wage_cycles_period_key"
  ON "wage_cycles" USING btree ("tenant_id", "period_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wage_cycles_due_idx"
  ON "wage_cycles" USING btree ("tenant_id", "due_on");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "wage_payments" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wage_cycle_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"basic" numeric(14, 2) DEFAULT '0' NOT NULL,
	"allowances" numeric(14, 2) DEFAULT '0' NOT NULL,
	"overtime" numeric(14, 2) DEFAULT '0' NOT NULL,
	-- Sum of `salary_deductions` for this cycle. Cannot include the health
	-- insurance premium, because that kind cannot be stored — see below.
	"deductions" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net" numeric(14, 2) DEFAULT '0' NOT NULL,
	"overtime_minutes" integer DEFAULT 0 NOT NULL,
	"absence_days" integer DEFAULT 0 NOT NULL,
	"leave_days" integer DEFAULT 0 NOT NULL,
	"paid" boolean DEFAULT false NOT NULL,
	"paid_on" date,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "wage_payments_amounts_check"
	  CHECK ("basic" >= 0 AND "allowances" >= 0 AND "overtime" >= 0 AND "deductions" >= 0)
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "wage_payments" ADD CONSTRAINT "wage_payments_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "wage_payments" ADD CONSTRAINT "wage_payments_wage_cycle_id_fk"
   FOREIGN KEY ("wage_cycle_id") REFERENCES "public"."wage_cycles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "wage_payments" ADD CONSTRAINT "wage_payments_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "wage_payments_cycle_employee_key"
  ON "wage_payments" USING btree ("wage_cycle_id", "employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wage_payments_employee_idx"
  ON "wage_payments" USING btree ("tenant_id", "employee_id");--> statement-breakpoint

-- ── HR-8: overtime by rate band ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "overtime_records" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"worked_on" date NOT NULL,
	"band" varchar(16) NOT NULL,
	"minutes" integer NOT NULL,
	-- 12500 is +25%. Integer basis points, never a float: this number is applied
	-- to every hour of every technician's month and then summed into a file a
	-- bank transfers and MOHRE audits.
	"multiplier_basis_points" integer NOT NULL,
	"hourly_rate" numeric(14, 2),
	"amount" numeric(14, 2),
	"rest_day_compensation" varchar(16),
	"substitute_day_on" date,
	"source" varchar(16) DEFAULT 'manual' NOT NULL,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "overtime_records_band_check"
	  CHECK ("band" IN ('standard', 'overtime', 'night', 'rest_day')),
	CONSTRAINT "overtime_records_source_check"
	  CHECK ("source" IN ('attendance', 'manual')),
	CONSTRAINT "overtime_records_minutes_check"
	  CHECK ("minutes" > 0 AND "minutes" <= 1440),
	-- The statutory multipliers are 100%, 125% and 150%. A row outside that
	-- range is either a typo or somebody paying below the statutory rate, and
	-- both are worth refusing at the point of insert.
	CONSTRAINT "overtime_records_multiplier_check"
	  CHECK ("multiplier_basis_points" BETWEEN 10000 AND 20000),
	CONSTRAINT "overtime_records_rest_day_check"
	  CHECK (
	    "rest_day_compensation" IS NULL
	    OR "rest_day_compensation" IN ('substitute_day', 'premium_pay')
	  ),
	-- A substitute day promised without a date is a day off nobody can prove was
	-- given. If the compensation is a substitute day, name the day.
	CONSTRAINT "overtime_records_substitute_check"
	  CHECK ("rest_day_compensation" <> 'substitute_day' OR "substitute_day_on" IS NOT NULL)
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "overtime_records" ADD CONSTRAINT "overtime_records_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "overtime_records" ADD CONSTRAINT "overtime_records_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "overtime_records" ADD CONSTRAINT "overtime_records_approved_by_id_fk"
   FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "overtime_records_day_band_key"
  ON "overtime_records" USING btree ("tenant_id", "employee_id", "worked_on", "band")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "overtime_records_period_idx"
  ON "overtime_records" USING btree ("tenant_id", "worked_on");--> statement-breakpoint

-- ── HR-6 and HR-16: the deduction that must be impossible ───────────────────
CREATE TABLE IF NOT EXISTS "salary_deductions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"wage_cycle_id" uuid,
	"kind" varchar(32) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	-- NOT NULL, and non-empty. A deduction from a protected wage with no stated
	-- reason is indistinguishable from an unlawful one when it is challenged,
	-- and it will be challenged: MOHRE decisions bind under AED 50,000.
	"reason" text NOT NULL,
	"authorised_by_id" uuid,
	"applies_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	-- ═══════════════════════════════════════════════════════════════════════
	-- THE CONSTRAINT THIS TABLE EXISTS FOR.
	--
	-- `HR-6`: the health insurance premium may not be deducted from salary.
	-- `HR-16`: recruitment and employment costs may never be recovered from a
	-- worker, directly or indirectly (Article 6).
	--
	-- Both requirements say "must be impossible", so this is a positive list.
	-- A negative list — `kind NOT IN ('health_insurance', ...)` — is defeated by
	-- the first person who types the premium in as "other", and that person
	-- exists. With a positive list there is no value that stores the premium,
	-- through the UI, through the ORM, or through psql.
	--
	-- Mirrored by `LAWFUL_DEDUCTION_KINDS` in packages/core/src/employment.ts,
	-- which produces the plain-language refusal naming the actual statute
	-- rather than "invalid value" — because "invalid value" teaches nobody
	-- anything and gets the amount recorded under a different label instead.
	-- ═══════════════════════════════════════════════════════════════════════
	CONSTRAINT "salary_deductions_kind_check" CHECK ("kind" IN (
	  'salary_advance_repayment',
	  'loan_repayment',
	  'unpaid_absence',
	  'disciplinary_fine',
	  'court_order',
	  'damage_recovery',
	  'social_security'
	)),
	CONSTRAINT "salary_deductions_amount_check" CHECK ("amount" > 0),
	CONSTRAINT "salary_deductions_reason_check"
	  CHECK (length(btrim("reason")) > 0)
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "salary_deductions" ADD CONSTRAINT "salary_deductions_tenant_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "salary_deductions" ADD CONSTRAINT "salary_deductions_employee_id_fk"
   FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "salary_deductions" ADD CONSTRAINT "salary_deductions_wage_cycle_id_fk"
   FOREIGN KEY ("wage_cycle_id") REFERENCES "public"."wage_cycles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "salary_deductions" ADD CONSTRAINT "salary_deductions_authorised_by_id_fk"
   FOREIGN KEY ("authorised_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "salary_deductions_employee_idx"
  ON "salary_deductions" USING btree ("tenant_id", "employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "salary_deductions_cycle_idx"
  ON "salary_deductions" USING btree ("tenant_id", "wage_cycle_id");
