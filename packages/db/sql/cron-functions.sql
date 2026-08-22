-- =============================================================================
-- The scheduled-work surface.
--
-- Run AFTER rls.sql.
--
-- THE PROBLEM THIS SOLVES
--
-- A scheduled job runs with no session, and therefore with no tenant context.
-- It then has to do two things that are, by definition, outside the tenant
-- boundary: find out which tenants exist so it can loop over them, and delete
-- expired session rows belonging to nobody in particular.
--
-- The application role is NOBYPASSRLS, and that is the whole security model, so
-- it cannot simply read past the policies. `withoutTenantBoundary()` in
-- packages/db/src/index.ts does NOT grant an exemption — it only skips the
-- withTenant wrapper, which means the policies still apply and the query
-- silently returns zero rows. That is the correct failure (silent-empty rather
-- than cross-tenant disclosure), and it is exactly what happened the first time
-- these crons ran: every job reported `tenants: 0` and cheerfully did nothing.
--
-- THE ANSWER, WHICH IS THE SAME ONE AUTHENTICATION GOT
--
-- Two narrow SECURITY DEFINER functions with a pinned search_path, returning
-- the minimum, revoked from PUBLIC and granted only to the application role.
--
-- These are deliberately NOT in public-functions.sql. That file is documented
-- as the surface an unauthenticated visitor can reach, and its bar is higher
-- for exactly that reason. Nothing here is reachable without a database
-- connection, and in practice the only callers are the secret-gated
-- /api/cron/* routes.
-- =============================================================================

-- ── Enumerate tenants ───────────────────────────────────────────────────────
-- Returns ids and nothing else: no name, no slug, no settings. A caller that
-- gets an id still has to pass it to withTenant() and is then bounded by the
-- ordinary policies, so this widens enumeration and not access.
CREATE OR REPLACE FUNCTION app_cron_active_tenants()
RETURNS SETOF uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM tenants
   WHERE is_active
     AND deleted_at IS NULL
   ORDER BY created_at;
$$;

REVOKE ALL ON FUNCTION app_cron_active_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_cron_active_tenants() TO meridian_app;

-- ── Sweep dead sessions ─────────────────────────────────────────────────────
-- Hygiene rather than security: an expired session is already unusable, since
-- app_auth_resolve_session refuses it. Without this the table grows by one row
-- per sign-in forever.
--
-- The grace period keeps recent rows readable long enough to answer "was I
-- signed out, or did I sign out?" during an incident, which is a question that
-- gets asked and cannot be answered from a table that has been emptied.
--
-- Deletes only rows that are provably dead — expired past the grace window, or
-- explicitly revoked past it. A live session is untouchable through this path.
CREATE OR REPLACE FUNCTION app_cron_sweep_sessions(p_grace_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM sessions
   WHERE (expires_at < now() - make_interval(days => p_grace_days))
      OR (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => p_grace_days));

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION app_cron_sweep_sessions(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_cron_sweep_sessions(integer) TO meridian_app;

-- ── cron_runs grants ────────────────────────────────────────────────────────
-- `cron_runs` carries no tenant_id, so the generic RLS loop in rls.sql skips
-- it — correctly, because it holds no tenant data. The blanket
-- GRANT ... ON ALL TABLES near the top of rls.sql already covers it, and this
-- is here so the grant is explicit rather than incidental: a later tightening
-- of that blanket grant must not silently stop the scheduler recording its own
-- runs, which is the one thing that makes every other cron trustworthy.
GRANT SELECT, INSERT, UPDATE ON public.cron_runs TO meridian_app;

-- Deliberately no DELETE. The run ledger is evidence that the schedule fired;
-- pruning it is an administrative action, not something the application does.

-- ── Verification ────────────────────────────────────────────────────────────
-- As with app_auth_*: any SECURITY DEFINER function without a pinned
-- search_path is a privilege escalation waiting to happen. This must return
-- zero rows.
--
--   SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND NOT EXISTS (
--       SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'
--     );
