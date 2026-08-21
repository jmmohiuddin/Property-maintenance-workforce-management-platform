import { and, eq, sql, desc, asc, inArray, isNull, type SQL, type AnyColumn } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  slaState,
  STATUS_LABEL,
  canTransition,
  checkOutdoorWindow,
  InvalidTransitionError,
  OPEN_STATUSES,
  AT_RISK_THRESHOLD,
  UserFacingError,
  type SlaState,
  type JobStatus,
  type JobPriority,
  type WorkingCalendar,
} from "@meridian/core";
import { loadWorkingCalendar } from "./reference";
import { writeAuditNote } from "./staff";
// The cursor codec is imported rather than re-implemented, even though
// `leads.ts` already imports `nextJobReference` from here and this makes the
// pair mutually importing. Both sides only touch each other inside function
// bodies, so module evaluation order cannot bite; and the alternative — a
// second base64url encoder for the same opaque cursor — is two things that can
// drift apart, which is worse than one import edge that cannot.
import { encodeCursor, decodeCursor, type Page } from "./leads";
import { rowDate, requiredRowDate } from "./_rows";

/**
 * Job persistence and queries.
 *
 * The status graph, labels and SLA maths live in `@meridian/core` because they
 * are pure and a browser needs them to render. This file holds only the parts
 * that touch the database.
 */

// ── Dispatch board ───────────────────────────────────────────────────────────

/**
 * Move a job to a new status and record why.
 *
 * Writes a `job_events` row in the same transaction as the status change, so
 * the two can never disagree. That is the whole point of the events table: it
 * is what makes "why did this job sit for three days" answerable.
 *
 * The transition graph itself lives in `@meridian/core` so a browser can render
 * the legal next steps; this function is what actually enforces it.
 */
export async function transitionJob(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    to: JobStatus;
    note?: string | undefined;
    /** Set when the transition is a side effect of something else. */
    actorKind?: "user" | "system" | "ai" | "customer";
  },
): Promise<{ from: JobStatus; to: JobStatus }> {
  const rows = await tx
    .select({ status: schema.jobs.status })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const current = rows[0];
  // RLS means "not found" and "belongs to another tenant" are indistinguishable
  // here, which is the intended behaviour.
  if (!current) throw new Error(`Job ${input.jobId} not found in this tenant`);

  const from = current.status as JobStatus;
  if (!canTransition(from, input.to)) throw new InvalidTransitionError(from, input.to);

  const now = new Date();
  const patch: Record<string, unknown> = { status: input.to, updatedAt: now };

  // Timestamp columns other queries depend on. Set here so they cannot drift
  // from the status they describe.
  if (input.to === "on_site") {
    patch["firstResponseAt"] = sql`coalesce(${schema.jobs.firstResponseAt}, ${now})`;
  }
  if (input.to === "work_complete") patch["completedAt"] = now;
  if (input.to === "closed" || input.to === "cancelled") patch["closedAt"] = now;

  await tx.update(schema.jobs).set(patch).where(eq(schema.jobs.id, input.jobId));

  await tx.insert(schema.jobEvents).values({
    tenantId: ctx.tenantId,
    jobId: input.jobId,
    fromStatus: from,
    toStatus: input.to,
    note: input.note ?? null,
    actorId: ctx.userId ?? null,
    actorKind: input.actorKind ?? ctx.actorKind ?? "user",
    occurredAt: now,
  });

  return { from, to: input.to };
}

// ── Dispatch board ───────────────────────────────────────────────────────────

/**
 * Visit statuses that mean somebody is on the hook for this job.
 *
 * "completed" is in the list deliberately. A job sitting in work_complete
 * awaiting sign-off still has a technician who did the work, and showing it as
 * unassigned both misleads the dispatcher and inflates the unassigned count
 * they are trying to drive to zero.
 */
const ASSIGNED_VISIT_STATUSES = ["assigned", "accepted", "en_route", "arrived", "completed"] as const;

