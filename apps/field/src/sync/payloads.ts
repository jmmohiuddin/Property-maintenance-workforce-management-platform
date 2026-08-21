/**
 * The payload of every mutation, in one place.
 *
 * ── WHY THESE ARE BUILDERS AND NOT OBJECT LITERALS AT THE CALL SITE ────────
 *
 * A payload is the part of the contract with no schema on the client: the
 * server parses it, the device merely composes it, and a misspelled key
 * produces a rejection hours later in a plant room rather than a compile
 * error. Putting every one behind a typed builder is what turns "the server
 * changed a field name" into a build failure here instead of a silent refusal
 * there. The API author has already changed two of them once.
 *
 * Field names are camelCase. The server accepts both spellings on input, but
 * writing one of them consistently is the only way the next reader can tell
 * whether a difference is deliberate.
 */

import type { MutationEntity, MutationOp } from "./protocol";

export interface MutationSpec {
  readonly entity: MutationEntity;
  readonly op: MutationOp;
  readonly jobId: string | null;
  readonly payload: Record<string, unknown>;
  /** Only the classes that can be overwritten carry one. See conflicts.ts. */
  readonly baseVersion: string | null;
  readonly dependsOnClientId: string | null;
}

// ── Status transitions ──────────────────────────────────────────────────────

/**
 * The only statuses a handset may set.
 *
 * ── AND THE ONE IT MAY NOT, WHICH IS THE POINT ─────────────────────────────
 *
 * `work_complete` is refused by the server, deliberately, and the device must
 * not offer it. `JOB-15`'s gate lives in `recordJobOutcome`, **not** in
 * `transitionJob`, and `on_site -> work_complete` is a perfectly legal
 * transition that checks nothing about the job card. A bare status change from
 * a phone would therefore have completed jobs with no after photograph, no
 * materials answer and no labour - silently, from the least observable client
 * in the estate.
 *
 * Completion has exactly one route in: `recordOutcome()` below.
 *
 * This list is duplicated from the server's allow-list, which is the kind of
 * duplication this workspace otherwise avoids. It is justified here because
 * the alternative is a button that queues a mutation guaranteed to be refused:
 * the client is not deciding the rule, it is declining to offer an action it
 * knows is not available. `assertTransitionAllowed` fails loudly if a caller
 * tries anyway, so the two lists disagreeing surfaces at once.
 */
export const FIELD_SETTABLE_STATUSES = ["en_route", "on_site", "paused"] as const;

export type FieldSettableStatus = (typeof FIELD_SETTABLE_STATUSES)[number];

export function isFieldSettableStatus(status: string): status is FieldSettableStatus {
  return (FIELD_SETTABLE_STATUSES as readonly string[]).includes(status);
}

export class UnavailableFromTheFieldError extends Error {
  constructor(readonly status: string) {
    super(
      status === "work_complete"
        ? "A job is completed by sending the job card, not by changing its status."
        : `A phone cannot set a job to "${status}".`,
    );
    this.name = "UnavailableFromTheFieldError";
  }
}

export function transition(input: {
  readonly jobId: string;
  readonly to: string;
  readonly note?: string;
  readonly baseVersion: string | null;
}): MutationSpec {
  if (!isFieldSettableStatus(input.to)) throw new UnavailableFromTheFieldError(input.to);
  return {
    entity: "job_status",
    op: "transition",
    jobId: input.jobId,
    payload: { jobId: input.jobId, to: input.to, ...(input.note ? { note: input.note } : {}) },
    baseVersion: input.baseVersion,
    dependsOnClientId: null,
  };
}

// ── The completion (JOB-15's only door) ─────────────────────────────────────

export function recordOutcome(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly outcomeCode: string;
  readonly symptomCodeId?: string | null;
  readonly causeCodeId?: string | null;
  readonly remedyCodeId?: string | null;
  readonly note?: string | null;
  readonly baseVersion: string | null;
  /** The evidence this completion cites must reach the server first (§8.3). */
  readonly dependsOnClientId?: string | null;
}): MutationSpec {
  return {
    entity: "job_outcome",
    op: "record",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      outcomeCode: input.outcomeCode,
      ...optional("visitId", input.visitId),
      ...optional("symptomCodeId", input.symptomCodeId),
      ...optional("causeCodeId", input.causeCodeId),
      ...optional("remedyCodeId", input.remedyCodeId),
      ...optional("note", input.note),
    },
    baseVersion: input.baseVersion,
    dependsOnClientId: input.dependsOnClientId ?? null,
  };
}

// ── Attachments and signatures cite an UPLOAD, never a storage key ──────────

