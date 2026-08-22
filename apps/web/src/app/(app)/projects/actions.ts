"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  addMilestone,
  addPhase,
  attachPermitDocument,
  attachSnagPhoto,
  closeSnag,
  createProject,
  decideVariation,
  engageSubcontractor,
  markMilestoneReached,
  raiseJobForPhase,
  raiseMilestoneInvoice,
  raiseSnag,
  raiseVariation,
  recordCost,
  recordPermit,
  releaseRetention,
  setPermitStatus,
  setPhaseProgress,
  transitionProject,
} from "@meridian/db";
import {
  ALL_PROJECT_STATUSES,
  COST_CATEGORIES,
  fromDubai,
  MILESTONE_TRIGGERS,
  PERMIT_STATUSES,
  PRIORITY_LABEL,
  SNAG_SEVERITIES,
  VARIATION_STATES,
  type CostCategory,
  type JobPriority,
  type MilestoneTrigger,
  type PermitStatus,
  type ProjectStatus,
  type SnagSeverity,
  type VariationState,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Writes for the projects module (`PRJ-1`…`PRJ-9`).
 *
 * ── WHICH PERMISSION, AND WHY IT IS ITS OWN ────────────────────────────────
 *
 * `projects:read` and `projects:write`, not `contracts:*`.
 *
 * The tempting shortcut was to borrow the contract's permission — a project is
 * commercial work with a value, staged payments and retention, so `contracts:*`
 * reads plausibly on a role list. It was the wrong call, and the reason is
 * visible in who holds what: `contracts:write` belongs to owner, admin and
 * **sales**, because sales owns the commercial relationship on an AMC, and an
 * operations manager deliberately reads that term sheet without writing it.
 *
 * `PRJ-1`…`PRJ-9` name the operations manager as a primary actor. Reaching them
 * through `contracts:write` would have meant widening a boundary that exists
 * for an unrelated reason, as a side effect of filling a gap in this module —
 * which is how a permission model rots. A project is a different object from a
 * maintenance contract: phases, milestones, variations, retention, permits, a
 * snag list and a project manager. It gets its own pair.
 *
 * ── EXCEPT FOR THE ONE ACT THAT IS NOT A PROJECT ACT ───────────────────────
 *
 * Raising the milestone invoice takes `invoices:create`, and the split is
 * deliberate rather than incidental. Certifying that a stage of work has been
 * reached is a project manager's judgement; allocating a sequential tax-invoice
 * number is an accountant's act, and a number allocated is a number used — the
 * document cannot be deleted afterwards, only credited.
 *
 * The accountant role holds `invoices:create` and `projects:read`, which is
 * precisely the pair this arrangement asks for: they can open the project and
 * raise its invoice, and they cannot move a phase, close a snag or approve a
 * variation.
 *
 * Every one of these re-checks on the server. The pages hide the forms from a
 * role that only reads — a dispatcher, a technician — but hiding a form is not
 * authorisation, and a `curl` with a session cookie never renders the page.
 */

export interface ProjectFormState {
  error?: string;
  ok?: string;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * A calendar day from `<input type="date">`, kept as `YYYY-MM-DD`.
 *
 * Never converted to a `Date`. Every day-valued column in this module is a
 * Postgres `date`, and the round trip through an instant shifts the value by
 * the reader's offset — which for a permit expiry reports a lapsed permit as
 * current, and for a retention due date reports money that fell due today as
 * not yet due. The contracts module has to convert because its term columns are
 * `timestamptz` on an older table; this one does not, so it does not.
 */
function day(formData: FormData, key: string): string | null {
  const value = text(formData, key);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function amount(value: string): boolean {
  return /^-?\d+(\.\d{1,2})?$/.test(value);
}

async function write() {
  return requireSessionWith("projects:write");
}

function ctxOf(session: Awaited<ReturnType<typeof write>>) {
  return { tenantId: session.principal.tenantId, userId: session.principal.userId };
}

function refresh(projectId: string): void {
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/projects");
}

// ── PRJ-1 ────────────────────────────────────────────────────────────────────

export async function createProjectAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();

  const name = text(formData, "name");
  const customerId = text(formData, "customerId");
  const propertyId = text(formData, "propertyId");
  const contractValue = text(formData, "contractValue");
  const retentionPercent = Number(text(formData, "retentionPercent") || "5");
  const defectsLiabilityDays = Number(text(formData, "defectsLiabilityDays") || "365");

  if (name.length < 2) return { error: "Give the project a name." };
  if (!customerId) return { error: "Choose the customer this project is for." };
  if (!amount(contractValue)) {
    return { error: "Enter the contract value as a number, e.g. 480000.00" };
  }
  if (!Number.isFinite(retentionPercent) || retentionPercent < 0 || retentionPercent > 10) {
    return {
      error:
        "Retention is between 0 and 10 percent. Above that is not a term this market uses — it " +
        "is usually a percentage typed where basis points were meant.",
    };
  }
  if (!Number.isInteger(defectsLiabilityDays) || defectsLiabilityDays < 0) {
    return { error: "The defects liability period is a whole number of days." };
  }

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      createProject(tx, ctxOf(session), {
        customerId,
        propertyId: propertyId || null,
        name,
        scope: text(formData, "scope") || null,
        contractValue,
        startsOn: day(formData, "startsOn"),
        targetCompletionOn: day(formData, "targetCompletionOn"),
        retentionBasisPoints: Math.round(retentionPercent * 100),
        defectsLiabilityDays,
      }),
    );

    revalidatePath("/projects");
    return {
      ok:
        `Project ${result.reference} created, quoted. Add its phases and payment milestones, ` +
        "then move it to awarded when the client confirms.",
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The project could not be created. Check the customer, the property and the value.",
        "projects:create",
      ),
    };
  }
}

