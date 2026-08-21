"use client";

import { useActionState } from "react";
import { requestRescheduleAction, type RescheduleFormState } from "./actions";

const INITIAL: RescheduleFormState = { status: "idle" };

/**
 * "That time does not work for me" (`ATS-14`).
 *
 * ── WHY THERE IS NO NEW-TIME PICKER ─────────────────────────────────────────
 *
 * Because a candidate cannot know what else is in that bay at ten on Tuesday. A
 * picker here would let somebody move a site trial a supervisor has blocked two
 * hours out for, and the result is two people standing in a yard rather than a
 * convenience. So this says "I cannot make it", carries one sentence of why,
 * and a person calls back.
 *
 * ── WHY IT IS ON THIS PAGE AT ALL ───────────────────────────────────────────
 *
 * The alternative is silence. Somebody whose shift changed at eleven at night
 * does not phone an office that is shut; they either turn up late or do not
 * turn up, and the first anyone here knows is an empty chair. One button on a
 * page they already have the link to is the difference between a rebooking and
 * a no-show, and a rebooked trade check is a candidate; a no-show is a story
 * about candidates who do not turn up.
 */
export function RescheduleForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(requestRescheduleAction, INITIAL);

  if (state.status === "success") {
    return (
      <p role="status" className="prose-body mt-4 text-[15px]">
        {state.message}
      </p>
    );
  }

  return (
    <form action={action} className="mt-5">
      <input type="hidden" name="token" value={token} />

      {state.status === "error" ? (
        <p
          role="alert"
          className="mb-3 text-[14px]"
          style={{ color: "var(--status-critical-text)" }}
        >
          {state.message}
        </p>
      ) : null}

      <label htmlFor="reschedule-note" className="text-[15px] font-medium">
        Cannot make it? Tell us and we will move it
      </label>
      <textarea
        id="reschedule-note"
        name="note"
        rows={2}
        maxLength={400}
        placeholder="My shift changed — any morning next week is fine"
        className="mt-2 w-full rounded border px-3 py-2 text-[15px]"
        style={{ backgroundColor: "var(--surface)", borderColor: "var(--border-strong)" }}
      />
      <button type="submit" className="btn btn-secondary mt-3" disabled={pending}>
        {pending ? "Sending…" : "Ask us to move it"}
      </button>
      <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
        We would much rather move it than have you not arrive.
      </p>
    </form>
  );
}
