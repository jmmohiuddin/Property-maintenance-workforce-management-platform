"use client";

import Link from "next/link";
import { useActionState, useId } from "react";
import { signIn, type LoginState } from "./actions";
import { Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: LoginState = {};

const inputClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

export function LoginForm() {
  const [state, formAction, pending] = useActionState(signIn, INITIAL);
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
        <label htmlFor={`${id}-email`} className="text-[14px] font-medium">
          Email
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          className={inputClass}
          style={inputStyle}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-password`} className="text-[14px] font-medium">
          Password
        </label>
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
          style={inputStyle}
        />
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary w-full !py-3 disabled:opacity-60">
        {pending ? "Signing in..." : "Sign in"}
      </button>

      {/*
        Under the button, not above it. Somebody who knows their password should
        not have to read past a recovery link to sign in — and somebody who does
        not know it has already failed once and is looking for exactly this.
      */}
      <p className="text-center text-[13px]">
        <Link
          href="/forgot-password"
          style={{ color: "var(--accent-text)" }}
          className="underline underline-offset-2"
        >
          Forgotten your password?
        </Link>
      </p>
    </form>
  );
}
