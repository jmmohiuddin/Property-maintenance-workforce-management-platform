"use client";

import { useActionState, useId, useState, useTransition } from "react";
import { URGENCY, URGENCY_LABEL } from "@meridian/core";
import {
  convertLead,
  loadConvertCandidates,
  type ConvertCandidateView,
  type ConvertState,
} from "./actions";
import { Warning, UsersThree } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ConvertState = {};

const inputClass =
  "w-full rounded-sm border px-3 py-2 text-[14px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

/** The tier that conversion refuses to decide about on its own. */
function needsDecision(c: ConvertCandidateView): boolean {
  return c.isStrict || c.isLinked;
}

function whyMatched(c: ConvertCandidateView): string {
  if (c.isLinked) return "already linked to this enquiry";
  if (c.isStrict) return "same phone and email";
  return "same phone or email";
}

/**
 * Convert a lead into a customer, a property and a job.
 *
 * Collapsed by default. A leads list where every row is an open form is
 * unreadable, and conversion is a considered action rather than a one-click
 * one - it creates three records.
 *
 * ── WHY THE CUSTOMER IS A QUESTION AND NOT A DEFAULT (`LEAD-5`) ────────────
 *
 * This form used to have no customer field at all, so every conversion created
 * a new account — including for a lead the strict matcher had already tied to
 * an existing customer, which is how one person ends up as two accounts with
 * their history split between them.
 *
 * Opening the form asks the matcher, and what comes back decides the shape of
 * the choice rather than the outcome of it:
 *
 *  * A **strict or already-linked** match starts with nothing selected. Not
 *    "attach", because filing work against an account nobody chose is not the
 *    safe direction; not "create", because that is the bug. The operator picks,
 *    and the account they picked is named on the button they press.
 *  * A **loose** match — one of phone or email — is listed and the form still
 *    defaults to creating a new customer. A shared switchboard number is a
 *    suggestion worth reading and a terrible reason to block a conversion.
 *
 * The list is a convenience. `convertLeadToJob` runs the same check inside the
 * transaction, so a form that could not load it is refused there instead.
 */
