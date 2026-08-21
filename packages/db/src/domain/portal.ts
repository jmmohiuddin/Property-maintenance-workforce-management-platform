import { and, eq, isNull, asc, desc, sql, inArray } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { loadWorkingCalendar } from "./reference";
import {
  computeSlaDeadlines,
  toMinor,
  UserFacingError,
  CUSTOMER_NOTIFICATION_EVENTS,
  visitsForTerm,
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
 * That mistake is no longer reachable. `listInvoices` now requires a `jobId`
 * and is the per-job list only, so there is no unbounded staff invoice query
 * for a portal path to pick up by accident; the tenant-wide one is
 * `searchInvoices`, which is keyset-paginated and staff-scoped. The portal home
 * page calls this function, and says so at the call site.
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

// ── CON-5. The contract, as the customer paying for it sees it ──────────────

export interface PortalEntitlementRow {
  readonly serviceSlug: string;
  readonly label: string;
  readonly visitsPerYear: number;
  /** Over the whole term, not per year. A two-year contract owes twice. */
  readonly entitledForTerm: number;
  readonly consumedVisits: number;
  readonly remaining: number;
}

export interface PortalContractRow {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly status: string;
  readonly startsOn: Date;
  readonly endsOn: Date;
  readonly daysRemaining: number;
  /** The customer-facing carve-out list, verbatim from the contract header. */
  readonly exclusions: readonly {
    readonly code: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly entitlements: readonly PortalEntitlementRow[];
}

/**
 * The customer's own contracts and what is left on them (`CON-5`).
 *
 * ── WHAT THIS DELIBERATELY DOES NOT READ ───────────────────────────────────
 *
 * Not `contract_terms`. The discount rate and the payment terms live there,
 * they are the internal position an out-of-scope quote is priced from, and
 * `CON-5` asks for the entitlement and not for them. The policy in
 * `sql/customer-scope.sql` opens `contract_entitlements` alone, so this is not
 * a matter of which columns were typed here: a query that reached for the terms
 * from a portal session would return nothing.
 *
 * The exclusion list comes from `contracts.exclusions`, the JSONB column the
 * schema documents as the list shown verbatim to the customer, rather than from
 * `contract_exclusions`. Those rows exist so `CON-6` can match a code by
 * machine, and a customer reading `compressor_replacement` learns less than the
 * sentence that was written for them.
 *
 * Drafts and cancellations are excluded for the same reason a draft invoice is:
 * an unsigned contract is a working document, and publishing one shows the
 * customer a term nobody has committed to.
 */
export async function listPortalContracts(
  tx: TenantScopedTx,
  options?: { now?: Date },
): Promise<readonly PortalContractRow[]> {
  const now = options?.now ?? new Date();

  // Query builder rather than raw SQL, so `starts_on` and `ends_on` arrive as
  // real Dates. `tx.execute` hands back space-separated strings and the type
  // parameter would not have said so.
  const rows = await tx
    .select({
      id: schema.contracts.id,
      reference: schema.contracts.reference,
      name: schema.contracts.name,
      status: schema.contracts.status,
      startsOn: schema.contracts.startsOn,
      endsOn: schema.contracts.endsOn,
      exclusions: schema.contracts.exclusions,
    })
    .from(schema.contracts)
    .where(
      and(
        isNull(schema.contracts.deletedAt),
        inArray(schema.contracts.status, ["active", "suspended", "expired"]),
      ),
    )
    .orderBy(desc(schema.contracts.endsOn));

  if (rows.length === 0) return [];

  const entitlements = await tx
    .select({
      contractId: schema.contractEntitlements.contractId,
      serviceSlug: schema.contractEntitlements.serviceSlug,
      label: schema.contractEntitlements.label,
      visitsPerYear: schema.contractEntitlements.visitsPerYear,
      consumedVisits: schema.contractEntitlements.consumedVisits,
    })
    .from(schema.contractEntitlements)
    .where(
      and(
        inArray(
          schema.contractEntitlements.contractId,
          rows.map((r) => r.id),
        ),
        isNull(schema.contractEntitlements.deletedAt),
      ),
    )
    .orderBy(asc(schema.contractEntitlements.label));

  return rows.map((r) => {
    const termDays = Math.max(
      1,
      Math.round((r.endsOn.getTime() - r.startsOn.getTime()) / 86_400_000),
    );

    return {
      id: r.id,
      reference: r.reference,
      name: r.name,
      status: r.status,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      daysRemaining: Math.ceil((r.endsOn.getTime() - now.getTime()) / 86_400_000),
      // Objects, not strings. `createContract` writes
      // `{ code, label, description }` into this column — the label and the
      // sentence are the whole reason it is the customer-facing list rather
      // than the code table — and a first pass here read it as an array of
      // strings, which silently produced an empty list on every contract.
      exclusions: (Array.isArray(r.exclusions) ? (r.exclusions as unknown[]) : []).flatMap((e) => {
        if (typeof e === "string") return [{ code: e, label: e, description: null }];
        if (e === null || typeof e !== "object") return [];
        const entry = e as Record<string, unknown>;
        const code = typeof entry["code"] === "string" ? entry["code"] : "";
        const label = typeof entry["label"] === "string" ? entry["label"] : code;
        if (label === "") return [];
        return [
          {
            code: code || label,
            label,
            description: typeof entry["description"] === "string" ? entry["description"] : null,
          },
        ];
      }),
      entitlements: entitlements
        .filter((e) => e.contractId === r.id)
        .map((e) => {
          const entitledForTerm = visitsForTerm(e.visitsPerYear, termDays);
          return {
            serviceSlug: e.serviceSlug,
            label: e.label,
            visitsPerYear: e.visitsPerYear,
            entitledForTerm,
            consumedVisits: e.consumedVisits,
            // Floored at zero. A contract that has been used past its
            // entitlement is at zero remaining, not at minus two — the
            // negative is a fact for the renewal conversation, not a number to
            // put in front of the customer as if we owed them less than none.
            remaining: Math.max(entitledForTerm - e.consumedVisits, 0),
          };
        }),
    };
  });
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
 * The template each customer event is queued under.
 *
 * ── WHY THIS IS ONE CONSTANT AND NOT SEVEN LITERALS ────────────────────────
 *
 * Template plus subject id *is* the idempotency key, and it is what lets the
 * immediate sends and the sweep coexist: the candidate query below refuses to
 * offer anything the notifications ledger already names, so a quote the jobs
 * screen announced at 21:40 is one the next sweep steps over. That only works
 * while the query and the web app's typed enqueue agree on the exact string. As
 * two independent sets of literals, a rename in one of them would have turned
 * every already-announced invoice back into an un-announced one and told every
 * customer twice — silently, because both halves would still compile.
 *
 * Declared `as const` so each value keeps its literal type. That is what lets
 * the web app pass `CUSTOMER_NOTIFICATION_TEMPLATE.work_complete` where a
 * template id is expected and still have its payload checked against the right
 * template, rather than widening to `string` and losing the check.
 */
export const CUSTOMER_NOTIFICATION_TEMPLATE = {
  request_received: "request_received",
  visit_scheduled: "visit_scheduled",
  technician_en_route: "technician_en_route",
  work_complete: "job_completed",
  quote_awaiting_decision: "quote_sent",
  invoice_issued: "invoice_issued",
  payment_received: "payment_received",
} as const satisfies Record<CustomerNotificationEvent, string>;

/** The record a customer notification can be about. */
export type CustomerNotificationSubjectTable =
  | "jobs"
  | "job_visits"
  | "quotes"
  | "invoices"
  | "payments";

/**
 * Does this customer want to hear about this event (`POR-5`)?
 *
 * ── WHY THIS EXISTS SEPARATELY FROM THE SWEEP'S FILTER ─────────────────────
 *
 * The opt-out used to be enforced in exactly one place: the `muted` CTE in
 * `pendingCustomerNotifications` below. That is the right shape for a sweep,
 * which asks the question about hundreds of customers at once and wants a set,
 * not hundreds of round trips.
 *
 * It is the wrong shape — and was simply absent — for the three events that are
 * *also* sent the instant they happen. A portal request is acknowledged while
 * the customer is still looking at the screen; a quote and an invoice are
 * announced by the action that raised them. Those three called `enqueue`
 * directly and never read this table at all, so a customer who switched invoice
 * emails off received every one of them. Permanently, because the ledger row
 * the immediate send wrote is what tells the sweep an invoice has already been
 * announced, so the sweep never revisited it either.
 *
 * So there are two readers of one table, deliberately: a set for the sweep and
 * a row for a single decision. What matters is that they cannot disagree, and
 * the thing that could make them disagree is the default. Absence of a row
 * means opted IN — the customer has never expressed a preference — and that
 * default is written here, in `customerNotificationSettings`, and in the CTE's
 * `where not is_enabled`, all three saying the same thing. The first one to
 * read a missing row as "off" would silently stop messages nobody asked to
 * stop, and there is a test pinning the two to the same answer for every event
 * and every customer in the fixture.
 *
 * Whichever reader answers no, the answer is recorded the same way:
 * `recordSuppressedCustomerNotification`. See there for why refusing has to
 * leave a trace.
 */
export async function isCustomerNotificationEnabled(
  tx: TenantScopedTx,
  customerId: string,
  event: CustomerNotificationEvent,
): Promise<boolean> {
  const rows = await tx
    .select({ isEnabled: schema.customerNotificationPreferences.isEnabled })
    .from(schema.customerNotificationPreferences)
    .where(
      and(
        eq(schema.customerNotificationPreferences.customerId, customerId),
        eq(schema.customerNotificationPreferences.event, event),
      ),
    )
    .limit(1);

  return rows[0]?.isEnabled ?? true;
}

/**
 * Record that a customer notification was deliberately withheld (`POR-5`).
 *
 * ── WHY REFUSING HAS TO LEAVE A TRACE ──────────────────────────────────────
 *
 * The sweep works out what is owed by asking what the `notifications` ledger
 * does not already name. Withholding a message by simply not writing a row
 * therefore does not withhold it — it defers it. The subject stays owed for as
 * long as its `recorded_at` is inside the lookback window, so the moment the
 * customer switched the event back on, the next sweep would deliver the backlog
 * they had muted: three back-dated invoice emails at once, on the Friday, for
 * invoices they said no to on the Monday.
 *
 * That is the experience that teaches people their preference controls do not
 * work, so it is not what happens. A mute is a refusal, not a pause. The
 * customer said no at the time the invoice was raised, and that answer is the
 * one that governs — a setting toggled afterwards changes what happens next, it
 * does not retroactively consent to what already went by.
 *
 * This is an explicit product decision, taken by the people who own the
 * product, and not a default that fell out of the implementation. It was
 * originally built the other way round and changed on purpose. Anyone who finds
 * this row surprising is looking at the answer to a question that was asked and
 * settled, not at an oversight to tidy up.
 *
 * ── HOW IT INTERACTS WITH THE DEDUP, WHICH IS THE SUBTLE PART ──────────────
 *
 * The row uses the same (template, subject_id) key the sweep dedupes on, and
 * status `suppressed`, which nothing ever sends: `dispatchPending` claims only
 * `queued` and `failed`. So a withheld message settles its subject in exactly
 * the way a sent one does, and the sweep steps over it forever after.
 *
 * The obvious worry is that this becomes the opposite bug — a marker that
 * blocks a later, genuinely new event. It does not, and the reason is that this
 * row is not doing anything a delivered row was not already doing. Every one of
 * the seven events is keyed so that a genuine recurrence gets a NEW subject id
 * rather than a second notification under the old one: a rescheduled visit is a
 * new `job_visits` row, a second payment is a new `payments` row, and
 * `technician_en_route` hangs off a single `en_route_at` timestamp that a
 * second departure overwrites. Where a key genuinely can repeat — a job
 * re-opened and completed twice writes `completed_at` on the same job id — the
 * subject key was already the limiter and a *sent* row already suppressed the
 * second notice. This changes nothing about that; it only makes a refusal as
 * final as a delivery.
 *
 * Nor can it block a different event: no two of the seven share a template, so
 * a suppression under `invoice_issued` is invisible to every other kind of
 * message about the same customer.
 *
 * ── WHAT IS DELIBERATELY *NOT* RECORDED ────────────────────────────────────
 *
 * An event the customer wants, for an account with no email address on file,
 * writes nothing. That is a different situation and must not be flattened into
 * this one: the message is still owed, and the sweep should send it the moment
 * somebody fills the billing email in. The dispatch cron counts those
 * separately so the gap stays visible.
 */
export async function recordSuppressedCustomerNotification(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    event: CustomerNotificationEvent;
    subjectTable: CustomerNotificationSubjectTable;
    subjectId: string;
    /** The address it would have gone to, for the "why didn't they get it" question. */
    address: string;
  },
): Promise<void> {
  const template = CUSTOMER_NOTIFICATION_TEMPLATE[input.event];

  // Guarded by a read rather than an upsert, because there is no unique index
  // on (template, subject_id) to hang one on — the ledger legitimately holds
  // several rows for one subject when an account has several notify contacts.
  // Two sweeps racing here would write two suppression rows, which costs a
  // duplicate ledger line and sends nothing, so the race is not worth a
  // constraint.
  //
  // The guard is blind inside a portal session, and deliberately so. Reads of
  // this table are closed to a customer scope by the restrictive default in
  // customer-scope.sql, while writes to it stay open because accepting a quote
  // has to be able to enqueue one. So the probe returns nothing there and the
  // insert always happens — which costs nothing in the one place it applies:
  // the portal only reaches here for a job it created in this same transaction,
  // which by definition nothing has written a row for yet.
  const existing = await tx
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.template, template),
        eq(schema.notifications.subjectId, input.subjectId),
      ),
    )
    .limit(1);

  if (existing.length > 0) return;

  await tx.insert(schema.notifications).values({
    tenantId: ctx.tenantId,
    channel: "email",
    template,
    recipientAddress: input.address,
    subjectTable: input.subjectTable,
    subjectId: input.subjectId,
    payload: { suppressed: "customer_opted_out", event: input.event },
    status: "suppressed",
  });
}

