"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withTenant, rescheduleVisit } from "@meridian/db";
import { requirePermission } from "@meridian/auth";
import { requireSession } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface ScheduleActionState {
  error?: string;
  ok?: string;
}

/**
 * `JOB-7` — move a visit to a new time.
 *
 * `TRD §7.3` order, in full: parse, authorise, open the tenant transaction,
 * check the state machine and the calendar inside it, mutate, audit, commit,
 * then revalidate. The hard blocks are not repeated here — they live in
 * `rescheduleVisit` — because a check in a server action is still a check the
 * cron sweep and the field app would not run.
 *
 * ── WHY THE INPUT IS A DUBAI-LOCAL WALL TIME ────────────────────────────────
 *
 * The grid the dispatcher drags across is drawn in Dubai time, and what they
 * mean by dropping a block on 13:00 is thirteen hundred in Dubai, whatever the
 * server's own zone is. So the form posts a date and a minute-of-day and the
 * conversion to an instant happens once, here, against a fixed +04:00 — the UAE
 * has no daylight saving, which is the property that makes a fixed offset
 * correct rather than merely convenient.
 */
const RescheduleInput = z.object({
  visitId: z.uuid(),
  /** Dubai-local `YYYY-MM-DD`. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a day."),
  /** Dubai-local minutes past midnight. */
  startMinute: z.coerce.number().int().min(0).max(24 * 60 - 1),
  /** Length in minutes. Defaults to the two hours assignment assumes. */
  durationMinutes: z.coerce.number().int().min(15).max(12 * 60).default(120),
});

function dubaiInstant(day: string, minuteOfDay: number): Date {
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minute = String(minuteOfDay % 60).padStart(2, "0");
  return new Date(`${day}T${hour}:${minute}:00+04:00`);
}

export async function moveVisit(
  _prev: ScheduleActionState,
  formData: FormData,
): Promise<ScheduleActionState> {
  const session = await requireSession();

  const parsed = RescheduleInput.safeParse({
    visitId: formData.get("visitId"),
    day: formData.get("day"),
    startMinute: formData.get("startMinute"),
    durationMinutes: formData.get("durationMinutes") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "That is not a time a visit can be moved to." };
  }

  try {
    requirePermission(session.principal, "jobs:assign");
  } catch {
    return { error: "Your role cannot change the schedule." };
  }

  const start = dubaiInstant(parsed.data.day, parsed.data.startMinute);
  if (Number.isNaN(start.getTime())) return { error: "That is not a real date." };
  const end = new Date(start.getTime() + parsed.data.durationMinutes * 60_000);

  let moved: { jobReference: string; technicianName: string };

  try {
    moved = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        rescheduleVisit(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { visitId: parsed.data.visitId, scheduledStart: start, scheduledEnd: end },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "The visit could not be moved.", "schedule") };
  }

  revalidatePath("/schedule");
  revalidatePath("/dispatch");
  revalidatePath("/jobs");

  const when = start.toLocaleString("en-GB", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  });

  return { ok: `${moved.jobReference} moved to ${when} GST for ${moved.technicianName}.` };
}
