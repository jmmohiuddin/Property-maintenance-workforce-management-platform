/**
 * The job sheet: what it hashes, and what actually reaches the page (`FLD-14`).
 *
 *   npm run test --workspace=@meridian/docs
 *
 * No database and no object store. This file proves the two properties the rest
 * of `FLD-14` rests on, and it proves them by reading the output rather than
 * the input.
 *
 * ── 1. THE CANONICALISATION IS PINNED TO A WRITTEN-OUT STRING ───────────────
 *
 * `canonicalJobSheet` has a twin on the handset — `canonicalSheet()` in
 * `apps/field/src/domain/signature.ts` — and the device's own comment says the
 * quiet part: *"This is the highest-consequence function in the app and there
 * is nothing to verify it against: no server implementation of it exists. The
 * two implementations must be diffed, byte for byte, before a signature
 * captured by this app is relied on for anything at all."*
 *
 * There is one now, and the diff has been made possible rather than merely
 * recommended: `EXPECTED_CANONICAL` below is the exact output, written out in
 * full. Anybody comparing the two implementations compares against a string
 * they can read, and a change to either side that moves a space fails here
 * rather than surfacing months later as a genuine signature reported as a
 * mismatch.
 *
 * ── 2. THE RENDER IS DETERMINISTIC ──────────────────────────────────────────
 *
 * Rendered twice, digests compared. The stored SHA-256 is only evidence if the
 * same sheet produces the same bytes; a renderer whose output moves is a
 * renderer whose hash proves nothing. `render.test.ts` makes the same check for
 * the tax documents and for the same reason.
 *
 * ── WHY EVERY CONTENT ASSERTION READS THE DECOMPRESSED PDF ──────────────────
 *
 * pdf-lib Flate-compresses its content streams and writes strings as hex, so a
 * naive search of the raw bytes reports every field missing. `pdf-text` inflates
 * them and pulls the text back out. A test that asserted on the object passed
 * in would prove the fixture was well-formed, not that the field was printed —
 * and the field that silently stops being printed here is the digest, which is
 * the entire evidential claim.
 */

import {
  canonicalJobSheet,
  jobSheetDigest,
  renderJobSheet,
  JOB_SHEET_FORMAT,
  type JobSheetContent,
} from "@meridian/docs";
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
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — "${needle}" should not be on the document`}`,
  );
}

const SUPPLIER = {
  name: "Sumon Advanced Technical Services LLC",
  trn: "100234567800003",
  address: "Office 1204, Al Moosa Tower 2, Sheikh Zayed Road, Dubai",
  phone: "+971 4 380 0000",
  email: "service@example.ae",
  licenceNumber: "930137",
  crNumber: "1234567",
};

const CONSENT = {
  version: "sig-consent-2026-08-v1",
  text:
    "By signing below you confirm that the work described above was carried out at this property, " +
    "that you are authorised to accept it on behalf of the site, and that the details recorded are " +
    "correct to the best of your knowledge. A copy will be emailed to the address you provide. " +
    "Your signature is stored as an image of the marks you make; we do not analyse how you sign.",
};

/**
 * Deliberately awkward in three ways, each of which the canonicalisation has a
 * rule about and each of which is where two implementations drift apart:
 *
 *   * `workCarriedOut` spans two lines, so the line-based format has to
 *     collapse them — a raw newline in a value would silently create a field
 *     the parser on the other side reads as `Recharged: 1` and the field before
 *     it as truncated.
 *   * the materials are NOT in alphabetical order, so a sort introduced on
 *     either side shows up.
 *   * `quantity` carries the trailing zeros `numeric(12,3)` returns, so the
 *     hashed value is the stored string rather than a number somebody parsed.
 */
