/**
 * A small, deterministic layout layer over pdf-lib.
 *
 * ── WHY NOT HEADLESS CHROMIUM ───────────────────────────────────────────────
 *
 * The TRD (§7.6) suggests React templates rendered by headless Chromium. This
 * does not do that, and the reason is cost against benefit. A Chromium download
 * is roughly 300 MB at install, it lands in CI on every job, it is a second
 * rendering engine to keep patched, and it makes byte-identical output hard:
 * the browser stamps its own metadata, its font rasterisation depends on the
 * host, and the produced PDF varies between Chromium versions. That last point
 * is not cosmetic. The SHA-256 of a rendered document is stored on the invoice
 * row and is what makes the artefact evidential; a renderer whose output moves
 * when a base image is rebuilt cannot support that claim.
 *
 * pdf-lib is pure JavaScript, has no native binary and no browser, and — this
 * is the part that decided it — seeds its internal name generator per document
 * and writes no `/ID` in the trailer, so with the creation and modification
 * dates pinned the same input produces the same bytes in every process on every
 * machine. `test/render.test.ts` asserts exactly that.
 *
 * The price is that there is no layout engine, so the code below is one: a text
 * cursor, wrapping, right alignment and page breaks. For a page of tabular
 * financial text that is a fair trade, and it buys precise control over the one
 * thing design doc §8.2 is most specific about — money right-aligned to a
 * common edge, in tabular figures, on every row.
 *
 * ── WHY THE Y AXIS IS INVERTED ──────────────────────────────────────────────
 *
 * PDF measures from the bottom-left. Documents are written from the top. The
 * cursor here runs downwards and converts at the point of drawing, because the
 * alternative is arithmetic like `PAGE.height - y - size` scattered through
 * every template, which is where off-by-a-line-height bugs live.
 */

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { CONTENT_WIDTH, INK, PAGE, type DocumentColour } from "./tokens";

export type Weight = "regular" | "bold";
export type Align = "left" | "right" | "center";

export interface TextOptions {
  readonly x?: number;
  readonly size?: number;
  readonly weight?: Weight;
  readonly colour?: DocumentColour;
  readonly align?: Align;
  /** Right edge for right/centre alignment. Defaults to the content width. */
  readonly width?: number;
}

/**
 * Characters the standard-14 fonts can encode.
 *
 * The standard-14 fonts use WinAnsi (CP1252). pdf-lib **throws** on a character
 * outside it rather than substituting, so an Arabic customer name or a Turkish
 * ğ would turn a render into a 500 rather than a document. Substituting is the
 * better failure of the two, but it must not be silent: the recipient's name is
 * a mandatory Article 59 field and quietly printing `????` where it should be
 * would satisfy the validator while producing a document that does not identify
 * the customer. So `Canvas` records every substitution and the render result
 * carries the list.
 *
 * The real fix is an embedded font, which is `INV-14`'s bilingual work and is
 * P2. This is the honest interim.
 */
const CP1252_HIGH = "€‚ƒ„…†‡ˆ‰Š‹Œ Ž  ‘’“”•–—˜™š›œ žŸ";

function encodable(codePoint: number): boolean {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return true;
  if (codePoint >= 0xa0 && codePoint <= 0xff) return true;
  return CP1252_HIGH.includes(String.fromCodePoint(codePoint));
}

/**
 * Typographic characters that have a WinAnsi equivalent get one; everything
 * else becomes a question mark and is reported.
 */
const SUBSTITUTIONS: Readonly<Record<string, string>> = {
  "‑": "-", // non-breaking hyphen
  "−": "-", // minus sign
  " ": " ", // non-breaking space — WinAnsi has it, but it confuses width maths
  " ": " ",
  " ": " ",
  "⁄": "/",
};

export class Canvas {
  private readonly pages: PDFPage[] = [];
  /** Distance from the top of the page to the cursor, in points. */
  private cursor: number = PAGE.marginTop;
  private readonly lost = new Set<string>();

