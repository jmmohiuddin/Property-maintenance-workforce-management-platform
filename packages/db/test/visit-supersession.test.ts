/**
 * Retiring the visit a reassignment replaces (`0040`).
 *
 * ── THE BUG ────────────────────────────────────────────────────────────────
 *
 * `job_visits` rows were never retired. `assignTechnician` does a plain INSERT,
 * `rescheduleVisit` refuses to change the technician on purpose, and there is
 * no DELETE from `job_visits` anywhere in `packages/db/src` — so reassigning a
 * job inserted a SECOND row and the first stayed `assigned` for ever. Because
 * `assigned` is one of `OCCUPYING_VISIT_STATUSES`, the abandoned row occupied
 * the original technician's diary permanently: `findCandidates` and
 * `listTechnicians` both scored on that count, so every historical
 * reassignment made somebody look busier than they were, monotonically, for
 * the life of the deployment.
 *
 * ── WHY THIS SUITE IS SHAPED THE WAY IT IS ─────────────────────────────────
 *
 * Every "the ghost is gone" assertion is paired with a "the live one is still
 * there" assertion against the SAME query. A suite that only proves the
 * negative passes just as happily against a function that returns no visits at
 * all — it would report the diary as empty and call the bug fixed, which is a
 * worse bug wearing the same test output.
 *
 * The other half is the line that must NOT move: a visit that reached
 * `en_route` or `arrived` is a fact about the world, and a dispatcher's
 * decision an hour later does not unmake it. Those assertions are the reason
 * this is not simply "retire everything open".
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema (through `0040`), RLS and `npm run db:seed`. Cleans up
 * after itself, and before itself.
 */

import { eq, sql } from "drizzle-orm";
import { UserFacingError, nextWorkingWindow, startOfDubaiDay } from "@meridian/core";
import {
  withTenant,
  assignTechnician,
  findCandidates,
  listTechnicians,
  loadWorkingCalendar,
  loadSchedule,
  pullWorkingSet,
  getJobCard,
  recordVisitLabour,
  recordJobOutcome,
  rescheduleVisit,
  schema,
  closeConnection,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";
/** Obscure enough that it cannot collide with a seeded skill or service. */
const TEST_SERVICE = "supersession-rig-service";
/** Unique per run, so this suite's fixtures never meet another run's. */
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const TAG = `__TEST supersede ${RUN}`;
const REFERENCE_PREFIX = `TSTSUPER${RUN}`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** Runs `fn` and reports how it refused, or null if it did not refuse. */
async function refusal(
  fn: () => Promise<unknown>,
): Promise<{ message: string; userFacing: boolean } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      userFacing: error instanceof UserFacingError,
    };
  }
}

/**
 * Remove what this suite writes, matched by tag rather than by id.
 *
 * Called on the way in as well as on the way out: a suite that only tidies up
 * on the way out leaves its rows behind the first time an assertion throws, and
 * then fails on a unique constraint for ever after — which reads as a broken
 * test rather than as a broken previous run.
 *
 * Age-gated on the technicians so a concurrent run's live fixture is out of
 * reach, the same shape as `sweepStale()` in `workforce.test.ts`.
 */
async function purge(tenantId: string): Promise<void> {
  await withTenant({ tenantId }, async (tx) => {
    const jobs = (await tx.execute<{ id: string }>(sql`
      select id from jobs where reference like ${`TSTSUPER%`}
    `)) as unknown as { id: string }[];

    // `audit_log` rows are deliberately NOT removed: the app role has no DELETE
    // on that table, which is the point of an append-only audit trail. The
    // assertion below filters on this run's own visit id, so leftovers from
    // earlier runs cannot be mistaken for it.
    for (const job of jobs) {
      await tx.execute(sql`delete from job_fault_codes where job_id = ${job.id}::uuid`);
      await tx.execute(sql`delete from job_events where job_id = ${job.id}::uuid`);
      await tx.execute(sql`delete from job_visits where job_id = ${job.id}::uuid`);
      await tx.execute(sql`update jobs set outcome_code = null where id = ${job.id}::uuid`);
      await tx.execute(sql`delete from jobs where id = ${job.id}::uuid`);
    }

    await tx.execute(sql`
      delete from technician_skills
       where technician_id in (
         select id from technicians
          where full_name like ${`__TEST supersede %`}
            and created_at < now() - interval '1 hour'
       )
    `);
    await tx.execute(sql`
      delete from technicians
       where full_name like ${`__TEST supersede %`}
         and created_at < now() - interval '1 hour'
    `);
  });
}

