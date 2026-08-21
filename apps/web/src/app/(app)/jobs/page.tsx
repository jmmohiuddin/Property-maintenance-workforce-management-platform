import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listDispatchBoard } from "@meridian/db";
import { getService, OPEN_STATUSES, STATUS_LABEL, PRIORITY_LABEL, SLA_STATE_LABEL, type JobStatus } from "@meridian/core";
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

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("jobs:read");
  const params = await searchParams;
  const filter = typeof params["status"] === "string" ? params["status"] : "open";

  const statuses: readonly JobStatus[] =
    filter === "all"
      ? ALL_STATUSES
      : ALL_STATUSES.includes(filter as JobStatus)
        ? [filter as JobStatus]
        : OPEN_STATUSES;

  const rows = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listDispatchBoard(tx, { statuses, limit: 300 }),
  );

  const chips: { key: string; label: string }[] = [
    { key: "open", label: "Open" },
    { key: "all", label: "All" },
    ...ALL_STATUSES.map((s) => ({ key: s, label: STATUS_LABEL[s] })),
  ];

  return (
    <AppShell session={session} active="jobs">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Jobs</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {rows.length} shown
          </p>
        </div>

        <nav aria-label="Filter by status" className="mt-6 flex flex-wrap gap-2">
          {chips.map((c) => {
            const active = filter === c.key;
            return (
              <Link
                key={c.key}
                href={c.key === "open" ? "/jobs" : `/jobs?status=${c.key}`}
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
           * ADM-12. Two different zeros, and the old copy told the same story
           * for both.
           *
           * "No jobs match this filter" over a database with no jobs at all
           * sends a new operations manager hunting through status chips for
           * work that was never raised. The filter is known here, so the screen
           * can say which of the two it is looking at — and in the second case
           * it can say what creates a job, which is the requirement.
           */
          <div className="mt-8">
            {filter === "all" ? (
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
                          join: both screens call `listDispatchBoard`. */}
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
      </div>
    </AppShell>
  );
}
