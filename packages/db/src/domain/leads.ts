import { and, eq, desc, sql, isNull, inArray, type SQL } from "drizzle-orm";
import { db, withTenant, type TenantScopedTx, type TenantContext } from "../index";
import * as schema from "../schema";
import { loadWorkingCalendar, resolveDispositionReason } from "./reference";
import {
  computeSlaDeadlines,
  emailKey,
  localPhoneKey,
  FOLLOW_UP_DAYS_FOR_OUTCOME,
  OPEN_LEAD_STAGES,
  type CommunicationChannel,
  type CommunicationDirection,
  type CommunicationOutcome,
  type JobPriority,
  type LeadStage,
  UserFacingError,
} from "@meridian/core";
import { nextJobReference } from "./jobs";
import { OPEN_JOB_STATUSES } from "./customers";
import { rowDate, requiredRowDate } from "./_rows";

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
): Promise<{
  leadId: string;
  reference: string;
  recipients: number;
  /**
   * `LEAD-5`. What this enquiry looks like it already is.
   *
   * Returned rather than acted on beyond the auto-link, because the caller here
   * is the public quote form and the visitor must not be told "we already have
   * you on file" — that is an account-existence oracle, and it is confirmable
   * for any phone number somebody cares to try. The operator sees the matches
   * on the lead screen; the visitor sees the same acknowledgement either way.
   */
  duplicates: DuplicateReport;
}> {
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

    // LEAD-5, closing PD-11. Run after the insert rather than before it, and
    // deliberately: the enquiry is recorded whatever the matcher decides. A
    // check that runs first and refuses is a form that silently drops the
    // second call from a customer whose first one went unanswered, which is
    // both the worst enquiry to lose and the one most likely to be a duplicate.
    const duplicates = await findDuplicateMatches(tx, {
      phone: enquiry.phone,
      email: enquiry.email,
      excludeLeadId: row.id,
    });

    // The strict tier's auto-link (phone AND email, exactly one match). It
    // writes two pointers and nothing else: no field is copied, no row is
    // merged, no stage is changed. An operator clearing a wrong link clears a
    // column; an operator undoing a wrong merge restores a backup.
    if (duplicates.autoLinkCustomerId || duplicates.autoLinkLeadId) {
      await tx
        .update(schema.leads)
        .set({
          matchedCustomerId: duplicates.autoLinkCustomerId,
          duplicateOfLeadId: duplicates.autoLinkLeadId,
        })
        .where(eq(schema.leads.id, row.id));
    }

    await hooks?.onCreated?.(tx, { leadId: row.id, reference, isEmergency });

    return { leadId: row.id, reference, recipients: recipients.length, duplicates };
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
  /** `LEAD-5`. Set by the strict matcher or by the link action. */
  readonly matchedCustomerId: string | null;
  readonly duplicateOfLeadId: string | null;
  /** `LEAD-9`. The nurture clock, and what `LEAD-7`'s retention clock reads. */
  readonly lastInteractionAt: Date;
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
      matchedCustomerId: schema.leads.matchedCustomerId,
      duplicateOfLeadId: schema.leads.duplicateOfLeadId,
      lastInteractionAt: schema.leads.lastInteractionAt,
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
      matchedCustomerId: schema.leads.matchedCustomerId,
      duplicateOfLeadId: schema.leads.duplicateOfLeadId,
      lastInteractionAt: schema.leads.lastInteractionAt,
    })
    .from(schema.leads)
    .where(eq(schema.leads.id, leadId))
    .limit(1);

  const row = rows[0];
  return row ? { ...row, stage: row.stage as LeadStage } : null;
}

/**
 * The customers a lead might already belong to, at the moment of conversion
 * (`LEAD-5`).
 *
 * `findDuplicateMatches` answers "who does this enquiry look like"; this
 * narrows that to the only half conversion can act on — customers — and folds
 * in the pointer already on the lead, which the matcher would miss if the
 * customer's phone or email has been edited since the link was made.
 *
 * Recomputed rather than read from `matched_customer_id` alone, and for the
 * same reason the lead screen recomputes: a customer created last week from a
 * different enquiry is a duplicate this lead did not have when it arrived.
 */
export interface ConvertCandidate {
  readonly customerId: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  /** Phone AND email both matched this customer. */
  readonly isStrict: boolean;
  /** The pointer is already on the lead — auto-linked at creation, or linked by hand. */
  readonly isLinked: boolean;
}

/** True for a candidate that conversion refuses to decide about on its own. */
function needsDecision(candidate: ConvertCandidate): boolean {
  return candidate.isStrict || candidate.isLinked;
}

export async function convertCustomerCandidates(
  tx: TenantScopedTx,
  leadId: string,
): Promise<readonly ConvertCandidate[]> {
  const lead = await getLead(tx, leadId);
  if (!lead) return [];

  const report = await findDuplicateMatches(tx, {
    phone: lead.phone,
    email: lead.email,
    excludeLeadId: lead.id,
  });

  const candidates: ConvertCandidate[] = report.matches
    .filter((m) => m.kind === "customer")
    .map((m) => ({
      customerId: m.id,
      name: m.name,
      phone: m.phone,
      email: m.email,
      isStrict: m.isStrict,
      isLinked: m.id === lead.matchedCustomerId,
    }));

  // The linked customer, when the matcher no longer finds it. Somebody changed
  // that account's phone number after the link was made; the link is still a
  // decision a person took about this lead and dropping it here would put the
  // duplicate back.
  if (lead.matchedCustomerId && !candidates.some((c) => c.isLinked)) {
    const [row] = await tx
      .select({
        id: schema.customers.id,
        name: schema.customers.name,
        phone: schema.customers.phone,
        billingEmail: schema.customers.billingEmail,
      })
      .from(schema.customers)
      .where(eq(schema.customers.id, lead.matchedCustomerId))
      .limit(1);

    if (row) {
      candidates.unshift({
        customerId: row.id,
        name: row.name,
        phone: row.phone,
        email: row.billingEmail,
        isStrict: false,
        isLinked: true,
      });
    }
  }

  // Strict and linked first: the ones conversion will refuse to guess about are
  // the ones worth reading.
  return [...candidates].sort((a, b) => Number(needsDecision(b)) - Number(needsDecision(a)));
}

