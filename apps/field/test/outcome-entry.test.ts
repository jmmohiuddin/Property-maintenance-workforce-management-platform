import { check, equal, deepEqual, done } from "./_harness";
import {
  EMPTY_FAULT_CODE_SELECTION,
  EMPTY_OUTCOME_DRAFT,
  validateOutcomeDraft,
  withFaultCode,
  type FaultCodeChoice,
} from "../src/domain/outcome-entry";
import { recordOutcome } from "../src/sync/payloads";
import { isKnownMutationKind, mutationKind } from "../src/sync/protocol";

const symptom: FaultCodeChoice = { id: "sym-1", kind: "symptom", code: "no_power", label: "No power" };
const symptom2: FaultCodeChoice = { id: "sym-2", kind: "symptom", code: "no_cooling", label: "No cooling" };
const cause: FaultCodeChoice = { id: "cau-1", kind: "cause", code: "blown_fuse", label: "Blown fuse" };

// ── Selecting fault codes ────────────────────────────────────────────────────

const afterSymptom = withFaultCode(EMPTY_FAULT_CODE_SELECTION, symptom);
equal("choosing a symptom sets it", afterSymptom.symptom?.id, "sym-1");
check("choosing a symptom leaves cause and remedy alone", afterSymptom.cause === null && afterSymptom.remedy === null);

const swapped = withFaultCode(afterSymptom, symptom2);
equal("choosing a different symptom replaces the first", swapped.symptom?.id, "sym-2");

const cleared = withFaultCode(afterSymptom, symptom);
equal("choosing the same symptom again clears it", cleared.symptom, null);

const withCause = withFaultCode(afterSymptom, cause);
check("a cause and a symptom can both be set", withCause.symptom?.id === "sym-1" && withCause.cause?.id === "cau-1");

// ── Submitting the outcome ───────────────────────────────────────────────────

const noOutcome = validateOutcomeDraft(EMPTY_OUTCOME_DRAFT);
check("no outcome chosen is rejected", !noOutcome.ok);
if (!noOutcome.ok) deepEqual("the one error is outcome_required", [...noOutcome.errors], ["outcome_required"]);

const outcomeOnly = validateOutcomeDraft({ ...EMPTY_OUTCOME_DRAFT, outcomeCode: "no_access" });
check("an outcome with no fault codes at all is accepted (a no_access visit diagnosed nothing)", outcomeOnly.ok);
if (outcomeOnly.ok) {
  deepEqual("every fault code id is null", [
    outcomeOnly.value.symptomCodeId,
    outcomeOnly.value.causeCodeId,
    outcomeOnly.value.remedyCodeId,
  ], [null, null, null]);
}

const full = validateOutcomeDraft({
  outcomeCode: "completed",
  outcomeLabel: "Completed",
  fault: withCause,
  note: "  Replaced the fuse.  ",
});
check("a full submission is accepted", full.ok);
if (full.ok) {
  equal("symptomCodeId comes from the selection", full.value.symptomCodeId, "sym-1");
  equal("causeCodeId comes from the selection", full.value.causeCodeId, "cau-1");
  equal("remedyCodeId is null when not chosen", full.value.remedyCodeId, null);
  equal("note is trimmed", full.value.note, "Replaced the fuse.");
}

const blankNote = validateOutcomeDraft({ ...EMPTY_OUTCOME_DRAFT, outcomeCode: "completed", note: "   " });
check("an all-whitespace note becomes null, not empty string", blankNote.ok && blankNote.value.note === null);

// ── What it feeds into is the one mutation that completes the job ──────────

if (full.ok) {
  const spec = recordOutcome({
    jobId: "job-1",
    baseVersion: null,
    outcomeCode: full.value.outcomeCode,
    symptomCodeId: full.value.symptomCodeId,
    causeCodeId: full.value.causeCodeId,
    remedyCodeId: full.value.remedyCodeId,
    note: full.value.note,
  });
  check(
    "the built mutation is job_outcome/record - JOB-15's only door",
    isKnownMutationKind(spec.entity, spec.op) && mutationKind(spec.entity, spec.op) === "job_outcome/record",
  );
  deepEqual("payload carries the outcome and the chosen fault codes together", spec.payload, {
    jobId: "job-1",
    outcomeCode: "completed",
    symptomCodeId: "sym-1",
    causeCodeId: "cau-1",
    note: "Replaced the fuse.",
  });
}

done("outcome-entry");
