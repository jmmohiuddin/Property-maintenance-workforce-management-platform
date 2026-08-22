"use server";

import { revalidatePath } from "next/cache";
import { withTenant, revokeFieldDevice } from "@meridian/db";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Field device revocation (`SEC-7`).
 *
 * `users:manage` — the same permission that already unlocks an account,
 * resets a second factor and deactivates a membership from `/admin/users`.
 * A lost handset is the same class of incident as those: a credential in the
 * wrong hands that needs killing *now*, by someone who was not holding the
 * device when it went missing. It is not an operational action (nothing here
 * is scoped to "your own" technicians the way dispatch or workforce screens
 * are), so it stays with the administrators rather than moving to
 * `technicians:write`, which a wider set of roles hold.
 */

export interface DeviceActionState {
  readonly error?: string;
  readonly success?: string;
}

export async function revokeDevice(
  _prev: DeviceActionState,
  formData: FormData,
): Promise<DeviceActionState> {
  const session = await requireSessionWith("users:manage");

  const deviceId = String(formData.get("deviceId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();

  if (!deviceId) return { error: "No device selected." };
  if (!reason) return { error: "Say why the device is being revoked — lost, replaced, or returned." };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        revokeFieldDevice(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { deviceId, reason },
        ),
    );
    if (!result.revoked) {
      return { error: "That device is already revoked, or no longer exists." };
    }
  } catch (error) {
    return { error: userMessage(error, "Could not revoke that device.", "field-device") };
  }

  revalidatePath("/admin/devices");
  return {
    success:
      "Device revoked. It can no longer sync or pull new work — their password, sessions and employment record are unchanged.",
  };
}