/** This run's own technicians and jobs, deleted by id rather than by pattern. */
async function purgeOwn(tenantId: string, technicianIds: string[]): Promise<void> {
  await withTenant({ tenantId }, async (tx) => {
    const jobs = (await tx.execute<{ id: string }>(sql`
      select id from jobs where reference like ${`${REFERENCE_PREFIX}-%`}
    `)) as unknown as { id: string }[];
    // `audit_log` rows are deliberately NOT removed: the app role has no DELETE
    // on that table, which is the point of an append-only audit trail. The
    // assertion below filters on this run's own visit id, so leftovers from
    // earlier runs cannot be mistaken for it.
    for (const job of jobs) {
      await tx.execute(sql`delete from job_fault_codes where job_id = ${job.id}::uuid`);
      await tx.execute(sql`delete from job_events where job_id = ${job.id}::uuid`);
      await tx.execute(sql`delete from job_visits where job_id = ${job.id}::uuid`);
      await tx.execute(sql`update jobs set outcome_code = null where id = ${job.id}::uuid`);
      await tx.execute(sql`delete from jobs where id = ${job.id}::uuid`);
    }
    for (const id of technicianIds) {
      await tx.execute(sql`delete from technician_skills where technician_id = ${id}::uuid`);
      await tx.execute(sql`delete from technicians where id = ${id}::uuid`);
    }
  });
}

/** The status of one visit, read back by id. Never by position. */
async function visitStatus(tenantId: string, visitId: string): Promise<string | null> {
  return withTenant({ tenantId }, async (tx) => {
    const rows = await tx
      .select({ status: schema.jobVisits.status })
      .from(schema.jobVisits)
      .where(eq(schema.jobVisits.id, visitId))
      .limit(1);
    return rows[0]?.status ?? null;
  });
}

