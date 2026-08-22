/**
 * Where the handset's credential lives.
 *
 * The device token is the whole of this app's authority: it is the technician's
 * own principal, bounded by their own row-level scope, and it lasts thirty days
 * rather than the eight hours a browser session gets. A credential with that
 * lifetime cannot sit in `AsyncStorage`, which is an unencrypted SQLite file
 * that any process with the app's sandbox - a debug build, a rooted handset, a
 * file-level backup - can read. It goes in the operating system's keystore: the
 * iOS keychain and the Android keystore, which is what `expo-secure-store` is.
 *
 * ── WHY THE BACKEND IS AN INTERFACE AND NOT AN IMPORT ──────────────────────
 *
 * `expo-secure-store` calls a native module the moment it is imported, so a
 * file that imports it at the top cannot be loaded by anything that is not a
 * running app - not by `tsx`, not by the portable half of this workspace, not
 * by a test. That would leave the one piece of code that decides whether this
 * phone is signed in as the one piece of code nothing could exercise.
 *
 * So the storage is a three-method interface, the expo implementation is
 * obtained through a *lazy* `require` inside a factory nobody calls under test,
 * and `test/device-auth.test.ts` runs the whole of the logic below against a
 * fake with no device present. This is also why this file stays free of every
 * other native import: it is in `tsconfig.json`'s portable project by way of
 * that test, and has to compile on a machine where nobody has run an install.
 *
 * ── ONE KEY, NOT FOUR ──────────────────────────────────────────────────────
 *
 * Token, expiry, device id and technician id are one JSON value under one key.
 * Four keys would be four writes, and a process killed between the second and
 * the third leaves a phone holding a token it cannot say the device id for -
 * which reads back as a credential rather than as an absence, and gets sent.
 * With one key the write either happened or it did not, and anything that does
 * not parse into all four fields is *not registered*, full stop.
 *
 * ── NO BIOMETRIC GATE, DELIBERATELY ────────────────────────────────────────
 *
 * `expo-secure-store` offers `requireAuthentication`, which puts a fingerprint
 * or face check in front of the keychain item. It is not used and must not be.
 * Sync runs in the background, from a screen the technician is not looking at,
 * on a phone in a pocket; a credential that needs a face to read is a
 * credential that is unreadable exactly when the app needs it. The product also
 * holds no biometric data anywhere and this is not the place to start.
 *
 * What *is* set is `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`:
 *
 *   * **after first unlock**, because a scheduled sync can run before anybody
 *     has looked at the phone that morning, and the default (`WHEN_UNLOCKED`)
 *     would fail that read for no security gain over a device that has been
 *     unlocked once since it booted;
 *   * **this device only**, because the item must not travel in an encrypted
 *     backup restored onto a second handset. Two phones holding one token is
 *     precisely the situation the server calls `reuse` and answers by revoking
 *     the device - see `packages/auth/src/device.ts`. Better that the restored
 *     phone finds nothing and registers itself.
 *
 * ── EXPIRY IS NOT CHECKED HERE ─────────────────────────────────────────────
 *
 * `expiresAt` is stored and is never used to decide whether to send the token.
 * ADR 0004's whole premise is that this device's clock is not trustworthy - the
 * sync status screen exists to tell a technician theirs is two hours out - so a
 * phone refusing to try because it believes its credential has lapsed would be
 * a phone that locks itself out over a wrong clock. The server holds the
 * authority and answers `device_expired` when it means it. The value is kept so
 * the sign-in screen can say something true about when.
 */

import type { DeviceToken } from "../sync/protocol";

/**
 * The three operations this needs from a keystore.
 *
 * Deliberately not `expo-secure-store`'s own shape: `deleteItem` rather than
 * `deleteItemAsync`, and no options argument, so that the accessibility and
 * keychain-service decisions above are made in exactly one place instead of at
 * every call site where one of them could be forgotten.
 */
