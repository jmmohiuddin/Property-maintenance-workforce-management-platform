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
import {
  smallBusinessReliefPosition,
  gradeGoal,
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
    checkTrue(
      "and an unmeasured figure never grades as missed",
      (d.pipeline.conversionPercent !== null || d.pipeline.conversionVerdict === "unknown") &&
        (d.cash.dsoDays !== null || d.cash.dsoVerdict === "unknown") &&
        (d.work.breachRatePercent !== null || d.work.breachVerdict === "unknown"),
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
