import { randomBytes, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@meridian/db";
import { verifyTotp, normaliseRecoveryCode } from "./totp";
import { createSession, type CreatedSession } from "./session";

/**
 * The second-factor step of login.
 *
 * A password check that succeeds does not produce a session for an MFA-enrolled
 * account. It produces a *challenge*: a short-lived, single-use token that is
 * worth nothing on its own. The session only exists once a code is verified.
 *
 * The challenge token is handled exactly like a session token — raw value in
 * the client cookie, SHA-256 hash in the database — for the same reason: a
 * database read must not yield anything that can be replayed.
 */

const CHALLENGE_BYTES = 32;

/**
 * Five minutes. Long enough to open an authenticator app and find the account,
 * short enough that a token left in a browser on a shared machine is dead
 * before anyone gets to it.
 */
const CHALLENGE_TTL_MS = 1000 * 60 * 5;

/**
 * Wrong codes allowed on one challenge.
 *
 * A six-digit code is a million possibilities, but only if guessing is
 * expensive. Five attempts and the challenge dies; the user starts again from
 * the password, which is itself rate-limited by the lockout counter.
 */
const MAX_CHALLENGE_ATTEMPTS = 5;

export const MFA_CHALLENGE_COOKIE = "meridian_mfa";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Recovery codes are hashed the same way. See `userRecoveryCodes` for why. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normaliseRecoveryCode(code)).digest("hex");
}

export interface Challenge {
  /** Give this to the client once. Only its hash is stored. */
  readonly token: string;
  readonly expiresAt: Date;
}

export async function beginMfaChallenge(input: {
  userId: string;
  tenantId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}): Promise<Challenge> {
  const token = randomBytes(CHALLENGE_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  await db.execute(sql`
    select app_mfa_begin(
      ${input.userId}::uuid,
      ${input.tenantId}::uuid,
      ${hashToken(token)},
      ${expiresAt.toISOString()}::timestamptz,
      ${input.userAgent ?? null},
      ${input.ipAddress ?? null}
    )
  `);

  return { token, expiresAt };
}

export type MfaFailure =
  | "expired"
  | "invalid_code"
  | "too_many_attempts"
  | "not_enrolled";

export type MfaResult =
  | {
      readonly ok: true;
      readonly session: CreatedSession;
      readonly tenantId: string;
      /** Set when a recovery code was spent, so the UI can say how many remain. */
      readonly recoveryCodesRemaining?: number;
    }
  | { readonly ok: false; readonly reason: MfaFailure };

interface ChallengeRow extends Record<string, unknown> {
  challenge_id: string;
  user_id: string;
  tenant_id: string;
  attempts: number;
  mfa_secret: string | null;
  mfa_last_step: string | null;
}

/**
 * Complete a challenge with a TOTP code or a recovery code.
 *
 * Both paths are handled here rather than in two entry points because the
 * attempt ceiling has to be shared: separating them would let an attacker burn
 * five guesses at the code, then five more at a recovery code, on the same
 * challenge.
 */
export async function completeMfaChallenge(input: {
  token: string;
  code: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  /** Injectable for tests; production always uses the real clock. */
  at?: Date;
}): Promise<MfaResult> {
  const rows = (await db.execute<ChallengeRow>(
    sql`select * from app_mfa_resolve(${hashToken(input.token)})`,
  )) as unknown as ChallengeRow[];

  const challenge = rows[0];
  // An unknown, consumed or expired token are all the same answer: start again.
  // Distinguishing them would confirm a guessed token was once real.
  if (!challenge) return { ok: false, reason: "expired" };

  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (!challenge.mfa_secret) {
    // Enrolment was withdrawn between the password step and this one. Refuse
    // rather than fall through to a session: the flag says the account wants a
    // second factor, and there is no longer one to check.
    return { ok: false, reason: "not_enrolled" };
  }

  const lastStep =
    challenge.mfa_last_step === null ? null : Number(challenge.mfa_last_step);

  const verified = verifyTotp(challenge.mfa_secret, input.code, {
    ...(input.at ? { at: input.at } : {}),
    lastUsedStep: lastStep,
  });

  let usedRecovery = false;

  if (!verified.ok) {
    // Not a valid code — try it as a recovery code before counting a failure,
    // because a user typing a recovery code is not making a mistake.
    const consumed = (await db.execute<{ app_mfa_consume_recovery: boolean }>(
      sql`select app_mfa_consume_recovery(${challenge.user_id}::uuid, ${hashRecoveryCode(input.code)})`,
    )) as unknown as { app_mfa_consume_recovery: boolean }[];

    usedRecovery = consumed[0]?.app_mfa_consume_recovery === true;

    if (!usedRecovery) {
      const attempts = (await db.execute<{ app_mfa_record_attempt: number }>(
        sql`select app_mfa_record_attempt(${challenge.challenge_id}::uuid)`,
      )) as unknown as { app_mfa_record_attempt: number }[];

      const count = Number(attempts[0]?.app_mfa_record_attempt ?? 0);
      return {
        ok: false,
        reason: count >= MAX_CHALLENGE_ATTEMPTS ? "too_many_attempts" : "invalid_code",
      };
    }
  }

  // Consuming the challenge is what makes this single-use. If two requests race
  // with the same valid code, exactly one gets `true` back.
  const completed = (await db.execute<{ app_mfa_complete: boolean }>(
    sql`select app_mfa_complete(${challenge.challenge_id}::uuid, ${verified.step ?? null})`,
  )) as unknown as { app_mfa_complete: boolean }[];

  if (completed[0]?.app_mfa_complete !== true) {
    return { ok: false, reason: "expired" };
  }

  await db.execute(sql`select app_auth_record_success(${challenge.user_id}::uuid)`);

  const session = await createSession({
    userId: challenge.user_id,
    tenantId: challenge.tenant_id,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  if (!usedRecovery) return { ok: true, session, tenantId: challenge.tenant_id };

  const remaining = (await db.execute<{ app_mfa_recovery_remaining: number }>(
    sql`select app_mfa_recovery_remaining(${challenge.user_id}::uuid)`,
  )) as unknown as { app_mfa_recovery_remaining: number }[];

  return {
    ok: true,
    session,
    tenantId: challenge.tenant_id,
    recoveryCodesRemaining: Number(remaining[0]?.app_mfa_recovery_remaining ?? 0),
  };
}

export function messageForMfaFailure(reason: MfaFailure): string {
  switch (reason) {
    case "too_many_attempts":
      return "Too many incorrect codes. Sign in again to start over.";
    case "expired":
      return "That sign-in attempt has expired. Enter your email and password again.";
    case "not_enrolled":
      return "Two-factor authentication is no longer set up on this account. Contact your administrator.";
    default:
      return "That code is not right. Check your authenticator app and try again.";
  }
}
