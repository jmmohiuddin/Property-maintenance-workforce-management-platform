import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listRetention, listUnapprovedSubcontracts, listExpiringPermits } from "@meridian/db";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Chip, EmptyState, LABEL, SectionHeading, daysPhrase, formatDay, money } from "../project-ui";
import { SubcontractDecisionForm } from "./chase-ui";

export const metadata: Metadata = { title: "Chase list — Projects" };
export const dynamic = "force-dynamic";

/**
 * The chase list (`PRJ-5`, `PRJ-6`, `PRJ-9`) — what `/api/cron/projects` tells
 * an accountant and an operations manager every morning, rendered so a person
 * can look at it between digests instead of only inside one.
 *
 * ── WHY THIS SCREEN DID NOT EXIST UNTIL TONIGHT ─────────────────────────────
 *
 * `listUnapprovedSubcontracts` and `listExpiringPermits` (`packages/db/src/
 * domain/projects.ts`) were written for the cron sweep and had exactly one
 * caller each: it. `listRetention`'s chase-window form — `{ dueWithinDays }` —
 * had the same story even though the un-windowed form is read by the projects
 * board. Three functions the system had been quietly running against every
 * tenant every night, and nothing a person could load to see what they found.
 * That is the same defect family `MilestonePanel` and the invoices module hit
 * elsewhere in this codebase: domain code with no caller is not merely
 * untidy, because nothing exercises it in anger until something finally does.
 *
 * ── WHAT IS DELIBERATELY DIFFERENT FROM THE PROJECTS BOARD ──────────────────
 *
 * `/projects` shows *all* outstanding retention, because that ledger has no
 * chase window of its own — `listRetention`'s comment in the domain module
 * says so directly. This screen narrows every list to the same windows the
 * cron sweep uses (`RETENTION_WINDOW_DAYS`, `PERMIT_WINDOW_DAYS`, mirrored
 * below rather than imported — a route handler is not a module other code
 * should depend on), so what is on screen here is exactly what tonight's or
 * tomorrow's email would have said, not a longer list that quietly disagrees
 * with the message that actually goes out.
 *
 * ── WHY SUBCONTRACTS ARE THE ONLY ROW WITH A BUTTON ─────────────────────────
 *
 * Retention is released with money changing hands, on the project screen,
 * against an invoice; permits are renewed by an authority, off-system, and
 * recorded on the project screen when the new certificate arrives — both
 * already have a home. Unapproved subcontracts had no home at all:
 * `client_approval_state` could only ever be set once, at `engageSubcontractor`,
 * and there was no way to move it afterwards. `decideSubcontractApproval` is
 * new tonight, and this is its only caller — see its own comment for why a
 * block was considered here and declined.
 */

/** Mirrors `RETENTION_WINDOW_DAYS` in `/api/cron/projects/route.ts`. See there for why 45. */
const RETENTION_WINDOW_DAYS = 45;

/** Mirrors `PERMIT_WINDOW_DAYS` in `/api/cron/projects/route.ts`. See there for why 30. */
const PERMIT_WINDOW_DAYS = 30;

