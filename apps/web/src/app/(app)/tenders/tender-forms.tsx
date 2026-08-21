"use client";

import { useActionState, useState } from "react";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import {
  recordTender,
  saveTenderDetail,
  submitTender,
  closeTender,
  type TenderFormState,
} from "./actions";

const INITIAL: TenderFormState = {};

/**
 * Vocabulary options are passed in rather than imported.
 *
 * Importing them from `@meridian/db` in a client component would pull the
 * postgres driver into the browser bundle — the same rule the accreditation
 * panel follows.
 */
export interface Option {
  readonly value: string;
  readonly label: string;
}

export interface PropertyOption extends Option {
  readonly assetCount: number;
}

/** Record a tender (`CON-11`). */
export function RecordTenderPanel({ sources }: { sources: readonly Option[] }) {
  const [state, formAction, pending] = useActionState(recordTender, INITIAL);

  return (
    <section className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
      <h2 className="text-lg font-semibold tracking-tight">Record a tender</h2>
      <p className="prose-body mt-2 text-[14px]">
        The deadline is the only field with no way round it. Everything else can be filled in
        afterwards &mdash; an opportunity noticed on a Thursday and written up the following week is
        one whose closing date has already moved four days closer.
      </p>

      <form action={formAction} className="mt-6 space-y-5">
        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

        <Field label="Title" description="What the issuer calls it.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="title" required minLength={3} aria-describedby={describedBy} />
          )}
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Issued by" description="The OA, developer, managing agent or authority.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="issuingBody" required aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Opportunity source">
            {({ id, describedBy }) => (
              <Select
                id={id}
                name="opportunitySourceId"
                required
                defaultValue=""
                aria-describedby={describedBy}
              >
                <option value="" disabled>
                  Choose a channel
                </option>
                {sources.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label="Submission deadline" description="Required. The queue sorts on it.">
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="submissionDeadline"
                type="date"
                required
                aria-describedby={describedBy}
              />
            )}
          </Field>

          <Field label="Decision expected" description="Optional. When the issuer says it will decide.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="decisionDate" type="date" aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Budget cycle" description="Optional. The issuer's budget year, as they write it.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="budgetCycle" maxLength={16} aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Portal reference" description="Optional. Their eSupply or tender number.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="portalReference" maxLength={64} aria-describedby={describedBy} />
            )}
          </Field>

          <Field label="Bid value" description="Optional, and revisable. AED, excluding VAT.">
            {({ id, describedBy }) => (
              <TextInput id={id} name="bidValue" inputMode="decimal" aria-describedby={describedBy} />
            )}
          </Field>

          <Field
            label="Competitors known"
            description="Optional. Leave blank for unknown — blank is not zero."
          >
            {({ id, describedBy }) => (
              <TextInput
                id={id}
                name="competitorsKnown"
                type="number"
                min={0}
                aria-describedby={describedBy}
              />
            )}
          </Field>
        </div>

        <Field label="Scope of work" description="Needed before a pack can be assembled.">
          {({ id, describedBy }) => (
            <TextArea id={id} name="scopeOfWork" rows={4} aria-describedby={describedBy} />
          )}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Recording…"
          className="btn btn-primary disabled:opacity-60"
        >
          Record tender
        </SubmitButton>
      </form>
    </section>
  );
}

