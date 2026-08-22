/**
 * The statement of account (`INV-13`).
 *
 * One customer, one date range, every movement that touched the balance, and
 * the balance they are being asked to pay. It is the document that gets emailed
 * when somebody rings up asking "what do we actually owe you" — which is why it
 * shows the workings rather than the answer: a bare figure invites a dispute
 * that a ledger settles in ten seconds.
 *
 * ── WHY THIS IS A DOCUMENT AND NOT THE PORTAL SCREEN ────────────────────────
 *
 * `portalStatement` in `@meridian/db` answers the same question on screen for a
 * signed-in customer, and this is deliberately not a render of it. That
 * function caps its entry list, takes no customer argument (the session is the
 * customer), and reports today's position. This renders `customerStatement`,
 * which is uncapped by construction, is produced by staff for a named customer,
 * and is as at a chosen date. A statement that silently omitted movements would
 * be a demand for the wrong amount, so the two are separate on purpose. See the
 * long note on `customerStatement` for the three differences in full.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * Same statement, same Dubai day, byte-identical output. Nothing here reads a
 * wall clock beyond the calendar day, and the PDF's own creation date is pinned
 * to the statement's closing date rather than to `new Date()` — the same rule
 * `tax-document.ts` follows and for a weaker but still real reason: a document
 * that changes every time it is produced cannot be compared against the copy
 * the customer is holding.
 *
 * This artefact is NOT stored write-once the way an invoice is. A statement is
 * a report about documents, not a document in its own right: it has no
 * sequential number, it creates no liability, and reissuing it next week with a
 * later closing date is the normal thing to do rather than a correction.
 */

import type { CustomerStatement, StatementLine } from "@meridian/db";
import { company, formatMoney } from "@meridian/core";
import { Canvas } from "./layout";
import { letterhead, lineTable, noteBlock, partyBlock, totalsBlock, type Column, type TableRow } from "./blocks";
import { amount, documentDate, joinPresent, money } from "./format";
import { sha256Hex } from "@meridian/files";
import type { RenderedDocument } from "./tax-document";

/**
 * The columns.
 *
 * The document reference is column zero because that is the only column
 * `lineTable` wraps, and a reference plus its kind is the cell that can run
 * long. Charges and credits are separate columns rather than one signed column:
 * a minus sign on a photocopy is four points of ink, and the whole design rule
 * on these documents is that nothing legible depends on something that small.
 */
const STATEMENT_COLUMNS: readonly Column[] = [
  { heading: "Document", width: 0, align: "left" },
  { heading: "Date", width: 62, align: "left" },
  { heading: "Charges", width: 76, align: "right" },
  { heading: "Credits", width: 76, align: "right" },
  { heading: "Balance", width: 82, align: "right" },
];

const AGEING_COLUMNS: readonly Column[] = [
  { heading: "Not yet due", width: 0, align: "left" },
  { heading: "1-30 days", width: 96, align: "right" },
  { heading: "31-60 days", width: 96, align: "right" },
  { heading: "Over 60 days", width: 96, align: "right" },
];

/** What a movement is called on the face of the statement. */
const KIND_LABEL: Readonly<Record<StatementLine["kind"], string>> = {
  invoice: "Tax invoice",
  credit_note: "Tax credit note",
  payment: "Payment received, thank you",
  write_off: "Written off by us",
};

/** The reason on a credit note, as a phrase rather than a code. */
const CREDIT_REASON_PHRASE: Readonly<Record<string, string>> = {
  return: "return",
  discount: "discount",
  cancellation: "cancellation",
  correction: "correction",
};

function detailFor(entry: StatementLine): string {
  if (entry.kind === "credit_note" && entry.detail) {
    const phrase = CREDIT_REASON_PHRASE[entry.detail] ?? entry.detail;
    return `${KIND_LABEL[entry.kind]} (${phrase})`;
  }
  if (entry.kind === "payment" && entry.detail) {
    return `${KIND_LABEL[entry.kind]} by ${entry.detail.replace(/_/g, " ")}, against ${entry.reference}`;
  }
  return KIND_LABEL[entry.kind];
}

