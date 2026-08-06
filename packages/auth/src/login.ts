import { sql } from "drizzle-orm";
import { db } from "@meridian/db";
import { verifyPassword, fakeVerify } from "./password";
import { createSession, type CreatedSession } from "./session";
import { beginMfaChallenge, type Challenge } from "./mfa";

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
 */

const MAX_FAILED_ATTEMPTS = 8;

export type LoginResult =
  | { readonly ok: true; readonly session: CreatedSession; readonly tenantId: string }
  /**
   * Password accepted, second factor outstanding. This is NOT a partial
   * session: the challenge grants nothing until a code is verified, and the
   * caller must not create a session from it.
   */
  | { readonly ok: false; readonly reason: "mfa_required"; readonly challenge: Challenge }
  | { readonly ok: false; readonly reason: Exclude<LoginFailure, "mfa_required"> };

export type LoginFailure =
  | "invalid_credentials"
  | "locked"
  | "no_membership"
  | "tenant_inactive"
  | "mfa_required";

interface LookupRow extends Record<string, unknown> {
  user_id: string;
  password_hash: string | null;
  failed_login_count: string | null;
  mfa_enabled: boolean;
  tenant_id: string | null;
  role: string | null;
  membership_active: boolean | null;
  tenant_active: boolean | null;
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

  const result = await db.execute<LookupRow>(sql`select * from app_auth_lookup(${email})`);
  const rows = result as unknown as LookupRow[];
  const user = rows[0];

  if (!user || !user.password_hash) {
    // Spend comparable time so response timing does not reveal that the
    // address is unknown or has no password set.
    await fakeVerify(input.password);
    return { ok: false, reason: "invalid_credentials" };
  }

  if (Number(user.failed_login_count ?? "0") >= MAX_FAILED_ATTEMPTS) {
    await fakeVerify(input.password);
    return { ok: false, reason: "locked" };
  }

  const valid = await verifyPassword(input.password, user.password_hash);

  if (!valid) {
    await db.execute(sql`select app_auth_record_failure(${user.user_id}::uuid)`);
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

/** The single message shown for every failure. Do not vary it by reason. */
export const GENERIC_LOGIN_ERROR = "Email or password is incorrect.";

export function messageForFailure(reason: LoginFailure): string {
  switch (reason) {
    case "locked":
      return "This account is temporarily locked after too many failed attempts. Contact your administrator.";
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
