/**
 * Customer sign-off (`FLD-13`, `FLD-14`, `FLD-15`).
 *
 * ── WHAT MAKES A SIGNATURE WORTH ANYTHING ──────────────────────────────────
 *
 * `FLD-13` is right that the legal test is intention to be bound, not
 * signature technology - a finger on glass is sufficient. What is *not*
 * sufficient is a signature attached to a document that can change afterwards.
 * `FLD-14`: *"a mutable signed job sheet has no evidential value."*
 *
 * So the signed artefact is not the job. It is a **rendering** of the job -
 * the exact text that was on the screen above the pad at the moment the
 * customer signed - hashed, and the hash stored with the signature. If anybody
 * later disputes what was signed, the sheet is re-rendered and re-hashed, and
 * either the digests match or they do not.
 *
 * ── FLD-14 IS NOT BUILT, ON EITHER SIDE. THE WHOLE OF IT ───────────────────
 *
 * An earlier version of this comment said the PDF snapshot was "rendered
 * server-side by `packages/docs` on receipt" and that the customer's copy was
 * emailed "via the notification pipeline". **Both were false.** `packages/docs`
 * renders quotes, tax documents and tender packs and has no job-sheet renderer;
 * `recordJobSignature` stores a signature image and a name and does nothing
 * else. The comment described a division of labour that existed in neither
 * half, which is worse than describing nothing - a reader checking whether
 * `FLD-14` was covered would have concluded it was, and stopped looking.
 *
 * ADR 0009 counts four instances of a document in this codebase describing
 * behaviour it does not have. This was a fifth, and it was mine.
 *
 * What `FLD-14` requires, and where each piece actually stands:
 *
 *   1. SHA-256 of the rendered sheet     device: `canonicalSheet()` builds the
 *                                        exact bytes. Nothing hashes them -
 *                                        `expo-crypto` is not installed.
 *   2. Immutable PDF snapshot            NOT BUILT ANYWHERE. No renderer, no
 *                                        versioned object storage for one.
 *   3. Record locked after signature     `isLocked()` refuses the edit on the
 *                                        device. The server does not lock.
 *   4. Reason-coded linked amendments    NOT BUILT. No mutation kind expresses
 *                                        one, so there is deliberately no
 *                                        capture surface either - see the
 *                                        `Amendment` note at the foot of this
 *                                        file.
 *   5. Contemporaneous copy emailed      NOT BUILT.
 *
 * Only (1)'s canonicalisation and (3)'s device-side refusal exist. **A
 * signature captured by this app today proves that somebody drew on a screen
 * and nothing about what they were agreeing to.** That is why
 * `SignatureScreen` refuses to save one rather than storing a record that
 * looks valid.
 *
 * ── WHAT THIS MODULE DOES ──────────────────────────────────────────────────
 *
 * The canonicalisation, and the vocabulary around it. `canonicalSheet()`
 * produces the exact byte sequence to be hashed and `SignatureDigest` is the
 * injected function that would hash it. The canonicalisation is the part that
 * has to be byte-identical on both sides, and it is the part that is tested
 * here - so that when the rest is built, the hard half is already settled.
 */

import type { OfflineStamp } from "./clock";
import type { GeoStamp } from "./attendance";

/**
 * `FLD-15`: *"Do not perform biometric signature verification... running
 * stroke-dynamics analysis for the purpose of uniquely identifying a person
 * turns the signature into biometric data with a materially higher legal bar."*
 *
 * The implementation of that rule is this type, and specifically what it
 * **omits**. A point is `{x, y}` and nothing else: no per-point timestamp, no
 * pressure, no velocity, no tilt. Those fields are what stroke-dynamics
 * analysis consumes, and the reliable way not to run the analysis is not to
 * hold the data. Capturing them "just in case" and promising not to look would
 * put biometric data on the device and in the database, which is the outcome
 * the requirement forbids.
 *
 * x and y are normalised to 0..1 against the pad, so the stroke renders at any
 * size and carries no information about the device's screen.
 */
export interface StrokePoint {
  readonly x: number;
  readonly y: number;
}

/** One continuous pen-down..pen-up movement. */
export type Stroke = readonly StrokePoint[];

