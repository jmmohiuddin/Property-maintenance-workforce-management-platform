/**
 * What actually comes out of the tender pack assembler (`CON-12`).
 *
 * These tests read the merged bytes, not the inputs. The distinction is the
 * whole point and it matters more here than on an invoice: a tender pack is
 * evidence, and a test that asserts on the object passed in proves the fixture
 * was well-formed rather than that the licence number, the chiller's serial
 * number and the insurer's certificate are on the pages that were submitted.
 *
 * Three claims are worth the effort, and none of them is "it produced a file":
 *
 *  1. The pack **refuses** on an expired or unevidenced certificate, by name.
 *     A pack containing a lapsed third-party liability certificate is worse
 *     than one that will not build, and that sentence is only true if the
 *     refusal actually happens.
 *  2. The certificates are **in** the merged document — the specimen text of
 *     an attached PDF is extractable from the pack's own bytes — rather than
 *     described in a line that says a certificate exists somewhere.
 *  3. The render is **deterministic**. The stored SHA-256 is evidence of what
 *     was submitted only if the same inputs produce the same bytes.
 *
 *   npx tsx test/tender-pack.test.ts
 *
 * No database and no object store. Everything here is pure rendering.
 */

import { PDFDocument, StandardFonts } from "pdf-lib";
import { renderTenderPack, type EvidenceAttachment } from "../src/tender-pack";
import { TenderPackNotRenderableError } from "@meridian/core";
import { sha256Hex } from "@meridian/files";
import { pdfText } from "./pdf-text";

let fail = 0;

function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}

function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

function contains(label: string, haystack: string, needle: string): void {
  const ok = haystack.includes(needle);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — "${needle}" is not on the document`}`);
}

