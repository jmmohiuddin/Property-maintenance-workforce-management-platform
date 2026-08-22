/**
 * `PRJ-2`, second half: a phase produces `Job`s for daily execution.
 *
 *   npx tsx test/projects-phase-jobs.test.ts
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * Phases, weights, dependencies and `attachJobToPhase` were all built with
 * `PRJ-2` and were all correct. Nothing ever *called* `attachJobToPhase`, so no
 * phase had ever produced a job, every Jobs count on the phase table rendered
 * zero, and the second half of the requirement did not exist. `raiseJobForPhase`
 * closes that, and the whole risk in closing it is the shortcut it did not take.
 *
 * A projects module that raised its own jobs with a hand-rolled
 * `insert(schema.jobs)` would work perfectly on the day it was written and
 * would quietly diverge from the ordinary job path afterwards. That is not
 * hypothetical: the web assignment path was found this week to have been
 * silently skipping the summer midday ban for exactly that reason, and the ban
 * carries AED 5,000 per worker, capped at AED 50,000, plus a company
 * classification downgrade.
 *
 * So the four things asserted below are the four things the shortcut loses:
 *
 * **The stored calendar reaches the SLA clock.** `computeSlaDeadlines` takes a
 * calendar as its fourth argument and falls back to `DEFAULT_CALENDAR` — whose
 * public-holiday list is deliberately EMPTY — when none is given. A test that
 * merely asserted "respond_by_at is not null" would pass against code that
 * passed `undefined` there, which is the bug. The assertion below inserts
 * public holidays into the *stored* calendar and then requires the deadline to
 * match the stored-calendar answer and to differ from the default-calendar
 * answer by weeks. It cannot pass both ways.
 *
 * **`is_outdoor` round-trips and is what the ban check reads.** Including that
 * it defaults to the *safe* direction when the caller says nothing.
 *
 * **The link is made exactly once.** `project_phase_jobs` has a unique index on
 * (tenant, job) and `attachJobToPhase` leans on it; raising twice must produce
 * two jobs with one link each, not one job with two.
 *
 * **The reference comes from the database.** `app_next_reference('JOB', …)`,
 * never `count(*) + 1`.
 *
 * ── WHY EVERY DB ASSERTION IS ANCHORED TO `TAG` ─────────────────────────────
 *
 * Same rule as `projects.test.ts`. A suite that only passes against a pristine
 * database fails on somebody's laptop for reasons that have nothing to do with
 * the code, and the usual response is to stop trusting the suite. The dev
 * database this runs against is shared, so every delete below is anchored to
 * `TAG` and to ids this file created.
 */

