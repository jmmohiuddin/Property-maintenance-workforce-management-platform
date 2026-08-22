/**
 * The job sheet: the document a customer signs, and the thing that makes their
 * signature mean something (`FLD-14`).
 *
 * ── THE REQUIREMENT, IN FULL ────────────────────────────────────────────────
 *
 * "Evidential integrity: store a SHA-256 hash of the exact rendered job sheet
 * that was on screen at the moment of signing, plus an immutable PDF snapshot
 * of it. Without this the signature proves nothing, because 'signed a job
 * sheet' is meaningless if the job sheet is mutable afterwards. After signature
 * the job record is locked; corrections happen only as a new, linked,
 * reason-coded amendment. Written to versioned, immutable object storage. A
 * copy is emailed to the customer immediately."
 *
 * This module is the first two clauses. `job-sheet-seal.ts` is the rest.
 *
 * ── THE TWO DIGESTS, AND WHY ONE WOULD NOT DO ───────────────────────────────
 *
 * "The exact rendered job sheet that was **on screen** at the moment of
 * signing" is not the same document as the one that ends up in storage: the
 * sheet on screen does not yet carry the signature. Hashing only the stored PDF
 * would record the digest of a document the signer never saw, which is a
 * plausible-looking answer to a question nobody asked.
 *
 * So there are two, and they are different kinds of thing:
 *
 *  1. `jobSheetDigest(content)` — SHA-256 of `canonicalJobSheet(content)`, a
 *     line-based text serialisation of exactly the fields the customer read.
 *     This is the digest the handset computes at the pad and sends with the
 *     signature, and the one the server re-derives from its own copy of the
 *     record and compares. It is the evidential anchor.
 *
 *  2. `renderJobSheet(...).sha256` — SHA-256 of the PDF snapshot, which is that
 *     same content plus the signature block, and which prints digest (1) on its
 *     own face so a person holding the paper and `shasum` can follow the chain
 *     without a database.
 *
 * ── WHY THE HASHED THING IS TEXT AND NOT THE PDF ────────────────────────────
 *
 * Because the other end of the comparison is a phone. `apps/field` builds the
 * canonical string on the device — see `canonicalSheet()` there, and the note
 * above it: *"Field order and formatting are part of the contract, not an
 * implementation detail: the server re-derives this string from its own copy of
 * the record and compares digests, so any difference in whitespace, ordering or
 * number formatting produces a mismatch and a false dispute."* A React Native
 * app cannot render a PDF byte-identically to a Node server, and asking it to
 * would replace an evidential guarantee with a rendering-parity problem.
 *
 * **`canonicalJobSheet` below is the server half of that contract, and the two
 * implementations must be diffed byte for byte before a signature captured by
 * the app is relied on for anything.** The device's file says there is nothing
 * to verify it against; there is now. `test/job-sheet.test.ts` pins the exact
 * output against a written-out golden string, so the diff is a text comparison
 * rather than an archaeology exercise.
 *
 * ── WHY THE PDF PRINTS NO MORE THAN THE DIGEST COVERS ───────────────────────
 *
 * Everything in the sheet's body is a field the canonical string carries, and
 * it is printed in the flattened form the canonicalisation produces — what is
 * on the page is what the digest covers, character for character. The inventory
 * of photographs, declarations and per-visit times is printed in a separate
 * block whose first sentence says it is *not* covered, rather than mixed into
 * the body: a document where some lines are hashed and some are not, with
 * nothing saying which, is a document whose digest means less than a reader
 * will assume.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * Same as `tax-document.ts`, and for the same reason: the SHA-256 of these
 * bytes is stored on the row, and an artefact whose hash changes every time it
 * is produced cannot evidence anything. The creation and modification dates are
 * pinned to the sheet's business date rather than the wall clock, metadata is
 * set explicitly, and no value on the page comes from `Intl` or `Date.now()`.
 * `test/job-sheet.test.ts` renders twice and compares digests.
 */

import { Canvas } from "./layout";
import { letterhead, lineTable, noteBlock, partyBlock, type Column, type DocumentParty, type TableRow } from "./blocks";
import { documentDate, joinPresent, quantity as trimQuantity } from "./format";
import { CONTENT_WIDTH, INK, SPACE, TYPE } from "./tokens";
import { sha256Hex } from "@meridian/files";
import type { RenderedDocument } from "./tax-document";

