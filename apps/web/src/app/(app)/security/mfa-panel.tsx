"use client";

import { useActionState, useId, useState, useTransition } from "react";
import { beginEnrolment, confirmMfa, turnOffMfa, type SecurityState } from "./actions";
import { ShieldCheck, Warning, CheckCircle, Key } from "@phosphor-icons/react/dist/ssr";

const INITIAL: SecurityState = {};

const inputClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

function Banner({ state }: { state: SecurityState }) {
  const message = state.error ?? state.ok;
  if (!message) return null;
  return (
    <p
      role={state.error ? "alert" : "status"}
      className="mt-5 flex items-start gap-3 rounded-sm p-4 text-[14px]"
      style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
    >
      {state.error ? (
        <Warning size={17} weight="fill" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
      ) : (
        <CheckCircle size={17} weight="fill" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
      )}
      {message}
    </p>
  );
}

export function MfaPanel({
  enabled,
  enabledAt,
  recoveryCodesRemaining,
  accountEmail,
}: {
  enabled: boolean;
  enabledAt: Date | null;
  recoveryCodesRemaining: number;
  accountEmail: string;
}) {
  const [confirmState, confirmAction, confirming] = useActionState(confirmMfa, INITIAL);
  const [offState, offAction, turningOff] = useActionState(turnOffMfa, INITIAL);
  const [starting, startTransition] = useTransition();
  const [pending, setPending] = useState<SecurityState["pending"]>(undefined);
  const [showOff, setShowOff] = useState(false);
  const id = useId();

  // The action's own pending value wins once a confirmation has been attempted,
  // so a wrong code keeps the same QR on screen instead of demanding a re-scan.
  const enrolment = confirmState.pending ?? pending;
  const recoveryCodes = confirmState.recoveryCodes;

  // ── Freshly enrolled: show the codes, once ───────────────────────────────
  if (recoveryCodes) {
    return (
      <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ShieldCheck size={19} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
          Two-factor sign-in is on
        </h2>
        <Banner state={confirmState} />

        <div
          className="mt-5 rounded-sm border-2 p-5"
          style={{ borderColor: "var(--accent)", backgroundColor: "var(--surface)" }}
        >
          <h3 className="flex items-center gap-2 text-[15px] font-semibold">
            <Key size={16} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Recovery codes
          </h3>
          <p className="prose-body mt-2 text-[14px]">
            Print these or put them in a password manager. Each one works once, and this is the only
            time they are shown — we store hashes, so we cannot show them again.
          </p>
          <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-2">
            {recoveryCodes.map((code) => (
              <li key={code} className="font-mono text-[15px] tabular-nums tracking-wide">
                {code}
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  // ── Already on ───────────────────────────────────────────────────────────
  if (enabled) {
    return (
      <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <ShieldCheck size={19} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
          Two-factor sign-in is on
        </h2>
        <p className="prose-body mt-2 text-[14px]">
          Since{" "}
          {enabledAt?.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "long" }) ??
            "enrolment"}
          . A stolen password is not enough to reach this account.
        </p>

        <p
          className="mt-4 text-[14px]"
          style={{
            color: recoveryCodesRemaining <= 2 ? "var(--accent-text)" : "var(--text-secondary)",
          }}
        >
          {recoveryCodesRemaining} recovery{" "}
          {recoveryCodesRemaining === 1 ? "code" : "codes"} left
          {recoveryCodesRemaining <= 2
            ? " — turn two-factor off and on again to issue a fresh set before you run out."
            : "."}
        </p>

        <Banner state={offState} />

        <div className="mt-6 border-t pt-6">
          {!showOff ? (
            <button type="button" onClick={() => setShowOff(true)} className="btn btn-secondary">
              Turn off two-factor sign-in
            </button>
          ) : (
            <form action={offAction} className="space-y-4">
              <p className="prose-body text-[14px]">
                Enter a current code — or a recovery code — to confirm this is you. Every other
                session will be signed out.
              </p>
              <div className="flex flex-col gap-2">
                <label htmlFor={`${id}-off`} className="text-[14px] font-medium">
                  Code
                </label>
                <input
                  id={`${id}-off`}
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  required
                  className={inputClass}
                  style={inputStyle}
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={turningOff}
                  className="btn btn-primary disabled:opacity-60"
                >
                  {turningOff ? "Turning off..." : "Confirm and turn off"}
                </button>
                <button type="button" onClick={() => setShowOff(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    );
  }

  // ── Off: offer enrolment ─────────────────────────────────────────────────
  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Two-factor sign-in</h2>
      <p className="prose-body mt-2 text-[14px]">
        A second factor means a leaked or guessed password is not enough on its own. Worth having on
        any account that can dispatch work, approve a quote or raise an invoice.
      </p>

      {!enrolment ? (
        <>
          <Banner state={confirmState} />
          <button
            type="button"
            disabled={starting}
            onClick={() =>
              startTransition(async () => {
                setPending((await beginEnrolment()).pending);
              })
            }
            className="btn btn-primary mt-5 disabled:opacity-60"
          >
            {starting ? "Preparing..." : "Set up two-factor sign-in"}
          </button>
        </>
      ) : (
        <form action={confirmAction} className="mt-6 space-y-5">
          <input type="hidden" name="secret" value={enrolment.secret} />

          <ol className="space-y-5">
            <li>
              <p className="text-[14px] font-medium">1. Scan this with your authenticator app</p>
              <div
                className="mt-3 inline-block rounded-sm p-3"
                style={{ backgroundColor: "#ffffff" }}
                // The SVG is generated server-side from our own encoder and
                // contains no scripts, no external references and nothing from
                // user input beyond the account email. See packages/core/src/qr.ts.
                dangerouslySetInnerHTML={{ __html: enrolment.qr }}
              />
            </li>

            <li>
              <p className="text-[14px] font-medium">
                2. Or type this key in, if the camera will not cooperate
              </p>
              <p className="prose-body mt-1 text-[13px]">
                Account: <span className="font-medium">{accountEmail}</span>
              </p>
              <code
                className="mt-2 block break-all rounded-sm border p-3 font-mono text-[14px] tracking-wider"
                style={{ backgroundColor: "var(--surface)" }}
              >
                {enrolment.secret.replace(/(.{4})/g, "$1 ").trim()}
              </code>
            </li>

            <li>
              <label htmlFor={`${id}-code`} className="text-[14px] font-medium">
                3. Enter the code your app is showing
              </label>
              <input
                id={`${id}-code`}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={7}
                required
                placeholder="000000"
                className={`${inputClass} mt-2 max-w-[200px] text-center tracking-[0.3em] tabular-nums`}
                style={inputStyle}
              />
              <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                Nothing is saved to your account until this code checks out.
              </p>
            </li>
          </ol>

          <Banner state={confirmState} />

          <div className="flex flex-wrap gap-3">
            <button type="submit" disabled={confirming} className="btn btn-primary disabled:opacity-60">
              {confirming ? "Checking..." : "Turn on two-factor sign-in"}
            </button>
            <button type="button" onClick={() => setPending(undefined)} className="btn btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
