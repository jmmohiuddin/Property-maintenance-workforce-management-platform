import { sql } from "drizzle-orm";
import type { TenantScopedTx } from "../index";
import {
  DASHBOARD_GOALS,
  DASHBOARD_HORIZON_DAYS,
  DASHBOARD_WEEK_DAYS,
  EMIRATISATION_SKILLED_THRESHOLD,
  gradeGoal,
  smallBusinessReliefPosition,
  type GoalVerdict,
  type ReliefPosition,
} from "@meridian/core";
import { arAgeing, uninvoicedSignedOffJobs, invoiceSequenceGaps } from "./commerce";
import {
  workforceSummary,
  blockedTechnicians,
  findExpiringEmployeeDocuments,
  findExpiringAccreditations,
} from "./compliance";
import { listDispatchBoard } from "./jobs";
import { findExpiringCertifications } from "./cron";

/**
 * Reporting: the product event stream (`KPI-2`), the owner dashboard (`KPI-3`,
 * which the weekly digest `KPI-5` renders as text), and the audit log reader
 * (`ADM-7`).
 *
 * ── THE RULE THIS FILE IS WRITTEN UNDER ─────────────────────────────────────
 *
 * A dashboard that computes a number nobody can trace is worse than no
 * dashboard, because it is trusted. So nothing here invents a figure:
 *
 *  * Every metric is either read from a table that exists, or it is a named
 *    `DashboardGap` with the stream it is waiting on. There is no third
 *    category — no "0" standing in for "not measured", no green tick earned by
 *    checking three of fifty fields.
 *  * Nothing is re-derived. Compliance numbers come from `compliance.ts`, cash
 *    from `commerce.ts`, open work from `jobs.ts`. A parallel query here that
 *    disagreed with the compliance board by one would destroy both screens'
 *    credibility, and the board is the one people act on.
 *  * Counts are taken from the list they head. Where this file renders "n" over
 *    a set, the "n" is `set.length` and not a separate `count(*)` that a join
 *    can inflate — `blockedTechnicians` returning one row per expired
 *    *document* is how a header once read "Blocked — 5" over a list of four
 *    people, and the fix has to be structural rather than remembered.
 *  * Money is integer minor units all the way through. `numeric` is cast to
 *    minor units inside SQL (`(x * 100)::bigint`) rather than parsed as a float
 *    in JavaScript, because a revenue figure computed with a float is a revenue
 *    figure that disagrees with the invoices.
 */

// ═══════════════════════════════════════════════════════════════════════════
// KPI-2 — the product event stream
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How an event family gets into `product_events`.
 *
 *  * `trigger` — a database trigger from `0017_kpi_and_admin` emits it. It
 *    cannot be forgotten, it survives a hand-repair during an incident, and it
 *    is already recording.
 *  * `none` — declared, specified, and **not instrumented**. The reason is
 *    stated on the entry.
 *
 * There is deliberately no third value for "emitted by an application call".
 * There would be nothing in it: every family with a row transition behind it is
 * a trigger, and every family without one is currently uninstrumented. An enum
 * value with no members is how `portal_action` would end up marked as
 * instrumented because somebody *intended* to add the call — which is precisely
 * the lie this registry exists to prevent. Add the value back in the same
 * commit as the first `recordProductEvent` call site, not before.
 */
export type EventEmitter = "trigger" | "none";

export interface ProductEventName {
  readonly name: string;
  readonly emitter: EventEmitter;
  readonly description: string;
  /** For `none`: what has to exist before this can be emitted. */
  readonly blockedOn?: string;
}

/**
 * The registry.
 *
 * `KPI-2` names eleven event families. Five of them are emitted — lead stage
 * changes, job status changes, quote sent/decided, invoice issued, payment
 * recorded — and six are not. `contract_status_changed` is a sixth emitted
 * family that `KPI-2` does not ask for; it costs one trigger and it is what
 * G10's renewal rate will eventually be computed from.
 *
 * ── WHY THE UNINSTRUMENTED ONES ARE LISTED AT ALL ───────────────────────────
 *
 * Because `portal_action  0` and "portal actions are not instrumented" render
 * identically in a report, and they mean opposite things. The first is a
 * business fact worth acting on; the second is a hole in the software. Without
 * this registry the weekly report cannot tell them apart, and the reader will
 * assume the reassuring one — which is exactly how a compliance checklist came
 * to say "ready for transmission" on the strength of seven fields out of fifty.
 *
 * `productEventReport` prints the `none` entries as a named gap list rather
 * than as rows of zeros. Nothing in this file reports a metric derived from an
 * event family whose emitter is `none`.
 */
export const PRODUCT_EVENT_NAMES: readonly ProductEventName[] = [
  {
    name: "lead_created",
    emitter: "trigger",
    description: "An enquiry became a lead row, with its channel and campaign (G1).",
  },
  {
    name: "lead_stage_changed",
    emitter: "trigger",
    description: "Lead moved between stages, carrying minutes since creation (G2).",
  },
  { name: "job_created", emitter: "trigger", description: "A job was raised." },
  {
    name: "job_status_changed",
    emitter: "trigger",
    description: "Job transitioned, carrying priority and elapsed minutes (G3).",
  },
  { name: "quote_sent", emitter: "trigger", description: "A quotation left the building (G5)." },
  {
    name: "quote_decided",
    emitter: "trigger",
    description: "Approved, rejected or expired, with hours from sent (G5, G6).",
  },
  {
    name: "invoice_issued",
    emitter: "trigger",
    description: "An invoice left draft, with its taxable amount and days since supply (G7).",
  },
  { name: "payment_recorded", emitter: "trigger", description: "Cash arrived against an invoice." },
  {
    name: "contract_status_changed",
    emitter: "trigger",
    description: "Contract signed, renewed, expired or cancelled (G10).",
  },
  {
    name: "quote_form_step",
    emitter: "none",
    description: "A step of the public quote form was completed or abandoned (G1).",
    blockedOn:
      "Nothing to hang a trigger on: the public quote form writes no row until it is submitted, so " +
      "an abandoned form leaves no trace at all. It needs a `recordProductEvent` call in the public " +
      "form handler, which belongs to the leads stream. Until then the funnel has a numerator and " +
      "no denominator — G1 measures enquiries captured over enquiries received, and the second " +
      "number is the one missing.",
  },
  {
    name: "assignment_warning_override",
    emitter: "none",
    description: "A dispatcher assigned past a certification or availability warning (JOB-10).",
    blockedOn:
      "DB-7 — `job_assignments.override_reason` and `override_warning_type` do not exist yet. " +
      "Until they do the override is not recorded anywhere, so there is nothing to emit.",
  },
  {
    name: "portal_action",
    emitter: "none",
    description: "A customer did something in the portal instead of phoning (G9).",
    blockedOn: "The portal stream. Portal actions are not yet distinguishable from staff writes.",
  },
  {
    name: "auth_event",
    emitter: "none",
    description: "Sign-in, lockout, MFA enrolment and reset.",
    blockedOn:
      "`packages/auth`. Authentication writes to `sessions` and `audit_log`, neither of which " +
      "carries a tenant at the moment of a failed login, so a trigger cannot attribute one.",
  },
  {
    name: "ats_stage_changed",
    emitter: "none",
    description: "An applicant moved through the hiring pipeline (G13, G14).",
    blockedOn: "The recruitment stream — the ATS tables do not exist in this branch.",
  },
  {
    name: "field_sync_health",
    emitter: "none",
    description: "Field-app queue depth, oldest unsynced item, dead letters (FLD-17).",
    blockedOn: "M11, Phase 3. There is no field app.",
  },
];

