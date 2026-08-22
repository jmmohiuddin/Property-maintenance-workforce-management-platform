/**
 * The statement of account (`INV-13`) — integration test against real Postgres.
 *
 *   npx tsx packages/db/test/statement.test.ts
 *
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 *
 * A statement of account is emailed to a customer and paid against, so every
 * way of getting it subtly wrong ends in somebody paying the wrong amount:
 *
 *  1. **A missing movement.** The closing balance is computed twice here by two
 *     independent routes — a database aggregate, and the running balance down
 *     the rows — and asserted equal. One route cannot detect a dropped row.
 *  2. **A capped ledger.** Every figure on the document must be the true one,
 *     so the fixtures below deliberately exceed every page size in this
 *     repository and assert the totals moved by the full amount.
 *  3. **A period boundary in the wrong timezone.** This session runs in
 *     Asia/Dhaka, two hours ahead of Dubai. Both ends of the period are
 *     bracketed with a document whose UTC calendar date sits on the opposite
 *     side of the boundary from its Dubai date, so a wrong timezone is visible
 *     rather than merely possible. A brought-forward balance is where this
 *     bites hardest: a document on the wrong side of the opening boundary is
 *     counted twice or not at all.
 *  4. **Ageing taken as at today rather than as at the statement date.** A
 *     fixture below pays an invoice AFTER the statement date and also sets the
 *     denormalised `invoices.amount_paid` column, so a statement that reads the
 *     column instead of the dated payments reports the wrong balance and the
 *     assertion says which.
 *
 * Every expected figure is written out in fils in the comment above its
 * assertion, from the decimal amounts the fixtures insert. Nothing here is the
 * function's own output reshaped.
 */

