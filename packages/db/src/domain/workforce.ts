import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../schema";
import type { TenantScopedTx } from "../index";
import { certState, UserFacingError, type CertState } from "@meridian/core";
import { OCCUPYING_VISIT_STATUSES } from "./assignment";

export { certState, CERT_WARNING_DAYS, CERT_STATE_LABEL, type CertState } from "@meridian/core";

/**
 * Technician roster, skills and certifications.
 *
 * This module exists because the dispatch engine's hard filters
 * (`findCandidates`) are only as good as the data behind them: a technician
 * with no verified skill row is invisible to dispatch, and one with a lapsed
 * mandatory certification is silently disqualified. Operations needs a screen
 * where both of those facts are visible and fixable, otherwise the usual
 * failure mode is "why did nobody get assigned?" with no way to answer it.
 */

export interface TechnicianRow {
  id: string;
  employeeCode: string;
  fullName: string;
  phone: string;
  email: string | null;
  employment: string;
  primaryTrade: string;
  grade: string;
  baseCity: string | null;
  isActive: boolean;
  visaExpiresOn: Date | null;
  skillSlugs: string[];
  /** Certifications that are expired or inside the warning window. */
  certAlerts: { name: string; expiresOn: Date | null; state: CertState }[];
  openVisits: number;
}

/**
 * The roster, with everything a dispatcher needs to spot a gap in one pass:
 * which services each person can actually be dispatched for, which papers are
 * about to lapse, and how loaded they already are.
 */
export async function listTechnicians(
  tx: TenantScopedTx,
  opts: { includeInactive?: boolean } = {},
): Promise<TechnicianRow[]> {
  const rows = await tx
    .select({
      id: schema.technicians.id,
      employeeCode: schema.technicians.employeeCode,
      fullName: schema.technicians.fullName,
      phone: schema.technicians.phone,
      email: schema.technicians.email,
      employment: schema.technicians.employment,
      primaryTrade: schema.technicians.primaryTrade,
      grade: schema.technicians.grade,
      baseCity: schema.technicians.baseCity,
      isActive: schema.technicians.isActive,
      visaExpiresOn: schema.technicians.visaExpiresOn,
    })
    .from(schema.technicians)
    .where(
      opts.includeInactive
        ? isNull(schema.technicians.deletedAt)
        : and(isNull(schema.technicians.deletedAt), eq(schema.technicians.isActive, true)),
    )
    .orderBy(asc(schema.technicians.fullName));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const [skills, certs, loads] = await Promise.all([
    tx
      .select({
        technicianId: schema.technicianSkills.technicianId,
        serviceSlug: schema.technicianSkills.serviceSlug,
      })
      .from(schema.technicianSkills)
      .where(inArray(schema.technicianSkills.technicianId, ids)),
    tx
      .select({
        technicianId: schema.technicianCertifications.technicianId,
        name: schema.technicianCertifications.name,
        expiresOn: schema.technicianCertifications.expiresOn,
      })
      .from(schema.technicianCertifications)
      .where(inArray(schema.technicianCertifications.technicianId, ids)),
    tx
      .select({
        technicianId: schema.jobVisits.technicianId,
        openVisits: sql<number>`count(*)::int`,
      })
      .from(schema.jobVisits)
      .where(
        and(
          inArray(schema.jobVisits.technicianId, ids),
          // The dispatch engine's own list rather than a copy of it. This
          // count is shown on the roster as "how much is this person
          // carrying", so it has to answer the same question `findCandidates`
          // scores on — including agreeing that a `superseded` visit (`0040`)
          // is nobody's work.
          inArray(schema.jobVisits.status, [...OCCUPYING_VISIT_STATUSES]),
        ),
      )
      .groupBy(schema.jobVisits.technicianId),
  ]);

  const now = new Date();
  const skillsBy = new Map<string, string[]>();
  for (const s of skills) {
    const list = skillsBy.get(s.technicianId);
    if (list) list.push(s.serviceSlug);
    else skillsBy.set(s.technicianId, [s.serviceSlug]);
  }

  const alertsBy = new Map<string, TechnicianRow["certAlerts"]>();
  for (const c of certs) {
    const state = certState(c.expiresOn, now);
    if (state !== "expired" && state !== "expiring") continue;
    const entry = { name: c.name, expiresOn: c.expiresOn, state };
    const list = alertsBy.get(c.technicianId);
    if (list) list.push(entry);
    else alertsBy.set(c.technicianId, [entry]);
  }

  const loadBy = new Map(loads.map((l) => [l.technicianId, l.openVisits]));

  return rows.map((r) => ({
    ...r,
    skillSlugs: (skillsBy.get(r.id) ?? []).sort(),
    // Expired first: a lapsed certification is a dispatch blocker, a warning is not.
    certAlerts: (alertsBy.get(r.id) ?? []).sort((a, b) =>
      a.state === b.state ? 0 : a.state === "expired" ? -1 : 1,
    ),
    openVisits: loadBy.get(r.id) ?? 0,
  }));
}

