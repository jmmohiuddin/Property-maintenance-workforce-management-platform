/**
 * The photo queue (`FLD-7`, TRD §8.6).
 *
 * *"A typical phone photo is 4-12 MB; a technician shoots 20-40 per job.
 * Uncompressed that is roughly 300 MB per technician per day on cellular,
 * which is the single most common cause of 'the app doesn't work' complaints
 * in this category."*
 *
 * Photos upload on a separate queue from record sync, and the separation is
 * not an optimisation. A day of job photos over a hotel's guest wifi is the
 * stated worst case, and a 200 MB upload sharing a queue with a 2 KB job
 * completion means the completion waits behind the photos - so the office
 * cannot see that the job is done until every image has landed. Records first,
 * evidence behind them, with one ordering constraint in the other direction:
 * a photo must never *precede* the event it evidences (TRD §8.3).
 *
 * This module is the policy, in pure functions. The native work - actually
 * resizing a JPEG, actually reading the network type - is `expo-image-manipulator`
 * and `expo-network`, called from `src/app/`. **None of that was executed in
 * this session.** The arithmetic below was tested; the pixels were not.
 */

// ── Compression (FLD-7, TRD §8.6) ───────────────────────────────────────────

/**
 * *"longest edge 1920-2048px, JPEG quality ~0.75, target <= 1 MB"*.
 *
 * 2048 rather than 1920: the difference in bytes is small and the difference
 * on a serial plate photographed at arm's length in a dark plant room is the
 * difference between a legible model number and a callback. Serial plates and
 * meter readings are the images this app exists to make readable.
 */
export const MAX_LONGEST_EDGE = 2048;
export const JPEG_QUALITY = 0.75;
export const TARGET_BYTES = 1_000_000;

export interface CompressionPlan {
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly quality: number;
  /** False when the source is already smaller than the target - do not re-encode. */
  readonly resize: boolean;
}

/**
 * Never upscales. Re-encoding a 900px photo to 2048px makes the file larger,
 * adds compression artefacts to evidence, and buys nothing.
 */
export function compressionPlan(width: number, height: number): CompressionPlan {
  const longest = Math.max(width, height);
  if (longest <= MAX_LONGEST_EDGE) {
    return { targetWidth: width, targetHeight: height, quality: JPEG_QUALITY, resize: false };
  }
  const scale = MAX_LONGEST_EDGE / longest;
  return {
    targetWidth: Math.round(width * scale),
    targetHeight: Math.round(height * scale),
    quality: JPEG_QUALITY,
    resize: true,
  };
}

// ── Chunking and resumability ───────────────────────────────────────────────

/**
 * 512 KB - **the server's default, and the server's number is the one that
 * counts.**
 *
 * `POST /uploads/init` returns the `chunkSize` it will actually use, and every
 * plan must be built from that rather than from this constant: chunk indices
 * are how a resumed upload identifies what it already holds, so a client
 * chunking at 256 KB against a server chunking at 512 KB would re-send bytes
 * it had already delivered and index them wrongly. This value exists for the
 * arithmetic before init has answered, and for tests.
 *
 * The size is a trade against the failure it exists for - a cell link that
 * drops mid-upload. A drop costs at most half a megabyte of retransmission.
 * Larger means fewer round trips and more to lose; smaller means per-request
 * overhead starts to dominate on a high-latency link, which describes every
 * basement.
 */
export const CHUNK_SIZE_BYTES = 512 * 1024;

export interface ChunkPlan {
  readonly totalChunks: number;
  /** Indices still to send, ascending. Excludes anything the server already holds. */
  readonly toSend: readonly number[];
  readonly bytesRemaining: number;
}

/**
 * `receivedChunks` comes from the upload-init response, where the server
 * **recounts** rather than increments. Resumability is server-declared rather
 * than client-remembered on purpose: the client's idea of what it sent is
 * exactly the thing a crash destroys, and "the server told me it holds chunks
 * 0-3" survives a reinstall and a dead battery.
 *
 * `chunkSize` must be the value init returned, not the constant above.
 */
export function chunkPlan(
  byteSize: number,
  receivedChunks: readonly number[] = [],
  chunkSize: number = CHUNK_SIZE_BYTES,
): ChunkPlan {
  const totalChunks = Math.max(1, Math.ceil(byteSize / chunkSize));
  const have = new Set(receivedChunks);
  const toSend: number[] = [];
  for (let i = 0; i < totalChunks; i++) if (!have.has(i)) toSend.push(i);

  const bytesRemaining = toSend.reduce((sum, index) => {
    const start = index * chunkSize;
    return sum + Math.min(chunkSize, byteSize - start);
  }, 0);

  return { totalChunks, toSend, bytesRemaining };
}

