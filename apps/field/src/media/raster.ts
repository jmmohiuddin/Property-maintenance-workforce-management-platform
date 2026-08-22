/**
 * Turning a signature's vector strokes into an uploadable image.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 *
 * `SignaturePad` captures a vector - `{x, y}` points, normalised 0..1, per
 * `domain/signature.ts`'s `FLD-15` argument against holding anything richer.
 * But `job_signature/record` cites an **upload**, and the upload pipeline
 * (`packages/files/src/sniff.ts`) only recognises PNG, JPEG, WEBP, PDF and a
 * handful of video containers by their magic bytes - never SVG, and never a
 * bare vector. A signature is evidence a customer signed a job sheet; sending
 * the vector as text and hoping the server infers a content type from it is
 * exactly the kind of thing this codebase's `sniffContentType` was written to
 * refuse.
 *
 * So the strokes have to become a raster image on the device, and it has to
 * be one of the four types the store recognises. This module rasterises them
 * onto a grayscale bitmap and encodes that bitmap as PNG - by hand, because
 * this workspace has no image-encoding dependency and adding a native one
 * (`react-native-view-shot`, `expo-gl`) is not something this session can
 * verify without a simulator. PNG's compressed-data stream (`IDAT`) is
 * allowed to hold **uncompressed** ("stored") DEFLATE blocks per RFC 1951
 * §3.2.4, so a real decoder reads this file correctly; it is only bigger than
 * a properly compressed one, which does not matter for a few hundred pixels
 * of black-on-white line art.
 *
 * Every piece here - `crc32`, `adler32`, the stored-block framing, the chunk
 * layout - is a fixed, published specification (RFC 1950/1951/2083), so it is
 * something `test/raster.test.ts` can actually verify: the CRC and Adler
 * functions against their own standard test vectors, and the encoded file's
 * own chunk CRCs recomputed and checked, which catches a framing bug even
 * though nothing in this session can view the picture.
 */

import type { Stroke } from "../domain/signature";

// ── CRC-32 (RFC 1952 Annex 8) ───────────────────────────────────────────────

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Adler-32 (RFC 1950 §9) ──────────────────────────────────────────────────

const ADLER_MOD = 65521;

export function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + (bytes[i] as number)) % ADLER_MOD;
    b = (b + a) % ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, false);
  return out;
}

// ── DEFLATE, stored blocks only (RFC 1951 §3.2.4) ───────────────────────────

const MAX_STORED_BLOCK = 65535;

function deflateStored(data: Uint8Array): Uint8Array {
  if (data.length === 0) {
    // One final, empty stored block: BFINAL=1, BTYPE=00, LEN=0, NLEN=0xffff.
    return Uint8Array.of(0x01, 0x00, 0x00, 0xff, 0xff);
  }
  const blocks: Uint8Array[] = [];
  let offset = 0;
  while (offset < data.length) {
    const len = Math.min(MAX_STORED_BLOCK, data.length - offset);
    const isFinal = offset + len >= data.length;
    const nlen = ~len & 0xffff;
    const block = new Uint8Array(5 + len);
    // BFINAL is bit 0 of this byte; BTYPE (bits 1-2) is 00 for "stored". The
    // remaining 5 bits are the padding RFC 1951 requires to reach the next
    // byte boundary, and padding bits must be zero.
    block[0] = isFinal ? 0x01 : 0x00;
    block[1] = len & 0xff;
    block[2] = (len >> 8) & 0xff;
    block[3] = nlen & 0xff;
    block[4] = (nlen >> 8) & 0xff;
    block.set(data.subarray(offset, offset + len), 5);
    blocks.push(block);
    offset += len;
  }
  return concatBytes(blocks);
}

