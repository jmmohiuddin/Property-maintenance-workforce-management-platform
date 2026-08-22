"use client";

import { useActionState, useState } from "react";
import { formatMoney, toMinor, computeTotals, UAE_VAT_BASIS_POINTS } from "@meridian/core";
import { createQuoteAction, sendQuoteAction, reviseQuoteAction, type ActionState } from "./actions";
import { Warning, CheckCircle, Plus, Trash, DownloadSimple, ArrowsClockwise } from "@phosphor-icons/react/dist/ssr";

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
 * Quote builder.
 *
 * Totals are previewed client-side with the same `computeTotals` the server
 * uses, so the number shown while typing is the number that gets stored. Using
 * a different rounding rule in the preview than in the record is how a customer
 * ends up querying a one-fil difference.
 */
export function QuotePanel({ jobId }: { jobId: string }) {
  const [state, formAction, pending] = useActionState(createQuoteAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);

  const totals = computeTotals({
    lines: lines.map((l) => ({ quantity: l.quantity || "0", unitPriceMinor: toMinor(l.unitPrice || "0") })),
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  if (!open) {
    return (
      <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="text-[14px] font-semibold">Quotation</h2>
        <p className="prose-body mt-2 text-[13px]">
          Build a quote for this job. The customer approves it in their portal.
        </p>
        <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary mt-4 !py-2 text-[14px]">
          Build a quote
        </button>
        {state.ok ? (
          <p className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
            {state.ok}
          </p>
        ) : null}
        {state.warning ? (
          <p
            className="mt-2 flex items-start gap-2 text-[13px] font-medium"
            style={{ color: "var(--status-warning-text)" }}
          >
            <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
            {state.warning}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[14px] font-semibold">New quotation</h2>

      {state.error ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--accent-text)" }}>
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.error}
        </p>
      ) : null}
      {state.warning ? (
        <p
          className="mt-3 flex items-start gap-2 text-[13px] font-medium"
          style={{ color: "var(--status-warning-text)" }}
        >
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.warning}
        </p>
      ) : null}
      {state.ok ? (
        <p className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.ok}
        </p>
      ) : null}
      <form action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="jobId" value={jobId} />
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="quote-title" className="text-[13px] font-medium">
            Title
          </label>
          <input id="quote-title" name="title" required className={inputClass} style={inputStyle} />
        </div>

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

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[14px] disabled:opacity-60">
            {pending ? "Saving..." : "Create draft"}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary !py-2 text-[14px]">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/** Sends a draft quote, which is what makes it visible in the customer portal. */
export function SendQuoteButton({ quoteId, reference }: { quoteId: string; reference: string }) {
  const [state, formAction, pending] = useActionState(sendQuoteAction, INITIAL);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="quoteId" value={quoteId} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium disabled:opacity-60"
        style={{ color: "var(--accent-text)" }}
      >
        {pending ? "Sending..." : `Send ${reference} to customer`}
      </button>
      {state.error ? (
        <span className="ml-2 text-[12px]" style={{ color: "var(--accent-text)" }}>
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

/**
 * Download the quotation (`QTE-3`).
 *
 * A plain link rather than an action, because the artefact is a file and the
 * browser already knows how to save one. The route serves it with
 * `Content-Disposition: attachment` (`SEC-8`), so this does not open a tab.
 *
 * The first person to follow it for a given quote causes the document to be
 * rendered and stored; everybody after that gets the same bytes. That is why
 * the link is offered on every quotation rather than only on ones already
 * rendered — there is no state here worth showing, and a link that appears
 * later would just read as something being broken now.
 *
 * If the render is refused — a quote whose totals do not add up — the route
 * answers 409 with the reasons in plain text rather than serving a file. That
 * is deliberately visible: the alternative is a PDF that states a total the
 * customer can disprove with a calculator.
 */
export function QuoteDocumentLink({ quoteId, reference }: { quoteId: string; reference: string }) {
  return (
    <a
      href={`/quotes/${quoteId}/document`}
      className="inline-flex items-center gap-1.5 text-[13px] font-medium"
      style={{ color: "var(--accent-text)" }}
      aria-label={`Download quotation ${reference}`}
    >
      <DownloadSimple size={13} aria-hidden />
      Download PDF
    </a>
  );
}

/**
 * Revise a quote (`QTE-10`): a new version, not an edit in place.
 *
 * Only rendered by the job page when `REVISABLE_QUOTE_STATUSES` (the server's
 * own list, in `@meridian/db`) includes this quote's status — an approved or
 * already-superseded quote is never offered the button at all. The refusal
 * that actually matters still lives in `reviseQuote` itself, on the server;
 * this is only what stops the button being offered for the obvious cases.
 *
 * The new version starts from a blank set of lines rather than the old
 * quote's, on purpose: pre-filling would invite "tweak one price and resubmit"
 * without a second look at the rest, and a revision is supposed to be a
 * considered new document, not a patch that happens to get a new reference.
 */
export function ReviseQuoteButton({
  jobId,
  quoteId,
  reference,
}: {
  jobId: string;
  quoteId: string;
  reference: string;
}) {
  const [state, formAction, pending] = useActionState(reviseQuoteAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY }]);

  const totals = computeTotals({
    lines: lines.map((l) => ({ quantity: l.quantity || "0", unitPriceMinor: toMinor(l.unitPrice || "0") })),
    taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 text-[13px] font-medium"
        style={{ color: "var(--accent-text)" }}
      >
        <ArrowsClockwise size={13} aria-hidden />
        Revise {reference}
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-sm border p-3" style={{ backgroundColor: "var(--surface)" }}>
      <p className="text-[13px] font-medium">
        New version of {reference} — the current one is kept on file, marked superseded.
      </p>

      {state.error ? (
        <p role="alert" className="mt-2 flex items-start gap-2 text-[13px]" style={{ color: "var(--accent-text)" }}>
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <form action={formAction} className="mt-3 space-y-3">
        <input type="hidden" name="jobId" value={jobId} />
        <input type="hidden" name="quoteId" value={quoteId} />
        <input type="hidden" name="lines" value={JSON.stringify(lines)} />

        <input
          aria-label="Title (leave blank to keep the current title)"
          placeholder="Title (leave blank to keep the current title)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          name="title"
          className={inputClass}
          style={inputStyle}
        />

        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="space-y-2 rounded-sm border p-2.5">
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
        </div>

        <input
          aria-label="Reason for this revision"
          placeholder="Why this needed a new version (optional)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          name="reason"
          className={inputClass}
          style={inputStyle}
        />

        <dl className="space-y-1 border-t pt-2 text-[13px]">
          <div className="flex justify-between">
            <dt style={{ color: "var(--text-secondary)" }}>Total (incl. VAT)</dt>
            <dd className="tnum font-semibold">{formatMoney(totals.totalMinor)}</dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[14px] disabled:opacity-60">
            {pending ? "Saving..." : "Create new version"}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary !py-2 text-[14px]">
            Cancel
          </button>
        </div>
      </form>

      {state.ok ? (
        <p className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
          <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.ok}
        </p>
      ) : null}
      {state.warning ? (
        <p
          className="mt-2 flex items-start gap-2 text-[13px] font-medium"
          style={{ color: "var(--status-warning-text)" }}
        >
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {state.warning}
        </p>
      ) : null}
    </div>
  );
}
