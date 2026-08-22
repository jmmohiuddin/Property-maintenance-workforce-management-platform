/**
 * The media upload loop: turns a captured-but-unsent photo or signature into
 * bytes on the server, then queues the mutation that upload unlocked.
 *
 * **NOT TYPECHECKED BY THE ROOT GATE, AND NOT EXECUTED IN THIS SESSION** - same
 * status as `sync-runner.ts`, for the same reason: this file imports
 * `expo-file-system` and WatermelonDB models, neither of which exists on a
 * machine with no Expo install. Everything it decides that *could* be tested
 * without a device was moved into `sync/upload-orchestrator.ts`, which is.
 * What is left here - reading a file's bytes, walking the queue, folding the
 * result back into SQLite - is untested and unrun, exactly as `sync-runner.ts`
 * says of itself.
 *
 * ── WHY THIS IS A SEPARATE RUNNER AND NOT PART OF `SyncRunner` ─────────────
 *
 * `media/queue.ts`'s header: *"Photos upload on a separate queue from record
 * sync... a 200 MB upload sharing a queue with a 2 KB job completion means the
 * completion waits behind the photos."* `SyncRunner.drain()` sends the outbox;
 * this sends the media the outbox is waiting on. They are deliberately not
 * coupled - a slow photo upload must never stall a job-status mutation - and
 * the only thing that ties them together is that filing a capture's mutation
 * (`fileUploadedCapture`) writes into the same outbox table `SyncRunner`
 * drains next.
 */

import type { Database } from "@nozbe/watermelondb";
import { File } from "expo-file-system";

import { loadQueuedPhotos, loadQueuedSignoffs, fileUploadedCapture } from "../db/watermelon";
import type { JobPhoto, JobSignoff } from "../db/models";
import {
  runUpload,
  attachmentMutationForUpload,
  signatureMutationForUpload,
  type ChunkSource,
  type UploadTransport,
} from "../sync/upload-orchestrator";
import { isPhotoRole } from "../domain/job-card";
import type { ClockSources } from "../domain/clock";
import { newClientId } from "../domain/ids";
import { renderSignatureImage } from "../media/raster";
import type { Stroke } from "../domain/signature";

/** Read a whole local file once, then slice it in memory for each chunk. */
function fileChunkSource(uri: string): ChunkSource {
  const file = new File(uri);
  let cached: Promise<Uint8Array> | null = null;
  const bytes = (): Promise<Uint8Array> => {
    if (!cached) cached = file.bytes();
    return cached;
  };
  return {
    totalBytes: file.size,
    read: async (start, end) => (await bytes()).subarray(start, end),
  };
}

/**
 * Bytes already sitting in memory - the signature image, which
 * `media/raster.ts` renders straight into a `Uint8Array` and which never
 * touches the file system at all.
 */
function bytesChunkSource(bytes: Uint8Array): ChunkSource {
  return { totalBytes: bytes.length, read: async (start, end) => bytes.subarray(start, end) };
}

export class MediaUploadRunner {
  private isRunning = false;

  constructor(
    private readonly database: Database,
    private readonly transport: UploadTransport,
    private readonly clock: ClockSources,
  ) {}

  /**
   * One pass over both queues. Failures on one item are logged and do not
   * stop the rest - a photo whose bytes the phone cannot currently read (a
   * file deleted by the OS under storage pressure, say) must not block every
   * other photo behind it in the queue.
   */
  async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      for (const photo of await loadQueuedPhotos(this.database)) {
        await this.uploadPhoto(photo).catch((error) =>
          console.warn(`[field] photo ${photo.id} did not upload`, error),
        );
      }
      for (const signoff of await loadQueuedSignoffs(this.database)) {
        await this.uploadSignature(signoff).catch((error) =>
          console.warn(`[field] signature ${signoff.id} did not upload`, error),
        );
      }
    } finally {
      this.isRunning = false;
    }
  }

  private async uploadPhoto(photo: JobPhoto): Promise<void> {
    if (!isPhotoRole(photo.role)) {
      // Mirrors `JobCardScreen`'s own reading of `photo.role`: an unrecognised
      // role has no destination `job_attachments.kind`, so this build cannot
      // file it. Left `queued` rather than `failed` - a build that *does*
      // recognise the role (an update rolled back, or an older capture from a
      // build with a wider `PhotoRole` union) should still be able to send it.
      console.warn(`[field] photo ${photo.id} has an unreadable role ("${photo.role}"); not uploading yet`);
      return;
    }

    const completed = await runUpload({
      transport: this.transport,
      // The photo's own client id is the upload's idempotency key, so a
      // second pass over the same still-queued row (the app was killed mid
      // upload, say) resumes rather than starting a second upload session.
      clientUploadId: photo.id,
      purpose: "job_photo",
      jobId: photo.jobId,
      source: fileChunkSource(photo.localUri),
      filename: photo.localUri.split("/").pop(),
    });

    const mutation = attachmentMutationForUpload({
      jobId: photo.jobId,
      role: photo.role,
      uploadId: completed.uploadId,
      caption: photo.caption ?? null,
      dependsOnClientId: photo.dependsOnClientId ?? null,
    });

    await fileUploadedCapture<JobPhoto>(this.database, "job_photos", photo.id, {
      clientId: newClientId(),
      entity: mutation.entity,
      op: mutation.op,
      jobId: mutation.jobId,
      payload: mutation.payload,
      baseVersion: mutation.baseVersion,
      dependsOnClientId: mutation.dependsOnClientId,
      createdAt: new Date(this.clock.now()).toISOString(),
      createdMonotonic: this.clock.monotonic(),
    }, (draft) => {
      draft.uploadState = "filed";
      draft.uploadId = completed.uploadId;
      draft.scanStatus = completed.response.scanStatus;
    });
  }

  private async uploadSignature(signoff: JobSignoff): Promise<void> {
    // Rendered here, from the stored vector, rather than once at capture
    // time: `job_signoffs` has no column to hold raster bytes (adding one
    // would be a schema migration - see `db/schema.ts`'s own warning that an
    // unmigrated version bump wipes every device's unsynced day), and
    // `renderSignatureImage` is a pure function of `strokes_json` and
    // `aspect_ratio`, both already stored, so re-deriving it on every upload
    // attempt costs nothing and cannot drift from what was actually drawn.
    const strokes = JSON.parse(signoff.strokesJson) as readonly Stroke[];
    const rendered = renderSignatureImage(strokes, signoff.aspectRatio);
    const source = bytesChunkSource(rendered.png);

    const completed = await runUpload({
      transport: this.transport,
      clientUploadId: signoff.id,
      purpose: "job_signature",
      jobId: signoff.jobId,
      source,
      filename: `${signoff.id}.png`,
    });

    const mutation = signatureMutationForUpload({
      jobId: signoff.jobId,
      visitId: signoff.visitId ?? null,
      uploadId: completed.uploadId,
      signedByName: signoff.signedByName,
      signedByRole: signoff.signedByRole ?? null,
      satisfactionRating: signoff.satisfactionRating ?? null,
      comments: signoff.comments ?? null,
    });

    await fileUploadedCapture<JobSignoff>(this.database, "job_signoffs", signoff.id, {
      clientId: newClientId(),
      entity: mutation.entity,
      op: mutation.op,
      jobId: mutation.jobId,
      payload: mutation.payload,
      baseVersion: mutation.baseVersion,
      dependsOnClientId: mutation.dependsOnClientId,
      createdAt: new Date(this.clock.now()).toISOString(),
      createdMonotonic: this.clock.monotonic(),
    }, (draft) => {
      draft.uploadId = completed.uploadId;
    });
  }
}