/**
 * The canonicalisation this build produces.
 *
 * Stored on every sealed sheet rather than assumed, so a sheet sealed under
 * these rules stays verifiable after the rules change. A digest whose recipe is
 * implicit is a digest that stops being checkable the first time the recipe
 * moves — and the recipe will move, because the sheet will gain fields.
 */
export const JOB_SHEET_FORMAT = "meridian-jobsheet-v1";

/** One part or consumable, as the customer saw it listed. */
export interface JobSheetMaterial {
  readonly description: string;
  /** The quantity as stored — a decimal string, never a float. */
  readonly quantity: string;
  readonly unit: string;
}

/**
 * Exactly the fields the digest covers.
 *
 * This mirrors `SheetContent` in `apps/field/src/domain/signature.ts` field for
 * field. Adding a member here without adding it there — or in a different
 * position — produces two implementations that disagree, and the way that
 * failure presents is a customer's genuine signature being reported as a
 * mismatch. Change both, together, and bump `JOB_SHEET_FORMAT`.
 */
export interface JobSheetContent {
  readonly jobReference: string;
  readonly customerName: string;
  readonly propertyAddress: string;
  readonly reportedFault: string;
  readonly diagnosedFault: string;
  readonly workCarriedOut: string;
  readonly materials: readonly JobSheetMaterial[];
  readonly labourMinutes: number;
  readonly outcomeLabel: string;
  readonly technicianName: string;
  /**
   * When the technician recorded the sheet, as the device saw it.
   *
   * A string rather than a `Date`, and passed through unaltered rather than
   * reformatted. The device's clock reading is part of what was on screen, and
   * reformatting it here would change the bytes the device hashed. `ADR 0004`
   * is why there are two clocks at all.
   */
  readonly recordedOfflineAt: string;
  readonly consent: JobSheetConsent;
}

/**
 * The consent statement rendered above the pad, versioned (`FLD-13`).
 *
 * Version *and* text. The version is what reports group on and what tells you a
 * signature was given under superseded wording; the text is what the sheet
 * prints and therefore what the digest covers, which is the point — a consent
 * statement that is referenced rather than reproduced is a consent statement
 * nobody can prove the wording of.
 */
export interface JobSheetConsent {
  readonly version: string;
  readonly text: string;
}

