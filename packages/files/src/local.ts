/**
 * The filesystem driver.
 *
 * For development, for tests, and for a single-node deployment that has not
 * yet had its region decision made (`INFRA-1`, `OPEN-2`). It is a real driver,
 * not a stub: it sniffs, it hashes, it refuses overwrites, and it holds the
 * same contract the S3 driver will have to hold. Building against it therefore
 * exercises the seam rather than deferring the awkward parts.
 *
 * What it is not: durable, replicated, or in the UAE. A deployment that runs
 * this in production has a data-residency problem, not a code problem, and
 * `objectStore()` says so.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sniffContentType, type AllowedContentType } from "./sniff";
import {
  assertValidKey,
  MAX_OBJECT_BYTES,
  ObjectStoreError,
  type ObjectStore,
  type PutInput,
  type StoredObject,
} from "./store";

/**
 * Metadata lives beside the object rather than inside it.
 *
 * A `.meta.json` sidecar keeps the stored bytes byte-identical to what was
 * rendered — which is the whole point, because the SHA-256 recorded on the
 * invoice row has to be recomputable from the file on disk by anyone with a
 * copy of it and `shasum`. Wrapping the payload in an envelope would break
 * that the first time an auditor tried.
 */
interface Sidecar {
  readonly contentType: AllowedContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storedAt: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class LocalFileStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    assertValidKey(key);
    const path = resolve(this.root, key);
    // Belt and braces. `assertValidKey` already forbids `..`, but this is the
    // check that survives somebody relaxing the pattern later, and it is the
    // one that matters: a key must never resolve outside its root.
    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new ObjectStoreError(`Storage key escapes the store root: ${JSON.stringify(key)}`);
    }
    return path;
  }

  async put(input: PutInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);

    if (input.body.length === 0) {
      throw new ObjectStoreError("Refusing to store an empty object");
    }
    if (input.body.length > MAX_OBJECT_BYTES) {
      throw new ObjectStoreError(
        `Object is ${input.body.length} bytes, over the ${MAX_OBJECT_BYTES}-byte limit`,
      );
    }

    const contentType = sniffContentType(input.body);
    if (!contentType) {
      throw new ObjectStoreError(
        "These bytes are not one of the formats this store holds. " +
          "The type is read from the file itself, so a declared type cannot override it.",
      );
    }
    if (input.declaredContentType && input.declaredContentType !== contentType) {
      throw new ObjectStoreError(
        `Caller declared ${input.declaredContentType} but the bytes are ${contentType}`,
      );
    }

    if (await this.head(input.key)) {
      throw new ObjectStoreError(
        `${input.key} already exists. Objects are write-once (OPS-6) — ` +
          "a stored tax document is the evidence of what was issued and cannot be replaced.",
      );
    }

    const object: StoredObject = {
      key: input.key,
      contentType,
      sizeBytes: input.body.length,
      sha256: sha256Hex(input.body),
      storedAt: new Date().toISOString(),
    };

    await mkdir(dirname(path), { recursive: true });
    // Bytes first, sidecar second. The reverse order would leave a metadata
    // record pointing at a file that does not exist if the process died
    // between the two writes, and `head()` would then report an object the
    // download route cannot serve.
    await writeFile(path, input.body, { flag: "wx" });
    await writeFile(`${path}.meta.json`, JSON.stringify(object satisfies Sidecar, null, 2));

    return object;
  }

  async head(key: string): Promise<StoredObject | null> {
    const path = this.pathFor(key);
    try {
      const raw = await readFile(`${path}.meta.json`, "utf8");
      return { key, ...(JSON.parse(raw) as Sidecar) };
    } catch {
      return null;
    }
  }

  async get(key: string): Promise<{ object: StoredObject; body: Uint8Array } | null> {
    const path = this.pathFor(key);
    const object = await this.head(key);
    if (!object) return null;

    const body = new Uint8Array(await readFile(path));

    // The hash is verified on read, not only recorded on write. A tax document
    // whose bytes have changed since they were stored is not a document that
    // should be served with a straight face — and silent bit-rot on a
    // seven-year retention window (`INV-15`) is exactly the kind of failure
    // nobody notices until an auditor asks.
    const actual = sha256Hex(body);
    if (actual !== object.sha256) {
      throw new ObjectStoreError(
        `${key} has changed since it was stored: expected SHA-256 ${object.sha256}, found ${actual}`,
      );
    }

    return { object, body };
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }
}
