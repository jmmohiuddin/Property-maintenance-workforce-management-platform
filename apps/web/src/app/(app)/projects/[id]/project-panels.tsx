"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import {
  COST_CATEGORIES,
  COST_CATEGORY_LABEL,
  MILESTONE_TRIGGERS,
  MILESTONE_TRIGGER_LABEL,
  PERMIT_STATUSES,
  PERMIT_STATUS_LABEL,
  PRIORITY_LABEL,
  PROJECT_STATUS_LABEL,
  SNAG_PARTY_LABEL,
  SNAG_SEVERITIES,
  SNAG_SEVERITY_LABEL,
  VARIATION_STATE_LABEL,
  type JobPriority,
  type ProjectStatus,
  type VariationState,
} from "@meridian/core";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import { uploadFile, type BrowserUploadPurpose } from "./upload-file";
import {
  addMilestoneAction,
  addPhaseAction,
  attachPermitDocumentAction,
  attachSnagPhotoAction,
  closeSnagAction,
  decideVariationAction,
  engageSubcontractorAction,
  markMilestoneReachedAction,
  raiseMilestoneInvoiceAction,
  raiseJobForPhaseAction,
  raiseSnagAction,
  raiseVariationAction,
  recordCostAction,
  recordPermitAction,
  releaseRetentionAction,
  setPermitStatusAction,
  setPhaseProgressAction,
  transitionProjectAction,
  type ProjectFormState,
} from "../actions";

const INITIAL: ProjectFormState = {};

/**
 * A subcontractor's paperwork, as a word in the picker.
 *
 * `unknown` is its own state and does not collapse into "licence and insurance
 * current". A trade licence nobody has recorded is not a valid trade licence —
 * it is a subcontractor about to be sent to a client's building with no
 * evidence they may lawfully be there.
 */
/**
 * Job priorities, planned first.
 *
 * `@meridian/core` exports the labels but no ordered list, and the order here
 * is not the enum's. Work raised from a programme is planned work by default,
 * so the option an operator will pick nine times in ten sits at the top and is
 * the one already selected. Emergency is last because a construction phase that
 * genuinely needs a P1 is a phone call, not a form.
 */
const JOB_PRIORITIES: readonly JobPriority[] = [
  "p4_planned",
  "p3_standard",
  "p2_urgent",
  "p1_emergency",
];

const COMPLIANCE_LABEL: Readonly<Record<string, string>> = {
  valid: "licence and insurance current",
  expiring: "licence or insurance expiring within 30 days",
  expired: "LICENCE OR INSURANCE EXPIRED",
  unknown: "licence or insurance not recorded",
};

/**
 * The write surfaces on the project detail screen.
 *
 * One client component per panel rather than one for the page. Each holds its
 * own `useActionState`, so a failed snag closure does not blank the banner on
 * the milestone panel above it — which is what a single shared state does, and
 * it reads as the form having lost the operator's work.
 *
 * Every one of these is a plain server-action form. Nothing here needs
 * JavaScript to submit; `useActionState` adds the pending label and the inline
 * result, and without it the browser posts and re-renders. That is the same
 * bargain the rest of the application makes, and it is the reason a supervisor
 * can close a snag from a site office.
 */

function Banner({ state }: { state: ProjectFormState }) {
  return (
    <>
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}
    </>
  );
}

/**
 * Move the project through its status machine (`PRJ-1`).
 *
 * The picker offers only the legal next steps — the graph is in
 * `@meridian/core` so the browser can render it, and the domain layer refuses
 * anything else regardless. Offering every status and refusing eight of them
 * would teach the operator that the screen guesses.
 */
