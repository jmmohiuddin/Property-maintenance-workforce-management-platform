"use client";

import { useActionState, useState } from "react";
import {
  AVAILABILITY_LABEL,
  AVAILABILITY_OPTIONS,
  CANDIDATE_GRADES,
  CANDIDATE_GRADE_LABEL,
  CANDIDATE_LOCATIONS,
  CANDIDATE_LOCATION_LABEL,
  EXPERIENCE_BANDS,
  EXPERIENCE_BAND_LABEL,
  services,
  telLink,
  tenant,
  whatsappLink,
} from "@meridian/core";
import { CheckCircle, Warning, Plus, Copy } from "@phosphor-icons/react/dist/ssr";
import { submitApplicationForm, type ApplicationFormState } from "./actions";

const INITIAL: ApplicationFormState = { status: "idle" };

/**
 * The application form (`ATS-3`).
 *
 * ── ONE SCREEN, NOT FOUR STEPS ──────────────────────────────────────────────
 *
 * The wireframe draws a four-step wizard with a progress bar; `ATS-3` says
 * "one screen". This is one screen, sectioned into the wizard's four named
 * groups, and the divergence is deliberate:
 *
 *  * Every form in this application works with JavaScript switched off, which
 *    is an architectural rule here rather than a preference. A four-step wizard
 *    without JavaScript is four page loads on a phone on a site connection —
 *    which is most of the three-minute budget spent on navigation.
 *  * A wizard holds state the back button destroys. Somebody who taps back to
 *    check what they put for experience and loses their certificate rows does
 *    not start again.
 *  * A progress bar communicates length. On a form whose entire selling point
 *    is that it is short, one screen a thumb can flick to the end of says it
 *    better than "Step 2 of 4" does.
 *
 * ── THE FIELD BUDGET ────────────────────────────────────────────────────────
 *
 * Two fields are typed: name and phone. Everything else is a tap on a radio,
 * and everything optional is genuinely optional. Roughly 60% of applicants
 * abandon on length, so a field that cannot justify itself in one sentence is
 * not on this form.
 *
 * ── WHAT IS NOT ASKED, AND WILL NOT BE ──────────────────────────────────────
 *
 * Date of birth, nationality, ethnicity, religion, marital status, children,
 * gender, a photograph, health or disability status, and **visa status**
 * (`ATS-6`, `ATS-5`). Not hidden, not optional — absent. The server action
 * cannot receive them and the database function has no argument for them.
 */
