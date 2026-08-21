/**
 * Timing events and the safety gate (`FLD-3`, `FLD-4`, `FLD-10`).
 *
 * ── APPEND-ONLY, WHICH IS THE ENTIRE CONFLICT STORY ────────────────────────
 *
 * TRD §8.4 puts *"immutable event facts - arrival, departure, photo,
 * signature"* at the top of the table with the note *"the biggest single
 * design win available"*. It is right, and it is worth being explicit about
 * why: an arrival modelled as `job_visits.arrived_at` is a mutable scalar two
 * writers can disagree about. The same arrival modelled as a row in an ordered
 * stream cannot conflict with anything, because nobody edits it - a correction
 * is a new row that supersedes it, and both survive.
 *
 * Nothing in this module mutates an event. `deriveLabour` reads the stream and
 * computes; it does not write a total back, because a stored total and a
 * stream that disagree is a dispute nobody can settle.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * `FLD-10` says labour is *"split by rate band"*. The bands live in the tenant's
 * rate card (`rate_card_items`), which is **not** in the bounded working set
 * (TRD §8.2 does not list it, and `price_list` is declared online-only in
 * working-set.ts). So this module splits time into travel and on-site minutes
 * and stops there; the office applies bands. That is a deliberate boundary,
 * not an omission I forgot to fill: a device that priced labour offline against
 * a cached rate card would produce numbers that disagree with the invoice.
 */

import type { OfflineStamp } from "./clock";

/** `FLD-3`. The visit's timing vocabulary. Append-only, ordered. */
export type TimingEventKind =
  | "en_route"
  | "arrived"
  | "started_work"
  | "paused"
  | "resumed"
  | "departed";

export const TIMING_EVENT_LABEL: Readonly<Record<TimingEventKind, string>> = {
  en_route: "On the way",
  arrived: "Arrived on site",
  started_work: "Started work",
  paused: "Paused",
  resumed: "Resumed",
  departed: "Left site",
};

/**
 * `FLD-16`. Location is stamped on discrete events, never as a breadcrumb.
 * Null is a legal value throughout: a plant room has no GPS fix, and a fix the
 * device could not get is not a fix the record should imply it had.
 */
export interface GeoStamp {
  readonly lat: number;
  readonly lng: number;
  readonly accuracyMetres: number | null;
}

export interface TimingEvent {
  /** ULID, minted on the device. Also the idempotency key. */
  readonly clientId: string;
  readonly jobId: string;
  readonly visitId: string | null;
  readonly kind: TimingEventKind;
  readonly stamp: OfflineStamp;
  readonly geo: GeoStamp | null;
  /** Required for `paused`; ignored otherwise. */
  readonly pauseReason: string | null;
  readonly note: string | null;
}

/** Which events may follow which. A stream, but not an arbitrary one. */
const TIMING_SUCCESSORS: Readonly<Record<TimingEventKind, readonly TimingEventKind[]>> = {
  en_route: ["arrived"],
  arrived: ["started_work", "departed"],
  started_work: ["paused", "departed"],
  paused: ["resumed", "departed"],
  resumed: ["paused", "departed"],
  departed: [],
};

export function nextTimingEvents(last: TimingEventKind | null): readonly TimingEventKind[] {
  return last === null ? ["en_route", "arrived"] : TIMING_SUCCESSORS[last];
}

// ── The safety gate (FLD-4) ─────────────────────────────────────────────────

/**
 * *"The `started_work` action is blocked until the risk assessment / RAMS
 * acknowledgement, permit-to-work reference (where required) and PPE
 * confirmation are recorded. In this trade that is frequently a legal
 * precondition, not a formality."*
 *
 * Three deliberate design points:
 *
 * 1. **The permit clause is conditional and the condition comes from the job,
 *    not from the app.** A permit-to-work is required for hot work, confined
 *    space and live electrical, and is not required for a tap washer. The job
 *    carries `requiresPermit` from the server; the device does not infer it.
 *
 * 2. **The gate refuses, it does not warn.** `startWorkRefusal` returns a
 *    reason or null, and the button is disabled on a reason. There is no
 *    override, because the override is the failure: every safety gate with a
 *    "proceed anyway" button becomes a button people press.
 *
 * 3. **It runs entirely offline.** A gate that needed a network call would be
 *    unenforceable in the basement where the hazard is. The templates are in
 *    the working set for exactly this reason.
 */
