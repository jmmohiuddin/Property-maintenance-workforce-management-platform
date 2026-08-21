import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  date,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, timestamps, money } from "./_shared";
import { tenants, users } from "./tenancy";
import { employees } from "./compliance";

/**
 * The employment lifecycle: contract terms, leave, hours, wages.
 *
 * `HR-4`, `HR-7`, `HR-8`, `HR-17`. This extends `compliance.ts` rather than
 * replacing it — `employees` and `employee_documents` stay where they are and
 * stay the only source of truth for who is employed and which of their
 * documents have expired. What is added here is everything that happens *to*
 * an employment record over time.
 *
 * ── THREE OF THESE TABLES ARE TAX RECORDS ───────────────────────────────────
 *
 * `employment_contract_terms`, `wage_cycles`, `wage_payments`,
 * `salary_deductions` and `overtime_records` all hold pay data. Payroll is a
 * financial record, so the seven-year floor in `domain/retention.ts` covers
 * them and the two-year `HR-15` employee clock must never be allowed to delete
 * them first. They are named to the retention owner rather than added to
 * `RETENTION_PROTECTED_TABLES` here, because that list is not this module's to
 * edit.
 *
 * ── MONEY ───────────────────────────────────────────────────────────────────
 *
 * `numeric(14,2)` at rest, integer minor units in code, and multipliers as
 * integer basis points — never a float anywhere near an overtime rate. See
 * `packages/core/src/employment.ts`.
 */

// ═══════════════════════════════════════════════════════════════════════════
// HR-4 — Contract terms, and the renewal that happens whether or not anyone
//        records it
// ═══════════════════════════════════════════════════════════════════════════

export const CONTRACT_TERM_ORIGINS = ["signed", "auto_renewed", "amended"] as const;
export type ContractTermOrigin = (typeof CONTRACT_TERM_ORIGINS)[number];

export const CONTRACT_TERM_STATUSES = ["draft", "active", "superseded", "ended"] as const;
export type ContractTermStatus = (typeof CONTRACT_TERM_STATUSES)[number];

/**
 * One term of one employment contract.
 *
 * ── WHY A TABLE OF TERMS AND NOT FOUR COLUMNS ON `employees` ────────────────
 *
 * `employees` already carries `contract_start`, `contract_end`, `probation_end`
 * and `notice_period_days`, and for a person on their first contract those four
 * columns are the whole truth. They stop being the whole truth the moment a
 * term lapses.
 *
 * UAE private-sector contracts are fixed-term only, and a fixed-term contract
 * that runs past its end date **auto-renews on the same terms by operation of
 * law**. So the day after the end date there are two facts to hold: the term
 * that was signed, and the term that is now running. Four columns can hold one
 * of those. Overwriting them with the renewal loses the signed dates — which is
 * the evidence in the dispute the renewal rule exists to prevent — and leaving
 * them alone renders an employed person as "contract expired", which is the
 * failure mode the requirement calls out by name.
 *
 * A term per row holds both, in order, with `origin` saying which of them a
 * human signed and which the law deemed.
 */
