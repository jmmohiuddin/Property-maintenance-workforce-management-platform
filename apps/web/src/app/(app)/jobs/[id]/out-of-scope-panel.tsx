"use client";

import { useActionState, useState } from "react";
import { formatMoney, toMinor, computeTotals, UAE_VAT_BASIS_POINTS } from "@meridian/core";
import { quoteOutOfScopeAction, type ActionState } from "./actions";
import { Warning, CheckCircle, Plus, Trash } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ActionState = {};

interface Line {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

const EMPTY: Line = { description: "", quantity: "1", unit: "ea", unitPrice: "" };

const inputClass =
  "w-full rounded-sm border px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export interface ContractExclusionOption {
  code: string;
  label: string;
  description: string | null;
}

/**
 * The on-demand half of `CON-6`.
 *
 * ── WHAT THIS PANEL IS FOR, AND WHAT THE BANNER ABOVE IT ALREADY DID ───────
 *
 * The scope check needs two kinds of input and only one of them can be
 * automated. Whether the contract covers this service, and whether the
 * entitlement is spent, are facts already on the job — the banner on this page
 * decides those on every render, without anybody pressing anything, which is
 * what stops the work being silently absorbed.
 *
 * What it cannot decide is which exclusion a fault actually matched, or whether
 * parts were needed. Only the person who did the diagnosis knows that. So those
 * two observations are what this form collects, and the verdict is recomputed
 * on the server from them: nothing here claims a verdict and nothing here sets
 * a price.
 *
 * The exclusion list is THIS contract's, not the standard set. A code the
 * contract does not carry excludes nothing however standard it is elsewhere, so
 * offering the full catalogue would invite somebody to tick a box that cannot
 * change the answer and then wonder why the quote was refused.
 *
 * The totals preview uses the same `computeTotals` the server does, like the
 * quote panel — but it shows the RATE-CARD figure, before the contract
 * discount, because the discount is the contract's and this form has no
 * business restating it. What is stored will be lower.
 */
