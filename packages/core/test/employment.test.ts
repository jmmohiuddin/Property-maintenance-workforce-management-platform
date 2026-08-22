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
  startOfWeek,
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
  LEAVE_KINDS,
  stageSickLeave,
  sickLeavePayMinor,
  SICK_LEAVE_FULL_PAY_DAYS,
  SICK_LEAVE_HALF_PAY_DAYS,
  SICK_LEAVE_TOTAL_DAYS,
  SICK_PAY_BASIS_POINTS,
  // HR-8
  assessWeeklyHours,
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
  // HR-13
  serviceLength,
  gratuityAccrual,
  gratuitySettlementDeadline,
  GRATUITY_DAYS_PER_YEAR_FIRST_FIVE,
  GRATUITY_DAYS_PER_YEAR_THEREAFTER,
  GRATUITY_CAP_MONTHS_OF_WAGE,
  GRATUITY_SETTLEMENT_DAYS,
  // HR-18
  classifySkilledEmployee,
  assessEmiratisation,
  ISCO_SKILLED_MAX_MAJOR_GROUP,
  EMIRATISATION_SKILLED_WAGE_FLOOR_MINOR,
  EMIRATISATION_SMALL_ESTABLISHMENT_FLOOR,
} from "../src/employment";
import { EMIRATISATION_SKILLED_THRESHOLD } from "../src/reporting";
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
// 24 August 2026 is a Monday. The week it starts is its own, and the Sunday
// before it belongs to the week that began six days earlier — the off-by-one
// that would otherwise put a Sunday's hours in the following week's total.
check("start of week is the Monday", startOfWeek("2026-08-24"), "2026-08-24");
check("a Wednesday snaps back to it", startOfWeek("2026-08-26"), "2026-08-24");
check("and a Sunday snaps back, not forward", startOfWeek("2026-08-30"), "2026-08-24");
check("the Monday after is the next week", startOfWeek("2026-08-31"), "2026-08-31");
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

console.log("\n— HR-7: sick leave, which is three rates and not one —");

check("fifteen days at full pay", SICK_LEAVE_FULL_PAY_DAYS, 15);
check("then thirty at half", SICK_LEAVE_HALF_PAY_DAYS, 30);
check("ninety days in all", SICK_LEAVE_TOTAL_DAYS, 90);
check("half pay is half, as basis points", SICK_PAY_BASIS_POINTS.half_pay, 5_000);
checkTrue("and sick is a recordable leave kind", LEAVE_KINDS.includes("sick"));

// ── The ladder, rung by rung, by day number ──────────────────────────────────
//
// Each of these is the Nth sick day of the leave year: N-1 already taken, one
// more day now. The boundaries are where the money changes, so both sides of
// every one of them is asserted rather than the middle of the stage.
const day = (n: number) => stageSickLeave({ days: 1, daysAlreadyTaken: n - 1 });

check("day 1 is full pay", day(1).fullPayDays, 1);
check("day 15 is still full pay", day(15).fullPayDays, 1);
check("and not half", day(15).halfPayDays, 0);
check("day 16 is half pay", day(16).halfPayDays, 1);
check("and no longer full", day(16).fullPayDays, 0);
check("day 45 is the last half-pay day", day(45).halfPayDays, 1);
check("and is not yet unpaid", day(45).unpaidDays, 0);
check("day 46 is unpaid", day(46).unpaidDays, 1);
check("and no longer half pay", day(46).halfPayDays, 0);
check("day 90 is the last statutory day", day(90).unpaidDays, 1);
check("and is still inside the entitlement", day(90).beyondEntitlementDays, 0);
check("day 91 is past the entitlement", day(91).beyondEntitlementDays, 1);
check("and is not unpaid sick leave", day(91).unpaidDays, 0);
check("day 90 leaves nothing", day(90).remainingDays, 0);
check("and day 91 cannot go negative", day(91).remainingDays, 0);

// ── The absence that spans two rates ─────────────────────────────────────────
//
// THE case this exists for. Twenty days is not twenty days at one rate, and
// paying it as one is five days of wage paid twice in the direction nobody
// notices.
const twenty = stageSickLeave({ days: 20 });
check("twenty days is fifteen at full pay", twenty.fullPayDays, 15);
check("and five at half", twenty.halfPayDays, 5);
check("with none unpaid", twenty.unpaidDays, 0);
check("all twenty consume the entitlement", twenty.entitlementConsumedDays, 20);
check("seventy of the ninety remain", twenty.remainingDays, 70);
checkTrue("and it is not twenty days at one rate", twenty.fullPayDays !== 20);

