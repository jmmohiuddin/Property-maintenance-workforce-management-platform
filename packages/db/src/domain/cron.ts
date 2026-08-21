import { sql, and, eq, lt, isNull, inArray } from "drizzle-orm";
import { db, withoutTenantBoundary, type TenantScopedTx } from "../index";
import * as schema from "../schema";

/**
 * Scheduled work: the run ledger, and the queries the scheduled routes drive.
 *
 * ADM-5 / TRD §7.4. Before this existed, nothing in the system ran on a
 * schedule. Notification dispatch piggy-backed on two unrelated user actions,
 * the rate-limit sweep never ran at all, and SLA breach detection was therefore
 * impossible — the clock existed, the alarm did not.
 *
 * Two rules govern everything here:
 *
 *  1. **Every run is recorded.** `startRun`/`finishRun` bracket each route, so
 *     `/api/cron/health` can ask "when did each job last finish?" and alert on
 *     one that stopped firing. A scheduler that fails silently is the exact
 *     failure this section exists to prevent, so the scheduler is monitored by
 *     the same mechanism as everything else.
 *  2. **Every route is idempotent.** Schedulers double-fire, retry on timeout,
 *     and occasionally run two instances at once. Nothing below may depend on
 *     running exactly once.
 */

// ── The run ledger ──────────────────────────────────────────────────────────

/**
 * `cron_runs` carries no `tenant_id` and is therefore not touched by the
 * generic RLS policy loop — which is correct rather than an oversight. It holds
 * a job name, two timestamps and a count: no tenant data exists in it to
 * isolate, and a job sweeping every tenant has no tenant context to be scoped
 * to. That is why these three functions use `db` directly instead of
 * `withTenant`; there is no boundary here to cross.
 */

export type CronOutcome = "ok" | "failed";

export const CRON_JOBS = [
  "dispatch",
  "sweep",
  "sla",
  "compliance",
  "retention",
  "contracts",
  // KPI-5. Appended, not slotted in: this list is the health check's
  // universe, and a job that is only in vercel.json is a job that can stop
  // firing without /api/cron/health noticing.
  "weekly-digest",
  // M9 / ATS-14, ATS-15, ATS-16. Sends the acknowledgements and releases the
  // outcome messages whose cancellable window has closed. It belongs in this
  // list rather than only in vercel.json for the reason stated above, and with
  // more force: if this job stops firing, applicants stop being told anything
  // and the only symptom is silence — which is exactly what the module exists
  // to prevent, arriving through the back door.
  "recruitment",
  "health",
] as const;
export type CronJob = (typeof CRON_JOBS)[number];

/**
 * How long each job may go without a completed run before health calls it
 * overdue. Generous relative to its schedule — roughly three missed runs for
 * the frequent jobs — because alerting on a single late invocation trains
 * people to ignore the alert.
 */
export const CRON_MAX_AGE_MINUTES: Readonly<Record<CronJob, number>> = {
  dispatch: 20, // runs every 5 minutes
  sweep: 200, // hourly
  sla: 35, // every 10 minutes
  compliance: 26 * 60, // daily
  retention: 26 * 60, // daily
  contracts: 26 * 60, // daily — CON-3..CON-7, the PPM engine
  // Weekly, Sunday 09:00 Dubai. Eight days rather than seven and a bit: a
  // weekly job that is an hour late is not a problem, and an allowance tight
  // enough to fire on a scheduler hiccup is an allowance somebody mutes.
  "weekly-digest": 8 * 24 * 60,
  // Every 15 minutes. Tight, because the acknowledgement it sends is what an
  // applicant reads as "they got it", and an hour of silence after tapping
  // Submit is when people phone the office.
  recruitment: 60,
  health: 20, // every 5 minutes
};

export async function startRun(job: CronJob): Promise<string> {
  const [row] = await db
    .insert(schema.cronRuns)
    .values({ job, outcome: "running" })
    .returning({ id: schema.cronRuns.id });

  if (!row) throw new Error(`Could not open a cron_runs row for "${job}"`);
  return row.id;
}

export async function finishRun(
  id: string,
  result: {
    outcome: CronOutcome;
    itemsProcessed?: number;
    detail?: Record<string, unknown>;
    error?: string;
  },
): Promise<void> {
  await db
    .update(schema.cronRuns)
    .set({
      finishedAt: new Date(),
      outcome: result.outcome,
      itemsProcessed: result.itemsProcessed ?? 0,
      detail: result.detail ?? {},
      // Truncated: a stack trace from a driver can be tens of kilobytes, and
      // the first line is the part anyone reads.
      error: result.error?.slice(0, 2000) ?? null,
    })
    .where(eq(schema.cronRuns.id, id));
}

