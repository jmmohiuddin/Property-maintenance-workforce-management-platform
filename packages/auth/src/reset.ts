import { randomBytes, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, type TenantScopedTx, type TenantContext } from "@meridian/db";
import { checkRateLimit } from "@meridian/db/domain";
import { hashPassword } from "./password";

/**
 * Password reset, and staff invitation.
 *
 * `SEC-5` / `ADM-2`, and `ADM-1`. Before this, there was no way to recover an
 * account or create a user without a database client — which is precisely what
 * the PRD means when it says the definition of MVP is *run one real operating
 * week without opening a database client*.
 *
 * ── THE PROPERTIES THAT MATTER ──────────────────────────────────────────────
 *
 * Each of these is a specific attack that the obvious implementation permits:
 *
 *  1. **Hashed at rest.** The raw token exists only in the emailed link. A
 *     database dump otherwise yields a working account-takeover link for every
 *     user who has ever requested a reset.
 *  2. **Single use, enforced by the UPDATE.** Consuming is a conditional
 *     write, not a read-then-write, so two concurrent uses of a copied link
 *     cannot both succeed.
 *  3. **Generic response.** "If that address exists, we have sent a link" —
 *     always, whether or not it does. A response that varies is an account
 *     enumeration oracle, and the reset form is the easiest place to find one.
 *  4. **Sessions die on reset.** If the reset was prompted by a compromise,
 *     leaving the attacker's session alive defeats the whole exercise.
 *  5. **Throttled twice.** Per IP, and per account. The per-account limit
 *     matters because flooding one person's inbox is a good way to bury a real
 *     security email.
 *  6. **An invitation never overwrites an existing password.** Otherwise
 *     "invite an address you do not control" becomes account takeover.
 */

const TOKEN_BYTES = 32;

/**
 * Thirty minutes. Long enough to find the email on a phone, short enough that
 * a link left in a shared or forwarded inbox stops being useful quickly.
 */
export const RESET_TTL_MS = 30 * 60 * 1000;

/**
 * Seven days for an invitation. Longer than a reset because a new starter may
 * not begin until Monday — but still bounded, since an unbounded invitation is
 * a permanent unauthenticated route into the tenant.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Per-IP throttle on requesting a reset. */
export const RESET_IP_LIMIT = 10;
export const RESET_IP_WINDOW_SECONDS = 15 * 60;

/** Per-account throttle, so one address cannot be flooded. */
export const RESET_ACCOUNT_LIMIT = 3;
export const RESET_ACCOUNT_WINDOW_MINUTES = 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export interface IssuedReset {
  /**
   * The raw token, for the emailed link. Returned exactly once and never
   * recoverable — the database holds only its hash.
   */
  readonly token: string;
  readonly expiresAt: Date;
  readonly email: string;
  readonly fullName: string;
}

/**
 * Request a password reset.
 *
 * Returns `null` when no link should be sent — unknown address, no usable
 * membership, or throttled. **The caller must render the same response either
 * way.** That is why this returns null rather than throwing or reporting a
 * reason: there is no branch here for a caller to accidentally surface.
 */
