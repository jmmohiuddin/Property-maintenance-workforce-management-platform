import { and, eq, isNull, asc, desc, sql, inArray } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { loadWorkingCalendar } from "./reference";
import {
  computeSlaDeadlines,
  toMinor,
  UserFacingError,
  CUSTOMER_NOTIFICATION_EVENTS,
  type CustomerNotificationEvent,
  type JobPriority,
  type JobStatus,
} from "@meridian/core";
import { nextJobReference } from "./jobs";
import { rowDate, requiredRowDate } from "./_rows";
// Type-only, so this stays a compile-time reference and adds no import cycle:
// the invoice status vocabulary belongs to commerce and is not restated here.
import type { InvoiceStatus } from "./commerce";

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

// ═══════════════════════════════════════════════════════════════════════════
// Customer-portal reads (`POR-3`, `POR-4`, `POR-5`).
//
// ── THE RULE EVERY FUNCTION BELOW OBEYS ────────────────────────────────────
//
// Each one is called inside `withCustomerScope`, never `withTenant`. That is
// not a convention, it is where the boundary lives. A portal user holds
// `jobs:read` so that the portal works at all, so a permission check alone
// would happily serve them another customer's rows; `withTenant` scopes to the
// tenant and not to the customer, so it would too. The RESTRICTIVE policies in
// sql/customer-scope.sql are the thing that actually refuses, and they only
// engage when `app.customer_id` is set.
//
// The consequence worth internalising: none of the queries below carry a
// `WHERE customer_id = ?`. That is deliberate. If one of them is ever run
// without customer scope it must return NOTHING rather than everything, and
// the way to get that property is to have no application-level filter to
// forget in the first place.
// ═══════════════════════════════════════════════════════════════════════════

// ── POR-3. Request history and detail ───────────────────────────────────────

export interface PortalRequestRow {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly serviceSlug: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly propertyName: string;
  readonly propertyArea: string | null;
  /** The booked window for the visit that matters now, or the last one done. */
  readonly visitStart: Date | null;
  readonly visitEnd: Date | null;
  readonly technicianName: string | null;
  /** `JOB-13`'s coded outcome, resolved to its label. Null until a visit ends. */
  readonly outcome: string | null;
  readonly photoCount: number;
}

/**
 * Every request this customer has raised (`POR-3`, closing `PD-8`).
 *
 * ── WHY THIS IS NOT `listDispatchBoard` WITH A DIFFERENT LIMIT ──────────────
 *
 * The portal home already calls `listDispatchBoard`, and under customer scope
 * that is safe — but it answers a different question. The board shows *open*
 * work ordered by priority and SLA deadline, which is a dispatcher's ordering:
 * it exists to decide what to do next. `POR-3` asks for history, which is the
 * customer's ordering — newest first, closed work included, because the whole
 * point is answering "what happened to the thing I reported in March".
 *
 * It also projects differently, and that difference is the security-relevant
 * part. The board carries `assignmentScore`, `assignmentReason` and the
 * override fields through `job_visits`; none of them belong in front of a
 * customer. The restrictive policy added for `job_visits` in 0016 stops one
 * customer seeing another's visits; this projection is what stops any customer
 * seeing the scoring behind their own.
 */
