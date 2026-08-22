-- =============================================================================
-- Document-number allocation.
--
-- Run AFTER rls.sql and customer-scope.sql.
--
-- Why this is a SECURITY DEFINER function rather than application code:
--
--   1. **Customer scope blinds the count.** `createPortalRequest` runs inside
--      `withCustomerScope`, where the restrictive policy on `jobs` hides every
--      row belonging to another customer. Counting jobs there returns the
--      customer's own total, so the "next" number is one that another customer
--      in the same tenant has already used. The unique index catches it and the
--      request fails — which is exactly what happened the first time a customer
--      raised a request through the portal.
--
--   2. **Counting races.** Two dispatchers raising an invoice in the same second
--      both read the same count. One of them loses on the unique index.
--
-- The counter row turns allocation into a single atomic UPDATE, and running as
-- definer means the customer restriction cannot hide the counter.
--
-- Rejected alternatives:
--
--   * A Postgres sequence per tenant/prefix/year — sequences are DDL, so every
--     new tenant would need CREATE privileges at runtime, and gaps from rolled
--     back transactions would still occur without buying anything.
--   * A permissive policy letting portal users read all jobs in their tenant —
--     that would hand a customer every other customer's job titles to fix a
--     numbering problem.
--   * `max(reference)` instead of `count(*)` — same blindness, same race.
--
-- The number IS allowed to skip on rollback. A gap in invoice numbers is a
-- question an accountant can answer; a duplicate is one they cannot.
-- =============================================================================

-- Allocate the next reference for this tenant, prefix and year.
--
-- The tenant comes from the connection GUC, never from an argument: a caller
-- must not be able to allocate a number inside somebody else's tenant.
CREATE OR REPLACE FUNCTION app_next_reference(p_prefix text, p_year int)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tenant uuid := nullif(current_setting('app.tenant_id', true), '')::uuid;
  v_next   int;
  v_seed   int := 0;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'app.tenant_id is not set on this connection';
  END IF;

  IF p_prefix !~ '^[A-Z]{2,8}$' THEN
    RAISE EXCEPTION 'Reference prefix must be 2-8 upper-case letters, got %', p_prefix;
  END IF;

  -- Fast path: the counter already exists for this tenant/prefix/year. The row
  -- lock taken by UPDATE is what serialises concurrent allocation.
  UPDATE reference_counters
     SET last_value = last_value + 1,
         updated_at = now()
   WHERE tenant_id = v_tenant
     AND prefix = p_prefix
     AND year = p_year
  RETURNING last_value INTO v_next;

  IF FOUND THEN
    RETURN p_prefix || '-' || p_year || '-' || lpad(v_next::text, 5, '0');
  END IF;

  -- First allocation for this tenant/prefix/year. Start above anything already
  -- stored, so a database that was seeded (or migrated from the old counting
  -- scheme) does not hand out a number that is already on a document.
  CASE p_prefix
    WHEN 'JOB' THEN
      SELECT coalesce(max((regexp_match(reference, '(\d+)$'))[1]::int), 0) INTO v_seed
        FROM jobs
       WHERE tenant_id = v_tenant AND reference LIKE p_prefix || '-' || p_year || '-%';
    WHEN 'QUO' THEN
      SELECT coalesce(max((regexp_match(reference, '(\d+)$'))[1]::int), 0) INTO v_seed
        FROM quotes
       WHERE tenant_id = v_tenant AND reference LIKE p_prefix || '-' || p_year || '-%';
    WHEN 'INV' THEN
      SELECT coalesce(max((regexp_match(reference, '(\d+)$'))[1]::int), 0) INTO v_seed
        FROM invoices
       WHERE tenant_id = v_tenant AND reference LIKE p_prefix || '-' || p_year || '-%';
    -- M3. The seed writes demo contracts directly, so the first allocation
    -- after a seeded database must start above them or it hands out a number
    -- already printed on a signed contract.
    WHEN 'CON' THEN
      SELECT coalesce(max((regexp_match(reference, '(\d+)$'))[1]::int), 0) INTO v_seed
        FROM contracts
       WHERE tenant_id = v_tenant AND reference LIKE p_prefix || '-' || p_year || '-%';
    -- M9. Same reason as CON above, found the same way: the seed writes a demo
    -- requisition with REQ-2026-00001 already on it, so the first allocation
    -- after seeding collided on the unique index and the whole action failed.
    -- A prefix whose rows can pre-exist needs a branch here.
    WHEN 'REQ' THEN
      SELECT coalesce(max((regexp_match(reference, '(\d+)$'))[1]::int), 0) INTO v_seed
        FROM job_requisitions
       WHERE tenant_id = v_tenant AND reference LIKE p_prefix || '-' || p_year || '-%';
    WHEN 'APP' THEN
      SELECT coalesce(max((regexp_match(reference, '(\d+)$'))[1]::int), 0) INTO v_seed
        FROM applications
       WHERE tenant_id = v_tenant AND reference LIKE p_prefix || '-' || p_year || '-%';
    ELSE
      v_seed := 0;
  END CASE;

  -- ON CONFLICT rather than a plain INSERT: two transactions can reach this
  -- branch at the same moment, and the loser must increment rather than fail.
  INSERT INTO reference_counters (tenant_id, prefix, year, last_value)
  VALUES (v_tenant, p_prefix, p_year, v_seed + 1)
  ON CONFLICT (tenant_id, prefix, year)
  DO UPDATE SET last_value = reference_counters.last_value + 1,
                updated_at = now()
  RETURNING last_value INTO v_next;

  RETURN p_prefix || '-' || p_year || '-' || lpad(v_next::text, 5, '0');
END;
$$;

-- Only the application role. Nothing here is reachable without a session.
REVOKE ALL ON FUNCTION app_next_reference(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_next_reference(text, int) TO meridian_app;
