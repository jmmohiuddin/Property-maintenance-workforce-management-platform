"use client";

import { useActionState, useId, useState } from "react";
import { Plus } from "@phosphor-icons/react/dist/ssr";
import { createAsset, attachJob, type AssetState } from "./actions";

const INITIAL: AssetState = {};

const inputClass =
  "w-full rounded-sm border px-3 py-2 text-[14px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

function Message({ state }: { state: AssetState }) {
  const message = state.error ?? state.ok;
  if (!message) return null;
  return (
    <p
      role={state.error ? "alert" : "status"}
      className="mt-4 rounded-sm p-3 text-[13px]"
      style={{
        backgroundColor: "var(--accent-wash)",
        color: state.error ? "var(--accent-text)" : "var(--text-primary)",
      }}
    >
      {message}
    </p>
  );
}

export interface CategoryOption {
  id: string;
  code: string;
  label: string;
  defaultPpmIntervalDays: number | null;
}

export interface UnitOption {
  id: string;
  reference: string;
}

/**
 * Register one piece of plant.
 *
 * The kind is a select and never a text box. It is the column the AMC price and
 * the tender answer are grouped by, and a kind typed by hand gives four
 * spellings of "chiller" and no answer at all.
 */
export function AddAssetForm({
  propertyId,
  categories,
  units,
}: {
  propertyId: string;
  categories: CategoryOption[];
  units: UnitOption[];
}) {
  const [state, formAction, pending] = useActionState(createAsset, INITIAL);
  const [open, setOpen] = useState(false);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const id = useId();

  const chosen = categories.find((c) => c.id === categoryId);

  if (categories.length === 0) {
    return (
      <p className="prose-body mt-4 text-[14px]">
        No asset kinds are configured for this tenant, so nothing can be registered yet.
      </p>
    );
  }

  if (!open) {
    return (
      <>
        <Message state={state} />
        <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary mt-4">
          <Plus size={15} weight="bold" aria-hidden />
          Register an asset
        </button>
      </>
    );
  }

  return (
    <form action={formAction} className="mt-5 space-y-4 border-t pt-5">
      <input type="hidden" name="propertyId" value={propertyId} />
      <Message state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-kind`} className="text-[13px] font-medium">
            Kind
          </label>
          <select
            id={`${id}-kind`}
            name="categoryId"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className={inputClass}
            style={inputStyle}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            {chosen?.defaultPpmIntervalDays
              ? `Serviced every ${chosen.defaultPpmIntervalDays} days unless you say otherwise.`
              : "This kind has no standard service interval."}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-tag`} className="text-[13px] font-medium">
            Asset tag
          </label>
          <input
            id={`${id}-tag`}
            name="tag"
            required
            placeholder="CH-01"
            className={inputClass}
            style={inputStyle}
          />
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            The label on the plant. Unique across every site, so a job card cannot be ambiguous.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
          Description
        </label>
        <input
          id={`${id}-name`}
          name="name"
          required
          placeholder="Chiller 1, main plant room"
          className={inputClass}
          style={inputStyle}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-make`} className="text-[13px] font-medium">
            Make
          </label>
          <input id={`${id}-make`} name="manufacturer" className={inputClass} style={inputStyle} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-model`} className="text-[13px] font-medium">
            Model
          </label>
          <input id={`${id}-model`} name="model" className={inputClass} style={inputStyle} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-serial`} className="text-[13px] font-medium">
            Serial number
          </label>
          <input
            id={`${id}-serial`}
            name="serialNumber"
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-loc`} className="text-[13px] font-medium">
            Location on site
          </label>
          <input
            id={`${id}-loc`}
            name="location"
            placeholder="Roof plant room, north"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        {units.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-unit`} className="text-[13px] font-medium">
              Unit (optional)
            </label>
            <select id={`${id}-unit`} name="unitId" className={inputClass} style={inputStyle}>
              <option value="">Serves the whole property</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.reference}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-installed`} className="text-[13px] font-medium">
            Install date
          </label>
          <input
            id={`${id}-installed`}
            name="installedOn"
            type="date"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-warranty`} className="text-[13px] font-medium">
            Warranty expiry
          </label>
          <input
            id={`${id}-warranty`}
            name="warrantyExpiresOn"
            type="date"
            className={inputClass}
            style={inputStyle}
          />
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            What decides whether a repair is chargeable or the manufacturer&rsquo;s problem.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-cond`} className="text-[13px] font-medium">
            Condition
          </label>
          <select
            id={`${id}-cond`}
            name="condition"
            defaultValue="good"
            className={inputClass}
            style={inputStyle}
          >
            <option value="new">New</option>
            <option value="good">Good</option>
            <option value="fair">Fair</option>
            <option value="poor">Poor</option>
            <option value="end_of_life">End of life</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-ppm`} className="text-[13px] font-medium">
            PPM interval (days)
          </label>
          <input
            id={`${id}-ppm`}
            name="ppmIntervalDays"
            inputMode="numeric"
            placeholder={
              chosen?.defaultPpmIntervalDays ? String(chosen.defaultPpmIntervalDays) : "—"
            }
            className={inputClass}
            style={inputStyle}
          />
          <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
            Leave empty to use the interval for this kind.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Registering…" : "Register asset"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

export interface LinkableJobOption {
  id: string;
  reference: string;
  title: string;
}

/**
 * Attach a job to the plant it was done on.
 *
 * This form exists because nothing else writes `jobs.asset_id`: the job screens
 * do not ask which asset the work was for, so without it every asset&rsquo;s
 * history would be permanently empty.
 */
export function AttachJobForm({
  propertyId,
  assetId,
  jobs,
}: {
  propertyId: string;
  assetId: string;
  jobs: LinkableJobOption[];
}) {
  const [state, formAction, pending] = useActionState(attachJob, INITIAL);
  const id = useId();

  if (jobs.length === 0) {
    return (
      <>
        <Message state={state} />
        <p className="prose-body mt-4 text-[14px]">
          Every job recorded at this property is already attached to an asset, so there is nothing
          left to add here.
        </p>
      </>
    );
  }

  return (
    <form action={formAction} className="mt-5 flex flex-wrap items-end gap-3 border-t pt-5">
      <input type="hidden" name="propertyId" value={propertyId} />
      <input type="hidden" name="assetId" value={assetId} />

      <div className="flex min-w-[280px] flex-1 flex-col gap-1.5">
        <label htmlFor={`${id}-job`} className="text-[13px] font-medium">
          Attach a job done on this asset
        </label>
        <select id={`${id}-job`} name="jobId" className={inputClass} style={inputStyle}>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.reference} — {j.title}
            </option>
          ))}
        </select>
      </div>

      <button type="submit" disabled={pending} className="btn btn-secondary">
        {pending ? "Attaching…" : "Attach"}
      </button>

      <div className="w-full">
        <Message state={state} />
      </div>
    </form>
  );
}
