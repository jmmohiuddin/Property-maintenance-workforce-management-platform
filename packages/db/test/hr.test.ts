/**
 * Employment lifecycle — integration test against real Postgres.
 *
 * `HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`. Every one of these is a row in PRD
 * §11.3 with a penalty attached, so the assertions below are on the exact
 * boundary rather than near it: the 85% WPS line to the fil, day 5 of the
 * escalation, a contract term that lapsed by one day.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── THE TWO ASSERTIONS THAT ARE REQUIREMENTS RATHER THAN TESTS ──────────────
 *
 *  1. **A health-insurance premium cannot be recorded as a salary deduction.**
 *     `HR-6` states it structurally, so it is proved twice: once through the
 *     domain layer, and once with a raw INSERT that bypasses the domain
 *     entirely. Only the second one proves the rule is true rather than merely
 *     enforced by the code path somebody happened to use.
 *  2. **A lapsed fixed-term contract with work continuing is a RENEWED
 *     contract.** Not an expired one, not a gap. The test asserts the renewed
 *     term exists as a row, on the same terms, with no second probation period.
 *
 * ── WHY EVERY ASSERTION IS A DELTA ──────────────────────────────────────────
 *
 * Same rule as `compliance.test.ts`: a suite that only passes against a
 * pristine database fails on somebody's laptop for a reason that has nothing to
 * do with the code, and the usual response is to stop trusting the suite. Every
 * count below is measured against its own fixtures.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  // HR-17
  ensureWageCycle,
  currentWageCycle,
  prepareWageFile,
  wageFileLines,
  wageFileGaps,
  confirmWageTransfer,
  unsettledWageCycles,
  permitIssuanceWarning,
  // HR-4
  recordContractTerm,
  listContractTerms,
  employmentContract,
  autoRenewExpiredContracts,
  contractAlerts,
  // HR-7
  leaveSummary,
  saveLeaveBalance,
  leaveOverview,
  recordSickLeave,
  sickLeaveYear,
  sickLeaveOverview,
  // HR-8
  recordOvertime,
  recordWorkedDay,
  listOvertime,
  workingHoursExceptions,
  weeklyWorkingHours,
  weeklyMinutesFor,
  hoursSourceWarning,
  activeTenantIds,
  // HR-13
  gratuityRegister,
  gratuityLiability,
  recordGratuitySettlement,
  listGratuitySettlements,
  overdueGratuitySettlements,
  markGratuitySettlementPaid,
  // HR-18
  skilledWorkforce,
  emiratisationPosition,
  saveOccupationClassification,
  // HR-19
  recordSubcontractor,
  subcontractorRegister,
  recordSubcontractorWorker,
  listSubcontractorWorkers,
  verifySubcontractorWorker,
  findExpiringSubcontractorObligations,
  // HR-6
  saveHealthInsurance,
  healthInsuranceFor,
  healthInsuranceGaps,
  recordSalaryDeduction,
  listSalaryDeductions,
} from "../src/domain";
import {
  addDays,
  addMonths,
  startOfMonth,
  startOfWeek,
  today,
  fromDubai,
  SICK_LEAVE_TOTAL_DAYS,
  GRATUITY_SETTLEMENT_DAYS,
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

const TAG = "HR-LIFECYCLE-TEST";
const NOW = today();

/** AED 6,000 basic — 30 days × 8 hours gives an exact AED 25.00/hour. */
const BASIC_MINOR = 600_000;

/**
 * The wage months this test operates on are in 2019, deliberately.
 *
 * The first version used the real current month, which meant it mutated the
 * cycle the compliance cron opens every day for real — writing fixture totals
 * onto it, and then deleting it on the way out. A test that destroys production
 * rows to tidy up after itself is worse than one that leaves them: the next
 * cron run silently reported a payroll of AED 0.00 as compliant.
 *
 * `wpsCycleFor` never returns a 2019 month and the cron never opens one, so
 * these two cycles are unambiguously this file's and are safe to delete. Every
 * assessment takes `now` explicitly, so the escalation ladder can still be
 * walked to the exact day.
 */
const PAID_PERIOD = "2019-03-01";
const PAID_DUE = "2019-04-01";
const LATE_PERIOD = "2019-01-01";

/**
 * Delete every row this file creates, in every tenant.
 *
 * ── WHY THIS RUNS BEFORE THE TEST AS WELL AS AFTER ──────────────────────────
 *
 * A run that fails part way never reaches its own cleanup. The next run then
 * fails on its *first* assertion, for a reason that has nothing to do with the
 * code: the fixture inserts collide on `employees_tenant_no_key`, and
 * `HR-LIFECYCLE-TEST-E1` cannot be inserted twice. The failure that gets
 * reported is whichever assertion happens to touch the missing fixture, which
 * is the most misleading shape a test failure can take.
 *
 * This is the most repeated defect in this project. Purging at both ends is the
 * shape `packages/auth/test/{reset,mfa}.test.ts` already use, and it makes the
 * suite idempotent under failure rather than only under success.
 *
 * ── WHY IT LOOPS OVER TENANTS ───────────────────────────────────────────────
 *
 * Every table below is RLS-protected and FORCE'd, so a delete outside a tenant
 * transaction removes nothing — silently, with no error and a zero row count.
 * The fixtures only ever land in one tenant, but a purge that can only reach
 * one tenant is a purge that cannot prove it left nothing behind, and the
 * isolation check at the end of this file depends on exactly that.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DELETE ────────────────────────────────────
 *
 * Wage cycles other than the two 2019 months this file opens. The compliance
 * cron opens a cycle per tenant per month, and an earlier version of this
 * cleanup deleted "every cycle with no payment lines" — which is exactly the
 * shape of a freshly opened one. It destroyed live rows, and the next scheduled
 * run reported a payroll of AED 0.00 as compliant.
 */
