import { check, equal, deepEqual, done } from "./_harness";
import {
  CHUNK_SIZE_BYTES,
  MAX_LONGEST_EDGE,
  canDeleteOriginal,
  chunkPlan,
  chunkRange,
  compressionPlan,
  estimateQueueBytes,
  formatBytes,
  shouldUpload,
  type UploadPolicy,
} from "../src/media/queue";
import { containsExifSegment, orientationTransform, swapsDimensions, unimplementedPipelineSteps } from "../src/media/exif";

// ── Compression (FLD-7) ─────────────────────────────────────────────────────

const landscape = compressionPlan(4032, 3024);
equal("the longest edge is capped", landscape.targetWidth, MAX_LONGEST_EDGE);
equal("and the aspect ratio is preserved", landscape.targetHeight, 1536);
check("a large photo is resized", landscape.resize);

const portrait = compressionPlan(3024, 4032);
equal("portrait caps the height", portrait.targetHeight, MAX_LONGEST_EDGE);
equal("and scales the width", portrait.targetWidth, 1536);

const small = compressionPlan(800, 600);
check("a small photo is not re-encoded", !small.resize);
equal("and is not upscaled", small.targetWidth, 800);

// ── Chunking and resumability ───────────────────────────────────────────────

equal("the default chunk size matches the server's", CHUNK_SIZE_BYTES, 512 * 1024);

const oneMegabyte = chunkPlan(1_000_000);
equal("a 1 MB photo is two chunks at the server's size", oneMegabyte.totalChunks, 2);
deepEqual("both are to send on a fresh upload", oneMegabyte.toSend, [0, 1]);
equal("and the whole file is outstanding", oneMegabyte.bytesRemaining, 1_000_000);

const resumed = chunkPlan(1_000_000, [0]);
deepEqual("a resumed upload sends only what the server lacks", resumed.toSend, [1]);
check("and reports less outstanding", resumed.bytesRemaining < oneMegabyte.bytesRemaining);

// The server declares the size at init; a plan built from the local constant
// while the server chunks differently would index the resumption wrongly.
const serverChunked = chunkPlan(1_000_000, [0, 1], 256 * 1024);
equal("a server-declared chunk size is honoured", serverChunked.totalChunks, 4);
deepEqual("and resumption indexes against it", serverChunked.toSend, [2, 3]);

const tiny = chunkPlan(12);
equal("a file smaller than one chunk is still one chunk", tiny.totalChunks, 1);
equal("and the range covers exactly the file", chunkRange(0, 12).end, 12);

const lastChunk = chunkRange(1, 1_000_000);
equal("the final chunk stops at the end of the file", lastChunk.end, 1_000_000);
check("and is shorter than a full chunk", lastChunk.end - lastChunk.start < CHUNK_SIZE_BYTES);

const complete = chunkPlan(400_000, [0]);
deepEqual("a fully received upload has nothing to send", complete.toSend, []);
equal("and nothing outstanding", complete.bytesRemaining, 0);

// ── When to upload (FLD-7's "always available" override) ────────────────────

const wifiOnly: UploadPolicy = { wifiOnly: true, uploadNowOverride: false, meteredWifiCountsAsCellular: true };

equal("with no connection, nothing uploads", shouldUpload(wifiOnly, "none").upload, false);
equal("on wifi, the queue drains", shouldUpload(wifiOnly, "wifi").upload, true);
equal("on cellular, a wifi-only policy waits", shouldUpload(wifiOnly, "cellular").upload, false);
equal(
  "and says what it is waiting for",
  shouldUpload(wifiOnly, "cellular").reason,
  "waiting_for_wifi",
);

const override: UploadPolicy = { ...wifiOnly, uploadNowOverride: true };
equal("the override beats the policy on cellular", shouldUpload(override, "cellular").upload, true);
equal("and is named as the reason", shouldUpload(override, "cellular").reason, "override");
equal(
  "but cannot conjure a connection that does not exist",
  shouldUpload(override, "none").upload,
  false,
);

equal("a metered hotspot counts as cellular", shouldUpload(wifiOnly, "wifi", true).upload, false);
const permissive: UploadPolicy = { ...wifiOnly, meteredWifiCountsAsCellular: false };
equal("unless the policy says otherwise", shouldUpload(permissive, "wifi", true).upload, true);
equal("an unknown network uploads rather than stalling", shouldUpload(wifiOnly, "unknown").upload, true);

// ── Keeping the original until the server confirms ──────────────────────────

check(
  "the original is kept until upload/complete is acknowledged",
  !canDeleteOriginal({ uploadCompleteAcknowledged: false, uploadId: null, attachmentAccepted: false }),
);
check(
  "chunks landing is not enough on its own",
  !canDeleteOriginal({ uploadCompleteAcknowledged: false, uploadId: "u1", attachmentAccepted: false }),
);
// Bytes the server holds that nothing points at are not yet evidence.
check(
  "a completed upload with no attachment filed is not enough",
  !canDeleteOriginal({ uploadCompleteAcknowledged: true, uploadId: "u1", attachmentAccepted: false }),
);
check(
  "nor is a filed attachment with no completed upload",
  !canDeleteOriginal({ uploadCompleteAcknowledged: false, uploadId: "u1", attachmentAccepted: true }),
);
check(
  "all three together release it",
  canDeleteOriginal({ uploadCompleteAcknowledged: true, uploadId: "u1", attachmentAccepted: true }),
);

equal("queue size sums the compressed copies", estimateQueueBytes([{ byteSize: 900_000 }, { byteSize: 800_000 }]), 1_700_000);
equal("bytes format readably", formatBytes(1_700_000), "1.6 MB");
equal("and small ones too", formatBytes(2048), "2 KB");

// ── EXIF orientation (FLD-8) ────────────────────────────────────────────────

deepEqual("tag 1 needs no transform", orientationTransform(1), { rotateDegrees: 0, mirrorHorizontal: false });
deepEqual("tag 6 rotates a quarter turn", orientationTransform(6), { rotateDegrees: 90, mirrorHorizontal: false });
deepEqual("tag 3 is upside down", orientationTransform(3), { rotateDegrees: 180, mirrorHorizontal: false });
deepEqual("tag 2 is mirrored, not rotated", orientationTransform(2), { rotateDegrees: 0, mirrorHorizontal: true });
deepEqual("tag 5 is both", orientationTransform(5), { rotateDegrees: 90, mirrorHorizontal: true });
deepEqual("a missing tag is left alone", orientationTransform(null), { rotateDegrees: 0, mirrorHorizontal: false });
deepEqual("an out-of-range tag is left alone rather than guessed", orientationTransform(99), {
  rotateDegrees: 0,
  mirrorHorizontal: false,
});

check("a quarter turn swaps the dimensions", swapsDimensions(orientationTransform(6)));
check("a half turn does not", !swapsDimensions(orientationTransform(3)));

// ── EXIF strip verification (FLD-8c) ────────────────────────────────────────

// FF D8 (SOI), then APP1: FF E1, two length bytes, then the "Exif\0\0" header.
const withExif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
check("an APP1 Exif segment is detected", containsExifSegment(withExif));

const stripped = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06]);
check("a stripped JPEG reports clean", !containsExifSegment(stripped));

// An APP1 segment carrying XMP: "http://ns.adobe.com/xap/" where Exif would be.
const app1NotExif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f]);
check("an APP1 segment that is not Exif (XMP) is not mistaken for one", !containsExifSegment(app1NotExif));

check("the pipeline is honest about what is not built", unimplementedPipelineSteps().length > 0);

done("media");