export interface CronJobHealth {
  readonly job: CronJob;
  readonly lastFinishedAt: Date | null;
  readonly lastOutcome: string | null;
  readonly minutesSince: number | null;
  /** True when the last successful finish is older than the job's allowance. */
  readonly overdue: boolean;
  /** True when the job has never completed a run. */
  readonly neverRan: boolean;
}

/**
 * The meta-check that makes every other cron trustworthy.
 *
 * A job that has never run is reported separately from one that has stopped
 * running, because they need different responses: the first is a deployment
 * that was never wired up, the second is something that broke.
 */
export async function cronHealth(now: Date = new Date()): Promise<readonly CronJobHealth[]> {
  const rows = (await db.execute<{
    job: string;
    finished_at: Date | string | null;
    outcome: string | null;
  }>(sql`
    select distinct on (job) job, finished_at, outcome
      from cron_runs
     where finished_at is not null
     order by job, finished_at desc
  `)) as unknown as { job: string; finished_at: Date | string | null; outcome: string | null }[];

  const byJob = new Map(rows.map((r) => [r.job, r]));

  return CRON_JOBS.map((job) => {
    const row = byJob.get(job);
    const finished = row?.finished_at ? new Date(row.finished_at) : null;
    const minutesSince = finished ? Math.floor((now.getTime() - finished.getTime()) / 60_000) : null;

    return {
      job,
      lastFinishedAt: finished,
      lastOutcome: row?.outcome ?? null,
      minutesSince,
      neverRan: finished === null,
      overdue: minutesSince === null || minutesSince > CRON_MAX_AGE_MINUTES[job],
    };
  });
}

/**
 * Runs that opened and never closed — a route that crashed or was killed
 * mid-flight. They are invisible to `cronHealth`, which only looks at finished
 * rows, so they need their own question.
 */
export async function strandedRuns(olderThanMinutes = 30): Promise<number> {
  const rows = (await db.execute<{ count: number }>(sql`
    select count(*)::int as count
      from cron_runs
     where finished_at is null
       and started_at < now() - make_interval(mins => ${olderThanMinutes})
  `)) as unknown as { count: number }[];

  return rows[0]?.count ?? 0;
}

// ── What the scheduled routes actually do ───────────────────────────────────

/**
 * Every active tenant, for the jobs that must run across all of them.
 *
 * Goes through `app_cron_active_tenants()`, a SECURITY DEFINER function, and
 * NOT through a plain select — because a plain select returns nothing.
 *
 * That is worth spelling out, because the failure is silent and this code was
 * written the wrong way first. The application role is NOBYPASSRLS, and the
 * policy on `tenants` is `id = app_current_tenant()`. A scheduled job has no
 * tenant context, so the GUC is unset, so the policy matches zero rows. Every
 * cron ran, reported `ok`, and processed nothing — a green tick over a system
 * doing no work, which is precisely the failure mode the scheduler was
 * introduced to eliminate.
 *
 * `withoutTenantBoundary()` does not help here. It skips the withTenant wrapper
 * and logs loudly; it does not and cannot grant an RLS exemption to a
 * NOBYPASSRLS role. Reading past a policy requires a definer function, which is
 * the same answer authentication reached for the same reason.
 */
export async function activeTenantIds(): Promise<readonly string[]> {
  return withoutTenantBoundary("cron: enumerate tenants for scheduled work", async (database) => {
    const rows = (await database.execute<{ id: string }>(
      sql`select app_cron_active_tenants() as id`,
    )) as unknown as { id: string }[];
    return rows.map((r) => r.id);
  });
}

/**
 * Delete sessions that expired or were revoked a while ago.
 *
 * Expired sessions are already unusable — `app_auth_resolve_session` refuses
 * them — so this is hygiene, not security: the table would otherwise grow one
 * row per sign-in forever. The grace period keeps recent rows around long
 * enough to answer "was I signed out, or did I sign out?" during an incident.
 */
