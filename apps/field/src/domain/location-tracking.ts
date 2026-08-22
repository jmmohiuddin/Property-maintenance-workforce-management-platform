/**
 * `FLD-16`: what makes the device sample a position at all, and what makes a
 * buffer of them worth sending. Pure - no `expo-location`, no WatermelonDB -
 * so the policy is typechecked by the root gate and tested by `tsx` rather
 * than trusted on the strength of a comment. The effectful half that reads a
 * GPS chip and writes SQLite is `app/components/LocationSharingTracker.tsx`,
 * which is neither.
 *
 * ── THE CAPTURE WINDOW IS NOT A FOURTH DECISION, IT IS THE SAME ONE ────────
 *
 * `technician_locations` is readable by a customer under exactly one
 * condition - `customer_scope` in `packages/db/sql/customer-scope.sql`: a
 * live visit, `en_route` or `arrived`, within twelve hours of setting off.
 * `currentTrackingAudience` in `packages/db/src/domain/tracking.ts` asks the
 * same question, in the same words, to decide what a ping's response tells
 * the technician.
 *
 * `shouldBeTracking` below asks it a THIRD time, on the device, before a
 * position is ever read off the chip - and it is not a third implementation
 * of the rule, it is the same one degree narrower: `job_visits.status` is
 * `en_route` exactly when `jobs.status` is `en_route`, and `arrived` exactly
 * when `jobs.status` is `on_site` (`transitionJob` in `packages/db/src/
 * domain/jobs.ts` sets both together, in one transaction). A phone syncs
 * `jobs`, not `job_visits` - see `FIELD_WORKING_SET` in `packages/db/src/
 * domain/field.ts` - so this reads the job status the sync already sent
 * rather than inventing a second table to mirror the visit.
 *
 * ── THE ALTERNATIVE THAT WAS REJECTED ───────────────────────────────────────
 *
 * Sample continuously, whenever the app is open, and let the SERVER decide
 * what a customer may read. That was rejected because of what would still be
 * true even if no query ever surfaced it: a phone recording a technician's
 * position on a lunch break, or the drive home, sitting in a database row, is
 * a privacy exposure whether or not the read policy happens to be correct
 * today. Gating capture at the SOURCE - so the row is never written at all -
 * is the only version of "we do not track your lunch break" that survives a
 * bug in the read policy rather than depending on one never happening.
 *
 * The cost of that choice is named rather than hidden: a technician who does
 * not tap "On my way" (`domain/location-tracking.ts` cannot see a status the
 * device was never told) is not tracked, and a customer watching the board
 * sees nothing until the technician's own control drives the transition. That
 * is the correct failure direction for a capture policy to fail in - not a
 * silent one, and not a customer being shown a phone's owner has no idea is
 * broadcasting.
 */

export type TrackableJobStatus = "en_route" | "on_site";

const TRACKABLE_STATUSES: readonly TrackableJobStatus[] = ["en_route", "on_site"];

export function isTrackableJobStatus(status: string): status is TrackableJobStatus {
  return (TRACKABLE_STATUSES as readonly string[]).includes(status);
}

/** True the moment ANY job this technician holds is in a trackable state. */
export function shouldBeTracking(jobStatuses: readonly string[]): boolean {
  return jobStatuses.some(isTrackableJobStatus);
}

export interface TrackableJob {
  readonly id: string;
  readonly status: string;
  readonly customerId: string;
}

/**
 * Which job, if any, explains why a position is being sampled right now - for
 * the banner that names who is watching (`FLD-16`'s "the technician must
 * know").
 *
 * This is an APPROXIMATION of `currentTrackingAudience`'s own tie-break, and
 * says so rather than pretending otherwise: the server orders by
 * `en_route_at`, a timestamp this device does not hold locally (`FieldJob`
 * carries no such field - see `pullWorkingSet`'s projection). Preferring
 * `en_route` over `on_site` is the best local substitute - the technician is
 * literally travelling to at most one place at a time, and a job already
 * `en_route` is the one whose journey is still in progress. Two candidates in
 * the same state is `currentTrackingAudience`'s own "a dispatch mistake
 * rather than a state to model"; this picks the first found rather than
 * inventing an order this device has no data to support.
 */
export function trackedJob<T extends TrackableJob>(jobs: readonly T[]): T | null {
  const enRoute = jobs.find((j) => j.status === "en_route");
  if (enRoute) return enRoute;
  return jobs.find((j) => j.status === "on_site") ?? null;
}

// ── The buffer: batched pings, not one request per fix ──────────────────────

/**
 * Reject rather than buffer - and reject the fix, not the batch it would
 * otherwise poison.
 *
 * Mirrors two of `assertPlausible`'s (`packages/db/src/domain/tracking.ts`)
 * rules, deliberately not all four. A real GPS chip does not hand back a
 * latitude of 91; duplicating the full range check here would be a second
 * copy of a rule with nothing to catch, and this repository has been bitten
 * by exactly that shape of drift before (see the note on inventing
 * vocabulary). What a real chip DOES hand back - on a cold fix, a permission
 * race, or a simulator with no location set - is `(0, 0)` or `NaN`, so those
 * are the two rules worth a local copy: filtering them here means one bad fix
 * cannot fail the whole flushed batch it would otherwise travel inside,
 * because `recordTechnicianPing` refuses an entire batch for one bad row.
 */
export function isUsablePosition(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

/**
 * The largest buffer this module will let a caller flush as one mutation.
 *
 * Well under the server's own `MAX_LOCATION_PINGS_PER_BATCH` (500, in
 * `packages/db/src/domain/field.ts`) - that ceiling is a sanity bound against
 * a bug, this one is a working target, and the two are not meant to be tuned
 * together.
 */
export const MAX_BUFFERED_PINGS = 40;

/**
 * How long a buffered-but-unsent ping may wait before it forces a flush, even
 * with the buffer far from full.
 *
 * Chosen so a customer watching a live board is never looking at a position
 * more than a couple of minutes stale while the technician is genuinely
 * travelling, and so a phone that has gone still is not flushing a
 * near-empty buffer every few seconds for no reason. A judgement call, like
 * every timeout in this app - `AttendanceBar`'s `LOCATION_FIX_TIMEOUT_MS`
 * says the same about itself.
 */
export const MAX_BUFFER_AGE_MS = 2 * 60_000;

export function shouldFlush(
  bufferLength: number,
  oldestBufferedAtMonotonic: number | null,
  nowMonotonic: number,
): boolean {
  if (bufferLength <= 0) return false;
  if (bufferLength >= MAX_BUFFERED_PINGS) return true;
  if (oldestBufferedAtMonotonic === null) return false;
  return nowMonotonic - oldestBufferedAtMonotonic >= MAX_BUFFER_AGE_MS;
}
