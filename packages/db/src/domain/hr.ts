import { sql, eq } from "drizzle-orm";
import {
  // HR-17
  assessWpsCycle,
  wpsCycleFor,
  wpsPermitIssuanceSuspended,
  WPS_MINIMUM_TRANSFER_PERCENT,
  type WpsAssessment,
  // HR-4
  assessContract,
  deemedRenewal,
  type ContractAssessment,
  // HR-7
  annualLeaveEntitlement,
  accruedLeaveDays,
  checkLeaveNotice,
  leaveDayCount,
  LEAVE_NOTICE_DAYS,
  stageSickLeave,
  sickLeavePayMinor,
  SICK_LEAVE_TOTAL_DAYS,
  type LeaveEntitlement,
  // HR-8
  splitWorkedWindow,
  overtimeAmountMinor,
  hourlyBasicMinor,
  ordinaryMinutesFor,
  assessWorkedDay,
  assessWeeklyHours,
  PAY_BAND_BASIS_POINTS,
  PAY_BAND_LABEL,
  MAX_OVERTIME_MINUTES_PER_DAY,
  type PayBand,
  type WeeklyHoursAssessment,
  // HR-6
  refuseDeduction,
  checkHealthInsurance,
  HEALTH_PLAN_LABEL,
  type HealthPlan,
  type DeductionKind,
  // dates
  UserFacingError,
  today,
  addDays,
  addMonths,
  daysBetween,
  startOfMonth,
  startOfWeek,
  formatDay,
  type CalendarDay,
} from "@meridian/core";
import { toMinor, toDecimalString } from "@meridian/core";
import type { TenantScopedTx } from "../index";
import * as schema from "../schema";

/**
 * The employment lifecycle: wages, contracts, leave, hours, insurance.
 *
 * `HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`. Everything here is the database half
 * of `packages/core/src/employment.ts` — the rules live there, unit-tested and
 * dependency-free, and this module's job is to feed them real rows and store
 * what they conclude. Nothing in this file re-derives a statutory number.
 *
 * ── EVERY QUERY BELOW HAS A CALLER ──────────────────────────────────────────
 *
 * TRD §10's rule, and it is the one this module could most easily break: a
 * payroll countdown nobody runs is a spreadsheet with extra steps. The wage
 * assessment is called by `/api/cron/compliance` and by `/hr`, the contract
 * renewal sweep by the same cron, the leave and hours reports by `/hr`, and the
 * insurance gap report by both. A function added here without a caller is a
 * policy document.
 */

// ── Reading money out of Postgres ───────────────────────────────────────────

/**
 * `numeric` arrives as a string and stays one until it is deliberately
 * converted. Every amount in this module is handled in integer minor units and
 * written back with `toDecimalString`, so no float ever touches a wage.
 */
function minorOf(value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : toMinor(value);
}

