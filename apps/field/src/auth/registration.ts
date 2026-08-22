/**
 * How a handset acquires a credential, and how it gives one back.
 *
 * ── THERE IS NO SECOND LOGIN, AND THAT IS THE DESIGN ───────────────────────
 *
 * `apps/web/src/app/api/field/v1/devices/register/route.ts` says it plainly:
 * *"There is exactly one place in this system where a password is checked and
 * this route is downstream of it."* The technician signs in through the same
 * `/login` page the office uses - the same password rules, the same lockout
 * curve, the same second factor, the same `sessions` row - and the resulting
 * `meridian_session` cookie is what authenticates the one call this module
 * makes. Nothing here checks a password, and nothing here may ever start.
 *
 * A device-specific credential exchange would be a second authentication path
 * with its own rate limiting, its own lockout and its own bugs, reachable from
 * every handset in the field. It is not built and must not be.
 *
 * ── SO HOW DOES A REACT NATIVE APP GET A COOKIE? ───────────────────────────
 *
 * By showing the office's own login page inside the app, in a web view, and
 * letting the server set the cookie in the platform's cookie jar the way it
 * would in any browser:
 *
 *   1. The app opens `<baseUrl>/login` in a web view.
 *   2. The technician signs in there. Password, lockout and MFA all happen on
 *      the server, in the page the office already ships. This app never sees
 *      the password and has no field to type one into - see `SignInScreen`.
 *   3. The server sets `meridian_session`. It is `httpOnly`, so no script in
 *      the web view can read it; that is correct and is why the cookie has to
 *      travel through the platform's jar rather than through this code.
 *   4. The web view navigates off `/login`. The app closes it and calls
 *      `registerDevice()`, a plain same-origin `fetch` with
 *      `credentials: "include"`. On iOS that reaches the cookie because
 *      `NSHTTPCookieStorage` is shared once the web view is configured with
 *      `sharedCookiesEnabled`; on Android the jar is shared already.
 *   5. The server answers with the device row and the raw token **once**, and
 *      it goes straight into the keystore. The cookie's job is over.
 *
 * `sameSite: "lax"` on the session cookie is not in the way: this is a
 * same-origin POST from the app to the server that set it.
 *
 * ── THE SEAM: STEPS 1 TO 3 ARE NOT BUILT, AND CANNOT BE FROM HERE ──────────
 *
 * A web view needs `react-native-webview`, which is not a dependency of this
 * workspace, and adding it means editing `package.json` and the lockfile. So
 * the presentation of the login page is an *interface* - `WebLoginPresenter` -
 * with no implementation in the tree, and `App.tsx` passes `null`. Everything
 * downstream of the cookie is built and tested; the sign-in screen says so in
 * words a technician can act on rather than pretending to work.
 *
 * When the dependency lands, the implementation is a component that renders
 * `<WebView source={{ uri: loginUrl(baseUrl) }} sharedCookiesEnabled
 * thirdPartyCookiesEnabled />` and resolves once `onNavigationStateChange`
 * reports a URL that is no longer under `/login`. Nothing else changes.
 */

import {
  APP_VERSION_HEADER,
  DEVICE_CURRENT_PATH,
  DEVICE_REGISTER_PATH,
  DEVICE_TIME_HEADER,
  parseErrorEnvelope,
  parseRegisterResponse,
  type FieldErrorCode,
} from "../sync/protocol";
import type { DeviceRegistration, DeviceStore } from "./device-store";

/** What the technician is told to do about a failure, by the app rather than by a code. */
export type RegistrationRemedy =
  /** Try again now, or when there is signal. Nothing is wrong with the account. */
  | "retry"
  /** Sign in again on the office's page; the session was not accepted. */
  | "signIn"
  /** Only the office can fix this. Retrying will not. */
  | "callOffice";

