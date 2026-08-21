import type { Metadata } from "next";
import Link from "next/link";
import { withTenant } from "@meridian/db";
import {
  listPublicHolidays,
  listRamadanPeriods,
  loadCalendarSettings,
  loadWorkingCalendar,
} from "@meridian/db/domain";
import { calendarWarnings, formatMinute, toDubai } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import {
  AddHolidayForm,
  AddRamadanForm,
  RemoveButton,
  WorkingWeekForm,
} from "./reference-forms";

export const metadata: Metadata = {
  title: "Reference data",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * `/admin/reference` — `ADM-10`.
 *
 * Taxonomies that change constantly, editable without a deploy. The highest
 * value on this screen is the emptiest part of it: `DEFAULT_CALENDAR` ships
 * with no public holidays and no Ramadan period, deliberately — a hardcoded
 * list goes stale in January — and until somebody fills them in, the scheduler
 * treats Eid as an ordinary Tuesday and says nothing.
 *
 * `calendarWarnings()` has been reporting that gap since the calendar was
 * written. This is the first screen where the gap can be closed.
 */
export default async function AdminReferencePage() {
  const session = await requireSessionWith("settings:write");

  const { holidays, ramadan, settings, calendar } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      holidays: await listPublicHolidays(tx),
      ramadan: await listRamadanPeriods(tx),
      settings: await loadCalendarSettings(tx),
      calendar: await loadWorkingCalendar(tx),
    }),
  );

  const now = new Date();
  const thisYear = toDubai(now).year;
  const warnings = calendarWarnings(calendar, now);
  const ban = calendar.middayBan;

  // Past holidays are kept — they are the record the SLA clock was computed
  // against — but they are not what somebody opening this screen came for.
  const upcoming = holidays.filter((h) => h.date >= isoDate(now));
  const past = holidays.filter((h) => h.date < isoDate(now));

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Reference data</h1>
            <p className="prose-body mt-2 text-[15px]">
              The working calendar the scheduler, the SLA clock and the field app all read.{" "}
              <Link
                href="/admin/company"
                className="underline underline-offset-2"
                style={{ color: "var(--accent-text)" }}
              >
                Company details
              </Link>{" "}
              are on their own screen.
            </p>
          </div>
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            Changes are audited
          </p>
        </header>

        {warnings.length > 0 ? (
          <ul
            className="mt-6 space-y-2 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : null}

        <section className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[15px] font-semibold">Working week</h2>
          <p className="prose-body mt-1 text-[14px]">
            {settings.isStored
              ? "Saved here. SLA deadlines for P2–P4 jobs are counted in these hours rather than in wall-clock time, so a job raised at 18:00 on a Thursday is not judged against a weekend nobody worked."
              : "Still on the defaults — nobody has confirmed the working week yet. Save it once, even unchanged, so it is a decision rather than an assumption."}
          </p>
          <div className="mt-5">
            <WorkingWeekForm
              weekend={settings.weekendDays}
              openTime={formatMinute(settings.openMinute)}
              closeTime={formatMinute(settings.closeMinute)}
              minBreakMinutes={settings.minBreakMinutes}
            />
          </div>
        </section>

        {/*
          Displayed, never offered. There is no control here and no column
          behind it: the ban is statutory, it is one of exactly three hard
          blocks in the system, and the penalty is per worker found working.
          Rendering it as a switch — even a disabled one — would suggest it is
          the kind of thing that has an off position.
        */}
        <section
          className="mt-8 rounded border p-5"
          style={{ backgroundColor: "var(--surface-sunken)" }}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold">Summer midday ban</h2>
            <span
              className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
              style={{
                backgroundColor: "var(--status-blocked-wash)",
                color: "var(--status-blocked-text)",
              }}
            >
              Statutory · not editable
            </span>
          </div>
          <p className="prose-body mt-2 text-[14px]">
            No outdoor work in direct sun between {formatMinute(ban.startMinute)} and{" "}
            {formatMinute(ban.endMinute)}, from {monthDay(ban.from)} to {monthDay(ban.to)}. Penalty:{" "}
            {ban.penalty}.
          </p>
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            The dispatcher cannot click through this one. An outdoor visit that runs into the window
            is refused and offered the next legal slot instead. Indoor work is unaffected — 13:00 on
            1 July is working time for an electrician in a plant room and is not for a painter on a
            roof.
          </p>
        </section>

        <section className="mt-10">
          <h2 className="text-[15px] font-semibold">Public holidays</h2>
          <p className="prose-body mt-1 text-[14px]">
            Announced annually by the cabinet, and the Islamic-calendar ones are confirmed by moon
            sighting a day or two ahead — so they are entered, never calculated. A date that is here
            is a non-working day for scheduling and for every SLA clock.
          </p>

          {holidays.length === 0 ? (
            <div
              className="mt-4 rounded-sm p-4 text-[14px]"
              style={{ backgroundColor: "var(--status-warning-wash)" }}
            >
              <p className="font-medium">No public holidays have been entered.</p>
              <p className="mt-1">
                Until they are, Eid al-Fitr, Eid al-Adha, National Day and every other holiday are
                ordinary working days to the scheduler — it will place visits on them and start SLA
                clocks running. Add the {thisYear} dates below; the fixed ones (1 January, 1
                December, 2–3 December) can go in now, and the rest as they are announced.
              </p>
            </div>
          ) : (
            <>
              <ul className="mt-4 divide-y border-y">
                {upcoming.map((holiday) => (
                  <li key={holiday.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                    <div>
                      <p className="text-[14px] font-medium">
                        {holiday.name}{" "}
                        <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                          · {readableDate(holiday.date)}
                        </span>
                      </p>
                      {holiday.sourceNote ? (
                        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {holiday.sourceNote}
                        </p>
                      ) : null}
                    </div>
                    <RemoveButton
                      kind="holiday"
                      id={holiday.id}
                      label={`${holiday.name} on ${holiday.date}`}
                    />
                  </li>
                ))}
              </ul>

              {upcoming.length === 0 ? (
                <p
                  className="mt-4 rounded-sm p-4 text-[14px]"
                  style={{ backgroundColor: "var(--status-warning-wash)" }}
                >
                  Every holiday on record has already passed. Nothing is entered for the rest of{" "}
                  {thisYear}, so the scheduler will treat the remaining ones as working days.
                </p>
              ) : null}

              {past.length > 0 ? (
                <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {past.length} past {past.length === 1 ? "holiday is" : "holidays are"} kept but not
                  listed — they are what existing SLA deadlines were computed against.
                </p>
              ) : null}
            </>
          )}

          <div
            className="mt-6 rounded border p-5"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h3 className="text-[14px] font-semibold">Add a holiday</h3>
            <div className="mt-4">
              <AddHolidayForm />
            </div>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-[15px] font-semibold">Ramadan</h2>
          <p className="prose-body mt-1 text-[14px]">
            Working hours are reduced by two per day for the month, by statute. Stored as a period
            rather than as dates, because the start moves when the moon is not sighted and moving one
            row is safer than moving thirty.
          </p>

          {ramadan.length === 0 ? (
            <div
              className="mt-4 rounded-sm p-4 text-[14px]"
              style={{ backgroundColor: "var(--status-warning-wash)" }}
            >
              <p className="font-medium">No Ramadan period has been entered.</p>
              <p className="mt-1">
                The statutory two-hour reduction is not being applied to anybody&rsquo;s day. Enter the
                expected dates now and correct them once the start is confirmed — an approximate
                period that gets corrected is far better than none.
              </p>
            </div>
          ) : (
            <ul className="mt-4 divide-y border-y">
              {ramadan.map((period) => (
                <li key={period.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                  <div>
                    <p className="text-[14px] font-medium">
                      {period.label}{" "}
                      <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                        · {readableDate(period.startsOn)} to {readableDate(period.endsOn)}
                      </span>
                    </p>
                    {period.sourceNote ? (
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {period.sourceNote}
                      </p>
                    ) : null}
                  </div>
                  <RemoveButton kind="ramadan" id={period.id} label={period.label} />
                </li>
              ))}
            </ul>
          )}

          <div
            className="mt-6 rounded border p-5"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h3 className="text-[14px] font-semibold">Add a period</h3>
            <div className="mt-4">
              <AddRamadanForm />
            </div>
          </div>
        </section>

        <p className="mt-10 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Every change on this page is written to the audit log with your name against it. Deadlines
          already stored on jobs are not recomputed — a job raised under last week&rsquo;s calendar
          keeps being judged by last week&rsquo;s calendar.
        </p>
      </main>
    </AppShell>
  );
}

/** `YYYY-MM-DD` in Dubai, for comparing against stored date strings. */
function isoDate(instant: Date): string {
  const t = toDubai(instant);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

function readableDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  if (!year || !month || !day) return iso;
  return `${day} ${MONTHS[month - 1] ?? month} ${year}`;
}

function monthDay([month, day]: readonly [number, number]): string {
  return `${day} ${MONTHS[month - 1] ?? month}`;
}
