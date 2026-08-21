import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  currentWageCycle,
  listWageCycles,
  wageFileLines,
  wageFileGaps,
} from "@meridian/db";
import { can } from "@meridian/auth";
import {
  formatMoney,
  formatDay,
  today,
  WPS_MINIMUM_TRANSFER_PERCENT,
  WPS_ESCALATION,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SectionHeading, EmptyState } from "../../workforce/compliance-ui";
import { WpsBanner, type WpsSeverity } from "../wps-banner";
import { BuildWageFile, ConfirmTransfer } from "../payroll-forms";

export const metadata: Metadata = { title: "Wage protection" };
export const dynamic = "force-dynamic";

/**
 * The WPS payroll register (`HR-17`).
 *
 * Three things, in this order: where the live cycle stands on the escalation
 * ladder, the wage-file inputs that have to exist by T-3, and the history —
 * which is the only place "have we ever been late" can be answered, and it is
 * the question an inspection actually asks.
 *
 * ── WHY THE LADDER IS PRINTED IN FULL ───────────────────────────────────────
 *
 * Below the register, every rung with its consequence, whether or not it
 * applies today. Compliance rules that are only shown when they bite are rules
 * nobody plans around: the point of putting day 5, day 11, day 16 and day 21 on
 * the screen on the 27th of the month is that somebody reading it on the 27th
 * still has a choice.
 */
