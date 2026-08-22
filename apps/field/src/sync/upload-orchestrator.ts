/**
 * Driving one upload to completion, and what it produces once it has.
 *
 * ── WHY UPLOADS AND MUTATIONS ARE TWO LANES, NOT ONE ────────────────────────
 *
 * `job_attachment/append` and `job_signature/record` cite an `uploadId`
 * (`payloads.ts`), and an upload id does not exist until `POST
 * /uploads/complete` has returned one - which needs a network round trip for
 * every chunk. That is true of nothing else in this app: every other capture
 * (a material line, a "no parts" declaration, an outcome) is queued in the
 * outbox the instant it is entered and never waits on the network to do it.
 *
 * A photograph or a signature therefore has to be honest about a real
 * asymmetry rather than paper over it: the *capture* (the frame, the strokes)
 * is written to the local database immediately and is never blocked on
 * connectivity - see `createJobPhotoRecord` / `createJobSignoffRecord` in
 * `db/watermelon.ts`, called straight from the camera and the signature pad.
 * What this module does is the second half, which genuinely cannot happen
 * offline: turn a captured-but-unsent photo or signature into bytes on the
 * server, and only then mint the `job_attachment/append` /
 * `job_signature/record` mutation - which goes into the **outbox**, exactly
 * like every other mutation, and is drained by `SyncRunner` on its own
 * schedule. This module never calls the mutations endpoint itself.
 *
 * `media/queue.ts`'s own header makes the same point about photos specifically
 * - "Photos upload on a separate queue from record sync... a photo must never
 * *precede* the event it evidences" - and this is that second queue's engine.
 *
 * ── WHAT IS PURE HERE, AND WHAT IS NOT ──────────────────────────────────────
 *
 * `runUpload` takes its network calls (`UploadTransport`) and its byte source
 * (`ChunkSource`) as arguments, so the sequencing - init, send only the chunks
 * the server does not already hold, complete - is testable with a fake
 * transport and no device, no file system and no real network. That is
 * `test/upload-orchestrator.test.ts`. The real transport is
 * `FieldApiClient` from `client.ts` (already exercised over HTTP by
 * `test/wire-contract.ts`), and the real byte source is
 * `app/upload-runner.ts`, which reads chunks with `expo-file-system` and has
 * not been run in this session - see the note at the top of that file.
 */

import type { FieldApiClient } from "./client";
import type { UploadInitRequest, UploadCompleteResponse } from "./protocol";
import { chunkPlan, chunkRange } from "../media/queue";
import { appendAttachment, recordSignature, type MutationSpec } from "./payloads";
import { attachmentKindForPhotoRole } from "../domain/job-card";
import type { PhotoRole } from "../domain/job-card";

/** The three calls an upload needs. `FieldApiClient` satisfies this structurally. */
export type UploadTransport = Pick<FieldApiClient, "initUpload" | "putChunk" | "completeUpload">;

export interface ChunkSource {
  /** Read the half-open byte range `[start, end)` of the thing being uploaded. */
  readonly read: (start: number, end: number) => Promise<Uint8Array>;
  readonly totalBytes: number;
}

export interface RunUploadInput {
  readonly transport: UploadTransport;
  readonly clientUploadId: string;
  readonly purpose: UploadInitRequest["purpose"];
  readonly jobId: string;
  readonly source: ChunkSource;
  readonly filename?: string;
  readonly sha256?: string;
}

export interface CompletedUpload {
  readonly uploadId: string;
  readonly response: UploadCompleteResponse;
}

/**
 * Init, send whatever chunks the server does not already have, complete.
 *
 * Resumable by construction rather than by remembering: `chunkPlan` (`media/
 * queue.ts`) is handed `receivedChunks` straight from the `initUpload`
 * response, which is **recounted by the server, not incremented** - so an
 * upload resumed after a dropped link or a killed app costs the chunks
 * actually lost, never the whole file, and never trusts this process's own
 * memory of what it had already sent.
 */
export async function runUpload(input: RunUploadInput): Promise<CompletedUpload> {
  if (input.source.totalBytes <= 0) {
    throw new Error("Nothing to upload: the capture has no bytes.");
  }

  const init = await input.transport.initUpload({
    clientUploadId: input.clientUploadId,
    purpose: input.purpose,
    jobId: input.jobId,
    totalBytes: input.source.totalBytes,
    ...(input.filename ? { filename: input.filename } : {}),
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
  });

  const plan = chunkPlan(input.source.totalBytes, init.receivedChunks, init.chunkSize);

  // Sequential rather than parallel. A parallel fan-out would need its own
  // retry and ordering story on top of `chunkPlan`'s, for a saving that does
  // not matter on the link this app is built for - a technician's phone, not
  // a datacentre upload.
  for (const index of plan.toSend) {
    const { start, end } = chunkRange(index, input.source.totalBytes, init.chunkSize);
    const bytes = await input.source.read(start, end);
    const url = init.chunkUrls[index];
    await input.transport.putChunk({
      uploadId: init.uploadId,
      index,
      bytes,
      sameOrigin: init.sameOrigin,
      ...(url ? { url } : {}),
    });
  }

  const response = await input.transport.completeUpload(init.uploadId);
  return { uploadId: init.uploadId, response };
}

// ── Turning a completed upload into the mutation it unlocks ────────────────

/**
 * `job_attachment/append`, once the photograph's upload has completed.
 *
 * The role determines the kind through `attachmentKindForPhotoRole` - never
 * re-derived here, per the note at the top of `domain/job-card.ts`.
 */
export function attachmentMutationForUpload(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly role: PhotoRole;
  readonly uploadId: string;
  readonly caption?: string | null;
  readonly dependsOnClientId?: string | null;
}): MutationSpec {
  return appendAttachment({
    jobId: input.jobId,
    visitId: input.visitId ?? null,
    kind: attachmentKindForPhotoRole(input.role),
    uploadId: input.uploadId,
    caption: input.caption ?? null,
    dependsOnClientId: input.dependsOnClientId ?? null,
  });
}

/** `job_signature/record`, once the signature image's upload has completed. */
export function signatureMutationForUpload(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly uploadId: string;
  readonly signedByName: string;
  readonly signedByRole?: string | null;
  readonly satisfactionRating?: number | null;
  readonly comments?: string | null;
}): MutationSpec {
  return recordSignature({
    jobId: input.jobId,
    visitId: input.visitId ?? null,
    uploadId: input.uploadId,
    signedByName: input.signedByName,
    signedByRole: input.signedByRole ?? null,
    satisfactionRating: input.satisfactionRating ?? null,
    comments: input.comments ?? null,
  });
}
