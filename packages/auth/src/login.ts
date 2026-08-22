import { sql } from "drizzle-orm";
import { db } from "@meridian/db";
import { checkRateLimit } from "@meridian/db/domain";
import { verifyPassword, fakeVerify } from "./password";
import { createSession, type CreatedSession } from "./session";
import { beginMfaChallenge, type Challenge } from "./mfa";
import { lockoutSecondsFor, lockStateAt, describeWait } from "./lockout";

/**
 * Login.
 *
 * Every failure path returns the same message and takes comparable time. The
 * caller is told "email or password is incorrect" whether the address is
 * unknown, the password is wrong, or the account has no usable membership,
 * because distinguishing them hands an attacker a free account-enumeration
 * oracle. The real reason is returned to the server-side caller for logging.
 *
 * Table access goes through `app_auth_*` SECURITY DEFINER functions - see
 * packages/db/sql/auth-functions.sql.
 *
 * Two throttles, and they defend against different attacks:
 *
 *   * Per-account lockout (./lockout.ts) stops someone guessing one person's
 *     password. It is now time-limited rather than permanent - see SEC-4.
 *   * Per-IP throttling (SEC-3) stops credential stuffing, where each attempt
 *     targets a *different* account and no single lockout counter ever moves.
 *     Account lockout is completely blind to that shape of attack, which is why
 *     it needed its own control rather than a higher threshold.
 *
 * The IP limiter is the same Postgres one built for the quote form. It fails
 * open, and the caller is told so via `degraded` so a limiter outage is logged
 * rather than discovered in a support ticket.
 */

/**
 * Attempts allowed per IP address per window, across all accounts.
 *
 * Set well above what a person with a forgotten password produces and well
 * below what makes stuffing a list worthwhile. Offices behind one NAT address
 * are the reason it is not lower.
 */
export const LOGIN_IP_LIMIT = 20;
export const LOGIN_IP_WINDOW_SECONDS = 15 * 60;

export type LoginResult =
  | { readonly ok: true; readonly session: CreatedSession; readonly tenantId: string }
  /**
   * Password accepted, second factor outstanding. This is NOT a partial
   * session: the challenge grants nothing until a code is verified, and the
   * caller must not create a session from it.
   */
  | { readonly ok: false; readonly reason: "mfa_required"; readonly challenge: Challenge }
  | {
      readonly ok: false;
      readonly reason: "locked";
      /** Seconds until the account unlocks itself. Drives the message. */
      readonly retryAfterSeconds: number;
    }
  | { readonly ok: false; readonly reason: Exclude<LoginFailure, "mfa_required" | "locked"> };

export type LoginFailure =
  | "invalid_credentials"
  | "locked"
  | "ip_throttled"
  | "no_membership"
  | "tenant_inactive"
  | "mfa_required";

interface LookupRow extends Record<string, unknown> {
  user_id: string;
  password_hash: string | null;
  failed_login_count: number | string | null;
  locked_until: string | Date | null;
  mfa_enabled: boolean;
  tenant_id: string | null;
  role: string | null;
  membership_active: boolean | null;
  tenant_active: boolean | null;
}

interface FailureRow extends Record<string, unknown> {
  failed_login_count: number | string | null;
  locked_until: string | Date | null;
}

function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

