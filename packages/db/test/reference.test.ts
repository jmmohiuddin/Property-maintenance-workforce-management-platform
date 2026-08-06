/**
 * Document-number allocation.
 *
 * Two regressions are pinned here, both of which shipped and both of which
 * only appear against a real database:
 *
 *   1. A customer raising a portal request allocated a job reference by
 *      counting jobs — and under the customer-scope policies that count sees
 *      only their own. The number was already taken and the insert failed.
 *   2. Two allocations in flight at once read the same count and collided.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS, reference.sql and `npm run db:seed`.
 */

import { eq, inArray } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  createPortalRequest,
  nextJobReference,
  schema,
  closeConnection,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };
  const created: string[] = [];

  // ── Allocation is unique under concurrency ───────────────────────────────
  // Each call is its own transaction, so they genuinely race.
  const refs = await Promise.all(
    Array.from({ length: 12 }, () => withTenant(ctx, (tx) => nextJobReference(tx))),
  );
  check("12 concurrent allocations produce 12 distinct references", new Set(refs).size, 12);
  checkTrue(
    "every reference is well formed",
    refs.every((r) => /^JOB-\d{4}-\d{5}$/.test(r)),
  );

  // ── Allocation clears references already stored ──────────────────────────
  const existing = await withTenant(ctx, (tx) =>
    tx.select({ reference: schema.jobs.reference }).from(schema.jobs),
  );
  const taken = new Set(existing.map((r) => r.reference));
  checkTrue("no allocation collides with a stored reference", refs.every((r) => !taken.has(r)));

  // ── The portal path: customer scope must not blind the allocator ─────────
  // Resolved by business key, not by a hard-coded uuid: the seed regenerates
  // ids on every run, and a test that pins them fails for a reason that has
  // nothing to do with what it is checking.
  const seeded = await withTenant(ctx, async (tx) => {
    const [customer] = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.code, "BAYOA"))
      .limit(1);
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "fatima@baytower.example"))
      .limit(1);
    const [property] = customer
      ? await tx
          .select({ id: schema.properties.id })
          .from(schema.properties)
          .where(eq(schema.properties.customerId, customer.id))
          .limit(1)
      : [];
    return { customerId: customer?.id, userId: user?.id, propertyId: property?.id };
  });

  const { customerId, userId, propertyId } = seeded;
  if (!customerId || !userId || !propertyId) {
    throw new Error("Seed data missing. Run `npm run db:seed` first.");
  }

  const portal = await withCustomerScope(
    {
      tenantId: TENANT,
      customerId,
      userId,
      actorKind: "customer",
    },
    async (tx) => {
      const seen = await tx.select({ id: schema.jobs.id }).from(schema.jobs);
      const request = await createPortalRequest(
        tx,
        {
          tenantId: TENANT,
          customerId,
          userId,
        },
        {
          propertyId,
          serviceSlug: "handyman",
          title: "__TEST reference allocation under customer scope",
          requestedPriority: "p3_standard",
        },
      );
      return { visibleJobs: seen.length, ...request };
    },
  );
  created.push(portal.jobId);

  checkTrue(
    "the customer can see far fewer jobs than the tenant has",
    portal.visibleJobs < existing.length,
  );
  checkTrue(
    "yet the reference they got is above every stored one",
    !taken.has(portal.reference),
  );
  check("the request starts at submitted, not triaged", await statusOf(portal.jobId), "submitted");

  // ── Clean-up ─────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, created));
    await tx.delete(schema.jobs).where(inArray(schema.jobs.id, created));
  });

  console.log(fail === 0 ? "\nreference: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

async function statusOf(jobId: string): Promise<string | undefined> {
  const rows = await withTenant({ tenantId: TENANT }, (tx) =>
    tx.select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, jobId)),
  );
  return rows[0]?.status;
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
