"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revokeSession, SESSION_COOKIE } from "@meridian/auth";
import { clearSessionCookie } from "@/lib/session";

/**
 * Sign out.
 *
 * Revokes the session row as well as clearing the cookie. Clearing the cookie
 * alone would leave a valid session token alive on the server for its full TTL,
 * so anyone who captured it - a shared machine, a proxy log - could keep using
 * it after the user believed they had logged out.
 */
export async function signOut(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  await clearSessionCookie();
  redirect("/login");
}
