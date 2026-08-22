/**
 * Tax invoice tests.
 *
 * Two things are being proved here, and they fail in different ways.
 *
 * The apportionment tests are money tests: the per-line tax and discount must
 * sum to the document totals exactly, in fils, or the invoice does not add up
 * and an accountant refuses it. These are the tests that catch a rounding
 * change.
 *
 * The rest are compliance tests: the render must refuse a document missing a
 * mandatory Article 59 field, and must pick the right variant under `INV-6`.
 * These are the tests that catch a well-meaning "make it work for now".
 */

import {
  apportionLines,
  assertRenderable,
  complianceChecklist,
  defaultInvoiceVariant,
  documentTitle,
  InvoiceNotRenderableError,
  isValidTrn,
  issuanceClock,
  pintAeKnownFieldGaps,
  renderableProblems,
  simplifiedInvoicePermitted,
  SIMPLIFIED_INVOICE_CEILING_MINOR,
  unitCodeFor,
  UAE_VAT_BASIS_POINTS,
  toDecimalString,
  type TaxDocumentDraft,
} from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

// ── Apportionment: the lines must sum to the document, to the fil ───────────

// A discount that does not divide evenly across three lines of unequal value.
// 3 x 33.33 = 99.99 subtotal, 10.00 discount, 5% VAT on 89.99 = 4.50.
const awkward = apportionLines({
  lines: [
    { quantity: "1", unitPriceMinor: 3333 },
    { quantity: "1", unitPriceMinor: 3333 },
    { quantity: "1", unitPriceMinor: 3333 },
  ],
  discountMinor: 1000,
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});

check("subtotal", toDecimalString(awkward.totals.subtotalMinor), "99.99");
check("tax is on the discounted amount", toDecimalString(awkward.totals.taxMinor), "4.50");
check(
  "line discounts sum to the document discount",
  awkward.lines.reduce((s, l) => s + l.discountMinor, 0),
  awkward.totals.discountMinor,
);
check(
  "line net amounts sum to the taxable amount",
  awkward.lines.reduce((s, l) => s + l.netMinor, 0),
  awkward.totals.subtotalMinor - awkward.totals.discountMinor,
);
check(
  "line tax sums to the document tax",
  awkward.lines.reduce((s, l) => s + l.taxMinor, 0),
  awkward.totals.taxMinor,
);

// A single leftover fil has to land somewhere deterministic rather than being
// dropped. 1000 fils across three equal lines is 333 + 333 + 334.
check("leftover fil is allocated, not dropped", awkward.lines[0]!.discountMinor, 334);
check("and the later lines take the floor", awkward.lines[2]!.discountMinor, 333);

// The pathological shape: many lines, an odd discount, an odd rate.
const many = apportionLines({
  lines: Array.from({ length: 37 }, (_, i) => ({
    quantity: "1.333",
    unitPriceMinor: 997 + i,
  })),
  discountMinor: 1234,
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});
check(
  "37 lines: discount still sums exactly",
  many.lines.reduce((s, l) => s + l.discountMinor, 0),
  1234,
);
check(
  "37 lines: tax still sums exactly",
  many.lines.reduce((s, l) => s + l.taxMinor, 0),
  many.totals.taxMinor,
);
check(
  "37 lines: net plus tax is the total",
  many.lines.reduce((s, l) => s + l.netMinor + l.taxMinor, 0),
  many.totals.totalMinor,
);

// A zero-valued document with a discount on it must not lose the discount.
const zeroed = apportionLines({
  lines: [{ quantity: "1", unitPriceMinor: 0 }],
  discountMinor: 500,
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});
check("a discount cannot exceed the subtotal", zeroed.totals.discountMinor, 0);
check("and nothing is invented on the line", zeroed.lines[0]!.netMinor, 0);

// ── INV-6: full versus simplified ───────────────────────────────────────────

check("a TRN is fifteen digits", isValidTrn("100123456789003"), true);
check("fourteen digits is not a TRN", isValidTrn("10012345678900"), false);
check("nor is a formatted one", isValidTrn("100-1234-5678-9003"), false);
check("nor is null", isValidTrn(null), false);

