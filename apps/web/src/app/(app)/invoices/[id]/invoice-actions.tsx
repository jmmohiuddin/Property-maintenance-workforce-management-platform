"use client";

import { useActionState, useState } from "react";
import { formatMoney, toMinor, UAE_VAT_BASIS_POINTS } from "@meridian/core";
import { recordPaymentAction, issueCreditNoteAction, type ActionState } from "./actions";
import { Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

const INITIAL: ActionState = {};

const inputClass =
  "w-full rounded-sm border px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

function Feedback({ state }: { state: ActionState }) {
  if (state.error) {
    return (
      <p
        role="alert"
        className="mt-3 flex items-start gap-2 text-[13px]"
        style={{ color: "var(--status-critical-text)" }}
      >
        <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
        {state.error}
      </p>
    );
  }
  if (state.ok) {
    return (
      <p className="mt-3 flex items-start gap-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
        <CheckCircle size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
        {state.ok}
      </p>
    );
  }
  return null;
}

/** Record a payment received against this invoice. */
export function PaymentPanel({
  invoiceId,
  outstandingMinor,
  currency,
}: {
  invoiceId: string;
  outstandingMinor: number;
  currency: string;
}) {
  const [state, formAction, pending] = useActionState(recordPaymentAction, INITIAL);
  const [open, setOpen] = useState(false);

  if (outstandingMinor <= 0) {
    return (
      <p className="prose-body mt-3 text-[13px]">Nothing outstanding.</p>
    );
  }

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn btn-secondary mt-4 !py-2 text-[14px]"
        >
          Record payment
        </button>
        <Feedback state={state} />
      </>
    );
  }

  return (
    <form action={formAction} className="mt-4 space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div>
        <label htmlFor="payment-amount" className="text-[13px] font-medium">
          Amount received
        </label>
        <input
          id="payment-amount"
          name="amount"
          inputMode="decimal"
          defaultValue={(outstandingMinor / 100).toFixed(2)}
          className={`${inputClass} tnum mt-1`}
          style={inputStyle}
        />
        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Outstanding {formatMoney(outstandingMinor, currency)}.
        </p>
      </div>
      <div>
        <label htmlFor="payment-method" className="text-[13px] font-medium">
          Method
        </label>
        <select
          id="payment-method"
          name="method"
          defaultValue="bank_transfer"
          className={`${inputClass} mt-1`}
          style={inputStyle}
        >
          <option value="bank_transfer">Bank transfer</option>
          <option value="cheque">Cheque</option>
          <option value="cash">Cash</option>
          <option value="card">Card</option>
          <option value="online_gateway">Online gateway</option>
        </select>
      </div>
      <div>
        <label htmlFor="payment-reference" className="text-[13px] font-medium">
          Reference
        </label>
        <input
          id="payment-reference"
          name="reference"
          className={`${inputClass} mt-1`}
          style={inputStyle}
        />
      </div>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[14px] disabled:opacity-60">
          {pending ? "Recording..." : "Record"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary !py-2 text-[14px]">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Issue a tax credit note (`INV-7`).
 *
 * The amount is entered excluding VAT and the VAT is shown as it is typed,
 * because the amount somebody has in their head is the net one they agreed with
 * the customer — and entering a gross figure into a net field is how output tax
 * gets over-credited by five percent.
 */
export function CreditNotePanel({
  invoiceId,
  invoiceReference,
  creditableMinor,
  currency,
}: {
  invoiceId: string;
  invoiceReference: string;
  creditableMinor: number;
  currency: string;
}) {
  const [state, formAction, pending] = useActionState(issueCreditNoteAction, INITIAL);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");

  const netMinor = toMinor(amount || "0");
  const taxMinor = Math.round((netMinor * UAE_VAT_BASIS_POINTS) / 10_000);

  if (!open) {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          disabled={creditableMinor <= 0}
          className="btn btn-secondary mt-2 !py-2 text-[14px] disabled:opacity-50"
        >
          Credit note
        </button>
        <Feedback state={state} />
      </>
    );
  }

  return (
    <form action={formAction} className="mt-4 space-y-3">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
        A credit note against {invoiceReference}, in its own sequential series. Up to{" "}
        {formatMoney(creditableMinor, currency)} remains creditable.
      </p>
      <div>
        <label htmlFor="credit-reason" className="text-[13px] font-medium">
          Why output tax is reduced
        </label>
        <select id="credit-reason" name="reason" defaultValue="" className={`${inputClass} mt-1`} style={inputStyle}>
          <option value="" disabled>
            Choose a reason
          </option>
          <option value="return">Return</option>
          <option value="discount">Post-issue discount</option>
          <option value="cancellation">Cancellation</option>
          <option value="correction">Correction</option>
        </select>
      </div>
      <div>
        <label htmlFor="credit-description" className="text-[13px] font-medium">
          What is being credited
        </label>
        <input id="credit-description" name="description" className={`${inputClass} mt-1`} style={inputStyle} />
      </div>
      <div>
        <label htmlFor="credit-amount" className="text-[13px] font-medium">
          Amount excluding VAT
        </label>
        <input
          id="credit-amount"
          name="amount"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className={`${inputClass} tnum mt-1`}
          style={inputStyle}
        />
        <p className="tnum mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
          VAT 5% {formatMoney(taxMinor, currency)} · credits{" "}
          {formatMoney(netMinor + taxMinor, currency)} in total
        </p>
      </div>
      <div>
        <label htmlFor="credit-detail" className="text-[13px] font-medium">
          Note for the record
        </label>
        <input id="credit-detail" name="reasonDetail" className={`${inputClass} mt-1`} style={inputStyle} />
      </div>
      <Feedback state={state} />
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className="btn btn-primary !py-2 text-[14px] disabled:opacity-60">
          {pending ? "Issuing..." : "Issue credit note"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary !py-2 text-[14px]">
          Cancel
        </button>
      </div>
    </form>
  );
}
