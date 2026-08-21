/**
 * Object storage and the media pipeline.
 *
 * See `store.ts` for the storage interface and why it looks the way it does,
 * `local.ts` for the one driver that exists, and `sniff.ts` for why a caller's
 * declared content type is never believed.
 *
 * The pipeline TRD §8.6 describes is split across four more modules, each of
 * which says in its own header why it is shaped the way it is:
 *
 *  * `chunks.ts` — resumable upload arithmetic, so a dropped connection costs
 *    one chunk rather than a 12 MB photo.
 *  * `exif.ts` — read the coordinates into columns, then take them out of the
 *    file. Dependency-free, because it holds a security property.
 *  * `images.ts` — resize, re-encode and HEIC conversion, which need a native
 *    library and therefore report honestly when they cannot run.
 *  * `scan.ts` / `clamav.ts` — the `ATS-9` virus scan, as an interface with a
 *    real driver and an explicit "no scanner configured" state.
 */

import { resolve } from "node:path";
import { LocalFileStore } from "./local";
import type { ObjectStore } from "./store";

export * from "./sniff";
export * from "./store";
export * from "./download";
export * from "./scan";
export * from "./clamav";
export * from "./exif";
export * from "./images";
export * from "./chunks";
export { LocalFileStore, sha256Hex } from "./local";

let _store: ObjectStore | undefined;

/**
 * The configured store.
 *
 * `FILES_DRIVER` selects it. Only `local` is implemented, and asking for
 * anything else fails with the reason rather than falling back — a silent
 * fallback to the local disk in a deployment that thinks it is writing to a
 * UAE bucket is the failure `INFRA-1` exists to prevent, and it would not be
 * discovered until somebody went looking for seven years of tax records.
 *
 * `FILES_LOCAL_ROOT` sets where the local driver writes. It defaults to a
 * directory under the working directory rather than the system temp directory,
 * because a temp directory is cleared on reboot and a rendered tax invoice
 * disappearing over a long weekend is not a development inconvenience — it is
 * the record of what was issued.
 */
export function objectStore(): ObjectStore {
  if (_store) return _store;

  const driver = process.env["FILES_DRIVER"]?.trim() || "local";

  if (driver !== "local") {
    throw new Error(
      `FILES_DRIVER is "${driver}", but only "local" is implemented. ` +
        "S3-compatible storage in a UAE region is INFRA-1 and is blocked on the " +
        "hosting-region decision (OPEN-2). Until that is made there is no bucket to write to.",
    );
  }

  // `turbopackIgnore` because this is a runtime directory, not a build input.
  // Without it the bundler treats `process.cwd()` here as dynamic filesystem
  // access and traces the entire repository into the server bundle — every
  // source file and the whole public folder, shipped to serve one PDF.
  const configured = process.env["FILES_LOCAL_ROOT"]?.trim();
  const root = configured
    ? resolve(/* turbopackIgnore: true */ configured)
    : `${process.cwd()}/.object-store`;

  _store = new LocalFileStore(root);
  return _store;
}

/** Tests and scripts that want a store somewhere specific. */
export function setObjectStore(store: ObjectStore | undefined): void {
  _store = store;
}
