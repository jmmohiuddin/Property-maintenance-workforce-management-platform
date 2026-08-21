"use client";

import { useActionState } from "react";
import {
  CANDIDATE_GRADES,
  CANDIDATE_GRADE_LABEL,
  CONTRACT_TYPES,
  CONTRACT_TYPE_LABEL,
  services,
} from "@meridian/core";
import { Field, TextInput, TextArea, Select, FormBanner, SubmitButton } from "@/components/form";
import { createRequisitionAction, type ActionState } from "./actions";

const INITIAL: ActionState = {};

/**
 * Open a vacancy (`ATS-1`).
 *
 * ── WHAT IS AND IS NOT ON THIS FORM ─────────────────────────────────────────
 *
 * `physicalRequirements` is here and is prominent, because `ATS-6` puts the
 * physical demands of a job **in the advert** — that is what makes the single
 * yes/no question on the application form legitimate. An applicant answering
 * "can you perform these?" about demands nobody stated is being asked a health
 * question with extra steps.
 *
 * The salary band is both-or-neither, refused by the domain and by a database
 * CHECK. A half-set band is published to Google Jobs as "from AED 0", which is
 * a salary claim nobody made on a page nobody can un-index.
 *
 * There is no field here for a placement fee, an agency cost to recover, or
 * anything else payable by the person hired. `HR-16` prohibits it, and the way
 * that prohibition is honoured is that no such field exists anywhere in the
 * module — not on this form, not in the action, not in the schema.
 *
 * ── THE HIRING MANAGER ──────────────────────────────────────────────────────
 *
 * `job_requisitions.hiring_manager_user_id` existed, and `createRequisition`
 * accepted it, and this form had no field — so the column could only ever be
 * null on anything the product created. `ATS-1` treats approval as a second
 * decision by a second person; a column nobody can populate cannot carry that,
 * and "who asked for this headcount" is the first question anybody asks when a
 * vacancy has been open for two months.
 *
 * Optional, because a vacancy that cannot be opened until the right person is
 * on the list is a vacancy somebody opens under the wrong name.
 */
export function NewRequisitionForm({
  hiringManagers = [],
}: {
  hiringManagers?: readonly { userId: string; fullName: string; role: string }[];
}) {
  const [state, formAction, pending] = useActionState(createRequisitionAction, INITIAL);

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Job title">
          {({ id, describedBy, invalid }) => (
            <TextInput
              id={id}
              name="title"
              required
              maxLength={160}
              placeholder="AC Technician"
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </Field>

        <Field label="Trade">
          {({ id, describedBy }) => (
            <Select id={id} name="trade" required aria-describedby={describedBy}>
              {services.map((service) => (
                <option key={service.slug} value={service.slug}>
                  {service.shortName}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Grade">
          {({ id }) => (
            <Select id={id} name="grade" defaultValue="technician">
              {CANDIDATE_GRADES.map((grade) => (
                <option key={grade} value={grade}>
                  {CANDIDATE_GRADE_LABEL[grade]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Contract type">
          {({ id }) => (
            <Select id={id} name="contractType" defaultValue="full_time">
              {CONTRACT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CONTRACT_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label="Positions">
          {({ id }) => (
            <TextInput id={id} name="headcount" type="number" min={1} defaultValue={1} />
          )}
        </Field>

        <Field label="Minimum years in trade" description="Leave blank if it does not matter.">
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="minExperienceYears"
              type="number"
              min={0}
              max={40}
              aria-describedby={describedBy}
            />
          )}
        </Field>

        <Field label="City">
          {({ id }) => <TextInput id={id} name="locationCity" defaultValue="Dubai" />}
        </Field>

        <Field label="Area (optional)">
          {({ id }) => <TextInput id={id} name="locationArea" maxLength={120} />}
        </Field>

        <Field
          label="Salary band — from (AED / month)"
          description="Both ends or neither. A half-set band publishes as “from AED 0”."
        >
          {({ id, describedBy }) => (
            <TextInput id={id} name="salaryMin" inputMode="decimal" aria-describedby={describedBy} />
          )}
        </Field>

        <Field label="Salary band — to (AED / month)">
          {({ id }) => <TextInput id={id} name="salaryMax" inputMode="decimal" />}
        </Field>

        <Field label="Applications close" description="Optional. The posting expires on this date.">
          {({ id, describedBy }) => (
            <TextInput id={id} name="closesAt" type="date" aria-describedby={describedBy} />
          )}
        </Field>

        <Field
          label="Hiring manager"
          description="Who asked for this headcount, and who approves it. Optional — but a vacancy with nobody's name on it is one nobody chases."
        >
          {({ id, describedBy }) => (
            <Select id={id} name="hiringManagerUserId" defaultValue="" aria-describedby={describedBy}>
              <option value="">Not named</option>
              {hiringManagers.map((manager) => (
                <option key={manager.userId} value={manager.userId}>
                  {manager.fullName} — {manager.role.replace(/_/g, " ")}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label="Certificates needed"
          description="Comma separated. Shown on the advert, never used to auto-filter."
        >
          {({ id, describedBy }) => (
            <TextInput
              id={id}
              name="requiredCertifications"
              placeholder="HVAC Level 2, Working at height"
              aria-describedby={describedBy}
            />
          )}
        </Field>
      </div>

      <Field label="About the role" description="Two or three sentences. This is the advert.">
        {({ id, describedBy }) => (
          <TextArea id={id} name="summary" rows={3} maxLength={2000} aria-describedby={describedBy} />
        )}
      </Field>

      <Field label="What they would be doing">
        {({ id }) => <TextArea id={id} name="responsibilities" rows={3} maxLength={2000} />}
      </Field>

      <Field
        label="Physical requirements"
        description="Stated here, in the advert — never asked as a health question. The application form asks one yes/no about performing these with or without reasonable adjustment, and that question is only fair if this is filled in."
      >
        {({ id, describedBy }) => (
          <TextArea
            id={id}
            name="physicalRequirements"
            rows={2}
            maxLength={1000}
            placeholder="Working at height, lifting to 25 kg, outdoor work in summer."
            aria-describedby={describedBy}
          />
        )}
      </Field>

      <SubmitButton pending={pending} pendingLabel="Opening…" className="btn btn-primary">
        Open vacancy
      </SubmitButton>
    </form>
  );
}
