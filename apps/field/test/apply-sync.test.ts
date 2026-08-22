/**
 * The download half of sync.
 *
 * Everything here runs the *real* path a response takes: `parseSyncResponse`
 * first, then `planSyncApply`. That matters for the very first group below -
 * "absent" and "empty" are a distinction the zod schema creates and the planner
 * consumes, and a test that constructed the parsed object by hand would prove
 * nothing about the half of it that reads the wire.
 *
 * What is NOT covered here, and cannot be: `applySyncPlan` in
 * `src/db/watermelon.ts`, which is the part that touches SQLite. It imports
 * `@nozbe/watermelondb` and cannot run under `tsx`. Every decision it makes was
 * moved into `src/sync/download.ts` for exactly that reason; what is left there
 * is the batch, and the batch is unexercised.
 */

import { check, equal, deepEqual, done } from "./_harness";
import { parseSyncResponse } from "../src/sync/protocol";
import {
  SYNC_STATE_KEYS,
  SyncApplyError,
  parseServerDay,
  parseServerInstant,
  planRemovals,
  planSyncApply,
  type DeviceHoldings,
} from "../src/sync/download";
import { completionReadiness } from "../src/domain/job-card";
import { evictionDecision } from "../src/domain/working-set";

const SERVER_TIME = "2026-08-22T05:00:00.000Z";
const NOTHING_HELD: DeviceHoldings = { jobIds: [], jobIdsWithUnsyncedWork: [] };

/** A response with only the two keys the schema insists on. */
function response(extra: Record<string, unknown> = {}): unknown {
  return { serverTime: SERVER_TIME, nextCursor: "cursor-1", ...extra };
}

function plan(extra: Record<string, unknown> = {}, holdings: DeviceHoldings = NOTHING_HELD) {
  return planSyncApply(parseSyncResponse(response(extra)), holdings);
}

/** Every required field of a job, so a test can vary one thing at a time. */
function job(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    reference: "JOB-2026-00001",
    title: "No cooling in the lobby",
    description: "Reported by the building manager.",
    status: "dispatched",
    statusLabel: "Dispatched",
    priority: "p2_urgent",
    serviceSlug: "hvac",
    isOutdoor: false,
    customerId: "cus-1",
    propertyId: "prop-1",
    unitId: null,
    assetId: "asset-1",
    scheduledFor: "2026-08-22T05:00:00.000Z",
    respondByAt: null,
    resolveByAt: null,
    outcomeCode: null,
    visitId: "visit-1",
    visitStatus: "scheduled",
    visitScheduledStart: "2026-08-22T05:30:00.000Z",
    visitScheduledEnd: "2026-08-22T07:30:00.000Z",
    gaps: null,
    updatedAt: "2026-08-22T04:59:00.000Z",
    ...extra,
  };
}

// ── 1. `taxonomies`: absent is not empty ────────────────────────────────────
//
// The route spreads `...(page.taxonomies ? { taxonomies: {…} } : {})`. Absent
// means "unchanged since your cursor, keep what you have"; an object with four
// empty arrays means "there are none". Reading the first as the second blanks a
// technician's fault-code picker mid-shift, offline.

const unchanged = plan();
equal("an omitted taxonomies key plans no taxonomy write at all", unchanged.taxonomies, null);

const emptied = plan({
  taxonomies: { faultCodes: [], outcomeCodes: [], photoExemptionReasons: [], rateCard: [] },
});
check("an empty taxonomies object plans a write, not a skip", emptied.taxonomies !== null);
equal("and that write is the empty set", emptied.taxonomies?.length, 0);

// The assertion that would fail if the two were ever conflated, stated as one
// line rather than left implicit in the two above.
check(
  "absent and empty reach the batch as different things",
  unchanged.taxonomies === null && Array.isArray(emptied.taxonomies),
);

