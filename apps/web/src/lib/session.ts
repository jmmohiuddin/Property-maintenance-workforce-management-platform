import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolveSession, SESSION_COOKIE, MFA_CHALLENGE_COOKIE, type SessionContext } from "@meridian/auth";
import { can, isStaff, type Permission } from "@meridian/auth";

/**
 * Request-scoped session helpers.
 *
 * `requireSession()` is called at the top of every protected page and action.
 * That is deliberately repetitive rather than handled once in middleware:
 * middleware in Next runs on the edge without database access, so it can check
 * that a cookie *exists* but not that the session behind it is still valid,
 * still unrevoked, and still attached to an active membership. A cookie-shaped
 * string is not authentication.
 */

export async function getSession(): Promise<SessionContext | null> {
  const store = await cookies();
  return resolveSession(store.get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/**
 * Require a session that also holds a permission.
 *
 * Redirects to an explanatory page rather than rendering a bare 403, because
 * the usual cause is a role that legitimately does not include this screen -
 * an accountant opening dispatch - and that person needs to know where they
 * *can* go, not just that they were refused.
 */
export async function requireSessionWith(permission: Permission): Promise<SessionContext> {
  const session = await requireStaffSession();
  if (!can(session.principal, permission)) {
    redirect(`/denied?permission=${encodeURIComponent(permission)}`);
  }
  return session;
}

/**
 * Require a STAFF session for the operational application.
 *
 * This is a real security boundary, not tidiness. The `customer` role holds
 * `jobs:read` so that portal users can see their own jobs - but every staff
 * screen queries through `withTenant()`, which scopes to the tenant and NOT to
 * a customer. A portal user reaching /dispatch would therefore see every
 * customer's work. Permission alone is not enough to gate these pages; the
 * role has to be checked too.
 */
export async function requireStaffSession(): Promise<SessionContext> {
  const session = await requireSession();
  if (!isStaff(session.principal.role)) redirect("/portal");
  return session;
}

/**
 * Require a customer-portal session.
 *
 * Guarantees a `customerId`, so every portal query can be run through
 * `withCustomerScope()` and get database-level scoping rather than relying on
 * a WHERE clause somebody might forget.
 */
export async function requirePortalSession(): Promise<
  SessionContext & { customerId: string }
> {
  const session = await requireSession();
  if (isStaff(session.principal.role)) redirect("/dispatch");
  const customerId = session.principal.customerId;
  // A customer-role membership with no customer_id is a misconfiguration, not a
  // state to render around: it would leave the portal unscoped.
  if (!customerId) redirect("/denied?permission=portal");
  return { ...session, customerId };
}

/** Where a session belongs after signing in. */
export function landingPathFor(session: SessionContext): string {
  return isStaff(session.principal.role) ? "/dispatch" : "/portal";
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

/**
 * The half-authenticated cookie.
 *
 * Deliberately a different name and a much shorter life than the session
 * cookie: nothing that reads `meridian_session` can ever be handed one of
 * these by accident, and it dies with the challenge.
 */
export async function setMfaCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(MFA_CHALLENGE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function getMfaCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(MFA_CHALLENGE_COOKIE)?.value;
}

export async function clearMfaCookie(): Promise<void> {
  const store = await cookies();
  store.delete(MFA_CHALLENGE_COOKIE);
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

export async function requestMetadata(): Promise<{ userAgent?: string; ipAddress?: string }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return {
    userAgent: h.get("user-agent") ?? undefined,
    // Left-most entry is the client; the rest are proxies. Trust this only
    // because the deployment terminates TLS at a proxy we control.
    ipAddress: forwarded?.split(",")[0]?.trim() ?? undefined,
  };
}
