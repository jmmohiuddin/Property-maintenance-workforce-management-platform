import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  UserFacingError,
  apportionLines,
  blockingPermits,
  canTransitionProject,
  canTransitionSubcontractApproval,
  canTransitionVariation,
  computeSlaDeadlines,
  criticalSnagsBlockingCompletion,
  defectsLiabilityEnd,
  dubaiDateKey,
  InvalidProjectTransitionError,
  InvalidSubcontractApprovalTransitionError,
  InvalidVariationTransitionError,
  lineTotalMinor,
  milestoneTriggerMet,
  projectMargin,
  PROJECT_STATUS_LABEL,
  retentionSplit,
  toDecimalString,
  toMinor,
  company,
  unitCodeFor,
  weightedCompletionPercent,
  MAX_RETENTION_BASIS_POINTS,
  UAE_VAT_BASIS_POINTS,
  type CostCategory,
  type JobPriority,
  type MilestoneTrigger,
  type PermitStatus,
  type ProjectMargin,
  type ProjectStatus,
  type RetentionStage,
  type RetentionStatus,
  type SnagSeverity,
  type SnagStatus,
  type SubcontractApproval,
  type VariationState,
} from "@meridian/core";
import { writeAuditNote } from "./staff";
// PRJ-2 raises its jobs through the ordinary job path rather than around it:
// the reference allocator and the stored working calendar, both imported here
// so that a project job is indistinguishable from any other job downstream.
import { nextJobReference } from "./jobs";
import { loadWorkingCalendar } from "./reference";
import { getUpload } from "./uploads";
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
    // ── AND WHY THERE IS NO EQUIVALENT BLOCK FOR `PRJ-9` HERE ────────────────
    //
    // `listUnapprovedSubcontracts` reports engagements exactly as unlawful as
    // an unapproved permit — Dubai Law No. 7 of 2025 requires the employer's
    // PRIOR approval before subcontracting, and an engagement whose
    // `starts_on` has passed while approval sits `pending` is already on the
    // wrong side of that line. It was tempting to refuse this transition on
    // the same grounds `blockingPermitsForProject` does above. It stays a
    // chase, not a block, for three reasons that together are not close:
    //
    //  1. **The requirement itself distinguishes them.** `PRJ-6`'s row in the
    //     spec reads "a project MAY NOT enter `on_site`..."; `PRJ-7`'s reads
    //     "practical completion CANNOT be recorded...". `PRJ-9`'s row
    //     describes the register and cites the law; it contains no such
    //     instruction. The two hard blocks in this function are where the
    //     spec used that language. This is not the third one by omission.
    //  2. **Whether the law reaches this business at all is an open question
    //     the spec itself has not answered.** `OPEN-3` — its own
    //     highest-priority unknown — is exactly this: whether a small
    //     technical-services/maintenance contractor is in scope, and whether
    //     "technical personnel" reaches a tradesman or only an engineer. A
    //     hard refusal that can stop dispatchable site work should not be
    //     built on an inference the people who wrote the requirement have
    //     flagged as unresolved.
    //  3. **There is no point of action to put it at, the way there is for
    //     `PRJ-6`.** A required permit is either approved or it is not, at the
    //     moment this function is called, which is precisely when the project
    //     record is asked to say "we are on site". A subcontractor starting
    //     work without approval is a fact about the calendar, discovered by a
    //     daily sweep long after the one call site that could have refused it
    //     — `engageSubcontractor` — already ran, often with a future
    //     `starts_on` that was entirely lawful at the time. Blocking
    //     `engageSubcontractor` itself would not fix that; it would only make
    //     the system unable to honestly *record* a violation that has already
    //     happened in the physical world, which is the one thing a chase list
    //     must never do to the state it is chasing.
    //
    // This is the same shape of argument `assessWpsCycle` makes in
    // `@meridian/core` for why late wages do not become a fourth dispatch
    // block: the one consequence in force today is not enforced through this
    // system's own doors, so the refusal belongs where it can actually act —
    // here, that is an operations manager reading the chase list and getting
    // the letter signed, or standing the crew down, not a status transition
    // refusing to save. `decideSubcontractApproval` exists so that, once they
    // have the letter, there is finally somewhere to put it.
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

/**
 * Project statuses a phase job may not be raised against.
 *
 * Read `ALL_PROJECT_STATUSES` and `PROJECT_TRANSITIONS` beside this list. Three
 * of the nine are refused and the other six are deliberately allowed:
 *
 *  * `quoted` is a tender being priced. Nothing has been won, nobody has been
 *    instructed, and `projects.property_id` is routinely still null at this
 *    point precisely because the unit is not identified yet. A job raised here
 *    would put a dispatchable, SLA-clocked instruction on the board for work no
 *    customer has asked for — and the SLA clock, once started, is reported on.
 *  * `closed` and `cancelled` are the two terminal states in the transition
 *    machine: nothing moves out of either. Work raised against them is work
 *    that can never be reported against a live project again, and the honest
 *    answer to "we found more to do on a closed project" is a new project or a
 *    variation, not a job attached to a finished one.
 *
 * And the six that are allowed, because each produces real daily work:
 *
 *  * `awarded` and `mobilising` produce site setup, hoarding, permits chasing
 *    and surveys. Waiting for `on_site` would mean the work that *gets* a
 *    project on site is the only work the system cannot express, which is how
 *    it ends up raised as an unattached ad-hoc job instead.
 *  * `on_site` and `snagging` are the obvious ones.
 *  * `practical_completion` and `defects_liability` produce defect
 *    rectification, and that is exactly the work the retention withheld under
 *    `PRJ-5` is being held against. Refusing it here would push the most
 *    financially consequential jobs on the project off the phase they belong
 *    to.
 */
const PHASE_JOBS_REFUSED_IN: readonly ProjectStatus[] = ["quoted", "closed", "cancelled"];

/**
 * The priority a phase job is raised at when the caller does not say.
 *
 * Planned, because a phase is a plan. Construction work raised from a
 * programme is scheduled work with a date on it, not a fault reported by a
 * tenant, and giving it a P2 clock by default would fill the SLA board with
 * breaches that describe nothing.
 */
const DEFAULT_PHASE_JOB_PRIORITY: JobPriority = "p4_planned";

export interface RaiseJobForPhaseInput {
  readonly phaseId: string;
  readonly title: string;
  readonly description?: string | null;
  /** Defaults to `p4_planned`. See `DEFAULT_PHASE_JOB_PRIORITY`. */
  readonly priority?: JobPriority | undefined;
  /** Defaults to the phase's own trade — that is what "assigned trades" means. */
  readonly serviceSlug?: string | null | undefined;
  readonly scheduledFor?: Date | null | undefined;
  /**
   * Whether the work is in direct sun. Defaults to **true**; see the function
   * comment for why the default leans that way.
   */
  readonly isOutdoor?: boolean | undefined;
}

