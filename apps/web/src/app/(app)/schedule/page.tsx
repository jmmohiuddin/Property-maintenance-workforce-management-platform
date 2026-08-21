import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, loadSchedule } from "@meridian/db";
import {
  getService,
  fromDubai,
  isWeekend,
  isRamadan,
  isInMiddayBanSeason,
  publicHolidayName,
  closeMinuteFor,
  formatMinute,
  PRIORITY_LABEL,
  SLA_STATE_LABEL,
  dubaiDateKey,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { ScheduleGrid, type GridDay } from "./schedule-grid";

export const metadata: Metadata = { title: "Schedule" };

// A cached schedule is a schedule somebody is reading after it changed.
export const dynamic = "force-dynamic";

const VIEWS = [
  { key: "day", label: "Day", days: 1 },
  { key: "week", label: "Week", days: 7 },
  { key: "lane", label: "Technician", days: 7 },
] as const;

type ViewKey = (typeof VIEWS)[number]["key"];

/**
 * `JOB-7` — the schedule view.
 *
 * ── WHY THIS IS NOT THE DISPATCH BOARD WITH DATES ON IT ─────────────────────
 *
 * The boundary is set out in full on `loadSchedule` in `packages/db`, and the
 * short version is that the two screens have different units. Dispatch answers
 * "what needs a decision now": its unit is the job, its axis is urgency, it has
 * no date range, and it is at its best empty. The schedule answers "who is
 * doing what, when": its unit is the visit, its axis is time inside a window,
 * its rows are people, and it is at its best full and even.
 *
 * Nothing here re-sorts by SLA, and nothing on dispatch grows a calendar. The
 * one thing both need is unassigned work, which appears at the bottom of this
 * page as a rail of jobs to place — with links into the job, where assignment
 * already lives, rather than a second assignment path.
 *
 * ── THE CALENDAR IS THE TENANT'S, NEVER THE DEFAULT ─────────────────────────
 *
 * `loadSchedule` reads it with `loadWorkingCalendar` and hands it back, and
 * every per-day fact below — weekend, public holiday, Ramadan close, whether
 * the midday ban is in season — is derived from that one object. The band this
 * screen draws is therefore the band this company is actually inspected
 * against; a screen computing it from `DEFAULT_CALENDAR` would draw a plausible
 * one instead, and be wrong on precisely the days that matter (`ADM-10`).
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("jobs:read");
  const params = await searchParams;

  const viewParam = typeof params["view"] === "string" ? params["view"] : "day";
  const view: ViewKey = (VIEWS.find((v) => v.key === viewParam)?.key ?? "day") as ViewKey;
  const window = VIEWS.find((v) => v.key === view) ?? VIEWS[0];

  const now = new Date();
  const fromParam = typeof params["from"] === "string" ? params["from"] : "";
  // Anchored on today in Dubai unless a day was asked for. `dubaiDateKey` is
  // the same formatter the rest of the codebase reads holidays with, so "today"
  // here and "today" in the calendar are the same day.
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromParam) ? fromParam : dubaiDateKey(now);

  const schedule = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => loadSchedule(tx, { from, days: window.days, now }),
  );

  const technicianParam = typeof params["technician"] === "string" ? params["technician"] : "";
  const selectedLane =
    schedule.lanes.find((l) => l.technicianId === technicianParam) ?? schedule.lanes[0] ?? null;

  // Per-day calendar facts, resolved here from the tenant's calendar so the
  // client component is handed answers rather than rules.
  const gridDays: GridDay[] = schedule.days.map((day) => {
    const [y, m, d] = day.split("-").map(Number);
    // Midday, deliberately: any instant inside the Dubai day answers "is this a
    // weekend, a holiday, in Ramadan, in the ban season" identically, and
    // midday cannot land on the wrong side of a boundary the way midnight can.
    const instant = fromDubai(y ?? 1970, m ?? 1, d ?? 1, 12 * 60);
    const ban = schedule.calendar.middayBan;
    return {
      day,
      label: instant.toLocaleDateString("en-GB", {
        timeZone: "Asia/Dubai",
        weekday: "short",
        day: "numeric",
        month: "short",
      }),
      isWeekend: isWeekend(instant, schedule.calendar),
      holidayName: publicHolidayName(instant, schedule.calendar),
      isRamadan: isRamadan(instant, schedule.calendar),
      openMinute: schedule.calendar.openMinute,
      closeMinute: closeMinuteFor(instant, schedule.calendar),
      ban: isInMiddayBanSeason(instant, schedule.calendar)
        ? { startMinute: ban.startMinute, endMinute: ban.endMinute }
        : null,
    };
  });

  const lanes =
    view === "lane" && selectedLane
      ? [
          {
            technicianId: selectedLane.technicianId,
            fullName: selectedLane.fullName,
            primaryTrade: selectedLane.primaryTrade,
            leaveDays: selectedLane.leaveDays,
          },
        ]
      : schedule.lanes.map((l) => ({
          technicianId: l.technicianId,
          fullName: l.fullName,
          primaryTrade: l.primaryTrade,
          leaveDays: l.leaveDays,
        }));

  const visibleLaneIds = new Set(lanes.map((l) => l.technicianId));
  const gridVisits = schedule.visits
    .filter((v) => visibleLaneIds.has(v.technicianId))
    .map((v) => ({
      visitId: v.visitId,
      jobId: v.jobId,
      reference: v.reference,
      title: v.title,
      priority: v.priority,
      serviceShortName: getService(v.serviceSlug)?.shortName ?? v.serviceSlug,
      isOutdoor: v.isOutdoor,
      technicianId: v.technicianId,
      technicianName: v.technicianName,
      customerName: v.customerName,
      propertyName: v.propertyName,
      day: v.day,
      startMinute: v.startMinute,
      endMinute: v.endMinute,
      visitStatus: v.visitStatus,
    }));

  const href = (next: { view?: string; from?: string; technician?: string }) => {
    const q = new URLSearchParams();
    q.set("view", next.view ?? view);
    q.set("from", next.from ?? from);
    const tech = next.technician ?? (view === "lane" ? (selectedLane?.technicianId ?? "") : "");
    if (tech) q.set("technician", tech);
    return `/schedule?${q.toString()}`;
  };

  const banInSeason = gridDays.some((d) => d.ban !== null);
  const onLeaveToday = schedule.lanes.filter((l) =>
    l.leaveDays.some((leave) => leave.day === schedule.today),
  );

  return (
    <AppShell session={session} active="schedule">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Schedule</h1>
            <p className="prose-body mt-2 text-[14px]">
              Who is doing what, and when. Dispatch is the other question &mdash; what still needs
              assigning.
            </p>
          </div>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {schedule.from === schedule.to ? schedule.from : `${schedule.from} → ${schedule.to}`} GST
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <nav aria-label="Schedule view" className="flex flex-wrap gap-2">
            {VIEWS.map((v) => (
              <Link
                key={v.key}
                href={href({ view: v.key })}
                aria-current={v.key === view ? "true" : undefined}
                className="rounded-sm border px-2.5 py-1.5 text-[13px] font-medium transition-colors"
                style={
                  v.key === view
                    ? {
                        backgroundColor: "var(--accent)",
                        color: "var(--accent-contrast)",
                        borderColor: "var(--accent)",
                      }
                    : { color: "var(--text-secondary)" }
                }
              >
                {v.label}
              </Link>
            ))}
          </nav>

          <span className="mx-1 h-5 w-px" style={{ backgroundColor: "var(--border-hairline)" }} />

          <Link href={href({ from: schedule.previousFrom })} className="btn btn-secondary !py-1.5 text-[13px]">
            Earlier
          </Link>
          <Link href={href({ from: schedule.today })} className="btn btn-secondary !py-1.5 text-[13px]">
            Today
          </Link>
          <Link href={href({ from: schedule.nextFrom })} className="btn btn-secondary !py-1.5 text-[13px]">
            Later
          </Link>
        </div>

        {view === "lane" && schedule.lanes.length > 0 ? (
          <nav aria-label="Technician" className="mt-4 flex flex-wrap gap-2">
            {schedule.lanes.map((l) => (
              <Link
                key={l.technicianId}
                href={href({ technician: l.technicianId })}
                aria-current={l.technicianId === selectedLane?.technicianId ? "true" : undefined}
                className="rounded-sm border px-2.5 py-1 text-[13px]"
                style={
                  l.technicianId === selectedLane?.technicianId
                    ? { backgroundColor: "var(--surface-sunken)", color: "var(--text-primary)" }
                    : { color: "var(--text-secondary)" }
                }
              >
                {l.fullName}
              </Link>
            ))}
          </nav>
        ) : null}

        {/*
          JOB-6, stated in words as well as drawn. The band on the grid is what
          a dispatcher reads at a glance; the number is what changes behaviour,
          and it does not fit inside a 6px stripe.
        */}
        {banInSeason ? (
          <p
            className="mt-6 rounded-sm border px-3 py-2 text-[13px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
          >
            Summer midday ban in force this week. No outdoor work in direct sun between{" "}
            {formatMinute(schedule.calendar.middayBan.startMinute)} and{" "}
            {formatMinute(schedule.calendar.middayBan.endMinute)}. Penalty:{" "}
            {schedule.calendar.middayBan.penalty}. The striped region on each lane is that window;
            an outdoor visit cannot be moved into it.
          </p>
        ) : null}

        {onLeaveToday.length > 0 ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            On approved leave today: {onLeaveToday.map((l) => l.fullName).join(", ")}.
          </p>
        ) : null}

        <ScheduleGrid
          view={view}
          days={gridDays}
          lanes={lanes}
          visits={gridVisits}
          canMove={can(session.principal, "jobs:assign")}
        />

        {/* ── The rail of work with nobody on it ──────────────────────────── */}
        <section className="mt-10">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 className="text-[17px] font-semibold">Waiting to be placed</h2>
            <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
              {/* The total is its own aggregate, not this list's length. A rail
                  capped at 25 that reported 25 would read as a full stop. */}
              {schedule.unplaced.length === schedule.unplacedTotal
                ? `${schedule.unplacedTotal} open`
                : `${schedule.unplaced.length} of ${schedule.unplacedTotal} open`}
            </p>
          </div>

          {schedule.unplaced.length === 0 ? (
            <div className="mt-4">
              <EmptyState kind="good" title="Every open job has somebody on it.">
                <p>
                  Nothing is waiting for a technician. New work appears here the moment it is raised
                  and leaves it the moment somebody is assigned.
                </p>
              </EmptyState>
            </div>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {schedule.unplaced.map((job) => (
                <li key={job.id}>
                  <Link
                    href={`/jobs/${job.id}`}
                    className="block p-4 transition-colors hover:bg-[var(--surface-sunken)]"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="flex flex-wrap items-baseline gap-3">
                        <span className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {job.reference}
                        </span>
                        <span className="text-[15px] font-medium">{job.title}</span>
                        {job.isOutdoor ? (
                          <span
                            className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                            style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
                          >
                            Outdoor
                          </span>
                        ) : null}
                      </div>
                      <span
                        className="text-[13px]"
                        style={{
                          color: job.sla === "breached" ? "var(--accent-text)" : "var(--text-muted)",
                        }}
                      >
                        {SLA_STATE_LABEL[job.sla]}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {PRIORITY_LABEL[job.priority]} &middot; {job.customerName} &middot;{" "}
                      {job.propertyName} &middot; {getService(job.serviceSlug)?.shortName ?? job.serviceSlug}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Assignment happens on the job, not here: choosing who does the work has to check skills,
            certification and availability, and this screen does not.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
