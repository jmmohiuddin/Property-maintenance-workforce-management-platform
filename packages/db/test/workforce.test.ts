/**
 * Workforce integration test.
 *
 * The point of these checks is the interaction between the admin screens and
 * the dispatch engine: a skill row is a dispatch permission and a lapsed
 * mandatory certification is a dispatch block, so editing them has to change
 * what `findCandidates` returns. Asserting only that the rows were written
 * would miss the thing that actually matters.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself.
 */

import { and, eq, like, lt } from "drizzle-orm";
import {
  withTenant,
  listTechnicians,
  getTechnician,
  upsertSkill,
  removeSkill,
  addCertification,
  removeCertification,
  skillCoverage,
  certState,
  findCandidates,
  schema,
  closeConnection,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";
/** Deliberately obscure so it cannot collide with a seeded skill. */
const TEST_SERVICE = "generator-maintenance";
/** Unique per run, so this suite's own fixture never collides with another run's. */
const RUN = Date.now().toString(36).slice(-6).toUpperCase();

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/**
 * Reap what a killed run of this file left behind.
 *
 * This suite now creates its own technician (see `subjectId` below) rather
 * than borrowing one from the seeded roster, so it can leak the same way
 * `jobs.test.ts` and `field.test.ts` do if the process dies before reaching
 * clean-up. Age-gated to an hour, far longer than this suite takes, so it
 * cannot reach a concurrent run's live fixture — same shape as `sweepStale()`
 * in `recruitment.test.ts`.
 */
async function sweepStale(ctx: { tenantId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx
      .delete(schema.technicians)
      .where(
        and(
          like(schema.technicians.fullName, "__TEST workforce %"),
          lt(schema.technicians.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
  });
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };

  await sweepStale(ctx);

  // ── Pure expiry logic, no database needed ────────────────────────────────
  const now = new Date("2026-06-01T00:00:00Z");
  check("certState: no expiry", certState(null, now), "no_expiry");
  check("certState: expired yesterday", certState(new Date("2026-05-31T00:00:00Z"), now), "expired");
  check("certState: expires in 10 days", certState(new Date("2026-06-11T00:00:00Z"), now), "expiring");
  check("certState: expires in a year", certState(new Date("2027-06-01T00:00:00Z"), now), "valid");

  // ── Roster ───────────────────────────────────────────────────────────────
  const roster = await withTenant(ctx, (tx) => listTechnicians(tx));
  checkTrue("roster is not empty", roster.length > 0);
  checkTrue(
    "roster rows carry their skills",
    roster.some((t) => t.skillSlugs.length > 0),
  );

  if (roster.length === 0) {
    throw new Error("Seed data missing. Run `npm run db:seed` first.");
  }

  /*
   * This suite's own technician, not a seeded one, and not `roster[0]` either.
   *
   * `roster.find((t) => !blockedIds.has(t.id))` used to pick the first
   * unblocked row in the shared `technicians` table (`HR-9`: a blocked
   * technician is excluded before scoring, at any skill level, so the subject
   * had to not be one). Position in a shared table is not an identity — other
   * suites (`jobs.test.ts`, `field.test.ts`) leave `__TEST scheduler …` and
   * `__TEST field …` rows behind when killed mid-run, those sort ahead of the
   * seeded roster, and `find` silently picked one of them as the subject. It
   * has no employee row, so `blockedTechnicians` never has an opinion on it —
   * it reads as "unblocked" without being a real candidate — and both the
   * skill and the lapsed-certification assertions below failed against a
   * technician this file never wrote to.
   *
   * The same trap, twice already: `otherTenantId()` took `activeTenantIds()[0]`
   * and silently resolved to the wrong tenant, and `myInvoices[0]` in
   * `portal.test.ts` started reading a zeroed row when a new fixture sorted
   * first. Both were fixed by selecting deliberately rather than by index —
   * here, by creating and owning the subject outright.
   */
  const subjectId = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.technicians)
      .values({
        tenantId: TENANT,
        employeeCode: `WF-${RUN}`,
        fullName: `__TEST workforce ${RUN}`,
        phone: "+971500000099",
        primaryTrade: TEST_SERVICE,
      })
      .returning({ id: schema.technicians.id });
    if (!row) throw new Error("could not create the test technician");
    return row.id;
  });
  const subject = { id: subjectId };

  // A real user id: `verified_by_id` is a foreign key, and signing off a skill
  // is meaningless without the person who vouched for it.
  const verifier = await withTenant(ctx, async (tx) => {
    const rows = await tx.select({ id: schema.users.id }).from(schema.users).limit(1);
    return rows[0]?.id ?? null;
  });
  if (!verifier) throw new Error("Seed data missing a user.");

  const property = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        lat: schema.properties.lat,
        lng: schema.properties.lng,
        city: schema.properties.city,
      })
      .from(schema.properties)
      .limit(1);
    return rows[0] ?? null;
  });
  if (!property) throw new Error("Seed data missing a property.");

  // ── A skill is what makes someone dispatchable ───────────────────────────
  const before = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property }),
  );
  const wasCandidate = before.candidates.some((c) => c.technicianId === subject.id);

  await withTenant(ctx, (tx) =>
    upsertSkill(
      tx,
      { tenantId: TENANT, userId: verifier },
      { technicianId: subject.id, serviceSlug: TEST_SERVICE, proficiency: 4 },
    ),
  );

  const afterSkill = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property }),
  );
  checkTrue(
    "signing off a skill makes the technician a candidate",
    afterSkill.candidates.some((c) => c.technicianId === subject.id),
  );
  checkTrue("was not a candidate before the skill existed", !wasCandidate);

  // Re-signing is a re-grade, not a duplicate.
  await withTenant(ctx, (tx) =>
    upsertSkill(
      tx,
      { tenantId: TENANT, userId: verifier },
      { technicianId: subject.id, serviceSlug: TEST_SERVICE, proficiency: 2 },
    ),
  );
  const detail = await withTenant(ctx, (tx) => getTechnician(tx, subject.id));
  const testSkills = (detail?.skills ?? []).filter((s) => s.serviceSlug === TEST_SERVICE);
  check("re-signing does not duplicate the row", testSkills.length, 1);
  check("re-signing re-grades", testSkills[0]?.proficiency, 2);

  const outOfRange = await withTenant(ctx, async (tx) => {
    try {
      await upsertSkill(
        tx,
        { tenantId: TENANT, userId: verifier },
        { technicianId: subject.id, serviceSlug: TEST_SERVICE, proficiency: 9 },
      );
      return false;
    } catch {
      return true;
    }
  });
  checkTrue("proficiency outside 1-5 is rejected", outOfRange);

  // ── A lapsed mandatory certification needs a recorded reason ─────────────
  //
  // A warning, not a block, and the distinction is `HR-9`'s own: five documents
  // hard-block a dispatch — work permit, residence visa, Emirates ID, medical
  // fitness, health insurance — and a trade certification is not one of them.
  // It warns, and the override carries a reason (`JOB-10`). This used to drop
  // the technician from the list entirely, which read as safer and was not: the
  // dispatcher who needs that person anyway phones them instead, and then
  // nothing is recorded at all.
  //
  // What must NOT move is what a warning can reach. `packages/db/test/
  // compliance.test.ts` holds the other half: a technician with an expired work
  // permit gets no control at any score.
  const cert = await withTenant(ctx, (tx) =>
    addCertification(
      tx,
      { tenantId: TENANT },
      {
        technicianId: subject.id,
        name: "__TEST generator permit",
        expiresOn: new Date(Date.now() - 86_400_000),
        requiredForServices: [TEST_SERVICE],
      },
    ),
  );

  const afterLapse = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property }),
  );
  checkTrue(
    "a lapsed mandatory certification removes the one-click candidate",
    !afterLapse.candidates.some((c) => c.technicianId === subject.id),
  );
  checkTrue(
    "and offers them against a recorded reason instead",
    afterLapse.warned.some((c) => c.technicianId === subject.id),
  );
  checkTrue(
    "and says why rather than silently dropping them",
    afterLapse.warned.some(
      (c) =>
        c.technicianId === subject.id &&
        c.requiresOverride &&
        c.warnings.some(
          (w) =>
            w.type === "certification_expired" && w.detail.includes("__TEST generator permit"),
        ),
    ),
  );

  const alerted = await withTenant(ctx, (tx) => listTechnicians(tx));
  checkTrue(
    "the roster surfaces the lapse",
    (alerted.find((t) => t.id === subject.id)?.certAlerts ?? []).some(
      (c) => c.state === "expired",
    ),
  );

  // ── Coverage ─────────────────────────────────────────────────────────────
  const coverage = await withTenant(ctx, (tx) => skillCoverage(tx));
  check(
    "coverage counts the new skill",
    coverage.find((c) => c.serviceSlug === TEST_SERVICE)?.technicians,
    1,
  );

  // ── Removing the block restores the candidate ────────────────────────────
  await withTenant(ctx, (tx) => removeCertification(tx, cert.id));
  const restored = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property }),
  );
  checkTrue(
    "removing the lapsed certification restores the candidate",
    restored.candidates.some((c) => c.technicianId === subject.id),
  );

  // ── Withdrawing the skill removes them again ─────────────────────────────
  const skillId = testSkills[0]?.id;
  if (skillId) await withTenant(ctx, (tx) => removeSkill(tx, skillId));
  const withdrawn = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property }),
  );
  checkTrue(
    "withdrawing the skill removes the candidate",
    !withdrawn.candidates.some((c) => c.technicianId === subject.id),
  );

  // ── Clean-up: nothing this test wrote should outlive it ──────────────────
  //
  // Every delete below is scoped to `subject.id` — the technician this run
  // created — rather than to the certification's name alone, so a concurrent
  // run of this same file cannot delete the other's live fixture mid-test.
  await withTenant(ctx, async (tx) => {
    await tx
      .delete(schema.technicianSkills)
      .where(
        and(
          eq(schema.technicianSkills.technicianId, subject.id),
          eq(schema.technicianSkills.serviceSlug, TEST_SERVICE),
        ),
      );
    await tx
      .delete(schema.technicianCertifications)
      .where(
        and(
          eq(schema.technicianCertifications.technicianId, subject.id),
          eq(schema.technicianCertifications.name, "__TEST generator permit"),
        ),
      );
    await tx
      .delete(schema.technicians)
      .where(and(eq(schema.technicians.id, subject.id), eq(schema.technicians.tenantId, TENANT)));
  });

  console.log(fail === 0 ? "\nall workforce checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
