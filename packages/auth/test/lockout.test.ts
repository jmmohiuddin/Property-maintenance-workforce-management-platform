/**
 * Lockout policy unit test.
 *
 * The reason this policy lives in a pure module rather than in SQL is so it can
 * be tested here, with no database and no clock of its own. The behaviour being
 * pinned is the one the audit found wrong: lockout used to be permanent while
 * the UI said "temporarily", so the two properties that matter most are that a
 * lock *expires* and that the wait the user is told is the wait they get.
 *
 *   npm run test --workspace=@meridian/auth
 *
 * No database required.
 */

import {
  lockoutSecondsFor,
  lockStateAt,
  describeWait,
  LOCKOUT_FREE_ATTEMPTS,
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MAX_SECONDS,
} from "../src/lockout";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

console.log("\n— backoff curve —");

// Mistyping a password a few times is normal and must cost nothing. A policy
// that locks on the second attempt gets disabled by whoever fields the calls.
for (let n = 1; n <= LOCKOUT_FREE_ATTEMPTS; n++) {
  check(`${n} failure${n === 1 ? "" : "s"} does not lock`, lockoutSecondsFor(n), 0);
}

check("first lock is the base delay", lockoutSecondsFor(LOCKOUT_FREE_ATTEMPTS + 1), LOCKOUT_BASE_SECONDS);
check("second lock doubles", lockoutSecondsFor(LOCKOUT_FREE_ATTEMPTS + 2), LOCKOUT_BASE_SECONDS * 2);
check("third lock doubles again", lockoutSecondsFor(LOCKOUT_FREE_ATTEMPTS + 3), LOCKOUT_BASE_SECONDS * 4);

// The cap is the anti-griefing property. Without it, someone who fails a
// colleague's login on purpose a few dozen times locks that account for years.
check("the curve is capped", lockoutSecondsFor(LOCKOUT_FREE_ATTEMPTS + 40), LOCKOUT_MAX_SECONDS);
check("and stays capped at absurd counts", lockoutSecondsFor(100_000), LOCKOUT_MAX_SECONDS);
checkTrue("no lock ever exceeds the cap", [...Array(200).keys()].every((n) => lockoutSecondsFor(n) <= LOCKOUT_MAX_SECONDS));

console.log("\n— lock state —");

const now = new Date("2026-08-21T10:00:00Z");

check("no expiry means not locked", lockStateAt(null, now).locked, false);
check("null expiry reports no wait", lockStateAt(null, now).retryAfterSeconds, 0);

// THE regression this file exists for: a lock in the past is over. The previous
// implementation had no expiry at all, so this case could not be expressed.
const past = new Date(now.getTime() - 1000);
check("an elapsed lock is not locked", lockStateAt(past, now).locked, false);

const future = new Date(now.getTime() + 90_000);
check("a future lock is locked", lockStateAt(future, now).locked, true);
check("and reports the remaining seconds", lockStateAt(future, now).retryAfterSeconds, 90);

// Rounding up, not down: telling someone to retry a moment before the lock
// actually lifts produces a second failure and a longer lock.
const partial = new Date(now.getTime() + 90_400);
check("partial seconds round up", lockStateAt(partial, now).retryAfterSeconds, 91);

console.log("\n— wording —");

check("seconds stay seconds", describeWait(45), "45 seconds");
check("one second is singular", describeWait(1), "1 second");
check("a minute is a minute", describeWait(60), "1 minute");
check("part-minutes round up", describeWait(61), "2 minutes");
check("the cap reads sensibly", describeWait(LOCKOUT_MAX_SECONDS), "30 minutes");

console.log(fail === 0 ? "\nAll lockout checks passed.\n" : `\n${fail} check(s) failed.\n`);
process.exit(fail === 0 ? 0 : 1);