/** The refusal's reasons, or a failure saying it rendered when it should not have. */
async function refuses(label: string, fn: () => Promise<unknown>): Promise<string[]> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — it assembled instead of refusing`);
    return [];
  } catch (error) {
    const ok = error instanceof TenderPackNotRenderableError;
    if (!ok) fail++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — threw ${error}`}`);
    return ok ? [...(error as TenderPackNotRenderableError).problems] : [];
  }
}

/** One of the refusal's reasons names this. */
function names(label: string, problems: readonly string[], needle: string): void {
  const ok = problems.some((p) => p.includes(needle));
  if (!ok) fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — no reason mentioned "${needle}". Got: ${problems.join(" | ")}`}`,
  );
}

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// The pack is dated well before its deadline, because a pack dated after the
// closing date is one of the things this refuses — see the last block.

const PREPARED_ON = "2026-08-20";
const DEADLINE = "2026-09-18";

const SUPPLIER = {
  name: "Sumon Advanced Technical Services LLC",
  trn: "100234567800003",
  address: "Office 1204, Al Moosa Tower 2, Sheikh Zayed Road, Dubai",
  phone: "+971 4 380 0000",
  email: "tenders@example.ae",
  licenceNumber: "930137",
  crNumber: "1234567",
};

function accreditation(over: Partial<{
  kind: string;
  kindLabel: string;
  name: string;
  referenceNo: string | null;
  issuingBody: string | null;
  grade: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  hasDocument: boolean;
  documentSha256: string | null;
}>) {
  return {
    kind: "trade_licence",
    kindLabel: "Trade licence",
    name: "DET trade licence",
    referenceNo: null,
    issuingBody: null,
    grade: null,
    issuedOn: null,
    expiresOn: "2027-01-23",
    hasDocument: true,
    documentSha256: null,
    ...over,
  };
}

const FULL_REGISTER = [
  accreditation({
    kind: "trade_licence",
    kindLabel: "Trade licence",
    name: "DET trade licence 930137",
    referenceNo: "930137",
    issuingBody: "Dubai Department of Economy and Tourism",
    expiresOn: "2027-01-23",
  }),
  accreditation({
    kind: "dewa_enrolment",
    kindLabel: "DEWA contractor enrolment",
    name: "DEWA electrical contractor enrolment",
    referenceNo: "DEWA-EC-44120",
    issuingBody: "Dubai Electricity and Water Authority",
    grade: "Gold",
    expiresOn: "2027-03-31",
  }),
  accreditation({
    kind: "liability_insurance",
    kindLabel: "Third-party liability insurance",
    name: "Third-party liability policy TPL-2026-771",
    referenceNo: "TPL-2026-771",
    issuingBody: "Orient Insurance",
    expiresOn: "2027-02-14",
  }),
  accreditation({
    kind: "workmen_comp",
    kindLabel: "Workmen's compensation cover",
    name: "Workmen's compensation policy WC-2026-118",
    referenceNo: "WC-2026-118",
    issuingBody: "Orient Insurance",
    expiresOn: "2027-02-14",
  }),
];

function pack(over: Record<string, unknown> = {}) {
  return {
    reference: "TND-2026-00007",
    title: "Bay Tower MEP annual maintenance contract",
    preparedOn: PREPARED_ON,
    issuingBody: "Bay Tower Owners Association",
    opportunitySourceLabel: "OA management company",
    portalReference: "BT-AMC-2027-03",
    budgetCycle: "2027",
    submissionDeadline: DEADLINE,
    decisionDate: "2026-10-15",
    supplier: SUPPLIER,
    scopeOfWork:
      "Planned preventive maintenance and reactive call-out cover for all mechanical, electrical " +
      "and plumbing plant at Bay Tower, Business Bay, for twelve months from 1 January 2027.",
    properties: [
      {
        name: "Bay Tower",
        addressLine: "Bay Tower, Business Bay",
        area: "Business Bay",
        city: "Dubai",
        typeLabel: "Building",
      },
    ],
    assets: [
      {
        propertyName: "Bay Tower",
        tag: "BT-CH-01",
        name: "Chiller 1, main plant room",
        category: "Chiller",
        manufacturer: "Carrier",
        model: "30XA-1002",
        serialNumber: "CAR-30XA-118842",
        location: "Roof plant room, north",
        installedOn: "2020-06-01",
        ppmIntervalDays: 90,
      },
      {
        propertyName: "Bay Tower",
        tag: "BT-LIFT-01",
        name: "Passenger lift 1",
        category: "Lift",
        manufacturer: "Otis",
        model: "Gen2 Premier",
        serialNumber: "OT-G2P-44190",
        location: "Core A",
        installedOn: null,
        ppmIntervalDays: 30,
      },
    ],
    rates: [
      {
        code: "HVAC-PPM-CH",
        label: "Chiller planned maintenance visit",
        unit: "visit",
        rateBandLabel: "Standard hours",
        unitPriceMinor: 185000,
        minQuantity: null,
        notes: null,
      },
      {
        code: "CALLOUT-EMG",
        label: "Emergency call-out, first hour",
        unit: "hour",
        rateBandLabel: "Emergency call-out",
        unitPriceMinor: 45000,
        minQuantity: "1.000",
        notes: "Within four hours, twenty-four hours a day.",
      },
    ],
    accreditations: FULL_REGISTER,
    referenceContracts: [
      {
        reference: "CON-2025-00014",
        customerName: "Marina Heights Owners Association",
        kindLabel: "Annual maintenance contract",
        startsOn: "2025-01-01",
        endsOn: "2026-12-31",
        annualValueMinor: 24500000,
        propertyCount: 1,
        statusLabel: "Active",
      },
    ],
    currency: "AED",
    bidValueMinor: 31200000,
    ...over,
  };
}

/** A one-page PDF standing in for a scanned certificate. */
async function specimenPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const pinned = new Date("2026-01-01T00:00:00.000Z");
  doc.setCreationDate(pinned);
  doc.setModificationDate(pinned);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(text, { x: 60, y: 700, size: 14, font });
  return doc.save({ useObjectStreams: false });
}

/** A 1x1 PNG, for the scanned-image path. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function evidence(): Promise<EvidenceAttachment[]> {
  const licence = await specimenPdf("SPECIMEN TRADE LICENCE 930137 DET DUBAI");
  const dewa = await specimenPdf("SPECIMEN DEWA CONTRACTOR ENROLMENT GOLD");
  const tpl = await specimenPdf("SPECIMEN THIRD PARTY LIABILITY TPL-2026-771");

  return [
    {
      position: 0,
      kindLabel: "Trade licence",
      name: "DET trade licence 930137",
      referenceNo: "930137",
      issuingBody: "Dubai Department of Economy and Tourism",
      grade: null,
      expiresOn: "2027-01-23",
      contentType: "application/pdf",
      bytes: licence,
      sha256: sha256Hex(licence),
    },
    {
      position: 1,
      kindLabel: "DEWA contractor enrolment",
      name: "DEWA electrical contractor enrolment",
      referenceNo: "DEWA-EC-44120",
      issuingBody: "Dubai Electricity and Water Authority",
      grade: "Gold",
      expiresOn: "2027-03-31",
      contentType: "application/pdf",
      bytes: dewa,
      sha256: sha256Hex(dewa),
    },
    {
      position: 2,
      kindLabel: "Third-party liability insurance",
      name: "Third-party liability policy TPL-2026-771",
      referenceNo: "TPL-2026-771",
      issuingBody: "Orient Insurance",
      grade: null,
      expiresOn: "2027-02-14",
      contentType: "application/pdf",
      bytes: tpl,
      sha256: sha256Hex(tpl),
    },
    {
      position: 3,
      kindLabel: "Workmen's compensation cover",
      name: "Workmen's compensation policy WC-2026-118",
      referenceNo: "WC-2026-118",
      issuingBody: "Orient Insurance",
      grade: null,
      expiresOn: "2027-02-14",
      // The scanned-certificate path. A workmen's compensation certificate is
      // very often a photograph of a piece of paper.
      contentType: "image/png",
      bytes: ONE_PIXEL_PNG,
      sha256: sha256Hex(ONE_PIXEL_PNG),
    },
  ];
}

async function main(): Promise<void> {
  const attachments = await evidence();

  // ── A complete pack ──────────────────────────────────────────────────────
  const rendered = await renderTenderPack(pack(), attachments);
  const text = pdfText(rendered.bytes);

  check("the pack is a PDF", rendered.contentType, "application/pdf");
  checkTrue("it has more pages than the body alone", rendered.pageCount > 4);
  check("every certificate was attached", rendered.attached.length, 4);

  // Who is bidding, and for what.
  contains("CON-12: the reference is on the document", text, "TND-2026-00007");
  contains("CON-12: the bidder's legal name is on it", text, "Sumon Advanced Technical Services");
  contains("WEB-14: the trade licence number is on it", text, "930137");
  contains("the issuing body is named", text, "Bay Tower Owners Association");
  contains("CON-11: the submission deadline is on the face of it", text, "18 Sep 2026");

  // The scope of work.
  contains("CON-12: the scope of work is printed", text, "Planned preventive maintenance");

  // The per-asset PPM schedule, from the register.
  contains("CON-12: the asset tag is printed", text, "BT-CH-01");
  contains("CON-12: the make and model are printed", text, "Carrier 30XA-1002");
  contains("CON-12: the serial number is printed", text, "CAR-30XA-118842");
  contains("CON-13: the PPM interval is printed", text, "90d");
  contains("the interval is converted to visits a year", text, "12");
  contains("the second building's plant is there too", text, "OT-G2P-44190");

  // The priced schedule of rates.
  contains("CON-12: the rate code is printed", text, "HVAC-PPM-CH");
  contains("CON-12: the rate is priced", text, "AED 1,850.00");
  contains("the emergency band is named on the line", text, "Emergency call-out");

  // The accreditation register, live.
  contains("HR-14: the insurer is named", text, "Orient Insurance");
  contains("HR-14: the DEWA grade is printed", text, "Grade Gold");
  contains("HR-14: the licence expiry is printed", text, "23 Jan 2027");

  // Reference contracts.
  contains("CON-12: the reference client is named", text, "Marina Heights Owners Association");
  contains("CON-12: the reference contract is priced", text, "AED 245,000.00");

  // The certificates themselves, merged in as pages.
  contains("CON-12: the trade licence PDF is in the pack", text, "SPECIMEN TRADE LICENCE 930137");
  contains("CON-12: the DEWA certificate is in the pack", text, "SPECIMEN DEWA CONTRACTOR");
  contains("CON-12: the insurance certificate is in the pack", text, "SPECIMEN THIRD PARTY LIABILITY");
  contains("each certificate is behind a divider naming it", text, "EVIDENCE 1 OF 4");
  contains("the divider gives the hash of what was attached", text, attachments[0]!.sha256);

  // The warning that is printed rather than hidden.
  checkTrue(
    "HR-14: holding no ISO certificate is warned about, not invented",
    rendered.warnings.some((w) => w.includes("No ISO certification")),
  );
  contains("and the warning is on the face of the document", text, "No ISO certification is recorded");

  // ── Determinism (the stored hash is only evidence if this holds) ──────────
  const again = await renderTenderPack(pack(), await evidence());
  check("the same pack renders to the same bytes", again.sha256, rendered.sha256);

  // ── What it refuses ──────────────────────────────────────────────────────

  const expired = await refuses("CON-12: it refuses on an expired insurance certificate", () =>
    renderTenderPack(
      pack({
        accreditations: FULL_REGISTER.map((a) =>
          a.kind === "liability_insurance" ? { ...a, expiresOn: "2026-07-31" } : a,
        ),
      }),
      attachments,
    ),
  );
  names("and names the certificate that lapsed", expired, "Third-party liability policy TPL-2026-771");
  names("and says when it expired", expired, "2026-07-31");

  const missing = await refuses("CON-12: it refuses when DEWA enrolment is not on the register", () =>
    renderTenderPack(
      pack({ accreditations: FULL_REGISTER.filter((a) => a.kind !== "dewa_enrolment") }),
      attachments,
    ),
  );
  names("and names what is missing", missing, "DEWA contractor enrolment");
  names("and says where to record it", missing, "/workforce/accreditations");

  const unevidenced = await refuses(
    "CON-12: it refuses on a required certificate with no document behind it",
    () =>
      renderTenderPack(
        pack({
          accreditations: FULL_REGISTER.map((a) =>
            a.kind === "workmen_comp" ? { ...a, hasDocument: false } : a,
          ),
        }),
        attachments,
      ),
  );
  names("and says the pack is the evidence, not the claim", unevidenced, "Workmen's compensation");

  const noPlant = await refuses("CON-12: it refuses with an empty per-asset PPM schedule", () =>
    renderTenderPack(pack({ assets: [] }), attachments),
  );
  names("and says why an empty plant list is fatal", noPlant, "nothing to price");

  const noRates = await refuses("CON-12: it refuses with an empty schedule of rates", () =>
    renderTenderPack(pack({ rates: [] }), attachments),
  );
  names("and says the pack would quote nothing", noRates, "quote nothing");

  const noScope = await refuses("CON-12: it refuses with no scope of work", () =>
    renderTenderPack(pack({ scopeOfWork: "   " }), attachments),
  );
  names("and says a price with nothing attached is not a pack", noScope, "a price with nothing attached");

  const closed = await refuses("CON-11: it refuses to build a pack for a closed tender", () =>
    renderTenderPack(pack({ submissionDeadline: "2026-08-01" }), attachments),
  );
  names("and says the tender has closed", closed, "the tender has closed");

  // Every reason at once, not one per attempt. A tool that refuses four times
  // in a row is a tool people assemble the pack by hand instead of.
  const several = await refuses("it reports every reason at once", () =>
    renderTenderPack(
      pack({
        assets: [],
        rates: [],
        accreditations: FULL_REGISTER.filter((a) => a.kind !== "trade_licence"),
      }),
      attachments,
    ),
  );
  checkTrue("three separate faults, three separate reasons", several.length >= 3);

  // ── A pack with no reference contracts says so ───────────────────────────
  const noReferences = await renderTenderPack(pack({ referenceContracts: [] }), attachments);
  const bare = pdfText(noReferences.bytes);
  contains("an empty reference section is stated, not omitted", bare, "none are claimed here");

  console.log(fail === 0 ? "\nAll tender pack checks passed." : `\n${fail} check(s) failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
