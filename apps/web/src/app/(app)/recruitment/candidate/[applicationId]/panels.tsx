"use client";

import { useActionState, useState } from "react";
import {
  BLOCKED_ON_LABEL,
  DISPOSITION_REASONS,
  DISPOSITION_BY_CODE,
  VISA_STATUSES,
  VISA_STATUS_LABEL,
  outcomeMessage,
} from "@meridian/core";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  archiveApplicationAction,
  cancelOutcomeAction,
  hireAction,
  moveStageAction,
  reopenApplicationAction,
  sendOutcomeNowAction,
  setBlockedOnAction,
  setVisaStatusAction,
  type ActionState,
} from "../../actions";

const INITIAL: ActionState = {};

interface Stage {
  id: string;
  name: string;
  stageType: string;
  sequence: number;
}

/**
 * Everything a recruiter does to a candidate, in one column.
 *
 * ── THE ORDER IS THE ARGUMENT ───────────────────────────────────────────────
 *
 * Move, then blocked-on, then visa, then archive, then hire. That is the order
 * of frequency and it is also the order of consequence — the thing done twenty
 * times a day is at the top and the thing done once is at the bottom, where
 * nobody reaches it by accident.
 *
 * The archive dialog puts the *reason* first and the message second, because
 * the reason writes the message. `ATS-16` is explicit that the disposition
 * reason maps to a message template so "certifications not current" produces
 * actionable feedback that often converts into a later re-application — and the
 * preview below the picker is what makes that visible rather than a claim in a
 * requirements document.
 *
 * There is no "send outcome message" checkbox anywhere on this screen. The
 * wireframe draws one, ticked and required; a required checkbox is still a
 * checkbox, and `closeApplication` takes no parameter that could turn it off.
 */
export function CandidatePanels(props: {
  applicationId: string;
  candidateId: string;
  candidateFirstName: string;
  candidateEmail: string | null;
  reference: string;
  roleTitle: string;
  statusToken: string;
  status: string;
  currentStageId: string | null;
  stageType: string | null;
  blockedOn: string;
  visaStatus: string | null;
  outcomeMessage: string | null;
  outcomeScheduledAt: string | null;
  outcomeSentAt: string | null;
  stages: readonly Stage[];
}) {
  const isLive = props.status === "active";

  return (
    <div className="space-y-8">
      {isLive ? <MovePanel {...props} /> : null}
      {isLive ? <BlockedPanel {...props} /> : null}
      {isLive && props.stageType === "trade_check" ? <VisaPanel {...props} /> : null}

      {/* The outcome controls, wherever the outcome currently stands. */}
      {!props.outcomeSentAt && props.outcomeScheduledAt ? <CancelPanel {...props} /> : null}
      {!props.outcomeSentAt && !props.outcomeScheduledAt && props.outcomeMessage ? (
        <SendNowPanel {...props} />
      ) : null}

      {isLive ? <ArchivePanel {...props} /> : <ReopenPanel {...props} />}
      {isLive ? <HirePanel {...props} /> : null}
    </div>
  );
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[16px] font-semibold">{title}</h2>
      {description ? (
        <p className="prose-body mt-1.5 text-[13px]">{description}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function MovePanel(props: { applicationId: string; currentStageId: string | null; stages: readonly Stage[] }) {
  const [state, action, pending] = useActionState(moveStageAction, INITIAL);
  const next = props.stages.filter((s) => s.id !== props.currentStageId);

  return (
    <Panel title="Move to">
      <form action={action} className="space-y-3">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <Select name="toStageId" defaultValue={next[0]?.id ?? ""} aria-label="Stage">
          {next.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.name}
            </option>
          ))}
        </Select>
        <TextInput name="note" placeholder="Note (optional)" maxLength={400} />
        <SubmitButton pending={pending} pendingLabel="Moving…" className="btn btn-primary">
          Move
        </SubmitButton>
      </form>
    </Panel>
  );
}

function BlockedPanel(props: { applicationId: string; blockedOn: string }) {
  const [state, action, pending] = useActionState(setBlockedOnAction, INITIAL);

  return (
    <Panel
      title="Who is holding this up?"
      description="The candidate sees the same answer on their own page. If we are waiting on a certificate, the one person who can fix that is the one most systems never tell."
    >
      <form action={action} className="space-y-3">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <Select name="blockedOn" defaultValue={props.blockedOn} aria-label="Blocked on">
          {(["none", "candidate", "us"] as const).map((value) => (
            <option key={value} value={value}>
              {BLOCKED_ON_LABEL[value]}
            </option>
          ))}
        </Select>
        <TextInput
          name="blockedNote"
          placeholder="What are we waiting for? e.g. photo of the HVAC certificate"
          maxLength={200}
        />
        <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-secondary">
          Record
        </SubmitButton>
      </form>
    </Panel>
  );
}

