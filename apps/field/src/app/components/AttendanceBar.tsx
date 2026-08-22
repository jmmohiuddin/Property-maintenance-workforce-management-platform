/**
 * `TECH-8`: geofenced clock-in / clock-out, at the top of "My jobs" - the
 * screen a technician opens first thing and last thing in a shift, and the
 * only screen this app has that is not scoped to one job. Attendance is a
 * day-level fact (`domain/shift-clock.ts`), not a per-job one, so it does not
 * belong on `JobCardScreen` the way a photograph or a material line does.
 *
 * ── OFFLINE-FIRST, THE SAME WAY EVERY OTHER CAPTURE HERE IS ────────────────
 *
 * This follows `JobCardScreen.submitMaterial`'s shape exactly: build the
 * `MutationSpec` (`appendAttendance`), stamp it (`stampOffline`), and write
 * the domain row and the outbox row in one `writeWithOutbox` transaction.
 * Nothing here awaits the network - the button responds the instant the local
 * write commits, whether or not this phone has signal.
 *
 * ── LOCATION IS BEST-EFFORT, AND REFUSAL DOES NOT BLOCK THE BUTTON ─────────
 *
 * `captureClockLocation` never throws and never leaves the technician
 * waiting indefinitely on a GPS fix that may never arrive in a basement: it
 * resolves within `LOCATION_FIX_TIMEOUT_MS` no matter what the OS does, and a
 * refused or undetermined permission is read as "no position", not as an
 * error. Every one of its outcomes still lets `clockAction` proceed to the
 * write - `lat`/`lng`/`accuracyMetres` and `withinGeofence` are simply absent
 * or `null`. A technician who has declined location, or is standing where
 * there is no fix, can still clock in.
 *
 * This differs from `CameraCaptureScreen`'s own `bestEffortLocation`, which
 * only reads whatever permission state already exists and never prompts.
 * That is right for a photograph, where the geotag is an incidental bonus
 * field nothing depends on. Here location *is* the feature `TECH-8` names, so
 * this control requests permission once if it has never been decided - still
 * only ever a request, never a requirement: every branch below still writes
 * the clock event.
 *
 * No background or continuous tracking of any kind happens here or anywhere
 * this file reaches: one `getCurrentPositionAsync` call, at the moment of the
 * event, and nothing is read again until the next button press.
 *
 * NOT RENDERED IN THIS SESSION - see the note at the top of `App.tsx`. It
 * compiles under `npm run typecheck:native`; nothing about its layout or its
 * behaviour on a real device has been seen, and `expo-location`'s actual
 * runtime behaviour (permission prompts, fix latency, accuracy) has not been
 * exercised against real hardware.
 */

import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import { Q } from "@nozbe/watermelondb";
import * as Location from "expo-location";

import { theme } from "../theme";
import type { AttendanceEvent, Property } from "../../db/models";
import { writeWithOutbox, type OutboxWrite } from "../../db/watermelon";
import { appendAttendance } from "../../sync/payloads";
import { systemClock, stampOffline } from "../../domain/clock";
import { newClientId } from "../../domain/ids";
import { evaluateGeofence, type GeofencePoint } from "../../domain/geofence";
import {
  SHIFT_CLOCK_LABEL,
  isShiftClockKind,
  nextShiftClockActions,
  type ShiftClockKind,
} from "../../domain/shift-clock";

/**
 * A GPS fix can hang indefinitely with no signal. This is a device-local
 * wait, never a network one, but `TECH-8`'s own requirement is that a
 * technician must not be stuck on this screen because a fix is slow to
 * arrive - so it is bounded, and the bound is a judgement call with nothing
 * to measure it against yet.
 */
const LOCATION_FIX_TIMEOUT_MS = 8_000;

type ClockLocationResult =
  | { readonly status: "captured"; readonly point: GeofencePoint; readonly accuracyMetres: number | null }
  | { readonly status: "unavailable" };

async function captureClockLocation(): Promise<ClockLocationResult> {
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (permission.status === Location.PermissionStatus.UNDETERMINED) {
      permission = await Location.requestForegroundPermissionsAsync();
    }
    if (!permission.granted) return { status: "unavailable" };

    const position = await Promise.race([
      Location.getCurrentPositionAsync({}),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATION_FIX_TIMEOUT_MS)),
    ]);
    if (!position) return { status: "unavailable" };

    return {
      status: "captured",
      point: { lat: position.coords.latitude, lng: position.coords.longitude },
      accuracyMetres: position.coords.accuracy ?? null,
    };
  } catch {
    // Any native failure (location services off, a denied prompt, a driver
    // error) is read the same way as "no fix": the clock event still goes
    // through, without coordinates.
    return { status: "unavailable" };
  }
}

