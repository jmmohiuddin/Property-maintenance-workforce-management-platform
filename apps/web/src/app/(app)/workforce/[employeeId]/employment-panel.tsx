"use client";

import { useActionState } from "react";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  saveContractTerm,
  saveLeaveAdjustment,
  saveOvertime,
  saveInsurance,
  recordDeduction,
  type HrFormState,
} from "../../hr/actions";

const INITIAL: HrFormState = {};

/**
 * The employment-lifecycle forms on one employee's record.
 *
 * Options are passed in rather than imported. `@meridian/db` is the whole
 * database package, and importing its constants into a client component drags
 * the postgres driver into the browser bundle — it fails the build on `net` and
 * `tls`, and would have shipped the connection code to the client if it had
 * not. The server owns every catalogue below; these components render what they
 * are handed.
 */
export interface Option {
  readonly value: string;
  readonly label: string;
}

/**
 * `HR-4`. Record the contract term.
 *
 * The end date is required and the form says why, because a fixed-term contract
 * without one is the state that produces the failure this whole feature exists
 * for: nothing can auto-renew it, nothing can give notice against it, and
 * nothing can prove it to an inspector.
 */
export function ContractPanel({ employeeId }: { employeeId: string }) {
  const [state, formAction, pending] = useActionState(saveContractTerm, INITIAL);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Record a contract term</h2>
      <p className="prose-body mt-2 text-[14px]">
        UAE private-sector contracts are fixed-term only. Recording a new term supersedes the one
        before it &mdash; the old dates stay on file, because they are the evidence if the renewal is
        ever disputed.
      </p>

      <form action={formAction} className="mt-6 space-y-5">
        <input type="hidden" name="employeeId" value={employeeId} />

        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Starts on">
            {({ id, describedBy }) => (
              <TextInput id={id} name="startsOn" type="date" required aria-describedby={describedBy} />
            )}
          </Field>
          <Field
            label="Ends on"
            description="Required. A term with no end date cannot renew, cannot be given notice against, and cannot be proved."
          >
            {({ id, describedBy }) => (
              <TextInput id={id} name="endsOn" type="date" required aria-describedby={describedBy} />
            )}
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Probation ends on"
            description="Optional, first term only. Maximum six months from the start date, and non-extendable."
          >
            {({ id, describedBy }) => (
              <TextInput id={id} name="probationEndsOn" type="date" aria-describedby={describedBy} />
            )}
          </Field>
          <Field
            label="Notice period, in days"
            description="30 to 90 days post-probation. Outside that range the clause does not hold, and it is the employer's notice that fails."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="noticePeriodDays"
                type="number"
                min={30}
                max={90}
                defaultValue={30}
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Basic salary"
            description="Basic only. Gratuity accrues on this and not on housing, transport or utilities."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="basicSalary"
                inputMode="decimal"
                placeholder="0.00"
                autoComplete="off"
                aria-describedby={describedBy}
              />
            )}
          </Field>
          <Field label="Working pattern" description="Optional, e.g. Sun–Thu 08:00–17:00, 1h break.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="workingPattern" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>
        </div>

        <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
          Record contract term
        </SubmitButton>
      </form>
    </section>
  );
}

/**
 * `HR-7`. Carry-over and adjustments only.
 *
 * There is no "days taken" field, because there is no stored balance to type it
 * into. Entitlement is computed from the service dates and days taken are
 * counted from the leave calendar; only these two numbers are facts that
 * nothing can derive.
 */
export function LeavePanel({
  employeeId,
  leaveYearStart,
}: {
  employeeId: string;
  leaveYearStart: string;
}) {
  const [state, formAction, pending] = useActionState(saveLeaveAdjustment, INITIAL);

  return (
    <form action={formAction} className="mt-4 space-y-5">
      <input type="hidden" name="employeeId" value={employeeId} />

      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Leave year starting">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="leaveYearStart"
              type="date"
              defaultValue={leaveYearStart}
              required
              aria-describedby={describedBy}
            />
          )}
        </Field>
        <Field label="Carried over" description="Days brought forward, per policy.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="carriedOverDays" type="number" min={0} defaultValue={0} aria-describedby={describedBy} />
          )}
        </Field>
        <Field label="Adjustment" description="Signed. Needs a reason either way.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="adjustmentDays" type="number" defaultValue={0} aria-describedby={describedBy} />
          )}
        </Field>
      </div>

      <Field
        label="Reason"
        description="Required for any adjustment. Leave is challenged at termination, and an adjustment with no reason is indistinguishable from a mistake by then."
      >
        {({ id, describedBy }) => <TextArea id={id} name="reason" rows={2} aria-describedby={describedBy} />}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-secondary disabled:opacity-60">
        Save leave balance
      </SubmitButton>
    </form>
  );
}

/**
 * `HR-8`. Hours by rate band.
 *
 * The amount is not on this form. It is computed on the server from the basic
 * salary and the statutory multiplier — a field that could hold the amount could
 * hold an amount below the statutory rate, and the whole reason overtime is a
 * table is that the number can be re-derived and checked.
 */
