import { sql, and, eq, isNull } from "drizzle-orm";
import type { TenantScopedTx } from "../index";
import * as schema from "../schema";
import {
  BLOCKING_DOCUMENT_KINDS,
  EMPLOYEE_DOCUMENT_LABEL,
  type AccreditationKind,
  type EmployeeDocumentKind,
} from "../schema/compliance";
import { today, type CalendarDay } from "@meridian/core";

/**
 * Workforce compliance: who may legally be sent to work, and who may not.
 *
 * `HR-9` is the requirement that most justifies building this system at all.
 * Deploying a worker without a valid permit carries **AED 100,000 to AED
 * 1,000,000** under Article 60 of the Labour Law as amended in 2024, multiplied
 * by the number of workers in fictitious-employment cases. `G15` is a
 * zero-tolerance target, and zero-tolerance targets are met by refusing the
 * action, not by reporting on it afterwards.
 *
 * ── BLOCK VERSUS WARN ───────────────────────────────────────────────────────
 *
 * Five documents block: work permit, residence visa, Emirates ID, medical
 * fitness, health insurance. Everything else — including an expired trade
 * certification — warns and requires a recorded reason (`JOB-10`).
 *
 * That split is deliberate and it is the whole design. A system that blocks too
 * much gets worked around, and a workaround is worse than a warning because it
 * is invisible: the dispatcher stops using the assign dialog and phones the
 * technician instead, and then nothing is recorded at all. Each hard block here
 * has a named statutory penalty behind it; adding a sixth requires naming one.
 */

export type BlockReason = "expired_document" | "on_leave" | "inactive";

export interface DispatchBlock {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly reason: BlockReason;
  /** Shown to the dispatcher. Names the document and the date. */
  readonly detail: string;
  /**
   * The consequence, as a number.
   *
   * "AED 100,000–1,000,000" changes behaviour; "a compliance risk" does not.
   * The design document is explicit that compliance messages state the penalty,
   * and this field is why the UI can.
   */
  readonly penalty: string | null;
  /** Days past expiry. Negative is impossible here — these are already expired. */
  readonly daysExpired: number | null;
  /**
   * How many OTHER blocking documents this person also has expired.
   *
   * Zero for almost everybody. It exists because the alternative — returning a
   * row per document — double-counts a person who has let two lapse, which is
   * exactly the person a compliance board most needs to show correctly.
   */
  readonly otherExpiredCount: number;
}

const PERMIT_PENALTY =
  "Deploying a worker without a valid permit carries a penalty of AED 100,000 to AED 1,000,000.";

const INSURANCE_PENALTY =
  "Health insurance is mandatory in Dubai and employer-funded. Lapses carry recurring monthly penalties and block visa processing.";

function penaltyFor(kind: string): string | null {
  switch (kind) {
    case "work_permit":
    case "residence_visa":
    case "emirates_id":
      return PERMIT_PENALTY;
    case "health_insurance":
      return INSURANCE_PENALTY;
    case "medical_fitness":
      return "A lapsed medical fitness certificate blocks visa processing and invalidates the work permit.";
    default:
      return null;
  }
}

/**
 * Technicians who cannot legally be dispatched right now.
 *
 * One query over `employee_documents` where `blocking` is true and the expiry
 * has passed. That is the entire mechanism, and the reason it is one query
 * rather than a rule per document type is the `blocking` column — a new
 * document kind becomes enforceable by being flagged, not by editing this
 * function.
 *
 * Note what is **not** here: technicians with no employee record at all. A
 * subcontracted technician has no employment documents in this system by
 * definition, and blocking everyone without a record would make the feature
 * unusable on day one and get it switched off. `HR-19` puts subcontractor
 * verification on its own footing; conflating the two would hide both.
 */