/** Allowances are `{ housing: "1500.00", transport: "500.00" }`. Sum in fils. */
function allowanceTotalMinor(allowances: unknown): number {
  if (!allowances || typeof allowances !== "object") return 0;
  let total = 0;
  for (const value of Object.values(allowances as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") total += toMinor(value);
  }
  return total;
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-17 — The WPS payroll countdown
// ═══════════════════════════════════════════════════════════════════════════

export interface WageCycleRow {
  readonly id: string;
  readonly periodMonth: CalendarDay;
  readonly dueOn: CalendarDay;
  readonly totalDueMinor: number;
  readonly totalTransferredMinor: number;
  readonly employeeCount: number;
  readonly paidEmployeeCount: number;
  readonly filePreparedOn: CalendarDay | null;
  readonly confirmedOn: CalendarDay | null;
  readonly transferReference: string | null;
  readonly status: string;
}

export interface WageCycleView extends WageCycleRow {
  readonly assessment: WpsAssessment;
}

type WageCycleDbRow = {
  id: string;
  period_month: string;
  due_on: string;
  total_due: string;
  total_transferred: string;
  employee_count: number;
  paid_employee_count: number;
  file_prepared_on: string | null;
  confirmed_on: string | null;
  transfer_reference: string | null;
  status: string;
};

function toWageCycle(r: WageCycleDbRow): WageCycleRow {
  return {
    id: r.id,
    periodMonth: r.period_month,
    dueOn: r.due_on,
    totalDueMinor: minorOf(r.total_due),
    totalTransferredMinor: minorOf(r.total_transferred),
    employeeCount: r.employee_count,
    paidEmployeeCount: r.paid_employee_count,
    filePreparedOn: r.file_prepared_on,
    confirmedOn: r.confirmed_on,
    transferReference: r.transfer_reference,
    status: r.status,
  };
}

function view(row: WageCycleRow, now: CalendarDay): WageCycleView {
  return {
    ...row,
    assessment: assessWpsCycle(
      {
        periodMonth: row.periodMonth,
        dueOn: row.dueOn,
        totalDueMinor: row.totalDueMinor,
        totalTransferredMinor: row.totalTransferredMinor,
        confirmedOn: row.confirmedOn,
        filePreparedOn: row.filePreparedOn,
        employeeCount: row.employeeCount,
      },
      now,
    ),
  };
}

/**
 * Open the wage cycle for a period, or return the one that exists.
 *
 * Idempotent, because the cron calls it every day and the page calls it on
 * every render. `ON CONFLICT DO NOTHING` on `(tenant_id, period_month)` rather
 * than a read-then-write: two requests landing in the same millisecond on the
 * 1st of the month is not hypothetical, it is the busiest moment this table has.
 */
export async function ensureWageCycle(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: { periodMonth: CalendarDay; dueOn?: CalendarDay },
): Promise<WageCycleRow> {
  const periodMonth = startOfMonth(input.periodMonth);
  // Wages for month M are due on the 1st of M+1. Stored rather than derived,
  // because the deadline has moved once already (Ministerial Resolution No. 340
  // of 2026) and a historic cycle must keep saying what it was actually due on.
  const dueOn = input.dueOn ?? addMonths(periodMonth, 1);

  await tx.execute(sql`
    insert into wage_cycles (tenant_id, period_month, due_on)
    values (${ctx.tenantId}::uuid, ${periodMonth}::date, ${dueOn}::date)
    on conflict (tenant_id, period_month) do nothing
  `);

  const rows = (await tx.execute<WageCycleDbRow>(sql`
    select id, period_month, due_on, total_due, total_transferred, employee_count,
           paid_employee_count, file_prepared_on, confirmed_on, transfer_reference, status
      from wage_cycles
     where period_month = ${periodMonth}::date and deleted_at is null
  `)) as unknown as WageCycleDbRow[];

  const row = rows[0];
  if (!row) throw new Error("Could not open the wage cycle.");
  return toWageCycle(row);
}

/**
 * The cycle that is live right now, plus where it stands on the ladder.
 *
 * Creates the cycle if it does not exist, deliberately. The alternative is a
 * countdown that reports "nothing to check" for the whole of August because
 * nobody pressed a button, and then reports the first violation on 2 September
 * — which is the day it stops being preventable.
 */
export async function currentWageCycle(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  now: CalendarDay = today(),
): Promise<WageCycleView> {
  const cycle = wpsCycleFor(now);
  const row = await ensureWageCycle(tx, ctx, { periodMonth: cycle.periodMonth, dueOn: cycle.dueOn });
  return view(row, now);
}

/** Recent cycles, newest first, each with its assessment. For the payroll page. */
export async function listWageCycles(
  tx: TenantScopedTx,
  limit = 12,
  now: CalendarDay = today(),
): Promise<readonly WageCycleView[]> {
  const rows = (await tx.execute<WageCycleDbRow>(sql`
    select id, period_month, due_on, total_due, total_transferred, employee_count,
           paid_employee_count, file_prepared_on, confirmed_on, transfer_reference, status
      from wage_cycles
     where deleted_at is null
     order by period_month desc
     limit ${limit}
  `)) as unknown as WageCycleDbRow[];

  return rows.map((r) => view(toWageCycle(r), now));
}

/**
 * Any past cycle still unresolved — the ones that stopped being a countdown.
 *
 * Reported every run while the condition holds, like the blocked technicians in
 * `compliance.ts`. A cycle that went unpaid in June does not stop being unpaid
 * because July's countdown started; the escalation ladder is still climbing on
 * it, and an alert that fired once in June has stopped being visible.
 */
export async function unsettledWageCycles(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly WageCycleView[]> {
  const rows = (await tx.execute<WageCycleDbRow>(sql`
    select id, period_month, due_on, total_due, total_transferred, employee_count,
           paid_employee_count, file_prepared_on, confirmed_on, transfer_reference, status
      from wage_cycles
     where deleted_at is null
       and due_on <= ${now}::date
       and status <> 'closed'
     order by period_month
  `)) as unknown as WageCycleDbRow[];

  return rows
    .map((r) => view(toWageCycle(r), now))
    // `nothing_due` drops off alongside `settled`. A month nobody was owed
    // anything for is not an outstanding obligation, and leaving it here would
    // put a permanent false alarm on a deployment that has not yet recorded any
    // employees.
    .filter((c) => c.assessment.stage !== "settled" && c.assessment.stage !== "nothing_due");
}

export interface WageLine {
  readonly employeeId: string;
  readonly fullName: string;
  readonly employeeNo: string | null;
  readonly basicMinor: number;
  readonly allowancesMinor: number;
  readonly overtimeMinor: number;
  readonly deductionsMinor: number;
  readonly netMinor: number;
  readonly overtimeMinutes: number;
  readonly leaveDays: number;
  readonly paid: boolean;
  /** Missing an IBAN means this line cannot be transferred at all. */
  readonly wpsIban: string | null;
}

/**
 * Produce the wage-file inputs for a cycle (`HR-17`, due by T-3).
 *
 * Hours, overtime, absences and deductions, per employee, computed from the
 * records that already exist rather than typed in again. Upserts one
 * `wage_payments` row per active employee and rewrites the cycle totals.
 *
 * ── WHY `total_due` COUNTS PEOPLE WITH NO LINE ──────────────────────────────
 *
 * It does not, and that is the trap this comment exists to mark. `total_due` is
 * the sum of the lines produced here, which covers every *active employee*. An
 * employee who should be paid but is not `active` — suspended, mid-termination,
 * a record somebody forgot to reactivate — is not in the denominator, so the
 * 85% test would pass while they went unpaid. `wageFileGaps` below is the check
 * for that, and it is reported next to the total rather than folded into it,
 * because a denominator that quietly grows is worse than one that is visibly
 * incomplete.
 */
export async function prepareWageFile(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  cycleId: string,
  now: CalendarDay = today(),
): Promise<{ lines: readonly WageLine[]; totalDueMinor: number }> {
  const cycles = (await tx.execute<{ id: string; period_month: string }>(sql`
    select id, period_month from wage_cycles where id = ${cycleId} and deleted_at is null
  `)) as unknown as { id: string; period_month: string }[];

  const cycle = cycles[0];
  if (!cycle) throw new UserFacingError("That wage cycle does not exist.");

  const periodStart = cycle.period_month;
  const periodEnd = addDays(addMonths(periodStart, 1), -1);

  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    employee_no: string | null;
    basic_salary_minor: string | null;
    allowances: unknown;
    wps_iban: string | null;
    overtime_minor: string;
    overtime_minutes: number;
    deductions_minor: string;
    leave_days: number;
  }>(sql`
    select e.id as employee_id,
           e.full_name,
           e.employee_no,
           e.basic_salary_minor::text as basic_salary_minor,
           e.allowances,
           e.wps_iban,
           coalesce((
             select sum(o.amount) from overtime_records o
              where o.employee_id = e.id
                and o.deleted_at is null
                -- Ordinary hours are already inside the monthly basic on this
                -- line. A standard-band row is an HOURS record — it is what
                -- makes the 48-hour week countable — and adding its amount here
                -- would pay the ordinary day a second time, on top of the
                -- salary. The minutes sum below has always excluded it; the
                -- money sum did not, and nothing recorded a standard band until
                -- recordWorkedDay did.
                and o.band <> 'standard'
                and o.worked_on between ${periodStart}::date and ${periodEnd}::date
           ), 0)::text as overtime_minor,
           coalesce((
             select sum(o.minutes)::int from overtime_records o
              where o.employee_id = e.id
                and o.deleted_at is null
                and o.band <> 'standard'
                and o.worked_on between ${periodStart}::date and ${periodEnd}::date
           ), 0) as overtime_minutes,
           coalesce((
             select sum(d.amount) from salary_deductions d
              where d.employee_id = e.id
                and d.deleted_at is null
                and (d.wage_cycle_id = ${cycleId}::uuid
                     or (d.wage_cycle_id is null
                         and d.applies_on between ${periodStart}::date and ${periodEnd}::date))
           ), 0)::text as deductions_minor,
           coalesce((
             select sum(
                      least(l.ends_on::date, ${periodEnd}::date)
                      - greatest(l.starts_on::date, ${periodStart}::date) + 1
                    )::int
               from leave_requests l
              where l.technician_id = e.technician_id
                and l.status = 'approved'
                and l.starts_on::date <= ${periodEnd}::date
                and l.ends_on::date >= ${periodStart}::date
           ), 0) as leave_days
      from employees e
     where e.deleted_at is null and e.status = 'active'
     order by e.full_name
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    employee_no: string | null;
    basic_salary_minor: string | null;
    allowances: unknown;
    wps_iban: string | null;
    overtime_minor: string;
    overtime_minutes: number;
    deductions_minor: string;
    leave_days: number;
  }[];

  const lines: WageLine[] = rows.map((r) => {
    // `basic_salary_minor` is already in fils on `employees`; the money columns
    // in this module are numeric(14,2). Both end up as integer minor units here
    // so the arithmetic below never mixes the two representations.
    const basicMinor = r.basic_salary_minor ? Number(r.basic_salary_minor) : 0;
    const allowancesMinor = allowanceTotalMinor(r.allowances);
    const overtimeMinor = minorOf(r.overtime_minor);
    const deductionsMinor = minorOf(r.deductions_minor);
    return {
      employeeId: r.employee_id,
      fullName: r.full_name,
      employeeNo: r.employee_no,
      basicMinor,
      allowancesMinor,
      overtimeMinor,
      deductionsMinor,
      netMinor: basicMinor + allowancesMinor + overtimeMinor - deductionsMinor,
      overtimeMinutes: r.overtime_minutes,
      leaveDays: r.leave_days,
      paid: false,
      wpsIban: r.wps_iban,
    };
  });

  for (const line of lines) {
    await tx.execute(sql`
      insert into wage_payments (
        tenant_id, wage_cycle_id, employee_id, basic, allowances, overtime,
        deductions, net, overtime_minutes, leave_days
      ) values (
        ${ctx.tenantId}::uuid, ${cycleId}::uuid, ${line.employeeId}::uuid,
        ${toDecimalString(line.basicMinor)}::numeric,
        ${toDecimalString(line.allowancesMinor)}::numeric,
        ${toDecimalString(line.overtimeMinor)}::numeric,
        ${toDecimalString(line.deductionsMinor)}::numeric,
        ${toDecimalString(line.netMinor)}::numeric,
        ${line.overtimeMinutes}, ${line.leaveDays}
      )
      on conflict (wage_cycle_id, employee_id) do update set
        basic = excluded.basic,
        allowances = excluded.allowances,
        overtime = excluded.overtime,
        deductions = excluded.deductions,
        net = excluded.net,
        overtime_minutes = excluded.overtime_minutes,
        leave_days = excluded.leave_days,
        updated_at = now()
    `);
  }

  const totalDueMinor = lines.reduce((sum, l) => sum + l.netMinor, 0);

  await tx.execute(sql`
    update wage_cycles
       set total_due = ${toDecimalString(totalDueMinor)}::numeric,
           employee_count = ${lines.length},
           file_prepared_on = ${now}::date,
           status = case when status = 'open' then 'file_prepared' else status end,
           updated_at = now()
     where id = ${cycleId}
  `);

  return { lines, totalDueMinor };
}

/** The lines in a prepared cycle, for the payroll page. */
export async function wageFileLines(
  tx: TenantScopedTx,
  cycleId: string,
): Promise<readonly WageLine[]> {
  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    employee_no: string | null;
    basic: string;
    allowances: string;
    overtime: string;
    deductions: string;
    net: string;
    overtime_minutes: number;
    leave_days: number;
    paid: boolean;
    wps_iban: string | null;
  }>(sql`
    select p.employee_id, e.full_name, e.employee_no, p.basic, p.allowances, p.overtime,
           p.deductions, p.net, p.overtime_minutes, p.leave_days, p.paid, e.wps_iban
      from wage_payments p
      join employees e on e.id = p.employee_id
     where p.wage_cycle_id = ${cycleId} and p.deleted_at is null
     order by e.full_name
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    employee_no: string | null;
    basic: string;
    allowances: string;
    overtime: string;
    deductions: string;
    net: string;
    overtime_minutes: number;
    leave_days: number;
    paid: boolean;
    wps_iban: string | null;
  }[];

  return rows.map((r) => ({
    employeeId: r.employee_id,
    fullName: r.full_name,
    employeeNo: r.employee_no,
    basicMinor: minorOf(r.basic),
    allowancesMinor: minorOf(r.allowances),
    overtimeMinor: minorOf(r.overtime),
    deductionsMinor: minorOf(r.deductions),
    netMinor: minorOf(r.net),
    overtimeMinutes: r.overtime_minutes,
    leaveDays: r.leave_days,
    paid: r.paid,
    wpsIban: r.wps_iban,
  }));
}

export interface WageFileGap {
  readonly employeeId: string;
  readonly fullName: string;
  readonly reason: string;
}

/**
 * People a wage transfer will not actually reach.
 *
 * Two kinds, and they fail differently — which is why the reason is per person
 * rather than one blanket sentence:
 *
 *  * **No IBAN.** They have a line and they are in the denominator, so their
 *    unpaid wage counts *against* the 85%: the establishment fails the test and
 *    the person is still unpaid. Two problems, not one.
 *  * **No basic salary.** Their line is zero, so they are effectively absent
 *    from the total — and this is the one where the 85% test passes at 100%
 *    while somebody goes unpaid, because the denominator never knew about them.
 *
 * Reported beside the total and never folded into it. A denominator that
 * quietly grows to cover its own gaps is worse than one that is visibly
 * incomplete.
 */
export async function wageFileGaps(tx: TenantScopedTx): Promise<readonly WageFileGap[]> {
  const rows = (await tx.execute<{ id: string; full_name: string; wps_iban: string | null; basic: string | null }>(sql`
    select e.id, e.full_name, e.wps_iban, e.basic_salary_minor::text as basic
      from employees e
     where e.deleted_at is null
       and e.status = 'active'
       and (e.wps_iban is null or btrim(e.wps_iban) = '' or e.basic_salary_minor is null or e.basic_salary_minor = 0)
     order by e.full_name
  `)) as unknown as { id: string; full_name: string; wps_iban: string | null; basic: string | null }[];

  return rows.map((r) => ({
    employeeId: r.id,
    fullName: r.full_name,
    reason:
      !r.wps_iban || r.wps_iban.trim() === ""
        ? "No WPS IBAN on record. Their line is in the total, so the wage cannot be transferred AND the shortfall counts against the 85% test."
        : "No basic salary recorded, so their line is zero. They are missing from the total, which means the 85% test can pass at 100% while they go unpaid.",
  }));
}

/**
 * Record the bank's confirmation of a WPS transfer.
 *
 * The amount is passed in rather than assumed equal to `total_due`, because a
 * partial transfer is a real and important state: 85% is the compliance line,
 * so "we paid most of it" has to be representable and has to be assessed
 * against the threshold rather than rounded up to "paid".
 */
export async function confirmWageTransfer(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    cycleId: string;
    transferredMinor: number;
    transferReference: string;
    confirmedOn?: CalendarDay;
    paidEmployeeCount?: number;
  },
): Promise<WageCycleView> {
  const reference = input.transferReference.trim();
  if (!reference) {
    // Mirrors the CHECK constraint, so the refusal is a sentence rather than a
    // constraint-violation stack trace reaching a user.
    throw new UserFacingError(
      "Record the bank or SIF reference. A transfer with no reference is an assertion, and it is the first thing an inspection asks for evidence of.",
    );
  }
  if (input.transferredMinor < 0) throw new UserFacingError("A transfer cannot be negative.");

  const confirmedOn = input.confirmedOn ?? today();

  await tx.execute(sql`
    update wage_cycles
       set total_transferred = ${toDecimalString(input.transferredMinor)}::numeric,
           confirmed_on = ${confirmedOn}::date,
           transfer_reference = ${reference},
           confirmed_by_id = ${ctx.userId ?? null}::uuid,
           paid_employee_count = coalesce(${input.paidEmployeeCount ?? null}::int, employee_count),
           status = 'transferred',
           updated_at = now()
     where id = ${input.cycleId}
  `);

  // The lines follow the cycle: a confirmed transfer marks every line paid, so
  // "which of these people has been paid" has one answer and not two.
  await tx.execute(sql`
    update wage_payments
       set paid = true, paid_on = ${confirmedOn}::date, updated_at = now()
     where wage_cycle_id = ${input.cycleId} and deleted_at is null
  `);

  const rows = (await tx.execute<WageCycleDbRow>(sql`
    select id, period_month, due_on, total_due, total_transferred, employee_count,
           paid_employee_count, file_prepared_on, confirmed_on, transfer_reference, status
      from wage_cycles where id = ${input.cycleId}
  `)) as unknown as WageCycleDbRow[];

  const row = rows[0];
  if (!row) throw new UserFacingError("That wage cycle does not exist.");
  return view(toWageCycle(row), today());
}

/**
 * Is new work-permit issuance suspended today, because of unpaid wages?
 *
 * Day 5 of the escalation. Surfaced as a **warning** on the onboarding screen
 * and nowhere else — see the long argument in `assessWpsCycle`. It is not a
 * block: the act MOHRE suspended happens at MOHRE, and refusing to let anyone
 * write down a new employee's name would only move the name somewhere this
 * system cannot see.
 */
export async function permitIssuanceWarning(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  now: CalendarDay = today(),
): Promise<string | null> {
  const unsettled = await unsettledWageCycles(tx, now);
  const suspended = unsettled.find((c) => wpsPermitIssuanceSuspended(c.assessment));
  if (!suspended) return null;

  return (
    `New work-permit issuance is suspended: ${suspended.assessment.label} wages are ` +
    `${suspended.assessment.daysLate} days late. A permit application made today will be refused, and the fee is not refunded. ` +
    `Clear the transfer first — at least ${WPS_MINIMUM_TRANSFER_PERCENT}% of wages due.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-4 — Contract terms and auto-renewal
// ═══════════════════════════════════════════════════════════════════════════

export interface ContractTermRow {
  readonly id: string;
  readonly employeeId: string;
  readonly sequence: number;
  readonly startsOn: CalendarDay;
  readonly endsOn: CalendarDay | null;
  readonly probationEndsOn: CalendarDay | null;
  readonly noticePeriodDays: number;
  readonly basicSalaryMinor: number | null;
  readonly workingPattern: string | null;
  readonly origin: string;
  readonly status: string;
  readonly note: string | null;
}

type ContractTermDbRow = {
  id: string;
  employee_id: string;
  sequence: number;
  starts_on: string;
  ends_on: string | null;
  probation_ends_on: string | null;
  notice_period_days: number;
  basic_salary: string | null;
  working_pattern: string | null;
  origin: string;
  status: string;
  note: string | null;
};

function toTerm(r: ContractTermDbRow): ContractTermRow {
  return {
    id: r.id,
    employeeId: r.employee_id,
    sequence: r.sequence,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    probationEndsOn: r.probation_ends_on,
    noticePeriodDays: r.notice_period_days,
    basicSalaryMinor: r.basic_salary === null ? null : minorOf(r.basic_salary),
    workingPattern: r.working_pattern,
    origin: r.origin,
    status: r.status,
    note: r.note,
  };
}

const TERM_COLUMNS = sql`id, employee_id, sequence, starts_on, ends_on, probation_ends_on,
                         notice_period_days, basic_salary, working_pattern, origin, status, note`;

/** Every term on file for one employee, oldest first. The contract's history. */
export async function listContractTerms(
  tx: TenantScopedTx,
  employeeId: string,
): Promise<readonly ContractTermRow[]> {
  const rows = (await tx.execute<ContractTermDbRow>(sql`
    select ${TERM_COLUMNS} from employment_contract_terms
     where employee_id = ${employeeId} and deleted_at is null
     order by sequence
  `)) as unknown as ContractTermDbRow[];
  return rows.map(toTerm);
}

/**
 * Record a contract term (`HR-4`).
 *
 * Sequence is allocated here rather than supplied, from `max(sequence) + 1`
 * inside the caller's transaction. Two people opening the same employment
 * record and saving a contract at once would otherwise both compute 2, and the
 * unique index would turn the second save into a constraint error nobody can
 * read — this way the second one gets 3.
 */
export async function recordContractTerm(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: {
    employeeId: string;
    startsOn: CalendarDay;
    endsOn?: CalendarDay | null;
    probationEndsOn?: CalendarDay | null;
    noticePeriodDays?: number;
    basicSalaryMinor?: number | null;
    allowances?: Record<string, string>;
    workingPattern?: string | null;
    origin?: "signed" | "auto_renewed" | "amended";
    renewedFromId?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; sequence: number }> {
  const rows = (await tx.execute<{ id: string; sequence: number }>(sql`
    insert into employment_contract_terms (
      tenant_id, employee_id, sequence, starts_on, ends_on, probation_ends_on,
      notice_period_days, basic_salary, allowances, working_pattern, origin, renewed_from_id, note
    )
    select ${ctx.tenantId}::uuid,
           ${input.employeeId}::uuid,
           coalesce(max(t.sequence), 0) + 1,
           ${input.startsOn}::date,
           ${input.endsOn ?? null}::date,
           ${input.probationEndsOn ?? null}::date,
           ${input.noticePeriodDays ?? 30},
           ${input.basicSalaryMinor === undefined || input.basicSalaryMinor === null
             ? null
             : toDecimalString(input.basicSalaryMinor)}::numeric,
           ${JSON.stringify(input.allowances ?? {})}::jsonb,
           ${input.workingPattern ?? null},
           ${input.origin ?? "signed"},
           ${input.renewedFromId ?? null}::uuid,
           ${input.note ?? null}
      from employment_contract_terms t
     where t.employee_id = ${input.employeeId}::uuid
    returning id, sequence
  `)) as unknown as { id: string; sequence: number }[];

  const row = rows[0];
  if (!row) throw new Error("Could not record the contract term.");

  // Everything before the new term is history. Superseding rather than deleting
  // keeps the signed dates, which are the evidence in the dispute the
  // auto-renewal rule exists to settle.
  await tx.execute(sql`
    update employment_contract_terms
       set status = 'superseded', updated_at = now()
     where employee_id = ${input.employeeId}
       and id <> ${row.id}
       and status = 'active'
       and deleted_at is null
  `);

  return row;
}

export interface EmploymentContractView {
  readonly employeeId: string;
  readonly fullName: string;
  readonly current: ContractTermRow | null;
  readonly assessment: ContractAssessment | null;
  readonly terms: readonly ContractTermRow[];
}

/**
 * The contract as it stands for one employee.
 *
 * Falls back to the four columns on `employees` when no term row exists, so an
 * employment record created before this table existed still reports a contract
 * state instead of a blank. That fallback is the reason the columns were left
 * on `employees` rather than migrated away: a partial migration that silently
 * turns every existing contract into "none recorded" is worse than a duplicate.
 */
export async function employmentContract(
  tx: TenantScopedTx,
  employeeId: string,
  now: CalendarDay = today(),
): Promise<EmploymentContractView | null> {
  const headers = (await tx.execute<{
    id: string;
    full_name: string;
    status: string;
    contract_type: string;
    contract_start: string | null;
    contract_end: string | null;
    probation_end: string | null;
    notice_period_days: number;
  }>(sql`
    select id, full_name, status, contract_type, contract_start, contract_end,
           probation_end, notice_period_days
      from employees where id = ${employeeId} and deleted_at is null
  `)) as unknown as {
    id: string;
    full_name: string;
    status: string;
    contract_type: string;
    contract_start: string | null;
    contract_end: string | null;
    probation_end: string | null;
    notice_period_days: number;
  }[];

  const header = headers[0];
  if (!header) return null;

  const terms = await listContractTerms(tx, employeeId);
  const current = terms.find((t) => t.status === "active") ?? terms[terms.length - 1] ?? null;
  const stillEmployed = header.status === "active";

  if (current) {
    return {
      employeeId: header.id,
      fullName: header.full_name,
      current,
      assessment: assessContract(
        {
          startsOn: current.startsOn,
          endsOn: current.endsOn,
          probationEndsOn: current.probationEndsOn,
          noticePeriodDays: current.noticePeriodDays,
          contractType: header.contract_type,
        },
        { stillEmployed, now },
      ),
      terms,
    };
  }

  if (!header.contract_start) {
    return { employeeId: header.id, fullName: header.full_name, current: null, assessment: null, terms };
  }

  return {
    employeeId: header.id,
    fullName: header.full_name,
    current: null,
    assessment: assessContract(
      {
        startsOn: header.contract_start,
        endsOn: header.contract_end,
        probationEndsOn: header.probation_end,
        noticePeriodDays: header.notice_period_days,
        contractType: header.contract_type,
      },
      { stillEmployed, now },
    ),
    terms,
  };
}

export interface ContractAlert {
  readonly employeeId: string;
  readonly fullName: string;
  readonly state: ContractAssessment["state"];
  readonly detail: string;
  readonly daysToEnd: number | null;
  readonly problems: readonly string[];
}

/**
 * Contracts that need something doing to them (`HR-4`).
 *
 * Four groups, in consequence order: terms that have already auto-renewed and
 * are not recorded, probation periods about to end (14 days' notice is the
 * whole window), terms inside the 90-day renewal horizon, and terms with a
 * statutory defect in them.
 *
 * Reads from `employment_contract_terms` where a term exists and from the
 * `employees` columns where one does not, for the reason in
 * `employmentContract` above.
 */
export async function contractAlerts(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly ContractAlert[]> {
  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    employee_status: string;
    contract_type: string;
    starts_on: string | null;
    ends_on: string | null;
    probation_ends_on: string | null;
    notice_period_days: number;
  }>(sql`
    select e.id as employee_id,
           e.full_name,
           e.status as employee_status,
           e.contract_type,
           coalesce(t.starts_on, e.contract_start) as starts_on,
           coalesce(t.ends_on, e.contract_end) as ends_on,
           coalesce(t.probation_ends_on, e.probation_end) as probation_ends_on,
           coalesce(t.notice_period_days, e.notice_period_days) as notice_period_days
      from employees e
      left join lateral (
        select * from employment_contract_terms x
         where x.employee_id = e.id and x.deleted_at is null and x.status = 'active'
         order by x.sequence desc limit 1
      ) t on true
     where e.deleted_at is null and e.status = 'active'
     order by e.full_name
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    employee_status: string;
    contract_type: string;
    starts_on: string | null;
    ends_on: string | null;
    probation_ends_on: string | null;
    notice_period_days: number;
  }[];

  const alerts: ContractAlert[] = [];

  for (const r of rows) {
    if (!r.starts_on) {
      alerts.push({
        employeeId: r.employee_id,
        fullName: r.full_name,
        state: "active",
        detail: "No contract recorded at all. Nothing here can tell you when it ends or whether it has renewed.",
        daysToEnd: null,
        problems: [],
      });
      continue;
    }

    const assessment = assessContract(
      {
        startsOn: r.starts_on,
        endsOn: r.ends_on,
        probationEndsOn: r.probation_ends_on,
        noticePeriodDays: r.notice_period_days,
        contractType: r.contract_type,
      },
      { stillEmployed: r.employee_status === "active", now },
    );

    const interesting =
      assessment.state === "auto_renewed" ||
      assessment.state === "expiring" ||
      assessment.state === "probation" ||
      assessment.problems.length > 0;

    if (!interesting) continue;

    alerts.push({
      employeeId: r.employee_id,
      fullName: r.full_name,
      state: assessment.state,
      detail: assessment.summary,
      daysToEnd: assessment.daysToEnd,
      problems: assessment.problems,
    });
  }

  // Consequence order: a contract that has already renewed without anybody
  // noticing outranks one that will renew in eleven weeks.
  const rank: Record<string, number> = { auto_renewed: 0, probation: 1, expiring: 2 };
  return alerts.sort(
    (a, b) => (rank[a.state] ?? 3) - (rank[b.state] ?? 3) || (a.daysToEnd ?? 0) - (b.daysToEnd ?? 0),
  );
}

export interface AutoRenewal {
  readonly employeeId: string;
  readonly fullName: string;
  readonly previousEnd: CalendarDay;
  readonly startsOn: CalendarDay;
  readonly endsOn: CalendarDay;
  readonly sequence: number;
}

/**
 * Materialise the renewals the law has already performed (`HR-4`).
 *
 * ── WHY THIS WRITES A ROW RATHER THAN COMPUTING ON READ ─────────────────────
 *
 * `assessContract` can say "this has auto-renewed" from the dates alone, and
 * for the screen that is enough. It is not enough for the record. The renewed
 * term carries the salary, the allowances and the notice period that are now
 * legally in force, and those have to exist as a row somebody can point at —
 * a computed answer that disappears when the page is closed is not what a
 * labour inspector, a gratuity calculation, or the wage file can read.
 *
 * Idempotent by construction: the lapsed term is superseded as the new one is
 * written, so a second run finds nothing to do. `origin = 'auto_renewed'` keeps
 * the deemed term distinguishable from one a human signed — which matters,
 * because only one of those is evidence of agreement.
 */
export async function autoRenewExpiredContracts(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  now: CalendarDay = today(),
): Promise<readonly AutoRenewal[]> {
  const rows = (await tx.execute<{
    term_id: string;
    employee_id: string;
    full_name: string;
    starts_on: string;
    ends_on: string;
    probation_ends_on: string | null;
    notice_period_days: number;
    basic_salary: string | null;
    allowances: unknown;
    working_pattern: string | null;
  }>(sql`
    select t.id as term_id, t.employee_id, e.full_name, t.starts_on, t.ends_on,
           t.probation_ends_on, t.notice_period_days, t.basic_salary, t.allowances, t.working_pattern
      from employment_contract_terms t
      join employees e on e.id = t.employee_id
     where t.status = 'active'
       and t.deleted_at is null
       and t.ends_on is not null
       and t.ends_on < ${now}::date
       and e.deleted_at is null
       and e.status = 'active'
     order by t.ends_on
  `)) as unknown as {
    term_id: string;
    employee_id: string;
    full_name: string;
    starts_on: string;
    ends_on: string;
    probation_ends_on: string | null;
    notice_period_days: number;
    basic_salary: string | null;
    allowances: unknown;
    working_pattern: string | null;
  }[];

  const renewals: AutoRenewal[] = [];

  for (const r of rows) {
    const deemed = deemedRenewal(r.starts_on, r.ends_on, now);

    const created = await recordContractTerm(
      tx,
      ctx,
      {
        employeeId: r.employee_id,
        startsOn: deemed.startsOn,
        endsOn: deemed.endsOn,
        // Probation belongs to the first term only and is non-extendable. A
        // renewal that carried it forward would be an unlawful second probation.
        probationEndsOn: null,
        noticePeriodDays: r.notice_period_days,
        basicSalaryMinor: r.basic_salary === null ? null : minorOf(r.basic_salary),
        allowances: (r.allowances as Record<string, string>) ?? {},
        workingPattern: r.working_pattern,
        origin: "auto_renewed",
        renewedFromId: r.term_id,
        note:
          `Renewed automatically. The term ending ${formatDay(r.ends_on)} was not renewed and work continued, ` +
          `so it renews on the same terms by operation of law (Federal Decree-Law 33/2021).`,
      },
    );

    renewals.push({
      employeeId: r.employee_id,
      fullName: r.full_name,
      previousEnd: r.ends_on,
      startsOn: deemed.startsOn,
      endsOn: deemed.endsOn,
      sequence: created.sequence,
    });
  }

  return renewals;
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-7 — Leave
// ═══════════════════════════════════════════════════════════════════════════

export interface LeaveRow {
  readonly id: string;
  readonly kind: string;
  readonly startsOn: CalendarDay;
  readonly endsOn: CalendarDay;
  readonly days: number;
  readonly status: string;
  readonly requestedOn: CalendarDay;
  /** `HR-7`: at least one month's notice of the leave dates. Warns, never blocks. */
  readonly noticeSufficient: boolean;
  readonly noticeDetail: string;
}

export interface LeaveSummary {
  readonly employeeId: string;
  readonly fullName: string;
  readonly technicianId: string | null;
  readonly serviceStart: CalendarDay | null;
  /**
   * The leave year this summary is measured against — the service anniversary,
   * not the service start.
   *
   * Returned rather than left for the caller to recompute. A form that wrote a
   * carry-over against the service start while this read it against the
   * anniversary would save a row nothing ever reads again, silently, and the
   * balance would simply never change. That is exactly what happened the first
   * time this was written.
   */
  readonly leaveYearStart: CalendarDay;
  readonly entitlement: LeaveEntitlement | null;
  readonly carriedOverDays: number;
  readonly adjustmentDays: number;
  readonly takenDays: number;
  readonly accruedDays: number;
  /** Accrued + carried over + adjustment − taken. Never stored. */
  readonly remainingDays: number;
  readonly requests: readonly LeaveRow[];
  /**
   * Sick leave is a separate entitlement with its own ladder, not a draw on
   * this one. Carried alongside rather than folded in, because the two answer
   * different questions and netting them off is how fifteen days of full-pay
   * sick leave gets taken out of somebody's annual leave.
   */
  readonly sick: SickLeaveYear | null;
}

/**
 * One employee's leave position (`HR-7`).
 *
 * Entitlement is computed from the service dates, days taken are counted from
 * `leave_requests`, and only the carry-over and any deliberate adjustment come
 * from a table. Nothing here reads a stored balance, because there isn't one —
 * see the comment on `leave_balances` for why that is a feature.
 *
 * Leave joins through `technician_id`: `leave_requests` was built against the
 * technician roster and is used by the dispatcher for availability, and giving
 * leave a second employee-keyed home would produce two calendars that disagree
 * about who is at work.
 */
export async function leaveSummary(
  tx: TenantScopedTx,
  employeeId: string,
  now: CalendarDay = today(),
): Promise<LeaveSummary | null> {
  const headers = (await tx.execute<{
    id: string;
    full_name: string;
    technician_id: string | null;
    service_start: string | null;
  }>(sql`
    select e.id, e.full_name, e.technician_id,
           coalesce(e.contract_start, t.joined_on::date) as service_start
      from employees e
      left join technicians t on t.id = e.technician_id
     where e.id = ${employeeId} and e.deleted_at is null
  `)) as unknown as {
    id: string;
    full_name: string;
    technician_id: string | null;
    service_start: string | null;
  }[];

  const header = headers[0];
  if (!header) return null;

  const leaveYearStart = header.service_start
    ? addMonths(header.service_start, Math.floor(monthsOfService(header.service_start, now) / 12) * 12)
    : startOfMonth(now);

  const balances = (await tx.execute<{ carried_over_days: number; adjustment_days: number }>(sql`
    select carried_over_days, adjustment_days
      from leave_balances
     where employee_id = ${employeeId}
       and leave_year_start = ${leaveYearStart}::date
       and deleted_at is null
  `)) as unknown as { carried_over_days: number; adjustment_days: number }[];

  const balance = balances[0] ?? { carried_over_days: 0, adjustment_days: 0 };

  const requests = await leaveRequestsFor(tx, header.technician_id);

  const takenDays = requests
    .filter((r) => r.status === "approved" && r.kind === "annual" && r.startsOn >= leaveYearStart)
    .reduce((sum, r) => sum + r.days, 0);

  const entitlement = header.service_start
    ? annualLeaveEntitlement({ serviceStart: header.service_start, asOf: now, leaveYearStart })
    : null;

  const accruedDays = header.service_start
    ? accruedLeaveDays({ serviceStart: header.service_start, asOf: now })
    : 0;

  return {
    employeeId: header.id,
    fullName: header.full_name,
    technicianId: header.technician_id,
    serviceStart: header.service_start,
    leaveYearStart,
    entitlement,
    carriedOverDays: balance.carried_over_days,
    adjustmentDays: balance.adjustment_days,
    takenDays,
    accruedDays,
    remainingDays: accruedDays + balance.carried_over_days + balance.adjustment_days - takenDays,
    requests,
    sick: await sickLeaveYear(tx, employeeId, now),
  };
}

function monthsOfService(from: CalendarDay, to: CalendarDay): number {
  const [fy = 0, fm = 0, fd = 0] = from.split("-").map(Number);
  const [ty = 0, tm = 0, td = 0] = to.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return Math.max(0, months);
}

async function leaveRequestsFor(
  tx: TenantScopedTx,
  technicianId: string | null,
): Promise<readonly LeaveRow[]> {
  if (!technicianId) return [];

  const rows = (await tx.execute<{
    id: string;
    kind: string;
    starts_on: string;
    ends_on: string;
    status: string;
    requested_on: string;
  }>(sql`
    select id, kind,
           starts_on::date::text as starts_on,
           ends_on::date::text as ends_on,
           status,
           created_at::date::text as requested_on
      from leave_requests
     where technician_id = ${technicianId} and deleted_at is null
     order by starts_on desc
     limit 50
  `)) as unknown as {
    id: string;
    kind: string;
    starts_on: string;
    ends_on: string;
    status: string;
    requested_on: string;
  }[];

  return rows.map((r) => {
    // The 30-day minimum is the notice an EMPLOYER must give when it sets
    // annual-leave dates. It has no application to sick leave, bereavement or
    // anything else that happens to somebody — a sick day is by nature notified
    // the morning it starts, and reporting that as insufficient notice turns
    // every illness into a compliance flag against the person who was ill.
    const notice =
      r.kind === "annual"
        ? checkLeaveNotice({ requestedOn: r.requested_on, startsOn: r.starts_on })
        : {
            sufficient: true,
            message: `Notice does not apply to ${r.kind} leave — the ${LEAVE_NOTICE_DAYS}-day minimum is for annual-leave dates set by the employer.`,
          };
    return {
      id: r.id,
      kind: r.kind,
      startsOn: r.starts_on,
      endsOn: r.ends_on,
      days: leaveDayCount(r.starts_on, r.ends_on),
      status: r.status,
      requestedOn: r.requested_on,
      noticeSufficient: notice.sufficient,
      noticeDetail: notice.message,
    };
  });
}

export interface LeaveOverviewRow {
  readonly employeeId: string;
  readonly fullName: string;
  readonly entitlementDays: number;
  readonly accruedDays: number;
  readonly takenDays: number;
  readonly remainingDays: number;
  readonly basis: string;
  /** Upcoming approved leave with less than a month's notice. */
  readonly shortNoticeCount: number;
}

/**
 * Everybody's leave position at once, for the HR board (`HR-7`).
 *
 * One query and then the arithmetic in TypeScript, rather than expressing the
 * three-branch entitlement rule in SQL. The rule is unit-tested in
 * `packages/core`; restating it as a CASE expression would give it a second
 * home nothing tests, and the two would diverge the first time the statute
 * moved.
 */
export async function leaveOverview(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly LeaveOverviewRow[]> {
  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    service_start: string | null;
    carried_over_days: number | null;
    adjustment_days: number | null;
    taken_days: number | null;
    short_notice: number | null;
  }>(sql`
    select e.id as employee_id,
           e.full_name,
           coalesce(e.contract_start, t.joined_on::date) as service_start,
           b.carried_over_days,
           b.adjustment_days,
           (select coalesce(sum(l.ends_on::date - l.starts_on::date + 1)::int, 0)
              from leave_requests l
             where l.technician_id = e.technician_id
               and l.status = 'approved'
               and l.kind = 'annual'
               and l.deleted_at is null
               and l.starts_on::date >= ${now}::date - 365) as taken_days,
           (select count(*)::int
              from leave_requests l
             where l.technician_id = e.technician_id
               and l.status = 'approved'
               -- Annual leave only. The notice rule is about the employer
               -- setting leave dates; counting a sick day against it flags the
               -- person who was ill, on a board about the employer's duties.
               and l.kind = 'annual'
               and l.deleted_at is null
               and l.starts_on::date >= ${now}::date
               and l.starts_on::date - l.created_at::date < ${LEAVE_NOTICE_DAYS}) as short_notice
      from employees e
      left join technicians t on t.id = e.technician_id
      left join lateral (
        select * from leave_balances x
         where x.employee_id = e.id and x.deleted_at is null
         order by x.leave_year_start desc limit 1
      ) b on true
     where e.deleted_at is null and e.status = 'active'
     order by e.full_name
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    service_start: string | null;
    carried_over_days: number | null;
    adjustment_days: number | null;
    taken_days: number | null;
    short_notice: number | null;
  }[];

  return rows.map((r) => {
    const entitlement = r.service_start
      ? annualLeaveEntitlement({ serviceStart: r.service_start, asOf: now })
      : null;
    const accrued = r.service_start ? accruedLeaveDays({ serviceStart: r.service_start, asOf: now }) : 0;
    const taken = r.taken_days ?? 0;
    const carried = r.carried_over_days ?? 0;
    const adjustment = r.adjustment_days ?? 0;

    return {
      employeeId: r.employee_id,
      fullName: r.full_name,
      entitlementDays: entitlement?.days ?? 0,
      accruedDays: accrued,
      takenDays: taken,
      remainingDays: accrued + carried + adjustment - taken,
      basis: entitlement?.explanation ?? "No service start date recorded, so nothing can be accrued.",
      shortNoticeCount: r.short_notice ?? 0,
    };
  });
}

// ── HR-7: sick leave, which is three rates and not one ──────────────────────

export interface SickLeavePeriod {
  readonly id: string;
  readonly startsOn: CalendarDay;
  readonly endsOn: CalendarDay;
  readonly days: number;
  readonly status: string;
  /** Sick days consumed earlier in the leave year, before this absence. */
  readonly daysAlreadyTaken: number;
  readonly probationUnpaidDays: number;
  readonly fullPayDays: number;
  readonly halfPayDays: number;
  readonly unpaidDays: number;
  readonly beyondEntitlementDays: number;
  /** Full pay plus half pay, against the whole monthly wage. Minor units. */
  readonly payMinor: number;
  readonly explanation: string;
}

export interface SickLeaveYear {
  readonly employeeId: string;
  readonly fullName: string;
  readonly leaveYearStart: CalendarDay;
  readonly takenDays: number;
  readonly fullPayDays: number;
  readonly halfPayDays: number;
  readonly unpaidDays: number;
  readonly probationUnpaidDays: number;
  readonly beyondEntitlementDays: number;
  /** Of the 90, at the end of the last absence. */
  readonly remainingDays: number;
  readonly payMinor: number;
  readonly periods: readonly SickLeavePeriod[];
}

type SickRow = {
  id: string;
  starts_on: string;
  ends_on: string;
  status: string;
};

/**
 * Walk a leave year's sick absences through the statutory ladder, in order.
 *
 * The cursor belongs to the **year**, not to the absence, which is the whole
 * reason this is a fold rather than a map. Twelve sick days in March leave
 * three days of the full-pay stage; six more in July are three at full pay and
 * three at half. Staging each absence from zero pays the first fifteen days of
 * every absence at full pay, which for a worker with several short absences is
 * most of the year at the wrong rate.
 *
 * `probationEndsOn` is nullable and the null case is not "no probation" — it is
 * "no probation date recorded", which this treats as no probation. That is the
 * employee-favourable reading, and it is the only one available: inventing a
 * probation period nobody recorded would move days out of full pay.
 */
function stageSickPeriods(
  rows: readonly SickRow[],
  monthlyWageMinor: number,
  probationEndsOn: CalendarDay | null,
): { periods: SickLeavePeriod[]; consumed: number } {
  const periods: SickLeavePeriod[] = [];
  let consumed = 0;

  for (const row of rows) {
    const days = leaveDayCount(row.starts_on, row.ends_on);

    // Days at the START of the absence that fall inside probation. Measured
    // with string arithmetic, both ends inclusive — a Date round trip here
    // shifts the boundary by the host's offset, and the direction that shifts
    // is which days were paid.
    const probationDays =
      probationEndsOn && daysBetween(row.starts_on, probationEndsOn) >= 0
        ? Math.min(days, daysBetween(row.starts_on, probationEndsOn) + 1)
        : 0;

    const stages = stageSickLeave({ days, daysAlreadyTaken: consumed, probationDays });
    consumed += stages.entitlementConsumedDays;

    periods.push({
      id: row.id,
      startsOn: row.starts_on,
      endsOn: row.ends_on,
      days,
      status: row.status,
      daysAlreadyTaken: stages.daysAlreadyTaken,
      probationUnpaidDays: stages.probationUnpaidDays,
      fullPayDays: stages.fullPayDays,
      halfPayDays: stages.halfPayDays,
      unpaidDays: stages.unpaidDays,
      beyondEntitlementDays: stages.beyondEntitlementDays,
      payMinor: sickLeavePayMinor(monthlyWageMinor, stages),
      explanation: stages.explanation,
    });
  }

  return { periods, consumed };
}

function summariseSickYear(
  header: { employeeId: string; fullName: string; leaveYearStart: CalendarDay },
  periods: readonly SickLeavePeriod[],
  consumed: number,
): SickLeaveYear {
  const sum = (pick: (p: SickLeavePeriod) => number) => periods.reduce((t, p) => t + pick(p), 0);

  return {
    employeeId: header.employeeId,
    fullName: header.fullName,
    leaveYearStart: header.leaveYearStart,
    takenDays: sum((p) => p.days),
    fullPayDays: sum((p) => p.fullPayDays),
    halfPayDays: sum((p) => p.halfPayDays),
    unpaidDays: sum((p) => p.unpaidDays),
    probationUnpaidDays: sum((p) => p.probationUnpaidDays),
    beyondEntitlementDays: sum((p) => p.beyondEntitlementDays),
    remainingDays: Math.max(0, SICK_LEAVE_TOTAL_DAYS - consumed),
    payMinor: sum((p) => p.payMinor),
    periods,
  };
}

/**
 * One employee's sick-leave position for the leave year in progress (`HR-7`).
 *
 * Bounded by the leave year rather than by a row limit. A `limit 50` here would
 * be a silent truncation of the ladder — the absences it dropped are the ones
 * that already consumed the full-pay stage, so the days that survived would all
 * be paid at full pay again.
 */
export async function sickLeaveYear(
  tx: TenantScopedTx,
  employeeId: string,
  now: CalendarDay = today(),
): Promise<SickLeaveYear | null> {
  const headers = (await tx.execute<{
    id: string;
    full_name: string;
    technician_id: string | null;
    service_start: string | null;
    probation_ends_on: string | null;
    basic_salary_minor: string | null;
    allowances: unknown;
  }>(sql`
    select e.id, e.full_name, e.technician_id,
           coalesce(e.contract_start, t.joined_on::date) as service_start,
           coalesce(
             (select c.probation_ends_on
                from employment_contract_terms c
               where c.employee_id = e.id and c.deleted_at is null
                 and c.probation_ends_on is not null
               order by c.sequence limit 1),
             e.probation_end
           ) as probation_ends_on,
           e.basic_salary_minor::text as basic_salary_minor,
           e.allowances
      from employees e
      left join technicians t on t.id = e.technician_id
     where e.id = ${employeeId} and e.deleted_at is null
  `)) as unknown as {
    id: string;
    full_name: string;
    technician_id: string | null;
    service_start: string | null;
    probation_ends_on: string | null;
    basic_salary_minor: string | null;
    allowances: unknown;
  }[];

  const header = headers[0];
  if (!header) return null;

  const leaveYearStart = header.service_start
    ? addMonths(header.service_start, Math.floor(monthsOfService(header.service_start, now) / 12) * 12)
    : startOfMonth(now);

  const rows = header.technician_id
    ? ((await tx.execute<SickRow>(sql`
        select id,
               starts_on::date::text as starts_on,
               ends_on::date::text as ends_on,
               status
          from leave_requests
         where technician_id = ${header.technician_id}::uuid
           and kind = 'sick'
           and status = 'approved'
           and deleted_at is null
           and starts_on::date >= ${leaveYearStart}::date
         order by starts_on, id
      `)) as unknown as SickRow[])
    : [];

  const basic = header.basic_salary_minor ? Number(header.basic_salary_minor) : 0;
  const { periods, consumed } = stageSickPeriods(
    rows,
    basic + allowanceTotalMinor(header.allowances),
    header.probation_ends_on,
  );

  return summariseSickYear(
    { employeeId: header.id, fullName: header.full_name, leaveYearStart },
    periods,
    consumed,
  );
}

/**
 * Everybody with sick leave recorded in the leave year in progress (`HR-7`).
 *
 * One query, then the ladder in TypeScript, for the same reason `leaveOverview`
 * does its arithmetic there: the staging rule is unit-tested in
 * `packages/core`, and a CASE expression restating it would be a second home
 * nothing tests. The leave year is per employee — it is their service
 * anniversary — so the query fetches a rolling year of absences and the fold
 * discards the ones that fall before each person's own year start.
 */
export async function sickLeaveOverview(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly SickLeaveYear[]> {
  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    service_start: string | null;
    probation_ends_on: string | null;
    basic_salary_minor: string | null;
    allowances: unknown;
    id: string;
    starts_on: string;
    ends_on: string;
    status: string;
  }>(sql`
    select e.id as employee_id,
           e.full_name,
           coalesce(e.contract_start, t.joined_on::date) as service_start,
           coalesce(
             (select c.probation_ends_on
                from employment_contract_terms c
               where c.employee_id = e.id and c.deleted_at is null
                 and c.probation_ends_on is not null
               order by c.sequence limit 1),
             e.probation_end
           ) as probation_ends_on,
           e.basic_salary_minor::text as basic_salary_minor,
           e.allowances,
           l.id,
           l.starts_on::date::text as starts_on,
           l.ends_on::date::text as ends_on,
           l.status
      from employees e
      left join technicians t on t.id = e.technician_id
      join leave_requests l
        on l.technician_id = e.technician_id
       and l.kind = 'sick'
       and l.status = 'approved'
       and l.deleted_at is null
       and l.starts_on::date >= ${now}::date - 400
     where e.deleted_at is null and e.status = 'active'
     order by e.full_name, l.starts_on, l.id
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    service_start: string | null;
    probation_ends_on: string | null;
    basic_salary_minor: string | null;
    allowances: unknown;
    id: string;
    starts_on: string;
    ends_on: string;
    status: string;
  }[];

  const byEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byEmployee.get(row.employee_id);
    if (list) list.push(row);
    else byEmployee.set(row.employee_id, [row]);
  }

  const out: SickLeaveYear[] = [];
  for (const [employeeId, group] of byEmployee) {
    const first = group[0];
    if (!first) continue;

    const leaveYearStart = first.service_start
      ? addMonths(first.service_start, Math.floor(monthsOfService(first.service_start, now) / 12) * 12)
      : startOfMonth(now);

    const inYear = group.filter((r) => r.starts_on >= leaveYearStart);
    if (inYear.length === 0) continue;

    const basic = first.basic_salary_minor ? Number(first.basic_salary_minor) : 0;
    const { periods, consumed } = stageSickPeriods(
      inYear,
      basic + allowanceTotalMinor(first.allowances),
      first.probation_ends_on,
    );

    out.push(
      summariseSickYear({ employeeId, fullName: first.full_name, leaveYearStart }, periods, consumed),
    );
  }

  return out;
}

/**
 * Record an absence as sick leave (`HR-7`).
 *
 * ── WHY THIS WRITES TO `leave_requests` AND NOT SOMEWHERE OF ITS OWN ────────
 *
 * Because the dispatcher reads `leave_requests` to decide who is available, and
 * a sick day it cannot see is a technician assigned to a job on a day they were
 * signed off. That table is keyed by technician rather than by employee, which
 * is the one real cost: an employment record with no technician link has
 * nowhere to put the absence, and this says so rather than storing it where
 * nothing will read it.
 *
 * The staging is deliberately NOT stored. Which days were full pay depends on
 * what else the leave year holds, and an absence recorded in April can be
 * cancelled in May — a stored split would then be a number nothing recomputes,
 * sitting next to the leave calendar that disagrees with it. It is derived on
 * read, by `sickLeaveYear` above, and returned here so the person recording it
 * sees what it cost before they leave the page.
 */
export async function recordSickLeave(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    startsOn: CalendarDay;
    endsOn: CalendarDay;
    status?: "pending" | "approved";
    reason?: string;
  },
  now: CalendarDay = today(),
): Promise<{ id: string; days: number; year: SickLeaveYear | null }> {
  if (daysBetween(input.startsOn, input.endsOn) < 0) {
    throw new UserFacingError("The absence ends before it starts.");
  }

  const days = leaveDayCount(input.startsOn, input.endsOn);
  if (days > SICK_LEAVE_TOTAL_DAYS) {
    throw new UserFacingError(
      `${days} days in one absence is longer than the ${SICK_LEAVE_TOTAL_DAYS}-day statutory sick-leave year. ` +
        `Record what has actually happened so far — an absence that runs past the entitlement is a termination ` +
        `question under Article 34, not a longer sick leave.`,
    );
  }

  const employees = (await tx.execute<{ technician_id: string | null }>(sql`
    select technician_id from employees where id = ${input.employeeId} and deleted_at is null
  `)) as unknown as { technician_id: string | null }[];

  const employee = employees[0];
  if (!employee) throw new UserFacingError("That employment record does not exist.");
  if (!employee.technician_id) {
    throw new UserFacingError(
      "This employment record is not linked to a technician, and leave is held against the technician roster — " +
        "which is what the dispatcher reads to decide who is available. Recording the absence anywhere else would " +
        "leave this person schedulable on a day they are signed off sick. Link the technician record first.",
    );
  }

  // `starts_on` and `ends_on` are timestamptz on this table and have been since
  // 0000, for what are calendar days. Not this module's column to change — the
  // dispatcher's availability window reads them as instants — so every read and
  // write here goes through ::date, which round-trips within a deployment and
  // is what the rest of this file already does.
  const rows = (await tx.execute<{ id: string }>(sql`
    insert into leave_requests (
      tenant_id, technician_id, kind, starts_on, ends_on, status, reason, approved_by_id, approved_at
    ) values (
      ${ctx.tenantId}::uuid, ${employee.technician_id}::uuid, 'sick',
      ${input.startsOn}::date, ${input.endsOn}::date,
      ${input.status ?? "approved"}, ${input.reason ?? null},
      ${ctx.userId ?? null}::uuid, ${ctx.userId ? sql`now()` : sql`null`}
    )
    returning id
  `)) as unknown as { id: string }[];

  const row = rows[0];
  if (!row) throw new Error("Could not record the sick leave.");

  return { id: row.id, days, year: await sickLeaveYear(tx, input.employeeId, now) };
}