async function purge(): Promise<void> {
  const like = `${TAG}%`;

  for (const id of await activeTenantIds()) {
    await withTenant({ tenantId: id, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`delete from salary_deductions where reason like ${like}`);
      await tx.execute(sql`
        delete from wage_payments where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      // Only the two 2019 cycles this file opens, named explicitly. NEVER a
      // structural predicate — see the note above.
      await tx.execute(sql`
        delete from wage_cycles where period_month in (${PAID_PERIOD}::date, ${LATE_PERIOD}::date)
      `);
      await tx.execute(sql`
        delete from overtime_records where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      await tx.execute(sql`
        delete from leave_balances where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      // Sick leave is recorded against the TECHNICIAN, because that is what the
      // dispatcher reads. Purging only by employee would leave every sick
      // absence this file records behind, and the next run's ladder would start
      // eighteen days in — silently, and only in the direction that pays the
      // full-pay stage twice.
      await tx.execute(sql`
        delete from leave_requests where technician_id in (
          select id from technicians where full_name like ${like}
        )
      `);
      await tx.execute(sql`
        delete from employment_contract_terms where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      await tx.execute(sql`
        delete from employee_documents where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      await tx.execute(sql`
        delete from gratuity_settlements where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      // `subcontractor_workers` is ON DELETE cascade from its supplier, so the
      // supplier is the only row that has to be named. Anchored to the tag, as
      // everything here is — a structural predicate would eventually match a
      // real subcontractor somebody entered.
      await tx.execute(sql`delete from subcontractors where name like ${like}`);
      await tx.execute(sql`delete from employees where full_name like ${like}`);
      await tx.execute(sql`delete from technicians where full_name like ${like}`);
    });
  }
}

async function main(): Promise<void> {
  // Before anything, not only after. A crashed run leaves this file's fixtures
  // behind and the next run then fails on its first insert.
  await purge();

  const tenantId = await testTenantId();

  // The second tenant, resolved rather than guessed at, and FATAL when there
  // isn't one.
  //
  // This used to route around `otherTenantId()` with a `?? null` and a skip
  // branch, because the helper queried `tenants` outside a tenant transaction
  // and returned null whether or not a second tenant existed. The helper now
  // enumerates through the cron's SECURITY DEFINER function and throws instead,
  // so the workaround is gone with it — and so is the skip. A single-tenant
  // database is a valid state for the product; it is not a valid state for a
  // suite whose fixtures are `npm run db:seed`, which creates a second tenant
  // for exactly this purpose. The isolation proof below covers payroll and
  // employment records, which is the data a cross-tenant leak would be worst
  // in, and it must not be capable of printing green without running.
  const otherId = await otherTenantId();

  let employeeId = "";
  let unpayableId = "";
  let technicianId = "";
  let lapsedEmployeeId = "";

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const techRows = (await tx.execute<{ id: string }>(sql`
      insert into technicians (tenant_id, employee_code, full_name, phone, primary_trade, joined_on)
      values (${tenantId}::uuid, ${`${TAG}-T1`}, ${`${TAG} Technician`}, '+971500000001', 'plumbing',
              (${NOW}::date - 400)::timestamptz)
      returning id
    `)) as unknown as { id: string }[];
    technicianId = techRows[0]!.id;

    // Fully payable: a basic salary, an IBAN, and 400 days of service.
    const employeeRows = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, technician_id, employee_no, full_name, basic_salary_minor,
                             allowances, wps_iban, contract_start, status)
      values (${tenantId}::uuid, ${technicianId}::uuid, ${`${TAG}-E1`}, ${`${TAG} Payable`},
              ${BASIC_MINOR}, '{"housing": "1500.00"}'::jsonb, 'AE070331234567890123456',
              (${NOW}::date - 400), 'active')
      returning id
    `)) as unknown as { id: string }[];
    employeeId = employeeRows[0]!.id;

    // Deliberately unpayable: no IBAN. The person a wage file leaves out while
    // reporting 100% compliance.
    const unpayableRows = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, employee_no, full_name, basic_salary_minor, status)
      values (${tenantId}::uuid, ${`${TAG}-E2`}, ${`${TAG} No IBAN`}, ${BASIC_MINOR}, 'active')
      returning id
    `)) as unknown as { id: string }[];
    unpayableId = unpayableRows[0]!.id;

    console.log("\n— HR-17: the WPS wage cycle —");

    // The live cycle, opened the way the cron opens it. Asserted but never
    // mutated: this is a real row the scheduler owns.
    const live = await currentWageCycle(tx, { tenantId }, NOW);
    check("the live cycle is last month's wages", live.periodMonth, addMonths(startOfMonth(NOW), -1));
    check("due on the 1st of this month", live.dueOn, startOfMonth(NOW));

    // ── The cycle this test owns ───────────────────────────────────────────
    const cycle = await ensureWageCycle(tx, { tenantId }, { periodMonth: PAID_PERIOD });
    check("the cycle is for the period asked for", cycle.periodMonth, PAID_PERIOD);
    check("due the 1st of the following month", cycle.dueOn, PAID_DUE);

    // Idempotent: the cron calls this daily and the page on every render.
    const again = await ensureWageCycle(tx, { tenantId }, { periodMonth: PAID_PERIOD });
    check("opening it twice returns the same row", again.id, cycle.id);

    // ── Overtime feeds the file ────────────────────────────────────────────
    // Two hours of +25% overtime inside the wage month, at AED 25.00/hour, is
    // AED 62.50 exactly. If this ever reads 62.49 or 62.51 a float has crept
    // into a multiplier.
    const overtime = await recordOvertime(tx, { tenantId }, {
      employeeId,
      workedOn: addDays(PAID_PERIOD, 10),
      band: "overtime",
      minutes: 120,
    });
    check("two hours of overtime is basic + 25%, exactly", overtime.amountMinor, 6_250);

    // ── A lawful deduction ─────────────────────────────────────────────────
    await recordSalaryDeduction(tx, { tenantId }, {
      employeeId,
      kind: "salary_advance_repayment",
      amountMinor: 50_000,
      reason: `${TAG} advance repayment`,
      appliesOn: addDays(PAID_PERIOD, 15),
    });
    const deductions = await listSalaryDeductions(tx, employeeId);
    check("the lawful deduction is on file", deductions.length, 1);
    check("at the amount given", deductions[0]?.amountMinor, 50_000);

    // ── The wage file ──────────────────────────────────────────────────────
    const file = await prepareWageFile(tx, { tenantId }, cycle.id, addDays(PAID_DUE, -3));
    const line = file.lines.find((l) => l.employeeId === employeeId);
    checkTrue("the payable employee has a line", line !== undefined);
    check("basic carried through", line?.basicMinor, BASIC_MINOR);
    check("allowances summed from the jsonb", line?.allowancesMinor, 150_000);
    check("overtime picked up from the month", line?.overtimeMinor, 6_250);
    check("the deduction subtracted", line?.deductionsMinor, 50_000);
    check(
      "net is basic + allowances + overtime − deductions",
      line?.netMinor,
      BASIC_MINOR + 150_000 + 6_250 - 50_000,
    );

    const stored = await wageFileLines(tx, cycle.id);
    checkTrue("the lines were persisted", stored.some((l) => l.employeeId === employeeId));

    // The person a wage file silently leaves out. This is the check that stops
    // "100% transferred" from meaning "everybody was paid".
    const gaps = await wageFileGaps(tx);
    checkTrue("the employee with no IBAN is reported as a gap", gaps.some((g) => g.employeeId === unpayableId));
    checkTrue("and the payable one is not", gaps.every((g) => g.employeeId !== employeeId));

    // ── The 85% line, to the fil ───────────────────────────────────────────
    const prepared = ((await tx.execute<{ total_due: string }>(sql`
      select total_due from wage_cycles where id = ${cycle.id}
    `)) as unknown as { total_due: string }[])[0]!;
    const totalDueMinor = Math.round(Number(prepared.total_due) * 100);
    const required = Math.ceil((totalDueMinor * 8500) / 10_000);

    const short = await confirmWageTransfer(tx, { tenantId }, {
      cycleId: cycle.id,
      transferredMinor: required - 1,
      transferReference: `${TAG}-SIF-1`,
      confirmedOn: PAID_DUE,
    });
    check("one fil under 85% is short-paid, not settled", short.assessment.stage, "short_paid");
    check("and the shortfall is that fil", short.assessment.shortfallMinor, 1);

    const met = await confirmWageTransfer(tx, { tenantId }, {
      cycleId: cycle.id,
      transferredMinor: required,
      transferReference: `${TAG}-SIF-2`,
      confirmedOn: PAID_DUE,
    });
    checkTrue("exactly 85% meets the threshold", met.assessment.meetsThreshold);
    // Transferred ON the deadline, at exactly the floor. The only state that is
    // both sufficient and on time, and therefore the only one that settles.
    check("on the deadline and at the floor is settled", met.assessment.stage, "settled");

    const stillOpen = await unsettledWageCycles(tx, addDays(PAID_DUE, 30));
    checkTrue(
      "a settled cycle drops off the unsettled list",
      stillOpen.every((c) => c.id !== cycle.id),
    );

    // ── The block-versus-warn answer ───────────────────────────────────────
    //
    // Day 5 of the escalation suspends new work-permit issuance. This system
    // reports that as a WARNING and adds no fourth hard block — the three that
    // exist each stop an act that is itself unlawful, and late wages make no
    // worker unlawful to deploy. The test asserts the warning exists and names
    // the consequence; there is deliberately no assertion that anything is
    // blocked, because nothing is.
    const lateCycle = await ensureWageCycle(tx, { tenantId }, { periodMonth: LATE_PERIOD });
    await tx.execute(sql`
      update wage_cycles set total_due = '10000.00', total_transferred = '0', employee_count = 4
       where id = ${lateCycle.id}
    `);

    // 1 March 2019 is day 29 of the escalation on wages due 1 February.
    const deepInTheLadder = "2019-03-01";
    const warning = await permitIssuanceWarning(tx, { tenantId }, deepInTheLadder);
    checkTrue("a badly late cycle warns that permits are suspended", warning !== null);
    checkTrue(
      "and the warning names the consequence rather than 'risk'",
      warning?.includes("work-permit issuance is suspended") === true,
    );

    // Four days late is day 5 — the first rung at which permits stop. Three
    // days late is day 4 and is not, and the difference between those two days
    // is the whole reason the ladder is modelled rather than flagged.
    const beforeSuspension = await permitIssuanceWarning(tx, { tenantId }, "2019-02-04");
    check("day 4 does not warn about permits", beforeSuspension, null);
    checkTrue(
      "day 5 does",
      (await permitIssuanceWarning(tx, { tenantId }, "2019-02-05")) !== null,
    );

    // ── The raw-SQL date contract, asserted rather than assumed ───────────
    //
    // `tx.execute<T>()`'s type parameter is an ASSERTION, not a check:
    // `tx.execute<{ x: Date }>(sql`select now() as x`)` compiles and returns a
    // string, and `.getTime()` then throws in whatever code path a tidy fixture
    // happened not to reach. Every raw row type in `domain/hr.ts` declares
    // `string` for every date column, which is the truth — verified: postgres-js
    // returns a string for `date` AND for `timestamptz`.
    //
    // This locks that in. If somebody re-types one of those columns as `Date`
    // to make a call site tidier, the compiler will agree with them and only
    // this assertion will not.
    const dateShape = /^\d{4}-\d{2}-\d{2}$/;
    checkTrue("a wage cycle's due date comes back as a calendar-day string", typeof cycle.dueOn === "string");
    checkTrue("of exactly YYYY-MM-DD", dateShape.test(cycle.dueOn));
    checkTrue("and so does the period month", dateShape.test(cycle.periodMonth));
    checkTrue(
      "the file-prepared date too",
      cycle.filePreparedOn === null || dateShape.test(cycle.filePreparedOn),
    );

    console.log("\n— HR-4: the contract that renewed itself —");

    // A term that ended yesterday, on somebody who is still employed. By
    // operation of law that contract has renewed on the same terms; the system
    // must say so rather than showing an expired record.
    const lapsedRows = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, employee_no, full_name, basic_salary_minor, status)
      values (${tenantId}::uuid, ${`${TAG}-E3`}, ${`${TAG} Lapsed`}, ${BASIC_MINOR}, 'active')
      returning id
    `)) as unknown as { id: string }[];
    lapsedEmployeeId = lapsedRows[0]!.id;

    const termStart = addMonths(addDays(NOW, -1), -12);
    await recordContractTerm(tx, { tenantId }, {
      employeeId: lapsedEmployeeId,
      startsOn: termStart,
      endsOn: addDays(NOW, -1),
      probationEndsOn: addMonths(termStart, 3),
      noticePeriodDays: 30,
      basicSalaryMinor: BASIC_MINOR,
    });

    const beforeSweep = await employmentContract(tx, lapsedEmployeeId, NOW);
    check("a lapsed term with work continuing reads as renewed", beforeSweep?.assessment?.state, "auto_renewed");
    checkTrue("and names the term the law deems to be running", beforeSweep?.assessment?.deemedTerm !== null);

    const renewals = await autoRenewExpiredContracts(tx, { tenantId }, NOW);
    const renewal = renewals.find((r) => r.employeeId === lapsedEmployeeId);
    checkTrue("the sweep records it", renewal !== undefined);
    check("starting the day after the old term ended", renewal?.startsOn, NOW);
    check("as term 2", renewal?.sequence, 2);

    const terms = await listContractTerms(tx, lapsedEmployeeId);
    check("two terms on file", terms.length, 2);
    check("the first is superseded, not deleted", terms[0]?.status, "superseded");
    check("the second is the renewal", terms[1]?.origin, "auto_renewed");
    // Probation is non-extendable and belongs to the first term only. A renewal
    // that carried it forward would be an unlawful second probation period.
    check("the renewal carries no probation period", terms[1]?.probationEndsOn, null);
    check("and the same basic salary", terms[1]?.basicSalaryMinor, BASIC_MINOR);

    checkTrue("contract term dates are calendar-day strings", typeof terms[1]?.startsOn === "string");
    checkTrue(
      "of exactly YYYY-MM-DD",
      /^\d{4}-\d{2}-\d{2}$/.test(terms[1]?.startsOn ?? ""),
    );

    const afterSweep = await employmentContract(tx, lapsedEmployeeId, NOW);
    check("after the sweep the contract reads as active", afterSweep?.assessment?.state, "active");

    // Idempotent: the cron runs nightly and must not stack renewals.
    const secondSweep = await autoRenewExpiredContracts(tx, { tenantId }, NOW);
    checkTrue(
      "running the sweep again renews nothing",
      secondSweep.every((r) => r.employeeId !== lapsedEmployeeId),
    );

    // A defective contract is recorded and reported, not refused. The database
    // CHECK stops a probation period past six months, so the defect this
    // exercises is the one the domain catches.
    const alerts = await contractAlerts(tx, NOW);
    checkTrue("the contract board reports something", alerts.length > 0);

    console.log("\n— HR-7: annual leave —");

    const leave = await leaveSummary(tx, employeeId, NOW);
    // 400 days of service is over a year, so the entitlement is the full 30.
    check("over a year's service entitles 30 calendar days", leave?.entitlement?.days, 30);
    check("and the basis is stated", leave?.entitlement?.basis, "full_year");
    check("nothing taken yet", leave?.takenDays, 0);

    // The leave year the summary itself is measured against — the service
    // anniversary, not the service start. Writing against the wrong one saves a
    // row nothing ever reads, and the balance simply never changes.
    const leaveYearStart = leave?.leaveYearStart ?? startOfMonth(NOW);
    await saveLeaveBalance(tx, { tenantId }, {
      employeeId,
      leaveYearStart,
      carriedOverDays: 5,
      adjustmentDays: -2,
      reason: `${TAG} adjustment`,
    });
    const adjusted = await leaveSummary(tx, employeeId, NOW);
    check("carry-over is held", adjusted?.carriedOverDays, 5);
    check("and the adjustment", adjusted?.adjustmentDays, -2);
    check(
      "remaining is accrued + carried + adjustment − taken",
      adjusted?.remainingDays,
      (adjusted?.accruedDays ?? 0) + 5 - 2 - (adjusted?.takenDays ?? 0),
    );

    // An adjustment with no reason is refused — it is indistinguishable from a
    // mistake when it is challenged at termination.
    let leaveRefused = false;
    try {
      await saveLeaveBalance(tx, { tenantId }, {
        employeeId,
        leaveYearStart,
        adjustmentDays: 3,
      });
    } catch {
      leaveRefused = true;
    }
    checkTrue("an adjustment with no reason is refused", leaveRefused);

    const overview = await leaveOverview(tx, NOW);
    checkTrue("the leave board includes the fixture", overview.some((r) => r.employeeId === employeeId));

    console.log("\n— HR-7: sick leave, which is three rates and not one —");

    // Two absences in the same leave year, in order, on the fixture whose
    // service started 400 days ago — so the leave year began at the twelve-
    // month anniversary, roughly five weeks back, and both absences fall
    // inside it.
    //
    // The pair is chosen to land ON the boundary rather than near it. Twelve
    // days first takes the full-pay stage to day 12; the six that follow are
    // days 13, 14, 15 at full pay and 16, 17, 18 at half. Day 15 and day 16 are
    // where the rate changes, and this proves the ladder crosses it through
    // real rows rather than only in the unit test.
    const firstAbsence = await recordSickLeave(tx, { tenantId }, {
      employeeId,
      startsOn: addDays(NOW, -25),
      endsOn: addDays(NOW, -14),
      reason: `${TAG} first absence`,
    }, NOW);
    check("a twelve-day absence is twelve days", firstAbsence.days, 12);
    check("all of it at full pay", firstAbsence.year?.fullPayDays, 12);
    check("none of it at half", firstAbsence.year?.halfPayDays, 0);
    check("and 78 of the 90 remain", firstAbsence.year?.remainingDays, 78);

    const secondAbsence = await recordSickLeave(tx, { tenantId }, {
      employeeId,
      startsOn: addDays(NOW, -10),
      endsOn: addDays(NOW, -5),
      reason: `${TAG} second absence`,
    }, NOW);
    check("a second six-day absence is six days", secondAbsence.days, 6);

    const year = await sickLeaveYear(tx, employeeId, NOW);
    check("eighteen sick days in the leave year", year?.takenDays, 18);
    // The whole point: the second absence CONTINUES the ladder. Restarting it
    // would pay all six of those days at full pay.
    check("fifteen of them at full pay, not eighteen", year?.fullPayDays, 15);
    check("and three at half pay", year?.halfPayDays, 3);
    check("with none unpaid yet", year?.unpaidDays, 0);
    check("seventy-two of the ninety remain", year?.remainingDays, 72);
    check("the ladder is ninety days long", SICK_LEAVE_TOTAL_DAYS, 90);

    const secondPeriod = year?.periods[1];
    check("the second absence starts at day 12 of the year", secondPeriod?.daysAlreadyTaken, 12);
    check("so three of its days are the rest of the full-pay stage", secondPeriod?.fullPayDays, 3);
    check("and three fall past day 15, at half pay", secondPeriod?.halfPayDays, 3);

    // AED 6,000 basic + AED 1,500 housing is AED 7,500 a month, so AED 250.00 a
    // day over 30. Fifteen full days is AED 3,750.00 and three half days is
    // AED 375.00 — AED 4,125.00 for the year, to the fil.
    check("the year's sick pay, in fils", year?.payMinor, 412_500);

    // Sick leave is a separate entitlement, not a draw on the annual one.
    const afterSick = await leaveSummary(tx, employeeId, NOW);
    check("annual leave taken is still nothing", afterSick?.takenDays, 0);
    check("and the summary carries the sick year alongside it", afterSick?.sick?.takenDays, 18);

    const sickBoard = await sickLeaveOverview(tx, NOW);
    const boardRow = sickBoard.find((r) => r.employeeId === employeeId);
    checkTrue("the HR board sees the absence", boardRow !== undefined);
    check("with the same staging the record shows", boardRow?.fullPayDays, 15);

    // The date contract again, on the new rows: calendar days as YYYY-MM-DD
    // strings, never round-tripped through a JS Date.
    const sickShape = /^\d{4}-\d{2}-\d{2}$/;
    checkTrue("a sick period's start comes back as a string", typeof secondPeriod?.startsOn === "string");
    checkTrue("of exactly YYYY-MM-DD", sickShape.test(secondPeriod?.startsOn ?? ""));
    checkTrue("and so does its end", sickShape.test(secondPeriod?.endsOn ?? ""));
    checkTrue("as does the leave year start", sickShape.test(year?.leaveYearStart ?? ""));

    // An absence longer than the statutory year is refused, by name: past 90
    // days it is a termination question under Article 34 and not a longer sick
    // leave, and recording it as one hides the decision.
    let tooLong = "";
    try {
      await recordSickLeave(tx, { tenantId }, {
        employeeId,
        startsOn: addDays(NOW, -200),
        endsOn: addDays(NOW, -60),
      }, NOW);
    } catch (error) {
      tooLong = error instanceof Error ? error.message : "";
    }
    checkTrue("an absence past the 90-day year is refused", tooLong.includes("Article 34"));

    // An employment record with no technician link has nowhere to put an
    // absence the dispatcher can see, and says so rather than storing it where
    // nothing reads it. `unpayableId` is the fixture with no technician.
    let noTechnician = "";
    try {
      await recordSickLeave(tx, { tenantId }, {
        employeeId: unpayableId,
        startsOn: addDays(NOW, -3),
        endsOn: addDays(NOW, -2),
      }, NOW);
    } catch (error) {
      noTechnician = error instanceof Error ? error.message : "";
    }
    checkTrue(
      "an unlinked record cannot hold leave, and the refusal says why",
      noTechnician.includes("dispatcher"),
    );

    // ── Sick leave is not short-notice annual leave ───────────────────────
    //
    // An absence starting today, notified today. The 30-day notice rule is the
    // notice an EMPLOYER must give when it sets annual-leave dates; counting a
    // sick day against it turns every illness into a compliance flag against
    // the person who was ill, on a board about the employer's duties.
    const beforeToday = (await leaveOverview(tx, NOW)).find((r) => r.employeeId === employeeId);
    await recordSickLeave(tx, { tenantId }, {
      employeeId,
      startsOn: NOW,
      endsOn: NOW,
      reason: `${TAG} today`,
    }, NOW);
    const afterToday = (await leaveOverview(tx, NOW)).find((r) => r.employeeId === employeeId);
    check(
      "a sick day notified this morning is not short-notice annual leave",
      afterToday?.shortNoticeCount,
      beforeToday?.shortNoticeCount,
    );
    check("and it does not move the annual-leave balance", afterToday?.takenDays, beforeToday?.takenDays);

    console.log("\n— HR-8: hours by rate band —");

    // Three hours of overtime in one day is one hour past the statutory
    // maximum of two. Recorded, not refused: refusing to store hours that were
    // worked does not un-work them, it hides the breach.
    const breachDay = addDays(NOW, -2);
    await recordOvertime(tx, { tenantId }, {
      employeeId,
      workedOn: breachDay,
      band: "overtime",
      minutes: 180,
    });
    const exceptions = await workingHoursExceptions(tx, { from: addDays(NOW, -7), to: NOW });
    checkTrue(
      "three hours of overtime in a day is reported as a breach",
      exceptions.some((e) => e.employeeId === employeeId && e.workedOn === breachDay),
    );

    // Rest-day work with no compensation recorded is the other exposure.
    const restDay = addDays(NOW, -3);
    await recordOvertime(tx, { tenantId }, {
      employeeId,
      workedOn: restDay,
      band: "rest_day",
      minutes: 300,
    });
    const withRestDay = await workingHoursExceptions(tx, { from: addDays(NOW, -7), to: NOW });
    checkTrue(
      "uncompensated rest-day work is reported",
      withRestDay.some((e) => e.employeeId === employeeId && e.workedOn === restDay),
    );

    // A substitute day promised without a date is a day off nobody can prove.
    let substituteRefused = false;
    try {
      await recordOvertime(tx, { tenantId }, {
        employeeId,
        workedOn: addDays(NOW, -4),
        band: "rest_day",
        minutes: 300,
        restDayCompensation: "substitute_day",
      });
    } catch {
      substituteRefused = true;
    }
    checkTrue("a substitute day with no date is refused", substituteRefused);

    // Back to the 2019 wage month, not just the last year: the overtime that
    // fed the wage file above sits in that period, and a window that excluded
    // it would count two rows and pass while the third was unreachable.
    const recorded = await listOvertime(tx, { from: PAID_PERIOD, to: NOW, employeeId });
    check("three overtime rows on file", recorded.length, 3);
    checkTrue(
      "each stores the multiplier it was actually paid at",
      recorded.every((r) => r.multiplierBasisPoints === 12_500 || r.multiplierBasisPoints === 15_000),
    );

    // Said out loud rather than reported as a clean bill of health: nothing is
    // measuring daily and weekly hours until the field app exists.
    const sourceWarning = await hoursSourceWarning(tx);
    checkTrue(
      "the hours report says when it is measuring nothing",
      sourceWarning === null || sourceWarning.includes("attendance events"),
    );

    console.log("\n— HR-8: the 48-hour week —");

    // A week nothing else in this file touches. 18 March 2019 is a Monday,
    // which is what `startOfWeek` and Postgres date_trunc on week both return —
    // and they have to agree, because one snaps the query window and the other
    // groups the rows. A window that started on a Wednesday would report that
    // week as the three days inside it and call a sixty-hour week compliant.
    const WEEK_START = "2019-03-18";
    check("the week snaps back to its Monday", startOfWeek("2019-03-20"), WEEK_START);
    check("and a Sunday belongs to the week it ends", startOfWeek("2019-03-24"), WEEK_START);

    // Six ordinary eight-hour days: 2,880 minutes, which is exactly 48 hours.
    // Recorded as `standard` band rows, which is what makes a week countable at
    // all — a table holding only the overtime can never see a week of ordinary
    // days that ran long.
    for (let i = 0; i < 6; i++) {
      await recordOvertime(tx, { tenantId }, {
        employeeId,
        workedOn: addDays(WEEK_START, i),
        band: "standard",
        minutes: 480,
      });
    }

    const window = { from: WEEK_START, to: addDays(WEEK_START, 6), employeeId };
    const atLimit = (await weeklyWorkingHours(tx, window)).find((w) => w.weekStart === WEEK_START);
    check("six eight-hour days is 2,880 minutes", atLimit?.recordedMinutes, 2_880);
    check("counted over six days", atLimit?.daysRecorded, 6);
    // Exactly at the maximum is lawful. A `>=` here would report a compliant
    // week as a violation, and the same slip the other way on any other
    // threshold in this module reports a violation as compliant.
    check("exactly 48 hours is within the statutory maximum", atLimit?.assessment.withinLimit, true);
    check("with nothing over", atLimit?.assessment.overMinutes, 0);
    check(
      "so it is not on the breach list",
      (await weeklyWorkingHours(tx, { ...window, breachesOnly: true })).length,
      0,
    );

    // One more minute.
    const oneOver = await recordOvertime(tx, { tenantId }, {
      employeeId,
      workedOn: WEEK_START,
      band: "overtime",
      minutes: 1,
    });
    check("recording an hour reports the week back", oneOver.weekly.minutes, 2_881);
    check("one minute past 48 hours is a breach", oneOver.weekly.withinLimit, false);
    check("and the excess is that minute", oneOver.weekly.overMinutes, 1);

    const breaches = await weeklyWorkingHours(tx, { ...window, breachesOnly: true });
    check("the board reports exactly that week", breaches.length, 1);
    check("at 2,881 minutes", breaches[0]?.recordedMinutes, 2_881);
    check("starting on the Monday", breaches[0]?.weekStart, WEEK_START);
    check("and ending on the Sunday", breaches[0]?.weekEnd, addDays(WEEK_START, 6));
    checkTrue(
      "week boundaries are calendar-day strings, not instants",
      /^\d{4}-\d{2}-\d{2}$/.test(breaches[0]?.weekStart ?? ""),
    );
    check(
      "and the same total is reachable from any day inside the week",
      await weeklyMinutesFor(tx, employeeId, addDays(WEEK_START, 3)),
      2_881,
    );

    // ── Ordinary hours are hours, not a second payment ────────────────────
    //
    // Those 2,880 standard minutes are inside the March wage month, and the
    // monthly basic already pays for them. Re-preparing the file proves they
    // add nothing: 120 minutes at +25% is AED 62.50 and the extra minute is
    // AED 0.52. Were the standard band counted, this line would read
    // AED 1,263.02 — an extra AED 1,200 of ordinary pay on top of a salary
    // that had already paid it, every month, for everybody.
    const rebuilt = await prepareWageFile(tx, { tenantId }, cycle.id, addDays(PAID_DUE, -3));
    const rebuiltLine = rebuilt.lines.find((l) => l.employeeId === employeeId);
    check("48 hours of ordinary time adds nothing to the wage line", rebuiltLine?.overtimeMinor, 6_302);
    check("and the overtime minutes exclude it too", rebuiltLine?.overtimeMinutes, 121);

    // ── A worked day, split from its start and end ────────────────────────
    //
    // 20:00 to 04:00 is eight hours, all of it ordinary time, and none of it
    // earns the +50% night premium — the answer people get wrong in the
    // expensive direction by classifying on the clock alone. This is the path
    // that runs `splitWorkedWindow` against real rows.
    const nightShiftDay = "2019-04-01";
    const nightShift = await recordWorkedDay(tx, { tenantId }, {
      employeeId,
      workedOn: nightShiftDay,
      start: fromDubai(2019, 4, 1, 20 * 60),
      end: fromDubai(2019, 4, 2, 4 * 60),
    });
    check("eight hours worked", nightShift.split.totalMinutes, 480);
    check("all of it ordinary time", nightShift.split.standardMinutes, 480);
    check("and none of it at the night premium", nightShift.split.nightMinutes, 0);
    check("one band on file for the day", nightShift.bandsRecorded.length, 1);
    check("the standard one", nightShift.bandsRecorded[0], "standard");
    check("and the week now knows about those hours", nightShift.weekly.minutes, 480);

    // ── A correction must not leave the old bands standing ────────────────
    //
    // 14:00–00:00 is ten hours: eight ordinary and two of overtime that fall
    // inside 22:00–04:00, so at +50%. Re-entered as 14:00–22:00 those two
    // hours did not happen — and a correction that leaves them on file leaves
    // them paid.
    const correctedDay = "2019-04-08";
    const beforeCorrection = await recordWorkedDay(tx, { tenantId }, {
      employeeId,
      workedOn: correctedDay,
      start: fromDubai(2019, 4, 8, 14 * 60),
      end: fromDubai(2019, 4, 9, 0),
    });
    check("ten hours worked", beforeCorrection.split.totalMinutes, 600);
    check("two of them at the night rate", beforeCorrection.split.nightMinutes, 120);
    check("recorded as two bands", beforeCorrection.bandsRecorded.length, 2);

    const afterCorrection = await recordWorkedDay(tx, { tenantId }, {
      employeeId,
      workedOn: correctedDay,
      start: fromDubai(2019, 4, 8, 14 * 60),
      end: fromDubai(2019, 4, 8, 22 * 60),
    });
    check("the corrected day is eight hours", afterCorrection.split.totalMinutes, 480);
    checkTrue("and the night band is withdrawn, not left standing", afterCorrection.bandsCleared.includes("night"));

    const correctedRows = await listOvertime(tx, { from: correctedDay, to: correctedDay, employeeId });
    check("one row left on the corrected day", correctedRows.length, 1);
    check("the standard one", correctedRows[0]?.band, "standard");
    check("and the week is eight hours, not ten", afterCorrection.weekly.minutes, 480);

    console.log("\n— HR-6: health insurance, and the deduction that must be impossible —");

    // AED 6,000 basic + AED 1,500 housing is AED 7,500 — above the AED 4,000
    // Essential Benefits threshold, so a standard plan is what is required.
    await saveHealthInsurance(tx, { tenantId }, {
      employeeId,
      plan: "standard",
      insurer: `${TAG} Insurer`,
      policyNo: "POL-1",
      premiumMinor: 120_000,
    });
    const cover = await healthInsuranceFor(tx, employeeId);
    check("the required plan follows the wage", cover?.requiredPlan, "standard");
    check("the premium is held as an employer cost", cover?.premiumMinor, 120_000);
    // No in-date `health_insurance` document exists for this fixture, so the
    // cover is still incomplete — and it must say so from the DOCUMENT, which
    // is the single source of truth for expiry.
    checkTrue(
      "a missing policy document is still a gap",
      cover?.problems.some((p) => p.includes("No in-date health insurance policy")) === true,
    );

    await tx.execute(sql`
      insert into employee_documents (tenant_id, employee_id, kind, expires_at, blocking)
      values (${tenantId}::uuid, ${employeeId}::uuid, 'health_insurance', (${NOW}::date + 90), true)
    `);
    const covered = await healthInsuranceFor(tx, employeeId);
    check("with the document in date the cover is compliant", covered?.problems.length, 0);

    const insuranceGaps = await healthInsuranceGaps(tx);
    checkTrue("the compliant employee is off the gap list", insuranceGaps.every((g) => g.employeeId !== employeeId));
    checkTrue("the one with no cover at all is on it", insuranceGaps.some((g) => g.employeeId === unpayableId));

    // ── The structural refusal, through the domain ─────────────────────────
    let insuranceDeductionMessage = "";
    try {
      await recordSalaryDeduction(tx, { tenantId }, {
        employeeId,
        kind: "health_insurance",
        amountMinor: 10_000,
        reason: "premium",
      });
    } catch (error) {
      insuranceDeductionMessage = error instanceof Error ? error.message : "";
    }
    checkTrue("a health-insurance deduction is refused", insuranceDeductionMessage !== "");
    checkTrue(
      "and the refusal names Dubai Law No. 11 of 2013",
      insuranceDeductionMessage.includes("Dubai Law No. 11 of 2013"),
    );

    let recruitmentMessage = "";
    try {
      await recordSalaryDeduction(tx, { tenantId }, {
        employeeId,
        kind: "visa_cost",
        amountMinor: 10_000,
        reason: "visa",
      });
    } catch (error) {
      recruitmentMessage = error instanceof Error ? error.message : "";
    }
    checkTrue("a visa-cost deduction is refused too (HR-16)", recruitmentMessage.includes("Article 6"));

    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n— HR-13: gratuity, on basic salary only —");
    // ═══════════════════════════════════════════════════════════════════════
    //
    // The arithmetic itself is proved to the fil in
    // `packages/core/test/employment.test.ts`, on the exact boundaries: 364
    // days against one year, five years against five years and a day, the
    // two-years cap biting and not biting. What is proved HERE is everything
    // that only a database can get wrong — which service date the register
    // reads, that a settlement freezes its inputs rather than joining to them,
    // and that every day-valued column comes back as a `YYYY-MM-DD` string.

    // A twin of E1: same service start, same basic, four times the allowance.
    // It exists for one assertion — the gratuity must be identical and the cap
    // must not be, which is the whole of `HR-13`'s "basic salary only" in two
    // numbers.
    const twinRows = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, employee_no, full_name, basic_salary_minor,
                             allowances, wps_iban, contract_start, status)
      values (${tenantId}::uuid, ${`${TAG}-E4`}, ${`${TAG} Allowance Twin`}, ${BASIC_MINOR},
              '{"housing": "4000.00"}'::jsonb, 'AE070331234567890123458',
              (${NOW}::date - 400), 'active')
      returning id
    `)) as unknown as { id: string }[];
    const twinId = twinRows[0]!.id;

    const register = await gratuityRegister(tx, NOW);
    const mineE1 = register.find((r) => r.employeeId === employeeId);
    const mineTwin = register.find((r) => r.employeeId === twinId);
    const mineNoStart = register.find((r) => r.employeeId === unpayableId);

    checkTrue("the register carries the payable employee", mineE1 !== undefined);
    // The trap this module tests for by name: a `date` column read back as a
    // space-separated timestamp string, or worse as a `Date` that moved a day.
    checkTrue(
      "the service start comes back as a YYYY-MM-DD string",
      /^\d{4}-\d{2}-\d{2}$/.test(mineE1?.serviceStart ?? ""),
    );
    check("read from contract_start, 400 days ago", mineE1?.serviceStart, addDays(NOW, -400));
    check("400 days is one completed year", mineE1?.accrual?.service.completedYears, 1);
    checkTrue("so gratuity has started accruing", mineE1?.accrual?.eligible === true);
    // 21 days at AED 200/day is AED 4,200, plus a pro-rated tail for the 35
    // days past the anniversary. More than the flat year, less than two.
    checkTrue("more than the flat 21 days", (mineE1?.accrual?.amountMinor ?? 0) > 21 * 20_000);
    checkTrue("and less than two years' worth", (mineE1?.accrual?.amountMinor ?? 0) < 42 * 20_000);

    // ── The requirement, in two assertions ────────────────────────────────
    check(
      "an AED 4,000 housing allowance changes the gratuity by nothing",
      mineTwin?.accrual?.amountMinor,
      mineE1?.accrual?.amountMinor,
    );
    checkTrue(
      "but it does change the two-years cap, which is measured on the whole wage",
      (mineTwin?.accrual?.capMinor ?? 0) > (mineE1?.accrual?.capMinor ?? 0),
    );
    check("E1's cap is 24 × (basic + AED 1,500)", mineE1?.accrual?.capMinor, (BASIC_MINOR + 150_000) * 24);
    check("the twin's is 24 × (basic + AED 4,000)", mineTwin?.accrual?.capMinor, (BASIC_MINOR + 400_000) * 24);
    check("neither cap bites at one year", mineTwin?.accrual?.capApplied, false);

    // ── The employee nobody can compute ──────────────────────────────────
    check("an employee with no service start has no accrual", mineNoStart?.accrual, null);
    checkTrue(
      "and says so rather than reporting zero",
      (mineNoStart?.problem ?? "").includes("no service start date"),
    );

    const liability = await gratuityLiability(tx, NOW);
    checkTrue("the liability is a positive number", liability.totalMinor > 0);
    checkTrue("and counts the employees it could not compute", liability.uncomputableCount >= 1);
    check(
      "the total is exactly the sum of the register, and nothing else",
      liability.totalMinor,
      register.reduce((n, r) => n + (r.accrual?.eligible ? r.accrual.amountMinor : 0), 0),
    );

    // ── The settlement, and the 14-day deadline ──────────────────────────
    const settlement = await recordGratuitySettlement(tx, { tenantId }, {
      employeeId: twinId,
      terminatedOn: NOW,
    });
    check("dues are payable 14 days after termination", settlement.dueOn, addDays(NOW, GRATUITY_SETTLEMENT_DAYS));
    check("at the accrued figure, not one somebody typed", settlement.amountMinor, mineTwin?.accrual?.amountMinor);

    const settlements = await listGratuitySettlements(tx, NOW);
    const mySettlement = settlements.find((s) => s.id === settlement.id);
    checkTrue("the settlement is on file", mySettlement !== undefined);
    checkTrue(
      "with its dates as YYYY-MM-DD strings",
      /^\d{4}-\d{2}-\d{2}$/.test(mySettlement?.dueOn ?? "") &&
        /^\d{4}-\d{2}-\d{2}$/.test(mySettlement?.terminatedOn ?? "") &&
        /^\d{4}-\d{2}-\d{2}$/.test(mySettlement?.serviceStart ?? ""),
    );
    check("the cap did not bite", mySettlement?.capApplied, false);
    check("so the amount equals the uncapped figure", mySettlement?.amountMinor, mySettlement?.uncappedMinor);
    check("not overdue on the day of termination", mySettlement?.overdue, false);

    // A second settlement for the same termination is how somebody gets paid
    // twice, so it is refused rather than merged.
    let doubleSettlement = "";
    try {
      await recordGratuitySettlement(tx, { tenantId }, { employeeId: twinId, terminatedOn: NOW });
    } catch (error) {
      doubleSettlement = error instanceof Error ? error.message : "";
    }
    checkTrue("a second settlement for the same employee is refused", doubleSettlement.includes("already has"));

    // And an employee whose figure cannot be computed cannot be settled at all,
    // rather than being settled at zero.
    let uncomputableSettlement = "";
    try {
      await recordGratuitySettlement(tx, { tenantId }, { employeeId: unpayableId, terminatedOn: NOW });
    } catch (error) {
      uncomputableSettlement = error instanceof Error ? error.message : "";
    }
    checkTrue(
      "and one with no service dates is refused rather than settled at zero",
      uncomputableSettlement.includes("Cannot settle"),
    );

    check("nothing is overdue today", (await overdueGratuitySettlements(tx, NOW)).length, 0);
    const overdueLater = await overdueGratuitySettlements(tx, addDays(NOW, GRATUITY_SETTLEMENT_DAYS + 1));
    checkTrue(
      "but it is on the 15th day",
      overdueLater.some((s) => s.id === settlement.id),
    );

    // "Paid" with nothing behind it is an assertion, and the limitation period
    // for a labour claim is two years.
    let unreferenced = "";
    try {
      await markGratuitySettlementPaid(tx, { settlementId: settlement.id, paidOn: NOW, reference: "  " });
    } catch (error) {
      unreferenced = error instanceof Error ? error.message : "";
    }
    checkTrue("marking it paid with no reference is refused", unreferenced.includes("reference"));

    await markGratuitySettlementPaid(tx, {
      settlementId: settlement.id,
      paidOn: addDays(NOW, 3),
      reference: `${TAG}-WPS-1`,
    });
    const afterPaid = await overdueGratuitySettlements(tx, addDays(NOW, GRATUITY_SETTLEMENT_DAYS + 1));
    check(
      "a paid settlement stops being overdue, whenever it was paid",
      afterPaid.filter((s) => s.id === settlement.id).length,
      0,
    );

    // ── Frozen inputs ────────────────────────────────────────────────────
    //
    // Every input to a settlement moves afterwards — the salary gets corrected,
    // the contract terms get superseded, and the employee record is purged two
    // years after termination by HR-15. A settlement that could only be
    // recomputed from rows that no longer exist is not evidence of anything.
    await tx.execute(sql`
      update employees set basic_salary_minor = 999999 where id = ${twinId}::uuid
    `);
    const frozen = (await listGratuitySettlements(tx, NOW)).find((s) => s.id === settlement.id);
    check("the settlement keeps the salary it was computed on", frozen?.basicMonthlyMinor, BASIC_MINOR);
    check("and the amount does not move with it", frozen?.amountMinor, settlement.amountMinor);
    await tx.execute(sql`
      update employees set basic_salary_minor = ${BASIC_MINOR} where id = ${twinId}::uuid
    `);

    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n— HR-18: Emiratisation, and the skilled denominator —");
    // ═══════════════════════════════════════════════════════════════════════

    const before = await emiratisationPosition(tx);

    // E1: ISCO 3, certificate held, AED 7,500 total. All three legs pass.
    await saveOccupationClassification(tx, {
      employeeId,
      iscoMajorGroup: 3,
      postSecondaryCertificate: true,
    });
    // The twin: ISCO 7, craft and related trades. Excluded on the first leg
    // whatever the other two say, which is the case the requirement is about.
    await saveOccupationClassification(tx, {
      employeeId: twinId,
      iscoMajorGroup: 7,
      postSecondaryCertificate: true,
    });
    // E2 is left entirely unrecorded: no group, no certificate answer, no wage.

    const workforce = await skilledWorkforce(tx);
    const wE1 = workforce.find((w) => w.employeeId === employeeId);
    const wTwin = workforce.find((w) => w.employeeId === twinId);
    const wUnknown = workforce.find((w) => w.employeeId === unpayableId);

    check("ISCO 3 + certificate + AED 7,500 is skilled", wE1?.test.classification, "skilled");
    check("and the group is labelled rather than left as a number", wE1?.iscoLabel, "Technicians and associate professionals");
    check("ISCO 7 is excluded on the first leg", wTwin?.test.classification, "excluded");
    checkTrue("and it names the group in the reason", (wTwin?.test.reasons[0] ?? "").includes("group 7"));
    check("an employee with nothing recorded is unknown, not unskilled", wUnknown?.test.classification, "unknown");

    const after = await emiratisationPosition(tx);
    check("one more skilled employee than before", after.skilled, before.skilled + 1);
    check("and one more excluded", after.excluded, before.excluded + 1);
    check(
      "the upper bound is skilled plus the unclassifiable",
      after.upperBound,
      after.skilled + after.unknown,
    );
    check(
      "and every active employee lands in exactly one bucket",
      after.skilled + after.excluded + after.unknown,
      after.headcount,
    );
    checkTrue("the unknowns are stated rather than hidden", (after.caveat ?? "").includes("unclassifiable"));
    // The point of the whole requirement: headcount is NOT the denominator.
    checkTrue("headcount is larger than the skilled count", after.headcount > after.skilled);

    let badGroup = "";
    try {
      await saveOccupationClassification(tx, {
        employeeId,
        iscoMajorGroup: 12,
        postSecondaryCertificate: true,
      });
    } catch (error) {
      badGroup = error instanceof Error ? error.message : "";
    }
    checkTrue("an ISCO group outside 1–9 is refused", badGroup.includes("1 to 9"));

    // ═══════════════════════════════════════════════════════════════════════
    console.log("\n— HR-19: the subcontractor register —");
    // ═══════════════════════════════════════════════════════════════════════

    const supplier = await recordSubcontractor(tx, { tenantId }, {
      name: `${TAG} Manpower LLC`,
      kind: "manpower_supplier",
      tradeSlug: "electrical",
      // Lapsed. Responsibility for site compliance does not transfer with the
      // work, so this is our exposure and not only theirs.
      tradeLicenceNo: "CR-99887",
      tradeLicenceExpiresOn: addDays(NOW, -41),
      liabilityInsurer: "Oman Insurance",
      liabilityPolicyNo: "TPL-2026-1",
      liabilityExpiresOn: addDays(NOW, 20),
      workmenCompInsurer: "Daman",
      workmenCompPolicyNo: "WC-2026-1",
      // Well outside the 90-day horizon, so it must NOT appear in the sweep.
      workmenCompExpiresOn: addDays(NOW, 200),
      approvalReference: "DM-SUBAPP-1",
      // Fifteen digits. Anything else is refused — asserted below.
      taxRegistrationNumber: "100123456700003",
      // The free-form tail. One lapsed and one live, so the sweep is proved to
      // reach INTO the jsonb rather than only across the three columns.
      accreditations: [
        { name: `${TAG} IRATA Level 3`, issuer: "IRATA International", expiresOn: addDays(NOW, -12) },
        { name: `${TAG} ISO 45001`, issuer: "EIAC", expiresOn: addDays(NOW, 400) },
      ],
      status: "approved",
    });

    await recordSubcontractorWorker(tx, { tenantId }, {
      subcontractorId: supplier.id,
      fullName: `${TAG} Supplied Current`,
      tradeSlug: "electrical",
      workPermitNo: "WP-1",
      workPermitExpiresOn: addDays(NOW, 30),
    });
    const lapsedWorker = await recordSubcontractorWorker(tx, { tenantId }, {
      subcontractorId: supplier.id,
      fullName: `${TAG} Supplied Lapsed`,
      workPermitNo: "WP-2",
      workPermitExpiresOn: addDays(NOW, -5),
      verified: false,
    });

    const suppliers = await subcontractorRegister(tx, NOW);
    const mySupplier = suppliers.find((s) => s.id === supplier.id);
    checkTrue("the supplier is on the register", mySupplier !== undefined);
    check("labelled as a manpower supplier, not a subcontractor", mySupplier?.kindLabel, "Manpower supplier");
    checkTrue(
      "expiry dates come back as YYYY-MM-DD strings",
      /^\d{4}-\d{2}-\d{2}$/.test(mySupplier?.tradeLicenceExpiresOn ?? ""),
    );
    check("two supplied workers", mySupplier?.workerCount, 2);
    check("one of them with a lapsed permit", mySupplier?.expiredPermitCount, 1);
    checkTrue(
      "the lapsed trade licence is a stated problem",
      (mySupplier?.problems ?? []).some((p) => p.startsWith("Trade licence expired")),
    );
    checkTrue(
      "and the lapsed permit names the Article 60 exposure",
      (mySupplier?.problems ?? []).some((p) => p.includes("AED 100,000")),
    );
    check("the supplier TRN is on file", mySupplier?.taxRegistrationNumber, "100123456700003");
    check("both accreditations are read back", mySupplier?.accreditations.length, 2);
    check("one of them has lapsed", mySupplier?.lapsedAccreditations.length, 1);
    check("named", mySupplier?.lapsedAccreditations[0]?.name, `${TAG} IRATA Level 3`);
    check("with its issuer", mySupplier?.accreditations[0]?.issuer, "IRATA International");
    checkTrue(
      "and the lapse is a stated problem, not only a count",
      (mySupplier?.problems ?? []).some((p) => p.includes("accreditation") && p.includes("expired")),
    );

    // The TRN is the same fifteen digits a tax invoice enforces, and it is one
    // rule rather than two: a supplier TRN that does not match their invoice is
    // input tax nobody can evidence.
    let badTrn = "";
    try {
      await recordSubcontractor(tx, { tenantId }, {
        name: `${TAG} Bad TRN LLC`,
        kind: "subcontractor",
        taxRegistrationNumber: "1234",
      });
    } catch (error) {
      badTrn = error instanceof Error ? error.message : "";
    }
    checkTrue("a TRN that is not fifteen digits is refused", badTrn.includes("fifteen digits"));
    check(
      "cover that is in date is NOT a problem",
      (mySupplier?.problems ?? []).filter((p) => p.startsWith("Workmen")).length,
      0,
    );

    const workers = await listSubcontractorWorkers(tx, supplier.id, NOW);
    check("both workers are listed", workers.length, 2);
    const current = workers.find((w) => w.fullName === `${TAG} Supplied Current`);
    const lapsed = workers.find((w) => w.id === lapsedWorker.id);
    checkTrue("whoever recorded the current one is on the row as the verifier", current?.verifiedAt !== null);
    check("30 days of permit left", current?.daysRemaining, 30);
    check("and the lapsed one expired five days ago", lapsed?.daysRemaining, -5);
    check("recorded without a verification, because nobody looked", lapsed?.verifiedAt, null);

    // ── The sweep, which is the same one HR-5 and HR-14 already use ──────
    const expiring = await findExpiringSubcontractorObligations(tx, 90, NOW);
    const mineExpiring = expiring.filter((e) => e.subcontractorId === supplier.id);
    // Seven obligations exist against this supplier: three organisation-level
    // columns, two worker permits and two jsonb accreditations. Five are inside
    // 90 days — the workmen's compensation cover at 200 days and the ISO 45001
    // certificate at 400 are not.
    check("five of the seven obligations are inside 90 days", mineExpiring.length, 5);
    checkTrue(
      "the lapsed trade licence, with a negative countdown",
      mineExpiring.some((e) => e.kind === "trade_licence" && e.daysRemaining === -41),
    );
    checkTrue(
      "the liability policy at 20 days",
      mineExpiring.some((e) => e.kind === "liability_insurance" && e.daysRemaining === 20),
    );
    checkTrue(
      "one worker permit, named",
      mineExpiring.some((e) => e.kind === "work_permit" && e.subject === `${TAG} Supplied Lapsed`),
    );
    check(
      "and NOT the workmen's compensation cover, which is 200 days out",
      mineExpiring.filter((e) => e.kind === "workmen_comp").length,
      0,
    );
    // The jsonb tail is swept by the SAME query, not by a second mechanism.
    checkTrue(
      "the lapsed accreditation inside the jsonb is swept, and named",
      mineExpiring.some(
        (e) => e.kind === "accreditation" && e.subject === `${TAG} IRATA Level 3` && e.daysRemaining === -12,
      ),
    );
    check(
      "and the one 400 days out is not",
      mineExpiring.filter((e) => e.kind === "accreditation").length,
      1,
    );
    check(
      "both worker permits inside 90 days are swept",
      mineExpiring.filter((e) => e.kind === "work_permit").length,
      2,
    );

    // ── Re-verification ─────────────────────────────────────────────────
    await verifySubcontractorWorker(tx, {}, {
      workerId: lapsedWorker.id,
      workPermitNo: "WP-2-RENEWED",
      workPermitExpiresOn: addDays(NOW, 700),
    });
    const reverified = (await listSubcontractorWorkers(tx, supplier.id, NOW)).find(
      (w) => w.id === lapsedWorker.id,
    );
    check("the renewed permit is on file", reverified?.workPermitNo, "WP-2-RENEWED");
    checkTrue("with a verification stamped on it", reverified?.verifiedAt !== null);
    const afterRenewal = await subcontractorRegister(tx, NOW);
    check(
      "and the supplier no longer has an expired permit against it",
      afterRenewal.find((s) => s.id === supplier.id)?.expiredPermitCount,
      0,
    );
  });

  // ── The same refusal, with the domain layer bypassed ─────────────────────
  //
  // The assertion above proves the code path refuses. This one proves the RULE
  // is true: a raw INSERT, no validation in the way, straight at the table. If
  // this passes, `HR-6` is enforced by the database and survives every future
  // code path, every script and every `psql` session.
  //
  // In its own transaction, because a constraint violation aborts the one it
  // happens in and would take every assertion after it down with it.
  console.log("\n— the constraint, with the domain layer bypassed —");
  let rawRefused = false;
  let rawMessage = "";
  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`
        insert into salary_deductions (tenant_id, employee_id, kind, amount, reason)
        values (${tenantId}::uuid, ${employeeId}::uuid, 'health_insurance', '100.00', 'bypassing the domain')
      `);
    });
  } catch (error) {
    rawRefused = true;
    // Drizzle wraps the driver error and keeps the Postgres one on `cause`, so
    // the constraint name is there and not in `message`. Asserting on the name
    // rather than on "some error happened" is what makes this test prove the
    // CHECK is doing the refusing — a foreign-key failure or a typo in the
    // table name would also have thrown.
    const cause = (error as { cause?: { constraint_name?: string; message?: string } }).cause;
    rawMessage = cause?.constraint_name ?? cause?.message ?? "";
  }
  checkTrue("a raw INSERT of an insurance deduction is refused by Postgres", rawRefused);
  check("by the CHECK constraint specifically", rawMessage, "salary_deductions_kind_check");

  let rawOtherRefused = false;
  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`
        insert into salary_deductions (tenant_id, employee_id, kind, amount, reason)
        values (${tenantId}::uuid, ${employeeId}::uuid, 'other', '100.00', 'the escape hatch')
      `);
    });
  } catch {
    rawOtherRefused = true;
  }
  // The positive list is what makes this true. A negative list of forbidden
  // kinds would let "other" through, and "other" is what the premium gets typed
  // in as ten seconds after the first refusal.
  checkTrue("and so is 'other', because the list is a positive one", rawOtherRefused);

  // ── The leave vocabulary, with the domain layer bypassed ─────────────────
  //
  // Same shape, same reason. The sick-leave ladder counts the rows whose kind
  // is exactly 'sick', so a day recorded as 'sick_leave' is a day the ladder
  // never sees — the employee reads as having more of the 90 statutory days
  // left than they do, and the fifteenth day of full pay gets paid twice. A
  // validator in a server action would not have stopped it arriving through
  // `psql`, a script, or the next code path somebody writes.
  console.log("\n— the leave vocabulary, with the domain layer bypassed —");
  let rawKindRefused = false;
  let rawKindConstraint = "";
  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`
        insert into leave_requests (tenant_id, technician_id, kind, starts_on, ends_on, status)
        values (${tenantId}::uuid, ${technicianId}::uuid, 'sick_leave',
                ${NOW}::date, ${NOW}::date, 'approved')
      `);
    });
  } catch (error) {
    rawKindRefused = true;
    const cause = (error as { cause?: { constraint_name?: string; message?: string } }).cause;
    rawKindConstraint = cause?.constraint_name ?? cause?.message ?? "";
  }
  checkTrue("a misspelt leave kind is refused by Postgres", rawKindRefused);
  check("by the CHECK constraint specifically", rawKindConstraint, "leave_requests_kind_check");

  // And the vocabulary is not so narrow that a real absence has nowhere to go.
  let lawfulKindAccepted = false;
  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx.execute(sql`
      insert into leave_requests (tenant_id, technician_id, kind, starts_on, ends_on, status)
      values (${tenantId}::uuid, ${technicianId}::uuid, 'bereavement',
              ${NOW}::date, ${NOW}::date, 'approved')
    `);
    lawfulKindAccepted = true;
  });
  checkTrue("a kind on the list is accepted", lawfulKindAccepted);

  // ── The ISCO range, with the domain layer bypassed ──────────────────────
  //
  // Same shape and the same reason as the two above. The skilled test in
  // `packages/core` reads major group 1-5 as skilled and 6-9 as excluded, and
  // a group 12 is neither — `classifySkilledEmployee` would report it as
  // excluded, because 12 is outside 1-5, and it would be reporting a typo as a
  // legal classification. `saveOccupationClassification` refuses it, but that
  // refusal is a code path somebody has to go through; the CHECK is what makes
  // it true through `psql` as well.
  console.log("\n— the ISCO range, with the domain layer bypassed —");
  let rawIscoRefused = false;
  let rawIscoConstraint = "";
  try {
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`
        update employees set isco_major_group = 12 where id = ${employeeId}::uuid
      `);
    });
  } catch (error) {
    rawIscoRefused = true;
    const cause = (error as { cause?: { constraint_name?: string; message?: string } }).cause;
    rawIscoConstraint = cause?.constraint_name ?? cause?.message ?? "";
  }
  checkTrue("an ISCO group outside 1-9 is refused by Postgres", rawIscoRefused);
  check("by the CHECK constraint specifically", rawIscoConstraint, "employees_isco_major_group_check");

  // And the constraint is NOT 1-5. An employee in group 7 is a recorded fact
  // that excludes them from the denominator; a constraint that only admitted
  // skilled groups would make the exclusion unrepresentable and push every
  // craft worker back into the unknown bucket, which is the reassuring
  // direction and therefore the wrong one.
  let group9Accepted = false;
  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx.execute(sql`
      update employees set isco_major_group = 9 where id = ${employeeId}::uuid
    `);
    group9Accepted = true;
  });
  checkTrue("but an unskilled group is a fact, not an error", group9Accepted);

  // ── Tenant isolation ─────────────────────────────────────────────────────
  //
  // Every table added by 0015 carries `tenant_id` and is covered by the generic
  // loop in sql/rls.sql. This proves the policy is actually in force rather
  // than merely written: the second tenant must see none of the rows above.
  console.log("\n— tenant isolation —");

  // A DELTA, not an absolute. The second tenant legitimately has wage cycles
  // of its own — the compliance cron opens one per tenant per month — so
  // "sees zero rows" would fail against a database the cron has ever run
  // against, for a reason that has nothing to do with RLS. What must be zero
  // is the number of THIS test's rows it can see, and the same query is run
  // under both tenants so a zero that means "the predicate matched nothing"
  // is distinguishable from a zero that means "the policy filtered it out".
  const countMine = sql`
    select (select count(*)::int from employees where full_name like ${`${TAG}%`}) as employees,
           (select count(*)::int from salary_deductions where reason like ${`${TAG}%`}) as deductions,
           (select count(*)::int from employment_contract_terms t
              join employees e on e.id = t.employee_id where e.full_name like ${`${TAG}%`}) as terms,
           (select count(*)::int from overtime_records o
              join employees e on e.id = o.employee_id where e.full_name like ${`${TAG}%`}) as overtime,
           (select count(*)::int from wage_payments p
              join employees e on e.id = p.employee_id where e.full_name like ${`${TAG}%`}) as payments,
           (select count(*)::int from leave_requests l
              join technicians t on t.id = l.technician_id where t.full_name like ${`${TAG}%`}) as leave,
           (select count(*)::int from gratuity_settlements g
              join employees e on e.id = g.employee_id where e.full_name like ${`${TAG}%`}) as settlements,
           (select count(*)::int from subcontractors s where s.name like ${`${TAG}%`}) as suppliers,
           (select count(*)::int from subcontractor_workers w
              join subcontractors s on s.id = w.subcontractor_id
             where s.name like ${`${TAG}%`}) as supplied_workers
  `;
  type Counts = {
    employees: number;
    deductions: number;
    terms: number;
    overtime: number;
    payments: number;
    leave: number;
    settlements: number;
    suppliers: number;
    supplied_workers: number;
  };

  const mine = ((await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    tx.execute<Counts>(countMine),
  )) as unknown as Counts[])[0]!;

  checkTrue("the owning tenant can see this test's rows", mine.employees > 0);
  checkTrue("including its deductions", mine.deductions > 0);
  checkTrue("its contract terms", mine.terms > 0);
  checkTrue("its overtime", mine.overtime > 0);
  checkTrue("its wage lines", mine.payments > 0);
  checkTrue("its sick leave", mine.leave > 0);
  checkTrue("its gratuity settlement", mine.settlements > 0);
  checkTrue("its subcontractor", mine.suppliers > 0);
  checkTrue("and its supplied workers", mine.supplied_workers > 0);

  const theirs = ((await withTenant({ tenantId: otherId, actorKind: "system" }, (tx) =>
    tx.execute<Counts>(countMine),
  )) as unknown as Counts[])[0]!;

  check("the other tenant sees none of the employees", theirs.employees, 0);
  check("none of the deductions", theirs.deductions, 0);
  check("none of the contract terms", theirs.terms, 0);
  check("none of the overtime", theirs.overtime, 0);
  check("none of the wage lines", theirs.payments, 0);
  check("none of the sick leave", theirs.leave, 0);
  // The three tables migration 0032 adds. Each carries `tenant_id`, so the
  // generic loop in sql/rls.sql covers them — this is what proves the loop ran.
  check("none of the gratuity settlements", theirs.settlements, 0);
  check("none of the subcontractors", theirs.suppliers, 0);
  check("and none of the supplied workers", theirs.supplied_workers, 0);

  await purge();

  console.log(
    fail === 0 ? "\nAll employment lifecycle checks passed.\n" : `\n${fail} check(s) failed.\n`,
  );
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  // Best effort. If the purge itself is what failed, the next run's own
  // opening purge is the backstop — which is the point of having one.
  await purge().catch(() => {});
  await closeConnection();
  process.exit(1);
});
