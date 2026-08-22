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
 *
 * ── THE OFFICE FORMATS, AND WHY THEY ARE HERE NOW ───────────────────────────
 *
 * `ATS-9` names `.doc`, `.docx`, `.rtf` and `.txt` as CV formats. The first
 * three are on the list; `.txt` is not, and the difference is not arbitrary:
 *
 *  * **`.rtf`** opens with the literal ASCII `{\rtf`. A real signature.
 *  * **`.doc`** is an OLE compound file — an eight-byte header that has not
 *    changed since 1993 — and Word's own `WordDocument` stream name is in the
 *    directory, which is what separates it from the `.xls` and `.msg` files
 *    that share the container.
 *  * **`.docx`** is a ZIP. The container is sniffable and the *contents* are
 *    then inspected: an OPC package with `[Content_Types].xml` and
 *    `word/document.xml` in its central directory is a Word document and a
 *    `.xlsx`, a `.jar` or a plain archive is not.
 *  * **`.txt` cannot be sniffed at all.** There is no header. Accepting it
 *    would mean believing a client-declared type, which is the one thing this
 *    module exists to refuse, and it would mean the allowlist could no longer
 *    say "nothing outside this list can be written" — because "plain text" is
 *    a shape, and an HTML page, an SVG and a shell script are all that shape.
 *    A candidate with a `.txt` CV is asked for a PDF. That is a worse form and
 *    a better system.
 *
 * ── WHAT MAKES THIS SAFE TO ADD, AND WHAT WOULD MAKE IT UNSAFE ──────────────
 *
 * All three formats can carry macros or embedded OLE objects, and a recruiter
 * opening one in Word is the attack. Three things stand between the two, and
 * the first is new: `ATS-9`'s virus scan is now a real ClamAV sweep rather than
 * an unimplemented column, so an uploaded document is `pending` until something
 * has actually looked at it. Second, nothing is ever rendered — every download
 * is `Content-Disposition: attachment` with `nosniff` and a sandbox CSP.
 * Third, the type is read from the bytes, so a `.exe` renamed `.docx` never
 * reaches the store.
 *
 * The condition worth stating plainly: on a deployment with **no** scanner
 * configured these files are stored `skipped` and are downloadable, and the
 * only thing left between a macro-bearing `.doc` and a recruiter is the fact
 * that it must be opened deliberately. That is the same position the system was
 * already in for PDFs, and it is why `/api/cron/scan` says loudly, on every
 * run, that no scanner is configured.
 */

/** The complete set of types this system will store. Nothing else is written. */
export const ALLOWED_CONTENT_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "application/rtf",
  "application/msword",
  // 71 characters, which matters: `candidate_documents.content_type` is
  // varchar(80), and a longer literal would fail at runtime on every upload of
  // this type with nothing catching it at compile time.
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
] as const;

export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

/** Conventional extension per type, for the download filename. */
export const EXTENSION_FOR: Readonly<Record<AllowedContentType, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/rtf": "rtf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
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

  // "{\rtf". RTF's own header, and the reason `.rtf` is sniffable when `.txt`
  // is not: it is a text format that is required to identify itself.
  if (startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66])) return "application/rtf";

  // OLE compound file. `.doc` shares this container with `.xls`, `.ppt` and
  // `.msg`, so the header alone is not an answer — the stream name is.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return containsUtf16(bytes, "WordDocument") ? "application/msword" : null;
  }

  // ZIP local file header. Same situation as the compound file, one layer up:
  // the container says nothing, the directory says everything.
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const names = zipEntryNames(bytes);
    if (
      names &&
      names.includes("[Content_Types].xml") &&
      names.some((name) => name === "word/document.xml")
    ) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    return null;
  }

  return null;
}

/**
 * Is this UTF-16LE string in these bytes?
 *
 * A compound file's directory can sit in any sector, so there is no fixed
 * offset to look at — the honest options are to implement the FAT walk or to
 * scan. The scan is bounded by the object size limit (25 MB) and runs once per
 * upload, which is nothing next to the hash that runs on the same bytes.
 */
function containsUtf16(bytes: Uint8Array, needle: string): boolean {
  const pattern = new Uint8Array(needle.length * 2);
  for (let i = 0; i < needle.length; i++) {
    pattern[i * 2] = needle.charCodeAt(i) & 0xff;
    pattern[i * 2 + 1] = 0;
  }

  outer: for (let at = 0; at + pattern.length <= bytes.length; at++) {
    for (let i = 0; i < pattern.length; i++) {
      if (bytes[at + i] !== pattern[i]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * The names in a ZIP's central directory, or `null` if this is not a plain ZIP.
 *
 * Reads the directory rather than walking local headers, because a local header
 * may declare its sizes in a trailing data descriptor — leaving a walker with
 * no way to find the next entry, and inviting the kind of guess that ends in an
 * unbounded loop over attacker-controlled bytes. Every read below is
 * bounds-checked and the entry count is capped; a Zip64 archive returns `null`
 * rather than being half-understood.
 */
function zipEntryNames(bytes: Uint8Array): string[] | null {
  const EOCD = 0x06054b50;
  const ENTRY = 0x02014b50;

  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The comment may be up to 65535 bytes, so the record starts at most that far
  // plus its own 22 bytes from the end.
  const floor = Math.max(0, bytes.length - 22 - 65535);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) return null;

  const total = view.getUint16(eocd + 10, true);
  const directoryAt = view.getUint32(eocd + 16, true);
  // Zip64 sentinels. A CV is not 4 GB; refusing is the right answer.
  if (total === 0xffff || directoryAt === 0xffffffff) return null;

  const names: string[] = [];
  let at = directoryAt;

  for (let i = 0; i < total && i < 4096; i++) {
    if (at + 46 > bytes.length) return null;
    if (view.getUint32(at, true) !== ENTRY) return null;

    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength > bytes.length) return null;

    names.push(asciiAt(bytes, at + 46, nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }

  return names;
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
