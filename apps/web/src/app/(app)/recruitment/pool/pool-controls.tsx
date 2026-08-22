"use client";

import { useActionState } from "react";
import { FormBanner } from "@/components/form";
import {
  reconfirmPoolMemberAction,
  withdrawPoolConsentAction,
  type ActionState,
} from "../actions";

const INITIAL: ActionState = {};

/**
 * "I called them" — both answers (`ATS-13`).
 *
 * One row, two buttons, and between them the two columns nothing in the product
 * could write. `reconfirmed_at` turns the re-confirmation alert from a list
 * that can only grow into a cycle somebody can finish; `consent_withdrawn_at`
 * is the right that comes with holding these details under consent at all, and
 * it also takes the record off the twelve-month clock and back onto the
 * six-month one.
 *
 * The banner is rendered per row rather than once at the top of the page,
 * because the answer to "did that work?" has to appear next to the thing that
 * was pressed — a success message 40 rows away is one nobody sees.
 */
export function PoolMemberControls({
  candidateId,
  poolKey,
  fullName,
}: {
  candidateId: string;
  poolKey: string;
  fullName: string;
}) {
  const [confirmState, reconfirm, confirming] = useActionState(reconfirmPoolMemberAction, INITIAL);
  const [withdrawState, withdraw, withdrawing] = useActionState(withdrawPoolConsentAction, INITIAL);

  const state = confirmState.error
    ? confirmState
    : withdrawState.error
      ? withdrawState
      : (confirmState.success && confirmState) ||
        (withdrawState.success && withdrawState) ||
        INITIAL;

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap gap-2">
        {/*
          Two forms, not one with a hidden intent field. These are opposite
          decisions about the same person and a mis-click must not be able to
          turn "they said yes, keep me on the list" into "delete me from it".
        */}
        <form action={reconfirm}>
          <input type="hidden" name="candidateId" value={candidateId} />
          <input type="hidden" name="poolKey" value={poolKey} />
          <button type="submit" disabled={confirming} className="btn btn-secondary">
            {confirming ? "Recording…" : "Re-confirmed"}
          </button>
        </form>

        <form action={withdraw}>
          <input type="hidden" name="candidateId" value={candidateId} />
          <input type="hidden" name="poolKey" value={poolKey} />
          <button
            type="submit"
            disabled={withdrawing}
            className="btn btn-secondary"
            style={{ color: "var(--status-critical-text)" }}
          >
            {withdrawing ? "Removing…" : "Withdrew consent"}
          </button>
        </form>
      </div>

      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.success ? (
        <FormBanner tone="success">
          <span className="sr-only">{fullName}: </span>
          {state.success}
        </FormBanner>
      ) : null}
    </div>
  );
}
