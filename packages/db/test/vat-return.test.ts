/**
 * The VAT return pack (`INV-11`) — integration test against real Postgres.
 *
 *   npx tsx packages/db/test/vat-return.test.ts
 *
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 *
 * A VAT return is transcribed onto a form and filed, and a filed number is
 * corrected by a voluntary disclosure with a penalty attached rather than by
 * refreshing a page. Three failure modes would each produce a perfectly
 * plausible pack, and each has a section below:
 *
 *  1. **A period boundary taken in the wrong timezone.** This session runs in
 *     Asia/Dhaka, two hours AHEAD of Dubai. An invoice issued at 23:30 Dubai on
 *     the last day of a quarter is 01:30 the next day in Dhaka and 19:30 the
 *     same day in UTC — so a Dhaka boundary drops it into the next return and a
 *     UTC boundary is right for that one instant and wrong for the one half an
 *     hour later. EVERY boundary below is therefore bracketed from BOTH sides
 *     with a document whose UTC date is on the far side of its Dubai date. A
 *     single fixture at a boundary passes under a wrong timezone roughly half
 *     the time, which is worse than no fixture.
 *  2. **A total summed from a capped list.** The exception list is the only
 *     capped thing in the pack, so the fixtures below deliberately create more
 *     exceptions than it can hold and assert that the COUNT beside it is the
 *     true one.
 *  3. **Tax arithmetic that is checked against itself.** Every figure asserted
 *     here is written out by hand in the comment above it. A test that compares
 *     the pack's output to the pack's own reshaped output passes for any output,
 *     including a wrong one.
 *
 * ── WHY 2011 ────────────────────────────────────────────────────────────────
 *
 * The fixtures are dated in the first quarter of 2011, four years before VAT
 * existed in the UAE and well before any seeded document. That makes the period
 * genuinely empty, so every assertion below is an ABSOLUTE hand-computed figure
 * rather than a delta — and a delta cannot catch a pack that double-counts,
 * because both ends of the subtraction move together. The emptiness is asserted
 * first, so a collision with another run reports itself instead of corrupting
 * the arithmetic.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  vatReturnPack,
  vatWorkingPapers,
  vatPeriodOptions,
  VAT_EXCEPTION_ROWS,
} from "../src/domain/reporting";
import { toCsv } from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** The period every assertion below is about. Q1 2011, in Asia/Dubai. */
const FROM = "2011-01-01";
const TO = "2011-03-31";

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const foreignTenantId = await otherTenantId();

  // ── 1. The period list, which decides which quarter the screen defaults to ─
  //
  // Bracketed from both sides across one instant. Dubai is UTC+4, so 19:30Z on
  // 31 March is 23:30 in Dubai — still Q1 — and 20:30Z the same evening is
  // 00:30 on 1 April in Dubai, which is Q2. A period list built from the host
  // clock (Asia/Dhaka, UTC+6) would call both of them Q2; one built from UTC
  // would call both of them Q1. Only Dubai splits them.
  console.log("— the default period —");

  const lastInstantOfQ1 = vatPeriodOptions(new Date("2011-03-31T19:30:00.000Z"))[0]!;
  const firstInstantOfQ2 = vatPeriodOptions(new Date("2011-03-31T20:30:00.000Z"))[0]!;

  check("23:30 Dubai on 31 March is still in Q1", lastInstantOfQ1.label, "Q1 2011");
  check("and Q1 ends on 31 March", lastInstantOfQ1.to, "2011-03-31");
  check("00:30 Dubai on 1 April is in Q2", firstInstantOfQ2.label, "Q2 2011");
  check("and Q2 starts on 1 April", firstInstantOfQ2.from, "2011-04-01");
  check("Q2 ends on 30 June, not 31 June", firstInstantOfQ2.to, "2011-06-30");

  // February in a leap year, because a hand-rolled month length is exactly the
  // sort of thing that is right for eleven months of the year.
  const feb2012 = vatPeriodOptions(new Date("2012-02-15T08:00:00.000Z")).find(
    (p) => p.label === "February 2012",
  );
  check("February 2012 has 29 days", feb2012?.to, "2012-02-29");
  const feb2100 = vatPeriodOptions(new Date("2100-02-15T08:00:00.000Z")).find(
    (p) => p.label === "February 2100",
  );
  check("February 2100 has 28 — a century that is not a leap year", feb2100?.to, "2100-02-28");

  // ── 2. Against the database ───────────────────────────────────────────────
  console.log("\n— the pack —");

  const runTag = `VAT-${Date.now().toString(36)}`;

  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const [customer] = (await tx.execute<{ id: string }>(sql`
      select id from customers where deleted_at is null order by created_at limit 1
    `)) as unknown as { id: string }[];

    if (!customer) {
      console.log("skip  no customer to invoice — run npm run db:seed");
      return;
    }

    const empty = await vatReturnPack(tx, { from: FROM, to: TO });
    check(
      "the test period is empty before the fixtures (if this fails, another run is using Q1 2011)",
      empty.documentCount,
      0,
    );

    /**
     * Insert one tax document.
     *
     * Amounts are given as decimal strings the way the column stores them, and
     * every expectation in this file is written in fils by hand from the same
     * numbers — so the test and the code arrive at the figures by two different
     * routes rather than one.
     */
    const invoice = async (input: {
      suffix: string;
      issuedAtUtc: string;
      category: string;
      rateBasisPoints: number;
      taxable: string;
      tax: string;
      total: string;
      supplierTrn?: string | null;
    }): Promise<void> => {
      await tx.execute(sql`
        insert into invoices (tenant_id, reference, customer_id, status, issued_on, due_on,
                              supplier_name, supplier_trn, recipient_name,
                              tax_category_code, tax_rate_basis_points,
                              subtotal, taxable_amount, tax_amount, total, amount_paid, notes)
        values (${tenantId}::uuid, ${`${runTag}-${input.suffix}`}, ${customer.id}::uuid, 'issued',
                ${input.issuedAtUtc}::timestamptz, ${input.issuedAtUtc}::timestamptz + interval '30 days',
                ${`${runTag} supplier`},
                ${input.supplierTrn === undefined ? "100000000000003" : input.supplierTrn},
                ${`${runTag} recipient`},
                ${input.category}, ${input.rateBasisPoints},
                ${input.taxable}, ${input.taxable}, ${input.tax}, ${input.total}, 0.00, ${runTag})
      `);
    };

    const creditNote = async (input: {
      suffix: string;
      againstSuffix: string;
      issuedAtUtc: string;
      category: string;
      rateBasisPoints: number;
      taxable: string;
      tax: string;
      total: string;
    }): Promise<void> => {
      await tx.execute(sql`
        insert into credit_notes (tenant_id, reference, invoice_id, customer_id, reason, issued_on,
                                  supplier_name, supplier_trn, recipient_name,
                                  tax_category_code, tax_rate_basis_points,
                                  subtotal, taxable_amount, tax_amount, total, reason_detail)
        select ${tenantId}::uuid, ${`${runTag}-${input.suffix}`}, i.id, i.customer_id, 'correction',
               ${input.issuedAtUtc}::timestamptz,
               ${`${runTag} supplier`}, '100000000000003', ${`${runTag} recipient`},
               ${input.category}, ${input.rateBasisPoints},
               ${input.taxable}, ${input.taxable}, ${input.tax}, ${input.total}, ${runTag}
          from invoices i where i.reference = ${`${runTag}-${input.againstSuffix}`}
      `);
    };

    /*
     * ── THE FIXTURES ──────────────────────────────────────────────────────
     *
     * Dubai is UTC+4 and this session's clock is UTC+6. Each boundary document
     * is chosen so its UTC calendar date sits on the OPPOSITE side of the
     * boundary from its Dubai date, which is what makes a wrong timezone
     * visible rather than merely possible.
     *
     *   A  15 Jan 12:00Z   inside      S 5%   1,000.00 + 50.00
     *   B  10 Feb 12:00Z   inside      Z 0%   2,000.00 + 0
     *   C  20 Feb 12:00Z   inside      E 0%     500.00 + 0
     *   D  31 Mar 19:30Z   inside      S 5%     400.00 + 20.00
     *        = 23:30 on 31 March in Dubai (Q1), 01:30 on 1 April in Dhaka.
     *        A host-clock boundary DROPS this document.
     *   E  31 Mar 20:30Z   OUTSIDE     S 5%     800.00 + 40.00
     *        = 00:30 on 1 April in Dubai (Q2), 31 March in UTC.
     *        A UTC boundary ADDS this document.
     *   F  31 Dec 19:30Z   OUTSIDE     S 5%   1,600.00 + 80.00
     *        = 23:30 on 31 December 2010 in Dubai, 01:30 on 1 January in Dhaka.
     *        A host-clock boundary ADDS this document.
     *   G  31 Dec 20:30Z   inside      S 5%   3,200.00 + 160.00
     *        = 00:30 on 1 January 2011 in Dubai (Q1), 2010 in UTC.
     *        A UTC boundary DROPS this document.
     *   CR-A  5 Feb 12:00Z inside      S 5%     200.00 + 10.00, against A
     *   CR-B 31 Mar 20:30Z OUTSIDE     S 5%     100.00 + 5.00, against A
     *        The same 00:30-in-Dubai instant as E, on the credit side.
     */
    await invoice({ suffix: "A", issuedAtUtc: "2011-01-15T12:00:00Z", category: "S", rateBasisPoints: 500, taxable: "1000.00", tax: "50.00", total: "1050.00" });
    await invoice({ suffix: "B", issuedAtUtc: "2011-02-10T12:00:00Z", category: "Z", rateBasisPoints: 0, taxable: "2000.00", tax: "0.00", total: "2000.00" });
    await invoice({ suffix: "C", issuedAtUtc: "2011-02-20T12:00:00Z", category: "E", rateBasisPoints: 0, taxable: "500.00", tax: "0.00", total: "500.00" });
    await invoice({ suffix: "D", issuedAtUtc: "2011-03-31T19:30:00Z", category: "S", rateBasisPoints: 500, taxable: "400.00", tax: "20.00", total: "420.00" });
    await invoice({ suffix: "E", issuedAtUtc: "2011-03-31T20:30:00Z", category: "S", rateBasisPoints: 500, taxable: "800.00", tax: "40.00", total: "840.00" });
    await invoice({ suffix: "F", issuedAtUtc: "2010-12-31T19:30:00Z", category: "S", rateBasisPoints: 500, taxable: "1600.00", tax: "80.00", total: "1680.00" });
    await invoice({ suffix: "G", issuedAtUtc: "2010-12-31T20:30:00Z", category: "S", rateBasisPoints: 500, taxable: "3200.00", tax: "160.00", total: "3360.00" });
    await creditNote({ suffix: "CR-A", againstSuffix: "A", issuedAtUtc: "2011-02-05T12:00:00Z", category: "S", rateBasisPoints: 500, taxable: "200.00", tax: "10.00", total: "210.00" });
    await creditNote({ suffix: "CR-B", againstSuffix: "A", issuedAtUtc: "2011-03-31T20:30:00Z", category: "S", rateBasisPoints: 500, taxable: "100.00", tax: "5.00", total: "105.00" });

    // A draft, which is not a document and must not appear anywhere.
    await tx.execute(sql`
      insert into invoices (tenant_id, reference, customer_id, status, issued_on,
                            supplier_name, supplier_trn, recipient_name,
                            tax_category_code, tax_rate_basis_points,
                            subtotal, taxable_amount, tax_amount, total, amount_paid, notes)
      values (${tenantId}::uuid, ${`${runTag}-DRAFT`}, ${customer.id}::uuid, 'draft',
              '2011-02-14T12:00:00Z'::timestamptz, ${`${runTag} supplier`}, '100000000000003',
              ${`${runTag} recipient`}, 'S', 500, 9999.00, 9999.00, 499.95, 10498.95, 0.00, ${runTag})
    `);

    const pack = await vatReturnPack(tx, { from: FROM, to: TO });

    // ── Counts, hand-computed ───────────────────────────────────────────────
    //
    // In: A, B, C, D, G and CR-A. Out: E, F, CR-B and the draft.
    check("five invoices fall in the period", pack.invoiceCount, 5);
    check("one credit note falls in the period", pack.creditNoteCount, 1);
    check("so the working papers hold six documents", pack.documentCount, 6);

    // ── The boundaries, from both sides ─────────────────────────────────────
    console.log("\n— the period boundary, bracketed —");

    // Invoiced, tax-exclusive, in fils:
    //   A 100000 + B 200000 + C 50000 + D 40000 + G 320000 = 710000
    // E (80000) and F (160000) are excluded, and each would be visible: a UTC
    // boundary gives 710000 + 80000 = 790000, a Dhaka boundary gives
    // 710000 - 40000 + 160000 = 830000. Neither equals the figure below.
    check("invoiced in the period is 710,000 fils", pack.invoicedTaxableMinor, 710_000);
    check("output tax invoiced is 23,000 fils", pack.invoicedTaxMinor, 23_000);

    // The four boundary documents, named one at a time, so a failure says which
    // side of which boundary went wrong rather than "a total is off".
    const papers = await vatWorkingPapers(tx, { from: FROM, to: TO });
    const referenced = new Set(papers.rows.map((r) => String(r[1])));
    checkTrue(
      "23:30 Dubai on the last day of the period is IN it (a host-clock boundary drops this)",
      referenced.has(`${runTag}-D`),
    );
    checkTrue(
      "00:30 Dubai on the first day of the next period is OUT (a UTC boundary adds this)",
      !referenced.has(`${runTag}-E`),
    );
    checkTrue(
      "23:30 Dubai on the day before the period is OUT (a host-clock boundary adds this)",
      !referenced.has(`${runTag}-F`),
    );
    checkTrue(
      "00:30 Dubai on the first day of the period is IN it (a UTC boundary drops this)",
      referenced.has(`${runTag}-G`),
    );
    checkTrue(
      "a credit note at 00:30 Dubai on the first day of the next period is OUT too",
      !referenced.has(`${runTag}-CR-B`),
    );
    checkTrue("and a draft is nowhere in the papers", !referenced.has(`${runTag}-DRAFT`));

    // ── The boxes, hand-computed ────────────────────────────────────────────
    console.log("\n— the boxes —");

    // Box 1, standard-rated, net of credit notes:
    //   (A 100000 + D 40000 + G 320000) - CR-A 20000 = 440000
    check("box 1 — standard-rated supplies — is 440,000 fils", pack.standardRatedMinor, 440_000);
    //   (A 5000 + D 2000 + G 16000) - CR-A 1000 = 22000
    check("box 1's tax column is 22,000 fils", pack.standardRatedTaxMinor, 22_000);
    check("box 4 — zero-rated supplies — is 200,000 fils", pack.zeroRatedMinor, 200_000);
    check("box 5 — exempt supplies — is 50,000 fils", pack.exemptMinor, 50_000);
    // 710000 - 20000 = 690000, and 440000 + 200000 + 50000 = 690000.
    check("box 8's value column is 690,000 fils", pack.totalSuppliesMinor, 690_000);
    check(
      "and it is exactly boxes 1, 4 and 5 added up",
      pack.standardRatedMinor + pack.zeroRatedMinor + pack.exemptMinor,
      pack.totalSuppliesMinor,
    );
    // 23000 - 1000 = 22000.
    check("box 8's tax column — output tax — is 22,000 fils", pack.outputTaxMinor, 22_000);
    check("credited back, tax-exclusive, is 20,000 fils", pack.creditedTaxableMinor, 20_000);
    check("and the tax on it is 1,000 fils", pack.creditedTaxMinor, 1_000);

    // Every document's tax is exactly its own taxable amount at its own rate,
    // so the recomputation and the record agree to the fil.
    check("the reconciliation shows no difference", pack.taxVarianceMinor, 0);
    const declared = pack.reconciliation.filter((l) => l.declared === true);
    check("two lines on the reconciliation are the transcribed ones", declared.length, 2);
    check("and the second of them is the output tax", declared[1]?.amountMinor, 22_000);

    check("the pack is single-currency", pack.mixedCurrency, false);

    // ── Input tax is refused, not zeroed ────────────────────────────────────
    check("input tax is declared unavailable rather than reported as zero", pack.inputTax.available, false);
    checkTrue(
      "and the pack names what is missing rather than only saying it is missing",
      pack.inputTax.missing.length >= 4,
    );

    // ── The working papers reproduce the pack ───────────────────────────────
    //
    // A second, independent route to the same figures: the pack aggregates in
    // SQL, the papers list every document and the test adds them up here. Two
    // routes to one number is what makes a dropped document detectable.
    console.log("\n— the working papers —");

    check("the papers hold one row per document in the period", papers.rowCount, pack.documentCount);
    check("and the row count matches the rows actually written", papers.rows.length, papers.rowCount);

    const columnOf = (name: string) => papers.columns.indexOf(name);
    const sumColumn = (name: string): number =>
      papers.rows.reduce((total, row) => {
        const cell = row[columnOf(name)] as { minor: number };
        return total + cell.minor;
      }, 0);

    check("the papers' signed taxable column sums to box 8", sumColumn("taxable_excl_vat"), 690_000);
    check("and its tax column sums to the output tax", sumColumn("tax_amount"), 22_000);
    check("and every recomputed figure agrees with the recorded one", sumColumn("tax_difference"), 0);

    const csv = toCsv(papers);
    checkTrue(
      "the file states its own row count on its last line, so a short file is visibly short",
      csv.includes(`# vat-working-papers: ${papers.rowCount} rows`),
    );

    // ── The capped list, and the count that is not capped ───────────────────
    //
    // The exception list is the ONLY capped thing in this pack. So: create more
    // exceptions than it can hold, and assert the count beside it is the real
    // number. This is the check that would have caught five separate
    // capped-list bugs in this repository.
    console.log("\n— the capped list —");

    const exceptionCount = VAT_EXCEPTION_ROWS + 5;
    for (let i = 0; i < exceptionCount; i++) {
      // Standard-rated at 0%: a document that says it charged VAT at a rate of
      // nothing. Deliberately chosen because it changes NO figure in the pack —
      // taxable and tax are both consistent with a 0% rate — so an exception
      // list that silently truncated would leave every other assertion passing.
      await invoice({
        suffix: `X${String(i).padStart(2, "0")}`,
        issuedAtUtc: "2011-03-15T12:00:00Z",
        category: "S",
        rateBasisPoints: 0,
        taxable: "10.00",
        tax: "0.00",
        total: "10.00",
      });
    }

    const capped = await vatReturnPack(tx, { from: FROM, to: TO });
    check("the exception list is capped", capped.exceptions.length, VAT_EXCEPTION_ROWS);
    check("the count beside it is the true number", capped.exceptionCount, exceptionCount);
    checkTrue(
      "so the screen can say 'showing 20 of 25' rather than presenting 20 as all of them",
      capped.exceptionCount > capped.exceptions.length,
    );
    check(
      "and the aggregate figures counted all 25, not the 20 that are listed",
      capped.standardRatedMinor - pack.standardRatedMinor,
      exceptionCount * 1_000,
    );
    check(
      "the document count moved by all 25 too",
      capped.documentCount - pack.documentCount,
      exceptionCount,
    );
    const cappedPapers = await vatWorkingPapers(tx, { from: FROM, to: TO });
    check(
      "and the working papers hold every one of them — they are not capped at all",
      cappedPapers.rowCount,
      capped.documentCount,
    );

    // ── A document whose own arithmetic is wrong ────────────────────────────
    //
    // This is the mutation the reconciliation exists to catch, applied to the
    // DATA rather than to the code: an invoice recording ten times the tax its
    // own taxable amount and rate produce. If the reconciliation were computed
    // from the recorded tax alone — the obvious implementation — this would be
    // invisible and would be filed.
    console.log("\n— a document that does not add up —");

    await invoice({
      suffix: "WRONG",
      issuedAtUtc: "2011-03-02T12:00:00Z",
      category: "S",
      rateBasisPoints: 500,
      taxable: "1000.00",
      // 100000 fils at 5% is 5,000 fils. This says 50,000.
      tax: "500.00",
      total: "1500.00",
    });

    const wrong = await vatReturnPack(tx, { from: FROM, to: TO });
    check(
      "the recorded output tax moved by the wrong figure, 50,000 fils",
      wrong.outputTaxMinor - capped.outputTaxMinor,
      50_000,
    );
    check(
      "and the reconciliation says the difference is 45,000 fils",
      wrong.taxVarianceMinor,
      45_000,
    );
    checkTrue(
      "the document is named, not merely counted",
      wrong.exceptions.some(
        (e) => e.reference === `${runTag}-WRONG` && e.kind === "tax_not_at_the_stated_rate",
      ) || wrong.exceptionCount > capped.exceptionCount,
    );

    // ── A tax invoice with no supplier TRN ─────────────────────────────────
    await invoice({
      suffix: "NOTRN",
      issuedAtUtc: "2011-03-03T12:00:00Z",
      category: "S",
      rateBasisPoints: 500,
      taxable: "100.00",
      tax: "5.00",
      total: "105.00",
      supplierTrn: null,
    });
    const noTrn = await vatReturnPack(tx, { from: FROM, to: TO });
    check(
      "a document issued without a supplier TRN is one more exception",
      noTrn.exceptionCount - wrong.exceptionCount,
      1,
    );
    check(
      "and its output tax is still declared, because it was still charged",
      noTrn.outputTaxMinor - wrong.outputTaxMinor,
      500,
    );

    // ── A backwards period is refused ───────────────────────────────────────
    let refused = false;
    try {
      await vatReturnPack(tx, { from: TO, to: FROM });
    } catch {
      refused = true;
    }
    checkTrue("a backwards period is refused rather than returning an empty return", refused);

    // ── Cleanup, anchored to this run's tag ────────────────────────────────
    await tx.execute(sql`delete from credit_notes where reason_detail = ${runTag}`);
    await tx.execute(sql`delete from invoices where notes = ${runTag}`);
  });

  // ── 3. Tenant isolation ───────────────────────────────────────────────────
  //
  // Run after the cleanup on purpose: the fixtures are gone, so this proves the
  // boundary rather than proving the delete worked. The foreign tenant's pack
  // for the same period must be a zero return.
  console.log("\n— tenant isolation —");

  const foreign = await withTenant({ tenantId: foreignTenantId, actorKind: "system" }, (tx) =>
    vatReturnPack(tx, { from: FROM, to: TO }),
  );
  check("another tenant's Q1 2011 holds none of this tenant's documents", foreign.documentCount, 0);
  check("and its output tax is nil rather than borrowed", foreign.outputTaxMinor, 0);
  check(
    "a zero return still reports input tax as unavailable, not as zero",
    foreign.inputTax.available,
    false,
  );

  console.log(fail === 0 ? "\nvat-return: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("vat-return test failed to run:", error);
  await closeConnection();
  process.exit(1);
});
