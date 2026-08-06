"use client";

import { useActionState, useId } from "react";
import { services, getService } from "@meridian/core";
import { saveSkill, deleteSkill, type WorkforceState } from "./actions";
import { Trash, Plus } from "@phosphor-icons/react/dist/ssr";

const INITIAL: WorkforceState = {};

const PROFICIENCY: Readonly<Record<number, string>> = {
  1: "1 — trainee, supervised only",
  2: "2 — assisting",
  3: "3 — works unsupervised",
  4: "4 — handles complex faults",
  5: "5 — expert, can sign off others",
};

const inputClass =
  "w-full rounded-sm border px-3 py-2 text-[14px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export function SkillPanel({
  technicianId,
  skills,
  canWrite,
}: {
  technicianId: string;
  skills: {
    id: string;
    serviceSlug: string;
    proficiency: number;
    verifiedAt: Date | null;
    verifiedByName: string | null;
  }[];
  canWrite: boolean;
}) {
  const [addState, addAction, adding] = useActionState(saveSkill, INITIAL);
  const [removeState, removeAction] = useActionState(deleteSkill, INITIAL);
  const id = useId();

  const message = addState.error ?? removeState.error ?? addState.ok ?? removeState.ok;
  const isError = Boolean(addState.error ?? removeState.error);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Skills</h2>
      <p className="prose-body mt-2 text-[14px]">
        Dispatch matches on any signed-off skill, not the primary trade alone. Proficiency breaks
        ties — the lowest grade that qualifies is offered first, so the expert stays free.
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

      {skills.length === 0 ? (
        <p className="mt-5 text-[14px]" style={{ color: "var(--accent-text)" }}>
          Nothing signed off. This technician cannot be offered for any job.
        </p>
      ) : (
        <ul className="mt-5 divide-y rounded border">
          {skills.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="text-[14px] font-medium">
                  {getService(s.serviceSlug)?.name ?? s.serviceSlug}
                </p>
                <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {PROFICIENCY[s.proficiency] ?? `Level ${s.proficiency}`}
                  {s.verifiedByName ? ` · signed off by ${s.verifiedByName}` : ""}
                </p>
              </div>
              {canWrite ? (
                <form action={removeAction}>
                  <input type="hidden" name="skillId" value={s.id} />
                  <input type="hidden" name="technicianId" value={technicianId} />
                  <button
                    type="submit"
                    className="grid h-8 w-8 place-items-center rounded-sm"
                    style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
                    aria-label={`Withdraw ${getService(s.serviceSlug)?.shortName ?? s.serviceSlug}`}
                    title="Withdraw this skill"
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
        <form action={addAction} className="mt-6 border-t pt-6">
          <input type="hidden" name="technicianId" value={technicianId} />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-service`} className="text-[13px] font-medium">
                Service
              </label>
              <select
                id={`${id}-service`}
                name="serviceSlug"
                required
                defaultValue=""
                className={inputClass}
                style={inputStyle}
              >
                <option value="" disabled>
                  Choose a service
                </option>
                {services.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-prof`} className="text-[13px] font-medium">
                Proficiency
              </label>
              <select
                id={`${id}-prof`}
                name="proficiency"
                defaultValue="3"
                className={inputClass}
                style={inputStyle}
              >
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {PROFICIENCY[n]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" disabled={adding} className="btn btn-secondary mt-4 disabled:opacity-60">
            <Plus size={15} weight="bold" aria-hidden />
            {adding ? "Saving..." : "Sign off skill"}
          </button>
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Signing off an existing skill re-grades it and records you as the verifier.
          </p>
        </form>
      ) : null}
    </section>
  );
}
