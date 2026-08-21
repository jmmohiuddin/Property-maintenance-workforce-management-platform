/**
 * The parts every document is built from.
 *
 * Design doc §8.1 gives one shared structure for quotes, invoices, credit
 * notes and job sheets. This module is that structure, so the templates differ
 * only where the documents genuinely differ — which is the mechanism behind
 * "Arabic bilingual is a layout variant of the same template, never a second
 * template" (`INV-14`) and behind the simplified invoice being a variant rather
 * than a second object (`INV-6`). A field added to the letterhead appears on
 * every document, once.
 */

import { Canvas } from "./layout";
import { amount, joinPresent } from "./format";
import { CONTENT_WIDTH, INK, PAGE, SPACE, TYPE } from "./tokens";

export interface DocumentParty {
  readonly name: string | null;
  readonly trn: string | null;
  readonly address: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly licenceNumber?: string | null;
  readonly crNumber?: string | null;
}

export interface MetaRow {
  readonly label: string;
  readonly value: string;
}

/** The right-hand column, where an accountant looks first. */
const META_X = PAGE.marginX + CONTENT_WIDTH * 0.52;
const META_WIDTH = CONTENT_WIDTH * 0.48;

/**
 * Letterhead: who is supplying, and which document this is.
 *
 * Design doc §8.2 in one function. The title is a heading at 20pt, not a
 * subtitle. The TRN sits directly under the company name rather than in the
 * footer, because a reader checking whether this is a valid tax invoice should
 * not have to scroll to find out. The sequential number is top-right.
 *
 * Every identity line is omitted when its value is unset. That is the rule from
 * `company.ts` and it is not negotiable on a document: an absent licence line
 * is a missing fact, `DET licence 000000` is a false one, and the false one is
 * on a document the customer keeps.
 */
export function letterhead(
  canvas: Canvas,
  input: {
    supplier: DocumentParty;
    title: string;
    reference: string;
    meta: readonly MetaRow[];
  },
): void {
  const top = canvas.y;
  const leftWidth = CONTENT_WIDTH * 0.5;

  canvas.line(input.supplier.name ?? "", {
    size: TYPE.supplierName,
    weight: "bold",
    width: leftWidth,
    leading: TYPE.supplierName * 1.5,
  });

  const registrations = joinPresent([
    input.supplier.licenceNumber ? `DET licence ${input.supplier.licenceNumber}` : null,
    input.supplier.crNumber ? `CR ${input.supplier.crNumber}` : null,
  ]);
  if (registrations) {
    canvas.line(registrations, { size: TYPE.small, colour: INK.secondary, width: leftWidth });
  }

  if (input.supplier.trn) {
    canvas.line(`TRN ${input.supplier.trn}`, {
      size: TYPE.small,
      weight: "bold",
      width: leftWidth,
    });
  }

  if (input.supplier.address) {
    canvas.paragraph(input.supplier.address, {
      size: TYPE.small,
      colour: INK.secondary,
      maxWidth: leftWidth,
      leading: TYPE.small * 1.35,
    });
  }

  const contact = joinPresent([input.supplier.phone, input.supplier.email]);
  if (contact) {
    canvas.line(contact, { size: TYPE.small, colour: INK.secondary, width: leftWidth });
  }

  const leftBottom = canvas.y;

  // The right column is drawn from the same starting height, so the two sides
  // are top-aligned however many identity lines happen to be configured.
  canvas.y = top;
  canvas.line(input.title.toUpperCase(), {
    x: META_X,
    width: META_WIDTH,
    align: "right",
    size: TYPE.documentTitle,
    weight: "bold",
    leading: TYPE.documentTitle * 1.25,
  });
  canvas.line(input.reference, {
    x: META_X,
    width: META_WIDTH,
    align: "right",
    size: 11,
    weight: "bold",
    leading: 11 * 1.6,
  });

  for (const row of input.meta) {
    canvas.text(row.label, { x: META_X, size: TYPE.small, colour: INK.secondary });
    canvas.line(row.value, {
      x: META_X,
      width: META_WIDTH,
      align: "right",
      size: TYPE.small,
      leading: TYPE.small * 1.5,
    });
  }

  canvas.y = Math.max(leftBottom, canvas.y) + SPACE.lg;
  canvas.rule({ thickness: 1, colour: INK.strong });
  canvas.y += SPACE.lg;
}