export interface RaisedPhaseJob {
  readonly jobId: string;
  readonly reference: string;
  /** False when the job was somehow already linked. See `attachJobToPhase`. */
  readonly attached: boolean;
}

/**
 * `PRJ-2`, second half: a phase produces `Job`s for daily execution.
 *
 * Phases, weights and dependencies have existed since `PRJ-2` was first built
 * and `attachJobToPhase` has existed alongside them — but nothing ever called
 * it, so no phase had ever produced a job and every job count on the phase
 * table rendered a truthful, useless zero. This is the function that closes
 * that, and almost all of its length is about *not* being a second way to
 * create a job.
 *
 * ── THE JOB IS CREATED THE ORDINARY WAY, AND THAT IS THE POINT ─────────────
 *
 * The tempting implementation is an `insert(schema.jobs)` with whatever columns
 * the projects screen happens to need. It was found this week that exactly that
 * shortcut on the web assignment path had been silently skipping the summer
 * midday ban, which carries AED 5,000 per worker, capped at AED 50,000, plus a
 * company classification downgrade. So this follows `materialisePpmJobs` in
 * `contracts.ts` and `convertLead` in `leads.ts` field for field:
 *
 *  1. **`nextJobReference(tx)`** allocates the reference through
 *     `app_next_reference('JOB', …)`. Never `count(*) + 1`: that races, and
 *     under the customer-scope policies a portal read cannot even see the
 *     number another customer already took.
 *  2. **`loadWorkingCalendar(tx)`** — the *stored* calendar (`ADM-10`), not
 *     `DEFAULT_CALENDAR`. `computeSlaDeadlines` falls back to a default whose
 *     public-holiday list is deliberately EMPTY, because a hardcoded one goes
 *     stale in January. Taking that fallback silently would mean an
 *     administrator could enter every UAE public holiday and every deadline
 *     computed here would still schedule straight through Eid.
 *  3. **`computeSlaDeadlines`** writes `respond_by_at` and `resolve_by_at` onto
 *     the row. Stored once, never recomputed on read, for the reason `JOB-3`
 *     gives: a job must keep being judged by the terms it was raised under.
 *  4. **A `job_events` row** naming the project reference and the phase, so the
 *     job's own timeline answers "where did this come from" without anybody
 *     needing to know `project_phase_jobs` exists.
 *  5. **`attachJobToPhase`** does the linking. The insert is not duplicated
 *     here; that function already owns the `onConflictDoNothing` that makes a
 *     double click a no-op instead of a 500.
 *
 * ── WHY `source = 'internal'` AND NOT A PROJECT SOURCE ────────────────────
 *
 * `job_source` has no project value and one is not added here. Adding an enum
 * value is `ALTER TYPE ... ADD VALUE`, which is a migration, and a migration is
 * owned by whoever is sequencing them — not by a feature branch that needed a
 * word. `internal` is truthful: the work was raised by staff rather than
 * arriving from a customer, which is what every other value in that enum is
 * distinguishing. The provenance that actually matters is carried by
 * `project_phase_jobs` (the link the phase panel reads), by the `job_events`
 * note (the sentence a person reads), and by `jobs.project_id` (denormalised,
 * no foreign key, so it is a hint for filtering rather than the authority).
 *
 * ── WHY `is_outdoor` DEFAULTS TO TRUE HERE ────────────────────────────────
 *
 * `jobs.is_outdoor` defaults to `false` at the column, which is right for the
 * table as a whole: most jobs in this system are a leaking tap in a villa or an
 * AC service in an apartment, and those are indoors.
 *
 * A job raised from a construction phase is not that job. It is site work on a
 * fit-out, a hoarding, a facade, a roof plant deck or a car-park deck, and the
 * ban applies to work in direct sun rather than to a trade — painting a
 * stairwell is indoors, painting the elevation of the same building is not.
 *
 * The two errors are not symmetric, and that asymmetry is the whole argument:
 *
 *  * Flagged outdoor when it was indoors: between 15 June and 15 September the
 *    scheduler refuses a visit placed between 12:30 and 15:00 and offers 15:00
 *    instead. The operator reads a refusal that names the ban, unticks the box
 *    because the work is inside, and re-books. Cost: one form submission, and
 *    the mistake is visible at the moment it is made.
 *  * Not flagged when it was outdoors: the ban check in `checkOutdoorWindow`
 *    is never consulted, the visit is placed at 13:00 in July, and the first
 *    anybody hears of it is an inspector on site. Cost: AED 5,000 per worker up
 *    to AED 50,000, plus a classification downgrade that reprices every tender
 *    the company bids for the following year. The mistake is invisible until it
 *    is expensive.
 *
 * So the default leans to the refusable error, and the caller can always say
 * otherwise. The UI ticks the box and lets the operator untick it, which is the
 * same bargain in the other direction: a decision that has to be taken rather
 * than one that is taken by omission.
 *
 * Note what this function does *not* do: it does not check the ban itself. Job
 * creation never has, in any of the three ordinary paths, because a job has no
 * end instant to check a window against — `scheduled_for` is an intention, not
 * a booking. The ban is enforced where the work is actually placed, in
 * `scheduleVisit` (`jobs.ts`) and `assignTechnician` (`assignment.ts`), both of
 * which read `jobs.is_outdoor` off the row this function writes. Setting the
 * flag correctly *is* the contribution.
 */
