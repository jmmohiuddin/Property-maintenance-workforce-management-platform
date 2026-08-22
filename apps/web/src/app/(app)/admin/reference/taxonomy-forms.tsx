"use client";

import { useActionState } from "react";
import { services } from "@meridian/core";
import { Field, FormBanner, Select, SubmitButton, TextInput } from "@/components/form";
import type { ReferenceState } from "./actions";
import {
  addAssetKind,
  addDisposition,
  addFault,
  addOutcome,
  addPhotoExemption,
  addRate,
  installAssetKinds,
  installDispositions,
  installOutcomes,
  installPhotoExemptions,
  stopRate,
  toggleAssetKind,
  toggleDisposition,
  toggleFault,
  toggleOutcome,
  togglePhotoExemption,
} from "./taxonomy-actions";

const INITIAL: ReferenceState = {};

/**
 * Controls for the controlled vocabularies (`ADM-10`).
 *
 * Server-action forms that work with JavaScript switched off, like every other
 * form in this application. Nothing here is a modal and nothing here is a
 * multi-step wizard: adding a code is one row of inputs and a button, because
 * the failure being designed against is not a mis-click, it is an operator
 * deciding it is easier to type the reason into the notes field.
 *
 * `ADM-10`'s point is that this stops being an engineering ticket. A screen
 * that makes editing a taxonomy feel like a form submission rather than a
 * request is the entire deliverable.
 */

function Feedback({ state }: { state: ReferenceState }) {
  if (state.error) return <FormBanner tone="error">{state.error}</FormBanner>;
  if (state.success) return <FormBanner tone="success">{state.success}</FormBanner>;
  return null;
}

/**
 * Retire or restore, in one click.
 *
 * The button posts the state it wants rather than "flip it", so two open tabs
 * cannot produce a change nobody asked for. There is no confirmation step: this
 * destroys nothing — the row stays, the leads and visits citing it keep citing
 * it — and a confirmation people learn to click through on a reversible action
 * is what makes them click through the one that matters.
 */
export function RetireButton({
  kind,
  id,
  label,
  isActive,
}: {
  kind: "disposition" | "fault" | "outcome" | "assetKind" | "photoExemption";
  id: string;
  label: string;
  isActive: boolean;
}) {
  const action =
    kind === "disposition"
      ? toggleDisposition
      : kind === "fault"
        ? toggleFault
        : kind === "assetKind"
          ? toggleAssetKind
          : kind === "photoExemption"
            ? togglePhotoExemption
            : toggleOutcome;
  const [state, formAction, pending] = useActionState(action, INITIAL);

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="label" value={label} />
      <input type="hidden" name="activate" value={isActive ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: isActive ? "var(--status-critical-text)" : "var(--accent-text)" }}
      >
        {pending ? "Saving…" : isActive ? "Retire" : "Restore"}
      </button>
      {state.error ? <span className="text-[12px]">{state.error}</span> : null}
    </form>
  );
}

// ── Lead disposition reasons (LEAD-6) ───────────────────────────────────────

