import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, ownerDashboard, productEventReport } from "@meridian/db";
import { DASHBOARD_GOALS, tenant } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { AttentionItem, Card, Meter, Metric, money, priorityLabel } from "./dashboard-ui";

export const metadata: Metadata = { title: "Owner dashboard" };
export const dynamic = "force-dynamic";

/**
 * The owner dashboard (`KPI-3`), and the screen the weekly email (`KPI-5`)
 * renders as text.
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 *
 * One question: is the business healthy. It is read on a phone, roughly weekly,
 * by the person who carries the liability for everything on it — so it is a
 * card stack in consequence order, not a grid of tiles in alphabetical order,
 * and the first card is the only one that ever demands an action.
 *
 * ── THE ROUTE NAME ──────────────────────────────────────────────────────────
 *
 * `/reports`, which is what wireframe §8 names it — along with the route table
 * in §1.1, the role-to-landing-page table in §1.2 and the screen index in §12.
 * It was built at `/dashboard` because the brief said so; the brief was wrong
 * and the spec was not, so the spec won. Recorded here because the reasoning
 * outlives the rename: this screen grows a VAT-return pack and an accounting
 * export beside it, and "reports" still describes that page while "dashboard"
 * stops doing so the moment it holds something you export rather than read.
 *
 * ── WHY EVERY FIGURE CARRIES A LINK ─────────────────────────────────────────
 *
 * `KPI-3` is a summary of records that exist elsewhere, and the fastest way to
 * make a summary untrusted is to make it unverifiable. Every card links to the
 * screen its numbers are computed from, so "that cannot be right" has a
 * two-second answer instead of becoming a reason to stop reading it.
 */
