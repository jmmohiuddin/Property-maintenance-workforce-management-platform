-- =============================================================================
-- RLS isolation proof.
--
-- Run against a database that has had 0000_init.sql and rls.sql applied.
-- Every check raises an exception on failure, so a clean run means the tenant
-- boundary genuinely holds rather than merely being configured.
--
--   psql -d meridian_dev -v ON_ERROR_STOP=1 -f sql/verify-rls.sql
-- =============================================================================

\set QUIET on
SET client_min_messages TO warning;

-- ── Fixtures (as owner, RLS not yet in play) ────────────────────────────────
-- Fixtures are namespaced and every statement below is scoped to these two
-- tenant ids, so this script is safe to run against a database that already
-- holds real or seeded data. An earlier version deleted by customer code alone
-- and collided with a seeded customer that shared it.
DELETE FROM public.customers
 WHERE tenant_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
DELETE FROM public.tenants WHERE slug IN ('alpha-fm', 'beta-fm');

INSERT INTO public.tenants (id, slug, legal_name, brand_name)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alpha-fm', 'Alpha FM LLC', 'Alpha'),
  ('22222222-2222-2222-2222-222222222222', 'beta-fm',  'Beta FM LLC',  'Beta');

INSERT INTO public.customers (tenant_id, code, name)
VALUES
  ('11111111-1111-1111-1111-111111111111', '__RLSTEST_A',   'RLS fixture, tenant A'),
  ('22222222-2222-2222-2222-222222222222', '__RLSTEST_B', 'RLS fixture, tenant B');

-- Only the tables these checks touch. Deliberately NOT a blanket
-- `GRANT ON ALL TABLES` — that would re-open UPDATE on audit_log and make
-- check 8 pass or fail depending on statement order rather than on the policy.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenants, public.customers TO meridian_app;
GRANT SELECT, INSERT ON public.audit_log TO meridian_app;

-- ── Checks (as the application role) ────────────────────────────────────────
DO $$
DECLARE
  visible int;
  leaked  int;
BEGIN
  SET LOCAL ROLE meridian_app;

  -- 1. No tenant context → no rows. Not an error, not other tenants' data.
  PERFORM set_config('app.tenant_id', '', true);
  SELECT count(*) INTO visible FROM public.customers;
  IF visible <> 0 THEN
    RAISE EXCEPTION 'FAIL 1: % customer rows visible with no tenant context (expected 0)', visible;
  END IF;

  -- 2. Tenant A sees exactly its own row.
  PERFORM set_config('app.tenant_id', '11111111-1111-1111-1111-111111111111', true);
  SELECT count(*) INTO visible FROM public.customers;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'FAIL 2: tenant A sees % customers (expected 1)', visible;
  END IF;

  -- 3. Tenant A cannot see tenant B's row even when naming its id directly.
  SELECT count(*) INTO leaked FROM public.customers WHERE code = '__RLSTEST_B';
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'FAIL 3: tenant A read % of tenant B''s rows', leaked;
  END IF;

  -- 4. Tenant A cannot write a row stamped with tenant B's id (WITH CHECK).
  BEGIN
    INSERT INTO public.customers (tenant_id, code, name)
    VALUES ('22222222-2222-2222-2222-222222222222', 'SMUGGLED', 'Cross-tenant insert');
    RAISE EXCEPTION 'FAIL 4: cross-tenant INSERT was permitted';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;  -- expected
  END;

  -- 5. Tenant A cannot reassign its own row to tenant B.
  BEGIN
    UPDATE public.customers
       SET tenant_id = '22222222-2222-2222-2222-222222222222'
     WHERE code = '__RLSTEST_A';
    RAISE EXCEPTION 'FAIL 5: cross-tenant UPDATE was permitted';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;  -- expected
  END;

  -- 6. Tenant A cannot delete tenant B's row (invisible → zero rows affected).
  DELETE FROM public.customers WHERE code = '__RLSTEST_B';
  GET DIAGNOSTICS leaked = ROW_COUNT;
  IF leaked <> 0 THEN
    RAISE EXCEPTION 'FAIL 6: tenant A deleted % of tenant B''s rows', leaked;
  END IF;

  -- 7. Switching context switches the visible set, with no bleed-through.
  PERFORM set_config('app.tenant_id', '22222222-2222-2222-2222-222222222222', true);
  SELECT count(*) INTO visible FROM public.customers WHERE code = '__RLSTEST_B';
  IF visible <> 1 THEN
    RAISE EXCEPTION 'FAIL 7: tenant B cannot see its own row';
  END IF;

  -- 8. The audit log must be append-only, even for the app role.
  BEGIN
    UPDATE public.audit_log SET action = 'tampered' WHERE true;
    RAISE EXCEPTION 'FAIL 8: audit_log accepted an UPDATE';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;  -- expected
  END;

  RESET ROLE;
END
$$;

-- ── Structural checks ───────────────────────────────────────────────────────
DO $$
DECLARE
  unprotected text;
  bypasses    boolean;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO unprotected
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND (c.relrowsecurity = false OR c.relforcerowsecurity = false);

  IF unprotected IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL 9: tables with tenant_id but no forced RLS: %', unprotected;
  END IF;

  SELECT rolbypassrls INTO bypasses FROM pg_roles WHERE rolname = 'meridian_app';
  IF bypasses THEN
    RAISE EXCEPTION 'FAIL 10: meridian_app has BYPASSRLS — every policy above is decorative';
  END IF;
