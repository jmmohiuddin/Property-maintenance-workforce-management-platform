/**
 * Money paid to an employee leaves a trail — integration test against real
 * Postgres.
 *
 *   npx tsx packages/db/test/payroll-audit.test.ts
 *
 * Requires the schema, `packages/db/sql/*` applied in order, and
 * `npm run db:seed`. Cleans up after itself, except for `audit_log`:
 * `meridian_app` holds no DELETE on that table by design, and a test that could
 * tidy the audit trail would be testing a database that is not the one in
 * production.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * `audit_log` covered every way money moves towards a CUSTOMER — `invoices`,
 * `payments`, `contracts` — and no way it moves towards an EMPLOYEE. A customer
 * receipt is settled against a bank statement. A WPS wage transfer and an
 * end-of-service settlement are settled against MOHRE, a labour court, and an
 * inspection, and the question all three ask is the one nothing recorded: *who
 * marked this paid, and when.*
 *
 * The gap was structural rather than incidental. `gratuity_settlements` carries
 * `recorded_by_id` for whoever computed the settlement and NOTHING at all for
 * whoever later marks it paid — `markGratuitySettlementPaid` does not even take
 * a `ctx`. So before the trigger existed there was no column, anywhere, that
 * could answer it. The row states the fact; only the log states the change.
 *
 * ── WHY THE ASSERTIONS ARE ON `changed_fields` AND `actor_id` ───────────────
 *
 * A count of audit rows would pass on an INSERT row the trigger writes for the
 * fixture itself, and would pass whether or not the confirmation was captured.
 * Every assertion below names the table, the record id, the action AND the
 * column that changed, and then checks who is recorded against it — because
 * "there is an audit trail" is not the claim being made. The claim is that it
 * names a person.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId } from "./_tenant";
import {
  ensureWageCycle,
  prepareWageFile,
  confirmWageTransfer,
  recordSalaryDeduction,
  recordGratuitySettlement,
  markGratuitySettlementPaid,
  activeTenantIds,
} from "../src/domain";
import { addDays, today } from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "PAYROLL-AUDIT-TEST";
const NOW = today();

/** AED 6,000 basic. */
const BASIC_MINOR = 600_000;

/**
 * 2019, and not the same 2019 months `hr.test.ts` owns.
 *
 * The compliance cron opens a wage cycle per tenant per month and never opens a
 * 2019 one, so this cycle is unambiguously this file's and is safe to delete on
 * the way out. `hr.test.ts` owns 2019-03 and 2019-01; two suites deleting each
 * other's cycles is the kind of shared-database failure that reads as a code
 * bug for an hour.
 */
const PERIOD = "2019-07-01";

/**
 * Delete every row this file creates, in every tenant, before AND after.
 *
 * A run that fails part way never reaches its own cleanup, and the next run
 * then collides on `employees_tenant_no_key` and reports the failure against
 * whichever assertion happens to touch the missing fixture. Every table here is
 * RLS-protected and FORCE'd, so a delete outside a tenant transaction removes
 * nothing, silently and with a zero row count — hence the loop.
 */
