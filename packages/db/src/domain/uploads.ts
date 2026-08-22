import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { TenantContext, TenantScopedTx } from "../index";
import * as schema from "../schema";
import { requiredRowDate, rowDate } from "./_rows";

/**
 * Resumable, chunked uploads (TRD §8.5, §8.6).
 *
 * ── WHAT THIS MODULE OWNS AND WHAT IT DOES NOT ──────────────────────────────
 *
 * It owns rows: opening a session, taking chunks, saying what is still missing,
 * handing the assembled bytes back, and recording where the finished object
 * ended up. It owns none of the file work — sniffing, hashing, EXIF, resizing
 * and the store itself all live in `@meridian/files`, and the route in between
 * is what joins them.
 *
 * That split is not tidiness. `packages/db` is imported by the seed script, by
 * fifteen test suites and by every server component in the application; making
 * it depend on a native image library so that one route can resize a photograph
 * would put that library on the critical path of all of them.
 *
 * ── THE THREE PROPERTIES THAT MAKE THIS SURVIVE A BAD CONNECTION ────────────
 *
 *  1. **Opening is idempotent.** `client_upload_id` is a unique index, and
 *     `openUpload` returns the existing session rather than a second one. §8.3:
 *     "the dominant real-world failure is request succeeded, response lost,
 *     client retries."
 *  2. **Receiving a chunk is idempotent.** `ON CONFLICT DO NOTHING` on
 *     `(session_id, chunk_index)`, and `received_chunks` is recounted from the
 *     rows rather than incremented — an increment would drift the first time a
 *     client resent a chunk, and a drifted counter is a session that reports
 *     itself complete while a chunk is missing.
 *  3. **Assembly verifies before it stores.** A missing middle chunk produces a
 *     perfectly valid, permanently truncated JPEG, and nothing downstream would
 *     ever notice.
 */

/** How long an unfinished upload is kept before the sweep reclaims it. */
export const UPLOAD_SESSION_TTL_HOURS = 48;

export type UploadStatus = "open" | "complete" | "aborted" | "failed";

export interface UploadSessionView {
  readonly sessionId: string;
  readonly clientUploadId: string;
  readonly purpose: string;
  readonly reference: string | null;
  readonly filename: string | null;
  readonly totalBytes: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly receivedChunks: number;
  /** Which parts are already here. The client subtracts this from its plan. */
  readonly receivedIndexes: readonly number[];
  readonly status: UploadStatus;
  readonly declaredSha256: string | null;
  readonly storageKey: string | null;
  readonly contentType: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly scanStatus: string;
  readonly capturedAt: Date | null;
  readonly capturedLat: string | null;
  readonly capturedLon: string | null;
  readonly orientation: number | null;
  readonly metadataStripped: boolean;
  readonly compression: string | null;
  readonly processingNote: string | null;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
}

// A type alias rather than an interface, deliberately: `tx.execute<T>` requires
// `Record<string, unknown>`, and TypeScript only gives an object *type* the
// implicit index signature that satisfies it — an interface does not get one.
type SessionRow = {
  id: string;
  client_upload_id: string;
  purpose: string;
  reference: string | null;
  filename: string | null;
  total_bytes: number;
  chunk_size: number;
  chunk_count: number;
  received_chunks: number;
  status: string;
  declared_sha256: string | null;
  storage_key: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  scan_status: string;
  // Timestamps from `tx.execute` arrive as space-separated strings, never as
  // Dates. See `_rows.ts` — the type parameter is an assertion, not a check.
  captured_at: string | null;
  captured_lat: string | null;
  captured_lon: string | null;
  orientation: number | null;
  metadata_stripped: boolean;
  compression: string | null;
  processing_note: string | null;
  expires_at: string;
  completed_at: string | null;
};

function toView(row: SessionRow, receivedIndexes: readonly number[]): UploadSessionView {
  return {
    sessionId: row.id,
    clientUploadId: row.client_upload_id,
    purpose: row.purpose,
    reference: row.reference,
    filename: row.filename,
    totalBytes: Number(row.total_bytes),
    chunkSize: Number(row.chunk_size),
    chunkCount: Number(row.chunk_count),
    receivedChunks: Number(row.received_chunks),
    receivedIndexes,
    status: row.status as UploadStatus,
    declaredSha256: row.declared_sha256,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256,
    scanStatus: row.scan_status,
    capturedAt: rowDate(row.captured_at),
    capturedLat: row.captured_lat,
    capturedLon: row.captured_lon,
    orientation: row.orientation === null ? null : Number(row.orientation),
    metadataStripped: row.metadata_stripped === true,
    compression: row.compression,
    processingNote: row.processing_note,
    expiresAt: requiredRowDate(row.expires_at),
    completedAt: rowDate(row.completed_at),
  };
}

