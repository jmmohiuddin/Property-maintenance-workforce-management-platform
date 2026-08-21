/**
 * Work vocabulary: job statuses, priorities, SLA maths, lead stages.
 *
 * Lives in `core`, not `db`, because it is **pure** - no drizzle, no driver, no
 * connection. That matters for more than tidiness: a client component that
 * needs `STATUS_LABEL` would otherwise import from `@meridian/db`, and because
 * that package's barrel re-exports the Postgres client, the bundler would try
 * to ship `fs`, `net` and `tls` to the browser and the build would fail.
 *
 * The rule this encodes: `core` is shared vocabulary, `db` is persistence.
 * Anything a browser might legitimately need to render belongs here.
 */

// ── Job status ───────────────────────────────────────────────────────────────

import { workingDeadline, DEFAULT_CALENDAR, type WorkingCalendar } from "./calendar";

export type JobStatus =
  | "draft"
  | "submitted"
  | "triaged"
  | "scheduled"
  | "dispatched"
  | "en_route"
  | "on_site"
  | "paused"
  | "work_complete"
  | "signed_off"
  | "invoiced"
  | "closed"
  | "cancelled";

/**
 * Permitted transitions. Explicit rather than computed from an ordering,
 * because the real graph is not linear: `paused` re-enters the middle, and
 * `cancelled` is reachable from almost anywhere but not from a terminal state.
 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  draft: ["submitted", "cancelled"],
  submitted: ["triaged", "cancelled"],
  triaged: ["scheduled", "dispatched", "paused", "cancelled"],
  scheduled: ["dispatched", "triaged", "paused", "cancelled"],
  dispatched: ["en_route", "scheduled", "paused", "cancelled"],
  en_route: ["on_site", "dispatched", "paused", "cancelled"],
  on_site: ["work_complete", "paused", "cancelled"],
  paused: ["triaged", "scheduled", "dispatched", "on_site", "cancelled"],
  work_complete: ["signed_off", "on_site"],
  signed_off: ["invoiced", "closed"],
  invoiced: ["closed"],
  closed: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly JobStatus[] = ["closed", "cancelled"];

/** Statuses that belong on the dispatch board: live work needing attention. */
export const OPEN_STATUSES: readonly JobStatus[] = [
  "submitted",
  "triaged",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "paused",
  "work_complete",
];

export const ALL_JOB_STATUSES: readonly JobStatus[] = [
  "draft",
  "submitted",
  "triaged",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "paused",
  "work_complete",
  "signed_off",
  "invoiced",
  "closed",
  "cancelled",
];

export const STATUS_LABEL: Readonly<Record<JobStatus, string>> = {
  draft: "Draft",
  submitted: "Submitted",
  triaged: "Triaged",
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  en_route: "En route",
  on_site: "On site",
  paused: "Paused",
  work_complete: "Work complete",
  signed_off: "Signed off",
  invoiced: "Invoiced",
  closed: "Closed",
  cancelled: "Cancelled",
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(from: JobStatus): readonly JobStatus[] {
  return TRANSITIONS[from];
}

/**
 * An error whose message is written for the person who caused it.
 *
 * The distinction matters: `error.message` from the driver is a SQL statement
 * with parameters in it, and putting that on a customer's screen is both
 * useless to them and a disclosure. Only errors marked with this class are
 * safe to render; everything else gets a generic sentence and a server log.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export class InvalidTransitionError extends UserFacingError {
  constructor(
    readonly from: JobStatus,
    readonly to: JobStatus,
  ) {
    super(
      `Cannot move a job from "${STATUS_LABEL[from]}" to "${STATUS_LABEL[to]}". ` +
        `Allowed: ${TRANSITIONS[from].map((s) => STATUS_LABEL[s]).join(", ") || "none, this is a terminal state"}.`,
    );
    this.name = "InvalidTransitionError";
  }
}

// ── Priority and SLA ─────────────────────────────────────────────────────────

export type JobPriority = "p1_emergency" | "p2_urgent" | "p3_standard" | "p4_planned";

export const PRIORITY_LABEL: Readonly<Record<JobPriority, string>> = {
  p1_emergency: "P1 Emergency",
  p2_urgent: "P2 Urgent",
  p3_standard: "P3 Standard",
  p4_planned: "P4 Planned",
};

export interface SlaTarget {
  /** Minutes from triage to arrival on site. */
  readonly respondMinutes: number;
  /** Minutes from triage to work complete. */
  readonly resolveMinutes: number;
}