const CONTENT: JobSheetContent = {
  jobReference: "SATS-JOB-2026-0042",
  customerName: "Bay Tower Owners Association",
  propertyAddress: "Bay Tower, Plot 17, Business Bay, Dubai",
  reportedFault: "Split unit in the gym is blowing warm",
  diagnosedFault: "Refrigerant undercharge from a flare joint leak",
  workCarriedOut:
    "Pressure tested the line set and found a weeping flare at the outdoor unit.\nRemade the joint, evacuated and recharged.",
  materials: [
    { description: "R410A refrigerant", quantity: "2.500", unit: "kg" },
    { description: "Flare nut 3/8", quantity: "2.000", unit: "ea" },
  ],
  labourMinutes: 95,
  outcomeLabel: "Completed",
  technicianName: "Rafiq Hossain",
  recordedOfflineAt: "2026-08-14T11:42:00.000Z",
  consent: CONSENT,
};

/**
 * The exact bytes. Written out rather than computed, so this is a contract and
 * not a tautology.
 *
 * If this string has to change, `canonicalSheet()` in `apps/field` changes in
 * the same commit and `JOB_SHEET_FORMAT` goes to v2 — a sheet already sealed
 * under v1 carries its format on the row and stays verifiable.
 */
const EXPECTED_CANONICAL = [
  "sheet_format: meridian-jobsheet-v1",
  "job_reference: SATS-JOB-2026-0042",
  "customer: Bay Tower Owners Association",
  "property: Bay Tower, Plot 17, Business Bay, Dubai",
  "reported_fault: Split unit in the gym is blowing warm",
  "diagnosed_fault: Refrigerant undercharge from a flare joint leak",
  "work_carried_out: Pressure tested the line set and found a weeping flare at the outdoor unit. Remade the joint, evacuated and recharged.",
  "materials_count: 2",
  "material_0: 2.500 kg R410A refrigerant",
  "material_1: 2.000 ea Flare nut 3/8",
  "labour_minutes: 95",
  "outcome: Completed",
  "technician: Rafiq Hossain",
  "recorded_offline_at: 2026-08-14T11:42:00.000Z",
  "consent_version: sig-consent-2026-08-v1",
  `consent_text: ${CONSENT.text}`,
].join("\n");

const ALSO_ON_FILE = {
  photoCounts: [
    { label: "'after' photograph", count: 2 },
    { label: "'before' photograph", count: 1 },
  ],
  declarations: [],
  visits: [
    { sequence: 1, technicianName: "Rafiq Hossain", workMinutes: 95, travelMinutes: 25 },
  ],
};

