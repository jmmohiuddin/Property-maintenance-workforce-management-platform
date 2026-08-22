/**
 * Annual maintenance contracts: what is covered, what is excluded, and when the
 * planned visits fall.
 *
 * `CON-1`…`CON-10`. Three things live here rather than in the database layer,
 * and each for the same reason the working calendar does: they are rules, they
 * are shared by the scheduler, the portal and (eventually) the field app, and a
 * rule implemented twice is two rules that will disagree.
 *
 *  1. **The exclusion set.** `CON-2` requires exclusions to be machine-readable
 *     because `CON-6` depends on them. A prose annexe cannot be evaluated, and
 *     work that cannot be evaluated gets absorbed.
 *  2. **The scope decision.** Given a contract's coverage type, its exclusions
 *     and its remaining entitlement, is this piece of work covered? That
 *     question is asked by the dispatcher, by the technician on site and by the
 *     portal, and it must return the same answer to all three.
 *  3. **The PPM plan.** `CON-3` — a contract generates its own visits for the
 *     full term, against the UAE working calendar, as dated *windows* rather
 *     than fixed appointments.
 *
 * ── WHY THE PLANNER IS PURE ─────────────────────────────────────────────────
 *
 * `planPpmVisits` takes a term, a set of entitlements and a calendar, and
 * returns dates. It touches no database. That is what makes it possible to
 * assert "no planned visit lands inside the summer midday ban" over a whole
 * year of generated dates in a unit test, rather than hoping it holds in
 * production — and the midday ban is a hard block with a named penalty, so
 * hoping is not good enough.
 */

import {
  DEFAULT_CALENDAR,
  fromDubai,
  isInMiddayBan,
  isPublicHoliday,
  isWorkingDay,
  nextWorkingWindow,
  toDubai,
  type WorkingCalendar,
} from "./calendar";

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * The two contract models that actually exist in this market (`CON-1`).
 *
 * They differ in exactly one thing, and it is the thing that decides whether an
 * AMC makes money: who carries parts risk. Everything else — visit frequency,
 * response tier, discount — is negotiable on either.
 */
export type CoverageType = "comprehensive" | "labour_only";

export const COVERAGE_TYPES: readonly CoverageType[] = ["comprehensive", "labour_only"];

export const COVERAGE_TYPE_LABEL: Readonly<Record<CoverageType, string>> = {
  comprehensive: "Comprehensive",
  labour_only: "Labour only",
};

export const COVERAGE_TYPE_DESCRIPTION: Readonly<Record<CoverageType, string>> = {
  comprehensive: "Labour, parts and consumables included, except where excluded below.",
  labour_only: "Labour included. Parts and consumables are quoted and billed separately.",
};

/** Billing frequencies `CON-1` names. Stored on the contract row as text. */
export type BillingFrequency = "monthly" | "quarterly" | "semi_annual" | "annually";

export const BILLING_FREQUENCIES: readonly BillingFrequency[] = [
  "monthly",
  "quarterly",
  "semi_annual",
  "annually",
];

export const BILLING_FREQUENCY_LABEL: Readonly<Record<BillingFrequency, string>> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annual: "Semi-annual",
  annually: "Annual",
};

// ── Exclusions ───────────────────────────────────────────────────────────────

export interface ExclusionDefinition {
  readonly code: string;
  readonly label: string;
  /** Shown verbatim to the customer in the portal, so it is written for them. */
  readonly description: string;
}

/**
 * The standard Dubai AMC exclusion set, named in `CON-2`.
 *
 * These seven are not a house preference — they are what every comprehensive
 * AMC in this market carves out, because each is a component whose replacement
 * cost exceeds a year of contract value. A contract that omits them is not
 * generous, it is mispriced.
 *
 * Codes are stable identifiers and are what `contract_exclusions` stores. The
 * label and description are editable per contract; the code is what `CON-6`
 * matches on, which is the whole reason this is a list of records rather than a
 * paragraph.
 */
