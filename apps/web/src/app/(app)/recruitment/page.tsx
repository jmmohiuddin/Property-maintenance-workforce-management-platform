import type { Metadata } from "next";
import Link from "next/link";
import { withTenant } from "@meridian/db";
import {
  applicationsOwedAnOutcome,
  listRequisitions,
  outcomeAccountability,
  talentPoolNeedingReconfirmation,
} from "@meridian/db/domain";
import {
  CANDIDATE_GRADE_LABEL,
  REQUISITION_STATUS_LABEL,
  getService,
  type CandidateGrade,
  type RequisitionStatus,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { NewRequisitionForm } from "./new-requisition-form";
import { ArrowRight, Warning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Recruitment" };
export const dynamic = "force-dynamic";

/**
 * Recruitment (`ATS-1`, `ATS-16`).
 *
 * ── WHY THE OWED-AN-OUTCOME PANEL IS FIRST ──────────────────────────────────
 *
 * Consequence order, the same rule the workforce board follows. The obvious
 * design puts open vacancies at the top, because that is what a recruiter came
 * here to work on — and it is exactly why the panel below them is the one that
 * never gets looked at.
 *
 * `G14` is the module's only hard target: 100% of applicants receive an
 * outcome. Around 65% of applicants never or rarely hear back, and roughly 80%
 * of those say they would not reapply. The people this panel names are not a
 * reporting curiosity; they are the failure mode the module exists to prevent,
 * and they are named rather than counted because "94%" is a statistic and "six
 * people with phone numbers" is a morning's work.
 */
export default async function RecruitmentPage() {
  const session = await requireSessionWith("recruitment:read");

  const { requisitions, accountability, owed, poolDue } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      requisitions: await listRequisitions(tx),
      accountability: await outcomeAccountability(tx),
      owed: await applicationsOwedAnOutcome(tx, 25),
      poolDue: await talentPoolNeedingReconfirmation(tx, 25),
    }),
  );

  const canWrite = ["owner", "admin", "hr"].includes(session.principal.role);

  return (
    <AppShell session={session} active="recruitment">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Recruitment</h1>
        <p className="prose-body mt-2 text-[14px]">
          Open vacancies, the pipeline behind each one, and — first, because it is the one that
          gets forgotten — everybody who is still waiting to be told something.
        </p>

        {/* ── G14 ──────────────────────────────────────────────────────── */}
        <section className="mt-8">
          <div
            className="rounded border p-6"
            style={{
              backgroundColor: "var(--surface-raised)",
              borderColor: accountability.overdue > 0 ? "var(--status-critical)" : undefined,
            }}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 className="text-[19px] font-semibold">Applicants told the outcome</h2>
              <p className="tnum text-[28px] font-semibold leading-none">
                {accountability.responseRatePercent}%
                <span
                  className="ml-2 text-[13px] font-normal"
                  style={{ color: "var(--text-muted)" }}
                >
                  target 100% (G14)
                </span>
              </p>
            </div>

            <dl className="mt-6 grid gap-5 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Applications" value={accountability.totalApplications} />
              <Stat label="Outcome sent" value={accountability.outcomeSent} />
              <Stat label="Within promise" value={accountability.awaiting} />
              <Stat label="Overdue" value={accountability.overdue} tone="critical" />
              <Stat label="Undecided, past date" value={accountability.staleActive} tone="warning" />
              <Stat label="No way to reach" value={accountability.unreachable} tone="warning" />
            </dl>

            {/*
              Three separate honesty notes, because each covers a different way
              a response rate can look good while somebody is still waiting.
            */}
            {accountability.awaitingHumanSend > 0 ? (
              <p className="mt-5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                {accountability.awaitingHumanSend} message
                {accountability.awaitingHumanSend === 1 ? " is" : "s are"} written and waiting for a
                person to send. An automated rejection is not permitted after a human has spoken to
                the candidate (ATS-15), so this is expected — but it should always be falling.
              </p>
            ) : null}

            {accountability.unreachable > 0 ? (
              <p className="mt-3 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                {accountability.unreachable} applicant
                {accountability.unreachable === 1 ? "" : "s"} gave a phone number and no email
                address. No SMS or WhatsApp transport is wired (ATS-14 asks for that channel first),
                so this system cannot tell them anything — they are counted here as unreached, not
                as satisfied. Until it exists, they need a phone call.
              </p>
            ) : null}

            {accountability.staleActive > 0 ? (
              <p className="mt-3 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                {accountability.staleActive} application
                {accountability.staleActive === 1 ? " is" : "s are"} still live and past the date
                the applicant was promised an answer. Nobody has decided anything about them. This
                is the state that becomes a silent rejection.
              </p>
            ) : null}
          </div>

          {owed.length > 0 ? (
            <div className="mt-4 rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              <div className="flex items-center gap-2.5 border-b px-6 py-4">
                <Warning
                  size={18}
                  weight="fill"
                  aria-hidden
                  style={{ color: "var(--status-critical-text)" }}
                />
                <h3 className="text-[16px] font-semibold">
                  Owed an outcome — {owed.length} {owed.length === 1 ? "person" : "people"}
                </h3>
              </div>
              <ul className="divide-y">
                {owed.map((person) => (
                  <li key={person.applicationId} className="flex flex-wrap items-center gap-4 px-6 py-4">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/recruitment/candidate/${person.applicationId}`}
                        className="text-[15px] font-medium hover:underline"
                      >
                        {person.fullName}
                      </Link>
                      <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {person.roleTitle} · {person.reference} · {person.phone}
                        {person.email ? ` · ${person.email}` : " · no email address"}
                      </p>
                    </div>
                    <p
                      className="tnum shrink-0 text-[13px] font-medium"
                      style={{ color: "var(--status-critical-text)" }}
                    >
                      {person.daysOverdue} {person.daysOverdue === 1 ? "day" : "days"} past the
                      promise
                    </p>
                    <p className="shrink-0 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {!person.reachable
                        ? "Call them — no email"
                        : person.hasMessage
                          ? "Message ready to send"
                          : "No decision recorded"}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        {/* ── Vacancies ────────────────────────────────────────────────── */}
        <section className="mt-12">
          <h2 className="text-[19px] font-semibold">Open vacancies</h2>

          {requisitions.length === 0 ? (
            <div
              className="mt-4 rounded border p-10 text-center"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <p className="text-[16px] font-semibold">No vacancies open.</p>
              <p className="prose-body mx-auto mt-2 max-w-md text-[14px]">
                Open one below. It goes to the careers site with JobPosting structured data once it
                has been approved, and applications land straight in its pipeline.
              </p>
            </div>
          ) : (
            <ul className="mt-4 space-y-3">
              {requisitions.map((requisition) => (
                <li key={requisition.id}>
                  <Link
                    href={`/recruitment/${requisition.id}`}
                    className="flex flex-wrap items-center gap-4 rounded border p-5 transition-colors hover:border-[var(--accent)]"
                    style={{ backgroundColor: "var(--surface-raised)" }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-3">
                        <span className="text-[16px] font-semibold">{requisition.title}</span>
                        <span
                          className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                          style={{
                            backgroundColor:
                              requisition.status === "open"
                                ? "var(--accent-wash)"
                                : "var(--surface-sunken)",
                            color:
                              requisition.status === "open"
                                ? "var(--accent-text)"
                                : "var(--text-secondary)",
                          }}
                        >
                          {REQUISITION_STATUS_LABEL[requisition.status as RequisitionStatus] ??
                            requisition.status}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {requisition.reference} ·{" "}
                        {getService(requisition.trade)?.shortName ?? requisition.trade} ·{" "}
                        {CANDIDATE_GRADE_LABEL[requisition.grade as CandidateGrade] ??
                          requisition.grade}{" "}
                        · {requisition.headcount}{" "}
                        {requisition.headcount === 1 ? "position" : "positions"} ·{" "}
                        {requisition.locationCity}
                      </p>
                    </div>
                    <ArrowRight size={17} aria-hidden className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── ATS-13 ───────────────────────────────────────────────────── */}
        {poolDue.length > 0 ? (
          <section className="mt-12">
            <h2 className="text-[19px] font-semibold">Talent pool — consent to re-confirm</h2>
            <p className="prose-body mt-2 text-[14px]">
              {poolDue.length} pool {poolDue.length === 1 ? "member" : "members"} last confirmed more
              than three months ago. A tradesperson&rsquo;s availability and certificate validity go
              stale in weeks, so a pool nobody re-confirms is a list of people who have all found
              other work — and holding their details past their consent is a separate problem.
            </p>
            <ul className="mt-4 space-y-2">
              {poolDue.slice(0, 10).map((member) => (
                <li
                  key={`${member.candidateId}-${member.poolKey}`}
                  className="flex flex-wrap items-center justify-between gap-3 rounded border px-5 py-3 text-[14px]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <span>
                    {member.fullName} · {member.phone}
                  </span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {getService(member.poolKey)?.shortName ?? member.poolKey} · due{" "}
                    {member.dueAt.toLocaleDateString("en-GB", {
                      timeZone: "Asia/Dubai",
                      day: "numeric",
                      month: "short",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {canWrite ? (
          <section className="mt-12">
            <h2 className="text-[19px] font-semibold">Open a vacancy</h2>
            <p className="prose-body mt-2 max-w-2xl text-[14px]">
              A vacancy is created as a draft with the standard seven-stage pipeline. It needs an
              approval before it can be published, and publishing is what puts it on the careers
              site.
            </p>
            <div className="mt-5 max-w-3xl">
              <NewRequisitionForm />
            </div>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "critical" | "warning";
}) {
  const colour =
    value === 0
      ? "var(--text-primary)"
      : tone === "critical"
        ? "var(--status-critical-text)"
        : tone === "warning"
          ? "var(--text-primary)"
          : "var(--text-primary)";

  return (
    <div>
      <dt className="text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </dt>
      <dd className="tnum mt-1 text-[22px] font-semibold" style={{ color: colour }}>
        {value}
      </dd>
    </div>
  );
}
