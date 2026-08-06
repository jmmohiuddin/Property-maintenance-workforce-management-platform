"use server";

import { revalidatePath } from "next/cache";
import { startEnrolment, confirmEnrolment, disableMfa, otpauthUri } from "@meridian/auth";
import { tenant, qrSvg } from "@meridian/core";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface SecurityState {
  error?: string;
  ok?: string;
  /** Present only while enrolment is in progress. Never persisted. */
  pending?: { secret: string; qr: string };
  /** Shown exactly once, immediately after enrolment. */
  recoveryCodes?: string[];
}

/**
 * Step one: produce a secret and a QR, without touching the account.
 *
 * Nothing is written here. If the user closes the tab, walks away, or scans a
 * code their phone silently fails to save, the account is exactly as it was —
 * which is the whole reason enrolment is two steps rather than one.
 */
export async function beginEnrolment(): Promise<SecurityState> {
  const session = await requireSession();

  const { secret, uri } = startEnrolment({
    issuer: tenant.brandName,
    account: session.user.email,
  });

  return { pending: { secret, qr: qrSvg(uri, { size: 208 }) } };
}

/**
 * Step two: prove the authenticator holds the secret, then enable it.
 *
 * The secret travels back through a hidden field rather than being stashed in a
 * session or a database row. It is not a credential until it is confirmed, and
 * a half-written secret sitting in the users table is exactly the state that
 * locks someone out.
 */
export async function confirmMfa(
  _prev: SecurityState,
  formData: FormData,
): Promise<SecurityState> {
  const session = await requireSession();

  const secret = String(formData.get("secret") ?? "");
  const code = String(formData.get("code") ?? "").trim();

  if (!secret) return { error: "Start again — the enrolment details were lost." };
  if (!code) {
    return {
      error: "Enter the six-digit code your app is showing.",
      pending: { secret, qr: qrSvg(secretUri(secret, session.user.email), { size: 208 }) },
    };
  }

  try {
    const { recoveryCodes } = await confirmEnrolment({
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      secret,
      code,
    });

    revalidatePath("/security");
    return {
      ok: "Two-factor sign-in is on. Save these recovery codes now — they are not shown again.",
      recoveryCodes: [...recoveryCodes],
    };
  } catch (error) {
    // Keep the pending enrolment alive on a wrong code: making the user
    // re-scan a fresh QR because they typed a stale code is a good way to have
    // them give up on the feature entirely.
    return {
      error: userMessage(error, "Could not turn on two-factor sign-in.", "security"),
      pending: { secret, qr: qrSvg(secretUri(secret, session.user.email), { size: 208 }) },
    };
  }
}

export async function turnOffMfa(
  _prev: SecurityState,
  formData: FormData,
): Promise<SecurityState> {
  const session = await requireSession();
  const code = String(formData.get("code") ?? "").trim();

  if (!code) return { error: "Enter a current code, or one of your recovery codes." };

  try {
    await disableMfa({
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      code,
      currentSessionId: session.sessionId,
    });
  } catch (error) {
    return { error: userMessage(error, "Could not turn off two-factor sign-in.", "security") };
  }

  revalidatePath("/security");
  return {
    ok: "Two-factor sign-in is off, and every other session has been signed out.",
  };
}

/**
 * Rebuild the enrolment URI for a secret already in flight.
 *
 * Goes through the same `otpauthUri` the first step used, so a change to the
 * URI format cannot make the retry QR differ from the one originally scanned.
 */
function secretUri(secret: string, account: string): string {
  return otpauthUri({ issuer: tenant.brandName, account, secret });
}