import { sql } from "drizzle-orm";
// No bare `db` handle here on purpose. Every table this file touches is
// policied on `app_current_tenant()`, so a query outside `withTenant` reads zero
// rows from a database that still holds every one of them.
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  addPhase,
  addPublicHoliday,
  attachJobToPhase,
  createProject,
  getProject,
  listPhaseJobs,
  loadWorkingCalendar,
  raiseJobForPhase,
  transitionJob,
  transitionProject,
} from "../src/domain";
import {
  checkOutdoorWindow,
  checkOutdoorWork,
  computeSlaDeadlines,
  dubaiDateKey,
  fromDubai,
  toDubai,
  DEFAULT_CALENDAR,
  UserFacingError,
  type JobPriority,
  type WorkingCalendar,
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

/**
 * Assert that a call is refused, and refused with a message a human wrote.
 *
 * The second half matters as much as the first. A gate that throws the driver's
 * error is a gate whose message is a SQL statement with parameters in it, and
 * this codebase renders only `UserFacingError`.
 */
async function refuses(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — expected a refusal, the call succeeded`);
  } catch (error) {
    const userFacing = error instanceof UserFacingError;
    if (!userFacing) fail++;
    console.log(
      `${userFacing ? "ok  " : "FAIL"}  ${label}` +
        (userFacing ? "" : ` — threw ${(error as Error)?.name}, not a UserFacingError`),
    );
  }
}

const TAG = "PRJ2JOB-TEST";
const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Deliberate rollback. Thrown to unwind a transaction whose writes must not land. */
class Rollback extends Error {
  constructor() {
    super("rollback");
    this.name = "Rollback";
  }
}

const day = (offsetMs: number) => dubaiDateKey(new Date(Date.now() + offsetMs));

// ── Part 1: the ban, with no database at all ─────────────────────────────────

/**
 * What `is_outdoor` actually gates.
 *
 * `raiseJobForPhase` does not call these — job creation never has, in any of
 * the three ordinary paths, because a job has no end instant to check a window
 * against. `scheduled_for` is an intention; the booking is a visit. The ban is
 * enforced where the work is placed, in `scheduleVisit` (`jobs.ts`) and
 * `assignTechnician` (`assignment.ts`), and both of those read `jobs.is_outdoor`
 * off the row this module writes.
 *
 * So this part establishes what the flag is worth, and part 3 proves the value
 * written to the column is the value those two functions would read.
 */
function testTheBanItself(): void {
  console.log("\n— JOB-6: what is_outdoor gates —");

  // 1 July, 13:00 Dubai. Inside the season (15 June – 15 September) and inside
  // the window (12:30 – 15:00).
  const inBan = fromDubai(2026, 7, 1, 13 * 60);
  const banned = checkOutdoorWork(inBan, DEFAULT_CALENDAR);
  check("outdoor work at 13:00 on 1 July is refused", banned.allowed, false);
  checkTrue(
    "and the refusal states the penalty as a number, not as 'risk'",
    (banned.message ?? "").includes("AED 5,000 per worker"),
  );
  check(
    "the alternative offered is 15:00, after the ban, not before it",
    banned.nextAllowed ? toDubai(banned.nextAllowed).minutesOfDay : -1,
    15 * 60,
  );

  // The obvious bug in the obvious implementation: a window that starts legally
  // and becomes illegal at 12:30.
  const startsLegal = checkOutdoorWindow(
    fromDubai(2026, 7, 1, 11 * 60),
    fromDubai(2026, 7, 1, 14 * 60),
    DEFAULT_CALENDAR,
  );
  check("an 11:00–14:00 window is refused even though 11:00 is legal", startsLegal.allowed, false);

  // And the same instant in January is ordinary working time.
  check(
    "the same 13:00 in January is allowed — it is a season, not a clock",
    checkOutdoorWork(fromDubai(2026, 1, 15, 13 * 60), DEFAULT_CALENDAR).allowed,
    true,
  );
}

// ── Part 2: the helpers the DB part reads with ───────────────────────────────

// A type alias rather than an interface: `tx.execute<T>` constrains T to
// `Record<string, unknown>`, and only an alias gets the implicit index signature
// that satisfies it.
type JobRow = {
  readonly id: string;
  readonly reference: string;
  readonly status: string;
  readonly priority: string;
  readonly source: string;
  readonly service_slug: string;
  readonly is_outdoor: boolean;
  readonly customer_id: string;
  readonly property_id: string;
  readonly project_id: string | null;
  /** Timestamps out of `tx.execute` are STRINGS, whatever the annotation says. */
  readonly respond_by_at: string | null;
  readonly resolve_by_at: string | null;
  readonly scheduled_for: string | null;
};

/**
 * Read a job back the way the production ban check reads it: off the row.
 *
 * Not from the input the test passed in. The coupling being asserted is between
 * the column and `checkOutdoorWindow`, and a test that fed its own variable back
 * to itself would prove nothing about the column.
 */
async function loadJob(tx: Parameters<Parameters<typeof withTenant>[1]>[0], jobId: string) {
  const rows = (await tx.execute<JobRow>(sql`
    select id, reference, status::text as status, priority::text as priority,
           source::text as source, service_slug, is_outdoor,
           customer_id, property_id, project_id,
           respond_by_at::text as respond_by_at,
           resolve_by_at::text as resolve_by_at,
           scheduled_for::text as scheduled_for
      from jobs
     where id = ${jobId}::uuid
  `)) as unknown as JobRow[];
  return rows[0];
}

// ── Part 3: against the database ─────────────────────────────────────────────

async function main(): Promise<void> {
  testTheBanItself();

  // Resolved by slug, not by taking whichever tenant sorts first. See
  // ./_tenant.ts — the tenant that sorts first is the deliberately-empty one.
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  let projectId = "";
  let sitelessProjectId = "";
  let phaseId = "";
  let untradedPhaseId = "";
  let cancelledPhaseId = "";
  const jobIds: string[] = [];

  try {
    await withTenant(ctx, async (tx) => {
      // ── Fixtures ───────────────────────────────────────────────────────
      const targets = (await tx.execute<{ property_id: string; customer_id: string }>(sql`
        select p.id as property_id, p.customer_id
          from properties p
          join customers c on c.id = p.customer_id
         where p.deleted_at is null and c.deleted_at is null
         order by p.created_at
         limit 1
      `)) as unknown as { property_id: string; customer_id: string }[];

      const target = targets[0];
      if (!target) {
        throw new Error("Need at least one customer with a property. Run `npm run db:seed`.");
      }

      console.log("\n— fixtures —");
      const created = await createProject(tx, ctx, {
        customerId: target.customer_id,
        propertyId: target.property_id,
        name: `${TAG} Level 9 fit-out`,
        scope: "Strip-out, partitions, MEP, joinery and handover.",
        contractValue: "620000.00",
        startsOn: day(-14 * DAY),
        targetCompletionOn: day(90 * DAY),
      });
      projectId = created.projectId;
      console.log(`      project ${created.reference}`);

      const phase = await addPhase(tx, ctx, {
        projectId,
        name: `${TAG} MEP first fix`,
        serviceSlug: "electrical",
        weightBasisPoints: 4000,
        plannedStartOn: day(0),
        plannedEndOn: day(30 * DAY),
      });
      phaseId = phase.phaseId;

      const untraded = await addPhase(tx, ctx, {
        projectId,
        name: `${TAG} handover clean`,
        weightBasisPoints: 500,
      });
      untradedPhaseId = untraded.phaseId;

      const cancelled = await addPhase(tx, ctx, {
        projectId,
        name: `${TAG} descoped joinery`,
        serviceSlug: "carpentry",
        weightBasisPoints: 0,
      });
      cancelledPhaseId = cancelled.phaseId;
      await tx.execute(sql`
        update project_phases set status = 'cancelled' where id = ${cancelledPhaseId}::uuid
      `);

      // ── The refusals that come before any job exists ────────────────────
      console.log("\n— PRJ-2: what a phase refuses to raise —");

      // The project is `quoted`. Nothing has been instructed, and a job here
      // would put a dispatchable, SLA-clocked instruction on the board for work
      // nobody has been asked to do.
      await refuses("a quoted project cannot raise work from a phase", () =>
        raiseJobForPhase(tx, ctx, { phaseId, title: "Pull cable to level 9" }),
      );

      await transitionProject(tx, ctx, { projectId, to: "awarded" });
      await transitionProject(tx, ctx, { projectId, to: "mobilising" });

      await refuses("a cancelled phase does not raise work", () =>
        raiseJobForPhase(tx, ctx, { phaseId: cancelledPhaseId, title: "Fit the joinery" }),
      );

      await refuses("a phase with no trade, and no trade chosen, is refused", () =>
        raiseJobForPhase(tx, ctx, { phaseId: untradedPhaseId, title: "Builder's clean" }),
      );

      await refuses("a phase that does not exist is not found in this tenant", () =>
        raiseJobForPhase(tx, ctx, {
          phaseId: "00000000-0000-0000-0000-000000000000",
          title: "Nothing",
        }),
      );

      // `projects.property_id` is nullable because a tender is priced before the
      // unit is identified. A job dispatches a technician to an address, so the
      // nullable column becomes a refusal at the point the address is needed.
      const siteless = await createProject(tx, ctx, {
        customerId: target.customer_id,
        name: `${TAG} unpriced tender, no building yet`,
        contractValue: "90000.00",
      });
      sitelessProjectId = siteless.projectId;
      await transitionProject(tx, ctx, { projectId: sitelessProjectId, to: "awarded" });
      const sitelessPhase = await addPhase(tx, ctx, {
        projectId: sitelessProjectId,
        name: `${TAG} enabling works`,
        serviceSlug: "handyman",
      });

      await refuses("a project with no property cannot raise a job — a job needs a site", () =>
        raiseJobForPhase(tx, ctx, { phaseId: sitelessPhase.phaseId, title: "Set up the hoarding" }),
      );

      // ── The job itself ─────────────────────────────────────────────────
      console.log("\n— PRJ-2: a phase produces a job —");

      const raised = await raiseJobForPhase(tx, ctx, {
        phaseId,
        title: `${TAG} Pull cable, level 9 north`,
        description: "Containment is in. Two men, one day.",
        priority: "p3_standard",
        scheduledFor: new Date(Date.now() + 3 * DAY),
      });
      jobIds.push(raised.jobId);

      // `app_next_reference('JOB', year)`, never `count(*) + 1`: counting races,
      // and under the customer-scope policies a portal read cannot even see the
      // number another customer already took.
      checkTrue(
        `the reference has the JOB-YYYY-NNNNN shape (${raised.reference})`,
        /^JOB-\d{4}-\d+$/.test(raised.reference),
      );
      check("and it is a fresh link, not a re-attach", raised.attached, true);

      const job = await loadJob(tx, raised.jobId);
      check("the job is triaged, not left in submitted", job?.status, "triaged");
      check("it carries the priority it was raised at", job?.priority, "p3_standard");
      // `job_source` has no project value and this branch does not own a
      // migration, so `internal` carries it and the link table carries the rest.
      check("its source is internal — no enum value was invented", job?.source, "internal");
      check("it takes the phase's own trade — 'assigned trades'", job?.service_slug, "electrical");
      check("the customer comes from the project", job?.customer_id, target.customer_id);
      check("and so does the site", job?.property_id, target.property_id);
      check("the job names its project for filtering", job?.project_id, projectId);
      checkTrue("an SLA response deadline was written", job?.respond_by_at != null);
      checkTrue("and a resolution deadline", job?.resolve_by_at != null);

      // An explicit trade overrides the phase's own.
      const overridden = await raiseJobForPhase(tx, ctx, {
        phaseId,
        title: `${TAG} Chase walls for containment`,
        serviceSlug: "handyman",
      });
      jobIds.push(overridden.jobId);
      check(
        "a trade chosen for the job overrides the phase's",
        (await loadJob(tx, overridden.jobId))?.service_slug,
        "handyman",
      );

      // ── The link, exactly once ─────────────────────────────────────────
      console.log("\n— PRJ-2: the link is made once —");

      const linkCount = async (jobId: string) => {
        const rows = (await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from project_phase_jobs where job_id = ${jobId}::uuid
        `)) as unknown as { count: number }[];
        return Number(rows[0]?.count ?? -1);
      };

      check("the job appears in project_phase_jobs exactly once", await linkCount(raised.jobId), 1);

      // A double click is not an error. `attachJobToPhase` leans on the unique
      // (tenant, job) index and `onConflictDoNothing`, and the second attempt
      // must be a no-op rather than a 500.
      const again = await attachJobToPhase(tx, ctx, { phaseId, jobId: raised.jobId });
      check("attaching the same job again reports no new link", again.attached, false);
      check("and did not create a second row", await linkCount(raised.jobId), 1);

      const phaseLinks = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from project_phase_jobs where phase_id = ${phaseId}::uuid
      `)) as unknown as { count: number }[];
      check("raising twice produced two links, one each", Number(phaseLinks[0]?.count), 2);

      // ── The timeline and the audit note ────────────────────────────────
      console.log("\n— PRJ-2: provenance —");

      const events = (await tx.execute<{ note: string; to_status: string; actor_kind: string }>(sql`
        select note, to_status, actor_kind
          from job_events
         where job_id = ${raised.jobId}::uuid
         order by occurred_at
      `)) as unknown as { note: string; to_status: string; actor_kind: string }[];

      check("the job's own timeline has the creation on it", events.length, 1);
      check("recorded as the triage it is", events[0]?.to_status, "triaged");
      checkTrue(
        "and the note names the project it came from",
        (events[0]?.note ?? "").includes("PRJ-"),
      );
      checkTrue(
        "and the phase, so nobody has to know the link table exists",
        (events[0]?.note ?? "").includes("MEP first fix"),
      );

      // Filtered by action, not counted. `audit_log` also carries a row written
      // by the table's own trigger for the insert, and a bare count would be an
      // assertion about the trigger rather than about this module.
      const audits = (await tx.execute<{ action: string }>(sql`
        select action from audit_log
         where table_name = 'jobs' and record_id = ${raised.jobId}::uuid
           and action = 'prj_job'
      `)) as unknown as { action: string }[];
      check("an audit note was written by this module", audits.length, 1);
      check("with the module's abbreviated action", audits[0]?.action, "prj_job");
      // `audit_log.action` is varchar(16). A longer string is a save that fails
      // at the driver rather than at a form.
      checkTrue(
        "which fits varchar(16)",
        (audits[0]?.action ?? "").length > 0 && (audits[0]?.action ?? "").length <= 16,
      );

      // ── The reads the phase panel needs ────────────────────────────────
      console.log("\n— PRJ-2: the phase panel stops rendering 0 —");

      const detail = await getProject(tx, projectId);
      const mep = detail?.phases.find((p) => p.id === phaseId);
      check("getProject's phase job count populates", mep?.jobCount, 2);
      check("and a phase that raised nothing still reads 0", detail?.phases.find((p) => p.id === untradedPhaseId)?.jobCount, 0);

      const rows = await listPhaseJobs(tx, projectId);
      check("listPhaseJobs returns both jobs", rows.length, 2);
      checkTrue(
        "each one carrying the phase it belongs to",
        rows.every((r) => r.phaseId === phaseId),
      );
      checkTrue(
        "and its reference, for the link to the jobs board",
        rows.every((r) => /^JOB-\d{4}-\d+$/.test(r.reference)),
      );
      checkTrue(
        "scheduled_for came back as a Date, not the string the driver returned",
        rows.some((r) => r.scheduledFor instanceof Date),
      );

      // ── The rest of the ordinary path ──────────────────────────────────
      //
      // A phase job is only worth raising if it can then be worked. This walks
      // one all the way to site through `transitionJob` — the same function
      // the dispatch board and the field app call — rather than asserting that
      // the row exists and stopping there.
      //
      // Worth its place for a specific reason: `transitionJob(to: "on_site")`
      // threw for every caller until this week. A JS `Date` interpolated into a
      // raw `sql` template was stringified into something the driver refused,
      // and nothing noticed because nothing in the suite moved a job to
      // on_site. A job that can be created and never arrive is not work.
      console.log("\n— PRJ-2: a phase job survives the ordinary execution path —");

      await transitionJob(tx, ctx, { jobId: raised.jobId, to: "dispatched" });
      await transitionJob(tx, ctx, { jobId: raised.jobId, to: "en_route" });
      await transitionJob(tx, ctx, { jobId: raised.jobId, to: "on_site" });

      const arrived = (await tx.execute<{ status: string; first_response_at: string | null }>(sql`
        select status, first_response_at::text as first_response_at
          from jobs where id = ${raised.jobId}::uuid
      `)) as unknown as { status: string; first_response_at: string | null }[];

      check("it reaches site through transitionJob", arrived[0]?.status, "on_site");
      // The column the fixed statement writes. Null here would mean the
      // transition succeeded while the clock it exists to stop never stopped.
      checkTrue("and arriving stopped the response clock", arrived[0]?.first_response_at !== null);

      // ── Terminal statuses ──────────────────────────────────────────────
      console.log("\n— PRJ-2: a finished project raises nothing —");

      await transitionProject(tx, ctx, { projectId: sitelessProjectId, to: "cancelled" });
      await refuses("a cancelled project cannot raise work from a phase", () =>
        raiseJobForPhase(tx, ctx, { phaseId: sitelessPhase.phaseId, title: "Too late" }),
      );
    });

    // ── The outdoor flag ───────────────────────────────────────────────────
    //
    // Committed, because the cleanup at the end removes them by id.
    console.log("\n— JOB-6: the flag the ban check reads —");

    await withTenant(ctx, async (tx) => {
      const explicitlyOutdoor = await raiseJobForPhase(tx, ctx, {
        phaseId,
        title: `${TAG} Cable tray on the roof deck`,
        isOutdoor: true,
      });
      jobIds.push(explicitlyOutdoor.jobId);

      const explicitlyIndoor = await raiseJobForPhase(tx, ctx, {
        phaseId,
        title: `${TAG} Second fix in the riser`,
        isOutdoor: false,
      });
      jobIds.push(explicitlyIndoor.jobId);

      const unsaid = await raiseJobForPhase(tx, ctx, {
        phaseId,
        title: `${TAG} Somebody did not say`,
      });
      jobIds.push(unsaid.jobId);

      const outdoorRow = await loadJob(tx, explicitlyOutdoor.jobId);
      const indoorRow = await loadJob(tx, explicitlyIndoor.jobId);
      const unsaidRow = await loadJob(tx, unsaid.jobId);

      check("an outdoor job round-trips as outdoor", outdoorRow?.is_outdoor, true);
      check("an indoor job round-trips as indoor", indoorRow?.is_outdoor, false);
      // The asymmetry: flagged-outdoor-when-indoors costs one re-submission
      // against a refusal that names the ban; not-flagged-when-outdoors costs
      // AED 5,000 per worker and is invisible until an inspector arrives.
      check("and saying nothing lands on the safe side of the ban", unsaidRow?.is_outdoor, true);

      // Now the coupling. This is the same call, with the same arguments, that
      // `scheduleVisit` (jobs.ts) and `assignTechnician` (assignment.ts) make —
      // both of them guarded by `if (job.is_outdoor)` on the value read above.
      const calendar = await loadWorkingCalendar(tx);
      const banStart = fromDubai(2026, 7, 1, 13 * 60);
      const banEnd = fromDubai(2026, 7, 1, 15 * 60);

      const outdoorGate = outdoorRow?.is_outdoor
        ? checkOutdoorWindow(banStart, banEnd, calendar)
        : { allowed: true as const };
      check("the flag off the row refuses a 13:00 slot in July", outdoorGate.allowed, false);

      const indoorGate = indoorRow?.is_outdoor
        ? checkOutdoorWindow(banStart, banEnd, calendar)
        : { allowed: true as const };
      check("and the indoor job in the same slot is not gated", indoorGate.allowed, true);

      const evening = outdoorRow?.is_outdoor
        ? checkOutdoorWindow(fromDubai(2026, 7, 1, 16 * 60), fromDubai(2026, 7, 1, 18 * 60), calendar)
        : { allowed: true as const };
      check("the outdoor job at 16:00 is allowed — the ban is a window", evening.allowed, true);
    });

    // ── The stored calendar reaches the SLA clock ──────────────────────────
    //
    // ── WHY THIS RUNS INSIDE A TRANSACTION THAT IS THROWN AWAY ────────────
    //
    // It has to write public holidays into the tenant's *stored* calendar to
    // have anything to discriminate against, and the calendar is shared state:
    // committed holidays would move the SLA deadline of every job every other
    // suite raises on this database for the next three weeks. So the holidays,
    // the job and everything else here are rolled back by throwing at the end.
    // The assertions have already run and `fail` is a JavaScript counter, which
    // survives the unwind.
    console.log("\n— ADM-10: the SLA clock counts against the STORED calendar —");

    let calendarProofRan = false;

    try {
      await withTenant(ctx, async (tx) => {
        // Three working weeks of public holidays, starting today. Absurd as a
        // calendar and exactly right as a probe: it moves every non-P1 deadline
        // by weeks, so the stored answer and the default answer cannot be
        // confused for one another by a few hours of drift.
        for (let i = 0; i < 21; i++) {
          await addPublicHoliday(tx, ctx, {
            date: day(i * DAY),
            name: `${TAG} probe holiday`,
            sourceNote: `${TAG} rolled back`,
          });
        }

        const stored: WorkingCalendar = await loadWorkingCalendar(tx);
        checkTrue(
          "the stored calendar now has holidays the default does not",
          Object.keys(stored.publicHolidays).length >
            Object.keys(DEFAULT_CALENDAR.publicHolidays).length,
        );

        // P2, not P1. `WALL_CLOCK_PRIORITIES` is exactly `["p1_emergency"]`, and
        // a wall-clock deadline ignores the calendar by design — so asserting
        // against P1 would be asserting against a function that cannot fail.
        const priority: JobPriority = "p2_urgent";
        const before = new Date();
        const expectedStored = computeSlaDeadlines(priority, before, undefined, stored);
        const expectedDefault = computeSlaDeadlines(priority, before, undefined, DEFAULT_CALENDAR);

        const gapDays =
          (expectedStored.respondByAt.getTime() - expectedDefault.respondByAt.getTime()) / DAY;
        console.log(`      stored vs default respond-by gap: ${gapDays.toFixed(1)} day(s)`);
        checkTrue(
          "the probe genuinely discriminates — the two calendars disagree by over a week",
          gapDays > 7,
        );

        const raised = await raiseJobForPhase(tx, ctx, {
          phaseId,
          title: `${TAG} calendar probe`,
          priority,
        });

        const row = await loadJob(tx, raised.jobId);
        const respondByAt = new Date(String(row?.respond_by_at));
        const resolveByAt = new Date(String(row?.resolve_by_at));

        // Two minutes of tolerance, for the milliseconds between the `new Date()`
        // above and the one inside `raiseJobForPhase`. The gap being discriminated
        // is weeks wide, so the tolerance cannot swallow it.
        checkTrue(
          "respond_by_at matches the STORED calendar's answer",
          Math.abs(respondByAt.getTime() - expectedStored.respondByAt.getTime()) < 2 * MINUTE,
        );
        checkTrue(
          "resolve_by_at too",
          Math.abs(resolveByAt.getTime() - expectedStored.resolveByAt.getTime()) < 2 * MINUTE,
        );
        // The assertion that fails if the code ever passes `undefined` for the
        // calendar and takes the DEFAULT_CALENDAR fallback.
        checkTrue(
          "and is NOT the answer DEFAULT_CALENDAR would have given",
          respondByAt.getTime() - expectedDefault.respondByAt.getTime() > 7 * DAY,
        );
        checkTrue(
          "the deadline lands on a day the stored calendar calls a working day",
          !(dubaiDateKey(respondByAt) in stored.publicHolidays),
        );

        calendarProofRan = true;
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }

    checkTrue("the stored-calendar proof actually ran", calendarProofRan);

    // Read back inside a tenant transaction, not on the bare `db` handle.
    // `public_holidays` is policied on `tenant_id = app_current_tenant()`, and
    // with `app.tenant_id` unset that policy matches zero rows — so a count
    // taken outside a tenant scope returns 0 whether or not the rows are there.
    // That is the same trap `_tenant.ts` documents for `otherTenantId`, and it
    // turns a cleanup assertion into one that cannot fail.
    await withTenant(ctx, async (tx) => {
      const surviving = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from public_holidays where name like ${`${TAG}%`}
      `)) as unknown as { count: number }[];
      check("and none of its probe holidays survived the rollback", surviving[0]?.count, 0);
    });

    // ── Cross-tenant isolation ─────────────────────────────────────────────
    //
    // Not a WHERE clause. `withTenant` sets `app.tenant_id` and Postgres does
    // the rest; the second tenant sees no phase, so it can raise nothing.
    console.log("\n— tenant isolation —");
    const other = await otherTenantId();
    await withTenant({ tenantId: other, actorKind: "system" }, async (tx) => {
      check("the other tenant sees none of these phase jobs", (await listPhaseJobs(tx, projectId)).length, 0);
      await refuses("and cannot raise one against a phase it cannot see", () =>
        raiseJobForPhase(tx, { tenantId: other, actorKind: "system" }, {
          phaseId,
          title: "Not yours",
        }),
      );
    });
  } finally {
    // ── Cleanup, anchored to TAG and to ids this file created ──────────────
    //
    // The jobs go first and by id. `project_phase_jobs.job_id` and
    // `job_events.job_id` are both ON DELETE cascade, so the links and the
    // timelines go with them; the projects then take their phases.
    console.log("\n— cleanup —");
    await withTenant(ctx, async (tx) => {
      // The audit rows are deliberately left. `audit_log` grants no DELETE to
      // the application role — it is append-only by design, which is the whole
      // value of an audit log — so a test that tidied up after itself there
      // would be a test that proved the log could be edited.
      for (const id of jobIds) {
        await tx.execute(sql`delete from jobs where id = ${id}::uuid`);
      }
      for (const id of [projectId, sitelessProjectId]) {
        if (id) await tx.execute(sql`delete from projects where id = ${id}::uuid`);
      }
      // An age gate as well as the tag, so a probe holiday left behind by a run
      // that crashed an hour ago is cleared and one another agent's run wrote a
      // second ago is not. Nothing here should exist at all — the probe rolls
      // itself back — which is exactly why it is worth sweeping for.
      await tx.execute(sql`
        delete from public_holidays
         where name like ${`${TAG}%`}
           and created_at < now() - interval '1 hour'
      `);
    });

    // ── And prove the cleanup worked ───────────────────────────────────────
    //
    // Inside a tenant transaction, for the reason above: every table below is
    // policied on `app_current_tenant()`, and a count taken on the bare `db`
    // handle would read 0 from a database that still had every row in it.
    await withTenant(ctx, async (tx) => {
      const one = async (label: string, query: ReturnType<typeof sql>) => {
        const rows = (await tx.execute<{ count: number }>(query)) as unknown as {
          count: number;
        }[];
        check(label, Number(rows[0]?.count), 0);
      };

      await one(
        "no test project survived cleanup",
        sql`select count(*)::int as count from projects where name like ${`${TAG}%`}`,
      );
      await one(
        "nor any job it raised",
        sql`select count(*)::int as count from jobs where title like ${`${TAG}%`}`,
      );
      await one(
        "nor a phase link pointing at a job that is gone",
        sql`select count(*)::int as count from project_phase_jobs pj
             where pj.job_id = any(${sql`array[${sql.join(
               [
                 ...jobIds.map((id) => sql`${id}`),
                 sql`'00000000-0000-0000-0000-000000000000'`,
               ],
               sql`, `,
             )}]::uuid[]`})`,
      );
      await one(
        "nor a probe holiday in anybody's calendar",
        sql`select count(*)::int as count from public_holidays where name like ${`${TAG}%`}`,
      );
    });
  }

  console.log(fail === 0 ? "\nAll phase-job checks passed.\n" : `\n${fail} check(s) FAILED.\n`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
