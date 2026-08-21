import { sql, and, eq, isNull } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  UserFacingError,
  computeSlaDeadlines,
  computeTotals,
  decideScope,
  dubaiDateKey,
  exclusionDefinition,
  parseContractSla,
  planPpmVisits,
  ppmCompletion,
  renewalBand,
  toDecimalString,
  toMinor,
  utilisationPercent,
  visitsForTerm,
  UAE_VAT_BASIS_POINTS,
  CONTRACT_DOCUMENT_LABEL,
  RENEWAL_PIPELINE_DAYS,
  STANDARD_AMC_EXCLUSIONS,
  type BillingFrequency,
  type ContractDocumentKind,
  type CoverageType,
  type JobPriority,
  type PpmCompletion,
  type RenewalBand,
  type ScopeDecision,
  type WorkingCalendar,
} from "@meridian/core";
import { loadWorkingCalendar } from "./reference";

/**
 * Contracts and AMC — `CON-1`…`CON-10`.
 *
 * ── WHAT THIS MODULE IS FOR ─────────────────────────────────────────────────
 *
 * An AMC is not a record of an agreement. It is a machine that produces work:
 * it generates its own planned visits for the full term, turns each of them
 * into a job when its window opens, decrements an entitlement when one
 * completes, refuses to absorb work it does not cover, and warns before it
 * expires. Every one of those verbs is a function below, and each has a caller
 * — the contracts screens, `/api/cron/contracts`, or `/api/cron/compliance`.
 *
 * ── THE ONE THING TO GET RIGHT ──────────────────────────────────────────────
 *
 * PPM dates are generated against the tenant's stored working calendar, never
 * against `DEFAULT_CALENDAR`. The default ships with an empty public-holiday
 * list on purpose — a hardcoded list goes stale in January and then silently
 * schedules work on Eid — so taking the fallback here would mean an
 * administrator could enter every UAE public holiday (`ADM-10`) and the PPM
 * schedule would still ignore them. `loadWorkingCalendar(tx)` is called at
 * every generation point for that reason.
 *
 * The planner also refuses the summer midday ban. That is a hard block with a
 * statutory penalty (AED 5,000 per worker, capped at AED 50,000, plus a
 * classification downgrade), and a planned visit is placed months in advance at
 * no cost — there is no reason to spend that risk on a date nobody has to keep.
 *
 * ── WHAT A RENEWAL IS ───────────────────────────────────────────────────────
 *
 * A **warning**, not a block. `CON-9` reminders escalate and an expired AMC is
 * reported every run while it stays expired, but nothing here refuses an
 * action because a contract is near its end. This system has exactly three hard
 * blocks — an expired blocking document, an expired work permit and the summer
 * midday ban — and each has a named statutory penalty. A contract renewal has a
 * commercial consequence, and commercial consequences are warned about.
 */

// ── References ───────────────────────────────────────────────────────────────

async function nextContractReference(tx: TenantScopedTx, year: number): Promise<string> {
  // Allocated by the database for the same reason quotes and invoices are:
  // counting rows races, and under the customer-scope policies a portal read
  // cannot see the number another customer already took. See sql/reference.sql.
  const rows = await tx.execute<{ reference: string }>(
    sql`select app_next_reference('CON', ${year}) as reference`,
  );
  const reference = rows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a contract reference");
  return reference;
}

// ── CON-1 / CON-2: creating a contract ───────────────────────────────────────

export interface EntitlementInput {
  readonly serviceSlug: string;
  readonly label: string;
  readonly visitsPerYear: number;
}

export interface ExclusionInput {
  readonly code: string;
  readonly label?: string;
  readonly description?: string;
}

export interface CreateContractInput {
  readonly customerId: string;
  readonly name: string;
  readonly coverageType: CoverageType;
  readonly startsOn: Date;
  readonly endsOn: Date;
  /** Decimal string as entered, e.g. "42000.00". */
  readonly annualValue: string;
  readonly billingFrequency: BillingFrequency;
  readonly paymentTermsDays?: number;
  readonly discountRateBasisPoints?: number;
  /** Null or omitted means unlimited callouts — a real and common term. */
  readonly calloutsPerYear?: number | null;
  readonly propertyIds: readonly string[];
  readonly entitlements: readonly EntitlementInput[];
  readonly exclusionCodes?: readonly string[];
  /** Per-priority SLA overrides. Shape validated by `parseContractSla`. */
  readonly slaTargets?: unknown;
  readonly ppmLeadTimeDays?: number;
  readonly ppmWindowDays?: number;
  readonly autoRenew?: boolean;
  readonly ownerId?: string;
}

/**
 * Create a contract, its term sheet, entitlements, exclusions and coverage.
 *
 * Draft, always. `CON-3` generates the schedule on **activation**, not on
 * creation, because a draft contract's dates change while it is being
 * negotiated and a schedule regenerated on every edit would either duplicate
 * visits or throw away ones a dispatcher had already moved.
 *
 * Both representations of the covered services and exclusions are written from
 * this one input — the JSONB arrays on `contracts` that the portal renders
 * verbatim, and the rows the scheduler and the scope check read. Writing them
 * from one place is what stops them drifting; writing them separately is how a
 * customer is shown an exclusion list the system does not enforce.
 */
export async function createContract(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: CreateContractInput,
): Promise<{ contractId: string; reference: string }> {
  if (input.entitlements.length === 0) {
    throw new UserFacingError(
      "A contract needs at least one entitlement. Without one it generates no visits, and a " +
        "maintenance contract that generates no visits is an invoice with no work behind it.",
    );
  }
  if (input.propertyIds.length === 0) {
    throw new UserFacingError("A contract needs at least one covered property.");
  }
  if (input.endsOn <= input.startsOn) {
    throw new UserFacingError("The contract must end after it starts.");
  }

  // Every covered property must belong to the customer the contract is with.
  //
  // RLS guarantees the properties are this tenant's; it says nothing about
  // whose they are inside the tenant. A contract covering another customer's
  // building would generate PPM jobs against that building, invoice the wrong
  // party for them, and show one customer's address in the other's portal —
  // and every one of those is discovered by the customer, not by us.
  const mismatched = (await tx.execute<{ id: string; name: string }>(sql`
    select id, name from properties
     where id = any(${sql`array[${sql.join(
       input.propertyIds.map((id) => sql`${id}`),
       sql`, `,
     )}]::uuid[]`})
       and (customer_id <> ${input.customerId} or deleted_at is not null)
  `)) as unknown as { id: string; name: string }[];

  if (mismatched.length > 0) {
    throw new UserFacingError(
      `These properties do not belong to this customer: ${mismatched.map((p) => p.name).join(", ")}.`,
    );
  }

  const reference = await nextContractReference(tx, input.startsOn.getFullYear());
  const exclusionCodes = input.exclusionCodes ?? STANDARD_AMC_EXCLUSIONS.map((e) => e.code);

  const [contract] = await tx
    .insert(schema.contracts)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: input.customerId,
      name: input.name,
      kind: "amc",
      status: "draft",
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      annualValue: toDecimalString(toMinor(input.annualValue)),
      billingFrequency: input.billingFrequency,
      // Kept in step with the entitlements rather than entered separately. The
      // column predates this module and other code reads it; two numbers that
      // mean the same thing must not be editable independently.
      visitsPerYear: input.entitlements.reduce((sum, e) => sum + e.visitsPerYear, 0),
      coveredServices: input.entitlements.map((e) => e.serviceSlug),
      exclusions: exclusionCodes.map((code) => {
        const definition = exclusionDefinition(code);
        return { code, label: definition?.label ?? code, description: definition?.description ?? null };
      }),
      slaTargets: parseContractSla(input.slaTargets),
      autoRenew: input.autoRenew ?? false,
      ownerId: input.ownerId ?? ctx.userId ?? null,
    })
    .returning({ id: schema.contracts.id });

  if (!contract) throw new Error("Failed to create contract");

  await tx.insert(schema.contractTerms).values({
    tenantId: ctx.tenantId,
    contractId: contract.id,
    coverageType: input.coverageType,
    paymentTermsDays: input.paymentTermsDays ?? 30,
    discountRateBasisPoints: input.discountRateBasisPoints ?? 1500,
    calloutsPerYear: input.calloutsPerYear ?? null,
    ppmLeadTimeDays: input.ppmLeadTimeDays ?? 21,
    ppmWindowDays: input.ppmWindowDays ?? 7,
  });

  await tx.insert(schema.contractProperties).values(
    input.propertyIds.map((propertyId) => ({
      tenantId: ctx.tenantId,
      contractId: contract.id,
      propertyId,
    })),
  );

  await tx.insert(schema.contractEntitlements).values(
    input.entitlements.map((e) => ({
      tenantId: ctx.tenantId,
      contractId: contract.id,
      serviceSlug: e.serviceSlug,
      label: e.label,
      visitsPerYear: e.visitsPerYear,
    })),
  );

  if (exclusionCodes.length > 0) {
    await tx.insert(schema.contractExclusions).values(
      exclusionCodes.map((code) => {
        const definition = exclusionDefinition(code);
        return {
          tenantId: ctx.tenantId,
          contractId: contract.id,
          code,
          label: definition?.label ?? code,
          description: definition?.description ?? null,
          isStandard: definition !== undefined,
        };
      }),
    );
  }

  return { contractId: contract.id, reference };
}

