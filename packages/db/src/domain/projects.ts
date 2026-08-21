import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  UserFacingError,
  apportionLines,
  blockingPermits,
  canTransitionProject,
  canTransitionVariation,
  criticalSnagsBlockingCompletion,
  defectsLiabilityEnd,
  dubaiDateKey,
  InvalidProjectTransitionError,
  InvalidVariationTransitionError,
  lineTotalMinor,
  milestoneTriggerMet,
  projectMargin,
  retentionSplit,
  toDecimalString,
  toMinor,
  company,
  unitCodeFor,
  weightedCompletionPercent,
  MAX_RETENTION_BASIS_POINTS,
  UAE_VAT_BASIS_POINTS,
  type CostCategory,
  type MilestoneTrigger,
  type PermitStatus,
  type ProjectMargin,
  type ProjectStatus,
  type RetentionStage,
  type RetentionStatus,
  type SnagSeverity,
  type SnagStatus,
  type VariationState,
} from "@meridian/core";
import { writeAuditNote } from "./staff";
import { rowDate } from "./_rows";

/**
 * Projects — `PRJ-1`…`PRJ-9`.
 *
 * ── WHAT THIS MODULE ENFORCES ───────────────────────────────────────────────
 *
 * Four rules, and each one exists because breaking it costs money that is never
 * recovered:
 *
 *  1. **The status machine is enforced here, not advised here.** `PRJ-1`'s
 *     graph lives in `@meridian/core` so a browser can render the legal next
 *     steps; `transitionProject` is what actually refuses the illegal ones.
 *  2. **A project may not go on site with a required permit unapproved**
 *     (`PRJ-6`). A hard block, like the summer midday ban, because the
 *     consequence is a stop-work notice from an authority rather than an
 *     awkward conversation.
 *  3. **Practical completion cannot be recorded with open critical snags**
 *     (`PRJ-7`). Also hard, and also for a statutory-adjacent reason: a
 *     critical snag is one that makes the premises unsafe or unusable, and
 *     handing those over is not a commercial argument.
 *  4. **A reached milestone raises exactly one invoice** (`PRJ-3`). Guarded by
 *     `project_milestones.invoice_id`, checked before the reference is
 *     allocated, because a tax invoice cannot be deleted — only credited — and
 *     a credit note is a document the customer reads.
 *
 * ── AND ONE THING IT DELIBERATELY DOES NOT ──────────────────────────────────
 *
 * Retention is never released automatically. The due date is computed, the
 * chase list is produced, and the release is a person's action — because the
 * money arrives when somebody invoices for it, and a system that quietly
 * marked retention "released" on its due date would replace a chase with a
 * clean-looking report and nothing in the bank.
 */

// ── References ───────────────────────────────────────────────────────────────

async function nextProjectReference(tx: TenantScopedTx, prefix: string, year: number): Promise<string> {
  // Allocated by the database for the same reason quotes, invoices and
  // contracts are: counting rows races, and under the customer-scope policies a
  // portal read cannot see the number another customer already took. See
  // sql/reference.sql.
  const rows = (await tx.execute<{ reference: string }>(
    sql`select app_next_reference(${prefix}, ${year}) as reference`,
  )) as unknown as { reference: string }[];

  const reference = rows[0]?.reference;
  if (!reference) throw new Error(`Could not allocate a ${prefix} reference`);
  return reference;
}

/** Today, in Dubai. Every day-valued comparison in this file starts here. */
function today(): string {
  return dubaiDateKey(new Date());
}

// ── PRJ-1: creating and moving a project ─────────────────────────────────────

export interface CreateProjectInput {
  readonly customerId: string;
  readonly propertyId?: string | null;
  readonly name: string;
  readonly scope?: string | null;
  /** Decimal string as entered, e.g. "480000.00". Tax-exclusive. */
  readonly contractValue: string;
  /** `YYYY-MM-DD`. Days, never instants — see the schema header. */
  readonly startsOn?: string | null;
  readonly targetCompletionOn?: string | null;
  readonly retentionBasisPoints?: number;
  readonly defectsLiabilityDays?: number;
  readonly projectManagerId?: string | null;
}

/**
 * Create a project. Always `quoted` — the first status in the graph.
 *
 * Never created as `awarded`, even when the award is already in hand, because
 * the transition is what writes the audit entry and the audit entry is what
 * answers "when did this become ours" in a dispute. A project that starts in
 * the middle of its own status machine has no record of how it got there.
 */
export async function createProject(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: CreateProjectInput,
): Promise<{ projectId: string; reference: string }> {
  if (input.name.trim().length < 2) {
    throw new UserFacingError("Give the project a name.");
  }

  const retentionBasisPoints = input.retentionBasisPoints ?? 500;
  if (
    !Number.isInteger(retentionBasisPoints) ||
    retentionBasisPoints < 0 ||
    retentionBasisPoints > MAX_RETENTION_BASIS_POINTS
  ) {
    throw new UserFacingError(
      "Retention must be between 0 and 10 percent. A rate above that is not a term this market " +
        "uses — it is usually a percentage typed where basis points were meant.",
    );
  }

  if (
    input.startsOn &&
    input.targetCompletionOn &&
    input.targetCompletionOn < input.startsOn
  ) {
    throw new UserFacingError("The target completion date cannot be before the start date.");
  }

  // The property must belong to the customer the project is for. RLS guarantees
  // it is this tenant's; it says nothing about whose it is inside the tenant,
  // and a project against another customer's building would raise jobs at that
  // building and invoice the wrong party for them.
  if (input.propertyId) {
    const rows = await tx
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(
        and(
          eq(schema.properties.id, input.propertyId),
          eq(schema.properties.customerId, input.customerId),
          isNull(schema.properties.deletedAt),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      throw new UserFacingError("That property does not belong to this customer.");
    }
  }

  const year = Number((input.startsOn ?? today()).slice(0, 4));
  const reference = await nextProjectReference(tx, "PRJ", year);

  const [project] = await tx
    .insert(schema.projects)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: input.customerId,
      propertyId: input.propertyId ?? null,
      name: input.name.trim(),
      scope: input.scope ?? null,
      contractValue: toDecimalString(toMinor(input.contractValue)),
      status: "quoted",
      startsOn: input.startsOn ?? null,
      targetCompletionOn: input.targetCompletionOn ?? null,
      retentionBasisPoints,
      defectsLiabilityDays: input.defectsLiabilityDays ?? 365,
      projectManagerId: input.projectManagerId ?? ctx.userId ?? null,
    })
    .returning({ id: schema.projects.id });

  if (!project) throw new Error("Failed to create project");

  // Eleven characters. `audit_log.action` is varchar(16), and a longer literal
  // fails at runtime on every call rather than at compile time on none.
  await writeAuditNote(tx, ctx, {
    tableName: "projects",
    recordId: project.id,
    action: "prj_created",
    detail: { reference, name: input.name, contractValue: input.contractValue },
  });

  return { projectId: project.id, reference };
}

interface ProjectCore {
  readonly id: string;
  readonly reference: string;
  readonly customerId: string;
  readonly status: ProjectStatus;
  readonly contractValueMinor: number;
  readonly retentionBasisPoints: number;
  readonly defectsLiabilityDays: number;
  readonly practicalCompletionOn: string | null;
  readonly name: string;
}

async function loadProjectCore(tx: TenantScopedTx, projectId: string): Promise<ProjectCore | null> {
  const rows = await tx
    .select({
      id: schema.projects.id,
      reference: schema.projects.reference,
      customerId: schema.projects.customerId,
      status: schema.projects.status,
      contractValue: schema.projects.contractValue,
      retentionBasisPoints: schema.projects.retentionBasisPoints,
      defectsLiabilityDays: schema.projects.defectsLiabilityDays,
      practicalCompletionOn: schema.projects.practicalCompletionOn,
      name: schema.projects.name,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    reference: row.reference,
    customerId: row.customerId,
    status: row.status as ProjectStatus,
    contractValueMinor: toMinor(row.contractValue),
    retentionBasisPoints: row.retentionBasisPoints,
    defectsLiabilityDays: row.defectsLiabilityDays,
    practicalCompletionOn: row.practicalCompletionOn,
    name: row.name,
  };
}

export interface TransitionResult {
  readonly from: ProjectStatus;
  readonly to: ProjectStatus;
  /** Set when the transition into `practical_completion` dated the retention. */
  readonly retentionDated: number;
}

/**
 * Move a project to a new status, enforcing the graph and the two gates.
 *
 * ── THE TWO GATES ───────────────────────────────────────────────────────────
 *
 * `on_site` refuses while a permit flagged required is unapproved or expired
 * (`PRJ-6`). `practical_completion` refuses while a critical snag is open
 * (`PRJ-7`). Both are checked here rather than in the action layer for the
 * usual reason: an action is one caller, and the cron routes, the seed and a
 * future portal are others.
 *
 * ── WHAT PRACTICAL COMPLETION DOES BESIDES CHANGE A WORD ────────────────────
 *
 * It fixes the retention clock. Until this moment every retention row has a
 * null `due_on`, because the date genuinely is not knowable — it is derived
 * from a completion that has not happened. The transition writes both due
 * dates at once: the practical-completion half falls due today, the defects-
 * liability half falls due `defects_liability_days` later. Deriving them on
 * read instead would mean the chase list changed shape whenever somebody edited
 * the defects period, including for money already released.
 */
export async function transitionProject(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    projectId: string;
    to: ProjectStatus;
    note?: string | undefined;
    /** The date the client took possession. Defaults to today, in Dubai. */
    practicalCompletionOn?: string | undefined;
  },
): Promise<TransitionResult> {
  const project = await loadProjectCore(tx, input.projectId);
  // RLS makes "not found" and "belongs to another tenant" indistinguishable
  // here, which is the intended behaviour.
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  const from = project.status;
  if (!canTransitionProject(from, input.to)) throw new InvalidProjectTransitionError(from, input.to);

  if (input.to === "on_site") {
    const blocking = await blockingPermitsForProject(tx, input.projectId);
    if (blocking.length > 0) {
      throw new UserFacingError(
        `This project cannot go on site: ${blocking.length} required permit(s) are not approved — ` +
          `${blocking.map((p) => `${p.authorityLabel} ${p.permitType}`).join("; ")}. ` +
          "Working without one draws a stop-work notice from the authority, which costs the " +
          "programme far more than the wait for the approval does.",
      );
    }
  }

  const patch: Record<string, unknown> = { status: input.to, updatedAt: new Date() };
  let retentionDated = 0;

  if (input.to === "practical_completion") {
    const openCritical = await openCriticalSnags(tx, input.projectId);
    if (openCritical.length > 0) {
      throw new UserFacingError(
        `Practical completion cannot be recorded with ${openCritical.length} critical snag(s) ` +
          `still open: ${openCritical.map((s) => `#${s.sequence} ${s.locationText}`).join("; ")}. ` +
          "A critical snag is one that makes the premises unsafe or unusable, which is exactly " +
          "what practical completion certifies is not the case.",
      );
    }

    const completionOn = input.practicalCompletionOn ?? today();
    const defectsEnd = defectsLiabilityEnd(completionOn, project.defectsLiabilityDays);
    patch["practicalCompletionOn"] = completionOn;
    patch["defectsLiabilityEndsOn"] = defectsEnd;

    retentionDated = await dateRetentionOnCompletion(tx, input.projectId, completionOn, defectsEnd);
  }

  if (input.to === "closed" || input.to === "cancelled") {
    patch["closedAt"] = new Date();
  }

  await tx.update(schema.projects).set(patch).where(eq(schema.projects.id, input.projectId));

  await writeAuditNote(tx, ctx, {
    tableName: "projects",
    recordId: input.projectId,
    action: "prj_status",
    detail: { from, to: input.to, note: input.note ?? null, retentionDated },
  });

  return { from, to: input.to, retentionDated };
}

