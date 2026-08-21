/**
 * Server-side image handling (TRD §8.6).
 *
 * ── WHERE THIS SITS IN §8.6, PRECISELY ──────────────────────────────────────
 *
 * §8.6's pipeline runs mostly on the device: capture, extract EXIF, apply
 * orientation, strip, compress to a 2048px / ~1 MB JPEG, thumbnail, queue,
 * then chunked resumable upload. Only the last three lines are the server's —
 * virus scan, SHA-256, private bucket, and on egress "EXIF stripped again,
 * verified".
 *
 * This module is the server's belt to the device's braces, and it exists
 * because "mostly on the device" is a sentence with a hole in it. A field app
 * built by someone else, a version that shipped before the compression step
 * landed, a photo attached from the web console rather than the phone, or a
 * device whose compression silently failed — all four put a 12 MB original with
 * live GPS coordinates into the store, and the server is the only place that
 * can notice.
 *
 * ── WHY IT DEGRADES INSTEAD OF DEPENDING ────────────────────────────────────
 *
 * Resampling pixels needs a native image library, which is not something to
 * make load-bearing for a security property. So the split is deliberate:
 *
 *  * **Metadata stripping never depends on anything.** `exif.ts` is
 *    hand-written, works everywhere, and is what actually stops a customer's
 *    home coordinates leaving the building.
 *  * **Resizing and format conversion depend on `sharp`**, which arrives with
 *    Next and is loaded here at runtime rather than declared as a dependency of
 *    this package — a declared dependency would have to be installed on every
 *    runtime that imports `@meridian/files`, including ones that only ever
 *    serve a rendered PDF.
 *
 * When the library is missing, `imagePipeline()` says so and the caller records
 * an honest note against the upload. It does not quietly store the original and
 * call it compressed.
 *
 * ── HEIC ────────────────────────────────────────────────────────────────────
 *
 * `heicDecode` in the state below is a real probe, not a constant, and on most
 * builds it is **false**. HEIC is HEVC frames in a HEIF container, HEVC is
 * patent-encumbered, and the prebuilt libvips that ships with sharp is
 * therefore compiled without an HEVC decoder — it reads AVIF, which is the same
 * container with AV1 inside, and refuses `.heic`. The conversion below is
 * written and will work on a runtime whose libvips has HEVC; on one that does
 * not, the upload is recorded as `unconverted` with the reason attached rather
 * than being stored as an openable file it is not.
 */

import { sniffContentType, type AllowedContentType } from "./sniff";

/** §8.6: longest edge 1920–2048px. The top of the range; downscaling twice is worse than once. */
export const IMAGE_MAX_EDGE = 2048;

/** §8.6: JPEG q≈0.75. */
export const IMAGE_JPEG_QUALITY = 75;

/** §8.6: target ≤ 1 MB. A target, not a guarantee — see the quality ladder below. */
export const IMAGE_TARGET_BYTES = 1024 * 1024;

/** The floor the quality ladder will not go below. Past this a certificate stops being readable. */
const MIN_JPEG_QUALITY = 40;

export interface ImageFacts {
  readonly width: number | null;
  readonly height: number | null;
  readonly format: string | null;
  readonly hasAlpha: boolean;
}

export type CompressionAction =
  /** Already within §8.6's envelope. Bytes untouched. */
  | "unchanged"
  /** Resized and/or re-encoded. */
  | "recompressed"
  /** Transcoded to a format staff can open. */
  | "converted"
  /** Should have been converted and could not be. The reason is in `note`. */
  | "unconverted";

export interface CompressionOutcome {
  readonly bytes: Uint8Array;
  readonly contentType: AllowedContentType;
  readonly width: number | null;
  readonly height: number | null;
  readonly action: CompressionAction;
  /** Always populated. This is what gets written next to the file. */
  readonly note: string;
}

export interface ImageProcessor {
  readonly name: string;
  facts(bytes: Uint8Array): Promise<ImageFacts>;
  /**
   * Bring one image inside §8.6's envelope.
   *
   * Never throws for an image it cannot handle — it returns `unconverted` with
   * the reason. An upload path that threw here would lose a photograph over a
   * missing codec, and the photograph is the evidence.
   */
  compress(bytes: Uint8Array, contentType: AllowedContentType): Promise<CompressionOutcome>;
}

export type ImagePipelineState =
  | {
      readonly available: true;
      readonly processor: ImageProcessor;
      /** False on nearly every prebuilt libvips. See the header. */
      readonly heicDecode: boolean;
      readonly note: string;
    }
  | { readonly available: false; readonly reason: string };

// ── The shape of `sharp` this module uses ───────────────────────────────────
//
// Declared here rather than imported, so a typecheck never depends on the
// library being installed and so a change to its type surface cannot break this
// build. Four methods and four metadata fields is the whole contract.