/** How many open visits the roster believes this technician is carrying. */
async function rosterLoad(tenantId: string, technicianId: string): Promise<number | null> {
  return withTenant({ tenantId }, async (tx) => {
    const roster = await listTechnicians(tx, { includeInactive: true });
    return roster.find((t) => t.id === technicianId)?.openVisits ?? null;
  });
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };

  await purge(TENANT);

  // ── Fixtures ─────────────────────────────────────────────────────────────
  //
  // This suite creates its own technicians rather than borrowing seeded ones,
  // and every later lookup is by the id it got back. `roster[0]` in a shared
  // table is not an identity — other suites leave `__TEST …` rows behind when
  // killed mid-run and those sort ahead of the seeded roster, which has
  // silently mis-selected a subject in this repository twice already.
  //
  // A technician with no `employees` row is never compliance-blocked, so `HR-9`
  // cannot quietly disqualify the subjects and make every assertion vacuous.
  const made = await withTenant(ctx, async (tx) => {
    const customer = (await tx.select({ id: schema.customers.id }).from(schema.customers).limit(1))[0];
    const property = (
      await tx
        .select({
          id: schema.properties.id,
          lat: schema.properties.lat,
          lng: schema.properties.lng,
          city: schema.properties.city,
        })
        .from(schema.properties)
        .limit(1)
    )[0];
    const user = (await tx.select({ id: schema.users.id }).from(schema.users).limit(1))[0];
    if (!customer || !property || !user) throw new Error("Seed data missing. Run `npm run db:seed`.");

    const techIds: string[] = [];
    for (const suffix of ["A", "B", "C"]) {
      const [row] = await tx
        .insert(schema.technicians)
        .values({
          tenantId: TENANT,
          employeeCode: `SUP-${RUN}-${suffix}`,
          fullName: `${TAG} ${suffix}`,
          phone: `+9715000${suffix.charCodeAt(0)}0${RUN.slice(-2)}`,
          primaryTrade: TEST_SERVICE,
        })
        .returning({ id: schema.technicians.id });
      if (!row) throw new Error(`could not create technician ${suffix}`);
      techIds.push(row.id);
    }

    // A and B hold the skill; C deliberately does not, so assigning C trips
    // `skill_missing` — the gate used below to prove a REFUSED assignment
    // retires nothing.
    for (const id of techIds.slice(0, 2)) {
      await tx.insert(schema.technicianSkills).values({
        tenantId: TENANT,
        technicianId: id,
        serviceSlug: TEST_SERVICE,
        proficiency: 4,
        verifiedById: user.id,
      });
    }

    return { customerId: customer.id, property, userId: user.id, techIds };
  });

  const [techA, techB, techC] = made.techIds as [string, string, string];

  async function makeJob(suffix: string, title: string): Promise<string> {
    return withTenant(ctx, async (tx) => {
      const [row] = await tx
        .insert(schema.jobs)
        .values({
          tenantId: TENANT,
          reference: `${REFERENCE_PREFIX}-${suffix}`,
          customerId: made.customerId,
          propertyId: made.property.id,
          serviceSlug: TEST_SERVICE,
          title: `${TAG} ${title}`,
          status: "triaged",
        })
        .returning({ id: schema.jobs.id });
      if (!row) throw new Error(`could not create job ${suffix}`);
      return row.id;
    });
  }

  const calendar = await withTenant(ctx, (tx) => loadWorkingCalendar(tx));

  /*
   * One window per job, and never `current_date` or `new Date()` alone.
   *
   * The session timezone here is Asia/Dhaka rather than Asia/Dubai, so a day
   * taken from the server's own clock is the wrong day for a UAE dispatcher.
   * `startOfDubaiDay` plus `nextWorkingWindow` takes a Dubai day explicitly and
   * lands inside the tenant's working calendar, which keeps `off_shift` and the
   * summer midday ban out of the assertions below — neither is what this suite
   * is testing, and either would make its refusals mean something else.
   *
   * Separate days per job so that no assignment in this file is ever
   * double-booked against another one. `double_booked` requires an override
   * reason, and a suite whose assignments start needing one is a suite testing
   * `JOB-10` by accident.
   */
  function windowFor(daysAhead: number): { start: Date; end: Date } {
    const start = nextWorkingWindow(startOfDubaiDay(new Date(Date.now() + daysAhead * DAY)), {
      outdoor: false,
      calendar,
    });
    return { start, end: new Date(start.getTime() + 2 * HOUR) };
  }

  try {
    // ══ 1. The reassignment itself ════════════════════════════════════════
    console.log("\n— a reassigned job retires the visit it replaces —");

    const jobReassign = await makeJob("RE", "reassigned");
    const w1 = windowFor(3);

    const baseA = await rosterLoad(TENANT, techA);
    check("technician A starts with an empty diary", baseA, 0);

    const first = await withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: jobReassign,
        technicianId: techA,
        scheduledStart: w1.start,
        scheduledEnd: w1.end,
        calendar,
      }),
    );
    check("a first assignment supersedes nothing", first.superseded.length, 0);

    // THE LOAD-BEARING POSITIVE. Everything below asserts that a retired visit
    // stops occupying a diary; this asserts that a live one occupies it in the
    // first place. Without it the whole file passes against a query that
    // returns no visits at all.
    check("a genuinely open visit occupies the diary", await rosterLoad(TENANT, techA), 1);

    const second = await withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: jobReassign,
        technicianId: techB,
        scheduledStart: w1.start,
        scheduledEnd: w1.end,
        calendar,
      }),
    );

    check("reassigning reports what it retired", second.superseded.length, 1);
    check("and names the visit", second.superseded[0]?.visitId, first.visitId);
    check("and the technician it was taken from", second.superseded[0]?.technicianId, techA);
    check("and what it was before", second.superseded[0]?.previousStatus, "assigned");

    check("the replaced visit is superseded", await visitStatus(TENANT, first.visitId), "superseded");
    check("the replacement is assigned", await visitStatus(TENANT, second.visitId), "assigned");

    check("the retired visit stops occupying A's diary", await rosterLoad(TENANT, techA), 0);
    // The positive half of the same claim, on the same query.
    check("and the live one occupies B's", await rosterLoad(TENANT, techB), 1);

    // The row is retired, not deleted. Superseding rather than deleting is what
    // keeps the dispatch decision — who was chosen, on what score, against what
    // override — auditable after the fact.
    const stillThere = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({ id: schema.jobVisits.id })
        .from(schema.jobVisits)
        .where(eq(schema.jobVisits.id, first.visitId));
      return rows.length;
    });
    check("the retired visit is kept, not deleted", stillThere, 1);

    // ══ 2. findCandidates, the query the bug actually degraded ════════════
    console.log("\n— the dispatch panel stops counting retired visits —");

    const w2 = windowFor(4);
    const panel = await withTenant(ctx, (tx) =>
      findCandidates(tx, {
        serviceSlug: TEST_SERVICE,
        property: made.property,
        from: w2.start,
        to: w2.end,
        calendar,
      }),
    );
    const offered = [...panel.candidates, ...panel.warned];
    const seenA = offered.find((c) => c.technicianId === techA);
    const seenB = offered.find((c) => c.technicianId === techB);

    checkTrue("A is still offered", seenA !== undefined);
    check("and carries no load from the visit taken off them", seenA?.openVisits, 0);
    checkTrue("B is offered too", seenB !== undefined);
    // Again the positive: the panel has not simply stopped counting.
    check("and does carry the load it actually holds", seenB?.openVisits, 1);

    // ══ 3. Attendance is never retired ════════════════════════════════════
    //
    // The line this file exists to draw. A visit that reached `en_route` or
    // `arrived` happened; no decision taken in an office afterwards unmakes it,
    // and retiring it would destroy the only record of the journey.
    console.log("\n— an attended visit is never retired —");

    for (const attended of ["en_route", "arrived"] as const) {
      const jobAttended = await makeJob(
        attended === "en_route" ? "ER" : "AR",
        `attended ${attended}`,
      );
      const w = windowFor(attended === "en_route" ? 5 : 6);

      const went = await withTenant(ctx, (tx) =>
        assignTechnician(tx, ctx, {
          jobId: jobAttended,
          technicianId: techA,
          scheduledStart: w.start,
          scheduledEnd: w.end,
          calendar,
        }),
      );

      // Set directly. Nothing in the product advances a visit past `assigned`
      // yet — see the note in the final report — so the state has to be staged.
      await withTenant(ctx, (tx) =>
        tx
          .update(schema.jobVisits)
          .set({ status: attended, enRouteAt: w.start })
          .where(eq(schema.jobVisits.id, went.visitId)),
      );

      // Measured across the reassignment rather than against a fixed number, so
      // this fails when the reassignment moves it and not when some earlier
      // section happens to have left another visit on A.
      const loadBefore = await rosterLoad(TENANT, techA);

      const swap = await withTenant(ctx, (tx) =>
        assignTechnician(tx, ctx, {
          jobId: jobAttended,
          technicianId: techB,
          scheduledStart: w.start,
          scheduledEnd: w.end,
          calendar,
        }),
      );

      check(`a ${attended} visit is not retired`, await visitStatus(TENANT, went.visitId), attended);
      check(`and the reassignment reports retiring nothing`, swap.superseded.length, 0);
      check(
        `and it still occupies the diary of the person who went`,
        (await rosterLoad(TENANT, techA))! - loadBefore!,
        0,
      );

      // Clean the diary for the next iteration by finishing the attended visit,
      // so the counts above start from a known place each time rather than
      // accumulating.
      await withTenant(ctx, (tx) =>
        tx
          .update(schema.jobVisits)
          .set({ status: "completed", completedAt: w.end })
          .where(eq(schema.jobVisits.id, went.visitId)),
      );
      await withTenant(ctx, (tx) =>
        tx
          .update(schema.jobVisits)
          .set({ status: "completed", completedAt: w.end })
          .where(eq(schema.jobVisits.id, swap.visitId)),
      );
    }

    console.log("\n— a settled visit is never retired either —");

    /*
     * One window, and each pass hands it back before the next takes it.
     *
     * A day per pass was the first attempt and it does not work: `windowFor`
     * skips the weekend, so "seven days out" and "nine days out" both resolve
     * to the same Monday and the second pass double-booked technician B against
     * his own visit from the first. `double_booked` needs an override reason,
     * which would have turned every assertion below into a `JOB-10` test that
     * happened to be green. Settling both visits at the end of each pass leaves
     * the window genuinely free, whatever the calendar does to the arithmetic.
     */
    for (const settled of ["completed", "no_access", "aborted", "declined"] as const) {
      const jobSettled = await makeJob(`S${settled.slice(0, 2).toUpperCase()}`, `settled ${settled}`);
      const w = windowFor(7);

      const done = await withTenant(ctx, (tx) =>
        assignTechnician(tx, ctx, {
          jobId: jobSettled,
          technicianId: techA,
          scheduledStart: w.start,
          scheduledEnd: w.end,
          calendar,
        }),
      );
      await withTenant(ctx, (tx) =>
        tx
          .update(schema.jobVisits)
          .set({ status: settled })
          .where(eq(schema.jobVisits.id, done.visitId)),
      );

      const replacement = await withTenant(ctx, (tx) =>
        assignTechnician(tx, ctx, {
          jobId: jobSettled,
          technicianId: techB,
          scheduledStart: w.start,
          scheduledEnd: w.end,
          calendar,
        }),
      );

      check(
        `a ${settled} visit keeps its recorded outcome`,
        await visitStatus(TENANT, done.visitId),
        settled,
      );

      // Hand the window back. See the note above the loop.
      await withTenant(ctx, (tx) =>
        tx
          .update(schema.jobVisits)
          .set({ status: "completed", completedAt: w.end })
          .where(eq(schema.jobVisits.id, replacement.visitId)),
      );
    }

    // ══ 4. The JOB-12 escape hatch ════════════════════════════════════════
    console.log("\n— a second technician alongside the first, asked for by name —");

    const jobPair = await makeJob("PR", "two on the job");
    const w8 = windowFor(8);

    // Measured as a RISE, not as an absolute. Technician B still holds the
    // reassigned job from section 1, so asserting "B carries one" would be
    // asserting the wrong thing and would break again the next time a section
    // is added above this one. A delta says what this block actually claims.
    const pairBaseA = await rosterLoad(TENANT, techA);
    const pairBaseB = await rosterLoad(TENANT, techB);

    const pairFirst = await withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: jobPair,
        technicianId: techA,
        scheduledStart: w8.start,
        scheduledEnd: w8.end,
        calendar,
      }),
    );
    const pairSecond = await withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: jobPair,
        technicianId: techB,
        scheduledStart: w8.start,
        scheduledEnd: w8.end,
        additional: true,
        calendar,
      }),
    );

    check("`additional` retires nothing", pairSecond.superseded.length, 0);
    check("the first visit stays assigned", await visitStatus(TENANT, pairFirst.visitId), "assigned");
    check("and so does the second", await visitStatus(TENANT, pairSecond.visitId), "assigned");
    check("both diaries gain a visit — A", (await rosterLoad(TENANT, techA))! - pairBaseA!, 1);
    check("both diaries gain a visit — B", (await rosterLoad(TENANT, techB))! - pairBaseB!, 1);

    // ══ 5. A refused assignment retires nothing ═══════════════════════════
    //
    // Retirement sits below every refusal in `assignTechnician` on purpose. A
    // dispatcher who trips the `JOB-10` gate must not find the previous
    // technician removed from a job that was never actually reassigned.
    console.log("\n— a refused assignment leaves the existing visit alone —");

    const refused = await refusal(() =>
      withTenant(ctx, (tx) =>
        assignTechnician(tx, ctx, {
          // C holds no skill for this service, so `skill_missing` gates it.
          jobId: jobPair,
          technicianId: techC,
          scheduledStart: w8.start,
          scheduledEnd: w8.end,
          calendar,
        }),
      ),
    );
    checkTrue("the silent override is refused", refused !== null);
    checkTrue("and safely", refused?.userFacing === true);
    check(
      "and the visit it would have replaced is untouched",
      await visitStatus(TENANT, pairFirst.visitId),
      "assigned",
    );

    // ══ 6. The job card stops rendering a phantom labour form ═════════════
    console.log("\n— the job card asks about visits that happened —");

    const card = await withTenant(ctx, (tx) => getJobCard(tx, jobReassign));
    check("one labour row, not one per ghost", card.labour.length, 1);
    check("and it is the live visit", card.labour[0]?.visitId, second.visitId);
    checkTrue(
      "the retired visit is absent from the card",
      !card.labour.some((l) => l.visitId === first.visitId),
    );

    const labourRefusal = await refusal(() =>
      withTenant(ctx, (tx) =>
        recordVisitLabour(tx, ctx, { jobId: jobReassign, visitId: first.visitId, workMinutes: 90 }),
      ),
    );
    checkTrue("recording labour against a retired visit is refused", labourRefusal !== null);
    checkTrue("and safely", labourRefusal?.userFacing === true);
    checkTrue(
      "and says why",
      (labourRefusal?.message ?? "").includes("replaced when the job was reassigned"),
    );

    // The control, not only the affordance: the same refusal has to hold for
    // the live visit's opposite — recording against it must still WORK, or the
    // guard above is indistinguishable from a function that refuses everything.
    await withTenant(ctx, (tx) =>
      recordVisitLabour(tx, ctx, { jobId: jobReassign, visitId: second.visitId, workMinutes: 90 }),
    );
    const cardAfter = await withTenant(ctx, (tx) => getJobCard(tx, jobReassign));
    check("labour on the live visit is still accepted", cardAfter.labour[0]?.workMinutes, 90);

    // The outcome gate only opens on a completable job — `recordJobOutcome`
    // refuses anything before `on_site` first, and the mutation run caught this
    // assertion passing on THAT refusal while retirement was disabled. Staged
    // directly rather than through `transitionJob`, because walking the status
    // graph is not what is under test here.
    await withTenant(ctx, (tx) =>
      tx.execute(sql`update jobs set status = 'on_site' where id = ${jobReassign}::uuid`),
    );

    const outcomeRefusal = await refusal(() =>
      withTenant(ctx, (tx) =>
        recordJobOutcome(tx, ctx, {
          jobId: jobReassign,
          visitId: first.visitId,
          outcomeCode: "no_access",
          completeWork: false,
        }),
      ),
    );
    checkTrue("an outcome against a retired visit is refused", outcomeRefusal !== null);
    checkTrue("and safely", outcomeRefusal?.userFacing === true);
    // The reason is asserted, not just the refusal. `recordJobOutcome` has
    // several other reasons to refuse — the mutation run proved this exact
    // check passing while retirement was disabled, on a refusal that had
    // nothing to do with the visit. A green assertion that cannot tell the two
    // apart is not testing the guard it is named after.
    checkTrue(
      "and because the visit was replaced, not for some other reason",
      (outcomeRefusal?.message ?? "").includes("replaced when the job was reassigned"),
    );

    // ══ 7. The schedule grid ══════════════════════════════════════════════
    console.log("\n— the grid draws no block for a retired visit —");

    const dubaiDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dubai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(w1.start);

    const grid = await withTenant(ctx, (tx) =>
      loadSchedule(tx, { from: dubaiDay, days: 1, now: new Date() }),
    );
    checkTrue(
      "the retired visit is not on the grid",
      !grid.visits.some((v) => v.visitId === first.visitId),
    );
    // The positive half, on the same query and the same day.
    checkTrue(
      "the live visit is",
      grid.visits.some((v) => v.visitId === second.visitId),
    );

    const dragRefusal = await refusal(() =>
      withTenant(ctx, (tx) =>
        rescheduleVisit(tx, ctx, {
          visitId: first.visitId,
          scheduledStart: new Date(w1.start.getTime() + HOUR),
          calendar,
        }),
      ),
    );
    checkTrue("dragging a retired visit is refused", dragRefusal !== null);
    checkTrue("and safely", dragRefusal?.userFacing === true);
    checkTrue(
      "and says it was replaced rather than claiming it happened",
      (dragRefusal?.message ?? "").includes("nothing here to move"),
    );

    // ══ 8. The handset ════════════════════════════════════════════════════
    //
    // The most user-visible half of the bug, and the one nothing else here
    // covers: `pullWorkingSet` is the only thing that ever tells a technician
    // what they are on. A retired visit left in its scope keeps the job on the
    // phone of the person it was taken off, for as long as the job stays open —
    // and they would go to it.
    console.log("\n— the job leaves the handset it was taken off —");

    const phoneA = await withTenant(ctx, (tx) => pullWorkingSet(tx, { technicianId: techA }));
    const phoneB = await withTenant(ctx, (tx) => pullWorkingSet(tx, { technicianId: techB }));

    checkTrue(
      "the reassigned job is off A's phone",
      !phoneA.jobs.some((j) => j.id === jobReassign),
    );
    // The positive half, on the same call: the sync has not simply gone empty.
    checkTrue(
      "and on B's",
      phoneB.jobs.some((j) => j.id === jobReassign),
    );
    check(
      "and B is handed the live visit's id, not the retired one",
      phoneB.jobs.find((j) => j.id === jobReassign)?.visitId,
      second.visitId,
    );

    // ══ 9. The retirement is on the record ════════════════════════════════
    console.log("\n— retiring a visit is an auditable act —");

    const noted = await withTenant(ctx, async (tx) => {
      const rows = (await tx.execute<{ n: string }>(sql`
        select count(*) as n from audit_log
         where table_name = 'job_visits'
           and action = 'superseded'
           and record_id = ${first.visitId}::uuid
      `)) as unknown as { n: string }[];
      return Number(rows[0]?.n ?? 0);
    });
    check("the retirement is in the audit log, once", noted, 1);
  } finally {
    await purgeOwn(TENANT, made.techIds);
  }

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeConnection);
