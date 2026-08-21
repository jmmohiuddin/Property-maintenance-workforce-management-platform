-- =============================================================================
-- Customer scoping for the portal.
--
-- Run AFTER rls.sql.
--
-- THE PROBLEM
--
-- RLS gives us tenant isolation: a query with the wrong (or missing) tenant
-- context returns zero rows. But a customer-portal user is inside a tenant, and
-- must only see their OWN records. If that second boundary lives only in
-- application WHERE clauses, then one forgotten filter shows Customer A the
-- invoices of Customer B - which is precisely the failure mode RLS exists to
-- prevent, reintroduced one layer up.
--
-- THE APPROACH
--
-- A second transaction-local GUC, `app.customer_id`, and an additional
-- restriction on every table a portal user can reach.
--
--   * Unset (staff sessions): policies behave exactly as before. Nothing about
--     the dispatch board changes.
--   * Set (portal sessions): rows are additionally restricted to that customer.
--
-- The failure mode is the safe one in both directions. A portal query that
-- forgets its customer filter returns nothing; a staff query is unaffected
-- because the GUC is never set for staff.
--
-- These are RESTRICTIVE policies, deliberately. A permissive policy is OR-ed
-- with the existing tenant policy, which would *widen* access; restrictive
-- policies are AND-ed, which is what "and also belongs to this customer" means.
-- Getting this backwards would silently grant more access, not less.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_current_customer() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.customer_id', true), '')::uuid
$$;

-- ── Tables owned directly by a customer ─────────────────────────────────────
DO $$
DECLARE
  t text;
  -- Every table with a `customer_id` column that a portal user can reach.
  owned text[] := ARRAY[
    'properties', 'jobs', 'quotes', 'invoices', 'contracts', 'customer_contacts',
    -- INV-7. A credit note carries the customer's name, address, TRN and the
    -- amount of a dispute. It arrived with the tax-invoice work and would
    -- otherwise be visible tenant-wide to any portal session, because the
    -- generic loop in rls.sql grants tenant isolation and nothing narrower.
    'credit_notes'
  ];
BEGIN
  FOREACH t IN ARRAY owned LOOP
    EXECUTE format('DROP POLICY IF EXISTS customer_scope ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY customer_scope ON public.%I
        AS RESTRICTIVE
        USING (app_current_customer() IS NULL OR customer_id = app_current_customer())
        WITH CHECK (app_current_customer() IS NULL OR customer_id = app_current_customer())
    $p$, t);
  END LOOP;
END
$$;

-- `customers` is scoped by its own primary key rather than a customer_id column.
DROP POLICY IF EXISTS customer_scope ON public.customers;
CREATE POLICY customer_scope ON public.customers
  AS RESTRICTIVE
  USING (app_current_customer() IS NULL OR id = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR id = app_current_customer());

-- ── Child tables reached through a parent ───────────────────────────────────
-- These carry no customer_id, so they are scoped by an EXISTS against their
-- parent. Without this, a direct read of `quote_lines` would bypass the whole
-- scheme - the line rows are where the prices actually are.
DROP POLICY IF EXISTS customer_scope ON public.quote_lines;
CREATE POLICY customer_scope ON public.quote_lines
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1 FROM public.quotes q
                WHERE q.id = quote_lines.quote_id
                  AND q.customer_id = app_current_customer())
  );

DROP POLICY IF EXISTS customer_scope ON public.invoice_lines;
CREATE POLICY customer_scope ON public.invoice_lines
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1 FROM public.invoices i
                WHERE i.id = invoice_lines.invoice_id
                  AND i.customer_id = app_current_customer())
  );

DROP POLICY IF EXISTS customer_scope ON public.credit_note_lines;
CREATE POLICY customer_scope ON public.credit_note_lines
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1 FROM public.credit_notes n
                WHERE n.id = credit_note_lines.credit_note_id
                  AND n.customer_id = app_current_customer())
  );

DROP POLICY IF EXISTS customer_scope ON public.payments;
CREATE POLICY customer_scope ON public.payments
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1 FROM public.invoices i
                WHERE i.id = payments.invoice_id
                  AND i.customer_id = app_current_customer())
  );

DROP POLICY IF EXISTS customer_scope ON public.job_events;
CREATE POLICY customer_scope ON public.job_events
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1 FROM public.jobs j
                WHERE j.id = job_events.job_id
                  AND j.customer_id = app_current_customer())
  );

-- `job_visits` deliberately excluded: it carries technician identity and
-- assignment scoring, which is internal. The portal reads technician *name*
-- through a purpose-built query rather than by being granted the table.