/**
 * Record carry-over or a deliberate adjustment to a leave year (`HR-7`).
 *
 * A reason is required for any non-zero adjustment, mirroring the CHECK
 * constraint. Leave adjustments are challenged at termination, and an
 * adjustment with no reason is indistinguishable from a mistake by then.
 */
export async function saveLeaveBalance(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    leaveYearStart: CalendarDay;
    carriedOverDays?: number;
    adjustmentDays?: number;
    reason?: string;
  },
): Promise<{ id: string }> {
  const adjustment = input.adjustmentDays ?? 0;
  const reason = (input.reason ?? "").trim();

  if (adjustment !== 0 && reason === "") {
    throw new UserFacingError(
      "Give a reason for the adjustment. A leave adjustment with no stated reason is indistinguishable from a mistake when it is challenged at termination.",
    );
  }
  if ((input.carriedOverDays ?? 0) < 0) throw new UserFacingError("Carry-over cannot be negative.");

  const rows = (await tx.execute<{ id: string }>(sql`
    insert into leave_balances (
      tenant_id, employee_id, leave_year_start, carried_over_days, adjustment_days, reason, adjusted_by_id
    ) values (
      ${ctx.tenantId}::uuid, ${input.employeeId}::uuid, ${input.leaveYearStart}::date,
      ${input.carriedOverDays ?? 0}, ${adjustment}, ${reason === "" ? null : reason},
      ${ctx.userId ?? null}::uuid
    )
    on conflict (tenant_id, employee_id, leave_year_start) do update set
      carried_over_days = excluded.carried_over_days,
      adjustment_days = excluded.adjustment_days,
      reason = excluded.reason,
      adjusted_by_id = excluded.adjusted_by_id,
      updated_at = now()
    returning id
  `)) as unknown as { id: string }[];

  const row = rows[0];
  if (!row) throw new Error("Could not save the leave balance.");
  return row;
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-8 — Overtime and working hours
// ═══════════════════════════════════════════════════════════════════════════

export interface OvertimeRow {
  readonly id: string;
  readonly employeeId: string;
  readonly fullName: string;
  readonly workedOn: CalendarDay;
  readonly band: PayBand;
  readonly bandLabel: string;
  readonly minutes: number;
  readonly multiplierBasisPoints: number;
  readonly amountMinor: number;
  readonly restDayCompensation: string | null;
  readonly substituteDayOn: CalendarDay | null;
  readonly source: string;
}

/**
 * Record one band of one worked day (`HR-8`).
 *
 * The amount is computed here from the employee's basic salary rather than
 * accepted from the caller, and the multiplier is taken from
 * `PAY_BAND_BASIS_POINTS` — integer basis points, so no float ever reaches a
 * wage. A caller that could supply the amount could supply an amount below the
 * statutory rate, and the whole reason this is a table is that the number can
 * be re-derived and checked.
 */
export async function recordOvertime(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    workedOn: CalendarDay;
    band: PayBand;
    minutes: number;
    restDayCompensation?: "substitute_day" | "premium_pay";
    substituteDayOn?: CalendarDay;
    source?: "attendance" | "manual";
    note?: string;
  },
): Promise<{ id: string; amountMinor: number; weekly: WeeklyHoursAssessment }> {
  if (input.minutes <= 0) throw new UserFacingError("Record the minutes actually worked.");
  if (input.minutes > 1440) throw new UserFacingError("More than 24 hours in one day is a data-entry error.");

  // NOTE: overtime past the two-hour daily cap is recorded, not refused. The
  // hours were worked; refusing to store them does not un-work them, it makes
  // the breach invisible — the same reason `checkStatutoryHours` warns rather
  // than blocks. `workingHoursExceptions` is what surfaces it.

  if (input.band === "rest_day" && input.restDayCompensation === "substitute_day" && !input.substituteDayOn) {
    throw new UserFacingError(
      "Name the substitute day. A day off promised without a date is a day off nobody can prove was given.",
    );
  }

  const employees = (await tx.execute<{ basic_salary_minor: string | null }>(sql`
    select basic_salary_minor::text as basic_salary_minor
      from employees where id = ${input.employeeId} and deleted_at is null
  `)) as unknown as { basic_salary_minor: string | null }[];

  const employee = employees[0];
  if (!employee) throw new UserFacingError("That employment record does not exist.");

  const monthlyBasicMinor = employee.basic_salary_minor ? Number(employee.basic_salary_minor) : 0;
  const hourly = hourlyBasicMinor(monthlyBasicMinor);
  const amountMinor = overtimeAmountMinor(hourly, input.minutes, input.band);
  const basisPoints = PAY_BAND_BASIS_POINTS[input.band];

  const rows = (await tx.execute<{ id: string }>(sql`
    insert into overtime_records (
      tenant_id, employee_id, worked_on, band, minutes, multiplier_basis_points,
      hourly_rate, amount, rest_day_compensation, substitute_day_on, source, approved_by_id, approved_at, note
    ) values (
      ${ctx.tenantId}::uuid, ${input.employeeId}::uuid, ${input.workedOn}::date, ${input.band},
      ${input.minutes}, ${basisPoints},
      ${toDecimalString(hourly)}::numeric, ${toDecimalString(amountMinor)}::numeric,
      ${input.restDayCompensation ?? null}, ${input.substituteDayOn ?? null}::date,
      ${input.source ?? "manual"}, ${ctx.userId ?? null}::uuid,
      ${ctx.userId ? sql`now()` : sql`null`}, ${input.note ?? null}
    )
    on conflict (tenant_id, employee_id, worked_on, band) where deleted_at is null
    do update set
      minutes = excluded.minutes,
      multiplier_basis_points = excluded.multiplier_basis_points,
      hourly_rate = excluded.hourly_rate,
      amount = excluded.amount,
      rest_day_compensation = excluded.rest_day_compensation,
      substitute_day_on = excluded.substitute_day_on,
      source = excluded.source,
      note = excluded.note,
      updated_at = now()
    returning id
  `)) as unknown as { id: string }[];

  const row = rows[0];
  if (!row) throw new Error("Could not record the overtime.");

  // Read back rather than added up, because this upserts: re-recording a day
  // that already had three hours against it with two replaces the three, and a
  // running total kept in TypeScript would have counted five.
  const minutesThisWeek = await weeklyMinutesFor(tx, input.employeeId, input.workedOn);

  return { id: row.id, amountMinor, weekly: assessWeeklyHours(minutesThisWeek) };
}