const SESSION_COLUMNS = sql`
  id, client_upload_id, purpose, reference, filename,
  total_bytes, chunk_size, chunk_count, received_chunks, status, declared_sha256,
  storage_key, content_type, size_bytes, sha256, scan_status,
  captured_at, captured_lat, captured_lon, orientation,
  metadata_stripped, compression, processing_note, expires_at, completed_at
`;

async function receivedIndexesFor(tx: TenantScopedTx, sessionId: string): Promise<number[]> {
  const rows = await tx
    .select({ index: schema.uploadChunks.chunkIndex })
    .from(schema.uploadChunks)
    .where(eq(schema.uploadChunks.sessionId, sessionId))
    .orderBy(asc(schema.uploadChunks.chunkIndex));

  return rows.map((r) => Number(r.index));
}

export interface OpenUploadInput {
  /** The device's ULID. Also the `Idempotency-Key` on the init request. */
  readonly clientUploadId: string;
  readonly purpose: string;
  readonly reference?: string | null;
  readonly filename?: string | null;
  readonly totalBytes: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
  readonly declaredSha256?: string | null;
  readonly createdById?: string | null;
  readonly ttlHours?: number;
}

/**
 * Open a session, or hand back the one this client already opened.
 *
 * ── WHY THE RETRY RETURNS THE OLD SESSION EVEN IF ITS SHAPE DIFFERS ─────────
 *
 * A client that retries with a different total size has a bug, and this returns
 * the original session rather than resetting it. Resetting would throw away
 * chunks that are already here, on the say-so of a request that is by
 * definition confused — and the caller finds out anyway, because the session it
 * gets back states the chunk size and count it must actually use.
 */
export async function openUpload(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: OpenUploadInput,
): Promise<{ readonly session: UploadSessionView; readonly reused: boolean }> {
  const existing = await findUploadByClientId(tx, input.clientUploadId);
  if (existing) return { session: existing, reused: true };

  const [row] = await tx
    .insert(schema.uploadSessions)
    .values({
      tenantId: ctx.tenantId,
      clientUploadId: input.clientUploadId,
      purpose: input.purpose,
      reference: input.reference ?? null,
      filename: input.filename ?? null,
      totalBytes: input.totalBytes,
      chunkSize: input.chunkSize,
      chunkCount: input.chunkCount,
      declaredSha256: input.declaredSha256 ?? null,
      createdById: input.createdById ?? null,
      expiresAt: new Date(Date.now() + (input.ttlHours ?? UPLOAD_SESSION_TTL_HOURS) * 3_600_000),
    })
    .returning({ id: schema.uploadSessions.id });

  if (!row) throw new Error("Could not open an upload session");

  const session = await getUpload(tx, row.id);
  if (!session) throw new Error("The upload session vanished immediately after being written");
  return { session, reused: false };
}

