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
import { testTenantId } from "./_tenant";
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
  // HR-8
  recordOvertime,
  listOvertime,
  workingHoursExceptions,
  hoursSourceWarning,
  activeTenantIds,
  // HR-6
  saveHealthInsurance,
  healthInsuranceFor,
  healthInsuranceGaps,
  recordSalaryDeduction,
  listSalaryDeductions,
} from "../src/domain";
import { addDays, addMonths, startOfMonth, today } from "@meridian/core";

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

  // Resolved through the cron's own SECURITY DEFINER enumerator rather than
  // through `otherTenantId()`. That helper queries `tenants` outside a tenant
  // transaction, where the RLS policy on that table is `id = app_current_tenant()`
  // and the setting is unset — so it returns null whether or not a second tenant
  // exists, and the isolation check it guards silently never runs.
  const otherId = (await activeTenantIds()).find((id) => id !== tenantId) ?? null;

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

  // ── Tenant isolation ─────────────────────────────────────────────────────
  //
  // Every table added by 0015 carries `tenant_id` and is covered by the generic
  // loop in sql/rls.sql. This proves the policy is actually in force rather
  // than merely written: the second tenant must see none of the rows above.
  if (otherId) {
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
                join employees e on e.id = p.employee_id where e.full_name like ${`${TAG}%`}) as payments
    `;
    type Counts = { employees: number; deductions: number; terms: number; overtime: number; payments: number };

    const mine = ((await withTenant({ tenantId, actorKind: "system" }, (tx) =>
      tx.execute<Counts>(countMine),
    )) as unknown as Counts[])[0]!;

    checkTrue("the owning tenant can see this test's rows", mine.employees > 0);
    checkTrue("including its deductions", mine.deductions > 0);
    checkTrue("its contract terms", mine.terms > 0);
    checkTrue("its overtime", mine.overtime > 0);
    checkTrue("and its wage lines", mine.payments > 0);

    const theirs = ((await withTenant({ tenantId: otherId, actorKind: "system" }, (tx) =>
      tx.execute<Counts>(countMine),
    )) as unknown as Counts[])[0]!;

    check("the other tenant sees none of the employees", theirs.employees, 0);
    check("none of the deductions", theirs.deductions, 0);
    check("none of the contract terms", theirs.terms, 0);
    check("none of the overtime", theirs.overtime, 0);
    check("and none of the wage lines", theirs.payments, 0);
  } else {
    console.log("\n— tenant isolation — skipped, only one tenant in this database");
  }

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