export async function transitionProjectAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const to = text(formData, "to") as ProjectStatus;

  if (!projectId) return { error: "Which project?" };
  if (!ALL_PROJECT_STATUSES.includes(to)) return { error: "Choose a status to move to." };

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      transitionProject(tx, ctxOf(session), {
        projectId,
        to,
        note: text(formData, "note") || undefined,
        practicalCompletionOn: day(formData, "practicalCompletionOn") ?? undefined,
      }),
    );

    refresh(projectId);
    return {
      ok:
        result.retentionDated > 0
          ? `Practical completion recorded. ${result.retentionDated} retention entries now have a ` +
            "due date — the first half is due now, the second at the end of the defects liability period."
          : `Moved to ${to.replace(/_/g, " ")}.`,
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The project could not be moved. Check its permits and its open snags.",
        "projects:transition",
      ),
    };
  }
}

// ── PRJ-2 ────────────────────────────────────────────────────────────────────

export async function addPhaseAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const name = text(formData, "name");
  const weightPercent = Number(text(formData, "weightPercent") || "0");

  if (!projectId) return { error: "Which project?" };
  if (name.length < 2) return { error: "Give the phase a name." };
  if (!Number.isFinite(weightPercent) || weightPercent < 0 || weightPercent > 100) {
    return { error: "A phase weight is a percentage of the whole project, 0 to 100." };
  }

  try {
    await withTenant(ctxOf(session), (tx) =>
      addPhase(tx, ctxOf(session), {
        projectId,
        name,
        serviceSlug: text(formData, "serviceSlug") || null,
        plannedStartOn: day(formData, "plannedStartOn"),
        plannedEndOn: day(formData, "plannedEndOn"),
        weightBasisPoints: Math.round(weightPercent * 100),
        dependsOnPhaseId: text(formData, "dependsOnPhaseId") || null,
      }),
    );

    refresh(projectId);
    return { ok: `Phase "${name}" added.` };
  } catch (error) {
    return {
      error: userMessage(error, "The phase could not be added.", "projects:phase"),
    };
  }
}

export async function setPhaseProgressAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const phaseId = text(formData, "phaseId");
  const percent = Number(text(formData, "percentComplete"));

  if (!phaseId) return { error: "Which phase?" };
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return { error: "Progress is a percentage between 0 and 100." };
  }

  try {
    await withTenant(ctxOf(session), (tx) =>
      setPhaseProgress(tx, ctxOf(session), { phaseId, percentComplete: percent }),
    );
    refresh(projectId);
    return { ok: "Progress recorded." };
  } catch (error) {
    return {
      error: userMessage(error, "The progress could not be recorded.", "projects:progress"),
    };
  }
}

