/**
 * Presenting, sealing and amending a job sheet (`FLD-14`).
 *
 * `job-sheet.ts` renders and hashes. This module is the other three clauses:
 * the immutable snapshot, the lock, and the copy that goes to the customer.
 *
 * ── WHY THIS LIVES IN `packages/docs` ───────────────────────────────────────
 *
 * It needs four things at once: the renderer, the object store, the database
 * and the notification queue. `packages/db` cannot have the last one — the
 * queue is built on top of the database, and importing it back would be a
 * cycle. `packages/docs` already depends on `db` and `files`, and `notify`
 * depends on `db` and not on `docs`, so this is the one package where all four
 * meet without one.
 *
 * ── THE ORDER OF OPERATIONS, AND WHAT IT PROTECTS ───────────────────────────
 *
 * Sealing does five things, and the order of all five is load-bearing:
 *
 *   1. Re-derive the canonical sheet from the database and compare its digest
 *      with the one the client says it showed. A mismatch refuses the
 *      signature. This is the step that makes "the exact sheet that was on
 *      screen" enforceable rather than merely asserted — without it, a client
 *      could sign a sheet that had already been overtaken by an edit, and the
 *      stored hash would faithfully record the wrong document.
 *   2. Render the sealed PDF and write it to object storage. Storage is not
 *      transactional and the database is, so the bytes go first: a transaction
 *      that fails afterwards leaves an orphaned object, and because the render
 *      is deterministic the retry produces byte-identical output and adopts its
 *      own orphan. `issue.ts` explains this at length and the reasoning is the
 *      same.
 *   3. Write the signature row. Before the sheet row, because the sheet
 *      references it — and because the lock triggers refuse a `job_signoffs`
 *      insert on a job that is already sealed, which is the correct rule and
 *      would refuse this one if the order were reversed.
 *   4. Write the sheet row. **This is the lock.** Every statement after it in
 *      this transaction that touches the job card is refused by `0037`.
 *   5. Enqueue the email, inside the same transaction. If anything above rolls
 *      back, so does the message — a customer is never sent a fingerprint of a
 *      document that does not exist.
 *
 * ── WHAT THIS MODULE WILL NOT DO ────────────────────────────────────────────
 *
 * It will not seal a job card with gaps in it. `JOB-15` already refuses to
 * complete such a job; sealing one would be worse, because the sheet is what
 * the customer signs and a sheet that reads "time on the tools: 0m" because
 * nobody filled it in is a document that misrepresents the visit in a form the
 * customer has endorsed. The refusal reuses `assertJobCardComplete`, so the
 * gate and the sheet cannot disagree about what "finished" means.
 */

import { eq } from "drizzle-orm";
import {
  assertJobCardComplete,
  getJobSheetSource,
  getSealedJobSheet,
  listJobSheets,
  recordJobSheet,
  recordJobSignature,
  resolveJobSheetAmendmentReason,
  schema,
  type JobSheetRow,
  type JobSheetSource,
  type TenantContext,
  type TenantScopedTx,
} from "@meridian/db";
import { company, dubaiDateKey, UserFacingError } from "@meridian/core";
import { objectStore } from "@meridian/files";
import { enqueue } from "@meridian/notify";
import {
  canonicalJobSheet,
  jobSheetDigest,
  renderJobSheet,
  JOB_SHEET_FORMAT,
  type JobSheetContent,
  type JobSheetConsent,
} from "./job-sheet";
import type { DocumentParty } from "./blocks";
import type { RenderedDocument } from "./tax-document";

/**
 * The consent statement this build renders above the pad (`FLD-13`).
 *
 * Byte-identical to `CONSENT_STATEMENT_V1` in
 * `apps/field/src/domain/signature.ts`, and it has to stay that way: the text
 * is inside the canonical string, so a single differing character between the
 * two copies makes every signature from that app read as a mismatch. It is
 * duplicated rather than shared because the app cannot import this package —
 * moving both to `@meridian/core`, which the field app is meant to share, is
 * the right end state and is not this stream's file to touch.
 *
 * The version is what a report groups on when the wording changes. The text is
 * copied onto the signature row at the moment of signing, so a sheet sealed
 * under v1 stays readable after this constant becomes v2.
 */
