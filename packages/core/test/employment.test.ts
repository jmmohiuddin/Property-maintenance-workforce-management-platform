/**
 * Employment lifecycle unit test — `HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`.
 *
 * No database. These are the rules from §11.3 of the PRD, and every one of
 * them has a penalty attached, so the boundaries are tested on the exact day
 * rather than near it: the 85% WPS line at 8499 and 8500 basis points, day 4
 * and day 5 of the escalation, six months of probation to the day, the sixth
 * month of service for annual leave.
 *
 *   npm run test --workspace=@meridian/core
 */

import {
  // dates
  daysBetween,
  addDays,
  addMonths,
  startOfMonth,
  completedMonths,
  // HR-17
  WPS_ESCALATION,
  WPS_MINIMUM_TRANSFER_PERCENT,
  WPS_THRESHOLD_BASIS_POINTS,
  wpsCycleFor,
  wpsCycleForWagesEarnedIn,
  assessWpsCycle,
  bandFor,
  wpsPermitIssuanceSuspended,
  // HR-4
  assessContract,
  deemedRenewal,
  PROBATION_MAX_MONTHS,
  // HR-7
  annualLeaveEntitlement,
  accruedLeaveDays,
  checkLeaveNotice,
  leaveDayCount,
  // HR-8
  splitWorkedWindow,
  nightMinutesBetween,
  overtimeAmountMinor,
  hourlyBasicMinor,
  assessWorkedDay,
  ordinaryMinutesFor,
  MAX_OVERTIME_MINUTES_PER_DAY,
  PAY_BAND_BASIS_POINTS,
  // HR-6
  requiredHealthPlan,
  refuseDeduction,
  checkHealthInsurance,
  ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR,
} from "../src/employment";
import { fromDubai, DEFAULT_CALENDAR, type WorkingCalendar } from "../src/calendar";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** Dubai wall-clock → instant. */
function dxb(y: number, m: number, d: number, hh: number, mm = 0): Date {
  return fromDubai(y, m, d, hh * 60 + mm);
}

console.log("\n— calendar-day arithmetic —");

check("day difference is whole days", daysBetween("2026-08-01", "2026-09-01"), 31);
check("and signed", daysBetween("2026-09-01", "2026-08-01"), -31);
check("adding days crosses months", addDays("2026-08-31", 1), "2026-09-01");
// The overflow that quietly turns six months of probation into six months and
// three days. 31 August plus six months is 28 February, not 3 March.
check("adding months clamps rather than overflowing", addMonths("2026-08-31", 6), "2027-02-28");
check("and handles leap years", addMonths("2024-08-31", 6), "2025-02-28");
check("start of month", startOfMonth("2026-08-24"), "2026-08-01");
check("completed months ignores the part month", completedMonths("2026-01-15", "2026-07-14"), 5);
check("and counts the exact anniversary", completedMonths("2026-01-15", "2026-07-15"), 6);

console.log("\n— HR-17: the WPS calendar —");

// Wages for August are due on 1 September. The live cycle on 3 September is
// still August's, two days late — not September's, which is not yet earned.
const cycle = wpsCycleFor("2026-09-03");
check("the live cycle is last month's wages", cycle.periodMonth, "2026-08-01");
check("due on the 1st of this month", cycle.dueOn, "2026-09-01");
check("labelled by the month worked", cycle.label, "August 2026");

const earned = wpsCycleForWagesEarnedIn("2026-08-14");
check("wages earned in August are due 1 September", earned.dueOn, "2026-09-01");

check("the threshold is 85%", WPS_MINIMUM_TRANSFER_PERCENT, 85);
check("which is 8500 basis points", WPS_THRESHOLD_BASIS_POINTS, 8500);

// ── The 85% line, tested on the fil ──────────────────────────────────────────
// AED 100,000 due. 85% is AED 85,000 exactly. One fil under is a violation.
const dueMinor = 10_000_000;
const atLine = assessWpsCycle(
  {
    periodMonth: "2026-08-01",
    dueOn: "2026-09-01",
    totalDueMinor: dueMinor,
    totalTransferredMinor: 8_500_000,
    confirmedOn: "2026-09-01",
  },
  "2026-09-01",
);
check("exactly 85% is compliant", atLine.stage, "settled");
check("and reads as 8500 basis points", atLine.transferredBasisPoints, 8500);

