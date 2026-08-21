import Link from "next/link";
import type { LeadFunnelReport } from "@meridian/db";
import { Warning } from "@phosphor-icons/react/dist/ssr";

/**
 * The report `lead_disposition_reasons` was built for (`LEAD-6`, `LEAD-9`).
 *
 * 0012 created the controlled vocabulary, `setLeadStage` enforces it, a
 * database CHECK backs that up — and nothing has ever read it. A taxonomy that
 * is collected and never reported costs the operator three seconds per lead and
 * returns nothing, and a field like that reliably becomes a field everybody
 * sets to whatever is first in the list.
 *
 * ── LOST AND DORMANT ARE SHOWN APART ───────────────────────────────────────
 *
 * `applies_to` exists because they answer different questions. Lost is "this
 * will not happen" — price, competitor, out of scope — and it changes what gets
 * quoted. Dormant is "not now" — budget year, tenant moving out — and it
 * changes *when to call back*. Summing them produces one "why we lose" number
 * that understates the pipeline still available and overstates the losses.
 */
export function DispositionPanel({ report }: { report: LeadFunnelReport }) {
  if (report.total === 0) return null;

  return (
    <section className="mt-6 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[15px] font-semibold">
        The last {report.days} days
      </h2>

      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        {[
          { label: "Leads", value: String(report.total) },
          { label: "Won", value: String(report.won) },
          { label: "Lost", value: String(report.lost) },
          { label: "Dormant", value: String(report.dormant) },
          {
            label: "Win rate",
            value: report.won + report.lost > 0 ? `${Math.round(report.winRate * 100)}%` : "—",
          },
          {
            label: "Median days to close",
            value: report.medianDaysToClose === null ? "—" : String(Math.round(report.medianDaysToClose)),
          },
        ].map((s) => (
          <div key={s.label}>
            <dt className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {s.label}
            </dt>
            <dd className="tnum mt-0.5 text-[19px] font-semibold">{s.value}</dd>
          </div>
        ))}
      </dl>

      {report.lostReasons.length > 0 || report.dormantReasons.length > 0 ? (
        <div className="mt-5 grid gap-6 sm:grid-cols-2">
          <ReasonList title="Why leads were lost" rows={report.lostReasons} />
          <ReasonList title="Why leads went dormant" rows={report.dormantReasons} />
        </div>
      ) : (
        <p className="prose-body mt-4 text-[13px]">
          Nothing has been closed with a reason yet, so there is no funnel to report on.{" "}
          <Link href="/admin/reference/dispositions" className="underline" style={{ color: "var(--accent-text)" }}>
            The reason list is here
          </Link>
          .
        </p>
      )}

      {/* Surfaced rather than filtered out. It should always be zero — the
          CHECK constraint sees to that for anything closed since 0012 — and a
          report that quietly drops these shows percentages that do not add up
          with nothing on screen to explain why. */}
      {report.unreasoned > 0 ? (
        <p
          className="mt-4 flex items-start gap-2 text-[13px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {report.unreasoned} closed lead{report.unreasoned === 1 ? "" : "s"} carr
          {report.unreasoned === 1 ? "ies" : "y"} no reason. These predate the reason list and are
          excluded from the percentages above.
        </p>
      ) : null}
    </section>
  );
}

function ReasonList({
  title,
  rows,
}: {
  title: string;
  rows: LeadFunnelReport["lostReasons"];
}) {
  if (rows.length === 0) {
    return (
      <div>
        <h3 className="text-[13px] font-semibold">{title}</h3>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          None in this window.
        </p>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-[13px] font-semibold">{title}</h3>
      <ul className="mt-2 space-y-1.5">
        {rows.map((r) => (
          <li key={r.reasonId ?? r.code} className="text-[13px]">
            <div className="flex items-baseline justify-between gap-3">
              <span>{r.label}</span>
              <span className="tnum shrink-0" style={{ color: "var(--text-muted)" }}>
                {r.leads} · {Math.round(r.share * 100)}%
              </span>
            </div>
            {/* A bar rather than only a number. Which reason is biggest is the
                one thing anybody takes from this, and a column of digits makes
                that a comparison task instead of a glance. */}
            <div className="mt-1 h-1 rounded-full" style={{ backgroundColor: "var(--border-hairline)" }}>
              <div
                className="h-1 rounded-full"
                style={{ width: `${Math.max(r.share * 100, 2)}%`, backgroundColor: "var(--accent)" }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
