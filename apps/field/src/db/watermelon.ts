/**
 * The WatermelonDB adapter.
 *
 * **NOT TYPECHECKED BY THE ROOT GATE.** This file imports `@nozbe/watermelondb`
 * and `react-native`, neither of which is installed in this repository - see
 * the comment in tsconfig.json. It compiles under `npm run typecheck:native`
 * after `npm install`, and nothing in this session executed it. Everything it
 * depends on that *could* be tested without a device was moved into
 * `schema.ts`, `outbox.ts` and `engine.ts`, which are.
 *
 * ── THE ONE THING THIS FILE IS FOR ─────────────────────────────────────────
 *
 * `writeWithOutbox` below is the transactional outbox from TRD §8.3, and it is
 * the reason the app can be killed mid-save without losing work. Every local
 * mutation goes through it. There is no other way to write a domain row, and
 * that is enforced by convention rather than by the type system - which is a
 * weakness worth knowing about: a screen that calls `database.write()` directly
 * would write a record that never syncs, silently.
 */

import { Database, Q } from "@nozbe/watermelondb";
import { appSchema, tableSchema } from "@nozbe/watermelondb";
import SQLiteAdapter from "@nozbe/watermelondb/adapters/sqlite";
import type { Collection, Model } from "@nozbe/watermelondb";

import { FIELD_SCHEMA, SCHEMA_VERSION } from "./schema";
import * as models from "./models";
import type { OutboxRow } from "../sync/outbox";
import type { MutationEntity, MutationOp } from "../sync/protocol";
import { SYNC_STATE_KEYS, type DeviceHoldings, type SyncPlan } from "../sync/download";

/**
 * The plain schema descriptor, handed to WatermelonDB's builders.
 *
 * The conversion is mechanical because the descriptor was written to match the
 * builders' input exactly. That is the point: the shape lives somewhere the
 * root typecheck and the unit tests can see it, and this is the ten lines that
 * carry it across the boundary.
 */
export const watermelonSchema = appSchema({
  version: FIELD_SCHEMA.version,
  tables: FIELD_SCHEMA.tables.map((table) =>
    tableSchema({
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        type: column.type,
        isOptional: column.isOptional,
        isIndexed: column.isIndexed,
      })),
    }),
  ),
});

/**
 * Migrations: **none yet, and that is a decision with a cost.**
 *
 * WatermelonDB's behaviour when the schema version rises with no migration
 * covering the gap is to **reset the local database**. On this app that means
 * deleting a technician's unsynced day. Version 1 has never shipped, so there
 * is nothing to migrate from; the moment it does ship, every schema change
 * needs an entry here, and `SCHEMA_VERSION` must not be bumped without one.
 *
 * This is left as a bare constant rather than an empty `schemaMigrations([])`
 * call so that adding the first migration is an obvious edit rather than a
 * change to an argument nobody reads.
 */
export const MIGRATIONS_REQUIRED_FROM_VERSION = SCHEMA_VERSION;

export function createDatabase(): Database {
  const adapter = new SQLiteAdapter({
    schema: watermelonSchema,
    // JSI gives synchronous SQLite access, which matters on the job list where
    // an observable query re-runs on every write. Falls back automatically.
    jsi: true,
    onSetUpError: (error) => {
      // Deliberately not swallowed. A database that failed to open means the
      // app cannot store anything, and the technician must be told before they
      // start a shift believing their work is being saved.
      console.error("[field] the local database could not be opened", error);
    },
  });

  return new Database({ adapter, modelClasses: Object.values(models) as never });
}

// ── The transactional outbox ────────────────────────────────────────────────

export interface OutboxWrite {
  readonly clientId: string;
  readonly entity: MutationEntity;
  readonly op: MutationOp;
  readonly jobId: string | null;
  readonly payload: Record<string, unknown>;
  readonly baseVersion: string | null;
  readonly dependsOnClientId: string | null;
  readonly createdAt: string;
  readonly createdMonotonic: number;
}

/**
 * Write a domain record and its outbox row in **one** transaction.
 *
 * `database.write()` wraps its callback in a single SQLite transaction, so
 * either both rows land or neither does. The failure this prevents is a phone
 * terminated between the two writes - which iOS does without warning, most
 * often just after a camera-heavy app returns to the foreground.
 *
 * The domain record's id **is** the client id. WatermelonDB allows an explicit
 * id via `_raw.id`, and using the device-minted ULID means a photo can point at
 * its parent job event by primary key before either has reached the server.
 */
