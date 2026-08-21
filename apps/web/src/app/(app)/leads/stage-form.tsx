"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Field, FormBanner, Select, SubmitButton, TextInput } from "@/components/form";
import { changeLeadStage, type StageState } from "./actions";
import { STAGE_CHOICES } from "./stage-choices";

const INITIAL: StageState = {};

export interface StageReason {
  readonly id: string;
  readonly label: string;
  /** `lost` | `dormant` | `both`. */
  readonly appliesTo: string;
}

const GROUPS = [
  { key: "both", label: "Lost or dormant" },
  { key: "lost", label: "Lost only" },
  { key: "dormant", label: "Dormant only" },
] as const;

/**
 * Move a lead, with the reason the move requires (`LEAD-6`).
 *
 * ── WHY THE REASON CONTROL IS A SELECT AND NOT A TEXT BOX ───────────────────
 *
 * Because the reason field is the only output the question was asked for. A
 * text box produces "too expensive", "Price", "cost" and "budget" for one
 * reason, and the pipeline report they were collected for cannot group them
 * back together — the analysis is lost at the moment of typing, not later.
 *
 * ── WHY NOTHING HERE IS CONTROLLED BY REACT STATE ───────────────────────────
 *
 * An earlier version filtered the reason list to the chosen stage as you
 * changed it, which meant the stage select had to be a controlled component.
 * React resets a form's DOM after a server action runs, and a controlled field
 * whose state did not change is not re-rendered afterwards — so a refused
 * submission left "Lost" in the component's state and `new` in the select the
 * operator was looking at, and the next click saved the stage they had not
 * chosen. It did so silently, which is the worst version of that bug.
 *
 * Uncontrolled fields cannot drift from what is on screen: the select returns
 * to this lead's actual stage after every submission, and what is posted is
 * always what was showing. The reasons are grouped by the stage they answer
 * instead of filtered, which needs no JavaScript at all — and the server
 * resolves the choice against the tenant's list either way, so the grouping is
 * guidance and the refusal is the control.
 */
export function StageForm({
  leadId,
  currentStage,
  reasons,
}: {
  leadId: string;
  currentStage: string;
  reasons: readonly StageReason[];
}) {
  const [state, formAction, pending] = useActionState(changeLeadStage, INITIAL);

  // `<details>` rather than a button that flips state, because this form has to
  // work with JavaScript switched off, and a panel only React can open is a form
  // nobody can reach. The disclosure is the browser's.
  return (
    <details>
      <summary className="btn btn-secondary inline-flex cursor-pointer !py-2 text-[14px]">
        Change stage
      </summary>

      <form action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="leadId" value={leadId} />

        {state.error ? <FormBanner tone="error">{state.error}</FormBanner> : null}
        {state.success ? <FormBanner tone="success">{state.success}</FormBanner> : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Stage">
            {({ id }) => (
              <Select id={id} name="stage" defaultValue={currentStage}>
                {STAGE_CHOICES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Reason"
            description="Required for lost and dormant. Ignored for every other stage."
          >
            {({ id }) => (
              <Select id={id} name="dispositionReasonId" defaultValue="">
                <option value="">No reason</option>
                {GROUPS.map((group) => {
                  const inGroup = reasons.filter((reason) => reason.appliesTo === group.key);
                  if (inGroup.length === 0) return null;
                  return (
                    <optgroup key={group.key} label={group.label}>
                      {inGroup.map((reason) => (
                        <option key={reason.id} value={reason.id}>
                          {reason.label}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </Select>
            )}
          </Field>
        </div>

        {reasons.length === 0 ? (
          <FormBanner tone="error">
            There are no reasons on the list, so this lead cannot be marked lost or dormant. Until
            somebody adds them in{" "}
            <Link href="/admin/reference/dispositions" className="underline underline-offset-2">
              reference data
            </Link>
            , every dead lead either sits in the pipeline looking live or is closed with a reason
            nobody can report on.
          </FormBanner>
        ) : null}

        <Field
          label="Note"
          description="What actually happened, in your words. Optional, and it does not replace the reason."
        >
          {({ id }) => <TextInput id={id} name="note" autoComplete="off" />}
        </Field>

        <SubmitButton
          pending={pending}
          pendingLabel="Saving…"
          className="btn btn-primary !py-2 text-[14px] disabled:opacity-60"
        >
          Save stage
        </SubmitButton>
      </form>
    </details>
  );
}
