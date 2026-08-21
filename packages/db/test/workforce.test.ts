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

import { and, eq } from "drizzle-orm";
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
  blockedTechnicians,
  schema,
  closeConnection,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";
/** Deliberately obscure so it cannot collide with a seeded skill. */
const TEST_SERVICE = "generator-maintenance";

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

  /*
   * The subject must not be compliance-blocked (`HR-9`).
   *
   * This test asks "does signing off a skill make this person a candidate?",
   * and the answer for someone with an expired work permit is correctly NO —
   * a blocked technician is excluded before scoring, at any skill level. Taking
   * `roster[0]` unconditionally made the test depend on whoever happens to sort
   * first having valid documents, which is not a property of the code under
   * test. Picking an unblocked technician keeps this test about skills.
   */
  const blocked = await withTenant(ctx, (tx) => blockedTechnicians(tx));
  const blockedIds = new Set(blocked.map((b) => b.technicianId));

  const subject = roster.find((t) => !blockedIds.has(t.id));
  if (!subject) {
    throw new Error(
      roster.length === 0
        ? "Seed data missing. Run `npm run db:seed` first."
        : "Every technician in the roster is compliance-blocked, so none can be a candidate. " +
          "Clear the demo data: delete from employees where employee_no like 'DEMO%';",
    );
  }

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

  // ── A lapsed mandatory certification is a hard block ─────────────────────
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
    "a lapsed mandatory certification removes the candidate",
    !afterLapse.candidates.some((c) => c.technicianId === subject.id),
  );
  checkTrue(
    "and says why rather than silently dropping them",
    afterLapse.disqualified.some(
      (d) => d.technicianId === subject.id && d.reason.includes("__TEST generator permit"),
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
      .where(eq(schema.technicianCertifications.name, "__TEST generator permit"));
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