/**
 * A `datetime-local` field, read as Dubai wall-clock time.
 *
 * The browser sends a naive `YYYY-MM-DDTHH:mm` with no zone in it, so somebody
 * has to decide what zone it meant. It meant the operator's, and every operator
 * of this system is in Asia/Dubai — UTC+4, no daylight saving, ever — so
 * `fromDubai` is exact rather than approximate. Parsing it with `new Date()`
 * would use the SERVER's zone instead, and a server in UTC would move every
 * date four hours earlier: outdoor work booked for 16:00 would be stored as
 * 12:00, which is inside the summer midday ban. The same helper, and the same
 * reasoning, as `jobs/[id]/actions.ts`.
 */
function dubaiDateTime(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!parts) return null;
  const [, year, month, day, hour, minute] = parts;
  return fromDubai(Number(year), Number(month), Number(day), Number(hour) * 60 + Number(minute));
}

/**
 * `PRJ-2`: raise a job from a phase.
 *
 * `projects:write`, not `jobs:write`. Deciding that a phase of a project needs
 * a day's work done is a project manager's act — the same person who entered
 * the phase, its weight and its trade — and reaching for the jobs boundary here
 * would have meant widening a grant to fill a gap in this module, which is the
 * failure mode the header of this file exists to describe. The RBAC boundaries
 * are asserted as whole sets in `packages/auth/test/rbac.test.ts`; nothing here
 * touches them.
 *
 * ── WHY THE EXPOSURE FIELD IS THREE-VALUED IN THIS FUNCTION ────────────────
 *
 * `is_outdoor` drives the summer midday ban, which costs AED 5,000 per worker.
 * A checkbox would have been the obvious control and it is the wrong one: an
 * unticked checkbox and an absent field are the same POST, so a request that
 * never mentioned exposure at all would arrive as "indoor" — the unsafe answer,
 * reached by omission. A select with two named values makes the operator choose,
 * and anything else (an empty string, a missing field, a hand-rolled `curl`)
 * falls through as `undefined` to the domain default, which is outdoor. The
 * safe direction has to be the one you get by not answering.
 */
export async function raiseJobForPhaseAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const phaseId = text(formData, "phaseId");
  const title = text(formData, "title");
  const priority = text(formData, "priority") as JobPriority;
  const scheduledForRaw = text(formData, "scheduledFor");

  if (!projectId) return { error: "Which project?" };
  if (!phaseId) return { error: "Which phase?" };
  if (title.length < 3) {
    return { error: "Give the job a title — it is what the technician reads first." };
  }
  if (!(priority in PRIORITY_LABEL)) return { error: "Choose the job's priority." };

  const scheduledFor = scheduledForRaw ? dubaiDateTime(scheduledForRaw) : null;
  if (scheduledForRaw && !scheduledFor) {
    return { error: "That date and time could not be read. Use the picker." };
  }

  // Three-valued on purpose. See the comment above: absent must not mean indoor.
  const exposure = text(formData, "exposure");
  const isOutdoor = exposure === "indoor" ? false : exposure === "outdoor" ? true : undefined;

  try {
    const raised = await withTenant(ctxOf(session), (tx) =>
      raiseJobForPhase(tx, ctxOf(session), {
        phaseId,
        title,
        description: text(formData, "description") || null,
        priority,
        serviceSlug: text(formData, "serviceSlug") || null,
        scheduledFor,
        isOutdoor,
      }),
    );

    refresh(projectId);
    // A job raised here appears on two boards this module knows nothing about,
    // and a dispatcher looking at a stale cache is a dispatcher who does not
    // know the work exists. Revalidated here rather than inside `refresh()`,
    // which every other write in this file shares and none of the others needs
    // this for.
    revalidatePath("/jobs");
    revalidatePath("/dispatch");

    return { ok: `Job ${raised.reference} raised and attached to the phase.` };
  } catch (error) {
    return {
      error: userMessage(error, "The job could not be raised.", "projects:phase-job"),
    };
  }
}

