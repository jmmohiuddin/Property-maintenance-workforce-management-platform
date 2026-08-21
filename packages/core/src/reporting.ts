import { PPM_COMPLETION_TARGET_PERCENT } from "./contract";
import { toDecimalString } from "./money";

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
 * mistake, which is why the dashboard reports skilled headcount as a range —
 * `lowerBound`/`upperBound` from `assessEmiratisation` — rather than a single
 * confident figure whenever a fact is missing.
 *
 * Only the threshold is defined here. The AED 4,000 salary floor
 * (`EMIRATISATION_SKILLED_WAGE_FLOOR_MINOR`) and the ISCO level list
 * (`ISCO_MAJOR_GROUPS`, `ISCO_SKILLED_MAX_MAJOR_GROUP`) live next to
 * `classifySkilledEmployee` in `employment.ts`, which applies them.
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

// ═══════════════════════════════════════════════════════════════════════════
// INV-17 — the corporate tax support pack, by tax period
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The last day of the last tax period for which Small Business Relief can be
 * elected. PRD §11: "available for periods ending on or before 31 December
 * 2029".
 *
 * A date rather than a year, because the test is on the period's **end**: a
 * business with a financial year ending 30 June has a period running July 2029
 * to June 2030, and that period ends after the line and is therefore outside
 * the scheme even though it begins inside it.
 */
export const SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END = "2029-12-31";

/**
 * One tax period's revenue, as measured.
 *
 * `invoicedMinor` and `creditedMinor` are carried alongside `revenueMinor`
 * rather than folded into it, because "AED 2.9m" and "AED 3.4m invoiced less
 * AED 0.5m credited" are the same number and a completely different
 * conversation with an accountant. A pack that shows only the net invites the
 * question it cannot answer.
 *
 * Every field is VAT-EXCLUSIVE. Small Business Relief is tested on revenue, and
 * VAT collected on behalf of the FTA is not revenue. Naming it in the type is
 * the only place that fact is unmissable.
 */
export interface TaxPeriodRevenue {
  /** The period's label, e.g. "2026". */
  readonly period: string;
  /** First day of the period, `YYYY-MM-DD`, Asia/Dubai. Computed in SQL. */
  readonly startsOn: string;
  /** Last day of the period, inclusive, `YYYY-MM-DD`, Asia/Dubai. */
  readonly endsOn: string;
  /** Issued invoices, tax-exclusive. */
  readonly invoicedMinor: number;
  /** Credit notes issued in the period, tax-exclusive, as a positive number. */
  readonly creditedMinor: number;
  /** `invoicedMinor - creditedMinor`. The figure the AED 3m test is applied to. */
  readonly revenueMinor: number;
  readonly invoices: number;
  readonly creditNotes: number;
  /** Whether the period has ended. A part-year figure is not a final one. */
  readonly complete: boolean;
  /** Days of the period elapsed at the time of measurement, from SQL. */
  readonly elapsedDays: number;
  /** Days in the whole period, from SQL. 365 or 366. */
  readonly totalDays: number;
}

/**
 * Where a period stands with respect to the relief.
 *
 * Five states rather than the three `ReliefState` carries, and the two extra
 * ones are the whole reason `INV-17` is a separate requirement from the meter
 * on the dashboard:
 *
 *  * `disqualified` — this period is under AED 3m, and it does not matter,
 *    because an **earlier** period went over. The relief is gone permanently.
 *    A single-period view cannot say this and will show green forever.
 *  * `unavailable` — the period ends after 31 December 2029, so the scheme no
 *    longer applies to it whatever the revenue is.
 */
export type ReliefStanding =
  | "available"
  | "approaching"
  | "breached"
  | "disqualified"
  | "unavailable";

export interface TaxPeriodPosition {
  readonly period: TaxPeriodRevenue;
  /** The AED 3m arithmetic for this period alone, from the shared function. */
  readonly relief: ReliefPosition;
  readonly standing: ReliefStanding;
  /**
   * The earliest period whose revenue crossed the line, at or before this one.
   * Null while the relief is intact.
   */
  readonly disqualifyingPeriod: string | null;
  /**
   * Revenue at the current run rate, projected to the end of the period, in
   * fils. Null once the period is complete — a finished period has an actual,
   * and showing an extrapolation beside it would invite reading the wrong one —
   * and null before `PROJECTION_MINIMUM_ELAPSED_DAYS`, because a run rate off
   * three weeks of January is arithmetic, not information.
   */
  readonly projectedRevenueMinor: number | null;
}

