import { eq, and, isNull } from "drizzle-orm";
import { withTenant, schema } from "@meridian/db";
import { UserFacingError } from "@meridian/core";
import {
  generateSecret,
  generateRecoveryCodes,
  otpauthUri,
  verifyTotp,
} from "./totp";
import { hashRecoveryCode } from "./mfa";
import { revokeAllSessionsForUser } from "./session";

/**
 * Enrolling in, and withdrawing from, two-factor authentication.
 *
 * Unlike the challenge surface in `mfa.ts`, none of this needs a
 * `SECURITY DEFINER` function: a user enrolling is already signed in, so
 * `app_current_user()` resolves and the ordinary `users` policy lets them read
 * and update their own row. Adding a definer function here would widen the
 * unauthenticated attack surface to solve a problem that does not exist.
 *
 * The flow is deliberately two-step — start, then confirm with a live code —
 * because writing the secret on the first request would enrol an account
 * against a QR nobody successfully scanned, and lock its owner out.
 */

export interface EnrolmentStart {
  /** Show once, alongside the QR. Never stored until confirmation. */
  readonly secret: string;
  readonly uri: string;
}

export function startEnrolment(input: { issuer: string; account: string }): EnrolmentStart {
  const secret = generateSecret();
  return { secret, uri: otpauthUri({ ...input, secret }) };
}

export interface EnrolmentResult {
  /** Shown exactly once. Only their hashes are stored. */
  readonly recoveryCodes: readonly string[];
}

/**
 * Confirm enrolment with a code generated from the pending secret.
 *
 * The code is checked against the secret the caller is enrolling with, not
 * against anything stored, which is the whole point: it proves the
 * authenticator app actually holds the secret before the account starts
 * requiring it.
 */
export async function confirmEnrolment(input: {
  tenantId: string;
  userId: string;
  secret: string;
  code: string;
}): Promise<EnrolmentResult> {
  const verified = verifyTotp(input.secret, input.code);
  if (!verified.ok) {
    throw new UserFacingError(
      "That code does not match. Check your authenticator app is showing the new entry, and try the current code.",
    );
  }

  const recoveryCodes = generateRecoveryCodes();

  await withTenant(
    { tenantId: input.tenantId, userId: input.userId, actorKind: "user" },
    async (tx) => {
      const updated = await tx
        .update(schema.users)
        .set({
          mfaSecret: input.secret,
          mfaEnabledAt: new Date(),
          // Start the replay guard at the step just used, so the code that
          // proved enrolment cannot immediately be replayed as a login.
          mfaLastStep: verified.step,
          updatedAt: new Date(),
        })
        .where(and(eq(schema.users.id, input.userId), isNull(schema.users.deletedAt)))
        .returning({ id: schema.users.id });

      if (updated.length === 0) throw new UserFacingError("Could not enable two-factor sign-in.");

      // Replace rather than append: enrolling afresh must not leave codes from
      // a previous enrolment usable.
      await tx.delete(schema.userRecoveryCodes).where(eq(schema.userRecoveryCodes.userId, input.userId));
      await tx.insert(schema.userRecoveryCodes).values(
        recoveryCodes.map((code) => ({
          userId: input.userId,
          codeHash: hashRecoveryCode(code),
        })),
      );
    },
  );

  return { recoveryCodes };
}

/**
 * Turn it off.
 *
 * Requires a current code, because the threat this defends against is someone
 * sitting at an unlocked, already-signed-in machine: without the check, a
 * second factor can be removed by exactly the person it exists to stop.
 *
 * Every other session is revoked afterwards. Weakening an account's protection
 * is precisely when a session you did not start should stop working.
 */
export async function disableMfa(input: {
  tenantId: string;
  userId: string;
  code: string;
  /** Kept alive. The caller's own session just proved a factor. */
  currentSessionId?: string | undefined;
}): Promise<void> {
  const secret = await withTenant(
    { tenantId: input.tenantId, userId: input.userId },
    async (tx) => {
      const rows = await tx
        .select({ secret: schema.users.mfaSecret, lastStep: schema.users.mfaLastStep })
        .from(schema.users)
        .where(eq(schema.users.id, input.userId))
        .limit(1);
      return rows[0] ?? null;
    },
  );

  if (!secret?.secret) throw new UserFacingError("Two-factor sign-in is not enabled.");

  const verified = verifyTotp(secret.secret, input.code, { lastUsedStep: secret.lastStep });
  if (!verified.ok) {
    // A recovery code is accepted here too: someone whose phone is gone still
    // has to be able to switch it off, and they hold a single-use secret to
    // prove it. Spending one is the cost.
    const spent = await withTenant(
      { tenantId: input.tenantId, userId: input.userId, actorKind: "user" },
      async (tx) => {
        const consumed = await tx
          .update(schema.userRecoveryCodes)
          .set({ usedAt: new Date() })
          .where(
            and(
              eq(schema.userRecoveryCodes.userId, input.userId),
              eq(schema.userRecoveryCodes.codeHash, hashRecoveryCode(input.code)),
              isNull(schema.userRecoveryCodes.usedAt),
            ),
          )
          .returning({ id: schema.userRecoveryCodes.id });
        return consumed.length > 0;
      },
    );

    if (!spent) throw new UserFacingError("That code is not right.");
  }

  await withTenant(
    { tenantId: input.tenantId, userId: input.userId, actorKind: "user" },
    async (tx) => {
      await tx
        .update(schema.users)
        .set({ mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null, updatedAt: new Date() })
        .where(eq(schema.users.id, input.userId));

      await tx
        .delete(schema.userRecoveryCodes)
        .where(eq(schema.userRecoveryCodes.userId, input.userId));
    },
  );

  await revokeAllSessionsForUser(input.userId, input.currentSessionId);
}

export interface MfaStatus {
  readonly enabled: boolean;
  readonly enabledAt: Date | null;
  readonly recoveryCodesRemaining: number;
}

export async function getMfaStatus(input: {
  tenantId: string;
  userId: string;
}): Promise<MfaStatus> {
  return withTenant({ tenantId: input.tenantId, userId: input.userId }, async (tx) => {
    const rows = await tx
      .select({ enabledAt: schema.users.mfaEnabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);

    const codes = await tx
      .select({ id: schema.userRecoveryCodes.id })
      .from(schema.userRecoveryCodes)
      .where(
        and(
          eq(schema.userRecoveryCodes.userId, input.userId),
          isNull(schema.userRecoveryCodes.usedAt),
        ),
      );

    return {
      enabled: rows[0]?.enabledAt != null,
      enabledAt: rows[0]?.enabledAt ?? null,
      recoveryCodesRemaining: codes.length,
    };
  });
}