/** Newlines collapse to a space; the format is line-based. */
function flatten(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/**
 * The exact content the customer saw, in the order they saw it.
 *
 * Byte-for-byte the twin of `canonicalSheet()` in `apps/field`. One `key: value`
 * per line, LF endings, no locale-dependent formatting anywhere, and no sorting
 * — the materials are hashed in the order the technician entered them, because
 * re-sorting would hash a document nobody looked at.
 */
export function canonicalJobSheet(content: JobSheetContent): string {
  const lines: string[] = [
    `sheet_format: ${JOB_SHEET_FORMAT}`,
    `job_reference: ${flatten(content.jobReference)}`,
    `customer: ${flatten(content.customerName)}`,
    `property: ${flatten(content.propertyAddress)}`,
    `reported_fault: ${flatten(content.reportedFault)}`,
    `diagnosed_fault: ${flatten(content.diagnosedFault)}`,
    `work_carried_out: ${flatten(content.workCarriedOut)}`,
    `materials_count: ${content.materials.length}`,
  ];

  content.materials.forEach((m, i) => {
    lines.push(`material_${i}: ${flatten(m.quantity)} ${flatten(m.unit)} ${flatten(m.description)}`);
  });

  lines.push(
    `labour_minutes: ${content.labourMinutes}`,
    `outcome: ${flatten(content.outcomeLabel)}`,
    `technician: ${flatten(content.technicianName)}`,
    `recorded_offline_at: ${content.recordedOfflineAt}`,
    `consent_version: ${flatten(content.consent.version)}`,
    `consent_text: ${flatten(content.consent.text)}`,
  );

  return lines.join("\n");
}

/**
 * The digest of the sheet as presented.
 *
 * UTF-8, because the canonical string carries customer and property names and
 * `latin1` would silently mangle any of them that is not Western European —
 * producing a digest that differs from the device's for a reason nobody would
 * find.
 */
export function jobSheetDigest(content: JobSheetContent): string {
  return sha256Hex(new TextEncoder().encode(canonicalJobSheet(content)));
}

/** The signature, as it appears on the sealed sheet. */
export interface JobSheetSignature {
  readonly signedByName: string;
  readonly signedByRole: string | null;
  readonly signerEmail: string | null;
  /** Dubai wall-clock, already formatted. Never derived here from a clock. */
  readonly signedAtLabel: string;
  /** The device's own reading, where the capture surface reported one. */
  readonly deviceSignedAtLabel: string | null;
}

/** An amendment's own heading matter (`FLD-14`). */
export interface JobSheetAmendment {
  /** The sheet being corrected, and the digest that sheet still stands on. */
  readonly amendsReference: string;
  readonly amendsContentSha256: string;
  readonly reasonCode: string;
  readonly reasonLabel: string;
  /** What the code does not say. Beside it, never instead of it. */
  readonly detail: string | null;
  readonly raisedByName: string | null;
}

/** Evidence that exists but which the digest does not cover. Stated as such. */
export interface JobSheetAlsoOnFile {
  readonly photoCounts: readonly { readonly label: string; readonly count: number }[];
  readonly declarations: readonly { readonly label: string; readonly note: string | null }[];
  readonly visits: readonly {
    readonly sequence: number;
    readonly technicianName: string;
    readonly workMinutes: number | null;
    readonly travelMinutes: number | null;
  }[];
}

export interface RenderJobSheetInput {
  /** `SATS-JOB-2026-0042-JS`, or `-A1` for the first amendment. */
  readonly reference: string;
  /**
   * The date the PDF's metadata is pinned to, `YYYY-MM-DD`.
   *
   * A Dubai calendar date computed by the caller from the signing instant, not
   * a wall clock read here. See the determinism note in the module header.
   */
  readonly businessDate: string;
  readonly supplier: DocumentParty;
  readonly content: JobSheetContent;
  readonly alsoOnFile: JobSheetAlsoOnFile;
  /** Null renders the sheet as presented — the version shown above the pad. */
  readonly signature: JobSheetSignature | null;
  /** Set on an amendment; null on an original. */
  readonly amendment?: JobSheetAmendment | null;
}

const MATERIAL_COLUMNS: readonly Column[] = [
  { heading: "Part or consumable", width: 0, align: "left" },
  { heading: "Qty", width: 52, align: "right" },
  { heading: "Unit", width: 60, align: "left" },
];

/** `95` → `1h 35m`. Local arithmetic, because `Intl` would move the bytes. */
function duration(minutes: number): string {
  if (minutes === 0) return "0m — no time on the tools";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * A labelled paragraph in the sheet's body. Every one of these is hashed.
 *
 * The value is `flatten`ed before it is drawn — the same function the
 * canonicalisation uses, applied for a reason stronger than tidiness: **what is
 * printed has to be what the digest covers**. A technician's note carrying a
 * newline is one line in the canonical string, and a sheet that rendered it as
 * two would be a document whose visible content differs from the hashed
 * content, which is precisely the gap `FLD-14` exists to close.
 *
 * It also avoids a trap in the layout layer. `Canvas.wrap` cleans before it
 * splits, so a raw `\n` reaching `paragraph()` is substituted with `?` and
 * reported as an unencodable character — a real, previously unexercised bug
 * that would have put a question mark in the middle of a signed sheet.
 */
function field(canvas: Canvas, label: string, value: string): void {
  canvas.ensure(34);
  canvas.line(label.toUpperCase(), {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.6,
  });
  canvas.paragraph(flatten(value) || "—", { size: TYPE.body, maxWidth: CONTENT_WIDTH });
  canvas.y += SPACE.md;
}

/**
 * Render the job sheet.
 *
 * Called twice for every signature and with the same `content` both times: once
 * with `signature: null` to produce what goes on screen above the pad, and once
 * with the signature to produce the artefact that is stored and emailed. The
 * digest of the canonical content is identical across the two, which is what
 * lets the sealed document print the digest of the document that was presented.
 */
export async function renderJobSheet(input: RenderJobSheetInput): Promise<RenderedDocument> {
  const { content } = input;
  const isAmendment = Boolean(input.amendment);
  const title = isAmendment ? "Job Sheet Amendment" : "Job Sheet";
  const contentSha256 = jobSheetDigest(content);

  const canvas = await Canvas.create({
    title: `${title} ${input.reference}`,
    author: input.supplier.name ?? "",
    subject: `${title} ${input.reference} — ${content.customerName}`,
    // Pinned to the business date. See the module header.
    date: new Date(`${input.businessDate}T00:00:00.000Z`),
  });

  letterhead(canvas, {
    supplier: input.supplier,
    title,
    reference: input.reference,
    meta: [
      { label: "Job", value: content.jobReference },
      { label: "Date of work", value: documentDate(input.businessDate) },
    ],
  });

  partyBlock(canvas, {
    heading: "Work carried out for",
    party: {
      name: content.customerName,
      trn: null,
      address: content.propertyAddress,
    },
    // A job sheet is not a tax document. The site address is the operative
    // fact — it is where the work happened and what the signer is confirming —
    // and a TRN on it would be a field nobody uses and one more thing to be
    // wrong on a document a customer keeps.
    showTrnAndAddress: true,
  });

  if (input.amendment) {
    // First on the page, before anything a reader might mistake for the
    // original record. An amendment that opens with the same layout as the
    // sheet it corrects is an amendment somebody files as a duplicate.
    noteBlock(canvas, {
      heading: "This document amends a signed job sheet",
      body:
        `This is an amendment to job sheet ${input.amendment.amendsReference}, ` +
        `which was signed by the customer and remains on file unchanged. Its content digest is ` +
        `${input.amendment.amendsContentSha256}. ` +
        `Reason for the amendment: ${input.amendment.reasonLabel} (${input.amendment.reasonCode}).` +
        (input.amendment.detail ? ` ${input.amendment.detail.trim()}` : "") +
        (input.amendment.raisedByName ? ` Raised by ${input.amendment.raisedByName}.` : ""),
    });
    canvas.y += SPACE.md;
  }

  // ── The body. Every line below is covered by the content digest. ──────────
  field(canvas, "Reported fault", content.reportedFault);
  field(canvas, "Diagnosed fault", content.diagnosedFault);
  field(canvas, "Work carried out", content.workCarriedOut);

  canvas.line("PARTS AND CONSUMABLES USED", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.8,
  });

  if (content.materials.length === 0) {
    // The distinction `JOB-15` exists for, restated on the face of the
    // document: an empty section reads as "nobody filled this in", and the
    // record says something stronger than that.
    canvas.paragraph("None. No parts or consumables were used on this job.", {
      size: TYPE.body,
      maxWidth: CONTENT_WIDTH,
    });
    canvas.y += SPACE.md;
  } else {
    // Flattened, for the reason `field` above gives: the table prints the same
    // strings the canonical `material_N` lines carry.
    const rows: TableRow[] = content.materials.map((m) => ({
      cells: [flatten(m.description), trimQuantity(flatten(m.quantity)), flatten(m.unit)],
    }));
    lineTable(canvas, { columns: MATERIAL_COLUMNS, rows });
  }

  field(canvas, "Time on the tools", duration(content.labourMinutes));
  field(canvas, "Outcome", content.outcomeLabel);
  field(canvas, "Attended by", content.technicianName);
  field(canvas, "Recorded on site at", content.recordedOfflineAt);

  // ── What is on file but outside the digest ────────────────────────────────
  const evidence = joinPresent(
    input.alsoOnFile.photoCounts
      .filter((p) => p.count > 0)
      .map((p) => `${p.count} ${p.label}${p.count === 1 ? "" : "s"}`),
    ", ",
  );
  const declarations = input.alsoOnFile.declarations.map((d) =>
    d.note ? `${d.label} — ${d.note.trim()}` : d.label,
  );
  const visits = input.alsoOnFile.visits.map(
    (v) =>
      `Visit ${v.sequence}, ${v.technicianName}: ` +
      `${v.workMinutes === null ? "time not recorded" : duration(v.workMinutes)} on the tools` +
      (v.travelMinutes === null ? "" : `, ${duration(v.travelMinutes)} travelling`),
  );

  if (evidence || declarations.length > 0 || visits.length > 0) {
    noteBlock(canvas, {
      heading: "Also on file",
      body: joinPresent(
        [
          "The following is held against this job and is not covered by the digest below.",
          evidence ? `Photographs held against this job: ${evidence}.` : null,
          declarations.length > 0 ? `Declarations: ${declarations.join("; ")}.` : null,
          visits.length > 0 ? visits.join(" ") : null,
        ],
        " ",
      ),
    });
    canvas.y += SPACE.md;
  }

  // ── The consent statement, then the signature ─────────────────────────────
  //
  // The statement is drawn above the signature because that is where it was on
  // screen (`FLD-13`: "a versioned consent statement rendered above the pad"),
  // and a document that reproduces the words in a different place from the one
  // the signer read is a document that misdescribes the moment.
  // The version is in the BODY as well as the heading, and deliberately so:
  // `noteBlock` upper-cases its heading, and an identifier that reports group
  // on must appear somewhere it can be read back exactly as it is stored.
  noteBlock(canvas, {
    heading: "Consent statement",
    body: `Version ${content.consent.version}. ${flatten(content.consent.text)}`,
  });
  canvas.y += SPACE.lg;

  canvas.ensure(96);
  canvas.line("SIGNATURE", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.8,
  });

  if (input.signature) {
    canvas.line(input.signature.signedByName, { size: TYPE.total, weight: "bold" });
    canvas.y += SPACE.sm;
    const who = joinPresent([
      input.signature.signedByRole,
      input.signature.signerEmail,
    ]);
    if (who) canvas.line(who, { size: TYPE.small, colour: INK.secondary });
    canvas.line(`Signed ${input.signature.signedAtLabel}`, { size: TYPE.small });
    if (input.signature.deviceSignedAtLabel) {
      // `FLD-3` and `ADR 0004`: both clocks, and the divergence visible rather
      // than reconciled. A device clock is frequently wrong and occasionally
      // set deliberately; printing only one of the two hides which.
      canvas.line(`Device clock read ${input.signature.deviceSignedAtLabel}`, {
        size: TYPE.small,
        colour: INK.secondary,
      });
    }
  } else {
    // The presented version. It says what it is, so a printout of the
    // pre-signature sheet can never be mistaken for a signed one.
    canvas.line("Not yet signed — this is the sheet as presented for signature.", {
      size: TYPE.body,
      weight: "bold",
    });
    canvas.y += SPACE.sm;
    canvas.rule({ width: 240, thickness: 1, colour: INK.strong });
    canvas.y += SPACE.md;
    canvas.line("Signature", { size: TYPE.small, colour: INK.secondary });
  }

  canvas.y += SPACE.lg;

  // The digest, on the face of the document. This is what makes the chain
  // followable by somebody holding the paper: the same bytes re-canonicalised
  // from the record must produce this string, and if they do not, the record
  // has moved since it was signed.
  noteBlock(canvas, {
    heading: "Evidential digest",
    body:
      `The content of this sheet, canonicalised under ${JOB_SHEET_FORMAT}, has the SHA-256 ` +
      `digest ${contentSha256}. That digest was computed from the sheet as presented for ` +
      `signature and is recorded against this job. It covers every field above the "Also on ` +
      `file" heading. This document is stored write-once; it is corrected by a linked, ` +
      `reason-coded amendment and never by replacement.`,
  });

  const bytes = await canvas.finish({
    legal: joinPresent([
      input.supplier.name,
      input.supplier.licenceNumber ? `DET licence ${input.supplier.licenceNumber}` : null,
      input.supplier.crNumber ? `CR ${input.supplier.crNumber}` : null,
      input.supplier.trn ? `TRN ${input.supplier.trn}` : null,
    ]),
    note: `${title} ${input.reference} · ${content.jobReference} · SHA-256 ${contentSha256.slice(0, 16)}…`,
  });

  return {
    bytes,
    sha256: sha256Hex(bytes),
    contentType: "application/pdf",
    filename: `${input.reference}.pdf`,
    pageCount: canvas.pageCount,
    substitutedCharacters: canvas.substituted,
  };
}
