import { sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import { today, startOfMonth, addMonths, type CalendarDay } from "@meridian/core";
import { requiredRowDate } from "./_rows";

/**
 * `CUST-5`. The monthly reporting pack for property managers.
 *
 * Sold on the contracts marketing page as a contract benefit
 * (`apps/web/src/app/(marketing)/contracts/page.tsx`); nothing was behind it.
 * This is what a property manager is actually accountable for at the end of a
 * calendar month, put in front of the building owner: jobs raised and closed,
 * response and resolution against the SLA they are paying for, PPM visits due
 * against visits completed, recommendations still outstanding, and what was
 * spent.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * Nothing from the owner dashboard (`KPI-3`) is reused, because none of it is
 * addressed to a customer: cash ageing, the sales pipeline, hiring and
 * Emiratisation are the business's own figures about itself, not a report on
 * the service delivered to one account. First-time-fix rate and contract
 * renewal rate are on `KPI-3`'s own gap list (`DASHBOARD_GAPS` in
 * `reporting.ts`) for the same reason they are not here — no visit outcome
 * code and no `contract_status_changed` history to compute them from yet.
 * Customer satisfaction (`job_signoffs.satisfaction_rating`) is real data this
 * function could report and deliberately does not: nobody asked for it, and a
 * pack padded with a figure nobody asked for is exactly what the brief warns
 * against.
 *
 * ── WHY EVERY FIGURE IS ITS OWN AGGREGATE ───────────────────────────────────
 *
 * Every count below is `count(*)` (or `count(*) filter (...)`) over the whole
 * matching set in one query, never `array.length` over a list built for
 * display elsewhere. `outstanding.items` is the one list-shaped field here and
 * it is capped; `outstanding.total` is a second, uncapped aggregate, and
 * `outstanding.truncated` says when the two disagree — the same shape
 * `portalStatement` uses and for the same reason: summing a capped list
 * quietly understates the customer with the longest history, which is exactly
 * the customer this report matters most for.
 *
 * ── WHY THE PERIOD IS COMPUTED IN JAVASCRIPT AND NOT `current_date` ─────────
 *
 * The Postgres session timezone here is not `Asia/Dubai`, so `current_date`
 * is the wrong calendar day for part of every day. `today()` from
 * `@meridian/core` takes Dubai's day explicitly, and `startOfMonth`/
 * `addMonths` do the month arithmetic on that string — a job closed at 01:00
 * Dubai on the 1st belongs to the new month, and reading `current_date` in SQL
 * would file it in the old one. The resulting `YYYY-MM-DD` boundaries are
 * passed into SQL as plain dates and compared against `col AT TIME ZONE
 * 'Asia/Dubai'`, which is the same conversion `revenuePosition` in
 * `reporting.ts` uses for the identical reason.
 *
 * ── WHY THIS RUNS UNDER `withCustomerScope` AND TAKES NO `customerId` FILTER ─
 *
 * Every query below reads `jobs`, `contract_visits`, `job_reports` and
 * `invoices`/`credit_notes` with no `WHERE customer_id = …` of its own. The
 * restrictive policies in `sql/customer-scope.sql` narrow every one of them to
 * the caller's customer, the same model `portal.ts` uses throughout. A portal
 * session or a cron loop that forgets to open `withCustomerScope` for this
 * customer gets an empty pack, never another customer's figures.
 * `contract_visits` carried no such policy before this change — it was open
 * tenant-wide to a portal session for the same reason `job_visits` once was —
 * and the new policy in `customer-scope.sql` is what makes the PPM section of
 * this pack safe to compute this way at all.
 */

export interface PropertyManagerReportPeriod {
  /** "August 2026". */
  readonly label: string;
  /** First day of the period, inclusive, Asia/Dubai. */
  readonly startsOn: CalendarDay;
  /** First day of the following month — the exclusive upper bound, Asia/Dubai. */
  readonly endsOn: CalendarDay;
}

export interface PropertyManagerJobsSummary {
  /** Jobs created in the period, any status. */
  readonly raised: number;
  /** Jobs whose status is `closed` and whose `closed_at` fell in the period. */
  readonly closed: number;
  /** Jobs whose status is `cancelled` and whose `closed_at` fell in the period — reported, not folded into `closed`. */
  readonly cancelled: number;
  /**
   * Of the jobs raised in the period, how many are neither closed nor
   * cancelled as of the moment this pack was generated. Deliberately not
   * "open at period end" — this system has no point-in-time snapshot of job
   * status, only the current one, and claiming to know the state on a past
   * date would be inventing a fact the data cannot support.
   */
  readonly raisedStillOpen: number;
}

export interface PropertyManagerSlaSummary {
  /** Jobs whose response deadline fell inside the period. */
  readonly responseDeadlines: number;
  /** Of those, the deadline was met: a first response recorded at or before it. */
  readonly responseMet: number;
  /** Percent met. Null when no response deadline fell in the period — never zero. */
  readonly responseMetPercent: number | null;
  /** Jobs whose resolution deadline fell inside the period. */
  readonly resolutionDeadlines: number;
  /** Of those, the deadline was met: the job completed at or before it. */
  readonly resolutionMet: number;
  readonly resolutionMetPercent: number | null;
}

export interface PropertyManagerPpmSummary {
  /** Contract visits whose due date fell inside the period. */
  readonly visitsDue: number;
  /** Of those, the ones marked completed. */
  readonly visitsCompleted: number;
  /** Percent completed. Null when nothing was due — never zero and never 100. */
  readonly completionPercent: number | null;
}

export interface PropertyManagerOutstandingItem {
  readonly jobReference: string;
  readonly jobTitle: string;
  readonly propertyName: string;
  readonly recommendation: string;
  readonly raisedAt: Date;
}

export interface PropertyManagerOutstanding {
  /**
   * Recommendations raised in the period, on a job report marked
   * `follow_up_required`, whose job is still open now. The true count, from
   * its own `count(*)` — never `items.length`.
   */
  readonly total: number;
  /** Oldest first, capped. */
  readonly items: readonly PropertyManagerOutstandingItem[];
  /** True when `total` is larger than `items.length` — the list shown is not the whole list. */
  readonly truncated: boolean;
}

export interface PropertyManagerSpend {
  /** Invoiced this period, net of credit notes issued this period. Tax-inclusive — what the customer was actually billed. */
  readonly invoicedMinor: number;
  readonly invoiceCount: number;
  readonly currency: string;
}

export interface PropertyManagerMonthlyPack {
  readonly customerId: string;
  readonly period: PropertyManagerReportPeriod;
  readonly generatedAt: Date;
  readonly jobs: PropertyManagerJobsSummary;
  readonly sla: PropertyManagerSlaSummary;
  readonly ppm: PropertyManagerPpmSummary;
  readonly outstanding: PropertyManagerOutstanding;
  readonly spend: PropertyManagerSpend;
}

/** Recommendations shown in full; the rest are named by `outstanding.total`. */
const OUTSTANDING_ITEMS_LIMIT = 20;

function monthLabel(day: CalendarDay): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    month: "long",
    year: "numeric",
  });
}