/** Vector, not raster - `FLD-13`: smaller, and it renders sharply at any size. */
export interface SignatureStrokes {
  readonly strokes: readonly Stroke[];
  /** The aspect ratio of the pad, so the vector can be laid out faithfully. */
  readonly aspectRatio: number;
}

/**
 * The consent statement, versioned.
 *
 * Versioned because the wording will change and a signature captured under the
 * old wording was given to the old wording. Storing the version rather than the
 * text keeps the record small; storing the text as well would let the record
 * be self-describing, and that trade is worth revisiting - it is not resolved
 * here, and the `statementText` field exists so the sheet hash covers the exact
 * words either way.
 */
export interface ConsentStatement {
  readonly version: string;
  readonly text: string;
}

export const CONSENT_STATEMENT_V1: ConsentStatement = {
  version: "sig-consent-2026-08-v1",
  text:
    "By signing below you confirm that the work described above was carried out at this property, " +
    "that you are authorised to accept it on behalf of the site, and that the details recorded are " +
    "correct to the best of your knowledge. A copy will be emailed to the address you provide. " +
    "Your signature is stored as an image of the marks you make; we do not analyse how you sign.",
};

/** `FLD-13`'s required identity fields. Every one of them is load-bearing. */
export interface SignerIdentity {
  readonly printedName: string;
  /** Relationship to the site - "Tenant", "Building manager", "Owner". */
  readonly role: string;
  /** For the copy. `FLD-14` requires the copy to be sent contemporaneously. */
  readonly email: string | null;
}

export interface CapturedSignature {
  readonly clientId: string;
  readonly jobId: string;
  readonly visitId: string | null;
  readonly signer: SignerIdentity;
  readonly strokes: SignatureStrokes;
  readonly consent: ConsentStatement;
  /** Device and (later) server timestamps, per ADR 0004. */
  readonly stamp: OfflineStamp;
  readonly geo: GeoStamp | null;
  /** Which technician's device captured this. */
  readonly technicianId: string;
  /** App build, so a rendering bug can be traced to the builds it affected. */
  readonly appVersion: string;
  /** SHA-256 of `canonicalSheet()`. The evidential anchor (`FLD-14`). */
  readonly sheetDigest: string;
  readonly satisfactionRating: number | null;
  readonly comments: string | null;
}

/**
 * `FLD-13`: *"`customer_not_available` is an explicit reason-coded path with
 * supervisor attestation - never force a fake signature, which is what always
 * happens when a signature is made mandatory."*
 *
 * The supervisor attestation is what stops this becoming the easy path. It is
 * a named person accepting that the visit ended unsigned, captured with the
 * same timestamp discipline as a signature.
 */
export type UnsignedReason =
  | "customer_not_available"
  | "customer_declined"
  | "site_unattended"
  | "customer_not_home";

export const UNSIGNED_REASON_LABEL: Readonly<Record<UnsignedReason, string>> = {
  customer_not_available: "Nobody available to sign",
  customer_declined: "Customer declined to sign",
  site_unattended: "Unattended site",
  customer_not_home: "Customer not home",
};

export interface UnsignedAttestation {
  readonly clientId: string;
  readonly jobId: string;
  readonly reason: UnsignedReason;
  readonly note: string;
  /** The supervisor who accepted it. Null until they have. */
  readonly attestedBySupervisorId: string | null;
  readonly stamp: OfflineStamp;
}

/**
 * Whether the visit may be closed without a signature.
 *
 * The attestation is required to be *present*, not to be *approved*: a
 * supervisor cannot always be reached from a basement, and blocking on that
 * would recreate the fake-signature pressure the requirement exists to remove.
 * The record leaves the device saying "unsigned, reason X, attestation
 * pending", and the office chases the attestation. That is a real gap and it
 * is visible, which is the whole difference.
 */
export function canCloseWithoutSignature(attestation: UnsignedAttestation | null): boolean {
  return attestation !== null && attestation.note.trim().length > 0;
}

// ── The sheet hash (FLD-14) ─────────────────────────────────────────────────