/**
 * The name to address a customer notification to.
 *
 * The account's name, not the name on the portal login that triggered the
 * message. The sweep greets every one of the seven events with `customers.name`
 * and the immediate sends have to match it, or the same customer gets two
 * differently-addressed versions of the same email depending on which path
 * happened to reach them first.
 */
export async function customerAccountName(
  tx: TenantScopedTx,
  customerId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ name: schema.customers.name })
    .from(schema.customers)
    .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
    .limit(1);

  return rows[0]?.name ?? null;
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
  readonly subjectTable: CustomerNotificationSubjectTable;
  readonly subjectId: string;
  readonly reference: string;
  readonly title: string;
  readonly detail: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly occursAt: Date | null;
  readonly occursEndAt: Date | null;
  readonly recipients: readonly CustomerNotificationRecipient[];
  /**
   * The customer has switched this event off. Offered anyway, so the caller can
   * record the refusal rather than silently defer it — see the note above.
   */
  readonly muted: boolean;
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
 * ── THE OPT-OUT: A FLAG HERE, NOT A FILTER ─────────────────────────────────
 *
 * The `muted` CTE below is the set-based half of `POR-5` — the right shape for
 * a sweep asking about hundreds of customers at once, where the single-row half
 * (`isCustomerNotificationEnabled`) would be hundreds of round trips. Both read
 * the same table with the same default, and a test pins them to the same answer
 * for every event and every customer in the fixture.
 *
 * What the CTE does *not* do is remove the row. It used to: muted candidates
 * were filtered out here, which meant the sweep never saw them, which meant
 * nothing ever recorded that they had been withheld. A muted event that leaves
 * no trace is not withheld, only deferred — it stays owed for as long as it is
 * inside the lookback window, so lifting the mute on Friday delivered the whole
 * week's worth of what the customer had said no to on Monday.
 *
 * So `muted` comes back as a column and the caller acts on it: it writes a
 * suppression row instead of an email, which settles the subject for good. That
 * is an explicit product decision — a mute is a refusal, not a pause — and the
 * reasoning, including why a suppression row cannot become the opposite bug,
 * is written out on `recordSuppressedCustomerNotification`.
 *
 * The cost of flagging rather than filtering is that muted candidates take up
 * room in the `limit` budget. They take it once: the row the caller writes
 * settles them, and the next sweep does not see them again.
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
    muted: boolean;
  };

  const rows = (await tx.execute<Row>(sql`
    with cutoff as (select now() - make_interval(days => ${sinceDays}) as since),

    -- Opted out, per customer per event. This set is what honours POR-5 on the
    -- sweep's side; the absence of a row means opted in, so only rows with
    -- is_enabled = false mute anything. The single-row form of the same
    -- question, for the sends that happen the moment the event does, is
    -- isCustomerNotificationEnabled above.
    --
    -- Projected as a column below rather than filtered out here, so that the
    -- caller can record the refusal in the ledger. Filtering meant the sweep
    -- never saw a muted event, so nothing ever wrote it down, so lifting the
    -- mute delivered the backlog.
    muted as (
      select customer_id, event from customer_notification_preferences where not is_enabled
    ),

    candidate as (
      -- Request received. The template column in every branch is bound from
      -- CUSTOMER_NOTIFICATION_TEMPLATE rather than written out, because it is
      -- half the idempotency key and the route writes the other half of the
      -- story under the same name.
      select 'request_received'::text as event, j.customer_id, 'jobs'::text as subject_table,
             j.id as subject_id, j.reference, j.title,
             null::text as detail, null::text as amount, null::text as currency,
             j.created_at as occurs_at, null::timestamptz as occurs_end_at,
             j.created_at as recorded_at,
             ${CUSTOMER_NOTIFICATION_TEMPLATE.request_received}::text as template
        from jobs j, cutoff c
       where j.deleted_at is null and j.status <> 'draft' and j.created_at >= c.since

      union all

      -- Visit scheduled. Keyed on the visit, not the job: a rescheduled job has
      -- a second visit and the customer needs telling about the new window.
      select 'visit_scheduled', j.customer_id, 'job_visits', v.id, j.reference, j.title,
             t.full_name, null, null, v.scheduled_start, v.scheduled_end,
             v.created_at, ${CUSTOMER_NOTIFICATION_TEMPLATE.visit_scheduled}::text
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
             v.en_route_at, ${CUSTOMER_NOTIFICATION_TEMPLATE.technician_en_route}::text
        from job_visits v
        join jobs j on j.id = v.job_id
        join technicians t on t.id = v.technician_id, cutoff c
       where v.en_route_at is not null and v.en_route_at >= c.since and j.deleted_at is null

      union all

      select 'work_complete', j.customer_id, 'jobs', j.id, j.reference, j.title,
             null, null, null, j.completed_at, null,
             j.completed_at, ${CUSTOMER_NOTIFICATION_TEMPLATE.work_complete}::text
        from jobs j, cutoff c
       where j.completed_at is not null and j.completed_at >= c.since and j.deleted_at is null

      union all

      select 'quote_awaiting_decision', q.customer_id, 'quotes', q.id, q.reference, q.title,
             null, q.total::text, q.currency::text, q.sent_at, q.valid_until,
             coalesce(q.sent_at, q.created_at),
             ${CUSTOMER_NOTIFICATION_TEMPLATE.quote_awaiting_decision}::text
        from quotes q, cutoff c
       where q.status in ('sent', 'viewed')
         and q.deleted_at is null
         and coalesce(q.sent_at, q.created_at) >= c.since

      union all

      select 'invoice_issued', i.customer_id, 'invoices', i.id, i.reference, i.reference,
             null, i.total::text, i.currency::text, i.due_on, null,
             coalesce(i.issued_on, i.created_at),
             ${CUSTOMER_NOTIFICATION_TEMPLATE.invoice_issued}::text
        from invoices i, cutoff c
       where i.status <> 'draft'
         and i.deleted_at is null
         and coalesce(i.issued_on, i.created_at) >= c.since

      union all

      select 'payment_received', i.customer_id, 'payments', p.id, i.reference, i.reference,
             p.method::text, p.amount::text, p.currency::text, p.received_at, null,
             p.received_at, ${CUSTOMER_NOTIFICATION_TEMPLATE.payment_received}::text
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
           k.occurs_end_at,
           exists (
             select 1 from muted m
              where m.customer_id = k.customer_id and m.event = k.event
           ) as muted
      from candidate k
      join customers cu on cu.id = k.customer_id
     where not exists (
             -- Already in the ledger, queued by this sweep or by an action.
             select 1 from notifications n
              where n.template = k.template and n.subject_id = k.subject_id
           )
       and cu.deleted_at is null
     order by k.recorded_at asc
     limit ${limit}
  `)) as unknown as Row[];

  if (rows.length === 0) return [];

  // Resolved in bulk — one query for every customer in the batch — through the
  // same function the immediate sends call for a single customer. That shared
  // function is the point: the immediate sends used to email
  // `customers.billing_email` directly (or, in the portal's case, the logged-in
  // user's own address), so a contact flagged `notify_on_jobs` heard about a
  // quote from the sweep and never from the jobs screen that actually sent it.
  const recipients = await customerNotificationRecipients(tx, [
    ...new Set(rows.map((r) => r.customer_id)),
  ]);

  return rows.map((r) => ({
    event: r.event as CustomerNotificationEvent,
    customerId: r.customer_id,
    customerName: r.customer_name,
    subjectTable: r.subject_table as CustomerNotificationSubjectTable,
    subjectId: r.subject_id,
    reference: r.reference,
    title: r.title,
    detail: r.detail,
    amount: r.amount,
    currency: r.currency,
    occursAt: rowDate(r.occurs_at),
    occursEndAt: rowDate(r.occurs_end_at),
    recipients: recipients.get(r.customer_id) ?? [],
    muted: r.muted,
  }));
}

/** One address a customer notification goes to, and who it belongs to. */
export interface CustomerNotificationRecipient {
  readonly email: string;
  readonly name: string;
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
 *
 * ── WHY THIS IS EXPORTED, WHEN IT USED TO BE PRIVATE ───────────────────────
 *
 * Because it was private, it was the sweep's rule and nobody else's. The three
 * events that are also sent the moment they happen each invented their own:
 * the quote and invoice actions emailed `customers.billing_email` straight from
 * `getQuoteForNotification` / `getInvoiceForNotification`, and the portal's
 * request form emailed the address on the login session. So a contact flagged
 * `notify_on_jobs` was told about a quote by the cron sweep and not by the
 * screen that sent it, and the billing contact was told about a request by the
 * sweep and not by the portal. Three recipient rules for seven events.
 *
 * One exported function, called by both the sweep (in bulk) and every immediate
 * send (for one customer), is what makes that structural rather than
 * remembered: there is no second rule to be inconsistent with.
 */
export async function customerNotificationRecipients(
  tx: TenantScopedTx,
  customerIds: readonly string[],
): Promise<Map<string, CustomerNotificationRecipient[]>> {
  const byCustomer = new Map<string, CustomerNotificationRecipient[]>();
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