export function AttendanceBar({ database }: { database: Database }): React.JSX.Element {
  const [lastKind, setLastKind] = useState<ShiftClockKind | null | undefined>(undefined);
  const [busy, setBusy] = useState<ShiftClockKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The most recent shift-clock event, by the device's own ordering
    // (`monotonic_at` - never `recorded_offline_at`; see `clock.ts`'s header
    // on why wall-clock time cannot be trusted for ordering). Observable, so
    // a clock action taken here is reflected the instant it commits, with no
    // re-fetch.
    const subscription = database
      .get<AttendanceEvent>("attendance_events")
      .query(Q.sortBy("monotonic_at", Q.desc), Q.take(1))
      .observe()
      .subscribe((rows) => {
        const kind = rows[0]?.kind;
        setLastKind(kind && isShiftClockKind(kind) ? kind : null);
      });
    return () => subscription.unsubscribe();
  }, [database]);

  // undefined: the query has not returned yet. Render nothing rather than a
  // flash of the wrong button.
  if (lastKind === undefined) return <View style={styles.bar} />;

  const actions = nextShiftClockActions(lastKind);

  async function clockAction(kind: ShiftClockKind): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      const location = await captureClockLocation();
      const point = location.status === "captured" ? location.point : null;
      const accuracyMetres = location.status === "captured" ? location.accuracyMetres : null;

      // Today's working-set properties are the only site this shift's clock
      // has to compare against - see `domain/geofence.ts`'s header for why
      // there is no single "the" property for a day-level event.
      const properties = await database.get<Property>("properties").query().fetch();
      const withinGeofence = evaluateGeofence(
        point,
        properties.map((p) => ({ lat: p.lat ?? null, lng: p.lng ?? null })),
      );

      const stamp = stampOffline(systemClock, null);
      const spec = appendAttendance({
        kind,
        occurredAt: stamp.recordedOfflineAt,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        accuracyMetres,
        withinGeofence,
      });

      const outbox: OutboxWrite = {
        clientId: newClientId(),
        entity: spec.entity,
        op: spec.op,
        jobId: spec.jobId,
        payload: spec.payload,
        baseVersion: spec.baseVersion,
        dependsOnClientId: spec.dependsOnClientId,
        createdAt: stamp.recordedOfflineAt,
        createdMonotonic: stamp.monotonicAt,
      };

      await writeWithOutbox<AttendanceEvent>(database, "attendance_events", outbox, (draft) => {
        draft.kind = kind;
        draft.recordedOfflineAt = new Date(stamp.recordedOfflineAt);
        draft.deviceOffsetMsAtCapture = stamp.deviceOffsetMsAtCapture ?? undefined;
        draft.monotonicAt = stamp.monotonicAt;
        draft.lat = point?.lat ?? undefined;
        draft.lng = point?.lng ?? undefined;
        draft.accuracyMetres = accuracyMetres ?? undefined;
        draft.withinGeofence = withinGeofence ?? undefined;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That could not be recorded on this phone.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={styles.bar}>
      <Text style={styles.status}>{statusLine(lastKind)}</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.actions}>
        {actions.map((kind) => (
          <Pressable
            key={kind}
            onPress={() => void clockAction(kind)}
            disabled={busy !== null}
            style={[styles.button, kind === "shift_in" || kind === "break_end" ? styles.buttonPrimary : styles.buttonSecondary]}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>{busy === kind ? "Saving…" : SHIFT_CLOCK_LABEL[kind]}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function statusLine(lastKind: ShiftClockKind | null): string {
  switch (lastKind) {
    case null:
      return "Not clocked in";
    case "shift_in":
      return "Clocked in";
    case "break_start":
      return "On break";
    case "break_end":
      return "Clocked in";
    case "shift_out":
      return "Clocked out";
  }
}

const styles = StyleSheet.create({
  bar: {
    padding: theme.space.md,
    backgroundColor: theme.colour.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colour.border,
  },
  status: { color: theme.colour.text, fontSize: theme.font.body, marginBottom: theme.space.sm },
  error: { color: theme.colour.danger, fontSize: theme.font.small, marginBottom: theme.space.sm },
  actions: { flexDirection: "row", gap: theme.space.sm },
  button: {
    flex: 1,
    minHeight: theme.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonPrimary: { backgroundColor: theme.colour.accent },
  buttonSecondary: { backgroundColor: theme.colour.surfaceRaised },
  buttonText: { color: theme.colour.text, fontSize: theme.font.body, fontWeight: "700" },
});
