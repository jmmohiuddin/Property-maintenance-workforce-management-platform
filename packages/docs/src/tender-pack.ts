/**
 * The tender pack (`CON-12`).
 *
 * *A single PDF containing scope of work, per-asset PPM schedule, priced
 * schedule of rates, trade licence, DEWA enrolment evidence, ISO certificates,
 * insurance certificates and reference contracts. Assembled from the company
 * accreditation register (`HR-14`) so it is always current. This is the artefact
 * that wins the RERA-mandated three-bid process.*
 *
 * ── WHY A PDF AND NOT A ZIP ─────────────────────────────────────────────────
 *
 * The requirement says "PDF/ZIP" and the choice is made by the storage layer
 * rather than by taste. `packages/files` sniffs every stored object's type from
 * its magic bytes and refuses anything outside an allowlist; a plain ZIP is not
 * on it, and a generic ZIP is indistinguishable from a `.docx` without
 * inspecting its directory. Storing the pack as a ZIP would mean widening that
 * allowlist — a security control — to make a convenience work.
 *
 * A single PDF is also the better artefact. An OA's evaluator opens one file,
 * scrolls, and finds the licence where the index said it would be. A ZIP is
 * eleven files, and the one they cannot open is the one they mark down.
 *
 * ── HOW "ASSEMBLED FROM LIVE DATA" IS HELD ──────────────────────────────────
 *
 * Nothing here is a copy. The plant list is read from `assets`, the rates from
 * `rate_card_items` as at the pack date, the accreditations from
 * `company_accreditations`, and the certificates themselves are pulled out of
 * object storage by the key on the register row. There is no attachment table
 * for tenders and there is deliberately not going to be one: an uploaded copy
 * of a certificate is a snapshot, and a snapshot is exactly what `CON-12` says
 * this must not be.
 *
 * The certificates are merged in as pages rather than described, because a
 * tender pack is evidence and a line of text saying "ISO 9001, expires March"
 * is a claim. Each is preceded by a rendered divider naming what it is, who
 * issued it, when it expires and the SHA-256 of the bytes attached — so the
 * pack says what it contains and a dispute about which version was submitted
 * has an answer.
 *
 * ── WHAT IT REFUSES ─────────────────────────────────────────────────────────
 *
 * `assertTenderPackRenderable` in `@meridian/core` holds the rules and this
 * module adds two it cannot see from there, both about the bytes rather than
 * the row: a certificate whose storage key points at nothing, and one stored in
 * a format that cannot become a page (a Word document, an RTF, a HEIC). Both
 * are collected and reported with everything else in one refusal, because a
 * pack that refuses four times in a row teaches people to stop using it.
 *
 * A tender pack containing an expired insurance certificate is worse than one
 * that refuses to build. That sentence is the whole design.
 *
 * ── DETERMINISM ─────────────────────────────────────────────────────────────
 *
 * Same rule as the invoice and the quotation, and see `layout.ts` for why it is
 * achievable at all with a pure-JS writer. Every date written into the merged
 * document's metadata is the pack's pinned business date, never `new Date()`,
 * so re-assembling the same pack from the same inputs produces the same bytes
 * and the stored SHA-256 stays evidence of what was submitted.
 */

import { PDFDocument } from "pdf-lib";
import { eq } from "drizzle-orm";
import {
  assertTenderPackRenderable,
  tenderPackWarnings,
  TenderPackNotRenderableError,
  visitsPerYear,
  type TenderPackDocument,
} from "@meridian/core";
import {
  tenderPackInputs,
  tenderPackOn,
  recordTenderPack,
  schema,
  type PackEvidence,
  type TenantScopedTx,
  type TenantContext,
} from "@meridian/db";
import { objectStore, sha256Hex } from "@meridian/files";
import { Canvas } from "./layout";
import { letterhead, lineTable, noteBlock, type Column, type TableRow } from "./blocks";
import { amount, documentDate, joinPresent, money } from "./format";
import { CONTENT_WIDTH, INK, PAGE, SPACE, TYPE } from "./tokens";
import type { RenderedDocument } from "./tax-document";

/**
 * The formats a certificate can become a page in.
 *
 * pdf-lib embeds JPEG and PNG and copies pages out of a PDF. It cannot do
 * anything with a Word document, an RTF, a WebP or a HEIC — and the honest
 * answer to one of those on the register is to say so and name the row, not to
 * drop it from the pack and let the evaluator notice.
 */
