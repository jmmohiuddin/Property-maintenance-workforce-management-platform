import { chunkExtent, planUpload, sha256Hex } from "@meridian/files";
import { receiveChunk } from "@meridian/db/domain";
import { UserFacingError } from "@meridian/core";
import { withDevice } from "../../../../_device";
import { requireOwnUpload } from "../../../_upload";

/**
 * `PUT /api/field/v1/uploads/{uploadId}/chunks/{index}` — one part of a file.
 *
 * The device-authenticated twin of the staff chunk route, calling the same
 * `receiveChunk`. Everything that makes that function safe is already true here
 * and is not re-solved: receipt is idempotent through a unique index on
 * `(session_id, chunk_index)`, and `received_chunks` is **recounted** rather
 * than incremented, because an increment drifts on the first resend and a
 * drifted counter reports a session complete with a chunk missing.
 *
 * ── WHY `PUT` ───────────────────────────────────────────────────────────────
 *
 * A chunk is a named thing at a fixed address and sending it twice must be the
 * same as sending it once. On the link this app is designed for — a basement,
 * a car park, a hotel's guest wifi — a client retrying after a timeout it never
 * saw the response to is the normal case, not an error.
 *
 * ── WHY THE LENGTH IS CHECKED AGAINST THE PLAN ──────────────────────────────
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
) {
  const { uploadId, index } = await params;

  return withDevice(request, async ({ tx, ctx, device }) => {
    // Ownership is re-derived from the session row's own job on every chunk,
    // not carried from init. A device that guessed an upload id would otherwise
    // be able to overwrite parts of somebody else's photograph.
    const session = await requireOwnUpload(tx, uploadId, device.technicianId);

    if (session.status !== "open") {
      throw new UserFacingError(`This upload is ${session.status} and cannot take any more parts.`);
    }

    const chunkIndex = Number(index);
    const plan = planUpload(session.totalBytes, session.chunkSize);

    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= plan.chunkCount) {
      throw new UserFacingError(
        `Part ${index} is outside this upload, which has ${plan.chunkCount} parts.`,
      );
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    const expected = chunkExtent(plan, chunkIndex);

    if (bytes.length !== expected.length) {
      throw new UserFacingError(
        `Part ${chunkIndex} of this upload is ${expected.length} bytes; ${bytes.length} arrived. ` +
          "The connection dropped mid-send; the phone will try this part again.",
      );
    }

    const receipt = await receiveChunk(tx, ctx, {
      sessionId: uploadId,
      chunkIndex,
      bytes,
      sha256: sha256Hex(bytes),
    });

    return {
      uploadId,
      chunkIndex,
      duplicate: receipt.duplicate,
      receivedChunks: receipt.received,
      chunkCount: receipt.expected,
      complete: receipt.complete,
    };
  });
}
