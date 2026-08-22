/**
 * The bounded working set (`FLD-2`, TRD §8.2).
 *
 * *"The device syncs a declared, bounded set - never 'everything'."*
 *
 * The declaration lives here, as data, for a reason that is not tidiness: the
 * server decides what to send and the client decides what to keep, and those
 * two decisions drifting apart is how a device ends up holding a customer list
 * nobody meant it to hold. `WORKING_SET` is the client's half of the contract
 * in a form that can be read, tested and pointed at in a privacy review. The
 * server's half is `GET /api/field/v1/sync`, owned by the web app.
 *
 * ── AND THE OTHER HALF OF §8.2, WHICH IS THE PART USUALLY SKIPPED ──────────
 *
 * *"Everything else is fetched on demand when online and is explicitly
 * unavailable offline. The screen says so, rather than showing an empty state
 * that looks like 'no data'."*
 *
 * An empty list and an unavailable list look identical and mean opposite
 * things. A technician who sees no invoice history concludes the customer has
 * none. `offlineAvailability()` below is what lets a screen say the true
 * thing instead, and it is exhaustive over the resource vocabulary so that
 * adding a resource without deciding its offline story does not compile.
 */

import { OPEN_STATUSES, type JobStatus } from "@meridian/core";

/**
 * The two halves of the resource vocabulary, as separate types.
 *
 * Splitting them rather than writing one union and a runtime check is what
 * makes the boundary a compile-time fact: `WORKING_SET` may only contain a
 * `SyncedResource`, `ONLINE_ONLY_MESSAGE` must contain every
 * `OnlineOnlyResource`, and moving a resource from one side to the other
 * breaks both until both are updated. A resource cannot be added without
 * somebody deciding, in the type system, whether it lives on the device.
 */
export type SyncedResource =
  | "job"
  | "customer"
  | "property"
  | "asset"
  | "fault_code"
  | "outcome_code"
  | "photo_exemption_reasons"
  | "rate_card"
  | "certification";

export type OnlineOnlyResource =
  | "invoice"
  | "quote"
  | "customer_history"
  | "other_technician_job"
  | "contract"
  | "stock_level"
  | "price_list";

/**
 * Things `FLD-2` names that **do not exist yet anywhere**, and the difference
 * that makes.
 *
 * `GET /api/field/v1/sync` returns these in `notYetAvailable`, each with the
 * sentence the screen shows and the reason it is blocked. They are not
 * online-only - fetching them online would fail too, because there is no table
 * to fetch from. `packages/db/src/domain/field.ts`:
 *
 *   parts_catalogue  "No parts/SKU catalogue table exists. `rate_card_items`
 *                     prices work, not parts."
 *   ppe_rams         "No PPE or RAMS template table exists in the schema."
 *
 * The consequence is real and is carried through this workspace rather than
 * papered over: the materials screen has no catalogue to scan against and must
 * fall back to free text flagged for the office (`MaterialLine.
 * needsOfficeReconciliation`), and `FLD-4`'s safety gate has no templates to
 * gate on, so it refuses everything - which is the correct direction for a
 * safety gate to fail, and is why the start-work button is disabled rather
 * than hidden.
 */
export type NotYetAvailableResource = "part" | "ppe_template" | "rams_template";

/** Every kind of record the app can show. */
export type FieldResource = SyncedResource | OnlineOnlyResource | NotYetAvailableResource;

export interface WorkingSetEntry {
  readonly resource: SyncedResource;
  /** What bounds the set. Prose, because the bound is a policy, not a query. */
  readonly bound: string;
}

/**
 * The declared set, as the server actually sends it.
 *
 * Transcribed from `FIELD_WORKING_SET` in `packages/db/src/domain/field.ts`
 * rather than from TRD §8.2, because the two differ: §8.2 lists a parts
 * catalogue and PPE/RAMS templates that no table backs, and does not list the
 * rate card that the server does send.
 */
