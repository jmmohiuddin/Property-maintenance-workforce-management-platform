import { sql } from "drizzle-orm";
import type { TenantContext, TenantScopedTx } from "../index";
import { writeAuditNote } from "./staff";

/**
 * Automated data-retention purges (`INV-15`, `HR-15`, `FLD-16`).
 *
 * TRD §10 puts it plainly: *a rule enforced by validation is a rule; a rule
 * written in a policy document is a hope.* Retention is one of those rules, so
 * it is a job.
 *
 * ── THE RULE THAT OUTRANKS EVERY OTHER RULE IN THIS FILE ────────────────────
 *
 * **This job does not delete financial records.** Not when a `delete_after`
 * date says it may, not when a personal-data retention rule says it should.
 *
 * VAT requires five years from the end of the relevant tax period; Corporate
 * Tax requires seven; both extend during a dispute, an audit or a pending
 * refund. Seven years is therefore the operating floor. A job that deletes a
 * record a tax audit later asks for cannot be undone, cannot be explained, and
 * carries AED 10,000 rising to AED 20,000 on repeat — before whatever the
 * assessment itself costs when the supporting document no longer exists.
 *
 * A retention job that never runs leaves personal data lying around, which is
 * bad. A retention job that deletes the wrong thing destroys evidence, which is
 * worse. So every deletion below is bounded twice: once by the retention clock
 * that made the row eligible, and once by the financial floor that can veto it.
 * Where the two disagree, the floor wins and the row is *reported as held*
 * rather than quietly skipped — see `heldForFinancialFloor`.
 *
 * ── WHAT IS LOGGED ─────────────────────────────────────────────────────────
 *
 * Every purge writes to `audit_log`, which is append-only in the database
 * (UPDATE and DELETE are revoked from the application role; see sql/rls.sql).
 * Deliberately not a `retention_deletions` table of its own: a second ledger of
 * "what did we delete" is one deploy away from disagreeing with the first, and
 * the one that is append-only at the database level is the one to trust.
 *
 * The log records identifiers, counts and dates — never the personal data that
 * was just deleted. Copying a purged employee's name into the audit trail would
 * defeat the purge and leave the data in a table nothing ever purges.
 */

// ── The floors ──────────────────────────────────────────────────────────────

/**
 * Seven years, because it covers both clocks.
 *
 * VAT: five years from the end of the tax period. Corporate Tax: seven from the
 * end of the tax period. Keeping to the longer one means never having to decide
 * per record which regime applies, and never being wrong about it.
 */
export const RETENTION_FINANCIAL_YEARS = 7;

/**
 * How long a raw GPS trace lives (`FLD-16`).
 *
 * The trace is a high-churn operational signal — where a van was at 14:32 —
 * not a business record. What survives it is what the business actually relies
 * on: `attendance_events`, `job_visits`, and the geo-stamp on a sign-off. Those
 * are not touched here.
 */
export const RETENTION_LOCATION_TRACE_DAYS = 30;

/**
 * Tables this job will never delete from, listed rather than implied.
 *
 * This is the financial exclusion made explicit. It exists as data so the cron
 * route can print it in its own response every run: a purge job that says "ok"
 * without saying what it left alone is indistinguishable from one whose
 * exclusion list was deleted in a refactor.
 *
 * Adding a table to a purge without removing it from here is a compile-time
 * contradiction a reviewer can see. Removing a table from here should require
 * naming the retention period that replaced the seven-year floor.
 */
export const RETENTION_PROTECTED_TABLES = [
  // Tax records under INV-15. Seven years, extended by any open dispute.
  "invoices",
  "invoice_lines",
  "credit_notes",
  "credit_note_lines",
  "payments",
  // The supporting evidence a tax invoice is assessed against. An invoice
  // without its job, its sign-off and its quote is an unsupported assertion.
  "quotes",
  "quote_lines",
  "contracts",
  "contract_visits",
  "jobs",
  "job_signoffs",
  "job_reports",
  "job_materials",
  // Append-only by construction; the application role has no DELETE on it.
  "audit_log",
] as const;

// ── What one purge did ──────────────────────────────────────────────────────

export interface PurgeOutcome {
  readonly table: string;
  /** The requirement being satisfied, e.g. `HR-15`. */
  readonly rule: string;
  readonly deleted: number;
  /**
   * Rows that were past their `delete_after` date and were **not** deleted,
   * because the seven-year financial floor still covers them.
   *
   * Reported rather than silently skipped. A held row is not an error, but a
   * held count that never falls is a `delete_after` date set against the wrong
   * clock, and nobody would ever find that out from a job that only counts
   * what it deleted.
   */
  readonly heldForFinancialFloor: number;
  /**
   * Object-storage keys belonging to rows that were just deleted.
   *
   * The database row is gone; the file it pointed at is not. Nothing in this
   * codebase can delete from object storage yet (`OPS-6` — versioning and
   * lifecycle rules are a deployment concern). Returning the keys is the honest
   * middle: the purge is incomplete, and the response says which objects are
   * now orphaned instead of implying the data is gone.
   */
  readonly orphanedStorageKeys: readonly string[];
}

// ── HR-15: employee records, two years post-termination, seven for payroll ──

/**
 * Delete employee records past `delete_after`, unless the financial floor holds
 * them.
 *
 * `HR-15` sets the personal-data clock: a minimum of two years after
 * termination of service, per Article 13 of the Labour Law. `delete_after` on
 * `employees` carries that date.
 *
 * It is not sufficient on its own, and that is the whole point of this
 * function. An `employees` row holds `basic_salary_minor`, `wps_iban` and
 * `mohre_person_code` — it *is* a payroll record, and payroll records are tax
 * records. So the two-year date only makes a row eligible; the seven-year floor
 * decides whether it goes. A row whose `delete_after` fell last month but whose
 * termination was three years ago is held for four more years, and said so.
 *
 * A serving employee is never deleted, whatever `delete_after` says. A null
 * `terminated_at` means the clock has not started, and a retention date set on
 * someone still on the payroll is a data-entry error rather than an
 * instruction.
 */
