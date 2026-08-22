import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, hseSummary, listEmployees } from "@meridian/db";
import {
  formatDay,
  INJURY_CAUSE_LABEL,
  INJURY_SEVERITY_LABEL,
  INJURY_CAUSES,
  INJURY_SEVERITIES,
  MOHRE_INJURY_NOTIFICATION_HOURS,
  PPE_ITEM_KINDS,
  PPE_ITEM_LABEL,
  PPE_REPLACEMENT_WARN_DAYS,
  RAMS_KINDS,
  RAMS_KIND_LABEL,
  RAMS_REVIEW_WARN_DAYS,
  WORK_INJURY_KINDS,
  WORK_INJURY_KIND_LABEL,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { SectionHeading, EmptyState, daysPhrase } from "../../workforce/compliance-ui";
import {
  RecordInjury,
  RecordNotification,
  CloseInvestigation,
  AddRams,
  AddToolboxTalk,
  IssuePpe,
} from "./forms";

export const metadata: Metadata = { title: "Health & safety" };
export const dynamic = "force-dynamic";

/**
 * The HSE board (`HR-11`, `HR-12`).
 *
 * Third sibling to `/workforce` and `/hr`, split from both by *question* rather
 * than by table, on the rule those two already set. `/workforce` answers "may
 * this person legally be sent to work today". `/hr` answers "what does the
 * employment relationship owe, and by when". This answers "what happened on
 * site, who has been told, and what was changed as a result" — and merging it
 * into either would put a 48-hour statutory clock underneath a leave balance.
 *
 * Consequence order, as everywhere else: the injury clock first, because it is
 * the only thing in this application measured in hours. Everything below it is
 * measured in days or in months.
 */
export default async function HsePage() {
  const session = await requireSessionWith("workforce:read");
  const canWrite = session.principal.role !== "readonly";

  const { summary, employees } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      summary: await hseSummary(tx),
      employees: await listEmployees(tx),
    }),
  );

  const employeeOptions = employees.map((e) => ({
    id: e.id,
    name: e.employeeNo ? `${e.fullName} (${e.employeeNo})` : e.fullName,
  }));

  const ramsOptions = summary.rams.map((r) => ({
    value: r.id,
    label: `${r.reference} — ${r.title}`,
  }));

  // Split by whether the statutory window has closed. Both are open
  // obligations; only one of them is already a breach, and a board that
  // rendered them together would bury the breach among the countdowns.
  const overdue = summary.openNotifications.filter(
    (i) => i.assessment.overdue,
  );
  const running = summary.openNotifications.filter(
    (i) => !i.assessment.mohreNotified && !i.assessment.overdue,
  );
  // MOHRE done, insurer not. Not an alarm and not nothing: late notice can void
  // the cover, which is a bigger bill than the administrative one.
  const insurerOnly = summary.openNotifications.filter((i) => i.assessment.mohreNotified);
  const police = summary.openNotifications.filter((i) => i.policeReportOutstanding);

  const ramsLapsed = summary.ramsDue.filter((r) => (r.daysToReview ?? 0) < 0);
  const ppeLapsed = summary.ppeDue.filter((p) => (p.daysToReplacement ?? 0) < 0);
  const ticketsExpired = summary.ropeAccess.filter((t) => (t.daysRemaining ?? 1) < 0);
  const ticketsNoExpiry = summary.ropeAccess.filter((t) => t.expiresOn === null);

  return (
    <AppShell session={session} active="hr/hse">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Health &amp; safety</h1>
          <p className="text-[13px]">
            <Link href="/hr" style={{ color: "var(--accent-text)" }}>
              Employment lifecycle &rarr;
            </Link>
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">
          The work injury register and the HSE record set. A work injury or occupational disease
          must be notified to MOHRE within {MOHRE_INJURY_NOTIFICATION_HOURS} hours of the company
          learning of it, and the employer must keep a register of both. Nothing on this page blocks
          a dispatch: a register that stopped work is a register people stop writing in, and an
          unwritten register is the failure the obligation exists to prevent.
        </p>

        {/* ── 1. The 48-hour clock ─────────────────────────────────────── */}
        <section className="mt-8 space-y-4">
          <SectionHeading
            tone={overdue.length > 0 ? "blocked" : running.length > 0 ? "critical" : "success"}
            title="MOHRE notification clock"
            count={overdue.length + running.length}
          >
            {MOHRE_INJURY_NOTIFICATION_HOURS} hours from when the company knew. Checked hourly.
          </SectionHeading>

          {overdue.length === 0 && running.length === 0 ? (
            <EmptyState tone="success" title="Nothing is owed to MOHRE.">
              Every injury on the register has been notified inside its window. This is a good
              state, not an empty one.
            </EmptyState>
          ) : null}

          {[...overdue, ...running].map((injury) => (
            <article
              key={injury.id}
              className="rounded-sm border p-5"
              style={{
                borderColor:
                  injury.assessment.severity === "alarm"
                    ? "var(--danger-border, var(--border))"
                    : "var(--border)",
              }}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h3 className="text-[15px] font-semibold">
                  {injury.reference} &mdash; {injury.employeeName ?? injury.employeeNo ?? "purged"}
                </h3>
                <p className="tnum text-[13px] font-semibold">{injury.assessment.headline}</p>
              </div>

              <p className="prose-body mt-2 text-[13px]">{injury.assessment.consequence}</p>

              <dl className="mt-3 grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="inline font-medium">What: </dt>
                  <dd className="inline">
                    {WORK_INJURY_KIND_LABEL[injury.kind] ?? injury.kind} &mdash;{" "}
                    {INJURY_CAUSE_LABEL[injury.cause] ?? injury.cause},{" "}
                    {INJURY_SEVERITY_LABEL[injury.severity] ?? injury.severity}
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">When: </dt>
                  <dd className="inline">{formatDay(injury.occurredOn)}</dd>
                </div>
                <div>
                  <dt className="inline font-medium">Window closes: </dt>
                  <dd className="inline tnum">
                    {injury.assessment.dueAt.toLocaleString("en-GB", {
                      timeZone: "Asia/Dubai",
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}{" "}
                    Dubai
                  </dd>
                </div>
                <div>
                  <dt className="inline font-medium">Insurer: </dt>
                  <dd className="inline">
                    {injury.assessment.insurerNotified ? "notified" : "NOT NOTIFIED"}
                  </dd>
                </div>
              </dl>

              <p className="prose-body mt-2 text-[13px]">{injury.description}</p>

              {canWrite ? (
                <div className="mt-4 grid gap-6 md:grid-cols-2">
                  {injury.assessment.mohreNotified ? null : (
                    <RecordNotification injuryId={injury.id} recipient="mohre" />
                  )}
                  {injury.assessment.insurerNotified ? null : (
                    <RecordNotification injuryId={injury.id} recipient="insurer" />
                  )}
                </div>
              ) : null}
            </article>
          ))}
        </section>

        {/* Immediate, and with no countdown behind it on purpose. */}
        {police.length > 0 ? (
          <section className="mt-8 space-y-3">
            <SectionHeading tone="blocked" title="Police report outstanding" count={police.length}>
              Immediate. This is not a {MOHRE_INJURY_NOTIFICATION_HOURS}-hour window and the system
              does not run a countdown against it.
            </SectionHeading>
            <ul className="space-y-1 text-[13px]">
              {police.map((i) => (
                <li key={i.id}>
                  {i.reference} &mdash; {INJURY_SEVERITY_LABEL[i.severity] ?? i.severity}, no police
                  reference recorded
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {insurerOnly.length > 0 ? (
          <section className="mt-8 space-y-3">
            <SectionHeading tone="warning" title="Insurer not notified" count={insurerOnly.length}>
              MOHRE has been told. Late notice to an insurer can void the cover.
            </SectionHeading>
            <ul className="space-y-1 text-[13px]">
              {insurerOnly.map((i) => (
                <li key={i.id}>
                  {i.reference} &mdash; {i.employeeName ?? i.employeeNo ?? "purged"},{" "}
                  {formatDay(i.occurredOn)}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── 2. The register ──────────────────────────────────────────── */}
        <section className="mt-10 space-y-4">
          <SectionHeading tone="warning" title={`Register — ${summary.statistics.year}`} count={summary.statistics.total}>
            {summary.statistics.lostTimeInjuries} lost-time, {summary.statistics.daysLost} day(s)
            lost, {summary.statistics.notifiedLate} notified late,{" "}
            {summary.statistics.investigationsOutstanding} investigation(s) open. Counted on Dubai&rsquo;s
            calendar year.
          </SectionHeading>

          {summary.register.length === 0 ? (
            <EmptyState tone="success" title="No injuries recorded.">
              Nothing has been entered in this register. That is either a good year or a register
              nobody is using &mdash; and the second is the failure this page exists to make
              visible, so it is worth knowing which.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left">
                    <th className="py-2 pr-4 font-medium">Reference</th>
                    <th className="py-2 pr-4 font-medium">Person</th>
                    <th className="py-2 pr-4 font-medium">When</th>
                    <th className="py-2 pr-4 font-medium">Cause</th>
                    <th className="py-2 pr-4 font-medium">Severity</th>
                    <th className="py-2 pr-4 font-medium">Days lost</th>
                    <th className="py-2 pr-4 font-medium">MOHRE</th>
                    <th className="py-2 font-medium">Investigation</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.register.map((i) => (
                    <tr key={i.id} className="border-t" style={{ borderColor: "var(--border)" }}>
                      <td className="py-2 pr-4 font-mono text-[12px]">{i.reference}</td>
                      <td className="py-2 pr-4">{i.employeeName ?? i.employeeNo ?? "purged"}</td>
                      <td className="py-2 pr-4">{formatDay(i.occurredOn)}</td>
                      <td className="py-2 pr-4">{INJURY_CAUSE_LABEL[i.cause] ?? i.cause}</td>
                      <td className="py-2 pr-4">{INJURY_SEVERITY_LABEL[i.severity] ?? i.severity}</td>
                      <td className="py-2 pr-4 tnum">{i.daysLost ?? "—"}</td>
                      <td className="py-2 pr-4">
                        {i.assessment.stage === "notified_late"
                          ? "late"
                          : i.assessment.mohreNotified
                            ? (i.mohreReference ?? "notified")
                            : "OUTSTANDING"}
                      </td>
                      <td className="py-2">{i.investigationCompletedOn ? "closed" : "open"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Investigations, and the corrective action that closes the loop. */}
        {canWrite && summary.investigationsOutstanding.length > 0 ? (
          <section className="mt-10 space-y-4">
            <SectionHeading
              tone="warning"
              title="Investigations open"
              count={summary.investigationsOutstanding.length}
            >
              A register with no corrective actions is a list of accidents.
            </SectionHeading>
            {summary.investigationsOutstanding.slice(0, 5).map((i) => (
              <article key={i.id} className="rounded-sm border p-5" style={{ borderColor: "var(--border)" }}>
                <h3 className="text-[14px] font-semibold">
                  {i.reference} &mdash; {INJURY_CAUSE_LABEL[i.cause] ?? i.cause},{" "}
                  {formatDay(i.occurredOn)}
                </h3>
                <p className="prose-body mt-1 text-[13px]">{i.description}</p>
                <div className="mt-3">
                  <CloseInvestigation
                    injuryId={i.id}
                    rams={ramsOptions}
                    policeOutstanding={i.policeReportOutstanding}
                  />
                </div>
              </article>
            ))}
          </section>
        ) : null}

        {/* ── 3. RAMS ──────────────────────────────────────────────────── */}
        <section className="mt-10 space-y-4">
          <SectionHeading
            tone={ramsLapsed.length > 0 ? "critical" : summary.ramsDue.length > 0 ? "warning" : "success"}
            title="Risk assessments & method statements"
            count={summary.rams.length}
          >
            {summary.ramsDue.length} falling out of review inside {RAMS_REVIEW_WARN_DAYS} days,{" "}
            {ramsLapsed.length} already past it.
          </SectionHeading>

          {summary.rams.length === 0 ? (
            <EmptyState tone="warning" title="No risk assessments on file.">
              A maintenance company working at height, on live fittings and with refrigerant has
              risk assessments. If they exist on paper only, nothing here can tell anybody when they
              fall out of review.
            </EmptyState>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {summary.rams.map((r) => (
                <li key={r.id}>
                  <span className="font-mono text-[12px]">{r.reference}</span> {r.title} &mdash;{" "}
                  {RAMS_KIND_LABEL[r.kind] ?? r.kind}, v{r.version}, {r.status}
                  {r.reviewDueOn ? (
                    <>
                      {" "}
                      &mdash; review {daysPhrase(r.daysToReview ?? 0)} ({formatDay(r.reviewDueOn)})
                    </>
                  ) : (
                    <> &mdash; no review date recorded</>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canWrite ? <AddRams kinds={RAMS_KINDS.map((k) => ({ value: k, label: RAMS_KIND_LABEL[k] }))} /> : null}
        </section>

        {/* ── 4. Toolbox talks ─────────────────────────────────────────── */}
        <section className="mt-10 space-y-4">
          <SectionHeading tone="warning" title="Toolbox talks" count={summary.talks.length} />

          {summary.talks.length === 0 ? (
            <EmptyState tone="warning" title="No toolbox talks recorded.">
              The question after an incident is whether that person was briefed. A topic and a date
              cannot answer it; an attendance list can.
            </EmptyState>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {summary.talks.map((t) => (
                <li key={t.id}>
                  {formatDay(t.heldOn)} &mdash; {t.topic}
                  {t.ramsReference ? <> (briefing {t.ramsReference})</> : null} &mdash;{" "}
                  <span className="tnum">{t.attendeeCount}</span> attendee
                  {t.attendeeCount === 1 ? "" : "s"}
                  {t.unacknowledgedCount > 0 ? (
                    <>, {t.unacknowledgedCount} unsigned</>
                  ) : null}
                  {t.presenterName ? <>, given by {t.presenterName}</> : null}
                </li>
              ))}
            </ul>
          )}

          {canWrite ? <AddToolboxTalk employees={employeeOptions} rams={ramsOptions} /> : null}
        </section>

        {/* ── 5. PPE ───────────────────────────────────────────────────── */}
        <section className="mt-10 space-y-4">
          <SectionHeading
            tone={ppeLapsed.length > 0 ? "critical" : summary.ppeDue.length > 0 ? "warning" : "success"}
            title="PPE due for replacement"
            count={summary.ppeDue.length}
          >
            Inside {PPE_REPLACEMENT_WARN_DAYS} days, {ppeLapsed.length} already past it. PPE is
            provided at the employer&rsquo;s expense and cannot be recovered from a wage.
          </SectionHeading>

          {summary.ppeDue.length === 0 ? (
            <EmptyState tone="success" title="Nothing is due for replacement.">
              No item on issue reaches its replacement date inside the next{" "}
              {PPE_REPLACEMENT_WARN_DAYS} days.
            </EmptyState>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {summary.ppeDue.map((p) => (
                <li key={p.id}>
                  {p.employeeName} &mdash; {PPE_ITEM_LABEL[p.itemKind] ?? p.itemKind}
                  {p.itemDescription ? <> ({p.itemDescription})</> : null} &mdash;{" "}
                  {daysPhrase(p.daysToReplacement ?? 0)}
                  {p.acknowledged ? null : <>, issue sheet unsigned</>}
                </li>
              ))}
            </ul>
          )}

          {canWrite ? (
            <IssuePpe
              employees={employeeOptions}
              items={PPE_ITEM_KINDS.map((k) => ({ value: k, label: PPE_ITEM_LABEL[k] }))}
            />
          ) : null}
        </section>

        {/* ── 6. Rope access ───────────────────────────────────────────── */}
        <section className="mt-10 space-y-4">
          <SectionHeading
            tone={ticketsExpired.length > 0 ? "critical" : "warning"}
            title="Rope access (IRATA)"
            count={summary.ropeAccess.length}
          />

          <p className="prose-body text-[13px]">
            Read from the technician certification register rather than from a second table of its
            own, so the dispatch gate and this board cannot disagree. An expired ticket already
            requires a recorded reason before an assignment to a rope-access service goes through;
            it is deliberately not a sixth hard block, because the five that exist each name a
            statutory penalty and this one is a scheme certification from a private body.
          </p>

          {summary.ropeAccess.length === 0 ? (
            <EmptyState tone="warning" title="No rope-access tickets recorded.">
              Record IRATA tickets as technician certifications with the rope-access services listed
              against them. Until then the dispatch gate has nothing to check.
            </EmptyState>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {summary.ropeAccess.map((t) => (
                <li key={t.certificationId}>
                  {t.technicianName} &mdash; {t.name}
                  {t.issuer ? <> ({t.issuer})</> : null} &mdash;{" "}
                  {t.expiresOn ? (
                    <>
                      {daysPhrase(t.daysRemaining ?? 0)} ({formatDay(t.expiresOn)})
                    </>
                  ) : (
                    <>no expiry recorded, so the assignment gate cannot see it at all</>
                  )}
                </li>
              ))}
            </ul>
          )}

          {ticketsNoExpiry.length > 0 ? (
            <p className="prose-body text-[13px]">
              {ticketsNoExpiry.length} ticket(s) have no expiry date. The assignment gate only ever
              looks at certifications where an expiry is recorded, so these read as held on this
              board and do not exist to the control.
            </p>
          ) : null}
        </section>

        {/* ── 7. Record an injury ──────────────────────────────────────── */}
        {canWrite ? (
          <section className="mt-10 space-y-4">
            <SectionHeading tone="critical" title="Record an injury or occupational disease" />
            <p className="prose-body text-[13px]">
              The {MOHRE_INJURY_NOTIFICATION_HOURS}-hour clock starts from when the company learned
              of it. This form asks for what the register and a notification need and nothing else
              &mdash; no diagnosis, no treatment, no body part.
            </p>
            <RecordInjury
              employees={employeeOptions}
              causes={INJURY_CAUSES.map((c) => ({ value: c, label: INJURY_CAUSE_LABEL[c] }))}
              severities={INJURY_SEVERITIES.map((s) => ({
                value: s,
                label: INJURY_SEVERITY_LABEL[s],
              }))}
              kinds={WORK_INJURY_KINDS.map((k) => ({ value: k, label: WORK_INJURY_KIND_LABEL[k] }))}
            />
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
