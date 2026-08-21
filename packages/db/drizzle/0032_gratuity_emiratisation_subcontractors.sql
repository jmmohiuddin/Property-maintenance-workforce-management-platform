-- End-of-service gratuity, the Emiratisation denominator, and the
-- subcontractor register -- HR-13, HR-18, HR-19.
--
-- Three requirements, one migration, and they share a property worth stating
-- up front: each of them is a number or a date that somebody currently keeps in
-- their head, and each has a penalty attached in PRD section 11.3.
--
-- == HR-13: why there is no accrual table ===================================
--
-- Gratuity is a derivation from a service start date and a basic salary, both
-- of which already exist on employees. A stored running balance would drift
-- away from the formula the first time a salary was corrected retroactively,
-- and the stored one is what somebody would get paid. So the liability is
-- computed live by gratuityAccrual in packages/core, and the only thing that
-- becomes a row is the settlement -- a payment, on a date, of an amount
-- somebody authorised, against a statutory 14-day deadline.
--
-- The settlement freezes its own inputs. Every one of them moves afterwards:
-- the basic salary column gets edited, the contract terms get superseded, and
-- the whole employee record is purged two years after termination by HR-15. A
-- settlement that could only be recomputed from rows that no longer exist is
-- not evidence of anything.
--
-- Note the two money columns that look redundant and are not. basic_monthly is
-- the accrual base -- basic salary ONLY, allowances excluded by Article 51.
-- total_monthly_wage is the base for the two-years cap, and "wage" there
-- carries its Article 1 meaning of basic plus allowances. Two different bases
-- in one calculation. Storing one figure would make it impossible to say
-- afterwards which rule the settlement was computed under.
--
-- == HR-18: two columns, and the reason both are nullable ===================
--
-- Emiratisation targets apply to establishments with 50 or more SKILLED
-- employees, and skilled is a conjunction of three tests: ISCO occupational
-- major group 1-5, AND a post-secondary certificate, AND a salary of at least
-- AED 4,000 a month. The wage is already on employees. The other two are not
-- anywhere, which is why the owner dashboard reports raw headcount today with a
-- DASHBOARD_GAPS entry saying, correctly, that a contractor with 60 tradesmen
-- and 6 office staff is measured against the 6 and not the 66.
--
-- Both columns are NULLABLE and neither has a default, and that is the
-- load-bearing part of this migration rather than a convenience. NOT NULL with
-- a default would have to invent an occupational group for every employee who
-- already exists, and an invented group is indistinguishable from one somebody
-- chose. classifySkilledEmployee returns 'unknown' for a missing fact, and
-- assessEmiratisation counts the unknowns into the UPPER bound of the skilled
-- range -- so an unrecorded fact reads as "the threshold may already have been
-- crossed" rather than as a reassuring low number. HR-18 names that failure by
-- name: the mode is discovering the threshold was crossed a quarter ago.
--
-- The CHECK is 1..9 because ISCO-08 has nine major groups. It is deliberately
-- NOT 1..5: an employee in group 7 is a recorded fact that excludes them, and a
-- constraint that only admitted skilled groups would make the exclusion
-- unrepresentable and push every craft worker back into 'unknown'.
--
-- == HR-19: one register, not two ==========================================
--
-- Responsibility for site compliance does not transfer with the work. A
-- supplied worker on our site with an expired permit is our exposure under
-- Article 60 -- AED 100,000 to AED 1,000,000 -- as surely as an employee would
-- be. The expiries here follow the shape employee_documents and
-- company_accreditations already use, and are swept by the same compliance
-- cron rather than by a second mechanism.
--
-- PRJ-9 in the projects module describes the same organisation engaged against
-- a project scope with its own payment terms. That engagement points at a row
-- here; it does not grow its own copy of the organisation. Two registers that
-- disagreed about whether a licence was current would be worse than one.
--
-- Supplied workers are deliberately NOT employees. Recording them as employees
-- would put them in the payroll, the WPS wage file, the gratuity liability and
-- the Emiratisation denominator -- four places they do not belong.
--
-- == RLS ===================================================================
--
-- Three new tables, every one carrying tenant_id, so the generic loop in
-- sql/rls.sql covers them the next time it runs. Re-run the WHOLE sql/ list in
-- README order after this migration -- never rls.sql alone, because it ends
-- with a blanket GRANT that public-functions.sql then revokes for rate_limits.
-- Then confirm verify-rls reports 13/13.

