"use client";

import { useActionState } from "react";
import { Field, TextInput, FormBanner, SubmitButton } from "@/components/form";
import {
  addHoliday,
  addRamadan,
  removeHoliday,
  removeRamadan,
  saveWorkingWeek,
  type ReferenceState,
} from "./actions";

const INITIAL: ReferenceState = {};

/**
 * Controls for `/admin/reference` (`ADM-10`).
 *
 * Every one is a server-action form that works with JavaScript switched off,
 * which is the standing architectural choice rather than a gap: this screen is
 * opened on a phone on a site visit as often as at a desk.
 */

function Feedback({ state }: { state: ReferenceState }) {
  if (state.error) return <FormBanner tone="error">{state.error}</FormBanner>;
  if (state.success) return <FormBanner tone="success">{state.success}</FormBanner>;
  return null;
}

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const;

/**
 * The working week.
 *
 * The wireframe draws this as "Sat–Sun / Fri–Sat / Custom" radio buttons with a
 * custom pattern hidden behind the third. Seven checkboxes express all three
 * without any of the state-swapping that would need JavaScript to work, and a
 * company running a single-day weekend — which happens — does not have to find
 * the "custom" option to say so.
 */
export function WorkingWeekForm({
  weekend,
  openTime,
  closeTime,
  minBreakMinutes,
}: {
  weekend: readonly number[];
  openTime: string;
  closeTime: string;
  minBreakMinutes: number;
}) {
  const [state, formAction, pending] = useActionState(saveWorkingWeek, INITIAL);

  return (
    <form action={formAction} className="space-y-5">
      <Feedback state={state} />

      <fieldset>
        <legend className="text-[14px] font-medium">Weekend</legend>
        <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Saturday and Sunday is the common private-sector arrangement, not a rule. Nothing is
          scheduled on these days and SLA clocks do not run.
        </p>
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
          {WEEKDAYS.map((day) => (
            <label key={day.value} className="flex items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                name="weekend"
                value={day.value}
                defaultChecked={weekend.includes(day.value)}
              />
              {day.label}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Opens">
          {({ id }) => <TextInput id={id} name="openTime" type="time" defaultValue={openTime} required />}
        </Field>
        <Field label="Closes" description="Two hours earlier during Ramadan, by statute.">
          {({ id }) => <TextInput id={id} name="closeTime" type="time" defaultValue={closeTime} required />}
        </Field>
        <Field label="Break (minutes)" description="At least 60, due after 5 consecutive hours. Longer is allowed.">
          {({ id }) => (
            <TextInput
              id={id}
              name="minBreakMinutes"
              type="number"
              inputMode="numeric"
              min={60}
              step={15}
              defaultValue={String(minBreakMinutes)}
              required
            />
          )}
        </Field>
      </div>

      <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-primary disabled:opacity-60">
        Save working week
      </SubmitButton>
    </form>
  );
}

export function AddHolidayForm() {
  const [state, formAction, pending] = useActionState(addHoliday, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Date">{({ id }) => <TextInput id={id} name="date" type="date" required />}</Field>
        <Field label="Holiday">
          {({ id }) => <TextInput id={id} name="name" required autoComplete="off" />}
        </Field>
        <Field label="Source" description="Where the date was confirmed. Optional, and worth a line.">
          {({ id }) => <TextInput id={id} name="sourceNote" autoComplete="off" />}
        </Field>
      </div>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add holiday
      </SubmitButton>
    </form>
  );
}

export function AddRamadanForm() {
  const [state, formAction, pending] = useActionState(addRamadan, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />
      <div className="grid gap-4 sm:grid-cols-4">
        <Field label="Period">
          {({ id }) => <TextInput id={id} name="label" required autoComplete="off" />}
        </Field>
        <Field label="First day">
          {({ id }) => <TextInput id={id} name="startsOn" type="date" required />}
        </Field>
        <Field label="Last day">{({ id }) => <TextInput id={id} name="endsOn" type="date" required />}</Field>
        <Field label="Source">{({ id }) => <TextInput id={id} name="sourceNote" autoComplete="off" />}</Field>
      </div>
      <SubmitButton pending={pending} pendingLabel="Adding…" className="btn btn-primary disabled:opacity-60">
        Add period
      </SubmitButton>
    </form>
  );
}

/**
 * Remove, in one click and with no confirmation step.
 *
 * The convention elsewhere is reveal-then-confirm for destructive actions, and
 * this is deliberately not one of those. Removing a holiday deletes a row that
 * can be retyped in ten seconds from the same form directly below, it signs
 * nobody out and it destroys no history — the audit log keeps the name. A
 * confirmation people learn to click through on a harmless action is what makes
 * them click through the one on a harmful one.
 */
export function RemoveButton({
  kind,
  id,
  label,
}: {
  kind: "holiday" | "ramadan";
  id: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(
    kind === "holiday" ? removeHoliday : removeRamadan,
    INITIAL,
  );

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="label" value={label} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: "var(--status-critical-text)" }}
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {state.error ? <span className="text-[12px]">{state.error}</span> : null}
    </form>
  );
}