export function OutOfScopePanel({
  jobId,
  contractId,
  contractReference,
  coverageType,
  exclusions,
  verdict,
}: {
  jobId: string;
  contractId: string;
  contractReference: string;
  coverageType: "comprehensive" | "labour_only";
  exclusions: readonly ContractExclusionOption[];
  verdict: string;
}) {
  const [state, formAction, pending] = useActionState(quoteOutOfScopeAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);

  const totals = computeTotals({
    lines: lines.map((l) => ({
      quantity: l.quantity || "0",
      unitPriceMinor: toMinor(l.unitPrice || "0"),
    })),
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  if (!open) {
    return (
      <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="text-[14px] font-semibold">Out-of-scope work</h2>
        <p className="prose-body mt-2 text-[13px]">
          {verdict === "covered"
            ? `This job is covered by ${contractReference}. If what you found on site is excluded ` +
              "or needs parts the contract does not pay for, record it here and the quote is " +
              "priced at the contract discount."
            : `This job is not covered by ${contractReference}. Raise the quote here so the work ` +
              "is billed rather than absorbed."}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn btn-secondary mt-4 !py-2 text-[14px]"
        >
          Raise a quote
        </button>
        {state.ok ? (
          <p
            className="mt-3 flex items-start gap-2 text-[13px]"
            style={{ color: "var(--text-secondary)" }}
          >
            <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
            {state.ok}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[14px] font-semibold">Out-of-scope quotation</h2>
      <p className="prose-body mt-2 text-[13px]">
        Against {contractReference}. The discount comes from the contract, not from this form.
      </p>

      {state.error ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 text-[13px]"
          style={{ color: "var(--accent-text)" }}
        >
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="jobId" value={jobId} />
        {/* Checked against the job's own contract on the server, not used. */}
        <input type="hidden" name="contractId" value={contractId} />
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="oos-title" className="text-[13px] font-medium">
            Title
          </label>
          <input id="oos-title" name="title" required className={inputClass} style={inputStyle} />
        </div>

        {/* ── What was found on site ──────────────────────────────────── */}
        <fieldset className="space-y-2">
          <legend className="text-[13px] font-medium">What was found on site</legend>
          {exclusions.length === 0 ? (
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              This contract carries no exclusions, so nothing here can be excluded by one. Work is
              still quotable if the service is outside the contract or the entitlement is spent.
            </p>
          ) : (
            <ul className="space-y-2">
              {exclusions.map((e) => (
                <li key={e.code}>
                  <label className="flex items-start gap-2 text-[13px]">
                    <input
                      type="checkbox"
                      name="exclusionCode"
                      value={e.code}
                      className="mt-0.5 shrink-0"
                    />
                    <span>
                      {e.label}
                      {e.description ? (
                        <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {e.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {/*
            Only on a labour-only contract. On a comprehensive one, parts are
            covered — offering the box would ask a question whose answer cannot
            change the verdict, and a control that does nothing teaches people
            to stop reading the form.
          */}
          {coverageType === "labour_only" ? (
            <label className="flex items-start gap-2 text-[13px]">
              <input type="checkbox" name="requiresParts" className="mt-0.5 shrink-0" />
              <span>
                This work needs parts or consumables
                <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                  Labour is covered under this contract; parts are billed separately.
                </span>
              </span>
            </label>
          ) : null}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-medium">Lines, at rate-card price</legend>
          {lines.map((line, i) => (
            <div key={i} className="space-y-2 rounded-sm border p-3">
              <div className="flex items-start gap-2">
                <input
                  aria-label={`Line ${i + 1} description`}
                  placeholder="Description"
                  value={line.description}
                  onChange={(e) =>
                    setLines(lines.map((l, j) => (i === j ? { ...l, description: e.target.value } : l)))
                  }
                  className={inputClass}
                  style={inputStyle}
                />
                {lines.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                    aria-label={`Remove line ${i + 1}`}
                    className="grid h-8 w-8 shrink-0 place-items-center rounded-sm"
                    style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
                  >
                    <Trash size={14} aria-hidden />
                  </button>
                ) : null}
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  aria-label={`Line ${i + 1} quantity`}
                  placeholder="Qty"
                  value={line.quantity}
                  onChange={(e) => setLines(lines.map((l, j) => (i === j ? { ...l, quantity: e.target.value } : l)))}
                  className={`${inputClass} tnum`}
                  style={inputStyle}
                />
                <input
                  aria-label={`Line ${i + 1} unit`}
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) => setLines(lines.map((l, j) => (i === j ? { ...l, unit: e.target.value } : l)))}
                  className={inputClass}
                  style={inputStyle}
                />
                <input
                  aria-label={`Line ${i + 1} unit price`}
                  placeholder="Price"
                  value={line.unitPrice}
                  onChange={(e) => setLines(lines.map((l, j) => (i === j ? { ...l, unitPrice: e.target.value } : l)))}
                  className={`${inputClass} tnum`}
                  style={inputStyle}
                />
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setLines([...lines, { ...EMPTY }])}
            className="inline-flex items-center gap-1.5 text-[13px] font-medium"
            style={{ color: "var(--accent-text)" }}
          >
            <Plus size={13} aria-hidden />
            Add line
          </button>
        </fieldset>

        <dl className="space-y-1 border-t pt-3 text-[13px]">
          <div className="flex justify-between">
            <dt style={{ color: "var(--text-secondary)" }}>Rate card, before discount</dt>
            <dd className="tnum">{formatMoney(totals.subtotalMinor)}</dd>
          </div>
        </dl>
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          The contract discount and VAT on the discounted amount are applied when the quote is
          saved. VAT is charged on what the customer actually pays, so the stored total is lower
          than the figure above.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={pending}
            className="btn btn-primary !py-2 text-[14px] disabled:opacity-60"
          >
            {pending ? "Saving..." : "Create draft"}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="btn btn-secondary !py-2 text-[14px]"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