export const STANDARD_AMC_EXCLUSIONS: readonly ExclusionDefinition[] = [
  {
    code: "compressor_replacement",
    label: "Compressor replacement",
    description:
      "Replacement of AC compressors. Diagnosis, gas top-up and electrical repairs remain covered.",
  },
  {
    code: "fan_motor_replacement",
    label: "Fan motor replacement",
    description: "Replacement of condenser and evaporator fan motors, indoor or outdoor.",
  },
  {
    code: "concealed_pipe_replacement",
    label: "Concealed pipe replacement",
    description:
      "Replacement of pipework buried in walls, floors or ceilings, including the making good afterwards.",
  },
  {
    code: "waterproofing",
    label: "Waterproofing",
    description: "Waterproofing of roofs, terraces, balconies, wet areas and tanks.",
  },
  {
    code: "pump_replacement",
    label: "Pump replacement",
    description: "Replacement of booster, transfer, drainage, irrigation and pool pumps.",
  },
  {
    code: "rewiring",
    label: "Rewiring",
    description: "Replacement of circuit wiring, distribution boards or main supply cabling.",
  },
  {
    code: "pool_plant",
    label: "Swimming pool plant",
    description: "Pool filtration plant, heaters, chlorinators and pool structure.",
  },
];

export function exclusionDefinition(code: string): ExclusionDefinition | undefined {
  return STANDARD_AMC_EXCLUSIONS.find((e) => e.code === code);
}

// ── The scope decision (CON-6) ───────────────────────────────────────────────

export type ScopeVerdict =
  /** Inside the contract. No charge, no quote. */
  | "covered"
  /** Matches an exclusion. Quotable at the contract discount, never absorbed. */
  | "excluded"
  /** The entitlement for this service is used up for the term. */
  | "entitlement_exhausted"
  /** The service is not one this contract covers at all. */
  | "not_covered"
  /** Labour is covered; the parts on this job are not. */
  | "parts_not_covered";

export interface ScopeInput {
  readonly coverageType: CoverageType;
  /** Catalogue slugs this contract covers. */
  readonly coveredServices: readonly string[];
  /** Exclusion codes recorded against the contract. */
  readonly exclusionCodes: readonly string[];
  readonly serviceSlug: string;
  /** Exclusion codes the operator has identified on this particular job. */
  readonly matchedExclusionCodes?: readonly string[];
  /** True when the work needs parts. Decides `labour_only` outcomes. */
  readonly requiresParts?: boolean;
  /** Null means unlimited. */
  readonly entitlementRemaining?: number | null;
  /** Basis points off the rate card for out-of-scope work under this contract. */
  readonly discountBasisPoints: number;
}

export interface ScopeDecision {
  readonly verdict: ScopeVerdict;
  /** True only for `covered`. Everything else has to be quoted or agreed. */
  readonly isCovered: boolean;
  /** True when `CON-6` requires a quote rather than silent absorption. */
  readonly requiresQuote: boolean;
  /** The exclusion that decided it, where one did. */
  readonly exclusionCode: string | null;
  /** Applied to the quote when `requiresQuote`. Zero when nothing is quotable. */
  readonly discountBasisPoints: number;
  /** Shown to the operator. States the decision and what happens next. */
  readonly reason: string;
}

/**
 * Is this work covered by the contract, and if not, what happens to it?
 *
 * `CON-6` is the single mechanism that stops a comprehensive AMC becoming a
 * loss, and the failure it prevents is not fraud — it is kindness. A technician
 * on site who finds a seized compressor does the decent thing and replaces it,
 * nobody raises a quote, and at renewal the contract shows a margin nobody can
 * explain. So the answer here is never "no": it is always "no, and this is the
 * quote", at a discount the customer already agreed to.
 *
 * Order matters. An exclusion beats a remaining entitlement, because a
 * compressor replacement is excluded whether or not there are visits left; and
 * a service the contract never covered is checked first, because "not in this
 * contract" is a different conversation from "used up".
 */
