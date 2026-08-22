/**
 * `FLD-16`'s device-side capture: what the phone does with the capture
 * window `domain/location-tracking.ts` computes, and how it tells the
 * technician about it. Mounted once, at the top of `App.tsx`, alongside the
 * route switch rather than inside one screen — the whole point of the
 * capture window is that it does not care which screen is on top.
 *
 * NOT RENDERED IN THIS SESSION, same as every screen under `screens/` - see
 * the note at the top of `App.tsx`. It compiles under
 * `npm run typecheck:native`; nothing about `expo-location`'s actual runtime
 * behaviour — permission prompts, fix latency, how iOS treats
 * `watchPositionAsync` once the app backgrounds — has been exercised against
 * real hardware.
 *
 * ── FOREGROUND, NOT BACKGROUND — A DECISION, NOT A GAP ──────────────────────
 *
 * `watchPositionAsync` runs here under FOREGROUND permission only
 * (`requestForegroundPermissionsAsync`, the same call `AttendanceBar` made
 * tonight for a one-shot fix). Both iOS and Android pause foreground location
 * updates the instant this app is backgrounded or the screen locks, so a
 * technician who locks their phone mid-drive stops updating the customer's
 * board until they reopen the app.
 *
 * Background tracking is not a bigger version of this, it is a different ask:
 * `requestBackgroundPermissionsAsync`, an Info.plist / manifest declaration,
 * a persistent Android foreground-service notification a technician cannot
 * dismiss without stopping tracking, and an App Store / Play Console review
 * justification for continuous background location. None of that is a change
 * this session can make responsibly with no reviewer, no store listing, and
 * no device to confirm the OS actually grants it — so it is not built here.
 * The foreground half is built properly and stops there; the gap is real,
 * named, and the owner's to decide on, not silently patched over with a
 * permission request this session cannot see the consequences of.
 *
 * ── THE TECHNICIAN MUST KNOW ─────────────────────────────────────────────
 *
 * `recordTechnicianPing` (`packages/db/src/domain/tracking.ts`) hands back
 * `sharedWithCustomer` on every accepted batch, so the office can prove after
 * the fact who was told what. This banner does not wait for that round trip
 * to say something, though: a technician should not need a successful sync
 * before being told they are being watched. It shows the same fact the
 * capture window itself is built on (`trackedJob`, `domain/
 * location-tracking.ts`) — while any job is `en_route` or `on_site`, sharing
 * IS happening, because that is exactly the condition `customer_scope` reads.
 * The one thing this banner cannot know ahead of the network is the
 * customer's name with total certainty; it reads it from the already-synced
 * `customers` table by the tracked job's `customerId`, the same data the job
 * card itself trusts.
 */

import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Database } from "@nozbe/watermelondb";
import * as Location from "expo-location";

import { theme } from "../theme";
import type { Job, Customer } from "../../db/models";
import { queueMutationOnly } from "../../db/watermelon";
import { appendLocationPings, type LocationPingInput } from "../../sync/payloads";
import { systemClock, stampOffline } from "../../domain/clock";
import { newClientId } from "../../domain/ids";
import { trackedJob, isUsablePosition, shouldFlush } from "../../domain/location-tracking";

/** Balanced accuracy: `FLD-16` shows a road position, not a lane. Cheaper on battery than `High`/`Highest`. */
const WATCH_ACCURACY = Location.Accuracy.Balanced;
/** Neither purely time- nor purely distance-driven — whichever fires first wakes the callback. */
const WATCH_TIME_INTERVAL_MS = 20_000;
const WATCH_DISTANCE_INTERVAL_M = 30;
/** How often the buffer is checked against `shouldFlush`'s age rule, not how often it actually flushes. */
const FLUSH_CHECK_INTERVAL_MS = 15_000;

