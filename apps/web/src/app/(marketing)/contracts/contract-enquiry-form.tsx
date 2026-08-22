"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  tenant,
  services,
  amcServices,
  PROPERTY_TYPES,
  ENQUIRY_PROPERTY_TYPE_LABEL,
} from "@meridian/core";
import { CheckCircle, Warning } from "@phosphor-icons/react/dist/ssr";
import { submitContractEnquiry, type ContractEnquiryState } from "./actions";
import {
  ENQUIRY_KINDS,
  ENQUIRY_KIND_LABEL,
  ENQUIRY_KIND_HINT,
  ORGANISATION_TYPES,
  ORGANISATION_TYPE_LABEL,
  COVERAGE_CHOICES,
  COVERAGE_CHOICE_LABEL,
  PAYMENT_TERM_CHOICES,
  PAYMENT_TERM_LABEL,
  type EnquiryKind,
} from "./enquiry";

/**
 * `WEB-11`, the form half.
 *
 * Follows `components/quote-form.tsx` deliberately — same `useActionState`
 * shape, same field/error rendering, same hidden referrer field, same honeypot,
 * same `noValidate` so the server's messages are the ones a visitor sees. What
 * is different is only what a B2B enquiry actually needs.
 *
 * Co-located in the route folder rather than added to `components/` because it
 * has exactly one caller and shares its schema with the action sitting beside
 * it. Next.js only routes the reserved filenames, so a component here is a
 * component, not a page.
 *
 * ── PROGRESSIVE ENHANCEMENT ─────────────────────────────────────────────────
 *
 * The `kind` state below only ever *hides* fields and disables checkboxes the
 * schema would reject anyway. With JavaScript off, every field is present and
 * enabled and the server's `superRefine` gives the same answer in words. No
 * validation lives here that does not also live on the server.
 */

const amcSlugs = new Set(amcServices.map((s) => s.slug));
const projectServices = services.filter((s) => !amcSlugs.has(s.slug));

const INITIAL: ContractEnquiryState = { status: "idle" };

const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface-raised)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

const inputClass =
  "w-full rounded-sm border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]";

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
          className="flex items-start gap-1.5 text-[13px] font-medium"
          style={{ color: "var(--accent-text)" }}
        >
          <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ErrorNote({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p
      id={id}
      className="flex items-start gap-1.5 text-[13px] font-medium"
      style={{ color: "var(--accent-text)" }}
    >
      <Warning size={14} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
      {message}
    </p>
  );
}

