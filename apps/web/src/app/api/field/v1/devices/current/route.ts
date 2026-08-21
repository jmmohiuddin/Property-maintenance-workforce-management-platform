import { revokeFieldDevice } from "@meridian/db/domain";
import { withDevice } from "../../_device";

/**
 * `DELETE /api/field/v1/devices/current` — sign this handset out (`SEC-7`).
 *
 * ── WHY THE DEVICE CAN REVOKE ITSELF ────────────────────────────────────────
 *
 * Handsets are handed back. A technician leaving, or swapping to a replacement
 * phone, should be able to end the credential from the device they are holding
 * rather than by finding an administrator — and an administrator who has to be
 * found is one who is sometimes not found, which leaves a live token on a phone
 * in a drawer.
 *
 * This is the same revocation an administrator performs, on the same row, with
 * the same effect. What it deliberately is *not* is a way to revoke somebody
 * else's device: the only device id it will accept is the one that
 * authenticated the request.
 *
 * The other direction — revoking a lost phone the technician cannot reach — is
 * a staff action against `revokeFieldDevice` from the workforce screen. Neither
 * disables the person; see that function for why that separation matters.
 */
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  return withDevice(request, async ({ tx, ctx, device }) => {
    const result = await revokeFieldDevice(tx, ctx, {
      deviceId: device.deviceId,
      reason: "Signed out on the device.",
    });
    return { revoked: result.revoked };
  });
}