const oneFilShort = assessWpsCycle(
  {
    periodMonth: "2026-08-01",
    dueOn: "2026-09-01",
    totalDueMinor: dueMinor,
    totalTransferredMinor: 8_499_999,
    confirmedOn: "2026-09-01",
  },
  "2026-09-01",
);
check("one fil under 85% is not", oneFilShort.stage, "short_paid");
check("and the shortfall is that fil", oneFilShort.shortfallMinor, 1);
// 84.99999% must floor to 8499, never round up over the line.
check("the share floors rather than rounding", oneFilShort.transferredBasisPoints, 8499);

// ── The escalation ladder ────────────────────────────────────────────────────
const unpaid = (on: string) =>
  assessWpsCycle(
    {
      periodMonth: "2026-08-01",
      dueOn: "2026-09-01",
      totalDueMinor: dueMinor,
      totalTransferredMinor: 0,
      confirmedOn: null,
    },
    on,
  );

check("T-6 is outside the alert window", unpaid("2026-08-26").stage, "not_due");
checkTrue("and is not alerting", unpaid("2026-08-26").alerting === false);
check("T-5 starts the countdown", unpaid("2026-08-27").stage, "countdown");
checkTrue("which alerts", unpaid("2026-08-27").alerting);
checkTrue("T-3 calls for the wage file", unpaid("2026-08-29").fileDue);
check("the 1st is due today", unpaid("2026-09-01").stage, "due_today");
check("the 2nd is the alarm", unpaid("2026-09-02").stage, "unconfirmed");
check("day 4 is still the day-2 band", unpaid("2026-09-04").stage, "unconfirmed");
check("day 5 suspends new work permits", unpaid("2026-09-05").stage, "permits_suspended");
check("day 10 has not yet reached fines", unpaid("2026-09-10").stage, "permits_suspended");
check("day 11 brings fines and downgrade", unpaid("2026-09-11").stage, "fines_and_downgrade");
check("day 16 registers labour disputes", unpaid("2026-09-16").stage, "labour_disputes");
check("day 21 reaches executive orders", unpaid("2026-09-21").stage, "executive_orders");
// Past the end of the month the ladder keeps counting rather than resetting.
check("and it does not reset at month end", unpaid("2026-10-04").stage, "executive_orders");

check("days late is zero before the deadline", unpaid("2026-08-27").daysLate, 0);
check("and counts from the 1st", unpaid("2026-09-05").daysLate, 4);

// The block-versus-warn answer, asserted rather than described.
checkTrue("day 4 does not suspend permits", wpsPermitIssuanceSuspended(unpaid("2026-09-04")) === false);
checkTrue("day 5 does", wpsPermitIssuanceSuspended(unpaid("2026-09-05")));

check("the ladder has six rungs", WPS_ESCALATION.length, 6);
check("nothing applies before day 1", bandFor(0), null);
checkTrue("every rung names a consequence", WPS_ESCALATION.every((b) => b.consequence.length > 20));

// An on-time transfer of the full payroll is the only quiet outcome.
const paid = assessWpsCycle(
  {
    periodMonth: "2026-08-01",
    dueOn: "2026-09-01",
    totalDueMinor: dueMinor,
    totalTransferredMinor: dueMinor,
    confirmedOn: "2026-08-31",
  },
  "2026-09-06",
);
check("paid early and in full is settled", paid.stage, "settled");
checkTrue("and stops alerting", paid.alerting === false);

// Paid in full, but on the 4th. Compliant in amount, not in date.
const paidLate = assessWpsCycle(
  {
    periodMonth: "2026-08-01",
    dueOn: "2026-09-01",
    totalDueMinor: dueMinor,
    totalTransferredMinor: dueMinor,
    confirmedOn: "2026-09-04",
  },
  "2026-09-06",
);
check("paid three days late is not settled", paidLate.stage, "unconfirmed");
check("and says how late", paidLate.daysLate, 3);

// A month nobody was owed anything for is not a late payroll. Both halves of
// the test matter: a file that covers nobody is "nothing due", but a month
// whose file has not been built yet is still an alarm.
const nothingDue = assessWpsCycle(
  {
    periodMonth: "2026-08-01",
    dueOn: "2026-09-01",
    totalDueMinor: 0,
    totalTransferredMinor: 0,
    confirmedOn: null,
    filePreparedOn: "2026-08-29",
    employeeCount: 0,
  },
  "2026-09-14",
);
check("a wage file covering nobody is not late", nothingDue.stage, "nothing_due");
checkTrue("and does not alert", nothingDue.alerting === false);

const unbuilt = assessWpsCycle(
  {
    periodMonth: "2026-08-01",
    dueOn: "2026-09-01",
    totalDueMinor: 0,
    totalTransferredMinor: 0,
    confirmedOn: null,
    employeeCount: 0,
  },
  "2026-09-14",
);
check("but a month whose file was never built still escalates", unbuilt.stage, "fines_and_downgrade");

