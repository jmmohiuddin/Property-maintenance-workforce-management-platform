import { and, eq, sql, inArray, isNull, gte, lte } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { transitionJob } from "./jobs";
import { blockForTechnician, blockedTechnicians, type DispatchBlock } from "./compliance";
import { loadWorkingCalendar } from "./reference";
import {
  checkOutdoorWindow,
  dubaiDateKey,
  fromDubai,
  isWorkingDay,
  isWorkingTime,
  toDubai,
  UserFacingError,
  type JobStatus,
  type WorkingCalendar,
} from "@meridian/core";

/**
 * Technician assignment.
 *
 * Deliberately NOT an LLM. Ranking technicians by skill, certification
 * validity, availability and distance is a constraint problem with an exact
 * answer; a scoring function is faster, cheaper, deterministic, testable, and -
 * critically - explainable to a dispatcher who asks "why him?". See
 * docs/adr/0005-ai-model-tiering.md.
 *
 * ── THE THREE CATEGORIES, AND WHY THERE ARE THREE ───────────────────────────
 *
 * **Blocked** (`HR-9`). An expired work permit, residence visa, Emirates ID,
 * medical fitness certificate or health insurance. Not a low score and not a
 * warning: deploying the person carries AED 100,000 to AED 1,000,000, `G15` is
 * a zero-tolerance target, and a zero-tolerance target is met by refusing the
 * action. The dispatcher gets no control at all, and `assignTechnician` refuses
 * again inside the transaction.
 *
 * **Warned** (`JOB-9`, `JOB-8`, `HR-9`). A lapsed or lapsing trade
 * certification, a clash with another visit, a statutory hour limit, a shift
 * they are not rostered for. Every one of these is sometimes the right call —
 * the technician twelve minutes away whose certificate expires in twelve days
 * is usually the correct answer — so this is a decision rather than a
 * prohibition, and `JOB-10` is what makes it a *recorded* decision. Assigning
 * past one of these without a reason is refused here, in the domain layer.
 *
 * **Disqualified.** Approved leave. Not offered, and not overridable from the
 * dispatch screen: a person on approved leave is not at work, and quietly
 * pulling them back in from a picker is how leave stops meaning anything.
 *
 * Distance, proficiency fit and current load are none of these three. They are
 * scoring.
 */

/** Rough great-circle distance in km. Adequate for ranking within a city. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Warnings (JOB-8, JOB-9, JOB-10, HR-9) ───────────────────────────────────

/**
 * What can be wrong with an assignment without being illegal.
 *
 * Every value here fits `job_visits.override_warning_type`, which is
 * varchar(48) — the longest is 20 characters, and a new one has to stay inside
 * that budget or the override cannot be recorded at all.
 */
export type AssignmentWarningType =
  | "skill_missing"
  | "certification_expired"
  | "certification_expiring"
  | "on_leave"
  | "double_booked"
  | "daily_hours_exceeded"
  | "weekly_hours_exceeded"
  | "off_shift"
  | "outside_working_hours";

/**
 * Which warnings a dispatcher may only pass by recording a reason (`JOB-10`).
 *
 * `outside_working_hours` is the one exception, and the reason is worth stating
 * because it looks like an omission. It fires when the technician has no
 * published roster and the window falls outside the tenant's normal working
 * day — which is true of every P1 emergency, and `JOB-4` says P1 is answered
 * 24/7. Demanding a typed justification for every night callout is the
 * over-blocking that gets a control worked around, and a workaround is worse
 * than a warning because it is invisible. It is shown, and it is not a gate.
 */
const WARNING_REQUIRES_OVERRIDE: Readonly<Record<AssignmentWarningType, boolean>> = {
  skill_missing: true,
  certification_expired: true,
  certification_expiring: true,
  on_leave: true,
  double_booked: true,
  daily_hours_exceeded: true,
  weekly_hours_exceeded: true,
  off_shift: true,
  outside_working_hours: false,
};

/** Consequence order. The first warning is the one the dispatcher must read. */
const WARNING_RANK: Readonly<Record<AssignmentWarningType, number>> = {
  certification_expired: 0,
  certification_expiring: 1,
  skill_missing: 2,
  on_leave: 3,
  double_booked: 4,
  weekly_hours_exceeded: 5,
  daily_hours_exceeded: 6,
  off_shift: 7,
  outside_working_hours: 8,
};