export const WORKING_SET: readonly WorkingSetEntry[] = [
  {
    resource: "job",
    bound:
      "This technician's jobs scheduled for today and tomorrow, plus any job in an open status assigned to them.",
  },
  {
    resource: "customer",
    bound: "Only the customers referenced by jobs in the set. Not the customer book.",
  },
  {
    resource: "property",
    bound: "Only properties (and their units and access instructions) referenced by jobs in the set.",
  },
  { resource: "asset", bound: "The plant installed at those properties, for identification and history on site." },
  { resource: "fault_code", bound: "The tenant's whole symptom / cause / remedy taxonomy (JOB-14)." },
  { resource: "outcome_code", bound: "The tenant's whole job outcome list (JOB-13)." },
  {
    // `job_photo_exemption_reasons`, read by `listPhotoExemptionReasons(tx)`;
    // five seeded per tenant. Named for the server's own manifest key so the
    // two lists cannot drift apart under maintenance.
    resource: "photo_exemption_reasons",
    bound:
      "The tenant's whole reason list, so JOB-15's exemption path works with no signal. The device never invents a reason code.",
  },
  { resource: "rate_card", bound: "The priced schedule of rates in force today." },
  {
    resource: "certification",
    bound:
      "This technician's own certifications and expiry states. Not the team's - a technician has no business reading a colleague's documents.",
  },
];

/** The server's own sentences, mirrored so the screen reads the same offline. */
export const NOT_YET_AVAILABLE_MESSAGE: Readonly<Record<NotYetAvailableResource, string>> = {
  part: "The parts catalogue is not on this phone yet. Type the part description instead.",
  ppe_template: "Method statements and PPE lists are not on this phone yet.",
  rams_template: "Method statements and PPE lists are not on this phone yet.",
};

const SYNCED: ReadonlySet<string> = new Set(WORKING_SET.map((e) => e.resource));

export type OfflineAvailability =
  | { readonly kind: "available"; readonly bound: string }
  | { readonly kind: "online_only"; readonly message: string }
  | { readonly kind: "not_yet_built"; readonly message: string };

/**
 * What a screen should say when a resource is not on the device.
 *
 * Written for the technician, in the second person, saying what to do rather
 * than what failed. "Invoices are not stored on the device" is a fact a person
 * can act on; "Failed to load" is not. `Record<OnlineOnlyResource, string>` is
 * what forces every online-only resource to have one.
 *
 * Three outcomes and not two, because "connect and it will load" and "this does
 * not exist yet" are different instructions. Telling a technician to find signal
 * for a parts catalogue that no table backs sends them outside for nothing.
 */
export const ONLINE_ONLY_MESSAGE: Readonly<Record<OnlineOnlyResource, string>> = {
  invoice: "Invoices are not stored on the device. Connect to see them.",
  quote: "Quotations are not stored on the device. Connect to see them.",
  customer_history:
    "Past visits are not stored on the device - only the jobs assigned to you. Connect to see the full history.",
  other_technician_job:
    "You can only see jobs assigned to you. Ask dispatch to reassign it if you need it.",
  contract: "Contract terms are not stored on the device. Connect to see them.",
  stock_level:
    "Van and warehouse stock levels change during the day, so they are not stored on the device. Connect to check.",
  price_list: "Prices are not stored on the device. Record what you fitted; the office prices it.",
};

export function offlineAvailability(resource: FieldResource): OfflineAvailability {
  const entry = WORKING_SET.find((e) => e.resource === resource);
  if (entry) return { kind: "available", bound: entry.bound };

  const notYet = NOT_YET_AVAILABLE_MESSAGE[resource as NotYetAvailableResource];
  if (notYet) return { kind: "not_yet_built", message: notYet };

  return { kind: "online_only", message: ONLINE_ONLY_MESSAGE[resource as OnlineOnlyResource] };
}

export function isSyncedOffline(resource: FieldResource): boolean {
  return SYNCED.has(resource);
}

// ── The job predicate ───────────────────────────────────────────────────────

export interface WorkingSetJob {
  readonly id: string;
  readonly assignedTechnicianId: string | null;
  readonly status: JobStatus;
  /** Scheduled start, ISO-8601. Null for an open job with no date yet. */
  readonly scheduledFor: string | null;
}

const OPEN: ReadonlySet<string> = new Set(OPEN_STATUSES);