/**
 * Convert a qualified lead into a customer, a property and a job.
 *
 * One transaction. A half-converted lead - a customer with no property, or a
 * property with no job - is worse than an unconverted one, because it looks
 * like real data to every report that follows.
 *
 * ── WHY THIS REFUSES RATHER THAN REUSING (`LEAD-5`) ────────────────────────
 *
 * The duplicate matcher used to run only on create. So a lead the strict tier
 * had already tied to an existing customer — pointer written, badge on the
 * screen, everything working — produced a second customer for the same person
 * the moment somebody pressed Convert. The check existed and the one action
 * that creates a customer never asked it.
 *
 * Running it here raises the question of what to do with a hit, and the two
 * obvious answers are both wrong in the same way:
 *
 *  * **Silently create** is the bug as it stands: two accounts for one person,
 *    their history split across both, and an ageing report that agrees with
 *    neither.
 *  * **Silently reuse** is not the safe opposite of it. This call attaches a
 *    property, a job and everything invoiced against it to an account, and a
 *    dispatcher who did not choose that account has no reason to check it. A
 *    wrong link at creation is undone by clearing a column; work filed under
 *    the wrong customer is undone by moving jobs and re-issuing invoices.
 *
 * So a strict or already-linked match makes the decision a person's, and this
 * refuses until it has one — `customerId` to attach to that account, or
 * `createNewCustomer` to say the match was seen and rejected. The refusal names
 * the account, which is the only way the outcome reaches the screen either way.
 *
 * A loose match — phone OR email — never reaches here. It is a suggestion the
 * convert form shows and the operator may ignore, because being wrong about a
 * shared switchboard number costs somebody dismissing a suggestion, and being
 * unable to convert costs them the job.
 */
export async function convertLeadToJob(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    leadId: string;
    /** Reuse an existing customer, or create one from the lead's details. */
    customerId?: string | undefined;
    /**
     * Create a new customer even though this lead matches one.
     *
     * The operator's acknowledgement that the match was put in front of them
     * and rejected. Without it a strict or linked match refuses.
     */
    createNewCustomer?: boolean | undefined;
    propertyName: string;
    addressLine: string;
    priority: JobPriority;
    title: string;
  },
): Promise<{
  jobId: string;
  reference: string;
  customerId: string;
  /** Named so the caller can say on screen which account the work went to. */
  customerName: string;
  /** False when an existing customer was reused. */
  customerCreated: boolean;
  propertyId: string;
}> {
  const lead = await getLead(tx, input.leadId);
  if (!lead) throw new Error("Lead not found in this tenant");
  if (lead.convertedCustomerId) throw new UserFacingError("This lead has already been converted");

  let customerId = input.customerId;
  let customerName: string;
  let customerCreated = false;

  if (customerId) {
    // Resolved, not trusted. Under RLS an id from another tenant selects
    // nothing here, so this is the cross-tenant check as well as the lookup
    // that gets the name back onto the screen.
    const [chosen] = await tx
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.customers)
      .where(eq(schema.customers.id, customerId))
      .limit(1);
    if (!chosen) throw new UserFacingError("That customer is not one this lead can be attached to.");
    customerName = chosen.name;
  } else {
    const candidates = await convertCustomerCandidates(tx, input.leadId);
    const blocking = candidates.filter(needsDecision);

    if (blocking.length > 0 && !input.createNewCustomer) {
      const names = blocking.map((c) => c.name).join(", ");
      throw new UserFacingError(
        `This enquiry matches an existing customer: ${names}. ` +
          `Choose whether to attach the job to that account or create a new one — ` +
          `converting cannot decide that for you.`,
      );
    }

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
      .returning({ id: schema.customers.id, name: schema.customers.name });
    if (!customer) throw new Error("Failed to create customer");
    customerId = customer.id;
    customerName = customer.name;
    customerCreated = true;
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
    // Which account this landed on, on the job's own timeline. The dispatcher
    // sees it at the moment of the decision; this is what the next person to
    // open the job sees, and it is the difference between an account that was
    // chosen and one that was assumed.
    note:
      `Converted from web enquiry ENQ-${lead.id.slice(0, 8).toUpperCase()}` +
      (customerCreated ? "" : ` · attached to existing customer ${customerName}`),
    actorId: ctx.userId ?? null,
    actorKind: "user",
  });

  await tx
    .update(schema.leads)
    .set({ stage: "won", convertedCustomerId: customerId, nextFollowUpAt: null, updatedAt: now })
    .where(eq(schema.leads.id, input.leadId));

  return {
    jobId: job.id,
    reference,
    customerId,
    customerName,
    customerCreated,
    propertyId: property.id,
  };
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

// ═══════════════════════════════════════════════════════════════════════════
// LEAD-5 · LEAD-8 · LEAD-9 — duplicates, search, and the communications log.
// ═══════════════════════════════════════════════════════════════════════════

// ── LEAD-8. Keyset pagination ───────────────────────────────────────────────

/**
 * An opaque page cursor.
 *
 * ── WHY NOT OFFSET ─────────────────────────────────────────────────────────
 *
 * `TD-10` is "unbounded lists", and the reflex fix — `LIMIT 50 OFFSET 500` —
 * fixes the symptom and keeps the bug. Two reasons, and the second is the one
 * that actually costs somebody something:
 *
 *  1. `OFFSET 500` makes Postgres read and discard five hundred rows before it
 *     returns anything, so page 11 costs eleven times page 1 and the list gets
 *     slower the further anybody looks into it.
 *  2. A lead recorded while somebody is paging shifts every subsequent row by
 *     one. The record that was at the top of page 2 moves to the bottom of page
 *     1, which the reader has already scrolled past — so it is never seen. A
 *     sales queue that silently skips leads is worse than one that is slow.
 *
 * The cursor is `(created_at, id)`. `id` is in it because `created_at` is not
 * unique: two leads recorded in the same millisecond make the boundary
 * ambiguous and one of them is dropped or repeated forever.
 *
 * Base64url so it survives a query string without escaping, and opaque so that
 * a caller cannot come to depend on its shape — this is a position in a result
 * set, not an API.
 */