export async function sweepExpiredSessions(graceDays = 7): Promise<number> {
  // Definer function, for the same reason as `activeTenantIds` above: the
  // policy on `sessions` is `user_id = app_current_user()`, and a cron has no
  // user. A direct DELETE here matches nothing and reports success.
  return withoutTenantBoundary("cron: sweep expired sessions", async (database) => {
    const rows = (await database.execute<{ removed: number }>(
      sql`select app_cron_sweep_sessions(${graceDays}) as removed`,
    )) as unknown as { removed: number }[];
    return Number(rows[0]?.removed ?? 0);
  });
}

/**
 * Move sent quotes past their validity date to `expired` (QTE-2).
 *
 * The audit noted that the `expired` status existed but nothing enforced it, so
 * a quote stayed "sent" indefinitely and could be approved months later at a
 * price that no longer covered the work. `superseded` and decided states are
 * untouched — only a live quote expires.
 */
export async function expireStaleQuotes(tx: TenantScopedTx): Promise<number> {
  const rows = await tx
    .update(schema.quotes)
    .set({ status: "expired", updatedAt: new Date() })
    .where(
      and(
        inArray(schema.quotes.status, ["sent", "viewed"]),
        lt(schema.quotes.validUntil, new Date()),
        isNull(schema.quotes.deletedAt),
      ),
    )
    .returning({ id: schema.quotes.id });

  return rows.length;
}

export interface SlaBreach {
  readonly jobId: string;
  readonly reference: string;
  readonly title: string;
  readonly priority: string;
  readonly status: string;
  /** `response` when no first response was recorded, `resolution` otherwise. */
  readonly kind: "response" | "resolution";
  readonly dueAt: Date;
  readonly minutesOverdue: number;
}

/**
 * Jobs past a deadline (JOB-5).
 *
 * Response and resolution are separate breaches with separate consequences, so
 * they are reported separately rather than collapsed into "late". A job with no
 * `first_response_at` past `respond_by_at` has nobody looking at it yet; one
 * past `resolve_by_at` has someone on it who is not going to finish in time.
 *
 * Terminal states are excluded: a job closed last week is not breaching now.
 *
 * NOTE — deadlines are compared against wall-clock here because that is what
 * the current schema stores. `JOB-3` requires P2–P4 deadlines to be computed
 * against the working calendar instead, so that a routine job raised at 18:00
 * on a Thursday does not breach overnight while nobody is working. That is a
 * Phase 1 change to how `respond_by_at` is *derived*; this query reads whatever
 * was derived and needs no change when it lands.
 */
