/**
 * EXIF: read it into columns, then take it out of the file (TRD §8.6).
 *
 * ── WHY BOTH HALVES, IN THAT ORDER ──────────────────────────────────────────
 *
 * §8.6 is explicit and the reasoning is worth keeping next to the code:
 *
 *  * **Extract first.** EXIF is fragile. Resizing rewrites it, most processing
 *    pipelines drop it, a share sheet strips it, and no database query can ever
 *    reach it. If the evidential value of a job photo is "taken at these
 *    coordinates at this time", that fact has to live in a column, because in
 *    the file it is one well-meaning transform away from gone.
 *
 *  * **Strip second.** A domestic job photo with embedded GPS carries the
 *    customer's home coordinates to everyone the photo is ever forwarded to.
 *    The customer copy and the emailed report are exactly that forwarding.
 *
 * ── WHY THIS IS HAND-WRITTEN AND NOT A LIBRARY ──────────────────────────────
 *
 * Both halves are small, and one of them is a security property. Stripping has
 * to work on a runtime with no native image library available, because the day
 * `imageProcessor()` reports itself unavailable is precisely the day a photo
 * would otherwise go out with its coordinates attached. A dependency that is
 * optional cannot hold a property that is not.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * JPEG only. PNG (`eXIf` chunk), WebP (`EXIF` chunk) and HEIC (an `Exif` item
 * in the meta box) can all carry the same coordinates, and this module reads
 * and strips none of them. That is a real gap and it is stated rather than
 * papered over: `stripMetadata()` below returns `supported: false` for those
 * types so a caller can refuse to send one rather than send one it believes it
 * has cleaned. The field app's compressed copy is a JPEG, which is the path
 * §8.6 actually describes.
 */

/** What the file said about itself, in the shape a column can hold. */
export interface ExifFacts {
  /** Decimal degrees, north positive. Null when the photo carries no GPS. */
  readonly latitude: number | null;
  /** Decimal degrees, east positive. */
  readonly longitude: number | null;
  /** ISO 8601. Uses the camera's recorded UTC offset when it gave one. */
  readonly takenAt: string | null;
  /** The TIFF orientation value, 1–8, or null. 1 means "already upright". */
  readonly orientation: number | null;
}

export const NO_EXIF: ExifFacts = {
  latitude: null,
  longitude: null,
  takenAt: null,
  orientation: null,
};

// ── JPEG segment walking ────────────────────────────────────────────────────

const SOI = 0xd8;
const SOS = 0xda;
const EOI = 0xd9;
const COM = 0xfe;

/**
 * Markers whose payload is metadata rather than picture.
 *
 * APP0 (JFIF density) and APP2 (ICC colour profile) are deliberately kept: the
 * first carries no personal data and the second is what stops the image
 * changing colour when it is opened somewhere else. Everything else in the APP
 * range goes, which covers EXIF and XMP (both APP1), Photoshop/IPTC (APP13),
 * and the maker-note blocks that phone vendors scatter through the rest.
 */
function isMetadataMarker(marker: number): boolean {
  if (marker === COM) return true;
  if (marker === 0xe0 || marker === 0xe2) return false; // APP0, APP2
  return marker >= 0xe1 && marker <= 0xef; // APP1..APP15
}

interface Segment {
  readonly marker: number;
  /** Offset of the 0xFF that opens the marker. */
  readonly start: number;
  /** Offset just past the segment's payload. */
  readonly end: number;
  readonly payloadStart: number;
  readonly payloadEnd: number;
}

/**
 * Every marker segment before the compressed data starts.
 *
 * Stops at SOS. Everything after SOS is entropy-coded scan data in which a
 * 0xFF byte is stuffed rather than a marker, so continuing to "walk markers"
 * past it is how naive parsers corrupt images.
 */
function jpegSegments(bytes: Uint8Array): Segment[] | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) return null;

  const segments: Segment[] = [];
  let at = 2;

  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;

    // Fill bytes: a marker may be preceded by any number of extra 0xFFs.
    let markerAt = at + 1;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++;
    const marker = bytes[markerAt];
    if (marker === undefined) return null;

    if (marker === SOS || marker === EOI) {
      segments.push({
        marker,
        start: at,
        end: bytes.length,
        payloadStart: markerAt + 1,
        payloadEnd: bytes.length,
      });
      return segments;
    }

    const lengthAt = markerAt + 1;
    if (lengthAt + 2 > bytes.length) return null;
    const length = ((bytes[lengthAt] ?? 0) << 8) | (bytes[lengthAt + 1] ?? 0);
    if (length < 2) return null;

    const end = lengthAt + length;
    if (end > bytes.length) return null;

    segments.push({ marker, start: at, end, payloadStart: lengthAt + 2, payloadEnd: end });
    at = end;
  }

  return segments;
}

// ── The TIFF block inside APP1 ──────────────────────────────────────────────