export function ContractEnquiryForm() {
  const [state, formAction, pending] = useActionState(submitContractEnquiry, INITIAL);
  const [kind, setKind] = useState<EnquiryKind>("amc");
  const id = useId();
  const referrerRef = useRef<HTMLInputElement>(null);

  // Same reasoning as the quote form: `document.referrer` is the only place an
  // external referrer exists, same-origin ones are dropped rather than recorded.
  useEffect(() => {
    const input = referrerRef.current;
    if (!input || !document.referrer) return;
    try {
      if (new URL(document.referrer).origin !== window.location.origin) {
        input.value = document.referrer;
      }
    } catch {
      // An unparseable referrer is not worth a thrown error on an enquiry form.
    }
  }, []);

  if (state.status === "success") {
    return (
      <div
        className="rounded border-2 p-8 md:p-10"
        style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
      >
        <CheckCircle size={32} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
        <h2 className="mt-4 text-2xl font-semibold">Enquiry received</h2>
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
    <form action={formAction} className="space-y-7" noValidate>
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

      <fieldset className="flex flex-col gap-3">
        <legend className="text-[14px] font-medium">What kind of enquiry is this?</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {ENQUIRY_KINDS.map((k) => (
            <label
              key={k}
              className={`flex cursor-pointer gap-3 rounded-sm p-4 ${kind === k ? "border-2" : "border"}`}
              style={{
                backgroundColor: "var(--surface-raised)",
                borderColor: kind === k ? "var(--accent)" : "var(--border-strong)",
              }}
            >
              <input
                type="radio"
                name="enquiryKind"
                value={k}
                checked={kind === k}
                onChange={() => setKind(k)}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span>
                <span className="block text-[15px] font-semibold">{ENQUIRY_KIND_LABEL[k]}</span>
                <span className="mt-1 block text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  {ENQUIRY_KIND_HINT[k]}
                </span>
              </span>
            </label>
          ))}
        </div>
        <ErrorNote id={`${id}-kind-error`} message={state.errors?.["enquiryKind"]} />
      </fieldset>

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
          label="Your role (optional)"
          htmlFor={`${id}-role`}
          error={state.errors?.["role"]}
          hint="Managing agent, facilities lead, procurement — whatever fits."
        >
          <input id={`${id}-role`} name="role" className={inputClass} style={inputStyle} />
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Organisation" htmlFor={`${id}-org`} error={state.errors?.["organisation"]}>
          <input
            id={`${id}-org`}
            name="organisation"
            autoComplete="organization"
            required
            className={inputClass}
            style={inputStyle}
            aria-invalid={Boolean(state.errors?.["organisation"])}
          />
        </Field>

        <Field label="Kind of organisation" htmlFor={`${id}-orgtype`} error={state.errors?.["organisationType"]}>
          <select
            id={`${id}-orgtype`}
            name="organisationType"
            defaultValue="property_manager"
            className={inputClass}
            style={inputStyle}
          >
            {ORGANISATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {ORGANISATION_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Phone number" htmlFor={`${id}-phone`} error={state.errors?.["phone"]}>
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

        <Field
          label="Email"
          htmlFor={`${id}-email`}
          error={state.errors?.["email"]}
          hint="Proposals and tender responses are documents. This is where they go."
        >
          <input
            id={`${id}-email`}
            name="email"
            type="email"
            autoComplete="email"
            required
            className={inputClass}
            style={inputStyle}
            aria-invalid={Boolean(state.errors?.["email"])}
          />
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-3">
        <Field
          label="How many properties?"
          htmlFor={`${id}-count`}
          error={state.errors?.["propertyCount"]}
        >
          <input
            id={`${id}-count`}
            name="propertyCount"
            type="number"
            inputMode="numeric"
            min={1}
            max={2000}
            defaultValue={1}
            required
            className={inputClass}
            style={inputStyle}
            aria-invalid={Boolean(state.errors?.["propertyCount"])}
          />
        </Field>

        <Field label="Property type" htmlFor={`${id}-ptype`} error={state.errors?.["propertyType"]}>
          <select
            id={`${id}-ptype`}
            name="propertyType"
            defaultValue="building"
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
      </div>

      <Field
        label="Area or community (optional)"
        htmlFor={`${id}-area`}
        error={state.errors?.["area"]}
        hint="Where the buildings are. One line is enough."
      >
        <input id={`${id}-area`} name="area" className={inputClass} style={inputStyle} />
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-[14px] font-medium">Which trades are in scope?</legend>
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          Only what is on our trade licence appears here. If something you need is missing, it is
          missing because we are not licensed for it.
        </p>

        <p className="mt-2 text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-secondary)" }}>
          Can sit inside a maintenance contract
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {amcServices.map((s) => (
            <label key={s.slug} className="flex items-start gap-3 text-[15px]">
              <input
                type="checkbox"
                name="serviceSlugs"
                value={s.slug}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span>{s.name}</span>
            </label>
          ))}
        </div>

        <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-secondary)" }}>
          Project work — quoted per project, not per year
        </p>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {/*
            Selectable, never `disabled`. A disabled attribute rendered on the
            server for the default "amc" state would still be there for a
            visitor without JavaScript who then chose "Tender or RFP" — locking
            them out of exactly the trades a tender is most likely to contain.
            The rule is enforced in `superRefine`, which names the offending
            trade and what to do about it, and that message is the same with
            JavaScript on or off.
          */}
          {projectServices.map((s) => (
            <label key={s.slug} className="flex items-start gap-3 text-[15px]">
              <input
                type="checkbox"
                name="serviceSlugs"
                value={s.slug}
                className="mt-1 h-4 w-4 shrink-0"
              />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
        {kind === "amc" ? (
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            These cannot sit inside a maintenance contract — a contract schedules recurring visits and
            these are built once. Choose “Tender or RFP” if they are part of a scope you are bidding
            out.
          </p>
        ) : null}
        <ErrorNote id={`${id}-services-error`} message={state.errors?.["serviceSlugs"]} />
      </fieldset>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field
          label="Coverage preference"
          htmlFor={`${id}-coverage`}
          error={state.errors?.["coverage"]}
        >
          <select
            id={`${id}-coverage`}
            name="coverage"
            defaultValue="undecided"
            className={inputClass}
            style={inputStyle}
          >
            {COVERAGE_CHOICES.map((c) => (
              <option key={c} value={c}>
                {COVERAGE_CHOICE_LABEL[c]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Payment terms sought"
          htmlFor={`${id}-terms`}
          error={state.errors?.["paymentTermsDays"]}
        >
          <select
            id={`${id}-terms`}
            name="paymentTermsDays"
            defaultValue=""
            className={inputClass}
            style={inputStyle}
          >
            {PAYMENT_TERM_CHOICES.map((t) => (
              <option key={t || "unspecified"} value={t}>
                {PAYMENT_TERM_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/*
        Always in the DOM, never conditionally mounted.

        The radios above are controlled, but React does not own them until it
        hydrates — a visitor with JavaScript disabled can still select "Tender
        or RFP", and the browser will submit it. If these two fields were
        mounted on `kind === "tender"` they would simply never appear for that
        visitor, and the schema *requires* a deadline for a tender: the form
        would reject a submission whose missing field was never on screen. Two
        fields a contract enquirer skips is a much smaller cost than a form
        that cannot be completed without JavaScript.
      */}
      <fieldset className="flex flex-col gap-4">
        <legend className="text-[14px] font-medium">If this is a tender</legend>
        <p className="-mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
          {kind === "tender"
            ? "The deadline is required. A bid queue is ordered by closing date and nothing else."
            : "Leave both blank for a maintenance contract enquiry."}
        </p>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field
            label="Tender reference (optional)"
            htmlFor={`${id}-tenderref`}
            error={state.errors?.["tenderReference"]}
            hint="The reference your portal or your pack knows it by."
          >
            <input
              id={`${id}-tenderref`}
              name="tenderReference"
              className={inputClass}
              style={inputStyle}
            />
          </Field>

          <Field
            label="Submission deadline"
            htmlFor={`${id}-deadline`}
            error={state.errors?.["submissionDeadline"]}
            hint="Required for a tender. It is what decides where this sits in our queue."
          >
            <input
              id={`${id}-deadline`}
              name="submissionDeadline"
              type="date"
              className={inputClass}
              style={inputStyle}
              aria-invalid={Boolean(state.errors?.["submissionDeadline"])}
            />
          </Field>
        </div>
      </fieldset>

      <Field
        label="Anything else we should know (optional)"
        htmlFor={`${id}-details`}
        error={state.errors?.["details"]}
        hint="Current contractor, known problem assets, when the existing contract ends, whether an asset register exists."
      >
        <textarea id={`${id}-details`} name="details" rows={5} className={inputClass} style={inputStyle} />
      </Field>

      {/* Honeypot. Hidden from people and from screen readers, visible to bots. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor={`${id}-website`}>Website</label>
        <input id={`${id}-website`} name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="flex flex-col gap-2">
        <label className="flex items-start gap-3 text-[14px]">
          <input type="checkbox" name="consent" required className="mt-1 h-4 w-4 shrink-0" />
          <span style={{ color: "var(--text-secondary)" }}>
            I agree to be contacted about this enquiry by phone, WhatsApp or email.
          </span>
        </label>
        <ErrorNote id={`${id}-consent-error`} message={state.errors?.["consent"]} />
      </div>

      <button type="submit" disabled={pending} className="btn btn-primary w-full !py-3.5 disabled:opacity-60">
        {pending ? "Sending enquiry..." : "Send enquiry"}
      </button>

      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
        This is not the emergency path. If something is failing now, call{" "}
        {tenant.emergencyPhone ?? tenant.phone} instead of filling this in.
      </p>
    </form>
  );
}
