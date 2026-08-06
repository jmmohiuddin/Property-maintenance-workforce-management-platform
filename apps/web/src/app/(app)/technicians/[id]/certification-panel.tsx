"use client";

import { useActionState, useId, useState } from "react";
import { services, getService, CERT_STATE_LABEL, type CertState } from "@meridian/core";
import { saveCertification, deleteCertification, type WorkforceState } from "./actions";
import { Trash, Plus } from "@phosphor-icons/react/dist/ssr";

const INITIAL: WorkforceState = {};

const inputClass =
  "w-full rounded-sm border px-3 py-2 text-[14px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

const dubaiDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

export function CertificationPanel({
  technicianId,
  certifications,
  canWrite,
}: {
  technicianId: string;
  certifications: {
    id: string;
    name: string;
    issuer: string | null;
    reference: string | null;
    issuedOn: Date | null;
    expiresOn: Date | null;
    requiredForServices: string[];
    state: CertState;
  }[];
  canWrite: boolean;
}) {
  const [addState, addAction, adding] = useActionState(saveCertification, INITIAL);
  const [removeState, removeAction] = useActionState(deleteCertification, INITIAL);
  const [open, setOpen] = useState(false);
  const id = useId();

  const message = addState.error ?? removeState.error ?? addState.ok ?? removeState.ok;
  const isError = Boolean(addState.error ?? removeState.error);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Certifications</h2>
      <p className="prose-body mt-2 text-[14px]">
        Marking a certification as required for a service makes it a hard gate: once it lapses,
        dispatch refuses to offer this technician for that service at all. That is a liability
        question, not a preference.
      </p>

      {message ? (
        <p
          role={isError ? "alert" : "status"}
          className="mt-4 rounded-sm p-3 text-[13px]"
          style={{
            backgroundColor: "var(--accent-wash)",
            color: isError ? "var(--accent-text)" : "var(--text-primary)",
          }}
        >
          {message}
        </p>
      ) : null}

      {certifications.length === 0 ? (
        <p className="prose-body mt-5 text-[14px]">Nothing on file.</p>
      ) : (
        <ul className="mt-5 divide-y rounded border">
          {certifications.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <p className="text-[14px] font-medium">{c.name}</p>
                  <span
                    className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={
                      c.state === "expired"
                        ? { backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }
                        : c.state === "expiring"
                          ? { backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }
                          : { backgroundColor: "var(--surface)", color: "var(--text-secondary)" }
                    }
                  >
                    {CERT_STATE_LABEL[c.state]}
                  </span>
                </div>
                <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {c.issuer ?? "Issuer not recorded"}
                  {c.reference ? ` · ${c.reference}` : ""}
                  {c.expiresOn ? ` · expires ${dubaiDate(c.expiresOn)}` : " · no expiry"}
                </p>
                {c.requiredForServices.length > 0 ? (
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    Required for:{" "}
                    {c.requiredForServices
                      .map((slug) => getService(slug)?.shortName ?? slug)
                      .join(", ")}
                  </p>
                ) : null}
              </div>
              {canWrite ? (
                <form action={removeAction}>
                  <input type="hidden" name="certificationId" value={c.id} />
                  <input type="hidden" name="technicianId" value={technicianId} />
                  <button
                    type="submit"
                    className="grid h-8 w-8 place-items-center rounded-sm"
                    style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
                    aria-label={`Remove ${c.name}`}
                    title="Remove this certification"
                  >
                    <Trash size={15} aria-hidden />
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <div className="mt-6 border-t pt-6">
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary">
              <Plus size={15} weight="bold" aria-hidden />
              Record a certification
            </button>
          ) : (
            <form action={addAction} className="space-y-4">
              <input type="hidden" name="technicianId" value={technicianId} />

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
                    Name
                  </label>
                  <input
                    id={`${id}-name`}
                    name="name"
                    required
                    placeholder="DEWA electrical permit"
                    className={inputClass}
                    style={inputStyle}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-issuer`} className="text-[13px] font-medium">
                    Issuer (optional)
                  </label>
                  <input id={`${id}-issuer`} name="issuer" className={inputClass} style={inputStyle} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-ref`} className="text-[13px] font-medium">
                    Reference (optional)
                  </label>
                  <input id={`${id}-ref`} name="reference" className={inputClass} style={inputStyle} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-issued`} className="text-[13px] font-medium">
                      Issued
                    </label>
                    <input
                      id={`${id}-issued`}
                      name="issuedOn"
                      type="date"
                      className={inputClass}
                      style={inputStyle}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-expires`} className="text-[13px] font-medium">
                      Expires
                    </label>
                    <input
                      id={`${id}-expires`}
                      name="expiresOn"
                      type="date"
                      className={inputClass}
                      style={inputStyle}
                    />
                  </div>
                </div>
              </div>

              <fieldset>
                <legend className="text-[13px] font-medium">
                  Mandatory for which services? (optional)
                </legend>
                <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  Leave empty to record it for the file without gating dispatch.
                </p>
                <div className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {services.map((s) => (
                    <label key={s.slug} className="flex items-center gap-2.5 text-[13px]">
                      <input type="checkbox" name="requiredFor" value={s.slug} className="h-4 w-4" />
                      {s.shortName}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="flex flex-wrap gap-3">
                <button type="submit" disabled={adding} className="btn btn-primary disabled:opacity-60">
                  {adding ? "Saving..." : "Record certification"}
                </button>
                <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}
