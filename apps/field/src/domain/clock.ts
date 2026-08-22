/**
 * Device clocks are wrong.
 *
 * ADR 0004: *"Every offline-captured record carries both the device timestamp
 * (`recorded_offline_at`) and the server receipt time, and reports use the
 * server time."* TRD §8.5: *"`server_time` in the sync response exists so the
 * device can detect and report clock divergence rather than silently recording
 * a wrong timestamp."*
 *
 * Both halves matter and they solve different problems.
 *
 *   The device timestamp is the only evidence that exists for *when* something
 *   happened in a basement with no signal. Discarding it and using the receipt
 *   time would say a job that finished at 11:40 finished at 18:05, when the
 *   technician got back to the van.
 *
 *   The server receipt time is the only timestamp an adversarial party cannot
 *   set. A technician who moves the device clock back two hours to hide a late
 *   arrival changes `recorded_offline_at` and cannot change the receipt time,
 *   and the gap between them is exactly the signal that says so.
 *
 * So: record both, report on the server one, and surface the divergence. This
 * module owns the third of those. It does not decide anything - the server is
 * authoritative about its own time - it measures, classifies and hands the
 * number to the sync-status screen.
 *
 * ── WHY THERE IS A MONOTONIC CLOCK AS WELL ─────────────────────────────────
 *
 * Wall-clock time is not usable for *ordering*. A technician who changes the
 * device time mid-shift, or an NTP step, makes `Date.now()` go backwards, and
 * an outbox ordered by a clock that goes backwards sends a job completion
 * before the arrival event it follows. Every captured record therefore also
 * carries a monotonic reading taken from process uptime, which is unaffected
 * by clock changes and is only ever compared within one app run.
 */

export interface ClockSources {
  /** Wall-clock milliseconds since epoch, as the device believes them. */
  readonly now: () => number;
  /**
   * Milliseconds since some arbitrary fixed point, guaranteed non-decreasing.
   * `performance.now()` on React Native; injectable so tests can drive it.
   */
  readonly monotonic: () => number;
}

export const systemClock: ClockSources = {
  now: () => Date.now(),
  monotonic: () =>
    typeof (globalThis as { performance?: { now?: () => number } }).performance?.now === "function"
      ? (globalThis as { performance: { now: () => number } }).performance.now()
      : // No performance.now: fall back to the wall clock. Ordering degrades to
        // whatever the wall clock does, which is the situation this exists to
        // avoid - so `monotonicIsReal` reports it rather than pretending.
        Date.now(),
};

export function monotonicIsReal(): boolean {
  return typeof (globalThis as { performance?: { now?: () => number } }).performance?.now === "function";
}

/** How far out the device clock is, and how much that matters. */
export type SkewSeverity = "aligned" | "minor" | "significant" | "unusable";

/**
 * Thresholds, and why these numbers.
 *
 *   30s   Below this is ordinary un-synced drift on a phone. Nothing to say.
 *   5m    Enough to move an arrival either side of an SLA boundary. Worth
 *         telling the technician, and worth flagging on the record.
 *   1h    Almost always a manually changed clock or a wrong time zone offset
 *         applied to a UTC field. The device timestamp is no longer evidence
 *         of anything and the office needs to know before it reads a report.
 *
 * These are a judgement, not a standard. They are the numbers most worth
 * tuning once real devices report real skew.
 */
export const SKEW_MINOR_MS = 30_000;
export const SKEW_SIGNIFICANT_MS = 5 * 60_000;
export const SKEW_UNUSABLE_MS = 60 * 60_000;

export function skewSeverity(offsetMs: number): SkewSeverity {
  const abs = Math.abs(offsetMs);
  if (abs < SKEW_MINOR_MS) return "aligned";
  if (abs < SKEW_SIGNIFICANT_MS) return "minor";
  if (abs < SKEW_UNUSABLE_MS) return "significant";
  return "unusable";
}

export interface SkewObservation {
  /** Server time minus device time, in milliseconds. Positive: device is slow. */
  readonly offsetMs: number;
  readonly severity: SkewSeverity;
  /** Round-trip of the request the reading came from; the offset's error bar. */
  readonly roundTripMs: number;
  /** Device wall-clock time at which this was observed. */
  readonly observedAtDevice: number;
}

/**
 * Estimate the device's offset from a sync response.
 *
 * The estimate assumes a symmetric round trip - the request took half the
 * elapsed time to reach the server - which is the same assumption SNTP makes
 * and is wrong by up to half the round trip on an asymmetric link. That error
 * is carried in `roundTripMs` rather than being smoothed away, because a
 * 200-millisecond uncertainty is irrelevant against a 30-second threshold and
 * an 8-second round trip on a bad cell link genuinely is worth doubting.
 *
 * There is no filtering or averaging across readings. It would be easy to add
 * and would be guessing: the app takes one reading per sync, syncs are hours
 * apart in the field, and a median of six readings from six different network
 * conditions is not more truthful than the last one.
 */
export function observeSkew(input: {
  readonly requestSentAtDevice: number;
  readonly responseReceivedAtDevice: number;
  readonly serverTime: number;
}): SkewObservation {
  const roundTripMs = Math.max(0, input.responseReceivedAtDevice - input.requestSentAtDevice);
  const deviceMidpoint = input.requestSentAtDevice + roundTripMs / 2;
  const offsetMs = Math.round(input.serverTime - deviceMidpoint);
  return {
    offsetMs,
    severity: skewSeverity(offsetMs),
    roundTripMs,
    observedAtDevice: input.responseReceivedAtDevice,
  };
}

/**
 * The timestamp block every offline-captured record carries.
 *
 * `serverReceivedAt` is null until the server tells us, and it is null in the
 * type rather than defaulted to the device time. A default would be a lie with
 * the same shape as the truth, and every report that reads it would silently
 * be reading a device clock while believing it was reading the server's.
 */
export interface OfflineStamp {
  /** `recorded_offline_at` - the device's own belief about when this happened. */
  readonly recordedOfflineAt: string;
  /** Monotonic reading, for ordering within this app run only. Never persisted upstream. */
  readonly monotonicAt: number;
  /** The skew known at capture time, so a record can be judged later. */
  readonly deviceOffsetMsAtCapture: number | null;
  /** Set from the mutation response. Null until the server has seen the record. */
  readonly serverReceivedAt: string | null;
}

export function stampOffline(
  clock: ClockSources,
  lastKnownOffsetMs: number | null,
): OfflineStamp {
  return {
    recordedOfflineAt: new Date(clock.now()).toISOString(),
    monotonicAt: clock.monotonic(),
    deviceOffsetMsAtCapture: lastKnownOffsetMs,
    serverReceivedAt: null,
  };
}

/**
 * The timestamp a report should use, and an honest answer when there isn't one.
 *
 * Never silently falls back to the device time. A caller that gets `null` has
 * a record the server has not acknowledged, and the correct thing to render is
 * "not yet synced", not a plausible-looking time.
 */
export function authoritativeTime(stamp: OfflineStamp): string | null {
  return stamp.serverReceivedAt;
}

/**
 * The device time corrected by the last known offset - a *best estimate*, and
 * named so. Used for display ("arrived 11:40") while a record is still queued,
 * where showing nothing would be worse than showing an estimate. Not used for
 * anything that is stored, compared against an SLA, or shown to a customer.
 */
export function estimatedTrueTime(stamp: OfflineStamp): string {
  const offset = stamp.deviceOffsetMsAtCapture ?? 0;
  return new Date(Date.parse(stamp.recordedOfflineAt) + offset).toISOString();
}
