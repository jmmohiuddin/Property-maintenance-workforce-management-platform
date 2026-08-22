/**
 * The work injury register and the HSE record set — integration test against
 * real Postgres.
 *
 * `HR-11`, `HR-12`. Two statutory obligations, and the assertions below are on
 * the exact boundary rather than near it: 48 hours to the minute, Dubai's
 * calendar day either side of midnight, and a notification made one millisecond
 * after the window closed.
 *
 *   npx tsx packages/db/test/hse.test.ts
 *
 * Requires a seeded database. Cleans up everything it creates, at both ends.
 *
 * ── THE THREE ASSERTIONS THAT ARE REQUIREMENTS RATHER THAN TESTS ────────────
 *
 *  1. **The 48-hour clock is bracketed from both sides.** 47:59 is inside the
 *     window; 48:00 is outside it. A single boundary fixture passes under
 *     mutation whenever it leans the right way, so every boundary here is two
 *     assertions and they disagree with each other by design.
 *  2. **The register's day is DUBAI's day.** An injury at 21:00 UTC is 01:00
 *     the next morning in Dubai, and it must file under the Dubai day — in the
 *     right month, and on New Year's Eve in the right year. The mirror case,
 *     where the two days agree, is asserted beside it: without it the test
 *     would also pass against code that always added a day.
 *  3. **A work injury record survives the `HR-15` employee purge.** The
 *     employee row is deleted and the register entry stays, with `employee_id`
 *     nulled and `employee_no` preserved — while a toolbox-talk attendance for
 *     the same employee is gone. Two children of one parent with two different
 *     retention answers, and the test is what proves the FK direction rather
 *     than the comment claiming it.
 *
 * ── WHY EVERY ASSERTION IS A DELTA, AND EVERY FIXTURE CARRIES A TAG ────────
 *
 * Same rule as `hr.test.ts` and `compliance.test.ts`. Four agents share this
 * database; a suite that only passes against a pristine one fails on somebody
 * else's write for a reason that has nothing to do with the code, and the usual
 * response is to stop trusting the suite. Nothing below is selected by position
 * or by "the newest row" — every fixture is found by its tag.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  activeTenantIds,
  // HR-11
  recordWorkInjury,
  recordMohreNotification,
  recordInsurerNotification,
  recordInjuryInvestigation,
  injuryRegister,
  openInjuryNotifications,
  workInjury,
  injuryStatistics,
  // HR-12
  recordRams,
  approveRams,
  listRams,
  recordToolboxTalk,
  acknowledgeToolboxTalk,
  listToolboxTalks,
  recordPpeIssue,
  listPpeIssues,
  returnPpeIssue,
  ropeAccessTickets,
  hseSummary,
  RETENTION_PROTECTED_TABLES,
} from "../src/domain";
import {
  assessInjuryNotification,
  addDays,
  today,
  dubaiDateKey,
  MOHRE_INJURY_NOTIFICATION_HOURS,
  ROPE_ACCESS_SERVICE_SLUGS,
} from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "HSE-TEST";
const HOUR = 3_600_000;

/**
 * The clock's origin, fixed rather than relative to now.
 *
 * Every countdown assertion below passes `now` explicitly, so the suite walks
 * the 48 hours to the minute without waiting for any of them — and, more
 * importantly, without its result depending on what time of day it is run.
 */
const KNOWN_AT = new Date("2026-03-10T06:00:00.000Z");

/**
 * An instant whose UTC day and Dubai day DISAGREE.
 *
 * 21:30 UTC on the 4th is 01:30 Dubai on the 5th. This is the fixture that
 * catches `current_date`, `getUTCFullYear` and every other reading of the day
 * that is not Dubai's.
 */
const NIGHT_SHIFT_UTC = new Date("2026-03-04T21:30:00.000Z");
const NIGHT_SHIFT_DUBAI_DAY: string = "2026-03-05";
const NIGHT_SHIFT_UTC_DAY: string = "2026-03-04";

/**
 * The same disagreement across a YEAR boundary.
 *
 * 21:30 UTC on 31 December 2025 is 01:30 Dubai on 1 January 2026, so it belongs
 * to the 2026 register and to the 2026 reference series. The year-end total is
 * the one number anybody ever compares against last year's.
 */
const NEW_YEAR_UTC = new Date("2025-12-31T21:30:00.000Z");
const NEW_YEAR_DUBAI_DAY = "2026-01-01";

