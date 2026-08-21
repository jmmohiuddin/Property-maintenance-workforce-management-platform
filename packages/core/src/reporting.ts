import { PPM_COMPLETION_TARGET_PERCENT } from "./contract";

/**
 * The thresholds the owner dashboard measures against (`KPI-3`, `KPI-5`).
 *
 * They live in `core` rather than in the query that reads them, for the reason
 * every other constant here does: a number written into a SQL string is a
 * number that cannot be tested, cannot be cited, and quietly differs from the
 * one in the email when somebody edits only one of them.
 *
 * Every figure below is sourced from PRD §7.1 (product goals) or §11 (the
 * compliance register). Where a target is a business preference it says so;
 * where it is a statutory line it says that instead, because the two behave
 * completely differently when you cross them.
 */

// ── Corporate tax: the line that cannot be uncrossed ─────────────────────────

/**
 * Small Business Relief, in fils. AED 3,000,000.
 *
 * `INV-17`, PRD §11. This is the single most consequential number on the
 * dashboard and it is not a target — it is a cliff. Three properties make it
 * different from every other figure here:
 *
 *  1. It is tested on **revenue**, not profit. A low-margin year at AED 3.1m
 *     breaches it; a high-margin year at AED 2.9m does not.
 *  2. It is **elected annually** in the tax return, so nobody is told they have
 *     crossed it — the business finds out when the return is prepared.
 *  3. **One breach permanently disqualifies every later period.** There is no
 *     way back. This is why the dashboard shows headroom continuously rather
 *     than reporting it once a year: the only useful moment to know is before.
 */
export const SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR = 300_000_000;

/**
 * Where the dashboard starts saying so. 80% of the threshold — AED 2.4m.
 *
 * Chosen so that a business tracking at this level still has a quarter in which
 * to decide whether to defer work, invoice in the next period, or accept the
 * loss of relief deliberately. A warning at 95% is an announcement, not a
 * decision point.
 */
export const SMALL_BUSINESS_RELIEF_WARNING_RATIO = 0.8;

/**
 * Corporate tax registration threshold for a natural person, in fils. AED 1m.
 *
 * PRD §11: a sole establishment becomes taxable once turnover exceeds AED 1m in
 * a calendar year, with registration due by 31 March of the following year and
 * AED 10,000 for registering late. Reported alongside the relief line because
 * they are measured on the same number and crossed in the same direction.
 */
export const CORPORATE_TAX_REGISTRATION_THRESHOLD_MINOR = 100_000_000;

export type ReliefState = "clear" | "approaching" | "breached";

export interface ReliefPosition {
  readonly revenueMinor: number;
  readonly thresholdMinor: number;
  /** 0–1+, revenue over threshold. Above 1 means the relief is already lost. */
  readonly ratio: number;
  readonly state: ReliefState;
  /** Fils remaining before the threshold. Negative once it is crossed. */
  readonly headroomMinor: number;
  /** Whether turnover has passed the AED 1m corporate-tax registration line. */
  readonly registrationRequired: boolean;
}

/**
 * Where this period's revenue sits against the relief threshold.
 *
 * Integer arithmetic throughout. `ratio` is the only float, it is derived last,
 * and nothing decides anything on it — `state` and `headroomMinor` are both
 * computed from the integers, so a rounding artefact in the progress bar cannot
 * change what the dashboard says.
 */
export function smallBusinessReliefPosition(revenueMinor: number): ReliefPosition {
  const thresholdMinor = SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR;
  const headroomMinor = thresholdMinor - revenueMinor;

  const state: ReliefState =
    revenueMinor > thresholdMinor
      ? "breached"
      : revenueMinor >= Math.floor(thresholdMinor * SMALL_BUSINESS_RELIEF_WARNING_RATIO)
        ? "approaching"
        : "clear";

  return {
    revenueMinor,
    thresholdMinor,
    // No divide-by-zero guard: the denominator is a statutory constant, and a
    // guard here would only ever hide the constant having been edited to zero.
    ratio: revenueMinor / thresholdMinor,
    state,
    headroomMinor,
    registrationRequired: revenueMinor > CORPORATE_TAX_REGISTRATION_THRESHOLD_MINOR,
  };
}

// ── Emiratisation ────────────────────────────────────────────────────────────

/**
 * The establishment size at which Emiratisation targets begin to apply.
 *
 * `HR-18`, PRD §11. Fifty **skilled** employees, and the definition of skilled
 * is the whole difficulty: ISCO occupational levels 1–5, **and** a
 * post-secondary certificate, **and** a salary of at least AED 4,000 a month.
 * Manual and craft workers, drivers, security and cleaners are excluded from
 * both the numerator and the denominator — so a contractor with 60 tradesmen
 * and 6 office staff is measured against the 6, not the 66.
 *
 * Getting the denominator wrong in the reassuring direction is the expensive
 * mistake, which is why the dashboard reports skilled headcount as a named gap
 * rather than as a number: `employees` carries none of the three facts the
 * definition needs.
 *
 * Only the threshold is defined here. The AED 4,000 salary floor and the ISCO
 * level list belong with the query that applies them, and declaring them now —
 * unused, unexercised — would be declaring that the test exists when what
 * exists is the number 50.
 */
