import { check, equal, deepEqual, done } from "./_harness";
import {
  canAttemptCompletion,
  canDeclareNoMaterials,
  completionReadiness,
  gapMessage,
  interpretRefusal,
  recordingMaterialClearsDeclaration,
  refusalDisposition,
  attachmentKindForPhotoRole,
  isPhotoRole,
  PHOTO_ROLES,
  PHOTO_ROLE_ATTACHMENT_KIND,
  type CapturedPhoto,
  type JobCardDraft,
  type PhotoRole,
} from "../src/domain/job-card";
import { JOB_ATTACHMENT_KINDS, isJobAttachmentKind } from "@meridian/core";
import {
  deriveLabour,
  isLabourRecorded,
  labourToRecord,
  safetyGaps,
  startWorkRefusal,
  nextTimingEvents,
  type SafetyAcknowledgement,
  type SafetyRequirement,
  type TimingEvent,
} from "../src/domain/attendance";
import { canonicalSheet, canCloseWithoutSignature, isLocked, CONSENT_STATEMENT_V1 } from "../src/domain/signature";

const stamp = (iso: string, monotonic: number) => ({
  recordedOfflineAt: iso,
  monotonicAt: monotonic,
  deviceOffsetMsAtCapture: null,
  serverReceivedAt: null,
});

function photo(role: CapturedPhoto["role"]): CapturedPhoto {
  return {
    clientId: `p-${role}`,
    jobId: "job-1",
    role,
    localUri: "file:///x.jpg",
    originalUri: null,
    thumbnailUri: null,
    stamp: stamp("2026-08-21T10:00:00.000Z", 1),
    capturedLat: null,
    capturedLng: null,
    caption: null,
    uploadState: "queued",
    uploadId: null,
    scanStatus: null,
  };
}

function draft(overrides: Partial<JobCardDraft> = {}): JobCardDraft {
  return {
    jobId: "job-1",
    fault: { reportedFault: "No cooling", symptom: null, cause: null, remedy: null, diagnosisNote: null },
    workCarriedOut: null,
    photos: [],
    photoExemptionCode: null,
    photoExemptionNote: null,
    materials: [],
    materialsDeclaredNone: null,
    labour: { travelMinutes: 0, workMinutes: 0, pausedMinutes: 0, incomplete: true },
    labourOverride: null,
    outcomeCode: null,
    recommendation: null,
    ...overrides,
  };
}

// ── JOB-15 is the SERVER's answer, rendered ─────────────────────────────────
//
// The device computes nothing here. `gaps` arrives on every sync from the same
// getJobCard() the web panel reads. What is tested is that all three of its
// states stay distinct, because collapsing any two is how a screen ends up
// lying about a job.

equal("a job the server has not ruled on is unknown", completionReadiness(undefined).state, "unknown");
equal("a job not at a completable stage is not_applicable", completionReadiness(null).state, "not_applicable");
equal("an empty gap list means the server says it is ready", completionReadiness([]).state, "ready");
equal("a populated one means work is outstanding", completionReadiness(["labour"]).state, "outstanding");

// The distinction that matters most: null is NOT "nothing is missing".
check("null does not read as ready", !canAttemptCompletion(null));
check("nor does an unsynced job", !canAttemptCompletion(undefined));
check("only an explicit empty list does", canAttemptCompletion([]));
check("and never one with gaps", !canAttemptCompletion(["after_photo"]));

const outstanding = completionReadiness(["after_photo", "labour"]);
deepEqual(
  "the gaps are rendered in the server's order, not re-sorted",
  outstanding.state === "outstanding" ? outstanding.codes : [],
  ["after_photo", "labour"],
);
check(
  "each becomes a sentence the technician can act on",
  outstanding.state === "outstanding" && outstanding.messages[0]!.includes("after"),
);

