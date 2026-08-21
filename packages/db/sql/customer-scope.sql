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
