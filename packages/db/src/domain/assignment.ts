import { and, eq, sql, inArray, isNull, or, gte, lte } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { transitionJob } from "./jobs";
import type { JobStatus } from "@meridian/core";

/**
 * Technician assignment.
 *
 * Deliberately NOT an LLM. Ranking technicians by skill, certification
 * validity, availability and distance is a constraint problem with an exact
 * answer; a scoring function is faster, cheaper, deterministic, testable, and -
 * critically - explainable to a dispatcher who asks "why him?". See
 * docs/adr/0005-ai-model-tiering.md.
 *
 * The distinction that matters in the code below is between **hard filters**
 * and **soft scoring**. A lapsed certification is not a low score, it is a
 * disqualification: sending an uncertified technician is a liability question,
 * not a preference. Distance and current load are scoring.
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
}

export interface DisqualifiedTechnician {
  readonly technicianId: string;
  readonly fullName: string;
  readonly reason: string;
}

export interface CandidateResult {
  readonly candidates: readonly Candidate[];
  /**
   * Technicians who have the skill but were excluded, with why.
   *
   * Surfaced rather than silently dropped: a dispatcher who cannot see that
   * their best technician was excluded for a lapsed certificate will assume
   * the system is broken and work around it.
   */
  readonly disqualified: readonly DisqualifiedTechnician[];
}

/**
 * Rank technicians for a job.
 *
 * Hard filters: active, holds a skill for the service, no lapsed certification
 * required for that service, not on approved leave over the window.
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

  if (skilled.length === 0) return { candidates: [], disqualified: [] };

  const ids = skilled.map((s) => s.technicianId);

  // HARD FILTER: certifications that are mandatory for this service and have
  // lapsed. `required_for_services` is a JSONB array of service slugs.
  const lapsed = await tx
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
        lte(schema.technicianCertifications.expiresOn, from),
      ),
    );

  // HARD FILTER: approved leave overlapping the work window.
  const onLeave = await tx
    .select({ technicianId: schema.leaveRequests.technicianId })
    .from(schema.leaveRequests)
    .where(
      and(
        inArray(schema.leaveRequests.technicianId, ids),
        eq(schema.leaveRequests.status, "approved"),
        lte(schema.leaveRequests.startsOn, to),
        gte(schema.leaveRequests.endsOn, from),
      ),
    );

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

  const lapsedBy = new Map(lapsed.map((l) => [l.technicianId, l]));
  const leaveSet = new Set(onLeave.map((l) => l.technicianId));
  const loadBy = new Map(loads.map((l) => [l.technicianId, l.openVisits]));

  const candidates: Candidate[] = [];
  const disqualified: DisqualifiedTechnician[] = [];

  for (const t of skilled) {
    const lapsedCert = lapsedBy.get(t.technicianId);
    if (lapsedCert) {
      disqualified.push({
        technicianId: t.technicianId,
        fullName: t.fullName,
        reason: `${lapsedCert.name} expired${lapsedCert.expiresOn ? ` on ${lapsedCert.expiresOn.toISOString().slice(0, 10)}` : ""}`,
      });
      continue;
    }

    if (leaveSet.has(t.technicianId)) {
      disqualified.push({
        technicianId: t.technicianId,
        fullName: t.fullName,
        reason: "On approved leave for this window",
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

    candidates.push({
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
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return { candidates: candidates.slice(0, input.limit ?? 10), disqualified };
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
  },
): Promise<{ visitId: string; sequence: number }> {
  const jobRows = await tx
    .select({ status: schema.jobs.status })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const job = jobRows[0];
  if (!job) throw new Error("Job not found in this tenant");

  const existing = await tx
    .select({ sequence: schema.jobVisits.sequence })
    .from(schema.jobVisits)
    .where(eq(schema.jobVisits.jobId, input.jobId));

  const sequence = existing.reduce((max, v) => Math.max(max, v.sequence), 0) + 1;
  const start = input.scheduledStart ?? new Date();

  const [visit] = await tx
    .insert(schema.jobVisits)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      technicianId: input.technicianId,
      sequence,
      status: "assigned",
      scheduledStart: start,
      scheduledEnd: input.scheduledEnd ?? new Date(start.getTime() + 2 * 60 * 60 * 1000),
      dispatchedAt: new Date(),
      assignmentMethod: input.method ?? "manual",
      assignmentScore: input.score ?? null,
      assignmentReason: input.reason ?? null,
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

  return { visitId: visit.id, sequence };
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
