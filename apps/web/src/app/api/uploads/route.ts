import { MAX_OBJECT_BYTES, UPLOAD_CHUNK_BYTES, UploadError, planUpload } from "@meridian/files";
import { openUpload } from "@meridian/db/domain";
import {
  UPLOAD_PURPOSES,
  authoriseUpload,
  inTenant,
  isUploadPurpose,
  sessionResponse,
  uploadRefusal,
} from "@/lib/uploads";

/**
 * Open a resumable upload (TRD §8.5 `uploads/init`).
 *
 * ── WHY THE CLIENT BRINGS ITS OWN ID ────────────────────────────────────────
 *
 * §8.3, verbatim: "the dominant real-world failure is request succeeded,
 * response lost, client retries." A technician on a hotel's guest wifi will hit
 * that on the first call as often as on any other, and without an idempotency
 * key a day of retries leaves forty abandoned half-sessions and one photograph.
 * `clientUploadId` is the ULID the device generated before it had a server at
 * all; opening twice with it returns the same session and the same progress.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return uploadRefusal(400, "Send a JSON body.");
  }

  // The header is the conventional place for it and the body is where a
  // hand-written client will put it. Both are accepted; neither is invented.
  const clientUploadId =
    request.headers.get("idempotency-key")?.trim() || String(body["clientUploadId"] ?? "").trim();

  if (!clientUploadId || clientUploadId.length > 64) {
    return uploadRefusal(
      400,
      "An upload needs a client-generated id, as an Idempotency-Key header or clientUploadId, of " +
        "at most 64 characters. Without one a lost response cannot be retried safely.",
    );
  }

  const purpose = String(body["purpose"] ?? "");
  if (!isUploadPurpose(purpose)) {
    // Listed from the constant rather than typed out. The hand-written list
    // this replaced was already two purposes out of date the day a third was
    // added, and a refusal that names the wrong set sends the caller looking
    // for a bug in their own code.
    return uploadRefusal(400, `purpose must be one of: ${UPLOAD_PURPOSES.join(", ")}.`);
  }

  const auth = await authoriseUpload(purpose);
  if (!auth.ok) return auth.response;

  const totalBytes = Number(body["totalBytes"]);
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    return uploadRefusal(400, "totalBytes must be a positive integer.");
  }
  // Checked here as well as in the store, because a client that declares 400 MB
  // should be told now rather than after sending 800 chunks.
  if (totalBytes > MAX_OBJECT_BYTES) {
    return uploadRefusal(413, `This system stores objects up to ${MAX_OBJECT_BYTES} bytes.`);
  }

  const requested = body["chunkSize"] === undefined ? UPLOAD_CHUNK_BYTES : Number(body["chunkSize"]);

  let plan;
  try {
    plan = planUpload(totalBytes, requested);
  } catch (error) {
    if (error instanceof UploadError) return uploadRefusal(400, error.message);
    throw error;
  }

  const declared = body["sha256"] === undefined ? null : String(body["sha256"]).toLowerCase();
  if (declared !== null && !/^[0-9a-f]{64}$/.test(declared)) {
    return uploadRefusal(400, "sha256, when given, must be 64 hex characters.");
  }

  const { session, reused } = await inTenant(auth.ctx, (tx) =>
    openUpload(tx, auth.ctx, {
      clientUploadId,
      purpose,
      reference: body["reference"] === undefined ? null : String(body["reference"]).slice(0, 120),
      filename: body["filename"] === undefined ? null : String(body["filename"]).slice(0, 200),
      totalBytes,
      chunkSize: plan.chunkSize,
      chunkCount: plan.chunkCount,
      declaredSha256: declared,
      createdById: auth.userId,
    }),
  );

  // 200 on a retry, 201 on a new session. The client does not need to care —
  // the body tells it what is still missing either way — but an operator
  // reading a log does.
  return sessionResponse(session, reused ? 200 : 201);
}
