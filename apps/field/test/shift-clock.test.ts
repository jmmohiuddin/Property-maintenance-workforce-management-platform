import { check, deepEqual, done } from "./_harness";
import {
  SHIFT_CLOCK_KINDS,
  SHIFT_CLOCK_LABEL,
  isShiftClockKind,
  nextShiftClockActions,
} from "../src/domain/shift-clock";

// ── The closed vocabulary matches the server's inline allow-list ───────────
//
// `recordFieldAttendance` (packages/db/src/domain/field.ts, ~line 1816)
// checks `["shift_in", "shift_out", "break_start", "break_end"]` inline.
// This is the device's copy of that same list.

deepEqual("the four kinds, and no others", [...SHIFT_CLOCK_KINDS], [
  "shift_in",
  "shift_out",
  "break_start",
  "break_end",
]);

for (const kind of SHIFT_CLOCK_KINDS) {
  check(`${kind} is recognised`, isShiftClockKind(kind));
  check(`${kind} has a label a technician can read`, SHIFT_CLOCK_LABEL[kind].length > 0);
}

check("an unrecognised kind is refused", !isShiftClockKind("lunch"));
check("case matters - the list is literal, not normalised", !isShiftClockKind("Shift_In"));

// ── The state machine ───────────────────────────────────────────────────────

deepEqual("a fresh day (nothing recorded) only offers clocking in", [...nextShiftClockActions(null)], ["shift_in"]);

deepEqual(
  "once clocked in, a technician may start a break or clock out - not clock in again",
  [...nextShiftClockActions("shift_in")],
  ["break_start", "shift_out"],
);

deepEqual(
  "mid-break, the only action is ending it",
  [...nextShiftClockActions("break_start")],
  ["break_end"],
);

deepEqual(
  "after a break ends, the technician may break again or clock out",
  [...nextShiftClockActions("break_end")],
  ["break_start", "shift_out"],
);

deepEqual(
  "after clocking out, the only action is clocking back in - a split shift",
  [...nextShiftClockActions("shift_out")],
  ["shift_in"],
);

// No kind ever offers itself as its own successor, and no kind is ever
// offered from a starting point that has not happened.
for (const kind of SHIFT_CLOCK_KINDS) {
  check(`${kind} never immediately repeats itself`, !nextShiftClockActions(kind).includes(kind));
}

done("shift-clock");
