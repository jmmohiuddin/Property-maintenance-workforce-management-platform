/**
 * Shared column helpers and enums.
 *
 * Two conventions everything else depends on:
 *
 *  1. Every tenant-scoped table carries `tenant_id` as its FIRST column and is
 *     covered by a Postgres RLS policy keyed on `current_setting('app.tenant_id')`.
 *     Application-layer `WHERE tenant_id = ?` is a convenience, not the security
 *     boundary — see sql/rls.sql and docs/adr/0003-multi-tenancy.md for why we
 *     put the boundary in the database.
 *  2. Money is `numeric(14,2)` with a separate currency column, never a float.
 *     Drizzle returns numeric as string; we keep it that way and convert at the
 *     edge so no rounding happens implicitly.
 */

import { pgEnum, timestamp, uuid, varchar, numeric } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const idCol = () => uuid("id").primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Soft delete. RLS policies exclude non-null rows from normal reads. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
};

export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
export const currencyCol = () => varchar("currency", { length: 3 }).notNull().default("AED");

/** Set by the connection wrapper before every tenant-scoped query. */
export const currentTenant = sql`current_setting('app.tenant_id', true)::uuid`;

// ── Enums ────────────────────────────────────────────────────────────────────

export const userRole = pgEnum("user_role", [
  "owner", // billing + full control of the tenant
  "admin", // full operational control
  "operations_manager", // dispatch, scheduling, workforce
  "dispatcher",
  "supervisor", // field team lead
  "technician",
  "accountant",
  "sales",
  // ADM-1. §5.2 adds a seventh staff persona: fill an open trade role in days,
  // and never dispatch someone whose permit, visa, medical or certification has
  // lapsed. The rule attached to it is that every role must have at least one
  // screen it alone can reach — `hr` earns that with the recruitment pipeline
  // (M9) and the workforce compliance board (M10).
  "hr",
  "customer", // portal user belonging to a customer account
  "readonly",
]);

export const jobStatus = pgEnum("job_status", [
  "draft",
  "submitted", // customer raised it, not yet triaged
  "triaged", // service type + priority confirmed
  "scheduled",
  "dispatched", // technician assigned, not yet travelling
  "en_route",
  "on_site",
  "paused", // waiting on parts, access, or approval
  "work_complete", // technician done, awaiting review
  "signed_off", // customer signature captured
  "invoiced",
  "closed",
  "cancelled",
]);

export const jobPriority = pgEnum("job_priority", ["p1_emergency", "p2_urgent", "p3_standard", "p4_planned"]);

export const jobSource = pgEnum("job_source", [
  "web_quote",
  "phone",
  "whatsapp",
  "ai_receptionist",
  "customer_portal",
  "contract_ppm", // auto-generated from a contract schedule
  "internal",
  "recurring",
]);

/**
 * The life of one technician attendance.
 *
 * ── WHY `superseded` EXISTS, AND WHY IT IS NOT ONE OF THE OTHER NINE ────────
 *
 * A visit row is written at ASSIGNMENT, not at attendance. Reassigning a job to
 * somebody else means calling `assignTechnician` again — `rescheduleVisit`
 * refuses to change the technician on purpose, because moving a visit into
 * another person's lane has to re-run skill matching, the `HR-9` block and the
 * `JOB-8` availability rules. So a reassignment inserts a SECOND row, and until
 * `0040` there was no state that could retire the first. It stayed `assigned`
 * for ever, occupying the original technician's diary in `findCandidates` and
 * `listTechnicians`, and rendering a labour form on the job card for a visit
 * that never happened.
 *
 * The three existing candidates were each considered and each says something
 * false about a person:
 *
 *   * `declined` means THE TECHNICIAN refused the work. Recording a
 *     dispatcher's reassignment as a decline attributes the office's decision
 *     to the employee, and any report counting who declines work would then be
 *     libel with a chart on it.
 *   * `aborted` means the visit STARTED and was abandoned — the reference data
 *     carries `aborted_unsafe` as a job outcome for exactly that. It claims
 *     attendance that did not occur, and it is in `SETTLED_VISIT_STATUSES`
 *     ("already happened") for that reason.
 *   * `cancelled` was rejected as a NEW member: it is the natural word for the
 *     customer calling off the appointment, which is a different real event
 *     this schema does not model yet. Spending it here would leave that event
 *     with no honest name later.
 *
 * `superseded` is the word this schema already uses for "a later record
 * replaced this one and the earlier one is kept, not deleted" — `quote_status`,
 * `CONTRACT_TERM_STATUSES` and the field app's outcome versions all use it in
 * exactly that sense.
 *
 * Appended LAST, deliberately: `ALTER TYPE ... ADD VALUE` appends, and a
 * declaration whose order disagrees with the type in the database makes every
 * later `drizzle-kit generate` produce a spurious diff.
 */
export const visitStatus = pgEnum("visit_status", [
  "proposed",
  "assigned",
  "accepted",
  "declined",
  "en_route",
  "arrived",
  "completed",
  "no_access",
  "aborted",
  "superseded",
]);

export const quoteStatus = pgEnum("quote_status", [
  "draft",
  "sent",
  "viewed",
  "approved",
  "rejected",
  "expired",
  "superseded",
]);

export const contractStatus = pgEnum("contract_status", [
  "draft",
  "pending_signature",
  "active",
  "suspended",
  "expired",
  "cancelled",
  "renewed",
]);

export const invoiceStatus = pgEnum("invoice_status", [
  "draft",
  "issued",
  "part_paid",
  "paid",
  "overdue",
  "written_off",
  "credited",
]);

export const paymentMethod = pgEnum("payment_method", [
  "card",
  "bank_transfer",
  "cash",
  "cheque",
  "online_gateway",
  "credit_note",
]);

export const propertyType = pgEnum("property_type", [
  "apartment",
  "villa",
  "office",
  "retail",
  "hotel",
  "building",
  "warehouse",
  "mixed_use",
  "other",
]);

export const employmentType = pgEnum("employment_type", ["direct", "contract_supply", "subcontractor"]);

export const attendanceKind = pgEnum("attendance_kind", ["shift_in", "shift_out", "break_start", "break_end"]);

export const leadStage = pgEnum("lead_stage", [
  "new",
  "contacted",
  "qualified",
  "quoted",
  "negotiating",
  "won",
  "lost",
  "dormant",
]);

export const assetCondition = pgEnum("asset_condition", ["new", "good", "fair", "poor", "end_of_life"]);