/** Overtime in a period, newest first. Drives the HR board and the wage file. */
export async function listOvertime(
  tx: TenantScopedTx,
  input: { from: CalendarDay; to: CalendarDay; employeeId?: string },
): Promise<readonly OvertimeRow[]> {
  const rows = (await tx.execute<{
    id: string;
    employee_id: string;
    full_name: string;
    worked_on: string;
    band: string;
    minutes: number;
    multiplier_basis_points: number;
    amount: string | null;
    rest_day_compensation: string | null;
    substitute_day_on: string | null;
    source: string;
  }>(sql`
    select o.id, o.employee_id, e.full_name, o.worked_on, o.band, o.minutes,
           o.multiplier_basis_points, o.amount, o.rest_day_compensation,
           o.substitute_day_on, o.source
      from overtime_records o
      join employees e on e.id = o.employee_id
     where o.deleted_at is null
       and o.worked_on between ${input.from}::date and ${input.to}::date
       and (${input.employeeId ?? null}::uuid is null or o.employee_id = ${input.employeeId ?? null}::uuid)
     order by o.worked_on desc, e.full_name
  `)) as unknown as {
    id: string;
    employee_id: string;
    full_name: string;
    worked_on: string;
    band: string;
    minutes: number;
    multiplier_basis_points: number;
    amount: string | null;
    rest_day_compensation: string | null;
    substitute_day_on: string | null;
    source: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    fullName: r.full_name,
    workedOn: r.worked_on,
    band: r.band as PayBand,
    bandLabel: PAY_BAND_LABEL[r.band as PayBand] ?? r.band,
    minutes: r.minutes,
    multiplierBasisPoints: r.multiplier_basis_points,
    amountMinor: minorOf(r.amount),
    restDayCompensation: r.rest_day_compensation,
    substituteDayOn: r.substitute_day_on,
    source: r.source,
  }));
}