interface SharpMetadata {
  width?: number | undefined;
  height?: number | undefined;
  format?: string | undefined;
  hasAlpha?: boolean | undefined;
}

interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  rotate(): SharpInstance;
  resize(options: { width: number; height: number; fit: string; withoutEnlargement: boolean }): SharpInstance;
  jpeg(options: { quality: number; mozjpeg?: boolean }): SharpInstance;
  png(options: { compressionLevel: number }): SharpInstance;
  toBuffer(): Promise<Buffer>;
}

interface SharpFactory {
  (input: Uint8Array): SharpInstance;
  format?: Record<string, { input?: { fileSuffix?: readonly string[] | undefined } | undefined } | undefined>;
  versions?: Record<string, string>;
}

let _override: ImagePipelineState | undefined;
let _resolved: Promise<ImagePipelineState> | undefined;

/** Tests and scripts that want a pipeline they control. `undefined` restores the real probe. */
export function setImagePipeline(state: ImagePipelineState | undefined): void {
  _override = state;
  _resolved = undefined;
}

/**
 * What this runtime can actually do to an image.
 *
 * Probed once and cached, because the probe loads a native library and the
 * answer cannot change without a restart.
 */
export function imagePipeline(): Promise<ImagePipelineState> {
  if (_override) return Promise.resolve(_override);
  _resolved ??= probe();
  return _resolved;
}

async function probe(): Promise<ImagePipelineState> {
  let factory: SharpFactory;

  try {
    const module = await import("sharp");
    factory = ((module as { default?: unknown }).default ?? module) as unknown as SharpFactory;
    if (typeof factory !== "function") throw new Error("sharp did not export a callable");
  } catch (error) {
    return {
      available: false,
      reason:
        "No native image library is available on this runtime, so uploaded images are stored " +
        "exactly as they arrived: not resized, not re-encoded, and HEIC not converted. Their " +
        "metadata is still stripped — that path has no dependencies — but a 12 MB original is " +
        `stored as a 12 MB original. (${error instanceof Error ? error.message : String(error)})`,
    };
  }

  // The real probe. `.heic` in the HEIF loader's suffix list is the difference
  // between a libvips with an HEVC decoder and one without; a build without it
  // lists only `.avif`.
  const suffixes = factory.format?.["heif"]?.input?.fileSuffix ?? [];
  const heicDecode = suffixes.includes(".heic") || suffixes.includes(".heif");

  return {
    available: true,
    heicDecode,
    processor: new SharpImageProcessor(factory, heicDecode),
    note: heicDecode
      ? "HEIC files are converted to JPEG on upload."
      : "This libvips build has no HEVC decoder, so HEIC files cannot be converted and are " +
        "stored as they arrived. Staff without an Apple device cannot open them. Fixing it is " +
        "a deployment change — a libvips built with libheif and HEVC enabled — not a code change.",
  };
}

export class SharpImageProcessor implements ImageProcessor {
  readonly name: string;

  constructor(
    private readonly sharp: SharpFactory,
    private readonly heicDecode: boolean,
  ) {
    this.name = `sharp(${this.sharp.versions?.["vips"] ?? "unknown libvips"})`;
  }

  async facts(bytes: Uint8Array): Promise<ImageFacts> {
    try {
      const meta = await this.sharp(bytes).metadata();
      return {
        width: meta.width ?? null,
        height: meta.height ?? null,
        format: meta.format ?? null,
        hasAlpha: meta.hasAlpha === true,
      };
    } catch {
      return { width: null, height: null, format: null, hasAlpha: false };
    }
  }

  async compress(bytes: Uint8Array, contentType: AllowedContentType): Promise<CompressionOutcome> {
    if (contentType === "image/heic") return this.convertHeic(bytes);

    if (contentType !== "image/jpeg" && contentType !== "image/png" && contentType !== "image/webp") {
      return {
        bytes,
        contentType,
        width: null,
        height: null,
        action: "unchanged",
        note: `${contentType} is not an image; nothing to compress.`,
      };
    }

    const meta = await this.facts(bytes);
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);

    if (longest > 0 && longest <= IMAGE_MAX_EDGE && bytes.length <= IMAGE_TARGET_BYTES) {
      return {
        bytes,
        contentType,
        width: meta.width,
        height: meta.height,
        action: "unchanged",
        note: `Already within ${IMAGE_MAX_EDGE}px and ${IMAGE_TARGET_BYTES} bytes; stored as sent.`,
      };
    }

    // Transparency is the whole reason this branch exists. A customer signature
    // is a PNG with an alpha channel, and re-encoding it as JPEG replaces the
    // transparent background with black — a signature nobody can read, on the
    // one artefact `FLD-14` makes immutable evidence.
    const keepAlpha = meta.hasAlpha && contentType === "image/png";

