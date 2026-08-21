/**
 * What actually comes out of the renderer.
 *
 * These tests read the bytes rather than the inputs. That distinction is the
 * whole point: every field checked here is one the FTA requires to be *on the
 * face of the document* (Article 59), and a test that asserts on the object
 * passed in proves the fixture was well-formed, not that the field was printed.
 * The extractor below decompresses the content streams and pulls the text back
 * out, so a field that stops being drawn fails a test instead of quietly
 * shipping an invoice that costs AED 2,500.
 */

import { renderTaxDocument, renderQuoteDocument } from "@meridian/docs";
import { InvoiceNotRenderableError } from "@meridian/core";
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

async function refuses(label: string, fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — it rendered instead of refusing`);
    return [];
  } catch (error) {
    const ok = error instanceof InvoiceNotRenderableError;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — threw ${error}`}`);
    return ok ? [...(error as InvoiceNotRenderableError).problems] : [];
  }
}

// ── A complete, well-formed tax invoice ─────────────────────────────────────
//
// Deliberately carries a discount, because the discount is what makes the
// VAT-after-discount order observable: 3,000 less 500 is 2,500, and 5% of that
// is 125 rather than the 150 that VAT-before-discount would produce.
const INVOICE = {
  documentType: "tax_invoice",
  reference: "SATS-INV-2026-0184",
  issueDate: "2026-08-14",
  supplyDate: "2026-08-05",
  dueDate: "2026-09-13",
  supplier: {
    name: "Sumon Advanced Technical Services LLC",
    trn: "100234567800003",
    address: "Office 1204, Al Moosa Tower 2, Sheikh Zayed Road, Dubai",
    country: "AE",
    phone: "+971 4 380 0000",
    email: "accounts@example.ae",
    licenceNumber: "930137",
    crNumber: "1234567",
  },
  recipient: {
    name: "Bay Tower Owners Association",
    trn: "100999888700003",
    address: "Bay Tower, Business Bay, Dubai",
    country: "AE",
  },
  currency: "AED",
  sourceCurrency: null,
  exchangeRate: null,
  lines: [
    {
      position: 1,
      description: "Lobby and lift car deep clean",
      quantity: "2.00",
      unit: "visit",
      unitCode: "E48",
      unitPriceMinor: 150000,
      lineTotalMinor: 300000,
      discountMinor: 50000,
      netMinor: 250000,
      taxRateBasisPoints: 500,
      taxMinor: 12500,
      taxCategoryCode: "S",
    },
  ],
  subtotalMinor: 300000,
  discountMinor: 50000,
  taxableMinor: 250000,
  taxRateBasisPoints: 500,
  taxMinor: 12500,
  totalMinor: 262500,
};

async function main(): Promise<void> {
  const rendered = await renderTaxDocument(INVOICE);
  const text = pdfText(rendered.bytes);

  check("it is a PDF", rendered.contentType, "application/pdf");
  check("one page", rendered.pageCount, 1);
  check("nothing was substituted on an ASCII document", rendered.substitutedCharacters.length, 0);
  check(
    "the bytes really are a PDF",
    Buffer.from(rendered.bytes.slice(0, 5)).toString("latin1"),
    "%PDF-",
  );

  // ── Article 59: the fields that must appear ───────────────────────────────
  contains("the words 'Tax Invoice'", text, "Tax Invoice");
  contains("the sequential number", text, "SATS-INV-2026-0184");
  contains("the supplier's TRN", text, "100234567800003");
  contains("the recipient's TRN", text, "100999888700003");
  contains("the supplier's name", text, "Sumon Advanced Technical Services LLC");
  contains("the recipient's name", text, "Bay Tower Owners Association");
  contains("the date of issue", text, "14 Aug 2026");
  // The one most often dropped, and the one the 14-day clock is measured from.
  contains("the date of supply, distinct from the issue date", text, "05 Aug 2026");

  // Cabinet Resolution 107/2022 Art. 7 — the trade licence on issued documents.
  contains("the trade licence number", text, "930137");

  // ── The arithmetic, on the face of the document ───────────────────────────
  contains("the per-line amount", text, "3,000.00");
  contains("the discount", text, "500.00");
  contains("the amount VAT is charged on", text, "2,500.00");
  // 125.00 is 5% of the *discounted* 2,500. If VAT were taken before the
  // discount it would read 150.00, so this single assertion is the ordering.
  contains("VAT of the net, not the gross", text, "125.00");
  contains("the total", text, "2,625.00");
  absent("VAT was not charged on the pre-discount amount", text, "150.00");

  // The label names the base so a reader can check the order without a
  // calculator — design doc §8.2.
  contains("the VAT label names its base", text, "VAT 5% of AED 2,500.00");

  // ── Determinism ───────────────────────────────────────────────────────────
  //
  // The stored SHA-256 is only evidence if the same document renders to the
  // same bytes. A creation timestamp taken from the clock would break this, and
  // `issue.ts` would then store a hash that disagrees with every later render.
  const again = await renderTaxDocument(INVOICE);
  check("rendering twice produces the same hash", again.sha256, rendered.sha256);
  check("rendering twice produces the same length", again.bytes.length, rendered.bytes.length);
  check("the hash is 64 hex characters", /^[0-9a-f]{64}$/.test(rendered.sha256), true);

  // ── The simplified variant (INV-6) ────────────────────────────────────────
  const simplified = await renderTaxDocument(
    { ...INVOICE, recipient: { ...INVOICE.recipient, trn: null } },
    { variant: "simplified" },
  );
  const simpleText = pdfText(simplified.bytes);
  // Article 59(5) asks for the words "Tax Invoice" clearly displayed — not
  // "Simplified Tax Invoice", which is the regulation's name for the variant
  // rather than a required caption. The title is deliberately the same.
  contains("a simplified invoice still says 'Tax Invoice'", simpleText, "Tax Invoice");
  contains("the supplier's TRN is still mandatory", simpleText, "100234567800003");
  absent("the recipient's address block is dropped", simpleText, "Business Bay");
  check("a different variant is different bytes", simplified.sha256 === rendered.sha256, false);

  // ── Refusals ──────────────────────────────────────────────────────────────
  //
  // Refusing costs an operator five minutes. Issuing an invoice missing a
  // mandatory field costs AED 2,500 and cannot be undone by editing — it is
  // corrected by a credit note.
  const noTrn = await refuses("an invoice with no supplier TRN is refused", () =>
    renderTaxDocument({ ...INVOICE, supplier: { ...INVOICE.supplier, trn: null } }),
  );
  check("and it says which field", noTrn.some((p) => p.toLowerCase().includes("trn")), true);

  // Not "a full invoice with no recipient TRN": an unregistered recipient
  // legitimately has none, and Article 59 asks for it only where the recipient
  // is registered. A TRN that is *present and malformed* is the real fault —
  // it is the one that makes the customer's input-tax claim fail.
  const badTrn = await refuses("a malformed recipient TRN is refused", () =>
    renderTaxDocument(
      { ...INVOICE, recipient: { ...INVOICE.recipient, trn: "12345" } },
      { variant: "full" },
    ),
  );
  check(
    "and it says what is wrong with it",
    badTrn.some((p) => p.includes("fifteen digits")),
    true,
  );

  const unregistered = await renderTaxDocument(
    { ...INVOICE, recipient: { ...INVOICE.recipient, trn: null } },
    { variant: "full" },
  );
  check(
    "but an unregistered recipient renders — having no TRN is lawful",
    unregistered.pageCount,
    1,
  );

  // VAT taken on the pre-discount amount. This is the arithmetic error that
  // over-charges a customer, and it must not be renderable.
  const badVat = await refuses("VAT charged before the discount is refused", () =>
    renderTaxDocument({ ...INVOICE, taxableMinor: 300000, taxMinor: 15000, totalMinor: 315000 }),
  );
  check(
    "and it names the discount rule",
    badVat.some((p) => p.includes("subtotal less the discount")),
    true,
  );

  // Every reason at once, not the first. One-at-a-time turns a five-minute
  // correction into an afternoon, which is how people learn to route around it.
  const manyProblems = await refuses("an invoice missing several fields is refused", () =>
    renderTaxDocument({
      ...INVOICE,
      supplier: { ...INVOICE.supplier, trn: null, address: null },
    }),
  );
  check("with every reason reported, not just the first", manyProblems.length > 1, true);

  await refuses("an invoice with no lines is refused", () =>
    renderTaxDocument({ ...INVOICE, lines: [], subtotalMinor: 0 }),
  );

  // ── Names the standard-14 fonts cannot encode ─────────────────────────────
  //
  // Reported rather than silently mangled: a customer name that lost characters
  // is not the name that was recorded, and INV-14's bilingual work is what
  // fixes it properly.
  const arabic = await renderTaxDocument({
    ...INVOICE,
    recipient: { ...INVOICE.recipient, name: "برج الخليج" },
  });
  check(
    "un-encodable characters are reported, not swallowed",
    arabic.substitutedCharacters.length > 0,
    true,
  );

  // ── The quotation (QTE-3) ─────────────────────────────────────────────────
  //
  // Not a tax document: no TRN of the recipient, no VAT claim to support. It
  // still carries the licence number, and it must say when the offer lapses —
  // a quote with no expiry is one a customer holds you to next year.
  const quote = await renderQuoteDocument({
    reference: "SATS-QTE-2026-0042",
    title: "Annual chiller maintenance",
    issueDate: "2026-08-14",
    validUntil: "2026-09-13",
    supplier: INVOICE.supplier,
    recipient: { ...INVOICE.recipient, trn: null },
    currency: "AED",
    lines: [
      {
        position: 1,
        description: "Quarterly chiller service",
        quantity: "4.00",
        unit: "visit",
        unitPriceMinor: 120000,
        lineTotalMinor: 480000,
        isOptional: false,
      },
    ],
    subtotalMinor: 480000,
    discountMinor: 0,
    taxableMinor: 480000,
    taxRateBasisPoints: 500,
    taxMinor: 24000,
    totalMinor: 504000,
    termsText: "Payment 30 days from invoice.",
    notes: null,
    acceptUrl: null,
  });
  const quoteText = pdfText(quote.bytes);
  contains("the quote reference", quoteText, "SATS-QTE-2026-0042");
  contains("the quote total", quoteText, "5,040.00");
  contains("the expiry date", quoteText, "13 Sep 2026");
  contains("the licence number on a quote too", quoteText, "930137");
  absent("a quote is not labelled a tax invoice", quoteText, "Tax Invoice");

  const quoteAgain = await renderQuoteDocument({
    reference: "SATS-QTE-2026-0042",
    title: "Annual chiller maintenance",
    issueDate: "2026-08-14",
    validUntil: "2026-09-13",
    supplier: INVOICE.supplier,
    recipient: { ...INVOICE.recipient, trn: null },
    currency: "AED",
    lines: [
      {
        position: 1,
        description: "Quarterly chiller service",
        quantity: "4.00",
        unit: "visit",
        unitPriceMinor: 120000,
        lineTotalMinor: 480000,
        isOptional: false,
      },
    ],
    subtotalMinor: 480000,
    discountMinor: 0,
    taxableMinor: 480000,
    taxRateBasisPoints: 500,
    taxMinor: 24000,
    totalMinor: 504000,
    termsText: "Payment 30 days from invoice.",
    notes: null,
    acceptUrl: null,
  });
  check("a quote renders deterministically too", quoteAgain.sha256, quote.sha256);

  console.log(fail === 0 ? "\nall document render checks passed" : `\n${fail} FAILED`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