// ── CON-3: the PPM schedule ──────────────────────────────────────────────────

export interface PpmGenerationResult {
  readonly created: number;
  readonly skippedExisting: number;
  /** Dates the calendar could not place inside the term. Reported, not hidden. */
  readonly unplaced: readonly string[];
}

/**
 * Generate the planned visits for the whole term (`CON-3`).
 *
 * Idempotent, and that is not a nicety. This is called from `activateContract`
 * and can be re-run from the contract page; a scheduler or an impatient
 * operator must not be able to double-book a year of visits. Idempotency is
 * achieved by *matching on the planned date* — a visit already planned for the
 * same property, service and day is left alone, including any date a dispatcher
 * has since moved. Regenerating would silently undo their work.
 *
 * The visits are dated windows, not appointments. `contract_visits.due_on` is
 * the target; the window is `due_on ± contract_terms.ppm_window_days`. Storing
 * one date and a half-width rather than three dates means the three can never
 * disagree.
 */
export async function generatePpmSchedule(
  tx: TenantScopedTx,
  ctx: TenantContext,
  contractId: string,
  calendarOverride?: WorkingCalendar,
): Promise<PpmGenerationResult> {
  const contract = await loadContractCore(tx, contractId);
  if (!contract) throw new UserFacingError("Contract not found in this tenant.");

  const properties = await tx
    .select({ propertyId: schema.contractProperties.propertyId })
    .from(schema.contractProperties)
    .where(
      and(
        eq(schema.contractProperties.contractId, contractId),
        isNull(schema.contractProperties.deletedAt),
      ),
    );

  const entitlements = await tx
    .select({
      serviceSlug: schema.contractEntitlements.serviceSlug,
      visitsPerYear: schema.contractEntitlements.visitsPerYear,
    })
    .from(schema.contractEntitlements)
    .where(
      and(
        eq(schema.contractEntitlements.contractId, contractId),
        isNull(schema.contractEntitlements.deletedAt),
      ),
    );

  if (properties.length === 0 || entitlements.length === 0) {
    return { created: 0, skippedExisting: 0, unplaced: [] };
  }

  // ADM-10. The stored calendar, never the default — see the module header.
  const calendar = calendarOverride ?? (await loadWorkingCalendar(tx));

  const plan = planPpmVisits({
    termStart: contract.startsOn,
    termEnd: contract.endsOn,
    properties: properties.map((p) => p.propertyId),
    entitlements: entitlements.map((e) => ({
      serviceSlug: e.serviceSlug,
      visitsPerYear: e.visitsPerYear,
    })),
    windowDays: contract.ppmWindowDays,
    calendar,
  });

  // One query for everything already planned, rather than an existence check
  // per visit. A three-property contract at four visits a year is 12 rows; a
  // building portfolio at monthly frequency is hundreds, and a round trip each
  // would make activation feel broken.
  const existing = (await tx.execute<{ key: string }>(sql`
    select property_id || '|' || coalesce(service_slug, '') || '|' ||
           to_char(due_on at time zone 'Asia/Dubai', 'YYYY-MM-DD') as key
      from contract_visits
     where contract_id = ${contractId}
       and deleted_at is null
  `)) as unknown as { key: string }[];

  const seen = new Set(existing.map((r) => r.key));

  const toInsert: (typeof schema.contractVisits.$inferInsert)[] = [];
  let skippedExisting = 0;

  for (const visit of plan.visits) {
    const key = `${visit.propertyId}|${visit.serviceSlug}|${dubaiDay(visit.dueOn)}`;
    if (seen.has(key)) {
      skippedExisting += 1;
      continue;
    }
    seen.add(key);
    toInsert.push({
      tenantId: ctx.tenantId,
      contractId,
      propertyId: visit.propertyId,
      dueOn: visit.dueOn,
      serviceSlug: visit.serviceSlug,
      status: "planned",
    });
  }

  if (toInsert.length > 0) {
    await tx.insert(schema.contractVisits).values(toInsert);
  }

  await tx
    .update(schema.contractTerms)
    .set({ ppmGeneratedThrough: contract.endsOn, updatedAt: new Date() })
    .where(eq(schema.contractTerms.contractId, contractId));

  return {
    created: toInsert.length,
    skippedExisting,
    unplaced: plan.unplaced.map(
      (u) => `${u.serviceSlug} visit ${u.sequence}: ${u.reason}`,
    ),
  };
}

/**
 * Activate a contract and generate its schedule (`CON-1`, `CON-3`).
 *
 * The two happen together on purpose. A contract marked active with no planned
 * visits looks correct on every screen and produces no work — which is the
 * failure mode this whole module exists to prevent, and it would be invisible
 * until an OA management company asked for a PPM completion report.
 */
export async function activateContract(
  tx: TenantScopedTx,
  ctx: TenantContext,
  contractId: string,
): Promise<PpmGenerationResult> {
  const contract = await loadContractCore(tx, contractId);
  if (!contract) throw new UserFacingError("Contract not found in this tenant.");
  if (contract.status === "cancelled" || contract.status === "expired") {
    throw new UserFacingError(
      `This contract is ${contract.status}. Renew it rather than reactivating it — a term that ` +
        "has already ended cannot be the term work is delivered under.",
    );
  }

  const result = await generatePpmSchedule(tx, ctx, contractId);

  await tx
    .update(schema.contracts)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(schema.contracts.id, contractId));

  await tx
    .update(schema.contractTerms)
    .set({ activatedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.contractTerms.contractId, contractId));

  return result;
}

// ── CON-4: a planned visit becomes a job ─────────────────────────────────────

export interface DuePpmVisit {
  readonly visitId: string;
  readonly contractId: string;
  readonly contractReference: string;
  readonly customerId: string;
  readonly propertyId: string;
  readonly propertyName: string;
  readonly serviceSlug: string;
  readonly entitlementLabel: string | null;
  readonly dueOn: Date;
  readonly leadTimeDays: number;
  readonly slaTargets: unknown;
}

/**
 * Planned visits that have entered their scheduling window (`CON-4`).
 *
 * "Entered its window" means `due_on` is no more than the contract's lead time
 * away — 21 days by default. Only visits with no job yet, only on active
 * contracts, and including any whose date has already passed: a visit that
 * slipped past its target without becoming a job is the most urgent row here,
 * not one to exclude.
 */
