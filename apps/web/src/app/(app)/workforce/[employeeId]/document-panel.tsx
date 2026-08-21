"use client";

import { useActionState } from "react";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  saveEmployeeDocument,
  withdrawEmployeeDocument,
  type WorkforceFormState,
} from "../actions";

const INITIAL: WorkforceFormState = {};

/**
 * The document types, passed in rather than imported.
 *
 * `@meridian/db` is the whole database package — importing its constants into a
 * client component drags the postgres driver into the browser bundle, which
 * fails the build on `net` and `tls` and would have shipped the connection code
 * to the client if it had not. The server owns the catalogue; this component
 * renders what it is handed.
 */
export interface DocumentKindOption {
  readonly value: string;
  readonly label: string;
  readonly blocking: boolean;
  readonly onFile: boolean;
}

/**
 * Record a document, or record its renewal.
 *
 * One form for both, because they are the same act: the server upserts on
 * `(employee_id, kind)`, so submitting a work permit that already exists
 * replaces the expiry rather than leaving the lapsed row behind to block
 * somebody whose paperwork is now in order.
 */
export function DocumentPanel({
  employeeId,
  kinds,
}: {
  employeeId: string;
  kinds: readonly DocumentKindOption[];
}) {
  const [state, formAction, pending] = useActionState(saveEmployeeDocument, INITIAL);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Record a document</h2>
      <p className="prose-body mt-2 text-[14px]">
        Five documents stop a dispatch when they lapse: MOHRE work permit, residence visa, Emirates
        ID, medical fitness certificate and health insurance. The rest are recorded for the file and
        warn at assignment. Which is which is decided by the document type, not by this form.
      </p>

      <form action={formAction} className="mt-6 space-y-5">
        <input type="hidden" name="employeeId" value={employeeId} />

        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <Field
          label="Document"
          description="Recording a type that is already on file replaces it — that is how a renewal is entered."
        >
          {({ id, describedBy }) => (
            <Select id={id} name="kind" required defaultValue="" aria-describedby={describedBy}>
              <option value="" disabled>
                Choose a document type
              </option>
              {kinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                  {kind.blocking ? " — blocks dispatch on expiry" : ""}
                  {kind.onFile ? " (on file — will be replaced)" : ""}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Expiry date"
            description="Required. A document with no expiry never warns and never blocks, which is worse than no document at all."
          >
            {({ id, describedBy }) => (
              <TextInput id={id} name="expiresAt" type="date" required aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Issue date" description="Optional.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="issuedAt" type="date" aria-describedby={describedBy} />
            )}
          </Field>
        </div>

        <Field
          label="Reference number"
          description="Optional. The permit, policy or card number, so a renewal can be chased without opening the file."
        >
          {({ id, describedBy }) => (
            <TextInput id={id} name="referenceNo" autoComplete="off" aria-describedby={describedBy} />
          )}
        </Field>

        <Field label="Note" description="Optional. Where the renewal has got to, if it has started.">
          {({ id, describedBy }) => (
            <TextArea id={id} name="note" rows={2} aria-describedby={describedBy} />
          )}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Recording…"
          className="btn btn-primary disabled:opacity-60"
        >
          Record document
        </SubmitButton>
      </form>
    </section>
  );
}

/**
 * Withdraw a document from the file.
 *
 * For a mis-typed entry, not for a renewal — a renewal is the form above. The
 * server soft-deletes, so the row survives for the `HR-15` retention period and
 * "what did we hold on the day we sent this person to site" stays answerable.
 */
export function WithdrawDocument({
  documentId,
  employeeId,
  label,
}: {
  documentId: string;
  employeeId: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(withdrawEmployeeDocument, INITIAL);

  return (
    <form action={formAction} className="text-right">
      <input type="hidden" name="documentId" value={documentId} />
      <input type="hidden" name="employeeId" value={employeeId} />
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
