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

import type { JobAttachmentKind, MaterialSource } from "@meridian/core";

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
 *
 * ── WHY `kind` IS A UNION AND NOT A `string` ───────────────────────────────
 *
 * It was a `string`, and the six permitted values were listed in this comment.
 * `recordJobAttachment` refuses anything outside them **by name**, so that was
 * one document read twice: this builder could compose a payload the office
 * always rejects, and the rejection would arrive hours later, in a plant room,
 * rather than here at compile time. That is the arrangement that produced
 * `FLD-9` — a vocabulary owned by one end of a wire is a vocabulary the other
 * end can silently disagree with.
 *
 * The union is `@meridian/core`'s, the same declaration `packages/db` now
 * re-exports, so both ends refuse the same six words. A photograph gets its
 * kind from `attachmentKindForPhotoRole(role)` rather than from a literal here:
 * the handset's seven-value `PhotoRole` and the server's six-value kind are two
 * vocabularies, and the mapping between them is written down once, in `core`.
 */
export function appendAttachment(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  /** The server's `job_attachments.kind`. For a photograph, use `attachmentKindForPhotoRole`. */
  readonly kind: JobAttachmentKind;
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

/**
 * `job_material/append` (`FLD-9`).
 *
 * `source` is `MaterialSource` and not `string`. The server validates it with
 * `isMaterialSource` and refuses anything else by name, so a builder that
 * accepted a free string could compose a payload the office always rejects -
 * and it would be rejected hours later in a plant room rather than here at
 * compile time, which is the whole reason these builders exist. The union is
 * `@meridian/core`'s, so both ends refuse the same three words.
 */
export function appendMaterial(input: {
  readonly jobId: string;
  readonly visitId?: string | null;
  readonly sku?: string | null;
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly source: MaterialSource;
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
 *
 * ── AND `visitId` IS REQUIRED FOR THE SAME KIND OF REASON ──────────────────
 *
 * It used to be `string | null`. `optional()` drops a null, and the server's
 * `visit_labour/record` handler reads it with `requireString` - so a null
 * produced a payload the office **always** refuses, from a builder whose type
 * said it was allowed. The outbox would have held it, the drain planner would
 * have sent it, and the technician would have learnt at the end of a shift they
 * had already worked that the hours on it were not filed.
 *
 * Labour is recorded against a visit and not against a job, which is not an
 * accident of the schema: `job_visits.work_minutes` is per visit because a job
 * with two visits has two answers, and `JOB-15`'s labour condition sums them.
 * There is no such thing as time on the tools that belongs to no visit, so the
 * type now says so and the guard below makes the type's promise real for a
 * caller coming from untyped data.
 */
export function recordLabour(input: {
  readonly jobId: string;
  /** Never null: labour belongs to a visit, and the server refuses it without one. */
  readonly visitId: string;
  readonly workMinutes: number;
  readonly travelMinutes?: number | null;
  readonly overrideReason?: string | null;
}): MutationSpec {
  if (!Number.isFinite(input.workMinutes)) {
    throw new Error("Labour must be a recorded number of minutes. Zero is allowed; nothing is not.");
  }
  if (!input.visitId.trim()) {
    throw new Error("Time on the tools is recorded against a visit. This one names none.");
  }
  return {
    entity: "visit_labour",
    op: "record",
    jobId: input.jobId,
    payload: {
      jobId: input.jobId,
      visitId: input.visitId,
      workMinutes: input.workMinutes,
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

/**
 * `attendance/append`. **`occurredAt` is required, and it is required because
 * the server refuses the record without it.**
 *
 * ── HOW THIS WAS MISSED BY TWO GREEN SUITES ────────────────────────────────
 *
 * This builder used to send `{ kind, jobId?, lat?, lng?, accuracyMetres? }` and
 * nothing else. `handleAttendance` in `packages/db/src/domain/field.ts` reads
 * `payload.occurredAt` first and throws *"This attendance record has no usable
 * time on it"* when it is absent - so **every clock-in and clock-out this app
 * could build was rejected**, deterministically, on arrival. The device would
 * have marked each one `dead` and shown the technician an error at the end of a
 * shift they had already worked.
 *
 * Neither suite could see it. `test/payloads.test.ts` asserts that the built
 * spec is a kind the server accepts and that it carries no `jobId`, which is
 * true of a payload the server then refuses; `packages/db/test/field.test.ts`
 * calls `applyFieldMutations` with a payload it composed itself, which of
 * course included the field the handler reads. It took one HTTP request to
 * find - see `test/wire-contract.ts`.
 *
 * The envelope's `recordedOfflineAt` is *not* the same value and could not
 * stand in for it: that is when the row was queued, and a shift that ended in a
 * basement is queued when the phone next has a hand free. `occurredAt` is when
 * the technician actually clocked out. The server keeps both - it corrects this
 * one by the measured skew into `attendance_events.occurred_at` and keeps the
 * raw claim in `recorded_offline_at` - which is the whole two-clock discipline
 * ADR 0004 asks for, and it needs both values to do it.
 *
 * Required rather than defaulted to `new Date().toISOString()`, because a
 * default would be the device's clock at *drain* time silently standing in for
 * its clock at *capture* time, which is the one substitution this protocol
 * exists to prevent.
 */
export function appendAttendance(input: {
  readonly kind: string;
  /** Device wall-clock ISO-8601 of the event itself, not of the queueing. */
  readonly occurredAt: string;
  readonly jobId?: string | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
  readonly accuracyMetres?: number | null;
  /**
   * `TECH-8`. `null` or `undefined` means unknown - no fix, permission
   * refused, or nothing in the working set to compare against - and is
   * **omitted** from the payload like `lat`/`lng`/`accuracyMetres` above:
   * `handleAttendance` reads a missing key as `null` itself, so omitting and
   * sending `null` are the same fact on arrival. A known `false` is not
   * omitted - see below. `domain/geofence.ts` computes this; this builder
   * only carries the answer onto the wire.
   */
  readonly withinGeofence?: boolean | null;
}): MutationSpec {
  if (!input.occurredAt.trim()) {
    throw new Error("An attendance event needs the time it happened, not the time it was sent.");
  }
  return {
    entity: "attendance",
    op: "append",
    jobId: input.jobId ?? null,
    payload: {
      kind: input.kind,
      occurredAt: input.occurredAt,
      ...optional("jobId", input.jobId),
      ...optional("lat", input.lat),
      ...optional("lng", input.lng),
      ...optional("accuracyMetres", input.accuracyMetres),
      // Unlike the other optional fields, a known `false` must reach the
      // server as `false`, not be dropped - `optional()` only omits `null`/
      // `undefined`, so a real "outside the geofence" survives here.
      ...optional("withinGeofence", input.withinGeofence ?? null),
    },
    baseVersion: null,
    dependsOnClientId: null,
  };
}

// ── Location pings (`FLD-16`) ────────────────────────────────────────────────

export interface LocationPingInput {
  readonly lat: number;
  readonly lng: number;
  readonly headingDegrees?: number | null;
  readonly speedKph?: number | null;
  readonly batteryPercent?: number | null;
  /** Device wall-clock ISO-8601 of the fix itself, not of the flush. */
  readonly recordedAt: string;
}

/**
 * `technician_location/append`. **The one mutation whose payload is an array.**
 *
 * Every other builder in this file composes one event. A position is
 * different: `recordTechnicianPing` (`packages/db/src/domain/tracking.ts`)
 * takes a BATCH and dedupes it by `(technician_id, recorded_at)`, because the
 * whole reason continuous tracking is affordable on a phone is that dozens of
 * fixes collected on a walk to the plant room travel as one request instead of
 * one outbox row and one HTTP round trip each. Queuing a mutation the instant
 * `watchPositionAsync` reports a fix would defeat that - see
 * `domain/location-tracking.ts` for the buffer this is built from, and
 * `app/components/LocationSharingTracker.tsx` for what flushes it.
 *
 * `technicianId` is never a field here, for any ping. Every other builder that
 * names an actor at least lets the server check the device's claim
 * (`requireJobForTechnician`); this one gives the device nothing to claim -
 * `handleLocationPing` in `field.ts` stamps every ping in the batch with the
 * authenticated device's own technician. There is no field for a buggy or
 * compromised client to lie in.
 */
export function appendLocationPings(pings: readonly LocationPingInput[]): MutationSpec {
  return {
    entity: "technician_location",
    op: "append",
    // No job: a position belongs to the technician's shift, not to one job -
    // the same reasoning `appendAttendance` gives for its own `jobId: null`.
    jobId: null,
    payload: {
      pings: pings.map((p) => ({
        lat: p.lat,
        lng: p.lng,
        ...optional("headingDegrees", p.headingDegrees ?? null),
        ...optional("speedKph", p.speedKph ?? null),
        ...optional("batteryPercent", p.batteryPercent ?? null),
        recordedAt: p.recordedAt,
      })),
    },
    // Append-only: nothing can make a fix that already landed stale (§8.4).
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