export async function blockedTechnicians(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly DispatchBlock[]> {
  /*
   * ONE ROW PER TECHNICIAN, not one per document.
   *
   * The first version selected per document, and a person who had let two
   * blocking documents lapse appeared twice: two cards on the compliance board,
   * two entries in the assign dialog's "cannot be assigned" list, and — worse —
   * `workforceSummary` counting them twice, so `deployable = headcount -
   * blocked` under-reported the available workforce. A dispatcher planning a
   * week off that number plans around people who do not exist.
   *
   * Somebody with two lapsed documents is precisely the person a compliance
   * board most needs to render correctly, so this is not an edge case.
   *
   * DISTINCT ON keeps the longest-expired document, which is both the most
   * urgent and the one that reads worst — the right one to lead with. The rest
   * are counted so the card can say there are more without listing them.
   *
   * `now` is Dubai's day, not `current_date` — the Postgres session's, which
   * runs wherever the cluster was initialised. `HR-9`'s block is the one
   * check in this whole system a race against the clock is least affordable:
   * this is the query the assign dialog and the second gate at the moment of
   * assignment both read, and the wrong direction for the error is a lapsed
   * permit reading as still valid for up to a few hours a day.
   */
  const rows = (await tx.execute<{
    technician_id: string;
    full_name: string;
    kind: string;
    expires_at: string;
    days_expired: number;
    other_expired: number;
  }>(sql`
    with expired as (
      select t.id as technician_id,
             t.full_name,
             d.kind,
             d.expires_at,
             (${now}::date - d.expires_at)::int as days_expired
        from employee_documents d
        join employees e on e.id = d.employee_id
        join technicians t on t.id = e.technician_id
       where d.blocking
         and d.expires_at is not null
         and d.expires_at < ${now}::date
         and d.deleted_at is null
         and e.deleted_at is null
         and e.status = 'active'
         and t.is_active
         and t.deleted_at is null
    )
    select distinct on (technician_id)
           technician_id,
           full_name,
           kind,
           expires_at,
           days_expired,
           (count(*) over (partition by technician_id) - 1)::int as other_expired
      from expired
     order by technician_id, expires_at
  `)) as unknown as {
    technician_id: string;
    full_name: string;
    kind: string;
    expires_at: string;
    days_expired: number;
    other_expired: number;
  }[];

  return rows
    .map((r) => ({
      technicianId: r.technician_id,
      technicianName: r.full_name,
      reason: "expired_document" as const,
      detail: `${EMPLOYEE_DOCUMENT_LABEL[r.kind as EmployeeDocumentKind] ?? r.kind} expired ${formatDate(r.expires_at)}`,
      penalty: penaltyFor(r.kind),
      daysExpired: r.days_expired,
      otherExpiredCount: r.other_expired,
    }))
    // DISTINCT ON forces an ordering by technician_id; the caller wants the
    // longest-overdue person first, which is consequence order.
    .sort((a, b) => (b.daysExpired ?? 0) - (a.daysExpired ?? 0));
}

/**
 * The same check for one technician, for the moment of assignment.
 *
 * `blockedTechnicians` populates the dialog; this is the second gate, run
 * inside the transaction that creates the visit. Both exist on purpose: the
 * first is a UI affordance and the second is the control. A dialog rendered
 * thirty seconds ago does not know that a permit expired at midnight, and
 * checking only in the UI is how a race becomes a six-figure penalty.
 */
export async function blockForTechnician(
  tx: TenantScopedTx,
  technicianId: string,
  now: CalendarDay = today(),
): Promise<DispatchBlock | null> {
  const blocks = await blockedTechnicians(tx, now);
  return blocks.find((b) => b.technicianId === technicianId) ?? null;
}

export interface ExpiringDocument {
  readonly employeeId: string;
  readonly technicianId: string | null;
  readonly employeeName: string;
  readonly kind: string;
  readonly label: string;
  readonly expiresAt: Date;
  /** Negative means already expired. */
  readonly daysRemaining: number;
  readonly blocking: boolean;
}

/**
 * Employee documents at or near expiry (`HR-5`).
 *
 * Escalating alert windows are T-90 / T-60 / T-30 / T-7 (§12.1); this returns
 * everything inside the outer window and lets the caller decide which band each
 * one falls in. Already-expired documents are always included, whatever the
 * window, because they are the urgent ones.
 *
 * `now` is Dubai's day, from `today()` — not `current_date`, which is the
 * Postgres session's idea of today and not necessarily the same calendar day.
 * See `findExpiringAccreditations` for the full reasoning; this is one of the
 * queries it refers to as "the other two".
 */
export async function findExpiringEmployeeDocuments(
  tx: TenantScopedTx,
  withinDays = 90,
  now: CalendarDay = today(),
): Promise<readonly ExpiringDocument[]> {
  const rows = (await tx.execute<{
    employee_id: string;
    technician_id: string | null;
    full_name: string;
    kind: string;
    expires_at: string;
    days_remaining: number;
    blocking: boolean;
  }>(sql`
    select e.id as employee_id,
           e.technician_id,
           e.full_name,
           d.kind,
           d.expires_at,
           (d.expires_at - ${now}::date)::int as days_remaining,
           d.blocking
      from employee_documents d
      join employees e on e.id = d.employee_id
     where d.expires_at is not null
       and d.expires_at <= ${now}::date + (${withinDays})::int
       and d.deleted_at is null
       and e.deleted_at is null
       and e.status = 'active'
     order by d.expires_at
  `)) as unknown as {
    employee_id: string;
    technician_id: string | null;
    full_name: string;
    kind: string;
    expires_at: string;
    days_remaining: number;
    blocking: boolean;
  }[];

  return rows.map((r) => ({
    employeeId: r.employee_id,
    technicianId: r.technician_id,
    employeeName: r.full_name,
    kind: r.kind,
    label: EMPLOYEE_DOCUMENT_LABEL[r.kind as EmployeeDocumentKind] ?? r.kind,
    expiresAt: new Date(r.expires_at),
    daysRemaining: r.days_remaining,
    blocking: r.blocking,
  }));
}

export interface ExpiringAccreditation {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly referenceNo: string | null;
  readonly expiresAt: Date;
  readonly daysRemaining: number;
}

/**
 * Company accreditations at or near expiry (`HR-14`).
 *
 * The trade licence is the one that matters most and the one nothing was
 * watching: licence 930137 expires on 23 January 2027, and an expired trade
 * licence stops the business rather than inconveniencing it.
 */
export async function findExpiringAccreditations(
  tx: TenantScopedTx,
  withinDays = 90,
  now: CalendarDay = today(),
): Promise<readonly ExpiringAccreditation[]> {
  // Day counting happens in SQL, as `date - date`, not in JavaScript.
  //
  // Subtracting a JS Date at midnight from `new Date()` and flooring gives 29
  // for a document expiring in 30 days, because the partial day is discarded —
  // and "29 days" on an alert that should read "30" is the kind of quiet
  // wrongness nobody ever chases down. Postgres date arithmetic has no time
  // component to lose. The other two expiry queries do the same.
  //
  // ── BUT THE DAY IS `now`, NOT `current_date` ────────────────────────────
  //
  // `current_date` is the Postgres session's idea of today, and the session
  // timezone is whatever the cluster was initialised with — not `Asia/Dubai`.
  // For the hours where those two disagree, this query and Dubai's calendar
  // are on different days, and the countdown is off by one in the direction
  // that reports a lapsed accreditation — including the trade licence this
  // function exists to watch — as still having a day left. `now` is `today()`,
  // computed in Dubai, and the subtraction stays in SQL: only the day it
  // subtracts changed.
  const rows = (await tx.execute<{
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    expires_at: string;
    days_remaining: number;
  }>(sql`
    select id, kind, name, reference_no, expires_at,
           (expires_at - ${now}::date)::int as days_remaining
      from company_accreditations
     where expires_at is not null
       and expires_at <= ${now}::date + (${withinDays})::int
       and deleted_at is null
     order by expires_at
  `)) as unknown as {
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    expires_at: string;
    days_remaining: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    referenceNo: r.reference_no,
    expiresAt: new Date(r.expires_at),
    daysRemaining: r.days_remaining,
  }));
}

