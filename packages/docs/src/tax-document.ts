/**
 * The tax invoice and the tax credit note.
 *
 * `INV-3` (full), `INV-6` (simplified) and `INV-7` (credit note) are three
 * requirements and **one template**. That is not tidiness; it is the reason the
 * simplified route can be deleted on 1 July 2027 without anybody having to find
 * out which of two code paths the historical documents went through. The
 * variant changes which blocks are drawn and which columns the table has. It
 * never changes the object, the totals or the validation.
 *
 * ── VALIDATION IS NOT REPEATED HERE ─────────────────────────────────────────
 *
 * `assertRenderable` in `@meridian/core` owns the question of whether a
 * document may be produced at all, and it is called on the first line of the
 * render. Nothing below re-checks a field it has already proved, because a
 * second copy of the Article 59 field set is a second copy to update when the
 * law moves — and the copy that does not get updated is the one in the
 * renderer, where it silently produces a document the validator would have
 * refused.
 */

import {
  assertRenderable,
  variantRationale,
  type InvoiceVariant,
  type TaxDocument,
} from "@meridian/core";
import { Canvas } from "./layout";
import { letterhead, lineTable, noteBlock, partyBlock, totalsBlock, type Column, type TableRow } from "./blocks";
import { amount, documentDate, joinPresent, money, quantity, rate } from "./format";
import { sha256Hex } from "@meridian/files";

export interface RenderedDocument {
  readonly bytes: Uint8Array;
  /** Lowercase hex. Stored beside the key; this is what makes it evidential. */
  readonly sha256: string;
  readonly contentType: "application/pdf";
  /** Suggested name. The download route sanitises it before it reaches a header. */
  readonly filename: string;
  readonly pageCount: number;
  /**
   * Characters the standard-14 fonts could not encode and which were replaced
   * with `?`. Empty on every ASCII document. Non-empty means a name on the face
   * of the document is not the name that was recorded — worth an operator
   * seeing, and the reason `INV-14`'s embedded-font work exists.
   */
  readonly substitutedCharacters: readonly string[];
}

/**
 * The full invoice's columns.
 *
 * Article 59 requires the quantity, unit price, tax rate **and tax amount in
 * AED** on every line, so the rate and the amount are separate columns rather
 * than one column showing `5%`. A document that shows only the rate makes the
 * reader multiply, and a reader who multiplies a rounded figure gets a
 * different answer from the one on the totals block.
 */
const FULL_COLUMNS: readonly Column[] = [
  { heading: "Description", width: 0, align: "left" },
  { heading: "Qty", width: 40, align: "right" },
  { heading: "Unit", width: 34, align: "left" },
  { heading: "Unit price", width: 78, align: "right" },
  { heading: "VAT", width: 32, align: "right" },
  { heading: "VAT amount", width: 70, align: "right" },
  { heading: "Amount", width: 84, align: "right" },
];

/**
 * The simplified invoice's columns (`INV-6`).
 *
 * The permitted field set is the words "Tax Invoice", the supplier's name,
 * address and TRN, the date of issue, a description, the total consideration
 * and the tax amount. Per-line tax is not among them, and dropping those two
 * columns is most of what makes this variant readable on a walk-in job where
 * the recipient is an individual rather than a finance department.
 */
const SIMPLIFIED_COLUMNS: readonly Column[] = [
  { heading: "Description", width: 0, align: "left" },
  { heading: "Qty", width: 44, align: "right" },
  { heading: "Unit", width: 40, align: "left" },
  { heading: "Amount", width: 100, align: "right" },
];

function rows(doc: TaxDocument, variant: InvoiceVariant): TableRow[] {
  return doc.lines.map((line) => ({
    // Design doc §8.1 groups lines under the job they billed, so a disputed
    // line can be traced to the work without opening the system.
    group: line.jobReference ? `Job ${line.jobReference}` : null,
    cells:
      variant === "full"
        ? [
            line.description,
            quantity(line.quantity),
            line.unit,
            money(line.unitPriceMinor, doc.currency),
            rate(line.taxRateBasisPoints),
            money(line.taxMinor, doc.currency),
            money(line.lineTotalMinor, doc.currency),
          ]
        : [
            line.description,
            quantity(line.quantity),
            line.unit,
            money(line.lineTotalMinor, doc.currency),
          ],
    // The amount column is quantity × unit price, so every row can be checked
    // by hand and the column sums to the subtotal. Where a document-level
    // discount has been apportioned across the lines, the line's VAT is
    // charged on less than its amount — which looks like an arithmetic error
    // unless the document says so. Stated in words, never by colour: design
    // doc §8.2, because a photocopied document has no colour left to read.
    note:
      line.discountMinor > 0
        ? `Less ${money(line.discountMinor, doc.currency)} of the document discount — VAT charged on ${money(line.netMinor, doc.currency)}.`
        : null,
  }));
}

