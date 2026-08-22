/**
 * What actually comes out of the statement renderer (`INV-13`).
 *
 * Reads the bytes back, not the input. A statement is a demand for money that
 * gets emailed to a customer, so the properties worth testing are the ones on
 * the FACE of the document: that the running balance is printed beside each
 * movement, that the closing figure is there under a label saying which way it
 * goes, that a write-off never carries the internal reason it was written off
 * for, and that an account in credit is not shown as owing money. An assertion
 * on the object passed in proves only that the fixture was well-formed.
 *
 * No database. The domain function is tested against Postgres in
 * `packages/db/test/statement.test.ts`; this is about the page.
 */

import { renderStatement } from "@meridian/docs";
import type { CustomerStatement } from "@meridian/db";
import { pdfText } from "./pdf-text";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function contains(label: string, haystack: string, needle: string): void {
  const ok = haystack.includes(needle);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — "${needle}" is not on the document`}`);
}
function absent(label: string, haystack: string, needle: string): void {
  const ok = !haystack.includes(needle);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — "${needle}" should not be on the document`}`);
}

/**
 * The same account the database test builds, with the same figures.
 *
 * Written out here rather than imported so that a change to the domain function
 * that silently altered the shape shows up as a compile error in this file
 * instead of as a document that renders differently.
 *
 *   brought forward             1,100.00
 *   + invoiced                  2,870.00
 *   - credited                    210.00
 *   - paid                        600.00
 *   - written off                 500.00
 *   = balance due               2,660.00
 */
const STATEMENT: CustomerStatement = {
  customer: {
    customerId: "6cc3f2b2-3a9e-4d0b-9d2f-1f5c9d3a7b11",
    code: "CUS-0042",
    name: "Serai Tower Owners Association",
    trn: "100999888700003",
    address: "Office 1201, Sheikh Zayed Road, Dubai, AE",
    billingEmail: "accounts@example.test",
    paymentTermsDays: 30,
  },
  from: "2011-01-01",
  to: "2011-03-31",
  generatedAt: new Date("2011-03-31T08:00:00.000Z"),
  currency: "AED",
  openingBalanceMinor: 110_000,
  entries: [
    { kind: "invoice", reference: "INV-2011-0001", occurredAt: new Date("2010-12-31T20:30:00Z"), occurredOn: "2011-01-01", amountMinor: 80_000, detail: null, balanceMinor: 190_000 },
    { kind: "invoice", reference: "INV-2011-0002", occurredAt: new Date("2011-01-15T12:00:00Z"), occurredOn: "2011-01-15", amountMinor: 105_000, detail: null, balanceMinor: 295_000 },
    { kind: "invoice", reference: "INV-2011-0003", occurredAt: new Date("2011-01-20T12:00:00Z"), occurredOn: "2011-01-20", amountMinor: 60_000, detail: null, balanceMinor: 355_000 },
    { kind: "payment", reference: "INV-2011-0003", occurredAt: new Date("2011-02-01T12:00:00Z"), occurredOn: "2011-02-01", amountMinor: -10_000, detail: "bank_transfer", balanceMinor: 345_000 },
    { kind: "credit_note", reference: "CRN-2011-0001", occurredAt: new Date("2011-02-05T12:00:00Z"), occurredOn: "2011-02-05", amountMinor: -21_000, detail: "correction", balanceMinor: 324_000 },
    { kind: "payment", reference: "INV-2011-0002", occurredAt: new Date("2011-02-20T12:00:00Z"), occurredOn: "2011-02-20", amountMinor: -50_000, detail: "bank_transfer", balanceMinor: 274_000 },
    { kind: "write_off", reference: "INV-2011-0003", occurredAt: new Date("2011-03-10T12:00:00Z"), occurredOn: "2011-03-10", amountMinor: -50_000, detail: null, balanceMinor: 224_000 },
    { kind: "invoice", reference: "INV-2011-0004", occurredAt: new Date("2011-03-31T19:30:00Z"), occurredOn: "2011-03-31", amountMinor: 42_000, detail: null, balanceMinor: 266_000 },
  ],
  invoicedMinor: 287_000,
  creditedMinor: 21_000,
  paidMinor: 60_000,
  writtenOffMinor: 50_000,
  closingBalanceMinor: 266_000,
  ageing: {
    currentMinor: 42_000,
    days1to30Minor: 0,
    days31to60Minor: 154_000,
    days61PlusMinor: 70_000,
    totalMinor: 266_000,
  },
  oldestOverdue: { reference: "INV-2010-0001", dueOn: "2010-07-01", daysOverdue: 273 },
};