export interface WorkforceSummary {
  readonly headcount: number;
  readonly deployable: number;
  readonly blocked: number;
}

/**
 * The three numbers at the top of the workforce board.
 *
 * `deployable` rather than `available` on purpose: it answers "how many people
 * can legally be sent to work today", which is a different and more useful
 * question than how many are on shift.
 */
export async function workforceSummary(tx: TenantScopedTx): Promise<WorkforceSummary> {
  const [counts] = await tx
    .select({ headcount: sql<number>`count(*)::int` })
    .from(schema.technicians)
    .where(and(eq(schema.technicians.isActive, true), isNull(schema.technicians.deletedAt)));

  const headcount = counts?.headcount ?? 0;
  const blocked = (await blockedTechnicians(tx)).length;

  return { headcount, deployable: headcount - blocked, blocked };
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// ─── The register underneath the report ──────────────────────────────────────
//
// Everything above reports on `employee_documents`. Nothing above puts a row in
// it. `HR-5` is the register itself — passport, visa, Emirates ID, work permit,
// medical fitness, insurance, with expiry dates — and a board rendered over an
// empty table is not a compliance system, it is a screen that always says
// "nothing to worry about". The functions below exist so the board can be wrong
// about something.

/**
 * Dates here are calendar days as `YYYY-MM-DD` strings, never `Date`.
 *
 * A permit expires on a day, not at an instant. Round-tripping one through a
 * JavaScript `Date` parses it as UTC midnight, and anything that then formats
 * it in a negative-offset zone renders the day before — an expiry silently off
 * by one, in the direction that says a lapsed permit is still valid. The
 * `date` columns are strings in Postgres and stay strings all the way to the
 * `<input type="date">`, which speaks exactly this format.
 */
export type CalendarDate = string;

const BLOCKING_KINDS_SQL = sql`array[${sql.join(
  BLOCKING_DOCUMENT_KINDS.map((k) => sql`${k}`),
  sql`, `,
)}]::text[]`;

export interface EmployeeRegisterRow {
  readonly id: string;
  readonly employeeNo: string | null;
  readonly fullName: string;
  readonly technicianId: string | null;
  readonly primaryTrade: string | null;
  readonly status: string;
  readonly documentsOnFile: number;
  /**
   * How many of the five `HR-9` documents have no in-date record at all.
   *
   * A missing document and an expired one are different failures with the same
   * consequence, and only the expired one is visible to `blockedTechnicians` —
   * that query joins `employee_documents`, so a technician with no work permit
   * row whatsoever is not blocked and not reported. This is the count that
   * finds them.
   */
  readonly blockingGaps: number;
}

/**
 * The employment register (`HR-5`), one row per employee.
 *
 * Ordered by exposure rather than by name: gaps first, then people, because the
 * list exists to be acted on and alphabetical order buries the only rows that
 * need anything doing to them.
 *
 * `now` is Dubai's day, not `current_date` — see `findExpiringAccreditations`.
 * `blockingGaps` is what decides which rows sort first, so getting the day
 * wrong here reorders the register, not just one figure on it.
 */
export async function listEmployees(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly EmployeeRegisterRow[]> {
  const rows = (await tx.execute<{
    id: string;
    employee_no: string | null;
    full_name: string;
    technician_id: string | null;
    primary_trade: string | null;
    status: string;
    documents_on_file: number;
    blocking_gaps: number;
  }>(sql`
    select e.id,
           e.employee_no,
           e.full_name,
           e.technician_id,
           t.primary_trade,
           e.status,
           (select count(*)::int
              from employee_documents d
             where d.employee_id = e.id and d.deleted_at is null) as documents_on_file,
           (select count(*)::int
              from unnest(${BLOCKING_KINDS_SQL}) as k
             where not exists (
               select 1 from employee_documents d
                where d.employee_id = e.id
                  and d.kind = k
                  and d.deleted_at is null
                  and d.expires_at is not null
                  and d.expires_at >= ${now}::date
             )) as blocking_gaps
      from employees e
      left join technicians t on t.id = e.technician_id and t.deleted_at is null
     where e.deleted_at is null
     order by blocking_gaps desc, e.full_name
  `)) as unknown as {
    id: string;
    employee_no: string | null;
    full_name: string;
    technician_id: string | null;
    primary_trade: string | null;
    status: string;
    documents_on_file: number;
    blocking_gaps: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    employeeNo: r.employee_no,
    fullName: r.full_name,
    technicianId: r.technician_id,
    primaryTrade: r.primary_trade,
    status: r.status,
    documentsOnFile: r.documents_on_file,
    blockingGaps: r.blocking_gaps,
  }));
}

