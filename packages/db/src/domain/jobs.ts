import { and, eq, sql, desc, asc, inArray, isNull } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  slaState,
  STATUS_LABEL,
  canTransition,
  InvalidTransitionError,
  OPEN_STATUSES,
  type SlaState,
  type JobStatus,
  type JobPriority,
} from "@meridian/core";

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
  readonly sla: SlaState;
}

/**
 * The dispatch board's query. Hits `jobs_board_idx` on
 * (tenant_id, status, priority, scheduled_for).
 *
 * SLA state is computed in application code rather than SQL on purpose: it
 * depends on "now", so doing it in the query would make the result
 * uncacheable and the logic untestable without a database.
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
      technicianName: schema.technicians.fullName,
    })
    .from(schema.jobs)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.jobs.customerId))
    .innerJoin(schema.properties, eq(schema.properties.id, schema.jobs.propertyId))
    .leftJoin(
      schema.jobVisits,
      and(
        eq(schema.jobVisits.jobId, schema.jobs.id),
        // "completed" is included deliberately. A job sitting in work_complete
        // awaiting sign-off still has a technician who did the work, and
        // showing it as unassigned both misleads the dispatcher and inflates
        // the unassigned count they are trying to drive to zero.
        inArray(schema.jobVisits.status, ["assigned", "accepted", "en_route", "arrived", "completed"]),
      ),
    )
    .leftJoin(schema.technicians, eq(schema.technicians.id, schema.jobVisits.technicianId))
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

/** Counts for the board header. One query, not one per status. */
export async function dispatchBoardCounts(
  tx: TenantScopedTx,
  now: Date = new Date(),
): Promise<{ open: number; breached: number; atRisk: number; unassigned: number }> {
  const rows = await listDispatchBoard(tx, { now, limit: 1000 });
  return {
    open: rows.length,
    breached: rows.filter((r) => r.sla === "breached").length,
    atRisk: rows.filter((r) => r.sla === "at_risk").length,
    unassigned: rows.filter((r) => r.technicianName === null).length,
  };
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