export async function writeWithOutbox<T extends Model>(
  database: Database,
  table: string,
  outbox: OutboxWrite,
  build: (record: T) => void,
): Promise<T> {
  return database.write(async () => {
    const record = await database.get<T>(table).create((draft) => {
      (draft._raw as { id: string }).id = outbox.clientId;
      build(draft);
    });

    await database.get<models.Outbox>("outbox").create((row) => {
      (row._raw as { id: string }).id = outbox.clientId;
      row.entity = outbox.entity;
      row.op = outbox.op;
      row.jobId = outbox.jobId ?? undefined;
      row.payloadJson = JSON.stringify(outbox.payload);
      row.baseVersion = outbox.baseVersion ?? undefined;
      row.dependsOnClientId = outbox.dependsOnClientId ?? undefined;
      row.createdAtDevice = Date.parse(outbox.createdAt);
      row.createdMonotonic = outbox.createdMonotonic;
      row.attemptCount = 0;
      row.nextAttemptAfter = 0;
      row.status = "pending";
    });

    return record;
  });
}

/** Read the outbox into the plain rows the pure drain planner understands. */
export async function loadOutbox(database: Database): Promise<OutboxRow[]> {
  const rows = await database
    .get<models.Outbox>("outbox")
    .query(Q.where("status", Q.notEq("done")))
    .fetch();

  return rows.map((row) => ({
    clientId: row.id,
    entity: row.entity as MutationEntity,
    op: row.op as MutationOp,
    jobId: row.jobId ?? null,
    payload: JSON.parse(row.payloadJson) as Record<string, unknown>,
    baseVersion: row.baseVersion ?? null,
    dependsOnClientId: row.dependsOnClientId ?? null,
    createdAt: new Date(row.createdAtDevice).toISOString(),
    createdMonotonic: row.createdMonotonic,
    attemptCount: row.attemptCount,
    nextAttemptAfter: row.nextAttemptAfter,
    status: row.status as OutboxRow["status"],
    lastError: row.lastError ?? null,
    refusalGaps: row.refusalGaps ? (JSON.parse(row.refusalGaps) as string[]) : null,
    serverReceivedAt: row.serverReceivedAt === undefined ? null : new Date(row.serverReceivedAt).toISOString(),
  }));
}

/** Fold the planner's decisions back into SQLite, in one transaction. */
export async function persistOutbox(database: Database, rows: readonly OutboxRow[]): Promise<void> {
  if (rows.length === 0) return;
  await database.write(async () => {
    const collection = database.get<models.Outbox>("outbox");
    const updates = await Promise.all(
      rows.map(async (row) => {
        const record = await collection.find(row.clientId);
        return record.prepareUpdate((draft) => {
          draft.status = row.status;
          draft.attemptCount = row.attemptCount;
          draft.nextAttemptAfter = row.nextAttemptAfter;
          draft.lastError = row.lastError ?? undefined;
          // Absent, not "[]": an empty list would say the card is complete.
          draft.refusalGaps = row.refusalGaps === null ? undefined : JSON.stringify(row.refusalGaps);
          draft.serverReceivedAt =
            row.serverReceivedAt === null ? undefined : Date.parse(row.serverReceivedAt);
        });
      }),
    );
    await database.batch(...updates);
  });
}

// ── The download half ───────────────────────────────────────────────────────

/**
 * What the device holds now, in the two facts the pull planner needs.
 *
 * Read *before* the write, in its own transaction, because the planner is pure
 * and cannot go and look. The window between this read and the batch that
 * follows is single-threaded JavaScript with no `await` on anything the user
 * can touch, so nothing can queue a mutation inside it - which matters,
 * because a job that acquired unsynced work between the two would be removed
 * on the strength of a stale answer.
 */
export async function readDeviceHoldings(database: Database): Promise<DeviceHoldings> {
  const jobs = await database.get<models.Job>("jobs").query().fetch();
  const queued = await database
    .get<models.Outbox>("outbox")
    .query(Q.where("status", Q.notEq("done")))
    .fetch();

  const withUnsyncedWork = new Set<string>();
  for (const row of queued) {
    // A row with no `jobId` belongs to the shift rather than to a job - an
    // attendance event - and cannot pin a job in place.
    if (row.jobId) withUnsyncedWork.add(row.jobId);
  }

  return { jobIds: jobs.map((job) => job.id), jobIdsWithUnsyncedWork: [...withUnsyncedWork] };
}

/** The cursor the last committed pull left behind. Null before the first sync. */
export async function readPullCursor(database: Database): Promise<string | null> {
  const rows = await database
    .get<models.SyncState>("sync_state")
    .query(Q.where("key", SYNC_STATE_KEYS.cursor))
    .fetch();
  return rows[0]?.value ?? null;
}

