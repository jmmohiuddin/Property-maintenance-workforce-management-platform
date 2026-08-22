"use client";

import Link from "next/link";
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

/**
 * The compliance block, rendered per the design document's `ComplianceBlock`
 * specification.
 *
 * The details matter and are worth stating, because it is easy to get subtly
 * wrong in a way that undoes the point:
 *
 *  - **No control at all.** Not a disabled button, not a greyed radio. A
 *    disabled control reads as "try again later"; the absence of one reads as
 *    "this is not possible", which is the true statement.
 *  - **The penalty as a number.** "AED 100,000–1,000,000" changes behaviour;
 *    "a compliance risk" does not.
 *  - **A route to fixing it.** A wall with no door gets climbed.
 *  - **`role="note"`, not `role="alert"`.** This is a persistent condition, not
 *    an event that just occurred, and announcing it as an alert every render
 *    would be wrong for a screen-reader user.
 */
function ComplianceBlock({
  block,
}: {
  block: { technicianId: string; technicianName: string; detail: string; penalty: string | null };
}) {
  return (
    <li
      role="note"
      aria-label={`${block.technicianName} cannot be dispatched`}
      className="rounded-sm border p-3"
      style={{
        // --status-blocked, not --status-critical. D-7: "impossible" must not
        // look like "urgent", and the contrast gate now checks the two hues are
        // at least 60 degrees apart so it stays that way.
        borderColor: "var(--status-blocked)",
        backgroundColor: "var(--status-blocked-wash)",
      }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-medium">{block.technicianName}</span>
        <span
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: "var(--status-blocked-text)" }}
        >
          Blocked
        </span>
      </div>
      <p className="mt-1 text-[12px] font-medium">⛔ {block.detail}</p>
      {block.penalty ? (
        <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
          {block.penalty}
        </p>
      ) : null}
      <Link
        href={`/technicians/${block.technicianId}`}
        className="mt-2 inline-block text-[12px] font-medium"
        style={{ color: "var(--accent-text)" }}
      >
        Open record →
      </Link>
    </li>
  );
}

export interface CandidateWarning {
  type: string;
  label: string;
  detail: string;
  requiresOverride: boolean;
}

export interface CandidateOption {
  technicianId: string;
  fullName: string;
  grade: string;
  score: number;
  reason: string;
  warnings: CandidateWarning[];
}

const fieldClass =
  "w-full rounded-sm border px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]";
const fieldStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

/** The advisory line under a clean candidate: shown, never a gate. */
function AdvisoryNote({ warnings }: { warnings: CandidateWarning[] }) {
  const advisory = warnings.filter((w) => !w.requiresOverride);
  if (advisory.length === 0) return null;
  return (
    <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
      {advisory.map((w) => w.detail).join(". ")}.
    </p>
  );
}

/**
 * `JOB-10`. Assigning past a warning, with the reason it took.
 *
 * ── WHY THIS IS A FORM AND NOT A CONFIRM DIALOG ────────────────────────────
 *
 * The audit found overrides were silent, and a silent override is
 * indistinguishable from a mistake. A confirm dialog would have fixed the
 * silence and none of the rest: "are you sure?" produces a click, not a record,
 * and a click cannot be read back in March by somebody asking why an engineer
 * with a lapsed certificate was sent to a gas job.
 *
 * So the cost of overriding is a sentence. The server refuses without one —
 * this is not a client-side rule, and the check that matters runs inside the
 * transaction that writes the visit, because a panel drawn thirty seconds ago
 * does not know what expired at midnight.
 */