export function TransitionPanel({
  projectId,
  status,
  allowed,
}: {
  projectId: string;
  status: ProjectStatus;
  allowed: readonly ProjectStatus[];
}) {
  const [state, formAction, pending] = useActionState(transitionProjectAction, INITIAL);

  if (allowed.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        {PROJECT_STATUS_LABEL[status]} is a terminal status. Nothing moves from here.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <Banner state={state} />
      <input type="hidden" name="projectId" value={projectId} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Move to" description="Only the legal next steps are offered.">
          {({ id, describedBy }) => (
            <Select id={id} name="to" required defaultValue="" aria-describedby={describedBy}>
              <option value="" disabled>
                Choose
              </option>
              {allowed.map((s) => (
                <option key={s} value={s}>
                  {PROJECT_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {allowed.includes("practical_completion") ? (
          <Field
            label="Practical completion date"
            description="Defaults to today. It fixes both retention release dates."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="practicalCompletionOn"
                type="date"
                aria-describedby={describedBy}
              />
            )}
          </Field>
        ) : null}

        <Field label="Note" description="Why, for the audit trail.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="note" maxLength={200} aria-describedby={describedBy} />
          )}
        </Field>
      </div>

      <SubmitButton pending={pending} pendingLabel="Moving…" className="btn btn-primary disabled:opacity-60">
        Move project
      </SubmitButton>
    </form>
  );
}

/**
 * `PRJ-2`: add a phase, record progress on the ones that exist, and raise the
 * jobs a phase produces.
 *
 * The third form is the half of `PRJ-2` that was missing. Phases, weights and
 * dependencies were all here; nothing raised work from them, so the Jobs column
 * on the table above rendered a truthful zero for every phase of every project.
 */
export function PhasePanel({
  projectId,
  phases,
  weightGap,
}: {
  projectId: string;
  phases: {
    id: string;
    sequence: number;
    name: string;
    percentComplete: number;
    serviceSlug: string | null;
  }[];
  weightGap: number;
}) {
  const [addState, addAction, addPending] = useActionState(addPhaseAction, INITIAL);
  const [progressState, progressAction, progressPending] = useActionState(
    setPhaseProgressAction,
    INITIAL,
  );
  const [jobState, jobAction, jobPending] = useActionState(
    raiseJobForPhaseAction,
    INITIAL,
  );

  return (
    <div className="space-y-6">
      {weightGap !== 0 && phases.length > 0 ? (
        <FormBanner tone="info">
          The phase weights total {(10_000 - weightGap) / 100}% of the project, not 100%. Every
          completion percentage on this screen is computed against that total, so it is currently
          measuring progress against {(10_000 - weightGap) / 100}% of the job.
        </FormBanner>
      ) : null}

      {phases.length > 0 ? (
        <form action={progressAction} className="space-y-4">
          <Banner state={progressState} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Phase">
              {({ id, describedBy }) => (
                <Select id={id} name="phaseId" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {phases.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.sequence}. {p.name} ({p.percentComplete}%)
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Complete, %"
              description="The status follows the number, so the two cannot disagree."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="percentComplete"
                  type="number"
                  min="0"
                  max="100"
                  required
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <div className="flex items-end">
              <SubmitButton
                pending={progressPending}
                pendingLabel="Saving…"
                className="btn btn-secondary disabled:opacity-60"
              >
                Record progress
              </SubmitButton>
            </div>
          </div>
        </form>
      ) : null}

      {/*
        Hidden until a phase exists. A picker with no options is a form that cannot be
        submitted, and the empty state above the table already says what to do instead.
      */}
      {phases.length > 0 ? (
        <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
          <summary className="cursor-pointer text-[13px] font-semibold">Raise a job from a phase</summary>
          <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
            The job is created the way every other job in this system is created: a{" "}
            <span className="tnum">JOB-</span> reference allocated by the database, an SLA clock
            computed against the working calendar an administrator maintains, and the summer midday
            ban applying when a visit is booked against it. It then appears on the jobs board and
            the dispatch board, attached to this phase.
          </p>
          <form action={jobAction} className="mt-4 space-y-4">
            <Banner state={jobState} />
            <input type="hidden" name="projectId" value={projectId} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Phase">
                {({ id, describedBy }) => (
                  <Select id={id} name="phaseId" required defaultValue="" aria-describedby={describedBy}>
                    <option value="" disabled>
                      Choose
                    </option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sequence}. {p.name}
                        {p.serviceSlug ? ` · ${p.serviceSlug}` : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="What is the job" description="The line a technician reads first.">
                {({ id, describedBy }) => (
                  <TextInput
                    id={id}
                    name="title"
                    required
                    minLength={3}
                    maxLength={240}
                    placeholder="Second fix containment, level 12 north"
                    aria-describedby={describedBy}
                  />
                )}
              </Field>
              <Field
                label="Trade"
                description="Blank takes the phase's own trade. It is what dispatch matches a technician's skills against."
              >
                {({ id, describedBy }) => (
                  <TextInput
                    id={id}
                    name="serviceSlug"
                    maxLength={64}
                    placeholder="electrical"
                    aria-describedby={describedBy}
                  />
                )}
              </Field>
              <Field label="Priority" description="Programme work is planned work. The SLA clock follows this.">
                {({ id, describedBy }) => (
                  <Select id={id} name="priority" defaultValue="p4_planned" aria-describedby={describedBy}>
                    {JOB_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label="Exposure"
                description="Outdoor work is refused between 12:30 and 15:00 from 15 June to 15 September. AED 5,000 per worker."
              >
                {({ id, describedBy }) => (
                  <Select id={id} name="exposure" defaultValue="outdoor" aria-describedby={describedBy}>
                    <option value="outdoor">In direct sun — outdoor</option>
                    <option value="indoor">Indoors or shaded</option>
                  </Select>
                )}
              </Field>
              <Field label="Planned for" description="Optional. The visit itself is booked on the job.">
                {({ id, describedBy }) => (
                  <TextInput id={id} name="scheduledFor" type="datetime-local" aria-describedby={describedBy} />
                )}
              </Field>
            </div>

            <Field label="Instructions" description="Optional.">
              {({ id, describedBy }) => (
                <TextArea id={id} name="description" rows={3} aria-describedby={describedBy} />
              )}
            </Field>

            <SubmitButton
              pending={jobPending}
              pendingLabel="Raising…"
              className="btn btn-secondary disabled:opacity-60"
            >
              Raise job
            </SubmitButton>
          </form>
        </details>
      ) : null}

      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">Add a phase</summary>
        <form action={addAction} className="mt-4 space-y-4">
          <Banner state={addState} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phase name">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="name"
                  required
                  minLength={2}
                  placeholder="MEP first fix"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field
              label="Weight, % of the project"
              description="Not all phases are the same size. This is what makes a completion figure mean anything."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="weightPercent"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Planned start">
              {({ id, describedBy }) => (
                <TextInput id={id} name="plannedStartOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Planned end">
              {({ id, describedBy }) => (
                <TextInput id={id} name="plannedEndOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            {phases.length > 0 ? (
              <Field label="Cannot start before" description="Optional dependency.">
                {({ id, describedBy }) => (
                  <Select id={id} name="dependsOnPhaseId" defaultValue="" aria-describedby={describedBy}>
                    <option value="">No dependency</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sequence}. {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>

          <SubmitButton
            pending={addPending}
            pendingLabel="Adding…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Add phase
          </SubmitButton>
        </form>
      </details>
    </div>
  );
}

/**
 * `PRJ-3`: define milestones, record them reached, and raise the invoice.
 *
 * Three separate forms, and the split between the last two is the point.
 * Certifying that a stage of work is done and allocating a sequential tax
 * invoice number are different acts by different people, and they take
 * different permissions — see the header of `actions.ts`.
 */
export function MilestonePanel({
  projectId,
  milestones,
  phases,
  canWrite,
  canInvoice,
}: {
  projectId: string;
  milestones: {
    id: string;
    sequence: number;
    name: string;
    status: string;
    triggerMet: boolean | null;
  }[];
  phases: { id: string; sequence: number; name: string }[];
  /**
   * The two halves of this panel take DIFFERENT permissions, which is why they
   * are passed separately rather than as one `canEdit`.
   *
   * An accountant holds `invoices:create` and `projects:read`: they raise the
   * invoice and may not certify the milestone. A project manager holds
   * `projects:write` and usually not `invoices:create`: the reverse. Rendering
   * either form to the role that cannot submit it would put a button on screen
   * whose only outcome is a refusal.
   */
  canWrite: boolean;
  canInvoice: boolean;
}) {
  const [addState, addAction, addPending] = useActionState(addMilestoneAction, INITIAL);
  const [reachState, reachAction, reachPending] = useActionState(markMilestoneReachedAction, INITIAL);
  const [invoiceState, invoiceAction, invoicePending] = useActionState(
    raiseMilestoneInvoiceAction,
    INITIAL,
  );

  const pending = milestones.filter((m) => m.status === "pending");
  const reached = milestones.filter((m) => m.status === "reached");

  return (
    <div className="space-y-6">
      {canWrite && pending.length > 0 ? (
        <form action={reachAction} className="space-y-4">
          <Banner state={reachState} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Milestone reached">
              {({ id, describedBy }) => (
                <Select id={id} name="milestoneId" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {pending.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.sequence}. {m.name}
                      {m.triggerMet === true ? " — trigger met" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Evidence"
              description="For a client sign-off this is the only record there is — no query can decide it."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="note"
                  maxLength={200}
                  placeholder="Signed certificate received from the consultant."
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <div className="flex items-end">
              <SubmitButton
                pending={reachPending}
                pendingLabel="Recording…"
                className="btn btn-secondary disabled:opacity-60"
              >
                Record as reached
              </SubmitButton>
            </div>
          </div>
        </form>
      ) : null}

      {reached.length > 0 ? (
        canInvoice ? (
          <form action={invoiceAction} className="space-y-4">
            <Banner state={invoiceState} />
            <input type="hidden" name="projectId" value={projectId} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Raise the invoice for"
                description="Issued immediately with a sequential number. It cannot be deleted afterwards, only credited."
              >
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    name="milestoneId"
                    required
                    defaultValue=""
                    aria-describedby={describedBy}
                  >
                    <option value="" disabled>
                      Choose
                    </option>
                    {reached.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.sequence}. {m.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="flex items-end">
                <SubmitButton
                  pending={invoicePending}
                  pendingLabel="Issuing…"
                  className="btn btn-primary disabled:opacity-60"
                >
                  Raise invoice
                </SubmitButton>
              </div>
            </div>
          </form>
        ) : (
          <FormBanner tone="info">
            {reached.length} milestone{reached.length === 1 ? " is" : "s are"} reached and awaiting
            an invoice. Raising it allocates a sequential tax-invoice number, which needs the
            invoicing permission — this is the accountant&rsquo;s step, not the project
            manager&rsquo;s.
          </FormBanner>
        )
      ) : null}

      {canWrite ? (
      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">Add a milestone</summary>
        <form action={addAction} className="mt-4 space-y-4">
          <Banner state={addState} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Milestone name">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="name"
                  required
                  minLength={2}
                  placeholder="Mobilisation, 30%"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Value, AED excluding VAT">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="value"
                  required
                  inputMode="decimal"
                  placeholder="144000.00"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field
              label="Triggered by"
              description="A client sign-off is recorded by a person; the other two are checked against the project."
            >
              {({ id, describedBy }) => (
                <Select id={id} name="triggerKind" required defaultValue="client_sign_off" aria-describedby={describedBy}>
                  {MILESTONE_TRIGGERS.map((t) => (
                    <option key={t} value={t}>
                      {MILESTONE_TRIGGER_LABEL[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {phases.length > 0 ? (
              <Field label="Against phase" description="Optional. A mobilisation payment has no phase.">
                {({ id, describedBy }) => (
                  <Select id={id} name="phaseId" defaultValue="" aria-describedby={describedBy}>
                    <option value="">The project as a whole</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sequence}. {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
            <Field label="Trigger date" description="Required for a date-triggered milestone.">
              {({ id, describedBy }) => (
                <TextInput id={id} name="triggerOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Trigger at, % complete" description="Required for a percentage trigger.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="triggerPercent"
                  type="number"
                  min="1"
                  max="100"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
          </div>

          <SubmitButton
            pending={addPending}
            pendingLabel="Adding…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Add milestone
          </SubmitButton>
        </form>
      </details>
      ) : null}
    </div>
  );
}

/** `PRJ-4`: raise a variation and move it through its approval states. */
export function VariationPanel({
  projectId,
  variations,
}: {
  projectId: string;
  variations: { id: string; reference: string; title: string; approvalState: VariationState }[];
}) {
  const [raiseState, raiseAction, raisePending] = useActionState(raiseVariationAction, INITIAL);
  const [decideState, decideAction, decidePending] = useActionState(decideVariationAction, INITIAL);

  const movable = variations.filter(
    (v) => v.approvalState !== "approved" && v.approvalState !== "withdrawn",
  );

  return (
    <div className="space-y-6">
      {movable.length > 0 ? (
        <form action={decideAction} className="space-y-4">
          <Banner state={decideState} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Variation">
              {({ id, describedBy }) => (
                <Select id={id} name="variationId" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {movable.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.reference} — {v.title}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Move to">
              {({ id, describedBy }) => (
                <Select id={id} name="to" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {(["submitted", "approved", "rejected", "withdrawn"] as const).map((s) => (
                    <option key={s} value={s}>
                      {VARIATION_STATE_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Client reference"
              description="The document the final account will ask for."
            >
              {({ id, describedBy }) => (
                <TextInput id={id} name="clientReference" maxLength={64} aria-describedby={describedBy} />
              )}
            </Field>
            <div className="flex items-end">
              <SubmitButton
                pending={decidePending}
                pendingLabel="Saving…"
                className="btn btn-secondary disabled:opacity-60"
              >
                Update
              </SubmitButton>
            </div>
          </div>
        </form>
      ) : null}

      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">Raise a variation</summary>
        <p className="prose-body mt-2 text-[13px]">
          Enter the change in value — negative for an omission. Unrecorded variations are the
          standard way a fit-out contractor loses money, and it is never one big one; it is forty
          small changes nobody wrote down.
        </p>
        <form action={raiseAction} className="mt-4 space-y-4">
          <Banner state={raiseState} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="title"
                  required
                  minLength={2}
                  placeholder="Additional power to server room"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Change in value, AED" description="Negative for an omission.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="value"
                  required
                  inputMode="decimal"
                  placeholder="18500.00"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Instructed by" description="Who asked for it, on site, in their words.">
              {({ id, describedBy }) => (
                <TextInput id={id} name="instructedBy" maxLength={160} aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Instructed on">
              {({ id, describedBy }) => (
                <TextInput id={id} name="instructedOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Programme impact, days" description="A variation costs time as well as money.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="programmeImpactDays"
                  type="number"
                  min="0"
                  max="365"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
          </div>

          <Field label="What changed">
            {({ id, describedBy }) => (
              <TextArea id={id} name="description" rows={2} aria-describedby={describedBy} />
            )}
          </Field>

          <SubmitButton
            pending={raisePending}
            pendingLabel="Raising…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Raise variation
          </SubmitButton>
        </form>
      </details>
    </div>
  );
}

/** `PRJ-5`: release a retention entry. Never automatic — see `domain/projects.ts`. */
export function RetentionPanel({
  projectId,
  entries,
}: {
  projectId: string;
  entries: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(releaseRetentionAction, INITIAL);

  if (entries.length === 0) return null;

  return (
    <form action={formAction} className="space-y-4">
      <Banner state={state} />
      <input type="hidden" name="projectId" value={projectId} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Release"
          description="Only entries whose due date is fixed. Practical completion sets it."
        >
          {({ id, describedBy }) => (
            <Select id={id} name="retentionId" required defaultValue="" aria-describedby={describedBy}>
              <option value="" disabled>
                Choose
              </option>
              {entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Released on" description="Defaults to today.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="releasedOn" type="date" aria-describedby={describedBy} />
          )}
        </Field>
        <div className="flex items-end">
          <SubmitButton
            pending={pending}
            pendingLabel="Releasing…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Mark released
          </SubmitButton>
        </div>
      </div>
    </form>
  );
}

/**
 * The one control on this screen that genuinely needs JavaScript.
 *
 * ── WHY IT BREAKS THE FILE'S OWN RULE ──────────────────────────────────────
 *
 * Every other form here is a plain server-action post that works with
 * JavaScript switched off. This one cannot be: the file goes up in parts, each
 * part is a separate idempotent request, and the server is asked between passes
 * which parts are still missing. That is what makes a 12 MB permit PDF survive
 * a site connection, and there is no version of it that a browser form post can
 * express. The trade is deliberate and it is confined to this component — the
 * permit and the snag are still recorded, updated and closed without it.
 *
 * ── WHY THE FORM POSTS AN UPLOAD ID AND NOT A FILE ─────────────────────────
 *
 * The bytes never touch the server action. They go to `/api/uploads`, which
 * authorises them against the same `projects:write` the action takes and stamps
 * the purpose onto the session row; what crosses into the action afterwards is
 * the session id. The action then reads the storage key off that row, server
 * side, inside the tenant transaction. No field on this form — hidden or
 * otherwise — carries a storage key, and that is the point: a key in a form is
 * a key an operator can edit.
 */
function AttachForm({
  purpose,
  accept,
  attach,
  fileLabel,
  fileDescription,
  replaceLabel,
  submitLabel,
  children,
}: {
  purpose: BrowserUploadPurpose;
  accept: string;
  attach: (
    prev: ProjectFormState,
    formData: FormData,
  ) => Promise<ProjectFormState>;
  fileLabel: string;
  fileDescription: string;
  replaceLabel: string;
  submitLabel: string;
  children: React.ReactNode;
}) {
  const [state, setState] = useState<ProjectFormState>(INITIAL);
  const [phase, setPhase] = useState("");
  const router = useRouter();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (phase) return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    // The bytes are removed from the payload before it goes anywhere near the
    // server action. What is left is the upload id and the identifiers.
    data.delete("file");

    if (!(file instanceof File) || file.size === 0) {
      setState({ error: "Choose a file first." });
      return;
    }

    setState(INITIAL);

    try {
      const uploaded = await uploadFile({
        file,
        purpose,
        reference: file.name,
        onPhase: setPhase,
      });
      data.set("uploadId", uploaded.uploadId);
      setPhase("attaching");

      const result = await attach(INITIAL, data);
      setState(result);
      if (result.ok) {
        form.reset();
        // The action revalidated the path; this is what makes the table above
        // redraw without the operator reloading and wondering whether it saved.
        router.refresh();
      }
    } catch (error) {
      setState({
        error:
          error instanceof Error
            ? error.message
            : "The file could not be uploaded.",
      });
    } finally {
      setPhase("");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Banner state={state} />
      {children}

      <Field label={fileLabel} description={fileDescription}>
        {({ id, describedBy }) => (
          <input
            id={id}
            name="file"
            type="file"
            accept={accept}
            required
            aria-describedby={describedBy}
            className="block w-full text-[13px]"
          />
        )}
      </Field>

      <label className="flex items-start gap-2.5 text-[13px]">
        <input type="checkbox" name="replace" className="mt-1" />
        <span>
          <span className="font-medium">{replaceLabel}</span>{" "}
          <span style={{ color: "var(--text-muted)" }}>
            &mdash; the superseded file is kept and the swap is recorded,
            because the register has to be able to show what was on file at the
            time.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={phase !== ""}
          className="btn btn-secondary disabled:opacity-60"
        >
          {phase === "" ? submitLabel : "Uploading…"}
        </button>
        {phase ? (
          <span className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            {phase}
          </span>
        ) : null}
      </div>
    </form>
  );
}

/** `PRJ-6`: the permit register and the status changes that unblock a site. */
export function PermitPanel({
  projectId,
  authorities,
  permits,
}: {
  projectId: string;
  authorities: { code: string; label: string }[];
  permits: {
    id: string;
    authorityLabel: string;
    permitType: string;
    status: string;
    hasDocument: boolean;
  }[];
}) {
  const [addState, addAction, addPending] = useActionState(recordPermitAction, INITIAL);
  const [statusState, statusAction, statusPending] = useActionState(setPermitStatusAction, INITIAL);

  return (
    <div className="space-y-6">
      {permits.length > 0 ? (
        <form action={statusAction} className="space-y-4">
          <Banner state={statusState} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Permit">
              {({ id, describedBy }) => (
                <Select id={id} name="permitId" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {permits.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.authorityLabel} — {p.permitType}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Status">
              {({ id, describedBy }) => (
                <Select id={id} name="status" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {PERMIT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {PERMIT_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Approved on">
              {({ id, describedBy }) => (
                <TextInput id={id} name="approvedOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field
              label="Expires on"
              description="An approval with no end date is one nobody re-checks."
            >
              {({ id, describedBy }) => (
                <TextInput id={id} name="expiresOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
          </div>
          <SubmitButton
            pending={statusPending}
            pendingLabel="Saving…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Update permit
          </SubmitButton>
        </form>
      ) : null}

      {permits.length > 0 ? (
        <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
          <summary className="cursor-pointer text-[13px] font-semibold">Attach the permit document</summary>
          <div className="mt-4">
            <AttachForm
              purpose="project_permit_document"
              accept="application/pdf,image/jpeg,image/png"
              attach={attachPermitDocumentAction}
              fileLabel="The permit itself"
              fileDescription="The approval, NOC or connection letter as issued. A PDF, or a photograph of it."
              replaceLabel="Replace the document already on file"
              submitLabel="Attach document"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <Field label="Permit">
                {({ id, describedBy }) => (
                  <Select id={id} name="permitId" required defaultValue="" aria-describedby={describedBy}>
                    <option value="" disabled>
                      Choose
                    </option>
                    {permits.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.authorityLabel} — {p.permitType}
                        {p.hasDocument ? " (document on file)" : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </AttachForm>
          </div>
        </details>
      ) : null}

      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">Record a permit</summary>
        <form action={addAction} className="mt-4 space-y-4">
          <Banner state={addState} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Authority">
              {({ id, describedBy }) => (
                <Select id={id} name="authorityCode" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {authorities.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Permit type">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="permitType"
                  required
                  minLength={2}
                  placeholder="Fire and life safety approval"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Status">
              {({ id, describedBy }) => (
                <Select id={id} name="status" required defaultValue="not_applied" aria-describedby={describedBy}>
                  {PERMIT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {PERMIT_STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Reference number">
              {({ id, describedBy }) => (
                <TextInput id={id} name="referenceNumber" maxLength={80} aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Applied on">
              {({ id, describedBy }) => (
                <TextInput id={id} name="appliedOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Expires on">
              {({ id, describedBy }) => (
                <TextInput id={id} name="expiresOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Fee paid, AED">
              {({ id, describedBy }) => (
                <TextInput id={id} name="feePaid" inputMode="decimal" aria-describedby={describedBy} />
              )}
            </Field>
          </div>

          <label className="flex items-start gap-2.5 text-[13px]">
            <input type="checkbox" name="isRequired" defaultChecked className="mt-1" />
            <span>
              <span className="font-medium">Required before going on site</span>{" "}
              <span style={{ color: "var(--text-muted)" }}>
                &mdash; ticked by default. A permit entered and not flagged is a permit that stops
                blocking, and the reason to enter it was that it blocks.
              </span>
            </span>
          </label>

          <SubmitButton
            pending={addPending}
            pendingLabel="Recording…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Record permit
          </SubmitButton>
        </form>
      </details>
    </div>
  );
}

/** `PRJ-7`: raise a snag, and close one with evidence. */
export function SnagPanel({
  projectId,
  trades,
  openSnags,
  allSnags,
}: {
  projectId: string;
  trades: { code: string; label: string }[];
  openSnags: {
    id: string;
    sequence: number;
    locationText: string;
    severity: string;
  }[];
  /**
   * Every snag, not only the open ones. Closure evidence is routinely found on
   * a phone after the snag was closed from the site office, and a picker that
   * offered only open snags would make reopening one the only way to file it.
   */
  allSnags: {
    id: string;
    sequence: number;
    locationText: string;
    hasPhoto: boolean;
    hasClosure: boolean;
  }[];
}) {
  const [raiseState, raiseAction, raisePending] = useActionState(raiseSnagAction, INITIAL);
  const [closeState, closeAction, closePending] = useActionState(closeSnagAction, INITIAL);

  return (
    <div className="space-y-6">
      {openSnags.length > 0 ? (
        <form action={closeAction} className="space-y-4">
          <Banner state={closeState} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Snag">
              {({ id, describedBy }) => (
                <Select id={id} name="snagId" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {openSnags.map((s) => (
                    <option key={s.id} value={s.id}>
                      #{s.sequence} {s.locationText} ({SNAG_SEVERITY_LABEL[
                        s.severity as keyof typeof SNAG_SEVERITY_LABEL
                      ] ?? s.severity})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="What was done"
              description="Required. A snag closed with no evidence is one raised again at handover."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="closureNote"
                  required
                  minLength={3}
                  maxLength={300}
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <div className="flex items-end">
              <SubmitButton
                pending={closePending}
                pendingLabel="Closing…"
                className="btn btn-secondary disabled:opacity-60"
              >
                Close snag
              </SubmitButton>
            </div>
          </div>
          <label className="flex items-center gap-2.5 text-[13px]">
            <input type="checkbox" name="status" value="rejected" />
            <span>
              Reject rather than close &mdash; this is not our snag, and the note says whose it is.
            </span>
          </label>
        </form>
      ) : null}

      {allSnags.length > 0 ? (
        <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
          <summary className="cursor-pointer text-[13px] font-semibold">Attach a photograph</summary>
          <div className="mt-4">
            <AttachForm
              purpose="project_snag_photo"
              accept="image/jpeg,image/png,application/pdf"
              attach={attachSnagPhotoAction}
              fileLabel="Photograph"
              fileDescription="Attach before closing. The upload goes up in parts, so a large photograph survives a site connection."
              replaceLabel="Replace the photograph already in this slot"
              submitLabel="Attach photograph"
            >
              <input type="hidden" name="projectId" value={projectId} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Snag">
                  {({ id, describedBy }) => (
                    <Select id={id} name="snagId" required defaultValue="" aria-describedby={describedBy}>
                      <option value="" disabled>
                        Choose
                      </option>
                      {allSnags.map((s) => (
                        <option key={s.id} value={s.id}>
                          #{s.sequence} {s.locationText}
                          {s.hasPhoto ? " · photo" : ""}
                          {s.hasClosure ? " · evidence" : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field
                  label="Which photograph"
                  description="The defect as raised, or the evidence that it was put right."
                >
                  {({ id, describedBy }) => (
                    <Select id={id} name="slot" required defaultValue="photo" aria-describedby={describedBy}>
                      <option value="photo">The snag itself</option>
                      <option value="closure">Closure evidence</option>
                    </Select>
                  )}
                </Field>
              </div>
            </AttachForm>
          </div>
        </details>
      ) : null}

      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">Raise a snag</summary>
        <form action={raiseAction} className="mt-4 space-y-4">
          <Banner state={raiseState} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Where" description="Level, room, wall. Specific enough to find again.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="locationText"
                  required
                  minLength={2}
                  placeholder="Level 12, meeting room 2, east wall"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Trade">
              {({ id, describedBy }) => (
                <Select id={id} name="tradeCode" required defaultValue="" aria-describedby={describedBy}>
                  <option value="" disabled>
                    Choose
                  </option>
                  {trades.map((t) => (
                    <option key={t.code} value={t.code}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Severity"
              description="Critical means unsafe or unusable — and it is what stops practical completion being recorded."
            >
              {({ id, describedBy }) => (
                <Select id={id} name="severity" required defaultValue="minor" aria-describedby={describedBy}>
                  {SNAG_SEVERITIES.map((s) => (
                    <option key={s} value={s}>
                      {SNAG_SEVERITY_LABEL[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Whose">
              {({ id, describedBy }) => (
                <Select id={id} name="responsibleParty" defaultValue="us" aria-describedby={describedBy}>
                  {(Object.keys(SNAG_PARTY_LABEL) as (keyof typeof SNAG_PARTY_LABEL)[]).map((p) => (
                    <option key={p} value={p}>
                      {SNAG_PARTY_LABEL[p]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Target date">
              {({ id, describedBy }) => (
                <TextInput id={id} name="targetOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Raised by" description="The consultant or client representative, if not us.">
              {({ id, describedBy }) => (
                <TextInput id={id} name="raisedBy" maxLength={160} aria-describedby={describedBy} />
              )}
            </Field>
          </div>

          <Field label="Description">
            {({ id, describedBy }) => (
              <TextArea id={id} name="description" rows={2} required aria-describedby={describedBy} />
            )}
          </Field>

          <SubmitButton
            pending={raisePending}
            pendingLabel="Raising…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Raise snag
          </SubmitButton>
        </form>
      </details>
    </div>
  );
}

/** `PRJ-8` and `PRJ-9`: book a cost, and engage a subcontractor. */
export function CostPanel({
  projectId,
  phases,
  subcontractors,
}: {
  projectId: string;
  phases: { id: string; sequence: number; name: string }[];
  subcontractors: {
    id: string;
    name: string;
    status: string;
    compliance: "valid" | "expiring" | "expired" | "unknown";
  }[];
}) {
  const [costState, costAction, costPending] = useActionState(recordCostAction, INITIAL);
  const [subState, subAction, subPending] = useActionState(engageSubcontractorAction, INITIAL);

  return (
    <div className="space-y-6">
      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">Book a cost</summary>
        <p className="prose-body mt-2 text-[13px]">
          The rate is captured on the row, not looked up when the figure is read. A historical cost
          that re-derives its rate is a historical cost that changes, and a closed project&rsquo;s
          margin must not move.
        </p>
        <form action={costAction} className="mt-4 space-y-4">
          <Banner state={costState} />
          <input type="hidden" name="projectId" value={projectId} />

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Kind">
              {({ id, describedBy }) => (
                <Select id={id} name="category" required defaultValue="labour" aria-describedby={describedBy}>
                  {COST_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {COST_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="What for">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="description"
                  required
                  minLength={2}
                  placeholder="Site labour, week 3"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field label="Incurred on">
              {({ id, describedBy }) => (
                <TextInput id={id} name="incurredOn" type="date" aria-describedby={describedBy} />
              )}
            </Field>
            <Field label="Quantity" description="Hours for labour, units for everything else.">
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="quantity"
                  required
                  inputMode="decimal"
                  placeholder="184.5"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            <Field
              label="Unit cost, AED"
              description="Fully loaded for labour — wage, accommodation, transport, visa, insurance."
            >
              {({ id, describedBy }) => (
                <TextInput
                  id={id}
                  name="unitCost"
                  required
                  inputMode="decimal"
                  placeholder="32.50"
                  aria-describedby={describedBy}
                />
              )}
            </Field>
            {phases.length > 0 ? (
              <Field label="Against phase">
                {({ id, describedBy }) => (
                  <Select id={id} name="phaseId" defaultValue="" aria-describedby={describedBy}>
                    <option value="">The project as a whole</option>
                    {phases.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.sequence}. {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : null}
          </div>

          <label className="flex items-start gap-2.5 text-[13px]">
            <input type="checkbox" name="isCommitted" className="mt-1" />
            <span>
              <span className="font-medium">Committed, not yet incurred</span>{" "}
              <span style={{ color: "var(--text-muted)" }}>
                &mdash; an order placed or a subcontract signed. It counts against the margin
                either way; a margin that improves because a supplier is slow to invoice reports
                the opposite of the truth.
              </span>
            </span>
          </label>

          <SubmitButton
            pending={costPending}
            pendingLabel="Recording…"
            className="btn btn-secondary disabled:opacity-60"
          >
            Book cost
          </SubmitButton>
        </form>
      </details>

      <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
        <summary className="cursor-pointer text-[13px] font-semibold">
          Engage a subcontractor
        </summary>
        {subcontractors.length === 0 ? (
          <p className="prose-body mt-2 text-[13px]">
            The register is empty. Subcontractors — their trade licence, insurance and expiry dates
            — are held in the workforce module, and an engagement here points at a row there rather
            than duplicating it.
          </p>
        ) : (
          <form action={subAction} className="mt-4 space-y-4">
            <Banner state={subState} />
            <input type="hidden" name="projectId" value={projectId} />

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Subcontractor" description="From the register, with its own licence and insurance dates.">
                {({ id, describedBy }) => (
                  <Select id={id} name="subcontractorId" required defaultValue="" aria-describedby={describedBy}>
                    <option value="" disabled>
                      Choose
                    </option>
                    {subcontractors.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} — {COMPLIANCE_LABEL[s.compliance]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Value, AED">
                {({ id, describedBy }) => (
                  <TextInput
                    id={id}
                    name="value"
                    required
                    inputMode="decimal"
                    aria-describedby={describedBy}
                  />
                )}
              </Field>
              <Field
                label="Client approval"
                description="Dubai Law No. 7 of 2025 requires the employer's prior approval before subcontracting."
              >
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    name="clientApprovalState"
                    defaultValue="pending"
                    aria-describedby={describedBy}
                  >
                    <option value="pending">Awaiting client approval</option>
                    <option value="approved">Approved</option>
                    <option value="refused">Refused</option>
                    <option value="not_required">Not required — and recorded as a decision</option>
                  </Select>
                )}
              </Field>
              <Field label="Client approval reference">
                {({ id, describedBy }) => (
                  <TextInput
                    id={id}
                    name="clientApprovalReference"
                    maxLength={64}
                    aria-describedby={describedBy}
                  />
                )}
              </Field>
              <Field label="Starts">
                {({ id, describedBy }) => (
                  <TextInput id={id} name="startsOn" type="date" aria-describedby={describedBy} />
                )}
              </Field>
              <Field label="Ends">
                {({ id, describedBy }) => (
                  <TextInput id={id} name="endsOn" type="date" aria-describedby={describedBy} />
                )}
              </Field>
            </div>

            <Field label="Scope">
              {({ id, describedBy }) => (
                <TextArea id={id} name="scope" rows={2} required aria-describedby={describedBy} />
              )}
            </Field>

            <SubmitButton
              pending={subPending}
              pendingLabel="Engaging…"
              className="btn btn-secondary disabled:opacity-60"
            >
              Engage
            </SubmitButton>
          </form>
        )}
      </details>
    </div>
  );
}
