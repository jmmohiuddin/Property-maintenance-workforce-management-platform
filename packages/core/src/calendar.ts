/**
 * The UAE working calendar.
 *
 * `JOB-6`. The PRD calls this "the requirement most likely to be missed and
 * most expensive to miss", and the reason is that three of the four rules below
 * carry a statutory penalty rather than a commercial one.
 *
 * ── WHY THIS IS ONE MODULE AND NOT FOUR ─────────────────────────────────────
 *
 * Every SLA calculation, schedule view, availability check and assignment
 * decision reads from this calendar. A working-hours rule that is implemented
 * once in the scheduler, once in the SLA calculator and once in the field app
 * is three rules that will disagree, and the disagreement will be discovered by
 * an inspector rather than by a test.
 *
 * So there are exactly three entry points — `isWorkingTime()`,
 * `nextWorkingWindow()` and `workingDeadline()` — and everything else consumes
 * those.
 *
 * ── WHY THERE IS NO TIMEZONE LIBRARY ────────────────────────────────────────
 *
 * `packages/core` has zero runtime dependencies, and that is what makes it
 * shareable with the field app. Asia/Dubai makes this affordable: **UTC+4,
 * fixed, no daylight saving, ever.** So a fixed-offset conversion is not an
 * approximation here — it is exact. If this system ever operates in a zone with
 * DST, this assumption breaks and must be replaced with a real tz database
 * rather than patched.
 *
 * ── THE FOUR RULES ──────────────────────────────────────────────────────────
 *
 *  1. **Summer midday ban.** No outdoor work in direct sun, 12:30–15:00, from
 *     15 June to 15 September. AED 5,000 per worker found working, capped at
 *     AED 50,000, plus a company classification downgrade. This is a HARD
 *     BLOCK: the dispatcher must not be able to click through it.
 *  2. **Ramadan.** Working hours reduced by two per day for the month.
 *  3. **Public holidays.** Maintained annually as reference data (`ADM-10`),
 *     because the Islamic-calendar ones are announced each year and cannot be
 *     computed.
 *  4. **Statutory hours.** 8 per day, 48 per week; at least one hour of break
 *     after five consecutive hours; weekend pattern configurable.
 */

// ── Time in Dubai, without a dependency ──────────────────────────────────────

/** Asia/Dubai is UTC+4 with no daylight saving. Exact, not approximate. */
export const DUBAI_UTC_OFFSET_MINUTES = 4 * 60;

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;

/**
 * The wall-clock fields a Dubai reader would see on a clock and a calendar.
 *
 * Computed by shifting the instant by the fixed offset and then reading it in
 * UTC — which is the standard trick, and is only safe because the offset really
 * is fixed.
 */
export interface DubaiTime {
  readonly year: number;
  /** 1–12, so it reads like a date rather than like a Date. */
  readonly month: number;
  readonly day: number;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
  /** Minutes since local midnight. The form most rules actually compare. */
  readonly minutesOfDay: number;
}

export function toDubai(instant: Date): DubaiTime {
  const shifted = new Date(instant.getTime() + DUBAI_UTC_OFFSET_MINUTES * MINUTE);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** The instant at a given Dubai wall-clock time. Inverse of `toDubai`. */
export function fromDubai(
  year: number,
  month: number,
  day: number,
  minutesOfDay = 0,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, 0, minutesOfDay);
  return new Date(asUtc - DUBAI_UTC_OFFSET_MINUTES * MINUTE);
}

/** Dubai-local midnight at the start of the day containing `instant`. */
export function startOfDubaiDay(instant: Date): Date {
  const t = toDubai(instant);
  return fromDubai(t.year, t.month, t.day, 0);
}

