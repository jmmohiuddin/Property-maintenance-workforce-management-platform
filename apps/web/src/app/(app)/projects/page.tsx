import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  listProjects,
  listRetention,
  contractableProperties,
  searchCustomers,
} from "@meridian/db";
import { OPEN_PROJECT_STATUSES } from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  Chip,
  EmptyState,
  LABEL,
  Meter,
  SectionHeading,
  daysPhrase,
  formatDay,
  money,
  statusTone,
} from "./project-ui";
import { NewProjectForm } from "./new-project-form";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

/**
 * The projects board (`PRJ-1`…`PRJ-9`).
 *
 * ── ORDERED BY CONSEQUENCE, LIKE EVERY OTHER OPERATOR SURFACE HERE ──────────
 *
 * Retention first. It is money already earned, already invoiced, sitting in
 * somebody else's account, and it is the only figure on this screen that
 * disappears entirely if nobody looks at it — a release nobody asks for is
 * simply never paid. Everything else on the page is at worst late.
 *
 * Unapproved variations second, for the same reason turned inside out: that is
 * work already happening with nothing securing the money for it, and it is
 * invisible everywhere else in the system — not in the contract value, not on
 * an invoice, only on the site.
 *
 * The list of projects, which is what a reader expects at the top, is third,
 * because it is the part that needs nothing doing to it.
 */
