/**
 * The field API wire contract.
 *
 * ── THIS FILE IS ONE FILE ON PURPOSE, AND IT EARNED IT ─────────────────────
 *
 * It was first written against TRD §8.5 verbatim, because
 * `apps/web/src/app/api/field/**` did not exist yet. The routes landed during
 * the same session and disagreed with the specification in nine places. Because
 * the entire wire vocabulary lives here, conforming was one file's worth of
 * edits rather than an archaeology exercise across the app.
 *
 * **Everything below is now transcribed from the real route handlers**, not
 * from the document:
 *
 *   `apps/web/src/app/api/field/v1/sync/route.ts`
 *   `apps/web/src/app/api/field/v1/mutations/route.ts`
 *   `apps/web/src/app/api/field/v1/_device.ts`
 *   `apps/web/src/app/api/field/v1/devices/register/route.ts`
 *   `packages/db/src/domain/field.ts`  (FieldMutation, FieldSyncPage, …)
 *
 * ── WHERE THE SERVER DIFFERS FROM TRD §8.5, FOR THE RECORD ─────────────────
 *
 *   1. **camelCase, not snake_case.** `clientId`, `baseVersion`, `serverTime`.
 *      §8.5 shows `next_cursor` and `server_time`; the routes send `nextCursor`
 *      and `serverTime`.
 *   2. **Four result lists, not two.** `accepted` / `conflicts` / `rejected` /
 *      `deferred`. §8.5 shows two. The extra two are right: "will never
 *      succeed" and "its dependency has not landed yet" need opposite handling
 *      and folding them into `conflicts` would have the device retry the first
 *      for ever and give up on the second.
 *   3. **No 409.** §8.3 specifies `409 on base_version mismatch`. The routes
 *      return 200 with the mutation in `conflicts`, which is the only thing
 *      that works for a batch where one of forty conflicts.
 *   4. **`baseVersion` is an ISO timestamp string**, not an integer version.
 *   5. **Device-token auth.** `Authorization: Bearer <token>`, with rotation
 *      delivered in the response body of whatever request triggered it - a
 *      phone that needed a second request to stay signed in would have a second
 *      chance to lose the new token. The old one stays valid ten more minutes.
 *   6. **The device reports its own clock** in `x-field-device-time` and the
 *      server returns the measured `clockSkewMs`. §8.5 has the device infer it
 *      from `server_time` alone; the client does both, since the server's
 *      measurement is the one that ends up on the device row.
 *   7. **`scope.jobIds` instead of tombstones.** The pull names every job id in
 *      the working set, changed or not, and the device deletes anything absent.
 *   8. **No parts catalogue.** §8.2 lists it; the server declares it in
 *      `notYetAvailable` because no SKU table exists. The local `parts` table
 *      therefore stays empty and the materials screen must fall back to free
 *      text - which `MaterialLine.needsOfficeReconciliation` already supports.
 *   9. **No PPE or RAMS templates**, for the same reason. `FLD-4`'s safety gate
 *      has no data to gate on, so it refuses everything - see JobCardScreen.
 *
 * ── NOW VERIFIED OVER HTTP, AND WHAT THAT FOUND ────────────────────────────
 *
 * This block used to say that nothing here had ever been exercised over HTTP by
 * either side, and that the first time the app pointed at a running server this
 * file should be expected to be wrong somewhere.
 *
 * `test/wire-contract.ts` is that first time. It registers a real device against
 * the real route with a real session cookie, pulls, pushes and rotates against a
 * live `next start`, and runs the server's real bytes through the parsers below
 * rather than reading them by eye. **Every shape declared in this file survived
 * it**: the four result lists, the four-state `gaps`, absent-versus-null
 * `taxonomies`, optional `scope`, the ISO timestamps, `deviceToken` rotation on
 * the body of whatever request triggered it, and `device_unknown` /
 * `device_revoked`.
 *
 * What the connection did find was in the *payloads*, which this file has no
 * schema for and `payloads.ts` composes - see the two builders corrected there -
 * and two defects on the server side of the contract, which
 * `test/wire-contract.ts` asserts rather than works around, and which
 * `README.md` names.
 */

import { z } from "zod";