export function chunkRange(
  index: number,
  byteSize: number,
  chunkSize: number = CHUNK_SIZE_BYTES,
): { readonly start: number; readonly end: number } {
  const start = index * chunkSize;
  return { start, end: Math.min(start + chunkSize, byteSize) };
}

// ── When to upload (FLD-7) ──────────────────────────────────────────────────

/**
 * *"Wi-Fi-preferred by default with an always-available 'upload now over
 * mobile data' override - a technician who needs the office to see a photo
 * now must never be blocked by a policy toggle."*
 *
 * The word doing the work is **always**. A data-saving policy that can block
 * an urgent photo is a policy that will, on the day it matters - a defect the
 * office needs to see before the technician leaves site. So the override is
 * not a setting buried in preferences; it is a per-photo action, and
 * `shouldUpload` cannot return false when it is set.
 */
export type NetworkKind = "none" | "cellular" | "wifi" | "unknown";

export interface UploadPolicy {
  readonly wifiOnly: boolean;
  /** Set per photo by the technician. Beats every other consideration. */
  readonly uploadNowOverride: boolean;
  /** Some carriers report a metered wifi hotspot; treated as cellular. */
  readonly meteredWifiCountsAsCellular: boolean;
}

export type UploadDecision =
  | { readonly upload: true; readonly reason: "override" | "wifi" | "policy_allows_cellular" }
  | { readonly upload: false; readonly reason: "no_connection" | "waiting_for_wifi" };

export function shouldUpload(
  policy: UploadPolicy,
  network: NetworkKind,
  isMetered = false,
): UploadDecision {
  if (network === "none") return { upload: false, reason: "no_connection" };
  if (policy.uploadNowOverride) return { upload: true, reason: "override" };

  const effectivelyCellular =
    network === "cellular" || (network === "wifi" && isMetered && policy.meteredWifiCountsAsCellular);

  if (!policy.wifiOnly) return { upload: true, reason: "policy_allows_cellular" };
  if (effectivelyCellular) return { upload: false, reason: "waiting_for_wifi" };

  // "unknown" is treated as uploadable. A device that cannot report its network
  // type is more likely to be a device with an unusual connection than a device
  // on a metered link, and refusing to upload on an unknown network is how a
  // queue silently never drains.
  return { upload: true, reason: "wifi" };
}

// ── Keeping the original (FLD-7) ────────────────────────────────────────────

/**
 * *"original retained locally until the compressed copy is confirmed synced"*.
 *
 * "Confirmed" means the server said so - `POST /uploads/complete` returned -
 * not "the last chunk PUT succeeded". A chunk landing is not the same as the
 * server having assembled, hashed and accepted the file, and deleting the only
 * full-resolution copy of a piece of evidence on the strength of the weaker
 * signal is not a trade worth making to save 8 MB.
 *
 * ── AND THE ATTACHMENT HAS TO BE FILED, NOT JUST THE BYTES STORED ──────────
 *
 * A completed upload is bytes the server holds and nothing points at. The
 * evidence only exists as evidence once `job_attachment/append` has cited the
 * `uploadId` and been accepted. Deleting the original in between would leave a
 * window where the full-resolution copy is gone and the job card still has no
 * photograph on it - so both conditions are required.
 *
 * There is no storage key here and there should not be: the server never
 * returns one (`SEC-8`), and the upload id is what ties the bytes to this job.
 */
export interface OriginalRetention {
  /** `uploads/complete` returned for this photo. */
  readonly uploadCompleteAcknowledged: boolean;
  /** The server's upload id, from init. */
  readonly uploadId: string | null;
  /** The `job_attachment/append` citing that upload has been accepted. */
  readonly attachmentAccepted: boolean;
}

export function canDeleteOriginal(retention: OriginalRetention): boolean {
  return (
    retention.uploadCompleteAcknowledged &&
    retention.uploadId !== null &&
    retention.attachmentAccepted
  );
}

/**
 * An honest estimate of what the queue will cost in data, for the screen that
 * asks a technician to approve a cellular upload. Compressed sizes only - the
 * originals never leave the device.
 */
export function estimateQueueBytes(pending: readonly { readonly byteSize: number }[]): number {
  return pending.reduce((sum, p) => sum + p.byteSize, 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