function rowsFor(statement: CustomerStatement): TableRow[] {
  const rows: TableRow[] = [
    {
      cells: [
        statement.from
          ? `Balance brought forward from ${documentDate(statement.from)}`
          : "Opening balance",
        statement.from ?? "",
        "",
        "",
        money(statement.openingBalanceMinor, statement.currency),
      ],
      // Said in words, not implied by a blank charges column. A brought-forward
      // figure with no explanation is the line customers ring up about.
      note: statement.from
        ? "Everything on this account before the period below, in one figure."
        : "This account starts here — there is nothing before the first line.",
    },
  ];

  for (const entry of statement.entries) {
    const charge = entry.amountMinor > 0 ? money(entry.amountMinor, statement.currency) : "";
    const credit = entry.amountMinor < 0 ? money(-entry.amountMinor, statement.currency) : "";
    rows.push({
      cells: [
        `${entry.reference} — ${detailFor(entry)}`,
        entry.occurredOn,
        charge,
        credit,
        money(entry.balanceMinor, statement.currency),
      ],
    });
  }

  return rows;
}

/**
 * Render a statement of account.
 *
 * Takes the pack `customerStatement` produced rather than a customer id: this
 * package renders, it does not query. That separation is what lets the totals
 * be checked against the database in `packages/db`'s test and the layout be
 * checked without one in `packages/docs`'.
 */
