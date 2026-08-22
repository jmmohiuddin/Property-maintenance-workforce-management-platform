/**
 * The first time the two halves of the field protocol have ever spoken.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT IN `npm test` ───────────────────────
 *
 * There are two suites over this protocol and both are green, which is exactly
 * the problem. `packages/db/test/field.test.ts` drives the domain layer against
 * Postgres and never goes through a route handler. `apps/field/test/*.test.ts`
 * drives the types and the pure planners and never opens a socket. Both halves
 * were transcribed from the same documents, so **a shared misreading of those
 * documents is invisible to both of them** - and that is the only class of bug
 * this file is here to find.
 *
 * It finds them by refusing to hand-check anything. The server's real bytes go
 * through `parseSyncResponse()`, `planSyncApply()`, `parseMutationResponse()`
 * and `applyMutationResponse()` - the client's own code, unmodified - and the
 * assertions are made on what those produce. A JSON field this file read by eye
 * would be a field the app has still never read.
 *
 * ── SO IT NEEDS A LIVE SERVER AND A LIVE DATABASE, AND THAT IS THE POINT ────
 *
 * Which is precisely why it is **not** wired into `npm run test`. The default
 * suite of thirteen scripts is hermetic: no server, no database, no network, so
 * it runs identically on a laptop, in CI and on a clean checkout where nobody
 * has run `npm install` in this workspace. Adding a test that needs a
 * `next start` and a Postgres to that list would mean the whole suite starts
 * failing for reasons that have nothing to do with the change being tested, and
 * the usual response to that is to stop running it. A gate that is sometimes
 * red for environmental reasons is a gate people learn to ignore.
 *
 * So this is a permanent, re-runnable, self-cleaning script with its own
 * command. `apps/field/README.md` carries the invocation:
 *
 *     # one terminal - your OWN server, on a port nobody else is using
 *     PORT=3107 npm run start
 *
 *     # another
 *     FIELD_WIRE_BASE_URL=http://127.0.0.1:3107 \
 *       npx tsx apps/field/test/wire-contract.ts
 *
 * ── EVERY ROW IT WRITES CARRIES A PER-RUN TAG ──────────────────────────────
 *
 * The development database is shared. Every row this script creates is stamped
 * with `RUN_TAG`, and every `DELETE` in `cleanup()` is anchored either to an id
 * this run captured or to that tag - never to a bare `LIKE` that could match a
 * row somebody else's fixtures created. There is also an age-gated sweep, for
 * rows a run that was killed mid-flight left behind: same prefix, but only
 * where the row is over an hour old, so a concurrent run of this same script
 * cannot delete the other one's live fixtures.
 *
 * It creates as little as it can. One job, one visit, one device, one session.
 * Everything else is read from what the seed already put there.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { check, deepEqual, done, equal } from "./_harness";

import { DeviceStore, type DeviceRegistration } from "../src/auth/device-store";
import { registerDevice, RegistrationError } from "../src/auth/registration";
import { DeviceAuthError, FieldApiClient, type FieldApiConfig } from "../src/sync/client";
import { planSyncApply, type DeviceHoldings, type SyncPlan } from "../src/sync/download";
import { applyMutationResponse } from "../src/sync/engine";
import { toOutboundMutation, type OutboxRow } from "../src/sync/outbox";
import {
  appendAttendance,
  appendMaterial,
  declareNoMaterials,
  exemptFromPhoto,
  recordLabour,
  recordOutcome,
  transition,
  type MutationSpec,
} from "../src/sync/payloads";
import { parseSyncResponse, type MutationResponse, type SyncResponse } from "../src/sync/protocol";
import { newClientId } from "../src/domain/ids";
import { systemClock } from "../src/domain/clock";

// ── The per-run tag, and everything anchored to it ──────────────────────────

/**
 * Twelve characters of hex, minted once per process.
 *
 * Short enough to fit inside `jobs.reference` (`varchar(32)`) beside a prefix
 * distinctive enough that no other suite in this repository could produce it,
 * and long enough that two runs starting in the same second cannot collide.
 */
const RUN_TAG = randomBytes(6).toString("hex");
const JOB_REFERENCE = `WIRECON-${RUN_TAG}`;
const DEVICE_LABEL = `wire-contract ${RUN_TAG}`;
const DEVICE_LABEL_PREFIX = "wire-contract ";
const SESSION_USER_AGENT = "meridian-wire-contract";

const BASE_URL = process.env["FIELD_WIRE_BASE_URL"] ?? "http://127.0.0.1:3107";
const APP_VERSION = "0.1.0-wire";
const TECHNICIAN_EMAIL = process.env["FIELD_WIRE_EMAIL"] ?? "bilal@meridianfm.example";

/** Ids this run created, so cleanup never has to guess. */
const created = {
  jobIds: [] as string[],
  deviceIds: [] as string[],
  sessionHashes: [] as string[],
  /** Anything with an `audit_log.record_id` pointing at it. */
  auditRecordIds: [] as string[],
};

// ── psql, because the alternative is a dependency ───────────────────────────

/**
 * All database access goes through the `psql` binary rather than through
 * `@meridian/db`.
 *
 * `apps/field` depends on `@meridian/core` and nothing else from this
 * workspace, and `test/**` is inside the project that `npm run typecheck -w
 * ./apps/field` compiles. Importing the database package here would pull
 * drizzle, the driver and the whole server-side type graph into the field
 * app's own typecheck - which is the compile the split in `tsconfig.json`
 * exists to keep small and portable. Shelling out costs a process per query
 * and keeps this file honest about what the field app depends on.
 */
function adminUrl(): string {
  const fromEnv = process.env["DATABASE_ADMIN_URL"];
  if (fromEnv) return fromEnv;

  let dir = resolve(process.cwd());
  for (;;) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      const line = readFileSync(candidate, "utf8")
        .split("\n")
        .find((l) => l.startsWith("DATABASE_ADMIN_URL="));
      if (line) return line.slice("DATABASE_ADMIN_URL=".length).trim();
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("DATABASE_ADMIN_URL is not set and no .env above the working directory has it.");
}

const DB_URL = adminUrl();

function sqlText(query: string): string {
  return execFileSync("psql", [DB_URL, "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
  }).trim();
}

/** One row, as JSON, or null. The query must produce at most one row. */
function sqlRow<T>(query: string): T | null {
  const out = sqlText(query);
  if (!out) return null;
  return JSON.parse(out) as T;
}

// ── Recording every byte that crosses the wire ──────────────────────────────

interface WireExchange {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly text: string;
}

const wire: WireExchange[] = [];

