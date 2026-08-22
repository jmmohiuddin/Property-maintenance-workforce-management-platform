"use client";

import { Field, TextInput, SubmitButton } from "@/components/form";
import { useActionState, useId, useState } from "react";
import { PROPERTY_TYPE_LABEL, type PropertyType } from "@meridian/core";
import {
  saveTerms,
  createContact,
  deleteContact,
  createProperty,
  grantPortalAccess,
  togglePortalAccess,
  type CustomerState,
} from "./actions";
import { Trash, Plus, Star } from "@phosphor-icons/react/dist/ssr";

const INITIAL: CustomerState = {};

const inputClass =
  "w-full rounded-sm border px-3 py-2 text-[14px] outline-none transition-colors focus:border-[var(--accent)]";
const inputStyle: React.CSSProperties = {
  backgroundColor: "var(--surface)",
  color: "var(--text-primary)",
  borderColor: "var(--border-strong)",
};

function Message({ state }: { state: CustomerState }) {
  const message = state.error ?? state.ok;
  if (!message) return null;
  return (
    <p
      role={state.error ? "alert" : "status"}
      className="mt-4 rounded-sm p-3 text-[13px]"
      style={{
        backgroundColor: "var(--accent-wash)",
        color: state.error ? "var(--accent-text)" : "var(--text-primary)",
      }}
    >
      {message}
    </p>
  );
}

/**
 * Commercial terms.
 *
 * Name and code are shown by the page but not editable here: they appear on
 * issued tax invoices, and renaming an account from the same form that changes
 * a phone number is how a document ends up disagreeing with the record it was
 * raised against.
 */
export function TermsPanel({
  customerId,
  billingEmail,
  phone,
  paymentTermsDays,
  creditLimit,
  accountManagerId,
  notes,
  managers,
  canWrite,
}: {
  customerId: string;
  billingEmail: string | null;
  phone: string | null;
  paymentTermsDays: number;
  creditLimit: string | null;
  accountManagerId: string | null;
  notes: string | null;
  managers: { id: string; fullName: string }[];
  canWrite: boolean;
}) {
  const [state, formAction, pending] = useActionState(saveTerms, INITIAL);
  const id = useId();

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Account terms</h2>
      <p className="prose-body mt-2 text-[14px]">
        Payment terms drive every invoice due date on this account, so changing them changes what
        the overdue report says tomorrow.
      </p>

      <Message state={state} />

      <form action={formAction} className="mt-5 space-y-4">
        <input type="hidden" name="customerId" value={customerId} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-email`} className="text-[13px] font-medium">
              Billing email
            </label>
            <input
              id={`${id}-email`}
              name="billingEmail"
              type="email"
              defaultValue={billingEmail ?? ""}
              disabled={!canWrite}
              className={inputClass}
              style={inputStyle}
            />
            <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
              Where quotes and invoices are sent. Empty means nothing goes out.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-phone`} className="text-[13px] font-medium">
              Phone
            </label>
            <input
              id={`${id}-phone`}
              name="phone"
              defaultValue={phone ?? ""}
              disabled={!canWrite}
              className={inputClass}
              style={inputStyle}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-terms`} className="text-[13px] font-medium">
              Payment terms (days)
            </label>
            <input
              id={`${id}-terms`}
              name="paymentTermsDays"
              type="number"
              min={0}
              max={180}
              required
              defaultValue={paymentTermsDays}
              disabled={!canWrite}
              className={`${inputClass} tnum`}
              style={inputStyle}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-credit`} className="text-[13px] font-medium">
              Credit limit (optional)
            </label>
            <input
              id={`${id}-credit`}
              name="creditLimit"
              defaultValue={creditLimit ?? ""}
              placeholder="50000.00"
              disabled={!canWrite}
              className={`${inputClass} tnum`}
              style={inputStyle}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-manager`} className="text-[13px] font-medium">
            Account manager
          </label>
          <select
            id={`${id}-manager`}
            name="accountManagerId"
            defaultValue={accountManagerId ?? ""}
            disabled={!canWrite}
            className={inputClass}
            style={inputStyle}
          >
            <option value="">Nobody assigned</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-notes`} className="text-[13px] font-medium">
            Notes
          </label>
          <textarea
            id={`${id}-notes`}
            name="notes"
            rows={3}
            defaultValue={notes ?? ""}
            disabled={!canWrite}
            className={inputClass}
            style={inputStyle}
          />
        </div>

        {canWrite ? (
          <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
            {pending ? "Saving..." : "Save terms"}
          </button>
        ) : null}
      </form>
    </section>
  );
}