class Tiff {
  constructor(
    private readonly view: DataView,
    /** Offset of the TIFF header within `view`. All IFD offsets are relative to it. */
    private readonly base: number,
    private readonly little: boolean,
  ) {}

  u16(at: number): number {
    return this.view.getUint16(at, this.little);
  }
  u32(at: number): number {
    return this.view.getUint32(at, this.little);
  }
  abs(offset: number): number {
    return this.base + offset;
  }
  get length(): number {
    return this.view.byteLength;
  }
  ascii(at: number, count: number): string {
    let out = "";
    for (let i = 0; i < count && at + i < this.view.byteLength; i++) {
      const c = this.view.getUint8(at + i);
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  }
  rational(at: number): number {
    const numerator = this.u32(at);
    const denominator = this.u32(at + 4);
    return denominator === 0 ? 0 : numerator / denominator;
  }
}

const TYPE_BYTES: Readonly<Record<number, number>> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  7: 1, // UNDEFINED
  9: 4, // SLONG
  10: 8, // SRATIONAL
};

interface Entry {
  readonly type: number;
  readonly count: number;
  /** Absolute offset of the value, whether it was inline or pointed at. */
  readonly at: number;
}

/** Every tag in one IFD, keyed by tag number. Bounded; a malformed IFD yields fewer. */
function readIfd(tiff: Tiff, ifdOffset: number): Map<number, Entry> {
  const out = new Map<number, Entry>();
  const start = tiff.abs(ifdOffset);
  if (start + 2 > tiff.length) return out;

  const count = tiff.u16(start);
  // A real IFD has a handful of tags. The cap is not a guess about cameras; it
  // is the bound that stops a corrupt count from walking the whole buffer.
  const entries = Math.min(count, 512);

  for (let i = 0; i < entries; i++) {
    const at = start + 2 + i * 12;
    if (at + 12 > tiff.length) break;

    const tag = tiff.u16(at);
    const type = tiff.u16(at + 2);
    const valueCount = tiff.u32(at + 4);
    const width = TYPE_BYTES[type];
    if (!width) continue;

    const total = width * valueCount;
    const valueAt = total <= 4 ? at + 8 : tiff.abs(tiff.u32(at + 8));
    if (valueAt < 0 || valueAt + Math.min(total, 4) > tiff.length) continue;

    out.set(tag, { type, count: valueCount, at: valueAt });
  }

  return out;
}

/** Three RATIONALs — degrees, minutes, seconds — into decimal degrees. */
function degrees(tiff: Tiff, entry: Entry | undefined, ref: string): number | null {
  if (!entry || entry.type !== 5 || entry.count < 3) return null;
  if (entry.at + 24 > tiff.length) return null;

  const value =
    tiff.rational(entry.at) + tiff.rational(entry.at + 8) / 60 + tiff.rational(entry.at + 16) / 3600;

  if (!Number.isFinite(value)) return null;
  const sign = ref === "S" || ref === "W" ? -1 : 1;
  return Number((value * sign).toFixed(6));
}

/**
 * "2026:08:21 14:32:07" plus an optional "+04:00", into ISO 8601.
 *
 * Returns null rather than guessing when the offset is absent. A photo
 * timestamp with an invented timezone is worse than no timestamp: it reads as
 * precise, and the hour it is wrong by is the hour an SLA is argued over. The
 * device's own clock offset arrives on the sync envelope (`server_time`, §8.5),
 * which is where a caller that wants to reconstruct this should get it.
 */
export function parseExifDateTime(raw: string, offset: string | null): string | null {
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

  if (!offset || !/^[+-]\d{2}:\d{2}$/.test(offset.trim())) return null;

  const stamp = new Date(`${local}${offset.trim()}`);
  return Number.isNaN(stamp.getTime()) ? null : stamp.toISOString();
}

/**
 * What a JPEG says about where and when it was taken.
 *
 * Never throws. A corrupt or absent EXIF block is `NO_EXIF`, because the caller
 * is an upload path and a photograph with unreadable metadata is still a
 * photograph worth keeping.
 */
