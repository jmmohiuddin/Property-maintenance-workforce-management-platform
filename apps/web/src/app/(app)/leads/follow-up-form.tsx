"use client";

import { useActionState } from "react";
import { setFollowUp, type LogState } from "./actions";

const INITIAL: LogState = {};

/**
 * Set or clear when this lead is next chased.
 *
 * ── WHY THE DATE IS UNCONTROLLED ───────────────────────────────────────────
 *
 * The same trap `stage-form.tsx` documents. React resets a form's DOM after a
 * server action, and a controlled field whose state did not change is not
 * re-rendered — so a refused submission leaves the component's state and the
 * visible input disagreeing, and the next submit posts the value nobody is
 * looking at. `defaultValue` re-derives from the server on every render of the
 * page, which is what the operator sees.
 *
 * Clearing is an explicit button rather than "submit an empty field", because
 * an empty date box next to a Save button reads as "unchanged" to most people
 * and the two actions have opposite meanings.
 */
export function FollowUpForm({
  leadId,
  nextFollowUpAt,
}: {
  leadId: string;
  nextFollowUpAt: Date | null;
}) {
  const [state, formAction, pending] = useActionState(setFollowUp, INITIAL);

  // `toISOString().slice(0, 10)` is UTC, and that is deliberate: the action
  // parses the value back as UTC midnight too, so the round trip is stable. A
  // Dubai-local formatter here and a UTC parser there would move the date by a
  // day for anything set after 20:00.
  const value = nextFollowUpAt ? nextFollowUpAt.toISOString().slice(0, 10) : "";

  return (
    <form action={formAction} className="mt-2">
      <input type="hidden" name="leadId" value={leadId} />
      <input
        type="date"
        name="nextFollowUpAt"
        defaultValue={value}
        aria-label="Next follow-up"
        className="w-full rounded-sm border px-3 py-2 text-[14px] outline-none focus:border-[var(--accent)]"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[13px] disabled:opacity-60">
          {pending ? "Saving…" : "Set"}
        </button>
        <button
          type="submit"
          disabled={pending}
          // Posts an empty value regardless of what is in the date input.
          // `formNoValidate` because an empty required-ish date is exactly what
          // this button means.
          formNoValidate
          onClick={(e) => {
            const form = e.currentTarget.form;
            const input = form?.elements.namedItem("nextFollowUpAt");
            if (input instanceof HTMLInputElement) input.value = "";
          }}
          className="btn btn-secondary !py-2 text-[13px] disabled:opacity-60"
        >
          Clear
        </button>
      </div>

      {state.error ? (
        <p role="alert" className="mt-2 text-[13px]" style={{ color: "var(--accent-text)" }}>
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {state.success}
        </p>
      ) : null}
    </form>
  );
}