const MERGEABLE = new Set(["application/pdf", "image/png", "image/jpeg"]);

/** One certificate, with its bytes, ready to become pages. */
export interface EvidenceAttachment {
  /** The entry in the document's accreditation list these bytes belong to. */
  readonly position: number;
  readonly kindLabel: string;
  readonly name: string;
  readonly referenceNo: string | null;
  readonly issuingBody: string | null;
  readonly grade: string | null;
  readonly expiresOn: string | null;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** The hash of what is actually attached, printed on the divider. */
  readonly sha256: string;
}

export interface RenderedTenderPack extends RenderedDocument {
  /** True, incomplete, and printed on the document. Never a reason to refuse. */
  readonly warnings: readonly string[];
  /** One line per attached certificate, for the stored manifest. */
  readonly attached: readonly { name: string; sha256: string; pages: number }[];
}

// ── The body ─────────────────────────────────────────────────────────────────

const PPM_COLUMNS: readonly Column[] = [
  { heading: "Asset", width: 0, align: "left" },
  { heading: "Make and model", width: 120, align: "left" },
  { heading: "Serial", width: 88, align: "left" },
  { heading: "Interval", width: 52, align: "right" },
  { heading: "Visits/yr", width: 46, align: "right" },
];

const RATE_COLUMNS: readonly Column[] = [
  { heading: "Description", width: 0, align: "left" },
  { heading: "Code", width: 72, align: "left" },
  { heading: "Band", width: 96, align: "left" },
  { heading: "Unit", width: 42, align: "left" },
  { heading: "Rate", width: 92, align: "right" },
];

const CONTRACT_COLUMNS: readonly Column[] = [
  { heading: "Client and contract", width: 0, align: "left" },
  { heading: "Period", width: 130, align: "left" },
  { heading: "Sites", width: 40, align: "right" },
  { heading: "Annual value", width: 100, align: "right" },
];

function ppmRows(doc: TenderPackDocument): TableRow[] {
  return doc.assets.map((a) => {
    const visits = visitsPerYear(a.ppmIntervalDays);
    return {
      // Grouped by building. An evaluator reads the pack building by building,
      // and a flat list of ninety assets across three towers is a list nobody
      // checks against their own plant room.
      group: a.propertyName,
      cells: [
        `${a.tag} — ${a.name}`,
        joinPresent([a.manufacturer, a.model], " "),
        a.serialNumber ?? "—",
        a.ppmIntervalDays ? `${a.ppmIntervalDays}d` : "—",
        visits === null ? "—" : String(visits),
      ],
      // The location is what tells the evaluator somebody walked the site.
      note: joinPresent([
        a.location,
        a.installedOn ? `installed ${documentDate(a.installedOn)}` : null,
      ]),
    };
  });
}

/** The accreditation register, as a readable block rather than a table. */
function accreditationBlock(canvas: Canvas, doc: TenderPackDocument): void {
  canvas.ensure(60);
  canvas.y += SPACE.md;
  canvas.line("ACCREDITATIONS AND INSURANCES", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.7,
  });
  canvas.paragraph(
    "Read from the company accreditation register at the moment this pack was assembled. " +
      "Every entry below is in date on the pack date shown in the header; the certificates " +
      "themselves are attached after this page in the order listed.",
    { size: TYPE.small, colour: INK.secondary, maxWidth: CONTENT_WIDTH },
  );
  canvas.y += SPACE.md;

  for (const a of doc.accreditations) {
    canvas.ensure(40);
    canvas.line(`${a.kindLabel} — ${a.name}`, { size: TYPE.body, weight: "bold" });

    canvas.line(
      joinPresent([
        a.referenceNo ? `No. ${a.referenceNo}` : null,
        a.issuingBody,
        a.grade ? `Grade ${a.grade}` : null,
        a.issuedOn ? `issued ${documentDate(a.issuedOn)}` : null,
        // The expiry is printed even where it is comfortably far off. An
        // evaluator checks it, and a pack that omits it invites them to ask.
        a.expiresOn ? `expires ${documentDate(a.expiresOn)}` : "no expiry recorded",
      ]),
      { size: TYPE.small, colour: INK.secondary },
    );

    canvas.line(
      a.hasDocument
        ? `Certificate attached${a.documentSha256 ? ` · SHA-256 ${a.documentSha256}` : ""}`
        : "No certificate attached to this entry.",
      { size: TYPE.small, colour: a.hasDocument ? INK.secondary : INK.accent },
    );
    canvas.y += SPACE.sm;
    canvas.rule({ colour: INK.hairline });
    canvas.y += SPACE.sm;
  }
}

