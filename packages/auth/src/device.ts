import { randomBytes, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@meridian/db";
import type { Principal, Role } from "./rbac";

/**
 * Device authentication for the field application (`SEC-7`, TRD §8.5).
 *
 * ── WHY A TECHNICIAN'S PHONE CANNOT USE A BROWSER SESSION ───────────────────
 *
 * `session.ts` gives a session eight hours idle and twenty-four hours absolute,
 * and both numbers are correct for the surface they were chosen for: a
 * coordinator at a desk, on a machine somebody else might sit at. Neither is
 * correct for a handset that spends Thursday in a plant room with no signal.
 * A device that has to re-authenticate before it can sync is a device that
 * loses a day of work — which is the single failure ADR 0004 says this product
 * cannot survive.
 *
 * ── WHAT IS THE SAME, WHICH IS EVERYTHING THAT IS A SECURITY PROPERTY ───────
 *
 * This is not a parallel authentication system. Every property that makes
 * `sessions` trustworthy is kept, and kept for the same reason:
 *
 *   * **Database-backed and revocable by a row update.** Not a JWT. A signed
 *     token that the server cannot un-issue is exactly the wrong shape for the
 *     thing this has to do — revoke a phone that is in the back of a taxi.
 *   * **Hashed at rest, SHA-256.** The raw token exists only on the handset. A
 *     backup or a dump yields nothing usable. SHA-256 rather than Argon2 for
 *     the reason `session.ts` gives: 256 bits of CSPRNG output has no guessable
 *     structure to slow an attacker down over, and this runs on every request.
 *   * **Liveness enforced in SQL.** `app_auth_resolve_device` requires the
 *     device unrevoked, the membership active, the tenant active, the
 *     technician active and the user not deleted, so no caller can forget one.
 *
 * ── WHAT IS DIFFERENT, AND WHY ──────────────────────────────────────────────
 *
 * The lifetime, and rotation. A token lives thirty days and is replaced
 * whenever it is more than seven days old and the phone is talking to us
 * anyway. A handset in daily use therefore never expires; one left in a drawer
 * over a month does, and its owner signs in again. That is the right split: the
 * risk of a forgotten handset grows with the time nobody is holding it.
 *
 * ── ROTATION HAS A GRACE WINDOW, AND THAT IS NOT A WEAKENING ────────────────
 *
 * Strict rotation — old token dead the instant the new one is issued — bricks a
 * phone every time the *rotation response* is the packet that goes missing.
 * On a hotel guest network that is not a rare event, and the failure is
 * unrecoverable from the handset: it holds a credential the server has already
 * retired and has no way to ask for another.
 *
 * So the replaced token stays usable for ten minutes. What makes that safe
 * rather than sloppy is that the replaced hash is kept *forever*, so presenting
 * it after the grace has passed is not "not found" — it is a positive signal
 * that a copy of this credential exists somewhere the phone is not. That is
 * theft, and `reuse` is what the caller acts on by revoking the device. Strict
 * rotation would have produced a bland 401 telling nobody anything.
 */

const TOKEN_BYTES = 32;

/** How long a freshly issued device token is valid for. */
export const DEVICE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * How old a token has to be before a sync bothers to replace it.
 *
 * Rotating on every request would be a write per sync for no gain, and would
 * multiply the number of windows in which a lost response can strand a handset.
 * A quarter of the lifetime keeps a working phone permanently ahead of expiry
 * while rotating rarely enough that the grace window is almost never in play.
 */
export const DEVICE_TOKEN_ROTATE_AFTER_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

/** How long the replaced token keeps working after rotation. */
export const DEVICE_TOKEN_GRACE_MS = 1000 * 60 * 10; // 10 minutes

/** The header the field app presents its token in. */
export const DEVICE_TOKEN_HEADER = "x-field-device-token";

export function hashDeviceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedDeviceToken {
  /** Give this to the handset once. It is never recoverable afterwards. */
  readonly token: string;
  /** What goes in the row. */
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

/** Mint a token. Pure: it writes nothing, so the caller owns the transaction. */
export function issueDeviceToken(now: Date = new Date()): IssuedDeviceToken {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return {
    token,
    tokenHash: hashDeviceToken(token),
    expiresAt: new Date(now.getTime() + DEVICE_TOKEN_TTL_MS),
  };
}

/** True when a sync should hand the device a fresh token on its way out. */
export function shouldRotate(tokenIssuedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - tokenIssuedAt.getTime() >= DEVICE_TOKEN_ROTATE_AFTER_MS;
}

export interface DeviceContext {
  readonly deviceId: string;
  readonly label: string;
  readonly technicianId: string;
  /**
   * The principal the device acts as — the technician's own user, with their
   * own role and overrides. §8.5: "the field app is a client, not a privileged
   * actor, and its access is bounded by the technician's own row-level scope."
   */
  readonly principal: Principal;
  readonly user: { readonly id: string; readonly fullName: string; readonly email: string };
  readonly tenant: { readonly id: string; readonly brandName: string };
  readonly tokenIssuedAt: Date;
  readonly tokenExpiresAt: Date;
  /** True when the presented token was the replaced one, still inside grace. */
  readonly usedGraceToken: boolean;
}

/**
 * The outcome of presenting a token.
 *
 * A discriminated union rather than `DeviceContext | null`, because the three
 * refusals need different responses and flattening them loses that: `expired`
 * asks the technician to sign in, `reuse` revokes the handset, and `unknown`
 * says nothing to anybody.
 */
export type DeviceResolution =
  | { readonly ok: true; readonly device: DeviceContext }
  | { readonly ok: false; readonly reason: "unknown" }
  | { readonly ok: false; readonly reason: "expired"; readonly deviceId: string; readonly tenantId: string }
  | { readonly ok: false; readonly reason: "reuse"; readonly deviceId: string; readonly tenantId: string };

interface ResolveDeviceRow extends Record<string, unknown> {
  device_id: string;
  match: string;
  tenant_id: string;
  technician_id: string;
  user_id: string;
  full_name: string;
  email: string;
  brand_name: string;
  role: string;
  overrides: Record<string, boolean> | null;
  label: string;
  // Timestamps from `execute` are strings, not Dates — see domain/_rows.ts.
  token_issued_at: string | Date;
  token_expires_at: string | Date;
}

/**
 * Resolve a raw device token to the technician it belongs to.
 *
 * Runs before any tenant is known, so it goes through the one SECURITY DEFINER
 * function rather than an RLS-scoped query — the same bootstrap problem, and
 * the same answer, as signing in by email.
 */
export async function resolveDeviceToken(token: string | undefined): Promise<DeviceResolution> {
  if (!token) return { ok: false, reason: "unknown" };

  const result = await db.execute<ResolveDeviceRow>(
    sql`select * from app_auth_resolve_device(${hashDeviceToken(token)})`,
  );

  const row = (result as unknown as ResolveDeviceRow[])[0];
  if (!row) return { ok: false, reason: "unknown" };

  if (row.match === "expired" || row.match === "reuse") {
    return { ok: false, reason: row.match, deviceId: row.device_id, tenantId: row.tenant_id };
  }

  return {
    ok: true,
    device: {
      deviceId: row.device_id,
      label: row.label,
      technicianId: row.technician_id,
      principal: {
        userId: row.user_id,
        tenantId: row.tenant_id,
        role: row.role as Role,
        overrides: row.overrides ?? {},
        technicianId: row.technician_id,
      },
      user: { id: row.user_id, fullName: row.full_name, email: row.email },
      tenant: { id: row.tenant_id, brandName: row.brand_name },
      tokenIssuedAt: new Date(row.token_issued_at),
      tokenExpiresAt: new Date(row.token_expires_at),
      usedGraceToken: row.match === "grace",
    },
  };
}
