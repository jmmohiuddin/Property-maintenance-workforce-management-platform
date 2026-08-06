"use client";

import { useActionState, useId, useState } from "react";
import { URGENCY, URGENCY_LABEL } from "@meridian/core";
import { convertLead, type ConvertState } from "./actions";
import { Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ConvertState = {};

const inputClass =
  "w-full rounded-sm border px-3 py-2 text-[14px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

/**
 * Collapsed by default. A leads list where every row is an open form is
 * unreadable, and conversion is a considered action rather than a one-click
 * one - it creates three records.
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

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary !py-2 text-[14px]">
        Convert to job
      </button>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="leadId" value={leadId} />

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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-prop`} className="text-[13px] font-medium">
            Property name
          </label>
          <input
            id={`${id}-prop`}
            name="propertyName"
            defaultValue={defaultProperty}
            required
            className={inputClass}
            style={inputStyle}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-addr`} className="text-[13px] font-medium">
            Address
          </label>
          <input id={`${id}-addr`} name="addressLine" required className={inputClass} style={inputStyle} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-title`} className="text-[13px] font-medium">
          Job title
        </label>
        <input
          id={`${id}-title`}
          name="title"
          defaultValue={defaultTitle}
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

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[14px] disabled:opacity-60">
          {pending ? "Converting..." : "Create customer, property and job"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary !py-2 text-[14px]">
          Cancel
        </button>
      </div>
    </form>
  );
}