/**
 * Render the pack body.
 *
 * Sections in the order an evaluator scores them: who is bidding, what they
 * were asked to price, the plant they surveyed, the prices, the evidence they
 * hold, and who else they do this for.
 */
async function renderBody(
  doc: TenderPackDocument,
  warnings: readonly string[],
  evidence: readonly EvidenceAttachment[],
): Promise<{ canvas: Canvas; bytes: Uint8Array }> {
  const canvas = await Canvas.create({
    title: `Tender pack ${doc.reference}`,
    author: doc.supplier.name,
    subject: `${doc.reference} — ${doc.title}`,
    // Pinned. See the header of this file and `layout.ts`.
    date: new Date(`${doc.preparedOn}T00:00:00.000Z`),
  });

  letterhead(canvas, {
    supplier: doc.supplier,
    title: "Tender pack",
    reference: doc.reference,
    meta: [
      { label: "Prepared", value: documentDate(doc.preparedOn) },
      { label: "Submission deadline", value: documentDate(doc.submissionDeadline) },
      ...(doc.decisionDate
        ? [{ label: "Decision expected", value: documentDate(doc.decisionDate) }]
        : []),
    ],
  });

  canvas.line("SUBMITTED TO", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.6,
  });
  canvas.line(doc.issuingBody, { size: TYPE.body, weight: "bold" });
  canvas.line(
    joinPresent([
      doc.opportunitySourceLabel,
      doc.portalReference ? `Portal reference ${doc.portalReference}` : null,
      doc.budgetCycle ? `Budget cycle ${doc.budgetCycle}` : null,
    ]),
    { size: TYPE.small, colour: INK.secondary },
  );
  canvas.y += SPACE.md;

  noteBlock(canvas, { heading: "Scope of works", body: doc.scopeOfWork });

  // ── The buildings ────────────────────────────────────────────────────────
  canvas.ensure(50);
  canvas.y += SPACE.md;
  canvas.line("SITES COVERED", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.7,
  });
  for (const p of doc.properties) {
    canvas.ensure(26);
    canvas.line(p.name, { size: TYPE.body, weight: "bold" });
    canvas.line(joinPresent([p.typeLabel, p.addressLine, p.area, p.city]), {
      size: TYPE.small,
      colour: INK.secondary,
    });
    canvas.y += SPACE.xs;
  }

  // ── The plant list ───────────────────────────────────────────────────────
  canvas.ensure(60);
  canvas.y += SPACE.lg;
  canvas.line("PER-ASSET PPM SCHEDULE", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.7,
  });
  canvas.paragraph(
    `${doc.assets.length} item${doc.assets.length === 1 ? "" : "s"} of plant, read from the asset ` +
      "register. The interval is the planned period between maintenance visits for that item; the " +
      "visit count is what that works out at over a year.",
    { size: TYPE.small, colour: INK.secondary, maxWidth: CONTENT_WIDTH },
  );
  canvas.y += SPACE.md;
  lineTable(canvas, { columns: PPM_COLUMNS, rows: ppmRows(doc) });

  // ── The prices ───────────────────────────────────────────────────────────
  canvas.ensure(60);
  canvas.y += SPACE.md;
  canvas.line("PRICED SCHEDULE OF RATES", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.7,
  });
  canvas.paragraph(
    `Rates in effect on ${documentDate(doc.preparedOn)}, exclusive of VAT. A rate quoted here is ` +
      "held for the duration of the tender validity stated by the issuer.",
    { size: TYPE.small, colour: INK.secondary, maxWidth: CONTENT_WIDTH },
  );
  canvas.y += SPACE.md;
  lineTable(canvas, {
    columns: RATE_COLUMNS,
    rows: doc.rates.map((r) => ({
      cells: [
        r.label,
        r.code,
        r.rateBandLabel,
        r.unit,
        money(r.unitPriceMinor, doc.currency),
      ],
      note: joinPresent([
        r.minQuantity ? `Minimum ${r.minQuantity} ${r.unit}` : null,
        r.notes,
      ]),
    })),
  });

  if (doc.bidValueMinor !== null) {
    canvas.ensure(40);
    canvas.line("BID VALUE", {
      size: TYPE.sectionHeading,
      weight: "bold",
      colour: INK.secondary,
      leading: TYPE.sectionHeading * 1.7,
    });
    canvas.line(`${doc.currency} ${amount(doc.bidValueMinor)} per annum, exclusive of VAT.`, {
      size: TYPE.body,
      weight: "bold",
    });
    canvas.y += SPACE.md;
  }

  // ── The evidence ─────────────────────────────────────────────────────────
  accreditationBlock(canvas, doc);

  // ── The references ───────────────────────────────────────────────────────
  canvas.ensure(60);
  canvas.y += SPACE.md;
  canvas.line("REFERENCE CONTRACTS", {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.secondary,
    leading: TYPE.sectionHeading * 1.7,
  });

  if (doc.referenceContracts.length === 0) {
    // Said, not omitted. A missing section reads as an oversight; a sentence
    // reads as a fact, and it is the same rule that stops this company
    // advertising ISO certificates it does not hold.
    canvas.paragraph(
      "No maintenance contracts are recorded against this company. References can be supplied on " +
        "request; none are claimed here.",
      { size: TYPE.small, colour: INK.primary, maxWidth: CONTENT_WIDTH },
    );
    canvas.y += SPACE.md;
  } else {
    canvas.y += SPACE.sm;
    lineTable(canvas, {
      columns: CONTRACT_COLUMNS,
      rows: doc.referenceContracts.map((c) => ({
        cells: [
          `${c.customerName} — ${c.kindLabel}`,
          `${documentDate(c.startsOn)} to ${documentDate(c.endsOn)}`,
          String(c.propertyCount),
          money(c.annualValueMinor, doc.currency),
        ],
        note: `${c.reference} · ${c.statusLabel}`,
      })),
    });
  }

  // ── What this pack does not claim ────────────────────────────────────────
  //
  // On the face of the document, not only on the operator's screen. Everything
  // here is true and incomplete, and an evaluator who finds the gap themselves
  // reads it as concealment.
  if (warnings.length > 0) {
    noteBlock(canvas, {
      heading: "Notes on this submission",
      body: warnings.join("\n"),
    });
  }

  // ── The index of what follows ────────────────────────────────────────────
  if (evidence.length > 0) {
    noteBlock(canvas, {
      heading: "Attached certificates",
      body:
        `${evidence.length} certificate${evidence.length === 1 ? "" : "s"} follow this page, each ` +
        "behind a sheet naming it and giving the SHA-256 of the file attached:\n" +
        evidence.map((e, i) => `${i + 1}. ${e.kindLabel} — ${e.name}`).join("\n"),
    });
  }

  const bytes = await canvas.finish({
    legal: legalFooter(doc),
    note: `Tender pack ${doc.reference} · prepared ${documentDate(doc.preparedOn)} · closes ${documentDate(doc.submissionDeadline)}`,
  });

  return { canvas, bytes };
}

