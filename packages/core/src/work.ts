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

// ── Materials (FLD-9) ────────────────────────────────────────────────────────

/**
 * Where a part came from.
 *
 * ── WHY THIS LIVES IN core AND NOT IN THE FIELD APP ────────────────────────
 *
 * It was defined in `apps/field/src/domain/job-card.ts` and nowhere else, and
 * that is precisely how the server came not to know it existed: the field
 * client sent `source` on every `job_material/append`, `job_materials` had no
 * column for it, and `recordJobMaterial` read no such key. Nothing refused and
 * nothing warned — the line was accepted and the provenance was gone. A
 * vocabulary owned by one end of a wire is a vocabulary the other end can
 * silently disagree with.
 *
 * `FLD-9` exists to answer "where did this part come from", which is the
 * question a warranty claim, a supplier dispute and a parts-markup audit all
 * turn on. That answer is only worth having if it is answerable by report
 * rather than by reading, so this is a closed set rather than free text.
 *
 * ── WHY A CHECK CONSTRAINT AND NOT A REFERENCE TABLE ───────────────────────
 *
 * `permit_authorities` and `snag_trades` are tables because an operator
 * genuinely adds to them — a new authority, a new trade. This is not that
 * shape. It is the same shape as `project_snags.responsible_party`, which is a
 * `varchar` with a CHECK for the same reason: a small, closed set of
 * provenance categories that nobody extends.
 *
 * The deciding argument is the field app. Its picker is compiled into an
 * offline client that may not be updated for weeks. A row added to a reference
 * table would be a value that client can neither render nor produce, so the
 * table would offer an operator a choice that does not work — which is worse
 * than the free-text fallback a vocabulary is supposed to prevent.
 */
export type MaterialSource = "van_stock" | "purchased" | "customer_supplied";

/** The wire spelling, in the order a picker should offer them. */
export const MATERIAL_SOURCES: readonly MaterialSource[] = [
  "van_stock",
  "purchased",
  "customer_supplied",
];

export const MATERIAL_SOURCE_LABEL: Readonly<Record<MaterialSource, string>> = {
  van_stock: "Van stock",
  purchased: "Purchased",
  customer_supplied: "Customer supplied",
};

export function isMaterialSource(value: unknown): value is MaterialSource {
  return typeof value === "string" && (MATERIAL_SOURCES as readonly string[]).includes(value);
}

// ── Attachments and photographs (FLD-7) ──────────────────────────────────────

/**
 * What a `job_attachments` row **is**, as storage. The database agrees: a CHECK
 * constraint named `job_attachments_kind`, added by `0025` with five values and
 * recreated by `0034` with a sixth.
 *
 * ── WHY THIS MOVED OUT OF `db` ─────────────────────────────────────────────
 *
 * It was declared in `packages/db/src/domain/jobcard.ts` and nowhere else,
 * which put it out of reach of the one client most likely to get it wrong:
 * `apps/field` depends on `@meridian/core` and never on `@meridian/db`, so
 * `appendAttachment` in `apps/field/src/sync/payloads.ts` typed its `kind` as a
 * bare `string` and named the six permitted values **in a doc comment**. That
 * is two readings of one document, and it is precisely the arrangement that
 * produced `FLD-9`: a handset could compose a payload the office always
 * refuses, and find out hours later, in a plant room, rather than at compile
 * time. There is one declaration now, in the package both ends already depend
 * on, and `db` re-exports it so every existing importer is unaffected.
 *
 * ── WHAT EACH KIND IS FOR, BECAUSE THEY ARE NOT INTERCHANGEABLE ────────────
 *
 *   `photo_before`   the state that justified the work. Customer-visible
 *                    (`PORTAL_PHOTO_KINDS`).
 *   `photo_after`    the state that proves it. **The only kind `JOB-15`
 *                    counts** — `getJobCard` filters on it by name.
 *   `photo_recommendation`  `FLD-12`. Filed only by `job_note/upsert`, in the
 *                    same savepoint as the recommendation text it illustrates.
 *                    Never a general-purpose "other" bucket, never counted
 *                    towards the after-photo gap.
 *   `signature`      a reusable credential. Has its own mutation and its own
 *                    table; withheld from the portal for that reason.
 *   `document`       whatever the office attached. Nothing constrains it, which
 *                    is why `0034` refused to file a recommendation photograph
 *                    here rather than admit a sixth kind.
 *   `video`          no writer yet.
 */
export const JOB_ATTACHMENT_KINDS = [
  "photo_before",
  "photo_after",
  "signature",
  "document",
  "video",
  "photo_recommendation",
] as const;
export type JobAttachmentKind = (typeof JOB_ATTACHMENT_KINDS)[number];