export function ConvertLeadForm({
  leadId,
  defaultTitle,
  defaultProperty,
}: {
  leadId: string;
  defaultTitle: string;
  defaultProperty: string;
}) {
  const [state, formAction, pending] = useActionState(convertLead, INITIAL);
  const [open, setOpen] = useState(false);
  const id = useId();

  // Controlled, so a rejected submission comes back with what was typed still
  // in it. React resets an uncontrolled form after an action, and re-typing an
  // address because the duplicate check asked a question is how people learn to
  // click past the question.
  const [propertyName, setPropertyName] = useState(defaultProperty);
  const [addressLine, setAddressLine] = useState("");
  const [title, setTitle] = useState(defaultTitle);

  const [candidates, setCandidates] = useState<ConvertCandidateView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  /** A customer id, "new", or "" for "not answered yet". */
  const [choice, setChoice] = useState("");

  function load() {
    setLoadError(null);
    startLoading(async () => {
      const result = await loadConvertCandidates(leadId);
      if (result.error || !result.candidates) {
        setCandidates(null);
        setLoadError(result.error ?? "Could not check for existing customers.");
        return;
      }
      setCandidates(result.candidates);
      // Nothing is preselected when a match has to be decided about. Everything
      // else defaults to a new customer, which is what conversion has always
      // done and what a loose match must not change.
      setChoice(result.candidates.some(needsDecision) ? "" : "new");
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          load();
        }}
        className="btn btn-secondary !py-2 text-[14px]"
      >
        Convert to job
      </button>
    );
  }

  const blocking = (candidates ?? []).filter(needsDecision);
  const undecided = blocking.length > 0 && choice === "";
  const chosen = candidates?.find((c) => c.customerId === choice) ?? null;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="leadId" value={leadId} />
      {chosen ? <input type="hidden" name="customerId" value={chosen.customerId} /> : null}
      {/* Sent only when there was something to acknowledge. An unconditional
          "1" here would be this layer quietly answering the domain's question
          on the operator's behalf, which is the bug with extra steps. */}
      {choice === "new" && blocking.length > 0 ? (
        <input type="hidden" name="createNewCustomer" value="1" />
      ) : null}

      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-sm p-3 text-[13px]"
          style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
        >
          <Warning size={15} weight="fill" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
          {state.error}
        </div>
      ) : null}

      {/* ── LEAD-5. Which customer ─────────────────────────────────────── */}
      {loading ? (
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          Checking whether we already have this person…
        </p>
      ) : null}

      {loadError ? (
        <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
          {loadError} Converting will still refuse if this enquiry turns out to match an existing
          customer.{" "}
          <button type="button" onClick={load} className="underline" style={{ color: "var(--accent-text)" }}>
            Try again
          </button>
        </p>
      ) : null}

      {candidates && candidates.length > 0 ? (
        <fieldset
          className="rounded-sm border p-4"
          style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--surface)" }}
        >
          <legend className="flex items-center gap-1.5 px-1 text-[13px] font-medium">
            <UsersThree size={14} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            {blocking.length > 0 ? "We already have this person" : "This might be an existing customer"}
          </legend>

          <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {blocking.length > 0
              ? "Say which account this job belongs to. Converting creates a property and a job under whichever you choose."
              : "One of phone or email matched. Worth a look — the default is still a new customer."}
          </p>

          <div className="mt-3 space-y-2">
            {candidates.map((c) => (
              <label key={c.customerId} className="flex cursor-pointer items-start gap-2.5 text-[13px]">
                <input
                  type="radio"
                  name="customerChoice"
                  value={c.customerId}
                  checked={choice === c.customerId}
                  onChange={() => setChoice(c.customerId)}
                  className="mt-0.5 h-4 w-4 shrink-0"
                />
                <span>
                  <span className="font-medium">Attach to {c.name}</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {" "}
                    — existing customer, {whyMatched(c)}
                    {c.phone ? ` · ${c.phone}` : ""}
                    {c.email ? ` · ${c.email}` : ""}
                  </span>
                </span>
              </label>
            ))}

            <label className="flex cursor-pointer items-start gap-2.5 text-[13px]">
              <input
                type="radio"
                name="customerChoice"
                value="new"
                checked={choice === "new"}
                onChange={() => setChoice("new")}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <span>
                <span className="font-medium">Create a new customer</span>
                <span style={{ color: "var(--text-muted)" }}>
                  {" "}
                  — a different person or a different account with the same number
                </span>
              </span>
            </label>
          </div>
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-prop`} className="text-[13px] font-medium">
            Property name
          </label>
          <input
            id={`${id}-prop`}
            name="propertyName"
            value={propertyName}
            onChange={(e) => setPropertyName(e.target.value)}
            required
            className={inputClass}
            style={inputStyle}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-addr`} className="text-[13px] font-medium">
            Address
          </label>
          <input
            id={`${id}-addr`}
            name="addressLine"
            value={addressLine}
            onChange={(e) => setAddressLine(e.target.value)}
            required
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-title`} className="text-[13px] font-medium">
          Job title
        </label>
        <input
          id={`${id}-title`}
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          className={inputClass}
          style={inputStyle}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-urg`} className="text-[13px] font-medium">
          Priority
        </label>
        <select id={`${id}-urg`} name="urgency" defaultValue="this-week" className={inputClass} style={inputStyle}>
          {URGENCY.map((u) => (
            <option key={u} value={u}>
              {URGENCY_LABEL[u]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending || undecided}
          className="btn btn-primary !py-2 text-[14px] disabled:opacity-60"
        >
          {pending
            ? "Converting..."
            : chosen
              ? `Create property and job for ${chosen.name}`
              : "Create customer, property and job"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary !py-2 text-[14px]">
          Cancel
        </button>
        {undecided ? (
          <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Choose an account first.
          </span>
        ) : null}
      </div>
    </form>
  );
}
