"use server";

import { revalidatePath } from "next/cache";
import { withTenant, resolveFieldConflict } from "@meridian/db";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Recording a dispatcher's verdict on a field conflict (§8.4, ADR 0004).
 *
 * `jobs:update` rather than a new permission: resolving is a judgement call
 * about a job's history, held by the same roles — dispatcher, supervisor,
 * operations manager, admin, owner — who can already change a job's state.
 * `jobs:read` (required to see the dispatch board at all) is not enough on
 * its own; this is a write.
 */

export interface ConflictActionState {
  readonly error?: string;
  readonly success?: string;
}

const RESOLUTIONS = ["accepted", "rejected", "superseded"] as const;
type Resolution = (typeof RESOLUTIONS)[number];

function isResolution(value: string): value is Resolution {
  return (RESOLUTIONS as readonly string[]).includes(value);
}

/**
 * `resolveFieldConflict` records the verdict and nothing else — it does not
 * reopen the job, write an outcome or bill a visit. Those are `transitionJob`'s
 * and `recordJobOutcome`'s job, with their own checks, and routing them
 * through here would be a second, unchecked path into them. If the job still
 * needs reopening or correcting, that happens from the job page.
 */
export async function resolveConflict(
  _prev: ConflictActionState,
  formData: FormData,
): Promise<ConflictActionState> {
  const session = await requireSessionWith("jobs:update");

  const conflictId = String(formData.get("conflictId") ?? "").trim();
  const rawResolution = String(formData.get("resolution") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!conflictId) return { error: "No conflict selected." };
  if (!isResolution(rawResolution)) {
    return { error: "Choose accepted, rejected, or superseded." };
  }

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        resolveFieldConflict(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { conflictId, resolution: rawResolution, note: note || null },
        ),
    );
    if (!result.resolved) {
      return { error: "That conflict is already resolved, or no longer exists." };
    }
  } catch (error) {
    return { error: userMessage(error, "Could not record that decision.", "field-conflict") };
  }

  revalidatePath("/dispatch/conflicts");
  revalidatePath("/dispatch");
  return {
    success:
      "Decision recorded. The job itself has not changed — reopen it or correct its outcome from the job page if that is still needed.",
  };
}