-- ── Verification ────────────────────────────────────────────────────────────
-- Must return zero rows: every customer-scoped policy has to be RESTRICTIVE,
-- because a PERMISSIVE one would be OR-ed with the tenant policy and would
-- therefore widen access instead of narrowing it.
--
--   SELECT tablename, policyname, permissive
--   FROM pg_policies
--   WHERE schemaname = 'public' AND policyname = 'customer_scope'
--     AND permissive <> 'RESTRICTIVE';

-- =============================================================================
-- Phase 2: the tables the portal reaches for `POR-3`, `POR-4` and `POR-5`.
--
-- ── EXCLUSION IS NOT DENIAL ─────────────────────────────────────────────────
--
-- The note above says `job_visits` is "deliberately excluded" because it
-- carries technician identity. That reasoning is right about what the portal
-- should *see* and wrong about what leaving the table out actually does: a
-- table with no `customer_scope` policy is not closed to a portal session, it
-- is open to it **tenant-wide**. The generic loop in rls.sql gives every table
-- with a `tenant_id` its tenant policy and nothing narrower, so
-- `SELECT * FROM job_visits` inside `withCustomerScope` returns every
-- customer's visits, and the only thing standing between that and a leak is
-- that no query happened to be written yet.
--
-- Two exactly this shape shipped and were caught by reading the code rather
-- than by anything failing: `credit_notes` and `credit_note_lines` (above), and
-- a staff download route gated on permission alone. So the rule applied from
-- here is the opposite one — every table a portal session can name gets a
-- policy, and the policy decides whether the answer is "your rows" or "none".
--
-- `job_visits` gets "your rows" and not "none", because `POR-3` requires the
-- assigned visit window and the portal now legitimately needs it. What keeps
-- the internal parts internal is the projection in `getPortalRequestDetail`, which
-- selects the window and the technician's name and never the assignment score,
-- the override reason or the geofence result. The policy is the boundary; the
-- projection is the discretion. Both are needed and neither substitutes for the
-- other.
-- =============================================================================

-- ── Job children, scoped through the parent job ─────────────────────────────
DO $$
DECLARE
  t text;
  -- Every table keyed by `job_id` that a portal session can name. `POR-3` and
  -- `POR-9` put four of them on the request detail screen; `job_visits` is here
  -- for the reason argued above.
  via_job text[] := ARRAY[
    'job_visits', 'job_reports', 'job_attachments', 'job_signoffs', 'job_materials'
  ];
BEGIN
  FOREACH t IN ARRAY via_job LOOP
    -- Skipped rather than failed if the table is absent, so this file stays
    -- runnable against a database part-way through the migration set.
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = t AND relkind = 'r'
    );

    EXECUTE format('DROP POLICY IF EXISTS customer_scope ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY customer_scope ON public.%1$I
        AS RESTRICTIVE
        USING (
          app_current_customer() IS NULL
          OR EXISTS (SELECT 1 FROM public.jobs j
                      WHERE j.id = %1$I.job_id
                        AND j.customer_id = app_current_customer())
        )
    $p$, t);
  END LOOP;
END
$$;

-- ── CON-5. What the customer is entitled to ─────────────────────────────────
--
-- CON-5 requires the entitlement to be visible on the customer record and in
-- the portal, and the entitlement lives in contract_entitlements: visits per
-- year per service, and how many of them have been consumed. The parent
-- contracts table is already customer-scoped in the owned array above, so this
-- is the one additional table the portal needs, and it is scoped through that
-- parent the same way quote_lines and invoice_lines are.
--
-- USING only, no WITH CHECK. A portal session reads its entitlement and never
-- writes it — consumption is decremented by the reconcile sweep on a staff
-- transaction — so the backstop block below would be the only thing granting a
-- write, and it grants none: an unscoped table is closed. Adding a WITH CHECK
-- here would state a write path that does not exist.
--
-- ── WHAT IS DELIBERATELY LEFT CLOSED, AND WHY ───────────────────────────────
--
--   * contract_terms carries the discount rate and the payment terms. Those are
--     internal commercial positions, they are what an out-of-scope quote is
--     priced from, and CON-5 does not ask for them. It stays closed.
--   * contract_exclusions stays closed and does not need opening: the
--     customer-facing exclusion list is the JSONB column on contracts, which is
--     already portal-visible and is documented in the schema as the list shown
--     verbatim to the customer. The row table exists so CON-6 can match a code
--     by machine, which is an internal concern.
--   * contract_documents and contract_renewal_notices stay closed. Neither is
--     named by CON-5, and a renewal notice records which member of staff was
--     told what and when.
--
-- Each of those is closed by the backstop at the foot of this file rather than
-- by omission, which is the distinction the block above was written to make.
DROP POLICY IF EXISTS customer_scope ON public.contract_entitlements;
CREATE POLICY customer_scope ON public.contract_entitlements
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1 FROM public.contracts c
                WHERE c.id = contract_entitlements.contract_id
                  AND c.customer_id = app_current_customer())
  );

