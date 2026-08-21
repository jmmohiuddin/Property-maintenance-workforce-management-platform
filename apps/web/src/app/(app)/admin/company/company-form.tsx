"use client";

import { useActionState } from "react";
import { Field, TextInput, FormBanner, SubmitButton } from "@/components/form";
import { saveIdentity, type CompanyState } from "./actions";

const INITIAL: CompanyState = {};

export interface IdentityValues {
  readonly legalName: string;
  readonly tradingName: string;
  readonly brandName: string;
  readonly licenceNumber: string;
  readonly licenceExpiry: string;
  readonly crNumber: string;
  readonly trn: string;
  readonly addressStreet: string;
  readonly addressCity: string;
  readonly addressRegion: string;
  readonly lat: string;
  readonly lng: string;
  readonly phone: string;
  readonly emergencyPhone: string;
  readonly whatsapp: string;
  readonly email: string;
}

/**
 * The identity form (`ADM-9`).
 *
 * ── NO PLACEHOLDER ATTRIBUTES, ANYWHERE ─────────────────────────────────────
 *
 * Not one input on this form carries a `placeholder` showing an example value.
 * A greyed-out `100399999900003` in the TRN box is indistinguishable from a
 * saved value at a glance, and somebody will read it off this screen onto an
 * invoice. Guidance goes in the description under the label, where it is prose
 * and cannot be mistaken for data — which is the same rule the rest of the
 * system follows for unset values, applied to the form that sets them.
 *
 * Every description says what the field *blocks* while it is empty, so the cost
 * of leaving it blank is on the screen rather than in a document nobody reads.
 */
export function CompanyForm({ values }: { values: IdentityValues }) {
  const [state, formAction, pending] = useActionState(saveIdentity, INITIAL);

  return (
    <form action={formAction} className="space-y-8">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

      <fieldset className="space-y-4">
        <legend className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
          Identity
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Legal name"
            description="Exactly as it appears on the trade licence. This is the name on every contract."
          >
            {({ id }) => (
              <TextInput id={id} name="legalName" defaultValue={values.legalName} required autoComplete="off" />
            )}
          </Field>

          <Field label="Trading name" description="Only if you trade under a different name. Leave empty otherwise.">
            {({ id }) => (
              <TextInput id={id} name="tradingName" defaultValue={values.tradingName} autoComplete="off" />
            )}
          </Field>

          <Field label="Brand name" description="What the application and the website call the company.">
            {({ id }) => <TextInput id={id} name="brandName" defaultValue={values.brandName} autoComplete="off" />}
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
          Registration
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Trade licence number"
            description="Issued by the Dubai Department of Economy and Tourism. Required on the website and on every document (WEB-14)."
          >
            {({ id }) => (
              <TextInput id={id} name="licenceNumber" defaultValue={values.licenceNumber} autoComplete="off" />
            )}
          </Field>

          <Field label="Licence expiry" description="Drives the renewal warning above.">
            {({ id }) => (
              <TextInput id={id} name="licenceExpiry" type="date" defaultValue={values.licenceExpiry} />
            )}
          </Field>

          <Field
            label="Commercial Register number"
            description="Cabinet Resolution 107/2022 Article 7 obliges this to be displayed on the website and on all printed material. While it is empty, the site is not compliant."
          >
            {({ id }) => <TextInput id={id} name="crNumber" defaultValue={values.crNumber} autoComplete="off" />}
          </Field>

          <Field
            label="TRN"
            description="15 digits. Without it no tax invoice can be issued (INV-3) — Article 59 of the VAT Executive Regulations requires the supplier TRN on the face of the invoice."
          >
            {({ id }) => (
              <TextInput id={id} name="trn" inputMode="numeric" defaultValue={values.trn} autoComplete="off" />
            )}
          </Field>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
          Address
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Street address"
            description="Needed for the tax invoice, the LocalBusiness structured data and the Google Business Profile."
          >
            {({ id }) => (
              <TextInput id={id} name="addressStreet" defaultValue={values.addressStreet} autoComplete="off" />
            )}
          </Field>

          <Field label="City">
            {({ id }) => <TextInput id={id} name="addressCity" defaultValue={values.addressCity} autoComplete="off" />}
          </Field>

          <Field label="Emirate">
            {({ id }) => (
              <TextInput id={id} name="addressRegion" defaultValue={values.addressRegion} autoComplete="off" />
            )}
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Latitude" description="For the map block in structured data (WEB-7).">
              {({ id }) => <TextInput id={id} name="lat" inputMode="decimal" defaultValue={values.lat} />}
            </Field>
            <Field label="Longitude">
              {({ id }) => <TextInput id={id} name="lng" inputMode="decimal" defaultValue={values.lng} />}
            </Field>
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
          Contact
        </legend>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Phone" description="Appears in every document footer and in the structured data.">
            {({ id }) => <TextInput id={id} name="phone" type="tel" defaultValue={values.phone} autoComplete="off" />}
          </Field>

          <Field
            label="Emergency phone"
            description="The 24-hour line. WEB-4 requires it reachable in one tap from every page, including when the database is down."
          >
            {({ id }) => (
              <TextInput id={id} name="emergencyPhone" type="tel" defaultValue={values.emergencyPhone} autoComplete="off" />
            )}
          </Field>

          <Field label="WhatsApp" description="Digits only, including the country code. Used to build wa.me links.">
            {({ id }) => (
              <TextInput id={id} name="whatsapp" inputMode="numeric" defaultValue={values.whatsapp} autoComplete="off" />
            )}
          </Field>

          <Field label="Email" description="Contact routes and the reply-to address on notifications.">
            {({ id }) => (
              <TextInput id={id} name="email" type="email" defaultValue={values.email} autoComplete="off" />
            )}
          </Field>
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-4">
        <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-primary disabled:opacity-60">
          Save company details
        </SubmitButton>
        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          Clearing a field removes the claim everywhere it appears. It is never replaced by an
          example value.
        </p>
      </div>
    </form>
  );
}
