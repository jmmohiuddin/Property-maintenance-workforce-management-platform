"use client";

import { useActionState, useState } from "react";
import { revokeDevice, type DeviceActionState } from "./actions";
import { TextArea, FormBanner, SubmitButton } from "@/components/form";

const INITIAL: DeviceActionState = {};

/**
 * Revoke one handset, two-step like every other destructive control in the
 * admin screens (reveal, then confirm) — this is the button somebody reaches
 * for while distracted because a technician just rang about a lost phone.
 */
export function RevokeDeviceForm({ deviceId, deviceLabel }: { deviceId: string; deviceLabel: string }) {
  const [state, formAction, pending] = useActionState(revokeDevice, INITIAL);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="text-[13px] font-medium underline underline-offset-2"
        style={{ color: "var(--status-critical-text)" }}
      >
        Revoke
      </button>
    );
  }

  return (
    <form
      action={formAction}
      className="mt-2 max-w-sm space-y-2 rounded-sm border p-3"
      style={{ backgroundColor: "var(--surface-sunken)" }}
    >
      <input type="hidden" name="deviceId" value={deviceId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

      <p className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
        Revoking &ldquo;{deviceLabel}&rdquo; stops it syncing immediately. It does not touch their
        password, sessions, or employment &mdash; only this one handset.
      </p>

      <label className="block">
        <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
          Reason
        </span>
        <TextArea name="reason" rows={2} required placeholder="Lost on site, 21 Aug" />
      </label>

      <div className="flex items-center gap-3">
        <SubmitButton pending={pending} pendingLabel="Revoking…" className="btn btn-primary">
          Confirm revoke
        </SubmitButton>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="text-[13px]"
          style={{ color: "var(--text-muted)" }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