export interface Cursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.createdAt.toISOString()}|${cursor.id}`, "utf8").toString("base64url");
}

/**
 * Decode a cursor, or null.
 *
 * Null rather than throwing, for every malformed input. This value arrives from
 * a query string, so it is attacker-controlled and much more often simply
 * stale — a bookmarked URL, a back button, a link somebody pasted into chat.
 * The right behaviour for all of those is the first page, not a 500.
 */
export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    // Shape-checked, not merely non-empty: this id goes into a uuid comparison
    // and a malformed one is an error from Postgres rather than an empty page.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export interface Page<T> {
  readonly rows: readonly T[];
  /** Null on the last page. Present means there is more, definitively. */
  readonly nextCursor: string | null;
}

/**
 * The `LIMIT n + 1` trick, in one place.
 *
 * Asking for one more row than the page needs is how "is there a next page"
 * becomes a fact rather than a guess. The alternative — a `count(*)` alongside
 * every page — doubles the query cost to answer a question the extra row
 * answers for free, and on a filtered search that count is the expensive half.
 */
function toPage<T extends { id: string; createdAt: Date }>(rows: T[], limit: number): Page<T> {
  if (rows.length <= limit) return { rows, nextCursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null };
}

/** The largest page anybody may ask for. A limit a caller can set is not a limit. */
const MAX_PAGE = 100;

/**
 * Build the text-search predicate (`LEAD-8`).
 *
 * ── ONE BOX, FOUR KINDS OF MATCH ───────────────────────────────────────────
 *
 * A person searching a lead list types one of four things and does not think of
 * them as different: a name, a phone number, an email address, or a reference.
 * Asking them which is a form; guessing from the shape is a search box.
 *
 * Phone goes through `app_phone_key` on both sides, the same comparison the
 * duplicate matcher uses — so searching "050 123 4567" finds the lead stored as
 * "+971501234567", and "04 555 0100" finds "+971 4 555 0100". Matching the raw
 * strings finds neither.
 *
 * The name match is `ILIKE '%…%'`, which cannot use a btree index at all; that
 * is why 0016 puts a trigram GIN index on `name`, and why this stays a plain
 * ILIKE rather than becoming `to_tsvector` — full-text search stems words and
 * would stop "Rash" matching "Rashid", which is the single most common way
 * anybody uses this box.
 */
function searchPredicate(
  q: string | undefined,
  columns: { name: string; phone: string; email: string },
): SQL | null {
  const term = q?.trim();
  if (!term) return null;

  const like = `%${term.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const phoneKey = localPhoneKey(term);
  const email = emailKey(term);

  // Every branch is a bound parameter. The column names come from the closed
  // set the two callers pass, never from anything a user typed.
  const clauses: SQL[] = [
    sql`${sql.raw(columns.name)} ilike ${like}`,
    sql`${sql.raw(columns.email)} is not null and lower(${sql.raw(columns.email)}) = ${email ?? ""}`,
  ];

  if (phoneKey) {
    clauses.push(sql`app_phone_key(${sql.raw(columns.phone)}) = ${phoneKey}`);
  }

  return sql`(${sql.join(clauses, sql` or `)})`;
}

export interface LeadSearchRow extends LeadRow {
  /** Resolved from `lead_disposition_reasons` so the list can show why. */
  readonly dispositionLabel: string | null;
}

/**
 * Search and page the lead list (`LEAD-8`, closing `TD-10` and `MB-016`).
 *
 * Server-side and indexed. The previous `listLeads` took a `limit` defaulting
 * to 100 and had no second page at all, which is not "the first hundred leads",
 * it is "every lead after the hundredth is invisible" — and nothing on the
 * screen said so.
 */
