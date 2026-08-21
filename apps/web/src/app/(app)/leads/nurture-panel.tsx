import Link from "next/link";
import type { NurtureQueue } from "@meridian/db";
import { LEAD_STAGE_LABEL } from "@meridian/core";
import { BellRinging, Snowflake } from "@phosphor-icons/react/dist/ssr";

/**
 * What needs chasing today (`LEAD-9`).
 *
 * ── WHY "GOING COLD" IS A SEPARATE LIST FROM "OVERDUE" ─────────────────────
 *
 * Overdue is a promise not kept: a date was set and it passed. It is easy to
 * find and it is the smaller problem.
 *
 * Going cold is the one nobody sees. An open lead with no follow-up date is
 * overdue for nothing, breaches no deadline and appears on no report — it just
 * sits in `contacted` until the quarter ends. `last_interaction_at`, added in
 * 0016 and maintained by the communications log, is what makes it findable at
 * all: it is the difference between "no news" and "nobody has touched this in
 * five weeks".
 *
 * Rendered above the list rather than below it, and hidden entirely when both
 * are empty. A panel that says "nothing to chase" every day is a panel people
 * stop reading, and then it says something and they still do not read it.
 */
export function NurturePanel({ queue }: { queue: NurtureQueue }) {
  if (queue.overdue.length === 0 && queue.goingCold.length === 0) return null;

  return (
    <section className="mt-6 grid gap-4 md:grid-cols-2">
      {queue.overdue.length > 0 ? (
        <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <BellRinging size={16} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Follow-up overdue ({queue.overdue.length})
          </h2>
          <ul className="mt-3 space-y-2">
            {queue.overdue.map((lead) => (
              <li key={lead.id} className="text-[14px]">
                <Link href={`/leads/${lead.id}`} className="underline underline-offset-2">
                  {lead.name}
                </Link>
                <span className="ml-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {LEAD_STAGE_LABEL[lead.stage]} · {lead.daysOverdue === 0 ? "due today" : `${lead.daysOverdue} days late`}
                  {lead.phone ? ` · ${lead.phone}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {queue.goingCold.length > 0 ? (
        <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold">
            <Snowflake size={16} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Going cold ({queue.goingCold.length})
          </h2>
          <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Open, no follow-up set, nothing for {queue.coldAfterDays} days.
          </p>
          <ul className="mt-3 space-y-2">
            {queue.goingCold.map((lead) => (
              <li key={lead.id} className="text-[14px]">
                <Link href={`/leads/${lead.id}`} className="underline underline-offset-2">
                  {lead.name}
                </Link>
                <span className="ml-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {LEAD_STAGE_LABEL[lead.stage]} · {lead.daysSinceInteraction} days quiet
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