/**
 * How much of a period has to have elapsed before a run-rate projection is
 * worth printing. One quarter.
 *
 * A projection is the only forward-looking number in this file and it is the
 * one that makes the alert actionable: "AED 1.9m at the end of April" is a fact
 * nobody can act on, and "on course for AED 3.2m by December" is a decision. It
 * is still an extrapolation, so it is labelled as one everywhere it appears and
 * it is withheld until the base period is long enough to mean anything.
 */
export const PROJECTION_MINIMUM_ELAPSED_DAYS = 90;

/**
 * Grade every tax period against the relief, carrying the breach forward.
 *
 * ── WHY THIS IS A FOLD AND NOT A MAP ────────────────────────────────────────
 *
 * `smallBusinessReliefPosition` answers "is this period over the line", which
 * is a question about one period. Eligibility is not: one breach in 2026 ends
 * the relief in 2027, 2028 and 2029 regardless of what those years do. So the
 * periods are walked in order and the earliest breach is carried forward, which
 * is the only way a later period can be told it is disqualified.
 *
 * Input order is not trusted — the list is sorted by `startsOn` here, because a
 * query that returned 2027 before 2026 would otherwise report the relief as
 * intact, and that failure is invisible in the output.
 */
export function taxPeriodPositions(
  periods: readonly TaxPeriodRevenue[],
): readonly TaxPeriodPosition[] {
  const ordered = [...periods].sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0));

  let firstBreach: string | null = null;

  return ordered.map((period) => {
    const relief = smallBusinessReliefPosition(period.revenueMinor);
    const breachedHere = relief.state === "breached";

    // Read before the update, so a period that breaches is "breached" rather
    // than "disqualified by itself" — the difference matters to the reader:
    // one is news, the other is history.
    const inheritedBreach = firstBreach;
    if (breachedHere && firstBreach === null) firstBreach = period.period;

    const standing: ReliefStanding =
      period.endsOn > SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END
        ? "unavailable"
        : inheritedBreach !== null
          ? "disqualified"
          : breachedHere
            ? "breached"
            : relief.state === "approaching"
              ? "approaching"
              : "available";

    return {
      period,
      relief,
      standing,
      disqualifyingPeriod: breachedHere ? period.period : inheritedBreach,
      projectedRevenueMinor: projectedRevenueMinor(period),
    };
  });
}

/**
 * Straight-line run rate to the end of the period, in fils.
 *
 * Integer arithmetic, and the multiplication happens before the division so the
 * rounding happens once at the end rather than compounding. The largest value
 * this can produce is a revenue figure times 366, which stays inside the safe
 * integer range by six orders of magnitude.
 */
function projectedRevenueMinor(period: TaxPeriodRevenue): number | null {
  if (period.complete) return null;
  if (period.elapsedDays < PROJECTION_MINIMUM_ELAPSED_DAYS) return null;
  if (period.elapsedDays <= 0 || period.totalDays <= 0) return null;
  return Math.round((period.revenueMinor * period.totalDays) / period.elapsedDays);
}

/**
 * The pack the screen and the export both read.
 *
 * `current` is resolved by matching the period the measurement date falls in,
 * never by taking the last element. A future-dated invoice puts a later period
 * in the list, and `at(-1)` would then quietly report next year as this year.
 */
export interface CorporateTaxPack {
  readonly periods: readonly TaxPeriodPosition[];
  readonly current: TaxPeriodPosition | null;
  /**
   * True once any period on record has crossed AED 3m. Once this is true it can
   * never become false again, which is exactly the property that makes it worth
   * a field of its own rather than a filter the caller has to remember to run.
   */
  readonly reliefPermanentlyLost: boolean;
  readonly currency: string;
  readonly measuredAt: Date;
}

// ═══════════════════════════════════════════════════════════════════════════
// INV-16 — the accounting export
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A money value on its way into a CSV cell.
 *
 * A wrapper rather than a bare string for two reasons, and the second one is a
 * security bug rather than a style preference:
 *
 *  1. Money is minor units everywhere else in this codebase, and the one place
 *     it becomes a decimal should be the place that writes the file.
 *  2. The formula guard below prefixes any text cell starting with `-` — and a
 *     credit of -1,000.00 rendered as a string would be prefixed too, turning a
 *     number into the text `'-1000.00` in the accountant's import. Passing
 *     amounts through their own type is what makes that impossible rather than
 *     remembered.
 */
