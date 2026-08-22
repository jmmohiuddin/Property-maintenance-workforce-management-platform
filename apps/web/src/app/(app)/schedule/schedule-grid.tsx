"use client";

import { useActionState, useRef, useState } from "react";
import Link from "next/link";
import { PRIORITY_LABEL, formatMinute } from "@meridian/core";
import { moveVisit, type ScheduleActionState } from "./actions";

/**
 * `JOB-7` — the schedule grid.
 *
 * ── WHAT IS AND IS NOT INTERACTIVE HERE ─────────────────────────────────────
 *
 * **Drag to reschedule is built**, within a technician's own lane: pick a visit
 * up, drop it on a slot, and the visit moves to that time.
 *
 * **Drag to assign is not**, and neither is dragging a visit into somebody
 * else's lane. Both are the same operation — deciding *who* — and that decision
 * has to run skill matching, the `HR-9` certification hard block and the
 * availability rules of `JOB-8`, which live in the assignment layer. A drop
 * handler that wrote a technician id would be a second assignment path that
 * skips all three, so a cross-lane drop is refused with a sentence saying why
 * and pointing at the job, where assignment already has a screen. The rail of
 * unplaced work below is a list with links for the same reason: it shows what
 * needs placing without pretending the placing can happen here.
 *
 * ── WHY EVERY DROP TARGET IS ALSO A FORM ────────────────────────────────────
 *
 * Drag and drop is a mouse gesture and a schedule is not an optional screen, so
 * every move is also reachable from the keyboard: each visit carries a "Move"
 * control that posts the same server action with the same fields. The drag
 * handler fills in that form and submits it rather than having a path of its
 * own — one code path, and the accessible one is the real one.
 */

export interface GridVisit {
  readonly visitId: string;
  readonly jobId: string;
  readonly reference: string;
  readonly title: string;
  readonly priority: string;
  readonly serviceShortName: string;
  readonly isOutdoor: boolean;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly customerName: string;
  readonly propertyName: string;
  readonly day: string;
  readonly startMinute: number;
  readonly endMinute: number;
  readonly visitStatus: string;
}

export interface GridLane {
  readonly technicianId: string;
  readonly fullName: string;
  readonly primaryTrade: string;
  readonly leaveDays: readonly { readonly day: string; readonly kind: string }[];
}

/**
 * Everything about one day that the calendar decides, resolved on the server.
 *
 * The client is handed answers, not rules. `isWorkingDay`, the Ramadan close
 * and the ban window all come from the tenant's stored calendar (`ADM-10`) via
 * `loadWorkingCalendar`, and computing any of them here would mean a second
 * copy running against `DEFAULT_CALENDAR` — a screen drawing a ban band that is
 * not the one this company is inspected against.
 */
export interface GridDay {
  readonly day: string;
  /** e.g. "Mon 22 Jun". Formatted server-side in Asia/Dubai. */
  readonly label: string;
  readonly isWeekend: boolean;
  readonly holidayName: string | null;
  readonly isRamadan: boolean;
  readonly openMinute: number;
  readonly closeMinute: number;
  /** Null outside 15 June – 15 September: there is no band to draw. */
  readonly ban: { readonly startMinute: number; readonly endMinute: number } | null;
}

/** The window the grid draws. Wide enough for an early start and a late finish. */
const GRID_START = 6 * 60;
const GRID_END = 20 * 60;
const GRID_SPAN = GRID_END - GRID_START;

/** Drop resolution. Half an hour is the smallest slot anybody schedules to. */
const SLOT_MINUTES = 30;

const INITIAL: ScheduleActionState = {};

function pct(minute: number): number {
  return ((Math.min(Math.max(minute, GRID_START), GRID_END) - GRID_START) / GRID_SPAN) * 100;
}

interface Dragged {
  readonly visitId: string;
  readonly technicianId: string;
  readonly durationMinutes: number;
  readonly reference: string;
}