/** "BILL TO" — the recipient, with the fields the variant requires. */
export function partyBlock(
  canvas: Canvas,
  input: { heading: string; party: DocumentParty; showTrnAndAddress: boolean },
): void {
  canvas.line(input.heading.toUpperCase(), {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.6,
  });

  canvas.line(input.party.name ?? "", { size: TYPE.body, weight: "bold" });

  if (input.showTrnAndAddress) {
    if (input.party.trn) {
      canvas.line(`TRN ${input.party.trn}`, { size: TYPE.small, weight: "bold" });
    }
    if (input.party.address) {
      canvas.paragraph(input.party.address, {
        size: TYPE.small,
        colour: INK.secondary,
        maxWidth: CONTENT_WIDTH * 0.6,
      });
    }
  }

  canvas.y += SPACE.md;
}

export interface Column {
  readonly heading: string;
  /** Points. The first column with a width of 0 absorbs the remainder. */
  readonly width: number;
  readonly align: "left" | "right";
}

export interface TableRow {
  /** Job or section this line belongs to; drawn once as a subheading. */
  readonly group?: string | null;
  readonly cells: readonly string[];
  /** Rendered in muted ink with a word saying why — never colour alone. */
  readonly note?: string | null;
}

/**
 * The line table.
 *
 * Money columns are right-aligned to a common edge in a font whose digits are
 * all one width, so a column of figures lines up on the decimal point without
 * any tabular-figure feature — design doc §2.2's `tnum` rule, held by the
 * choice of face rather than by a setting the PDF has no way to express.
 *
 * Rows repeat their header on a page break because a table that continues onto
 * a second page with unlabelled columns is one the reader has to scroll back to
 * interpret, and a printed document cannot be scrolled back.
 */
export function lineTable(
  canvas: Canvas,
  input: { columns: readonly Column[]; rows: readonly TableRow[] },
): void {
  const fixed = input.columns.reduce((sum, c) => sum + c.width, 0);
  const flexible = CONTENT_WIDTH - fixed;
  const widths = input.columns.map((c) => (c.width === 0 ? flexible : c.width));

  const xs: number[] = [];
  let x = PAGE.marginX;
  for (const width of widths) {
    xs.push(x);
    x += width;
  }

  // A right-aligned column sitting immediately left of a left-aligned one puts
  // two values hard against each other — "2.5hr" reads as one token. The pad is
  // applied to the cell rather than the column width so the columns still add
  // up to the content width.
  const padOf = (align: "left" | "right"): number => (align === "left" ? 4 : 0);

  const drawHeader = (): void => {
    canvas.fill({ height: 16, colour: INK.sunken });
    canvas.y += 4.5;
    input.columns.forEach((column, i) => {
      canvas.text(column.heading, {
        x: (xs[i] ?? PAGE.marginX) + padOf(column.align),
        width: (widths[i] ?? 0) - 4 - padOf(column.align),
        align: column.align,
        size: TYPE.small,
        weight: "bold",
        colour: INK.secondary,
      });
    });
    canvas.y += 11.5;
  };

  drawHeader();
  canvas.onContinuation((c) => {
    c.y = PAGE.marginTop;
    drawHeader();
  });

  let currentGroup: string | null = null;

  for (const row of input.rows) {
    // The description is the only cell that wraps; every other column holds a
    // number or a unit and would look broken split across two lines.
    const descriptionWidth = (widths[0] ?? CONTENT_WIDTH) - 6;
    const wrapped = canvas.wrap(row.cells[0] ?? "", TYPE.table, descriptionWidth);
    const noteLines = row.note ? canvas.wrap(row.note, TYPE.small, descriptionWidth) : [];
    const height =
      wrapped.length * (TYPE.table * 1.35) + noteLines.length * (TYPE.small * 1.35) + SPACE.sm;

    if (row.group && row.group !== currentGroup) {
      canvas.ensure(height + TYPE.body * 1.8);
      currentGroup = row.group;
      canvas.y += SPACE.sm;
      canvas.line(currentGroup, {
        size: TYPE.table,
        weight: "bold",
        leading: TYPE.table * 1.6,
      });
    } else {
      canvas.ensure(height);
    }

    const rowTop = canvas.y;

    input.columns.forEach((column, i) => {
      if (i === 0) return;
      canvas.text(row.cells[i] ?? "", {
        x: (xs[i] ?? PAGE.marginX) + padOf(column.align),
        width: (widths[i] ?? 0) - 4 - padOf(column.align),
        align: column.align,
        size: TYPE.table,
      });
    });

    for (const text of wrapped) {
      canvas.line(text, { x: (xs[0] ?? PAGE.marginX) + 2, size: TYPE.table, width: descriptionWidth });
    }
    for (const text of noteLines) {
      canvas.line(text, {
        x: (xs[0] ?? PAGE.marginX) + 2,
        size: TYPE.small,
        colour: INK.secondary,
        width: descriptionWidth,
      });
    }

    canvas.y = Math.max(canvas.y, rowTop + TYPE.table * 1.35) + SPACE.sm;
    canvas.rule({ colour: INK.hairline });
  }

  canvas.onContinuation(null);
  canvas.y += SPACE.md;
}