export interface TechnicianDetail {
  technician: {
    id: string;
    employeeCode: string;
    fullName: string;
    phone: string;
    email: string | null;
    employment: string;
    primaryTrade: string;
    grade: string;
    baseCity: string | null;
    isActive: boolean;
    visaExpiresOn: Date | null;
    joinedOn: Date | null;
  };
  skills: {
    id: string;
    serviceSlug: string;
    proficiency: number;
    verifiedAt: Date | null;
    verifiedByName: string | null;
  }[];
  certifications: {
    id: string;
    name: string;
    issuer: string | null;
    reference: string | null;
    issuedOn: Date | null;
    expiresOn: Date | null;
    requiredForServices: string[];
    state: CertState;
  }[];
}

export async function getTechnician(
  tx: TenantScopedTx,
  technicianId: string,
): Promise<TechnicianDetail | null> {
  const [technician] = await tx
    .select({
      id: schema.technicians.id,
      employeeCode: schema.technicians.employeeCode,
      fullName: schema.technicians.fullName,
      phone: schema.technicians.phone,
      email: schema.technicians.email,
      employment: schema.technicians.employment,
      primaryTrade: schema.technicians.primaryTrade,
      grade: schema.technicians.grade,
      baseCity: schema.technicians.baseCity,
      isActive: schema.technicians.isActive,
      visaExpiresOn: schema.technicians.visaExpiresOn,
      joinedOn: schema.technicians.joinedOn,
    })
    .from(schema.technicians)
    .where(and(eq(schema.technicians.id, technicianId), isNull(schema.technicians.deletedAt)))
    .limit(1);

  if (!technician) return null;

  const [skills, certs] = await Promise.all([
    tx
      .select({
        id: schema.technicianSkills.id,
        serviceSlug: schema.technicianSkills.serviceSlug,
        proficiency: schema.technicianSkills.proficiency,
        verifiedAt: schema.technicianSkills.verifiedAt,
        verifiedByName: schema.users.fullName,
      })
      .from(schema.technicianSkills)
      .leftJoin(schema.users, eq(schema.users.id, schema.technicianSkills.verifiedById))
      .where(eq(schema.technicianSkills.technicianId, technicianId))
      .orderBy(asc(schema.technicianSkills.serviceSlug)),
    tx
      .select({
        id: schema.technicianCertifications.id,
        name: schema.technicianCertifications.name,
        issuer: schema.technicianCertifications.issuer,
        reference: schema.technicianCertifications.reference,
        issuedOn: schema.technicianCertifications.issuedOn,
        expiresOn: schema.technicianCertifications.expiresOn,
        requiredForServices: schema.technicianCertifications.requiredForServices,
      })
      .from(schema.technicianCertifications)
      .where(eq(schema.technicianCertifications.technicianId, technicianId))
      .orderBy(asc(schema.technicianCertifications.expiresOn)),
  ]);

  const now = new Date();

  return {
    technician,
    skills,
    certifications: certs.map((c) => ({
      ...c,
      requiredForServices: Array.isArray(c.requiredForServices)
        ? (c.requiredForServices as string[])
        : [],
      state: certState(c.expiresOn, now),
    })),
  };
}