// ── PRJ-2: phases ────────────────────────────────────────────────────────────

export interface AddPhaseInput {
  readonly projectId: string;
  readonly name: string;
  readonly serviceSlug?: string | null;
  readonly plannedStartOn?: string | null;
  readonly plannedEndOn?: string | null;
  readonly weightBasisPoints?: number;
  readonly dependsOnPhaseId?: string | null;
}

/**
 * Add a phase. The sequence is allocated, not passed in.
 *
 * Passing it in would let two phases share a number, and the unique index would
 * turn that into a failed save on a form somebody had spent five minutes
 * filling. `max(sequence) + 1` inside the transaction is enough: two operators
 * adding a phase in the same second is not a race worth a counter table, and
 * the unique index still catches it if it happens.
 */
export async function addPhase(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: AddPhaseInput,
): Promise<{ phaseId: string; sequence: number }> {
  if (input.name.trim().length < 2) throw new UserFacingError("Give the phase a name.");

  const weight = input.weightBasisPoints ?? 0;
  if (!Number.isInteger(weight) || weight < 0 || weight > 10_000) {
    throw new UserFacingError("A phase weight is between 0 and 100 percent of the project.");
  }
  if (input.plannedStartOn && input.plannedEndOn && input.plannedEndOn < input.plannedStartOn) {
    throw new UserFacingError("A phase cannot end before it starts.");
  }

  const project = await loadProjectCore(tx, input.projectId);
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  // A dependency must be a phase of the same project. Across projects it would
  // be a schedule nobody can read and a cycle nobody can break.
  if (input.dependsOnPhaseId) {
    const rows = await tx
      .select({ id: schema.projectPhases.id })
      .from(schema.projectPhases)
      .where(
        and(
          eq(schema.projectPhases.id, input.dependsOnPhaseId),
          eq(schema.projectPhases.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw new UserFacingError("A phase can only depend on another phase of the same project.");
    }
  }

  const maxRows = (await tx.execute<{ next: number }>(sql`
    select coalesce(max(sequence), 0) + 1 as next
      from project_phases
     where project_id = ${input.projectId}::uuid
  `)) as unknown as { next: number }[];
  const sequence = maxRows[0]?.next ?? 1;

  const [phase] = await tx
    .insert(schema.projectPhases)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      sequence,
      name: input.name.trim(),
      serviceSlug: input.serviceSlug ?? null,
      plannedStartOn: input.plannedStartOn ?? null,
      plannedEndOn: input.plannedEndOn ?? null,
      weightBasisPoints: weight,
      dependsOnPhaseId: input.dependsOnPhaseId ?? null,
    })
    .returning({ id: schema.projectPhases.id });

  if (!phase) throw new Error("Failed to create phase");
  return { phaseId: phase.id, sequence };
}

/**
 * Record progress on a phase.
 *
 * The status is derived from the percentage rather than set beside it, so the
 * two cannot disagree. A phase at 100% marked "in progress" and a phase at 40%
 * marked "complete" are both states somebody would have to interpret, and the
 * weighted completion figure would read one of them and the board the other.
 */
export async function setPhaseProgress(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { phaseId: string; percentComplete: number; actualStartOn?: string | null },
): Promise<{ percentComplete: number; status: string }> {
  const percent = Math.round(input.percentComplete);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new UserFacingError("Progress is a percentage between 0 and 100.");
  }

  const rows = await tx
    .select({
      id: schema.projectPhases.id,
      projectId: schema.projectPhases.projectId,
      status: schema.projectPhases.status,
      actualStartOn: schema.projectPhases.actualStartOn,
    })
    .from(schema.projectPhases)
    .where(eq(schema.projectPhases.id, input.phaseId))
    .limit(1);

  const phase = rows[0];
  if (!phase) throw new UserFacingError("Phase not found in this tenant.");
  if (phase.status === "cancelled") {
    throw new UserFacingError("This phase is cancelled. Progress cannot be recorded against it.");
  }

  const status = percent >= 100 ? "complete" : percent > 0 ? "in_progress" : "planned";
  const nowDay = today();

  await tx
    .update(schema.projectPhases)
    .set({
      percentComplete: percent,
      status,
      actualStartOn:
        phase.actualStartOn ?? (percent > 0 ? (input.actualStartOn ?? nowDay) : null),
      actualEndOn: percent >= 100 ? nowDay : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.projectPhases.id, input.phaseId));

  await writeAuditNote(tx, ctx, {
    tableName: "project_phases",
    recordId: input.phaseId,
    action: "prj_progress",
    detail: { projectId: phase.projectId, percentComplete: percent, status },
  });

  return { percentComplete: percent, status };
}

/**
 * `PRJ-2`: link a job to the phase it executes.
 *
 * The job is not created here. It is created by the ordinary job path — with
 * its priority, its SLA clock, its outdoor flag and its calendar check intact —
 * and then attached. Raising it from inside this module would mean the projects
 * module owned a second, quieter way to create work, and the day the two
 * diverge is the day a project job skips the summer midday ban.
 */
export async function attachJobToPhase(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { phaseId: string; jobId: string },
): Promise<{ attached: boolean }> {
  const phaseRows = await tx
    .select({ id: schema.projectPhases.id, projectId: schema.projectPhases.projectId })
    .from(schema.projectPhases)
    .where(eq(schema.projectPhases.id, input.phaseId))
    .limit(1);

  const phase = phaseRows[0];
  if (!phase) throw new UserFacingError("Phase not found in this tenant.");

  const jobRows = await tx
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.id, input.jobId), isNull(schema.jobs.deletedAt)))
    .limit(1);
  if (jobRows.length === 0) throw new UserFacingError("Job not found in this tenant.");

  // `onConflictDoNothing` on the unique (tenant, job) index rather than a probe
  // and an insert: attaching the same job twice is a double click, not an
  // error, and the second attempt must be a no-op rather than a 500.
  const inserted = await tx
    .insert(schema.projectPhaseJobs)
    .values({
      tenantId: ctx.tenantId,
      projectId: phase.projectId,
      phaseId: input.phaseId,
      jobId: input.jobId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.projectPhaseJobs.id });

  return { attached: inserted.length > 0 };
}

// ── PRJ-3: milestone billing ─────────────────────────────────────────────────

export interface AddMilestoneInput {
  readonly projectId: string;
  readonly phaseId?: string | null;
  readonly name: string;
  /** Decimal string, tax-exclusive. */
  readonly value: string;
  readonly triggerKind: MilestoneTrigger;
  readonly triggerOn?: string | null;
  readonly triggerPercent?: number | null;
}

export async function addMilestone(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: AddMilestoneInput,
): Promise<{ milestoneId: string; sequence: number }> {
  if (input.name.trim().length < 2) throw new UserFacingError("Give the milestone a name.");

  const valueMinor = toMinor(input.value);
  if (valueMinor <= 0) {
    throw new UserFacingError("A milestone needs a value. A zero-value milestone raises no invoice.");
  }

  // Each trigger needs the field it is evaluated against, or it can never be
  // reached by anything except a person overriding it — which is a silent
  // downgrade of a date milestone into a sign-off one.
  if (input.triggerKind === "date" && !input.triggerOn) {
    throw new UserFacingError("A date-triggered milestone needs its date.");
  }
  if (
    input.triggerKind === "percent_complete" &&
    (input.triggerPercent === null ||
      input.triggerPercent === undefined ||
      input.triggerPercent < 1 ||
      input.triggerPercent > 100)
  ) {
    throw new UserFacingError(
      "A percentage-triggered milestone needs a completion percentage between 1 and 100.",
    );
  }

  const project = await loadProjectCore(tx, input.projectId);
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  const maxRows = (await tx.execute<{ next: number }>(sql`
    select coalesce(max(sequence), 0) + 1 as next
      from project_milestones
     where project_id = ${input.projectId}::uuid
  `)) as unknown as { next: number }[];
  const sequence = maxRows[0]?.next ?? 1;

  const [milestone] = await tx
    .insert(schema.projectMilestones)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      phaseId: input.phaseId ?? null,
      sequence,
      name: input.name.trim(),
      value: toDecimalString(valueMinor),
      triggerKind: input.triggerKind,
      triggerOn: input.triggerOn ?? null,
      triggerPercent: input.triggerPercent ?? null,
    })
    .returning({ id: schema.projectMilestones.id });

  if (!milestone) throw new Error("Failed to create milestone");
  return { milestoneId: milestone.id, sequence };
}

/**
 * Mark a milestone reached.
 *
 * Separate from raising the invoice, and deliberately so. The two are different
 * decisions taken by different people: a project manager certifies that the
 * milestone has been reached, and an accountant raises the tax invoice. Fusing
 * them would mean the person who can record site progress can also allocate a
 * sequential invoice number, which is both a segregation problem and the reason
 * the RBAC for the two differs.
 *
 * `date` and `percent_complete` triggers are checked against reality here.
 * `client_sign_off` cannot be — no query decides whether a client signed
 * something — so it is accepted on the recorded note, which is the honest
 * behaviour rather than a check that always passes.
 */