export async function dueContractVisits(
  tx: TenantScopedTx,
  limit = 500,
): Promise<readonly DuePpmVisit[]> {
  const rows = (await tx.execute<{
    visit_id: string;
    contract_id: string;
    reference: string;
    customer_id: string;
    property_id: string;
    property_name: string;
    service_slug: string;
    entitlement_label: string | null;
    due_on: Date | string;
    lead_time_days: number;
    sla_targets: unknown;
  }>(sql`
    select v.id as visit_id,
           c.id as contract_id,
           c.reference,
           c.customer_id,
           v.property_id,
           p.name as property_name,
           coalesce(v.service_slug, '') as service_slug,
           e.label as entitlement_label,
           v.due_on,
           t.ppm_lead_time_days as lead_time_days,
           c.sla_targets
      from contract_visits v
      join contracts c on c.id = v.contract_id and c.deleted_at is null
      join contract_terms t on t.contract_id = c.id and t.deleted_at is null
      join properties p on p.id = v.property_id
      left join contract_entitlements e
             on e.contract_id = c.id
            and e.service_slug = v.service_slug
            and e.deleted_at is null
     where v.job_id is null
       and v.status = 'planned'
       and v.deleted_at is null
       and c.status = 'active'
       -- The lead time is per contract, so it cannot be a bound parameter on
       -- the outside of the query — it is a column, compared row by row.
       and v.due_on <= now() + make_interval(days => t.ppm_lead_time_days)
     order by v.due_on
     limit ${limit}
  `)) as unknown as {
    visit_id: string;
    contract_id: string;
    reference: string;
    customer_id: string;
    property_id: string;
    property_name: string;
    service_slug: string;
    entitlement_label: string | null;
    due_on: Date | string;
    lead_time_days: number;
    sla_targets: unknown;
  }[];

  return rows.map((r) => ({
    visitId: r.visit_id,
    contractId: r.contract_id,
    contractReference: r.reference,
    customerId: r.customer_id,
    propertyId: r.property_id,
    propertyName: r.property_name,
    serviceSlug: r.service_slug,
    entitlementLabel: r.entitlement_label,
    dueOn: new Date(r.due_on),
    leadTimeDays: r.lead_time_days,
    slaTargets: r.sla_targets,
  }));
}

/** Priority PPM work is raised at. Planned by definition — that is `p4_planned`. */
const PPM_PRIORITY: JobPriority = "p4_planned";

export interface MaterialisedVisit {
  readonly visitId: string;
  readonly jobId: string;
  readonly jobReference: string;
  readonly contractReference: string;
  readonly dueOn: Date;
}

/**
 * Turn every due planned visit into a job (`CON-4`).
 *
 * The job inherits the scope, the property, the entitlement and the contract's
 * own SLA targets — `computeSlaDeadlines` has taken contract targets as a
 * parameter since `JOB-3` and nothing was passing them, so a contract that had
 * negotiated a four-hour response was still being judged against the default
 * seven days. That seam is closed here.
 *
 * `source = 'contract_ppm'` and `is_contract_covered = true` are what make the
 * job identifiable as contract work everywhere downstream: the dispatch board
 * shows the AMC chip, the invoice run skips it, and `CON-5` knows which
 * entitlement to decrement when it completes.
 *
 * Idempotent through `contract_visits.job_id`: a visit that already has a job
 * is excluded by `dueContractVisits`, and the visit is updated inside the same
 * transaction as the job insert, so a double-fired scheduler cannot produce two
 * jobs for one visit.
 */
export async function materialisePpmJobs(
  tx: TenantScopedTx,
  ctx: TenantContext,
  options: { limit?: number; now?: Date } = {},
): Promise<readonly MaterialisedVisit[]> {
  const due = await dueContractVisits(tx, options.limit ?? 500);
  if (due.length === 0) return [];

  const now = options.now ?? new Date();
  const calendar = await loadWorkingCalendar(tx);
  const created: MaterialisedVisit[] = [];

  for (const visit of due) {
    const targets = parseContractSla(visit.slaTargets);
    const { respondByAt, resolveByAt } = computeSlaDeadlines(
      PPM_PRIORITY,
      now,
      targets,
      calendar,
    );

    const referenceRows = await tx.execute<{ reference: string }>(
      sql`select app_next_reference('JOB', ${now.getFullYear()}) as reference`,
    );
    const reference = referenceRows[0]?.reference;
    if (!reference) throw new Error("Could not allocate a job reference");

    const title = `${visit.entitlementLabel ?? visit.serviceSlug} — contract visit`;

    const [job] = await tx
      .insert(schema.jobs)
      .values({
        tenantId: ctx.tenantId,
        reference,
        customerId: visit.customerId,
        propertyId: visit.propertyId,
        serviceSlug: visit.serviceSlug,
        title,
        description:
          `Planned maintenance visit under contract ${visit.contractReference}, ` +
          `due ${dubaiDay(visit.dueOn)}.`,
        status: "triaged",
        priority: PPM_PRIORITY,
        source: "contract_ppm",
        contractId: visit.contractId,
        isContractCovered: true,
        scheduledFor: visit.dueOn,
        respondByAt,
        resolveByAt,
        createdById: ctx.userId ?? null,
      })
      .returning({ id: schema.jobs.id });

    if (!job) throw new Error("Failed to create the contract visit job");

    await tx.insert(schema.jobEvents).values({
      tenantId: ctx.tenantId,
      jobId: job.id,
      fromStatus: null,
      toStatus: "triaged",
      note: `Generated from contract ${visit.contractReference} (CON-4).`,
      actorId: ctx.userId ?? null,
      actorKind: "system",
    });

    await tx
      .update(schema.contractVisits)
      .set({ jobId: job.id, status: "generated", updatedAt: now })
      .where(eq(schema.contractVisits.id, visit.visitId));

    created.push({
      visitId: visit.visitId,
      jobId: job.id,
      jobReference: reference,
      contractReference: visit.contractReference,
      dueOn: visit.dueOn,
    });
  }

  return created;
}

// ── CON-5: entitlement consumption ───────────────────────────────────────────

export interface ReconciliationResult {
  readonly completed: number;
  readonly missed: number;
}

/**
 * Close the loop between finished jobs and the schedule (`CON-5`, `CON-7`).
 *
 * Two things, run together because they are the same sweep over the same rows:
 *
 *  1. A planned visit whose job has completed becomes `completed`, and the
 *     entitlement for that service is decremented.
 *  2. A planned visit whose window has closed with no completed job becomes
 *     `missed`. That is the number `CON-7` reports and `G12` targets at 98%,
 *     and it only exists if something marks it.
 *
 * ── WHY THIS IS A SWEEP AND NOT A TRIGGER ON JOB COMPLETION ─────────────────
 *
 * Consumption could be decremented inside `transitionJob`. It is not, for two
 * reasons. A job can be completed, reopened and completed again for the same
 * fault — `jobs.parent_job_id` and `is_revisit` exist precisely because that
 * happens — and a hook on the transition would decrement twice for one owed
 * visit. And the *missed* half has no event to hang off at all: nothing happens
 * when a visit is not done. A sweep that reads the current state answers both
 * questions the same way, and re-running it changes nothing, because the visit
 * status it just wrote is what excludes the row next time.
 */
export async function reconcileContractVisits(
  tx: TenantScopedTx,
  windowDaysFallback = 7,
): Promise<ReconciliationResult> {
  // ── Completed ────────────────────────────────────────────────────────────
  const completedRows = (await tx.execute<{ id: string; contract_id: string; service_slug: string }>(sql`
    update contract_visits v
       set status = 'completed', updated_at = now()
      from jobs j
     where v.job_id = j.id
       and v.status = 'generated'
       and v.deleted_at is null
       and j.completed_at is not null
       and j.status in ('work_complete', 'signed_off', 'invoiced', 'closed')
    returning v.id, v.contract_id, coalesce(v.service_slug, '') as service_slug
  `)) as unknown as { id: string; contract_id: string; service_slug: string }[];

  // One UPDATE per (contract, service), not per visit: two visits of the same
  // service completing in one sweep are one statement, and `consumed_visits =
  // consumed_visits + n` is atomic under concurrency in a way that read-then-
  // write from the application never is.
  const perEntitlement = new Map<string, { contractId: string; serviceSlug: string; count: number }>();
  for (const row of completedRows) {
    const key = `${row.contract_id}|${row.service_slug}`;
    const entry = perEntitlement.get(key);
    if (entry) entry.count += 1;
    else perEntitlement.set(key, { contractId: row.contract_id, serviceSlug: row.service_slug, count: 1 });
  }

  for (const entry of perEntitlement.values()) {
    await tx.execute(sql`
      update contract_entitlements
         set consumed_visits = consumed_visits + ${entry.count},
             updated_at = now()
       where contract_id = ${entry.contractId}
         and service_slug = ${entry.serviceSlug}
         and deleted_at is null
    `);
  }

  // ── Missed ───────────────────────────────────────────────────────────────
  //
  // The window's far edge, not the target date. A visit due on the 15th with a
  // seven-day window is not late on the 16th — that is the entire point of a
  // window, and marking it missed a day after target would make the PPM
  // completion figure describe a schedule nobody agreed to.
  const missedRows = (await tx.execute<{ id: string }>(sql`
    update contract_visits v
       set status = 'missed', updated_at = now()
      from contracts c
     where v.contract_id = c.id
       and v.status in ('planned', 'generated')
       and v.deleted_at is null
       and c.deleted_at is null
       and v.due_on + make_interval(days => coalesce(
             (select t.ppm_window_days from contract_terms t
               where t.contract_id = c.id and t.deleted_at is null),
             ${windowDaysFallback}
           )) < now()
       -- A visit whose job is still open is late, not missed. It is counted
       -- as overdue by ppmCompliance either way; changing its status here
       -- would strand a job that is on its way to site.
       and (v.job_id is null or exists (
             select 1 from jobs j
              where j.id = v.job_id
                and j.status in ('cancelled')
           ))
    returning v.id
  `)) as unknown as { id: string }[];

  return { completed: completedRows.length, missed: missedRows.length };
}