export const JOB_SHEET_CONSENT: JobSheetConsent = {
  version: "sig-consent-2026-08-v1",
  text:
    "By signing below you confirm that the work described above was carried out at this property, " +
    "that you are authorised to accept it on behalf of the site, and that the details recorded are " +
    "correct to the best of your knowledge. A copy will be emailed to the address you provide. " +
    "Your signature is stored as an image of the marks you make; we do not analyse how you sign.",
};

/**
 * The supplier identity, from live configuration.
 *
 * A job sheet carries no identity snapshot on its row and does not need one:
 * unlike a tax invoice it is not a record of a taxable supply, and what freezes
 * the identity is the act of storing the artefact. The sheet a customer signed
 * keeps showing the licence number that was on it when they signed, because
 * those bytes are what is kept.
 */
function supplier(): DocumentParty {
  return {
    name: company.legalName,
    trn: company.trn,
    address: [company.address.street, company.address.city, company.address.country]
      .filter(Boolean)
      .join(", "),
    phone: company.phone,
    email: company.email,
    licenceNumber: company.licenceNumber,
    crNumber: company.crNumber,
  };
}

/** The canonical content, built from the record rather than from a caller. */
function contentOf(source: JobSheetSource, consent: JobSheetConsent, recordedAt: string): JobSheetContent {
  return {
    jobReference: source.jobReference,
    customerName: source.customerName,
    propertyAddress: source.propertyAddress,
    reportedFault: source.reportedFault,
    diagnosedFault: source.diagnosedFault,
    workCarriedOut: source.workCarriedOut,
    materials: source.materials,
    labourMinutes: source.labourMinutes,
    outcomeLabel: source.outcomeLabel,
    technicianName: source.technicianName,
    recordedOfflineAt: recordedAt,
    consent,
  };
}

