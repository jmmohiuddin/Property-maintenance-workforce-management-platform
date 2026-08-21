/**
 * The employment lifecycle rules: wages, contracts, leave, overtime, insurance.
 *
 * `HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`. Every constant in this file is a row
 * in §11.3 of the PRD, and every row in §11.3 has a penalty attached to it. So
 * the numbers live here, once, rather than in a form validator, a cron route
 * and a report — three places that will eventually disagree, and the
 * disagreement will be discovered by MOHRE rather than by a test.
 *
 * ── WHY THIS IS NOT IN `calendar.ts` ────────────────────────────────────────
 *
 * `calendar.ts` answers "may work happen at this instant". This file answers
 * "what is owed for work that happened, and by when". They share the Dubai
 * clock and the statutory day, and this module imports them rather than
 * restating them — `checkStatutoryHours`, `isRamadan` and `closeMinuteFor` are
 * the calendar's, and `assessWorkedDay` below calls them.
 *
 * ── WHY NO FLOATS ANYWHERE NEAR AN OVERTIME MULTIPLIER ──────────────────────
 *
 * `1.25` is not representable in IEEE 754, and neither is `1.5 * 0.1`. An
 * overtime multiplier is applied to every hour of every technician's month and
 * then summed into a wage file that a bank transfers and MOHRE audits. So the
 * multipliers below are **integer basis points** — 12500 is +25% — and every
 * amount is computed in integer minor units with exactly one rounding step.
 *
 * ── DATES ARE CALENDAR DAYS, AS STRINGS ─────────────────────────────────────
 *
 * Wages are due on *the 1st*, a contract ends on *a day*, leave is counted in
 * *calendar days*. None of those are instants. `YYYY-MM-DD` strings are what
 * the Postgres `date` columns hold, what `<input type="date">` speaks, and what
 * survives a round trip without a timezone silently moving a deadline by a day
 * in the direction that says a late payment was on time.
 */

import { dubaiDateKey, isRamadan, toDubai, fromDubai, DEFAULT_CALENDAR, checkStatutoryHours } from "./calendar";
import type { WorkingCalendar, HoursCheck } from "./calendar";

// ── Calendar-day arithmetic ─────────────────────────────────────────────────

/** A calendar day, `YYYY-MM-DD`. Never an instant. */
export type CalendarDay = string;

const DAY_MS = 86_400_000;

function partsOf(day: CalendarDay): { year: number; month: number; date: number } {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`Not a calendar day: "${day}". Expected YYYY-MM-DD.`);
  return { year: y, month: m, date: d };
}

/**
 * `Date.UTC` and nothing else.
 *
 * Both ends of every comparison below are UTC midnight, so no offset is ever
 * applied and none is ever lost. The moment one end came from `new Date()` in
 * a local zone this would start being wrong by a day — which is why `today()`
 * goes through the Dubai key rather than through the host's clock.
 */
function toUtcMidnight(day: CalendarDay): number {
  const p = partsOf(day);
  return Date.UTC(p.year, p.month - 1, p.date);
}

function keyOf(ms: number): CalendarDay {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

/** Today, in Dubai. The only correct "today" for a UAE statutory deadline. */
export function today(now: Date = new Date()): CalendarDay {
  return dubaiDateKey(now);
}

/** `to - from`, in whole days. Negative when `to` is earlier. */
export function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round((toUtcMidnight(to) - toUtcMidnight(from)) / DAY_MS);
}

export function addDays(day: CalendarDay, count: number): CalendarDay {
  return keyOf(toUtcMidnight(day) + count * DAY_MS);
}

/**
 * Add whole months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. Overflowing is how a
 * probation period that must not exceed six months quietly becomes six months
 * and three days.
 */
export function addMonths(day: CalendarDay, count: number): CalendarDay {
  const p = partsOf(day);
  const targetMonthIndex = p.month - 1 + count;
  const year = p.year + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return keyOf(Date.UTC(year, month, Math.min(p.date, lastDay)));
}

/**
 * The Monday of the week containing `day`.
 *
 * Monday because that is what the 48-hour week is measured over here and what
 * Postgres `date_trunc('week', ...)` returns — the weekly aggregation in
 * `domain/hr.ts` groups with one and snaps its window with the other, and two
 * different week starts would put the same worked day in two different weeks
 * depending on which end of the query you read. The UAE weekend is Saturday and
 * Sunday (`DEFAULT_CALENDAR.weekend`), so a Monday start also keeps a week's
 * worked days contiguous rather than splitting them across the boundary.
 */