export function InstallDispositionsButton({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(installDispositions, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        {label}
      </SubmitButton>
    </form>
  );
}

export function AddDispositionForm() {
  const [state, formAction, pending] = useActionState(addDisposition, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Reason"
          description="The words a salesperson would actually say. “Price too high”, not “commercial”."
        >
          {({ id }) => <TextInput id={id} name="label" required autoComplete="off" />}
        </Field>
        <Field
          label="Applies to"
          description="Lost means it will not happen. Dormant means not now."
        >
          {({ id }) => (
            <Select id={id} name="appliesTo" defaultValue="both">
              <option value="both">Lost and dormant</option>
              <option value="lost">Lost only</option>
              <option value="dormant">Dormant only</option>
            </Select>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field
          label="Guidance"
          description="When to pick this one rather than the next one along. Optional, and worth a line."
        >
          {({ id }) => <TextInput id={id} name="guidance" autoComplete="off" />}
        </Field>
        <Field label="Code" description="Left blank, it is built from the reason.">
          {({ id }) => <TextInput id={id} name="code" autoComplete="off" />}
        </Field>
        <Field label="Order" description="Lower shows first in the picker.">
          {({ id }) => (
            <TextInput
              id={id}
              name="sortOrder"
              type="number"
              inputMode="numeric"
              defaultValue="100"
              step={10}
            />
          )}
        </Field>
      </div>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add reason
      </SubmitButton>
    </form>
  );
}

// ── Fault codes (JOB-14) ────────────────────────────────────────────────────

export function AddFaultForm({ defaultKind }: { defaultKind: "symptom" | "cause" | "remedy" }) {
  const [state, formAction, pending] = useActionState(addFault, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Part">
          {({ id }) => (
            <Select id={id} name="kind" defaultValue={defaultKind}>
              <option value="symptom">Symptom — what was reported</option>
              <option value="cause">Cause — what was found</option>
              <option value="remedy">Remedy — what was done</option>
            </Select>
          )}
        </Field>
        <Field label="Code reads as" description="A technician's words, not a category name.">
          {({ id }) => <TextInput id={id} name="label" required autoComplete="off" />}
        </Field>
        <Field
          label="Service"
          description="Leave as every service unless it only makes sense for one trade."
        >
          {({ id }) => (
            <Select id={id} name="serviceSlug" defaultValue="">
              <option value="">Every service</option>
              {services.map((service) => (
                <option key={service.slug} value={service.slug}>
                  {service.shortName}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Description" description="Optional. What separates this from the one beside it.">
          {({ id }) => <TextInput id={id} name="description" autoComplete="off" />}
        </Field>
        <Field label="Code" description="Left blank, it is built from the wording.">
          {({ id }) => <TextInput id={id} name="code" autoComplete="off" />}
        </Field>
        <Field label="Order">
          {({ id }) => (
            <TextInput
              id={id}
              name="sortOrder"
              type="number"
              inputMode="numeric"
              defaultValue="100"
              step={10}
            />
          )}
        </Field>
      </div>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add code
      </SubmitButton>
    </form>
  );
}

// ── Job outcome codes (JOB-13) ──────────────────────────────────────────────

export function InstallOutcomesButton({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(installOutcomes, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        {label}
      </SubmitButton>
    </form>
  );
}

export function AddOutcomeForm() {
  const [state, formAction, pending] = useActionState(addOutcome, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Outcome" description="How a technician would report it on the phone.">
          {({ id }) => <TextInput id={id} name="label" required autoComplete="off" />}
        </Field>
        <Field label="Description">
          {({ id }) => <TextInput id={id} name="description" autoComplete="off" />}
        </Field>
        <Field label="Order">
          {({ id }) => (
            <TextInput
              id={id}
              name="sortOrder"
              type="number"
              inputMode="numeric"
              defaultValue="100"
              step={10}
            />
          )}
        </Field>
      </div>
      <label className="flex items-start gap-2 text-[14px]">
        <input type="checkbox" name="requiresReturnVisit" className="mt-1" />
        <span>
          Work is still owed after this outcome
          <span className="block text-[13px]" style={{ color: "var(--text-muted)" }}>
            The job stays open and a return visit is expected. This is what stops “no access” from
            being counted as a finished visit.
          </span>
        </span>
      </label>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add outcome
      </SubmitButton>
    </form>
  );
}

// ── Asset kinds (CON-13) ────────────────────────────────────────────────────

export function InstallAssetKindsButton({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(installAssetKinds, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        {label}
      </SubmitButton>
    </form>
  );
}

/**
 * Add a kind of plant.
 *
 * The service interval belongs to the kind rather than to the asset because it
 * is a property of the equipment, not of the building: a lift is inspected
 * monthly and a tank cleaned twice a year whoever is entering it. It prefills
 * the register and every asset can still override it.
 */
export function AddAssetKindForm() {
  const [state, formAction, pending] = useActionState(addAssetKind, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Kind" description="What a technician calls it — “Cooling tower”, “Fire pump”.">
          {({ id }) => <TextInput id={id} name="label" required autoComplete="off" />}
        </Field>
        <Field label="Description" description="When to choose this one rather than the one next to it.">
          {({ id }) => <TextInput id={id} name="description" autoComplete="off" />}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Serviced by" description="Which trade attends it.">
          {({ id }) => (
            <Select id={id} name="serviceSlug" defaultValue="">
              <option value="">No particular trade</option>
              {services.map((service) => (
                <option key={service.slug} value={service.slug}>
                  {service.shortName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Service every (days)"
          description="Left empty means the register asks per asset."
        >
          {({ id }) => (
            <TextInput id={id} name="defaultPpmIntervalDays" type="number" inputMode="numeric" step={30} />
          )}
        </Field>
        <Field label="Order">
          {({ id }) => (
            <TextInput id={id} name="sortOrder" type="number" inputMode="numeric" defaultValue="100" step={10} />
          )}
        </Field>
      </div>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add kind
      </SubmitButton>
    </form>
  );
}

// ── Rate card (QTE-4) ───────────────────────────────────────────────────────

const UNITS = [
  { value: "hour", label: "per hour" },
  { value: "visit", label: "per visit" },
  { value: "point", label: "per point" },
  { value: "item", label: "per item" },
  { value: "m2", label: "per m²" },
  { value: "metre", label: "per metre" },
  { value: "day", label: "per day" },
  { value: "month", label: "per month" },
] as const;

const BANDS = [
  { value: "standard", label: "Standard" },
  { value: "after_hours", label: "After hours" },
  { value: "emergency", label: "Emergency" },
  { value: "weekend", label: "Weekend" },
] as const;

/**
 * Add a price, or replace one.
 *
 * Reusing an existing code is how a price *rise* is entered: the current period
 * closes on the date the new one starts and stays readable afterwards. That is
 * the whole design of the table, so the form says so rather than hiding it
 * behind an "edit" button that would imply the old number is gone.
 */
export function AddRateForm({ today, defaultCode }: { today: string; defaultCode?: string }) {
  const [state, formAction, pending] = useActionState(addRate, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Line reads as" description="Exactly as it should appear on a quotation.">
          {({ id }) => (
            <TextInput id={id} name="label" required autoComplete="off" />
          )}
        </Field>
        <Field label="Service">
          {({ id }) => (
            <Select id={id} name="serviceSlug" required defaultValue="">
              <option value="" disabled>
                Choose a service
              </option>
              {services.map((service) => (
                <option key={service.slug} value={service.slug}>
                  {service.shortName}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Unit">
          {({ id }) => (
            <Select id={id} name="unit" defaultValue="hour">
              {UNITS.map((unit) => (
                <option key={unit.value} value={unit.value}>
                  {unit.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Rate band" description="Each band is priced separately.">
          {({ id }) => (
            <Select id={id} name="rateBand" defaultValue="standard">
              {BANDS.map((band) => (
                <option key={band.value} value={band.value}>
                  {band.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Price (AED)" description="Dirhams and fils, e.g. 250 or 250.50.">
          {({ id }) => (
            <TextInput id={id} name="unitPrice" required inputMode="decimal" autoComplete="off" />
          )}
        </Field>
        <Field label="Minimum" description="Optional. “Minimum one hour” lives here.">
          {({ id }) => <TextInput id={id} name="minQuantity" inputMode="decimal" autoComplete="off" />}
        </Field>
        <Field label="Applies from" description="Today, or the date the new price takes effect.">
          {({ id }) => (
            <TextInput id={id} name="effectiveFrom" type="date" required defaultValue={today} />
          )}
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Notes" description="What the price includes, or what it excludes.">
          {({ id }) => <TextInput id={id} name="notes" autoComplete="off" />}
        </Field>
        <Field
          label="Code"
          description="Left blank, it is built from the service and the wording. Reuse a code to raise that price."
        >
          {({ id }) => (
            <TextInput id={id} name="code" autoComplete="off" defaultValue={defaultCode ?? ""} />
          )}
        </Field>
      </div>

      <label className="flex items-start gap-2 text-[14px]">
        <input type="checkbox" name="isPublished" className="mt-1" />
        <span>
          Show on the published schedule of rates
          <span className="block text-[13px]" style={{ color: "var(--text-muted)" }}>
            Not every rate is a public rate. Contract pricing and work bought in at cost normally
            stay off it.
          </span>
        </span>
      </label>

      <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-primary disabled:opacity-60">
        Save price
      </SubmitButton>
    </form>
  );
}

export function StopRateButton({
  code,
  rateBand,
  label,
  today,
}: {
  code: string;
  rateBand: string;
  label: string;
  today: string;
}) {
  const [state, formAction, pending] = useActionState(stopRate, INITIAL);

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="rateBand" value={rateBand} />
      <input type="hidden" name="label" value={label} />
      <label className="sr-only" htmlFor={`stop-${code}-${rateBand}`}>
        Last day {label} applies
      </label>
      <input
        id={`stop-${code}-${rateBand}`}
        type="date"
        name="endsOn"
        defaultValue={today}
        className="rounded-sm border px-2 py-1 text-[13px]"
        style={{
          backgroundColor: "var(--surface-raised)",
          color: "var(--text-primary)",
          borderColor: "var(--border-strong)",
        }}
      />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: "var(--status-critical-text)" }}
      >
        {pending ? "Saving…" : "Stop charging"}
      </button>
      {state.error ? <span className="text-[12px]">{state.error}</span> : null}
    </form>
  );
}

// ── Photo exemption reasons (JOB-15) ────────────────────────────────────────

export function InstallPhotoExemptionsButton({ label }: { label: string }) {
  const [state, formAction, pending] = useActionState(installPhotoExemptions, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <Feedback state={state} />
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        {label}
      </SubmitButton>
    </form>
  );
}

/**
 * Add a reason an "after" photograph is missing.
 *
 * No free-text alternative anywhere on this screen, and none in the job card
 * either. `JOB-15` says "an explicit reason-coded exemption", and the whole
 * value of the clause is being able to ask later whether photographs are
 * missing because some work is genuinely unphotographable or because one crew
 * learnt that typing anything gets them past the gate. A text box answers
 * neither question.
 */
export function AddPhotoExemptionForm() {
  const [state, formAction, pending] = useActionState(addPhotoExemption, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Reason" description="How a technician would say it on the phone.">
          {({ id }) => <TextInput id={id} name="label" required autoComplete="off" />}
        </Field>
        <Field
          label="Description"
          description="When this applies, so two reasons do not overlap."
        >
          {({ id }) => <TextInput id={id} name="description" autoComplete="off" />}
        </Field>
        <Field label="Order">
          {({ id }) => (
            <TextInput
              id={id}
              name="sortOrder"
              type="number"
              inputMode="numeric"
              defaultValue="100"
              step={10}
            />
          )}
        </Field>
      </div>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add reason
      </SubmitButton>
    </form>
  );
}
