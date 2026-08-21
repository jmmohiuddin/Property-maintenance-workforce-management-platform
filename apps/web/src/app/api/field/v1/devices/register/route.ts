import { NextResponse } from "next/server";
import { withTenant } from "@meridian/db";
import { registerFieldDevice, checkRateLimit } from "@meridian/db/domain";
import { issueDeviceToken } from "@meridian/auth";
import { UserFacingError } from "@meridian/core";
import { getSession } from "@/lib/session";
import { fieldError } from "../../_device";

/**
 * `POST /api/field/v1/devices/register` (`SEC-7`).
 *
 * The only way a handset acquires a credential, and the one route in this API
 * that is authenticated by a **session** rather than by a device token —
 * necessarily, since the device has no token yet.
 *
 * ── WHY THIS IS NOT A SEPARATE LOGIN ────────────────────────────────────────
 *
 * The technician signs in on the phone through the same login the web uses:
 * their password, their lockout curve, their second factor, their session row.
 * Building a device-specific credential exchange would have meant a second
 * authentication path with its own rate limiting, its own lockout and its own
 * bugs — and it is the path that would be reachable from every handset in the
 * field. There is exactly one place in this system where a password is checked
 * and this route is downstream of it.
 *
 * ── WHY IT REFUSES ANYBODY WHO IS NOT A TECHNICIAN ──────────────────────────
 *
 * A device is bound to a `technician_id`, and every read and write the field
 * API performs is scoped to that technician's own work. A session with no
 * technician record has nothing to scope to: registering one would produce a
 * device whose working set is empty and whose mutations are all refused, which
 * is a confusing way to say "you are not a field engineer".
 */
export const dynamic = "force-dynamic";

/** Registrations per user per hour. A phone is registered once, not hourly. */
const REGISTER_LIMIT = 5;
const REGISTER_WINDOW_SECONDS = 3600;

/** Read a value under either the snake_case or the camelCase spelling. */
function str(source: Record<string, unknown>, snake: string, camel: string): string | null {
  const value = source[snake] ?? source[camel];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return fieldError("unauthenticated", "Sign in to register this device.", 401);

  const technicianId = session.principal.technicianId;
  if (!technicianId) {
    return fieldError(
      "not_a_technician",
      "This account is not a field technician, so a device cannot be registered to it.",
      403,
    );
  }

  // Bucketed by user rather than by IP: every technician on one site shares an
  // IP, and rate-limiting the site would lock out a crew whose colleague is
  // setting up a replacement phone. The limiter fails open (see
  // `domain/ratelimit.ts`) and the `degraded` flag is why that is a decision
  // rather than an oversight.
  const limit = await checkRateLimit({
    bucket: `field-register:${session.user.id}`,
    limit: REGISTER_LIMIT,
    windowSeconds: REGISTER_WINDOW_SECONDS,
  });
  if (!limit.allowed) {
    return fieldError(
      "rate_limited",
      "This account has registered several devices in the last hour. Try again later.",
      429,
    );
  }
  if (limit.degraded) {
    console.error("[field] device registration ran without a working rate limiter");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fieldError("bad_request", "This request was not understood.", 400);
  }

  const issued = issueDeviceToken();

  try {
    const device = await withTenant(
      { tenantId: session.tenant.id, userId: session.user.id, actorKind: "user" },
      async (tx) =>
        registerFieldDevice(
          tx,
          { tenantId: session.tenant.id, userId: session.user.id, actorKind: "user" },
          {
            technicianId,
            userId: session.user.id,
            label: String(body["label"] ?? "").trim() || `${session.user.fullName}'s phone`,
            platform: String(body["platform"] ?? ""),
            // Both spellings accepted on the way in, for the reason the
            // mutations route gives: tolerating one cannot be wrong, and
            // refusing one is a 400 a technician reads as "sync failed".
            appVersion: str(body, "app_version", "appVersion"),
            osVersion: str(body, "os_version", "osVersion"),
            tokenHash: issued.tokenHash,
            tokenExpiresAt: issued.expiresAt,
          },
        ),
    );

    // The raw token is handed over exactly once and is never recoverable
    // afterwards, for the reason `session.ts` gives about session tokens: only
    // its hash reaches the database, so a dump yields nothing usable.
    return NextResponse.json({
      device: { id: device.id, technicianId },
      deviceToken: { token: issued.token, expiresAt: issued.expiresAt.toISOString() },
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof UserFacingError) return fieldError("refused", error.message, 400);
    console.error("[field] device registration failed", error);
    return fieldError("server_error", "This device could not be registered. Try again.", 500);
  }
}