/** How the sheet's dates appear on the page and in the email. Dubai, always. */
function dubaiStamp(instant: Date): string {
  return instant.toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Where a sheet lives.
 *
 * The same shape as `documentStorageKey` in `issue.ts` — tenant first for a
 * prefix-scoped credential, year next for a retention lifecycle rule, the
 * reference as the filename so an operator looking at the bucket knows what it
 * is without a database.
 */
export function jobSheetStorageKey(input: {
  tenantId: string;
  year: string;
  reference: string;
}): string {
  const slug = input.reference.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  return `tenants/${input.tenantId.toLowerCase()}/documents/job-sheet/${input.year}/${slug}.pdf`;
}

/**
 * Write the bytes, or adopt what is already there.
 *
 * The same adoption rule as `issue.ts`, and for the same reason: the write-once
 * property in `packages/files` exists to stop a template change replacing a
 * document somebody has already been sent, not to stop a retry after a failed
 * transaction. An existing object with the same hash is the same document.
 */
async function store(key: string, document: RenderedDocument): Promise<string> {
  const objects = objectStore();
  const existing = await objects.head(key);

  if (existing) {
    if (existing.sha256 !== document.sha256) {
      console.warn(
        `[docs] ${key} already holds a different job sheet (stored ${existing.sha256}, ` +
          `re-rendered ${document.sha256}). Keeping the stored one — it is the copy that may ` +
          `already have been sent, and a signed sheet is corrected by an amendment, not a reprint.`,
      );
    }
    return existing.sha256;
  }

  const written = await objects.put({
    key,
    body: document.bytes,
    declaredContentType: "application/pdf",
  });
  return written.sha256;
}

export interface JobSheetPresentation {
  readonly jobId: string;
  readonly jobReference: string;
  readonly reference: string;
  /** The canonical text, so a client can show or diff exactly what is hashed. */
  readonly canonical: string;
  /** SHA-256 of `canonical`. What a capture surface sends back with the signature. */
  readonly contentSha256: string;
  readonly consent: JobSheetConsent;
  readonly businessDate: string;
  readonly source: JobSheetSource;
  readonly content: JobSheetContent;
}

/**
 * What the sheet says and what it hashes to, without rendering it.
 *
 * Separated from `presentJobSheet` because the job screen needs the digest on
 * every load of a complete, unsigned job — it goes into the signature form as
 * the value the seal is checked against — and producing a PDF on every page
 * view to obtain a 64-character string would be work nobody reads.
 *
 * The digest is a pure function of the record. `recordedAt` comes from the
 * visit rather than from the clock (see `JobSheetSource.recordedAt`), so the
 * value the page put in the form is the value the action re-derives — and when
 * the two differ it is because the card genuinely moved, which is exactly what
 * the comparison is for.
 */
export async function jobSheetPresentation(
  tx: TenantScopedTx,
  jobId: string,
  options?: { recordedAt?: string; consent?: JobSheetConsent; now?: Date },
): Promise<JobSheetPresentation> {
  const sealed = await getSealedJobSheet(tx, jobId);
  if (sealed) {
    throw new UserFacingError(
      `This job was already signed off on job sheet ${sealed.reference}. ` +
        `A second signature would make "who signed this job" a question with two answers. ` +
        `If the sheet is wrong, raise a reason-coded amendment against it.`,
    );
  }

  // The same gate the completion path uses, so the sheet and `JOB-15` cannot
  // disagree about what a finished job card is. A sheet presented over an
  // incomplete card would put "time on the tools: 0m" in front of a customer
  // because nobody filled the section in, and then ask them to endorse it.
  await assertJobCardComplete(tx, jobId);

  const source = await getJobSheetSource(tx, jobId);
  const consent = options?.consent ?? JOB_SHEET_CONSENT;
  const content = contentOf(source, consent, options?.recordedAt ?? source.recordedAt);

  return {
    jobId,
    jobReference: source.jobReference,
    reference: `${source.jobReference}-JS`,
    canonical: canonicalJobSheet(content),
    contentSha256: jobSheetDigest(content),
    consent,
    // `dubaiDateKey`, not `toISOString().slice(0, 10)`. A sheet signed at 01:00
    // Dubai on the 5th is dated the 4th by UTC, and the whole system reasons in
    // Asia/Dubai.
    businessDate: dubaiDateKey(options?.now ?? new Date()),
    source,
    content,
  };
}

export interface PresentedJobSheet {
  readonly jobId: string;
  readonly jobReference: string;
  readonly reference: string;
  /** The canonical text, so a client can show or diff exactly what is hashed. */
  readonly canonical: string;
  /** SHA-256 of `canonical`. What a capture surface sends back with the signature. */
  readonly contentSha256: string;
  readonly consent: JobSheetConsent;
  readonly bytes: Uint8Array;
  /**
   * SHA-256 of `bytes`.
   *
   * Distinct from `contentSha256` and both are needed. The content digest is
   * the evidential one and is stable across renders of the same record; this
   * one covers the exact bytes handed to the client, which is what an ETag has
   * to mean.
   */
  readonly pdfSha256: string;
  readonly businessDate: string;
  /** Non-empty means a name on the sheet lost characters. See `RenderedDocument`. */
  readonly substitutedCharacters: readonly string[];
}

/**
 * The sheet as it goes on screen, above the pad.
 *
 * Writes nothing. Renders the unsigned version, returns its bytes, the exact
 * canonical string that was hashed and the digest of it. A capture surface
 * displays this, takes the signature, and sends the digest back to
 * `sealJobSheet` — which re-derives it and refuses if the record has moved in
 * between.
 *
 * `recordedAt` is optional and defaults to the record's own timing. A handset
 * overrides it with the device clock reading it actually showed the technician,
 * so that the hash covers the value the customer saw rather than one the server
 * substituted. Either way the string is carried through unaltered; see
 * `JobSheetContent.recordedOfflineAt`.
 */
export async function presentJobSheet(
  tx: TenantScopedTx,
  jobId: string,
  options?: { recordedAt?: string; consent?: JobSheetConsent; now?: Date },
): Promise<PresentedJobSheet> {
  const presentation = await jobSheetPresentation(tx, jobId, options);

  const rendered = await renderJobSheet({
    reference: presentation.reference,
    businessDate: presentation.businessDate,
    supplier: supplier(),
    content: presentation.content,
    alsoOnFile: {
      photoCounts: presentation.source.photoCounts,
      declarations: presentation.source.declarations,
      visits: presentation.source.visits,
    },
    signature: null,
  });

  return {
    jobId,
    jobReference: presentation.jobReference,
    reference: presentation.reference,
    canonical: presentation.canonical,
    contentSha256: presentation.contentSha256,
    consent: presentation.consent,
    bytes: rendered.bytes,
    pdfSha256: rendered.sha256,
    businessDate: presentation.businessDate,
    substitutedCharacters: rendered.substitutedCharacters,
  };
}

export class SheetChangedError extends UserFacingError {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      "The job card changed between this sheet being shown and it being signed, so the signature " +
        "would not be a signature on what was displayed. Nothing has been recorded. Show the " +
        "customer the sheet again and take the signature on the current version.",
    );
    this.name = "SheetChangedError";
  }
}