// ── CON-6: out of scope ──────────────────────────────────────────────────────

export interface ScopeCheckInput {
  readonly serviceSlug: string;
  /** Exclusion codes the operator identified on this job. */
  readonly matchedExclusionCodes?: readonly string[];
  readonly requiresParts?: boolean;
}

/**
 * Is this work covered by the contract? (`CON-6`)
 *
 * The decision itself is `decideScope` in `packages/core` — pure, shared with
 * the portal and the field app, and testable without a database. This function
 * is the part that needs one: it loads the coverage type, the exclusion codes
 * and the remaining entitlement, and hands them over.
 *
 * The verdict is never a refusal to act. It is "this is not covered, and this
 * is the quote", at a discount the customer already agreed to — because the way
 * a comprehensive AMC becomes a loss is not fraud, it is a technician on site
 * doing the decent thing with a seized compressor and nobody raising a quote.
 */
export async function checkContractScope(
  tx: TenantScopedTx,
  contractId: string,
  input: ScopeCheckInput,
): Promise<ScopeDecision> {
  const rows = (await tx.execute<{
    coverage_type: string;
    discount_rate_basis_points: number;
    covered_services: unknown;
    exclusion_codes: string[];
    visits_per_year: number | null;
    consumed_visits: number | null;
    term_days: number;
  }>(sql`
    select t.coverage_type,
           t.discount_rate_basis_points,
           c.covered_services,
           coalesce(
             (select array_agg(x.code) from contract_exclusions x
               where x.contract_id = c.id and x.deleted_at is null),
             array[]::text[]
           ) as exclusion_codes,
           e.visits_per_year,
           e.consumed_visits,
           greatest(1, (c.ends_on::date - c.starts_on::date))::int as term_days
      from contracts c
      join contract_terms t on t.contract_id = c.id and t.deleted_at is null
      left join contract_entitlements e
             on e.contract_id = c.id
            and e.service_slug = ${input.serviceSlug}
            and e.deleted_at is null
     where c.id = ${contractId} and c.deleted_at is null
  `)) as unknown as {
    coverage_type: string;
    discount_rate_basis_points: number;
    covered_services: unknown;
    exclusion_codes: string[];
    visits_per_year: number | null;
    consumed_visits: number | null;
    term_days: number;
  }[];

  const row = rows[0];
  if (!row) throw new UserFacingError("Contract not found in this tenant.");

  const covered = Array.isArray(row.covered_services)
    ? (row.covered_services as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  // Entitlement is a per-year figure; what is left is measured over the term.
  // A two-year contract at four visits a year owes eight, and comparing
  // consumption against four would report it exhausted halfway through.
  const entitled =
    row.visits_per_year === null ? null : visitsForTerm(row.visits_per_year, row.term_days);

  const decision = decideScope({
    coverageType: row.coverage_type === "labour_only" ? "labour_only" : "comprehensive",
    coveredServices: covered,
    exclusionCodes: row.exclusion_codes ?? [],
    serviceSlug: input.serviceSlug,
    matchedExclusionCodes: input.matchedExclusionCodes ?? [],
    requiresParts: input.requiresParts ?? false,
    entitlementRemaining: entitled === null ? null : entitled - (row.consumed_visits ?? 0),
    discountBasisPoints: row.discount_rate_basis_points,
  });

  return decision;
}

export interface OutOfScopeLine {
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  /** Decimal string at rate-card price, before the contract discount. */
  readonly unitPrice: string;
}

/**
 * Raise the quote that `CON-6` requires, at the contract discount.
 *
 * The discount is computed here rather than being typed into the form, because
 * the number that must be applied is the one on the contract — a discount an
 * operator remembers is a discount that will eventually be wrong in the
 * customer's favour on a job that is already unprofitable.
 *
 * VAT is applied **after** the discount, which `computeTotals` does: tax is due
 * on what the customer actually pays.
 */
export async function quoteOutOfScopeWork(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    contractId: string;
    jobId: string;
    title: string;
    lines: readonly OutOfScopeLine[];
    scope?: ScopeCheckInput;
    validForDays?: number;
  },
): Promise<{ quoteId: string; reference: string; totalMinor: number; decision: ScopeDecision }> {
  if (input.lines.length === 0) throw new UserFacingError("A quote needs at least one line.");

  const jobRows = await tx
    .select({
      customerId: schema.jobs.customerId,
      propertyId: schema.jobs.propertyId,
      serviceSlug: schema.jobs.serviceSlug,
    })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, input.jobId))
    .limit(1);

  const job = jobRows[0];
  if (!job) throw new UserFacingError("Job not found in this tenant.");

  const decision = await checkContractScope(tx, input.contractId, {
    serviceSlug: input.scope?.serviceSlug ?? job.serviceSlug,
    ...(input.scope?.matchedExclusionCodes
      ? { matchedExclusionCodes: input.scope.matchedExclusionCodes }
      : {}),
    ...(input.scope?.requiresParts !== undefined ? { requiresParts: input.scope.requiresParts } : {}),
  });

  if (!decision.requiresQuote) {
    throw new UserFacingError(
      "This work is covered by the contract, so it must not be quoted. Raising a quote for " +
        "covered work bills a customer twice for the same entitlement.",
    );
  }

  const lineInputs = input.lines.map((l) => ({
    quantity: l.quantity,
    unitPriceMinor: toMinor(l.unitPrice),
  }));

  const grossSubtotal = computeTotals({ lines: lineInputs, taxRateBasisPoints: 0 }).subtotalMinor;
  const discountMinor = Math.round((grossSubtotal * decision.discountBasisPoints) / 10_000);

  const totals = computeTotals({
    lines: lineInputs,
    discountMinor,
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  const referenceRows = await tx.execute<{ reference: string }>(
    sql`select app_next_reference('QUO', ${new Date().getFullYear()}) as reference`,
  );
  const reference = referenceRows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a quote reference");

  const [quote] = await tx
    .insert(schema.quotes)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: job.customerId,
      propertyId: job.propertyId,
      jobId: input.jobId,
      title: input.title,
      status: "draft",
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: toDecimalString(totals.discountMinor),
      taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      validUntil: new Date(Date.now() + (input.validForDays ?? 30) * 24 * 60 * 60 * 1000),
      notes:
        `${decision.reason}\n\n` +
        `Contract discount of ${(decision.discountBasisPoints / 100).toFixed(2)}% applied.`,
      preparedById: ctx.userId ?? null,
    })
    .returning({ id: schema.quotes.id });

  if (!quote) throw new Error("Failed to create the out-of-scope quote");

  await tx.insert(schema.quoteLines).values(
    input.lines.map((l, i) => ({
      tenantId: ctx.tenantId,
      quoteId: quote.id,
      position: i + 1,
      serviceSlug: job.serviceSlug,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: toDecimalString(toMinor(l.unitPrice)),
      lineTotal: toDecimalString(
        computeTotals({ lines: [lineInputs[i]!], taxRateBasisPoints: 0 }).subtotalMinor,
      ),
    })),
  );

  // The job now carries a quote and is no longer silently contract-covered.
  // Leaving `is_contract_covered` true here is exactly how out-of-scope work
  // gets absorbed: the invoice run would skip it.
  await tx
    .update(schema.jobs)
    .set({
      quoteId: quote.id,
      isContractCovered: false,
      requiresQuoteApproval: true,
      updatedAt: new Date(),
    })
    .where(eq(schema.jobs.id, input.jobId));

  return { quoteId: quote.id, reference, totalMinor: totals.totalMinor, decision };
}