/**
 * `CUST-5`. Must be called inside `withCustomerScope` — see the file header.
 *
 * `customerId` is not used to filter anything; it is stamped onto the return
 * value so a caller building an email or a page has it without a second read.
 * Passing the wrong one here does not leak another customer's figures, RLS
 * does — it produces a pack labelled with a customer id that does not match
 * the data actually returned, which is a caller bug the customer-scope tests
 * pin down separately.
 */
export async function propertyManagerMonthlyPack(
  tx: TenantScopedTx,
  ctx: TenantContext & { customerId: string },
  options?: { now?: Date },
): Promise<PropertyManagerMonthlyPack> {
  const now = options?.now ?? new Date();
  const dubaiToday = today(now);
  const thisMonthStart = startOfMonth(dubaiToday);
  const periodStart = addMonths(thisMonthStart, -1);
  const periodEnd = thisMonthStart;

  const [jobs, slaRow, ppmRow, outstandingTotal, outstandingItems, spendRow] = await Promise.all([
    jobsSummary(tx, periodStart, periodEnd),
    slaSummary(tx, periodStart, periodEnd),
    ppmSummary(tx, periodStart, periodEnd),
    outstandingCount(tx, periodStart, periodEnd),
    outstandingRows(tx, periodStart, periodEnd),
    spendSummary(tx, periodStart, periodEnd),
  ]);

  return {
    customerId: ctx.customerId,
    period: { label: monthLabel(periodStart), startsOn: periodStart, endsOn: periodEnd },
    generatedAt: now,
    jobs,
    sla: slaRow,
    ppm: ppmRow,
    outstanding: {
      total: outstandingTotal,
      items: outstandingItems,
      truncated: outstandingTotal > outstandingItems.length,
    },
    spend: spendRow,
  };
}

