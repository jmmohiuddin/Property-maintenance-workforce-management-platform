"use client";

import { useActionState, useState } from "react";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  recordInjury,
  recordInjuryNotified,
  closeInjuryInvestigation,
  addRams,
  addToolboxTalk,
  issuePpe,
  type HrFormState,
} from "../actions";

const INITIAL: HrFormState = {};

export interface EmployeeOption {
  readonly id: string;
  readonly name: string;
}

export interface Choice {
  readonly value: string;
  readonly label: string;
}

/**
 * Record an injury (`HR-11`).
 *
 * ── WHY THIS FORM IS SHORT ──────────────────────────────────────────────────
 *
 * Every field on it is one the statutory register or a MOHRE notification
 * needs. There is no diagnosis field, no treatment field and no body-part
 * field, and their absence is the design rather than a first cut: this register
 * holds health information about identifiable people, and the rule applied to
 * every column was whether the obligation needs it. See the table's own comment
 * in `schema/compliance.ts` for what was rejected and why.
 *
 * The practical reason to keep it short is the same one: the clock starts when
 * this is submitted, so a form somebody puts off until they have gathered the
 * medical report is a form that delays the record — and the record is what
 * starts anybody thinking about the 48 hours.
 *
 * `becameKnownAt` is left blank in the ordinary case and the server defaults it
 * to the incident time. It only earns a value for an occupational disease,
 * which is diagnosed rather than witnessed.
 */
export function RecordInjury({
  employees,
  causes,
  severities,
  kinds,
}: {
  employees: readonly EmployeeOption[];
  causes: readonly Choice[];
  severities: readonly Choice[];
  kinds: readonly Choice[];
}) {
  const [state, formAction, pending] = useActionState(recordInjury, INITIAL);
  const [kind, setKind] = useState("work_injury");

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Who was injured">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="employeeId" required defaultValue="">
              <option value="" disabled>
                Choose an employee
              </option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Injury or occupational disease">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="When it happened" description="Dubai time.">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="datetime-local" name="occurredAt" required />
          )}
        </Field>

        <Field
          label="When the company learned of it"
          description={
            kind === "occupational_disease"
              ? "The 48-hour clock runs from here. For a disease that is the diagnosis, not the exposure."
              : "Leave blank unless it is different — the clock then runs from the time above."
          }
        >
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="datetime-local" name="becameKnownAt" />
          )}
        </Field>

        <Field label="How serious">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="severity" required defaultValue="">
              <option value="" disabled>
                Choose
              </option>
              {severities.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="What caused it">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="cause" required defaultValue="">
              <option value="" disabled>
                Choose
              </option>
              {causes.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <Field label="Where" description="The site, building or plant room.">
        {({ id, describedBy }) => (
          <TextInput id={id} aria-describedby={describedBy} name="location" maxLength={200} />
        )}
      </Field>

      <Field
        label="What happened"
        description="About the work, not about the injury. This is what a risk assessment gets rewritten against."
      >
        {({ id, describedBy }) => (
          <TextArea id={id} aria-describedby={describedBy} name="description" required rows={3} />
        )}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
        Record the injury
      </SubmitButton>
    </form>
  );
}

/**
 * Record that MOHRE, or the insurer, was told (`HR-11`).
 *
 * The only thing that stops the clock, and it is a person pressing this rather
 * than a job inferring it — the hourly sweep is explicitly forbidden from
 * setting these columns, because a job that stamped them would replace a live
 * statutory obligation with a tidy screen and no notification.
 */
export function RecordNotification({
  injuryId,
  recipient,
}: {
  injuryId: string;
  recipient: "mohre" | "insurer";
}) {
  const [state, formAction, pending] = useActionState(recordInjuryNotified, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}
      <input type="hidden" name="injuryId" value={injuryId} />
      <input type="hidden" name="recipient" value={recipient} />
      <Field
        label={recipient === "mohre" ? "MOHRE reference" : "Insurer claim reference"}
        description={
          recipient === "mohre"
            ? "Required. A notification with no reference is an assertion."
            : "Optional while the claim number has not come back."
        }
      >
        {({ id, describedBy }) => (
          <TextInput id={id} aria-describedby={describedBy} name="reference" maxLength={64} required={recipient === "mohre"} />
        )}
      </Field>
      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        {recipient === "mohre" ? "MOHRE has been notified" : "The insurer has been notified"}
      </SubmitButton>
    </form>
  );
}

