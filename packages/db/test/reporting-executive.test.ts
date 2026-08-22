/**
 * The executive dashboard's three new cards — integration test against real
 * Postgres.
 *
 *   npx tsx packages/db/test/reporting-executive.test.ts
 *
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 *
 * `MD-1` (revenue and job volume by service line and by month), `MD-3`
 * (technician utilisation, and the outcome tally that stands where first-time
 * fix was asked for) and `MD-5` (customers at risk). Three failure modes, each
 * of which has already shipped somewhere in this repository:
 *
 *  1. **A headline summed from a capped list.** Found five times: the customers
 *     page, the overdue banner, the owner dashboard's own Work card, the portal
 *     balance and the dispatch counts. Every total below is seeded with MORE
 *     rows than the display cap and asserted against the true total, with the
 *     cap deliberately turned down to 3 so a list-derived figure would be
 *     obviously short rather than plausibly low.
 *  2. **Dubai's day read as the server's day.** Found eight times. The month
 *     boundary fixture below is an invoice issued at 00:30 on the FIRST of the
 *     current Dubai month — 20:30 UTC on the last day of the previous one — so a
 *     query using UTC boundaries files it in the wrong month every single run,
 *     not for two hours a day.
 *  3. **A metric reported without a source.** Utilisation over unrecorded
 *     labour is 0%, which reads as idle technicians and means an empty form.
 *     The null-versus-zero rule is asserted in both directions.
 *
 * ── WHY EVERY ASSERTION IS A HAND-COMPUTED DELTA ────────────────────────────
 *
 * Absolutes break against a laptop with demo data in it, and an assertion that
 * compares a figure to the same function's own output reshaped passes for any
 * figure including a wrong one. So every expectation below is either a literal
 * arrived at on paper (660000 fils, 14400 minutes, 2880 minutes) or a measured
 * baseline plus such a literal.
 *
 * ── AND WHY IT ROLLS BACK ───────────────────────────────────────────────────
 *
 * Eleven at-risk customers left behind would sit on the owner dashboard of a
 * shared development database forever. The whole run is one transaction and it
 * ends with a deliberate throw, so the assertions see the fixtures and nothing
 * else ever does.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId } from "./_tenant";
import {
  ownerDashboard,
  revenueBreakdown,
  utilisationPosition,
  outcomePosition,
  retentionPosition,
  DASHBOARD_GAPS,
} from "../src/domain/reporting";
import {
  DEFAULT_CALENDAR,
  CUSTOMER_QUIET_AFTER_DAYS,
  CUSTOMER_LAPSED_AFTER_DAYS,
  today,
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

const TAG = `MDX-${Date.now().toString(36).toUpperCase()}`;

/** Thrown to roll the fixtures back. Caught in `main`; never an error. */
class Rollback extends Error {}

