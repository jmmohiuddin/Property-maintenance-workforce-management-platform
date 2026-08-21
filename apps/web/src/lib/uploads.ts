import "server-only";
import { can, isStaff, type Permission } from "@meridian/auth";
import { withTenant, type TenantContext, type TenantScopedTx } from "@meridian/db";
import {
  abortUpload,
  completeUpload,
  getUpload,
  readUploadChunks,
  type UploadSessionView,
} from "@meridian/db/domain";
import {
  EXTENSION_FOR,
  NO_EXIF,
  ObjectStoreError,
  assembleUpload,
  hasJpegMetadata,
  imagePipeline,
  missingChunks,
  objectStore,
  planUpload,
  readJpegExif,
  sha256Hex,
  sniffContentType,
  stripMetadata,
  virusScanner,
  type AllowedContentType,
  type StoredObject,
} from "@meridian/files";
import { getSession } from "@/lib/session";

/**
 * The upload transport (TRD §8.5, §8.6).
 *
 * ── WHY THESE ROUTES EXIST BEFORE THE FIELD APP DOES ───────────────────────
 *
 * §8.5 names `POST /api/field/v1/uploads/init` and `/complete` on the field
 * API, and the field API does not exist — it needs `SEC-7` device
 * authentication, which is not built and is not something to invent in a file
 * about photographs. So the transport is here, behind the staff session that
 * already exists, and the field app's own route later becomes a second door
 * onto the same three functions rather than a second implementation of them.
 *
 * Doing it this way round has a second effect worth stating: the job-card
 * screens being built this wave can attach a photograph today, over a
 * connection that survives being dropped, rather than waiting for a phone.
 *
 * ── WHERE THE §8.6 PIPELINE ACTUALLY RUNS ──────────────────────────────────
 *
 * On the device, per the spec — capture, EXIF, orientation, compress,
 * thumbnail, queue — and then again here, because "on the device" is a sentence
 * with a hole in it. A field app built by somebody else, a version that shipped
 * before the compression step landed, or a photo attached from this console
 * rather than a phone, all put a 12 MB original with live GPS coordinates in
 * front of `completeStagedUpload`, and it is the only place that can notice.
 */

