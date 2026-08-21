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
import type { Model } from "@nozbe/watermelondb";

import { FIELD_SCHEMA, SCHEMA_VERSION } from "./schema";
import * as models from "./models";
import type { OutboxRow } from "../sync/outbox";
import type { MutationEntity, MutationOp } from "../sync/protocol";

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
