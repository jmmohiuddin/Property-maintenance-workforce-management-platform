"use server";

import { withTenant } from "@meridian/db";
import { requestPasswordReset, RESET_TTL_MS } from "@meridian/auth";
import { enqueue, dispatchPending, selectTransport } from "@meridian/notify";
import { absoluteUrl } from "@meridian/core";
import { requestMetadata } from "@/lib/session";

/**
 * Request a password reset (`SEC-5`, `ADM-2`).
 *
 * ── THE ONE RULE THIS SCREEN HAS ────────────────────────────────────────────
 *
 * **The response is identical whether or not the address exists.** Always. That
 * is why this action has a single success shape and no error branch for
 * "unknown address": there is no code path here that could leak the difference,
 * rather than a code path that carefully avoids leaking it.
 *
 * A reset form that says "no account found" is an account enumeration oracle
 * with a friendly interface, and it is the easiest one to find on any
 * application.
 *
 * Timing is not equalised, and that is a considered omission rather than an
 * oversight: the work done for an unknown address (one indexed lookup) versus a
 * known one (a lookup, an insert, an enqueue) does differ. Closing that channel
 * properly means queueing the work regardless and responding before it runs,
 * which is worth doing when there is a background worker to hand. Noted here so
 * the next person knows it was weighed.
 */

export interface ForgotState {
  readonly sent?: boolean;
  readonly error?: string;
}

export async function requestReset(_prev: ForgotState, formData: FormData): Promise<ForgotState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    // The only error this form can produce: an empty box. Anything about the
    // address itself would be information about whether it exists.
    return { error: "Enter the email address you sign in with." };
  }

  const meta = await requestMetadata();
  const issued = await requestPasswordReset({ email, ipAddress: meta.ipAddress });

  // Unknown address, no usable membership, or throttled. Same response.
  if (!issued) return { sent: true };

  const tenantSlug = process.env["PUBLIC_TENANT_SLUG"];
  const resetUrl = absoluteUrl(`/reset-password/${issued.token}`);

  try {
    // The notification goes through the same ledgered queue as everything else,
    // so a provider outage delays the email rather than losing it — and the
    // failure is visible in the notifications queue rather than only in a log.
    const tenantId = await resolveTenantId(tenantSlug);
    if (tenantId) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        await enqueue(tx, { tenantId, actorKind: "system" }, {
          channel: "email",
          template: "password_reset",
          to: issued.email,
          payload: {
            fullName: issued.fullName,
            resetUrl,
            expiresInMinutes: Math.round(RESET_TTL_MS / 60000),
          },
        });
      });

      // Drained immediately as well as by the cron. A person staring at a
      // password reset page will not wait five minutes for the next scheduled
      // drain, and this is the one message where latency is the whole product.
      await dispatchPending(tenantId, { transport: selectTransport() });
    }
  } catch (error) {
    // Logged, never surfaced. Telling the user the send failed would confirm
    // the address exists — and they can simply try again.
    console.error("[reset] could not enqueue the reset email", error);
  }

  return { sent: true };
}

/**
 * Resolve the public tenant slug to an id.
 *
 * Uses the same SECURITY DEFINER function the quote form uses, because this is
 * the same bootstrap problem: an unauthenticated visitor whose request has to
 * land in a specific tenant.
 */
async function resolveTenantId(slug: string | undefined): Promise<string | null> {
  if (!slug) {
    console.error("[reset] PUBLIC_TENANT_SLUG is not set; cannot send a reset email");
    return null;
  }

  const { db } = await import("@meridian/db");
  const { sql } = await import("drizzle-orm");

  const rows = (await db.execute<{ app_public_resolve_tenant: string | null }>(
    sql`select app_public_resolve_tenant(${slug})`,
  )) as unknown as { app_public_resolve_tenant: string | null }[];

  return rows[0]?.app_public_resolve_tenant ?? null;
}