export default async function PayrollPage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = can(session.principal, "workforce:write");

  const { cycle, lines, history, gaps } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const live = await currentWageCycle(tx, { tenantId: session.principal.tenantId });
      return {
        cycle: live,
        lines: await wageFileLines(tx, live.id),
        history: await listWageCycles(tx, 12),
        gaps: await wageFileGaps(tx),
      };
    },
  );

  const totalNet = lines.reduce((sum, l) => sum + l.netMinor, 0);
  const totalOvertime = lines.reduce((sum, l) => sum + l.overtimeMinor, 0);
  const totalDeductions = lines.reduce((sum, l) => sum + l.deductionsMinor, 0);
  const past = history.filter((h) => h.id !== cycle.id);

  return (
    <AppShell session={session} active="hr">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/hr" style={{ color: "var(--accent-text)" }}>
            &larr; Employment lifecycle
          </Link>
        </p>

        <h1 className="mt-4 text-2xl font-semibold tracking-tight md:text-3xl">Wage protection</h1>
        <p className="prose-body mt-2 text-[14px]">
          Wages for the previous month are due on the <strong>1st</strong>, and an establishment is
          compliant when at least {WPS_MINIMUM_TRANSFER_PERCENT}% of total wages due has been
          transferred by then. The system computes the file; it does not disburse. Recording the
          transfer here is what stops the escalation, and only the bank actually moving the money
          makes that record true.
        </p>

        <div className="mt-8">
          <WpsBanner
            label={cycle.assessment.label}
            headline={cycle.assessment.headline}
            consequence={cycle.assessment.consequence}
            severity={cycle.assessment.severity as WpsSeverity}
            stage={cycle.assessment.stage}
            daysUntilDue={cycle.assessment.daysUntilDue}
            daysLate={cycle.assessment.daysLate}
            dueOn={formatDay(cycle.dueOn)}
            transferredBasisPoints={cycle.assessment.transferredBasisPoints}
            thresholdPercent={WPS_MINIMUM_TRANSFER_PERCENT}
            totalDueMinor={cycle.totalDueMinor}
            totalTransferredMinor={cycle.totalTransferredMinor}
            employeeCount={cycle.employeeCount}
            fileDue={cycle.assessment.fileDue}
            filePreparedOn={cycle.filePreparedOn ? formatDay(cycle.filePreparedOn) : null}
          />
        </div>

        {/* ── The wage file ─────────────────────────────────────────────── */}
        <section aria-labelledby="file-heading" className="mt-10">
          <div id="file-heading">
            <SectionHeading tone="warning" title="Wage file inputs" count={lines.length}>
              hours, overtime, absences and deductions &mdash; due by T-3
            </SectionHeading>
          </div>

          {lines.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                tone="warning"
                title="No lines yet for this cycle."
                action={canWrite ? <BuildWageFile label={cycle.assessment.label} prepared={false} /> : null}
              >
                <p>
                  The file is built from the employment records: basic salary, allowances, overtime
                  recorded against the month, approved leave and any lawful deduction. It is
                  produced automatically three days before the deadline; build it now if the numbers
                  are wanted sooner.
                </p>
              </EmptyState>
            </div>
          ) : (
            <>
              <div className="mt-4 overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                      <th scope="col" className="p-3 font-medium">Employee</th>
                      <th scope="col" className="p-3 text-right font-medium">Basic</th>
                      <th scope="col" className="p-3 text-right font-medium">Allowances</th>
                      <th scope="col" className="p-3 text-right font-medium">Overtime</th>
                      <th scope="col" className="p-3 text-right font-medium">Deductions</th>
                      <th scope="col" className="p-3 text-right font-medium">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => (
                      <tr key={line.employeeId} className="border-b last:border-0">
                        <th scope="row" className="p-3 text-left font-normal">
                          <Link href={`/workforce/${line.employeeId}`} className="font-medium">
                            {line.fullName}
                          </Link>
                          {/* An IBAN that is missing is the difference between a
                              line in a file and a person who does not get paid,
                              so it is stated on the row rather than only in the
                              gap list below. */}
                          {line.wpsIban ? null : (
                            <span className="ml-2 text-[12px]" style={{ color: "var(--status-critical-text)" }}>
                              no IBAN
                            </span>
                          )}
                          {line.overtimeMinutes > 0 || line.leaveDays > 0 ? (
                            <span className="ml-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                              {line.overtimeMinutes > 0
                                ? `${(line.overtimeMinutes / 60).toFixed(1)}h OT`
                                : ""}
                              {line.overtimeMinutes > 0 && line.leaveDays > 0 ? " · " : ""}
                              {line.leaveDays > 0 ? `${line.leaveDays}d leave` : ""}
                            </span>
                          ) : null}
                        </th>
                        <td className="tnum p-3 text-right">{formatMoney(line.basicMinor)}</td>
                        <td className="tnum p-3 text-right">{formatMoney(line.allowancesMinor)}</td>
                        <td className="tnum p-3 text-right">{formatMoney(line.overtimeMinor)}</td>
                        <td className="tnum p-3 text-right">
                          {line.deductionsMinor === 0 ? "—" : formatMoney(line.deductionsMinor)}
                        </td>
                        <td className="tnum p-3 text-right font-medium">{formatMoney(line.netMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2" style={{ backgroundColor: "var(--surface-sunken)" }}>
                      <th scope="row" className="p-3 text-left font-semibold">
                        Total
                      </th>
                      <td className="p-3" />
                      <td className="p-3" />
                      <td className="tnum p-3 text-right">{formatMoney(totalOvertime)}</td>
                      <td className="tnum p-3 text-right">
                        {totalDeductions === 0 ? "—" : formatMoney(totalDeductions)}
                      </td>
                      <td className="tnum p-3 text-right font-semibold">{formatMoney(totalNet)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <p className="prose-body mt-3 text-[12px]">
                Deductions here can never include a health insurance premium. Cover is
                employer-funded under Dubai Law No. 11 of 2013 and recruitment costs may never be
                recovered from a worker under Article 6 &mdash; both are enforced by a positive list
                of lawful deduction kinds with a database constraint behind it, not by a note on
                this page.
              </p>

              {canWrite ? (
                <div className="mt-5">
                  <BuildWageFile label={cycle.assessment.label} prepared={cycle.filePreparedOn !== null} />
                </div>
              ) : null}
            </>
          )}

          {gaps.length > 0 ? (
            <div className="mt-6">
              <EmptyState
                tone="critical"
                title={`A transfer today would not reach ${gaps.length} active ${gaps.length === 1 ? "employee" : "employees"}`}
              >
                <ul className="space-y-1">
                  {gaps.map((g) => (
                    <li key={g.employeeId}>
                      <Link href={`/workforce/${g.employeeId}`} style={{ color: "var(--accent-text)" }}>
                        {g.fullName}
                      </Link>{" "}
                      &mdash; {g.reason}
                    </li>
                  ))}
                </ul>
                <p className="mt-2">
                  Stated per person because the two failures are not the same. A missing IBAN keeps
                  the wage in the total and makes it unpayable &mdash; the{" "}
                  {WPS_MINIMUM_TRANSFER_PERCENT}% test fails and somebody is unpaid. A missing salary
                  keeps them out of the total &mdash; the test passes at 100% and somebody is still
                  unpaid, which is the one that looks like compliance.
                </p>
              </EmptyState>
            </div>
          ) : null}
        </section>

        {/* ── Record the transfer ───────────────────────────────────────── */}
        {canWrite && cycle.assessment.stage !== "settled" && cycle.assessment.stage !== "nothing_due" ? (
          <section
            aria-labelledby="transfer-heading"
            className="mt-10 rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 id="transfer-heading" className="text-lg font-semibold tracking-tight">
              Record the WPS transfer
            </h2>
            <p className="prose-body mt-2 text-[14px]">
              This records what the bank did. It does not move money, and recording it does not make
              it true &mdash; but an unrecorded transfer keeps the escalation running here and on
              every alert this system sends.
            </p>
            <div className="mt-6">
              <ConfirmTransfer
                cycleId={cycle.id}
                label={cycle.assessment.label}
                suggestedAmount={formatMoney(cycle.totalDueMinor)}
                today={today()}
              />
            </div>
          </section>
        ) : null}

        {/* ── History ───────────────────────────────────────────────────── */}
        <section aria-labelledby="history-heading" className="mt-10">
          <div id="history-heading">
            <SectionHeading tone="success" title="Wage cycles" count={past.length}>
              the answer to &ldquo;have we ever been late&rdquo;
            </SectionHeading>
          </div>

          {past.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No completed wage cycles yet.">
                <p>
                  A cycle is opened automatically for each month as its deadline approaches, so this
                  list fills itself. Until it has rows in it, nothing here can answer whether the
                  establishment has been late before &mdash; which is what a MOHRE inspection asks.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {past.map((h) => (
                <li key={h.id} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 p-4">
                  <div>
                    <p className="text-[14px] font-medium">{h.assessment.label}</p>
                    <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Due {formatDay(h.dueOn)}
                      {h.confirmedOn ? ` · transferred ${formatDay(h.confirmedOn)}` : " · not transferred"}
                      {h.transferReference ? ` · ${h.transferReference}` : ""}
                    </p>
                  </div>
                  <p
                    className="tnum text-[13px] font-medium"
                    style={{
                      color:
                        h.assessment.stage === "settled"
                          ? "var(--status-success-text)"
                          : h.assessment.stage === "nothing_due"
                            ? "var(--text-muted)"
                            : "var(--status-blocked-text)",
                    }}
                  >
                    {formatMoney(h.totalTransferredMinor)} of {formatMoney(h.totalDueMinor)} &middot;{" "}
                    {(h.assessment.transferredBasisPoints / 100).toFixed(2)}%
                    {h.assessment.stage === "settled"
                      ? " · on time"
                      : ` · ${h.assessment.stage.replace(/_/g, " ")}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── The ladder, printed whether or not it applies ─────────────── */}
        <section aria-labelledby="ladder-heading" className="mt-10">
          <h2 id="ladder-heading" className="text-[15px] font-semibold uppercase tracking-wide">
            What happens after the 1st
          </h2>
          <p className="prose-body mt-2 text-[13px]">
            Printed in full, on every day of the month. A consequence that only appears once it
            applies is a consequence nobody plans around, and every rung below is avoidable on the
            day this page is being read.
          </p>
          <ol className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            {WPS_ESCALATION.map((band) => {
              const reached =
                cycle.assessment.daysLate + 1 >= band.day &&
                cycle.assessment.stage !== "settled" &&
                cycle.assessment.stage !== "nothing_due";
              return (
                <li key={band.day} className="flex gap-4 p-4">
                  <span
                    className="tnum w-14 shrink-0 text-[13px] font-semibold"
                    style={{ color: reached ? "var(--status-blocked-text)" : "var(--text-muted)" }}
                  >
                    Day {band.day}
                  </span>
                  <span
                    className="text-[13px]"
                    style={{ color: reached ? "var(--text-primary)" : "var(--text-secondary)" }}
                  >
                    {band.consequence}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      </div>
    </AppShell>
  );
}