export interface UnregisteredTechnician {
  readonly id: string;
  readonly fullName: string;
  readonly employeeCode: string;
  readonly primaryTrade: string | null;
}

/**
 * Active technicians with no employment record.
 *
 * Deliberately not treated as a violation. `blockedTechnicians` explains why:
 * subcontracted and manpower-supplied labour legitimately has no employment
 * file here, and blocking everyone without one would get the feature switched
 * off in a week. But an unregistered technician is invisible to every query in
 * this module, so the board has to say who they are — otherwise "0 blocked"
 * means "0 blocked among the people we happen to have paperwork for", and
 * nobody reading it knows that.
 */
export async function techniciansWithoutEmploymentRecord(
  tx: TenantScopedTx,
): Promise<readonly UnregisteredTechnician[]> {
  const rows = (await tx.execute<{
    id: string;
    full_name: string;
    employee_code: string;
    primary_trade: string | null;
  }>(sql`
    select t.id, t.full_name, t.employee_code, t.primary_trade
      from technicians t
     where t.is_active
       and t.deleted_at is null
       and not exists (
         select 1 from employees e
          where e.technician_id = t.id and e.deleted_at is null
       )
     order by t.full_name
  `)) as unknown as {
    id: string;
    full_name: string;
    employee_code: string;
    primary_trade: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    employeeCode: r.employee_code,
    primaryTrade: r.primary_trade,
  }));
}

