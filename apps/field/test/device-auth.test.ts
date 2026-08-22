/**
 * Device registration, secure storage, rotation and revocation.
 *
 * Everything here runs under plain `tsx` with no device, no keystore and no
 * network: the store's backend is a fake implementing `SecureBackend`, and the
 * API client is handed a fake `fetch`. That is the whole reason those two are
 * injectable - the code that decides whether this handset is signed in is the
 * code that most needs exercising, and `expo-secure-store` cannot be loaded
 * outside a running app.
 *
 * The scenarios are the four the server can produce (`packages/auth/src/device.ts`):
 * a fresh registration, a rotation, a grace-window request, and the two 401s -
 * `device_expired`, which leaves the stored token alone, and `device_revoked`,
 * which must destroy it.
 */

import { check, deepEqual, done, equal } from "./_harness";
import {
  DeviceStore,
  DeviceStoreError,
  parseDeviceRecord,
  type DeviceRegistration,
  type SecureBackend,
} from "../src/auth/device-store";
import {
  RegistrationError,
  loginUrl,
  registerDevice,
  signInAndRegister,
  signOutDevice,
  type WebLoginPresenter,
} from "../src/auth/registration";
import { DeviceAuthError, FieldApiClient } from "../src/sync/client";
import { DEVICE_CURRENT_PATH, DEVICE_REGISTER_PATH, MUTATIONS_PATH } from "../src/sync/protocol";
import type { ClockSources } from "../src/domain/clock";

// ── Fakes ───────────────────────────────────────────────────────────────────

/** The keystore, as a Map, with a switch for "the keystore is refusing". */
class FakeBackend implements SecureBackend {
  readonly items = new Map<string, string>();
  writes = 0;
  reads = 0;
  deletes = 0;
  failWrites = false;
  failReads = false;

  async getItem(key: string): Promise<string | null> {
    this.reads++;
    if (this.failReads) throw new Error("keychain unavailable");
    return this.items.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.writes++;
    if (this.failWrites) throw new Error("keychain full");
    this.items.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.deletes++;
    if (this.failWrites) throw new Error("keychain locked");
    this.items.delete(key);
  }
}

const SECRET = "sYnthetic-token-0000-AAAA_do-not-log";
const ROTATED = "sYnthetic-token-1111-BBBB_do-not-log";

const REGISTRATION: DeviceRegistration = {
  token: SECRET,
  expiresAt: "2026-09-20T00:00:00.000Z",
  deviceId: "dev_1",
  technicianId: "tech_1",
};

const fixedClock: ClockSources = { now: () => 1_700_000_000_000, monotonic: () => 1_000 };

interface FakeCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | null;
}

/** A `fetch` that answers from a queue and records what it was asked. */
function fakeFetch(
  answers: readonly (() => { status: number; body: unknown })[],
): { impl: typeof fetch; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  let index = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index++;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : null,
    });
    if (!answer) throw new Error("no answer queued");
    const { status, body } = answer();
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * Everything below is one async function because `tsx` transpiles this
 * workspace to CommonJS, where top-level `await` is not available - and every
 * one of these checks is about what a keystore write or an HTTP round trip
 * left behind, which is not observable synchronously.
 */