async function jobsSummary(
  tx: TenantScopedTx,
  periodStart: CalendarDay,
  periodEnd: CalendarDay,
): Promise<PropertyManagerJobsSummary> {
  const rows = (await tx.execute<{
    raised: string;
    closed: string;
    cancelled: string;
    raised_still_open: string;
  }>(sql`
    select
      count(*) filter (
        where (j.created_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.created_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as raised,
      count(*) filter (
        where j.status = 'closed'
          and j.closed_at is not null
          and (j.closed_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.closed_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as closed,
      count(*) filter (
        where j.status = 'cancelled'
          and j.closed_at is not null
          and (j.closed_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.closed_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as cancelled,
      count(*) filter (
        where (j.created_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.created_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
          and j.status not in ('closed', 'cancelled')
      ) as raised_still_open
      from jobs j
     where j.deleted_at is null
  `)) as unknown as { raised: string; closed: string; cancelled: string; raised_still_open: string }[];

  const r = rows[0];
  return {
    raised: Number(r?.raised ?? 0),
    closed: Number(r?.closed ?? 0),
    cancelled: Number(r?.cancelled ?? 0),
    raisedStillOpen: Number(r?.raised_still_open ?? 0),
  };
}

/**
 * Response and resolution against the deadline `computeSlaDeadlines` set on
 * the job, mirroring the definition `workPosition` uses on the owner
 * dashboard (`reporting.ts`): the deadline falling inside the period is what
 * is counted, not the outcome date. A job whose deadline fell last month but
 * was met this month belongs to last month's figure, because that is the
 * commitment that was due.
 */
async function slaSummary(
  tx: TenantScopedTx,
  periodStart: CalendarDay,
  periodEnd: CalendarDay,
): Promise<PropertyManagerSlaSummary> {
  const rows = (await tx.execute<{
    response_deadlines: string;
    response_met: string;
    resolution_deadlines: string;
    resolution_met: string;
  }>(sql`
    select
      (select count(*) from jobs j
        where j.deleted_at is null
          and j.respond_by_at is not null
          and (j.respond_by_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.respond_by_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as response_deadlines,
      (select count(*) from jobs j
        where j.deleted_at is null
          and j.respond_by_at is not null
          and (j.respond_by_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.respond_by_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
          and j.first_response_at is not null
          and j.first_response_at <= j.respond_by_at
      ) as response_met,
      (select count(*) from jobs j
        where j.deleted_at is null
          and j.resolve_by_at is not null
          and (j.resolve_by_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.resolve_by_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as resolution_deadlines,
      (select count(*) from jobs j
        where j.deleted_at is null
          and j.resolve_by_at is not null
          and (j.resolve_by_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (j.resolve_by_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
          and j.completed_at is not null
          and j.completed_at <= j.resolve_by_at
      ) as resolution_met
  `)) as unknown as {
    response_deadlines: string;
    response_met: string;
    resolution_deadlines: string;
    resolution_met: string;
  }[];

  const r = rows[0];
  const responseDeadlines = Number(r?.response_deadlines ?? 0);
  const responseMet = Number(r?.response_met ?? 0);
  const resolutionDeadlines = Number(r?.resolution_deadlines ?? 0);
  const resolutionMet = Number(r?.resolution_met ?? 0);

  return {
    responseDeadlines,
    responseMet,
    responseMetPercent: responseDeadlines > 0 ? Math.round((responseMet / responseDeadlines) * 100) : null,
    resolutionDeadlines,
    resolutionMet,
    resolutionMetPercent:
      resolutionDeadlines > 0 ? Math.round((resolutionMet / resolutionDeadlines) * 100) : null,
  };
}

