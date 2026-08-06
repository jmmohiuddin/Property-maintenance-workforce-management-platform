import { and, eq, desc, sql, isNull, inArray } from "drizzle-orm";
import { db, withTenant, type TenantScopedTx, type TenantContext } from "../index";
import * as schema from "../schema";
import {
  computeSlaDeadlines,
  OPEN_LEAD_STAGES,
  type JobPriority,
  type LeadStage,
  UserFacingError,
} from "@meridian/core";
import { nextJobReference } from "./jobs";

/**
 * Leads.
 *
 * A public enquiry becomes a `lead`, not a `job`. That is a deliberate domain
 * decision rather than a shortcut: a job requires a customer and a property,
 * and a web form submission has neither - it has a name, a phone number and a
 * description of a problem. Forcing a job would mean inventing a customer
 * record for every tyre-kicker and every duplicate submission, which corrupts
 * the customer list and makes job counts meaningless.
 *
 * So the flow is: enquiry -> lead -> (qualified by a human) -> customer +
 * property + job. `convertLeadToJob` below does that conversion in one
 * transaction.
 */

export interface PublicEnquiry {
  readonly name: string;
  readonly phone: string;
  readonly email?: string | undefined;
  readonly serviceSlug: string;
  readonly urgency: string;
  readonly propertyType: string;
  readonly city: string;
  readonly area?: string | undefined;
  readonly details?: string | undefined;
  /** utm_source / medium / campaign / referrer, for attribution reporting. */
  readonly attribution?: Record<string, string> | undefined;
}

/**
 * Resolve the tenant that owns the public website.
 *
 * Goes through a SECURITY DEFINER function because an unauthenticated visitor
 * has no tenant context. See sql/public-functions.sql.
 */
export async function resolvePublicTenantId(slug: string): Promise<string | null> {
  const result = await db.execute<{ app_public_resolve_tenant: string | null }>(
    sql`select app_public_resolve_tenant(${slug})`,
  );
  return (result as unknown as { app_public_resolve_tenant: string | null }[])[0]
    ?.app_public_resolve_tenant ?? null;
}

/** Record a public enquiry as a lead. Runs inside the tenant boundary. */
export async function createLeadFromEnquiry(
  tenantId: string,
  enquiry: PublicEnquiry,
): Promise<{ leadId: string; reference: string }> {
  return withTenant({ tenantId, actorKind: "customer" }, async (tx) => {
    const [row] = await tx
      .insert(schema.leads)
      .values({
        tenantId,
        name: enquiry.name,
        email: enquiry.email || null,
        phone: enquiry.phone,
        serviceSlug: enquiry.serviceSlug,
        city: enquiry.city,
        area: enquiry.area || null,
        propertyTypeGuess: enquiry.propertyType as never,
        stage: "new",
        source: "website",
        attribution: enquiry.attribution ?? {},
        message: enquiry.details || null,
        // An emergency enquiry needs looking at now, not on the next follow-up
        // sweep. Everything else gets a next-working-day nudge.
        nextFollowUpAt:
          enquiry.urgency === "emergency"
            ? new Date()
            : new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.leads.id });

    if (!row) throw new Error("Failed to record lead");

    // Human-facing reference. Derived from the id rather than a counter so it
    // needs no extra round trip and cannot collide.
    const reference = `ENQ-${row.id.slice(0, 8).toUpperCase()}`;
    return { leadId: row.id, reference };
  });
}

export interface LeadRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly serviceSlug: string | null;
  readonly city: string | null;
  readonly area: string | null;
  readonly stage: LeadStage;
  readonly message: string | null;
  readonly createdAt: Date;
  readonly nextFollowUpAt: Date | null;
  readonly convertedCustomerId: string | null;
}

export async function listLeads(
  tx: TenantScopedTx,
  options?: { stages?: readonly LeadStage[]; limit?: number },
): Promise<readonly LeadRow[]> {
  const stages = options?.stages ?? OPEN_LEAD_STAGES;

  const rows = await tx
    .select({
      id: schema.leads.id,
      name: schema.leads.name,
      phone: schema.leads.phone,
      email: schema.leads.email,
      serviceSlug: schema.leads.serviceSlug,
      city: schema.leads.city,
      area: schema.leads.area,
      stage: schema.leads.stage,
      message: schema.leads.message,
      createdAt: schema.leads.createdAt,
      nextFollowUpAt: schema.leads.nextFollowUpAt,
      convertedCustomerId: schema.leads.convertedCustomerId,
    })
    .from(schema.leads)
    // inArray, not a raw interpolated array literal. These values are internal
    // constants today, but a raw-SQL habit here is one refactor away from
    // taking a stage filter straight from a query string.
    .where(and(isNull(schema.leads.deletedAt), inArray(schema.leads.stage, [...stages])))
    .orderBy(desc(schema.leads.createdAt))
    .limit(options?.limit ?? 100);

  return rows.map((r) => ({ ...r, stage: r.stage as LeadStage }));
}