export async function listPortalRequests(
  tx: TenantScopedTx,
  options?: { limit?: number; statuses?: readonly JobStatus[] },
): Promise<readonly PortalRequestRow[]> {
  const limit = Math.min(options?.limit ?? 50, 200);

  // Each status bound as its own parameter rather than passed as one array.
  // Drizzle's `sql` tag expands a JavaScript array into separate placeholders,
  // so `= any(${statuses})` renders as `any(($1, $2))` and Postgres rejects it
  // — it typechecks and fails on every call. `sql.join` produces a real IN list
  // with one bind per value.
  const statusFilter =
    options?.statuses && options.statuses.length > 0
      ? sql`and j.status::text in (${sql.join(
          options.statuses.map((s) => sql`${s}`),
          sql`, `,
        )})`
      : sql``;

  // A LATERAL rather than a plain LEFT JOIN on `job_visits`. A job with three
  // visits joined plainly returns three rows, and the list would show the same
  // request three times with three different windows — which reads as three
  // separate appointments to the person looking at it.
  //
  // The ordering inside it picks the visit that matters now: a live one first
  // (assigned, accepted, en route, arrived), then the most recent by schedule.
  const rows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    status: string;
    service_slug: string;
    created_at: string;
    completed_at: string | null;
    property_name: string;
    property_area: string | null;
    visit_start: string | null;
    visit_end: string | null;
    technician_name: string | null;
    outcome: string | null;
    photo_count: string;
  }>(sql`
    select j.id,
           j.reference,
           j.title,
           j.status::text as status,
           j.service_slug,
           j.created_at,
           j.completed_at,
           p.name as property_name,
           p.area as property_area,
           v.scheduled_start as visit_start,
           v.scheduled_end   as visit_end,
           v.technician_name,
           o.label as outcome,
           (select count(*) from job_attachments a
             where a.job_id = j.id
               and a.kind in ('photo_before', 'photo_after')) as photo_count
      from jobs j
      join properties p on p.id = j.property_id
      left join lateral (
        select vv.scheduled_start, vv.scheduled_end, t.full_name as technician_name
          from job_visits vv
          join technicians t on t.id = vv.technician_id
         where vv.job_id = j.id
         order by (vv.status in ('assigned','accepted','en_route','arrived')) desc,
                  vv.scheduled_start desc nulls last,
                  vv.sequence desc
         limit 1
      ) v on true
      left join job_outcome_codes o
             on o.tenant_id = j.tenant_id and o.code = j.outcome_code
     where j.deleted_at is null
       -- A draft job is one operations has not raised yet. Showing it would
       -- announce work the customer has not been told about and cannot act on.
       and j.status <> 'draft'
       ${statusFilter}
     order by j.created_at desc, j.id desc
     limit ${limit}
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    status: string;
    service_slug: string;
    created_at: string;
    completed_at: string | null;
    property_name: string;
    property_area: string | null;
    visit_start: string | null;
    visit_end: string | null;
    technician_name: string | null;
    outcome: string | null;
    photo_count: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    status: r.status as JobStatus,
    serviceSlug: r.service_slug,
    createdAt: requiredRowDate(r.created_at),
    completedAt: rowDate(r.completed_at),
    propertyName: r.property_name,
    propertyArea: r.property_area,
    visitStart: rowDate(r.visit_start),
    visitEnd: rowDate(r.visit_end),
    technicianName: r.technician_name,
    outcome: r.outcome,
    photoCount: Number(r.photo_count),
  }));
}

export interface PortalRequestDetail {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: JobStatus;
  readonly serviceSlug: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly propertyName: string;
  readonly propertyArea: string | null;
  readonly propertyCity: string;
  readonly outcome: string | null;
  /** Status changes only, in the customer's words. Never the internal note. */
  readonly timeline: readonly { readonly status: JobStatus; readonly occurredAt: Date }[];
  readonly visits: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly technicianName: string;
    readonly scheduledStart: Date | null;
    readonly scheduledEnd: Date | null;
    readonly arrivedAt: Date | null;
    readonly completedAt: Date | null;
  }[];
  /** What was done, in the technician's own words or an approved summary. */
  readonly workCarriedOut: readonly string[];
  readonly recommendations: readonly string[];
  readonly materials: readonly { readonly description: string; readonly quantity: string; readonly unit: string }[];
  readonly photos: readonly {
    readonly id: string;
    readonly kind: string;
    readonly caption: string | null;
    readonly capturedAt: Date | null;
  }[];
  readonly signoff: {
    readonly signedByName: string;
    readonly signedAt: Date;
    readonly satisfactionRating: number | null;
  } | null;
}

/**
 * One request, with everything the customer is entitled to see (`POR-3`).
 *
 * ── THREE DELIBERATE OMISSIONS ─────────────────────────────────────────────
 *
 * 1. **Event notes.** `job_events.note` is staff free text — "customer was
 *    abusive on the phone", "third callout this month, check the warranty",
 *    "converted from web enquiry ENQ-…". The timeline here is the status and
 *    the timestamp, and nothing else. There is no way to sanitise a free-text
 *    field written by somebody who believed it was internal.
 *
 * 2. **Unapproved AI summaries.** `job_reports.ai_summary` is generated from
 *    the technician's raw notes and is explicitly reviewable rather than
 *    silent — `ai_summary_approved_by_id` is the review. An unapproved summary
 *    is a machine's guess at what happened on site, and putting it in front of
 *    a customer as a statement of work performed is how a warranty argument
 *    starts. Approved summaries are shown; unapproved ones fall back to
 *    `work_carried_out`, which a person wrote.
 *
 * 3. **Costs on materials.** `job_materials` carries `unit_cost` — what the
 *    part cost the business. `POR-3` asks for what was used, and the price is
 *    on the invoice.
 */
export async function getPortalRequestDetail(
  tx: TenantScopedTx,
  jobId: string,
): Promise<PortalRequestDetail | null> {
  const jobRows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    description: string | null;
    status: string;
    service_slug: string;
    created_at: string;
    completed_at: string | null;
    property_name: string;
    property_area: string | null;
    property_city: string;
    outcome: string | null;
  }>(sql`
    select j.id, j.reference, j.title, j.description, j.status::text as status,
           j.service_slug, j.created_at, j.completed_at,
           p.name as property_name, p.area as property_area, p.city as property_city,
           o.label as outcome
      from jobs j
      join properties p on p.id = j.property_id
      left join job_outcome_codes o
             on o.tenant_id = j.tenant_id and o.code = j.outcome_code
     where j.id = ${jobId}
       and j.deleted_at is null
       and j.status <> 'draft'
     limit 1
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    description: string | null;
    status: string;
    service_slug: string;
    created_at: string;
    completed_at: string | null;
    property_name: string;
    property_area: string | null;
    property_city: string;
    outcome: string | null;
  }[];

  const job = jobRows[0];
  // Not found and not yours are the same answer, and they have to be: telling
  // the two apart tells a caller whether a given id exists in another
  // customer's account.
  if (!job) return null;

  const events = await tx
    .select({ toStatus: schema.jobEvents.toStatus, occurredAt: schema.jobEvents.occurredAt })
    .from(schema.jobEvents)
    .where(eq(schema.jobEvents.jobId, jobId))
    .orderBy(asc(schema.jobEvents.occurredAt));

  const visits = await tx
    .select({
      id: schema.jobVisits.id,
      sequence: schema.jobVisits.sequence,
      technicianName: schema.technicians.fullName,
      scheduledStart: schema.jobVisits.scheduledStart,
      scheduledEnd: schema.jobVisits.scheduledEnd,
      arrivedAt: schema.jobVisits.arrivedAt,
      completedAt: schema.jobVisits.completedAt,
    })
    .from(schema.jobVisits)
    .innerJoin(schema.technicians, eq(schema.technicians.id, schema.jobVisits.technicianId))
    .where(eq(schema.jobVisits.jobId, jobId))
    .orderBy(asc(schema.jobVisits.sequence));

  const reports = await tx
    .select({
      workCarriedOut: schema.jobReports.workCarriedOut,
      recommendation: schema.jobReports.recommendation,
      aiSummary: schema.jobReports.aiSummary,
      aiSummaryApprovedById: schema.jobReports.aiSummaryApprovedById,
    })
    .from(schema.jobReports)
    .where(eq(schema.jobReports.jobId, jobId))
    .orderBy(asc(schema.jobReports.createdAt));

  const materials = await tx
    .select({
      description: schema.jobMaterials.description,
      quantity: schema.jobMaterials.quantity,
      unit: schema.jobMaterials.unit,
    })
    .from(schema.jobMaterials)
    .where(eq(schema.jobMaterials.jobId, jobId));

  const photos = await tx
    .select({
      id: schema.jobAttachments.id,
      kind: schema.jobAttachments.kind,
      caption: schema.jobAttachments.caption,
      capturedAt: schema.jobAttachments.capturedAt,
    })
    .from(schema.jobAttachments)
    .where(
      and(
        eq(schema.jobAttachments.jobId, jobId),
        // Photographs only. `document` and `signature` attachments are neither
        // evidence of the work nor safe to hand over blind — a signature image
        // is a reusable credential.
        inArray(schema.jobAttachments.kind, ["photo_before", "photo_after"]),
      ),
    )
    .orderBy(asc(schema.jobAttachments.createdAt));

  const signoffs = await tx
    .select({
      signedByName: schema.jobSignoffs.signedByName,
      signedAt: schema.jobSignoffs.signedAt,
      satisfactionRating: schema.jobSignoffs.satisfactionRating,
    })
    .from(schema.jobSignoffs)
    .where(eq(schema.jobSignoffs.jobId, jobId))
    .orderBy(desc(schema.jobSignoffs.signedAt))
    .limit(1);

  return {
    id: job.id,
    reference: job.reference,
    title: job.title,
    description: job.description,
    status: job.status as JobStatus,
    serviceSlug: job.service_slug,
    createdAt: requiredRowDate(job.created_at),
    completedAt: rowDate(job.completed_at),
    propertyName: job.property_name,
    propertyArea: job.property_area,
    propertyCity: job.property_city,
    outcome: job.outcome,
    timeline: events.map((e) => ({ status: e.toStatus as JobStatus, occurredAt: e.occurredAt })),
    visits,
    workCarriedOut: reports
      .map((r) => (r.aiSummaryApprovedById ? (r.aiSummary ?? r.workCarriedOut) : r.workCarriedOut))
      .filter((t): t is string => Boolean(t && t.trim())),
    recommendations: reports
      .map((r) => r.recommendation)
      .filter((t): t is string => Boolean(t && t.trim())),
    materials,
    photos,
    signoff: signoffs[0] ?? null,
  };
}

