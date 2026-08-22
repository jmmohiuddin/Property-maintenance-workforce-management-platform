import { check, equal, deepEqual, done } from "./_harness";
import {
  runUpload,
  attachmentMutationForUpload,
  signatureMutationForUpload,
  type UploadTransport,
  type ChunkSource,
} from "../src/sync/upload-orchestrator";
import { isKnownMutationKind, mutationKind } from "../src/sync/protocol";
import type {
  UploadChunkResponse,
  UploadCompleteResponse,
  UploadInitRequest,
  UploadInitResponse,
} from "../src/sync/protocol";

/**
 * An in-memory stand-in for the office, good enough to prove the
 * orchestration logic without a device or a network - `FieldApiClient` itself
 * is exercised over real HTTP by `test/wire-contract.ts`, which this test does
 * not attempt to duplicate.
 */
class FakeTransport implements UploadTransport {
  readonly initCalls: UploadInitRequest[] = [];
  readonly chunkCallOrder: number[] = [];
  readonly chunksReceived = new Map<number, Uint8Array>();
  completeCalled = false;

  constructor(
    private readonly chunkSize: number,
    private readonly totalBytes: number,
    private readonly alreadyReceived: readonly number[] = [],
  ) {}

  async initUpload(request: UploadInitRequest): Promise<UploadInitResponse> {
    this.initCalls.push(request);
    const chunkCount = Math.max(1, Math.ceil(this.totalBytes / this.chunkSize));
    return {
      uploadId: "upload-1",
      clientUploadId: request.clientUploadId,
      purpose: request.purpose,
      jobId: request.jobId,
      status: "open",
      chunkSize: this.chunkSize,
      chunkCount,
      receivedChunks: [...this.alreadyReceived],
      chunkUrls: [],
      sameOrigin: true,
      reused: false,
      expiresAt: "2026-08-23T00:00:00.000Z",
    };
  }

  async putChunk(input: {
    uploadId: string;
    index: number;
    bytes: ArrayBuffer | Uint8Array;
    url?: string;
    sameOrigin: boolean;
  }): Promise<UploadChunkResponse> {
    this.chunkCallOrder.push(input.index);
    this.chunksReceived.set(input.index, input.bytes as Uint8Array);
    return {
      uploadId: input.uploadId,
      chunkIndex: input.index,
      duplicate: false,
      receivedChunks: [...this.chunksReceived.keys()],
      chunkCount: Math.max(1, Math.ceil(this.totalBytes / this.chunkSize)),
      complete: this.chunksReceived.size === Math.ceil(this.totalBytes / this.chunkSize),
    };
  }

  async completeUpload(uploadId: string): Promise<UploadCompleteResponse> {
    this.completeCalled = true;
    return {
      uploadId,
      clientUploadId: "client-upload-1",
      status: "complete",
      contentType: "image/jpeg",
      sizeBytes: this.totalBytes,
      sha256: null,
      scanStatus: "pending",
      capturedAt: null,
      capturedLat: null,
      capturedLon: null,
      orientation: null,
      metadataStripped: null,
      note: null,
      serverReceivedAt: "2026-08-22T09:00:00.000Z",
    };
  }
}

function sourceOf(bytes: Uint8Array): ChunkSource {
  return {
    totalBytes: bytes.length,
    read: async (start, end) => bytes.subarray(start, end),
  };
}

async function main(): Promise<void> {
  // ── A fresh upload sends every chunk, in order, then completes ─────────────

  await (async () => {
    const bytes = new Uint8Array(250).map((_, i) => i % 256);
    const transport = new FakeTransport(100, bytes.length);
    const result = await runUpload({
      transport,
      clientUploadId: "cu-1",
      purpose: "job_photo",
      jobId: "job-1",
      source: sourceOf(bytes),
      filename: "after.jpg",
    });

    equal("returns the server's upload id", result.uploadId, "upload-1");
    deepEqual("sent chunks 0, 1 and 2 in order", transport.chunkCallOrder, [0, 1, 2]);
    check("completeUpload was called", transport.completeCalled);
    check("the whole file round-tripped through the chunks",
      Array.from(bytes).every((b, i) => transport.chunksReceived.get(Math.floor(i / 100))?.[i % 100] === b));
    equal("init named the right purpose", transport.initCalls[0]?.purpose, "job_photo");
    equal("init carried the total byte count", transport.initCalls[0]?.totalBytes, 250);
  })();

  // ── Resumption sends only the chunks the server does not already hold ──────

  await (async () => {
    const bytes = new Uint8Array(250);
    // The server says it already has chunk 0 and chunk 1; only chunk 2 is new.
    const transport = new FakeTransport(100, bytes.length, [0, 1]);
    await runUpload({
      transport,
      clientUploadId: "cu-2",
      purpose: "job_photo",
      jobId: "job-1",
      source: sourceOf(bytes),
    });
    deepEqual("only the missing chunk was sent", transport.chunkCallOrder, [2]);
  })();

  // ── An already-complete upload (every chunk already received) sends none ───

  await (async () => {
    const bytes = new Uint8Array(150);
    const transport = new FakeTransport(100, bytes.length, [0, 1]);
    await runUpload({
      transport,
      clientUploadId: "cu-3",
      purpose: "job_signature",
      jobId: "job-1",
      source: sourceOf(bytes),
    });
    deepEqual("no chunks were re-sent", transport.chunkCallOrder, []);
    check("completeUpload was still called", transport.completeCalled);
  })();

  // ── An empty capture is refused before any network call ─────────────────────

  await (async () => {
    const transport = new FakeTransport(100, 0);
    let threw = false;
    try {
      await runUpload({
        transport,
        clientUploadId: "cu-4",
        purpose: "job_photo",
        jobId: "job-1",
        source: sourceOf(new Uint8Array(0)),
      });
    } catch {
      threw = true;
    }
    check("an empty capture throws rather than uploading nothing", threw);
    check("init was never called", transport.initCalls.length === 0);
  })();

  // ── What comes out the other end is a real, recognised mutation ────────────

  const attachmentSpec = attachmentMutationForUpload({
    jobId: "job-1",
    role: "after",
    uploadId: "upload-1",
  });
  check(
    "role 'after' -> job_attachment/append with kind photo_after",
    isKnownMutationKind(attachmentSpec.entity, attachmentSpec.op) &&
      mutationKind(attachmentSpec.entity, attachmentSpec.op) === "job_attachment/append" &&
      attachmentSpec.payload["kind"] === "photo_after",
  );
  equal("the mutation cites the upload id, not a storage key", attachmentSpec.payload["uploadId"], "upload-1");
  equal("append-only: no baseVersion", attachmentSpec.baseVersion, null);

  const beforeSpec = attachmentMutationForUpload({ jobId: "job-1", role: "serial_plate", uploadId: "upload-2" });
  equal(
    "a non-'after' role maps through attachmentKindForPhotoRole, not a guess",
    beforeSpec.payload["kind"],
    "photo_before",
  );

  const signatureSpec = signatureMutationForUpload({
    jobId: "job-1",
    uploadId: "upload-3",
    signedByName: "A. Customer",
    signedByRole: "Tenant",
  });
  check(
    "job_signature/record, citing the upload",
    isKnownMutationKind(signatureSpec.entity, signatureSpec.op) &&
      mutationKind(signatureSpec.entity, signatureSpec.op) === "job_signature/record" &&
      signatureSpec.payload["uploadId"] === "upload-3",
  );

  done("upload-orchestrator");
}

void main();