export async function markMilestoneReached(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { milestoneId: string; note?: string | undefined; force?: boolean },
): Promise<{ milestoneId: string; name: string; valueMinor: number }> {
  const rows = await tx
    .select({
      id: schema.projectMilestones.id,
      projectId: schema.projectMilestones.projectId,
      name: schema.projectMilestones.name,
      value: schema.projectMilestones.value,
      status: schema.projectMilestones.status,
      triggerKind: schema.projectMilestones.triggerKind,
      triggerOn: schema.projectMilestones.triggerOn,
      triggerPercent: schema.projectMilestones.triggerPercent,
    })
    .from(schema.projectMilestones)
    .where(eq(schema.projectMilestones.id, input.milestoneId))
    .limit(1);

  const milestone = rows[0];
  if (!milestone) throw new UserFacingError("Milestone not found in this tenant.");
  if (milestone.status !== "pending") {
    throw new UserFacingError(
      `This milestone is already "${milestone.status}". Only a pending milestone can be reached.`,
    );
  }

  const met = milestoneTriggerMet(
    {
      kind: milestone.triggerKind as MilestoneTrigger,
      triggerOn: milestone.triggerOn,
      triggerPercent: milestone.triggerPercent,
    },
    { today: today(), percentComplete: await projectCompletionPercent(tx, milestone.projectId) },
  );

  // `false` is a trigger the system can evaluate and which is not satisfied.
  // `null` is one it cannot judge — a client sign-off — and passes through.
  if (met === false && !input.force) {
    throw new UserFacingError(
      milestone.triggerKind === "date"
        ? `This milestone is triggered on ${milestone.triggerOn}, which has not arrived.`
        : `This milestone triggers at ${milestone.triggerPercent}% complete and the project is not there yet.`,
    );
  }

  await tx
    .update(schema.projectMilestones)
    .set({
      status: "reached",
      reachedAt: new Date(),
      reachedById: ctx.userId ?? null,
      reachedNote: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.projectMilestones.id, input.milestoneId));

  await writeAuditNote(tx, ctx, {
    tableName: "project_miles",
    recordId: input.milestoneId,
    action: "prj_reached",
    detail: {
      projectId: milestone.projectId,
      name: milestone.name,
      trigger: milestone.triggerKind,
      forced: Boolean(input.force && met === false),
      note: input.note ?? null,
    },
  });

  return {
    milestoneId: milestone.id,
    name: milestone.name,
    valueMinor: toMinor(milestone.value),
  };
}

export interface MilestoneInvoiceResult {
  readonly invoiceId: string;
  readonly reference: string;
  readonly totalMinor: number;
  readonly retentionWithheldMinor: number;
}

/**
 * `PRJ-3`: raise the invoice a reached milestone earns.
 *
 * ── WHY THIS DOES NOT CALL `createInvoiceFromJob` ───────────────────────────
 *
 * Because it cannot, and that impossibility is the requirement. That function
 * takes a job and refuses anything not signed off; a 30% mobilisation payment
 * has no job behind it and never will. The requirement names this precisely:
 * "the mechanism the current invoicing model — one job, one invoice — cannot
 * express."
 *
 * Everything else is identical to the job path, and identical on purpose. The
 * same supplier snapshot is taken at issue, the same `apportionLines`
 * distributes the VAT so the lines sum to the document exactly, the same
 * `app_next_reference` allocates the number, and the invoice is issued rather
 * than drafted — allocating a sequential number to something that may never be
 * issued puts a gap in the series, and a gap is an FTA audit flag.
 *
 * ── RETENTION IS WITHHELD HERE, NOT DEDUCTED HERE ───────────────────────────
 *
 * The invoice is raised for the **full** milestone value and the retention is
 * recorded as a claim against it (`PRJ-5`). Invoicing 95% instead would be
 * simpler and wrong twice over: it would under-declare output tax, which is due
 * on the full consideration at the tax point, and it would leave no record that
 * 5% is owed — which is precisely how retention stops being chased.
 */
export async function raiseMilestoneInvoice(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { milestoneId: string; description?: string | undefined },
): Promise<MilestoneInvoiceResult> {
  const rows = await tx
    .select({
      id: schema.projectMilestones.id,
      projectId: schema.projectMilestones.projectId,
      name: schema.projectMilestones.name,
      value: schema.projectMilestones.value,
      status: schema.projectMilestones.status,
      invoiceId: schema.projectMilestones.invoiceId,
    })
    .from(schema.projectMilestones)
    .where(eq(schema.projectMilestones.id, input.milestoneId))
    .limit(1);

  const milestone = rows[0];
  if (!milestone) throw new UserFacingError("Milestone not found in this tenant.");

  // Checked BEFORE the reference is allocated. A tax invoice cannot be deleted,
  // only credited, so the second click has to stop here rather than produce a
  // second document with a sequential number on it.
  if (milestone.invoiceId) {
    throw new UserFacingError(
      "This milestone has already been invoiced. Credit the existing invoice if it is wrong — a " +
        "second tax invoice for the same milestone is a document the customer has to reconcile.",
    );
  }
  if (milestone.status !== "reached") {
    throw new UserFacingError(
      "Record the milestone as reached before invoicing it. Invoicing work nobody has certified " +
        "is how a final account argument starts.",
    );
  }

  const project = await loadProjectCore(tx, milestone.projectId);
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  const customerRows = await tx
    .select({
      name: schema.customers.name,
      trn: schema.customers.taxRegistrationNumber,
      billingAddress: schema.customers.billingAddress,
      billingCity: schema.customers.billingCity,
      billingCountry: schema.customers.billingCountry,
      terms: schema.customers.paymentTermsDays,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, project.customerId))
    .limit(1);

  const customer = customerRows[0];
  if (!customer) throw new UserFacingError("The customer for this project could not be read.");

  const valueMinor = toMinor(milestone.value);
  const { lines: apportioned, totals } = apportionLines({
    lines: [{ quantity: "1", unitPriceMinor: valueMinor }],
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  const issuedOn = new Date();
  const termsDays = customer.terms ?? 30;
  const dueOn = new Date(issuedOn.getTime() + termsDays * 24 * 60 * 60 * 1000);
  const reference = await nextProjectReference(tx, "INV", issuedOn.getFullYear());

  // Snapshotted at issue, exactly as the job path does it. See `supplierBlock`.
  const supplier = supplierBlock();

  const recipientAddress =
    [customer.billingAddress, customer.billingCity].filter(Boolean).join(", ") || null;

  const [invoice] = await tx
    .insert(schema.invoices)
    .values({
      tenantId: ctx.tenantId,
      reference,
      documentType: "tax_invoice",
      customerId: project.customerId,
      // No job. That is the point of this function.
      jobId: null,
      status: "issued",
      issuedOn,
      dueOn,
      // The date of supply for a staged payment is the date the stage was
      // certified, which for every milestone here is the day it was reached.
      supplyDate: dubaiDateKey(issuedOn),
      subtotal: toDecimalString(totals.subtotalMinor),
      discountAmount: toDecimalString(totals.discountMinor),
      taxableAmount: toDecimalString(totals.subtotalMinor - totals.discountMinor),
      taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
      taxAmount: toDecimalString(totals.taxMinor),
      total: toDecimalString(totals.totalMinor),
      amountPaid: "0.00",
      ...supplier,
      recipientName: customer.name,
      recipientTrn: customer.trn,
      recipientAddress,
      recipientCountry: customer.billingCountry ?? "AE",
      paymentTermsDays: termsDays,
      buyerReference: project.reference,
      issuedById: ctx.userId ?? null,
    })
    .returning({ id: schema.invoices.id });

  if (!invoice) throw new Error("Failed to create milestone invoice");

  const share = apportioned[0];
  await tx.insert(schema.invoiceLines).values({
    tenantId: ctx.tenantId,
    invoiceId: invoice.id,
    position: 1,
    description:
      input.description ??
      `${project.name} (${project.reference}) — ${milestone.name}`,
    quantity: "1",
    unit: "ea",
    unitCode: unitCodeFor("ea"),
    unitPrice: toDecimalString(valueMinor),
    lineTotal: toDecimalString(share?.lineTotalMinor ?? valueMinor),
    discountAmount: toDecimalString(share?.discountMinor ?? 0),
    netAmount: toDecimalString(share?.netMinor ?? valueMinor),
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
    taxAmount: toDecimalString(share?.taxMinor ?? 0),
  });

  await tx
    .update(schema.projectMilestones)
    .set({ status: "invoiced", invoiceId: invoice.id, updatedAt: new Date() })
    .where(eq(schema.projectMilestones.id, input.milestoneId));

  const retentionWithheldMinor = await withholdRetention(tx, ctx, {
    projectId: project.id,
    invoiceId: invoice.id,
    milestoneId: milestone.id,
    netMinor: totals.subtotalMinor - totals.discountMinor,
    basisPoints: project.retentionBasisPoints,
    practicalCompletionOn: project.practicalCompletionOn,
    defectsLiabilityDays: project.defectsLiabilityDays,
  });

  await writeAuditNote(tx, ctx, {
    tableName: "invoices",
    recordId: invoice.id,
    action: "prj_invoiced",
    detail: {
      projectId: project.id,
      milestoneId: milestone.id,
      reference,
      totalMinor: totals.totalMinor,
      retentionWithheldMinor,
    },
  });

  return {
    invoiceId: invoice.id,
    reference,
    totalMinor: totals.totalMinor,
    retentionWithheldMinor,
  };
}

/**
 * The supplier identity block for a milestone invoice.
 *
 * `supplierSnapshot` in `commerce.ts` is module-private and that file is not
 * this module's to change, so this reads the same `company.ts` configuration it
 * reads. Snapshotted onto the invoice row at issue, never joined at render:
 * an invoice is a legal artefact, and reprinting a 2026 document after the
 * office moves must still show what it showed in 2026.
 *
 * Unset values stay null. `DED-000000` on a tax invoice is worse than no
 * licence line at all, and `assertPublishableIdentity` already refuses
 * placeholders in production.
 */
function supplierBlock(): {
  supplierName: string;
  supplierTrn: string | null;
  supplierAddress: string | null;
  supplierLicenceNumber: string | null;
  supplierCrNumber: string | null;
  supplierPhone: string | null;
  supplierEmail: string | null;
  supplierCountry: string;
} {
  const a = company.address;
  // Only when there is a street. "Dubai, United Arab Emirates" is a region, not
  // an address, and Article 59 asks for an address.
  const address = a.street ? [a.street, a.city, a.region, a.country].filter(Boolean).join(", ") : null;

  return {
    supplierName: company.legalName,
    supplierTrn: company.trn,
    supplierAddress: address,
    supplierLicenceNumber: company.licenceNumber,
    supplierCrNumber: company.crNumber,
    supplierPhone: company.phone,
    supplierEmail: company.email,
    supplierCountry: a.countryCode,
  };
}

// ── PRJ-4: variation orders ──────────────────────────────────────────────────

export interface RaiseVariationInput {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | null;
  /** Signed decimal string. Negative is an omission. */
  readonly value: string;
  readonly instructedBy?: string | null;
  readonly instructedOn?: string | null;
  readonly programmeImpactDays?: number;
}

/**
 * Raise a variation. Always `draft`.
 *
 * The value may be negative and that is not a validation gap: an omission is a
 * variation, it changes the final account, and recording it as an edit to the
 * contract value instead would lose the record of what was omitted — which is
 * the first thing asked about in a final account argument.
 */
export async function raiseVariation(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RaiseVariationInput,
): Promise<{ variationId: string; reference: string }> {
  if (input.title.trim().length < 2) throw new UserFacingError("Give the variation a title.");

  const valueMinor = toMinor(input.value);
  if (valueMinor === 0) {
    throw new UserFacingError(
      "A variation with no value is a note, not a variation. Record the change in value, even " +
        "when it is a reduction.",
    );
  }

  const project = await loadProjectCore(tx, input.projectId);
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  const reference = await nextProjectReference(tx, "VO", new Date().getFullYear());

  const [variation] = await tx
    .insert(schema.projectVariations)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      reference,
      title: input.title.trim(),
      description: input.description ?? null,
      value: toDecimalString(valueMinor),
      approvalState: "draft",
      instructedBy: input.instructedBy ?? null,
      instructedOn: input.instructedOn ?? null,
      programmeImpactDays: input.programmeImpactDays ?? 0,
    })
    .returning({ id: schema.projectVariations.id });

  if (!variation) throw new Error("Failed to raise variation");

  await writeAuditNote(tx, ctx, {
    tableName: "project_vars",
    recordId: variation.id,
    action: "prj_vo_raised",
    detail: { projectId: input.projectId, reference, value: input.value },
  });

  return { variationId: variation.id, reference };
}

