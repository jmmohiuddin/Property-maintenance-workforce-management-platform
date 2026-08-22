/**
 * Jobs: the schedule (`JOB-7`) and keyset paging (`LEAD-8`) — integration test
 * against real Postgres.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself,
 * except for `audit_log`: `meridian_app` holds no DELETE on that table by
 * design, and a test that could tidy the audit trail would be testing a
 * database that is not the one in production.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * Four claims, and the first two are the ones that would fail silently.
 *
 * **Paging cannot skip a job.** A cursor is only worth having if a row inserted
 * mid-page cannot push another row across the boundary and out of sight. That
 * is tested by inserting one, mid-page, and looking.
 *
 * **A headline count is not a page count.** The trap `LEAD-8` names: totals
 * derived from a paginated array silently become page-one totals. Every count
 * here is asserted to move independently of the page.
 *
 * **A day boundary is a Dubai day boundary.** A visit at 00:30 Dubai is 20:30
 * the previous day in UTC, and bucketing it in JavaScript puts it on the wrong
 * row of the schedule for exactly the people who start early. Asserted against
 * an instant chosen to straddle it.
 *
 * **The midday ban is a wall.** `JOB-6` — AED 5,000 per worker, capped at
 * AED 50,000, plus a company classification downgrade. An outdoor visit cannot
 * be dragged into 12:30–15:00 in July, and an indoor one is not stopped, which
 * is the half that gets over-blocked when people only test the first.
 *
 * ── WHY EVERY DB ASSERTION IS A DELTA ───────────────────────────────────────
 *
 * Same rule as `compliance.test.ts` and `contracts.test.ts`. This database is
 * shared and seeded; a suite that only passes against a pristine one fails on
 * somebody's laptop for reasons unrelated to the code, and the usual response
 * to that is to stop trusting the suite.
 */

import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import {
  withTenant,
  schema,
  closeConnection,
  searchJobs,
  countJobs,
  listDispatchBoard,
  dispatchBoardCounts,
  loadSchedule,
  rescheduleVisit,
  transitionJob,
  recordJobOutcome,
  raiseReturnVisit,
  getJobDetail,
} from "../src/index";
import { slaState, UserFacingError, DEFAULT_MIDDAY_BAN, formatMinute, type JobStatus } from "@meridian/core";
import { testTenantId } from "./_tenant";

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const TOKEN = `ZZSCHED${RUN}`;

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** Dubai wall time as an instant. The UAE has no daylight saving, so +04:00 is exact. */
function dubai(iso: string): Date {
  return new Date(`${iso}+04:00`);
}

const MINUTE = 60_000;

/**
 * Reap the technician a killed run of this file left behind.
 *
 * This suite's own technician (`__TEST scheduler ${RUN}`, below) is deleted by
 * ID at the end of a clean run, but a run that dies first — a failed assertion
 * that threw, a killed process — never reaches that block, and the row is
 * orphaned for good: it sorts ahead of the seeded roster and gets picked up by
 * anything that reads the `technicians` table positionally, most notably
 * `workforce.test.ts`.
 *
 * Age-gated to an hour, far longer than this suite takes, so it cannot reach a
 * concurrent run's live fixture — same shape as `sweepStale()` in
 * `recruitment.test.ts`. `job_visits.technician_id` is `ON DELETE RESTRICT`, so
 * a leaked technician's visits have to go first; the parent jobs are left for
 * `jobs`' own housekeeping rather than swept here, to keep this narrowly about
 * the table that breaks other suites.
 */