checkTrue(
  "simplified is permitted for an unregistered recipient at any value",
  simplifiedInvoicePermitted({ recipientTrn: null, totalMinor: 99_999_900 }),
);
checkTrue(
  "and for a registered recipient at exactly AED 10,000",
  simplifiedInvoicePermitted({
    recipientTrn: "100123456789003",
    totalMinor: SIMPLIFIED_INVOICE_CEILING_MINOR,
  }),
);
check(
  "but not for a registered recipient one fil above it",
  simplifiedInvoicePermitted({
    recipientTrn: "100123456789003",
    totalMinor: SIMPLIFIED_INVOICE_CEILING_MINOR + 1,
  }),
  false,
);

check("a registered recipient gets the full invoice", defaultInvoiceVariant("100123456789003"), "full");
check("an unregistered one gets the simplified", defaultInvoiceVariant(null), "simplified");
check("the words on the document", documentTitle("tax_invoice"), "Tax Invoice");
check("and on a credit note", documentTitle("tax_credit_note"), "Tax Credit Note");

// ── PINT AE unit codes ──────────────────────────────────────────────────────

check("hours map to HUR", unitCodeFor("hr"), "HUR");
check("square metres map to MTK", unitCodeFor("m2"), "MTK");
check("case does not matter", unitCodeFor("EA"), "H87");
check("an unmapped unit is null, not a guess", unitCodeFor("bucket"), null);

// ── INV-5: the 14-day clock ─────────────────────────────────────────────────

check("day 0 is inside the window", issuanceClock("2026-08-01", "2026-08-01").state, "within_window");
check("day 9 is still quiet", issuanceClock("2026-08-01", "2026-08-10").state, "within_window");
check("day 10 raises the alert", issuanceClock("2026-08-01", "2026-08-11").state, "approaching");
check("day 14 is the last lawful day", issuanceClock("2026-08-01", "2026-08-15").state, "approaching");
check("day 15 is a breach", issuanceClock("2026-08-01", "2026-08-16").state, "breached");
check("the deadline is stated", issuanceClock("2026-08-01", "2026-08-02").deadline, "2026-08-15");
check("days remaining counts down", issuanceClock("2026-08-01", "2026-08-12").daysRemaining, 3);
check(
  "a breach names the penalty in dirhams",
  issuanceClock("2026-08-01", "2026-08-20").penalty?.includes("2,500"),
  true,
);
// Month and year boundaries, where naive date arithmetic goes wrong.
check("across a month end", issuanceClock("2026-12-28", "2027-01-11").daysSinceSupply, 14);

// ── INV-3: the render refuses on a missing mandatory field ──────────────────

const goodLines = apportionLines({
  lines: [
    { quantity: "2.5", unitPriceMinor: 18000 },
    { quantity: "1", unitPriceMinor: 12000 },
  ],
  discountMinor: 5000,
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});

function draft(overrides: Partial<TaxDocumentDraft> = {}): TaxDocumentDraft {
  return {
    documentType: "tax_invoice",
    reference: "INV-2026-00184",
    issueDate: "2026-08-12",
    supplyDate: "2026-08-11",
    dueDate: "2026-09-11",
    supplier: {
      name: "Sumon Akon Technical Services",
      trn: "100123456789003",
      address: "Office 12, Al Quoz Industrial 3, Dubai, United Arab Emirates",
      country: "AE",
      licenceNumber: "930137",
      crNumber: "1234567",
      phone: null,
      email: null,
    },
    recipient: {
      name: "Emirates Property Management LLC",
      trn: "100987654321003",
      address: "Business Bay, Dubai",
      country: "AE",
    },
    currency: "AED",
    sourceCurrency: null,
    exchangeRate: null,
    lines: [
      {
        position: 1,
        description: "Labour — AC repair",
        quantity: "2.5",
        unit: "hr",
        unitCode: "HUR",
        unitPriceMinor: 18000,
        lineTotalMinor: goodLines.lines[0]!.lineTotalMinor,
        discountMinor: goodLines.lines[0]!.discountMinor,
        netMinor: goodLines.lines[0]!.netMinor,
        taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
        taxMinor: goodLines.lines[0]!.taxMinor,
        taxCategoryCode: "S",
      },
      {
        position: 2,
        description: "Capacitor 45µF",
        quantity: "1",
        unit: "ea",
        unitCode: "H87",
        unitPriceMinor: 12000,
        lineTotalMinor: goodLines.lines[1]!.lineTotalMinor,
        discountMinor: goodLines.lines[1]!.discountMinor,
        netMinor: goodLines.lines[1]!.netMinor,
        taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
        taxMinor: goodLines.lines[1]!.taxMinor,
        taxCategoryCode: "S",
      },
    ],
    subtotalMinor: goodLines.totals.subtotalMinor,
    discountMinor: goodLines.totals.discountMinor,
    taxableMinor: goodLines.totals.subtotalMinor - goodLines.totals.discountMinor,
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
    taxMinor: goodLines.totals.taxMinor,
    totalMinor: goodLines.totals.totalMinor,
    ...overrides,
  };
}