// A gap code from a newer server must still reach the screen.
check(
  "an unknown gap code is shown rather than dropped",
  gapMessage("asbestos_register_not_checked").includes("asbestos_register_not_checked"),
);
check("and tells the technician what to do about it", gapMessage("something_new").includes("Call them"));

// ── The shape of what gets sent ─────────────────────────────────────────────
//
// "No materials" is a positive declaration in `job_card_declarations`, not an
// empty array, and the server refuses it when lines exist.

const blank = draft();
check("a card with no lines and no declaration may declare none", canDeclareNoMaterials(blank));

const withLines = draft({
  materials: [
    {
      clientId: "m1",
      sku: null,
      description: "Contactor 40A",
      quantity: "1",
      unit: "ea",
      source: "van_stock",
      serialNumber: null,
      needsOfficeReconciliation: true,
    },
  ],
});
check("a card with a part may not declare none - the server refuses it", !canDeclareNoMaterials(withLines));

const alreadyDeclared = draft({ materialsDeclaredNone: { at: "2026-08-21T11:00:00.000Z", note: null } });
check("declaring none twice is not offered", !canDeclareNoMaterials(alreadyDeclared));
check(
  "and recording a part must clear the declaration, as the server does",
  recordingMaterialClearsDeclaration(alreadyDeclared),
);
check("with nothing to clear when none was declared", !recordingMaterialClearsDeclaration(blank));

// ── FLD-4: the safety gate ──────────────────────────────────────────────────

const requirement: SafetyRequirement = {
  ramsRequired: true,
  requiredPpeCodes: ["gloves", "eye"],
  permitRequired: true,
};
const nothingDone: SafetyAcknowledgement = {
  ramsVersion: null,
  ramsAcknowledgedAt: null,
  ppeConfirmed: [],
  ppeAcknowledgedAt: null,
  permitReference: null,
};
deepEqual("all three gates are shut", safetyGaps(requirement, nothingDone), ["rams", "ppe", "permit"]);
check("and work cannot start", startWorkRefusal(requirement, nothingDone) !== null);

const partial: SafetyAcknowledgement = {
  ramsVersion: "v3",
  ramsAcknowledgedAt: "2026-08-21T09:50:00.000Z",
  ppeConfirmed: ["gloves"],
  ppeAcknowledgedAt: "2026-08-21T09:51:00.000Z",
  permitReference: "PTW-4471",
};
deepEqual("confirming only some PPE does not open the gate", safetyGaps(requirement, partial), ["ppe"]);

const allDone: SafetyAcknowledgement = { ...partial, ppeConfirmed: ["gloves", "eye"] };
equal("with everything recorded, work may start", startWorkRefusal(requirement, allDone), null);

const noPermitNeeded: SafetyRequirement = { ramsRequired: true, requiredPpeCodes: [], permitRequired: false };
equal(
  "a job needing no permit is not blocked on one",
  startWorkRefusal(noPermitNeeded, { ...nothingDone, ramsAcknowledgedAt: "2026-08-21T09:50:00.000Z" }),
  null,
);

deepEqual("a visit starts en route or on arrival", nextTimingEvents(null), ["en_route", "arrived"]);
deepEqual("work can only start after arriving", nextTimingEvents("arrived"), ["started_work", "departed"]);
deepEqual("nothing follows departure", nextTimingEvents("departed"), []);

// ── FLD-10: labour from the event stream ────────────────────────────────────

function event(kind: TimingEvent["kind"], iso: string, monotonic: number): TimingEvent {
  return {
    clientId: `e-${monotonic}`,
    jobId: "job-1",
    visitId: null,
    kind,
    stamp: stamp(iso, monotonic),
    geo: null,
    pauseReason: null,
    note: null,
  };
}