export interface SafetyAcknowledgement {
  /** RAMS document version the technician confirmed reading. */
  readonly ramsVersion: string | null;
  readonly ramsAcknowledgedAt: string | null;
  /** PPE items the technician confirmed wearing, by template code. */
  readonly ppeConfirmed: readonly string[];
  readonly ppeAcknowledgedAt: string | null;
  /** Permit reference, where the job requires one. */
  readonly permitReference: string | null;
}

export interface SafetyRequirement {
  readonly ramsRequired: boolean;
  readonly requiredPpeCodes: readonly string[];
  readonly permitRequired: boolean;
}

export type SafetyGap = "rams" | "ppe" | "permit";

export const SAFETY_GAP_MESSAGE: Readonly<Record<SafetyGap, string>> = {
  rams: "Read and confirm the risk assessment before starting work.",
  ppe: "Confirm the PPE for this job before starting work.",
  permit: "Enter the permit-to-work reference before starting work.",
};

export function safetyGaps(
  requirement: SafetyRequirement,
  ack: SafetyAcknowledgement,
): readonly SafetyGap[] {
  const gaps: SafetyGap[] = [];
  if (requirement.ramsRequired && !ack.ramsAcknowledgedAt) gaps.push("rams");

  const confirmed = new Set(ack.ppeConfirmed);
  const ppeOutstanding = requirement.requiredPpeCodes.some((code) => !confirmed.has(code));
  if (ppeOutstanding || (requirement.requiredPpeCodes.length > 0 && !ack.ppeAcknowledgedAt)) {
    gaps.push("ppe");
  }

  if (requirement.permitRequired && !ack.permitReference?.trim()) gaps.push("permit");
  return gaps;
}

/** Null means `started_work` is permitted. A string is what the screen shows. */
export function startWorkRefusal(
  requirement: SafetyRequirement,
  ack: SafetyAcknowledgement,
): string | null {
  const gaps = safetyGaps(requirement, ack);
  if (gaps.length === 0) return null;
  return gaps.map((g) => SAFETY_GAP_MESSAGE[g]).join(" ");
}

// ── Labour derivation (FLD-10) ──────────────────────────────────────────────

export interface LabourSplit {
  /** `en_route` to `arrived`. Costs differently from on-site time. */
  readonly travelMinutes: number;
  /** `started_work` to `departed`, less paused intervals. */
  readonly workMinutes: number;
  /** Paused time, kept separately rather than silently dropped. */
  readonly pausedMinutes: number;
  /** True when the stream never reached `departed`: the split is provisional. */
  readonly incomplete: boolean;
}

/**
 * Derive travel, work and paused minutes from the event stream.
 *
 * ── WHICH CLOCK THIS USES, AND WHY IT IS THE WRONG-BUT-CORRECT ONE ─────────
 *
 * Durations are computed from `recordedOfflineAt` - the device clock - not
 * from the server receipt times, and that is deliberate. A *duration* between
 * two events captured by the same device is correct even when that device's
 * absolute time is hours out, because the error cancels. The server receipt
 * times are the opposite: they are absolutely right and give a duration of
 * "however long the technician took to find signal", which is not the answer.
 *
 * So: durations from the device, absolute times from the server. Neither clock
 * is used for the thing it is bad at.
 *
 * The one case this gets wrong is a technician changing the clock *between*
 * two events of the same visit. `clock.ts` reports that as skew, and a negative
 * interval is clamped to zero here rather than subtracted, so a tampered clock
 * cannot manufacture negative time.
 */