export function OvertimePanel({ employeeId, bands }: { employeeId: string; bands: readonly Option[] }) {
  const [state, formAction, pending] = useActionState(saveOvertime, INITIAL);

  return (
    <form action={formAction} className="mt-4 space-y-5">
      <input type="hidden" name="employeeId" value={employeeId} />

      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-5 sm:grid-cols-3">
        <Field label="Date worked">
          {({ id, describedBy }) => (
            <TextInput id={id} name="workedOn" type="date" required aria-describedby={describedBy} />
          )}
        </Field>
        <Field label="Rate band" description="The multiplier follows the band; it is not typed in.">
          {({ id, describedBy }) => (
            <Select id={id} name="band" required defaultValue="" aria-describedby={describedBy}>
              <option value="" disabled>
                Choose a band
              </option>
              {bands.map((band) => (
                <option key={band.value} value={band.value}>
                  {band.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Minutes" description="At most 120 minutes of overtime a day is lawful.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="minutes" type="number" min={1} max={1440} required aria-describedby={describedBy} />
          )}
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Rest-day compensation"
          description="Rest-day work only. A substitute day or +50% — record which, because a promise is not evidence six months later."
        >
          {({ id, describedBy }) => (
            <Select id={id} name="restDayCompensation" defaultValue="" aria-describedby={describedBy}>
              <option value="">Not rest-day work</option>
              <option value="substitute_day">Substitute rest day</option>
              <option value="premium_pay">Paid at +50%</option>
            </Select>
          )}
        </Field>
        <Field label="Substitute day" description="Required if a substitute day is the compensation.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="substituteDayOn" type="date" aria-describedby={describedBy} />
          )}
        </Field>
      </div>

      <Field label="Note" description="Optional. Why the hours were worked, if it is not obvious.">
        {({ id, describedBy }) => <TextArea id={id} name="note" rows={2} aria-describedby={describedBy} />}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        Record hours
      </SubmitButton>
    </form>
  );
}

/**
 * `HR-6`. Health cover, recorded as an employer cost.
 *
 * The premium field is an employer cost and there is no path from it to a
 * salary deduction. That is not a convention: `salary_deductions.kind` has a
 * CHECK constraint whose positive list contains no insurance value, so the
 * premium cannot be stored as a deduction through this form, through the ORM,
 * or through `psql`.
 *
 * No expiry field, either. The expiry lives on the health insurance document,
 * which is one of the five that hard-block a dispatch when it lapses; a second
 * expiry here would be a second source of truth and the wrong one would be the
 * one somebody read.
 */
export function InsurancePanel({
  employeeId,
  plans,
  requiredPlan,
}: {
  employeeId: string;
  plans: readonly Option[];
  requiredPlan: string | null;
}) {
  const [state, formAction, pending] = useActionState(saveInsurance, INITIAL);

  return (
    <form action={formAction} className="mt-4 space-y-5">
      <input type="hidden" name="employeeId" value={employeeId} />

      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Plan tier"
          description={
            requiredPlan
              ? `This wage requires ${requiredPlan}.`
              : "Workers paid under AED 4,000 a month require an Essential Benefits Plan."
          }
        >
          {({ id, describedBy }) => (
            <Select id={id} name="plan" required defaultValue="" aria-describedby={describedBy}>
              <option value="" disabled>
                Choose a plan tier
              </option>
              {plans.map((plan) => (
                <option key={plan.value} value={plan.value}>
                  {plan.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Insurer" description="A policy nobody can name is a policy nobody can claim against.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="insurer" required autoComplete="off" aria-describedby={describedBy} />
          )}
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Policy number" description="Optional.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="policyNo" autoComplete="off" aria-describedby={describedBy} />
          )}
        </Field>
        <Field
          label="Annual premium"
          description="An employer cost. It is not deductible from salary and there is no way to record it as one."
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="premium"
              inputMode="decimal"
              placeholder="0.00"
              autoComplete="off"
              aria-describedby={describedBy}
            />
          )}
        </Field>
      </div>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        Record health cover
      </SubmitButton>
    </form>
  );
}

/**
 * Salary deductions, from a closed list.
 *
 * ── WHY THE LIST IS CLOSED ──────────────────────────────────────────────────
 *
 * `HR-6` and `HR-16` are structural requirements, not warnings: the health
 * insurance premium may not be deducted from salary, and recruitment costs may
 * never be recovered from a worker, directly or indirectly. A free-text field
 * defeats both the moment somebody types "other", so there is no free-text
 * field — the select carries only the kinds that are lawful, and the database
 * refuses everything else regardless of what reaches it.
 */
export function DeductionPanel({ employeeId, kinds }: { employeeId: string; kinds: readonly Option[] }) {
  const [state, formAction, pending] = useActionState(recordDeduction, INITIAL);

  return (
    <form action={formAction} className="mt-4 space-y-5">
      <input type="hidden" name="employeeId" value={employeeId} />

      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-5 sm:grid-cols-3">
        <Field
          label="Deduction type"
          description="A closed list. Anything not here is either an employment cost the employer must bear or an unlawful reduction of a protected wage."
        >
          {({ id, describedBy }) => (
            <Select id={id} name="kind" required defaultValue="" aria-describedby={describedBy}>
              <option value="" disabled>
                Choose a type
              </option>
              {kinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="amount"
              inputMode="decimal"
              required
              placeholder="0.00"
              autoComplete="off"
              aria-describedby={describedBy}
            />
          )}
        </Field>
        <Field label="Applies on" description="Which wage month it lands in.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="appliesOn" type="date" aria-describedby={describedBy} />
          )}
        </Field>
      </div>

      <Field
        label="Reason"
        description="Required. MOHRE decisions bind under AED 50,000, and a deduction with no stated reason is indistinguishable from an unlawful one when it is challenged."
      >
        {({ id, describedBy }) => <TextArea id={id} name="reason" rows={2} required aria-describedby={describedBy} />}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        Record deduction
      </SubmitButton>
    </form>
  );
}