export interface EmployeeDocumentRow {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly referenceNo: string | null;
  readonly issuedAt: CalendarDate | null;
  readonly expiresAt: CalendarDate | null;
  readonly blocking: boolean;
  readonly note: string | null;
  /** Null where no expiry is recorded. Negative means already expired. */
  readonly daysRemaining: number | null;
}

export interface EmployeeRecord {
  readonly id: string;
  readonly employeeNo: string | null;
  readonly fullName: string;
  readonly technicianId: string | null;
  readonly technicianName: string | null;
  readonly primaryTrade: string | null;
  readonly status: string;
  readonly contractType: string;
  readonly documents: readonly EmployeeDocumentRow[];
  /** The `HR-9` kinds with no in-date document. Drives the gap list on the page. */
  readonly missingBlockingKinds: readonly EmployeeDocumentKind[];
}

/**
 * One employee and every document on file. Null when the id is not this
 * tenant's.
 *
 * `now` is Dubai's day, not `current_date` — see `findExpiringAccreditations`.
 * `missingBlockingKinds` below is derived from `daysRemaining >= 0` on each
 * document, so the wrong day here does not just mislabel one row — it can
 * move a document across the in-date/expired line and change which `HR-9`
 * kinds this employee is reported as missing.
 */
export async function getEmployeeRecord(
  tx: TenantScopedTx,
  employeeId: string,
  now: CalendarDay = today(),
): Promise<EmployeeRecord | null> {
  const headers = (await tx.execute<{
    id: string;
    employee_no: string | null;
    full_name: string;
    technician_id: string | null;
    technician_name: string | null;
    primary_trade: string | null;
    status: string;
    contract_type: string;
  }>(sql`
    select e.id, e.employee_no, e.full_name, e.technician_id,
           t.full_name as technician_name, t.primary_trade,
           e.status, e.contract_type
      from employees e
      left join technicians t on t.id = e.technician_id and t.deleted_at is null
     where e.id = ${employeeId} and e.deleted_at is null
  `)) as unknown as {
    id: string;
    employee_no: string | null;
    full_name: string;
    technician_id: string | null;
    technician_name: string | null;
    primary_trade: string | null;
    status: string;
    contract_type: string;
  }[];

  const header = headers[0];
  if (!header) return null;

  const docs = (await tx.execute<{
    id: string;
    kind: string;
    reference_no: string | null;
    issued_at: string | null;
    expires_at: string | null;
    blocking: boolean;
    note: string | null;
    days_remaining: number | null;
  }>(sql`
    select id, kind, reference_no, issued_at, expires_at, blocking, note,
           (expires_at - ${now}::date)::int as days_remaining
      from employee_documents
     where employee_id = ${employeeId} and deleted_at is null
     order by expires_at nulls last
  `)) as unknown as {
    id: string;
    kind: string;
    reference_no: string | null;
    issued_at: string | null;
    expires_at: string | null;
    blocking: boolean;
    note: string | null;
    days_remaining: number | null;
  }[];

  const documents = docs.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: EMPLOYEE_DOCUMENT_LABEL[d.kind as EmployeeDocumentKind] ?? d.kind,
    referenceNo: d.reference_no,
    issuedAt: d.issued_at,
    expiresAt: d.expires_at,
    blocking: d.blocking,
    note: d.note,
    daysRemaining: d.days_remaining,
  }));

  const inDate = new Set(
    documents.filter((d) => d.daysRemaining !== null && d.daysRemaining >= 0).map((d) => d.kind),
  );

  return {
    id: header.id,
    employeeNo: header.employee_no,
    fullName: header.full_name,
    technicianId: header.technician_id,
    technicianName: header.technician_name,
    primaryTrade: header.primary_trade,
    status: header.status,
    contractType: header.contract_type,
    documents,
    missingBlockingKinds: BLOCKING_DOCUMENT_KINDS.filter((k) => !inDate.has(k)),
  };
}

