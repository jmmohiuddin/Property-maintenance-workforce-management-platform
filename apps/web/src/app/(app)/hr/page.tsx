import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, hrLifecycleSummary } from "@meridian/db";
import {
  formatDay,
  formatMoney,
  WPS_MINIMUM_TRANSFER_PERCENT,
  MAX_OVERTIME_MINUTES_PER_DAY,
  LEAVE_NOTICE_DAYS,
  SICK_LEAVE_FULL_PAY_DAYS,
  SICK_LEAVE_HALF_PAY_DAYS,
  SICK_LEAVE_TOTAL_DAYS,
  ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR,
  GRATUITY_SETTLEMENT_DAYS,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SectionHeading, EmptyState, daysPhrase } from "../workforce/compliance-ui";
import { WpsBanner, type WpsSeverity } from "./wps-banner";

export const metadata: Metadata = { title: "Employment lifecycle" };
export const dynamic = "force-dynamic";

/**
 * The employment lifecycle board (`HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`).
 *
 * Sibling to `/workforce`, and the split between them is by *question*, not by
 * table. `/workforce` answers "may this person legally be sent to work today" —
 * documents, expiries, hard blocks. This page answers "what does the employment
 * relationship owe, and by when" — wages, contract terms, leave, hours, cover.
 * Merging them would produce one screen where a leave balance sits under a
 * lapsed work permit, and the lapsed work permit would stop being the first
 * thing anybody sees.
 *
 * Consequence order, as everywhere else in this application: wages first,
 * because the WPS escalation costs the ability to hire within five days and
 * nothing else here moves that fast.
 */