export const ASSIGNMENT_WARNING_LABEL: Readonly<Record<AssignmentWarningType, string>> = {
  skill_missing: "No signed-off skill",
  certification_expired: "Certification expired",
  certification_expiring: "Certification expiring",
  on_leave: "On approved leave",
  double_booked: "Already booked",
  daily_hours_exceeded: "Over the daily hour limit",
  weekly_hours_exceeded: "Over the weekly hour limit",
  off_shift: "Not on shift",
  outside_working_hours: "Outside working hours",
};

export interface AssignmentWarning {
  readonly type: AssignmentWarningType;
  /** Plain language, naming the fact and its date. Shown to the dispatcher. */
  readonly detail: string;
  /** True when the assignment is refused without a recorded reason (`JOB-10`). */
  readonly requiresOverride: boolean;
}

/**
 * Short enough that a real reason clears it, long enough that "ok" does not.
 *
 * An override reason is read months later by somebody deciding whether the
 * decision was sound. Two characters answers nothing, and a field that accepts
 * two characters is a field that collects them.
 */
export const MIN_OVERRIDE_REASON_LENGTH = 10;

/** `HR-9`: a trade certification warns from 30 days before it lapses. */
const CERT_EXPIRY_WARNING_DAYS = 30;

/** Visit statuses that occupy a technician's diary. */
const OCCUPYING_VISIT_STATUSES = ["assigned", "accepted", "en_route", "arrived"] as const;

/** How long a visit is assumed to run when nobody says otherwise. */
const DEFAULT_VISIT_MINUTES = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Dubai-local midnight on the Monday of the week containing `instant`.
 *
 * Monday, because the statutory 48-hour ceiling is counted per week and the
 * common private-sector weekend is Saturday–Sunday (`OPEN-8`) — so Monday is
 * where the count has to reset. A rolling seven days would let a technician
 * work fifty-five hours over two calendar weeks without ever tripping it.
 */
function dubaiWeekStart(instant: Date): Date {
  const t = toDubai(instant);
  const back = (t.weekday + 6) % 7; // Monday → 0 … Sunday → 6
  return fromDubai(t.year, t.month, t.day - back, 0);
}

function visitMinutes(start: Date | null, end: Date | null): number {
  if (!start) return 0;
  if (!end) return DEFAULT_VISIT_MINUTES;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
}

