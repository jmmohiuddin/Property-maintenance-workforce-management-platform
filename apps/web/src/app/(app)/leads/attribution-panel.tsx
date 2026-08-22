import type { AttributionRow } from "@meridian/db/domain";

/**
 * Where the leads came from (`LEAD-4`).
 *
 * The reason `DB-5` exists, put on the screen the people who work the pipeline
 * already have open. Ten service pages, ten area pages, JSON-LD on all of them
 * and an llms.txt are an investment, and until these columns were written
 * nothing recorded which of them produced anything — so the work could only be
 * defended on faith and could only be cut on faith.
 *
 * Won alongside volume, because the two disagree often enough to matter: a
 * source producing forty enquiries and one job is not the one to spend more on,
 * and a panel showing only the forty says that it is.
 *
 * Collapsed by default. It is context for a decision made once a quarter, not
 * something to read past on the way to today's enquiries.
 */
export function AttributionPanel({
  summary,
}: {
  summary: {
    readonly byChannel: readonly AttributionRow[];
    readonly byLandingPage: readonly AttributionRow[];
    readonly byCampaign: readonly AttributionRow[];
    readonly unattributed: number;
    readonly days: number;
  };
}) {
  const total = summary.byChannel.reduce((sum, row) => sum + row.leads, 0);

  return (
    <details className="mt-6 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <summary className="cursor-pointer text-[14px] font-medium">
        Where leads came from · last {summary.days} days
      </summary>

      {total === 0 ? (
        <p className="prose-body mt-4 text-[14px]">
          No leads in the last {summary.days} days, so there is nothing to attribute yet.
        </p>
      ) : (
        <div className="mt-5 grid gap-8 md:grid-cols-3">
          <Column title="Channel" rows={summary.byChannel} empty="Nothing recorded." />
          <Column
            title="Landing page"
            rows={summary.byLandingPage}
            empty="No landing pages recorded. Every enquiry is arriving with no page attached to it."
          />
          <Column
            title="Campaign"
            rows={summary.byCampaign}
            empty="No campaign tags seen. Either nothing is being run, or the links are missing their UTM parameters."
          />
        </div>
      )}

      {summary.unattributed > 0 ? (
        <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {summary.unattributed} of these {total} have no source recorded at all — phone calls,
          walk-ins, and anyone whose browser sent nothing. That number is shown rather than
          absorbed into the others, because a funnel that quietly attributes what it does not know
          is worse than one with an honest gap in it.
        </p>
      ) : null}
    </details>
  );
}

function Column({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: readonly AttributionRow[];
  empty: string;
}) {
  return (
    <div>
      <h3 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {empty}
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.slice(0, 8).map((row) => (
            <li key={row.label} className="flex items-baseline justify-between gap-3 text-[13px]">
              <span className="truncate" title={row.label}>
                {row.label}
              </span>
              <span className="tnum shrink-0" style={{ color: "var(--text-secondary)" }}>
                {row.leads} · {row.won} won
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