export interface SecureBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/** What this phone knows about itself once it has registered. */
export interface DeviceRegistration {
  /** The raw bearer token. Only its SHA-256 ever reaches the office. */
  readonly token: string;
  /** ISO-8601, from the server. Recorded, never enforced locally. */
  readonly expiresAt: string;
  readonly deviceId: string;
  readonly technicianId: string;
}

/**
 * The keystore refused.
 *
 * ── THE MESSAGE IS FIXED, AND THAT IS THE POINT ────────────────────────────
 *
 * The underlying error is not attached, not as a `cause` and not as text. A
 * keystore driver that echoes the value it was handed - and some do, on the
 * "failed to store <value>" pattern - would put the raw token into a message
 * that gets logged, shown, or sent to a crash reporter. The raw token exists in
 * exactly one place and this class is not going to be the second one.
 */
export class DeviceStoreError extends Error {
  constructor(readonly operation: "read" | "write" | "clear" | "rotate", detail: string) {
    super(detail);
    this.name = "DeviceStoreError";
  }
}

/** The single keychain key. Alphanumerics, `.`, `-` and `_` only. */
export const DEVICE_STORE_KEY = "meridian.field.device";

/** iOS `kSecAttrService` / Android alias. Namespaced so a second app cannot collide. */
const KEYCHAIN_SERVICE = "meridian.field";

/**
 * The record version.
 *
 * An unrecognised version reads back as "not registered" rather than being
 * coerced. A build that changes this shape and tries to interpret the old one
 * is a build that guesses, and the cost of guessing wrong here is a phone that
 * sends a malformed credential for ever; the cost of being wrong the other way
 * is one sign-in.
 */
const RECORD_VERSION = 1;

/**
 * The real keystore.
 *
 * `require` rather than `import`, because importing `expo-secure-store`
 * executes a native module lookup at load time and this file has to be loadable
 * by `tsx`. Nothing calls this factory except a running app.
 */
export function expoSecureStoreBackend(): SecureBackend {
  interface ExpoSecureStore {
    readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;
    getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>;
    setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
    deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>;
  }

  const store = require("expo-secure-store") as ExpoSecureStore;

  const options = {
    keychainService: KEYCHAIN_SERVICE,
    keychainAccessible: store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    // requireAuthentication is deliberately absent. See the header.
  };

  return {
    getItem: (key) => store.getItemAsync(key, options),
    setItem: (key, value) => store.setItemAsync(key, value, options),
    deleteItem: (key) => store.deleteItemAsync(key, options),
  };
}

/**
 * Read a stored record, or decide there isn't one.
 *
 * Exported because "half a record is no record" is the property that keeps a
 * malformed credential off the wire, and a property that matters that much is
 * one a test should be able to hold directly.
 */
export function parseDeviceRecord(raw: string | null): DeviceRegistration | null {
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Truncated, or written by something else. Not a credential.
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record["v"] !== RECORD_VERSION) return null;

  const token = nonEmptyString(record["token"]);
  const expiresAt = nonEmptyString(record["expiresAt"]);
  const deviceId = nonEmptyString(record["deviceId"]);
  const technicianId = nonEmptyString(record["technicianId"]);

  // All four or none. A token with no device id is the exact shape a partial
  // write produces, and it is the shape that must not be treated as a sign-in.
  if (!token || !expiresAt || !deviceId || !technicianId) return null;

  return { token, expiresAt, deviceId, technicianId };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function serialiseDeviceRecord(registration: DeviceRegistration): string {
  return JSON.stringify({ v: RECORD_VERSION, ...registration });
}

