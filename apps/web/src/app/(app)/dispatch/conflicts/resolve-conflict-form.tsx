"use client";

import { useActionState, useState } from "react";
import { resolveConflict, type ConflictActionState } from "./actions";
import { TextArea, FormBanner, SubmitButton } from "@/components/form";

const INITIAL: ConflictActionState = {};

const OPTIONS: ReadonlyArray<{
  value: "accepted" | "rejected" | "superseded";
  label: string;
  hint: string;
}> = [
  {
    value: "accepted",
    label: "Accept the device",
    hint: "The technician's version stands — the cancellation was wrong, or came too late.",
  },
  {
    value: "rejected",
    label: "Reject the device",
    hint: "The server's version stands — the offline completion should not count.",
  },
  {
    value: "superseded",
    label: "Superseded",
    hint: "Neither side is authoritative any more — overtaken by something since.",
  },
];

/**
 * One conflict's verdict, recorded and nothing else.
 *
 * This form does not touch the job. `resolveConflict` calls
 * `resolveFieldConflict`, which deliberately only writes the decision — see
 * that function's doc comment. If the work still needs finishing, that is a
 * separate trip to the job page, through `transitionJob` / `recordJobOutcome`
 * and the checks that belong to them.
 */
export function ResolveConflictForm({ conflictId }: { conflictId: string }) {
  const [state, formAction, pending] = useActionState(resolveConflict, INITIAL);
  const [resolution, setResolution] = useState<"accepted" | "rejected" | "superseded" | "">("");

  return (
    <form
      action={formAction}
      className="mt-4 space-y-3 rounded-sm border p-4"
      style={{ backgroundColor: "var(--surface-raised)" }}
    >
      <input type="hidden" name="conflictId" value={conflictId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

      <div className="grid gap-2 sm:grid-cols-3">
        {OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className="flex cursor-pointer flex-col gap-1 rounded-sm border p-3 text-[13px]"
            style={{ borderColor: resolution === opt.value ? "var(--accent)" : "var(--border-strong)" }}
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="resolution"
                value={opt.value}
                required
                onChange={() => setResolution(opt.value)}
              />
              {opt.label}
            </span>
            <span style={{ color: "var(--text-muted)" }}>{opt.hint}</span>
          </label>
        ))}
      </div>

      <label className="block">
        <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
          Note (optional)
        </span>
        <TextArea name="note" rows={2} placeholder="Why, for whoever reads this later." />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-primary">
          Record decision
        </SubmitButton>
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          Records your verdict only — it does not reopen the job or change its outcome.
        </p>
      </div>
    </form>
  );
}