/**
 * Does this job belong on the device?
 *
 * Two clauses, and the second is the one that stops the app being useless.
 * "Today and tomorrow" alone would evict a job the technician left half-done
 * on Friday and returns to on Monday - which is precisely the job whose notes
 * they need. So: **today or tomorrow, OR open and assigned to them.**
 *
 * The status list is `OPEN_STATUSES` from `@meridian/core`, not a copy. A
 * second list of open statuses that disagreed with the dispatch board's would
 * mean the office could see a job the technician's app had quietly dropped.
 *
 * `today` is passed in as a local calendar date (YYYY-MM-DD) rather than
 * computed from `Date.now()`, because the device clock is not trusted (see
 * clock.ts) and because "today" in the field is the *site's* day, not UTC's.
 *
 * ── A TENSION IN THE SPECIFICATION, IMPLEMENTED LITERALLY AND FLAGGED ──────
 *
 * TRD §8.2 reads "jobs for today and tomorrow, **plus any job in an open state
 * assigned to them**", and `scheduled` is an open status in
 * `OPEN_STATUSES`. Taken literally - as it is here - the second clause
 * subsumes the first for every job that has been scheduled at all, including a
 * PPM visit planned for next month. The date window then only excludes
 * non-open jobs, which is a much weaker bound than "today and tomorrow"
 * suggests.
 *
 * It is implemented literally anyway, for two reasons. The volume is bounded
 * in practice because dispatch assigns close to the date, so the difference is
 * a handful of rows rather than the "everything" §8.2 forbids. And narrowing
 * it here would mean this client silently held less than the server sent,
 * which is the client-server drift the declaration at the top of this file
 * exists to prevent. If the bound needs tightening it should tighten on the
 * server, in `GET /api/field/v1/sync`, and both sides should move together.
 */
export function isJobInWorkingSet(
  job: WorkingSetJob,
  technicianId: string,
  todayLocalDate: string,
): boolean {
  if (job.assignedTechnicianId !== technicianId) return false;
  if (OPEN.has(job.status)) return true;
  if (!job.scheduledFor) return false;

  const scheduledDate = job.scheduledFor.slice(0, 10);
  return scheduledDate === todayLocalDate || scheduledDate === nextDay(todayLocalDate);
}

export function nextDay(localDate: string): string {
  const d = new Date(`${localDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Eviction ────────────────────────────────────────────────────────────────

/**
 * ADR 0004's stated risk: *"Storage growth on device. Cap the local database,
 * evict completed jobs older than 30 days, and make photo retention policy
 * explicit before launch rather than after the first 'storage full' report
 * from a technician mid-shift."*
 *
 * Two rules, and the ordering between them is the whole safety property.
 */
export const EVICT_COMPLETED_AFTER_DAYS = 30;

export interface EvictionCandidate {
  readonly jobId: string;
  readonly status: JobStatus;
  /** Device-local completion date, YYYY-MM-DD. Null while the job is open. */
  readonly completedLocalDate: string | null;
  /** True while anything about this job is still queued in the outbox. */
  readonly hasUnsyncedWork: boolean;
}

export type EvictionDecision =
  | { readonly evict: true; readonly reason: string }
  | { readonly evict: false; readonly reason: string };

/**
 * **A job with unsynced work is never evicted, whatever its age.** That check
 * is first and unconditional. Evicting a completed-but-unsynced job would
 * delete the only copy of a day's work to save a few megabytes, which is the
 * one failure this product cannot survive.
 */
export function evictionDecision(
  candidate: EvictionCandidate,
  todayLocalDate: string,
  afterDays: number = EVICT_COMPLETED_AFTER_DAYS,
): EvictionDecision {
  if (candidate.hasUnsyncedWork) {
    return { evict: false, reason: "Work on this job has not reached the server yet." };
  }
  if (!OPEN.has(candidate.status) && candidate.completedLocalDate) {
    const ageDays = daysBetween(candidate.completedLocalDate, todayLocalDate);
    if (ageDays >= afterDays) {
      return { evict: true, reason: `Finished ${ageDays} days ago and fully synced.` };
    }
    return { evict: false, reason: `Finished ${ageDays} days ago; kept for ${afterDays}.` };
  }
  return { evict: false, reason: "Still open." };
}

export function daysBetween(fromLocalDate: string, toLocalDate: string): number {
  const from = Date.parse(`${fromLocalDate}T00:00:00Z`);
  const to = Date.parse(`${toLocalDate}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}