/**
 * Open an employment record, optionally against an existing technician.
 *
 * `technicianId` is what makes the record enforceable: `blockedTechnicians`
 * joins through it, so an employee file with no technician attached is a filing
 * cabinet entry that can never stop a dispatch.
 */
export async function createEmployeeRecord(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: { fullName: string; technicianId?: string; employeeNo?: string },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(schema.employees)
    .values({
      tenantId: ctx.tenantId,
      fullName: input.fullName,
      technicianId: input.technicianId ?? null,
      employeeNo: input.employeeNo ?? null,
    })
    .returning({ id: schema.employees.id });

  if (!row) throw new Error("Could not open the employment record.");
  return row;
}

/**
 * Record or replace one document for an employee.
 *
 * Upsert rather than insert, on the partial unique index over
 * `(employee_id, kind)`: renewing a work permit is the same document with a new
 * expiry, and letting the old row survive alongside the new one would leave an
 * expired blocking document in the table forever — permanently blocking a
 * technician whose paperwork is actually in order.
 *
 * `blocking` is derived here from `BLOCKING_DOCUMENT_KINDS` and is not an
 * input. It is the field that decides whether a lapse is a wall or a sign, and
 * a form that could set it would let anyone downgrade a work permit to a
 * warning from the browser.
 */
