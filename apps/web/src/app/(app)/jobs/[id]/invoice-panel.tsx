"use client";

import { useActionState, useState } from "react";
import { formatMoney, toMinor, computeTotals, UAE_VAT_BASIS_POINTS } from "@meridian/core";
import { raiseInvoiceAction, type ActionState } from "./actions";
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

/**
 * Invoice builder.
 *
 * Prefilled from the approved quote when there is one, because invoicing
 * something other than what the customer approved is the single most common
 * cause of a disputed invoice — and retyping the lines is how that happens by
 * accident. The lines stay editable: variations are real.
 */
export function InvoicePanel({
  jobId,
  quotedLines,
  quoteReference,
  signedOff,
}: {
  jobId: string;
  quotedLines: Line[];
  quoteReference: string | null;
  signedOff: boolean;
}) {
  const [state, formAction, pending] = useActionState(raiseInvoiceAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>(
    quotedLines.length > 0 ? quotedLines.map((l) => ({ ...l })) : [{ ...EMPTY }],
  );

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
        <h2 className="text-[14px] font-semibold">Invoice</h2>
        <p className="prose-body mt-2 text-[13px]">
          {signedOff
            ? quoteReference
              ? `Raise the invoice. The lines start from ${quoteReference}.`
              : "Raise the invoice for this job."
            : "Available once the customer has signed off the work."}
        </p>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={!signedOff}
          className="btn btn-secondary mt-4 !py-2 text-[14px] disabled:opacity-50"
        >
          Raise invoice
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
      <h2 className="text-[14px] font-semibold">New invoice</h2>

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
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />

        <fieldset className="space-y-3">
          <legend className="text-[13px] font-medium">Lines</legend>
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
                  onChange={(e) =>
                    setLines(lines.map((l, j) => (i === j ? { ...l, quantity: e.target.value } : l)))
                  }
                  className={`${inputClass} tnum`}
                  style={inputStyle}
                />
                <input
                  aria-label={`Line ${i + 1} unit`}
                  placeholder="Unit"
                  value={line.unit}
                  onChange={(e) =>
                    setLines(lines.map((l, j) => (i === j ? { ...l, unit: e.target.value } : l)))
                  }
                  className={inputClass}
                  style={inputStyle}
                />
                <input
                  aria-label={`Line ${i + 1} unit price`}
                  placeholder="Price"
                  value={line.unitPrice}
                  onChange={(e) =>
                    setLines(lines.map((l, j) => (i === j ? { ...l, unitPrice: e.target.value } : l)))
                  }
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
            <dt style={{ color: "var(--text-secondary)" }}>Subtotal</dt>
            <dd className="tnum">{formatMoney(totals.subtotalMinor)}</dd>
          </div>
          <div className="flex justify-between">
            <dt style={{ color: "var(--text-secondary)" }}>VAT 5%</dt>
            <dd className="tnum">{formatMoney(totals.taxMinor)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt>Total</dt>
            <dd className="tnum">{formatMoney(totals.totalMinor)}</dd>
          </div>
        </dl>

        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          The invoice is issued the moment it is created and emailed to the customer. There is no
          draft step — a tax invoice with a number on it is a document, not a workspace.
        </p>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            disabled={pending}
            className="btn btn-primary !py-2 text-[14px] disabled:opacity-60"
          >
            {pending ? "Raising..." : "Raise and send"}
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
