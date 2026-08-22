/**
 * Account lockout policy.
 *
 * SEC-4 / ADM-3. The previous behaviour was a hard threshold with no way back:
 * eight failures locked the account forever, the only cure was an UPDATE run by
 * hand, and the sign-in screen told the user they were "temporarily" locked.
 * That combination is worse than having no lockout at all — the user believes a
 * wait will fix it, so they wait instead of asking for help, and the account is
 * unusable until someone happens to notice.
 *
 * Two things fix it: the lock expires on its own, and an administrator can
 * clear it (`unlockAccount`). This module owns the curve, deliberately as a
 * pure function with no I/O, so the policy is unit-testable without a database
 * and is stated in exactly one place rather than reimplemented in SQL, in the
 * UI copy and in whatever reads it next.
 *
 * The curve: nothing happens for the first few failures, because normal people
 * mistype passwords. After that the wait doubles, capped at 30 minutes. The cap
 * matters — an uncapped exponential is a denial-of-service an attacker can aim
 * at a named victim by failing their login on purpose.
 */

/** Failures allowed before the first lock. Below this, only the counter moves. */
export const LOCKOUT_FREE_ATTEMPTS = 5;

/** First lock, in seconds. Each subsequent failure doubles it. */
export const LOCKOUT_BASE_SECONDS = 60;

/**
 * Ceiling on a single lock, in seconds.
 *
 * Thirty minutes is long enough to make online guessing pointless and short
 * enough that a locked-out colleague can wait it out rather than needing an
 * administrator during a shift.
 */
export const LOCKOUT_MAX_SECONDS = 30 * 60;

/**
 * How long to lock the account given the number of consecutive failures
 * *including* the one being recorded now. Zero means "do not lock yet".
 */
export function lockoutSecondsFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= LOCKOUT_FREE_ATTEMPTS) return 0;

  const step = consecutiveFailures - LOCKOUT_FREE_ATTEMPTS - 1;
  // 2 ** step overflows to Infinity long after the cap bites, but Math.min on
  // Infinity still returns the cap, so there is no special case to write.
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** step, LOCKOUT_MAX_SECONDS);
}

export interface LockState {
  readonly locked: boolean;
  /** Whole seconds remaining, rounded up. Zero when not locked. */
  readonly retryAfterSeconds: number;
}

/** Is this account locked right now, and for how much longer? */
export function lockStateAt(lockedUntil: Date | null | undefined, now: Date = new Date()): LockState {
  if (!lockedUntil) return { locked: false, retryAfterSeconds: 0 };

  const remainingMs = lockedUntil.getTime() - now.getTime();
  if (remainingMs <= 0) return { locked: false, retryAfterSeconds: 0 };

  return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
}

/**
 * The wait, phrased for a person rather than for a log.
 *
 * Rounded up to whole minutes above a minute: "try again in 4 minutes" is
 * something a user can act on, "in 3 minutes 41 seconds" is a countdown they
 * will get wrong. Below a minute it stays in seconds, because "in 0 minutes"
 * is nonsense.
 */
export function describeWait(retryAfterSeconds: number): string {
  if (retryAfterSeconds <= 0) return "now";
  if (retryAfterSeconds < 60) {
    return `${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}`;
  }

  const minutes = Math.ceil(retryAfterSeconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
