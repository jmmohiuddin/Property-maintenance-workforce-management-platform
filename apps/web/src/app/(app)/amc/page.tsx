import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  listContracts,
  renewalPipeline,
  ppmCompliance,
  contractableProperties,
  searchCustomers,
} from "@meridian/db";
import {
  PPM_COMPLETION_TARGET_PERCENT,
  RENEWAL_PIPELINE_DAYS,
  COVERAGE_TYPE_LABEL,
  amcServices,
  type CoverageType,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  CONTRACT_STATUS_LABEL,
  Chip,
  EmptyState,
  Meter,
  SectionHeading,
  bandLabel,
  daysPhrase,
  formatDay,
  money,
  renewalTone,
  statusTone,
} from "./contract-ui";
import { NewContractForm } from "./new-contract-form";

export const metadata: Metadata = { title: "Contracts and AMC" };
export const dynamic = "force-dynamic";

/**
 * The contracts board (`CON-1`, `CON-7`, `CON-8`).
 *
 * Consequence-ordered, like every other operator surface in this app. The
 * renewal pipeline is first because a silently expired AMC is the most
 * expensive failure mode in this business model — it stops generating work
 * without stopping anything visible — and PPM completion is second because it
 * is the number an OA management company asks for at renewal (`G12`). The list
 * of contracts, which is what a reader expects at the top, is third, because it
 * is the part that needs nothing doing to it.
 *
 * Nothing on this page blocks. A contract near its end is warned about; the
 * three hard blocks in this system all have a statutory penalty behind them and
 * a renewal has a commercial one.
 */