import { sql } from "drizzle-orm";
import { withTenant, withCustomerScope, closeConnection } from "../src/index";
import { testTenantId } from "./_tenant";
import { customerStatement } from "../src/domain/commerce";
import { UserFacingError } from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const FROM = "2011-01-01";
const TO = "2011-03-31";

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const runTag = `STM-${Date.now().toString(36)}`;

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // Two customers of this run's own, so every figure below is an absolute
    // hand-computed number rather than a delta — and so the cross-customer
    // check has something real on the other side of the boundary.
    const [mine] = (await tx.execute<{ id: string }>(sql`
      insert into customers (tenant_id, code, name, trn, billing_email, billing_address,
                             billing_city, payment_terms_days, notes)
      values (${tenantId}::uuid, ${`${runTag}-A`}, ${`${runTag} Serai Tower Owners Association`},
              '100000000000003', 'accounts@example.test', 'Office 1201, Sheikh Zayed Road',
              'Dubai', 30, ${runTag})
      returning id
    `)) as unknown as { id: string }[];
    const [theirs] = (await tx.execute<{ id: string }>(sql`
      insert into customers (tenant_id, code, name, payment_terms_days, notes)
      values (${tenantId}::uuid, ${`${runTag}-B`}, ${`${runTag} Somebody Else`}, 30, ${runTag})
      returning id
    `)) as unknown as { id: string }[];

    const customerId = mine!.id;
    const otherCustomerId = theirs!.id;

    const invoice = async (input: {
      suffix: string;
      customerId?: string;
      issuedAtUtc: string;
      total: string;
      status?: string;
      writtenOffAtUtc?: string;
      amountPaidColumn?: string;
    }): Promise<void> => {
      await tx.execute(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, due_on,
                              supplier_name, supplier_trn, recipient_name,
                              subtotal, taxable_amount, tax_amount, total, amount_paid,
                              written_off_at, notes)
        values (${tenantId}::uuid, ${`${runTag}-${input.suffix}`},
                ${input.customerId ?? customerId}::uuid,
                ${input.status ?? "issued"}::invoice_status,
                ${input.issuedAtUtc}::timestamptz,
                ${input.issuedAtUtc}::timestamptz + interval '30 days',
                ${`${runTag} supplier`}, '100000000000003', ${`${runTag} recipient`},
                ${input.total}, ${input.total}, 0.00, ${input.total},
                ${input.amountPaidColumn ?? "0.00"},
                ${input.writtenOffAtUtc ?? null}::timestamptz, ${runTag})
      `);
    };

    const payment = async (input: {
      againstSuffix: string;
      receivedAtUtc: string;
      amount: string;
    }): Promise<void> => {
      await tx.execute(sql`
        insert into payments (tenant_id, invoice_id, amount, method, reference, received_at)
        select ${tenantId}::uuid, i.id, ${input.amount}, 'bank_transfer', ${runTag},
               ${input.receivedAtUtc}::timestamptz
          from invoices i where i.reference = ${`${runTag}-${input.againstSuffix}`}
      `);
    };

    const creditNote = async (input: {
      suffix: string;
      againstSuffix: string;
      issuedAtUtc: string;
      total: string;
    }): Promise<void> => {
      await tx.execute(sql`
        insert into credit_notes (tenant_id, reference, invoice_id, customer_id, reason, issued_on,
                                  supplier_name, supplier_trn, recipient_name,
                                  subtotal, taxable_amount, tax_amount, total, reason_detail)
        select ${tenantId}::uuid, ${`${runTag}-${input.suffix}`}, i.id, i.customer_id, 'correction',
               ${input.issuedAtUtc}::timestamptz, ${`${runTag} supplier`}, '100000000000003',
               ${`${runTag} recipient`}, ${input.total}, ${input.total}, 0.00, ${input.total}, ${runTag}
          from invoices i where i.reference = ${`${runTag}-${input.againstSuffix}`}
      `);
    };

    /*
     * ── THE FIXTURES ──────────────────────────────────────────────────────
     *
     * Dubai is UTC+4; this session's clock is UTC+6.
     *
     *   BEFORE the period, so they form the brought-forward balance:
     *     O1  invoice   2010-06-01 12:00Z            1,000.00  =  +100000
     *     P1  payment   2010-07-01 12:00Z              300.00  =   -30000
     *     F   invoice   2010-12-31 19:30Z              400.00  =   +40000
     *           = 23:30 on 31 Dec 2010 in Dubai, 01:30 on 1 Jan 2011 in Dhaka.
     *           A host-clock boundary pulls this INTO the period.
     *     opening = 100000 - 30000 + 40000 = 110000
     *
     *   INSIDE the period:
     *     G   invoice   2010-12-31 20:30Z              800.00  =   +80000
     *           = 00:30 on 1 Jan 2011 in Dubai, 2010 in UTC.
     *           A UTC boundary pushes this OUT of the period and into opening.
     *     A   invoice   2011-01-15 12:00Z            1,050.00  =  +105000
     *     W   invoice   2011-01-20 12:00Z              600.00  =   +60000
     *     PW  payment   2011-02-01 12:00Z              100.00  =   -10000
     *     CA  credit    2011-02-05 12:00Z              210.00  =   -21000
     *     PA  payment   2011-02-20 12:00Z              500.00  =   -50000
     *     WO  write-off 2011-03-10 12:00Z, on W    forgiven 500.00 = -50000
     *     D   invoice   2011-03-31 19:30Z              420.00  =   +42000
     *           = 23:30 on 31 Mar in Dubai, 01:30 on 1 Apr in Dhaka.
     *           A host-clock boundary drops this out of the period.
     *
     *   AFTER the period:
     *     E   invoice   2011-03-31 20:30Z              840.00
     *           = 00:30 on 1 Apr in Dubai, 31 Mar in UTC. A UTC boundary pulls
     *           this in.
     *     PD  payment on D, 2011-05-01 — AND D's amount_paid column is set to
     *           200.00, so a statement reading the column instead of the dated
     *           payments would show D as part-paid on 31 March.
     */
    await invoice({ suffix: "O1", issuedAtUtc: "2010-06-01T12:00:00Z", total: "1000.00" });
    await payment({ againstSuffix: "O1", receivedAtUtc: "2010-07-01T12:00:00Z", amount: "300.00" });
    await invoice({ suffix: "F", issuedAtUtc: "2010-12-31T19:30:00Z", total: "400.00" });
    await invoice({ suffix: "G", issuedAtUtc: "2010-12-31T20:30:00Z", total: "800.00" });
    await invoice({ suffix: "A", issuedAtUtc: "2011-01-15T12:00:00Z", total: "1050.00" });
    await invoice({
      suffix: "W",
      issuedAtUtc: "2011-01-20T12:00:00Z",
      total: "600.00",
      status: "written_off",
      writtenOffAtUtc: "2011-03-10T12:00:00Z",
    });
    await payment({ againstSuffix: "W", receivedAtUtc: "2011-02-01T12:00:00Z", amount: "100.00" });
    await creditNote({ suffix: "CA", againstSuffix: "A", issuedAtUtc: "2011-02-05T12:00:00Z", total: "210.00" });
    await payment({ againstSuffix: "A", receivedAtUtc: "2011-02-20T12:00:00Z", amount: "500.00" });
    await invoice({
      suffix: "D",
      issuedAtUtc: "2011-03-31T19:30:00Z",
      total: "420.00",
      // The denormalised column, deliberately ahead of the dated payment below.
      amountPaidColumn: "200.00",
    });
    await payment({ againstSuffix: "D", receivedAtUtc: "2011-05-01T12:00:00Z", amount: "200.00" });
    await invoice({ suffix: "E", issuedAtUtc: "2011-03-31T20:30:00Z", total: "840.00" });

    // Somebody else's invoice, in the same period, for the same tenant.
    await invoice({
      suffix: "OTHER",
      customerId: otherCustomerId,
      issuedAtUtc: "2011-02-14T12:00:00Z",
      total: "9999.00",
    });

    // A draft, which is not a document and is not owed.
    await invoice({
      suffix: "DRAFT",
      issuedAtUtc: "2011-02-15T12:00:00Z",
      total: "7777.00",
      status: "draft",
    });

    console.log("— the brought-forward balance —");

    const statement = await customerStatement(tx, { customerId, from: FROM, to: TO });

    // 100000 - 30000 + 40000 = 110000. F is on the far side of the opening
    // boundary in Dubai and on THIS side of it in the host's zone, so a
    // host-clock boundary gives 70000 here and 150000 in the movements.
    check("the balance brought forward is 110,000 fils", statement.openingBalanceMinor, 110_000);

    console.log("\n— the period boundary, bracketed —");

    const referenced = statement.entries.map((e) => e.reference);
    checkTrue(
      "23:30 Dubai on the day before the period is NOT a movement (a host clock adds it)",
      !referenced.includes(`${runTag}-F`),
    );
    checkTrue(
      "00:30 Dubai on the first day of the period IS one (a UTC clock drops it)",
      referenced.includes(`${runTag}-G`),
    );
    checkTrue(
      "23:30 Dubai on the last day of the period IS one (a host clock drops it)",
      referenced.includes(`${runTag}-D`),
    );
    checkTrue(
      "00:30 Dubai on the first day of the next period is NOT (a UTC clock adds it)",
      !referenced.includes(`${runTag}-E`),
    );
    checkTrue("and a draft never appears", !referenced.includes(`${runTag}-DRAFT`));
    checkTrue(
      "nor does another customer's invoice, in the same tenant and the same month",
      !referenced.includes(`${runTag}-OTHER`),
    );

    console.log("\n— the totals —");

    // G 80000 + A 105000 + W 60000 + D 42000 = 287000
    check("invoiced in the period is 287,000 fils", statement.invoicedMinor, 287_000);
    check("credited is 21,000 fils", statement.creditedMinor, 21_000);
    // PW 10000 + PA 50000 = 60000. PD is dated after the period and is not here.
    check("paid is 60,000 fils", statement.paidMinor, 60_000);
    // W's total 60000, less the 10000 paid before it was written off.
    check("written off is 50,000 fils — the forgiven part, not the invoice", statement.writtenOffMinor, 50_000);
    // 110000 + 287000 - 21000 - 60000 - 50000 = 266000
    check("the closing balance is 266,000 fils", statement.closingBalanceMinor, 266_000);

    check("there are eight movements in the period", statement.entries.length, 8);

    // ── Two routes to one number ────────────────────────────────────────────
    //
    // The totals above are database aggregates. The running balance is folded
    // down the rows. They are computed independently and must land on the same
    // figure — which is the only check that can catch a movement the aggregate
    // counted and the list dropped, or the reverse.
    console.log("\n— two routes to the closing balance —");
    check(
      "the running balance on the last row equals the closing balance",
      statement.entries[statement.entries.length - 1]?.balanceMinor,
      statement.closingBalanceMinor,
    );
    check(
      "and the opening balance plus every movement equals it too",
      statement.openingBalanceMinor + statement.entries.reduce((t, e) => t + e.amountMinor, 0),
      266_000,
    );
    check(
      "the movements are in date order, oldest first",
      statement.entries.map((e) => e.occurredAt.getTime()).join(","),
      [...statement.entries].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())
        .map((e) => e.occurredAt.getTime())
        .join(","),
    );
    check(
      "the write-off is a ledger row rather than a footer adjustment",
      statement.entries.filter((e) => e.kind === "write_off").length,
      1,
    );
    check(
      "and it carries no internal reason text, because this document goes to the customer",
      statement.entries.find((e) => e.kind === "write_off")?.detail,
      null,
    );

    // ── Ageing as at the statement date, not as at today ────────────────────
    console.log("\n— ageing, as at 31 March 2011 —");

    // Open at 31 March 2011, with days overdue from each invoice's due date:
    //   O1  70000 outstanding, due 2010-07-01 — 273 days   -> over 60
    //   F   40000 outstanding, due 2011-01-30 —  60 days   -> 31 to 60
    //   G   80000 outstanding, due 2011-01-31 —  59 days   -> 31 to 60
    //   A   34000 outstanding (105000 - 21000 credit - 50000 paid),
    //             due 2011-02-14 — 45 days                 -> 31 to 60
    //   D   42000 outstanding, due 2011-04-30 — not yet due -> current
    //   W   written off on 10 March, so no longer receivable
    //   E   issued 1 April in Dubai, so not yet issued
    check("nothing is 1 to 30 days overdue", statement.ageing.days1to30Minor, 0);
    check("31 to 60 days holds 154,000 fils", statement.ageing.days31to60Minor, 154_000);
    check("over 60 days holds 70,000 fils", statement.ageing.days61PlusMinor, 70_000);
    check(
      "and the invoice issued at 23:30 on the closing day is aged as not yet due, 42,000 fils",
      statement.ageing.currentMinor,
      42_000,
    );
    // The strongest available statement about this document: the four buckets
    // are computed per invoice from dated events, the closing balance is a
    // ledger aggregate, and on an account with nothing overpaid they must be
    // the same number.
    check(
      "the four buckets add up to the closing balance",
      statement.ageing.totalMinor,
      statement.closingBalanceMinor,
    );
    check("the oldest overdue invoice is named", statement.oldestOverdue?.reference, `${runTag}-O1`);
    check("with its age in days", statement.oldestOverdue?.daysOverdue, 273);

    // D was paid 200.00 on 1 May, and its `amount_paid` column already says so.
    // A statement dated 31 March that read the column would age D at 22000.
    checkTrue(
      "a payment received after the statement date has not been applied to it",
      statement.ageing.currentMinor === 42_000,
    );

    const later = await customerStatement(tx, { customerId, from: FROM, to: "2011-06-30" });
    // The May payment (-20000) and E (+84000) both arrive: 266000 + 84000 - 20000 = 330000.
    check("extending the period to 30 June picks both of them up", later.closingBalanceMinor, 330_000);
    check("as two more movements", later.entries.length, 10);

    // ── The whole account, with no start date ──────────────────────────────
    console.log("\n— the whole account —");

    const whole = await customerStatement(tx, { customerId, to: TO });
    check("with no start date there is nothing to bring forward", whole.openingBalanceMinor, 0);
    check("and every movement is a row: three before the period plus eight in it", whole.entries.length, 11);
    check("the closing balance is the same 266,000 fils either way", whole.closingBalanceMinor, 266_000);
    check(
      "which is the check a brought-forward balance exists to survive",
      whole.closingBalanceMinor,
      statement.closingBalanceMinor,
    );

    // ── The capped-list catcher ─────────────────────────────────────────────
    //
    // Fifty-five more invoices in the period — more than `listPortalInvoices`
    // returns by default (50), more than the invoice search page shows (25),
    // and more than any other page size in this repository. If any figure below
    // came from a capped list, it would move by less than the full amount.
    console.log("\n— more rows than any page —");

    const bulk = 55;
    for (let i = 0; i < bulk; i++) {
      await invoice({
        suffix: `BULK${String(i).padStart(2, "0")}`,
        issuedAtUtc: "2011-02-25T12:00:00Z",
        total: "11.00",
      });
    }

    const big = await customerStatement(tx, { customerId, from: FROM, to: TO });
    // 55 invoices at 1,100 fils each = 60,500 fils.
    check("invoiced moved by the full 60,500 fils", big.invoicedMinor - statement.invoicedMinor, 60_500);
    check("the closing balance moved by the same", big.closingBalanceMinor - statement.closingBalanceMinor, 60_500);
    check("and every one of the 55 is a row", big.entries.length - statement.entries.length, bulk);
    check(
      "the running balance still lands on the aggregate",
      big.entries[big.entries.length - 1]?.balanceMinor,
      big.closingBalanceMinor,
    );

    // ── Refusals ────────────────────────────────────────────────────────────
    console.log("\n— refusals —");

    let backwards = false;
    try {
      await customerStatement(tx, { customerId, from: TO, to: FROM });
    } catch (error) {
      backwards = error instanceof UserFacingError;
    }
    checkTrue("a backwards period is refused rather than returning an empty ledger", backwards);

    let unknown = false;
    try {
      await customerStatement(tx, {
        customerId: "00000000-0000-4000-8000-000000000000",
        to: TO,
      });
    } catch (error) {
      unknown = error instanceof UserFacingError;
    }
    checkTrue("an unknown account is refused", unknown);

    // ── Cleanup, anchored to this run's tag ────────────────────────────────
    await tx.execute(sql`delete from payments where reference = ${runTag}`);
    await tx.execute(sql`delete from credit_notes where reason_detail = ${runTag}`);
    await tx.execute(sql`delete from invoices where notes = ${runTag}`);
    await tx.execute(sql`delete from customers where notes = ${runTag}`);
  });

  // ── Customer-scope RLS ─────────────────────────────────────────────────────
  //
  // A portal session asking for somebody else's statement must find the account
  // ABSENT rather than be told "forbidden" — which is what the restrictive
  // policies in sql/customer-scope.sql produce, and what the function's error
  // message is worded not to contradict. Run against a real seeded customer
  // pair, after this run's fixtures are gone.
  console.log("\n— customer scope —");

  const pair = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const rows = (await tx.execute<{ id: string }>(sql`
      select id from customers where deleted_at is null order by created_at limit 2
    `)) as unknown as { id: string }[];
    return rows;
  });

  if (pair.length < 2) {
    console.log("skip  fewer than two customers seeded — cannot prove customer scope");
  } else {
    const [first, second] = pair as [{ id: string }, { id: string }];

    const own = await withCustomerScope(
      { tenantId, customerId: first.id, actorKind: "customer" },
      (tx) => customerStatement(tx, { customerId: first.id, to: "2100-01-01" }),
    );
    check("a portal session can read its own account", own.customer.customerId, first.id);

    let absent = false;
    try {
      await withCustomerScope(
        { tenantId, customerId: first.id, actorKind: "customer" },
        (tx) => customerStatement(tx, { customerId: second.id, to: "2100-01-01" }),
      );
    } catch (error) {
      absent = error instanceof UserFacingError;
    }
    checkTrue(
      "and cannot read another customer's, because the row is absent rather than filtered",
      absent,
    );
  }

  console.log(fail === 0 ? "\nstatement: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("statement test failed to run:", error);
  await closeConnection();
  process.exit(1);
});
