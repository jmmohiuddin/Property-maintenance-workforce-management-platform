"use client";

import { useActionState } from "react";
import {
  BILLING_FREQUENCIES,
  BILLING_FREQUENCY_LABEL,
  COVERAGE_TYPES,
  COVERAGE_TYPE_DESCRIPTION,
  COVERAGE_TYPE_LABEL,
  STANDARD_AMC_EXCLUSIONS,
} from "@meridian/core";
import { Field, TextInput, Select, FormBanner, SubmitButton } from "@/components/form";
import { createContractAction, type ContractFormState } from "./actions";

const INITIAL: ContractFormState = {};

/**
 * Write a contract (`CON-1`, `CON-2`).
 *
 * `<details>` and a plain server action rather than a multi-step wizard with
 * client state, for the same reason the employment register uses one: this is
 * the only way into the table, and a form that needs JavaScript is a table that
 * cannot be populated on a site-office connection.
 *
 * ── WHY THE ENTITLEMENT ROWS ARE FIXED ──────────────────────────────────────
 *
 * Four rows, always rendered, blank ones ignored. An "add another" button needs
 * client state and buys nothing: a contract with more than four service
 * families in it is rare enough to be worth a second edit, and four empty
 * selects cost nothing to skip past. This is the trade that keeps the form
 * working with scripting off.
 *
 * ── WHY EXCLUSIONS ARE TICKED BY DEFAULT ────────────────────────────────────
 *
 * The seven in `STANDARD_AMC_EXCLUSIONS` are what every comprehensive AMC in
 * this market carves out, because each is a component whose replacement cost
 * exceeds a year of contract value. A contract that omits them is not generous,
 * it is mispriced — so the default is to include them and unticking one is a
 * deliberate act.
 */
export function NewContractForm({
  customers,
  properties,
  services,
}: {
  customers: { id: string; name: string; code: string }[];
  properties: {
    id: string;
    name: string;
    area: string | null;
    customerId: string;
    customerName: string;
    activeContracts: number;
  }[];
  services: { slug: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(createContractAction, INITIAL);

  return (
    <details className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <summary className="cursor-pointer text-[14px] font-semibold">Write a contract</summary>

      <p className="prose-body mt-2 text-[13px]">
        Created as a draft. Activating it is what generates the planned visits for the whole term —
        a contract marked active with no schedule looks correct on every screen and produces no
        work.
      </p>

      <form action={formAction} className="mt-5 space-y-6">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Contract name" description="What the customer calls it on their side.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="name"
                required
                minLength={2}
                autoComplete="off"
                placeholder="Bay Tower — comprehensive AMC"
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
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold">Contract type</legend>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            These two differ in who carries parts risk, which is the thing that decides whether an
            AMC makes money.
          </p>
          {COVERAGE_TYPES.map((type, i) => (
            <label key={type} className="flex items-start gap-2.5 text-[13px]">
              <input
                type="radio"
                name="coverageType"
                value={type}
                defaultChecked={i === 0}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{COVERAGE_TYPE_LABEL[type]}</span>{" "}
                <span style={{ color: "var(--text-muted)" }}>
                  &mdash; {COVERAGE_TYPE_DESCRIPTION[type]}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Starts">
            {({ id, describedBy }) => (
              <TextInput id={id} name="startsOn" type="date" required aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Ends">
            {({ id, describedBy }) => (
              <TextInput id={id} name="endsOn" type="date" required aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Annual value" description="Excluding VAT.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="annualValue"
                required
                inputMode="decimal"
                pattern="\d+(\.\d{1,2})?"
                placeholder="42000.00"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Billing">
            {({ id, describedBy }) => (
              <Select
                id={id}
                name="billingFrequency"
                defaultValue="quarterly"
                aria-describedby={describedBy}
              >
                {BILLING_FREQUENCIES.map((f) => (
                  <option key={f} value={f}>
                    {BILLING_FREQUENCY_LABEL[f]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Out-of-scope discount (%)"
            description="Applied to any quote raised for work this contract does not cover."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="discountPercent"
                inputMode="decimal"
                defaultValue="15"
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field
            label="Callouts per year"
            description="Leave blank for unlimited — a real and common term, not a missing value."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="calloutsPerYear"
                inputMode="numeric"
                placeholder="unlimited"
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold">Properties covered</legend>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Each covered property gets its own copy of the visit schedule. Properties must belong to
            the customer chosen above.
          </p>
          {properties.length === 0 ? (
            <p className="text-[13px]" style={{ color: "var(--status-warning-text)" }}>
              No properties exist yet. Add one on the customer record first &mdash; a contract with
              no property generates no visits.
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto rounded border p-3">
              {properties.map((p) => (
                <label key={p.id} className="flex items-start gap-2.5 py-1 text-[13px]">
                  <input type="checkbox" name="propertyId" value={p.id} className="mt-1" />
                  <span>
                    <span className="font-medium">{p.name}</span>
                    <span style={{ color: "var(--text-muted)" }}>
                      {p.area ? ` · ${p.area}` : ""} · {p.customerName}
                      {p.activeContracts > 0
                        ? ` · already under ${p.activeContracts} active contract${p.activeContracts === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-semibold">Entitlements</legend>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Scheduled visits per service family per year. This is what generates the schedule, so a
            contract with none of these produces no work at all. Four rows; leave the ones you do
            not need blank.
          </p>
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="grid gap-3 sm:grid-cols-[3fr_1fr]">
              <Select name="entitlementService" defaultValue="" aria-label={`Service ${row + 1}`}>
                <option value="">&mdash;</option>
                {services.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <TextInput
                name="entitlementVisits"
                inputMode="numeric"
                defaultValue={row === 0 ? "4" : ""}
                placeholder="visits/yr"
                aria-label={`Visits per year ${row + 1}`}
              />
            </div>
          ))}
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-[13px] font-semibold">Exclusions</legend>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Machine-readable, not an annexe. Work matching one of these raises a quote at the
            contract discount instead of being absorbed &mdash; the single mechanism that stops a
            comprehensive AMC becoming a loss.
          </p>
          <div className="rounded border p-3">
            {STANDARD_AMC_EXCLUSIONS.map((e) => (
              <label key={e.code} className="flex items-start gap-2.5 py-1 text-[13px]">
                <input
                  type="checkbox"
                  name="exclusionCode"
                  value={e.code}
                  defaultChecked
                  className="mt-1"
                />
                <span>
                  <span className="font-medium">{e.label}</span>{" "}
                  <span style={{ color: "var(--text-muted)" }}>&mdash; {e.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <SubmitButton
          pending={pending}
          pendingLabel="Creating…"
          className="btn btn-primary disabled:opacity-60"
        >
          Create draft contract
        </SubmitButton>
      </form>
    </details>
  );
}