/** Close an investigation and say what changed (`HR-11` into `HR-12`). */
export function CloseInvestigation({
  injuryId,
  rams,
  policeOutstanding,
}: {
  injuryId: string;
  rams: readonly Choice[];
  policeOutstanding: boolean;
}) {
  const [state, formAction, pending] = useActionState(closeInjuryInvestigation, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}
      <input type="hidden" name="injuryId" value={injuryId} />

      <Field
        label="What was changed"
        description="Required. An investigation closed with no corrective action is a record that nothing happened."
      >
        {({ id, describedBy }) => (
          <TextArea id={id} aria-describedby={describedBy} name="correctiveAction" required rows={3} />
        )}
      </Field>

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Days of work lost">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="number" name="daysLost" min={0} step={1} />
          )}
        </Field>
        <Field label="The assessment that replaced it" description="Optional.">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="ramsId" defaultValue="">
              <option value="">None</option>
              {rams.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {policeOutstanding ? (
        <Field
          label="Police reference"
          description="This severity is police-reportable and nothing is recorded. That obligation is immediate; it is not a 48-hour window."
        >
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} name="policeReference" maxLength={64} />
          )}
        </Field>
      ) : null}

      <SubmitButton pending={pending} pendingLabel="Closing…" className="btn btn-secondary disabled:opacity-60">
        Close the investigation
      </SubmitButton>
    </form>
  );
}

/** Record and approve a RAMS pack (`HR-12`). */
export function AddRams({ kinds }: { kinds: readonly Choice[] }) {
  const [state, formAction, pending] = useActionState(addRams, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <Field label="Title">
        {({ id, describedBy }) => (
          <TextInput id={id} aria-describedby={describedBy} name="title" required maxLength={200} />
        )}
      </Field>

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Kind">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="kind" defaultValue="rams">
              {kinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Trade" description="Optional, e.g. electrical.">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} name="tradeSlug" maxLength={64} />
          )}
        </Field>
        <Field
          label="Next review"
          description="Blank means one year from today, in Dubai."
        >
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="date" name="reviewDueOn" />
          )}
        </Field>
      </div>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
        Record and approve
      </SubmitButton>
    </form>
  );
}

/**
 * Record a toolbox talk and its attendance (`HR-12`).
 *
 * The attendee list is unticked by default, which is the opposite of the WPS
 * transfer roster on `/hr/payroll`, and deliberately so. There the ordinary
 * answer is "everybody was paid", so everybody starts ticked. Here the ordinary
 * answer is "the six people who were on that site this morning", and starting
 * with the whole establishment ticked would make the effortless action a false
 * claim that every employee was briefed.
 */
export function AddToolboxTalk({
  employees,
  rams,
}: {
  employees: readonly EmployeeOption[];
  rams: readonly Choice[];
}) {
  const [state, formAction, pending] = useActionState(addToolboxTalk, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Topic">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} name="topic" required maxLength={200} />
          )}
        </Field>
        <Field label="Held on" description="Blank means today, in Dubai.">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="date" name="heldOn" />
          )}
        </Field>
        <Field label="Assessment briefed" description="Optional.">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="ramsId" defaultValue="">
              <option value="">None</option>
              {rams.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <fieldset className="rounded-sm border p-4" style={{ borderColor: "var(--border)" }}>
        <legend className="px-1 text-[13px] font-semibold">Who was there</legend>
        <p className="prose-body mb-3 text-[12px]">
          Tick everybody who attended. The record refuses to save with nobody ticked &mdash;
          proving who was briefed is the only reason it exists.
        </p>
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {employees.map((e) => (
            <label key={e.id} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" name="employeeIds" value={e.id} />
              <span>{e.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
        Record the talk
      </SubmitButton>
    </form>
  );
}

/** Issue PPE (`HR-12`). */
export function IssuePpe({
  employees,
  items,
}: {
  employees: readonly EmployeeOption[];
  items: readonly Choice[];
}) {
  const [state, formAction, pending] = useActionState(issuePpe, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Issued to">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="employeeId" required defaultValue="">
              <option value="" disabled>
                Choose an employee
              </option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="What">
          {({ id, describedBy }) => (
            <Select id={id} aria-describedby={describedBy} name="itemKind" required defaultValue="">
              <option value="" disabled>
                Choose
              </option>
              {items.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Field label="Item" description="Optional, e.g. Petzl Avao.">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} name="itemDescription" maxLength={160} />
          )}
        </Field>
        <Field label="Size">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} name="size" maxLength={24} />
          )}
        </Field>
        <Field label="Issued on" description="Blank means today.">
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="date" name="issuedOn" />
          )}
        </Field>
        <Field
          label="Replace by"
          description="Harnesses and lanyards have a shelf life."
        >
          {({ id, describedBy }) => (
            <TextInput id={id} aria-describedby={describedBy} type="date" name="replaceDueOn" />
          )}
        </Field>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="acknowledged" />
        <span>They signed the issue sheet</span>
      </label>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
        Record the issue
      </SubmitButton>
    </form>
  );
}