export async function findSlaBreaches(tx: TenantScopedTx, limit = 100): Promise<readonly SlaBreach[]> {
  const rows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    priority: string;
    status: string;
    kind: "response" | "resolution";
    due_at: Date | string;
    minutes_overdue: number;
  }>(sql`
    select id, reference, title, priority::text as priority, status::text as status,
           kind, due_at,
           (extract(epoch from (now() - due_at)) / 60)::int as minutes_overdue
      from (
        select j.id, j.reference, j.title, j.priority, j.status,
               'response'::text as kind, j.respond_by_at as due_at
          from jobs j
         where j.deleted_at is null
           and j.first_response_at is null
           and j.respond_by_at is not null
           and j.respond_by_at < now()
           and j.status not in ('signed_off', 'invoiced', 'closed', 'cancelled', 'draft')

        union all

        select j.id, j.reference, j.title, j.priority, j.status,
               'resolution'::text as kind, j.resolve_by_at as due_at
          from jobs j
         where j.deleted_at is null
           and j.completed_at is null
           and j.resolve_by_at is not null
           and j.resolve_by_at < now()
           and j.status not in ('signed_off', 'invoiced', 'closed', 'cancelled', 'draft')
      ) breaches
     order by due_at
     limit ${limit}
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    priority: string;
    status: string;
    kind: "response" | "resolution";
    due_at: Date | string;
    minutes_overdue: number;
  }[];

  return rows.map((r) => ({
    jobId: r.id,
    reference: r.reference,
    title: r.title,
    priority: r.priority,
    status: r.status,
    kind: r.kind,
    dueAt: new Date(r.due_at),
    minutesOverdue: r.minutes_overdue,
  }));
}

export interface ExpiringCertification {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly certification: string;
  readonly expiresOn: Date;
  readonly daysRemaining: number;
}

/**
 * Technician certifications at or near expiry (HR-3, feeding HR-9).
 *
 * Negative `daysRemaining` means already expired. Both are returned from one
 * query because the alert is the same shape and the recipient is the same
 * person — the difference is urgency, which the number carries.
 *
 * SCOPE — this is the part of `/api/cron/compliance` that can be built today.
 * The employee document register (`HR-5`: passport, residence visa, Emirates
 * ID, work permit, medical fitness, health insurance) and the company
 * accreditation register (`HR-14`: the trade licence and its 23 Jan 2027
 * expiry, DEWA enrolment, insurances) do not have tables yet; they arrive in
 * Phase 1 and plug into the same route. Saying so here rather than shipping a
 * route that reports "ok" while checking nothing is the whole point.
 */
export async function findExpiringCertifications(
  tx: TenantScopedTx,
  withinDays = 90,
): Promise<readonly ExpiringCertification[]> {
  const rows = (await tx.execute<{
    technician_id: string;
    full_name: string;
    name: string;
    expires_on: Date | string;
    days_remaining: number;
  }>(sql`
    select c.technician_id, t.full_name, c.name, c.expires_on,
           -- expires_on is timestamptz, not date. Subtracting a date from a
           -- timestamp yields an interval, which cannot be cast to integer —
           -- so the cast to date happens first. This threw on the first real
           -- run against seeded data, which is the argument for running the
           -- route rather than only typechecking it.
           (c.expires_on::date - current_date)::int as days_remaining
      from technician_certifications c
      join technicians t on t.id = c.technician_id
     where c.expires_on is not null
       -- The cast on the parameter is required, not decorative. A bare
       -- date + placeholder is ambiguous to the planner (date + integer or
       -- date + interval?) and it refuses to guess.
       and c.expires_on::date <= current_date + (${withinDays})::int
       and c.deleted_at is null
       and t.is_active
       and t.deleted_at is null
     order by c.expires_on
  `)) as unknown as {
    technician_id: string;
    full_name: string;
    name: string;
    expires_on: Date | string;
    days_remaining: number;
  }[];

  return rows.map((r) => ({
    technicianId: r.technician_id,
    technicianName: r.full_name,
    certification: r.name,
    expiresOn: new Date(r.expires_on),
    daysRemaining: r.days_remaining,
  }));
}

/**
 * Has this person already been told this, recently?
 *
 * The reason this exists: `/api/cron/sla` runs every ten minutes, and a job
 * that breached at 09:00 is still breaching at 09:10, 09:20 and 09:30. Without
 * a gate the operations manager gets the same digest six times an hour, and six
 * identical emails an hour is a filter rule — after which the alert reaches
 * nobody at all. §12.2 of the PRD puts the ceiling at one alert per event per
 * recipient per hour; this is that ceiling.
 *
 * Deliberately reads the notification ledger rather than keeping its own state.
 * The ledger already records exactly what was enqueued for whom and when, and a
 * second source of truth about "did we tell them" would be one deploy away from
 * disagreeing with the first.
 */
export async function recentlyNotified(
  tx: TenantScopedTx,
  input: { template: string; recipientUserId: string; withinMinutes: number },
): Promise<boolean> {
  const rows = (await tx.execute<{ hit: boolean }>(sql`
    select exists (
      select 1 from notifications
       where template = ${input.template}
         and recipient_user_id = ${input.recipientUserId}::uuid
         and created_at > now() - make_interval(mins => ${input.withinMinutes})
    ) as hit
  `)) as unknown as { hit: boolean }[];

  return rows[0]?.hit === true;
}

/**
 * Roles an operational alert can be routed to.
 *
 * Narrowed to the enum rather than accepting `string`, so a typo in a caller
 * ("operations-manager") is a compile error instead of a query that silently
 * matches nobody and an alert that silently reaches no one.
 */
export type AlertRole = (typeof schema.userRole.enumValues)[number];

/**
 * Staff who should hear about an operational alert.
 *
 * Routed by role rather than by a configured address list, because an address
 * list goes stale the first time somebody leaves and nobody notices until an
 * SLA breach emails a former employee.
 */
export async function alertRecipients(
  tx: TenantScopedTx,
  roles: readonly AlertRole[] = ["owner", "operations_manager"],
): Promise<readonly { userId: string; email: string; fullName: string }[]> {
  // Query builder rather than raw SQL, specifically so the role list is bound
  // as a parameter. There is no string-built SQL anywhere in this codebase and
  // this is not the place to start one — an interpolated `IN (...)` is how that
  // rule quietly dies.
  const rows = await tx
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      fullName: schema.users.fullName,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(
      and(
        eq(schema.memberships.isActive, true),
        inArray(schema.memberships.role, [...roles]),
        isNull(schema.users.deletedAt),
      ),
    );

  return rows;
}
