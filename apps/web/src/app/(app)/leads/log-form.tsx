"use client";

import { useActionState } from "react";
import { logLeadCommunication, type LogState } from "./actions";
import {
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CHANNEL_LABEL,
  COMMUNICATION_OUTCOMES,
  COMMUNICATION_OUTCOME_LABEL,
} from "@meridian/core";
import { Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

const INITIAL: LogState = {};

/**
 * Log a touch (`LEAD-9`).
 *
 * ── THE DESIGN CONSTRAINT IS THE INTERACTION COST ──────────────────────────
 *
 * "One click plus one sentence." The `communications` table has been in the
 * schema since the first migration and has never held a row, and the reason is
 * not that nobody wanted the history — it is that every version of this form
 * anybody imagines has six fields, and six fields is slower than not bothering.
 *
 * So: the sentence is the only required input and it has focus. Channel and
 * outcome are single-select rows of buttons rather than dropdowns, because a
 * `<select>` costs a tap to open, a scroll and a tap to close. The date is not
 * asked for at all — it is now, which is when somebody logs a call — and the
 * follow-up is derived from the outcome in the domain.
 */
export function LogCommunicationForm({
  leadId,
  customerId,
}: {
  leadId?: string;
  customerId?: string;
}) {
  const [state, formAction, pending] = useActionState(logLeadCommunication, INITIAL);

  return (
    <form action={formAction} className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      {leadId ? <input type="hidden" name="leadId" value={leadId} /> : null}
      {customerId ? <input type="hidden" name="customerId" value={customerId} /> : null}

      <label htmlFor="log-body" className="block text-[14px] font-medium">
        What happened?
      </label>
      <textarea
        id="log-body"
        name="body"
        rows={2}
        required
        placeholder="Called Ahmed — wants a site visit before committing."
        className="mt-2 w-full rounded-sm border px-3 py-2 text-[14px] outline-none focus:border-[var(--accent)]"
      />

      <fieldset className="mt-4">
        <legend className="text-[13px] font-medium">How</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {COMMUNICATION_CHANNELS.map((channel, i) => (
            <label key={channel} className="cursor-pointer">
              <input
                type="radio"
                name="channel"
                value={channel}
                defaultChecked={i === 0}
                className="peer sr-only"
              />
              <span
                className="inline-block rounded-sm border px-2.5 py-1.5 text-[13px] peer-checked:border-[var(--accent)] peer-checked:font-semibold"
                style={{ color: "var(--text-secondary)" }}
              >
                {COMMUNICATION_CHANNEL_LABEL[channel]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4">
        <legend className="text-[13px] font-medium">And?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {/*
            An explicit "not recorded" option, checked by default. A required
            outcome would be an outcome guessed, and a guessed code is worse
            than a null one: null is visibly missing in the report, whereas a
            wrong code is counted.
          */}
          <label className="cursor-pointer">
            <input type="radio" name="outcome" value="" defaultChecked className="peer sr-only" />
            <span
              className="inline-block rounded-sm border px-2.5 py-1.5 text-[13px] peer-checked:border-[var(--accent)] peer-checked:font-semibold"
              style={{ color: "var(--text-secondary)" }}
            >
              Not recorded
            </span>
          </label>
          {COMMUNICATION_OUTCOMES.map((outcome) => (
            <label key={outcome} className="cursor-pointer">
              <input type="radio" name="outcome" value={outcome} className="peer sr-only" />
              <span
                className="inline-block rounded-sm border px-2.5 py-1.5 text-[13px] peer-checked:border-[var(--accent)] peer-checked:font-semibold"
                style={{ color: "var(--text-secondary)" }}
              >
                {COMMUNICATION_OUTCOME_LABEL[outcome]}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[14px] disabled:opacity-60">
          {pending ? "Logging…" : "Log it"}
        </button>
        <label className="flex items-center gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <input type="checkbox" name="direction" value="inbound" className="h-4 w-4" />
          They contacted us
        </label>
      </div>

      {state.error ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--accent-text)" }}>
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p role="status" className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--accent-text)" }}>
          <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {/* Only a lead carries a follow-up date, and only an outcome moves
              it. Saying otherwise on the customer screen would be this form
              claiming a side effect the domain does not have there. */}
          {state.success}
          {leadId ? " If you recorded an outcome, the follow-up date has moved with it." : ""}
        </p>
      ) : null}
    </form>
  );
}
