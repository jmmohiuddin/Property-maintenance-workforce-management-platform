-- =============================================================================
-- Row-Level Security, audit triggers and role grants.
--
-- Run AFTER `drizzle-kit migrate`. Drizzle owns table structure; this file owns
-- the security boundary, because policies are not expressible in the ORM and we
-- want them reviewed as security code rather than buried in a migration diff.
--
-- The model:
--   * `meridian_migrator` owns the tables and runs migrations.
--   * `meridian_app` is what the application connects as. It has NOBYPASSRLS,
--     is not the table owner, and therefore cannot escape these policies.
--   * Every tenant-scoped table forces RLS and filters on
--     `current_setting('app.tenant_id')`, set per transaction by withTenant().
--
-- The single most important line in this file is FORCE ROW LEVEL SECURITY.
-- Without it, policies are skipped for the table owner, and a deployment that
-- accidentally connects as the owner loses all isolation without any error.
-- =============================================================================

-- ── Roles ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_app') THEN
    CREATE ROLE meridian_app LOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE meridian_app NOBYPASSRLS;
ALTER ROLE meridian_app SET statement_timeout = '30s';
ALTER ROLE meridian_app SET idle_in_transaction_session_timeout = '60s';

GRANT USAGE ON SCHEMA public TO meridian_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO meridian_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO meridian_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO meridian_app;

-- ── Helpers ─────────────────────────────────────────────────────────────────

-- Returns NULL rather than raising when unset, so a query that runs outside a
-- tenant transaction returns zero rows instead of an error the caller might
-- catch and ignore. Silent-empty is the safer failure here: it breaks the
-- feature loudly in testing but never leaks across tenants in production.
CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- ── Tenant isolation policies ───────────────────────────────────────────────

-- Applies the same policy shape to every table carrying a tenant_id column, so
-- a table added later cannot be forgotten: re-run this block after migrating
-- and it covers anything new.
--
-- `audit_log` is excluded on purpose. The policy created here is FOR ALL, which
-- would permit UPDATE and DELETE on it; the append-only policies further down
-- are narrower and must be the only ones that table has.
DO $$
DECLARE
  t text;
  append_only text[] := ARRAY['audit_log'];
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenant_id'
      AND NOT a.attisdropped
      AND c.relname <> ALL (append_only)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        USING (tenant_id = app_current_tenant())
        WITH CHECK (tenant_id = app_current_tenant())
    $p$, t);

    RAISE NOTICE 'RLS enabled on %', t;
  END LOOP;
END
$$;

-- ── Tables without a tenant_id ──────────────────────────────────────────────

-- `tenants`: a session may only see its own tenant row.
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self ON public.tenants;
CREATE POLICY tenant_self ON public.tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- `users` is global by design (one person may work for several tenants), so it
-- is scoped by shared membership rather than by tenant_id. Login lookup by
-- email happens before a tenant is known and therefore runs through
-- withoutTenantBoundary() on a separate, narrowly-granted path.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_visible_to_shared_tenant ON public.users;
CREATE POLICY users_visible_to_shared_tenant ON public.users
  USING (
    id = app_current_user()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = users.id
        AND m.tenant_id = app_current_tenant()
    )
  );

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sessions_own ON public.sessions;
CREATE POLICY sessions_own ON public.sessions
  USING (user_id = app_current_user())
  WITH CHECK (user_id = app_current_user());

-- ── Second-factor tables ────────────────────────────────────────────────────
-- Both belong to a *user*, not a tenant, so the generic tenant_id loop above
-- either skips them or gets the boundary wrong:
--
--   * `user_recovery_codes` has no tenant_id at all, so the loop skipped it
--     entirely and it would have shipped with no policy on it.
--   * `mfa_challenges` does have one, so the loop gave it a tenant policy —
--     which would let any signed-in colleague read every challenge row in their
--     own tenant. The hashes are not usable without their preimage, but there
--     is no reason to hand them out.
--
-- Own-row policies for both, exactly like `sessions`. During login itself there
-- is no session and therefore no `app_current_user()`, so these rows are
-- unreachable from the application — which is why the `app_mfa_*` SECURITY
-- DEFINER functions exist.
ALTER TABLE public.user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_recovery_codes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recovery_codes_own ON public.user_recovery_codes;
CREATE POLICY recovery_codes_own ON public.user_recovery_codes
  USING (user_id = app_current_user())
  WITH CHECK (user_id = app_current_user());

ALTER TABLE public.mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mfa_challenges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.mfa_challenges;
DROP POLICY IF EXISTS mfa_challenges_own ON public.mfa_challenges;
CREATE POLICY mfa_challenges_own ON public.mfa_challenges
  USING (user_id = app_current_user())
  WITH CHECK (user_id = app_current_user());