export interface HoursException {
  readonly employeeId: string;
  readonly fullName: string;
  readonly workedOn: CalendarDay;
  readonly detail: string;
}

/**
 * Working-time breaches in a period (`HR-8`, `HR-10`), reported weekly.
 *
 * Two things this looks for and one it deliberately does not. It finds overtime
 * beyond the two-hour daily cap, and rest-day work with no compensation
 * recorded — the two exposures that come straight off the overtime records.
 *
 * It does **not** find the 48-hour week from attendance events, because
 * `attendance_events` is populated by the field app, which does not exist yet.
 * Reporting "0 breaches" from an empty table would be the exact failure this
 * codebase keeps warning about: a board that is reassuring because nothing is
 * being measured. `hoursSourceWarning` below says so out loud instead.
 */
export async function workingHoursExceptions(
  tx: TenantScopedTx,
  input: { from: CalendarDay; to: CalendarDay },
): Promise<readonly HoursException[]> {
  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    worked_on: string;
    overtime_minutes: number;
    uncompensated_rest_day_minutes: number;
  }>(sql`
    select o.employee_id,
           e.full_name,
           o.worked_on,
           coalesce(sum(o.minutes) filter (where o.band in ('overtime', 'night')), 0)::int as overtime_minutes,
           coalesce(sum(o.minutes) filter (
             where o.band = 'rest_day' and o.rest_day_compensation is null
           ), 0)::int as uncompensated_rest_day_minutes
      from overtime_records o
      join employees e on e.id = o.employee_id
     where o.deleted_at is null
       and o.worked_on between ${input.from}::date and ${input.to}::date
     group by o.employee_id, e.full_name, o.worked_on
    having coalesce(sum(o.minutes) filter (where o.band in ('overtime', 'night')), 0) > ${MAX_OVERTIME_MINUTES_PER_DAY}
        or coalesce(sum(o.minutes) filter (
             where o.band = 'rest_day' and o.rest_day_compensation is null
           ), 0) > 0
     order by o.worked_on desc, e.full_name
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    worked_on: string;
    overtime_minutes: number;
    uncompensated_rest_day_minutes: number;
  }[];

  return rows.map((r) => ({
    employeeId: r.employee_id,
    fullName: r.full_name,
    workedOn: r.worked_on,
    detail:
      r.overtime_minutes > MAX_OVERTIME_MINUTES_PER_DAY
        ? `${(r.overtime_minutes / 60).toFixed(1)} hours of overtime, past the statutory maximum of ${MAX_OVERTIME_MINUTES_PER_DAY / 60} extra hours a day.`
        : `${(r.uncompensated_rest_day_minutes / 60).toFixed(1)} hours worked on a rest day with no substitute day or premium recorded.`,
  }));
}

// ── HR-8: the 48-hour week ──────────────────────────────────────────────────

export interface WeeklyHoursRow {
  readonly employeeId: string;
  readonly fullName: string;
  /** The Monday of the week, matching Postgres date_trunc on week. */
  readonly weekStart: CalendarDay;
  readonly weekEnd: CalendarDay;
  readonly recordedMinutes: number;
  readonly standardMinutes: number;
  readonly overtimeMinutes: number;
  readonly nightMinutes: number;
  readonly restDayMinutes: number;
  /** Days in the week with any hours recorded at all. */
  readonly daysRecorded: number;
  readonly assessment: WeeklyHoursAssessment;
}

/**
 * Minutes recorded in the week containing `day`, for one employee (`HR-8`).
 *
 * This is the `minutesThisWeek` that `assessWorkedDay` has always taken as a
 * parameter and that nothing in the database layer supplied — the reason the
 * 48-hour maximum was unit-tested and unchecked at the same time.
 *
 * ── WHAT THIS NUMBER IS, EXACTLY ────────────────────────────────────────────
 *
 * The sum of the `overtime_records` rows for that week, every band included. It
 * is a **lower bound on hours worked, not a measurement of them**: the only
 * hours in that table are the ones somebody entered, and `HR-8` says hours come
 * from clock-in/out in the field app, which is `FLD-3` and does not exist. So a
 * week that crosses 48 hours here has genuinely crossed it; a week that does
 * not may still have, unrecorded. `hoursSourceWarning` says that in the product
 * rather than in this comment, because the person reading the board is the one
 * who needs to know it.
 */
export async function weeklyMinutesFor(
  tx: TenantScopedTx,
  employeeId: string,
  day: CalendarDay,
): Promise<number> {
  const weekStart = startOfWeek(day);
  const rows = (await tx.execute<{ minutes: number }>(sql`
    select coalesce(sum(minutes), 0)::int as minutes
      from overtime_records
     where employee_id = ${employeeId}::uuid
       and deleted_at is null
       and worked_on between ${weekStart}::date and ${addDays(weekStart, 6)}::date
  `)) as unknown as { minutes: number }[];

  return rows[0]?.minutes ?? 0;
}

/**
 * Every employee's recorded hours, by week, against the 48-hour maximum.
 *
 * The window is snapped back to the Monday of the week `from` falls in, and the
 * grouping is Postgres `date_trunc` on week, which is also Monday. Those two
 * have to agree: a window starting on a Wednesday would report that week's
 * total as the three days inside it and call a 60-hour week compliant.
 *
 * `worked_on` is a `date` column and the truncation runs through `timestamp`,
 * not `timestamptz`, so no session timezone reaches the week boundary. The same
 * cast through `timestamptz` would move a Monday's hours into the previous week
 * for every deployment whose cluster is not in Dubai.
 */
export async function weeklyWorkingHours(
  tx: TenantScopedTx,
  input: { from: CalendarDay; to: CalendarDay; employeeId?: string; breachesOnly?: boolean },
): Promise<readonly WeeklyHoursRow[]> {
  const from = startOfWeek(input.from);

  const rows = (await tx.execute<{
    employee_id: string;
    full_name: string;
    week_start: string;
    minutes: number;
    standard_minutes: number;
    overtime_minutes: number;
    night_minutes: number;
    rest_day_minutes: number;
    days_recorded: number;
  }>(sql`
    select o.employee_id,
           e.full_name,
           date_trunc('week', o.worked_on::timestamp)::date::text as week_start,
           coalesce(sum(o.minutes), 0)::int as minutes,
           coalesce(sum(o.minutes) filter (where o.band = 'standard'), 0)::int as standard_minutes,
           coalesce(sum(o.minutes) filter (where o.band = 'overtime'), 0)::int as overtime_minutes,
           coalesce(sum(o.minutes) filter (where o.band = 'night'), 0)::int as night_minutes,
           coalesce(sum(o.minutes) filter (where o.band = 'rest_day'), 0)::int as rest_day_minutes,
           count(distinct o.worked_on)::int as days_recorded
      from overtime_records o
      join employees e on e.id = o.employee_id
     where o.deleted_at is null
       and o.worked_on between ${from}::date and ${input.to}::date
       and (${input.employeeId ?? null}::uuid is null or o.employee_id = ${input.employeeId ?? null}::uuid)
     group by o.employee_id, e.full_name, date_trunc('week', o.worked_on::timestamp)
     order by week_start desc, e.full_name
  `)) as unknown as {
    employee_id: string;
    full_name: string;
    week_start: string;
    minutes: number;
    standard_minutes: number;
    overtime_minutes: number;
    night_minutes: number;
    rest_day_minutes: number;
    days_recorded: number;
  }[];

  const weeks = rows.map((r) => ({
    employeeId: r.employee_id,
    fullName: r.full_name,
    weekStart: r.week_start,
    weekEnd: addDays(r.week_start, 6),
    recordedMinutes: r.minutes,
    standardMinutes: r.standard_minutes,
    overtimeMinutes: r.overtime_minutes,
    nightMinutes: r.night_minutes,
    restDayMinutes: r.rest_day_minutes,
    daysRecorded: r.days_recorded,
    assessment: assessWeeklyHours(r.minutes),
  }));

  return input.breachesOnly ? weeks.filter((w) => !w.assessment.withinLimit) : weeks;
}

/**
 * What the hours picture is NOT covering, in plain language.
 *
 * `HR-8` says hours come from clock-in/out in the field app. That app does not
 * exist, so `attendance_events` is empty and every daily and weekly maximum in
 * `checkStatutoryHours` is being checked against nothing. Saying so is the
 * difference between a report and a reassurance.
 */
export async function hoursSourceWarning(tx: TenantScopedTx): Promise<string | null> {
  const rows = (await tx.execute<{ events: number }>(sql`
    select count(*)::int as events from attendance_events
     where occurred_at > now() - interval '30 days'
  `)) as unknown as { events: number }[];

  if ((rows[0]?.events ?? 0) > 0) return null;

  return (
    "No attendance events in the last 30 days. HR-8 expects daily and weekly working-hour maxima (8 per day, " +
    "48 per week, one hour of break after five consecutive hours) to be computed from clock-in/out, which arrives " +
    "with the field app (FLD-3). Until then the only hours this system knows about are the ones recorded by hand " +
    "below, so the weekly totals are a floor and not a measurement: a week shown as over 48 hours is genuinely over, " +
    "but a week shown as under may only be under-recorded. An empty exception list means nothing is being measured, " +
    "not that nobody is over."
  );
}

/**
 * Compute a day's rate-band split from a start and end (`HR-8`).
 *
 * A thin wrapper over `splitWorkedWindow` that supplies the statutory ordinary
 * day for the date — eight hours, six during Ramadan. Exists so callers never
 * pass `ordinaryMinutes` themselves, which is the one input somebody would
 * otherwise hard-code as 480 and quietly break every Ramadan.
 */
export function splitWorkedDay(input: {
  start: Date;
  end: Date;
  breakMinutes?: number;
  isRestDay?: boolean;
}): ReturnType<typeof splitWorkedWindow> {
  return splitWorkedWindow({
    start: input.start,
    end: input.end,
    ordinaryMinutes: ordinaryMinutesFor(input.start),
    ...(input.breakMinutes === undefined ? {} : { breakMinutes: input.breakMinutes }),
    ...(input.isRestDay === undefined ? {} : { isRestDay: input.isRestDay }),
  });
}

export interface WorkedDayResult {
  readonly workedOn: CalendarDay;
  readonly split: ReturnType<typeof splitWorkedWindow>;
  readonly totalMinor: number;
  readonly bandsRecorded: readonly PayBand[];
  readonly bandsCleared: readonly PayBand[];
  /** The week this day lands in, INCLUDING the day just recorded. */
  readonly weekly: WeeklyHoursAssessment;
  readonly warnings: readonly string[];
}

/**
 * Record one worked day from its start and end, split into rate bands.
 *
 * ── WHY THIS EXISTS, GIVEN THE PER-BAND FORM ALREADY DID ────────────────────
 *
 * `recordOvertime` takes a band and a number of minutes, which means whoever is
 * typing has already done the split in their head — and the split is the part
 * that is easy to get wrong in the expensive direction. A shift from 20:00 to
 * 04:00 is eight hours, all of it ordinary time, and none of it earns the night
 * premium; classified on the clock alone it looks like six hours at +50%.
 * `splitWorkedWindow` is the function that gets that right, and until now
 * nothing in the database layer called it.
 *
 * ── AND WHY IT IS NOT THE FIELD APP ─────────────────────────────────────────
 *
 * This is a start and an end somebody types in. `FLD-3` is a clock-in and a
 * clock-out with a geofence on them, landing in `attendance_events`, and it
 * does not exist. The difference matters for what may be claimed about the
 * numbers: hours recorded here are as complete as whoever entered them, which
 * is why the weekly total this returns is a floor rather than a measurement and
 * why `hoursSourceWarning` says so on the board.
 *
 * The ordinary hours ARE stored, as a `standard` band row. That is the change
 * that makes a 48-hour week countable at all — a table holding only the
 * overtime can never see a week of ordinary days that ran long. They are
 * excluded from the wage file's overtime money, because the monthly basic
 * already pays them; see `prepareWageFile`.
 */
export async function recordWorkedDay(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    workedOn: CalendarDay;
    /** Dubai wall-clock instants for the day being recorded. */
    start: Date;
    end: Date;
    breakMinutes?: number;
    isRestDay?: boolean;
    note?: string;
  },
): Promise<WorkedDayResult> {
  const split = splitWorkedDay({
    start: input.start,
    end: input.end,
    ...(input.breakMinutes === undefined ? {} : { breakMinutes: input.breakMinutes }),
    ...(input.isRestDay === undefined ? {} : { isRestDay: input.isRestDay }),
  });

  if (split.totalMinutes <= 0) throw new UserFacingError("That day has no worked minutes in it.");
  if (split.totalMinutes > 1440) throw new UserFacingError("More than 24 hours in one day is a data-entry error.");

  const minutesByBand: Record<PayBand, number> = {
    standard: split.standardMinutes,
    overtime: split.overtimeMinutes,
    night: split.nightMinutes,
    rest_day: split.restDayMinutes,
  };

  const bandsRecorded: PayBand[] = [];
  const bandsCleared: PayBand[] = [];
  let totalMinor = 0;

  for (const band of ["standard", "overtime", "night", "rest_day"] as const) {
    const minutes = minutesByBand[band];

    if (minutes > 0) {
      const recorded = await recordOvertime(tx, ctx, {
        employeeId: input.employeeId,
        workedOn: input.workedOn,
        band,
        minutes,
        source: "manual",
        ...(input.note ? { note: input.note } : {}),
      });
      totalMinor += recorded.amountMinor;
      bandsRecorded.push(band);
      continue;
    }

    // A day re-entered with different times must not leave the bands it no
    // longer has standing. Without this, correcting a 20:00–02:00 shift to
    // 20:00–00:00 leaves the two night hours on file for ever, and they are
    // paid at +50%. Soft-deleted rather than hard, so the correction is legible
    // in a payroll dispute instead of the earlier figure simply vanishing.
    const cleared = (await tx.execute<{ id: string }>(sql`
      update overtime_records
         set deleted_at = now(), updated_at = now()
       where employee_id = ${input.employeeId}::uuid
         and worked_on = ${input.workedOn}::date
         and band = ${band}
         and deleted_at is null
      returning id
    `)) as unknown as { id: string }[];

    if (cleared.length > 0) bandsCleared.push(band);
  }

  // The weekly total, read back AFTER the writes so it includes this day, and
  // then run through the same `assessWorkedDay` the unit tests exercise. This
  // is the parameter that had no caller: `minutesThisWeek` from real rows.
  const minutesThisWeek = await weeklyMinutesFor(tx, input.employeeId, input.workedOn);

  const employees = (await tx.execute<{ basic_salary_minor: string | null }>(sql`
    select basic_salary_minor::text as basic_salary_minor
      from employees where id = ${input.employeeId} and deleted_at is null
  `)) as unknown as { basic_salary_minor: string | null }[];

  const assessment = assessWorkedDay({
    start: input.start,
    end: input.end,
    ...(input.breakMinutes === undefined ? {} : { breakMinutes: input.breakMinutes }),
    ...(input.isRestDay === undefined ? {} : { isRestDay: input.isRestDay }),
    minutesThisWeek,
    monthlyBasicMinor: employees[0]?.basic_salary_minor ? Number(employees[0].basic_salary_minor) : 0,
  });

  return {
    workedOn: input.workedOn,
    split,
    totalMinor,
    bandsRecorded,
    bandsCleared,
    weekly: assessWeeklyHours(minutesThisWeek),
    warnings: assessment.warnings.concat(assessment.hours.warnings),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-6 — Health insurance
// ═══════════════════════════════════════════════════════════════════════════

export interface HealthInsuranceRow {
  readonly employeeId: string;
  readonly fullName: string;
  readonly plan: HealthPlan | null;
  readonly planLabel: string | null;
  readonly insurer: string | null;
  readonly policyNo: string | null;
  readonly premiumMinor: number | null;
  readonly monthlyWageMinor: number | null;
  readonly requiredPlan: HealthPlan;
  readonly hasInDatePolicy: boolean;
  readonly policyExpiresOn: CalendarDay | null;
  readonly problems: readonly string[];
}

/**
 * The health-cover columns, measured against a day this module chose.
 *
 * ── WHY THIS IS A FUNCTION AND NOT A CONSTANT ───────────────────────────────
 *
 * It used to compare against `current_date`, which is the Postgres session's
 * idea of today — and the session timezone is whatever the cluster was
 * initialised with, not Asia/Dubai. For the hours where those two disagree,
 * `current_date` is a different calendar day from the one every other date
 * comparison in this module uses, and the error has a direction: a policy that
 * expired at midnight Dubai keeps reporting as in date until midnight in the
 * server's zone. A lapsed health-insurance policy reading as valid is the
 * failure this whole module exists to prevent, so today is passed in, from
 * `today()`, like every other day-valued comparison here.
 */
function healthColumns(now: CalendarDay) {
  return sql`
  e.id as employee_id,
  e.full_name,
  e.health_plan,
  e.health_insurer,
  e.health_policy_no,
  e.health_premium,
  e.basic_salary_minor::text as basic_salary_minor,
  e.allowances,
  d.expires_at::date::text as policy_expires_on,
  (d.expires_at is not null and d.expires_at >= ${now}::date) as has_in_date_policy
`;
}

type HealthDbRow = {
  employee_id: string;
  full_name: string;
  health_plan: string | null;
  health_insurer: string | null;
  health_policy_no: string | null;
  health_premium: string | null;
  basic_salary_minor: string | null;
  allowances: unknown;
  policy_expires_on: string | null;
  has_in_date_policy: boolean | null;
};

function toHealthRow(r: HealthDbRow): HealthInsuranceRow {
  const basic = r.basic_salary_minor ? Number(r.basic_salary_minor) : null;
  const monthlyWageMinor = basic === null ? null : basic + allowanceTotalMinor(r.allowances);
  const plan = (r.health_plan as HealthPlan | null) ?? null;
  const hasInDatePolicy = r.has_in_date_policy === true;

  const check = checkHealthInsurance({
    monthlyWageMinor,
    plan,
    insurer: r.health_insurer,
    hasInDatePolicyDocument: hasInDatePolicy,
  });

  return {
    employeeId: r.employee_id,
    fullName: r.full_name,
    plan,
    planLabel: plan ? HEALTH_PLAN_LABEL[plan] : null,
    insurer: r.health_insurer,
    policyNo: r.health_policy_no,
    premiumMinor: r.health_premium === null ? null : minorOf(r.health_premium),
    monthlyWageMinor,
    requiredPlan: check.requiredPlan,
    hasInDatePolicy,
    policyExpiresOn: r.policy_expires_on,
    problems: check.problems,
  };
}

/** One employee's health cover (`HR-6`). Expiry comes from the document, always. */
export async function healthInsuranceFor(
  tx: TenantScopedTx,
  employeeId: string,
  now: CalendarDay = today(),
): Promise<HealthInsuranceRow | null> {
  const rows = (await tx.execute<HealthDbRow>(sql`
    select ${healthColumns(now)}
      from employees e
      left join employee_documents d
        on d.employee_id = e.id and d.kind = 'health_insurance' and d.deleted_at is null
     where e.id = ${employeeId} and e.deleted_at is null
  `)) as unknown as HealthDbRow[];

  const row = rows[0];
  return row ? toHealthRow(row) : null;
}

/**
 * Everybody whose health cover is not what the law requires (`HR-6`).
 *
 * Three distinct failures with one consequence — monthly penalties from AED 500
 * to AED 150,000 and blocked visa processing: no policy on file, a policy of
 * the wrong tier for the wage, and a policy nobody can name the insurer for.
 * All three are reported, because "has insurance" is not the requirement.
 */
export async function healthInsuranceGaps(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly HealthInsuranceRow[]> {
  const rows = (await tx.execute<HealthDbRow>(sql`
    select ${healthColumns(now)}
      from employees e
      left join employee_documents d
        on d.employee_id = e.id and d.kind = 'health_insurance' and d.deleted_at is null
     where e.deleted_at is null and e.status = 'active'
     order by e.full_name
  `)) as unknown as HealthDbRow[];

  return rows.map(toHealthRow).filter((r) => r.problems.length > 0);
}

/**
 * Record health cover for an employee (`HR-6`).
 *
 * Takes a premium, and takes it as an **employer cost**. There is no path from
 * this function to a salary deduction and there cannot be one: the premium
 * lands on `employees.health_premium`, and `salary_deductions.kind` has a CHECK
 * constraint whose positive list contains no insurance value at all.
 */
export async function saveHealthInsurance(
  tx: TenantScopedTx,
  _ctx: { tenantId: string },
  input: {
    employeeId: string;
    plan: HealthPlan;
    insurer: string;
    policyNo?: string;
    premiumMinor?: number | null;
  },
): Promise<void> {
  const insurer = input.insurer.trim();
  if (!insurer) throw new UserFacingError("Name the insurer. A policy nobody can name is a policy nobody can claim against.");

  await tx
    .update(schema.employees)
    .set({
      healthPlan: input.plan,
      healthInsurer: insurer,
      healthPolicyNo: input.policyNo?.trim() || null,
      healthPremium:
        input.premiumMinor === undefined || input.premiumMinor === null
          ? null
          : toDecimalString(input.premiumMinor),
      updatedAt: new Date(),
    })
    .where(eq(schema.employees.id, input.employeeId));
}

// ── The deduction that must be impossible ───────────────────────────────────

export interface DeductionRow {
  readonly id: string;
  readonly kind: string;
  readonly amountMinor: number;
  readonly reason: string;
  readonly appliesOn: CalendarDay | null;
}

/**
 * Record a salary deduction — or refuse it, by name and by statute.
 *
 * `HR-6` and `HR-16` are structural requirements: the health insurance premium
 * may not be deducted from salary, and recruitment costs may never be recovered
 * from a worker. Three things enforce that, and all three are deliberate:
 *
 *  1. `LAWFUL_DEDUCTION_KINDS` in `packages/core`, a positive list.
 *  2. `refuseDeduction`, which returns the sentence naming the actual law —
 *     because "invalid value" teaches nobody anything and gets the amount
 *     recorded under a different label ten seconds later.
 *  3. A CHECK constraint on `salary_deductions.kind`, which is what makes it
 *     impossible rather than merely refused. A validator here would still leave
 *     the value reachable through `psql`, through the ORM, and through the next
 *     code path somebody writes.
 */
export async function recordSalaryDeduction(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    kind: string;
    amountMinor: number;
    reason: string;
    appliesOn?: CalendarDay;
    wageCycleId?: string;
  },
): Promise<{ id: string }> {
  const refusal = refuseDeduction(input.kind);
  if (refusal) throw new UserFacingError(refusal);

  if (input.amountMinor <= 0) throw new UserFacingError("A deduction must be a positive amount.");
  const reason = input.reason.trim();
  if (!reason) {
    throw new UserFacingError(
      "State the reason for the deduction. A reduction of a protected wage with no stated reason is indistinguishable from an unlawful one when it is challenged.",
    );
  }

  const rows = (await tx.execute<{ id: string }>(sql`
    insert into salary_deductions (
      tenant_id, employee_id, wage_cycle_id, kind, amount, reason, authorised_by_id, applies_on
    ) values (
      ${ctx.tenantId}::uuid, ${input.employeeId}::uuid, ${input.wageCycleId ?? null}::uuid,
      ${input.kind as DeductionKind}, ${toDecimalString(input.amountMinor)}::numeric,
      ${reason}, ${ctx.userId ?? null}::uuid, ${input.appliesOn ?? null}::date
    )
    returning id
  `)) as unknown as { id: string }[];

  const row = rows[0];
  if (!row) throw new Error("Could not record the deduction.");
  return row;
}

/** Deductions on file for one employee. */
export async function listSalaryDeductions(
  tx: TenantScopedTx,
  employeeId: string,
): Promise<readonly DeductionRow[]> {
  const rows = (await tx.execute<{
    id: string;
    kind: string;
    amount: string;
    reason: string;
    applies_on: string | null;
  }>(sql`
    select id, kind, amount, reason, applies_on
      from salary_deductions
     where employee_id = ${employeeId} and deleted_at is null
     order by coalesce(applies_on, created_at::date) desc
  `)) as unknown as {
    id: string;
    kind: string;
    amount: string;
    reason: string;
    applies_on: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amountMinor: minorOf(r.amount),
    reason: r.reason,
    appliesOn: r.applies_on,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// The board
// ═══════════════════════════════════════════════════════════════════════════

export interface HrLifecycleSummary {
  readonly wages: WageCycleView;
  readonly unsettled: readonly WageCycleView[];
  readonly permitWarning: string | null;
  readonly contracts: readonly ContractAlert[];
  readonly leave: readonly LeaveOverviewRow[];
  readonly sickLeave: readonly SickLeaveYear[];
  readonly hoursExceptions: readonly HoursException[];
  /** Weeks over the 48-hour statutory maximum, most recent first. */
  readonly weeklyBreaches: readonly WeeklyHoursRow[];
  readonly hoursWarning: string | null;
  readonly insuranceGaps: readonly HealthInsuranceRow[];
  readonly wageGaps: readonly WageFileGap[];
}

/**
 * Everything the HR board renders, in one round trip.
 *
 * Consequence order, and it is the same order the page uses: wages first
 * because the escalation costs the ability to hire within five days, then
 * contracts, then insurance, then leave and hours. A board sorted any other way
 * would put a leave balance above a payroll that is eleven days late.
 */
export async function hrLifecycleSummary(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  now: CalendarDay = today(),
): Promise<HrLifecycleSummary> {
  const weekAgo = addDays(now, -7);

  return {
    wages: await currentWageCycle(tx, ctx, now),
    unsettled: await unsettledWageCycles(tx, now),
    permitWarning: await permitIssuanceWarning(tx, ctx, now),
    contracts: await contractAlerts(tx, now),
    leave: await leaveOverview(tx, now),
    sickLeave: await sickLeaveOverview(tx, now),
    hoursExceptions: await workingHoursExceptions(tx, { from: weekAgo, to: now }),
    // Four weeks rather than one. A daily breach is visible the day it happens;
    // a 48-hour week is only visible once the week is finished, so a seven-day
    // window would show the current week — always partial, always under the
    // limit — and never the completed one that went over.
    weeklyBreaches: await weeklyWorkingHours(tx, {
      from: startOfWeek(addDays(now, -21)),
      to: now,
      breachesOnly: true,
    }),
    hoursWarning: await hoursSourceWarning(tx),
    insuranceGaps: await healthInsuranceGaps(tx, now),
    wageGaps: await wageFileGaps(tx),
  };
}