export const FIELD_API_VERSION = "v1";
export const SYNC_PATH = `/api/field/${FIELD_API_VERSION}/sync`;
export const MUTATIONS_PATH = `/api/field/${FIELD_API_VERSION}/mutations`;
export const DEVICE_REGISTER_PATH = `/api/field/${FIELD_API_VERSION}/devices/register`;
export const DEVICE_CURRENT_PATH = `/api/field/${FIELD_API_VERSION}/devices/current`;

export const UPLOAD_INIT_PATH = `/api/field/${FIELD_API_VERSION}/uploads/init`;
export const UPLOAD_COMPLETE_PATH = `/api/field/${FIELD_API_VERSION}/uploads/complete`;
export const DEVICE_SIGNOUT_PATH = `/api/field/${FIELD_API_VERSION}/devices/current`;

/**
 * Both work; `Authorization: Bearer <token>` is the one to keep, per the API
 * author. The legacy header is kept as a constant only so that a handset
 * talking to an older server has something to fall back to - nothing sends it.
 */
export const DEVICE_TOKEN_HEADER_LEGACY = "x-field-device-token";
export const DEVICE_TIME_HEADER = "x-field-device-time";
export const APP_VERSION_HEADER = "x-field-app-version";

/** `MAX_BATCH` in the mutations route. Exceeding it is refused, not truncated. */
export const MAX_BATCH = 200;

// ── Mutations, upward ───────────────────────────────────────────────────────

/**
 * `FIELD_MUTATION_KINDS` from `packages/db/src/domain/field.ts`, as
 * `entity/op` pairs.
 *
 * *"The list is closed, and that is the point: an unrecognised pair is rejected
 * rather than routed somewhere plausible."* Mirrored here so the device refuses
 * to queue a mutation the server would reject, rather than discovering it after
 * a technician has walked to the van.
 */
export const FIELD_MUTATION_KINDS = [
  "job_status/transition",
  "job_outcome/record",
  "job_attachment/append",
  "job_material/append",
  "job_material/declare_none",
  "job_photo/exempt",
  "visit_labour/record",
  "job_signature/record",
  "job_note/upsert",
  "attendance/append",
] as const;

export type FieldMutationKind = (typeof FIELD_MUTATION_KINDS)[number];

export const MUTATION_ENTITIES = [
  "job_status",
  "job_outcome",
  "job_attachment",
  "job_material",
  "job_photo",
  "visit_labour",
  "job_signature",
  "job_note",
  "attendance",
] as const;

export type MutationEntity = (typeof MUTATION_ENTITIES)[number];
export type MutationOp = string;

export function mutationKind(entity: MutationEntity, op: MutationOp): string {
  return `${entity}/${op}`;
}

export function isKnownMutationKind(entity: MutationEntity, op: MutationOp): boolean {
  return (FIELD_MUTATION_KINDS as readonly string[]).includes(mutationKind(entity, op));
}

/** One outbox row, on the wire. Field names match `FieldMutation` exactly. */
export interface OutboundMutation {
  /** ULID minted on the device. The per-mutation idempotency key. */
  readonly clientId: string;
  readonly entity: MutationEntity;
  readonly op: MutationOp;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * What the device believed the server held - an ISO timestamp, not an
   * integer. Null for anything append-only, which cannot be stale.
   */
  readonly baseVersion: string | null;
  readonly dependsOnClientId: string | null;
  /** ADR 0004. The device's own clock. Never trusted for a report. */
  readonly recordedOfflineAt: string;
}

export interface MutationBatchRequest {
  readonly mutations: readonly OutboundMutation[];
}

/** Rotation: a new token arrives in the body and must be persisted at once. */
export const deviceTokenSchema = z.object({
  token: z.string(),
  expiresAt: z.string(),
});