export default async function HrPage() {
  const session = await requireSessionWith("workforce:read");

  const summary = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => hrLifecycleSummary(tx, { tenantId: session.principal.tenantId }),
  );

  const { wages, unsettled, permitWarning, contracts, leave, hoursExceptions, hoursWarning } = summary;
  const { sickLeave, weeklyBreaches } = summary;
  const { gratuity, gratuityOverdue, emiratisation, subcontractorExpiries } = summary;
  // Already lapsed, as opposed to lapsing. The card leads with the count that
  // has a consequence attached today rather than with the horizon total.
  const subcontractorLapsed = subcontractorExpiries.filter((e) => e.daysRemaining < 0).length;
  // Anyone who has used more than the full-pay stage. Everybody else's sick
  // leave is on their own record; what belongs on a board is the position that
  // has a consequence attached — the next day of illness is paid at half.
  const sickStaged = sickLeave.filter((r) => r.halfPayDays > 0 || r.unpaidDays > 0 || r.beyondEntitlementDays > 0);

  const olderUnsettled = unsettled.filter((c) => c.id !== wages.id);
  const autoRenewed = contracts.filter((c) => c.state === "auto_renewed");
  const probation = contracts.filter((c) => c.state === "probation");
  const expiring = contracts.filter((c) => c.state === "expiring");
  const defective = contracts.filter((c) => c.problems.length > 0);
  // Everything the four groups above do not claim — today that is "no contract
  // recorded at all", which `contractAlerts` returns with state `active`.
  // Without this the heading counted a row the page had no group to render, so
  // the section read "Contracts — 1" above an empty space, and the one employee
  // with no contract on file was the one it hid.
  const ungrouped = contracts.filter(
    (c) =>
      c.problems.length === 0 &&
      c.state !== "auto_renewed" &&
      c.state !== "probation" &&
      c.state !== "expiring",
  );
  const shortNotice = leave.filter((l) => l.shortNoticeCount > 0);

  return (
    <AppShell session={session} active="hr">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Employment lifecycle</h1>
          <p className="text-[13px]">
            <Link href="/workforce" style={{ color: "var(--accent-text)" }}>
              Workforce compliance &mdash; documents and dispatch blocks &rarr;
            </Link>
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">
          Wages, contracts, leave, hours and health cover. Nothing on this page blocks a dispatch
          &mdash; the three things that do are documents, and they live on the workforce board. What
          is here instead runs on deadlines: wages are due on the 1st, a contract that runs past its
          end date has already renewed, and probation cannot be extended once it ends.
        </p>

        {/* ── 1. WPS — the fastest-moving consequence in the business ────── */}
        <div className="mt-8">
          <WpsBanner
            label={wages.assessment.label}
            headline={wages.assessment.headline}
            consequence={wages.assessment.consequence}
            severity={wages.assessment.severity as WpsSeverity}
            stage={wages.assessment.stage}
            daysUntilDue={wages.assessment.daysUntilDue}
            daysLate={wages.assessment.daysLate}
            dueOn={formatDay(wages.dueOn)}
            transferredBasisPoints={wages.assessment.transferredBasisPoints}
            thresholdPercent={WPS_MINIMUM_TRANSFER_PERCENT}
            totalDueMinor={wages.totalDueMinor}
            totalTransferredMinor={wages.totalTransferredMinor}
            employeeCount={wages.employeeCount}
            fileDue={wages.assessment.fileDue}
            filePreparedOn={wages.filePreparedOn ? formatDay(wages.filePreparedOn) : null}
            href="/hr/payroll"
          />
        </div>

        {/* A month that went unpaid does not stop mattering when the next
            countdown starts. The ladder is still climbing on it. */}
        {olderUnsettled.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {olderUnsettled.map((c) => (
              <li
                key={c.id}
                className="rounded-sm border-l-2 px-4 py-3 text-[13px]"
                style={{ borderColor: "var(--status-blocked)", color: "var(--text-secondary)" }}
              >
                <strong style={{ color: "var(--status-blocked-text)" }}>
                  {c.assessment.label} is still unsettled &mdash; {c.assessment.daysLate} days late.
                </strong>{" "}
                {c.assessment.consequence}
              </li>
            ))}
          </ul>
        ) : null}

        {permitWarning ? (
          <div className="mt-4">
            <EmptyState tone="blocked" title="New work-permit issuance is suspended">
              <p>{permitWarning}</p>
              <p className="mt-2">
                This is a warning, not a block. The suspension happens at MOHRE, not here &mdash;
                recording who you intend to employ is not the act that was suspended, and refusing
                to let anybody write a name down would only move the name somewhere this system
                cannot see it.
              </p>
            </EmptyState>
          </div>
        ) : null}

        {summary.wageGaps.length > 0 ? (
          <div className="mt-4">
            <EmptyState
              tone="critical"
              title={`A transfer today would not reach ${summary.wageGaps.length} ${summary.wageGaps.length === 1 ? "person" : "people"}`}
            >
              <ul className="space-y-1">
                {summary.wageGaps.map((g) => (
                  <li key={g.employeeId}>
                    <Link href={`/workforce/${g.employeeId}`} style={{ color: "var(--accent-text)" }}>
                      {g.fullName}
                    </Link>{" "}
                    &mdash; {g.reason}
                  </li>
                ))}
              </ul>
              <p className="mt-2">
                Each reason fails differently, which is why they are stated per person: a missing
                IBAN leaves the wage in the total and unpayable, so the {WPS_MINIMUM_TRANSFER_PERCENT}
                % test fails <em>and</em> somebody is unpaid; a missing salary leaves them out of the
                total, so the test passes at 100% while somebody is unpaid. The second is worse,
                because it looks like compliance.
              </p>
            </EmptyState>
          </div>
        ) : null}

        {/* ── 2. Contracts ──────────────────────────────────────────────── */}
        <section aria-labelledby="contracts-heading" className="mt-10">
          <div id="contracts-heading">
            <SectionHeading tone="critical" title="Contracts" count={contracts.length}>
              fixed-term only, and a term that ran on has already renewed
            </SectionHeading>
          </div>

          {autoRenewed.length > 0 ? (
            <div className="mt-4">
              <p className="text-[13px] font-semibold" style={{ color: "var(--status-critical-text)" }}>
                Renewed by operation of law &mdash; {autoRenewed.length}
              </p>
              <p className="prose-body mt-1 text-[12px]">
                The recorded term ended and work continued, so the contract renewed on the same
                terms. The nightly sweep records the renewed term; this list is what it found. If
                the terms were meant to change, a fresh contract has to be issued &mdash; the
                renewal has already happened either way.
              </p>
              <ContractList rows={autoRenewed} />
            </div>
          ) : null}

          {probation.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-semibold" style={{ color: "var(--status-warning-text)" }}>
                On probation &mdash; {probation.length}
              </p>
              <p className="prose-body mt-1 text-[12px]">
                Maximum six months, non-extendable, and 14 days&rsquo; notice from the employer.
                Once it ends the notice period jumps to 30&ndash;90 days, so the decision has a
                deadline whether or not anybody has made it.
              </p>
              <ContractList rows={probation} />
            </div>
          ) : null}

          {expiring.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                Ending within 90 days &mdash; {expiring.length}
              </p>
              <ContractList rows={expiring} />
            </div>
          ) : null}

          {defective.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-semibold" style={{ color: "var(--status-critical-text)" }}>
                Statutory defects &mdash; {defective.length}
              </p>
              <p className="prose-body mt-1 text-[12px]">
                Each of these is a clause that will not hold if it is tested. A nine-month probation
                is void in that clause; a 14-day post-probation notice is unenforceable, and it is
                the employer&rsquo;s notice that fails.
              </p>
              <ul className="mt-2 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                {defective.map((c) => (
                  <li key={`${c.employeeId}-defect`} className="p-4">
                    <Link href={`/workforce/${c.employeeId}`} className="text-[14px] font-medium">
                      {c.fullName}
                    </Link>
                    <ul className="mt-1 space-y-1 text-[12px]" style={{ color: "var(--status-critical-text)" }}>
                      {c.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {ungrouped.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-semibold" style={{ color: "var(--status-critical-text)" }}>
                Nothing on file &mdash; {ungrouped.length}
              </p>
              <p className="prose-body mt-1 text-[12px]">
                Not a lesser problem than the ones above &mdash; a worse one. Nothing here knows when
                these contracts end, so nothing can tell you they have renewed, and the auto-renewal
                happens regardless.
              </p>
              <ContractList rows={ungrouped} />
            </div>
          ) : null}

          {contracts.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="No contract needs anything doing to it.">
                <p>
                  Nothing has auto-renewed unnoticed, no probation period is running out, and
                  nothing ends inside 90 days. Contracts with no dates recorded at all would appear
                  here too, so this also means every active employee has a contract on file.
                </p>
              </EmptyState>
            </div>
          ) : null}
        </section>

        {/* ── 3. Health insurance ───────────────────────────────────────── */}
        <section aria-labelledby="insurance-heading" className="mt-10">
          <div id="insurance-heading">
            <SectionHeading tone="critical" title="Health insurance" count={summary.insuranceGaps.length}>
              employer-funded, and never deductible from salary
            </SectionHeading>
          </div>

          {summary.insuranceGaps.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="Every active employee has the cover the law requires.">
                <p>
                  Mandatory in Dubai under Law No. 11 of 2013, employer-funded, and the premium may
                  not be deducted from salary &mdash; which is enforced structurally: there is no
                  deduction type that can hold it, in the form, in the domain layer or in the
                  database.
                </p>
              </EmptyState>
            </div>
          ) : (
            <>
              <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                {summary.insuranceGaps.map((row) => (
                  <li key={row.employeeId} className="p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                      <Link href={`/workforce/${row.employeeId}`} className="text-[14px] font-medium">
                        {row.fullName}
                      </Link>
                      <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        Requires{" "}
                        {row.requiredPlan === "essential_benefits"
                          ? "an Essential Benefits Plan"
                          : "a standard plan"}
                      </span>
                    </div>
                    <ul className="mt-1 space-y-1 text-[12px]" style={{ color: "var(--status-critical-text)" }}>
                      {row.problems.map((problem) => (
                        <li key={problem}>{problem}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              <p className="prose-body mt-3 text-[12px]">
                Workers paid under AED {ESSENTIAL_BENEFITS_WAGE_CEILING_MINOR / 100} a month require
                an Essential Benefits Plan specifically. A policy of the wrong tier is
                non-compliant in the same way as no policy at all, and the penalty runs monthly from
                AED 500 to AED 150,000 while it blocks visa processing.
              </p>
            </>
          )}
        </section>

        {/* ── 4. Leave ──────────────────────────────────────────────────── */}
        <section aria-labelledby="leave-heading" className="mt-10">
          <div id="leave-heading">
            <SectionHeading tone="warning" title="Annual leave" count={leave.length}>
              30 days after a year; 2 days a month between six and twelve
            </SectionHeading>
          </div>

          {leave.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No active employment records, so no leave to account for.">
                <p>
                  Entitlement is computed from the service start date. Until there are employment
                  records with a contract start on them, this list is empty because nothing is being
                  counted &mdash; not because everybody has taken their leave.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {leave.map((row) => (
                <li key={row.employeeId} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <Link href={`/workforce/${row.employeeId}`} className="text-[14px] font-medium">
                      {row.fullName}
                    </Link>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {row.basis}
                    </p>
                  </div>
                  <p className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    <strong style={{ color: "var(--text-primary)" }}>{row.remainingDays}</strong>{" "}
                    remaining &middot; {row.takenDays} taken &middot; {row.accruedDays} accrued of{" "}
                    {row.entitlementDays}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {shortNotice.length > 0 ? (
            <p
              className="mt-3 rounded-sm border-l-2 px-4 py-3 text-[13px]"
              style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
            >
              <strong style={{ color: "var(--text-primary)" }}>
                {shortNotice.length} upcoming leave{" "}
                {shortNotice.length === 1 ? "period was" : "periods were"} approved with less than{" "}
                {LEAVE_NOTICE_DAYS} days&rsquo; notice.
              </strong>{" "}
              Flagged, not refused. Leave agreed at short notice by consent is lawful; leave{" "}
              <em>imposed</em> at short notice is not, and only the record of who asked distinguishes
              them.
            </p>
          ) : null}
        </section>

        {/* ── 4b. Sick leave — a separate entitlement, on its own ladder ─── */}
        <section aria-labelledby="sick-heading" className="mt-10">
          <div id="sick-heading">
            <SectionHeading tone="warning" title="Sick leave" count={sickLeave.length}>
              {SICK_LEAVE_FULL_PAY_DAYS} days at full pay, then {SICK_LEAVE_HALF_PAY_DAYS} at half,
              then 45 unpaid
            </SectionHeading>
          </div>

          {sickLeave.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="success" title="No sick leave recorded in anybody's current leave year.">
                <p>
                  Sick leave is a separate entitlement from annual leave and does not come out of it.
                  After probation the ladder is {SICK_LEAVE_FULL_PAY_DAYS} days at full pay, then{" "}
                  {SICK_LEAVE_HALF_PAY_DAYS} at half, then 45 unpaid &mdash;{" "}
                  {SICK_LEAVE_TOTAL_DAYS} days a year, consumed in that order and carried across
                  absences. Record an absence on the employment record and the staging follows from
                  the leave year rather than from the absence.
                </p>
              </EmptyState>
            </div>
          ) : (
            <>
              <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                {sickLeave.map((row) => (
                  <li
                    key={row.employeeId}
                    className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4"
                  >
                    <div>
                      <Link href={`/workforce/${row.employeeId}`} className="text-[14px] font-medium">
                        {row.fullName}
                      </Link>
                      <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {row.fullPayDays} at full pay &middot; {row.halfPayDays} at half &middot;{" "}
                        {row.unpaidDays} unpaid
                        {row.probationUnpaidDays > 0
                          ? ` · ${row.probationUnpaidDays} inside probation`
                          : ""}
                        {row.beyondEntitlementDays > 0
                          ? ` · ${row.beyondEntitlementDays} past the ${SICK_LEAVE_TOTAL_DAYS}-day year`
                          : ""}
                        {" · "}
                        {formatMoney(row.payMinor)} of sick pay
                      </p>
                    </div>
                    <p className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      <strong style={{ color: "var(--text-primary)" }}>{row.remainingDays}</strong>{" "}
                      of {SICK_LEAVE_TOTAL_DAYS} remaining &middot; {row.takenDays} taken
                    </p>
                  </li>
                ))}
              </ul>

              {sickStaged.length > 0 ? (
                <p
                  className="mt-3 rounded-sm border-l-2 px-4 py-3 text-[13px]"
                  style={{ borderColor: "var(--status-warning)", color: "var(--text-secondary)" }}
                >
                  <strong style={{ color: "var(--text-primary)" }}>
                    {sickStaged.length}{" "}
                    {sickStaged.length === 1 ? "person has" : "people have"} used the full-pay stage.
                  </strong>{" "}
                  Their next sick day is at half pay or below. The stages consume in order and carry
                  across absences &mdash; a second illness continues where the first stopped, and
                  restarting the ladder at each absence pays the first fifteen days twice.
                </p>
              ) : null}
            </>
          )}
        </section>

        {/* ── 5. Working time ───────────────────────────────────────────── */}
        <section aria-labelledby="hours-heading" className="mt-10">
          <div id="hours-heading">
            <SectionHeading tone="warning" title="Working time, last 7 days" count={hoursExceptions.length}>
              8 hours a day, 48 a week, at most 2 extra hours
            </SectionHeading>
          </div>

          {hoursWarning ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="Nothing is measuring hours yet.">
                <p>{hoursWarning}</p>
              </EmptyState>
            </div>
          ) : null}

          {hoursExceptions.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {hoursExceptions.map((row) => (
                <li
                  key={`${row.employeeId}-${row.workedOn}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4"
                >
                  <div>
                    <Link href={`/workforce/${row.employeeId}`} className="text-[14px] font-medium">
                      {row.fullName}
                    </Link>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--status-warning-text)" }}>
                      {row.detail}
                    </p>
                  </div>
                  <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {formatDay(row.workedOn)} &middot; {daysPhrase(-Math.abs(daysAgo(row.workedOn)))}
                  </p>
                </li>
              ))}
            </ul>
          ) : hoursWarning ? null : (
            <div className="mt-4">
              <EmptyState tone="success" title="No working-time breach in the last week.">
                <p>
                  Overtime is capped at {MAX_OVERTIME_MINUTES_PER_DAY / 60} extra hours a day, and
                  rest-day work has to be compensated with a substitute day or at +50%. Both are
                  checked against the overtime records; neither blocks anything, because a system
                  that refuses to record hours worked does not un-work them, it hides them.
                </p>
              </EmptyState>
            </div>
          )}
        </section>

        {/* ── 5b. The 48-hour week ──────────────────────────────────────── */}
        <section aria-labelledby="weekly-heading" className="mt-10">
          <div id="weekly-heading">
            <SectionHeading tone="critical" title="Weeks past 48 hours" count={weeklyBreaches.length}>
              the statutory weekly maximum, over the last four weeks
            </SectionHeading>
          </div>

          {weeklyBreaches.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No recorded week is past 48 hours.">
                <p>
                  Read that as narrowly as it is meant. What is counted is what has been recorded
                  &mdash; ordinary hours entered as a worked day, plus overtime and rest-day work
                  &mdash; so this is a floor and not a measurement. A week that shows as over is
                  genuinely over; a week that shows as under may only be under-recorded, and until
                  clock-in and clock-out arrive with the field app there is no way to tell which
                  from here.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {weeklyBreaches.map((week) => (
                <li
                  key={`${week.employeeId}-${week.weekStart}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4"
                >
                  <div>
                    <Link href={`/workforce/${week.employeeId}`} className="text-[14px] font-medium">
                      {week.fullName}
                    </Link>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--status-critical-text)" }}>
                      {week.assessment.detail}
                    </p>
                  </div>
                  <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {formatDay(week.weekStart)} &mdash; {formatDay(week.weekEnd)} &middot;{" "}
                    {(week.recordedMinutes / 60).toFixed(1)}h over {week.daysRecorded}{" "}
                    {week.daysRecorded === 1 ? "day" : "days"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 6. Gratuity, Emiratisation and the subcontractor register ──
            Three summaries rather than three sections, each linking to the
            board that owns it. They are last for the same reason the WPS
            banner is first: nothing here moves inside a week. The gratuity
            liability changes by a day's accrual a day, the skilled headcount
            by a hire, and a subcontractor's licence on a schedule somebody
            else set. Putting any of them above a payroll that is eleven days
            late would be sorting the page by interest rather than by
            consequence. */}
        <section aria-labelledby="standing-heading" className="mt-10">
          <div id="standing-heading">
            <SectionHeading tone="success" title="Standing positions">
              slower-moving obligations, each with its own board
            </SectionHeading>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            {/* HR-13 */}
            <Link
              href="/hr/gratuity"
              className="rounded border p-4 transition-colors hover:border-current"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <p className="text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                End-of-service gratuity
              </p>
              <p className="tnum mt-1 text-xl font-semibold">{formatMoney(gratuity.totalMinor)}</p>
              <p className="prose-body mt-1 text-[12px]">{gratuity.headline}</p>
              {gratuityOverdue.length > 0 ? (
                <p className="mt-2 text-[12px] font-semibold" style={{ color: "var(--status-critical-text)" }}>
                  {gratuityOverdue.length} settlement
                  {gratuityOverdue.length === 1 ? " is" : "s are"} past the{" "}
                  {GRATUITY_SETTLEMENT_DAYS}-day deadline and unpaid.
                </p>
              ) : null}
              {gratuity.uncomputableCount > 0 ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--status-warning-text)" }}>
                  {gratuity.uncomputableCount} record
                  {gratuity.uncomputableCount === 1 ? "" : "s"} missing a service date or a basic
                  salary, so this figure is understated.
                </p>
              ) : null}
            </Link>

            {/* HR-18 */}
            <Link
              href="/hr/emiratisation"
              className="rounded border p-4 transition-colors hover:border-current"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <p className="text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Emiratisation &mdash; skilled headcount
              </p>
              <p className="tnum mt-1 text-xl font-semibold">
                {emiratisation.unknown > 0
                  ? `${emiratisation.lowerBound}–${emiratisation.upperBound}`
                  : emiratisation.lowerBound}
                <span className="text-[13px] font-normal" style={{ color: "var(--text-muted)" }}>
                  {" "}
                  / {emiratisation.threshold}
                </span>
              </p>
              {/* The whole point of HR-18 in one line: this is NOT headcount. */}
              <p className="prose-body mt-1 text-[12px]">
                {emiratisation.headcount} employed in total, which is not the number the threshold
                is measured against.
              </p>
              {emiratisation.undecidedByMissingFacts || emiratisation.approaching ? (
                <p className="mt-2 text-[12px] font-semibold" style={{ color: "var(--status-warning-text)" }}>
                  {emiratisation.headline}
                </p>
              ) : null}
              {/* OPEN-4 travels with the figure, not only on the page that
                  explains it. A count this precise, against a threshold that
                  may not apply to technical services at all, is exactly the
                  number somebody acts on with false confidence — and the
                  summary card is where they would see it without the
                  explanation. Shown only in the 20–49 band, because that is
                  the only band the open question affects: at 50+ skilled the
                  rule applies whatever the sector. */}
              {emiratisation.band === "small_establishment_band" ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                  OPEN-4: whether technical services is a designated sector for the 20&ndash;49
                  employee rule is unconfirmed. Assumed in scope.
                </p>
              ) : null}
            </Link>

            {/* HR-19 */}
            <Link
              href="/workforce/subcontractors"
              className="rounded border p-4 transition-colors hover:border-current"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <p className="text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Subcontractors and manpower suppliers
              </p>
              <p className="tnum mt-1 text-xl font-semibold">{subcontractorExpiries.length}</p>
              <p className="prose-body mt-1 text-[12px]">
                {subcontractorExpiries.length === 0
                  ? "Nothing in the supplier register expires within 90 days."
                  : "licence, insurance and work-permit expiries within 90 days"}
              </p>
              {subcontractorLapsed > 0 ? (
                <p className="mt-2 text-[12px] font-semibold" style={{ color: "var(--status-critical-text)" }}>
                  {subcontractorLapsed} of them {subcontractorLapsed === 1 ? "has" : "have"} already
                  lapsed. Responsibility for site compliance does not transfer with the work.
                </p>
              ) : null}
            </Link>
          </div>
        </section>

        <p className="mt-10 text-[12px]" style={{ color: "var(--text-muted)" }}>
          The work-injury register (`HR-11`) is specified but not built &mdash; the 48-hour MOHRE
          reporting clock and the salary-continuation obligation have no home yet. Nothing on this
          page reports on it, and nothing on this page implies it is fine.
        </p>
      </div>
    </AppShell>
  );
}

function ContractList({
  rows,
}: {
  rows: readonly { employeeId: string; fullName: string; detail: string; daysToEnd: number | null }[];
}) {
  return (
    <ul className="mt-2 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
      {rows.map((row) => (
        <li key={row.employeeId} className="p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <Link href={`/workforce/${row.employeeId}`} className="text-[14px] font-medium">
              {row.fullName}
            </Link>
            {row.daysToEnd === null ? null : (
              <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                {daysPhrase(row.daysToEnd)}
              </span>
            )}
          </div>
          <p className="prose-body mt-1 text-[12px]">{row.detail}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Days between a stored `YYYY-MM-DD` and today, in Dubai.
 *
 * Both ends go through UTC midnight rather than through the host's local zone,
 * which is what stops "yesterday" reading as "today" on a machine west of
 * Greenwich. Same rule as `packages/core/src/employment.ts`.
 */
function daysAgo(day: string): number {
  const then = Date.parse(`${day}T00:00:00Z`);
  const now = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return Math.round((now - then) / 86_400_000);
}