export function ApplicationForm({
  roleSlug,
  roleTrade,
  roleTitle,
  physicalRequirements,
}: {
  roleSlug: string;
  roleTrade: string;
  roleTitle: string;
  physicalRequirements: string | null;
}) {
  const [state, formAction, pending] = useActionState(submitApplicationForm, INITIAL);
  const [certificateRows, setCertificateRows] = useState(1);
  const [hasCertificates, setHasCertificates] = useState<"yes" | "no">("no");

  if (state.status === "success" && state.reference) {
    return <Confirmation state={state} roleTitle={roleTitle} />;
  }

  const error = (field: string) => state.errors?.[field];

  return (
    <form action={formAction} className="space-y-10" noValidate>
      <input type="hidden" name="roleSlug" value={roleSlug} />
      {/* Honeypot. Off-screen rather than display:none, which some bots skip. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="company-field">Company</label>
        <input id="company-field" type="text" name="company" tabIndex={-1} autoComplete="off" />
      </div>

      {state.status === "error" && state.message ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-sm p-4 text-[15px]"
          style={{ backgroundColor: "var(--status-critical-wash)" }}
        >
          <Warning
            size={18}
            weight="fill"
            aria-hidden
            className="mt-0.5 shrink-0"
            style={{ color: "var(--status-critical-text)" }}
          />
          <span>{state.message}</span>
        </div>
      ) : null}

      {/* ── 1. Can you do the job ──────────────────────────────────────── */}
      <FormSection number={1} title="Can you do the job">
        <Choice
          name="trade"
          label="Your trade"
          error={error("trade")}
          defaultValue={roleTrade}
          options={services.map((s) => ({ value: s.slug, label: s.shortName }))}
          asSelect
        />
        <Choice
          name="grade"
          label="Your grade"
          error={error("grade")}
          defaultValue="technician"
          options={CANDIDATE_GRADES.map((g) => ({ value: g, label: CANDIDATE_GRADE_LABEL[g] }))}
        />
        <Choice
          name="experienceBand"
          label="Years in the trade"
          error={error("experienceBand")}
          defaultValue="2_to_5"
          options={EXPERIENCE_BANDS.map((b) => ({ value: b, label: EXPERIENCE_BAND_LABEL[b] }))}
        />
        <Choice
          name="currentLocation"
          label="Where are you now?"
          hint="This is about how soon a trade test can be arranged. It is not a filter, and we hire from both."
          error={error("currentLocation")}
          defaultValue="in_uae"
          options={CANDIDATE_LOCATIONS.map((l) => ({
            value: l,
            label: CANDIDATE_LOCATION_LABEL[l],
          }))}
        />
      </FormSection>

      {/* ── 2. Certificates ────────────────────────────────────────────── */}
      <FormSection number={2} title="Your certificates">
        <fieldset className="flex flex-col gap-3">
          <legend className="text-[15px] font-medium">Do you hold any trade certificates?</legend>
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            If not, that is fine — say no and carry on. Nothing here is required.
          </p>
          <div className="flex flex-wrap gap-2">
            {(["no", "yes"] as const).map((value) => (
              <label
                key={value}
                className="flex cursor-pointer items-center gap-2.5 rounded-sm border px-4 py-3 text-[15px]"
                style={{
                  backgroundColor:
                    hasCertificates === value ? "var(--accent-wash)" : "var(--surface-raised)",
                  borderColor:
                    hasCertificates === value ? "var(--accent)" : "var(--border-strong)",
                }}
              >
                <input
                  type="radio"
                  name="hasCertificates"
                  value={value}
                  checked={hasCertificates === value}
                  onChange={() => setHasCertificates(value)}
                />
                {value === "yes" ? "Yes" : "No"}
              </label>
            ))}
          </div>
        </fieldset>

        {/*
          Rendered whenever JavaScript has not decided otherwise, so a visitor
          with scripts off still sees one certificate row and can fill it in.
          The toggle above is an affordance, not a gate.
        */}
        {hasCertificates === "yes" ? (
          <div className="space-y-4">
            {error("certificates") ? (
              <p role="alert" className="text-[14px]" style={{ color: "var(--status-critical-text)" }}>
                {error("certificates")}
              </p>
            ) : null}

            {Array.from({ length: certificateRows }, (_, i) => (
              <div
                key={i}
                className="rounded-sm border p-4"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Text
                    name={`cert_${i}_scheme`}
                    label="Certificate"
                    placeholder="e.g. HVAC Level 2"
                  />
                  <Text
                    name={`cert_${i}_expires`}
                    label="Expires"
                    type="month"
                    hint="The date everyone forgets — and the one that stops you being sent to site."
                  />
                  <Text name={`cert_${i}_number`} label="Number (optional)" />
                  <Text name={`cert_${i}_body`} label="Issued by (optional)" />
                </div>
              </div>
            ))}

            {certificateRows < 6 ? (
              <button
                type="button"
                onClick={() => setCertificateRows((n) => n + 1)}
                className="btn btn-secondary"
              >
                <Plus size={15} weight="bold" aria-hidden />
                Add another certificate
              </button>
            ) : null}
          </div>
        ) : null}

        {/*
          `ATS-6`. A job question about the essential functions of this role,
          with or without reasonable adjustment. Never a health question, and
          the second answer is "I'd like to discuss it" rather than "no" —
          because the right outcome there is a conversation, not a rejection the
          applicant issued to themselves on a form.
        */}
        {physicalRequirements ? (
          <div
            className="rounded-sm p-4 text-[15px]"
            style={{ backgroundColor: "var(--surface-sunken)" }}
          >
            <p className="font-medium">Physical requirements for this role</p>
            <p className="prose-body mt-1.5 text-[14px]">{physicalRequirements}</p>
          </div>
        ) : null}

        <Choice
          name="essentialFunctions"
          label="Can you perform these, with or without reasonable adjustment?"
          error={error("essentialFunctions")}
          defaultValue="yes"
          options={[
            { value: "yes", label: "Yes" },
            { value: "discuss", label: "I'd like to discuss it" },
          ]}
        />
      </FormSection>

      {/* ── 3. When you can start ──────────────────────────────────────── */}
      <FormSection number={3} title="When you can start">
        <Choice
          name="availability"
          label="Availability"
          error={error("availability")}
          defaultValue="immediate"
          options={AVAILABILITY_OPTIONS.map((a) => ({ value: a, label: AVAILABILITY_LABEL[a] }))}
        />
        <label className="flex items-center gap-3 text-[15px]">
          <input type="checkbox" name="hasDrivingLicence" className="h-[18px] w-[18px]" />
          I hold a UAE driving licence
        </label>
      </FormSection>

      {/* ── 4. How to reach you ────────────────────────────────────────── */}
      <FormSection number={4} title="How to reach you">
        <Text
          name="fullName"
          label="Your name"
          autoComplete="name"
          required
          error={error("fullName")}
        />
        <Text
          name="phone"
          label="Phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          required
          hint="This is how we will contact you. WhatsApp works."
          error={error("phone")}
        />
        <Text
          name="email"
          label="Email (optional)"
          type="email"
          inputMode="email"
          autoComplete="email"
          hint="If you give us one we will email you the outcome as well as messaging you."
          error={error("email")}
        />

        <div className="flex flex-col gap-2">
          <label htmlFor="cv-field" className="text-[15px] font-medium">
            CV (optional)
          </label>
          <input
            id="cv-field"
            type="file"
            name="cv"
            accept="application/pdf,image/png,image/jpeg,image/webp,image/heic,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/rtf"
            className="text-[14px]"
          />
          <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            A PDF, a Word document, or a photo of your CV, up to 10 MB. Plain text files
            cannot be accepted. No CV? That is fine — you have told us enough.
          </p>
        </div>

        <label className="flex items-start gap-3 text-[15px]">
          <input
            type="checkbox"
            name="overEighteen"
            required
            defaultChecked
            className="mt-0.5 h-[18px] w-[18px]"
          />
          <span>
            I am 18 or over.
            {error("overEighteen") ? (
              <span className="block text-[13px]" style={{ color: "var(--status-critical-text)" }}>
                {error("overEighteen")}
              </span>
            ) : null}
          </span>
        </label>

        {/*
          `ATS-13`. Separate, explicit, unticked. The application itself is
          processed under the pre-contractual negotiation exception and that
          basis expires with the vacancy; keeping the details afterwards is a
          different purpose and needs its own consent, so it gets its own box.
        */}
        <label className="flex items-start gap-3 text-[15px]">
          <input type="checkbox" name="talentPoolConsent" className="mt-0.5 h-[18px] w-[18px]" />
          <span>
            Keep my details for future roles in my trade.
            <span className="block text-[13px]" style={{ color: "var(--text-muted)" }}>
              Optional, and separate from this application. We will check with you every three
              months and you can ask us to delete your details at any time.
            </span>
          </span>
        </label>
      </FormSection>

      <div className="space-y-4">
        <button
          type="submit"
          disabled={pending}
          className="btn btn-primary w-full !py-4 text-[16px] disabled:opacity-60"
        >
          {pending ? "Sending your application…" : "Submit application"}
        </button>
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          We reply to every application, including the ones we turn down, and we will tell you when
          by. We never charge you anything — recruitment and visa costs are ours by law.
        </p>
      </div>
    </form>
  );
}