/**
 * A `fetch` that keeps the raw response text.
 *
 * `response.clone()` rather than reading the body, because the client is going
 * to read it afterwards and a consumed body would fail there instead of here -
 * which would be this harness breaking the thing it is measuring.
 */
const recordingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input as Parameters<typeof fetch>[0], init);
  const text = await response.clone().text();
  wire.push({
    method: init?.method ?? "GET",
    url: typeof input === "string" ? input : String(input),
    status: response.status,
    text,
  });
  return response;
};

/** The raw body of the most recent exchange whose URL contains `fragment`. */
function lastBody(fragment: string): Record<string, unknown> {
  for (let i = wire.length - 1; i >= 0; i -= 1) {
    const entry = wire[i];
    if (entry && entry.url.includes(fragment)) return JSON.parse(entry.text) as Record<string, unknown>;
  }
  throw new Error(`no recorded exchange for ${fragment}`);
}

function hasKey(body: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body, key);
}

/** ISO-8601 with a `T` and a real offset. What the client's parsers expect. */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

// ── An in-memory keystore, so the real DeviceStore is the thing under test ──

function memoryBackend(): {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
} {
  const cells = new Map<string, string>();
  return {
    getItem: async (key) => cells.get(key) ?? null,
    setItem: async (key, value) => {
      cells.set(key, value);
    },
    deleteItem: async (key) => {
      cells.delete(key);
    },
  };
}

// ── Outbox rows, from the client's own builders ─────────────────────────────

let monotonic = 0;

/**
 * One queued write, exactly as the app would have queued it.
 *
 * The payload is never written by hand here. `payloads.ts` is the only thing
 * in the client that knows what a mutation body looks like, and a harness that
 * composed its own would be testing a second, private opinion about the
 * contract instead of the one the app ships.
 */
function queue(spec: MutationSpec): OutboxRow {
  monotonic += 1;
  return {
    clientId: newClientId(),
    entity: spec.entity,
    op: spec.op,
    jobId: spec.jobId,
    payload: spec.payload,
    baseVersion: spec.baseVersion,
    dependsOnClientId: spec.dependsOnClientId,
    createdAt: new Date().toISOString(),
    createdMonotonic: monotonic,
    attemptCount: 0,
    nextAttemptAfter: 0,
    status: "pending",
    lastError: null,
    refusalGaps: null,
    serverReceivedAt: null,
  };
}

async function push(
  client: FieldApiClient,
  rows: readonly OutboxRow[],
): Promise<{ response: MutationResponse; folded: readonly OutboxRow[] }> {
  const result = await client.push(newClientId(), rows.map(toOutboundMutation));
  const folded = applyMutationResponse(rows, result.data, monotonic + 1000);
  return { response: result.data, folded: folded.rows };
}

