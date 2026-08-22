"use client";

import { useActionState, useEffect, useId, useRef } from "react";
import {
  tenant,
  services,
  URGENCY,
  URGENCY_LABEL,
  PROPERTY_TYPES,
  ENQUIRY_PROPERTY_TYPE_LABEL,
} from "@meridian/core";
import { submitQuoteRequest, type QuoteFormState } from "@/app/(marketing)/quote/actions";
import { CheckCircle, Warning } from "@phosphor-icons/react/dist/ssr";

const INITIAL: QuoteFormState = { status: "idle" };

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {/* Label above input, never placeholder-as-label. */}
      <label htmlFor={htmlFor} className="text-[14px] font-medium">
        {label}
      </label>
      {children}
      {hint && !error ? (
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={`${htmlFor}-error`}
          className="flex items-center gap-1.5 text-[13px] font-medium"
          style={{ color: "var(--accent-text)" }}
        >
          <Warning size={14} weight="fill" aria-hidden />
          {error}
        </p>
      ) : null}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

const inputClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]";

export function QuoteForm({ defaultService }: { defaultService?: string }) {
  const [state, formAction, pending] = useActionState(submitQuoteRequest, INITIAL);
  const id = useId();
  const referrerRef = useRef<HTMLInputElement>(null);

  /**
   * Where the visitor came from (`LEAD-4`).
   *
   * `document.referrer` is the only place this exists — the browser does not
   * send a Referer naming another site on the POST, so without this field the
   * question "which search or which directory produced this enquiry" has no
   * answer at all, which is precisely the gap `LEAD-4` was written about.
   *
   * Same-origin referrers are dropped rather than recorded: a visitor moving
   * from a service page to this one did not come from that page, and filling
   * the column with internal navigation would make every row look attributed
   * and none of them be. The page the form was sent from is already known from
   * the request itself.
   *
   * In an effect, and therefore skipped entirely without JavaScript. The rest
   * of the form still works, and the enquiry is still recorded with whatever
   * the request headers carry.
   */
  useEffect(() => {
    const input = referrerRef.current;
    if (!input || !document.referrer) return;
    try {
      if (new URL(document.referrer).origin !== window.location.origin) {
        input.value = document.referrer;
      }
    } catch {
      // An unparseable referrer is not worth a thrown error on a quote form.
    }
  }, []);

  if (state.status === "success") {
    return (
      <div
        className="rounded border-2 p-8 md:p-10"
        style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
      >
        <CheckCircle size={32} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
        <h2 className="mt-4 text-2xl font-semibold">Request received</h2>
        <p className="prose-body mt-3">{state.message}</p>
        {state.reference ? (
          <p className="tnum mt-5 text-[14px]">
            <span style={{ color: "var(--text-muted)" }}>Your reference: </span>
            <span className="font-semibold">{state.reference}</span>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {/* Attribution, not input. Never shown, never focusable, and empty when
          the browser has nothing to say. See the effect above. */}
      <input ref={referrerRef} type="hidden" name="referrer" defaultValue="" />
      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-sm p-4 text-[14px]"
          style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
        >
          <Warning size={17} weight="fill" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
          {state.message}
        </div>
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Your name" htmlFor={`${id}-name`} error={state.errors?.["name"]}>
          <input
            id={`${id}-name`}
            name="name"
            autoComplete="name"
            required
            className={inputClass}
            style={inputStyle}
            aria-invalid={Boolean(state.errors?.["name"])}
          />
        </Field>

        <Field
          label="Phone number"
          htmlFor={`${id}-phone`}
          error={state.errors?.["phone"]}
          hint="We call or WhatsApp this number."
        >
          <input
            id={`${id}-phone`}
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            className={inputClass}
            style={inputStyle}
            aria-invalid={Boolean(state.errors?.["phone"])}
          />
        </Field>
      </div>

      <Field label="Email (optional)" htmlFor={`${id}-email`} error={state.errors?.["email"]}>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          autoComplete="email"
          className={inputClass}
          style={inputStyle}
        />
      </Field>

      <Field label="What do you need?" htmlFor={`${id}-service`} error={state.errors?.["serviceSlug"]}>
        <select
          id={`${id}-service`}
          name="serviceSlug"
          defaultValue={defaultService ?? ""}
          required
          className={inputClass}
          style={inputStyle}
        >
          <option value="" disabled>
            Choose a service
          </option>
          {services.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="How urgent is it?" htmlFor={`${id}-urgency`} error={state.errors?.["urgency"]}>
          <select id={`${id}-urgency`} name="urgency" defaultValue="this-week" className={inputClass} style={inputStyle}>
            {URGENCY.map((u) => (
              <option key={u} value={u}>
                {URGENCY_LABEL[u]}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Property type" htmlFor={`${id}-property`} error={state.errors?.["propertyType"]}>
          <select
            id={`${id}-property`}
            name="propertyType"
            defaultValue="apartment"
            className={inputClass}
            style={inputStyle}
          >
            {PROPERTY_TYPES.map((p) => (
              <option key={p} value={p}>
                {ENQUIRY_PROPERTY_TYPE_LABEL[p]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="City" htmlFor={`${id}-city`} error={state.errors?.["city"]}>
          <select
            id={`${id}-city`}
            name="city"
            defaultValue={tenant.address.city}
            required
            className={inputClass}
            style={inputStyle}
          >
            {tenant.serviceAreas.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Area or community (optional)" htmlFor={`${id}-area`} error={state.errors?.["area"]}>
          <input id={`${id}-area`} name="area" className={inputClass} style={inputStyle} />
        </Field>
      </div>

      <Field
        label="Describe the problem (optional)"
        htmlFor={`${id}-details`}
        error={state.errors?.["details"]}
        hint="Symptoms are enough. You do not need to know the cause."
      >
        <textarea id={`${id}-details`} name="details" rows={5} className={inputClass} style={inputStyle} />
      </Field>

      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor={`${id}-company`}>Company</label>
        <input id={`${id}-company`} name="company" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0" />
          <span style={{ color: "var(--text-secondary)" }}>
            I agree to be contacted about this request by phone, WhatsApp or email.
          </span>
        </label>
        {state.errors?.["consent"] ? (
          <p className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: "var(--accent-text)" }}>
            <Warning size={14} weight="fill" aria-hidden />
            {state.errors["consent"]}
          </p>
        ) : null}
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary w-full !py-3.5 disabled:opacity-60">
        {pending ? "Sending request..." : "Send request"}
      </button>

      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        Quotations are issued within 24 hours of survey. Emergencies are dispatched immediately, call{" "}
        {tenant.emergencyPhone}.
      </p>
    </form>
  );
}
