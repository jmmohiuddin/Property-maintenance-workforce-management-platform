/**
 * The application shell.
 *
 * **NOT TYPECHECKED BY THE ROOT GATE, AND NEVER RENDERED.** No simulator was
 * available in this session. This file and everything under `screens/` compile
 * only under `npm run typecheck:native` after `npm install`, and no part of
 * this UI has been run, laid out or looked at.
 *
 * ── WHY THE NAVIGATOR IS TWENTY LINES OF `useState` ────────────────────────
 *
 * React Navigation is the obvious choice and is deliberately not used. The app
 * has four screens and a strictly linear flow - list, job card, signature,
 * sync - with no deep linking, no tabs and no modal stack. A navigation
 * library would add a dependency tree, a gesture handler, a reanimated
 * peer, and native configuration on both platforms, in exchange for
 * solving a problem this app does not have yet.
 *
 * It will have that problem: push notifications on assignment (`FLD-18`) mean
 * deep linking into a job, and that is the point at which this should be
 * replaced rather than extended.
 *
 * ── SIGN-IN IS A GATE, NOT A SCREEN IN THE FLOW ────────────────────────────
 *
 * A handset with no device token cannot pull a job, cannot push a mutation and
 * cannot upload a photograph; every request comes back `device_unknown`. So it
 * is not one more route in the switch below - it replaces the body entirely
 * until there is a credential, because everything behind it is furniture.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Platform, SafeAreaView, StatusBar, StyleSheet, View } from "react-native";

import { theme } from "./theme";
import { JobListScreen } from "./screens/JobListScreen";
import { JobCardScreen } from "./screens/JobCardScreen";
import { SignatureScreen } from "./screens/SignatureScreen";
import { SignInScreen } from "./screens/SignInScreen";
import { SyncStatusScreen } from "./screens/SyncStatusScreen";
import { SyncBanner } from "./components/SyncBanner";
import { LocationSharingTracker } from "./components/LocationSharingTracker";
import { createDatabase } from "../db/watermelon";
import { FieldApiClient } from "../sync/client";
import { SyncRunner, type SyncStatus } from "./sync-runner";
import { MediaUploadRunner } from "./upload-runner";
import { systemClock } from "../domain/clock";
import { DeviceStore, expoSecureStoreBackend } from "../auth/device-store";
import { signInAndRegister, type WebLoginPresenter } from "../auth/registration";

type Route =
  | { readonly name: "jobs" }
  | { readonly name: "jobCard"; readonly jobId: string }
  | { readonly name: "signature"; readonly jobId: string }
  | { readonly name: "sync" };

const APP_VERSION = "0.1.0";

/** Not configurable in the UI yet; see the note where it is read. */
const BASE_URL = process.env["EXPO_PUBLIC_API_BASE_URL"] ?? "";

/**
 * ── THE ONE SEAM IN THE SIGN-IN FLOW ───────────────────────────────────────
 *
 * Registration is authenticated by a `meridian_session` cookie, which the
 * technician obtains by signing in on the office's own `/login` page shown in a
 * web view. That web view needs `react-native-webview`, which is not a
 * dependency of this workspace, and adding one means editing `package.json` and
 * the lockfile.
 *
 * Everything downstream of the cookie is built: `registerDevice()` makes the
 * call, `DeviceStore` keeps the token, `FieldApiClient` presents and rotates it.
 * Only the presentation of the login page is missing, so it is an interface
 * with no implementation rather than a stub that pretends. `SignInScreen` reads
 * this being null and says so in words.
 *
 * To finish it: install `react-native-webview`, and replace this with a
 * presenter that renders `<WebView source={{ uri }} sharedCookiesEnabled
 * thirdPartyCookiesEnabled />` and resolves once the technician has navigated
 * off `/login`. Nothing else in this file changes.
 */
const WEB_LOGIN: WebLoginPresenter | null = null;

