import { sql, and, eq, isNull } from "drizzle-orm";
import type { TenantScopedTx } from "../index";
import * as schema from "../schema";
import {
  BLOCKING_DOCUMENT_KINDS,
  EMPLOYEE_DOCUMENT_LABEL,
  type AccreditationKind,
  type EmployeeDocumentKind,
} from "../schema/compliance";
import {
  today,
  addDays,
  daysBetween,
  dubaiDateKey,
  assessInjuryNotification,
  POLICE_REPORTABLE_SEVERITIES,
  ROPE_ACCESS_SERVICE_SLUGS,
  RAMS_REVIEW_WARN_DAYS,
  PPE_REPLACEMENT_WARN_DAYS,
  type CalendarDay,
  type InjuryAssessment,
  type InjuryCause,
  type InjurySeverity,
  type WorkInjuryKind,
  type RamsKind,
  type RamsStatus,
  type PpeItemKind,
} from "@meridian/core";

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

// ═══════════════════════════════════════════════════════════════════════════
// HR-11 — The work injury register and the MOHRE notification clock
// ═══════════════════════════════════════════════════════════════════════════
//
// ── BLOCK OR WARN ──────────────────────────────────────────────────────────
//
// Warn, loudly, and block nothing. The reasoning is on `assessInjuryNotification`
// in `packages/core` and it is not repeated in full here, but the operative
// half is: the one thing this system must never do is make recording an injury
// expensive. A register that stopped work is a register people stop writing in,
// and an unwritten register is exactly the failure the statutory obligation
// exists to prevent.
//
// ── WHY THE CLOCK IS HOURLY AND NOT DAILY ──────────────────────────────────
//
// The WPS ladder is the house pattern for a statutory clock that escalates as
// it runs down, and this is the same shape with a much shorter fuse. A nightly
// job against a 48-hour window gets two chances at it and can be up to
// twenty-four hours late on each — so the whole final band would routinely be
// skipped. `/api/cron/hse` runs hourly for that reason alone.

/** What `injuryRegister` and the hourly clock both return. */
export interface InjuryRecord {
  readonly id: string;
  readonly reference: string;
  readonly employeeId: string | null;
  /** Null once the employee has been purged. The register entry survives. */
  readonly employeeName: string | null;
  readonly employeeNo: string | null;
  readonly kind: WorkInjuryKind;
  readonly occurredAt: Date;
  /** Dubai's calendar day. Not the session's. */
  readonly occurredOn: CalendarDay;
  readonly becameKnownAt: Date;
  readonly severity: InjurySeverity;
  readonly cause: InjuryCause;
  readonly location: string | null;
  readonly description: string;
  readonly daysLost: number | null;
  readonly mohreNotifiedAt: Date | null;
  readonly mohreReference: string | null;
  readonly insurerNotifiedAt: Date | null;
  readonly insurerClaimReference: string | null;
  readonly policeReference: string | null;
  readonly investigationCompletedOn: CalendarDay | null;
  readonly correctiveAction: string | null;
  readonly assessment: InjuryAssessment;
  /**
   * True where the severity is one the police must be told about immediately
   * and no police reference has been recorded.
   *
   * A standing flag, never a countdown. "Immediately" is not a countdown, and a
   * 48-hour bar against it would read as permission to wait two days.
   */
  readonly policeReportOutstanding: boolean;
}

interface InjuryRow extends Record<string, unknown> {
  id: string;
  reference: string;
  employee_id: string | null;
  employee_name: string | null;
  employee_no: string | null;
  kind: string;
  occurred_at: string;
  occurred_on: string;
  became_known_at: string;
  severity: string;
  cause: string;
  location: string | null;
  description: string;
  days_lost: number | null;
  mohre_notified_at: string | null;
  mohre_reference: string | null;
  insurer_notified_at: string | null;
  insurer_claim_reference: string | null;
  police_reference: string | null;
  investigation_completed_on: string | null;
  corrective_action: string | null;
}

function toInjuryRecord(r: InjuryRow, now: Date): InjuryRecord {
  const severity = r.severity as InjurySeverity;
  const assessment = assessInjuryNotification(
    {
      occurredAt: new Date(r.occurred_at),
      becameKnownAt: new Date(r.became_known_at),
      mohreNotifiedAt: r.mohre_notified_at ? new Date(r.mohre_notified_at) : null,
      insurerNotifiedAt: r.insurer_notified_at ? new Date(r.insurer_notified_at) : null,
    },
    now,
  );

  return {
    id: r.id,
    reference: r.reference,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    employeeNo: r.employee_no,
    kind: r.kind as WorkInjuryKind,
    occurredAt: new Date(r.occurred_at),
    occurredOn: r.occurred_on,
    becameKnownAt: new Date(r.became_known_at),
    severity,
    cause: r.cause as InjuryCause,
    location: r.location,
    description: r.description,
    daysLost: r.days_lost,
    mohreNotifiedAt: r.mohre_notified_at ? new Date(r.mohre_notified_at) : null,
    mohreReference: r.mohre_reference,
    insurerNotifiedAt: r.insurer_notified_at ? new Date(r.insurer_notified_at) : null,
    insurerClaimReference: r.insurer_claim_reference,
    policeReference: r.police_reference,
    investigationCompletedOn: r.investigation_completed_on,
    correctiveAction: r.corrective_action,
    assessment,
    policeReportOutstanding:
      POLICE_REPORTABLE_SEVERITIES.includes(severity) && r.police_reference === null,
  };
}