export async function raiseJobForPhase(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RaiseJobForPhaseInput,
): Promise<RaisedPhaseJob> {
  const title = input.title.trim();
  if (title.length < 3) {
    throw new UserFacingError("Give the job a title — it is what the technician reads first.");
  }

  // One query for the phase and the project it belongs to. Under RLS a phase in
  // another tenant is simply absent, which is why "not found" and "not yours"
  // are the same sentence below and deliberately so.
  const rows = await tx
    .select({
      phaseId: schema.projectPhases.id,
      phaseName: schema.projectPhases.name,
      phaseSequence: schema.projectPhases.sequence,
      phaseStatus: schema.projectPhases.status,
      phaseServiceSlug: schema.projectPhases.serviceSlug,
      projectId: schema.projects.id,
      projectReference: schema.projects.reference,
      projectName: schema.projects.name,
      projectStatus: schema.projects.status,
      customerId: schema.projects.customerId,
      propertyId: schema.projects.propertyId,
    })
    .from(schema.projectPhases)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.projectPhases.projectId))
    .where(
      and(
        eq(schema.projectPhases.id, input.phaseId),
        isNull(schema.projectPhases.deletedAt),
        isNull(schema.projects.deletedAt),
      ),
    )
    .limit(1);

  const phase = rows[0];
  if (!phase) throw new UserFacingError("Phase not found in this tenant.");

  // A cancelled phase is descoped work. `setPhaseProgress` refuses it for the
  // same reason: recording anything against it produces a number that the
  // weighted completion figure has already excluded.
  if (phase.phaseStatus === "cancelled") {
    throw new UserFacingError(
      `Phase ${phase.phaseSequence} "${phase.phaseName}" is cancelled. ` +
        "Work descoped from the programme does not raise jobs — reinstate the phase, or raise " +
        "the job against the phase that now owns the work.",
    );
  }

  const projectStatus = phase.projectStatus as ProjectStatus;
  if (PHASE_JOBS_REFUSED_IN.includes(projectStatus)) {
    throw new UserFacingError(
      `${phase.projectReference} is ${PROJECT_STATUS_LABEL[projectStatus].toLowerCase()}, so a ` +
        "job cannot be raised against its phases. " +
        (projectStatus === "quoted"
          ? "Nothing has been instructed yet — award the project first, and the phase will raise " +
            "work the moment it has."
          : "This project is finished. Further work is a new project or a variation on a live " +
            "one, not a job attached to a closed programme."),
    );
  }

  // `projects.property_id` is nullable on purpose: a tender is priced long
  // before the unit is identified, and forcing a building onto a quoted project
  // would mean inventing one. A job is a different matter — it dispatches a
  // technician to an address — so the nullable column becomes a refusal at the
  // exact point the address is first genuinely needed.
  if (!phase.propertyId) {
    throw new UserFacingError(
      `${phase.projectReference} has no property on it, and a job needs a site to send a ` +
        "technician to. Set the project's property first — open the project, edit it, and " +
        "choose the building or unit this work happens in.",
    );
  }

  // "Assigned trades", as `PRJ-2` puts it. The phase's own trade is the default
  // because that is where the assignment was recorded; the caller may override
  // it for the phase that covers more than one. Neither means the job cannot be
  // raised blind — `jobs.service_slug` is what the dispatch board matches a
  // technician's skills against, and a wrong guess sends the wrong trade.
  const serviceSlug = (input.serviceSlug ?? "").trim() || phase.phaseServiceSlug;
  if (!serviceSlug) {
    throw new UserFacingError(
      `Phase ${phase.phaseSequence} "${phase.phaseName}" has no trade assigned, and none was ` +
        "chosen for this job. Pick the trade — it is what the dispatch board matches against a " +
        "technician's skills, and a job with the wrong one sends the wrong person.",
    );
  }

  const priority = input.priority ?? DEFAULT_PHASE_JOB_PRIORITY;
  const now = new Date();

  // ADM-10. The stored calendar, not DEFAULT_CALENDAR. See the function comment
  // above, point 2: the default's public-holiday list is empty by design, and
  // taking the fallback silently ignores every holiday an administrator entered.
  const calendar = await loadWorkingCalendar(tx);
  const { respondByAt, resolveByAt } = computeSlaDeadlines(priority, now, undefined, calendar);
  const reference = await nextJobReference(tx);

  const [job] = await tx
    .insert(schema.jobs)
    .values({
      tenantId: ctx.tenantId,
      reference,
      customerId: phase.customerId,
      propertyId: phase.propertyId,
      serviceSlug,
      title,
      description: input.description?.trim() || null,
      // Triaged, not submitted. Somebody with `projects:write` has already
      // chosen the trade, the priority and the phase this belongs to, which is
      // the decision triage exists to take. Landing it in `submitted` would put
      // it back in a queue to be re-decided by somebody with less context.
      status: "triaged",
      priority,
      source: "internal",
      projectId: phase.projectId,
      isOutdoor: input.isOutdoor ?? true,
      scheduledFor: input.scheduledFor ?? null,
      respondByAt,
      resolveByAt,
      createdById: ctx.userId ?? null,
    })
    .returning({ id: schema.jobs.id });

  if (!job) throw new Error("Failed to create the phase job");

  await tx.insert(schema.jobEvents).values({
    tenantId: ctx.tenantId,
    jobId: job.id,
    fromStatus: null,
    toStatus: "triaged",
    // Where this came from, on the job's own timeline. A technician who opens
    // the job on a phone sees the project reference and the phase name without
    // knowing that a link table exists, and the person who finds the job on the
    // dispatch board tomorrow can tell it apart from a reactive call-out.
    note:
      `Raised from ${phase.projectReference} phase ${phase.phaseSequence} ` +
      `"${phase.phaseName}" (PRJ-2).` +
      ((input.isOutdoor ?? true) ? " Flagged as outdoor work: the summer midday ban applies." : ""),
    actorId: ctx.userId ?? null,
    // `system` when a scheduler or the seed raised it; `user` otherwise. The
    // timeline distinguishes the two because "who did this" is the first
    // question asked of a job nobody remembers creating.
    actorKind: ctx.actorKind === "system" ? "system" : "user",
  });

  await writeAuditNote(tx, ctx, {
    tableName: "jobs",
    recordId: job.id,
    // `audit_log.action` is varchar(16). The existing entries in this module
    // abbreviate for the same reason — `prj_ret_rel`, `prj_progress`.
    action: "prj_job",
    detail: {
      projectId: phase.projectId,
      projectReference: phase.projectReference,
      phaseId: phase.phaseId,
      phaseSequence: phase.phaseSequence,
      jobReference: reference,
      serviceSlug,
      priority,
      isOutdoor: input.isOutdoor ?? true,
    },
  });

  // The link, through the function that already owns it. Duplicating the insert
  // here is what the comment on `attachJobToPhase` warns against, and it is
  // also how the two would drift.
  const { attached } = await attachJobToPhase(tx, ctx, {
    phaseId: phase.phaseId,
    jobId: job.id,
  });

  return { jobId: job.id, reference, attached };
}

export interface PhaseJobRow {
  readonly phaseId: string;
  readonly jobId: string;
  readonly reference: string;
  readonly title: string;
  readonly status: string;
  readonly priority: JobPriority;
  readonly scheduledFor: Date | null;
  readonly isOutdoor: boolean;
}

/**
 * The jobs each phase of a project has raised.
 *
 * `getProject` already selects a `job_count` per phase — it has since `PRJ-2`
 * was written, and it has always returned 0 because nothing called
 * `attachJobToPhase`. That count now populates on its own and needs no change.
 * What the panel cannot get from a count is *which* jobs, so this returns the
 * rows: one flat list ordered by phase and then by when the work is due, which
 * the screen groups by `phaseId`.
 *
 * Kept out of `getProject` rather than folded into it. The detail read is
 * already six queries deep and every one of them is unconditional; a project
 * with no phases has nothing to group, and the caller that wants a printable
 * project summary has no use for this at all.
 *
 * Soft-deleted jobs are excluded. `project_phase_jobs` cascades from the job,
 * so a hard-deleted job takes its link with it, but a soft-deleted one leaves
 * the link standing — and a phase panel listing a job the jobs board has
 * stopped showing is a phase panel nobody trusts.
 */
