import "server-only";
import { NextResponse } from "next/server";
import { withTenant, type TenantScopedTx, type TenantContext } from "@meridian/db";
import {
  revokeFieldDevice,
  rotateFieldDeviceToken,
  touchFieldDevice,
} from "@meridian/db/domain";
import {
  resolveDeviceToken,
  issueDeviceToken,
  shouldRotate,
  DEVICE_TOKEN_HEADER,
  DEVICE_TOKEN_GRACE_MS,
  type DeviceContext,
} from "@meridian/auth";
import { UserFacingError } from "@meridian/core";

/**
 * The shared shape of every device-authenticated field route (TRD §8.5).
 *
 * Written once for the reason `lib/cron.ts` gives about the scheduled routes:
 * four copies of an authentication check is three chances to get it wrong, and
 * the check here decides whether an unauthenticated caller can write to a job.
 *
 * ── WHAT THIS DOES THAT A `requireSession()` DOES NOT ───────────────────────
 *
 *  1. **Resolves a device, not a cookie.** A phone presents a bearer token in a
 *     header; there is no cookie and no CSRF surface, because there is no
 *     browser and no ambient credential.
 *  2. **Rotates on the way out.** A token older than its rotation age is
 *     replaced and the new one returned in the response body. The old one keeps
 *     working for ten minutes so that losing this response does not strand the
 *     handset — see `packages/auth/src/device.ts` for why that is safety rather
 *     than laxity.
 *  3. **Measures the clock.** Every request carries the device's own time; the
 *     divergence is stored on the device row so a support call about impossible
 *     timestamps has an answer.
 *  4. **Acts on token reuse.** A retired token presented after its grace has
 *     passed did not come from the phone, and the response is to revoke the
 *     device rather than return a bland 401.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * It grants nothing. The handler runs inside `withTenant()` under the
 * technician's own principal, so every read and write is subject to the same
 * row-level policies as the dispatch board. §8.5: "the field app is a client,
 * not a privileged actor."
 */

export interface FieldRequestContext {
  readonly tx: TenantScopedTx;
  readonly ctx: TenantContext;
  readonly device: DeviceContext;
  /** Device clock minus server clock, milliseconds. Null when not reported. */
  readonly clockSkewMs: number | null;
}

/** The device's own clock, as it claims it, from the envelope header. */
export const DEVICE_TIME_HEADER = "x-field-device-time";
const APP_VERSION_HEADER = "x-field-app-version";

export function fieldError(code: string, message: string, status: number): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * The device's credential, from either spelling.
 *
 * `Authorization: Bearer` is what the field client sends and is the ordinary
 * shape for a token that is not a cookie; `x-field-device-token` was this
 * server's first spelling. Both are accepted rather than one being declared
 * correct, because the two halves of this protocol are being written in
 * parallel and a handset that cannot authenticate is not a disagreement worth
 * having. Bearer is the one to keep.
 */
function readToken(request: Request): string | undefined {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) {
    const bearer = header.slice(7).trim();
    if (bearer) return bearer;
  }
  return request.headers.get(DEVICE_TOKEN_HEADER)?.trim() || undefined;
}

/**
 * How far the handset's clock is from ours, or null when it did not say.
 *
 * Null is a real answer and is stored as one. A device that reports no time
 * gets **no correction applied** to its offline timestamps, and `clock_skew_ms`
 * stays null so that an uncorrected value is identifiable as uncorrected. The
 * alternative — assuming zero skew — would silently label a guess as a
 * measurement, which is the thing ADR 0004's two-clock rule exists to prevent.
 */
function readSkew(request: Request, serverTime: number, bodyDeviceTime?: string | null): number | null {
  const raw = request.headers.get(DEVICE_TIME_HEADER) ?? bodyDeviceTime ?? null;
  if (!raw) return null;
  const deviceTime = new Date(raw);
  if (Number.isNaN(deviceTime.getTime())) return null;
  return deviceTime.getTime() - serverTime;
}