/** Move a variation through its approval states, enforcing the graph. */
export async function decideVariation(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    variationId: string;
    to: VariationState;
    clientReference?: string | undefined;
    reason?: string | undefined;
  },
): Promise<{ from: VariationState; to: VariationState }> {
  const rows = await tx
    .select({
      id: schema.projectVariations.id,
      projectId: schema.projectVariations.projectId,
      reference: schema.projectVariations.reference,
      approvalState: schema.projectVariations.approvalState,
    })
    .from(schema.projectVariations)
    .where(eq(schema.projectVariations.id, input.variationId))
    .limit(1);

  const variation = rows[0];
  if (!variation) throw new UserFacingError("Variation not found in this tenant.");

  const from = variation.approvalState as VariationState;
  if (!canTransitionVariation(from, input.to)) {
    throw new InvalidVariationTransitionError(from, input.to);
  }

  const now = new Date();
  const patch: Record<string, unknown> = { approvalState: input.to, updatedAt: now };
  if (input.to === "submitted") patch["submittedAt"] = now;
  if (input.to === "approved" || input.to === "rejected") {
    patch["decidedAt"] = now;
    patch["decidedById"] = ctx.userId ?? null;
    patch["decisionReason"] = input.reason ?? null;
  }
  if (input.clientReference !== undefined) patch["clientReference"] = input.clientReference || null;

  // An approval with no client reference is an approval nobody can evidence
  // when the final account is argued. Warned about on screen rather than
  // refused here — a verbal instruction confirmed by email is real, and
  // refusing it would push the record out of the system entirely.
  await tx
    .update(schema.projectVariations)
    .set(patch)
    .where(eq(schema.projectVariations.id, input.variationId));

  await writeAuditNote(tx, ctx, {
    tableName: "project_vars",
    recordId: input.variationId,
    action: "prj_vo_state",
    detail: {
      projectId: variation.projectId,
      reference: variation.reference,
      from,
      to: input.to,
      clientReference: input.clientReference ?? null,
    },
  });

  return { from, to: input.to };
}

// ── PRJ-5: retention ─────────────────────────────────────────────────────────

/**
 * Withhold retention against an invoice: two rows, one per release stage.
 *
 * Idempotent through the unique index on (invoice, stage). A retry of a
 * milestone invoice — or a second call from a future path — must not withhold
 * twice, because two claims for the same money is a balance nobody can
 * reconcile against the invoice it came from.
 *
 * Due dates are set here only when practical completion has already happened,
 * which is the unusual case: retention is normally withheld months before the
 * project completes and gets its dates from `transitionProject`.
 */
export async function withholdRetention(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    projectId: string;
    invoiceId: string;
    milestoneId?: string | null;
    netMinor: number;
    basisPoints: number;
    practicalCompletionOn?: string | null;
    defectsLiabilityDays?: number;
  },
): Promise<number> {
  const split = retentionSplit(input.netMinor, input.basisPoints);
  if (split.totalMinor <= 0) return 0;

  const completion = input.practicalCompletionOn ?? null;
  const defectsEnd = completion
    ? defectsLiabilityEnd(completion, input.defectsLiabilityDays ?? 365)
    : null;

  await tx
    .insert(schema.projectRetention)
    .values([
      {
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        invoiceId: input.invoiceId,
        milestoneId: input.milestoneId ?? null,
        stage: "practical_completion",
        amount: toDecimalString(split.practicalCompletionMinor),
        basisPoints: input.basisPoints,
        status: completion ? "due" : "held",
        dueOn: completion,
      },
      {
        tenantId: ctx.tenantId,
        projectId: input.projectId,
        invoiceId: input.invoiceId,
        milestoneId: input.milestoneId ?? null,
        stage: "defects_liability",
        amount: toDecimalString(split.defectsLiabilityMinor),
        basisPoints: input.basisPoints,
        status: "held",
        dueOn: defectsEnd,
      },
    ])
    .onConflictDoNothing();

  return split.totalMinor;
}

/**
 * Fix every held retention row's due date at practical completion.
 *
 * Called from `transitionProject` and nowhere else. Only rows still `held` are
 * touched: a row already released or written off has a history, and rewriting
 * its due date would change what the ledger says happened.
 *
 * Written as one statement rather than a read and a loop because the two dates
 * are decided by the stage, and a CASE in SQL is one round trip where a loop is
 * one per invoice on a project that may have twenty.
 */
async function dateRetentionOnCompletion(
  tx: TenantScopedTx,
  projectId: string,
  completionOn: string,
  defectsEndOn: string,
): Promise<number> {
  const rows = (await tx.execute<{ id: string }>(sql`
    update project_retention
       set due_on = case
             when stage = 'practical_completion' then ${completionOn}::date
             else ${defectsEndOn}::date
           end,
           status = case
             when stage = 'practical_completion' then 'due'
             else 'held'
           end,
           updated_at = now()
     where project_id = ${projectId}::uuid
       and status = 'held'
       and deleted_at is null
    returning id
  `)) as unknown as { id: string }[];

  return rows.length;
}

export interface RetentionRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectReference: string;
  readonly projectName: string;
  readonly customerName: string;
  readonly invoiceReference: string;
  readonly stage: RetentionStage;
  readonly amountMinor: number;
  readonly status: RetentionStatus;
  readonly dueOn: string | null;
  readonly daysToDue: number | null;
  readonly lastRemindedAt: Date | null;
}

/**
 * The retention ledger for one project, or the chase list across all of them.
 *
 * ── THE `::int` TRAP THIS AVOIDS ────────────────────────────────────────────
 *
 * The amount is summed and returned as text, then converted with `Number()` in
 * TypeScript. Casting a minor-unit sum to `::int` in SQL is the bug this
 * codebase has already been bitten by: retention across a portfolio passes
 * 2,147,483,647 fils — about AED 21.5 million — and `int4` overflows mid-page
 * with an error nobody can read. `numeric` out, `Number()` in.
 */
export async function listRetention(
  tx: TenantScopedTx,
  filter: { projectId?: string; dueWithinDays?: number } = {},
): Promise<readonly RetentionRow[]> {
  const nowDay = today();

  const rows = (await tx.execute<{
    id: string;
    project_id: string;
    project_reference: string;
    project_name: string;
    customer_name: string;
    invoice_reference: string;
    stage: string;
    amount: string;
    status: string;
    due_on: string | null;
    last_reminded_at: string | null;
  }>(sql`
    select r.id,
           r.project_id,
           p.reference   as project_reference,
           p.name        as project_name,
           c.name        as customer_name,
           i.reference   as invoice_reference,
           r.stage,
           r.amount::text as amount,
           r.status,
           r.due_on::text as due_on,
           r.last_reminded_at
      from project_retention r
      join projects  p on p.id = r.project_id
      join customers c on c.id = p.customer_id
      join invoices  i on i.id = r.invoice_id
     where r.deleted_at is null
       ${filter.projectId ? sql`and r.project_id = ${filter.projectId}::uuid` : sql``}
       ${
         filter.dueWithinDays !== undefined
           ? sql`and r.status in ('held', 'due')
                 and r.due_on is not null
                 and r.due_on <= (${nowDay}::date + ${filter.dueWithinDays}::int)`
           : sql``
       }
     order by r.due_on nulls last, p.reference, r.stage
  `)) as unknown as {
    id: string;
    project_id: string;
    project_reference: string;
    project_name: string;
    customer_name: string;
    invoice_reference: string;
    stage: string;
    amount: string;
    status: string;
    due_on: string | null;
    last_reminded_at: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectReference: r.project_reference,
    projectName: r.project_name,
    customerName: r.customer_name,
    invoiceReference: r.invoice_reference,
    stage: r.stage as RetentionStage,
    amountMinor: toMinor(r.amount),
    status: r.status as RetentionStatus,
    dueOn: r.due_on,
    daysToDue:
      r.due_on === null
        ? null
        : Math.round(
            (Date.parse(`${r.due_on}T00:00:00Z`) - Date.parse(`${nowDay}T00:00:00Z`)) / 86_400_000,
          ),
    lastRemindedAt: rowDate(r.last_reminded_at),
  }));
}

/**
 * Release retention — a person's action, never a scheduled one.
 *
 * The system computes the due date and produces the chase list; it does not
 * mark the money as returned, because the money is returned when a client pays
 * it and nothing here observes that. A scheduled release would replace a chase
 * with a tidy report and an empty bank account.
 */
export async function releaseRetention(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { retentionId: string; releasedOn?: string | undefined; note?: string | undefined },
): Promise<{ amountMinor: number; stage: RetentionStage }> {
  const rows = await tx
    .select({
      id: schema.projectRetention.id,
      projectId: schema.projectRetention.projectId,
      stage: schema.projectRetention.stage,
      amount: schema.projectRetention.amount,
      status: schema.projectRetention.status,
      dueOn: schema.projectRetention.dueOn,
    })
    .from(schema.projectRetention)
    .where(eq(schema.projectRetention.id, input.retentionId))
    .limit(1);

  const retention = rows[0];
  if (!retention) throw new UserFacingError("Retention entry not found in this tenant.");
  if (retention.status === "released") {
    throw new UserFacingError("This retention has already been released.");
  }
  if (retention.status === "written_off") {
    throw new UserFacingError("This retention was written off. Reversing it is an accounting entry.");
  }
  if (!retention.dueOn) {
    throw new UserFacingError(
      "This retention has no due date yet — it is fixed when practical completion is recorded. " +
        "Releasing it now would return money before the milestone that earns it.",
    );
  }

  await tx
    .update(schema.projectRetention)
    .set({
      status: "released",
      releasedOn: input.releasedOn ?? today(),
      note: input.note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.projectRetention.id, input.retentionId));

  await writeAuditNote(tx, ctx, {
    tableName: "project_reten",
    recordId: input.retentionId,
    action: "prj_ret_rel",
    detail: {
      projectId: retention.projectId,
      stage: retention.stage,
      amount: retention.amount,
      note: input.note ?? null,
    },
  });

  return { amountMinor: toMinor(retention.amount), stage: retention.stage as RetentionStage };
}