// ── PRJ-3 ────────────────────────────────────────────────────────────────────

export async function addMilestoneAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const name = text(formData, "name");
  const value = text(formData, "value");
  const triggerKind = text(formData, "triggerKind") as MilestoneTrigger;
  const percentRaw = text(formData, "triggerPercent");

  if (!projectId) return { error: "Which project?" };
  if (name.length < 2) return { error: "Give the milestone a name." };
  if (!amount(value)) return { error: "Enter the milestone value as a number, e.g. 144000.00" };
  if (!MILESTONE_TRIGGERS.includes(triggerKind)) return { error: "Choose what triggers it." };

  try {
    await withTenant(ctxOf(session), (tx) =>
      addMilestone(tx, ctxOf(session), {
        projectId,
        phaseId: text(formData, "phaseId") || null,
        name,
        value,
        triggerKind,
        triggerOn: day(formData, "triggerOn"),
        triggerPercent: percentRaw === "" ? null : Number(percentRaw),
      }),
    );

    refresh(projectId);
    return { ok: `Milestone "${name}" added.` };
  } catch (error) {
    return {
      error: userMessage(error, "The milestone could not be added.", "projects:milestone"),
    };
  }
}

export async function markMilestoneReachedAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const milestoneId = text(formData, "milestoneId");
  const note = text(formData, "note");

  if (!milestoneId) return { error: "Which milestone?" };

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      markMilestoneReached(tx, ctxOf(session), { milestoneId, note: note || undefined }),
    );
    refresh(projectId);
    return {
      ok: `"${result.name}" recorded as reached. It can now be invoiced.`,
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The milestone could not be recorded as reached.",
        "projects:reached",
      ),
    };
  }
}

/**
 * `PRJ-3`: raise the invoice.
 *
 * `invoices:create`, not `projects:write`. See the module header — this
 * allocates a sequential tax-invoice number, which is not the same act as
 * certifying that a stage of work is done.
 */
export async function raiseMilestoneInvoiceAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await requireSessionWith("invoices:create");
  const projectId = text(formData, "projectId");
  const milestoneId = text(formData, "milestoneId");

  if (!milestoneId) return { error: "Which milestone?" };

  const ctx = { tenantId: session.principal.tenantId, userId: session.principal.userId };

  try {
    const result = await withTenant(ctx, (tx) =>
      raiseMilestoneInvoice(tx, ctx, { milestoneId }),
    );

    refresh(projectId);
    revalidatePath("/invoices");
    return {
      ok:
        `Invoice ${result.reference} issued.` +
        (result.retentionWithheldMinor > 0
          ? " Retention has been withheld against it in two entries — one released on practical " +
            "completion, one at the end of the defects liability period."
          : ""),
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The invoice could not be raised. Check that the milestone is reached and not already invoiced.",
        "projects:invoice",
      ),
    };
  }
}

// ── PRJ-4 ────────────────────────────────────────────────────────────────────

export async function raiseVariationAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const title = text(formData, "title");
  const value = text(formData, "value");
  const impactRaw = text(formData, "programmeImpactDays");

  if (!projectId) return { error: "Which project?" };
  if (title.length < 2) return { error: "Give the variation a title." };
  if (!amount(value)) {
    return {
      error:
        "Enter the change in value, e.g. 18500.00 for extra work or -6200.00 for an omission. " +
        "An omission is a variation too.",
    };
  }

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      raiseVariation(tx, ctxOf(session), {
        projectId,
        title,
        description: text(formData, "description") || null,
        value,
        instructedBy: text(formData, "instructedBy") || null,
        instructedOn: day(formData, "instructedOn"),
        programmeImpactDays: impactRaw === "" ? 0 : Number(impactRaw),
      }),
    );

    refresh(projectId);
    return {
      ok:
        `Variation ${result.reference} raised as a draft. It totals separately from the contract ` +
        "value until the client approves it.",
    };
  } catch (error) {
    return {
      error: userMessage(error, "The variation could not be raised.", "projects:variation"),
    };
  }
}