export interface SealJobSheetInput {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly signedByName: string;
  readonly signedByRole?: string | null;
  readonly signerEmail?: string | null;
  /** Where `packages/files` put the signature image. */
  readonly signatureStorageKey: string;
  readonly satisfactionRating?: number | null;
  readonly comments?: string | null;
  /**
   * The digest the capture surface says it displayed.
   *
   * Required. A signature offered without one is a signature on an unknown
   * document, and accepting it would store exactly the evidence `FLD-14` says
   * is worth nothing.
   */
  readonly presentedSha256: string;
  /**
   * The `recordedOfflineAt` string that was on the presented sheet.
   *
   * Optional: omitted, it is re-derived from the record exactly as
   * `jobSheetPresentation` derived it. A handset passes the device clock
   * reading it actually displayed, because on that path the value the customer
   * saw is the one the hash has to cover.
   */
  readonly recordedAt?: string;
  /** The device's own clock reading, where the client reported one (`FLD-3`). */
  readonly deviceSignedAt?: Date | null;
  readonly consent?: JobSheetConsent;
  readonly now?: Date;
}

export interface SealedJobSheet {
  readonly sheetId: string;
  readonly signoffId: string;
  readonly reference: string;
  readonly storageKey: string;
  readonly contentSha256: string;
  readonly pdfSha256: string;
  /** Null when the copy went out; a sentence when there was nowhere to send it. */
  readonly copyProblem: string | null;
  readonly substitutedCharacters: readonly string[];
}

/**
 * Take the signature, seal the sheet, lock the card, send the copy.
 *
 * Runs entirely inside the caller's transaction. See the order-of-operations
 * note in the module header for why each step is where it is.
 */
