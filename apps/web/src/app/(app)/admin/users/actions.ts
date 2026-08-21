"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { withTenant } from "@meridian/db";
import {
  setMembershipActive,
  setMembershipRole,
  revokeInvitation,
  countActiveAdministrators,
  writeAuditNote,
} from "@meridian/db/domain";
import { inviteStaff, unlockAccount, INVITE_TTL_MS } from "@meridian/auth";
import { enqueue, dispatchPending, selectTransport } from "@meridian/notify";
import { absoluteUrl, UserFacingError } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { isAssignableRole, ROLE_LABEL } from "./roles";

/**
 * Staff administration (`ADM-1`, `ADM-3`, `SEC-6`).
 *
 * The screen whose absence means "not a product yet". Every action here
 * replaces something that previously required a database client during an
 * incident — which is the worst possible time to be writing SQL by hand.
 *
 * All of them follow the standard shape: authorise, open a scoped transaction,
 * mutate, audit, enqueue in the same transaction, commit, revalidate.
 */

export interface AdminState {
  readonly error?: string;
  readonly success?: string;
}


function fail(message: string): AdminState {
  return { error: message };
}

/** Invite a member of staff (`ADM-1`). */
export async function invite(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const session = await requireSessionWith("users:manage");

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!email || !email.includes("@")) return fail("Enter a valid email address.");
  if (!fullName) return fail("Enter the person's name — it appears on their invitation.");
  if (!isAssignableRole(role)) {
    // The role list is a closed set, checked server-side. A select element is a
    // suggestion; a form post is whatever the sender chose to put in it, and
    // `customer` here would create a portal login with a staff invitation.
    return fail("Choose a role.");
  }

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      const issued = await inviteStaff(tx, ctx, { email, fullName, role });

      await writeAuditNote(tx, ctx, {
        tableName: "user_invitations",
        action: "invite",
        detail: { email, role, invitedBy: session.user.email },
      });

      // Enqueued inside the transaction: an invitation email must not exist for
      // an invitation that rolled back.
      await enqueue(tx, ctx, {
        channel: "email",
        template: "staff_invitation",
        to: email,
        payload: {
          fullName,
          inviterName: session.user.fullName,
          roleLabel: ROLE_LABEL[role] ?? role,
          acceptUrl: absoluteUrl(`/invite/${issued.token}`),
          expiresInDays: Math.round(INVITE_TTL_MS / 86_400_000),
        },
      });
    });

    await dispatchPending(session.principal.tenantId, { transport: selectTransport() });
  } catch (error) {
    if (error instanceof UserFacingError) return fail(error.message);
    console.error("[admin] invite failed", error);
    return fail("Could not send that invitation. Try again, or check the notifications queue.");
  }

  revalidatePath("/admin/users");
  return { success: `Invitation sent to ${email}.` };
}

/**
 * Unlock an account (`ADM-3`, `SEC-4`).
 *
 * The action that previously required somebody to open a database client, at
 * 07:00, while a dispatcher stood waiting. Lockouts now decay on their own, so
 * this is the "cannot wait" path rather than the only path.
 */
export async function unlock(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const session = await requireSessionWith("users:manage");
  const userId = String(formData.get("userId") ?? "");
  if (!userId) return fail("No account selected.");

  try {
    await unlockAccount(userId);

    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };
    await withTenant(ctx, (tx) =>
      writeAuditNote(tx, ctx, {
        tableName: "users",
        recordId: userId,
        action: "unlock",
        detail: { unlockedBy: session.user.email },
      }),
    );
  } catch (error) {
    console.error("[admin] unlock failed", error);
    return fail("Could not unlock that account.");
  }

  revalidatePath("/admin/users");
  return { success: "Account unlocked. They can sign in now." };
}

/** Deactivate or reactivate a membership. */
export async function setActive(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const session = await requireSessionWith("users:manage");
  const userId = String(formData.get("userId") ?? "");
  const isActive = String(formData.get("isActive") ?? "") === "true";
  if (!userId) return fail("No account selected.");

  // Deactivating yourself is almost always a misclick, and it signs you out
  // mid-action. Refused rather than confirmed, because there is no case where
  // it is the thing somebody meant to do from this screen.
  if (userId === session.principal.userId && !isActive) {
    return fail("You cannot deactivate your own account from here.");
  }

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      if (!isActive) {
        // The check that stops this screen creating the exact situation it
        // exists to prevent: a tenant with nobody who can administer it, and no
        // way back in without SQL.
        const admins = await countActiveAdministrators(tx);
        const target = (await tx.execute<{ role: string }>(
          sql`select role::text as role from memberships where user_id = ${userId}::uuid`,
        )) as unknown as { role: string }[];
        const role = target[0]?.role;
        if ((role === "owner" || role === "admin") && admins <= 1) {
          throw new UserFacingError(
            "That is the last active administrator. Promote somebody else first, or you will lock everyone out of the settings.",
          );
        }
      }

      await setMembershipActive(tx, ctx, { userId, isActive });
    });
  } catch (error) {
    if (error instanceof UserFacingError) return fail(error.message);
    console.error("[admin] setActive failed", error);
    return fail("Could not change that account.");
  }

  revalidatePath("/admin/users");
  return {
    success: isActive
      ? "Account reactivated."
      : "Account deactivated and signed out of every session.",
  };
}