export async function decideVariationAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const variationId = text(formData, "variationId");
  const to = text(formData, "to") as VariationState;

  if (!variationId) return { error: "Which variation?" };
  if (!VARIATION_STATES.includes(to)) return { error: "Choose a state to move it to." };

  const clientReference = text(formData, "clientReference");

  try {
    await withTenant(ctxOf(session), (tx) =>
      decideVariation(tx, ctxOf(session), {
        variationId,
        to,
        clientReference: clientReference || undefined,
        reason: text(formData, "reason") || undefined,
      }),
    );

    refresh(projectId);
    return {
      ok:
        to === "approved" && !clientReference
          ? "Approved. There is no client approval reference against it — that is the document " +
            "the final account will ask for, so add it as soon as it arrives."
          : `Variation moved to ${to}.`,
    };
  } catch (error) {
    return {
      error: userMessage(error, "The variation could not be moved.", "projects:vo-state"),
    };
  }
}

// ── PRJ-5 ────────────────────────────────────────────────────────────────────

export async function releaseRetentionAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const retentionId = text(formData, "retentionId");

  if (!retentionId) return { error: "Which retention entry?" };

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      releaseRetention(tx, ctxOf(session), {
        retentionId,
        releasedOn: day(formData, "releasedOn") ?? undefined,
        note: text(formData, "note") || undefined,
      }),
    );

    refresh(projectId);
    return { ok: `Released. Record the payment against the invoice when it arrives.` };
  } catch (error) {
    return {
      error: userMessage(error, "The retention could not be released.", "projects:retention"),
    };
  }
}

// ── PRJ-6 ────────────────────────────────────────────────────────────────────

export async function recordPermitAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const authorityCode = text(formData, "authorityCode");
  const permitType = text(formData, "permitType");
  const status = text(formData, "status") as PermitStatus;
  const feePaid = text(formData, "feePaid");

  if (!projectId) return { error: "Which project?" };
  if (!authorityCode) return { error: "Choose the authority this permit is issued by." };
  if (permitType.length < 2) return { error: "Say what kind of permit this is." };
  if (!PERMIT_STATUSES.includes(status)) return { error: "Choose where the permit has got to." };
  if (feePaid && !amount(feePaid)) return { error: "Enter the fee as a number, e.g. 1500.00" };

  try {
    await withTenant(ctxOf(session), (tx) =>
      recordPermit(tx, ctxOf(session), {
        projectId,
        authorityCode,
        permitType,
        referenceNumber: text(formData, "referenceNumber") || null,
        status,
        // Absent means unticked. Defaulting to required is the safe direction:
        // a permit entered and not flagged is a permit that stops blocking, and
        // the reason to enter it was that it blocks.
        isRequired: formData.get("isRequired") !== null,
        appliedOn: day(formData, "appliedOn"),
        approvedOn: day(formData, "approvedOn"),
        expiresOn: day(formData, "expiresOn"),
        feePaid: feePaid || "0",
        notes: text(formData, "notes") || null,
      }),
    );

    refresh(projectId);
    return { ok: `${permitType} recorded.` };
  } catch (error) {
    return {
      error: userMessage(error, "The permit could not be recorded.", "projects:permit"),
    };
  }
}

export async function setPermitStatusAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const permitId = text(formData, "permitId");
  const status = text(formData, "status") as PermitStatus;

  if (!permitId) return { error: "Which permit?" };
  if (!PERMIT_STATUSES.includes(status)) return { error: "Choose a status." };

  const expiresOn = day(formData, "expiresOn");
  if (status === "approved" && !day(formData, "approvedOn")) {
    return { error: "An approved permit needs the date it was approved." };
  }

  try {
    await withTenant(ctxOf(session), (tx) =>
      setPermitStatus(tx, ctxOf(session), {
        permitId,
        status,
        referenceNumber: text(formData, "referenceNumber") || null,
        approvedOn: day(formData, "approvedOn"),
        expiresOn,
      }),
    );

    refresh(projectId);
    return {
      ok:
        status === "approved" && !expiresOn
          ? "Approved, with no expiry recorded. If the approval does expire, add the date — an " +
            "approval with no end date is one nobody will re-check."
          : "Permit updated.",
    };
  } catch (error) {
    return {
      error: userMessage(error, "The permit could not be updated.", "projects:permit-state"),
    };
  }
}