// One projection, used by every read below, so the register screen and the
// hourly job cannot drift into disagreeing about what an injury record is.
//
// `occurred_on` is SELECTED, never recomputed — the column already holds
// Dubai's day and `(occurred_at at time zone 'Asia/Dubai')::date` here would be
// a second answer to a question that already has one.
const INJURY_COLUMNS = sql`
  i.id,
  i.reference,
  i.employee_id,
  e.full_name as employee_name,
  i.employee_no,
  i.kind,
  i.occurred_at,
  i.occurred_on,
  i.became_known_at,
  i.severity,
  i.cause,
  i.location,
  i.description,
  i.days_lost,
  i.mohre_notified_at,
  i.mohre_reference,
  i.insurer_notified_at,
  i.insurer_claim_reference,
  i.police_reference,
  i.investigation_completed_on,
  i.corrective_action
`;

/**
 * Record a work injury or occupational disease.
 *
 * ── THE TWO INSTANTS ────────────────────────────────────────────────────────
 *
 * `occurredAt` is when it happened; `becameKnownAt` is when the employer
 * learned of it, and the 48-hour clock runs from the second. They are the same
 * instant for an injury somebody witnessed, which is why the parameter defaults
 * — but an occupational disease arrives as a diagnosis, sometimes years after
 * the exposure, and starting the clock at the exposure would report every such
 * record as an immediate statutory breach on the day it was entered.
 *
 * ── AND THE DAY ─────────────────────────────────────────────────────────────
 *
 * `occurred_on` is written here, from **Dubai's** key, and never by a database
 * default. `current_date` is the Postgres session's calendar day — this
 * cluster's session runs at Asia/Dhaka, two hours ahead of Dubai — so for
 * roughly two hours in every twenty-four it is tomorrow. A night-shift injury
 * at 01:00 Dubai is 21:00 UTC the previous evening, and filed under the wrong
 * day it lands in the wrong month of the register.
 */
export async function recordWorkInjury(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    kind?: WorkInjuryKind;
    occurredAt: Date;
    /** Defaults to `occurredAt`. Later only for an occupational disease. */
    becameKnownAt?: Date;
    severity: InjurySeverity;
    cause: InjuryCause;
    location?: string | null;
    jobId?: string | null;
    description: string;
    daysLost?: number | null;
    medicalReportKey?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; reference: string }> {
  const becameKnownAt = input.becameKnownAt ?? input.occurredAt;
  if (becameKnownAt.getTime() < input.occurredAt.getTime()) {
    throw new Error(
      "An employer cannot have learned of an injury before it happened. Check the two dates.",
    );
  }
  if (!input.description.trim()) {
    throw new Error("Record what happened. A register entry with no description is a date.");
  }

  // Allocated by the database, for the reason `app_next_reference` states: two
  // people recording an incident in the same minute would otherwise both read
  // the same count and one would lose on the unique index — at the exact moment
  // when the thing that must not happen is a record failing to be written.
  const refRows = (await tx.execute<{ reference: string }>(
    // Dubai's year, from the Dubai key — not `getUTCFullYear`. An injury at
    // 01:00 Dubai on 1 January is 21:00 UTC on 31 December, and the UTC year
    // would file it under the previous year's reference series while
    // `occurred_on` two lines below filed it under the new one.
    sql`select app_next_reference('INJ', ${Number(dubaiDateKey(input.occurredAt).slice(0, 4))}) as reference`,
  )) as unknown as { reference: string }[];
  const reference = refRows[0]?.reference;
  if (!reference) throw new Error("Could not allocate an injury register reference.");

  // Frozen at insert. It survives the HR-15 purge that nulls `employee_id`, and
  // it is what ties the surviving register entry to the audit row that recorded
  // the purge — `purgeExpiredEmployees` writes exactly this value.
  const empRows = (await tx.execute<{ employee_no: string | null }>(sql`
    select employee_no from employees where id = ${input.employeeId}::uuid
  `)) as unknown as { employee_no: string | null }[];
  if (empRows.length === 0) throw new Error("No such employee in this tenant.");

  const [row] = await tx
    .insert(schema.workInjuries)
    .values({
      tenantId: ctx.tenantId,
      reference,
      employeeId: input.employeeId,
      employeeNo: empRows[0]?.employee_no ?? null,
      kind: input.kind ?? "work_injury",
      occurredAt: input.occurredAt,
      // Dubai's day. See the note above; this is the whole reason the column
      // exists rather than being derived at read time.
      occurredOn: dubaiDateKey(input.occurredAt),
      becameKnownAt,
      severity: input.severity,
      cause: input.cause,
      location: input.location ?? null,
      jobId: input.jobId ?? null,
      description: input.description.trim(),
      daysLost: input.daysLost ?? null,
      medicalReportKey: input.medicalReportKey ?? null,
      recordedById: ctx.userId ?? null,
      note: input.note ?? null,
    })
    .returning({ id: schema.workInjuries.id });

  if (!row) throw new Error("Could not record the injury.");
  return { id: row.id, reference };
}

