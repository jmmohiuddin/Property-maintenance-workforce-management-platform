import { and, eq, desc, sql, isNull, inArray } from "drizzle-orm";
import { db, withTenant, type TenantScopedTx, type TenantContext } from "../index";
import * as schema from "../schema";
import { loadWorkingCalendar, resolveDispositionReason } from "./reference";
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

/**
 * Where a lead came from (`LEAD-4`, `DB-5`).
 *
 * Separated from the enquiry itself because the same shape has to serve the web
 * form, the 30-second manual create form for phone and walk-in enquiries
 * (`LEAD-1`) and whatever an aggregator integration eventually posts. A
 * structure that only the web form can fill is a funnel that only measures the
 * website.
 *
 * Every field is optional and stays null when unknown. Nothing here invents a
 * plausible value — an enquiry with no campaign recorded must not become an
 * enquiry attributed to the wrong campaign, because the whole reason these
 * columns exist is to decide where money goes next.
 */
export interface LeadAttribution {
  /** `LEAD-1`'s channel list. Defaults to `website` at the database. */
  readonly channel?: string | undefined;
  readonly utmSource?: string | undefined;
  readonly utmMedium?: string | undefined;
  readonly utmCampaign?: string | undefined;
  /** The page the enquiry was sent from, path and query. */
  readonly landingPage?: string | undefined;
  /** Where the visitor arrived from, when the browser tells us. */
  readonly referrer?: string | undefined;
  /** Which advertised number was dialled. Phone leads only. */
  readonly calledNumber?: string | undefined;
  /**
   * Anything unanticipated — `gclid`, user agent, an aggregator's own id.
   *
   * Kept alongside the columns rather than replaced by them. The columns are
   * what a report groups by; this is what stops the next advertising platform
   * from needing a migration before its leads can be recorded at all.
   */
  readonly extra?: Record<string, string> | undefined;
}

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
  readonly attribution?: LeadAttribution | undefined;
}