function isoDay(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "an unrecorded date";
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/**
 * Everything that is wrong with sending these technicians to this work, in this
 * window, that is not a legal block.
 *
 * One function, two callers, and that is the point: `findCandidates` uses it to
 * decide what the dispatch panel offers, and `assignTechnician` re-runs it
 * inside the transaction to decide what the server accepts. If they were two
 * implementations they would disagree, and the one that mattered would be the
 * looser of the two.
 *
 * `JOB-8` names five availability questions — on shift, not on approved leave,
 * not already booked, within daily and weekly hour limits, and outside the
 * summer ban for outdoor work. Four of them are here. The fifth is not a
 * property of a technician at all: the midday ban depends on the *job* being
 * outdoors, so it is a hard block on the window in `assignTechnician`, not a
 * warning on a person.
 */
export async function assignmentWarnings(
  tx: TenantScopedTx,
  input: {
    technicianIds: readonly string[];
    serviceSlug: string;
    from: Date;
    to: Date;
    calendar: WorkingCalendar;
    /** A visit being re-checked does not clash with itself. */
    ignoreVisitId?: string | undefined;
  },
): Promise<ReadonlyMap<string, readonly AssignmentWarning[]>> {
  const ids = [...new Set(input.technicianIds)];
  const found = new Map<string, AssignmentWarning[]>();
  if (ids.length === 0) return found;

  const add = (technicianId: string, type: AssignmentWarningType, detail: string): void => {
    const list = found.get(technicianId) ?? [];
    list.push({ type, detail, requiresOverride: WARNING_REQUIRES_OVERRIDE[type] });
    found.set(technicianId, list);
  };

  const { from, to, calendar } = input;
  const proposedMinutes = Math.max(1, Math.round((to.getTime() - from.getTime()) / 60_000));

  // ── JOB-9: does this person hold the skill at all? ────────────────────────
  //
  // `findCandidates` only ever asks about technicians who do, so this fires for
  // the other caller: an assignment posted from somewhere else, or a skill
  // withdrawn between the panel rendering and the button being pressed.
  const skilled = await tx
    .select({ technicianId: schema.technicianSkills.technicianId })
    .from(schema.technicianSkills)
    .where(
      and(
        inArray(schema.technicianSkills.technicianId, ids),
        eq(schema.technicianSkills.serviceSlug, input.serviceSlug),
      ),
    );
  const skilledSet = new Set(skilled.map((s) => s.technicianId));
  for (const id of ids) {
    if (!skilledSet.has(id)) {
      add(id, "skill_missing", `No signed-off skill for ${input.serviceSlug} on this record`);
    }
  }

  // ── HR-9: trade certifications, expired and about to expire ──────────────
  //
  // Both states, in one query. The expiring half has never been surfaced at
  // assignment time before, and it is the case the override column was written
  // for: a certificate that lapses in twelve days is not a reason to refuse the
  // work, it is a reason to record who decided and why.
  const horizon = new Date(from.getTime() + CERT_EXPIRY_WARNING_DAYS * DAY_MS);
  const certs = await tx
    .select({
      technicianId: schema.technicianCertifications.technicianId,
      name: schema.technicianCertifications.name,
      expiresOn: schema.technicianCertifications.expiresOn,
    })
    .from(schema.technicianCertifications)
    .where(
      and(
        inArray(schema.technicianCertifications.technicianId, ids),
        sql`${schema.technicianCertifications.requiredForServices} @> ${JSON.stringify([input.serviceSlug])}::jsonb`,
        sql`${schema.technicianCertifications.expiresOn} is not null`,
        lte(schema.technicianCertifications.expiresOn, horizon),
      ),
    );
  for (const cert of certs) {
    const expired = cert.expiresOn !== null && cert.expiresOn <= from;
    add(
      cert.technicianId,
      expired ? "certification_expired" : "certification_expiring",
      `${cert.name} ${expired ? "expired on" : "expires on"} ${isoDay(cert.expiresOn)}, and it is mandatory for ${input.serviceSlug}`,
    );
  }

  // ── HR-7: approved leave overlapping the window ──────────────────────────
  //
  // ── THE RULE, BECAUSE THIS DIVERGES FROM THE SCHEDULE BOARD ON PURPOSE ───
  //
  // An override belongs on the path that can record a reason. A path that
  // cannot capture one must refuse instead.
  //
  // So this is a gated warning here and an outright refusal on drag-to-
  // reschedule, and the two are not an inconsistency to be tidied away. The
  // case that a hard refusal here would break is real: `JOB-4` makes P1
  // emergencies 24/7, and a technician on approved leave who agrees to come in
  // for one happens. If the domain refused absolutely, the only way to record
  // what actually happened would be to delete the leave record — which destroys
  // the evidence instead of annotating it, and leaves the diary lying about
  // where that person was. A recorded override beats a workaround that erases a
  // row. Dragging a visit onto a leave day is the opposite case: overwhelmingly
  // a slip, on a surface with nowhere to type why, so allowing it there would
  // produce exactly the silent override `JOB-10` exists to prevent.
  //
  // APPROVED ONLY, on both sides. A pending request is somebody asking, not a
  // fact about the diary; treating it as one would let anybody make themselves
  // unschedulable by asking. `packages/db/test/assignment.test.ts` and the
  // schedule board's own suite each pin this independently.
  const leave = await tx
    .select({
      technicianId: schema.leaveRequests.technicianId,
      kind: schema.leaveRequests.kind,
      startsOn: schema.leaveRequests.startsOn,
      endsOn: schema.leaveRequests.endsOn,
    })
    .from(schema.leaveRequests)
    .where(
      and(
        inArray(schema.leaveRequests.technicianId, ids),
        eq(schema.leaveRequests.status, "approved"),
        lte(schema.leaveRequests.startsOn, to),
        gte(schema.leaveRequests.endsOn, from),
      ),
    );
  for (const l of leave) {
    add(
      l.technicianId,
      "on_leave",
      `Approved ${l.kind} leave from ${isoDay(l.startsOn)} to ${isoDay(l.endsOn)}`,
    );
  }

  // ── JOB-8: on shift ───────────────────────────────────────────────────────
  //
  // The `shifts` table is empty in every deployment this has run in, and a
  // rule that fires for everybody is a rule that gets ignored by everybody. So
  // the roster is only treated as authoritative for a technician who has one:
  // rows nearby mean somebody is maintaining their pattern, and a window
  // outside it is a real conflict. No rows means no roster, and the question
  // falls back to the tenant's working calendar — which is a weaker statement,
  // and is reported as the weaker `outside_working_hours` rather than dressed
  // up as a roster clash.
  const rosterFrom = new Date(from.getTime() - 7 * DAY_MS);
  const rosterTo = new Date(to.getTime() + 7 * DAY_MS);
  const shiftRows = await tx
    .select({
      technicianId: schema.shifts.technicianId,
      startsAt: schema.shifts.startsAt,
      endsAt: schema.shifts.endsAt,
    })
    .from(schema.shifts)
    .where(
      and(
        inArray(schema.shifts.technicianId, ids),
        lte(schema.shifts.startsAt, rosterTo),
        gte(schema.shifts.endsAt, rosterFrom),
      ),
    );

  const rostered = new Set(shiftRows.map((s) => s.technicianId));
  const covered = new Set(
    shiftRows.filter((s) => s.startsAt <= from && s.endsAt >= to).map((s) => s.technicianId),
  );

  // One instant inside the window rather than the boundary: a visit that ends
  // at 18:00 exactly has not run past an 18:00 close.
  const lastInstant = new Date(Math.max(from.getTime(), to.getTime() - 60_000));
  const insideCalendar = isWorkingTime(from, calendar) && isWorkingTime(lastInstant, calendar);
  const calendarReason = !isWorkingDay(from, calendar)
    ? "a non-working day on the tenant calendar"
    : "outside the tenant's working hours";

  for (const id of ids) {
    if (rostered.has(id)) {
      if (!covered.has(id)) {
        add(id, "off_shift", `No rostered shift covers ${isoDay(from)} for this window`);
      }
    } else if (!insideCalendar) {
      add(
        id,
        "outside_working_hours",
        `This window falls ${calendarReason}, and no shift is rostered for this technician`,
      );
    }
  }

  // ── JOB-8: already booked, and the statutory hour ceilings ───────────────
  //
  // One query serves all three questions. The week is bounded so a technician
  // with two years of history does not drag it all back to answer "is he free
  // on Tuesday".
  const weekStart = dubaiWeekStart(from);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
  const scanFrom = new Date(Math.min(weekStart.getTime(), from.getTime()) - DAY_MS);
  const scanTo = new Date(Math.max(weekEnd.getTime(), to.getTime()) + DAY_MS);

  const visits = await tx
    .select({
      id: schema.jobVisits.id,
      technicianId: schema.jobVisits.technicianId,
      scheduledStart: schema.jobVisits.scheduledStart,
      scheduledEnd: schema.jobVisits.scheduledEnd,
    })
    .from(schema.jobVisits)
    .where(
      and(
        inArray(schema.jobVisits.technicianId, ids),
        inArray(schema.jobVisits.status, [...OCCUPYING_VISIT_STATUSES]),
        sql`${schema.jobVisits.scheduledStart} is not null`,
        gte(schema.jobVisits.scheduledStart, scanFrom),
        lte(schema.jobVisits.scheduledStart, scanTo),
      ),
    );

  const proposedDay = dubaiDateKey(from);
  const dayMinutes = new Map<string, number>();
  const weekMinutes = new Map<string, number>();

  for (const visit of visits) {
    if (input.ignoreVisitId && visit.id === input.ignoreVisitId) continue;
    const start = visit.scheduledStart;
    if (!start) continue;
    const end = visit.scheduledEnd ?? new Date(start.getTime() + DEFAULT_VISIT_MINUTES * 60_000);
    const minutes = visitMinutes(start, end);

    if (start < to && end > from) {
      add(
        visit.technicianId,
        "double_booked",
        `Already booked ${start.toISOString().slice(11, 16)}–${end.toISOString().slice(11, 16)} UTC on ${isoDay(start)}`,
      );
    }
    if (dubaiDateKey(start) === proposedDay) {
      dayMinutes.set(visit.technicianId, (dayMinutes.get(visit.technicianId) ?? 0) + minutes);
    }
    if (start >= weekStart && start < weekEnd) {
      weekMinutes.set(visit.technicianId, (weekMinutes.get(visit.technicianId) ?? 0) + minutes);
    }
  }

  const dayCeiling = calendar.maxHoursPerDay * 60;
  const weekCeiling = calendar.maxHoursPerWeek * 60;
  for (const id of ids) {
    const day = (dayMinutes.get(id) ?? 0) + proposedMinutes;
    const week = (weekMinutes.get(id) ?? 0) + proposedMinutes;
    if (day > dayCeiling) {
      add(
        id,
        "daily_hours_exceeded",
        `${formatHours(day)} scheduled on ${proposedDay} against a statutory ${calendar.maxHoursPerDay}-hour day`,
      );
    }
    if (week > weekCeiling) {
      add(
        id,
        "weekly_hours_exceeded",
        `${formatHours(week)} scheduled in the week of ${isoDay(weekStart)} against a statutory ${calendar.maxHoursPerWeek}-hour week`,
      );
    }
  }

  for (const [id, list] of found) {
    list.sort((a, b) => WARNING_RANK[a.type] - WARNING_RANK[b.type]);
    found.set(id, list);
  }

  return found;
}

/** The warning a dispatcher is really overriding when several apply at once. */
export function leadingWarning(
  warnings: readonly AssignmentWarning[],
): AssignmentWarning | null {
  const gated = warnings.filter((w) => w.requiresOverride);
  if (gated.length === 0) return null;
  return [...gated].sort((a, b) => WARNING_RANK[a.type] - WARNING_RANK[b.type])[0] ?? null;
}

// ── Ranking ──────────────────────────────────────────────────────────────────

export interface Candidate {
  readonly technicianId: string;
  readonly fullName: string;
  readonly grade: string;
  readonly primaryTrade: string;
  readonly proficiency: number;
  readonly baseCity: string | null;
  readonly distanceKm: number | null;
  /** Jobs already assigned to this technician that are not yet complete. */
  readonly openVisits: number;
  readonly score: number;
  /** Plain-language explanation, shown in the UI and stored on the visit. */
  readonly reason: string;
  /** `JOB-8`, `JOB-9`. Empty for most candidates. */
  readonly warnings: readonly AssignmentWarning[];
  /** True when assigning this person needs a recorded reason (`JOB-10`). */
  readonly requiresOverride: boolean;
}

export interface DisqualifiedTechnician {
  readonly technicianId: string;
  readonly fullName: string;
  readonly reason: string;
}

export interface CandidateResult {
  /** Assignable in one click. May still carry advisory warnings. */
  readonly candidates: readonly Candidate[];
  /**
   * Assignable, but only against a recorded reason (`JOB-10`).
   *
   * Kept out of `candidates` rather than mixed in with a badge, because the two
   * are different actions: one is a button, the other is a form with a reason
   * in it. Mixing them would make the override the same gesture as the ordinary
   * assignment, and an override that costs nothing to make is one nobody thinks
   * about before making.
   */
  readonly warned: readonly Candidate[];
  /**
   * Technicians who cannot legally be dispatched (`HR-9`).
   *
   * Kept apart from `disqualified` because the two render differently and mean
   * different things. A disqualified technician is on approved leave — a
   * scheduling fact. A blocked one has an expired permit, visa, Emirates ID,
   * medical certificate or health insurance, and sending them carries a
   * six-figure penalty. The design document is specific: a blocked technician
   * gets no radio button at all, because a disabled control reads as "try again
   * later" and the absence of a control reads as "this is not possible".
   */
  readonly blocked: readonly DispatchBlock[];
  /**
   * Technicians excluded outright, with why.
   *
   * Approved leave, and only approved leave. Surfaced rather than silently
   * dropped: a dispatcher who cannot see that their best technician was
   * excluded will assume the system is broken and work around it.
   */
  readonly disqualified: readonly DisqualifiedTechnician[];
}

/**
 * Rank technicians for a job.
 *
 * Hard filters: active, holds a skill for the service, legally dispatchable
 * (`HR-9`), not on approved leave over the window.
 * Warned: certification lapsed or lapsing, clashing visit, statutory hour
 * ceiling, off roster.
 * Soft scoring: distance, proficiency fit, current load.
 */
export async function findCandidates(
  tx: TenantScopedTx,
  input: {
    serviceSlug: string;
    property: { lat: number | null; lng: number | null; city: string };
    /** Window the work is expected to occupy. Defaults to now for 3 hours. */
    from?: Date;
    to?: Date;
    limit?: number;
    /** Supplied by callers that have already loaded it. Never `DEFAULT_CALENDAR`. */
    calendar?: WorkingCalendar | undefined;
  },
): Promise<CandidateResult> {
  const from = input.from ?? new Date();
  const to = input.to ?? new Date(from.getTime() + 3 * 60 * 60 * 1000);

  // Everyone with a verified skill for this service.
  const skilled = await tx
    .select({
      technicianId: schema.technicians.id,
      fullName: schema.technicians.fullName,
      grade: schema.technicians.grade,
      primaryTrade: schema.technicians.primaryTrade,
      baseCity: schema.technicians.baseCity,
      baseLat: schema.technicians.baseLat,
      baseLng: schema.technicians.baseLng,
      proficiency: schema.technicianSkills.proficiency,
    })
    .from(schema.technicianSkills)
    .innerJoin(schema.technicians, eq(schema.technicians.id, schema.technicianSkills.technicianId))
    .where(
      and(
        eq(schema.technicianSkills.serviceSlug, input.serviceSlug),
        eq(schema.technicians.isActive, true),
        isNull(schema.technicians.deletedAt),
      ),
    );

  if (skilled.length === 0) {
    return { candidates: [], warned: [], disqualified: [], blocked: [] };
  }

  // HR-9. Computed before anything else, because a blocked technician must not
  // appear as a candidate at any score. Blocking is a legal question, not a
  // ranking one — this is the difference between a wall and a sign.
  const allBlocked = await blockedTechnicians(tx);
  const blockedById = new Map(allBlocked.map((b) => [b.technicianId, b]));

  const ids = skilled.map((s) => s.technicianId);

  // The tenant's own calendar, never `DEFAULT_CALENDAR`: the weekend pattern,
  // the working day and the public holidays are all configured (`ADM-10`), and
  // an availability check run against the defaults would call a working Friday
  // a weekend for half the deployments this could run in.
  const calendar = input.calendar ?? (await loadWorkingCalendar(tx));

  const warningsById = await assignmentWarnings(tx, {
    technicianIds: ids,
    serviceSlug: input.serviceSlug,
    from,
    to,
    calendar,
  });

  // SOFT SCORING input: how much each technician is already carrying.
  const loads = await tx
    .select({
      technicianId: schema.jobVisits.technicianId,
      openVisits: sql<number>`count(*)::int`,
    })
    .from(schema.jobVisits)
    .where(
      and(
        inArray(schema.jobVisits.technicianId, ids),
        inArray(schema.jobVisits.status, ["assigned", "accepted", "en_route", "arrived"]),
      ),
    )
    .groupBy(schema.jobVisits.technicianId);

  const loadBy = new Map(loads.map((l) => [l.technicianId, l.openVisits]));

  const candidates: Candidate[] = [];
  const warned: Candidate[] = [];
  const disqualified: DisqualifiedTechnician[] = [];
  const blocked: DispatchBlock[] = [];

  for (const t of skilled) {
    // HR-9 first, and that ordering is deliberate: when someone is both on
    // leave and carrying an expired permit, the permit is the thing the
    // dispatcher needs to know about. Reporting the lesser reason would let the
    // serious one stay invisible until the day they come back.
    const block = blockedById.get(t.technicianId);
    if (block) {
      blocked.push(block);
      continue;
    }

    const warnings = warningsById.get(t.technicianId) ?? [];

    // Approved leave is the one warning that is not offered here. The domain
    // layer will still take the assignment against a recorded reason if it
    // arrives from somewhere else — but a person on leave is not at work, and a
    // picker that quietly offers them is how leave stops meaning anything. See
    // the rule on the leave query in `assignmentWarnings` above for why this is
    // a warning rather than a refusal, and why the schedule board refuses where
    // this one warns.
    const leaveWarning = warnings.find((w) => w.type === "on_leave");
    if (leaveWarning) {
      disqualified.push({
        technicianId: t.technicianId,
        fullName: t.fullName,
        reason: leaveWarning.detail,
      });
      continue;
    }

    const openVisits = loadBy.get(t.technicianId) ?? 0;

    const km =
      input.property.lat !== null && input.property.lng !== null && t.baseLat !== null && t.baseLng !== null
        ? distanceKm(
            { lat: input.property.lat, lng: input.property.lng },
            { lat: t.baseLat, lng: t.baseLng },
          )
        : null;

    // Lower is better. Weights are a starting point to tune against real
    // outcomes once the board is in daily use, not a tuned model.
    //   distance   1 point per km          - travel is the dominant real cost
    //   load       8 points per open visit - roughly "an extra job costs 8km"
    //   overskill  3 points per grade above what the job needs, so a
    //              supervisor is not burned on routine work when a
    //              technician is free and equally close
    const sameCity = t.baseCity === input.property.city;
    const distancePenalty = km ?? (sameCity ? 15 : 60);
    const loadPenalty = openVisits * 8;
    const overskillPenalty = Math.max(0, t.proficiency - 3) * 3;
    const score = distancePenalty + loadPenalty + overskillPenalty;

    const reasonParts = [
      km !== null ? `${km.toFixed(1)} km from base` : sameCity ? `based in ${t.baseCity}` : "location unknown",
      openVisits === 0 ? "no open jobs" : `${openVisits} open job${openVisits === 1 ? "" : "s"}`,
      `proficiency ${t.proficiency}/5`,
    ];

    const requiresOverride = warnings.some((w) => w.requiresOverride);

    const candidate: Candidate = {
      technicianId: t.technicianId,
      fullName: t.fullName,
      grade: t.grade,
      primaryTrade: t.primaryTrade,
      proficiency: t.proficiency,
      baseCity: t.baseCity,
      distanceKm: km,
      openVisits,
      score,
      reason: reasonParts.join(", "),
      warnings,
      requiresOverride,
    };

    (requiresOverride ? warned : candidates).push(candidate);
  }

  candidates.sort((a, b) => a.score - b.score);
  warned.sort((a, b) => a.score - b.score);

  const limit = input.limit ?? 10;
  return {
    candidates: candidates.slice(0, limit),
    warned: warned.slice(0, limit),
    disqualified,
    blocked,
  };
}

/**
 * Assign a technician to a job.
 *
 * Creates the visit and moves the job to `dispatched` in one transaction, and
 * records how the decision was made. `assignment_method` and
 * `assignment_score` exist so the optimiser can later be measured against the
 * dispatcher rather than simply trusted.
 */
export async function assignTechnician(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    technicianId: string;
    scheduledStart?: Date | undefined;
    scheduledEnd?: Date | undefined;
    method?: "manual" | "suggested" | "auto";
    score?: number | undefined;
    reason?: string | undefined;
    /**
     * `JOB-10`. Required when the dispatcher is overriding a warning, and
     * enforced below rather than described: the warnings are recomputed here,
     * inside the transaction, and an assignment that trips one and carries no
     * reason is refused.
     *
     * `overrideWarningType` is the warning the dispatcher was *shown*. It is
     * checked against the warning that is current and not trusted as the value
     * to store — a panel rendered thirty seconds ago does not know a
     * certificate expired at midnight, and recording the stale one would put a
     * false statement in the audit trail.
     */
    overrideWarningType?: string | undefined;
    overrideReason?: string | undefined;
    /** Supplied so the midday-ban and availability checks use the configured calendar. */
    calendar?: WorkingCalendar | undefined;
  },
): Promise<{ visitId: string; sequence: number; overrode: readonly AssignmentWarning[] }> {
  const jobRows = await tx
    .select({
      status: schema.jobs.status,
      isOutdoor: schema.jobs.isOutdoor,
      serviceSlug: schema.jobs.serviceSlug,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const job = jobRows[0];
  if (!job) throw new Error("Job not found in this tenant");

  // ── The two hard blocks, enforced in the domain layer ────────────────────
  //
  // Both are re-checked HERE, inside the transaction, and not only in the
  // dialog that offered the choice. That is the point: a dialog rendered thirty
  // seconds ago does not know a permit expired at midnight, and a check that
  // lives only in the UI is an affordance rather than a control. The TRD is
  // explicit — enforced in the domain layer, not the UI.

  // HR-9. AED 100,000 to AED 1,000,000 per worker.
  const block = await blockForTechnician(tx, input.technicianId);
  if (block) {
    throw new UserFacingError(
      `${block.technicianName} cannot be dispatched: ${block.detail}. ${block.penalty ?? ""}`.trim(),
    );
  }

  // The window is settled BEFORE the ban is checked, and that ordering is the
  // whole of a bug this used to have. The check was guarded on
  // `input.scheduledStart` being present while the insert below fell back to
  // `new Date()` — so an outdoor job assigned with no time, at 13:00 on 1 July,
  // was scheduled straight into the ban window with nothing evaluated. The
  // default is now the value that gets checked.
  const start = input.scheduledStart ?? new Date();
  const end = input.scheduledEnd ?? new Date(start.getTime() + DEFAULT_VISIT_MINUTES * 60_000);

  const calendar = input.calendar ?? (await loadWorkingCalendar(tx));

  // JOB-6. AED 5,000 per worker, capped at AED 50,000, plus a classification
  // downgrade. Only applies to work flagged outdoor — indoor work proceeds
  // through the window normally, and blocking it would be the kind of
  // over-blocking that gets a control worked around.
  if (job.isOutdoor) {
    const check = checkOutdoorWindow(start, end, calendar);
    if (!check.allowed) {
      throw new UserFacingError(
        `${check.message} Next available window: ${check.nextAllowed?.toISOString() ?? "later today"}.`,
      );
    }
  }

  // ── JOB-10, made true ────────────────────────────────────────────────────
  //
  // This block is why the docstring on `overrideWarningType` is now a statement
  // about behaviour rather than an intention. Until it existed the field was
  // accepted, written, and never populated by any caller: both columns were
  // null in every row, so an override was indistinguishable from a clean
  // assignment, which is indistinguishable from a mistake.
  const warnings = (
    await assignmentWarnings(tx, {
      technicianIds: [input.technicianId],
      serviceSlug: job.serviceSlug,
      from: start,
      to: end,
      calendar,
    })
  ).get(input.technicianId) ?? [];

  const gated = warnings.filter((w) => w.requiresOverride);
  const leading = leadingWarning(warnings);
  const reason = (input.overrideReason ?? "").trim();

  if (leading) {
    if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
      throw new UserFacingError(
        `This assignment overrides a warning and needs a recorded reason of at least ` +
          `${MIN_OVERRIDE_REASON_LENGTH} characters. ` +
          gated.map((w) => `${ASSIGNMENT_WARNING_LABEL[w.type]}: ${w.detail}.`).join(" "),
      );
    }
    // The type is checked, not stored. A submitted type that is no longer among
    // the current warnings means the panel is out of date — the dispatcher is
    // acknowledging something other than what is actually wrong, and taking the
    // assignment would file a reason against the wrong fact.
    if (input.overrideWarningType && !gated.some((w) => w.type === input.overrideWarningType)) {
      throw new UserFacingError(
        `The warnings on this technician have changed since the panel was drawn. ` +
          `Reload the job and look again: ` +
          gated.map((w) => `${ASSIGNMENT_WARNING_LABEL[w.type]}: ${w.detail}.`).join(" "),
      );
    }
  }

  const existing = await tx
    .select({ sequence: schema.jobVisits.sequence })
    .from(schema.jobVisits)
    .where(eq(schema.jobVisits.jobId, input.jobId));

  const sequence = existing.reduce((max, v) => Math.max(max, v.sequence), 0) + 1;

  const [visit] = await tx
    .insert(schema.jobVisits)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      technicianId: input.technicianId,
      sequence,
      status: "assigned",
      scheduledStart: start,
      scheduledEnd: end,
      dispatchedAt: new Date(),
      assignmentMethod: input.method ?? "manual",
      assignmentScore: input.score ?? null,
      assignmentReason: input.reason ?? null,
      // Null when nothing was overridden, and that is a fact worth keeping
      // null: a reason recorded against no warning would make the override
      // count meaningless in the other direction.
      overrideWarningType: leading?.type ?? null,
      overrideReason: leading ? reason : null,
      assignedById: ctx.userId ?? null,
    })
    .returning({ id: schema.jobVisits.id });

  if (!visit) throw new Error("Failed to create visit");

  // Only move the job forward if the status allows it. Assigning a second
  // technician to a job already on site must not drag it back to dispatched.
  const status = job.status as JobStatus;
  if (status === "triaged" || status === "scheduled") {
    await transitionJob(tx, ctx, {
      jobId: input.jobId,
      to: "dispatched",
      note: input.reason ? `Assigned: ${input.reason}` : "Technician assigned",
    });
  }

  return { visitId: visit.id, sequence, overrode: gated };
}

