import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  purgeExpiredEmployees,
  purgeLocationTraces,
  RETENTION_FINANCIAL_YEARS,
  RETENTION_LOCATION_TRACE_DAYS,
  RETENTION_PROTECTED_TABLES,
} from "@meridian/db/domain";
import { runCron } from "@/lib/cron";

/**
 * Data-retention purge. Daily, 02:00 Asia/Dubai (`0 22 * * *` UTC).
 *
 * `INV-15`, `HR-15`, `FLD-16`, TRD §7.4. Two of the seven routes `ADM-5` names
 * were deliberately not built during Phase 0 because the columns they need did
 * not exist. `employees.delete_after` arrived with migration 0005, so this one
 * can now be built for real rather than as a stub that reports "ok".
 *
 * Deliberately at 02:00, four hours before the compliance sweep at 06:00. Both
 * are daily and both walk every tenant; running them together would put two
 * table-wide passes on the same connection pool at the same minute for no
 * reason. Deleting also holds locks, and 02:00 is when nobody is looking at the
 * rows being locked.
 *
 * ── WHAT IS PURGED ─────────────────────────────────────────────────────────
 *
 *  * `HR-15` employee records past `delete_after` — **only** where termination
 *    was more than seven years ago. The two-year Labour Law clock makes a row
 *    eligible; the seven-year tax floor decides whether it goes.
 *  * `FLD-16` raw GPS traces older than 30 days. High-churn continuous location
 *    data about identifiable people, with no business record depending on it.
 *
 * ── WHAT IS NOT PURGED, AND NEVER WILL BE BY THIS ROUTE ────────────────────
 *
 * Financial records. Every one of them, listed by name in
 * `RETENTION_PROTECTED_TABLES` and printed in this route's own response every
 * run. Deleting a record a tax audit later asks for is the single worst thing
 * this job could do — it is irreversible, unexplainable, and carries AED 10,000
 * rising to AED 20,000 on repeat before the assessment itself. A retention job
 * that has not run leaves personal data lying around; a retention job that
 * deletes the wrong row destroys evidence.
 *
 * ── WHAT IS STILL MISSING, SAID OUT LOUD ───────────────────────────────────
 *
 * Reported in `warnings` on every run rather than announced once in a commit
 * message. A route that says "ok" while three of its obligations have no
 * mechanism behind them is the failure the scheduler exists to eliminate.
 *
 * A purge failure needs no alert of its own: `runCron` records the run as
 * `failed` and returns 500, and `/api/cron/health` reports the job as overdue
 * the moment it stops finishing. That is the same path every other cron uses,
 * and a second one would be a second thing to keep working.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return runCron("retention", request, async () => {
    const tenants = await activeTenantIds();

    let employeesPurged = 0;
    let employeesHeld = 0;
    let locationTracesPurged = 0;
    const orphanedStorageKeys: string[] = [];

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      const ctx = { tenantId, actorKind: "system" as const };

      await withTenant(ctx, async (tx) => {
        // One transaction per tenant, both purges inside it, and the audit
        // notes written by the same transaction that does the deleting. A
        // deletion that commits without its log entry is a deletion nobody can
        // account for afterwards, which for a retention job is the only
        // question that ever gets asked about it.
        const employees = await purgeExpiredEmployees(tx, ctx);
        const traces = await purgeLocationTraces(tx, ctx);

        employeesPurged += employees.deleted;
        employeesHeld += employees.heldForFinancialFloor;
        locationTracesPurged += traces.deleted;
        orphanedStorageKeys.push(...employees.orphanedStorageKeys);
      });
    }

    // Reported every run while it holds. The database row is gone and the file
    // it pointed at is not, so the data is not actually deleted — saying "10
    // employee records purged" without this would be a false statement about a
    // compliance obligation.
    if (orphanedStorageKeys.length > 0) {
      warnings.push(
        `${orphanedStorageKeys.length} object-storage key(s) are now orphaned: the database rows ` +
          `were purged and nothing in this system can delete from object storage (OPS-6). Until ` +
          `lifecycle rules exist, those objects must be removed by hand: ` +
          orphanedStorageKeys.slice(0, 20).join(", ") +
          (orphanedStorageKeys.length > 20 ? `, and ${orphanedStorageKeys.length - 20} more` : ""),
      );
    }

    warnings.push(
      `Not purged, by design: ${RETENTION_PROTECTED_TABLES.join(", ")}. Tax records are retained ` +
        `${RETENTION_FINANCIAL_YEARS} years (Corporate Tax) and 5 years (VAT), extended by any ` +
        `open dispute, audit or pending refund.`,
    );

    warnings.push(
      "Not yet purged, because the mechanism does not exist: applicant and candidate data " +
        "(ATS-18) — no `candidates` table; lead and marketing consent records (LEAD-7) — `leads` " +
        "has no `delete_after` or `last_interaction_at` column; customer contact PII on closed " +
        "accounts — no retention clock defined. Each needs a column before it can need a job.",
    );

    warnings.push(
      "Outside this route entirely: UAE data residency (INV-15 requires records held in the UAE; " +
        "this deploys to ap-southeast-1 — see ADR-0008) and object-storage lifecycle and " +
        "versioning rules (OPS-6). Both are deployment constraints and neither can be satisfied " +
        "by application code.",
    );

    return {
      processed: employeesPurged + locationTracesPurged,
      detail: {
        tenants: tenants.length,
        employeesPurged,
        // Not an error. A held count that never falls means a `delete_after`
        // date was set against the two-year clock on a record the seven-year
        // floor still covers, and nothing else would ever reveal that.
        employeesHeldForFinancialFloor: employeesHeld,
        locationTracesPurged,
        orphanedStorageKeys: orphanedStorageKeys.length,
        financialFloorYears: RETENTION_FINANCIAL_YEARS,
        locationRetentionDays: RETENTION_LOCATION_TRACE_DAYS,
        protectedTables: RETENTION_PROTECTED_TABLES.length,
      },
      warnings,
    };
  });
}
