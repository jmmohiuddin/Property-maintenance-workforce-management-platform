"use client";

import { useActionState, useState } from "react";
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

/** One line on the wage file, as the roster below needs it. */
export interface TransferRosterEntry {
  readonly employeeId: string;
  readonly fullName: string;
  /** Preformatted on the server; this component never does money arithmetic. */
  readonly amount: string;
  /** True when this line is already marked paid from an earlier confirmation. */
  readonly paid: boolean;
  /** No IBAN means the transfer could not have reached them at all. */
  readonly payable: boolean;
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
 *
 * ── WHY THERE IS A ROSTER, AND WHY IT STARTS FULLY TICKED ───────────────────
 *
 * The amount is only half the answer. A cycle can transfer 92% of the payroll
 * and still have missed four people, because the 85% test is a ratio of dirhams
 * and not of workers — and the record that then says "paid" against those four
 * is what MOHRE, a labour court and the worker are all shown afterwards. So the
 * screen has to be able to say *which* people, and the server refuses a short
 * transfer that does not.
 *
 * It starts with every name ticked and folded away, because "everybody was
 * paid" is the ordinary month and the ordinary month must stay one click. The
 * cost is paid only by the rare case that has to be described: untick whoever
 * the transfer did not reach. Unticking is also the un-marking — the names are
 * the whole truth about the cycle, so somebody dropped from the list has their
 * line written back to unpaid rather than left behind as a stale "paid".
 */
export function ConfirmTransfer({
  cycleId,
  label,
  suggestedAmount,
  today,
  roster,
}: {
  cycleId: string;
  label: string;
  /** The total due, shown as text beside the field — never prefilled into it. */
  suggestedAmount: string;
  today: string;
  roster: readonly TransferRosterEntry[];
}) {
  const [state, formAction, pending] = useActionState(confirmTransfer, INITIAL);
  const [unpaid, setUnpaid] = useState<readonly string[]>([]);

  function toggle(employeeId: string, reached: boolean) {
    setUnpaid((current) =>
      reached ? current.filter((id) => id !== employeeId) : [...current, employeeId],
    );
  }

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

      {roster.length > 0 ? (
        <details className="rounded border p-4" style={{ backgroundColor: "var(--surface-sunken)" }}>
          {/* The hidden field submits whether or not the disclosure is open, so
              the server can tell "the list was shown and everybody stayed
              ticked" from "there was no list". */}
          <input type="hidden" name="roster" value="named" />

          <summary className="cursor-pointer text-[13px] font-medium">
            {unpaid.length === 0
              ? `All ${roster.length} employee${roster.length === 1 ? "" : "s"} were paid — open this if somebody was not`
              : `${roster.length - unpaid.length} of ${roster.length} paid · ${unpaid.length} will be recorded as unpaid`}
          </summary>

          <p className="prose-body mt-3 text-[12px]">
            Untick anybody the transfer did not reach. Their line stays unpaid and says so on the
            wage file, and the cycle records how many people the money actually got to. This is the
            whole answer for the cycle rather than an addition to it — anybody unticked here is
            marked unpaid even if an earlier confirmation had marked them paid.
          </p>

          <ul className="mt-3 space-y-1">
            {roster.map((entry) => (
              <li key={entry.employeeId}>
                <label className="flex items-center gap-3 rounded px-2 py-1.5 text-[13px]">
                  <input
                    type="checkbox"
                    name="paidEmployeeIds"
                    value={entry.employeeId}
                    defaultChecked
                    onChange={(event) => toggle(entry.employeeId, event.currentTarget.checked)}
                    className="h-4 w-4 shrink-0"
                  />
                  <span className="flex-1">
                    {entry.fullName}
                    {entry.payable ? null : (
                      <span className="ml-2 text-[12px]" style={{ color: "var(--status-critical-text)" }}>
                        no IBAN — a transfer cannot have reached them
                      </span>
                    )}
                    {entry.paid ? (
                      <span className="ml-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        already marked paid
                      </span>
                    ) : null}
                  </span>
                  <span className="tnum" style={{ color: "var(--text-muted)" }}>
                    {entry.amount}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary disabled:opacity-60">
        Record the transfer
      </SubmitButton>
    </form>
  );
}