/**
 * The handset's credential, held in the keystore and cached in memory.
 *
 * ── THE MEMORY COPY IS A CORRECTNESS DEVICE, NOT A CACHE ───────────────────
 *
 * Consider a rotation whose keystore write fails. The server has already
 * retired the old token; it stays usable for ten minutes and then presenting it
 * is `reuse`, which revokes the device. Worse, a retry inside those ten minutes
 * does *not* rescue the phone: a device that authenticates on its grace token
 * is deliberately not rotated again, so no second copy of the new token is ever
 * offered. One failed write and the handset is on a ten-minute fuse.
 *
 * So `save()` updates memory *first* and writes second. If the write fails the
 * next request already carries the new token - which the server accepts, and
 * being fresh does not rotate - and the durable write is retried on the next
 * `read()`. The failure is still thrown at the caller who caused it, because a
 * phone whose keystore is refusing writes will lose the credential the moment
 * it is restarted and somebody has to be told. Surviving the blip and hiding
 * it are different things and this does the first only.
 */
export class DeviceStore {
  /** `undefined` means "not read yet"; `null` means "read, and not registered". */
  private cached: DeviceRegistration | null | undefined = undefined;
  /** A value that memory holds and the keystore does not, yet. */
  private unflushed: { readonly value: DeviceRegistration | null } | null = null;

  constructor(
    private readonly backend: SecureBackend,
    private readonly key: string = DEVICE_STORE_KEY,
  ) {}

  /** True while a write is owed to the keystore. The sync screen can show it. */
  get hasUnflushedWrite(): boolean {
    return this.unflushed !== null;
  }

  async read(): Promise<DeviceRegistration | null> {
    // A write we still owe is the truth; retry it, but do not fail the read for
    // it. The caller who caused the failed write was already told.
    if (this.unflushed) {
      await this.flush(false);
      return this.cached ?? null;
    }

    if (this.cached !== undefined) return this.cached;

    let raw: string | null;
    try {
      raw = await this.backend.getItem(this.key);
    } catch {
      throw new DeviceStoreError("read", "This phone's secure storage could not be read.");
    }

    this.cached = parseDeviceRecord(raw);
    return this.cached;
  }

  /** The token to present, or null when this phone has never registered. */
  async token(): Promise<string | null> {
    return (await this.read())?.token ?? null;
  }

  /** Store a fresh registration. Replaces whatever was there. */
  async save(registration: DeviceRegistration): Promise<void> {
    this.cached = registration;
    this.unflushed = { value: registration };
    await this.flush(true);
  }

  /**
   * Persist a rotated token against the registration already held.
   *
   * Refuses when nothing is registered rather than writing a record with no
   * device id in it. A rotation can only arrive on a request that authenticated,
   * so this cannot happen to a correct client; if it ever does, the honest
   * answer is a loud refusal and not a half record that reads back as a sign-in.
   */
  async saveRotatedToken(rotated: DeviceToken): Promise<void> {
    const current = await this.read();
    if (!current) {
      throw new DeviceStoreError(
        "rotate",
        "The office sent a replacement sign-in for a phone that is not registered.",
      );
    }
    await this.save({ ...current, token: rotated.token, expiresAt: rotated.expiresAt });
  }

  /**
   * Forget the credential.
   *
   * Called when the server has revoked this device, and when the technician
   * signs out. Memory is cleared before the keystore, so a failed delete still
   * stops this process presenting a token the office has already retired.
   */
  async clear(): Promise<void> {
    this.cached = null;
    this.unflushed = { value: null };
    await this.flush(true);
  }

  private async flush(rethrow: boolean): Promise<void> {
    const pending = this.unflushed;
    if (!pending) return;

    try {
      if (pending.value === null) {
        await this.backend.deleteItem(this.key);
      } else {
        await this.backend.setItem(this.key, serialiseDeviceRecord(pending.value));
      }
      this.unflushed = null;
    } catch {
      if (!rethrow) return;
      throw pending.value === null
        ? new DeviceStoreError("clear", "This phone's sign-in could not be removed from secure storage.")
        : new DeviceStoreError("write", "This phone's sign-in could not be saved to secure storage.");
    }
  }
}