export async function getLead(tx: TenantScopedTx, leadId: string): Promise<LeadRow | null> {
  const rows = await tx
    .select({
      id: schema.leads.id,
      name: schema.leads.name,
      phone: schema.leads.phone,
      email: schema.leads.email,
      serviceSlug: schema.leads.serviceSlug,
      city: schema.leads.city,
      area: schema.leads.area,
      stage: schema.leads.stage,
      message: schema.leads.message,
      createdAt: schema.leads.createdAt,
      nextFollowUpAt: schema.leads.nextFollowUpAt,
      convertedCustomerId: schema.leads.convertedCustomerId,
    })
    .from(schema.leads)
    .where(eq(schema.leads.id, leadId))
    .limit(1);

  const row = rows[0];
  return row ? { ...row, stage: row.stage as LeadStage } : null;
}

/**
 * Convert a qualified lead into a customer, a property and a job.
 *
 * One transaction. A half-converted lead - a customer with no property, or a
 * property with no job - is worse than an unconverted one, because it looks
 * like real data to every report that follows.
 */
export async function convertLeadToJob(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    leadId: string;
    /** Reuse an existing customer, or create one from the lead's details. */
    customerId?: string | undefined;
    propertyName: string;
    addressLine: string;
    priority: JobPriority;
    title: string;
  },
): Promise<{ jobId: string; reference: string; customerId: string; propertyId: string }> {
  const lead = await getLead(tx, input.leadId);
  if (!lead) throw new Error("Lead not found in this tenant");
  if (lead.convertedCustomerId) throw new UserFacingError("This lead has already been converted");

  let customerId = input.customerId;

  if (!customerId) {
    // Tenant-unique code derived from the name, with a short suffix so two
    // customers called "Al Futtaim" cannot collide.
    const base = lead.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toUpperCase() || "CUST";
    const code = `${base}-${lead.id.slice(0, 4).toUpperCase()}`;

    const [customer] = await tx
      .insert(schema.customers)
      .values({
        tenantId: ctx.tenantId,
        code,
        name: lead.name,
        isCompany: false,
        phone: lead.phone,
        billingEmail: lead.email,
        paymentTermsDays: 0,
      })
      .returning({ id: schema.customers.id });
    if (!customer) throw new Error("Failed to create customer");
    customerId = customer.id;
  }

  const [property] = await tx
    .insert(schema.properties)
    .values({
      tenantId: ctx.tenantId,
      customerId,
      name: input.propertyName,
      type: "other",
      addressLine: input.addressLine,
      area: lead.area,
      city: lead.city ?? "Dubai",
    })
    .returning({ id: schema.properties.id });
  if (!property) throw new Error("Failed to create property");

  const now = new Date();
  const { respondByAt, resolveByAt } = computeSlaDeadlines(input.priority, now);
  const reference = await nextJobReference(tx);

  const [job] = await tx
    .insert(schema.jobs)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId,
      propertyId: property.id,
      serviceSlug: lead.serviceSlug ?? "handyman",
      title: input.title,
      description: lead.message,
      status: "triaged",
      priority: input.priority,
      source: "web_quote",
      respondByAt,
      resolveByAt,
      createdById: ctx.userId ?? null,
    })
    .returning({ id: schema.jobs.id });
  if (!job) throw new Error("Failed to create job");

  await tx.insert(schema.jobEvents).values({
    tenantId: ctx.tenantId,
    jobId: job.id,
    fromStatus: null,
    toStatus: "triaged",
    note: `Converted from web enquiry ENQ-${lead.id.slice(0, 8).toUpperCase()}`,
    actorId: ctx.userId ?? null,
    actorKind: "user",
  });

  await tx
    .update(schema.leads)
    .set({ stage: "won", convertedCustomerId: customerId, nextFollowUpAt: null, updatedAt: now })
    .where(eq(schema.leads.id, input.leadId));

  return { jobId: job.id, reference, customerId, propertyId: property.id };
}

export async function setLeadStage(
  tx: TenantScopedTx,
  leadId: string,
  stage: LeadStage,
  lostReason?: string,
): Promise<void> {
  await tx
    .update(schema.leads)
    .set({
      stage,
      lostReason: stage === "lost" ? (lostReason ?? null) : null,
      nextFollowUpAt: stage === "lost" || stage === "won" ? null : undefined,
      updatedAt: new Date(),
    })
    .where(eq(schema.leads.id, leadId));
}