export async function requestPasswordReset(input: {
  email: string;
  ipAddress?: string | undefined;
}): Promise<IssuedReset | null> {
  const email = input.email.trim().toLowerCase();

  if (input.ipAddress) {
    const decision = await checkRateLimit({
      bucket: `reset:${input.ipAddress}`,
      limit: RESET_IP_LIMIT,
      windowSeconds: RESET_IP_WINDOW_SECONDS,
    });
    if (decision.degraded) {
      console.warn("[auth] reset IP throttle degraded; allowing", { ip: input.ipAddress });
    }
    if (!decision.allowed) return null;
  }

  const found = (await db.execute<{ app_reset_find_user: string | null }>(
    sql`select app_reset_find_user(${email})`,
  )) as unknown as { app_reset_find_user: string | null }[];

  const userId = found[0]?.app_reset_find_user ?? null;
  if (!userId) return null;

  const recent = (await db.execute<{ app_reset_recent_count: number }>(
    sql`select app_reset_recent_count(${userId}::uuid, ${RESET_ACCOUNT_WINDOW_MINUTES})`,
  )) as unknown as { app_reset_recent_count: number }[];

  if ((recent[0]?.app_reset_recent_count ?? 0) >= RESET_ACCOUNT_LIMIT) {
    // Deliberately silent to the caller. Telling the requester they have hit a
    // per-account limit confirms the account exists, which is the one thing
    // this whole flow is careful not to do.
    console.warn("[auth] password reset throttled for an account", { userId });
    return null;
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);

  await db.execute(sql`
    select app_reset_issue(
      ${userId}::uuid,
      ${hashToken(token)},
      ${expiresAt.toISOString()}::timestamptz,
      ${input.ipAddress ?? null}
    )
  `);

  const who = (await db.execute<{ user_id: string; email: string; full_name: string }>(
    sql`select * from app_reset_peek(${hashToken(token)})`,
  )) as unknown as { user_id: string; email: string; full_name: string }[];

  const row = who[0];
  if (!row) return null;

  return { token, expiresAt, email: row.email, fullName: row.full_name };
}