/**
 * Record that a retention reminder has gone out.
 *
 * A timestamp rather than a ledger of rungs, unlike `contract_renewal_notices`,
 * and the asymmetry is deliberate: a renewal ladder is four different messages
 * to possibly different people, whereas a retention chase is the same message
 * to the same accounts contact until the money arrives. What matters here is
 * only "have we asked recently", which one timestamp answers.
 */
export async function markRetentionReminded(
  tx: TenantScopedTx,
  retentionIds: readonly string[],
): Promise<number> {
  if (retentionIds.length === 0) return 0;

  const result = await tx
    .update(schema.projectRetention)
    .set({ lastRemindedAt: new Date(), updatedAt: new Date() })
    .where(inArray(schema.projectRetention.id, [...retentionIds]))
    .returning({ id: schema.projectRetention.id });

  return result.length;
}

// ── PRJ-6: permits ───────────────────────────────────────────────────────────

export interface PermitRow {
  readonly id: string;
  readonly authorityId: string;
  readonly authorityCode: string;
  readonly authorityLabel: string;
  readonly permitType: string;
  readonly referenceNumber: string | null;
  readonly status: PermitStatus;
  readonly isRequired: boolean;
  readonly appliedOn: string | null;
  readonly approvedOn: string | null;
  readonly expiresOn: string | null;
  readonly feePaidMinor: number;
  readonly documentStorageKey: string | null;
}

export async function listPermits(
  tx: TenantScopedTx,
  projectId: string,
): Promise<readonly PermitRow[]> {
  const rows = await tx
    .select({
      id: schema.projectPermits.id,
      authorityId: schema.projectPermits.authorityId,
      authorityCode: schema.permitAuthorities.code,
      authorityLabel: schema.permitAuthorities.label,
      permitType: schema.projectPermits.permitType,
      referenceNumber: schema.projectPermits.referenceNumber,
      status: schema.projectPermits.status,
      isRequired: schema.projectPermits.isRequired,
      appliedOn: schema.projectPermits.appliedOn,
      approvedOn: schema.projectPermits.approvedOn,
      expiresOn: schema.projectPermits.expiresOn,
      feePaid: schema.projectPermits.feePaid,
      documentStorageKey: schema.projectPermits.documentStorageKey,
    })
    .from(schema.projectPermits)
    .innerJoin(
      schema.permitAuthorities,
      eq(schema.permitAuthorities.id, schema.projectPermits.authorityId),
    )
    .where(
      and(
        eq(schema.projectPermits.projectId, projectId),
        isNull(schema.projectPermits.deletedAt),
      ),
    )
    .orderBy(asc(schema.permitAuthorities.sortOrder), asc(schema.projectPermits.permitType));

  return rows.map((r) => ({
    id: r.id,
    authorityId: r.authorityId,
    authorityCode: r.authorityCode,
    authorityLabel: r.authorityLabel,
    permitType: r.permitType,
    referenceNumber: r.referenceNumber,
    status: r.status as PermitStatus,
    isRequired: r.isRequired,
    appliedOn: r.appliedOn,
    approvedOn: r.approvedOn,
    expiresOn: r.expiresOn,
    feePaidMinor: toMinor(r.feePaid),
    documentStorageKey: r.documentStorageKey,
  }));
}

/** The permits standing between this project and `on_site`. `PRJ-6`. */
export async function blockingPermitsForProject(
  tx: TenantScopedTx,
  projectId: string,
): Promise<readonly PermitRow[]> {
  return blockingPermits(await listPermits(tx, projectId), today());
}

export async function recordPermit(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    projectId: string;
    authorityCode: string;
    permitType: string;
    referenceNumber?: string | null;
    status?: PermitStatus;
    isRequired?: boolean;
    appliedOn?: string | null;
    approvedOn?: string | null;
    expiresOn?: string | null;
    feePaid?: string | null;
    notes?: string | null;
  },
): Promise<{ permitId: string }> {
  if (input.permitType.trim().length < 2) {
    throw new UserFacingError("Say what kind of permit this is.");
  }

  const authorityRows = await tx
    .select({ id: schema.permitAuthorities.id })
    .from(schema.permitAuthorities)
    .where(
      and(
        eq(schema.permitAuthorities.code, input.authorityCode),
        eq(schema.permitAuthorities.isActive, true),
      ),
    )
    .limit(1);

  const authority = authorityRows[0];
  // A permit whose authority is not on the list is one that cannot be grouped,
  // chased or reported on — which is what the vocabulary table exists to stop.
  if (!authority) {
    throw new UserFacingError("Choose the authority this permit is issued by.");
  }

  const status = input.status ?? "not_applied";
  // An approved permit with no expiry is the state that reads as safe forever.
  // Warned rather than refused: some approvals genuinely have no expiry, and a
  // refusal would push the record out of the register.
  const [permit] = await tx
    .insert(schema.projectPermits)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      authorityId: authority.id,
      permitType: input.permitType.trim(),
      referenceNumber: input.referenceNumber ?? null,
      status,
      isRequired: input.isRequired ?? true,
      appliedOn: input.appliedOn ?? null,
      approvedOn: input.approvedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      feePaid: toDecimalString(toMinor(input.feePaid ?? "0")),
      notes: input.notes ?? null,
    })
    .returning({ id: schema.projectPermits.id });

  if (!permit) throw new Error("Failed to record permit");

  await writeAuditNote(tx, ctx, {
    tableName: "project_perms",
    recordId: permit.id,
    action: "prj_permit",
    detail: {
      projectId: input.projectId,
      authority: input.authorityCode,
      permitType: input.permitType,
      status,
    },
  });

  return { permitId: permit.id };
}

export async function setPermitStatus(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    permitId: string;
    status: PermitStatus;
    referenceNumber?: string | null;
    approvedOn?: string | null;
    expiresOn?: string | null;
  },
): Promise<void> {
  const patch: Record<string, unknown> = { status: input.status, updatedAt: new Date() };
  if (input.referenceNumber !== undefined) patch["referenceNumber"] = input.referenceNumber || null;
  if (input.approvedOn !== undefined) patch["approvedOn"] = input.approvedOn || null;
  if (input.expiresOn !== undefined) patch["expiresOn"] = input.expiresOn || null;
  if (input.status === "applied" ) patch["appliedOn"] = sql`coalesce(applied_on, current_date)`;

  const updated = await tx
    .update(schema.projectPermits)
    .set(patch)
    .where(eq(schema.projectPermits.id, input.permitId))
    .returning({ id: schema.projectPermits.id, projectId: schema.projectPermits.projectId });

  if (updated.length === 0) throw new UserFacingError("Permit not found in this tenant.");

  await writeAuditNote(tx, ctx, {
    tableName: "project_perms",
    recordId: input.permitId,
    action: "prj_permit_st",
    detail: { status: input.status, expiresOn: input.expiresOn ?? null },
  });
}

// ── PRJ-7: snags ─────────────────────────────────────────────────────────────

export interface SnagRow {
  readonly id: string;
  readonly sequence: number;
  readonly locationText: string;
  readonly tradeCode: string;
  readonly tradeLabel: string;
  readonly severity: SnagSeverity;
  readonly description: string;
  readonly responsibleParty: string;
  readonly subcontractorName: string | null;
  readonly targetOn: string | null;
  readonly status: SnagStatus;
  readonly photoStorageKey: string | null;
  readonly closurePhotoStorageKey: string | null;
  readonly closedAt: Date | null;
}

export async function listSnags(
  tx: TenantScopedTx,
  projectId: string,
): Promise<readonly SnagRow[]> {
  const rows = await tx
    .select({
      id: schema.projectSnags.id,
      sequence: schema.projectSnags.sequence,
      locationText: schema.projectSnags.locationText,
      tradeCode: schema.snagTrades.code,
      tradeLabel: schema.snagTrades.label,
      severity: schema.projectSnags.severity,
      description: schema.projectSnags.description,
      responsibleParty: schema.projectSnags.responsibleParty,
      subcontractorName: schema.subcontractors.name,
      targetOn: schema.projectSnags.targetOn,
      status: schema.projectSnags.status,
      photoStorageKey: schema.projectSnags.photoStorageKey,
      closurePhotoStorageKey: schema.projectSnags.closurePhotoStorageKey,
      closedAt: schema.projectSnags.closedAt,
    })
    .from(schema.projectSnags)
    .innerJoin(schema.snagTrades, eq(schema.snagTrades.id, schema.projectSnags.tradeId))
    .leftJoin(
      schema.subcontractors,
      eq(schema.subcontractors.id, schema.projectSnags.subcontractorId),
    )
    .where(and(eq(schema.projectSnags.projectId, projectId), isNull(schema.projectSnags.deletedAt)))
    .orderBy(asc(schema.projectSnags.sequence));

  return rows.map((r) => ({
    id: r.id,
    sequence: r.sequence,
    locationText: r.locationText,
    tradeCode: r.tradeCode,
    tradeLabel: r.tradeLabel,
    severity: r.severity as SnagSeverity,
    description: r.description,
    responsibleParty: r.responsibleParty,
    subcontractorName: r.subcontractorName,
    targetOn: r.targetOn,
    status: r.status as SnagStatus,
    photoStorageKey: r.photoStorageKey,
    closurePhotoStorageKey: r.closurePhotoStorageKey,
    closedAt: r.closedAt,
  }));
}

/** The gate `PRJ-7` names: open critical snags on one project. */
export async function openCriticalSnags(
  tx: TenantScopedTx,
  projectId: string,
): Promise<readonly SnagRow[]> {
  return criticalSnagsBlockingCompletion(await listSnags(tx, projectId));
}

