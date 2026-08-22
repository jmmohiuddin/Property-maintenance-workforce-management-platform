import { randomBytes, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@meridian/db";
import type { Principal, Role } from "./rbac";

/**
 * Session tokens.
 *
 * The raw token exists only in the cookie. The database stores its SHA-256
 * hash, so a database read - a backup, a dump, a SQL injection - does not yield
 * usable session tokens. SHA-256 rather than Argon2 here on purpose: the token
 * is 256 bits of CSPRNG output, so there is no guessable structure to slow an
 * attacker down over, and session validation runs on every request.
 *
 * Every function here goes through an `app_auth_*` SECURITY DEFINER function
 * rather than touching tables directly. See packages/db/sql/auth-functions.sql
 * for why that indirection exists - the short version is that authentication
 * has to happen before a tenant is known, which RLS cannot express.
 */

const TOKEN_BYTES = 32;
export const SESSION_COOKIE = "meridian_session";

/**
 * Two clocks, and both are enforced (`SEC-11`, closing `TD-12`).
 *
 * The session used to have a single fixed 12-hour TTL with no renewal. A
 * coordinator who signed in at 07:00 was signed out at 19:00 — mid-shift, with
 * no warning, losing whatever was in the form they were filling in. That is an
 * availability failure dressed as a security control, because the twelve hours
 * were not protecting anything: the risk from a stolen token is the same at
 * hour 11 as at hour 13.
 *
 * What actually helps is the pair:
 *
 *  * **`SLIDE_MS` — the idle window.** Renewed on activity. A session dies
 *    eight hours after the person stops using it, which is the property that
 *    protects an unattended machine.
 *  * **`ABSOLUTE_MS` — the hard ceiling.** Never moves. This is what stops
 *    "sliding" degrading into "never expires", which would make a stolen token
 *    permanent as long as the thief kept using it.
 *
 * The database enforces the ceiling too — `app_auth_touch_session` clamps with
 * `LEAST(...)` and `app_auth_resolve_session` refuses a session past it. Doing
 * it in both places is deliberate: the clamp is the mechanism, the read check
 * is the guarantee.
 */
const SLIDE_MS = 1000 * 60 * 60 * 8; // 8 hours idle
const ABSOLUTE_MS = 1000 * 60 * 60 * 24; // 24 hours total

/**
 * How close to expiry a session has to be before activity renews it.
 *
 * Renewing on every single request would mean a write on every page view for no
 * benefit. Renewing only in the last quarter of the window keeps the write rate
 * low while making it impossible for an active user to be signed out.
 */
const RENEW_WHEN_REMAINING_MS = SLIDE_MS * 0.25;

/** Warn the user this long before their session ends (`D-11`). */
export const SESSION_WARNING_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionContext {
  readonly sessionId: string;
  readonly principal: Principal;
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string };
  readonly tenant: { readonly id: string; readonly brandName: string };
  /** The sliding expiry, as of this request. Moves forward on activity. */
  readonly expiresAt: Date;
  /** The hard ceiling. Never moves, and is what the warning banner counts to. */
  readonly absoluteExpiresAt: Date | null;
}

export interface CreatedSession {
  /** Give this to the client once. It is never recoverable afterwards. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  tenantId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}): Promise<CreatedSession> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = Date.now();
  const expiresAt = new Date(now + SLIDE_MS);
  const absoluteExpiresAt = new Date(now + ABSOLUTE_MS);

  await db.execute(sql`
    select app_auth_create_session(
      ${input.userId}::uuid,
      ${input.tenantId}::uuid,
      ${hashToken(token)},
      ${input.userAgent ?? null},
      ${input.ipAddress ?? null},
      ${expiresAt.toISOString()}::timestamptz,
      ${absoluteExpiresAt.toISOString()}::timestamptz
    )
  `);

  return { token, expiresAt, absoluteExpiresAt };
}

/**
 * Extend a session on activity, if it is close enough to expiry to be worth a
 * write. Returns the new expiry, or null when nothing changed.
 *
 * Clamped to the absolute ceiling inside the SQL function rather than here, so
 * a caller cannot extend past it by passing a large slide.
 */
export async function touchSession(token: string, expiresAt: Date): Promise<Date | null> {
  const remaining = expiresAt.getTime() - Date.now();
  if (remaining > RENEW_WHEN_REMAINING_MS) return null;

  const rows = (await db.execute<{ app_auth_touch_session: string | null }>(
    sql`select app_auth_touch_session(${hashToken(token)}, ${Math.floor(SLIDE_MS / 1000)})`,
  )) as unknown as { app_auth_touch_session: string | null }[];

  const next = rows[0]?.app_auth_touch_session;
  return next ? new Date(next) : null;
}

interface ResolveRow extends Record<string, unknown> {
  session_id: string;
  expires_at: string | Date;
  absolute_expires_at: string | Date | null;
  user_id: string;
  full_name: string;
  email: string;
  tenant_id: string;
  brand_name: string;
  role: string;
  overrides: Record<string, boolean> | null;
  customer_id: string | null;
  technician_id: string | null;
}

/**
 * Resolve a raw token to a principal, or null.
 *
 * Liveness conditions - not revoked, not expired, membership active, tenant
 * active - are enforced inside the SQL function so a caller cannot forget one.
 */
export async function resolveSession(token: string | undefined): Promise<SessionContext | null> {
  if (!token) return null;

  const result = await db.execute<ResolveRow>(
    sql`select * from app_auth_resolve_session(${hashToken(token)})`,
  );

  const row = (result as unknown as ResolveRow[])[0];
  if (!row) return null;

  return {
    sessionId: row.session_id,
    expiresAt: new Date(row.expires_at),
    absoluteExpiresAt: row.absolute_expires_at ? new Date(row.absolute_expires_at) : null,
    user: { id: row.user_id, fullName: row.full_name, email: row.email },
    tenant: { id: row.tenant_id, brandName: row.brand_name },
    principal: {
      userId: row.user_id,
      tenantId: row.tenant_id,
      role: row.role as Role,
      overrides: row.overrides ?? {},
      customerId: row.customer_id ?? undefined,
      technicianId: row.technician_id ?? undefined,
    },
  };
}

/** Revoke one session. Used on logout. */
export async function revokeSession(token: string): Promise<void> {
  await db.execute(sql`select app_auth_revoke_session(${hashToken(token)})`);
}

/**
 * Revoke every session for a user. Call on password change, on a suspected
 * compromise, and when a membership is deactivated.
 *
 * `exceptSessionId` keeps the caller's own session alive. That matters where
 * the user is doing the revoking themselves — turning off two-factor sign-in,
 * say — because signing them out of the tab they are working in is both
 * jarring and unnecessary: theirs is the session that just proved a factor.
 * Omit it for the compromise cases, where everything should go.
 */
export async function revokeAllSessionsForUser(
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const result = await db.execute<{ app_auth_revoke_all_sessions: number }>(
    sql`select app_auth_revoke_all_sessions(${userId}::uuid, ${exceptSessionId ?? null})`,
  );
  return (result as unknown as { app_auth_revoke_all_sessions: number }[])[0]
    ?.app_auth_revoke_all_sessions ?? 0;
}
