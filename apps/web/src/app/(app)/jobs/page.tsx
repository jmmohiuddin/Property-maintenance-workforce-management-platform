import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, searchJobs, countJobs } from "@meridian/db";
import {
  getService,
  OPEN_STATUSES,
  STATUS_LABEL,
  PRIORITY_LABEL,
  SLA_STATE_LABEL,
  type JobStatus,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";

export const metadata: Metadata = { title: "Jobs" };
export const dynamic = "force-dynamic";

const ALL_STATUSES: readonly JobStatus[] = [
  "submitted",
  "triaged",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "paused",
  "work_complete",
  "signed_off",
  "invoiced",
  "closed",
  "cancelled",
];

const PAGE_SIZE = 25;

/**
 * `LEAD-8`. Search and paging state live in the query string, not in React.
 *
 * ── WHAT THIS SCREEN USED TO DO ─────────────────────────────────────────────
 *
 * It called the dispatch board's query with `limit: 300` and printed
 * "{rows.length} shown". Two things were wrong with that and only one of them
 * looked like a bug. The visible one: past row 300 a job was unreachable, with
 * no next page and nothing saying so. The quieter one: at 300 jobs the header
 * would have read "300 shown" forever, which is a cap presenting itself as a
 * total. PRD §9 puts this tenant at 5,000 jobs a year, so both arrive inside
 * year one, and the rows that vanish are the oldest — exactly the ones somebody
 * arrives here looking for.
 *
 * Now: keyset pages of 25 against `jobs_keyset_idx`, and a headline count from
 * its own tenant-wide aggregate. The count is a second query on purpose. A
 * total derived from the page is a page size wearing a total's clothing, and it
 * is the trap that had to be undone on the customers screen.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("jobs:read");
  const params = await searchParams;
  const filter = typeof params["status"] === "string" ? params["status"] : "open";
  const q = typeof params["q"] === "string" ? params["q"].trim() : "";
  const cursor = typeof params["after"] === "string" ? params["after"] : undefined;

  const statuses: readonly JobStatus[] =
    filter === "all"
      ? ALL_STATUSES
      : ALL_STATUSES.includes(filter as JobStatus)
        ? [filter as JobStatus]
        : OPEN_STATUSES;

  const { page, total } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      page: await searchJobs(tx, { q: q || undefined, statuses, cursor, limit: PAGE_SIZE }),
      total: await countJobs(tx, { q: q || undefined, statuses }),
    }),
  );

  const rows = page.rows;

  const chips: { key: string; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "all", label: "All" },
    ...ALL_STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] })),
  ];

  /** Preserve the filter and the search when building a page or filter link. */
  const hrefFor = (next: { status?: string; after?: string | null }) => {
    const p = new URLSearchParams();
    const status = next.status ?? filter;
    if (status && status !== "open") p.set("status", status);
    if (q) p.set("q", q);
    if (next.after) p.set("after", next.after);
    const qs = p.toString();
    return qs ? `/jobs?${qs}` : "/jobs";
  };

  return (
    <AppShell session={session} active="jobs">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Jobs</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {/* The total is the tenant's, from its own aggregate. The page size
                is stated separately so the two can never be read as one number. */}
            {total === rows.length
              ? `${total} ${total === 1 ? "job" : "jobs"}`
              : `${rows.length} of ${total} jobs`}
          </p>
        </div>

        <form method="get" action="/jobs" className="mt-6 flex flex-wrap gap-2">
          {filter !== "open" ? <input type="hidden" name="status" value={filter} /> : null}
          <label className="flex-1 min-w-[16rem]">
            <span className="sr-only">Search jobs by reference or title</span>
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Reference or what went wrong"
              className="w-full rounded-sm border px-3 py-2 text-[14px] outline-none focus:border-[var(--accent)]"
            />
          </label>
          <button type="submit" className="btn btn-secondary">
            Search
          </button>
          {q ? (
            <Link href={hrefFor({ after: null })} className="btn btn-secondary">
              Clear
            </Link>
          ) : null}
        </form>

        <nav aria-label="Filter by status" className="mt-4 flex flex-wrap gap-2">
          {chips.map((c) => {
            const active = filter === c.key;
            return (
              <Link
                key={c.key}
                // Changing the filter drops the cursor deliberately: a position
                // in one result set means nothing in another, and carrying it
                // over would land the reader in the middle of a list they have
                // not seen the top of.
                href={hrefFor({ status: c.key, after: null })}
                aria-current={active ? "true" : undefined}
                className="rounded-sm border px-2.5 py-1.5 text-[13px] font-medium transition-colors"
                style={
                  active
                    ? {
                        backgroundColor: "var(--accent)",
                        color: "var(--accent-contrast)",
                        borderColor: "var(--accent)",
                      }
                    : { color: "var(--text-secondary)" }
                }
              >
                {c.label}
              </Link>
            );
          })}
        </nav>

        {rows.length === 0 ? (
          /*
           * ADM-12. Three different zeros now, and the old copy told the same
           * story for the first two.
           *
           * "No jobs match this filter" over a database with no jobs at all
           * sends a new operations manager hunting through status chips for
           * work that was never raised. The filter is known here, so the screen
           * can say which of the three it is looking at — and in the middle
           * case it can say what creates a job, which is the requirement.
           */
          <div className="mt-8">
            {q ? (
              <EmptyState kind="filtered" title="Nothing matches that search.">
                <p>
                  No job reference or title contains &ldquo;{q}&rdquo;
                  {filter === "all" ? "" : " in this status"}. The search looks at the reference and
                  the title, not at the customer or the address.
                </p>
              </EmptyState>
            ) : filter === "all" ? (
              <EmptyState kind="start" title="No job has been raised yet.">
                <p>
                  A job is created by converting a lead, by a customer raising a request in the
                  portal, or directly from the dispatch board. Every one of them carries a reference
                  and an SLA clock from the moment it exists.
                </p>
                <p className="mt-2">
                  Nothing is misconfigured &mdash; this is what the screen looks like before the
                  first week.
                </p>
              </EmptyState>
            ) : (
              <EmptyState kind="filtered" title="No job is in that state right now.">
                <p>
                  Other jobs exist; none are {(chips.find((c) => c.key === filter)?.label ?? filter).toLowerCase()}.
                </p>
              </EmptyState>
            )}
          </div>
        ) : (
          <ul className="mt-8 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            {rows.map((job) => (
              <li key={job.id}>
                <Link href={`/jobs/${job.id}`} className="block p-5 transition-colors hover:bg-[var(--surface-sunken)]">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <span className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {job.reference}
                      </span>
                      <h2 className="text-[15px] font-medium">{job.title}</h2>
                      {/* The same chip the dispatch board shows, from the same
                          join: both queries carry the AMC reference on the row. */}
                      {job.contractReference ? (
                        <span
                          className="tnum rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                          style={{
                            backgroundColor: "var(--accent-wash)",
                            color: "var(--accent-text)",
                          }}
                        >
                          AMC &middot; {job.contractReference}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-3 text-[13px]">
                      <span style={{ color: "var(--text-secondary)" }}>{STATUS_LABEL[job.status]}</span>
                      <span
                        style={{
                          color:
                            job.sla === "breached" ? "var(--accent-text)" : "var(--text-muted)",
                        }}
                      >
                        {SLA_STATE_LABEL[job.sla]}
                      </span>
                    </div>
                  </div>
                  <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {PRIORITY_LABEL[job.priority]} &middot; {job.customerName} &middot; {job.propertyName}
                    {job.propertyArea ? `, ${job.propertyArea}` : ""} &middot;{" "}
                    {getService(job.serviceSlug)?.shortName ?? job.serviceSlug} &middot;{" "}
                    {job.technicianName ?? "Unassigned"}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {page.nextCursor ? (
          <div className="mt-6">
            {/* Keyset, so this is "everything after the last row on this page"
                rather than "skip 25". A job raised while somebody pages cannot
                push a row past the boundary and out of sight. */}
            <Link href={hrefFor({ after: page.nextCursor })} className="btn btn-secondary">
              Show older jobs
            </Link>
          </div>
        ) : null}

        {cursor ? (
          <p className="mt-4 text-[13px]">
            <Link href={hrefFor({ after: null })} className="underline" style={{ color: "var(--text-muted)" }}>
              Back to the newest
            </Link>
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}
