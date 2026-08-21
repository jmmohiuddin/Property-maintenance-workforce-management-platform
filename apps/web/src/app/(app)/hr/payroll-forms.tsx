"use client";

import { useActionState } from "react";
import { Field, TextInput, FormBanner, SubmitButton } from "@/components/form";
import { buildWageFile, confirmTransfer, type HrFormState } from "./actions";

const INITIAL: HrFormState = {};

/**
 * Produce the wage-file inputs (`HR-17`).
 *
 * The nightly job does this at T-3 whether or not anybody presses this. Both
 * exist deliberately: the job is the guarantee, and the button is what an
 * accountant uses when they want the numbers before the job would have produced
 * them. Idempotent — the server upserts, so pressing it twice changes nothing.
 */
export function BuildWageFile({ label, prepared }: { label: string; prepared: boolean }) {
  const [state, formAction, pending] = useActionState(buildWageFile, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}
      <SubmitButton pending={pending} pendingLabel="Building…" className="btn btn-primary disabled:opacity-60">
        {prepared ? `Rebuild the ${label} wage file` : `Build the ${label} wage file`}
      </SubmitButton>
    </form>
  );
}

/**
 * Record the transfer (`HR-17`).
 *
 * ── WHY THE AMOUNT IS TYPED IN ──────────────────────────────────────────────
 *
 * It would be one click to record the total due as transferred. That click is
 * the bug: 85% of total wages is the compliance line, so a partial transfer is
 * a real and important state, and pre-filling the total makes the one state
 * that matters — "we paid most of it" — the hardest to record. An establishment
 * that recorded 60% as "paid" discovers the truth when its work permits stop
 * being issued.
 *
 * The bank reference is required for the same reason: "transferred" without one
 * is an assertion, and it is the first thing an inspection asks evidence for.
 */
export function ConfirmTransfer({
  cycleId,
  label,
  suggestedAmount,
  today,
}: {
  cycleId: string;
  label: string;
  /** The total due, shown as text beside the field — never prefilled into it. */
  suggestedAmount: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(confirmTransfer, INITIAL);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="cycleId" value={cycleId} />

      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Amount transferred"
          description={`${suggestedAmount} is due for ${label}. Type what actually left the account — a short transfer is a violation whether or not it is recorded as one.`}
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="transferred"
              inputMode="decimal"
              required
              autoComplete="off"
              placeholder="0.00"
              aria-describedby={describedBy}
            />
          )}
        </Field>

        <Field label="Transfer date" description="The day the bank confirmed it, not the day it was instructed.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="confirmedOn"
              type="date"
              defaultValue={today}
              required
              aria-describedby={describedBy}
            />
          )}
        </Field>
      </div>

      <Field
        label="Bank or SIF reference"
        description="Required. Without it this record is an assertion rather than evidence."
      >
        {({ id, describedBy }) => (
          <TextInput id={id} name="transferReference" required autoComplete="off" aria-describedby={describedBy} />
        )}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
        Record the transfer
      </SubmitButton>
    </form>
  );
}