const rendered = assertRenderable(draft());
check("a complete full invoice renders", rendered.variant, "full");
check("with the right title", rendered.title, "Tax Invoice");
check("a complete invoice reports no problems", renderableProblems(draft()).length, 0);

check(
  "no supplier TRN refuses",
  renderableProblems(draft({ supplier: { ...draft().supplier, trn: null } })).some((p) =>
    p.includes("TRN"),
  ),
  true,
);
check(
  "no supplier address refuses",
  renderableProblems(draft({ supplier: { ...draft().supplier, address: null } })).some((p) =>
    p.includes("address"),
  ),
  true,
);
check(
  "a full invoice with no recipient address refuses",
  renderableProblems(draft({ recipient: { ...draft().recipient, address: null } })).some((p) =>
    p.includes("recipient's address"),
  ),
  true,
);

// A line written before per-line tax existed. The structural schema refuses it
// rather than the renderer inventing an apportionment after the fact.
const untaxedLine = draft();
check(
  "a line with no tax amount refuses",
  renderableProblems({
    ...untaxedLine,
    lines: [{ ...untaxedLine.lines[0]!, taxMinor: null }, untaxedLine.lines[1]!],
  }).length > 0,
  true,
);

// Arithmetic that does not reconcile must never reach a PDF.
check(
  "lines that do not sum to the subtotal refuse",
  renderableProblems(draft({ subtotalMinor: 99999 })).some((p) => p.includes("subtotal")),
  true,
);
check(
  "a total that is not taxable plus tax refuses",
  renderableProblems(draft({ totalMinor: 1 })).length > 0,
  true,
);

// Article 59's exchange rate disclosure is all-or-nothing.
check(
  "a source currency with no rate refuses",
  renderableProblems(draft({ sourceCurrency: "USD" })).some((p) => p.includes("exchange rate")),
  true,
);

// INV-6 is a permission, not a free choice.
const bigInvoice = draft({ totalMinor: goodLines.totals.totalMinor });
check(
  "simplified is refused where it is not permitted",
  renderableProblems(
    {
      ...bigInvoice,
      lines: [
        { ...bigInvoice.lines[0]!, lineTotalMinor: 2_000_000, netMinor: 2_000_000, taxMinor: 100_000 },
      ],
      subtotalMinor: 2_000_000,
      discountMinor: 0,
      taxableMinor: 2_000_000,
      taxMinor: 100_000,
      totalMinor: 2_100_000,
    },
    { variant: "simplified" },
  ).some((p) => p.includes("10,000")),
  true,
);

// A credit note must reference the invoice it corrects.
check(
  "a credit note with no original refuses",
  renderableProblems(draft({ documentType: "tax_credit_note" })).some((p) =>
    p.includes("reference the invoice"),
  ),
  true,
);
check(
  "a credit note with a reference and a reason renders",
  renderableProblems(
    draft({
      documentType: "tax_credit_note",
      creditedInvoiceReference: "INV-2026-00184",
      creditReason: "correction",
    }),
  ).length,
  0,
);