/**
 * Upsert by primary key, which is the server's id.
 *
 * The server re-sends a related entity rather than paging it - a customer whose
 * name changed arrives again on the next pull - so a re-sent row is an update
 * here, not a duplicate. Making the local record id **be** the server id is
 * what makes that a one-line decision instead of a lookup table: the same
 * choice `writeWithOutbox` makes for the upward direction, where the record id
 * is the device-minted client id.
 *
 * It returns prepared operations rather than performing them, so that the whole
 * pull lands in one `database.batch()`. See `applySyncPlan`.
 */
async function prepareUpsert<T extends Model, R extends { readonly id: string }>(
  collection: Collection<T>,
  rows: readonly R[],
  apply: (draft: T, row: R, isNew: boolean) => void,
): Promise<T[]> {
  if (rows.length === 0) return [];

  const existing = await collection.query(Q.where("id", Q.oneOf(rows.map((r) => r.id)))).fetch();
  const byId = new Map(existing.map((record) => [record.id, record]));

  return rows.map((row) => {
    const found = byId.get(row.id);
    if (found) return found.prepareUpdate((draft) => apply(draft, row, false));
    return collection.prepareCreate((draft) => {
      (draft._raw as { id: string }).id = row.id;
      apply(draft, row, true);
    });
  });
}

/**
 * Perform a pull, or perform none of it.
 *
 * ── WHY EVERYTHING GOES IN ONE `batch()` ───────────────────────────────────
 *
 * `database.batch()` is the only WatermelonDB call that is atomic across
 * several records; a sequence of `create()` calls inside one `write()` is a
 * sequence of writes that happens to hold a lock. The distinction is the whole
 * safety property of this function: **the cursor row is in the same batch as
 * the data it describes.** A pull interrupted halfway - the process killed, the
 * adapter erroring on one row - leaves the device holding its previous working
 * set and its previous cursor, and the next sync fetches the same delta again.
 * The failure this forbids is the other one: a cursor that says "you have
 * everything up to Tuesday" on a device that wrote half of Monday, where
 * nothing will ever fetch the missing half because nothing knows it is missing.
 *
 * Removals are in the same batch for the same reason. A job that left the
 * working set and a cursor that has moved past the pull which said so must
 * become true together.
 */