export async function listPhaseJobs(
  tx: TenantScopedTx,
  projectId: string,
): Promise<readonly PhaseJobRow[]> {
  const rows = (await tx.execute<{
    phase_id: string;
    job_id: string;
    reference: string;
    title: string;
    status: string;
    priority: string;
    scheduled_for: string | null;
    is_outdoor: boolean;
  }>(sql`
    select pj.phase_id,
           j.id as job_id,
           j.reference,
           j.title,
           j.status::text as status,
           j.priority::text as priority,
           j.scheduled_for::text as scheduled_for,
           j.is_outdoor
      from project_phase_jobs pj
      join jobs j on j.id = pj.job_id
      join project_phases ph on ph.id = pj.phase_id
     where pj.project_id = ${projectId}::uuid
       and j.deleted_at is null
     order by ph.sequence, j.scheduled_for nulls last, j.reference
  `)) as unknown as {
    phase_id: string;
    job_id: string;
    reference: string;
    title: string;
    status: string;
    priority: string;
    scheduled_for: string | null;
    is_outdoor: boolean;
  }[];

  return rows.map((r) => ({
    phaseId: r.phase_id,
    jobId: r.job_id,
    reference: r.reference,
    title: r.title,
    status: r.status,
    priority: r.priority as JobPriority,
    // A timestamp out of `tx.execute` is a string, whatever the type parameter
    // says. See `_rows.ts` — the annotation is an assertion, not a check.
    scheduledFor: rowDate(r.scheduled_for),
    isOutdoor: r.is_outdoor,
  }));
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

// ── PRJ-5 / PRJ-6 / PRJ-9: the chase sweep ───────────────────────────────────
//
// Everything above this line produces a state; nothing above it ever tells
// anybody. `listRetention({ dueWithinDays })` and `markRetentionReminded` were
// written for a caller that did not exist, `client_approval_state` defaults to
// `pending` and nothing has ever asked about it, and `project_permits` carries
// an expiry date whose only consumer is a gate that refuses a button. This
// block is the reading half of `/api/cron/projects`.
//
// ── WHY SUPPRESSION IS DONE IN TWO DIFFERENT PLACES ─────────────────────────
//
// `listUnapprovedSubcontracts` and `listExpiringPermits` take a
// `notRemindedWithinHours` filter and apply it in SQL; retention does not,
// because `listRetention` is also the ledger the project screen reads and a
// chase window has no meaning there. The sweep therefore filters retention in
// TypeScript with `needsChasing`, which is the same predicate the SQL applies,
// written once so the two cannot drift. The asymmetry is deliberate rather than
// an oversight: the SQL-side filter is what lets the subcontract chase ride the
// `project_subcontracts_approval_idx` index all the way through, and retention
// is bounded by `dueWithinDays` long before it reaches memory.

/**
 * Has this row gone unchased for long enough to chase again?
 *
 * NULL is "never asked" and is always due. The window is hours rather than
 * days because the sweep is daily and a scheduler that double-fires at 07:15
 * and 07:16 must not send the same digest twice — the same reason
 * `recentlyNotified` exists one layer up. This one gates the *rows*; that one
 * gates the *recipient*. Both are needed: without this, a second run on the
 * same day would re-mark every row and reset the clock; without that, a tenant
 * whose row set changed by one entry would be emailed twice.
 */
export function needsChasing(
  lastRemindedAt: Date | null,
  withinHours: number,
  now: Date = new Date(),
): boolean {
  if (lastRemindedAt === null) return true;
  return now.getTime() - lastRemindedAt.getTime() >= withinHours * 60 * 60 * 1000;
}

/**
 * Projects that are still ours, for the purposes of a chase.
 *
 * `cancelled` and `closed` and nothing else. Deliberately wider than
 * `OPEN_PROJECT_STATUSES`, which stops at `snagging`: an engagement made
 * without the employer's approval on a project now in defects liability is
 * still the engagement whose paperwork is asked for in a dispute, and a permit
 * that lapses during the defects period is still a permit somebody has to
 * produce. The file closes when the project closes, not at handover.
 */
const CHASEABLE_PROJECT_STATUSES = sql`('quoted', 'awarded', 'mobilising', 'on_site', 'snagging', 'practical_completion', 'defects_liability')`;

export interface UnapprovedSubcontractRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectReference: string;
  readonly projectName: string;
  readonly projectStatus: ProjectStatus;
  readonly subcontractorName: string;
  readonly scope: string;
  readonly valueMinor: number;
  /** "pending" or "refused". Never "approved" or "not_required" — see below. */
  readonly approvalState: string;
  readonly startsOn: string | null;
  /**
   * `starts_on` has arrived and the approval has not. Dubai Law No. 7 of 2025
   * requires the employer's **prior** approval before subcontracting within the
   * contracting sector, so this is not "running late" — it is already the wrong
   * side of the line, and the only remaining question is how far.
   */
  readonly alreadyStarted: boolean;
  /** Days since `starts_on`, in Dubai. Null when no start date is recorded. */
  readonly daysSinceStart: number | null;
  readonly lastRemindedAt: Date | null;
}

/**
 * Engagements that lack the employer's approval (`PRJ-9`).
 *
 * ── WHY `refused` IS IN HERE AS WELL AS `pending` ───────────────────────────
 *
 * `pending` is the common case and the one the default produces. `refused` is
 * rarer and strictly worse: the employer has been asked and has said no, and
 * the engagement row is still there with a start date on it. Reporting only
 * `pending` would mean the one state that is unambiguously unlawful to proceed
 * under is the one state nothing ever mentions, which is the wrong way round.
 * They are returned together and separated by `approvalState` so the message
 * can put the refusals first rather than merging the two into one count.
 *
 * `not_required` is excluded, and that is not the same judgement. It is a
 * recorded decision that this engagement falls outside the approval regime —
 * a supply-only order, say — and chasing a decision somebody already made is
 * how a chase list gets filtered into a folder.
 *
 * ── THE ORDER ───────────────────────────────────────────────────────────────
 *
 * Least-recently-chased first, NULLs first, which is both the fair order and
 * the one `project_subcontracts_approval_idx (tenant_id, client_approval_state,
 * last_reminded_at)` was added for. Ordering by value or by start date would
 * mean a small engagement that nobody has ever asked about sits behind a large
 * one that has been asked about four times.
 */
