-- =============================================================================
-- Password reset and invitation acceptance.
--
-- Run AFTER rls.sql.
--
-- Both flows are unauthenticated by definition — somebody who cannot sign in is
-- the entire audience — so they hit the same bootstrap problem as login and get
-- the same answer: a small, fixed set of SECURITY DEFINER functions, each doing
-- one step and returning the minimum.
--
-- The bar here is the same as public-functions.sql rather than auth-functions.
-- These are reachable by anyone holding a token from an email, so every
-- function below assumes the caller is hostile and holds a token they may have
-- found rather than been sent.
--
-- Rules carried over: pinned search_path on every function; return the minimum;
-- never trust a tenant id from the caller.
-- =============================================================================

-- ── Password reset ──────────────────────────────────────────────────────────

-- Look up a user by email for the purposes of issuing a reset.
--
-- Returns the id and nothing else. In particular it does NOT reveal whether the
-- address exists to the caller — the *route* returns the same generic response
-- either way, and this function returning zero rows is how that is implemented
-- rather than something the route has to remember to do.
CREATE OR REPLACE FUNCTION app_reset_find_user(p_email text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id
    FROM users u
   WHERE lower(u.email) = lower(p_email)
     AND u.deleted_at IS NULL
     -- Must have at least one active membership in an active tenant. A user
     -- with no way in should not be sent a link that lets them set a password
     -- they still cannot use.
     AND EXISTS (
       SELECT 1 FROM memberships m
         JOIN tenants t ON t.id = m.tenant_id
        WHERE m.user_id = u.id AND m.is_active AND t.is_active
     )
   LIMIT 1;
$$;

-- How many reset tokens has this user been issued recently?
--
-- Per-account throttling, separate from the per-IP limit on the route. Without
-- it, an attacker who knows an address can flood that person's inbox — which is
-- a nuisance attack, but also a good way to bury a real security email under
-- forty identical ones.
CREATE OR REPLACE FUNCTION app_reset_recent_count(p_user_id uuid, p_within_minutes integer)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::int
    FROM password_reset_tokens
   WHERE user_id = p_user_id
     AND created_at > now() - make_interval(mins => p_within_minutes);
$$;

CREATE OR REPLACE FUNCTION app_reset_issue(
  p_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_ip text
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, requested_ip)
  VALUES (p_user_id, p_token_hash, p_expires_at, p_ip)
  RETURNING id;
$$;

-- Resolve a token to the user it belongs to, without consuming it.
--
-- Used to decide whether to render the "set a new password" form at all. An
-- expired or already-used token returns nothing, so the form is never shown for
-- a link that cannot work — which is a better experience than accepting a new
-- password and then refusing it.
CREATE OR REPLACE FUNCTION app_reset_peek(p_token_hash text)
RETURNS TABLE (user_id uuid, email text, full_name text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.email::text, u.full_name::text
    FROM password_reset_tokens r
    JOIN users u ON u.id = r.user_id
   WHERE r.token_hash = p_token_hash
     AND r.consumed_at IS NULL
     AND r.expires_at > now()
     AND u.deleted_at IS NULL
   LIMIT 1;
$$;

-- Consume a token and set the password, atomically.
--
-- One function rather than two calls, because the gap between "check the token"
-- and "use the token" is a race an attacker with a copied link can win. The
-- UPDATE that consumes it is the guard: it matches only an unconsumed,
-- unexpired row, so a second concurrent attempt affects zero rows and the
-- function returns false without touching the password.
--
-- Also clears the lockout. Someone resetting their password after being locked
-- out has, by definition, proved control of the mailbox — leaving them locked
-- would send them to an administrator for no reason.
CREATE OR REPLACE FUNCTION app_reset_consume(p_token_hash text, p_password_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  UPDATE password_reset_tokens
     SET consumed_at = now()
   WHERE token_hash = p_token_hash
     AND consumed_at IS NULL
     AND expires_at > now()
  RETURNING user_id INTO v_user_id;

  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE users
     SET password_hash = p_password_hash,
         failed_login_count = 0,
         locked_until = NULL,
         updated_at = now()
   WHERE id = v_user_id;

  -- Every other live reset token for this user dies with the one just used.
  -- Two requests in a mailbox means the older link is either forgotten or in
  -- somebody else's hands, and neither is a reason to keep it working.
  UPDATE password_reset_tokens
     SET consumed_at = now()
   WHERE user_id = v_user_id
     AND consumed_at IS NULL;

  -- SEC-5: a password reset invalidates every existing session. If the reset
  -- was prompted by a compromise, leaving the attacker's session alive defeats
  -- the entire point of resetting.
  UPDATE sessions
     SET revoked_at = now()
   WHERE user_id = v_user_id
     AND revoked_at IS NULL;

  RETURN v_user_id;
END;
$$;

-- Housekeeping, called by /api/cron/sweep.
CREATE OR REPLACE FUNCTION app_reset_sweep(p_older_than_days integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  DELETE FROM password_reset_tokens
   WHERE expires_at < now() - make_interval(days => p_older_than_days);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Invitations ─────────────────────────────────────────────────────────────

-- Resolve an invitation token without accepting it.
DROP FUNCTION IF EXISTS app_invite_peek(text);

CREATE OR REPLACE FUNCTION app_invite_peek(p_token_hash text)
RETURNS TABLE (
  invitation_id uuid,
  tenant_id uuid,
  email text,
  full_name text,
  role text,
  brand_name text,
  customer_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.id, i.tenant_id, i.email::text, i.full_name::text, i.role::text, t.brand_name::text,
         i.customer_id
    FROM user_invitations i
    JOIN tenants t ON t.id = i.tenant_id
   WHERE i.token_hash = p_token_hash
     AND i.accepted_at IS NULL
     AND i.revoked_at IS NULL
     AND i.expires_at > now()
     AND t.is_active
   LIMIT 1;
$$;

-- Accept an invitation: create or reuse the user, set their password, create
-- the membership. Atomic, for the same reason `app_reset_consume` is.
--
-- Reusing an existing user by email is deliberate — one person may work for two
-- tenants, which is why `users` is global and `memberships` is the tenant
-- binding. Inviting an existing address must add a membership, not fail, and
-- must NOT overwrite the password of an account that already exists elsewhere.
CREATE OR REPLACE FUNCTION app_invite_accept(p_token_hash text, p_password_hash text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv record;
  v_user_id uuid;
  v_existing_password text;
BEGIN
  UPDATE user_invitations
     SET accepted_at = now(), updated_at = now()
   WHERE token_hash = p_token_hash
     AND accepted_at IS NULL
     AND revoked_at IS NULL
     AND expires_at > now()
  RETURNING id, tenant_id, email, full_name, role, customer_id INTO v_inv;

  IF v_inv.id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id, password_hash INTO v_user_id, v_existing_password
    FROM users WHERE lower(email) = lower(v_inv.email) AND deleted_at IS NULL;

  IF v_user_id IS NULL THEN
    INSERT INTO users (email, full_name, password_hash, email_verified_at)
    VALUES (v_inv.email, v_inv.full_name, p_password_hash, now())
    RETURNING id INTO v_user_id;
  ELSIF v_existing_password IS NULL THEN
    -- An account that exists but has never had a password — a customer contact
    -- promoted to staff, say. Setting one here is safe because there is no
    -- credential to overwrite.
    UPDATE users SET password_hash = p_password_hash, email_verified_at = now(), updated_at = now()
     WHERE id = v_user_id;
  END IF;
  -- Otherwise the account already has a password and keeps it. An invitation
  -- must never be a way to overwrite the credentials of an existing account:
  -- that would turn "invite an address you do not control" into account
  -- takeover.

  -- POR-8. `customer_id` carries through from the invitation, so a portal
  -- invitation produces a `customer` membership scoped to one customer and a
  -- staff invitation produces one scoped to none. Both halves are load-bearing:
  -- the role keeps a portal user out of the staff application, and the
  -- customer_id is what withCustomerScope() sets so the RESTRICTIVE policies
  -- narrow every query to that customer's rows.
  INSERT INTO memberships (tenant_id, user_id, role, customer_id, is_active, invited_at, accepted_at)
  VALUES (v_inv.tenant_id, v_user_id, v_inv.role, v_inv.customer_id, true, now(), now())
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET is_active = true,
                role = EXCLUDED.role,
                customer_id = EXCLUDED.customer_id,
                accepted_at = now(),
                updated_at = now();

  RETURN v_user_id;
END;
$$;

-- ── SEC-11: sliding sessions ────────────────────────────────────────────────
--
-- Extend a live session's expiry, bounded by its absolute cap.
--
-- `LEAST(..., absolute_expires_at)` is the whole safety property: the sliding
-- window can never push a session past the hard ceiling set when it was
-- created, so "sliding" cannot degrade into "never expires".
--
-- Only touches rows that are still live. A revoked or expired session is not
-- resurrected by activity on it.
CREATE OR REPLACE FUNCTION app_auth_touch_session(p_token_hash text, p_slide_seconds integer)
RETURNS timestamptz
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE sessions
     SET expires_at = LEAST(
           now() + make_interval(secs => p_slide_seconds),
           COALESCE(absolute_expires_at, now() + make_interval(secs => p_slide_seconds))
         ),
         last_seen_at = now()
   WHERE token_hash = p_token_hash
     AND revoked_at IS NULL
     AND expires_at > now()
     AND (absolute_expires_at IS NULL OR absolute_expires_at > now())
  RETURNING expires_at;
$$;

-- `app_auth_create_session` gains the absolute cap. DROP first: the argument
-- list changed, and CREATE OR REPLACE cannot do that.
DROP FUNCTION IF EXISTS app_auth_create_session(uuid, uuid, text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION app_auth_create_session(
  p_user_id uuid,
  p_tenant_id uuid,
  p_token_hash text,
  p_user_agent text,
  p_ip_address text,
  p_expires_at timestamptz,
  p_absolute_expires_at timestamptz
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO sessions (
    user_id, tenant_id, token_hash, user_agent, ip_address, expires_at, absolute_expires_at, last_seen_at
  )
  VALUES (
    p_user_id, p_tenant_id, p_token_hash, p_user_agent, p_ip_address,
    p_expires_at, p_absolute_expires_at, now()
  )
  RETURNING id;
$$;

-- The absolute cap has to be enforced on READ as well as on renewal. A session
-- whose sliding expiry is still in the future but whose absolute cap has passed
-- must not resolve.
DROP FUNCTION IF EXISTS app_auth_resolve_session(text);

CREATE OR REPLACE FUNCTION app_auth_resolve_session(p_token_hash text)
RETURNS TABLE (
  session_id uuid,
  expires_at timestamptz,
  absolute_expires_at timestamptz,
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
    s.absolute_expires_at,
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
    AND (s.absolute_expires_at IS NULL OR s.absolute_expires_at > now())
    AND m.is_active
    AND t.is_active
    AND u.deleted_at IS NULL
  LIMIT 1;
$$;

-- ── Grants ──────────────────────────────────────────────────────────────────
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'app_reset_find_user(text)',
    'app_reset_recent_count(uuid, integer)',
    'app_reset_issue(uuid, text, timestamptz, text)',
    'app_reset_peek(text)',
    'app_reset_consume(text, text)',
    'app_reset_sweep(integer)',
    'app_invite_peek(text)',
    'app_invite_accept(text, text)',
    'app_auth_touch_session(text, integer)',
    'app_auth_create_session(uuid,uuid,text,text,text,timestamptz,timestamptz)',
    'app_auth_resolve_session(text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO meridian_app', fn);
  END LOOP;
END
$$;

-- The application role must never touch these tables directly: the functions
-- above are the whole supported surface, and a direct UPDATE on
-- password_reset_tokens would let application code mark a token unconsumed.
REVOKE ALL ON public.password_reset_tokens FROM meridian_app;
GRANT SELECT ON public.user_invitations TO meridian_app;