/**
 * Defaults applied when no contract governs the job. A contract's own
 * `sla_targets` override these per priority.
 */
export const DEFAULT_SLA: Readonly<Record<JobPriority, SlaTarget>> = {
  p1_emergency: { respondMinutes: 60, resolveMinutes: 4 * 60 },
  p2_urgent: { respondMinutes: 4 * 60, resolveMinutes: 24 * 60 },
  p3_standard: { respondMinutes: 24 * 60, resolveMinutes: 3 * 24 * 60 },
  p4_planned: { respondMinutes: 7 * 24 * 60, resolveMinutes: 14 * 24 * 60 },
};

/** Narrows an untrusted contract `sla_targets` blob to usable overrides. */
export function parseContractSla(raw: unknown): Partial<Record<JobPriority, SlaTarget>> {
  if (typeof raw !== "object" || raw === null) return {};
  const out: Partial<Record<JobPriority, SlaTarget>> = {};

  for (const priority of Object.keys(DEFAULT_SLA) as JobPriority[]) {
    const entry = (raw as Record<string, unknown>)[priority];
    if (typeof entry !== "object" || entry === null) continue;
    const { respondMinutes, resolveMinutes } = entry as Record<string, unknown>;
    if (typeof respondMinutes === "number" && typeof resolveMinutes === "number") {
      out[priority] = { respondMinutes, resolveMinutes };
    }
  }
  return out;
}

export function slaTargetFor(
  priority: JobPriority,
  contractTargets?: Partial<Record<JobPriority, SlaTarget>>,
): SlaTarget {
  return contractTargets?.[priority] ?? DEFAULT_SLA[priority];
}

/**
 * Priorities whose clock runs 24/7 rather than against the working calendar.
 *
 * `JOB-3`. Only P1. An active leak at 02:00 on a Saturday is still an
 * emergency, the 24-hour line exists precisely to answer it, and a deadline
 * that politely waited for Monday would describe a service the business does
 * not offer.
 */
export const WALL_CLOCK_PRIORITIES: readonly JobPriority[] = ["p1_emergency"];

/**
 * SLA deadlines are computed once at triage and stored, never recomputed on
 * read. A contract's targets can change mid-year, and a job raised under the
 * old terms must keep being judged by the old terms - deriving on read would
 * silently rewrite history every time a contract was renegotiated, which is
 * exactly the number a customer disputes.
 *
 * ── CHANGED BY `JOB-3` ──────────────────────────────────────────────────────
 *
 * Deadlines used to be wall-clock for every priority, which produced deadlines
 * nobody could have met. A P3 job raised at 18:00 on a Thursday breached at
 * 18:00 on Friday — overnight, then into a weekend the business does not work.
 * The breach was real in the database and imaginary in the world, and a queue
 * full of imaginary breaches is how people learn to ignore the real ones.
 *
 * P2-P4 now count **working minutes** from the calendar (`JOB-6`); P1 stays
 * wall-clock. Passing no calendar keeps the default one, so existing callers
 * get the corrected behaviour without changing.
 */
export function computeSlaDeadlines(
  priority: JobPriority,
  from: Date,
  contractTargets?: Partial<Record<JobPriority, SlaTarget>>,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): { respondByAt: Date; resolveByAt: Date } {
  const target = slaTargetFor(priority, contractTargets);
  const wallClock = WALL_CLOCK_PRIORITIES.includes(priority);

  return {
    respondByAt: workingDeadline(from, target.respondMinutes, { wallClock, calendar }),
    resolveByAt: workingDeadline(from, target.resolveMinutes, { wallClock, calendar }),
  };
}

export type SlaState = "on_track" | "at_risk" | "breached" | "met" | "none";

/**
 * "At risk" fires at 80% of the window elapsed. That threshold is a judgement,
 * not a standard: early enough that a dispatcher can still act, late enough
 * that the board is not permanently amber. It is the number most worth tuning
 * against real data once the board is in daily use.
 */
