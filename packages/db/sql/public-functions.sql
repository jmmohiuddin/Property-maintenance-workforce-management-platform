-- =============================================================================
-- The public surface.
--
-- Run AFTER rls.sql.
--
-- A visitor submitting the quote form on the marketing site has no session and
-- therefore no tenant context, but their enquiry has to land in a specific
-- tenant's lead queue. That is the same bootstrap problem authentication has,
-- and it gets the same answer: one narrow SECURITY DEFINER function rather than
-- a loosened policy.
--
-- Every addition here is a hole in the tenant boundary that an unauthenticated
-- visitor can reach, so the bar is much higher than for app_auth_*. There are
-- two functions, and the second earns its place by narrowing that surface
-- rather than widening it: without a rate limiter, the first function's caller
-- can be driven as fast as an attacker can send packets.
-- =============================================================================

-- Resolve a tenant slug to its id, for the public website only.
--
-- Returns nothing but the id: no name, no settings, no domain. A visitor
-- cannot enumerate tenants with this because they must already know the slug,
-- and knowing the slug reveals nothing they did not already have.
CREATE OR REPLACE FUNCTION app_public_resolve_tenant(p_slug text)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM tenants
   WHERE slug = p_slug
     AND is_active
     AND deleted_at IS NULL
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION app_public_resolve_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_resolve_tenant(text) TO meridian_app;

-- ── Rate limiting ───────────────────────────────────────────────────────────

-- The bucket table is written only through the function below.
--
-- ENABLE, deliberately not FORCE. A table with FORCE and no policy is
-- unwritable by everyone including this function's owner, which would make the
-- limiter fail on every call. ENABLE alone denies the application role - no
-- policy means no rows - while leaving the definer able to do its job.
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

-- The blanket grant in rls.sql names every table in the schema, including this
-- one. RLS already blocks it, but a limiter the limited party can reset is not
-- worth having, so the grant is withdrawn as well.
REVOKE ALL ON public.rate_limits FROM meridian_app;

-- Count one hit against a bucket and say whether it is still allowed.
--
-- The whole operation is a single INSERT ... ON CONFLICT so that concurrent
-- requests cannot interleave a read and a write and both conclude they were
-- under the limit. A read-then-update version of this is a race that lets N
-- simultaneous requests all pass a limit of 1.
--
-- A fixed window, not a sliding one: it is a few lines instead of a table of
-- timestamps per caller, and the worst case - twice the limit across a window
-- boundary - is irrelevant for a contact form. It would matter for a login,
-- which is why login throttling lives in app_auth_* against a real counter on
-- the user row instead.
CREATE OR REPLACE FUNCTION app_public_rate_limit(
  p_bucket text,
  p_limit integer,
  p_window_seconds integer
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hits integer;
  v_expired boolean;
BEGIN
  IF p_bucket IS NULL OR p_bucket = '' OR p_limit < 1 OR p_window_seconds < 1 THEN
    -- Refuse to silently allow everything on a malformed call.
    RAISE EXCEPTION 'app_public_rate_limit: invalid arguments';
  END IF;

  INSERT INTO rate_limits AS r (bucket, window_start, hits)
  VALUES (p_bucket, now(), 1)
  ON CONFLICT (bucket) DO UPDATE
     SET hits = CASE
                  WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN 1
                  ELSE r.hits + 1
                END,
         window_start = CASE
                  WHEN r.window_start < now() - make_interval(secs => p_window_seconds) THEN now()
                  ELSE r.window_start
                END
  RETURNING r.hits, r.window_start < now() - make_interval(secs => p_window_seconds)
       INTO v_hits, v_expired;

  RETURN v_hits <= p_limit;
END;
$$;

REVOKE ALL ON FUNCTION app_public_rate_limit(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_rate_limit(text, integer, integer) TO meridian_app;

-- Housekeeping. Buckets are tiny but unbounded in number, and nothing else
-- deletes them; an untended limiter table grows for the life of the site.
CREATE OR REPLACE FUNCTION app_public_rate_limit_sweep(p_older_than_seconds integer DEFAULT 86400)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_removed integer;
BEGIN
  DELETE FROM rate_limits
   WHERE window_start < now() - make_interval(secs => p_older_than_seconds);
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION app_public_rate_limit_sweep(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_public_rate_limit_sweep(integer) TO meridian_app;