const refreshed = plan({
  taxonomies: {
    faultCodes: [
      { id: "f1", kind: "symptom", code: "NO_COOL", label: "No cooling", description: null, sortOrder: 10 },
      { id: "f2", kind: "cause", code: "LOW_GAS", label: "Low refrigerant", description: null, sortOrder: 20 },
    ],
    outcomeCodes: [
      { id: "o1", code: "FIXED", label: "Fixed on site", description: null, requiresReturnVisit: false, sortOrder: 1 },
      { id: "o2", code: "PARTS", label: "Awaiting parts", description: null, requiresReturnVisit: true, sortOrder: 2 },
    ],
    photoExemptionReasons: [
      { id: "p1", code: "NO_ACCESS", label: "No access to the plant", description: null },
      { id: "p2", code: "DARK", label: "Too dark to photograph", description: null },
    ],
    rateCard: [{ id: "r1", code: "HVAC_HR", label: "HVAC labour, per hour", notes: null, unitPriceMinor: 15000 }],
  },
});

equal("all four vocabularies flatten into one table", refreshed.taxonomies?.length, 7);
equal(
  "a fault code keeps JOB-14's kind, which is what the picker groups by",
  refreshed.taxonomies?.find((t) => t.id === "f2")?.kind,
  "cause",
);
equal(
  "an outcome code has no kind, and absent is not an empty string",
  refreshed.taxonomies?.find((t) => t.id === "o1")?.kind,
  undefined,
);
equal(
  "requiresReturnVisit survives, because it changes what the screen offers next",
  refreshed.taxonomies?.find((t) => t.id === "o2")?.requiresReturnVisit,
  true,
);
equal(
  "a photo exemption reason takes its order from the server's array, having none of its own",
  refreshed.taxonomies?.find((t) => t.id === "p2")?.sortOrder,
  1,
);
// The rate card is stored as vocabulary only. There is no money column in
// `taxonomy_terms` and none should exist - `working-set.ts` declares prices
// online-only so the device cannot quote a stale number.
const rate = refreshed.taxonomies?.find((t) => t.id === "r1");
equal("a rate card row is stored by code", rate?.code, "HVAC_HR");
check("and carries no price anywhere on it", !Object.keys(rate ?? {}).some((k) => /price|amount|minor/i.test(k)));

// ── 2. `scope.jobIds` replaces tombstones ───────────────────────────────────

const held = ["job-a", "job-b", "job-c"];

deepEqual(
  "what the device holds, minus what the server named, is what goes",
  planRemovals(held, ["job-a"], []).remove,
  ["job-b", "job-c"],
);
deepEqual(
  "a job still in scope is never removed, changed or not",
  planRemovals(held, held, []).remove,
  [],
);
deepEqual(
  "an empty scope is a real answer: the technician has nothing assigned",
  planRemovals(held, [], []).remove,
  ["job-a", "job-b", "job-c"],
);

// The guard. Losing a technician's queued write is the failure this whole
// milestone exists to prevent, and a reassignment must not do what a storage
// cap is forbidden to do.
const withQueuedWork = planRemovals(held, ["job-a"], ["job-b"]);
deepEqual("a job with unsynced work is not removed when it falls out of scope", withQueuedWork.remove, ["job-c"]);
deepEqual("it is kept, and named as kept", withQueuedWork.retainedForUnsyncedWork, ["job-b"]);

// The same rule, stated in the same order, as `evictionDecision` - the two are
// the same deletion arriving through different doors.
check(
  "eviction refuses a job with unsynced work too, whatever its age",
  evictionDecision(
    { jobId: "job-b", status: "closed", completedLocalDate: "2020-01-01", hasUnsyncedWork: true },
    "2026-08-22",
  ).evict === false,
);
check(
  "and it does evict the same job once the queue has drained",
  evictionDecision(
    { jobId: "job-b", status: "closed", completedLocalDate: "2020-01-01", hasUnsyncedWork: false },
    "2026-08-22",
  ).evict === true,
);

// Through the whole planner, not just the helper.
const evicting = plan(
  { scope: { jobIds: ["job-keep"] } },
  { jobIds: ["job-keep", "job-gone", "job-busy"], jobIdsWithUnsyncedWork: ["job-busy"] },
);
deepEqual("the plan removes the job the office took away", evicting.removeJobIds, ["job-gone"]);
deepEqual("and keeps the one still holding work", evicting.retainedForUnsyncedWork, ["job-busy"]);