// ── POR-4. Invoices and the statement of account ────────────────────────────

export interface PortalInvoiceRow {
  readonly id: string;
  readonly reference: string;
  readonly status: InvoiceStatus;
  readonly issuedOn: Date | null;
  readonly dueOn: Date | null;
  readonly totalMinor: number;
  readonly paidMinor: number;
  readonly creditedMinor: number;
  readonly outstandingMinor: number;
  readonly currency: string;
  readonly daysOverdue: number | null;
  /** False until the artefact exists. The download link is hidden, not broken. */
  readonly hasDocument: boolean;
  readonly jobReference: string | null;
}

/**
 * The customer's invoices (`POR-4`).
 *
 * ── WHY THIS IS NOT `listInvoices` UNDER CUSTOMER SCOPE ────────────────────
 *
 * Because `listInvoices` returns drafts, and the portal must not. A draft
 * invoice is a working document: the amount can still change, the lines can
 * still be wrong, and it has no legal existence — Article 59 attaches to an
 * issued tax invoice. Showing one to a customer publishes a number the business
 * has not committed to, and the first anyone hears of it is a dispute about a
 * figure nobody meant to send.
 *
 * The portal home page shares this problem today. It calls `listInvoices`
 * directly and lists whatever comes back, drafts included.
 *
 * Credit notes are netted off here rather than listed separately, because the
 * question this screen answers is "what do I owe". `portalStatement` below is
 * where the two are shown as separate documents, which is what a statement of
 * account is for.
 */
