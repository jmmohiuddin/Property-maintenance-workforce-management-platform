import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listDispatchBoard } from "@meridian/db";
import { getService, OPEN_STATUSES, STATUS_LABEL, PRIORITY_LABEL, SLA_STATE_LABEL, type JobStatus } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";

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
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">No jobs match this filter</h2>
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