/**
 * Record that MOHRE was notified. The only thing that stops the clock.
 *
 * `notifiedAt` defaults to now rather than being derivable from anything: the
 * notification is an act somebody performed at an instant, and back-dating it
 * has to be possible (the call was made yesterday and typed in this morning)
 * while being visible. The audit trigger on `work_injuries` records who set it
 * and when they set it, which is the pair that matters if the two disagree.
 *
 * A reference without an instant is refused by a CHECK constraint in migration
 * 0041, so a half-recorded notification cannot leave the record alarming for
 * ever while somebody insists it was reported.
 */
export async function recordMohreNotification(
  tx: TenantScopedTx,
  injuryId: string,
  input: { reference?: string | null; notifiedAt?: Date },
): Promise<void> {
  await tx
    .update(schema.workInjuries)
    .set({
      mohreNotifiedAt: input.notifiedAt ?? new Date(),
      mohreReference: input.reference?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(schema.workInjuries.id, injuryId));
}

/** Record that the insurer was notified, and the claim reference. */
export async function recordInsurerNotification(
  tx: TenantScopedTx,
  injuryId: string,
  input: { claimReference?: string | null; notifiedAt?: Date },
): Promise<void> {
  await tx
    .update(schema.workInjuries)
    .set({
      insurerNotifiedAt: input.notifiedAt ?? new Date(),
      insurerClaimReference: input.claimReference?.trim() || null,
      updatedAt: new Date(),
    })
    .where(eq(schema.workInjuries.id, injuryId));
}

/**
 * Close the investigation, and say what was changed as a result.
 *
 * `ramsId` is the join between `HR-11` and `HR-12`. An injury whose corrective
 * action was "the method statement was rewritten" points at the pack that
 * replaced it, so the next person to read the register can see whether anything
 * actually happened — which is the difference between a register and a list of
 * accidents.
 */
export async function recordInjuryInvestigation(
  tx: TenantScopedTx,
  injuryId: string,
  input: {
    completedOn?: CalendarDay;
    correctiveAction: string;
    ramsId?: string | null;
    daysLost?: number | null;
    policeReference?: string | null;
  },
): Promise<void> {
  if (!input.correctiveAction.trim()) {
    throw new Error(
      "Say what was changed. An investigation closed with no corrective action is a record that nothing happened.",
    );
  }

  await tx
    .update(schema.workInjuries)
    .set({
      // Dubai's day, defaulted here rather than by `current_date` in SQL.
      investigationCompletedOn: input.completedOn ?? today(),
      correctiveAction: input.correctiveAction.trim(),
      ramsId: input.ramsId ?? null,
      ...(input.daysLost === undefined ? {} : { daysLost: input.daysLost }),
      ...(input.policeReference === undefined
        ? {}
        : { policeReference: input.policeReference?.trim() || null }),
      updatedAt: new Date(),
    })
    .where(eq(schema.workInjuries.id, injuryId));
}

/**
 * The register, most recent first.
 *
 * Bounded by Dubai's calendar day on both ends where a window is given, because
 * "injuries in August" is a question about a month in Dubai and not about a
 * month in whatever timezone this cluster was initialised with.
 */
export async function injuryRegister(
  tx: TenantScopedTx,
  options?: { from?: CalendarDay; to?: CalendarDay; limit?: number; now?: Date },
): Promise<readonly InjuryRecord[]> {
  const now = options?.now ?? new Date();
  const from = options?.from ?? null;
  const to = options?.to ?? null;
  const limit = Math.min(Math.max(options?.limit ?? 200, 1), 1000);

  const rows = (await tx.execute<InjuryRow>(sql`
    select ${INJURY_COLUMNS}
      from work_injuries i
      left join employees e on e.id = i.employee_id
     where i.deleted_at is null
       and (${from}::date is null or i.occurred_on >= ${from}::date)
       and (${to}::date is null or i.occurred_on <= ${to}::date)
     order by i.occurred_at desc
     limit ${limit}
  `)) as unknown as InjuryRow[];

  return rows.map((r) => toInjuryRecord(r, now));
}

/**
 * Injuries MOHRE has not been told about. The hourly job's whole input.
 *
 * Oldest first — consequence order, as everywhere else in this application. The
 * one closest to the end of its window is the one somebody has to act on now.
 *
 * No date filter. A record that went unnotified for a week does not stop being
 * a live statutory obligation because the window closed; the ladder is still
 * climbing on it, exactly as the WPS sweep keeps reporting June in September.
 */
export async function openInjuryNotifications(
  tx: TenantScopedTx,
  now: Date = new Date(),
): Promise<readonly InjuryRecord[]> {
  const rows = (await tx.execute<InjuryRow>(sql`
    select ${INJURY_COLUMNS}
      from work_injuries i
      left join employees e on e.id = i.employee_id
     where i.deleted_at is null
       and (i.mohre_notified_at is null or i.insurer_notified_at is null)
     order by i.became_known_at asc
  `)) as unknown as InjuryRow[];

  return rows.map((r) => toInjuryRecord(r, now)).filter((r) => r.assessment.alerting);
}

/** One record, for the detail view and for the actions that write to it. */
export async function workInjury(
  tx: TenantScopedTx,
  injuryId: string,
  now: Date = new Date(),
): Promise<InjuryRecord | null> {
  const rows = (await tx.execute<InjuryRow>(sql`
    select ${INJURY_COLUMNS}
      from work_injuries i
      left join employees e on e.id = i.employee_id
     where i.id = ${injuryId}::uuid
       and i.deleted_at is null
  `)) as unknown as InjuryRow[];

  const row = rows[0];
  return row ? toInjuryRecord(row, now) : null;
}

export interface InjuryStatistics {
  /** The Dubai calendar year this covers. */
  readonly year: number;
  readonly total: number;
  readonly lostTimeInjuries: number;
  readonly daysLost: number;
  readonly notifiedLate: number;
  readonly stillUnnotified: number;
  readonly investigationsOutstanding: number;
}

/**
 * The register's own totals, for one Dubai calendar year.
 *
 * ── WHY THE YEAR IS BOUNDED IN DUBAI'S DAY ─────────────────────────────────
 *
 * The obvious query is `extract(year from occurred_at)`, and it is wrong for
 * two hours out of every twenty-four in this deployment. An injury at 02:00
 * Dubai on 1 January is 22:00 UTC on 31 December, so it counts into the
 * previous year — and the year-end total is the one number anybody ever
 * compares against last year's.
 *
 * `occurred_on` already holds Dubai's day, so bounding on it is both correct
 * and index-friendly. That is what the column is for.
 */
export async function injuryStatistics(
  tx: TenantScopedTx,
  options?: { year?: number; now?: Date },
): Promise<InjuryStatistics> {
  const now = options?.now ?? new Date();
  // Dubai's year, not the host's. `today()` is the Dubai key.
  const year = options?.year ?? Number(today(now).slice(0, 4));
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const records = await injuryRegister(tx, { from, to, limit: 1000, now });

  return {
    year,
    total: records.length,
    lostTimeInjuries: records.filter(
      (r) => r.severity === "lost_time" || r.severity === "serious" || r.severity === "fatal",
    ).length,
    daysLost: records.reduce((sum, r) => sum + (r.daysLost ?? 0), 0),
    notifiedLate: records.filter((r) => r.assessment.stage === "notified_late").length,
    stillUnnotified: records.filter((r) => !r.assessment.mohreNotified).length,
    investigationsOutstanding: records.filter((r) => r.investigationCompletedOn === null).length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HR-12 — HSE records: RAMS, toolbox talks, PPE, rope access
// ═══════════════════════════════════════════════════════════════════════════

export interface RamsRecord {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly kind: RamsKind;
  readonly tradeSlug: string | null;
  readonly serviceSlug: string | null;
  readonly version: number;
  readonly status: RamsStatus;
  readonly approvedOn: CalendarDay | null;
  readonly reviewDueOn: CalendarDay | null;
  /** Negative once the review date has passed. Null when there is no date. */
  readonly daysToReview: number | null;
  readonly hazardCount: number;
  readonly storageKey: string | null;
}

/**
 * Record a risk assessment or method statement.
 *
 * A revision is a NEW row with the next version, never an edit in place — the
 * same rule `employment_contract_terms` follows, and for the same reason: the
 * pack that was briefed at a toolbox talk in March has to still say in December
 * what it said in March, because that is what somebody was told to do.
 */
export async function recordRams(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: {
    title: string;
    kind?: RamsKind;
    tradeSlug?: string | null;
    serviceSlug?: string | null;
    jobId?: string | null;
    version?: number;
    hazards?: readonly { hazard: string; control: string; residualRisk?: string }[];
    storageKey?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; reference: string }> {
  if (!input.title.trim()) throw new Error("A risk assessment needs a title.");

  const refRows = (await tx.execute<{ reference: string }>(
    // Dubai's year, from the Dubai key. A pack raised at 02:00 Dubai on 1
    // January belongs to the new year's reference series.
    sql`select app_next_reference('RAM', ${Number(today().slice(0, 4))}) as reference`,
  )) as unknown as { reference: string }[];
  const reference = refRows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a RAMS reference.");

  const [row] = await tx
    .insert(schema.hseRams)
    .values({
      tenantId: ctx.tenantId,
      reference,
      title: input.title.trim(),
      kind: input.kind ?? "rams",
      tradeSlug: input.tradeSlug ?? null,
      serviceSlug: input.serviceSlug ?? null,
      jobId: input.jobId ?? null,
      version: input.version ?? 1,
      status: "draft",
      hazards: input.hazards ?? [],
      storageKey: input.storageKey ?? null,
      note: input.note ?? null,
    })
    .returning({ id: schema.hseRams.id });

  if (!row) throw new Error("Could not record the risk assessment.");
  return { id: row.id, reference };
}

/**
 * Approve a pack, and set the date it falls out of review.
 *
 * Both dates default to **Dubai's** day and Dubai's day plus a year. The review
 * interval is a year because that is the ordinary practice and because a pack
 * has to be re-read on any material change anyway — which is an event, not a
 * date, and is what `recordInjuryInvestigation`'s `ramsId` exists to record.
 */
export async function approveRams(
  tx: TenantScopedTx,
  ramsId: string,
  input: { approvedById?: string | null; approvedOn?: CalendarDay; reviewDueOn?: CalendarDay },
): Promise<void> {
  const approvedOn = input.approvedOn ?? today();
  const reviewDueOn = input.reviewDueOn ?? addDays(approvedOn, 365);

  if (daysBetween(approvedOn, reviewDueOn) <= 0) {
    throw new Error("The review date has to be after the approval date.");
  }

  await tx
    .update(schema.hseRams)
    .set({
      status: "approved",
      approvedById: input.approvedById ?? null,
      approvedOn,
      reviewDueOn,
      updatedAt: new Date(),
    })
    .where(eq(schema.hseRams.id, ramsId));
}

/**
 * RAMS packs, optionally only those falling out of review.
 *
 * `withinDays` is an upper bound rather than a range: a pack whose review date
 * passed last month is inside a 30-day window, and it is the one that matters
 * most. Same shape as `listRetention({ dueWithinDays })`.
 *
 * ── THE DAY ────────────────────────────────────────────────────────────────
 *
 * `${now}::date` is Dubai's day, passed in from `today()`. NOT `current_date`,
 * which is this Postgres session's day and is a day ahead of Dubai's for two
 * hours out of every twenty-four — long enough for a pack to read as still in
 * review on the morning it went out of it.
 */
export async function listRams(
  tx: TenantScopedTx,
  options?: { withinDays?: number; approvedOnly?: boolean; now?: CalendarDay },
): Promise<readonly RamsRecord[]> {
  const now = options?.now ?? today();
  const withinDays = options?.withinDays ?? null;
  const approvedOnly = options?.approvedOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    kind: string;
    trade_slug: string | null;
    service_slug: string | null;
    version: number;
    status: string;
    approved_on: string | null;
    review_due_on: string | null;
    days_to_review: number | null;
    hazard_count: number;
    storage_key: string | null;
  }>(sql`
    select r.id,
           r.reference,
           r.title,
           r.kind,
           r.trade_slug,
           r.service_slug,
           r.version,
           r.status,
           r.approved_on,
           r.review_due_on,
           case when r.review_due_on is null then null
                else (r.review_due_on - ${now}::date)::int end as days_to_review,
           jsonb_array_length(coalesce(r.hazards, '[]'::jsonb))::int as hazard_count,
           r.storage_key
      from hse_rams r
     where r.deleted_at is null
       and (${approvedOnly}::boolean is false or r.status = 'approved')
       and (
             ${withinDays}::int is null
             or (r.review_due_on is not null and r.review_due_on <= ${now}::date + ${withinDays}::int)
           )
     order by r.review_due_on asc nulls last, r.reference asc
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    kind: string;
    trade_slug: string | null;
    service_slug: string | null;
    version: number;
    status: string;
    approved_on: string | null;
    review_due_on: string | null;
    days_to_review: number | null;
    hazard_count: number;
    storage_key: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    kind: r.kind as RamsKind,
    tradeSlug: r.trade_slug,
    serviceSlug: r.service_slug,
    version: r.version,
    status: r.status as RamsStatus,
    approvedOn: r.approved_on,
    reviewDueOn: r.review_due_on,
    daysToReview: r.days_to_review,
    hazardCount: r.hazard_count,
    storageKey: r.storage_key,
  }));
}

export interface ToolboxTalkRecord {
  readonly id: string;
  readonly heldOn: CalendarDay;
  readonly topic: string;
  readonly ramsId: string | null;
  readonly ramsReference: string | null;
  readonly presenterName: string | null;
  readonly durationMinutes: number | null;
  readonly attendeeCount: number;
  /** Attendees who never signed. The number an inspector actually asks about. */
  readonly unacknowledgedCount: number;
}

/**
 * Record a toolbox talk and who was at it.
 *
 * The attendance is written in the same transaction as the talk, deliberately.
 * A talk row with no attendees is a plan, and the question after an incident is
 * "was this person briefed" — which a topic and a date cannot answer. Two
 * separate calls would make the empty state reachable, and the empty state is
 * the one that proves nothing.
 *
 * `heldOn` defaults to **Dubai's** day.
 */
export async function recordToolboxTalk(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    topic: string;
    heldOn?: CalendarDay;
    employeeIds: readonly string[];
    ramsId?: string | null;
    jobId?: string | null;
    presenterName?: string | null;
    durationMinutes?: number | null;
    storageKey?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; attendees: number }> {
  if (!input.topic.trim()) throw new Error("A toolbox talk needs a topic.");
  const employeeIds = [...new Set(input.employeeIds)];
  if (employeeIds.length === 0) {
    throw new Error(
      "Record who was there. A toolbox talk with no attendees proves nothing, and proving who was briefed is the only reason this record exists.",
    );
  }
  if (!ctx.userId && !input.presenterName?.trim()) {
    throw new Error("Say who gave the talk.");
  }

  const [row] = await tx
    .insert(schema.toolboxTalks)
    .values({
      tenantId: ctx.tenantId,
      heldOn: input.heldOn ?? today(),
      topic: input.topic.trim(),
      ramsId: input.ramsId ?? null,
      jobId: input.jobId ?? null,
      presentedById: ctx.userId ?? null,
      presenterName: input.presenterName?.trim() || null,
      durationMinutes: input.durationMinutes ?? null,
      storageKey: input.storageKey ?? null,
      note: input.note ?? null,
    })
    .returning({ id: schema.toolboxTalks.id });

  if (!row) throw new Error("Could not record the toolbox talk.");

  await tx.insert(schema.toolboxTalkAttendees).values(
    employeeIds.map((employeeId) => ({
      tenantId: ctx.tenantId,
      toolboxTalkId: row.id,
      employeeId,
    })),
  );

  return { id: row.id, attendees: employeeIds.length };
}

/** Record that an attendee signed the sheet. */
export async function acknowledgeToolboxTalk(
  tx: TenantScopedTx,
  input: { toolboxTalkId: string; employeeId: string; at?: Date },
): Promise<void> {
  await tx
    .update(schema.toolboxTalkAttendees)
    .set({ acknowledgedAt: input.at ?? new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.toolboxTalkAttendees.toolboxTalkId, input.toolboxTalkId),
        eq(schema.toolboxTalkAttendees.employeeId, input.employeeId),
      ),
    );
}

/** Talks held in a window of **Dubai** days, most recent first. */
export async function listToolboxTalks(
  tx: TenantScopedTx,
  options?: { since?: CalendarDay; limit?: number },
): Promise<readonly ToolboxTalkRecord[]> {
  const since = options?.since ?? null;
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);

  const rows = (await tx.execute<{
    id: string;
    held_on: string;
    topic: string;
    rams_id: string | null;
    rams_reference: string | null;
    presenter_name: string | null;
    duration_minutes: number | null;
    attendee_count: number;
    unacknowledged_count: number;
  }>(sql`
    select t.id,
           t.held_on,
           t.topic,
           t.rams_id,
           r.reference as rams_reference,
           coalesce(t.presenter_name, u.full_name) as presenter_name,
           t.duration_minutes,
           count(a.id)::int as attendee_count,
           count(a.id) filter (where a.acknowledged_at is null)::int as unacknowledged_count
      from toolbox_talks t
      left join hse_rams r on r.id = t.rams_id
      left join users u on u.id = t.presented_by_id
      left join toolbox_talk_attendees a
             on a.toolbox_talk_id = t.id and a.deleted_at is null
     where t.deleted_at is null
       and (${since}::date is null or t.held_on >= ${since}::date)
     group by t.id, r.reference, u.full_name
     order by t.held_on desc, t.created_at desc
     limit ${limit}
  `)) as unknown as {
    id: string;
    held_on: string;
    topic: string;
    rams_id: string | null;
    rams_reference: string | null;
    presenter_name: string | null;
    duration_minutes: number | null;
    attendee_count: number;
    unacknowledged_count: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    heldOn: r.held_on,
    topic: r.topic,
    ramsId: r.rams_id,
    ramsReference: r.rams_reference,
    presenterName: r.presenter_name,
    durationMinutes: r.duration_minutes,
    attendeeCount: r.attendee_count,
    unacknowledgedCount: r.unacknowledged_count,
  }));
}

export interface PpeIssueRecord {
  readonly id: string;
  readonly employeeId: string;
  readonly employeeName: string;
  readonly itemKind: PpeItemKind;
  readonly itemDescription: string | null;
  readonly size: string | null;
  readonly quantity: number;
  readonly issuedOn: CalendarDay;
  readonly replaceDueOn: CalendarDay | null;
  /** Negative once the replacement date has passed. */
  readonly daysToReplacement: number | null;
  readonly acknowledged: boolean;
}

/** Issue PPE to one employee. `issuedOn` defaults to **Dubai's** day. */
export async function recordPpeIssue(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId?: string },
  input: {
    employeeId: string;
    itemKind: PpeItemKind;
    itemDescription?: string | null;
    size?: string | null;
    quantity?: number;
    issuedOn?: CalendarDay;
    replaceDueOn?: CalendarDay | null;
    acknowledged?: boolean;
    note?: string | null;
  },
): Promise<{ id: string }> {
  const issuedOn = input.issuedOn ?? today();
  if (input.replaceDueOn && daysBetween(issuedOn, input.replaceDueOn) <= 0) {
    throw new Error("The replacement date has to be after the issue date.");
  }

  const [row] = await tx
    .insert(schema.ppeIssues)
    .values({
      tenantId: ctx.tenantId,
      employeeId: input.employeeId,
      itemKind: input.itemKind,
      itemDescription: input.itemDescription?.trim() || null,
      size: input.size?.trim() || null,
      quantity: input.quantity ?? 1,
      issuedOn,
      replaceDueOn: input.replaceDueOn ?? null,
      acknowledgedAt: input.acknowledged ? new Date() : null,
      issuedById: ctx.userId ?? null,
      note: input.note ?? null,
    })
    .returning({ id: schema.ppeIssues.id });

  if (!row) throw new Error("Could not record the PPE issue.");
  return row;
}

/** Record that a piece of PPE came back, so it drops off the replacement list. */
export async function returnPpeIssue(
  tx: TenantScopedTx,
  ppeIssueId: string,
  returnedOn?: CalendarDay,
): Promise<void> {
  await tx
    .update(schema.ppeIssues)
    .set({ returnedOn: returnedOn ?? today(), updatedAt: new Date() })
    .where(eq(schema.ppeIssues.id, ppeIssueId));
}

/**
 * PPE on issue, optionally only what is due for replacement.
 *
 * `${now}::date` is Dubai's day, for the reason given on `listRams`.
 */
export async function listPpeIssues(
  tx: TenantScopedTx,
  options?: { employeeId?: string; withinDays?: number; now?: CalendarDay },
): Promise<readonly PpeIssueRecord[]> {
  const now = options?.now ?? today();
  const employeeId = options?.employeeId ?? null;
  const withinDays = options?.withinDays ?? null;

  const rows = (await tx.execute<{
    id: string;
    employee_id: string;
    employee_name: string;
    item_kind: string;
    item_description: string | null;
    size: string | null;
    quantity: number;
    issued_on: string;
    replace_due_on: string | null;
    days_to_replacement: number | null;
    acknowledged: boolean;
  }>(sql`
    select p.id,
           p.employee_id,
           e.full_name as employee_name,
           p.item_kind,
           p.item_description,
           p.size,
           p.quantity,
           p.issued_on,
           p.replace_due_on,
           case when p.replace_due_on is null then null
                else (p.replace_due_on - ${now}::date)::int end as days_to_replacement,
           (p.acknowledged_at is not null) as acknowledged
      from ppe_issues p
      join employees e on e.id = p.employee_id
     where p.deleted_at is null
       and p.returned_on is null
       and (${employeeId}::uuid is null or p.employee_id = ${employeeId}::uuid)
       and (
             ${withinDays}::int is null
             or (p.replace_due_on is not null and p.replace_due_on <= ${now}::date + ${withinDays}::int)
           )
     order by p.replace_due_on asc nulls last, e.full_name asc
  `)) as unknown as {
    id: string;
    employee_id: string;
    employee_name: string;
    item_kind: string;
    item_description: string | null;
    size: string | null;
    quantity: number;
    issued_on: string;
    replace_due_on: string | null;
    days_to_replacement: number | null;
    acknowledged: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    employeeId: r.employee_id,
    employeeName: r.employee_name,
    itemKind: r.item_kind as PpeItemKind,
    itemDescription: r.item_description,
    size: r.size,
    quantity: r.quantity,
    issuedOn: r.issued_on,
    replaceDueOn: r.replace_due_on,
    daysToReplacement: r.days_to_replacement,
    acknowledged: r.acknowledged,
  }));
}

export interface RopeAccessTicket {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly certificationId: string;
  readonly name: string;
  readonly issuer: string | null;
  readonly reference: string | null;
  readonly expiresOn: CalendarDay | null;
  /** Negative once expired. */
  readonly daysRemaining: number | null;
  readonly services: readonly string[];
}

/**
 * Rope-access tickets, read from `technician_certifications`.
 *
 * ── THERE IS NO IRATA TABLE, AND THAT IS THE DECISION ──────────────────────
 *
 * An IRATA ticket is a per-person certification with an issuer, a reference, an
 * expiry and a list of services it is mandatory for. That table already exists,
 * `assignmentWarnings` already raises `certification_expired` from it, and
 * `WARNING_REQUIRES_OVERRIDE` already marks that warning as one an assignment
 * cannot pass without a recorded reason. The nightly compliance sweep already
 * sends `certification_expiring` before it lapses.
 *
 * So this function is a lens, not a register. A second table would have been a
 * second answer to "is this ticket current" — and the second answer is always
 * the stale one — and it would have been invisible to the dispatch gate, which
 * is the only place the answer changes anybody's behaviour.
 *
 * ── AND IT IS NOT PROMOTED TO A SIXTH HARD BLOCK ───────────────────────────
 *
 * The five hard blocks are the five statutory documents whose absence carries
 * AED 100,000 to AED 1,000,000 under Article 60, and this codebase's own rule
 * is that adding a sixth requires naming the statutory penalty it prevents.
 * IRATA is a scheme certification from a private body. Whether an equivalent
 * ticket is legally mandatory for a given façade in Dubai is a question this
 * database cannot answer, so it does not pretend to — and an override with a
 * recorded reason is exactly what that uncertainty earns.
 *
 * ── THE DAY ────────────────────────────────────────────────────────────────
 *
 * `expires_on` on that table is a `timestamptz`, not a `date`, so the countdown
 * is taken against Dubai midnight rather than against `current_date`. A ticket
 * that expires at 00:00 on the 5th must not read as current on the 5th in
 * Dubai because the session's clock says it is still the 4th somewhere.
 */
export async function ropeAccessTickets(
  tx: TenantScopedTx,
  options?: { now?: CalendarDay },
): Promise<readonly RopeAccessTicket[]> {
  const now = options?.now ?? today();
  const slugs = JSON.stringify(ROPE_ACCESS_SERVICE_SLUGS);

  const rows = (await tx.execute<{
    technician_id: string;
    technician_name: string;
    certification_id: string;
    name: string;
    issuer: string | null;
    reference: string | null;
    expires_on: string | null;
    days_remaining: number | null;
    services: string[];
  }>(sql`
    select c.technician_id,
           t.full_name as technician_name,
           c.id as certification_id,
           c.name,
           c.issuer,
           c.reference,
           (c.expires_on at time zone 'Asia/Dubai')::date::text as expires_on,
           case when c.expires_on is null then null
                else ((c.expires_on at time zone 'Asia/Dubai')::date - ${now}::date)::int end
             as days_remaining,
           coalesce(
             (select array_agg(value::text order by value::text)
                from jsonb_array_elements_text(c.required_for_services) as value),
             array[]::text[]
           ) as services
      from technician_certifications c
      join technicians t on t.id = c.technician_id
     where c.deleted_at is null
       and t.deleted_at is null
       and exists (
         select 1
           from jsonb_array_elements_text(c.required_for_services) as s(slug)
           join jsonb_array_elements_text(${slugs}::jsonb) as w(slug) on lower(s.slug) = lower(w.slug)
       )
     order by c.expires_on asc nulls last, t.full_name asc
  `)) as unknown as {
    technician_id: string;
    technician_name: string;
    certification_id: string;
    name: string;
    issuer: string | null;
    reference: string | null;
    expires_on: string | null;
    days_remaining: number | null;
    services: string[];
  }[];

  return rows.map((r) => ({
    technicianId: r.technician_id,
    technicianName: r.technician_name,
    certificationId: r.certification_id,
    name: r.name,
    issuer: r.issuer,
    reference: r.reference,
    expiresOn: r.expires_on,
    daysRemaining: r.days_remaining,
    services: r.services,
  }));
}

export interface HseSummary {
  readonly now: Date;
  readonly today: CalendarDay;
  /** Everything still owed to MOHRE or an insurer, worst first. */
  readonly openNotifications: readonly InjuryRecord[];
  readonly register: readonly InjuryRecord[];
  readonly statistics: InjuryStatistics;
  readonly ramsDue: readonly RamsRecord[];
  readonly rams: readonly RamsRecord[];
  readonly talks: readonly ToolboxTalkRecord[];
  readonly ppeDue: readonly PpeIssueRecord[];
  readonly ropeAccess: readonly RopeAccessTicket[];
  /** Injuries whose investigation has not been closed out. */
  readonly investigationsOutstanding: readonly InjuryRecord[];
}

/**
 * Everything the HSE board renders, in one read.
 *
 * One function rather than nine calls from a page, for the reason
 * `hrLifecycleSummary` is one function: nine round trips per render is nine
 * chances for the page and the cron to disagree about what the board says, and
 * the cron reads the same domain functions this composes.
 */
export async function hseSummary(
  tx: TenantScopedTx,
  options?: { now?: Date },
): Promise<HseSummary> {
  const now = options?.now ?? new Date();
  const day = today(now);

  const [openNotifications, register, statistics, ramsDue, rams, talks, ppeDue, ropeAccess] =
    await Promise.all([
      openInjuryNotifications(tx, now),
      injuryRegister(tx, { limit: 50, now }),
      injuryStatistics(tx, { now }),
      listRams(tx, { withinDays: RAMS_REVIEW_WARN_DAYS, approvedOnly: true, now: day }),
      listRams(tx, { now: day }),
      listToolboxTalks(tx, { limit: 25 }),
      listPpeIssues(tx, { withinDays: PPE_REPLACEMENT_WARN_DAYS, now: day }),
      ropeAccessTickets(tx, { now: day }),
    ]);

  return {
    now,
    today: day,
    openNotifications,
    register,
    statistics,
    ramsDue,
    rams,
    talks,
    ppeDue,
    ropeAccess,
    investigationsOutstanding: register.filter((r) => r.investigationCompletedOn === null),
  };
}
