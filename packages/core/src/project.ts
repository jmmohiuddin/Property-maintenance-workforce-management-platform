/**
 * Projects: the vocabulary, the status graph and the money rules — `PRJ-1`…`PRJ-9`.
 *
 * Lives in `core` for the same reason `work.ts` does: it is pure, and a client
 * component that renders a status chip or a retention figure must be able to
 * import it without dragging the Postgres driver into the browser bundle.
 *
 * ── WHY A PROJECT IS NOT A BIG JOB ──────────────────────────────────────────
 *
 * A `Job` is one visit's worth of work with one invoice at the end of it. A
 * fit-out is eight weeks, five trades, four staged payments and a snag list,
 * and the thing that breaks first if you model it as a job is the money: the
 * invoice model is one job, one invoice, and a milestone-billed contract needs
 * four invoices against no completed job at all. That is `PRJ-3`, and it is the
 * reason this module exists rather than a `is_big` flag on `jobs`.
 *
 * ── THE FOUR NUMBERS THAT DECIDE WHETHER A FIT-OUT MAKES MONEY ──────────────
 *
 * Contract value, approved variations, retention withheld, and cost. Three of
 * them are invisible in most contractors' systems and all three run in the
 * same direction — they make the job look more profitable than it is:
 *
 *   * **Unrecorded variations** (`PRJ-4`) are work done and never billed. The
 *     standard way a fit-out contractor loses money is not a bad price; it is
 *     forty small changes nobody wrote down.
 *   * **Retention** (`PRJ-5`) is 5–10% of every invoice that the client keeps.
 *     It is already earned revenue sitting in someone else's bank account, and
 *     it is released only if somebody asks. Retention nobody chases is a gift.
 *   * **Cost** (`PRJ-8`) is the one nothing else in this system records at all.
 *
 * Every rule below exists to keep one of those four visible.
 */

import { UserFacingError } from "./work";
import { addDaysToDate, daysBetweenDates } from "./invoice";

// ── PRJ-1: the project status machine ────────────────────────────────────────

export type ProjectStatus =
  | "quoted"
  | "awarded"
  | "mobilising"
  | "on_site"
  | "snagging"
  | "practical_completion"
  | "defects_liability"
  | "closed"
  | "cancelled";

/**
 * Permitted transitions.
 *
 * Written out rather than derived from the order, because the graph is not the
 * straight line the requirement's arrow notation suggests:
 *
 *   * `snagging` and `on_site` go both ways. A snag inspection that finds
 *     structural work outstanding sends the project back on site, and a machine
 *     that cannot express that gets worked around by recording practical
 *     completion early — which is precisely the record `PRJ-7` depends on.
 *   * `practical_completion` cannot be reversed. It starts the defects
 *     liability clock, releases the first half of retention and is usually a
 *     certificate signed by the client's consultant. Un-signing it is a
 *     conversation, not a status change.
 *   * `cancelled` is reachable up to the point the client takes possession and
 *     not after. A project at practical completion has been handed over; what
 *     happens next is a dispute or a claim, not a cancellation.
 *
 * `quoted → cancelled` is the lost tender, and it is the most common ending of
 * all.
 */
const PROJECT_TRANSITIONS: Readonly<Record<ProjectStatus, readonly ProjectStatus[]>> = {
  quoted: ["awarded", "cancelled"],
  awarded: ["mobilising", "cancelled"],
  mobilising: ["on_site", "awarded", "cancelled"],
  on_site: ["snagging", "practical_completion", "cancelled"],
  snagging: ["on_site", "practical_completion", "cancelled"],
  practical_completion: ["defects_liability"],
  defects_liability: ["closed"],
  closed: [],
  cancelled: [],
};

export const ALL_PROJECT_STATUSES: readonly ProjectStatus[] = [
  "quoted",
  "awarded",
  "mobilising",
  "on_site",
  "snagging",
  "practical_completion",
  "defects_liability",
  "closed",
  "cancelled",
];

/** Statuses where the project is live work somebody is accountable for today. */
export const OPEN_PROJECT_STATUSES: readonly ProjectStatus[] = [
  "quoted",
  "awarded",
  "mobilising",
  "on_site",
  "snagging",
];