/**
 * Registration failed.
 *
 * Carries the server's own sentence, because the server wrote those sentences
 * for this screen - "This account is not a field technician, so a device cannot
 * be registered to it" is better than anything this file could compose. The
 * code is kept for the app to branch on and is never shown.
 */
export class RegistrationError extends Error {
  constructor(
    readonly code: FieldErrorCode,
    readonly remedy: RegistrationRemedy,
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

/** What the handset tells the office about itself. All of it optional to the server. */
export interface DeviceDescription {
  /** What a coordinator will see in the workforce screen. "Sam's iPhone". */
  readonly label: string;
  /** "ios" | "android", from `Platform.OS`. */
  readonly platform: string;
  readonly appVersion: string;
  readonly osVersion: string | null;
}

/** The result of showing the office's login page in a web view. */
export interface WebLoginResult {
  /** True when the technician reached a signed-in page. */
  readonly signedIn: boolean;
  /**
   * A `Cookie` header to send explicitly, for a platform whose web view does
   * not share its jar with `fetch`. Null is the normal case and means "the
   * cookie is in the jar; just make the request".
   */
  readonly cookieHeader?: string | null;
}

/**
 * Shows `<baseUrl>/login` and resolves when the technician has a session.
 *
 * The single seam. See the header for why there is no implementation and what
 * the implementation is once `react-native-webview` is a dependency.
 */
export interface WebLoginPresenter {
  present(input: { readonly loginUrl: string }): Promise<WebLoginResult>;
}

/** The reason the sign-in screen gives when no presenter is installed. */
export const NO_WEB_LOGIN_MESSAGE =
  "This version of the app cannot show the sign-in page yet. Ask the office to finish setting up " +
  "this phone before you go out.";

export function loginUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/login`;
}

export interface RegisterInput {
  readonly baseUrl: string;
  readonly device: DeviceDescription;
  /** From `WebLoginResult`. Omitted when the platform cookie jar carries it. */
  readonly cookieHeader?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** 30 seconds, matching `FieldApiClient`, and for the captive-portal reason it gives. */
const REGISTER_TIMEOUT_MS = 30_000;

/**
 * `POST /api/field/v1/devices/register`, authenticated by the session cookie.
 *
 * Returns the registration to store. **Does not store it** - that is
 * `signInAndRegister`'s job, and keeping the two apart is what lets this be
 * tested against a fake `fetch` with no keystore in the picture.
 *
 * Note what is deliberately absent from every throw below: the response body.
 * A successful body contains the raw token, and an error path that stringifies
 * "the response" is how a token ends up in a crash report.
 */
export async function registerDevice(input: RegisterInput): Promise<DeviceRegistration> {
  const doFetch = input.fetchImpl ?? fetch;
  const now = input.now ?? Date.now;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? REGISTER_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(`${input.baseUrl}${DEVICE_REGISTER_PATH}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [APP_VERSION_HEADER]: input.device.appVersion,
        [DEVICE_TIME_HEADER]: new Date(now()).toISOString(),
        ...(input.cookieHeader ? { Cookie: input.cookieHeader } : {}),
      },
      // The cookie is ambient, in the platform jar the web view wrote to.
      credentials: "include",
      body: JSON.stringify({
        label: input.device.label,
        platform: input.device.platform,
        appVersion: input.device.appVersion,
        osVersion: input.device.osVersion,
      }),
      signal: controller.signal,
    });
  } catch {
    throw new RegistrationError(
      "unknown",
      "retry",
      "The office could not be reached. Try again where there is a signal.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const envelope = parseErrorEnvelope(await safeJson(response));
    throw new RegistrationError(envelope.code, remedyFor(envelope.code, response.status), envelope.message);
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new RegistrationError(
      "unknown",
      "callOffice",
      "The office sent an answer this version of the app could not read.",
    );
  }

  // A shape this build cannot read is a protocol failure, and it must not be
  // retried in a loop - it fails identically every time.
  let parsed;
  try {
    parsed = parseRegisterResponse(raw);
  } catch {
    throw new RegistrationError(
      "unknown",
      "callOffice",
      "The office sent an answer this version of the app could not read.",
    );
  }

  return {
    token: parsed.deviceToken.token,
    expiresAt: parsed.deviceToken.expiresAt,
    deviceId: parsed.device.id,
    technicianId: parsed.device.technicianId,
  };
}