// ── CON-7: PPM compliance ────────────────────────────────────────────────────

export interface ContractPpmStatus extends PpmCompletion {
  readonly contractId: string;
  readonly reference: string;
  readonly name: string;
  readonly planned: number;
  readonly missed: number;
}

/**
 * Visits scheduled, completed and overdue, per contract (`CON-7`, `G12`).
 *
 * "Overdue" is a visit whose window has closed without a completed job —
 * whether it was marked `missed` by the sweep or is still sitting `generated`
 * with an unfinished job past its window. Both are the same fact to the person
 * asking, and reporting only the first would understate the number by exactly
 * the visits somebody is currently late on.
 */
export async function ppmCompliance(
  tx: TenantScopedTx,
  options: { contractId?: string } = {},
): Promise<readonly ContractPpmStatus[]> {
  const contractFilter = options.contractId
    ? sql`and c.id = ${options.contractId}`
    : sql``;

  const rows = (await tx.execute<{
    contract_id: string;
    reference: string;
    name: string;
    scheduled: number;
    completed: number;
    overdue: number;
    planned: number;
    missed: number;
  }>(sql`
    select c.id as contract_id,
           c.reference,
           c.name,
           count(v.id)::int as scheduled,
           count(*) filter (where v.status = 'completed')::int as completed,
           count(*) filter (
             where v.status <> 'completed'
               and v.due_on + make_interval(days => t.ppm_window_days) < now()
           )::int as overdue,
           count(*) filter (where v.status = 'planned')::int as planned,
           count(*) filter (where v.status = 'missed')::int as missed
      from contracts c
      join contract_terms t on t.contract_id = c.id and t.deleted_at is null
      left join contract_visits v on v.contract_id = c.id and v.deleted_at is null
     where c.deleted_at is null
       and c.status in ('active', 'expired', 'renewed')
       ${contractFilter}
     group by c.id, c.reference, c.name
     order by c.reference
  `)) as unknown as {
    contract_id: string;
    reference: string;
    name: string;
    scheduled: number;
    completed: number;
    overdue: number;
    planned: number;
    missed: number;
  }[];

  return rows.map((r) => ({
    contractId: r.contract_id,
    reference: r.reference,
    name: r.name,
    planned: r.planned,
    missed: r.missed,
    ...ppmCompletion({ scheduled: r.scheduled, completed: r.completed, overdue: r.overdue }),
  }));
}

// ── CON-8 / CON-9: renewal ───────────────────────────────────────────────────

export interface RenewalCandidate {
  readonly contractId: string;
  readonly reference: string;
  readonly name: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly endsOn: Date;
  /** Negative means the contract has already expired. */
  readonly daysRemaining: number;
  readonly band: RenewalBand | null;
  /** Decimal string as stored. */
  readonly annualValue: string;
  readonly currency: string;
  readonly autoRenew: boolean;
  /** Jobs raised against the contract over the term. `CON-8`. */
  readonly jobsInTerm: number;
  readonly entitledVisits: number;
  readonly consumedVisits: number;
  readonly utilisationPercent: number;
  readonly ownerUserId: string | null;
}

/**
 * Contracts inside the renewal window (`CON-8`), and the facts to renew on.
 *
 * Prior-year job count and entitlement utilisation come from the same query
 * because they are the two numbers a renewal conversation is actually about: a
 * contract at 40% utilisation is over-priced for the customer and a contract at
 * 130% is under-priced for us, and neither is visible from the contract value
 * alone.
 *
 * Already-expired contracts are included regardless of the window. They are the
 * failure `CON-9` exists to prevent — "a silently expired AMC is the most
 * expensive failure mode in this business model" — and dropping them out of the
 * pipeline the day they lapse is how they become silent.
 */
export async function renewalPipeline(
  tx: TenantScopedTx,
  withinDays = RENEWAL_PIPELINE_DAYS,
): Promise<readonly RenewalCandidate[]> {
  const rows = (await tx.execute<{
    contract_id: string;
    reference: string;
    name: string;
    customer_id: string;
    customer_name: string;
    ends_on: Date | string;
    days_remaining: number;
    annual_value: string;
    currency: string;
    auto_renew: boolean;
    jobs_in_term: number;
    entitled_visits: number;
    consumed_visits: number;
    owner_id: string | null;
    term_days: number;
  }>(sql`
    select c.id as contract_id,
           c.reference,
           c.name,
           c.customer_id,
           cu.name as customer_name,
           c.ends_on,
           (c.ends_on::date - current_date)::int as days_remaining,
           c.annual_value,
           c.currency,
           c.auto_renew,
           c.owner_id,
           greatest(1, (c.ends_on::date - c.starts_on::date))::int as term_days,
           -- Cancelled jobs excluded, and by the same rule as the callout
           -- count below, so the two numbers on the contract page cannot
           -- disagree about what a job is. A renewal priced on "34 jobs this
           -- term" when six of them were called off overstates what was
           -- delivered, and that is the number the customer checks.
           (select count(*)::int from jobs j
             where j.contract_id = c.id
               and j.status <> 'cancelled'
               and j.deleted_at is null) as jobs_in_term,
           coalesce((select sum(e.visits_per_year)::int from contract_entitlements e
                      where e.contract_id = c.id and e.deleted_at is null), 0) as entitled_visits,
           coalesce((select sum(e.consumed_visits)::int from contract_entitlements e
                      where e.contract_id = c.id and e.deleted_at is null), 0) as consumed_visits
      from contracts c
      join customers cu on cu.id = c.customer_id
     where c.deleted_at is null
       and c.status in ('active', 'expired')
       -- Expired contracts are in whatever the window is. See the note above.
       and (c.ends_on::date <= current_date + (${withinDays})::int)
     order by c.ends_on
  `)) as unknown as {
    contract_id: string;
    reference: string;
    name: string;
    customer_id: string;
    customer_name: string;
    ends_on: Date | string;
    days_remaining: number;
    annual_value: string;
    currency: string;
    auto_renew: boolean;
    jobs_in_term: number;
    entitled_visits: number;
    consumed_visits: number;
    owner_id: string | null;
    term_days: number;
  }[];

  return rows.map((r) => {
    const entitled = visitsForTerm(r.entitled_visits, r.term_days);
    return {
      contractId: r.contract_id,
      reference: r.reference,
      name: r.name,
      customerId: r.customer_id,
      customerName: r.customer_name,
      endsOn: new Date(r.ends_on),
      daysRemaining: r.days_remaining,
      band: renewalBand(r.days_remaining),
      annualValue: r.annual_value,
      currency: r.currency,
      autoRenew: r.auto_renew,
      jobsInTerm: r.jobs_in_term,
      entitledVisits: entitled,
      consumedVisits: r.consumed_visits,
      utilisationPercent: utilisationPercent(r.consumed_visits, entitled),
      ownerUserId: r.owner_id,
    };
  });
}

/**
 * Contracts due a `CON-9` reminder, and which rung.
 *
 * Thin over `renewalPipeline` on purpose: the renewal screen and the scheduled
 * reminder must be looking at the same list, or the email will name a contract
 * the pipeline does not show.
 */
export async function findExpiringContracts(
  tx: TenantScopedTx,
  withinDays = RENEWAL_PIPELINE_DAYS,
): Promise<readonly RenewalCandidate[]> {
  const pipeline = await renewalPipeline(tx, withinDays);
  return pipeline.filter((c) => c.band !== null);
}

/**
 * Has this rung already been sent to this person?
 *
 * Reads the notice ledger rather than the notification queue's time window.
 * `recentlyNotified` is a ceiling on frequency; this is a record of which rung
 * was reached, and only the second can stop a 60-day notice being re-sent as a
 * 30-day one a month later.
 */