const acceptedSchema = z.object({
  clientId: z.string(),
  /**
   * ADR 0004's server receipt time. ISO-8601.
   *
   * ── AND WHY IT MUST NOT BE USED FOR ORDERING ──────────────────────────────
   *
   * Every mutation in a request is applied in one transaction, and Postgres
   * `now()` is the transaction start time - so this value is **byte-identical
   * for every row in a batch**. That is the correct answer to "when did the
   * server receive this" and it is not an answer to "which of these two
   * happened first". Rows written together record no order.
   *
   * The only honest source of ordering is the order the device sent them in;
   * the server applies a batch in array order. `engine.ts` is what guarantees
   * that order, and nothing anywhere may sort by this field to recover it.
   * `audit_log` and `product_events` have the same property and it has caught
   * people who selected "the newest row".
   */
  serverReceivedAt: z.string(),
  /** The row id the effect produced, where it produced one. */
  serverId: z.string().optional(),
  /** Whatever else the domain function returned. Shape varies by kind. */
  result: z.record(z.string(), z.unknown()).default({}),
});

const conflictSchema = z.object({
  clientId: z.string(),
  reason: z.string(),
  serverState: z.record(z.string(), z.unknown()).default({}),
  /** The sentence the technician's phone shows. Written by the server. */
  detail: z.string(),
});

const rejectedSchema = z.object({
  clientId: z.string(),
  message: z.string(),
  /**
   * The server-computed `JOB-15` gaps, present only when the refusal was the
   * completion gate. *"Structured, because a sentence is something to show and
   * a list is something to act on."*
   *
   * **Optional, and absent is not empty.** An empty array would mean "nothing
   * is missing", which is never true of a rejected completion - so this must
   * not be given a `.default([])`, which is exactly the mistake that would make
   * a refused card look ready.
   */
  gaps: z.array(z.string()).optional(),
});
const deferredSchema = z.object({ clientId: z.string(), dependsOn: z.string() });

export const mutationResponseSchema = z.object({
  accepted: z.array(acceptedSchema).default([]),
  conflicts: z.array(conflictSchema).default([]),
  rejected: z.array(rejectedSchema).default([]),
  deferred: z.array(deferredSchema).default([]),
  serverTime: z.string(),
  clockSkewMs: z.number().nullable().default(null),
  deviceToken: deviceTokenSchema.optional(),
});

export type MutationAccepted = z.infer<typeof acceptedSchema>;
export type MutationConflict = z.infer<typeof conflictSchema>;
export type MutationRejected = z.infer<typeof rejectedSchema>;
export type MutationDeferred = z.infer<typeof deferredSchema>;
export type MutationResponse = z.infer<typeof mutationResponseSchema>;
export type DeviceToken = z.infer<typeof deviceTokenSchema>;

// ── Sync, downward ──────────────────────────────────────────────────────────

/**
 * Record shapes are passthrough - `z.record(z.string(), z.unknown())`.
 *
 * The device stores what it is given and reads the fields it knows.
 * Enumerating every column here would put a second copy of the server's schema
 * in a place that cannot be migrated, and would mean a server adding a column
 * broke every handset still on an old build.
 */
const record = z.record(z.string(), z.unknown());

export const syncResponseSchema = z.object({
  serverTime: z.string(),
  nextCursor: z.string(),
  /** The pull hit its page cap: come straight back rather than waiting. */
  truncated: z.boolean().default(false),
  /** No cursor was sent: this was a first, complete sync. */
  complete: z.boolean().default(false),
  jobs: z.array(record).default([]),
  customers: z.array(record).default([]),
  properties: z.array(record).default([]),
  assets: z.array(record).default([]),
  certifications: z.array(record).default([]),
  /**
   * **Null means "unchanged, keep what you have".** Not an empty object.
   * Conflating the two blanks the technician's fault-code picker, which is the
   * server's own stated reason for the distinction - so the client must not
   * "helpfully" default it.
   */
  taxonomies: z
    .object({
      faultCodes: z.array(record).default([]),
      outcomeCodes: z.array(record).default([]),
      photoExemptionReasons: z.array(record).default([]),
      rateCard: z.array(record).default([]),
    })
    .nullable()
    .default(null),
  /**
   * The authoritative membership of the working set: every job id in scope,
   * changed or not. **The device deletes anything not named here.** This is
   * what stops a job reassigned to somebody else living on the phone for ever.
   *
   * ── WHY THIS IS `optional()` AND NOT `default({ jobIds: [] })` ─────────────
   *
   * It was the default, and the default was a way to lose a technician's day.
   *
   * `{ jobIds: [] }` is a real and meaningful answer: *"you have nothing
   * assigned"*, and the device is right to empty itself. **Absent** is a
   * different statement: the server said nothing about membership, and the
   * device must keep what it holds. Defaulting one to the other means any
   * response that loses this key - an older server, a proxy that rewrites a
   * body, a partial deserialisation - reads as "you have no jobs" and evicts
   * the entire working set.
   *
   * This is the same absent-versus-empty distinction the route's own comment
   * makes about `taxonomies`, on the one field where reading it wrongly is
   * destructive rather than merely blank. `planRemovals` refuses to compute
   * any removal at all when it is undefined.
   */
  scope: z.object({ jobIds: z.array(z.string()).default([]) }).optional(),
  unavailableOffline: z.array(record).default([]),
  notYetAvailable: z.array(record).default([]),
  device: z
    .object({
      id: z.string(),
      label: z.string().nullable().optional(),
      technicianId: z.string(),
    })
    .optional(),
  manifest: z.array(record).default([]),
  deviceToken: deviceTokenSchema.optional(),
});

