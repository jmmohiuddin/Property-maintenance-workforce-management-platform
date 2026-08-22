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

/** Minutes as hours, to one decimal. Utilisation is read in days, not minutes. */
function hours(minutes: number): string {
  return `${(minutes / 60).toLocaleString("en-GB", { maximumFractionDigits: 0 })} h`;
}

/** "hvac-installation-maintenance" -> "Hvac installation maintenance". */
function serviceLabel(slug: string | null): string {
  if (!slug) return "Not classified";
  const words = slug.replace(/[-_]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "2026-08" -> "Aug 26". Short enough for twelve rows on a phone. */
function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  // An unparseable key renders as itself rather than as "Invalid Date". The
  // breakdown always returns a key; this is the guard that keeps a future
  // caller's empty string from putting nonsense on the owner's screen.
  if (!year || !month || Number.isNaN(Number(year)) || Number.isNaN(Number(month))) return key;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return `${date.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${year.slice(2)}`;
}

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

  const { cash, revenue, pipeline, work, contracts, compliance, hiring, billing, emiratisation } =
    dashboard;
  const { revenueBreakdown: breakdown, utilisation, outcomes, retention } = dashboard;
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
          The cash, revenue, work, pipeline and compliance figures arrive by email every Sunday
          morning, so those numbers reach you whether or not you sign in; the three management
          cards lower down are read here. Every card links to the records it is computed from.
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
            href="/reports/tax"
            tone={
              dashboard.tax.current?.standing === "disqualified" ||
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
              {/*
                The meter above measures THIS period, and the relief is lost
                permanently by a breach in ANY period — so a business that
                crossed the line two years ago would otherwise read a
                comfortable green bar here every January. The disqualification
                outranks the bar rather than sitting under it.
              */}
              {dashboard.tax.current?.standing === "disqualified" ? (
                <p className="prose-body mt-3 text-[13px]">
                  <strong style={{ color: "var(--status-critical-text)" }}>
                    The relief was lost in {dashboard.tax.current.disqualifyingPeriod}.
                  </strong>{" "}
                  This period is under the line and that does not bring it back — one breach
                  disqualifies every later period.{" "}
                  <Link href="/reports/tax" style={{ color: "var(--accent-text)" }}>
                    Every period
                  </Link>
                  .
                </p>
              ) : (
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
              )}
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
          <Card title="Contracts" href="/amc" subtitle={`Expiring within ${compliance.horizonDays} days`}>
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
                {/*
                  G12. Null renders "not measured", which is the only honest
                  answer before a visit window has closed — 0% would show a
                  contractor who has just signed their first AMC as failing a
                  98% target, and 100% would award a perfect score to a business
                  that has not done any maintenance yet.
                */}
                <Metric
                  label="PPM completion"
                  value={
                    contracts.ppmCompletionPercent === null
                      ? null
                      : `${contracts.ppmCompletionPercent}%`
                  }
                  verdict={contracts.ppmVerdict}
                  note={
                    contracts.ppmCompletionPercent === null
                      ? "No planned visit has reached the end of its window yet, so nothing can have been missed."
                      : `${contracts.ppmVisitsCompleted} of ${contracts.ppmVisitsDue} visits due were done. Target ${DASHBOARD_GOALS["ppmCompletion"]!.target}% or better (G12).`
                  }
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

            {/*
              HR-18. A range, not a number — `lowerBound`–`upperBound` from
              `assessEmiratisation`, because an employee with no ISCO group or
              certificate answer recorded is not unskilled, nobody has said. The
              establishment is banded on the upper bound, so a missing fact
              reads as "the threshold may already have been crossed" rather
              than as a reassuring low figure. Collapsing this to one number
              would reintroduce exactly the misleading figure this card used to
              omit as a named gap.
            */}
            <div className="my-2 border-t" />
            <p
              className="text-[12px] font-semibold uppercase tracking-wide"
              style={{ color: "var(--text-secondary)" }}
            >
              Emiratisation (HR-18)
            </p>
            <Metric
              label="Skilled headcount"
              value={
                emiratisation.unknown > 0
                  ? `${emiratisation.lowerBound}–${emiratisation.upperBound}`
                  : `${emiratisation.lowerBound}`
              }
              note={`Threshold ${emiratisation.threshold}${emiratisation.unknown > 0 ? ` · ${emiratisation.unknown} employee${emiratisation.unknown === 1 ? "" : "s"} unclassifiable` : ""}`}
            />
            <p className="prose-body mt-1 text-[12px]">{emiratisation.headline}</p>
            {emiratisation.caveat ? (
              <p
                className="mt-1 text-[12px]"
                style={{
                  color: emiratisation.undecidedByMissingFacts
                    ? "var(--status-warning-text)"
                    : "var(--text-muted)",
                }}
              >
                {emiratisation.caveat}
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

          {/* ── 9. Hiring ────────────────────────────────────────────────── */}
          <Card title="Hiring" href="/recruitment" subtitle={`Open roles, and how long a hire takes`}>
            {/*
              This card was a line in "Not measured" until migration 0018,
              declaring that no requisition or application table existed. Both
              had existed since 0014, in the same branch. It is placed here —
              below the four cards with a statutory penalty behind them and
              above the gap list — because a slow hire costs money and a lapsed
              work permit costs AED 100,000, and consequence order is the only
              order this stack has.
            */}
            {hiring.requisitionsRecorded === 0 ? (
              /*
                A START zero, not a `gap`.

                Nothing is going unrecorded here — the module simply has not
                been used yet, which is exactly what day one looks like. A `gap`
                would put a warning colour on a business that has never needed
                to hire, and that is how a reader learns to ignore the warning
                colours everywhere else on this screen.
              */
              <EmptyState kind="start" title="No role has been opened yet.">
                <p>
                  Days-to-hire and applicant flow are both computed from requisitions, so they
                  begin being measured the moment the first one is raised. Nothing is missing
                  &mdash; there is simply nothing to hire for yet.
                </p>
              </EmptyState>
            ) : (
              <>
                {hiring.openRoles === 0 ? (
                  <EmptyState kind="good" title="No role is open at the moment.">
                    <p>
                      {hiring.requisitionsRecorded} requisition
                      {hiring.requisitionsRecorded === 1 ? " has" : "s have"} been recorded and none
                      is currently taking applications. Nobody is waiting on you.
                    </p>
                  </EmptyState>
                ) : (
                  <>
                    <Metric label="Open roles" value={`${hiring.openRoles}`} emphasis />
                    <Metric
                      label="Heads wanted"
                      value={`${hiring.openHeadcount}`}
                      note="A single requisition can be open for more than one person."
                    />
                    <Metric label="Live applications" value={`${hiring.liveApplications}`} />
                  </>
                )}

                {/*
                  A role approved and never published is invisible to every
                  applicant while looking, on the recruitment board, exactly
                  like a role that is live.
                */}
                {hiring.awaitingApproval > 0 ? (
                  <Metric
                    label="Waiting for approval"
                    value={`${hiring.awaitingApproval}`}
                    verdict="missed"
                    note="Nobody can apply to these until they are approved and published."
                  />
                ) : null}

                <div className="my-2 border-t" />
                <Metric
                  label="Days to hire"
                  value={
                    hiring.medianDaysToHire === null ? null : `${hiring.medianDaysToHire} days`
                  }
                  verdict={hiring.daysToHireVerdict}
                  note={
                    hiring.medianDaysToHire === null
                      ? `Nobody has been hired in ${hiring.windowDays} days, so there is nothing to take a median of.`
                      : `Median across ${hiring.hiresInWindow} hire${hiring.hiresInWindow === 1 ? "" : "s"} in ${hiring.windowDays} days, from application received to offer accepted. Target under ${DASHBOARD_GOALS["daysToHire"]!.target} days (G13).`
                  }
                />
              </>
            )}
          </Card>

          {/* ── 9a. Where the money comes from (MD-1) ────────────────────── */}
          <div className="lg:col-span-2">
            <Card
              title="Where the money comes from"
              href="/invoices"
              subtitle={`Tax-exclusive, net of credit notes, over ${breakdown.months} months from ${monthLabel(breakdown.fromMonth)}`}
            >
              {breakdown.attributedMinor === 0 && breakdown.windowRevenueMinor === 0 ? (
                <EmptyState kind="start" title="Nothing has been invoiced in the last year.">
                  <p>
                    The breakdown is computed from invoice lines, so it begins the moment the first
                    invoice is issued. Nothing is missing &mdash; there is simply nothing to split
                    yet.
                  </p>
                </EmptyState>
              ) : (
                <div className="grid gap-8 md:grid-cols-2">
                  <div>
                    <p
                      className="text-[12px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      By service line
                    </p>
                    {/*
                      "Showing 8 of 41", not eight rows presented as the whole
                      business. The figure above the list is a SQL aggregate over
                      every line; the list is the top of it. Five separate places
                      in this product once summed a headline from a page of rows,
                      and none of them looked truncated — they looked like a
                      plateau, which is the one shape of wrong number nobody
                      investigates.
                    */}
                    <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      Showing {breakdown.byServiceLine.length} of {breakdown.serviceLinesTotal}
                      {breakdown.otherMinor !== 0
                        ? ` — the rest total ${money(breakdown.otherMinor, breakdown.currency)}`
                        : ""}
                    </p>
                    <ul className="mt-3 space-y-1">
                      {breakdown.byServiceLine.map((line) => (
                        <li
                          key={line.serviceSlug ?? "unclassified"}
                          className="flex flex-wrap items-baseline justify-between gap-x-4"
                        >
                          <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                            {serviceLabel(line.serviceSlug)}
                          </span>
                          <span className="tnum text-[13px]">
                            {money(line.revenueMinor, breakdown.currency)}
                            <span style={{ color: "var(--text-muted)" }}>
                              {" "}
                              · {line.jobsCompleted} job{line.jobsCompleted === 1 ? "" : "s"}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                    {breakdown.unattributedMinor !== 0 ? (
                      /*
                        The residual. Normally zero, because a document's line
                        nets sum exactly to its taxable amount. It is shown
                        rather than absorbed because a breakdown that quietly
                        fails to add up to the total above it is worse than one
                        that says so.
                      */
                      <p className="mt-3 text-[12px]" style={{ color: "var(--status-warning-text)" }}>
                        {money(breakdown.unattributedMinor, breakdown.currency)} of revenue cannot
                        be attributed to a service line &mdash; those invoice lines carry no net
                        amount, which is what every line written before the Article 59 migration
                        looks like. It is counted in the total and left out of the split rather
                        than spread across it.
                      </p>
                    ) : null}
                  </div>

                  <div>
                    <p
                      className="text-[12px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      By month
                    </p>
                    <p className="mt-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
                      Dubai calendar months. An invoice raised at 01:00 on the 1st belongs to the
                      month it was raised in here, whatever the server thinks the date is.
                    </p>
                    <ul className="mt-3 space-y-1">
                      {breakdown.byMonth.map((m) => (
                        <li key={m.month} className="flex flex-wrap items-baseline justify-between gap-x-4">
                          <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                            {monthLabel(m.month)}
                          </span>
                          <span className="tnum text-[13px]">
                            {money(m.revenueMinor, breakdown.currency)}
                            <span style={{ color: "var(--text-muted)" }}>
                              {" "}
                              · {m.jobsCompleted} job{m.jobsCompleted === 1 ? "" : "s"}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              {/*
                MD-1 asks for margin and this card does not show it, for the
                same reason the AMC screen does not: the system records price
                and not cost outside project work. Said here rather than left as
                a blank space, because an absent number reads as an oversight
                and somebody eventually fills it with an estimate. The full
                reasoning is in the "Not measured" card below.
              */}
              <p className="mt-6 border-t pt-4 text-[12px]" style={{ color: "var(--text-muted)" }}>
                No margin is shown, and that is deliberate. Cost is recorded only against projects
                &mdash; maintenance and AMC work, which is nearly all of the revenue above, has no
                cost row at all &mdash; so a margin here would be estimated rather than measured.
                A made-up number that looks precise is worse than none, because somebody prices
                against it.
              </p>
            </Card>
          </div>

          {/* ── 9b. Technicians (MD-3) ───────────────────────────────────── */}
          <Card
            title="Technicians"
            href="/technicians"
            subtitle={`Time on the tools over ${utilisation.windowDays} days`}
          >
            <Metric
              label="Utilisation"
              value={utilisation.utilisationPercent === null ? null : `${utilisation.utilisationPercent}%`}
              emphasis
              note={
                utilisation.utilisationPercent === null
                  ? "No visit in the window carries recorded labour, so there is nothing to divide. Not zero — zero would say the technicians did nothing."
                  : `${hours(utilisation.workedMinutes)} recorded against ${hours(utilisation.availableMinutes)} available across ${utilisation.technicians} technician${utilisation.technicians === 1 ? "" : "s"}, on this company's own working calendar and less approved leave.`
              }
            />
            {/*
              The coverage line is not decoration. Utilisation computed over a
              job card nobody fills in reads as idle technicians and means an
              empty form, and those are opposite conclusions from the same
              absent data.
            */}
            <Metric
              label="Visits with labour recorded"
              value={
                utilisation.labourCoveragePercent === null
                  ? null
                  : `${utilisation.labourCoveragePercent}%`
              }
              verdict={
                utilisation.labourCoveragePercent !== null && utilisation.labourCoveragePercent < 80
                  ? "missed"
                  : undefined
              }
              note={
                utilisation.labourCoveragePercent === null
                  ? "No visit on a completed job fell inside the window."
                  : `${utilisation.visitsWithLabour} of ${utilisation.visitsOnCompletedJobs} visits on completed jobs. The figure above rests on these; below about 80% it is measuring the paperwork rather than the work.`
              }
            />
            <Metric
              label="Travel"
              value={hours(utilisation.travelMinutes)}
              note="Recorded travelling. Real time, and not productive time — reported here rather than folded into utilisation."
            />

            {utilisation.byTechnician.length > 0 ? (
              <>
                <div className="my-3 border-t" />
                <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                  Showing {utilisation.byTechnician.length} of {utilisation.technicians}
                </p>
                <ul className="mt-2 space-y-1">
                  {utilisation.byTechnician.map((t) => (
                    <li key={t.technicianId} className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {t.name}
                      </span>
                      <span
                        className="tnum text-[13px]"
                        style={{ color: t.utilisationPercent === null ? "var(--text-muted)" : undefined }}
                      >
                        {t.utilisationPercent === null
                          ? "not measured"
                          : `${t.utilisationPercent}% · ${hours(t.workedMinutes)}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <div className="my-3 border-t" />
            {/*
              This is NOT first-time fix, and the copy says so where somebody
              might otherwise assume it. G11 needs to know which attendance
              closed the job and nothing here records that; what is recorded is
              the outcome somebody chose when the work ended.
            */}
            <Metric
              label="Left a return visit owed"
              value={
                outcomes.returnVisitRatePercent === null ? null : `${outcomes.returnVisitRatePercent}%`
              }
              note={
                outcomes.returnVisitRatePercent === null
                  ? `None of the ${outcomes.jobsCompleted} jobs completed in ${outcomes.windowDays} days carries a recorded outcome, so there is nothing to take a proportion of.`
                  : `${outcomes.returnVisitRequired} of ${outcomes.outcomesRecorded} completed jobs with a recorded outcome, over ${outcomes.windowDays} days. This is not the first-time-fix rate — see "Not measured" below for why that one cannot be computed.`
              }
            />
            <Metric
              label="Jobs with an outcome recorded"
              value={
                outcomes.outcomeCoveragePercent === null ? null : `${outcomes.outcomeCoveragePercent}%`
              }
              verdict={
                outcomes.outcomeCoveragePercent !== null && outcomes.outcomeCoveragePercent < 80
                  ? "missed"
                  : undefined
              }
              note={`${outcomes.outcomesRecorded} of ${outcomes.jobsCompleted} jobs completed in the window.`}
            />
          </Card>

          {/* ── 9c. Customers at risk (MD-5) ─────────────────────────────── */}
          <Card
            title="Customers at risk"
            href="/customers"
            tone={retention.atRisk > 0 || retention.lapsed > 0 ? "warning" : "neutral"}
            subtitle={`Quiet for ${retention.quietAfterDays} days is a risk; ${retention.lapsedAfterDays} is churn`}
          >
            {retention.everActive === 0 ? (
              <EmptyState kind="start" title="No customer has traded yet.">
                <p>
                  Risk is read from silence &mdash; the gap since a customer&rsquo;s last job or
                  invoice &mdash; so it begins being measured once there is a first one to be
                  silent after. The {retention.neverActive} customer
                  {retention.neverActive === 1 ? "" : "s"} on file
                  {retention.neverActive === 1 ? " is" : " are"} held out of the rate rather than
                  counted as lost.
                </p>
              </EmptyState>
            ) : (
              <>
                <Metric
                  label="At risk"
                  value={`${retention.atRisk}`}
                  emphasis
                  verdict={retention.atRisk > 0 ? "missed" : "met"}
                  note={`No live contract, and nothing raised or invoiced for over ${retention.quietAfterDays} days — or an agreement that ran out and was never replaced.`}
                />
                <Metric
                  label="Already gone"
                  value={`${retention.lapsed}`}
                  note={`Silent for over ${retention.lapsedAfterDays} days with no live contract.`}
                />
                <Metric
                  label="Churn rate"
                  value={retention.churnRatePercent === null ? null : `${retention.churnRatePercent}%`}
                  note={
                    retention.churnRatePercent === null
                      ? "No customer has ever raised a job or been invoiced, so there is no denominator."
                      : `${retention.lapsed} of ${retention.everActive} customers who have ever traded. The ${retention.neverActive} that never have are excluded from both sides — counting them would report a freshly imported customer list as catastrophic churn.`
                  }
                />

                {retention.customers.length > 0 ? (
                  <>
                    <div className="my-3 border-t" />
                    {/*
                      The count above is a SQL aggregate over every customer and
                      is NOT the length of this list, which is why the line below
                      states both.
                    */}
                    <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                      Showing {retention.customers.length} of {retention.atRisk + retention.lapsed},
                      most revenue first
                    </p>
                    <ul className="mt-2 space-y-2">
                      {retention.customers.map((c) => (
                        <li key={c.id}>
                          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                            <span className="text-[13px]">{c.name}</span>
                            <span className="tnum text-[13px]">
                              {money(c.revenueMinor, retention.currency)}
                            </span>
                          </div>
                          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
                            {c.reason === "contract_lapsed"
                              ? "Agreement ended and nothing signed since"
                              : "Gone quiet"}
                            {c.daysQuiet === null ? "" : ` · ${c.daysQuiet} days since anything`}
                            {c.state === "lapsed" ? " · already gone" : ""}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <div className="mt-3">
                    <EmptyState kind="good" title="Nobody has gone quiet.">
                      <p>
                        Every customer who has ever traded has either been active inside{" "}
                        {retention.quietAfterDays} days or holds a live agreement.
                      </p>
                    </EmptyState>
                  </div>
                )}
              </>
            )}
          </Card>

          {/* ── 10. Not measured ─────────────────────────────────────────── */}
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

        {/*
          The two screens this dashboard summarises rather than replaces. Both
          are read at a different moment — the tax page when a return is being
          prepared, the export when the accountant asks — so neither belongs in
          the weekly card stack, and both belong within one click of it.
        */}
        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
          <Link href="/reports/tax" style={{ color: "var(--accent-text)" }}>
            Corporate tax &mdash; every period against the AED 3m line &rarr;
          </Link>
          <Link href="/reports/export" style={{ color: "var(--accent-text)" }}>
            Accounting export &mdash; invoices, credit notes, payments, AR &rarr;
          </Link>
        </div>
      </div>
    </AppShell>
  );
}