// ── 3. Timestamps: refuse rather than store NaN ─────────────────────────────

equal(
  "an ISO-8601 instant parses to epoch milliseconds",
  parseServerInstant("t", "2026-08-22T09:00:00.000Z").epochMs,
  Date.parse("2026-08-22T09:00:00.000Z"),
);
equal("and is not reported as an anomaly", parseServerInstant("t", "2026-08-22T09:00:00.000Z").anomaly, null);

// Postgres renders a timestamptz as `2026-08-22 09:00:00+04` - a space where
// ISO has a `T`, and a two-digit offset ISO does not accept. V8 limps through
// it; Hermes, which is what this app runs on, returns NaN.
const postgres = parseServerInstant("t", "2026-08-22 09:00:00+04");
equal(
  "a raw Postgres timestamp is repaired to the right instant",
  postgres.epochMs,
  Date.parse("2026-08-22T05:00:00.000Z"),
);
check("and is reported rather than quietly absorbed", postgres.anomaly !== null);

const postgresNoZone = parseServerInstant("t", "2026-08-22 09:00:00");
equal("a zoneless Postgres timestamp is read as UTC", postgresNoZone.epochMs, Date.parse("2026-08-22T09:00:00Z"));

for (const rubbish of ["", "not a date", "2026-13-45T99:00:00Z"]) {
  let refused = false;
  try {
    parseServerInstant("t", rubbish);
  } catch (error) {
    refused = error instanceof SyncApplyError;
  }
  check(`\`${rubbish}\` is refused rather than stored as NaN`, refused);
}

for (const wrongType of [null, undefined, 1_755_849_600_000, {}]) {
  let refused = false;
  try {
    parseServerInstant("t", wrongType);
  } catch (error) {
    refused = error instanceof SyncApplyError;
  }
  check(`a ${typeof wrongType} where a timestamp belongs is refused`, refused);
}

// The whole pull is refused, not the one field - a plan that dropped a bad
// respond-by date and stored the rest would advance the cursor past a row the
// device never wrote correctly.
let pullRefused: unknown = null;
try {
  plan({ jobs: [job({ respondByAt: "yesterday" })], scope: { jobIds: ["job-1"] } });
} catch (error) {
  pullRefused = error;
}
check("one unparseable timestamp refuses the entire pull", pullRefused instanceof SyncApplyError);
check(
  "and the refusal names the field, because a sync that fails anonymously is unfixable",
  (pullRefused as SyncApplyError | null)?.field.includes("respondByAt") === true,
);

// Null is a state, not a failure. A job with no SLA clock has no SLA clock.
const noSla = plan({ jobs: [job({ respondByAt: null, resolveByAt: null })], scope: { jobIds: ["job-1"] } });
equal("a null timestamp becomes an unset column, never NaN", noSla.jobs[0]?.respondByAt, undefined);
check("and nothing about it is NaN", !Number.isNaN(noSla.jobs[0]?.respondByAt ?? 0));

// Day-valued columns. `expiresOn` is kept as YYYY-MM-DD end to end server-side
// precisely so it cannot drift across midnight; the local column is a number,
// so the round trip is forced and is anchored at UTC to make it reversible.
const expiry = parseServerDay("expiresOn", "2026-11-30");
equal("a day parses to UTC midnight", expiry, Date.parse("2026-11-30T00:00:00.000Z"));
equal("and reads back as the same day string", new Date(expiry).toISOString().slice(0, 10), "2026-11-30");
let dayRefused = false;
try {
  parseServerDay("expiresOn", "2026-11-30T00:00:00.000Z");
} catch (error) {
  dayRefused = error instanceof SyncApplyError;
}
check("a full timestamp where a day belongs is refused, not truncated", dayRefused);

// ── 4. `gaps`: JOB-15 is rendered, never recomputed ─────────────────────────