export async function recordEmployeeDocument(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: {
    employeeId: string;
    kind: EmployeeDocumentKind;
    referenceNo?: string;
    issuedAt?: CalendarDate;
    expiresAt?: CalendarDate;
    note?: string;
  },
): Promise<{ id: string }> {
  const blocking = BLOCKING_DOCUMENT_KINDS.includes(input.kind);

  const [row] = await tx
    .insert(schema.employeeDocuments)
    .values({
      tenantId: ctx.tenantId,
      employeeId: input.employeeId,
      kind: input.kind,
      referenceNo: input.referenceNo ?? null,
      issuedAt: input.issuedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      note: input.note ?? null,
      blocking,
    })
    .onConflictDoUpdate({
      target: [schema.employeeDocuments.employeeId, schema.employeeDocuments.kind],
      targetWhere: isNull(schema.employeeDocuments.deletedAt),
      set: {
        referenceNo: input.referenceNo ?? null,
        issuedAt: input.issuedAt ?? null,
        expiresAt: input.expiresAt ?? null,
        note: input.note ?? null,
        blocking,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schema.employeeDocuments.id });

  if (!row) throw new Error("Could not record the document.");
  return row;
}

/**
 * Withdraw a document.
 *
 * Soft delete, and that is not a convention being followed for its own sake:
 * `HR-15` requires employment records to survive two years past termination,
 * and "which documents did we hold on the day we sent this person to site" is
 * exactly the question a labour inspection asks. A hard delete answers it with
 * silence.
 */
export async function removeEmployeeDocument(tx: TenantScopedTx, documentId: string): Promise<void> {
  await tx
    .update(schema.employeeDocuments)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.employeeDocuments.id, documentId));
}

export interface AccreditationRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly referenceNo: string | null;
  readonly issuingBody: string | null;
  readonly grade: string | null;
  readonly expiresAt: CalendarDate | null;
  readonly daysRemaining: number | null;
}

/**
 * The whole company accreditation register (`HR-14`), expiring or not.
 *
 * `findExpiringAccreditations` answers "what needs renewing"; this answers
 * "what do we hold", which is the question the tender pack (`CON-12`) asks and
 * the question that has been answered from memory until now. The previous build
 * published three ISO certificates the company does not hold; nothing is
 * publishable that is not a row here.
 *
 * `now` is Dubai's day, not `current_date` — see `findExpiringAccreditations`.
 */
export async function listAccreditations(
  tx: TenantScopedTx,
  now: CalendarDay = today(),
): Promise<readonly AccreditationRow[]> {
  const rows = (await tx.execute<{
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    issuing_body: string | null;
    grade: string | null;
    expires_at: string | null;
    days_remaining: number | null;
  }>(sql`
    select id, kind, name, reference_no, issuing_body, grade, expires_at,
           (expires_at - ${now}::date)::int as days_remaining
      from company_accreditations
     where deleted_at is null
     order by expires_at nulls last
  `)) as unknown as {
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    issuing_body: string | null;
    grade: string | null;
    expires_at: string | null;
    days_remaining: number | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    referenceNo: r.reference_no,
    issuingBody: r.issuing_body,
    grade: r.grade,
    expiresAt: r.expires_at,
    daysRemaining: r.days_remaining,
  }));
}

/** Record a company accreditation (`HR-14`). */
export async function recordAccreditation(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: {
    kind: AccreditationKind;
    name: string;
    referenceNo?: string;
    issuingBody?: string;
    grade?: string;
    issuedAt?: CalendarDate;
    expiresAt?: CalendarDate;
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(schema.companyAccreditations)
    .values({
      tenantId: ctx.tenantId,
      kind: input.kind,
      name: input.name,
      referenceNo: input.referenceNo ?? null,
      issuingBody: input.issuingBody ?? null,
      grade: input.grade ?? null,
      issuedAt: input.issuedAt ?? null,
      expiresAt: input.expiresAt ?? null,
    })
    .returning({ id: schema.companyAccreditations.id });

  if (!row) throw new Error("Could not record the accreditation.");
  return row;
}

/** Withdraw an accreditation. Soft delete, for the reason given above. */
export async function removeAccreditation(tx: TenantScopedTx, accreditationId: string): Promise<void> {
  await tx
    .update(schema.companyAccreditations)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.companyAccreditations.id, accreditationId));
}
