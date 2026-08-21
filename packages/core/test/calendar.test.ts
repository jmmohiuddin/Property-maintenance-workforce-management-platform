/**
 * Working calendar unit test.
 *
 * `JOB-6` carries three statutory penalties, so this file is written the way
 * the TRD asks for `core` coverage: every branch, including the ones that only
 * happen on one date a year.
 *
 * The specific scenarios the TRD's §11.3 names as required tests:
 *   - an outdoor job scheduled at 13:00 on 1 July must be REFUSED
 *   - a P3 job raised at 18:00 on a Thursday must not breach overnight
 *
 * Both are below, with the exact instants.
 *
 *   npm run test --workspace=@meridian/core
 *
 * No database required.
 */

import {
  toDubai,
  fromDubai,
  dubaiDateKey,
  isInMiddayBan,
  isInMiddayBanSeason,
  checkOutdoorWork,
  checkOutdoorWindow,
  isWorkingTime,
  isWorkingDay,
  isWeekend,
  isRamadan,
  closeMinuteFor,
  nextWorkingWindow,
  addWorkingMinutes,
  workingMinutesBetween,
  workingDeadline,
  checkStatutoryHours,
  calendarWarnings,
  formatMinute,
  formatDubai,
  DEFAULT_CALENDAR,
  type WorkingCalendar,
} from "../src/calendar";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** Dubai wall-clock → instant, for readable test setup. */
function dxb(y: number, m: number, d: number, hh: number, mm = 0): Date {
  return fromDubai(y, m, d, hh * 60 + mm);
}

console.log("\n— Dubai time, without a timezone library —");

// Asia/Dubai is UTC+4 with no DST. If this ever fails, the fixed-offset
// assumption behind the whole module has been broken.
const noon = dxb(2026, 7, 1, 12, 0);
check("noon Dubai is 08:00 UTC", noon.toISOString(), "2026-07-01T08:00:00.000Z");
check("and reads back as noon", toDubai(noon).minutesOfDay, 12 * 60);
check("date key is Dubai-local", dubaiDateKey(noon), "2026-07-01");

// The case a UTC-based implementation gets wrong: 23:00 UTC is already the
// next day in Dubai.
const lateUtc = new Date("2026-07-01T21:00:00.000Z");
check("21:00 UTC is 01:00 next day in Dubai", dubaiDateKey(lateUtc), "2026-07-02");
check("and the hour is 1", toDubai(lateUtc).hour, 1);

console.log("\n— the summer midday ban (AED 5,000 per worker) —");

// THE test the TRD names: 1 July, 13:00, outdoor. Must be refused.
const julyOneThirteen = dxb(2026, 7, 1, 13, 0);
checkTrue("1 July 13:00 is inside the ban", isInMiddayBan(julyOneThirteen));

const refusal = checkOutdoorWork(julyOneThirteen);
check("outdoor work at 13:00 on 1 July is REFUSED", refusal.allowed, false);
check("and the reason is named", refusal.reason, "midday_ban");
checkTrue("and the penalty is a number, not 'a risk'", refusal.message?.includes("AED 5,000") === true);
// Refusing without an alternative is how a hard block gets worked around.
check("and the next legal slot is offered", refusal.nextAllowed?.toISOString(), dxb(2026, 7, 1, 15, 0).toISOString());

// Boundaries. 12:30 is banned, 15:00 is not — a half-open interval, so a job
// starting exactly at 15:00 is legal.
checkTrue("12:29 is legal", !isInMiddayBan(dxb(2026, 7, 1, 12, 29)));
checkTrue("12:30 is banned", isInMiddayBan(dxb(2026, 7, 1, 12, 30)));
checkTrue("14:59 is banned", isInMiddayBan(dxb(2026, 7, 1, 14, 59)));
checkTrue("15:00 is legal", !isInMiddayBan(dxb(2026, 7, 1, 15, 0)));

// Season boundaries: 15 June and 15 September are both inclusive.
checkTrue("14 June 13:00 is outside the season", !isInMiddayBan(dxb(2026, 6, 14, 13, 0)));
checkTrue("15 June 13:00 is inside", isInMiddayBan(dxb(2026, 6, 15, 13, 0)));
checkTrue("15 September 13:00 is inside", isInMiddayBan(dxb(2026, 9, 15, 13, 0)));
checkTrue("16 September 13:00 is outside", !isInMiddayBan(dxb(2026, 9, 16, 13, 0)));
checkTrue("1 January 13:00 is outside", !isInMiddayBan(dxb(2026, 1, 1, 13, 0)));

// Indoor work is unaffected, and getting this wrong in either direction is the
// common mistake: blocking everything, or blocking nothing.
checkTrue("indoor work at 13:00 on 1 July is fine", isWorkingTime(dxb(2026, 7, 1, 13, 0)));

