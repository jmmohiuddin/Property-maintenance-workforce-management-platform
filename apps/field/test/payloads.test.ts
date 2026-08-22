import { check, equal, deepEqual, done } from "./_harness";
import {
  FIELD_SETTABLE_STATUSES,
  UnavailableFromTheFieldError,
  appendAttachment,
  appendAttendance,
  appendMaterial,
  declareNoMaterials,
  exemptFromPhoto,
  isFieldSettableStatus,
  recordLabour,
  recordOutcome,
  recordSignature,
  transition,
  upsertNote,
} from "../src/sync/payloads";
import { attachmentKindForPhotoRole, PHOTO_ROLES } from "../src/domain/job-card";
import { isKnownMutationKind, mutationKind } from "../src/sync/protocol";
import { needsBaseVersion } from "../src/sync/conflicts";
import type { FieldMutationKind } from "../src/sync/protocol";

// Every builder must produce a kind the server's closed list accepts.
const built = [
  transition({ jobId: "j1", to: "on_site", baseVersion: null }),
  recordOutcome({ jobId: "j1", outcomeCode: "completed", baseVersion: null }),
  appendAttachment({ jobId: "j1", kind: "photo_after", uploadId: "u1" }),
  appendMaterial({ jobId: "j1", description: "Contactor", quantity: "1", unit: "ea", source: "van_stock" }),
  declareNoMaterials({ jobId: "j1" }),
  exemptFromPhoto({ jobId: "j1", reasonCode: "photography_prohibited" }),
  recordLabour({ jobId: "j1", visitId: "v1", workMinutes: 0 }),
  recordSignature({ jobId: "j1", uploadId: "u2", signedByName: "A. Customer" }),
  upsertNote({ jobId: "j1", workCarriedOut: "Replaced contactor", baseVersion: null }),
  appendAttendance({ kind: "shift_in", occurredAt: "2026-08-22T06:00:00.000Z" }),
];

for (const spec of built) {
  const kind = mutationKind(spec.entity, spec.op);
  check(`${kind} is a kind the server accepts`, isKnownMutationKind(spec.entity, spec.op));
  check(`${kind} carries a baseVersion only if its data class needs one`,
    (spec.baseVersion !== null) === false || needsBaseVersion(kind as FieldMutationKind));
}

// ── work_complete cannot be sent from a phone ───────────────────────────────
//
// JOB-15's gate is in recordJobOutcome, not transitionJob, and
// `on_site -> work_complete` checks nothing about the job card. A bare status
// change would have completed jobs with empty cards from the least observable
// client in the estate.

deepEqual("the settable statuses are the server's allow-list", [...FIELD_SETTABLE_STATUSES], [
  "en_route",
  "on_site",
  "paused",
]);
check("en_route may be set", isFieldSettableStatus("en_route"));
check("on_site may be set", isFieldSettableStatus("on_site"));
check("paused may be set", isFieldSettableStatus("paused"));
check("work_complete may NOT be set", !isFieldSettableStatus("work_complete"));
check("nor may signed_off", !isFieldSettableStatus("signed_off"));
check("nor cancelled", !isFieldSettableStatus("cancelled"));

let refusedCompletion: unknown = null;
try {
  transition({ jobId: "j1", to: "work_complete", baseVersion: null });
} catch (error) {
  refusedCompletion = error;
}
check("building a work_complete transition throws", refusedCompletion instanceof UnavailableFromTheFieldError);
check(
  "and the message points at the job card instead of just refusing",
  refusedCompletion instanceof Error && refusedCompletion.message.includes("sending the job card"),
);

// ── Attachments cite an upload, never a storage key ─────────────────────────

const attachment = appendAttachment({ jobId: "j1", kind: "photo_after", uploadId: "u1", caption: "After" });
equal("the attachment cites the upload id", attachment.payload["uploadId"], "u1");
check("and carries no storage key", !("storageKey" in attachment.payload));
// The pipeline sniffed the bytes and extracted EXIF into columns; the phone
// only ever guessed at these, and a value that is ignored teaches a reader it
// matters.
for (const guessed of ["mimeType", "sizeBytes", "capturedAt", "capturedLat", "capturedLon"]) {
  check(`the phone does not send ${guessed} - the server extracted it`, !(guessed in attachment.payload));
}
equal("an attachment is append-only, so it carries no baseVersion", attachment.baseVersion, null);