export async function renewalNoticeSent(
  tx: TenantScopedTx,
  input: { contractId: string; band: RenewalBand; recipientUserId: string },
): Promise<boolean> {
  const rows = (await tx.execute<{ hit: boolean }>(sql`
    select exists (
      select 1 from contract_renewal_notices
       where contract_id = ${input.contractId}
         and band = ${input.band}
         and recipient_user_id = ${input.recipientUserId}::uuid
    ) as hit
  `)) as unknown as { hit: boolean }[];

  return rows[0]?.hit === true;
}

/**
 * Record that a rung was sent.
 *
 * `ON CONFLICT DO NOTHING` against the unique index, so two schedulers racing
 * produce one row and one email rather than two of each.
 */
export async function recordRenewalNotice(
  tx: TenantScopedTx,
  ctx: { tenantId: string },
  input: { contractId: string; band: RenewalBand; recipientUserId: string },
): Promise<void> {
  await tx
    .insert(schema.contractRenewalNotices)
    .values({
      tenantId: ctx.tenantId,
      contractId: input.contractId,
      band: input.band,
      recipientUserId: input.recipientUserId,
    })
    .onConflictDoNothing();
}

/**
 * Generate a renewal quote prefilled from actuals (`CON-8`).
 *
 * "From actuals" is the whole requirement. The line is the contract's own
 * annual value and its own entitlement schedule, not a number retyped from the
 * last renewal — and the notes carry the utilisation, because a renewal priced
 * without knowing whether the customer used 40% or 130% of what they bought is
 * a renewal priced from hope.
 *
 * Deliberately a draft. Nothing is sent to a customer by a scheduled job.
 */
export async function generateRenewalQuote(
  tx: TenantScopedTx,
  ctx: TenantContext,
  contractId: string,
): Promise<{ quoteId: string; reference: string; totalMinor: number }> {
  const candidates = await renewalPipeline(tx, 3650);
  const candidate = candidates.find((c) => c.contractId === contractId);
  if (!candidate) {
    throw new UserFacingError(
      "This contract is not in the renewal pipeline. Only an active or expired contract can be " +
        "renewed; a draft is edited instead.",
    );
  }

  const entitlements = await tx
    .select({
      label: schema.contractEntitlements.label,
      visitsPerYear: schema.contractEntitlements.visitsPerYear,
    })
    .from(schema.contractEntitlements)
    .where(
      and(
        eq(schema.contractEntitlements.contractId, contractId),
        isNull(schema.contractEntitlements.deletedAt),
      ),
    );

  const lineInputs = [
    { quantity: "1", unitPriceMinor: toMinor(candidate.annualValue) },
  ];
  const totals = computeTotals({ lines: lineInputs, taxRateBasisPoints: UAE_VAT_BASIS_POINTS });

  const referenceRows = await tx.execute<{ reference: string }>(
    sql`select app_next_reference('QUO', ${new Date().getFullYear()}) as reference`,
  );
  const reference = referenceRows[0]?.reference;
  if (!reference) throw new Error("Could not allocate a quote reference");

  const scheduleNote = entitlements
    .map((e) => `  ${e.label} — ${e.visitsPerYear} visit(s) per year`)
    .join("\n");

  const [quote] = await tx
    .insert(schema.quotes)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: candidate.customerId,
      title: `Renewal — ${candidate.name}`,
      status: "draft",
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: "0",
      taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      notes:
        `Renewal of contract ${candidate.reference}, expiring ${dubaiDay(candidate.endsOn)}.\n\n` +
        `Prior term: ${candidate.jobsInTerm} job(s), ` +
        `${candidate.consumedVisits} of ${candidate.entitledVisits} entitled visits used ` +
        `(${candidate.utilisationPercent}% utilisation).\n\n` +
        `Proposed schedule:\n${scheduleNote}`,
      preparedById: ctx.userId ?? null,
    })
    .returning({ id: schema.quotes.id });

  if (!quote) throw new Error("Failed to create the renewal quote");

  await tx.insert(schema.quoteLines).values({
    tenantId: ctx.tenantId,
    quoteId: quote.id,
    position: 1,
    description: `${candidate.name} — annual maintenance contract renewal`,
    quantity: "1",
    unit: "year",
    unitPrice: toDecimalString(toMinor(candidate.annualValue)),
    lineTotal: toDecimalString(totals.subtotalMinor),
  });

  return { quoteId: quote.id, reference, totalMinor: totals.totalMinor };
}

/**
 * Move contracts past their end date to `expired`.
 *
 * The `expired` status existed and nothing set it, which is the same trap
 * `expireStaleQuotes` was written for: a contract stays "active" forever, the
 * renewal pipeline never fires, and PPM visits keep materialising into jobs
 * under a term that ended in March. Warned about, never blocked.
 */
export async function expireEndedContracts(tx: TenantScopedTx): Promise<number> {
  const rows = (await tx.execute<{ id: string }>(sql`
    update contracts
       set status = 'expired', updated_at = now()
     where status = 'active'
       and deleted_at is null
       and ends_on < now()
    returning id
  `)) as unknown as { id: string }[];

  return rows.length;
}

// ── CON-10: documents ────────────────────────────────────────────────────────

export interface ContractDocumentRow {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly title: string;
  readonly storageKey: string;
  readonly version: number;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
  readonly createdAt: Date;
  /** False for a version that has been superseded by a later one. */
  readonly isCurrent: boolean;
}

/**
 * Attach a contract document (`CON-10`).
 *
 * Versioned, never overwritten. `contracts.document_storage_key` holds a single
 * key, and replacing it loses the document that was actually signed — "which
 * version of the scope annexe was in force in March" is a question a dispute
 * asks, and one key answers it with the wrong document.
 */
export async function attachContractDocument(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    contractId: string;
    kind: ContractDocumentKind;
    title: string;
    storageKey: string;
    mimeType?: string;
    sizeBytes?: number;
  },
): Promise<{ id: string; version: number }> {
  const versionRows = (await tx.execute<{ next: number }>(sql`
    select coalesce(max(version), 0) + 1 as next
      from contract_documents
     where contract_id = ${input.contractId} and kind = ${input.kind}
  `)) as unknown as { next: number }[];

  const version = versionRows[0]?.next ?? 1;

  const [row] = await tx
    .insert(schema.contractDocuments)
    .values({
      tenantId: ctx.tenantId,
      contractId: input.contractId,
      kind: input.kind,
      title: input.title,
      storageKey: input.storageKey,
      version,
      mimeType: input.mimeType ?? null,
      sizeBytes: input.sizeBytes ?? null,
      uploadedById: ctx.userId ?? null,
    })
    .returning({ id: schema.contractDocuments.id });

  if (!row) throw new Error("Could not attach the document.");
  return { id: row.id, version };
}

export async function listContractDocuments(
  tx: TenantScopedTx,
  contractId: string,
): Promise<readonly ContractDocumentRow[]> {
  const rows = (await tx.execute<{
    id: string;
    kind: string;
    title: string;
    storage_key: string;
    version: number;
    mime_type: string | null;
    size_bytes: number | null;
    created_at: Date | string;
    is_current: boolean;
  }>(sql`
    select id, kind, title, storage_key, version, mime_type, size_bytes, created_at,
           version = max(version) over (partition by kind) as is_current
      from contract_documents
     where contract_id = ${contractId} and deleted_at is null
     order by kind, version desc
  `)) as unknown as {
    id: string;
    kind: string;
    title: string;
    storage_key: string;
    version: number;
    mime_type: string | null;
    size_bytes: number | null;
    created_at: Date | string;
    is_current: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: CONTRACT_DOCUMENT_LABEL[r.kind as ContractDocumentKind] ?? r.kind,
    title: r.title,
    storageKey: r.storage_key,
    version: r.version,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    createdAt: new Date(r.created_at),
    isCurrent: r.is_current,
  }));
}

// ── Reading contracts ────────────────────────────────────────────────────────

export interface ContractRow {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly status: string;
  readonly coverageType: string;
  readonly startsOn: Date;
  readonly endsOn: Date;
  readonly daysRemaining: number;
  readonly annualValue: string;
  readonly currency: string;
  readonly billingFrequency: string;
  readonly propertyCount: number;
  readonly plannedVisits: number;
  readonly completedVisits: number;
  readonly overdueVisits: number;
}