/** Change somebody's role. */
export async function changeRole(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const session = await requireSessionWith("users:manage");
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? "");

  if (!userId) return fail("No account selected.");
  if (!isAssignableRole(role)) return fail("Choose a role.");

  if (userId === session.principal.userId) {
    // Same reasoning as deactivation: demoting yourself out of `users:manage`
    // is a one-way door with a database client on the other side of it.
    return fail("You cannot change your own role from here. Ask another administrator.");
  }

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      const admins = await countActiveAdministrators(tx);
      const target = (await tx.execute<{ role: string }>(
        sql`select role::text as role from memberships where user_id = ${userId}::uuid`,
      )) as unknown as { role: string }[];
      const current = target[0]?.role;

      const demotingLastAdmin =
        (current === "owner" || current === "admin") &&
        role !== "owner" &&
        role !== "admin" &&
        admins <= 1;

      if (demotingLastAdmin) {
        throw new UserFacingError(
          "That is the last active administrator. Promote somebody else first.",
        );
      }

      await setMembershipRole(tx, ctx, { userId, role });
    });
  } catch (error) {
    if (error instanceof UserFacingError) return fail(error.message);
    console.error("[admin] changeRole failed", error);
    return fail("Could not change that role.");
  }

  revalidatePath("/admin/users");
  return { success: `Role changed. They have been signed out and will pick it up on next sign-in.` };
}

/**
 * Reset somebody's second factor (`SEC-6`).
 *
 * The attestation is mandatory, and it is the actual control here — the
 * software cannot verify that an administrator really did confirm an identity
 * over a video call, so it records the claim, names who made it, and makes it
 * permanent in an append-only log.
 *
 * This is the highest-value social-engineering target in the product: "I've
 * lost my phone" is the standard opening line, and an MFA reset performed
 * without out-of-band verification hands over an account. Requiring somebody to
 * type how they verified is not a formality; it is the moment where they have
 * to notice that they did not.
 */
export async function resetMfa(_prev: AdminState, formData: FormData): Promise<AdminState> {
  const session = await requireSessionWith("users:manage");
  const userId = String(formData.get("userId") ?? "");
  const attestation = String(formData.get("attestation") ?? "").trim();

  if (!userId) return fail("No account selected.");
  if (attestation.length < 15) {
    return fail(
      "Say how you verified their identity — the channel and what you checked. This is recorded permanently and it is the whole control.",
    );
  }

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      // Clearing the secret and the enrolment stamp together. Leaving the
      // secret behind would let an old authenticator entry keep working after
      // the reset, which is exactly what a reset is for.
      await tx.execute(sql`
        update users
           set mfa_enabled_at = null, mfa_secret = null, mfa_last_step = null, updated_at = now()
         where id = ${userId}::uuid
      `);

      await tx.execute(sql`
        update sessions set revoked_at = now()
         where user_id = ${userId}::uuid and revoked_at is null
      `);

      await writeAuditNote(tx, ctx, {
        tableName: "users",
        recordId: userId,
        action: "mfa_reset",
        detail: { attestation, resetBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] resetMfa failed", error);
    return fail("Could not reset that second factor.");
  }

  revalidatePath("/admin/users");
  return {
    success: "Second factor removed and every session signed out. They will re-enrol at next sign-in.",
  };
}

/** Cancel an invitation that has not been accepted. */
export async function cancelInvitation(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const session = await requireSessionWith("users:manage");
  const invitationId = String(formData.get("invitationId") ?? "");
  if (!invitationId) return fail("No invitation selected.");

  const ctx = {
    tenantId: session.principal.tenantId,
    userId: session.principal.userId,
    actorKind: "user" as const,
  };

  await withTenant(ctx, (tx) => revokeInvitation(tx, ctx, invitationId));

  revalidatePath("/admin/users");
  return { success: "Invitation cancelled. That link no longer works." };
}