export async function raiseSnag(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    projectId: string;
    phaseId?: string | null;
    locationText: string;
    tradeCode: string;
    severity: SnagSeverity;
    description: string;
    responsibleParty?: string;
    subcontractorId?: string | null;
    targetOn?: string | null;
    photoStorageKey?: string | null;
    raisedBy?: string | null;
  },
): Promise<{ snagId: string; sequence: number }> {
  if (input.locationText.trim().length < 2) {
    throw new UserFacingError("Say where the snag is. 'Level 3, meeting room 2, east wall'.");
  }
  if (input.description.trim().length < 3) {
    throw new UserFacingError("Describe the snag. A one-word snag is one nobody can close.");
  }

  const tradeRows = await tx
    .select({ id: schema.snagTrades.id })
    .from(schema.snagTrades)
    .where(and(eq(schema.snagTrades.code, input.tradeCode), eq(schema.snagTrades.isActive, true)))
    .limit(1);

  const trade = tradeRows[0];
  if (!trade) throw new UserFacingError("Choose the trade this snag belongs to.");

  const maxRows = (await tx.execute<{ next: number }>(sql`
    select coalesce(max(sequence), 0) + 1 as next
      from project_snags
     where project_id = ${input.projectId}::uuid
  `)) as unknown as { next: number }[];
  const sequence = maxRows[0]?.next ?? 1;

  const [snag] = await tx
    .insert(schema.projectSnags)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      phaseId: input.phaseId ?? null,
      sequence,
      locationText: input.locationText.trim(),
      tradeId: trade.id,
      severity: input.severity,
      description: input.description.trim(),
      responsibleParty: input.responsibleParty ?? "us",
      subcontractorId: input.subcontractorId ?? null,
      targetOn: input.targetOn ?? null,
      photoStorageKey: input.photoStorageKey ?? null,
      raisedById: ctx.userId ?? null,
      raisedBy: input.raisedBy ?? null,
    })
    .returning({ id: schema.projectSnags.id });

  if (!snag) throw new Error("Failed to raise snag");
  return { snagId: snag.id, sequence };
}

/**
 * Close a snag with evidence.
 *
 * A closure note is required and a photograph is asked for. The note is
 * mandatory because "closed" with nothing behind it is a snag that gets raised
 * again at handover by somebody standing in front of it; the photograph is not
 * mandatory because some snags — a missing certificate, a wrong door number —
 * genuinely have nothing to photograph, and a gate with no legitimate way past
 * it is a gate somebody widens permanently.
 */
export async function closeSnag(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    snagId: string;
    closureNote: string;
    closurePhotoStorageKey?: string | null;
    status?: Extract<SnagStatus, "closed" | "rejected">;
  },
): Promise<{ status: SnagStatus }> {
  if (input.closureNote.trim().length < 3) {
    throw new UserFacingError(
      "Say what was done. A snag closed with no evidence is one that gets raised again at handover.",
    );
  }

  const rows = await tx
    .select({
      id: schema.projectSnags.id,
      projectId: schema.projectSnags.projectId,
      sequence: schema.projectSnags.sequence,
      severity: schema.projectSnags.severity,
      status: schema.projectSnags.status,
    })
    .from(schema.projectSnags)
    .where(eq(schema.projectSnags.id, input.snagId))
    .limit(1);

  const snag = rows[0];
  if (!snag) throw new UserFacingError("Snag not found in this tenant.");
  if (snag.status === "closed" || snag.status === "rejected") {
    throw new UserFacingError(`This snag is already ${snag.status}.`);
  }

  const status = input.status ?? "closed";

  await tx
    .update(schema.projectSnags)
    .set({
      status,
      closureNote: input.closureNote.trim(),
      closurePhotoStorageKey: input.closurePhotoStorageKey ?? null,
      closedAt: new Date(),
      closedById: ctx.userId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.projectSnags.id, input.snagId));

  await writeAuditNote(tx, ctx, {
    tableName: "project_snags",
    recordId: input.snagId,
    action: "prj_snag_shut",
    detail: {
      projectId: snag.projectId,
      sequence: snag.sequence,
      severity: snag.severity,
      status,
      hasPhoto: Boolean(input.closurePhotoStorageKey),
    },
  });

  return { status };
}

// ── PRJ-9: subcontractors ────────────────────────────────────────────────────

/**
 * `PRJ-9` is two halves and only one of them is this module's.
 *
 * The organisation — trade licence, liability and workmen's-compensation
 * cover, their expiries, the Law No. 7 of 2025 approval reference — is
 * `HR-19`'s `subcontractors` register, written by the HR module and watched by
 * the same compliance sweep that watches employee documents. Nothing here
 * creates one: a second register would be a second answer to "is this
 * licence current", and the second answer is always the stale one.
 *
 * What is here is the **engagement**: this organisation, this project, this
 * scope, these payment terms, this client approval.
 */

export interface SubcontractorRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly tradeSlug: string | null;
  readonly status: string;
  readonly tradeLicenceExpiresOn: string | null;
  readonly liabilityExpiresOn: string | null;
  readonly approvalReference: string | null;
  /** Engagements against projects. The one column this module contributes. */
  readonly engagements: number;
}

/**
 * The register, with this module's engagement count beside each row.
 *
 * Reads `HR-19`'s table rather than one of its own. The expiry dates come back
 * as `text` and stay strings the whole way to the screen — through a `Date`
 * they shift by the local offset, and for a trade licence that reports an
 * expired one as current, on a subcontractor about to be put on a client's site.
 */
export async function listSubcontractors(
  tx: TenantScopedTx,
): Promise<readonly SubcontractorRow[]> {
  const rows = (await tx.execute<{
    id: string;
    name: string;
    kind: string;
    trade_slug: string | null;
    status: string;
    trade_licence_expires_on: string | null;
    liability_expires_on: string | null;
    approval_reference: string | null;
    engagements: number;
  }>(sql`
    select s.id,
           s.name,
           s.kind,
           s.trade_slug,
           s.status,
           s.trade_licence_expires_on::text as trade_licence_expires_on,
           s.liability_expires_on::text as liability_expires_on,
           s.approval_reference,
           (select count(*)::int
              from project_subcontracts ps
             where ps.subcontractor_id = s.id
               and ps.deleted_at is null) as engagements
      from subcontractors s
     where s.deleted_at is null
     order by s.name
  `)) as unknown as {
    id: string;
    name: string;
    kind: string;
    trade_slug: string | null;
    status: string;
    trade_licence_expires_on: string | null;
    liability_expires_on: string | null;
    approval_reference: string | null;
    engagements: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    tradeSlug: r.trade_slug,
    status: r.status,
    tradeLicenceExpiresOn: r.trade_licence_expires_on,
    liabilityExpiresOn: r.liability_expires_on,
    approvalReference: r.approval_reference,
    engagements: Number(r.engagements),
  }));
}

/**
 * Engage a subcontractor against a project scope.
 *
 * The engagement is committed cost from the moment it is signed — it books a
 * `project_costs` row with `is_committed`, so the margin moves when the
 * commitment is made rather than when the first invoice arrives. A margin that
 * improves because a supplier is slow to invoice is a margin that reports the
 * opposite of the truth.
 */
export async function engageSubcontractor(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    projectId: string;
    subcontractorId: string;
    phaseId?: string | null;
    scope: string;
    value: string;
    paymentTermsDays?: number;
    retentionBasisPoints?: number;
    clientApprovalState?: string;
    clientApprovedOn?: string | null;
    clientApprovalReference?: string | null;
    startsOn?: string | null;
    endsOn?: string | null;
  },
): Promise<{ subcontractId: string; committedMinor: number }> {
  if (input.scope.trim().length < 3) {
    throw new UserFacingError("Say what the subcontractor is engaged to do.");
  }

  const valueMinor = toMinor(input.value);
  if (valueMinor < 0) throw new UserFacingError("A subcontract value cannot be negative.");

  const project = await loadProjectCore(tx, input.projectId);
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  const [engagement] = await tx
    .insert(schema.projectSubcontracts)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      subcontractorId: input.subcontractorId,
      phaseId: input.phaseId ?? null,
      scope: input.scope.trim(),
      value: toDecimalString(valueMinor),
      paymentTermsDays: input.paymentTermsDays ?? 30,
      retentionBasisPoints: input.retentionBasisPoints ?? 0,
      // Defaults to `pending`, never `not_required`. Dubai Law No. 7 of 2025
      // requires the employer's prior approval before subcontracting in the
      // contracting sector, and a field that defaults to "not required" is a
      // field that is always "not required".
      clientApprovalState: input.clientApprovalState ?? "pending",
      clientApprovedOn: input.clientApprovedOn ?? null,
      clientApprovalReference: input.clientApprovalReference ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
    })
    .returning({ id: schema.projectSubcontracts.id });

  if (!engagement) throw new Error("Failed to engage subcontractor");

  if (valueMinor > 0) {
    await tx.insert(schema.projectCosts).values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      phaseId: input.phaseId ?? null,
      subcontractorId: input.subcontractorId,
      category: "subcontractor",
      description: input.scope.trim().slice(0, 240),
      incurredOn: input.startsOn ?? today(),
      quantity: "1",
      unit: "ea",
      unitCost: toDecimalString(valueMinor),
      amount: toDecimalString(valueMinor),
      isCommitted: true,
      recordedById: ctx.userId ?? null,
    });
  }

  await writeAuditNote(tx, ctx, {
    tableName: "project_subs",
    recordId: engagement.id,
    action: "prj_subcon",
    detail: {
      projectId: input.projectId,
      subcontractorId: input.subcontractorId,
      value: input.value,
      clientApproval: input.clientApprovalState ?? "pending",
    },
  });

  return { subcontractId: engagement.id, committedMinor: valueMinor };
}

// ── PRJ-8: cost and margin ───────────────────────────────────────────────────

/**
 * Book a cost against the project.
 *
 * The rate is captured, not referenced. `labour_cost_rates` supplies the
 * default when none is passed, but what is stored on the row is the number that
 * was used — a historical cost that re-derives its rate on every read is a
 * historical cost that changes when somebody gives the electricians a rise, and
 * a closed project's margin must not move.
 */
