/**
 * Conflict resolution by data class (TRD §8.4).
 *
 * *"This is the table that prevents the whole problem. Most 'sync conflicts'
 * in field service are self-inflicted by modelling events as mutable state."*
 *
 * The table is transcribed below as code rather than left in the document,
 * because the client has to act on it and a rule the client implements from
 * memory of a document is a rule that drifts.
 *
 * ── KEYED BY `entity/op`, NOT BY ENTITY ────────────────────────────────────
 *
 * `job_material/append` and `job_material/declare_none` are the same entity and
 * different data classes: one is an additive collection, the other is a
 * declaration the server holds one of. Keying the table by entity alone would
 * force them to share a class and get one of them wrong. The key is the
 * server's own closed `FIELD_MUTATION_KINDS` list, so the two cannot drift.
 *
 * ── WHAT THE CLIENT DECIDES, WHICH IS ALMOST NOTHING ───────────────────────
 *
 * The server is authoritative - §8.3 titles the whole design
 * "server-authoritative with a transactional outbox". This module merges
 * nothing. It decides three much smaller things:
 *
 *   1. Whether a mutation is even *capable* of conflicting, which determines
 *      whether the client should carry a `baseVersion` for it at all.
 *   2. What to do locally when the server refuses one.
 *   3. What to tell the technician, in words about their job rather than about
 *      HTTP - falling back to the server's own `detail`, which is written for
 *      exactly that purpose.
 */

import type { FieldMutationKind } from "./protocol";

export type DataClass =
  | "immutable_event"
  | "server_authoritative"
  | "additive_collection"
  | "free_text_scalar"
  | "counter"
  | "post_signature";

export const DATA_CLASS_OF: Readonly<Record<FieldMutationKind, DataClass>> = {
  // "Job status, dispatch assignment. Server-authoritative. Dispatcher wins;
  //  client accepts and surfaces the change."
  "job_status/transition": "server_authoritative",
  "job_outcome/record": "server_authoritative",
  // A declaration the server holds exactly one of, not a growing collection.
  "job_material/declare_none": "server_authoritative",
  "job_photo/exempt": "server_authoritative",

  // "Immutable event facts - arrival, departure, photo, signature.
  //  Append-only. No conflict possible. The biggest single design win."
  "job_attachment/append": "immutable_event",
  "attendance/append": "immutable_event",
  "job_signature/record": "immutable_event",
  // A position. Nothing overwrites a fix that has already landed, and the
  // server never asks the device for one back - same class as an attendance
  // event, for the same reason.
  "technician_location/append": "immutable_event",

  // "Additive collections - materials, notes, photos. Union by
  //  client-generated ID. An or-set, implementable without a CRDT library."
  "job_material/append": "additive_collection",

  // "Free-text scalars - job notes body. Last-write-wins on server receipt,
  //  with the loser preserved and surfaced."
  "job_note/upsert": "free_text_scalar",

  // "Counters - hours, quantities. Stored as entries, summed server-side.
  //  Never an absolute overwritten scalar."
  "visit_labour/record": "counter",
};

/**
 * Does this mutation need optimistic concurrency?
 *
 * Only the classes that can be *overwritten*. Sending a `baseVersion` for an
 * append-only event would be noise at best: nothing can make an arrival that
 * already happened stale, and a version check on it could only ever produce a
 * false conflict.
 */
export function needsBaseVersion(kind: FieldMutationKind): boolean {
  const dataClass = DATA_CLASS_OF[kind];
  return dataClass === "free_text_scalar" || dataClass === "server_authoritative";
}

// ── Acting on a refusal ─────────────────────────────────────────────────────

export type ConflictAction =
  /** The server's version stands and the technician does not need telling. */
  | "accept_server_silently"
  /** The server's version stands, and the screen must say so - the job moved. */
  | "accept_server_and_notify"
  /** Keep what the technician typed as a preserved loser, surfaced for merge. */
  | "preserve_local_and_notify"
  /** The job card is refused. Reopen it on the checklist (`JOB-15`). */
  | "reopen_job_card"
  /** Nobody here can decide. Dispatch board, per ADR 0004. */
  | "escalate_to_office";

