/**
 * The digital job card - what the technician found, did, fitted and spent
 * (`FLD-6`, `FLD-7`, `FLD-9`, `FLD-11`, `FLD-12`).
 *
 * ── THE DEVICE DOES NOT DECIDE WHETHER A JOB CARD IS COMPLETE ──────────────
 *
 * An earlier version of this file computed `JOB-15`'s outstanding conditions
 * locally, as an "advisory" pre-check that mirrored the server's vocabulary.
 * That was wrong, and the reason is worth keeping because it is subtle: the
 * check was careful, it used the server's own gap names, and it was still a
 * second implementation of one rule. Two implementations of one rule are one
 * rule and one bug waiting for the rule to change.
 *
 * `packages/db/src/domain/field.ts` says it exactly:
 *
 *   > A phone that reimplements "do I have an after photograph, materials and
 *   > labour" will drift from that rule the first time the rule changes - and
 *   > the failure is the worst shape available: the technician's screen says
 *   > the job is ready, they press complete standing in a plant room with no
 *   > signal, and the refusal arrives hours later when the queue drains.
 *
 * So the server computes the gaps and **sends them**. `FieldJob.gaps` arrives
 * on every sync, from the same `getJobCard(tx, jobId)` that the web job-card
 * panel renders, and a rejected completion carries a fresh list in
 * `rejected[].gaps`. This module's job is to render what it is told and to
 * survive being told something it does not recognise. It computes nothing.
 *
 * ── THE THREE STATES OF `gaps`, WHICH ARE NOT TWO ──────────────────────────
 *
 *   `null`  completion is not on the table - the job is still `dispatched` and
 *           nobody has arrived. **Not** "nothing is missing".
 *   `[]`    nothing is missing; this job can be completed.
 *   `[...]` these conditions are outstanding.
 *
 * Collapsing null into empty would put a live "complete" button on a job the
 * technician has not travelled to yet. `completionReadiness()` below keeps the
 * three apart and is the only thing the screen is allowed to ask.
 *
 * ── WHAT THE DEVICE STILL OWNS ─────────────────────────────────────────────
 *
 * The *shape* of the record - that "no materials" is a positive declaration
 * rather than an empty list, that a recorded zero is different from a blank -
 * is modelled here, because those are properties of what gets sent, not
 * judgements about whether it is enough. Getting them wrong produces a
 * mutation the server rejects; getting the gate wrong produces a screen that
 * lies.
 */

import type { OfflineStamp } from "./clock";
import type { LabourOverride, LabourSplit } from "./attendance";
import { effectiveWorkMinutes } from "./attendance";

// ── Fault capture (FLD-6) ───────────────────────────────────────────────────

/** `JOB-14`'s three-part taxonomy. Codes come from sync, never from a literal. */
export type FaultCodeKind = "symptom" | "cause" | "remedy";

export interface FaultCodeRef {
  /** Server id of a row in `fault_codes`. */
  readonly id: string;
  readonly kind: FaultCodeKind;
  readonly code: string;
  readonly label: string;
}

export interface FaultCapture {
  /**
   * What the customer reported, as the office recorded it. Read-only on the
   * device: the technician diagnoses, they do not rewrite the complaint.
   */
  readonly reportedFault: string | null;
  readonly symptom: FaultCodeRef | null;
  readonly cause: FaultCodeRef | null;
  readonly remedy: FaultCodeRef | null;
  /** The technician's own words. Recorded alongside the codes, never instead. */
  readonly diagnosisNote: string | null;
}

// ── Photos (FLD-7) ──────────────────────────────────────────────────────────

/** `FLD-7`'s role vocabulary. A photo without a role is a photo nobody can find. */
export type PhotoRole =
  | "before"
  | "after"
  | "defect"
  | "serial_plate"
  | "meter_reading"
  | "parts_used"
  | "site_access";

export const PHOTO_ROLE_LABEL: Readonly<Record<PhotoRole, string>> = {
  before: "Before",
  after: "After",
  defect: "Defect",
  serial_plate: "Serial plate",
  meter_reading: "Meter reading",
  parts_used: "Parts used",
  site_access: "Site access",
};

export interface CapturedPhoto {
  readonly clientId: string;
  readonly jobId: string;
  readonly role: PhotoRole;
  /** Local file URI of the compressed copy queued for upload. */
  readonly localUri: string;
  /** Local file URI of the original, kept until the compressed copy is confirmed synced. */
  readonly originalUri: string | null;
  readonly thumbnailUri: string | null;
  readonly stamp: OfflineStamp;
  /** `FLD-8`(b): extracted into columns at capture, before EXIF is stripped. */
  readonly capturedLat: number | null;
  readonly capturedLng: number | null;
  readonly caption: string | null;
  readonly uploadState: "queued" | "uploading" | "uploaded" | "filed" | "failed";
  /** The server's upload id. What the attachment mutation cites - not a key. */
  readonly uploadId: string | null;
  /** "pending" until the server's scan clears it. Never presented as cleared. */
  readonly scanStatus: string | null;
}

