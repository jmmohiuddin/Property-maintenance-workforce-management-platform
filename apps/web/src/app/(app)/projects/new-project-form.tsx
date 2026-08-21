"use client";

import { useActionState } from "react";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import { createProjectAction, type ProjectFormState } from "./actions";

const INITIAL: ProjectFormState = {};

/**
 * Create a project (`PRJ-1`).
 *
 * A `<details>` and a plain server action rather than a wizard with client
 * state, for the same reason the contract and employment forms are: this is the
 * only way into the table, and a form that needs JavaScript is a table that
 * cannot be populated from a site office on a bad connection.
 *
 * ── WHY THE PROPERTY PICKER LISTS THE CUSTOMER ─────────────────────────────
 *
 * Because the server refuses a property belonging to a different customer, and
 * a refusal the form could have prevented is a refusal that reads as a bug. The
 * option label carries the customer name so the mismatch is visible before it
 * is submitted. Filtering the list with JavaScript would be neater and would
 * stop working with scripting off, which is the connection this form exists for.
 *
 * ── WHY RETENTION DEFAULTS TO 5 AND IS CAPPED AT 10 ────────────────────────
 *
 * 5% is the fit-out norm and 10% is the top of what this market uses. A number
 * above that is not a hard bargain, it is a percentage typed where basis points
 * were meant — and it would withhold a hundred times too much from every
 * invoice on the project.
 */
export function NewProjectForm({
  customers,
  properties,
}: {
  customers: { id: string; name: string; code: string }[];
  properties: { id: string; name: string; customerId: string; customerName: string }[];
}) {
  const [state, formAction, pending] = useActionState(createProjectAction, INITIAL);

  return (
    <details className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <summary className="cursor-pointer text-[14px] font-semibold">New project</summary>

      <p className="prose-body mt-2 text-[13px]">
        Created as quoted, always — the first status in the machine. The transition to awarded is
        what records when the work became ours, and a project that starts in the middle of its own
        status machine has no record of how it got there.
      </p>

      <form action={formAction} className="mt-5 space-y-6">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Project name" description="What the client calls it on their side.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="name"
                required
                minLength={2}
                maxLength={200}
                autoComplete="off"
                placeholder="Level 12 office fit-out"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Customer" description="The party the contract is with.">
            {({ id, describedBy }) => (
              <Select id={id} name="customerId" required defaultValue="" aria-describedby={describedBy}>
                <option value="" disabled>
                  Choose a customer
                </option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Property"
            description="Optional. A tender is often priced before the unit is identified."
          >
            {({ id, describedBy }) => (
              <Select id={id} name="propertyId" defaultValue="" aria-describedby={describedBy}>
                <option value="">Not yet identified</option>
                {properties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.customerName}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Contract value, AED excluding VAT"
            description="The awarded figure. It never moves — changes are variations."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="contractValue"
                required
                inputMode="decimal"
                placeholder="480000.00"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Starts" description="When the site is handed to us.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="startsOn" type="date" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Target completion" description="The programme date, not the contract date.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="targetCompletionOn"
                type="date"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field
            label="Retention withheld, %"
            description="Deducted from every invoice on this project. Half released at practical completion, half at the end of the defects liability period."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="retentionPercent"
                type="number"
                min="0"
                max="10"
                step="0.5"
                defaultValue="5"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field
            label="Defects liability period, days"
            description="Twelve months is the market default. It fixes when the second half of retention falls due."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="defectsLiabilityDays"
                type="number"
                min="0"
                max="1825"
                defaultValue="365"
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </div>

        <Field
          label="Scope of works"
          description="What was agreed. This is the paragraph read at every argument about a variation."
        >
          {({ id, describedBy }) => (
            <TextArea
              id={id}
              name="scope"
              rows={3}
              placeholder="Strip-out, partitions, MEP, joinery, flooring and handover."
              aria-describedby={describedBy}
            />
          )}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Creating…"
          className="btn btn-primary disabled:opacity-60"
        >
          Create project
        </SubmitButton>
      </form>
    </details>
  );
}