export interface ConflictVerdict {
  readonly action: ConflictAction;
  /** Written for the technician, about their job. */
  readonly message: string;
}

/**
 * The reason strings the server actually emits today, from
 * `packages/db/src/domain/field.ts`.
 *
 * Two, at the time of writing. The list is short because the design works:
 * most of what would be a conflict elsewhere is append-only here and cannot
 * conflict at all.
 */
export const KNOWN_CONFLICT_REASONS = [
  /** The office closed or cancelled the job before the phone's card arrived. */
  "job_ended_in_office",
  /** A job report saved over text the office had changed. The loser is kept. */
  "text_overwritten",
] as const;

export function classifyConflict(input: {
  readonly kind: FieldMutationKind;
  readonly reason: string;
  /** The server's own sentence. Always shown when this build cannot do better. */
  readonly detail?: string;
}): ConflictVerdict {
  const reason = input.reason.toLowerCase();
  const dataClass = DATA_CLASS_OF[input.kind];

  // ADR 0004 names this exact case: "A technician marking a job complete
  // offline while a dispatcher cancels it online is a real conflict that needs
  // a human, not a merge rule."
  if (reason.startsWith("job_ended_in_office")) {
    return {
      action: "escalate_to_office",
      message:
        "The office closed this job while you were offline. Your work has reached them and someone will " +
        "be in touch - do not re-enter it.",
    };
  }

  // The server has already applied the technician's text and preserved what it
  // replaced. Nothing to do locally except say so: silently accepting would
  // leave the technician unaware they overwrote a colleague.
  if (reason.startsWith("text_overwritten")) {
    return {
      action: "preserve_local_and_notify",
      message:
        "Someone in the office had changed these notes while you were offline. Yours is now the version " +
        "on file, and theirs has been kept alongside it.",
    };
  }

  // Idempotency working as designed: the request arrived twice and the server
  // already has it. This is the *expected* outcome of "request succeeded,
  // response lost, client retries" and is not a conflict in any real sense.
  // The server currently reports it as an acceptance rather than a conflict;
  // handled here in case that changes.
  if (reason.startsWith("duplicate")) {
    return { action: "accept_server_silently", message: "Already saved." };
  }

  if (reason.startsWith("stale_version")) {
    switch (dataClass) {
      case "free_text_scalar":
        return {
          action: "preserve_local_and_notify",
          message: input.detail ?? "Both versions of these notes have been kept.",
        };
      case "server_authoritative":
        return {
          action: "accept_server_and_notify",
          message: input.detail ?? "The office changed this job while you were offline. Their version stands.",
        };
      case "immutable_event":
      case "additive_collection":
      case "counter":
        // Structurally impossible: nothing overwrites these, so nothing can be
        // stale against them. Reaching here means the server and this client
        // disagree about the data class - a contract bug, not a data problem.
        return {
          action: "escalate_to_office",
          message:
            input.detail ??
            "This could not be saved and the app cannot tell why. Call the office and quote this job.",
        };
      case "post_signature":
        return {
          action: "escalate_to_office",
          message: input.detail ?? "This job is signed and locked. Add an amendment instead.",
        };
    }
  }

  // An unrecognised reason from a newer server. Do not guess: showing the
  // server's own words and asking a person is always safe, and silently
  // discarding a refusal is never. The server writes `detail` for the
  // technician's screen, so there is usually something good to show.
  return {
    action: "escalate_to_office",
    message:
      input.detail ??
      `The office refused this (${input.reason}). Your work is still on the phone - call them before ` +
        "re-entering it.",
  };
}

/** True when the technician's typing must be kept alongside the server's. */
export function preservesLocalCopy(action: ConflictAction): boolean {
  return action === "preserve_local_and_notify" || action === "escalate_to_office";
}