async function main(): Promise<void> {
  // ── The canonicalisation ──────────────────────────────────────────────────
  const canonical = canonicalJobSheet(CONTENT);

  check("the canonical sheet is byte-for-byte the pinned string", canonical, EXPECTED_CANONICAL);
  check("the format is stamped on line one", canonical.split("\n")[0], `sheet_format: ${JOB_SHEET_FORMAT}`);
  check("line endings are LF, never CRLF", canonical.includes("\r"), false);
  absent("a newline inside a value did not survive into the format", canonical, "unit.\nRemade");
  check(
    "materials keep the order the technician entered them",
    canonical.indexOf("R410A") < canonical.indexOf("Flare nut"),
    true,
  );

  const digest = jobSheetDigest(CONTENT);
  check("the digest is 64 lower-case hex characters", /^[0-9a-f]{64}$/.test(digest), true);
  check("the digest is stable across calls", jobSheetDigest(CONTENT), digest);

  // One character of one material, and the digest has to move. This is the
  // property the whole requirement rests on: if a changed record produced an
  // unchanged digest, a mutable job sheet would verify.
  const tampered: JobSheetContent = {
    ...CONTENT,
    materials: [
      { description: "R410A refrigerant", quantity: "2.600", unit: "kg" },
      ...CONTENT.materials.slice(1),
    ],
  };
  check("changing one quantity changes the digest", jobSheetDigest(tampered) === digest, false);

  const reordered: JobSheetContent = {
    ...CONTENT,
    materials: [...CONTENT.materials].reverse(),
  };
  check("reordering the materials changes the digest", jobSheetDigest(reordered) === digest, false);

  // ── The presented sheet: what goes on screen above the pad ────────────────
  const presented = await renderJobSheet({
    reference: "SATS-JOB-2026-0042-JS",
    businessDate: "2026-08-14",
    supplier: SUPPLIER,
    content: CONTENT,
    alsoOnFile: ALSO_ON_FILE,
    signature: null,
  });
  const presentedText = pdfText(presented.bytes);

  check("it is a PDF", presented.contentType, "application/pdf");
  check(
    "the bytes really are a PDF",
    Buffer.from(presented.bytes.slice(0, 5)).toString("latin1"),
    "%PDF-",
  );
  check("nothing was substituted on an ASCII sheet", presented.substitutedCharacters.length, 0);

  contains("the job reference is printed", presentedText, "SATS-JOB-2026-0042");
  contains("the customer is printed", presentedText, "Bay Tower Owners Association");
  contains("the site address is printed", presentedText, "Business Bay");
  contains("the reported fault is printed", presentedText, "blowing warm");
  contains("the diagnosed fault is printed", presentedText, "Refrigerant undercharge");
  contains("the work carried out is printed", presentedText, "weeping flare");
  contains("a material is printed", presentedText, "R410A refrigerant");
  contains("its quantity is printed without trailing zeros", presentedText, "2.5");
  contains("the labour is printed in hours and minutes", presentedText, "1h 35m");
  contains("the outcome is printed", presentedText, "Completed");
  contains("the technician is printed", presentedText, "Rafiq Hossain");
  contains("the consent version is printed", presentedText, "sig-consent-2026-08-v1");
  // A short phrase on purpose: `pdfText` reconstructs one string per
  // text-showing operator, so a long sentence that the layout wrapped comes
  // back with a newline in the middle of it and a naive substring search fails
  // on a document that is perfectly correct.
  contains("the consent wording is printed", presentedText, "we do not analyse how you sign");
  contains("the digest is on the face of the document", presentedText, digest);
  contains(
    "the presented sheet says it is not signed",
    presentedText,
    "Not yet signed",
  );
  contains(
    "evidence outside the digest is labelled as such",
    presentedText,
    "not covered by the digest",
  );
  contains("the legal footer carries the licence", presentedText, "DET licence 930137");

  // ── Determinism ───────────────────────────────────────────────────────────
  const again = await renderJobSheet({
    reference: "SATS-JOB-2026-0042-JS",
    businessDate: "2026-08-14",
    supplier: SUPPLIER,
    content: CONTENT,
    alsoOnFile: ALSO_ON_FILE,
    signature: null,
  });
  check("rendering the same sheet twice produces the same hash", again.sha256, presented.sha256);
  check(
    "and byte-for-byte the same length",
    again.bytes.length,
    presented.bytes.length,
  );

  // The proof that the pinning is what is doing it. A different business date
  // is a different document; if these two matched, the date would not be
  // reaching the metadata and the "pinned, not `new Date()`" claim would be
  // decorative.
  const otherDay = await renderJobSheet({
    reference: "SATS-JOB-2026-0042-JS",
    businessDate: "2026-08-15",
    supplier: SUPPLIER,
    content: CONTENT,
    alsoOnFile: ALSO_ON_FILE,
    signature: null,
  });
  check("a different business date is different bytes", otherDay.sha256 === presented.sha256, false);

  // ── The sealed sheet ──────────────────────────────────────────────────────
  const sealed = await renderJobSheet({
    reference: "SATS-JOB-2026-0042-JS",
    businessDate: "2026-08-14",
    supplier: SUPPLIER,
    content: CONTENT,
    alsoOnFile: ALSO_ON_FILE,
    signature: {
      signedByName: "Amira Khalil",
      signedByRole: "Building manager",
      signerEmail: "amira@example.ae",
      signedAtLabel: "14 Aug 2026, 15:42",
      deviceSignedAtLabel: "14 Aug 2026, 15:39",
    },
  });
  const sealedText = pdfText(sealed.bytes);

  contains("the signer's printed name is on the sealed sheet", sealedText, "Amira Khalil");
  contains("their relationship to the site is on it", sealedText, "Building manager");
  contains("the address the copy went to is on it", sealedText, "amira@example.ae");
  contains("the server's clock reading is on it", sealedText, "14 Aug 2026, 15:42");
  // `FLD-3` and `ADR 0004`: both clocks, with the divergence visible rather
  // than reconciled. A sheet showing only one hides which of them was wrong.
  contains("the device's clock reading is on it too", sealedText, "14 Aug 2026, 15:39");
  absent("it no longer claims to be unsigned", sealedText, "Not yet signed");

  // The load-bearing one. The sealed document carries the digest of the
  // document that was PRESENTED — the sheet the customer actually read, which
  // did not yet have their name on it. Without this the stored hash would be of
  // a document nobody saw.
  contains("the sealed sheet carries the presented sheet's digest", sealedText, digest);
  check(
    "the signature does not change the content digest",
    jobSheetDigest(CONTENT),
    digest,
  );
  check(
    "but it does change the PDF, so the two artefacts are distinguishable",
    sealed.sha256 === presented.sha256,
    false,
  );

  const sealedAgain = await renderJobSheet({
    reference: "SATS-JOB-2026-0042-JS",
    businessDate: "2026-08-14",
    supplier: SUPPLIER,
    content: CONTENT,
    alsoOnFile: ALSO_ON_FILE,
    signature: {
      signedByName: "Amira Khalil",
      signedByRole: "Building manager",
      signerEmail: "amira@example.ae",
      signedAtLabel: "14 Aug 2026, 15:42",
      deviceSignedAtLabel: "14 Aug 2026, 15:39",
    },
  });
  check("the sealed sheet renders deterministically too", sealedAgain.sha256, sealed.sha256);

  // ── The amendment ─────────────────────────────────────────────────────────
  const amendment = await renderJobSheet({
    reference: "SATS-JOB-2026-0042-JS-A1",
    businessDate: "2026-08-20",
    supplier: SUPPLIER,
    content: CONTENT,
    alsoOnFile: ALSO_ON_FILE,
    signature: null,
    amendment: {
      amendsReference: "SATS-JOB-2026-0042-JS",
      amendsContentSha256: digest,
      reasonCode: "materials_misrecorded",
      reasonLabel: "Parts recorded wrongly",
      detail: "1.8 kg of R410A was charged, not 2.5 kg. The van stock count confirms it.",
      raisedByName: "Priya Nair",
    },
  });
  const amendmentText = pdfText(amendment.bytes);

  contains("an amendment says so in its title", amendmentText, "JOB SHEET AMENDMENT");
  contains("it names the sheet it corrects", amendmentText, "SATS-JOB-2026-0042-JS");
  contains("it quotes that sheet's digest", amendmentText, digest);
  contains("it carries the reason code", amendmentText, "materials_misrecorded");
  contains("it carries the reason in words", amendmentText, "Parts recorded wrongly");
  contains("it carries what the code cannot say", amendmentText, "1.8 kg of R410A was charged");
  contains("it names who raised it", amendmentText, "Priya Nair");

  // ── A sheet with nothing on it, which is a real visit ─────────────────────
  //
  // A `no_access` job: nobody was in, no parts, no time on the tools. The
  // requirement's own reasoning in `JOB-15` is that a recorded zero is a fact
  // and a null is nobody having filled the section in, and a document that
  // renders the fact as an empty section throws that distinction away in front
  // of the customer.
  const emptyVisit: JobSheetContent = {
    ...CONTENT,
    materials: [],
    labourMinutes: 0,
    outcomeLabel: "No access",
    workCarriedOut: "Attended at the agreed window. Nobody on site and the riser was locked.",
  };
  const empty = await renderJobSheet({
    reference: "SATS-JOB-2026-0043-JS",
    businessDate: "2026-08-14",
    supplier: SUPPLIER,
    content: emptyVisit,
    alsoOnFile: { photoCounts: [], declarations: [], visits: [] },
    signature: null,
  });
  const emptyText = pdfText(empty.bytes);

  contains(
    "no parts renders as a stated fact, not an empty table",
    emptyText,
    "No parts or consumables were used",
  );
  contains("zero minutes says what it means", emptyText, "no time on the tools");
  check(
    "materials_count is zero and no material line is hashed",
    canonicalJobSheet(emptyVisit).includes("material_0"),
    false,
  );

  console.log(fail === 0 ? "\nall job sheet render checks passed" : `\n${fail} FAILED`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