export const UPLOAD_PURPOSES = ["job_photo", "job_signature", "candidate_document"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/**
 * What a caller must already be allowed to do before it may upload for this
 * purpose.
 *
 * Existing permissions, deliberately — no `uploads:write`. A permission that
 * only guards the conveyor belt would be a permission somebody grants because
 * "it is just file upload", after which anyone holding it can put a file
 * against a job they cannot otherwise touch.
 */
const PERMISSION_FOR: Readonly<Record<UploadPurpose, Permission>> = {
  job_photo: "jobs:update",
  job_signature: "jobs:update",
  candidate_document: "recruitment:write",
};

export function isUploadPurpose(value: string): value is UploadPurpose {
  return (UPLOAD_PURPOSES as readonly string[]).includes(value);
}

export type UploadAuth =
  | { readonly ok: true; readonly ctx: TenantContext; readonly userId: string }
  | { readonly ok: false; readonly response: Response };

/** Plain text and status codes, never a redirect — see `lib/documents.ts` for why. */
export function uploadRefusal(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function authoriseUpload(purpose: UploadPurpose): Promise<UploadAuth> {
  const session = await getSession();
  if (!session) return { ok: false, response: uploadRefusal(401, "Sign in to upload.") };

  if (!isStaff(session.principal.role)) {
    return { ok: false, response: uploadRefusal(403, "Uploads are not available outside the office.") };
  }
  if (!can(session.principal, PERMISSION_FOR[purpose])) {
    return {
      ok: false,
      response: uploadRefusal(403, `Your role cannot upload a ${purpose.replace("_", " ")}.`),
    };
  }

  return {
    ok: true,
    userId: session.principal.userId,
    ctx: {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user",
    },
  };
}

/**
 * Authorise against a session that already exists, by its own recorded purpose.
 *
 * The purpose is read from the row rather than taken from the request, which is
 * the whole point: a caller who may upload a candidate document must not be
 * able to finish somebody's job photo by naming a different purpose in a query
 * parameter.
 */
export async function authoriseExistingUpload(
  sessionId: string,
): Promise<UploadAuth & { session?: UploadSessionView }> {
  const signedIn = await getSession();
  if (!signedIn) return { ok: false, response: uploadRefusal(401, "Sign in to upload.") };

  const found = await withTenant(
    {
      tenantId: signedIn.principal.tenantId,
      userId: signedIn.principal.userId,
      actorKind: "user",
    },
    (tx) => getUpload(tx, sessionId),
  ).catch(() => null);

  // Not-found and not-in-this-tenant are the same answer: row-level security
  // returns no row for either, and telling them apart would confirm that a
  // session id exists somewhere else.
  if (!found) return { ok: false, response: uploadRefusal(404, "There is no such upload.") };
  if (!isUploadPurpose(found.purpose)) {
    return { ok: false, response: uploadRefusal(409, "This upload has a purpose this build does not know.") };
  }

  const auth = await authoriseUpload(found.purpose);
  return auth.ok ? { ...auth, session: found } : auth;
}

export interface FinishedUpload {
  readonly session: UploadSessionView;
  readonly object: StoredObject;
}

/**
 * Assemble, inspect, process and store.
 *
 * ── THE ORDER IS THE SPECIFICATION ─────────────────────────────────────────
 *
 * Verify the parts, then the hash, then the type from the bytes, then extract
 * EXIF into columns, then compress (which applies orientation), then strip
 * metadata and check that it is gone, then store. Every step earns its place:
 *
 *  * **Verify before storing.** A missing middle chunk assembles into a
 *    perfectly valid, permanently truncated JPEG that nothing downstream would
 *    ever question.
 *  * **Extract before stripping.** §8.6, and the reason is that EXIF is
 *    fragile — the compression step below would destroy it, which is exactly
 *    what makes it worthless as evidence and exactly why it goes in a column.
 *  * **Strip before egress, not at egress.** Doing it here means the stored
 *    artefact is already clean, so a future export path cannot forget.
 *
 * ── WHY THE STORE WRITE HAPPENS OUTSIDE THE TRANSACTION ────────────────────
 *
 * A `put()` inside a transaction that then rolls back leaves an object nothing
 * references and — because objects are write-once (`OPS-6`) — a key that can
 * never be rewritten, so the retry fails forever. Instead the key is derived
 * from the session id, the write is idempotent (an existing object with a
 * matching hash is accepted as our own), and the row is updated afterwards.
 */
export async function completeStagedUpload(
  ctx: TenantContext,
  sessionId: string,
): Promise<{ ok: true; result: FinishedUpload } | { ok: false; response: Response }> {
  const staged = await withTenant(ctx, async (tx) => {
    const session = await getUpload(tx, sessionId);
    if (!session) return { problem: uploadRefusal(404, "There is no such upload.") } as const;

    if (session.status === "complete") {
      return { problem: null, alreadyDone: session } as const;
    }
    if (session.status !== "open") {
      return {
        problem: uploadRefusal(409, `This upload was ${session.status} and cannot be completed.`),
      } as const;
    }

    const plan = planUpload(session.totalBytes, session.chunkSize);
    const parts = await readUploadChunks(tx, sessionId);
    const missing = missingChunks(
      plan,
      parts.map((p) => p.index),
    );

    if (missing.length > 0) {
      return {
        problem: uploadRefusal(
          409,
          `${missing.length} of ${plan.chunkCount} chunks have not arrived: ${missing
            .slice(0, 20)
            .join(", ")}${missing.length > 20 ? ", …" : ""}. Send those and complete again.`,
        ),
      } as const;
    }

    return { problem: null, session, bytes: assembleUpload(plan, parts) } as const;
  });

  if (staged.problem) return { ok: false, response: staged.problem };
  if ("alreadyDone" in staged && staged.alreadyDone) {
    const object = staged.alreadyDone.storageKey
      ? await objectStore().head(staged.alreadyDone.storageKey)
      : null;
    if (!object) {
      return { ok: false, response: uploadRefusal(502, "This upload is recorded as complete but its file is missing.") };
    }
    return { ok: true, result: { session: staged.alreadyDone, object } };
  }

  const session = staged.session!;
  const assembled = staged.bytes!;

  // ── The hash the client promised ──────────────────────────────────────────
  const sha256 = sha256Hex(assembled);
  if (session.declaredSha256 && session.declaredSha256 !== sha256) {
    await withTenant(ctx, (tx) =>
      abortUpload(tx, sessionId, `Assembled bytes hash to ${sha256}, not the declared ${session.declaredSha256}.`, "failed"),
    );
    return {
      ok: false,
      response: uploadRefusal(
        409,
        "The assembled file does not match the hash the client declared. The upload was discarded " +
          "rather than stored: a photograph that is silently corrupt is worse than one that " +
          "visibly failed, because a signed job sheet is immutable once written (FLD-14).",
      ),
    };
  }

  // ── What it actually is ───────────────────────────────────────────────────
  const contentType = sniffContentType(assembled);
  if (!contentType) {
    await withTenant(ctx, (tx) =>
      abortUpload(tx, sessionId, "The assembled bytes are not a format this system stores.", "failed"),
    );
    return {
      ok: false,
      response: uploadRefusal(
        415,
        "These bytes are not one of the formats this system stores. The type is read from the " +
          "file itself, so the type the client declared cannot override it.",
      ),
    };
  }

  // ── §8.6: extract, then process, then strip ──────────────────────────────
  const facts = contentType === "image/jpeg" ? readJpegExif(assembled) : NO_EXIF;

  const pipeline = await imagePipeline();
  let bytes = assembled;
  let storedType: AllowedContentType = contentType;
  let compression = "unchanged";
  let note: string;

  if (pipeline.available) {
    const outcome = await pipeline.processor.compress(bytes, storedType);
    bytes = outcome.bytes;
    storedType = outcome.contentType;
    compression = outcome.action;
    note = outcome.note;
  } else {
    compression = "unavailable";
    note = pipeline.reason;
  }

  const strip = stripMetadata(bytes, storedType);
  let metadataStripped = false;
  if (strip.supported) {
    bytes = strip.bytes;
    // Verified, not assumed — §8.6's word. The check runs against the bytes
    // about to be written, so "stripped" in the column means this file, now.
    metadataStripped = !hasJpegMetadata(bytes);
  } else {
    note = `${note} ${strip.reason}`;
  }

  // ── Store it ──────────────────────────────────────────────────────────────
  const key = `uploads/${ctx.tenantId}/${session.purpose}/${sessionId}.${EXTENSION_FOR[storedType]}`;
  let object: StoredObject;

  try {
    object = await putOnce(key, bytes, storedType);
  } catch (error) {
    console.error(`[uploads] could not store ${key}`, error);
    await withTenant(ctx, (tx) =>
      abortUpload(tx, sessionId, error instanceof Error ? error.message : "Storage failed", "failed"),
    );
    return { ok: false, response: uploadRefusal(502, "The file could not be stored. This has been logged.") };
  }

  const finished = await withTenant(ctx, (tx) =>
    completeUpload(tx, {
      sessionId,
      storageKey: object.key,
      contentType: object.contentType,
      sizeBytes: object.sizeBytes,
      sha256: object.sha256,
      // The same fork as the CV path, for the same reason: `pending` when
      // something will look at this within ten minutes, `skipped` when nothing
      // ever will, and never a claim that a scan happened.
      scanStatus: virusScanner().configured ? "pending" : "skipped",
      capturedAt: facts.takenAt ? new Date(facts.takenAt) : null,
      capturedLat: facts.latitude,
      capturedLon: facts.longitude,
      orientation: facts.orientation,
      metadataStripped,
      compression,
      processingNote: note,
    }),
  );

  if (!finished) {
    return { ok: false, response: uploadRefusal(409, "This upload was completed by another request.") };
  }

  return { ok: true, result: { session: finished, object } };
}

/**
 * Write once, and treat our own previous write as success.
 *
 * `put()` refuses an existing key (`OPS-6`), which is right and which would
 * otherwise make a retried completion fail permanently. The hash comparison is
 * what keeps that safe: an object already at this key whose bytes hash to the
 * same value *is* this upload, and one that does not is a genuine collision
 * worth failing on.
 */
async function putOnce(
  key: string,
  bytes: Uint8Array,
  declaredContentType: AllowedContentType,
): Promise<StoredObject> {
  try {
    return await objectStore().put({ key, body: bytes, declaredContentType });
  } catch (error) {
    if (!(error instanceof ObjectStoreError)) throw error;

    const existing = await objectStore().head(key);
    if (existing && existing.sha256 === sha256Hex(bytes)) return existing;
    throw error;
  }
}

/** The shape every upload route answers with. Deliberately free of the storage key. */
export function sessionResponse(session: UploadSessionView, status = 200): Response {
  const plan = planUpload(session.totalBytes, session.chunkSize);

  return Response.json(
    {
      uploadId: session.sessionId,
      clientUploadId: session.clientUploadId,
      purpose: session.purpose,
      reference: session.reference,
      status: session.status,
      totalBytes: session.totalBytes,
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      receivedChunks: session.receivedChunks,
      // The whole resumption protocol: the client sends these and nothing else.
      missingChunks: missingChunks(plan, session.receivedIndexes),
      // `storage_key` is deliberately absent. `SEC-8` has no public URLs and no
      // route hands out a location; the finished object is read back through a
      // permission-checked download route, never by key.
      contentType: session.contentType,
      sizeBytes: session.sizeBytes,
      sha256: session.sha256,
      scanStatus: session.scanStatus,
      capturedAt: session.capturedAt,
      capturedLat: session.capturedLat,
      capturedLon: session.capturedLon,
      orientation: session.orientation,
      metadataStripped: session.metadataStripped,
      compression: session.compression,
      note: session.processingNote,
      expiresAt: session.expiresAt,
    },
    { status },
  );
}

/** Shared by the routes that need a tenant transaction and nothing else. */
export function inTenant<T>(ctx: TenantContext, fn: (tx: TenantScopedTx) => Promise<T>): Promise<T> {
  return withTenant(ctx, fn);
}