export async function getUpload(tx: TenantScopedTx, sessionId: string): Promise<UploadSessionView | null> {
  const rows = (await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS}
      from upload_sessions
     where id = ${sessionId}::uuid
       and deleted_at is null
     limit 1
  `)) as unknown as SessionRow[];

  const row = rows[0];
  if (!row) return null;
  return toView(row, await receivedIndexesFor(tx, row.id));
}

export async function findUploadByClientId(
  tx: TenantScopedTx,
  clientUploadId: string,
): Promise<UploadSessionView | null> {
  const rows = (await tx.execute<SessionRow>(sql`
    select ${SESSION_COLUMNS}
      from upload_sessions
     where client_upload_id = ${clientUploadId}
       and deleted_at is null
     limit 1
  `)) as unknown as SessionRow[];

  const row = rows[0];
  if (!row) return null;
  return toView(row, await receivedIndexesFor(tx, row.id));
}

export interface ChunkReceipt {
  readonly received: number;
  readonly expected: number;
  /** True when this exact chunk was already here. Not an error — it is the normal retry. */
  readonly duplicate: boolean;
  readonly complete: boolean;
}

/**
 * Take one chunk.
 *
 * `received_chunks` is recounted from `upload_chunks` rather than incremented.
 * An increment drifts the first time a client resends a part it never saw
 * acknowledged — and a drifted counter is a session that believes it is
 * complete while a chunk is missing, which is the one failure mode that
 * produces a corrupt file nobody notices.
 */
export async function receiveChunk(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    readonly sessionId: string;
    readonly chunkIndex: number;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  },
): Promise<ChunkReceipt> {
  const inserted = await tx
    .insert(schema.uploadChunks)
    .values({
      tenantId: ctx.tenantId,
      sessionId: input.sessionId,
      chunkIndex: input.chunkIndex,
      sizeBytes: input.bytes.length,
      sha256: input.sha256,
      bytes: input.bytes,
    })
    .onConflictDoNothing({
      target: [schema.uploadChunks.sessionId, schema.uploadChunks.chunkIndex],
    })
    .returning({ id: schema.uploadChunks.id });

  const counted = (await tx.execute<{ received: number; expected: number }>(sql`
    update upload_sessions s
       set received_chunks = (select count(*) from upload_chunks c where c.session_id = s.id),
           updated_at = now()
     where s.id = ${input.sessionId}::uuid
       and s.status = 'open'
    returning s.received_chunks as received, s.chunk_count as expected
  `)) as unknown as { received: number; expected: number }[];

  const row = counted[0];
  if (!row) {
    throw new Error(`Upload ${input.sessionId} is not open; it cannot take any more chunks.`);
  }

  return {
    received: Number(row.received),
    expected: Number(row.expected),
    duplicate: inserted.length === 0,
    complete: Number(row.received) === Number(row.expected),
  };
}

/**
 * Every chunk of a session, in order, for assembly.
 *
 * Read inside the same transaction that completes the session, so a sweep
 * running concurrently cannot delete the parts between reading them and storing
 * the result.
 */
export async function readUploadChunks(
  tx: TenantScopedTx,
  sessionId: string,
): Promise<readonly { readonly index: number; readonly bytes: Uint8Array }[]> {
  const rows = await tx
    .select({
      index: schema.uploadChunks.chunkIndex,
      bytes: schema.uploadChunks.bytes,
    })
    .from(schema.uploadChunks)
    .where(eq(schema.uploadChunks.sessionId, sessionId))
    .orderBy(asc(schema.uploadChunks.chunkIndex));

  return rows.map((r) => ({ index: Number(r.index), bytes: r.bytes }));
}

export interface CompleteUploadInput {
  readonly sessionId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  /** `pending` when a scanner is configured, `skipped` when this deployment has none. */
  readonly scanStatus: "pending" | "skipped";
  readonly capturedAt?: Date | null;
  readonly capturedLat?: number | null;
  readonly capturedLon?: number | null;
  readonly orientation?: number | null;
  readonly metadataStripped: boolean;
  readonly compression: string;
  readonly processingNote: string;
}

/**
 * Record where the finished object went, and drop the scaffolding.
 *
 * The conditional `status = 'open'` is what makes a duplicated complete call
 * safe: the second one matches nothing, returns no row, and the caller learns
 * the session was already finished rather than writing a second object.
 */
export async function completeUpload(
  tx: TenantScopedTx,
  input: CompleteUploadInput,
): Promise<UploadSessionView | null> {
  const rows = (await tx.execute<{ id: string }>(sql`
    update upload_sessions
       set status = 'complete',
           storage_key = ${input.storageKey},
           content_type = ${input.contentType},
           size_bytes = ${input.sizeBytes},
           sha256 = ${input.sha256},
           scan_status = ${input.scanStatus},
           captured_at = ${input.capturedAt ?? null},
           captured_lat = ${input.capturedLat ?? null},
           captured_lon = ${input.capturedLon ?? null},
           orientation = ${input.orientation ?? null},
           metadata_stripped = ${input.metadataStripped},
           compression = ${input.compression},
           processing_note = ${input.processingNote.slice(0, 400)},
           completed_at = now(),
           updated_at = now()
     where id = ${input.sessionId}::uuid
       and status = 'open'
    returning id
  `)) as unknown as { id: string }[];

  if (rows.length === 0) return null;

  // The parts have served their purpose and the assembled object is in the
  // store. Keeping them would mean holding every uploaded photo twice, once as
  // bytea and once as a file.
  await tx.delete(schema.uploadChunks).where(eq(schema.uploadChunks.sessionId, input.sessionId));

  return getUpload(tx, input.sessionId);
}

/** Give up on a session and release its parts. Safe to call twice. */
export async function abortUpload(
  tx: TenantScopedTx,
  sessionId: string,
  reason: string,
  status: "aborted" | "failed" = "aborted",
): Promise<boolean> {
  const rows = (await tx.execute<{ id: string }>(sql`
    update upload_sessions
       set status = ${status},
           processing_note = ${reason.slice(0, 400)},
           updated_at = now()
     where id = ${sessionId}::uuid
       and status = 'open'
    returning id
  `)) as unknown as { id: string }[];

  if (rows.length === 0) return false;
  await tx.delete(schema.uploadChunks).where(eq(schema.uploadChunks.sessionId, sessionId));
  return true;
}

export interface UploadSweepResult {
  readonly abandoned: number;
  readonly bytesReclaimed: number;
}

/**
 * Reclaim uploads nobody finished.
 *
 * A technician whose phone died mid-upload leaves half a photo in `bytea`, and
 * nothing else in the system will ever come back for it. Left alone, the table
 * grows by every abandoned attempt on every bad connection forever — and unlike
 * an orphaned object in a bucket, this one is inside the database that
 * everything else queries.
 *
 * The session row survives its chunks. It is small, it records that somebody
 * tried and failed, and that record is what turns "the app doesn't work" into a
 * number somebody can look at.
 */
export async function sweepAbandonedUploads(tx: TenantScopedTx): Promise<UploadSweepResult> {
  const measured = (await tx.execute<{ bytes: string | number | null }>(sql`
    select coalesce(sum(c.size_bytes), 0) as bytes
      from upload_chunks c
      join upload_sessions s on s.id = c.session_id
     where s.status = 'open'
       and s.expires_at < now()
  `)) as unknown as { bytes: string | number | null }[];

  const bytesReclaimed = Number(measured[0]?.bytes ?? 0);

  const swept = (await tx.execute<{ id: string }>(sql`
    update upload_sessions
       set status = 'aborted',
           processing_note = 'Abandoned: the client never sent every chunk before the session expired.',
           updated_at = now()
     where status = 'open'
       and expires_at < now()
    returning id
  `)) as unknown as { id: string }[];

  if (swept.length > 0) {
    await tx.execute(sql`
      delete from upload_chunks
       where session_id in (
         select id from upload_sessions where status = 'aborted' and expires_at < now()
       )
    `);
  }

  return { abandoned: swept.length, bytesReclaimed };
}

export interface UploadPressure {
  readonly open: number;
  readonly bytesStaged: number;
  readonly oldestOpenMinutes: number;
}

/** How much unfinished upload is sitting in the database right now. */
export async function uploadPressure(tx: TenantScopedTx): Promise<UploadPressure> {
  const rows = (await tx.execute<{
    open: number;
    bytes: string | number | null;
    oldest_minutes: number | null;
  }>(sql`
    select count(distinct s.id)::int as open,
           coalesce(sum(c.size_bytes), 0) as bytes,
           coalesce(max(extract(epoch from (now() - s.created_at)) / 60), 0)::int as oldest_minutes
      from upload_sessions s
      left join upload_chunks c on c.session_id = s.id
     where s.status = 'open'
       and s.deleted_at is null
  `)) as unknown as { open: number; bytes: string | number | null; oldest_minutes: number | null }[];

  const row = rows[0];
  return {
    open: Number(row?.open ?? 0),
    bytesStaged: Number(row?.bytes ?? 0),
    oldestOpenMinutes: Number(row?.oldest_minutes ?? 0),
  };
}

/** Completed uploads whose object is waiting on a scan. Feeds `/api/cron/scan`. */
export async function pendingUploadScans(
  tx: TenantScopedTx,
  limit = 50,
): Promise<readonly { readonly sessionId: string; readonly storageKey: string }[]> {
  const rows = await tx
    .select({ id: schema.uploadSessions.id, storageKey: schema.uploadSessions.storageKey })
    .from(schema.uploadSessions)
    .where(
      and(
        eq(schema.uploadSessions.status, "complete"),
        eq(schema.uploadSessions.scanStatus, "pending"),
        isNull(schema.uploadSessions.deletedAt),
      ),
    )
    .orderBy(asc(schema.uploadSessions.completedAt))
    .limit(limit);

  return rows.flatMap((r) => (r.storageKey ? [{ sessionId: r.id, storageKey: r.storageKey }] : []));
}

/** Record a verdict against an uploaded object. */
export async function recordUploadScan(
  tx: TenantScopedTx,
  input: { readonly sessionId: string; readonly scanStatus: "clean" | "infected" | "skipped" },
): Promise<boolean> {
  const rows = (await tx.execute<{ id: string }>(sql`
    update upload_sessions
       set scan_status = ${input.scanStatus}, updated_at = now()
     where id = ${input.sessionId}::uuid
       and scan_status = 'pending'
    returning id
  `)) as unknown as { id: string }[];

  return rows.length > 0;
}