/**
 * Run `handler` as an authenticated device.
 *
 * The handler's return value is the response body. Anything it throws is
 * translated the way `lib/errors.ts` translates a failed action: a message the
 * domain deliberately wrote for a human is shown, and everything else is logged
 * where operations can see it and replaced with a sentence that says what to do
 * next. A driver error rendered on a phone in a plant room helps nobody and
 * discloses the schema.
 */
export async function withDevice(
  request: Request,
  handler: (context: FieldRequestContext) => Promise<Record<string, unknown>>,
): Promise<NextResponse> {
  const resolution = await resolveDeviceToken(readToken(request));

  if (!resolution.ok) {
    if (resolution.reason === "reuse") {
      // A retired token, presented after its successor was issued and its grace
      // window closed. A copy of this credential exists somewhere the phone is
      // not. Revoking is the only safe response, and it costs the technician a
      // re-registration rather than costing the company a live stolen handset.
      console.error(
        `[field] retired device token replayed; revoking device ${resolution.deviceId}`,
      );
      await withTenant(
        { tenantId: resolution.tenantId, actorKind: "system" },
        async (tx) =>
          revokeFieldDevice(tx, { tenantId: resolution.tenantId, actorKind: "system" }, {
            deviceId: resolution.deviceId,
            reason: "An old token was replayed after rotation; revoked automatically.",
          }),
      );
      return fieldError(
        "device_revoked",
        "This device has been signed out for security. Sign in again to register it.",
        401,
      );
    }

    if (resolution.reason === "expired") {
      return fieldError(
        "device_expired",
        "This device has not synced for a while and needs signing in again.",
        401,
      );
    }

    // "unknown" covers no token, an unrecognised one, and a revoked device.
    // Deliberately one answer for all three: a caller that can tell them apart
    // learns whether a device id exists.
    return fieldError("device_unknown", "This device is not signed in.", 401);
  }

  const device = resolution.device;
  const serverNow = Date.now();
  const clockSkewMs = readSkew(request, serverNow);
  const appVersion = request.headers.get(APP_VERSION_HEADER);

  const ctx: TenantContext = {
    tenantId: device.tenant.id,
    userId: device.user.id,
    actorKind: "user",
  };

  try {
    const { body, rotated } = await withTenant(ctx, async (tx) => {
      const result = await handler({ tx, ctx, device, clockSkewMs });

      await touchFieldDevice(tx, {
        deviceId: device.deviceId,
        clockSkewMs,
        appVersion,
        pulled: request.method === "GET",
      });

      // Rotation happens inside the same transaction as the work, so a
      // rollback cannot leave the handset holding a token the server has
      // retired. A lost *response* is the case the grace window covers; a lost
      // *transaction* must not rotate at all.
      //
      // A device that authenticated on its grace token is not rotated again:
      // it is already one step behind, and issuing a third token would push
      // the one it holds out of the chain entirely.
      if (!device.usedGraceToken && shouldRotate(device.tokenIssuedAt)) {
        const issued = issueDeviceToken();
        await rotateFieldDeviceToken(tx, {
          deviceId: device.deviceId,
          tokenHash: issued.tokenHash,
          tokenExpiresAt: issued.expiresAt,
          graceUntil: new Date(Date.now() + DEVICE_TOKEN_GRACE_MS),
        });
        return { body: result, rotated: issued };
      }

      return { body: result, rotated: null };
    });

    return NextResponse.json({
      ...body,
      // A rotated token rides back on whatever request triggered the rotation
      // rather than needing a call of its own: a phone that has to make a
      // second request to stay signed in has a second chance to lose it.
      ...(rotated
        ? { deviceToken: { token: rotated.token, expiresAt: rotated.expiresAt.toISOString() } }
        : {}),
    });
  } catch (error) {
    if (error instanceof UserFacingError) {
      return fieldError("refused", error.message, 400);
    }
    console.error("[field] request failed", error);
    return fieldError(
      "server_error",
      "The office could not be reached properly. Your work is saved on this phone and will be sent again.",
      500,
    );
  }
}

/** Parse a JSON body, or refuse. A phone that sends nonsense gets a sentence. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new UserFacingError("This request was not understood.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UserFacingError) throw error;
    throw new UserFacingError("This request was not understood.");
  }
}