function legalFooter(doc: TenderPackDocument): string {
  return joinPresent([
    doc.supplier.name,
    doc.supplier.licenceNumber ? `DET licence ${doc.supplier.licenceNumber}` : null,
    doc.supplier.crNumber ? `CR ${doc.supplier.crNumber}` : null,
    doc.supplier.trn ? `TRN ${doc.supplier.trn}` : null,
  ]);
}

/**
 * The sheet that goes in front of each certificate.
 *
 * Its own one-page canvas rather than part of the body, because the body has
 * already been finished by the time the certificates are merged and a divider
 * has to sit between two copied documents. It carries no page number — see
 * `Canvas.finish`, which grew a `pageLabel` option for exactly this: "Page 1 of
 * 1" stamped on what is really page fourteen is worse than no number at all.
 */
async function renderDivider(
  doc: TenderPackDocument,
  item: EvidenceAttachment,
  position: number,
  total: number,
): Promise<{ bytes: Uint8Array; substituted: readonly string[] }> {
  const canvas = await Canvas.create({
    title: `${doc.reference} — evidence ${position} of ${total}`,
    author: doc.supplier.name,
    subject: item.name,
    date: new Date(`${doc.preparedOn}T00:00:00.000Z`),
  });

  canvas.y = PAGE.height * 0.28;

  canvas.line(`EVIDENCE ${position} OF ${total}`, {
    size: TYPE.sectionHeading,
    weight: "bold",
    colour: INK.accent,
    leading: TYPE.sectionHeading * 2,
  });

  canvas.line(item.kindLabel, { size: TYPE.documentTitle, weight: "bold", leading: TYPE.documentTitle * 1.4 });
  canvas.paragraph(item.name, { size: TYPE.supplierName, maxWidth: CONTENT_WIDTH });

  canvas.y += SPACE.lg;
  canvas.rule({ thickness: 1, colour: INK.strong });
  canvas.y += SPACE.lg;

  for (const [label, value] of [
    ["Reference", item.referenceNo],
    ["Issued by", item.issuingBody],
    ["Grade", item.grade],
    ["Expires", item.expiresOn ? documentDate(item.expiresOn) : "not recorded"],
    ["File", item.contentType],
    ["SHA-256", item.sha256],
  ] as const) {
    if (!value) continue;
    canvas.text(label, { size: TYPE.small, colour: INK.secondary, width: 90 });
    canvas.line(value, { x: PAGE.marginX + 96, size: TYPE.small, leading: TYPE.small * 1.9 });
  }

  canvas.y += SPACE.lg;
  canvas.paragraph(
    "The document that follows is the file held on the company accreditation register on the pack " +
      "date. The hash above is of that file as attached, so this copy can be checked against the " +
      "original.",
    { size: TYPE.small, colour: INK.secondary, maxWidth: CONTENT_WIDTH * 0.8 },
  );

  const bytes = await canvas.finish({ legal: legalFooter(doc), note: null, pageLabel: null });
  return { bytes, substituted: canvas.substituted };
}