export interface ResetSubject {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

/**
 * Is this token live? Used to decide whether to render the form at all.
 *
 * Showing a password form for a dead link, accepting a new password, and only
 * then refusing it is a worse experience than saying so up front — and it
 * teaches users that the link "sometimes works", which is how expired links get
 * retried instead of re-requested.
 */
export async function peekResetToken(token: string): Promise<ResetSubject | null> {
  if (!token) return null;

  const rows = (await db.execute<{ user_id: string; email: string; full_name: string }>(
    sql`select * from app_reset_peek(${hashToken(token)})`,
  )) as unknown as { user_id: string; email: string; full_name: string }[];

  const row = rows[0];
  return row ? { userId: row.user_id, email: row.email, fullName: row.full_name } : null;
}

export type ResetOutcome =
  | { readonly ok: true; readonly userId: string }
  | { readonly ok: false; readonly reason: "invalid_or_expired" | "weak_password" };

/**
 * Minimum password length.
 *
 * Length only, no composition rules. Mandatory symbol-and-digit rules produce
 * `Password1!` and a sticky note; length is the property that actually
 * correlates with strength. Twelve is the current NIST-aligned floor for a
 * human-chosen secret.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols — a short password with a "!" on the end is still short.`;
  }
  return null;
}

/**
 * Consume a reset token and set the new password.
 *
 * The token check and the password write happen in one SQL function so the gap
 * between them cannot be raced. Every other live token for the user is consumed
 * at the same time, and every session is revoked.
 */
export async function completePasswordReset(input: {
  token: string;
  password: string;
}): Promise<ResetOutcome> {
  if (passwordProblem(input.password)) return { ok: false, reason: "weak_password" };

  const passwordHash = await hashPassword(input.password);

  const rows = (await db.execute<{ app_reset_consume: string | null }>(
    sql`select app_reset_consume(${hashToken(input.token)}, ${passwordHash})`,
  )) as unknown as { app_reset_consume: string | null }[];

  const userId = rows[0]?.app_reset_consume ?? null;
  return userId ? { ok: true, userId } : { ok: false, reason: "invalid_or_expired" };
}

// ── Invitations (ADM-1) ──────────────────────────────────────────────────────

export interface IssuedInvitation {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Invite a member of staff.
 *
 * Authorisation is the caller's job — the server action checks `users:manage`
 * and writes the audit row. This is the mechanism.
 *
 * Re-inviting the same address revokes the outstanding invitation first, so an
 * older email cannot be used after a role has been changed. That is enforced by
 * a partial unique index as well as by this code, because two mechanisms is the
 * right number for anything that grants access.
 */
export async function inviteStaff(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    email: string;
    fullName: string;
    role: string;
    /**
     * Set for a portal invitation (`POR-8`), null for staff.
     *
     * Carried through to the membership on acceptance. A `customer` role
     * without this would be a portal login scoped to nothing —
     * `requirePortalSession` refuses that rather than rendering an unscoped
     * portal, which is the safe failure but not a useful one.
     */
    customerId?: string | undefined;
  },
): Promise<IssuedInvitation> {
  // Takes a scoped transaction rather than opening its own, and that is a
  // correction rather than a convenience.
  //
  // Issuing an invitation is an AUTHENTICATED act performed by an administrator
  // who already has a tenant context — unlike accepting one, which is
  // unauthenticated by definition and goes through a SECURITY DEFINER function.
  // The first version of this bypassed `withTenant`, and RLS refused it. That
  // refusal was correct: writing a row that grants access to a tenant, from
  // outside that tenant's boundary, is exactly what the boundary is for.
  //
  // It also means the invitation is enqueued in the same transaction as the
  // audit row and the notification, so an invitation cannot exist for an action
  // that rolled back.
  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const email = input.email.trim().toLowerCase();

  // Re-inviting revokes the outstanding link first, so an older email cannot be
  // accepted after a role has been changed. A partial unique index enforces the
  // same thing at the database level — two mechanisms is the right number for
  // anything that grants access.
  await tx.execute(sql`
    update user_invitations
       set revoked_at = now(), updated_at = now()
     where tenant_id = ${ctx.tenantId}::uuid
       and lower(email) = ${email}
       and accepted_at is null
       and revoked_at is null
  `);

  await tx.execute(sql`
    insert into user_invitations (tenant_id, email, full_name, role, customer_id, token_hash, expires_at, invited_by_id)
    values (
      ${ctx.tenantId}::uuid,
      ${email},
      ${input.fullName.trim()},
      ${input.role}::user_role,
      ${input.customerId ?? null},
      ${hashToken(token)},
      ${expiresAt.toISOString()}::timestamptz,
      ${ctx.userId ?? null}
    )
  `);

  return { token, expiresAt };
}

export interface InvitationSubject {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly brandName: string;
  /** Non-null for a portal invitation. */
  readonly customerId: string | null;
}

export async function peekInvitation(token: string): Promise<InvitationSubject | null> {
  if (!token) return null;

  const rows = (await db.execute<{
    invitation_id: string;
    tenant_id: string;
    email: string;
    full_name: string;
    role: string;
    brand_name: string;
    customer_id: string | null;
  }>(sql`select * from app_invite_peek(${hashToken(token)})`)) as unknown as {
    invitation_id: string;
    tenant_id: string;
    email: string;
    full_name: string;
    role: string;
    brand_name: string;
    customer_id: string | null;
  }[];

  const row = rows[0];
  if (!row) return null;

  return {
    invitationId: row.invitation_id,
    tenantId: row.tenant_id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    brandName: row.brand_name,
    customerId: row.customer_id,
  };
}

export async function acceptInvitation(input: {
  token: string;
  password: string;
}): Promise<ResetOutcome> {
  if (passwordProblem(input.password)) return { ok: false, reason: "weak_password" };

  const passwordHash = await hashPassword(input.password);

  const rows = (await db.execute<{ app_invite_accept: string | null }>(
    sql`select app_invite_accept(${hashToken(input.token)}, ${passwordHash})`,
  )) as unknown as { app_invite_accept: string | null }[];

  const userId = rows[0]?.app_invite_accept ?? null;
  return userId ? { ok: true, userId } : { ok: false, reason: "invalid_or_expired" };
}

/** Delete reset tokens whose expiry is long past. Called by `/api/cron/sweep`. */
export async function sweepResetTokens(olderThanDays = 7): Promise<number> {
  const rows = (await db.execute<{ app_reset_sweep: number }>(
    sql`select app_reset_sweep(${olderThanDays})`,
  )) as unknown as { app_reset_sweep: number }[];
  return Number(rows[0]?.app_reset_sweep ?? 0);
}
