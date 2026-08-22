"use client";

import { useActionState } from "react";
import { Field, TextInput, Select, FormBanner, SubmitButton } from "@/components/form";
import { settleGratuity, payGratuity, classifyOccupation, type HrFormState } from "./actions";

const INITIAL: HrFormState = {};

export interface SettleableEmployee {
  readonly id: string;
  readonly name: string;
  /** Pre-formatted on the server. The client bundle has no money formatter. */
  readonly accrued: string;
}

/**
 * Record an end-of-service settlement (`HR-13`).
 *
 * ── THERE IS NO AMOUNT FIELD, AND THAT IS THE DESIGN ────────────────────────
 *
 * The accrued figure is shown beside each name and cannot be typed over. The
 * gratuity is Article 51's arithmetic — 21 days for the first five years then
 * 30, on basic salary only, capped at two years' total wages — and the whole
 * reason `HR-13` exists is that nobody does that sum the same way twice. An
 * editable amount would make the computation optional, and the first person in
 * a hurry would paste the number from a spreadsheet.
 *
 * What the form asks for is the termination date, because the 14-day statutory
 * deadline runs from it and it is the one fact the system cannot know.
 */
export function SettleGratuity({
  employees,
  today,
}: {
  employees: readonly SettleableEmployee[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(settleGratuity, INITIAL);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Record an end-of-service settlement</h2>
      <p className="prose-body mt-2 text-[14px]">
        The amount is computed from the service dates and the basic salary on file &mdash; 21 days&rsquo;
        basic pay per year for the first five years, 30 thereafter, capped at two years&rsquo; total
        wages. It is not a field, on purpose. All end-of-service dues are payable within 14 days of
        termination.
      </p>

      <form action={formAction} className="mt-6 space-y-5">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Employee" description="Accrued figure shown beside each name.">
            {({ id, describedBy }) => (
              <Select id={id} name="employeeId" required defaultValue="" aria-describedby={describedBy}>
                <option value="" disabled>
                  Choose an employee
                </option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} &mdash; {e.accrued}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Termination date" description="The 14-day clock runs from this day.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="terminatedOn"
                type="date"
                required
                defaultValue={today}
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </div>

        <SubmitButton
          pending={pending}
          pendingLabel="Recording…"
          className="btn btn-primary disabled:opacity-60"
        >
          Record settlement
        </SubmitButton>
      </form>
    </section>
  );
}

/**
 * Mark a settlement as paid (`HR-13`).
 *
 * The reference is required. A settlement marked paid with nothing behind it is
 * worth nothing in a labour claim, and the limitation period for one is two
 * years from termination — which is longer than anybody's memory of a transfer.
 */
export function PayGratuity({
  settlementId,
  label,
  today,
}: {
  settlementId: string;
  label: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(payGratuity, INITIAL);

  return (
    <form action={formAction} className="mt-3 space-y-3">
      <input type="hidden" name="settlementId" value={settlementId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Paid on">
          {({ id }) => <TextInput id={id} name="paidOn" type="date" required defaultValue={today} />}
        </Field>
        <Field label="Bank or WPS reference">
          {({ id }) => <TextInput id={id} name="reference" required autoComplete="off" />}
        </Field>
        <SubmitButton
          pending={pending}
          pendingLabel="Recording…"
          className="btn btn-secondary disabled:opacity-60"
        >
          Record payment
          <span className="sr-only"> for {label}</span>
        </SubmitButton>
      </div>
    </form>
  );
}

export interface IscoOption {
  readonly value: number;
  readonly label: string;
  readonly skilled: boolean;
}

/**
 * Record the two occupational facts the skilled test needs (`HR-18`).
 *
 * ── BOTH FIELDS OPEN ON "NOT RECORDED", AND NEITHER DEFAULTS ────────────────
 *
 * A select that defaulted to a group would silently answer the question that
 * decides whether this employee is in the Emiratisation denominator, and a
 * defaulted answer is indistinguishable from a chosen one. Unanswered is a real
 * state: it shows up as the gap between the lower and upper bounds of the
 * skilled range, it is visible on the screen above, and it can be corrected.
 */
export function ClassifyOccupation({
  employeeId,
  employeeName,
  groups,
  currentGroup,
  currentCertificate,
}: {
  employeeId: string;
  employeeName: string;
  groups: readonly IscoOption[];
  currentGroup: number | null;
  currentCertificate: boolean | null;
}) {
  const [state, formAction, pending] = useActionState(classifyOccupation, INITIAL);

  return (
    <form action={formAction} className="mt-3 space-y-3">
      <input type="hidden" name="employeeId" value={employeeId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="flex flex-wrap items-end gap-3">
        <Field label="ISCO occupational group">
          {({ id }) => (
            <Select id={id} name="iscoMajorGroup" defaultValue={currentGroup === null ? "" : String(currentGroup)}>
              <option value="">Not recorded</option>
              {groups.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.value} &mdash; {g.label}
                  {g.skilled ? "" : " (outside the test)"}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Post-secondary certificate">
          {({ id }) => (
            <Select
              id={id}
              name="postSecondaryCertificate"
              defaultValue={currentCertificate === null ? "" : currentCertificate ? "yes" : "no"}
            >
              <option value="">Not recorded</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          )}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Saving…"
          className="btn btn-secondary disabled:opacity-60"
        >
          Save
          <span className="sr-only"> classification for {employeeName}</span>
        </SubmitButton>
      </div>
    </form>
  );
}
