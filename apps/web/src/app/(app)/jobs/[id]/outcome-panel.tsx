"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { recordOutcomeAction, type ActionState } from "./actions";
import { Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ActionState = {};

const fieldClass =
  "w-full rounded-sm border px-3 py-2 text-[13px] outline-none focus:border-[var(--accent)]";
const fieldStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export interface OutcomeOption {
  code: string;
  label: string;
  description: string | null;
  requiresReturnVisit: boolean;
}

export interface FaultOption {
  id: string;
  label: string;
}

export interface VisitOption {
  id: string;
  sequence: number;
  technicianName: string;
}

export interface RecordedFault {
  kind: string;
  label: string;
}

/**
 * Outcome and fault capture (`JOB-13`, `JOB-14`).
 *
 * ── WHY THIS PANEL AND NOT A STATUS BUTTON ─────────────────────────────────
 *
 * "Work complete" used to be one of the plain status buttons, which meant a job
 * could reach `work_complete` with `outcome_code` null — and nothing recovers
 * that afterwards, because nobody remembers in March what happened on a Tuesday
 * in January. `G11`, first-time fix rate, is computed from that column: without
 * it the target has no numerator at all. So the move goes through here, the
 * status panel no longer offers it, and the server refuses it there as well.
 *
 * ── WHY THE THREE FAULT PICKERS ARE OPTIONAL AND THE OUTCOME IS NOT ────────
 *
 * Because a visit that could not get through the door diagnosed nothing.
 * Demanding a cause for a `no_access` outcome produces a fabricated one, and a
 * fabricated cause is worse than a gap: the gap is visible in the data and the
 * fabrication is not. The outcome itself is always knowable — something
 * happened, even if what happened is that nobody was home.
 *
 * ── THE EMPTY-PICKER CASE ──────────────────────────────────────────────────
 *
 * Fault codes are per-business and this repository deliberately seeds none;
 * the symptom / cause / remedy lists are empty until an administrator writes
 * them. An empty `<select>` would read as a broken form, so the panel says what
 * is actually true and links to the screen that fixes it.
 */
export function OutcomePanel({
  jobId,
  outcomes,
  symptoms,
  causes,
  remedies,
  visits,
  recordedOutcome,
  recordedFaults,
  isComplete,
}: {
  jobId: string;
  outcomes: OutcomeOption[];
  symptoms: FaultOption[];
  causes: FaultOption[];
  remedies: FaultOption[];
  visits: VisitOption[];
  recordedOutcome: { code: string; label: string } | null;
  recordedFaults: RecordedFault[];
  /** True once the job is past `on_site`: recording is a correction, not a move. */
  isComplete: boolean;
}) {
  const [state, formAction, pending] = useActionState(recordOutcomeAction, INITIAL);
  const [selected, setSelected] = useState(recordedOutcome?.code ?? "");

  const chosen = outcomes.find((o) => o.code === selected) ?? null;
  const noVocabulary = symptoms.length === 0 && causes.length === 0 && remedies.length === 0;

  if (outcomes.length === 0) {
    // The empty-list case this codebase has already shipped once. Saying so is
    // the whole fix: a picker with nothing in it reads as a broken screen, and
    // the operator writes the outcome into the notes field instead — which is
    // exactly what the controlled list exists to prevent.
    return (
      <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="text-[14px] font-semibold">Outcome</h2>
        <p className="prose-body mt-2 text-[13px]">
          No job outcomes are configured, so the work cannot be completed yet. Install the standard
          seven in one click.
        </p>
        <Link
          href="/admin/reference/outcomes"
          className="mt-3 inline-block text-[13px] font-medium"
          style={{ color: "var(--accent-text)" }}
        >
          Open job outcomes →
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[14px] font-semibold">{isComplete ? "Outcome" : "Complete the work"}</h2>

      {recordedOutcome ? (
        <p className="mt-2 flex items-start gap-2 text-[13px]">
          <CheckCircle
            size={14}
            weight="fill"
            aria-hidden
            className="mt-0.5 shrink-0"
            style={{ color: "var(--status-success-text)" }}
          />
          Recorded as <strong>{recordedOutcome.label}</strong>
        </p>
      ) : (
        <p className="prose-body mt-2 text-[13px]">
          What happened on the visit, from the controlled list. This is what the first-time-fix rate
          is counted from, so it is recorded when the work ends rather than reconstructed later.
        </p>
      )}

      {recordedFaults.length > 0 ? (
        <ul className="mt-2 space-y-0.5">
          {recordedFaults.map((f) => (
            <li key={f.kind} className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              {f.kind}: {f.label}
            </li>
          ))}
        </ul>
      ) : null}

      <form action={formAction} className="mt-4 space-y-3">
        <input type="hidden" name="jobId" value={jobId} />

        <div>
          <label htmlFor="outcome-code" className="block text-[13px] font-medium">
            Outcome
          </label>
          <select
            id="outcome-code"
            name="outcomeCode"
            required
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          >
            <option value="">Choose…</option>
            {outcomes.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
          {chosen?.description ? (
            <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
              {chosen.description}
            </p>
          ) : null}
          {/* The requirement's actual point: no access and return-visit-required
              are a large share of real visits and are not failures to be tidied
              away. Saying so before the form is submitted is what makes them
              first-class rather than an afterthought. */}
          {chosen?.requiresReturnVisit ? (
            <p
              className="mt-1.5 flex items-start gap-1.5 text-[12px] font-medium"
              style={{ color: "var(--status-warning-text)" }}
            >
              <Warning size={13} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
              This leaves work owing. The job stays open for a return visit.
            </p>
          ) : null}
        </div>

        {visits.length > 1 ? (
          <div>
            <label htmlFor="outcome-visit" className="block text-[13px] font-medium">
              Which visit
            </label>
            <select id="outcome-visit" name="visitId" className={`${fieldClass} mt-1`} style={fieldStyle}>
              <option value="">Not visit-specific</option>
              {visits.map((v) => (
                <option key={v.id} value={v.id}>
                  Visit {v.sequence} · {v.technicianName}
                </option>
              ))}
            </select>
          </div>
        ) : visits.length === 1 && visits[0] ? (
          <input type="hidden" name="visitId" value={visits[0].id} />
        ) : null}

        {noVocabulary ? (
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            No fault codes are configured for this service, so the symptom, cause and remedy cannot
            be coded yet.{" "}
            <Link href="/admin/reference/fault-codes" style={{ color: "var(--accent-text)" }}>
              Set them up →
            </Link>
          </p>
        ) : (
          <div className="space-y-3">
            <FaultSelect id="symptom" name="symptomCodeId" label="Symptom" options={symptoms} />
            <FaultSelect id="cause" name="causeCodeId" label="Cause" options={causes} />
            <FaultSelect id="remedy" name="remedyCodeId" label="Remedy" options={remedies} />
          </div>
        )}

        <div>
          <label htmlFor="outcome-note" className="block text-[13px] font-medium">
            Note (optional)
          </label>
          <textarea
            id="outcome-note"
            name="note"
            rows={2}
            placeholder="What the codes do not say"
            className={`${fieldClass} mt-1`}
            style={fieldStyle}
          />
        </div>

        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary w-full !py-2 text-[14px] disabled:opacity-60"
        >
          {pending ? "Saving..." : isComplete ? "Update the outcome" : "Record and complete"}
        </button>
      </form>

      {state.error || state.ok ? (
        <p
          role="status"
          className="mt-3 flex items-start gap-2 text-[13px]"
          style={{ color: state.error ? "var(--accent-text)" : "var(--text-secondary)" }}
        >
          {state.error ? (
            <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          ) : (
            <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          )}
          {state.error ?? state.ok}
        </p>
      ) : null}
    </div>
  );
}

function FaultSelect({
  id,
  name,
  label,
  options,
}: {
  id: string;
  name: string;
  label: string;
  options: FaultOption[];
}) {
  if (options.length === 0) return null;
  return (
    <div>
      <label htmlFor={`fault-${id}`} className="block text-[13px] font-medium">
        {label}
      </label>
      <select id={`fault-${id}`} name={name} className={`${fieldClass} mt-1`} style={fieldStyle}>
        <option value="">Not recorded</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