console.log("\n— HR-4: contract form, probation and auto-renewal —");

const term = {
  startsOn: "2025-09-01",
  endsOn: "2026-08-31",
  probationEndsOn: "2026-01-01",
  noticePeriodDays: 30,
  contractType: "fixed_term",
};

check("a running term is active", assessContract(term, { stillEmployed: true, now: "2026-03-01" }).state, "active");
check(
  "inside the last 90 days it is expiring",
  assessContract(term, { stillEmployed: true, now: "2026-08-01" }).state,
  "expiring",
);
check(
  "during probation it says so",
  assessContract(term, { stillEmployed: true, now: "2025-11-01" }).state,
  "probation",
);

// THE case. An end date that has passed while the person kept working is a
// renewed contract, not an expired record.
const renewed = assessContract(term, { stillEmployed: true, now: "2026-10-15" });
check("a lapsed term with work continuing auto-renews", renewed.state, "auto_renewed");
check("the deemed term starts the day after", renewed.deemedTerm?.startsOn, "2026-09-01");
check("and runs the same length", renewed.deemedTerm?.endsOn, "2027-08-31");
check("first renewal", renewed.deemedTerm?.renewalCount, 1);

// Two years past the end date is two renewals, not one that also expired.
const twiceRenewed = assessContract(term, { stillEmployed: true, now: "2028-01-15" });
check("a term lapsed twice renews twice", twiceRenewed.deemedTerm?.renewalCount, 2);
check("and the live term covers today", twiceRenewed.deemedTerm?.endsOn, "2028-08-31");

// The same lapsed date, with the person gone, is an ended contract.
check(
  "a lapsed term with no employment has ended",
  assessContract(term, { stillEmployed: false, now: "2026-10-15" }).state,
  "ended",
);

check("renewal is computed on term length", deemedRenewal("2025-01-01", "2025-06-30", "2025-08-01").endsOn, "2025-12-31");

// ── Statutory defects ────────────────────────────────────────────────────────
const overlongProbation = assessContract(
  { ...term, probationEndsOn: "2026-03-15" },
  { stillEmployed: true, now: "2026-01-15" },
);
checkTrue(
  "probation past six months is a problem",
  overlongProbation.problems.some((p) => p.includes(`${PROBATION_MAX_MONTHS} months`)),
);

const shortNotice = assessContract({ ...term, noticePeriodDays: 7 }, { stillEmployed: true, now: "2026-03-01" });
checkTrue("a 7-day notice period is a problem", shortNotice.problems.some((p) => p.includes("30–90")));

const longNotice = assessContract({ ...term, noticePeriodDays: 120 }, { stillEmployed: true, now: "2026-03-01" });
checkTrue("so is 120 days", longNotice.problems.length > 0);

const unlimited = assessContract(
  { startsOn: "2025-09-01", endsOn: null, contractType: "unlimited" },
  { stillEmployed: true, now: "2026-03-01" },
);
check("an unlimited contract raises two problems", unlimited.problems.length, 2);

console.log("\n— HR-7: annual leave —");

check("under six months accrues nothing", annualLeaveEntitlement({ serviceStart: "2026-05-01", asOf: "2026-09-01" }).days, 0);
check(
  "at six months exactly, two days a month",
  annualLeaveEntitlement({ serviceStart: "2026-03-01", asOf: "2026-09-01" }).days,
  12,
);
check(
  "eleven months is twenty-two days",
  annualLeaveEntitlement({ serviceStart: "2025-10-01", asOf: "2026-09-01" }).days,
  22,
);
check(
  "a full year is thirty calendar days",
  annualLeaveEntitlement({ serviceStart: "2025-09-01", asOf: "2026-09-01" }).days,
  30,
);
check(
  "and the basis is stated, never inferred",
  annualLeaveEntitlement({ serviceStart: "2026-03-01", asOf: "2026-09-01" }).basis,
  "partial_year",
);

// The pro-rate trap: two days a month for six months is 12, not 15.
checkTrue(
  "the partial-year rule is not a pro-rated thirtieth",
  annualLeaveEntitlement({ serviceStart: "2026-03-01", asOf: "2026-09-01" }).days !== 15,
);

check("accrual mid-year is by completed month", accruedLeaveDays({ serviceStart: "2024-09-01", asOf: "2026-03-01" }), 15);
check("leave days count both ends", leaveDayCount("2026-09-01", "2026-09-30"), 30);
check("one day of leave is one day", leaveDayCount("2026-09-01", "2026-09-01"), 1);