export function ScheduleGrid({
  view,
  days,
  lanes,
  visits,
  canMove,
}: {
  view: "day" | "week" | "lane";
  days: readonly GridDay[];
  lanes: readonly GridLane[];
  visits: readonly GridVisit[];
  /** False for a role that may read the schedule but not change it. */
  canMove: boolean;
}) {
  const [state, formAction, pending] = useActionState(moveVisit, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const [dragged, setDragged] = useState<Dragged | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  /** Fill the one form and submit it. Both drag and the Move control land here. */
  const submitMove = (visitId: string, day: string, startMinute: number, durationMinutes: number) => {
    const form = formRef.current;
    if (!form) return;
    (form.elements.namedItem("visitId") as HTMLInputElement).value = visitId;
    (form.elements.namedItem("day") as HTMLInputElement).value = day;
    (form.elements.namedItem("startMinute") as HTMLInputElement).value = String(startMinute);
    (form.elements.namedItem("durationMinutes") as HTMLInputElement).value = String(durationMinutes);
    form.requestSubmit();
  };

  const onDrop = (technicianId: string, day: string, startMinute: number) => {
    const drag = dragged;
    setDragged(null);
    if (!drag) return;

    if (drag.technicianId !== technicianId) {
      // Not a silent no-op. A drop that appears to do nothing reads as a broken
      // screen, and the dispatcher tries again rather than going to the job.
      setRefusal(
        `${drag.reference} cannot be dropped into another technician's lane from here — changing who does the work is an assignment, and it has to re-check skills, certification and availability. Open the job to reassign it.`,
      );
      return;
    }

    setRefusal(null);
    submitMove(drag.visitId, day, startMinute, drag.durationMinutes);
  };

  const message = refusal ?? state.error ?? state.ok ?? null;
  const tone = refusal || state.error ? "error" : state.ok ? "ok" : null;

  return (
    <div className="mt-6">
      {/* One form, filled by whichever control the operator used. */}
      <form ref={formRef} action={formAction} className="hidden">
        <input type="hidden" name="visitId" defaultValue="" />
        <input type="hidden" name="day" defaultValue="" />
        <input type="hidden" name="startMinute" defaultValue="" />
        <input type="hidden" name="durationMinutes" defaultValue="" />
      </form>

      <div aria-live="polite" role="status">
        {message ? (
          <p
            className="mb-4 rounded-sm border px-3 py-2 text-[13px]"
            style={
              tone === "error"
                ? { backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }
                : { backgroundColor: "var(--surface-sunken)", color: "var(--text-secondary)" }
            }
          >
            {message}
          </p>
        ) : null}
        {pending ? (
          <p className="mb-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Moving…
          </p>
        ) : null}
      </div>

      {view === "week" ? (
        <WeekGrid days={days} lanes={lanes} visits={visits} />
      ) : (
        <TimeGrid
          rows={
            view === "day"
              ? lanes.map((lane) => ({
                  key: lane.technicianId,
                  technicianId: lane.technicianId,
                  day: days[0]?.day ?? "",
                  heading: lane.fullName,
                  subheading: lane.primaryTrade,
                  dayMeta: days[0],
                  onLeave: lane.leaveDays.find((l) => l.day === days[0]?.day)?.kind ?? null,
                }))
              : days.map((d) => ({
                  key: d.day,
                  technicianId: lanes[0]?.technicianId ?? "",
                  day: d.day,
                  heading: d.label,
                  subheading: d.holidayName ?? (d.isWeekend ? "Weekend" : ""),
                  dayMeta: d,
                  onLeave: lanes[0]?.leaveDays.find((l) => l.day === d.day)?.kind ?? null,
                }))
          }
          visits={visits}
          view={view}
          canMove={canMove}
          dragged={dragged}
          onDragStart={setDragged}
          onDragEnd={() => setDragged(null)}
          onDrop={onDrop}
          onMove={submitMove}
        />
      )}
    </div>
  );
}

interface GridRow {
  readonly key: string;
  readonly technicianId: string;
  readonly day: string;
  readonly heading: string;
  readonly subheading: string;
  readonly dayMeta: GridDay | undefined;
  readonly onLeave: string | null;
}

/**
 * The time-axis grid: one row per lane (day view) or per day (technician view).
 *
 * The ban band is drawn as a region of the row rather than as a badge on it,
 * because that is the requirement — "a visually blocked region" — and because
 * the thing a dispatcher needs to see is that the time is *gone*, not that a
 * rule exists. It is drawn on every row inside the season, including for
 * technicians with nothing booked, so an empty afternoon in July does not look
 * like available capacity.
 */
function TimeGrid({
  rows,
  visits,
  view,
  canMove,
  dragged,
  onDragStart,
  onDragEnd,
  onDrop,
  onMove,
}: {
  rows: readonly GridRow[];
  visits: readonly GridVisit[];
  view: "day" | "lane";
  canMove: boolean;
  dragged: Dragged | null;
  onDragStart: (d: Dragged) => void;
  onDragEnd: () => void;
  onDrop: (technicianId: string, day: string, startMinute: number) => void;
  onMove: (visitId: string, day: string, startMinute: number, duration: number) => void;
}) {
  const hours: number[] = [];
  for (let m = GRID_START; m <= GRID_END; m += 60) hours.push(m);

  const slots: number[] = [];
  for (let m = GRID_START; m < GRID_END; m += SLOT_MINUTES) slots.push(m);

  if (rows.length === 0) {
    return (
      <p className="rounded border p-6 text-[14px]" style={{ color: "var(--text-muted)" }}>
        No technician lanes to show. Add technicians before the schedule can say who is doing what.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
      <div className="min-w-[56rem]">
        {/* Hour ruler */}
        <div className="flex border-b" style={{ backgroundColor: "var(--surface-sunken)" }}>
          <div className="w-44 shrink-0 px-4 py-2 text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            {view === "day" ? "Technician" : "Day"}
          </div>
          <div className="relative flex-1">
            {hours.map((m) => (
              <span
                key={m}
                className="tnum absolute top-2 -translate-x-1/2 text-[11px]"
                style={{ left: `${pct(m)}%`, color: "var(--text-muted)" }}
              >
                {formatMinute(m)}
              </span>
            ))}
            <div className="h-8" />
          </div>
        </div>

        {rows.map((row) => {
          const rowVisits = visits.filter(
            (v) =>
              v.day === row.day &&
              (view === "day" ? v.technicianId === row.technicianId : v.technicianId === row.technicianId),
          );
          const meta = row.dayMeta;
          const closed = meta ? meta.holidayName !== null || meta.isWeekend : false;

          return (
            <div key={row.key} className="flex border-b last:border-0">
              <div className="w-44 shrink-0 border-r px-4 py-3">
                <p className="text-[14px] font-medium">{row.heading}</p>
                <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {row.subheading}
                </p>
                {row.onLeave ? (
                  <p className="mt-1 text-[12px] font-medium" style={{ color: "var(--accent-text)" }}>
                    On {row.onLeave} leave
                  </p>
                ) : null}
              </div>

              <div className="relative min-h-[4.5rem] flex-1">
                {/* Outside working hours, and non-working days, shown flat
                    rather than hidden: capacity that does not exist should look
                    like nothing, not like space. */}
                {meta ? (
                  <>
                    <div
                      aria-hidden
                      className="absolute inset-y-0"
                      style={{
                        left: 0,
                        width: `${pct(meta.openMinute)}%`,
                        backgroundColor: "var(--surface-sunken)",
                      }}
                    />
                    <div
                      aria-hidden
                      className="absolute inset-y-0"
                      style={{
                        left: `${pct(meta.closeMinute)}%`,
                        right: 0,
                        backgroundColor: "var(--surface-sunken)",
                      }}
                    />
                  </>
                ) : null}

                {closed ? (
                  <div
                    aria-hidden
                    className="absolute inset-0"
                    style={{ backgroundColor: "var(--surface-sunken)", opacity: 0.7 }}
                  />
                ) : null}

                {row.onLeave ? (
                  <div
                    aria-hidden
                    className="absolute inset-0"
                    style={{ backgroundColor: "var(--surface-sunken)", opacity: 0.85 }}
                  />
                ) : null}

                {/* Drop slots, behind everything else. */}
                {canMove
                  ? slots.map((m) => (
                      <div
                        key={m}
                        className="absolute inset-y-0"
                        style={{
                          left: `${pct(m)}%`,
                          width: `${(SLOT_MINUTES / GRID_SPAN) * 100}%`,
                          outline:
                            dragged && dragged.technicianId === row.technicianId
                              ? "1px dashed var(--border-hairline)"
                              : undefined,
                        }}
                        onDragOver={(e) => {
                          if (dragged) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          onDrop(row.technicianId, row.day, m);
                        }}
                      />
                    ))
                  : null}

                {/*
                  JOB-6. The summer midday work ban, 12:30–15:00 from 15 June to
                  15 September, drawn over the slots so the time reads as taken
                  rather than free. It is not a drop blocker in the browser:
                  indoor work runs through the window legally, and the refusal
                  for outdoor work is enforced in the domain layer where it
                  cannot be bypassed by a client that decided otherwise.
                */}
                {meta?.ban ? (
                  <div
                    className="pointer-events-none absolute inset-y-0 flex items-center justify-center"
                    style={{
                      left: `${pct(meta.ban.startMinute)}%`,
                      width: `${pct(meta.ban.endMinute) - pct(meta.ban.startMinute)}%`,
                      backgroundImage:
                        "repeating-linear-gradient(45deg, var(--accent-wash) 0 6px, transparent 6px 12px)",
                      borderLeft: "1px solid var(--accent-text)",
                      borderRight: "1px solid var(--accent-text)",
                    }}
                    title={`Outdoor work prohibited ${formatMinute(meta.ban.startMinute)}–${formatMinute(meta.ban.endMinute)}`}
                  >
                    <span
                      className="rotate-0 px-1 text-[10px] font-semibold uppercase tracking-wide"
                      style={{ color: "var(--accent-text)" }}
                    >
                      Midday ban
                    </span>
                  </div>
                ) : null}

                {rowVisits.map((v, i) => (
                  <VisitBlock
                    key={v.visitId}
                    visit={v}
                    stack={i}
                    canMove={canMove}
                    day={row.day}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    onMove={onMove}
                  />
                ))}

                {rowVisits.length === 0 && !closed && !row.onLeave ? (
                  <p
                    className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    Nothing booked
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VisitBlock({
  visit,
  stack,
  canMove,
  day,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  visit: GridVisit;
  stack: number;
  canMove: boolean;
  day: string;
  onDragStart: (d: Dragged) => void;
  onDragEnd: () => void;
  onMove: (visitId: string, day: string, startMinute: number, duration: number) => void;
}) {
  const duration = Math.max(SLOT_MINUTES, visit.endMinute - visit.startMinute);
  const left = pct(visit.startMinute);
  const width = Math.max(pct(visit.endMinute) - left, 2);

  return (
    <div
      className="absolute rounded-sm border px-2 py-1"
      draggable={canMove}
      onDragStart={() =>
        onDragStart({
          visitId: visit.visitId,
          technicianId: visit.technicianId,
          durationMinutes: duration,
          reference: visit.reference,
        })
      }
      onDragEnd={onDragEnd}
      style={{
        left: `${left}%`,
        width: `${width}%`,
        top: `${0.5 + stack * 0.25}rem`,
        backgroundColor: visit.isOutdoor ? "var(--accent-wash)" : "var(--surface-sunken)",
        borderColor: visit.priority === "p1_emergency" ? "var(--accent-text)" : "var(--border-hairline)",
        cursor: canMove ? "grab" : undefined,
      }}
      title={`${visit.reference} · ${visit.title} · ${visit.customerName} · ${visit.propertyName} · ${formatMinute(visit.startMinute)}–${formatMinute(visit.endMinute)}`}
    >
      <Link href={`/jobs/${visit.jobId}`} className="block truncate text-[12px] font-medium">
        {visit.reference} {visit.title}
      </Link>
      <p className="tnum truncate text-[11px]" style={{ color: "var(--text-muted)" }}>
        {formatMinute(visit.startMinute)}–{formatMinute(visit.endMinute)} · {visit.serviceShortName}
        {visit.isOutdoor ? " · Outdoor" : ""}
      </p>
      {canMove ? (
        <label className="mt-1 flex items-center gap-1 text-[11px]" style={{ color: "var(--text-muted)" }}>
          <span className="sr-only">
            Move {visit.reference} for {visit.technicianName}
          </span>
          {/*
            The keyboard path. Same action, same fields, same domain checks —
            this is not a lesser fallback, it is the same move the drag makes.
          */}
          <select
            defaultValue=""
            className="w-full rounded-sm border bg-transparent px-1 py-0.5 text-[11px]"
            onChange={(e) => {
              const minute = Number(e.target.value);
              e.target.value = "";
              if (Number.isFinite(minute)) onMove(visit.visitId, day, minute, duration);
            }}
          >
            <option value="">Move to…</option>
            {Array.from({ length: GRID_SPAN / SLOT_MINUTES }, (_, i) => GRID_START + i * SLOT_MINUTES).map(
              (m) => (
                <option key={m} value={m}>
                  {formatMinute(m)}
                </option>
              ),
            )}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/**
 * The week view: technicians down, days across.
 *
 * No time axis — seven days of half-hour slots on one screen is a grid nobody
 * can read, and the question this view answers is "who has a full week and who
 * has an empty one", which is a count and a shape rather than a clock. Dragging
 * is deliberately absent here for the same reason: a drop would have to invent
 * a time of day.
 */
function WeekGrid({
  days,
  lanes,
  visits,
}: {
  days: readonly GridDay[];
  lanes: readonly GridLane[];
  visits: readonly GridVisit[];
}) {
  return (
    <div className="overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
      <table className="w-full min-w-[64rem] border-collapse text-left">
        <thead>
          <tr className="border-b text-[12px]" style={{ color: "var(--text-muted)" }}>
            <th scope="col" className="px-4 py-3 font-medium uppercase tracking-wide">
              Technician
            </th>
            {days.map((d) => (
              <th key={d.day} scope="col" className="px-3 py-3 font-medium">
                <span className="block">{d.label}</span>
                {d.holidayName ? (
                  <span className="block text-[11px]" style={{ color: "var(--accent-text)" }}>
                    {d.holidayName}
                  </span>
                ) : d.isWeekend ? (
                  <span className="block text-[11px]">Weekend</span>
                ) : d.isRamadan ? (
                  <span className="block text-[11px]">Ramadan hours</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => (
            <tr key={lane.technicianId} className="border-b last:border-0 align-top">
              <th scope="row" className="px-4 py-3 text-left font-medium">
                <span className="block text-[14px]">{lane.fullName}</span>
                <span className="block text-[12px] font-normal" style={{ color: "var(--text-muted)" }}>
                  {lane.primaryTrade}
                </span>
              </th>
              {days.map((d) => {
                const leave = lane.leaveDays.find((l) => l.day === d.day);
                const cell = visits.filter(
                  (v) => v.day === d.day && v.technicianId === lane.technicianId,
                );
                return (
                  <td
                    key={d.day}
                    className="px-3 py-3"
                    style={
                      leave || d.holidayName || d.isWeekend
                        ? { backgroundColor: "var(--surface-sunken)" }
                        : undefined
                    }
                  >
                    {leave ? (
                      <p className="text-[12px] font-medium" style={{ color: "var(--accent-text)" }}>
                        {leave.kind} leave
                      </p>
                    ) : null}
                    {cell.length === 0 && !leave ? (
                      <span className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                        —
                      </span>
                    ) : null}
                    <ul className="space-y-1">
                      {cell.map((v) => (
                        <li key={v.visitId}>
                          <Link
                            href={`/jobs/${v.jobId}`}
                            className="block rounded-sm border px-1.5 py-1 text-[12px]"
                            style={{
                              backgroundColor: v.isOutdoor ? "var(--accent-wash)" : "transparent",
                              borderColor:
                                v.priority === "p1_emergency"
                                  ? "var(--accent-text)"
                                  : "var(--border-hairline)",
                            }}
                          >
                            <span className="tnum">{formatMinute(v.startMinute)}</span> {v.reference}
                            <span className="block truncate" style={{ color: "var(--text-muted)" }}>
                              {v.title}
                            </span>
                            <span className="sr-only">
                              {PRIORITY_LABEL[v.priority as keyof typeof PRIORITY_LABEL] ?? v.priority}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