async function ppmSummary(
  tx: TenantScopedTx,
  periodStart: CalendarDay,
  periodEnd: CalendarDay,
): Promise<PropertyManagerPpmSummary> {
  const rows = (await tx.execute<{ visits_due: string; visits_completed: string }>(sql`
    select
      count(*) filter (
        where (cv.due_on at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (cv.due_on at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as visits_due,
      count(*) filter (
        where cv.status = 'completed'
          and (cv.due_on at time zone 'Asia/Dubai')::date >= ${periodStart}::date
          and (cv.due_on at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
      ) as visits_completed
      from contract_visits cv
     where cv.deleted_at is null
  `)) as unknown as { visits_due: string; visits_completed: string }[];

  const r = rows[0];
  const visitsDue = Number(r?.visits_due ?? 0);
  const visitsCompleted = Number(r?.visits_completed ?? 0);

  return {
    visitsDue,
    visitsCompleted,
    completionPercent: visitsDue > 0 ? Math.round((visitsCompleted / visitsDue) * 100) : null,
  };
}

/**
 * The true count of outstanding recommendations, independent of the capped
 * list `outstandingRows` returns. See the file header for why these are two
 * separate queries rather than one list and its `.length`.
 */
async function outstandingCount(
  tx: TenantScopedTx,
  periodStart: CalendarDay,
  periodEnd: CalendarDay,
): Promise<number> {
  const rows = (await tx.execute<{ count: string }>(sql`
    select count(*) as count
      from job_reports jr
      join jobs j on j.id = jr.job_id
     where jr.deleted_at is null
       and jr.follow_up_required = true
       and jr.recommendation is not null
       and length(trim(jr.recommendation)) > 0
       and (jr.created_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
       and (jr.created_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
       and j.status not in ('closed', 'cancelled')
  `)) as unknown as { count: string }[];

  return Number(rows[0]?.count ?? 0);
}

async function outstandingRows(
  tx: TenantScopedTx,
  periodStart: CalendarDay,
  periodEnd: CalendarDay,
): Promise<readonly PropertyManagerOutstandingItem[]> {
  const rows = (await tx.execute<{
    job_reference: string;
    job_title: string;
    property_name: string;
    recommendation: string;
    raised_at: string;
  }>(sql`
    select j.reference as job_reference,
           j.title as job_title,
           p.name as property_name,
           jr.recommendation,
           jr.created_at as raised_at
      from job_reports jr
      join jobs j on j.id = jr.job_id
      join properties p on p.id = j.property_id
     where jr.deleted_at is null
       and jr.follow_up_required = true
       and jr.recommendation is not null
       and length(trim(jr.recommendation)) > 0
       and (jr.created_at at time zone 'Asia/Dubai')::date >= ${periodStart}::date
       and (jr.created_at at time zone 'Asia/Dubai')::date <  ${periodEnd}::date
       and j.status not in ('closed', 'cancelled')
     order by jr.created_at asc
     limit ${OUTSTANDING_ITEMS_LIMIT}
  `)) as unknown as {
    job_reference: string;
    job_title: string;
    property_name: string;
    recommendation: string;
    raised_at: string;
  }[];

  return rows.map((r) => ({
    jobReference: r.job_reference,
    jobTitle: r.job_title,
    propertyName: r.property_name,
    recommendation: r.recommendation,
    raisedAt: requiredRowDate(r.raised_at),
  }));
}

/**
 * Invoiced this period, net of credit notes issued in the same period.
 *
 * Tax-inclusive `total`, not `taxable_amount` — this is not measured against
 * the Small Business Relief line, it is "what were we billed", which is what
 * `portalStatement` already shows this same customer. Cast to minor units in
 * SQL as `bigint`, the same pattern `revenuePosition` uses, and never as
 * `::int`: an aggregate over a year of invoices can exceed a 32-bit integer.
 */
