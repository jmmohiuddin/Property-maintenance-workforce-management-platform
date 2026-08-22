"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * `CUST-3` / `EMG-5`. The panel that says where the technician is.
 *
 * ── WHY THIS IS A CLIENT COMPONENT AT ALL ───────────────────────────────────
 *
 * Only for two things, and both of them are about not lying:
 *
 *   1. It re-fetches the page every thirty seconds. A screen labelled "live"
 *      that is a snapshot from when the page loaded is worse than no screen —
 *      a customer refreshes, sees the same distance, and concludes nobody is
 *      moving. The refresh is a `router.refresh()`, so the server component
 *      re-runs `getPortalLiveTracking` inside `withCustomerScope` and every
 *      boundary is re-evaluated on every tick. Nothing is cached client-side,
 *      and the moment the visit completes the next tick returns nothing.
 *
 *   2. It renders the age of the position relative to the reader's own clock.
 *      "Updated 40 seconds ago" is the sentence that makes a stale reading
 *      obvious, and it is only true if it is computed in the reader's browser.
 *
 * Everything else — the distance, the ETA, whether either may be shown at all —
 * was decided on the server. This component cannot widen anything: it is handed
 * numbers or nulls, and a null here is a null the projection chose.
 *
 * The refresh interval is thirty seconds and not three. A person waiting for a
 * plumber checks their phone every few minutes; a two-second feed serves the
 * watching, not the waiting, and it is the difference between an arrival
 * estimate and a tail.
 */
const REFRESH_MS = 30_000;

export interface LiveTrackingPanelProps {
  readonly state: "travelling" | "on_site";
  readonly technicianName: string;
  readonly enRouteAt: string;
  readonly distanceKm: number | null;
  readonly etaMinutes: number | null;
  readonly lastSeenAt: string | null;
  readonly stale: boolean;
}

function relativeAge(from: Date, now: number): string {
  const seconds = Math.max(0, Math.round((now - from.getTime()) / 1000));
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

export function LiveTrackingPanel(props: LiveTrackingPanelProps) {
  const router = useRouter();
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    // Set on mount rather than at render: reading the clock during render makes
    // the server and client markup disagree, and React replaces the whole
    // subtree. Null until then, and the age simply is not shown for one frame.
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const refresh = setInterval(() => router.refresh(), REFRESH_MS);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [router]);

  const lastSeenAt = props.lastSeenAt ? new Date(props.lastSeenAt) : null;
  const enRouteAt = new Date(props.enRouteAt);

  const headline =
    props.state === "on_site"
      ? `${props.technicianName} is at your property`
      : `${props.technicianName} is on the way`;

  /**
   * The four sentences, and each is true of exactly one situation.
   *
   * The temptation is one sentence with the numbers dropped out when they are
   * missing, which produces "is on the way, away, arriving in" on a bad signal.
   * A missing ETA is not a formatting problem, it is a different thing to say.
   */
  const detail = (() => {
    if (props.state === "on_site") {
      return "They arrived and are working now. We stop sharing their location once they are with you.";
    }
    if (props.stale) {
      return "We have lost contact with their phone — a basement or a tunnel usually does it. They are still on their way.";
    }
    if (props.etaMinutes !== null && props.distanceKm !== null) {
      return `About ${props.distanceKm} km away, roughly ${props.etaMinutes} minute${
        props.etaMinutes === 1 ? "" : "s"
      } out. That is an estimate from the traffic they have to cross, not a promise.`;
    }
    if (lastSeenAt === null) {
      return "They have set off. We are waiting for the first position from their phone.";
    }
    return "They have set off. We cannot work out a distance for this address.";
  })();

  return (
    <section
      className="mt-6 rounded border p-5"
      style={{
        backgroundColor: "var(--accent-wash)",
        borderColor: "var(--accent)",
      }}
      aria-live="polite"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: "var(--accent-text)" }}>
          {headline}
        </h2>
        <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
          Set off{" "}
          {enRouteAt.toLocaleTimeString("en-GB", {
            timeZone: "Asia/Dubai",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </p>
      </div>

      <p className="prose-body mt-2 text-[14px]">{detail}</p>

      {/* The age of the reading, which is what makes the reading honest. Hidden
          until the clock has been read on the client — see the effect above. */}
      {lastSeenAt !== null && now !== null ? (
        <p className="tnum mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Position updated {relativeAge(lastSeenAt, now)}
        </p>
      ) : null}
    </section>
  );
}