export async function listUnapprovedSubcontracts(
  tx: TenantScopedTx,
  filter: { projectId?: string; notRemindedWithinHours?: number } = {},
): Promise<readonly UnapprovedSubcontractRow[]> {
  const rows = (await tx.execute<{
    id: string;
    project_id: string;
    project_reference: string;
    project_name: string;
    project_status: string;
    subcontractor_name: string;
    scope: string;
    value: string;
    client_approval_state: string;
    starts_on: string | null;
    already_started: boolean;
    days_since_start: number | null;
    last_reminded_at: string | null;
  }>(sql`
    select ps.id,
           ps.project_id,
           p.reference as project_reference,
           p.name      as project_name,
           p.status    as project_status,
           s.name      as subcontractor_name,
           ps.scope,
           ps.value::text as value,
           ps.client_approval_state,
           ps.starts_on::text as starts_on,
           (ps.starts_on is not null
              and ps.starts_on <= (now() at time zone 'Asia/Dubai')::date) as already_started,
           case
             when ps.starts_on is null then null
             else ((now() at time zone 'Asia/Dubai')::date - ps.starts_on)::int
           end as days_since_start,
           ps.last_reminded_at
      from project_subcontracts ps
      join projects       p on p.id = ps.project_id
      join subcontractors s on s.id = ps.subcontractor_id
     where ps.deleted_at is null
       and ps.client_approval_state in ('pending', 'refused')
       and p.deleted_at is null
       and p.status in ${CHASEABLE_PROJECT_STATUSES}
       ${filter.projectId ? sql`and ps.project_id = ${filter.projectId}::uuid` : sql``}
       ${
         filter.notRemindedWithinHours !== undefined
           ? sql`and (ps.last_reminded_at is null
                      or ps.last_reminded_at <= now() - make_interval(hours => ${filter.notRemindedWithinHours}))`
           : sql``
       }
     order by ps.last_reminded_at asc nulls first, ps.starts_on asc nulls last, p.reference
  `)) as unknown as {
    id: string;
    project_id: string;
    project_reference: string;
    project_name: string;
    project_status: string;
    subcontractor_name: string;
    scope: string;
    value: string;
    client_approval_state: string;
    starts_on: string | null;
    already_started: boolean;
    days_since_start: number | null;
    last_reminded_at: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectReference: r.project_reference,
    projectName: r.project_name,
    projectStatus: r.project_status as ProjectStatus,
    subcontractorName: r.subcontractor_name,
    scope: r.scope,
    // Text out of SQL, `toMinor` in TypeScript. A portfolio of subcontracts
    // passes 2,147,483,647 fils long before a portfolio of anything else does,
    // and `::int` on the way out is how that becomes an error nobody can read.
    valueMinor: toMinor(r.value),
    approvalState: r.client_approval_state,
    startsOn: r.starts_on,
    // `boolean` out of Postgres arrives as a real boolean through this driver,
    // but the cast is free and the alternative is a truthy string.
    alreadyStarted: r.already_started === true,
    daysSinceStart: r.days_since_start === null ? null : Number(r.days_since_start),
    lastRemindedAt: rowDate(r.last_reminded_at),
  }));
}

/**
 * Record that an approval chase has gone out about these engagements.
 *
 * Mirrors `markRetentionReminded` exactly, including the empty-array
 * short-circuit, and for the same reason: what matters is only "have we asked
 * recently", which one timestamp answers. A ladder of rungs would be the
 * `contract_renewal_notices` shape, and that shape exists because a renewal is
 * four different messages to possibly different people. This is the same
 * question asked of the same project manager until somebody produces the
 * employer's letter.
 */
export async function markSubcontractsReminded(
  tx: TenantScopedTx,
  subcontractIds: readonly string[],
): Promise<number> {
  if (subcontractIds.length === 0) return 0;

  const result = await tx
    .update(schema.projectSubcontracts)
    .set({ lastRemindedAt: new Date(), updatedAt: new Date() })
    .where(inArray(schema.projectSubcontracts.id, [...subcontractIds]))
    .returning({ id: schema.projectSubcontracts.id });

  return result.length;
}

export interface ExpiringPermitRow {
  readonly id: string;
  readonly projectId: string;
  readonly projectReference: string;
  readonly projectName: string;
  readonly authorityCode: string;
  readonly authorityLabel: string;
  readonly permitType: string;
  readonly referenceNumber: string | null;
  readonly expiresOn: string;
  /** Negative when it has already lapsed. */
  readonly daysRemaining: number;
  readonly lastRemindedAt: Date | null;
}

/**
 * Required permits about to lapse, or already lapsed (`PRJ-6`).
 *
 * ── WHY THIS IS WORTH A MESSAGE AT ALL ──────────────────────────────────────
 *
 * `blockingPermits` treats a required permit that is approved and **expired**
 * as blocking, which is right — an operator reads the word "Approved" and stops
 * reading, and the authority does not. But the consequence of that rule, with
 * nothing watching the date, is that a permit lapsing mid-project is discovered
 * as a button that mysteriously refuses, by whoever happened to click it, on
 * the morning the crew is already at the gate. This turns it back into a date
 * somebody was told about in advance.
 *
 * Only `is_required` permits, and only `approved` ones. A permit that is not
 * required blocks nothing, and a chase list containing items with no
 * consequence is a chase list people learn to skim. A permit still `applied`
 * for is already blocking today and is not an expiry problem — that one is on
 * the project screen, in red, and does not need an email as well.
 *
 * Ordered by expiry rather than by last chased, unlike the subcontract list
 * above: this list has a real deadline attached to each row, and the one that
 * lapses on Sunday must be read before the one that lapses in six weeks
 * however long ago either was mentioned. `project_permits_expiry_idx
 * (tenant_id, expires_on)` is the index that serves it.
 */