export interface CsvAmount {
  readonly minor: number;
}

/** Mark a minor-unit figure as money for the CSV writer. */
export function csvAmount(minor: number): CsvAmount {
  return { minor };
}

export type CsvValue = string | number | boolean | null | undefined | CsvAmount;

function isAmount(value: CsvValue): value is CsvAmount {
  return typeof value === "object" && value !== null && "minor" in value;
}

/**
 * The leading characters that make a spreadsheet treat a cell as a formula.
 *
 * ── WHY AN EXPORT NEEDS THIS ────────────────────────────────────────────────
 *
 * Customer names, invoice notes and payment references in this system come from
 * a public lead form and from operators typing. A customer called
 * `=HYPERLINK("http://…","Click")` is a valid row in the database and an
 * executed formula in the accountant's spreadsheet — CSV injection, and the
 * victim is the person outside the business who was sent the file.
 *
 * Guarded by prefixing an apostrophe, which every spreadsheet reads as "this is
 * text". Applied to text cells only; amounts are `CsvAmount` and never pass
 * through here, which is why a negative number survives intact.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/** One CSV cell, RFC 4180 quoted, formula-guarded. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  if (isAmount(value)) return toDecimalString(value.minor);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";

  const guarded = CSV_FORMULA_LEAD.test(value) ? `'${value}` : value;
  const needsQuotes = /[",\r\n]/.test(guarded) || guarded !== guarded.trim();
  return needsQuotes ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * CRLF, not LF.
 *
 * RFC 4180 says CRLF, and the audience for this file is an accountant opening
 * it in Excel on Windows. Excel copes with LF; older imports and a surprising
 * number of accounting packages do not, and a file that imports as one giant
 * row is indistinguishable from a broken export to the person receiving it.
 */
export const CSV_LINE_ENDING = "\r\n";

export function csvLine(cells: readonly CsvValue[]): string {
  return cells.map(csvField).join(",");
}

/**
 * A named table on its way out of the system.
 *
 * `rowCount` is a field rather than something the caller derives from
 * `rows.length`, and the two are asserted equal in the test. It exists so that
 * a truncated export is **visibly** truncated: the count is written into the
 * file's own trailer, so a file that stops at row 200 says "200" next to a
 * range the accountant can check, instead of looking like a quiet month.
 */
export interface ExportTable {
  readonly name: string;
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CsvValue[])[];
  readonly rowCount: number;
}

/**
 * Serialise a table to CSV, with a trailer that states how many rows it holds.
 *
 * ── WHY THERE IS A TRAILER AT ALL ───────────────────────────────────────────
 *
 * Silent truncation is the failure mode this whole export is written against,
 * and it has one property that makes it lethal: the output of a truncated
 * export is a perfectly well-formed file. Nothing about 200 tidy rows says the
 * 201st was dropped. So the file carries its own count, and the count comes
 * from the query rather than from the array — if the two ever disagree, the
 * file says so on its last line rather than balancing three fils short in
 * somebody's ledger nine months later.
 */
export function toCsv(table: ExportTable): string {
  const lines: string[] = [csvLine(table.columns)];
  for (const row of table.rows) lines.push(csvLine(row));
  lines.push("");
  lines.push(csvLine([`# ${table.name}: ${table.rowCount} rows`]));
  return lines.join(CSV_LINE_ENDING) + CSV_LINE_ENDING;
}

// ── The chart of accounts the journal maps onto ──────────────────────────────

/**
 * The default account codes the general journal is written against.
 *
 * ── WHY DEFAULTS, AND WHY THAT IS HONEST ────────────────────────────────────
 *
 * These are not this company's account codes, because this system does not know
 * them — the accountant's ledger lives in the accountant's software and nothing
 * here has ever seen its chart of accounts. Inventing a lookup table that the
 * operator has to maintain, and that would be wrong the first time the
 * accountant renumbered anything, would be worse than a documented default: a
 * remapping step every accountant already performs on every import becomes an
 * invisible mismatch instead.
 *
 * So the export states its assumption in the file itself. The account NAME
 * travels beside the code in every row precisely so the remapping can be done
 * by reading rather than by guessing.
 *
 * The codes follow the conventional block layout — 1000s assets, 2000s
 * liabilities, 4000s income — which is what makes them recognisable to whoever
 * opens the file.
 */