  private constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    /** Drawn at the top of every page after the first. */
    private continuation: ((canvas: Canvas) => void) | null = null,
  ) {}

  static async create(meta: {
    title: string;
    author: string;
    subject: string;
    /**
     * Pinned, not `new Date()`.
     *
     * The document's own issue date is used, so the metadata is both meaningful
     * and stable. A wall-clock timestamp here would make every re-render a
     * different file and every stored hash unverifiable.
     */
    date: Date;
  }): Promise<Canvas> {
    // `updateMetadata: false` stops pdf-lib stamping its own ModDate on save,
    // which is the other place a wall clock leaks into the bytes.
    const doc = await PDFDocument.create({ updateMetadata: false });

    doc.setTitle(meta.title);
    doc.setAuthor(meta.author);
    doc.setSubject(meta.subject);
    doc.setProducer("@meridian/docs");
    doc.setCreator("@meridian/docs");
    doc.setCreationDate(meta.date);
    doc.setModificationDate(meta.date);
    // A11Y-13 wants tagged PDFs with a logical reading order. This sets the
    // language, which screen readers use to choose a voice; the structure tree
    // that makes a PDF properly tagged is not built here and is not claimed.
    doc.setLanguage("en-AE");

    const canvas = new Canvas(
      doc,
      await doc.embedFont(StandardFonts.Helvetica),
      await doc.embedFont(StandardFonts.HelveticaBold),
    );
    canvas.addPage();
    return canvas;
  }

  /** Register what to draw at the top of each continuation page; null clears it. */
  onContinuation(draw: ((canvas: Canvas) => void) | null): void {
    this.continuation = draw;
  }

  private get page(): PDFPage {
    const page = this.pages[this.pages.length - 1];
    if (!page) throw new Error("Canvas has no page");
    return page;
  }

  private addPage(): void {
    this.pages.push(this.doc.addPage([PAGE.width, PAGE.height]));
    this.cursor = PAGE.marginTop;
  }

  get y(): number {
    return this.cursor;
  }

  set y(value: number) {
    this.cursor = value;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  /** Characters that could not be encoded, for the caller to report. */
  get substituted(): readonly string[] {
    return [...this.lost];
  }

  private font(weight: Weight): PDFFont {
    return weight === "bold" ? this.bold : this.regular;
  }

  /** WinAnsi-safe text, recording anything that had to be replaced. */
  private clean(value: string): string {
    let out = "";
    for (const character of value.normalize("NFC")) {
      const replacement = SUBSTITUTIONS[character];
      if (replacement !== undefined) {
        out += replacement;
        continue;
      }
      if (encodable(character.codePointAt(0) ?? 0)) {
        out += character;
        continue;
      }
      this.lost.add(character);
      out += "?";
    }
    return out;
  }

  widthOf(value: string, size: number, weight: Weight = "regular"): number {
    return this.font(weight).widthOfTextAtSize(this.clean(value), size);
  }

  /**
   * Room for `height` more points, or a new page.
   *
   * Called before anything that must not be split — a totals block, a table
   * header, the last two lines of a paragraph. A totals block orphaned onto its
   * own page is the layout failure that makes a document look like it was
   * assembled by accident.
   */
  ensure(height: number): void {
    if (this.cursor + height <= PAGE.height - PAGE.marginBottom) return;
    this.addPage();
    this.continuation?.(this);
  }

  /** One line of text at the cursor's height. Does not advance the cursor. */
  text(value: string, options: TextOptions = {}): void {
    const size = options.size ?? 9;
    const weight = options.weight ?? "regular";
    const cleaned = this.clean(value);
    const width = options.width ?? CONTENT_WIDTH;
    const left = options.x ?? PAGE.marginX;

    let x = left;
    if (options.align === "right") {
      x = left + width - this.font(weight).widthOfTextAtSize(cleaned, size);
    } else if (options.align === "center") {
      x = left + (width - this.font(weight).widthOfTextAtSize(cleaned, size)) / 2;
    }

    this.page.drawText(cleaned, {
      x,
      // The cursor points at the top of the line box; PDF positions text on its
      // baseline, so the size is subtracted to get there.
      y: PAGE.height - this.cursor - size,
      size,
      font: this.font(weight),
      color: rgb(
        (options.colour ?? INK.primary).r,
        (options.colour ?? INK.primary).g,
        (options.colour ?? INK.primary).b,
      ),
    });
  }

  /** One line, then move the cursor down by the line height. */
  line(value: string, options: TextOptions & { leading?: number } = {}): void {
    const size = options.size ?? 9;
    this.text(value, options);
    this.cursor += options.leading ?? size * 1.35;
  }

  /** Split text to fit a width, without measuring the same string twice. */
  wrap(value: string, size: number, maxWidth: number, weight: Weight = "regular"): string[] {
    const font = this.font(weight);
    const lines: string[] = [];

    for (const paragraph of this.clean(value).split(/\r?\n/)) {
      let current = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !current) {
          current = candidate;
          continue;
        }
        lines.push(current);
        current = word;
      }
      lines.push(current);
    }

    return lines;
  }

  /** Wrapped text at the cursor, advancing it. Returns the height consumed. */
  paragraph(
    value: string,
    options: TextOptions & { maxWidth?: number; leading?: number } = {},
  ): number {
    const size = options.size ?? 9;
    const leading = options.leading ?? size * 1.35;
    const maxWidth = options.maxWidth ?? options.width ?? CONTENT_WIDTH;
    const start = this.cursor;

    for (const wrapped of this.wrap(value, size, maxWidth, options.weight ?? "regular")) {
      this.ensure(leading);
      this.text(wrapped, options);
      this.cursor += leading;
    }

    return this.cursor - start;
  }

  /** A horizontal rule at the cursor. Does not advance it. */
  rule(options: { x?: number; width?: number; thickness?: number; colour?: DocumentColour } = {}): void {
    const x = options.x ?? PAGE.marginX;
    const width = options.width ?? CONTENT_WIDTH;
    const colour = options.colour ?? INK.hairline;

    this.page.drawLine({
      start: { x, y: PAGE.height - this.cursor },
      end: { x: x + width, y: PAGE.height - this.cursor },
      thickness: options.thickness ?? 0.5,
      color: rgb(colour.r, colour.g, colour.b),
    });
  }

  /** A filled block, drawn downwards from the cursor. Does not advance it. */
  fill(options: {
    height: number;
    x?: number;
    width?: number;
    colour: DocumentColour;
    border?: DocumentColour;
  }): void {
    const x = options.x ?? PAGE.marginX;
    const width = options.width ?? CONTENT_WIDTH;

    this.page.drawRectangle({
      x,
      y: PAGE.height - this.cursor - options.height,
      width,
      height: options.height,
      color: rgb(options.colour.r, options.colour.g, options.colour.b),
      ...(options.border
        ? { borderColor: rgb(options.border.r, options.border.g, options.border.b), borderWidth: 0.5 }
        : {}),
    });
  }

  /**
   * Stamp the footer on every page and serialise.
   *
   * The footer runs last because "Page 1 of 3" cannot be written until the
   * third page exists. `legal` is the licence and Commercial Register line that
   * design doc §8.2 requires on *every* document — so it is applied here, once,
   * where no template can forget it.
   */
  async finish(footer: { legal: string; note?: string | null }): Promise<Uint8Array> {
    const total = this.pages.length;

    this.pages.forEach((page, index) => {
      const baseline = PAGE.height - (PAGE.height - PAGE.marginBottom + 14);

      page.drawLine({
        start: { x: PAGE.marginX, y: baseline + 16 },
        end: { x: PAGE.marginX + CONTENT_WIDTH, y: baseline + 16 },
        thickness: 0.5,
        color: rgb(INK.hairline.r, INK.hairline.g, INK.hairline.b),
      });

      const legal = this.clean(footer.legal);
      page.drawText(legal, {
        x: PAGE.marginX,
        y: baseline,
        size: 7.5,
        font: this.regular,
        color: rgb(INK.muted.r, INK.muted.g, INK.muted.b),
      });

      if (footer.note) {
        page.drawText(this.clean(footer.note), {
          x: PAGE.marginX,
          y: baseline - 10,
          size: 7.5,
          font: this.regular,
          color: rgb(INK.muted.r, INK.muted.g, INK.muted.b),
        });
      }

      const label = `Page ${index + 1} of ${total}`;
      page.drawText(label, {
        x: PAGE.marginX + CONTENT_WIDTH - this.regular.widthOfTextAtSize(label, 7.5),
        y: baseline,
        size: 7.5,
        font: this.regular,
        color: rgb(INK.muted.r, INK.muted.g, INK.muted.b),
      });
    });

    // Object streams would pack the document's objects into compressed
    // containers. Turning them off costs a few hundred bytes and keeps every
    // object and every content stream separately addressable and separately
    // decompressible — which matters for an artefact that has to stay readable
    // by ordinary tools for seven years (`INV-15`), and which is what lets the
    // test read the text back out and assert the licence number is really on
    // the page rather than trusting that a draw call happened.
    return this.doc.save({ useObjectStreams: false });
  }
}
