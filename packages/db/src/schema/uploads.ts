import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  numeric,
  timestamp,
  uuid,
  index,
  uniqueIndex,
  customType,
} from "drizzle-orm/pg-core";
import { idCol, timestamps } from "./_shared";
import { tenants, users } from "./tenancy";

/**
 * Resumable, chunked uploads — the transport for TRD §8.5 and §8.6.
 *
 * ── WHAT THIS TABLE IS NOT ──────────────────────────────────────────────────
 *
 * It is not job photos, and it is not candidate documents. Those are domain
 * tables owned by the parts of the system that care what a photo *means* —
 * `job_attachments`, `job_signatures`, `candidate_documents`. This is the
 * conveyor belt underneath all of them: it gets bytes from a phone on a bad
 * connection into the object store, in one piece, once, and then it is done. A
 * completed session hands back a storage key, a content type and a SHA-256, and
 * the domain row cites those.
 *
 * Keeping the two apart is what lets the field app upload a photo before the
 * job note it belongs to has ever reached the server — which §8.3 requires,
 * because `depends_on_client_id` orders the *record* sync and the media queue
 * runs beside it, not inside it.
 *
 * ── WHY THE CHUNKS ARE ROWS ─────────────────────────────────────────────────
 *
 * See migration 0026 for the long version. The short one: `ObjectStore.put()`
 * sniffs content type from magic bytes and refuses anything outside its
 * allowlist, and the middle 512 KB of a JPEG is not a JPEG. Staging parts in the
 * store would have required a second write path that skips the sniffer, which
 * is precisely the hole `SEC-8` is shaped to prevent. So parts are rows, only
 * the assembled file reaches the store, and it goes through the same front door
 * as everything else.
 */

/**
 * `bytea`, as `Uint8Array` on the TypeScript side.
 *
 * Drizzle has no built-in for it. `postgres` hands back a Buffer, which *is* a
 * Uint8Array, but the conversion is written out rather than assumed — a
 * `Buffer` leaking into code that does `new Uint8Array(x)` on it produces a
 * view over the whole pooled slab rather than the row's bytes, which is a
 * memory-disclosure bug wearing a type error's clothes.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

export const uploadSessions = pgTable(
  "upload_sessions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /**
     * The ULID the device generated before it had a server (§8.3), and the
     * idempotency key for the init call. "Request succeeded, response lost,
     * client retries" is the dominant real-world failure; without this a day on
     * bad wifi leaves forty abandoned half-uploads and one photo.
     */
    clientUploadId: varchar("client_upload_id", { length: 64 }).notNull(),
    /**
     * Vocabulary, not a foreign key. The list lives in
     * `apps/web/src/lib/uploads.ts`, which is also where each purpose is mapped
     * to the permission a caller must already hold — `job_photo`,
     * `job_signature`, `candidate_document`, `project_permit_document`,
     * `project_snag_photo`. Adding one needs no migration; the column is wide
     * enough, and that is deliberate.
     *
     * What is recorded here is what the attach path checks: a caller cites an
     * upload id and the server reads the purpose off this row, so an upload
     * authorised as one kind of file cannot be stapled to another kind of
     * record.
     */
    purpose: varchar("purpose", { length: 32 }).notNull(),
    /** The caller's handle for what this illustrates. Never resolved here; handed back at completion. */
    reference: varchar("reference", { length: 120 }),
    filename: varchar("filename", { length: 200 }),
    totalBytes: integer("total_bytes").notNull(),
    chunkSize: integer("chunk_size").notNull(),
    chunkCount: integer("chunk_count").notNull(),
    /** What the client says the finished file hashes to. Verified at assembly, refused on mismatch. */
    declaredSha256: varchar("declared_sha256", { length: 64 }),
    receivedChunks: integer("received_chunks").notNull().default(0),
    /** `open` | `complete` | `aborted` | `failed`. */
    status: varchar("status", { length: 16 }).notNull().default("open"),

    storageKey: text("storage_key"),
    contentType: varchar("content_type", { length: 80 }),
    sizeBytes: integer("size_bytes"),
    sha256: varchar("sha256", { length: 64 }),
    /** The same four states, and the same gate, as `candidate_documents.scan_status`. */
    scanStatus: varchar("scan_status", { length: 16 }).notNull().default("pending"),

    /** §8.6's structured columns. The evidential copy of what the file said about itself. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    capturedLat: numeric("captured_lat", { precision: 9, scale: 6 }),
    capturedLon: numeric("captured_lon", { precision: 9, scale: 6 }),
    orientation: smallint("orientation"),
    /** False on a stored image means this system could not clean it — and that is queryable. */
    metadataStripped: boolean("metadata_stripped").notNull().default(false),
    compression: varchar("compression", { length: 16 }),
    processingNote: varchar("processing_note", { length: 400 }),

    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("upload_sessions_client_idx").on(t.tenantId, t.clientUploadId),
    index("upload_sessions_open_idx").on(t.tenantId, t.status, t.expiresAt),
  ],
);

export const uploadChunks = pgTable(
  "upload_chunks",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => uploadSessions.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("upload_chunks_part_idx").on(t.sessionId, t.chunkIndex),
    index("upload_chunks_session_idx").on(t.tenantId, t.sessionId),
  ],
);