export async function applySyncPlan(database: Database, plan: SyncPlan): Promise<void> {
  await database.write(async () => {
    const operations: Model[] = [];

    operations.push(
      ...(await prepareUpsert(database.get<models.Job>("jobs"), plan.jobs, (draft, row, isNew) => {
        draft.serverId = row.id;
        draft.reference = row.reference;
        draft.title = row.title;
        draft.description = row.description;
        draft.status = row.status;
        draft.priority = row.priority;
        draft.serviceSlug = row.serviceSlug;
        draft.customerId = row.customerId;
        draft.propertyId = row.propertyId;
        draft.assetId = row.assetId;
        draft.visitId = row.visitId;
        draft.scheduledFor = row.scheduledFor;
        draft.scheduledEnd = row.scheduledEnd;
        draft.respondByAt = row.respondByAt;
        draft.resolveByAt = row.resolveByAt;
        // Three states, stored as three states. `JSON.stringify(null)` is the
        // string "null", which is what `JobCardScreen` parses back into the
        // "completion is not on the table" reading. Leaving the column alone
        // when the key was absent preserves the fourth state, "never told".
        if (row.gaps !== undefined) draft.gapsJson = JSON.stringify(row.gaps);
        draft.version = row.version;
        draft.syncedAt = row.syncedAt;

        /**
         * ── `FLD-4`: THE SERVER SENDS NOTHING, SO THE GATE IS SHUT ────────
         *
         * `FieldJob` has no RAMS, permit or PPE fields, because no PPE or RAMS
         * template table exists in the schema at all - the sync route declares
         * both in `notYetAvailable` and `protocol.ts` records it as the ninth
         * place the server differs from TRD §8.5.
         *
         * These three columns are not optional, so something has to go in
         * them, and `false` / `[]` is the one answer that must not: it reads
         * as "this job needs no risk assessment and no permit", which is the
         * device inventing a safety rule in the permissive direction.
         * `safetyGaps()` would then return nothing and the start-work button
         * would go live on a hot-work job with no permit reference.
         *
         * So the refusal is written down instead. `working-set.ts` states the
         * position - *"`FLD-4`'s safety gate has no templates to gate on, so
         * it refuses everything, which is the correct direction for a safety
         * gate to fail"* - and this is that sentence as two booleans. The
         * moment the server carries the real requirement, these become a
         * mapping and this comment goes away.
         *
         * Written on create only. A sync must not stamp over a value some
         * later code path set from real data.
         */
        if (isNew) {
          draft.ramsRequired = true;
          draft.permitRequired = true;
          draft.requiredPpeCodes = "[]";
        }
      })),
    );

    operations.push(
      ...(await prepareUpsert(database.get<models.Customer>("customers"), plan.customers, (draft, row) => {
        draft.serverId = row.id;
        draft.name = row.name;
        draft.phone = row.phone;
        draft.syncedAt = row.syncedAt;
      })),
    );

    operations.push(
      ...(await prepareUpsert(database.get<models.Property>("properties"), plan.properties, (draft, row) => {
        draft.serverId = row.id;
        draft.customerId = row.customerId;
        draft.name = row.name;
        draft.address = row.address;
        draft.accessInstructions = row.accessInstructions;
        draft.lat = row.lat;
        draft.lng = row.lng;
        draft.syncedAt = row.syncedAt;
      })),
    );

    operations.push(
      ...(await prepareUpsert(database.get<models.Asset>("assets"), plan.assets, (draft, row) => {
        draft.serverId = row.id;
        draft.propertyId = row.propertyId;
        draft.tag = row.tag;
        draft.name = row.name;
        draft.manufacturer = row.manufacturer;
        draft.model = row.model;
        draft.serialNumber = row.serialNumber;
        draft.locationNote = row.locationNote;
        draft.syncedAt = row.syncedAt;
      })),
    );

    operations.push(
      ...(await prepareUpsert(
        database.get<models.Certification>("certifications"),
        plan.certifications,
        (draft, row) => {
          draft.serverId = row.id;
          draft.scheme = row.scheme;
          draft.label = row.label;
          draft.expiresOn = row.expiresOn;
          draft.state = row.state;
          draft.syncedAt = row.syncedAt;
        },
      )),
    );

    /**
     * **Null is not empty.** Null means the taxonomies did not change since
     * this device's cursor and the table is not to be touched; a list - even an
     * empty one - is the whole set, and replaces what is there.
     *
     * Getting this backwards blanks the fault-code picker of a technician who
     * is standing in a plant room with no signal and no way to get it back, on
     * every pull after the first. It is the single most consequential `if` in
     * the download half.
     */
    if (plan.taxonomies !== null) {
      const collection = database.get<models.TaxonomyTerm>("taxonomy_terms");
      const held = await collection.query().fetch();
      const arriving = new Set(plan.taxonomies.map((term) => term.id));
      for (const term of held) {
        // A term the office retired. The four vocabularies come whole, so
        // "absent from this list" here really does mean "gone" - unlike the
        // job delta, where absence means nothing at all.
        if (!arriving.has(term.id)) operations.push(term.prepareDestroyPermanently());
      }
      operations.push(
        ...(await prepareUpsert(collection, plan.taxonomies, (draft, row) => {
          draft.serverId = row.id;
          draft.vocabulary = row.vocabulary;
          draft.kind = row.kind;
          draft.code = row.code;
          draft.label = row.label;
          draft.description = row.description;
          draft.requiresReturnVisit = row.requiresReturnVisit;
          draft.sortOrder = row.sortOrder;
          draft.syncedAt = row.syncedAt;
        })),
      );
    }

    /**
     * Jobs that fell out of `scope.jobIds`, already filtered by the planner so
     * that nothing with queued work is here.
     *
     * **Only the `jobs` row goes.** The technician's own captures -
     * `job_cards`, `job_photos`, `job_materials`, `timing_events` - are left
     * where they are. Everything a reassignment deletes here has already
     * reached the office, but a photograph whose bytes are still uploading has
     * no outbox row yet (the attachment mutation is queued only once the upload
     * returns an id), so cascading the delete would destroy exactly the work
     * the guard above exists to protect. Reclaiming that space is
     * `evictionDecision`'s job, on age, and it is not built.
     */
    if (plan.removeJobIds.length > 0) {
      const doomed = await database
        .get<models.Job>("jobs")
        .query(Q.where("id", Q.oneOf([...plan.removeJobIds])))
        .fetch();
      for (const job of doomed) operations.push(job.prepareDestroyPermanently());
    }

    // Last, and in the same batch: the cursor only becomes true if everything
    // above did. `syncedAt` is the *server's* clock, not this phone's.
    operations.push(
      ...(await prepareUpsert(
        database.get<models.SyncState>("sync_state"),
        [
          { id: SYNC_STATE_KEYS.cursor, value: plan.nextCursor },
          { id: SYNC_STATE_KEYS.lastPulledServerTime, value: plan.serverTime },
        ],
        (draft, row) => {
          draft.key = row.id;
          draft.value = row.value;
          draft.updatedAt = plan.syncedAt;
        },
      )),
    );

    await database.batch(...operations);
  });
}