-- == RE-RUNNABILITY ========================================================
--
-- Every statement in this file is guarded: CREATE ... IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS, and a duplicate_object guard around each ADD CONSTRAINT. The
-- README applies drizzle/*.sql in a glob against a fresh database, where none
-- of that is needed -- but an operator re-running a single migration after a
-- partial failure is the normal case, and a file that aborts halfway through on
-- "constraint already exists" leaves the schema in the state that produced the
-- failure. This one can be applied twice and the second run is a no-op.

-- == HR-18: the two facts the skilled test needs ============================
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "isco_major_group" smallint;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN IF NOT EXISTS "post_secondary_certificate" boolean;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "employees" ADD CONSTRAINT "employees_isco_major_group_check"
   CHECK ("isco_major_group" IS NULL OR ("isco_major_group" BETWEEN 1 AND 9));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The Emiratisation denominator's exact predicate. The skilled count is
-- recomputed on every render of the HR board and on every compliance cron run.
CREATE INDEX IF NOT EXISTS "employees_skilled_idx"
  ON "employees" USING btree ("tenant_id","isco_major_group","post_secondary_certificate")
  WHERE "status" = 'active' AND "deleted_at" IS NULL;--> statement-breakpoint

-- == HR-13: the settlement ==================================================
CREATE TABLE IF NOT EXISTS "gratuity_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	-- The day the relationship ended. The 14-day clock starts here.
	"terminated_on" date NOT NULL,
	-- Frozen. employees.contract_start is editable and this must not be.
	"service_start" date NOT NULL,
	"service_days" integer NOT NULL,
	"completed_years" integer NOT NULL,
	-- Basic salary ONLY. Housing, transport, utilities and furniture are
	-- excluded from the accrual by Article 51.
	"basic_monthly" numeric(14, 2) NOT NULL,
	-- Basic PLUS allowances. The base for the two-years cap, and nothing else.
	"total_monthly_wage" numeric(14, 2) NOT NULL,
	"uncapped_amount" numeric(14, 2) NOT NULL,
	"cap_amount" numeric(14, 2) NOT NULL,
	"gratuity_amount" numeric(14, 2) NOT NULL,
	-- terminated_on + 14 days, stored rather than derived for the same reason
	-- wage_cycles.due_on is: a statutory deadline that moved once can move
	-- again, and history must not move with it.
	"settlement_due_on" date NOT NULL,
	"paid_on" date,
	"payment_reference" varchar(64),
	"recorded_by_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	-- A settlement paid before the employment ended is a data-entry error, not
	-- an early payment.
	CONSTRAINT "gratuity_settlements_paid_after_termination" CHECK (
		"paid_on" IS NULL OR "paid_on" >= "terminated_on"
	),
	CONSTRAINT "gratuity_settlements_service_before_termination" CHECK (
		"service_start" <= "terminated_on"
	),
	-- The cap is a ceiling, so what is owed can never exceed it and can never
	-- exceed the uncapped figure either. Two comparisons, both >=, because the
	-- amount is allowed to EQUAL either one -- an uncapped settlement equals the
	-- uncapped figure, and a capped one equals the cap.
	CONSTRAINT "gratuity_settlements_amount_bounded" CHECK (
		"gratuity_amount" <= "uncapped_amount" AND "gratuity_amount" <= "cap_amount"
	)
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gratuity_settlements" ADD CONSTRAINT "gratuity_settlements_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "gratuity_settlements_employee_key"
  ON "gratuity_settlements" USING btree ("tenant_id","employee_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- The overdue sweep's exact predicate: unpaid settlements past their day.
CREATE INDEX IF NOT EXISTS "gratuity_settlements_due_idx"
  ON "gratuity_settlements" USING btree ("tenant_id","settlement_due_on")
  WHERE "paid_on" IS NULL AND "deleted_at" IS NULL;--> statement-breakpoint

-- == HR-19: the subcontractor register ======================================
CREATE TABLE IF NOT EXISTS "subcontractors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	-- A supplier of bodies is not a supplier of a scope. Different exposure.
	"kind" varchar(24) DEFAULT 'subcontractor' NOT NULL,
	"trade_slug" varchar(64),
	"contact_name" varchar(120),
	"contact_phone" varchar(32),
	"contact_email" varchar(160),
	-- Commercial Register number. Its expiry stops them trading, not just us.
	"trade_licence_no" varchar(64),
	"trade_licence_expires_on" date,
	"liability_insurer" varchar(120),
	"liability_policy_no" varchar(64),
	"liability_expires_on" date,
	"workmen_comp_insurer" varchar(120),
	"workmen_comp_policy_no" varchar(64),
	"workmen_comp_expires_on" date,
	-- Dubai Law No. 7 of 2025: prior approval is required to subcontract.
	"approval_reference" varchar(64),
	"status" varchar(16) DEFAULT 'provisional' NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "subcontractors_kind_check" CHECK ("kind" IN ('subcontractor', 'manpower_supplier')),
	CONSTRAINT "subcontractors_status_check" CHECK (
		"status" IN ('approved', 'provisional', 'suspended', 'withdrawn')
	)
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subcontractors" ADD CONSTRAINT "subcontractors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- Two facts about the ORGANISATION, added after the CREATE TABLE rather than
-- inside it so that re-running this file against a database that already has
-- the table still picks them up. CREATE TABLE IF NOT EXISTS is a no-op on an
-- existing table and would silently skip a column added to its body.
--
-- The TRN is 15 digits and is the same TRN_PATTERN packages/core enforces on a
-- tax invoice. It is here because the supplier's invoices to us carry it, and
-- INV-6 distinguishes a full tax invoice from a simplified one on exactly that
-- basis -- a supplier whose TRN we do not hold is one whose input tax we cannot
-- evidence.
--
-- `accreditations` is jsonb and company_accreditations is a table, and the
-- difference is not inconsistency. We control our own accreditations, renew
-- them and assign a renewal owner, so they get a kind vocabulary. We control
-- none of a supplier's third-party certifications and cannot enumerate the
-- issuing schemes in advance, so a vocabulary there would either reject a real
-- certificate or grow an `other` bucket that swallowed most of them.
--
-- NOT NULL DEFAULT '[]' rather than nullable: an empty list and an unrecorded
-- list are not usefully different for a free-form tail, and a nullable jsonb
-- array is the shape every reader forgets to null-check.
ALTER TABLE "subcontractors" ADD COLUMN IF NOT EXISTS "tax_registration_number" varchar(15);--> statement-breakpoint
ALTER TABLE "subcontractors" ADD COLUMN IF NOT EXISTS "accreditations" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- Fifteen digits or nothing. The same rule as invoices, enforced here too
-- because a TRN typed with a space in it is a TRN that silently fails to match
-- the supplier's invoice when somebody reconciles input tax.
DO $$ BEGIN
 ALTER TABLE "subcontractors" ADD CONSTRAINT "subcontractors_trn_check"
   CHECK ("tax_registration_number" IS NULL OR "tax_registration_number" ~ '^[0-9]{15}$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- A jsonb array, not an object or a bare string. Without this the column
-- accepts `{"name": ...}` and every reader that does `.map()` over it throws at
-- render time rather than at write time.
DO $$ BEGIN
 ALTER TABLE "subcontractors" ADD CONSTRAINT "subcontractors_accreditations_array"
   CHECK (jsonb_typeof("accreditations") = 'array');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "subcontractors_name_key"
  ON "subcontractors" USING btree ("tenant_id","name") WHERE "deleted_at" IS NULL;--> statement-breakpoint

-- Three expiries, one index each, the same predicate as
-- employee_documents_blocking_expiry_idx. Same question, different subject.
CREATE INDEX IF NOT EXISTS "subcontractors_licence_expiry_idx"
  ON "subcontractors" USING btree ("tenant_id","trade_licence_expires_on") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontractors_liability_expiry_idx"
  ON "subcontractors" USING btree ("tenant_id","liability_expires_on") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontractors_workmen_expiry_idx"
  ON "subcontractors" USING btree ("tenant_id","workmen_comp_expires_on") WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "subcontractor_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subcontractor_id" uuid NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"trade_slug" varchar(64),
	-- MOHRE work permit. Two-year standard validity, same as HR-5.
	"work_permit_no" varchar(64),
	"work_permit_expires_on" date,
	-- A recorded expiry is a claim by the supplier. A verification is a claim by
	-- us, with a name against it, and it is the second one an inspector asks
	-- for. Null means nobody has looked -- which is the state the register
	-- exists to make visible rather than the state it hides.
	"verified_by_id" uuid,
	"verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "subcontractor_workers" ADD CONSTRAINT "subcontractor_workers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontractor_workers" ADD CONSTRAINT "subcontractor_workers_subcontractor_id_fk" FOREIGN KEY ("subcontractor_id") REFERENCES "public"."subcontractors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subcontractor_workers" ADD CONSTRAINT "subcontractor_workers_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "subcontractor_workers_supplier_idx"
  ON "subcontractor_workers" USING btree ("tenant_id","subcontractor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subcontractor_workers_permit_expiry_idx"
  ON "subcontractor_workers" USING btree ("tenant_id","work_permit_expires_on")
  WHERE "is_active" AND "deleted_at" IS NULL;