// A window that STARTS legally and runs into the ban. The obvious
// implementation checks only the start instant and lets this through.
const straddling = checkOutdoorWindow(dxb(2026, 7, 1, 11, 0), dxb(2026, 7, 1, 14, 0));
check("an 11:00–14:00 outdoor visit is refused", straddling.allowed, false);
check("and is offered the post-ban slot", straddling.nextAllowed?.toISOString(), dxb(2026, 7, 1, 15, 0).toISOString());

const beforeBan = checkOutdoorWindow(dxb(2026, 7, 1, 9, 0), dxb(2026, 7, 1, 12, 0));
checkTrue("a 09:00–12:00 outdoor visit is allowed", beforeBan.allowed);

const afterBan = checkOutdoorWindow(dxb(2026, 7, 1, 15, 0), dxb(2026, 7, 1, 17, 0));
checkTrue("a 15:00–17:00 outdoor visit is allowed", afterBan.allowed);

const winter = checkOutdoorWindow(dxb(2026, 1, 15, 11, 0), dxb(2026, 1, 15, 14, 0));
checkTrue("the same window in January is allowed", winter.allowed);

checkTrue("season check ignores time of day", isInMiddayBanSeason(dxb(2026, 7, 1, 3, 0)));

console.log("\n— weekend, holidays, Ramadan —");

// 2026-08-22 is a Saturday, 2026-08-23 a Sunday, 2026-08-24 a Monday.
checkTrue("Saturday is a weekend", isWeekend(dxb(2026, 8, 22, 10, 0)));
checkTrue("Sunday is a weekend", isWeekend(dxb(2026, 8, 23, 10, 0)));
checkTrue("Monday is not", !isWeekend(dxb(2026, 8, 24, 10, 0)));
checkTrue("Saturday is not a working day", !isWorkingDay(dxb(2026, 8, 22, 10, 0)));

const withHoliday: WorkingCalendar = {
  ...DEFAULT_CALENDAR,
  publicHolidays: { "2026-12-02": "UAE National Day" },
  ramadanPeriods: [["2027-02-17", "2027-03-18"]],
};

checkTrue("a configured holiday is not a working day", !isWorkingDay(dxb(2026, 12, 2, 10, 0), withHoliday));
checkTrue("the day after it is", isWorkingDay(dxb(2026, 12, 3, 10, 0), withHoliday));
checkTrue("the same date is a working day without the config", isWorkingDay(dxb(2026, 12, 2, 10, 0)));

checkTrue("a date inside Ramadan is detected", isRamadan(dxb(2027, 3, 1, 10, 0), withHoliday));
checkTrue("a date outside it is not", !isRamadan(dxb(2027, 4, 1, 10, 0), withHoliday));
check("Ramadan shortens the day by two hours", closeMinuteFor(dxb(2027, 3, 1, 10, 0), withHoliday), 16 * 60);
check("and a normal day is unchanged", closeMinuteFor(dxb(2026, 8, 24, 10, 0), withHoliday), 18 * 60);
checkTrue("17:00 during Ramadan is outside hours", !isWorkingTime(dxb(2027, 3, 1, 17, 0), withHoliday));
checkTrue("17:00 normally is inside hours", isWorkingTime(dxb(2026, 8, 24, 17, 0), withHoliday));

console.log("\n— working hours —");

checkTrue("07:59 is before opening", !isWorkingTime(dxb(2026, 8, 24, 7, 59)));
checkTrue("08:00 is open", isWorkingTime(dxb(2026, 8, 24, 8, 0)));
checkTrue("17:59 is open", isWorkingTime(dxb(2026, 8, 24, 17, 59)));
checkTrue("18:00 is closed", !isWorkingTime(dxb(2026, 8, 24, 18, 0)));

console.log("\n— finding the next working window —");

check(
  "already-working time is returned unchanged",
  nextWorkingWindow(dxb(2026, 8, 24, 10, 0)).toISOString(),
  dxb(2026, 8, 24, 10, 0).toISOString(),
);
check(
  "before opening rolls forward to 08:00 the same day",
  nextWorkingWindow(dxb(2026, 8, 24, 6, 0)).toISOString(),
  dxb(2026, 8, 24, 8, 0).toISOString(),
);
check(
  "after closing rolls to the next morning",
  nextWorkingWindow(dxb(2026, 8, 24, 19, 0)).toISOString(),
  dxb(2026, 8, 25, 8, 0).toISOString(),
);
// Friday 21 Aug 2026 18:00 → skips Sat and Sun → Monday 24th.
check(
  "Friday evening skips the weekend",
  nextWorkingWindow(dxb(2026, 8, 21, 19, 0)).toISOString(),
  dxb(2026, 8, 24, 8, 0).toISOString(),
);
check(
  "outdoor work inside the ban is pushed to 15:00",
  nextWorkingWindow(dxb(2026, 7, 1, 13, 0), { outdoor: true }).toISOString(),
  dxb(2026, 7, 1, 15, 0).toISOString(),
);
check(
  "indoor work inside the ban is not pushed",
  nextWorkingWindow(dxb(2026, 7, 1, 13, 0)).toISOString(),
  dxb(2026, 7, 1, 13, 0).toISOString(),
);