// ── Materials (FLD-9) ───────────────────────────────────────────────────────

export type MaterialSource = "van_stock" | "purchased" | "customer_supplied";

export const MATERIAL_SOURCE_LABEL: Readonly<Record<MaterialSource, string>> = {
  van_stock: "Van stock",
  purchased: "Purchased",
  customer_supplied: "Customer supplied",
};

export interface MaterialLine {
  readonly clientId: string;
  /** Null when the technician used the free-text escape hatch below. */
  readonly sku: string | null;
  readonly description: string;
  /** Decimal string. Fractional quantities are real: 2.5 m of cable. */
  readonly quantity: string;
  readonly unit: string;
  readonly source: MaterialSource;
  readonly serialNumber: string | null;
  /**
   * `FLD-9`: *"with a free-text escape hatch flagged for office
   * reconciliation"*. The flag is the point. A technician who fitted a part
   * that is not in the catalogue must be able to say so - the alternative is
   * they pick the nearest wrong SKU, and a wrong SKU is worse than a flagged
   * unknown because nobody ever finds it.
   */
  readonly needsOfficeReconciliation: boolean;
}

// ── The draft ───────────────────────────────────────────────────────────────

/**
 * `JOB-15` distinguishes "no materials" from "nobody filled it in", and so does
 * this. `materialsDeclaredNone` is a positive act with a timestamp, not the
 * absence of rows.
 */
export interface JobCardDraft {
  readonly jobId: string;
  readonly fault: FaultCapture;
  readonly workCarriedOut: string | null;
  readonly photos: readonly CapturedPhoto[];
  /** `JOB-15`'s reason-coded exemption. Code comes from sync (`photo_exemption_reason`). */
  readonly photoExemptionCode: string | null;
  readonly photoExemptionNote: string | null;
  readonly materials: readonly MaterialLine[];
  readonly materialsDeclaredNone: { readonly at: string; readonly note: string | null } | null;
  readonly labour: LabourSplit;
  readonly labourOverride: LabourOverride | null;
  /** `JOB-11` / `JOB-13`. Code from sync (`outcome_code`), never free text. */
  readonly outcomeCode: string | null;
  /**
   * `FLD-12`. Raises a lead when set. The highest-value field on the form, and
   * a **field of `job_note/upsert`** rather than a record of its own - the
   * server has no recommendation entity. See `payloads.ts`.
   */
  readonly recommendation: { readonly text: string; readonly photoClientId: string | null } | null;
}

/**
 * The server's gap vocabulary - `JobCardGap` in
 * `packages/db/src/domain/jobcard.ts`.
 *
 * This is a **label table, not a rule**. Nothing here decides whether a gap
 * exists; the codes arrive from the server and this turns them into the
 * sentence a technician reads in a plant room. It is deliberately not a
 * closed union in the places that consume it: the server may grow a fourth
 * condition, and an old build on somebody's phone has to show it rather than
 * drop it.
 *
 * Note there is no `outcome` entry, though an earlier version of this file
 * invented one. `assertJobCardComplete` gates on three conditions; the outcome
 * code is refused separately by `recordJobOutcome`, which returns its own
 * message. Adding a fourth gap here would have been the device asserting a
 * rule the server does not have.
 */
export type CompletionGap = "after_photo" | "materials" | "labour";

export const COMPLETION_GAP_MESSAGE: Readonly<Record<CompletionGap, string>> = {
  after_photo: "Take at least one 'after' photo, or record why there isn't one.",
  materials: "List the parts you used, or record that you used none.",
  labour: "Record how long the work took.",
};

/** A gap code this build has never heard of still has to reach the screen. */
export function gapMessage(code: string): string {
  return (
    COMPLETION_GAP_MESSAGE[code as CompletionGap] ??
    `The office needs something else on this card before it can be completed (${code}). Call them.`
  );
}

export type CompletionReadiness =
  /** `gaps === null`: the job is not at a stage where completion applies. */
  | { readonly state: "not_applicable" }
  /** `gaps === []`: the server says this card is complete. */
  | { readonly state: "ready" }
  /** `gaps` non-empty: these conditions are outstanding, in the server's order. */
  | { readonly state: "outstanding"; readonly messages: readonly string[]; readonly codes: readonly string[] }
  /**
   * This job has never synced, so the device has never been told. Distinct
   * from "ready" on purpose: an unsynced job is not a job the server has
   * approved, and showing a live complete button would be the device deciding.
   */
  | { readonly state: "unknown" };

