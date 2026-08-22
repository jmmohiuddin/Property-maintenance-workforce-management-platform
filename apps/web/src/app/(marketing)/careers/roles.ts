import "server-only";
import { listPublicRoles, getPublicRole } from "@meridian/db/domain";
import type { PublicRequisition } from "@meridian/core";

/**
 * Open roles for the careers site (`ATS-2`).
 *
 * ── WHY THIS WRAPPER EXISTS ─────────────────────────────────────────────────
 *
 * Two reasons, both about failing well on a public page.
 *
 * First, the tenant. `PUBLIC_TENANT_SLUG` is what says whose vacancies these
 * are, and it can be unset on a fresh deployment. An unset variable must not
 * produce a stack trace on the careers page — it must produce an empty list and
 * a log line, because the page around it still works and still tells a
 * tradesperson how to reach the company.
 *
 * Second, the database. `/careers` is a public marketing page, so a database
 * that is down should degrade it to the static content rather than 500 it. The
 * static half of the page — direct employment, WPS, tools provided — is true
 * whether or not there is a vacancy today, and it is what most visitors came
 * for.
 *
 * Both failure paths log loudly. A careers page that silently shows "no open
 * roles" while eleven requisitions are live is worse than one that errors,
 * because nothing ever surfaces it.
 */

async function tenantId(): Promise<string | null> {
  const slug = process.env["PUBLIC_TENANT_SLUG"];
  if (!slug) {
    console.error("[careers] PUBLIC_TENANT_SLUG is not set; no vacancies can be shown");
    return null;
  }

  const { resolvePublicTenantId } = await import("@meridian/db");
  const id = await resolvePublicTenantId(slug);
  if (!id) console.error(`[careers] no active tenant with slug "${slug}"`);
  return id;
}

export async function openRoles(): Promise<readonly PublicRequisition[]> {
  try {
    const id = await tenantId();
    if (!id) return [];
    return await listPublicRoles(id);
  } catch (error) {
    console.error("[careers] could not load open roles; showing the static page only", error);
    return [];
  }
}

export async function openRole(slug: string): Promise<PublicRequisition | null> {
  try {
    const id = await tenantId();
    if (!id) return null;
    return await getPublicRole(id, slug);
  } catch (error) {
    console.error(`[careers] could not load role "${slug}"`, error);
    return null;
  }
}
