import { check, equal, done } from "./_harness";
import {
  observeSkew,
  skewSeverity,
  stampOffline,
  authoritativeTime,
  estimatedTrueTime,
  type ClockSources,
} from "../src/domain/clock";

equal("no skew is aligned", skewSeverity(0), "aligned");
equal("29 seconds is still aligned", skewSeverity(29_000), "aligned");
equal("a minute out is minor", skewSeverity(60_000), "minor");
equal("ten minutes out is significant", skewSeverity(10 * 60_000), "significant");
equal("two hours out is unusable", skewSeverity(2 * 60 * 60_000), "unusable");
equal("skew is judged on magnitude, not direction", skewSeverity(-2 * 60 * 60_000), "unusable");

// A device running two hours slow, on a 200ms round trip.
const observed = observeSkew({
  requestSentAtDevice: 1_000_000,
  responseReceivedAtDevice: 1_000_200,
  serverTime: 1_000_100 + 2 * 60 * 60_000,
});
equal("the offset is measured from the round-trip midpoint", observed.offsetMs, 2 * 60 * 60_000);
equal("the round trip is carried as the error bar", observed.roundTripMs, 200);
equal("a two-hour offset is unusable", observed.severity, "unusable");

// The estimate must not be smoothed across readings: one call, one answer.
const second = observeSkew({
  requestSentAtDevice: 2_000_000,
  responseReceivedAtDevice: 2_000_010,
  serverTime: 2_000_005,
});
equal("a subsequent aligned reading is not dragged by the previous one", second.severity, "aligned");

// ── The two-clock discipline ────────────────────────────────────────────────

let monotonic = 500;
const clock: ClockSources = { now: () => 1_700_000_000_000, monotonic: () => monotonic };

const stamp = stampOffline(clock, 2 * 60 * 60_000);
equal("the device timestamp is recorded", stamp.recordedOfflineAt, "2023-11-14T22:13:20.000Z");
equal("the server receipt time starts null, never defaulted", stamp.serverReceivedAt, null);
equal("the skew known at capture is carried with the record", stamp.deviceOffsetMsAtCapture, 2 * 60 * 60_000);
equal("a monotonic reading is taken for ordering", stamp.monotonicAt, 500);

equal("an unsynced record has no authoritative time", authoritativeTime(stamp), null);
equal(
  "the estimate corrects the device time by the known offset",
  estimatedTrueTime(stamp),
  "2023-11-15T00:13:20.000Z",
);

const acknowledged = { ...stamp, serverReceivedAt: "2023-11-15T00:20:00.000Z" };
equal(
  "once acknowledged, the authoritative time is the server's",
  authoritativeTime(acknowledged),
  "2023-11-15T00:20:00.000Z",
);

monotonic = 900;
const later = stampOffline(clock, null);
check("a later capture has a later monotonic reading despite an identical wall clock",
  later.monotonicAt > stamp.monotonicAt);
equal("the two wall clocks are identical", later.recordedOfflineAt, stamp.recordedOfflineAt);

done("clock");
