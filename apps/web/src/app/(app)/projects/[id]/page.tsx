import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getProject,
  listSubcontractors,
  projectVocabularies,
} from "@meridian/db";
import {
  allowedProjectTransitions,
  dubaiDateKey,
  phaseWeightGap,
  subcontractorComplianceState,
  COST_CATEGORY_LABEL,
  OPEN_SNAG_STATUSES,
  type SnagStatus,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  Chip,
  EmptyState,
  LABEL,
  Meter,
  SectionHeading,
  daysPhrase,
  formatDay,
  marginTone,
  money,
  percentFromBasisPoints,
  permitTone,
  severityTone,
  statusTone,
} from "../project-ui";
import {
  CostPanel,
  MilestonePanel,
  PermitPanel,
  PhasePanel,
  RetentionPanel,
  SnagPanel,
  TransitionPanel,
  VariationPanel,
} from "./project-panels";

export const metadata: Metadata = { title: "Project" };
export const dynamic = "force-dynamic";

/**
 * One project (`PRJ-1`…`PRJ-9`).
 *
 * ── ORDERED BY WHAT STOPS THE JOB ──────────────────────────────────────────
 *
 * Blockers first: the permits that stop the site and the critical snags that
 * stop handover. Both are refusals rather than warnings — the project cannot
 * move while either stands — so a screen that buried them under a payment
 * schedule would be a screen whose reader discovers the block by being refused.
 *
 * Money second: the margin, the variations that move it, and the retention
 * withheld. Then the plan. Then the ledgers.
 *
 * ── THE MARGIN IS SHOWN WITH ITS ARITHMETIC ────────────────────────────────
 *
 * Revenue, actual cost, committed cost and the unapproved variations that are
 * deliberately outside revenue are all on the screen beside the percentage. A
 * single margin figure with no working is a number people either believe or
 * ignore, and the two things that make this one honest — unapproved variations
 * excluded, committed cost counted — are exactly the two a reader would assume
 * went the other way.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSessionWith("projects:read");
  const canWrite = can(session.principal, "projects:write");
  const canInvoice = can(session.principal, "invoices:create");

  const { project, vocab, subcontractors } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      project: await getProject(tx, id),
      vocab: canWrite
        ? await projectVocabularies(tx)
        : { snagTrades: [], permitAuthorities: [] },
      subcontractors: canWrite ? await listSubcontractors(tx) : [],
    }),
  );

  if (!project) notFound();

  const today = dubaiDateKey(new Date());

  const blockingPermitRows = project.permits.filter(
    (p) => p.isRequired && (p.status !== "approved" || (p.expiresOn !== null && p.expiresOn < today)),
  );
  const openSnags = project.snags.filter((s) =>
    OPEN_SNAG_STATUSES.includes(s.status as SnagStatus),
  );
  const openCritical = openSnags.filter((s) => s.severity === "critical");

  const outstandingRetention = project.retention.filter(
    (r) => r.status === "held" || r.status === "due",
  );
  const releasable = outstandingRetention.filter((r) => r.dueOn !== null);

  const weightGap = phaseWeightGap(
    project.phases
      .filter((p) => p.status !== "cancelled")
      .map((p) => ({ weightBasisPoints: p.weightBasisPoints })),
  );

  const margin = project.financials.margin;

  return (
    <AppShell session={session} active="projects">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/projects" className="hover:underline" style={{ color: "var(--text-muted)" }}>
            &larr; Projects
          </Link>
        </p>

        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{project.name}</h1>
            <p className="mt-1 text-[14px]" style={{ color: "var(--text-secondary)" }}>
              <span className="tnum">{project.reference}</span> &middot; {project.customerName}
              {project.propertyName ? ` · ${project.propertyName}` : ""}
              {project.projectManagerName ? ` · ${project.projectManagerName}` : ""}
            </p>
          </div>
          <Chip tone={statusTone(project.status)} label={LABEL.status[project.status]}>
            {project.percentComplete === null
              ? "no plan entered"
              : `${project.percentComplete}% complete`}
          </Chip>
        </div>

        {/* ── 1. What is stopping this project ──────────────────────────── */}
        {blockingPermitRows.length > 0 || openCritical.length > 0 ? (
          <section className="mt-8 space-y-3">
            {blockingPermitRows.length > 0 ? (
              <EmptyState
                tone="critical"
                title={`${blockingPermitRows.length} required permit${blockingPermitRows.length === 1 ? "" : "s"} not in force — this project cannot go on site.`}
              >
                {blockingPermitRows
                  .map(
                    (p) =>
                      `${p.authorityLabel} ${p.permitType} (${LABEL.permit[p.status]}${p.expiresOn && p.expiresOn < today ? `, expired ${formatDay(p.expiresOn)}` : ""})`,
                  )
                  .join("; ")}
                . Working without one draws a stop-work notice from the authority, which costs the
                programme far more than the wait for the approval does.
              </EmptyState>
            ) : null}

            {openCritical.length > 0 ? (
              <EmptyState
                tone="critical"
                title={`${openCritical.length} critical snag${openCritical.length === 1 ? "" : "s"} open — practical completion cannot be recorded.`}
              >
                A critical snag is one that makes the premises unsafe or unusable, which is exactly
                what practical completion certifies is not the case. Major and minor snags do not
                block handover, and never have.
              </EmptyState>
            ) : null}
          </section>
        ) : null}

        {/* ── 2. The money ──────────────────────────────────────────────── */}
        <section aria-labelledby="money-heading" className="mt-10">
          <div id="money-heading">
            <SectionHeading tone={marginTone(margin.marginBasisPoints)} title="Where the money is">
              Contract value plus approved variations, against cost incurred and cost committed.
            </SectionHeading>
          </div>

          <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                label: "Revenue",
                value: money(margin.revenueMinor),
                note: `${money(project.contractValueMinor)} awarded + ${money(margin.revenueMinor - project.contractValueMinor)} approved variations`,
              },
              {
                label: "Cost incurred",
                value: money(margin.actualCostMinor),
                note:
                  project.financials.breakdown.length === 0
                    ? "nothing booked yet"
                    : project.financials.breakdown
                        .map((b) => `${COST_CATEGORY_LABEL[b.category]} ${money(b.actualMinor)}`)
                        .join(" · "),
              },
              {
                label: "Cost committed",
                value: money(margin.committedCostMinor),
                note: "ordered or subcontracted, invoice not yet arrived",
              },
              {
                label: "Margin",
                value: `${money(margin.marginMinor)} · ${percentFromBasisPoints(margin.marginBasisPoints)}`,
                note: "committed cost counted, unapproved variations excluded",
              },
            ].map((card) => (
              <div
                key={card.label}
                className="rounded-sm border p-4"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <dt className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {card.label}
                </dt>
                <dd className="tnum mt-1 text-[18px] font-semibold">{card.value}</dd>
                <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                  {card.note}
                </p>
              </div>
            ))}
          </dl>

          {margin.unapprovedVariationMinor !== 0 ? (
            <div className="mt-4">
              <EmptyState
                tone="warning"
                title={`${money(margin.unapprovedVariationMinor)} of variations are instructed and not approved.`}
              >
                Deliberately outside the revenue above. Work may already be happening against it,
                and until the client approves it there is nothing securing the money — which is why
                it is totalled separately rather than folded in.
              </EmptyState>
            </div>
          ) : null}

          {project.financials.retentionHeldMinor > 0 ? (
            <p className="prose-body mt-3 text-[13px]">
              {money(project.financials.retentionHeldMinor)} is withheld as retention against{" "}
              {money(project.financials.invoicedMinor)} invoiced. It is already-earned revenue in
              the client&rsquo;s account, and it comes back only when somebody asks.
            </p>
          ) : null}
        </section>

        {/* ── 3. Status machine ─────────────────────────────────────────── */}
        {canWrite ? (
          <section aria-labelledby="status-heading" className="mt-10">
            <div id="status-heading">
              <SectionHeading tone="neutral" title="Move the project">
                The graph is enforced, not advised. Illegal steps are not offered and would be
                refused anyway.
              </SectionHeading>
            </div>
            <div className="mt-4">
              <TransitionPanel
                projectId={project.id}
                status={project.status}
                allowed={allowedProjectTransitions(project.status)}
              />
            </div>
          </section>
        ) : null}

        {/* ── 4. Phases ─────────────────────────────────────────────────── */}
        <section aria-labelledby="phases-heading" className="mt-10">
          <div id="phases-heading">
            <SectionHeading tone="neutral" title="Phases" count={project.phases.length}>
              Weighted, because a six-week first fix and a one-day handover clean are not the same
              size.
            </SectionHeading>
          </div>

          {project.phases.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="neutral" title="No plan entered.">
                A project with no phases is not 0% complete — it is one whose plan has not been
                entered, and the screens say so rather than showing a zero.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">#</th>
                    <th className="py-2 pr-4 font-medium">Phase</th>
                    <th className="py-2 pr-4 font-medium">Planned</th>
                    <th className="py-2 pr-4 font-medium">Weight</th>
                    <th className="py-2 pr-4 font-medium">Progress</th>
                    <th className="py-2 font-medium">Jobs</th>
                  </tr>
                </thead>
                <tbody>
                  {project.phases.map((p) => (
                    <tr key={p.id} className="border-b">
                      <td className="py-2.5 pr-4 tnum">{p.sequence}</td>
                      <td className="py-2.5 pr-4 font-medium">{p.name}</td>
                      <td className="py-2.5 pr-4">
                        {formatDay(p.plannedStartOn)} — {formatDay(p.plannedEndOn)}
                      </td>
                      <td className="py-2.5 pr-4 tnum">{p.weightBasisPoints / 100}%</td>
                      <td className="py-2.5 pr-4">
                        <span className="inline-flex items-center gap-2">
                          <Meter percent={p.percentComplete} tone="success" />
                          <span className="tnum">{p.percentComplete}%</span>
                        </span>
                      </td>
                      <td className="py-2.5 tnum">{p.jobCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite ? (
            <div className="mt-5">
              <PhasePanel
                projectId={project.id}
                phases={project.phases.map((p) => ({
                  id: p.id,
                  sequence: p.sequence,
                  name: p.name,
                  percentComplete: p.percentComplete,
                }))}
                weightGap={weightGap}
              />
            </div>
          ) : null}
        </section>

        {/* ── 5. Milestones ─────────────────────────────────────────────── */}
        <section aria-labelledby="milestones-heading" className="mt-10">
          <div id="milestones-heading">
            <SectionHeading tone="neutral" title="Payment milestones" count={project.milestones.length}>
              A reached milestone raises one invoice, with no job behind it — the thing the
              one-job-one-invoice model cannot express.
            </SectionHeading>
          </div>

          {project.milestones.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No payment schedule.">
                A multi-week project with no milestones is one that gets invoiced at the end, which
                is the cash-flow shape this module exists to avoid.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">#</th>
                    <th className="py-2 pr-4 font-medium">Milestone</th>
                    <th className="py-2 pr-4 font-medium">Trigger</th>
                    <th className="py-2 pr-4 text-right font-medium">Value</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Invoice</th>
                  </tr>
                </thead>
                <tbody>
                  {project.milestones.map((m) => (
                    <tr key={m.id} className="border-b">
                      <td className="py-2.5 pr-4 tnum">{m.sequence}</td>
                      <td className="py-2.5 pr-4 font-medium">{m.name}</td>
                      <td className="py-2.5 pr-4">
                        {m.triggerKind === "date"
                          ? formatDay(m.triggerOn)
                          : m.triggerKind === "percent_complete"
                            ? `${m.triggerPercent}% complete`
                            : "Client sign-off"}
                        {m.triggerMet === true && m.status === "pending" ? (
                          <span
                            className="block text-[12px]"
                            style={{ color: "var(--status-success-text)" }}
                          >
                            trigger met
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4 text-right tnum">{money(m.valueMinor)}</td>
                      <td className="py-2.5 pr-4">
                        <Chip
                          tone={
                            m.status === "invoiced"
                              ? "success"
                              : m.status === "reached"
                                ? "warning"
                                : "neutral"
                          }
                          label={LABEL.milestone[m.status as keyof typeof LABEL.milestone] ?? m.status}
                        />
                      </td>
                      <td className="py-2.5 tnum">
                        {m.invoiceReference ? (
                          <Link href="/invoices" className="hover:underline">
                            {m.invoiceReference}
                          </Link>
                        ) : (
                          <span style={{ color: "var(--text-muted)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite || canInvoice ? (
            <div className="mt-5">
              <MilestonePanel
                projectId={project.id}
                milestones={project.milestones.map((m) => ({
                  id: m.id,
                  sequence: m.sequence,
                  name: m.name,
                  status: m.status,
                  triggerMet: m.triggerMet,
                }))}
                phases={project.phases.map((p) => ({
                  id: p.id,
                  sequence: p.sequence,
                  name: p.name,
                }))}
                canWrite={canWrite}
                canInvoice={canInvoice}
              />
            </div>
          ) : null}
        </section>

        {/* ── 6. Variations ─────────────────────────────────────────────── */}
        <section aria-labelledby="variations-heading" className="mt-10">
          <div id="variations-heading">
            <SectionHeading
              tone={margin.unapprovedVariationMinor !== 0 ? "warning" : "neutral"}
              title="Variations"
              count={project.variations.length}
            >
              Unrecorded variations are the standard way a fit-out contractor loses money — and it
              is never one big one.
            </SectionHeading>
          </div>

          {project.variations.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="neutral" title="None recorded.">
                On a project of this length that is unusual rather than clean. An omission counts
                too, and it goes in as a negative value.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">Reference</th>
                    <th className="py-2 pr-4 font-medium">Variation</th>
                    <th className="py-2 pr-4 text-right font-medium">Value</th>
                    <th className="py-2 pr-4 font-medium">State</th>
                    <th className="py-2 font-medium">Client reference</th>
                  </tr>
                </thead>
                <tbody>
                  {project.variations.map((v) => (
                    <tr key={v.id} className="border-b">
                      <td className="py-2.5 pr-4 tnum">{v.reference}</td>
                      <td className="py-2.5 pr-4">
                        <span className="font-medium">{v.title}</span>
                        {v.instructedBy ? (
                          <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                            instructed by {v.instructedBy}
                            {v.instructedOn ? ` on ${formatDay(v.instructedOn)}` : ""}
                            {v.programmeImpactDays > 0 ? ` · +${v.programmeImpactDays} days` : ""}
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4 text-right tnum">{money(v.valueMinor)}</td>
                      <td className="py-2.5 pr-4">
                        <Chip
                          tone={
                            v.approvalState === "approved"
                              ? "success"
                              : v.approvalState === "rejected" || v.approvalState === "withdrawn"
                                ? "neutral"
                                : "warning"
                          }
                          label={LABEL.variation[v.approvalState]}
                        />
                      </td>
                      <td className="py-2.5 tnum">
                        {v.clientReference ?? (
                          <span style={{ color: "var(--text-muted)" }}>none recorded</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite ? (
            <div className="mt-5">
              <VariationPanel
                projectId={project.id}
                variations={project.variations.map((v) => ({
                  id: v.id,
                  reference: v.reference,
                  title: v.title,
                  approvalState: v.approvalState,
                }))}
              />
            </div>
          ) : null}
        </section>

        {/* ── 7. Retention ──────────────────────────────────────────────── */}
        <section aria-labelledby="retention-heading" className="mt-10">
          <div id="retention-heading">
            <SectionHeading
              tone={outstandingRetention.length > 0 ? "warning" : "neutral"}
              title="Retention"
              count={project.retention.length}
            >
              {percentFromBasisPoints(project.retentionBasisPoints)} of every invoice, half released
              at practical completion and half {project.defectsLiabilityDays} days later.
            </SectionHeading>
          </div>

          {project.retention.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="neutral" title="Nothing withheld yet.">
                Retention is recorded when the first milestone invoice is raised. It is taken from
                the tax-exclusive value — the VAT was declared on the full amount at the tax point
                and is owed whether or not the client has paid it.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">Invoice</th>
                    <th className="py-2 pr-4 font-medium">Release</th>
                    <th className="py-2 pr-4 text-right font-medium">Amount</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Due</th>
                  </tr>
                </thead>
                <tbody>
                  {project.retention.map((r) => (
                    <tr key={r.id} className="border-b">
                      <td className="py-2.5 pr-4 tnum">{r.invoiceReference}</td>
                      <td className="py-2.5 pr-4">{LABEL.retentionStage[r.stage]}</td>
                      <td className="py-2.5 pr-4 text-right tnum">{money(r.amountMinor)}</td>
                      <td className="py-2.5 pr-4">
                        <Chip
                          tone={
                            r.status === "released"
                              ? "success"
                              : r.daysToDue !== null && r.daysToDue < 0
                                ? "critical"
                                : "warning"
                          }
                          label={LABEL.retentionStatus[r.status]}
                        />
                      </td>
                      <td className="py-2.5">
                        {r.dueOn ? formatDay(r.dueOn) : "—"}
                        <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {daysPhrase(r.daysToDue)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite && releasable.length > 0 ? (
            <div className="mt-5">
              <RetentionPanel
                projectId={project.id}
                entries={releasable.map((r) => ({
                  id: r.id,
                  label: `${r.invoiceReference} · ${LABEL.retentionStage[r.stage]} · ${money(r.amountMinor)}`,
                }))}
              />
            </div>
          ) : null}
        </section>

        {/* ── 8. Permits ────────────────────────────────────────────────── */}
        <section aria-labelledby="permits-heading" className="mt-10">
          <div id="permits-heading">
            <SectionHeading
              tone={blockingPermitRows.length > 0 ? "critical" : "neutral"}
              title="Permits"
              count={project.permits.length}
            >
              A required permit that is unapproved — or approved and expired — stops the project
              entering site.
            </SectionHeading>
          </div>

          {project.permits.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="warning" title="No permits recorded.">
                An empty register is not the same as no permits needed. Whatever the authorities
                require for this building, the record of it belongs here — the gate reads this
                table and nothing else.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">Authority</th>
                    <th className="py-2 pr-4 font-medium">Permit</th>
                    <th className="py-2 pr-4 font-medium">Reference</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Expires</th>
                    <th className="py-2 text-right font-medium">Fee</th>
                  </tr>
                </thead>
                <tbody>
                  {project.permits.map((p) => (
                    <tr key={p.id} className="border-b">
                      <td className="py-2.5 pr-4">{p.authorityLabel}</td>
                      <td className="py-2.5 pr-4">
                        <span className="font-medium">{p.permitType}</span>
                        {!p.isRequired ? (
                          <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                            not required to start
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5 pr-4 tnum">
                        {p.referenceNumber ?? <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                      <td className="py-2.5 pr-4">
                        <Chip
                          tone={permitTone(p.status, p.expiresOn, today)}
                          label={LABEL.permit[p.status]}
                        />
                      </td>
                      <td className="py-2.5 pr-4">{formatDay(p.expiresOn)}</td>
                      <td className="py-2.5 text-right tnum">{money(p.feePaidMinor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite ? (
            <div className="mt-5">
              <PermitPanel
                projectId={project.id}
                authorities={vocab.permitAuthorities.map((a) => ({ code: a.code, label: a.label }))}
                permits={project.permits.map((p) => ({
                  id: p.id,
                  authorityLabel: p.authorityLabel,
                  permitType: p.permitType,
                  status: p.status,
                }))}
              />
            </div>
          ) : null}
        </section>

        {/* ── 9. Snags ──────────────────────────────────────────────────── */}
        <section aria-labelledby="snags-heading" className="mt-10">
          <div id="snags-heading">
            <SectionHeading
              tone={openCritical.length > 0 ? "critical" : openSnags.length > 0 ? "warning" : "neutral"}
              title="Snag list"
              count={project.snags.length}
            >
              {openSnags.length} open, {openCritical.length} of them critical. Only critical snags
              stop handover.
            </SectionHeading>
          </div>

          {project.snags.length === 0 ? (
            <div className="mt-4">
              <EmptyState tone="neutral" title="Nothing raised.">
                On a project at handover an empty snag list usually means nobody has walked it yet.
              </EmptyState>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-[14px]">
                <thead>
                  <tr className="border-b text-left" style={{ color: "var(--text-muted)" }}>
                    <th className="py-2 pr-4 font-medium">#</th>
                    <th className="py-2 pr-4 font-medium">Where</th>
                    <th className="py-2 pr-4 font-medium">Trade</th>
                    <th className="py-2 pr-4 font-medium">Severity</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 font-medium">Target</th>
                  </tr>
                </thead>
                <tbody>
                  {project.snags.map((s) => (
                    <tr key={s.id} className="border-b">
                      <td className="py-2.5 pr-4 tnum">{s.sequence}</td>
                      <td className="py-2.5 pr-4">
                        <span className="font-medium">{s.locationText}</span>
                        <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {s.description}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">{s.tradeLabel}</td>
                      <td className="py-2.5 pr-4">
                        <Chip
                          tone={severityTone(s.severity)}
                          label={LABEL.severity[s.severity]}
                        />
                      </td>
                      <td className="py-2.5 pr-4">
                        {LABEL.snag[s.status]}
                        {s.closurePhotoStorageKey ? (
                          <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                            evidence attached
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2.5">{formatDay(s.targetOn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite ? (
            <div className="mt-5">
              <SnagPanel
                projectId={project.id}
                trades={vocab.snagTrades.map((t) => ({ code: t.code, label: t.label }))}
                openSnags={openSnags.map((s) => ({
                  id: s.id,
                  sequence: s.sequence,
                  locationText: s.locationText,
                  severity: s.severity,
                }))}
              />
            </div>
          ) : null}
        </section>

        {/* ── 10. Cost and subcontract ──────────────────────────────────── */}
        {canWrite ? (
          <section aria-labelledby="cost-heading" className="mt-10">
            <div id="cost-heading">
              <SectionHeading tone="neutral" title="Cost and subcontract">
                This is the only place in the system that records what work costs rather than what
                it is sold for.
              </SectionHeading>
            </div>
            <div className="mt-5">
              <CostPanel
                projectId={project.id}
                phases={project.phases.map((p) => ({
                  id: p.id,
                  sequence: p.sequence,
                  name: p.name,
                }))}
                // The licence and insurance state is computed here rather than
                // stored, and it is put in front of the person choosing. A
                // subcontractor with a lapsed trade licence is one who cannot
                // lawfully be on a client's site, and the moment to find that
                // out is before the engagement, not at the gate.
                subcontractors={subcontractors.map((s) => ({
                  id: s.id,
                  name: s.name,
                  status: s.status,
                  compliance: subcontractorComplianceState(
                    {
                      licenceExpiresOn: s.tradeLicenceExpiresOn,
                      insuranceExpiresOn: s.liabilityExpiresOn,
                    },
                    today,
                  ),
                }))}
              />
            </div>
          </section>
        ) : null}

        {project.scope ? (
          <section className="mt-10">
            <SectionHeading tone="neutral" title="Scope of works" />
            <p className="prose-body mt-3 whitespace-pre-wrap text-[14px]">{project.scope}</p>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