const ASSIGNED_VISIT_STATUS_LIST = sql.join(
  ASSIGNED_VISIT_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * The technician currently carrying a job, as a correlated subquery.
 *
 * This used to be a LEFT JOIN through job_visits, which is wrong for the one
 * case job_visits exists to model: `JOB-12` multi-visit work. A job with two
 * live visits produced two board rows, and every count derived from those rows
 * counted it twice — so a "parts on order, returning Thursday" job silently
 * inflated the open figure the dispatcher is driving to zero.
 *
 * Latest visit by sequence, because that is the one still to happen.
 */
function assignedTechnicianName(jobIdColumn: SQL | AnyColumn) {
  return sql<string | null>`(
  select t.full_name
    from job_visits v
    join technicians t on t.id = v.technician_id
   where v.job_id = ${jobIdColumn}
     and v.status in (${ASSIGNED_VISIT_STATUS_LIST})
   order by v.sequence desc
   limit 1
)`;
}

/** For the query builder, where the jobs table is referenced by its real name. */
const ASSIGNED_TECHNICIAN_NAME = assignedTechnicianName(schema.jobs.id);

/** For the raw queries below, where it is aliased to `j`. */
const ASSIGNED_TECHNICIAN_NAME_J = assignedTechnicianName(sql`j.id`);

export interface DispatchBoardRow {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly serviceSlug: string;
  readonly createdAt: Date;
  readonly scheduledFor: Date | null;
  readonly respondByAt: Date | null;
  readonly resolveByAt: Date | null;
  readonly completedAt: Date | null;
  readonly customerName: string;
  readonly propertyName: string;
  readonly propertyArea: string | null;
  readonly propertyCity: string;
  readonly technicianName: string | null;
  /**
   * The AMC this job was raised under, or null. `CON-6` is what stops contract
   * work being absorbed, and a dispatcher who cannot tell a contract job from
   * any other one has no reason to look for it — so the reference travels with
   * the row rather than being fetched by whoever remembers to ask.
   */
  readonly contractReference: string | null;
  readonly sla: SlaState;
}

/**
 * The dispatch board's query. Hits `jobs_board_idx` on
 * (tenant_id, status, priority, scheduled_for).
 *
 * SLA state is computed in application code rather than SQL on purpose: it
 * depends on "now", so doing it in the query would make the result
 * uncacheable and the logic untestable without a database.
 *
 * ── WHY THIS ONE IS CAPPED AND NOT PAGED (`LEAD-8`) ─────────────────────────
 *
 * `LEAD-8` requires keyset pagination on the jobs list, and `searchJobs` below
 * is that. This function is deliberately not it.
 *
 * The board's ORDER BY is `priority, resolve_by_at, created_at` — operational
 * ordering, `JOB-11`, the best decision in the existing product and explicitly
 * not to be "improved" into a generic sortable table. It is also a poor keyset
 * key: `priority` is a four-value enum, so a cursor on it lands in the middle
 * of a tie thousands of rows wide, and `resolve_by_at` is nullable, so the
 * row-wise comparison that makes keyset work stops being a total order.
 *
 * More to the point, the board is a *top N by urgency* view. A dispatcher who
 * has reached the bottom of it has reached the work that does not need a
 * dispatcher, and page two of "least urgent open jobs" is a screen nobody
 * opens. A cap is the right shape here — as long as it is visible, which is
 * what `dispatchBoardCounts` is for: it counts tenant-wide with its own
 * aggregate, so the board can say "showing 200 of 431" rather than quietly
 * presenting 200 as the total.
 */
export async function listDispatchBoard(
  tx: TenantScopedTx,
  options?: { statuses?: readonly JobStatus[]; limit?: number; now?: Date },
): Promise<readonly DispatchBoardRow[]> {
  const statuses = options?.statuses ?? OPEN_STATUSES;
  const now = options?.now ?? new Date();

  const rows = await tx
    .select({
      id: schema.jobs.id,
      reference: schema.jobs.reference,
      title: schema.jobs.title,
      status: schema.jobs.status,
      priority: schema.jobs.priority,
      serviceSlug: schema.jobs.serviceSlug,
      createdAt: schema.jobs.createdAt,
      scheduledFor: schema.jobs.scheduledFor,
      respondByAt: schema.jobs.respondByAt,
      resolveByAt: schema.jobs.resolveByAt,
      completedAt: schema.jobs.completedAt,
      customerName: schema.customers.name,
      propertyName: schema.properties.name,
      propertyArea: schema.properties.area,
      propertyCity: schema.properties.city,
      technicianName: ASSIGNED_TECHNICIAN_NAME,
      contractReference: schema.contracts.reference,
    })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.jobs.customerId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.jobs.propertyId))
    // One join, both surfaces: the dispatch board and the jobs list call this
    // function, so the AMC chip appears on each without either page knowing
    // anything about contracts.
    .leftJoin(schema.contracts, eq(schema.contracts.id, schema.jobs.contractId))
    .where(and(inArray(schema.jobs.status, [...statuses]), isNull(schema.jobs.deletedAt)))
    .orderBy(asc(schema.jobs.priority), asc(schema.jobs.resolveByAt), desc(schema.jobs.createdAt))
    .limit(options?.limit ?? 200);

  return rows.map((r) => ({
    ...r,
    status: r.status as JobStatus,
    priority: r.priority as JobPriority,
    sla: slaState({
      createdAt: r.createdAt,
      resolveByAt: r.resolveByAt,
      completedAt: r.completedAt,
      now,
    }),
  }));
}

export interface JobDetail {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly serviceSlug: string;
  readonly createdAt: Date;
  readonly respondByAt: Date | null;
  readonly resolveByAt: Date | null;
  readonly completedAt: Date | null;
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyId: string;
  readonly propertyName: string;
  readonly propertyArea: string | null;
  readonly propertyCity: string;
  readonly propertyLat: number | null;
  readonly propertyLng: number | null;
  readonly accessInstructions: string | null;
  readonly sla: SlaState;
  readonly visits: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly status: string;
    readonly technicianName: string;
    readonly scheduledStart: Date | null;
    readonly arrivedAt: Date | null;
    readonly completedAt: Date | null;
    readonly assignmentMethod: string;
    readonly assignmentReason: string | null;
  }[];
  readonly events: readonly {
    readonly id: string;
    readonly fromStatus: string | null;
    readonly toStatus: string;
    readonly note: string | null;
    readonly actorKind: string;
    readonly occurredAt: Date;
  }[];
}

/** Everything the job detail page shows. Three queries, not N+1. */
export async function getJobDetail(
  tx: TenantScopedTx,
  jobId: string,
  now: Date = new Date(),
): Promise<JobDetail | null> {
  const rows = await tx
    .select({
      id: schema.jobs.id,
      reference: schema.jobs.reference,
      title: schema.jobs.title,
      description: schema.jobs.description,
      status: schema.jobs.status,
      priority: schema.jobs.priority,
      serviceSlug: schema.jobs.serviceSlug,
      createdAt: schema.jobs.createdAt,
      respondByAt: schema.jobs.respondByAt,
      resolveByAt: schema.jobs.resolveByAt,
      completedAt: schema.jobs.completedAt,
      customerId: schema.customers.id,
      customerName: schema.customers.name,
      propertyId: schema.properties.id,
      propertyName: schema.properties.name,
      propertyArea: schema.properties.area,
      propertyCity: schema.properties.city,
      propertyLat: schema.properties.lat,
      propertyLng: schema.properties.lng,
      accessInstructions: schema.properties.accessInstructions,
    })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.jobs.customerId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.jobs.propertyId))
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  const job = rows[0];
  if (!job) return null;

  const visits = await tx
    .select({
      id: schema.jobVisits.id,
      sequence: schema.jobVisits.sequence,
      status: schema.jobVisits.status,
      technicianName: schema.technicians.fullName,
      scheduledStart: schema.jobVisits.scheduledStart,
      arrivedAt: schema.jobVisits.arrivedAt,
      completedAt: schema.jobVisits.completedAt,
      assignmentMethod: schema.jobVisits.assignmentMethod,
      assignmentReason: schema.jobVisits.assignmentReason,
    })
    .from(schema.jobVisits)
    .innerJoin(schema.technicians, eq(schema.technicians.id, schema.jobVisits.technicianId))
    .where(eq(schema.jobVisits.jobId, jobId))
    .orderBy(asc(schema.jobVisits.sequence));

  const events = await tx
    .select({
      id: schema.jobEvents.id,
      fromStatus: schema.jobEvents.fromStatus,
      toStatus: schema.jobEvents.toStatus,
      note: schema.jobEvents.note,
      actorKind: schema.jobEvents.actorKind,
      occurredAt: schema.jobEvents.occurredAt,
    })
    .from(schema.jobEvents)
    .where(eq(schema.jobEvents.jobId, jobId))
    .orderBy(desc(schema.jobEvents.occurredAt));

  return {
    ...job,
    status: job.status as JobStatus,
    priority: job.priority as JobPriority,
    sla: slaState({
      createdAt: job.createdAt,
      resolveByAt: job.resolveByAt,
      completedAt: job.completedAt,
      now,
    }),
    visits,
    events,
  };
}

