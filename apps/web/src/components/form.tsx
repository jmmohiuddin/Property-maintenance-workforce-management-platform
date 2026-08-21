"use client";

import { useId } from "react";
import { Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

/**
 * The shared form kit.
 *
 * `D-2`, and it is overdue rather than speculative. `inputClass` and
 * `inputStyle` were re-declared in roughly six route components; the auth flows
 * added four more forms, and eight new modules are coming. The design
 * document's rule is that the third duplicate is a component.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 *
 * Not a form library. Every form in this application is a server-action form
 * that works without JavaScript, and that is a deliberate architectural choice
 * (`§1`, progressive enhancement) rather than a gap waiting to be filled. These
 * are styled primitives with the accessibility wiring done once — label
 * association, `aria-describedby`, `aria-invalid`, error announcement — because
 * that wiring is what actually gets forgotten when it is retyped per screen.
 */

const controlClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]";

const controlStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

const invalidStyle: React.CSSProperties = {
  ...controlStyle,
  borderColor: "var(--status-critical)",
};

export interface FieldProps {
  label: string;
  /** Guidance shown under the label. Associated via `aria-describedby`. */
  description?: string;
  /** Field-level error. Announced, and associated the same way. */
  error?: string;
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => React.ReactNode;
}

/**
 * Label + control + description + error, wired for assistive technology.
 *
 * The render-prop shape exists so the control keeps its own type and props —
 * a wrapper that rendered `<input {...rest} />` would have to re-export the
 * entire input surface, and would quietly drop whatever it forgot.
 */
export function Field({ label, description, error, children }: FieldProps) {
  const base = useId();
  const id = `${base}-control`;
  const descriptionId = description ? `${base}-description` : undefined;
  const errorId = error ? `${base}-error` : undefined;

  // Both ids when both exist: a screen reader should hear the guidance AND the
  // error, not whichever one was written last.
  const describedBy = [descriptionId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[14px] font-medium">
        {label}
      </label>
      {description ? (
        <p id={descriptionId} className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {description}
        </p>
      ) : null}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}

/**
 * A field-level error, adjacent to its field.
 *
 * `role="alert"` and next to the control, never only in a summary at the top.
 * A message about one input that lives three hundred pixels away from it is a
 * message the person filling in that input does not read.
 */
export function FieldError({ id, children }: { id?: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="flex items-start gap-1.5 text-[13px]"
      style={{ color: "var(--status-critical-text)" }}
    >
      <span aria-hidden>●</span>
      <span>{children}</span>
    </p>
  );
}

type InputProps = Omit<React.ComponentPropsWithoutRef<"input">, "className" | "style"> & {
  invalid?: boolean;
};

export function TextInput({ invalid, ...props }: InputProps) {
  return (
    <input
      {...props}
      aria-invalid={invalid || undefined}
      className={controlClass}
      style={invalid ? invalidStyle : controlStyle}
    />
  );
}

type TextAreaProps = Omit<React.ComponentPropsWithoutRef<"textarea">, "className" | "style"> & {
  invalid?: boolean;
};

export function TextArea({ invalid, rows = 4, ...props }: TextAreaProps) {
  return (
    <textarea
      {...props}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={controlClass}
      style={invalid ? invalidStyle : controlStyle}
    />
  );
}

type SelectProps = Omit<React.ComponentPropsWithoutRef<"select">, "className" | "style"> & {
  invalid?: boolean;
};

export function Select({ invalid, children, ...props }: SelectProps) {
  return (
    <select
      {...props}
      aria-invalid={invalid || undefined}
      className={controlClass}
      style={invalid ? invalidStyle : controlStyle}
    >
      {children}
    </select>
  );
}

/**
 * A form-level banner.
 *
 * `role="alert"` for errors, `role="status"` for success — different politeness
 * levels, because an error interrupts and a confirmation should not.
 *
 * Inline and persistent, never a toast. A message that vanishes after four
 * seconds is not a message, and this application deliberately has no toasts.
 */
export function FormBanner({
  tone,
  children,
}: {
  tone: "error" | "success" | "info";
  children: React.ReactNode;
}) {
  const isError = tone === "error";
  const Icon = isError ? Warning : CheckCircle;

  const background =
    tone === "error"
      ? "var(--status-critical-wash)"
      : tone === "success"
        ? "var(--status-success-wash, var(--accent-wash))"
        : "var(--surface-sunken)";

  const iconColour =
    tone === "error" ? "var(--status-critical-text)" : "var(--accent-text)";

  return (
    <div
      role={isError ? "alert" : "status"}
      className="flex items-start gap-3 rounded-sm p-4 text-[14px]"
      style={{ backgroundColor: background, color: "var(--text-primary)" }}
    >
      <Icon size={17} weight="fill" aria-hidden className="mt-0.5 shrink-0" style={{ color: iconColour }} />
      <div>{children}</div>
    </div>
  );
}

/**
 * The submit button.
 *
 * Disabled while pending with a verb-ing label — "Saving…", not "Please wait".
 * The existing convention across the app, kept and made harder to forget.
 */
export function SubmitButton({
  pending,
  children,
  pendingLabel,
  className = "btn btn-primary w-full !py-3 disabled:opacity-60",
}: {
  pending: boolean;
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? pendingLabel : children}
    </button>
  );
}

/**
 * A password field with the policy stated up front.
 *
 * The rule is shown before the person types rather than after they submit.
 * Announcing a length requirement only on failure is how people end up on their
 * third attempt at a password they had already thought of.
 */
export function PasswordField({
  label = "New password",
  name = "password",
  minLength,
  error,
  autoFocus,
}: {
  label?: string;
  name?: string;
  minLength: number;
  error?: string;
  autoFocus?: boolean;
}) {
  return (
    <Field
      label={label}
      description={`At least ${minLength} characters. Length matters more than symbols — a short password with a "!" on the end is still short.`}
      error={error}
    >
      {({ id, describedBy, invalid }) => (
        <TextInput
          id={id}
          name={name}
          type="password"
          autoComplete="new-password"
          required
          minLength={minLength}
          autoFocus={autoFocus}
          aria-describedby={describedBy}
          invalid={invalid}
        />
      )}
    </Field>
  );
}