export default async function ProjectsPage() {
  const session = await requireSessionWith("projects:read");
  const canWrite = can(session.principal, "projects:write");

  const { projects, retention, properties, customers } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      projects: await listProjects(tx),
      // Everything held or due, across every project. One query — the chase
      // list is the point of the screen and it must not be one click away.
      retention: await listRetention(tx),
      properties: canWrite ? await contractableProperties(tx) : [],
      // `searchCustomers`, not a full list read. `TD-10`: the unbounded version
      // read every customer, then every open job, then every unpaid invoice, to
      // fill a picker that needs a name and a code.
      customers: canWrite ? (await searchCustomers(tx, { limit: 100 })).rows : [],
    }),
  );

  const live = projects.filter((p) => OPEN_PROJECT_STATUSES.includes(p.status));
  const outstandingRetention = retention.filter(
    (r) => r.status === "held" || r.status === "due",
  );
  const chaseable = outstandingRetention
    .filter((r) => r.daysToDue !== null && r.daysToDue <= 14)
    .sort((a, b) => (a.daysToDue ?? 0) - (b.daysToDue ?? 0));

  const retentionHeldMinor = outstandingRetention.reduce((sum, r) => sum + r.amountMinor, 0);
  const unapprovedMinor = projects.reduce((sum, p) => sum + p.unapprovedVariationMinor, 0);
  const blocked = projects.filter((p) => p.blockingPermits > 0);

  return (
    <AppShell session={session} active="projects">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Projects</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            Live <strong style={{ color: "var(--text-primary)" }}>{live.length}</strong> &middot;
            Retention held{" "}
            <strong
              style={{
                color:
                  retentionHeldMinor > 0 ? "var(--status-warning-text)" : "var(--text-primary)",
              }}
            >
              {money(retentionHeldMinor)}
            </strong>{" "}
            &middot; Unapproved variations{" "}
            <strong
              style={{
                color: unapprovedMinor > 0 ? "var(--status-critical-text)" : "var(--text-primary)",
              }}
            >
              {money(unapprovedMinor)}
            </strong>
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">
          A project is the container a `Job` cannot be: multi-week work, staged payments, a snag
          list and money withheld for a year after handover. Three rules are enforced rather than
          advised — a project cannot go on site with a required permit unapproved, practical
          completion cannot be recorded with an open critical snag, and a reached milestone raises
          exactly one invoice.
        </p>

        {/* ── 1. Retention ──────────────────────────────────────────────── */}
        <section aria-labelledby="retention-heading" className="mt-10">
          <div id="retention-heading">
            <SectionHeading
              tone={chaseable.length > 0 ? "critical" : "warning"}
              title="Retention outstanding"
              count={outstandingRetention.length}
            >
              Withheld from invoices already issued. Released only when somebody asks — nothing
              here releases itself.
            </SectionHeading>
          </div>

          {outstandingRetention.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="Nothing withheld.">
                No project has retention held against it. That is either a clean ledger or a
                project whose invoices have not been raised yet.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Customer</th>
                    <th className="py-2 pr-4 font-medium">Invoice</th>
                    <th className="py-2 pr-4 font-medium">Release</th>
                    <th className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th className="py-2 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {outstandingRetention.map((r) => {
                    const overdue = r.daysToDue !== null && r.daysToDue < 0;
                    return (
                      <tr key={r.id} className="border-b">
                        <td className="py-2.5 pr-4">
                          <Link href={`/projects/${r.projectId}`} className="hover:underline">
                            {r.projectReference}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-4">{r.customerName}</td>
                        <td className="py-2.5 pr-4 tnum">{r.invoiceReference}</td>
                        <td className="py-2.5 pr-4">{LABEL.retentionStage[r.stage]}</td>
                        <td className="py-2.5 pr-4 text-right tnum">{money(r.amountMinor)}</td>
                        <td className="py-2.5">
                          <Chip
                            tone={overdue ? "critical" : r.dueOn ? "warning" : "neutral"}
                            label={r.dueOn ? formatDay(r.dueOn) : "Held"}
                          >
                            {daysPhrase(r.daysToDue)}
                          </Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── 2. Permits blocking the site ──────────────────────────────── */}
        {blocked.length > 0 ? (
          <section aria-labelledby="blocked-heading" className="mt-10">
            <div id="blocked-heading">
              <SectionHeading tone="critical" title="Permits holding a site up" count={blocked.length}>
                A required permit that is unapproved — or approved and expired — stops the project
                entering site. Working without one draws a stop-work notice.
              </SectionHeading>
            </div>
            <ul className="mt-4 space-y-2">
              {blocked.map((p) => (
                <li key={p.id} className="text-[14px]">
                  <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                    {p.reference}
                  </Link>{" "}
                  <span style={{ color: "var(--text-secondary)" }}>
                    {p.name} — {p.blockingPermits} permit
                    {p.blockingPermits === 1 ? "" : "s"} outstanding
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── 3. The projects ───────────────────────────────────────────── */}
        <section aria-labelledby="projects-heading" className="mt-10">
          <div id="projects-heading">
            <SectionHeading tone="neutral" title="All projects" count={projects.length}>
              Contract value is the awarded figure and never moves. Variations total beside it.
            </SectionHeading>
          </div>

          {projects.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="neutral" title="No projects yet.">
                A project is for work a single job cannot carry — a fit-out, an installation, a
                renovation. Create one below and give it phases and payment milestones.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">Reference</th>
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 text-right font-medium">Contract value</th>
                    <th className="py-2 pr-4 text-right font-medium">Variations</th>
                    <th className="py-2 pr-4 font-medium">Progress</th>
                    <th className="py-2 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id} className="border-b">
                      <td className="py-2.5 pr-4 tnum">
                        <Link href={`/projects/${p.id}`} className="hover:underline">
                          {p.reference}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="font-medium">{p.name}</span>
                        <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {p.customerName}
                          {p.propertyName ? ` · ${p.propertyName}` : ""}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Chip tone={statusTone(p.status)} label={LABEL.status[p.status]}>
                          {p.openCriticalSnags > 0
                            ? `${p.openCriticalSnags} critical snag${p.openCriticalSnags === 1 ? "" : "s"}`
                            : undefined}
                        </Chip>
                      </td>
                      <td className="py-2.5 pr-4 text-right tnum">
                        {money(p.contractValueMinor)}
                      </td>
                      <td className="py-2.5 pr-4 text-right tnum">
                        {money(p.approvedVariationMinor)}
                        {p.unapprovedVariationMinor !== 0 ? (
                          <span
                            className="block text-[12px]"
                            style={{ color: "var(--status-critical-text)" }}
                          >
                            {money(p.unapprovedVariationMinor)} unapproved
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4">
                        {p.percentComplete === null ? (
                          <span style={{ color: "var(--text-muted)" }}>not planned</span>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <Meter percent={p.percentComplete} tone="success" />
                            <span className="tnum">{p.percentComplete}%</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2.5">{formatDay(p.targetCompletionOn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {canWrite ? (
          <section className="mt-10">
            <NewProjectForm
              customers={customers.map((c) => ({ id: c.id, name: c.name, code: c.code }))}
              properties={properties.map((p) => ({
                id: p.id,
                name: p.name,
                customerId: p.customerId,
                customerName: p.customerName,
              }))}
            />
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
