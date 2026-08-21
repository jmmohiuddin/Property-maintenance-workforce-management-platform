"use client";

import { useActionState } from "react";
import { setPreference, type PreferenceState } from "./actions";
import { Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: PreferenceState = {};

/**
 * One notification, one switch (`POR-5`).
 *
 * ── WHY EACH ROW IS ITS OWN FORM ───────────────────────────────────────────
 *
 * A single form with seven checkboxes and a Save button is fewer requests and
 * the wrong trade. Unchecked checkboxes are simply absent from a form post, so
 * a partially-loaded page or a stale render submits "off" for every switch the
 * browser did not send — silently turning off notifications the customer never
 * touched. One form per row makes each post say exactly one thing about exactly
 * one event, and there is no Save button to forget.
 *
 * ── WHY IT SUBMITS ON CHANGE AND STILL HAS A BUTTON ───────────────────────
 *
 * `onChange` submitting is what makes it feel like a switch. The button is
 * inside a `<noscript>`-safe fallback position: without JavaScript the checkbox
 * is a checkbox and the visible button submits it, which is the difference
 * between a degraded page and a broken one. `POR-10` says these users are on
 * phones on building sites, where the JavaScript sometimes does not arrive.
 */
export function PreferenceToggle({
  event,
  label,
  description,
  isEnabled,
}: {
  event: string;
  label: string;
  description: string;
  isEnabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(setPreference, INITIAL);

  return (
    <form action={formAction} className="flex items-start justify-between gap-4 p-5">
      <input type="hidden" name="event" value={event} />

      <div className="min-w-0">
        <label htmlFor={`pref-${event}`} className="text-[15px] font-medium">
          {label}
        </label>
        <p className="prose-body mt-1 text-[13px]">{description}</p>
        {state.error ? (
          <p
            role="alert"
            className="mt-2 flex items-start gap-1.5 text-[13px]"
            style={{ color: "var(--accent-text)" }}
          >
            <Warning size={13} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
            {state.error}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-end gap-2">
        <input
          id={`pref-${event}`}
          type="checkbox"
          name="isEnabled"
          defaultChecked={isEnabled}
          disabled={pending}
          // 24px, which with the label's own tap area clears the 44px minimum.
          className="h-6 w-6 accent-[var(--accent)]"
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        />
        {/* Kept visible rather than hidden behind a JavaScript check. With
            JavaScript the change has already submitted itself and this is a
            no-op; without it, it is the only way to save. A button that is
            hidden by script is a button that is missing on exactly the page
            loads where it was needed. */}
        <button
          type="submit"
          className="text-[12px] underline"
          style={{ color: "var(--text-muted)" }}
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
