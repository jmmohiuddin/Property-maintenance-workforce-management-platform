-- =============================================================================
-- The authentication surface.
--
-- Run AFTER rls.sql.
--
-- THE PROBLEM THIS SOLVES
--
-- RLS scopes every read to `current_setting('app.tenant_id')`. Authentication
-- has to happen *before* a tenant is known - that is the whole point of logging
-- in - so the login query has no tenant context and the `users` policy matches
-- zero rows. Login by email is therefore impossible under RLS as written. This
-- is not a flaw in the policy; it is a genuine bootstrap problem that every
-- RLS-based system has to answer somehow.
--
-- THE ANSWERS WE REJECTED
--
--   * Loosen the users policy so "no tenant context" means "see everything".
--     This inverts the safe default: the failure mode of a forgotten
--     withTenant() becomes full disclosure instead of zero rows.
--   * Connect as a superuser for auth. Bypasses RLS for the whole connection,
--     which is exactly the misconfiguration assertNotBypassingRls() exists to
--     catch.
--   * A second database role for auth. Workable, but it moves the boundary
--     into connection-string configuration, where it is invisible to review.
--
-- THE ANSWER WE CHOSE
--
-- A small, fixed set of SECURITY DEFINER functions. Each one does exactly one
-- authentication step and returns only the columns that step needs. They run
-- with the definer's privileges, so they see past RLS - but they are the ONLY
-- way the application can do so, they are enumerable (\df app_auth_*), and each
-- one is short enough to read in full during a security review.
--
-- Rules for anything added here:
--   1. SET search_path = public on every function. Without it, a caller who
--      controls search_path can shadow `users` with their own table and change
--      what the function does.
--   2. Return the minimum. Never `SELECT *` - a column added to `users` later
--      must not silently start flowing out of the auth path.
--   3. No function may take a tenant_id from the caller and trust it.
-- =============================================================================

-- ── Look up a user by email, with their memberships ─────────────────────────
-- Returns one row per membership, or one row with NULL membership columns when
-- the user exists but belongs to no tenant. Zero rows means no such user.
CREATE OR REPLACE FUNCTION app_auth_lookup(p_email text)
RETURNS TABLE (
  user_id uuid,
  password_hash text,
  failed_login_count text,
  mfa_enabled boolean,
  tenant_id uuid,
  role text,
  membership_active boolean,
  tenant_active boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id,
    u.password_hash,
    u.failed_login_count,
    (u.mfa_enabled_at IS NOT NULL),
    m.tenant_id,
    m.role::text,
    m.is_active,
    t.is_active
  FROM users u
  LEFT JOIN memberships m ON m.user_id = u.id
  LEFT JOIN tenants t ON t.id = m.tenant_id
  WHERE lower(u.email) = lower(p_email)
    AND u.deleted_at IS NULL
$$;

-- ── Record the outcome of an attempt ────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_auth_record_failure(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users
     SET failed_login_count = (COALESCE(NULLIF(failed_login_count, '')::int, 0) + 1)::text,
         updated_at = now()
   WHERE id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION app_auth_record_success(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE users
     SET failed_login_count = '0',
         last_login_at = now(),
         updated_at = now()
   WHERE id = p_user_id;
$$;

-- ── Sessions ────────────────────────────────────────────────────────────────
-- The raw token never reaches the database; only its SHA-256 hash does.
CREATE OR REPLACE FUNCTION app_auth_create_session(
  p_user_id uuid,
  p_tenant_id uuid,
  p_token_hash text,
  p_user_agent text,
  p_ip_address text,
  p_expires_at timestamptz
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO sessions (user_id, tenant_id, token_hash, user_agent, ip_address, expires_at)
  VALUES (p_user_id, p_tenant_id, p_token_hash, p_user_agent, p_ip_address, p_expires_at)
  RETURNING id;
$$;

-- Resolves a token to everything the application needs to build a principal.
-- Deliberately enforces the liveness conditions in SQL (not revoked, not
-- expired, membership active, tenant active) so a caller cannot forget one.
CREATE OR REPLACE FUNCTION app_auth_resolve_session(p_token_hash text)
RETURNS TABLE (
  session_id uuid,
  expires_at timestamptz,
  user_id uuid,
  full_name text,
  email text,
  tenant_id uuid,
  brand_name text,
  role text,
  overrides jsonb,
  customer_id uuid,
  technician_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    s.id,
    s.expires_at,
    u.id,
    u.full_name::text,
    u.email::text,
    t.id,
    t.brand_name::text,
    m.role::text,
    m.permission_overrides,
    m.customer_id,
    tech.id
  FROM sessions s
  JOIN users u       ON u.id = s.user_id
  JOIN tenants t     ON t.id = s.tenant_id
  JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
  LEFT JOIN technicians tech
         ON tech.tenant_id = s.tenant_id
        AND tech.user_id = s.user_id
        AND tech.is_active
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND m.is_active
    AND t.is_active
    AND u.deleted_at IS NULL
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION app_auth_revoke_session(p_token_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sessions SET revoked_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION app_auth_revoke_all_sessions(p_user_id uuid, p_except uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  -- `p_except` keeps one session alive: the one the user is revoking from.
  -- Passing NULL revokes everything, which is what a compromise needs.
  UPDATE sessions SET revoked_at = now()
   WHERE user_id = p_user_id
     AND revoked_at IS NULL
     AND (p_except IS NULL OR id <> p_except);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
-- EXECUTE is public by default on new functions, which would let any role call
-- them. Lock that down and grant explicitly.
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app_auth_lookup(text)',
    'app_auth_record_failure(uuid)',
    'app_auth_record_success(uuid)',
    'app_auth_create_session(uuid,uuid,text,text,text,timestamptz)',
    'app_auth_resolve_session(text)',
    'app_auth_revoke_session(text)',
    'app_auth_revoke_all_sessions(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO meridian_app', fn);
  END LOOP;
END
$$;

-- ── Verification ────────────────────────────────────────────────────────────
-- Any SECURITY DEFINER function without a pinned search_path is a privilege
-- escalation waiting to happen. This must return zero rows.
--
--   SELECT p.proname
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.prosecdef
--     AND NOT EXISTS (
--       SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%'
--     );