export async function purgeExpiredEmployees(
  tx: TenantScopedTx,
  ctx: TenantContext,
  options?: { financialYears?: number },
): Promise<PurgeOutcome> {
  const years = options?.financialYears ?? RETENTION_FINANCIAL_YEARS;

  // Counted before the delete, in the same transaction, so the two numbers
  // describe the same instant. Asking afterwards would report a held count
  // computed against a table the delete had already changed.
  const heldRows = (await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from employees
     where delete_after is not null
       and delete_after < (now() at time zone 'Asia/Dubai')::date
       and (
             terminated_at is null
             or terminated_at >= now() - make_interval(years => ${years})
           )
  `)) as unknown as { count: number }[];

  const heldForFinancialFloor = heldRows[0]?.count ?? 0;

  // Collected before the cascade removes them. `employee_documents` is
  // ON DELETE CASCADE, so these rows disappear with their employee and the
  // storage keys become unrecoverable one statement later.
  const keyRows = (await tx.execute<{ storage_key: string }>(sql`
    select d.storage_key
      from employee_documents d
      join employees e on e.id = d.employee_id
     where d.storage_key is not null
       and e.delete_after is not null
       and e.delete_after < (now() at time zone 'Asia/Dubai')::date
       and e.terminated_at is not null
       and e.terminated_at < now() - make_interval(years => ${years})
  `)) as unknown as { storage_key: string }[];

  const deleted = (await tx.execute<{ id: string; employee_no: string | null }>(sql`
    delete from employees
     where delete_after is not null
       and delete_after < (now() at time zone 'Asia/Dubai')::date
       -- The financial floor. Both halves are load-bearing:
       --   * terminated_at is not null — a serving employee is never purged.
       --   * seven years since termination — the payroll data on this row is a
       --     tax record, and INV-15 outranks the two-year HR-15 clock.
       and terminated_at is not null
       and terminated_at < now() - make_interval(years => ${years})
    returning id, employee_no
  `)) as unknown as { id: string; employee_no: string | null }[];

  for (const row of deleted) {
    // Identifier and dates only. The name, salary, IBAN and MOHRE code that
    // were on this row are not copied here — an audit trail that preserves the
    // data a purge removed has not purged anything.
    await writeAuditNote(tx, ctx, {
      tableName: "employees",
      recordId: row.id,
      action: "retention_purge",
      detail: {
        rule: "HR-15",
        employeeNo: row.employee_no,
        financialFloorYears: years,
        cascaded: "employee_documents",
      },
    });
  }

  return {
    table: "employees",
    rule: "HR-15",
    deleted: deleted.length,
    heldForFinancialFloor,
    orphanedStorageKeys: keyRows.map((r) => r.storage_key),
  };
}

// ── FLD-16: raw location traces ─────────────────────────────────────────────

/**
 * Delete GPS traces older than the retention window.
 *
 * `FLD-16`. `technician_locations` is the one table in this schema that grows
 * without bound from ordinary use — a ping per van per interval, forever — and
 * it is also continuous location data about identifiable people, which is the
 * kind of personal data with the weakest case for indefinite retention.
 *
 * Nothing financial is lost. Proof that someone attended a job lives in
 * `job_visits`, `attendance_events` and the sign-off, none of which this
 * touches. The trace is how the van got there, not that it did.
 *
 * No `delete_after` column is involved: the window is uniform, the volume is
 * large, and a per-row date on a table of this shape would cost more to
 * maintain than it could ever express.
 */
export async function purgeLocationTraces(
  tx: TenantScopedTx,
  ctx: TenantContext,
  options?: { retentionDays?: number; batchLimit?: number },
): Promise<PurgeOutcome> {
  const days = options?.retentionDays ?? RETENTION_LOCATION_TRACE_DAYS;
  // Bounded so one neglected tenant cannot turn a nightly job into a
  // table-length delete that holds locks past the route's 60-second budget.
  // Idempotent by construction: whatever is left over is still older than the
  // cutoff tomorrow, and the job runs every day.
  const limit = options?.batchLimit ?? 50_000;

  const deleted = (await tx.execute<{ count: number }>(sql`
    with doomed as (
      select id
        from technician_locations
       where recorded_at < now() - make_interval(days => ${days})
       order by recorded_at
       limit ${limit}
    )
    delete from technician_locations t
     using doomed d
     where t.id = d.id
    returning t.id
  `)) as unknown as { id: string }[];

  if (deleted.length > 0) {
    // One summary row, not one per trace. A purge of forty thousand pings that
    // wrote forty thousand audit rows would have moved the storage problem into
    // the table that may never be pruned.
    await writeAuditNote(tx, ctx, {
      tableName: "technician_locations",
      action: "retention_purge",
      detail: {
        rule: "FLD-16",
        rowsDeleted: deleted.length,
        retentionDays: days,
        batchLimit: limit,
        truncatedByBatchLimit: deleted.length === limit,
      },
    });
  }

  return {
    table: "technician_locations",
    rule: "FLD-16",
    deleted: deleted.length,
    // No financial floor applies: a GPS ping is not a tax record, and none of
    // the evidence an invoice is assessed against lives in this table.
    heldForFinancialFloor: 0,
    orphanedStorageKeys: [],
  };
}
