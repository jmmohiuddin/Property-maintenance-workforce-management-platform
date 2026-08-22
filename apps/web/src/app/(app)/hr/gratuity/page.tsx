import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  gratuityRegister,
  gratuityLiability,
  listGratuitySettlements,
} from "@meridian/db";
import { can } from "@meridian/auth";
import {
  formatDay,
  formatMoney,
  today,
  GRATUITY_DAYS_PER_YEAR_FIRST_FIVE,
  GRATUITY_DAYS_PER_YEAR_THEREAFTER,
  GRATUITY_TIER_BOUNDARY_YEARS,
  GRATUITY_CAP_MONTHS_OF_WAGE,
  GRATUITY_SETTLEMENT_DAYS,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SectionHeading, EmptyState, daysPhrase } from "../../workforce/compliance-ui";
import { SettleGratuity, PayGratuity } from "../gratuity-forms";

export const metadata: Metadata = { title: "End-of-service gratuity" };
export const dynamic = "force-dynamic";

/**
 * The accrued gratuity liability, and the settlements against it (`HR-13`).
 *
 * ── WHY THIS IS A LIABILITY SCREEN AND NOT A CALCULATOR ─────────────────────
 *
 * The requirement's own words are "accrued and visible as a liability so it is
 * never a surprise". A calculator answers a question somebody already knows to
 * ask; the surprise `HR-13` is about is the one that arrives with a resignation
 * letter, when a figure nobody had been carrying becomes payable in fourteen
 * days. So the total comes first, before any individual, and the per-employee
 * rows exist to explain it rather than to be looked up one at a time.
 *
 * The arithmetic is deliberately restated on the page. Every leaver checks it,
 * and a number that cannot be reproduced by hand is a number that gets argued
 * about — which is the outcome the requirement exists to prevent.
 */