END
$$;

-- ── Customer-scope policies ─────────────────────────────────────────────────
DO $$
DECLARE
  permissive_ones text;
  secdef_unpinned text;
  unbounded_writes text;
  public_definers text;
BEGIN
  -- 11. Every customer_scope policy must be RESTRICTIVE. A PERMISSIVE policy is
  -- OR-ed with the tenant policy, so getting this wrong WIDENS access instead of
  -- narrowing it — and does so silently, since every query still works.
  SELECT string_agg(tablename, ', ') INTO permissive_ones
  FROM pg_policies
  WHERE schemaname = 'public' AND policyname = 'customer_scope'
    AND permissive <> 'RESTRICTIVE';

  IF permissive_ones IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL 11: customer_scope is PERMISSIVE on: %. A permissive policy widens access.',
      permissive_ones;
  END IF;

  -- 12. Every SECURITY DEFINER function must pin search_path, or a caller who
  -- controls search_path can shadow the tables it reads.
  SELECT string_agg(p.proname, ', ') INTO secdef_unpinned
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND NOT EXISTS (
      SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'
    );

  IF secdef_unpinned IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL 12: SECURITY DEFINER without a pinned search_path: %', secdef_unpinned;
  END IF;

  -- 13. An unbounded write check may only sit on a table that names no customer.
  --
  -- `customer-scope.sql` closes every unscoped table to portal reads, and lets
  -- the write check stay `true` where the table has no `customer_id` — those are
  -- the append-only ledgers a portal session must write but never read
  -- (`audit_log`, `notifications`).
  --
  -- A table that *does* carry `customer_id` and still has an unbounded write
  -- check is the dangerous combination: the database would accept a row naming
  -- somebody else's customer, and only application code would be standing in the
  -- way. The first run of this check found exactly that on `memberships` — the
  -- table that grants portal access — and on `user_invitations`.
  --
  -- The reason this is a permanent check and not a one-off fix: the failure it
  -- catches is a *future* one. Someone adds a portal feature that writes a
  -- customer-owned table, the backstop covers the read side, and nothing at all
  -- covers the write side. Nobody would see it. This will.
  SELECT string_agg(c.relname, ', ') INTO unbounded_writes
  FROM pg_policy p
  JOIN pg_class c ON c.oid = p.polrelid
  WHERE p.polname LIKE 'customer\_scope%'
    AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
    AND EXISTS (
      SELECT 1 FROM information_schema.columns col
       WHERE col.table_schema = 'public'
         AND col.table_name = c.relname
         AND col.column_name = 'customer_id'
    );

  IF unbounded_writes IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL 13: customer_scope has WITH CHECK (true) on customer-owned table(s): %. '
      'A portal session could write a row naming another customer.',
      unbounded_writes;
  END IF;

  -- 14. Every SECURITY DEFINER function is closed to PUBLIC.
  --
  -- These functions exist to cross the tenant boundary deliberately: they run as
  -- their owner, so RLS does not constrain them. That is the whole point of
  -- app_auth_resolve_session and its siblings, and it is why the last thing
  -- auth-functions.sql does is REVOKE ALL FROM PUBLIC and GRANT EXECUTE to
  -- meridian_app alone.
  --
  -- That grants loop sits at the FOOT of a 470-line file, and this check exists
  -- because of what happens when the file does not reach it. On 2026-08-22 the
  -- file aborted partway through, on a function referencing a table whose
  -- migration had not been applied yet. Every statement before the abort took
  -- effect; the grants block did not. The result was a database where every
  -- SECURITY DEFINER function in the authentication surface was executable by
  -- PUBLIC, and nothing anywhere said so.
  --
  -- That is the failure this catches: a half-applied auth file is
  -- indistinguishable from a complete one from the outside. The functions all
  -- exist, they all work, and the boundary they were built to enforce is simply
  -- not there. It is a worse state than an outright failure, because everything
  -- appears to run.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO public_definers
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.prosecdef
    -- Trigger functions are excluded: Postgres refuses a direct call to a
    -- function returning `trigger`, so an EXECUTE grant on one confers nothing.
    -- Flagging them would make this check noisy, and a noisy check is one people
    -- learn to scroll past -- which is how the thing it guards gets missed.
    AND p.prorettype <> 'trigger'::regtype
    AND has_function_privilege('public', p.oid, 'EXECUTE');

  IF public_definers IS NOT NULL THEN
    RAISE EXCEPTION
      'FAIL 14: SECURITY DEFINER function(s) executable by PUBLIC: %. '
      'These cross the tenant boundary by design. Re-run the whole sql/ list in '
      'README order — a mid-file abort leaves the grants block at the foot of '
      'auth-functions.sql unapplied, and nothing else reports it.',
      public_definers;
  END IF;
END
$$;

-- ── Cleanup ─────────────────────────────────────────────────────────────────
DELETE FROM public.customers
 WHERE tenant_id IN ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
DELETE FROM public.tenants WHERE slug IN ('alpha-fm', 'beta-fm');

\echo '── RLS verification: all 14 checks passed ──'