/**
 * Counts for the board header (`LEAD-8`, and the trap it names).
 *
 * ── WHY THIS IS AN AGGREGATE AND NOT A `.filter()` ──────────────────────────
 *
 * It used to be `listDispatchBoard(tx, { limit: 1000 })` and four array
 * filters. That is the same trap `LEAD-8` describes on the customers page: the
 * headline figures were not tenant-wide totals, they were totals *of the first
 * thousand rows*, and at the PRD's own stated volume — 5,000 jobs a year, §9 —
 * the first number a dispatcher trusts each morning would have quietly become
 * a page total inside year one. Worse, it would have gone on rising to exactly
 * 1000 and then stopped, which reads as a plateau rather than as a cap.
 *
 * So the counts are computed by Postgres over every matching row, independent
 * of any page or cap, and `open` is what tells the board its own list is
 * truncated.
 *
 * ── THE SLA ARITHMETIC IS MIRRORED, AND THE MIRROR IS TESTED ────────────────
 *
 * `slaState` in `@meridian/core` is the definition, and it stays there because
 * a browser needs it. The FILTER clauses below restate it in SQL, which is a
 * duplication with a real risk of drift — so `test/jobs.test.ts` classifies the
 * same rows both ways and fails if the two ever disagree. The threshold itself
 * is imported rather than typed as `0.8` twice.
 */
/**
 * The board's own test for "past its deadline", as one SQL expression.
 *
 * Extracted so that the header's total and the dashboard's per-priority
 * breakdown cannot disagree about the same job: they are not two restatements
 * of `slaState`, they are one restatement used twice. See the note above
 * `dispatchBoardCounts` for why a restatement exists at all and what stops it
 * drifting from the definition in `@meridian/core`.
 *
 * `at` is passed already stringified so both callers bind the same instant.
 */
function breachedInSql(at: string) {
  return sql`(
    j.resolve_by_at is not null
      and case
            when j.completed_at is not null then j.completed_at > j.resolve_by_at
            when ${at}::timestamptz > j.resolve_by_at then true
            -- slaState treats a non-positive window as already breached:
            -- a deadline at or before creation was never achievable.
            else j.resolve_by_at <= j.created_at
          end
  )`;
}

export async function dispatchBoardCounts(
  tx: TenantScopedTx,
  now: Date = new Date(),
  statuses: readonly JobStatus[] = OPEN_STATUSES,
): Promise<{ open: number; breached: number; atRisk: number; unassigned: number }> {
  const at = now.toISOString();
  const statusList = sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );

  const rows = (await tx.execute<Record<string, never>>(sql`
    select
      count(*) as open,
      count(*) filter (where ${breachedInSql(at)}) as breached,
      count(*) filter (
        where j.resolve_by_at is not null
          and j.completed_at is null
          and ${at}::timestamptz <= j.resolve_by_at
          and j.resolve_by_at > j.created_at
          and extract(epoch from (${at}::timestamptz - j.created_at))
              / extract(epoch from (j.resolve_by_at - j.created_at)) >= ${AT_RISK_THRESHOLD}
      ) as at_risk,
      count(*) filter (
        where not exists (
          select 1 from job_visits v
           where v.job_id = j.id and v.status in (${ASSIGNED_VISIT_STATUS_LIST})
        )
      ) as unassigned
    from jobs j
   where j.deleted_at is null
     and j.status::text in (${statusList})
  `)) as unknown as {
    open: string;
    breached: string;
    at_risk: string;
    unassigned: string;
  }[];

  const row = rows[0];
  return {
    open: Number(row?.open ?? 0),
    breached: Number(row?.breached ?? 0),
    atRisk: Number(row?.at_risk ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
  };
}

/**
 * The same counts, split by priority (`KPI-3`'s Work card).
 *
 * The owner dashboard used to build this by reading `listDispatchBoard` with a
 * limit of 1000 and filtering the array four ways. That is the `LEAD-8` trap
 * described above, one screen further on: past a thousand open jobs the
 * per-priority figures would have stopped rising, and a number that stops
 * rising does not look truncated — it looks like a plateau, which is the
 * failure mode nobody investigates. At the PRD's stated 5,000 jobs a year
 * (§9) the owner's weekly read would have quietly become a page total.
 *
 * It lives here rather than in `reporting.ts` so that one place knows how to
 * count the board. The dashboard's intent was always "the dispatch board is
 * the source of truth, so the two cannot disagree" — and agreeing with the
 * board means asking the same question of the same table, not reading its rows.
 *
 * Only priorities with at least one open job come back, which is what the
 * dashboard renders: `group by` produces no row for a priority with no jobs,
 * so the caller needs no filter of its own.
 */
export async function dispatchBoardCountsByPriority(
  tx: TenantScopedTx,
  now: Date = new Date(),
  statuses: readonly JobStatus[] = OPEN_STATUSES,
): Promise<readonly { priority: JobPriority; jobs: number; breached: number }[]> {
  const at = now.toISOString();
  const statusList = sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );

  const rows = (await tx.execute<{ priority: string; jobs: string; breached: string }>(sql`
    select j.priority::text                                as priority,
           count(*)::text                                  as jobs,
           count(*) filter (where ${breachedInSql(at)})::text as breached
      from jobs j
     where j.deleted_at is null
       and j.status::text in (${statusList})
     group by j.priority
     -- By the enum column, which is declared emergency-first, rather than by
     -- the text it was cast to. They agree today only because the names happen
     -- to be numbered, and the board orders by the enum too.
     order by j.priority
  `)) as unknown as { priority: string; jobs: string; breached: string }[];

  return rows.map((r) => ({
    priority: r.priority as JobPriority,
    jobs: Number(r.jobs),
    breached: Number(r.breached),
  }));
}

/**
 * Allocate the next job reference for this tenant.
 *
 * Delegates to `app_next_reference`, a SECURITY DEFINER function, for two
 * reasons that application code cannot solve: counting rows races under
 * concurrency, and under the customer-scope policies a portal user can only
 * see their own jobs, so the number they compute has already been used by
 * somebody else in the tenant. See `sql/reference.sql`.
 */