/**
 * `job_attachment/append`.
 *
 * ── WHY `uploadId` AND NOT `storageKey` ────────────────────────────────────
 *
 * An earlier version of this contract took the key from the payload. That let
 * a handset file an attachment against its own job pointing at **any** object
 * in the tenant - a candidate's passport scan, a signed contract - which the
 * job card would then render to the customer. `recordJobAttachment` could
 * never have caught it: a key is a string, and by the time it arrives the
 * question of who was allowed to produce it is gone.
 *
 * The server now resolves the key from the upload row and checks that the
 * upload was opened for this job by this technician. The device therefore
 * cannot name an object it did not create, which is a property no amount of
 * validation on a string could have given it.
 *
 * `mimeType`, `sizeBytes`, `capturedAt` and the coordinates are **not sent**.
 * The pipeline sniffed the bytes and extracted EXIF into columns; the phone
 * only ever guessed at them. Sending them would be ignored, and sending a
 * value that is ignored is how a reader comes to believe it matters.
 */
export function appendAttachment(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  /** `photo_before` | `photo_after` | ... - the server's `job_attachments.kind`. */
  readonly kind: string;
  readonly uploadId: string;
  readonly caption?: string | null;
  /** The upload must have completed before this is applied. */
  readonly dependsOnClientId?: string | null;
}): MutationSpec {
  return {
    entity: "job_attachment",
    op: "append",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      kind: input.kind,
      uploadId: input.uploadId,
      ...optional("visitId", input.visitId),
      ...optional("caption", input.caption),
    },
    // Append-only: nothing can make it stale (§8.4).
    baseVersion: null,
    dependsOnClientId: input.dependsOnClientId ?? null,
  };
}

/** `job_signature/record`. Cites the upload, for the same reason. */
export function recordSignature(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly uploadId: string;
  readonly signedByName: string;
  readonly signedByRole?: string | null;
  readonly satisfactionRating?: number | null;
  readonly comments?: string | null;
  readonly dependsOnClientId?: string | null;
}): MutationSpec {
  return {
    entity: "job_signature",
    op: "record",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      uploadId: input.uploadId,
      signedByName: input.signedByName,
      ...optional("visitId", input.visitId),
      ...optional("signedByRole", input.signedByRole),
      ...optional("satisfactionRating", input.satisfactionRating),
      ...optional("comments", input.comments),
    },
    baseVersion: null,
    dependsOnClientId: input.dependsOnClientId ?? null,
  };
}

// ── Materials ───────────────────────────────────────────────────────────────

export function appendMaterial(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly sku?: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly source: string;
  readonly serialNumber?: string | null;
}): MutationSpec {
  return {
    entity: "job_material",
    op: "append",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      description: input.description,
      quantity: input.quantity,
      unit: input.unit,
      source: input.source,
      ...optional("visitId", input.visitId),
      ...optional("sku", input.sku),
      ...optional("serialNumber", input.serialNumber),
    },
    baseVersion: null,
    dependsOnClientId: null,
  };
}

/**
 * `job_material/declare_none` - a positive act, not an empty array.
 *
 * The server deletes the declaration when a part is recorded and refuses the
 * declaration when lines exist, so a client that inferred "none" from an empty
 * local list would fight it on every sync. `canDeclareNoMaterials()` in
 * `domain/job-card.ts` is the guard; this is what it guards.
 */
export function declareNoMaterials(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly note?: string | null;
}): MutationSpec {
  return {
    entity: "job_material",
    op: "declare_none",
    jobId: input.jobId,
    payload: { jobId: input.jobId, ...optional("visitId", input.visitId), ...optional("note", input.note) },
    baseVersion: null,
    dependsOnClientId: null,
  };
}

// ── The after-photo exemption ───────────────────────────────────────────────

/**
 * `job_photo/exempt`. **`reasonCode` is required and free text is refused.**
 *
 * The code comes from `taxonomies.photoExemptionReasons`, which is
 * `job_photo_exemption_reasons` - five seeded per tenant, read by
 * `listPhotoExemptionReasons(tx)`. The device holds no vocabulary of its own,
 * so a picker that is empty means the taxonomy has not synced, not that there
 * are no reasons.
 */
export function exemptFromPhoto(input: {
  readonly jobId: string;
  readonly reasonCode: string;
  readonly note?: string | null;
}): MutationSpec {
  if (!input.reasonCode.trim()) {
    throw new Error("A photo exemption needs a reason code from the office's list, not free text.");
  }
  return {
    entity: "job_photo",
    op: "exempt",
    jobId: input.jobId,
    payload: { jobId: input.jobId, reasonCode: input.reasonCode, ...optional("note", input.note) },
    baseVersion: null,
    dependsOnClientId: null,
  };
}

// ── Labour ──────────────────────────────────────────────────────────────────

/**
 * `visit_labour/record`.
 *
 * **`workMinutes: 0` is legal and meaningful**; absent or null is refused.
 * A no-access visit spent no time on the tools, and collapsing a recorded zero
 * into "not recorded" turns a satisfied `JOB-15` condition into a gap. The
 * type below takes `number`, not `number | null`, so the collapse cannot be
 * expressed - `labourToRecord()` in `domain/attendance.ts` is where the
 * null-vs-zero decision is made, and a null never reaches here.
 */