const notApplicable = plan({ jobs: [job({ gaps: null })], scope: { jobIds: ["job-1"] } });
equal("`gaps: null` stays null - completion is not on the table", notApplicable.jobs[0]?.gaps, null);
equal(
  "which the job card reads as not applicable",
  completionReadiness(notApplicable.jobs[0]?.gaps).state,
  "not_applicable",
);

const ready = plan({ jobs: [job({ status: "on_site", gaps: [] })], scope: { jobIds: ["job-1"] } });
deepEqual("`gaps: []` stays an empty list - nothing is missing", ready.jobs[0]?.gaps, []);
equal("which the job card reads as ready", completionReadiness(ready.jobs[0]?.gaps).state, "ready");

const outstanding = plan({
  jobs: [job({ status: "on_site", gaps: ["after_photo", "labour"] })],
  scope: { jobIds: ["job-1"] },
});
deepEqual("outstanding conditions arrive in the server's order", outstanding.jobs[0]?.gaps, [
  "after_photo",
  "labour",
]);
equal("which the job card reads as outstanding", completionReadiness(outstanding.jobs[0]?.gaps).state, "outstanding");

// The state that is easy to lose: an absent key is not the same as null, and
// the plan says "leave the column alone" rather than inventing an answer.
const neverTold = plan({ jobs: [job({ gaps: undefined })], scope: { jobIds: ["job-1"] } });
equal("an absent `gaps` key plans no write to the column", neverTold.jobs[0]?.gaps, undefined);
equal("which the job card reads as unknown", completionReadiness(neverTold.jobs[0]?.gaps).state, "unknown");

// `??` is deliberately not used to collapse the absent case here: `null ??
// "absent"` is "absent", which is the very conflation this line is checking
// against, and a test that made it would pass while proving the opposite.
const spelt = (gaps: readonly string[] | null | undefined): string =>
  gaps === undefined ? "(column left alone)" : JSON.stringify(gaps);

check(
  "all four states of gaps are distinguishable after a round trip",
  new Set([
    spelt(notApplicable.jobs[0]?.gaps),
    spelt(ready.jobs[0]?.gaps),
    spelt(outstanding.jobs[0]?.gaps),
    spelt(neverTold.jobs[0]?.gaps),
  ]).size === 4,
);

let gapsRefused = false;
try {
  plan({ jobs: [job({ gaps: "after_photo" })], scope: { jobIds: ["job-1"] } });
} catch (error) {
  gapsRefused = error instanceof SyncApplyError;
}
check("a `gaps` that is not a list of strings is refused rather than coerced", gapsRefused);

// ── 5. The clock the device writes down is the server's ─────────────────────

const stamped = plan({ jobs: [job()], scope: { jobIds: ["job-1"] } });
equal("every synced_at is the server's clock", stamped.syncedAt, Date.parse(SERVER_TIME));
equal("including on the job row", stamped.jobs[0]?.syncedAt, Date.parse(SERVER_TIME));
check(
  "and it is not the device's, which the working set was never filtered against",
  Math.abs(stamped.syncedAt - Date.now()) > 60_000,
);

// ── 6. The job mapping, against the route's actual field names ──────────────

const mapped = plan({ jobs: [job()], scope: { jobIds: ["job-1"] } }).jobs[0];
equal("the local primary key is the server's job id", mapped?.id, "job-1");
equal(
  "the list window is the technician's own visit, not the job's date",
  mapped?.scheduledFor,
  Date.parse("2026-08-22T05:30:00.000Z"),
);
equal("with its end", mapped?.scheduledEnd, Date.parse("2026-08-22T07:30:00.000Z"));
equal("`version` is `updatedAt` verbatim, because it goes back as baseVersion", mapped?.version, "2026-08-22T04:59:00.000Z");
equal("the office's description comes across", mapped?.description, "Reported by the building manager.");

// A job dispatch has placed in the day but not yet given this technician a
// visit still sorts into the list rather than falling to "No time set".
const noVisit = plan({
  jobs: [job({ visitId: null, visitScheduledStart: null, visitScheduledEnd: null })],
  scope: { jobIds: ["job-1"] },
}).jobs[0];
equal("with no visit, the job's own scheduled time is the window", noVisit?.scheduledFor, Date.parse(SERVER_TIME));
equal("and there is no end, rather than a fabricated one", noVisit?.scheduledEnd, undefined);