async function purge(): Promise<void> {
  const like = `${TAG}%`;

  for (const id of await activeTenantIds()) {
    await withTenant({ tenantId: id, actorKind: "system" }, async (tx) => {
      await tx.execute(sql`delete from salary_deductions where reason like ${like}`);
      await tx.execute(sql`
        delete from wage_payments where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      // Named explicitly. NEVER a structural predicate like "cycles with no
      // lines" — that is the shape of a freshly opened live one.
      await tx.execute(sql`delete from wage_cycles where period_month = ${PERIOD}::date`);
      await tx.execute(sql`
        delete from gratuity_settlements where employee_id in (
          select id from employees where full_name like ${like}
        )
      `);
      await tx.execute(sql`delete from employees where full_name like ${like}`);
    });
  }
}

/** How many audit rows name this exact record, action and changed column. */
async function auditRows(
  tenantId: string,
  where: { table: string; recordId: string; action: string; field: string },
): Promise<{ count: number; actorId: string | null; actorKind: string | null }> {
  return withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // Selected by tenant, table, record id, action and changed column — never
    // by "the newest row". Timestamps inside one transaction tie to the
    // microsecond, so ordering by `occurred_at` picks an arbitrary row.
    const rows = (await tx.execute(sql`
      select count(*)::int as n,
             min(actor_id::text) as actor_id,
             min(actor_kind) as actor_kind
        from audit_log
       where tenant_id = ${tenantId}::uuid
         and table_name = ${where.table}
         and record_id = ${where.recordId}::uuid
         and action = ${where.action}
         and changed_fields ? ${where.field}
    `)) as unknown as { n: number; actor_id: string | null; actor_kind: string | null }[];

    const row = rows[0];
    return {
      count: Number(row?.n ?? 0),
      actorId: row?.actor_id ?? null,
      actorKind: row?.actor_kind ?? null,
    };
  });
}

async function main(): Promise<void> {
  await purge();

  const tenantId = await testTenantId();

  // A real person, resolved by their role rather than taken off the top of the
  // table. The whole point of the trigger is that it records WHO, and an actor
  // that is null proves nothing.
  const hrUserId = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const rows = (await tx.execute<{ id: string }>(sql`
      select u.id
        from memberships m
        join users u on u.id = m.user_id
       where m.tenant_id = ${tenantId}::uuid and m.role = 'hr'
       order by u.email
       limit 1
    `)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error("No HR user in the seeded tenant. Run `npm run db:seed`.");
    return id;
  });

  const ctx = { tenantId, userId: hrUserId, actorKind: "user" as const };

  let employeeId = "";
  let cycleId = "";
  let wageLineId = "";
  let deductionId = "";
  let settlementId = "";
  const confirmedOn = addDays(PERIOD, 32);
  const terminatedOn = addDays(NOW, -3);

  await withTenant(ctx, async (tx) => {
    const employeeRows = (await tx.execute<{ id: string }>(sql`
      insert into employees (tenant_id, employee_no, full_name, basic_salary_minor,
                             allowances, wps_iban, contract_start, status)
      values (${tenantId}::uuid, ${`${TAG}-E1`}, ${`${TAG} Payable`}, ${BASIC_MINOR},
              '{"housing": "1500.00"}'::jsonb, 'AE070331234567890123456',
              (${NOW}::date - 400), 'active')
      returning id
    `)) as unknown as { id: string }[];
    employeeId = employeeRows[0]!.id;

    const cycle = await ensureWageCycle(tx, { tenantId }, { periodMonth: PERIOD });
    cycleId = cycle.id;

    await recordSalaryDeduction(tx, { tenantId }, {
      employeeId,
      kind: "salary_advance_repayment",
      amountMinor: 50_000,
      reason: `${TAG} advance repayment`,
      appliesOn: addDays(PERIOD, 15),
    });

    const deductionRows = (await tx.execute<{ id: string }>(sql`
      select id from salary_deductions
       where employee_id = ${employeeId}::uuid and reason = ${`${TAG} advance repayment`}
    `)) as unknown as { id: string }[];
    deductionId = deductionRows[0]!.id;

    const file = await prepareWageFile(tx, { tenantId }, cycleId, addDays(PERIOD, 28));
    const line = file.lines.find((l) => l.employeeId === employeeId);
    checkTrue("the fixture employee has a wage line", line !== undefined);

    // By employee, not by index. A leaked line from another suite sorts first.
    const lineRows = (await tx.execute<{ id: string }>(sql`
      select id from wage_payments
       where wage_cycle_id = ${cycleId}::uuid and employee_id = ${employeeId}::uuid
    `)) as unknown as { id: string }[];
    wageLineId = lineRows[0]!.id;

    // ── The WPS transfer is confirmed ──────────────────────────────────────
    await confirmWageTransfer(tx, { tenantId, userId: hrUserId }, {
      cycleId,
      transferredMinor: file.totalDueMinor,
      transferReference: `${TAG}-SIF-0001`,
      confirmedOn,
    });

    // ── The end-of-service settlement is computed, then marked paid ────────
    const settlement = await recordGratuitySettlement(tx, { tenantId, userId: hrUserId }, {
      employeeId,
      terminatedOn,
      note: `${TAG} settlement`,
    });
    settlementId = settlement.id;

    // Deliberately called exactly as the application calls it: no ctx, no
    // actor argument. Everything known about who did this comes from the
    // trigger reading the session, which is the property under test.
    await markGratuitySettlementPaid(tx, {
      settlementId,
      paidOn: addDays(terminatedOn, 5),
      reference: `${TAG}-EOS-0001`,
    });
  });

  console.log("\n— HR-17: the WPS wage transfer —");

  const cycleAudit = await auditRows(tenantId, {
    table: "wage_cycles",
    recordId: cycleId,
    action: "update",
    field: "transfer_reference",
  });
  check("confirming the transfer is on the audit trail", cycleAudit.count, 1);
  check("and it names the person who confirmed it", cycleAudit.actorId, hrUserId);
  check("as a user, not as the scheduler", cycleAudit.actorKind, "user");

  const confirmedAudit = await auditRows(tenantId, {
    table: "wage_cycles",
    recordId: cycleId,
    action: "update",
    field: "confirmed_on",
  });
  check("the day the bank confirmed is recorded as a change", confirmedAudit.count, 1);

  const lineAudit = await auditRows(tenantId, {
    table: "wage_payments",
    recordId: wageLineId,
    action: "update",
    field: "paid",
  });
  check("the employee's own line being marked paid is audited too", lineAudit.count, 1);
  check("with the same actor against it", lineAudit.actorId, hrUserId);

  console.log("\n— HR-13: the end-of-service settlement —");

  const settlementAudit = await auditRows(tenantId, {
    table: "gratuity_settlements",
    recordId: settlementId,
    action: "update",
    field: "paid_on",
  });
  check("marking a settlement paid is on the audit trail", settlementAudit.count, 1);
  // The row itself cannot answer this: `recorded_by_id` names whoever computed
  // the settlement, and there is no column at all for whoever paid it.
  check("and it names who marked it paid", settlementAudit.actorId, hrUserId);

  const referenceAudit = await auditRows(tenantId, {
    table: "gratuity_settlements",
    recordId: settlementId,
    action: "update",
    field: "payment_reference",
  });
  check("the bank reference is captured with it", referenceAudit.count, 1);

  const settlementInsert = await auditRows(tenantId, {
    table: "gratuity_settlements",
    recordId: settlementId,
    action: "insert",
    field: "__new",
  });
  check("as is the settlement being computed in the first place", settlementInsert.count, 1);

  console.log("\n— HR-16: a deduction from a protected wage —");

  const deductionAudit = await auditRows(tenantId, {
    table: "salary_deductions",
    recordId: deductionId,
    action: "insert",
    field: "__new",
  });
  check("taking money off a wage is on the audit trail", deductionAudit.count, 1);
  check("and it names who took it", deductionAudit.actorId, hrUserId);

  await purge();

  console.log(fail === 0 ? "\nAll payroll audit checks passed." : `\n${fail} check(s) FAILED.`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