async function main(): Promise<void> {
  const document = await renderStatement(STATEMENT);
  const text = await pdfText(document.bytes);

  console.log("— the face of the document —");

  contains("it says what it is", text, "STATEMENT OF ACCOUNT");
  contains("it names the account holder", text, "Serai Tower Owners Association");
  contains("and their TRN", text, "TRN 100999888700003");
  contains("the account code stands in for a document number", text, "CUS-0042");

  // The brought-forward figure is the line customers dispute, so it is a row
  // with a date and an explanation rather than an unlabelled starting number.
  contains("the balance brought forward is a row", text, "Balance brought forward from 01 Jan 2011");
  contains("with its figure", text, "AED 1,100.00");

  console.log("\n— the movements —");

  contains("an invoice is named as a tax invoice", text, "Tax invoice");
  contains("a payment thanks the payer", text, "Payment received, thank you");
  contains("a payment says what it was applied to", text, "against INV-2011-0002");
  contains("a credit note carries its reason", text, "Tax credit note (correction)");
  contains("a write-off is on the ledger", text, "Written off by us");
  contains("every reference is printed", text, "INV-2011-0004");

  // The running balance beside each row is the whole reason this is a ledger
  // rather than four lists. Two intermediate figures, so a single wrong sign
  // somewhere in the middle is caught rather than cancelling out by the end.
  contains("the running balance after the first movement", text, "AED 1,900.00");
  contains("and after the credit note", text, "AED 3,240.00");

  console.log("\n— the figure being demanded —");

  contains("the closing figure is labelled which way it goes", text, "Balance now due");
  contains("and it is 2,660.00", text, "AED 2,660.00");
  contains("the four movements are shown so the total can be checked", text, "Payments received");
  contains("including the write-off, so the arithmetic closes", text, "Written off by us");

  console.log("\n— the ageing —");

  contains("the balance is aged", text, "HOW THIS BALANCE IS AGED");
  contains("with the oldest overdue document named", text, "Oldest overdue: INV-2010-0001");
  // The note wraps, so the assertion stops at the wrap point rather than
  // spanning it — a fragment that crosses a line break fails for a reason that
  // has nothing to do with the figure being right.
  contains("and its age", text, "273 days");

  console.log("\n— what must not be on it —");

  // The internal write-off reason never travels. There is no way to sanitise
  // prose written by somebody who believed it was internal, and this document
  // is emailed to the person it was written about.
  absent("no internal write-off reason", text, "uncollectable");
  contains(
    "it says plainly that it is not a tax invoice, so nobody claims input tax against it",
    text,
    "it is not itself a tax invoice",
  );

  console.log("\n— the artefact —");

  check("it is a PDF", document.contentType, "application/pdf");
  check("named for the account and the closing date", document.filename, "statement-CUS-0042-2011-03-31.pdf");
  check("nothing was lost to the standard-14 encoding", document.substitutedCharacters.length, 0);

  // Determinism. The bytes are not stored write-once the way an invoice's are,
  // but a customer holding last week's copy must be able to be handed the same
  // file again — which is only true if nothing in the render reads a clock.
  const again = await renderStatement(STATEMENT);
  check("the same statement renders byte-identically", again.sha256, document.sha256);

  const laterClock = await renderStatement({
    ...STATEMENT,
    generatedAt: new Date("2011-03-31T23:59:00.000Z"),
  });
  check(
    "and generating it later the same day changes nothing — no wall clock reaches the page",
    laterClock.sha256,
    document.sha256,
  );

  console.log("\n— an account in credit —");

  // A negative balance under "Balance now due" is read as a typo by nearly
  // everybody, and the one reader who does not read it as a typo pays it.
  const credit = await renderStatement({
    ...STATEMENT,
    closingBalanceMinor: -45_000,
    paidMinor: 371_000,
    ageing: { currentMinor: 0, days1to30Minor: 0, days31to60Minor: 0, days61PlusMinor: 0, totalMinor: 0 },
    oldestOverdue: null,
  });
  const creditText = await pdfText(credit.bytes);
  contains("it says the balance is in their favour", creditText, "Balance in your favour");
  contains("as a positive figure", creditText, "AED 450.00");
  absent("and never asks them for it", creditText, "Balance now due");
  contains("it explains what happens to the credit", creditText, "applied against your next invoice");
  absent("an ageing table of four zeros is not printed", creditText, "HOW THIS BALANCE IS AGED");

  console.log("\n— the whole account, with no start date —");

  const whole = await renderStatement({ ...STATEMENT, from: null, openingBalanceMinor: 0 });
  const wholeText = await pdfText(whole.bytes);
  contains("the first row says the account starts here", wholeText, "Opening balance");
  contains("rather than implying something was carried in", wholeText, "there is nothing before the first");

  console.log(fail === 0 ? "\nstatement render: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("statement render test failed to run:", error);
  process.exit(1);
});
