import { sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";

/**
 * Staff administration (`ADM-1`).
 *
 * The audit's judgement on this was blunt and correct: *there is no way to
 * create a user, a tenant, or a recovered password without SQL.* That is what
 * stops the system being a product. This module, plus the reset flow in
 * `packages/auth`, is the zero-SQL user lifecycle.
 *
 * Everything here runs inside a tenant transaction. Membership rows grant
 * access to a tenant, so writing one from outside that tenant's boundary is
 * exactly what the boundary exists to prevent — the same lesson the invitation
 * flow learned when RLS refused it.
 */

export interface StaffRow {
  readonly userId: string;
  readonly membershipId: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: string;
  readonly isActive: boolean;
  readonly mfaEnabled: boolean;
  readonly lastLoginAt: Date | null;
  /** Non-null while a lockout is in force. Drives the unlock action. */
  readonly lockedUntil: Date | null;
  readonly failedLoginCount: number;
}

/**
 * Everyone with a membership in this tenant, staff and portal users alike.
 *
 * Ordered by consequence rather than alphabetically: locked accounts first
 * because somebody cannot work, then deactivated, then people without a second
 * factor, then everyone else. A dispatcher who cannot sign in at 07:00 is the
 * reason this screen gets opened, so they are what it opens on.
 */
export async function listStaff(tx: TenantScopedTx): Promise<readonly StaffRow[]> {
  const rows = (await tx.execute<{
    user_id: string;
    membership_id: string;
    full_name: string;
    email: string;
    role: string;
    is_active: boolean;
    mfa_enabled: boolean;
    last_login_at: Date | string | null;
    locked_until: Date | string | null;
    failed_login_count: number;
  }>(sql`
    select u.id as user_id,
           m.id as membership_id,
           u.full_name,
           u.email,
           m.role::text as role,
           m.is_active,
           (u.mfa_enabled_at is not null) as mfa_enabled,
           u.last_login_at,
           u.locked_until,
           u.failed_login_count
      from memberships m
      join users u on u.id = m.user_id
     where u.deleted_at is null
     order by
       (u.locked_until is not null and u.locked_until > now()) desc,
       m.is_active asc,
       (u.mfa_enabled_at is null) desc,
       u.full_name
  `)) as unknown as {
    user_id: string;
    membership_id: string;
    full_name: string;
    email: string;
    role: string;
    is_active: boolean;
    mfa_enabled: boolean;
    last_login_at: Date | string | null;
    locked_until: Date | string | null;
    failed_login_count: number;
  }[];

  return rows.map((r) => ({
    userId: r.user_id,
    membershipId: r.membership_id,
    fullName: r.full_name,
    email: r.email,
    role: r.role,
    isActive: r.is_active,
    mfaEnabled: r.mfa_enabled,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
    lockedUntil: r.locked_until ? new Date(r.locked_until) : null,
    failedLoginCount: Number(r.failed_login_count ?? 0),
  }));
}

export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export async function listPendingInvitations(
  tx: TenantScopedTx,
): Promise<readonly PendingInvitation[]> {
  const rows = (await tx.execute<{
    id: string;
    email: string;
    full_name: string;
    role: string;
    expires_at: Date | string;
    created_at: Date | string;
  }>(sql`
    select id, email, full_name, role::text as role, expires_at, created_at
      from user_invitations
     where accepted_at is null
       and revoked_at is null
       and expires_at > now()
     order by created_at desc
  `)) as unknown as {
    id: string;
    email: string;
    full_name: string;
    role: string;
    expires_at: Date | string;
    created_at: Date | string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    role: r.role,
    expiresAt: new Date(r.expires_at),
    createdAt: new Date(r.created_at),
  }));
}