const split = deriveLabour([
  event("en_route", "2026-08-21T08:00:00.000Z", 1),
  event("arrived", "2026-08-21T08:25:00.000Z", 2),
  event("started_work", "2026-08-21T08:30:00.000Z", 3),
  event("paused", "2026-08-21T09:00:00.000Z", 4),
  event("resumed", "2026-08-21T09:30:00.000Z", 5),
  event("departed", "2026-08-21T10:15:00.000Z", 6),
]);
equal("travel time is the en-route interval", split.travelMinutes, 25);
equal("work time excludes the pause", split.workMinutes, 75);
equal("the pause is kept rather than dropped", split.pausedMinutes, 30);
check("a departed visit is complete", !split.incomplete);

const stillOnSite = deriveLabour([
  event("arrived", "2026-08-21T08:25:00.000Z", 1),
  event("started_work", "2026-08-21T08:30:00.000Z", 2),
]);
check("a visit with no departure is marked incomplete", stillOnSite.incomplete);

// A technician who winds the clock back must not manufacture negative time.
const tampered = deriveLabour([
  event("started_work", "2026-08-21T10:00:00.000Z", 1),
  event("departed", "2026-08-21T08:00:00.000Z", 2),
]);
equal("a backwards clock yields zero, never negative minutes", tampered.workMinutes, 0);

// Events arriving out of order still compute correctly - the monotonic reading
// is what orders them, not the array.
const shuffled = deriveLabour([
  event("departed", "2026-08-21T10:15:00.000Z", 6),
  event("started_work", "2026-08-21T08:30:00.000Z", 3),
  event("arrived", "2026-08-21T08:25:00.000Z", 2),
  event("en_route", "2026-08-21T08:00:00.000Z", 1),
]);
equal("a shuffled stream is ordered before it is measured", shuffled.travelMinutes, 25);
equal("and the work interval is right", shuffled.workMinutes, 105);

// ── FLD-10: labour is per visit, and zero is not null ───────────────────────

const noAccessVisit = deriveLabour([
  event("en_route", "2026-08-21T08:00:00.000Z", 1),
  event("arrived", "2026-08-21T08:25:00.000Z", 2),
  // No `started_work`: nobody could get in.
  event("departed", "2026-08-21T08:35:00.000Z", 3),
]);
const noAccessRecord = labourToRecord(noAccessVisit, null);
equal("a no-access visit records a genuine zero on the tools", noAccessRecord.workMinutes, 0);
equal("with the travel time it really cost", noAccessRecord.travelMinutes, 25);
check("and counts as recorded - zero is an answer", isLabourRecorded(noAccessRecord));
equal("derived from the events, not typed", noAccessRecord.source, "derived");

const stillWorking = labourToRecord(
  deriveLabour([
    event("arrived", "2026-08-21T08:25:00.000Z", 1),
    event("started_work", "2026-08-21T08:30:00.000Z", 2),
  ]),
  null,
);
equal("a visit still in progress records nothing", stillWorking.workMinutes, null);
check("and is NOT counted as recorded - null is not zero", !isLabourRecorded(stillWorking));
equal("which the screen can tell apart from a real zero", stillWorking.source, "not_recorded");

// An override rescues a visit whose event stream never closed.
const unfinished = deriveLabour([
  event("arrived", "2026-08-21T08:25:00.000Z", 1),
  event("started_work", "2026-08-21T08:30:00.000Z", 2),
]);
const overridden = labourToRecord(unfinished, { workMinutes: 90, reason: "Phone died; timing lost." });
equal("an override supplies a figure the events could not", overridden.workMinutes, 90);
equal("and is marked as the technician's, not the events'", overridden.source, "override");
equal("carrying the reason FLD-10 requires", overridden.overrideReason, "Phone died; timing lost.");
check("and counts as recorded", isLabourRecorded(overridden));

const overriddenZero = labourToRecord(split, { workMinutes: 0, reason: "Attended, no work needed." });
equal("a technician may override to zero", overriddenZero.workMinutes, 0);
check("and it still counts as recorded", isLabourRecorded(overriddenZero));

// ── The server's refusal, rendered ──────────────────────────────────────────