/**
 * Staple an uploaded file to a permit (`PRJ-6`, "documents attached").
 *
 * ── WHAT THIS FORM CARRIES, AND WHAT IT REFUSES TO CARRY ───────────────────
 *
 * An **upload id**. Not a storage key, not a filename, not a path. The bytes
 * went up through `/api/uploads`, which authorised them against
 * `projects:write` for the purpose `project_permit_document` and recorded that
 * purpose on the session row; `attachPermitDocument` reads the key off that row
 * inside the tenant transaction. A hidden field holding a storage key would
 * look identical on the screen and would let anyone who can post this form
 * attach any object in the store to any permit they can see.
 */
export async function attachPermitDocumentAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const permitId = text(formData, "permitId");
  const uploadId = text(formData, "uploadId");

  if (!permitId) return { error: "Which permit?" };
  if (!uploadId) return { error: "Choose a file — nothing was uploaded." };

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      attachPermitDocument(tx, ctxOf(session), {
        permitId,
        uploadId,
        replace: formData.get("replace") !== null,
      }),
    );

    refresh(projectId);
    return {
      ok: result.replaced
        ? "Document replaced. The superseded file is kept and the swap is on the audit log — the " +
          "register has to be able to show what was on file when the site gate passed."
        : "Document attached to the permit.",
    };
  } catch (error) {
    return {
      error: userMessage(error, "The document could not be attached.", "projects:permit-doc"),
    };
  }
}

// ── PRJ-7 ────────────────────────────────────────────────────────────────────

export async function raiseSnagAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const locationText = text(formData, "locationText");
  const tradeCode = text(formData, "tradeCode");
  const severity = text(formData, "severity") as SnagSeverity;
  const description = text(formData, "description");

  if (!projectId) return { error: "Which project?" };
  if (locationText.length < 2) {
    return { error: "Say where it is. 'Level 12, meeting room 2, east wall'." };
  }
  if (!tradeCode) return { error: "Choose the trade this snag belongs to." };
  if (!SNAG_SEVERITIES.includes(severity)) return { error: "Choose a severity." };
  if (description.length < 3) {
    return { error: "Describe the snag. A one-word snag is one nobody can close." };
  }

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      raiseSnag(tx, ctxOf(session), {
        projectId,
        phaseId: text(formData, "phaseId") || null,
        locationText,
        tradeCode,
        severity,
        description,
        responsibleParty: text(formData, "responsibleParty") || "us",
        subcontractorId: text(formData, "subcontractorId") || null,
        targetOn: day(formData, "targetOn"),
        raisedBy: text(formData, "raisedBy") || null,
      }),
    );

    refresh(projectId);
    return {
      ok:
        severity === "critical"
          ? `Snag ${result.sequence} raised as critical. Practical completion cannot be recorded ` +
            "while it is open."
          : `Snag ${result.sequence} raised.`,
    };
  } catch (error) {
    return { error: userMessage(error, "The snag could not be raised.", "projects:snag") };
  }
}

export async function closeSnagAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const snagId = text(formData, "snagId");
  const closureNote = text(formData, "closureNote");

  if (!snagId) return { error: "Which snag?" };
  if (closureNote.length < 3) {
    return {
      error:
        "Say what was done. A snag closed with no evidence is one that gets raised again at " +
        "handover by somebody standing in front of it.",
    };
  }

  const rejected = text(formData, "status") === "rejected";

  try {
    await withTenant(ctxOf(session), (tx) =>
      closeSnag(tx, ctxOf(session), {
        snagId,
        closureNote,
        status: rejected ? "rejected" : "closed",
      }),
    );

    refresh(projectId);
    return { ok: rejected ? "Snag rejected, with the reason recorded." : "Snag closed." };
  } catch (error) {
    return { error: userMessage(error, "The snag could not be closed.", "projects:snag-close") };
  }
}

/**
 * The snag photograph, or the photograph that closes it (`PRJ-7`).
 *
 * Same rule as the permit above: an upload id crosses the wire, never a storage
 * key. The slot is a two-value vocabulary checked here rather than passed
 * through, because `"photo" | "closure"` reaching the domain layer as an
 * unchecked string is one typo away from writing a column nobody asked for.
 *
 * Attach, then close. The upload is chunked and can take a minute on site wifi;
 * holding the closure form open across it would be the one thing the resumable
 * transport exists to avoid.
 */