export default async function GratuityPage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");
  const now = today();

  const { register, liability, settlements } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      register: await gratuityRegister(tx, now),
      liability: await gratuityLiability(tx, now),
      settlements: await listGratuitySettlements(tx, now),
    }),
  );

  const accruing = register.filter((r) => r.accrual?.eligible);
  const waiting = register.filter((r) => r.accrual && !r.accrual.eligible);
  const uncomputable = register.filter((r) => r.problem !== null);
  const unpaid = settlements.filter((s) => s.paidOn === null);
  const overdue = unpaid.filter((s) => s.overdue);
  const paid = settlements.filter((s) => s.paidOn !== null);

  // Only employees with a computable figure can be settled. Offering the others
  // would produce a refusal at the end of a form somebody had already filled in.
  const settleable = accruing
    .filter((r) => !r.settled)
    .map((r) => ({
      id: r.employeeId,
      name: r.fullName,
      accrued: formatMoney(r.accrual?.amountMinor ?? 0),
    }));

  return (
    <AppShell session={session} active="hr">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/hr" style={{ color: "var(--accent-text)" }}>
            &larr; Employment lifecycle
          </Link>
        </p>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">
          End-of-service gratuity
        </h1>
        <p className="prose-body mt-2 text-[14px]">
          {GRATUITY_DAYS_PER_YEAR_FIRST_FIVE} days&rsquo; <strong>basic</strong> pay for each of the
          first {GRATUITY_TIER_BOUNDARY_YEARS} years and {GRATUITY_DAYS_PER_YEAR_THEREAFTER} days for
          each year after that, capped at {GRATUITY_CAP_MONTHS_OF_WAGE} months of the{" "}
          <em>total</em> wage, with nothing at all below one year of continuous service. Housing,
          transport, utilities and furniture allowances are excluded from the accrual &mdash; they
          count only towards the cap. Everything owed is payable within{" "}
          {GRATUITY_SETTLEMENT_DAYS} days of termination.
        </p>

        {/* ── 1. The liability, which is the whole point of the screen ───── */}
        <div className="mt-8 rounded-sm border-l-2 px-5 py-4"
             style={{ borderColor: "var(--accent-text)", backgroundColor: "var(--surface-raised)" }}>
          <p className="text-[13px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Accrued liability today
          </p>
          <p className="tnum mt-1 text-3xl font-semibold">{formatMoney(liability.totalMinor)}</p>
          <p className="prose-body mt-2 text-[13px]">{liability.headline}</p>
          {liability.uncomputableCount > 0 ? (
            <p className="mt-2 text-[13px]" style={{ color: "var(--status-warning-text)" }}>
              {liability.uncomputableCount} employment record
              {liability.uncomputableCount === 1 ? " has" : "s have"} no service start date or no
              basic salary on file, so this total is understated by whatever they have earned.
            </p>
          ) : null}
          {liability.nextEligible ? (
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Next to cross one year: {liability.nextEligible.fullName} on{" "}
              {formatDay(liability.nextEligible.on)}.
            </p>
          ) : null}
        </div>

        {/* ── 2. Settlements past the 14-day deadline ─────────────────────── */}
        {overdue.length > 0 ? (
          <section className="mt-10">
            <SectionHeading tone="blocked" title="Overdue settlements" count={overdue.length}>
              All end-of-service dues are payable within {GRATUITY_SETTLEMENT_DAYS} days of
              termination.
            </SectionHeading>
            <ul className="mt-4 space-y-3">
              {overdue.map((s) => (
                <li
                  key={s.id}
                  className="rounded-sm border-l-2 px-4 py-3"
                  style={{
                    borderColor: "var(--status-critical-border)",
                    backgroundColor: "var(--status-critical-wash)",
                  }}
                >
                  <p className="text-[14px] font-medium">
                    {s.fullName} &mdash;{" "}
                    <span className="tnum">{formatMoney(s.amountMinor)}</span>
                  </p>
                  <p className="mt-1 text-[13px]">{s.deadline.headline}</p>
                  {canWrite ? <PayGratuity settlementId={s.id} label={s.fullName} today={now} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── 3. Recorded but not yet paid ────────────────────────────────── */}
        {unpaid.length > overdue.length ? (
          <section className="mt-10">
            <SectionHeading tone="warning" title="Awaiting payment" count={unpaid.length - overdue.length}>
              Within the {GRATUITY_SETTLEMENT_DAYS}-day window, and counting down.
            </SectionHeading>
            <ul className="mt-4 space-y-3">
              {unpaid
                .filter((s) => !s.overdue)
                .map((s) => (
                  <li key={s.id} className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
                    <p className="text-[14px] font-medium">
                      {s.fullName} &mdash;{" "}
                      <span className="tnum">{formatMoney(s.amountMinor)}</span>
                    </p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      Terminated {formatDay(s.terminatedOn)} &middot; due {formatDay(s.dueOn)} &middot;{" "}
                      {daysPhrase(s.deadline.daysRemaining)}
                    </p>
                    {canWrite ? <PayGratuity settlementId={s.id} label={s.fullName} today={now} /> : null}
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        {/* ── 4. The register itself ──────────────────────────────────────── */}
        <section className="mt-10">
          <SectionHeading tone="success" title="Accruing" count={accruing.length}>
            One year of continuous service or more.
          </SectionHeading>

          {accruing.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="Nobody has completed a year of continuous service.">
                <p>
                  Gratuity accrues from the first anniversary. Until then the liability is genuinely
                  zero &mdash; but it becomes payable in full on the day somebody crosses that line,
                  which is why the date is worth watching rather than the balance.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {accruing.map((r) => (
                <li key={r.employeeId} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <p className="text-[14px] font-medium">
                      {r.fullName}
                      {r.employeeNo ? (
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {r.employeeNo}
                        </span>
                      ) : null}
                      {r.settled ? (
                        <span className="ml-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          settled
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      From {r.serviceStart ? formatDay(r.serviceStart) : "—"} &middot;{" "}
                      {r.accrual?.explanation}
                    </p>
                    {/* The two bases, side by side, because the difference
                        between them is the whole requirement. */}
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Basic {formatMoney(r.basicMonthlyMinor ?? 0)}/month
                      {r.allowancesMinor > 0
                        ? ` · allowances ${formatMoney(r.allowancesMinor)}/month, excluded from the accrual`
                        : ""}
                    </p>
                  </div>
                  <p className="tnum text-[15px] font-semibold">
                    {formatMoney(r.accrual?.amountMinor ?? 0)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {waiting.length > 0 ? (
          <section className="mt-10">
            <SectionHeading tone="warning" title="Under one year" count={waiting.length}>
              Nothing has accrued yet, and the whole first year lands at once when it does.
            </SectionHeading>
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {waiting.map((r) => (
                <li key={r.employeeId} className="p-4">
                  <p className="text-[14px] font-medium">{r.fullName}</p>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {r.accrual?.explanation}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {uncomputable.length > 0 ? (
          <section className="mt-10">
            <SectionHeading tone="critical" title="Cannot be computed" count={uncomputable.length}>
              Missing from the liability above, in the direction that says the business owes less
              than it does.
            </SectionHeading>
            <ul className="mt-4 space-y-3">
              {uncomputable.map((r) => (
                <li
                  key={r.employeeId}
                  className="rounded-sm border-l-2 px-4 py-3 text-[13px]"
                  style={{
                    borderColor: "var(--status-critical-border)",
                    backgroundColor: "var(--status-critical-wash)",
                  }}
                >
                  <p className="text-[14px] font-medium">{r.fullName}</p>
                  <p className="mt-1">{r.problem}</p>
                  <p className="mt-1">
                    <Link href={`/workforce/${r.employeeId}`} style={{ color: "var(--accent-text)" }}>
                      Open the employment record &rarr;
                    </Link>
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {paid.length > 0 ? (
          <section className="mt-10">
            <SectionHeading tone="success" title="Settled and paid" count={paid.length} />
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {paid.map((s) => (
                <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-4">
                  <div>
                    <p className="text-[14px] font-medium">{s.fullName}</p>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Terminated {formatDay(s.terminatedOn)} &middot; paid{" "}
                      {s.paidOn ? formatDay(s.paidOn) : "—"} &middot; {s.paymentReference}
                      {s.capApplied ? " · capped at two years’ total wages" : ""}
                    </p>
                  </div>
                  <p className="tnum text-[14px]">{formatMoney(s.amountMinor)}</p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-10">
          {canWrite ? (
            settleable.length > 0 ? (
              <SettleGratuity employees={settleable} today={now} />
            ) : (
              <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                Nobody is currently eligible for a settlement that has not already been recorded.
              </p>
            )
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              Your role can read this register but not change it.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
