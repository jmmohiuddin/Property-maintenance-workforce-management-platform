/**
 * The object store seam.
 *
 * `packages/files` exists because there is no storage layer at all and
 * `invoices.pdf_storage_key` is a column nothing writes (`TD-14`). This module
 * is the interface; `local.ts` is the one driver that exists.
 *
 * ── WHY THERE IS NO S3 DRIVER IN THIS COMMIT ────────────────────────────────
 *
 * `INFRA-1` requires that electronic tax records are retained in the UAE, and
 * `OPEN-2` records that the hosting region has not been decided — the current
 * deployment is Singapore. Writing an S3 driver now would mean choosing a
 * bucket, a region and a credential shape before the person who has to answer
 * to a tax agent has chosen any of them, and a driver written against a guess
 * is a driver that gets rewritten. So the seam is here, one honest driver is
 * here, and `objectStore()` refuses loudly rather than pretending a bucket
 * exists.
 *
 * ── WHY THIS INTERFACE HAS NO `url()` METHOD ────────────────────────────────
 *
 * `SEC-8` requires private storage with no public URLs. The most reliable way
 * to hold that property is to make it unrepresentable: there is no method that
 * returns a link, so no route can accidentally hand one out and no template
 * can embed one. Bytes are read by a server that has already checked the
 * requester's permission, and served with `Content-Disposition: attachment`.
 * When a real S3 driver lands, short-lived signed URLs are the implementation
 * detail of `get()`, not a new method on this interface.
 *
 * ── WHY WRITES ARE REFUSED, NOT OVERWRITTEN ─────────────────────────────────
 *
 * `OPS-6` makes signed job sheets and tax documents write-once. `put()`
 * therefore fails on an existing key instead of replacing it. The failure this
 * prevents is a template change silently rewriting an invoice a customer has
 * already received and an accountant has already filed — the artefact whose
 * SHA-256 is the evidence of what was issued.
 */

import type { AllowedContentType } from "./sniff";

/** What the store knows about one stored object. */
export interface StoredObject {
  readonly key: string;
  /** Sniffed from the bytes, never taken from a caller's word. */
  readonly contentType: AllowedContentType;
  readonly sizeBytes: number;
  /** Lowercase hex. This is what makes the artefact evidential. */
  readonly sha256: string;
  readonly storedAt: string;
}

export interface PutInput {
  readonly key: string;
  readonly body: Uint8Array;
  /**
   * What the caller believes this is.
   *
   * Cross-checked against the magic bytes and refused on a mismatch. It is
   * never used *as* the content type — that always comes from the bytes. A
   * caller that disagrees with its own payload has a bug worth surfacing.
   */
  readonly declaredContentType?: AllowedContentType;
}

export interface ObjectStore {
  /** Write once. Refuses an existing key; refuses bytes outside the allowlist. */
  put(input: PutInput): Promise<StoredObject>;
  /** Bytes and metadata, or null when the key does not exist. */
  get(key: string): Promise<{ readonly object: StoredObject; readonly body: Uint8Array } | null>;
  /** Metadata only, for a route that wants to check existence cheaply. */
  head(key: string): Promise<StoredObject | null>;
  /**
   * Deliberately narrow: retention purges (`ATS-18`, `FLD` traces) need it.
   * A tax document must never reach it — see `INV-15`, seven years.
   */
  delete(key: string): Promise<void>;
}

/**
 * 25 MB.
 *
 * Enforced by the store rather than by each caller, because `SEC-8` requires
 * the cap server-side and a limit that every caller has to remember is a limit
 * one caller will forget. A rendered tax document is a few tens of kilobytes;
 * this ceiling exists for the photo and CV paths that will use the same store.
 */
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;

export class ObjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/**
 * A key is a path, and a path is the classic traversal hole.
 *
 * Lowercase, slash-separated, no `..`, no leading or repeated slash, no
 * absolute path, no backslash. The local driver turns a key into a filename,
 * so a key of `../../.env` would otherwise be a read of the deployment's
 * secrets through a route that looks like a download.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,254}$/;

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new ObjectStoreError(`Not a valid storage key: ${JSON.stringify(key)}`);
  }
  if (key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new ObjectStoreError(`Not a valid storage key: ${JSON.stringify(key)}`);
  }
}