async function sweepStale(ctx: { tenantId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const stale = await tx
      .select({ id: schema.technicians.id })
      .from(schema.technicians)
      .where(
        and(
          like(schema.technicians.fullName, "__TEST scheduler %"),
          lt(schema.technicians.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    if (stale.length === 0) return;
    const staleIds = stale.map((t) => t.id);
    await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.technicianId, staleIds));
    await tx.delete(schema.technicians).where(inArray(schema.technicians.id, staleIds));
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId };

  await sweepStale(ctx);

  const createdJobs: string[] = [];
  const createdVisits: string[] = [];
  const createdLeave: string[] = [];
  let technicianId = "";

  // ── Fixtures ─────────────────────────────────────────────────────────────

  const found = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.properties.id, customerId: schema.properties.customerId })
      .from(schema.properties)
      .limit(1);
    return rows[0] ?? null;
  });
  if (!found) throw new Error("Seed data missing. Run `npm run db:seed` first.");
  const site = found;

  // This test's own technician, not a seeded one: it books approved leave, and
  // borrowing somebody else's calendar to do that would change what a parallel
  // suite sees on the workforce board.
  technicianId = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.technicians)
      .values({
        tenantId,
        employeeCode: `ZZ-${RUN}`,
        fullName: `__TEST scheduler ${RUN}`,
        phone: "+971500000000",
        primaryTrade: "hvac-installation-maintenance",
      })
      .returning({ id: schema.technicians.id });
    if (!row) throw new Error("could not create the test technician");
    return row.id;
  });

  const now = new Date();

  /** One job, with the SLA clock set to produce a known state. */
  async function makeJob(input: {
    suffix: string;
    title: string;
    /*
     * The whole status union, not the two this helper happened to be used with.
     * It read `"triaged" | "closed"` because nothing had ever made a job in any
     * other state, so the first fixture that needed `dispatched` broke the
     * compile -- and did so silently under `tsx`, which transpiles without
     * typechecking, so the test ran and passed while the gate was red.
     */
    status: JobStatus;
    createdAt?: Date;
    resolveByAt?: Date | null;
    completedAt?: Date | null;
    isOutdoor?: boolean;
  }): Promise<string> {
    return withTenant(ctx, async (tx) => {
      const [row] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `ZZ-${RUN}-${input.suffix}`,
          customerId: site.customerId,
          propertyId: site.id,
          serviceSlug: "hvac-installation-maintenance",
          title: input.title,
          status: input.status,
          isOutdoor: input.isOutdoor ?? false,
          ...(input.createdAt ? { createdAt: input.createdAt } : {}),
          ...(input.resolveByAt !== undefined ? { resolveByAt: input.resolveByAt } : {}),
          ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        })
        .returning({ id: schema.jobs.id });
      if (!row) throw new Error("could not create a test job");
      createdJobs.push(row.id);
      return row.id;
    });
  }

  async function makeVisit(
    jobId: string,
    scheduledStart: Date,
    sequence = 1,
    status: "assigned" | "completed" = "assigned",
  ): Promise<string> {
    return withTenant(ctx, async (tx) => {
      const [row] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId,
          jobId,
          technicianId,
          sequence,
          status,
          scheduledStart,
          scheduledEnd: new Date(scheduledStart.getTime() + 120 * MINUTE),
        })
        .returning({ id: schema.jobVisits.id });
      if (!row) throw new Error("could not create a test visit");
      createdVisits.push(row.id);
      return row.id;
    });
  }

  // ── LEAD-8. Paging is a total order, and it cannot skip a row ────────────
  //
  // Deliberately created with a tie: three of these share an exact created_at,
  // which is the case the id half of the cursor exists for. Without it the
  // boundary is ambiguous and one of the tied rows is dropped or repeated for
  // ever.
  const tie = new Date("2027-03-01T08:00:00.000Z");
  const pagingIds = [
    await makeJob({ suffix: "P1", title: `${TOKEN} first`, status: "closed", createdAt: new Date(tie.getTime() + 3 * MINUTE) }),
    await makeJob({ suffix: "P2", title: `${TOKEN} second`, status: "closed", createdAt: new Date(tie.getTime() + 2 * MINUTE) }),
    await makeJob({ suffix: "P3", title: `${TOKEN} third`, status: "closed", createdAt: tie }),
    await makeJob({ suffix: "P4", title: `${TOKEN} fourth`, status: "closed", createdAt: tie }),
    await makeJob({ suffix: "P5", title: `${TOKEN} fifth`, status: "closed", createdAt: tie }),
  ];

  const total = await withTenant(ctx, (tx) => countJobs(tx, { q: TOKEN, statuses: undefined }));
  check("countJobs finds every job matching the search", total, pagingIds.length);

  const firstPage = await withTenant(ctx, (tx) => searchJobs(tx, { q: TOKEN, limit: 2 }));
  check("a page is the size asked for, not the size of the result set", firstPage.rows.length, 2);
  checkTrue("a page that is not the last carries a cursor", firstPage.nextCursor !== null);
  checkTrue(
    "the total is not the page — it is larger, and independent of it",
    total > firstPage.rows.length,
  );

  // A job arriving mid-page. Under OFFSET this shifts every later page by one
  // and a row is silently never seen; under keyset the cursor is a position in
  // the ordering, so it cannot.
  const interloper = await makeJob({
    suffix: "P6",
    title: `${TOKEN} raised while paging`,
    status: "closed",
    createdAt: new Date(tie.getTime() + 10 * MINUTE),
  });

  const seen: string[] = firstPage.rows.map((r) => r.id);
  let cursor = firstPage.nextCursor;
  let guard = 0;
  while (cursor && guard++ < 20) {
    const next: { rows: readonly { id: string }[]; nextCursor: string | null } = await withTenant(
      ctx,
      (tx) => searchJobs(tx, { q: TOKEN, limit: 2, cursor: cursor ?? undefined }),
    );
    seen.push(...next.rows.map((r) => r.id));
    cursor = next.nextCursor;
  }

  check("paging reaches every row it started with", new Set(seen).size, pagingIds.length);
  check("paging returns no row twice", seen.length, new Set(seen).size);
  checkTrue(
    "a job raised mid-page does not displace one that was already listed",
    pagingIds.every((id) => seen.includes(id)),
  );
  checkTrue(
    "and the newcomer, being newer than the cursor, is not spliced into a later page",
    !seen.includes(interloper),
  );

  // ── LEAD-8. The counts are the tenant's, not the page's ──────────────────
  //
  // Four jobs with known SLA states, asserted as deltas, and each one also
  // classified by `slaState` in TypeScript so the SQL mirror in
  // `dispatchBoardCounts` cannot drift from the definition it restates.
  const before = await withTenant(ctx, (tx) => dispatchBoardCounts(tx, now, ["triaged"]));

  const slaFixtures = [
    {
      suffix: "S1",
      state: "breached" as const,
      createdAt: new Date(now.getTime() - 200 * MINUTE),
      resolveByAt: new Date(now.getTime() - 10 * MINUTE),
    },
    {
      suffix: "S2",
      state: "at_risk" as const,
      createdAt: new Date(now.getTime() - 100 * MINUTE),
      resolveByAt: new Date(now.getTime() + 5 * MINUTE),
    },
    {
      suffix: "S3",
      state: "on_track" as const,
      createdAt: new Date(now.getTime() - 5 * MINUTE),
      resolveByAt: new Date(now.getTime() + 1000 * MINUTE),
    },
    { suffix: "S4", state: "none" as const, createdAt: now, resolveByAt: null },
  ];

  for (const f of slaFixtures) {
    await makeJob({
      suffix: f.suffix,
      title: `${TOKEN} sla ${f.suffix}`,
      status: "triaged",
      createdAt: f.createdAt,
      resolveByAt: f.resolveByAt,
    });
    check(
      `slaState agrees this fixture is ${f.state}`,
      slaState({ createdAt: f.createdAt, resolveByAt: f.resolveByAt, completedAt: null, now }),
      f.state,
    );
  }

  const after = await withTenant(ctx, (tx) => dispatchBoardCounts(tx, now, ["triaged"]));
  check("the open count rises by every job added", after.open - before.open, 4);
  check("the SQL breach filter matches slaState", after.breached - before.breached, 1);
  check("the SQL at-risk filter matches slaState", after.atRisk - before.atRisk, 1);
  check("a job with nobody on it counts as unassigned", after.unassigned - before.unassigned, 4);

  // ── JOB-12. A job with two visits is one job ─────────────────────────────
  const multiVisit = await makeJob({
    suffix: "MV",
    title: `${TOKEN} parts on order`,
    status: "triaged",
    createdAt: now,
    resolveByAt: new Date(now.getTime() + 1000 * MINUTE),
  });
  await makeVisit(multiVisit, dubai("2027-05-04T09:00:00"), 1, "completed");
  await makeVisit(multiVisit, dubai("2027-05-06T09:00:00"), 2, "assigned");

  const board = await withTenant(ctx, (tx) => listDispatchBoard(tx, { now, statuses: ["triaged"], limit: 1000 }));
  check(
    "a two-visit job appears on the board once, not once per visit",
    board.filter((r) => r.id === multiVisit).length,
    1,
  );
  check(
    "and it shows the latest visit's technician rather than an arbitrary one",
    board.find((r) => r.id === multiVisit)?.technicianName ?? null,
    `__TEST scheduler ${RUN}`,
  );

  const withVisits = await withTenant(ctx, (tx) => dispatchBoardCounts(tx, now, ["triaged"]));
  check("it raises the open count by one, not by two", withVisits.open - after.open, 1);
  check("and it is not counted as unassigned", withVisits.unassigned - after.unassigned, 0);

  // ── JOB-7. A day boundary is a Dubai day boundary ────────────────────────
  //
  // 00:30 on 2 July in Dubai is 20:30 on 1 July in UTC. A schedule that buckets
  // in the server's own zone puts this visit on the first — one row wrong, once,
  // for whoever starts early, which is the sort of bug that gets explained away
  // as somebody misreading the screen.
  const earlyJob = await makeJob({
    suffix: "EB",
    title: `${TOKEN} half past midnight`,
    status: "triaged",
    createdAt: now,
  });
  await makeVisit(earlyJob, dubai("2027-07-02T00:30:00"));

  const july2 = await withTenant(ctx, (tx) => loadSchedule(tx, { from: "2027-07-02", days: 1, now }));
  const placed = july2.visits.find((v) => v.jobId === earlyJob);
  check("a 00:30 Dubai visit lands on that Dubai day", placed?.day ?? null, "2027-07-02");
  check("and at the right minute of it", placed?.startMinute ?? -1, 30);

  const july1 = await withTenant(ctx, (tx) => loadSchedule(tx, { from: "2027-07-01", days: 1, now }));
  checkTrue(
    "and not on the UTC day it would fall on",
    !july1.visits.some((v) => v.jobId === earlyJob),
  );

  const week = await withTenant(ctx, (tx) => loadSchedule(tx, { from: "2027-07-01", days: 7, now }));
  check("a week is seven days", week.days.length, 7);
  check("and its last day is the seventh", week.to, "2027-07-07");
  check("generated by Postgres, in order", week.days[0] ?? "", "2027-07-01");
  checkTrue(
    "the lane roster includes this test's technician",
    week.lanes.some((l) => l.technicianId === technicianId),
  );
  checkTrue(
    "the schedule carries the tenant's calendar, not a default one assembled in the page",
    week.calendar.middayBan.startMinute === DEFAULT_MIDDAY_BAN.startMinute &&
      Array.isArray(week.calendar.weekend),
  );

  // The rail's total is its own aggregate. S1..S4 have no visits, so they are
  // all on it — and the number beside it must count them whatever the cap does.
  checkTrue(
    "unplaced work is counted tenant-wide, not by the length of the rail",
    week.unplacedTotal >= week.unplaced.length,
  );

  // ── JOB-6. The wall ──────────────────────────────────────────────────────
  const outdoorJob = await makeJob({
    suffix: "OD",
    title: `${TOKEN} roof unit`,
    status: "triaged",
    createdAt: now,
    isOutdoor: true,
  });
  const outdoorVisit = await makeVisit(outdoorJob, dubai("2027-05-04T09:00:00"));

  const indoorJob = await makeJob({
    suffix: "IN",
    title: `${TOKEN} plant room`,
    status: "triaged",
    createdAt: now,
    isOutdoor: false,
  });
  const indoorVisit = await makeVisit(indoorJob, dubai("2027-05-04T09:00:00"));

  const banStart = formatMinute(DEFAULT_MIDDAY_BAN.startMinute);
  let refusal = "";
  try {
    await withTenant(ctx, (tx) =>
      rescheduleVisit(tx, ctx, {
        visitId: outdoorVisit,
        scheduledStart: dubai("2027-07-01T13:00:00"),
      }),
    );
  } catch (error) {
    refusal = error instanceof UserFacingError ? error.message : `not user-facing: ${String(error)}`;
  }
  checkTrue(
    `an outdoor visit cannot be moved into the ${banStart} ban window in July`,
    refusal.includes("AED 5,000"),
  );

  // The other half, which over-blocking would break: 13:00 in a plant room is
  // lawful work and the scheduler must not refuse it.
  const indoorMoved = await withTenant(ctx, (tx) =>
    rescheduleVisit(tx, ctx, {
      visitId: indoorVisit,
      scheduledStart: dubai("2027-07-01T13:00:00"),
    }),
  );
  check(
    "an indoor visit moves through the same window",
    indoorMoved.scheduledStart.toISOString(),
    dubai("2027-07-01T13:00:00").toISOString(),
  );

  const scheduledFor = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ scheduledFor: schema.jobs.scheduledFor })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, indoorJob));
    return rows[0]?.scheduledFor ?? null;
  });
  check(
    "the job's own scheduled_for follows the visit rather than disagreeing with it",
    scheduledFor?.toISOString() ?? null,
    dubai("2027-07-01T13:00:00").toISOString(),
  );

  // Filtered on the action, not "the latest row": the row trigger writes an
  // `insert` row for the visit too, and taking whichever came back first would
  // pass whether or not `rescheduleVisit` audited anything at all.
  const audited = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<Record<string, never>>(sql`
      select count(*) as n
        from audit_log
       where table_name = 'job_visits'
         and record_id = ${indoorVisit}::uuid
         and action = 'rescheduled'
         and changed_fields ->> 'rule' = 'JOB-7'
    `)) as unknown as { n: string }[];
    return Number(rows[0]?.n ?? 0);
  });
  check("and the move is on the audit trail, with the rule that governs it", audited, 1);

  // ── HR-7 into JOB-8. Approved leave is not schedulable time ──────────────
  await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.leaveRequests)
      .values({
        tenantId,
        technicianId,
        kind: "annual",
        startsOn: dubai("2027-08-09T00:00:00"),
        endsOn: dubai("2027-08-11T00:00:00"),
        status: "approved",
      })
      .returning({ id: schema.leaveRequests.id });
    if (row) createdLeave.push(row.id);
  });

  let leaveRefusal = "";
  try {
    await withTenant(ctx, (tx) =>
      rescheduleVisit(tx, ctx, {
        visitId: indoorVisit,
        // 09:00, so the midday ban cannot be what refuses this.
        scheduledStart: dubai("2027-08-10T09:00:00"),
      }),
    );
  } catch (error) {
    leaveRefusal = error instanceof UserFacingError ? error.message : String(error);
  }
  checkTrue(
    "a visit cannot be moved onto a day the technician is on approved leave",
    leaveRefusal.includes("approved annual leave"),
  );

  const laneWithLeave = await withTenant(ctx, (tx) =>
    loadSchedule(tx, { from: "2027-08-09", days: 3, now }),
  );
  const lane = laneWithLeave.lanes.find((l) => l.technicianId === technicianId);
  check("and the schedule shows that leave on their lane", lane?.leaveDays.length ?? 0, 3);

  // A pending request is a request. Greying a lane out for one would have the
  // dispatcher planning around an absence nobody has agreed to.
  await withTenant(ctx, (tx) =>
    tx
      .update(schema.leaveRequests)
      .set({ status: "pending" })
      .where(inArray(schema.leaveRequests.id, createdLeave)),
  );
  const laneWithoutLeave = await withTenant(ctx, (tx) =>
    loadSchedule(tx, { from: "2027-08-09", days: 3, now }),
  );
  check(
    "pending leave does not block the lane",
    laneWithoutLeave.lanes.find((l) => l.technicianId === technicianId)?.leaveDays.length ?? -1,
    0,
  );

  // ── A visit that has already happened is a record, not a plan ────────────
  await withTenant(ctx, (tx) =>
    tx.update(schema.jobVisits).set({ status: "completed" }).where(eq(schema.jobVisits.id, indoorVisit)),
  );
  let settledRefusal = "";
  try {
    await withTenant(ctx, (tx) =>
      rescheduleVisit(tx, ctx, { visitId: indoorVisit, scheduledStart: dubai("2027-05-05T09:00:00") }),
    );
  } catch (error) {
    settledRefusal = error instanceof UserFacingError ? error.message : String(error);
  }
  checkTrue(
    "a completed visit cannot be rescheduled",
    settledRefusal.includes("cannot be rescheduled"),
  );

  // ── Revisit tracking: `parentJobId` / `isRevisit`, wired for the first time ─
  //
  // `raiseReturnVisit` is gated on the PARENT job's own recorded outcome, so
  // every case below records one first with `recordJobOutcome({ completeWork:
  // false })` — a correction-only call that sets `outcome_code` without moving
  // the job (avoiding the JOB-15 job-card gate, which is not what this suite
  // is testing).

  // Positive: an outcome that calls for a return visit (`no_access`) lets one
  // be raised, and the new job says so and names its parent.
  const revisitParent = await makeJob({ suffix: "REVISIT-PARENT", title: `${TOKEN} revisit parent`, status: "on_site" });
  await withTenant(ctx, (tx) =>
    recordJobOutcome(tx, ctx, { jobId: revisitParent, outcomeCode: "no_access", completeWork: false }),
  );
  const revisit = await withTenant(ctx, (tx) => raiseReturnVisit(tx, ctx, { parentJobId: revisitParent }));
  createdJobs.push(revisit.jobId);
  checkTrue("raising a return visit yields a new job", revisit.jobId !== revisitParent);

  const revisitDetail = await withTenant(ctx, (tx) => getJobDetail(tx, revisit.jobId));
  check("the new job names its parent", revisitDetail?.parentJobId, revisitParent);
  checkTrue("the new job is flagged as a revisit", revisitDetail?.isRevisit === true);
  checkTrue(
    "the new job carries the parent's own reference for display",
    (revisitDetail?.parentJobReference ?? "").includes(`ZZ-${RUN}-REVISIT-PARENT`),
  );
  checkTrue("the return visit gets an SLA clock of its own", revisitDetail?.resolveByAt != null);

  // Load-bearing positive on the OTHER side: an ordinary job raised by
  // `makeJob` (not through `raiseReturnVisit`) has both columns null — the
  // "do not backfill" guarantee, checked directly rather than assumed.
  const ordinaryJob = await makeJob({ suffix: "ORDINARY", title: `${TOKEN} ordinary job`, status: "triaged" });
  const ordinaryDetail = await withTenant(ctx, (tx) => getJobDetail(tx, ordinaryJob));
  check("an ordinary job has no parent", ordinaryDetail?.parentJobId, null);
  checkTrue("and is not flagged as a revisit", ordinaryDetail?.isRevisit === false);

  // Negative: an outcome that does NOT call for a return visit (`completed`)
  // refuses to raise one.
  const noReturnParent = await makeJob({ suffix: "NORETURN", title: `${TOKEN} no return needed`, status: "on_site" });
  await withTenant(ctx, (tx) =>
    recordJobOutcome(tx, ctx, { jobId: noReturnParent, outcomeCode: "completed", completeWork: false }),
  );
  let noReturnRefusal = "";
  try {
    await withTenant(ctx, (tx) => raiseReturnVisit(tx, ctx, { parentJobId: noReturnParent }));
  } catch (error) {
    noReturnRefusal = error instanceof UserFacingError ? error.message : String(error);
  }
  checkTrue(
    "an outcome that does not require a return visit refuses to raise one",
    noReturnRefusal.includes("does not call for a return visit"),
  );

  // Negative: a job with no recorded outcome at all refuses too — there is
  // nothing yet to justify a return visit against.
  const noOutcomeParent = await makeJob({ suffix: "NOOUTCOME", title: `${TOKEN} no outcome yet`, status: "on_site" });
  let noOutcomeRefusal = "";
  try {
    await withTenant(ctx, (tx) => raiseReturnVisit(tx, ctx, { parentJobId: noOutcomeParent }));
  } catch (error) {
    noOutcomeRefusal = error instanceof UserFacingError ? error.message : String(error);
  }
  checkTrue(
    "a job with no recorded outcome refuses a return visit",
    noOutcomeRefusal.includes("no recorded outcome"),
  );

  // ── Clean-up: nothing this test wrote should outlive it ──────────────────
  await withTenant(ctx, async (tx) => {
    if (createdLeave.length > 0) {
      await tx.delete(schema.leaveRequests).where(inArray(schema.leaveRequests.id, createdLeave));
    }
    if (createdVisits.length > 0) {
      await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.id, createdVisits));
    }
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, createdJobs));
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, createdJobs));
    }
    if (technicianId) {
      await tx
        .delete(schema.technicians)
        .where(and(eq(schema.technicians.id, technicianId), eq(schema.technicians.tenantId, tenantId)));
    }
  });

  /*
   * ── on_site sets first_response_at, and the call does not throw ──────────
   *
   * transitionJob(to: "on_site") threw for EVERY caller. The branch built
   * `sql`coalesce(col, ${now})`` with a JS Date, which the driver stringifies
   * as "Sat Aug 22 2026 08:59:33" and then refuses to bind -- an
   * ERR_INVALID_ARG_TYPE raised before the statement reaches Postgres, and not
   * a UserFacingError, so a field sync batch lost every mutation queued behind
   * the arrival and a dispatcher marking somebody on site got a 500.
   *
   * It survived because no suite moved a job to on_site: this one did not,
   * assignment.test.ts did not, and projects.test.ts's `to: "on_site"` is
   * `transitionProject`, a different function entirely. It was found by
   * connecting the field client to a real server over HTTP.
   *
   * The second assertion is the one that matters. A broken expression that
   * quietly wrote NULL would satisfy "it did not throw", and first_response_at
   * is what every SLA response figure is measured from.
   */
  const arriving = await makeJob({ suffix: "ONSITE", title: `${TOKEN} arriving`, status: "dispatched" });
  await withTenant({ tenantId }, async (tx) => {
    await transitionJob(tx, { tenantId }, { jobId: arriving, to: "en_route" });
    await transitionJob(tx, { tenantId }, { jobId: arriving, to: "on_site" });
    const [row] = (await tx
      .select({ status: schema.jobs.status, firstResponseAt: schema.jobs.firstResponseAt })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, arriving))) as { status: string; firstResponseAt: Date | null }[];
    check("a job can be moved on site at all", row?.status, "on_site");
    checkTrue("and arriving stamps first_response_at rather than leaving it null", row?.firstResponseAt != null);
  });

  console.log(fail === 0 ? "\nall jobs checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