export async function login(input: {
  email: string;
  password: string;
  /** Required when the user belongs to more than one tenant. */
  tenantId?: string | undefined;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  // SEC-3. Checked before the password hash is verified, because verifying is
  // the expensive part by design (Argon2id) and an unthrottled attacker would
  // otherwise get a free CPU-exhaustion primitive alongside their guessing.
  if (input.ipAddress) {
    const decision = await checkRateLimit({
      bucket: `login:${input.ipAddress}`,
      limit: LOGIN_IP_LIMIT,
      windowSeconds: LOGIN_IP_WINDOW_SECONDS,
    });

    if (decision.degraded) {
      console.warn("[auth] login IP throttle degraded; allowing the attempt", { ip: input.ipAddress });
    }
    if (!decision.allowed) {
      // No fakeVerify here on purpose. The whole point of refusing is to not
      // spend the CPU, and the response time already differs from a real
      // attempt in a way no attacker can exploit — they have been told plainly
      // that they are rate limited.
      return { ok: false, reason: "ip_throttled" };
    }
  }

  const result = await db.execute<LookupRow>(sql`select * from app_auth_lookup(${email})`);
  const rows = result as unknown as LookupRow[];
  const user = rows[0];

  if (!user || !user.password_hash) {
    // Spend comparable time so response timing does not reveal that the
    // address is unknown or has no password set.
    await fakeVerify(input.password);
    return { ok: false, reason: "invalid_credentials" };
  }

  const lock = lockStateAt(asDate(user.locked_until));
  if (lock.locked) {
    await fakeVerify(input.password);
    return { ok: false, reason: "locked", retryAfterSeconds: lock.retryAfterSeconds };
  }

  const valid = await verifyPassword(input.password, user.password_hash);

  if (!valid) {
    // The lock length is computed from the count this failure will produce, so
    // the database is told how long to lock rather than deciding for itself.
    // Keeping the curve in TypeScript means it is testable without Postgres and
    // exists in one place instead of being duplicated into SQL.
    const nextCount = Number(user.failed_login_count ?? 0) + 1;
    const lockSeconds = lockoutSecondsFor(nextCount);

    const recorded = (await db.execute<FailureRow>(
      sql`select * from app_auth_record_failure(${user.user_id}::uuid, ${lockSeconds})`,
    )) as unknown as FailureRow[];

    const nowLocked = lockStateAt(asDate(recorded[0]?.locked_until ?? null));
    if (nowLocked.locked) {
      return { ok: false, reason: "locked", retryAfterSeconds: nowLocked.retryAfterSeconds };
    }

    return { ok: false, reason: "invalid_credentials" };
  }

  const candidates = rows.filter(
    (r) => r.tenant_id !== null && (input.tenantId ? r.tenant_id === input.tenantId : true),
  );

  if (candidates.length === 0) return { ok: false, reason: "no_membership" };

  const usable = candidates.find((r) => r.membership_active && r.tenant_active);
  if (!usable || !usable.tenant_id) {
    return {
      ok: false,
      reason: candidates.some((r) => r.membership_active) ? "tenant_inactive" : "no_membership",
    };
  }

  // The membership check comes first on purpose: a user with no usable
  // membership gets the generic answer rather than a challenge that reveals
  // their account exists and is MFA-protected.
  if (user.mfa_enabled) {
    const challenge = await beginMfaChallenge({
      userId: user.user_id,
      tenantId: usable.tenant_id,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    });
    // The success counter is deliberately not reset here. The login is not
    // complete until the second factor is, and resetting now would let someone
    // with a stolen password keep the lockout counter at zero forever.
    return { ok: false, reason: "mfa_required", challenge };
  }

  await db.execute(sql`select app_auth_record_success(${user.user_id}::uuid)`);

  const session = await createSession({
    userId: user.user_id,
    tenantId: usable.tenant_id,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
  });

  return { ok: true, session, tenantId: usable.tenant_id };
}

/**
 * Clear a lockout (ADM-1, ADM-3).
 *
 * Authorisation belongs to the caller — this is the mechanism, not the control.
 * The server action that calls it checks `users:manage` and writes the audit
 * row, so the log records which administrator unlocked whom.
 */
export async function unlockAccount(userId: string): Promise<void> {
  await db.execute(sql`select app_auth_unlock(${userId}::uuid)`);
}

/** The single message shown for every failure. Do not vary it by reason. */
export const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

export function messageForFailure(reason: LoginFailure, retryAfterSeconds = 0): string {
  switch (reason) {
    case "locked":
      // The copy now matches the mechanism. Naming the actual wait is the whole
      // point of SEC-4: "temporarily locked, contact your administrator" was a
      // promise the system did not keep, and it sent people to the wrong place.
      return retryAfterSeconds > 0
        ? `Too many failed attempts. Try again in ${describeWait(retryAfterSeconds)}, or ask an administrator to unlock the account.`
        : "Too many failed attempts. Ask an administrator to unlock the account.";
    case "ip_throttled":
      return "Too many sign-in attempts from this connection. Wait a few minutes and try again.";
    case "mfa_required":
      // Reached only if a caller renders this instead of showing the code
      // form. Kept exhaustive so adding a failure reason is a type error.
      return "Enter the code from your authenticator app.";
    default:
      // invalid_credentials, no_membership and tenant_inactive all collapse to
      // the same message on purpose.
      return GENERIC_LOGIN_ERROR;
  }
}
