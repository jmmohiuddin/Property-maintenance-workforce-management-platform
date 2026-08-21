"use client";

import { useActionState } from "react";
import Link from "next/link";
import { requestReset, type ForgotState } from "./actions";
import { Field, TextInput, FormBanner, SubmitButton } from "@/components/form";

const INITIAL: ForgotState = {};

export function ForgotForm() {
  const [state, formAction, pending] = useActionState(requestReset, INITIAL);

  /*
   * The confirmation is deliberately vague about whether the address exists,
   * and deliberately specific about everything else — what to look for, how
   * long the link lasts, what to do if it does not arrive.
   *
   * Being vague about the one fact while being helpful about the rest is what
   * stops "we can't tell you whether that account exists" reading as evasive.
   */
  if (state.sent) {
    return (
      <FormBanner tone="success">
        <p className="font-medium">Check your email</p>
        <p className="mt-1.5">
          If that address has an account, a reset link is on its way. It works once and expires in
          30 minutes.
        </p>
        <p className="mt-3" style={{ color: "var(--text-secondary)" }}>
          Nothing after a few minutes? Check the spam folder, then ask an administrator — they can
          send a fresh invitation without needing your password.
        </p>
        <Link
          href="/login"
          className="mt-4 inline-block font-medium"
          style={{ color: "var(--accent-text)" }}
        >
          Back to sign in
        </Link>
      </FormBanner>
    );
  }

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}

      <Field
        label="Email"
        description="The address you sign in with. We will send a link that lets you set a new password."
      >
        {({ id, describedBy }) => (
          <TextInput
            id={id}
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            aria-describedby={describedBy}
          />
        )}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Sending…">
        Send a reset link
      </SubmitButton>

      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        <Link href="/login" style={{ color: "var(--accent-text)" }} className="underline underline-offset-2">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
