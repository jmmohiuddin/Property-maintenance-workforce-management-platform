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
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { SafeAreaView, StatusBar, StyleSheet, View } from "react-native";

import { theme } from "./theme";
import { JobListScreen } from "./screens/JobListScreen";
import { JobCardScreen } from "./screens/JobCardScreen";
import { SignatureScreen } from "./screens/SignatureScreen";
import { SyncStatusScreen } from "./screens/SyncStatusScreen";
import { SyncBanner } from "./components/SyncBanner";
import { createDatabase } from "../db/watermelon";
import { FieldApiClient } from "../sync/client";
import { SyncRunner, type SyncStatus } from "./sync-runner";
import { systemClock } from "../domain/clock";

type Route =
  | { readonly name: "jobs" }
  | { readonly name: "jobCard"; readonly jobId: string }
  | { readonly name: "signature"; readonly jobId: string }
  | { readonly name: "sync" };

export default function App(): JSX.Element {
  const [route, setRoute] = useState<Route>({ name: "jobs" });
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const database = useMemo(() => createDatabase(), []);

  const runner = useMemo(() => {
    const api = new FieldApiClient({
      // Not configurable in the UI yet. A real build needs this per
      // environment, and the technician needs to be able to see which server
      // they are on when something is wrong.
      baseUrl: process.env["EXPO_PUBLIC_API_BASE_URL"] ?? "",
      appVersion: "0.1.0",
      // ── DEVICE REGISTRATION IS NOT BUILT ──────────────────────────────────
      //
      // `POST /api/field/v1/devices/register` authenticates with a *web
      // session cookie* and hands back a device token exactly once. That means
      // the technician signs in through a web view, and this app stores the
      // token in `expo-secure-store` - which is declared as a dependency and
      // is not used, because none of that flow exists.
      //
      // Until it does, `getDeviceToken` returns null, every request is
      // unauthenticated, and the server answers `device_unknown`. The sync
      // banner shows "Sign in", which is the truth.
      getDeviceToken: async () => null,
      onDeviceToken: async () => {
        // Rotation would be persisted here. Dropping a rotated token strands
        // the handset once its grace window closes, so this must be wired
        // before the app talks to a real server.
      },
      clock: systemClock,
    });
    return new SyncRunner(database, api, systemClock);
  }, [database]);

  useEffect(() => {
    const unsubscribe = runner.subscribe(setStatus);
    void runner.recover();
    return unsubscribe;
  }, [runner]);

  const openJob = useCallback((jobId: string) => setRoute({ name: "jobCard", jobId }), []);
  const openSignature = useCallback((jobId: string) => setRoute({ name: "signature", jobId }), []);
  const back = useCallback(() => setRoute({ name: "jobs" }), []);

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={theme.colour.background} />
      <SyncBanner status={status} onPress={() => setRoute({ name: "sync" })} />
      <View style={styles.body}>
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
          <SignatureScreen database={database} jobId={route.jobId} onDone={back} />
        )}
        {route.name === "sync" && <SyncStatusScreen runner={runner} status={status} onBack={back} />}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colour.background },
  body: { flex: 1 },
});