/**
 * What a given refusal means for the person holding the phone.
 *
 * `unauthenticated` is the interesting one: it means the cookie did not arrive
 * or had already lapsed, which is a sign-in problem and not an account problem,
 * so the remedy is to sign in again rather than to ring the office.
 */
function remedyFor(code: FieldErrorCode, status: number): RegistrationRemedy {
  if (code === "unauthenticated") return "signIn";
  if (code === "not_a_technician") return "callOffice";
  if (code === "rate_limited") return "retry";
  if (status >= 500) return "retry";
  return "callOffice";
}

export interface SignInInput extends Omit<RegisterInput, "cookieHeader"> {
  readonly store: DeviceStore;
  /** Null until `react-native-webview` exists in this workspace. See the header. */
  readonly webLogin: WebLoginPresenter | null;
}

/**
 * The whole flow: show the office's login page, then register this handset.
 *
 * The store write is awaited before this returns, so a caller that sees success
 * knows the token is durable. If the keystore refuses, the registration is lost
 * and has to be repeated - which is the right failure, because the alternative
 * is an app that believes it is signed in and has nothing to present after a
 * restart. `DeviceStore.save` has already put the value in memory, so the
 * current session keeps working while the technician is told to sort the phone
 * out.
 */
export async function signInAndRegister(input: SignInInput): Promise<DeviceRegistration> {
  if (!input.webLogin) {
    throw new RegistrationError("unknown", "callOffice", NO_WEB_LOGIN_MESSAGE);
  }

  const login = await input.webLogin.present({ loginUrl: loginUrl(input.baseUrl) });
  if (!login.signedIn) {
    throw new RegistrationError("unauthenticated", "signIn", "Sign-in was not completed.");
  }

  const registration = await registerDevice({
    baseUrl: input.baseUrl,
    device: input.device,
    cookieHeader: login.cookieHeader ?? null,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.now ? { now: input.now } : {}),
  });

  await input.store.save(registration);
  return registration;
}

export interface SignOutInput {
  readonly baseUrl: string;
  readonly store: DeviceStore;
  readonly appVersion: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * `DELETE /api/field/v1/devices/current` - hand this handset back.
 *
 * ── THE LOCAL CLEAR HAPPENS WHETHER OR NOT THE CALL SUCCEEDS ───────────────
 *
 * A technician signing out is usually handing the phone to somebody else, and
 * they are often doing it in a van with no signal. Keeping the token because
 * the office could not be told would leave a live credential on a handset that
 * has changed hands, which is the failure this whole flow exists to prevent.
 *
 * The reverse order would be worse still: clearing first and then failing to
 * call leaves the row live on the server with nobody able to reach it from the
 * phone. So the call goes first, its failure is tolerated, and the clear is
 * unconditional. `revoked: false` from the office is the residue an
 * administrator can still act on from the workforce screen.
 */
export async function signOutDevice(input: SignOutInput): Promise<{ readonly toldTheOffice: boolean }> {
  const doFetch = input.fetchImpl ?? fetch;
  const token = await input.store.token();

  let toldTheOffice = false;
  if (token) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? REGISTER_TIMEOUT_MS);
    try {
      const response = await doFetch(`${input.baseUrl}${DEVICE_CURRENT_PATH}`, {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          [APP_VERSION_HEADER]: input.appVersion,
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
      toldTheOffice = response.ok;
    } catch {
      toldTheOffice = false;
    } finally {
      clearTimeout(timer);
    }
  }

  await input.store.clear();
  return { toldTheOffice };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