export async function sealJobSheet(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: SealJobSheetInput,
): Promise<SealedJobSheet> {
  const now = input.now ?? new Date();
  const consent = input.consent ?? JOB_SHEET_CONSENT;

  const sealed = await getSealedJobSheet(tx, input.jobId);
  if (sealed) {
    throw new UserFacingError(
      `This job was already signed off on job sheet ${sealed.reference}. ` +
        `If that sheet is wrong, raise a reason-coded amendment against it.`,
    );
  }

  await assertJobCardComplete(tx, input.jobId);

  const source = await getJobSheetSource(tx, input.jobId);
  const recordedAtText = input.recordedAt ?? source.recordedAt;
  const content = contentOf(source, consent, recordedAtText);
  const contentSha256 = jobSheetDigest(content);

  // Step 1. The comparison that makes the requirement enforceable.
  //
  // Lower-cased on both sides before comparing, because a client library that
  // returns an upper-case digest is producing the same digest — and refusing a
  // genuine signature over letter case would be a false dispute of exactly the
  // kind the canonicalisation is written to avoid.
  if (input.presentedSha256.trim().toLowerCase() !== contentSha256) {
    throw new SheetChangedError(input.presentedSha256.trim().toLowerCase(), contentSha256);
  }

  const businessDate = dubaiDateKey(now);
  const reference = `${source.jobReference}-JS`;

  const rendered = await renderJobSheet({
    reference,
    businessDate,
    supplier: supplier(),
    content,
    alsoOnFile: {
      photoCounts: source.photoCounts,
      declarations: source.declarations,
      visits: source.visits,
    },
    signature: {
      signedByName: input.signedByName.trim(),
      signedByRole: input.signedByRole?.trim() || null,
      signerEmail: input.signerEmail?.trim().toLowerCase() || null,
      signedAtLabel: dubaiStamp(now),
      deviceSignedAtLabel: input.deviceSignedAt ? dubaiStamp(input.deviceSignedAt) : null,
    },
  });

  // Step 2. Bytes before rows. Storage is not transactional; the database is.
  const key = jobSheetStorageKey({
    tenantId: ctx.tenantId,
    year: businessDate.slice(0, 4),
    reference,
  });
  const pdfSha256 = await store(key, rendered);

  // Step 3. The signature, before the sheet that references it — and before the
  // lock exists, which is the only moment a `job_signoffs` insert is permitted
  // on this job.
  const signoff = await recordJobSignature(tx, ctx, {
    jobId: input.jobId,
    visitId: input.visitId ?? null,
    signedByName: input.signedByName,
    signedByRole: input.signedByRole ?? null,
    signatureStorageKey: input.signatureStorageKey,
    satisfactionRating: input.satisfactionRating ?? null,
    comments: input.comments ?? null,
    signerEmail: input.signerEmail ?? null,
    consentVersion: consent.version,
    consentText: consent.text,
  });

  // Step 4. The lock.
  const sheet = await recordJobSheet(tx, ctx, {
    jobId: input.jobId,
    visitId: input.visitId ?? null,
    kind: "original",
    reference,
    sequence: 0,
    signoffId: signoff.id,
    sheetFormat: JOB_SHEET_FORMAT,
    contentSha256,
    storageKey: key,
    pdfSha256,
    businessDate,
    // The one input to the digest that cannot be re-read from the record. See
    // `job_sheets.recorded_at_text`.
    recordedAtText,
  });

  // Step 5. The copy, in this transaction.
  //
  // The signer's own address first. `FLD-13` collects it at the pad precisely
  // because the person who signs at a site is often not the person the
  // invoices go to, and sending what they signed to the accounts inbox instead
  // is both a useless copy and a disclosure to somebody who was not there. The
  // customer's billing address is the fallback, not the default.
  // Lower-cased, matching what `recordJobSignature` stored on the row. The same
  // address in two cases is two recipients in every suppression window and
  // every bounce count, and the ledger is the thing that has to be able to
  // answer "was this customer sent their copy" with one row.
  const to =
    input.signerEmail?.trim().toLowerCase() || source.customerEmail?.trim().toLowerCase() || "";
  const enqueued = await enqueue(tx, ctx, {
    channel: "email",
    template: "job_sheet_signed",
    to,
    subject: { table: "job_sheets", id: sheet.id },
    payload: {
      customerName: source.customerName,
      signedByName: input.signedByName.trim(),
      jobReference: source.jobReference,
      jobTitle: source.jobTitle,
      sheetReference: reference,
      contentSha256,
      signedAt: now,
    },
  });

  return {
    sheetId: sheet.id,
    signoffId: signoff.id,
    reference,
    storageKey: key,
    contentSha256,
    pdfSha256,
    // Reported rather than thrown. The signature is the event and the copy is a
    // consequence of it; rolling back a customer's signature because nobody had
    // recorded an email address would lose the thing that matters to protect
    // the thing that does not. The gap is returned so the operator sees it.
    copyProblem:
      "skipped" in enqueued
        ? "No email address was given for the signer and the customer has none on file, so the " +
          "contemporaneous copy could not be sent. Add an address and forward the sheet."
        : null,
    substitutedCharacters: rendered.substitutedCharacters,
  };
}

export interface AmendJobSheetInput {
  readonly jobId: string;
  readonly reasonCode: string;
  /** What the code does not say. Beside it, never instead of it. */
  readonly detail?: string | null;
  readonly now?: Date;
}

/**
 * Correct a signed sheet without touching it (`FLD-14`).
 *
 * ── WHAT AN AMENDMENT IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * It is a second document: the record as it now stands, with a coded reason
 * and, where somebody wrote one, a sentence saying what was wrong. It is sealed
 * and hashed like the original, stored write-once like the original, and linked
 * to the original.
 *
 * It is **not** an unlock. The card stays locked, the original sheet stays on
 * file, and its digest still describes the document the customer signed.
 * "Corrections happen only as a new, linked, reason-coded amendment" is
 * satisfied by a second document; an unlock-edit-reseal cycle would leave the
 * copy in the customer's inbox evidencing a position the business no longer
 * holds, which is the mutable job sheet the requirement forbids arrived at by a
 * more respectable-looking route.
 *
 * A consequence worth stating plainly: because the card is locked, the amended
 * content is *the same* content as the original unless the correction is
 * carried in `detail`. That is not an oversight — it is what "nothing is ever
 * edited" costs, and the honest place for the correction is a sentence somebody
 * wrote and signed their name under, not a silently different row.
 */
