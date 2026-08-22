/**
 * The quotation (`QTE-3`).
 *
 * The same letterhead, the same table and the same totals block as the tax
 * invoice, because a customer who receives both should recognise the second as
 * coming from the people who sent the first. What differs is what a quotation
 * has to carry that an invoice does not: a validity date, the scope it covers,
 * and a way to say yes.
 *
 * ── WHAT THIS DOCUMENT PROMISES ─────────────────────────────────────────────
 *
 * A quotation is an offer, and every figure on it is one the customer will hold
 * the company to. So the validity date is prominent rather than buried in the
 * terms — an offer with no visible expiry is one that gets accepted in March at
 * a price agreed in January — and optional lines are labelled in words on the
 * line itself, because a priced line a customer reads as included is an
 * argument that surfaces at invoicing, months later, with the work already
 * done.
 */

import { assertQuoteRenderable, type QuoteDocument } from "@meridian/core";
import { Canvas } from "./layout";
import { letterhead, lineTable, noteBlock, partyBlock, totalsBlock, type Column, type TableRow } from "./blocks";
import { amount, documentDate, joinPresent, money, quantity, rate } from "./format";
import { sha256Hex } from "@meridian/files";
import type { RenderedDocument } from "./tax-document";

const COLUMNS: readonly Column[] = [
  { heading: "Description", width: 0, align: "left" },
  { heading: "Qty", width: 44, align: "right" },
  { heading: "Unit", width: 40, align: "left" },
  { heading: "Unit price", width: 90, align: "right" },
  { heading: "Amount", width: 96, align: "right" },
];

function rows(doc: QuoteDocument): TableRow[] {
  return doc.lines.map((line) => ({
    cells: [
      // The word is in the description, at the same size and weight as every
      // other line, because a marker set in smaller or lighter type is the one
      // a customer skims past — and a priced line they read as included is an
      // argument at invoicing, with the work already done.
      line.isOptional ? `Optional — ${line.description}` : line.description,
      quantity(line.quantity),
      line.unit,
      money(line.unitPriceMinor, doc.currency),
      money(line.lineTotalMinor, doc.currency),
    ],
    note: line.isOptional
      ? "Optional — priced for information and NOT included in the total below."
      : null,
  }));
}

/**
 * Render a quotation.
 *
 * Deterministic, for the same reason the tax document is: the artefact is
 * stored and its hash recorded, so that the quote a customer accepted in the
 * portal can be produced later unchanged even if the template has moved on.
 */
export async function renderQuoteDocument(input: unknown): Promise<RenderedDocument> {
  const doc = assertQuoteRenderable(input);

  const canvas = await Canvas.create({
    title: `Quotation ${doc.reference}`,
    author: doc.supplier.name,
    subject: `${doc.reference} — ${doc.title}`,
    date: new Date(`${doc.issueDate}T00:00:00.000Z`),
  });

  const meta = [{ label: "Issued", value: documentDate(doc.issueDate) }];
  if (doc.validUntil) meta.push({ label: "Valid until", value: documentDate(doc.validUntil) });

  letterhead(canvas, {
    supplier: doc.supplier,
    title: "Quotation",
    reference: doc.reference,
    meta,
  });

  partyBlock(canvas, { heading: "Prepared for", party: doc.recipient, showTrnAndAddress: true });

  noteBlock(canvas, { heading: "Scope of works", body: doc.title });

  canvas.y += 6;
  lineTable(canvas, { columns: COLUMNS, rows: rows(doc) });

  const totals = [{ label: "Subtotal", value: doc.subtotalMinor }];
  if (doc.discountMinor !== 0) {
    totals.push({ label: "Discount", value: -doc.discountMinor });
    totals.push({ label: "Net of discount", value: doc.taxableMinor });
  }
  totals.push({
    label: `VAT ${rate(doc.taxRateBasisPoints)} of ${money(doc.taxableMinor, doc.currency)}`,
    value: doc.taxMinor,
  });

  totalsBlock(canvas, {
    currency: doc.currency,
    rows: [...totals, { label: "Total", value: doc.totalMinor, emphasis: true }],
  });

  if (doc.notes) noteBlock(canvas, { heading: "Notes", body: doc.notes });
  if (doc.termsText) noteBlock(canvas, { heading: "Terms and conditions", body: doc.termsText });

  // The validity statement is repeated in prose beneath the totals, not only as
  // a date in the letterhead. The letterhead date is what a reader scans; this
  // is what they read when they come back to the document in six weeks.
  if (doc.validUntil) {
    noteBlock(canvas, {
      heading: "Validity",
      body: `This quotation is valid until ${documentDate(doc.validUntil)}. After that date the prices above are withdrawn and the work will need to be re-quoted.`,
    });
  }

  // The accept link is printed only when there is one. A draft quote has no
  // portal token yet, and printing a URL that answers 404 is worse than saying
  // nothing — the customer's first interaction with the portal would be a
  // broken page.
  if (doc.acceptUrl) {
    noteBlock(canvas, {
      heading: "To accept or decline",
      body: `Open ${doc.acceptUrl} — you can accept or decline this quotation there, and the decision is recorded against this reference.`,
    });
  }

  const bytes = await canvas.finish({
    legal: joinPresent([
      doc.supplier.name,
      doc.supplier.licenceNumber ? `DET licence ${doc.supplier.licenceNumber}` : null,
      doc.supplier.crNumber ? `CR ${doc.supplier.crNumber}` : null,
      doc.supplier.trn ? `TRN ${doc.supplier.trn}` : null,
    ]),
    note: `Quotation ${doc.reference} · ${amount(doc.totalMinor)} ${doc.currency}`,
  });

  return {
    bytes,
    sha256: sha256Hex(bytes),
    contentType: "application/pdf",
    filename: `${doc.reference}.pdf`,
    pageCount: canvas.pageCount,
    substitutedCharacters: canvas.substituted,
  };
}