/**
 * Render and merge.
 *
 * Everything is loaded with `updateMetadata: false` and the merged document's
 * dates are set from the pack's business date, so nothing anywhere in the
 * output is taken from a clock.
 */
export async function renderTenderPack(
  input: unknown,
  evidence: readonly EvidenceAttachment[],
): Promise<RenderedTenderPack> {
  const doc = assertTenderPackRenderable(input);
  const warnings = tenderPackWarnings(doc);

  const { canvas, bytes: bodyBytes } = await renderBody(doc, warnings, evidence);

  const pinned = new Date(`${doc.preparedOn}T00:00:00.000Z`);
  const merged = await PDFDocument.create({ updateMetadata: false });
  merged.setTitle(`Tender pack ${doc.reference}`);
  merged.setAuthor(doc.supplier.name);
  merged.setSubject(`${doc.reference} — ${doc.title}`);
  merged.setProducer("@meridian/docs");
  merged.setCreator("@meridian/docs");
  merged.setCreationDate(pinned);
  merged.setModificationDate(pinned);
  merged.setLanguage("en-AE");

  await appendPdf(merged, bodyBytes);

  const attached: { name: string; sha256: string; pages: number }[] = [];

  // The body's losses plus every divider's. A certificate holder's name that
  // the standard-14 font cannot set is exactly the kind of thing that appears
  // on a divider and nowhere else, and reporting only the body's would say the
  // document is clean when a name on it is not the name that was recorded.
  const substituted = new Set(canvas.substituted);

  for (const [index, item] of evidence.entries()) {
    const divider = await renderDivider(doc, item, index + 1, evidence.length);
    for (const character of divider.substituted) substituted.add(character);
    await appendPdf(merged, divider.bytes);

    const before = merged.getPageCount();

    if (item.contentType === "application/pdf") {
      await appendPdf(merged, item.bytes);
    } else {
      await appendImage(merged, item);
    }

    attached.push({
      name: item.name,
      sha256: item.sha256,
      pages: merged.getPageCount() - before,
    });
  }

  const bytes = await merged.save({ useObjectStreams: false });

  return {
    bytes,
    sha256: sha256Hex(bytes),
    contentType: "application/pdf",
    filename: `${doc.reference}-tender-pack.pdf`,
    pageCount: merged.getPageCount(),
    substitutedCharacters: [...substituted],
    warnings,
    attached,
  };
}