/**
 * What the screen may say about completing this job.
 *
 * `gaps` is `readonly string[] | null | undefined`, and all three inputs mean
 * different things - see the note at the top of this file. `undefined` is the
 * local-only case: a job row that has never carried a server answer.
 */
export function completionReadiness(gaps: readonly string[] | null | undefined): CompletionReadiness {
  if (gaps === undefined) return { state: "unknown" };
  if (gaps === null) return { state: "not_applicable" };
  if (gaps.length === 0) return { state: "ready" };
  return { state: "outstanding", messages: gaps.map(gapMessage), codes: gaps };
}

/**
 * May the completion button be pressed?
 *
 * **Only when the server has said so.** Not on "unknown", which is the case
 * that would otherwise be tempting - a technician who has never synced a job
 * would get a button that queues a completion the server refuses. Refusing to
 * offer it, and saying why, is the honest answer.
 */
export function canAttemptCompletion(gaps: readonly string[] | null | undefined): boolean {
  return completionReadiness(gaps).state === "ready";
}

// ── The shape of what gets sent ─────────────────────────────────────────────

/**
 * `JOB-15` distinguishes "no materials" from "nobody filled it in", and the
 * server holds that as a row in `job_card_declarations` with
 * `kind = 'materials_none'` - a positive act, not an empty array.
 *
 * Two consequences the device has to respect, both enforced below rather than
 * left to a screen to remember:
 *
 *   * **Never infer the declaration from an empty list.** A card nobody has
 *     filled in and a card with a declared zero look identical in an array
 *     length and mean opposite things.
 *   * **Never send the declaration while lines exist.** `declareNoMaterials`
 *     refuses it, and recording a part deletes an existing declaration in the
 *     same transaction. A device that sent both would fight the server on
 *     every sync.
 */
export function canDeclareNoMaterials(draft: JobCardDraft): boolean {
  return draft.materials.length === 0 && draft.materialsDeclaredNone === null;
}

/**
 * True when recording this part must also drop a local `materials_none`
 * declaration, mirroring what the server does in one transaction.
 */
export function recordingMaterialClearsDeclaration(draft: JobCardDraft): boolean {
  return draft.materialsDeclaredNone !== null;
}

// ── Handling the server's refusal ───────────────────────────────────────────

/**
 * A completion the server rejected.
 *
 * `rejected[].gaps` in `FieldMutationResult` - *"structured, because a sentence
 * is something to show and a list is something to act on"*. Absent, not empty,
 * on every refusal that was not the `JOB-15` gate: an empty array would mean
 * "nothing is missing", which is never true of a rejected completion.
 *
 * `gaps` is typed `string[]`, not `CompletionGap[]`, because this build will be
 * an old version on somebody's phone for months after the server grows a
 * condition, and a client that crashes on an unknown enum member is a client
 * that cannot be updated over the air.
 */
export interface CompletionRefusal {
  readonly clientId: string;
  /** The server's own sentence. Always shown when nothing better is available. */
  readonly message: string;
  readonly gaps?: readonly string[];
}

export interface InterpretedRefusal {
  /** Every gap, in the server's order, as text. Unknown codes included. */
  readonly messages: readonly string[];
  /** Codes this build recognises and can route the technician to a section for. */
  readonly known: readonly CompletionGap[];
  /** Codes it does not. Shown, never dropped - see above. */
  readonly unknown: readonly string[];
  /** True when only prose was available. */
  readonly proseOnly: boolean;
}

const KNOWN_GAPS: ReadonlySet<string> = new Set<CompletionGap>(["after_photo", "materials", "labour"]);

export function interpretRefusal(refusal: CompletionRefusal): InterpretedRefusal {
  const gaps = refusal.gaps ?? [];
  return {
    messages: gaps.length > 0 ? gaps.map(gapMessage) : [refusal.message],
    known: gaps.filter((g): g is CompletionGap => KNOWN_GAPS.has(g)),
    unknown: gaps.filter((g) => !KNOWN_GAPS.has(g)),
    proseOnly: gaps.length === 0,
  };
}

/**
 * What a refused completion does to the local record.
 *
 * **It does not roll back, and it does not discard the queued write.** The job
 * card stays exactly as the technician left it, the outbox row moves to
 * `refused` carrying the gaps, and the screen reopens on the checklist.
 *
 * Rolling back would discard a technician's typing to resolve a disagreement
 * about a photo count. Retrying would burn battery and bury the reason - the
 * answer is deterministic and will not change until a person changes
 * something. Dropping it would lose the work outright. So it is kept, visible,
 * and not retried, and fixing the gap mints a new mutation.
 */
export type RefusalDisposition = "hold_for_technician";

export function refusalDisposition(_refusal: CompletionRefusal): RefusalDisposition {
  return "hold_for_technician";
}