export const PROJECT_STATUS_LABEL: Readonly<Record<ProjectStatus, string>> = {
  quoted: "Quoted",
  awarded: "Awarded",
  mobilising: "Mobilising",
  on_site: "On site",
  snagging: "Snagging",
  practical_completion: "Practical completion",
  defects_liability: "Defects liability",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function canTransitionProject(from: ProjectStatus, to: ProjectStatus): boolean {
  return PROJECT_TRANSITIONS[from].includes(to);
}

export function allowedProjectTransitions(from: ProjectStatus): readonly ProjectStatus[] {
  return PROJECT_TRANSITIONS[from];
}

export class InvalidProjectTransitionError extends UserFacingError {
  constructor(
    readonly from: ProjectStatus,
    readonly to: ProjectStatus,
  ) {
    super(
      `Cannot move a project from "${PROJECT_STATUS_LABEL[from]}" to ` +
        `"${PROJECT_STATUS_LABEL[to]}". Allowed: ` +
        `${PROJECT_TRANSITIONS[from].map((s) => PROJECT_STATUS_LABEL[s]).join(", ") || "none, this is a terminal state"}.`,
    );
    this.name = "InvalidProjectTransitionError";
  }
}

// ── PRJ-2: phases ────────────────────────────────────────────────────────────

export type PhaseStatus = "planned" | "in_progress" | "complete" | "cancelled";

export const PHASE_STATUS_LABEL: Readonly<Record<PhaseStatus, string>> = {
  planned: "Planned",
  in_progress: "In progress",
  complete: "Complete",
  cancelled: "Cancelled",
};

/** Weights are basis points, so a whole project is 10,000. */
export const FULL_WEIGHT_BASIS_POINTS = 10_000;

export interface PhaseWeight {
  readonly weightBasisPoints: number;
  readonly percentComplete: number;
}

/**
 * How complete the project is, as a percentage, weighted by phase.
 *
 * Weighted rather than counted, because phases are not the same size: first fix
 * is six weeks and handover cleaning is a day, and a project reported as "four
 * of eight phases done, so 50%" is one where the schedule is about to be a
 * surprise. Cancelled phases are excluded from both sides — a phase descoped
 * mid-project must not drag the percentage down forever.
 *
 * Returns null when there is nothing to weigh. A project with no phases is not
 * 0% complete; it is a project whose plan has not been entered, and showing 0%
 * would make an unplanned project and an unstarted one look identical.
 */
export function weightedCompletionPercent(
  phases: readonly PhaseWeight[],
): number | null {
  const totalWeight = phases.reduce((sum, p) => sum + p.weightBasisPoints, 0);
  if (phases.length === 0 || totalWeight <= 0) return null;

  const earned = phases.reduce(
    (sum, p) => sum + p.weightBasisPoints * Math.min(100, Math.max(0, p.percentComplete)),
    0,
  );
  return Math.round(earned / totalWeight);
}

/**
 * Whether the phase weights add up.
 *
 * Deliberately a *warning* the caller renders, not a refusal. Phases are
 * entered one at a time and a plan is incomplete for as long as it is being
 * typed; refusing the fourth phase because the first three sum to 7,500 would
 * make the screen unusable. What must not happen is the plan staying at 7,500
 * silently, because then every completion percentage above is quietly computed
 * against three quarters of the job.
 */
export function phaseWeightGap(phases: readonly { weightBasisPoints: number }[]): number {
  return FULL_WEIGHT_BASIS_POINTS - phases.reduce((sum, p) => sum + p.weightBasisPoints, 0);
}

// ── PRJ-3: milestone billing ─────────────────────────────────────────────────

export type MilestoneTrigger = "date" | "percent_complete" | "client_sign_off";

export const MILESTONE_TRIGGERS: readonly MilestoneTrigger[] = [
  "date",
  "percent_complete",
  "client_sign_off",
];

export const MILESTONE_TRIGGER_LABEL: Readonly<Record<MilestoneTrigger, string>> = {
  date: "Date reached",
  percent_complete: "Percentage complete",
  client_sign_off: "Client sign-off",
};

export type MilestoneStatus = "pending" | "reached" | "invoiced" | "cancelled";

export const MILESTONE_STATUS_LABEL: Readonly<Record<MilestoneStatus, string>> = {
  pending: "Pending",
  reached: "Reached, not yet invoiced",
  invoiced: "Invoiced",
  cancelled: "Cancelled",
};

export interface MilestoneTriggerState {
  readonly kind: MilestoneTrigger;
  readonly triggerOn: string | null;
  readonly triggerPercent: number | null;
}

/**
 * Whether a milestone's trigger condition is objectively met.
 *
 * Only two of the three triggers can be evaluated by the system at all, and
 * saying so out loud is the point of this function returning `null` for the
 * third. A **client sign-off** is a signature on a certificate: no query can
 * decide it, and a system that pretended to would either invoice work the
 * client has not accepted or hide the fact that it is guessing. So sign-off
 * milestones are reached by a person recording the sign-off, and this returns
 * null to mean "not mine to judge" rather than false, which would read on
 * screen as "not yet".
 */
export function milestoneTriggerMet(
  trigger: MilestoneTriggerState,
  context: { readonly today: string; readonly percentComplete: number | null },
): boolean | null {
  switch (trigger.kind) {
    case "date":
      if (!trigger.triggerOn) return null;
      return daysBetweenDates(trigger.triggerOn, context.today) >= 0;
    case "percent_complete":
      if (trigger.triggerPercent === null || context.percentComplete === null) return null;
      return context.percentComplete >= trigger.triggerPercent;
    case "client_sign_off":
      return null;
  }
}

// ── PRJ-4: variation orders ──────────────────────────────────────────────────

export type VariationState = "draft" | "submitted" | "approved" | "rejected" | "withdrawn";

export const VARIATION_STATES: readonly VariationState[] = [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "withdrawn",
];

export const VARIATION_STATE_LABEL: Readonly<Record<VariationState, string>> = {
  draft: "Draft",
  submitted: "Submitted to client",
  approved: "Approved",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/**
 * States where the work may already be happening and the money is not secured.
 *
 * This is the set `PRJ-4` calls "visible and totalled separately". A variation
 * in one of these states is instructed work with no approval behind it, and the
 * whole reason the requirement exists is that it is invisible everywhere else:
 * it does not appear in the contract value, it does not appear in an invoice,
 * and it does appear on the site as labour and material going out of the door.
 */
export const UNAPPROVED_VARIATION_STATES: readonly VariationState[] = ["draft", "submitted"];

const VARIATION_TRANSITIONS: Readonly<Record<VariationState, readonly VariationState[]>> = {
  draft: ["submitted", "withdrawn"],
  // A variation can be approved without a formal submission step — verbally on
  // site, then written up. Refusing that would mean the written-up version
  // never gets entered, which is the failure this whole table exists to stop.
  submitted: ["approved", "rejected", "withdrawn"],
  approved: [],
  rejected: ["submitted", "withdrawn"],
  withdrawn: [],
};

export function canTransitionVariation(from: VariationState, to: VariationState): boolean {
  return VARIATION_TRANSITIONS[from].includes(to);
}

export class InvalidVariationTransitionError extends UserFacingError {
  constructor(from: VariationState, to: VariationState) {
    super(
      `Cannot move a variation from "${VARIATION_STATE_LABEL[from]}" to ` +
        `"${VARIATION_STATE_LABEL[to]}". Allowed: ` +
        `${VARIATION_TRANSITIONS[from].map((s) => VARIATION_STATE_LABEL[s]).join(", ") || "none, this is final"}.`,
    );
    this.name = "InvalidVariationTransitionError";
  }
}

// ── PRJ-5: retention ─────────────────────────────────────────────────────────

/** The market norm. 5% is common on fit-out, 10% on main contracts. */
export const DEFAULT_RETENTION_BASIS_POINTS = 500;
export const MAX_RETENTION_BASIS_POINTS = 1_000;

/** The defects liability period the market defaults to: twelve months. */
export const DEFAULT_DEFECTS_LIABILITY_DAYS = 365;

/**
 * The two moments retention is released, and the share released at each.
 *
 * Half at practical completion, half at the end of the defects liability
 * period, which is the standard split in the UAE market. Basis points rather
 * than a fraction so the arithmetic stays integer: half of an odd number of
 * fils has to go somewhere deterministic, and `Math.round` on a float is not
 * where it should be decided.
 */
export const PRACTICAL_COMPLETION_RELEASE_BASIS_POINTS = 5_000;

export type RetentionStage = "practical_completion" | "defects_liability";

export const RETENTION_STAGES: readonly RetentionStage[] = [
  "practical_completion",
  "defects_liability",
];

export const RETENTION_STAGE_LABEL: Readonly<Record<RetentionStage, string>> = {
  practical_completion: "On practical completion",
  defects_liability: "On end of defects liability",
};

export type RetentionStatus = "held" | "due" | "released" | "written_off";

export const RETENTION_STATUS_LABEL: Readonly<Record<RetentionStatus, string>> = {
  held: "Held",
  due: "Due for release",
  released: "Released",
  written_off: "Written off",
};

export interface RetentionSplit {
  readonly totalMinor: number;
  readonly practicalCompletionMinor: number;
  readonly defectsLiabilityMinor: number;
}

/**
 * How much of an invoice is withheld, and how that splits across the two
 * releases.
 *
 * Applied to the **tax-exclusive** amount. Retention is a deduction from the
 * consideration for the work, not from the VAT — the VAT was accounted for on
 * the full value at the tax point and is owed to the FTA whether or not the
 * client has paid it yet. Withholding a percentage of the gross would under-
 * declare output tax, which is the expensive direction of this error.
 *
 * The remainder goes to the *second* release, deliberately. A stray fil in the
 * half that comes back a year later is the one a contractor is least likely to
 * chase, so it is the half that must not be short.
 */
export function retentionSplit(netMinor: number, basisPoints: number): RetentionSplit {
  const bp = Math.max(0, Math.min(MAX_RETENTION_BASIS_POINTS, Math.round(basisPoints)));
  const totalMinor = Math.round((netMinor * bp) / 10_000);
  const practicalCompletionMinor = Math.floor(
    (totalMinor * PRACTICAL_COMPLETION_RELEASE_BASIS_POINTS) / 10_000,
  );

  return {
    totalMinor,
    practicalCompletionMinor,
    defectsLiabilityMinor: totalMinor - practicalCompletionMinor,
  };
}

/**
 * When the end of the defects liability period falls.
 *
 * Plain calendar arithmetic on `YYYY-MM-DD`, never a `Date`. A day-valued
 * column round-tripped through a JS `Date` shifts by the local UTC offset, and
 * for this value the shift runs in the direction that reports a retention
 * release as not yet due on the day it becomes due — which, given that the sum
 * has been sitting in the client's account for a year already, is the last
 * place to lose a day.
 */
export function defectsLiabilityEnd(practicalCompletionOn: string, days: number): string {
  return addDaysToDate(practicalCompletionOn, Math.max(0, Math.round(days)));
}

/** Days until a retention release falls due. Negative means it is overdue. */
export function retentionDaysToDue(dueOn: string, today: string): number {
  return daysBetweenDates(today, dueOn);
}

/** How far ahead of its due date a retention release starts being chased. */
export const RETENTION_REMINDER_LEAD_DAYS = 14;

// ── PRJ-6: permits ───────────────────────────────────────────────────────────

export type PermitStatus = "not_applied" | "applied" | "approved" | "rejected" | "expired";

export const PERMIT_STATUSES: readonly PermitStatus[] = [
  "not_applied",
  "applied",
  "approved",
  "rejected",
  "expired",
];

export const PERMIT_STATUS_LABEL: Readonly<Record<PermitStatus, string>> = {
  not_applied: "Not applied for",
  applied: "Applied",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
};

/**
 * The permitting authorities a Dubai fit-out actually deals with.
 *
 * A controlled list rather than a text box, for the reason every other
 * vocabulary in this system is one: "DM", "Dubai Municipality" and "Dubai
 * Muncipality" are three answers to a question that has one, and the question —
 * which authority is holding this project up — is asked across rows.
 *
 * Copied into migration 0029 and into `seed.ts`, because a vocabulary table
 * that ships empty leaves the operator an empty picker, and an empty picker is
 * free text with extra steps.
 */
export const STANDARD_PERMIT_AUTHORITIES: readonly {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly sortOrder: number;
}[] = [
  {
    code: "dm",
    label: "Dubai Municipality",
    description:
      "Building completion, fit-out and modification permits for most of Dubai outside the free zones.",
    sortOrder: 10,
  },
  {
    code: "dda",
    label: "Dubai Development Authority (DDA)",
    description:
      "The authority for TECOM, Media City, Internet City, Studio City and Dubai Design District.",
    sortOrder: 20,
  },
  {
    code: "trakhees",
    label: "Trakhees (Ports, Customs and Free Zone Corporation)",
    description: "Palm Jumeirah, Dubai World Central, Jebel Ali and the other PCFC jurisdictions.",
    sortOrder: 30,
  },
  {
    code: "dewa",
    label: "Dubai Electricity and Water Authority (DEWA)",
    description:
      "Electrical connection, meter, and any work on the incoming supply. NOC before energisation.",
    sortOrder: 40,
  },
  {
    code: "dcd",
    label: "Dubai Civil Defence",
    description:
      "Fire and life safety approval — detection, suppression, escape routes. The approval most often on the critical path.",
    sortOrder: 50,
  },
  {
    code: "building_management",
    label: "Building management / owners association",
    description:
      "Not a government authority, but the fit-out NOC, working-hours consent and lift booking that gate site access.",
    sortOrder: 60,
  },
];

export interface PermitState {
  readonly isRequired: boolean;
  readonly status: PermitStatus;
  readonly expiresOn: string | null;
}

/**
 * Permits that stand between this project and `on_site` (`PRJ-6`).
 *
 * A permit counts as blocking when it is flagged required and is not approved,
 * and *also* when it is approved but has expired. The second case is the one
 * worth the extra line: an approval with a date on it is exactly the record an
 * operator glances at, sees the word "Approved", and stops reading.
 *
 * Comparison is between `YYYY-MM-DD` strings, which is why `expiresOn` is
 * carried as a string all the way from the column. Through a `Date` it shifts
 * by the local offset, and here that reports an expired permit as still valid —
 * for a document whose absence stops the site, in front of an inspector.
 */
export function blockingPermits<T extends PermitState>(
  permits: readonly T[],
  today: string,
): readonly T[] {
  return permits.filter((p) => {
    if (!p.isRequired) return false;
    if (p.status !== "approved") return true;
    return p.expiresOn !== null && p.expiresOn < today;
  });
}

// ── PRJ-7: snags ─────────────────────────────────────────────────────────────

export type SnagSeverity = "critical" | "major" | "minor";

export const SNAG_SEVERITIES: readonly SnagSeverity[] = ["critical", "major", "minor"];

export const SNAG_SEVERITY_LABEL: Readonly<Record<SnagSeverity, string>> = {
  critical: "Critical",
  major: "Major",
  minor: "Minor",
};

export type SnagStatus = "open" | "in_progress" | "closed" | "rejected";

export const SNAG_STATUS_LABEL: Readonly<Record<SnagStatus, string>> = {
  open: "Open",
  in_progress: "In progress",
  closed: "Closed",
  rejected: "Rejected",
};

/** Snags still owed. `rejected` is a decision, `closed` is evidence. */
export const OPEN_SNAG_STATUSES: readonly SnagStatus[] = ["open", "in_progress"];

export type SnagParty = "us" | "subcontractor" | "client" | "consultant" | "supplier";

export const SNAG_PARTY_LABEL: Readonly<Record<SnagParty, string>> = {
  us: "Us",
  subcontractor: "Subcontractor",
  client: "Client",
  consultant: "Consultant",
  supplier: "Supplier",
};

/**
 * The trades a snag gets assigned to.
 *
 * Seeded, and matched to the catalogue service slugs where one exists, so that
 * "who has the most open snags" and "which trade do we send" are the same
 * answer. The three with no service slug — glazing, fire and life safety, and
 * aluminium work — are subcontracted rather than sold, and they are on the list
 * anyway because they are where fit-out snags actually accumulate.
 */
export const STANDARD_SNAG_TRADES: readonly {
  readonly code: string;
  readonly label: string;
  readonly serviceSlug: string | null;
  readonly sortOrder: number;
}[] = [
  { code: "electrical", label: "Electrical", serviceSlug: "electrical-fittings-repair", sortOrder: 10 },
  { code: "plumbing", label: "Plumbing and drainage", serviceSlug: "plumbing-sanitary", sortOrder: 20 },
  { code: "hvac", label: "HVAC", serviceSlug: "hvac-installation-maintenance", sortOrder: 30 },
  { code: "joinery", label: "Joinery and carpentry", serviceSlug: "carpentry", sortOrder: 40 },
  { code: "painting", label: "Painting and decoration", serviceSlug: "painting", sortOrder: 50 },
  { code: "flooring", label: "Flooring", serviceSlug: "tiling", sortOrder: 60 },
  { code: "ceiling", label: "Ceilings and partitions", serviceSlug: "false-ceilings", sortOrder: 70 },
  { code: "glazing", label: "Glazing and aluminium", serviceSlug: null, sortOrder: 80 },
  { code: "fire_safety", label: "Fire and life safety", serviceSlug: null, sortOrder: 90 },
  { code: "cleaning", label: "Cleaning and making good", serviceSlug: "building-cleaning", sortOrder: 100 },
];

/**
 * `PRJ-7`'s hard rule: practical completion cannot be recorded with open
 * critical snags.
 *
 * Only *critical*. That is a deliberate line, not a softening. Practical
 * completion means the client can occupy and use the premises for their
 * intended purpose; it has never meant the snag list is empty, and a rule that
 * demanded an empty list would be worked around within a week by downgrading
 * every snag to minor — which would destroy the one field that makes the list
 * worth keeping.
 *
 * A critical snag is one that stops occupation or is unsafe: no fire alarm
 * coverage, a live board with no cover, a leaking riser. Handing those over is
 * not a commercial argument, so this is a refusal rather than a warning.
 */
export function criticalSnagsBlockingCompletion<
  T extends { readonly severity: SnagSeverity; readonly status: SnagStatus },
>(snags: readonly T[]): readonly T[] {
  return snags.filter(
    (s) => s.severity === "critical" && OPEN_SNAG_STATUSES.includes(s.status),
  );
}

// ── PRJ-8: cost and margin ───────────────────────────────────────────────────

export type CostCategory = "labour" | "materials" | "subcontractor" | "plant_hire" | "other";

export const COST_CATEGORIES: readonly CostCategory[] = [
  "labour",
  "materials",
  "subcontractor",
  "plant_hire",
  "other",
];

export const COST_CATEGORY_LABEL: Readonly<Record<CostCategory, string>> = {
  labour: "Labour",
  materials: "Materials at cost",
  subcontractor: "Subcontractor",
  plant_hire: "Plant hire",
  other: "Other",
};

export interface ProjectMargin {
  /** Contract value plus approved variations, tax-exclusive, in minor units. */
  readonly revenueMinor: number;
  /** Variations instructed but not approved. Deliberately outside revenue. */
  readonly unapprovedVariationMinor: number;
  /** Cost actually incurred. */
  readonly actualCostMinor: number;
  /** Cost committed — ordered, subcontracted — but not yet incurred. */
  readonly committedCostMinor: number;
  readonly marginMinor: number;
  /** Basis points of revenue, so 2,150 is a 21.5% margin. Null at zero revenue. */
  readonly marginBasisPoints: number | null;
}

/**
 * The live margin `PRJ-8` asks for.
 *
 * Two decisions in here are worth stating, because both make the number look
 * *worse* than the alternative and both are correct:
 *
 * **Unapproved variations are not revenue.** They are reported beside the
 * margin so nobody forgets they exist, but a variation the client has not
 * approved is work that may never be paid for, and counting it is how a project
 * reports a healthy margin right up until the final account.
 *
 * **Committed cost counts against the margin.** A subcontract signed for
 * AED 180,000 is money gone whether or not an invoice has arrived, and a margin
 * that improves every time a supplier is slow to invoice is a margin that tells
 * you the opposite of the truth.
 */
export function projectMargin(input: {
  readonly contractValueMinor: number;
  readonly approvedVariationMinor: number;
  readonly unapprovedVariationMinor: number;
  readonly actualCostMinor: number;
  readonly committedCostMinor: number;
}): ProjectMargin {
  const revenueMinor = input.contractValueMinor + input.approvedVariationMinor;
  const costMinor = input.actualCostMinor + input.committedCostMinor;
  const marginMinor = revenueMinor - costMinor;

  return {
    revenueMinor,
    unapprovedVariationMinor: input.unapprovedVariationMinor,
    actualCostMinor: input.actualCostMinor,
    committedCostMinor: input.committedCostMinor,
    marginMinor,
    marginBasisPoints:
      revenueMinor === 0 ? null : Math.round((marginMinor * 10_000) / revenueMinor),
  };
}

/**
 * Cost of labour: hours × an hourly cost, in minor units.
 *
 * Hours carry two decimals and the arithmetic is integer throughout — hundredths
 * of an hour multiplied by fils, divided back down once, rounded once. A
 * timesheet of 7.25 hours at AED 32.50 must produce the same figure every time
 * it is recomputed, and a float does not guarantee that.
 */
export function labourCostMinor(hours: string | number, hourlyCostMinor: number): number {
  const text = typeof hours === "number" ? hours.toFixed(2) : hours.trim();
  if (text === "") return 0;
  const negative = text.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? text.slice(1) : text).split(".");
  const hundredths = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  const value = Math.round((hundredths * hourlyCostMinor) / 100);
  return negative ? -value : value;
}

// ── PRJ-9: subcontractors ────────────────────────────────────────────────────

export type SubcontractApproval = "not_required" | "pending" | "approved" | "refused";

export const SUBCONTRACT_APPROVAL_LABEL: Readonly<Record<SubcontractApproval, string>> = {
  not_required: "Not required",
  pending: "Awaiting client approval",
  approved: "Approved",
  refused: "Refused",
};

/**
 * Dubai Law No. 7 of 2025 requires the employer's prior approval before a
 * contractor subcontracts within the contracting sector.
 *
 * Which is why `not_required` exists and why it is not the default anywhere:
 * it is for the genuine exceptions — a labour supply agreement, a specialist
 * the client themselves nominated — and recording one is a positive act, not
 * an omission. A field that defaults to "not required" is a field that is
 * always "not required".
 */
export const SUBCONTRACT_APPROVAL_AUTHORITY =
  "Dubai Law No. 7 of 2025 requires the employer's prior approval before subcontracting.";

export interface SubcontractorCompliance {
  readonly licenceExpiresOn: string | null;
  readonly insuranceExpiresOn: string | null;
}

export type ComplianceState = "valid" | "expiring" | "expired" | "unknown";

/** How far ahead a subcontractor's paperwork starts being chased. */
export const SUBCONTRACTOR_EXPIRY_WARNING_DAYS = 30;

/**
 * The worse of a subcontractor's licence and insurance states.
 *
 * `unknown` is its own state and does not collapse into `valid`. A trade
 * licence nobody has recorded is not a valid trade licence — it is a
 * subcontractor about to be sent to a client's building with no evidence they
 * may legally be there, and reporting that as fine is the failure this register
 * exists to prevent.
 */
export function subcontractorComplianceState(
  input: SubcontractorCompliance,
  today: string,
): ComplianceState {
  const states = [input.licenceExpiresOn, input.insuranceExpiresOn].map<ComplianceState>((on) => {
    if (!on) return "unknown";
    if (on < today) return "expired";
    return daysBetweenDates(today, on) <= SUBCONTRACTOR_EXPIRY_WARNING_DAYS
      ? "expiring"
      : "valid";
  });

  const order: readonly ComplianceState[] = ["expired", "unknown", "expiring", "valid"];
  return order.find((state) => states.includes(state)) ?? "valid";
}
