"use client";

import { useActionState, useState } from "react";
import { decide, type DecisionState } from "./actions";
import { Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: DecisionState = {};

/**
 * Approving is one click. Declining asks for a reason first, because a decline
 * without one is a dead end for whoever picks it up - and because the small
 * amount of friction is appropriate on the destructive-ish option.
 */
export function QuoteDecision({ quoteId }: { quoteId: string }) {
  const [state, formAction, pending] = useActionState(decide, INITIAL);
  const [declining, setDeclining] = useState(false);

  return (
    <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[15px] font-semibold">Your decision</h2>
      <p className="prose-body mt-2 text-[14px]">
        Approving authorises us to schedule and carry out the work at the price above.
      </p>

      {state.error ? (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 text-[13px]"
          style={{ color: "var(--accent-text)" }}
        >
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      {!declining ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <form action={formAction}>
            <input type="hidden" name="quoteId" value={quoteId} />
            <input type="hidden" name="decision" value="approved" />
            <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
              {pending ? "Recording..." : "Approve this quotation"}
            </button>
          </form>
          <button type="button" onClick={() => setDeclining(true)} className="btn btn-secondary">
            Decline
          </button>
        </div>
      ) : (
        <form action={formAction} className="mt-5 space-y-3">
          <input type="hidden" name="quoteId" value={quoteId} />
          <input type="hidden" name="decision" value="rejected" />
          <label htmlFor="decline-reason" className="block text-[14px] font-medium">
            What is the reason? (optional, but it helps us)
          </label>
          <textarea
            id="decline-reason"
            name="reason"
            rows={3}
            className="w-full rounded-sm border px-3 py-2 text-[14px] outline-none focus:border-[var(--accent)]"
            style={{
              backgroundColor: "var(--surface)",
              color: "var(--text-primary)",
              borderColor: "var(--border-strong)",
            }}
          />
          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
              {pending ? "Recording..." : "Decline this quotation"}
            </button>
            <button type="button" onClick={() => setDeclining(false)} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