export function decideScope(input: ScopeInput): ScopeDecision {
  const discount = input.discountBasisPoints;

  if (!input.coveredServices.includes(input.serviceSlug)) {
    return {
      verdict: "not_covered",
      isCovered: false,
      requiresQuote: true,
      exclusionCode: null,
      discountBasisPoints: discount,
      reason:
        "This service is not covered by the contract. Quote it at the contract discount rather " +
        "than carrying it as contract work.",
    };
  }

  // An exclusion the operator identified on this job, intersected with the ones
  // this contract actually carries. A code that is not on the contract does not
  // exclude anything, however standard it is elsewhere.
  const matched = (input.matchedExclusionCodes ?? []).find((c) => input.exclusionCodes.includes(c));
  if (matched) {
    const definition = exclusionDefinition(matched);
    return {
      verdict: "excluded",
      isCovered: false,
      requiresQuote: true,
      exclusionCode: matched,
      discountBasisPoints: discount,
      reason:
        `Excluded by the contract: ${definition?.label ?? matched}. ` +
        "Raise a quote at the contract discount — this cannot be absorbed as contract work.",
    };
  }

  if (input.coverageType === "labour_only" && input.requiresParts === true) {
    return {
      verdict: "parts_not_covered",
      isCovered: false,
      requiresQuote: true,
      exclusionCode: null,
      discountBasisPoints: discount,
      reason:
        "Labour is covered; parts and consumables are billed separately under a labour-only " +
        "contract. Quote the parts at the contract discount.",
    };
  }

  const remaining = input.entitlementRemaining;
  if (remaining !== null && remaining !== undefined && remaining <= 0) {
    return {
      verdict: "entitlement_exhausted",
      isCovered: false,
      requiresQuote: true,
      exclusionCode: null,
      discountBasisPoints: discount,
      reason:
        "The entitlement for this service is used up for the contract term. Further visits are " +
        "quotable at the contract discount.",
    };
  }

  return {
    verdict: "covered",
    isCovered: true,
    requiresQuote: false,
    exclusionCode: null,
    discountBasisPoints: 0,
    reason: "Covered by the contract. No charge.",
  };
}

// ── Contract documents (CON-10) ──────────────────────────────────────────────

/**
 * The kinds of paperwork a contract carries.
 *
 * In `core` rather than in the database layer because it is a vocabulary, not a
 * query — and because the attach form is a client component. Importing it from
 * `@meridian/db` pulled the Postgres driver into the browser bundle and failed
 * the build, which is the practical reason a shared label table belongs on this
 * side of the line.
 */
export const CONTRACT_DOCUMENT_KINDS = [
  "signed_contract",
  "scope_annexe",
  "asset_register",
  "insurance",
  "other",
] as const;

export type ContractDocumentKind = (typeof CONTRACT_DOCUMENT_KINDS)[number];

export const CONTRACT_DOCUMENT_LABEL: Readonly<Record<ContractDocumentKind, string>> = {
  signed_contract: "Signed contract",
  scope_annexe: "Scope annexe",
  asset_register: "Asset register",
  insurance: "Insurance certificate",
  other: "Other",
};

// ── Renewal (CON-8, CON-9) ───────────────────────────────────────────────────

/**
 * The reminder ladder from `CON-9`, in days before expiry.
 *
 * Four reminders rather than one because a 90-day notice is a diary entry and a
 * 7-day notice is a phone call, and the same message at both distances gets
 * ignored at the first and panicked at the last.
 *
 * Descending, so `renewalBand` can take the first that matches.
 */
export const RENEWAL_BANDS = [90, 60, 30, 7] as const;
export type RenewalBand = (typeof RENEWAL_BANDS)[number];

/** The window a renewal enters the pipeline at (`CON-8`). */
export const RENEWAL_PIPELINE_DAYS = 90;

/**
 * Which reminder a contract is due, given days to expiry.
 *
 * Returns the *tightest* band that has been reached, so a contract first seen
 * at 45 days out gets the 60-day reminder rather than silently skipping to 30.
 * Already-expired contracts return the 7-day band — they are past every
 * threshold, and the alternative (null) would make the most urgent case the one
 * nothing fires on.
 *
 * A renewal is a **warning**, not a block. Nothing in this system refuses an
 * action because a contract is expiring; the three hard blocks are an expired
 * blocking document, an expired work permit and the summer midday ban, each
 * with a statutory penalty behind it. A contract renewal has a commercial
 * consequence, and commercial consequences are warned about.
 */
export function renewalBand(daysRemaining: number): RenewalBand | null {
  // Ascending scan of a descending list: the first band still wide enough to
  // contain `daysRemaining` is the tightest one that has been reached.
  return [...RENEWAL_BANDS].reverse().find((b) => daysRemaining <= b) ?? null;
}

/** Percentage of entitlement consumed, for the renewal pipeline (`CON-8`). */
export function utilisationPercent(consumed: number, entitled: number): number {
  if (entitled <= 0) return 0;
  return Math.round((consumed / entitled) * 100);
}

// ── PPM planning (CON-3) ─────────────────────────────────────────────────────

export interface PpmEntitlement {
  readonly serviceSlug: string;
  /** Scheduled visits per service family per year. `CON-2`. */
  readonly visitsPerYear: number;
}