/** An instant whose UTC day and Dubai day AGREE. The load-bearing positive. */
const DAYTIME_UTC = new Date("2026-03-06T08:00:00.000Z");
const DAYTIME_DUBAI_DAY = "2026-03-06";

/**
 * Delete every row this file creates, in every tenant.
 *
 * Runs before the suite as well as after it. A run that fails part way never
 * reaches its own cleanup, and the next run then fails on its *first* insert
 * for a reason that has nothing to do with the code — the most misleading shape
 * a test failure can take, and the most repeated defect in this project.
 *
 * Loops over tenants because every table here is RLS-protected and FORCE'd: a
 * delete outside a tenant transaction removes nothing, silently, with no error
 * and a zero row count.
 *
 * Everything is anchored to the tag. Never a structural predicate — "every
 * injury with no MOHRE reference" is exactly the shape of a real record
 * somebody entered an hour ago.
 */
async function purge(): Promise<void> {
  const like = `${TAG}%`;

  for (const id of await activeTenantIds()) {
    await withTenant({ tenantId: id, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`delete from work_injuries where description like ${like}`);
      // Attendees cascade from the talk; the talk is the only row to name.
      await tx.execute(sql`delete from toolbox_talks where topic like ${like}`);
      await tx.execute(sql`
        delete from ppe_issues where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      await tx.execute(sql`delete from hse_rams where title like ${like}`);
      await tx.execute(sql`
        delete from technician_certifications where name like ${like}
      `);
      await tx.execute(sql`delete from employees where full_name like ${like}`);
      await tx.execute(sql`delete from technicians where full_name like ${like}`);
    });
  }
}

async function main(): Promise<void> {
  await purge();

  const tenantId = await testTenantId();
  const otherId = await otherTenantId();

  // ═══════════════════════════════════════════════════════════════════════
  // 1. The 48-hour clock, in pure code, bracketed from both sides
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── HR-11: the MOHRE notification clock ──\n");

  check("the statutory window is 48 hours", MOHRE_INJURY_NOTIFICATION_HOURS, 48);

  const clock = (offsetMs: number, mohre: Date | null = null, insurer: Date | null = null) =>
    assessInjuryNotification(
      {
        occurredAt: KNOWN_AT,
        becameKnownAt: KNOWN_AT,
        mohreNotifiedAt: mohre,
        insurerNotifiedAt: insurer,
      },
      new Date(KNOWN_AT.getTime() + offsetMs),
    );

  // ── The window boundary. Both sides, one minute apart. ──────────────────
  const justInside = clock(48 * HOUR - 60_000);
  const exactlyOn = clock(48 * HOUR);
  check("at 47:59 the window is still open", justInside.overdue, false);
  check("at 47:59 the stage is the final band", justInside.stage, "final_hours");
  check("at 48:00 the window has closed", exactlyOn.overdue, true);
  check("at 48:00 the stage is overdue", exactlyOn.stage, "overdue");
  // Both directions asserted, so a clock that leaned either way would fail one
  // of them. A single fixture at 47:59 passes against a 24-hour window too.
  check("at 48:00 it is not yet a whole hour late", exactlyOn.hoursLate, 0);
  check("at 49:00 it is one hour late", clock(49 * HOUR).hoursLate, 1);

  // ── The escalation bands, each bracketed. ───────────────────────────────
  check("at 23:59 the record is merely recorded", clock(24 * HOUR - 60_000).stage, "recorded");
  check("at 24:00 half the window has gone", clock(24 * HOUR).stage, "half_elapsed");
  check("at 35:59 it is still the half band", clock(36 * HOUR - 60_000).stage, "half_elapsed");
  check("at 36:00 twelve hours remain", clock(36 * HOUR).stage, "final_hours");

  // ── Hours remaining leans conservative, on purpose. ─────────────────────
  check("at 47:59 it reports 0 hours remaining, not 1", justInside.hoursRemaining, 0);
  check("at 47:00 it reports 1 hour remaining", clock(47 * HOUR).hoursRemaining, 1);

  // ── Notified: in time, and one millisecond late. ────────────────────────
  const dueAt = new Date(KNOWN_AT.getTime() + 48 * HOUR);
  const onTheLine = clock(50 * HOUR, dueAt, dueAt);
  const oneMsLate = clock(50 * HOUR, new Date(dueAt.getTime() + 1), dueAt);
  check("a notification AT the deadline is in time", onTheLine.stage, "notified");
  check("a notification one millisecond later is late", oneMsLate.stage, "notified_late");
  // The pair matters: a late notification stays late for ever, and a record
  // that re-graded itself once enough time had passed would erase the breach.
  check("a late notification is not alerting once the insurer is told", oneMsLate.alerting, false);
  check("an in-time notification is not overdue", onTheLine.overdue, false);

  // ── The insurer keeps it alerting even after MOHRE is satisfied. ────────
  const insurerOutstanding = clock(50 * HOUR, dueAt, null);
  checkTrue("MOHRE notified but insurer not is still alerting", insurerOutstanding.alerting);
  check("...and is not reported as a statutory breach", insurerOutstanding.stage, "notified");
  checkTrue("neither notified is alerting", clock(1 * HOUR).alerting);

  // ── The clock runs from KNOWLEDGE, not from the incident. ───────────────
  //
  // An occupational disease diagnosed today after an exposure a year ago has a
  // full 48 hours, not a 365-day breach. Both instants supplied, deliberately
  // different, so the test would fail against code reading `occurredAt`.
  const disease = assessInjuryNotification(
    {
      occurredAt: new Date("2025-03-10T06:00:00.000Z"),
      becameKnownAt: KNOWN_AT,
      mohreNotifiedAt: null,
      insurerNotifiedAt: null,
    },
    new Date(KNOWN_AT.getTime() + HOUR),
  );
  check("a disease diagnosed an hour ago is not overdue", disease.overdue, false);
  check("...and has 47 hours left, not minus a year", disease.hoursRemaining, 47);

  // ═══════════════════════════════════════════════════════════════════════
  // 2. Fixtures
  // ═══════════════════════════════════════════════════════════════════════
  const fixtures = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const [tech] = (await tx.execute<{ id: string }>(sql`
      insert into technicians (tenant_id, employee_code, full_name, phone, primary_trade, is_active)
      values (${tenantId}::uuid, ${`${TAG}-TC1`}, ${`${TAG}-T1`}, '+971500000000', 'electrical', true)
      returning id
    `)) as unknown as { id: string }[];

    const [emp] = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, technician_id, employee_no, full_name, status)
      values (${tenantId}::uuid, ${tech!.id}::uuid, ${`${TAG}-E1`}, ${`${TAG}-Employee-One`}, 'active')
      returning id
    `)) as unknown as { id: string }[];

    const [emp2] = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, employee_no, full_name, status)
      values (${tenantId}::uuid, ${`${TAG}-E2`}, ${`${TAG}-Employee-Two`}, 'active')
      returning id
    `)) as unknown as { id: string }[];

    /*
     * Three certifications on one technician, and every expiry is a FIXED
     * INSTANT rather than "today plus forty days".
     *
     * The first version seeded these from `today()` cast to `timestamptz`,
     * which Postgres resolves in the SESSION's timezone — Asia/Dhaka here, two
     * hours ahead of Dubai — so midnight Dhaka is 22:00 Dubai the evening
     * before and the countdown came out one short. The query was right and the
     * fixture was wrong, which is the most expensive shape this mistake takes:
     * a fixture seeded from the session's clock against a query reading Dubai's
     * day is flaky for exactly the reason the code would have been wrong.
     *
     * The two instants are chosen to pin DUBAI specifically rather than merely
     * "not UTC", and they bracket it from opposite sides:
     *
     *   L2  21:00 UTC on 31 Dec 2026 → 01:00 Dubai on 1 Jan 2027. UTC says 31
     *       December, Dubai says 1 January. Catches a query that reads the
     *       instant as UTC.
     *   L1  19:00 UTC on 31 Dec 2026 → 23:00 Dubai on 31 December, but 01:00 on
     *       1 January in Asia/Dhaka, which is the session timezone of this
     *       cluster. Catches a query that lets the SESSION decide — the eight-
     *       times-repeated defect in this repository, and the one a UTC-only
     *       fixture cannot see.
     *
     *   Between them, only Dubai's day satisfies both, and each is the other's
     *   load-bearing positive: L2 alone also passes against code that always
     *   adds a day, and L1 alone also passes against plain UTC.
     *
     *   Not-rope  a service slug that is not rope access. Proves the lens
     *       filters rather than returning every certification.
     */
    await tx.execute(sql`
      insert into technician_certifications
        (tenant_id, technician_id, name, issuer, expires_on, required_for_services)
      values
        (${tenantId}::uuid, ${tech!.id}::uuid, ${`${TAG}-IRATA-L2`}, 'IRATA International',
         '2026-12-31T21:00:00Z'::timestamptz, ${JSON.stringify(["rope-access"])}::jsonb),
        (${tenantId}::uuid, ${tech!.id}::uuid, ${`${TAG}-IRATA-L1`}, 'IRATA International',
         '2026-12-31T19:00:00Z'::timestamptz, ${JSON.stringify(["rope-access"])}::jsonb),
        (${tenantId}::uuid, ${tech!.id}::uuid, ${`${TAG}-Not-Rope`}, 'Somebody',
         '2026-12-31T12:00:00Z'::timestamptz, ${JSON.stringify(["hvac-servicing"])}::jsonb)
    `);

    return { technicianId: tech!.id, employeeId: emp!.id, employeeTwoId: emp2!.id };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. The register writes DUBAI's day
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── HR-11: the register, on Dubai's calendar day ──\n");

  const recorded = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const night = await recordWorkInjury(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeId,
        occurredAt: NIGHT_SHIFT_UTC,
        severity: "lost_time",
        cause: "electrical",
        location: "Plant room B",
        description: `${TAG} night shift, live fitting`,
      },
    );

    const daytime = await recordWorkInjury(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeTwoId,
        occurredAt: DAYTIME_UTC,
        severity: "first_aid",
        cause: "hand_tool",
        description: `${TAG} daytime, hand tool`,
      },
    );

    const newYear = await recordWorkInjury(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeId,
        occurredAt: NEW_YEAR_UTC,
        severity: "medical_treatment",
        cause: "fall_same_level",
        description: `${TAG} new year's eve`,
      },
    );

    // Fatal, for the police-reportable flag. Nothing about this record is
    // notified, so it is also the one the clock walks.
    const serious = await recordWorkInjury(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeTwoId,
        occurredAt: KNOWN_AT,
        severity: "serious",
        cause: "fall_from_height",
        description: `${TAG} fall from a façade`,
      },
    );

    return { night, daytime, newYear, serious };
  });

  const rows = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    tx.execute<{ reference: string; occurred_on: string }>(sql`
      select reference, occurred_on::text as occurred_on
        from work_injuries
       where description like ${`${TAG}%`}
       order by reference
    `),
  );
  const byRef = new Map(
    (rows as unknown as { reference: string; occurred_on: string }[]).map((r) => [
      r.reference,
      r.occurred_on,
    ]),
  );

  // THE assertion. 21:30 UTC is 01:30 the next morning in Dubai.
  check(
    "a 21:30 UTC injury files under Dubai's day, not the UTC day",
    byRef.get(recorded.night.reference),
    NIGHT_SHIFT_DUBAI_DAY,
  );
  checkTrue(
    "...and Dubai's day and the UTC day genuinely disagree for that fixture",
    NIGHT_SHIFT_DUBAI_DAY !== NIGHT_SHIFT_UTC_DAY,
  );
  // The load-bearing positive beside it. Without this, code that always added a
  // day would pass the assertion above.
  check(
    "a daytime injury files under the day both clocks agree on",
    byRef.get(recorded.daytime.reference),
    DAYTIME_DUBAI_DAY,
  );
  check(
    "an injury at 21:30 on 31 December files under 1 January in Dubai",
    byRef.get(recorded.newYear.reference),
    NEW_YEAR_DUBAI_DAY,
  );
  // The reference series follows the same year, or the register and the serial
  // would disagree about which year the record belongs to.
  checkTrue(
    "...and its reference is in the Dubai year's series",
    recorded.newYear.reference.startsWith("INJ-2026-"),
  );
  checkTrue(
    "while a plainly-2026 injury is also in the 2026 series",
    recorded.night.reference.startsWith("INJ-2026-"),
  );

  // The statistics bound the year on Dubai's day too.
  const stats2026 = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    injuryStatistics(tx, { year: 2026 }),
  );
  const stats2025 = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    injuryStatistics(tx, { year: 2025 }),
  );
  const tagged2026 = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    injuryRegister(tx, { from: "2026-01-01", to: "2026-12-31" }),
  );
  const tagged2025 = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    injuryRegister(tx, { from: "2025-01-01", to: "2025-12-31" }),
  );
  check(
    "all four fixtures land in the 2026 register",
    tagged2026.filter((r) => r.description.startsWith(TAG)).length,
    4,
  );
  check(
    "and none of them in 2025, though one happened on 31 December UTC",
    tagged2025.filter((r) => r.description.startsWith(TAG)).length,
    0,
  );
  checkTrue("the 2026 statistics count at least the four", stats2026.total >= 4);
  check("the statistics report the year they were asked for", stats2025.year, 2025);

  // ═══════════════════════════════════════════════════════════════════════
  // 4. The clock, over the database
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── HR-11: notification, and what stops the clock ──\n");

  const openBefore = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    openInjuryNotifications(tx, new Date(KNOWN_AT.getTime() + HOUR)),
  );
  const mine = openBefore.filter((r) => r.description.startsWith(TAG));
  check("all four fixtures are owed to somebody", mine.length, 4);
  checkTrue(
    "the fatal-severity record is flagged for a police report",
    mine.find((r) => r.reference === recorded.serious.reference)?.policeReportOutstanding === true,
  );
  checkTrue(
    "...while a first-aid record is not",
    mine.find((r) => r.reference === recorded.daytime.reference)?.policeReportOutstanding === false,
  );

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await recordMohreNotification(tx, recorded.serious.id, {
      reference: `${TAG}-MOHRE-1`,
      notifiedAt: new Date(KNOWN_AT.getTime() + 2 * HOUR),
    });
  });

  const afterMohre = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    workInjury(tx, recorded.serious.id, new Date(KNOWN_AT.getTime() + 60 * HOUR)),
  );
  check("MOHRE notification stops the statutory clock", afterMohre?.assessment.stage, "notified");
  check("...and the record is no longer overdue", afterMohre?.assessment.overdue, false);
  checkTrue("...but it still alerts, because the insurer has not been told", afterMohre!.assessment.alerting);

  await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    recordInsurerNotification(tx, recorded.serious.id, {
      claimReference: `${TAG}-CLAIM-1`,
      notifiedAt: new Date(KNOWN_AT.getTime() + 3 * HOUR),
    }),
  );

  const afterBoth = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    workInjury(tx, recorded.serious.id, new Date(KNOWN_AT.getTime() + 60 * HOUR)),
  );
  check("with both notified it stops alerting", afterBoth?.assessment.alerting, false);

  const openAfter = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    openInjuryNotifications(tx, new Date(KNOWN_AT.getTime() + 60 * HOUR)),
  );
  check(
    "the settled record drops off the hourly job's list",
    openAfter.filter((r) => r.reference === recorded.serious.reference).length,
    0,
  );
  checkTrue(
    "while the other three stay on it",
    openAfter.filter((r) => r.description.startsWith(TAG)).length === 3,
  );

  // ── Refusals ────────────────────────────────────────────────────────────
  let refusedKnownBefore = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      recordWorkInjury(
        tx,
        { tenantId },
        {
          employeeId: fixtures.employeeId,
          occurredAt: KNOWN_AT,
          becameKnownAt: new Date(KNOWN_AT.getTime() - HOUR),
          severity: "first_aid",
          cause: "other",
          description: `${TAG} should not exist`,
        },
      ),
    );
  } catch {
    refusedKnownBefore = true;
  }
  checkTrue("the employer cannot have known before it happened", refusedKnownBefore);

  // The same rule, proved at the DATABASE rather than through the code path
  // somebody happened to use. Only the second one proves the rule is true.
  let refusedByConstraint = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      tx.execute(sql`
        insert into work_injuries
          (tenant_id, reference, employee_id, occurred_at, occurred_on, became_known_at,
           severity, cause, description)
        values (${tenantId}::uuid, ${`${TAG}-RAW-1`}, ${fixtures.employeeId}::uuid,
                ${KNOWN_AT.toISOString()}::timestamptz, '2026-03-10'::date,
                ${new Date(KNOWN_AT.getTime() - HOUR).toISOString()}::timestamptz,
                'first_aid', 'other', ${`${TAG} raw insert`})
      `),
    );
  } catch {
    refusedByConstraint = true;
  }
  checkTrue("...and the database refuses it too, not only the domain", refusedByConstraint);

  let refusedHalfNotification = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      tx.execute(sql`
        update work_injuries
           set mohre_reference = ${`${TAG}-PHANTOM`}
         where id = ${recorded.night.id}::uuid
      `),
    );
  } catch {
    refusedHalfNotification = true;
  }
  checkTrue(
    "a MOHRE reference cannot be recorded without a notification instant",
    refusedHalfNotification,
  );
  // The positive beside it: the pair together is accepted.
  await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    recordMohreNotification(tx, recorded.night.id, { reference: `${TAG}-MOHRE-2` }),
  );
  const night = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    workInjury(tx, recorded.night.id),
  );
  check("...and the pair together is accepted", night?.mohreReference, `${TAG}-MOHRE-2`);

  let refusedEmptyAction = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      recordInjuryInvestigation(tx, recorded.night.id, { correctiveAction: "   " }),
    );
  } catch {
    refusedEmptyAction = true;
  }
  checkTrue("an investigation cannot be closed with no corrective action", refusedEmptyAction);

  // ═══════════════════════════════════════════════════════════════════════
  // 5. HR-12: RAMS, toolbox talks, PPE, rope access
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── HR-12: HSE records ──\n");

  const day = today();
  const rams = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const inWindow = await recordRams(tx, { tenantId }, { title: `${TAG} working at height` });
    const outOfWindow = await recordRams(tx, { tenantId }, { title: `${TAG} confined space` });
    const lapsed = await recordRams(tx, { tenantId }, { title: `${TAG} refrigerant handling` });

    // Bracketed either side of the 30-day window, one day apart.
    await approveRams(tx, inWindow.id, { approvedOn: day, reviewDueOn: addDays(day, 30) });
    await approveRams(tx, outOfWindow.id, { approvedOn: day, reviewDueOn: addDays(day, 31) });
    await approveRams(tx, lapsed.id, {
      approvedOn: addDays(day, -400),
      reviewDueOn: addDays(day, -5),
    });

    return { inWindow, outOfWindow, lapsed };
  });

  const due = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    listRams(tx, { withinDays: 30, approvedOnly: true, now: day }),
  );
  const dueRefs = new Set(due.map((r) => r.reference));
  checkTrue("a review due in exactly 30 days is inside the window", dueRefs.has(rams.inWindow.reference));
  checkTrue("a review due in 31 days is outside it", !dueRefs.has(rams.outOfWindow.reference));
  checkTrue("a review that lapsed five days ago is inside it", dueRefs.has(rams.lapsed.reference));
  check(
    "...and reports as five days past, not five days away",
    due.find((r) => r.reference === rams.lapsed.reference)?.daysToReview,
    -5,
  );
  check(
    "a review due in exactly 30 days reports 30",
    due.find((r) => r.reference === rams.inWindow.reference)?.daysToReview,
    30,
  );

  let refusedBadReview = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      approveRams(tx, rams.inWindow.id, { approvedOn: day, reviewDueOn: day }),
    );
  } catch {
    refusedBadReview = true;
  }
  checkTrue("a review date on the approval day is refused", refusedBadReview);

  // ── Toolbox talks ───────────────────────────────────────────────────────
  let refusedEmptyTalk = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      recordToolboxTalk(
        tx,
        { tenantId, userId: undefined },
        { topic: `${TAG} nobody came`, employeeIds: [], presenterName: "A supervisor" },
      ),
    );
  } catch {
    refusedEmptyTalk = true;
  }
  checkTrue("a toolbox talk with no attendees is refused", refusedEmptyTalk);

  const talk = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    recordToolboxTalk(
      tx,
      { tenantId },
      {
        topic: `${TAG} working at height`,
        employeeIds: [fixtures.employeeId, fixtures.employeeTwoId, fixtures.employeeId],
        ramsId: rams.inWindow.id,
        presenterName: "A supervisor",
      },
    ),
  );
  check("...while a talk with attendees is recorded", talk.attendees, 2);

  const talks = await withTenant({ tenantId, actorKind: "system" }, (tx) => listToolboxTalks(tx));
  const mineTalk = talks.find((t) => t.id === talk.id);
  check("the attendance count is the count of distinct people", mineTalk?.attendeeCount, 2);
  check("nobody has signed yet", mineTalk?.unacknowledgedCount, 2);
  check("...and the day is Dubai's day", mineTalk?.heldOn, dubaiDateKey(new Date()));
  check("...and the RAMS it briefed is named", mineTalk?.ramsReference, rams.inWindow.reference);

  await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    acknowledgeToolboxTalk(tx, { toolboxTalkId: talk.id, employeeId: fixtures.employeeId }),
  );
  const talksAfter = await withTenant({ tenantId, actorKind: "system" }, (tx) => listToolboxTalks(tx));
  check(
    "one signature leaves one unsigned",
    talksAfter.find((t) => t.id === talk.id)?.unacknowledgedCount,
    1,
  );

  // ── PPE ─────────────────────────────────────────────────────────────────
  let refusedBadPpe = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      recordPpeIssue(
        tx,
        { tenantId },
        {
          employeeId: fixtures.employeeId,
          itemKind: "fall_arrest",
          issuedOn: day,
          replaceDueOn: day,
        },
      ),
    );
  } catch {
    refusedBadPpe = true;
  }
  checkTrue("a replacement date on the issue day is refused", refusedBadPpe);

  const ppe = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const inWindow = await recordPpeIssue(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeId,
        itemKind: "fall_arrest",
        itemDescription: "Harness",
        issuedOn: addDays(day, -100),
        replaceDueOn: addDays(day, 30),
      },
    );
    const outOfWindow = await recordPpeIssue(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeId,
        itemKind: "eye",
        issuedOn: addDays(day, -100),
        replaceDueOn: addDays(day, 31),
      },
    );
    const returned = await recordPpeIssue(
      tx,
      { tenantId },
      {
        employeeId: fixtures.employeeTwoId,
        itemKind: "hearing",
        issuedOn: addDays(day, -100),
        replaceDueOn: addDays(day, 10),
      },
    );
    await returnPpeIssue(tx, returned.id, day);
    return { inWindow, outOfWindow, returned };
  });

  const ppeDue = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    listPpeIssues(tx, { withinDays: 30, now: day }),
  );
  const ppeIds = new Set(ppeDue.map((p) => p.id));
  checkTrue("PPE due in exactly 30 days is inside the window", ppeIds.has(ppe.inWindow.id));
  checkTrue("PPE due in 31 days is outside it", !ppeIds.has(ppe.outOfWindow.id));
  checkTrue("PPE that came back is off the list entirely", !ppeIds.has(ppe.returned.id));

  // ── Rope access, through the certification register ─────────────────────
  //
  // `now` is a fixed Dubai day rather than today's, so the countdowns below are
  // the same numbers on every machine on every day of the year.
  const CERT_NOW = "2026-12-01";
  const tickets = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    ropeAccessTickets(tx, { now: CERT_NOW }),
  );
  const mineTickets = tickets.filter((t) => t.name.startsWith(TAG));
  const l2 = mineTickets.find((t) => t.name === `${TAG}-IRATA-L2`);
  const l1 = mineTickets.find((t) => t.name === `${TAG}-IRATA-L1`);

  check("the rope-access lens finds both IRATA tickets", mineTickets.length, 2);
  checkTrue(
    "...and the non-rope certification on the same technician is excluded",
    !mineTickets.some((t) => t.name === `${TAG}-Not-Rope`),
  );
  // 21:00 UTC on 31 December is 01:00 Dubai on 1 January. The expiry has to
  // read as the Dubai day, not the UTC one.
  check("an expiry at 21:00 UTC on 31 Dec reads as 1 Jan in Dubai", l2?.expiresOn, "2027-01-01");
  check("...and counts down 31 days from 1 December", l2?.daysRemaining, 31);
  // The other side. 19:00 UTC is still 31 December in Dubai but already
  // 1 January in Asia/Dhaka, the session's timezone — so this one fails against
  // a query that lets the session decide, which the assertion above cannot see.
  check("an expiry at 19:00 UTC on 31 Dec reads as 31 Dec in Dubai", l1?.expiresOn, "2026-12-31");
  check("...and counts down 30 days from 1 December", l1?.daysRemaining, 30);
  checkTrue("the slug list is not empty, or the filter would match nothing", ROPE_ACCESS_SERVICE_SLUGS.length > 0);

  // ── The board reads all of it ───────────────────────────────────────────
  const summary = await withTenant({ tenantId, actorKind: "system" }, (tx) => hseSummary(tx));
  checkTrue("the board sees the open notifications", summary.openNotifications.length > 0);
  checkTrue("the board sees the RAMS", summary.rams.length >= 3);
  checkTrue("the board sees the talks", summary.talks.length >= 1);
  checkTrue("the board sees the PPE due", summary.ppeDue.length >= 1);
  checkTrue("the board sees the rope-access tickets", summary.ropeAccess.length >= 1);
  check("the board's day is Dubai's day", summary.today, dubaiDateKey(new Date()));

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Retention: the register survives the employee, the attendance does not
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── HR-15 against HR-11: what a purge takes and what it leaves ──\n");

  checkTrue(
    "work_injuries is on the retention protection list",
    (RETENTION_PROTECTED_TABLES as readonly string[]).includes("work_injuries"),
  );
  // The negative beside it: a table NOT on the list, so the assertion above is
  // about this list rather than about every string being present.
  checkTrue(
    "...while the HSE record tables deliberately are not",
    !(RETENTION_PROTECTED_TABLES as readonly string[]).includes("toolbox_talk_attendees"),
  );

  // The real test. Deleting the employee is exactly what `purgeExpiredEmployees`
  // does seven years after termination, and a protection list does not stop a
  // cascade — only the FK direction does.
  const survived = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx.execute(sql`delete from employees where id = ${fixtures.employeeTwoId}::uuid`);

    const injuries = (await tx.execute<{
      reference: string;
      employee_id: string | null;
      employee_no: string | null;
    }>(sql`
      select reference, employee_id, employee_no
        from work_injuries
       where reference = ${recorded.daytime.reference}
    `)) as unknown as { reference: string; employee_id: string | null; employee_no: string | null }[];

    const attendees = (await tx.execute<{ count: number }>(sql`
      select count(*)::int as count
        from toolbox_talk_attendees
       where toolbox_talk_id = ${talk.id}::uuid
    `)) as unknown as { count: number }[];

    return { injury: injuries[0], attendees: attendees[0]?.count ?? -1 };
  });

  checkTrue("the injury register entry survives the employee's deletion", survived.injury !== undefined);
  check("...with the link to the person severed", survived.injury?.employee_id, null);
  check("...and the pseudonymous reference kept", survived.injury?.employee_no, `${TAG}-E2`);
  // The other child of the same parent, with the opposite answer. Without this
  // the FK direction above could be a blanket "nothing ever cascades".
  check("...while the toolbox-talk attendance cascaded away with them", survived.attendees, 1);

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Tenant isolation
  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n── RLS: the five new tables ──\n");

  interface Counts extends Record<string, unknown> {
    injuries: number;
    rams: number;
    talks: number;
    attendees: number;
    ppe: number;
  }
  const countMine = sql`
    select (select count(*)::int from work_injuries where description like ${`${TAG}%`}) as injuries,
           (select count(*)::int from hse_rams where title like ${`${TAG}%`}) as rams,
           (select count(*)::int from toolbox_talks where topic like ${`${TAG}%`}) as talks,
           (select count(*)::int from toolbox_talk_attendees
             where toolbox_talk_id in (select id from toolbox_talks where topic like ${`${TAG}%`})) as attendees,
           (select count(*)::int from ppe_issues
             where employee_id in (select id from employees where full_name like ${`${TAG}%`})) as ppe
  `;

  const ours = ((await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    tx.execute<Counts>(countMine),
  )) as unknown as Counts[])[0]!;

  checkTrue("this tenant sees its injuries", ours.injuries > 0);
  checkTrue("its risk assessments", ours.rams > 0);
  checkTrue("its toolbox talks", ours.talks > 0);
  checkTrue("its attendance rows", ours.attendees > 0);
  checkTrue("and its PPE issues", ours.ppe > 0);

  const theirs = ((await withTenant({ tenantId: otherId, actorKind: "system" }, (tx) =>
    tx.execute<Counts>(countMine),
  )) as unknown as Counts[])[0]!;

  // Every one of the five tables carries `tenant_id`, so the generic loop in
  // sql/rls.sql covers them — this is what proves the loop actually ran.
  check("the other tenant sees none of the injuries", theirs.injuries, 0);
  check("none of the risk assessments", theirs.rams, 0);
  check("none of the toolbox talks", theirs.talks, 0);
  check("none of the attendance rows", theirs.attendees, 0);
  check("and none of the PPE issues", theirs.ppe, 0);

  await purge();

  console.log(fail === 0 ? "\nAll HSE checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await purge().catch(() => {});
  await closeConnection();
  process.exit(1);
});
