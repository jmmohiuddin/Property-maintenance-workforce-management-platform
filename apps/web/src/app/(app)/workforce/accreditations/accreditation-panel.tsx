"use client";

import { useActionState } from "react";
import { Field, TextInput, Select, FormBanner, SubmitButton } from "@/components/form";
import { saveAccreditation, withdrawAccreditation, type WorkforceFormState } from "../actions";

const INITIAL: WorkforceFormState = {};

/**
 * Accreditation types, passed in rather than imported — importing them from
 * `@meridian/db` here would pull the postgres driver into the client bundle.
 */
export interface AccreditationKindOption {
  readonly value: string;
  readonly label: string;
}

/** Record a company accreditation (`HR-14`). */
export function AccreditationPanel({ kinds }: { kinds: readonly AccreditationKindOption[] }) {
  const [state, formAction, pending] = useActionState(saveAccreditation, INITIAL);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Record an accreditation</h2>
      <p className="prose-body mt-2 text-[14px]">
        Every entry needs an expiry. An accreditation with no expiry date is one nobody renews,
        which is how a trade licence reaches its last week unnoticed.
      </p>

      <form action={formAction} className="mt-6 space-y-5">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Type">
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

          <Field label="Name" description="As it appears on the certificate.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="name"
                required
                minLength={2}
                autoComplete="off"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Reference number" description="Optional. The licence or policy number.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="referenceNo" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Issuing body" description="Optional. DET, DEWA, Dubai Municipality, the insurer.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="issuingBody" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field
            label="Grade"
            description="Optional. DEWA enrolment is graded Platinum, Gold, Silver or Bronze on past performance."
          >
            {({ id, describedBy }) => (
              <TextInput id={id} name="grade" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Issue date" description="Optional.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="issuedAt" type="date" aria-describedby={describedBy} />
            )}
          </Field>
        </div>

        <Field label="Expiry date" description="Required.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="expiresAt" type="date" required aria-describedby={describedBy} />
          )}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Recording…"
          className="btn btn-primary disabled:opacity-60"
        >
          Record accreditation
        </SubmitButton>
      </form>
    </section>
  );
}

/** Withdraw an accreditation. Soft delete, so the tender-pack history survives. */
export function WithdrawAccreditation({
  accreditationId,
  label,
}: {
  accreditationId: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(withdrawAccreditation, INITIAL);

  return (
    <form action={formAction} className="text-right">
      <input type="hidden" name="accreditationId" value={accreditationId} />
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