const refusal = interpretRefusal({
  clientId: "c1",
  message: "This job card is not complete.",
  gaps: ["after_photo", "labour"],
});
deepEqual("known gaps are recognised so the screen can route to a section", refusal.known, ["after_photo", "labour"]);
equal("and every gap becomes a sentence", refusal.messages.length, 2);
check("with wording the technician can act on", refusal.messages[0]!.includes("after"));

const partlyUnknown = interpretRefusal({
  clientId: "c1",
  message: "This job card is not complete.",
  gaps: ["after_photo", "asbestos_register_not_checked"],
});
deepEqual("a gap this build has never heard of survives", partlyUnknown.unknown, ["asbestos_register_not_checked"]);
deepEqual("alongside the ones it knows", partlyUnknown.known, ["after_photo"]);
equal("and both reach the screen", partlyUnknown.messages.length, 2);

const proseOnly = interpretRefusal({ clientId: "c1", message: "The office refused this." });
check("a refusal with no gap list falls back to the server's prose", proseOnly.proseOnly);
deepEqual("showing exactly what the server said", proseOnly.messages, ["The office refused this."]);

equal(
  "a refusal holds the card for the technician rather than rolling back",
  refusalDisposition({ clientId: "c1", message: "not complete" }),
  "hold_for_technician",
);

// ── FLD-13/14: the sheet hash and the unsigned path ─────────────────────────

const sheet = {
  jobReference: "JOB-2026-04821",
  customerName: "Marina Towers Owners Association",
  propertyAddress: "Tower 2, Dubai Marina",
  reportedFault: "No cooling in the lobby",
  diagnosedFault: "Failed contactor",
  workCarriedOut: "Replaced contactor\nTested operation",
  materials: [{ description: "Contactor 40A", quantity: "1", unit: "ea" }],
  labourMinutes: 75,
  outcomeLabel: "Completed",
  technicianName: "A. Technician",
  recordedOfflineAt: "2026-08-21T10:15:00.000Z",
  consent: CONSENT_STATEMENT_V1,
};

const canonical = canonicalSheet(sheet);
equal("canonicalisation is deterministic", canonical, canonicalSheet(sheet));
check("newlines inside a field are flattened", !canonical.includes("Replaced contactor\nTested"));
check("the consent version is part of what is signed", canonical.includes(CONSENT_STATEMENT_V1.version));
check("and so is the consent text", canonical.includes("we do not analyse how you sign"));

const tweaked = canonicalSheet({ ...sheet, labourMinutes: 76 });
check("changing one minute changes the canonical form", tweaked !== canonical);

const reordered = canonicalSheet({
  ...sheet,
  materials: [
    { description: "Contactor 40A", quantity: "1", unit: "ea" },
    { description: "Cable tie", quantity: "4", unit: "ea" },
  ],
});
check("adding a material changes what was signed", reordered !== canonical);

check("a job is not locked before it is signed", !isLocked(null, null));
check("a signed job is locked", isLocked("2026-08-21T10:20:00.000Z", null));

const attestation = {
  clientId: "a1",
  jobId: "job-1",
  reason: "customer_not_available" as const,
  note: "Site locked at 17:00; security would not sign.",
  attestedBySupervisorId: null,
  stamp: stamp("2026-08-21T17:05:00.000Z", 9),
};
check("an attested unsigned visit can close", canCloseWithoutSignature(attestation));
check("an unsigned visit with no note cannot", !canCloseWithoutSignature({ ...attestation, note: "  " }));
check("nor can one with no attestation at all", !canCloseWithoutSignature(null));
check("an attested visit locks the record too", isLocked(null, attestation));

// ── FLD-7: a photo's ROLE and an attachment's KIND, and the map between ─────
//
// Two vocabularies, deliberately. A role says what is in the frame; a kind says
// what the row is evidence of. They do not even share a spelling — the handset
// says `before`, `job_attachments.kind` says `photo_before` — and nothing
// mapped between them for as long as no photograph had ever crossed the wire.
//
// These checks are the contract that mapping has to keep. The exhaustiveness
// half is the compiler's (`Record<PhotoRole, JobAttachmentKind>` in
// `@meridian/core`, so an eighth role does not build until somebody decides
// where it goes); what a type cannot say is *which* kind is right, and that is
// what is asserted here.