// The error carries every problem at once, not the first one. Fixing a document
// one refusal at a time is how somebody decides the tool is not worth using.
try {
  assertRenderable(
    draft({
      supplier: { ...draft().supplier, trn: null, address: null },
      recipient: { ...draft().recipient, address: null },
    }),
  );
  check("assertRenderable throws on an incomplete document", false, true);
} catch (error) {
  const problems = error instanceof InvoiceNotRenderableError ? error.problems : [];
  check("every problem is reported at once", problems.length, 3);
  checkTrue(
    "and the message names the penalty",
    error instanceof Error && error.message.includes("2,500"),
  );
}

// ── The compliance panel (wireframes §7.1) ──────────────────────────────────

const checklist = complianceChecklist(draft(), {
  variant: "full",
  sequenceGapBefore: false,
  asOf: "2026-08-12",
});
const state = (key: string): string | undefined => checklist.find((i) => i.key === key)?.state;

check("title is satisfied", state("title"), "ok");
check("supplier TRN is satisfied", state("supplier_trn"), "ok");
check("the sequence is reported clean", state("sequence"), "ok");
check("issued one day after supply is inside the window", state("issuance_window"), "ok");
check("licence and CR are satisfied", state("licence"), "ok");
check("PINT AE readiness is pending, not failing", state("pint_ae"), "pending");

const unknownSequence = complianceChecklist(draft(), { variant: "full", asOf: "2026-08-12" });
check(
  "an unrun gap report is pending rather than a pass",
  unknownSequence.find((i) => i.key === "sequence")?.state,
  "pending",
);

const gapped = complianceChecklist(draft(), {
  variant: "full",
  sequenceGapBefore: true,
  asOf: "2026-08-12",
});
check("a known gap fails the check", gapped.find((i) => i.key === "sequence")?.state, "missing");

const late = complianceChecklist(draft({ issueDate: "2026-09-01" }), {
  variant: "full",
  sequenceGapBefore: false,
  asOf: "2026-09-01",
});
check(
  "issuing 21 days after supply fails the window",
  late.find((i) => i.key === "issuance_window")?.state,
  "missing",
);

const noSupplyDate = complianceChecklist(draft({ supplyDate: null }), {
  variant: "full",
  asOf: "2026-08-12",
});
check(
  "no date of supply fails the window rather than passing it",
  noSupplyDate.find((i) => i.key === "issuance_window")?.state,
  "missing",
);

const simplified = complianceChecklist(
  draft({ recipient: { name: "Walk-in", trn: null, address: null, country: "AE" } }),
  { variant: "simplified", sequenceGapBefore: false, asOf: "2026-08-12" },
);
check(
  "a simplified invoice does not fail for a missing recipient address",
  simplified.find((i) => i.key === "recipient")?.state,
  "ok",
);

// Note the wording. This checks the e-invoicing fields the system MODELS, which
// is seven of roughly fifty PINT AE mandatory fields, assembled from the PRD's
// summary rather than from the specification. "No known gaps" is the claim;
// "PINT AE ready" is not, and asserting the latter here would have quietly
// blessed the same overclaim on the invoice screen.
check("a complete document has no known e-invoicing gaps", pintAeKnownFieldGaps(draft()).length, 0);

const unmapped = draft();
check(
  "an unmapped unit code is reported as a gap, and does not block issuing",
  pintAeKnownFieldGaps({
    ...unmapped,
    lines: [{ ...unmapped.lines[0]!, unitCode: null }, unmapped.lines[1]!],
  }).some((p) => p.includes("unit code")),
  true,
);

// The checklist entry must never read as "ready", whatever the field state.
const readyish = complianceChecklist(draft(), { variant: "full", asOf: "2026-08-12" });
const pintItem = readyish.find((i) => i.key === "pint_ae");
check("the e-invoicing item never claims readiness", pintItem?.state, "pending");
check(
  "and its label says the check is partial",
  pintItem?.label.toLowerCase().includes("partial"),
  true,
);
check(
  "and its detail says so too",
  (pintItem?.detail ?? "").toLowerCase().includes("not a full pint ae"),
  true,
);

console.log(`\n${fail === 0 ? "invoice: all checks passed" : `${fail} FAILING`}`);
process.exit(fail === 0 ? 0 : 1);
