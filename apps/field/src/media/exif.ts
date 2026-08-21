/**
 * EXIF, in the three deliberate parts `FLD-8` names.
 *
 *   (a) capture the geotag and timestamp where the photo is evidence;
 *   (b) **extract** latitude, longitude, timestamp and orientation into
 *       structured columns at capture - EXIF is fragile, stripped by
 *       processing pipelines, altered by resizing, and invisible to queries;
 *   (c) **strip** EXIF on every egress path, because embedded GPS in a
 *       domestic job photo leaks the customer's home coordinates to anyone the
 *       photo is forwarded to.
 *
 * The ordering is the requirement. Orientation in particular must be *applied*
 * to the pixels before the tag is discarded, or every portrait photo the
 * customer receives is sideways - and a sideways photo of a serial plate is an
 * unreadable photo of a serial plate.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT IS NOT ──────────────────────────────────
 *
 * It is the **policy and the pure transformations**: the extraction contract,
 * the orientation arithmetic, the strip-verification predicate. It does not
 * read EXIF from a JPEG - that is `expo-image-manipulator` and the camera's own
 * metadata, called from `src/app/`, and it is not implemented in this session.
 *
 * Part (c) is only half here on purpose. The device strips before upload, and
 * TRD §8.6 also requires a strip on **egress** - the customer copy, the emailed
 * report - performed and verified server-side. That half belongs to
 * `packages/files` and is not this workspace's to build. A client-side strip
 * alone would be a guarantee resting on every future client behaving.
 */

/** What EXIF is worth keeping, once it has been moved somewhere queryable. */
export interface ExtractedExif {
  readonly lat: number | null;
  readonly lng: number | null;
  /** The camera's own capture time. Subject to the same wrong-clock problem. */
  readonly capturedAt: string | null;
  /** EXIF orientation tag, 1-8. Null when absent. */
  readonly orientation: number | null;
  /** Metres, where the source reported it. */
  readonly accuracyMetres: number | null;
}

export const EMPTY_EXIF: ExtractedExif = {
  lat: null,
  lng: null,
  capturedAt: null,
  orientation: null,
  accuracyMetres: null,
};

/**
 * The EXIF orientation tag, resolved into the rotation and mirroring needed to
 * bake it into the pixels.
 *
 * The eight values are the standard TIFF/EXIF set. Values 2, 4, 5 and 7 are
 * mirrored, which almost no phone camera produces and which every naive
 * implementation gets wrong by treating the tag as "rotate by N degrees".
 * Handling them is nine lines; discovering that a front-camera photo of a
 * meter reading is mirrored is a callback.
 */
export interface OrientationTransform {
  readonly rotateDegrees: 0 | 90 | 180 | 270;
  readonly mirrorHorizontal: boolean;
}

export function orientationTransform(tag: number | null): OrientationTransform {
  switch (tag) {
    case 2:
      return { rotateDegrees: 0, mirrorHorizontal: true };
    case 3:
      return { rotateDegrees: 180, mirrorHorizontal: false };
    case 4:
      return { rotateDegrees: 180, mirrorHorizontal: true };
    case 5:
      return { rotateDegrees: 90, mirrorHorizontal: true };
    case 6:
      return { rotateDegrees: 90, mirrorHorizontal: false };
    case 7:
      return { rotateDegrees: 270, mirrorHorizontal: true };
    case 8:
      return { rotateDegrees: 270, mirrorHorizontal: false };
    // 1, null, and anything unrecognised: no transform. Guessing at an
    // out-of-range tag would rotate a correctly oriented photo.
    default:
      return { rotateDegrees: 0, mirrorHorizontal: false };
  }
}

/** True when applying the transform swaps the image's width and height. */
export function swapsDimensions(transform: OrientationTransform): boolean {
  return transform.rotateDegrees === 90 || transform.rotateDegrees === 270;
}

/**
 * The full capture pipeline as a declared sequence, in order.
 *
 * Written as data rather than as a comment so the sync-diagnostics screen can
 * render exactly what the app does to a photograph. `FLD-16` requires an
 * always-accessible "what we track" screen; a technician who is being asked to
 * photograph a customer's home is entitled to the same answer.
 *
 * Steps marked `implemented: false` are **not built**. The list is the honest
 * shape of the pipeline including the parts that are missing, rather than a
 * shorter list that implies completeness.
 */
export interface PipelineStep {
  readonly id: string;
  readonly description: string;
  readonly implemented: boolean;
}

export const CAPTURE_PIPELINE: readonly PipelineStep[] = [
  {
    id: "in_app_capture",
    description: "Photograph taken inside the app. The camera roll is never read (FLD-8).",
    implemented: false,
  },
  {
    id: "extract_exif",
    description: "Latitude, longitude, timestamp and orientation copied into database columns.",
    implemented: false,
  },
  {
    id: "apply_orientation",
    description: "Rotation and mirroring baked into the pixels while the tag is still known.",
    implemented: false,
  },
  {
    id: "strip_exif",
    description: "All remaining EXIF removed from the stored image.",
    implemented: false,
  },
  {
    id: "compress",
    description: "Longest edge 2048px, JPEG quality 0.75, target 1 MB.",
    implemented: false,
  },
  {
    id: "thumbnail",
    description: "Local thumbnail generated so the gallery renders instantly with no signal.",
    implemented: false,
  },
  {
    id: "queue",
    description: "Queued for chunked, resumable upload. Wi-Fi preferred; 'upload now' always available.",
    implemented: true,
  },
  {
    id: "retain_original",
    description: "Full-resolution original kept on the device until the server confirms the copy.",
    implemented: true,
  },
  {
    id: "server_scan",
    description: "Virus scan, SHA-256 and private-bucket storage, server-side.",
    implemented: false,
  },
  {
    id: "egress_strip",
    description: "EXIF stripped again and verified on every copy that leaves the organisation.",
    implemented: false,
  },
];

export function unimplementedPipelineSteps(): readonly PipelineStep[] {
  return CAPTURE_PIPELINE.filter((step) => !step.implemented);
}

/**
 * The verification half of the strip.
 *
 * A strip that is performed and not checked is a strip that silently stops
 * working the day the image library changes. This predicate is what a test - or
 * the app, before queueing - asserts against the bytes it is about to send.
 * The check is deliberately structural rather than a library call: the JPEG
 * APP1 marker carrying an "Exif\0\0" header is what has to be absent, and
 * looking for it directly cannot be fooled by a library that reports success.
 *
 * It does **not** prove there is no metadata at all: XMP lives in a different
 * APP1 payload and IPTC in APP13, and neither is checked here. Named rather
 * than implied.
 */
export function containsExifSegment(bytes: Uint8Array): boolean {
  // APP1 marker is FF E1; the segment then carries "Exif\0\0".
  for (let i = 0; i + 9 < bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xe1) continue;
    if (
      bytes[i + 4] === 0x45 && // E
      bytes[i + 5] === 0x78 && // x
      bytes[i + 6] === 0x69 && // i
      bytes[i + 7] === 0x66 && // f
      bytes[i + 8] === 0x00
    ) {
      return true;
    }
  }
  return false;
}
