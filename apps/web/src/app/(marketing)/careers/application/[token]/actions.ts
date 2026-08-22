"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { interviewRescheduleRequestSchema, tenant } from "@meridian/core";
import { checkRateLimit } from "@meridian/db";
import { requestInterviewReschedule } from "@meridian/db/domain";

/**
 * The candidate asking to move an interview (`ATS-14`).
 *
 * ── WHY THIS IS BEHIND THE TOKEN THEY ALREADY HAVE ──────────────────────────
 *
 * `applications.status_token` is 64 unguessable characters held by exactly one
 * person, and an interview belongs to exactly one application. A second
 * "reschedule token" would grant a strict subset of what the first grants, to
 * the same holder, for the same purpose — and would add a second secret to
 * leak and a second lost-link phone call. So there is no second token.
 *
 * ── WHY IT ASKS RATHER THAN MOVES ───────────────────────────────────────────
 *
 * There is no new-time field on this form and no argument for one in
 * `app_public_request_interview_reschedule`. A site trial is a supervisor, a
 * bay and a two-hour hole in a working day; a candidate silently moving it is
 * not a convenience, it is two people standing in a yard. The ask is recorded,
 * the application is marked as waiting on us (`ATS-8`), and a person answers.
 *
 * ── WHY IT DOES NOT OPEN A TENANT TRANSACTION ───────────────────────────────
 *
 * Same reason the application form does not: this is an unauthenticated caller,
 * and `withTenant()` would attach a tenant's full row-level-security scope to
 * their request for the rest of its transaction. The whole write happens inside
 * one `SECURITY DEFINER` function instead.
 */
const RESCHEDULE_RATE_LIMIT = 5;
const RESCHEDULE_RATE_WINDOW_SECONDS = 3600;

function clientKey(h: Headers): string {
  // Trusted only because this deployment terminates TLS at a proxy that
  // overwrites it. The same footnote is on the quote form and the application
  // form: behind a different proxy, or none, this is spoofable.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || "unknown";
}

export interface RescheduleFormState {
  status: "idle" | "success" | "error";
  message?: string;
}

export async function requestRescheduleAction(
  _prev: RescheduleFormState,
  formData: FormData,
): Promise<RescheduleFormState> {
  const token = String(formData.get("token") ?? "");
  const parsed = interviewRescheduleRequestSchema.safeParse({
    note: String(formData.get("note") ?? ""),
  });

  if (!parsed.success) {
    return { status: "error", message: "That note is too long — a sentence is plenty." };
  }

  const h = await headers();
  const limit = await checkRateLimit({
    bucket: `reschedule:${clientKey(h)}`,
    limit: RESCHEDULE_RATE_LIMIT,
    windowSeconds: RESCHEDULE_RATE_WINDOW_SECONDS,
  });

  if (!limit.allowed) {
    return {
      status: "error",
      message: `We already have your message. If it is urgent, call ${tenant.phone}.`,
    };
  }

  try {
    const recorded = await requestInterviewReschedule(token, parsed.data.note || undefined);

    if (!recorded) {
      // No live interview, or a token that resolves to nothing. Said the same
      // way in both cases: a different message for "no such token" would
      // confirm that the token space is real and worth probing.
      return {
        status: "error",
        message: `We could not find an appointment to move. Call ${tenant.phone} and we will sort it out.`,
      };
    }
  } catch (error) {
    console.error("[careers] reschedule request failed", error);
    return {
      status: "error",
      message: `Something went wrong on our side — this is not you. Please call ${tenant.phone}.`,
    };
  }

  revalidatePath(`/careers/application/${token}`);
  return {
    status: "success",
    message:
      "Thank you — we have that, and somebody will come back to you with a new time. Do not travel to the original one until you hear from us.",
  };
}