export async function listPortalInvoices(
  tx: TenantScopedTx,
  options?: { limit?: number; now?: Date },
): Promise<readonly PortalInvoiceRow[]> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const now = options?.now ?? new Date();

  const rows = (await tx.execute<{
    id: string;
    reference: string;
    status: string;
    issued_on: string | null;
    due_on: string | null;
    total: string;
    amount_paid: string;
    credited: string;
    currency: string;
    has_document: boolean;
    job_reference: string | null;
  }>(sql`
    select i.id,
           i.reference,
           i.status::text as status,
           i.issued_on,
           i.due_on,
           i.total,
           i.amount_paid,
           coalesce((select sum(n.total) from credit_notes n
                      where n.invoice_id = i.id and n.deleted_at is null), 0) as credited,
           i.currency,
           (i.pdf_storage_key is not null) as has_document,
           j.reference as job_reference
      from invoices i
      left join jobs j on j.id = i.job_id
     where i.deleted_at is null
       and i.status <> 'draft'
     order by i.issued_on desc nulls last, i.reference desc
     limit ${limit}
  `)) as unknown as {
    id: string;
    reference: string;
    status: string;
    issued_on: string | null;
    due_on: string | null;
    total: string;
    amount_paid: string;
    credited: string;
    currency: string;
    has_document: boolean;
    job_reference: string | null;
  }[];

  return rows.map((r) => {
    const issuedOn = rowDate(r.issued_on);
    const dueOn = rowDate(r.due_on);
    const totalMinor = toMinor(r.total);
    const paidMinor = toMinor(r.amount_paid);
    const creditedMinor = toMinor(r.credited);
    const outstandingMinor = Math.max(totalMinor - paidMinor - creditedMinor, 0);
    const settled = r.status === "paid" || r.status === "written_off" || r.status === "credited";

    return {
      id: r.id,
      reference: r.reference,
      status: r.status as InvoiceStatus,
      issuedOn,
      dueOn,
      totalMinor,
      paidMinor,
      creditedMinor,
      outstandingMinor,
      currency: r.currency,
      // Overdue is computed from today rather than read from a status column,
      // for the reason `arAgeing` gives: a stored "overdue" flag is only as
      // current as the last time a nightly job that nobody watches ran.
      daysOverdue:
        dueOn && !settled && outstandingMinor > 0
          ? Math.max(Math.floor((now.getTime() - dueOn.getTime()) / 86_400_000), 0) || null
          : null,
      hasDocument: r.has_document,
      jobReference: r.job_reference,
    };
  });
}

export interface StatementEntry {
  readonly kind: "invoice" | "credit_note" | "payment";
  readonly reference: string;
  readonly occurredAt: Date;
  /** Positive increases what is owed, negative reduces it. */
  readonly amountMinor: number;
  readonly detail: string | null;
}

export interface PortalStatement {
  /** Oldest first, capped. The totals below are NOT computed from these. */
  readonly entries: readonly StatementEntry[];
  /** True when the ledger is longer than the entries shown. */
  readonly truncated: boolean;
  readonly invoicedMinor: number;
  readonly creditedMinor: number;
  readonly paidMinor: number;
  readonly balanceMinor: number;
  readonly currency: string;
}

/**
 * Statement of account (`POR-4`, and the customer-facing half of `INV-13`).
 *
 * One chronological ledger of everything that moved the balance: invoices up,
 * credit notes down, payments down. Signed amounts rather than three separate
 * lists, because the question is "how did I get to this number" and three
 * lists side by side is the reader doing the arithmetic.
 *
 * The balance is derived from the entries in the same pass that builds them, so
 * the total and the lines cannot disagree — a statement whose footer does not
 * match its rows is worse than no statement, because somebody will act on it.
 */