-- ── Audit log: append-only ──────────────────────────────────────────────────
-- Defended twice, because each defence alone is one careless line from being
-- undone: the grant can be reopened by a later blanket GRANT ON ALL TABLES, and
-- a policy can be replaced by the generic loop above if someone removes the
-- exclusion. Both have to fail before the log becomes rewritable.
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.audit_log;

DROP POLICY IF EXISTS audit_read ON public.audit_log;
CREATE POLICY audit_read ON public.audit_log
  FOR SELECT USING (tenant_id = app_current_tenant());

DROP POLICY IF EXISTS audit_append ON public.audit_log;
CREATE POLICY audit_append ON public.audit_log
  FOR INSERT WITH CHECK (true);

-- ── Audit trigger ───────────────────────────────────────────────────────────
-- Records only changed columns. Writing this in the database rather than the
-- application means a direct SQL fix during an incident is still captured.

CREATE OR REPLACE FUNCTION app_audit_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  changed jsonb := '{}'::jsonb;
  k text;
  old_j jsonb;
  new_j jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    old_j := to_jsonb(OLD);
    new_j := to_jsonb(NEW);
    FOR k IN SELECT jsonb_object_keys(new_j) LOOP
      -- updated_at changes on every write; logging it adds noise, not evidence.
      IF k <> 'updated_at' AND (old_j -> k) IS DISTINCT FROM (new_j -> k) THEN
        changed := changed || jsonb_build_object(k, jsonb_build_object('old', old_j -> k, 'new', new_j -> k));
      END IF;
    END LOOP;

    IF changed = '{}'::jsonb THEN
      RETURN NEW;  -- nothing of substance changed
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    changed := jsonb_build_object('__new', to_jsonb(NEW));
  ELSE
    changed := jsonb_build_object('__old', to_jsonb(OLD));
  END IF;

  INSERT INTO public.audit_log (
    tenant_id, table_name, record_id, action, changed_fields,
    actor_id, actor_kind, request_id, occurred_at
  ) VALUES (
    app_current_tenant(),
    TG_TABLE_NAME,
    COALESCE((to_jsonb(COALESCE(NEW, OLD)) ->> 'id')::uuid, NULL),
    lower(TG_OP),
    changed,
    app_current_user(),
    COALESCE(NULLIF(current_setting('app.actor_kind', true), ''), 'user'),
    NULLIF(current_setting('app.request_id', true), ''),
    now()
  );

  RETURN COALESCE(NEW, OLD);
END
$$;

-- Attach to the tables where "who changed this and when" is actually asked.
-- Deliberately not every table: high-churn telemetry (technician_locations)
-- would swamp the log and drown the rows that matter.
DO $$
DECLARE
  t text;
  audited text[] := ARRAY[
    'jobs', 'job_visits', 'job_signoffs', 'quotes', 'quote_lines',
    'contracts', 'contract_visits', 'invoices', 'invoice_lines', 'payments',
    'customers', 'properties', 'assets', 'technicians', 'memberships', 'leave_requests',
    -- CON-11. The tender row stores its own outcome, reason and who decided it,
    -- so the FACT is recorded. What was not recorded is the change: who moved a
    -- bid from won to lost, and when. On a deadline-driven pipeline that is the
    -- history somebody asks for after the fact.
    'tenders'
  ];
BEGIN
  FOREACH t IN ARRAY audited LOOP
    IF EXISTS (SELECT 1 FROM pg_class WHERE relname = t AND relkind = 'r') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS audit_%1$s ON public.%1$I', t);
      EXECUTE format(
        'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON public.%1$I
           FOR EACH ROW EXECUTE FUNCTION app_audit_trigger()', t);
    END IF;
  END LOOP;
END
$$;

-- ── updated_at maintenance ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attname = 'updated_at' AND NOT a.attisdropped
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_%1$s ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER touch_%1$s BEFORE UPDATE ON public.%1$I
         FOR EACH ROW EXECUTE FUNCTION app_touch_updated_at()', t);
  END LOOP;
END
$$;

-- ── Final grant fixups ──────────────────────────────────────────────────────
-- Deliberately the LAST statement that touches privileges. The blanket
-- `GRANT ... ON ALL TABLES` near the top of this file also covers audit_log, so
-- revoking earlier would be silently undone by re-running that grant. sql/
-- verify-rls.sql check 8 fails if this ever regresses.
REVOKE UPDATE, DELETE ON public.audit_log FROM meridian_app;

-- ── Verification ────────────────────────────────────────────────────────────
-- Run after deploy. Any row returned is a table with a tenant_id that is not
-- protected, which is a release blocker.
--
--   SELECT c.relname
--   FROM pg_class c
--   JOIN pg_namespace n ON n.oid = c.relnamespace
--   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
--   WHERE n.nspname = 'public' AND c.relkind = 'r'
--     AND (c.relrowsecurity = false OR c.relforcerowsecurity = false);
--
-- And confirm the app role cannot bypass:
--   SELECT rolbypassrls FROM pg_roles WHERE rolname = 'meridian_app';  -- must be false