-- ── POR-5. Notification preferences ─────────────────────────────────────────
-- Owned directly by the customer, and written by them: a portal user turning an
-- event off is an INSERT or UPDATE from a portal session, so this one needs its
-- WITH CHECK as much as its USING. Without the check a tampered `customerId`
-- would let one customer switch off another's invoice notifications.
DROP POLICY IF EXISTS customer_scope ON public.customer_notification_preferences;
CREATE POLICY customer_scope ON public.customer_notification_preferences
  AS RESTRICTIVE
  USING (app_current_customer() IS NULL OR customer_id = app_current_customer())
  WITH CHECK (app_current_customer() IS NULL OR customer_id = app_current_customer());

-- ── Staff-only tables: closed to portal sessions entirely ───────────────────
--
-- These have no customer-facing reading at all, and "no policy" would leave
-- them tenant-wide to a portal session for the reason set out at the top of
-- this block. `app_current_customer() IS NULL` is the whole predicate: staff
-- (GUC unset) are unaffected, and a portal session sees zero rows however the
-- query is written.
--
--   * `leads` is the pre-sale pipeline — other people's enquiries, their phone
--     numbers, what they were quoted and why they were lost.
--   * `communications` is the internal record of what was said about a
--     customer, including the sentence a salesperson wrote about them. `LEAD-9`
--     asks for it to survive staff turnover, not to be published to the
--     customer it is about.
--   * `lead_disposition_reasons` is the vocabulary of why deals die.
DO $$
DECLARE
  t text;
  staff_only text[] := ARRAY['leads', 'communications', 'lead_disposition_reasons'];
BEGIN
  FOREACH t IN ARRAY staff_only LOOP
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM pg_class WHERE relname = t AND relkind = 'r'
    );

    EXECUTE format('DROP POLICY IF EXISTS customer_scope ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY customer_scope ON public.%I
        AS RESTRICTIVE
        USING (app_current_customer() IS NULL)
        WITH CHECK (app_current_customer() IS NULL)
    $p$, t);
  END LOOP;
END
$$;

-- ── The technician who came to your property ────────────────────────────────
--
-- `POR-3` shows "Yusuf is on his way" and names who attended, so a portal
-- session has to read `technicians`. The generic backstop below would close it,
-- and closing it does not merely hide a name — the visit query inner-joins this
-- table, so an invisible technician silently removes the whole visit and the
-- customer's appointment window disappears. That is how a blanket denial turns
-- a privacy control into a missing feature.
--
-- The scope is therefore "a technician who has been sent to one of your jobs",
-- not "any technician in the tenant". A customer cannot enumerate the workforce
-- by asking; they can see the people who came to their own property.
--
-- Rows, not columns: this policy decides which technicians are visible, and the
-- projection in `getPortalRequestDetail` is what keeps `assignment_score` and
-- the geofence internal. Both are needed and they are not substitutes.
DROP POLICY IF EXISTS customer_scope ON public.technicians;--> statement-breakpoint
CREATE POLICY customer_scope ON public.technicians
  AS RESTRICTIVE
  USING (
    app_current_customer() IS NULL
    OR EXISTS (SELECT 1
                 FROM job_visits v
                 JOIN jobs j ON j.id = v.job_id
                WHERE v.technician_id = technicians.id
                  AND j.customer_id = app_current_customer())
  )
  WITH CHECK (app_current_customer() IS NULL);

