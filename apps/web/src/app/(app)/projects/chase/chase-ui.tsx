"use client";

import { useActionState } from "react";
import { Field, TextInput, FormBanner } from "@/components/form";
import { decideSubcontractApprovalAction, type ProjectFormState } from "../actions";

const INITIAL: ProjectFormState = {};

function Banner({ state }: { state: ProjectFormState }) {
  return (
    <>
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}
    </>
  );
}

/**
 * The one act this screen was missing: recording the employer's answer.
 *
 * `decideSubcontractApproval` (`packages/db/src/domain/projects.ts`) is new
 * tonight — there was previously no way, anywhere in this application, to move
 * `client_approval_state` off whatever `engageSubcontractor` set it to. Every
 * row this form renders beside is `pending` or `refused` by construction
 * (`listUnapprovedSubcontracts` excludes anything else), so this is the whole
 * reason the row is actionable rather than merely readable.
 *
 * One `useActionState` per row, not one for the table, for the same reason
 * every panel on the project detail screen gets its own: a refused decision on
 * one engagement must not blank the confirmation that just appeared beside a
 * different one.
 */
export function SubcontractDecisionForm({
  projectId,
  subcontractId,
  refusable,
}: {
  projectId: string;
  subcontractId: string;
  /** Whether "refused" is still a legal move — false once already refused. */
  refusable: boolean;
}) {
  const [state, formAction, pending] = useActionState(decideSubcontractApprovalAction, INITIAL);

  return (
    <form action={formAction} className="mt-2 flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="subcontractId" value={subcontractId} />
      <div className="w-full basis-full">
        <Banner state={state} />
      </div>
      <div className="w-56">
        <Field label="Approval reference" description="The employer's letter, if it has one yet.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="approvalReference" maxLength={64} aria-describedby={describedBy} />
          )}
        </Field>
      </div>
      {/*
        Two submit buttons, one form, one `useActionState` — the standard HTML
        way to let the same submission carry a different value for `to`
        depending on which was pressed. `SubmitButton` does not forward `name`
        or `value`, so these are plain buttons carrying the same pending state
        and the same disabled-while-saving behaviour by hand.
      */}
      <button
        type="submit"
        name="to"
        value="approved"
        disabled={pending}
        className="btn btn-primary disabled:opacity-60"
      >
        {pending ? "Saving…" : "Approved"}
      </button>
      {refusable ? (
        <button
          type="submit"
          name="to"
          value="refused"
          disabled={pending}
          className="btn btn-secondary disabled:opacity-60"
        >
          {pending ? "Saving…" : "Refused"}
        </button>
      ) : null}
    </form>
  );
}