export async function renderStatement(statement: CustomerStatement): Promise<RenderedDocument> {
  const closing = statement.closingBalanceMinor;
  const inCredit = closing < 0;

  const canvas = await Canvas.create({
    title: `Statement of account ${statement.customer.code}`,
    author: company.legalName,
    subject: `Statement of account for ${statement.customer.name} to ${statement.to}`,
    // Pinned to the closing date, never to the wall clock. See the header.
    date: new Date(`${statement.to}T00:00:00.000Z`),
  });

  const meta = [
    { label: "Statement date", value: documentDate(statement.to) },
    {
      label: "Period covered",
      value: statement.from
        ? `${documentDate(statement.from)} to ${documentDate(statement.to)}`
        : `Everything to ${documentDate(statement.to)}`,
    },
    { label: "Account", value: statement.customer.code },
  ];

  letterhead(canvas, {
    supplier: {
      name: company.legalName,
      trn: company.trn,
      address: company.address.street
        ? [company.address.street, company.address.city, company.address.region, company.address.country]
            .filter(Boolean)
            .join(", ")
        : null,
      phone: company.phone,
      email: company.email,
      licenceNumber: company.licenceNumber,
      crNumber: company.crNumber,
    },
    title: "Statement of account",
    // Not a sequential reference. A statement is a report about documents, not
    // a document in its own right, and giving it an invoice-shaped number would
    // invite it into a series the FTA reads as tax documents.
    reference: statement.customer.code,
    meta,
  });

  partyBlock(canvas, {
    heading: "Account",
    party: {
      name: statement.customer.name,
      trn: statement.customer.trn,
      address: statement.customer.address,
    },
    showTrnAndAddress: true,
  });

  lineTable(canvas, { columns: STATEMENT_COLUMNS, rows: rowsFor(statement) });

  // ── The footer figures ────────────────────────────────────────────────────
  //
  // Four movements and a balance, in the order somebody checks them: what we
  // charged, what we credited back, what you paid, what we stopped pursuing.
  // A reader who adds these to the opening balance must land exactly on the
  // closing balance, which is why the write-off is a row here rather than an
  // adjustment folded into the total.
  const totals = [
    { label: "Balance brought forward", value: statement.openingBalanceMinor },
    { label: "Invoiced in this period", value: statement.invoicedMinor },
    { label: "Credit notes issued", value: -statement.creditedMinor },
    { label: "Payments received", value: -statement.paidMinor },
  ];
  if (statement.writtenOffMinor !== 0) {
    totals.push({ label: "Written off by us", value: -statement.writtenOffMinor });
  }

  totalsBlock(canvas, {
    currency: statement.currency,
    rows: [
      ...totals,
      {
        label: inCredit ? "Balance in your favour" : "Balance now due",
        // Shown as a positive figure under a label that says which way it goes.
        // A negative total under "Balance due" is read as a typo by roughly
        // everybody, and the one reader who does not read it as a typo pays it.
        value: inCredit ? -closing : closing,
        emphasis: true,
      },
    ],
  });

  // ── How the balance is aged ───────────────────────────────────────────────
  //
  // Only when something is actually outstanding. An ageing table of four zeros
  // under a settled account is noise on a document whose whole job is to make
  // one number believable.
  if (statement.ageing.totalMinor > 0) {
    canvas.y += 6;
    canvas.line("HOW THIS BALANCE IS AGED", {
      size: 8.5,
      weight: "bold",
      leading: 8.5 * 1.7,
    });
    lineTable(canvas, {
      columns: AGEING_COLUMNS,
      rows: [
        {
          cells: [
            money(statement.ageing.currentMinor, statement.currency),
            money(statement.ageing.days1to30Minor, statement.currency),
            money(statement.ageing.days31to60Minor, statement.currency),
            money(statement.ageing.days61PlusMinor, statement.currency),
          ],
          note:
            statement.oldestOverdue !== null
              ? `Oldest overdue: ${statement.oldestOverdue.reference}, due ${documentDate(
                  statement.oldestOverdue.dueOn,
                )}, ${statement.oldestOverdue.daysOverdue} day${
                  statement.oldestOverdue.daysOverdue === 1 ? "" : "s"
                } ago.`
              : "Nothing on this account is past its due date.",
        },
      ],
    });
  }

  noteBlock(canvas, {
    heading: "What this statement is",
    body:
      `Every invoice, credit note, payment and write-off on account ${statement.customer.code} ` +
      (statement.from
        ? `between ${documentDate(statement.from)} and ${documentDate(statement.to)}, `
        : `up to ${documentDate(statement.to)}, `) +
      `in the order they happened, dated in Asia/Dubai. Amounts include VAT where VAT was ` +
      `charged. Draft invoices are not shown — a draft has not been issued and is not owed. ` +
      `This is a summary of documents you already hold; it is not itself a tax invoice, so ` +
      `claim input tax against the invoices it lists rather than against this page. If a line ` +
      `here does not match your records, quote its reference and we will send the document.`,
  });

  if (inCredit) {
    noteBlock(canvas, {
      heading: "This account is in credit",
      body:
        `${formatMoney(-closing, statement.currency)} is in your favour as at ` +
        `${documentDate(statement.to)}. It will be applied against your next invoice unless you ` +
        `ask us to refund it.`,
    });
  }

  const bytes = await canvas.finish({
    legal: joinPresent([
      company.legalName,
      company.licenceNumber ? `DET licence ${company.licenceNumber}` : null,
      company.crNumber ? `CR ${company.crNumber}` : null,
      company.trn ? `TRN ${company.trn}` : null,
    ]),
    note:
      `Statement of account ${statement.customer.code} to ${statement.to} · ` +
      `${inCredit ? "in credit " : "due "}${amount(Math.abs(closing))} ${statement.currency} · ` +
      `${statement.entries.length} movement${statement.entries.length === 1 ? "" : "s"}`,
  });

  return {
    bytes,
    sha256: sha256Hex(bytes),
    contentType: "application/pdf",
    filename: `statement-${statement.customer.code}-${statement.to}.pdf`,
    pageCount: canvas.pageCount,
    substitutedCharacters: canvas.substituted,
  };
}