export async function amendJobSheet(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: AmendJobSheetInput,
): Promise<{
  readonly sheetId: string;
  readonly reference: string;
  readonly storageKey: string;
  readonly contentSha256: string;
  readonly pdfSha256: string;
}> {
  const original = await getSealedJobSheet(tx, input.jobId);
  if (!original) {
    throw new UserFacingError(
      "There is no signed job sheet on this job, so there is nothing to amend. " +
        "An unsigned job card is corrected by editing it.",
    );
  }

  const reason = await resolveJobSheetAmendmentReason(tx, input.reasonCode);

  const detail = input.detail?.trim() || null;
  if (!detail) {
    // The code says which kind of thing went wrong. It cannot say what the
    // position now is, and an amendment that only says "parts recorded wrongly"
    // leaves the reader knowing that the sheet is wrong and not what is right —
    // which is worse than the uncorrected sheet, because it discredits the
    // record without replacing it.
    throw new UserFacingError(
      "An amendment needs a sentence saying what the position actually is. The reason code says " +
        "what kind of thing went wrong; it cannot say what is right.",
    );
  }

  const existing = await listJobSheets(tx, input.jobId);
  const sequence = Math.max(...existing.map((s) => s.sequence)) + 1;
  const reference = `${original.reference}-A${sequence}`;

  const now = input.now ?? new Date();
  const businessDate = dubaiDateKey(now);

  const source = await getJobSheetSource(tx, input.jobId);
  const consent = await consentOfSheet(tx, original);
  // The ORIGINAL's own `recordedOfflineAt` string, read off its row rather than
  // re-derived. On the handset path that value came from the device clock and
  // the server cannot reconstruct it — which is why the column exists.
  //
  // Reproducing it makes the amendment's content digest equal to the
  // original's, and that equality is the point: it is machine-checkable proof
  // that raising an amendment corrected what the record MEANS and did not touch
  // what it says. A digest that differed would leave a reader unable to tell an
  // amendment from a re-seal.
  const content = contentOf(source, consent, original.recordedAtText);
  const contentSha256 = jobSheetDigest(content);

  const raisedByName = await actorName(tx, ctx);

  const rendered = await renderJobSheet({
    reference,
    businessDate,
    supplier: supplier(),
    content,
    alsoOnFile: {
      photoCounts: source.photoCounts,
      declarations: source.declarations,
      visits: source.visits,
    },
    signature: null,
    amendment: {
      amendsReference: original.reference,
      amendsContentSha256: original.contentSha256,
      reasonCode: reason.code,
      reasonLabel: reason.label,
      detail,
      raisedByName,
    },
  });

  const key = jobSheetStorageKey({
    tenantId: ctx.tenantId,
    year: businessDate.slice(0, 4),
    reference,
  });
  const pdfSha256 = await store(key, rendered);

  const sheet = await recordJobSheet(tx, ctx, {
    jobId: input.jobId,
    visitId: original.visitId,
    kind: "amendment",
    reference,
    sequence,
    sheetFormat: JOB_SHEET_FORMAT,
    contentSha256,
    storageKey: key,
    pdfSha256,
    businessDate,
    recordedAtText: original.recordedAtText,
    amendsSheetId: original.id,
    amendmentReasonCode: reason.code,
    amendmentDetail: detail,
  });

  return { sheetId: sheet.id, reference, storageKey: key, contentSha256, pdfSha256 };
}

/**
 * The consent wording the original sheet was signed under.
 *
 * Read from the signature row rather than taken from `JOB_SHEET_CONSENT`,
 * because an amendment raised after the wording changes must reproduce the
 * words the customer actually agreed to. Falling back to the current constant
 * covers a signature captured before `0037` added the columns — the only case
 * where the row genuinely does not know.
 */
async function consentOfSheet(tx: TenantScopedTx, sheet: JobSheetRow): Promise<JobSheetConsent> {
  if (!sheet.signoffId) return JOB_SHEET_CONSENT;

  const rows = await tx
    .select({
      version: schema.jobSignoffs.consentVersion,
      text: schema.jobSignoffs.consentText,
    })
    .from(schema.jobSignoffs)
    .where(eq(schema.jobSignoffs.id, sheet.signoffId))
    .limit(1);

  const row = rows[0];
  if (!row?.version || !row.text) return JOB_SHEET_CONSENT;
  return { version: row.version, text: row.text };
}

/** Who raised the amendment, for the face of the document. */
async function actorName(tx: TenantScopedTx, ctx: TenantContext): Promise<string | null> {
  if (!ctx.userId) return null;
  const rows = await tx
    .select({ name: schema.users.fullName })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId))
    .limit(1);
  return rows[0]?.name ?? null;
}
