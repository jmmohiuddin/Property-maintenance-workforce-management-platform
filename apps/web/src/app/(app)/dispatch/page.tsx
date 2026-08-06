import type { Metadata } from "next";
import { withTenant, listDispatchBoard, dispatchBoardCounts } from "@meridian/db";
import {
  getService,
  STATUS_LABEL,
  PRIORITY_LABEL,
  SLA_STATE_LABEL,
  minutesUntil,
  formatDuration,
  type SlaState,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Warning, Clock, UserCircle } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Dispatch" };

// Always live. A cached dispatch board is a dangerous dispatch board.
export const dynamic = "force-dynamic";

const SLA_STYLE: Readonly<Record<SlaState, { bg: string; fg: string }>> = {
  breached: { bg: "var(--accent-wash)", fg: "var(--accent-text)" },
  at_risk: { bg: "var(--surface-sunken)", fg: "var(--text-primary)" },
  on_track: { bg: "transparent", fg: "var(--text-muted)" },
  met: { bg: "transparent", fg: "var(--text-muted)" },
  none: { bg: "transparent", fg: "var(--text-muted)" },
};

export default async function DispatchPage() {
  const session = await requireSessionWith("jobs:read");
  const now = new Date();

  // Every read goes through withTenant, so Postgres RLS is what actually
  // scopes these rows - not a WHERE clause we could forget to write.
  const { rows, counts } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      rows: await listDispatchBoard(tx, { now }),
      counts: await dispatchBoardCounts(tx, now),
    }),
  );

  return (
    <AppShell session={session} active="dispatch">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Dispatch board</h1>
            <p className="prose-body mt-2 text-[14px]">
              Open work, ordered by priority then by how soon it breaches.
            </p>
          </div>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {now.toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" })} GST
          </p>
        </div>

        <dl className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-2 lg:grid-cols-4" style={{ backgroundColor: "var(--border-hairline)" }}>
          {[
            { label: "Open jobs", value: counts.open, tone: false },
            { label: "SLA breached", value: counts.breached, tone: counts.breached > 0 },
            { label: "At risk", value: counts.atRisk, tone: false },
            { label: "Unassigned", value: counts.unassigned, tone: counts.unassigned > 0 },
          ].map((stat) => (
            <div key={stat.label} className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {stat.label}
              </dt>
              <dd
                className="tnum mt-1 text-3xl font-semibold"
                style={stat.tone ? { color: "var(--accent-text)" } : undefined}
              >
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>

        {rows.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">Nothing open</h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              Every job is closed or cancelled. Either it is a very good day, or the seed has not run.
            </p>
          </div>
        ) : (
          <div className="mt-8 overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            <table className="w-full min-w-[64rem] border-collapse text-left">
              <thead>
                <tr className="border-b text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  <th scope="col" className="px-4 py-3 font-medium">Reference</th>
                  <th scope="col" className="px-4 py-3 font-medium">Job</th>
                  <th scope="col" className="px-4 py-3 font-medium">Priority</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Technician</th>
                  <th scope="col" className="px-4 py-3 font-medium">SLA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((job) => {
                  const remaining = job.resolveByAt ? minutesUntil(job.resolveByAt, now) : null;
                  // Fallback keeps this total under noUncheckedIndexedAccess,
                  // and means a status added later renders plainly rather than
                  // crashing the board.
                  const style = SLA_STYLE[job.sla] ?? { bg: "transparent", fg: "var(--text-muted)" };
                  return (
                    <tr key={job.id} className="border-b last:border-0 align-top">
                      <td className="tnum px-4 py-4 text-[13px] whitespace-nowrap">{job.reference}</td>
                      <td className="px-4 py-4">
                        <p className="text-[15px] font-medium">{job.title}</p>
                        <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {job.customerName} &middot; {job.propertyName}
                          {job.propertyArea ? `, ${job.propertyArea}` : ""} &middot;{" "}
                          {getService(job.serviceSlug)?.shortName ?? job.serviceSlug}
                        </p>
                      </td>
                      <td className="px-4 py-4 text-[13px] whitespace-nowrap">
                        {job.priority === "p1_emergency" ? (
                          <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: "var(--accent-text)" }}>
                            <Warning size={14} weight="fill" aria-hidden />
                            {PRIORITY_LABEL[job.priority]}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-secondary)" }}>{PRIORITY_LABEL[job.priority]}</span>
                        )}
                      </td>
                      <td className="px-4 py-4 text-[13px] whitespace-nowrap">{STATUS_LABEL[job.status]}</td>
                      <td className="px-4 py-4 text-[13px] whitespace-nowrap">
                        {job.technicianName ? (
                          <span className="inline-flex items-center gap-1.5">
                            <UserCircle size={15} aria-hidden style={{ color: "var(--text-muted)" }} />
                            {job.technicianName}
                          </span>
                        ) : (
                          <span className="font-medium" style={{ color: "var(--accent-text)" }}>
                            Unassigned
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-4 whitespace-nowrap">
                        <span
                          className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[12px] font-medium"
                          style={{ backgroundColor: style.bg, color: style.fg }}
                        >
                          <Clock size={13} aria-hidden />
                          {SLA_STATE_LABEL[job.sla]}
                        </span>
                        {remaining !== null ? (
                          <p className="tnum mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                            {remaining >= 0 ? `${formatDuration(remaining)} left` : `${formatDuration(remaining)} over`}
                          </p>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