export async function attachSnagPhotoAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const snagId = text(formData, "snagId");
  const uploadId = text(formData, "uploadId");
  const slot = text(formData, "slot");

  if (!snagId) return { error: "Which snag?" };
  if (!uploadId) return { error: "Choose a photograph — nothing was uploaded." };
  if (slot !== "photo" && slot !== "closure") {
    return { error: "Say whether this is the snag photograph or the closure evidence." };
  }

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      attachSnagPhoto(tx, ctxOf(session), {
        snagId,
        uploadId,
        slot,
        replace: formData.get("replace") !== null,
      }),
    );

    refresh(projectId);
    const what = slot === "closure" ? "Closure evidence" : "Snag photograph";
    return {
      ok: result.replaced
        ? `${what} replaced. The superseded photograph is kept and the swap is on the audit log.`
        : `${what} attached.`,
    };
  } catch (error) {
    return {
      error: userMessage(error, "The photograph could not be attached.", "projects:snag-photo"),
    };
  }
}

// ── PRJ-8 ────────────────────────────────────────────────────────────────────

export async function recordCostAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const category = text(formData, "category") as CostCategory;
  const description = text(formData, "description");
  const quantity = text(formData, "quantity");
  const unitCost = text(formData, "unitCost");

  if (!projectId) return { error: "Which project?" };
  if (!COST_CATEGORIES.includes(category)) return { error: "Choose what kind of cost this is." };
  if (description.length < 2) return { error: "Say what this cost is for." };
  if (!/^\d+(\.\d{1,3})?$/.test(quantity)) {
    return { error: "Enter the quantity — hours for labour, units for everything else." };
  }
  if (!amount(unitCost)) return { error: "Enter the unit cost as a number, e.g. 32.50" };

  try {
    const result = await withTenant(ctxOf(session), (tx) =>
      recordCost(tx, ctxOf(session), {
        projectId,
        phaseId: text(formData, "phaseId") || null,
        category,
        description,
        incurredOn: day(formData, "incurredOn") ?? undefined,
        quantity,
        unit: text(formData, "unit") || undefined,
        unitCost,
        isCommitted: formData.get("isCommitted") !== null,
        supplierReference: text(formData, "supplierReference") || null,
      }),
    );

    refresh(projectId);
    return { ok: `Cost recorded: ${(result.amountMinor / 100).toFixed(2)} AED.` };
  } catch (error) {
    return { error: userMessage(error, "The cost could not be recorded.", "projects:cost") };
  }
}

// ── PRJ-9 ────────────────────────────────────────────────────────────────────

export async function engageSubcontractorAction(
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  const session = await write();
  const projectId = text(formData, "projectId");
  const subcontractorId = text(formData, "subcontractorId");
  const scope = text(formData, "scope");
  const value = text(formData, "value");

  if (!projectId) return { error: "Which project?" };
  if (!subcontractorId) return { error: "Choose the subcontractor from the register." };
  if (scope.length < 3) return { error: "Say what they are engaged to do." };
  if (!amount(value)) return { error: "Enter the subcontract value as a number." };

  try {
    await withTenant(ctxOf(session), (tx) =>
      engageSubcontractor(tx, ctxOf(session), {
        projectId,
        subcontractorId,
        phaseId: text(formData, "phaseId") || null,
        scope,
        value,
        clientApprovalState: text(formData, "clientApprovalState") || "pending",
        clientApprovedOn: day(formData, "clientApprovedOn"),
        clientApprovalReference: text(formData, "clientApprovalReference") || null,
        startsOn: day(formData, "startsOn"),
        endsOn: day(formData, "endsOn"),
      }),
    );

    refresh(projectId);
    return {
      ok:
        "Engaged. The value counts against the project margin as committed cost from now, not " +
        "from the day the first invoice arrives.",
    };
  } catch (error) {
    return {
      error: userMessage(error, "The subcontractor could not be engaged.", "projects:subcontract"),
    };
  }
}