export interface LedgerAccount {
  readonly code: string;
  readonly name: string;
}

export const LEDGER_ACCOUNTS = {
  /*
   * Every account name says whether the amounts posted to it are VAT-inclusive
   * or VAT-exclusive, and that is not decoration. A journal's debit and credit
   * columns necessarily hold both — the receivable is gross, the revenue is net
   * — so the column heading cannot carry the distinction the way it does in the
   * listing exports, and the account name is the only place left that can. An
   * accountant importing a "Revenue" line without knowing which one it is has
   * to ask, and the answer arrives after the return is filed.
   */
  receivable: { code: "1100", name: "Accounts receivable (VAT-inclusive)" },
  bank: { code: "1010", name: "Bank (VAT-inclusive receipts)" },
  cash: { code: "1000", name: "Cash (VAT-inclusive receipts)" },
  revenue: { code: "4000", name: "Revenue (VAT-exclusive)" },
  /** Output tax collected on behalf of the FTA. A liability, never income. */
  vatOutput: { code: "2100", name: "VAT payable (output tax)" },
  /*
   * Where a settlement that was not cash goes.
   *
   * `payment_method` includes `credit_note`, and a receipt recorded under it
   * did not put money in the bank — the credit note that offset the invoice
   * already credited receivables in its own posting. Sending it to Bank would
   * claim cash that never arrived and credit receivables twice. It goes to a
   * clearing account instead, where it is visible and the accountant clears it
   * against the credit note rather than discovering an unexplained bank
   * balance.
   */
  settlement: { code: "1150", name: "Settlement clearing (non-cash)" },
  /**
   * Where a document whose stored total does not equal taxable + tax puts its
   * difference. It should never be used; see `documentJournalLines`.
   */
  rounding: { code: "9999", name: "Rounding difference" },
} as const satisfies Record<string, LedgerAccount>;

/**
 * One side of one double-entry posting.
 *
 * Debit and credit are separate fields holding a non-negative number, rather
 * than one signed `amountMinor`. That is how every accounting import expects a
 * journal, and it is also the shape that makes the balance check meaningful:
 * summing a signed column to zero proves nothing about which side each posting
 * landed on, and a journal with the signs flipped on both halves of an entry
 * balances perfectly while reversing the business's revenue.
 */
export interface JournalLine {
  /** `YYYY-MM-DD`, Asia/Dubai, computed in SQL. */
  readonly date: string;
  readonly reference: string;
  readonly documentType: "invoice" | "credit_note" | "payment";
  readonly accountCode: string;
  readonly accountName: string;
  readonly contact: string;
  readonly description: string;
  readonly debitMinor: number;
  readonly creditMinor: number;
  /** UNCL5305: "S" standard-rated, "Z" zero-rated, "E" exempt. Empty on cash. */
  readonly taxCode: string;
  readonly currency: string;
}

/** A sales document reduced to the six facts a journal posting needs. */
export interface JournalDocument {
  readonly reference: string;
  readonly date: string;
  readonly contact: string;
  readonly currency: string;
  readonly taxCode: string;
  /** Tax-EXCLUSIVE consideration. */
  readonly taxableMinor: number;
  readonly taxMinor: number;
  /** Tax-INCLUSIVE total, as stored on the document. */
  readonly totalMinor: number;
}

/**
 * The postings for one invoice or one credit note.
 *
 * An invoice: debit receivables with the gross, credit revenue with the net and
 * the VAT account with the tax. A credit note is the same three postings with
 * the sides swapped — which is why one function serves both and there is no
 * second copy of the arithmetic to get out of step.
 *
 * ── THE ROUNDING LINE ───────────────────────────────────────────────────────
 *
 * `@meridian/core`'s document validation already refuses a document where
 * `total !== taxable + tax`, so in practice the difference is always zero and
 * this line is never written. It exists because the alternative, when a
 * historical row does disagree, is a journal that does not balance — and an
 * unbalanced journal is rejected by the accounting package with an error the
 * operator cannot act on. A visible AED 0.01 on a "rounding difference" account
 * is a question somebody can answer.
 */