export const EMIRATISATION_SKILLED_THRESHOLD = 50;

// ── The goals the dashboard grades against ───────────────────────────────────

/**
 * A target, its direction, and where it came from.
 *
 * `direction` exists so that one comparison function serves all of them: "lower
 * is better" for DSO and breach rate, "higher is better" for conversion. Two
 * comparison helpers is one comparison helper written twice with the operator
 * flipped in one of them, which is a bug waiting for a Friday.
 */
export interface GoalTarget {
  readonly id: string;
  readonly label: string;
  readonly target: number;
  readonly direction: "lower_is_better" | "higher_is_better";
  readonly unit: "days" | "percent";
}

/**
 * The subset of PRD §7.1 the owner dashboard can actually source today.
 *
 * G11 (first-time fix) is on the wireframe and is deliberately absent here: it
 * needs field-app visit outcome codes, and a target with no measurement is a
 * line on a screen that will read "—" forever while looking like a metric.
 *
 * G12 (PPM completion) used to sit beside it for the same reason, waiting on
 * `CON-7` visit completion. That landed, so it is a goal now rather than a
 * gap. The entry that removed it from `DASHBOARD_GAPS` is the point of this
 * file: a target arrives when the measurement does, not before.
 */
export const DASHBOARD_GOALS: Readonly<Record<string, GoalTarget>> = {
  slaBreachRate: {
    id: "G4",
    label: "SLA breach rate",
    target: 5,
    direction: "lower_is_better",
    unit: "percent",
  },
  quoteConversion: {
    id: "G5",
    label: "Quote conversion",
    target: 50,
    direction: "higher_is_better",
    unit: "percent",
  },
  invoiceLagDays: {
    id: "G7",
    label: "Invoice lag",
    target: 2,
    direction: "lower_is_better",
    unit: "days",
  },
  dsoDays: {
    id: "G8",
    label: "Days sales outstanding",
    target: 45,
    direction: "lower_is_better",
    unit: "days",
  },
  /*
   * G12, PRD §7.1 and CON-7. The target is not restated here: it is
   * `PPM_COMPLETION_TARGET_PERCENT`, which the AMC screen already grades
   * against, and two copies of 98 is one copy of 98 that somebody edits.
   */
  ppmCompletion: {
    id: "G12",
    label: "PPM completion",
    target: PPM_COMPLETION_TARGET_PERCENT,
    direction: "higher_is_better",
    unit: "percent",
  },
  /*
   * G13, PRD §7.1: "application received → offer accepted, median under 14
   * days".
   *
   * A median rather than a mean, and the target is written for one. In this
   * market a single hire can wait eleven weeks on a visa transfer or a notice
   * period, and a mean over four hires a year is one such hire away from
   * reporting a broken process that is working. The median says what the
   * typical applicant experiences, which is the thing that loses candidates to
   * the competitor who answered first.
   */
  daysToHire: {
    id: "G13",
    label: "Days to hire",
    target: 14,
    direction: "lower_is_better",
    unit: "days",
  },
};

export type GoalVerdict = "met" | "missed" | "unknown";

/**
 * Grade a measured value against its target.
 *
 * `null` in, `"unknown"` out — never `"missed"`. A metric with no data is not a
 * failing metric, and rendering it as one is how a dashboard teaches its reader
 * to ignore the warning colours. This is the same rule the compliance board
 * applies to an empty document register: zero blocks over an empty register
 * means "nothing is being checked", not "everyone is clear".
 */
export function gradeGoal(value: number | null, goal: GoalTarget): GoalVerdict {
  if (value === null || !Number.isFinite(value)) return "unknown";
  return goal.direction === "lower_is_better"
    ? value <= goal.target
      ? "met"
      : "missed"
    : value >= goal.target
      ? "met"
      : "missed";
}

// ── Horizons ─────────────────────────────────────────────────────────────────

/**
 * The dashboard's forward window, in days.
 *
 * `KPI-3` names 90 days twice — contracts expiring and compliance expiries —
 * so it is one constant rather than two literals that can drift apart. The
 * workforce board uses 365 for company accreditations because a trade licence
 * renewal is a multi-week municipality process; the owner dashboard stays at 90
 * for everything, because it is read on a phone and a twelve-month list is not
 * something anybody scans on a phone.
 */
export const DASHBOARD_HORIZON_DAYS = 90;

/** How far back "this week" reaches on the dashboard and in the digest. */
export const DASHBOARD_WEEK_DAYS = 7;

/**
 * The window days-to-hire is measured over, in days.
 *
 * A year rather than the 90 the rest of the dashboard uses, and this is the one
 * place the difference is justified. A maintenance contractor of this size
 * hires a handful of people a year: a 90-day window would put the median over
 * one or two hires most quarters, and a median over one hire is that hire's
 * number wearing a statistic's name. Twelve months is also the period the
 * comparison G13 invites — "are we slower than last year" — is asked about.
 *
 * Rolling, not calendar. A year-to-date window would report "not measured"
 * every January for whoever is reading it on the 3rd.
 */
export const DASHBOARD_HIRING_WINDOW_DAYS = 365;