export async function searchLeads(
  tx: TenantScopedTx,
  options?: {
    q?: string | undefined;
    stages?: readonly LeadStage[] | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    /** Only leads whose follow-up is due at or before this moment. */
    followUpDueBy?: Date | undefined;
  },
): Promise<Page<LeadSearchRow>> {
  const limit = Math.min(Math.max(options?.limit ?? 25, 1), MAX_PAGE);
  const cursor = decodeCursor(options?.cursor);

  const stages = options?.stages ? [...options.stages] : null;
  const stageFilter =
    stages && stages.length > 0
      ? sql`and l.stage::text in (${sql.join(stages.map((s) => sql`${s}`), sql`, `)})`
      : sql``;

  const search = searchPredicate(options?.q, {
    name: "l.name",
    phone: "l.phone",
    email: "l.email",
  });

  // Row-wise comparison, not `created_at < x OR (created_at = x AND id < y)`.
  // Postgres can drive `(created_at, id) < (…, …)` straight off the
  // `leads_keyset_idx` composite; the OR form usually cannot use it.
  const keyset = cursor
    ? sql`and (l.created_at, l.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    : sql``;

  const followUp = options?.followUpDueBy
    ? sql`and l.next_follow_up_at is not null and l.next_follow_up_at <= ${options.followUpDueBy.toISOString()}::timestamptz`
    : sql``;

  const rows = (await tx.execute<Record<string, never>>(sql`
    select l.id, l.name, l.phone, l.email, l.service_slug, l.city, l.area,
           l.stage::text as stage, l.message, l.created_at, l.next_follow_up_at,
           l.converted_customer_id, l.channel, l.utm_source, l.utm_medium,
           l.utm_campaign, l.landing_page, l.referrer, l.called_number,
           l.disposition_reason_id, l.last_interaction_at, l.matched_customer_id,
           l.duplicate_of_lead_id,
           r.label as disposition_label
      from leads l
      left join lead_disposition_reasons r on r.id = l.disposition_reason_id
     where l.deleted_at is null
       ${stageFilter}
       ${search ? sql`and ${search}` : sql``}
       ${keyset}
       ${followUp}
     order by l.created_at desc, l.id desc
     limit ${limit + 1}
  `)) as unknown as {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    service_slug: string | null;
    city: string | null;
    area: string | null;
    stage: string;
    message: string | null;
    created_at: string;
    next_follow_up_at: string | null;
    converted_customer_id: string | null;
    channel: string;
    utm_source: string | null;
    utm_medium: string | null;
    utm_campaign: string | null;
    landing_page: string | null;
    referrer: string | null;
    called_number: string | null;
    disposition_reason_id: string | null;
    last_interaction_at: string;
    matched_customer_id: string | null;
    duplicate_of_lead_id: string | null;
    disposition_label: string | null;
  }[];

  return toPage(
    rows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      serviceSlug: r.service_slug,
      city: r.city,
      area: r.area,
      stage: r.stage as LeadStage,
      message: r.message,
      createdAt: requiredRowDate(r.created_at),
      nextFollowUpAt: rowDate(r.next_follow_up_at),
      convertedCustomerId: r.converted_customer_id,
      channel: r.channel,
      utmSource: r.utm_source,
      utmMedium: r.utm_medium,
      utmCampaign: r.utm_campaign,
      landingPage: r.landing_page,
      referrer: r.referrer,
      calledNumber: r.called_number,
      dispositionReasonId: r.disposition_reason_id,
      lastInteractionAt: requiredRowDate(r.last_interaction_at),
      matchedCustomerId: r.matched_customer_id,
      duplicateOfLeadId: r.duplicate_of_lead_id,
      dispositionLabel: r.disposition_label,
    })),
    limit,
  );
}

export interface CustomerSearchRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly billingEmail: string | null;
  readonly isActive: boolean;
  readonly industry: string | null;
  readonly currency: string;
  readonly paymentTermsDays: number;
  readonly accountManagerName: string | null;
  readonly propertyCount: number;
  readonly openJobs: number;
  /** Minor units. Issued and part-paid invoices, never written-off ones. */
  readonly outstandingMinor: number;
  /** The part of that balance past its due date. */
  readonly overdueMinor: number;
}

/**
 * Search and page the customer list (`LEAD-8`, closing `TD-10` on this screen).
 *
 * Here rather than in `domain/customers.ts` because the cursor, the page
 * boundary and the search predicate are private to this file and shared with
 * `searchLeads` above. That sharing is the point rather than an accident of
 * layout: the same box finds a phone number the same way on both screens, which
 * is the property a user actually notices, and one predicate cannot drift from
 * itself.
 *
 * ── WHY THE MONEY IS IN THIS QUERY ─────────────────────────────────────────
 *
 * The customer screen exists to put work in flight and money outstanding on the
 * same row, and `listCustomers` produced both — by reading every customer, then
 * every open job, then every unpaid invoice, and joining them in JavaScript.
 * That is the unbounded read `TD-10` names, and paging it in the application
 * would page the display while still fetching everything.
 *
 * So the balances are correlated subqueries against `invoices` and `jobs`,
 * evaluated for the twenty-five rows this page returns and no others. The
 * arithmetic stays in integer minor units — `round(x * 100)` on a
 * `numeric(14,2)` is exact, and this number is read next to the ledger.
 */
export async function searchCustomers(
  tx: TenantScopedTx,
  options?: {
    q?: string | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
    /** Inactive accounts are hidden by default, as the list has always done. */
    includeInactive?: boolean | undefined;
    now?: Date | undefined;
  },
): Promise<Page<CustomerSearchRow>> {
  const limit = Math.min(Math.max(options?.limit ?? 25, 1), MAX_PAGE);
  const cursor = decodeCursor(options?.cursor);
  const now = (options?.now ?? new Date()).toISOString();

  const search = searchPredicate(options?.q, {
    name: "c.name",
    phone: "c.phone",
    email: "c.billing_email",
  });

  const keyset = cursor
    ? sql`and (c.created_at, c.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`
    : sql``;

  const activeOnly = options?.includeInactive ? sql`` : sql`and c.is_active`;

  const rows = (await tx.execute<Record<string, never>>(sql`
    select c.id, c.created_at, c.code, c.name, c.phone, c.billing_email, c.is_active,
           c.industry, c.currency, c.payment_terms_days,
           u.full_name as account_manager_name,
           (select count(*) from properties p
             where p.customer_id = c.id and p.deleted_at is null) as property_count,
           (select count(*) from jobs j
             where j.customer_id = c.id and j.deleted_at is null
               and j.status::text in (${sql.join(OPEN_JOB_STATUSES.map((s) => sql`${s}`), sql`, `)})) as open_jobs,
           -- greatest(..., 0) per invoice, not on the sum: an overpaid invoice
           -- is not a credit against the next one here, and letting it net off
           -- would understate a balance that accounts is chasing.
           coalesce((select sum(round(greatest(i.total - i.amount_paid, 0) * 100))
                       from invoices i
                      where i.customer_id = c.id and i.deleted_at is null
                        and i.status::text in ('issued', 'part_paid', 'overdue')), 0) as outstanding_minor,
           coalesce((select sum(round(greatest(i.total - i.amount_paid, 0) * 100))
                       from invoices i
                      where i.customer_id = c.id and i.deleted_at is null
                        and i.status::text in ('issued', 'part_paid', 'overdue')
                        and i.due_on is not null and i.due_on < ${now}::timestamptz), 0) as overdue_minor
      from customers c
      left join users u on u.id = c.account_manager_id
     where c.deleted_at is null
       ${activeOnly}
       ${search ? sql`and ${search}` : sql``}
       ${keyset}
     order by c.created_at desc, c.id desc
     limit ${limit + 1}
  `)) as unknown as {
    id: string;
    created_at: string;
    code: string;
    name: string;
    phone: string | null;
    billing_email: string | null;
    is_active: boolean;
    industry: string | null;
    currency: string;
    payment_terms_days: number;
    account_manager_name: string | null;
    property_count: string;
    open_jobs: string;
    outstanding_minor: string;
    overdue_minor: string;
  }[];

  return toPage(
    rows.map((r) => ({
      id: r.id,
      createdAt: requiredRowDate(r.created_at),
      code: r.code,
      name: r.name,
      phone: r.phone,
      billingEmail: r.billing_email,
      isActive: r.is_active,
      industry: r.industry,
      currency: r.currency,
      paymentTermsDays: Number(r.payment_terms_days),
      accountManagerName: r.account_manager_name,
      propertyCount: Number(r.property_count),
      openJobs: Number(r.open_jobs),
      outstandingMinor: Number(r.outstanding_minor),
      overdueMinor: Number(r.overdue_minor),
    })),
    limit,
  );
}

// ── LEAD-5. Duplicate detection ─────────────────────────────────────────────

export type DuplicateKind = "lead" | "customer";

export interface DuplicateMatch {
  readonly kind: DuplicateKind;
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  /** True when phone AND email both matched — the strict tier. */
  readonly isStrict: boolean;
  /** For a lead: which stage it is in. For a customer: null. */
  readonly stage: LeadStage | null;
  readonly lastSeenAt: Date;
}

export interface DuplicateReport {
  readonly matches: readonly DuplicateMatch[];
  /** The strict customer match, if there is exactly one. Safe to auto-link. */
  readonly autoLinkCustomerId: string | null;
  /** The strict lead match, if there is exactly one. Safe to auto-link. */
  readonly autoLinkLeadId: string | null;
}

/**
 * Find the leads and customers this enquiry might already be (`LEAD-5`,
 * closing `PD-11` and `MB-015`).
 *
 * ── THE TWO TIERS, AND WHY THEY ARE DIFFERENT ACTIONS ──────────────────────
 *
 * The requirement asks for a loose matcher that *suggests* and a strict matcher
 * that may *auto-link*, and the distinction is not fussiness — it is the
 * difference between two acceptable failures.
 *
 *  * **Loose** is phone OR email. It is right often and wrong sometimes: an
 *    office switchboard, a facilities manager who gives their own mobile for
 *    three buildings, a family sharing an address. Being wrong costs somebody
 *    dismissing a suggestion, so it suggests.
 *  * **Strict** is phone AND email, both matching the same record. Being wrong
 *    there costs two customers merged into one, and the amount of manual work
 *    to unpick that is why it links rather than merges: `matched_customer_id`
 *    is a pointer that can be cleared, not a write into the other record.
 *
 * Auto-link is refused when strict matches more than one record. Two records
 * both carrying the same phone and the same email is itself a duplicate that
 * somebody has to look at, and picking one arbitrarily would hide it.
 *
 * ── WHY THE PHONE COMPARISON IS NOT `=` ────────────────────────────────────
 *
 * "+971 50 123 4567", "050 123 4567" and "00971501234567" are one number
 * written three ways, and every one of them appears in a real database. Both
 * sides go through `app_phone_key`, which reduces a number to its national
 * significant form — country code and trunk zero removed — and which the
 * functional index in 0016 is built on, so this is an index lookup and not a
 * scan. Note that it is not "the last nine digits": that works for mobiles and
 * silently fails for the eight-digit landline an owners association answers on.
 */
export async function findDuplicateMatches(
  tx: TenantScopedTx,
  input: {
    phone?: string | null | undefined;
    email?: string | null | undefined;
    /** The lead being checked, so it does not match itself on convert. */
    excludeLeadId?: string | undefined;
  },
): Promise<DuplicateReport> {
  const phoneKey = localPhoneKey(input.phone);
  const email = emailKey(input.email);

  // Nothing to match on is not an error and not an empty result to be
  // interpreted: a walk-in with a name and no contact details genuinely has no
  // duplicate signal, and reporting "no duplicates" for it would be a claim
  // this function cannot make.
  if (!phoneKey && !email) return { matches: [], autoLinkCustomerId: null, autoLinkLeadId: null };

  const exclude = input.excludeLeadId ?? null;

  const rows = (await tx.execute<{
    kind: string;
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    phone_hit: boolean;
    email_hit: boolean;
    stage: string | null;
    last_seen_at: string;
  }>(sql`
      select 'lead'::text as kind,
             l.id, l.name, l.phone, l.email,
             (app_phone_key(l.phone) is not null and app_phone_key(l.phone) = ${phoneKey}) as phone_hit,
             (l.email is not null and lower(l.email) = ${email}) as email_hit,
             l.stage::text as stage,
             greatest(l.created_at, l.last_interaction_at) as last_seen_at
        from leads l
       where l.deleted_at is null
         and (${exclude}::uuid is null or l.id <> ${exclude}::uuid)
         and (
           (app_phone_key(l.phone) is not null and app_phone_key(l.phone) = ${phoneKey})
           or (l.email is not null and lower(l.email) = ${email})
         )

       union all

      -- Customers matched on the account's own phone and billing email, and
      -- through their contacts. A building manager's mobile is on the contact
      -- row far more often than on the customer row, so checking only the
      -- customer record finds the enquiry is new when it is the third one from
      -- the same person this year.
      select 'customer',
             cu.id, cu.name, cu.phone, cu.billing_email,
             bool_or(app_phone_key(coalesce(ct.phone, cu.phone)) = ${phoneKey}),
             bool_or(lower(coalesce(ct.email, cu.billing_email)) = ${email}),
             null,
             cu.created_at
        from customers cu
        left join customer_contacts ct
               on ct.customer_id = cu.id and ct.deleted_at is null
       where cu.deleted_at is null
         and (
           app_phone_key(cu.phone) = ${phoneKey}
           or lower(cu.billing_email) = ${email}
           or app_phone_key(ct.phone) = ${phoneKey}
           or lower(ct.email) = ${email}
         )
       group by cu.id, cu.name, cu.phone, cu.billing_email, cu.created_at

       order by last_seen_at desc
       limit 20
  `)) as unknown as {
    kind: string;
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    phone_hit: boolean;
    email_hit: boolean;
    stage: string | null;
    last_seen_at: string;
  }[];

  const matches: DuplicateMatch[] = rows.map((r) => ({
    kind: r.kind as DuplicateKind,
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    // Strict requires BOTH signals to have been available and both to have hit.
    // An enquiry with no email cannot produce a strict match however well the
    // phone matches, which is the point: one signal is a suggestion.
    isStrict: Boolean(phoneKey && email && r.phone_hit && r.email_hit),
    stage: (r.stage as LeadStage | null) ?? null,
    lastSeenAt: requiredRowDate(r.last_seen_at),
  }));

  const strictCustomers = matches.filter((m) => m.isStrict && m.kind === "customer");
  const strictLeads = matches.filter((m) => m.isStrict && m.kind === "lead");

  return {
    matches,
    // Exactly one, or nothing. Ambiguity is escalated to a person rather than
    // resolved by whichever row the planner returned first.
    autoLinkCustomerId: strictCustomers.length === 1 ? (strictCustomers[0]?.id ?? null) : null,
    autoLinkLeadId: strictLeads.length === 1 ? (strictLeads[0]?.id ?? null) : null,
  };
}

/**
 * Record the merge-or-link decision (`LEAD-5`).
 *
 * ── WHY THIS LINKS AND DOES NOT MERGE ──────────────────────────────────────
 *
 * "Merge" in a CRM usually means: copy the fields across, repoint the children,
 * delete one row. Every part of that is irreversible and at least one part is
 * always wrong — the older record has the better address, the newer one has the
 * current phone, and whichever way the copy runs somebody loses the field they
 * cared about.
 *
 * So both rows stay. The duplicate points at the original, the communications
 * log follows the pointer, and the pipeline stops counting the same enquiry
 * twice because a linked lead is closed with a reason. Nothing is destroyed, so
 * a mistaken link is undone by clearing a column instead of by a restore.
 *
 * The disposition reason is required rather than defaulted, and it is required
 * by the same CHECK that governs every other closure: a lead that leaves the
 * pipeline without a coded reason is a hole in the funnel report, and
 * "duplicate" is one of the more useful things that report can say.
 */
export async function linkDuplicateLead(
  tx: TenantScopedTx,
  input: {
    leadId: string;
    /** The earlier lead this repeats, if any. */
    duplicateOfLeadId?: string | undefined;
    /** The existing customer this enquiry is from, if any. */
    matchedCustomerId?: string | undefined;
    /** Required to close the duplicate. Omit to link without closing. */
    dispositionReasonId?: string | undefined;
  },
): Promise<void> {
  if (input.duplicateOfLeadId === input.leadId) {
    throw new UserFacingError("A lead cannot be a duplicate of itself.");
  }

  // Resolved rather than trusted. Under RLS an id from another tenant returns
  // nothing here, so this is also the cross-tenant check.
  if (input.duplicateOfLeadId) {
    const target = await getLead(tx, input.duplicateOfLeadId);
    if (!target) throw new UserFacingError("That lead is not one this can be linked to.");
  }

  await tx
    .update(schema.leads)
    .set({
      duplicateOfLeadId: input.duplicateOfLeadId ?? null,
      matchedCustomerId: input.matchedCustomerId ?? null,
      lastInteractionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.leads.id, input.leadId));

  if (input.dispositionReasonId) {
    // Through `setLeadStage`, not a direct update, so the controlled-list check
    // and the database CHECK both still apply. A second closure path that
    // skipped them is how free text gets back into the reason field.
    await setLeadStage(tx, input.leadId, "lost", {
      dispositionReasonId: input.dispositionReasonId,
      note: input.duplicateOfLeadId
        ? `Duplicate of lead ${input.duplicateOfLeadId.slice(0, 8).toUpperCase()}`
        : "Existing customer",
    });
  }
}

// ── LEAD-9. Communications log ──────────────────────────────────────────────

export interface CommunicationRow {
  readonly id: string;
  readonly channel: string;
  readonly direction: string;
  readonly subject: string | null;
  readonly body: string | null;
  readonly outcome: string | null;
  readonly authorName: string | null;
  readonly isAutomated: boolean;
  readonly occurredAt: Date;
}

/**
 * Log one touch (`LEAD-9`).
 *
 * ── ONE CLICK AND ONE SENTENCE ─────────────────────────────────────────────
 *
 * The requirement is explicit about the interaction cost, and it is the whole
 * design constraint: a log that takes longer than writing on a pad does not get
 * written, and a communications table nobody writes to is what
 * `communications` has been since it was created. So `channel`, `direction`
 * and `occurredAt` all default, and the only thing the caller must supply is
 * the sentence.
 *
 * ── THE SIDE EFFECT IS THE POINT ───────────────────────────────────────────
 *
 * Logging a call winds two clocks. `last_interaction_at` becomes true, which is
 * what the nurture queue and `LEAD-7`'s retention clock both read; and the
 * outcome sets a default follow-up, because "one click and one sentence" cannot
 * also mean "and now pick a date". A call logged with no next step is a lead
 * dropped by accident rather than by decision.
 *
 * An explicit `nextFollowUpAt` always wins over the outcome's default —
 * including an explicit null, which means "no follow-up, deliberately".
 */
export async function logCommunication(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    leadId?: string | undefined;
    customerId?: string | undefined;
    jobId?: string | undefined;
    channel: CommunicationChannel;
    direction?: CommunicationDirection | undefined;
    subject?: string | undefined;
    /** The sentence. This is the required field. */
    body: string;
    outcome?: CommunicationOutcome | undefined;
    occurredAt?: Date | undefined;
    /** Explicit, including explicit null. Undefined means "use the default". */
    nextFollowUpAt?: Date | null | undefined;
  },
): Promise<{ communicationId: string }> {
  const body = input.body.trim();
  if (!body) throw new UserFacingError("Say what happened, in a sentence.");
  if (!input.leadId && !input.customerId && !input.jobId) {
    throw new UserFacingError("A logged communication has to be about a lead, a customer or a job.");
  }

  const occurredAt = input.occurredAt ?? new Date();

  const [row] = await tx
    .insert(schema.communications)
    .values({
      tenantId: ctx.tenantId,
      leadId: input.leadId ?? null,
      customerId: input.customerId ?? null,
      jobId: input.jobId ?? null,
      channel: input.channel,
      direction: input.direction ?? "outbound",
      subject: input.subject?.trim() || null,
      body,
      outcome: input.outcome ?? null,
      authorId: ctx.userId ?? null,
      isAutomated: ctx.actorKind === "ai" || ctx.actorKind === "system",
      occurredAt,
    })
    .returning({ id: schema.communications.id });

  if (!row) throw new Error("Could not log the communication");

  if (input.leadId) {
    const defaultDays = input.outcome ? FOLLOW_UP_DAYS_FOR_OUTCOME[input.outcome] : null;
    const nextFollowUpAt =
      input.nextFollowUpAt !== undefined
        ? input.nextFollowUpAt
        : defaultDays === null
          ? undefined // Leave whatever was already there.
          : new Date(occurredAt.getTime() + defaultDays * 24 * 60 * 60 * 1000);

    await tx
      .update(schema.leads)
      .set({
        lastInteractionAt: occurredAt,
        ...(nextFollowUpAt !== undefined ? { nextFollowUpAt } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.leads.id, input.leadId));
  }

  return { communicationId: row.id };
}

/**
 * The history for one lead or one customer (`LEAD-9`).
 *
 * A lead that has been linked to an earlier one shows the earlier one's log as
 * well, through `duplicate_of_lead_id`. That is the reason linking is worth
 * anything: the second enquiry from the same person is only useful if it
 * arrives carrying what was said the first time.
 */
export async function listCommunications(
  tx: TenantScopedTx,
  input: { leadId?: string | undefined; customerId?: string | undefined; limit?: number | undefined },
): Promise<readonly CommunicationRow[]> {
  const limit = Math.min(input.limit ?? 50, 200);

  const scope = input.leadId
    ? sql`c.lead_id in (
            select ${input.leadId}::uuid
             union
            select l.duplicate_of_lead_id from leads l where l.id = ${input.leadId}::uuid
              and l.duplicate_of_lead_id is not null
          )`
    : input.customerId
      ? sql`c.customer_id = ${input.customerId}::uuid`
      : null;

  if (!scope) return [];

  const rows = (await tx.execute<{
    id: string;
    channel: string;
    direction: string;
    subject: string | null;
    body: string | null;
    outcome: string | null;
    author_name: string | null;
    is_automated: boolean;
    occurred_at: string;
  }>(sql`
    select c.id, c.channel, c.direction, c.subject, c.body, c.outcome,
           u.full_name as author_name, c.is_automated, c.occurred_at
      from communications c
      left join users u on u.id = c.author_id
     where ${scope}
       and c.deleted_at is null
     order by c.occurred_at desc, c.created_at desc
     limit ${limit}
  `)) as unknown as {
    id: string;
    channel: string;
    direction: string;
    subject: string | null;
    body: string | null;
    outcome: string | null;
    author_name: string | null;
    is_automated: boolean;
    occurred_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel,
    direction: r.direction,
    subject: r.subject,
    body: r.body,
    outcome: r.outcome,
    authorName: r.author_name,
    isAutomated: r.is_automated,
    occurredAt: requiredRowDate(r.occurred_at),
  }));
}

/**
 * Set or clear a follow-up date by hand.
 *
 * Separate from `logCommunication` because deferring a lead is not the same
 * event as talking to somebody, and recording "called, no answer" against a
 * lead nobody called would corrupt the only metric the log produces.
 */
export async function setLeadFollowUp(
  tx: TenantScopedTx,
  leadId: string,
  nextFollowUpAt: Date | null,
): Promise<void> {
  await tx
    .update(schema.leads)
    .set({ nextFollowUpAt, updatedAt: new Date() })
    .where(eq(schema.leads.id, leadId));
}

// ── Nurture and the disposition report ──────────────────────────────────────

export interface NurtureRow {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly stage: LeadStage;
  readonly nextFollowUpAt: Date | null;
  readonly lastInteractionAt: Date;
  readonly daysSinceInteraction: number;
  readonly daysOverdue: number | null;
  readonly channel: string;
}

export interface NurtureQueue {
  /** Follow-up date has passed. Somebody said they would call and has not. */
  readonly overdue: readonly NurtureRow[];
  /** Open, no follow-up set, and nothing has happened for `coldAfterDays`. */
  readonly goingCold: readonly NurtureRow[];
  readonly coldAfterDays: number;
}

/**
 * What needs chasing (`LEAD-9`'s reason for existing).
 *
 * ── TWO LISTS, BECAUSE THEY ARE TWO DIFFERENT FAILURES ─────────────────────
 *
 * **Overdue** is a promise not kept: a date was set and it has passed. Somebody
 * decided to call on Sunday and did not.
 *
 * **Going cold** is worse and is invisible without this query: an open lead
 * with no follow-up date at all. Nothing is overdue because nothing was ever
 * promised, so it appears on no list, breaches no deadline, and sits in
 * `contacted` until the quarter ends. `last_interaction_at` is what makes it
 * findable — it is the difference between "no news" and "nobody has touched
 * this in five weeks".
 *
 * Both are capped and ordered oldest-first, because a queue that shows the
 * newest neglect first is a queue that never reaches the oldest.
 */
export async function leadNurtureQueue(
  tx: TenantScopedTx,
  options?: { now?: Date; coldAfterDays?: number; limit?: number },
): Promise<NurtureQueue> {
  const now = options?.now ?? new Date();
  const coldAfterDays = options?.coldAfterDays ?? 14;
  const limit = Math.min(options?.limit ?? 25, 100);

  const openStages = sql.join(
    OPEN_LEAD_STAGES.map((s) => sql`${s}`),
    sql`, `,
  );

  const rows = (await tx.execute<{
    bucket: string;
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    stage: string;
    next_follow_up_at: string | null;
    last_interaction_at: string;
    channel: string;
  }>(sql`
    with open_leads as (
      select l.* from leads l
       where l.deleted_at is null
         and l.stage::text in (${openStages})
         and l.converted_customer_id is null
         -- A lead already linked to an earlier one is not a second thing to
         -- chase. Chasing both is how somebody gets called twice about the
         -- same enquiry by two different people.
         and l.duplicate_of_lead_id is null
    )
    (select 'overdue'::text as bucket, id, name, phone, email, stage::text,
            next_follow_up_at, last_interaction_at, channel
       from open_leads
      where next_follow_up_at is not null
        and next_follow_up_at <= ${now.toISOString()}::timestamptz
      order by next_follow_up_at asc
      limit ${limit})

    union all

    (select 'cold', id, name, phone, email, stage::text,
            next_follow_up_at, last_interaction_at, channel
       from open_leads
      where next_follow_up_at is null
        and last_interaction_at < ${now.toISOString()}::timestamptz
                                  - make_interval(days => ${coldAfterDays})
      order by last_interaction_at asc
      limit ${limit})
  `)) as unknown as {
    bucket: string;
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    stage: string;
    next_follow_up_at: string | null;
    last_interaction_at: string;
    channel: string;
  }[];

  const toRow = (r: (typeof rows)[number]): NurtureRow => {
    const lastInteractionAt = requiredRowDate(r.last_interaction_at);
    const nextFollowUpAt = rowDate(r.next_follow_up_at);

    return {
      id: r.id,
      name: r.name,
      phone: r.phone,
      email: r.email,
      stage: r.stage as LeadStage,
      nextFollowUpAt,
      lastInteractionAt,
      daysSinceInteraction: Math.floor(
        (now.getTime() - lastInteractionAt.getTime()) / 86_400_000,
      ),
      daysOverdue: nextFollowUpAt
        ? Math.floor((now.getTime() - nextFollowUpAt.getTime()) / 86_400_000)
        : null,
      channel: r.channel,
    };
  };

  return {
    overdue: rows.filter((r) => r.bucket === "overdue").map(toRow),
    goingCold: rows.filter((r) => r.bucket === "cold").map(toRow),
    coldAfterDays,
  };
}

export interface DispositionCount {
  readonly reasonId: string | null;
  readonly code: string;
  readonly label: string;
  readonly appliesTo: string;
  readonly leads: number;
  /** Share of closures in this scope, 0–1. Computed here so two screens agree. */
  readonly share: number;
}

export interface LeadFunnelReport {
  readonly days: number;
  readonly byStage: readonly { readonly stage: LeadStage; readonly leads: number }[];
  readonly total: number;
  readonly won: number;
  readonly lost: number;
  readonly dormant: number;
  /** Won as a share of everything that reached a terminal stage. */
  readonly winRate: number;
  readonly lostReasons: readonly DispositionCount[];
  readonly dormantReasons: readonly DispositionCount[];
  /** Closures with no reason attached. Should be zero; if it is not, say so. */
  readonly unreasoned: number;
  readonly medianDaysToClose: number | null;
}

/**
 * The report `lead_disposition_reasons` was built for (`LEAD-6`, `LEAD-9`).
 *
 * 0012 created the controlled vocabulary, `setLeadStage` enforces it and a
 * database CHECK backs that up — and until now nothing read it. A taxonomy
 * that is collected and never reported is a form field that costs the operator
 * three seconds a lead and returns nothing, which is exactly how a controlled
 * list turns into a field everybody sets to the first option.
 *
 * ── WHY LOST AND DORMANT ARE REPORTED SEPARATELY ───────────────────────────
 *
 * `applies_to` exists because they are different questions. Lost is "this will
 * not happen": price, competitor, scope we do not do — and the answer changes
 * what is quoted. Dormant is "not now": budget year, tenant moving out, waiting
 * on the landlord — and the answer changes *when to call back*. Adding them
 * together produces a single "why we do not win" number that is wrong in both
 * directions, understating the pipeline still available and overstating the
 * losses.
 *
 * `unreasoned` is deliberately surfaced rather than filtered out. It should
 * always be zero — the CHECK constraint sees to that for anything closed after
 * 0012 — and a non-zero value means historical rows predate the constraint. A
 * report that quietly drops them shows percentages that do not add up and
 * nobody can see why.
 */
export async function leadDispositionReport(
  tx: TenantScopedTx,
  options?: { days?: number },
): Promise<LeadFunnelReport> {
  const days = options?.days ?? 90;

  const stageRows = (await tx.execute<{ stage: string; leads: string }>(sql`
    select stage::text as stage, count(*) as leads
      from leads
     where deleted_at is null
       and created_at >= now() - make_interval(days => ${days})
     group by 1
  `)) as unknown as { stage: string; leads: string }[];

  const reasonRows = (await tx.execute<{
    stage: string;
    reason_id: string | null;
    code: string | null;
    label: string | null;
    applies_to: string | null;
    leads: string;
  }>(sql`
    select l.stage::text as stage,
           r.id as reason_id,
           r.code,
           r.label,
           r.applies_to,
           count(*) as leads
      from leads l
      left join lead_disposition_reasons r on r.id = l.disposition_reason_id
     where l.deleted_at is null
       and l.stage in ('lost', 'dormant')
       and l.created_at >= now() - make_interval(days => ${days})
     group by 1, 2, 3, 4, 5
     order by count(*) desc, r.label
  `)) as unknown as {
    stage: string;
    reason_id: string | null;
    code: string | null;
    label: string | null;
    applies_to: string | null;
    leads: string;
  }[];

  // Median rather than mean. One lead reopened after eight months drags an
  // average past every real number in the set, and the figure is read as
  // "how long does this normally take".
  const cycleRows = (await tx.execute<{ median_days: string | null }>(sql`
    select percentile_cont(0.5) within group (
             order by extract(epoch from (updated_at - created_at)) / 86400
           ) as median_days
      from leads
     where deleted_at is null
       and stage in ('won', 'lost')
       and created_at >= now() - make_interval(days => ${days})
  `)) as unknown as { median_days: string | null }[];

  const byStage = stageRows.map((r) => ({ stage: r.stage as LeadStage, leads: Number(r.leads) }));
  const total = byStage.reduce((sum, r) => sum + r.leads, 0);
  const countOf = (stage: LeadStage) => byStage.find((r) => r.stage === stage)?.leads ?? 0;

  const won = countOf("won");
  const lost = countOf("lost");
  const dormant = countOf("dormant");
  const closed = won + lost;

  const bucket = (stage: "lost" | "dormant"): DispositionCount[] => {
    const rows = reasonRows.filter((r) => r.stage === stage && r.reason_id);
    const stageTotal = rows.reduce((sum, r) => sum + Number(r.leads), 0);
    return rows.map((r) => ({
      reasonId: r.reason_id,
      code: r.code ?? "unknown",
      label: r.label ?? "No reason recorded",
      appliesTo: r.applies_to ?? "both",
      leads: Number(r.leads),
      share: stageTotal > 0 ? Number(r.leads) / stageTotal : 0,
    }));
  };

  const medianDays = cycleRows[0]?.median_days;

  return {
    days,
    byStage,
    total,
    won,
    lost,
    dormant,
    winRate: closed > 0 ? won / closed : 0,
    lostReasons: bucket("lost"),
    dormantReasons: bucket("dormant"),
    unreasoned: reasonRows.filter((r) => !r.reason_id).reduce((sum, r) => sum + Number(r.leads), 0),
    medianDaysToClose: medianDays === null || medianDays === undefined ? null : Number(medianDays),
  };
}