/**
 * Deactivate or reactivate a membership.
 *
 * Deactivation, not deletion. A person who leaves has signed things — job
 * sign-offs, quote approvals, audit entries — and those records name them. A
 * hard delete would either orphan that history or cascade it away, and both are
 * worse than a row with `is_active = false`.
 *
 * Sessions are revoked on deactivation in the same transaction. Without that,
 * somebody removed at 09:00 keeps working until their session expires, which
 * is the entire window a deactivation is meant to close.
 */
export async function setMembershipActive(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { userId: string; isActive: boolean },
): Promise<void> {
  await tx.execute(sql`
    update memberships
       set is_active = ${input.isActive}, updated_at = now()
     where user_id = ${input.userId}::uuid
       and tenant_id = ${ctx.tenantId}::uuid
  `);

  if (!input.isActive) {
    await tx.execute(sql`
      update sessions
         set revoked_at = now()
       where user_id = ${input.userId}::uuid
         and tenant_id = ${ctx.tenantId}::uuid
         and revoked_at is null
    `);
  }
}

/**
 * Change a membership's role.
 *
 * Sessions are revoked too, and that is not belt-and-braces. The principal —
 * role and permissions — is resolved when a session is read, so an existing
 * session keeps whatever role it had. Demoting somebody without revoking is a
 * demotion that does not take effect until they happen to sign out.
 */
export async function setMembershipRole(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { userId: string; role: string },
): Promise<void> {
  await tx.execute(sql`
    update memberships
       set role = ${input.role}::user_role, updated_at = now()
     where user_id = ${input.userId}::uuid
       and tenant_id = ${ctx.tenantId}::uuid
  `);

  await tx.execute(sql`
    update sessions
       set revoked_at = now()
     where user_id = ${input.userId}::uuid
       and tenant_id = ${ctx.tenantId}::uuid
       and revoked_at is null
  `);
}

export async function revokeInvitation(
  tx: TenantScopedTx,
  ctx: TenantContext,
  invitationId: string,
): Promise<void> {
  await tx.execute(sql`
    update user_invitations
       set revoked_at = now(), updated_at = now()
     where id = ${invitationId}::uuid
       and tenant_id = ${ctx.tenantId}::uuid
       and accepted_at is null
       and revoked_at is null
  `);
}

/**
 * How many owners or admins does this tenant have who can still sign in?
 *
 * Called before deactivating or demoting one. Locking the last administrator
 * out of the tenant is unrecoverable without a database client — which is
 * precisely the situation `ADM-1` exists to eliminate, so it would be
 * embarrassing for the admin screen to be the thing that causes it.
 */
export async function countActiveAdministrators(tx: TenantScopedTx): Promise<number> {
  const rows = (await tx.execute<{ count: number }>(sql`
    select count(*)::int as count
      from memberships m
      join users u on u.id = m.user_id
     where m.role in ('owner', 'admin')
       and m.is_active
       and u.deleted_at is null
  `)) as unknown as { count: number }[];

  return rows[0]?.count ?? 0;
}

/**
 * Write an explicit audit entry for something a trigger cannot see.
 *
 * Most mutations are audited by the database trigger on the table itself, which
 * is the right default — it captures a direct SQL fix during an incident too.
 * But some records are about the *procedure* rather than the data: `SEC-6`
 * requires an MFA reset to record, in free text, who verified whom and how. No
 * column changes when an administrator confirms an identity over a video call,
 * so no trigger can capture it.
 *
 * The design document's phrasing is the point: **the procedure is the control;
 * the software only records it.** This function is the recording.
 */
export async function writeAuditNote(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    tableName: string;
    recordId?: string | undefined;
    action: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (tenant_id, table_name, record_id, action, changed_fields, actor_id, actor_kind)
    values (
      ${ctx.tenantId}::uuid,
      ${input.tableName},
      ${input.recordId ?? null},
      ${input.action},
      ${JSON.stringify(input.detail)}::jsonb,
      ${ctx.userId ?? null},
      ${ctx.actorKind ?? "user"}
    )
  `);
}