export function documentJournalLines(
  doc: JournalDocument,
  kind: "invoice" | "credit_note",
): readonly JournalLine[] {
  const invoice = kind === "invoice";
  const base = {
    date: doc.date,
    reference: doc.reference,
    documentType: kind,
    contact: doc.contact,
    currency: doc.currency,
  } as const;

  const description = invoice ? `Invoice ${doc.reference}` : `Credit note ${doc.reference}`;
  const side = (minor: number, debit: boolean) =>
    debit ? { debitMinor: minor, creditMinor: 0 } : { debitMinor: 0, creditMinor: minor };

  const lines: JournalLine[] = [
    {
      ...base,
      accountCode: LEDGER_ACCOUNTS.receivable.code,
      accountName: LEDGER_ACCOUNTS.receivable.name,
      description,
      taxCode: "",
      ...side(doc.totalMinor, invoice),
    },
    {
      ...base,
      accountCode: LEDGER_ACCOUNTS.revenue.code,
      accountName: LEDGER_ACCOUNTS.revenue.name,
      description,
      taxCode: doc.taxCode,
      ...side(doc.taxableMinor, !invoice),
    },
    {
      ...base,
      accountCode: LEDGER_ACCOUNTS.vatOutput.code,
      accountName: LEDGER_ACCOUNTS.vatOutput.name,
      description,
      taxCode: doc.taxCode,
      ...side(doc.taxMinor, !invoice),
    },
  ];

  const difference = doc.totalMinor - (doc.taxableMinor + doc.taxMinor);
  if (difference !== 0) {
    lines.push({
      ...base,
      accountCode: LEDGER_ACCOUNTS.rounding.code,
      accountName: LEDGER_ACCOUNTS.rounding.name,
      description: `${description} — stored total differs from taxable + tax`,
      taxCode: "",
      // On an invoice a positive difference means the gross debit exceeds the
      // two credits, so the balancing posting is a credit. On a credit note
      // every side is the other way round, hence the second branch.
      ...side(Math.abs(difference), invoice ? difference < 0 : difference > 0),
    });
  }

  return lines;
}

export interface JournalPayment {
  readonly reference: string;
  readonly date: string;
  readonly contact: string;
  readonly currency: string;
  readonly amountMinor: number;
  /** The `payment_method` enum value. Only "cash" changes the account. */
  readonly method: string;
  readonly invoiceReference: string;
}

/**
 * The postings for one receipt: debit the bank, credit receivables.
 *
 * No VAT line. The tax was accounted for when the invoice was issued — this
 * business accounts on an accrual basis, which is what the invoice postings
 * above already assume — and posting output tax a second time on the receipt
 * would double the VAT return.
 */
export function paymentJournalLines(payment: JournalPayment): readonly JournalLine[] {
  const account =
    payment.method === "cash"
      ? LEDGER_ACCOUNTS.cash
      : payment.method === "credit_note"
        ? LEDGER_ACCOUNTS.settlement
        : LEDGER_ACCOUNTS.bank;
  const base = {
    date: payment.date,
    reference: payment.reference,
    documentType: "payment",
    contact: payment.contact,
    currency: payment.currency,
    description: `Receipt against ${payment.invoiceReference}`,
    taxCode: "",
  } as const;

  return [
    {
      ...base,
      accountCode: account.code,
      accountName: account.name,
      debitMinor: payment.amountMinor,
      creditMinor: 0,
    },
    {
      ...base,
      accountCode: LEDGER_ACCOUNTS.receivable.code,
      accountName: LEDGER_ACCOUNTS.receivable.name,
      debitMinor: 0,
      creditMinor: payment.amountMinor,
    },
  ];
}

/**
 * Total debits and total credits over a journal.
 *
 * The one assertion that decides whether this export is importable at all: an
 * accounting package rejects an unbalanced journal outright. Returned as a pair
 * rather than a boolean so a failing export can say by how much.
 */
export function journalTotals(lines: readonly JournalLine[]): {
  debitMinor: number;
  creditMinor: number;
  balanced: boolean;
} {
  let debitMinor = 0;
  let creditMinor = 0;
  for (const line of lines) {
    debitMinor += line.debitMinor;
    creditMinor += line.creditMinor;
  }
  return { debitMinor, creditMinor, balanced: debitMinor === creditMinor };
}
