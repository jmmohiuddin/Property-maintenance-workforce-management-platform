/**
 * What a byte stream actually is.
 *
 * `SEC-8` requires that content type is sniffed from magic bytes and never
 * trusted from the client. The failure that prevents is specific and old: a
 * caller uploads `payload.svg` and declares it `image/png`, the store believes
 * the declaration, and the download route later serves the file with an
 * `image/png` header — or, worse, a route that reflects the stored type serves
 * `image/svg+xml` same-origin, at which point the SVG's embedded `<script>`
 * runs with the session cookie of whoever opened it.
 *
 * ── WHY AN ALLOWLIST AND NOT A DETECTOR ─────────────────────────────────────
 *
 * A general-purpose sniffer answers "what is this?". That is the wrong
 * question, because the honest answer for an unrecognised file is "some
 * bytes", and something downstream then has to decide what to do with it. The
 * question this module answers is "is this one of the handful of formats this
 * system stores?", and the answer is a type or `null`. Nothing outside the
 * list can be written at all.
 *
 * The list is deliberately short. It does **not** include SVG, HTML, XML or
 * anything else the browser will execute — those are text formats with no
 * reliable magic bytes anyway, so they fall out of the allowlist by
 * construction rather than by a rule somebody could later relax.
 */

/** The complete set of types this system will store. Nothing else is written. */
export const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** Conventional extension per type, for the download filename. */
export const EXTENSION_FOR: Readonly<Record<AllowedContentType, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
};

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

/** ASCII helper — the container formats identify themselves in plain text. */
function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * The type these bytes really are, or `null` if this is not a format we store.
 *
 * `null` is the answer for a corrupt file, an empty file, a text file, and a
 * format nobody has thought about. All four are refusals, and they are the
 * same refusal on purpose: a store that can be talked into writing "some
 * unknown thing" is a store that eventually serves one.
 */
export function sniffContentType(bytes: Uint8Array): AllowedContentType | null {
  // "%PDF-". A PDF is permitted to carry up to 1024 bytes of junk before its
  // header and still be readable, but this store only ever holds PDFs it
  // generated itself, so the strict reading is the right one — a file that
  // needs the lenient rule did not come from here.
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";

  // JPEG's SOI marker. The third byte distinguishes the frame type and varies,
  // so only the two-byte SOI plus the 0xFF that opens the next marker is fixed.
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";

  // RIFF container with a WEBP fourcc. Checking only "RIFF" would also accept
  // a WAV file, which is a different thing entirely.
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && asciiAt(bytes, 8, 4) === "WEBP") {
    return "image/webp";
  }

  // ISO base media file format: a `ftyp` box at offset 4, then the brand. The
  // brands below are what an iPhone camera writes; a technician's site photo
  // is the reason this format is on the list at all.
  if (asciiAt(bytes, 4, 4) === "ftyp") {
    const brand = asciiAt(bytes, 8, 4);
    if (brand === "heic" || brand === "heix" || brand === "heim" || brand === "mif1") {
      return "image/heic";
    }
  }

  return null;
}

/**
 * A filename safe to put in a `Content-Disposition` header.
 *
 * Everything outside a conservative set is replaced rather than stripped, so
 * two different references can never collapse into the same filename. A quote
 * and a credit note that both arrive as `document.pdf` is a support call.
 *
 * The characters removed are the ones that end the header value early — a
 * quote, a semicolon, a newline — which is the header-injection route into a
 * second `Content-Disposition` or a forged `Set-Cookie`.
 */
export function safeFilename(proposed: string, contentType: AllowedContentType): string {
  const extension = EXTENSION_FOR[contentType];
  const stem = proposed
    .replace(new RegExp(`\\.${extension}$`, "i"), "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);

  return `${stem || "document"}.${extension}`;
}
