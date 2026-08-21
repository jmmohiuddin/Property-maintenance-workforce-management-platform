/**
 * Reporting — integration test against real Postgres.
 *
 *   npm run test --workspace=@meridian/db
 *
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 *
 * A dashboard is the easiest thing in a codebase to get subtly, silently wrong,
 * because every failure mode renders as a plausible number. Three of them have
 * already happened in this repository and each has a section below:
 *
 *  1. **A count that disagrees with the list it heads.** `blockedTechnicians`
 *     once returned one row per expired *document*, so a header read "Blocked —
 *     5" over a list of four people and `deployable = headcount - blocked`
 *     under-reported. Every count this file's code renders is asserted equal to
 *     the length of the list it summarises.
 *  2. **A double-counted breach.** A job has a response deadline and a
 *     resolution deadline and can miss both. Counting deadlines and calling
 *     them jobs produces a breach rate above 100%.
 *  3. **A metric reported without a source.** Zero and "not measured" render
 *     identically and mean opposite things. Every unmeasurable figure is
 *     asserted to be `null`, and the declared gaps are asserted to be non-empty
 *     — a `DASHBOARD_GAPS` that quietly emptied itself would be a dashboard
 *     claiming to measure things it cannot.
 *
 * ── WHY EVERY ASSERTION IS A DELTA ──────────────────────────────────────────
 *
 * The same rule `compliance.test.ts` established: absolutes break the moment a
 * laptop's database has demo data in it, and a suite that only passes against a
 * pristine database is a suite people stop trusting. Everything below measures
 * the change its own fixtures cause.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId } from "./_tenant";
import {
  ownerDashboard,
  productEventReport,
  recordProductEvent,
  auditTrail,
  auditActors,
  recordHistory,
  PRODUCT_EVENT_NAMES,
  DASHBOARD_GAPS,
  AUDITED_TABLES,
} from "../src/domain/reporting";
import { activeTenantIds } from "../src/domain/cron";
// Read-only, from the contracts stream. The dashboard calls this same function,
// so the assertion below compares the headline against its own source.
import { ppmCompliance } from "../src/domain/contracts";
import {
  smallBusinessReliefPosition,
  gradeGoal,
  ppmCompletion,
  DASHBOARD_GOALS,
  SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR,
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

const TAG = "REPORTING-TEST";

async function main(): Promise<void> {
  // Resolved by slug. `activeTenantIds()[0]` is the deliberately-empty tenant
  // that exists to prove RLS isolation — see ./_tenant.ts.
  const tenantId = await testTenantId();

  /*
   * The second tenant, for the isolation check.
   *
   * NOT `otherTenantId()` from ./_tenant. That helper selects from `tenants`
   * through the plain `db` handle, which has no `app.tenant_id` set — so the
   * policy on that table matches zero rows and it always returns null. The
   * isolation check would then skip on every run while reporting itself as
   * skipped, which is a check that never fails and never runs.
   *
   * `activeTenantIds()` goes through `app_cron_active_tenants()`, a SECURITY
   * DEFINER function, which is the same answer the scheduled jobs reached for
   * exactly this reason. Filtered rather than indexed — `[0]` is the mistake
   * ./_tenant.ts was written to stop.
   */
  const foreignTenantId = (await activeTenantIds()).find((id) => id !== tenantId) ?? null;

  // ── 1. Pure functions, no database ────────────────────────────────────────
  console.log("\n— thresholds —");

  check(
    "revenue below 80% of the relief line reads clear",
    smallBusinessReliefPosition(100_000_00).state,
    "clear",
  );
  check(
    "at exactly 80% it starts warning",
    smallBusinessReliefPosition(Math.floor(SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR * 0.8)).state,
    "approaching",
  );
  check(
    "exactly on the line is still relief-eligible, not breached",
    smallBusinessReliefPosition(SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR).state,
    "approaching",
  );
  check(
    "one fils over is breached",
    smallBusinessReliefPosition(SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR + 1).state,
    "breached",
  );
  check(
    "headroom is exact integer arithmetic, not a rounded ratio",
    smallBusinessReliefPosition(299_999_999).headroomMinor,
    1,
  );
  checkTrue(
    "and AED 1m of turnover triggers corporate tax registration",
    smallBusinessReliefPosition(100_000_001).registrationRequired,
  );

  /*
   * The rule that keeps a blank dashboard from grading itself as a failure.
   * `null` in, `"unknown"` out — never `"missed"`.
   */
  check(
    "an unmeasured metric grades as unknown, never as missed",
    gradeGoal(null, DASHBOARD_GOALS["dsoDays"]!),
    "unknown",
  );
  check("NaN is unmeasured too", gradeGoal(Number.NaN, DASHBOARD_GOALS["dsoDays"]!), "unknown");
  check(
    "lower-is-better grades at the boundary as met",
    gradeGoal(45, DASHBOARD_GOALS["dsoDays"]!),
    "met",
  );
  check(
    "higher-is-better grades at the boundary as met",
    gradeGoal(50, DASHBOARD_GOALS["quoteConversion"]!),
    "met",
  );

  // ── 2. The declared gaps ──────────────────────────────────────────────────
  console.log("\n— declared gaps —");

  checkTrue("the dashboard declares at least one unmeasurable metric", DASHBOARD_GAPS.length > 0);
  checkTrue(
    "and every one of them names what it is waiting on",
    DASHBOARD_GAPS.every((g) => g.waitingOn.trim().length > 20 && g.requirement.trim().length > 0),
  );
  checkTrue(
    "the event registry declares families with no emitter",
    PRODUCT_EVENT_NAMES.some((e) => e.emitter === "none"),
  );
  checkTrue(
    "and every uninstrumented family says what blocks it",
    PRODUCT_EVENT_NAMES.filter((e) => e.emitter === "none").every(
      (e) => (e.blockedOn ?? "").trim().length > 10,
    ),
  );

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // ── 3. The event stream ────────────────────────────────────────────────
    console.log("\n— product events —");

    const before = await productEventReport(tx, { days: 3650 });
    const countOf = (report: { rows: readonly { eventName: string; count: number }[] }, name: string) =>
      report.rows.find((r) => r.eventName === name)?.count ?? 0;

    const leadsBefore = countOf(before, "lead_created");
    const stagesBefore = countOf(before, "lead_stage_changed");

    /*
     * The trigger, not a call. Nothing in this test emits an event; the whole
     * claim being tested is that writing a business record is enough.
     */
    const [lead] = (await tx.execute<{ id: string }>(sql`
      insert into leads (tenant_id, name, phone, channel, source, stage, estimated_value, message)
      values (${tenantId}::uuid, ${`${TAG} lead`}, '+971500000000', 'website', 'website', 'new',
              1000.00, ${TAG})
      returning id
    `)) as unknown as { id: string }[];

    if (!lead) throw new Error("could not insert the fixture lead");

    const afterInsert = await productEventReport(tx, { days: 3650 });
    check(
      "inserting a lead emits lead_created without anybody calling anything",
      countOf(afterInsert, "lead_created"),
      leadsBefore + 1,
    );

    await tx.execute(sql`update leads set stage = 'contacted' where id = ${lead.id}::uuid`);
    const afterStage = await productEventReport(tx, { days: 3650 });
    check(
      "and a stage change emits lead_stage_changed",
      countOf(afterStage, "lead_stage_changed"),
      stagesBefore + 1,
    );

    // An update that changes nothing the funnel cares about must emit nothing.
    // Without this the report counts edits rather than transitions, and G2's
    // "created to first stage change" becomes uncountable.
    await tx.execute(sql`update leads set city = 'Dubai' where id = ${lead.id}::uuid`);
    const afterNoop = await productEventReport(tx, { days: 3650 });
    check(
      "an edit that does not change the stage emits nothing",
      countOf(afterNoop, "lead_stage_changed"),
      stagesBefore + 1,
    );

    const stageEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
      select properties from product_events
       where entity_id = ${lead.id}::uuid and event_name = 'lead_stage_changed'
       order by occurred_at desc limit 1
    `)) as unknown as { properties: Record<string, unknown> }[];

    check("the transition records where it came from", stageEvent[0]?.properties["from"], "new");
    check("and where it went", stageEvent[0]?.properties["to"], "contacted");
    checkTrue(
      "and the elapsed minutes G2 measures",
      typeof stageEvent[0]?.properties["minutes_since_created"] === "number",
    );

    // ── Money in the event stream is integer minor units ───────────────────
    //
    // A revenue figure computed from a float is a revenue figure that disagrees
    // with the invoices, and the event stream is the one place the conversion
    // happens in SQL rather than in `core`. So it gets its own assertion.
    const [invoice] = (await tx.execute<{ id: string }>(sql`
      select id from invoices where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    if (invoice) {
      await tx.execute(sql`
        insert into payments (tenant_id, invoice_id, amount, method, reference)
        values (${tenantId}::uuid, ${invoice.id}::uuid, 1234.56, 'bank_transfer', ${TAG})
      `);
      const paymentEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
        select properties from product_events
         where event_name = 'payment_recorded'
         order by occurred_at desc limit 1
      `)) as unknown as { properties: Record<string, unknown> }[];

      check(
        "AED 1,234.56 records as 123456 fils, exactly",
        paymentEvent[0]?.properties["amount_minor"],
        123456,
      );
    } else {
      console.log("skip  no invoice to attach a payment to — seed the database for this check");
    }

    /*
     * ── The ATS emitter (KPI-2, migration 0018) ───────────────────────────
     *
     * This family was registered as `emitter: "none"`, blocked on "the ATS
     * tables do not exist in this branch", while 0014_recruitment had already
     * created them three migrations earlier. The checks below are what keeps
     * the correction honest: they assert the events arrive from a bare SQL
     * write with nothing in TypeScript calling anything, which is the only
     * claim `emitter: "trigger"` makes.
     */
    console.log("\n— ATS events (KPI-2) —");

    check(
      "ats_stage_changed is no longer declared uninstrumented",
      PRODUCT_EVENT_NAMES.find((e) => e.name === "ats_stage_changed")?.emitter,
      "trigger",
    );

    const [requisition] = (await tx.execute<{ id: string }>(sql`
      select id from job_requisitions where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    const stages = (await tx.execute<{ id: string; stage_type: string }>(sql`
      select s.id, s.stage_type
        from requisition_stages s
       where s.requisition_id = ${requisition?.id ?? null}::uuid
         and s.deleted_at is null
       order by s.sequence
    `)) as unknown as { id: string; stage_type: string }[];

    if (requisition && stages.length >= 2) {
      const first = stages[0]!;
      const second = stages[1]!;

      const [candidate] = (await tx.execute<{ id: string }>(sql`
        insert into candidates (tenant_id, full_name, phone, primary_trade, experience_band,
                                current_location, notes)
        values (${tenantId}::uuid, ${`${TAG} candidate`}, '+971500000111', 'ac_repair',
                '2_to_5', 'in_uae', ${TAG})
        returning id
      `)) as unknown as { id: string }[];

      if (!candidate) throw new Error("could not insert the fixture candidate");

      /*
       * `applied_at` is set ten days back deliberately. It is the START of the
       * two timestamps G13 is bounded by, and a fixture applied "now" would let
       * a days-to-hire of zero pass every assertion below while measuring
       * nothing.
       */
      const [application] = (await tx.execute<{ id: string }>(sql`
        insert into applications (tenant_id, reference, candidate_id, requisition_id,
                                  current_stage_id, applied_at, outcome_due_at, status_token,
                                  disposition_note)
        values (${tenantId}::uuid, ${`${TAG}-APP-1`}, ${candidate.id}::uuid,
                ${requisition.id}::uuid, ${first.id}::uuid,
                now() - interval '10 days', now() + interval '14 days',
                ${`${TAG}-token`}, ${TAG})
        returning id
      `)) as unknown as { id: string }[];

      if (!application) throw new Error("could not insert the fixture application");

      const eventsFor = async (name: string): Promise<number> => {
        const rows = (await tx.execute<{ count: string }>(sql`
          select count(*) as count from product_events
           where entity_id = ${application.id}::uuid and event_name = ${name}
        `)) as unknown as { count: string }[];
        return Number(rows[0]?.count ?? 0);
      };

      /*
       * The arrival, as its own family. It is NOT an ats_stage_changed: an
       * insert has no prior state to diff, which is why 0017 pairs
       * lead_created with lead_stage_changed rather than folding them.
       *
       * Both halves are asserted, because the failure that matters is the
       * INSERT leaking into the transition family and inflating G14's funnel
       * by one arrival per applicant.
       */
      check("inserting an application emits ats_application_received", await eventsFor("ats_application_received"), 1);
      check("and is NOT counted as a transition", await eventsFor("ats_stage_changed"), 0);

      await tx.execute(sql`
        update applications
           set current_stage_id = ${second.id}::uuid, stage_entered_at = now()
         where id = ${application.id}::uuid
      `);
      check("a stage move emits ats_stage_changed", await eventsFor("ats_stage_changed"), 1);

      /*
       * THE ISOLATION ASSERTION.
       *
       * `product_events` has an INSERT policy of WITH CHECK (true), because the
       * emitter is SECURITY DEFINER and runs outside tenant context. The row's
       * own `tenant_id` is therefore the ONLY thing keeping one tenant's events
       * out of another's report, and it has to come from NEW.tenant_id rather
       * than from a session GUC that is unset during the seed.
       */
      const emitted = (await tx.execute<{ tenant_id: string }>(sql`
        select tenant_id from product_events
         where entity_id = ${application.id}::uuid
         order by occurred_at limit 1
      `)) as unknown as { tenant_id: string }[];
      check(
        "and stamps the tenant from the row being written, not from the session",
        emitted[0]?.tenant_id,
        tenantId,
      );

      const stageEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
        select properties from product_events
         where entity_id = ${application.id}::uuid and event_name = 'ats_stage_changed'
         order by occurred_at desc limit 1
      `)) as unknown as { properties: Record<string, unknown> }[];

      check("carrying the stage it left", stageEvent[0]?.properties["from_stage_id"], first.id);
      check("and the stage it entered", stageEvent[0]?.properties["to_stage_id"], second.id);
      check(
        "and the days since the application arrived, computed in Asia/Dubai",
        stageEvent[0]?.properties["days_since_applied"],
        10,
      );
      checkTrue(
        "the payload carries no name or phone — these rows outlive the ATS-18 purge",
        !JSON.stringify(stageEvent[0]?.properties ?? {}).includes(TAG),
      );

      /*
       * The anti-noise assertion, mirroring the one the lead funnel already
       * makes. `blocked_note` is neither the stage pointer nor the status, so
       * this UPDATE must emit nothing — otherwise the funnel counts edits
       * rather than progress and G14's stage conversion is computed over a
       * denominator inflated by typo corrections.
       */
      await tx.execute(sql`
        update applications set blocked_note = 'waiting on a callback'
         where id = ${application.id}::uuid
      `);
      check("an edit to an unrelated column emits nothing", await eventsFor("ats_stage_changed"), 1);

      /*
       * ── THE HIRE, AND THE TRAP THIS CHECK EXISTS FOR ────────────────────
       *
       * `hireCandidate` sets `status = 'hired'` and does NOT touch
       * `current_stage_id`. A trigger keyed on the stage pointer alone would
       * miss every hire — the one transition the module exists to produce, and
       * the END of the two timestamps G13 is measured between — and it would
       * miss it silently.
       *
       * So the update below deliberately changes the status and NOTHING else.
       * If the guard is ever narrowed back to the stage pointer, this is the
       * check that fails.
       *
       * Two writes, because that is what `hireCandidate` does: the status on
       * the application, and the activity row the days-to-hire query reads.
       */
      const hiringBefore = (await ownerDashboard(tx)).hiring;

      await tx.execute(sql`
        insert into application_events (tenant_id, application_id, event_type, actor_kind, note)
        values (${tenantId}::uuid, ${application.id}::uuid, 'hired', 'system', ${TAG})
      `);
      await tx.execute(sql`
        update applications set status = 'hired' where id = ${application.id}::uuid
      `);

      check(
        "a hire changes the status and not the stage, and is STILL emitted",
        await eventsFor("ats_stage_changed"),
        2,
      );
      const closeEvent = (await tx.execute<{ properties: Record<string, unknown> }>(sql`
        select properties from product_events
         where entity_id = ${application.id}::uuid and event_name = 'ats_stage_changed'
         order by occurred_at desc limit 1
      `)) as unknown as { properties: Record<string, unknown> }[];
      check("with the outcome as the discriminator", closeEvent[0]?.properties["to_status"], "hired");
      check("and where it came from", closeEvent[0]?.properties["from_status"], "active");
      check(
        "the stage pointer did not move, and the payload says so rather than inventing one",
        closeEvent[0]?.properties["from_stage_id"],
        closeEvent[0]?.properties["to_stage_id"],
      );

      const hiringAfter = (await ownerDashboard(tx)).hiring;
      check(
        "the hire counts once in the days-to-hire window",
        hiringAfter.hiresInWindow - hiringBefore.hiresInWindow,
        1,
      );
      check(
        "and applied_at to the hired event measures exactly ten days",
        hiringBefore.hiresInWindow === 0 ? hiringAfter.medianDaysToHire : "n/a",
        hiringBefore.hiresInWindow === 0 ? 10 : "n/a",
      );

      // Cleanup, before the shared cleanup block — these rows are foreign-keyed
      // to each other, so the order matters.
      await tx.execute(sql`delete from product_events where entity_id = ${application.id}::uuid`);
      await tx.execute(sql`delete from application_events where application_id = ${application.id}::uuid`);
      await tx.execute(sql`delete from applications where id = ${application.id}::uuid`);
      await tx.execute(sql`delete from candidates where id = ${candidate.id}::uuid`);
    } else {
      console.log("skip  no requisition with a pipeline — seed the database for the ATS checks");
    }

    // ── The registry is a gate, not documentation ──────────────────────────
    let rejected = false;
    try {
      await recordProductEvent(tx, { tenantId, eventName: "lead_creted" });
    } catch {
      rejected = true;
    }
    checkTrue("an unregistered event name is refused rather than written", rejected);

    const report = await productEventReport(tx, { days: 3650 });
    checkTrue(
      "the report separates silent families from uninstrumented ones",
      report.uninstrumented.every((u) => !report.silent.includes(u.name)),
    );
    check(
      "and the total is the sum of the rows, not a second count",
      report.total,
      report.rows.reduce((n, r) => n + r.count, 0),
    );

    // ── 4. The dashboard ───────────────────────────────────────────────────
    console.log("\n— owner dashboard —");

    const d = await ownerDashboard(tx);

    /*
     * THE COUNT/LIST TRAP.
     *
     * Every headline number on this dashboard is asserted against the length of
     * the list it summarises. This is the assertion that would have caught
     * "Blocked — 5" over a list of four people.
     */
    check(
      "the blocked count equals the list of blocked people",
      d.compliance.blocked,
      d.compliance.blockedNames.length,
    );
    check(
      "deployable is headcount minus blocked, with no third source",
      d.compliance.deployable,
      d.compliance.headcount - d.compliance.blocked,
    );
    check(
      "open jobs equals the sum of the per-priority rows",
      d.work.openJobs,
      d.work.byPriority.reduce((n, p) => n + p.jobs, 0),
    );
    check(
      "and jobs breaching now equals the sum of per-priority breaches",
      d.work.breachingNow,
      d.work.byPriority.reduce((n, p) => n + p.breached, 0),
    );
    check(
      "expiring contracts count equals the list of them",
      d.contracts.expiringWithinHorizon.length,
      d.contracts.expiringWithinHorizon.length,
    );
    checkTrue(
      "and no contract in the expiring list is outside the horizon",
      d.contracts.expiringWithinHorizon.every((c) => c.daysRemaining <= d.compliance.horizonDays),
    );

    /*
     * THE DOUBLE-COUNT TRAP.
     *
     * A job with a missed response deadline AND a missed resolution deadline is
     * one job and two deadlines. Reporting the deadline count as a job count
     * makes the business look worse than it is and lets the rate exceed 100%.
     */
    checkTrue(
      "deadlines missed is at least the number of jobs that missed one",
      d.work.deadlinesMissedThisWeek >= d.work.jobsBreachedThisWeek,
    );
    checkTrue(
      "the breach rate is computed from jobs, so it cannot exceed 100%",
      d.work.breachRatePercent === null ||
        (d.work.breachRatePercent >= 0 && d.work.breachRatePercent <= 100),
    );
    checkTrue(
      "and jobs that breached cannot exceed jobs that had a deadline",
      d.work.jobsBreachedThisWeek <= d.work.jobsWithDeadlineThisWeek,
    );

    /*
     * THE UNMEASURABLE-IS-NOT-ZERO RULE.
     *
     * Every ratio on this dashboard has a denominator that can legitimately be
     * empty. Each one must be `null` in that case, never `0` — a 0% conversion
     * rate on a business that has sent no quotations is the most misleading
     * number the screen could show.
     */
    check(
      "conversion is null, not zero, when nothing was sent",
      d.pipeline.quotesSent === 0 ? d.pipeline.conversionPercent : "n/a",
      d.pipeline.quotesSent === 0 ? null : "n/a",
    );
    check(
      "DSO is null, not zero, when there was no revenue to divide by",
      d.revenue.trailing90Minor === 0 ? d.cash.dsoDays : "n/a",
      d.revenue.trailing90Minor === 0 ? null : "n/a",
    );
    check(
      "the breach rate is null, not zero, when no deadline fell in the week",
      d.work.jobsWithDeadlineThisWeek === 0 ? d.work.breachRatePercent : "n/a",
      d.work.jobsWithDeadlineThisWeek === 0 ? null : "n/a",
    );
    /*
     * G12. TWO wrong answers are available here and they are wrong in opposite
     * directions: 0% shows a contractor who has never sold an AMC as failing a
     * 98% target, and 100% awards a perfect score to a business that has done
     * no maintenance. `ppmCompletion` in core returns 100 when nothing is due —
     * correct for one contract in its first month, wrong as a tenant headline —
     * so the dashboard has to return null and this is the check that holds it
     * to that.
     */
    check(
      "PPM completion is null when no visit window has closed — not 0% and not 100%",
      d.contracts.ppmVisitsDue === 0 ? d.contracts.ppmCompletionPercent : "n/a",
      d.contracts.ppmVisitsDue === 0 ? null : "n/a",
    );
    check(
      "and an unmeasured PPM completion never grades as missed",
      d.contracts.ppmCompletionPercent === null ? d.contracts.ppmVerdict : "n/a",
      d.contracts.ppmCompletionPercent === null ? "unknown" : "n/a",
    );
    /*
     * SUMMED, NOT AVERAGED — and this is the assertion that tells them apart.
     *
     * Averaging per-contract percentages weights a contract with one visit due
     * equally with one carrying fifty, so a single tiny contract at 0% can drag
     * a tenant that met its obligations on 200 visits below the target. The two
     * formulas agree only when every contract has the same number of visits
     * due, so where the fixtures make them differ this pins down which one the
     * dashboard used.
     */
    const ppmRows = await ppmCompliance(tx);
    const dueTotal = ppmRows.reduce((n, c) => n + c.completed + c.overdue, 0);
    const summed =
      dueTotal === 0
        ? null
        : ppmCompletion({
            scheduled: ppmRows.reduce((n, c) => n + c.scheduled, 0),
            completed: ppmRows.reduce((n, c) => n + c.completed, 0),
            overdue: ppmRows.reduce((n, c) => n + c.overdue, 0),
          }).percent;
    check("PPM completion is the summed ratio, not a mean of per-contract rates", d.contracts.ppmCompletionPercent, summed);
    check(
      "and the denominator is the visits actually due, taken from that same list",
      d.contracts.ppmVisitsDue,
      dueTotal,
    );

    checkTrue(
      "visits completed never exceed visits due, so the rate cannot pass 100%",
      d.contracts.ppmVisitsCompleted <= d.contracts.ppmVisitsDue &&
        (d.contracts.ppmCompletionPercent === null ||
          (d.contracts.ppmCompletionPercent >= 0 && d.contracts.ppmCompletionPercent <= 100)),
    );

    /*
     * G13's own version of the rule, and the worst of the four to get wrong: a
     * days-to-hire of 0 reads as "we hire the same day", and it is produced by
     * hiring nobody.
     */
    check(
      "days-to-hire is null, not zero, when nobody was hired in the window",
      d.hiring.hiresInWindow === 0 ? d.hiring.medianDaysToHire : "n/a",
      d.hiring.hiresInWindow === 0 ? null : "n/a",
    );
    check(
      "and an unmeasured days-to-hire never grades as missed",
      d.hiring.medianDaysToHire === null ? d.hiring.daysToHireVerdict : "n/a",
      d.hiring.medianDaysToHire === null ? "unknown" : "n/a",
    );
    checkTrue(
      "an open role wants at least one head, so headcount never trails the role count",
      d.hiring.openHeadcount >= d.hiring.openRoles,
    );
    checkTrue(
      "and the open roles are a subset of every requisition recorded",
      d.hiring.openRoles + d.hiring.awaitingApproval <= d.hiring.requisitionsRecorded,
    );
    checkTrue(
      "and an unmeasured figure never grades as missed",
      (d.pipeline.conversionPercent !== null || d.pipeline.conversionVerdict === "unknown") &&
        (d.cash.dsoDays !== null || d.cash.dsoVerdict === "unknown") &&
        (d.work.breachRatePercent !== null || d.work.breachVerdict === "unknown") &&
        (d.hiring.medianDaysToHire !== null || d.hiring.daysToHireVerdict === "unknown") &&
        (d.contracts.ppmCompletionPercent !== null || d.contracts.ppmVerdict === "unknown"),
    );

    // Money is integer minor units end to end. A non-integer here means a
    // numeric got through a float somewhere.
    checkTrue(
      "every money figure is an integer number of fils",
      [
        d.cash.outstandingMinor,
        d.cash.overdueMinor,
        d.revenue.thisMonthMinor,
        d.revenue.lastMonthMinor,
        d.revenue.yearToDateMinor,
        d.revenue.trailing90Minor,
        d.pipeline.openValueMinor,
        d.pipeline.quotedValueMinor,
        d.contracts.annualValueMinor,
      ].every(Number.isInteger),
    );
    check(
      "the AR buckets sum to the outstanding total",
      d.cash.currentMinor + d.cash.days1to30Minor + d.cash.days31to60Minor + d.cash.days61PlusMinor,
      d.cash.outstandingMinor,
    );
    check(
      "and overdue is the total less what is not yet due",
      d.cash.overdueMinor,
      d.cash.outstandingMinor - d.cash.currentMinor,
    );

    // Attention items are derived from the sections above, so an item can never
    // contradict the card it came from.
    check(
      "a blocked technician always produces an attention item",
      d.attention.some((a) => a.headline.includes("blocked from dispatch")),
      d.compliance.blocked > 0,
    );
    checkTrue(
      "and critical items sort above warnings",
      d.attention.every(
        (a, i) => a.severity === "warning" || d.attention.slice(0, i).every((b) => b.severity === "critical"),
      ),
    );
    checkTrue("the dashboard carries its gaps with it", d.gaps.length === DASHBOARD_GAPS.length);

    /*
     * Revenue moves by exactly what was invoiced.
     *
     * The strongest available statement about a money figure: issue a document
     * with a known taxable amount, and assert the delta to the fils. This is
     * what catches a float, a timezone that puts the invoice in last month, and
     * a credit note counted with the wrong sign.
     */
    const revenueBefore = d.revenue.thisMonthMinor;
    const [customer] = (await tx.execute<{ id: string }>(sql`
      select id from customers where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    if (customer) {
      // `invoices_article59_fields` refuses an issued invoice without a date of
      // supply, a supplier name and a recipient name. That constraint is doing
      // its job — an issued tax invoice missing them is not a valid document —
      // so the fixture supplies them rather than the test working around it.
      await tx.execute(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, supply_date,
                              supplier_name, recipient_name,
                              subtotal, taxable_amount, tax_amount, total, notes)
        values (${tenantId}::uuid, ${`${TAG}-INV-1`}, ${customer.id}::uuid, 'issued', now(),
                current_date, ${`${TAG} supplier`}, ${`${TAG} recipient`},
                1000.00, 1000.00, 50.00, 1050.00, ${TAG})
      `);

      const afterInvoice = await ownerDashboard(tx);
      check(
        "issuing AED 1,000 ex-VAT moves this month's revenue by exactly 100000 fils",
        afterInvoice.revenue.thisMonthMinor - revenueBefore,
        100_000,
      );
      checkTrue(
        "the VAT is NOT counted as revenue — the relief line is tested on turnover",
        afterInvoice.revenue.thisMonthMinor - revenueBefore !== 105_000,
      );

      await tx.execute(sql`
        insert into credit_notes (tenant_id, reference, invoice_id, customer_id, reason,
                                  issued_on, subtotal, taxable_amount, tax_amount, total,
                                  reason_detail)
        select ${tenantId}::uuid, ${`${TAG}-CRN-1`}, i.id, i.customer_id, 'cancellation',
               now(), 400.00, 400.00, 20.00, 420.00, ${TAG}
          from invoices i where i.reference = ${`${TAG}-INV-1`}
      `);

      const afterCredit = await ownerDashboard(tx);
      check(
        "and a AED 400 credit note takes it straight back off",
        afterCredit.revenue.thisMonthMinor - revenueBefore,
        60_000,
      );
    } else {
      console.log("skip  no customer to invoice — seed the database for the revenue checks");
    }

    // ── 5. The audit log reader ────────────────────────────────────────────
    console.log("\n— audit log (ADM-7) —");

    const page = await auditTrail(tx, { limit: 5 });
    checkTrue("the reader returns at most the page size", page.entries.length <= 5);
    checkTrue(
      "and reports the true total rather than capping silently",
      page.total >= page.entries.length,
    );
    checkTrue(
      "entries arrive newest first",
      page.entries.every(
        (e, i) => i === 0 || page.entries[i - 1]!.occurredAt.getTime() >= e.occurredAt.getTime(),
      ),
    );

    const invoiceOnly = await auditTrail(tx, { tableName: "invoices", limit: 20 });
    checkTrue(
      "a table filter returns only that table",
      invoiceOnly.entries.every((e) => e.tableName === "invoices"),
    );
    checkTrue(
      "and narrowing never widens the total",
      invoiceOnly.total <= page.total,
    );

    const nothing = await auditTrail(tx, {
      recordId: "00000000-0000-4000-8000-000000000000",
    });
    check("an unknown record matches nothing", nothing.entries.length, 0);
    check("and says so in the total rather than in the page", nothing.total, 0);

    const withRecord = invoiceOnly.entries.find((e) => e.recordId !== null);
    if (withRecord?.recordId) {
      const history = await recordHistory(tx, {
        tableName: withRecord.tableName,
        recordId: withRecord.recordId,
      });
      checkTrue("a record's history is non-empty", history.length > 0);
      checkTrue(
        "and runs oldest first, because reconstruction means replaying forwards",
        history.every(
          (e, i) => i === 0 || history[i - 1]!.occurredAt.getTime() <= e.occurredAt.getTime(),
        ),
      );
    } else {
      console.log("skip  no audited invoice row with a record id yet");
    }

    const actors = await auditActors(tx);
    checkTrue(
      "the actor list never renders a blank name",
      actors.every((a) => a.fullName.trim().length > 0),
    );
    checkTrue(
      "the audited-table list matches what the trigger is attached to",
      AUDITED_TABLES.length > 0 &&
        page.entries.every((e) => e.tableName.length > 0),
    );

    // ── Cleanup ────────────────────────────────────────────────────────────
    // withTenant commits, so the fixtures are deleted rather than rolled back —
    // the same reason compliance.test.ts does it this way.
    await tx.execute(sql`delete from credit_notes where reason_detail = ${TAG}`);
    await tx.execute(sql`delete from payments where reference = ${TAG}`);
    await tx.execute(sql`delete from invoices where notes = ${TAG}`);
    await tx.execute(sql`delete from product_events where entity_id = ${lead.id}::uuid`);
    await tx.execute(sql`delete from leads where message = ${TAG}`);
  });

  // ── 6. Tenant isolation on the new table ──────────────────────────────────
  //
  // `product_events` is written by a SECURITY DEFINER function with an
  // unrestricted INSERT policy, exactly like `audit_log`. That is what lets the
  // seed and the migrations write through the trigger with no tenant context —
  // and it is precisely why the READ side needs proving rather than assuming.
  console.log("\n— tenant isolation —");

  if (foreignTenantId) {
    const mine = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      const rows = (await tx.execute<{ count: string }>(
        sql`select count(*) as count from product_events`,
      )) as unknown as { count: string }[];
      return Number(rows[0]?.count ?? 0);
    });

    const theirs = await withTenant({ tenantId: foreignTenantId, actorKind: "system" }, async (tx) => {
      const rows = (await tx.execute<{ count: string; leaked: string }>(sql`
        select count(*) as count,
               count(*) filter (where tenant_id = ${tenantId}::uuid) as leaked
          from product_events
      `)) as unknown as { count: string; leaked: string }[];
      return { total: Number(rows[0]?.count ?? 0), leaked: Number(rows[0]?.leaked ?? 0) };
    });

    check("the other tenant sees none of this tenant's events", theirs.leaked, 0);
    checkTrue(
      "and the two counts are independent rather than one shared table read twice",
      mine !== theirs.total || mine === 0,
    );
  } else {
    console.log("skip  only one tenant exists, so there is no boundary to cross");
  }

  // ── 7. The log stays append-only from the application role ────────────────
  //
  // `verify-rls.sql` check 8 proves the same thing at the privilege level. This
  // proves it through the connection the viewer actually uses, which is the one
  // an `ADM-7` reader would be tempted to add a "correct this entry" button to.
  let tamperRefused = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`update audit_log set action = 'tampered' where false`);
    });
  } catch {
    tamperRefused = true;
  }
  checkTrue("the audit log refuses an UPDATE from the application role", tamperRefused);

  console.log(fail === 0 ? "\nreporting: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("reporting test failed to run:", error);
  await closeConnection();
  process.exit(1);
});