/**
 * Add or re-grade a skill.
 *
 * Adding a skill is the act that makes a technician dispatchable for a service,
 * so it records who vouched for it. `onConflictDoUpdate` makes the operation
 * idempotent — a supervisor re-grading someone is the same action as adding.
 */
export async function upsertSkill(
  tx: TenantScopedTx,
  ctx: { tenantId: string; userId: string },
  input: { technicianId: string; serviceSlug: string; proficiency: number },
): Promise<void> {
  if (input.proficiency < 1 || input.proficiency > 5) {
    throw new UserFacingError("Proficiency must be between 1 and 5.");
  }

  await tx
    .insert(schema.technicianSkills)
    .values({
      tenantId: ctx.tenantId,
      technicianId: input.technicianId,
      serviceSlug: input.serviceSlug,
      proficiency: input.proficiency,
      verifiedById: ctx.userId,
      verifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.technicianSkills.tenantId,
        schema.technicianSkills.technicianId,
        schema.technicianSkills.serviceSlug,
      ],
      set: {
        proficiency: input.proficiency,
        verifiedById: ctx.userId,
        verifiedAt: new Date(),
        updatedAt: new Date(),
      },
    });
}

/**
 * Remove a skill outright rather than soft-deleting it.
 *
 * A skill row is a live dispatch permission, not history: leaving a withdrawn
 * skill behind with a flag invites a query that forgets the flag and assigns
 * someone who is no longer signed off. The audit trigger keeps the record of
 * what was removed and by whom.
 */
export async function removeSkill(tx: TenantScopedTx, skillId: string): Promise<void> {
  await tx.delete(schema.technicianSkills).where(eq(schema.technicianSkills.id, skillId));
}

export async function addCertification(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: {
    technicianId: string;
    name: string;
    issuer?: string;
    reference?: string;
    issuedOn?: Date;
    expiresOn?: Date;
    requiredForServices?: string[];
  },
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(schema.technicianCertifications)
    .values({
      tenantId: ctx.tenantId,
      technicianId: input.technicianId,
      name: input.name,
      issuer: input.issuer ?? null,
      reference: input.reference ?? null,
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      requiredForServices: input.requiredForServices ?? [],
    })
    .returning({ id: schema.technicianCertifications.id });

  if (!row) throw new Error("Could not record the certification.");
  return row;
}

export async function removeCertification(tx: TenantScopedTx, certificationId: string): Promise<void> {
  await tx
    .delete(schema.technicianCertifications)
    .where(eq(schema.technicianCertifications.id, certificationId));
}

/**
 * Coverage: how many dispatchable technicians exist per service.
 *
 * A service with zero verified technicians is a promise the website makes that
 * dispatch cannot keep, and nothing else in the system surfaces that.
 */
export async function skillCoverage(
  tx: TenantScopedTx,
): Promise<{ serviceSlug: string; technicians: number }[]> {
  return tx
    .select({
      serviceSlug: schema.technicianSkills.serviceSlug,
      technicians: sql<number>`count(distinct ${schema.technicianSkills.technicianId})::int`,
    })
    .from(schema.technicianSkills)
    .innerJoin(
      schema.technicians,
      and(
        eq(schema.technicians.id, schema.technicianSkills.technicianId),
        eq(schema.technicians.isActive, true),
        isNull(schema.technicians.deletedAt),
      ),
    )
    .groupBy(schema.technicianSkills.serviceSlug);
}
