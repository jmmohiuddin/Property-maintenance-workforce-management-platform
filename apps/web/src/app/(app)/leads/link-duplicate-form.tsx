"use client";

import { useActionState, useState } from "react";
import { linkDuplicate, type LogState } from "./actions";
import type { StageReason } from "./stage-form";

const INITIAL: LogState = {};

/**
 * The merge-or-link action (`LEAD-5`).
 *
 * Two buttons, because they are two decisions and only one of them closes the
 * lead:
 *
 *  * **Link** records the connection and leaves the lead open. Right when this
 *    is a real second enquiry from an existing customer — a new job at the same
 *    building — and the connection is context rather than a reason to stop.
 *  * **Link and close** is for a genuine double submission. It needs a reason
 *    from the controlled list, because `LEAD-6` requires one for every closure
 *    and "duplicate" is one of the more useful things a funnel report can say.
 *
 * ── THE SELECT GUARD ───────────────────────────────────────────────────────
 *
 * The reason list is filtered to the reasons this closure can use, and the
 * first option is an explicit empty prompt rather than the first real reason. A
 * `<select>` whose value is not among its options renders the first one
 * silently, and the shape of that bug here would be a lead closed with whatever
 * reason happens to sort first — invisible until somebody reads a funnel report
 * and wonders why "competitor" tripled.
 */
export function LinkDuplicateForm({
  leadId,
  matchKind,
  matchId,
  matchName,
  reasons,
}: {
  leadId: string;
  matchKind: "lead" | "customer";
  matchId: string;
  matchName: string;
  reasons: readonly StageReason[];
}) {
  const [state, formAction, pending] = useActionState(linkDuplicate, INITIAL);
  const [closing, setClosing] = useState(false);

  return (
    <form action={formAction} className="mt-3">
      <input type="hidden" name="leadId" value={leadId} />
      {matchKind === "lead" ? (
        <input type="hidden" name="duplicateOfLeadId" value={matchId} />
      ) : (
        <input type="hidden" name="matchedCustomerId" value={matchId} />
      )}

      {!closing ? (
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className="btn btn-secondary !py-1.5 text-[13px] disabled:opacity-60">
            {pending ? "Linking…" : `Link to ${matchName}`}
          </button>
          {reasons.length > 0 ? (
            <button
              type="button"
              onClick={() => setClosing(true)}
              className="btn btn-secondary !py-1.5 text-[13px]"
            >
              Link and close as duplicate
            </button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-2">
          <label htmlFor={`reason-${matchId}`} className="block text-[13px] font-medium">
            Why is this being closed?
          </label>
          <select
            id={`reason-${matchId}`}
            name="dispositionReasonId"
            required
            defaultValue=""
            className="w-full rounded-sm border px-3 py-2 text-[14px]"
          >
            {/* The empty prompt is first and is selected. Without it the
                control would silently pre-select a real reason nobody chose. */}
            <option value="">Choose a reason…</option>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={pending} className="btn btn-primary !py-1.5 text-[13px] disabled:opacity-60">
              {pending ? "Saving…" : "Link and close"}
            </button>
            <button type="button" onClick={() => setClosing(false)} className="btn btn-secondary !py-1.5 text-[13px]">
              Cancel
            </button>
          </div>
        </div>
      )}

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
