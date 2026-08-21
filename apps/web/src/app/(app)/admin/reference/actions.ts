"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@meridian/db";
import {
  addPublicHoliday,
  addRamadanPeriod,
  deletePublicHoliday,
  deleteRamadanPeriod,
  loadCalendarSettings,
  saveCalendarSettings,
  writeAuditNote,
} from "@meridian/db/domain";
import { DEFAULT_CALENDAR, formatMinute } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";

/**
 * Reference data (`ADM-10`).
 *
 * The taxonomies that change on a cabinet announcement rather than on a release
 * schedule. Every action here used to be a code change and a deploy, which in
 * practice meant a holiday announced on a Thursday was entered in March or not
 * at all — and an unentered holiday does not fail loudly, it schedules thirty
 * people onto sites on Eid.
 *
 * `settings:write`, so `owner` only. The working week decides when SLA clocks
 * run and when the scheduler will place a visit; it is not a preference.
 */

export interface ReferenceState {
  readonly error?: string;
  readonly success?: string;
}

function fail(message: string): ReferenceState {
  return { error: message };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `"08:30"` → 510. Returns null for anything an `<input type="time">` would not produce. */
function minutesFromTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

async function context() {
  const session = await requireSessionWith("settings:write");
  return {
    session,
    ctx: {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    },
  };
}

/**
 * The working week (`OPEN-8`).
 *
 * Note what this action cannot do. There is no branch here that touches the
 * summer midday ban, the Ramadan reduction or the statutory maxima, because
 * there is no column for any of them — they are constants in `DEFAULT_CALENDAR`
 * and `loadWorkingCalendar` reads them from there every time. The midday ban is
 * a hard block worth AED 5,000 per worker; a hard block that a form post can
 * switch off is a warning wearing a costume.
 */
export async function saveWorkingWeek(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const weekend = formData
    .getAll("weekend")
    .map((value) => Number(String(value)))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  const unique = [...new Set(weekend)].sort((a, b) => a - b);

  if (unique.length > 6) {
    return fail("At least one day of the week has to be a working day.");
  }

  const openMinute = minutesFromTime(String(formData.get("openTime") ?? ""));
  const closeMinute = minutesFromTime(String(formData.get("closeTime") ?? ""));
  if (openMinute === null || closeMinute === null) {
    return fail("Enter opening and closing times as HH:MM.");
  }
  if (openMinute >= closeMinute) {
    return fail("The working day has to close after it opens.");
  }

  const minBreakMinutes = Number(String(formData.get("minBreakMinutes") ?? ""));
  if (!Number.isInteger(minBreakMinutes) || minBreakMinutes < DEFAULT_CALENDAR.minBreakMinutes) {
    // The statutory floor, restated rather than assumed: a break of at least one
    // hour is due after five consecutive hours worked. The database CHECK
    // refuses anything shorter too, so this message exists to explain the
    // refusal rather than to be the refusal.
    return fail(
      `A break of at least ${DEFAULT_CALENDAR.minBreakMinutes} minutes is due after ` +
        `${DEFAULT_CALENDAR.breakAfterHours} consecutive hours. This can be longer, never shorter.`,
    );
  }

  // Ramadan shortens the day by two hours, so a working day of under two hours
  // closes before it opens once the reduction is applied, and
  // `nextWorkingWindow` then skips every day of the month.
  if (closeMinute - openMinute <= DEFAULT_CALENDAR.ramadanReductionMinutes) {
    return fail(
      `The working day is shorter than the statutory Ramadan reduction of ` +
        `${DEFAULT_CALENDAR.ramadanReductionMinutes / 60} hours, which would leave no working ` +
        `time at all during Ramadan.`,
    );
  }

  try {
    await withTenant(ctx, async (tx) => {
      const before = await loadCalendarSettings(tx);
      await saveCalendarSettings(tx, ctx, {
        weekendDays: unique,
        openMinute,
        closeMinute,
        minBreakMinutes,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "calendar_settings",
        recordId: ctx.tenantId,
        action: "calendar_update",
        detail: {
          from: {
            weekend: before.weekendDays,
            open: formatMinute(before.openMinute),
            close: formatMinute(before.closeMinute),
            minBreakMinutes: before.minBreakMinutes,
          },
          to: {
            weekend: unique,
            open: formatMinute(openMinute),
            close: formatMinute(closeMinute),
            minBreakMinutes,
          },
          changedBy: session.user.email,
        },
      });
    });
  } catch (error) {
    console.error("[admin] working week save failed", error);
    return fail("Could not save the working week. Nothing was changed.");
  }

  revalidatePath("/admin/reference");
  return {
    success:
      "Saved. SLA deadlines raised from now on are counted against these hours; deadlines already " +
      "on existing jobs keep the hours they were computed with.",
  };
}

export async function addHoliday(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const date = String(formData.get("date") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const sourceNote = String(formData.get("sourceNote") ?? "").trim() || null;

  if (!ISO_DATE.test(date)) return fail("Pick a date.");
  if (!name) return fail("Name the holiday — next year's administrator has to recognise it.");

  try {
    await withTenant(ctx, async (tx) => {
      await addPublicHoliday(tx, ctx, { date, name, sourceNote });
      await writeAuditNote(tx, ctx, {
        tableName: "public_holidays",
        action: "holiday_set",
        detail: { date, name, sourceNote, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] add holiday failed", error);
    return fail("Could not save that holiday.");
  }

  revalidatePath("/admin/reference");
  return { success: `${name} on ${date} is now a non-working day.` };
}

export async function removeHoliday(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that holiday");
  if (!id) return fail("No holiday selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await deletePublicHoliday(tx, id);
      await writeAuditNote(tx, ctx, {
        tableName: "public_holidays",
        recordId: id,
        action: "holiday_removed",
        // The label is recorded because the row is gone: an audit entry naming
        // only a uuid answers "when" and never "what".
        detail: { holiday: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] remove holiday failed", error);
    return fail("Could not remove that holiday.");
  }

  revalidatePath("/admin/reference");
  return { success: `${label} removed. It is a working day again.` };
}

export async function addRamadan(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const label = String(formData.get("label") ?? "").trim();
  const startsOn = String(formData.get("startsOn") ?? "").trim();
  const endsOn = String(formData.get("endsOn") ?? "").trim();
  const sourceNote = String(formData.get("sourceNote") ?? "").trim() || null;

  if (!label) return fail("Give the period a name, such as “Ramadan 1447”.");
  if (!ISO_DATE.test(startsOn) || !ISO_DATE.test(endsOn)) return fail("Pick both dates.");
  if (endsOn < startsOn) {
    // String comparison is exact for ISO dates, and the database CHECK refuses
    // it too. An inverted period matches no dates at all, so the reduction
    // would silently never apply.
    return fail("The period has to end after it starts.");
  }

  try {
    await withTenant(ctx, async (tx) => {
      await addRamadanPeriod(tx, ctx, { label, startsOn, endsOn, sourceNote });
      await writeAuditNote(tx, ctx, {
        tableName: "ramadan_periods",
        action: "ramadan_set",
        detail: { label, startsOn, endsOn, sourceNote, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] add ramadan period failed", error);
    return fail("Could not save that period.");
  }

  revalidatePath("/admin/reference");
  return {
    success: `${label} saved. Working days in that period close two hours early.`,
  };
}

export async function removeRamadan(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that period");
  if (!id) return fail("No period selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await deleteRamadanPeriod(tx, id);
      await writeAuditNote(tx, ctx, {
        tableName: "ramadan_periods",
        recordId: id,
        action: "ramadan_removed",
        detail: { period: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] remove ramadan period failed", error);
    return fail("Could not remove that period.");
  }

  revalidatePath("/admin/reference");
  return { success: `${label} removed.` };
}
