"use server";

import { redirect } from "next/navigation";
import {
  login,
  completeMfaChallenge,
  messageForFailure,
  messageForMfaFailure,
  GENERIC_LOGIN_ERROR,
} from "@meridian/auth";
import {
  setSessionCookie,
  setMfaCookie,
  getMfaCookie,
  clearMfaCookie,
  requestMetadata,
  getSession,
  landingPathFor,
} from "@/lib/session";

export interface LoginState {
  readonly error?: string;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: GENERIC_LOGIN_ERROR };
  }

  const meta = await requestMetadata();
  const result = await login({ email, password, ...meta });

  if (!result.ok) {
    // Password accepted, second factor outstanding. The challenge is not a
    // session and grants nothing on its own; it goes in its own cookie under
    // its own name so no code path can mistake it for one.
    if (result.reason === "mfa_required") {
      await setMfaCookie(result.challenge.token, result.challenge.expiresAt);
      redirect("/login/verify");
    }

    // The message is deliberately the same for unknown-email and wrong-password.
    // See packages/auth/src/login.ts.
    return { error: messageForFailure(result.reason) };
  }

  await setSessionCookie(result.session.token, result.session.expiresAt);

  // Staff land on dispatch, portal users on the portal. Sending everyone to
  // /dispatch would bounce customers straight back out via requireStaffSession.
  const session = await getSession();
  redirect(session ? landingPathFor(session) : "/dispatch");
}

export interface VerifyState {
  readonly error?: string;
  /** Set when a recovery code was spent, so the user knows to make more. */
  readonly recoveryRemaining?: number;
}

/**
 * Second step of an MFA login.
 *
 * The challenge token comes from the cookie, never from the form: a token in a
 * form field is one copied link away from being replayed by someone else.
 */
export async function verifyMfa(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const token = await getMfaCookie();
  if (!token) {
    return { error: "That sign-in attempt has expired. Enter your email and password again." };
  }

  const code = String(formData.get("code") ?? "").trim();
  if (!code) return { error: "Enter the code from your authenticator app." };

  const meta = await requestMetadata();
  const result = await completeMfaChallenge({ token, code, ...meta });

  if (!result.ok) {
    // A dead challenge should not leave a cookie behind that keeps failing.
    if (result.reason === "expired" || result.reason === "too_many_attempts") {
      await clearMfaCookie();
    }
    return { error: messageForMfaFailure(result.reason) };
  }

  await clearMfaCookie();
  await setSessionCookie(result.session.token, result.session.expiresAt);

  // Someone who just spent a recovery code is sent to the security page rather
  // than to their usual landing screen. They are, by definition, signing in
  // without their authenticator — the useful next step is seeing how many codes
  // they have left and re-issuing a set, not the dispatch board.
  if (result.recoveryCodesRemaining !== undefined) {
    redirect(`/security?recovery_used=${result.recoveryCodesRemaining}`);
  }

  const session = await getSession();
  redirect(session ? landingPathFor(session) : "/dispatch");
}
