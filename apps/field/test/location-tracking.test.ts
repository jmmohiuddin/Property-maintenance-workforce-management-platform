import { check, equal, deepEqual, done } from "./_harness";
import {
  isTrackableJobStatus,
  shouldBeTracking,
  trackedJob,
  isUsablePosition,
  shouldFlush,
  MAX_BUFFERED_PINGS,
  MAX_BUFFER_AGE_MS,
} from "../src/domain/location-tracking";

// ── The capture window: en_route and on_site, and nothing else ─────────────
//
// Mirrors `customer_scope` in `packages/db/sql/customer-scope.sql` and
// `currentTrackingAudience` in `packages/db/src/domain/tracking.ts`: a live
// visit is `en_route` or `arrived`, and `jobs.status` is `en_route`/`on_site`
// exactly when the visit is - see `transitionJob` in `packages/db/src/
// domain/jobs.ts`.

check("en_route is trackable", isTrackableJobStatus("en_route"));
check("on_site is trackable", isTrackableJobStatus("on_site"));
for (const other of ["dispatched", "paused", "work_complete", "triaged", "scheduled", "closed", "cancelled"]) {
  check(`${other} is NOT trackable — sampling stops the moment the visit does`, !isTrackableJobStatus(other));
}

check("no jobs at all means no tracking", !shouldBeTracking([]));
check("a dispatched-only day means no tracking — nobody has set off yet", !shouldBeTracking(["dispatched", "paused"]));
check("one en_route job is enough to start", shouldBeTracking(["dispatched", "en_route"]));
check("one on_site job is enough to start", shouldBeTracking(["on_site"]));

// ── Which job explains the banner ───────────────────────────────────────────

equal("no jobs at all: nothing tracked", trackedJob([]), null);
equal(
  "a job that is merely dispatched explains nothing",
  trackedJob([{ id: "j1", status: "dispatched", customerId: "c1" }]),
  null,
);
equal(
  "an en_route job is the tracked one",
  trackedJob([{ id: "j1", status: "en_route", customerId: "c1" }])?.id,
  "j1",
);
equal(
  "an on_site job is the tracked one too",
  trackedJob([{ id: "j1", status: "on_site", customerId: "c1" }])?.id,
  "j1",
);
equal(
  "en_route is preferred over on_site when both exist — a dispatch anomaly, per currentTrackingAudience",
  trackedJob([
    { id: "onsite-job", status: "on_site", customerId: "c1" },
    { id: "enroute-job", status: "en_route", customerId: "c2" },
  ])?.id,
  "enroute-job",
);
equal(
  "a completed job never explains the banner, even alongside a trackable one",
  trackedJob([
    { id: "done", status: "work_complete", customerId: "c1" },
    { id: "live", status: "en_route", customerId: "c2" },
  ])?.id,
  "live",
);

// ── The two rules worth a client-side copy: Null Island and NaN ────────────
//
// Deliberately not the full range check `assertPlausible`
// (`packages/db/src/domain/tracking.ts`) makes — see this module's own header
// for why duplicating more than these two would be a second copy of a rule
// with nothing real to catch.

check("a plausible fix passes", isUsablePosition(25.2048, 55.2708));
check("Null Island is refused", !isUsablePosition(0, 0));
check("a non-finite latitude is refused", !isUsablePosition(Number.NaN, 55.2708));
check("a non-finite longitude is refused", !isUsablePosition(25.2048, Number.NaN));
check("Infinity is refused", !isUsablePosition(Number.POSITIVE_INFINITY, 55.2708));
// This module does NOT duplicate the off-planet range check — a real GPS
// chip does not hand one back, so a range beyond ±90/±180 still passes here
// and is caught server-side by `assertPlausible` instead.
check("an out-of-range latitude is NOT filtered here (that rule lives server-side only)", isUsablePosition(91, 55));

// ── The buffer: full, or old enough, and never before either ───────────────

check("an empty buffer never flushes", !shouldFlush(0, null, 1_000_000));
check("an empty buffer does not flush even with an (impossible) old timestamp", !shouldFlush(0, 0, 1_000_000));
check("a buffer at the cap flushes regardless of age", shouldFlush(MAX_BUFFERED_PINGS, 999_999, 1_000_000));
check("one below the cap, freshly started, does not flush yet", !shouldFlush(MAX_BUFFERED_PINGS - 1, 999_999, 1_000_000));
check(
  "a small buffer flushes once it has waited the full age window",
  shouldFlush(1, 1_000_000 - MAX_BUFFER_AGE_MS, 1_000_000),
);
check(
  "and does not flush a moment before that window closes",
  !shouldFlush(1, 1_000_000 - MAX_BUFFER_AGE_MS + 1, 1_000_000),
);
check("a non-empty buffer with no recorded age never force-flushes on age alone", !shouldFlush(3, null, 1_000_000));

deepEqual("the buffer constants are sane relative to each other", MAX_BUFFERED_PINGS > 0 && MAX_BUFFER_AGE_MS > 0, true);

done("location-tracking");
