/**
 * "Fault codes" and "Choose what happened", and why they share one module.
 *
 * `sync/payloads.ts`'s `recordOutcome` - `job_outcome/record` - is the **only**
 * mutation that carries `outcomeCode`, `symptomCodeId`, `causeCodeId` and
 * `remedyCodeId`. `packages/db/src/domain/outcomes.ts`'s `recordJobOutcome`
 * confirms it: there is no separate fault-code entity or mutation kind in
 * `FIELD_MUTATION_KINDS`. So on the wire, "what the technician diagnosed" and
 * "what happened" are one write, not two - the job card's "Fault codes" and
 * "Outcome" sections are two places to *choose* values, and one action, firing
 * from the outcome section, that sends them.
 *
 * ── THE DEVICE DOES NOT DECIDE WHETHER THIS COMPLETION IS ALLOWED ──────────
 *
 * Same rule as the rest of `domain/job-card.ts`: this module validates that a
 * *value* was chosen (an outcome code, present; fault codes, each optional).
 * It does not check `JOB-15`'s three gaps - photo, materials, labour - because
 * `assertJobCardComplete` on the server is where that gate lives, and it is
 * queued regardless of local readiness; if the gate is not satisfied yet the
 * mutation comes back `rejected` with `gaps`, which `JobCardScreen` already
 * renders as `lastRefusal`. What was recorded stays on the phone and is not
 * re-entered - the outbox's own `refused` state, not a second implementation
 * of the rule here.
 */

import type { FaultCodeKind } from "./job-card";

export interface FaultCodeChoice {
  /** The server's `fault_codes.id` - what `recordOutcome` actually cites. */
  readonly id: string;
  readonly kind: FaultCodeKind;
  readonly code: string;
  readonly label: string;
}

export interface FaultCodeSelection {
  readonly symptom: FaultCodeChoice | null;
  readonly cause: FaultCodeChoice | null;
  readonly remedy: FaultCodeChoice | null;
}

export const EMPTY_FAULT_CODE_SELECTION: FaultCodeSelection = { symptom: null, cause: null, remedy: null };

/**
 * Choosing a code again clears it - a picker with no way to say "actually,
 * none" would force a technician who tapped the wrong symptom to pick a
 * different wrong one to get rid of it.
 */
export function withFaultCode(selection: FaultCodeSelection, choice: FaultCodeChoice): FaultCodeSelection {
  const current = selection[choice.kind];
  const next = current !== null && current.id === choice.id ? null : choice;
  return { ...selection, [choice.kind]: next };
}

export interface OutcomeDraft {
  readonly outcomeCode: string | null;
  readonly outcomeLabel: string | null;
  readonly fault: FaultCodeSelection;
  readonly note: string;
}

export const EMPTY_OUTCOME_DRAFT: OutcomeDraft = {
  outcomeCode: null,
  outcomeLabel: null,
  fault: EMPTY_FAULT_CODE_SELECTION,
  note: "",
};

export type OutcomeSubmitError = "outcome_required";

export const OUTCOME_SUBMIT_ERROR_MESSAGE: Readonly<Record<OutcomeSubmitError, string>> = {
  outcome_required: "Choose what happened before recording it.",
};

export interface ValidOutcomeSubmission {
  readonly outcomeCode: string;
  readonly symptomCodeId: string | null;
  readonly causeCodeId: string | null;
  readonly remedyCodeId: string | null;
  readonly note: string | null;
}

export type OutcomeSubmitResult =
  | { readonly ok: true; readonly value: ValidOutcomeSubmission }
  | { readonly ok: false; readonly errors: readonly OutcomeSubmitError[] };

/**
 * Everything else is optional on the wire (`recordOutcome`'s own doc comment:
 * "a `no_access` visit diagnosed nothing, and demanding a cause for it would
 * produce a fabricated one"), so the only local gate is that an outcome was
 * actually chosen - a mutation with no `outcomeCode` is refused by
 * `requireString` on the server, deterministically, for every technician who
 * taps the button with nothing selected.
 */
export function validateOutcomeDraft(draft: OutcomeDraft): OutcomeSubmitResult {
  if (!draft.outcomeCode) return { ok: false, errors: ["outcome_required"] };
  return {
    ok: true,
    value: {
      outcomeCode: draft.outcomeCode,
      symptomCodeId: draft.fault.symptom?.id ?? null,
      causeCodeId: draft.fault.cause?.id ?? null,
      remedyCodeId: draft.fault.remedy?.id ?? null,
      note: draft.note.trim() || null,
    },
  };
}
