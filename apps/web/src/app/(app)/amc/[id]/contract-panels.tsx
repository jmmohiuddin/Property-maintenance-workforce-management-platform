"use client";

import { useActionState } from "react";
// From `core`, not `@meridian/db`: this is a client component, and importing
// the domain barrel here pulls the Postgres driver into the browser bundle.
import {
  CONTRACT_DOCUMENT_KINDS,
  CONTRACT_DOCUMENT_LABEL,
  type ContractDocumentKind,
} from "@meridian/core";
import { Field, TextInput, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  activateContractAction,
  attachContractDocumentAction,
  generateRenewalQuoteAction,
  type ContractFormState,
} from "../actions";

const INITIAL: ContractFormState = {};

/**
 * Activate the contract, and generate its schedule (`CON-1`, `CON-3`).
 *
 * One button for both, because they are one act. A contract marked active with
 * no planned visits reads as correct on every screen and produces no work, and
 * nobody would find out until an OA management company asked for a PPM
 * completion report at renewal.
 */
export function ActivatePanel({
  contractId,
  status,
  entitlementCount,
  propertyCount,
}: {
  contractId: string;
  status: string;
  entitlementCount: number;
  propertyCount: number;
}) {
  const [state, formAction, pending] = useActionState(activateContractAction, INITIAL);

  const generated = entitlementCount > 0 && propertyCount > 0;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="contractId" value={contractId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {status === "active"
          ? "Already active. Re-running generation adds only the dates that are missing — it will " +
            "not duplicate a visit or undo one a dispatcher has moved."
          : "Activating generates the planned visits for the whole term, against the working " +
            "calendar. No visit is placed on a public holiday, a weekend, or inside the summer " +
            "midday ban."}
      </p>

      {!generated ? (
        <p className="text-[13px]" style={{ color: "var(--status-warning-text)" }}>
          This contract has {entitlementCount} entitlement(s) and {propertyCount} propert
          {propertyCount === 1 ? "y" : "ies"}, so it would generate nothing.
        </p>
      ) : null}

      <SubmitButton
        pending={pending}
        pendingLabel="Generating…"
        className="btn btn-primary disabled:opacity-60"
      >
        {status === "active" ? "Regenerate the schedule" : "Activate and generate the schedule"}
      </SubmitButton>
    </form>
  );
}

/** `CON-8`. Prefilled from the contract's own value and utilisation. */
export function RenewalPanel({
  contractId,
  daysRemaining,
}: {
  contractId: string;
  daysRemaining: number;
}) {
  const [state, formAction, pending] = useActionState(generateRenewalQuoteAction, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="contractId" value={contractId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
        {daysRemaining < 0
          ? "This contract has already expired and is generating no planned visits. A renewal quote " +
            "is still the right first move — the customer has not been served since it lapsed."
          : "Drafts a quotation from this contract's own annual value, prior-term job count and " +
            "entitlement utilisation. Nothing is sent to the customer."}
      </p>

      <SubmitButton
        pending={pending}
        pendingLabel="Drafting…"
        className="btn btn-secondary disabled:opacity-60"
      >
        Generate renewal quote
      </SubmitButton>
    </form>
  );
}

/** `CON-10`. Versioned; an earlier version is never overwritten. */
export function DocumentPanel({ contractId }: { contractId: string }) {
  const [state, formAction, pending] = useActionState(attachContractDocumentAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="contractId" value={contractId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <Field label="Type">
        {({ id, describedBy }) => (
          <Select id={id} name="kind" defaultValue="signed_contract" aria-describedby={describedBy}>
            {CONTRACT_DOCUMENT_KINDS.map((k: ContractDocumentKind) => (
              <option key={k} value={k}>
                {CONTRACT_DOCUMENT_LABEL[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <Field label="Title">
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            name="title"
            required
            minLength={2}
            autoComplete="off"
            aria-describedby={describedBy}
          />
        )}
      </Field>

      <Field
        label="Storage key"
        description="Direct upload from this screen is not built. The key is recorded so the document is findable; nothing here pretends the file was received."
      >
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            name="storageKey"
            required
            autoComplete="off"
            placeholder="contracts/CON-2026-00001/signed-v1.pdf"
            aria-describedby={describedBy}
          />
        )}
      </Field>

      <SubmitButton
        pending={pending}
        pendingLabel="Attaching…"
        className="btn btn-secondary disabled:opacity-60"
      >
        Attach
      </SubmitButton>
    </form>
  );
}
