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
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
export const SESSION_COOKIE = "meridian_session";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionContext {
  readonly sessionId: string;
  readonly principal: Principal;
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string };
  readonly tenant: { readonly id: string; readonly brandName: string };
  readonly expiresAt: Date;
}

export interface CreatedSession {
  /** Give this to the client once. It is never recoverable afterwards. */
  readonly token: string;
  readonly expiresAt: Date;
}

export async function createSession(input: {
  userId: string;
  tenantId: string;
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
}): Promise<CreatedSession> {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.execute(sql`
    select app_auth_create_session(
      ${input.userId}::uuid,
      ${input.tenantId}::uuid,
      ${hashToken(token)},
      ${input.userAgent ?? null},
      ${input.ipAddress ?? null},
      ${expiresAt.toISOString()}::timestamptz
    )
  `);

  return { token, expiresAt };
}

interface ResolveRow extends Record<string, unknown> {
  session_id: string;
  expires_at: string | Date;
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