export default function App(): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ name: "jobs" });
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const database = useMemo(() => createDatabase(), []);

  /**
   * The keystore-backed credential. Constructed once and shared by the API
   * client and the sign-in flow, so there is one cache of "is this phone signed
   * in" rather than two that can disagree.
   */
  const store = useMemo(() => new DeviceStore(expoSecureStoreBackend()), []);

  /** null while the keystore is still being read; a boolean once it is known. */
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  /**
   * This device's own technician id, once known - the one identity fact this
   * phone holds about who is using it. `SignatureScreen` cites it on the local
   * job sheet digest; nothing synced to the device carries a technician's
   * *name* (see that screen's header).
   */
  const [technicianId, setTechnicianId] = useState<string | null>(null);

  /**
   * One `FieldApiClient` for the life of the screen, shared by `SyncRunner`
   * (mutations and the working-set pull) and `MediaUploadRunner` (uploads).
   * Both are device-authenticated requests through the same token and the
   * same rotation handling; splitting the client would split that handling
   * too, silently, the first time the two runners disagreed about a token.
   */
  const api = useMemo(
    () =>
      new FieldApiClient({
        // Not configurable in the UI yet. A real build needs this per
        // environment, and the technician needs to be able to see which server
        // they are on when something is wrong.
        baseUrl: BASE_URL,
        appVersion: APP_VERSION,
        getDeviceToken: () => store.token(),
        // Awaited by the client before the response body reaches the caller, and
        // its failure is not caught here: a dropped rotation strands the handset
        // once the ten-minute grace closes, and the office will not offer that
        // token a second time.
        onDeviceToken: (token) => store.saveRotatedToken(token),
        // Called only for `device_revoked`, which is what
        // `DeviceAuthError.clearsStoredToken` encodes. An expired token is left
        // alone: clearing it loses nothing and gains nothing.
        clearDeviceToken: () => store.clear(),
        clock: systemClock,
      }),
    [store],
  );

  // One runner for the life of the screen. It used to be rebuilt after every
  // registration, to work around `needsSignIn` latching true for ever; the
  // runner now clears that flag when a device-authenticated request comes
  // back, so there is nothing left for a new instance to reset - and keeping
  // the old one keeps the outbox recovery it has already done.
  const runner = useMemo(() => new SyncRunner(database, api, systemClock), [database, api]);

  /**
   * The media queue: turns a captured-but-unsent photo or signature into an
   * `uploadId` and files the mutation it unlocks. See that file's header for
   * why it is a separate runner from `SyncRunner` rather than a step inside
   * `drain()`.
   */
  const uploadRunner = useMemo(() => new MediaUploadRunner(database, api, systemClock), [database, api]);

  useEffect(() => {
    const unsubscribe = runner.subscribe(setStatus);
    // Recovery first, and it is an ordering rather than a preference: rows the
    // operating system left `inflight` go back to `pending` before anything
    // else looks at the queue, so a pull that evicts an out-of-scope job can
    // see that the job still has unsynced work and refuse to drop it.
    //
    // The upload runner follows the first pull/drain, not before it: a photo
    // or signature captured before this device has ever registered has
    // nowhere to upload to, and `MediaUploadRunner.run()` fails each item
    // individually and logs rather than blocking - so running it here costs
    // nothing when there is nothing queued, which is the common case.
    void runner
      .recover()
      .then(() => runner.pull())
      .then(() => uploadRunner.run());
  }, [runner, uploadRunner]);

  // Read the credential once at startup. A keystore that refuses to be read is
  // reported as "not registered", which is true in the only sense that matters:
  // this app has no token it can present.
  useEffect(() => {
    let cancelled = false;
    store
      .read()
      .then((registration) => {
        if (cancelled) return;
        setRegistered(registration !== null);
        setTechnicianId(registration?.technicianId ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setRegistered(false);
        setSignInError("This phone's protected storage could not be read. Restart the phone and try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [store]);

  // A 401 may have destroyed the stored token - `client.ts` clears it when the
  // office says the device is revoked. Re-read rather than assume, so the
  // sign-in screen can tell "never registered" from "signed out".
  const needsSignIn = status?.needsSignIn === true;
  useEffect(() => {
    if (!needsSignIn) return;
    let cancelled = false;
    store
      .read()
      .then((registration) => {
        if (cancelled) return;
        setRegistered(registration !== null);
        setTechnicianId(registration?.technicianId ?? null);
      })
      .catch(() => {
        if (!cancelled) setRegistered(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsSignIn, store]);

  const signIn = useCallback(async () => {
    setSigningIn(true);
    setSignInError(null);
    try {
      await signInAndRegister({
        baseUrl: BASE_URL,
        store,
        webLogin: WEB_LOGIN,
        device: {
          // Left empty on purpose: the office names the device after the
          // technician whose session registered it, and the server knows their
          // name where this app does not.
          label: "",
          platform: Platform.OS,
          appVersion: APP_VERSION,
          osVersion: String(Platform.Version),
        },
      });
      setRegistered(true);
      const registration = await store.read();
      setTechnicianId(registration?.technicianId ?? null);
      setRoute({ name: "jobs" });
      // Nothing to reset on the runner: its next pull or push clears the
      // signed-out flag by succeeding, which is the only proof worth taking.
      void runner.pull().then(() => uploadRunner.run());
    } catch (error) {
      // Whatever sentence the server or the flow wrote. Never a code, and
      // never the response body - which on the success path holds the token.
      setSignInError(
        error instanceof Error ? error.message : "This phone could not be signed in. Try again.",
      );
    } finally {
      setSigningIn(false);
    }
  }, [runner, uploadRunner, store]);

  const openJob = useCallback((jobId: string) => setRoute({ name: "jobCard", jobId }), []);
  const openSignature = useCallback((jobId: string) => setRoute({ name: "signature", jobId }), []);
  const back = useCallback(() => setRoute({ name: "jobs" }), []);

  // Still reading the keystore: show the shell, and nothing that would flash a
  // sign-in prompt at a technician who is in fact signed in.
  const gateOpen = registered === true && !needsSignIn;

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colour.background} />
      <SyncBanner status={status} onPress={() => setRoute({ name: "sync" })} />
      {/* `FLD-16`: mounted once, alongside the route switch rather than
          inside one screen - the capture window it drives does not care
          which screen is on top, only which job is `en_route`/`on_site`. */}
      {gateOpen ? <LocationSharingTracker database={database} /> : null}
      <View style={styles.body}>
        {registered === null ? null : !gateOpen ? (
          <SignInScreen
            reason={needsSignIn ? "signedOut" : "notRegistered"}
            canSignIn={WEB_LOGIN !== null}
            busy={signingIn}
            error={signInError}
            onSignIn={() => void signIn()}
          />
        ) : (
          <>
            {route.name === "jobs" && (
              <JobListScreen database={database} onOpenJob={openJob} />
            )}
            {route.name === "jobCard" && (
              <JobCardScreen
                database={database}
                jobId={route.jobId}
                onBack={back}
                onSign={() => openSignature(route.jobId)}
              />
            )}
            {route.name === "signature" && (
              <SignatureScreen
                database={database}
                jobId={route.jobId}
                technicianId={technicianId}
                onDone={back}
              />
            )}
            {route.name === "sync" && (
              <SyncStatusScreen runner={runner} status={status} onBack={back} />
            )}
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colour.background },
  body: { flex: 1 },
});
