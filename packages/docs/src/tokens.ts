/**
 * Document design tokens.
 *
 * Design doc §8.2: *type and colour tokens are shared with the web system — a
 * brand change is one edit.* This file is the document end of that sharing, and
 * it is worth saying plainly why it is a copy of values rather than a read of
 * them.
 *
 * ── WHY THE VALUES ARE RESTATED HERE ────────────────────────────────────────
 *
 * A PDF has no cascade, no custom properties and no stylesheet. `globals.css`
 * declares `--text-primary` as a chain of `var()` references resolved by a
 * browser; a PDF writer needs three floats. Resolving that chain at build time
 * would mean parsing CSS in a Node package, which is a parser to maintain, a
 * build step to run, and a new way for a document render to fail — for a
 * palette of nine values that changes when the brand changes, which is roughly
 * never.
 *
 * So the coupling is a convention rather than a mechanism, and the convention
 * is written down: **`apps/web/src/app/globals.css` is the source of truth.**
 * These are its light-theme values. A brand change edits both, and the second
 * edit is this file.
 *
 * ── WHY ONLY THE LIGHT PALETTE ──────────────────────────────────────────────
 *
 * There is no dark mode on paper.
 *
 * ── WHY COLOUR CARRIES NOTHING ──────────────────────────────────────────────
 *
 * Design doc §8.2: *everything legible in greyscale; status is never conveyed
 * by colour alone on a document, because documents get photocopied and faxed.*
 * The palette below is therefore an ink ramp and one accent, and the accent is
 * used for a rule and a heading, never to mean anything. Every distinction that
 * carries meaning — an optional line, a credit rather than a charge, a document
 * that is a draft — is carried by a word, a weight or a border, all of which
 * survive a fax machine.
 */

/** A colour as pdf-lib wants it: three components, each 0–1. */
export interface DocumentColour {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hex(value: string): DocumentColour {
  return {
    r: parseInt(value.slice(1, 3), 16) / 255,
    g: parseInt(value.slice(3, 5), 16) / 255,
    b: parseInt(value.slice(5, 7), 16) / 255,
  };
}

export const INK = {
  /** --text-primary → --color-ink-950 */
  primary: hex("#0b0e12"),
  /** --text-secondary → --color-ink-600 */
  secondary: hex("#46566a"),
  /** --text-muted. Already lifted off ink-500 in globals.css to clear AA. */
  muted: hex("#5c6d81"),
  /** --border-hairline → --color-ink-200 */
  hairline: hex("#dfe4ea"),
  /** --border-strong → --color-ink-300 */
  strong: hex("#c2cbd5"),
  /** --surface-sunken → --color-ink-100. The totals block and table header. */
  sunken: hex("#eef1f4"),
  white: hex("#ffffff"),
  /** --accent-text → --color-signal-700. The one accent, used sparingly. */
  accent: hex("#9c3608"),
} as const;

/**
 * The type scale, in points.
 *
 * Design doc §2.2 permits a serif for document body text. This uses the sans
 * anyway, and the reason is metric rather than aesthetic: the standard-14
 * Helvetica is guaranteed present in every PDF reader and needs no embedded
 * font file, whereas Geist — the web system's face — would have to be embedded,
 * which puts a font binary in the repository and makes a rendered document's
 * bytes depend on which version of that binary was installed. The whole point
 * of storing a hash is that the bytes are stable, and a font that ships with
 * the renderer is one fewer thing that can move underneath it.
 *
 * Helvetica's digits are all one width, so money columns align without a
 * tabular-figures feature — which is what §2.2 asks for on every figure.
 */
export const TYPE = {
  /** The words the law requires on the face of the document. */
  documentTitle: 20,
  /** The company's legal name in the letterhead. */
  supplierName: 12,
  sectionHeading: 8.5,
  body: 9,
  /** Table rows. One step down so a long description does not wrap twice. */
  table: 8.5,
  /** Metadata, the legal footer, the page number. */
  small: 7.5,
  /** The one figure the reader is looking for. */
  total: 12,
} as const;

/**
 * A4 at 72dpi, and a margin wide enough to survive a hole punch and a
 * photocopier's edge loss.
 */
export const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 46,
  marginTop: 46,
  /** Deeper than the top margin: the legal footer lives inside it. */
  marginBottom: 62,
} as const;

export const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;

/** Vertical rhythm on a 4pt base, matching the web system's 4px base. */
export const SPACE = { xs: 2, sm: 4, md: 8, lg: 12, xl: 20, xxl: 28 } as const;
