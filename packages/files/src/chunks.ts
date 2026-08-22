/**
 * Resumable, chunked upload — the arithmetic half (TRD §8.5, §8.6).
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * ADR 0004: photos and signatures "upload separately from record sync, queued,
 * resumable, and heavily compressed. A day of job photos over a hotel's guest
 * wifi is the realistic worst case." A single POST of a 12 MB photo over that
 * connection is a coin toss, and losing it means starting again — so the
 * twentieth attempt is no more likely to succeed than the first, and the
 * technician's phone burns the battery proving it.
 *
 * Chunking changes the shape of the failure: a dropped connection costs one
 * chunk, the client asks what is still missing, and it sends only that. The
 * upload makes progress even on a link that never once stays up long enough to
 * carry the whole file.
 *
 * ── WHY THE PLAN IS PURE FUNCTIONS AND THE STATE IS IN POSTGRES ─────────────
 *
 * Everything here is arithmetic over a total size and a chunk size, and
 * arithmetic is where an off-by-one lives: a final chunk sized as a full chunk,
 * an index counted from one, a total that disagrees with the sum of its parts.
 * All of that is testable with no database and no network, and it is tested.
 *
 * What is *not* here is where the received chunks live, which is
 * `upload_sessions` / `upload_chunks` in `@meridian/db` — because resumption
 * has to survive the process that received chunk 3 being replaced before chunk
 * 4 arrives. In-memory staging would work perfectly in development and fail on
 * the first serverless deployment, which is the worst possible combination.
 */

/**
 * 512 KB.
 *
 * Small enough to survive a bad link — at a realistic 200 kbit/s in a basement
 * a chunk is about twenty seconds, which most drops are shorter than — and
 * large enough that a 12 MB photo is 24 requests rather than 200. It is a
 * default: the client is told the chunk size when the session opens and must
 * use the one it was given, so this can be tuned without shipping an app.
 */
export const UPLOAD_CHUNK_BYTES = 512 * 1024;

export const MIN_UPLOAD_CHUNK_BYTES = 32 * 1024;
export const MAX_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * A ceiling on the number of parts, independent of the byte ceiling.
 *
 * `MAX_OBJECT_BYTES` already caps an object at 25 MB, which at the minimum
 * chunk size is 800 parts. This stops a client from declaring a 25 MB upload in
 * 32 KB chunks purely to open 800 round trips.
 */
export const MAX_UPLOAD_CHUNKS = 512;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export interface ChunkPlan {
  readonly totalBytes: number;
  readonly chunkSize: number;
  readonly chunkCount: number;
}

/**
 * How a file of this size is cut up.
 *
 * Refuses rather than clamps. A client that asks for a chunk size outside the
 * band has a bug, and silently substituting a different one produces a session
 * where the server and the client disagree about what chunk 4 is — which
 * surfaces later as a corrupt file with a mismatched hash and no clue why.
 */
export function planUpload(totalBytes: number, chunkSize: number = UPLOAD_CHUNK_BYTES): ChunkPlan {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new UploadError(`An upload must declare a positive size, not ${totalBytes}`);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_UPLOAD_CHUNK_BYTES || chunkSize > MAX_UPLOAD_CHUNK_BYTES) {
    throw new UploadError(
      `Chunk size must be between ${MIN_UPLOAD_CHUNK_BYTES} and ${MAX_UPLOAD_CHUNK_BYTES} bytes, not ${chunkSize}`,
    );
  }

  const chunkCount = Math.ceil(totalBytes / chunkSize);
  if (chunkCount > MAX_UPLOAD_CHUNKS) {
    throw new UploadError(
      `${totalBytes} bytes in ${chunkSize}-byte chunks is ${chunkCount} parts, over the ${MAX_UPLOAD_CHUNKS} limit`,
    );
  }

  return { totalBytes, chunkSize, chunkCount };
}

export interface ChunkExtent {
  readonly index: number;
  readonly start: number;
  readonly endExclusive: number;
  readonly length: number;
}

/** Where chunk `index` sits in the whole file. The last one is short, and that is the point. */
export function chunkExtent(plan: ChunkPlan, index: number): ChunkExtent {
  if (!Number.isInteger(index) || index < 0 || index >= plan.chunkCount) {
    throw new UploadError(`Chunk ${index} is outside this upload, which has ${plan.chunkCount} parts`);
  }

  const start = index * plan.chunkSize;
  const endExclusive = Math.min(start + plan.chunkSize, plan.totalBytes);
  return { index, start, endExclusive, length: endExclusive - start };
}

/**
 * What the client still has to send.
 *
 * This is the whole resumption protocol: the client asks, the server answers
 * with a list, the client sends those. It deliberately does not track *order* —
 * chunks may arrive in any order and more than once, because a client that
 * retries after a timeout it never saw the response to is the normal case, not
 * the exception.
 */
export function missingChunks(plan: ChunkPlan, present: readonly number[]): number[] {
  const have = new Set(present);
  const out: number[] = [];
  for (let index = 0; index < plan.chunkCount; index++) {
    if (!have.has(index)) out.push(index);
  }
  return out;
}

/**
 * Put the file back together.
 *
 * Every check here is one that has to happen *before* the bytes are sniffed,
 * hashed and stored, because all three of those would otherwise succeed
 * against a file that is quietly wrong — a missing middle chunk produces a
 * perfectly valid, permanently truncated JPEG.
 */
export function assembleUpload(
  plan: ChunkPlan,
  parts: readonly { readonly index: number; readonly bytes: Uint8Array }[],
): Uint8Array {
  const byIndex = new Map<number, Uint8Array>();
  for (const part of parts) {
    if (byIndex.has(part.index)) {
      throw new UploadError(`Chunk ${part.index} was supplied twice`);
    }
    byIndex.set(part.index, part.bytes);
  }

  const missing = missingChunks(plan, [...byIndex.keys()]);
  if (missing.length > 0) {
    throw new UploadError(
      `Cannot assemble: ${missing.length} of ${plan.chunkCount} chunks are missing (${missing
        .slice(0, 10)
        .join(", ")}${missing.length > 10 ? ", …" : ""})`,
    );
  }

  const out = new Uint8Array(plan.totalBytes);
  for (let index = 0; index < plan.chunkCount; index++) {
    const extent = chunkExtent(plan, index);
    const bytes = byIndex.get(index)!;
    if (bytes.length !== extent.length) {
      throw new UploadError(
        `Chunk ${index} is ${bytes.length} bytes; this upload declared it as ${extent.length}`,
      );
    }
    out.set(bytes, extent.start);
  }

  return out;
}
