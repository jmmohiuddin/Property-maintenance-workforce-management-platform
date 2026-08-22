"use client";

import { useActionState, useId, useState } from "react";
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

/**
 * `CON-13`. The equipment picker, and why it is here and not on triage.
 *
 * This is the one intake path where a registered asset can already exist —
 * lead conversion creates the property alongside the job, so its picker would
 * be empty every time. The person filling this in is usually standing in front
 * of the machine, which makes them the best-placed person in the whole flow to
 * say which one it is.
 *
 * It is optional, and stays optional. "I don't know" is an honest answer to
 * "which chiller", and a required dropdown would collect a guess instead of a
 * blank — a guess that writes a visit into the wrong plant's history, which is
 * worse than no history at all because a tender gets priced off it.
 *
 * Filtered from an already-loaded list rather than fetched per property. The
 * account's whole register came down with the page; see the server component.
 */
export function RequestForm({
  properties,
  assets,
}: {
  properties: { id: string; name: string; area: string | null; city: string }[];
  assets: {
    id: string;
    propertyId: string;
    name: string;
    categoryLabel: string | null;
    location: string | null;
  }[];
}) {
  const [state, formAction, pending] = useActionState(raiseRequest, INITIAL);
  const id = useId();

  const onlyProperty = properties.length === 1 ? properties[0]!.id : "";
  const [propertyId, setPropertyId] = useState(onlyProperty);
  const here = assets.filter((a) => a.propertyId === propertyId);

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
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
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

      {/* CON-13. Only where there is plant on the register to point at. A
          heading followed by "nothing here" on every request from every
          customer without an asset register is how a field gets scrolled
          past by the customers it was written for. `key` on the select
          clears a stale choice when the property above changes — without
          it, React keeps the old value and the request carries an asset
          from the building the customer just navigated away from. */}
      {here.length > 0 ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-asset`} className="text-[14px] font-medium">
            Which equipment is it? (optional)
          </label>
          <select
            key={propertyId}
            id={`${id}-asset`}
            name="assetId"
            defaultValue=""
            className={inputClass}
            style={inputStyle}
          >
            <option value="">I am not sure / something else</option>
            {here.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.categoryLabel ? ` — ${a.categoryLabel}` : ""}
                {a.location ? ` (${a.location})` : ""}
              </option>
            ))}
          </select>
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            Telling us which unit puts this visit on that unit&rsquo;s service record. Leave it if
            you are not sure — we will work it out on site.
          </p>
        </div>
      ) : null}

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
