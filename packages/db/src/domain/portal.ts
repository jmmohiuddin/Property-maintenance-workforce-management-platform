import { and, eq, isNull, asc } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { loadWorkingCalendar } from "./reference";
import { computeSlaDeadlines, UserFacingError, type JobPriority } from "@meridian/core";
import { nextJobReference } from "./jobs";

/**
 * Customer-portal writes.
 *
 * Unlike the public quote form, an authenticated portal user already HAS a
 * customer record and properties - so they can raise a real job directly
 * rather than a lead. That is the whole difference between the two entry
 * points and it is why they are separate code paths.
 *
 * Every function here must be called inside `withCustomerScope`, so the
 * restrictive policies do the scoping. The `propertyId` below is deliberately
 * not validated against the customer in application code: if the property
 * belongs to someone else it is invisible to this transaction, so the lookup
 * returns nothing and the insert never happens.
 */

export async function listCustomerProperties(
  tx: TenantScopedTx,
): Promise<readonly { id: string; name: string; area: string | null; city: string }[]> {
  return tx
    .select({
      id: schema.properties.id,
      name: schema.properties.name,
      area: schema.properties.area,
      city: schema.properties.city,
    })
    .from(schema.properties)
    .where(and(isNull(schema.properties.deletedAt), eq(schema.properties.isActive, true)))
    .orderBy(asc(schema.properties.name));
}

/**
 * Raise a job from the portal.
 *
 * Portal-raised jobs start at `submitted`, not `triaged`: a customer describes
 * a symptom, and deciding the trade, the priority and the duration is the
 * operator's judgement. Skipping triage would let a customer set their own SLA.
 */
export async function createPortalRequest(
  tx: TenantScopedTx,
  ctx: TenantContext & { customerId: string },
  input: {
    propertyId: string;
    serviceSlug: string;
    title: string;
    description?: string | undefined;
    /** What the customer says. Operations may revise it at triage. */
    requestedPriority: JobPriority;
  },
): Promise<{ jobId: string; reference: string }> {
  const properties = await tx
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(eq(schema.properties.id, input.propertyId))
    .limit(1);

  // Invisible under customer scope means "not yours", and we do not distinguish.
  if (!properties[0]) throw new UserFacingError("That property is not on your account");

  const now = new Date();
  // ADM-10. The stored calendar, not DEFAULT_CALENDAR.
  //
  // computeSlaDeadlines takes a calendar as its fourth argument and falls back
  // to the default when none is given — and the default ships with an EMPTY
  // holiday list, deliberately, because a hardcoded one goes stale in January.
  // Taking that fallback silently here would mean an administrator could enter
  // every UAE public holiday and every deadline computed afterwards would still
  // ignore them. The seam existed; nothing was using it.
  const calendar = await loadWorkingCalendar(tx);
  const { respondByAt, resolveByAt } = computeSlaDeadlines(input.requestedPriority, now, undefined, calendar);
  const reference = await nextJobReference(tx);

  const [job] = await tx
    .insert(schema.jobs)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: ctx.customerId,
      propertyId: input.propertyId,
      serviceSlug: input.serviceSlug,
      title: input.title,
      description: input.description ?? null,
      status: "submitted",
      priority: input.requestedPriority,
      source: "customer_portal",
      respondByAt,
      resolveByAt,
      createdById: ctx.userId ?? null,
    })
    .returning({ id: schema.jobs.id });

  if (!job) throw new Error("Could not raise the request");

  await tx.insert(schema.jobEvents).values({
    tenantId: ctx.tenantId,
    jobId: job.id,
    fromStatus: null,
    toStatus: "submitted",
    note: "Raised by the customer in the portal",
    actorId: ctx.userId ?? null,
    actorKind: "customer",
  });

  return { jobId: job.id, reference };
}