async function spendSummary(
  tx: TenantScopedTx,
  periodStart: CalendarDay,
  periodEnd: CalendarDay,
): Promise<PropertyManagerSpend> {
  const rows = (await tx.execute<{ invoiced_minor: string; invoice_count: string; currency: string | null }>(sql`
    with inv as (
      select (i.issued_on at time zone 'Asia/Dubai')::date as issued_day,
             (i.total * 100)::bigint                       as minor,
             i.currency
        from invoices i
       where i.deleted_at is null
         and i.status <> 'draft'
         and i.issued_on is not null
    ),
    crn as (
      select (c.issued_on at time zone 'Asia/Dubai')::date as issued_day,
             (c.total * 100)::bigint                       as minor
        from credit_notes c
       where c.deleted_at is null
         and c.issued_on is not null
    )
    select
      coalesce((select sum(minor) from inv
                 where issued_day >= ${periodStart}::date and issued_day < ${periodEnd}::date), 0)
      - coalesce((select sum(minor) from crn
                 where issued_day >= ${periodStart}::date and issued_day < ${periodEnd}::date), 0)
        as invoiced_minor,
      (select count(*) from inv
        where issued_day >= ${periodStart}::date and issued_day < ${periodEnd}::date)
        as invoice_count,
      (select currency from inv limit 1) as currency
  `)) as unknown as { invoiced_minor: string; invoice_count: string; currency: string | null }[];

  const r = rows[0];
  return {
    invoicedMinor: Number(r?.invoiced_minor ?? 0),
    invoiceCount: Number(r?.invoice_count ?? 0),
    currency: r?.currency ?? "AED",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Staff-side helpers: who gets a pack, and whether one already went out.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Customers holding (or who have held) an AMC — the audience `CUST-5` was
 * sold to. Staff-scoped: the caller loops these under `withTenant`, then
 * opens `withCustomerScope` per id to build the actual pack.
 *
 * `active`, `suspended` and `expired` — the same three statuses
 * `listPortalContracts` shows a customer their own contract under. A cancelled
 * or superseded contract does not currently entitle the account to the
 * monthly pack; a customer whose only contract expired without renewal still
 * gets one more, for the same reason `ppmCompliance` still counts an expired
 * contract's visits — the month's work happened under that contract.
 */
export async function customersWithMonthlyPack(tx: TenantScopedTx): Promise<readonly string[]> {
  const rows = (await tx.execute<{ customer_id: string }>(sql`
    select distinct c.customer_id
      from contracts c
     where c.deleted_at is null
       and c.status in ('active', 'suspended', 'expired')
  `)) as unknown as { customer_id: string }[];

  return rows.map((r) => r.customer_id);
}

/**
 * Has this customer already been sent a monthly pack recently?
 *
 * Staff-scoped, like `recentlyNotified` in `cron.ts` — the customer-scope
 * default policy on `notifications` closes it to a portal session, but a
 * cron loop iterating customers under `withTenant` needs to read it, and the
 * dedup has to happen there rather than inside the per-customer
 * `withCustomerScope` block that builds the pack.
 *
 * 27 days, not 30: the same reasoning `weekly_owner_digest` uses for six days
 * instead of seven. A monthly job that runs an hour early after a scheduler
 * restart must not be suppressed by a 30-day window and silently skip a
 * customer for the rest of the month.
 */
export async function recentlySentMonthlyPack(
  tx: TenantScopedTx,
  input: { template: string; customerId: string; withinDays: number },
): Promise<boolean> {
  const rows = (await tx.execute<{ hit: boolean }>(sql`
    select exists (
      select 1 from notifications
       where template = ${input.template}
         and subject_table = 'customers'
         and subject_id = ${input.customerId}::uuid
         and created_at > now() - make_interval(days => ${input.withinDays})
    ) as hit
  `)) as unknown as { hit: boolean }[];

  return rows[0]?.hit === true;
}