export async function nextJobReference(tx: TenantScopedTx, year = new Date().getFullYear()): Promise<string> {
  const rows = await tx.execute<{ reference: string }>(
    sql`select app_next_reference('JOB', ${year}) as reference`,
  );
  const reference = rows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a job reference");
  return reference;
}

// ── The jobs list: search and keyset pagination (`LEAD-8`) ───────────────────

export interface JobSearchRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly reference: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly serviceSlug: string;
  readonly isOutdoor: boolean;
  readonly scheduledFor: Date | null;
  readonly respondByAt: Date | null;
  readonly resolveByAt: Date | null;
  readonly completedAt: Date | null;
  readonly customerName: string;
  readonly propertyName: string;
  readonly propertyArea: string | null;
  readonly propertyCity: string;
  readonly technicianName: string | null;
  readonly contractReference: string | null;
  readonly sla: SlaState;
}

/** The largest page anybody may ask for. A limit a caller can set is not a limit. */
const MAX_JOB_PAGE = 100;

/**
 * Search and page the jobs list (`LEAD-8`, closing `TD-10`).
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * The jobs screen called `listDispatchBoard` with `limit: 300`. That is not
 * "the first three hundred jobs" — it is "every job after the three hundredth
 * is unreachable", with nothing on the screen saying so and no next page to
 * reach it by. At 5,000 jobs a year (PRD §9) the cap is hit inside the first
 * year, and the jobs it hides are the oldest ones: exactly the rows somebody
 * is looking for when they open this screen with a reference in their hand.
 *
 * ── WHY THE ORDER IS created_at DESC AND NOT THE BOARD'S ────────────────────
 *
 * The dispatch board sorts by SLA consequence and stays capped — see the note
 * on `listDispatchBoard`. This is the other question: a list somebody reads or
 * searches, where newest-first is the only ordering that makes a cursor a total
 * order and therefore the only one that can page without skipping rows. The two
 * screens shared one function; they now share joins and a row shape instead,
 * which is the part that was actually worth sharing.
 *
 * The cursor is (created_at, id), row-wise, driving off jobs_keyset_idx.
 */