export async function portalStatement(
  tx: TenantScopedTx,
  options?: { limit?: number },
): Promise<PortalStatement> {
  const limit = Math.min(options?.limit ?? 200, 500);

  const rows = (await tx.execute<{
    kind: string;
    reference: string;
    occurred_at: string;
    amount: string;
    detail: string | null;
    currency: string;
  }>(sql`
      select 'invoice' as kind,
             i.reference,
             coalesce(i.issued_on, i.created_at) as occurred_at,
             i.total as amount,
             null::text as detail,
             i.currency
        from invoices i
       where i.deleted_at is null and i.status <> 'draft'

       union all

      select 'credit_note',
             n.reference,
             coalesce(n.issued_on, n.created_at),
             n.total,
             n.reason::text,
             n.currency
        from credit_notes n
       where n.deleted_at is null

       union all

      -- Joined to invoices rather than read alone. A payment carries no
      -- customer_id of its own; its customer-scope policy reaches the customer
      -- through the invoice, and the statement needs the invoice reference
      -- anyway to say what the payment was against.
      select 'payment',
             i.reference,
             p.received_at,
             p.amount,
             p.method::text,
             p.currency
        from payments p
        join invoices i on i.id = p.invoice_id
       where p.deleted_at is null

       order by occurred_at asc, reference asc
       limit ${limit}
  `)) as unknown as {
    kind: string;
    reference: string;
    occurred_at: string;
    amount: string;
    detail: string | null;
    currency: string;
  }[];

  // ── The totals ────────────────────────────────────────────────────────────
  //
  // A separate aggregate over EVERY row, not a sum of the entries above.
  //
  // The entry list is capped, and it is capped from the oldest end because a
  // running balance has to start at the beginning to mean anything. Summing the
  // capped list would therefore produce a footer that is correct for a customer
  // with a short history and quietly wrong — understated — for the long-standing
  // customer with the largest balance. That is the wrong direction to be wrong
  // in, on a number somebody pays against.
  const totalRows = (await tx.execute<{
    invoiced: string;
    credited: string;
    paid: string;
    entry_count: string;
    currency: string | null;
  }>(sql`
    select
      coalesce((select sum(i.total) from invoices i
                 where i.deleted_at is null and i.status <> 'draft'), 0)::text as invoiced,
      coalesce((select sum(n.total) from credit_notes n
                 where n.deleted_at is null), 0)::text as credited,
      coalesce((select sum(p.amount) from payments p
                 join invoices i2 on i2.id = p.invoice_id
                where p.deleted_at is null), 0)::text as paid,
      (
        (select count(*) from invoices i3 where i3.deleted_at is null and i3.status <> 'draft')
        + (select count(*) from credit_notes n2 where n2.deleted_at is null)
        + (select count(*) from payments p2
            join invoices i4 on i4.id = p2.invoice_id
           where p2.deleted_at is null)
      )::text as entry_count,
      (select i5.currency from invoices i5
        where i5.deleted_at is null and i5.status <> 'draft'
        order by i5.issued_on desc nulls last limit 1) as currency
  `)) as unknown as {
    invoiced: string;
    credited: string;
    paid: string;
    entry_count: string;
    currency: string | null;
  }[];

  const totals = totalRows[0];
  const invoicedMinor = toMinor(totals?.invoiced ?? "0");
  const creditedMinor = toMinor(totals?.credited ?? "0");
  const paidMinor = toMinor(totals?.paid ?? "0");

  const entries: StatementEntry[] = rows.map((r) => ({
    kind: r.kind as StatementEntry["kind"],
    reference: r.reference,
    occurredAt: requiredRowDate(r.occurred_at),
    // Signed, so one column reads as a ledger: an invoice increases what is
    // owed, a credit note and a payment reduce it. Three separate lists side by
    // side would make the reader do the arithmetic.
    amountMinor: r.kind === "invoice" ? toMinor(r.amount) : -toMinor(r.amount),
    detail: r.detail,
  }));

  return {
    entries,
    truncated: Number(totals?.entry_count ?? 0) > entries.length,
    invoicedMinor,
    creditedMinor,
    paidMinor,
    balanceMinor: invoicedMinor - creditedMinor - paidMinor,
    currency: totals?.currency || "AED",
  };
}

export interface PortalInvoiceRef {
  readonly id: string;
  readonly reference: string;
  readonly status: InvoiceStatus;
}

/**
 * Resolve an invoice a portal user is asking to download (`POR-4`).
 *
 * ── WHY THIS FUNCTION EXISTS AT ALL ────────────────────────────────────────
 *
 * The staff download route refuses portal users outright and says the portal
 * path is "a different concern with a different scoping mechanism". This is
 * that mechanism, and the difference is one line: the transaction is opened
 * with `withCustomerScope`, so the invoice is invisible unless it is theirs and
 * the lookup below returns nothing.
 *
 * The route then hands the id to `materialiseInvoiceDocument`, which runs in
 * the same scoped transaction and is therefore scoped too — including the
 * render-once write-back, which cannot touch a row the policy hides.
 *
 * Drafts are refused here as well as being hidden from the list. Two checks for
 * one rule is not redundancy: the list decides what is *shown*, this decides
 * what is *served*, and a link that is merely not rendered is a link somebody
 * can still type.
 */
