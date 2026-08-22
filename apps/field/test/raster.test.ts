import { check, equal, done } from "./_harness";
import { crc32, adler32, encodeGrayscalePng, rasterizeStrokes, renderSignatureImage } from "../src/media/raster";
import type { Stroke } from "../src/domain/signature";

// ── Published test vectors for the two checksums ────────────────────────────
//
// CRC-32 of "123456789" is the standard test vector quoted by every CRC-32
// implementation (it is `check` in the "CRC-32" entry of the CRC RevEng
// catalogue). Adler-32 of "Wikipedia" is the worked example on Wikipedia's own
// Adler-32 page, chosen because it is independently reproducible without this
// codebase.
function ascii(s: string): Uint8Array {
  return Uint8Array.from(s.split("").map((c) => c.charCodeAt(0)));
}

equal("crc32('123456789')", crc32(ascii("123456789")), 0xcbf43926);
equal("crc32('')", crc32(ascii("")), 0x00000000);
equal("adler32('Wikipedia')", adler32(ascii("Wikipedia")), 0x11e60398);
equal("adler32('')", adler32(ascii("")), 0x00000001);

// ── The PNG encoder produces a spec-shaped file ──────────────────────────────
//
// There is no PNG decoder in this workspace and none is added for this test -
// but the chunk framing (RFC 2083) is simple enough to walk by hand, and doing
// so recomputes every CRC the encoder wrote rather than trusting it. A framing
// bug (wrong length, wrong CRC, chunks in the wrong order) fails this even
// though nothing here renders the picture.
interface ParsedChunk {
  readonly type: string;
  readonly data: Uint8Array;
}

function parsePngChunks(bytes: Uint8Array): readonly ParsedChunk[] {
  const signature = bytes.subarray(0, 8);
  const expectedSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  check("PNG signature bytes", signature.every((b, i) => b === expectedSignature[i]));

  const chunks: ParsedChunk[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const length = view.getUint32(0, false);
    const type = String.fromCharCode(bytes[offset + 4] as number, bytes[offset + 5] as number,
      bytes[offset + 6] as number, bytes[offset + 7] as number);
    const dataStart = offset + 8;
    const data = bytes.subarray(dataStart, dataStart + length);
    const crcStored = new DataView(bytes.buffer, bytes.byteOffset + dataStart + length, 4).getUint32(0, false);
    const crcComputed = crc32(bytes.subarray(offset + 4, dataStart + length));
    check(`${type} chunk CRC is correct`, crcStored === crcComputed);
    chunks.push({ type, data });
    offset = dataStart + length + 4;
  }
  equal("PNG ends exactly at the last chunk", offset, bytes.length);
  return chunks;
}

const width = 20;
const height = 10;
const gray = new Uint8Array(width * height).fill(255);
gray[0] = 0; // one black pixel, so the encoder is not just emitting a blank buffer
const png = encodeGrayscalePng(width, height, gray);

const chunks = parsePngChunks(png);
equal("chunk order", chunks.map((c) => c.type).join(","), "IHDR,IDAT,IEND");

const ihdr = chunks[0] as ParsedChunk;
const ihdrView = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.length);
equal("IHDR width", ihdrView.getUint32(0, false), width);
equal("IHDR height", ihdrView.getUint32(4, false), height);
equal("IHDR bit depth", ihdr.data[8], 8);
equal("IHDR colour type (grayscale)", ihdr.data[9], 0);

check("rejects a mismatched pixel buffer", (() => {
  try {
    encodeGrayscalePng(2, 2, new Uint8Array(3));
    return false;
  } catch {
    return true;
  }
})());

// ── The zlib stream inside IDAT is a valid "stored" (uncompressed) block ────
//
// A stored DEFLATE block, once its 2-byte zlib header and 4-byte Adler-32
// trailer are stripped, is a literal copy of the input preceded by a 5-byte
// block header (RFC 1951 §3.2.4: BFINAL/BTYPE byte, LEN, NLEN). Decoding that
// by hand and checking it against the raw scanlines this encoder built is the
// closest thing available here to actually inflating the image.
const idat = (chunks[1] as ParsedChunk).data;
check("zlib CMF/FLG header is valid (CMF*256+FLG divisible by 31)", (idat[0]! * 256 + idat[1]!) % 31 === 0);
const blockHeader = idat.subarray(2, 7);
equal("stored block is final", blockHeader[0], 0x01);
const len = (blockHeader[2] as number) << 8 | (blockHeader[1] as number);
const nlen = (blockHeader[4] as number) << 8 | (blockHeader[3] as number);
equal("NLEN is the one's complement of LEN", nlen, (~len) & 0xffff);
equal("stored block length matches the scanline buffer", len, height * (width + 1));
const storedData = idat.subarray(7, 7 + len);
equal("first scanline's filter byte is None (0)", storedData[0], 0);
equal("the one black pixel survived the round trip", storedData[1], 0);
check("every other pixel on the first row is still white", Array.from(storedData.subarray(2, width + 1)).every((b) => b === 255));
const trailer = idat.subarray(idat.length - 4);
const trailerView = new DataView(trailer.buffer, trailer.byteOffset, 4);
equal("zlib Adler-32 trailer matches the scanline buffer", trailerView.getUint32(0, false), adler32(storedData));

// ── The rasteriser draws something, and stays inside the canvas ─────────────

const diagonal: readonly Stroke[] = [
  [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
];
const rasterised = rasterizeStrokes(diagonal, 50, 50, 1);
check("rasteriser produced ink somewhere", Array.from(rasterised).some((b) => b < 255));
check("rasteriser touched the near corner", rasterised[0] as number < 255);
check("rasteriser touched the far corner", rasterised[50 * 50 - 1] as number < 255);
check("rasteriser produced exactly width*height pixels", rasterised.length === 50 * 50);

// A stroke of a single point (a tap) still renders as a dot rather than
// throwing or producing an all-white buffer.
const tap: readonly Stroke[] = [[{ x: 0.5, y: 0.5 }]];
const tapped = rasterizeStrokes(tap, 20, 20, 2);
check("a single-point stroke still draws something", Array.from(tapped).some((b) => b < 255));

// A blank signature (no strokes at all) still rasterises - to a blank canvas,
// which the caller decides whether to accept, not this function.
const blank = rasterizeStrokes([], 10, 10);
check("no strokes -> an all-white canvas", blank.every((b) => b === 255));

// ── The whole pipeline: strokes + aspect ratio -> a sized PNG ───────────────

const rendered = renderSignatureImage(diagonal, 2, 300);
equal("renderSignatureImage width matches the target", rendered.width, 300);
equal("renderSignatureImage height follows the aspect ratio", rendered.height, 150);
check("renderSignatureImage produced PNG-signed bytes",
  rendered.png[0] === 137 && rendered.png[1] === 80 && rendered.png[2] === 78 && rendered.png[3] === 71);
parsePngChunks(rendered.png); // re-validates every CRC on the real pipeline output

// A degenerate aspect ratio (0, negative, NaN) must not produce a
// division-by-zero canvas - it falls back to a sane default rather than
// throwing or producing a zero-height image `encodeGrayscalePng` would reject.
const degenerate = renderSignatureImage([], 0, 100);
check("a degenerate aspect ratio still yields a positive height", degenerate.height > 0);

done("raster");
