/**
 * The technician's own clock: shift-in, shift-out and breaks (`TECH-8`).
 *
 * ── A SEPARATE VOCABULARY FROM `attendance.ts`'s `TimingEventKind` ─────────
 *
 * `domain/attendance.ts` already owns `en_route` / `arrived` / `started_work`
 * / `paused` / `resumed` / `departed` - a *per-visit* stream, stored locally
 * in `timing_events`, that has no mutation kind on the wire at all
 * (`FIELD_MUTATION_KINDS` names nothing for it) and exists to feed
 * `deriveLabour`. This is a different, day-level stream that does have a wire
 * mutation - `attendance/append` (`sync/protocol.ts`) - backed by
 * `attendance_events` in `packages/db/src/schema/workforce.ts` and written by
 * `recordFieldAttendance` in `packages/db/src/domain/field.ts` (~line 1816).
 * Two vocabularies that both start with "attendance" would be exactly the
 * ambiguity this codebase has been bitten by before, so this one is named
 * `shift-clock` rather than reusing `attendance` for a second, unrelated
 * meaning.
 *
 * ── WHY THE FOUR KINDS ARE DUPLICATED HERE RATHER THAN IMPORTED ────────────
 *
 * `recordFieldAttendance` checks `const kinds = ["shift_in", "shift_out",
 * "break_start", "break_end"]` inline, not as an exported `@meridian/core`
 * union - so there is nothing in `packages/db`'s public surface for this file
 * to import. Duplicating the four literal strings, the same way
 * `FIELD_SETTABLE_STATUSES` duplicates the server's status allow-list in
 * `sync/payloads.ts`, is the least-bad option available from this side of the
 * wire: an unrecognised kind is refused here, before a mutation is even
 * built, by the same closed list the server enforces. If the server's list
 * ever changes, both call sites need updating and disagreeing between them is
 * how a rejected clock event gets discovered - the same trade `payloads.ts`'s
 * own header already makes for `FIELD_SETTABLE_STATUSES`.
 */

export const SHIFT_CLOCK_KINDS = ["shift_in", "shift_out", "break_start", "break_end"] as const;

export type ShiftClockKind = (typeof SHIFT_CLOCK_KINDS)[number];

export function isShiftClockKind(value: string): value is ShiftClockKind {
  return (SHIFT_CLOCK_KINDS as readonly string[]).includes(value);
}

export const SHIFT_CLOCK_LABEL: Readonly<Record<ShiftClockKind, string>> = {
  shift_in: "Clock in",
  shift_out: "Clock out",
  break_start: "Start break",
  break_end: "End break",
};

/**
 * What a technician may do next, given the last shift-clock event of the day
 * (or none). A small, explicit state machine rather than "every button,
 * always enabled": clocking out twice in a row, or starting a break before
 * clocking in, are not states a payroll dispute should ever have to explain.
 *
 * `null` - nothing recorded yet - only offers `shift_in`. A split shift
 * (`shift_out` then `shift_in` again later the same day) is not a distinct
 * case: `shift_out`'s successor is `shift_in`, the same rule as starting the
 * day, deliberately.
 */
const SHIFT_CLOCK_SUCCESSORS: Readonly<Record<ShiftClockKind, readonly ShiftClockKind[]>> = {
  shift_in: ["break_start", "shift_out"],
  break_start: ["break_end"],
  break_end: ["break_start", "shift_out"],
  shift_out: ["shift_in"],
};

export function nextShiftClockActions(last: ShiftClockKind | null): readonly ShiftClockKind[] {
  return last === null ? ["shift_in"] : SHIFT_CLOCK_SUCCESSORS[last];
}