function VisaPanel(props: { applicationId: string; candidateId: string; visaStatus: string | null }) {
  const [state, action, pending] = useActionState(setVisaStatusAction, INITIAL);

  return (
    <Panel
      title="Visa and permit"
      description="Trade Check stage, asked of everyone shortlisted, uniformly. For permit and timeline planning only — never a filter, and never on the public form (ATS-5)."
    >
      <form action={action} className="space-y-3">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        <input type="hidden" name="candidateId" value={props.candidateId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <Select
          name="visaStatus"
          defaultValue={props.visaStatus ?? VISA_STATUSES[0]}
          aria-label="Visa status"
        >
          {VISA_STATUSES.map((status) => (
            <option key={status} value={status}>
              {VISA_STATUS_LABEL[status]}
            </option>
          ))}
        </Select>
        <TextInput name="visaCurrentSponsor" placeholder="Current sponsor (optional)" maxLength={160} />
        <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-secondary">
          Record
        </SubmitButton>
      </form>
    </Panel>
  );
}

/**
 * Archive — the reason is the product (wireframe §5.3).
 *
 * The preview updates as the reason changes, so the person choosing can see
 * what the candidate is about to read. That is the difference between a
 * disposition code that feeds a chart and one that feeds a message: a recruiter
 * who can see "renew it and please do apply again" attached to "certification
 * not current" picks the accurate reason rather than the nearest one.
 */
function ArchivePanel(props: {
  applicationId: string;
  candidateFirstName: string;
  roleTitle: string;
}) {
  const [state, action, pending] = useActionState(archiveApplicationAction, INITIAL);
  const [code, setCode] = useState<string>(DISPOSITION_REASONS[0].code);
  const [note, setNote] = useState("");

  const reason = DISPOSITION_BY_CODE[code];
  const preview = outcomeMessage({
    candidateFirstName: props.candidateFirstName,
    roleTitle: props.roleTitle,
    dispositionCode: code,
    extraNote: note,
  });

  return (
    <Panel
      title="Archive"
      description="Every archive sends this person an outcome. There is no option not to — that is the whole of ATS-16, and the target is 100%."
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <Field
          label="Reason"
          description="A closed list. Free text here would destroy the only output the question is asked for."
        >
          {({ id, describedBy }) => (
            <Select
              id={id}
              name="dispositionCode"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby={describedBy}
            >
              {DISPOSITION_REASONS.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Anything to add (optional)">
          {({ id }) => (
            <TextArea
              id={id}
              name="note"
              rows={2}
              maxLength={600}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>

        <div>
          <p className="text-[13px] font-medium">They will receive:</p>
          <p
            className="mt-1.5 rounded-sm p-3 text-[14px]"
            style={{ backgroundColor: "var(--surface-sunken)" }}
          >
            {preview}
          </p>
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {reason?.autoSendable
              ? "Goes out in 24 hours and can be cancelled until then (ATS-15)."
              : "Waits for you to press send. An automated rejection is not permitted after a human has spoken to the candidate (ATS-15)."}
          </p>
        </div>

        {reason?.talentPoolCandidate ? (
          <label className="flex items-start gap-3 text-[14px]">
            <input type="checkbox" name="addToTalentPool" className="mt-0.5 h-[17px] w-[17px]" />
            <span>
              Keep on file for future roles
              <span className="block text-[13px]" style={{ color: "var(--text-muted)" }}>
                Its own lawful basis, and a re-confirmation every 90 days. We will ask the candidate
                to confirm it themselves.
              </span>
            </span>
          </label>
        ) : null}

        <SubmitButton pending={pending} pendingLabel="Archiving…" className="btn btn-secondary">
          Archive and tell them
        </SubmitButton>
      </form>
    </Panel>
  );
}

function CancelPanel(props: { applicationId: string; outcomeScheduledAt: string | null }) {
  const [state, action, pending] = useActionState(cancelOutcomeAction, INITIAL);

  return (
    <Panel
      title="Cancel the scheduled message"
      description="Cancelling does not clear the obligation. This applicant stays on the owed-an-outcome list until somebody tells them something."
    >
      <form action={action} className="space-y-3">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}
        <SubmitButton pending={pending} pendingLabel="Cancelling…" className="btn btn-secondary">
          Cancel it
        </SubmitButton>
      </form>
    </Panel>
  );
}

function SendNowPanel(props: {
  applicationId: string;
  candidateFirstName: string;
  candidateEmail: string | null;
  reference: string;
  roleTitle: string;
  statusToken: string;
  outcomeMessage: string | null;
}) {
  const [state, action, pending] = useActionState(sendOutcomeNowAction, INITIAL);

  return (
    <Panel
      title="Send the outcome"
      description="Written when the decision was made. Read it, then send it — which is a very different task from writing a rejection from scratch at the end of a long week, and it is the difference between this getting done and not."
    >
      <form action={action} className="space-y-3">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        <input type="hidden" name="candidateEmail" value={props.candidateEmail ?? ""} />
        <input type="hidden" name="candidateFirstName" value={props.candidateFirstName} />
        <input type="hidden" name="reference" value={props.reference} />
        <input type="hidden" name="roleTitle" value={props.roleTitle} />
        <input type="hidden" name="statusToken" value={props.statusToken} />

        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <TextArea name="outcomeMessage" rows={5} defaultValue={props.outcomeMessage ?? ""} />

        {props.candidateEmail ? null : (
          <p className="text-[13px]" style={{ color: "var(--status-critical-text)" }}>
            No email address. No SMS or WhatsApp transport is configured, so this system cannot
            reach them — call them, and do not mark it sent until somebody actually has.
          </p>
        )}

        <SubmitButton pending={pending} pendingLabel="Sending…" className="btn btn-primary">
          Send now
        </SubmitButton>
      </form>
    </Panel>
  );
}

function ReopenPanel(props: { applicationId: string; status: string }) {
  const [state, action, pending] = useActionState(reopenApplicationAction, INITIAL);
  if (props.status === "hired") return null;

  return (
    <Panel
      title="Reopen"
      description="Puts the application back in the stage it was archived from. The message already sent stays in the history — a reopened application whose feed claims nothing was sent would be a lie."
    >
      <form action={action} className="space-y-3">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}
        <SubmitButton pending={pending} pendingLabel="Reopening…" className="btn btn-secondary">
          Reopen
        </SubmitButton>
      </form>
    </Panel>
  );
}

/**
 * Hire (`ATS-17`).
 *
 * *"The conversion is the point of the whole module."* Identity, trade, grade
 * and every certification with its expiry carry across in one transaction, and
 * nothing is retyped — a certification retyped by hand loses its expiry roughly
 * as often as somebody is in a hurry, and the consequence surfaces months later
 * as a refused dispatch under `HR-9`, or worse, as a permitted one.
 *
 * Look at the fields: there is no fee, bond, repayment or visa cost to recover.
 * `HR-16` prohibits recovering recruitment costs from a worker, and this form
 * honours it the only way that survives a redesign — by having no such field to
 * remove.
 */
function HirePanel(props: { applicationId: string }) {
  const [state, action, pending] = useActionState(hireAction, INITIAL);

  return (
    <Panel
      title="Hire"
      description="Creates the technician and the employment record together, carrying every certification across with its expiry date. Nothing is re-keyed."
    >
      <form action={action} className="space-y-4">
        <input type="hidden" name="applicationId" value={props.applicationId} />
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <Field label="Staff number">
          {({ id }) => <TextInput id={id} name="employeeCode" required maxLength={32} />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Contract start">
            {({ id }) => <TextInput id={id} name="contractStart" type="date" required />}
          </Field>
          <Field
            label="Contract end"
            description="UAE private-sector contracts are fixed-term only."
          >
            {({ id, describedBy }) => (
              <TextInput id={id} name="contractEnd" type="date" aria-describedby={describedBy} />
            )}
          </Field>
          <Field label="Probation ends" description="Maximum six months, non-extendable.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="probationEnd" type="date" aria-describedby={describedBy} />
            )}
          </Field>
          <Field label="Notice period (days)">
            {({ id }) => (
              <TextInput id={id} name="noticePeriodDays" type="number" min={30} max={90} defaultValue={30} />
            )}
          </Field>
          <Field
            label="Basic salary (AED / month)"
            description="Basic only. Gratuity accrues on basic pay, excluding allowances."
          >
            {({ id, describedBy }) => (
              <TextInput id={id} name="basicSalary" inputMode="decimal" aria-describedby={describedBy} />
            )}
          </Field>
          <Field label="Base city">
            {({ id }) => <TextInput id={id} name="baseCity" defaultValue="Dubai" maxLength={80} />}
          </Field>
        </div>

        <p
          className="rounded-sm p-3 text-[13px]"
          style={{ backgroundColor: "var(--surface-sunken)" }}
        >
          Cannot be dispatched until the work permit, residence visa, Emirates ID, medical fitness
          certificate and health insurance are all recorded and valid (HR-9). Recruitment and visa
          costs are the employer&rsquo;s and may never be deducted from this employee&rsquo;s salary
          — there is no field anywhere in this system in which to record one (HR-16).
        </p>

        <SubmitButton pending={pending} pendingLabel="Creating…" className="btn btn-primary">
          Create employee
        </SubmitButton>
      </form>
    </Panel>
  );
}
