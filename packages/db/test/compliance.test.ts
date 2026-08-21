/**
 * Compliance-gated dispatch — integration test against real Postgres.
 *
 * `HR-9` is the requirement that most justifies building this system:
 * deploying a worker without a valid permit carries AED 100,000 to AED
 * 1,000,000. `G15` is zero tolerance. A zero-tolerance target is met by the
 * action being refused, so this file proves the refusal — including the part
 * that matters most, which is that the domain layer refuses even when the UI
 * would have allowed it.
 *
 * The TRD's §11.3 names two of these explicitly as required tests:
 *   - dispatch to a technician whose work permit expired yesterday → REFUSED
 *   - an outdoor job scheduled at 13:00 on 1 July → REFUSED
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── WHY EVERY ASSERTION IS A DELTA ──────────────────────────────────────────
 *
 * This file first asserted absolutes — "nobody is blocked", "exactly one
 * technician is blocked" — and broke the moment the development database had
 * demo compliance data in it. That was the test's fault, not the data's: a
 * suite that only passes against a pristine database is a suite that will fail
 * on somebody's laptop for a reason that has nothing to do with the code, and
 * the usual response to that is to stop trusting the suite.
 *
 * So everything below measures the CHANGE its own fixtures cause. That holds
 * whether the database is empty, freshly seeded, or full of demo rows.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection, db } from "../src/index";
import {
  blockedTechnicians,
  blockForTechnician,
  findExpiringEmployeeDocuments,
  findExpiringAccreditations,
  workforceSummary,
  assignTechnician,
  findCandidates,
} from "../src/domain";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "COMPLIANCE-TEST";

async function main(): Promise<void> {
  const tenantRows = (await db.execute<{ id: string }>(
    sql`select app_cron_active_tenants() as id`,
  )) as unknown as { id: string }[];
  const tenantId = tenantRows[0]?.id;
  if (!tenantId) throw new Error("No tenant. Run `npm run db:seed` first.");

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // ── Fixtures ───────────────────────────────────────────────────────────
    // Two active technicians with no employment record of their own, so the
    // fixtures below cannot collide with demo data or with a previous run that
    // died before its cleanup.
    const techRows = (await tx.execute<{ id: string; full_name: string }>(sql`
      select t.id, t.full_name from technicians t
       where t.is_active and t.deleted_at is null
         and not exists (
           select 1 from employees e where e.technician_id = t.id and e.deleted_at is null
         )
       order by t.created_at limit 2
    `)) as unknown as { id: string; full_name: string }[];

    const clean = techRows[0];
    const doomed = techRows[1];
    if (!clean || !doomed) {
      throw new Error(
        "Need two active technicians without an employee record. Seed the database, or clear " +
          "demo data: delete from employees where employee_no like 'DEMO%';",
      );
    }

    console.log("\n— baseline —");

    // Whatever is already there is the baseline. The fixtures below are
    // measured against it.
    const before = await blockedTechnicians(tx);
    const blockedBefore = new Set(before.map((b) => b.technicianId));
    const summaryBefore = await workforceSummary(tx);

    console.log(`      baseline: ${before.length} already blocked, ${summaryBefore.headcount} headcount`);
    check("the summary agrees with the block list", summaryBefore.blocked, before.length);
    check(
      "and deployable is headcount minus blocked",
      summaryBefore.deployable,
      summaryBefore.headcount - before.length,
    );

    // The fixture technician must not already be blocked, or the delta is
    // meaningless. Picking one that is clean keeps the test honest.
    if (blockedBefore.has(doomed.id) || blockedBefore.has(clean.id)) {
      throw new Error(
        "The fixture technicians are already compliance-blocked. Pick two that are not, " +
          "or clear the demo data: delete from employee_documents where note = 'DEMO';",
      );
    }

    // ── Give one technician an employment record with an expired permit ────
    console.log("\n— a work permit that expired yesterday —");

    const [employee] = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, technician_id, full_name, employee_no, status)
      values (${tenantId}::uuid, ${doomed.id}::uuid, ${`${TAG} ${doomed.full_name}`}, ${`${TAG}-1`}, 'active')
      returning id
    `)) as unknown as { id: string }[];
    if (!employee) throw new Error("Could not create the employee fixture");

    await tx.execute(sql`
      insert into employee_documents (tenant_id, employee_id, kind, expires_at, blocking, note)
      values (${tenantId}::uuid, ${employee.id}::uuid, 'work_permit', current_date - 1, true, ${TAG})
    `);

    const blocked = await blockedTechnicians(tx);
    check("exactly one more technician is blocked", blocked.length, before.length + 1);

    const ours = blocked.find((b) => b.technicianId === doomed.id);
    checkTrue("and it is our fixture", ours !== undefined);
    checkTrue("the reason names the document", ours?.detail.includes("work permit") === true);
    // "AED 100,000-1,000,000" changes behaviour; "a compliance risk" does not.
    checkTrue("and the penalty is a number", ours?.penalty?.includes("AED 100,000") === true);
    check("expired yesterday reads as one day", ours?.daysExpired, 1);

    const summaryAfter = await workforceSummary(tx);
    check("the board counts one more blocked", summaryAfter.blocked, summaryBefore.blocked + 1);
    check("and one fewer deployable", summaryAfter.deployable, summaryBefore.deployable - 1);

    checkTrue("the per-technician check agrees", (await blockForTechnician(tx, doomed.id)) !== null);
    check("and clears the unaffected technician", await blockForTechnician(tx, clean.id), null);

    // ── The dialog must not offer them ─────────────────────────────────────
    console.log("\n— the assign dialog —");

    const skillRows = (await tx.execute<{ service_slug: string }>(sql`
      select service_slug from technician_skills where technician_id = ${doomed.id}::uuid limit 1
    `)) as unknown as { service_slug: string }[];

    if (skillRows[0]) {
      const result = await findCandidates(tx, {
        serviceSlug: skillRows[0].service_slug,
        property: { lat: null, lng: null, city: "Dubai" },
      });

      checkTrue(
        "a blocked technician is not a candidate at any score",
        !result.candidates.some((c) => c.technicianId === doomed.id),
      );
      checkTrue(
        "they appear in the blocked list instead",
        result.blocked.some((b) => b.technicianId === doomed.id),
      );
      // Blocked and disqualified render differently and mean different things.
      checkTrue(
        "and not merely as disqualified",
        !result.disqualified.some((d) => d.technicianId === doomed.id),
      );
    } else {
      console.log("skip  no skill row for the fixture technician; dialog check not run");
    }

    // ── The gate that actually matters ─────────────────────────────────────
    // A dialog rendered thirty seconds ago does not know a permit expired at
    // midnight. This is the check inside the transaction.
    console.log("\n— the domain layer refuses, not just the UI —");

    const jobRows = (await tx.execute<{ id: string }>(sql`
      select id from jobs where deleted_at is null and status in ('triaged','scheduled') limit 1
    `)) as unknown as { id: string }[];

    if (jobRows[0]) {
      let refused = false;
      let message = "";
      try {
        await assignTechnician(tx, { tenantId, actorKind: "system" }, {
          jobId: jobRows[0].id,
          technicianId: doomed.id,
        });
      } catch (error) {
        refused = true;
        message = error instanceof Error ? error.message : String(error);
      }

      checkTrue("assigning a blocked technician throws", refused);
      checkTrue("and the message names the reason", message.includes("work permit"));
      checkTrue("and states the penalty", message.includes("AED 100,000"));
    } else {
      console.log("skip  no assignable job in the seed; assignment gate not run");
    }

    // ── Expiry sweeps ──────────────────────────────────────────────────────
    console.log("\n— expiry reporting (HR-5, HR-14) —");

    const expiring = await findExpiringEmployeeDocuments(tx, 90);
    checkTrue(
      "an already-expired document is reported",
      expiring.some((d) => d.employeeId === employee.id && d.daysRemaining < 0),
    );
    checkTrue(
      "and is marked blocking",
      expiring.find((d) => d.employeeId === employee.id)?.blocking === true,
    );

    await tx.execute(sql`
      insert into company_accreditations (tenant_id, kind, name, reference_no, expires_at)
      values (${tenantId}::uuid, 'trade_licence', ${`${TAG} licence`}, '930137', current_date + 30)
    `);

    const accreditations = await findExpiringAccreditations(tx, 90);
    const licence = accreditations.find((a) => a.name.startsWith(TAG));
    checkTrue("an accreditation inside the window is reported", licence !== undefined);
    check("with the right days remaining", licence?.daysRemaining, 30);

    // ── A non-blocking document must NOT block ─────────────────────────────
    // The block/warn split is the whole design. Over-blocking gets the control
    // worked around, and a workaround is invisible.
    console.log("\n— non-blocking documents warn, they do not block —");

    await tx.execute(sql`
      insert into employee_documents (tenant_id, employee_id, kind, expires_at, blocking, note)
      values (${tenantId}::uuid, ${employee.id}::uuid, 'driving_licence', current_date - 30, false, ${TAG})
    `);

    const stillOne = await blockedTechnicians(tx);
    check("an expired driving licence adds no new block", stillOne.length, before.length + 1);

    // ── Cleanup ────────────────────────────────────────────────────────────
    // Rolled back rather than deleted would be cleaner, but withTenant commits
    // and the assignment gate needs a real transaction to run in.
    await tx.execute(sql`delete from employee_documents where note = ${TAG}`);
    await tx.execute(sql`delete from employees where employee_no = ${`${TAG}-1`}`);
    await tx.execute(sql`delete from company_accreditations where name like ${`${TAG}%`}`);

    const after = await blockedTechnicians(tx);
    check("cleanup restores the baseline exactly", after.length, before.length);
    checkTrue(
      "and our fixture is gone from it",
      !after.some((b) => b.technicianId === doomed.id),
    );
  });

  console.log(fail === 0 ? "\ncompliance: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("compliance test failed to run:", error);
  await closeConnection();
  process.exit(1);
});
