import type { Metadata } from "next";
import { withCustomerScope, propertyManagerMonthlyPack } from "@meridian/db";
import { formatMoney } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { EmptyState } from "@/components/empty-state";
import { ClipboardText, Wrench, CalendarCheck, Receipt } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Monthly report" };
export const dynamic = "force-dynamic";

/**
 * `CUST-5`. The monthly reporting pack, on demand.
 *
 * The cron under `/api/cron/monthly-pack` emails this to a property manager's
 * notification contacts on the 1st; this page is the same figures, from the
 * same domain function (`propertyManagerMonthlyPack`), for whoever is logged
 * into the portal and wants to look them up between emails — or who has no
 * notification contact configured and would otherwise never see the pack at
 * all.
 *
 * Every read goes through `withCustomerScope`, exactly like the rest of this
 * folder: a forgotten filter here returns nothing, never another customer's
 * jobs, visits or invoices.
 */
export default async function PortalReportsPage() {
  const session = await requirePortalSession();

  const pack = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    (tx) =>
      propertyManagerMonthlyPack(
        tx,
        { tenantId: session.principal.tenantId, customerId: session.customerId },
      ),
  );

  const dateFmt = (d: Date): string =>
    d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

  const pct = (n: number | null): string => (n === null ? "not measured" : `${n}%`);

  return (
    <PortalShell session={session} active="reports">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Monthly report</h1>
        <p className="prose-body mt-2 text-[14px]">
          {pack.period.label}. Jobs raised and closed, response and resolution against your SLA,
          planned maintenance, outstanding recommendations and spend — across every property and
          contract on this account. The same figures are emailed to your account's notification
          contacts on the 1st of each month.
        </p>

        {/* ── Jobs and SLA ─────────────────────────────────────────────── */}
        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-2 lg:grid-cols-4"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            { label: "Jobs raised", value: `${pack.jobs.raised}` },
            { label: "Jobs closed", value: `${pack.jobs.closed}` },
            { label: "Response SLA met", value: pct(pack.sla.responseMetPercent) },
            { label: "Resolution SLA met", value: pct(pack.sla.resolutionMetPercent) },
          ].map((s) => (
            <div key={s.label} className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {s.label}
              </dt>
              <dd className="tnum mt-1 text-2xl font-semibold">{s.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {pack.jobs.raisedStillOpen} of the jobs raised this month {pack.jobs.raisedStillOpen === 1 ? "is" : "are"}{" "}
          still open.
          {pack.sla.responseDeadlines === 0
            ? " No response deadline fell inside this month."
            : ` ${pack.sla.responseMet} of ${pack.sla.responseDeadlines} response deadlines were met.`}
          {pack.sla.resolutionDeadlines === 0
            ? " No resolution deadline fell inside this month."
            : ` ${pack.sla.resolutionMet} of ${pack.sla.resolutionDeadlines} resolution deadlines were met.`}
        </p>

        {/* ── PPM ──────────────────────────────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <CalendarCheck size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Planned maintenance
          </h2>
          {pack.ppm.visitsDue === 0 ? (
            <p className="prose-body mt-3 text-[14px]">No PPM visit was due this month.</p>
          ) : (
            <p className="prose-body mt-3 text-[14px]">
              {pack.ppm.visitsCompleted} of {pack.ppm.visitsDue} planned visits due this month were completed
              ({pct(pack.ppm.completionPercent)}).
            </p>
          )}
        </section>

        {/* ── Outstanding recommendations ─────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Wrench size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Outstanding recommendations
          </h2>

          {pack.outstanding.total === 0 ? (
            <EmptyState kind="good" title="Nothing outstanding from this month's visits.">
              No recommendation raised on a job report this month is still waiting on a decision.
            </EmptyState>
          ) : (
            <>
              <p className="prose-body mt-3 text-[14px]">
                {pack.outstanding.total} recommendation{pack.outstanding.total === 1 ? "" : "s"} raised this month{" "}
                {pack.outstanding.total === 1 ? "is" : "are"} still open
                {pack.outstanding.truncated
                  ? ` (showing ${pack.outstanding.items.length} of ${pack.outstanding.total})`
                  : ""}
                .
              </p>
              <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                {pack.outstanding.items.map((item, i) => (
                  <li key={`${item.jobReference}-${i}`} className="p-5">
                    <p className="tnum text-[15px] font-medium">
                      {item.jobReference} · {item.propertyName}
                    </p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {item.jobTitle} · raised {dateFmt(item.raisedAt)}
                    </p>
                    <p className="prose-body mt-2 text-[14px]">{item.recommendation}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        {/* ── Spend ────────────────────────────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Receipt size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Spend
          </h2>
          <p className="prose-body mt-3 text-[14px]">
            {formatMoney(pack.spend.invoicedMinor, pack.spend.currency)} invoiced this month across{" "}
            {pack.spend.invoiceCount} invoice{pack.spend.invoiceCount === 1 ? "" : "s"}.
          </p>
        </section>

        <p className="mt-10 flex items-center gap-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
          <ClipboardText size={14} aria-hidden />
          Generated {dateFmt(pack.generatedAt)}. First-time-fix rate and contract renewal rate are not
          shown — this system does not yet record what a report would need to compute them honestly.
        </p>
      </div>
    </PortalShell>
  );
}