export type SyncResponse = z.infer<typeof syncResponseSchema>;

export const registerResponseSchema = z.object({
  device: z.object({ id: z.string(), technicianId: z.string() }),
  deviceToken: deviceTokenSchema,
  serverTime: z.string(),
});

export type RegisterResponse = z.infer<typeof registerResponseSchema>;

/** `fieldError()` in `_device.ts`. Every failure has this shape. */
export const errorEnvelopeSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * The error codes the routes emit. Two of them mean the same thing to the
 * technician and different things to the app: `device_revoked` must clear the
 * stored token, `device_expired` need not.
 */
export type FieldErrorCode =
  | "device_unknown"
  | "device_expired"
  | "device_revoked"
  | "unauthenticated"
  | "not_a_technician"
  | "rate_limited"
  | "bad_request"
  | "refused"
  | "server_error"
  | "unknown";

// ── Uploads ─────────────────────────────────────────────────────────────────

/**
 * `POST /api/field/v1/uploads/init`.
 *
 * ── `jobId` IS REQUIRED, AND THAT IS THE SECURITY CONTROL ──────────────────
 *
 * Every technician holds `jobs:update`, so permission alone would let any
 * handset attach a photograph to any job in the tenant. The server checks
 * `jobId` against this technician's assignments at init, and the attachment
 * mutation later cites the `uploadId` rather than a storage key - so the
 * question "who was allowed to produce this object" is still answerable at the
 * moment it is filed. A key is a string, and by the time a string arrives that
 * question is gone.
 */
export interface UploadInitRequest {
  /** Idempotent on this. A retried init returns the same upload, `reused: true`. */
  readonly clientUploadId: string;
  readonly purpose: UploadPurpose;
  readonly jobId: string;
  readonly totalBytes: number;
  readonly chunkSize?: number;
  readonly sha256?: string;
  readonly filename?: string;
}

/** The server accepts these two and nothing else. */
export type UploadPurpose = "job_photo" | "job_signature";

export const uploadInitResponseSchema = z.object({
  uploadId: z.string(),
  clientUploadId: z.string(),
  purpose: z.string(),
  jobId: z.string(),
  status: z.string(),
  chunkSize: z.number(),
  chunkCount: z.number(),
  /** Recounted, not incremented - resumption costs the chunks actually lost. */
  receivedChunks: z.array(z.number()).default([]),
  chunkUrls: z.array(z.string()).default([]),
  /**
   * **True, and it changes how the chunk is sent.**
   *
   * These URLs are not presigned. Chunks are stored as `bytea` rows rather
   * than staged objects, because `ObjectStore.put()` sniffs content and would
   * refuse the middle 512 KB of a JPEG - there is nothing to presign a URL to.
   * So the chunk PUT goes to *this* server and **must carry the device token**,
   * which is the opposite of what a presigned third-party URL requires.
   * `client.ts` branches on this flag rather than assuming either.
   */
  sameOrigin: z.boolean().default(true),
  /** True when init was replayed and this upload already existed. */
  reused: z.boolean().default(false),
  expiresAt: z.string(),
});

export const uploadChunkResponseSchema = z.object({
  uploadId: z.string(),
  chunkIndex: z.number(),
  /** True when this chunk had already landed. Not an error. */
  duplicate: z.boolean().default(false),
  receivedChunks: z.array(z.number()).default([]),
  chunkCount: z.number(),
  complete: z.boolean().default(false),
});

