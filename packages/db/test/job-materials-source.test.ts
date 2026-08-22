/**
 * `FLD-9` — where the part came from, end to end.
 *
 *   npx tsx test/job-materials-source.test.ts
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * One bug, and it is the shape of bug this suite exists to make impossible
 * again rather than merely fixed once.
 *
 * The field client sent `source` on every `job_material/append` and
 * `serialNumber` where it had one. `job_materials` had neither column and
 * `recordJobMaterial()` read neither key. So both values arrived, were
 * accepted, and were discarded. Nothing refused and nothing warned.
 *
 * That is worse than a missing feature, and the difference is the whole reason
 * this is tested at three layers instead of one. A refusal would have told the
 * technician to try something else. Silent acceptance told them it had worked —
 * which produces a confident, wrong answer six months later, when a warranty
 * claim, a supplier dispute or a parts-markup audit asks the one question
 * `FLD-9` exists to answer.
 *
 * ── WHY THE WIRE PATH IS TESTED AND NOT ONLY THE DOMAIN CALL ───────────────
 *
 * Because the wire path is where it broke. `recordJobMaterial` could have been
 * given both columns and the sync handler in `domain/field.ts` would still have
 * built its input without them, and every domain-level assertion would still
 * have passed. The mapping from payload to input is the defect, so the mapping
 * is what is asserted: a mutation is pushed through `applyFieldMutations` in
 * the shape `apps/field/src/sync/payloads.ts` actually sends, and the row is
 * read back out of Postgres.
 *
 * ── WHY EVERY ASSERTION IS ANCHORED TO A PER-RUN TAG ───────────────────────
 *
 * Same rule as `field.test.ts` and `projects.test.ts`: the development database
 * is shared, and a suite that only passes against a pristine one fails on
 * somebody's laptop for reasons that have nothing to do with the code. The
 * cleanup is age-gated as well as tagged, so it can never reach a concurrent
 * run's live fixture.
 */

import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import * as schema from "../src/schema";
import {
  applyFieldMutations,
  recordJobMaterial,
  registerFieldDevice,
  nextJobReference,
} from "../src/index";
import { issueDeviceToken } from "@meridian/auth";
import { MATERIAL_SOURCES } from "@meridian/core";
import { testTenantId } from "./_tenant";

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const TAG = `ZZMAT${RUN}`;

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

let clientSeq = 0;
function clientId(): string {
  clientSeq += 1;
  return `${TAG}-${clientSeq.toString().padStart(3, "0")}`;
}

/**
 * Clear anything a previous run died before cleaning up.
 *
 * Age-gated to an hour, far longer than this suite takes, so it cannot reach a
 * concurrent run's live fixture — the same shape as `sweepStale()` in
 * `field.test.ts`, and for the same reason: a run killed mid-way orphans a
 * technician row that sorts ahead of the seeded roster and is then picked up by
 * anything reading the table positionally.
 */