    try {
      const outcome = keepAlpha
        ? await this.encodePng(bytes)
        : await this.encodeJpegLadder(bytes, meta);

      // Refusing to make things worse. A small PNG screenshot can re-encode
      // larger than it started; storing the bigger one would be absurd.
      if (outcome.bytes.length >= bytes.length && longest <= IMAGE_MAX_EDGE) {
        return {
          bytes,
          contentType,
          width: meta.width,
          height: meta.height,
          action: "unchanged",
          note: "Re-encoding produced a larger file, so the original was kept.",
        };
      }

      return outcome;
    } catch (error) {
      return {
        bytes,
        contentType,
        width: meta.width,
        height: meta.height,
        action: "unconverted",
        note: `Could not re-encode this image; it is stored as it arrived. ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** `.rotate()` with no argument applies the EXIF orientation and then drops it — §8.6's step two. */
  private pipeline(bytes: Uint8Array): SharpInstance {
    return this.sharp(bytes)
      .rotate()
      .resize({
        width: IMAGE_MAX_EDGE,
        height: IMAGE_MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
      });
  }

  /**
   * Down the quality ladder until it fits, or until the floor.
   *
   * Bounded and small — four attempts, not a search. §8.6 asks for a target,
   * and a photograph that will not reach 1 MB at q40 is one that should be
   * stored slightly large rather than made unreadable.
   */
  private async encodeJpegLadder(bytes: Uint8Array, meta: ImageFacts): Promise<CompressionOutcome> {
    let best: Buffer | null = null;
    let quality = IMAGE_JPEG_QUALITY;

    for (; quality >= MIN_JPEG_QUALITY; quality -= 12) {
      best = await this.pipeline(bytes).jpeg({ quality, mozjpeg: true }).toBuffer();
      if (best.length <= IMAGE_TARGET_BYTES) break;
    }
    if (!best) throw new Error("The JPEG encoder produced nothing");

    const out = new Uint8Array(best);
    const after = await this.facts(out);

    return {
      bytes: out,
      contentType: "image/jpeg",
      width: after.width,
      height: after.height,
      action: "recompressed",
      note:
        `${meta.width ?? "?"}×${meta.height ?? "?"} ${meta.format ?? "image"} at ${bytes.length} bytes ` +
        `→ ${after.width ?? "?"}×${after.height ?? "?"} JPEG q${Math.max(quality, MIN_JPEG_QUALITY)} at ` +
        `${out.length} bytes. Orientation applied and metadata dropped by the encoder.`,
    };
  }

  private async encodePng(bytes: Uint8Array): Promise<CompressionOutcome> {
    const buffer = await this.pipeline(bytes).png({ compressionLevel: 9 }).toBuffer();
    const out = new Uint8Array(buffer);
    const after = await this.facts(out);

    return {
      bytes: out,
      contentType: "image/png",
      width: after.width,
      height: after.height,
      action: "recompressed",
      note:
        `Kept as PNG because it has an alpha channel — re-encoding a signature as JPEG turns its ` +
        `transparent background black. ${bytes.length} → ${out.length} bytes.`,
    };
  }

  /**
   * HEIC to JPEG (`ATS-9`).
   *
   * The reason this is worth doing at all: trades candidates photograph their
   * certificates with an iPhone, an iPhone writes HEIC, and a recruiter on a
   * Windows laptop cannot open one. A file the office cannot read is the same
   * as a file that was never sent.
   */
  private async convertHeic(bytes: Uint8Array): Promise<CompressionOutcome> {
    if (!this.heicDecode) {
      return {
        bytes,
        contentType: "image/heic",
        width: null,
        height: null,
        action: "unconverted",
        note:
          "HEIC could not be converted: this runtime's libvips has no HEVC decoder. The file is " +
          "stored exactly as it arrived and will not open for staff without an Apple device. It " +
          "also still carries its own metadata, which this code cannot strip from HEIC.",
      };
    }

    try {
      const buffer = await this.pipeline(bytes).jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true }).toBuffer();
      const out = new Uint8Array(buffer);

      // Sniffed rather than assumed. Everything downstream — the store, the
      // download headers, the extension on the saved file — reads the type from
      // the bytes, and this path must not be the one place that asserts it.
      if (sniffContentType(out) !== "image/jpeg") {
        throw new Error("The converted bytes are not a JPEG");
      }

      const after = await this.facts(out);
      return {
        bytes: out,
        contentType: "image/jpeg",
        width: after.width,
        height: after.height,
        action: "converted",
        note: `HEIC converted to JPEG: ${bytes.length} → ${out.length} bytes.`,
      };
    } catch (error) {
      return {
        bytes,
        contentType: "image/heic",
        width: null,
        height: null,
        action: "unconverted",
        note: `HEIC conversion failed; the original is stored. ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }
}