// A job with neither says so. `JobListScreen` renders "No time set" for this.
const unplaced = plan({
  jobs: [job({ scheduledFor: null, visitScheduledStart: null, visitScheduledEnd: null })],
  scope: { jobIds: ["job-1"] },
}).jobs[0];
equal("a job nobody has placed in the day has no window at all", unplaced?.scheduledFor, undefined);

let missingId = false;
try {
  plan({ jobs: [{ reference: "JOB-1" }] });
} catch (error) {
  missingId = error instanceof SyncApplyError;
}
check("a job with no id is refused - there is no primary key to upsert on", missingId);

// ── 7. The related entities ─────────────────────────────────────────────────

const related = plan({
  customers: [{ id: "cus-1", name: "Marina Towers OA", phone: null, updatedAt: SERVER_TIME }],
  properties: [
    {
      id: "prop-1",
      customerId: "cus-1",
      name: "Tower B",
      addressLine: "Plot 42, Al Sufouh Road",
      area: "Dubai Marina",
      city: "Dubai",
      lat: 25.08,
      lng: 55.14,
      accessInstructions: "Gate code 4417. Ask security for the plant room key.",
      updatedAt: SERVER_TIME,
    },
  ],
  assets: [
    {
      id: "asset-1",
      propertyId: "prop-1",
      tag: "CH-02",
      name: "Chiller 2",
      location: "Basement plant room",
      manufacturer: "Carrier",
      model: "30XA",
      serialNumber: "SN-9931",
      serviceSlug: "hvac",
      condition: "fair",
      updatedAt: SERVER_TIME,
    },
  ],
  certifications: [
    { id: "cert-1", name: "Working at height", issuer: "IOSH", expiresOn: "2026-11-30", state: "expiring_soon" },
    { id: "cert-2", name: "First aid", issuer: null, expiresOn: null, state: "valid" },
  ],
});

equal("a customer with no phone stores no phone", related.customers[0]?.phone, undefined);
equal(
  "the three address columns become the one the schema has",
  related.properties[0]?.address,
  "Plot 42, Al Sufouh Road, Dubai Marina, Dubai",
);
equal(
  "the field that justifies syncing properties at all survives",
  related.properties[0]?.accessInstructions,
  "Gate code 4417. Ask security for the plant room key.",
);
equal("`location` lands in `location_note`", related.assets[0]?.locationNote, "Basement plant room");
equal("a certification's issuer is its scheme", related.certifications[0]?.scheme, "IOSH");
equal(
  "and a certification with no issuer stores an empty scheme, not the word null",
  related.certifications[1]?.scheme,
  "",
);
equal("a certification with no expiry has no expiry", related.certifications[1]?.expiresOn, undefined);
equal(
  "the server's expiry state comes across rather than being recomputed",
  related.certifications[0]?.state,
  "expiring_soon",
);

// ── 8. The cursor ───────────────────────────────────────────────────────────

equal("the cursor to store is the one the server sent", plan().nextCursor, "cursor-1");
equal("the sync_state key for it is stable", SYNC_STATE_KEYS.cursor, "pull_cursor");
equal("as is the one for the server's clock", SYNC_STATE_KEYS.lastPulledServerTime, "last_pulled_server_time");
check("a truncated page says come straight back", plan({ truncated: true }).truncated);
check("a first sync says so", plan({ complete: true }).complete);

// ── 9. Unknown columns still sync ───────────────────────────────────────────
//
// `protocol.ts` keeps the record bodies passthrough so a server that adds a
// column does not break every handset on an old build. The planner has to
// honour that: it reads what it knows and ignores the rest.

const futureColumn = plan({
  jobs: [job({ some_column_added_next_year: { nested: true } })],
  scope: { jobIds: ["job-1"] },
});
equal("a job carrying a column this build has never seen still stores", futureColumn.jobs.length, 1);
equal("and the fields it does know are unaffected", futureColumn.jobs[0]?.reference, "JOB-2026-00001");

done("apply-sync");