/** Copy every page of a PDF onto the end of the pack. */
async function appendPdf(target: PDFDocument, bytes: Uint8Array): Promise<void> {
  const source = await PDFDocument.load(bytes, {
    updateMetadata: false,
    // A certificate downloaded from an authority's portal is routinely
    // "encrypted" with an empty owner password and no restriction that means
    // anything. Refusing to read it would refuse the pack over a permissions
    // flag on a document anybody can already open.
    ignoreEncryption: true,
  });
  const pages = await target.copyPages(source, source.getPageIndices());
  for (const page of pages) target.addPage(page);
}

/**
 * A scanned certificate, as one page.
 *
 * Fitted inside the page margins with its aspect ratio kept. A certificate
 * stretched to fill A4 is a certificate an evaluator suspects has been edited.
 */
async function appendImage(target: PDFDocument, item: EvidenceAttachment): Promise<void> {
  const image =
    item.contentType === "image/png"
      ? await target.embedPng(item.bytes)
      : await target.embedJpg(item.bytes);

  const page = target.addPage([PAGE.width, PAGE.height]);
  const maxWidth = PAGE.width - PAGE.marginX * 2;
  const maxHeight = PAGE.height - PAGE.marginTop - PAGE.marginBottom;
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1);
  const width = image.width * scale;
  const height = image.height * scale;

  page.drawImage(image, {
    x: (PAGE.width - width) / 2,
    y: (PAGE.height - height) / 2,
    width,
    height,
  });
}

// ── Materialising (CON-12, following `issue.ts`) ─────────────────────────────

export interface StoredTenderPack {
  readonly reference: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly preparedOn: string;
  readonly pageCount: number;
  /** False when a pack for this business date already existed. */
  readonly rendered: boolean;
  readonly warnings: readonly string[];
}