export const employmentContractTerms = pgTable(
  "employment_contract_terms",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** 1 for the signed contract, 2 for its first renewal, and so on. */
    sequence: integer("sequence").notNull().default(1),
    startsOn: date("starts_on").notNull(),
    /**
     * Required. A fixed-term contract without an end date cannot auto-renew,
     * cannot be given notice against, and cannot be proved to an inspector.
     * `assessContract` reports its absence as a statutory defect; the column
     * being nullable is what lets the defect be *recorded* rather than being
     * unrepresentable and therefore invisible.
     */
    endsOn: date("ends_on"),
    /** Maximum six months from `starts_on`, non-extendable. Term 1 only. */
    probationEndsOn: date("probation_ends_on"),
    /** 30–90 days post-probation. Outside that range it is unenforceable. */
    noticePeriodDays: integer("notice_period_days").notNull().default(30),
    /** Basic pay only. Gratuity accrues on this and not on the allowances. */
    basicSalary: money("basic_salary"),
    /** `{ housing: "1500.00", transport: "500.00" }`. Excluded from gratuity. */
    allowances: jsonb("allowances").notNull().default({}),
    /** Free-form working pattern, e.g. "Sun–Thu 08:00–17:00, 1h break". */
    workingPattern: varchar("working_pattern", { length: 160 }),
    origin: varchar("origin", { length: 16 }).notNull().default("signed"),
    /** The term this one renewed, so the chain is walkable in both directions. */
    renewedFromId: uuid("renewed_from_id"),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    /** The signed PDF in object storage, where one exists. */
    storageKey: text("storage_key"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("contract_terms_sequence_key").on(t.tenantId, t.employeeId, t.sequence),
    index("contract_terms_employee_idx").on(t.tenantId, t.employeeId, t.startsOn),
    // The renewal sweep's exact predicate: active terms whose end date has
    // passed. Without it the nightly job scans every term ever recorded.
    index("contract_terms_expiry_idx")
      .on(t.tenantId, t.endsOn)
      .where(sql`${t.status} = 'active' and ${t.deletedAt} is null`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// HR-7 — Leave
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Carry-over and manual adjustments to a leave year. NOT the balance.
 *
 * ── WHY THERE IS NO `days_taken` COLUMN ─────────────────────────────────────
 *
 * The obvious design stores entitled / taken / remaining and updates them on
 * every approval. It is also the design that drifts: a leave request cancelled
 * by an UPDATE that forgot to decrement, a row deleted directly, a retroactive
 * approval, and the stored balance and the leave calendar disagree — with the
 * stored one being the number that gets paid out.
 *
 * So entitlement is *computed* from the service dates by
 * `annualLeaveEntitlement`, days taken are *counted* from `leave_requests`, and
 * this table holds only the two things neither of those can derive: what was
 * carried over from last year, and any adjustment a human made on purpose, with
 * a reason. Those are facts, not derivations, and facts are what a table is for.
 */
export const leaveBalances = pgTable(
  "leave_balances",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** First day of the leave year this row describes. */
    leaveYearStart: date("leave_year_start").notNull(),
    /** Days brought forward from the previous leave year, per policy. */
    carriedOverDays: integer("carried_over_days").notNull().default(0),
    /** Signed. Negative takes days away, and needs the same reason as adding. */
    adjustmentDays: integer("adjustment_days").notNull().default(0),
    /** Required by the domain layer for any non-zero adjustment. */
    reason: text("reason"),
    adjustedById: uuid("adjusted_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("leave_balances_year_key").on(t.tenantId, t.employeeId, t.leaveYearStart),
    index("leave_balances_employee_idx").on(t.tenantId, t.employeeId),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// HR-8 — Overtime, by rate band
// ═══════════════════════════════════════════════════════════════════════════

// `PAY_BANDS`, not `RATE_BANDS`: the latter already exists in domain/reference.ts
// and means what a customer is charged out of hours, which is the opposite end
// of the transaction from what a worker is paid for working them.
export const PAY_BANDS = ["standard", "overtime", "night", "rest_day"] as const;
export type PayBandKind = (typeof PAY_BANDS)[number];

export const REST_DAY_COMPENSATION = ["substitute_day", "premium_pay"] as const;
export type RestDayCompensation = (typeof REST_DAY_COMPENSATION)[number];

/**
 * Hours worked, split by the rate they are paid at (`HR-8`).
 *
 * One row per employee, per day, per band. The split itself is computed by
 * `splitWorkedWindow` in `packages/core`; this is where the result is kept so
 * that the wage file can be reproduced months later, which is the whole point
 * — "the system computes; it does not disburse", and a computation nobody can
 * re-read is not evidence of anything.
 *
 * `multiplier_basis_points` is stored on the row rather than looked up from the
 * band at read time. Rates are set by statute and statutes change; a historic
 * overtime entry must keep saying what it was actually paid at, not what the
 * current constant says it would be paid at today.
 */
export const overtimeRecords = pgTable(
  "overtime_records",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    workedOn: date("worked_on").notNull(),
    band: varchar("band", { length: 16 }).notNull(),
    minutes: integer("minutes").notNull(),
    /** 12500 is +25%. Integer basis points, never a float. */
    multiplierBasisPoints: integer("multiplier_basis_points").notNull(),
    /** Basic hourly rate applied, so the row can be recomputed by hand. */
    hourlyRate: money("hourly_rate"),
    amount: money("amount"),
    /**
     * Rest-day work is compensated by a substitute day OR at +50%. Which one is
     * a choice somebody makes, and "we agreed a day off" is not evidence six
     * months later.
     */
    restDayCompensation: varchar("rest_day_compensation", { length: 16 }),
    substituteDayOn: date("substitute_day_on"),
    /** `attendance` where derived from clock events; `manual` where typed in. */
    source: varchar("source", { length: 16 }).notNull().default("manual"),
    approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("overtime_records_day_band_key")
      .on(t.tenantId, t.employeeId, t.workedOn, t.band)
      .where(sql`${t.deletedAt} is null`),
    index("overtime_records_period_idx").on(t.tenantId, t.workedOn),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// HR-17 — The WPS wage cycle
// ═══════════════════════════════════════════════════════════════════════════

export const WAGE_CYCLE_STATUSES = ["open", "file_prepared", "transferred", "closed"] as const;
export type WageCycleStatus = (typeof WAGE_CYCLE_STATUSES)[number];

/**
 * One Gregorian month of wages, and whether it reached the workers on time.
 *
 * `HR-17` is the highest-frequency compliance obligation in the business: wages
 * for the previous month are due **on the 1st**, and an establishment is
 * compliant only when at least 85% of total wages due were transferred by that
 * date. The escalation past it costs, in order, the ability to hire, money, a
 * category downgrade, automatic labour disputes and possibly a travel ban.
 *
 * ── WHY BOTH TOTALS ARE STORED ──────────────────────────────────────────────
 *
 * `total_due` and `total_transferred` are kept as columns rather than summed
 * from `wage_payments` on demand, and the reason is the 85% test. That test is
 * against *total wages due*, which includes people whose line never made it
 * into the file — and a sum over the lines that exist can only ever report
 * 100%. The denominator has to be able to be larger than the rows.
 *
 * Payroll is a tax record. Seven-year floor.
 */
export const wageCycles = pgTable(
  "wage_cycles",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** First day of the month the wages are FOR. `2026-08-01` for August pay. */
    periodMonth: date("period_month").notNull(),
    /** Always the 1st of the following month. Stored, not derived, because a
     *  ministerial resolution has moved it before and history must not move. */
    dueOn: date("due_on").notNull(),
    totalDue: money("total_due").notNull().default("0"),
    totalTransferred: money("total_transferred").notNull().default("0"),
    employeeCount: integer("employee_count").notNull().default(0),
    paidEmployeeCount: integer("paid_employee_count").notNull().default(0),
    /** The day the wage-file inputs were produced. `HR-17` wants this by T-3. */
    filePreparedOn: date("file_prepared_on"),
    /** The day the bank confirmed. Null while unconfirmed — the alarm state. */
    confirmedOn: date("confirmed_on"),
    /** The SIF / bank reference. Without one, "transferred" is an assertion. */
    transferReference: varchar("transfer_reference", { length: 64 }),
    confirmedById: uuid("confirmed_by_id").references(() => users.id, { onDelete: "set null" }),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("wage_cycles_period_key").on(t.tenantId, t.periodMonth),
    index("wage_cycles_due_idx").on(t.tenantId, t.dueOn),
  ],
);

/**
 * One employee's line in one wage cycle — the wage file inputs (`HR-17`).
 *
 * Hours, overtime, absences and deductions, produced by T-3 so the transfer can
 * be instructed before the 1st. Deliberately not a payslip and deliberately not
 * a payment instruction: the requirement is explicit that *the system computes;
 * it does not disburse*.
 */
export const wagePayments = pgTable(
  "wage_payments",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    wageCycleId: uuid("wage_cycle_id")
      .notNull()
      .references(() => wageCycles.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    basic: money("basic").notNull().default("0"),
    allowances: money("allowances").notNull().default("0"),
    overtime: money("overtime").notNull().default("0"),
    /** Sum of `salary_deductions` for this cycle. Never includes insurance. */
    deductions: money("deductions").notNull().default("0"),
    net: money("net").notNull().default("0"),
    overtimeMinutes: integer("overtime_minutes").notNull().default(0),
    absenceDays: integer("absence_days").notNull().default(0),
    leaveDays: integer("leave_days").notNull().default(0),
    /** True once this line is confirmed as transferred through WPS. */
    paid: boolean("paid").notNull().default(false),
    paidOn: date("paid_on"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("wage_payments_cycle_employee_key").on(t.wageCycleId, t.employeeId),
    index("wage_payments_employee_idx").on(t.tenantId, t.employeeId),
  ],
);

/**
 * The kinds of deduction that may lawfully be taken from a wage.
 *
 * A **positive** list, mirrored by a CHECK constraint in migration 0015 and by
 * `LAWFUL_DEDUCTION_KINDS` in `packages/core`. All three have to agree, and
 * that redundancy is the point: `HR-6` says the health-insurance premium may
 * not be deducted from salary, and `HR-16` says recruitment costs may never be
 * recovered from a worker. Both are structural requirements — "must be
 * impossible", not "must be discouraged" — and a rule enforced only in a form
 * validator is one `psql` session away from not existing.
 *
 * A negative list would have been defeated by the first person to type the
 * premium in as "other".
 */
// The list itself lives in `packages/core/src/employment.ts`, imported here so
// that the schema, the domain refusal and the CHECK constraint cannot drift
// apart into three lists that agree until the day one of them is edited.
export { LAWFUL_DEDUCTION_KINDS, type DeductionKind } from "@meridian/core";

export const salaryDeductions = pgTable(
  "salary_deductions",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** Null for a standing deduction not yet attached to a month. */
    wageCycleId: uuid("wage_cycle_id").references(() => wageCycles.id, { onDelete: "set null" }),
    /** Constrained to `LAWFUL_DEDUCTION_KINDS` by a CHECK in the migration. */
    kind: varchar("kind", { length: 32 }).notNull(),
    amount: money("amount").notNull(),
    /** Required. A deduction from a protected wage with no stated reason is
     *  indistinguishable from an unlawful one when it is challenged. */
    reason: text("reason").notNull(),
    authorisedById: uuid("authorised_by_id").references(() => users.id, { onDelete: "set null" }),
    appliesOn: date("applies_on"),
    ...timestamps,
  },
  (t) => [
    index("salary_deductions_employee_idx").on(t.tenantId, t.employeeId),
    index("salary_deductions_cycle_idx").on(t.tenantId, t.wageCycleId),
  ],
);
