import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getJobDetail,
  findCandidates,
  listQuotes,
  getQuoteWithLines,
  listInvoices,
  jobContractScope,
  loadWorkingCalendar,
  listJobOutcomeCodes,
  faultCodeOptions,
  getJobOutcome,
  schema,
  ASSIGNMENT_WARNING_LABEL,
  QUOTE_STATUS_LABEL,
  INVOICE_STATUS_LABEL,
  type AssignmentWarningType,
} from "@meridian/db";
import { eq } from "drizzle-orm";
import {
  getService,
  allowedTransitions,
  nextWorkingWindow,
  toDubai,
  STATUS_LABEL,
  PRIORITY_LABEL,
  SLA_STATE_LABEL,
  minutesUntil,
  formatDuration,
  formatMoney,
  toMinor,
  type JobStatus,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { StatusActions, AssignPanel, type CandidateOption } from "./job-actions";
import { OutcomePanel } from "./outcome-panel";
import { QuotePanel, SendQuoteButton, QuoteDocumentLink } from "./quote-panel";
import { InvoicePanel } from "./invoice-panel";
import { OutOfScopePanel } from "./out-of-scope-panel";
import { MapPin, Key, Clock, ShieldCheck, Warning } from "@phosphor-icons/react/dist/ssr";

export const dynamic = "force-dynamic";

/** Statuses where adding a technician is a sensible next action. */
const ASSIGNABLE_STATUSES: readonly string[] = ["triaged", "scheduled", "paused"];

/**
 * Statuses where the outcome can still be recorded or corrected (`JOB-13`).
 *
 * `on_site` records it and completes the work in one move. `work_complete`
 * allows a correction before sign-off, which is the only window in which one is
 * honest: after sign-off the customer has agreed to a version of events, and
 * editing it afterwards changes what they signed for.
 */
const OUTCOME_STATUSES: readonly string[] = ["on_site", "work_complete"];

/**
 * `datetime-local` wants Dubai wall-clock, and so does the server that reads it
 * back. Formatting through `toDubai` rather than `toISOString` is what keeps
 * the two ends agreeing on what 16:00 means.
 */
function dubaiFieldValue(instant: Date): string {
  const t = toDubai(instant);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${t.year}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Job ${id.slice(0, 8)}` };
}

/**
 * The shape the client panel takes. The warning label is resolved here rather
 * than in the browser: `ASSIGNMENT_WARNING_LABEL` lives in `@meridian/db`, and
 * importing that package into a client component would drag the Postgres
 * driver into the bundle.
 */
function toCandidateOption(c: {
  technicianId: string;
  fullName: string;
  grade: string;
  score: number;
  reason: string;
  warnings: readonly { type: string; detail: string; requiresOverride: boolean }[];
}): CandidateOption {
  return {
    technicianId: c.technicianId,
    fullName: c.fullName,
    grade: c.grade,
    score: c.score,
    reason: c.reason,
    warnings: c.warnings.map((w) => ({
      type: w.type,
      label: ASSIGNMENT_WARNING_LABEL[w.type as AssignmentWarningType] ?? w.type,
      detail: w.detail,
      requiresOverride: w.requiresOverride,
    })),
  };
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("jobs:read");
  const { id } = await params;
  const now = new Date();

  const data = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const job = await getJobDetail(tx, id, now);
      if (!job) return null;

      // The tenant's own calendar, once, and passed to everything that needs
      // it. `JOB-6` is explicit that this is a single service rather than a
      // rule duplicated per screen — and `DEFAULT_CALENDAR` would get the
      // weekend, the holidays and the working day wrong for any tenant that has
      // configured them, which is the point of configuring them.
      const calendar = await loadWorkingCalendar(tx);

      const flags = await tx
        .select({ isOutdoor: schema.jobs.isOutdoor })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id))
        .limit(1);
      const isOutdoor = flags[0]?.isOutdoor ?? false;

      // JOB-8. Availability is a question about a window, so the panel opens on
      // one: the next legal working slot, skipping the summer midday ban when
      // the work is outdoors. "Now, for two hours" was the old implicit answer
      // and it is wrong for every job booked for tomorrow morning.
      const windowStart = nextWorkingWindow(now, { outdoor: isOutdoor, calendar });
      const windowEnd = new Date(windowStart.getTime() + 2 * 60 * 60 * 1000);

      // Only look for candidates when the job could actually take one.
      const needsAssignment = ASSIGNABLE_STATUSES.includes(job.status);
      const candidates = needsAssignment
        ? await findCandidates(tx, {
            serviceSlug: job.serviceSlug,
            property: { lat: job.propertyLat, lng: job.propertyLng, city: job.propertyCity },
            from: windowStart,
            to: windowEnd,
            calendar,
          })
        : { candidates: [], warned: [], disqualified: [], blocked: [] };

      // JOB-13 and JOB-14. Loaded for every job rather than only for the ones
      // being completed, because a closed job's outcome is the answer to "was
      // this fixed first time" and hiding it behind a status check would make
      // the record invisible exactly where it is being read.
      const outcome = await getJobOutcome(tx, id);
      const outcomeCodes = OUTCOME_STATUSES.includes(job.status)
        ? await listJobOutcomeCodes(tx, { activeOnly: true })
        : [];
      const faults = OUTCOME_STATUSES.includes(job.status)
        ? await faultCodeOptions(tx, job.serviceSlug)
        : { symptom: [], cause: [], remedy: [] };

      const quotes = await listQuotes(tx, { jobId: id });
      const invoices = await listInvoices(tx, { jobId: id });

      // Invoicing should start from what the customer actually approved, so the
      // approved quote's lines are carried through rather than retyped.
      const approved = quotes.find((q) => q.status === "approved");
      const approvedQuote = approved ? await getQuoteWithLines(tx, approved.id) : null;

      // CON-6, automatically. Null when the job is not contract work, which is
      // most jobs. Computed here rather than behind a button on purpose: a
      // check somebody has to remember to run is a check that gets forgotten on
      // exactly the job that needed it, and the work is then absorbed. See the
      // note on `jobContractScope`.
      const contractScope = await jobContractScope(tx, id);

      return {
        job,
        candidates,
        needsAssignment,
        quotes,
        invoices,
        approvedQuote,
        contractScope,
        outcome,
        outcomeCodes,
        faults,
        windowStart,
        windowEnd,
      };
    },
  );

  // RLS makes "does not exist" and "belongs to another tenant" indistinguishable
  // here, which is exactly the intended behaviour.
  if (!data) notFound();

  const {
    job,
    candidates,
    needsAssignment,
    quotes,
    invoices,
    approvedQuote,
    contractScope,
    outcome,
    outcomeCodes,
    faults,
    windowStart,
    windowEnd,
  } = data;
  const service = getService(job.serviceSlug);
  const remaining = job.resolveByAt ? minutesUntil(job.resolveByAt, now) : null;
  const canUpdate = can(session.principal, "jobs:update");
  const canAssign = can(session.principal, "jobs:assign");

  return (
    <AppShell session={session} active="jobs">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/dispatch" className="hover:underline">
            Dispatch
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <Link href="/jobs" className="hover:underline">
            Jobs
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span className="tnum" style={{ color: "var(--text-secondary)" }}>
            {job.reference}
          </span>
        </nav>

        <div className="mt-6 grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <div className="flex flex-wrap items-center gap-3">
              <span className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
                {job.reference}
              </span>
              <span
                className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
              >
                {PRIORITY_LABEL[job.priority]}
              </span>
              <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {STATUS_LABEL[job.status]}
              </span>
            </div>

            <h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">{job.title}</h1>
            {job.description ? <p className="prose-body mt-4">{job.description}</p> : null}

            <dl className="mt-8 grid gap-6 sm:grid-cols-2">
              <div>
                <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  Customer
                </dt>
                <dd className="mt-1 text-[15px] font-medium">{job.customerName}</dd>
              </div>
              <div>
                <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  Service
                </dt>
                <dd className="mt-1 text-[15px] font-medium">
                  {service?.name ?? job.serviceSlug}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  Property
                </dt>
                <dd className="mt-1 flex items-start gap-2 text-[15px] font-medium">
                  <MapPin size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                  {job.propertyName}
                  {job.propertyArea ? `, ${job.propertyArea}` : ""}, {job.propertyCity}
                </dd>
              </div>
              {job.accessInstructions ? (
                <div className="sm:col-span-2">
                  <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    Access
                  </dt>
                  <dd className="prose-body mt-1 flex items-start gap-2 text-[14px]">
                    <Key size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                    {job.accessInstructions}
                  </dd>
                </div>
              ) : null}
            </dl>

            {/* ── Visits ────────────────────────────────────────────────── */}
            <h2 className="mt-10 text-lg font-semibold tracking-tight">Visits</h2>
            {job.visits.length === 0 ? (
              <p className="prose-body mt-3 text-[14px]">No technician assigned yet.</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {job.visits.map((v) => (
                  <li
                    key={v.id}
                    className="rounded border p-4"
                    style={{ backgroundColor: "var(--surface-raised)" }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-[15px] font-medium">
                        Visit {v.sequence} &middot; {v.technicianName}
                      </p>
                      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {v.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    {v.assignmentReason ? (
                      <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {v.assignmentMethod}: {v.assignmentReason}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {/* ── Timeline ──────────────────────────────────────────────── */}
            <h2 className="mt-10 text-lg font-semibold tracking-tight">Timeline</h2>
            <ol className="mt-4">
              {job.events.map((e) => (
                <li key={e.id} className="flex gap-4 border-b py-3 last:border-0">
                  <span className="tnum shrink-0 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {e.occurredAt.toLocaleString("en-GB", {
                      timeZone: "Asia/Dubai",
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </span>
                  <div>
                    <p className="text-[14px]">
                      {e.fromStatus
                        ? `${STATUS_LABEL[e.fromStatus as keyof typeof STATUS_LABEL] ?? e.fromStatus} → ${STATUS_LABEL[e.toStatus as keyof typeof STATUS_LABEL] ?? e.toStatus}`
                        : STATUS_LABEL[e.toStatus as keyof typeof STATUS_LABEL] ?? e.toStatus}
                      {e.actorKind !== "user" ? (
                        <span style={{ color: "var(--text-muted)" }}> ({e.actorKind})</span>
                      ) : null}
                    </p>
                    {e.note ? (
                      <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {e.note}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {/* ── Sidebar ─────────────────────────────────────────────────── */}
          <aside className="space-y-6 lg:col-span-4">
            <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[14px] font-semibold">SLA</h2>
              <p className="mt-3 flex items-center gap-2 text-[15px] font-semibold">
                <Clock size={15} aria-hidden style={{ color: "var(--accent)" }} />
                {SLA_STATE_LABEL[job.sla]}
              </p>
              {remaining !== null ? (
                <p className="tnum mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {remaining >= 0
                    ? `${formatDuration(remaining)} until resolve deadline`
                    : `${formatDuration(remaining)} past resolve deadline`}
                </p>
              ) : null}
            </div>

            {/*
              ── CON-6, stated whether or not anybody asked ────────────────

              Beside the SLA banner, and for the same reason it is: both are
              facts about this job that decide what happens to it, and both are
              worthless if reading them is optional. The verdict here is the
              automatic one — service coverage and remaining entitlement — so
              it is true of every contract job on first render. What it cannot
              know is what the technician found, which is what the panel below
              collects.
            */}
            {contractScope ? (
              <div
                className="rounded border p-5"
                style={{
                  backgroundColor: "var(--surface-raised)",
                  borderColor: contractScope.decision.isCovered
                    ? undefined
                    : "var(--accent)",
                }}
              >
                <h2 className="text-[14px] font-semibold">Contract</h2>
                <p className="mt-3 flex items-start gap-2 text-[15px] font-semibold">
                  {contractScope.decision.isCovered ? (
                    <ShieldCheck
                      size={15}
                      weight="fill"
                      aria-hidden
                      className="mt-0.5 shrink-0"
                      style={{ color: "var(--accent)" }}
                    />
                  ) : (
                    <Warning
                      size={15}
                      weight="fill"
                      aria-hidden
                      className="mt-0.5 shrink-0"
                      style={{ color: "var(--accent-text)" }}
                    />
                  )}
                  {contractScope.decision.isCovered
                    ? `Covered by ${contractScope.contractReference}`
                    : `NOT COVERED by ${contractScope.contractReference}`}
                </p>
                <p className="prose-body mt-2 text-[13px]">{contractScope.decision.reason}</p>
                <p className="tnum mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {contractScope.contractName}
                </p>
              </div>
            ) : null}

            {/*
              `work_complete` is deliberately not in this list (`JOB-13`).

              It is still a legal transition and the graph still allows it; what
              changed is that on this screen it goes through the outcome panel,
              which cannot complete the work without recording what happened.
              Leaving the bare button here would leave the old door open, and a
              job that reaches `work_complete` with a null outcome has lost that
              fact permanently — `G11` is computed from that column and nobody
              reconstructs a Tuesday in January from memory in March. The server
              action refuses it too; this only stops it being offered.
            */}
            {canUpdate ? (
              <StatusActions
                jobId={job.id}
                allowed={allowedTransitions(job.status).filter(
                  (t): t is JobStatus => t !== "work_complete",
                )}
              />
            ) : null}

            {canUpdate && OUTCOME_STATUSES.includes(job.status) ? (
              <OutcomePanel
                jobId={job.id}
                outcomes={outcomeCodes.map((o) => ({
                  code: o.code,
                  label: o.label,
                  description: o.description,
                  requiresReturnVisit: o.requiresReturnVisit,
                }))}
                symptoms={faults.symptom.map((f) => ({ id: f.id, label: f.label }))}
                causes={faults.cause.map((f) => ({ id: f.id, label: f.label }))}
                remedies={faults.remedy.map((f) => ({ id: f.id, label: f.label }))}
                visits={job.visits.map((v) => ({
                  id: v.id,
                  sequence: v.sequence,
                  technicianName: v.technicianName,
                }))}
                recordedOutcome={
                  outcome.outcomeCode
                    ? { code: outcome.outcomeCode, label: outcome.outcomeLabel ?? outcome.outcomeCode }
                    : null
                }
                recordedFaults={outcome.faultCodes.map((f) => ({ kind: f.kind, label: f.label }))}
                isComplete={job.status === "work_complete"}
              />
            ) : null}

            {/* Past sign-off the outcome is no longer editable, and it is still
                the answer to "was this fixed first time". Read-only beats
                absent. */}
            {outcome.outcomeCode && !OUTCOME_STATUSES.includes(job.status) ? (
              <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h2 className="text-[14px] font-semibold">Outcome</h2>
                <p className="mt-2 text-[15px] font-medium">
                  {outcome.outcomeLabel ?? outcome.outcomeCode}
                </p>
                {outcome.faultCodes.length > 0 ? (
                  <ul className="mt-2 space-y-0.5">
                    {outcome.faultCodes.map((f) => (
                      <li key={f.id} className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {f.kind}: {f.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {can(session.principal, "quotes:read") ? (
              <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h2 className="text-[14px] font-semibold">Quotations</h2>
                {quotes.length === 0 ? (
                  <p className="prose-body mt-2 text-[13px]">None yet.</p>
                ) : (
                  <ul className="mt-3 space-y-3">
                    {quotes.map((q) => (
                      <li key={q.id} className="border-b pb-3 last:border-0 last:pb-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="tnum text-[13px]">{q.reference}</span>
                          <span className="tnum text-[13px] font-semibold">
                            {formatMoney(toMinor(q.total), q.currency)}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {QUOTE_STATUS_LABEL[q.status]}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                          {q.status === "draft" && can(session.principal, "quotes:send") ? (
                            <SendQuoteButton quoteId={q.id} reference={q.reference} />
                          ) : null}
                          <QuoteDocumentLink quoteId={q.id} reference={q.reference} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {/*
              The on-demand half, and only on contract work. `quotes:create` is
              the same permission an ordinary quote needs, because what this
              produces is an ordinary quote — priced by the contract rather than
              by whoever is filling the form in.
            */}
            {contractScope && can(session.principal, "quotes:create") ? (
              <OutOfScopePanel
                jobId={job.id}
                contractId={contractScope.contractId}
                contractReference={contractScope.contractReference}
                coverageType={contractScope.coverageType}
                exclusions={contractScope.exclusions.map((e) => ({
                  code: e.code,
                  label: e.label,
                  description: e.description,
                }))}
                verdict={contractScope.decision.verdict}
              />
            ) : null}

            {can(session.principal, "quotes:create") ? <QuotePanel jobId={job.id} /> : null}

            {can(session.principal, "invoices:read") && invoices.length > 0 ? (
              <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h2 className="text-[14px] font-semibold">Invoices</h2>
                <ul className="mt-3 space-y-3">
                  {invoices.map((i) => (
                    <li key={i.id} className="border-b pb-3 last:border-0 last:pb-0">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="tnum text-[13px]">{i.reference}</span>
                        <span className="tnum text-[13px] font-semibold">
                          {formatMoney(toMinor(i.total), i.currency)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {INVOICE_STATUS_LABEL[i.status]}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {can(session.principal, "invoices:create") ? (
              <InvoicePanel
                jobId={job.id}
                quoteReference={approvedQuote?.reference ?? null}
                quotedLines={
                  approvedQuote
                    ? approvedQuote.lines.map((l) => ({
                        description: l.description,
                        quantity: l.quantity,
                        unit: l.unit,
                        unitPrice: l.unitPrice,
                      }))
                    : []
                }
                signedOff={["signed_off", "invoiced", "closed"].includes(job.status)}
              />
            ) : null}

            {canAssign && needsAssignment ? (
              <AssignPanel
                jobId={job.id}
                serviceName={service?.shortName ?? job.serviceSlug}
                candidates={candidates.candidates.map(toCandidateOption)}
                warned={candidates.warned.map(toCandidateOption)}
                disqualified={[...candidates.disqualified]}
                blocked={candidates.blocked.map((b) => ({
                  technicianId: b.technicianId,
                  technicianName: b.technicianName,
                  detail: b.detail,
                  penalty: b.penalty,
                }))}
                defaultStart={dubaiFieldValue(windowStart)}
                defaultEnd={dubaiFieldValue(windowEnd)}
              />
            ) : null}
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