/** `tenants/<id>/documents/tender-pack/<year>/<ref>-<date>.pdf`. */
export function tenderPackStorageKey(input: {
  tenantId: string;
  reference: string;
  preparedOn: string;
}): string {
  const slug = `${input.reference}-${input.preparedOn}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `tenants/${input.tenantId.toLowerCase()}/documents/tender-pack/${input.preparedOn.slice(0, 4)}/${slug}.pdf`;
}

/**
 * Assemble the pack, or refuse with everything that is wrong.
 *
 * Idempotent per business date. A pack already assembled today is returned as
 * it was stored and nothing is rendered — which is what makes the stored hash
 * the hash of what was submitted rather than of whatever the register happens
 * to say when somebody presses the button a second time.
 */
export async function materialiseTenderPack(
  tx: TenantScopedTx,
  ctx: TenantContext,
  tenderId: string,
  options?: { preparedOn?: string },
): Promise<StoredTenderPack> {
  const { document, evidence, preparedOn } = await tenderPackInputs(tx, tenderId, options);

  const existing = await tenderPackOn(tx, tenderId, preparedOn);
  if (existing) {
    return {
      reference: document.reference,
      storageKey: existing.storageKey,
      sha256: existing.sha256,
      preparedOn: existing.preparedOn,
      pageCount: existing.pageCount,
      rendered: false,
      // From the manifest, not an empty list. A caller that shows warnings
      // beside the download would otherwise report a pack as clean the second
      // time it was opened, which is the same lie told more convincingly.
      warnings: manifestWarnings(existing.manifest),
    };
  }

  const { attachments, problems } = await readEvidence(evidence);

  // The register said there was a certificate; the store disagreed, or held
  // something that cannot become a page. Either way the row's `hasDocument` is
  // a claim the bytes do not support, so it is corrected before the assert runs
  // and the assert refuses on the required kinds that are now unevidenced.
  const byPosition = new Map(attachments.map((a) => [a.position, a]));
  const corrected: TenderPackDocument = {
    ...document,
    accreditations: document.accreditations.map((a, position) => ({
      ...a,
      hasDocument: byPosition.has(position),
      documentSha256: byPosition.get(position)?.sha256 ?? null,
    })),
  };

  let rendered;
  try {
    rendered = await renderTenderPack(corrected, attachments);
  } catch (error) {
    if (error instanceof TenderPackNotRenderableError && problems.length > 0) {
      // Reported together. Two refusals in a row for the same submission is how
      // a tool teaches people to assemble the pack by hand instead.
      throw new TenderPackNotRenderableError(document.reference, [...error.problems, ...problems]);
    }
    throw error;
  }

  if (problems.length > 0) {
    throw new TenderPackNotRenderableError(document.reference, problems);
  }

  const tenantId = await tenantIdOfTender(tx, tenderId);
  const key = tenderPackStorageKey({ tenantId, reference: document.reference, preparedOn });

  const objects = objectStore();
  const already = await objects.head(key);
  const sha256 = already
    ? already.sha256
    : (await objects.put({ key, body: rendered.bytes, declaredContentType: "application/pdf" }))
        .sha256;

  const stored = await recordTenderPack(tx, ctx, {
    tenderId,
    preparedOn,
    storageKey: key,
    sha256,
    pageCount: rendered.pageCount,
    byteSize: rendered.bytes.byteLength,
    manifest: JSON.stringify({
      preparedOn,
      warnings: rendered.warnings,
      attached: rendered.attached,
      assets: document.assets.length,
      rates: document.rates.length,
      referenceContracts: document.referenceContracts.length,
    }),
  });

  return {
    reference: document.reference,
    storageKey: stored.storageKey,
    sha256: stored.sha256,
    preparedOn: stored.preparedOn,
    pageCount: stored.pageCount,
    rendered: true,
    warnings: rendered.warnings,
  };
}

/**
 * The warnings a stored pack was assembled with.
 *
 * Tolerant on purpose: the manifest is a text column and a pack written by an
 * older version of this module may not have the key. A missing manifest means
 * "nothing recorded", never a thrown error on a download.
 */
function manifestWarnings(manifest: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(manifest);
    if (!parsed || typeof parsed !== "object") return [];
    const warnings = (parsed as { warnings?: unknown }).warnings;
    if (!Array.isArray(warnings)) return [];
    return warnings.filter((w): w is string => typeof w === "string");
  } catch {
    return [];
  }
}

/**
 * Pull the certificates out of object storage.
 *
 * Problems are collected rather than thrown one at a time, for the reason
 * `assertRenderable` collects its own. The content type comes from the store,
 * which sniffed it from the magic bytes — never from what somebody typed when
 * they uploaded it.
 */
async function readEvidence(
  evidence: readonly PackEvidence[],
): Promise<{ attachments: EvidenceAttachment[]; problems: string[] }> {
  const objects = objectStore();
  const attachments: EvidenceAttachment[] = [];
  const problems: string[] = [];

  for (const item of evidence) {
    const stored = await objects.get(item.storageKey);

    if (!stored) {
      problems.push(
        `${item.name} is on the accreditation register with a certificate attached, but the file ` +
          `is not in the store (${item.storageKey}). The pack will not claim a certificate it ` +
          `cannot produce`,
      );
      continue;
    }

    if (!MERGEABLE.has(stored.object.contentType)) {
      problems.push(
        `${item.name} is stored as ${stored.object.contentType}, which cannot become a page in a ` +
          `tender pack — replace it on the register with a PDF or a scan`,
      );
      continue;
    }

    attachments.push({
      position: item.position,
      kindLabel: item.kindLabel,
      name: item.name,
      referenceNo: item.referenceNo,
      issuingBody: item.issuingBody,
      grade: item.grade,
      expiresOn: item.expiresOn,
      contentType: stored.object.contentType,
      bytes: stored.body,
      sha256: stored.object.sha256,
    });
  }

  return { attachments, problems };
}

/**
 * The tenant the tender belongs to.
 *
 * Read from the row rather than taken from the caller's context, for the reason
 * `issue.ts` gives: the storage key is the only thing separating one tenant's
 * documents from another's in the bucket, and deriving it from the row being
 * rendered means a mismatched context cannot file a pack under the wrong
 * tenant. The read is inside the tenant boundary, so it finds nothing for a row
 * belonging to somebody else.
 */
async function tenantIdOfTender(tx: TenantScopedTx, tenderId: string): Promise<string> {
  const rows = await tx
    .select({ tenantId: schema.tenders.tenantId })
    .from(schema.tenders)
    .where(eq(schema.tenders.id, tenderId))
    .limit(1);

  const tenantId = rows[0]?.tenantId;
  if (!tenantId) throw new Error("Tender not found in this tenant");
  return tenantId;
}
