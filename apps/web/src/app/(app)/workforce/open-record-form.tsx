"use client";

import { useActionState } from "react";
import { Field, TextInput, Select, FormBanner, SubmitButton } from "@/components/form";
import { openEmployeeRecord, type WorkforceFormState } from "./actions";

const INITIAL: WorkforceFormState = {};

/**
 * Open an employment record (`HR-5`).
 *
 * `<details>` rather than a `useState` toggle. This form is the only way into
 * the register, and a disclosure that depends on JavaScript is a register that
 * cannot be populated on a bad connection in a site office — which is exactly
 * where the paperwork gets typed up. The form itself is a server action, so it
 * posts and works with scripting off too.
 */
export function OpenRecordForm({
  technicians,
}: {
  technicians: { id: string; fullName: string; employeeCode: string }[];
}) {
  const [state, formAction, pending] = useActionState(openEmployeeRecord, INITIAL);

  return (
    <details className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <summary className="cursor-pointer text-[14px] font-semibold">Open an employment record</summary>

      <p className="prose-body mt-2 text-[13px]">
        Attach it to a technician wherever one exists. That link is what lets an expired work permit
        stop a dispatch; an unattached record is a filing cabinet entry that can never block
        anything.
      </p>

      <form action={formAction} className="mt-5 space-y-5">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Full name" description="As it appears on the passport.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="fullName"
                required
                minLength={2}
                autoComplete="off"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Employee number" description="Optional. Must be unique within the company.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="employeeNo" autoComplete="off" aria-describedby={describedBy} />
            )}
          </Field>
        </div>

        <Field
          label="Technician"
          description={
            technicians.length === 0
              ? "Every active technician already has an employment record."
              : "Only technicians without a record are listed."
          }
        >
          {({ id, describedBy }) => (
            <Select id={id} name="technicianId" defaultValue="" aria-describedby={describedBy}>
              <option value="">Not a technician — office or unassigned</option>
              {technicians.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.fullName} · {t.employeeCode}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Opening…"
          className="btn btn-primary disabled:opacity-60"
        >
          Open record
        </SubmitButton>
      </form>
    </details>
  );
}
