import { sql, type SQL } from "drizzle-orm";
import type { TenantScopedTx } from "../index";
import {
  DASHBOARD_GOALS,
  DASHBOARD_HIRING_WINDOW_DAYS,
  DASHBOARD_HORIZON_DAYS,
  DASHBOARD_WEEK_DAYS,
  DASHBOARD_REVENUE_MONTHS,
  DASHBOARD_SERVICE_LINE_ROWS,
  DASHBOARD_UTILISATION_WINDOW_DAYS,
  DASHBOARD_AT_RISK_ROWS,
  CUSTOMER_QUIET_AFTER_DAYS,
  CUSTOMER_LAPSED_AFTER_DAYS,
  workingMinutesBetween,
  gradeGoal,
  ppmCompletion,
  smallBusinessReliefPosition,
  taxPeriodPositions,
  csvAmount,
  documentJournalLines,
  paymentJournalLines,
  journalTotals,
  dubaiDateKey,
  UserFacingError,
  type GoalVerdict,
  type ReliefPosition,
  type CorporateTaxPack,
  type TaxPeriodRevenue,
  type ExportTable,
  type CsvValue,
  type JournalLine,
  type WorkingCalendar,
} from "@meridian/core";
import { requiredRowDate } from "./_rows";
import { arAgeing, openReceivables, uninvoicedSignedOffJobs, invoiceSequenceGaps } from "./commerce";
import {
  workforceSummary,
  blockedTechnicians,
  findExpiringEmployeeDocuments,
  findExpiringAccreditations,
} from "./compliance";
import { dispatchBoardCounts, dispatchBoardCountsByPriority } from "./jobs";
import { findExpiringCertifications } from "./cron";
// Read, never written. The utilisation denominator is the tenant's OWN working
// calendar — its weekend, its opening hours, its public holidays, its Ramadan
// reduction — and not a constant restated here. A second definition of "a
// working day" is a second answer to "was this technician available", and the
// scheduler already owns the first one.
import { loadWorkingCalendar } from "./reference";
import { listRequisitions } from "./recruitment";
import { emiratisationPosition } from "./hr";
import type { EmiratisationPosition } from "@meridian/core";
// Read, never written by this stream. The dashboard and the AMC screen have to
// agree about PPM completion, and calling the same function is what guarantees it.
import { ppmCompliance } from "./contracts";

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
 *  * `trigger` — a database trigger from `0017_kpi_and_admin` or
 *    `0018_ats_product_events` emits it. It cannot be forgotten, it survives a
 *    hand-repair during an incident, and it is already recording.
 *  * `call` — an application `recordProductEvent` call emits it. Strictly
 *    weaker than a trigger, and an entry using it has to name its call site so
 *    the claim can be checked rather than believed: a call fires from one code
 *    path, a second path making the same change emits nothing, and a repair
 *    made directly in SQL during an incident emits nothing at all.
 *  * `none` — declared, specified, and **not instrumented**. The reason is
 *    stated on the entry.
 *
 * `call` was deliberately absent until there was a call site to point at. An
 * enum value with no members is how `portal_action` would end up marked as
 * instrumented because somebody *intended* to add the call — which is precisely
 * the lie this registry exists to prevent. The rule this file set was to add
 * the value in the same commit as the first `recordProductEvent` call site and
 * not before; `JOB-10`'s override capture is that call site, and this is that
 * commit.
 */