check(
  "every role in the picker is a key of the map, and vice versa",
  [...PHOTO_ROLES].sort().join(",") === Object.keys(PHOTO_ROLE_ATTACHMENT_KIND).sort().join(","),
);

// The whole mapping, restated independently. Asserting each role against
// `attachmentKindForPhotoRole(role)` would be asserting the map against itself
// - true for any map, including a wrong one - so the expected destinations are
// written out here and compared wholesale. Every entry below is a decision, and
// changing one in `core` without changing it here is meant to fail.
deepEqual("each role has the destination it was decided to have", PHOTO_ROLE_ATTACHMENT_KIND, {
  before: "photo_before",
  after: "photo_after",
  defect: "photo_before",
  serial_plate: "photo_before",
  meter_reading: "photo_before",
  parts_used: "photo_before",
  site_access: "photo_before",
});

for (const role of PHOTO_ROLES) {
  check(
    `a ${role} photograph has a destination the server accepts`,
    isJobAttachmentKind(attachmentKindForPhotoRole(role)),
  );
}

// The load-bearing assertion. `photo_after` is not "taken later" - it is the
// one kind `assertJobCardComplete` counts as evidence the work was done. A
// picture of a box of parts or a meter dial reaching it would satisfy JOB-15
// with no photograph of the finished work on file, which is exactly the failure
// 0025's CHECK was added to prevent, arriving from the client instead.
const afterProducing = PHOTO_ROLES.filter((r) => attachmentKindForPhotoRole(r) === "photo_after");
deepEqual("only the 'after' role produces JOB-15's evidence kind", afterProducing, ["after"]);
equal("and 'before' produces the kind that justifies the work", attachmentKindForPhotoRole("before"), "photo_before");

// Three kinds are unreachable from a photograph on a handset, each for its own
// reason: FLD-12's recommendation photo is filed only by `job_note/upsert` in
// the same savepoint as the note it illustrates; `document` is the free-text
// bucket 0034 refused to reuse; `signature` has its own mutation and table.
for (const closed of ["photo_recommendation", "document", "signature", "video"] as const) {
  check(
    `no role files a photograph as ${closed}`,
    !PHOTO_ROLES.some((r) => attachmentKindForPhotoRole(r) === closed),
  );
}

// The two vocabularies must not be confusable at runtime either. A build that
// accepted the server's spelling as a role, or a role as a kind, would put the
// bug back where it started with the types still green.
for (const kind of JOB_ATTACHMENT_KINDS) {
  check(`the server's "${kind}" is not a photo role`, !isPhotoRole(kind));
}
for (const role of PHOTO_ROLES) {
  check(`the handset's "${role}" is not an attachment kind`, !isJobAttachmentKind(role));
}

check("an unrecognised role is not narrowed into the union", !isPhotoRole("selfie"));
check("nor is a missing one", !isPhotoRole(null));

// `CapturedPhoto.role` is nullable because `job_photos.role` is a plain text
// column: a role this build cannot read has no destination kind, and there is
// no default that would not amount to this app deciding what a photograph is
// of. The draft carries the null rather than a guess.
const unreadable: CapturedPhoto = { ...photo("before"), role: null };
equal("a photograph whose role could not be read carries null, not a default", unreadable.role, null);

// A guard that keeps the mapping honest as the union grows: the `never` here
// only type-checks while every role is accounted for by the map above.
const exhaustive: (r: PhotoRole) => string = (r) => PHOTO_ROLE_ATTACHMENT_KIND[r];
equal("the map is indexable by every member of the union", exhaustive("site_access"), "photo_before");

done("jobcard");