/** Trim, collapse empties to null, and cut to the column's width. */
function attributionValue(value: string | undefined, maxLength: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  // Truncated rather than rejected. A referrer URL longer than the column is a
  // real referrer, and losing the enquiry over its query string would be a far
  // worse outcome than losing the tail of the string.
  return trimmed.slice(0, maxLength);
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
        // LEAD-4. Ten service pages, ten area pages and a pile of structured
        // data exist to produce exactly this row, and until these columns were
        // written nothing recorded which of them did — so the investment could
        // only be defended on faith and could only be cut on faith.
        channel: enquiry.attribution?.channel ?? "website",
        utmSource: attributionValue(enquiry.attribution?.utmSource, 120),
        utmMedium: attributionValue(enquiry.attribution?.utmMedium, 120),
        utmCampaign: attributionValue(enquiry.attribution?.utmCampaign, 160),
        landingPage: attributionValue(enquiry.attribution?.landingPage, 512),
        referrer: attributionValue(enquiry.attribution?.referrer, 512),
        calledNumber: attributionValue(enquiry.attribution?.calledNumber, 32),
        attribution: enquiry.attribution?.extra ?? {},
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
  /** `LEAD-4`. Selected on the list, not only on the detail: attribution that
   *  has to be clicked into is attribution nobody reads. */
  readonly channel: string;
  readonly utmSource: string | null;
  readonly utmMedium: string | null;
  readonly utmCampaign: string | null;
  readonly landingPage: string | null;
  readonly referrer: string | null;
  readonly calledNumber: string | null;
  readonly dispositionReasonId: string | null;
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
      channel: schema.leads.channel,
      utmSource: schema.leads.utmSource,
      utmMedium: schema.leads.utmMedium,
      utmCampaign: schema.leads.utmCampaign,
      landingPage: schema.leads.landingPage,
      referrer: schema.leads.referrer,
      calledNumber: schema.leads.calledNumber,
      dispositionReasonId: schema.leads.dispositionReasonId,
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
      channel: schema.leads.channel,
      utmSource: schema.leads.utmSource,
      utmMedium: schema.leads.utmMedium,
      utmCampaign: schema.leads.utmCampaign,
      landingPage: schema.leads.landingPage,
      referrer: schema.leads.referrer,
      calledNumber: schema.leads.calledNumber,
      dispositionReasonId: schema.leads.dispositionReasonId,
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
  // ADM-10. The stored calendar, not DEFAULT_CALENDAR.
  //
  // computeSlaDeadlines takes a calendar as its fourth argument and falls back
  // to the default when none is given — and the default ships with an EMPTY
  // holiday list, deliberately, because a hardcoded one goes stale in January.
  // Taking that fallback silently here would mean an administrator could enter
  // every UAE public holiday and every deadline computed afterwards would still
  // ignore them. The seam existed; nothing was using it.
  const calendar = await loadWorkingCalendar(tx);
  const { respondByAt, resolveByAt } = computeSlaDeadlines(input.priority, now, undefined, calendar);
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

/**
 * Move a lead through the funnel (`LEAD-6`).
 *
 * ── WHY THIS FUNCTION REFUSES THINGS ────────────────────────────────────────
 *
 * `lost` and `dormant` require a reason from the controlled list, and free text
 * is not an acceptable substitute for it. That is the requirement as written,
 * and the reason it is written that way is that the reason field is the only
 * output the question was asked for: "too expensive", "Price", "cost",
 * "budget" and "too $$" are one category typed five ways, and the report they
 * were collected for cannot group them back together afterwards.
 *
 * So the check happens here rather than in the form. A form check is a check
 * the next form forgets — the field app, an importer and a bulk action are all
 * coming — and `leads_disposition_required` in the database is the backstop
 * behind this, not the message anybody should ever have to read.
 *
 * `note` is kept and is genuinely optional: the code says which category, the
 * note says what actually happened. What it cannot do is replace the code.
 */
export async function setLeadStage(
  tx: TenantScopedTx,
  leadId: string,
  stage: LeadStage,
  options?: { dispositionReasonId?: string | undefined; note?: string | undefined },
): Promise<void> {
  const needsReason = stage === "lost" || stage === "dormant";

  if (needsReason) {
    const reasonId = options?.dispositionReasonId?.trim();
    if (!reasonId) {
      throw new UserFacingError(
        stage === "lost"
          ? "Choose why this lead was lost. The reason is what makes the pipeline worth reporting on."
          : "Choose why this lead is dormant, so it can be found again when that reason expires.",
      );
    }

    // Resolved rather than trusted. The id arrives from a form post, so it can
    // name a retired reason, a reason belonging to the other stage, or — if RLS
    // were ever misconfigured — nothing at all in this tenant.
    const reason = await resolveDispositionReason(tx, reasonId, stage);
    if (!reason) {
      throw new UserFacingError(
        "That reason is not one this lead can be closed with. Pick one from the list.",
      );
    }

    await tx
      .update(schema.leads)
      .set({
        stage,
        dispositionReasonId: reason.id,
        lostReason: options?.note?.trim() || null,
        // No follow-up on a lost lead. A dormant one keeps whatever it had:
        // dormant means "not now", and a lead nobody ever looks at again is
        // lost with extra steps.
        nextFollowUpAt: stage === "lost" ? null : undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.leads.id, leadId));
    return;
  }

  await tx
    .update(schema.leads)
    .set({
      stage,
      // Reopening clears the closure. A lead back in `contacted` carrying last
      // month's lost reason reads as lost to every person and every report that
      // sees it.
      dispositionReasonId: null,
      lostReason: null,
      nextFollowUpAt: stage === "won" ? null : undefined,
      updatedAt: new Date(),
    })
    .where(eq(schema.leads.id, leadId));
}

/**
 * Which sources actually produced leads (`LEAD-4`).
 *
 * The reason `DB-5` exists, made visible. Ten service pages, ten area pages,
 * JSON-LD on all of them and an llms.txt are an investment that can only be
 * defended or cut on evidence, and this is the smallest query that produces
 * any: how many enquiries each channel and each landing page brought in over a
 * window, and how many of them were won.
 *
 * Won-rate rather than volume alone, because they disagree often enough to
 * matter. A channel producing forty enquiries and one job is not the channel to
 * spend more on, and a report showing only the forty says it is.
 */
export interface AttributionRow {
  readonly label: string;
  readonly leads: number;
  readonly won: number;
}

export async function leadAttributionSummary(
  tx: TenantScopedTx,
  options?: { days?: number },
): Promise<{
  readonly byChannel: readonly AttributionRow[];
  readonly byLandingPage: readonly AttributionRow[];
  readonly byCampaign: readonly AttributionRow[];
  /** Leads in the window with no source recorded at all. The honest denominator. */
  readonly unattributed: number;
  readonly days: number;
}> {
  const days = options?.days ?? 90;

  const query = async (dimension: "channel" | "landing_page" | "utm_campaign") => {
    // The dimension is chosen from a closed set here rather than interpolated,
    // because a column name cannot be a bind parameter and the alternative is
    // string-built SQL. Three explicit branches are duller and cannot be turned
    // into an injection by a future caller that passes a query-string value.
    const column =
      dimension === "channel"
        ? sql`channel`
        : dimension === "landing_page"
          ? sql`landing_page`
          : sql`utm_campaign`;

    const rows = (await tx.execute<{ label: string; leads: string; won: string }>(sql`
      select ${column}::text as label,
             count(*) as leads,
             count(*) filter (where stage = 'won') as won
        from leads
       where deleted_at is null
         and created_at >= now() - make_interval(days => ${days})
         and ${column} is not null
       group by 1
       order by 2 desc, 1
       limit 25
    `)) as unknown as { label: string; leads: string; won: string }[];

    return rows.map((r) => ({ label: r.label, leads: Number(r.leads), won: Number(r.won) }));
  };

  const gapQuery = async (): Promise<number> => {
    const rows = (await tx.execute<{ unattributed: string }>(sql`
      select count(*) as unattributed
        from leads
       where deleted_at is null
         and created_at >= now() - make_interval(days => ${days})
         and landing_page is null
         and referrer is null
         and utm_source is null
         and called_number is null
    `)) as unknown as { unattributed: string }[];
    return Number(rows[0]?.unattributed ?? 0);
  };

  const [byChannel, byLandingPage, byCampaign, unattributed] = await Promise.all([
    query("channel"),
    query("landing_page"),
    query("utm_campaign"),
    gapQuery(),
  ]);

  return { byChannel, byLandingPage, byCampaign, unattributed, days };
}