/**
 * The contract list.
 *
 * Ordered by days remaining rather than by name, for the same reason the
 * workforce board is ordered by exposure: the list exists to be acted on, and
 * the contract about to lapse unrenewed is the row that costs most to miss.
 */
export async function listContracts(
  tx: TenantScopedTx,
  options: { includeEnded?: boolean } = {},
): Promise<readonly ContractRow[]> {
  const statusFilter = options.includeEnded
    ? sql``
    : sql`and c.status not in ('cancelled', 'renewed')`;

  const rows = (await tx.execute<{
    id: string;
    reference: string;
    name: string;
    customer_id: string;
    customer_name: string;
    status: string;
    coverage_type: string | null;
    starts_on: Date | string;
    ends_on: Date | string;
    days_remaining: number;
    annual_value: string;
    currency: string;
    billing_frequency: string;
    property_count: number;
    planned_visits: number;
    completed_visits: number;
    overdue_visits: number;
  }>(sql`
    select c.id,
           c.reference,
           c.name,
           c.customer_id,
           cu.name as customer_name,
           c.status::text as status,
           t.coverage_type,
           c.starts_on,
           c.ends_on,
           (c.ends_on::date - current_date)::int as days_remaining,
           c.annual_value,
           c.currency,
           c.billing_frequency,
           (select count(*)::int from contract_properties cp
             where cp.contract_id = c.id and cp.deleted_at is null) as property_count,
           (select count(*)::int from contract_visits v
             where v.contract_id = c.id and v.deleted_at is null
               and v.status = 'planned') as planned_visits,
           (select count(*)::int from contract_visits v
             where v.contract_id = c.id and v.deleted_at is null
               and v.status = 'completed') as completed_visits,
           (select count(*)::int from contract_visits v
             where v.contract_id = c.id and v.deleted_at is null
               and v.status <> 'completed'
               and v.due_on + make_interval(days => coalesce(t.ppm_window_days, 7)) < now()
           ) as overdue_visits
      from contracts c
      join customers cu on cu.id = c.customer_id
      left join contract_terms t on t.contract_id = c.id and t.deleted_at is null
     where c.deleted_at is null
       ${statusFilter}
     order by c.ends_on
  `)) as unknown as {
    id: string;
    reference: string;
    name: string;
    customer_id: string;
    customer_name: string;
    status: string;
    coverage_type: string | null;
    starts_on: Date | string;
    ends_on: Date | string;
    days_remaining: number;
    annual_value: string;
    currency: string;
    billing_frequency: string;
    property_count: number;
    planned_visits: number;
    completed_visits: number;
    overdue_visits: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    name: r.name,
    customerId: r.customer_id,
    customerName: r.customer_name,
    status: r.status,
    coverageType: r.coverage_type ?? "comprehensive",
    startsOn: new Date(r.starts_on),
    endsOn: new Date(r.ends_on),
    daysRemaining: r.days_remaining,
    annualValue: r.annual_value,
    currency: r.currency,
    billingFrequency: r.billing_frequency,
    propertyCount: r.property_count,
    plannedVisits: r.planned_visits,
    completedVisits: r.completed_visits,
    overdueVisits: r.overdue_visits,
  }));
}

export interface ContractEntitlementRow {
  readonly id: string;
  readonly serviceSlug: string;
  readonly label: string;
  readonly visitsPerYear: number;
  /** Over the whole term, not per year. */
  readonly entitledForTerm: number;
  readonly consumedVisits: number;
  readonly remaining: number;
}

export interface ContractVisitRow {
  readonly id: string;
  readonly propertyId: string;
  readonly propertyName: string;
  readonly serviceSlug: string | null;
  readonly dueOn: Date;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly status: string;
  readonly jobId: string | null;
  readonly jobReference: string | null;
  readonly jobStatus: string | null;
}

export interface ContractDetail {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly customerId: string;
  readonly customerName: string;
  readonly status: string;
  readonly coverageType: CoverageType;
  readonly startsOn: Date;
  readonly endsOn: Date;
  readonly daysRemaining: number;
  readonly annualValue: string;
  readonly currency: string;
  readonly billingFrequency: string;
  readonly paymentTermsDays: number;
  readonly discountRateBasisPoints: number;
  readonly calloutsPerYear: number | null;
  /**
   * Callouts entitled over the whole term, scaled from the per-year figure the
   * same way `entitledForTerm` is. Null when the contract is unlimited.
   */
  readonly calloutsForTerm: number | null;
  /**
   * Derived, never stored: jobs against this contract that did not come from
   * the PPM schedule. See the note on `callouts_per_year` in the schema for
   * why there is no counter column behind this.
   */
  readonly consumedCallouts: number;
  readonly ppmLeadTimeDays: number;
  readonly ppmWindowDays: number;
  readonly activatedAt: Date | null;
  readonly autoRenew: boolean;
  readonly slaTargets: unknown;
  readonly entitlements: readonly ContractEntitlementRow[];
  readonly exclusions: readonly {
    readonly code: string;
    readonly label: string;
    readonly description: string | null;
  }[];
  readonly properties: readonly { readonly id: string; readonly name: string; readonly area: string | null }[];
  readonly visits: readonly ContractVisitRow[];
  readonly documents: readonly ContractDocumentRow[];
  readonly completion: PpmCompletion;
  readonly jobsInTerm: number;
}