/** zlib stream (RFC 1950): a 2-byte header, DEFLATE data, then Adler-32. */
function zlibStore(data: Uint8Array): Uint8Array {
  // CMF=0x78 (32K window, DEFLATE), FLG=0x01 (no preset dictionary, check
  // bits chosen so (CMF*256+FLG) % 31 === 0 - the header zlib readers verify).
  const header = Uint8Array.of(0x78, 0x01);
  return concatBytes([header, deflateStored(data), u32be(adler32(data))]);
}

// ── PNG (RFC 2083) ──────────────────────────────────────────────────────────

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type.split("").map((c) => c.charCodeAt(0)));
  const crc = crc32(concatBytes([typeBytes, data]));
  return concatBytes([u32be(data.length), typeBytes, data, u32be(crc)]);
}

/**
 * An 8-bit grayscale PNG. `gray` is one byte per pixel, row-major,
 * `width * height` long - 255 is white, 0 is black.
 */
export function encodeGrayscalePng(width: number, height: number, gray: Uint8Array): Uint8Array {
  if (width <= 0 || height <= 0) throw new Error("A PNG needs a positive width and height.");
  if (gray.length !== width * height) {
    throw new Error(`Pixel buffer is ${gray.length} bytes; expected ${width * height} for ${width}x${height}.`);
  }

  // Every scanline is prefixed with a filter-type byte; "0" (None) is used
  // throughout, which is legal and, for line art with large flat regions,
  // compresses acceptably even without the DEFLATE compression this encoder
  // does not perform.
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width + 1);
    raw[rowStart] = 0;
    raw.set(gray.subarray(y * width, y * width + width), rowStart + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: grayscale
  ihdr[10] = 0; // compression method: deflate (the only value PNG defines)
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return concatBytes([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStore(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

// ── Rasterising the signature vector ────────────────────────────────────────

function setPixel(buffer: Uint8Array, width: number, height: number, x: number, y: number, value: number): void {
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  buffer[y * width + x] = value;
}

function drawDot(buffer: Uint8Array, width: number, height: number, cx: number, cy: number, radius: number): void {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      setPixel(buffer, width, height, cx + dx, cy + dy, 0);
    }
  }
}

/** Bresenham's line algorithm, stamping a dot (the pen) at every step. */
function drawLine(
  buffer: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
): void {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    drawDot(buffer, width, height, x, y, radius);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * Strokes are normalised 0..1 against the pad (`SignaturePad`'s own
 * coordinate system); this scales them onto a `width x height` canvas and
 * draws each pen-down..pen-up movement as a connected line. A stroke of a
 * single point (a tap, not a drag) still renders as a dot.
 */
export function rasterizeStrokes(
  strokes: readonly Stroke[],
  width: number,
  height: number,
  penRadius = 2,
): Uint8Array {
  const buffer = new Uint8Array(width * height).fill(255);
  for (const stroke of strokes) {
    let previous: { x: number; y: number } | null = null;
    for (const point of stroke) {
      const x = Math.round(point.x * (width - 1));
      const y = Math.round(point.y * (height - 1));
      if (previous) drawLine(buffer, width, height, previous.x, previous.y, x, y, penRadius);
      else drawDot(buffer, width, height, x, y, penRadius);
      previous = { x, y };
    }
  }
  return buffer;
}

export interface RenderedSignature {
  readonly width: number;
  readonly height: number;
  readonly png: Uint8Array;
}

/**
 * The strokes plus the pad's aspect ratio (see `SignaturePad`'s `onChange`),
 * rendered as a PNG at a fixed target width. A blank signature (no strokes)
 * still renders - a blank white square - because refusing to render one is a
 * screen's decision about whether an empty pad may be saved, not this
 * function's.
 */
export function renderSignatureImage(
  strokes: readonly Stroke[],
  aspectRatio: number,
  targetWidth = 640,
): RenderedSignature {
  const ratio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 2;
  const width = Math.max(1, Math.round(targetWidth));
  const height = Math.max(1, Math.round(width / ratio));
  const gray = rasterizeStrokes(strokes, width, height);
  return { width, height, png: encodeGrayscalePng(width, height, gray) };
}
