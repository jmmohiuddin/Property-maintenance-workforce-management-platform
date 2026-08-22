import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant, getContract } from "@meridian/db";
import {
  BILLING_FREQUENCY_LABEL,
  COVERAGE_TYPE_DESCRIPTION,
  COVERAGE_TYPE_LABEL,
  PPM_COMPLETION_TARGET_PERCENT,
  type BillingFrequency,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  CONTRACT_STATUS_LABEL,
  VISIT_STATUS_LABEL,
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
  visitTone,
} from "../contract-ui";
import { ActivatePanel, DocumentPanel, RenewalPanel } from "./contract-panels";

export const metadata: Metadata = { title: "Contract" };
export const dynamic = "force-dynamic";

/**
 * Contract detail (`CON-2`, `CON-3`, `CON-5`, `CON-7`, `CON-8`, `CON-10`).
 *
 * Laid out as the wireframe has it: entitlements and the PPM schedule on the
 * left, because they are what somebody opens this page to check; renewal,
 * properties and documents on the right. Exclusions sit under the schedule with
 * the sentence that explains what happens when work matches one — the exclusion
 * list is meaningless without it, and it is the sentence people get wrong.
 */
export default async function ContractDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSessionWith("contracts:read");
  const canWrite = can(session.principal, "contracts:write");

  const contract = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => getContract(tx, id),
  );

  if (!contract) notFound();

  const upcoming = contract.visits.filter((v) => v.status === "planned" || v.status === "generated");
  const past = contract.visits.filter((v) => v.status === "completed" || v.status === "missed");

  return (
    <AppShell session={session} active="amc">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/amc" style={{ color: "var(--accent-text)" }}>
            &larr; Contracts
          </Link>
        </p>

        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              {contract.name}
              <span className="tnum ml-3 text-[15px] font-normal" style={{ color: "var(--text-muted)" }}>
                {contract.reference}
              </span>
            </h1>
            <p className="mt-1 text-[14px]" style={{ color: "var(--text-secondary)" }}>
              <Link href={`/customers/${contract.customerId}`} style={{ color: "var(--accent-text)" }}>
                {contract.customerName}
              </Link>{" "}
              &middot; {COVERAGE_TYPE_LABEL[contract.coverageType]} &middot;{" "}
              {formatDay(contract.startsOn)} &ndash; {formatDay(contract.endsOn)} &middot;{" "}
              {money(contract.annualValue, contract.currency)}/year &middot;{" "}
              {BILLING_FREQUENCY_LABEL[contract.billingFrequency as BillingFrequency] ??
                contract.billingFrequency}{" "}
              billing
            </p>
          </div>
          <Chip
            tone={statusTone(contract.status)}
            label={CONTRACT_STATUS_LABEL[contract.status] ?? contract.status}
          >
            {contract.activatedAt ? `activated ${formatDay(contract.activatedAt)}` : "not activated"}
          </Chip>
        </div>

        <p className="prose-body mt-2 text-[13px]">
          {COVERAGE_TYPE_DESCRIPTION[contract.coverageType]} Payment terms{" "}
          {contract.paymentTermsDays} days. Out-of-scope work is quoted at{" "}
          {(contract.discountRateBasisPoints / 100).toFixed(2)}% off the rate card.
        </p>

        <div className="mt-8 grid gap-10 lg:grid-cols-[3fr_2fr]">
          {/* ── Left column ─────────────────────────────────────────────── */}
          <div className="space-y-10">
            {/* Entitlements (CON-2, CON-5) */}
            <section aria-labelledby="entitlements-heading">
              <div id="entitlements-heading">
                <SectionHeading tone="neutral" title="Entitlements" count={contract.entitlements.length}>
                  what is owed under the term, and what is left
                </SectionHeading>
              </div>

              {contract.entitlements.length === 0 ? (
                <div className="mt-4">
                  <EmptyState tone="warning" title="No entitlement is recorded.">
                    <p>
                      This contract generates no visits and consumes nothing. A maintenance contract
                      with no entitlement is an invoice with no work behind it.
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <ul className="mt-4 space-y-2">
                  {contract.entitlements.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-[13px]"
                    >
                      <span className="font-medium">{e.label}</span>
                      <span className="tnum" style={{ color: "var(--text-secondary)" }}>
                        <Meter
                          value={e.consumedVisits}
                          max={Math.max(e.entitledForTerm, 1)}
                          tone={e.remaining <= 0 ? "critical" : "success"}
                        />{" "}
                        {e.consumedVisits} of {e.entitledForTerm} used
                        {e.remaining <= 0 ? (
                          <strong style={{ color: "var(--status-critical-text)" }}>
                            {" "}
                            &middot; exhausted
                          </strong>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>
                            {" "}
                            &middot; {e.remaining} left
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                  {/* Derived from the job list, not from a counter — a callout
                      is any job against this contract the PPM schedule did not
                      raise. Rendered the same way as the visit entitlements
                      above so the reader does not have to know the difference. */}
                  <li className="flex flex-wrap items-baseline justify-between gap-x-6 border-t pt-2 text-[13px]">
                    <span className="font-medium">Callouts</span>
                    <span className="tnum" style={{ color: "var(--text-secondary)" }}>
                      {contract.calloutsForTerm === null ? (
                        <>
                          unlimited
                          <span style={{ color: "var(--text-muted)" }}>
                            {" "}
                            &middot; {contract.consumedCallouts} used
                          </span>
                        </>
                      ) : (
                        <>
                          <Meter
                            value={contract.consumedCallouts}
                            max={Math.max(contract.calloutsForTerm, 1)}
                            tone={
                              contract.consumedCallouts >= contract.calloutsForTerm
                                ? "critical"
                                : "success"
                            }
                          />{" "}
                          {contract.consumedCallouts} of {contract.calloutsForTerm} used
                          {contract.consumedCallouts >= contract.calloutsForTerm ? (
                            <strong style={{ color: "var(--status-critical-text)" }}>
                              {" "}
                              &middot; exhausted
                            </strong>
                          ) : null}
                        </>
                      )}
                    </span>
                  </li>
                </ul>
              )}
            </section>

            {/* PPM schedule (CON-3, CON-4, CON-7) */}
            <section aria-labelledby="schedule-heading">
              <div id="schedule-heading">
                <SectionHeading
                  tone={contract.completion.meetsTarget ? "success" : "critical"}
                  title="PPM schedule"
                  count={contract.visits.length}
                >
                  target dates with a &plusmn;{contract.ppmWindowDays}-day window &middot; a job is
                  raised {contract.ppmLeadTimeDays} days ahead
                </SectionHeading>
              </div>

              <p className="tnum mt-3 text-[13px]">
                Completion{" "}
                <strong
                  style={{
                    color: contract.completion.meetsTarget
                      ? "var(--status-success-text)"
                      : "var(--status-critical-text)",
                  }}
                >
                  {contract.completion.percent}%
                </strong>{" "}
                <span style={{ color: "var(--text-muted)" }}>
                  &middot; {contract.completion.completed} done, {contract.completion.overdue}{" "}
                  overdue &middot; target {PPM_COMPLETION_TARGET_PERCENT}% (G12)
                </span>
              </p>

              {contract.visits.length === 0 ? (
                <div className="mt-4">
                  <EmptyState tone="warning" title="No visits have been generated.">
                    <p>
                      The schedule is generated when the contract is activated, for the whole term at
                      once. Until then nothing produces work and nothing is measured.
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <>
                  {upcoming.length > 0 ? (
                    <VisitTable rows={upcoming} caption="Upcoming" />
                  ) : null}
                  {past.length > 0 ? (
                    <div className="mt-6">
                      <VisitTable rows={past} caption="Completed and missed" />
                    </div>
                  ) : null}
                </>
              )}
            </section>

            {/* Exclusions (CON-2, CON-6) */}
            <section aria-labelledby="exclusions-heading">
              <div id="exclusions-heading">
                <SectionHeading tone="warning" title="Exclusions" count={contract.exclusions.length}>
                  machine-readable, so they can actually stop something
                </SectionHeading>
              </div>

              {contract.exclusions.length === 0 ? (
                <div className="mt-4">
                  <EmptyState tone="critical" title="Nothing is excluded.">
                    <p>
                      On a comprehensive contract this means compressors, fan motors, concealed
                      pipework, waterproofing, pumps, rewiring and pool plant are all covered at the
                      contract price. Each of those costs more to replace than a year of this
                      contract is worth.
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <ul className="mt-4 space-y-1.5 text-[13px]">
                  {contract.exclusions.map((e) => (
                    <li key={e.code}>
                      <span aria-hidden style={{ color: "var(--status-critical-text)" }}>
                        &#10007;{" "}
                      </span>
                      <span className="font-medium">{e.label}</span>
                      {e.description ? (
                        <span style={{ color: "var(--text-muted)" }}> &mdash; {e.description}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <p
                className="mt-4 rounded-sm border-l-2 px-4 py-3 text-[13px]"
                style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
              >
                <strong style={{ color: "var(--text-primary)" }}>What happens to excluded work:</strong>{" "}
                it raises a quote at {(contract.discountRateBasisPoints / 100).toFixed(2)}% off the
                rate card rather than being absorbed. That is the single mechanism that stops a
                comprehensive AMC becoming a loss &mdash; and the failure it prevents is not fraud,
                it is a technician on site doing the decent thing with a seized compressor while
                nobody raises a quote.
              </p>
            </section>
          </div>

          {/* ── Right column ────────────────────────────────────────────── */}
          <div className="space-y-10">
            {/* Renewal (CON-8, CON-9) */}
            <section aria-labelledby="renewal-heading">
              <div id="renewal-heading">
                <SectionHeading tone={renewalTone(contract.daysRemaining)} title="Renewal">
                  reminders at 90, 60, 30 and 7 days
                </SectionHeading>
              </div>

              <div className="mt-4 space-y-2 text-[13px]">
                <p className="tnum">
                  <Chip
                    tone={renewalTone(contract.daysRemaining)}
                    label={daysPhrase(contract.daysRemaining)}
                  >
                    {formatDay(contract.endsOn)}
                    {bandLabel(contract.daysRemaining)
                      ? ` · ${bandLabel(contract.daysRemaining)}`
                      : ""}
                  </Chip>
                </p>
                <p style={{ color: "var(--text-secondary)" }}>
                  {contract.jobsInTerm} job{contract.jobsInTerm === 1 ? "" : "s"} raised this term
                  &middot; auto-renew {contract.autoRenew ? "on" : "off"}
                </p>
                <p style={{ color: "var(--text-muted)" }}>
                  A renewal is a warning, never a block. Nothing in this system refuses an action
                  because a contract is near its end &mdash; what stops is the planned visits, on
                  the day the term does.
                </p>
              </div>

              {canWrite ? (
                <div className="mt-4">
                  <RenewalPanel contractId={contract.id} daysRemaining={contract.daysRemaining} />
                </div>
              ) : null}
            </section>

            {/* Properties */}
            <section aria-labelledby="properties-heading">
              <div id="properties-heading">
                <SectionHeading tone="neutral" title="Properties" count={contract.properties.length}>
                  each one gets its own copy of the schedule
                </SectionHeading>
              </div>
              <ul className="mt-4 space-y-1.5 text-[13px]">
                {contract.properties.map((p) => (
                  <li key={p.id}>
                    <span className="font-medium">{p.name}</span>
                    {p.area ? (
                      <span style={{ color: "var(--text-muted)" }}> &middot; {p.area}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {/* Activation (CON-3) */}
            {canWrite ? (
              <section aria-labelledby="activate-heading">
                <div id="activate-heading">
                  <SectionHeading tone="neutral" title="Schedule generation" />
                </div>
                <div className="mt-4">
                  <ActivatePanel
                    contractId={contract.id}
                    status={contract.status}
                    entitlementCount={contract.entitlements.length}
                    propertyCount={contract.properties.length}
                  />
                </div>
              </section>
            ) : null}

            {/* Documents (CON-10) */}
            <section aria-labelledby="documents-heading">
              <div id="documents-heading">
                <SectionHeading tone="neutral" title="Documents" count={contract.documents.length}>
                  versioned &mdash; an earlier one is never overwritten
                </SectionHeading>
              </div>

              {contract.documents.length === 0 ? (
                <div className="mt-4">
                  <EmptyState tone="warning" title="Nothing is attached.">
                    <p>
                      The signed contract, the scope annexe and the insurance certificates are what a
                      dispute is settled with. None of them is on file here.
                    </p>
                  </EmptyState>
                </div>
              ) : (
                <ul className="mt-4 space-y-1.5 text-[13px]">
                  {contract.documents.map((d) => (
                    <li key={d.id}>
                      <span className="font-medium">{d.title}</span>{" "}
                      <span style={{ color: "var(--text-muted)" }}>
                        &middot; {d.label} &middot; v{d.version}
                        {d.isCurrent ? "" : " (superseded)"} &middot; {formatDay(d.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              {canWrite ? (
                <details className="mt-4 rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
                  <summary className="cursor-pointer text-[13px] font-semibold">
                    Attach a document
                  </summary>
                  <div className="mt-4">
                    <DocumentPanel contractId={contract.id} />
                  </div>
                </details>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The visit list.
 *
 * A table rather than cards: this is scanned, not read, and what is compared
 * across rows is a date and a status. The window is rendered beside the target
 * because the window is the promise — the target date alone reads as an
 * appointment, and a missed appointment is a complaint where a missed window is
 * a breach.
 */
function VisitTable({
  rows,
  caption,
}: {
  rows: readonly {
    id: string;
    propertyName: string;
    serviceSlug: string | null;
    dueOn: Date;
    windowStart: Date;
    windowEnd: Date;
    status: string;
    jobId: string | null;
    jobReference: string | null;
  }[];
  caption: string;
}) {
  return (
    <div className="mt-4">
      <p className="text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
        {caption} &mdash; {rows.length}
      </p>
      <ul className="mt-2 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
        {rows.map((v) => (
          <li
            key={v.id}
            className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 p-3 text-[13px]"
          >
            <div>
              <p className="font-medium">
                {v.serviceSlug ?? "Visit"}
                <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                  {" "}
                  &middot; {v.propertyName}
                </span>
              </p>
              <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                Target {formatDay(v.dueOn)} &middot; window {formatDay(v.windowStart)} &ndash;{" "}
                {formatDay(v.windowEnd)}
                {v.jobId && v.jobReference ? (
                  <>
                    {" "}
                    &middot;{" "}
                    <Link href={`/jobs/${v.jobId}`} style={{ color: "var(--accent-text)" }}>
                      {v.jobReference}
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
            <Chip tone={visitTone(v.status)} label={VISIT_STATUS_LABEL[v.status] ?? v.status} />
          </li>
        ))}
      </ul>
    </div>
  );
}