export async function searchJobs(
  tx: TenantScopedTx,
  options?: {
    q?: string | undefined;
    statuses?: readonly JobStatus[] | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    now?: Date | undefined;
  },
): Promise<Page<JobSearchRow>> {
  const limit = Math.min(Math.max(options?.limit ?? 25, 1), MAX_JOB_PAGE);
  const cursor = decodeCursor(options?.cursor);
  const now = options?.now ?? new Date();

  const statusFilter = jobStatusFilter(options?.statuses);
  const search = jobSearchPredicate(options?.q);

  // Row-wise, not created_at < x OR (created_at = x AND id < y). Postgres can
  // drive the tuple comparison straight off the composite index; the OR form
  // usually cannot.
  const keyset = cursor
    ? sql`and (j.created_at, j.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    : sql``;

  const rows = (await tx.execute<Record<string, never>>(sql`
    select j.id, j.created_at, j.reference, j.title, j.status::text as status,
           j.priority::text as priority, j.service_slug, j.is_outdoor,
           j.scheduled_for, j.respond_by_at, j.resolve_by_at, j.completed_at,
           c.name as customer_name,
           p.name as property_name, p.area as property_area, p.city as property_city,
           ct.reference as contract_reference,
           ${ASSIGNED_TECHNICIAN_NAME_J} as technician_name
      from jobs j
      join customers c on c.id = j.customer_id
      join properties p on p.id = j.property_id
      left join contracts ct on ct.id = j.contract_id
     where j.deleted_at is null
       ${statusFilter}
       ${search}
       ${keyset}
     order by j.created_at desc, j.id desc
     limit ${limit + 1}
  `)) as unknown as {
    id: string;
    created_at: string;
    reference: string;
    title: string;
    status: string;
    priority: string;
    service_slug: string;
    is_outdoor: boolean;
    scheduled_for: string | null;
    respond_by_at: string | null;
    resolve_by_at: string | null;
    completed_at: string | null;
    customer_name: string;
    property_name: string;
    property_area: string | null;
    property_city: string;
    contract_reference: string | null;
    technician_name: string | null;
  }[];

  const mapped: JobSearchRow[] = rows.map((r) => {
    const createdAt = requiredRowDate(r.created_at);
    const resolveByAt = rowDate(r.resolve_by_at);
    const completedAt = rowDate(r.completed_at);
    return {
      id: r.id,
      createdAt,
      reference: r.reference,
      title: r.title,
      status: r.status as JobStatus,
      priority: r.priority as JobPriority,
      serviceSlug: r.service_slug,
      isOutdoor: r.is_outdoor,
      scheduledFor: rowDate(r.scheduled_for),
      respondByAt: rowDate(r.respond_by_at),
      resolveByAt,
      completedAt,
      customerName: r.customer_name,
      propertyName: r.property_name,
      propertyArea: r.property_area,
      propertyCity: r.property_city,
      technicianName: r.technician_name,
      contractReference: r.contract_reference,
      sla: slaState({ createdAt, resolveByAt, completedAt, now }),
    };
  });

  // The LIMIT n + 1 trick: asking for one more row than the page needs makes
  // "is there a next page" a fact rather than a guess, without a second count.
  if (mapped.length <= limit) return { rows: mapped, nextCursor: null };
  const page = mapped.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

/**
 * How many jobs match, tenant-wide.
 *
 * A deliberate second query, and the reason is the trap `LEAD-8` names: a
 * headline figure derived from the page is not a total, it is a page size
 * wearing a total's clothing, and the moment paging exists the number silently
 * becomes wrong. So the count is computed over every matching row and the page
 * is computed separately; neither can turn into the other by accident.
 */
export async function countJobs(
  tx: TenantScopedTx,
  options?: { q?: string | undefined; statuses?: readonly JobStatus[] | undefined },
): Promise<number> {
  const statusFilter = jobStatusFilter(options?.statuses);
  const search = jobSearchPredicate(options?.q);

  const rows = (await tx.execute<Record<string, never>>(sql`
    select count(*) as total
      from jobs j
     where j.deleted_at is null
       ${statusFilter}
       ${search}
  `)) as unknown as { total: string }[];

  return Number(rows[0]?.total ?? 0);
}

function jobStatusFilter(statuses: readonly JobStatus[] | undefined) {
  if (!statuses || statuses.length === 0) return sql``;
  const list = sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );
  return sql`and j.status::text in (${list})`;
}

/**
 * One box, two kinds of match.
 *
 * Somebody searching jobs types a reference they were quoted on the phone or a
 * few words of what went wrong, and does not think of those as different
 * questions. Both are ILIKE with a leading wildcard, which no btree index can
 * serve — which is why migration 0023 puts trigram GIN indexes on both columns
 * rather than leaving this a sequential scan wearing a WHERE clause.
 */
function jobSearchPredicate(q: string | undefined) {
  const term = q?.trim();
  if (!term) return sql``;
  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return sql`and (j.reference ilike ${like} or j.title ilike ${like})`;
}

// ── JOB-7. The schedule ──────────────────────────────────────────────────────

/**
 * ── WHERE THE SCHEDULE ENDS AND THE DISPATCH BOARD BEGINS ───────────────────
 *
 * These are two screens over the same table and they are not the same screen,
 * so the boundary is worth stating rather than discovering later.
 *
 * The **dispatch board** answers *what needs a decision now*. Its unit is the
 * **job**, its axis is **urgency** — priority then time-to-breach — it has no
 * date range at all, and it is at its best when it is empty. A job that is
 * fully scheduled with a technician on the way has stopped being the
 * dispatcher's problem, and it is still on that board only because the SLA
 * clock has not stopped.
 *
 * The **schedule** answers *who is doing what, when*. Its unit is the **visit**
 * (`job_visits`, which is why `JOB-12` multi-visit work has a place here and
 * nowhere on the board), its axis is **time within a bounded window**, and its
 * rows are **people**. It is at its best when it is full and even. Urgency is
 * not its ordering — a P1 and a P4 in the same hour occupy the same amount of
 * that hour.
 *
 * The practical test used when deciding what belongs where: if the answer
 * changes when you change the date range, it belongs to the schedule; if it
 * changes when the clock ticks, it belongs to the board. Unassigned work is the
 * one thing both need, and it appears here as `unplaced` — a bounded rail of
 * work to place, not a second copy of the board's ordering.
 */

/** A visit on the schedule grid. Times are pre-resolved to Dubai by Postgres. */
export interface ScheduledVisit {
  readonly visitId: string;
  readonly jobId: string;
  readonly reference: string;
  readonly title: string;
  readonly jobStatus: JobStatus;
  readonly visitStatus: string;
  readonly priority: JobPriority;
  readonly serviceSlug: string;
  readonly isOutdoor: boolean;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly customerName: string;
  readonly propertyName: string;
  readonly propertyArea: string | null;
  /** Dubai-local `YYYY-MM-DD` the visit starts on, computed in SQL. */
  readonly day: string;
  /** Dubai-local minutes past midnight, computed in SQL. */
  readonly startMinute: number;
  /** End minute, clamped to the start's own day so a block never wraps. */
  readonly endMinute: number;
  readonly scheduledStart: Date;
  readonly scheduledEnd: Date | null;
}

/** A lane on the schedule: one technician, and the days they are unavailable. */
export interface ScheduleLane {
  readonly technicianId: string;
  readonly fullName: string;
  readonly primaryTrade: string;
  readonly grade: string;
  /** `HR-7` approved leave, expanded to Dubai-local days inside the window. */
  readonly leaveDays: readonly { readonly day: string; readonly kind: string }[];
  /** Planned shifts inside the window, as Dubai-local day and minute spans. */
  readonly shifts: readonly {
    readonly day: string;
    readonly startMinute: number;
    readonly endMinute: number;
    readonly kind: string;
  }[];
}

/** Work with no visit yet: the rail the dispatcher drags from. */
export interface UnplacedJob {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly priority: JobPriority;
  readonly serviceSlug: string;
  readonly isOutdoor: boolean;
  readonly customerName: string;
  readonly propertyName: string;
  readonly resolveByAt: Date | null;
  readonly sla: SlaState;
}

export interface Schedule {
  /** Dubai-local `YYYY-MM-DD`, inclusive at both ends. */
  readonly from: string;
  readonly to: string;
  /** Every day in the window, generated by Postgres, never by JavaScript. */
  readonly days: readonly string[];
  /** The window before and after this one, and today, all in Dubai. */
  readonly previousFrom: string;
  readonly nextFrom: string;
  readonly today: string;
  readonly lanes: readonly ScheduleLane[];
  readonly visits: readonly ScheduledVisit[];
  readonly unplaced: readonly UnplacedJob[];
  /** Tenant-wide, so the rail can say how much it is not showing. */
  readonly unplacedTotal: number;
  /** The tenant's calendar, so the view draws the ban band it actually has. */
  readonly calendar: WorkingCalendar;
}

/** How many unplaced jobs the rail shows before it starts saying "and N more". */
const UNPLACED_RAIL_LIMIT = 25;

/**
 * The widest window anybody may ask for.
 *
 * The range arrives in a query string, so it is attacker-controlled and much
 * more often simply a typo. A month is more schedule than a person reads and
 * far more than a `generate_series` should be asked to cross with a lateral
 * join on every lane.
 */
const MAX_SCHEDULE_DAYS = 31;

/**
 * Everything the schedule view renders, for one Dubai-local date range.
 *
 * ── WHY EVERY DATE BOUNDARY IS IN SQL ───────────────────────────────────────
 *
 * A visit at 00:30 Dubai is 20:30 the previous day in UTC. Bucketing visits
 * into days in JavaScript means doing that conversion on a server whose zone is
 * whatever the platform set, and the bug it produces is not a crash: it is a
 * visit that appears on the wrong day, once, for the people who start early.
 * So Postgres does it — `at time zone 'Asia/Dubai'` for the bucket, and
 * `generate_series` for the list of days — and the range predicate is written
 * against the raw timestamptz column so it still uses an index.
 *
 * ── WHAT THE CALENDAR IS DOING IN A QUERY FUNCTION ──────────────────────────
 *
 * It is returned, not applied. The summer midday ban is a property of the
 * tenant's configured calendar (`ADM-10`), and the view has to draw it as a
 * blocked band; reading it here rather than in the page is what stops a screen
 * quietly falling back to `DEFAULT_CALENDAR` and drawing a band that is not the
 * one this tenant is inspected against.
 */
export async function loadSchedule(
  tx: TenantScopedTx,
  options: {
    /** Dubai-local `YYYY-MM-DD`, the first day of the window. */
    from: string;
    /** How many days the window covers. 1 for a day view, 7 for a week. */
    days: number;
    now?: Date | undefined;
    calendar?: WorkingCalendar | undefined;
  },
): Promise<Schedule> {
  const { from } = options;
  const now = options.now ?? new Date();
  const dayCount = Math.min(Math.max(Math.trunc(options.days), 1), MAX_SCHEDULE_DAYS);

  // The last day of the window, as a SQL expression rather than a JavaScript
  // value. Every date boundary on this screen is Postgres arithmetic on a date,
  // including this one — adding days in JavaScript is how a schedule ends up
  // one day wide at the end of a month.
  const toDate = sql`(${from}::date + ${dayCount - 1}::int)`;

  const [
    calendar,
    dayRows,
    boundaryRows,
    visitRows,
    laneRows,
    leaveRows,
    shiftRows,
    unplacedRows,
    unplacedTotal,
  ] = await Promise.all([
      options.calendar ? Promise.resolve(options.calendar) : loadWorkingCalendar(tx),

      tx.execute<Record<string, never>>(sql`
        select to_char(d, 'YYYY-MM-DD') as day
          from generate_series(${from}::date, ${toDate}, interval '1 day') d
      `) as unknown as Promise<{ day: string }[]>,

      // Where the previous and next windows start, and what day it is in
      // Dubai — so the paging controls on the screen never need a date
      // calculation in JavaScript either.
      tx.execute<Record<string, never>>(sql`
        select to_char(${from}::date - ${dayCount}::int, 'YYYY-MM-DD') as previous_from,
               to_char(${from}::date + ${dayCount}::int, 'YYYY-MM-DD') as next_from,
               to_char((${now.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') as today
      `) as unknown as Promise<{ previous_from: string; next_from: string; today: string }[]>,

      // The range is expressed against the raw column, so the composite index
      // on (tenant_id, scheduled_start, technician_id) still drives it. Writing
      // it as a predicate on the converted value would force a scan.
      tx.execute<Record<string, never>>(sql`
        select v.id as visit_id, v.job_id, v.technician_id,
               v.status::text as visit_status,
               v.scheduled_start, v.scheduled_end,
               to_char(v.scheduled_start at time zone 'Asia/Dubai', 'YYYY-MM-DD') as day,
               extract(hour from (v.scheduled_start at time zone 'Asia/Dubai')) * 60
                 + extract(minute from (v.scheduled_start at time zone 'Asia/Dubai')) as start_minute,
               -- Clamped to the start's own day. A visit running past midnight
               -- would otherwise produce an end minute smaller than its start
               -- and a block that renders inside out.
               least(
                 1440,
                 case
                   when v.scheduled_end is null then null
                   else extract(epoch from (v.scheduled_end - v.scheduled_start)) / 60
                        + extract(hour from (v.scheduled_start at time zone 'Asia/Dubai')) * 60
                        + extract(minute from (v.scheduled_start at time zone 'Asia/Dubai'))
                 end
               ) as end_minute,
               j.reference, j.title, j.status::text as job_status,
               j.priority::text as priority, j.service_slug, j.is_outdoor,
               c.name as customer_name, p.name as property_name, p.area as property_area,
               t.full_name as technician_name
          from job_visits v
          join jobs j on j.id = v.job_id
          join customers c on c.id = j.customer_id
          join properties p on p.id = j.property_id
          join technicians t on t.id = v.technician_id
         where j.deleted_at is null
           and v.scheduled_start is not null
           and v.scheduled_start >= (${from}::date::timestamp at time zone 'Asia/Dubai')
           and v.scheduled_start < ((${toDate} + 1)::timestamp at time zone 'Asia/Dubai')
           and v.status::text not in ('declined', 'aborted')
         order by v.scheduled_start asc, t.full_name asc
      `) as unknown as Promise<
        {
          visit_id: string;
          job_id: string;
          technician_id: string;
          visit_status: string;
          scheduled_start: string;
          scheduled_end: string | null;
          day: string;
          start_minute: string;
          end_minute: string | null;
          reference: string;
          title: string;
          job_status: string;
          priority: string;
          service_slug: string;
          is_outdoor: boolean;
          customer_name: string;
          property_name: string;
          property_area: string | null;
          technician_name: string;
        }[]
      >,

      tx.execute<Record<string, never>>(sql`
        select t.id, t.full_name, t.primary_trade, t.grade
          from technicians t
         where t.is_active and t.deleted_at is null
         order by t.full_name asc
      `) as unknown as Promise<
        { id: string; full_name: string; primary_trade: string; grade: string }[]
      >,

      // HR-7. Approved leave only: a pending request is a request, and greying
      // out a lane for one would have the dispatcher planning around an absence
      // nobody has agreed to. Expanded to days in SQL because the span is
      // half-open at neither end and the arithmetic is a date arithmetic.
      tx.execute<Record<string, never>>(sql`
        select l.technician_id, l.kind, to_char(d, 'YYYY-MM-DD') as day
          from leave_requests l
          cross join lateral generate_series(
            greatest((l.starts_on at time zone 'Asia/Dubai')::date, ${from}::date),
            least((l.ends_on at time zone 'Asia/Dubai')::date, ${toDate}),
            interval '1 day'
          ) d
         where l.status = 'approved'
           and l.deleted_at is null
           and (l.starts_on at time zone 'Asia/Dubai')::date <= ${toDate}
           and (l.ends_on at time zone 'Asia/Dubai')::date >= ${from}::date
      `) as unknown as Promise<{ technician_id: string; kind: string; day: string }[]>,

      tx.execute<Record<string, never>>(sql`
        select s.technician_id, s.kind,
               to_char(s.starts_at at time zone 'Asia/Dubai', 'YYYY-MM-DD') as day,
               extract(hour from (s.starts_at at time zone 'Asia/Dubai')) * 60
                 + extract(minute from (s.starts_at at time zone 'Asia/Dubai')) as start_minute,
               least(
                 1440,
                 extract(epoch from (s.ends_at - s.starts_at)) / 60
                   + extract(hour from (s.starts_at at time zone 'Asia/Dubai')) * 60
                   + extract(minute from (s.starts_at at time zone 'Asia/Dubai'))
               ) as end_minute
          from shifts s
         where s.deleted_at is null
           and s.starts_at >= (${from}::date::timestamp at time zone 'Asia/Dubai')
           and s.starts_at < ((${toDate} + 1)::timestamp at time zone 'Asia/Dubai')
      `) as unknown as Promise<
        {
          technician_id: string;
          kind: string;
          day: string;
          start_minute: string;
          end_minute: string;
        }[]
      >,

      tx.execute<Record<string, never>>(sql`
        select j.id, j.reference, j.title, j.status::text as status,
               j.priority::text as priority, j.service_slug, j.is_outdoor,
               j.created_at, j.resolve_by_at, j.completed_at,
               c.name as customer_name, p.name as property_name
          from jobs j
          join customers c on c.id = j.customer_id
          join properties p on p.id = j.property_id
         where j.deleted_at is null
           and j.status::text in (${sql.join(
             OPEN_STATUSES.map((s) => sql`${s}`),
             sql`, `,
           )})
           and not exists (
             select 1 from job_visits v
              where v.job_id = j.id and v.status in (${ASSIGNED_VISIT_STATUS_LIST})
           )
         order by j.priority asc, j.resolve_by_at asc nulls last, j.created_at asc
         limit ${UNPLACED_RAIL_LIMIT}
      `) as unknown as Promise<
        {
          id: string;
          reference: string;
          title: string;
          status: string;
          priority: string;
          service_slug: string;
          is_outdoor: boolean;
          created_at: string;
          resolve_by_at: string | null;
          completed_at: string | null;
          customer_name: string;
          property_name: string;
        }[]
      >,

      // Its own aggregate, not the rail's length. The rail is capped at 25 and
      // the number beside it has to be the truth about the tenant.
      tx.execute<Record<string, never>>(sql`
        select count(*) as total
          from jobs j
         where j.deleted_at is null
           and j.status::text in (${sql.join(
             OPEN_STATUSES.map((s) => sql`${s}`),
             sql`, `,
           )})
           and not exists (
             select 1 from job_visits v
              where v.job_id = j.id and v.status in (${ASSIGNED_VISIT_STATUS_LIST})
           )
      `) as unknown as Promise<{ total: string }[]>,
    ]);

  const leaveByTechnician = new Map<string, { day: string; kind: string }[]>();
  for (const row of leaveRows) {
    const list = leaveByTechnician.get(row.technician_id) ?? [];
    list.push({ day: row.day, kind: row.kind });
    leaveByTechnician.set(row.technician_id, list);
  }

  const shiftsByTechnician = new Map<
    string,
    { day: string; startMinute: number; endMinute: number; kind: string }[]
  >();
  for (const row of shiftRows) {
    const list = shiftsByTechnician.get(row.technician_id) ?? [];
    list.push({
      day: row.day,
      startMinute: Number(row.start_minute),
      endMinute: Number(row.end_minute),
      kind: row.kind,
    });
    shiftsByTechnician.set(row.technician_id, list);
  }

  const days = dayRows.map((d) => d.day);
  const boundary = boundaryRows[0];

  return {
    from,
    // The last generated day, not a computed one: if the two ever disagreed
    // the header would be describing a window the rows do not come from.
    to: days[days.length - 1] ?? from,
    days,
    previousFrom: boundary?.previous_from ?? from,
    nextFrom: boundary?.next_from ?? from,
    today: boundary?.today ?? from,
    lanes: laneRows.map((t) => ({
      technicianId: t.id,
      fullName: t.full_name,
      primaryTrade: t.primary_trade,
      grade: t.grade,
      leaveDays: leaveByTechnician.get(t.id) ?? [],
      shifts: shiftsByTechnician.get(t.id) ?? [],
    })),
    visits: visitRows.map((r) => {
      const startMinute = Number(r.start_minute);
      return {
        visitId: r.visit_id,
        jobId: r.job_id,
        reference: r.reference,
        title: r.title,
        jobStatus: r.job_status as JobStatus,
        visitStatus: r.visit_status,
        priority: r.priority as JobPriority,
        serviceSlug: r.service_slug,
        isOutdoor: r.is_outdoor,
        technicianId: r.technician_id,
        technicianName: r.technician_name,
        customerName: r.customer_name,
        propertyName: r.property_name,
        propertyArea: r.property_area,
        day: r.day,
        startMinute,
        // A visit with no end is shown as an hour: long enough to be a block a
        // person can see and click, short enough that it does not claim time
        // nobody has actually committed.
        endMinute: r.end_minute === null ? startMinute + 60 : Number(r.end_minute),
        scheduledStart: requiredRowDate(r.scheduled_start),
        scheduledEnd: rowDate(r.scheduled_end),
      };
    }),
    unplaced: unplacedRows.map((r) => ({
      id: r.id,
      reference: r.reference,
      title: r.title,
      status: r.status as JobStatus,
      priority: r.priority as JobPriority,
      serviceSlug: r.service_slug,
      isOutdoor: r.is_outdoor,
      customerName: r.customer_name,
      propertyName: r.property_name,
      resolveByAt: rowDate(r.resolve_by_at),
      sla: slaState({
        createdAt: requiredRowDate(r.created_at),
        resolveByAt: rowDate(r.resolve_by_at),
        completedAt: rowDate(r.completed_at),
        now,
      }),
    })),
    unplacedTotal: Number(unplacedTotal[0]?.total ?? 0),
    calendar,
  };
}

/** Visit states that have already happened, or been refused. Not movable. */
const SETTLED_VISIT_STATUSES = ["completed", "no_access", "aborted", "declined"];

/** Job states in which moving a visit still means anything. */
const RESCHEDULABLE_JOB_STATUSES: readonly JobStatus[] = [
  "submitted",
  "triaged",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "paused",
];

/**
 * Move an existing visit to a new window (`JOB-7`, "drag to reschedule").
 *
 * ── WHY THE CHECKS ARE HERE AND NOT IN THE DROP HANDLER ─────────────────────
 *
 * The grid the dispatcher dragged across was rendered at some point in the
 * past, against a calendar that may since have gained a public holiday and a
 * technician who may since have had leave approved. A check that lives in the
 * component is an affordance; this is the control. `TRD §7.3` is explicit that
 * it belongs in the domain layer.
 *
 * Three refusals, in descending order of consequence:
 *
 *  1. **The summer midday ban** (`JOB-6`), for outdoor work only. AED 5,000 per
 *     worker, capped at AED 50,000, plus a company classification downgrade.
 *     A hard block — there is no override argument on this function, because a
 *     block a caller can pass a flag to skip is a warning wearing a costume.
 *     Indoor work moves through the window normally, which is the half people
 *     get wrong in the other direction.
 *  2. **Approved leave** (`HR-7` feeding `JOB-8`). Not a statutory penalty, but
 *     a visit booked onto somebody's approved annual leave is a visit that will
 *     not happen, and finding that out on the day costs a customer.
 *  3. **A visit that has already happened.** Completed, aborted, refused for
 *     no access — the record of what occurred is not a plan to be edited.
 *
 * This deliberately does NOT change the technician. Moving a visit into another
 * person's lane is re-assignment: it has to re-run skill matching, the `HR-9`
 * certification block and the availability rules of `JOB-8`, all of which live
 * in `assignment.ts`. Doing it here would mean a second, weaker assignment path
 * that skips those — so the schedule refuses cross-lane moves rather than
 * quietly performing a worse version of one.
 */
export async function rescheduleVisit(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    visitId: string;
    scheduledStart: Date;
    scheduledEnd?: Date | undefined;
    /** Supplied by callers that already loaded it; read here otherwise. */
    calendar?: WorkingCalendar | undefined;
  },
): Promise<{
  jobId: string;
  jobReference: string;
  technicianId: string;
  technicianName: string;
  from: Date | null;
  scheduledStart: Date;
  scheduledEnd: Date;
}> {
  const rows = (await tx.execute<Record<string, never>>(sql`
    select v.id, v.job_id, v.technician_id, v.status::text as visit_status,
           v.scheduled_start, v.scheduled_end,
           j.reference, j.status::text as job_status, j.is_outdoor,
           t.full_name as technician_name
      from job_visits v
      join jobs j on j.id = v.job_id
      join technicians t on t.id = v.technician_id
     where v.id = ${input.visitId}::uuid
     limit 1
  `)) as unknown as {
    id: string;
    job_id: string;
    technician_id: string;
    visit_status: string;
    scheduled_start: string | null;
    scheduled_end: string | null;
    reference: string;
    job_status: string;
    is_outdoor: boolean;
    technician_name: string;
  }[];

  const visit = rows[0];
  // RLS makes "not found" and "belongs to another tenant" indistinguishable
  // here, which is the intended behaviour.
  if (!visit) throw new UserFacingError("That visit is not in this tenant.");

  if (SETTLED_VISIT_STATUSES.includes(visit.visit_status)) {
    throw new UserFacingError(
      `This visit is already ${visit.visit_status.replace("_", " ")} — what happened cannot be rescheduled. ` +
        "Raise a return visit instead.",
    );
  }

  if (!RESCHEDULABLE_JOB_STATUSES.includes(visit.job_status as JobStatus)) {
    throw new UserFacingError(
      `${visit.reference} is ${STATUS_LABEL[visit.job_status as JobStatus] ?? visit.job_status} and its visits are no longer scheduled.`,
    );
  }

  // Two hours is what assignTechnician assumes when it is given no end, and the
  // two have to agree or a dragged visit would silently change length.
  const scheduledEnd =
    input.scheduledEnd ?? new Date(input.scheduledStart.getTime() + 2 * 60 * 60 * 1000);

  if (scheduledEnd <= input.scheduledStart) {
    throw new UserFacingError("A visit has to end after it starts.");
  }

  const calendar = input.calendar ?? (await loadWorkingCalendar(tx));

  // JOB-6. The hard block.
  if (visit.is_outdoor) {
    const check = checkOutdoorWindow(input.scheduledStart, scheduledEnd, calendar);
    if (!check.allowed) {
      throw new UserFacingError(
        check.nextAllowed
          ? `${check.message} The first legal start after that is ${check.nextAllowed.toISOString()}.`
          : (check.message ?? "That window is not permitted for outdoor work."),
      );
    }
  }

  // HR-7 into JOB-8. Approved leave, on the Dubai-local day the visit starts.
  const leave = (await tx.execute<Record<string, never>>(sql`
    select l.kind
      from leave_requests l
     where l.technician_id = ${visit.technician_id}::uuid
       and l.status = 'approved'
       and l.deleted_at is null
       and (l.starts_on at time zone 'Asia/Dubai')::date
           <= (${input.scheduledStart.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date
       and (l.ends_on at time zone 'Asia/Dubai')::date
           >= (${input.scheduledStart.toISOString()}::timestamptz at time zone 'Asia/Dubai')::date
     limit 1
  `)) as unknown as { kind: string }[];

  const onLeave = leave[0];
  if (onLeave) {
    throw new UserFacingError(
      `${visit.technician_name} is on approved ${onLeave.kind} leave that day. Move the visit or assign somebody else.`,
    );
  }

  await tx.execute(sql`
    update job_visits
       set scheduled_start = ${input.scheduledStart.toISOString()}::timestamptz,
           scheduled_end = ${scheduledEnd.toISOString()}::timestamptz,
           updated_at = now()
     where id = ${input.visitId}::uuid
  `);

  // The job's own scheduled_for is what the dispatch board and the customer
  // notification read, so it follows the earliest live visit rather than being
  // left to disagree with the grid.
  await tx.execute(sql`
    update jobs j
       set scheduled_for = (
             select min(v.scheduled_start)
               from job_visits v
              where v.job_id = j.id
                and v.status::text not in ('declined', 'aborted', 'no_access')
           ),
           updated_at = now()
     where j.id = ${visit.job_id}::uuid
  `);

  await writeAuditNote(tx, ctx, {
    tableName: "job_visits",
    recordId: input.visitId,
    // Eleven characters. audit_log.action is varchar(16), which rules out
    // "visit_rescheduled".
    action: "rescheduled",
    detail: {
      rule: "JOB-7",
      jobId: visit.job_id,
      jobReference: visit.reference,
      technicianId: visit.technician_id,
      from: visit.scheduled_start,
      to: input.scheduledStart.toISOString(),
      end: scheduledEnd.toISOString(),
      isOutdoor: visit.is_outdoor,
    },
  });

  return {
    jobId: visit.job_id,
    jobReference: visit.reference,
    technicianId: visit.technician_id,
    technicianName: visit.technician_name,
    from: rowDate(visit.scheduled_start),
    scheduledStart: input.scheduledStart,
    scheduledEnd,
  };
}