export function startOfWeek(day: CalendarDay): CalendarDay {
  // getUTCDay(): 0 is Sunday. Sunday belongs to the week that began six days
  // earlier, not to the one starting tomorrow.
  const weekday = new Date(toUtcMidnight(day)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}

/** The first of the month containing `day`. */
export function startOfMonth(day: CalendarDay): CalendarDay {
  const p = partsOf(day);
  return `${p.year}-${String(p.month).padStart(2, "0")}-01`;
}

/** Whole months from `from` to `to`, ignoring the part-month at the end. */
export function completedMonths(from: CalendarDay, to: CalendarDay): number {
  const a = partsOf(from);
  const b = partsOf(to);
  let months = (b.year - a.year) * 12 + (b.month - a.month);
  if (b.date < a.date) months -= 1;
  return months;
}

/** `2026-09-01` → `1 September 2026`. Deadlines read as deadlines. */
export function formatDay(day: CalendarDay): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-17 — The Wage Protection System calendar
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The highest-frequency compliance obligation in the business.
 *
 * Since Ministerial Resolution No. 340 of 2026, effective 1 June 2026, wages
 * for the previous month are due **on the 1st day of each Gregorian month** —
 * replacing the older "within 15 days" practice that most UAE payroll advice
 * still describes. An establishment is compliant when it has transferred at
 * least 85% of total wages due by that date.
 */
export const WPS_DUE_DAY_OF_MONTH = 1;

/** Compliance threshold, as a percentage of total wages due. */
export const WPS_MINIMUM_TRANSFER_PERCENT = 85;

/** Alerts start here (§12.1: "WPS payroll countdown from T-5 days"). */
export const WPS_ALERT_LEAD_DAYS = 5;

/** `HR-17`: the wage file inputs are produced by T-3. */
export const WPS_FILE_LEAD_DAYS = 3;

export type WpsStage =
  /** Outside the alerting window. Nothing to do yet. */
  | "not_due"
  /** Inside T-5. The countdown §12.1 asks for. */
  | "countdown"
  /** The 1st. Payment is due today and is not yet confirmed. */
  | "due_today"
  /** Day 2. "WPS transfer unconfirmed on the 2nd" — alarm tone. */
  | "unconfirmed"
  /** Day 5. New work-permit issuance suspended. */
  | "permits_suspended"
  /** Day 11. Administrative fines and category downgrade. */
  | "fines_and_downgrade"
  /** Day 16. Automatic labour-dispute registration. */
  | "labour_disputes"
  /** Day 21. Executive orders and possible travel bans. */
  | "executive_orders"
  /** Transferred at or above the threshold. The only good outcome. */
  | "settled"
  /** Transferred, but below 85%. Settled in cash, not in law. */
  | "short_paid"
  /**
   * Nobody was owed anything this month.
   *
   * Not the same as `settled`, and the distinction is load-bearing: `settled`
   * means wages were transferred on time, and reporting that when no wages
   * existed would put a false clean run into the compliance history an
   * inspection reads.
   */
  | "nothing_due";

/**
 * The escalation ladder, as data.
 *
 * A single "payroll is late" boolean throws away the only information anybody
 * acts on. The distance between day 4 and day 5 is the distance between an
 * embarrassing conversation and being unable to hire; between day 15 and day 16
 * is the distance between a fine and a labour dispute registered against the
 * establishment automatically, without any worker complaining.
 *
 * `day` is the day of the month the wages were due in — the 1st is day 1 — so
 * the ladder is month-length agnostic and keeps counting past day 31.
 */
export interface WpsEscalationBand {
  readonly day: number;
  readonly stage: WpsStage;
  /** Stated as the consequence, not as "risk". A consequence changes behaviour. */
  readonly consequence: string;
  readonly severity: "info" | "warning" | "critical" | "alarm";
}

export const WPS_ESCALATION: readonly WpsEscalationBand[] = [
  {
    day: 1,
    stage: "due_today",
    consequence: "Wages for last month are due today. Transfer at least 85% of total wages through WPS.",
    severity: "warning",
  },
  {
    day: 2,
    stage: "unconfirmed",
    consequence:
      "The transfer is unconfirmed a day after the deadline. MOHRE issues automated warnings from today, and the establishment is already recorded as non-compliant.",
    severity: "alarm",
  },
  {
    day: 5,
    stage: "permits_suspended",
    consequence:
      "New work-permit issuance is suspended from today. No new worker can be onboarded until the wages are paid.",
    severity: "alarm",
  },
  {
    day: 11,
    stage: "fines_and_downgrade",
    consequence:
      "Administrative fines apply from today and the establishment is downgraded a category, which raises the cost of every future permit.",
    severity: "alarm",
  },
  {
    day: 16,
    stage: "labour_disputes",
    consequence:
      "Labour disputes are registered automatically from today, on behalf of every unpaid worker, without any of them complaining.",
    severity: "alarm",
  },
  {
    day: 21,
    stage: "executive_orders",
    consequence:
      "Executive orders may be issued from today and travel bans are possible against the establishment's owner.",
    severity: "alarm",
  },
];

/**
 * The wage cycle covering a given day.
 *
 * Wages for month M are due on the 1st of month M+1. On 3 September the live
 * cycle is August's wages, due 1 September and two days late; on 28 August it
 * is also August's wages, due 1 September and three days out. There is exactly
 * one live cycle at any moment, which is why this returns one and not a list.
 */
export interface WpsCycle {
  /** First day of the month the wages are FOR. `2026-08-01` for August pay. */
  readonly periodMonth: CalendarDay;
  /** The statutory deadline. Always the 1st of the following month. */
  readonly dueOn: CalendarDay;
  /** Human label, e.g. "August 2026". */
  readonly label: string;
}

export function wpsCycleFor(day: CalendarDay): WpsCycle {
  // The cycle that is live *today* is last month's wages, because this month's
  // are not yet earned. On the 1st itself that is still last month's — the
  // deadline is today, not next month.
  const periodMonth = addMonths(startOfMonth(day), -1);
  return {
    periodMonth,
    dueOn: startOfMonth(day),
    label: monthLabel(periodMonth),
  };
}

/** The cycle for wages earned in the month containing `day`. */
export function wpsCycleForWagesEarnedIn(day: CalendarDay): WpsCycle {
  const periodMonth = startOfMonth(day);
  return {
    periodMonth,
    dueOn: addMonths(periodMonth, 1),
    label: monthLabel(periodMonth),
  };
}

function monthLabel(monthStart: CalendarDay): string {
  return new Date(`${monthStart}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

export interface WpsCycleInput {
  readonly periodMonth: CalendarDay;
  readonly dueOn: CalendarDay;
  /** Total wages owed for the period, in minor units (fils). */
  readonly totalDueMinor: number;
  /** Total actually transferred through WPS, in minor units. */
  readonly totalTransferredMinor: number;
  /** When the bank confirmed the transfer. Null while unconfirmed. */
  readonly confirmedOn: CalendarDay | null;
  /** Set once the wage-file inputs have been produced (`HR-17`, by T-3). */
  readonly filePreparedOn?: CalendarDay | null;
  /**
   * How many employees the prepared file covers.
   *
   * Needed to tell "nobody was owed anything" from "nobody has worked out what
   * is owed yet". Both look like `totalDueMinor === 0`, and only one of them is
   * an alarm — a deployment with no employment records yet would otherwise be
   * told every day from the 2nd that its payroll was late, which is the fastest
   * way to teach an owner to ignore this alert before it ever matters.
   */
  readonly employeeCount?: number;
}

export interface WpsAssessment {
  readonly periodMonth: CalendarDay;
  readonly label: string;
  readonly dueOn: CalendarDay;
  readonly stage: WpsStage;
  readonly severity: "info" | "warning" | "critical" | "alarm";
  /** Positive before the deadline, negative after it. */
  readonly daysUntilDue: number;
  /** 0 until the deadline passes. */
  readonly daysLate: number;
  /**
   * Transferred share, in basis points of what was due. 8500 is exactly 85%.
   *
   * Basis points rather than a percentage float, because this number decides
   * whether the establishment is compliant and `84.999999999` must never round
   * its way over the line.
   */
  readonly transferredBasisPoints: number;
  readonly shortfallMinor: number;
  readonly meetsThreshold: boolean;
  /** True from T-5, and every day thereafter until it settles. */
  readonly alerting: boolean;
  /** True from T-3 while the wage file has not been produced. */
  readonly fileDue: boolean;
  readonly consequence: string;
  /** One line, for a subject line or a page heading. */
  readonly headline: string;
}

/** 8500 basis points. Derived, so the percentage above is the only knob. */
export const WPS_THRESHOLD_BASIS_POINTS = WPS_MINIMUM_TRANSFER_PERCENT * 100;

/**
 * Where one wage cycle stands, and what happens next.
 *
 * ── WHY THIS IS NOT A HARD BLOCK ────────────────────────────────────────────
 *
 * There are exactly three hard blocks in this system, each stopping a dispatch:
 * an expired blocking document, an expired work permit, and the summer midday
 * ban. Late wages do not become a fourth, and the reason is causal rather than
 * squeamish.
 *
 * The three existing blocks stop the *illegal act itself* — sending a person to
 * work who may not lawfully work, or at an hour when nobody may. Late wages
 * make no worker unlawful to deploy. What day 5 suspends is **new work-permit
 * issuance**, not existing employment. Blocking dispatch on unpaid wages would
 * therefore stop lawful, already-permitted work in order to punish a payment
 * failure — and it would stop the revenue that pays the wages, which makes the
 * violation worse rather than better. It would also be routed around inside a
 * day: the dispatcher would phone the technician, and then nothing at all would
 * be recorded.
 *
 * Nor does it become a hard block anywhere else, and the tempting place is
 * onboarding: MOHRE stops issuing new work permits on day 5, so why not refuse
 * to open a new employment record? Because that would be *this system* refusing
 * a lawful internal act on the strength of an external decision it cannot see.
 * The permit application is made to MOHRE and refused by MOHRE; recording who
 * we intend to employ is not the act that was suspended, and a company that
 * cannot write down a name until it has paid last month's wages will keep the
 * names somewhere this system cannot see.
 *
 * What lateness earns instead is **escalating alerts that name the specific
 * consequence in force today**, and `wpsPermitIssuanceSuspended` as a warning
 * carried onto the onboarding screen — so an HR administrator learns that the
 * permit will be refused *before* spending a fee on it, which is the actual
 * decision they are about to get wrong. There is no fourth wall.
 */
export function assessWpsCycle(input: WpsCycleInput, now: CalendarDay = today()): WpsAssessment {
  const label = monthLabel(input.periodMonth);
  const daysUntilDue = daysBetween(now, input.dueOn);
  const daysLate = Math.max(0, -daysUntilDue);

  const due = Math.max(0, Math.round(input.totalDueMinor));
  const transferred = Math.max(0, Math.round(input.totalTransferredMinor));

  // Integer division, floored. A cycle sitting at 84.99% must read as 8499 and
  // fail the test, not round up into compliance.
  const transferredBasisPoints = due === 0 ? 0 : Math.floor((transferred * 10_000) / due);
  const required = Math.ceil((due * WPS_THRESHOLD_BASIS_POINTS) / 10_000);
  const shortfallMinor = Math.max(0, required - transferred);
  const meetsThreshold = due > 0 && transferred >= required;

  // ── Settled ──────────────────────────────────────────────────────────────
  // Confirmed on or before the deadline AND at or above the threshold. Both
  // halves are load-bearing: an on-time transfer of 60% of the payroll is a
  // WPS violation that looks like a payment, and it is the one an establishment
  // discovers when its permits stop being issued.
  if (input.confirmedOn && meetsThreshold && daysBetween(input.confirmedOn, input.dueOn) >= 0) {
    return {
      periodMonth: input.periodMonth,
      label,
      dueOn: input.dueOn,
      stage: "settled",
      severity: "info",
      daysUntilDue,
      daysLate: 0,
      transferredBasisPoints,
      shortfallMinor: 0,
      meetsThreshold: true,
      alerting: false,
      fileDue: false,
      consequence: "",
      headline: `${label} wages transferred on time — ${percent(transferredBasisPoints)} of wages due.`,
    };
  }

  // Confirmed but short. Not "paid": 85% is the line, and being under it is a
  // violation whether or not the money left the account.
  if (input.confirmedOn && !meetsThreshold) {
    const band = bandFor(daysLate + 1);
    return {
      periodMonth: input.periodMonth,
      label,
      dueOn: input.dueOn,
      stage: "short_paid",
      severity: "alarm",
      daysUntilDue,
      daysLate,
      transferredBasisPoints,
      shortfallMinor,
      meetsThreshold: false,
      alerting: true,
      fileDue: false,
      consequence:
        `Only ${percent(transferredBasisPoints)} of wages due were transferred. WPS requires at least ` +
        `${WPS_MINIMUM_TRANSFER_PERCENT}%, so this cycle is non-compliant despite the payment. ` +
        (band ? band.consequence : ""),
      headline: `${label} wages transferred short — ${percent(transferredBasisPoints)} against a ${WPS_MINIMUM_TRANSFER_PERCENT}% floor.`,
    };
  }

  // Confirmed late, at or above the threshold. Still non-compliant: the ladder
  // is keyed on the transfer date, not on the amount.
  if (input.confirmedOn && meetsThreshold) {
    const lateBy = daysBetween(input.dueOn, input.confirmedOn);
    const band = bandFor(lateBy + 1);
    return {
      periodMonth: input.periodMonth,
      label,
      dueOn: input.dueOn,
      stage: band?.stage ?? "unconfirmed",
      severity: "critical",
      daysUntilDue,
      daysLate: lateBy,
      transferredBasisPoints,
      shortfallMinor: 0,
      meetsThreshold: true,
      alerting: false,
      fileDue: false,
      consequence:
        `Transferred ${lateBy} day${lateBy === 1 ? "" : "s"} after the deadline. ` +
        (band ? band.consequence : ""),
      headline: `${label} wages transferred ${lateBy} day${lateBy === 1 ? "" : "s"} late.`,
    };
  }

  // ── Unconfirmed ──────────────────────────────────────────────────────────
  if (daysUntilDue > 0) {
    const alerting = daysUntilDue <= WPS_ALERT_LEAD_DAYS;
    const fileDue = daysUntilDue <= WPS_FILE_LEAD_DAYS && !input.filePreparedOn;
    return {
      periodMonth: input.periodMonth,
      label,
      dueOn: input.dueOn,
      stage: alerting ? "countdown" : "not_due",
      severity: alerting ? "warning" : "info",
      daysUntilDue,
      daysLate: 0,
      transferredBasisPoints,
      shortfallMinor,
      meetsThreshold,
      alerting,
      fileDue,
      consequence: fileDue
        ? `The wage file inputs — hours, overtime, absences and deductions — are due today so the transfer can be instructed before ${formatDay(input.dueOn)}.`
        : `Wages for ${label} must be transferred by ${formatDay(input.dueOn)}.`,
      headline: `${label} wages due in ${daysUntilDue} day${daysUntilDue === 1 ? "" : "s"}.`,
    };
  }

  // Nothing was owed, and that is known rather than assumed: the file has been
  // produced and it covers nobody. Without the `filePreparedOn` half of this
  // test, a month whose inputs simply had not been built yet would report as
  // "nothing due" on the 2nd — silencing the one alert that matters most.
  if (due === 0 && (input.employeeCount ?? 0) === 0 && input.filePreparedOn) {
    return {
      periodMonth: input.periodMonth,
      label,
      dueOn: input.dueOn,
      stage: "nothing_due",
      severity: "info",
      daysUntilDue,
      daysLate,
      transferredBasisPoints: 0,
      shortfallMinor: 0,
      meetsThreshold: true,
      alerting: false,
      fileDue: false,
      consequence: "",
      headline: `No wages were due for ${label} — the wage file covers nobody.`,
    };
  }

  const band = bandFor(daysLate + 1) ?? WPS_ESCALATION[0]!;
  return {
    periodMonth: input.periodMonth,
    label,
    dueOn: input.dueOn,
    stage: band.stage,
    severity: band.severity,
    daysUntilDue,
    daysLate,
    transferredBasisPoints,
    shortfallMinor,
    meetsThreshold,
    alerting: true,
    fileDue: !input.filePreparedOn,
    consequence: band.consequence,
    headline:
      daysLate === 0
        ? `${label} wages are due TODAY and the transfer is unconfirmed.`
        : `${label} wages are ${daysLate} day${daysLate === 1 ? "" : "s"} late — day ${daysLate + 1} of the WPS escalation.`,
  };
}

/** The band in force on a given day of the escalation, or null before day 1. */
export function bandFor(escalationDay: number): WpsEscalationBand | null {
  let current: WpsEscalationBand | null = null;
  for (const band of WPS_ESCALATION) {
    if (escalationDay >= band.day) current = band;
  }
  return current;
}

/**
 * Is new work-permit issuance suspended right now?
 *
 * Day 5 of the escalation. This is the one act late wages actually stop, and
 * the reason `assessWpsCycle` refuses to become a fourth dispatch block: the
 * refusal belongs on onboarding, where MOHRE has put it, and nowhere else.
 */
export function wpsPermitIssuanceSuspended(assessment: WpsAssessment): boolean {
  return (
    assessment.stage === "permits_suspended" ||
    assessment.stage === "fines_and_downgrade" ||
    assessment.stage === "labour_disputes" ||
    assessment.stage === "executive_orders"
  );
}

function percent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const frac = basisPoints % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0")}%`;
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-4 — Contract form, probation, notice and auto-renewal
// ═══════════════════════════════════════════════════════════════════════════

/**
 * UAE private-sector contracts are **fixed-term only** since Federal
 * Decree-Law 33/2021. The three-year cap was removed in 2022, so a term may be
 * any length — but it must have an end date, and an unlimited contract is not a
 * lawful shape.
 */
export const LAWFUL_CONTRACT_TYPES = ["fixed_term"] as const;

/** Maximum six months, and explicitly non-extendable. */
export const PROBATION_MAX_MONTHS = 6;

/** Notice an employer must give to terminate during probation. */
export const PROBATION_NOTICE_DAYS = 14;

/** Post-probation notice, both ends. Anything outside is unenforceable. */
export const NOTICE_MIN_DAYS = 30;
export const NOTICE_MAX_DAYS = 90;

/** How far ahead an expiring term is worth surfacing. */
export const CONTRACT_RENEWAL_WINDOW_DAYS = 90;

export type ContractState =
  | "not_started"
  | "probation"
  | "active"
  | "expiring"
  /**
   * The state this whole feature exists for.
   *
   * A fixed-term contract whose end date has passed while the worker kept
   * turning up **is a renewed contract on the same terms**, by operation of
   * law. It is not an expired record and it is not a gap. A system that renders
   * it as "expired" invites somebody to treat the person as unemployed — or,
   * worse, to backdate a new contract on different terms, which is precisely
   * the dispute the auto-renewal rule exists to prevent.
   */
  | "auto_renewed"
  | "ended";

export interface ContractTerm {
  readonly startsOn: CalendarDay;
  readonly endsOn: CalendarDay | null;
  readonly probationEndsOn?: CalendarDay | null;
  readonly noticePeriodDays?: number | null;
  readonly contractType?: string;
}

export interface ContractAssessment {
  readonly state: ContractState;
  /** Negative once the end date has passed. Null where no end date is recorded. */
  readonly daysToEnd: number | null;
  readonly probationDaysRemaining: number | null;
  /**
   * The term the law deems to be running, when the recorded one has lapsed.
   *
   * Same start-to-end length as the term it renewed, on the same terms —
   * because that is what "auto-renews on the same terms" means. Rendered as the
   * live contract; the lapsed row stays as history.
   */
  readonly deemedTerm: { readonly startsOn: CalendarDay; readonly endsOn: CalendarDay; readonly renewalCount: number } | null;
  /** Statutory defects in the recorded contract. Each one is a dispute waiting. */
  readonly problems: readonly string[];
  readonly summary: string;
}

/**
 * What the contract on file actually is, today.
 *
 * `stillEmployed` is what turns a lapsed end date into a renewal rather than a
 * termination, and it has to be passed in: this module cannot see the
 * employment status, and guessing it in either direction is the error.
 */
export function assessContract(
  term: ContractTerm,
  options: { stillEmployed: boolean; now?: CalendarDay },
): ContractAssessment {
  const now = options.now ?? today();
  const problems: string[] = [];

  if (term.contractType && !LAWFUL_CONTRACT_TYPES.includes(term.contractType as "fixed_term")) {
    problems.push(
      `Contract type "${term.contractType}" is not a lawful shape. UAE private-sector contracts have been fixed-term only since Federal Decree-Law 33/2021.`,
    );
  }

  if (!term.endsOn) {
    problems.push(
      "No end date recorded. A fixed-term contract without an end date cannot auto-renew, cannot be given notice against, and cannot be proved to a labour inspector.",
    );
  }

  if (term.probationEndsOn) {
    const maximum = addMonths(term.startsOn, PROBATION_MAX_MONTHS);
    if (daysBetween(maximum, term.probationEndsOn) > 0) {
      problems.push(
        `Probation ends ${formatDay(term.probationEndsOn)}, past the statutory maximum of ${PROBATION_MAX_MONTHS} months from ${formatDay(term.startsOn)} (${formatDay(maximum)}). Probation is capped at six months and is non-extendable.`,
      );
    }
    if (daysBetween(term.startsOn, term.probationEndsOn) <= 0) {
      problems.push("Probation ends on or before the contract starts.");
    }
  }

  const notice = term.noticePeriodDays ?? null;
  if (notice !== null && (notice < NOTICE_MIN_DAYS || notice > NOTICE_MAX_DAYS)) {
    problems.push(
      `Notice period of ${notice} days sits outside the statutory ${NOTICE_MIN_DAYS}–${NOTICE_MAX_DAYS} day range for post-probation termination.`,
    );
  }

  const daysToEnd = term.endsOn ? daysBetween(now, term.endsOn) : null;

  const probationDaysRemaining =
    term.probationEndsOn && daysBetween(now, term.probationEndsOn) >= 0
      ? daysBetween(now, term.probationEndsOn)
      : null;

  if (daysBetween(term.startsOn, now) < 0) {
    return {
      state: "not_started",
      daysToEnd,
      probationDaysRemaining: null,
      deemedTerm: null,
      problems,
      summary: `Starts ${formatDay(term.startsOn)}.`,
    };
  }

  // ── The lapsed end date ──────────────────────────────────────────────────
  if (term.endsOn && daysBetween(term.endsOn, now) > 0) {
    if (!options.stillEmployed) {
      return {
        state: "ended",
        daysToEnd,
        probationDaysRemaining: null,
        deemedTerm: null,
        problems,
        summary: `Ended ${formatDay(term.endsOn)}.`,
      };
    }

    const deemed = deemedRenewal(term.startsOn, term.endsOn, now);
    return {
      state: "auto_renewed",
      daysToEnd,
      probationDaysRemaining: null,
      deemedTerm: deemed,
      problems,
      summary:
        `The recorded term ended ${formatDay(term.endsOn)} and work continued, so the contract renewed ` +
        `on the same terms by operation of law. The term now running is ${formatDay(deemed.startsOn)} to ` +
        `${formatDay(deemed.endsOn)}${deemed.renewalCount > 1 ? ` (renewal ${deemed.renewalCount})` : ""}. ` +
        `Record it, or issue a fresh contract — the person is employed either way.`,
    };
  }

  if (probationDaysRemaining !== null) {
    return {
      state: "probation",
      daysToEnd,
      probationDaysRemaining,
      deemedTerm: null,
      problems,
      summary:
        `On probation until ${formatDay(term.probationEndsOn!)} — ${probationDaysRemaining} day${probationDaysRemaining === 1 ? "" : "s"} left. ` +
        `Termination by the employer during probation requires ${PROBATION_NOTICE_DAYS} days' notice. Probation cannot be extended.`,
    };
  }

  if (daysToEnd !== null && daysToEnd <= CONTRACT_RENEWAL_WINDOW_DAYS) {
    return {
      state: "expiring",
      daysToEnd,
      probationDaysRemaining: null,
      deemedTerm: null,
      problems,
      summary:
        `Ends ${formatDay(term.endsOn!)}, in ${daysToEnd} day${daysToEnd === 1 ? "" : "s"}. ` +
        `Renew it or let it auto-renew knowingly — an unrenewed term that runs on renews on the same terms regardless.`,
    };
  }

  return {
    state: "active",
    daysToEnd,
    probationDaysRemaining: null,
    deemedTerm: null,
    problems,
    summary: term.endsOn ? `Runs to ${formatDay(term.endsOn)}.` : "No end date recorded.",
  };
}

/**
 * The term the law deems to be running after one or more lapsed renewals.
 *
 * Loops rather than renewing once, because a contract that lapsed fourteen
 * months ago has renewed twice on a twelve-month term, and reporting "renewed
 * until a date that has also passed" would be a second wrong answer rather than
 * a correction of the first.
 */
export function deemedRenewal(
  originalStart: CalendarDay,
  originalEnd: CalendarDay,
  now: CalendarDay,
): { startsOn: CalendarDay; endsOn: CalendarDay; renewalCount: number } {
  // `endsOn` is the last day the contract covers, not the day after it. A term
  // running 1 September 2025 to 31 August 2026 is twelve months, and measuring
  // start-to-end directly returns eleven — which would renew every contract in
  // the business one month short and put the deemed end date in the wrong month
  // for ever after. Measure to the day the term stops covering.
  const termMonths = Math.max(1, completedMonths(originalStart, addDays(originalEnd, 1)));

  let startsOn = addDays(originalEnd, 1);
  let endsOn = addDays(addMonths(startsOn, termMonths), -1);
  let renewalCount = 1;

  // Guard rather than `while (true)`: a corrupt pair of dates must not spin.
  // Twenty renewals of a one-month term is twenty months of unrecorded
  // employment, which is far past the point where the loop bound matters.
  for (let guard = 0; guard < 240 && daysBetween(endsOn, now) > 0; guard++) {
    startsOn = addDays(endsOn, 1);
    endsOn = addDays(addMonths(startsOn, termMonths), -1);
    renewalCount += 1;
  }

  return { startsOn, endsOn, renewalCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-7 — Annual leave
// ═══════════════════════════════════════════════════════════════════════════

/** 30 calendar days per leave year, after one year of continuous service. */
export const ANNUAL_LEAVE_DAYS = 30;

/** 2 days per month for service between six and twelve months. */
export const PARTIAL_YEAR_LEAVE_DAYS_PER_MONTH = 2;

/** No statutory annual-leave entitlement accrues below six months' service. */
export const LEAVE_ACCRUAL_MIN_MONTHS = 6;

/** The employer must give at least one month's notice of the leave dates. */
export const LEAVE_NOTICE_DAYS = 30;

export interface LeaveEntitlement {
  readonly days: number;
  /** Which of the three rules produced the number. Shown, never inferred. */
  readonly basis: "under_six_months" | "partial_year" | "full_year";
  readonly serviceMonths: number;
  readonly explanation: string;
}

/**
 * Statutory annual-leave entitlement for the leave year in progress.
 *
 * Three rules, and the middle one is the one systems drop: between six and
 * twelve months of service the entitlement is **two days per month**, not a
 * pro-rated thirtieth of thirty. Two days a month for six months is twelve
 * days; a naive pro-rate gives fifteen, and the difference is a payment on
 * termination that the employer thinks it has already made.
 */
export function annualLeaveEntitlement(input: {
  serviceStart: CalendarDay;
  asOf?: CalendarDay;
  /** Start of the leave year being measured. Defaults to the service anniversary. */
  leaveYearStart?: CalendarDay;
}): LeaveEntitlement {
  const asOf = input.asOf ?? today();
  const serviceMonths = Math.max(0, completedMonths(input.serviceStart, asOf));

  if (serviceMonths < LEAVE_ACCRUAL_MIN_MONTHS) {
    return {
      days: 0,
      basis: "under_six_months",
      serviceMonths,
      explanation: `${serviceMonths} month${serviceMonths === 1 ? "" : "s"}' service. Statutory annual leave begins to accrue at six months.`,
    };
  }

  if (serviceMonths < 12) {
    const days = serviceMonths * PARTIAL_YEAR_LEAVE_DAYS_PER_MONTH;
    return {
      days,
      basis: "partial_year",
      serviceMonths,
      explanation: `${serviceMonths} months' service — ${PARTIAL_YEAR_LEAVE_DAYS_PER_MONTH} days per month of service, so ${days} days.`,
    };
  }

  // Past a year, the entitlement is the full 30 days for each leave year. A
  // part-year in progress accrues pro rata by completed month, which is what a
  // termination settlement is actually computed against.
  const yearStart = input.leaveYearStart ?? lastAnniversary(input.serviceStart, asOf);
  const monthsIntoYear = Math.max(0, Math.min(12, completedMonths(yearStart, asOf)));

  if (monthsIntoYear >= 12) {
    return {
      days: ANNUAL_LEAVE_DAYS,
      basis: "full_year",
      serviceMonths,
      explanation: `Over one year's service — ${ANNUAL_LEAVE_DAYS} calendar days for the leave year beginning ${formatDay(yearStart)}.`,
    };
  }

  const accrued = Math.floor((ANNUAL_LEAVE_DAYS * monthsIntoYear) / 12);
  return {
    days: ANNUAL_LEAVE_DAYS,
    basis: "full_year",
    serviceMonths,
    explanation:
      `Over one year's service — ${ANNUAL_LEAVE_DAYS} calendar days for the leave year beginning ` +
      `${formatDay(yearStart)}, of which ${accrued} ${accrued === 1 ? "day has" : "days have"} accrued so far.`,
  };
}

/** Days accrued so far in the current leave year, for a settlement figure. */
export function accruedLeaveDays(input: { serviceStart: CalendarDay; asOf?: CalendarDay }): number {
  const asOf = input.asOf ?? today();
  const serviceMonths = Math.max(0, completedMonths(input.serviceStart, asOf));
  if (serviceMonths < LEAVE_ACCRUAL_MIN_MONTHS) return 0;
  if (serviceMonths < 12) return serviceMonths * PARTIAL_YEAR_LEAVE_DAYS_PER_MONTH;

  const yearStart = lastAnniversary(input.serviceStart, asOf);
  const monthsIntoYear = Math.max(0, Math.min(12, completedMonths(yearStart, asOf)));
  return Math.floor((ANNUAL_LEAVE_DAYS * monthsIntoYear) / 12);
}

function lastAnniversary(serviceStart: CalendarDay, asOf: CalendarDay): CalendarDay {
  const years = Math.floor(completedMonths(serviceStart, asOf) / 12);
  return addMonths(serviceStart, years * 12);
}

export interface LeaveNoticeCheck {
  readonly sufficient: boolean;
  readonly daysGiven: number;
  readonly message: string;
}

/**
 * Was at least a month's notice of the leave dates given?
 *
 * `HR-7`. A warning, not a refusal: leave is frequently agreed at short notice
 * by mutual consent, and a system that refuses to record agreed leave produces
 * an unrecorded absence — which is worse for both the roster and the employee's
 * balance than a flagged one.
 */
export function checkLeaveNotice(input: {
  requestedOn: CalendarDay;
  startsOn: CalendarDay;
}): LeaveNoticeCheck {
  const daysGiven = daysBetween(input.requestedOn, input.startsOn);
  if (daysGiven >= LEAVE_NOTICE_DAYS) {
    return {
      sufficient: true,
      daysGiven,
      message: `${daysGiven} days' notice given.`,
    };
  }
  return {
    sufficient: false,
    daysGiven,
    message:
      `${daysGiven} day${daysGiven === 1 ? "" : "s"}' notice — the statutory minimum is ${LEAVE_NOTICE_DAYS} days ` +
      `for the employer to set annual-leave dates. Recorded, and flagged: leave agreed at shorter notice is lawful by consent, ` +
      `but leave imposed at shorter notice is not.`,
  };
}

/** Calendar days a leave request covers, both ends inclusive. */
export function leaveDayCount(startsOn: CalendarDay, endsOn: CalendarDay): number {
  return Math.max(0, daysBetween(startsOn, endsOn) + 1);
}

/**
 * The kinds of leave a request may be recorded as.
 *
 * Mirrored by a CHECK constraint on `leave_requests.kind` in migration 0019.
 * The vocabulary exists for one reason: the sick-leave ladder below counts the
 * rows whose kind is exactly `sick`, and a day recorded as "Sick" or
 * "sick_leave" is a day the ladder never sees — so the employee reads as having
 * more of the 90 statutory days left than they do, and the fifteenth day of
 * full pay gets paid twice.
 *
 * ── WHY `other` IS ON THIS LIST WHEN IT IS BANNED FROM THE DEDUCTION ONE ────
 *
 * `LAWFUL_DEDUCTION_KINDS` is a positive list precisely so that "other" cannot
 * exist: there, an unlisted value is an unlawful deduction wearing a different
 * label, and the constraint is what makes the rule true. Nothing of the kind is
 * true here. A leave kind is a classification, not a permission, and the rows
 * that predate this vocabulary have to land somewhere the constraint accepts.
 * `other` is where migration 0019 puts them — visibly unclassified rather than
 * silently relabelled as annual or sick, either of which would move somebody's
 * balance.
 */
export const LEAVE_KINDS = [
  "annual",
  "sick",
  "maternity",
  "parental",
  "bereavement",
  "hajj",
  "study",
  "unpaid",
  "other",
] as const;

export type LeaveKind = (typeof LEAVE_KINDS)[number];

export const LEAVE_KIND_LABEL: Readonly<Record<LeaveKind, string>> = {
  annual: "Annual leave",
  sick: "Sick leave",
  maternity: "Maternity leave",
  parental: "Parental leave",
  bereavement: "Bereavement leave",
  hajj: "Hajj",
  study: "Study leave",
  unpaid: "Unpaid leave",
  other: "Other — kind not recorded",
};

// ═══════════════════════════════════════════════════════════════════════════
// HR-7 — Sick leave, which is three rates and not one
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Statutory sick leave, after probation: 15 days at full pay, then 30 at half
 * pay, then 45 unpaid — 90 days in all, per leave year.
 *
 * ── THE ONE THING SYSTEMS GET WRONG HERE ────────────────────────────────────
 *
 * A twenty-day absence is not twenty days at one rate. It is fifteen at full
 * pay and five at half pay, and the difference is five days of somebody's wage
 * paid twice over — in the direction the employer never notices, because the
 * payroll simply looks slightly high.
 *
 * The stages consume **in order**, and the cursor is the leave year rather than
 * the absence: a worker who took twelve sick days in March and takes six more
 * in July gets three of those six at full pay and three at half, because the
 * first stage had three days left in it. Restarting the ladder at every absence
 * is the same overpayment, spread out enough that nobody adds it up.
 */
export const SICK_LEAVE_FULL_PAY_DAYS = 15;
export const SICK_LEAVE_HALF_PAY_DAYS = 30;
export const SICK_LEAVE_UNPAID_DAYS = 45;

/** 15 + 30 + 45. Past this, the absence is not statutory sick leave at all. */
export const SICK_LEAVE_TOTAL_DAYS =
  SICK_LEAVE_FULL_PAY_DAYS + SICK_LEAVE_HALF_PAY_DAYS + SICK_LEAVE_UNPAID_DAYS;

/**
 * What each stage pays, as integer basis points of the daily wage.
 *
 * Basis points for the same reason the overtime multipliers are: `0.5` is
 * exactly representable but `wage * 0.5` on a wage that is itself a rounded
 * float is not, and half pay is applied to thirty days of somebody's month.
 */
export const SICK_PAY_BASIS_POINTS = {
  full_pay: 10_000,
  half_pay: 5_000,
  unpaid: 0,
} as const;

export interface SickLeaveStages {
  readonly days: number;
  readonly daysAlreadyTaken: number;
  /** Days inside probation. Unpaid, and they do NOT consume the 90. */
  readonly probationUnpaidDays: number;
  readonly fullPayDays: number;
  readonly halfPayDays: number;
  readonly unpaidDays: number;
  /** Days past the 90-day year. Not sick leave — an absence to be decided on. */
  readonly beyondEntitlementDays: number;
  /** full + half + unpaid: what the next absence's cursor advances by. */
  readonly entitlementConsumedDays: number;
  /** Of the 90, after this absence. */
  readonly remainingDays: number;
  readonly explanation: string;
}

/** Overlap of `[from, to)` with `[start, end)`, in whole days. */
function overlap(from: number, to: number, start: number, end: number): number {
  return Math.max(0, Math.min(to, end) - Math.max(from, start));
}

/**
 * Split one sick absence across the three statutory rates (`HR-7`).
 *
 * `daysAlreadyTaken` is the position in the leave year, not in this absence,
 * which is what makes the ladder continue rather than restart. The three stages
 * are half-open ranges over that position — `[0, 15)`, `[15, 45)`, `[45, 90)` —
 * so day 15 is the last full-pay day and day 16 is the first half-pay one, and
 * there is no `<=` anywhere for somebody to get backwards.
 */
export function stageSickLeave(input: {
  days: number;
  /** Sick days consumed earlier in the same leave year. */
  daysAlreadyTaken?: number;
  /**
   * Days at the START of this absence that fall inside the probation period.
   *
   * There is no paid sick leave during probation. Unpaid sick leave is
   * available with the employer's agreement, and none of it consumes the 90
   * days — the entitlement runs from the end of probation.
   */
  probationDays?: number;
}): SickLeaveStages {
  const days = Math.max(0, Math.floor(input.days));
  const daysAlreadyTaken = Math.max(0, Math.floor(input.daysAlreadyTaken ?? 0));
  const probationUnpaidDays = Math.min(days, Math.max(0, Math.floor(input.probationDays ?? 0)));

  const staged = days - probationUnpaidDays;
  const from = daysAlreadyTaken;
  const to = daysAlreadyTaken + staged;

  const fullEnd = SICK_LEAVE_FULL_PAY_DAYS;
  const halfEnd = fullEnd + SICK_LEAVE_HALF_PAY_DAYS;
  const unpaidEnd = halfEnd + SICK_LEAVE_UNPAID_DAYS;

  const fullPayDays = overlap(from, to, 0, fullEnd);
  const halfPayDays = overlap(from, to, fullEnd, halfEnd);
  const unpaidDays = overlap(from, to, halfEnd, unpaidEnd);
  const beyondEntitlementDays = Math.max(0, to - Math.max(from, unpaidEnd));

  const entitlementConsumedDays = fullPayDays + halfPayDays + unpaidDays;
  const remainingDays = Math.max(0, SICK_LEAVE_TOTAL_DAYS - (daysAlreadyTaken + entitlementConsumedDays));

  const parts: string[] = [];
  if (probationUnpaidDays > 0) {
    parts.push(`${probationUnpaidDays} inside probation, unpaid and not counted against the ${SICK_LEAVE_TOTAL_DAYS}`);
  }
  if (fullPayDays > 0) parts.push(`${fullPayDays} at full pay`);
  if (halfPayDays > 0) parts.push(`${halfPayDays} at half pay`);
  if (unpaidDays > 0) parts.push(`${unpaidDays} unpaid`);
  if (beyondEntitlementDays > 0) {
    parts.push(
      `${beyondEntitlementDays} past the ${SICK_LEAVE_TOTAL_DAYS}-day year, which is not sick leave at all`,
    );
  }

  return {
    days,
    daysAlreadyTaken,
    probationUnpaidDays,
    fullPayDays,
    halfPayDays,
    unpaidDays,
    beyondEntitlementDays,
    entitlementConsumedDays,
    remainingDays,
    explanation:
      days === 0
        ? "No sick days recorded."
        : `${days} day${days === 1 ? "" : "s"} — ${parts.join(", ")}. ` +
          `${remainingDays} of the ${SICK_LEAVE_TOTAL_DAYS} statutory days remain this leave year.`,
  };
}

/**
 * What a staged absence is worth, in minor units.
 *
 * Against the **whole** monthly wage — basic plus allowances — because Article
 * 31 stages the *wage*, and "wage" is basic plus every allowance in Article 1.
 * Computing sick pay on basic alone is a systematic underpayment of exactly the
 * housing and transport allowance, every sick day, for everybody.
 *
 * One rounding step per stage: the daily rate is rounded once from the month,
 * and each stage is `daily × days × basisPoints ÷ 10000` rounded once. That is
 * what makes the total equal what an employee gets multiplying it out by hand.
 */
export function sickLeavePayMinor(
  monthlyWageMinor: number,
  stages: SickLeaveStages,
  options: { daysPerMonth?: number } = {},
): number {
  const daysPerMonth = options.daysPerMonth ?? PAYROLL_DAYS_PER_MONTH;
  if (daysPerMonth <= 0) return 0;
  const dailyMinor = Math.round(monthlyWageMinor / daysPerMonth);

  const full = Math.round((dailyMinor * stages.fullPayDays * SICK_PAY_BASIS_POINTS.full_pay) / 10_000);
  const half = Math.round((dailyMinor * stages.halfPayDays * SICK_PAY_BASIS_POINTS.half_pay) / 10_000);
  return full + half;
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-8 — Working hours and overtime
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Overtime multipliers, as integer basis points of the basic hourly rate.
 *
 * Named "pay band" rather than "rate band" on purpose: `RateBand` already
 * exists in `packages/db/src/domain/reference.ts` and means the opposite end of
 * the transaction — what a *customer* is charged out of hours. Two types called
 * `RateBand`, one for what a worker is paid and one for what a client pays,
 * would be aliased at every import site until somebody stopped aliasing.
 *
 * 10000 = ×1.00. These are never floats, for the reason at the top of the file:
 * they are applied per hour, per person, per month, and summed into a wage
 * file. See `overtimeAmountMinor`.
 */
export const PAY_BAND_BASIS_POINTS = {
  /** Ordinary hours, inside the statutory day. */
  standard: 10_000,
  /** Overtime at basic + 25%. */
  overtime: 12_500,
  /** Overtime worked between 22:00 and 04:00: basic + 50%. */
  night: 15_000,
  /** Work on a rest day: a substitute day OR basic + 50%. */
  rest_day: 15_000,
} as const;

export type PayBand = keyof typeof PAY_BAND_BASIS_POINTS;

export const PAY_BAND_LABEL: Readonly<Record<PayBand, string>> = {
  standard: "Standard",
  overtime: "Overtime (+25%)",
  night: "Night, 22:00–04:00 (+50%)",
  rest_day: "Rest day (+50% or a substitute day)",
};

/** Overtime is capped at two extra hours a day. */
export const MAX_OVERTIME_MINUTES_PER_DAY = 120;

/** The night band, as minutes of the Dubai day. Wraps midnight. */
export const NIGHT_START_MINUTE = 22 * 60;
export const NIGHT_END_MINUTE = 4 * 60;

/**
 * Hours in a working month, for converting a monthly basic salary to an hourly
 * one.
 *
 * 30 days × 8 hours is the UAE market convention rather than a statutory
 * formula, which is why it is a named constant a deployment can change instead
 * of a `/240` buried in an expression. Getting it wrong scales every overtime
 * payment in the business by a constant factor, in a direction nobody notices
 * until an employee does the sum.
 */
export const PAYROLL_DAYS_PER_MONTH = 30;
export const PAYROLL_HOURS_PER_DAY = 8;

/** Monthly basic (minor units) → hourly basic (minor units). */
export function hourlyBasicMinor(
  monthlyBasicMinor: number,
  options: { daysPerMonth?: number; hoursPerDay?: number } = {},
): number {
  const days = options.daysPerMonth ?? PAYROLL_DAYS_PER_MONTH;
  const hours = options.hoursPerDay ?? PAYROLL_HOURS_PER_DAY;
  if (days <= 0 || hours <= 0) return 0;
  return Math.round(monthlyBasicMinor / (days * hours));
}

/**
 * What a stretch of worked minutes is worth, in minor units.
 *
 * One rounding step, at the end. `hourly × minutes × basisPoints` is an exact
 * integer product; dividing by `60 × 10000` once and rounding once is what
 * makes the sum of a month's entries equal the number an employee gets by
 * multiplying it out by hand.
 */
export function overtimeAmountMinor(
  hourlyMinor: number,
  minutes: number,
  band: PayBand,
): number {
  const basisPoints = PAY_BAND_BASIS_POINTS[band];
  return Math.round((hourlyMinor * minutes * basisPoints) / (60 * 10_000));
}

export interface PayBandSplit {
  readonly standardMinutes: number;
  readonly overtimeMinutes: number;
  readonly nightMinutes: number;
  readonly restDayMinutes: number;
  readonly totalMinutes: number;
  /** Minutes of overtime beyond the two-hour daily cap. */
  readonly overCapMinutes: number;
}

/**
 * Split one worked stretch into the bands it is paid at.
 *
 * ── THE ORDERING RULE, WHICH IS THE WHOLE FUNCTION ──────────────────────────
 *
 * Standard hours come first chronologically: the statutory day is worked, and
 * only what follows it is overtime. So the night premium is computed against
 * the *overtime portion* — the minutes after the statutory day has been used
 * up — and not against every minute that happens to fall after 22:00. A shift
 * that starts at 20:00 and ends at 04:00 is eight hours: the whole thing is
 * ordinary time and none of it attracts the +50%, which is the answer people
 * get wrong in the expensive direction by classifying on the clock alone.
 *
 * Rest-day work is not split at all. Every minute of it is rest-day work, to be
 * compensated with a substitute day or +50%, and the choice between those two
 * belongs to the employer — recorded, not assumed.
 */
export function splitWorkedWindow(input: {
  start: Date;
  end: Date;
  /** Minutes of ordinary time before overtime begins. Ramadan shortens it. */
  ordinaryMinutes: number;
  /** Unpaid break inside the window, removed before any of this. */
  breakMinutes?: number;
  isRestDay?: boolean;
}): PayBandSplit {
  const rawMinutes = Math.max(0, Math.round((input.end.getTime() - input.start.getTime()) / 60_000));
  const totalMinutes = Math.max(0, rawMinutes - (input.breakMinutes ?? 0));

  if (input.isRestDay) {
    return {
      standardMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: 0,
      restDayMinutes: totalMinutes,
      totalMinutes,
      overCapMinutes: 0,
    };
  }

  const standardMinutes = Math.min(totalMinutes, Math.max(0, input.ordinaryMinutes));
  const extraMinutes = totalMinutes - standardMinutes;

  // The overtime portion starts once the ordinary day is used up. The break is
  // charged against the ordinary portion, which is where it is actually taken.
  const overtimeStart = new Date(input.start.getTime() + (standardMinutes + (input.breakMinutes ?? 0)) * 60_000);
  const nightMinutes = extraMinutes === 0 ? 0 : nightMinutesBetween(overtimeStart, input.end);

  return {
    standardMinutes,
    overtimeMinutes: Math.max(0, extraMinutes - nightMinutes),
    nightMinutes: Math.min(extraMinutes, nightMinutes),
    restDayMinutes: 0,
    totalMinutes,
    overCapMinutes: Math.max(0, extraMinutes - MAX_OVERTIME_MINUTES_PER_DAY),
  };
}

/**
 * Minutes of `[start, end)` that fall inside 22:00–04:00, Dubai.
 *
 * Walks the Dubai days the window touches and intersects each one's night
 * window rather than doing modular arithmetic on minutes-of-day, because the
 * night window wraps midnight and the modular version of this is where the
 * off-by-one lives.
 */
export function nightMinutesBetween(start: Date, end: Date): number {
  if (end <= start) return 0;

  let total = 0;
  const first = toDubai(start);
  // One day back, because the night window opened on the previous day at 22:00
  // and can still be running at 03:00 on this one.
  let cursorDay = fromDubai(first.year, first.month, first.day - 1, 0);

  for (let guard = 0; guard < 400; guard++) {
    const t = toDubai(cursorDay);
    const windowStart = fromDubai(t.year, t.month, t.day, NIGHT_START_MINUTE);
    const windowEnd = fromDubai(t.year, t.month, t.day + 1, NIGHT_END_MINUTE);

    if (windowStart >= end) break;

    const from = start > windowStart ? start : windowStart;
    const to = end < windowEnd ? end : windowEnd;
    if (to > from) total += Math.round((to.getTime() - from.getTime()) / 60_000);

    cursorDay = fromDubai(t.year, t.month, t.day + 1, 0);
  }

  return total;
}

/**
 * The statutory ordinary day for a given date.
 *
 * Eight hours, less the two-hour Ramadan reduction. `checkStatutoryHours` in
 * `calendar.ts` compares against `maxHoursPerDay` flat; this is the same number
 * with the reduction applied, and it is what `assessWorkedDay` passes back in
 * so the two never disagree.
 */
export function ordinaryMinutesFor(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): number {
  const base = calendar.maxHoursPerDay * 60;
  return isRamadan(instant, calendar) ? Math.max(0, base - calendar.ramadanReductionMinutes) : base;
}

export interface WorkedDayAssessment {
  readonly split: PayBandSplit;
  /** Amounts per band, in minor units. Empty bands are omitted by the caller. */
  readonly amounts: Readonly<Record<PayBand, number>>;
  readonly totalMinor: number;
  readonly hours: HoursCheck;
  /** `HR-8` and `HR-10` findings the hours check itself cannot see. */
  readonly warnings: readonly string[];
  readonly withinLimits: boolean;
}

/**
 * One worked day, priced and checked (`HR-8`, `HR-10`).
 *
 * Delegates the statutory maxima to `checkStatutoryHours` — the calendar owns
 * those and a second copy of "8 hours, 48 hours, one hour after five" is a
 * second copy that will drift. What this adds is the part the calendar has no
 * business knowing: the rate bands, the two-extra-hours cap, and the Ramadan
 * reduction applied to the day limit rather than only to the closing time.
 */
export function assessWorkedDay(
  input: {
    start: Date;
    end: Date;
    breakMinutes?: number;
    isRestDay?: boolean;
    minutesThisWeek: number;
    monthlyBasicMinor: number;
  },
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): WorkedDayAssessment {
  const ordinaryMinutes = ordinaryMinutesFor(input.start, calendar);
  const split = splitWorkedWindow({
    start: input.start,
    end: input.end,
    ordinaryMinutes,
    ...(input.breakMinutes === undefined ? {} : { breakMinutes: input.breakMinutes }),
    ...(input.isRestDay === undefined ? {} : { isRestDay: input.isRestDay }),
  });

  const hourly = hourlyBasicMinor(input.monthlyBasicMinor);
  const amounts: Record<PayBand, number> = {
    standard: overtimeAmountMinor(hourly, split.standardMinutes, "standard"),
    overtime: overtimeAmountMinor(hourly, split.overtimeMinutes, "overtime"),
    night: overtimeAmountMinor(hourly, split.nightMinutes, "night"),
    rest_day: overtimeAmountMinor(hourly, split.restDayMinutes, "rest_day"),
  };

  const hours = checkStatutoryHours(
    {
      minutesToday: split.totalMinutes,
      minutesThisWeek: input.minutesThisWeek,
      longestStretchMinutes: split.totalMinutes - (input.breakMinutes ?? 0),
    },
    calendar,
    // The Ramadan reduction, applied to the daily maximum and not only to the
    // closing time. Without this a nine-hour day in Ramadan — three hours over
    // the statutory six — reports as one hour over.
    { on: input.start },
  );

  const warnings: string[] = [];
  if (split.overCapMinutes > 0) {
    warnings.push(
      `${formatMinutes(split.overtimeMinutes + split.nightMinutes)} of overtime exceeds the statutory maximum of ` +
        `${MAX_OVERTIME_MINUTES_PER_DAY / 60} extra hours per day by ${formatMinutes(split.overCapMinutes)}.`,
    );
  }
  if (split.restDayMinutes > 0) {
    warnings.push(
      `${formatMinutes(split.restDayMinutes)} worked on a rest day. Compensate with a substitute rest day or pay at ` +
        `+50%; record which, because "we agreed a day off" is not evidence six months later.`,
    );
  }
  if (isRamadan(input.start, calendar) && split.totalMinutes > ordinaryMinutes) {
    warnings.push(
      `Ramadan: the ordinary day is ${formatMinutes(ordinaryMinutes)}, two hours shorter. Everything beyond it is overtime.`,
    );
  }

  return {
    split,
    amounts,
    totalMinor: amounts.standard + amounts.overtime + amounts.night + amounts.rest_day,
    hours,
    warnings,
    withinLimits: hours.withinLimits && warnings.length === 0,
  };
}

function formatMinutes(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hour${hours === 1 ? "" : "s"}`;
}

export interface WeeklyHoursAssessment {
  readonly minutes: number;
  readonly limitMinutes: number;
  /** How far past the statutory week. Zero when it is exactly at the limit. */
  readonly overMinutes: number;
  readonly withinLimit: boolean;
  readonly detail: string;
}

/**
 * One week's worked minutes against the 48-hour statutory maximum (`HR-8`).
 *
 * ── WHY THE COMPARISON IS NOT WRITTEN HERE ──────────────────────────────────
 *
 * `checkStatutoryHours` in `calendar.ts` already owns "more than 48 hours in a
 * week is a breach", and it is the function `assessWorkedDay` runs a worked day
 * through. A second `minutesThisWeek > 48 * 60` here would be a second copy of
 * a statutory comparison, and the two would agree right up until somebody
 * changed one of them — most likely by turning a `>` into a `>=`, which reports
 * a lawful 48-hour week as a violation and, done the other way round on any
 * other threshold in this file, reports a violation as lawful.
 *
 * So this delegates the verdict and only adds the numbers a report needs: the
 * limit it was measured against and how far past it the week ran. Exactly 48
 * hours is within the limit; 48 hours and one minute is not.
 */
export function assessWeeklyHours(
  minutesThisWeek: number,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): WeeklyHoursAssessment {
  const limitMinutes = Math.max(0, calendar.maxHoursPerWeek * 60);
  const minutes = Math.max(0, minutesThisWeek);

  // `minutesToday: 0` is not a claim that nobody worked today — it is this
  // function declining to answer the daily question, which it has no day to
  // answer it for. Zero minutes produces no daily warning, so what comes back
  // is the weekly verdict alone.
  const check = checkStatutoryHours({ minutesToday: 0, minutesThisWeek: minutes }, calendar);

  return {
    minutes,
    limitMinutes,
    overMinutes: Math.max(0, minutes - limitMinutes),
    withinLimit: check.withinLimits,
    detail:
      check.warnings[0] ??
      `${formatMinutes(minutes)} this week, within the statutory maximum of ${calendar.maxHoursPerWeek} hours.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-6 — Health insurance, and the deduction that must be impossible
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Health insurance is mandatory in Dubai under Dubai Law No. 11 of 2013, is
 * **employer-funded**, and the premium **may not be deducted from salary**.
 *
 * That last clause is structural rather than advisory, which is why it appears
 * in three places that all have to agree: a positive list of lawful deduction
 * kinds here, a CHECK constraint on `salary_deductions.kind` in the database,
 * and a plain-language refusal in `recordSalaryDeduction`. A comment in a form
 * would have been a policy note.
 */
export const HEALTH_INSURANCE_EMPLOYER_FUNDED = true;

/** Workers earning below this require an Essential Benefits Plan. AED 4,000/month. */
export const ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR = 400_000;

export const HEALTH_PLANS = ["essential_benefits", "standard"] as const;
export type HealthPlan = (typeof HEALTH_PLANS)[number];

export const HEALTH_PLAN_LABEL: Readonly<Record<HealthPlan, string>> = {
  essential_benefits: "Essential Benefits Plan (EBP)",
  standard: "Standard plan",
};

/**
 * Which plan the law requires for this wage.
 *
 * The monthly wage here is the total — basic plus allowances — because the
 * AED 4,000 EBP threshold is set against what the worker is actually paid, not
 * against the basic component that gratuity is computed on.
 */
export function requiredHealthPlan(monthlyWageMinor: number): HealthPlan {
  return monthlyWageMinor < ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR ? "essential_benefits" : "standard";
}

/**
 * Deduction kinds that may lawfully be taken from a salary.
 *
 * A **positive** list, deliberately. A negative list of forbidden kinds is one
 * free-text value away from being defeated — somebody records the insurance
 * premium as "other" and the prohibition evaporates. With a positive list, a
 * kind that is not named here cannot be stored at all, in the database or in
 * this module.
 */
export const LAWFUL_DEDUCTION_KINDS = [
  "salary_advance_repayment",
  "loan_repayment",
  "unpaid_absence",
  "disciplinary_fine",
  "court_order",
  "damage_recovery",
  "social_security",
] as const;

export type DeductionKind = (typeof LAWFUL_DEDUCTION_KINDS)[number];

export const DEDUCTION_KIND_LABEL: Readonly<Record<DeductionKind, string>> = {
  salary_advance_repayment: "Repayment of a salary advance",
  loan_repayment: "Repayment of an employer loan",
  unpaid_absence: "Unpaid absence",
  disciplinary_fine: "Disciplinary fine",
  court_order: "Court-ordered deduction",
  damage_recovery: "Recovery for damage caused, as agreed or awarded",
  social_security: "Social security contribution (GCC nationals)",
};

/**
 * Kinds somebody will try, and the statute that refuses each one.
 *
 * These are never stored. They exist so the refusal can name the right law
 * instead of saying "invalid value" — which teaches nobody anything and gets
 * the amount recorded under a different label ten seconds later.
 */
const REFUSALS: Readonly<Record<string, string>> = {
  health_insurance:
    "Health insurance is employer-funded under Dubai Law No. 11 of 2013 and the premium may not be deducted from salary. Record it as an employer cost on the employment record instead.",
  insurance_premium:
    "Health insurance is employer-funded under Dubai Law No. 11 of 2013 and the premium may not be deducted from salary. Record it as an employer cost on the employment record instead.",
  medical_insurance:
    "Health insurance is employer-funded under Dubai Law No. 11 of 2013 and the premium may not be deducted from salary. Record it as an employer cost on the employment record instead.",
  visa_cost:
    "Article 6 of the Labour Law prohibits charging or recovering recruitment and employment costs from a worker, directly or indirectly. Visa costs are the employer's.",
  recruitment_fee:
    "Article 6 of the Labour Law prohibits charging or recovering recruitment and employment costs from a worker, directly or indirectly.",
  work_permit_fee:
    "Article 6 of the Labour Law prohibits charging or recovering recruitment and employment costs from a worker, directly or indirectly. Permit fees are the employer's.",
  medical_test:
    "Article 6 of the Labour Law prohibits recovering employment costs from a worker. The pre-employment medical is an employment cost.",
  emirates_id:
    "Article 6 of the Labour Law prohibits recovering employment costs from a worker. The Emirates ID is an employment cost.",
};

/**
 * Why this deduction cannot be recorded, or null if it can.
 *
 * `HR-6` and `HR-16` share one mechanism, because they are the same failure:
 * a cost the employer must bear being moved onto the worker. Returning the
 * sentence rather than a boolean is the difference between a rule and a
 * refusal somebody understands.
 */
export function refuseDeduction(kind: string): string | null {
  const normalised = kind.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((LAWFUL_DEDUCTION_KINDS as readonly string[]).includes(normalised)) return null;

  const named = REFUSALS[normalised];
  if (named) return named;

  return (
    `"${kind}" is not a lawful salary deduction in the UAE. Deductions are limited to a fixed list — ` +
    `${LAWFUL_DEDUCTION_KINDS.map((k) => DEDUCTION_KIND_LABEL[k].toLowerCase()).join(", ")} — because ` +
    `anything outside it is either an employment cost the employer must bear (Article 6) or an ` +
    `unauthorised reduction of a protected wage. If this is genuinely one of the permitted kinds, use that kind.`
  );
}

export interface HealthInsuranceCheck {
  readonly compliant: boolean;
  readonly requiredPlan: HealthPlan;
  readonly problems: readonly string[];
}

/**
 * Whether an employee's health cover is what the law requires (`HR-6`).
 *
 * Deliberately says nothing about expiry. `employee_documents` holds the
 * `health_insurance` document with its expiry date, it is already one of the
 * five blocking kinds, and a second expiry stored here would be a second
 * source of truth — the one that is wrong being, inevitably, the one somebody
 * reads.
 */
export function checkHealthInsurance(input: {
  monthlyWageMinor: number | null;
  plan: HealthPlan | null;
  insurer: string | null;
  /** From `employee_documents`, not from a second column. */
  hasInDatePolicyDocument: boolean;
}): HealthInsuranceCheck {
  const requiredPlan = requiredHealthPlan(input.monthlyWageMinor ?? 0);
  const problems: string[] = [];

  if (!input.hasInDatePolicyDocument) {
    problems.push(
      "No in-date health insurance policy on file. Cover is mandatory in Dubai, blocks visa processing when it lapses, and carries monthly penalties from AED 500 to AED 150,000.",
    );
  }
  if (!input.plan) {
    problems.push("No plan tier recorded, so nothing can check it against the AED 4,000 Essential Benefits threshold.");
  } else if (input.plan !== requiredPlan && requiredPlan === "essential_benefits") {
    problems.push(
      `Wage is below AED ${ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR / 100}/month, which requires an Essential Benefits Plan. A ${HEALTH_PLAN_LABEL[input.plan]} is recorded.`,
    );
  }
  if (!input.insurer) {
    problems.push("No insurer recorded. A policy nobody can name is a policy nobody can claim against.");
  }
  if (input.monthlyWageMinor === null) {
    problems.push("No wage recorded, so the required plan tier is a guess.");
  }

  return { compliant: problems.length === 0, requiredPlan, problems };
}
