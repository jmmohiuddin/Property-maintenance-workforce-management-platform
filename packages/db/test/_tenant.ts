import { sql } from "drizzle-orm";
import { db } from "../src/index";
import { activeTenantIds } from "../src/domain/cron";

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
 * ── WHY THIS THROWS INSTEAD OF RETURNING NULL ──────────────────────────────
 *
 * It used to select from `tenants` on the plain `db` handle, outside a tenant
 * transaction. The policy on that table is `id = app_current_tenant()`, and
 * with `app.tenant_id` unset it matches zero rows — so the helper returned
 * null whether or not a second tenant existed. Every caller read that null as
 * "only one tenant here, skip", printed `skip`, and the isolation check under
 * it never ran once. Three suites — reporting, HR and recruitment — each found
 * this separately and routed around the helper rather than through it.
 *
 * A check that cannot fail is worse than no check: it occupies the place where
 * somebody would otherwise write one. So this now enumerates through
 * `activeTenantIds()` — `app_cron_active_tenants()`, a SECURITY DEFINER
 * function, which is the same answer the scheduled jobs reached for the same
 * RLS reason — and throws when there is no second tenant. A single-tenant
 * database is a valid state for the *product*; it is not a valid state for a
 * suite whose fixtures are `npm run db:seed`, which creates two tenants
 * precisely so that isolation can be proven.
 *
 * Filtered by identity rather than indexed. `[0]` is the mistake `testTenantId`
 * above exists to stop, and it would pick the wrong tenant here too.
 */
export async function otherTenantId(
  slug = process.env["PUBLIC_TENANT_SLUG"] ?? "meridian",
): Promise<string> {
  const tenantId = await testTenantId(slug);
  const other = (await activeTenantIds()).find((id) => id !== tenantId);

  if (!other) {
    throw new Error(
      `Cross-tenant isolation cannot be proven: "${slug}" is the only active tenant in this ` +
        "database. Run `npm run db:seed`, which creates a second one for exactly this purpose. " +
        "This is deliberately fatal — the previous version returned null here and every " +
        "isolation check that depended on it silently skipped.",
    );
  }
  return other;
}