const notice = checkLeaveNotice({ requestedOn: "2026-08-20", startsOn: "2026-09-01" });
check("twelve days' notice is short", notice.sufficient, false);
check("and says how short", notice.daysGiven, 12);
checkTrue(
  "a month's notice is sufficient",
  checkLeaveNotice({ requestedOn: "2026-08-01", startsOn: "2026-09-01" }).sufficient,
);

console.log("\n— HR-8: working hours and overtime —");

check("basic + 25%", PAY_BAND_BASIS_POINTS.overtime, 12_500);
check("night is basic + 50%", PAY_BAND_BASIS_POINTS.night, 15_000);
check("and so is rest-day work", PAY_BAND_BASIS_POINTS.rest_day, 15_000);
check("two extra hours a day", MAX_OVERTIME_MINUTES_PER_DAY, 120);

// AED 6,000 monthly basic over 30 days × 8 hours = AED 25.00/hour.
check("monthly basic converts to hourly", hourlyBasicMinor(600_000), 2_500);

// One hour of overtime on AED 25.00/hour is AED 31.25 — and it is exact,
// which is the point of doing this in basis points.
check("an hour of overtime is basic + 25%", overtimeAmountMinor(2_500, 60, "overtime"), 3_125);
check("an hour of night work is basic + 50%", overtimeAmountMinor(2_500, 60, "night"), 3_750);
check("a standard hour is the basic rate", overtimeAmountMinor(2_500, 60, "standard"), 2_500);
// The float version of this — 25 * 1.25 * (90/60) — is 46.875 and rounds
// wherever the runtime feels like it. Integer basis points give 4688 fils.
check("ninety minutes rounds once", overtimeAmountMinor(2_500, 90, "overtime"), 4_688);

// ── The split ────────────────────────────────────────────────────────────────
// 08:00–18:00 with an hour's break is nine worked hours: eight standard, one
// overtime, none at night.
const ordinaryDay = splitWorkedWindow({
  start: dxb(2026, 8, 24, 8, 0),
  end: dxb(2026, 8, 24, 18, 0),
  ordinaryMinutes: 8 * 60,
  breakMinutes: 60,
});
check("nine worked hours", ordinaryDay.totalMinutes, 9 * 60);
check("eight of them standard", ordinaryDay.standardMinutes, 8 * 60);
check("one at +25%", ordinaryDay.overtimeMinutes, 60);
check("and none at night", ordinaryDay.nightMinutes, 0);
check("within the two-hour cap", ordinaryDay.overCapMinutes, 0);

// THE case the obvious implementation gets wrong: 20:00–04:00 is eight hours.
// The whole shift is ordinary time and none of it earns the night premium,
// even though six of the hours fall inside 22:00–04:00.
const nightShift = splitWorkedWindow({
  start: dxb(2026, 8, 24, 20, 0),
  end: dxb(2026, 8, 25, 4, 0),
  ordinaryMinutes: 8 * 60,
});
check("an eight-hour night shift is eight hours", nightShift.totalMinutes, 8 * 60);
check("all of it ordinary time", nightShift.standardMinutes, 8 * 60);
check("no night premium on ordinary hours", nightShift.nightMinutes, 0);

// Extend the same shift by two hours and the extra IS overtime — and it falls
// at 04:00–06:00, outside the night window, so it is +25% not +50%.
const nightShiftPlus = splitWorkedWindow({
  start: dxb(2026, 8, 24, 20, 0),
  end: dxb(2026, 8, 25, 6, 0),
  ordinaryMinutes: 8 * 60,
});
check("two extra hours after 04:00 are +25%", nightShiftPlus.overtimeMinutes, 120);
check("and none of them at +50%", nightShiftPlus.nightMinutes, 0);

// Overtime that genuinely lands inside the night window.
const lateFinish = splitWorkedWindow({
  start: dxb(2026, 8, 24, 14, 0),
  end: dxb(2026, 8, 25, 0, 0),
  ordinaryMinutes: 8 * 60,
});
check("ten hours worked", lateFinish.totalMinutes, 10 * 60);
check("eight standard", lateFinish.standardMinutes, 8 * 60);
// Overtime runs 22:00–00:00, entirely inside the night band.
check("two hours of overtime, all at night", lateFinish.nightMinutes, 120);
check("and none at the +25% rate", lateFinish.overtimeMinutes, 0);

