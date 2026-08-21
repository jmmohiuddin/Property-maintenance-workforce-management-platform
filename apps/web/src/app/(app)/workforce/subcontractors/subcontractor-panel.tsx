"use client";

import { useActionState } from "react";
import { Field, TextInput, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  saveSubcontractor,
  withdrawSubcontractor,
  saveSubcontractorWorker,
  reverifySubcontractorWorker,
  type WorkforceFormState,
} from "../actions";

const INITIAL: WorkforceFormState = {};

/**
 * Add a subcontractor or manpower supplier (`HR-19`).
 *
 * Three expiries and one approval reference, because those are the four things
 * that stop being true on a date. Everything else on the form is contact
 * detail, which does not expire and does not carry a penalty.
 */
export function SubcontractorPanel() {
  const [state, formAction, pending] = useActionState(saveSubcontractor, INITIAL);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Add a subcontractor</h2>
      <p className="prose-body mt-2 text-[14px]">
        Trade licence, third-party liability cover and workmen&rsquo;s compensation, each with the
        date it stops being true. Dubai Law No. 7 of 2025 requires prior approval to subcontract, so
        the approval reference belongs on the organisation rather than on any one job it is used on.
      </p>

      <form action={formAction} className="mt-6 space-y-5">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Name">
            {({ id, describedBy }) => (
              <TextInput id={id} name="name" required minLength={2} autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field
            label="Kind"
            description="A supplier of bodies is not a supplier of a scope, and the exposure differs."
          >
            {({ id, describedBy }) => (
              <Select id={id} name="kind" required defaultValue="subcontractor" aria-describedby={describedBy}>
                <option value="subcontractor">Subcontractor &mdash; takes a scope of work</option>
                <option value="manpower_supplier">Manpower supplier &mdash; supplies workers</option>
              </Select>
            )}
          </Field>

          <Field label="Trade" description="Optional. The catalogue slug, e.g. electrical.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="tradeSlug" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Status">
            {({ id, describedBy }) => (
              <Select id={id} name="status" defaultValue="provisional" aria-describedby={describedBy}>
                <option value="provisional">Provisional &mdash; paperwork not yet complete</option>
                <option value="approved">Approved</option>
                <option value="suspended">Suspended</option>
                <option value="withdrawn">Withdrawn</option>
              </Select>
            )}
          </Field>

          <Field label="Contact name">
            {({ id, describedBy }) => (
              <TextInput id={id} name="contactName" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Contact phone">
            {({ id, describedBy }) => (
              <TextInput id={id} name="contactPhone" type="tel" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Contact email">
            {({ id, describedBy }) => (
              <TextInput id={id} name="contactEmail" type="email" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Subcontracting approval reference" description="Dubai Law No. 7 of 2025.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="approvalReference" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field
            label="Tax registration number"
            description="Fifteen digits, where the supplier is VAT-registered. Leave blank if they are not — their invoices to us are then simplified rather than full tax invoices."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="taxRegistrationNumber"
                inputMode="numeric"
                pattern="[0-9]{15}"
                autoComplete="off"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Trade licence number">
            {({ id, describedBy }) => (
              <TextInput id={id} name="tradeLicenceNo" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Trade licence expiry">
            {({ id, describedBy }) => (
              <TextInput id={id} name="tradeLicenceExpiresOn" type="date" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Liability insurer">
            {({ id, describedBy }) => (
              <TextInput id={id} name="liabilityInsurer" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Liability policy expiry">
            {({ id, describedBy }) => (
              <TextInput id={id} name="liabilityExpiresOn" type="date" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Workmen's compensation insurer">
            {({ id, describedBy }) => (
              <TextInput id={id} name="workmenCompInsurer" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Workmen's compensation expiry">
            {({ id, describedBy }) => (
              <TextInput id={id} name="workmenCompExpiresOn" type="date" aria-describedby={describedBy} />
            )}
          </Field>
        </div>

        {/* ── Third-party accreditations ────────────────────────────────
            Three rows, free-form. Deliberately not a picker: unlike our own
            accreditation register, we do not control the issuing schemes here,
            so a vocabulary would either reject a real certificate or grow an
            "other" option that swallowed most of them. Each expiry joins the
            same 90-day sweep as the licence and the two insurances. */}
        <fieldset className="space-y-3 rounded-sm border p-4" style={{ borderColor: "var(--border)" }}>
          <legend className="px-1 text-[13px] font-medium">Accreditations</legend>
          <p className="prose-body text-[12px]">
            Third-party certifications the supplier holds &mdash; IRATA, EIAC, ISO, a trade-body
            registration. An expiry recorded here is watched on the same 90-day clock as the
            licence and the insurances; one left blank is not watched at all.
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-wrap items-end gap-3">
              <Field label={`Name ${i + 1}`}>
                {({ id }) => <TextInput id={id} name="accreditationName" autoComplete="off" />}
              </Field>
              <Field label="Issuer">
                {({ id }) => <TextInput id={id} name="accreditationIssuer" autoComplete="off" />}
              </Field>
              <Field label="Expires">
                {({ id }) => <TextInput id={id} name="accreditationExpiresOn" type="date" />}
              </Field>
            </div>
          ))}
        </fieldset>

        <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-primary disabled:opacity-60">
          Add to the register
        </SubmitButton>
      </form>
    </section>
  );
}

/** Withdraw a subcontractor. Soft delete, so any engagement history survives. */
export function WithdrawSubcontractor({ id, label }: { id: string; label: string }) {
  const [state, formAction, pending] = useActionState(withdrawSubcontractor, INITIAL);

  return (
    <form action={formAction} className="text-right">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        disabled={pending}
        className="text-[12px] font-medium disabled:opacity-60"
        style={{ color: "var(--text-muted)" }}
      >
        {pending ? "Withdrawing…" : "Withdraw"}
        <span className="sr-only"> {label}</span>
      </button>
      {state.error ? (
        <p role="alert" className="mt-1 text-[12px]" style={{ color: "var(--status-critical-text)" }}>
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Record a supplied worker and their permit, in one act (`HR-19`).
 *
 * The verification checkbox is ticked by default and unticking it is the
 * deliberate choice. Whoever types this row is the person who was handed the
 * card; a separate "verify" step would leave a register full of permit numbers
 * with nobody's name against them, which looks exactly like compliance and is
 * not.
 */
export function AddSupplierWorker({ subcontractorId, name }: { subcontractorId: string; name: string }) {
  const [state, formAction, pending] = useActionState(saveSubcontractorWorker, INITIAL);

  return (
    <form action={formAction} className="mt-4 space-y-3 rounded-sm border p-4" style={{ borderColor: "var(--border)" }}>
      <input type="hidden" name="subcontractorId" value={subcontractorId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <p className="text-[13px] font-medium">Add a worker supplied by {name}</p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Full name">
          {({ id }) => <TextInput id={id} name="fullName" required minLength={2} autoComplete="off" />}
        </Field>
        <Field label="Trade">{({ id }) => <TextInput id={id} name="tradeSlug" autoComplete="off" />}</Field>
        <Field label="Work permit number">
          {({ id }) => <TextInput id={id} name="workPermitNo" autoComplete="off" />}
        </Field>
        <Field label="Permit expiry">
          {({ id }) => <TextInput id={id} name="workPermitExpiresOn" type="date" />}
        </Field>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <input type="checkbox" name="verified" defaultChecked className="h-4 w-4" />
        I have seen this permit myself
      </label>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        Record worker
      </SubmitButton>
    </form>
  );
}

/** Re-verify a permit, or stand a worker down (`HR-19`). */
export function ReverifyWorker({ workerId, name }: { workerId: string; name: string }) {
  const [state, formAction, pending] = useActionState(reverifySubcontractorWorker, INITIAL);

  return (
    <form action={formAction} className="mt-2 space-y-2">
      <input type="hidden" name="workerId" value={workerId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Renewed permit number">
          {({ id }) => <TextInput id={id} name="workPermitNo" autoComplete="off" />}
        </Field>
        <Field label="New expiry">
          {({ id }) => <TextInput id={id} name="workPermitExpiresOn" type="date" />}
        </Field>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input type="checkbox" name="standDown" className="h-4 w-4" />
          Stand down instead
        </label>
        <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-secondary disabled:opacity-60">
          Save
          <span className="sr-only"> for {name}</span>
        </SubmitButton>
      </div>
    </form>
  );
}
