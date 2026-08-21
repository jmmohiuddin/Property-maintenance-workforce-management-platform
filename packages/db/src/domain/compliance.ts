import { sql, and, eq, isNull } from "drizzle-orm";
import type { TenantScopedTx } from "../index";
import * as schema from "../schema";
import { EMPLOYEE_DOCUMENT_LABEL, type EmployeeDocumentKind } from "../schema/compliance";

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
export async function blockedTechnicians(tx: TenantScopedTx): Promise<readonly DispatchBlock[]> {
  const rows = (await tx.execute<{
    technician_id: string;
    full_name: string;
    kind: string;
    expires_at: string;
    days_expired: number;
  }>(sql`
    select t.id as technician_id,
           t.full_name,
           d.kind,
           d.expires_at,
           (current_date - d.expires_at)::int as days_expired
      from employee_documents d
      join employees e on e.id = d.employee_id
      join technicians t on t.id = e.technician_id
     where d.blocking
       and d.expires_at is not null
       and d.expires_at < current_date
       and d.deleted_at is null
       and e.deleted_at is null
       and e.status = 'active'
       and t.is_active
       and t.deleted_at is null
     order by d.expires_at
  `)) as unknown as {
    technician_id: string;
    full_name: string;
    kind: string;
    expires_at: string;
    days_expired: number;
  }[];

  return rows.map((r) => ({
    technicianId: r.technician_id,
    technicianName: r.full_name,
    reason: "expired_document" as const,
    detail: `${EMPLOYEE_DOCUMENT_LABEL[r.kind as EmployeeDocumentKind] ?? r.kind} expired ${formatDate(r.expires_at)}`,
    penalty: penaltyFor(r.kind),
    daysExpired: r.days_expired,
  }));
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
): Promise<DispatchBlock | null> {
  const blocks = await blockedTechnicians(tx);
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
 */
export async function findExpiringEmployeeDocuments(
  tx: TenantScopedTx,
  withinDays = 90,
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
           (d.expires_at - current_date)::int as days_remaining,
           d.blocking
      from employee_documents d
      join employees e on e.id = d.employee_id
     where d.expires_at is not null
       and d.expires_at <= current_date + (${withinDays})::int
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
): Promise<readonly ExpiringAccreditation[]> {
  // Day counting happens in SQL, as `date - date`, not in JavaScript.
  //
  // Subtracting a JS Date at midnight from `new Date()` and flooring gives 29
  // for a document expiring in 30 days, because the partial day is discarded —
  // and "29 days" on an alert that should read "30" is the kind of quiet
  // wrongness nobody ever chases down. Postgres date arithmetic has no time
  // component to lose. The other two expiry queries do the same.
  const rows = (await tx.execute<{
    id: string;
    kind: string;
    name: string;
    reference_no: string | null;
    expires_at: string;
    days_remaining: number;
  }>(sql`
    select id, kind, name, reference_no, expires_at,
           (expires_at - current_date)::int as days_remaining
      from company_accreditations
     where expires_at is not null
       and expires_at <= current_date + (${withinDays})::int
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