export function deriveLabour(events: readonly TimingEvent[]): LabourSplit {
  const ordered = [...events].sort((a, b) => a.stamp.monotonicAt - b.stamp.monotonicAt);

  let travelMs = 0;
  let workMs = 0;
  let pausedMs = 0;

  let enRouteAt: number | null = null;
  let workingSince: number | null = null;
  let pausedSince: number | null = null;
  let departed = false;

  for (const event of ordered) {
    const at = Date.parse(event.stamp.recordedOfflineAt);
    switch (event.kind) {
      case "en_route":
        enRouteAt = at;
        break;
      case "arrived":
        if (enRouteAt !== null) travelMs += Math.max(0, at - enRouteAt);
        enRouteAt = null;
        break;
      case "started_work":
        workingSince = at;
        break;
      case "paused":
        if (workingSince !== null) workMs += Math.max(0, at - workingSince);
        workingSince = null;
        pausedSince = at;
        break;
      case "resumed":
        if (pausedSince !== null) pausedMs += Math.max(0, at - pausedSince);
        pausedSince = null;
        workingSince = at;
        break;
      case "departed":
        if (workingSince !== null) workMs += Math.max(0, at - workingSince);
        if (pausedSince !== null) pausedMs += Math.max(0, at - pausedSince);
        workingSince = null;
        pausedSince = null;
        departed = true;
        break;
    }
  }

  return {
    travelMinutes: Math.round(travelMs / 60_000),
    workMinutes: Math.round(workMs / 60_000),
    pausedMinutes: Math.round(pausedMs / 60_000),
    incomplete: !departed,
  };
}

/**
 * A technician's own figure, with the reason `FLD-10` requires.
 *
 * Carried alongside the derived value, never replacing it. Both reach the
 * server, so the office can see that a technician said 90 minutes where the
 * events said 40, and why.
 */
export interface LabourOverride {
  readonly workMinutes: number;
  readonly reason: string;
}

/**
 * What is actually sent as `visit_labour/record`.
 *
 * ── NULL AND ZERO ARE DIFFERENT ANSWERS, AND THE TYPE SAYS SO ──────────────
 *
 * `packages/db/src/domain/jobcard.ts` is explicit about this, and the reasoning
 * is worth repeating because a UI gets it wrong by default:
 *
 *   > The gate asks that labour time be *recorded*, not that it be positive. A
 *   > `no_access` visit is a real outcome and the honest labour figure for it
 *   > is zero: the technician travelled, could not get in, and spent no time on
 *   > the tools. Demanding a positive number would produce a fabricated one.
 *
 * So `workMinutes: number | null`, where **null means nobody has filled it in
 * and zero means no time on the tools**. The screen must be able to send a
 * genuine zero, and `source` is what lets it show the difference: a spinner
 * defaulted to 0 and a technician who chose 0 look identical in the number.
 *
 * ── PER VISIT, NOT PER TECHNICIAN PER DAY ──────────────────────────────────
 *
 * The server column is `job_visits.work_minutes`. A technician on four jobs in
 * a day produces four of these and one day's attendance; the two are not two
 * homes for the same number, and nothing here touches payroll.
 *
 * The no-access path falls out without a special case: a visit with `arrived`
 * and `departed` and no `started_work` derives zero work minutes and is
 * complete, so it is recordable as a true zero.
 */
export interface LabourRecord {
  /** Null: nobody has filled it in. Zero: no time on the tools. */
  readonly workMinutes: number | null;
  readonly travelMinutes: number | null;
  readonly source: "derived" | "override" | "not_recorded";
  /** `FLD-10` requires a reason with an override. Null otherwise. */
  readonly overrideReason: string | null;
}

export function labourToRecord(derived: LabourSplit, override: LabourOverride | null): LabourRecord {
  if (override) {
    return {
      workMinutes: override.workMinutes,
      travelMinutes: derived.travelMinutes,
      source: "override",
      overrideReason: override.reason,
    };
  }

  // A visit that never reached `departed` has no honest total yet. Sending the
  // running figure would record a number that was true for a moment, and the
  // server cannot tell it apart from a final one.
  if (derived.incomplete) {
    return { workMinutes: null, travelMinutes: null, source: "not_recorded", overrideReason: null };
  }

  return {
    workMinutes: derived.workMinutes,
    travelMinutes: derived.travelMinutes,
    source: "derived",
    overrideReason: null,
  };
}

/** True when this is a real recorded value, including a real zero. */
export function isLabourRecorded(record: LabourRecord): boolean {
  return record.workMinutes !== null;
}

/**
 * `FLD-10`: *"overridable with a reason"*. The override is carried alongside
 * the derived value, never as a replacement for it. Both reach the server; the
 * office can see that a technician said 90 minutes where the events said 40,
 * and why.
 */
export function effectiveWorkMinutes(
  derived: LabourSplit,
  override: LabourOverride | null,
): { readonly minutes: number; readonly overridden: boolean } {
  return override
    ? { minutes: override.workMinutes, overridden: true }
    : { minutes: derived.workMinutes, overridden: false };
}