const EVENT_NAMES = new Set(PRODUCT_EVENT_NAMES.map((e) => e.name));

/**
 * Record an event that no row transition can be triggered from.
 *
 * Deliberately narrow. Almost everything worth counting is a status change on a
 * business record, and those are emitted by the triggers in
 * `0017_kpi_and_admin` where they cannot be forgotten. This exists for the
 * remainder — a funnel step, an abandoned form — and every use of it is a place
 * where somebody has to remember, which is a cost, not a feature.
 *
 * Rejects an unregistered name rather than writing it. The whole value of a
 * machine key is that the report can group on it, and one typo produces a
 * second event family that looks like a third of the traffic went missing.
 */
export async function recordProductEvent(
  tx: TenantScopedTx,
  input: {
    tenantId: string;
    eventName: string;
    entityType?: string | null;
    entityId?: string | null;
    properties?: Record<string, unknown>;
  },
): Promise<void> {
  if (!EVENT_NAMES.has(input.eventName)) {
    throw new Error(
      `"${input.eventName}" is not in PRODUCT_EVENT_NAMES. Add it to the registry in ` +
        `domain/reporting.ts first — an unregistered event name is invisible to the weekly report.`,
    );
  }

  await tx.execute(sql`
    select app_product_event(
      ${input.tenantId}::uuid,
      ${input.eventName},
      ${input.entityType ?? null},
      ${input.entityId ?? null}::uuid,
      ${JSON.stringify(input.properties ?? {})}::jsonb
    )
  `);
}

export interface EventCount {
  readonly eventName: string;
  readonly count: number;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}

export interface ProductEventReport {
  readonly days: number;
  readonly rows: readonly EventCount[];
  readonly total: number;
  /** Registered families with an emitter that produced nothing in the window. */
  readonly silent: readonly string[];
  /** Registered families with no emitter at all, and what each waits on. */
  readonly uninstrumented: readonly ProductEventName[];
}

/**
 * The weekly SQL report `KPI-2` asks for.
 *
 * `silent` and `uninstrumented` are separate lists on purpose, and neither is
 * folded into `rows` as a zero. A family that is instrumented and produced
 * nothing is a quiet week; a family with no emitter is a hole. Printing both as
 * `0` is the failure this whole file is written against.
 */