// Rest-day work is not split. Every minute is rest-day work.
const restDay = splitWorkedWindow({
  start: dxb(2026, 8, 22, 9, 0),
  end: dxb(2026, 8, 22, 14, 0),
  ordinaryMinutes: 8 * 60,
  isRestDay: true,
});
check("rest-day work is all one band", restDay.restDayMinutes, 5 * 60);
check("with no standard hours inside it", restDay.standardMinutes, 0);

check("night minutes are counted across midnight", nightMinutesBetween(dxb(2026, 8, 24, 21, 0), dxb(2026, 8, 25, 5, 0)), 6 * 60);
check("and are zero in the middle of the day", nightMinutesBetween(dxb(2026, 8, 24, 9, 0), dxb(2026, 8, 24, 17, 0)), 0);

// ── The cap and the statutory maxima ─────────────────────────────────────────
const overCap = assessWorkedDay({
  start: dxb(2026, 8, 24, 8, 0),
  end: dxb(2026, 8, 24, 19, 30),
  minutesThisWeek: 40 * 60,
  monthlyBasicMinor: 600_000,
});
checkTrue("eleven and a half hours warns", overCap.withinLimits === false);
checkTrue(
  "and names the two-hour overtime cap",
  overCap.warnings.some((w) => w.includes("2 extra hours")),
);

// ── Ramadan ──────────────────────────────────────────────────────────────────
const ramadanCalendar: WorkingCalendar = {
  ...DEFAULT_CALENDAR,
  ramadanPeriods: [["2027-02-08", "2027-03-09"]],
};
check(
  "the ordinary day is eight hours normally",
  ordinaryMinutesFor(dxb(2026, 8, 24, 9, 0), DEFAULT_CALENDAR),
  8 * 60,
);
check(
  "and six during Ramadan",
  ordinaryMinutesFor(dxb(2027, 2, 20, 9, 0), ramadanCalendar),
  6 * 60,
);

const ramadanDay = assessWorkedDay(
  {
    start: dxb(2027, 2, 20, 8, 0),
    end: dxb(2027, 2, 20, 15, 0),
    minutesThisWeek: 30 * 60,
    monthlyBasicMinor: 600_000,
  },
  ramadanCalendar,
);
// Seven hours in Ramadan is one hour of overtime, not a normal day.
check("a seven-hour Ramadan day has an hour of overtime", ramadanDay.split.overtimeMinutes, 60);
checkTrue(
  "and the hours check knows the day is six hours",
  ramadanDay.hours.warnings.some((w) => w.includes("Ramadan")),
);

console.log("\n— HR-6: health insurance and unlawful deductions —");

check("the EBP ceiling is AED 4,000", ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR, 400_000);
check("below it, an Essential Benefits Plan", requiredHealthPlan(399_999), "essential_benefits");
check("at it, a standard plan", requiredHealthPlan(400_000), "standard");

// The structural block. There must be no way to record this.
checkTrue("health insurance cannot be deducted", refuseDeduction("health_insurance") !== null);
checkTrue(
  "and the refusal names the law",
  refuseDeduction("health_insurance")?.includes("Dubai Law No. 11 of 2013") === true,
);
checkTrue("nor under a synonym", refuseDeduction("Medical Insurance") !== null);
checkTrue("nor as an insurance premium", refuseDeduction("insurance-premium") !== null);
checkTrue("recruitment fees are refused too (HR-16)", refuseDeduction("visa_cost") !== null);
checkTrue("an unrecognised kind is refused by default", refuseDeduction("miscellaneous") !== null);
check("a lawful kind is permitted", refuseDeduction("salary_advance_repayment"), null);
check("and so is an unpaid absence", refuseDeduction("unpaid_absence"), null);

const wrongPlan = checkHealthInsurance({
  monthlyWageMinor: 250_000,
  plan: "standard",
  insurer: "Daman",
  hasInDatePolicyDocument: true,
});
check("a standard plan under AED 4,000 is wrong", wrongPlan.compliant, false);
check("and the required plan is named", wrongPlan.requiredPlan, "essential_benefits");

const noCover = checkHealthInsurance({
  monthlyWageMinor: 250_000,
  plan: null,
  insurer: null,
  hasInDatePolicyDocument: false,
});
check("no cover at all is three problems", noCover.problems.length, 3);

const good = checkHealthInsurance({
  monthlyWageMinor: 250_000,
  plan: "essential_benefits",
  insurer: "Daman",
  hasInDatePolicyDocument: true,
});
check("the right plan with a policy on file is compliant", good.compliant, true);

console.log(fail === 0 ? "\nAll employment checks passed.\n" : `\n${fail} check(s) failed.\n`);
process.exit(fail === 0 ? 0 : 1);