// A photograph's kind comes from the role it was taken with, not from a literal
// typed at the call site. `kind` was a bare `string` here with the six
// permitted values written out in a doc comment, which let this builder compose
// a payload `recordJobAttachment` always refuses - hours later, in a plant
// room. The union is `@meridian/core`'s now, so the compiler refuses it here.
// The destinations themselves are asserted in `jobcard.test.ts`, against a
// table written out by hand - comparing them to `attachmentKindForPhotoRole`
// here would be comparing the map to itself. What this checks is the seam: the
// builder carries the mapped kind onto the wire unaltered, for every role, and
// produces a mutation kind the server's closed list accepts.
for (const role of PHOTO_ROLES) {
  const filed = appendAttachment({ jobId: "j1", kind: attachmentKindForPhotoRole(role), uploadId: "u1" });
  check(
    `job_attachment/append is a kind the server accepts for a ${role} photograph`,
    isKnownMutationKind(filed.entity, filed.op),
  );
}
equal(
  "a photograph of the parts fitted goes on the wire as photo_before",
  appendAttachment({ jobId: "j1", kind: attachmentKindForPhotoRole("parts_used"), uploadId: "u1" }).payload["kind"],
  "photo_before",
);
equal(
  "and only the finished work goes on as photo_after",
  appendAttachment({ jobId: "j1", kind: attachmentKindForPhotoRole("after"), uploadId: "u1" }).payload["kind"],
  "photo_after",
);

const signature = recordSignature({ jobId: "j1", uploadId: "u2", signedByName: "A. Customer" });
equal("a signature cites the upload id too", signature.payload["uploadId"], "u2");
check("and no storage key", !("storageKey" in signature.payload));

// ── Labour: zero is an answer ───────────────────────────────────────────────

const zero = recordLabour({ jobId: "j1", visitId: "v1", workMinutes: 0 });
equal("a recorded zero is sent as zero", zero.payload["workMinutes"], 0);
check("and the key is present, not omitted", "workMinutes" in zero.payload);

let refusedLabour = false;
try {
  recordLabour({ jobId: "j1", visitId: "v1", workMinutes: Number.NaN });
} catch {
  refusedLabour = true;
}
check("a non-number is refused rather than sent as null", refusedLabour);

// ── The exemption needs a code from the office's list ───────────────────────

const exempt = exemptFromPhoto({ jobId: "j1", reasonCode: "customer_refused" });
equal("the exemption carries a reason code", exempt.payload["reasonCode"], "customer_refused");

let refusedExemption = false;
try {
  exemptFromPhoto({ jobId: "j1", reasonCode: "   " });
} catch {
  refusedExemption = true;
}
check("free text is refused before it reaches the wire", refusedExemption);

// ── The recommendation is a field of the note ───────────────────────────────

const note = upsertNote({
  jobId: "j1",
  workCarriedOut: "Replaced contactor",
  recommendation: "Compressor is noisy; quote a replacement.",
  baseVersion: "2026-08-21T09:00:00.000Z",
});
equal("FLD-12's recommendation rides on job_note/upsert", note.entity, "job_note");
equal("carrying the text", note.payload["recommendation"], "Compressor is noisy; quote a replacement.");
equal("a note is a free-text scalar, so it carries a baseVersion", note.baseVersion, "2026-08-21T09:00:00.000Z");

