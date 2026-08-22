import "server-only";
import type { PublicRateCardRow } from "@meridian/db/domain";

/**
 * The published schedule of rates, for `/rates` (`WEB-16`).
 *
 * Same shape of guard as `../careers/roles.ts`, and for the same two reasons.
 *
 * First, the tenant. `PUBLIC_TENANT_SLUG` says whose rate card this is, and it
 * can be unset on a fresh deployment — that must produce an empty schedule and
 * a log line, not a stack trace on a public page.
 *
 * Second, the database. `/rates` is a public marketing page; if the database is
 * down, the page should degrade to its static explanatory copy (what the bands
 * mean, VAT treatment, materials) rather than 500. A visitor who cannot see
 * today's numbers should still be able to read the page and call.
 */
async function tenantId(): Promise<string | null> {
  const slug = process.env["PUBLIC_TENANT_SLUG"];
  if (!slug) {
    console.error("[rates] PUBLIC_TENANT_SLUG is not set; no rates can be shown");
    return null;
  }

  const { resolvePublicTenantId } = await import("@meridian/db");
  const id = await resolvePublicTenantId(slug);
  if (!id) console.error(`[rates] no active tenant with slug "${slug}"`);
  return id;
}

export async function publishedRateCard(): Promise<readonly PublicRateCardRow[]> {
  try {
    const id = await tenantId();
    if (!id) return [];
    const { listPublicRateCard } = await import("@meridian/db/domain");
    return await listPublicRateCard(id);
  } catch (error) {
    console.error("[rates] could not load the published rate card; showing the static page only", error);
    return [];
  }
}
