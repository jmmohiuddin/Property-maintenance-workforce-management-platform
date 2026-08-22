import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getEmployeeRecord,
  blockForTechnician,
  employmentContract,
  leaveSummary,
  healthInsuranceFor,
  listOvertime,
  weeklyWorkingHours,
  listSalaryDeductions,
  EMPLOYEE_DOCUMENT_KINDS,
  EMPLOYEE_DOCUMENT_LABEL,
  BLOCKING_DOCUMENT_KINDS,
} from "@meridian/db";
import { can } from "@meridian/auth";
import {
  formatMoney,
  today,
  addDays,
  startOfMonth,
  formatDay as formatCalendarDay,
  HEALTH_PLANS,
  HEALTH_PLAN_LABEL,
  PAY_BAND_LABEL,
  SICK_LEAVE_FULL_PAY_DAYS,
  SICK_LEAVE_HALF_PAY_DAYS,
  SICK_LEAVE_TOTAL_DAYS,
  LAWFUL_DEDUCTION_KINDS,
  DEDUCTION_KIND_LABEL,
  PROBATION_NOTICE_DAYS,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  ComplianceBlock,
  EmptyState,
  ExpiryChip,
  formatDay,
  humanise,
  tradeLabel,
} from "../compliance-ui";
import { DocumentPanel, WithdrawDocument } from "./document-panel";
import {
  ContractPanel,
  LeavePanel,
  SickLeavePanel,
  OvertimePanel,
  WorkedDayPanel,
  InsurancePanel,
  DeductionPanel,
} from "./employment-panel";

export const metadata: Metadata = { title: "Employment record" };
export const dynamic = "force-dynamic";

/**
 * One employment record and its documents (`HR-5`).
 *
 * This page exists because the board cannot: without somewhere to type an
 * expiry date, `employee_documents` stays empty and the compliance board is a
 * screen that always reports that everything is fine. `HR-5` is the register,
 * not the report over it.
 */
