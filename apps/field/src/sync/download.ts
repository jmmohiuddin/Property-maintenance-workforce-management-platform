/**
 * The download half of sync, as a decision rather than a write.
 *
 * `GET /api/field/v1/sync` comes back, `parseSyncResponse` turns it into a
 * `SyncResponse`, and this module decides **what the device should hold as a
 * result**: which rows to upsert, with which local column values, and which
 * jobs to let go of. It performs no I/O and imports nothing native, which is
 * why `test/apply-sync.test.ts` can run every rule below under plain `tsx` with
 * no simulator. `applySyncResponse()` in `src/app/sync-runner.ts` is the other
 * half - it takes this plan and performs it, in one WatermelonDB batch, and it
 * is the part no compiler in this repository has ever executed.
 *
 * That split is the same one `engine.ts` uses for the upload half, and it is
 * kept for the same reason: the interesting decisions are the ones worth
 * testing, and they are exactly the ones that do not need a device.
 *
 * ── THREE THINGS THIS FILE EXISTS TO GET RIGHT ─────────────────────────────
 *
 * **1. Absent is not empty, for `taxonomies`.** The route spreads
 * `...(page.taxonomies ? { taxonomies: {…} } : {})`, so an unchanged taxonomy
 * set arrives as a **missing key**, which `syncResponseSchema` renders as
 * `null`. Null means "keep what you have". An object - even one whose four
 * arrays are all empty - means "this is the whole set, replace yours with it".
 * A client that read the first as the second would blank a technician's
 * fault-code picker mid-shift, offline, with no way to get it back until
 * signal. So `SyncPlan.taxonomies` is `null | TaxonomyTermUpsert[]` and the
 * two take different code paths all the way down to the batch.
 *
 * **2. `scope.jobIds` is authoritative membership, not a delta.** A delta
 * protocol cannot express deletion - "absent from a delta" and "unchanged" are
 * the same bytes - so every in-scope job id comes down on every pull, changed
 * or not, and the device drops what is not named. `planRemovals` computes that
 * as "what I hold, minus this", **less any job with unsynced work**. That
 * exception is not a nicety: `domain/working-set.ts` puts the same rule first
 * and unconditional in `evictionDecision`, because deleting a job whose
 * completion is still sitting in the outbox destroys the only copy of a
 * technician's day to reclaim a few kilobytes. A reassignment must never do
 * what a storage cap is forbidden to do.
 *
 * **3. A timestamp is refused rather than stored as `NaN`.** WatermelonDB's
 * `@date`/number columns hold epoch milliseconds, and `Number.NaN` stored in
 * one is the worst outcome available: it reads back as a date, sorts
 * unpredictably, and renders as "Invalid Date" on the one screen a technician
 * uses to plan their morning. `packages/db/src/domain/_rows.ts` makes the same
 * call server-side and says why - *"loud rather than silently null"*. Every
 * timestamp on the way in goes through `parseServerInstant` below, which
 * throws a `SyncApplyError` naming the field rather than letting a bad value
 * reach SQLite. A refused pull is retried; a stored `NaN` is permanent.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT DO ───────────────────────────────────
 *
 * It does not recompute anything the server decided. `job.gaps` is carried
 * through verbatim - including the difference between `null` ("completion is
 * not on the table") and `[]` ("nothing is missing") that `domain/job-card.ts`
 * depends on - and stored as JSON text so all three of its states survive a
 * round trip through SQLite. It does not derive "today" from the device clock,
 * because the server filtered the working set on a **Dubai** calendar day and
 * a device-side `new Date()` disagrees with that for the 22 hours a day when
 * nobody would notice.
 */

import type { SyncResponse } from "./protocol";

/**
 * Keys in the `sync_state` table.
 *
 * Named constants rather than string literals at the call site because the
 * cursor is the one value whose corruption is silent: a device that reads back
 * a key nobody wrote pulls from the beginning of time on every sync and looks
 * merely slow.
 */
export const SYNC_STATE_KEYS = {
  /** `nextCursor` from the last pull that **committed**. */
  cursor: "pull_cursor",
  /** The server's own clock at that pull, ISO-8601. Not the device's. */
  lastPulledServerTime: "last_pulled_server_time",
} as const;