export function ContactsPanel({
  customerId,
  contacts,
  canWrite,
}: {
  customerId: string;
  contacts: {
    id: string;
    fullName: string;
    role: string | null;
    email: string | null;
    phone: string | null;
    isPrimary: boolean;
    notifyOnJobs: boolean;
  }[];
  canWrite: boolean;
}) {
  const [addState, addAction, adding] = useActionState(createContact, INITIAL);
  const [removeState, removeAction] = useActionState(deleteContact, INITIAL);
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Contacts</h2>
      <p className="prose-body mt-2 text-[14px]">
        The people we actually call. The primary contact is who a dispatcher reaches first when
        access falls through on site.
      </p>

      <Message state={addState.error ?? addState.ok ? addState : removeState} />

      {contacts.length === 0 ? (
        <p className="mt-5 text-[14px]" style={{ color: "var(--accent-text)" }}>
          Nobody on file. A job at this account has no one to call.
        </p>
      ) : (
        <ul className="mt-5 divide-y rounded border">
          {contacts.map((c) => (
            <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
              <div>
                <div className="flex flex-wrap items-baseline gap-2.5">
                  <p className="text-[14px] font-medium">{c.fullName}</p>
                  {c.isPrimary ? (
                    <span
                      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
                    >
                      <Star size={10} weight="fill" aria-hidden />
                      Primary
                    </span>
                  ) : null}
                  {c.role ? (
                    <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {c.role}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {[c.email, c.phone].filter(Boolean).join(" · ") || "No contact details"}
                  {c.notifyOnJobs ? "" : " · not notified about jobs"}
                </p>
              </div>
              {canWrite ? (
                <form action={removeAction}>
                  <input type="hidden" name="contactId" value={c.id} />
                  <input type="hidden" name="customerId" value={customerId} />
                  <button
                    type="submit"
                    className="grid h-8 w-8 place-items-center rounded-sm"
                    style={{ boxShadow: "inset 0 0 0 1px var(--border-strong)" }}
                    aria-label={`Remove ${c.fullName}`}
                    title="Remove this contact"
                  >
                    <Trash size={15} aria-hidden />
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
        <div className="mt-6 border-t pt-6">
          {!open ? (
            <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary">
              <Plus size={15} weight="bold" aria-hidden />
              Add a contact
            </button>
          ) : (
            <form action={addAction} className="space-y-4">
              <input type="hidden" name="customerId" value={customerId} />
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
                    Name
                  </label>
                  <input
                    id={`${id}-name`}
                    name="fullName"
                    required
                    className={inputClass}
                    style={inputStyle}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-role`} className="text-[13px] font-medium">
                    Role (optional)
                  </label>
                  <input
                    id={`${id}-role`}
                    name="role"
                    placeholder="Building manager"
                    className={inputClass}
                    style={inputStyle}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-cemail`} className="text-[13px] font-medium">
                    Email
                  </label>
                  <input
                    id={`${id}-cemail`}
                    name="email"
                    type="email"
                    className={inputClass}
                    style={inputStyle}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-cphone`} className="text-[13px] font-medium">
                    Phone
                  </label>
                  <input id={`${id}-cphone`} name="phone" className={inputClass} style={inputStyle} />
                </div>
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex items-center gap-2.5 text-[13px]">
                  <input type="checkbox" name="isPrimary" className="h-4 w-4" />
                  Primary contact
                </label>
                <label className="flex items-center gap-2.5 text-[13px]">
                  <input type="checkbox" name="notifyOnJobs" defaultChecked className="h-4 w-4" />
                  Notify about jobs
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button type="submit" disabled={adding} className="btn btn-primary disabled:opacity-60">
                  {adding ? "Adding..." : "Add contact"}
                </button>
                <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Add a property.
 *
 * Coordinates are optional but the form says what happens without them: the
 * dispatch optimiser ranks by travel distance, and a property with no position
 * falls back to matching on city alone.
 */
export function AddPropertyForm({ customerId }: { customerId: string }) {
  const [state, formAction, pending] = useActionState(createProperty, INITIAL);
  const [open, setOpen] = useState(false);
  const id = useId();

  if (!open) {
    return (
      <>
        <Message state={state} />
        <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary mt-4">
          <Plus size={15} weight="bold" aria-hidden />
          Add a property
        </button>
      </>
    );
  }

  return (
    <form action={formAction} className="mt-5 space-y-4 border-t pt-5">
      <input type="hidden" name="customerId" value={customerId} />
      <Message state={state} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-pname`} className="text-[13px] font-medium">
            Name
          </label>
          <input
            id={`${id}-pname`}
            name="name"
            required
            placeholder="Marina Heights"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-ptype`} className="text-[13px] font-medium">
            Type
          </label>
          <select
            id={`${id}-ptype`}
            name="type"
            defaultValue="building"
            className={inputClass}
            style={inputStyle}
          >
            {(Object.keys(PROPERTY_TYPE_LABEL) as PropertyType[]).map((t) => (
              <option key={t} value={t}>
                {PROPERTY_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-addr`} className="text-[13px] font-medium">
          Address
        </label>
        <input
          id={`${id}-addr`}
          name="addressLine"
          required
          className={inputClass}
          style={inputStyle}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-area`} className="text-[13px] font-medium">
            Area (optional)
          </label>
          <input
            id={`${id}-area`}
            name="area"
            placeholder="Dubai Marina"
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-city`} className="text-[13px] font-medium">
            City
          </label>
          <input
            id={`${id}-city`}
            name="city"
            required
            defaultValue="Dubai"
            className={inputClass}
            style={inputStyle}
          />
        </div>
      </div>

      <fieldset>
        <legend className="text-[13px] font-medium">Position (optional)</legend>
        <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
          Without coordinates, dispatch cannot rank technicians by travel distance to this property
          and falls back to matching on city.
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <input
            aria-label="Latitude"
            name="lat"
            placeholder="Latitude, e.g. 25.076"
            className={`${inputClass} tnum`}
            style={inputStyle}
          />
          <input
            aria-label="Longitude"
            name="lng"
            placeholder="Longitude, e.g. 55.139"
            className={`${inputClass} tnum`}
            style={inputStyle}
          />
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-floors`} className="text-[13px] font-medium">
            Floors (optional)
          </label>
          <input
            id={`${id}-floors`}
            name="floors"
            type="number"
            min={0}
            className={`${inputClass} tnum`}
            style={inputStyle}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-units`} className="text-[13px] font-medium">
            Units (optional)
          </label>
          <input
            id={`${id}-units`}
            name="unitCount"
            type="number"
            min={0}
            className={`${inputClass} tnum`}
            style={inputStyle}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-access`} className="text-[13px] font-medium">
          Access instructions (optional)
        </label>
        <textarea
          id={`${id}-access`}
          name="accessInstructions"
          rows={3}
          placeholder="Gate code, security desk process, escort requirements"
          className={inputClass}
          style={inputStyle}
        />
        <p className="text-[12px]" style={{ color: "var(--text-muted)" }}>
          This reaches the technician on the job card. It is the difference between a completed
          visit and a wasted one.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={pending} className="btn btn-primary disabled:opacity-60">
          {pending ? "Adding..." : "Add property"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Portal access (`POR-8`).
 *
 * The screen that replaces an INSERT. Before this, granting somebody portal
 * access meant writing SQL, so nobody did it — and a portal built to answer
 * "what did you actually do" before it is asked was reachable by almost no one.
 *
 * Revoking is the half that matters most and is easiest to under-build: it
 * deactivates the membership AND kills their sessions, because a building
 * manager who changes jobs on Monday should not still be reading this
 * customer's invoices on Tuesday.
 */
export function PortalAccessPanel({
  customerId,
  users,
  contacts,
}: {
  customerId: string;
  users: {
    userId: string;
    fullName: string;
    email: string;
    isActive: boolean;
    lastLoginAt: Date | null;
    hasPassword: boolean;
  }[];
  contacts: { fullName: string; email: string | null }[];
}) {
  const [grantState, grantAction, granting] = useActionState(grantPortalAccess, INITIAL);
  const [toggleState, toggleAction, toggling] = useActionState(togglePortalAccess, INITIAL);

  // Contacts we already hold an address for and who have no account yet. This
  // is the whole friction: staff should not have to retype an email they
  // already entered on the contacts panel two inches above.
  const withAccounts = new Set(users.map((u) => u.email.toLowerCase()));
  const candidates = contacts.filter(
    (c) => c.email && !withAccounts.has(c.email.toLowerCase()),
  );

  return (
    <section className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-[15px] font-semibold">Portal access</h2>
      <p className="mt-1.5 text-[13px]" style={{ color: "var(--text-muted)" }}>
        They can raise requests, approve quotes and see their own invoices. They see nothing
        belonging to any other customer — that is enforced in the database, not by this screen.
      </p>

      <Message state={grantState} />
      <Message state={toggleState} />

      {users.length === 0 ? (
        <p className="prose-body mt-4 text-[14px]">
          Nobody here can sign in yet. Every status question they have becomes a phone call until
          somebody does.
        </p>
      ) : (
        <ul className="mt-4 divide-y border-y">
          {users.map((u) => (
            <li key={u.userId} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
              <div>
                <p className="text-[14px] font-medium">
                  {u.fullName}
                  {!u.isActive ? (
                    <span
                      className="ml-2 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{
                        backgroundColor: "var(--status-neutral-wash)",
                        color: "var(--status-neutral-text)",
                      }}
                    >
                      Revoked
                    </span>
                  ) : null}
                </p>
                <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {u.email} ·{" "}
                  {!u.hasPassword
                    ? "invitation not yet accepted"
                    : u.lastLoginAt
                      ? `last signed in ${u.lastLoginAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
                      : "never signed in"}
                </p>
              </div>

              <form action={toggleAction} className="shrink-0">
                <input type="hidden" name="customerId" value={customerId} />
                <input type="hidden" name="userId" value={u.userId} />
                <input type="hidden" name="isActive" value={String(!u.isActive)} />
                <button
                  type="submit"
                  disabled={toggling}
                  className="text-[13px] font-medium underline underline-offset-2 disabled:opacity-60"
                  style={{
                    color: u.isActive ? "var(--status-critical-text)" : "var(--accent-text)",
                  }}
                >
                  {toggling ? "Saving…" : u.isActive ? "Revoke access" : "Restore access"}
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={grantAction} className="mt-5 space-y-4 border-t pt-5">
        <input type="hidden" name="customerId" value={customerId} />

        {candidates.length > 0 ? (
          <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
            Contacts on file without an account:{" "}
            {candidates.map((c) => `${c.fullName} (${c.email})`).join(", ")}
          </p>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            {({ id }) => <TextInput id={id} name="fullName" required autoComplete="off" />}
          </Field>
          <Field label="Email">
            {({ id }) => <TextInput id={id} name="email" type="email" required autoComplete="off" />}
          </Field>
        </div>

        <SubmitButton
          pending={granting}
          pendingLabel="Sending…"
          className="btn btn-secondary disabled:opacity-60"
        >
          Send portal invitation
        </SubmitButton>
      </form>
    </section>
  );
}