export function LocationSharingTracker({ database }: { database: Database }): React.JSX.Element | null {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [customers, setCustomers] = useState<readonly Customer[]>([]);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const bufferRef = useRef<LocationPingInput[]>([]);
  const oldestBufferedMonotonicRef = useRef<number | null>(null);
  const watchRef = useRef<Awaited<ReturnType<typeof Location.watchPositionAsync>> | null>(null);
  const watchingRef = useRef(false);

  useEffect(() => {
    const subscriptions = [
      database.get<Job>("jobs").query().observe().subscribe(setJobs),
      database.get<Customer>("customers").query().observe().subscribe(setCustomers),
    ];
    return () => subscriptions.forEach((s) => s.unsubscribe());
  }, [database]);

  // The single job explaining why a position is being sampled right now, or
  // null when nothing is - see `trackedJob`'s own header for why this is an
  // approximation of the server's tie-break rather than a copy of it.
  const active = jobs
    ? trackedJob(jobs.map((j) => ({ id: j.id, status: j.status, customerId: j.customerId })))
    : null;

  /** Empty the buffer into one outbox mutation. Never awaits the network - `queueMutationOnly` only touches SQLite. */
  async function flush(): Promise<void> {
    const pending = bufferRef.current;
    if (pending.length === 0) return;
    bufferRef.current = [];
    oldestBufferedMonotonicRef.current = null;
    try {
      const spec = appendLocationPings(pending);
      const stamp = stampOffline(systemClock, null);
      await queueMutationOnly(database, {
        clientId: newClientId(),
        entity: spec.entity,
        op: spec.op,
        jobId: spec.jobId,
        payload: spec.payload,
        baseVersion: spec.baseVersion,
        dependsOnClientId: spec.dependsOnClientId,
        createdAt: stamp.recordedOfflineAt,
        createdMonotonic: stamp.monotonicAt,
      });
    } catch (error) {
      // A local SQLite write failing here is a device-storage problem, not a
      // network one. There is no per-ping control to surface it on, and the
      // positions are already gone rather than re-queued (re-buffering a
      // failed flush risks growing without bound if the write keeps
      // failing) - logged for the office to notice in aggregate, same as
      // `MediaUploadRunner`'s own per-item failures.
      console.warn("[field] a batch of positions could not be queued", error);
    }
  }

  // Start or stop the watch as the capture window opens and closes. Reruns on
  // every status change of the tracked job, but `watchingRef` makes that a
  // no-op while a watch is already live - en_route -> on_site must not
  // restart the GPS subscription, only en_route/on_site -> anything-else may
  // stop it.
  useEffect(() => {
    let cancelled = false;

    async function startWatching(): Promise<void> {
      if (watchingRef.current) return;
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (permission.status === Location.PermissionStatus.UNDETERMINED) {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (!permission.granted) {
          if (!cancelled) setPermissionDenied(true);
          return;
        }
        if (!cancelled) setPermissionDenied(false);

        watchingRef.current = true;
        watchRef.current = await Location.watchPositionAsync(
          { accuracy: WATCH_ACCURACY, timeInterval: WATCH_TIME_INTERVAL_MS, distanceInterval: WATCH_DISTANCE_INTERVAL_M },
          (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            // Filtered here, not merely at the server: a cold fix or a
            // permission race handing back Null Island must not poison a
            // batch of otherwise-good pings when it is flushed.
            if (!isUsablePosition(lat, lng)) return;

            const heading = position.coords.heading;
            const speed = position.coords.speed;
            const now = systemClock.monotonic();
            if (bufferRef.current.length === 0) oldestBufferedMonotonicRef.current = now;
            bufferRef.current = [
              ...bufferRef.current,
              {
                lat,
                lng,
                headingDegrees: heading !== null && Number.isFinite(heading) ? Math.round(heading) : null,
                // m/s -> km/h, matching `recordTechnicianPing`'s column.
                speedKph: speed !== null && Number.isFinite(speed) && speed >= 0 ? Math.round(speed * 3.6) : null,
                // `expo-location` does not report battery; that column stays
                // null from this producer rather than a guessed value.
                batteryPercent: null,
                recordedAt: new Date(systemClock.now()).toISOString(),
              },
            ];

            if (shouldFlush(bufferRef.current.length, oldestBufferedMonotonicRef.current, systemClock.monotonic())) {
              void flush();
            }
          },
        );
      } catch (error) {
        console.warn("[field] location watch could not start", error);
      }
    }

    function stopWatching(): void {
      watchingRef.current = false;
      watchRef.current?.remove();
      watchRef.current = null;
      void flush();
    }

    if (active) void startWatching();
    else stopWatching();

    return () => {
      cancelled = true;
    };
    // `flush` closes over `bufferRef`/`database`, both stable across renders;
    // omitted deliberately, the way `AttendanceBar` omits its own stable
    // closures from its effect list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.status]);

  // A time-boxed flush independent of new fixes arriving - `shouldFlush`'s own
  // age branch has nothing to trigger it from a stationary technician, who
  // produces no new `watchPositionAsync` callbacks at all.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (shouldFlush(bufferRef.current.length, oldestBufferedMonotonicRef.current, systemClock.monotonic())) {
        void flush();
      }
    }, FLUSH_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  // Whatever is buffered when this component itself unmounts (the app is
  // being torn down) is still worth sending rather than silently dropped.
  useEffect(() => {
    return () => {
      void flush();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!active) return null;

  const customerName = customers.find((c) => c.id === active.customerId)?.name ?? null;

  return (
    <View style={styles.bar}>
      <Text style={styles.text}>
        {permissionDenied
          ? "Location is off — your live position is not being shared with the customer."
          : customerName
            ? `Sharing your live location with ${customerName}`
            : "Sharing your live location with the customer"}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.xs,
    backgroundColor: theme.colour.surfaceRaised,
  },
  text: { color: theme.colour.textMuted, fontSize: theme.font.small },
});
