"use client";

import { useActionState, useId } from "react";
import { services, URGENCY, URGENCY_LABEL } from "@meridian/core";
import { raiseRequest, type RequestState } from "./actions";
import { Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: RequestState = {};

const inputClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export function RequestForm({
  properties,
}: {
  properties: { id: string; name: string; area: string | null; city: string }[];
}) {
  const [state, formAction, pending] = useActionState(raiseRequest, INITIAL);
  const id = useId();

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-sm p-4 text-[14px]"
          style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
        >
          <Warning
            size={17}
            weight="fill"
            aria-hidden
            className="mt-0.5 shrink-0"
            style={{ color: "var(--accent-text)" }}
          />
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-property`} className="text-[14px] font-medium">
          Which property?
        </label>
        <select
          id={`${id}-property`}
          name="propertyId"
          required
          defaultValue={properties.length === 1 ? properties[0]!.id : ""}
          className={inputClass}
          style={inputStyle}
        >
          {properties.length !== 1 ? (
            <option value="" disabled>
              Choose a property
            </option>
          ) : null}
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.area ? `, ${p.area}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-service`} className="text-[14px] font-medium">
          What kind of work is it?
        </label>
        <select id={`${id}-service`} name="serviceSlug" required defaultValue="" className={inputClass} style={inputStyle}>
          <option value="" disabled>
            Choose, or pick Handyman if you are not sure
          </option>
          {services.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-title`} className="text-[14px] font-medium">
          What is the problem?
        </label>
        <input
          id={`${id}-title`}
          name="title"
          required
          placeholder="Water staining the ceiling in the third-floor corridor"
          className={inputClass}
          style={inputStyle}
        />
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          Describe the symptom. You do not need to know the cause.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-detail`} className="text-[14px] font-medium">
          Anything else that would help? (optional)
        </label>
        <textarea id={`${id}-detail`} name="description" rows={4} className={inputClass} style={inputStyle} />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-urgency`} className="text-[14px] font-medium">
          How urgent is it?
        </label>
        <select id={`${id}-urgency`} name="urgency" defaultValue="this-week" className={inputClass} style={inputStyle}>
          {URGENCY.filter((u) => u !== "emergency").map((u) => (
            <option key={u} value={u}>
              {URGENCY_LABEL[u]}
            </option>
          ))}
        </select>
        {/* "Emergency" is deliberately absent. A genuine emergency needs the
            phone line, and offering it here would let a form sit unread at 2am
            while someone believes they have reported a flood. */}
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          For anything causing damage right now, call us instead.
        </p>
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary w-full !py-3.5 disabled:opacity-60">
        {pending ? "Raising..." : "Raise this request"}
      </button>
    </form>
  );
}