export const AT_RISK_THRESHOLD = 0.8;

export function slaState(input: {
  createdAt: Date;
  resolveByAt: Date | null;
  completedAt: Date | null;
  now?: Date;
}): SlaState {
  if (!input.resolveByAt) return "none";
  const now = input.now ?? new Date();

  if (input.completedAt) {
    return input.completedAt <= input.resolveByAt ? "met" : "breached";
  }

  if (now > input.resolveByAt) return "breached";

  const total = input.resolveByAt.getTime() - input.createdAt.getTime();
  if (total <= 0) return "breached";

  const elapsed = now.getTime() - input.createdAt.getTime();
  return elapsed / total >= AT_RISK_THRESHOLD ? "at_risk" : "on_track";
}

export const SLA_STATE_LABEL: Readonly<Record<SlaState, string>> = {
  on_track: "On track",
  at_risk: "At risk",
  breached: "Breached",
  met: "Met",
  none: "No SLA",
};

/** Signed minutes until a deadline. Negative means overdue. */
export function minutesUntil(deadline: Date, now: Date = new Date()): number {
  return Math.round((deadline.getTime() - now.getTime()) / 60_000);
}

export function formatDuration(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs < 60) return `${abs}m`;
  const hours = Math.floor(abs / 60);
  if (hours < 24) {
    const rem = abs % 60;
    return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0 ? `${days}d` : `${days}d ${remHours}h`;
}

// ── Leads ────────────────────────────────────────────────────────────────────

export type LeadStage =
  | "new"
  | "contacted"
  | "qualified"
  | "quoted"
  | "negotiating"
  | "won"
  | "lost"
  | "dormant";

export const LEAD_STAGE_LABEL: Readonly<Record<LeadStage, string>> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  quoted: "Quoted",
  negotiating: "Negotiating",
  won: "Won",
  lost: "Lost",
  dormant: "Dormant",
};

export const OPEN_LEAD_STAGES: readonly LeadStage[] = [
  "new",
  "contacted",
  "qualified",
  "quoted",
  "negotiating",
];

/** Maps the public form's urgency to an operational priority. */
export function priorityForUrgency(urgency: string): JobPriority {
  switch (urgency) {
    case "emergency":
      return "p1_emergency";
    case "today":
      return "p2_urgent";
    case "this-week":
      return "p3_standard";
    default:
      return "p4_planned";
  }
}

/* ── Certification expiry ──────────────────────────────────────────────────
 * Lives here rather than in `db` because the technician screens are client
 * components: importing this from the db package would pull the postgres
 * driver into the browser bundle.
 */

/** Days ahead of expiry at which a certification starts warning. */
export const CERT_WARNING_DAYS = 45;

export type CertState = "valid" | "expiring" | "expired" | "no_expiry";

export function certState(expiresOn: Date | null, now = new Date()): CertState {
  if (!expiresOn) return "no_expiry";
  const days = Math.floor((expiresOn.getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return "expired";
  if (days <= CERT_WARNING_DAYS) return "expiring";
  return "valid";
}

export const CERT_STATE_LABEL: Readonly<Record<CertState, string>> = {
  valid: "Valid",
  expiring: "Expiring soon",
  expired: "Expired",
  no_expiry: "No expiry",
};

/* ── Property types ────────────────────────────────────────────────────────
 * Mirrors the `property_type` enum in the database. Lives here rather than in
 * `db` for the same reason the certification vocabulary does: the admin forms
 * are client components, and importing this from the db package would pull the
 * postgres driver into the browser bundle.
 */

export type PropertyType =
  | "apartment"
  | "villa"
  | "office"
  | "retail"
  | "hotel"
  | "building"
  | "warehouse"
  | "mixed_use"
  | "other";

export const PROPERTY_TYPE_LABEL: Readonly<Record<PropertyType, string>> = {
  apartment: "Apartment",
  villa: "Villa",
  office: "Office",
  retail: "Retail",
  hotel: "Hotel",
  building: "Building / tower",
  warehouse: "Warehouse",
  mixed_use: "Mixed use",
  other: "Other",
};