export default async function EmployeeRecordPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");
  const { employeeId } = await params;

  const { record, block, contract, leave, insurance, overtime, deductions, weeks } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const found = await getEmployeeRecord(tx, employeeId);
      if (!found) {
        return {
          record: null,
          block: null,
          contract: null,
          leave: null,
          insurance: null,
          overtime: [],
          deductions: [],
          weeks: [],
        };
      }
      return {
        record: found,
        block: found.technicianId ? await blockForTechnician(tx, found.technicianId) : null,
        // The employment lifecycle (`HR-4`, `HR-6`, `HR-7`, `HR-8`) alongside
        // the document register (`HR-5`). One round trip, one transaction:
        // seven sequential requests would each open their own and could each
        // see a different moment.
        contract: await employmentContract(tx, employeeId),
        leave: await leaveSummary(tx, employeeId),
        insurance: await healthInsuranceFor(tx, employeeId),
        // A year back. Overtime is a payroll input and the wage cycle it feeds
        // is monthly, but the question this page answers is "what has this
        // person been asked to work", which is not a one-month question.
        overtime: await listOvertime(tx, { from: addDays(today(), -365), to: today(), employeeId }),
        // Eight weeks of weekly totals against the 48-hour maximum. A week is
        // only assessable once it is over, so a seven-day window would show the
        // current week — always partial, always under — and never a finished
        // one that went past.
        weeks: await weeklyWorkingHours(tx, {
          from: addDays(today(), -56),
          to: today(),
          employeeId,
        }),
        deductions: await listSalaryDeductions(tx, employeeId),
      };
    },
  );

  // A record belonging to another tenant is filtered out by RLS and arrives
  // here as null, so this is a 404 rather than a 403 — deliberately. Telling an
  // attacker "that id exists but is not yours" confirms the id.
  if (!record) notFound();

  const trade = tradeLabel(record.primaryTrade);
  // Sick leave rides on the leave summary rather than being fetched again: it
  // is measured against the same leave year, and a second call would compute
  // that year a second time from the same dates for the pleasure of being able
  // to disagree with the first.
  const sick = leave?.sick ?? null;
  const weeksOver = weeks.filter((w) => !w.assessment.withinLimit);

  // Built here rather than inside the form: the constants live in the database
  // package, and importing that from a client component pulls the postgres
  // driver into the browser bundle.
  const onFile = new Set(record.documents.map((d) => d.kind));
  const documentKinds = EMPLOYEE_DOCUMENT_KINDS.map((kind) => ({
    value: kind,
    label: EMPLOYEE_DOCUMENT_LABEL[kind],
    blocking: BLOCKING_DOCUMENT_KINDS.includes(kind),
    onFile: onFile.has(kind),
  }));

  return (
    <AppShell session={session} active="workforce">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/workforce" style={{ color: "var(--accent-text)" }}>
            &larr; Workforce compliance
          </Link>
        </p>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{record.fullName}</h1>
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {record.employeeNo ? (
              <>
                <span className="tnum">{record.employeeNo}</span> &middot;{" "}
              </>
            ) : null}
            {humanise(record.contractType)} &middot; {humanise(record.status)}
            {trade ? ` · ${trade}` : ""}
          </p>
        </div>

        {record.technicianId ? (
          <p className="mt-2 text-[13px]">
            <Link href={`/technicians/${record.technicianId}`} style={{ color: "var(--accent-text)" }}>
              Technician record: skills, certifications and workload &rarr;
            </Link>
          </p>
        ) : (
          <p className="prose-body mt-2 text-[13px]">
            Not linked to a technician. Documents recorded here are kept for the file, but nothing
            they say can stop a dispatch &mdash; the block is enforced through the technician link.
          </p>
        )}

        {/* The block first, before anything else on the page, for the same
            reason it is first on the board: it is the only thing here with a
            statutory penalty attached to it. */}
        {block ? (
          <ul className="mt-6">
            <ComplianceBlock
              name={record.fullName}
              subtitle={trade}
              detail={block.detail}
              penalty={block.penalty}
              fixHref="#record-document"
              fixLabel="Record the renewal below"
            />
          </ul>
        ) : null}

        {record.missingBlockingKinds.length > 0 ? (
          <div className="mt-6">
            <EmptyState
              tone="critical"
              title={`${record.missingBlockingKinds.length} of the 5 required documents ${
                record.missingBlockingKinds.length === 1 ? "is" : "are"
              } not in date`}
            >
              <p>
                {record.missingBlockingKinds
                  .map((k) => EMPLOYEE_DOCUMENT_LABEL[k])
                  .join(", ")}
                . A document that is missing entirely is invisible to the dispatch check &mdash; it
                joins through <code>employee_documents</code>, so no row means no block, which is
                the opposite of what a missing work permit should do.
              </p>
            </EmptyState>
          </div>
        ) : null}

        <section aria-labelledby="documents-heading" className="mt-8">
          <h2 id="documents-heading" className="text-lg font-semibold tracking-tight">
            Documents on file &mdash; {record.documents.length}
          </h2>

          {record.documents.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="Nothing on file for this person.">
                <p>
                  Record the work permit, residence visa, Emirates ID, medical fitness certificate
                  and health insurance. Those five are the ones that stop a dispatch when they
                  lapse; everything else is recorded for the file and warns at assignment.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {record.documents.map((d) => (
                <li key={d.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
                  <div>
                    <p className="text-[14px] font-medium">
                      {d.label}
                      {d.referenceNo ? (
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {d.referenceNo}
                        </span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {d.blocking
                        ? "Expiry blocks dispatch outright"
                        : "Expiry warns at assignment; an override needs a recorded reason"}
                      {d.issuedAt ? ` · issued ${formatDay(d.issuedAt)}` : ""}
                    </p>
                    {d.note ? (
                      <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                        {d.note}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <ExpiryChip
                      expiresAt={d.expiresAt}
                      daysRemaining={d.daysRemaining}
                      blocking={d.blocking}
                    />
                    {canWrite ? (
                      <WithdrawDocument
                        documentId={d.id}
                        employeeId={record.id}
                        label={d.label}
                      />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── HR-4: the contract ────────────────────────────────────────── */}
        <section aria-labelledby="contract-heading" className="mt-10">
          <h2 id="contract-heading" className="text-lg font-semibold tracking-tight">
            Contract
          </h2>

          {contract?.assessment ? (
            <div className="mt-4">
              {/* An auto-renewed term is rendered as a live contract, never as an
                  expired one. That is the requirement: a fixed-term contract the
                  worker kept working past IS renewed, by operation of law, and
                  showing it as "expired" invites somebody to treat the person as
                  unemployed or to backdate a new contract on different terms —
                  which is the dispute the renewal rule exists to prevent. */}
              <EmptyState
                tone={
                  contract.assessment.state === "auto_renewed"
                    ? "critical"
                    : contract.assessment.problems.length > 0
                      ? "critical"
                      : contract.assessment.state === "probation" ||
                          contract.assessment.state === "expiring"
                        ? "warning"
                        : "success"
                }
                title={contractTitle(contract.assessment.state)}
              >
                <p>{contract.assessment.summary}</p>
                {contract.assessment.state === "probation" ? (
                  <p className="mt-2">
                    Termination by the employer during probation takes {PROBATION_NOTICE_DAYS}{" "}
                    days&rsquo; notice. Once probation ends it becomes the contractual notice period,
                    so the decision has a deadline whether or not anybody has made it.
                  </p>
                ) : null}
                {contract.assessment.problems.length > 0 ? (
                  <ul className="mt-2 space-y-1" style={{ color: "var(--status-critical-text)" }}>
                    {contract.assessment.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4">
              <EmptyState tone="warning" title="No contract recorded.">
                <p>
                  Nothing knows when this contract ends, so nothing can tell you it has renewed. A
                  fixed-term contract that runs past its end date renews on the same terms by
                  operation of law &mdash; the only question is whether the system knows.
                </p>
              </EmptyState>
            </div>
          )}

          {contract && contract.terms.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {contract.terms.map((term) => (
                <li key={term.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <p className="text-[14px] font-medium">
                      Term {term.sequence}
                      <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                        {" "}
                        &middot; {term.origin === "auto_renewed" ? "renewed by operation of law" : humanise(term.origin)}
                      </span>
                    </p>
                    <p className="tnum mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {formatCalendarDay(term.startsOn)}
                      {term.endsOn ? ` — ${formatCalendarDay(term.endsOn)}` : " — no end date"}
                      {term.probationEndsOn ? ` · probation to ${formatCalendarDay(term.probationEndsOn)}` : ""}
                      {` · ${term.noticePeriodDays} days' notice`}
                    </p>
                  </div>
                  <p className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {term.basicSalaryMinor === null ? "No basic recorded" : `${formatMoney(term.basicSalaryMinor)} basic`}
                    {term.status === "active" ? "" : ` · ${humanise(term.status)}`}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}

          {canWrite ? (
            <div className="mt-6">
              <ContractPanel employeeId={record.id} />
            </div>
          ) : null}
        </section>

        {/* ── HR-6: health cover ────────────────────────────────────────── */}
        <section aria-labelledby="insurance-heading" className="mt-10">
          <h2 id="insurance-heading" className="text-lg font-semibold tracking-tight">
            Health insurance
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            Mandatory in Dubai, employer-funded, and the premium may not be deducted from salary.
            The expiry is not held here &mdash; it is on the health insurance document above, which
            is one of the five that stop a dispatch when they lapse.
          </p>

          {insurance ? (
            insurance.problems.length > 0 ? (
              <div className="mt-4">
                <EmptyState tone="critical" title="The cover on file is not what the law requires.">
                  <ul className="space-y-1">
                    {insurance.problems.map((problem) => (
                      <li key={problem}>{problem}</li>
                    ))}
                  </ul>
                </EmptyState>
              </div>
            ) : (
              <p className="tnum mt-4 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {insurance.planLabel} &middot; {insurance.insurer}
                {insurance.policyNo ? ` · ${insurance.policyNo}` : ""}
                {insurance.premiumMinor === null
                  ? ""
                  : ` · ${formatMoney(insurance.premiumMinor)} employer-funded premium`}
              </p>
            )
          ) : null}

          {canWrite ? (
            <InsurancePanel
              employeeId={record.id}
              plans={HEALTH_PLANS.map((plan) => ({ value: plan, label: HEALTH_PLAN_LABEL[plan] }))}
              requiredPlan={insurance ? HEALTH_PLAN_LABEL[insurance.requiredPlan] : null}
            />
          ) : null}
        </section>

        {/* ── HR-7: leave ───────────────────────────────────────────────── */}
        <section aria-labelledby="leave-heading" className="mt-10">
          <h2 id="leave-heading" className="text-lg font-semibold tracking-tight">
            Annual leave
          </h2>

          {leave?.entitlement ? (
            <>
              <p className="tnum mt-3 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--text-primary)" }}>{leave.remainingDays}</strong> days
                remaining &middot; {leave.accruedDays} accrued &middot; {leave.takenDays} taken
                {leave.carriedOverDays > 0 ? ` · ${leave.carriedOverDays} carried over` : ""}
                {leave.adjustmentDays !== 0 ? ` · ${leave.adjustmentDays} adjustment` : ""}
              </p>
              <p className="prose-body mt-1 text-[12px]">{leave.entitlement.explanation}</p>
            </>
          ) : (
            <p className="prose-body mt-3 text-[13px]">
              No service start date on the record, so no entitlement can be computed. Record the
              contract start above &mdash; leave accrues from it, and a termination settlement is
              computed against it.
            </p>
          )}

          {leave && leave.requests.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {leave.requests.slice(0, 10).map((request) => (
                <li key={request.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <p className="text-[14px] font-medium">
                      {humanise(request.kind)} &middot; {request.days}{" "}
                      {request.days === 1 ? "day" : "days"}
                    </p>
                    <p className="tnum mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {formatCalendarDay(request.startsOn)} — {formatCalendarDay(request.endsOn)} &middot;{" "}
                      {humanise(request.status)}
                    </p>
                  </div>
                  {/* Short notice is flagged, never refused. Leave agreed at
                      short notice by consent is lawful; leave imposed at short
                      notice is not, and the only thing that distinguishes them
                      is a record of who asked. */}
                  <p
                    className="text-[12px]"
                    style={{
                      color: request.noticeSufficient
                        ? "var(--text-muted)"
                        : "var(--status-warning-text)",
                    }}
                  >
                    {request.noticeDetail}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}

          {canWrite ? (
            <LeavePanel
              employeeId={record.id}
              // The anniversary the summary is measured against, not the
              // service start. Writing a carry-over against the wrong one saves
              // a row nothing ever reads and the balance never moves.
              leaveYearStart={leave?.leaveYearStart ?? startOfMonth(today())}
            />
          ) : null}
        </section>

        {/* ── HR-7: sick leave ──────────────────────────────────────────── */}
        <section aria-labelledby="sick-heading" className="mt-10">
          <h2 id="sick-heading" className="text-lg font-semibold tracking-tight">
            Sick leave
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            A separate entitlement, not a draw on the annual leave above. After probation:{" "}
            {SICK_LEAVE_FULL_PAY_DAYS} days at full pay, then {SICK_LEAVE_HALF_PAY_DAYS} at half
            pay, then 45 unpaid &mdash; {SICK_LEAVE_TOTAL_DAYS} days per leave year. The stages
            consume in order and they carry across absences: a second illness continues where the
            first stopped rather than starting the full-pay days again.
          </p>

          {sick && sick.takenDays > 0 ? (
            <>
              <p className="tnum mt-3 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                <strong style={{ color: "var(--text-primary)" }}>{sick.remainingDays}</strong> of{" "}
                {SICK_LEAVE_TOTAL_DAYS} days remaining &middot; {sick.takenDays} taken &middot;{" "}
                {sick.fullPayDays} at full pay &middot; {sick.halfPayDays} at half &middot;{" "}
                {sick.unpaidDays} unpaid
                {sick.probationUnpaidDays > 0
                  ? ` · ${sick.probationUnpaidDays} inside probation, unpaid`
                  : ""}
              </p>
              <p className="prose-body mt-1 text-[12px]">
                {formatMoney(sick.payMinor)} of sick pay in the leave year beginning{" "}
                {formatCalendarDay(sick.leaveYearStart)}, computed on the whole wage &mdash; basic
                and allowances &mdash; because that is what Article 31 stages.
              </p>

              <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                {sick.periods.map((period) => (
                  <li key={period.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                    <div>
                      <p className="text-[14px] font-medium">
                        {period.days} {period.days === 1 ? "day" : "days"}
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {formatCalendarDay(period.startsOn)} &mdash;{" "}
                          {formatCalendarDay(period.endsOn)}
                        </span>
                      </p>
                      <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                        {period.explanation}
                      </p>
                    </div>
                    <p className="tnum text-[13px] font-medium">{formatMoney(period.payMinor)}</p>
                  </li>
                ))}
              </ul>

              {sick.beyondEntitlementDays > 0 ? (
                <div className="mt-4">
                  <EmptyState tone="critical" title="This absence has run past the statutory year.">
                    <p>
                      {sick.beyondEntitlementDays} days beyond the {SICK_LEAVE_TOTAL_DAYS}. Past
                      that point the absence is not sick leave at all &mdash; it is a decision under
                      Article 34, and recording it as a longer sick leave hides the decision rather
                      than making it.
                    </p>
                  </EmptyState>
                </div>
              ) : null}
            </>
          ) : (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
              {record.technicianId
                ? `No sick leave recorded in this leave year, so all ${SICK_LEAVE_TOTAL_DAYS} days remain.`
                : "Not linked to a technician. Leave is held against the technician roster — which is what the dispatcher reads to decide who is available — so an absence cannot be recorded here until the records are linked."}
            </p>
          )}

          {canWrite && record.technicianId ? <SickLeavePanel employeeId={record.id} /> : null}
        </section>

        {/* ── HR-8: hours ───────────────────────────────────────────────── */}
        <section aria-labelledby="hours-heading" className="mt-10">
          <h2 id="hours-heading" className="text-lg font-semibold tracking-tight">
            Overtime and rest-day work
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            Basic +25%, or +50% for overtime between 22:00 and 04:00 and for rest-day work. At most
            two extra hours a day. The multiplier follows the band and the amount is computed from
            the basic salary &mdash; neither is typed in, so a historic entry can always be
            re-derived and checked.
          </p>

          {overtime.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {overtime.slice(0, 15).map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <p className="text-[14px] font-medium">
                      {(row.minutes / 60).toFixed(1)} hours &middot; {PAY_BAND_LABEL[row.band] ?? row.bandLabel}
                    </p>
                    <p className="tnum mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {formatCalendarDay(row.workedOn)} &middot; ×
                      {(row.multiplierBasisPoints / 10000).toFixed(2)}
                      {row.restDayCompensation
                        ? ` · ${row.restDayCompensation === "substitute_day" ? `substitute day ${row.substituteDayOn ? formatCalendarDay(row.substituteDayOn) : ""}` : "paid at +50%"}`
                        : ""}
                    </p>
                  </div>
                  <p className="tnum text-[13px] font-medium">{formatMoney(row.amountMinor)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
              No overtime recorded in the last year.
            </p>
          )}

          {/* ── The 48-hour week ──────────────────────────────────────── */}
          <h3 className="mt-8 text-[15px] font-semibold tracking-tight">Weekly hours, last eight weeks</h3>
          <p className="prose-body mt-2 text-[13px]">
            48 hours is the statutory maximum. What is counted is what has been recorded &mdash;
            ordinary hours entered as a worked day below, plus overtime and rest-day work. It is a
            floor, not a measurement: clock-in and clock-out arrive with the field app, so a week
            shown as over is genuinely over, and a week shown as under may only be under-recorded.
          </p>

          {weeks.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {weeks.slice(0, 8).map((week) => (
                <li
                  key={week.weekStart}
                  className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4"
                >
                  <div>
                    <p className="tnum text-[14px] font-medium">
                      {formatCalendarDay(week.weekStart)} &mdash; {formatCalendarDay(week.weekEnd)}
                    </p>
                    <p
                      className="mt-1 text-[12px]"
                      style={{
                        color: week.assessment.withinLimit
                          ? "var(--text-muted)"
                          : "var(--status-critical-text)",
                      }}
                    >
                      {week.assessment.detail}
                    </p>
                  </div>
                  <p className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    <strong style={{ color: "var(--text-primary)" }}>
                      {(week.recordedMinutes / 60).toFixed(1)}h
                    </strong>{" "}
                    over {week.daysRecorded} {week.daysRecorded === 1 ? "day" : "days"}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
              No hours recorded in the last eight weeks. That is not the same as no hours worked
              &mdash; nothing here is measuring them yet.
            </p>
          )}

          {weeksOver.length > 0 ? (
            <div className="mt-4">
              <EmptyState
                tone="critical"
                title={`${weeksOver.length} ${weeksOver.length === 1 ? "week is" : "weeks are"} past the 48-hour statutory maximum`}
              >
                <p>
                  Reported, not blocked. A system that refuses to record hours that were worked does
                  not un-work them &mdash; it moves them somewhere nobody can see, which is worse for
                  the labour claim than a flagged week.
                </p>
              </EmptyState>
            </div>
          ) : null}

          {canWrite ? (
            <>
              <h3 className="mt-8 text-[15px] font-semibold tracking-tight">Record a worked day</h3>
              <p className="prose-body mt-2 text-[13px]">
                Start and end times, and the split into ordinary, overtime and night hours follows
                from them. This is also the only way ordinary hours get recorded, and without them
                the weekly total above can never see a week of ordinary days that ran long.
              </p>
              <WorkedDayPanel employeeId={record.id} />

              <h3 className="mt-8 text-[15px] font-semibold tracking-tight">
                Or record one band directly
              </h3>
              <OvertimePanel
                employeeId={record.id}
                bands={(["overtime", "night", "rest_day"] as const).map((band) => ({
                  value: band,
                  label: PAY_BAND_LABEL[band],
                }))}
              />
            </>
          ) : null}
        </section>

        {/* ── HR-6 / HR-16: deductions ──────────────────────────────────── */}
        <section aria-labelledby="deductions-heading" className="mt-10">
          <h2 id="deductions-heading" className="text-lg font-semibold tracking-tight">
            Salary deductions
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            A closed list. The health insurance premium is not on it and cannot be added to it
            &mdash; cover is employer-funded under Dubai Law No. 11 of 2013 &mdash; and neither are
            visa costs, recruitment fees or permit fees, which Article 6 prohibits recovering from a
            worker in any form.
          </p>

          {deductions.length > 0 ? (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {deductions.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <p className="text-[14px] font-medium">{humanise(row.kind)}</p>
                    <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                      {row.reason}
                      {row.appliesOn ? ` · ${formatCalendarDay(row.appliesOn)}` : ""}
                    </p>
                  </div>
                  <p className="tnum text-[13px] font-medium">{formatMoney(row.amountMinor)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
              Nothing deducted from this wage.
            </p>
          )}

          {canWrite ? (
            <DeductionPanel
              employeeId={record.id}
              kinds={LAWFUL_DEDUCTION_KINDS.map((kind) => ({
                value: kind,
                label: DEDUCTION_KIND_LABEL[kind],
              }))}
            />
          ) : null}
        </section>

        <div id="record-document" className="mt-8 scroll-mt-8">
          {canWrite ? (
            <DocumentPanel employeeId={record.id} kinds={documentKinds} />
          ) : (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              Your role can read this record but not change it. An operations manager, HR or an
              administrator can record documents and renewals.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The contract state, as the sentence somebody acts on.
 *
 * `auto_renewed` is the one that matters and the one a raw enum would ruin:
 * "Auto renewed" reads as a system event, when what it means is "this person is
 * employed on a term nobody signed, and the law says so".
 */
function contractTitle(state: string): string {
  switch (state) {
    case "auto_renewed":
      return "Renewed by operation of law — record it or issue a new contract";
    case "probation":
      return "On probation";
    case "expiring":
      return "Ending soon";
    case "ended":
      return "Ended";
    case "not_started":
      return "Not yet started";
    default:
      return "Running";
  }
}