export async function recordCost(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    projectId: string;
    phaseId?: string | null;
    jobId?: string | null;
    subcontractorId?: string | null;
    category: CostCategory;
    description: string;
    incurredOn?: string;
    /** Hours for labour, quantity for everything else. Decimal string. */
    quantity: string;
    unit?: string;
    /** Cost per unit. For labour, per hour. Omitted, it comes from the rate card. */
    unitCost?: string;
    /** Rate-card code to price labour from, when `unitCost` is not given. */
    labourRateCode?: string;
    isCommitted?: boolean;
    supplierReference?: string | null;
  },
): Promise<{ costId: string; amountMinor: number }> {
  if (input.description.trim().length < 2) {
    throw new UserFacingError("Say what this cost is for.");
  }

  const incurredOn = input.incurredOn ?? today();
  let unitCostMinor = input.unitCost === undefined ? null : toMinor(input.unitCost);

  if (unitCostMinor === null && input.labourRateCode) {
    unitCostMinor = await hourlyCostForDate(tx, input.labourRateCode, incurredOn);
    if (unitCostMinor === null) {
      throw new UserFacingError(
        `No labour cost rate for "${input.labourRateCode}" applied on ${incurredOn}. Add the rate ` +
          "with the date it took effect, or enter the hourly cost directly.",
      );
    }
  }

  if (unitCostMinor === null) {
    throw new UserFacingError("Give the unit cost, or a labour rate code to price it from.");
  }

  // The same `lineTotalMinor` an invoice line uses: quantity scaled to
  // thousandths, multiplied by fils, divided back and rounded exactly once. One
  // arithmetic for cost and price rather than two that can drift, and integer
  // throughout so a timesheet recomputed gives the same figure every time.
  const amountMinor = lineTotalMinor({ quantity: input.quantity, unitPriceMinor: unitCostMinor });

  const [cost] = await tx
    .insert(schema.projectCosts)
    .values({
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      phaseId: input.phaseId ?? null,
      jobId: input.jobId ?? null,
      subcontractorId: input.subcontractorId ?? null,
      category: input.category,
      description: input.description.trim(),
      incurredOn,
      quantity: input.quantity,
      unit: input.unit ?? (input.category === "labour" ? "hour" : "ea"),
      unitCost: toDecimalString(unitCostMinor),
      amount: toDecimalString(amountMinor),
      isCommitted: input.isCommitted ?? false,
      supplierReference: input.supplierReference ?? null,
      recordedById: ctx.userId ?? null,
    })
    .returning({ id: schema.projectCosts.id });

  if (!cost) throw new Error("Failed to record cost");
  return { costId: cost.id, amountMinor };
}

/**
 * The hourly cost that applied on a given day.
 *
 * Day-valued comparison in SQL against a `date` column, never a JS `Date`
 * round trip. A rate effective from 1 January compared through an instant in a
 * negative-offset zone is a rate that does not apply on its own first day.
 */
async function hourlyCostForDate(
  tx: TenantScopedTx,
  code: string,
  on: string,
): Promise<number | null> {
  const rows = (await tx.execute<{ hourly_cost: string }>(sql`
    select hourly_cost::text as hourly_cost
      from labour_cost_rates
     where code = ${code}
       and is_active
       and deleted_at is null
       and effective_from <= ${on}::date
       and (effective_to is null or effective_to >= ${on}::date)
     order by effective_from desc
     limit 1
  `)) as unknown as { hourly_cost: string }[];

  const row = rows[0];
  return row ? toMinor(row.hourly_cost) : null;
}

export interface CostBreakdown {
  readonly category: CostCategory;
  readonly actualMinor: number;
  readonly committedMinor: number;
}

export interface ProjectFinancials {
  readonly margin: ProjectMargin;
  readonly breakdown: readonly CostBreakdown[];
  /** Gross of every milestone invoice raised, VAT included. */
  readonly invoicedMinor: number;
  /** Withheld and not yet back: the number `PRJ-5` exists to keep visible. */
  readonly retentionHeldMinor: number;
}

/**
 * `PRJ-8`'s live margin, plus the breakdown behind it.
 *
 * Every sum comes back as `text` and is converted with `Number()` through
 * `toMinor`. Not `::int`: a fit-out portfolio's costs pass 2,147,483,647 fils —
 * about AED 21.5 million — and an `int4` cast overflows mid-page with an error
 * nobody can act on.
 */
export async function projectFinancials(
  tx: TenantScopedTx,
  projectId: string,
): Promise<ProjectFinancials> {
  const project = await loadProjectCore(tx, projectId);
  if (!project) throw new UserFacingError("Project not found in this tenant.");

  const variationRows = (await tx.execute<{ approved: string; unapproved: string }>(sql`
    select coalesce(sum(value) filter (where approval_state = 'approved'), 0)::text as approved,
           coalesce(sum(value) filter (where approval_state in ('draft', 'submitted')), 0)::text as unapproved
      from project_variations
     where project_id = ${projectId}::uuid
       and deleted_at is null
  `)) as unknown as { approved: string; unapproved: string }[];

  const costRows = (await tx.execute<{
    category: string;
    actual: string;
    committed: string;
  }>(sql`
    select category,
           coalesce(sum(amount) filter (where not is_committed), 0)::text as actual,
           coalesce(sum(amount) filter (where is_committed), 0)::text as committed
      from project_costs
     where project_id = ${projectId}::uuid
       and deleted_at is null
     group by category
     order by category
  `)) as unknown as { category: string; actual: string; committed: string }[];

  const moneyRows = (await tx.execute<{ invoiced: string; retention_held: string }>(sql`
    select coalesce((select sum(i.total)
                       from project_milestones m
                       join invoices i on i.id = m.invoice_id
                      where m.project_id = ${projectId}::uuid
                        and m.deleted_at is null), 0)::text as invoiced,
           coalesce((select sum(r.amount)
                       from project_retention r
                      where r.project_id = ${projectId}::uuid
                        and r.status in ('held', 'due')
                        and r.deleted_at is null), 0)::text as retention_held
  `)) as unknown as { invoiced: string; retention_held: string }[];

  const breakdown: CostBreakdown[] = costRows.map((r) => ({
    category: r.category as CostCategory,
    actualMinor: toMinor(r.actual),
    committedMinor: toMinor(r.committed),
  }));

  const margin = projectMargin({
    contractValueMinor: project.contractValueMinor,
    approvedVariationMinor: toMinor(variationRows[0]?.approved ?? "0"),
    unapprovedVariationMinor: toMinor(variationRows[0]?.unapproved ?? "0"),
    actualCostMinor: breakdown.reduce((sum, b) => sum + b.actualMinor, 0),
    committedCostMinor: breakdown.reduce((sum, b) => sum + b.committedMinor, 0),
  });

  return {
    margin,
    breakdown,
    invoicedMinor: toMinor(moneyRows[0]?.invoiced ?? "0"),
    retentionHeldMinor: toMinor(moneyRows[0]?.retention_held ?? "0"),
  };
}

// ── Reads for the screens ────────────────────────────────────────────────────

/** Weighted completion across a project's live phases. Null when unplanned. */
export async function projectCompletionPercent(
  tx: TenantScopedTx,
  projectId: string,
): Promise<number | null> {
  const rows = await tx
    .select({
      weightBasisPoints: schema.projectPhases.weightBasisPoints,
      percentComplete: schema.projectPhases.percentComplete,
      status: schema.projectPhases.status,
    })
    .from(schema.projectPhases)
    .where(
      and(eq(schema.projectPhases.projectId, projectId), isNull(schema.projectPhases.deletedAt)),
    );

  // Cancelled phases are excluded from both sides: a phase descoped mid-project
  // must not drag the percentage down for the rest of the job.
  return weightedCompletionPercent(
    rows
      .filter((r) => r.status !== "cancelled")
      .map((r) => ({ weightBasisPoints: r.weightBasisPoints, percentComplete: r.percentComplete })),
  );
}

export interface ProjectListRow {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly customerName: string;
  readonly propertyName: string | null;
  readonly status: ProjectStatus;
  readonly contractValueMinor: number;
  readonly approvedVariationMinor: number;
  readonly unapprovedVariationMinor: number;
  readonly targetCompletionOn: string | null;
  readonly percentComplete: number | null;
  readonly openCriticalSnags: number;
  readonly blockingPermits: number;
  readonly retentionHeldMinor: number;
}

/**
 * The projects board.
 *
 * One query with correlated subqueries rather than a list read followed by a
 * fan-out per project. `TD-10` is the precedent: the customers list read every
 * customer, then every open job, then every unpaid invoice, and joined them in
 * JavaScript to fill a table.
 *
 * The counts a board is read for — open critical snags, unapproved permits —
 * are the ones that decide whether a project can move, so they are here rather
 * than one click away.
 */
export async function listProjects(
  tx: TenantScopedTx,
  filter: { statuses?: readonly ProjectStatus[] } = {},
): Promise<readonly ProjectListRow[]> {
  const nowDay = today();

  const rows = (await tx.execute<{
    id: string;
    reference: string;
    name: string;
    customer_name: string;
    property_name: string | null;
    status: string;
    contract_value: string;
    approved_variations: string;
    unapproved_variations: string;
    target_completion_on: string | null;
    weight_total: number;
    weighted_earned: number;
    open_critical: number;
    blocking_permits: number;
    retention_held: string;
  }>(sql`
    select p.id,
           p.reference,
           p.name,
           c.name as customer_name,
           pr.name as property_name,
           p.status,
           p.contract_value::text as contract_value,
           coalesce((select sum(v.value) from project_variations v
                      where v.project_id = p.id and v.approval_state = 'approved'
                        and v.deleted_at is null), 0)::text as approved_variations,
           coalesce((select sum(v.value) from project_variations v
                      where v.project_id = p.id and v.approval_state in ('draft', 'submitted')
                        and v.deleted_at is null), 0)::text as unapproved_variations,
           p.target_completion_on::text as target_completion_on,
           coalesce((select sum(ph.weight_basis_points) from project_phases ph
                      where ph.project_id = p.id and ph.status <> 'cancelled'
                        and ph.deleted_at is null), 0)::int as weight_total,
           coalesce((select sum(ph.weight_basis_points * ph.percent_complete) from project_phases ph
                      where ph.project_id = p.id and ph.status <> 'cancelled'
                        and ph.deleted_at is null), 0)::bigint as weighted_earned,
           (select count(*)::int from project_snags s
             where s.project_id = p.id and s.severity = 'critical'
               and s.status in ('open', 'in_progress') and s.deleted_at is null) as open_critical,
           (select count(*)::int from project_permits pm
             where pm.project_id = p.id and pm.is_required and pm.deleted_at is null
               and (pm.status <> 'approved'
                    or (pm.expires_on is not null and pm.expires_on < ${nowDay}::date))) as blocking_permits,
           coalesce((select sum(r.amount) from project_retention r
                      where r.project_id = p.id and r.status in ('held', 'due')
                        and r.deleted_at is null), 0)::text as retention_held
      from projects p
      join customers c on c.id = p.customer_id
      left join properties pr on pr.id = p.property_id
     where p.deleted_at is null
       ${
         filter.statuses && filter.statuses.length > 0
           ? sql`and p.status = any(${sql`array[${sql.join(
               filter.statuses.map((s) => sql`${s}`),
               sql`, `,
             )}]::text[]`})`
           : sql``
       }
     order by p.status, p.target_completion_on nulls last, p.reference
  `)) as unknown as {
    id: string;
    reference: string;
    name: string;
    customer_name: string;
    property_name: string | null;
    status: string;
    contract_value: string;
    approved_variations: string;
    unapproved_variations: string;
    target_completion_on: string | null;
    weight_total: number;
    weighted_earned: number;
    open_critical: number;
    blocking_permits: number;
    retention_held: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    name: r.name,
    customerName: r.customer_name,
    propertyName: r.property_name,
    status: r.status as ProjectStatus,
    contractValueMinor: toMinor(r.contract_value),
    approvedVariationMinor: toMinor(r.approved_variations),
    unapprovedVariationMinor: toMinor(r.unapproved_variations),
    targetCompletionOn: r.target_completion_on,
    // `weighted_earned` comes back as bigint, which postgres-js hands over as a
    // string. Number() it rather than trusting the declared type — the type
    // parameter on `execute` is an assertion, not a check.
    percentComplete:
      Number(r.weight_total) > 0
        ? Math.round(Number(r.weighted_earned) / Number(r.weight_total))
        : null,
    openCriticalSnags: Number(r.open_critical),
    blockingPermits: Number(r.blocking_permits),
    retentionHeldMinor: toMinor(r.retention_held),
  }));
}

