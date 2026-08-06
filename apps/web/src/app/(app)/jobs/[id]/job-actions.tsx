"use client";

import { useActionState, useState } from "react";
import { STATUS_LABEL, type JobStatus } from "@meridian/core";
import { changeStatus, assign, type ActionState } from "./actions";
import { Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ActionState = {};

function Feedback({ state }: { state: ActionState }) {
  if (!state.error && !state.ok) return null;
  const isError = Boolean(state.error);
  return (
    <p
      role="status"
      className="mt-3 flex items-start gap-2 text-[13px]"
      style={{ color: isError ? "var(--accent-text)" : "var(--text-secondary)" }}
    >
      {isError ? (
        <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
      ) : (
        <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
      )}
      {state.error ?? state.ok}
    </p>
  );
}

/**
 * Only legal transitions are rendered, from the domain layer's graph. The
 * server re-validates, so a hand-crafted POST for an illegal move is still
 * rejected.
 */
export function StatusActions({ jobId, allowed }: { jobId: string; allowed: JobStatus[] }) {
  const [state, formAction, pending] = useActionState(changeStatus, INITIAL);
  const [selected, setSelected] = useState<JobStatus | null>(null);

  if (allowed.length === 0) {
    return (
      <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="text-[14px] font-semibold">Status</h2>
        <p className="prose-body mt-2 text-[13px]">
          This job is in a terminal state. No further changes are possible.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[14px] font-semibold">Move to</h2>

      <div className="mt-3 flex flex-wrap gap-2">
        {allowed.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSelected(s === selected ? null : s)}
            aria-pressed={selected === s}
            className="rounded-sm border px-2.5 py-1.5 text-[13px] font-medium transition-colors"
            style={
              selected === s
                ? { backgroundColor: "var(--accent)", color: "var(--accent-contrast)", borderColor: "var(--accent)" }
                : { color: "var(--text-secondary)" }
            }
          >
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {selected ? (
        <form action={formAction} className="mt-4 space-y-3">
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="to" value={selected} />
          <label htmlFor="status-note" className="block text-[13px] font-medium">
            Note (optional)
          </label>
          <textarea
            id="status-note"
            name="note"
            rows={2}
            placeholder="Why, if it is not obvious"
            className="w-full rounded-sm border px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]"
            style={{
              backgroundColor: "var(--surface)",
              color: "var(--text-primary)",
              borderColor: "var(--border-strong)",
            }}
          />
          <button type="submit" disabled={pending} className="btn btn-primary w-full !py-2 text-[14px] disabled:opacity-60">
            {pending ? "Saving..." : `Move to ${STATUS_LABEL[selected]}`}
          </button>
        </form>
      ) : null}

      <Feedback state={state} />
    </div>
  );
}

export function AssignPanel({
  jobId,
  serviceName,
  candidates,
  disqualified,
}: {
  jobId: string;
  serviceName: string;
  candidates: { technicianId: string; fullName: string; grade: string; score: number; reason: string }[];
  disqualified: { technicianId: string; fullName: string; reason: string }[];
}) {
  const [state, formAction, pending] = useActionState(assign, INITIAL);

  // An empty panel and a missing panel look identical to a dispatcher, and both
  // read as "broken". Say which it is: nobody holds the skill, or everyone who
  // does was excluded and here is why.
  if (candidates.length === 0) {
    return (
      <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="text-[14px] font-semibold">No technician available</h2>
        <p className="prose-body mt-2 text-[13px]">
          {disqualified.length === 0
            ? `Nobody currently holds a ${serviceName} skill. Add the skill to a technician's profile, or subcontract this one.`
            : `Everyone with a ${serviceName} skill was excluded:`}
        </p>
        {disqualified.length > 0 ? (
          <ul className="mt-3 space-y-1.5">
            {disqualified.map((d) => (
              <li key={d.technicianId} className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                <span style={{ color: "var(--text-secondary)" }}>{d.fullName}</span> &middot; {d.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[14px] font-semibold">Suggested technicians</h2>
      <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
        Ranked by distance, current load and skill fit. Lower score is better.
      </p>

      <ul className="mt-4 space-y-2">
        {candidates.map((c, i) => (
          <li key={c.technicianId}>
            <form action={formAction}>
              <input type="hidden" name="jobId" value={jobId} />
              <input type="hidden" name="technicianId" value={c.technicianId} />
              <input type="hidden" name="score" value={c.score} />
              <input type="hidden" name="reason" value={c.reason} />
              <button
                type="submit"
                disabled={pending}
                className="w-full rounded-sm border p-3 text-left transition-colors hover:border-[var(--accent)] disabled:opacity-60"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[14px] font-medium">
                    {i === 0 ? "★ " : ""}
                    {c.fullName}
                  </span>
                  <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {c.score.toFixed(0)}
                  </span>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
                  {c.reason}
                </p>
              </button>
            </form>
          </li>
        ))}
      </ul>

      {/* Shown rather than silently dropped: a dispatcher who cannot see that
          their best technician was excluded will assume the tool is broken. */}
      {disqualified.length > 0 ? (
        <div className="mt-5 border-t pt-4">
          <h3 className="text-[13px] font-semibold">Excluded</h3>
          <ul className="mt-2 space-y-1.5">
            {disqualified.map((d) => (
              <li key={d.technicianId} className="text-[12px]" style={{ color: "var(--text-muted)" }}>
                <span style={{ color: "var(--text-secondary)" }}>{d.fullName}</span> &middot; {d.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <Feedback state={state} />
    </div>
  );
}
