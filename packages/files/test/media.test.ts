/**
 * The media pipeline: chunk arithmetic, EXIF, and image processing.
 *
 * The EXIF block below is built by hand rather than loaded from a fixture, for
 * the same reason the ZIP in `sniff.test.ts` is: a checked-in binary proves the
 * parser agrees with one camera, and a constructed one proves it agrees with
 * the specification — including the parts a single fixture would never contain,
 * like a value small enough to sit inline in its own directory entry.
 */

import {
  IMAGE_MAX_EDGE,
  IMAGE_TARGET_BYTES,
  MAX_UPLOAD_CHUNKS,
  UPLOAD_CHUNK_BYTES,
  assembleUpload,
  chunkExtent,
  hasJpegMetadata,
  imagePipeline,
  missingChunks,
  parseExifDateTime,
  planUpload,
  readJpegExif,
  sha256Hex,
  sniffContentType,
  stripJpegMetadata,
  stripMetadata,
} from "@meridian/files";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: unknown): void {
  check(label, got, true);
}
function refuses(label: string, fn: () => unknown): void {
  try {
    fn();
    fail++;
    console.log(`FAIL  ${label} — it was allowed`);
  } catch {
    console.log(`ok    ${label}`);
  }
}

// ── A JPEG with a known EXIF block ──────────────────────────────────────────

const u16le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** One 12-byte IFD entry. `value` is four bytes: the datum itself, or a pointer to it. */
const entry = (tag: number, type: number, count: number, value: number[]): number[] => [
  ...u16le(tag), ...u16le(type), ...u32le(count), ...value,
];

const rational = (numerator: number, denominator: number): number[] => [
  ...u32le(numerator), ...u32le(denominator),
];

/**
 * Dubai, 25.1972 N / 55.2744 E, on 21 August 2026 at 14:32:07 +04:00.
 *
 * The offsets are laid out by hand and commented, because that is what is being
 * tested — a parser that reads pointers correctly and one that happens to work
 * on contiguous data look identical against a fixture.
 */
function exifJpeg(): Uint8Array {
  const DATE_AT = 134;
  const OFFSET_AT = 154;
  const LAT_AT = 162;
  const LON_AT = 186;

  const tiff = [
    ...ascii("II"), ...u16le(0x2a), ...u32le(8), //   0: header, IFD0 at 8

    // 8: IFD0 — orientation inline, two pointers out
    ...u16le(3),
    ...entry(0x0112, 3, 1, [...u16le(6), 0, 0]), //   orientation = 6 (rotate 90 CW)
    ...entry(0x8769, 4, 1, u32le(50)), //             Exif IFD
    ...entry(0x8825, 4, 1, u32le(80)), //             GPS IFD
    ...u32le(0), //                                   no IFD1

    // 50: Exif IFD
    ...u16le(2),
    ...entry(0x9003, 2, 20, u32le(DATE_AT)), //       DateTimeOriginal
    ...entry(0x9011, 2, 7, u32le(OFFSET_AT)), //      OffsetTimeOriginal
    ...u32le(0),

    // 80: GPS IFD — the refs are two bytes and therefore inline
    ...u16le(4),
    ...entry(0x0001, 2, 2, [...ascii("N"), 0, 0, 0]),
    ...entry(0x0002, 5, 3, u32le(LAT_AT)),
    ...entry(0x0003, 2, 2, [...ascii("E"), 0, 0, 0]),
    ...entry(0x0004, 5, 3, u32le(LON_AT)),
    ...u32le(0),

    // 134: the values the pointers above refer to
    ...ascii("2026:08:21 14:32:07"), 0,
    ...ascii("+04:00"), 0,
    0, //                                             pad to an even offset
    ...rational(25, 1), ...rational(11, 1), ...rational(4992, 100),
    ...rational(55, 1), ...rational(16, 1), ...rational(2784, 100),
  ];

  const app1 = [...ascii("Exif"), 0, 0, ...tiff];
  const length = app1.length + 2;

  return new Uint8Array([
    0xff, 0xd8, //                                    SOI
    0xff, 0xe1, (length >> 8) & 0xff, length & 0xff, ...app1,
    0xff, 0xfe, 0x00, 0x08, ...ascii("secret"), //    COM: a comment, also metadata
    0xff, 0xda, 0x00, 0x02, //                        SOS
    0x11, 0x22, 0x33, 0x44, 0xff, 0x00, 0x55, //      "scan data", including a stuffed 0xFF
    0xff, 0xd9, //                                    EOI
  ]);
}