/** `YYYY-MM-DD` in Dubai. The key public holidays are stored against. */
export function dubaiDateKey(instant: Date): string {
  const t = toDubai(instant);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

// ── The rules, as configuration ──────────────────────────────────────────────

/**
 * The summer midday ban.
 *
 * Dates and times are data rather than constants in a function body, because
 * they are set by ministerial decision and have moved before. `ADM-10` makes
 * them editable without a deploy; these are the defaults.
 */
export interface MiddayBanRule {
  /** Inclusive start, as [month, day]. */
  readonly from: readonly [number, number];
  /** Inclusive end, as [month, day]. */
  readonly to: readonly [number, number];
  readonly startMinute: number;
  readonly endMinute: number;
  /** Stated in the refusal message. A number changes behaviour; "risk" does not. */
  readonly penalty: string;
}

export const DEFAULT_MIDDAY_BAN: MiddayBanRule = {
  from: [6, 15],
  to: [9, 15],
  startMinute: 12 * 60 + 30, // 12:30
  endMinute: 15 * 60, // 15:00
  penalty: "AED 5,000 per worker, capped at AED 50,000, plus a company classification downgrade",
};

export interface WorkingCalendar {
  /**
   * Weekday numbers that are the weekend. 0 = Sunday … 6 = Saturday.
   *
   * Saturday–Sunday is the common private-sector arrangement and the default,
   * but this is `OPEN-8` and is configured per deployment rather than assumed.
   */
  readonly weekend: readonly number[];
  /** Minutes of day the working day opens and closes. */
  readonly openMinute: number;
  readonly closeMinute: number;
  /** Reduction applied during Ramadan, in minutes. Two hours by statute. */
  readonly ramadanReductionMinutes: number;
  /** `YYYY-MM-DD` → name. Announced annually, so it is data, never computed. */
  readonly publicHolidays: Readonly<Record<string, string>>;
  /**
   * Ramadan periods as `[firstDay, lastDay]` in `YYYY-MM-DD`.
   *
   * Islamic-calendar dates depend on moon sighting and are confirmed a day or
   * two ahead. Computing them from an arithmetic Hijri calendar produces a date
   * that is usually right, and "usually right" is the wrong property for a rule
   * that changes everybody's hours.
   */
  readonly ramadanPeriods: readonly (readonly [string, string])[];
  readonly middayBan: MiddayBanRule;
  /** Statutory maxima. Checked by the scheduler, not enforced here. */
  readonly maxHoursPerDay: number;
  readonly maxHoursPerWeek: number;
  /** A break of at least this long is due after this many consecutive hours. */
  readonly breakAfterHours: number;
  readonly minBreakMinutes: number;
}

/**
 * The default calendar.
 *
 * Public holidays are deliberately EMPTY. A hardcoded list goes stale in
 * January and then silently schedules work on Eid; `ADM-10` makes this
 * reference data an administrator maintains, and an empty list is honest about
 * not knowing rather than confidently wrong. `calendarWarnings()` reports the
 * gap so it is visible rather than assumed.
 */
export const DEFAULT_CALENDAR: WorkingCalendar = {
  weekend: [6, 0], // Saturday, Sunday
  openMinute: 8 * 60,
  closeMinute: 18 * 60,
  ramadanReductionMinutes: 2 * 60,
  publicHolidays: {},
  ramadanPeriods: [],
  middayBan: DEFAULT_MIDDAY_BAN,
  maxHoursPerDay: 8,
  maxHoursPerWeek: 48,
  breakAfterHours: 5,
  minBreakMinutes: 60,
};

// ── Predicates ───────────────────────────────────────────────────────────────

function monthDayValue(month: number, day: number): number {
  return month * 100 + day;
}

/**
 * Is this instant inside the summer midday ban window?
 *
 * Note this is a property of the *instant*, not of the job. Whether it matters
 * depends on whether the work is outdoors — see `checkOutdoorWork`. Indoor work
 * proceeds normally through the window, which is the point people get wrong in
 * both directions.
 */
export function isInMiddayBan(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  const ban = calendar.middayBan;
  const t = toDubai(instant);

  const today = monthDayValue(t.month, t.day);
  const from = monthDayValue(ban.from[0], ban.from[1]);
  const to = monthDayValue(ban.to[0], ban.to[1]);

  // A window that wraps the new year (to < from) would need the opposite test.
  // The summer ban does not wrap, but writing it this way means a rule change
  // that does wrap behaves correctly rather than silently covering no days.
  const inSeason = from <= to ? today >= from && today <= to : today >= from || today <= to;
  if (!inSeason) return false;

  return t.minutesOfDay >= ban.startMinute && t.minutesOfDay < ban.endMinute;
}

export function isPublicHoliday(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  return dubaiDateKey(instant) in calendar.publicHolidays;
}

export function publicHolidayName(
  instant: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): string | null {
  return calendar.publicHolidays[dubaiDateKey(instant)] ?? null;
}

export function isWeekend(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  return calendar.weekend.includes(toDubai(instant).weekday);
}

export function isRamadan(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  const key = dubaiDateKey(instant);
  return calendar.ramadanPeriods.some(([start, end]) => key >= start && key <= end);
}

/** The close time for this particular day, with the Ramadan reduction applied. */
export function closeMinuteFor(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): number {
  const close = calendar.closeMinute;
  return isRamadan(instant, calendar) ? close - calendar.ramadanReductionMinutes : close;
}

/** Is this a day the business works at all? */
export function isWorkingDay(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  return !isWeekend(instant, calendar) && !isPublicHoliday(instant, calendar);
}

/**
 * Is this instant inside normal working hours?
 *
 * Entry point one of three. Deliberately does NOT consider the midday ban:
 * 13:00 on 1 July is working time for an electrician in a plant room and is
 * not for a painter on a roof. That distinction is the job's, not the clock's,
 * and it lives in `checkOutdoorWork`.
 */
export function isWorkingTime(instant: Date, calendar: WorkingCalendar = DEFAULT_CALENDAR): boolean {
  if (!isWorkingDay(instant, calendar)) return false;
  const minutes = toDubai(instant).minutesOfDay;
  return minutes >= calendar.openMinute && minutes < closeMinuteFor(instant, calendar);
}

// ── The hard block ───────────────────────────────────────────────────────────

export type OutdoorRefusalReason = "midday_ban";

export interface OutdoorWorkCheck {
  readonly allowed: boolean;
  readonly reason?: OutdoorRefusalReason;
  /** Plain language, naming the rule and the penalty. Shown to the dispatcher. */
  readonly message?: string;
  /** The first legal instant at or after the requested one. Never just refuse. */
  readonly nextAllowed?: Date;
}

/**
 * The hard block (`JOB-6`, and the reason `ADR-0012` exists).
 *
 * Three things this returns, and all three matter:
 *
 *  - **A refusal**, not a warning. The design document's rule is that a rule
 *    with a penalty is a wall, not a sign. A dispatcher cannot click through
 *    this one.
 *  - **The penalty as a number.** "AED 5,000 per worker" changes behaviour;
 *    "compliance risk" does not.
 *  - **The next legal slot.** Refusing without offering an alternative is how a
 *    hard block gets worked around, and a workaround is invisible.
 */
export function checkOutdoorWork(
  instant: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): OutdoorWorkCheck {
  if (!isInMiddayBan(instant, calendar)) return { allowed: true };

  const ban = calendar.middayBan;
  const t = toDubai(instant);
  const nextAllowed = fromDubai(t.year, t.month, t.day, ban.endMinute);

  return {
    allowed: false,
    reason: "midday_ban",
    message:
      `Outdoor work in direct sun is prohibited between ${formatMinute(ban.startMinute)} and ` +
      `${formatMinute(ban.endMinute)}, from ${formatMonthDay(ban.from)} to ${formatMonthDay(ban.to)}. ` +
      `Penalty: ${ban.penalty}.`,
    nextAllowed,
  };
}

/**
 * Does a whole window of outdoor work touch the ban?
 *
 * A visit from 11:00 to 14:00 starts legally and becomes illegal at 12:30. A
 * check on the start instant alone would pass it, which is the obvious bug in
 * the obvious implementation.
 */
export function checkOutdoorWindow(
  start: Date,
  end: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): OutdoorWorkCheck {
  const atStart = checkOutdoorWork(start, calendar);
  if (!atStart.allowed) return atStart;

  const ban = calendar.middayBan;
  const t = toDubai(start);

  // The ban window on the start's own day. If the visit runs into it, the visit
  // is refused — and the alternative offered is after the ban ends, not before
  // it starts, because a shortened visit is a different job.
  if (isInMiddayBanSeason(start, calendar)) {
    const banStart = fromDubai(t.year, t.month, t.day, ban.startMinute);
    const banEnd = fromDubai(t.year, t.month, t.day, ban.endMinute);

    if (start < banEnd && end > banStart) {
      return {
        allowed: false,
        reason: "midday_ban",
        message:
          `This outdoor visit runs into the summer midday ban ` +
          `(${formatMinute(ban.startMinute)}–${formatMinute(ban.endMinute)}, ` +
          `${formatMonthDay(ban.from)} to ${formatMonthDay(ban.to)}). Penalty: ${ban.penalty}.`,
        nextAllowed: banEnd,
      };
    }
  }

  return { allowed: true };
}

/** Is the date inside the ban season, irrespective of the time of day? */
export function isInMiddayBanSeason(
  instant: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): boolean {
  const ban = calendar.middayBan;
  const t = toDubai(instant);
  const today = monthDayValue(t.month, t.day);
  const from = monthDayValue(ban.from[0], ban.from[1]);
  const to = monthDayValue(ban.to[0], ban.to[1]);
  return from <= to ? today >= from && today <= to : today >= from || today <= to;
}

// ── Moving through working time ──────────────────────────────────────────────

/** Guard against an unmaintained calendar spinning forever. Two years of days. */
const MAX_SEARCH_DAYS = 730;

/**
 * The next instant at or after `from` that is working time.
 *
 * Entry point two of three. Returns `from` unchanged when it is already
 * working time, so callers can use it unconditionally.
 *
 * `outdoor` additionally skips the midday ban, which is what makes this usable
 * as the "offer them 15:00 instead" half of a refusal.
 */
export function nextWorkingWindow(
  from: Date,
  options: { outdoor?: boolean; calendar?: WorkingCalendar } = {},
): Date {
  const calendar = options.calendar ?? DEFAULT_CALENDAR;
  let cursor = from;

  for (let guard = 0; guard < MAX_SEARCH_DAYS * 3; guard++) {
    const t = toDubai(cursor);

    if (!isWorkingDay(cursor, calendar)) {
      cursor = fromDubai(t.year, t.month, t.day + 1, calendar.openMinute);
      continue;
    }

    const close = closeMinuteFor(cursor, calendar);

    if (t.minutesOfDay < calendar.openMinute) {
      cursor = fromDubai(t.year, t.month, t.day, calendar.openMinute);
      continue;
    }
    if (t.minutesOfDay >= close) {
      cursor = fromDubai(t.year, t.month, t.day + 1, calendar.openMinute);
      continue;
    }

    if (options.outdoor && isInMiddayBan(cursor, calendar)) {
      cursor = fromDubai(t.year, t.month, t.day, calendar.middayBan.endMinute);
      continue;
    }

    return cursor;
  }

  // Unreachable unless the calendar marks every day non-working, which would be
  // a configuration error rather than a scheduling one. Failing loudly beats
  // returning a date two years out that nobody notices.
  throw new Error(
    "No working time found within two years. Check the weekend, holiday and hours configuration.",
  );
}

/** Working minutes between two instants. The unit SLA deadlines are counted in. */
export function workingMinutesBetween(
  start: Date,
  end: Date,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): number {
  if (end <= start) return 0;

  let total = 0;
  let cursor = startOfDubaiDay(start);

  for (let guard = 0; guard < MAX_SEARCH_DAYS; guard++) {
    if (cursor > end) break;

    const t = toDubai(cursor);
    const dayStart = fromDubai(t.year, t.month, t.day, calendar.openMinute);
    const dayEnd = fromDubai(t.year, t.month, t.day, closeMinuteFor(cursor, calendar));

    if (isWorkingDay(cursor, calendar)) {
      const from = start > dayStart ? start : dayStart;
      const to = end < dayEnd ? end : dayEnd;
      if (to > from) total += Math.round((to.getTime() - from.getTime()) / MINUTE);
    }

    cursor = fromDubai(t.year, t.month, t.day + 1, 0);
  }

  return total;
}

/**
 * Add `minutes` of *working* time to `from`.
 *
 * Entry point three of three, and the one that fixes `JOB-3`. A P3 job raised
 * at 18:00 on a Thursday used to breach at 18:00 on Friday — overnight, over a
 * weekend, while nobody was working and nobody could have responded. Counting
 * in working minutes makes the deadline one the business can actually meet, and
 * therefore one worth alerting on.
 */
export function addWorkingMinutes(
  from: Date,
  minutes: number,
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
): Date {
  if (minutes <= 0) return from;

  let remaining = minutes;
  let cursor = nextWorkingWindow(from, { calendar });

  for (let guard = 0; guard < MAX_SEARCH_DAYS; guard++) {
    const t = toDubai(cursor);
    const close = closeMinuteFor(cursor, calendar);
    const availableToday = close - t.minutesOfDay;

    if (remaining <= availableToday) {
      return new Date(cursor.getTime() + remaining * MINUTE);
    }

    remaining -= availableToday;
    cursor = nextWorkingWindow(fromDubai(t.year, t.month, t.day + 1, calendar.openMinute), {
      calendar,
    });
  }

  throw new Error("Could not place a deadline within two years of working time.");
}

/**
 * The SLA deadline for a target, computed the right way for its priority.
 *
 * `JOB-3` and `JOB-4` together: **P1 emergency stays wall-clock**, because an
 * active leak at 02:00 on a Saturday is still an emergency and the 24/7 line
 * exists precisely to answer it. **P2–P4 count working minutes**, because a
 * deadline that elapses while the business is legitimately closed is not a
 * service failure — it is a badly computed number that generates a false alarm
 * and trains people to ignore the real ones.
 */
export function workingDeadline(
  from: Date,
  minutes: number,
  options: { wallClock?: boolean; calendar?: WorkingCalendar } = {},
): Date {
  if (options.wallClock) return new Date(from.getTime() + minutes * MINUTE);
  return addWorkingMinutes(from, minutes, options.calendar ?? DEFAULT_CALENDAR);
}

// ── Statutory hours ──────────────────────────────────────────────────────────

export interface HoursCheck {
  readonly withinLimits: boolean;
  readonly warnings: readonly string[];
}

/**
 * Check a technician's hours against the statutory maxima (`HR-8`, `HR-10`).
 *
 * Warns rather than blocks, deliberately. The design rule is that exactly three
 * things are hard blocks — expired work permit, expired blocking document, the
 * midday ban — and that adding a fourth requires naming a penalty it prevents.
 * Exceeding 48 hours in a week is a labour-claim exposure rather than an
 * on-the-spot fine, and a system that blocks it outright gets worked around by
 * simply not recording the hours, which is strictly worse.
 */
export function checkStatutoryHours(
  input: { minutesToday: number; minutesThisWeek: number; longestStretchMinutes?: number },
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
  /**
   * The day being checked, so the Ramadan reduction reaches the daily maximum.
   *
   * Optional, and absent it behaves exactly as before — the eight-hour limit
   * flat. `HR-8` needs the other behaviour: during Ramadan the statutory day is
   * two hours shorter, and a check that only shortens the *closing time* while
   * leaving the *limit* at eight reports a nine-hour Ramadan day as one hour
   * over when it is three. Every caller that knows the date should pass it.
   */
  options: { on?: Date } = {},
): HoursCheck {
  const warnings: string[] = [];
  const ramadan = options.on !== undefined && isRamadan(options.on, calendar);
  const dayLimitMinutes = calendar.maxHoursPerDay * 60 - (ramadan ? calendar.ramadanReductionMinutes : 0);
  const dayLimit = Math.max(0, dayLimitMinutes);
  const weekLimit = calendar.maxHoursPerWeek * 60;

  if (input.minutesToday > dayLimit) {
    warnings.push(
      `${formatHours(input.minutesToday)} today exceeds the statutory maximum of ${formatHours(dayLimit)} per day` +
        `${ramadan ? " (Ramadan: reduced by two hours)" : ""}.`,
    );
  }
  if (input.minutesThisWeek > weekLimit) {
    warnings.push(
      `${formatHours(input.minutesThisWeek)} this week exceeds the statutory maximum of ${calendar.maxHoursPerWeek} hours per week.`,
    );
  }
  if (
    input.longestStretchMinutes !== undefined &&
    input.longestStretchMinutes > calendar.breakAfterHours * 60
  ) {
    warnings.push(
      `${formatHours(input.longestStretchMinutes)} without a break. A break of at least ` +
        `${calendar.minBreakMinutes} minutes is due after ${calendar.breakAfterHours} consecutive hours.`,
    );
  }

  return { withinLimits: warnings.length === 0, warnings };
}

// ── Configuration health ─────────────────────────────────────────────────────

/**
 * What is missing from this calendar, in plain language.
 *
 * Surfaced by the admin screen and worth logging at boot. An empty holiday list
 * is not an error — it is the honest default — but it *is* something somebody
 * has to fix before the scheduler can be trusted, and an unmaintained calendar
 * fails silently by scheduling work on Eid.
 */
export function calendarWarnings(
  calendar: WorkingCalendar = DEFAULT_CALENDAR,
  now: Date = new Date(),
): readonly string[] {
  const warnings: string[] = [];
  const year = toDubai(now).year;

  const holidaysThisYear = Object.keys(calendar.publicHolidays).filter((d) =>
    d.startsWith(String(year)),
  );
  if (holidaysThisYear.length === 0) {
    warnings.push(
      `No public holidays configured for ${year}. Work will be scheduled on Eid, National Day and ` +
        `every other holiday until they are entered (ADM-10).`,
    );
  }

  const ramadanThisYear = calendar.ramadanPeriods.filter(([start]) => start.startsWith(String(year)));
  if (ramadanThisYear.length === 0) {
    warnings.push(
      `No Ramadan period configured for ${year}. The statutory two-hour daily reduction will not be ` +
        `applied (ADM-10).`,
    );
  }

  return warnings;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** `750` → `"12:30"`. */
export function formatMinute(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60) % 24;
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatMonthDay([month, day]: readonly [number, number]): string {
  return `${day} ${MONTH_NAMES[month - 1] ?? month}`;
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} hours`;
}

/** `DD MMM YYYY, HH:MM` in Dubai. The format the whole UI uses. */
export function formatDubai(instant: Date): string {
  const t = toDubai(instant);
  const month = (MONTH_NAMES[t.month - 1] ?? "").slice(0, 3);
  return `${String(t.day).padStart(2, "0")} ${month} ${t.year}, ${formatMinute(t.minutesOfDay)}`;
}

/** Total minutes in a day, exported so callers do not restate 1440. */
export const MINUTES_PER_DAY = DAY_MINUTES;