export default async function ProjectChasePage() {
  const session = await requireSessionWith("projects:read");
  const canWrite = can(session.principal, "projects:write");

  const { retention, subcontracts, permits } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      retention: await listRetention(tx, { dueWithinDays: RETENTION_WINDOW_DAYS }),
      subcontracts: await listUnapprovedSubcontracts(tx),
      permits: await listExpiringPermits(tx, { withinDays: PERMIT_WINDOW_DAYS }),
    }),
  );

  const overdueRetention = retention.filter((r) => (r.daysToDue ?? 0) < 0);
  const retentionDueMinor = retention.reduce((sum, r) => sum + r.amountMinor, 0);

  const unlawfulSubcontracts = subcontracts.filter((s) => s.alreadyStarted);
  const refusedSubcontracts = subcontracts.filter((s) => s.approvalState === "refused");

  const lapsedPermits = permits.filter((p) => p.daysRemaining < 0);

  return (
    <AppShell session={session} active="projects">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div>
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              <Link href="/projects" className="hover:underline">
                Projects
              </Link>{" "}
              / Chase list
            </p>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Chase list</h1>
          </div>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {retention.length + subcontracts.length + permits.length} item
            {retention.length + subcontracts.length + permits.length === 1 ? "" : "s"} across three
            registers
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">
          Exactly what <code>/api/cron/projects</code> read this morning to decide who to email —
          retention inside its {RETENTION_WINDOW_DAYS}-day window, subcontract engagements still
          without the employer&rsquo;s approval, and required permits inside their{" "}
          {PERMIT_WINDOW_DAYS}-day window. Nothing here is blocked; every row is a state the system
          knows about and is telling a person, on the theory that the chase itself is the control.
        </p>

        {/* ── 1. Retention ──────────────────────────────────────────────── */}
        <section aria-labelledby="chase-retention-heading" className="mt-10">
          <div id="chase-retention-heading">
            <SectionHeading
              tone={overdueRetention.length > 0 ? "critical" : "warning"}
              title="Retention falling due"
              count={retention.length}
            >
              Money already invoiced, sitting in the client&rsquo;s account until somebody asks for
              it. {money(retentionDueMinor)} across every row below.
            </SectionHeading>
          </div>

          {retention.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="Nothing due inside the window.">
                No retention claim falls due within {RETENTION_WINDOW_DAYS} days. Released retention
                stops appearing here the day it is released.
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
                    <th className="py-2 pr-4 font-medium">Stage</th>
                    <th className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th className="py-2 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {retention.map((r) => {
                    const overdue = (r.daysToDue ?? 0) < 0;
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
                            tone={overdue ? "critical" : "warning"}
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

        {/* ── 2. Unapproved subcontracts ────────────────────────────────── */}
        <section aria-labelledby="chase-subcontracts-heading" className="mt-10">
          <div id="chase-subcontracts-heading">
            <SectionHeading
              tone={unlawfulSubcontracts.length > 0 || refusedSubcontracts.length > 0 ? "critical" : "warning"}
              title="Subcontracts without the employer's approval"
              count={subcontracts.length}
            >
              Dubai Law No. 7 of 2025 requires the employer&rsquo;s approval before subcontracting,
              in advance. An engagement whose start date has already passed is on the wrong side of
              that line right now, not running late on paperwork.
            </SectionHeading>
          </div>

          {subcontracts.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="Nothing awaiting approval.">
                Every engagement on a live project is either approved, refused, or recorded as not
                requiring approval.
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 space-y-4">
              {subcontracts.map((s) => (
                <li
                  key={s.id}
                  className="rounded-sm border-l-2 px-4 py-3"
                  style={{
                    borderColor:
                      s.alreadyStarted || s.approvalState === "refused"
                        ? "var(--status-critical)"
                        : "var(--status-warning)",
                    backgroundColor:
                      s.alreadyStarted || s.approvalState === "refused"
                        ? "var(--status-critical-wash)"
                        : "var(--status-warning-wash)",
                  }}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="text-[14px] font-medium">
                      <Link href={`/projects/${s.projectId}`} className="hover:underline">
                        {s.projectReference}
                      </Link>{" "}
                      — {s.subcontractorName}
                    </p>
                    <span className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {money(s.valueMinor)}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {s.scope}
                  </p>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {s.approvalState === "refused" ? "Refused" : "Awaiting approval"}
                    {s.startsOn
                      ? s.alreadyStarted
                        ? ` — started ${formatDay(s.startsOn)}, ${s.daysSinceStart} day(s) ago without ` +
                          "approval"
                        : ` — starts ${formatDay(s.startsOn)}`
                      : " — no start date recorded"}
                  </p>
                  {canWrite ? (
                    <SubcontractDecisionForm
                      projectId={s.projectId}
                      subcontractId={s.id}
                      refusable={s.approvalState !== "refused"}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 3. Permits about to lapse ─────────────────────────────────── */}
        <section aria-labelledby="chase-permits-heading" className="mt-10">
          <div id="chase-permits-heading">
            <SectionHeading
              tone={lapsedPermits.length > 0 ? "critical" : "warning"}
              title="Required permits about to lapse"
              count={permits.length}
            >
              An approved permit that lapses mid-project starts blocking the same project it once
              cleared — see the permit gate on <code>transitionProject</code>. Renew it here before
              site work is refused by the button rather than by the authority.
            </SectionHeading>
          </div>

          {permits.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="Nothing lapsing inside the window.">
                No approved, required permit expires within {PERMIT_WINDOW_DAYS} days.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">Project</th>
                    <th className="py-2 pr-4 font-medium">Authority</th>
                    <th className="py-2 pr-4 font-medium">Permit</th>
                    <th className="py-2 pr-4 font-medium">Reference</th>
                    <th className="py-2 font-medium">Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {permits.map((p) => (
                    <tr key={p.id} className="border-b">
                      <td className="py-2.5 pr-4">
                        <Link href={`/projects/${p.projectId}`} className="hover:underline">
                          {p.projectReference}
                        </Link>
                      </td>
                      <td className="py-2.5 pr-4">{p.authorityLabel}</td>
                      <td className="py-2.5 pr-4">{p.permitType}</td>
                      <td className="py-2.5 pr-4 tnum">{p.referenceNumber ?? "—"}</td>
                      <td className="py-2.5">
                        <Chip tone={p.daysRemaining < 0 ? "critical" : "warning"} label={formatDay(p.expiresOn)}>
                          {p.daysRemaining < 0
                            ? `expired ${Math.abs(p.daysRemaining)} day(s) ago`
                            : p.daysRemaining === 0
                              ? "expires today"
                              : `expires in ${p.daysRemaining} day(s)`}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