/** Edit a tender and set the buildings it is priced for. */
export function TenderDetailForm({
  tenderId,
  defaults,
  properties,
  selectedPropertyIds,
}: {
  tenderId: string;
  defaults: {
    title: string;
    issuingBody: string;
    submissionDeadline: string;
    decisionDate: string | null;
    budgetCycle: string | null;
    portalReference: string | null;
    scopeOfWork: string | null;
    competitorsKnown: number | null;
    competitorNotes: string | null;
    bidValue: string | null;
  };
  properties: readonly PropertyOption[];
  selectedPropertyIds: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(saveTenderDetail, INITIAL);
  const [selected, setSelected] = useState<readonly string[]>(selectedPropertyIds);

  const registeredPlant = properties
    .filter((p) => selected.includes(p.value))
    .reduce((sum, p) => sum + p.assetCount, 0);

  return (
    <form action={formAction} className="mt-6 space-y-5">
      <input type="hidden" name="tenderId" value={tenderId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <Field label="Title">
        {({ id }) => <TextInput id={id} name="title" defaultValue={defaults.title} required />}
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Issued by">
          {({ id }) => (
            <TextInput id={id} name="issuingBody" defaultValue={defaults.issuingBody} required />
          )}
        </Field>
        <Field label="Submission deadline">
          {({ id }) => (
            <TextInput
              id={id}
              name="submissionDeadline"
              type="date"
              defaultValue={defaults.submissionDeadline}
              required
            />
          )}
        </Field>
        <Field label="Decision expected">
          {({ id }) => (
            <TextInput
              id={id}
              name="decisionDate"
              type="date"
              defaultValue={defaults.decisionDate ?? ""}
            />
          )}
        </Field>
        <Field label="Budget cycle">
          {({ id }) => (
            <TextInput id={id} name="budgetCycle" defaultValue={defaults.budgetCycle ?? ""} maxLength={16} />
          )}
        </Field>
        <Field label="Portal reference">
          {({ id }) => (
            <TextInput
              id={id}
              name="portalReference"
              defaultValue={defaults.portalReference ?? ""}
              maxLength={64}
            />
          )}
        </Field>
        <Field label="Bid value" description="AED, excluding VAT.">
          {({ id }) => (
            <TextInput id={id} name="bidValue" inputMode="decimal" defaultValue={defaults.bidValue ?? ""} />
          )}
        </Field>
        <Field label="Competitors known" description="Blank means unknown, which is not zero.">
          {({ id }) => (
            <TextInput
              id={id}
              name="competitorsKnown"
              type="number"
              min={0}
              defaultValue={defaults.competitorsKnown ?? ""}
            />
          )}
        </Field>
      </div>

      <Field label="Scope of work" description="Printed on the pack. It will not assemble without one.">
        {({ id }) => (
          <TextArea id={id} name="scopeOfWork" rows={5} defaultValue={defaults.scopeOfWork ?? ""} />
        )}
      </Field>

      <Field label="What is known about the competition" description="Optional. Intelligence, not data.">
        {({ id }) => (
          <TextArea id={id} name="competitorNotes" rows={3} defaultValue={defaults.competitorNotes ?? ""} />
        )}
      </Field>

      <fieldset>
        <legend className="text-[13px] font-medium">Buildings this tender covers</legend>
        <p className="prose-body mt-1 text-[13px]">
          The pack&rsquo;s per-asset PPM schedule is the union of these buildings&rsquo; registers.
          A building with no registered plant contributes nothing to it.
        </p>
        <div className="mt-3 max-h-64 space-y-2 overflow-y-auto rounded border p-3">
          {properties.length === 0 ? (
            <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
              No properties are registered in this tenant yet.
            </p>
          ) : (
            properties.map((p) => (
              <label key={p.value} className="flex items-baseline gap-2 text-[13px]">
                <input
                  type="checkbox"
                  name="propertyIds"
                  value={p.value}
                  checked={selected.includes(p.value)}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? [...current, p.value]
                        : current.filter((id) => id !== p.value),
                    )
                  }
                />
                <span>
                  {p.label}
                  <span className="tnum" style={{ color: "var(--text-muted)" }}>
                    {" "}
                    &middot; {p.assetCount} asset{p.assetCount === 1 ? "" : "s"}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
          <span className="tnum">{registeredPlant}</span> item
          {registeredPlant === 1 ? "" : "s"} of plant would appear in the pack.
        </p>
      </fieldset>

      <SubmitButton pending={pending} pendingLabel="Saving…" className="btn btn-primary disabled:opacity-60">
        Save tender
      </SubmitButton>
    </form>
  );
}

/** Record that the bid went in. */
export function SubmitTenderForm({ tenderId, today }: { tenderId: string; today: string }) {
  const [state, formAction, pending] = useActionState(submitTender, INITIAL);

  return (
    <form action={formAction} className="mt-4 space-y-4">
      <input type="hidden" name="tenderId" value={tenderId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Submitted on">
          {({ id }) => <TextInput id={id} name="submittedOn" type="date" defaultValue={today} required />}
        </Field>
        <Field label="Bid value" description="Optional. AED, excluding VAT.">
          {({ id }) => <TextInput id={id} name="bidValue" inputMode="decimal" />}
        </Field>
      </div>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        Mark as submitted
      </SubmitButton>
    </form>
  );
}

/**
 * Record the outcome and the reason (`CON-11`).
 *
 * The reason list narrows with the outcome, in the browser, from the list the
 * server sent — a losing reason offered as an explanation for a win is a
 * dropdown that trains people to pick the nearest wrong thing.
 */
export function CloseTenderForm({
  tenderId,
  today,
  reasons,
}: {
  tenderId: string;
  today: string;
  reasons: readonly (Option & { appliesTo: string })[];
}) {
  const [state, formAction, pending] = useActionState(closeTender, INITIAL);
  const [outcome, setOutcome] = useState("");

  const applicable = reasons.filter(
    (r) => outcome === "" || r.appliesTo === "both" || r.appliesTo === outcome,
  );

  return (
    <form action={formAction} className="mt-4 space-y-4">
      <input type="hidden" name="tenderId" value={tenderId} />
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
      {state.ok ? <FormBanner tone="success">{state.ok}</FormBanner> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="What happened">
          {({ id }) => (
            <Select
              id={id}
              name="outcome"
              required
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
            >
              <option value="" disabled>
                Choose an outcome
              </option>
              <option value="won">Won</option>
              <option value="lost">Lost</option>
              <option value="withdrawn">Withdrawn</option>
              <option value="no_bid">No bid</option>
            </Select>
          )}
        </Field>

        <Field
          label="Reason"
          description={
            outcome === "lost"
              ? "Required. A loss counted without one tells you the number and not the fix."
              : "Optional."
          }
        >
          {({ id }) => (
            <Select id={id} name="reasonId" defaultValue="" required={outcome === "lost"}>
              <option value="">No reason recorded</option>
              {applicable.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Decided on" description="Optional.">
          {({ id }) => <TextInput id={id} name="decidedOn" type="date" defaultValue={today} />}
        </Field>
      </div>

      <Field label="Note" description="Optional. What the issuer actually said.">
        {({ id }) => <TextArea id={id} name="note" rows={3} />}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Recording…" className="btn btn-secondary disabled:opacity-60">
        Record outcome
      </SubmitButton>
    </form>
  );
}