async function main(): Promise<void> {
  // ── The record is all four fields or it is nothing ──────────────────────────

  check("nothing stored reads back as not registered", parseDeviceRecord(null) === null);
  check("an empty string is not a credential", parseDeviceRecord("") === null);
  check("truncated JSON is not a credential", parseDeviceRecord('{"v":1,"token":"ab') === null);
  check("a JSON array is not a credential", parseDeviceRecord("[]") === null);
  check(
    "a record missing the device id is not a credential",
    parseDeviceRecord(
      JSON.stringify({ v: 1, token: SECRET, expiresAt: "2026-01-01T00:00:00.000Z", technicianId: "tech_1" }),
    ) === null,
  );
  check(
    "nor is one missing the technician id",
    parseDeviceRecord(
      JSON.stringify({ v: 1, token: SECRET, expiresAt: "2026-01-01T00:00:00.000Z", deviceId: "dev_1" }),
    ) === null,
  );
  check(
    "nor one whose token is blank",
    parseDeviceRecord(JSON.stringify({ ...REGISTRATION, v: 1, token: "   " })) === null,
  );
  check(
    "a record from a version this build does not know is not a credential",
    parseDeviceRecord(JSON.stringify({ ...REGISTRATION, v: 99 })) === null,
  );
  deepEqual(
    "a complete record reads back exactly",
    parseDeviceRecord(JSON.stringify({ ...REGISTRATION, v: 1 })),
    REGISTRATION,
  );

  // ── The store ───────────────────────────────────────────────────────────────

  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);

    check("a phone that has never registered has no token", (await store.token()) === null);

    await store.save(REGISTRATION);
    equal("saving writes exactly once", backend.writes, 1);
    equal("and the token is the one to present", await store.token(), SECRET);

    // One key, so a partial write is not expressible: the whole record lands or
    // none of it does.
    equal("the record occupies one key", backend.items.size, 1);

    const reopened = new DeviceStore(backend);
    deepEqual("a fresh store reads the same record back", await reopened.read(), REGISTRATION);

    await store.saveRotatedToken({ token: ROTATED, expiresAt: "2026-10-20T00:00:00.000Z" });
    equal("rotation replaces the token", (await store.read())?.token, ROTATED);
    equal("and keeps the device id", (await store.read())?.deviceId, "dev_1");
    equal("and keeps the technician id", (await store.read())?.technicianId, "tech_1");
    equal("and takes the new expiry", (await store.read())?.expiresAt, "2026-10-20T00:00:00.000Z");

    await store.clear();
    check("clearing leaves no credential", (await store.read()) === null);
    equal("and removes the key rather than blanking it", backend.items.size, 0);
  })();

  // A rotation for a phone that is not registered would produce a record with no
  // device id in it. It is refused instead.
  await (async () => {
    const store = new DeviceStore(new FakeBackend());
    let refused = false;
    try {
      await store.saveRotatedToken({ token: ROTATED, expiresAt: "2026-10-20T00:00:00.000Z" });
    } catch (error) {
      refused = error instanceof DeviceStoreError && error.operation === "rotate";
    }
    check("a rotation with nothing registered is refused, not half-written", refused);
  })();

  // ── A keystore that refuses a write is survivable, and is still reported ────

  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);

    backend.failWrites = true;
    let raised: unknown = null;
    try {
      await store.saveRotatedToken({ token: ROTATED, expiresAt: "2026-10-20T00:00:00.000Z" });
    } catch (error) {
      raised = error;
    }

    check("a failed rotation write is raised, not swallowed", raised instanceof DeviceStoreError);
    // The point of the memory copy: the server has already retired the old token
    // and will not rotate again for a device on its grace token, so the next
    // request has to carry the new one or the handset is on a ten-minute fuse.
    equal("but the new token is used immediately anyway", await store.token(), ROTATED);
    check("and the store knows it still owes the keystore a write", store.hasUnflushedWrite);

    backend.failWrites = false;
    await store.read();
    check("which it settles on the next read", !store.hasUnflushedWrite);
    deepEqual("with the rotated record durable", parseDeviceRecord(backend.items.get("meridian.field.device") ?? null), {
      ...REGISTRATION,
      token: ROTATED,
      expiresAt: "2026-10-20T00:00:00.000Z",
    });
  })();

  await (async () => {
    const backend = new FakeBackend();
    backend.failReads = true;
    const store = new DeviceStore(backend);
    let raised: unknown = null;
    try {
      await store.read();
    } catch (error) {
      raised = error;
    }
    check("an unreadable keystore is an error, not a silent 'not registered'", raised instanceof DeviceStoreError);
  })();

  // Clearing a revoked credential stops this process presenting it even when the
  // keystore delete itself fails.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    backend.failWrites = true;
    try {
      await store.clear();
    } catch {
      // Expected: reported to the caller.
    }
    check("a failed delete still stops the token being presented", (await store.token()) === null);
  })();

  // ── Registration ────────────────────────────────────────────────────────────

  equal("the login page is the office's own", loginUrl("https://office.example.com"), "https://office.example.com/login");
  equal("a trailing slash does not double up", loginUrl("https://office.example.com/"), "https://office.example.com/login");

  await (async () => {
    const { impl, calls } = fakeFetch([
      () => ({
        status: 200,
        body: {
          device: { id: "dev_9", technicianId: "tech_9" },
          deviceToken: { token: SECRET, expiresAt: "2026-09-20T00:00:00.000Z" },
          serverTime: "2026-08-21T09:00:00.000Z",
        },
      }),
    ]);

    const registration = await registerDevice({
      baseUrl: "https://office.example.com",
      device: { label: "", platform: "ios", appVersion: "0.1.0", osVersion: "18.2" },
      fetchImpl: impl,
    });

    const call = calls[0];
    equal("registration posts to the register route", call?.url, `https://office.example.com${DEVICE_REGISTER_PATH}`);
    equal("as a POST", call?.method, "POST");
    check("and carries no bearer token, because it has none yet", !("Authorization" in (call?.headers ?? {})));
    deepEqual("the registration is the whole credential", registration, {
      token: SECRET,
      expiresAt: "2026-09-20T00:00:00.000Z",
      deviceId: "dev_9",
      technicianId: "tech_9",
    });
  })();

  // The three refusals the route can produce, and what each one tells the person
  // holding the phone to do.
  for (const [status, code, remedy] of [
    [401, "unauthenticated", "signIn"],
    [403, "not_a_technician", "callOffice"],
    [429, "rate_limited", "retry"],
    [500, "server_error", "retry"],
  ] as const) {
    await (async () => {
      const { impl } = fakeFetch([() => ({ status, body: { error: { code, message: "The office said no." } } })]);
      let raised: unknown = null;
      try {
        await registerDevice({
          baseUrl: "https://office.example.com",
          device: { label: "", platform: "android", appVersion: "0.1.0", osVersion: "15" },
          fetchImpl: impl,
        });
      } catch (error) {
        raised = error;
      }
      check(`${code} is a registration failure`, raised instanceof RegistrationError);
      equal(`${code} tells the technician to ${remedy}`, (raised as RegistrationError).remedy, remedy);
      equal(`${code} shows the server's own sentence`, (raised as RegistrationError).message, "The office said no.");
    })();
  }

  // The seam: no web view, no sign-in, and it says so rather than failing oddly.
  await (async () => {
    const store = new DeviceStore(new FakeBackend());
    let raised: unknown = null;
    try {
      await signInAndRegister({
        baseUrl: "https://office.example.com",
        device: { label: "", platform: "ios", appVersion: "0.1.0", osVersion: "18.2" },
        store,
        webLogin: null,
      });
    } catch (error) {
      raised = error;
    }
    check("without a login web view, registration refuses", raised instanceof RegistrationError);
    check(
      "with a sentence about the office finishing the setup",
      (raised as RegistrationError).message.includes("Ask the office"),
    );
    check("and nothing is stored", (await store.read()) === null);
  })();

  // With a presenter, the cookie the web view obtained is what authenticates.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    const presented: string[] = [];
    const presenter: WebLoginPresenter = {
      present: async ({ loginUrl: url }) => {
        presented.push(url);
        return { signedIn: true, cookieHeader: "meridian_session=abc" };
      },
    };
    const { impl, calls } = fakeFetch([
      () => ({
        status: 200,
        body: {
          device: { id: "dev_9", technicianId: "tech_9" },
          deviceToken: { token: SECRET, expiresAt: "2026-09-20T00:00:00.000Z" },
          serverTime: "2026-08-21T09:00:00.000Z",
        },
      }),
    ]);

    await signInAndRegister({
      baseUrl: "https://office.example.com",
      device: { label: "", platform: "ios", appVersion: "0.1.0", osVersion: "18.2" },
      store,
      webLogin: presenter,
      fetchImpl: impl,
    });

    deepEqual("the office's login page is what was shown", presented, ["https://office.example.com/login"]);
    equal("the session cookie authenticates the registration", calls[0]?.headers["Cookie"], "meridian_session=abc");
    equal("and the credential is durable before sign-in returns", await new DeviceStore(backend).token(), SECRET);
  })();

  await (async () => {
    const store = new DeviceStore(new FakeBackend());
    const presenter: WebLoginPresenter = { present: async () => ({ signedIn: false }) };
    let raised: unknown = null;
    try {
      await signInAndRegister({
        baseUrl: "https://office.example.com",
        device: { label: "", platform: "ios", appVersion: "0.1.0", osVersion: "18.2" },
        store,
        webLogin: presenter,
      });
    } catch (error) {
      raised = error;
    }
    check("a login the technician abandoned registers nothing", raised instanceof RegistrationError);
    check("and nothing is stored", (await store.read()) === null);
  })();

  // ── Signing out ─────────────────────────────────────────────────────────────

  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const { impl, calls } = fakeFetch([() => ({ status: 200, body: { revoked: true } })]);

    const result = await signOutDevice({
      baseUrl: "https://office.example.com",
      store,
      appVersion: "0.1.0",
      fetchImpl: impl,
    });

    equal("sign-out deletes the current device", calls[0]?.url, `https://office.example.com${DEVICE_CURRENT_PATH}`);
    equal("with the device's own token", calls[0]?.headers["Authorization"], `Bearer ${SECRET}`);
    check("the office was told", result.toldTheOffice);
    check("and the phone has forgotten the credential", (await store.read()) === null);
  })();

  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const { impl } = fakeFetch([
      () => {
        throw new Error("no signal");
      },
    ]);

    const result = await signOutDevice({
      baseUrl: "https://office.example.com",
      store,
      appVersion: "0.1.0",
      fetchImpl: impl,
    });

    check("a sign-out with no signal did not reach the office", !result.toldTheOffice);
    // A phone being handed over in a van has to forget the token whether or not
    // the office could be reached.
    check("and the credential is destroyed anyway", (await store.read()) === null);
  })();

  // ── The client: presenting, rotating, and the three refusals ────────────────

  function clientFor(store: DeviceStore, impl: typeof fetch): FieldApiClient {
    return new FieldApiClient({
      baseUrl: "https://office.example.com",
      appVersion: "0.1.0",
      getDeviceToken: () => store.token(),
      onDeviceToken: (token) => store.saveRotatedToken(token),
      clearDeviceToken: () => store.clear(),
      clock: fixedClock,
      fetchImpl: impl,
    });
  }

  const OK_MUTATION_BODY = {
    accepted: [],
    conflicts: [],
    rejected: [],
    deferred: [],
    serverTime: "2026-08-21T09:00:00.000Z",
    clockSkewMs: 0,
  };

  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const { impl, calls } = fakeFetch([() => ({ status: 200, body: OK_MUTATION_BODY })]);

    await clientFor(store, impl).push("batch_1", []);
    equal("the client presents the stored token as a bearer", calls[0]?.headers["Authorization"], `Bearer ${SECRET}`);
    equal("to the mutations route", calls[0]?.url, `https://office.example.com${MUTATIONS_PATH}`);
  })();

  // Rotation: the new token must be durable before the caller sees the body.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);

    let tokenWhenBodyDelivered: string | null = null;
    const { impl } = fakeFetch([
      () => ({
        status: 200,
        body: { ...OK_MUTATION_BODY, deviceToken: { token: ROTATED, expiresAt: "2026-10-20T00:00:00.000Z" } },
      }),
    ]);

    await clientFor(store, impl).push("batch_1", []);
    tokenWhenBodyDelivered = parseDeviceRecord(backend.items.get("meridian.field.device") ?? null)?.token ?? null;

    equal("a rotated token is durable by the time push resolves", tokenWhenBodyDelivered, ROTATED);
    equal("and is what the next request will present", await store.token(), ROTATED);
  })();

  // A rotation the keystore refuses must fail the call rather than be dropped.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    backend.failWrites = true;

    const { impl } = fakeFetch([
      () => ({
        status: 200,
        body: { ...OK_MUTATION_BODY, deviceToken: { token: ROTATED, expiresAt: "2026-10-20T00:00:00.000Z" } },
      }),
    ]);

    let raised: unknown = null;
    try {
      await clientFor(store, impl).push("batch_1", []);
    } catch (error) {
      raised = error;
    }
    check("a rotation that could not be stored fails the request", raised instanceof DeviceStoreError);
  })();

  // Grace is not an error. The server answers 200 and rotates nothing; there is
  // no second token and the stored one must be left exactly as it is.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const before = backend.writes;
    const { impl } = fakeFetch([() => ({ status: 200, body: OK_MUTATION_BODY })]);

    const result = await clientFor(store, impl).push("batch_1", []);
    check("a request answered on the grace token succeeds", result.data.accepted.length === 0);
    equal("and writes nothing to the keystore", backend.writes, before);
    equal("leaving the token it already had", await store.token(), SECRET);
  })();

  // `device_expired`: sign in again, and keep the token, because clearing it
  // gains nothing.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const { impl } = fakeFetch([
      () => ({
        status: 401,
        body: {
          error: {
            code: "device_expired",
            message: "This device has not synced for a while and needs signing in again.",
          },
        },
      }),
    ]);

    let raised: unknown = null;
    try {
      await clientFor(store, impl).push("batch_1", []);
    } catch (error) {
      raised = error;
    }
    check("an expired device is a device-auth failure", raised instanceof DeviceAuthError);
    check("which does not clear the stored token", !(raised as DeviceAuthError).clearsStoredToken);
    equal("and the token is still there", await store.token(), SECRET);
    equal("nothing was deleted", backend.deletes, 0);
  })();

  // `device_revoked`: a copy of this credential exists somewhere the phone is
  // not, the server has already revoked the device, and the token must go.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const { impl } = fakeFetch([
      () => ({
        status: 401,
        body: {
          error: {
            code: "device_revoked",
            message: "This device has been signed out for security. Sign in again to register it.",
          },
        },
      }),
    ]);

    let raised: unknown = null;
    try {
      await clientFor(store, impl).push("batch_1", []);
    } catch (error) {
      raised = error;
    }
    check("a revoked device is a device-auth failure", raised instanceof DeviceAuthError);
    check("which clears the stored token", (raised as DeviceAuthError).clearsStoredToken);
    check("and it is gone", (await store.read()) === null);
    equal("removed from the keystore, not blanked", backend.items.size, 0);
    // Replaying a retired token is what the server treats as theft. The next
    // request must present nothing at all rather than the dead credential.
    equal("so the next request carries no bearer", await store.token(), null);
  })();

  // `device_unknown` - no token, an unrecognised one, or a revoked device. The
  // server deliberately says the same thing for all three, and the client must
  // not invent a distinction by clearing on it.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    const { impl } = fakeFetch([
      () => ({ status: 401, body: { error: { code: "device_unknown", message: "This device is not signed in." } } }),
    ]);

    let raised: unknown = null;
    try {
      await clientFor(store, impl).push("batch_1", []);
    } catch (error) {
      raised = error;
    }
    check("an unknown device is a device-auth failure", raised instanceof DeviceAuthError);
    check("which does not clear the stored token", !(raised as DeviceAuthError).clearsStoredToken);
    equal("and the token is left alone", await store.token(), SECRET);
  })();

  // A revoke whose keystore delete fails must still surface as "sign in again",
  // not as a keychain error nobody can act on.
  await (async () => {
    const backend = new FakeBackend();
    const store = new DeviceStore(backend);
    await store.save(REGISTRATION);
    backend.failWrites = true;
    const { impl } = fakeFetch([
      () => ({ status: 401, body: { error: { code: "device_revoked", message: "Signed out for security." } } }),
    ]);

    let raised: unknown = null;
    try {
      await clientFor(store, impl).push("batch_1", []);
    } catch (error) {
      raised = error;
    }
    check("the technician is told to sign in, not told about a keychain", raised instanceof DeviceAuthError);
    check("and this process has stopped presenting the token", (await store.token()) === null);
  })();

  // ── The token never reaches a console, a message, or a stringified object ───

  await (async () => {
    const captured: string[] = [];
    const real = { log: console.log, warn: console.warn, error: console.error };
    const capture =
      (name: "log" | "warn" | "error") =>
      (...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : safeString(a))).join(" "));
        // Keep the harness's own output flowing.
        if (name === "log") real.log(...args);
      };
    console.log = capture("log");
    console.warn = capture("warn");
    console.error = capture("error");

    const messages: string[] = [];
    try {
      const backend = new FakeBackend();
      const store = new DeviceStore(backend);

      // Registration, rotation, a failed write, a revoke and a sign-out: every
      // path that has the raw token in its hands.
      const { impl: registerImpl } = fakeFetch([
        () => ({
          status: 200,
          body: {
            device: { id: "dev_9", technicianId: "tech_9" },
            deviceToken: { token: SECRET, expiresAt: "2026-09-20T00:00:00.000Z" },
            serverTime: "2026-08-21T09:00:00.000Z",
          },
        }),
      ]);
      const registration = await registerDevice({
        baseUrl: "https://office.example.com",
        device: { label: "", platform: "ios", appVersion: "0.1.0", osVersion: "18.2" },
        fetchImpl: registerImpl,
      });
      await store.save(registration);

      backend.failWrites = true;
      try {
        await store.saveRotatedToken({ token: ROTATED, expiresAt: "2026-10-20T00:00:00.000Z" });
      } catch (error) {
        messages.push(describe(error));
      }
      backend.failWrites = false;

      const { impl: revokeImpl } = fakeFetch([
        () => ({ status: 401, body: { error: { code: "device_revoked", message: "Signed out for security." } } }),
      ]);
      try {
        await clientFor(store, revokeImpl).push("batch_1", []);
      } catch (error) {
        messages.push(describe(error));
      }

      const { impl: badRegisterImpl } = fakeFetch([() => ({ status: 500, body: "not an envelope" })]);
      try {
        await registerDevice({
          baseUrl: "https://office.example.com",
          device: { label: "", platform: "ios", appVersion: "0.1.0", osVersion: "18.2" },
          fetchImpl: badRegisterImpl,
        });
      } catch (error) {
        messages.push(describe(error));
      }
    } finally {
      console.log = real.log;
      console.warn = real.warn;
      console.error = real.error;
    }

    const consoleOutput = captured.join("\n");
    check("nothing in this flow printed the raw token", !consoleOutput.includes(SECRET));
    check("nor the rotated one", !consoleOutput.includes(ROTATED));
    check(
      "and no error message carries a token",
      messages.every((message) => !message.includes(SECRET) && !message.includes(ROTATED)),
    );
    check("there were errors to check", messages.length === 3);
  })();

  done("device-auth");
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return safeString(error);
  // Everything a logger or a crash reporter would pick up.
  return [error.name, error.message, error.stack ?? "", safeString(error)].join("\n");
}

function safeString(value: unknown): string {
  try {
    return JSON.stringify(value, Object.getOwnPropertyNames(Object(value)) as string[]) ?? String(value);
  } catch {
    return String(value);
  }
}

void main();