// ── The second absence continues; it does not restart ────────────────────────
const march = stageSickLeave({ days: 12 });
check("twelve days in March are all at full pay", march.fullPayDays, 12);
const july = stageSickLeave({ days: 6, daysAlreadyTaken: march.entitlementConsumedDays });
check("three of July's six days are the rest of the full-pay stage", july.fullPayDays, 3);
check("and the other three are at half pay", july.halfPayDays, 3);
check("the year has taken eighteen days", july.daysAlreadyTaken + july.days, 18);
check("and seventy-two remain", july.remainingDays, 72);

// A whole leave year at once, to prove the three stages fill in order.
const wholeYear = stageSickLeave({ days: 100 });
check("a hundred days fills the full-pay stage", wholeYear.fullPayDays, 15);
check("the half-pay stage", wholeYear.halfPayDays, 30);
check("the unpaid stage", wholeYear.unpaidDays, 45);
check("and leaves ten days past the entitlement", wholeYear.beyondEntitlementDays, 10);

// ── Probation ────────────────────────────────────────────────────────────────
//
// No paid sick leave during probation, and none of it consumes the ninety —
// the entitlement runs from the end of probation, so a worker who was ill in
// their second week still has all fifteen full-pay days afterwards.
const inProbation = stageSickLeave({ days: 5, probationDays: 5 });
check("five days inside probation are unpaid", inProbation.probationUnpaidDays, 5);
check("none of them at full pay", inProbation.fullPayDays, 0);
check("and none of them consume the entitlement", inProbation.entitlementConsumedDays, 0);
check("so all ninety days remain", inProbation.remainingDays, 90);

// An absence that straddles the end of probation: the first two days are
// unpaid, the rest start the ladder at day 1.
const straddling = stageSickLeave({ days: 6, probationDays: 2 });
check("the probation days stay unpaid", straddling.probationUnpaidDays, 2);
check("and the four after it are the first four full-pay days", straddling.fullPayDays, 4);
check("with the entitlement consumed by four", straddling.entitlementConsumedDays, 4);

// ── What it is worth ─────────────────────────────────────────────────────────
//
// AED 9,000 a month over 30 days is AED 300.00 a day. Fifteen full days is
// AED 4,500.00 and five half days is AED 750.00 — AED 5,250.00, to the fil.
check("full and half pay, in fils", sickLeavePayMinor(900_000, twenty), 525_000);
check("unpaid days are worth nothing", sickLeavePayMinor(900_000, day(46)), 0);
check("and a probation absence is unpaid", sickLeavePayMinor(900_000, inProbation), 0);

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

// ── The 48-hour week ─────────────────────────────────────────────────────────
//
// Both sides of the line, to the minute. Exactly 48 hours is lawful; a `>=`
// here would report a compliant week as a violation, and the same operator
// slipped the other way on any other threshold in this file reports a
// violation as compliant.
const exactly48 = assessWeeklyHours(48 * 60);
check("exactly 48 hours is within the statutory week", exactly48.withinLimit, true);
check("with nothing over", exactly48.overMinutes, 0);
check("and the limit is stated", exactly48.limitMinutes, 2_880);

const oneMinuteOver = assessWeeklyHours(48 * 60 + 1);
check("one minute past 48 hours is not", oneMinuteOver.withinLimit, false);
check("and the excess is that minute", oneMinuteOver.overMinutes, 1);
checkTrue(
  "the detail names the weekly maximum rather than 'over'",
  oneMinuteOver.detail.includes("48 hours per week"),
);