// ── The recommendation photo rides the same mutation, once resolved ────────
//
// `0034` gave the server a sixth `job_attachments.kind`, `photo_recommendation`,
// and `recommendationUploadId` is the one field that carries it — never a
// storage key, same as every other attachment on the wire.
const noteWithPhoto = upsertNote({
  jobId: "j1",
  recommendation: "Compressor is noisy; quote a replacement.",
  recommendationUploadId: "u9",
  baseVersion: null,
});
equal(
  "a recommendation photo cites an upload id, not a storage key",
  noteWithPhoto.payload["recommendationUploadId"],
  "u9",
);
check(
  "and nothing named storageKey ever reaches this payload",
  !("storageKey" in noteWithPhoto.payload) && !("recommendationStorageKey" in noteWithPhoto.payload),
);

// ── Omitted, not null ───────────────────────────────────────────────────────
//
// An absent key means "leave it alone" and a null means "clear it". A screen
// that helpfully sent every field it had would blank a technician's note.

const sparse = upsertNote({ jobId: "j1", workCarriedOut: "Done", baseVersion: null });
check("an unset field is omitted", !("recommendation" in sparse.payload));
check("rather than sent as null", sparse.payload["recommendation"] === undefined);
check(
  "and the recommendation photo field is omitted when there is no photo",
  !("recommendationUploadId" in sparse.payload),
);
const explicitNull = upsertNote({ jobId: "j1", faultFound: null, baseVersion: null });
check("an explicit null is omitted too", !("faultFound" in explicitNull.payload));

// ── Ordering: the dependency travels with the mutation ──────────────────────

const dependent = recordOutcome({
  jobId: "j1",
  outcomeCode: "completed",
  baseVersion: null,
  dependsOnClientId: "photo-1",
});
equal("a completion can cite the evidence that must land first", dependent.dependsOnClientId, "photo-1");

// The aggregate root is kept locally for the drain planner's grouping and is
// also in the payload, where the server reads it.
equal("the job id is in the payload the server parses", dependent.payload["jobId"], "j1");
equal("and on the spec, for local ordering", dependent.jobId, "j1");

// An attendance event with no job is its own aggregate.
const shift = appendAttendance({ kind: "shift_in", occurredAt: "2026-08-22T06:00:00.000Z" });
equal("a shift event belongs to no job", shift.jobId, null);
check("and does not invent one in the payload", !("jobId" in shift.payload));

// ── TECH-8: withinGeofence ───────────────────────────────────────────────────

const unknownGeofence = appendAttendance({
  kind: "shift_in",
  occurredAt: "2026-08-22T06:00:00.000Z",
  withinGeofence: null,
});
check(
  "an unevaluated geofence (null) is omitted, not sent as a literal null",
  !("withinGeofence" in unknownGeofence.payload),
);

const noGeofenceGiven = appendAttendance({ kind: "shift_in", occurredAt: "2026-08-22T06:00:00.000Z" });
check(
  "omitting withinGeofence entirely behaves the same as passing null",
  !("withinGeofence" in noGeofenceGiven.payload),
);

const insideGeofence = appendAttendance({
  kind: "shift_in",
  occurredAt: "2026-08-22T06:00:00.000Z",
  withinGeofence: true,
});
equal("a known true reaches the payload as true", insideGeofence.payload["withinGeofence"], true);

const outsideGeofence = appendAttendance({
  kind: "shift_in",
  occurredAt: "2026-08-22T06:00:00.000Z",
  withinGeofence: false,
});
check(
  "a known false is NOT dropped - it is a real fact, not an absent one",
  "withinGeofence" in outsideGeofence.payload,
);
equal("and it survives as false, not coerced to true or omitted", outsideGeofence.payload["withinGeofence"], false);

// A clock event with a captured position and no geofence verdict yet - the
// coordinates and the verdict are independent fields.
const positionedNoVerdict = appendAttendance({
  kind: "shift_out",
  occurredAt: "2026-08-22T14:00:00.000Z",
  lat: 25.2048,
  lng: 55.2708,
  accuracyMetres: 12,
  withinGeofence: false,
});
deepEqual("lat/lng/accuracy and withinGeofence all travel independently", positionedNoVerdict.payload, {
  kind: "shift_out",
  occurredAt: "2026-08-22T14:00:00.000Z",
  lat: 25.2048,
  lng: 55.2708,
  accuracyMetres: 12,
  withinGeofence: false,
});

done("payloads");
