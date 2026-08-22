-- Sick leave, and the leave vocabulary it depends on — `HR-7`, `HR-8`.
--
-- 0015 built the employment lifecycle: contract terms, leave balances, overtime
-- by rate band, the WPS wage cycle. Annual leave came with it. Sick leave did
-- not, and sick leave is the half of `HR-7` with three different rates in it:
-- after probation, 15 days at full pay, then 30 at half pay, then 45 unpaid,
-- 90 days in all per leave year.
--
-- ── WHY THERE IS NO `sick_leave` TABLE HERE ─────────────────────────────────
--
-- Because `leave_requests` already exists and the dispatcher already reads it.
-- A second, employee-keyed home for absence would produce two calendars that
-- disagree about who is at work — and the one the dispatcher does not read is
-- the one that sends a technician to a job on the day they were signed off
-- sick. Sick leave is a `kind` on the row that already means "this person is
-- not available", which is also why `assignment.ts` treats it as hard
-- unavailability without a line of new code.
--
-- ── WHAT THIS MIGRATION ACTUALLY CHANGES ────────────────────────────────────
--
-- `leave_requests.kind` has been an unconstrained `varchar(32)` since 0000,
-- defaulting to 'annual'. That was harmless while nothing read it. It stops
-- being harmless the moment entitlement arithmetic keys off it: the sick-leave
-- ladder counts the rows whose kind is exactly 'sick', so a day recorded as
-- 'Sick' or 'sick_leave' is a day the ladder never sees. The employee then
-- reads as having more of the 90 statutory days left than they do, and the
-- fifteenth day of full pay gets paid at full pay twice.
--
-- So the column gets a CHECK against the vocabulary in
-- `packages/core/src/employment.ts` (`LEAVE_KINDS`). Same three-place
-- agreement as the deduction list: the constant, the domain layer, and the
-- constraint that makes it true through `psql` as well as through a form.
--
-- ── EXISTING ROWS ───────────────────────────────────────────────────────────
--
-- A CHECK added to a populated column is validated against every row in it, so
-- the normalisation below has to come first and has to be total. It does three
-- things, in order: lowercase and trim, map the spellings a human would
-- plausibly have typed onto the vocabulary, and put everything still unmatched
-- into 'other'.
--
-- 'other' is on the vocabulary for exactly that last step, and it is worth
-- saying why, because `salary_deductions.kind` deliberately has no such escape
-- hatch. There, an unlisted value is an unlawful deduction wearing a different
-- label and the positive list is what makes the prohibition true. Here a kind
-- is a classification and not a permission — nothing is authorised by it — and
-- the alternative to 'other' is guessing. A legacy row silently relabelled
-- 'annual' moves somebody's leave balance; relabelled 'sick' it moves their
-- sick-pay ladder. 'other' moves neither and is visibly unclassified.
--
-- On a database seeded from `packages/db/src/seed.ts` every row is already
-- 'annual' and none of these statements change anything.
--
-- One assumption worth stating, because it is load-bearing: `leave_requests`
-- has FORCE ROW LEVEL SECURITY, so the normalisation only reaches every row if
-- the role applying migrations bypasses RLS — a superuser, which is how the
-- README applies them. Applied as a non-bypassing role the UPDATEs would see
-- no rows and silently change nothing. That failure is loud rather than quiet:
-- ADD CONSTRAINT validates against the whole table regardless of RLS, so the
-- migration aborts on the first row it could not reach instead of leaving a
-- half-normalised column behind.
--
-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- No new table, so no new policy: `leave_requests` is already covered by the
-- generic loop in `sql/rls.sql` and is one of the tables named in the audit
-- trigger list. Re-run the `sql/` files in README order after this migration
-- anyway — never `rls.sql` alone, because it ends with a blanket GRANT that
-- `public-functions.sql` then revokes for `rate_limits`.

-- ── Normalise, before the constraint can reject anything ────────────────────
UPDATE "leave_requests" SET "kind" = lower(btrim("kind"))
 WHERE "kind" IS DISTINCT FROM lower(btrim("kind"));--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'annual'
 WHERE "kind" IN ('annual_leave', 'holiday', 'holidays', 'vacation', 'al');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'sick'
 WHERE "kind" IN ('sick_leave', 'sickness', 'illness', 'medical', 'medical_leave');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'maternity'
 WHERE "kind" IN ('maternity_leave', 'maternity');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'parental'
 WHERE "kind" IN ('parental_leave', 'paternity', 'paternity_leave');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'bereavement'
 WHERE "kind" IN ('bereavement_leave', 'compassionate', 'compassionate_leave');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'hajj'
 WHERE "kind" IN ('pilgrimage', 'umrah', 'hajj_leave');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'study'
 WHERE "kind" IN ('study_leave', 'exam', 'exams', 'examination');--> statement-breakpoint

UPDATE "leave_requests" SET "kind" = 'unpaid'
 WHERE "kind" IN ('unpaid_leave', 'leave_without_pay', 'lwop', 'no_pay');--> statement-breakpoint

-- Anything still unrecognised. Visibly unclassified beats confidently wrong.
UPDATE "leave_requests" SET "kind" = 'other'
 WHERE "kind" NOT IN (
   'annual', 'sick', 'maternity', 'parental', 'bereavement', 'hajj', 'study', 'unpaid', 'other'
 );--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_kind_check"
   CHECK ("kind" IN (
     'annual', 'sick', 'maternity', 'parental', 'bereavement', 'hajj', 'study', 'unpaid', 'other'
   ));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

-- The sick-leave ladder's exact predicate: one technician's approved leave of
-- one kind, from the start of their leave year. Without it, staging a single
-- absence scans every leave row the tenant has ever recorded — and the ladder
-- is walked once per employee on every render of the HR board.
CREATE INDEX IF NOT EXISTS "leave_requests_kind_idx"
  ON "leave_requests" USING btree ("tenant_id", "technician_id", "kind", "starts_on")
  WHERE "deleted_at" IS NULL;