export function recordLabour(input: {
  readonly jobId: string;
  readonly visitId: string | null;
  readonly workMinutes: number;
  readonly travelMinutes?: number | null;
  readonly overrideReason?: string | null;
}): MutationSpec {
  if (!Number.isFinite(input.workMinutes)) {
    throw new Error("Labour must be a recorded number of minutes. Zero is allowed; nothing is not.");
  }
  return {
    entity: "visit_labour",
    op: "record",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      workMinutes: input.workMinutes,
      ...optional("visitId", input.visitId),
      ...optional("travelMinutes", input.travelMinutes),
      ...optional("overrideReason", input.overrideReason),
    },
    baseVersion: null,
    dependsOnClientId: null,
  };
}

// ── Notes, and the recommendation that lives inside one ─────────────────────

/**
 * `job_note/upsert`.
 *
 * **`FLD-12`'s recommendation is a field of this**, not a mutation of its own.
 * An earlier draft of this workspace had a `job_recommendation` entity and a
 * local table to match; the server has no such thing, and a capture surface
 * with no sync path loses a technician's work silently - which for `FLD-12`
 * means losing the single highest-value field on the form.
 *
 * ── THE PHOTOGRAPH, AND WHY IT IS ONE MORE OPTIONAL FIELD ──────────────────
 *
 * `FLD-12` is "a free field **with an optional photo** that raises a lead".
 * The text lands in `job_reports`; the photograph used to have nowhere to go —
 * `job_attachments.kind` was constrained to `photo_before | photo_after |
 * signature | document | video` by a CHECK in migration `0025` and by
 * `JOB_ATTACHMENT_KINDS` in `packages/db/src/domain/jobcard.ts`, and a
 * recommendation photo was none of those. Filing it as `document` with a
 * caption would have been the free-text anti-pattern this codebase rejects
 * everywhere else.
 *
 * `0025` was widened to a sixth kind by `0034`, so the field this comment used
 * to describe as agreed-but-not-yet-possible now exists and is sent:
 *
 *     recommendationUploadId?: string
 *
 * The server (`handleJobNote` in `packages/db/src/domain/field.ts`) resolves
 * it through the same `resolveDeviceUpload` check every other attachment goes
 * through — this technician's upload, for this job, finished — and files it as
 * a `photo_recommendation` attachment in the same transaction, indeed the same
 * savepoint, as the note. The association is therefore causal and recorded,
 * never inferred later by whoever reads the lead from a timestamp or from
 * proximity to the text.
 *
 * `job_cards.recommendation_photo_client_id` on the device still holds the
 * *local* photo's client id until the capture-and-upload pipeline resolves it
 * to a server `uploadId` — that pipeline is not built in this session (see
 * `db/schema.ts`) — but this builder no longer has anything left to invent
 * once it does: it takes the resolved upload id and sends it.
 */
export function upsertNote(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly faultFound?: string | null;
  readonly workCarriedOut?: string | null;
  readonly recommendation?: string | null;
  readonly rawNotes?: string | null;
  /** The recommendation photo's server upload id, once uploaded. Never a key. */
  readonly recommendationUploadId?: string | null;
  readonly baseVersion: string | null;
}): MutationSpec {
  return {
    entity: "job_note",
    op: "upsert",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      ...optional("visitId", input.visitId),
      ...optional("faultFound", input.faultFound),
      ...optional("workCarriedOut", input.workCarriedOut),
      ...optional("recommendation", input.recommendation),
      ...optional("rawNotes", input.rawNotes),
      ...optional("recommendationUploadId", input.recommendationUploadId),
    },
    // Free-text scalar: last-write-wins with the loser preserved (§8.4).
    baseVersion: input.baseVersion,
    dependsOnClientId: null,
  };
}

// ── Attendance ──────────────────────────────────────────────────────────────

export function appendAttendance(input: {
  readonly kind: string;
  readonly jobId?: string | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
  readonly accuracyMetres?: number | null;
}): MutationSpec {
  return {
    entity: "attendance",
    op: "append",
    jobId: input.jobId ?? null,
    payload: {
      kind: input.kind,
      ...optional("jobId", input.jobId),
      ...optional("lat", input.lat),
      ...optional("lng", input.lng),
      ...optional("accuracyMetres", input.accuracyMetres),
    },
    baseVersion: null,
    dependsOnClientId: null,
  };
}

/**
 * Omit rather than send null.
 *
 * The two are not equivalent to a server that treats an absent key as "leave
 * it alone" and a null as "clear it" - and `job_note/upsert` does exactly
 * that, which is how a technician's typed note gets blanked by a screen that
 * helpfully sent every field it had.
 */
function optional(key: string, value: unknown): Record<string, unknown> {
  return value === null || value === undefined ? {} : { [key]: value };
}