export type EventEmitter = "trigger" | "call" | "none";

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
 * `KPI-2` names eleven event families. Six of them are emitted — lead stage
 * changes, job status changes, quote sent/decided, invoice issued, payment
 * recorded and applicant stage changes — and five are not.
 * `contract_status_changed` is an emitted family that `KPI-2` does not ask for;
 * it costs one trigger and it is what G10's renewal rate will eventually be
 * computed from.
 *
 * ── THE ATS ENTRY THAT WAS FALSE FOR THREE MIGRATIONS ───────────────────────
 *
 * `ats_stage_changed` sat here marked `none`, blocked on "the ATS tables do not
 * exist in this branch", while `0014_recruitment` — three migrations earlier,
 * in this same tree — had already created `job_requisitions`, `applications`,
 * `requisition_stages` and `application_events`. The entry was written before
 * 0014 landed and never revisited, so the weekly report printed "the applicant
 * pipeline is not instrumented" over a database that was recording applicants
 * the whole time.
 *
 * That is worth stating rather than quietly deleting, because it is the same
 * failure this registry exists to prevent, pointed the other way. The registry
 * defends against a zero that is really a hole; a stale blocker is a hole that
 * is really a table away from being filled, and it is harder to notice — a gap
 * list nobody can act on is a gap list nobody reads.
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
  /*
   * The ATS family, from `0018_ats_product_events`.
   *
   * Two names, and the split is the one 0017 already makes twice —
   * `lead_created` beside `lead_stage_changed`, `job_created` beside
   * `job_status_changed`. An arrival is not a transition: it has no prior state
   * to diff and nothing to put in `from_status`.
   *
   * Everything that IS a transition shares ONE name, with the sub-case in the
   * properties, exactly as `job_status_changed` does it. A stage move, a hire
   * and an archival all arrive as `ats_stage_changed`, discriminated by
   * `from_status`/`to_status` and `from_stage_id`/`to_stage_id`. Splitting
   * those into a name per outcome multiplies the names a report has to union
   * before it can answer one question, and a query that forgets one of them
   * loses a share of the traffic without saying so.
   *
   * It hangs off `applications` rather than off `application_events`. The
   * activity feed is written by application code, so a hand-repair or the
   * unauthenticated careers-site path leaves no trace in it — 0018 carries the
   * full argument.
   *
   * The trigger watches `status` as well as `current_stage_id`, and that is the
   * load-bearing detail: `hireCandidate` sets `status = 'hired'` without
   * touching the stage pointer, so a trigger keyed on the pointer alone would
   * silently miss every hire — the one transition the module exists to produce.
   */
  {
    name: "ats_application_received",
    emitter: "trigger",
    description:
      "An application arrived, with its requisition and source. G13's denominator, and the " +
      "only trace the unauthenticated careers-site path leaves in this stream (G13, G14).",
  },
  {
    name: "ats_stage_changed",
    emitter: "trigger",
    description:
      "An application moved stage or changed status — hires and archivals included, " +
      "discriminated by to_status, carrying time in stage and days since applied (G13, G14).",
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
    // Spelled as `JOB-10` spells it. The registry declared
    // `assignment_warning_override` and the PRD asks for
    // `assignment_warning_overridden`, so the call site — which cannot emit a
    // name the registry does not hold — was emitting the registry's spelling
    // and the specification's name existed nowhere in the software. Renamed
    // while the family is an hour old and no row has been written under either
    // spelling; the registry implements the PRD, so where they disagree it is
    // the registry that is wrong.
    name: "assignment_warning_overridden",
    emitter: "call",
    description:
      "A dispatcher assigned past a certification or availability warning, carrying the warning " +
      "types overridden and the technician (JOB-10). Emitted by the `assign` server action in " +
      "`app/(app)/jobs/[id]/actions.ts`, best-effort and outside the transaction: the record of the " +
      "override is `job_visits.override_reason`, and this row exists so the weekly report can count " +
      "overrides without reading every visit. A failure here loses a bar on a chart rather than a " +
      "dispatch that has already happened.",
  },
  {
    name: "portal_action",
    emitter: "none",
    description: "A customer did something in the portal instead of phoning (G9).",
    blockedOn:
      "Only the half that writes no row. Portal writes ARE distinguishable now: " +
      "`withCustomerScope` sets `app.actor_kind` to `customer`, `app_product_event` stamps it onto " +
      "every row it writes, and a portal-raised job additionally carries `source = customer_portal` " +
      "in its `job_created` properties — so those are already counted, under their own event names. " +
      "What has no emitter is the rest of G9: viewing an invoice, downloading a statement, reading a " +
      "quotation. Those are the actions that replace a phone call and none of them writes a row, so " +
      "there is nothing for a trigger to fire on. It needs a `recordProductEvent` call on the portal " +
      "read paths, which belongs to the portal stream.",
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
  /**
   * G12 / CON-7, as a whole percent. Null when no visit has come due yet.
   *
   * Null rather than zero AND null rather than 100. Both wrong answers are
   * available here and each is wrong in an opposite, plausible direction: 0%
   * shows a contractor who has never sold an AMC as catastrophically failing a
   * 98% target, and 100% awards a perfect score to a business that has done no
   * maintenance. `ppmCompletion` in `core` returns 100 for a single contract
   * with nothing yet due, which is right for one contract inside its first
   * month and wrong as a headline for a whole tenant.
   */
  readonly ppmCompletionPercent: number | null;
  readonly ppmVerdict: GoalVerdict;
  /** Visits whose window has closed: completed plus overdue. The denominator. */
  readonly ppmVisitsDue: number;
  readonly ppmVisitsCompleted: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// MD-1 — where the money comes from: by service line and by month
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One service line's contribution over the breakdown window.
 *
 * `revenueMinor` is tax-exclusive and net of credit notes, exactly like the
 * headline it sits under — it is the same `net_amount` arithmetic read one
 * level down, at the invoice LINE rather than the invoice, which is the only
 * level at which the question "which trade earned this" has an answer.
 */
export interface ServiceLineRevenue {
  /** Catalogue slug. Null where the line carries none — see `unattributedMinor`. */
  readonly serviceSlug: string | null;
  readonly revenueMinor: number;
  /** Jobs COMPLETED on that slug in the window. Volume, beside value. */
  readonly jobsCompleted: number;
}

/** One Dubai calendar month of the breakdown. */
export interface MonthlyRevenue {
  /** "YYYY-MM", Asia/Dubai. Computed in SQL, never from a JavaScript month. */
  readonly month: string;
  readonly revenueMinor: number;
  readonly jobsCompleted: number;
}

/**
 * `MD-1`: "revenue, margin and job volume by service line and by month".
 *
 * Two of the three. Margin is absent and is a declared `DashboardGap` rather
 * than a zero — see the entry in `DASHBOARD_GAPS`, which names the exact table
 * that does not exist.
 *
 * ── THE TWO NUMBERS THAT MAKE THIS HONEST ───────────────────────────────────
 *
 *  * `attributedMinor` is the sum of EVERY line in the window, not of the rows
 *    in `byServiceLine`. `byServiceLine` is capped at
 *    `DASHBOARD_SERVICE_LINE_ROWS` for display and `otherMinor` /
 *    `serviceLinesTotal` carry what the cap hid, so a card can render
 *    "8 of 41" instead of presenting a truncated list as the whole business.
 *    Summing a headline from a capped list has been found five times in this
 *    repository and never once looked wrong on the screen.
 *  * `unattributedMinor` is the headline revenue MINUS `attributedMinor`. It
 *    is normally zero — `apportionLines` in core guarantees that a document's
 *    line nets sum exactly to its `taxable_amount` — and it is carried anyway
 *    because `invoice_lines.net_amount` is nullable for rows written before
 *    migration 0007. Those lines cannot be attributed to a service without
 *    inventing a figure, so they are reported as unattributed rather than
 *    dropped. A breakdown that silently fails to add up to the total above it
 *    is the defect this field exists to make impossible.
 */
export interface RevenueBreakdown {
  /** Whole Dubai months covered, including the current partial one. */
  readonly months: number;
  /** "YYYY-MM" of the first month in the window. */
  readonly fromMonth: string;
  /** Revenue over the window on the same definition as `RevenuePosition`. */
  readonly windowRevenueMinor: number;
  /** Sum of every attributable line in the window. */
  readonly attributedMinor: number;
  /** `windowRevenueMinor - attributedMinor`. Normally zero; see above. */
  readonly unattributedMinor: number;
  /** Highest-earning lines first, capped for display. */
  readonly byServiceLine: readonly ServiceLineRevenue[];
  /** Every line below the cap, summed. Zero when nothing was cut. */
  readonly otherMinor: number;
  /**
   * Distinct service lines with revenue OR completed jobs in the window — every
   * line `byServiceLine` was ranked over, not only the ones displayed. The
   * "of 41".
   */
  readonly serviceLinesTotal: number;
  /** Oldest month first, so it reads left to right as a chart. */
  readonly byMonth: readonly MonthlyRevenue[];
  readonly currency: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// MD-3 — technician utilisation, and what can honestly stand where
//        first-time-fix was asked for
// ═══════════════════════════════════════════════════════════════════════════

export interface TechnicianUtilisation {
  readonly technicianId: string;
  readonly name: string;
  readonly availableMinutes: number;
  readonly workedMinutes: number;
  /** Null when this technician has no available time in the window at all. */
  readonly utilisationPercent: number | null;
}

/**
 * `MD-3`, first half: technician utilisation.
 *
 * ── THE DEFINITION, WRITTEN DOWN BECAUSE IT IS A CHOICE ─────────────────────
 *
 * **Utilisation = recorded time on the tools ÷ available working time.**
 *
 * *Numerator* — `job_visits.work_minutes`, the figure a technician or a
 * supervisor typed into the job card. Not scheduled duration: a visit booked
 * for two hours that took forty minutes is forty minutes of utilisation, and
 * measuring the booking measures the dispatcher's optimism. Travel is
 * deliberately excluded and reported beside it as `travelMinutes` — travel is
 * real time and it is not productive time, and folding it in is how a business
 * with a routing problem reports 95% utilisation.
 *
 * *Denominator* — working minutes from the tenant's own `WorkingCalendar` via
 * `workingMinutesBetween`, so the weekend it actually keeps, its public
 * holidays and the statutory Ramadan reduction are all already handled by the
 * same code the scheduler uses. Then, per technician: clipped at `joined_on`
 * so somebody who started six weeks into a ninety-day window is not measured
 * against ninety days, and less any APPROVED leave overlapping the window.
 * Pending leave is somebody asking, not a fact about the diary — the same rule
 * `assignmentWarnings` applies.
 *
 * Three denominators were available and this is the third: contracted hours do
 * not exist on `technicians` at all (there is no hours or FTE column), rostered
 * hours do not exist in practice (the `shifts` table has no writer anywhere in
 * the product and is empty in every deployment), and calendar hours would
 * charge every technician for Fridays and Eid. The working calendar is the only
 * one of the three that is both populated and meaningful.
 *
 * ── AND WHY THE PERCENTAGE CAN BE NULL ──────────────────────────────────────
 *
 * `work_minutes` is written by exactly one production path — the web job-card
 * form — so on a business that has not adopted the job card it is null
 * everywhere. Utilisation computed over that is 0%, which reads as idle
 * technicians and means unrecorded labour. Those are opposite conclusions from
 * the same number, so the figure is null until at least one visit carries
 * labour, and `labourCoveragePercent` is returned beside it always: a
 * utilisation figure resting on 12% of visits is a figure whose reader has to
 * know that.
 */
export interface UtilisationPosition {
  readonly windowDays: number;
  /** Active technicians. The denominator's population, uncapped. */
  readonly technicians: number;
  readonly availableMinutes: number;
  readonly workedMinutes: number;
  /** Recorded travelling. Reported, never folded into the numerator. */
  readonly travelMinutes: number;
  /** Whole percent. Null when no visit in the window carries labour. */
  readonly utilisationPercent: number | null;
  /** Visits in the window on jobs that reached a completed state. */
  readonly visitsOnCompletedJobs: number;
  /** How many of those carry recorded labour. */
  readonly visitsWithLabour: number;
  /** Whole percent. Null when no visit in the window sits on a completed job. */
  readonly labourCoveragePercent: number | null;
  /** Busiest first, capped for display. The counts above are not capped. */
  readonly byTechnician: readonly TechnicianUtilisation[];
  /** Minutes of approved leave removed from the denominator. */
  readonly leaveMinutesExcluded: number;
}

export interface OutcomeTally {
  readonly code: string;
  readonly label: string;
  readonly requiresReturnVisit: boolean;
  readonly jobs: number;
}

/**
 * `MD-3`, second half — and NOT first-time-fix. Read `DASHBOARD_GAPS`.
 *
 * G11 defines first-time fix as "jobs closed on first visit ÷ all reactive
 * jobs" and this system cannot count either side of that honestly. What it CAN
 * count is what somebody deliberately recorded when the work ended: the job's
 * outcome code, and whether that outcome is one the tenant has marked as
 * leaving a return visit owed.
 *
 * That is a different metric with a different meaning and it is named
 * differently on purpose. A return-visit rate says "this proportion of finished
 * work left something owing"; a first-time-fix rate says "this proportion was
 * done in one attendance". They correlate and they are not the same, and
 * putting the second label on the first number is exactly the plausible-looking
 * lie this file exists to refuse.
 *
 * `outcomeCoveragePercent` is not decoration either. A return-visit rate over
 * the 8% of jobs that happen to carry an outcome is not a rate, so the
 * denominator's honesty is returned with the figure rather than assumed.
 */
export interface OutcomePosition {
  readonly windowDays: number;
  readonly jobsCompleted: number;
  readonly outcomesRecorded: number;
  /** Whole percent. Null when nothing completed in the window. */
  readonly outcomeCoveragePercent: number | null;
  /** Jobs whose recorded outcome requires a return visit. */
  readonly returnVisitRequired: number;
  /** Of jobs WITH an outcome, not of all jobs. Null when none carry one. */
  readonly returnVisitRatePercent: number | null;
  /** Every recorded outcome and its count. Uncapped; the vocabulary is small. */
  readonly byOutcome: readonly OutcomeTally[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MD-5 — which customers are at risk, before they leave
// ═══════════════════════════════════════════════════════════════════════════

export type CustomerRiskReason = "gone_quiet" | "contract_lapsed";

export interface AtRiskCustomer {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly state: "at_risk" | "lapsed";
  readonly reason: CustomerRiskReason;
  /** "YYYY-MM-DD" in Asia/Dubai, or null where there has never been activity. */
  readonly lastActiveOn: string | null;
  readonly daysQuiet: number | null;
  /** Trailing twelve months, tax-exclusive, net of credit notes. What is at stake. */
  readonly revenueMinor: number;
}

/**
 * `MD-5`: "know which customers are at risk before they leave".
 *
 * ── THE DEFINITION, WRITTEN DOWN BECAUSE IT IS A JUDGEMENT ──────────────────
 *
 * Nothing in this system records that a customer left. There is no cancellation
 * event, no closed-account status that anybody maintains — `customers.is_active`
 * is written by nothing outside the seed — and a maintenance customer does not
 * resign, they simply stop calling. So the only available signal is silence,
 * and every choice below is about how to read it.
 *
 * **Activity** is the later of the customer's most recent job (by `created_at`)
 * and their most recent non-draft invoice (by `issued_on`), taken as a
 * *Dubai* calendar date. Jobs alone would miss a customer billed monthly under
 * a facilities agreement; invoices alone would miss one whose work is all
 * contract-covered and never separately invoiced.
 *
 * **Retained** — holds a live contract (`active`, not past its end date),
 * whatever the silence. A contracted customer is contractually retained, and
 * one who looks quiet is a PPM-generation fault to investigate, not churn to
 * report. Otherwise: retained if they have been active inside
 * `CUSTOMER_QUIET_AFTER_DAYS`.
 *
 * **At risk** — no live contract, and either quiet for longer than
 * `CUSTOMER_QUIET_AFTER_DAYS` (but not yet `CUSTOMER_LAPSED_AFTER_DAYS`), or a
 * contract that ended inside the last `CUSTOMER_LAPSED_AFTER_DAYS` with nothing
 * signed since. The second is the leading indicator `MD-5` is actually asking
 * for: the AMC ran out in March and nobody chased it, and the customer has not
 * yet noticed they are no longer covered.
 *
 * **Lapsed** — quiet for longer than `CUSTOMER_LAPSED_AFTER_DAYS` with no live
 * contract. Reported as churn.
 *
 * **Never active** — a customer record with no job and no invoice, ever. Held
 * out of BOTH sides of the rate. A tenant that imported a customer list on
 * Monday must not read 90% churn on Tuesday, and that is precisely what
 * counting them as lapsed would produce.
 *
 * Both thresholds live in `@meridian/core` so a business that knows its own
 * rhythm can move them in one place, and so that moving them moves the test
 * with the dashboard.
 */
export interface RetentionPosition {
  /** Customers with at least one job or invoice, ever. The rate's denominator. */
  readonly everActive: number;
  readonly retained: number;
  readonly atRisk: number;
  readonly lapsed: number;
  /** Records with no activity at all. Excluded from the rate; reported so the zero is legible. */
  readonly neverActive: number;
  /** Lapsed / everActive as a whole percent. Null when nobody has ever been active. */
  readonly churnRatePercent: number | null;
  /**
   * At-risk and lapsed customers, most revenue first, capped for display.
   *
   * The counts above are SQL aggregates over every customer and are NOT the
   * length of this list. Compare `list.length` against `atRisk + lapsed` to see
   * whether the card is showing everything.
   */
  readonly customers: readonly AtRiskCustomer[];
  readonly quietAfterDays: number;
  readonly lapsedAfterDays: number;
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

/**
 * Hiring (`KPI-3` — "open roles and days-to-hire").
 *
 * `requisitionsRecorded` is not decoration. Zero open roles on a business that
 * has recorded fifteen requisitions is a business that is not hiring this
 * month, which is fine; zero open roles on an empty table is a module nobody
 * has started using, and the two must not render the same way. It is the same
 * good-zero/gap-zero distinction `EmptyState` draws, carried as data so the
 * screen does not have to guess.
 */
export interface HiringPosition {
  /** Approved, published and not past their closing date. */
  readonly openRoles: number;
  /** Heads wanted across those roles. A role can be open for three people. */
  readonly openHeadcount: number;
  /** Approved but not yet published — a role nobody can apply to. */
  readonly awaitingApproval: number;
  /** Every requisition ever recorded, any status. Zero means an unused module. */
  readonly requisitionsRecorded: number;
  /** Live applications against the open roles. */
  readonly liveApplications: number;
  readonly hiresInWindow: number;
  /** Median, in days. Null when nobody was hired in the window — never zero. */
  readonly medianDaysToHire: number | null;
  readonly daysToHireVerdict: GoalVerdict;
  readonly windowDays: number;
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
  /** `MD-1`. Where the revenue above came from, by service line and by month. */
  readonly revenueBreakdown: RevenueBreakdown;
  /** `MD-3`. Time on the tools against available working time. */
  readonly utilisation: UtilisationPosition;
  /** `MD-3`. What finished work was recorded as. NOT first-time-fix; see the type. */
  readonly outcomes: OutcomePosition;
  /** `MD-5`. Customers going quiet, before they have gone. */
  readonly retention: RetentionPosition;
  readonly pipeline: PipelinePosition;
  readonly work: WorkPosition;
  readonly contracts: ContractPosition;
  readonly compliance: CompliancePosition;
  readonly hiring: HiringPosition;
  readonly billing: BillingRisk;
  /**
   * Skilled headcount against the 50-employee Emiratisation threshold
   * (`KPI-3` / `HR-18`).
   *
   * Carries `lowerBound`/`upperBound`, not a single figure — see
   * `emiratisationPosition` and `assessEmiratisation` in `packages/core`.
   * An employee with a missing ISCO group or certificate answer is not
   * counted as unskilled; they widen the range instead, because the
   * establishment is banded on the upper bound. Render `headline` and
   * `caveat` together, never `skilled` alone: a single confident number
   * is exactly the misleading figure this used to be a `DASHBOARD_GAPS`
   * entry to prevent.
   */
  readonly emiratisation: EmiratisationPosition;
  /**
   * Every tax period on record against the relief line (`INV-17`).
   *
   * On the dashboard for one reason: `revenue.relief` measures **this** period,
   * and the relief is lost permanently by a breach in **any** period. Without
   * this the meter reads green every January after the year it was crossed,
   * which is precisely the failure `INV-17` was written about.
   */
  readonly tax: CorporateTaxPack;
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

  const [
    ageing,
    revenue,
    pipeline,
    work,
    contracts,
    compliance,
    hiring,
    billing,
    tax,
    emiratisation,
    breakdown,
    utilisation,
    outcomes,
    retention,
  ] = await Promise.all([
    arAgeing(tx, now),
    revenuePosition(tx, now),
    pipelinePosition(tx, now),
    workPosition(tx, now),
    contractPosition(tx, now, horizonDays),
    compliancePosition(tx, horizonDays, now),
    hiringPosition(tx, now),
    billingRisk(tx, now),
    corporateTaxPack(tx, { now }),
    emiratisationPosition(tx),
    revenueBreakdown(tx, now),
    utilisationPosition(tx, now),
    outcomePosition(tx, now),
    retentionPosition(tx, now),
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
    revenueBreakdown: breakdown,
    utilisation,
    outcomes,
    retention,
    pipeline,
    work,
    contracts,
    compliance,
    hiring,
    billing,
    tax,
    emiratisation,
    attention: attentionItems({ cash, revenue, work, contracts, compliance, billing, tax }),
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
    requirement: "KPI-3 / HR-17",
    metric: "WPS payroll countdown",
    waitingOn: "The HR stream — there is no payroll calendar table.",
  },
  /*
   * ── THIS ENTRY WAS WRONG, AND THE CORRECTION MATTERS ──────────────────────
   *
   * It used to read: "The field app (M11, Phase 3). It is computed from visit
   * outcome codes, and no visit records one yet." Half of that is now stale and
   * the half that survives is not the real blocker, so both halves were
   * misleading in opposite directions: it implied the metric arrives with the
   * field app, and it will not.
   *
   * What changed: `jobs.outcome_code` IS written now, by `recordJobOutcome`
   * (`domain/outcomes.ts`), from the web job card, against the controlled
   * `job_outcome_codes` vocabulary. The outcome capture the entry was waiting
   * for exists.
   *
   * What did not change, and what actually blocks G11 — "jobs closed on first
   * visit / all reactive jobs" — is that NEITHER side of that fraction can be
   * counted honestly:
   *
   *  1. A `job_visits` row is not an attendance. It is written at ASSIGNMENT
   *     (`domain/assignment.ts`, status `assigned`, `dispatched_at` set), the
   *     `visit_status` enum has no `cancelled` or `reassigned` member, and
   *     `rescheduleVisit` refuses to change the technician — so reassigning a
   *     job inserts a SECOND row and nothing ever retires the first. A job
   *     fixed on the first attendance after two office reassignments carries
   *     three visits. Counting visits would report a first-time-fix rate
   *     depressed by dispatcher churn, which is not what G11 measures.
   *  2. The obvious repair — count only visits carrying recorded labour —
   *     fails in the flattering direction, which is worse. `assertJobCardComplete`
   *     requires labour on the JOB, not on every visit, so a genuine failed
   *     first attendance where nobody typed minutes disappears and the job
   *     scores as a first-time fix.
   *  3. The outcome code cannot break the tie either. It is a JOB-level column
   *     overwritten on each `recordJobOutcome` call, so a job whose first visit
   *     was no-access and whose second was a fix records only the fix. The
   *     evidence that would separate them is destroyed by design.
   *  4. "Reactive" has no marker. `jobs.is_revisit` and `jobs.parent_job_id`
   *     exist in the schema and nothing in the product has ever written either.
   *
   * So this is not a field-app dependency. It is a schema change: an outcome,
   * or at minimum an attended flag, recorded PER VISIT and never overwritten.
   * `outcomePosition` returns what the recorded data does support — a
   * return-visit rate, under its own name.
   */
  {
    requirement: "KPI-3 / G11 / MD-3",
    metric: "First-time fix rate",
    waitingOn:
      "A per-visit outcome. `job_visits` records assignments, not attendances — a reassignment " +
      "inserts a second row and nothing retires the first — and `jobs.outcome_code` is one " +
      "job-level value overwritten on each call, so neither the numerator (closed on the first " +
      "attendance) nor the denominator (reactive jobs) can be counted. The return-visit rate on " +
      "the same card is what the recorded data does support.",
  },
  /*
   * ── MD-1's MARGIN, AND WHY IT IS STILL NOT A NUMBER ───────────────────────
   *
   * `CON-8` deferred margin at renewal on the ground that "the system records
   * what a contract is worth and not what it costs to service", and the AMC
   * screen still says so in as many words. `PRJ-8` has since built the other
   * half — `labour_cost_rates` (fully loaded, effective-dated) and
   * `project_costs` (captured at entry, never re-derived) — so the ground has
   * genuinely moved, and it was re-examined rather than assumed before this
   * entry was written.
   *
   * It has not moved far enough. `project_costs.project_id` is NOT NULL: cost
   * exists only where a project exists, and the maintenance and AMC work this
   * dashboard's revenue is almost entirely made of has no cost row at all.
   *
   * The two columns that look like a substitute are worse than nothing:
   *
   *  * `technicians.hourly_cost` is written by nothing in the product (the seed
   *    sets a flat 45.00 and no screen edits it), is undated and edited in
   *    place — the exact pattern `labour_cost_rates` was versioned to avoid,
   *    where giving the electricians a rise silently rewrites the margin on
   *    every job ever closed — and is not documented as fully loaded. The
   *    `labour_cost_rates` schema puts the size of that error at about a third,
   *    "worse than no margin at all because it is believed".
   *  * `job_materials.unit_cost` is nullable and optional on the field sync
   *    path, so a job whose parts were not costed reports a HIGHER margin than
   *    reality. Wrong in the flattering direction is the one direction a margin
   *    must never be wrong in, because somebody prices against it.
   *
   * A margin is therefore a gap and not a figure. What unblocks it is a cost
   * ledger that reaches jobs — `project_costs.job_id` already exists and is
   * nullable for exactly this — plus a rate table with the effective dating
   * `labour_cost_rates` has and `technicians.hourly_cost` does not.
   */
  {
    requirement: "MD-1",
    metric: "Revenue margin, by service line and by month",
    waitingOn:
      "A cost ledger that reaches jobs. `project_costs` requires a project, so maintenance and AMC " +
      "work — nearly all of this revenue — has no recorded cost. `technicians.hourly_cost` is " +
      "written by nothing but the seed and is undated, so using it would rewrite history on every " +
      "pay rise, and `job_materials.unit_cost` is optional, so an uncosted part would report a " +
      "higher margin than reality. Revenue and job volume by service line and by month are shown.",
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
/**
 * What "revenue" means, once, in SQL.
 *
 * ── WHY THIS IS A SHARED FRAGMENT AND NOT TWO SIMILAR QUERIES ───────────────
 *
 * Two figures in this system are measured against the AED 3,000,000 Small
 * Business Relief line: the meter on the owner dashboard (`revenuePosition`)
 * and the tax-period pack (`corporateTaxPack`, `INV-17`). If those two ever
 * disagreed, the screen that says "you are fine" and the screen that says "you
 * are not" would both be in the product, and the business would believe
 * whichever it read first. Breaching AED 3m once ends the relief permanently,
 * so the cost of believing the wrong one is not recoverable.
 *
 * The two queries therefore share this definition rather than resembling each
 * other. Four decisions live in it:
 *
 *  * **Tax-exclusive.** `taxable_amount`, not `total`. VAT is collected on
 *    behalf of the FTA and is not revenue; measuring the relief on the gross
 *    would report a breach roughly AED 150,000 early every year.
 *  * **Drafts are not revenue.** A draft is not a document.
 *  * **Credit notes subtract.** `crn` is netted off wherever `inv` is summed,
 *    never left to a caller to remember.
 *  * **Dated in Asia/Dubai.** `issued_on` is a `timestamptz`; an invoice raised
 *    at 02:00 Dubai on 1 January is 31 December in UTC and belongs to the wrong
 *    tax period under the wrong timezone. That is a permanent misstatement of a
 *    threshold, which is why every boundary here is computed in SQL against
 *    this conversion and none of it is done in JavaScript.
 *
 * `issued_on is null` on a non-draft is a data fault: it is excluded rather
 * than dated to today, because inventing an issue date puts revenue in a period
 * it was never earned in.
 */
const REVENUE_SOURCE = sql`
    inv as (
      select (i.issued_on at time zone 'Asia/Dubai') as issued_local,
             (i.taxable_amount * 100)::bigint        as taxable_minor,
             i.currency
        from invoices i
       where i.deleted_at is null
         and i.status <> 'draft'
         and i.issued_on is not null
    ),
    crn as (
      select (c.issued_on at time zone 'Asia/Dubai') as issued_local,
             (c.taxable_amount * 100)::bigint        as taxable_minor
        from credit_notes c
       where c.deleted_at is null
         and c.issued_on is not null
    )`;

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
    ${REVENUE_SOURCE}
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

// ── MD-1: the breakdown ──────────────────────────────────────────────────────

/**
 * The window, the line-level revenue in it, and the job volume beside it.
 *
 * A shared fragment for the same reason `REVENUE_SOURCE` is one: the by-service
 * query, the by-month query and the reconciliation query have to be measuring
 * one window over one definition, and three similar CTE blocks are three
 * windows that drift apart on the first edit.
 *
 * Every boundary is Asia/Dubai and computed in SQL. A by-month breakdown is
 * precisely where the session timezone bites: an invoice issued at 01:30 Dubai
 * on 1 July is 30 June in UTC, and a JavaScript month boundary would file it
 * under the wrong month for about two hours of every day.
 */
function breakdownSource(nowIso: string, months: number): SQL {
  return sql`
    anchor as (
      select (${nowIso}::timestamptz at time zone 'Asia/Dubai') as local_now
    ),
    bounds as (
      select date_trunc('month', local_now) - make_interval(months => ${months - 1}) as window_start,
             date_trunc('month', local_now)                                          as current_month_start,
             local_now + interval '1 day'                                            as window_end
        from anchor
    ),
    inv_line as (
      select date_trunc('month', (i.issued_on at time zone 'Asia/Dubai')) as month_start,
             il.service_slug                                              as slug,
             (il.net_amount * 100)::bigint                                as net_minor
        from invoice_lines il
        join invoices i on i.id = il.invoice_id
       cross join bounds b
       where i.deleted_at is null
         and i.status <> 'draft'
         and i.issued_on is not null
         and il.deleted_at is null
         and il.net_amount is not null
         and (i.issued_on at time zone 'Asia/Dubai') >= b.window_start
         and (i.issued_on at time zone 'Asia/Dubai') <  b.window_end
    ),
    crn_line as (
      select date_trunc('month', (c.issued_on at time zone 'Asia/Dubai')) as month_start,
             cl.service_slug                                              as slug,
             (cl.net_amount * 100)::bigint                                as net_minor
        from credit_note_lines cl
        join credit_notes c on c.id = cl.credit_note_id
       cross join bounds b
       where c.deleted_at is null
         and c.issued_on is not null
         and cl.deleted_at is null
         and (c.issued_on at time zone 'Asia/Dubai') >= b.window_start
         and (c.issued_on at time zone 'Asia/Dubai') <  b.window_end
    ),
    net_lines as (
      select month_start, slug,  net_minor from inv_line
      union all
      select month_start, slug, -net_minor from crn_line
    ),
    job_volume as (
      select date_trunc('month', (j.completed_at at time zone 'Asia/Dubai')) as month_start,
             j.service_slug                                                  as slug,
             count(*)                                                        as jobs
        from jobs j
       cross join bounds b
       where j.deleted_at is null
         and j.completed_at is not null
         and (j.completed_at at time zone 'Asia/Dubai') >= b.window_start
         and (j.completed_at at time zone 'Asia/Dubai') <  b.window_end
       group by 1, 2
    )`;
}

/**
 * `MD-1`: revenue and job volume, by service line and by month.
 *
 * Every figure here is a Postgres aggregate over every matching row. Nothing is
 * a reduction of a page of results, and the two display caps
 * (`DASHBOARD_SERVICE_LINE_ROWS`, and nothing at all on the months) are applied
 * after the totals are known, with what they hid returned beside them.
 *
 * Job volume is keyed on `jobs.completed_at`, not `created_at`: the question
 * beside a revenue figure is how much work was DONE that month, and a job
 * raised in June and finished in August belongs to August in both columns.
 */
export async function revenueBreakdown(
  tx: TenantScopedTx,
  now: Date,
  options?: { months?: number; rows?: number },
): Promise<RevenueBreakdown> {
  const months = options?.months ?? DASHBOARD_REVENUE_MONTHS;
  const rows = options?.rows ?? DASHBOARD_SERVICE_LINE_ROWS;
  const iso = now.toISOString();
  const source = breakdownSource(iso, months);

  const [serviceRows, monthRows, totalRows] = await Promise.all([
    tx.execute<{ slug: string | null; revenue_minor: string; jobs: string }>(sql`
      with ${source},
      slugs as (
        select slug from net_lines
        union
        select slug from job_volume
      ),
      agg as (
        select s.slug,
               coalesce((select sum(net_minor) from net_lines l
                          where l.slug is not distinct from s.slug), 0) as revenue_minor,
               coalesce((select sum(jobs) from job_volume v
                          where v.slug is not distinct from s.slug), 0) as jobs
          from slugs s
      )
      select slug,
             revenue_minor::text as revenue_minor,
             jobs::text          as jobs
        from agg
       order by revenue_minor desc, slug asc
    `) as unknown as Promise<{ slug: string | null; revenue_minor: string; jobs: string }[]>,

    tx.execute<{ month: string; revenue_minor: string; jobs: string }>(sql`
      with ${source},
      grid as (
        select generate_series(b.window_start, b.current_month_start, interval '1 month') as month_start
          from bounds b
      )
      select to_char(g.month_start, 'YYYY-MM')                                        as month,
             coalesce((select sum(net_minor) from net_lines l
                        where l.month_start = g.month_start), 0)::text                as revenue_minor,
             coalesce((select sum(jobs) from job_volume j
                        where j.month_start = g.month_start), 0)::text                as jobs
        from grid g
       order by g.month_start asc
    `) as unknown as Promise<{ month: string; revenue_minor: string; jobs: string }[]>,

    tx.execute<{
      window_revenue_minor: string;
      attributed_minor: string;
      from_month: string;
      currency: string | null;
    }>(sql`
      with ${source}
      select (
          coalesce((select sum((i.taxable_amount * 100)::bigint)
                      from invoices i cross join bounds b
                     where i.deleted_at is null
                       and i.status <> 'draft'
                       and i.issued_on is not null
                       and (i.issued_on at time zone 'Asia/Dubai') >= b.window_start
                       and (i.issued_on at time zone 'Asia/Dubai') <  b.window_end), 0)
        - coalesce((select sum((c.taxable_amount * 100)::bigint)
                      from credit_notes c cross join bounds b
                     where c.deleted_at is null
                       and c.issued_on is not null
                       and (c.issued_on at time zone 'Asia/Dubai') >= b.window_start
                       and (c.issued_on at time zone 'Asia/Dubai') <  b.window_end), 0)
        )::text as window_revenue_minor,
        coalesce((select sum(net_minor) from net_lines), 0)::text as attributed_minor,
        (select to_char(window_start, 'YYYY-MM') from bounds)     as from_month,
        (select currency from invoices
          where deleted_at is null and status <> 'draft' limit 1) as currency
    `) as unknown as Promise<{
      window_revenue_minor: string;
      attributed_minor: string;
      from_month: string;
      currency: string | null;
    }[]>,
  ]);

  const all: ServiceLineRevenue[] = serviceRows.map((r) => ({
    serviceSlug: r.slug,
    revenueMinor: Number(r.revenue_minor),
    jobsCompleted: Number(r.jobs),
  }));

  const shown = all.slice(0, rows);
  const otherMinor = all.slice(rows).reduce((sum, r) => sum + r.revenueMinor, 0);
  const totals = totalRows[0];
  const windowRevenueMinor = Number(totals?.window_revenue_minor ?? 0);
  const attributedMinor = Number(totals?.attributed_minor ?? 0);

  return {
    months,
    fromMonth: totals?.from_month ?? "",
    windowRevenueMinor,
    attributedMinor,
    unattributedMinor: windowRevenueMinor - attributedMinor,
    byServiceLine: shown,
    otherMinor,
    // Every line the list is ranked over, including one with completed jobs and
    // no money against it — contract-covered work is exactly that, and it is
    // information rather than noise. "8 of 41" has to count the same things the
    // eight rows were chosen from, or the two numbers describe different sets.
    serviceLinesTotal: all.length,
    byMonth: monthRows.map((r) => ({
      month: r.month,
      revenueMinor: Number(r.revenue_minor),
      jobsCompleted: Number(r.jobs),
    })),
    currency: totals?.currency ?? "AED",
  };
}

// ── MD-3: utilisation ────────────────────────────────────────────────────────

/**
 * `MD-3`: time on the tools against available working time.
 *
 * The definition, the three denominators that were available and why this is
 * the one, and why the percentage can be null, are all on
 * `UtilisationPosition`. Read that before changing anything here.
 *
 * ── WHY THE DENOMINATOR IS COMPUTED IN TYPESCRIPT ───────────────────────────
 *
 * Every other figure on this dashboard is a SQL aggregate, and this one is not.
 * The reason is that "a working minute" is not a fact in the database: it is
 * `workingMinutesBetween` applied to the tenant's `WorkingCalendar`, which
 * assembles a weekend array, opening minutes, a public-holiday table and a
 * Ramadan period table into a rule with a two-hour statutory reduction in it.
 * Restating that rule in SQL would be a second definition of the working day
 * sitting beside the scheduler's, and the two would disagree the first time an
 * administrator added a holiday.
 *
 * The capped-list trap is avoided the other way: the technician list is read
 * WITHOUT a limit, so the denominator is over every active technician, and the
 * numerator is a single SQL aggregate over every visit in the window.
 * `byTechnician` is sliced for display only, after both totals exist.
 */
export async function utilisationPosition(
  tx: TenantScopedTx,
  now: Date,
  options?: { windowDays?: number; rows?: number; calendar?: WorkingCalendar },
): Promise<UtilisationPosition> {
  const windowDays = options?.windowDays ?? DASHBOARD_UTILISATION_WINDOW_DAYS;
  const rows = options?.rows ?? DASHBOARD_SERVICE_LINE_ROWS;
  const windowEnd = now;
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const [calendar, techRows, leaveRows, workRows, coverRows] = await Promise.all([
    options?.calendar ? Promise.resolve(options.calendar) : loadWorkingCalendar(tx),

    // No limit. This list IS the denominator's population, and a page of it
    // would be a plateau at the page size.
    tx.execute<{ id: string; full_name: string; joined_on: Date | null }>(sql`
      select id, full_name, joined_on
        from technicians
       where deleted_at is null and is_active
       order by full_name
    `) as unknown as Promise<{ id: string; full_name: string; joined_on: Date | null }[]>,

    tx.execute<{ technician_id: string; starts_on: Date; ends_on: Date }>(sql`
      select technician_id, starts_on, ends_on
        from leave_requests
       where deleted_at is null
         and status = 'approved'
         and starts_on <  ${windowEnd.toISOString()}::timestamptz
         and ends_on   >= ${windowStart.toISOString()}::timestamptz
    `) as unknown as Promise<{ technician_id: string; starts_on: Date; ends_on: Date }[]>,

    tx.execute<{ technician_id: string; worked: string; travel: string; labour_visits: string }>(sql`
      select v.technician_id,
             coalesce(sum(v.work_minutes), 0)::text                   as worked,
             coalesce(sum(v.travel_minutes), 0)::text                 as travel,
             count(*) filter (where v.work_minutes is not null)::text as labour_visits
        from job_visits v
       where v.deleted_at is null
         and v.scheduled_start >= ${windowStart.toISOString()}::timestamptz
         and v.scheduled_start <  ${windowEnd.toISOString()}::timestamptz
       group by 1
    `) as unknown as Promise<
      { technician_id: string; worked: string; travel: string; labour_visits: string }[]
    >,

    tx.execute<{ visits: string; with_labour: string }>(sql`
      select count(*)::text                                            as visits,
             count(*) filter (where v.work_minutes is not null)::text  as with_labour
        from job_visits v
        join jobs j on j.id = v.job_id
       where v.deleted_at is null
         and j.deleted_at is null
         and j.status in ('work_complete', 'signed_off', 'invoiced', 'closed')
         and v.scheduled_start >= ${windowStart.toISOString()}::timestamptz
         and v.scheduled_start <  ${windowEnd.toISOString()}::timestamptz
    `) as unknown as Promise<{ visits: string; with_labour: string }[]>,
  ]);

  const workedBy = new Map(workRows.map((r) => [r.technician_id, r]));
  const leaveBy = new Map<string, { startsOn: Date; endsOn: Date }[]>();
  for (const l of leaveRows) {
    const list = leaveBy.get(l.technician_id) ?? [];
    list.push({ startsOn: new Date(l.starts_on), endsOn: new Date(l.ends_on) });
    leaveBy.set(l.technician_id, list);
  }

  let availableMinutes = 0;
  let workedMinutes = 0;
  let travelMinutes = 0;
  let leaveMinutesExcluded = 0;
  let labourVisitsTotal = 0;
  const byTechnician: TechnicianUtilisation[] = [];

  for (const t of techRows) {
    // A technician who joined inside the window is measured from the day they
    // joined. Charging them for the weeks before they existed reports a
    // recruiting business as an idle one.
    const joined = t.joined_on ? new Date(t.joined_on) : null;
    const from = joined && joined > windowStart ? joined : windowStart;

    let available = from < windowEnd ? workingMinutesBetween(from, windowEnd, calendar) : 0;

    for (const l of leaveBy.get(t.id) ?? []) {
      const start = l.startsOn > from ? l.startsOn : from;
      const end = l.endsOn < windowEnd ? l.endsOn : windowEnd;
      if (end <= start) continue;
      const off = workingMinutesBetween(start, end, calendar);
      available -= off;
      leaveMinutesExcluded += off;
    }
    if (available < 0) available = 0;

    const row = workedBy.get(t.id);
    const worked = Number(row?.worked ?? 0);
    const travel = Number(row?.travel ?? 0);
    const labourVisits = Number(row?.labour_visits ?? 0);

    availableMinutes += available;
    workedMinutes += worked;
    travelMinutes += travel;
    labourVisitsTotal += labourVisits;

    byTechnician.push({
      technicianId: t.id,
      name: t.full_name,
      availableMinutes: available,
      workedMinutes: worked,
      // Null on the same rule as the headline: no visit of theirs carries
      // labour, so nothing was measured. Zero here would name a specific person
      // as idle on the strength of a form nobody filled in.
      utilisationPercent:
        labourVisits > 0 && available > 0 ? Math.round((worked / available) * 100) : null,
    });
  }

  const cover = coverRows[0];
  const visitsOnCompletedJobs = Number(cover?.visits ?? 0);
  const visitsWithLabour = Number(cover?.with_labour ?? 0);

  /*
   * Null, not zero, and this is the whole point of the coverage pair.
   *
   * Nothing recorded means "not measured". Rendered as 0% it means "the
   * technicians did nothing", and those are opposite conclusions drawn from the
   * same absent data. The dashboard's standing rule is that an unmeasurable
   * figure is null; the one below is the same rule applied to a metric whose
   * source column has exactly one production writer.
   */
  const utilisationPercent =
    labourVisitsTotal > 0 && availableMinutes > 0
      ? Math.round((workedMinutes / availableMinutes) * 100)
      : null;

  byTechnician.sort((a, b) => b.workedMinutes - a.workedMinutes || a.name.localeCompare(b.name));

  return {
    windowDays,
    technicians: techRows.length,
    availableMinutes,
    workedMinutes,
    travelMinutes,
    utilisationPercent,
    visitsOnCompletedJobs,
    visitsWithLabour,
    labourCoveragePercent:
      visitsOnCompletedJobs > 0
        ? Math.round((visitsWithLabour / visitsOnCompletedJobs) * 100)
        : null,
    byTechnician: byTechnician.slice(0, rows),
    leaveMinutesExcluded,
  };
}

/**
 * `MD-3`, and expressly NOT `G11`. The reasoning is on `OutcomePosition` and in
 * the `DASHBOARD_GAPS` entry for first-time fix; both are worth reading before
 * anybody is tempted to rename this.
 *
 * Jobs are counted by `completed_at`, in Dubai. One row per job — `outcome_code`
 * is a single column on `jobs`, so this cannot double-count the way a join to a
 * per-visit table would.
 */
export async function outcomePosition(
  tx: TenantScopedTx,
  now: Date,
  options?: { windowDays?: number },
): Promise<OutcomePosition> {
  const windowDays = options?.windowDays ?? DASHBOARD_UTILISATION_WINDOW_DAYS;
  const from = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const to = now.toISOString();

  const [tallyRows, totalRows] = await Promise.all([
    tx.execute<{ code: string; label: string | null; requires_return: boolean; jobs: string }>(sql`
      select j.outcome_code                                   as code,
             o.label                                          as label,
             coalesce(o.requires_return_visit, false)         as requires_return,
             count(*)::text                                   as jobs
        from jobs j
        left join job_outcome_codes o
               on o.tenant_id = j.tenant_id and o.code = j.outcome_code
       where j.deleted_at is null
         and j.outcome_code is not null
         and j.completed_at is not null
         and j.completed_at >= ${from}::timestamptz
         and j.completed_at <  ${to}::timestamptz
       group by 1, 2, 3
       order by 4 desc, 1
    `) as unknown as Promise<
      { code: string; label: string | null; requires_return: boolean; jobs: string }[]
    >,

    tx.execute<{ completed: string; with_outcome: string }>(sql`
      select count(*)::text                                            as completed,
             count(*) filter (where j.outcome_code is not null)::text  as with_outcome
        from jobs j
       where j.deleted_at is null
         and j.completed_at is not null
         and j.completed_at >= ${from}::timestamptz
         and j.completed_at <  ${to}::timestamptz
    `) as unknown as Promise<{ completed: string; with_outcome: string }[]>,
  ]);

  const byOutcome: OutcomeTally[] = tallyRows.map((r) => ({
    code: r.code,
    // The code itself, never "Unknown": an outcome recorded before somebody
    // retired the vocabulary entry still has to render as what was recorded.
    label: r.label ?? r.code,
    requiresReturnVisit: r.requires_return,
    jobs: Number(r.jobs),
  }));

  const jobsCompleted = Number(totalRows[0]?.completed ?? 0);
  // Taken from the rows it heads, not from a second count(*) with its own WHERE
  // clause — the rule the rest of this file follows for the same reason.
  const outcomesRecorded = byOutcome.reduce((sum, o) => sum + o.jobs, 0);
  const returnVisitRequired = byOutcome
    .filter((o) => o.requiresReturnVisit)
    .reduce((sum, o) => sum + o.jobs, 0);

  return {
    windowDays,
    jobsCompleted,
    outcomesRecorded,
    outcomeCoveragePercent:
      jobsCompleted > 0 ? Math.round((outcomesRecorded / jobsCompleted) * 100) : null,
    returnVisitRequired,
    returnVisitRatePercent:
      outcomesRecorded > 0 ? Math.round((returnVisitRequired / outcomesRecorded) * 100) : null,
    byOutcome,
  };
}

// ── MD-5: retention ──────────────────────────────────────────────────────────

/**
 * Every customer, classified once.
 *
 * A shared fragment, like `REVENUE_SOURCE` and for the same reason: the counts
 * and the list are the SAME classification, so the card cannot show nine names
 * under a headline of seven. The counts are aggregates over this CTE and the
 * list is an ORDER BY and a LIMIT over it — never the other way round, which is
 * how a headline ends up being the length of a page.
 *
 * Dates are Dubai calendar dates throughout, taken from the anchor rather than
 * from current_date. The session timezone is not Asia/Dubai, so current_date is
 * the wrong day for about two hours of every twenty-four, and a threshold at
 * exactly 90 days flips on that boundary.
 */
function retentionSource(nowIso: string, quietDays: number, lapsedDays: number): SQL {
  return sql`
    anchor as (
      select (${nowIso}::timestamptz at time zone 'Asia/Dubai')::date as today_dubai
    ),
    scored as (
      select c.id,
             c.code,
             c.name,
             a.today_dubai,
             greatest(
               (select max((j.created_at at time zone 'Asia/Dubai')::date)
                  from jobs j
                 where j.customer_id = c.id and j.deleted_at is null),
               (select max((i.issued_on at time zone 'Asia/Dubai')::date)
                  from invoices i
                 where i.customer_id = c.id and i.deleted_at is null
                   and i.status <> 'draft' and i.issued_on is not null)
             ) as last_active_on,
             exists (
               select 1 from contracts k
                where k.customer_id = c.id and k.deleted_at is null
                  and k.status = 'active'
                  and (k.ends_on at time zone 'Asia/Dubai')::date >= a.today_dubai
             ) as has_active_contract,
             (select max((k.ends_on at time zone 'Asia/Dubai')::date)
                from contracts k
               where k.customer_id = c.id and k.deleted_at is null
                 and k.status in ('active', 'suspended', 'expired', 'cancelled')
                 and (k.ends_on at time zone 'Asia/Dubai')::date < a.today_dubai
             ) as contract_ended_on,
             (
               coalesce((select sum((i.taxable_amount * 100)::bigint)
                           from invoices i
                          where i.customer_id = c.id and i.deleted_at is null
                            and i.status <> 'draft' and i.issued_on is not null
                            and (i.issued_on at time zone 'Asia/Dubai')::date > a.today_dubai - 365), 0)
             - coalesce((select sum((n.taxable_amount * 100)::bigint)
                           from credit_notes n
                          where n.customer_id = c.id and n.deleted_at is null
                            and n.issued_on is not null
                            and (n.issued_on at time zone 'Asia/Dubai')::date > a.today_dubai - 365), 0)
             ) as revenue_minor
        from customers c
       cross join anchor a
       where c.deleted_at is null
    ),
    classified as (
      select s.*,
             (s.today_dubai - s.last_active_on) as days_quiet,
             (not s.has_active_contract
              and s.contract_ended_on is not null
              and (s.today_dubai - s.contract_ended_on) <= ${lapsedDays}) as contract_recently_lapsed,
             case
               when s.last_active_on is null then 'never_active'
               when s.has_active_contract    then 'retained'
               when (s.today_dubai - s.last_active_on) >= ${lapsedDays} then 'lapsed'
               when s.contract_ended_on is not null
                    and (s.today_dubai - s.contract_ended_on) <= ${lapsedDays} then 'at_risk'
               when (s.today_dubai - s.last_active_on) >= ${quietDays} then 'at_risk'
               else 'retained'
             end as state
        from scored s
    )`;
}

/**
 * `MD-5`: who is going quiet, and who has already gone.
 *
 * The definitions — activity, retained, at risk, lapsed, never active — are
 * written out on `RetentionPosition`, because a metric whose definition is not
 * written beside the code is one that gets redefined by accident six months
 * later by somebody reading the SQL and guessing.
 */
export async function retentionPosition(
  tx: TenantScopedTx,
  now: Date,
  options?: { quietAfterDays?: number; lapsedAfterDays?: number; rows?: number },
): Promise<RetentionPosition> {
  const quietAfterDays = options?.quietAfterDays ?? CUSTOMER_QUIET_AFTER_DAYS;
  const lapsedAfterDays = options?.lapsedAfterDays ?? CUSTOMER_LAPSED_AFTER_DAYS;
  const rows = options?.rows ?? DASHBOARD_AT_RISK_ROWS;
  const iso = now.toISOString();

  const [countRows, listRows] = await Promise.all([
    tx.execute<{
      ever_active: string;
      retained: string;
      at_risk: string;
      lapsed: string;
      never_active: string;
      currency: string | null;
    }>(sql`
      with ${retentionSource(iso, quietAfterDays, lapsedAfterDays)}
      select count(*) filter (where state <> 'never_active')::text as ever_active,
             count(*) filter (where state = 'retained')::text      as retained,
             count(*) filter (where state = 'at_risk')::text       as at_risk,
             count(*) filter (where state = 'lapsed')::text        as lapsed,
             count(*) filter (where state = 'never_active')::text  as never_active,
             (select currency from customers where deleted_at is null limit 1) as currency
        from classified
    `) as unknown as Promise<{
      ever_active: string;
      retained: string;
      at_risk: string;
      lapsed: string;
      never_active: string;
      currency: string | null;
    }[]>,

    tx.execute<{
      id: string;
      code: string;
      name: string;
      state: string;
      contract_recently_lapsed: boolean;
      last_active_on: string | null;
      days_quiet: number | null;
      revenue_minor: string;
    }>(sql`
      with ${retentionSource(iso, quietAfterDays, lapsedAfterDays)}
      select id, code, name, state, contract_recently_lapsed,
             to_char(last_active_on, 'YYYY-MM-DD') as last_active_on,
             days_quiet,
             revenue_minor::text                   as revenue_minor
        from classified
       where state in ('at_risk', 'lapsed')
       order by revenue_minor desc, days_quiet desc nulls last, name
       limit ${rows}
    `) as unknown as Promise<{
      id: string;
      code: string;
      name: string;
      state: string;
      contract_recently_lapsed: boolean;
      last_active_on: string | null;
      days_quiet: number | null;
      revenue_minor: string;
    }[]>,
  ]);

  const c = countRows[0];
  const everActive = Number(c?.ever_active ?? 0);
  const lapsed = Number(c?.lapsed ?? 0);

  return {
    everActive,
    retained: Number(c?.retained ?? 0),
    atRisk: Number(c?.at_risk ?? 0),
    lapsed,
    neverActive: Number(c?.never_active ?? 0),
    churnRatePercent: everActive > 0 ? Math.round((lapsed / everActive) * 100) : null,
    customers: listRows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      state: r.state === "lapsed" ? "lapsed" : "at_risk",
      // A contract that ran out is the more actionable of the two reasons and
      // the one somebody can still do something about, so it wins the label
      // wherever both are true.
      reason: r.contract_recently_lapsed ? "contract_lapsed" : "gone_quiet",
      lastActiveOn: r.last_active_on,
      daysQuiet: r.days_quiet === null ? null : Number(r.days_quiet),
      revenueMinor: Number(r.revenue_minor),
    })),
    quietAfterDays,
    lapsedAfterDays,
    currency: c?.currency ?? "AED",
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
  /*
   * ── THE CAP THAT LOOKED LIKE A PLATEAU ──────────────────────────────────
   *
   * The dispatch board is the source of truth for what is open, so the
   * dashboard cannot disagree with the board about how many jobs there are.
   * That intent was right and the implementation was not: this read
   * `listDispatchBoard(tx, { now, limit: 1000 })` and filtered the array, so
   * every figure below — the open count, the unassigned count, the jobs
   * breaching now, and each per-priority row — was a total of the first
   * thousand open jobs rather than of the tenant's.
   *
   * At the PRD's stated volume, 5,000 jobs a year (§9), those numbers would
   * have climbed to exactly 1000 and stopped. Nothing on the screen would have
   * looked truncated; it would have looked like a plateau, which is the one
   * shape of wrong number nobody investigates. This is the same `LEAD-8` trap
   * the board's own header hit, and the fix is the same: agreeing with the
   * board means asking the same question of the same table, not reading its
   * rows. Both counters below are Postgres aggregates over every matching row,
   * and they are the board's own, so the two screens now agree by
   * construction rather than by coincidence.
   */
  const [counts, byPriority] = await Promise.all([
    dispatchBoardCounts(tx, now),
    dispatchBoardCountsByPriority(tx, now),
  ]);

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
    openJobs: counts.open,
    byPriority,
    unassigned: counts.unassigned,
    breachingNow: counts.breached,
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

  /*
   * G12 — PPM completion, read from `ppmCompliance` rather than recomputed.
   *
   * This was `DASHBOARD_GAPS`' PPM entry, blocked on "nothing generates or
   * completes `contract_visits` rows". CON-4 and CON-5 landed, so it is a
   * measurement now.
   *
   * ── SUMMED, NOT AVERAGED ────────────────────────────────────────────────
   *
   * The totals are summed across contracts and the percentage taken once at
   * the end. Averaging the per-contract percentages would weight a contract
   * with one visit due equally with one carrying fifty, so a single tiny
   * contract at 0% could drag a tenant meeting its obligations on 200 visits
   * below the target — and the number an OA management company asks for at
   * renewal is "of the visits you owed us, how many happened", which is the
   * summed one.
   *
   * The denominator is `completed + overdue`, which is what `ppmCompletion`
   * uses and why the arithmetic is borrowed from it rather than written again:
   * a visit whose window has not closed cannot have been missed, and counting
   * it would make every contract in its first month look like a failing one.
   */
  const ppm = await ppmCompliance(tx);
  const ppmVisitsCompleted = ppm.reduce((n, c) => n + c.completed, 0);
  const ppmVisitsDue = ppmVisitsCompleted + ppm.reduce((n, c) => n + c.overdue, 0);
  const ppmCompletionPercent =
    ppmVisitsDue === 0
      ? null
      : ppmCompletion({
          scheduled: ppm.reduce((n, c) => n + c.scheduled, 0),
          completed: ppmVisitsCompleted,
          overdue: ppmVisitsDue - ppmVisitsCompleted,
        }).percent;

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
    ppmCompletionPercent,
    ppmVerdict: gradeGoal(ppmCompletionPercent, DASHBOARD_GOALS["ppmCompletion"]!),
    ppmVisitsDue,
    ppmVisitsCompleted,
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
  now: Date,
): Promise<CompliancePosition> {
  // The dashboard's own `now` is a `Date` (it drives revenue-period and
  // other instant-valued arithmetic too); the expiry sweeps below want
  // Dubai's calendar day, not `current_date`, so it is converted once here
  // rather than letting each sweep fall back to its own `today()` default.
  // `dubaiDateKey` is what `today()` itself calls — same conversion, already
  // imported in this file.
  const day = dubaiDateKey(now);
  const [summary, blocks, documents, accreditations, certifications] = await Promise.all([
    workforceSummary(tx),
    blockedTechnicians(tx, day),
    findExpiringEmployeeDocuments(tx, horizonDays, day),
    findExpiringAccreditations(tx, horizonDays, day),
    findExpiringCertifications(tx, horizonDays, day),
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
 * Open roles and days-to-hire (`KPI-3`, G13).
 *
 * This was `DASHBOARD_GAPS[0]` — "no requisition or application table exists in
 * this branch" — while `0014_recruitment` had already created both, three
 * migrations earlier in the same tree.
 *
 * ── THE TWO TIMESTAMPS G13 IS BOUNDED BY ────────────────────────────────────
 *
 * PRD §7.1 states G13 as "application received → offer accepted, median under
 * 14 days". Precisely:
 *
 *   START  `applications.applied_at` — stamped by the row's own default when
 *          the application is inserted, by the careers-site path and the staff
 *          path alike. Not `created_at`: they are the same instant today, and
 *          `applied_at` is the one that means "the applicant applied" rather
 *          than "a row was written", which is what survives a backfill.
 *
 *   END    `application_events.occurred_at` where `event_type = 'hired'` — the
 *          row `hireCandidate` writes in the same transaction as the conversion
 *          to a technician. That transaction IS the offer being accepted:
 *          nothing creates an employment record on a maybe.
 *
 * The end stamp is a join because `applications` carries no `hired_at` column
 * and this file does not get to add one — a column added by a migration without
 * a matching declaration in `schema/recruitment.ts` is a column the next
 * generated diff proposes dropping.
 *
 * Two nearby columns were rejected. `updated_at` moves on any later edit, so a
 * corrected phone number would rewrite history. `outcome_sent_at` is set to the
 * same instant by `hireCandidate`, but it means "we told them", and reusing a
 * notification stamp as a hire date is the kind of proxy that survives until
 * somebody re-sends an outcome.
 *
 * Its one failure mode, stated rather than hidden: a hire performed by a
 * hand-written `UPDATE applications SET status = 'hired'` writes no activity
 * row and is not counted. That is detectable rather than silent — 0018's
 * trigger emits `ats_application_closed` from the table itself, so a
 * discrepancy between that count and `hiresInWindow` is exactly the sign of one.
 *
 * ── DATES ARE BOUNDED IN SQL, IN Asia/Dubai ─────────────────────────────────
 *
 * Both endpoints are converted to local dates before subtracting, so "applied
 * Sunday, hired Wednesday" is three days regardless of where the database runs.
 * Nothing here computes a boundary in JavaScript.
 */
async function hiringPosition(tx: TenantScopedTx, now: Date): Promise<HiringPosition> {
  const windowDays = DASHBOARD_HIRING_WINDOW_DAYS;

  /*
   * Requisitions come from `listRequisitions`, not from a second `count(*)`.
   *
   * The rule at the top of this file: the dashboard and the recruitment board
   * must agree about how many roles are open, and the only way to guarantee
   * that is for both to read the same function. A parallel aggregate here that
   * filtered `deleted_at` slightly differently would produce two defensible
   * numbers and destroy trust in the pair.
   */
  const requisitions = await listRequisitions(tx, { includeClosed: true });

  /*
   * `closesAt` is compared against `now` in JavaScript, and that is not the
   * boundary arithmetic this file computes in SQL. A closing date is an instant
   * against an instant — there is no calendar bucket, no month edge and no
   * timezone question in it. The SQL rule exists for `date_trunc` over a local
   * month, where doing it here would move an invoice issued at 02:00 on the 1st
   * into the previous month.
   */
  const live = requisitions.filter(
    (r) => r.status === "open" && (r.closesAt === null || r.closesAt.getTime() >= now.getTime()),
  );

  const openIds = live.map((r) => r.id);

  const rows = (await tx.execute<{
    live_applications: string;
    hires: string;
    median_days: string | null;
  }>(sql`
    with open_reqs as (
      -- The open set, passed in from the list this card's count is taken from,
      -- so the two cannot drift. An empty array yields an empty set, which is
      -- the correct answer and not a special case.
      select value::uuid as id
        from jsonb_array_elements_text(${JSON.stringify(openIds)}::jsonb) as t(value)
    ),
    hires as (
      select ((h.hired_at at time zone 'Asia/Dubai')::date
              - (a.applied_at at time zone 'Asia/Dubai')::date) as days_to_hire
        from applications a
        -- The earliest hire stamp, because an application that was reopened and
        -- hired again should measure from the first offer accepted, not the
        -- second. LATERAL rather than a grouped join so a missing activity row
        -- drops the application rather than contributing a null to the median.
        join lateral (
          select min(ev.occurred_at) as hired_at
            from application_events ev
           where ev.application_id = a.id
             and ev.event_type = 'hired'
        ) h on h.hired_at is not null
       where a.deleted_at is null
         and a.status = 'hired'
         and h.hired_at >= ${now.toISOString()}::timestamptz - make_interval(days => ${windowDays})
         and h.hired_at <= ${now.toISOString()}::timestamptz
    )
    select
      (select count(*)::text from applications a
        where a.deleted_at is null
          and a.status = 'active'
          and a.requisition_id in (select id from open_reqs)) as live_applications,
      (select count(*)::text from hires) as hires,
      (select percentile_cont(0.5) within group (order by days_to_hire)::text
         from hires) as median_days
  `)) as unknown as {
    live_applications: string;
    hires: string;
    median_days: string | null;
  }[];

  const r = rows[0];
  const median = r?.median_days;

  /*
   * Null, not zero, when nobody was hired in the window.
   *
   * The same rule DSO and conversion follow, and it bites harder here: a
   * days-to-hire of 0 reads as "we hire the same day", which is the most
   * flattering number this card could show and is produced by hiring nobody.
   */
  const medianDaysToHire =
    median === null || median === undefined ? null : Math.round(Number(median));

  return {
    openRoles: live.length,
    openHeadcount: live.reduce((n, req) => n + req.headcount, 0),
    awaitingApproval: requisitions.filter((req) => req.status === "pending_approval").length,
    requisitionsRecorded: requisitions.length,
    liveApplications: Number(r?.live_applications ?? 0),
    hiresInWindow: Number(r?.hires ?? 0),
    medianDaysToHire,
    daysToHireVerdict: gradeGoal(medianDaysToHire, DASHBOARD_GOALS["daysToHire"]!),
    windowDays,
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
  tax: CorporateTaxPack;
}): readonly Attention[] {
  const items: Attention[] = [];
  const { cash, revenue, work, contracts, compliance, billing, tax } = input;

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

  /*
   * Three states, and the order matters.
   *
   * `disqualified` goes first because it is the one this period's own figure
   * cannot show. A business that crossed AED 3m in a previous period is under
   * the line this year, sees a green meter, and elects a relief it lost for
   * good — so the disqualification has to outrank a reassuring current number
   * rather than sit behind it.
   */
  if (tax.current?.standing === "disqualified") {
    items.push({
      severity: "critical",
      headline: `Small Business Relief was permanently lost in ${tax.current.disqualifyingPeriod}`,
      detail:
        "This period's revenue is under AED 3,000,000, and it does not restore the relief — one " +
        "breach disqualifies every later period. Do not elect it in the return without confirming " +
        "the earlier period with your accountant.",
      href: "/reports/tax",
    });
  } else if (revenue.relief.state === "breached") {
    items.push({
      severity: "critical",
      headline: "Revenue has passed the AED 3,000,000 Small Business Relief line",
      detail:
        "The relief is lost for this period and permanently for every later one. Confirm the figure " +
        "with the accountant before acting on it — it is computed from issued invoices net of credit notes.",
      href: "/reports/tax",
    });
  } else if (revenue.relief.state === "approaching") {
    items.push({
      severity: "warning",
      headline: "Approaching the AED 3,000,000 Small Business Relief line",
      detail:
        "Crossing it once permanently ends the relief for all later periods. There is still time to " +
        "decide deliberately rather than discover it in the return.",
      href: "/reports/tax",
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
      // `/amc`, not `/customers`. This link was written before the contracts
      // stream shipped a screen, and pointed at the customer list because that
      // was the closest thing that existed. It now sends the reader one click
      // short of the record the item is about.
      href: "/amc",
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
 * How far back one record's reconstruction reaches.
 *
 * Named rather than inline because the screen has to say which 200 it showed:
 * a cap the reader cannot see is the silent truncation `LEAD-8` and §12.1 both
 * forbid.
 */
export const RECORD_HISTORY_LIMIT = 200;

/**
 * A raw `audit_log` row, as `tx.execute` actually hands it back.
 *
 * `occurred_at` is typed `string` deliberately. The type parameter on
 * `execute` is an assertion rather than a check, and postgres-js returns a
 * space-separated timestamp string — so declaring `Date` there compiles and
 * then throws at the first `.getTime()`. It is converted once, in
 * `toAuditEntry`, through the coercion in `_rows.ts`.
 *
 * An alias rather than an `interface`, and it has to be: `tx.execute<T>`
 * constrains `T` to `Record<string, unknown>`, which an object type satisfies
 * implicitly and an interface does not.
 */
type AuditRow = {
  id: string;
  table_name: string;
  record_id: string | null;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_kind: string;
  occurred_at: string;
  ip_address: string | null;
  request_id: string | null;
  changed_fields: Record<string, unknown> | null;
};

/**
 * The projection both audit readers use.
 *
 * Shared so that the feed and one record's history cannot drift into
 * disagreeing about the same row — an audit screen where the reconstruction
 * shows a different actor from the list it was opened from is worse than
 * either screen alone.
 */
const AUDIT_SELECT = sql`
  select a.id, a.table_name, a.record_id, a.action, a.actor_id,
         u.full_name as actor_name,
         a.actor_kind, a.occurred_at, a.ip_address, a.request_id, a.changed_fields
    from audit_log a
    -- LEFT, and it matters. The actor may have been deleted, and an audit
    -- entry that disappears because the person who made it left the company
    -- is the one entry an auditor most wants.
    left join users u on u.id = a.actor_id
`;

function toAuditEntry(r: AuditRow): AuditEntry {
  return {
    id: r.id,
    tableName: r.table_name,
    recordId: r.record_id,
    action: r.action as AuditEntry["action"],
    actorId: r.actor_id,
    actorName: r.actor_name,
    actorKind: r.actor_kind,
    occurredAt: requiredRowDate(r.occurred_at),
    ipAddress: r.ip_address,
    requestId: r.request_id,
    changedFields: r.changed_fields,
  };
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

  const rows = (await tx.execute<AuditRow>(sql`
    ${AUDIT_SELECT}
     where ${where}
     order by a.occurred_at desc, a.id desc
     limit ${limit} offset ${offset}
  `)) as unknown as AuditRow[];

  const countRows = (await tx.execute<{ total: string }>(sql`
    select count(*)::text as total
      from audit_log a
     where ${where}
  `)) as unknown as { total: string }[];

  return {
    entries: rows.map(toAuditEntry),
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
 * One record's history, oldest first (`ADM-7`).
 *
 * `ADM-7`'s actual requirement is "able to reconstruct any record's history",
 * which is a different query from the filtered list: it is ordered forwards,
 * because reconstruction means replaying the changes in the order they
 * happened, and it starts at the beginning rather than paginating from the
 * newest end.
 *
 * ── WHY IT READS FORWARDS RATHER THAN REVERSING THE FEED ────────────────────
 *
 * This was `auditTrail(...).reverse()`, which is the same rows only while a
 * record has fewer than `RECORD_HISTORY_LIMIT` of them. Past that the feed
 * hands back the *newest* 200 and reversing them produces a history with no
 * beginning — and the beginning is the load-bearing entry: the insert carries
 * the whole row under `__new`, which is the state every later diff is replayed
 * onto. A reconstruction missing its first entry cannot be performed at all,
 * so the truncation has to happen at the recent end, where the feed can still
 * reach what was cut.
 *
 * ── WHAT THE LOG CANNOT TELL YOU ────────────────────────────────────────────
 *
 * `occurred_at` is `now()`, which in Postgres is the *transaction* timestamp.
 * Two changes written by one transaction therefore share it exactly, and the
 * table has no sequence to break the tie — the id is a random uuid. Their
 * relative order is not recorded, and this function does not invent one. The
 * viewer says so rather than implying a sequence the evidence does not have.
 *
 * Returns an empty array for a record with nothing logged. That is a real
 * answer — the record predates the trigger, or its table is not audited — and
 * the caller renders it as the gap it is rather than as an error.
 */
export async function recordHistory(
  tx: TenantScopedTx,
  input: { tableName: string; recordId: string },
): Promise<readonly AuditEntry[]> {
  // Bound parameters, like the feed. `tableName` arrives from a query string.
  // Tenant scoping is the RLS policy on audit_log, the same one the feed
  // relies on; there is no tenant predicate here to get wrong.
  const rows = (await tx.execute<AuditRow>(sql`
    ${AUDIT_SELECT}
     where a.table_name = ${input.tableName}::text
       and a.record_id = ${input.recordId}::uuid
     order by a.occurred_at asc, a.id asc
     limit ${RECORD_HISTORY_LIMIT}
  `)) as unknown as AuditRow[];

  return rows.map(toAuditEntry);
}

// ═══════════════════════════════════════════════════════════════════════════
// INV-17 — the corporate tax support pack
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Revenue by tax period, against the AED 3,000,000 Small Business Relief line.
 *
 * ── WHY THIS IS NOT THE DASHBOARD METER AGAIN ───────────────────────────────
 *
 * The owner dashboard already measures this year's revenue against AED 3m. It
 * is the right thing on that screen and it is not `INV-17`, for one reason: the
 * relief is lost **permanently** by a single breach, and a single-period view
 * cannot see a breach that happened in a previous period. A business that
 * crossed the line in 2026 sees a green meter every January afterwards, files a
 * return electing relief it is not entitled to, and finds out from the FTA.
 *
 * So the pack reads every period on record, in order, and carries the breach
 * forward — `taxPeriodPositions` in `@meridian/core` does the carrying. That is
 * the whole requirement: the number was never the hard part.
 *
 * ── THE PERIOD ──────────────────────────────────────────────────────────────
 *
 * The Gregorian calendar year, in `Asia/Dubai`, which is the default corporate
 * tax period and the one this business uses. A financial year ending on any
 * other date is a real possibility for a UAE company and is **not** supported
 * here: it would need a configured year-end, and configuring one that nobody
 * has been asked for would put a wrong period boundary in front of the reader
 * with no way to tell. `startsOn` and `endsOn` travel on every row so the
 * assumption is visible in the output rather than buried in this comment.
 *
 * Every boundary below — the period start, the period end, whether the period
 * is complete, how much of it has elapsed — is computed in SQL against
 * `at time zone 'Asia/Dubai'`. None of it is done in JavaScript. An invoice
 * issued at 02:00 Dubai on 1 January is dated 31 December in UTC, and a
 * period boundary computed on the server's clock would put that revenue in the
 * previous period — misstating a threshold whose breach cannot be undone.
 */
export async function corporateTaxPack(
  tx: TenantScopedTx,
  options?: { now?: Date },
): Promise<CorporateTaxPack> {
  const now = options?.now ?? new Date();

  type Row = {
    period: string;
    starts_on: string;
    ends_on: string;
    invoiced_minor: string;
    credited_minor: string;
    revenue_minor: string;
    invoices: string;
    credit_notes: string;
    complete: string;
    elapsed_days: string;
    total_days: string;
    is_current: string;
    currency: string | null;
  };

  const rows = (await tx.execute<Row>(sql`
    with ${REVENUE_SOURCE},
    anchor as (
      select (${now.toISOString()}::timestamptz at time zone 'Asia/Dubai') as local_now
    ),
    current_period as (
      select date_trunc('year', local_now) as current_start from anchor
    ),
    -- One row per document, tagged with the period it falls in. A union rather
    -- than two joined aggregates: a full outer join between invoices-by-year
    -- and credits-by-year drops a year that has credits and no invoices, which
    -- is exactly the year somebody would want an explanation for.
    movements as (
      select date_trunc('year', issued_local) as period_start,
             taxable_minor                    as invoiced_minor,
             0::bigint                        as credited_minor,
             1                                as invoice_count,
             0                                as credit_count
        from inv
      union all
      select date_trunc('year', issued_local),
             0::bigint,
             taxable_minor,
             0,
             1
        from crn
    ),
    span as (
      select min(period_start) as first_start, max(period_start) as last_start from movements
    ),
    -- Generated rather than taken from the movements, so a period with no
    -- documents at all still appears with a revenue of zero. A missing row
    -- reads as "no data" and a zero row reads as "no revenue", and for a
    -- threshold report those are different statements.
    period_list as (
      select generate_series(
               least(
                 coalesce((select first_start from span), (select current_start from current_period)),
                 (select current_start from current_period)
               ),
               greatest(
                 coalesce((select last_start from span), (select current_start from current_period)),
                 (select current_start from current_period)
               ),
               interval '1 year'
             ) as period_start
    )
    select
      to_char(p.period_start, 'YYYY')                                                as period,
      to_char(p.period_start, 'YYYY-MM-DD')                                          as starts_on,
      to_char(p.period_start + interval '1 year' - interval '1 day', 'YYYY-MM-DD')   as ends_on,
      coalesce(sum(m.invoiced_minor), 0)::text                                       as invoiced_minor,
      coalesce(sum(m.credited_minor), 0)::text                                       as credited_minor,
      (coalesce(sum(m.invoiced_minor), 0) - coalesce(sum(m.credited_minor), 0))::text as revenue_minor,
      coalesce(sum(m.invoice_count), 0)::text                                        as invoices,
      coalesce(sum(m.credit_count), 0)::text                                         as credit_notes,
      ((select local_now from anchor) >= p.period_start + interval '1 year')::text   as complete,
      greatest(0, least(
        extract(day from ((select local_now from anchor) - p.period_start))::int + 1,
        extract(day from ((p.period_start + interval '1 year') - p.period_start))::int
      ))::text                                                                       as elapsed_days,
      extract(day from ((p.period_start + interval '1 year') - p.period_start))::int::text as total_days,
      -- Which period "now" falls in, decided in SQL against the same
      -- Asia/Dubai conversion as every other boundary here. Resolving it in
      -- JavaScript would reintroduce exactly the timezone offset the rest of
      -- this query exists to avoid, on the one row the reader acts on.
      (p.period_start = (select current_start from current_period))::text             as is_current,
      (select currency from inv limit 1)                                              as currency
      from period_list p
      left join movements m on m.period_start = p.period_start
     group by p.period_start
     order by p.period_start
  `)) as unknown as Row[];

  const periods: TaxPeriodRevenue[] = rows.map((r) => ({
    period: r.period,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    // Number(), never ::int in SQL. A year's taxable amount in fils is a
    // nine-figure number and a business that has been running a decade would
    // overflow int4 in the sum, mid-query, for no reason.
    invoicedMinor: Number(r.invoiced_minor),
    creditedMinor: Number(r.credited_minor),
    revenueMinor: Number(r.revenue_minor),
    invoices: Number(r.invoices),
    creditNotes: Number(r.credit_notes),
    complete: r.complete === "true",
    elapsedDays: Number(r.elapsed_days),
    totalDays: Number(r.total_days),
  }));

  const positions = taxPeriodPositions(periods);

  // The current period is the one SQL flagged, never the last element of the
  // list: a future-dated invoice puts a later period on the end, and `at(-1)`
  // would then report next year's figure as this year's.
  const currentPeriodLabel = rows.find((r) => r.is_current === "true")?.period ?? null;
  const current = positions.find((p) => p.period.period === currentPeriodLabel) ?? null;

  return {
    periods: positions,
    current,
    reliefPermanentlyLost: positions.some((p) => p.relief.state === "breached"),
    currency: rows[0]?.currency ?? "AED",
    measuredAt: now,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// INV-16 — the accounting export
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How many rows one round trip to the database fetches.
 *
 * Not a page size. Nothing outside this file sees it, no caller can change it,
 * and the loop that uses it does not stop until the query returns a short
 * batch. It exists so a ten-year export does not build one enormous result set
 * in the driver, and for no other reason.
 */
const EXPORT_BATCH = 500;

/**
 * The point at which a batching loop is assumed to be broken.
 *
 * One million rows. A maintenance contractor does not issue a million invoices
 * a decade, so reaching this means the cursor stopped advancing — and the right
 * response to that is to fail loudly. **Never** to return what has been
 * collected so far: a partial accounting export that looks complete is the
 * exact failure this whole module is written to prevent, and a thrown error is
 * the only outcome an operator cannot mistake for a quiet month.
 */
const EXPORT_MAX_BATCHES = 2_000;

/** A keyset position: the last row's sort value and id. */
interface ExportCursor {
  readonly sort: string;
  readonly id: string;
}

/**
 * Every row a query matches, fetched in batches.
 *
 * ── WHY THIS IS NOT `.limit(500)` ───────────────────────────────────────────
 *
 * Because five separate places in this repository have shipped a capped list
 * being read as a complete one, and an accounting export is the worst place for
 * the sixth. The loop below has no row limit: it asks for `EXPORT_BATCH + 0`
 * rows, and it stops when the database returns fewer than it asked for, which
 * is the only condition that means "there are no more". Every caller counts
 * what it received and the count is written into the file, so a file that is
 * short is visibly short.
 *
 * Keyset rather than `offset`, on `(sort, id)` where `id` is unique — so the
 * comparison is strict, progress is guaranteed, and a row inserted by another
 * session mid-export cannot cause a row to be skipped or repeated the way a
 * shifting `offset` does.
 */
async function* exportRows<T extends { cursor_sort: string; cursor_id: string }>(
  tx: TenantScopedTx,
  build: (after: ExportCursor | null, limit: number) => SQL,
): AsyncGenerator<T> {
  let after: ExportCursor | null = null;

  for (let batch = 0; ; batch++) {
    if (batch >= EXPORT_MAX_BATCHES) {
      throw new Error(
        `Accounting export did not terminate after ${EXPORT_MAX_BATCHES} batches. ` +
          `Refusing to return a partial set of books.`,
      );
    }

    const rows = (await tx.execute<T>(build(after, EXPORT_BATCH))) as unknown as T[];
    for (const row of rows) yield row;
    if (rows.length < EXPORT_BATCH) return;

    const last = rows[rows.length - 1]!;
    after = { sort: last.cursor_sort, id: last.cursor_id };
  }
}

/** The keyset predicate, or nothing on the first batch. */
function afterCursor(after: ExportCursor | null, sortExpression: SQL): SQL {
  if (!after) return sql``;
  return sql`and (${sortExpression}, cursor_source.id) > (${after.sort}::timestamp, ${after.id}::uuid)`;
}

/** A VAT rate in basis points, as a percentage string. Integer arithmetic. */
function vatRatePercent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = basisPoints % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

export const ACCOUNTING_EXPORT_DATASETS = [
  "invoices",
  "credit_notes",
  "payments",
  "receivables",
  "journal",
] as const;

export type AccountingDataset = (typeof ACCOUNTING_EXPORT_DATASETS)[number];

export function isAccountingDataset(value: string): value is AccountingDataset {
  return (ACCOUNTING_EXPORT_DATASETS as readonly string[]).includes(value);
}

export interface AccountingExport {
  /** Inclusive, `YYYY-MM-DD`, Asia/Dubai. */
  readonly from: string;
  readonly to: string;
  readonly generatedAt: Date;
  readonly currency: string;
  readonly tables: Readonly<Record<AccountingDataset, ExportTable>>;
  /**
   * Debits against credits over the whole journal. An accounting package
   * rejects an unbalanced journal outright, so this is checked here rather than
   * discovered on import.
   */
  readonly journalBalance: ReturnType<typeof journalTotals>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The accounting export (`INV-16`, closing `MB-017`).
 *
 * Five tables: the invoices issued in the range, the credit notes issued in it,
 * the payments received in it, the receivables outstanding **now**, and a
 * double-entry general journal covering the first three.
 *
 * ── "IN CSV AND IN A FORMAT THE ACCOUNTANT CAN IMPORT" ──────────────────────
 *
 * Both are CSV, and they are not the same thing. The first four tables are
 * listings — one row per document, every field the document carries, which is
 * what somebody checks a figure against. The journal is the import: one row per
 * posting, account code and name, debit and credit in separate columns, which
 * is the shape Xero, QuickBooks Online, Zoho Books and Tally all accept. A
 * listing cannot be imported into a ledger and a journal cannot be reconciled
 * against a document, so the requirement asks for both and this produces both.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * PRD §6.2: *this system feeds an accountant; it does not replace one.* There
 * is no trial balance, no P&L, no expense side and no bank reconciliation — the
 * journal covers sales, VAT and receipts, because those are the transactions
 * this system is the system of record for. Everything else belongs to the
 * accountant, and exporting a half-populated trial balance would invite it to
 * be trusted as a complete one.
 *
 * ── THE RANGE, AND THE ONE TABLE IT DOES NOT APPLY TO ───────────────────────
 *
 * `receivables` is the position **as at now**, not as at `to`. Reconstructing
 * an as-at-a-past-date AR balance would need the payment history replayed
 * against each invoice, and while `payments` carries the dates to do it, the
 * write-off and credited statuses do not — so the honest answer is today's
 * balance, labelled today's balance. The table's title carries the date.
 */
export async function accountingExport(
  tx: TenantScopedTx,
  options: { from: string; to: string; now?: Date },
): Promise<AccountingExport> {
  const now = options.now ?? new Date();
  const { from, to } = options;

  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new UserFacingError("Give the export range as two dates, each YYYY-MM-DD.");
  }
  if (from > to) {
    throw new UserFacingError("The export range starts after it ends.");
  }

  const journal: JournalLine[] = [];

  // ── Invoices ──────────────────────────────────────────────────────────────

  type InvoiceRowOut = {
    cursor_sort: string;
    cursor_id: string;
    reference: string;
    document_type: string;
    status: string;
    issue_date: string;
    supply_date: string | null;
    due_date: string | null;
    customer_code: string | null;
    customer_name: string;
    customer_trn: string | null;
    currency: string;
    subtotal_minor: string;
    discount_minor: string;
    taxable_minor: string;
    tax_rate_basis_points: string;
    tax_minor: string;
    total_minor: string;
    paid_minor: string;
    credited_minor: string;
    tax_category_code: string;
    buyer_reference: string | null;
    purchase_order_reference: string | null;
    job_reference: string | null;
    contract_reference: string | null;
  };

  const invoiceSort = sql`(cursor_source.issued_on at time zone 'Asia/Dubai')`;

  const invoiceRows: (readonly CsvValue[])[] = [];
  for await (const r of exportRows<InvoiceRowOut>(tx, (after, limit) => sql`
    select
      to_char(cursor_source.issued_on at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI:SS.US') as cursor_sort,
      cursor_source.id::text                                       as cursor_id,
      cursor_source.reference,
      cursor_source.document_type,
      cursor_source.status::text                                   as status,
      to_char(cursor_source.issued_on at time zone 'Asia/Dubai', 'YYYY-MM-DD') as issue_date,
      to_char(cursor_source.supply_date, 'YYYY-MM-DD')             as supply_date,
      to_char(cursor_source.due_on at time zone 'Asia/Dubai', 'YYYY-MM-DD')    as due_date,
      cu.code                                                      as customer_code,
      cu.name                                                      as customer_name,
      cu.trn                                                       as customer_trn,
      cursor_source.currency,
      (cursor_source.subtotal * 100)::bigint::text                 as subtotal_minor,
      (cursor_source.discount_amount * 100)::bigint::text          as discount_minor,
      (cursor_source.taxable_amount * 100)::bigint::text           as taxable_minor,
      cursor_source.tax_rate_basis_points::text                    as tax_rate_basis_points,
      (cursor_source.tax_amount * 100)::bigint::text               as tax_minor,
      (cursor_source.total * 100)::bigint::text                    as total_minor,
      (cursor_source.amount_paid * 100)::bigint::text              as paid_minor,
      coalesce(cn.credited, 0)::text                               as credited_minor,
      cursor_source.tax_category_code,
      cursor_source.buyer_reference,
      cursor_source.purchase_order_reference,
      j.reference                                                  as job_reference,
      ct.reference                                                 as contract_reference
      from invoices cursor_source
      join customers cu on cu.id = cursor_source.customer_id
      left join jobs j on j.id = cursor_source.job_id
      left join contracts ct on ct.id = cursor_source.contract_id
      left join lateral (
        select sum((n.total * 100)::bigint) as credited
          from credit_notes n
         where n.invoice_id = cursor_source.id and n.deleted_at is null
      ) cn on true
     where cursor_source.deleted_at is null
       -- A draft is not a document. Exporting one would put a number in an
       -- accountant's ledger that the customer has never been shown.
       and cursor_source.status <> 'draft'
       and cursor_source.issued_on is not null
       and (cursor_source.issued_on at time zone 'Asia/Dubai') >= ${from}::date
       and (cursor_source.issued_on at time zone 'Asia/Dubai') < ${to}::date + interval '1 day'
       ${afterCursor(after, invoiceSort)}
     order by ${invoiceSort}, cursor_source.id
     limit ${limit}
  `)) {
    const taxableMinor = Number(r.taxable_minor);
    const taxMinor = Number(r.tax_minor);
    const totalMinor = Number(r.total_minor);
    const paidMinor = Number(r.paid_minor);
    const creditedMinor = Number(r.credited_minor);

    invoiceRows.push([
      r.reference,
      r.document_type,
      r.status,
      r.issue_date,
      r.supply_date,
      r.due_date,
      r.customer_code,
      r.customer_name,
      r.customer_trn,
      r.currency,
      csvAmount(Number(r.subtotal_minor)),
      csvAmount(Number(r.discount_minor)),
      csvAmount(taxableMinor),
      vatRatePercent(Number(r.tax_rate_basis_points)),
      csvAmount(taxMinor),
      csvAmount(totalMinor),
      csvAmount(paidMinor),
      csvAmount(creditedMinor),
      csvAmount(totalMinor - paidMinor - creditedMinor),
      r.tax_category_code,
      r.buyer_reference,
      r.purchase_order_reference,
      r.job_reference,
      r.contract_reference,
      r.cursor_id,
    ]);

    journal.push(
      ...documentJournalLines(
        {
          reference: r.reference,
          date: r.issue_date,
          contact: r.customer_name,
          currency: r.currency,
          taxCode: r.tax_category_code,
          taxableMinor,
          taxMinor,
          totalMinor,
        },
        "invoice",
      ),
    );
  }

  // ── Credit notes ──────────────────────────────────────────────────────────

  type CreditRowOut = {
    cursor_sort: string;
    cursor_id: string;
    reference: string;
    document_type: string;
    status: string;
    issue_date: string;
    supply_date: string | null;
    invoice_reference: string;
    customer_code: string | null;
    customer_name: string;
    customer_trn: string | null;
    reason: string;
    reason_detail: string | null;
    currency: string;
    subtotal_minor: string;
    discount_minor: string;
    taxable_minor: string;
    tax_rate_basis_points: string;
    tax_minor: string;
    total_minor: string;
    tax_category_code: string;
  };

  const creditSort = sql`(cursor_source.issued_on at time zone 'Asia/Dubai')`;

  const creditRows: (readonly CsvValue[])[] = [];
  for await (const r of exportRows<CreditRowOut>(tx, (after, limit) => sql`
    select
      to_char(cursor_source.issued_on at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI:SS.US') as cursor_sort,
      cursor_source.id::text                                       as cursor_id,
      cursor_source.reference,
      cursor_source.document_type,
      cursor_source.status,
      to_char(cursor_source.issued_on at time zone 'Asia/Dubai', 'YYYY-MM-DD') as issue_date,
      to_char(cursor_source.supply_date, 'YYYY-MM-DD')             as supply_date,
      i.reference                                                  as invoice_reference,
      cu.code                                                      as customer_code,
      cu.name                                                      as customer_name,
      cu.trn                                                       as customer_trn,
      cursor_source.reason,
      cursor_source.reason_detail,
      cursor_source.currency,
      (cursor_source.subtotal * 100)::bigint::text                 as subtotal_minor,
      (cursor_source.discount_amount * 100)::bigint::text          as discount_minor,
      (cursor_source.taxable_amount * 100)::bigint::text           as taxable_minor,
      cursor_source.tax_rate_basis_points::text                    as tax_rate_basis_points,
      (cursor_source.tax_amount * 100)::bigint::text               as tax_minor,
      (cursor_source.total * 100)::bigint::text                    as total_minor,
      cursor_source.tax_category_code
      from credit_notes cursor_source
      join invoices i on i.id = cursor_source.invoice_id
      join customers cu on cu.id = cursor_source.customer_id
     where cursor_source.deleted_at is null
       and cursor_source.issued_on is not null
       and (cursor_source.issued_on at time zone 'Asia/Dubai') >= ${from}::date
       and (cursor_source.issued_on at time zone 'Asia/Dubai') < ${to}::date + interval '1 day'
       ${afterCursor(after, creditSort)}
     order by ${creditSort}, cursor_source.id
     limit ${limit}
  `)) {
    const taxableMinor = Number(r.taxable_minor);
    const taxMinor = Number(r.tax_minor);
    const totalMinor = Number(r.total_minor);

    creditRows.push([
      r.reference,
      r.document_type,
      r.status,
      r.issue_date,
      r.supply_date,
      r.invoice_reference,
      r.customer_code,
      r.customer_name,
      r.customer_trn,
      r.reason,
      r.reason_detail,
      r.currency,
      csvAmount(Number(r.subtotal_minor)),
      csvAmount(Number(r.discount_minor)),
      csvAmount(taxableMinor),
      vatRatePercent(Number(r.tax_rate_basis_points)),
      csvAmount(taxMinor),
      csvAmount(totalMinor),
      r.tax_category_code,
      r.cursor_id,
    ]);

    journal.push(
      ...documentJournalLines(
        {
          reference: r.reference,
          date: r.issue_date,
          contact: r.customer_name,
          currency: r.currency,
          taxCode: r.tax_category_code,
          taxableMinor,
          taxMinor,
          totalMinor,
        },
        "credit_note",
      ),
    );
  }

  // ── Payments ──────────────────────────────────────────────────────────────

  type PaymentRowOut = {
    cursor_sort: string;
    cursor_id: string;
    received_date: string;
    invoice_reference: string;
    customer_code: string | null;
    customer_name: string;
    method: string;
    reference: string | null;
    gateway_provider: string | null;
    currency: string;
    amount_minor: string;
    reconciled_date: string | null;
  };

  const paymentSort = sql`(cursor_source.received_at at time zone 'Asia/Dubai')`;

  const paymentRows: (readonly CsvValue[])[] = [];
  for await (const r of exportRows<PaymentRowOut>(tx, (after, limit) => sql`
    select
      to_char(cursor_source.received_at at time zone 'Asia/Dubai', 'YYYY-MM-DD HH24:MI:SS.US') as cursor_sort,
      cursor_source.id::text                                       as cursor_id,
      to_char(cursor_source.received_at at time zone 'Asia/Dubai', 'YYYY-MM-DD') as received_date,
      i.reference                                                  as invoice_reference,
      cu.code                                                      as customer_code,
      cu.name                                                      as customer_name,
      cursor_source.method::text                                   as method,
      cursor_source.reference,
      cursor_source.gateway_provider,
      cursor_source.currency,
      (cursor_source.amount * 100)::bigint::text                   as amount_minor,
      to_char(cursor_source.reconciled_at at time zone 'Asia/Dubai', 'YYYY-MM-DD') as reconciled_date
      from payments cursor_source
      join invoices i on i.id = cursor_source.invoice_id
      join customers cu on cu.id = i.customer_id
     where cursor_source.deleted_at is null
       and (cursor_source.received_at at time zone 'Asia/Dubai') >= ${from}::date
       and (cursor_source.received_at at time zone 'Asia/Dubai') < ${to}::date + interval '1 day'
       ${afterCursor(after, paymentSort)}
     order by ${paymentSort}, cursor_source.id
     limit ${limit}
  `)) {
    const amountMinor = Number(r.amount_minor);

    paymentRows.push([
      r.received_date,
      r.invoice_reference,
      r.customer_code,
      r.customer_name,
      r.method,
      r.reference,
      r.gateway_provider,
      r.currency,
      csvAmount(amountMinor),
      r.reconciled_date,
      r.cursor_id,
    ]);

    journal.push(
      ...paymentJournalLines({
        reference: r.reference ?? r.invoice_reference,
        date: r.received_date,
        contact: r.customer_name,
        currency: r.currency,
        amountMinor,
        method: r.method,
        invoiceReference: r.invoice_reference,
      }),
    );
  }

  // ── Receivables, as at now ────────────────────────────────────────────────
  //
  // From `openReceivables`, which `arAgeing` also folds over. The schedule an
  // accountant receives and the control total the dashboard shows are the same
  // arithmetic run once, so reconciling them is a formality rather than a
  // discovery.

  const receivables = await openReceivables(tx, now);
  const asOf = dubaiDateKey(now);

  const receivableRows: (readonly CsvValue[])[] = receivables.map((r) => [
    r.reference,
    r.customerCode,
    r.customerName,
    r.customerTrn,
    r.status,
    r.issuedOn ? dubaiDateKey(r.issuedOn) : null,
    r.dueOn ? dubaiDateKey(r.dueOn) : null,
    r.overdueDays,
    r.bucket,
    r.currency,
    csvAmount(r.totalMinor),
    csvAmount(r.paidMinor),
    csvAmount(r.creditedMinor),
    csvAmount(r.outstandingMinor),
    r.invoiceId,
  ]);

  // ── The journal ───────────────────────────────────────────────────────────

  const journalRows: (readonly CsvValue[])[] = journal.map((l) => [
    l.date,
    l.reference,
    l.documentType,
    l.accountCode,
    l.accountName,
    l.contact,
    l.description,
    csvAmount(l.debitMinor),
    csvAmount(l.creditMinor),
    l.taxCode,
    l.currency,
  ]);

  const table = (
    name: AccountingDataset,
    title: string,
    columns: readonly string[],
    rows: (readonly CsvValue[])[],
  ): ExportTable => ({ name, title, columns, rows, rowCount: rows.length });

  const range = `${from} to ${to}`;

  return {
    from,
    to,
    generatedAt: now,
    currency: receivables[0]?.currency ?? "AED",
    journalBalance: journalTotals(journal),
    tables: {
      invoices: table("invoices", `Invoices issued, ${range}`, INVOICE_EXPORT_COLUMNS, invoiceRows),
      credit_notes: table(
        "credit_notes",
        `Credit notes issued, ${range}`,
        CREDIT_NOTE_EXPORT_COLUMNS,
        creditRows,
      ),
      payments: table("payments", `Payments received, ${range}`, PAYMENT_EXPORT_COLUMNS, paymentRows),
      receivables: table(
        "receivables",
        `Accounts receivable as at ${asOf}`,
        RECEIVABLE_EXPORT_COLUMNS,
        receivableRows,
      ),
      journal: table(
        "journal",
        `General journal, ${range}`,
        JOURNAL_EXPORT_COLUMNS,
        journalRows,
      ),
    },
  };
}

/*
 * ── THE COLUMN HEADINGS ─────────────────────────────────────────────────────
 *
 * Every money column says `_excl_vat` or `_incl_vat`, without exception, and
 * that is the single most important thing about these lists.
 *
 * An accountant importing a column called `total` has to decide whether it is
 * gross or net, and the decision is invisible once it is made: a VAT-inclusive
 * figure booked as revenue overstates revenue by 5% and understates the VAT
 * liability by the same amount, in a business that is measured against a
 * AED 3,000,000 threshold on revenue. The suffix costs nine characters.
 */

const INVOICE_EXPORT_COLUMNS = [
  "invoice_reference",
  "document_type",
  "status",
  "issue_date",
  "supply_date",
  "due_date",
  "customer_code",
  "customer_name",
  "customer_trn",
  "currency",
  "subtotal_excl_vat",
  "discount_excl_vat",
  "taxable_amount_excl_vat",
  "vat_rate_percent",
  "vat_amount",
  "total_incl_vat",
  "amount_paid_incl_vat",
  "credited_incl_vat",
  "balance_incl_vat",
  "tax_category_code",
  "buyer_reference",
  "purchase_order_reference",
  "job_reference",
  "contract_reference",
  "invoice_id",
] as const;

const CREDIT_NOTE_EXPORT_COLUMNS = [
  "credit_note_reference",
  "document_type",
  "status",
  "issue_date",
  "supply_date",
  "original_invoice_reference",
  "customer_code",
  "customer_name",
  "customer_trn",
  "reason",
  "reason_detail",
  "currency",
  "subtotal_excl_vat",
  "discount_excl_vat",
  "taxable_amount_excl_vat",
  "vat_rate_percent",
  "vat_amount",
  "total_incl_vat",
  "tax_category_code",
  "credit_note_id",
] as const;

const PAYMENT_EXPORT_COLUMNS = [
  "received_date",
  "invoice_reference",
  "customer_code",
  "customer_name",
  "method",
  "payment_reference",
  "gateway_provider",
  "currency",
  "amount_received_incl_vat",
  "reconciled_date",
  "payment_id",
] as const;

const RECEIVABLE_EXPORT_COLUMNS = [
  "invoice_reference",
  "customer_code",
  "customer_name",
  "customer_trn",
  "status",
  "issue_date",
  "due_date",
  "days_overdue",
  "ageing_bucket",
  "currency",
  "total_incl_vat",
  "amount_paid_incl_vat",
  "credited_incl_vat",
  "outstanding_incl_vat",
  "invoice_id",
] as const;

const JOURNAL_EXPORT_COLUMNS = [
  "date",
  "document_reference",
  "document_type",
  "account_code",
  "account_name",
  "contact",
  "description",
  "debit",
  "credit",
  "tax_code",
  "currency",
] as const;