/**
 * The exact content the customer saw, in the order they saw it.
 *
 * Field order and formatting are part of the contract, not an implementation
 * detail: the server re-derives this string from its own copy of the record and
 * compares digests, so any difference in whitespace, ordering or number
 * formatting produces a mismatch and a false dispute. It is therefore written
 * as explicitly as possible - one `key: value` per line, LF endings, no
 * locale-dependent formatting anywhere.
 *
 * **This is the highest-consequence function in the app and there is nothing
 * to verify it against: no server implementation of it exists.** It is tested
 * here for stability and determinism only. The two implementations must be
 * diffed, byte for byte, before a signature captured by this app is relied on
 * for anything at all.
 */
export interface SheetContent {
  readonly jobReference: string;
  readonly customerName: string;
  readonly propertyAddress: string;
  readonly reportedFault: string;
  readonly diagnosedFault: string;
  readonly workCarriedOut: string;
  readonly materials: readonly { readonly description: string; readonly quantity: string; readonly unit: string }[];
  readonly labourMinutes: number;
  readonly outcomeLabel: string;
  readonly technicianName: string;
  readonly recordedOfflineAt: string;
  readonly consent: ConsentStatement;
}

export function canonicalSheet(content: SheetContent): string {
  const lines: string[] = [
    `sheet_format: meridian-jobsheet-v1`,
    `job_reference: ${flatten(content.jobReference)}`,
    `customer: ${flatten(content.customerName)}`,
    `property: ${flatten(content.propertyAddress)}`,
    `reported_fault: ${flatten(content.reportedFault)}`,
    `diagnosed_fault: ${flatten(content.diagnosedFault)}`,
    `work_carried_out: ${flatten(content.workCarriedOut)}`,
    `materials_count: ${content.materials.length}`,
  ];

  // Not sorted. The customer saw them in the order the technician entered them,
  // and re-sorting here would hash a document nobody looked at.
  content.materials.forEach((m, i) => {
    lines.push(`material_${i}: ${flatten(m.quantity)} ${flatten(m.unit)} ${flatten(m.description)}`);
  });

  lines.push(
    `labour_minutes: ${content.labourMinutes}`,
    `outcome: ${flatten(content.outcomeLabel)}`,
    `technician: ${flatten(content.technicianName)}`,
    `recorded_offline_at: ${content.recordedOfflineAt}`,
    `consent_version: ${content.consent.version}`,
    `consent_text: ${flatten(content.consent.text)}`,
  );

  return lines.join("\n");
}

/** Newlines and carriage returns collapse to a space; the format is line-based. */
function flatten(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

/** Injected: `expo-crypto`'s SHA-256 in the app, a stub in tests. */
export type SignatureDigest = (canonical: string) => Promise<string>;

export async function sealSheet(
  content: SheetContent,
  digest: SignatureDigest,
): Promise<{ readonly canonical: string; readonly sha256: string }> {
  const canonical = canonicalSheet(content);
  return { canonical, sha256: await digest(canonical) };
}

/**
 * `FLD-14`: *"After signature the job record is locked; corrections happen only
 * as a new, linked, reason-coded amendment."*
 *
 * TRD §8.4 restates it as a conflict rule: post-signature records are
 * immutable. The device enforces the lock locally so the technician cannot
 * type into a field that the server will refuse - and the enforcement is a
 * single predicate rather than a per-field rule, because "which fields lock"
 * is exactly the kind of list that grows a hole.
 */
export function isLocked(signedAt: string | null, attestation: UnsignedAttestation | null): boolean {
  return signedAt !== null || attestation !== null;
}

/**
 * `FLD-14`'s amendment. **There is no way to send one, and the app does not
 * offer to capture one.**
 *
 * The server's mutation vocabulary (`FIELD_MUTATION_KINDS`) has nothing that
 * expresses an amendment, so a screen that captured one would write to a dead
 * end: the technician types a correction, the app says it is saved, and
 * nothing ever carries it to the office. That is worse than the missing
 * feature, so the local table was removed and `isLocked()` above refuses the
 * edit outright - the technician is told the job is signed and to call the
 * office, which is true.
 *
 * The type is kept because the shape is settled and the requirement is real.
 * Building it needs a server route first.
 */
export interface Amendment {
  readonly clientId: string;
  readonly jobId: string;
  /** The signed record this corrects. Never overwrites it. */
  readonly amendsClientId: string | null;
  readonly reasonCode: string;
  readonly text: string;
  readonly stamp: OfflineStamp;
}
