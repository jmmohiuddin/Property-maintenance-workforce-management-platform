import { MAX_OBJECT_BYTES, UPLOAD_CHUNK_BYTES, UploadError, planUpload } from "@meridian/files";
import { openUpload } from "@meridian/db/domain";
import { UserFacingError } from "@meridian/core";
import { withDevice, readJson } from "../../_device";
import { isFieldUploadPurpose, requireJobForDevice } from "../_upload";

/**
 * `POST /api/field/v1/uploads/init` (TRD §8.5, §8.6).
 *
 * Opens a resumable upload for a photograph or a signature, device-
 * authenticated. The transport underneath is the media agent's `openUpload` —
 * see `../_upload.ts` for why this is a door and not a second implementation.
 *
 * ── WHY THE CHUNK URLS ARE OURS AND NOT PRESIGNED ───────────────────────────
 *
 * §8.5 says "presigned, chunked, resumable", and two of those three are exactly
 * what happens. Presigning is the one that does not, because chunks are stored
 * as `bytea` rows rather than as staged objects — `ObjectStore.put()` sniffs
 * content and would refuse the middle 512 KB of a JPEG, and staging in the
 * store would need a second write path that skips the sniffer, which is the
 * hole `SEC-8` exists to prevent. There is nothing to presign a URL *to*.
 *
 * So the returned URLs are same-origin paths on this API, and `sameOrigin` says
 * so in the response. That distinction matters to the client: its `putChunk`
 * deliberately withholds the device token from presigned URLs, because sending
 * a credential to a third-party storage host is a leak. These are not a third
 * party — they are this server, they require the device token like every other
 * field route, and the flag is how the client knows which rule applies.
 *
 * ── IDEMPOTENT, BECAUSE THAT IS THE NORMAL WEATHER ──────────────────────────
 *
 * `clientUploadId` is the ULID the device generated before it had a server at
 * all. Opening twice with it returns the same session and the same progress —
 * §8.3's "request succeeded, response lost, client retries", which on a hotel
 * guest network happens on the first call as often as on any other. Without it
 * a day of retries leaves forty abandoned half-sessions and one photograph.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withDevice(request, async ({ tx, ctx, device }) => {
    const body = await readJson(request);

    // Header first, body second. Both are accepted; neither is invented. The
    // staff route does the same, and a client that has to guess which one this
    // server reads is a client that will guess wrong.
    const clientUploadId =
      request.headers.get("idempotency-key")?.trim() ||
      String(body["clientUploadId"] ?? body["client_id"] ?? "").trim();

    if (!clientUploadId || clientUploadId.length > 64) {
      throw new UserFacingError(
        "This upload has no client-generated id. Without one a lost response cannot be retried " +
          "safely, and the photograph would be sent twice or not at all.",
      );
    }

    const purpose = String(body["purpose"] ?? "");
    if (!isFieldUploadPurpose(purpose)) {
      throw new UserFacingError("A phone uploads a job photo or a job signature, and nothing else.");
    }

    // The job is named here and checked here, and the check is the reason this
    // route exists separately from the staff one: every technician holds
    // `jobs:update`, so permission alone would let any handset attach a
    // photograph to any job in the tenant.
    const jobId = String(body["jobId"] ?? body["job_id"] ?? "").trim();
    if (!jobId) throw new UserFacingError("An upload from a phone has to say which job it is for.");
    await requireJobForDevice(tx, jobId, device.technicianId);

    const totalBytes = Number(body["totalBytes"] ?? body["byte_size"]);
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new UserFacingError("This upload did not say how large the file is.");
    }
    // Refused now rather than after eight hundred chunks have crossed a
    // cellular link the technician is paying for.
    if (totalBytes > MAX_OBJECT_BYTES) {
      throw new UserFacingError(
        `This file is larger than the ${Math.floor(MAX_OBJECT_BYTES / (1024 * 1024))} MB limit. ` +
          "Photographs are compressed on the phone before they are sent; this one was not.",
      );
    }

    const requested =
      body["chunkSize"] === undefined ? UPLOAD_CHUNK_BYTES : Number(body["chunkSize"]);

    let plan;
    try {
      plan = planUpload(totalBytes, requested);
    } catch (error) {
      if (error instanceof UploadError) throw new UserFacingError(error.message);
      throw error;
    }

    const declared =
      body["sha256"] === undefined ? null : String(body["sha256"]).toLowerCase();
    if (declared !== null && !/^[0-9a-f]{64}$/.test(declared)) {
      throw new UserFacingError("The checksum on this upload is not a SHA-256.");
    }

    const { session, reused } = await openUpload(tx, ctx, {
      clientUploadId,
      purpose,
      // The job, so `requireOwnUpload` can re-derive ownership on every later
      // call from the row rather than from the request.
      reference: jobId,
      filename:
        body["filename"] === undefined ? null : String(body["filename"]).slice(0, 200),
      totalBytes,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      declaredSha256: declared,
      createdById: device.user.id,
    });

    const base = `/api/field/v1/uploads/${session.sessionId}/chunks`;

    return {
      uploadId: session.sessionId,
      clientUploadId: session.clientUploadId,
      purpose: session.purpose,
      jobId,
      status: session.status,
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
      receivedChunks: session.receivedChunks,
      // The whole resumption protocol: on a retry the device sends these and
      // nothing else. A session reopened after a dead battery costs the chunks
      // that were actually lost, not the file.
      chunkUrls: Array.from({ length: session.chunkCount }, (_, i) => `${base}/${i}`),
      // Attach the device token to these. See the note above.
      sameOrigin: true,
      // True when this id had already been seen. The device does not need to
      // care — `receivedChunks` tells it what to send either way — but an
      // operator reading a log does.
      reused,
      expiresAt: session.expiresAt,
    };
  });
}