function OverrideCandidate({
  jobId,
  candidate,
  formAction,
  pending,
  scheduledStart,
  scheduledEnd,
}: {
  jobId: string;
  candidate: CandidateOption;
  formAction: (payload: FormData) => void;
  pending: boolean;
  scheduledStart: string;
  scheduledEnd: string;
}) {
  const [open, setOpen] = useState(false);
  const gating = candidate.warnings.filter((w) => w.requiresOverride);
  const leading = gating[0];

  return (
    <li
      className="rounded-sm border p-3"
      style={{ borderColor: "var(--status-warning)", backgroundColor: "var(--status-warning-wash)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-medium">{candidate.fullName}</span>
        <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
          {candidate.score.toFixed(0)}
        </span>
      </div>
      <p className="mt-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
        {candidate.reason}
      </p>

      <ul className="mt-2 space-y-1">
        {gating.map((w) => (
          <li key={w.type} className="flex items-start gap-1.5 text-[12px] font-medium">
            <Warning
              size={13}
              weight="fill"
              aria-hidden
              className="mt-0.5 shrink-0"
              style={{ color: "var(--status-warning-text)" }}
            />
            <span>
              {w.label}: {w.detail}
            </span>
          </li>
        ))}
      </ul>
      <AdvisoryNote warnings={candidate.warnings} />

      {open ? (
        <form action={formAction} className="mt-3 space-y-2">
          <input type="hidden" name="jobId" value={jobId} />
          <input type="hidden" name="technicianId" value={candidate.technicianId} />
          <input type="hidden" name="score" value={candidate.score} />
          <input type="hidden" name="reason" value={candidate.reason} />
          <input type="hidden" name="scheduledStart" value={scheduledStart} />
          <input type="hidden" name="scheduledEnd" value={scheduledEnd} />
          {/* What the dispatcher was looking at. The server checks it is still
              the current warning and refuses if it is not, rather than filing
              the reason against a fact that has since changed. */}
          <input type="hidden" name="overrideWarningType" value={leading?.type ?? ""} />
          <label
            htmlFor={`override-${candidate.technicianId}`}
            className="block text-[12px] font-medium"
          >
            Why is this the right call?
          </label>
          <textarea
            id={`override-${candidate.technicianId}`}
            name="overrideReason"
            rows={2}
            required
            minLength={10}
            placeholder="Renewal booked for Thursday; nobody else is within 40 km"
            className={fieldClass}
            style={fieldStyle}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={pending}
              className="btn btn-secondary flex-1 !py-1.5 text-[13px] disabled:opacity-60"
            >
              {pending ? "Assigning..." : "Assign and record the reason"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-sm border px-2.5 py-1.5 text-[13px]"
              style={{ color: "var(--text-secondary)" }}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-2 text-[12px] font-medium"
          style={{ color: "var(--accent-text)" }}
        >
          Assign anyway, with a reason →
        </button>
      )}
    </li>
  );
}

export function AssignPanel({
  jobId,
  serviceName,
  candidates,
  warned,
  disqualified,
  blocked,
  defaultStart,
  defaultEnd,
}: {
  jobId: string;
  serviceName: string;
  candidates: CandidateOption[];
  warned: CandidateOption[];
  disqualified: { technicianId: string; fullName: string; reason: string }[];
  blocked: { technicianId: string; technicianName: string; detail: string; penalty: string | null }[];
  /** `YYYY-MM-DDTHH:mm` in Dubai wall-clock, from the working calendar. */
  defaultStart: string;
  defaultEnd: string;
}) {
  const [state, formAction, pending] = useActionState(assign, INITIAL);
  // JOB-8. The window is what availability is checked against, so it is a field
  // rather than an assumption: "now, for two hours" was the old implicit answer
  // and it is wrong for every job booked for tomorrow morning.
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(defaultEnd);

  const nobody = candidates.length === 0 && warned.length === 0;

  // An empty panel and a missing panel look identical to a dispatcher, and both
  // read as "broken". Say which it is: nobody holds the skill, or everyone who
  // does was excluded and here is why.
  if (nobody) {
    return (
      <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="text-[14px] font-semibold">No technician available</h2>
        <p className="prose-body mt-2 text-[13px]">
          {disqualified.length === 0 && blocked.length === 0
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

        {/* If everyone with the skill is compliance-blocked, that IS the answer
            to "why is nobody available", and burying it would send the
            dispatcher looking for a scheduling problem that does not exist. */}
        {blocked.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {blocked.map((b) => (
              <ComplianceBlock key={b.technicianId} block={b} />
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

      {/* JOB-8. Availability is a question about a window, so the window is
          asked for. Times are Dubai local — the server reads them as such,
          because a server in UTC would otherwise move an outdoor 16:00 visit
          into the summer midday ban. */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div>
          <label htmlFor="assign-start" className="block text-[12px] font-medium">
            From
          </label>
          <input
            id="assign-start"
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
        <div>
          <label htmlFor="assign-end" className="block text-[12px] font-medium">
            To
          </label>
          <input
            id="assign-end"
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>
      </div>
      <p className="mt-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
        Change the window and reload to re-check availability against it.
      </p>

      <ul className="mt-4 space-y-2">
        {candidates.map((c, i) => (
          <li key={c.technicianId}>
            <form action={formAction}>
              <input type="hidden" name="jobId" value={jobId} />
              <input type="hidden" name="technicianId" value={c.technicianId} />
              <input type="hidden" name="score" value={c.score} />
              <input type="hidden" name="reason" value={c.reason} />
              <input type="hidden" name="scheduledStart" value={start} />
              <input type="hidden" name="scheduledEnd" value={end} />
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
                <AdvisoryNote warnings={c.warnings} />
              </button>
            </form>
          </li>
        ))}
      </ul>

      {/* HR-9. Above the warnings on purpose: consequence order applies inside a
          panel as much as it does to a list. A lapsed permit is a six-figure
          exposure; a certificate that lapses next month is a decision. */}
      {blocked.length > 0 ? (
        <div className="mt-5 border-t pt-4">
          <h3 className="text-[13px] font-semibold">Cannot be assigned &mdash; {blocked.length}</h3>
          <ul className="mt-2 space-y-2">
            {blocked.map((b) => (
              <ComplianceBlock key={b.technicianId} block={b} />
            ))}
          </ul>
        </div>
      ) : null}

      {/* JOB-9 and JOB-10. Separated from the one-click list rather than badged
          inside it, because they are different actions: one is a button, the
          other is a form with a reason in it. */}
      {warned.length > 0 ? (
        <div className="mt-5 border-t pt-4">
          <h3 className="text-[13px] font-semibold">
            Needs a recorded reason &mdash; {warned.length}
          </h3>
          <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
            Overriding is often the right call. It is recorded either way.
          </p>
          <ul className="mt-2 space-y-2">
            {warned.map((c) => (
              <OverrideCandidate
                key={c.technicianId}
                jobId={jobId}
                candidate={c}
                formAction={formAction}
                pending={pending}
                scheduledStart={start}
                scheduledEnd={end}
              />
            ))}
          </ul>
        </div>
      ) : null}

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
