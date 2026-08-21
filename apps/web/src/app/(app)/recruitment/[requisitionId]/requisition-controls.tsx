"use client";

import { useActionState } from "react";
import Link from "next/link";
import { FormBanner } from "@/components/form";
import {
  approveRequisitionAction,
  publishRequisitionAction,
  closeRequisitionAction,
  type ActionState,
} from "../actions";

const INITIAL: ActionState = {};

/**
 * Approve · publish · close (`ATS-1`, `ATS-2`).
 *
 * Three separate forms rather than one with a hidden intent field, so a
 * mis-click cannot close a vacancy while somebody meant to publish it.
 *
 * The close button carries the live-applicant count in its own label. The
 * domain refuses the close while anybody is still `active` and explains why —
 * closing a role with eleven people in Screening is how eleven people never
 * hear anything — but a refusal the person only meets after clicking is a worse
 * design than a button that says what it is going to do.
 */
export function RequisitionControls({
  requisitionId,
  status,
  approved,
  publicSlug,
  liveApplicants,
}: {
  requisitionId: string;
  status: string;
  approved: boolean;
  publicSlug: string;
  liveApplicants: number;
}) {
  const [approveState, approve, approving] = useActionState(approveRequisitionAction, INITIAL);
  const [publishState, publish, publishing] = useActionState(publishRequisitionAction, INITIAL);
  const [closeState, close, closing] = useActionState(closeRequisitionAction, INITIAL);

  const state = closeState.error
    ? closeState
    : publishState.error
      ? publishState
      : approveState.error
        ? approveState
        : (closeState.success && closeState) ||
          (publishState.success && publishState) ||
          (approveState.success && approveState) ||
          INITIAL;

  const isOpen = status === "open";
  const isClosed = status === "filled" || status === "cancelled";

  return (
    <div className="w-full max-w-md space-y-3">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

      <div className="flex flex-wrap gap-2">
        {isOpen ? (
          <Link href={`/careers/${publicSlug}`} className="btn btn-secondary" prefetch={false}>
            View posting
          </Link>
        ) : null}

        {!approved && !isClosed ? (
          <form action={approve}>
            <input type="hidden" name="requisitionId" value={requisitionId} />
            <button type="submit" disabled={approving} className="btn btn-secondary">
              {approving ? "Approving…" : "Approve"}
            </button>
          </form>
        ) : null}

        {approved && !isOpen && !isClosed ? (
          <form action={publish}>
            <input type="hidden" name="requisitionId" value={requisitionId} />
            <button type="submit" disabled={publishing} className="btn btn-primary">
              {publishing ? "Publishing…" : "Publish to careers site"}
            </button>
          </form>
        ) : null}

        {!isClosed ? (
          <form action={close}>
            <input type="hidden" name="requisitionId" value={requisitionId} />
            <input type="hidden" name="closeStatus" value="filled" />
            <button type="submit" disabled={closing} className="btn btn-secondary">
              {closing
                ? "Closing…"
                : liveApplicants > 0
                  ? `Close (${liveApplicants} still live)`
                  : "Close role"}
            </button>
          </form>
        ) : null}
      </div>

      {!approved && !isClosed ? (
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          A vacancy reaches the careers site only after somebody has approved the headcount. The
          database refuses an open role with no approval on it, so this is a gate rather than a
          badge.
        </p>
      ) : null}
    </div>
  );
}