/** One contract and everything on its page. Null when the id is not this tenant's. */
export async function getContract(
  tx: TenantScopedTx,
  contractId: string,
): Promise<ContractDetail | null> {
  const headers = (await tx.execute<{
    id: string;
    reference: string;
    name: string;
    customer_id: string;
    customer_name: string;
    status: string;
    coverage_type: string;
    starts_on: Date | string;
    ends_on: Date | string;
    days_remaining: number;
    term_days: number;
    annual_value: string;
    currency: string;
    billing_frequency: string;
    payment_terms_days: number;
    discount_rate_basis_points: number;
    callouts_per_year: number | null;
    consumed_callouts: number;
    ppm_lead_time_days: number;
    ppm_window_days: number;
    activated_at: Date | string | null;
    auto_renew: boolean;
    sla_targets: unknown;
    jobs_in_term: number;
  }>(sql`
    select c.id, c.reference, c.name, c.customer_id, cu.name as customer_name,
           c.status::text as status,
           coalesce(t.coverage_type, 'comprehensive') as coverage_type,
           c.starts_on, c.ends_on,
           (c.ends_on::date - current_date)::int as days_remaining,
           greatest(1, (c.ends_on::date - c.starts_on::date))::int as term_days,
           c.annual_value, c.currency, c.billing_frequency,
           coalesce(t.payment_terms_days, 30) as payment_terms_days,
           coalesce(t.discount_rate_basis_points, 1500) as discount_rate_basis_points,
           t.callouts_per_year,
           -- CON-2 callout consumption, derived rather than counted into a
           -- column. A callout is any job against this contract that the PPM
           -- schedule did not raise. Cancelled jobs are excluded: a callout
           -- that was called off was not consumed, and a stored counter could
           -- not have known that without being decremented by hand.
           (select count(*)::int from jobs j
             where j.contract_id = c.id
               and j.source <> 'contract_ppm'
               and j.status <> 'cancelled'
               and j.deleted_at is null) as consumed_callouts,
           coalesce(t.ppm_lead_time_days, 21) as ppm_lead_time_days,
           coalesce(t.ppm_window_days, 7) as ppm_window_days,
           t.activated_at,
           c.auto_renew,
           c.sla_targets,
           -- Same rule as renewalPipeline and as the callout derivation
           -- above: a cancelled job was not work done.
           (select count(*)::int from jobs j
             where j.contract_id = c.id
               and j.status <> 'cancelled'
               and j.deleted_at is null) as jobs_in_term
      from contracts c
      join customers cu on cu.id = c.customer_id
      left join contract_terms t on t.contract_id = c.id and t.deleted_at is null
     where c.id = ${contractId} and c.deleted_at is null
  `)) as unknown as {
    id: string;
    reference: string;
    name: string;
    customer_id: string;
    customer_name: string;
    status: string;
    coverage_type: string;
    starts_on: Date | string;
    ends_on: Date | string;
    days_remaining: number;
    term_days: number;
    annual_value: string;
    currency: string;
    billing_frequency: string;
    payment_terms_days: number;
    discount_rate_basis_points: number;
    callouts_per_year: number | null;
    consumed_callouts: number;
    ppm_lead_time_days: number;
    ppm_window_days: number;
    activated_at: Date | string | null;
    auto_renew: boolean;
    sla_targets: unknown;
    jobs_in_term: number;
  }[];

  const header = headers[0];
  if (!header) return null;

  const entitlementRows = (await tx.execute<{
    id: string;
    service_slug: string;
    label: string;
    visits_per_year: number;
    consumed_visits: number;
  }>(sql`
    select id, service_slug, label, visits_per_year, consumed_visits
      from contract_entitlements
     where contract_id = ${contractId} and deleted_at is null
     order by label
  `)) as unknown as {
    id: string;
    service_slug: string;
    label: string;
    visits_per_year: number;
    consumed_visits: number;
  }[];

  const exclusionRows = (await tx.execute<{
    code: string;
    label: string;
    description: string | null;
  }>(sql`
    select code, label, description
      from contract_exclusions
     where contract_id = ${contractId} and deleted_at is null
     order by label
  `)) as unknown as { code: string; label: string; description: string | null }[];

  const propertyRows = (await tx.execute<{ id: string; name: string; area: string | null }>(sql`
    select p.id, p.name, p.area
      from contract_properties cp
      join properties p on p.id = cp.property_id
     where cp.contract_id = ${contractId} and cp.deleted_at is null
     order by p.name
  `)) as unknown as { id: string; name: string; area: string | null }[];

  const visitRows = (await tx.execute<{
    id: string;
    property_id: string;
    property_name: string;
    service_slug: string | null;
    due_on: Date | string;
    status: string;
    job_id: string | null;
    job_reference: string | null;
    job_status: string | null;
  }>(sql`
    select v.id, v.property_id, p.name as property_name, v.service_slug, v.due_on, v.status,
           v.job_id, j.reference as job_reference, j.status::text as job_status
      from contract_visits v
      join properties p on p.id = v.property_id
      left join jobs j on j.id = v.job_id
     where v.contract_id = ${contractId} and v.deleted_at is null
     order by v.due_on
  `)) as unknown as {
    id: string;
    property_id: string;
    property_name: string;
    service_slug: string | null;
    due_on: Date | string;
    status: string;
    job_id: string | null;
    job_reference: string | null;
    job_status: string | null;
  }[];

  const documents = await listContractDocuments(tx, contractId);
  const [completion] = await ppmCompliance(tx, { contractId });

  const windowMs = header.ppm_window_days * 24 * 60 * 60 * 1000;

  return {
    id: header.id,
    reference: header.reference,
    name: header.name,
    customerId: header.customer_id,
    customerName: header.customer_name,
    status: header.status,
    coverageType: header.coverage_type === "labour_only" ? "labour_only" : "comprehensive",
    startsOn: new Date(header.starts_on),
    endsOn: new Date(header.ends_on),
    daysRemaining: header.days_remaining,
    annualValue: header.annual_value,
    currency: header.currency,
    billingFrequency: header.billing_frequency,
    paymentTermsDays: header.payment_terms_days,
    discountRateBasisPoints: header.discount_rate_basis_points,
    calloutsPerYear: header.callouts_per_year,
    calloutsForTerm:
      header.callouts_per_year === null
        ? null
        : visitsForTerm(header.callouts_per_year, header.term_days),
    consumedCallouts: header.consumed_callouts,
    ppmLeadTimeDays: header.ppm_lead_time_days,
    ppmWindowDays: header.ppm_window_days,
    activatedAt: header.activated_at ? new Date(header.activated_at) : null,
    autoRenew: header.auto_renew,
    slaTargets: header.sla_targets,
    entitlements: entitlementRows.map((e) => {
      const entitled = visitsForTerm(e.visits_per_year, header.term_days);
      return {
        id: e.id,
        serviceSlug: e.service_slug,
        label: e.label,
        visitsPerYear: e.visits_per_year,
        entitledForTerm: entitled,
        consumedVisits: e.consumed_visits,
        remaining: entitled - e.consumed_visits,
      };
    }),
    exclusions: exclusionRows,
    properties: propertyRows,
    visits: visitRows.map((v) => {
      const dueOn = new Date(v.due_on);
      return {
        id: v.id,
        propertyId: v.property_id,
        propertyName: v.property_name,
        serviceSlug: v.service_slug,
        dueOn,
        windowStart: new Date(dueOn.getTime() - windowMs),
        windowEnd: new Date(dueOn.getTime() + windowMs),
        status: v.status,
        jobId: v.job_id,
        jobReference: v.job_reference,
        jobStatus: v.job_status,
      };
    }),
    documents,
    completion:
      completion ?? ppmCompletion({ scheduled: 0, completed: 0, overdue: 0 }),
    jobsInTerm: header.jobs_in_term,
  };
}

export interface ContractableProperty {
  readonly id: string;
  readonly name: string;
  readonly area: string | null;
  readonly customerId: string;
  readonly customerName: string;
  /** How many active contracts already cover it. Overlap is legal, not a bug. */
  readonly activeContracts: number;
}

/**
 * Properties a contract can be written against, with their customer.
 *
 * Exists because there is no general property listing anywhere else in the
 * domain layer — `customers.ts` has `addProperty` and nothing that reads them
 * across customers — and the contract form needs one to offer a choice.
 *
 * `activeContracts` is shown rather than used to filter. A building genuinely
 * can sit under two contracts (an AMC for the plant and a cleaning contract for
 * the common areas), so excluding covered properties would make the second one
 * impossible to write. Showing the count lets the operator notice the case
 * where it was a mistake.
 */
export async function contractableProperties(
  tx: TenantScopedTx,
): Promise<readonly ContractableProperty[]> {
  const rows = (await tx.execute<{
    id: string;
    name: string;
    area: string | null;
    customer_id: string;
    customer_name: string;
    active_contracts: number;
  }>(sql`
    select p.id, p.name, p.area, p.customer_id, c.name as customer_name,
           (select count(*)::int
              from contract_properties cp
              join contracts ct on ct.id = cp.contract_id
             where cp.property_id = p.id
               and cp.deleted_at is null
               and ct.deleted_at is null
               and ct.status = 'active') as active_contracts
      from properties p
      join customers c on c.id = p.customer_id
     where p.deleted_at is null
       and c.deleted_at is null
     order by c.name, p.name
  `)) as unknown as {
    id: string;
    name: string;
    area: string | null;
    customer_id: string;
    customer_name: string;
    active_contracts: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    area: r.area,
    customerId: r.customer_id,
    customerName: r.customer_name,
    activeContracts: r.active_contracts,
  }));
}

// ── Internals ────────────────────────────────────────────────────────────────

interface ContractCore {
  readonly id: string;
  readonly status: string;
  readonly startsOn: Date;
  readonly endsOn: Date;
  readonly ppmWindowDays: number;
}

async function loadContractCore(
  tx: TenantScopedTx,
  contractId: string,
): Promise<ContractCore | null> {
  const rows = (await tx.execute<{
    id: string;
    status: string;
    starts_on: Date | string;
    ends_on: Date | string;
    ppm_window_days: number | null;
  }>(sql`
    select c.id, c.status::text as status, c.starts_on, c.ends_on, t.ppm_window_days
      from contracts c
      left join contract_terms t on t.contract_id = c.id and t.deleted_at is null
     where c.id = ${contractId} and c.deleted_at is null
  `)) as unknown as {
    id: string;
    status: string;
    starts_on: Date | string;
    ends_on: Date | string;
    ppm_window_days: number | null;
  }[];

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    startsOn: new Date(row.starts_on),
    endsOn: new Date(row.ends_on),
    ppmWindowDays: row.ppm_window_days ?? 7,
  };
}

/**
 * `YYYY-MM-DD` in Dubai.
 *
 * `dubaiDateKey` from `packages/core`, not an `Intl` format — the same function
 * the calendar uses to look up public holidays. Two ways of naming a Dubai day
 * is two ways of disagreeing about which day a visit falls on, and the
 * disagreement would appear on the boundary hours nobody tests.
 */
function dubaiDay(instant: Date): string {
  return dubaiDateKey(instant);
}