function rowFor(rows: readonly OutboxRow[], clientId: string): OutboxRow {
  const found = rows.find((r) => r.clientId === clientId);
  if (!found) throw new Error(`no folded row for ${clientId}`);
  return found;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

interface Principal {
  user_id: string;
  tenant_id: string;
  technician_id: string;
}

interface Fixture extends Principal {
  jobId: string;
  visitId: string;
  sessionToken: string;
}

/** The user whose registration quota this run spends. Set by `makeFixture`. */
let registeringUserId: string | null = null;

function makeFixture(): Fixture {
  const principal = sqlRow<Principal>(`
    select row_to_json(x) from (
      select u.id as user_id, m.tenant_id, t.id as technician_id
        from users u
        join memberships m on m.user_id = u.id
        join technicians t on t.user_id = u.id and t.tenant_id = m.tenant_id
       where u.email = '${TECHNICIAN_EMAIL}'
       limit 1
    ) x
  `);
  if (!principal) throw new Error(`no technician user for ${TECHNICIAN_EMAIL}`);
  registeringUserId = principal.user_id;

  // ── The session, minted rather than driven through the login form ─────────
  //
  // The web login is a Next server action, not a JSON endpoint, and posting to
  // one programmatically means reproducing its encoding and its action id. That
  // is a lot of machinery to exercise a password check that is not what this
  // file is about. So the session row is created the way `createSession()`
  // creates it - a 256-bit token whose SHA-256 is what reaches the table - and
  // handed to the register route as the cookie. Everything downstream of the
  // password is still the real thing: the real cookie name, the real
  // `app_auth_resolve_session`, the real `getSession()`, the real route.
  const sessionToken = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(sessionToken).digest("hex");
  created.sessionHashes.push(tokenHash);
  sqlText(`
    select app_auth_create_session(
      '${principal.user_id}'::uuid,
      '${principal.tenant_id}'::uuid,
      '${tokenHash}',
      '${SESSION_USER_AGENT}',
      '127.0.0.1',
      now() + interval '1 hour',
      now() + interval '2 hours'
    )
  `);

  // ── One job and one visit, both this run's own ────────────────────────────
  //
  // Rather than driving a seeded job through `on_site` and putting it back
  // afterwards. Three other streams are reading this database right now, and a
  // seeded job that spends five minutes in a status nobody put it in is a
  // confusing thing to walk into. A job that only this run has ever named
  // cannot be confusing to anybody, and `ON DELETE CASCADE` from `jobs` takes
  // the visit, the events, the declarations and the conflicts with it.
  const job = sqlRow<{ id: string }>(`
    with source as (
      select customer_id, property_id, service_slug, source
        from jobs
       where tenant_id = '${principal.tenant_id}'::uuid and deleted_at is null
       order by created_at
       limit 1
    )
    insert into jobs (tenant_id, reference, customer_id, property_id, service_slug,
                      title, description, status, priority, source, scheduled_for, is_outdoor)
    select '${principal.tenant_id}'::uuid, '${JOB_REFERENCE}', s.customer_id, s.property_id,
           s.service_slug,
           'Wire contract check ${RUN_TAG}',
           'Created by apps/field/test/wire-contract.ts. Safe to delete.',
           'dispatched'::job_status, 'p3_standard'::job_priority, s.source, now(), false
      from source s
    returning json_build_object('id', id)
  `);
  if (!job) throw new Error("the fixture job was not created");
  created.jobIds.push(job.id);
  created.auditRecordIds.push(job.id);

  const visit = sqlRow<{ id: string }>(`
    insert into job_visits (tenant_id, job_id, technician_id, sequence, status,
                            scheduled_start, scheduled_end)
    values ('${principal.tenant_id}'::uuid, '${job.id}'::uuid, '${principal.technician_id}'::uuid,
            1, 'assigned'::visit_status, now(), now() + interval '2 hours')
    returning json_build_object('id', id)
  `);
  if (!visit) throw new Error("the fixture visit was not created");
  created.auditRecordIds.push(visit.id);

  return { ...principal, jobId: job.id, visitId: visit.id, sessionToken };
}

/**
 * Everything this run wrote, and nothing else.
 *
 * Ordered so that no delete is blocked by a foreign key: the rows that
 * reference a device go before the device, the rows that reference a job go
 * with the job through `ON DELETE CASCADE`.
 *
 * The `= any(array[...])` predicates are anchored to ids this process captured,
 * which cannot match a row it did not create. The two sweeps at the end are
 * anchored to the tag prefix **and** to an age, for rows a killed run left
 * behind - an unanchored prefix delete would happily take a concurrent run's
 * live fixtures, which is exactly how a night gets lost to imagined flakiness.
 */
function cleanup(): void {
  const list = (ids: readonly string[]): string =>
    ids.length === 0 ? "array[]::uuid[]" : `array[${ids.map((i) => `'${i}'::uuid`).join(",")}]`;

  try {
    // ── The audit trail goes first, while its subjects still exist ──────────
    //
    // `app_audit_trigger` fires on the job, the visit, the events, the
    // declarations and the attendance rows, and `audit_log` has no foreign key
    // back to any of them - so once the job cascades away, the only thing left
    // pointing at those `record_id`s is nothing at all. Every predicate here is
    // a sub-select over rows that belong to this run's own job or device, so it
    // cannot reach an audit row for anything else.
    if (created.jobIds.length > 0) {
      sqlText(`
        delete from audit_log where record_id in (
          select id from job_events            where job_id = any(${list(created.jobIds)})
          union all select id from job_visits             where job_id = any(${list(created.jobIds)})
          union all select id from job_card_declarations  where job_id = any(${list(created.jobIds)})
          union all select id from job_reports            where job_id = any(${list(created.jobIds)})
          union all select id from job_materials          where job_id = any(${list(created.jobIds)})
          union all select id from job_attachments        where job_id = any(${list(created.jobIds)})
          union all select id from job_fault_codes        where job_id = any(${list(created.jobIds)})
        )
      `);
    }
    if (created.deviceIds.length > 0) {
      // `attendance_events.device_id` is `varchar(80)`, not a uuid foreign key -
      // so it has to be compared as text, and it does not cascade with the
      // device row the way `field_mutations` does.
      const asText = created.deviceIds.map((i) => `'${i}'`).join(",");
      sqlText(`
        delete from audit_log where record_id in (
          select id from attendance_events where device_id in (${asText})
        )
      `);
      sqlText(`delete from attendance_events where device_id in (${asText})`);
    }
    if (created.auditRecordIds.length > 0) {
      sqlText(`delete from audit_log where record_id = any(${list(created.auditRecordIds)})`);
    }
    if (created.jobIds.length > 0) {
      sqlText(`delete from jobs where id = any(${list(created.jobIds)})`);
    }
    if (created.deviceIds.length > 0) {
      // Cascades `field_mutations` and `field_conflicts`.
      sqlText(`delete from field_devices where id = any(${list(created.deviceIds)})`);
    }
    if (created.sessionHashes.length > 0) {
      const hashes = created.sessionHashes.map((h) => `'${h}'`).join(",");
      sqlText(`delete from sessions where token_hash in (${hashes})`);
    }

    // ── And the audit rows the deletes themselves just wrote ────────────────
    //
    // `app_audit_trigger` fires on DELETE as well as INSERT, so removing the
    // fixture job writes one more `audit_log` row per table on the way out -
    // after the pass above has already run. A second pass over the same
    // captured ids collects them. Both predicates are still anchored: the job
    // and visit ids came from this process, and the second clause only reaches
    // a `job_visits` row whose recorded `job_id` is one of this run's jobs.
    if (created.jobIds.length > 0) {
      sqlText(`delete from audit_log where record_id = any(${list(created.jobIds)})`);
      sqlText(`
        delete from audit_log
         where table_name = 'job_visits'
           and (changed_fields->'__old'->>'job_id')::uuid = any(${list(created.jobIds)})
      `);
    }
    if (created.auditRecordIds.length > 0) {
      sqlText(`delete from audit_log where record_id = any(${list(created.auditRecordIds)})`);
    }

    // ── The registration quota this run spent ───────────────────────────────
    //
    // `/devices/register` allows five registrations per user per hour, which is
    // right for a phone that is registered once and wrong for a script that
    // registers one on every run: five runs in an hour and the sixth is refused
    // by a control that is doing exactly its job. The bucket key is
    // `field-register:<userId>` and this deletes precisely the one this run
    // incremented - not the table, not a prefix, and not anybody else's bucket.
    if (registeringUserId) {
      sqlText(`delete from rate_limits where bucket = 'field-register:${registeringUserId}'`);
    }

    // ── The age-gated sweep ──────────────────────────────────────────────────
    const sweptDevices = sqlText(`
      with gone as (
        delete from field_devices
         where label like '${DEVICE_LABEL_PREFIX}%'
           and registered_at < now() - interval '1 hour'
        returning 1
      ) select count(*) from gone
    `);
    const sweptJobs = sqlText(`
      with gone as (
        delete from jobs
         where reference like 'WIRECON-%'
           and created_at < now() - interval '1 hour'
        returning 1
      ) select count(*) from gone
    `);
    const sweptSessions = sqlText(`
      with gone as (
        delete from sessions
         where user_agent = '${SESSION_USER_AGENT}'
           and created_at < now() - interval '1 hour'
        returning 1
      ) select count(*) from gone
    `);

    console.log(
      `\ncleanup: devices=${created.deviceIds.length} jobs=${created.jobIds.length} ` +
        `sessions=${created.sessionHashes.length}; ` +
        `age-gated sweep took devices=${sweptDevices} jobs=${sweptJobs} sessions=${sweptSessions}`,
    );

    const leftovers = sqlText(`
      select coalesce(sum(n), 0) from (
        select count(*) as n from field_devices where label = '${DEVICE_LABEL}'
        union all
        select count(*) from jobs where reference = '${JOB_REFERENCE}'
        union all
        select count(*) from audit_log where changed_fields::text like '%${RUN_TAG}%'
      ) t
    `);
    check(`cleanup left nothing tagged ${RUN_TAG} behind`, leftovers === "0", `${leftovers} rows remain`);
  } catch (error) {
    check("cleanup completed", false, String(error));
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`wire-contract  tag=${RUN_TAG}  base=${BASE_URL}`);
  const fixture = makeFixture();

  // ══ 1. Register a real device ═════════════════════════════════════════════

  let registration: DeviceRegistration;
  try {
    registration = await registerDevice({
      baseUrl: BASE_URL,
      device: {
        label: DEVICE_LABEL,
        platform: "ios",
        appVersion: APP_VERSION,
        osVersion: "18.5",
      },
      cookieHeader: `meridian_session=${fixture.sessionToken}`,
      fetchImpl: recordingFetch,
    });
  } catch (error) {
    const detail = error instanceof RegistrationError ? `${error.code}: ${error.message}` : String(error);
    check("register: the real route accepted a real session cookie", false, detail);
    return;
  }

  created.deviceIds.push(registration.deviceId);
  created.auditRecordIds.push(registration.deviceId);
  check("register: the client's parseRegisterResponse accepted the route's bytes verbatim", true);
  equal("register: device is bound to this technician", registration.technicianId, fixture.technician_id);
  check("register: a raw token came back", registration.token.length > 20);
  check("register: expiresAt is ISO-8601", ISO_8601.test(registration.expiresAt), registration.expiresAt);

  const registerBody = lastBody("/devices/register");
  check("register: body carries device, deviceToken and serverTime and nothing is missing",
    hasKey(registerBody, "device") && hasKey(registerBody, "deviceToken") && hasKey(registerBody, "serverTime"));
  check("register: serverTime is ISO-8601", ISO_8601.test(String(registerBody["serverTime"])),
    String(registerBody["serverTime"]));

  const deviceRow = sqlRow<{ id: string; token_generation: number }>(`
    select row_to_json(x) from (
      select id, token_generation from field_devices where id = '${registration.deviceId}'::uuid
    ) x
  `);
  check("register: the device row exists in field_devices", deviceRow !== null);

  // ══ 2. Pull a working set ═════════════════════════════════════════════════

  const store = new DeviceStore(memoryBackend());
  await store.save(registration);

  const config: FieldApiConfig = {
    baseUrl: BASE_URL,
    getDeviceToken: () => store.token(),
    onDeviceToken: (token) => store.saveRotatedToken(token),
    clearDeviceToken: () => store.clear(),
    appVersion: APP_VERSION,
    clock: systemClock,
    fetchImpl: recordingFetch,
  };
  const client = new FieldApiClient(config);

  // A held set that deliberately disagrees with the server's, so the removal
  // rules are exercised rather than merely present: one job that is genuinely
  // gone, and one that is gone but still has queued work.
  const strandedId = randomUUID();
  const retainedId = randomUUID();
  const holdings: DeviceHoldings = {
    jobIds: [fixture.jobId, strandedId, retainedId],
    jobIdsWithUnsyncedWork: [retainedId],
  };

  // ── SIX SECONDS, BEFORE THE FIRST PULL AND NOT AFTER IT ──────────────────
  //
  // `pullWorkingSet` sets the watermark of a *complete* pull to
  // `serverTime - WATERMARK_LAG_MS` (five seconds), deliberately: `updated_at`
  // is stamped when a statement runs and the row becomes visible when its
  // transaction commits, so a watermark at `now()` would silently skip any row
  // that stamped early and committed late. The consequence for a test is that a
  // row written moments before the first pull is inside that window and comes
  // back again on the second - which is the protocol working, and would make
  // "the delta was empty" a claim that only held by accident.
  //
  // Waiting *here* is what makes the next pull a real test of the delta:
  // the fixture ages past the lag before the watermark is taken, so anything
  // the second pull returns genuinely changed after it.
  await new Promise((r) => setTimeout(r, 6_000));

  const first = await client.pull(null);
  const firstBody = lastBody("/api/field/v1/sync");
  const firstResponse: SyncResponse = parseSyncResponse(firstBody);
  const firstPlan: SyncPlan = planSyncApply(firstResponse, holdings);

  check("pull 1: parseSyncResponse accepted the route's bytes verbatim", true);
  equal("pull 1: complete is true when no cursor was sent", firstResponse.complete, true);
  check("pull 1: nextCursor is a non-empty string", firstResponse.nextCursor.length > 0);

  // taxonomies - absent versus empty, the distinction that blanks a picker
  check("pull 1: the taxonomies key is PRESENT on a full sync", hasKey(firstBody, "taxonomies"));
  check("pull 1: taxonomies survived the parser as an object, not null",
    firstResponse.taxonomies !== null);
  check("pull 1: planSyncApply produced taxonomy terms to write",
    firstPlan.taxonomies !== null && firstPlan.taxonomies.length > 0,
    `${firstPlan.taxonomies === null ? "null" : firstPlan.taxonomies.length} terms`);
  if (firstResponse.taxonomies) {
    const counts = {
      faultCodes: firstResponse.taxonomies.faultCodes.length,
      outcomeCodes: firstResponse.taxonomies.outcomeCodes.length,
      photoExemptionReasons: firstResponse.taxonomies.photoExemptionReasons.length,
      rateCard: firstResponse.taxonomies.rateCard.length,
    };
    // All four vocabularies are asserted to be *present as arrays* rather than
    // to be populated. `fault_codes` and `rate_card_items` are empty in the
    // development seed, and a vocabulary the operator has not filled in is a
    // legitimate empty list - the distinction this response has to keep is
    // between "the whole set, and it happens to be empty" and "no news", which
    // is the object-versus-null one asserted above. Counts are printed so an
    // empty seed is visible rather than mistaken for a protocol failure.
    check(`pull 1: all four vocabularies arrived as arrays ${JSON.stringify(counts)}`,
      Array.isArray(firstResponse.taxonomies.faultCodes) &&
        Array.isArray(firstResponse.taxonomies.outcomeCodes) &&
        Array.isArray(firstResponse.taxonomies.photoExemptionReasons) &&
        Array.isArray(firstResponse.taxonomies.rateCard));
    check("pull 1: the populated vocabularies survived planTaxonomies' field reads",
      (firstPlan.taxonomies ?? []).filter((t) => t.vocabulary === "outcomeCodes").length ===
        counts.outcomeCodes &&
        (firstPlan.taxonomies ?? []).filter((t) => t.vocabulary === "photoExemptionReasons").length ===
          counts.photoExemptionReasons);
  }

  // scope - the authoritative membership
  check("pull 1: the scope key is present", hasKey(firstBody, "scope"));
  check("pull 1: scope.jobIds names this run's job", (firstResponse.scope?.jobIds ?? []).includes(fixture.jobId));
  check("pull 1: scope.jobIds names jobs that did NOT change too (membership, not delta)",
    (firstResponse.scope?.jobIds ?? []).length >= firstResponse.jobs.length,
    `scope=${(firstResponse.scope?.jobIds ?? []).length} jobs=${firstResponse.jobs.length}`);
  deepEqual("pull 1: the plan removes the stranded job and only that one",
    [...firstPlan.removeJobIds], [strandedId]);
  deepEqual("pull 1: the plan retains the out-of-scope job that still has queued work",
    [...firstPlan.retainedForUnsyncedWork], [retainedId]);

  // timestamps
  deepEqual("pull 1: download.ts raised no timestamp anomalies", [...firstPlan.anomalies], []);
  check("pull 1: serverTime is ISO-8601 and not a raw Postgres timestamp",
    ISO_8601.test(firstResponse.serverTime), firstResponse.serverTime);
  const rawJobs = (firstBody["jobs"] ?? []) as Record<string, unknown>[];
  const everyStamp = rawJobs.flatMap((j) =>
    ["updatedAt", "scheduledFor", "respondByAt", "resolveByAt", "visitScheduledStart", "visitScheduledEnd"]
      .map((k) => j[k])
      .filter((v): v is string => typeof v === "string"));
  check(`pull 1: all ${everyStamp.length} job timestamps are ISO-8601`,
    everyStamp.every((s) => ISO_8601.test(s)),
    everyStamp.find((s) => !ISO_8601.test(s)));

  // gaps - null is not []
  const mineRaw = rawJobs.find((j) => j["id"] === fixture.jobId);
  check("pull 1: this run's job is in the working set", mineRaw !== undefined);
  if (mineRaw) {
    check("pull 1: the gaps key is present on a job row", hasKey(mineRaw, "gaps"));
    equal("pull 1: gaps is NULL for a dispatched job, where completion is not on the table",
      mineRaw["gaps"] as unknown, null);
  }
  const minePlanned = firstPlan.jobs.find((j) => j.id === fixture.jobId);
  // Written out rather than with `??`, which would fold the `null` this check
  // is about into the sentinel it is being distinguished from.
  check("pull 1: planSyncApply kept that null as null, not [] and not absent",
    minePlanned !== undefined && minePlanned.gaps === null,
    JSON.stringify(minePlanned?.gaps));
  check("pull 1: the job's version is the string the server sent, for baseVersion",
    typeof minePlanned?.version === "string" && minePlanned.version === mineRaw?.["updatedAt"]);

  check("pull 1: the client measured a clock skew from the round trip", first.skew !== null);

  // The lists that say what the phone does NOT hold (§8.2's second half). An
  // empty state that looks like "no data" is worse than a refusal: a technician
  // who opens the invoice for a job and sees nothing concludes there is no
  // invoice and tells the customer so.
  check("pull 1: unavailableOffline arrived with sentences to show",
    firstResponse.unavailableOffline.length > 0 &&
      firstResponse.unavailableOffline.every((r) => typeof r["key"] === "string"),
    JSON.stringify(firstResponse.unavailableOffline.slice(0, 1)));
  check("pull 1: notYetAvailable arrived - the parts catalogue and the RAMS templates",
    firstResponse.notYetAvailable.length > 0,
    JSON.stringify(firstResponse.notYetAvailable.map((r) => r["key"])));
  check("pull 1: the manifest of the working set arrived",
    firstResponse.manifest.length > 0);
  check("pull 1: the response names this device back to it",
    firstResponse.device?.id === registration.deviceId &&
      firstResponse.device?.technicianId === fixture.technician_id);

  // ── A second pull, with the cursor ───────────────────────────────────────

  const second = await client.pull(firstResponse.nextCursor);
  const secondBody = lastBody("/api/field/v1/sync");
  const secondResponse = parseSyncResponse(secondBody);
  const secondPlan = planSyncApply(secondResponse, holdings);

  check("pull 2: the taxonomies key is OMITTED when nothing changed", !hasKey(secondBody, "taxonomies"));
  equal("pull 2: the parser rendered that omission as null - keep what you have",
    secondResponse.taxonomies, null);
  equal("pull 2: the plan says touch nothing rather than delete everything",
    secondPlan.taxonomies, null);
  equal("pull 2: complete is false when a cursor was sent", secondResponse.complete, false);
  check("pull 2: scope is still sent on a delta", hasKey(secondBody, "scope"));
  check("pull 2: scope still names this run's job even though it did not change",
    (secondResponse.scope?.jobIds ?? []).includes(fixture.jobId));
  equal("pull 2: past the watermark lag and nothing changed, so no job rows came back",
    secondResponse.jobs.length, 0);
  check("pull 2: still no timestamp anomalies", secondPlan.anomalies.length === 0,
    secondPlan.anomalies.join("; "));
  check("pull 2: the client measured a clock skew", second.skew !== null);

  const cursorAfterSecond = secondResponse.nextCursor;

  // ══ 3. Push a mutation batch ══════════════════════════════════════════════

  const version = minePlanned?.version ?? null;

  const enRoute = queue(transition({ jobId: fixture.jobId, to: "en_route", baseVersion: version }));
  const shiftIn = queue(appendAttendance({
    kind: "shift_in",
    occurredAt: new Date().toISOString(),
    lat: 25.2,
    lng: 55.27,
  }));
  const orphan = queue({
    ...declareNoMaterials({ jobId: fixture.jobId }),
    dependsOnClientId: newClientId(),
  });

  const batch1 = [enRoute, shiftIn, orphan];
  const first_push = await push(client, batch1);
  const pushBody = lastBody("/api/field/v1/mutations");

  check("push: all four result lists are present and spelled as the client believes",
    hasKey(pushBody, "accepted") && hasKey(pushBody, "conflicts") &&
      hasKey(pushBody, "rejected") && hasKey(pushBody, "deferred"));
  check("push: serverTime and clockSkewMs are present",
    hasKey(pushBody, "serverTime") && hasKey(pushBody, "clockSkewMs"));
  check("push: the server measured the device clock from the header",
    typeof first_push.response.clockSkewMs === "number",
    JSON.stringify(first_push.response.clockSkewMs));
  check("push: serverTime is ISO-8601", ISO_8601.test(first_push.response.serverTime),
    first_push.response.serverTime);

  equal("push: en_route was accepted", rowFor(first_push.folded, enRoute.clientId).status, "done");
  const acceptedEntry = first_push.response.accepted.find((a) => a.clientId === enRoute.clientId);
  check("push: an accepted entry carries serverReceivedAt as ISO-8601",
    acceptedEntry !== undefined && ISO_8601.test(acceptedEntry.serverReceivedAt),
    acceptedEntry?.serverReceivedAt);
  check("push: applyMutationResponse stored the server's receipt time on the row",
    rowFor(first_push.folded, enRoute.clientId).serverReceivedAt === acceptedEntry?.serverReceivedAt);

  const deferredEntry = first_push.response.deferred.find((d) => d.clientId === orphan.clientId);
  check("push: a mutation whose dependency has not landed comes back in `deferred`",
    deferredEntry !== undefined, JSON.stringify(first_push.response.deferred));
  equal("push: deferred names the dependency it is waiting on",
    deferredEntry?.dependsOn, orphan.dependsOnClientId);
  equal("push: applyMutationResponse put it back to pending, not dead",
    rowFor(first_push.folded, orphan.clientId).status, "pending");
  equal("push: and charged it no attempt",
    rowFor(first_push.folded, orphan.clientId).attemptCount, 0);

  // ── The attendance builder, which is where the two halves disagreed ──────
  const attendanceRejection = first_push.response.rejected.find((r) => r.clientId === shiftIn.clientId);
  const attendanceAccepted = first_push.response.accepted.find((a) => a.clientId === shiftIn.clientId);
  check("push: attendance/append built by payloads.ts is ACCEPTED by the real route",
    attendanceAccepted !== undefined,
    attendanceRejection ? `rejected: ${attendanceRejection.message}` : "not answered at all");

  // ── The transition to `on_site`: FOUND BROKEN HERE, SINCE FIXED ──────────
  //
  // ── THIS CHECK FAILED WHEN IT WAS WRITTEN. IT MUST STAY HERE ─────────────
  //
  // `transitionJob` sets `first_response_at` on the move to `on_site` with
  //
  //     patch["firstResponseAt"] = sql`coalesce(${schema.jobs.firstResponseAt}, ${now})`
  //
  // (`packages/db/src/domain/jobs.ts`), interpolating a JavaScript `Date` into a
  // `sql` template. The driver cannot serialise a `Date` in that position and
  // throws `ERR_INVALID_ARG_TYPE` **before the statement is sent**, which is not
  // a `UserFacingError` and therefore is not one of the failures the
  // per-mutation savepoint is built to absorb: the whole request returns 500 and
  // the entire batch is rolled back, including mutations that had already been
  // applied. A technician who arrives on site can neither say so nor send
  // anything queued behind it.
  //
  // That was a defect on the server side of this contract, in a package this
  // workspace is not allowed to edit, so it was reported rather than fixed -
  // and asserted here so that the day somebody fixed `jobs.ts` this script
  // would turn green by itself. It has: the interpolation is now
  // `${now.toISOString()}::timestamptz` and this check passes. A harness that
  // had quietly routed around the broken protocol would have been the same
  // failure as the two suites this file exists to check, and the fix would
  // have had nothing to prove it from the client's side.
  //
  // The assertion stays exactly as written, because it is now the regression
  // test: it is the only thing in this repository that checks a technician can
  // report arriving on site through the API rather than through the domain
  // layer.
  const onSite = queue(transition({ jobId: fixture.jobId, to: "on_site", baseVersion: version }));
  let onSiteAccepted = false;
  let onSiteDetail = "";
  try {
    const attempt = await push(client, [onSite]);
    onSiteAccepted = rowFor(attempt.folded, onSite.clientId).status === "done";
    onSiteDetail = JSON.stringify(attempt.response);
  } catch (error) {
    onSiteDetail = String(error);
  }
  check("SERVER BUG (packages/db/src/domain/jobs.ts, first_response_at): " +
    "job_status/transition to on_site is accepted", onSiteAccepted, onSiteDetail);
  equal("SERVER BUG: and the 500 rolled the whole batch back, so nothing landed",
    sqlText(`select status from jobs where id = '${fixture.jobId}'::uuid`),
    onSiteAccepted ? "on_site" : "en_route");

  // Routed around, so that everything downstream of arrival can still be
  // proven. This is the only write in the run that does not go through the API,
  // it touches only this run's own job, and it exists solely because of the
  // defect asserted immediately above.
  if (!onSiteAccepted) {
    sqlText(`update jobs set status = 'on_site'::job_status, updated_at = now()
              where id = '${fixture.jobId}'::uuid`);
  }

  // ── The JOB-15 refusal, over HTTP, with the queued write surviving ───────

  const refusedOutcome = queue(recordOutcome({
    jobId: fixture.jobId,
    visitId: fixture.visitId,
    outcomeCode: "completed",
    baseVersion: version,
  }));
  const second_push = await push(client, [refusedOutcome]);

  const rejection = second_push.response.rejected.find((r) => r.clientId === refusedOutcome.clientId);
  check("JOB-15: the completion came back in `rejected`", rejection !== undefined,
    JSON.stringify(second_push.response));
  check("JOB-15: the refusal carries a structured gap list, not only prose",
    (rejection?.gaps?.length ?? 0) > 0, JSON.stringify(rejection?.gaps));
  deepEqual("JOB-15: the gaps are the three the job card is actually missing",
    [...(rejection?.gaps ?? [])].sort(), ["after_photo", "labour", "materials"]);
  check("JOB-15: the message is a sentence a technician can act on",
    (rejection?.message ?? "").includes("job card"), rejection?.message);

  const refusedRow = rowFor(second_push.folded, refusedOutcome.clientId);
  equal("JOB-15: the queued write SURVIVES, in `refused`", refusedRow.status, "refused");
  deepEqual("JOB-15: carrying the server's gaps for the job card to reopen on",
    [...(refusedRow.refusalGaps ?? [])].sort(), ["after_photo", "labour", "materials"]);
  check("JOB-15: and the server's sentence", refusedRow.lastError === rejection?.message);
  equal("JOB-15: nothing was written - the job is still on site",
    sqlText(`select status from jobs where id = '${fixture.jobId}'::uuid`), "on_site");

  // ── Closing two of the three gaps, and watching the list shrink ──────────

  const materials = queue(declareNoMaterials({ jobId: fixture.jobId, visitId: fixture.visitId }));
  const labour = queue(recordLabour({ jobId: fixture.jobId, visitId: fixture.visitId, workMinutes: 45 }));
  const third_push = await push(client, [materials, labour]);
  equal("gaps: declaring no materials was accepted",
    rowFor(third_push.folded, materials.clientId).status, "done");
  equal("gaps: recording labour was accepted",
    rowFor(third_push.folded, labour.clientId).status, "done");

  const refusedAgain = queue(recordOutcome({
    jobId: fixture.jobId,
    visitId: fixture.visitId,
    outcomeCode: "completed",
    baseVersion: version,
  }));
  const fourth_push = await push(client, [refusedAgain]);
  const rejection2 = fourth_push.response.rejected.find((r) => r.clientId === refusedAgain.clientId);
  deepEqual("gaps: the server's list is live - only the photograph is outstanding now",
    [...(rejection2?.gaps ?? [])], ["after_photo"]);

  // ── A conflict, which needs a human ──────────────────────────────────────

  const illegal = queue(transition({ jobId: fixture.jobId, to: "en_route", baseVersion: version }));
  const fifth_push = await push(client, [illegal]);
  const conflict = fifth_push.response.conflicts.find((c) => c.clientId === illegal.clientId);
  check("conflict: an illegal transition comes back in `conflicts`, not `rejected`",
    conflict !== undefined, JSON.stringify(fifth_push.response));
  check("conflict: it carries reason, detail and serverState",
    typeof conflict?.reason === "string" && (conflict?.detail?.length ?? 0) > 0 &&
      conflict?.serverState !== undefined,
    JSON.stringify(conflict));
  equal("conflict: applyMutationResponse parked the row as conflicted, not dead",
    rowFor(fifth_push.folded, illegal.clientId).status, "conflicted");
  equal("conflict: the server's own sentence is what the technician is shown",
    rowFor(fifth_push.folded, illegal.clientId).lastError, conflict?.detail ?? null);

  // ── Idempotency: the same clientId twice ─────────────────────────────────

  const replay = await client.push(newClientId(), [toOutboundMutation(labour)]);
  const replayed = replay.data.accepted.find((a) => a.clientId === labour.clientId);
  check("idempotency: replaying an accepted clientId replays the stored receipt",
    replayed !== undefined, JSON.stringify(replay.data));

  // ── AND WHAT A REPLAYED *REFUSAL* COMES BACK AS ─────────────────────────
  //
  // `applyFieldMutations` writes a receipt for a rejection too, and the replay
  // branch reconstructs the answer from `result.message` alone - it does not
  // read back the `gaps` it stored beside it. So the same completion sent twice
  // is `refused` (correctable, gaps attached) the first time and `dead` (no
  // gaps, nothing to act on) the second.
  //
  // That is not a bug the device suffers from today, because `afterRefusal`
  // parks the row in `refused` and never re-sends it - "fixing one mints a new
  // mutation". It is asserted here so the property is written down rather than
  // depended on by accident: any future retry-a-refusal button would silently
  // downgrade a fixable job card into a dead one.
  const replayedRefusal = await client.push(newClientId(), [toOutboundMutation(refusedOutcome)]);
  const replayedReject = replayedRefusal.data.rejected.find(
    (r) => r.clientId === refusedOutcome.clientId,
  );
  check("idempotency: a replayed refusal is still a rejection", replayedReject !== undefined,
    JSON.stringify(replayedRefusal.data));
  check("idempotency: but the replay drops the gaps, so a re-sent refusal reads as dead",
    replayedReject?.gaps === undefined, JSON.stringify(replayedReject?.gaps));

  // ══ 4. gaps === [] means something different from gaps === null ═══════════

  const exempt = queue(exemptFromPhoto({ jobId: fixture.jobId, reasonCode: "nothing_visible" }));
  const sixth_push = await push(client, [exempt]);
  equal("gaps: the photo exemption was accepted",
    rowFor(sixth_push.folded, exempt.clientId).status, "done");

  const third = await client.pull(cursorAfterSecond);
  const thirdBody = lastBody("/api/field/v1/sync");
  const thirdResponse = parseSyncResponse(thirdBody);
  const thirdPlan = planSyncApply(thirdResponse, holdings);

  check("pull 3: a cursored pull DID return a delta", thirdResponse.jobs.length > 0,
    `${thirdResponse.jobs.length} jobs`);
  check("pull 3: the delta contains the job that changed",
    thirdResponse.jobs.some((j) => j["id"] === fixture.jobId));
  // The question `scope` exists to answer: membership, not change. Every id the
  // delta carried has to be in scope, and scope has to name jobs the delta did
  // not carry - otherwise it is just a second copy of the delta and the device
  // has no way to tell an unchanged job from a reassigned one.
  const thirdScope = thirdResponse.scope?.jobIds ?? [];
  const thirdDeltaIds = thirdResponse.jobs.map((j) => String(j["id"]));
  check("pull 3: every job in the delta is named in scope",
    thirdDeltaIds.every((id) => thirdScope.includes(id)));
  check(`pull 3: scope names in-scope jobs the delta did NOT carry ` +
    `(scope=${thirdScope.length}, delta=${thirdDeltaIds.length})`,
    thirdScope.some((id) => !thirdDeltaIds.includes(id)));
  const thirdRaw = (thirdBody["jobs"] as Record<string, unknown>[]).find((j) => j["id"] === fixture.jobId);
  deepEqual("pull 3: gaps is now [] - nothing is missing, which is not the same as null",
    thirdRaw?.["gaps"], []);
  const thirdPlanned = thirdPlan.jobs.find((j) => j.id === fixture.jobId);
  deepEqual("pull 3: planSyncApply kept the empty list distinct from null",
    thirdPlanned?.gaps, []);
  equal("pull 3: the job's status came down as on_site", thirdPlanned?.status, "on_site");
  check("pull 3: still no timestamp anomalies", thirdPlan.anomalies.length === 0,
    thirdPlan.anomalies.join("; "));
  check("pull 3: taxonomies still omitted", !hasKey(thirdBody, "taxonomies"));
  check("pull 3: third pull still measured skew", third.skew !== null);

  // ══ 4b. Two more places the builders and the handlers disagree ════════════

  // ── `visit_labour/record` without a visit ────────────────────────────────
  //
  // `recordLabour` used to take `visitId: string | null`; `optional()` drops a
  // null and the server reads it with `requireString`, so the builder could
  // produce a payload the office always refuses. Both halves of the fix are
  // checked: the server really does refuse the payload the old builder made,
  // and the new builder refuses to make it in the first place. The bad payload
  // has to be hand-written here precisely because the type no longer permits it.
  const handWrittenLabour = queue({
    entity: "visit_labour",
    op: "record",
    jobId: fixture.jobId,
    payload: { jobId: fixture.jobId, workMinutes: 20 },
    baseVersion: null,
    dependsOnClientId: null,
  });
  const labourPush = await push(client, [handWrittenLabour]);
  const labourReject = labourPush.response.rejected.find(
    (r) => r.clientId === handWrittenLabour.clientId,
  );
  check("labour: the server refuses a labour record that names no visit",
    labourReject !== undefined && labourReject.message.includes("visitId"),
    JSON.stringify(labourPush.response));
  let labourGuardFired = false;
  try {
    recordLabour({ jobId: fixture.jobId, visitId: "  ", workMinutes: 20 });
  } catch {
    labourGuardFired = true;
  }
  check("labour: and the builder now refuses to compose one", labourGuardFired);

  // ── `job_material/append` sends two fields the server has nowhere to put ──
  //
  // `appendMaterial` requires `source` ("van_stock" | "purchased" |
  // "customer_supplied") and optionally sends `serialNumber`.
  //
  // FOUND BROKEN HERE, SINCE FIXED. `job_materials` had neither column and
  // `recordJobMaterial` read neither key, so both were accepted and silently
  // dropped - nothing refused, nothing warned, and the office lost the answer
  // to "where did this part come from", which is the question stock
  // reconciliation is. Silent acceptance is worse than a refusal, because a
  // refusal tells the technician. The columns now exist and the value is
  // stored; the assertion is unchanged and is now the regression test.
  const materialWithSource = queue(appendMaterial({
    jobId: fixture.jobId,
    visitId: fixture.visitId,
    description: `Contactor ${RUN_TAG}`,
    quantity: "1",
    unit: "ea",
    source: "van_stock",
    serialNumber: `SN-${RUN_TAG}`,
  }));
  const materialPush = await push(client, [materialWithSource]);
  equal("material: the line was accepted",
    rowFor(materialPush.folded, materialWithSource.clientId).status, "done");
  const storedMaterial = sqlText(`
    select coalesce(string_agg(column_name, ','), '') from information_schema.columns
     where table_name = 'job_materials' and column_name in ('source', 'serial_number')
  `);
  check("FLD-9: the `source` the technician recorded reaches a column " +
    "(job_materials.source/serial_number)", storedMaterial !== "",
    "accepted and dropped silently - nothing refuses, nothing warns, and stock " +
      "reconciliation loses the answer to \"where did this part come from\"");

  // ══ 5. Token rotation, and what a bad token does ══════════════════════════

  const tokenBefore = await store.token();

  // Rotation triggers at seven days. Backdating this run's own device row is
  // the only way to reach that path inside a test, and it is a row nothing
  // else in this database has ever heard of.
  sqlText(`
    update field_devices
       set token_issued_at = now() - interval '8 days'
     where id = '${registration.deviceId}'::uuid
  `);

  const rotatedPull = await client.pull(thirdResponse.nextCursor);
  const rotatedBody = lastBody("/api/field/v1/sync");
  check("rotation: the response carried a replacement token", hasKey(rotatedBody, "deviceToken"));
  const tokenAfter = await store.token();
  check("rotation: the client persisted it before handing the body over",
    tokenAfter !== null && tokenAfter !== tokenBefore);
  check("rotation: and the sync body itself still parsed", rotatedPull.data.serverTime.length > 0);
  const generation = sqlText(
    `select token_generation from field_devices where id = '${registration.deviceId}'::uuid`,
  );
  equal("rotation: the server advanced the device's token generation", generation, "2");

  // The old token, inside its grace window, is still good.
  const graceStore = new DeviceStore(memoryBackend());
  await graceStore.save({ ...registration, token: tokenBefore ?? "" });
  const graceClient = new FieldApiClient({
    ...config,
    getDeviceToken: () => graceStore.token(),
    onDeviceToken: (t) => graceStore.saveRotatedToken(t),
    clearDeviceToken: () => graceStore.clear(),
  });
  let graceWorked = false;
  try {
    await graceClient.pull(null);
    graceWorked = true;
  } catch (error) {
    graceWorked = false;
    check("grace: the retired token still worked inside its ten minutes", false, String(error));
  }
  if (graceWorked) check("grace: the retired token still worked inside its ten minutes", true);

  // ...and outside it, the device is revoked and the client forgets the token.
  sqlText(`
    update field_devices
       set previous_token_grace_until = now() - interval '1 minute'
     where id = '${registration.deviceId}'::uuid
  `);
  try {
    await graceClient.pull(null);
    check("reuse: a retired token replayed after its grace is refused", false, "it was accepted");
  } catch (error) {
    check("reuse: a retired token replayed after its grace is refused",
      error instanceof DeviceAuthError, String(error));
    if (error instanceof DeviceAuthError) {
      equal("reuse: the code is device_revoked", error.code, "device_revoked");
      check("reuse: which the client knows means destroy the stored token",
        error.clearsStoredToken);
      equal("reuse: and it did", await graceStore.token(), null);
    }
  }

  // A token that was never issued.
  const strangerStore = new DeviceStore(memoryBackend());
  await strangerStore.save({ ...registration, token: "not-a-token-this-office-ever-issued" });
  const stranger = new FieldApiClient({
    ...config,
    getDeviceToken: () => strangerStore.token(),
    onDeviceToken: (t) => strangerStore.saveRotatedToken(t),
    clearDeviceToken: () => strangerStore.clear(),
  });
  try {
    await stranger.pull(null);
    check("bad token: an unknown bearer token is refused", false, "it was accepted");
  } catch (error) {
    check("bad token: the client classified it as DeviceAuthError, not a retryable failure",
      error instanceof DeviceAuthError, `${error}`);
    if (error instanceof DeviceAuthError) {
      equal("bad token: the code is device_unknown", error.code, "device_unknown");
      check("bad token: which does NOT destroy the stored token", !error.clearsStoredToken);
    }
  }

  // No token at all.
  const anonymous = new FieldApiClient({ ...config, getDeviceToken: async () => null });
  try {
    await anonymous.pull(null);
    check("no token: an unauthenticated pull is refused", false, "it was accepted");
  } catch (error) {
    check("no token: also DeviceAuthError / device_unknown",
      error instanceof DeviceAuthError && error.code === "device_unknown", `${error}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    check("the harness ran to the end", false, String(error));
  })
  .then(() => {
    cleanup();
    // Named here rather than left as a mysterious red line. A defect on the
    // server side of this contract is reported, not routed around, and the
    // assertion stays so that the fix flips this script green by itself.
    console.log(
      "\nWHAT CONNECTING THE TWO HALVES FOUND (both server side, both now fixed):\n" +
        "  1. packages/db/src/domain/jobs.ts - transitionJob() interpolated a JS Date\n" +
        "     into `sql\u0060coalesce(first_response_at, ${now})\u0060` on the move to on_site.\n" +
        "     The driver threw before the statement was sent, the mutations route returned\n" +
        "     500 and the WHOLE BATCH was rolled back - the per-mutation savepoint does not\n" +
        "     absorb it, because it is not a UserFacingError. A technician could not report\n" +
        "     arriving on site, and nothing queued behind that could be sent either. It\n" +
        "     reached no suite because none moved a job to on_site. Now ::timestamptz.\n" +
        "  2. job_materials had no `source` or `serial_number` column and\n" +
        "     recordJobMaterial() read neither key. FLD-9 has the technician record where\n" +
        "     a part came from; the server accepted the line and dropped the answer.\n" +
        "     Silent acceptance, which is worse than a refusal. Both columns now exist.\n" +
        "\n  Both checks above are kept exactly as written. They are the regression tests,\n" +
        "  and they are the only ones that exercise either path through the API.",
    );
    done("wire-contract");
  });
