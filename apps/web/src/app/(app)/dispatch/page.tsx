import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  listDispatchBoard,
  dispatchBoardCounts,
  countOpenFieldConflicts,
  listFieldConflicts,
} from "@meridian/db";
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
import { EmptyState } from "@/components/empty-state";
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
  const { rows, counts, openConflictCount, conflictRows } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      rows: await listDispatchBoard(tx, { now }),
      counts: await dispatchBoardCounts(tx, now),
      // The headline figure comes from the count query, never from measuring
      // the (deliberately short) list below it — a capped list under-reports
      // the moment the queue outgrows its cap, and this is the number a
      // dispatcher would use to decide whether the queue is under control.
      openConflictCount: await countOpenFieldConflicts(tx),
      conflictRows: await listFieldConflicts(tx, { unresolvedOnly: true, limit: 5 }),
    }),
  );

  return (
    <AppShell session={session} active="dispatch">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Dispatch board</h1>
            <p className="prose-body mt-2 text-[14px]">
              Open work, ordered by priority then by how soon it breaches.{" "}
              <Link href="/schedule" className="underline underline-offset-2" style={{ color: "var(--accent-text)" }}>
                The schedule
              </Link>{" "}
              is the other view: who is doing what, and when.
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

        {/*
          The field conflict queue (§8.4, ADR 0004).

          A conflict is raised when a technician completes a job offline while
          a dispatcher cancels it online (or the reverse) — ADR 0004 treats
          that as real work for a human, not something a merge rule can
          settle. Somebody spent an afternoon on work the system does not
          currently believe happened, so this sits on the board rather than
          waiting to be found, but as a panel of its own: the table below is
          ordered by SLA consequence, and folding an old conflict into that
          ordering would let it displace a live emergency.
        */}
        <div className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Field conflicts</h2>
            {openConflictCount > 0 ? (
              <Link
                href="/dispatch/conflicts"
                className="text-[13px] font-medium underline underline-offset-2"
                style={{ color: "var(--accent-text)" }}
              >
                Resolve &rarr;
              </Link>
            ) : null}
          </div>

          {openConflictCount === 0 ? (
            <div className="mt-3">
              <EmptyState kind="good" title="No unresolved field conflicts.">
                <p>
                  Nothing is waiting on a decision between what a handset attempted and what the
                  server holds. New conflicts appear here the moment a device sync disagrees with
                  the server about a job&apos;s state.
                </p>
              </EmptyState>
            </div>
          ) : (
            <div
              className="mt-3 overflow-hidden rounded border"
              style={{ borderColor: "var(--status-warning)", backgroundColor: "var(--status-warning-wash)" }}
            >
              <ul className="divide-y" style={{ borderColor: "var(--border-hairline)" }}>
                {conflictRows.map((c) => (
                  <li key={c.id} className="p-4">
                    <p className="text-[14px] font-medium">
                      <Link
                        href={`/jobs/${c.jobId}`}
                        className="underline underline-offset-2"
                        style={{ color: "var(--accent-text)" }}
                      >
                        {c.jobReference}
                      </Link>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {" "}
                        &middot; {c.technicianName} &middot; {c.deviceLabel}
                      </span>
                    </p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {c.detail}
                    </p>
                  </li>
                ))}
              </ul>
              {openConflictCount > conflictRows.length ? (
                <p
                  className="px-4 py-3 text-[12px]"
                  style={{ color: "var(--text-secondary)", backgroundColor: "var(--surface-raised)" }}
                >
                  Showing the {conflictRows.length} oldest-waiting of {openConflictCount} unresolved
                  conflicts.{" "}
                  <Link href="/dispatch/conflicts" style={{ color: "var(--accent-text)" }}>
                    The full queue
                  </Link>{" "}
                  has the rest.
                </p>
              ) : null}
            </div>
          )}
        </div>

        {rows.length === 0 ? (
          /*
           * ADM-12. The previous copy ended "…or the seed has not run", which
           * is a sentence written for whoever built the screen. The first
           * person to see this board empty is a dispatcher on a Monday, and
           * being told about a seed script tells them the software is broken.
           */
          <div className="mt-8">
            <EmptyState kind="good" title="Nothing is waiting on a dispatcher.">
              <p>
                Every job is signed off, closed or cancelled &mdash; there is nothing to assign,
                nothing en route and no SLA clock running. New work lands here the moment a lead is
                converted, a customer raises a request in the portal, or somebody rings the
                emergency line.
              </p>
            </EmptyState>
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
                        <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
                          {job.title}
                          {/*
                            CON-6 is the mechanism that stops contract work
                            being absorbed, and it is reached from the job page.
                            A dispatcher who cannot tell a contract job from any
                            other one has no reason to open it, which is why
                            this chip exists rather than only the flag in the
                            database.
                          */}
                          {job.contractReference ? (
                            <span
                              className="tnum shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                              style={{
                                backgroundColor: "var(--accent-wash)",
                                color: "var(--accent-text)",
                              }}
                            >
                              AMC &middot; {job.contractReference}
                            </span>
                          ) : null}
                        </p>
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

        {/*
          The cap, said out loud (`LEAD-8`).

          This board is a top-N-by-urgency view and a cap is the right shape for
          it — see the note on `listDispatchBoard`. What is not acceptable is a
          cap nobody can see: 200 rows presented as the whole board is a screen
          that quietly stops mentioning work. `counts.open` is a tenant-wide
          aggregate, independent of this list, so the two disagreeing is exactly
          how truncation becomes visible. The overflow is the least urgent end,
          and the jobs list is where it can be paged through in full.
        */}
        {counts.open > rows.length ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Showing the {rows.length} most urgent of {counts.open} open jobs. The remaining{" "}
            {counts.open - rows.length} are further from breaching &mdash;{" "}
            <Link href="/jobs" className="underline underline-offset-2" style={{ color: "var(--accent-text)" }}>
              the jobs list
            </Link>{" "}
            pages through all of them.
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}