export default async function DashboardPage() {
  const session = await requireSessionWith("reports:read");

  const { dashboard, events } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      dashboard: await ownerDashboard(tx),
      events: await productEventReport(tx, { days: 7 }),
    }),
  );

  const { cash, revenue, pipeline, work, contracts, compliance, billing } = dashboard;
  const critical = dashboard.attention.filter((a) => a.severity === "critical");

  const asOf = dashboard.generatedAt.toLocaleString("en-GB", {
    timeZone: tenant.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <AppShell session={session} active="dashboard">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">This week</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {asOf}
          </p>
        </div>

        <p className="prose-body mt-2 max-w-2xl text-[14px]">
          The same figures arrive by email every Sunday morning, so the number reaches you whether
          or not you sign in. Every card links to the records it is computed from.
        </p>

        {/* One column on a phone, two on a laptop. Never three: the card stack
            is read top to bottom in consequence order, and a third column puts
            something below the fold that was meant to be second. */}
        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          {/* ── 1. Needs you ─────────────────────────────────────────────── */}
          <div className="lg:col-span-2">
            <Card
              title="Needs you"
              tone={critical.length > 0 ? "critical" : dashboard.attention.length > 0 ? "warning" : "neutral"}
              subtitle={
                dashboard.attention.length > 0
                  ? `${dashboard.attention.length} item${dashboard.attention.length === 1 ? "" : "s"}, ` +
                    `most consequential first`
                  : undefined
              }
            >
              {dashboard.attention.length === 0 ? (
                /*
                 * A quiet week has to say what was checked.
                 *
                 * An empty first card and an unrun check look identical, and the
                 * reassuring reading is the one people take. The four named here
                 * are exactly the four conditions with a statutory penalty
                 * attached, and they are the four `attentionItems` evaluates.
                 */
                <EmptyState kind="good" title="Nothing needs you this week.">
                  <p>
                    No technician is blocked from dispatch, no company accreditation has expired, no
                    signed-off job is past its 14-day invoice deadline, and this year&rsquo;s invoice
                    series has no gaps. Those four carry a penalty; all four were checked.
                  </p>
                </EmptyState>
              ) : (
                <ul className="space-y-3">
                  {dashboard.attention.map((a) => (
                    <AttentionItem key={a.headline} {...a} />
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* ── 2. Cash ──────────────────────────────────────────────────── */}
          <Card title="Cash" href="/invoices" subtitle="Receivables, and how old they are">
            <Metric
              label="Outstanding"
              value={money(cash.outstandingMinor, cash.currency)}
              emphasis
            />
            <Metric
              label="Overdue"
              value={money(cash.overdueMinor, cash.currency)}
              verdict={cash.overdueMinor > 0 ? "missed" : "met"}
            />
            <div className="my-2 border-t" />
            <Metric label="Not yet due" value={money(cash.currentMinor, cash.currency)} />
            <Metric label="1–30 days" value={money(cash.days1to30Minor, cash.currency)} />
            <Metric label="31–60 days" value={money(cash.days31to60Minor, cash.currency)} />
            <Metric label="61+ days" value={money(cash.days61PlusMinor, cash.currency)} />
            <div className="my-2 border-t" />
            <Metric
              label="Days sales outstanding"
              value={cash.dsoDays === null ? null : `${cash.dsoDays} days`}
              verdict={cash.dsoVerdict}
              note={
                cash.dsoDays === null
                  ? "Nothing was invoiced in the last 90 days, so there is no denominator."
                  : `Target under ${DASHBOARD_GOALS["dsoDays"]!.target} days (G8). Receivables ÷ average daily revenue over 90 days.`
              }
            />
          </Card>

          {/* ── 3. Revenue and the relief line ───────────────────────────── */}
          <Card
            title="Revenue"
            href="/invoices"
            tone={
              revenue.relief.state === "breached"
                ? "critical"
                : revenue.relief.state === "approaching"
                  ? "warning"
                  : "neutral"
            }
            subtitle="Tax-exclusive, net of credit notes"
          >
            <Metric
              label="This month"
              value={money(revenue.thisMonthMinor, revenue.currency)}
              note={`${revenue.invoicesThisMonth} invoice${revenue.invoicesThisMonth === 1 ? "" : "s"}`}
              emphasis
            />
            <Metric label="Last month" value={money(revenue.lastMonthMinor, revenue.currency)} />
            <Metric label="Year to date" value={money(revenue.yearToDateMinor, revenue.currency)} />

            <div className="mt-5">
              <p className="text-[12px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
                Small Business Relief line
              </p>
              <div className="mt-2">
                <Meter
                  value={revenue.yearToDateMinor}
                  max={revenue.relief.thresholdMinor}
                  currency={revenue.currency}
                  tone={revenue.relief.state}
                />
              </div>
              {/*
                A cliff, not a target, and the copy has to say which. Crossing it
                once ends the relief permanently for every later period — so the
                useful moment to know is before, which is the only reason this is
                on a weekly screen rather than in an annual return.
              */}
              <p className="prose-body mt-3 text-[13px]">
                {revenue.relief.state === "breached" ? (
                  <>
                    <strong style={{ color: "var(--status-critical-text)" }}>
                      The line has been crossed.
                    </strong>{" "}
                    The relief is gone for this period and permanently for every later one. Confirm
                    the figure with your accountant before acting on it.
                  </>
                ) : (
                  <>
                    <strong>{money(revenue.relief.headroomMinor, revenue.currency)}</strong> of
                    headroom. Crossing AED 3,000,000 once permanently ends the relief for all later
                    periods, and it is tested on revenue rather than profit.
                  </>
                )}
              </p>
              {revenue.relief.registrationRequired ? (
                <p className="mt-2 text-[12px]" style={{ color: "var(--status-warning-text)" }}>
                  Turnover has passed AED 1,000,000, so corporate tax registration is due by 31
                  March of next year. Late registration is AED 10,000.
                </p>
              ) : null}
            </div>
          </Card>

          {/* ── 4. Work ──────────────────────────────────────────────────── */}
          <Card title="Work" href="/dispatch" subtitle="Open jobs and the SLA clock">
            <Metric label="Open jobs" value={`${work.openJobs}`} emphasis />
            <Metric
              label="Unassigned"
              value={`${work.unassigned}`}
              verdict={work.unassigned > 0 ? "missed" : "met"}
            />

            {work.byPriority.length === 0 ? (
              <div className="mt-3">
                <EmptyState kind="good" title="No open jobs.">
                  <p>
                    Every job is closed, cancelled or signed off. Nothing is waiting on a
                    technician.
                  </p>
                </EmptyState>
              </div>
            ) : (
              <ul className="mt-3 space-y-1">
                {work.byPriority.map((p) => (
                  <li key={p.priority} className="flex items-baseline justify-between gap-4">
                    <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {priorityLabel(p.priority)}
                    </span>
                    <span className="tnum text-[13px]">
                      {p.jobs}
                      {p.breached > 0 ? (
                        <span style={{ color: "var(--status-critical-text)" }}>
                          {" "}
                          · {p.breached} past a deadline
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div className="my-3 border-t" />
            {/*
              Two numbers, deliberately, and each says which it is.

              A job has a response deadline and a resolution deadline and can
              miss both. One row per missed deadline is right for the operations
              manager, who has to action each; a headline that says "13 SLA
              breaches" over 10 jobs is wrong for the owner, and a rate computed
              from it can exceed 100%.
            */}
            <Metric
              label="Jobs that missed a deadline"
              value={`${work.jobsBreachedThisWeek}`}
              note={
                `${work.deadlinesMissedThisWeek} deadline${work.deadlinesMissedThisWeek === 1 ? "" : "s"} ` +
                `missed in total — a job can miss both its response and its resolution deadline.`
              }
            />
            <Metric
              label="Breach rate"
              value={work.breachRatePercent === null ? null : `${work.breachRatePercent}%`}
              verdict={work.breachVerdict}
              note={
                work.breachRatePercent === null
                  ? "No deadline fell inside the last seven days."
                  : `${work.jobsBreachedThisWeek} of ${work.jobsWithDeadlineThisWeek} jobs with a deadline this week. Target under ${DASHBOARD_GOALS["slaBreachRate"]!.target}% (G4).`
              }
            />
          </Card>

          {/* ── 5. Pipeline ──────────────────────────────────────────────── */}
          <Card title="Pipeline" href="/leads" subtitle={`Quote funnel over ${pipeline.windowDays} days`}>
            {pipeline.byStage.length === 0 ? (
              <EmptyState kind="gap" title="No leads have ever been recorded.">
                <p>
                  Not a quiet week — an empty table. Every figure in this card is computed from
                  <code> leads</code>, so conversion, pipeline value and response time are all
                  unmeasurable until enquiries are being captured. The public quote form writes
                  here; so does converting a phone call.
                </p>
              </EmptyState>
            ) : (
              <>
                <Metric label="Open leads" value={`${pipeline.openLeads}`} emphasis />
                <Metric label="New this week" value={`${pipeline.newThisWeek}`} />
                <Metric
                  label="Open lead value"
                  value={money(pipeline.openValueMinor, revenue.currency)}
                  note="Leads with no estimate contribute to the count and not to the value."
                />
                <ul className="mt-3 space-y-1">
                  {pipeline.byStage.map((s) => (
                    <li key={s.stage} className="flex items-baseline justify-between gap-4">
                      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {s.stage.replace(/_/g, " ")}
                      </span>
                      <span className="tnum text-[13px]">
                        {s.leads}
                        {s.valueMinor > 0 ? (
                          <span style={{ color: "var(--text-muted)" }}>
                            {" "}
                            · {money(s.valueMinor, revenue.currency)}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="my-3 border-t" />
            <Metric
              label="Quotes out"
              value={money(pipeline.quotedValueMinor, revenue.currency)}
              note="Sent and not yet decided."
            />
            <Metric
              label="Conversion"
              value={pipeline.conversionPercent === null ? null : `${pipeline.conversionPercent}%`}
              verdict={pipeline.conversionVerdict}
              note={
                pipeline.conversionPercent === null
                  ? `No quotation has been sent in ${pipeline.windowDays} days, so there is nothing to divide by.`
                  : `${pipeline.quotesApproved} approved of ${pipeline.quotesSent} sent. Target ${DASHBOARD_GOALS["quoteConversion"]!.target}% or better (G5).`
              }
            />
          </Card>

          {/* ── 6. Contracts ─────────────────────────────────────────────── */}
          <Card title="Contracts" href="/customers" subtitle={`Expiring within ${compliance.horizonDays} days`}>
            {contracts.active === 0 ? (
              <EmptyState kind="gap" title="No active contracts are recorded.">
                <p>
                  Annual maintenance contracts are the revenue that makes a maintenance business
                  survivable, and none are on file. Renewal rate, PPM completion and recurring
                  revenue are all unmeasurable until they are.
                </p>
              </EmptyState>
            ) : (
              <>
                <Metric label="Active" value={`${contracts.active}`} emphasis />
                <Metric
                  label="Annual value"
                  value={money(contracts.annualValueMinor, contracts.currency)}
                />
                <Metric
                  label="Expiring"
                  value={`${contracts.expiringWithinHorizon.length}`}
                  verdict={contracts.expiringWithinHorizon.length > 0 ? "missed" : "met"}
                />
                {contracts.expiringWithinHorizon.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {contracts.expiringWithinHorizon.map((c) => (
                      <li key={c.id} className="text-[13px]">
                        <p className="font-medium">
                          {c.name}{" "}
                          <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                            · {c.customerName}
                          </span>
                        </p>
                        <p className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {c.daysRemaining < 0
                            ? `Expired ${Math.abs(c.daysRemaining)} days ago`
                            : `${c.daysRemaining} days left`}
                          {c.autoRenew
                            ? " · renews itself unless cancelled"
                            : " · does not auto-renew"}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </>
            )}
          </Card>

          {/* ── 7. People ────────────────────────────────────────────────── */}
          <Card
            title="People"
            href="/workforce"
            tone={compliance.blocked > 0 ? "critical" : "neutral"}
            subtitle="Read from the compliance board, not recomputed"
          >
            <Metric label="Headcount" value={`${compliance.headcount}`} emphasis />
            <Metric label="Deployable" value={`${compliance.deployable}`} />
            <Metric
              label="Blocked from dispatch"
              value={`${compliance.blocked}`}
              verdict={compliance.blocked > 0 ? "missed" : "met"}
              note={compliance.blocked > 0 ? compliance.blockedNames.join(", ") : undefined}
            />
            <div className="my-2 border-t" />
            <Metric
              label="Documents expiring"
              value={`${compliance.documentsExpiring}`}
              note={
                compliance.documentsExpired > 0
                  ? `${compliance.documentsExpired} already expired`
                  : `within ${compliance.horizonDays} days`
              }
            />
            <Metric
              label="Accreditations expiring"
              value={`${compliance.accreditationsExpiring}`}
              note={
                compliance.accreditationsExpired > 0
                  ? `${compliance.accreditationsExpired} already expired`
                  : undefined
              }
            />
            {compliance.nextExpiry ? (
              <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                Next: {compliance.nextExpiry.label} —{" "}
                {compliance.nextExpiry.daysRemaining < 0
                  ? `expired ${Math.abs(compliance.nextExpiry.daysRemaining)} days ago`
                  : `${compliance.nextExpiry.daysRemaining} days`}
              </p>
            ) : null}
          </Card>

          {/* ── 8. Billing risk ──────────────────────────────────────────── */}
          <Card
            title="Billing risk"
            href="/invoices"
            tone={billing.issuanceBreached > 0 || billing.sequenceGaps > 0 ? "critical" : "neutral"}
            subtitle="The two faults an FTA audit asks about"
          >
            <Metric
              label="Past the 14-day limit"
              value={`${billing.issuanceBreached}`}
              verdict={billing.issuanceBreached > 0 ? "missed" : "met"}
              note="AED 2,500 each, and the penalty has already been incurred (INV-5)."
            />
            <Metric label="Approaching it" value={`${billing.issuanceApproaching}`} />
            <Metric
              label="Invoice series gaps"
              value={`${billing.sequenceGaps}`}
              verdict={billing.sequenceGaps > 0 ? "missed" : "met"}
              note={
                billing.sequenceGaps > 0
                  ? "A missing invoice number is an audit flag. The innocent explanation is a rolled-back transaction — but somebody has to be able to give it (INV-4)."
                  : "This year's issued series is contiguous."
              }
            />
            <Metric
              label="Invoice lag"
              value={billing.invoiceLagDays === null ? null : `${billing.invoiceLagDays} days`}
              verdict={billing.invoiceLagVerdict}
              note={
                billing.invoiceLagDays === null
                  ? "No invoice this year carries a date of supply, so the lag cannot be measured."
                  : `Median from date of supply to issue. Target under ${DASHBOARD_GOALS["invoiceLagDays"]!.target} days (G7).`
              }
            />
          </Card>

          {/* ── 9. Not measured ──────────────────────────────────────────── */}
          <div className="lg:col-span-2">
            <Card
              title="Not measured"
              subtitle={`${dashboard.gaps.length} figures this screen is specified to show and cannot yet source`}
            >
              {/*
                The section that stops this dashboard being trusted further than
                it has earned.

                A metric that is silently absent gets assumed to be fine, and
                that assumption is exactly how a compliance checklist came to
                report "ready for transmission" on the strength of seven fields
                out of fifty. Each row names what is missing and what has to
                exist before it is not.
              */}
              <ul className="space-y-3">
                {dashboard.gaps.map((g) => (
                  <li key={g.metric}>
                    <p className="text-[13px] font-medium">
                      {g.metric}{" "}
                      <span className="font-normal" style={{ color: "var(--text-muted)" }}>
                        · {g.requirement}
                      </span>
                    </p>
                    <p className="prose-body mt-0.5 text-[12px]">{g.waitingOn}</p>
                  </li>
                ))}
              </ul>

              <div className="mt-5 border-t pt-4">
                <p className="text-[13px] font-medium">
                  Product events recorded this week:{" "}
                  <span className="tnum">{events.total}</span>
                </p>
                <p className="prose-body mt-1 text-[12px]">
                  {events.uninstrumented.length > 0 ? (
                    <>
                      No event stream yet for{" "}
                      {events.uninstrumented.map((e) => e.name).join(", ")}. Those are gaps in the
                      software rather than zeros in the business, which is why they are named here
                      instead of shown as rows reading nought.
                    </>
                  ) : (
                    <>Every registered event family has an emitter.</>
                  )}
                </p>
                <p className="mt-3 text-[12px]">
                  <Link href="/admin/audit" style={{ color: "var(--accent-text)" }}>
                    The audit log &mdash; who changed what, and when &rarr;
                  </Link>
                </p>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