console.log("\n— working-time arithmetic —");

check(
  "two hours inside one working day",
  addWorkingMinutes(dxb(2026, 8, 24, 10, 0), 120).toISOString(),
  dxb(2026, 8, 24, 12, 0).toISOString(),
);
// 16:00 + 4 working hours = 2 hours today (to 18:00) + 2 tomorrow (from 08:00).
check(
  "four hours spills into the next day",
  addWorkingMinutes(dxb(2026, 8, 24, 16, 0), 240).toISOString(),
  dxb(2026, 8, 25, 10, 0).toISOString(),
);

// THE regression the whole module exists for. A P3 job raised at 18:00 on
// Thursday used to breach at 18:00 Friday — overnight and into a weekend
// nobody works. Counting working minutes moves it to Monday.
const thursdayEvening = dxb(2026, 8, 20, 18, 0); // Thursday
const p3Deadline = addWorkingMinutes(thursdayEvening, 24 * 60);
checkTrue("a P3 raised Thursday 18:00 does not breach overnight", p3Deadline > dxb(2026, 8, 21, 8, 0));
checkTrue("nor over the weekend", p3Deadline > dxb(2026, 8, 23, 23, 59));
check("it lands on the following Tuesday morning", dubaiDateKey(p3Deadline), "2026-08-25");

check("a full working day is 10 hours here", workingMinutesBetween(dxb(2026, 8, 24, 0, 0), dxb(2026, 8, 25, 0, 0)), 600);
check("a weekend contributes nothing", workingMinutesBetween(dxb(2026, 8, 22, 0, 0), dxb(2026, 8, 24, 0, 0)), 0);
check("a backwards range is zero, not negative", workingMinutesBetween(dxb(2026, 8, 25, 0, 0), dxb(2026, 8, 24, 0, 0)), 0);

console.log("\n— SLA deadlines by priority (JOB-3, JOB-4) —");

// P1 stays wall-clock. An active leak at 02:00 on a Saturday is still an
// emergency, and the 24/7 line exists to answer it.
const saturdayNight = dxb(2026, 8, 22, 2, 0);
check(
  "P1 is wall-clock, even at 02:00 on a Saturday",
  workingDeadline(saturdayNight, 60, { wallClock: true }).toISOString(),
  dxb(2026, 8, 22, 3, 0).toISOString(),
);
// P2-P4 count working minutes, so the same instant produces a very different
// and much more honest deadline.
const p2 = workingDeadline(saturdayNight, 4 * 60);
check("P2 from the same instant waits for Monday", dubaiDateKey(p2), "2026-08-24");
check("and lands at 12:00", formatMinute(toDubai(p2).minutesOfDay), "12:00");

console.log("\n— statutory hours (warn, never block) —");

check("a normal day is within limits", checkStatutoryHours({ minutesToday: 7 * 60, minutesThisWeek: 40 * 60 }).withinLimits, true);
check("a 9-hour day warns", checkStatutoryHours({ minutesToday: 9 * 60, minutesThisWeek: 40 * 60 }).warnings.length, 1);
check("a 49-hour week warns", checkStatutoryHours({ minutesToday: 7 * 60, minutesThisWeek: 49 * 60 }).warnings.length, 1);
check(
  "six hours without a break warns",
  checkStatutoryHours({ minutesToday: 6 * 60, minutesThisWeek: 30 * 60, longestStretchMinutes: 6 * 60 }).warnings.length,
  1,
);
checkTrue(
  "the day warning names the statutory number",
  checkStatutoryHours({ minutesToday: 9 * 60, minutesThisWeek: 0 }).warnings[0]?.includes("8 hours") === true,
);

console.log("\n— configuration health —");

// An empty holiday list is the honest default, and it is also something
// somebody must fix before the scheduler can be trusted.
check("an unconfigured calendar warns about holidays", calendarWarnings(DEFAULT_CALENDAR, dxb(2026, 8, 24, 10, 0)).length, 2);
check(
  "a configured one does not",
  calendarWarnings(
    { ...DEFAULT_CALENDAR, publicHolidays: { "2026-12-02": "National Day" }, ramadanPeriods: [["2026-02-17", "2026-03-18"]] },
    dxb(2026, 8, 24, 10, 0),
  ).length,
  0,
);

console.log("\n— formatting —");

check("minute formatting pads", formatMinute(12 * 60 + 30), "12:30");
check("and handles midnight", formatMinute(0), "00:00");
check("instants format in Dubai time", formatDubai(dxb(2026, 8, 24, 15, 5)), "24 Aug 2026, 15:05");

console.log(fail === 0 ? "\nAll calendar checks passed.\n" : `\n${fail} check(s) failed.\n`);
process.exit(fail === 0 ? 0 : 1);