export interface PhaseRow {
  readonly id: string;
  readonly sequence: number;
  readonly name: string;
  readonly serviceSlug: string | null;
  readonly plannedStartOn: string | null;
  readonly plannedEndOn: string | null;
  readonly weightBasisPoints: number;
  readonly percentComplete: number;
  readonly status: string;
  readonly dependsOnPhaseId: string | null;
  readonly jobCount: number;
}

export interface MilestoneRow {
  readonly id: string;
  readonly sequence: number;
  readonly name: string;
  readonly valueMinor: number;
  readonly triggerKind: MilestoneTrigger;
  readonly triggerOn: string | null;
  readonly triggerPercent: number | null;
  readonly status: string;
  readonly reachedAt: Date | null;
  readonly invoiceId: string | null;
  readonly invoiceReference: string | null;
  /** True / false / null, where null means only a person can decide. */
  readonly triggerMet: boolean | null;
}

export interface VariationRow {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly valueMinor: number;
  readonly approvalState: VariationState;
  readonly instructedBy: string | null;
  readonly instructedOn: string | null;
  readonly clientReference: string | null;
  readonly programmeImpactDays: number;
}

export interface ProjectDetail {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly scope: string | null;
  readonly status: ProjectStatus;
  readonly customerId: string;
  readonly customerName: string;
  readonly propertyName: string | null;
  readonly contractValueMinor: number;
  readonly retentionBasisPoints: number;
  readonly defectsLiabilityDays: number;
  readonly startsOn: string | null;
  readonly targetCompletionOn: string | null;
  readonly practicalCompletionOn: string | null;
  readonly defectsLiabilityEndsOn: string | null;
  readonly projectManagerName: string | null;
  readonly percentComplete: number | null;
  readonly phases: readonly PhaseRow[];
  readonly milestones: readonly MilestoneRow[];
  readonly variations: readonly VariationRow[];
  readonly permits: readonly PermitRow[];
  readonly snags: readonly SnagRow[];
  readonly retention: readonly RetentionRow[];
  readonly financials: ProjectFinancials;
}

/** Everything the project detail screen renders, in one place. */
export async function getProject(
  tx: TenantScopedTx,
  projectId: string,
): Promise<ProjectDetail | null> {
  const headerRows = await tx
    .select({
      id: schema.projects.id,
      reference: schema.projects.reference,
      name: schema.projects.name,
      scope: schema.projects.scope,
      status: schema.projects.status,
      customerId: schema.projects.customerId,
      customerName: schema.customers.name,
      propertyName: schema.properties.name,
      contractValue: schema.projects.contractValue,
      retentionBasisPoints: schema.projects.retentionBasisPoints,
      defectsLiabilityDays: schema.projects.defectsLiabilityDays,
      startsOn: schema.projects.startsOn,
      targetCompletionOn: schema.projects.targetCompletionOn,
      practicalCompletionOn: schema.projects.practicalCompletionOn,
      defectsLiabilityEndsOn: schema.projects.defectsLiabilityEndsOn,
      projectManagerName: schema.users.fullName,
    })
    .from(schema.projects)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.projects.customerId))
    .leftJoin(schema.properties, eq(schema.properties.id, schema.projects.propertyId))
    .leftJoin(schema.users, eq(schema.users.id, schema.projects.projectManagerId))
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);

  const header = headerRows[0];
  if (!header) return null;

  const phaseRows = (await tx.execute<{
    id: string;
    sequence: number;
    name: string;
    service_slug: string | null;
    planned_start_on: string | null;
    planned_end_on: string | null;
    weight_basis_points: number;
    percent_complete: number;
    status: string;
    depends_on_phase_id: string | null;
    job_count: number;
  }>(sql`
    select ph.id,
           ph.sequence,
           ph.name,
           ph.service_slug,
           ph.planned_start_on::text as planned_start_on,
           ph.planned_end_on::text as planned_end_on,
           ph.weight_basis_points,
           ph.percent_complete,
           ph.status,
           ph.depends_on_phase_id,
           (select count(*)::int from project_phase_jobs j where j.phase_id = ph.id) as job_count
      from project_phases ph
     where ph.project_id = ${projectId}::uuid
       and ph.deleted_at is null
     order by ph.sequence
  `)) as unknown as {
    id: string;
    sequence: number;
    name: string;
    service_slug: string | null;
    planned_start_on: string | null;
    planned_end_on: string | null;
    weight_basis_points: number;
    percent_complete: number;
    status: string;
    depends_on_phase_id: string | null;
    job_count: number;
  }[];

  const phases: PhaseRow[] = phaseRows.map((r) => ({
    id: r.id,
    sequence: r.sequence,
    name: r.name,
    serviceSlug: r.service_slug,
    plannedStartOn: r.planned_start_on,
    plannedEndOn: r.planned_end_on,
    weightBasisPoints: r.weight_basis_points,
    percentComplete: r.percent_complete,
    status: r.status,
    dependsOnPhaseId: r.depends_on_phase_id,
    jobCount: Number(r.job_count),
  }));

  const percentComplete = weightedCompletionPercent(
    phases
      .filter((p) => p.status !== "cancelled")
      .map((p) => ({ weightBasisPoints: p.weightBasisPoints, percentComplete: p.percentComplete })),
  );

  const milestoneRows = await tx
    .select({
      id: schema.projectMilestones.id,
      sequence: schema.projectMilestones.sequence,
      name: schema.projectMilestones.name,
      value: schema.projectMilestones.value,
      triggerKind: schema.projectMilestones.triggerKind,
      triggerOn: schema.projectMilestones.triggerOn,
      triggerPercent: schema.projectMilestones.triggerPercent,
      status: schema.projectMilestones.status,
      reachedAt: schema.projectMilestones.reachedAt,
      invoiceId: schema.projectMilestones.invoiceId,
      invoiceReference: schema.invoices.reference,
    })
    .from(schema.projectMilestones)
    .leftJoin(schema.invoices, eq(schema.invoices.id, schema.projectMilestones.invoiceId))
    .where(
      and(
        eq(schema.projectMilestones.projectId, projectId),
        isNull(schema.projectMilestones.deletedAt),
      ),
    )
    .orderBy(asc(schema.projectMilestones.sequence));

  const nowDay = today();
  const milestones: MilestoneRow[] = milestoneRows.map((r) => ({
    id: r.id,
    sequence: r.sequence,
    name: r.name,
    valueMinor: toMinor(r.value),
    triggerKind: r.triggerKind as MilestoneTrigger,
    triggerOn: r.triggerOn,
    triggerPercent: r.triggerPercent,
    status: r.status,
    reachedAt: r.reachedAt,
    invoiceId: r.invoiceId,
    invoiceReference: r.invoiceReference,
    triggerMet: milestoneTriggerMet(
      {
        kind: r.triggerKind as MilestoneTrigger,
        triggerOn: r.triggerOn,
        triggerPercent: r.triggerPercent,
      },
      { today: nowDay, percentComplete },
    ),
  }));

  const variationRows = await tx
    .select({
      id: schema.projectVariations.id,
      reference: schema.projectVariations.reference,
      title: schema.projectVariations.title,
      value: schema.projectVariations.value,
      approvalState: schema.projectVariations.approvalState,
      instructedBy: schema.projectVariations.instructedBy,
      instructedOn: schema.projectVariations.instructedOn,
      clientReference: schema.projectVariations.clientReference,
      programmeImpactDays: schema.projectVariations.programmeImpactDays,
    })
    .from(schema.projectVariations)
    .where(
      and(
        eq(schema.projectVariations.projectId, projectId),
        isNull(schema.projectVariations.deletedAt),
      ),
    )
    .orderBy(desc(schema.projectVariations.createdAt));

  return {
    id: header.id,
    reference: header.reference,
    name: header.name,
    scope: header.scope,
    status: header.status as ProjectStatus,
    customerId: header.customerId,
    customerName: header.customerName,
    propertyName: header.propertyName,
    contractValueMinor: toMinor(header.contractValue),
    retentionBasisPoints: header.retentionBasisPoints,
    defectsLiabilityDays: header.defectsLiabilityDays,
    startsOn: header.startsOn,
    targetCompletionOn: header.targetCompletionOn,
    practicalCompletionOn: header.practicalCompletionOn,
    defectsLiabilityEndsOn: header.defectsLiabilityEndsOn,
    projectManagerName: header.projectManagerName,
    percentComplete,
    phases,
    milestones,
    variations: variationRows.map((r) => ({
      id: r.id,
      reference: r.reference,
      title: r.title,
      valueMinor: toMinor(r.value),
      approvalState: r.approvalState as VariationState,
      instructedBy: r.instructedBy,
      instructedOn: r.instructedOn,
      clientReference: r.clientReference,
      programmeImpactDays: r.programmeImpactDays,
    })),
    permits: await listPermits(tx, projectId),
    snags: await listSnags(tx, projectId),
    retention: await listRetention(tx, { projectId }),
    financials: await projectFinancials(tx, projectId),
  };
}

/** The vocabularies the project screens' pickers are filled from. */
export async function projectVocabularies(tx: TenantScopedTx): Promise<{
  readonly snagTrades: readonly { id: string; code: string; label: string }[];
  readonly permitAuthorities: readonly { id: string; code: string; label: string }[];
}> {
  const trades = await tx
    .select({
      id: schema.snagTrades.id,
      code: schema.snagTrades.code,
      label: schema.snagTrades.label,
    })
    .from(schema.snagTrades)
    .where(eq(schema.snagTrades.isActive, true))
    .orderBy(asc(schema.snagTrades.sortOrder));

  const authorities = await tx
    .select({
      id: schema.permitAuthorities.id,
      code: schema.permitAuthorities.code,
      label: schema.permitAuthorities.label,
    })
    .from(schema.permitAuthorities)
    .where(eq(schema.permitAuthorities.isActive, true))
    .orderBy(asc(schema.permitAuthorities.sortOrder));

  return { snagTrades: trades, permitAuthorities: authorities };
}