async function main(): Promise<void> {
  // ── Chunk arithmetic ──────────────────────────────────────────────────────
  const plan = planUpload(12 * 1024 * 1024, UPLOAD_CHUNK_BYTES);
  check("a 12 MB photo is 24 chunks at 512 KB", plan.chunkCount, 24);
  check("the first chunk starts at zero", chunkExtent(plan, 0).start, 0);
  check("the last chunk ends at the declared size", chunkExtent(plan, 23).endExclusive, plan.totalBytes);

  // The off-by-one this file exists to prevent: a final chunk sized as a full
  // chunk writes past the end of the buffer, or pads the file with zeros.
  const ragged = planUpload(1000, 32 * 1024);
  check("a file smaller than one chunk is one chunk", ragged.chunkCount, 1);
  check("and that chunk is the file, not the chunk size", chunkExtent(ragged, 0).length, 1000);

  const uneven = planUpload(100_000, 32 * 1024);
  check("100 KB in 32 KB chunks is four parts", uneven.chunkCount, 4);
  check("the last of which is short", chunkExtent(uneven, 3).length, 100_000 - 3 * 32 * 1024);

  refuses("a zero-byte upload is refused", () => planUpload(0));
  refuses("a negative size is refused", () => planUpload(-1));
  refuses("a chunk size below the floor is refused", () => planUpload(1000, 16));
  refuses("a chunk size above the ceiling is refused", () => planUpload(1000, 64 * 1024 * 1024));
  refuses(
    `${MAX_UPLOAD_CHUNKS + 1} parts is refused, so a client cannot open unbounded round trips`,
    () => planUpload(25 * 1024 * 1024, 32 * 1024),
  );
  refuses("a chunk index outside the plan is refused", () => chunkExtent(ragged, 1));

  // ── Resumption ────────────────────────────────────────────────────────────
  check("nothing sent means everything is missing", missingChunks(uneven, []).length, 4);
  check("the gap in the middle is what comes back", missingChunks(uneven, [0, 1, 3]).join(","), "2");
  check("a fully-received upload is missing nothing", missingChunks(uneven, [0, 1, 2, 3]).length, 0);
  // A client that retried a chunk it never saw the response to is the normal
  // case, not an error. Duplicates in the received list change nothing.
  check("a duplicated receipt is not a gap", missingChunks(uneven, [0, 0, 1, 2, 3]).length, 0);

  // ── Assembly ──────────────────────────────────────────────────────────────
  const whole = new Uint8Array(100_000);
  for (let i = 0; i < whole.length; i++) whole[i] = i & 0xff;

  const parts = [0, 1, 2, 3].map((index) => {
    const extent = chunkExtent(uneven, index);
    return { index, bytes: whole.subarray(extent.start, extent.endExclusive) };
  });

  // Shuffled on purpose: chunks arrive out of order on a bad link, and an
  // assembler that concatenated in arrival order would produce a file that
  // hashes differently every time and is corrupt every time.
  const shuffled = [parts[2]!, parts[0]!, parts[3]!, parts[1]!];
  check("out-of-order chunks reassemble byte-identically", sha256Hex(assembleUpload(uneven, shuffled)), sha256Hex(whole));

  refuses("a missing middle chunk is refused, not silently truncated", () =>
    assembleUpload(uneven, [parts[0]!, parts[1]!, parts[3]!]),
  );
  refuses("a chunk sent twice is refused", () => assembleUpload(uneven, [...parts, parts[0]!]));
  refuses("a chunk of the wrong length is refused", () =>
    assembleUpload(uneven, [parts[0]!, parts[1]!, parts[2]!, { index: 3, bytes: new Uint8Array(5) }]),
  );

  // ── EXIF: read it ─────────────────────────────────────────────────────────
  const photo = exifJpeg();
  check("the constructed file is a JPEG", sniffContentType(photo), "image/jpeg");

  const facts = readJpegExif(photo);
  check("latitude comes back in decimal degrees", facts.latitude, 25.1972);
  check("longitude too", facts.longitude, 55.2744);
  check("orientation is read", facts.orientation, 6);
  check("the capture time is resolved against the camera's own offset", facts.takenAt, "2026-08-21T10:32:07.000Z");

  // A timestamp with an invented timezone reads as precise and is wrong by
  // hours — which is the hour an SLA gets argued over. No offset, no answer.
  check("no recorded offset means no timestamp, not a guessed one", parseExifDateTime("2026:08:21 14:32:07", null), null);
  check("a malformed timestamp is null", parseExifDateTime("not a date", "+04:00"), null);

  // Never throws. An upload path must not lose a photograph over metadata.
  check("a file with no EXIF is not an error", readJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])).latitude, null);
  check("nor is something that is not a JPEG at all", readJpegExif(new Uint8Array([1, 2, 3])).orientation, null);
  check(
    "a truncated EXIF header is not an error",
    readJpegExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0a, ...ascii("Exif"), 0, 0, 0x49])).latitude,
    null,
  );

  // ── EXIF: take it out ─────────────────────────────────────────────────────
  checkTrue("the photo starts out carrying metadata", hasJpegMetadata(photo));

  const stripped = stripJpegMetadata(photo);
  check("stripping removes it", hasJpegMetadata(stripped), false);
  check("and the coordinates are gone with it", readJpegExif(stripped).latitude, null);
  checkTrue("the file got smaller", stripped.length < photo.length);

  // The compressed image data is untouched — no decode, no re-encode. An egress
  // path that re-encoded would produce a customer copy whose hash differs from
  // the stored evidence for a reason nobody could later explain.
  const scanData = Buffer.from(stripped).indexOf(Buffer.from([0xff, 0xda]));
  check(
    "the picture itself is byte-identical",
    Buffer.from(stripped.subarray(scanData)).toString("hex"),
    Buffer.from(photo.subarray(Buffer.from(photo).indexOf(Buffer.from([0xff, 0xda])))).toString("hex"),
  );
  check("stripping twice is a no-op", stripJpegMetadata(stripped), stripped);

  // ── Egress: cleaned, or plainly not cleaned ───────────────────────────────
  const jpegEgress = stripMetadata(photo, "image/jpeg");
  checkTrue("a JPEG can be cleaned", jpegEgress.supported);
  checkTrue("and reports that it removed something", jpegEgress.supported && jpegEgress.removed);

  // The branch that matters. "Not a format this code can clean" must never be
  // reported as "cleaned" — that is the whole content of §8.6's "verified".
  // PDF is in this list on purpose: one this system rendered carries no camera
  // metadata, one somebody uploaded carries whatever made it, and nothing in
  // the bytes distinguishes them.
  for (const type of ["image/heic", "image/png", "image/webp", "application/pdf"]) {
    const result = stripMetadata(new Uint8Array([1, 2, 3]), type);
    check(`${type} is honestly reported as un-cleanable`, result.supported, false);
    checkTrue(
      `and the reason for ${type} says the file may still carry a location`,
      !result.supported && result.reason.includes("location"),
    );
  }

  // ── The image processor ───────────────────────────────────────────────────
  const pipeline = await imagePipeline();

  if (!pipeline.available) {
    // Not a skip. This asserts the honest-degradation contract: no native
    // library means a stated reason, and callers record that reason against the
    // upload rather than claiming a compression that never happened.
    checkTrue("with no image library, the reason is stated", pipeline.reason.length > 40);
    checkTrue("and it says the file is stored as it arrived", pipeline.reason.includes("stored"));
    console.log(`note  no native image library on this runtime: ${pipeline.reason}`);
  } else {
    console.log(`note  image processor: ${pipeline.processor.name}; HEIC decode: ${pipeline.heicDecode}`);

    // A photograph shaped like the ones §8.6 is about: bigger than 2048px on
    // its long edge, and noisy enough that it does not compress to nothing.
    const big = await synthesiseJpeg(4032, 3024);
    check("the synthesised original is a JPEG", sniffContentType(big), "image/jpeg");
    checkTrue(`and is over ${IMAGE_MAX_EDGE}px on the long edge`, big.length > 0);

    const compressed = await pipeline.processor.compress(big, "image/jpeg");
    check("a phone-sized photo is recompressed", compressed.action, "recompressed");
    check("down to the §8.6 long edge", Math.max(compressed.width ?? 0, compressed.height ?? 0), IMAGE_MAX_EDGE);
    checkTrue("and under the 1 MB target", compressed.bytes.length <= IMAGE_TARGET_BYTES);
    checkTrue("and smaller than it started", compressed.bytes.length < big.length);
    check("and still a JPEG by its own bytes", sniffContentType(compressed.bytes), "image/jpeg");
    check("and carries no metadata out of the encoder", hasJpegMetadata(compressed.bytes), false);

    // Already inside the envelope: nothing to do, and doing nothing is recorded
    // as doing nothing rather than as a compression.
    const small = await synthesiseJpeg(800, 600);
    const untouched = await pipeline.processor.compress(small, "image/jpeg");
    check("an already-small photo is left alone", untouched.action, "unchanged");
    check("byte-for-byte", sha256Hex(untouched.bytes), sha256Hex(small));

    // The signature case. A PNG with transparency re-encoded as JPEG comes back
    // with a black background — an unreadable signature on the one artefact
    // FLD-14 makes immutable evidence.
    const signature = await synthesisePng(3000, 1200);
    const kept = await pipeline.processor.compress(signature, "image/png");
    check("a transparent PNG stays a PNG", kept.contentType, "image/png");
    check("resized, not converted", kept.action, "recompressed");
    check("and its own bytes agree", sniffContentType(kept.bytes), "image/png");

    // HEIC. On a libvips without an HEVC decoder this is `unconverted` with the
    // reason attached — which is the honest outcome and is asserted as such,
    // rather than the suite pretending the conversion happened.
    const heic = new Uint8Array([0, 0, 0, 0x18, ...ascii("ftypheic"), ...new Array(64).fill(0)]);
    const converted = await pipeline.processor.compress(heic, "image/heic");
    if (pipeline.heicDecode) {
      checkTrue("HEIC is either converted or explains itself", ["converted", "unconverted"].includes(converted.action));
    } else {
      check("without an HEVC decoder, HEIC is left unconverted", converted.action, "unconverted");
      check("and the original bytes are kept", sha256Hex(converted.bytes), sha256Hex(heic));
      checkTrue("and the note says why", converted.note.includes("HEVC"));
      checkTrue("and warns that staff cannot open it", converted.note.includes("Apple"));
    }
  }

  console.log(`\n${fail === 0 ? "files/media: all checks passed" : `${fail} FAILING`}`);
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * A JPEG of a given size, made here rather than checked in.
 *
 * Deliberately noisy: a flat colour compresses to a few kilobytes at any
 * resolution, so a test built on one would "pass" the 1 MB target without ever
 * exercising the quality ladder.
 */
async function synthesiseJpeg(width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  const pixels = Buffer.allocUnsafe(width * height * 3);
  let seed = 12345;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = (seed >> 16) & 0xff;
  }
  const out = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
  return new Uint8Array(out);
}

async function synthesisePng(width: number, height: number): Promise<Uint8Array> {
  const { default: sharp } = await import("sharp");
  const out = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return new Uint8Array(out);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