/**
 * The confirmation (`ATS-16`, wireframe §2.4).
 *
 * Three things, in this order: it arrived, here is your reference, here is when
 * you will hear — and a link that answers "where has it got to" at any hour
 * without an account. Those four facts are the whole difference between this
 * and the applications that go into a mailbox and are never mentioned again.
 */
function Confirmation({ state, roleTitle }: { state: ApplicationFormState; roleTitle: string }) {
  const whatsapp = whatsappLink(`Hello, I am asking about application ${state.reference}.`);

  return (
    <div
      role="status"
      className="rounded border p-7"
      style={{ backgroundColor: "var(--surface-raised)" }}
    >
      <div className="flex items-start gap-3">
        <CheckCircle
          size={26}
          weight="fill"
          aria-hidden
          className="mt-0.5 shrink-0"
          style={{ color: "var(--accent)" }}
        />
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">Application received</h2>
          <p className="prose-body mt-1.5 text-[15px]">
            For {roleTitle}. Nothing else is needed from you right now.
          </p>
        </div>
      </div>

      <dl className="mt-7 space-y-5">
        <div>
          <dt className="text-[13px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
            Your reference
          </dt>
          <dd className="tnum mt-1 text-[22px] font-semibold">{state.reference}</dd>
        </div>

        {state.outcomeDueLabel ? (
          <div>
            <dt
              className="text-[13px] uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}
            >
              You will hear from us by
            </dt>
            <dd className="mt-1 text-[17px] font-medium">
              {state.outcomeDueLabel}
              <span className="block text-[14px] font-normal" style={{ color: "var(--text-secondary)" }}>
                Whatever the outcome. If it is a no, we will tell you why.
              </span>
            </dd>
          </div>
        ) : null}

        {state.statusUrl ? (
          <div>
            <dt
              className="text-[13px] uppercase tracking-wide"
              style={{ color: "var(--text-muted)" }}
            >
              Track your application
            </dt>
            <dd className="mt-1.5">
              <a
                href={state.statusUrl}
                className="inline-flex max-w-full items-center gap-2 break-all text-[15px] underline"
                style={{ color: "var(--accent-text)" }}
              >
                <Copy size={15} aria-hidden className="shrink-0" />
                {state.statusUrl}
              </a>
              <span className="mt-1.5 block text-[14px]" style={{ color: "var(--text-secondary)" }}>
                No account, no password. Save this link — it is the only copy.
              </span>
            </dd>
          </div>
        ) : null}
      </dl>

      {state.cvNote ? (
        <p
          className="mt-6 rounded-sm p-3.5 text-[14px]"
          style={{ backgroundColor: "var(--surface-sunken)" }}
        >
          {state.cvNote}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap gap-3">
        {whatsapp ? (
          <a href={whatsapp} className="btn btn-secondary">
            Ask us a question
          </a>
        ) : null}
        {tenant.phone ? (
          <a href={telLink(tenant.phone)} className="btn btn-secondary">
            {tenant.phone}
          </a>
        ) : null}
      </div>
    </div>
  );
}

// ── Primitives, kept local ─────────────────────────────────────────────────

function FormSection({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="space-y-6">
      <legend className="flex items-baseline gap-3">
        <span
          aria-hidden
          className="grid h-6 w-6 place-items-center rounded-full font-mono text-[12px] font-bold"
          style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
        >
          {number}
        </span>
        <span className="text-[19px] font-semibold tracking-tight">{title}</span>
      </legend>
      {children}
    </fieldset>
  );
}

/**
 * A choice. Radios by default, a select only where the list is long.
 *
 * Radios cost one tap; a select costs a tap, a scroll and a second tap, and on
 * a phone it covers the page while you do it. That is the whole reason grade,
 * experience, location and availability are radios and trade is not: ten trades
 * is where the radio list stops being scannable.
 */
function Choice({
  name,
  label,
  hint,
  error,
  defaultValue,
  options,
  asSelect,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  defaultValue: string;
  options: readonly { value: string; label: string }[];
  asSelect?: boolean;
}) {
  const describedBy = hint || error ? `${name}-hint` : undefined;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="text-[15px] font-medium">{label}</legend>
      {hint ? (
        <p id={describedBy} className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </p>
      ) : null}

      {asSelect ? (
        <select
          name={name}
          defaultValue={defaultValue}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className="w-full rounded-sm border px-3.5 py-3 text-[16px] outline-none focus:border-[var(--accent)]"
          style={{
            backgroundColor: "var(--surface-raised)",
            color: "var(--text-primary)",
            borderColor: error ? "var(--status-critical)" : "var(--border-strong)",
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <label
              key={o.value}
              // A generous hit area. This form is filled in with one thumb, and
              // a 44px target is the difference between one tap and three.
              className="flex cursor-pointer items-center gap-2.5 rounded-sm border px-4 py-3 text-[15px] has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-wash)]"
              style={{
                backgroundColor: "var(--surface-raised)",
                borderColor: "var(--border-strong)",
              }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                defaultChecked={o.value === defaultValue}
                aria-describedby={describedBy}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}

      {error ? (
        <p role="alert" className="text-[13px]" style={{ color: "var(--status-critical-text)" }}>
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function Text({
  name,
  label,
  hint,
  error,
  type = "text",
  required,
  placeholder,
  autoComplete,
  inputMode,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  inputMode?: "text" | "tel" | "email";
}) {
  const id = `field-${name}`;
  const hintId = hint || error ? `${id}-hint` : undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-[15px] font-medium">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        inputMode={inputMode}
        aria-describedby={hintId}
        aria-invalid={error ? true : undefined}
        // 16px, deliberately. Anything smaller makes iOS Safari zoom the page
        // on focus, and a form that jumps when you tap it is a form people
        // abandon before they find their way back to the next field.
        className="w-full rounded-sm border px-3.5 py-3 text-[16px] outline-none transition-colors focus:border-[var(--accent)]"
        style={{
          backgroundColor: "var(--surface-raised)",
          color: "var(--text-primary)",
          borderColor: error ? "var(--status-critical)" : "var(--border-strong)",
        }}
      />
      {hint && !error ? (
        <p id={hintId} className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={hintId} role="alert" className="text-[13px]" style={{ color: "var(--status-critical-text)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
