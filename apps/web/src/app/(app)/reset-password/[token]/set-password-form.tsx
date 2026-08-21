"use client";

import { useActionState } from "react";
import Link from "next/link";
import { setPassword, type SetPasswordState } from "./actions";
import { Field, TextInput, PasswordField, FormBanner, SubmitButton } from "@/components/form";

const INITIAL: SetPasswordState = {};

export function SetPasswordForm({
  token,
  kind,
  minLength,
  submitLabel,
}: {
  token: string;
  kind: "reset" | "invite";
  minLength: number;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(setPassword, INITIAL);

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? (
        <FormBanner tone="error">
          <p>{state.error}</p>
          <Link
            href="/forgot-password"
            className="mt-2 inline-block font-medium"
            style={{ color: "var(--accent-text)" }}
          >
            Request a new link
          </Link>
        </FormBanner>
      ) : null}

      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="kind" value={kind} />

      <PasswordField minLength={minLength} error={state.fieldError} autoFocus />

      <Field label="Confirm password">
        {({ id }) => (
          <TextInput id={id} name="confirm" type="password" autoComplete="new-password" required />
        )}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Saving…">
        {submitLabel}
      </SubmitButton>

      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        Setting a password signs out every other session on this account.
      </p>
    </form>
  );
}