async function sweepStale(ctx: { tenantId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const stale = await tx
      .select({ id: schema.technicians.id })
      .from(schema.technicians)
      .where(
        and(
          like(schema.technicians.fullName, "__TEST material %"),
          lt(schema.technicians.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    if (stale.length === 0) return;
    const ids = stale.map((t) => t.id);
    await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.technicianId, ids));
    await tx.delete(schema.fieldDevices).where(inArray(schema.fieldDevices.technicianId, ids));
    await tx.delete(schema.technicians).where(inArray(schema.technicians.id, ids));
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "user" as const };

  await sweepStale(ctx);

  let jobId = "";
  let technicianId = "";
  let deviceId = "";
  let userId = "";

  try {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const site = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({ id: schema.properties.id, customerId: schema.properties.customerId })
        .from(schema.properties)
        .limit(1);
      return rows[0] ?? null;
    });
    if (!site) throw new Error("Seed data missing. Run `npm run db:seed` first.");

    userId = await withTenant(ctx, async (tx) => {
      const rows = (await tx.execute<{ user_id: string }>(sql`
        select user_id from memberships where is_active limit 1
      `)) as unknown as { user_id: string }[];
      const row = rows[0];
      if (!row) throw new Error("Seed data missing a membership. Run `npm run db:seed`.");
      return row.user_id;
    });

    const built = await withTenant({ ...ctx, userId }, async (tx) => {
      const [tech] = await tx
        .insert(schema.technicians)
        .values({
          tenantId,
          employeeCode: `${TAG}-T`,
          fullName: `__TEST material ${RUN}`,
          phone: "+971500000009",
          primaryTrade: "hvac-installation-maintenance",
          userId,
        })
        .returning({ id: schema.technicians.id });
      if (!tech) throw new Error("Could not create the technician fixture");

      const reference = await nextJobReference(tx);
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference,
          customerId: site.customerId,
          propertyId: site.id,
          serviceSlug: "handyman",
          title: `${TAG} material provenance fixture`,
          status: "dispatched",
          priority: "p3_standard",
          source: "internal",
          createdById: userId,
        })
        .returning({ id: schema.jobs.id });
      if (!job) throw new Error("Could not create the job fixture");

      // The visit is what makes the job this technician's. Without it the sync
      // handler refuses every mutation with "That job is not assigned to you"
      // — which is the correct answer, and worth stating here because a suite
      // that worked around it by loosening the check would be testing nothing.
      const [visit] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId,
          jobId: job.id,
          technicianId: tech.id,
          sequence: 1,
          status: "arrived",
          scheduledStart: new Date(),
          scheduledEnd: new Date(Date.now() + 2 * 60 * 60 * 1000),
        })
        .returning({ id: schema.jobVisits.id });
      if (!visit) throw new Error("Could not create the visit fixture");

      return { technicianId: tech.id, jobId: job.id, visitId: visit.id };
    });
    technicianId = built.technicianId;
    jobId = built.jobId;

    const issued = await issueDeviceToken();
    const device = await withTenant({ ...ctx, userId }, (tx) =>
      registerFieldDevice(tx, { ...ctx, userId }, {
        technicianId,
        userId,
        label: `__TEST material handset ${RUN}`,
        platform: "ios",
        appVersion: "1.0.0",
        tokenHash: issued.tokenHash,
        tokenExpiresAt: issued.expiresAt,
      }),
    );
    deviceId = device.id;

    // ── The wire path, which is where it broke ─────────────────────────────
    console.log("\n— FLD-9: the sync handler no longer drops what the client sent —");

    const acceptedId = clientId();
    const pushed = await withTenant({ ...ctx, userId }, (tx) =>
      applyFieldMutations(tx, { ...ctx, userId }, {
        deviceId,
        technicianId,
        mutations: [
          {
            clientId: acceptedId,
            entity: "job_material",
            op: "append",
            // Exactly the shape apps/field/src/sync/payloads.ts sends.
            payload: {
              jobId,
              description: `${TAG} scroll compressor`,
              quantity: "1.000",
              unit: "ea",
              source: "purchased",
              serialNumber: "SN-ZZ-4417",
            },
          },
        ],
      }),
    );

    check("the mutation is accepted", pushed.accepted.length, 1);
    check("and nothing was rejected", pushed.rejected.length, 0);

    const stored = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          id: schema.jobMaterials.id,
          source: schema.jobMaterials.source,
          serialNumber: schema.jobMaterials.serialNumber,
        })
        .from(schema.jobMaterials)
        .where(
          and(
            eq(schema.jobMaterials.jobId, jobId),
            eq(schema.jobMaterials.description, `${TAG} scroll compressor`),
          ),
        );
      return rows[0] ?? null;
    });

    checkTrue("the material line exists", stored !== null);
    // The two assertions the original bug would have failed. Before the fix
    // both of these read null while the mutation reported success.
    check("the source the technician chose survived the sync", stored?.source, "purchased");
    check("and so did the serial number", stored?.serialNumber, "SN-ZZ-4417");

    // ── An unknown value is refused, never quietly dropped ─────────────────
    console.log("\n— a source this system does not know is refused, not discarded —");

    const badId = clientId();
    const bad = await withTenant({ ...ctx, userId }, (tx) =>
      applyFieldMutations(tx, { ...ctx, userId }, {
        deviceId,
        technicianId,
        mutations: [
          {
            clientId: badId,
            entity: "job_material",
            op: "append",
            payload: {
              jobId,
              description: `${TAG} mystery part`,
              quantity: "1.000",
              unit: "ea",
              source: "found_in_a_skip",
            },
          },
        ],
      }),
    );

    check("it is not accepted", bad.accepted.length, 0);
    check("it is rejected", bad.rejected.length, 1);
    checkTrue(
      "and the refusal names what a source may be, so the fix is obvious",
      MATERIAL_SOURCES.every((s) => (bad.rejected[0]?.message ?? "").includes(s)),
    );

    const skipRow = await withTenant(ctx, async (tx) => {
      const rows = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from job_materials
         where job_id = ${jobId}::uuid and description = ${`${TAG} mystery part`}
      `)) as unknown as { count: number }[];
      return rows[0]?.count;
    });
    // The critical one. The old behaviour was to write the line and throw the
    // provenance away, which is indistinguishable to the technician from
    // success. A refusal must leave no line at all.
    check("and no line was written with the provenance stripped off it", skipRow, 0);

    // ── Absent means absent, and is never invented ─────────────────────────
    console.log("\n— a line with no source recorded says so, rather than guessing —");

    const quietId = clientId();
    await withTenant({ ...ctx, userId }, (tx) =>
      applyFieldMutations(tx, { ...ctx, userId }, {
        deviceId,
        technicianId,
        mutations: [
          {
            clientId: quietId,
            entity: "job_material",
            op: "append",
            // An older client, from before the field app grew its picker.
            payload: {
              jobId,
              description: `${TAG} cable, 2.5mm`,
              quantity: "12.500",
              unit: "m",
            },
          },
        ],
      }),
    );

    const quiet = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          source: schema.jobMaterials.source,
          serialNumber: schema.jobMaterials.serialNumber,
        })
        .from(schema.jobMaterials)
        .where(
          and(
            eq(schema.jobMaterials.jobId, jobId),
            eq(schema.jobMaterials.description, `${TAG} cable, 2.5mm`),
          ),
        );
      return rows[0] ?? null;
    });

    checkTrue("the line is still accepted", quiet !== null);
    // Not 'van_stock'. A default here would state, on every row nobody was
    // asked about, that the part came off the van — the confident wrong answer
    // the whole change exists to prevent.
    check("its source is null, meaning not recorded", quiet?.source, null);
    check("and a consumable with no serial number has none", quiet?.serialNumber, null);

    // ── The domain call, for the console path that has no picker yet ───────
    console.log("\n— recordJobMaterial itself round-trips both, and refuses a bad one —");

    const direct = await withTenant({ ...ctx, userId }, (tx) =>
      recordJobMaterial(tx, { tenantId, userId }, {
        jobId,
        description: `${TAG} expansion valve`,
        quantity: "2.000",
        unit: "ea",
        source: "customer_supplied",
        serialNumber: "  SN-TRIMMED-9  ",
      }),
    );
    checkTrue("the line was written", Boolean(direct.id));

    const directRow = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({
          source: schema.jobMaterials.source,
          serialNumber: schema.jobMaterials.serialNumber,
        })
        .from(schema.jobMaterials)
        .where(eq(schema.jobMaterials.id, direct.id));
      return rows[0] ?? null;
    });
    check("with the source it was given", directRow?.source, "customer_supplied");
    check("and the serial number trimmed", directRow?.serialNumber, "SN-TRIMMED-9");

    let refused = "";
    try {
      await withTenant({ ...ctx, userId }, (tx) =>
        recordJobMaterial(tx, { tenantId, userId }, {
          jobId,
          description: `${TAG} should not exist`,
          quantity: "1.000",
          // Cast, because the point of the assertion is a value the type system
          // already forbids arriving from an untyped wire.
          source: "off_the_back_of_a_lorry" as never,
        }),
      );
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error);
    }
    checkTrue("an unknown source is refused at the domain boundary too", refused.length > 0);
    checkTrue(
      "and the refusal is a sentence, not a constraint name",
      refused.includes("van_stock") && !refused.includes("job_materials_source"),
    );

    // ── The CHECK constraint is real, not only a TypeScript opinion ────────
    console.log("\n— the database refuses it too, with the domain layer bypassed —");

    let dbRefused = "";
    try {
      await withTenant({ ...ctx, userId }, (tx) =>
        tx.insert(schema.jobMaterials).values({
          tenantId,
          jobId,
          description: `${TAG} straight past the guard`,
          quantity: "1.000",
          unit: "ea",
          source: "nowhere_at_all",
        }),
      );
    } catch (error) {
      // Constraint names arrive on `.cause`, not on `.message`.
      const cause = (error as { cause?: { constraint_name?: string } }).cause;
      dbRefused = cause?.constraint_name ?? "";
    }
    check("by the CHECK added in 0036", dbRefused, "job_materials_source");
  } finally {
    // ── Cleanup ────────────────────────────────────────────────────────────
    console.log("\n— cleanup —");
    await withTenant({ ...ctx, userId }, async (tx) => {
      if (jobId) {
        await tx.delete(schema.jobMaterials).where(eq(schema.jobMaterials.jobId, jobId));
      }
      if (deviceId) {
        await tx.execute(sql`delete from field_mutations where device_id = ${deviceId}::uuid`);
        await tx.delete(schema.fieldDevices).where(eq(schema.fieldDevices.id, deviceId));
      }
      if (jobId) {
        // Before the technician: `job_visits.technician_id` is ON DELETE
        // RESTRICT, so a leaked visit strands the fixture permanently.
        await tx.delete(schema.jobVisits).where(eq(schema.jobVisits.jobId, jobId));
        await tx.execute(sql`delete from job_events where job_id = ${jobId}::uuid`);
        await tx.delete(schema.jobs).where(eq(schema.jobs.id, jobId));
      }
      if (technicianId) {
        await tx.delete(schema.technicians).where(eq(schema.technicians.id, technicianId));
      }
    });

    // Counted inside `withTenant`. Outside one, `app.tenant_id` is unset, every
    // policy here matches zero rows, and this would report 0 whether or not the
    // cleanup worked — a check that cannot fail, which is worse than no check.
    const survivors = await withTenant(ctx, async (tx) => {
      const rows = (await tx.execute<{ jobs: number; techs: number }>(sql`
        select (select count(*)::int from jobs where title like ${`${TAG}%`})        as jobs,
               (select count(*)::int from technicians where employee_code like ${`${TAG}%`}) as techs
      `)) as unknown as { jobs: number; techs: number }[];
      return rows[0];
    });
    check("no test job survived cleanup", survivors?.jobs, 0);
    check("nor the technician fixture", survivors?.techs, 0);
  }

  console.log(fail === 0 ? "\nAll material provenance checks passed.\n" : `\n${fail} check(s) FAILED.\n`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
