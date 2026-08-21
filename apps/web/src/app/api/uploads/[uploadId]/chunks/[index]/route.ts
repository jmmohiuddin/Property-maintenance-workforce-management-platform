import { chunkExtent, planUpload, sha256Hex } from "@meridian/files";
import { receiveChunk } from "@meridian/db/domain";
import { authoriseExistingUpload, inTenant, uploadRefusal } from "@/lib/uploads";

/**
 * One part of a file.
 *
 * ── WHY `PUT` AND NOT `POST` ────────────────────────────────────────────────
 *
 * A chunk is a named thing at a fixed address, and sending it twice must be the
 * same as sending it once. That is the definition of idempotent, `PUT` is the
 * method that promises it, and the database holds the promise with a unique
 * index on `(session_id, chunk_index)`. A client that retries after a timeout
 * it never saw the response to is the normal case on a bad link, not an error.
 *
 * ── WHY THE LENGTH IS CHECKED AGAINST THE PLAN ─────────────────────────────
 *
 * The plan says how long chunk N is, including the short last one. A chunk that
 * disagrees is either a client bug or a truncated request body, and both
 * assemble into a file that is valid, wrong, and silent about it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ uploadId: string; index: string }> },
): Promise<Response> {
  const { uploadId, index } = await params;
  const auth = await authoriseExistingUpload(uploadId);
  if (!auth.ok) return auth.response;

  const session = auth.session!;
  if (session.status !== "open") {
    return uploadRefusal(409, `This upload is ${session.status} and cannot take any more chunks.`);
  }

  const chunkIndex = Number(index);
  const plan = planUpload(session.totalBytes, session.chunkSize);

  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= plan.chunkCount) {
    return uploadRefusal(400, `Chunk ${index} is outside this upload, which has ${plan.chunkCount} parts.`);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  const expected = chunkExtent(plan, chunkIndex);

  if (bytes.length !== expected.length) {
    return uploadRefusal(
      400,
      `Chunk ${chunkIndex} of this upload is ${expected.length} bytes; ${bytes.length} arrived.`,
    );
  }

  const receipt = await inTenant(auth.ctx, (tx) =>
    receiveChunk(tx, auth.ctx, { sessionId: uploadId, chunkIndex, bytes, sha256: sha256Hex(bytes) }),
  );

  return Response.json({
    uploadId,
    chunkIndex,
    duplicate: receipt.duplicate,
    receivedChunks: receipt.received,
    chunkCount: receipt.expected,
    complete: receipt.complete,
  });
}