/**
 * A response this build could read but must not store.
 *
 * Distinct from `ProtocolError`, which means the response did not parse at
 * all. This one means it parsed and then said something impossible - a
 * timestamp that is not a timestamp, a job with no id - and the retry story is
 * the same as `ProtocolError`'s: it will fail identically next time, so it is
 * reported rather than retried for ever.
 */
export class SyncApplyError extends Error {
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`The office sent a sync response this app could not store (${field}): ${detail}`);
    this.name = "SyncApplyError";
  }
}

// ── Timestamps ──────────────────────────────────────────────────────────────

/**
 * Postgres' own rendering of a `timestamptz`: `2026-08-22 09:00:00+04`, with a
 * space where ISO-8601 has a `T`.
 *
 * Every timestamp in `FieldSyncPage` goes through `rowDate()` or
 * `requiredRowDate()` server-side and is therefore a real `Date` by the time
 * `NextResponse.json` serialises it, which makes it ISO. **That is a property
 * of today's `pullWorkingSet`, not of the protocol**: `tx.execute<T>()`'s type
 * parameter is an assertion and not a check, so a column added to that query
 * without a `rowDate()` around it would arrive here in this shape with nothing
 * on either side complaining.
 *
 * V8 parses the space form through a lenient fallback; Hermes, which is what
 * this app actually runs on, is stricter and will hand back `NaN`. So the form
 * is recognised and rewritten rather than trusted to `Date.parse`, and the
 * fact that it happened is reported as an anomaly rather than quietly coped
 * with - a server that starts sending raw Postgres strings is a bug somebody
 * needs to hear about, not a case to absorb.
 */
const POSTGRES_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)(.*)$/;

/** A day, `YYYY-MM-DD`, exactly as `to_char(expires_on, 'YYYY-MM-DD')` writes it. */
const SERVER_DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface InstantReading {
  readonly epochMs: number;
  /** Set when the value was not ISO-8601 and had to be repaired to parse. */
  readonly anomaly: string | null;
}

/**
 * One timestamp, or a refusal. Never `NaN`.
 *
 * Returns the reading rather than the number so the caller can collect the
 * anomaly. A repaired timestamp is still stored - dropping a technician's
 * scheduled window because the server spelled it wrong helps nobody standing
 * in a car park - but it is stored *and* named.
 */
export function parseServerInstant(field: string, value: unknown): InstantReading {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SyncApplyError(field, `expected an ISO-8601 timestamp, got ${describe(value)}`);
  }

  let text = value;
  let anomaly: string | null = null;

  const postgres = POSTGRES_TIMESTAMP.exec(value);
  if (postgres) {
    // `+04` is a legal Postgres offset and not a legal ISO one; `+04:00` is
    // both. Widening it here is the difference between a parsed date and a
    // NaN on Hermes.
    const zone = postgres[3] === "" ? "Z" : /^[+-]\d{2}$/.test(postgres[3] ?? "") ? `${postgres[3]}:00` : postgres[3];
    text = `${postgres[1]}T${postgres[2]}${zone}`;
    anomaly = `${field} arrived as a raw Postgres timestamp (${value}), not ISO-8601`;
  }

  const epochMs = Date.parse(text);
  if (!Number.isFinite(epochMs)) {
    throw new SyncApplyError(field, `not a timestamp: ${value}`);
  }
  return { epochMs, anomaly };
}

/**
 * A day-valued column, as epoch milliseconds at **UTC** midnight.
 *
 * `packages/db/src/domain/field.ts` keeps `expiresOn` as `YYYY-MM-DD` end to
 * end on purpose - *"round-tripping it through a `Date` would move an expiry
 * across midnight for any reader in a negative offset, and this is the value
 * that decides whether somebody may be dispatched"*. The local schema declares
 * `certifications.expires_on` as a number, so the device has no choice but to
 * do exactly that round trip.
 *
 * Anchoring at UTC midnight makes it lossless in one direction: a reader that
 * recovers the day with `new Date(ms).toISOString().slice(0, 10)` gets the
 * string back byte for byte. A reader that uses `toLocaleDateString()` or
 * `getDate()` will be a day out west of Greenwich, and that is a real hazard
 * carried by this column rather than solved here. See the report.
 */