-- ── EVERYTHING ELSE IS CLOSED TO A PORTAL SESSION ───────────────────────────
--
-- The generic backstop, and the most important block in this file.
--
-- The rule this closes was found the expensive way. `job_visits` carried a
-- comment saying it was "deliberately excluded" from customer scope because it
-- holds technician identity — which was right about what the portal should see
-- and wrong about what exclusion does. A table with no `customer_scope` policy
-- is not closed to a portal session. It is open **tenant-wide**, because the
-- generic loop in `rls.sql` gives it tenant isolation and nothing narrower. The
-- omission that was meant to withhold a table was publishing it.
--
-- Seven more tables had the same hole. Fixing those seven fixed the instances
-- and left the cause: a table is exposed unless somebody remembers, and the
-- someone is a different person on a different stream every week. At the time
-- this was written there were fifty tenant-scoped tables with no customer scope
-- — `employees`, `wage_payments`, `salary_deductions`, `candidates`,
-- `sessions`, `notifications`, `audit_log` among them. None of them had a
-- portal query today. "No query today" is not an access control.
--
-- So the default is inverted here. Any tenant-scoped table that has not been
-- given an explicit scope above is closed to a portal session outright, and a
-- table added next month is closed before anyone has thought about it. Opening
-- one is then a deliberate act: add it to a list above and say why.
--
-- ── THE WRITE SIDE, WHICH IS NOT UNIFORM ────────────────────────────────────
--
-- Reads are the disclosure risk and every table here is closed to them. Writes
-- split in two, on whether the table names a customer:
--
--   * **No `customer_id` column** — the check is `true`. A portal session
--     legitimately writes rows to tables it must never read: accepting a quote
--     appends to `audit_log` and enqueues a `notification`. Repeating the USING
--     expression there would break the portal, which is closing a hole by
--     deleting the feature. RESTRICTIVE policies are ANDed, so a `true` check
--     adds nothing and leaves `tenant_isolation`'s own check in force.
--
--   * **Has a `customer_id` column** — the check is the staff test. A table
--     that names a customer and is not explicitly scoped above is one no portal
--     session has any business writing, and leaving it at `true` means the
--     database would accept a row naming *another* customer. `memberships` is
--     the one that makes this concrete: it carries `customer_id` and it is how
--     portal access is granted, so an unbounded write check is the difference
--     between "no code path does that today" and "the database would refuse".
--     Only the second survives the next feature.
--
-- The split was not designed. `WITH CHECK (true)` was applied uniformly first,
-- and the invariant below — an unbounded write check may only sit on a table
-- with no `customer_id` — was suggested as a way to detect the mistake. It
-- found `memberships` and `user_invitations` on its first run.
-- ── WHY THE BACKSTOP POLICY HAS ITS OWN NAME ────────────────────────────────
--
-- `customer_scope_default`, not `customer_scope`. The two names are what let
-- this block be re-runnable without either clobbering the explicit policies
-- above or being defeated by its own previous output.
--
-- Named the same, the loop had to skip any table that already had a policy —
-- which meant it skipped tables carrying a *stale or wrong* one, and re-running
-- the file could not repair them. That was found by mutation-testing check 13:
-- a deliberately bad policy was written onto `memberships`, the check caught it
-- correctly, and then re-applying this file did not put it back. A security file
-- that cannot restore the state it declares is a file you cannot trust after an
-- incident, which is the one moment you need to.
--
-- With separate names the loop owns its own policies outright: it drops and
-- recreates `customer_scope_default` every run, and never touches a
-- `customer_scope` written by hand above.
--
-- ── AND WHY IT DROPS FIRST AND DECIDES SECOND ───────────────────────────────
--
-- The loop walks every tenant-scoped table and unconditionally drops its
-- `customer_scope_default`, then creates one again only where no explicit
-- `customer_scope` exists. An earlier version selected only the tables without
-- an explicit policy, which meant a table PROMOTED from closed to scoped kept
-- the backstop it was given on the previous run — and because restrictive
-- policies are ANDed, `USING (app_current_customer() IS NULL)` went on refusing
-- every portal read regardless of the new policy sitting beside it.
--
-- That was found by opening `contract_entitlements` for `CON-5`: the explicit
-- policy applied cleanly, the portal query returned nothing, and both policies
-- were present and correct on their own terms. The promotion direction is the
-- one this file will keep being asked for — a table is closed by default and
-- opened when a requirement names it — so it is the direction that has to be
-- re-runnable.
DO $$
DECLARE
  t text;
  has_explicit boolean;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'tenant_id')
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS customer_scope_default ON public.%I', t);

    SELECT EXISTS (
      SELECT 1 FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND p.polname = 'customer_scope'
    ) INTO has_explicit;

    -- Scoped by hand above. The backstop stays off, and this is the branch the
    -- old loop could not reach on a table that already had one.
    CONTINUE WHEN has_explicit;

    -- Named-customer tables are closed to portal writes as well as reads.
    IF EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_schema = 'public'
                  AND col.table_name = t
                  AND col.column_name = 'customer_id') THEN
      EXECUTE format($p$
        CREATE POLICY customer_scope_default ON public.%I
          AS RESTRICTIVE
          USING (app_current_customer() IS NULL)
          WITH CHECK (app_current_customer() IS NULL)
      $p$, t);
      RAISE NOTICE 'customer scope: % closed to portal sessions (reads and writes)', t;
    ELSE
      EXECUTE format($p$
        CREATE POLICY customer_scope_default ON public.%I
          AS RESTRICTIVE
          USING (app_current_customer() IS NULL)
          WITH CHECK (true)
      $p$, t);
      RAISE NOTICE 'customer scope: % closed to portal reads', t;
    END IF;
  END LOOP;
END
$$;