export interface PpmPlanInput {
  readonly termStart: Date;
  readonly termEnd: Date;
  readonly properties: readonly string[];
  readonly entitlements: readonly PpmEntitlement[];
  /**
   * Half-width of the target window, in days. `CON-3` requires windows rather
   * than fixed dates: "a window is what makes a schedule survivable". Seven
   * days either side means a visit missed by a van breakdown on Tuesday is
   * still on schedule on Thursday.
   */
  readonly windowDays?: number;
  /** Dubai wall-clock minute the target instant is placed at. 09:00 default. */
  readonly targetMinuteOfDay?: number;
  readonly calendar?: WorkingCalendar;
}

export interface PlannedVisit {
  readonly propertyId: string;
  readonly serviceSlug: string;
  /** 1-based, within this property and service. Reads as "visit 3 of 4". */
  readonly sequence: number;
  readonly totalForTerm: number;
  /** Always a working instant, never a holiday, never inside the midday ban. */
  readonly dueOn: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
}

export interface PpmPlan {
  readonly visits: readonly PlannedVisit[];
  /**
   * Visits the calendar could not place inside the term.
   *
   * Reported rather than dropped. A visit silently missing from a PPM schedule
   * is the number an OA management company asks for at renewal (`G12`) being
   * quietly wrong in our favour, and that is the one direction it must never be
   * wrong in.
   */
  readonly unplaced: readonly {
    readonly propertyId: string;
    readonly serviceSlug: string;
    readonly sequence: number;
    readonly reason: string;
  }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_PPM_WINDOW_DAYS = 7;
export const DEFAULT_PPM_TARGET_MINUTE = 9 * 60;

/**
 * How many visits a per-year entitlement produces over a term of a given length.
 *
 * Rounded rather than floored: an 18-month contract at four visits a year owes
 * six, and flooring a 13-month contract to four would quietly under-deliver.
 * Always at least one — an entitlement that exists produces a visit.
 */
export function visitsForTerm(visitsPerYear: number, termDays: number): number {
  if (visitsPerYear <= 0 || termDays <= 0) return 0;
  return Math.max(1, Math.round((visitsPerYear * termDays) / 365));
}

/**
 * Place the planned visits for a whole contract term.
 *
 * ── HOW THE DATES ARE CHOSEN ────────────────────────────────────────────────
 *
 * Each visit is placed at the **midpoint of its share of the term**, not at the
 * end of it. Four visits over a year fall in mid-February, mid-May, mid-August
 * and mid-November rather than on the last day of each quarter. Two reasons:
 * end-of-interval placement puts the final visit on the last day of the term,
 * where any slip pushes it outside the contract entirely; and midpoint spacing
 * leaves headroom for the calendar to move a date forward without running out
 * of term.
 *
 * Then each target is snapped forward to the next legal working instant with
 * `nextWorkingWindow(..., { outdoor: true })`. That single call is what
 * guarantees the two properties this function exists to guarantee:
 *
 *   * **Never on a public holiday or a weekend.** `isWorkingDay` is inside it.
 *   * **Never inside the summer midday ban.** `outdoor: true` is not a guess
 *     about the work — it is the conservative reading. A water-tank clean on a
 *     roof and a chiller service on a plant deck are both outdoor, both are
 *     routine PPM, and the penalty for being wrong in the permissive direction
 *     is AED 5,000 per worker capped at AED 50,000 plus a classification
 *     downgrade. A planned visit is planned months ahead and costs nothing to
 *     place at 09:00 instead; there is no reason to spend that risk here.
 *
 * The calendar is passed in rather than defaulted at the call site so that a
 * tenant whose administrator has loaded this year's public holidays
 * (`ADM-10`) gets a plan that respects them. Passing none uses
 * `DEFAULT_CALENDAR`, whose holiday list is deliberately empty — honest about
 * not knowing rather than confidently wrong.
 */
export function planPpmVisits(input: PpmPlanInput): PpmPlan {
  const calendar = input.calendar ?? DEFAULT_CALENDAR;
  const windowDays = input.windowDays ?? DEFAULT_PPM_WINDOW_DAYS;
  const targetMinute = input.targetMinuteOfDay ?? DEFAULT_PPM_TARGET_MINUTE;

  const visits: PlannedVisit[] = [];
  const unplaced: {
    propertyId: string;
    serviceSlug: string;
    sequence: number;
    reason: string;
  }[] = [];

  const termMs = input.termEnd.getTime() - input.termStart.getTime();
  if (termMs <= 0) return { visits, unplaced };

  const termDays = Math.round(termMs / DAY_MS);

  for (const propertyId of input.properties) {
    for (const entitlement of input.entitlements) {
      const total = visitsForTerm(entitlement.visitsPerYear, termDays);
      if (total === 0) continue;

      const intervalMs = termMs / total;
      // Snapping can only move a date forward, so two adjacent targets can land
      // on the same instant if the second falls on a long holiday run. Tracked
      // per (property, service) so visit 3 is never the same date as visit 2.
      let lastPlaced: number | null = null;

      for (let i = 0; i < total; i++) {
        const targetMs = input.termStart.getTime() + intervalMs * (i + 0.5);
        const t = toDubai(new Date(targetMs));
        let candidate = fromDubai(t.year, t.month, t.day, targetMinute);

        if (lastPlaced !== null && candidate.getTime() <= lastPlaced) {
          const previous = toDubai(new Date(lastPlaced));
          candidate = fromDubai(previous.year, previous.month, previous.day + 1, targetMinute);
        }

        const dueOn = nextWorkingWindow(candidate, { outdoor: true, calendar });

        if (dueOn > input.termEnd) {
          unplaced.push({
            propertyId,
            serviceSlug: entitlement.serviceSlug,
            sequence: i + 1,
            reason:
              "The next working day after the target falls outside the contract term. Shorten " +
              "the interval or extend the term.",
          });
          continue;
        }

        lastPlaced = dueOn.getTime();

        visits.push({
          propertyId,
          serviceSlug: entitlement.serviceSlug,
          sequence: i + 1,
          totalForTerm: total,
          dueOn,
          windowStart: new Date(dueOn.getTime() - windowDays * DAY_MS),
          windowEnd: new Date(dueOn.getTime() + windowDays * DAY_MS),
        });
      }
    }
  }

  visits.sort((a, b) => a.dueOn.getTime() - b.dueOn.getTime());
  return { visits, unplaced };
}

/**
 * A planned date that breaks one of the two rules the planner guarantees.
 *
 * Exists so the contract page and the test can assert the same property, rather
 * than the test asserting one thing and the screen showing another. Returns an
 * empty list for a plan produced by `planPpmVisits` against the same calendar —
 * if it ever does not, the planner is wrong and this says which date.
 */
export function ppmCalendarViolations(
  visits: readonly { readonly dueOn: Date; readonly serviceSlug: string }[],
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): readonly { readonly dueOn: Date; readonly serviceSlug: string; readonly reason: string }[] {
  const problems: { dueOn: Date; serviceSlug: string; reason: string }[] = [];

  for (const visit of visits) {
    if (isPublicHoliday(visit.dueOn, calendar)) {
      problems.push({
        dueOn: visit.dueOn,
        serviceSlug: visit.serviceSlug,
        reason: "falls on a public holiday",
      });
      continue;
    }
    if (!isWorkingDay(visit.dueOn, calendar)) {
      problems.push({
        dueOn: visit.dueOn,
        serviceSlug: visit.serviceSlug,
        reason: "falls on a non-working day",
      });
      continue;
    }
    if (isInMiddayBan(visit.dueOn, calendar)) {
      problems.push({
        dueOn: visit.dueOn,
        serviceSlug: visit.serviceSlug,
        reason: `falls inside the summer midday ban — ${calendar.middayBan.penalty}`,
      });
    }
  }

  return problems;
}

// ── PPM compliance (CON-7) ───────────────────────────────────────────────────

/** `G12`. The number an OA management company asks for at renewal. */
export const PPM_COMPLETION_TARGET_PERCENT = 98;

export interface PpmCompletion {
  readonly scheduled: number;
  readonly completed: number;
  readonly overdue: number;
  /** Completed ÷ (completed + overdue), as a whole percent. */
  readonly percent: number;
  readonly meetsTarget: boolean;
}

/**
 * PPM completion, measured against visits that are actually due.
 *
 * The denominator is completed + overdue, **not** every visit in the term. A
 * one-year contract in its first month would otherwise report 8% completion and
 * look like a failing contract, which is the number that trains people to
 * ignore this metric. Only a visit whose window has closed can have been
 * missed.
 */
export function ppmCompletion(input: {
  scheduled: number;
  completed: number;
  overdue: number;
}): PpmCompletion {
  const due = input.completed + input.overdue;
  const percent = due === 0 ? 100 : Math.round((input.completed / due) * 100);
  return {
    scheduled: input.scheduled,
    completed: input.completed,
    overdue: input.overdue,
    percent,
    meetsTarget: percent >= PPM_COMPLETION_TARGET_PERCENT,
  };
}