export async function getPortalInvoiceRef(
  tx: TenantScopedTx,
  invoiceId: string,
): Promise<PortalInvoiceRef | null> {
  const rows = await tx
    .select({
      id: schema.invoices.id,
      reference: schema.invoices.reference,
      status: schema.invoices.status,
    })
    .from(schema.invoices)
    .where(and(eq(schema.invoices.id, invoiceId), isNull(schema.invoices.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row || row.status === "draft") return null;
  return { id: row.id, reference: row.reference, status: row.status as InvoiceStatus };
}

// ── POR-5. Customer notifications, and the per-event opt-out ────────────────

export interface CustomerNotificationSetting {
  readonly event: CustomerNotificationEvent;
  readonly isEnabled: boolean;
  readonly updatedAt: Date | null;
}

/**
 * What this customer has chosen, for every event (`POR-5`).
 *
 * Returns all seven whether or not a row exists, because the screen has to
 * render seven switches and "no row" means opted in. Building that default in
 * the caller would mean every caller has to know it, and the first one that
 * forgets renders an unset preference as "off" — which silently stops messages
 * the customer never asked to stop.
 */
export async function customerNotificationSettings(
  tx: TenantScopedTx,
  customerId: string,
): Promise<readonly CustomerNotificationSetting[]> {
  const rows = await tx
    .select({
      event: schema.customerNotificationPreferences.event,
      isEnabled: schema.customerNotificationPreferences.isEnabled,
      updatedAt: schema.customerNotificationPreferences.updatedAt,
    })
    .from(schema.customerNotificationPreferences)
    .where(eq(schema.customerNotificationPreferences.customerId, customerId));

  const stored = new Map(rows.map((r) => [r.event, r]));

  return CUSTOMER_NOTIFICATION_EVENTS.map((event) => {
    const row = stored.get(event);
    return {
      event,
      isEnabled: row?.isEnabled ?? true,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

/**
 * Turn one event on or off (`POR-5`).
 *
 * An upsert on `(tenant_id, customer_id, event)` rather than a delete-when-on:
 * "opted back in on 3 March" is a fact worth keeping, and a row that vanishes
 * when the answer is yes makes the two states — never chosen, and chosen yes —
 * indistinguishable afterwards.
 *
 * `event` is narrowed to the union by the type and checked again by the CHECK
 * constraint in 0016. Both, because this is reached from a form post: the type
 * is a promise the compiler makes about this codebase, and the constraint is
 * what holds when the value arrives from somewhere the compiler never saw.
 */
export async function setCustomerNotificationPreference(
  tx: TenantScopedTx,
  ctx: TenantContext & { customerId: string },
  input: { event: CustomerNotificationEvent; isEnabled: boolean },
): Promise<void> {
  await tx
    .insert(schema.customerNotificationPreferences)
    .values({
      tenantId: ctx.tenantId,
      customerId: ctx.customerId,
      event: input.event,
      isEnabled: input.isEnabled,
      updatedById: ctx.userId ?? null,
    })
    .onConflictDoUpdate({
      target: [
        schema.customerNotificationPreferences.tenantId,
        schema.customerNotificationPreferences.customerId,
        schema.customerNotificationPreferences.event,
      ],
      set: {
        isEnabled: input.isEnabled,
        updatedById: ctx.userId ?? null,
        updatedAt: new Date(),
      },
    });
}

/**
 * A customer notification that is owed and has not been queued.
 *
 * The payload shapes match `@meridian/notify`'s templates exactly, but this
 * package cannot say so in its types — `notify` imports `db`, so a type import
 * the other way is a cycle. The caller maps event to template in one place
 * (`apps/web/src/lib/customer-notifications.ts`) and the compiler checks the
 * match there.
 */
export interface PendingCustomerNotification {
  readonly event: CustomerNotificationEvent;
  readonly customerId: string;
  readonly customerName: string;
  /** The record this is about. Also the idempotency key — see below. */
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly reference: string;
  readonly title: string;
  readonly detail: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly occursAt: Date | null;
  readonly occursEndAt: Date | null;
  readonly recipients: readonly { readonly email: string; readonly name: string }[];
}

/**
 * Everything the customer should have been told about and has not been
 * (`POR-5`).
 *
 * ── WHY A SWEEP AND NOT SEVEN CALL SITES ───────────────────────────────────
 *
 * The obvious implementation is an `enqueue` next to each state change: one in
 * the assignment action, one where a technician taps "on my way", one in
 * `recordPayment`, and so on. That is what was done for the three notifications
 * that already exist, and `TD-4` is the record of how it goes: the queue, the
 * ledger and the retry logic were all correct, and the only thing that ever
 * *called* them was two unrelated user actions, so a quote sent at 21:40 sat
 * unqueued until somebody completed an unrelated job.
 *
 * Seven more call sites means seven more places to forget, spread across code
 * owned by four different people, plus the field app and the importer that are
 * still coming. A sweep over the facts already recorded in the database is
 * indifferent to which code path wrote them — including paths written later by
 * somebody who never read this file.
 *
 * ── IDEMPOTENCY ────────────────────────────────────────────────────────────
 *
 * `notifications` is the ledger of what was attempted, so it is also the record
 * of what not to attempt again: a row is owed only when no notification with
 * that template already names that subject. This is why the existing per-action
 * enqueues do not need removing and must not be — `request_received` queued by
 * the portal form is the same (template, subject) pair the sweep would produce,
 * so the sweep skips it. The two mechanisms compose instead of double-sending.
 *
 * ── THE LOOKBACK WINDOW ────────────────────────────────────────────────────
 *
 * `sinceDays` is not a performance tuning knob, it is a safety catch. Without
 * it, the first run of this sweep against an existing database would email
 * every customer about every invoice ever issued and every job ever completed,
 * because none of them have a matching ledger row. Seven days is short enough
 * that the first run is quiet and long enough that a weekend of cron outage
 * still gets delivered.
 */
export async function pendingCustomerNotifications(
  tx: TenantScopedTx,
  options?: { sinceDays?: number; limit?: number },
): Promise<readonly PendingCustomerNotification[]> {
  const sinceDays = options?.sinceDays ?? 7;
  const limit = Math.min(options?.limit ?? 200, 500);

  type Row = {
    event: string;
    customer_id: string;
    customer_name: string;
    subject_table: string;
    subject_id: string;
    reference: string;
    title: string;
    detail: string | null;
    amount: string | null;
    currency: string | null;
    occurs_at: string | null;
    occurs_end_at: string | null;
  };

  const rows = (await tx.execute<Row>(sql`
    with cutoff as (select now() - make_interval(days => ${sinceDays}) as since),

    -- Opted out, per customer per event. A LEFT JOIN against this is what
    -- honours POR-5; the absence of a row means opted in, so only rows with
    -- is_enabled = false suppress anything.
    muted as (
      select customer_id, event from customer_notification_preferences where not is_enabled
    ),

    candidate as (
      -- Request received.
      select 'request_received'::text as event, j.customer_id, 'jobs'::text as subject_table,
             j.id as subject_id, j.reference, j.title,
             null::text as detail, null::text as amount, null::text as currency,
             j.created_at as occurs_at, null::timestamptz as occurs_end_at,
             j.created_at as recorded_at, 'request_received'::text as template
        from jobs j, cutoff c
       where j.deleted_at is null and j.status <> 'draft' and j.created_at >= c.since

      union all

      -- Visit scheduled. Keyed on the visit, not the job: a rescheduled job has
      -- a second visit and the customer needs telling about the new window.
      select 'visit_scheduled', j.customer_id, 'job_visits', v.id, j.reference, j.title,
             t.full_name, null, null, v.scheduled_start, v.scheduled_end,
             v.created_at, 'visit_scheduled'
        from job_visits v
        join jobs j on j.id = v.job_id
        join technicians t on t.id = v.technician_id, cutoff c
       where v.scheduled_start is not null
         and v.status in ('assigned', 'accepted', 'en_route', 'arrived', 'completed')
         and v.created_at >= c.since
         and j.deleted_at is null

      union all

      -- On the way. The en_route_at timestamp is the fact; the visit status may
      -- have moved past it by the time the sweep runs, which is why the
      -- timestamp is the condition rather than the status.
      select 'technician_en_route', j.customer_id, 'job_visits', v.id, j.reference, j.title,
             t.full_name, null, null, v.en_route_at, null,
             v.en_route_at, 'technician_en_route'
        from job_visits v
        join jobs j on j.id = v.job_id
        join technicians t on t.id = v.technician_id, cutoff c
       where v.en_route_at is not null and v.en_route_at >= c.since and j.deleted_at is null

      union all

      select 'work_complete', j.customer_id, 'jobs', j.id, j.reference, j.title,
             null, null, null, j.completed_at, null,
             j.completed_at, 'job_completed'
        from jobs j, cutoff c
       where j.completed_at is not null and j.completed_at >= c.since and j.deleted_at is null

      union all

      select 'quote_awaiting_decision', q.customer_id, 'quotes', q.id, q.reference, q.title,
             null, q.total::text, q.currency::text, q.sent_at, q.valid_until,
             coalesce(q.sent_at, q.created_at), 'quote_sent'
        from quotes q, cutoff c
       where q.status in ('sent', 'viewed')
         and q.deleted_at is null
         and coalesce(q.sent_at, q.created_at) >= c.since

      union all

      select 'invoice_issued', i.customer_id, 'invoices', i.id, i.reference, i.reference,
             null, i.total::text, i.currency::text, i.due_on, null,
             coalesce(i.issued_on, i.created_at), 'invoice_issued'
        from invoices i, cutoff c
       where i.status <> 'draft'
         and i.deleted_at is null
         and coalesce(i.issued_on, i.created_at) >= c.since

      union all

      select 'payment_received', i.customer_id, 'payments', p.id, i.reference, i.reference,
             p.method::text, p.amount::text, p.currency::text, p.received_at, null,
             p.received_at, 'payment_received'
        from payments p
        join invoices i on i.id = p.invoice_id, cutoff c
       where p.deleted_at is null and p.received_at >= c.since
    )

    select k.event,
           k.customer_id,
           cu.name as customer_name,
           k.subject_table,
           k.subject_id,
           k.reference,
           k.title,
           k.detail,
           k.amount,
           k.currency,
           k.occurs_at,
           k.occurs_end_at
      from candidate k
      join customers cu on cu.id = k.customer_id
     where not exists (
             select 1 from muted m
              where m.customer_id = k.customer_id and m.event = k.event
           )
       and not exists (
             -- Already in the ledger, queued by this sweep or by an action.
             select 1 from notifications n
              where n.template = k.template and n.subject_id = k.subject_id
           )
       and cu.deleted_at is null
     order by k.recorded_at asc
     limit ${limit}
  `)) as unknown as Row[];

  if (rows.length === 0) return [];

  const recipients = await customerNotificationRecipients(tx, [
    ...new Set(rows.map((r) => r.customer_id)),
  ]);

  return rows.map((r) => ({
    event: r.event as CustomerNotificationEvent,
    customerId: r.customer_id,
    customerName: r.customer_name,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    reference: r.reference,
    title: r.title,
    detail: r.detail,
    amount: r.amount,
    currency: r.currency,
    occursAt: rowDate(r.occurs_at),
    occursEndAt: rowDate(r.occurs_end_at),
    recipients: recipients.get(r.customer_id) ?? [],
  }));
}

/**
 * Who at a customer hears about their jobs.
 *
 * The contacts flagged `notify_on_jobs`, plus the billing address as a
 * fallback. The fallback matters more than it looks: a customer created by
 * `convertLeadToJob` has a billing email and no contacts at all, so a
 * recipient list built from contacts alone would silently reach nobody for
 * every converted lead — which is most new customers.
 *
 * Portal *users* are deliberately not included. A portal login is an identity
 * for reading the account, not a subscription: the person who holds the login
 * is often not the person who wants the emails, and conflating them is how
 * somebody ends up unable to stop messages without losing their access.
 */
async function customerNotificationRecipients(
  tx: TenantScopedTx,
  customerIds: readonly string[],
): Promise<Map<string, { email: string; name: string }[]>> {
  const byCustomer = new Map<string, { email: string; name: string }[]>();
  if (customerIds.length === 0) return byCustomer;

  // `inArray`, not `= any(${ids})` in a raw template. Drizzle's `sql` tag
  // expands a JavaScript array into separate placeholders, so `any(${ids})`
  // becomes `any(($1, $2))` and Postgres rejects it with "op ANY/ALL (array)
  // requires array on right side". It typechecks; it fails at runtime, every
  // time, for every caller. The query builder binds the list properly.
  const contacts = await tx
    .select({
      customerId: schema.customerContacts.customerId,
      email: schema.customerContacts.email,
      fullName: schema.customerContacts.fullName,
    })
    .from(schema.customerContacts)
    .where(
      and(
        inArray(schema.customerContacts.customerId, [...customerIds]),
        eq(schema.customerContacts.notifyOnJobs, true),
        isNull(schema.customerContacts.deletedAt),
      ),
    );

  for (const c of contacts) {
    if (!c.email) continue;
    const list = byCustomer.get(c.customerId) ?? [];
    list.push({ email: c.email.toLowerCase(), name: c.fullName });
    byCustomer.set(c.customerId, list);
  }

  // The fallback, applied only where the contact list produced nobody.
  const missing = customerIds.filter((id) => !byCustomer.has(id));
  if (missing.length === 0) return byCustomer;

  const billing = await tx
    .select({
      id: schema.customers.id,
      name: schema.customers.name,
      billingEmail: schema.customers.billingEmail,
    })
    .from(schema.customers)
    .where(and(inArray(schema.customers.id, [...missing]), isNull(schema.customers.deletedAt)));

  for (const c of billing) {
    if (!c.billingEmail) continue;
    byCustomer.set(c.id, [{ email: c.billingEmail.toLowerCase(), name: c.name }]);
  }

  return byCustomer;
}
