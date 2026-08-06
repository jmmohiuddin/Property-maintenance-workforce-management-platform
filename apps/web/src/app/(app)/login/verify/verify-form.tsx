"use client";

import { useActionState, useId } from "react";
import { verifyMfa, type VerifyState } from "../actions";
import { Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: VerifyState = {};

const inputClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-center text-[22px] tracking-[0.35em] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
  fontVariantNumeric: "tabular-nums",
};

export function VerifyForm() {
  const [state, formAction, pending] = useActionState(verifyMfa, INITIAL);
  const id = useId();

  return (
    <form action={formAction} className="space-y-5">
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
        <label htmlFor={`${id}-code`} className="text-[14px] font-medium">
          Six-digit code
        </label>
        <input
          id={`${id}-code`}
          name="code"
          // Not `type="number"`: a code with a leading zero is a real code, and
          // number inputs on mobile hand you a spinner nobody wants.
          inputMode="numeric"
          autoComplete="one-time-code"
          // No maxLength — a recovery code goes in this same box, and truncating
          // it at six characters would silently make it wrong.
          required
          autoFocus
          placeholder="000000"
          className={inputClass}
          style={inputStyle}
        />
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary w-full !py-3 disabled:opacity-60">
        {pending ? "Checking..." : "Verify and sign in"}
      </button>
    </form>
  );
}