/**
 * `POST /api/field/v1/uploads/complete`.
 *
 * Note what comes back and what the device therefore stops guessing at:
 * `contentType` was sniffed from the bytes, and `capturedAt`, `capturedLat`,
 * `capturedLon` and `orientation` were extracted from the image's own EXIF
 * into columns (§8.6). The phone's guesses are ignored. `capturedAt` falls
 * back to the skew-corrected device time only when the image carried no
 * timestamp of its own.
 *
 * **`scanStatus` comes back `pending`.** An unscanned photograph is never
 * presented as cleared.
 *
 * No `storageKey` is ever returned - `SEC-8`: a key is not a link.
 */
export const uploadCompleteResponseSchema = z.object({
  uploadId: z.string(),
  clientUploadId: z.string(),
  status: z.string(),
  contentType: z.string().nullable().default(null),
  sizeBytes: z.number().nullable().default(null),
  sha256: z.string().nullable().default(null),
  scanStatus: z.string(),
  capturedAt: z.string().nullable().default(null),
  capturedLat: z.number().nullable().default(null),
  capturedLon: z.number().nullable().default(null),
  orientation: z.number().nullable().default(null),
  metadataStripped: z.boolean().nullable().default(null),
  compression: z.unknown().optional(),
  note: z.string().nullable().default(null),
  serverReceivedAt: z.string(),
});

export type UploadInitResponse = z.infer<typeof uploadInitResponseSchema>;
export type UploadChunkResponse = z.infer<typeof uploadChunkResponseSchema>;
export type UploadCompleteResponse = z.infer<typeof uploadCompleteResponseSchema>;

export function uploadChunkPath(uploadId: string, index: number): string {
  return `/api/field/${FIELD_API_VERSION}/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * A parse failure is a *protocol* error and is named as one.
 *
 * The retry rules differ: a network error should be retried for ever, and a
 * response this build cannot read fails identically on every attempt. Retrying
 * it is how a queue looks busy for a week while achieving nothing - `FLD-17`'s
 * stated failure.
 */
export class ProtocolError extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`The office sent a response this app version could not read (${path}): ${detail}`);
    this.name = "ProtocolError";
  }
}

export function parseSyncResponse(raw: unknown): SyncResponse {
  const result = syncResponseSchema.safeParse(raw);
  if (!result.success) throw new ProtocolError(SYNC_PATH, summarise(result.error));
  return result.data;
}

export function parseMutationResponse(raw: unknown): MutationResponse {
  const result = mutationResponseSchema.safeParse(raw);
  if (!result.success) throw new ProtocolError(MUTATIONS_PATH, summarise(result.error));
  return result.data;
}

export function parseRegisterResponse(raw: unknown): RegisterResponse {
  const result = registerResponseSchema.safeParse(raw);
  if (!result.success) throw new ProtocolError(DEVICE_REGISTER_PATH, summarise(result.error));
  return result.data;
}

export function parseUploadInitResponse(raw: unknown): UploadInitResponse {
  const result = uploadInitResponseSchema.safeParse(raw);
  if (!result.success) throw new ProtocolError(UPLOAD_INIT_PATH, summarise(result.error));
  return result.data;
}

export function parseUploadChunkResponse(raw: unknown, path: string): UploadChunkResponse {
  const result = uploadChunkResponseSchema.safeParse(raw);
  if (!result.success) throw new ProtocolError(path, summarise(result.error));
  return result.data;
}

export function parseUploadCompleteResponse(raw: unknown): UploadCompleteResponse {
  const result = uploadCompleteResponseSchema.safeParse(raw);
  if (!result.success) throw new ProtocolError(UPLOAD_COMPLETE_PATH, summarise(result.error));
  return result.data;
}

/** Best-effort: an error body that is not the declared envelope still yields a code. */
export function parseErrorEnvelope(raw: unknown): { code: FieldErrorCode; message: string } {
  const result = errorEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    return { code: "unknown", message: "The office could not be reached properly." };
  }
  return { code: result.data.error.code as FieldErrorCode, message: result.data.error.message };
}

function summarise(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