// The same verdict reached through a worked day, which is the path a real
// clock-in/out pair takes: 47 hours already this week plus a nine-hour day.
const weekBreach = assessWorkedDay({
  start: dxb(2026, 8, 28, 8, 0),
  end: dxb(2026, 8, 28, 17, 0),
  minutesThisWeek: 47 * 60 + 9 * 60,
  monthlyBasicMinor: 600_000,
});
checkTrue(
  "a worked day that takes the week past 48 hours warns",
  weekBreach.hours.warnings.some((w) => w.includes("48 hours per week")),
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

console.log("\n— HR-13: end-of-service gratuity, on basic salary only —");

/**
 * One fixture, six boundaries.
 *
 * AED 6,000 basic gives a daily basic of exactly AED 200 — 600000 ÷ 30 — so
 * every figure below can be checked by multiplication rather than trusted. The
 * AED 2,000 housing allowance is there precisely because it must make no
 * difference to the accrual and all the difference to the cap.
 */
const GRAT_BASIC = 600_000;
const GRAT_TOTAL = 800_000; // basic + AED 2,000 housing
const GRAT_START = "2020-01-01";
const gratuity = (asOf: string, start = GRAT_START) =>
  gratuityAccrual({
    serviceStart: start,
    asOf,
    basicMonthlyMinor: GRAT_BASIC,
    totalMonthlyWageMinor: GRAT_TOTAL,
  });

check("daily basic is monthly ÷ 30, to the fil", gratuity("2021-01-01").dailyBasicMinor, 20_000);

// ── The minimum-service boundary: 364 days against exactly one year ─────────
const day364 = gratuity(addDays(GRAT_START, 364));
check("364 days of service is 364 days", daysBetween(GRAT_START, addDays(GRAT_START, 364)), 364);
check("364 days accrues nothing", day364.amountMinor, 0);
check("and is reported as ineligible rather than as zero", day364.eligible, false);
check("no completed years at 364 days", day364.service.completedYears, 0);

const year1 = gratuity("2021-01-01");
checkTrue("exactly one year is eligible — the anniversary is inside the entitlement", year1.eligible);
check("one completed year", year1.service.completedYears, 1);
check("21 days of basic pay", year1.entitlementDays, GRATUITY_DAYS_PER_YEAR_FIRST_FIVE);
check("which is AED 4,200 at AED 200/day", year1.amountMinor, 21 * 20_000);

// ── The 21 → 30 switch: exactly five years against five years and a day ─────
const year5 = gratuity("2025-01-01");
check("five completed years", year5.service.completedYears, 5);
check("21 × 5 = 105 days", year5.entitlementDays, 105);
check("AED 21,000", year5.amountMinor, 105 * 20_000);
check("no part-year at the anniversary", year5.service.remainderDays, 0);

const year5day1 = gratuity("2025-01-02");
check("five years and a day is still five completed years", year5day1.service.completedYears, 5);
check("with one day of remainder", year5day1.service.remainderDays, 1);
check("in a 365-day service year", year5day1.service.remainderYearDays, 365);
// The extra day accrues at 30/365 of a day's basic, NOT 21/365. Math.round(20000 × 30 ÷ 365).
check("the day after the fifth anniversary accrues at the 30-day rate", year5day1.amountMinor, 105 * 20_000 + 1_644);
check("and 1644 fils is 20000 × 30 ÷ 365 rounded", Math.round((20_000 * GRATUITY_DAYS_PER_YEAR_THEREAFTER) / 365), 1_644);

// The same one-day tail on the other side of the boundary, at the 21-day rate.
// 2024 is a leap year, so the service year 2024-01-01 → 2025-01-01 is 366 days.
const year4day1 = gratuity("2024-01-02");
check("four years and a day is four completed years", year4day1.service.completedYears, 4);
check("in a 366-day service year", year4day1.service.remainderYearDays, 366);
check("and its tail accrues at the 21-day rate", year4day1.amountMinor, 84 * 20_000 + 1_148);
check("21 ≠ 30: the tails differ", year4day1.amountMinor - 84 * 20_000 === year5day1.amountMinor - 105 * 20_000, false);

// ── The cap, on both sides of where it bites ───────────────────────────────
check("the cap is two years' TOTAL wages", gratuity("2021-01-01").capMinor, GRAT_TOTAL * GRATUITY_CAP_MONTHS_OF_WAGE);

// 33 completed years: 21×5 + 30×28 = 945 days = AED 189,000, under the
// AED 192,000 ceiling. This is also the assertion that the cap is measured on
// the total wage and not on basic — at 24 months of basic the ceiling would be
// AED 144,000 and this figure would be capped.
const year33 = gratuity("2023-01-01", "1990-01-01");
check("33 completed years", year33.service.completedYears, 33);
check("945 days of basic pay", year33.entitlementDays, 945);
check("the cap does NOT bite at AED 189,000", year33.capApplied, false);
check("so the full accrual is owed", year33.amountMinor, 945 * 20_000);

// 34 completed years: 21×5 + 30×29 = 975 days = AED 195,000, over the ceiling.
const year34 = gratuity("2024-01-01", "1990-01-01");
check("34 completed years", year34.service.completedYears, 34);
check("975 days uncapped", year34.uncappedMinor, 975 * 20_000);
checkTrue("the cap bites", year34.capApplied);
check("and two years' total wages is what is owed", year34.amountMinor, GRAT_TOTAL * GRATUITY_CAP_MONTHS_OF_WAGE);
check("which is AED 192,000", year34.amountMinor, 19_200_000);

// ── Basic only. The whole requirement, in one assertion ───────────────────
const withAllowances = gratuityAccrual({
  serviceStart: GRAT_START,
  asOf: "2025-01-01",
  basicMonthlyMinor: GRAT_BASIC,
  totalMonthlyWageMinor: 1_400_000, // AED 8,000 of allowances on top
});
const withoutAllowances = gratuityAccrual({
  serviceStart: GRAT_START,
  asOf: "2025-01-01",
  basicMonthlyMinor: GRAT_BASIC,
  totalMonthlyWageMinor: GRAT_BASIC,
});
check(
  "allowances change the gratuity by nothing at all",
  withAllowances.amountMinor,
  withoutAllowances.amountMinor,
);
// The contrast that makes the point: sick pay on the same two wages is NOT the
// same number, because sick pay is staged on the whole wage and gratuity is not.
const oneSickDay = stageSickLeave({ days: 1 });
check(
  "sick pay on the same two wages IS different — different base, deliberately",
  sickLeavePayMinor(1_400_000, oneSickDay) === sickLeavePayMinor(GRAT_BASIC, oneSickDay),
  false,
);
// Stated as a number rather than only as an inequality, so the direction is on
// the record: sick pay on basic alone under-pays by exactly the allowance.
check("one sick day on the whole wage", sickLeavePayMinor(1_400_000, oneSickDay), Math.round(1_400_000 / 30));
check("one sick day on basic alone", sickLeavePayMinor(GRAT_BASIC, oneSickDay), Math.round(GRAT_BASIC / 30));

// ── Service length, on its own ─────────────────────────────────────────────
check("a 29 February start has a 28 February anniversary", serviceLength("2020-02-29", "2021-02-28").completedYears, 1);
check("and not one day earlier", serviceLength("2020-02-29", "2021-02-27").completedYears, 0);
check("service before the start date is zero, not negative", serviceLength("2026-01-01", "2025-12-01").days, 0);

// ── The 14-day settlement deadline ─────────────────────────────────────────
const settled = gratuitySettlementDeadline("2026-08-01", "2026-08-15");
check("dues are payable 14 days after termination", settled.dueOn, addDays("2026-08-01", GRATUITY_SETTLEMENT_DAYS));
check("the 14th day itself is not late", settled.overdue, false);
check("with zero days remaining", settled.daysRemaining, 0);
const late = gratuitySettlementDeadline("2026-08-01", "2026-08-16");
checkTrue("the 15th day is", late.overdue);
check("by one day", late.daysRemaining, -1);

console.log("\n— HR-18: Emiratisation, and the three-part skilled test —");

const skilledInput = (over: Partial<Parameters<typeof classifySkilledEmployee>[0]> = {}) =>
  classifySkilledEmployee({
    iscoMajorGroup: 3,
    postSecondaryCertificate: true,
    monthlyWageMinor: 600_000,
    ...over,
  });

check("all three legs pass", skilledInput().classification, "skilled");

// ── Leg 1: the ISCO boundary, both sides ──────────────────────────────────
check("ISCO major group 5 is inside the test", skilledInput({ iscoMajorGroup: 5 }).classification, "skilled");
check("ISCO major group 6 is not", skilledInput({ iscoMajorGroup: 6 }).classification, "excluded");
check("the boundary constant is 5", ISCO_SKILLED_MAX_MAJOR_GROUP, 5);
check("craft trades — group 7 — are excluded", skilledInput({ iscoMajorGroup: 7 }).classification, "excluded");
check("plant operators and drivers — group 8", skilledInput({ iscoMajorGroup: 8 }).classification, "excluded");
check("cleaners and labourers — group 9", skilledInput({ iscoMajorGroup: 9 }).classification, "excluded");

// ── Leg 3: the AED 4,000 boundary, both sides ─────────────────────────────
check("AED 4,000 is AED 4,000 in fils", EMIRATISATION_SKILLED_WAGE_FLOOR_MINOR, 400_000);
check("exactly AED 4,000 is at or above the floor", skilledInput({ monthlyWageMinor: 400_000 }).classification, "skilled");
check("one fil below is not", skilledInput({ monthlyWageMinor: 399_999 }).classification, "excluded");
// The opposite operator on the same number, forty lines apart in the source.
check("and the SAME wage is outside the Essential Benefits requirement", requiredHealthPlan(400_000), "standard");
check("while one fil below is inside it", requiredHealthPlan(399_999), "essential_benefits");

// ── Leg 2, and the unknowns ───────────────────────────────────────────────
check("no certificate excludes", skilledInput({ postSecondaryCertificate: false }).classification, "excluded");
check("an unrecorded certificate is unknown, not unskilled", skilledInput({ postSecondaryCertificate: null }).classification, "unknown");
check("an unrecorded ISCO group is unknown", skilledInput({ iscoMajorGroup: null }).classification, "unknown");
check("an unrecorded wage is unknown", skilledInput({ monthlyWageMinor: null }).classification, "unknown");
check(
  "but a definite failure beats a missing fact",
  skilledInput({ iscoMajorGroup: 7, postSecondaryCertificate: null, monthlyWageMinor: null }).classification,
  "excluded",
);
checkTrue("and it says why", skilledInput({ iscoMajorGroup: 7 }).reasons.length > 0);

// ── The establishment position, on both sides of 50 ───────────────────────
const at49 = assessEmiratisation({ skilled: 49, excluded: 300, unknown: 0 });
check("49 skilled is below the threshold", at49.inScope, false);
checkTrue("but close enough to say so", at49.approaching);
const at50 = assessEmiratisation({ skilled: 50, excluded: 300, unknown: 0 });
checkTrue("50 skilled is 'or more' — the targets apply", at50.inScope);
check("the threshold is 50", EMIRATISATION_SKILLED_THRESHOLD, 50);

// The requirement's own example: 60 tradesmen and 6 office staff.
const contractor = assessEmiratisation({ skilled: 6, excluded: 60, unknown: 0, headcount: 66 });
check("60 tradesmen and 6 office staff is measured against the 6", contractor.lowerBound, 6);
check("not the 66", contractor.headcount, 66);
check("and is nowhere near the threshold", contractor.inScope, false);
check("nor approaching it", contractor.approaching, false);

// Missing facts must not resolve in the reassuring direction.
const undecided = assessEmiratisation({ skilled: 48, excluded: 10, unknown: 3 });
check("48 skilled with 3 unclassified has an upper bound of 51", undecided.upperBound, 51);
checkTrue("so the threshold may already be crossed", undecided.inScope);
checkTrue("and the screen is told it cannot tell", undecided.undecidedByMissingFacts);
checkTrue("with the reason named", (undecided.caveat ?? "").includes("unclassifiable"));
check("a fully classified establishment over the line is not 'undecided'", at50.undecidedByMissingFacts, false);

// OPEN-4: the 20–49 band, on both sides.
check("the small-establishment floor is 20", EMIRATISATION_SMALL_ESTABLISHMENT_FLOOR, 20);
check(
  "19 employees is below the OPEN-4 band",
  assessEmiratisation({ skilled: 6, excluded: 13, unknown: 0 }).band,
  "outside_targets",
);
const band20 = assessEmiratisation({ skilled: 6, excluded: 14, unknown: 0 });
check("20 is inside it", band20.band, "small_establishment_band");
checkTrue("and OPEN-4 is stated rather than answered", (band20.caveat ?? "").includes("OPEN-4"));
// 66 employees is past the top of the 20-49 band and 6 skilled is nowhere near
// 50. Neither regime applies, and the band says exactly that rather than
// rounding the establishment into the nearer of the two.
check("60 tradesmen and 6 office staff is in neither regime", contractor.band, "outside_targets");
check("no caveat is invented where there is no uncertainty", contractor.caveat, null);

console.log(fail === 0 ? "\nAll employment checks passed.\n" : `\n${fail} check(s) failed.\n`);
process.exit(fail === 0 ? 0 : 1);