export async function listExpiringPermits(
  tx: TenantScopedTx,
  filter: { withinDays: number; projectId?: string; notRemindedWithinHours?: number },
): Promise<readonly ExpiringPermitRow[]> {
  const rows = (await tx.execute<{
    id: string;
    project_id: string;
    project_reference: string;
    project_name: string;
    authority_code: string;
    authority_label: string;
    permit_type: string;
    reference_number: string | null;
    expires_on: string;
    days_remaining: number;
    last_reminded_at: string | null;
  }>(sql`
    select pp.id,
           pp.project_id,
           p.reference as project_reference,
           p.name      as project_name,
           pa.code     as authority_code,
           pa.label    as authority_label,
           pp.permit_type,
           pp.reference_number,
           pp.expires_on::text as expires_on,
           (pp.expires_on - (now() at time zone 'Asia/Dubai')::date)::int as days_remaining,
           pp.last_reminded_at
      from project_permits pp
      join projects           p  on p.id = pp.project_id
      join permit_authorities pa on pa.id = pp.authority_id
     where pp.deleted_at is null
       and pp.is_required
       and pp.status = 'approved'
       and pp.expires_on is not null
       and pp.expires_on <= (now() at time zone 'Asia/Dubai')::date + ${filter.withinDays}::int
       and p.deleted_at is null
       and p.status in ${CHASEABLE_PROJECT_STATUSES}
       ${filter.projectId ? sql`and pp.project_id = ${filter.projectId}::uuid` : sql``}
       ${
         filter.notRemindedWithinHours !== undefined
           ? sql`and (pp.last_reminded_at is null
                      or pp.last_reminded_at <= now() - make_interval(hours => ${filter.notRemindedWithinHours}))`
           : sql``
       }
     order by pp.expires_on asc, p.reference
  `)) as unknown as {
    id: string;
    project_id: string;
    project_reference: string;
    project_name: string;
    authority_code: string;
    authority_label: string;
    permit_type: string;
    reference_number: string | null;
    expires_on: string;
    days_remaining: number;
    last_reminded_at: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectReference: r.project_reference,
    projectName: r.project_name,
    authorityCode: r.authority_code,
    authorityLabel: r.authority_label,
    permitType: r.permit_type,
    referenceNumber: r.reference_number,
    expiresOn: r.expires_on,
    daysRemaining: Number(r.days_remaining),
    lastRemindedAt: rowDate(r.last_reminded_at),
  }));
}