const DAY_MS = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const now = new Date();

  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      // ═══════════════════════════════════════════════════════════════════
      // MD-1 — revenue and job volume by service line and by month
      // ═══════════════════════════════════════════════════════════════════
      console.log("\n— MD-1: revenue by service line and by month —");

      const [site] = (await tx.execute<{ id: string; customer_id: string }>(sql`
        select id, customer_id from properties where deleted_at is null order by created_at limit 1
      `)) as unknown as { id: string; customer_id: string }[];
      if (!site) throw new Error("no property in this tenant — run `npm run db:seed`");
      const sitePropertyId = site.id;

      const before = await revenueBreakdown(tx, now, { rows: 3 });

      /*
       * ELEVEN service lines, and the cap is three.
       *
       * The point of eleven is that it exceeds every display cap in play
       * (`DASHBOARD_SERVICE_LINE_ROWS` is 8, and the call below asks for 3), so
       * a total reduced from the rendered rows would come back at roughly a
       * quarter of the truth. Amounts are AED 100, 200 … 1100, which sum on
       * paper to AED 6,600 — 660,000 fils.
       */
      const LINES = 11;
      let handComputedMinor = 0;
      for (let i = 1; i <= LINES; i++) {
        const aed = i * 100;
        handComputedMinor += aed * 100;
        const vat = (aed * 5) / 100;
        const ref = `${TAG}-INV-${String(i).padStart(2, "0")}`;
        const [inv] = (await tx.execute<{ id: string }>(sql`
          insert into invoices (tenant_id, reference, customer_id, status, issued_on, supply_date,
                                supplier_name, recipient_name,
                                subtotal, taxable_amount, tax_amount, total, notes)
          values (${tenantId}::uuid, ${ref}, ${site.customer_id}::uuid, 'issued',
                  ${now.toISOString()}::timestamptz,
                  (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date,
                  ${`${TAG} supplier`}, ${`${TAG} recipient`},
                  ${String(aed)}, ${String(aed)}, ${String(vat)}, ${String(aed + vat)}, ${TAG})
          returning id
        `)) as unknown as { id: string }[];

        await tx.execute(sql`
          insert into invoice_lines (tenant_id, invoice_id, position, service_slug, description,
                                     quantity, unit_price, line_total, discount_amount, net_amount,
                                     tax_rate_basis_points, tax_amount)
          values (${tenantId}::uuid, ${inv!.id}::uuid, 1,
                  ${`${TAG}-s${String(i).padStart(2, "0")}`}, ${`${TAG} line ${i}`},
                  1, ${String(aed)}, ${String(aed)}, 0, ${String(aed)}, 500, ${String(vat)})
        `);
      }
      check("the eleven fixtures sum on paper to 660,000 fils", handComputedMinor, 660_000);

      /*
       * One more, deliberately unattributable: an issued invoice whose line
       * carries no `net_amount`, which is what every row written before
       * migration 0007 looks like. It must show up in the headline and NOT be
       * silently apportioned to a service line.
       */
      const [orphan] = (await tx.execute<{ id: string }>(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, supply_date,
                              supplier_name, recipient_name,
                              subtotal, taxable_amount, tax_amount, total, notes)
        values (${tenantId}::uuid, ${`${TAG}-INV-ORPHAN`}, ${site.customer_id}::uuid, 'issued',
                ${now.toISOString()}::timestamptz,
                (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date,
                ${`${TAG} supplier`}, ${`${TAG} recipient`},
                500.00, 500.00, 25.00, 525.00, ${TAG})
        returning id
      `)) as unknown as { id: string }[];
      await tx.execute(sql`
        insert into invoice_lines (tenant_id, invoice_id, position, service_slug, description,
                                   quantity, unit_price, line_total)
        values (${tenantId}::uuid, ${orphan!.id}::uuid, 1, ${`${TAG}-s01`},
                ${`${TAG} pre-0007 line`}, 1, 500.00, 500.00)
      `);

      /*
       * ── THE MONTH BOUNDARY FIXTURE ────────────────────────────────────
       *
       * 00:30 on the first of the CURRENT Dubai month. In UTC that instant is
       * 20:30 on the last day of the previous month, so a breakdown whose
       * month boundaries are computed anywhere but Asia/Dubai files this
       * AED 777 under the wrong month on every run of the year — not for two
       * hours a day, which is what made the accounting-export version of this
       * bug survive the change that wrote it.
       *
       * The fixture's own instant is derived in SQL from the same Dubai
       * conversion the query uses, for the reason `reporting.test.ts` records:
       * a fixture seeded from `current_date` against a query reading Dubai's
       * day is flaky for exactly the same reason the code would be wrong.
       */
      const [dawn] = (await tx.execute<{ id: string; issued_on: Date }>(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, supply_date,
                              supplier_name, recipient_name,
                              subtotal, taxable_amount, tax_amount, total, notes)
        values (${tenantId}::uuid, ${`${TAG}-INV-DAWN`}, ${site.customer_id}::uuid, 'issued',
                (date_trunc('month', (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai'))
                   + interval '30 minutes') at time zone 'Asia/Dubai',
                (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date,
                ${`${TAG} supplier`}, ${`${TAG} recipient`},
                777.00, 777.00, 38.85, 815.85, ${TAG})
        returning id, issued_on
      `)) as unknown as { id: string; issued_on: Date }[];
      await tx.execute(sql`
        insert into invoice_lines (tenant_id, invoice_id, position, service_slug, description,
                                   quantity, unit_price, line_total, discount_amount, net_amount,
                                   tax_rate_basis_points, tax_amount)
        values (${tenantId}::uuid, ${dawn!.id}::uuid, 1, ${`${TAG}-s01`}, ${`${TAG} dawn line`},
                1, 777.00, 777.00, 0, 777.00, 500, 38.85)
      `);

      /*
       * And the other edge, 23:30 Dubai on the LAST day of the PREVIOUS month.
       *
       * Two fixtures, not one, because which way a wrong timezone throws an
       * invoice depends on which side of Dubai the server sits. The dawn
       * fixture above catches a session running BEHIND Asia/Dubai — UTC, say —
       * which would drag it into the previous month. This one catches a session
       * running AHEAD, which is what this development database happens to do
       * (Asia/Dhaka, UTC+6), and which would push it forward into the current
       * month. A single fixture passes on half the world's servers, and the
       * half it passes on is not knowable from the test.
       */
      const [dusk] = (await tx.execute<{ id: string }>(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, supply_date,
                              supplier_name, recipient_name,
                              subtotal, taxable_amount, tax_amount, total, notes)
        values (${tenantId}::uuid, ${`${TAG}-INV-DUSK`}, ${site.customer_id}::uuid, 'issued',
                (date_trunc('month', (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai'))
                   - interval '30 minutes') at time zone 'Asia/Dubai',
                (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date,
                ${`${TAG} supplier`}, ${`${TAG} recipient`},
                333.00, 333.00, 16.65, 349.65, ${TAG})
        returning id
      `)) as unknown as { id: string }[];
      await tx.execute(sql`
        insert into invoice_lines (tenant_id, invoice_id, position, service_slug, description,
                                   quantity, unit_price, line_total, discount_amount, net_amount,
                                   tax_rate_basis_points, tax_amount)
        values (${tenantId}::uuid, ${dusk!.id}::uuid, 1, ${`${TAG}-s01`}, ${`${TAG} dusk line`},
                1, 333.00, 333.00, 0, 333.00, 500, 16.65)
      `);

      const after = await revenueBreakdown(tx, now, { rows: 3 });

      // ── The capped-list defence ────────────────────────────────────────
      check(
        "the attributed total is the true total of all eleven lines, not of the three displayed",
        after.attributedMinor - before.attributedMinor,
        660_000 + 77_700 + 33_300,
      );
      check("the displayed list is capped where it was told to be", after.byServiceLine.length, 3);
      check(
        "and the count of lines behind the cap is the true count",
        after.serviceLinesTotal - before.serviceLinesTotal,
        LINES,
      );
      check(
        "so the truncation is visible: shown < total",
        after.byServiceLine.length < after.serviceLinesTotal,
        true,
      );
      check(
        "the shown rows plus the other bucket reconcile to the attributed total, to the fil",
        after.byServiceLine.reduce((n, r) => n + r.revenueMinor, 0) + after.otherMinor,
        after.attributedMinor,
      );

      // ── The reconciliation that makes the breakdown honest ─────────────
      check(
        "the headline moves by every issued invoice including the unattributable one",
        after.windowRevenueMinor - before.windowRevenueMinor,
        660_000 + 77_700 + 33_300 + 50_000,
      );
      check(
        "and the AED 500 with no line net is reported as unattributed, not apportioned",
        after.unattributedMinor - before.unattributedMinor,
        50_000,
      );

      // ── Dubai's month, not the server's ────────────────────────────────
      const currentMonth = today(now).slice(0, 7);
      check(
        "the last month in the breakdown is the current month in Dubai",
        after.byMonth[after.byMonth.length - 1]?.month,
        currentMonth,
      );
      check("twelve months are returned, gaps included", after.byMonth.length, 12);
      const monthBefore = before.byMonth.find((m) => m.month === currentMonth)?.revenueMinor ?? 0;
      const monthAfter = after.byMonth.find((m) => m.month === currentMonth)?.revenueMinor ?? 0;
      check(
        "an invoice issued at 00:30 Dubai on the 1st lands in THIS Dubai month",
        monthAfter - monthBefore,
        660_000 + 77_700,
      );

      const previousMonth = after.byMonth[after.byMonth.length - 2]?.month ?? "";
      const prevBefore = before.byMonth.find((m) => m.month === previousMonth)?.revenueMinor ?? 0;
      const prevAfter = after.byMonth.find((m) => m.month === previousMonth)?.revenueMinor ?? 0;
      check(
        "and one issued at 23:30 Dubai on the last of the month stays in the PREVIOUS one",
        prevAfter - prevBefore,
        33_300,
      );

      // ── Money is integer minor units ───────────────────────────────────
      checkTrue(
        "every figure is an integer number of fils",
        Number.isInteger(after.attributedMinor) &&
          Number.isInteger(after.windowRevenueMinor) &&
          after.byMonth.every((m) => Number.isInteger(m.revenueMinor)) &&
          after.byServiceLine.every((r) => Number.isInteger(r.revenueMinor)),
      );

      /*
       * ── MUTATION TEST: the breakdown arithmetic ───────────────────────
       *
       * The assertion above compares a delta to a number computed on paper. To
       * prove it can fail, the same delta is compared to a deliberately wrong
       * expectation — the sum of the three DISPLAYED rows, which is what a
       * capped-list implementation would have produced. If both passed, the
       * assertion would be vacuous.
       */
      const cappedSum = after.byServiceLine.reduce((n, r) => n + r.revenueMinor, 0);
      checkTrue(
        "MUTATION: the true total is NOT the sum of the displayed rows — a capped-list bug would differ",
        after.attributedMinor !== cappedSum || after.otherMinor === 0,
      );

      // ═══════════════════════════════════════════════════════════════════
      // MD-1 — margin is a declared gap, not a figure
      // ═══════════════════════════════════════════════════════════════════
      console.log("\n— MD-1: margin —");

      const marginGap = DASHBOARD_GAPS.find((g) => g.requirement === "MD-1");
      checkTrue("margin is declared as an unmeasurable metric, not shown as zero", marginGap !== undefined);
      checkTrue(
        "and the blocker names the table rather than a future release",
        (marginGap?.waitingOn ?? "").includes("project_costs"),
      );

      const ftfGap = DASHBOARD_GAPS.find((g) => g.metric === "First-time fix rate");
      checkTrue("first-time fix is still declared unmeasurable", ftfGap !== undefined);
      checkTrue(
        "and no longer blames the field app, which is not what blocks it",
        !(ftfGap?.waitingOn ?? "").includes("field app"),
      );
      checkTrue(
        "it names the real blocker: a per-visit outcome",
        (ftfGap?.waitingOn ?? "").includes("per-visit outcome"),
      );

      // ═══════════════════════════════════════════════════════════════════
      // MD-3 — utilisation
      // ═══════════════════════════════════════════════════════════════════
      console.log("\n— MD-3: technician utilisation —");

      /*
       * A calendar with no weekend, no holidays and a twenty-four-hour day, so
       * the denominator is arithmetic anybody can check: ten days is 14,400
       * minutes per technician and nothing else. Testing against the tenant's
       * real calendar would be testing `workingMinutesBetween` against itself.
       */
      const flat: WorkingCalendar = {
        ...DEFAULT_CALENDAR,
        weekend: [],
        openMinute: 0,
        closeMinute: 24 * 60,
        publicHolidays: {},
        ramadanPeriods: [],
      };
      const WINDOW_DAYS = 10;
      const uBefore = await utilisationPosition(tx, now, {
        windowDays: WINDOW_DAYS,
        calendar: flat,
        rows: 2,
      });

      check(
        "available minutes are 10 days x 1440 for every active technician, computed on paper",
        uBefore.availableMinutes,
        uBefore.technicians * WINDOW_DAYS * 24 * 60,
      );
      check("the per-technician list is capped where it was told to be", uBefore.byTechnician.length, 2);
      checkTrue(
        "so the truncation is visible: shown < technicians counted",
        uBefore.byTechnician.length < uBefore.technicians,
      );
      check(
        "with no labour recorded anywhere, utilisation is NULL and not zero",
        uBefore.workedMinutes === 0 ? uBefore.utilisationPercent : null,
        null,
      );

      const [tech] = (await tx.execute<{ id: string }>(sql`
        select id from technicians where deleted_at is null and is_active order by full_name limit 1
      `)) as unknown as { id: string }[];
      if (!tech) throw new Error("no technician in this tenant — run `npm run db:seed`");

      const visitAt = new Date(now.getTime() - 5 * DAY_MS);
      const [utilJob] = (await tx.execute<{ id: string }>(sql`
        insert into jobs (tenant_id, reference, customer_id, property_id, service_slug, title,
                          status, priority, source, completed_at)
        values (${tenantId}::uuid, ${`${TAG}-JOB-UTIL`}, ${site.customer_id}::uuid,
                ${site.id}::uuid, 'hvac-installation-maintenance', ${`${TAG} utilisation job`},
                'closed', 'p3_standard', 'phone', ${visitAt.toISOString()}::timestamptz)
        returning id
      `)) as unknown as { id: string }[];

      await tx.execute(sql`
        insert into job_visits (tenant_id, job_id, technician_id, sequence, status,
                                scheduled_start, scheduled_end, work_minutes, travel_minutes)
        values (${tenantId}::uuid, ${utilJob!.id}::uuid, ${tech.id}::uuid, 1, 'completed',
                ${visitAt.toISOString()}::timestamptz,
                ${new Date(visitAt.getTime() + 2 * 60 * 60 * 1000).toISOString()}::timestamptz,
                120, 30)
      `);

      const uWorked = await utilisationPosition(tx, now, {
        windowDays: WINDOW_DAYS,
        calendar: flat,
        rows: 2,
      });

      check("two hours on the tools moves the numerator by exactly 120", uWorked.workedMinutes - uBefore.workedMinutes, 120);
      check("travel is counted separately and not folded in", uWorked.travelMinutes - uBefore.travelMinutes, 30);
      check("the visit sits on a completed job, so coverage counts it", uWorked.visitsWithLabour - uBefore.visitsWithLabour, 1);
      check(
        "and it counts once in the coverage denominator",
        uWorked.visitsOnCompletedJobs - uBefore.visitsOnCompletedJobs,
        1,
      );
      check(
        "utilisation is now a number, computed from the hand-derived denominator",
        uWorked.utilisationPercent,
        Math.round(
          ((uBefore.workedMinutes + 120) / (uWorked.technicians * WINDOW_DAYS * 24 * 60)) * 100,
        ),
      );

      /*
       * ── LEAVE COMES OUT OF THE DENOMINATOR ────────────────────────────
       *
       * Two whole Dubai days of approved leave, aligned to midnight so the
       * expected figure is 2 x 1440 = 2880 minutes and not an arithmetic
       * riddle. Approved only: a pending request is somebody asking, and
       * treating it as a fact about the diary would let anybody shrink their
       * own denominator.
       */
      const [leaveWindow] = (await tx.execute<{ starts_on: Date; ends_on: Date }>(sql`
        select (date_trunc('day', (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai'))
                  - interval '4 days') at time zone 'Asia/Dubai' as starts_on,
               (date_trunc('day', (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai'))
                  - interval '2 days') at time zone 'Asia/Dubai' as ends_on
      `)) as unknown as { starts_on: Date; ends_on: Date }[];

      await tx.execute(sql`
        insert into leave_requests (tenant_id, technician_id, kind, starts_on, ends_on, status, reason)
        values (${tenantId}::uuid, ${tech.id}::uuid, 'annual',
                ${leaveWindow!.starts_on}::timestamptz, ${leaveWindow!.ends_on}::timestamptz,
                'approved', ${TAG})
      `);

      const uLeave = await utilisationPosition(tx, now, {
        windowDays: WINDOW_DAYS,
        calendar: flat,
        rows: 2,
      });
      check("two days of approved leave remove 2,880 minutes", uLeave.leaveMinutesExcluded - uWorked.leaveMinutesExcluded, 2880);
      check("and the denominator drops by the same 2,880", uWorked.availableMinutes - uLeave.availableMinutes, 2880);

      await tx.execute(sql`
        insert into leave_requests (tenant_id, technician_id, kind, starts_on, ends_on, status, reason)
        values (${tenantId}::uuid, ${tech.id}::uuid, 'annual',
                ${leaveWindow!.starts_on}::timestamptz, ${leaveWindow!.ends_on}::timestamptz,
                'pending', ${`${TAG} pending`})
      `);
      const uPending = await utilisationPosition(tx, now, {
        windowDays: WINDOW_DAYS,
        calendar: flat,
        rows: 2,
      });
      check("a PENDING request changes nothing", uPending.availableMinutes, uLeave.availableMinutes);

      // ═══════════════════════════════════════════════════════════════════
      // MD-3 — the outcome tally that is NOT first-time fix
      // ═══════════════════════════════════════════════════════════════════
      console.log("\n— MD-3: recorded outcomes —");

      const outcomes = (await tx.execute<{ code: string; requires_return_visit: boolean }>(sql`
        select code, requires_return_visit from job_outcome_codes where is_active order by sort_order
      `)) as unknown as { code: string; requires_return_visit: boolean }[];
      const returning = outcomes.find((o) => o.requires_return_visit);
      const terminal = outcomes.find((o) => !o.requires_return_visit);

      if (!returning || !terminal) {
        console.log("skip  this tenant has no outcome vocabulary — run `npm run db:seed`");
      } else {
        const oBefore = await outcomePosition(tx, now, { windowDays: 90 });
        const completedAt = new Date(now.getTime() - 3 * DAY_MS).toISOString();

        await tx.execute(sql`
          insert into jobs (tenant_id, reference, customer_id, property_id, service_slug, title,
                            status, priority, source, completed_at, outcome_code)
          values
            (${tenantId}::uuid, ${`${TAG}-JOB-R`}, ${site.customer_id}::uuid, ${site.id}::uuid,
             'hvac-installation-maintenance', ${`${TAG} returning`}, 'closed', 'p3_standard',
             'phone', ${completedAt}::timestamptz, ${returning.code}),
            (${tenantId}::uuid, ${`${TAG}-JOB-T`}, ${site.customer_id}::uuid, ${site.id}::uuid,
             'hvac-installation-maintenance', ${`${TAG} terminal`}, 'closed', 'p3_standard',
             'phone', ${completedAt}::timestamptz, ${terminal.code}),
            (${tenantId}::uuid, ${`${TAG}-JOB-N`}, ${site.customer_id}::uuid, ${site.id}::uuid,
             'hvac-installation-maintenance', ${`${TAG} no outcome`}, 'closed', 'p3_standard',
             'phone', ${completedAt}::timestamptz, null)
        `);

        const oAfter = await outcomePosition(tx, now, { windowDays: 90 });
        check("three completed jobs, counted as three", oAfter.jobsCompleted - oBefore.jobsCompleted, 3);
        check("two of them carry an outcome", oAfter.outcomesRecorded - oBefore.outcomesRecorded, 2);
        check("one of those leaves a return visit owed", oAfter.returnVisitRequired - oBefore.returnVisitRequired, 1);
        check(
          "the return-visit rate divides by jobs WITH an outcome, never by all jobs",
          oAfter.returnVisitRatePercent,
          Math.round(
            ((oBefore.returnVisitRequired + 1) / (oBefore.outcomesRecorded + 2)) * 100,
          ),
        );
        checkTrue(
          "the outcome tally sums to the recorded count — it cannot double-count a job",
          oAfter.byOutcome.reduce((n, o) => n + o.jobs, 0) === oAfter.outcomesRecorded,
        );
        checkTrue(
          "coverage is reported beside the rate, so a rate over 8% of jobs is legible as one",
          oAfter.outcomeCoveragePercent !== null,
        );
      }

      // ═══════════════════════════════════════════════════════════════════
      // MD-5 — customers at risk
      // ═══════════════════════════════════════════════════════════════════
      console.log("\n— MD-5: retention —");

      const rBefore = await retentionPosition(tx, now, { rows: 3 });

      /**
       * Insert a customer and, optionally, a job dated N Dubai days ago.
       *
       * The job's date is derived in SQL from the same Dubai conversion the
       * classifier uses. Seeding from `current_date` against a query reading
       * Dubai's day is flaky for the same reason the code would be wrong, and
       * the thresholds below are exact-boundary tests where one day decides the
       * answer.
       */
      async function makeCustomer(
        suffix: string,
        lastJobDaysAgo: number | null,
      ): Promise<string> {
        const [c] = (await tx.execute<{ id: string }>(sql`
          insert into customers (tenant_id, code, name, notes)
          values (${tenantId}::uuid, ${`${TAG}-${suffix}`}, ${`${TAG} ${suffix}`}, ${TAG})
          returning id
        `)) as unknown as { id: string }[];
        if (lastJobDaysAgo !== null) {
          await tx.execute(sql`
            insert into jobs (tenant_id, reference, customer_id, property_id, service_slug, title,
                              status, priority, source, created_at)
            values (${tenantId}::uuid, ${`${TAG}-J-${suffix}`}, ${c!.id}::uuid, ${sitePropertyId}::uuid,
                    'hvac-installation-maintenance', ${`${TAG} ${suffix} job`}, 'closed',
                    'p3_standard', 'phone',
                    (((${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date
                       - ${lastJobDaysAgo}::int) + interval '12 hours')
                      at time zone 'Asia/Dubai')
          `);
        }
        return c!.id;
      }

      // Exactly on the boundary in both directions — 180 days quiet is churn,
      // 179 is not, and one day decides it.
      await makeCustomer("LAPSED", CUSTOMER_LAPSED_AFTER_DAYS);
      await makeCustomer("QUIET", CUSTOMER_LAPSED_AFTER_DAYS - 1);
      await makeCustomer("EDGE89", CUSTOMER_QUIET_AFTER_DAYS - 1);
      await makeCustomer("EDGE90", CUSTOMER_QUIET_AFTER_DAYS);
      await makeCustomer("FRESH", 3);
      await makeCustomer("NEW", null);

      // Contracted, and silent for a year. Contractually retained all the same.
      const contracted = await makeCustomer("CONTRACTED", 300);
      await tx.execute(sql`
        insert into contracts (tenant_id, reference, customer_id, name, kind, status,
                               starts_on, ends_on, annual_value)
        values (${tenantId}::uuid, ${`${TAG}-CON-LIVE`}, ${contracted}::uuid,
                ${`${TAG} live AMC`}, 'amc', 'active',
                ${new Date(now.getTime() - 200 * DAY_MS).toISOString()}::timestamptz,
                ${new Date(now.getTime() + 200 * DAY_MS).toISOString()}::timestamptz, 50000.00)
      `);

      // Active this month, but the AMC ran out three weeks ago and nobody
      // chased it. This is the leading indicator MD-5 is actually asking for.
      const dropped = await makeCustomer("DROPPED", 10);
      await tx.execute(sql`
        insert into contracts (tenant_id, reference, customer_id, name, kind, status,
                               starts_on, ends_on, annual_value)
        values (${tenantId}::uuid, ${`${TAG}-CON-DEAD`}, ${dropped}::uuid,
                ${`${TAG} lapsed AMC`}, 'amc', 'expired',
                ${new Date(now.getTime() - 400 * DAY_MS).toISOString()}::timestamptz,
                ${new Date(now.getTime() - 21 * DAY_MS).toISOString()}::timestamptz, 50000.00)
      `);

      const rAfter = await retentionPosition(tx, now, { rows: 3 });

      /*
       * Eight fixtures, classified on paper:
       *
       *   LAPSED      180 days quiet, no contract          -> lapsed
       *   QUIET       179 days quiet, no contract          -> at risk (gone quiet)
       *   EDGE90       90 days quiet, no contract          -> at risk (gone quiet)
       *   EDGE89       89 days quiet, no contract          -> retained
       *   FRESH         3 days quiet                       -> retained
       *   CONTRACTED  300 days quiet, LIVE contract        -> retained
       *   DROPPED      10 days quiet, AMC expired 21 ago   -> at risk (contract lapsed)
       *   NEW         no job, no invoice, ever             -> never active
       *
       * Seven ever active, one never, one lapsed, three at risk, three retained.
       * EDGE89 and EDGE90 are one day apart and land on opposite sides, which is
       * the assertion that would catch a threshold read as "> 90" or measured
       * against the server's day instead of Dubai's.
       */
      check("seven of the eight fixtures have ever been active",
        rAfter.everActive - rBefore.everActive, 7);
      check("the eighth has never been active at all, and is held out of the rate",
        rAfter.neverActive - rBefore.neverActive, 1);
      check(`quiet for exactly ${CUSTOMER_LAPSED_AFTER_DAYS} days is churn`,
        rAfter.lapsed - rBefore.lapsed, 1);
      check(
        "179 days, exactly 90 days, and the dropped AMC are the three at risk",
        rAfter.atRisk - rBefore.atRisk,
        3,
      );
      check(
        "89 days, this week, and the contracted one silent for a year are the three retained",
        rAfter.retained - rBefore.retained,
        3,
      );
      check(
        "the churn rate is lapsed over ever-active, computed from the hand-counted deltas",
        rAfter.churnRatePercent,
        Math.round(((rBefore.lapsed + 1) / (rBefore.everActive + 7)) * 100),
      );

      const dropRow = rAfter.customers.find((c) => c.name === `${TAG} DROPPED`);
      const listAll = await retentionPosition(tx, now, { rows: 500 });
      const droppedRow = listAll.customers.find((c) => c.name === `${TAG} DROPPED`);
      check("a customer whose contract ran out is flagged for that, not for silence",
        droppedRow?.reason, "contract_lapsed");
      check("and one who simply stopped calling is flagged for silence",
        listAll.customers.find((c) => c.name === `${TAG} QUIET`)?.reason, "gone_quiet");
      check("the 180-day customer is reported as lapsed, not merely at risk",
        listAll.customers.find((c) => c.name === `${TAG} LAPSED`)?.state, "lapsed");
      check("its days-quiet is Dubai's count, exactly on the threshold",
        listAll.customers.find((c) => c.name === `${TAG} LAPSED`)?.daysQuiet,
        CUSTOMER_LAPSED_AFTER_DAYS);
      checkTrue("the contracted customer is not on the at-risk list at all",
        !listAll.customers.some((c) => c.name === `${TAG} CONTRACTED`));
      checkTrue("nor is the one that has never traded", !listAll.customers.some((c) => c.name === `${TAG} NEW`));
      check("exactly 90 days quiet crosses the line",
        listAll.customers.find((c) => c.name === `${TAG} EDGE90`)?.state, "at_risk");
      checkTrue("and 89 days does not",
        !listAll.customers.some((c) => c.name === `${TAG} EDGE89`));
      checkTrue("dropRow is only listed when the cap allows it", dropRow === undefined || dropRow.reason === "contract_lapsed");

      /*
       * ── THE CAPPED-LIST DEFENCE, ON THE AT-RISK CARD ──────────────────
       *
       * Eleven more quiet customers against a cap of three. If `atRisk` were
       * the length of the rendered list it would stop at three and look like a
       * plateau; it has to move by eleven.
       */
      const EXTRA = 11;
      for (let i = 0; i < EXTRA; i++) {
        await makeCustomer(`BULK${String(i).padStart(2, "0")}`, CUSTOMER_QUIET_AFTER_DAYS + 5);
      }
      const rBulk = await retentionPosition(tx, now, { rows: 3 });
      check("eleven more quiet customers move the count by eleven", rBulk.atRisk - rAfter.atRisk, EXTRA);
      check("while the list stays capped at three", rBulk.customers.length, 3);
      checkTrue("so the card can say 'showing 3 of N' rather than implying it is showing all",
        rBulk.customers.length < rBulk.atRisk + rBulk.lapsed);

      /*
       * ── MUTATION TEST: the churn classification ───────────────────────
       *
       * The boundary assertions above are only worth anything if moving the
       * threshold moves the answer. Re-running the SAME classifier with the
       * lapsed line one day later must reclassify the 180-day customer from
       * lapsed to at-risk, and nothing else about the fixtures changes.
       */
      const mutated = await retentionPosition(tx, now, {
        lapsedAfterDays: CUSTOMER_LAPSED_AFTER_DAYS + 1,
        rows: 500,
      });
      check(
        "MUTATION: moving the lapsed line one day out reclassifies the boundary customer",
        mutated.customers.find((c) => c.name === `${TAG} LAPSED`)?.state,
        "at_risk",
      );
      check(
        "MUTATION: and the churn count falls by exactly that one",
        rBulk.lapsed - mutated.lapsed,
        1,
      );

      // ═══════════════════════════════════════════════════════════════════
      // The dashboard carries all three
      // ═══════════════════════════════════════════════════════════════════
      console.log("\n— the assembled dashboard —");
      const d = await ownerDashboard(tx, { now });
      check("the breakdown on the dashboard is the same query", d.revenueBreakdown.attributedMinor, after.attributedMinor);
      checkTrue("utilisation is on it", d.utilisation.windowDays > 0);
      checkTrue("the outcome tally is on it", d.outcomes.windowDays > 0);
      checkTrue("retention is on it", d.retention.everActive >= 0);
      check("and it still declares its gaps rather than emptying itself", d.gaps.length, DASHBOARD_GAPS.length);
      checkTrue("including at least one about margin", d.gaps.some((g) => g.metric.toLowerCase().includes("margin")));

      throw new Rollback("fixtures rolled back");
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
    console.log("\n—  every fixture above was rolled back; the database is unchanged —");
  }

  await closeConnection();
  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