/**
 * Render a tax invoice or a tax credit note.
 *
 * Deterministic: the same document produces byte-identical output. The PDF's
 * creation and modification dates are pinned to the document's own issue date
 * rather than to the wall clock, because the SHA-256 of these bytes is stored
 * on the row and an artefact whose hash changes every time it is produced
 * cannot evidence anything.
 */
export async function renderTaxDocument(
  input: unknown,
  options?: { variant?: InvoiceVariant },
): Promise<RenderedDocument> {
  const { document: doc, variant, title } = assertRenderable(input, options);
  const isCreditNote = doc.documentType === "tax_credit_note";

  const canvas = await Canvas.create({
    title: `${title} ${doc.reference}`,
    author: doc.supplier.name,
    subject: `${title} ${doc.reference} — ${doc.recipient.name}`,
    date: new Date(`${doc.issueDate}T00:00:00.000Z`),
  });

  const meta = [
    { label: "Issued", value: documentDate(doc.issueDate) },
    // Article 59 requires the date of supply alongside the date of issue where
    // they differ. It is printed even when they do not, because the reader
    // cannot tell "the same day" from "nobody recorded it" if the row is absent.
    { label: isCreditNote ? "Original supply" : "Date of supply", value: documentDate(doc.supplyDate) },
  ];
  if (doc.dueDate && !isCreditNote) {
    meta.push({ label: "Payment due", value: documentDate(doc.dueDate) });
  }
  if (doc.creditedInvoiceReference) {
    meta.push({ label: "Credits invoice", value: doc.creditedInvoiceReference });
  }

  letterhead(canvas, {
    supplier: doc.supplier,
    title,
    reference: doc.reference,
    meta,
  });

  partyBlock(canvas, {
    heading: isCreditNote ? "Credit to" : "Bill to",
    party: doc.recipient,
    // The simplified variant exists precisely because the recipient's details
    // are not required. Printing an address block with one name in it would
    // reintroduce the friction the variant removes.
    showTrnAndAddress: variant === "full",
  });

  lineTable(canvas, {
    columns: variant === "full" ? FULL_COLUMNS : SIMPLIFIED_COLUMNS,
    rows: rows(doc, variant),
  });

  const totals = [{ label: "Subtotal", value: doc.subtotalMinor }];
  if (doc.discountMinor !== 0) {
    totals.push({ label: "Discount", value: -doc.discountMinor });
    totals.push({ label: "Net of discount", value: doc.taxableMinor });
  }
  totals.push({
    // The amount VAT was charged on is named in the label. That single string
    // is what lets a reader verify the discount-then-VAT order without a
    // calculator, which is what design doc §8.2 asks for.
    label: `VAT ${rate(doc.taxRateBasisPoints)} of ${money(doc.taxableMinor, doc.currency)}`,
    value: doc.taxMinor,
  });

  totalsBlock(canvas, {
    currency: doc.currency,
    rows: [
      ...totals,
      {
        label: isCreditNote ? "Total credited" : "Total due",
        value: doc.totalMinor,
        emphasis: true,
      },
    ],
  });

  // Article 59 requires the exchange rate where any amount originates in
  // another currency. It is on the face of the document rather than in the
  // footer because it is part of how the figures above were arrived at.
  if (doc.sourceCurrency && doc.exchangeRate) {
    noteBlock(canvas, {
      heading: "Exchange rate",
      body: `Amounts originating in ${doc.sourceCurrency} were converted at ${doc.exchangeRate} ${doc.currency} per ${doc.sourceCurrency}, the rate applying on the date of supply.`,
    });
  }

  if (isCreditNote && doc.creditReason) {
    noteBlock(canvas, {
      heading: "Reason for this credit note",
      body: doc.creditReason,
    });
  }

  if (variant === "simplified") {
    // Why this document is shorter than a full invoice, in the document
    // itself. An auditor reading it two years from now should not have to
    // reconstruct the AED 10,000 test from the totals.
    noteBlock(canvas, {
      heading: "Why this is a simplified tax invoice",
      body: variantRationale({
        variant,
        recipientTrn: doc.recipient.trn,
        totalMinor: doc.totalMinor,
      }),
    });
  }

  const bytes = await canvas.finish({
    // Built from the invoice's own snapshot rather than from live
    // configuration. Reprinting a 2026 document after the office moves or the
    // licence is reissued must show what it showed in 2026 — which is why the
    // identity is on the row at all.
    legal: joinPresent([
      doc.supplier.name,
      doc.supplier.licenceNumber ? `DET licence ${doc.supplier.licenceNumber}` : null,
      doc.supplier.crNumber ? `CR ${doc.supplier.crNumber}` : null,
      doc.supplier.trn ? `TRN ${doc.supplier.trn}` : null,
    ]),
    note: `${title} ${doc.reference} · ${amount(doc.totalMinor)} ${doc.currency}`,
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