export interface TotalRow {
  readonly label: string;
  readonly value: number;
  /** The one figure the document exists to communicate. */
  readonly emphasis?: boolean;
}

/**
 * The totals block.
 *
 * Design doc §8.2 asks for the arithmetic to be *shown, so a reader can verify
 * it without a calculator*. That is why the VAT row names the amount it was
 * charged on — `VAT 5% of AED 1,305.00` rather than `VAT 5%` — and why the net
 * of discount is a row of its own rather than an implied step. Between them
 * they make the discount-then-VAT order visible on the face of the document,
 * which is the order the whole money layer holds and the one a customer
 * disputes when it is wrong.
 */
export function totalsBlock(
  canvas: Canvas,
  input: { rows: readonly TotalRow[]; currency: string; width?: number },
): void {
  const width = input.width ?? 260;
  const x = PAGE.marginX + CONTENT_WIDTH - width;
  const labelWidth = width * 0.56;
  const valueWidth = width - labelWidth;

  // Kept whole. A total stranded on its own page reads as a document that was
  // assembled rather than written.
  canvas.ensure(input.rows.length * 15 + 24);

  for (const row of input.rows) {
    if (row.emphasis) {
      canvas.y += SPACE.xs;
      canvas.rule({ x, width, thickness: 1, colour: INK.primary });
      canvas.y += SPACE.md;
    }

    const size = row.emphasis ? TYPE.total : TYPE.body;
    canvas.text(row.label, {
      x,
      width: labelWidth,
      size,
      weight: row.emphasis ? "bold" : "regular",
      colour: row.emphasis ? INK.primary : INK.secondary,
    });
    canvas.line(`${input.currency} ${amount(row.value)}`, {
      x: x + labelWidth,
      width: valueWidth,
      align: "right",
      size,
      weight: row.emphasis ? "bold" : "regular",
      leading: size * 1.6,
    });
  }

  canvas.y += SPACE.md;
}

/** A titled block of prose — scope, terms, the reason for a credit note. */
export function noteBlock(canvas: Canvas, input: { heading: string; body: string }): void {
  canvas.ensure(48);
  canvas.y += SPACE.md;
  canvas.line(input.heading.toUpperCase(), {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.7,
  });
  canvas.paragraph(input.body, { size: TYPE.small, colour: INK.primary, maxWidth: CONTENT_WIDTH });
}