export default async function ContractsPage() {
  const session = await requireSessionWith("contracts:read");
  const canWrite = can(session.principal, "contracts:write");

  const { contracts, renewals, compliance, properties, customers } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      contracts: await listContracts(tx),
      renewals: await renewalPipeline(tx),
      compliance: await ppmCompliance(tx),
      properties: canWrite ? await contractableProperties(tx) : [],
      // `searchCustomers`, not `listCustomers`. TD-10: the unbounded list read
      // every customer, then every open job, then every unpaid invoice, and
      // joined them in JavaScript — to fill a picker that needs a name and a
      // code. This is one bounded query, and the form below still shows what it
      // showed before.
      customers: canWrite ? (await searchCustomers(tx, { limit: 100 })).rows : [],
    }),
  );

  // The aggregate `CON-7` figure: one number across every contract, computed
  // from the same completed/overdue counts as each contract's own. Summing the
  // per-contract percentages instead would weight a one-visit contract the same
  // as a 200-visit portfolio.
  const totalCompleted = compliance.reduce((sum, c) => sum + c.completed, 0);
  const totalOverdue = compliance.reduce((sum, c) => sum + c.overdue, 0);
  const totalDue = totalCompleted + totalOverdue;
  const aggregatePercent = totalDue === 0 ? null : Math.round((totalCompleted / totalDue) * 100);

  const expired = renewals.filter((r) => r.daysRemaining < 0);
  const upcoming = renewals.filter((r) => r.daysRemaining >= 0);
  const active = contracts.filter((c) => c.status === "active");

  return (
    <AppShell session={session} active="amc">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Contracts and AMC</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            Active <strong style={{ color: "var(--text-primary)" }}>{active.length}</strong> &middot;
            Renewing <strong style={{ color: "var(--text-primary)" }}>{upcoming.length}</strong>{" "}
            &middot; Expired{" "}
            <strong
              style={{
                color: expired.length > 0 ? "var(--status-critical-text)" : "var(--text-primary)",
              }}
            >
              {expired.length}
            </strong>
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">
          An AMC is not a record of an agreement — it generates its own planned visits, turns each
          into a job three weeks before it is due, and decrements the entitlement when one
          completes. Work that matches an exclusion raises a quote at the contract discount rather
          than being absorbed, which is the single mechanism that stops a comprehensive contract
          becoming a loss.
        </p>

        {/* ── 1. Renewals ───────────────────────────────────────────────── */}
        <section aria-labelledby="renewals-heading" className="mt-10">
          <div id="renewals-heading">
            <SectionHeading
              tone={expired.length > 0 ? "critical" : "warning"}
              title="Renewal pipeline"
              count={renewals.length}
            >
              inside {RENEWAL_PIPELINE_DAYS} days of expiry, plus anything already lapsed
            </SectionHeading>
          </div>

          {/*
            CON-8 asks for margin at renewal and this page does not show it.
            Said here rather than left as a blank space, because an absent
            number reads as an oversight and somebody eventually fills it with
            an estimate.
          */}
          <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
            No margin figure is shown, and that is deliberate. The system records what a contract
            is worth and not what it costs to service — there is no labour or material cost
            anywhere in the schema — so a margin here would be estimated rather than measured, and
            a made-up number that looks precise is worse than no number at renewal. Utilisation
            and the job count in the term are what these rows are renewed on.
          </p>

          {renewals.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                tone={active.length === 0 ? "warning" : "success"}
                title={
                  active.length === 0
                    ? "Nothing is renewing, because nothing is active."
                    : `No contract expires in the next ${RENEWAL_PIPELINE_DAYS} days.`
                }
              >
                {active.length === 0 ? (
                  <p>
                    There are no active contracts, so there is no renewal pipeline and no planned
                    maintenance being generated. A contract has to be activated before it produces
                    anything.
                  </p>
                ) : (
                  <p>
                    Reminders go to the owner and sales at 90, 60, 30 and 7 days, and an expired
                    contract is reported every morning until it is renewed or closed. Nothing here
                    depends on somebody remembering to look at this page.
                  </p>
                )}
              </EmptyState>
            </div>
          ) : (
            <ul
              className="mt-4 divide-y rounded border"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {renewals.map((r) => (
                <li key={r.contractId}>
                  <Link
                    href={`/amc/${r.contractId}`}
                    className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4"
                  >
                    <div>
                      <p className="text-[14px] font-medium">
                        {r.name}
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {r.reference}
                        </span>
                      </p>
                      <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                        {r.customerName} &middot; {money(r.annualValue, r.currency)}/year &middot;{" "}
                        {r.jobsInTerm} job{r.jobsInTerm === 1 ? "" : "s"} this term
                        {r.autoRenew ? " · auto-renews" : ""}
                      </p>
                      <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Entitlement {r.consumedVisits} of {r.entitledVisits}{" "}
                        <Meter
                          value={r.consumedVisits}
                          max={Math.max(r.entitledVisits, 1)}
                          tone={r.utilisationPercent > 100 ? "critical" : "success"}
                        />{" "}
                        {r.entitledVisits > 0 ? `${r.utilisationPercent}% utilisation` : null}
                      </p>
                    </div>
                    <Chip
                      tone={renewalTone(r.daysRemaining)}
                      label={
                        r.daysRemaining < 0
                          ? `EXPIRED — ${daysPhrase(r.daysRemaining)}`
                          : daysPhrase(r.daysRemaining)
                      }
                    >
                      {formatDay(r.endsOn)}
                      {bandLabel(r.daysRemaining) ? ` · ${bandLabel(r.daysRemaining)}` : ""}
                    </Chip>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 2. PPM completion ─────────────────────────────────────────── */}
        <section aria-labelledby="completion-heading" className="mt-10">
          <div id="completion-heading">
            <SectionHeading
              tone={
                aggregatePercent === null
                  ? "neutral"
                  : aggregatePercent >= PPM_COMPLETION_TARGET_PERCENT
                    ? "success"
                    : "critical"
              }
              title="PPM completion"
            >
              target {PPM_COMPLETION_TARGET_PERCENT}% (G12) &middot; the number an OA management
              company asks for at renewal
            </SectionHeading>
          </div>

          {aggregatePercent === null ? (
            <div className="mt-4">
              <EmptyState tone="neutral" title="No visit has come due yet.">
                <p>
                  Completion is measured against visits whose window has closed, not against every
                  visit in the term. A contract in its first month would otherwise report 8% and
                  look like it was failing, which is how a metric gets ignored.
                </p>
              </EmptyState>
            </div>
          ) : (
            <>
              <p className="tnum mt-4 text-[28px] font-semibold tracking-tight">
                {aggregatePercent}%
                <span
                  className="ml-3 text-[13px] font-normal"
                  style={{ color: "var(--text-secondary)" }}
                >
                  {totalCompleted} of {totalDue} due visits carried out
                  {totalOverdue > 0 ? ` · ${totalOverdue} overdue` : ""}
                </span>
              </p>

              <ul
                className="mt-4 divide-y rounded border"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                {compliance
                  // Worst first. A list sorted by reference buries the one
                  // contract that will be argued about at renewal.
                  .filter((c) => c.completed + c.overdue > 0)
                  .sort((a, b) => a.percent - b.percent)
                  .map((c) => (
                    <li key={c.contractId}>
                      <Link
                        href={`/amc/${c.contractId}`}
                        className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-4"
                      >
                        <p className="text-[14px] font-medium">
                          {c.name}
                          <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                            {" "}
                            &middot; {c.reference}
                          </span>
                        </p>
                        <span
                          className="tnum text-[13px] font-medium"
                          style={{
                            color: c.meetsTarget
                              ? "var(--status-success-text)"
                              : "var(--status-critical-text)",
                          }}
                        >
                          {c.percent}%{" "}
                          <Meter
                            value={c.percent}
                            max={100}
                            tone={c.meetsTarget ? "success" : "critical"}
                          />{" "}
                          <span className="font-normal" style={{ color: "var(--text-muted)" }}>
                            {c.completed} done
                            {c.overdue > 0 ? `, ${c.overdue} overdue` : ""}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>

        {/* ── 3. Every contract ─────────────────────────────────────────── */}
        <section aria-labelledby="contracts-heading" className="mt-10">
          <div id="contracts-heading">
            <SectionHeading tone="neutral" title="Contracts" count={contracts.length}>
              drafts, active terms and anything expired but not yet closed
            </SectionHeading>
          </div>

          {contracts.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No contracts yet.">
                <p>
                  The <code>contracts</code> table has existed since the first migration and has
                  never had a row in it. Until it does, every planned-maintenance figure on this
                  page is a report about nothing.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul
              className="mt-4 divide-y rounded border"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {contracts.map((c) => (
                <li key={c.id}>
                  <Link href={`/amc/${c.id}`} className="block p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <p className="text-[14px] font-medium">
                        {c.name}
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {c.reference}
                        </span>
                        <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                          {" "}
                          &middot; {c.customerName}
                        </span>
                      </p>
                      <Chip tone={statusTone(c.status)} label={CONTRACT_STATUS_LABEL[c.status] ?? c.status}>
                        {formatDay(c.startsOn)} &ndash; {formatDay(c.endsOn)}
                      </Chip>
                    </div>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {COVERAGE_TYPE_LABEL[c.coverageType as CoverageType] ?? c.coverageType}{" "}
                      &middot; {money(c.annualValue, c.currency)}/year &middot; {c.billingFrequency}{" "}
                      billing &middot; {c.propertyCount}{" "}
                      {c.propertyCount === 1 ? "property" : "properties"} &middot;{" "}
                      {c.plannedVisits} planned, {c.completedVisits} done
                      {c.overdueVisits > 0 ? (
                        <span style={{ color: "var(--status-critical-text)" }}>
                          , {c.overdueVisits} overdue
                        </span>
                      ) : null}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 4. Create ─────────────────────────────────────────────────── */}
        {canWrite ? (
          <section className="mt-10">
            <NewContractForm
              customers={customers.map((c) => ({ id: c.id, name: c.name, code: c.code }))}
              properties={properties.map((p) => ({
                id: p.id,
                name: p.name,
                area: p.area,
                customerId: p.customerId,
                customerName: p.customerName,
                activeContracts: p.activeContracts,
              }))}
              services={amcServices.map((s) => ({ slug: s.slug, name: s.name }))}
            />
          </section>
        ) : (
          <p className="mt-10 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Your role can read contracts but not change them. Sales, an administrator or the owner
            can write and activate them.
          </p>
        )}

        <p className="mt-10 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Tenders (<code>CON-11</code>, <code>CON-12</code>) and the per-property asset register
          (<code>CON-13</code>) are specified and not built. Per-asset PPM is how commercial AMCs
          are priced, so contracts written now schedule by service and property rather than by
          asset.
        </p>
      </div>
    </AppShell>
  );
}
