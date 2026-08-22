"use client";

import { useActionState, useState } from "react";
import { invite, unlock, setActive, changeRole, resetMfa, cancelInvitation, type AdminState } from "./actions";
import { ASSIGNABLE_ROLE_OPTIONS } from "./roles";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";

const INITIAL: AdminState = {};

/**
 * Client controls for `/admin/users`.
 *
 * Every destructive action here is two-step, following the existing convention
 * from the two-factor screen: reveal, then confirm. That convention exists
 * because these are the buttons somebody clicks while distracted, and the
 * consequences — signing a colleague out, removing a second factor — are not
 * things a confirmation dialog they have learned to dismiss will catch.
 */

function Feedback({ state }: { state: AdminState }) {
  if (state.error) return <FormBanner tone="error">{state.error}</FormBanner>;
  if (state.success) return <FormBanner tone="success">{state.success}</FormBanner>;
  return null;
}

export function InvitePanel() {
  const [state, formAction, pending] = useActionState(invite, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <Feedback state={state} />

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name">
          {({ id }) => <TextInput id={id} name="fullName" required autoComplete="off" />}
        </Field>
        <Field label="Email">
          {({ id }) => <TextInput id={id} name="email" type="email" required autoComplete="off" />}
        </Field>
        <Field label="Role">
          {({ id }) => (
            <Select id={id} name="role" defaultValue="dispatcher" required>
              {ASSIGNABLE_ROLE_OPTIONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className="flex items-center gap-4">
        <SubmitButton pending={pending} pendingLabel="Sending…" className="btn btn-primary disabled:opacity-60">
          Send invitation
        </SubmitButton>
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          They choose their own password. The link lasts seven days and works once.
        </p>
      </div>
    </form>
  );
}

export function UnlockButton({ userId }: { userId: string }) {
  const [state, formAction, pending] = useActionState(unlock, INITIAL);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="userId" value={userId} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: "var(--accent-text)" }}
      >
        {pending ? "Unlocking…" : "Unlock"}
      </button>
      {state.error ? <span className="ml-2 text-[12px]">{state.error}</span> : null}
    </form>
  );
}

export function ActiveToggle({
  userId,
  isActive,
  fullName,
}: {
  userId: string;
  isActive: boolean;
  fullName: string;
}) {
  const [state, formAction, pending] = useActionState(setActive, INITIAL);
  const [confirming, setConfirming] = useState(false);

  // Reactivating is harmless and goes in one click. Deactivating signs somebody
  // out of every session immediately, so it asks first.
  if (isActive && !confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[13px] font-medium underline underline-offset-2"
        style={{ color: "var(--status-critical-text)" }}
      >
        Deactivate
      </button>
    );
  }

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="isActive" value={String(!isActive)} />
      {isActive ? (
        <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
          Sign {fullName.split(" ")[0]} out and block access?
        </span>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: isActive ? "var(--status-critical-text)" : "var(--accent-text)" }}
      >
        {pending ? "Saving…" : isActive ? "Yes, deactivate" : "Reactivate"}
      </button>
      {isActive ? (
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[13px]"
          style={{ color: "var(--text-muted)" }}
        >
          Cancel
        </button>
      ) : null}
      {state.error ? <span className="ml-2 text-[12px]">{state.error}</span> : null}
    </form>
  );
}

export function RoleSelect({ userId, role }: { userId: string; role: string }) {
  const [state, formAction, pending] = useActionState(changeRole, INITIAL);

  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="userId" value={userId} />
      <select
        name="role"
        defaultValue={role}
        className="rounded-sm border px-2 py-1 text-[13px]"
        style={{
          backgroundColor: "var(--surface-raised)",
          color: "var(--text-primary)",
          borderColor: "var(--border-strong)",
        }}
        aria-label="Role"
      >
        {ASSIGNABLE_ROLE_OPTIONS.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: "var(--accent-text)" }}
      >
        {pending ? "Saving…" : "Change"}
      </button>
      {state.error ? <span className="text-[12px]">{state.error}</span> : null}
    </form>
  );
}

/**
 * MFA reset (`SEC-6`).
 *
 * Two-step, and the second step is a text box rather than a confirmation
 * button. That is the entire design: the software cannot verify that the
 * administrator really did phone the person back on a known number, so it makes
 * them write down what they did, names them, and keeps it in an append-only
 * log.
 *
 * "I've lost my phone" is the standard opening line of a social-engineering
 * call. Being made to type *how* you verified is the moment somebody notices
 * that they have not.
 */
export function ResetMfaButton({ userId, fullName }: { userId: string; fullName: string }) {
  const [state, formAction, pending] = useActionState(resetMfa, INITIAL);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[13px] font-medium underline underline-offset-2"
        style={{ color: "var(--text-secondary)" }}
      >
        Reset two-factor
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-3 space-y-3 rounded-sm border p-4" style={{ backgroundColor: "var(--surface-sunken)" }}>
      <input type="hidden" name="userId" value={userId} />

      <FormBanner tone="error">
        This removes {fullName.split(" ")[0]}&apos;s second factor and signs them out everywhere.
        Verify their identity on a channel other than email before you continue — a text message to
        a number you already had, or a video call. An account is what is on the other side of this.
      </FormBanner>

      <Field
        label="How did you verify them?"
        description="Recorded permanently in the audit log against your name. Name the channel and what you checked."
        error={state.error}
      >
        {({ id, describedBy, invalid }) => (
          <TextArea
            id={id}
            name="attestation"
            rows={2}
            required
            placeholder="Video call, confirmed Emirates ID, 12 Aug 15:04"
            aria-describedby={describedBy}
            invalid={invalid}
          />
        )}
      </Field>

      <div className="flex items-center gap-3">
        <SubmitButton pending={pending} pendingLabel="Resetting…" className="btn btn-primary disabled:opacity-60">
          Reset two-factor
        </SubmitButton>
        <button type="button" onClick={() => setOpen(false)} className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function CancelInvitationButton({ invitationId }: { invitationId: string }) {
  const [state, formAction, pending] = useActionState(cancelInvitation, INITIAL);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="invitationId" value={invitationId} />
      <button
        type="submit"
        disabled={pending}
        className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
        style={{ color: "var(--status-critical-text)" }}
      >
        {pending ? "Cancelling…" : "Cancel"}
      </button>
      {state.error ? <span className="ml-2 text-[12px]">{state.error}</span> : null}
    </form>
  );
}