/** Record that a permit expiry chase has gone out. Same shape as the other two. */
export async function markPermitsReminded(
  tx: TenantScopedTx,
  permitIds: readonly string[],
): Promise<number> {
  if (permitIds.length === 0) return 0;

  const result = await tx
    .update(schema.projectPermits)
    .set({ lastRemindedAt: new Date(), updatedAt: new Date() })
    .where(inArray(schema.projectPermits.id, [...permitIds]))
    .returning({ id: schema.projectPermits.id });

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

/**
 * ── ATTACHING A FILE TO A RECORD: THE ONE RULE ─────────────────────────────
 *
 * A caller names an **upload session id**. It never names a storage key.
 *
 * The distinction is the whole of the security here. A storage key is just a
 * string: by the time one arrives at a function like this, the question of who
 * was allowed to produce it has already been lost, and nothing downstream can
 * recover it. `uploads/<some other tenant>/candidate_document/<uuid>.pdf` is a
 * perfectly well-formed key, and a permit register that accepted keys would
 * serve that file to anybody who could read the permit.
 *
 * A session id is different because the row behind it carries its own
 * provenance: row-level security says which tenant opened it, `purpose` says
 * what it was authorised as, `status` says whether the bytes are all here and
 * verified, and `scan_status` says whether anything has looked at them. So the
 * key is *derived* from the session inside this transaction, and the four
 * things above are checked first.
 *
 * ── WHICH SCAN VERDICTS ARE ACCEPTED, AND WHY ──────────────────────────────
 *
 * `clean` and `skipped`. Not `pending`, not `infected`.
 *
 *  * `infected` is obvious and needs no argument.
 *  * `pending` means a scanner is configured and has not yet reached this
 *    file. `/api/cron/scan` exists precisely so that nothing serves bytes in
 *    that state, and it runs every ten minutes: refusing here costs the
 *    operator one retry and is the difference between the sweep being a gate
 *    and being decoration.
 *  * `skipped` is written by `completeStagedUpload` only when
 *    `virusScanner().configured` is false — a deployment with no scanner at
 *    all. It is not a file that failed a check; it is a file in a deployment
 *    where no check exists, and the same deployment is already storing job
 *    photographs and candidate CVs on that footing. Refusing it would not make
 *    such a deployment safer, it would make the permit register unusable there
 *    and push the permit PDF into somebody's email. `/api/cron/scan` warns
 *    about this state on every single run, which is the honest way to carry
 *    it.
 *
 * Note that `skipped` uploads are never revisited — `pendingUploadScans`
 * selects `scan_status = 'pending'` only — so accepting one is accepting a file
 * nothing will ever scan. That is a deployment-configuration decision, made
 * once by whoever left `CLAMAV_HOST` unset, and it is not this function's to
 * relitigate per file.
 */
async function resolveUploadedFile(
  tx: TenantScopedTx,
  input: { uploadId: string; expectedPurpose: string; what: string },
): Promise<{ storageKey: string; filename: string | null; contentType: string | null }> {
  const session = await getUpload(tx, input.uploadId);

  // Not-found and not-in-this-tenant are the same answer, because row-level
  // security gives the same answer for both and telling them apart would
  // confirm that an id exists somewhere else. The message says the same thing
  // for the same reason.
  if (!session) throw new UserFacingError("There is no such upload.");

  if (session.status !== "complete") {
    throw new UserFacingError(
      `That upload is ${session.status}, not finished. Wait for it to finish before attaching it.`,
    );
  }

  // The purpose is read from the row, never from the caller. A person who may
  // upload a candidate's passport must not be able to name that session here
  // and have it filed as a permit — which is the same file, under a different
  // permission, read by a different set of people.
  if (session.purpose !== input.expectedPurpose) {
    throw new UserFacingError(
      `That upload was not made as ${input.what}. Upload the file again from this screen.`,
    );
  }

  if (session.scanStatus === "infected") {
    throw new UserFacingError(
      "That file failed the virus scan. It is not attached anywhere and will not be served.",
    );
  }
  if (session.scanStatus !== "clean" && session.scanStatus !== "skipped") {
    throw new UserFacingError(
      "That file has not been scanned yet. The scan runs every ten minutes; try again shortly.",
    );
  }

  // Only now, and from the row.
  if (!session.storageKey) {
    throw new Error(`Upload ${input.uploadId} is complete with no storage key`);
  }

  return {
    storageKey: session.storageKey,
    filename: session.filename,
    contentType: session.contentType,
  };
}

/**
 * `PRJ-6`: put the permit itself behind the register entry.
 *
 * ── WHY REPLACING AN EXISTING DOCUMENT TAKES AN EXPLICIT ASK ───────────────
 *
 * Objects are write-once (`OPS-6`), and the reason that matters here is not
 * storage hygiene. The on-site gate reads this register: a project passed into
 * `on_site` because a permit said `approved`, and the document that was on file
 * at that moment is the evidence of what the gate was told. A second attach
 * that silently replaced the first would leave the register looking exactly as
 * it does now while the thing it evidences had changed underneath — which is
 * the shape of every document dispute that gets settled by whoever kept better
 * records.
 *
 * So a first attach is free, and a replacement takes `replace: true` and is
 * written into the audit log with **both** keys. The superseded object is not
 * deleted — it stays in the store, cited by the audit row, which is what makes
 * the trail worth having. The alternative designs were both worse: refusing
 * outright means an operator who attached the wrong PDF cannot fix it without a
 * developer, and overwriting silently means nobody can ever tell that they did.
 */
export async function attachPermitDocument(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    permitId: string;
    /** An upload session id. Never a storage key — see `resolveUploadedFile`. */
    uploadId: string;
    replace?: boolean;
  },
): Promise<{ storageKey: string; replaced: string | null }> {
  const rows = await tx
    .select({
      id: schema.projectPermits.id,
      projectId: schema.projectPermits.projectId,
      permitType: schema.projectPermits.permitType,
      status: schema.projectPermits.status,
      existing: schema.projectPermits.documentStorageKey,
    })
    .from(schema.projectPermits)
    .where(and(eq(schema.projectPermits.id, input.permitId), isNull(schema.projectPermits.deletedAt)))
    .limit(1);

  const permit = rows[0];
  if (!permit) throw new UserFacingError("Permit not found in this tenant.");

  if (permit.existing && !input.replace) {
    throw new UserFacingError(
      "This permit already has a document on file. Tick 'replace the document on file' if the " +
        "one there is wrong — the superseded file is kept and the swap is recorded.",
    );
  }

  const file = await resolveUploadedFile(tx, {
    uploadId: input.uploadId,
    expectedPurpose: "project_permit_document",
    what: "a permit document",
  });

  await tx
    .update(schema.projectPermits)
    .set({ documentStorageKey: file.storageKey, updatedAt: new Date() })
    .where(eq(schema.projectPermits.id, input.permitId));

  await writeAuditNote(tx, ctx, {
    // `audit_log.action` is varchar(16); the abbreviations in this file are
    // not stylistic.
    tableName: "project_perms",
    recordId: input.permitId,
    action: "prj_permit_doc",
    detail: {
      projectId: permit.projectId,
      permitType: permit.permitType,
      permitStatus: permit.status,
      uploadId: input.uploadId,
      filename: file.filename,
      contentType: file.contentType,
      storageKey: file.storageKey,
      // Named, not deleted. This is the whole point of taking `replace`.
      supersededStorageKey: permit.existing,
    },
  });

  return { storageKey: file.storageKey, replaced: permit.existing };
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

/**
 * Raises a snag. It does **not** take a photograph.
 *
 * It used to accept a `photoStorageKey`, and no caller ever passed one --
 * the server action does not collect it and never did. That is the safer
 * of the two ways for a parameter like this to be wrong, but it is still
 * wrong: a storage key arriving in an argument list is a key whose
 * provenance has already been lost, and the next caller to wire the form
 * up properly would have passed one straight from the browser. Evidence
 * goes on afterwards through `attachSnagPhoto`, which resolves the key
 * from an upload the session owns. See the note above that function for
 * why the same parameter was taken off `closeSnag`.
 */
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
      closurePhotoStorageKey: schema.projectSnags.closurePhotoStorageKey,
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

  // ── THIS DOES NOT TOUCH THE CLOSURE PHOTOGRAPH, AND THAT IS THE POINT ─────
  //
  // Two bugs lived on one line here, and removing the line removed both.
  //
  // It read `closurePhotoStorageKey: input.closurePhotoStorageKey ?? null`,
  // which set the column to NULL on every closure that did not name a key —
  // and since evidence is attached *before* the snag is closed (the upload is
  // chunked and cannot happen inside a form post; see `attachSnagPhoto`),
  // closing a snag silently discarded the photograph somebody had filed
  // against it seconds earlier.
  //
  // The first fix was to write the column only when the caller named one. That
  // was correct and still left the parameter, which is the second bug: a
  // storage key in an argument list is a key whose provenance has already been
  // lost, and no production caller ever passed one — the server action does not
  // collect it and never did. It survived only because a test fixture used it
  // as a shortcut. A parameter that exists is a parameter somebody eventually
  // passes, and the one who wires the closure form up properly would have
  // passed a key straight from the browser.
  //
  // So the parameter is gone, on the same argument as `raiseSnag`'s. Closure
  // evidence goes on through `attachSnagPhoto`, which resolves the key from an
  // upload session the tenant owns. Clobbering it here is now impossible rather
  // than merely not done, which is the difference between a fixed bug and one
  // that cannot recur.
  await tx
    .update(schema.projectSnags)
    .set({
      status,
      closureNote: input.closureNote.trim(),
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
      // The row, and now there is nothing else it could read: evidence is
      // attached before the closure rather than named in it.
      hasPhoto: Boolean(snag.closurePhotoStorageKey),
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

/** Which of the two photographs on a snag is being filed. */
export type SnagPhotoSlot = "photo" | "closure";

/**
 * `PRJ-7`: the photograph of the snag, and the photograph that closes it.
 *
 * ── WHY TWO SLOTS AND NOT TWO ROWS ─────────────────────────────────────────
 *
 * `PRJ-7` names exactly two: the **photo** of the defect and the **closure
 * evidence**. They are not a gallery; they are a before and an after, and the
 * pair is what a handover meeting argues over. Two columns say that. A general
 * attachments table would say "some number of photographs, in some order", and
 * the question a supervisor actually asks — was there a photograph of this
 * before it was signed off — would stop having an answer.
 *
 * The two slots are independent. Attaching the closure photograph leaves the
 * original untouched, which sounds obvious and is exactly what a single
 * `photoStorageKey` parameter threaded through `closeSnag` would have got
 * wrong.
 *
 * ── WHY THIS IS NOT PART OF `closeSnag` ────────────────────────────────────
 *
 * Because the upload is chunked and asynchronous and the closure is a form
 * post. Folding them together would mean either holding a form open across a
 * multi-megabyte upload on site wifi — the exact failure the resumable
 * transport exists to survive — or passing a storage key through the closure
 * form, which is the thing that must never happen. So: attach first, close
 * after. `closeSnag` cannot overwrite a closure photograph at all — it no
 * longer takes a key — which is what makes that order safe rather than merely
 * conventional.
 *
 * Attaching closure evidence to an already-closed snag is allowed, and
 * deliberately: a supervisor who closed the snag from the site office and found
 * the photograph on their phone afterwards is adding evidence, not changing a
 * decision. Replacing one already on file is the case that takes `replace`,
 * for the same reason as the permit above.
 *
 * ── WHAT IS DELIBERATELY NOT ENFORCED HERE ─────────────────────────────────
 *
 * Closing a **critical** snag still does not require a closure photograph.
 * There is a real argument that it should — a critical snag is by definition
 * one that makes the premises unsafe, and "we fixed it, trust us" is thin
 * evidence for that — but it is a new refusal in front of the practical-
 * completion gate, and changing what that gate demands is not a decision to
 * take in a file about attaching files. Flagged, not built.
 */
export async function attachSnagPhoto(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    snagId: string;
    /** An upload session id. Never a storage key — see `resolveUploadedFile`. */
    uploadId: string;
    slot: SnagPhotoSlot;
    replace?: boolean;
  },
): Promise<{ storageKey: string; replaced: string | null }> {
  const rows = await tx
    .select({
      id: schema.projectSnags.id,
      projectId: schema.projectSnags.projectId,
      sequence: schema.projectSnags.sequence,
      severity: schema.projectSnags.severity,
      status: schema.projectSnags.status,
      photoStorageKey: schema.projectSnags.photoStorageKey,
      closurePhotoStorageKey: schema.projectSnags.closurePhotoStorageKey,
    })
    .from(schema.projectSnags)
    .where(and(eq(schema.projectSnags.id, input.snagId), isNull(schema.projectSnags.deletedAt)))
    .limit(1);

  const snag = rows[0];
  if (!snag) throw new UserFacingError("Snag not found in this tenant.");

  const existing = input.slot === "closure" ? snag.closurePhotoStorageKey : snag.photoStorageKey;

  if (existing && !input.replace) {
    throw new UserFacingError(
      input.slot === "closure"
        ? "This snag already has closure evidence. Tick 'replace' if the photograph on file is " +
          "wrong — the superseded one is kept and the swap is recorded."
        : "This snag already has a photograph. Tick 'replace' if the one on file is wrong — the " +
          "superseded one is kept and the swap is recorded.",
    );
  }

  const file = await resolveUploadedFile(tx, {
    uploadId: input.uploadId,
    expectedPurpose: "project_snag_photo",
    what: "a snag photograph",
  });

  await tx
    .update(schema.projectSnags)
    .set(
      input.slot === "closure"
        ? { closurePhotoStorageKey: file.storageKey, updatedAt: new Date() }
        : { photoStorageKey: file.storageKey, updatedAt: new Date() },
    )
    .where(eq(schema.projectSnags.id, input.snagId));

  await writeAuditNote(tx, ctx, {
    // varchar(16): "prj_snag_photo" is 14, and naming the slot in the detail
    // rather than in the action is what keeps it that way.
    tableName: "project_snags",
    recordId: input.snagId,
    action: "prj_snag_photo",
    detail: {
      projectId: snag.projectId,
      sequence: snag.sequence,
      severity: snag.severity,
      snagStatus: snag.status,
      slot: input.slot,
      uploadId: input.uploadId,
      filename: file.filename,
      contentType: file.contentType,
      storageKey: file.storageKey,
      supersededStorageKey: existing,
    },
  });

  return { storageKey: file.storageKey, replaced: existing };
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

export interface DecideSubcontractApprovalInput {
  readonly subcontractId: string;
  readonly to: SubcontractApproval;
  /** Defaults to today, in Dubai, when moving to `approved`. Ignored otherwise. */
  readonly approvedOn?: string | undefined;
  readonly approvalReference?: string | undefined;
}

/**
 * Record the employer's decision on an engagement's approval (`PRJ-9`).
 *
 * Until this function existed, `client_approval_state` could be set exactly
 * once — at `engageSubcontractor`, on creation — and never again. That is not
 * a subtlety: every row `listUnapprovedSubcontracts` returns is `pending` or
 * `refused` by construction, which is also exactly the set of rows the chase
 * sweep and the chase screen (`/projects/chase`) put in front of an operations
 * manager every morning, and there was no way to *act* on any of them short of
 * writing SQL by hand. A chase list nobody can resolve trains its reader to
 * ignore it, the same failure `releaseRetention` exists to prevent for the
 * retention half of this same sweep.
 *
 * ── THE GRAPH, AND WHY `refused → approved` IS THE ONLY WAY BACK ───────────
 *
 * `canTransitionSubcontractApproval` (`@meridian/core`) is the whole rule:
 * `pending` resolves to `approved` or `refused`; a `refused` decision can still
 * become `approved` later, because an operations manager who reads "no" today
 * often goes back and gets a "yes" once the paperwork is fixed; and there is no
 * route back to `pending` from either terminal state, because an approval or a
 * refusal is a decision the employer made and dated, not a position that
 * lapses on its own. `not_required` is not reachable from here at all — it is
 * a classification made at engagement time about whether the law's approval
 * regime applies, not an answer to a question that was ever asked of the
 * employer, and this function only records the employer's answers.
 *
 * ── WHY THIS DOES NOT ALSO GATE `on_site` ───────────────────────────────────
 *
 * It was tempting to pair this with a block in `transitionProject`, mirroring
 * `PRJ-6`'s required-permit gate exactly. It is not there, and the reasoning is
 * written where that decision belongs: beside `transitionProject`'s `PRJ-6`
 * block, and beside `assessWpsCycle` in `@meridian/core`, which declines a
 * comparable block for the same shape of reason. This function's job is
 * narrower and unconditional either way: make the state the chase list already
 * reports resolvable, whatever the system ultimately does or does not refuse
 * because of it.
 */
export async function decideSubcontractApproval(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: DecideSubcontractApprovalInput,
): Promise<{ from: SubcontractApproval; to: SubcontractApproval }> {
  const rows = await tx
    .select({
      id: schema.projectSubcontracts.id,
      projectId: schema.projectSubcontracts.projectId,
      clientApprovalState: schema.projectSubcontracts.clientApprovalState,
    })
    .from(schema.projectSubcontracts)
    .where(
      and(
        eq(schema.projectSubcontracts.id, input.subcontractId),
        isNull(schema.projectSubcontracts.deletedAt),
      ),
    )
    .limit(1);

  const engagement = rows[0];
  if (!engagement) throw new UserFacingError("Subcontract engagement not found in this tenant.");

  const from = engagement.clientApprovalState as SubcontractApproval;
  if (!canTransitionSubcontractApproval(from, input.to)) {
    throw new InvalidSubcontractApprovalTransitionError(from, input.to);
  }

  const patch: Record<string, unknown> = { clientApprovalState: input.to, updatedAt: new Date() };
  // Only an approval carries a date and a reference forward. A refusal dates
  // itself in the audit note, and `clientApprovedOn`/`clientApprovalReference`
  // are specifically the employer's paperwork for saying yes.
  if (input.to === "approved") {
    patch["clientApprovedOn"] = input.approvedOn ?? today();
    patch["clientApprovalReference"] = input.approvalReference || null;
  }

  await tx
    .update(schema.projectSubcontracts)
    .set(patch)
    .where(eq(schema.projectSubcontracts.id, input.subcontractId));

  await writeAuditNote(tx, ctx, {
    tableName: "project_subs",
    recordId: input.subcontractId,
    action: "prj_subcon_appr",
    detail: {
      projectId: engagement.projectId,
      from,
      to: input.to,
      approvalReference: input.approvalReference ?? null,
    },
  });

  return { from, to: input.to };
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