/**
 * Everything the job-assigned message needs, read after the visit exists.
 *
 * The technician's own email address is on `technicians`, not `users`: not
 * every technician has a login, and the person who does the work is the person
 * who must be told about it.
 */
export async function getVisitForNotification(
  tx: TenantScopedTx,
  visitId: string,
): Promise<{
  technicianName: string;
  technicianEmail: string | null;
  technicianUserId: string | null;
  jobReference: string;
  jobTitle: string;
  propertyName: string;
  propertyArea: string | null;
  scheduledStart: Date | null;
  accessInstructions: string | null;
} | null> {
  const rows = await tx
    .select({
      technicianName: schema.technicians.fullName,
      technicianEmail: schema.technicians.email,
      technicianUserId: schema.technicians.userId,
      jobReference: schema.jobs.reference,
      jobTitle: schema.jobs.title,
      propertyName: schema.properties.name,
      propertyArea: schema.properties.area,
      scheduledStart: schema.jobVisits.scheduledStart,
      accessInstructions: schema.properties.accessInstructions,
    })
    .from(schema.jobVisits)
    .innerJoin(schema.technicians, eq(schema.technicians.id, schema.jobVisits.technicianId))
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobVisits.jobId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.jobs.propertyId))
    .where(eq(schema.jobVisits.id, visitId))
    .limit(1);

  return rows[0] ?? null;
}