export function parseServerDay(field: string, value: unknown): number {
  if (typeof value !== "string" || !SERVER_DAY.test(value)) {
    throw new SyncApplyError(field, `expected YYYY-MM-DD, got ${describe(value)}`);
  }
  const epochMs = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(epochMs)) throw new SyncApplyError(field, `not a date: ${value}`);
  return epochMs;
}

// ── Reading an opaque record ────────────────────────────────────────────────

/**
 * The collections arrive as `Record<string, unknown>` - `protocol.ts` keeps
 * them passthrough so that a column the server adds next year does not fail
 * the sync on a handset nobody has updated. The cost of that is here: every
 * field this build *does* read has to be checked, because "the server sent a
 * number where a string belongs" is now a runtime question.
 */
type Row = Record<string, unknown>;

function requiredText(scope: string, row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value === "") {
    throw new SyncApplyError(`${scope}.${key}`, `expected a non-empty string, got ${describe(value)}`);
  }
  return value;
}

/** Null and absent both mean "no value"; anything else that is not a string is a bug. */
function optionalText(scope: string, row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new SyncApplyError(`${scope}.${key}`, `expected a string or null, got ${describe(value)}`);
  }
  return value;
}

function optionalNumber(scope: string, row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SyncApplyError(`${scope}.${key}`, `expected a finite number or null, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  return `${typeof value} ${JSON.stringify(value)}`;
}

// ── What the plan says to write ─────────────────────────────────────────────

/**
 * One local `jobs` row.
 *
 * `id` is the **server's** job id, and that is load-bearing rather than
 * convenient: `JobListScreen` passes `job.id` to `JobCardScreen`, which queries
 * `job_cards`, `job_photos` and the outbox by it, and `payloads.ts` puts it on
 * the wire as `jobId`. If the local primary key were anything else, every
 * mutation the device sent would name a job the server has never heard of.
 */
export interface JobUpsert {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string | undefined;
  readonly status: string;
  readonly priority: string;
  readonly serviceSlug: string;
  readonly customerId: string;
  readonly propertyId: string;
  readonly assetId: string | undefined;
  readonly visitId: string | undefined;
  /** The technician's own visit window, which is what `FLD-1` orders the list by. */
  readonly scheduledFor: number | undefined;
  readonly scheduledEnd: number | undefined;
  readonly respondByAt: number | undefined;
  readonly resolveByAt: number | undefined;
  /**
   * `FieldJob.gaps`, verbatim, in all three of its states.
   *
   * `undefined` is the fourth state and does not come from the server: it means
   * the key was absent, so this build leaves `gaps_json` exactly as it found
   * it rather than inventing an answer. Today's route always sends the key.
   */
  readonly gaps: readonly string[] | null | undefined;
  /** `updatedAt`, ISO, which is the string the server wants back as `baseVersion`. */
  readonly version: string;
  readonly syncedAt: number;
}

export interface CustomerUpsert {
  readonly id: string;
  readonly name: string;
  readonly phone: string | undefined;
  readonly syncedAt: number;
}

export interface PropertyUpsert {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  /** `addressLine`, `area` and `city` joined: the local schema has one column. */
  readonly address: string;
  readonly accessInstructions: string | undefined;
  readonly lat: number | undefined;
  readonly lng: number | undefined;
  readonly syncedAt: number;
}

export interface AssetUpsert {
  readonly id: string;
  readonly propertyId: string;
  readonly tag: string;
  readonly name: string;
  readonly manufacturer: string | undefined;
  readonly model: string | undefined;
  readonly serialNumber: string | undefined;
  readonly locationNote: string | undefined;
  readonly syncedAt: number;
}

export interface CertificationUpsert {
  readonly id: string;
  readonly scheme: string;
  readonly label: string;
  /** UTC midnight of the `YYYY-MM-DD` the server sent. See `parseServerDay`. */
  readonly expiresOn: number | undefined;
  readonly state: string;
  readonly syncedAt: number;
}

/** The four vocabularies, flattened into the one local table that holds them. */
export type Vocabulary = "faultCodes" | "outcomeCodes" | "photoExemptionReasons" | "rateCard";

export interface TaxonomyTermUpsert {
  readonly id: string;
  readonly vocabulary: Vocabulary;
  /** "symptom" | "cause" | "remedy" for fault codes; absent for the rest. */
  readonly kind: string | undefined;
  readonly code: string;
  readonly label: string;
  readonly description: string | undefined;
  readonly requiresReturnVisit: boolean | undefined;
  readonly sortOrder: number;
  readonly syncedAt: number;
}

export interface SyncPlan {
  /** The server's clock, as sent. Never replaced with the device's. */
  readonly serverTime: string;
  /**
   * What every `synced_at` column gets, taken from `serverTime` rather than
   * from `Date.now()`. The device clock is not trusted anywhere else in this
   * app and there is no reason to start here; more to the point, the working
   * set was filtered on a **Dubai** calendar day and a device-derived stamp
   * compared against it disagrees for the 22 hours a day nobody is looking.
   */
  readonly syncedAt: number;
  readonly nextCursor: string;
  /** The pull hit its page cap: come straight back rather than waiting. */
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly jobs: readonly JobUpsert[];
  readonly customers: readonly CustomerUpsert[];
  readonly properties: readonly PropertyUpsert[];
  readonly assets: readonly AssetUpsert[];
  readonly certifications: readonly CertificationUpsert[];
  /**
   * **Null means keep what is already stored.** A list - including an empty
   * one - means replace the whole table with it. See the header.
   */
  readonly taxonomies: readonly TaxonomyTermUpsert[] | null;
  readonly removeJobIds: readonly string[];
  /** Out of scope, kept anyway, because their work has not reached the office. */
  readonly retainedForUnsyncedWork: readonly string[];
  /** Things worth telling somebody about that were not worth refusing over. */
  readonly anomalies: readonly string[];
}

export interface DeviceHoldings {
  /** Every job id in the local `jobs` table, before this pull. */
  readonly jobIds: readonly string[];
  /** Job ids named by an outbox row that has not reached `done`. */
  readonly jobIdsWithUnsyncedWork: readonly string[];
}

// ── Removals ────────────────────────────────────────────────────────────────

export interface RemovalPlan {
  readonly remove: readonly string[];
  readonly retainedForUnsyncedWork: readonly string[];
}

/**
 * What the device should stop holding.
 *
 * "What I hold, minus what the server just named" - and then the guard.
 *
 * ── THE GUARD IS THE SAME ONE EVICTION USES, AND IT IS FIRST ───────────────
 *
 * `evictionDecision` in `domain/working-set.ts` refuses to touch a job with
 * unsynced work before it looks at anything else, because *"evicting a
 * completed-but-unsynced job would delete the only copy of a day's work to save
 * a few megabytes, which is the one failure this product cannot survive"*. A
 * job falling out of `scope.jobIds` is the same deletion arriving through a
 * different door - a technician reassigned at 11:00 whose morning is still in
 * the outbox - so it obeys the same rule, in the same order.
 *
 * The retained job is not hidden. It stays on the phone until its queue
 * drains, and the next pull that finds it still out of scope removes it then.
 * That is the whole recovery: no tombstone table, no retention window, and no
 * case where a device offline for a fortnight silently keeps a job it should
 * have dropped.
 */
export function planRemovals(
  heldJobIds: readonly string[],
  /**
   * **Undefined is not the same as empty, and the difference is a day's work.**
   *
   * `[]` is the server saying "you have nothing assigned"; emptying the phone
   * is the correct response. `undefined` is the server not having said
   * anything about membership at all - an older build, a proxy that rewrote
   * the body, a response that lost the key - and the only safe reading of
   * silence is "keep what you hold". Treating the second as the first evicts
   * the entire working set on the strength of a missing field.
   */
  scopeJobIds: readonly string[] | undefined,
  jobIdsWithUnsyncedWork: readonly string[],
): RemovalPlan {
  if (scopeJobIds === undefined) return { remove: [], retainedForUnsyncedWork: [] };

  const inScope = new Set(scopeJobIds);
  const unsynced = new Set(jobIdsWithUnsyncedWork);

  const remove: string[] = [];
  const retainedForUnsyncedWork: string[] = [];

  for (const jobId of heldJobIds) {
    if (inScope.has(jobId)) continue;
    if (unsynced.has(jobId)) retainedForUnsyncedWork.push(jobId);
    else remove.push(jobId);
  }

  return { remove, retainedForUnsyncedWork };
}

// ── The plan ────────────────────────────────────────────────────────────────

/**
 * Turn a parsed sync response into the writes it implies.
 *
 * Throws `SyncApplyError` rather than returning a partial plan. A pull that
 * cannot be stored in full must not be stored in part: the cursor would then
 * advance past rows the device never wrote, and nothing would ever fetch them
 * again. `applySyncResponse` performs the whole plan or none of it, and this
 * builds the whole plan or none of it, for the same reason.
 */
export function planSyncApply(response: SyncResponse, holdings: DeviceHoldings): SyncPlan {
  const anomalies: string[] = [];
  const serverTimeReading = parseServerInstant("serverTime", response.serverTime);
  if (serverTimeReading.anomaly) anomalies.push(serverTimeReading.anomaly);
  const syncedAt = serverTimeReading.epochMs;

  const instant = (field: string, value: unknown): number | undefined => {
    if (value === null || value === undefined) return undefined;
    const reading = parseServerInstant(field, value);
    if (reading.anomaly) anomalies.push(reading.anomaly);
    return reading.epochMs;
  };

  const jobs = response.jobs.map((row): JobUpsert => {
    const id = requiredText("jobs", row, "id");
    const scope = `jobs[${id}]`;
    return {
      id,
      reference: requiredText(scope, row, "reference"),
      title: requiredText(scope, row, "title"),
      description: optionalText(scope, row, "description"),
      status: requiredText(scope, row, "status"),
      priority: requiredText(scope, row, "priority"),
      serviceSlug: requiredText(scope, row, "serviceSlug"),
      customerId: requiredText(scope, row, "customerId"),
      propertyId: requiredText(scope, row, "propertyId"),
      assetId: optionalText(scope, row, "assetId"),
      visitId: optionalText(scope, row, "visitId"),
      // The local pair is a *window*, and the only window the server sends is
      // the technician's own visit (`visitScheduledStart`/`visitScheduledEnd`,
      // from the LATERAL that picks their latest visit on the job). The job's
      // own `scheduledFor` is the fallback for a job dispatch has placed in the
      // day without yet giving this technician a visit - without it, an open
      // job would sort to the top of the list under "No time set".
      scheduledFor:
        instant(`${scope}.visitScheduledStart`, row["visitScheduledStart"]) ??
        instant(`${scope}.scheduledFor`, row["scheduledFor"]),
      scheduledEnd: instant(`${scope}.visitScheduledEnd`, row["visitScheduledEnd"]),
      respondByAt: instant(`${scope}.respondByAt`, row["respondByAt"]),
      resolveByAt: instant(`${scope}.resolveByAt`, row["resolveByAt"]),
      gaps: readGaps(scope, row),
      version: requiredIsoText(scope, row, "updatedAt", anomalies),
      syncedAt,
    };
  });

  const customers = response.customers.map((row): CustomerUpsert => {
    const id = requiredText("customers", row, "id");
    const scope = `customers[${id}]`;
    return {
      id,
      name: requiredText(scope, row, "name"),
      phone: optionalText(scope, row, "phone"),
      syncedAt,
    };
  });

  const properties = response.properties.map((row): PropertyUpsert => {
    const id = requiredText("properties", row, "id");
    const scope = `properties[${id}]`;
    return {
      id,
      customerId: requiredText(scope, row, "customerId"),
      name: requiredText(scope, row, "name"),
      // Three server columns, one local one. Joining rather than storing only
      // `addressLine` because the emirate is how a technician finds a building
      // they have never been to, and dropping it to fit the schema would be the
      // device losing data it was sent.
      address: [
        requiredText(scope, row, "addressLine"),
        optionalText(scope, row, "area"),
        optionalText(scope, row, "city"),
      ]
        .filter((part): part is string => typeof part === "string" && part.trim() !== "")
        .join(", "),
      accessInstructions: optionalText(scope, row, "accessInstructions"),
      lat: optionalNumber(scope, row, "lat"),
      lng: optionalNumber(scope, row, "lng"),
      syncedAt,
    };
  });

  const assets = response.assets.map((row): AssetUpsert => {
    const id = requiredText("assets", row, "id");
    const scope = `assets[${id}]`;
    return {
      id,
      propertyId: requiredText(scope, row, "propertyId"),
      tag: requiredText(scope, row, "tag"),
      name: requiredText(scope, row, "name"),
      manufacturer: optionalText(scope, row, "manufacturer"),
      model: optionalText(scope, row, "model"),
      serialNumber: optionalText(scope, row, "serialNumber"),
      // `FieldAsset.location` - "Basement plant room 2". The local column is
      // `location_note`; the two are the same thing under different names.
      locationNote: optionalText(scope, row, "location"),
      syncedAt,
    };
  });

  const certifications = response.certifications.map((row): CertificationUpsert => {
    const id = requiredText("certifications", row, "id");
    const scope = `certifications[${id}]`;
    const expiresOn = row["expiresOn"];
    return {
      id,
      // `FieldCertification.issuer` is nullable and the local column is not.
      // An empty string is the honest rendering of "the office did not record
      // one" - it shows as blank rather than as a scheme nobody issued.
      scheme: optionalText(scope, row, "issuer") ?? "",
      label: requiredText(scope, row, "name"),
      expiresOn:
        expiresOn === null || expiresOn === undefined
          ? undefined
          : parseServerDay(`${scope}.expiresOn`, expiresOn),
      // Server-computed against the server's clock. Re-derivable on the device
      // from `expires_on` via `certState()` so an expiry that passes at
      // midnight while the phone is offline still reads as expired.
      state: requiredText(scope, row, "state"),
      syncedAt,
    };
  });

  const removals = planRemovals(
    holdings.jobIds,
    response.scope?.jobIds,
    holdings.jobIdsWithUnsyncedWork,
  );

  return {
    serverTime: response.serverTime,
    syncedAt,
    nextCursor: response.nextCursor,
    truncated: response.truncated,
    complete: response.complete,
    jobs,
    customers,
    properties,
    assets,
    certifications,
    // `null` here is the whole point - see the header. It reaches the batch as
    // "touch nothing", and an empty array reaches it as "delete everything".
    taxonomies: response.taxonomies === null ? null : planTaxonomies(response.taxonomies, syncedAt),
    removeJobIds: removals.remove,
    retainedForUnsyncedWork: removals.retainedForUnsyncedWork,
    anomalies,
  };
}

/**
 * `updatedAt` becomes `jobs.version`, which is sent straight back to the server
 * as `baseVersion` on the next optimistic write. So it is stored as the string
 * the server sent, not as a re-serialised `Date` - a round trip through
 * `toISOString()` would change `+04:00` into `Z` and turn an equality check on
 * the server into a mismatch. It is still *parsed*, because a `version` that is
 * not a timestamp would be refused later, at the point where refusing costs a
 * technician their write.
 */
function requiredIsoText(scope: string, row: Row, key: string, anomalies: string[]): string {
  const value = requiredText(scope, row, key);
  const reading = parseServerInstant(`${scope}.${key}`, value);
  if (reading.anomaly) anomalies.push(reading.anomaly);
  return value;
}

/**
 * `gaps`, with all four states kept apart.
 *
 * `undefined` (key absent) is "the device has never been told"; `null` is
 * "completion is not on the table"; `[]` is "nothing is missing"; a list is the
 * outstanding conditions. `domain/job-card.ts`'s `completionReadiness()` is
 * built on exactly this distinction and `canAttemptCompletion` returns true for
 * precisely one of the four, so collapsing any pair here would put a live
 * complete button on a job nobody has arrived at.
 */
function readGaps(scope: string, row: Row): readonly string[] | null | undefined {
  const value = row["gaps"];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new SyncApplyError(`${scope}.gaps`, `expected a list of strings or null, got ${describe(value)}`);
  }
  return value as readonly string[];
}

/**
 * The four vocabularies, flattened.
 *
 * They arrive whole or not at all, so the local table is replaced wholesale by
 * whatever this returns. Two of the four - `photoExemptionReasons` and
 * `rateCard` - carry no sort order of their own through the domain layer, so
 * the array index stands in for one: the server ordered them (`order by
 * sort_order, label`) and the index is that order made durable.
 */
function planTaxonomies(
  taxonomies: NonNullable<SyncResponse["taxonomies"]>,
  syncedAt: number,
): readonly TaxonomyTermUpsert[] {
  const terms: TaxonomyTermUpsert[] = [];

  taxonomies.faultCodes.forEach((row, index) => {
    const id = requiredText("taxonomies.faultCodes", row, "id");
    const scope = `taxonomies.faultCodes[${id}]`;
    terms.push({
      id,
      vocabulary: "faultCodes",
      // "symptom" | "cause" | "remedy" - `JOB-14`'s three-part taxonomy, and
      // the reason `taxonomy_terms.kind` is indexed.
      kind: requiredText(scope, row, "kind"),
      code: requiredText(scope, row, "code"),
      label: requiredText(scope, row, "label"),
      description: optionalText(scope, row, "description"),
      requiresReturnVisit: undefined,
      sortOrder: optionalNumber(scope, row, "sortOrder") ?? index,
      syncedAt,
    });
  });

  taxonomies.outcomeCodes.forEach((row, index) => {
    const id = requiredText("taxonomies.outcomeCodes", row, "id");
    const scope = `taxonomies.outcomeCodes[${id}]`;
    const requiresReturnVisit = row["requiresReturnVisit"];
    terms.push({
      id,
      vocabulary: "outcomeCodes",
      kind: undefined,
      code: requiredText(scope, row, "code"),
      label: requiredText(scope, row, "label"),
      description: optionalText(scope, row, "description"),
      requiresReturnVisit: typeof requiresReturnVisit === "boolean" ? requiresReturnVisit : undefined,
      sortOrder: optionalNumber(scope, row, "sortOrder") ?? index,
      syncedAt,
    });
  });

  taxonomies.photoExemptionReasons.forEach((row, index) => {
    const id = requiredText("taxonomies.photoExemptionReasons", row, "id");
    const scope = `taxonomies.photoExemptionReasons[${id}]`;
    terms.push({
      id,
      vocabulary: "photoExemptionReasons",
      kind: undefined,
      code: requiredText(scope, row, "code"),
      label: requiredText(scope, row, "label"),
      description: optionalText(scope, row, "description"),
      requiresReturnVisit: undefined,
      // `listPhotoExemptionReasons` selects `sort_order` and then drops it from
      // the row it returns, so there is nothing to read. The server's ordering
      // is the only ordering that exists, and the index is it.
      sortOrder: index,
      syncedAt,
    });
  });

  taxonomies.rateCard.forEach((row, index) => {
    const id = requiredText("taxonomies.rateCard", row, "id");
    const scope = `taxonomies.rateCard[${id}]`;
    terms.push({
      id,
      vocabulary: "rateCard",
      kind: undefined,
      code: requiredText(scope, row, "code"),
      label: requiredText(scope, row, "label"),
      // `RateCardRow.notes`. **The price is deliberately not stored, and there
      // is nowhere to put it if it were.** `taxonomy_terms` has no money
      // column and `parts` drops its price on purpose - `working-set.ts`
      // declares `price_list` online-only so *"the device cannot quote a stale
      // number"*, and `domain/attendance.ts` says the office applies rate bands
      // because a device that priced labour offline would disagree with the
      // invoice. What is kept is the vocabulary: the code and the label.
      description: optionalText(scope, row, "notes"),
      requiresReturnVisit: undefined,
      sortOrder: index,
      syncedAt,
    });
  });

  return terms;
}