export function readJpegExif(bytes: Uint8Array): ExifFacts {
  const segments = jpegSegments(bytes);
  if (!segments) return NO_EXIF;

  const app1 = segments.find(
    (s) =>
      s.marker === 0xe1 &&
      s.payloadEnd - s.payloadStart > 8 &&
      String.fromCharCode(
        bytes[s.payloadStart] ?? 0,
        bytes[s.payloadStart + 1] ?? 0,
        bytes[s.payloadStart + 2] ?? 0,
        bytes[s.payloadStart + 3] ?? 0,
      ) === "Exif",
  );
  if (!app1) return NO_EXIF;

  const tiffStart = app1.payloadStart + 6; // "Exif\0\0"
  if (tiffStart + 8 > bytes.length) return NO_EXIF;

  const order = String.fromCharCode(bytes[tiffStart] ?? 0, bytes[tiffStart + 1] ?? 0);
  if (order !== "II" && order !== "MM") return NO_EXIF;

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tiff = new Tiff(view, tiffStart, order === "II");

    if (tiff.u16(tiffStart + 2) !== 0x002a) return NO_EXIF;

    const ifd0 = readIfd(tiff, tiff.u32(tiffStart + 4));

    const orientationEntry = ifd0.get(0x0112);
    const orientationRaw = orientationEntry ? tiff.u16(orientationEntry.at) : null;
    const orientation =
      orientationRaw !== null && orientationRaw >= 1 && orientationRaw <= 8 ? orientationRaw : null;

    let takenAt: string | null = null;
    const exifPointer = ifd0.get(0x8769);
    if (exifPointer) {
      const exif = readIfd(tiff, tiff.u32(exifPointer.at));
      const dateEntry = exif.get(0x9003) ?? ifd0.get(0x0132);
      const offsetEntry = exif.get(0x9011) ?? exif.get(0x9010);
      if (dateEntry) {
        takenAt = parseExifDateTime(
          tiff.ascii(dateEntry.at, Math.min(dateEntry.count, 32)),
          offsetEntry ? tiff.ascii(offsetEntry.at, Math.min(offsetEntry.count, 8)) : null,
        );
      }
    }

    let latitude: number | null = null;
    let longitude: number | null = null;
    const gpsPointer = ifd0.get(0x8825);
    if (gpsPointer) {
      const gps = readIfd(tiff, tiff.u32(gpsPointer.at));
      const latRef = gps.get(0x0001);
      const lonRef = gps.get(0x0003);
      latitude = degrees(tiff, gps.get(0x0002), latRef ? tiff.ascii(latRef.at, 2) : "N");
      longitude = degrees(tiff, gps.get(0x0004), lonRef ? tiff.ascii(lonRef.at, 2) : "E");

      // A photo with no fix writes 0,0 rather than omitting the tags. Null
      // Island is in the Gulf of Guinea; no job in this system is there.
      if (latitude === 0 && longitude === 0) {
        latitude = null;
        longitude = null;
      }
      if (latitude !== null && Math.abs(latitude) > 90) latitude = null;
      if (longitude !== null && Math.abs(longitude) > 180) longitude = null;
    }

    return { latitude, longitude, takenAt, orientation };
  } catch {
    // Any arithmetic on a deliberately malformed header lands here. An upload
    // is not the place to fail over metadata.
    return NO_EXIF;
  }
}

/** True when this JPEG still carries a segment `stripJpegMetadata` would remove. */
export function hasJpegMetadata(bytes: Uint8Array): boolean {
  const segments = jpegSegments(bytes);
  if (!segments) return false;
  return segments.some((s) => isMetadataMarker(s.marker));
}

/**
 * The same picture with its metadata segments removed.
 *
 * Byte-for-byte identical in the compressed image data — no decode, no
 * re-encode, no quality loss. That matters more than it sounds: an egress path
 * that re-encoded to strip metadata would produce a customer copy whose SHA-256
 * differs from the stored evidence for a reason nobody could later explain.
 *
 * Returns the input unchanged when there is nothing to remove, so a caller can
 * compare by reference to know whether it did anything.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const segments = jpegSegments(bytes);
  if (!segments || !segments.some((s) => isMetadataMarker(s.marker))) return bytes;

  const keep = segments.filter((s) => !isMetadataMarker(s.marker));
  const size = 2 + keep.reduce((total, s) => total + (s.end - s.start), 0);
  const out = new Uint8Array(size);

  out[0] = 0xff;
  out[1] = SOI;
  let at = 2;
  for (const segment of keep) {
    out.set(bytes.subarray(segment.start, segment.end), at);
    at += segment.end - segment.start;
  }

  return out;
}

export type StripResult =
  | { readonly supported: true; readonly bytes: Uint8Array; readonly removed: boolean }
  | { readonly supported: false; readonly reason: string };

/**
 * Strip metadata from whatever this is, or say plainly that it cannot.
 *
 * The `supported: false` branch is the point of this function. A caller sending
 * a file to a customer needs to know the difference between "cleaned" and "not
 * a format this code can clean", and the second must never be reported as the
 * first — that is the whole content of §8.6's "EXIF stripped again, verified".
 */
export function stripMetadata(bytes: Uint8Array, contentType: string): StripResult {
  if (contentType === "image/jpeg") {
    const cleaned = stripJpegMetadata(bytes);
    return { supported: true, bytes: cleaned, removed: cleaned !== bytes };
  }

  // Everything else, PDF included. A PDF this system rendered carries no camera
  // metadata, but a PDF somebody *uploaded* carries whatever the tool that made
  // it wrote, and this function cannot tell the two apart from the bytes. It
  // says so rather than reporting a clean it did not perform.
  return {
    supported: false,
    reason:
      `Metadata cannot be stripped from ${contentType} by this code — only JPEG is handled. ` +
      "PNG (eXIf), WebP (EXIF) and HEIC (an Exif item) can all carry GPS coordinates, and this " +
      "file may still be carrying the customer's location.",
  };
}
