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
-- This file holds exactly one function and should stay that way. Every addition
-- here is a hole in the tenant boundary that an unauthenticated visitor can
-- reach, so the bar is much higher than for app_auth_*.
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