export function isJobAttachmentKind(value: unknown): value is JobAttachmentKind {
  return typeof value === "string" && (JOB_ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/**
 * `FLD-7`'s role vocabulary: **why the technician took the photograph.**
 * A photo without a role is a photo nobody can find.
 *
 * The seven values are the requirement's own list, verbatim.
 */
export type PhotoRole =
  | "before"
  | "after"
  | "defect"
  | "serial_plate"
  | "meter_reading"
  | "parts_used"
  | "site_access";

/** The wire spelling, in the order a picker should offer them. */
export const PHOTO_ROLES: readonly PhotoRole[] = [
  "before",
  "after",
  "defect",
  "serial_plate",
  "meter_reading",
  "parts_used",
  "site_access",
];

export const PHOTO_ROLE_LABEL: Readonly<Record<PhotoRole, string>> = {
  before: "Before",
  after: "After",
  defect: "Defect",
  serial_plate: "Serial plate",
  meter_reading: "Meter reading",
  parts_used: "Parts used",
  site_access: "Site access",
};

export function isPhotoRole(value: unknown): value is PhotoRole {
  return typeof value === "string" && (PHOTO_ROLES as readonly string[]).includes(value);
}

/**
 * Where a photograph taken on a handset is **stored** on the server.
 *
 * ── THESE ARE TWO VOCABULARIES, NOT ONE SPELLED TWICE ──────────────────────
 *
 * The tempting reading is that `before`/`after` are just short for
 * `photo_before`/`photo_after` and the other five are kinds nobody got round to
 * adding. Three pieces of evidence say otherwise:
 *
 *   1. `JOB_ATTACHMENT_KINDS` is not a photo vocabulary. Three of its six
 *      values — `signature`, `document`, `video` — are not photographs at all.
 *      A role is a property of a photograph; a kind is the class of an
 *      attachment. They do not range over the same things.
 *   2. `PHOTO_ROLES` is not a storage vocabulary. `serial_plate` and
 *      `meter_reading` say what is *in the frame*; `photo_after` says what the
 *      row is *evidence of*. `JOB-15`, `PORTAL_PHOTO_KINDS` and the sealed job
 *      sheet all read the second question and none of them ask the first.
 *   3. The specification treats them as two axes and says so: the technical
 *      requirements list `job_attachments` as "Build, reshape — add `role` tag,
 *      `scan_status`, SHA-256, extracted EXIF columns". A `role` *tag*, beside
 *      `kind`, not instead of it.
 *
 * So this is a mapping and not a merge, and it is total by construction: the
 * annotation below is `Record<PhotoRole, JobAttachmentKind>`, so an eighth role
 * added to the union does not compile until somebody has decided where it goes.
 * That is the entire point of writing it as a table rather than a switch with a
 * default.
 *
 * ── WHY ONLY `after` REACHES `photo_after` ─────────────────────────────────
 *
 * `photo_after` is not "a photograph taken later". It is the one kind
 * `assertJobCardComplete` counts, by name, as evidence the work was done. A
 * `parts_used` photograph is a picture of a box on a van floor; a
 * `meter_reading` is a dial. Letting either satisfy the completion gate would
 * reproduce exactly the failure `0025` added its CHECK to prevent — "the job
 * completes, the gate reports itself as satisfied, and no photo is on file" —
 * except from the client rather than from a typo.
 *
 * Everything else is a record of what was found, so it lands in
 * `photo_before`: the state that justified the work, customer-visible,
 * counting towards nothing.
 *
 * Three kinds are deliberately unreachable from here. `photo_recommendation`
 * belongs to `FLD-12` and is filed only by `job_note/upsert`, in the same
 * savepoint as the note it illustrates — an attachment mutation naming it would
 * produce a recommendation photograph attached to no recommendation. `document`
 * is the free-text bucket `0034` refused to use for exactly this purpose.
 * `signature` has its own mutation and its own table.
 *
 * ── WHAT THIS MAPPING COSTS, STATED PLAINLY ────────────────────────────────
 *
 * Five roles collapse into one kind, so today the role does **not** survive the
 * wire: the office learns that a photograph was taken before the work, not that
 * it was of the serial plate. That is a real loss and it is not this function's
 * to fix — `job_attachments` has no column to put a role in. The mapping is
 * what is correct *until* that column exists, and having it in one place is
 * what makes adding the column a one-file change rather than an excavation.
 */
export const PHOTO_ROLE_ATTACHMENT_KIND: Readonly<Record<PhotoRole, JobAttachmentKind>> = {
  before: "photo_before",
  after: "photo_after",
  defect: "photo_before",
  serial_plate: "photo_before",
  meter_reading: "photo_before",
  parts_used: "photo_before",
  site_access: "photo_before",
};

/**
 * The one destination kind for a photograph with this role.
 *
 * Takes a `PhotoRole` and not a `string` on purpose: a role this build could
 * not read has no destination, and inventing one would be the same confident
 * wrong answer `FLD-9` was. Callers narrow with `isPhotoRole` first.
 */
export function attachmentKindForPhotoRole(role: PhotoRole): JobAttachmentKind {
  return PHOTO_ROLE_ATTACHMENT_KIND[role];
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
