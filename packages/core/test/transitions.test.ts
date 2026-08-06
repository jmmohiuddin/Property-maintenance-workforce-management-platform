import { canTransition, allowedTransitions, InvalidTransitionError, ALL_JOB_STATUSES } from "@meridian/core";

const cases: [string, string, boolean][] = [
  ["submitted", "closed", false],   // skipping the entire lifecycle
  ["submitted", "triaged", true],
  ["closed", "on_site", false],     // reopening a terminal state
  ["cancelled", "triaged", false],
  ["on_site", "work_complete", true],
  ["work_complete", "signed_off", true],
  ["triaged", "invoiced", false],   // billing before any work
  ["paused", "on_site", true],
];

let fail = 0;
for (const [from, to, expected] of cases) {
  const got = canTransition(from as never, to as never);
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${from} -> ${to}  expected ${expected}, got ${got}`);
}

// Terminal states must be dead ends.
for (const s of ["closed", "cancelled"] as const) {
  const n = allowedTransitions(s).length;
  const ok = n === 0;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${s} is terminal (${n} exits)`);
}

// Every status must be reachable from at least one other, or it is dead code.
for (const s of ALL_JOB_STATUSES) {
  if (s === "draft") continue; // entry point
  const reachable = ALL_JOB_STATUSES.some((f) => f !== s && canTransition(f as never, s as never));
  if (!reachable) { fail++; console.log(`FAIL  ${s} is unreachable from any status`); }
}

console.log(`\n${fail === 0 ? "transition graph: all checks passed" : `${fail} FAILING`}`);
process.exit(fail === 0 ? 0 : 1);
