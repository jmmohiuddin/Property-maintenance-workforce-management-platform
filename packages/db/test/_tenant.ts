import { sql } from "drizzle-orm";
import { db } from "../src/index";

/**
 * Resolve the tenant a test should run against.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Three separate tests were written as `activeTenantIds()[0]`, and all three
 * eventually failed against code that was working correctly.
 *
 * The seed creates two tenants deliberately, so that row-level-security
 * isolation can be proven against a second one. That second tenant has an owner
 * and nothing else — no technicians, no operations manager, no dispatcher —
 * which is not a broken fixture: it is exactly what a brand-new deployment
 * looks like, and testing against it is how the "no recipients" and "no
 * candidates" paths get exercised at all.
 *
 * `app_cron_active_tenants()` orders by `created_at`, and which tenant sorts
 * first is a property of how the seed last ran rather than anything a test
 * should depend on. It currently returns the *empty* one first. So a test
 * taking `[0]` silently ran against a tenant with no data, and reported
 * "nobody to notify" or "no technicians available" as a failure of the code.
 *
 * Resolving by slug fixes it once. `PUBLIC_TENANT_SLUG` is also the tenant the
 * public quote form lands in, so it is the one nearly every test actually means.
 */
export async function testTenantId(
  slug = process.env["PUBLIC_TENANT_SLUG"] ?? "meridian",
): Promise<string> {
  const rows = (await db.execute<{ app_public_resolve_tenant: string | null }>(
    sql`select app_public_resolve_tenant(${slug})`,
  )) as unknown as { app_public_resolve_tenant: string | null }[];

  const id = rows[0]?.app_public_resolve_tenant;
  if (!id) {
    throw new Error(
      `No active tenant with slug "${slug}". Run \`npm run db:seed\`, or set PUBLIC_TENANT_SLUG.`,
    );
  }
  return id;
}

/**
 * The other tenant — the one a test uses to prove it cannot see across the
 * boundary.
 *
 * Returns null when only one tenant exists, so an isolation check can skip
 * rather than fail: a single-tenant database is a valid state, and a test that
 * fails on it is a test that fails on a fresh deployment.
 */
export async function otherTenantId(
  slug = process.env["PUBLIC_TENANT_SLUG"] ?? "meridian",
): Promise<string | null> {
  const rows = (await db.execute<{ id: string }>(sql`
    select id from tenants
     where slug <> ${slug} and is_active and deleted_at is null
     order by created_at
     limit 1
  `)) as unknown as { id: string }[];

  return rows[0]?.id ?? null;
}
