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

/**
 * Who should be told about a new enquiry (`LEAD-2`, `LEAD-3`).
 *
 * Routed by role rather than by a configured address list, because an address
 * list goes stale the first time somebody leaves and nobody notices until an
 * enquiry emails a former employee.
 *
 * An emergency reaches the owner as well. That is the whole of `LEAD-3`: the
 * distinction between "somebody will pick this up" and "somebody must pick this
 * up now" has to exist in who is woken, not only in a flag on a row.
 */
export async function enquiryRecipients(
  tx: TenantScopedTx,
  isEmergency: boolean,
): Promise<readonly { userId: string; email: string; fullName: string }[]> {
  const roles: ("owner" | "operations_manager" | "dispatcher")[] = isEmergency
    ? ["owner", "operations_manager", "dispatcher"]
    : ["operations_manager", "dispatcher"];

  // Query builder rather than raw SQL, and the reason is specific: drizzle's
  // `sql` template expands a JavaScript array into separate placeholders, so
  // `= any(${roles})` becomes `= any(($1, $2))` — which Postgres rejects with
  // "op ANY/ALL (array) requires array on right side". Every lead would have
  // thrown. Interpolating the list into the string instead would work and would
  // be the first piece of string-built SQL in this codebase, which is not a
  // trade worth making. `inArray` binds it properly.
  return tx
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
        inArray(schema.memberships.role, roles),
        isNull(schema.users.deletedAt),
      ),
    )
    .orderBy(schema.users.fullName);
}

/**
 * Record a public enquiry as a lead, and tell somebody about it.
 *
 * ── WHY THE NOTIFICATION IS INSIDE THIS TRANSACTION ─────────────────────────
 *
 * `LEAD-2`, closing `PD-3`. Until now this function wrote a row and the caller
 * wrote a log line. The lead existed; nobody was told. An enquiry that arrives
 * on a Thursday at 21:00 and reaches no one is revenue that never existed, and
 * every answer-engine page on the public site exists to produce exactly these.
 *
 * Enqueued in the same transaction as the insert, which is the pattern already
 * used everywhere else here and is the reason it can be trusted: a notification
 * cannot promise an enquiry that rolled back, and an enquiry cannot be recorded
 * without one being queued. The two facts commit together or not at all.
 *
 * Delivery is a separate step — `/api/cron/dispatch` drains the queue — so a
 * provider outage delays the alert rather than losing the enquiry.
 */
export async function createLeadFromEnquiry(
  tenantId: string,
  enquiry: PublicEnquiry,
  hooks?: {
    /**
     * Runs inside the same transaction as the insert, before it commits.
     *
     * This exists to invert a dependency rather than to be clever.
     * `packages/notify` imports `packages/db`, so `db` importing `notify` to
     * send the alert would be a cycle. Handing the caller the open transaction
     * keeps both properties that matter: the notification is enqueued
     * atomically with the lead, AND it goes through notify's typed `enqueue`,
     * so a template payload that is missing a field is a compile error rather
     * than an email that says "Hello undefined".
     *
     * Throwing from here rolls the lead back, which is the correct direction:
     * an enquiry recorded with no alert is the exact failure being fixed.
     */
    onCreated?: (
      tx: TenantScopedTx,
      lead: { leadId: string; reference: string; isEmergency: boolean },
    ) => Promise<void>;
  },
): Promise<{ leadId: string; reference: string; recipients: number }> {
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

    const isEmergency = enquiry.urgency === "emergency";
    const recipients = await enquiryRecipients(tx, isEmergency);

    if (recipients.length === 0) {
      // Loud, and worth its own line. A deployment with no operations manager
      // and no dispatcher captures enquiries into a queue nobody is watching,
      // which looks identical to working correctly right up until somebody asks
      // why nothing was followed up.
      console.error(
        `[leads] ${reference} recorded but there is no operations manager or dispatcher to notify`,
      );
    }

    await hooks?.onCreated?.(tx, { leadId: row.id, reference, isEmergency });

    return { leadId: row.id, reference, recipients: recipients.length };
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