export async function productEventReport(
  tx: TenantScopedTx,
  options?: { days?: number },
): Promise<ProductEventReport> {
  const days = options?.days ?? DASHBOARD_WEEK_DAYS;

  const rows = (await tx.execute<{
    event_name: string;
    count: string;
    first_seen: Date | string;
    last_seen: Date | string;
  }>(sql`
    select event_name,
           count(*) as count,
           min(occurred_at) as first_seen,
           max(occurred_at) as last_seen
      from product_events
     where occurred_at >= now() - make_interval(days => ${days})
     group by event_name
     order by 2 desc, 1
  `)) as unknown as {
    event_name: string;
    count: string;
    first_seen: Date | string;
    last_seen: Date | string;
  }[];

  const counted = rows.map((r) => ({
    eventName: r.event_name,
    count: Number(r.count),
    firstSeen: new Date(r.first_seen),
    lastSeen: new Date(r.last_seen),
  }));

  const seen = new Set(counted.map((r) => r.eventName));

  return {
    days,
    rows: counted,
    total: counted.reduce((sum, r) => sum + r.count, 0),
    silent: PRODUCT_EVENT_NAMES.filter((e) => e.emitter !== "none" && !seen.has(e.name)).map(
      (e) => e.name,
    ),
    uninstrumented: PRODUCT_EVENT_NAMES.filter((e) => e.emitter === "none"),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// KPI-3 — the owner dashboard
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A metric the dashboard is specified to show and cannot yet source.
 *
 * Rendered on the screen and printed in the email, rather than omitted. An
 * absent row reads as "nothing to report"; a named gap reads as "this is not
 * being measured", which is the true statement and the one that gets the
 * missing stream built.
 */
export interface DashboardGap {
  /** The requirement that asked for it. */
  readonly requirement: string;
  readonly metric: string;
  /** What has to exist first, in plain words. */
  readonly waitingOn: string;
}

export interface CashPosition {
  readonly outstandingMinor: number;
  readonly overdueMinor: number;
  readonly currentMinor: number;
  readonly days1to30Minor: number;
  readonly days31to60Minor: number;
  readonly days61PlusMinor: number;
  /** Null when there is no revenue in the trailing window to divide by. */
  readonly dsoDays: number | null;
  readonly dsoVerdict: GoalVerdict;
  readonly currency: string;
}

export interface RevenuePosition {
  readonly thisMonthMinor: number;
  readonly lastMonthMinor: number;
  /** Calendar year to date. The period the Small Business Relief test uses. */
  readonly yearToDateMinor: number;
  readonly trailing90Minor: number;
  readonly relief: ReliefPosition;
  readonly currency: string;
  /** Invoices counted, so a suspiciously round number can be checked. */
  readonly invoicesThisMonth: number;
}

export interface PipelineStage {
  readonly stage: string;
  readonly leads: number;
  readonly valueMinor: number;
}

export interface PipelinePosition {
  readonly byStage: readonly PipelineStage[];
  readonly openLeads: number;
  readonly openValueMinor: number;
  readonly newThisWeek: number;
  readonly quotesSent: number;
  readonly quotesApproved: number;
  /** Percent. Null when nothing was sent in the window — not zero. */
  readonly conversionPercent: number | null;
  readonly conversionVerdict: GoalVerdict;
  readonly quotedValueMinor: number;
  readonly windowDays: number;
}

export interface WorkPosition {
  readonly openJobs: number;
  readonly byPriority: readonly { priority: string; jobs: number; breached: number }[];
  readonly unassigned: number;
  /** Jobs currently past a deadline. Distinct jobs, not deadline rows. */
  readonly breachingNow: number;
  /** Distinct jobs that missed a deadline falling inside the last week. */
  readonly jobsBreachedThisWeek: number;
  /** Deadlines missed this week. Higher than the job count when one job missed both. */
  readonly deadlinesMissedThisWeek: number;
  readonly jobsWithDeadlineThisWeek: number;
  readonly breachRatePercent: number | null;
  readonly breachVerdict: GoalVerdict;
}

export interface ContractPosition {
  readonly active: number;
  readonly annualValueMinor: number;
  readonly expiringWithinHorizon: readonly {
    id: string;
    reference: string;
    name: string;
    customerName: string;
    endsOn: Date;
    daysRemaining: number;
    annualValueMinor: number;
    autoRenew: boolean;
  }[];
  readonly currency: string;
}

export interface CompliancePosition {
  readonly headcount: number;
  readonly deployable: number;
  readonly blocked: number;
  readonly blockedNames: readonly string[];
  readonly documentsExpiring: number;
  readonly documentsExpired: number;
  readonly accreditationsExpiring: number;
  readonly accreditationsExpired: number;
  readonly certificationsExpiring: number;
  /** The single most urgent expiry across all three registers, or null. */
  readonly nextExpiry: { label: string; daysRemaining: number } | null;
  readonly horizonDays: number;
}

export interface BillingRisk {
  /** INV-5 supplies past the 14-day tax invoice deadline. */
  readonly issuanceBreached: number;
  readonly issuanceApproaching: number;
  /** INV-4 gaps in the issued invoice series this year. An FTA audit flag. */
  readonly sequenceGaps: number;
  /** Median days from date of supply to invoice issue, this year. G7. */
  readonly invoiceLagDays: number | null;
  readonly invoiceLagVerdict: GoalVerdict;
}

/**
 * One item on the "needs you" panel.
 *
 * Ordered by consequence, not by recency — the same rule the workforce board
 * follows. `severity` decides the order and nothing else does: a lapsed work
 * permit is AED 100,000 and a contract expiring in eleven weeks is a phone
 * call, and a list sorted by date puts them the wrong way round.
 */
export interface Attention {
  readonly severity: "critical" | "warning";
  readonly headline: string;
  readonly detail: string;
  /** Where the reader goes to fix it. */
  readonly href: string;
}

export interface OwnerDashboard {
  readonly generatedAt: Date;
  readonly cash: CashPosition;
  readonly revenue: RevenuePosition;
  readonly pipeline: PipelinePosition;
  readonly work: WorkPosition;
  readonly contracts: ContractPosition;
  readonly compliance: CompliancePosition;
  readonly billing: BillingRisk;
  readonly attention: readonly Attention[];
  readonly gaps: readonly DashboardGap[];
}

/**
 * Everything `KPI-3` asks for, in one read, for one tenant.
 *
 * Composed from the existing domain functions wherever one exists. The only new
 * SQL here is for questions nothing else asks — revenue by period, pipeline by
 * stage, deadlines missed inside a window — and each of those is a single
 * aggregate over one table.
 *
 * `now` is a parameter rather than a call to `new Date()` inside, so the
 * month-boundary arithmetic is testable without waiting for a month boundary.
 */
export async function ownerDashboard(
  tx: TenantScopedTx,
  options?: { now?: Date; horizonDays?: number },
): Promise<OwnerDashboard> {
  const now = options?.now ?? new Date();
  const horizonDays = options?.horizonDays ?? DASHBOARD_HORIZON_DAYS;

  const [ageing, revenue, pipeline, work, contracts, compliance, billing] = await Promise.all([
    arAgeing(tx, now),
    revenuePosition(tx, now),
    pipelinePosition(tx, now),
    workPosition(tx, now),
    contractPosition(tx, now, horizonDays),
    compliancePosition(tx, horizonDays),
    billingRisk(tx, now),
  ]);

  const overdueMinor =
    ageing.days1to30Minor + ageing.days31to60Minor + ageing.days61PlusMinor;

  /*
   * DSO — days sales outstanding.
   *
   * Outstanding receivables divided by average daily revenue over the trailing
   * 90 days. Ninety rather than 365 because a maintenance business's mix
   * changes within a year and a twelve-month denominator lags a collections
   * problem by two quarters.
   *
   * Null, not zero, when there is no revenue in the window. Zero would render
   * as a perfect DSO on a business that has invoiced nothing, which is the most
   * misleading number this dashboard could produce.
   */
  const dsoDays =
    revenue.trailing90Minor > 0
      ? Math.round((ageing.totalOutstandingMinor / revenue.trailing90Minor) * 90)
      : null;

  const cash: CashPosition = {
    outstandingMinor: ageing.totalOutstandingMinor,
    overdueMinor,
    currentMinor: ageing.currentMinor,
    days1to30Minor: ageing.days1to30Minor,
    days31to60Minor: ageing.days31to60Minor,
    days61PlusMinor: ageing.days61PlusMinor,
    dsoDays,
    dsoVerdict: gradeGoal(dsoDays, DASHBOARD_GOALS["dsoDays"]!),
    currency: revenue.currency,
  };

  return {
    generatedAt: now,
    cash,
    revenue,
    pipeline,
    work,
    contracts,
    compliance,
    billing,
    attention: attentionItems({ cash, revenue, work, contracts, compliance, billing }),
    gaps: DASHBOARD_GAPS,
  };
}

/**
 * The metrics on the wireframe that this branch cannot source.
 *
 * Static, because every one of them is blocked on a table rather than on data —
 * they will not start working because a week went by. Each names the stream
 * that unblocks it, so integration is a wiring job rather than an
 * investigation.
 */
export const DASHBOARD_GAPS: readonly DashboardGap[] = [
  {
    requirement: "KPI-3",
    metric: "Open roles and days-to-hire",
    waitingOn:
      "The recruitment stream (ATS-1…ATS-19). No requisition or application table exists in this branch, " +
      "so both the numerator and the denominator are missing.",
  },
  {
    requirement: "KPI-3 / HR-18",
    metric: "Skilled headcount against the Emiratisation threshold",
    waitingOn:
      `The HR stream. "Skilled" needs three facts per employee — ISCO occupational level 1–5, a ` +
      `post-secondary certificate, and salary at or above AED 4,000/month — and \`employees\` carries ` +
      `none of them. Total headcount is reported instead, and it is NOT the same number: a contractor ` +
      `with 60 tradesmen and 6 office staff is measured against the 6, not the 66, so reporting ` +
      `headcount against ${EMIRATISATION_SKILLED_THRESHOLD} would say the threshold was near when it is far.`,
  },
  {
    requirement: "KPI-3 / HR-17",
    metric: "WPS payroll countdown",
    waitingOn: "The HR stream — there is no payroll calendar table.",
  },
  {
    requirement: "KPI-3 / G11",
    metric: "First-time fix rate",
    waitingOn:
      "The field app (M11, Phase 3). It is computed from visit outcome codes, and no visit records one yet.",
  },
  {
    requirement: "KPI-3 / G12",
    metric: "PPM completion rate",
    waitingOn:
      "The contracts stream (CON-7). `contract_visits` exists but nothing generates or completes rows in it, " +
      "so the ratio would be 0/0 rendered as 0%.",
  },
  {
    requirement: "KPI-3 / G10",
    metric: "Contract renewal rate",
    waitingOn:
      "The contracts stream (CON-8). `contract_status_changed` events started recording with migration 0017, " +
      "so this becomes computable one renewal cycle after that data starts arriving — not retrospectively.",
  },
];

// ── The pieces ───────────────────────────────────────────────────────────────

/**
 * Revenue by period, net of credit notes.
 *
 * ── WHY `taxable_amount` AND NOT `total` ────────────────────────────────────
 *
 * `taxable_amount` is the tax-exclusive figure after discount. VAT is collected
 * on the government's behalf and is not turnover, so a Small Business Relief
 * position read off VAT-inclusive totals crosses the AED 3,000,000 line 5%
 * early — and since one breach permanently disqualifies every later period, an
 * early false alarm is not a harmless conservatism. It would push a business
 * into deferring real work.
 *
 * Credit notes are subtracted, not ignored. A cancelled supply that was
 * invoiced and then credited is not revenue, and leaving it in would inflate
 * the threshold reading in the direction that matters.
 *
 * Period boundaries are computed in `Asia/Dubai`, in SQL. Doing the month
 * arithmetic in JavaScript against a database that does not run in Dubai puts
 * an invoice issued at 02:00 on the 1st into the previous month.
 */
async function revenuePosition(tx: TenantScopedTx, now: Date): Promise<RevenuePosition> {
  const rows = (await tx.execute<{
    this_month: string;
    last_month: string;
    year_to_date: string;
    trailing_90: string;
    invoices_this_month: string;
    currency: string | null;
  }>(sql`
    with anchor as (
      select (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai') as local_now
    ),
    bounds as (
      select date_trunc('month', local_now)                     as month_start,
             date_trunc('month', local_now) - interval '1 month' as prev_month_start,
             date_trunc('year', local_now)                      as year_start,
             local_now - interval '90 days'                     as trailing_start,
             local_now                                          as local_now
        from anchor
    ),
    -- Issued invoices, keyed on the local-time issue date. issued_on is null
    -- on a draft, and the status filter already excludes drafts, so a null here
    -- is an issued invoice with no issue date — which is a data fault worth
    -- leaving out of a revenue figure rather than silently dating to today.
    inv as (
      select (i.issued_on at time zone 'Asia/Dubai') as issued_local,
             (i.taxable_amount * 100)::bigint        as taxable_minor,
             i.currency
        from invoices i, bounds b
       where i.deleted_at is null
         and i.status <> 'draft'
         and i.issued_on is not null
         and (i.issued_on at time zone 'Asia/Dubai') >= b.year_start - interval '1 year'
    ),
    crn as (
      select (c.issued_on at time zone 'Asia/Dubai') as issued_local,
             (c.taxable_amount * 100)::bigint        as taxable_minor
        from credit_notes c, bounds b
       where c.deleted_at is null
         and c.issued_on is not null
         and (c.issued_on at time zone 'Asia/Dubai') >= b.year_start - interval '1 year'
    )
    select
      coalesce((select sum(taxable_minor) from inv, bounds b
                 where issued_local >= b.month_start and issued_local < b.local_now + interval '1 day'), 0)
      - coalesce((select sum(taxable_minor) from crn, bounds b
                 where issued_local >= b.month_start and issued_local < b.local_now + interval '1 day'), 0)
        as this_month,
      coalesce((select sum(taxable_minor) from inv, bounds b
                 where issued_local >= b.prev_month_start and issued_local < b.month_start), 0)
      - coalesce((select sum(taxable_minor) from crn, bounds b
                 where issued_local >= b.prev_month_start and issued_local < b.month_start), 0)
        as last_month,
      coalesce((select sum(taxable_minor) from inv, bounds b
                 where issued_local >= b.year_start), 0)
      - coalesce((select sum(taxable_minor) from crn, bounds b
                 where issued_local >= b.year_start), 0)
        as year_to_date,
      coalesce((select sum(taxable_minor) from inv, bounds b
                 where issued_local >= b.trailing_start), 0)
      - coalesce((select sum(taxable_minor) from crn, bounds b
                 where issued_local >= b.trailing_start), 0)
        as trailing_90,
      (select count(*) from inv, bounds b
        where issued_local >= b.month_start and issued_local < b.local_now + interval '1 day')
        as invoices_this_month,
      (select currency from inv limit 1) as currency
  `)) as unknown as {
    this_month: string;
    last_month: string;
    year_to_date: string;
    trailing_90: string;
    invoices_this_month: string;
    currency: string | null;
  }[];

  const r = rows[0];
  const yearToDateMinor = Number(r?.year_to_date ?? 0);

  return {
    thisMonthMinor: Number(r?.this_month ?? 0),
    lastMonthMinor: Number(r?.last_month ?? 0),
    yearToDateMinor,
    trailing90Minor: Number(r?.trailing_90 ?? 0),
    relief: smallBusinessReliefPosition(yearToDateMinor),
    invoicesThisMonth: Number(r?.invoices_this_month ?? 0),
    currency: r?.currency ?? "AED",
  };
}

/**
 * Leads by stage, and the quote funnel over the trailing window.
 *
 * `estimated_value` is what a lead is worth before a quotation exists, and it
 * is nullable — an unestimated lead contributes to the count and not to the
 * value, which is the honest treatment. Coalescing it to zero would be the same
 * thing; coalescing it to an average would be inventing revenue.
 */
async function pipelinePosition(tx: TenantScopedTx, now: Date): Promise<PipelinePosition> {
  const windowDays = DASHBOARD_HORIZON_DAYS;

  const stageRows = (await tx.execute<{ stage: string; leads: string; value_minor: string }>(sql`
    select stage::text as stage,
           count(*) as leads,
           coalesce(sum((estimated_value * 100)::bigint), 0) as value_minor
      from leads
     where deleted_at is null
     group by 1
     order by 1
  `)) as unknown as { stage: string; leads: string; value_minor: string }[];

  const byStage = stageRows.map((r) => ({
    stage: r.stage,
    leads: Number(r.leads),
    valueMinor: Number(r.value_minor),
  }));

  // "Open" is every stage that is neither decided nor parked. Derived from the
  // same rows the caller renders, so the headline and the breakdown cannot
  // disagree — the alternative is a second `count(*)` with its own WHERE clause
  // and its own opportunity to drift.
  const DECIDED = new Set(["won", "lost", "dormant"]);
  const open = byStage.filter((s) => !DECIDED.has(s.stage));

  const newRows = (await tx.execute<{ count: string }>(sql`
    select count(*) as count
      from leads
     where deleted_at is null
       and created_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${DASHBOARD_WEEK_DAYS})
  `)) as unknown as { count: string }[];

  /*
   * The quote funnel.
   *
   * Denominator is quotes SENT in the window, numerator is those approved —
   * both keyed on `sent_at`, so a quote sent inside the window and decided
   * after it counts as sent-and-not-yet-approved rather than vanishing from
   * both sides. Keying the numerator on `decided_at` instead would let
   * conversion exceed 100% in a week where old quotes landed.
   */
  const funnelRows = (await tx.execute<{
    sent: string;
    approved: string;
    quoted_minor: string;
  }>(sql`
    select count(*) filter (where sent_at is not null) as sent,
           count(*) filter (where sent_at is not null and status = 'approved') as approved,
           coalesce(sum((total * 100)::bigint) filter (
             where sent_at is not null and status in ('sent', 'viewed')
           ), 0) as quoted_minor
      from quotes
     where deleted_at is null
       and sent_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${windowDays})
  `)) as unknown as { sent: string; approved: string; quoted_minor: string }[];

  const sent = Number(funnelRows[0]?.sent ?? 0);
  const approved = Number(funnelRows[0]?.approved ?? 0);
  const conversionPercent = sent > 0 ? Math.round((approved / sent) * 100) : null;

  return {
    byStage,
    openLeads: open.reduce((n, s) => n + s.leads, 0),
    openValueMinor: open.reduce((n, s) => n + s.valueMinor, 0),
    newThisWeek: Number(newRows[0]?.count ?? 0),
    quotesSent: sent,
    quotesApproved: approved,
    conversionPercent,
    conversionVerdict: gradeGoal(conversionPercent, DASHBOARD_GOALS["quoteConversion"]!),
    quotedValueMinor: Number(funnelRows[0]?.quoted_minor ?? 0),
    windowDays,
  };
}

/**
 * Open work by priority, and the SLA picture.
 *
 * ── THE DOUBLE-COUNT THIS FUNCTION IS BUILT AROUND ──────────────────────────
 *
 * A job has two deadlines. It can miss both. `findSlaBreaches` in `cron.ts`
 * returns one row per missed *deadline* — correctly, because the operations
 * manager has to action each one separately — but a dashboard headline that
 * says "3 SLA breaches" over two jobs is wrong in the direction that makes the
 * business look worse than it is, and the rate computed from it can exceed
 * 100%.
 *
 * So three numbers are returned and each says which it is:
 * `deadlinesMissedThisWeek` counts deadlines, `jobsBreachedThisWeek` counts
 * jobs, and `breachRatePercent` divides jobs by jobs. G4's target is "jobs past
 * a response deadline ÷ all jobs", so the rate uses the job count.
 */
async function workPosition(tx: TenantScopedTx, now: Date): Promise<WorkPosition> {
  // The dispatch board is the source of truth for what is open, so the
  // dashboard cannot disagree with the board about how many jobs there are.
  const board = await listDispatchBoard(tx, { now, limit: 1000 });

  const priorities = ["p1_emergency", "p2_urgent", "p3_standard", "p4_planned"];
  const byPriority = priorities
    .map((priority) => {
      const rows = board.filter((r) => r.priority === priority);
      return {
        priority,
        jobs: rows.length,
        breached: rows.filter((r) => r.sla === "breached").length,
      };
    })
    .filter((p) => p.jobs > 0);

  const weekRows = (await tx.execute<{
    jobs_breached: string;
    deadlines_missed: string;
    jobs_with_deadline: string;
  }>(sql`
    with anchor as (select ${now.toISOString()}::timestamptz as now_at),
    -- Every deadline that FELL inside the window, whether or not it was met and
    -- whether or not the job is still open. "Breaches this week" is a question
    -- about the week, so a job closed on Friday still counts against Tuesday.
    due as (
      select j.id,
             'response' as kind,
             j.respond_by_at as due_at,
             (j.first_response_at is null or j.first_response_at > j.respond_by_at) as missed
        from jobs j, anchor a
       where j.deleted_at is null
         and j.respond_by_at is not null
         and j.respond_by_at >= a.now_at - make_interval(days => ${DASHBOARD_WEEK_DAYS})
         and j.respond_by_at <= a.now_at
         and j.status <> 'cancelled'

      union all

      select j.id,
             'resolution' as kind,
             j.resolve_by_at as due_at,
             (j.completed_at is null or j.completed_at > j.resolve_by_at) as missed
        from jobs j, anchor a
       where j.deleted_at is null
         and j.resolve_by_at is not null
         and j.resolve_by_at >= a.now_at - make_interval(days => ${DASHBOARD_WEEK_DAYS})
         and j.resolve_by_at <= a.now_at
         and j.status <> 'cancelled'
    )
    select count(distinct id) filter (where missed)::text as jobs_breached,
           count(*) filter (where missed)::text           as deadlines_missed,
           count(distinct id)::text                       as jobs_with_deadline
      from due
  `)) as unknown as {
    jobs_breached: string;
    deadlines_missed: string;
    jobs_with_deadline: string;
  }[];

  const jobsBreachedThisWeek = Number(weekRows[0]?.jobs_breached ?? 0);
  const jobsWithDeadlineThisWeek = Number(weekRows[0]?.jobs_with_deadline ?? 0);
  const breachRatePercent =
    jobsWithDeadlineThisWeek > 0
      ? Math.round((jobsBreachedThisWeek / jobsWithDeadlineThisWeek) * 100)
      : null;

  return {
    openJobs: board.length,
    byPriority,
    unassigned: board.filter((r) => r.technicianName === null).length,
    breachingNow: board.filter((r) => r.sla === "breached").length,
    jobsBreachedThisWeek,
    deadlinesMissedThisWeek: Number(weekRows[0]?.deadlines_missed ?? 0),
    jobsWithDeadlineThisWeek,
    breachRatePercent,
    breachVerdict: gradeGoal(breachRatePercent, DASHBOARD_GOALS["slaBreachRate"]!),
  };
}

/**
 * Active contracts and the ones running out inside the horizon.
 *
 * Reads the `contracts` table, which has existed since 0000 and is being given
 * a UI in parallel by the contracts stream. Only `status`, `ends_on`,
 * `annual_value` and `auto_renew` are touched — the four columns that have been
 * there from the start — so this survives whatever that work adds.
 *
 * `auto_renew` is carried onto the row because it changes what the owner does
 * about an expiry: a contract that renews itself needs a decision only if the
 * answer is "no", and one that does not needs a phone call.
 */
async function contractPosition(
  tx: TenantScopedTx,
  now: Date,
  horizonDays: number,
): Promise<ContractPosition> {
  const rows = (await tx.execute<{
    id: string;
    reference: string;
    name: string;
    customer_name: string;
    ends_on: Date | string;
    days_remaining: number;
    annual_value_minor: string;
    auto_renew: boolean;
  }>(sql`
    select c.id, c.reference, c.name,
           cu.name as customer_name,
           c.ends_on,
           (c.ends_on::date - (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date)::int
             as days_remaining,
           (c.annual_value * 100)::bigint as annual_value_minor,
           c.auto_renew
      from contracts c
      join customers cu on cu.id = c.customer_id
     where c.deleted_at is null
       and c.status = 'active'
       and c.ends_on::date <= (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date
                              + (${horizonDays})::int
     order by c.ends_on
  `)) as unknown as {
    id: string;
    reference: string;
    name: string;
    customer_name: string;
    ends_on: Date | string;
    days_remaining: number;
    annual_value_minor: string;
    auto_renew: boolean;
  }[];

  const totals = (await tx.execute<{ active: string; annual_value_minor: string; currency: string | null }>(sql`
    select count(*)::text as active,
           coalesce(sum((annual_value * 100)::bigint), 0)::text as annual_value_minor,
           (select currency from contracts where deleted_at is null limit 1) as currency
      from contracts
     where deleted_at is null and status = 'active'
  `)) as unknown as { active: string; annual_value_minor: string; currency: string | null }[];

  return {
    active: Number(totals[0]?.active ?? 0),
    annualValueMinor: Number(totals[0]?.annual_value_minor ?? 0),
    currency: totals[0]?.currency ?? "AED",
    expiringWithinHorizon: rows.map((r) => ({
      id: r.id,
      reference: r.reference,
      name: r.name,
      customerName: r.customer_name,
      endsOn: new Date(r.ends_on),
      daysRemaining: r.days_remaining,
      annualValueMinor: Number(r.annual_value_minor),
      autoRenew: r.auto_renew,
    })),
  };
}

/**
 * Compliance, entirely from `compliance.ts` and `cron.ts`.
 *
 * Not one new query. The workforce board and the owner dashboard have to agree
 * to the person, and the only way to guarantee that is for both to call the
 * same functions — a second query here that filtered `is_active` slightly
 * differently would produce two numbers, both defensible, and destroy trust in
 * the pair.
 *
 * `blocked` comes from `workforceSummary`, which counts
 * `blockedTechnicians().length` — one row per person, because that query uses
 * `DISTINCT ON`. `blockedNames` is built from the same array, so the count and
 * the list cannot disagree.
 */
async function compliancePosition(
  tx: TenantScopedTx,
  horizonDays: number,
): Promise<CompliancePosition> {
  const [summary, blocks, documents, accreditations, certifications] = await Promise.all([
    workforceSummary(tx),
    blockedTechnicians(tx),
    findExpiringEmployeeDocuments(tx, horizonDays),
    findExpiringAccreditations(tx, horizonDays),
    findExpiringCertifications(tx, horizonDays),
  ]);

  const candidates: { label: string; daysRemaining: number }[] = [
    ...documents.map((d) => ({ label: `${d.employeeName} — ${d.label}`, daysRemaining: d.daysRemaining })),
    ...accreditations.map((a) => ({ label: a.name, daysRemaining: a.daysRemaining })),
    ...certifications.map((c) => ({
      label: `${c.technicianName} — ${c.certification}`,
      daysRemaining: c.daysRemaining,
    })),
  ].sort((a, b) => a.daysRemaining - b.daysRemaining);

  return {
    headcount: summary.headcount,
    deployable: summary.deployable,
    blocked: summary.blocked,
    blockedNames: blocks.map((b) => b.technicianName),
    documentsExpiring: documents.length,
    documentsExpired: documents.filter((d) => d.daysRemaining < 0).length,
    accreditationsExpiring: accreditations.length,
    accreditationsExpired: accreditations.filter((a) => a.daysRemaining < 0).length,
    certificationsExpiring: certifications.length,
    nextExpiry: candidates[0] ?? null,
    horizonDays,
  };
}

/**
 * The two billing faults an owner is personally exposed to.
 *
 * `INV-5` is AED 2,500 per un-issued invoice and `INV-4` is the gap an FTA
 * auditor asks about. Both already have queries; this reads them and adds the
 * lag measurement, which nothing else computes.
 *
 * The median rather than the mean for lag. One invoice raised eleven months
 * late — a dispute, a lost signature — moves a mean past the target on its own
 * and hides a process that is otherwise fine.
 */
async function billingRisk(tx: TenantScopedTx, now: Date): Promise<BillingRisk> {
  const [supplies, sequence] = await Promise.all([
    uninvoicedSignedOffJobs(tx),
    invoiceSequenceGaps(tx, { year: now.getFullYear() }),
  ]);

  const lagRows = (await tx.execute<{ median: string | null }>(sql`
    select percentile_cont(0.5) within group (
             order by ((issued_on at time zone 'Asia/Dubai')::date - supply_date)
           )::text as median
      from invoices
     where deleted_at is null
       and status <> 'draft'
       and issued_on is not null
       and supply_date is not null
       and (issued_on at time zone 'Asia/Dubai') >=
           date_trunc('year', ${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')
  `)) as unknown as { median: string | null }[];

  const median = lagRows[0]?.median;
  const invoiceLagDays = median === null || median === undefined ? null : Number(median);

  return {
    issuanceBreached: supplies.filter((s) => s.state === "breached").length,
    issuanceApproaching: supplies.filter((s) => s.state === "approaching").length,
    sequenceGaps: sequence.gaps.length,
    invoiceLagDays,
    invoiceLagVerdict: gradeGoal(invoiceLagDays, DASHBOARD_GOALS["invoiceLagDays"]!),
  };
}

/**
 * The "needs you" panel, ordered by consequence.
 *
 * Everything here is derived from figures already computed above — nothing runs
 * a query of its own, so an item cannot appear on the panel that contradicts
 * the section it came from.
 *
 * The order is the order of the penalties: people who cannot legally work, then
 * the company's own licence, then per-invoice fines, then the tax cliff that
 * cannot be uncrossed, then operational misses. That last one is deliberate —
 * an SLA breach is a commercial problem and a lapsed work permit is a criminal
 * one, and a panel sorted by recency puts them the wrong way round.
 */
function attentionItems(input: {
  cash: CashPosition;
  revenue: RevenuePosition;
  work: WorkPosition;
  contracts: ContractPosition;
  compliance: CompliancePosition;
  billing: BillingRisk;
}): readonly Attention[] {
  const items: Attention[] = [];
  const { cash, revenue, work, contracts, compliance, billing } = input;

  if (compliance.blocked > 0) {
    items.push({
      severity: "critical",
      headline: `${compliance.blocked} technician${compliance.blocked === 1 ? "" : "s"} blocked from dispatch`,
      detail:
        `${compliance.blockedNames.join(", ")} cannot be assigned to any job. Deploying a worker ` +
        `without a valid permit carries AED 100,000 to AED 1,000,000 under Article 60.`,
      href: "/workforce",
    });
  }

  if (compliance.accreditationsExpired > 0) {
    items.push({
      severity: "critical",
      headline: `${compliance.accreditationsExpired} company accreditation${compliance.accreditationsExpired === 1 ? " has" : "s have"} expired`,
      detail:
        "An expired trade licence stops the business rather than inconveniencing it, and the same " +
        "register is what a tender pack is built from.",
      href: "/workforce/accreditations",
    });
  }

  if (billing.issuanceBreached > 0) {
    items.push({
      severity: "critical",
      headline: `${billing.issuanceBreached} signed-off job${billing.issuanceBreached === 1 ? "" : "s"} past the 14-day invoice deadline`,
      detail: "AED 2,500 each, and the penalty has already been incurred. Issue them today.",
      href: "/invoices",
    });
  }

  if (billing.sequenceGaps > 0) {
    items.push({
      severity: "critical",
      headline: `${billing.sequenceGaps} gap${billing.sequenceGaps === 1 ? "" : "s"} in this year's invoice series`,
      detail:
        "A missing invoice number is an FTA audit flag. The innocent explanation is a rolled-back " +
        "transaction — but that is an answer somebody has to be able to give.",
      href: "/invoices",
    });
  }

  if (revenue.relief.state === "breached") {
    items.push({
      severity: "critical",
      headline: "Revenue has passed the AED 3,000,000 Small Business Relief line",
      detail:
        "The relief is lost for this period and permanently for every later one. Confirm the figure " +
        "with the accountant before acting on it — it is computed from issued invoices net of credit notes.",
      href: "/invoices",
    });
  } else if (revenue.relief.state === "approaching") {
    items.push({
      severity: "warning",
      headline: "Approaching the AED 3,000,000 Small Business Relief line",
      detail:
        "Crossing it once permanently ends the relief for all later periods. There is still time to " +
        "decide deliberately rather than discover it in the return.",
      href: "/invoices",
    });
  }

  if (compliance.documentsExpired > 0) {
    items.push({
      severity: "warning",
      headline: `${compliance.documentsExpired} employee document${compliance.documentsExpired === 1 ? " has" : "s have"} expired`,
      detail:
        "Not all of these block a dispatch, but every one of them is a renewal that is now late " +
        "rather than cheap.",
      href: "/workforce",
    });
  }

  if (work.jobsBreachedThisWeek > 0) {
    items.push({
      severity: "warning",
      headline: `${work.jobsBreachedThisWeek} job${work.jobsBreachedThisWeek === 1 ? "" : "s"} missed an SLA deadline this week`,
      detail:
        `${work.deadlinesMissedThisWeek} deadline${work.deadlinesMissedThisWeek === 1 ? "" : "s"} missed ` +
        `across ${work.jobsWithDeadlineThisWeek} job${work.jobsWithDeadlineThisWeek === 1 ? "" : "s"} with a ` +
        `deadline falling in the window.`,
      href: "/dispatch",
    });
  }

  if (contracts.expiringWithinHorizon.length > 0) {
    const notRenewing = contracts.expiringWithinHorizon.filter((c) => !c.autoRenew);
    items.push({
      severity: "warning",
      headline: `${contracts.expiringWithinHorizon.length} contract${contracts.expiringWithinHorizon.length === 1 ? "" : "s"} expiring within ${DASHBOARD_HORIZON_DAYS} days`,
      detail:
        notRenewing.length > 0
          ? `${notRenewing.length} of them ${notRenewing.length === 1 ? "does" : "do"} not ` +
            `auto-renew, so ${notRenewing.length === 1 ? "it ends" : "they end"} unless somebody acts.`
          : "All of them auto-renew, so this needs a decision only if the answer is no.",
      href: "/customers",
    });
  }

  if (cash.days61PlusMinor > 0) {
    items.push({
      severity: "warning",
      headline: "Receivables more than 60 days overdue",
      detail: "The oldest bucket is where collection rates fall off, not where they start to.",
      href: "/invoices",
    });
  }

  return items;
}

// ═══════════════════════════════════════════════════════════════════════════
// ADM-7 — the audit log viewer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The tables the audit trigger is attached to, in `sql/rls.sql`.
 *
 * Mirrored here so the filter dropdown offers what actually exists rather than
 * every table in the schema — offering `technician_locations` when nothing
 * writes an audit row for it produces an empty result the reader interprets as
 * "no changes were made", which is the opposite of the truth.
 *
 * Duplicated from SQL on purpose, exactly like the contrast gate duplicates the
 * design tokens: parsing `pg_trigger` at request time to build a dropdown is
 * more fragile than the drift this risks, and the drift shows up as a filter
 * with a table missing rather than as a wrong answer.
 */
export const AUDITED_TABLES = [
  "jobs",
  "job_visits",
  "job_signoffs",
  "quotes",
  "quote_lines",
  "contracts",
  "contract_visits",
  "invoices",
  "invoice_lines",
  "payments",
  "customers",
  "properties",
  "assets",
  "technicians",
  "memberships",
  "leave_requests",
] as const;

export type AuditedTable = (typeof AUDITED_TABLES)[number];

export interface AuditEntry {
  readonly id: string;
  readonly tableName: string;
  readonly recordId: string | null;
  readonly action: "insert" | "update" | "delete";
  readonly actorId: string | null;
  readonly actorName: string | null;
  readonly actorKind: string;
  readonly occurredAt: Date;
  readonly ipAddress: string | null;
  readonly requestId: string | null;
  /**
   * Column-level diff, `{ column: { old, new } }` for an update.
   *
   * An insert stores the whole new row under `__new` and a delete under
   * `__old`, which is what `app_audit_trigger` writes. Left in its raw shape
   * rather than normalised into a uniform list, because the viewer's job is to
   * show what the log says, and reshaping it in the reader is where a viewer
   * starts to disagree with the record it is supposed to reproduce.
   */
  readonly changedFields: Record<string, unknown> | null;
}

export interface AuditFilters {
  readonly tableName?: string;
  readonly recordId?: string;
  readonly actorId?: string;
  readonly action?: "insert" | "update" | "delete";
  /** Inclusive, as an ISO date `YYYY-MM-DD` in Asia/Dubai. */
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AuditPage {
  readonly entries: readonly AuditEntry[];
  /** Total matching the filter, so the screen can say "50 of 312" honestly. */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Read the audit log (`ADM-7`).
 *
 * The log has existed since 0000 with UPDATE and DELETE revoked from the
 * application role, and no reader. `MB-018` is closed by this function: the
 * evidence was being collected and could not be looked at, which is the same as
 * not collecting it the first time anyone asks a question about a record.
 *
 * ── WHY A COUNT AND A PAGE, NOT A CAPPED LIST ───────────────────────────────
 *
 * `LEAD-8` names the unbounded list query as the thing that fails first at
 * scale, and this table is the largest one that grows without a retention
 * clock. But a silently capped list is worse than a slow one here: an auditor
 * asking "did anybody change this invoice" and seeing fifty rows has no way to
 * know there were three hundred. The count is a second query and it is worth
 * it — §12.1 of the wireframes is explicit that a partial list must say so.
 *
 * Filters are bound parameters throughout, including `table_name`. It arrives
 * from a query string, and there is no string-built SQL in this codebase.
 */
export async function auditTrail(
  tx: TenantScopedTx,
  filters: AuditFilters = {},
): Promise<AuditPage> {
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  // `null` for an absent filter, and every predicate written as
  // `(param is null or column = param)`. One query plan, no conditional SQL
  // assembly, and no branch that can forget the tenant boundary — which is in
  // the RLS policy anyway, but a reader should not have to check that to be
  // sure.
  const tableName = filters.tableName ?? null;
  const recordId = filters.recordId ?? null;
  const actorId = filters.actorId ?? null;
  const action = filters.action ?? null;
  const from = filters.from ?? null;
  const to = filters.to ?? null;

  const where = sql`
    (${tableName}::text is null or a.table_name = ${tableName}::text)
    and (${recordId}::uuid is null or a.record_id = ${recordId}::uuid)
    and (${actorId}::uuid is null or a.actor_id = ${actorId}::uuid)
    and (${action}::text is null or a.action = ${action}::text)
    and (${from}::date is null or (a.occurred_at at time zone 'Asia/Dubai')::date >= ${from}::date)
    and (${to}::date is null or (a.occurred_at at time zone 'Asia/Dubai')::date <= ${to}::date)
  `;

  const rows = (await tx.execute<{
    id: string;
    table_name: string;
    record_id: string | null;
    action: string;
    actor_id: string | null;
    actor_name: string | null;
    actor_kind: string;
    occurred_at: Date | string;
    ip_address: string | null;
    request_id: string | null;
    changed_fields: Record<string, unknown> | null;
  }>(sql`
    select a.id, a.table_name, a.record_id, a.action, a.actor_id,
           u.full_name as actor_name,
           a.actor_kind, a.occurred_at, a.ip_address, a.request_id, a.changed_fields
      from audit_log a
      -- LEFT, and it matters. The actor may have been deleted, and an audit
      -- entry that disappears because the person who made it left the company
      -- is the one entry an auditor most wants.
      left join users u on u.id = a.actor_id
     where ${where}
     order by a.occurred_at desc, a.id desc
     limit ${limit} offset ${offset}
  `)) as unknown as {
    id: string;
    table_name: string;
    record_id: string | null;
    action: string;
    actor_id: string | null;
    actor_name: string | null;
    actor_kind: string;
    occurred_at: Date | string;
    ip_address: string | null;
    request_id: string | null;
    changed_fields: Record<string, unknown> | null;
  }[];

  const countRows = (await tx.execute<{ total: string }>(sql`
    select count(*)::text as total
      from audit_log a
     where ${where}
  `)) as unknown as { total: string }[];

  return {
    entries: rows.map((r) => ({
      id: r.id,
      tableName: r.table_name,
      recordId: r.record_id,
      action: r.action as AuditEntry["action"],
      actorId: r.actor_id,
      actorName: r.actor_name,
      actorKind: r.actor_kind,
      occurredAt: new Date(r.occurred_at),
      ipAddress: r.ip_address,
      requestId: r.request_id,
      changedFields: r.changed_fields,
    })),
    total: Number(countRows[0]?.total ?? 0),
    limit,
    offset,
  };
}

/**
 * Who has written to the audit log, for the actor filter.
 *
 * Read from the log itself rather than from `memberships`, so a former
 * employee's changes stay reachable after their membership is deactivated.
 * Listing current staff instead would make exactly the history an investigation
 * needs unfilterable.
 */
export async function auditActors(
  tx: TenantScopedTx,
): Promise<readonly { userId: string; fullName: string; entries: number }[]> {
  const rows = (await tx.execute<{ user_id: string; full_name: string | null; entries: string }>(sql`
    select a.actor_id as user_id, u.full_name, count(*)::text as entries
      from audit_log a
      left join users u on u.id = a.actor_id
     where a.actor_id is not null
     group by 1, 2
     order by 3 desc, 2
     limit 100
  `)) as unknown as { user_id: string; full_name: string | null; entries: string }[];

  return rows.map((r) => ({
    userId: r.user_id,
    // A null name means the user row is gone or invisible under the users
    // policy. Saying so beats an empty cell that reads like a rendering bug.
    fullName: r.full_name ?? "(user no longer visible)",
    entries: Number(r.entries),
  }));
}

/**
 * One record's complete history, oldest first.
 *
 * `ADM-7`'s actual requirement is "able to reconstruct any record's history",
 * which is a different query from the filtered list: it is unpaginated by
 * design and ordered forwards, because reconstruction means replaying the
 * changes in the order they happened. The cap is high and explicit rather than
 * absent — a record with more than 500 audited changes is itself the finding.
 */
export async function recordHistory(
  tx: TenantScopedTx,
  input: { tableName: string; recordId: string },
): Promise<readonly AuditEntry[]> {
  const page = await auditTrail(tx, {
    tableName: input.tableName,
    recordId: input.recordId,
    limit: 200,
  });
  return [...page.entries].reverse();
}
