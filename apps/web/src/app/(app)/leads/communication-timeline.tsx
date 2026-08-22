import {
  COMMUNICATION_CHANNEL_LABEL,
  COMMUNICATION_OUTCOME_LABEL,
  type CommunicationChannel,
  type CommunicationOutcome,
} from "@meridian/core";

/**
 * What was said, newest first (`LEAD-9`).
 *
 * One component for both halves of the requirement — "a log of calls and
 * messages per lead and customer" — because the two timelines read the same
 * rows out of the same table. A second copy of this markup on the customer
 * screen would be two places for a channel label to be wrong in.
 *
 * A server component with no state: the log form beside it is the interactive
 * part, and this is the part that has to render for somebody with the phone
 * already ringing.
 */
export interface TimelineEntry {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly body: string | null;
  readonly outcome: string | null;
  readonly authorName: string | null;
  readonly isAutomated: boolean;
  readonly occurredAt: Date;
}

export function CommunicationTimeline({
  entries,
  empty,
}: {
  entries: readonly TimelineEntry[];
  /** What to say when nothing is logged. The two screens say different things. */
  empty: string;
}) {
  if (entries.length === 0) {
    return <p className="prose-body mt-3 text-[14px]">{empty}</p>;
  }

  return (
    <ul className="mt-4 space-y-3">
      {entries.map((c) => (
        <li key={c.id} className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-[13px] font-semibold">
              {COMMUNICATION_CHANNEL_LABEL[c.channel as CommunicationChannel] ?? c.channel}
              {c.direction === "inbound" ? " · they contacted us" : ""}
              {c.outcome
                ? ` · ${COMMUNICATION_OUTCOME_LABEL[c.outcome as CommunicationOutcome] ?? c.outcome}`
                : ""}
            </p>
            <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
              {c.occurredAt.toLocaleString("en-GB", {
                timeZone: "Asia/Dubai",
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </p>
          </div>
          {c.body ? <p className="prose-body mt-2 text-[14px]">{c.body}</p> : null}
          <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
            {c.isAutomated ? "Automated" : (c.authorName ?? "Unknown")}
          </p>
        </li>
      ))}
    </ul>
  );
}
