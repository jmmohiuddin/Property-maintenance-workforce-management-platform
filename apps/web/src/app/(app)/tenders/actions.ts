"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  createTender,
  updateTender,
  setTenderProperties,
  markTenderSubmitted,
  recordTenderOutcome,
} from "@meridian/db";
import { TENDER_OUTCOMES, type TenderOutcome } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Writes for the tender pipeline (`CON-11`).
 *
 * Every one of these re-checks `contracts:write` on the server. The pages hide
 * the forms from a read-only role, but hiding a form is not authorisation — a
 * `curl` with a session cookie never sees the page at all.
 *
 * ── WHY `contracts:*` AND NOT A NEW PERMISSION ──────────────────────────────
 *
 * A tender is a contract before it exists: the same people prepare it, the same
 * people decide whether to bid, and winning one produces a contract row. The
 * `sales` role already holds `contracts:write` and is exactly the role that
 * chases OA tenders, so a `tenders:*` pair would have been granted to precisely
 * the roles that already hold this one — an eleventh permission that separates
 * nothing. `packages/auth/src/rbac.ts` says the two-layer model exists so a
 * tenant can tighten without inventing a role; the same argument applies to
 * inventing a permission.
 */

export interface TenderFormState {
  error?: string;
  ok?: string;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * Money from a form, as integer minor units.
 *
 * Parsed from the decimal string the operator typed and rounded once, here, at
 * the edge. Everything below this line is integers — a bid value that travels
 * as a float is a bid value that eventually differs from the one on the
 * document by a fil.
 */
function minorUnits(value: string): number | null | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[, ]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * A calendar day, kept as the string the browser sent.
 *
 * `<input type="date">` submits `YYYY-MM-DD` and the Postgres `date` column
 * stores exactly that. Parsing it into a `Date` in between is the step that
 * introduces a timezone, and a timezone applied to a submission deadline is how
 * a bid due on the 18th gets filed against the 17th. So: check the shape, and
 * pass it through untouched.
 */
function calendarDate(value: string): string | undefined {
  if (!value) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export async function recordTender(
  _prev: TenderFormState,
  formData: FormData,
): Promise<TenderFormState> {
  const session = await requireSessionWith("contracts:write");

  const title = text(formData, "title");
  const issuingBody = text(formData, "issuingBody");
  const opportunitySourceId = text(formData, "opportunitySourceId");
  const submissionDeadline = text(formData, "submissionDeadline");

  if (!title) return { error: "Give the tender a title." };
  if (!issuingBody) return { error: "Name the organisation that issued it." };
  if (!opportunitySourceId) return { error: "Say where the opportunity came from." };
  if (!calendarDate(submissionDeadline)) {
    return { error: "A tender needs a submission deadline. It is the one date nothing negotiates." };
  }

  const bidValueMinor = minorUnits(text(formData, "bidValue"));
  if (bidValueMinor === null) return { error: "The bid value should be a number, like 312000.00." };

  const competitorsRaw = text(formData, "competitorsKnown");
  const competitorsKnown = competitorsRaw ? Number(competitorsRaw) : undefined;
  if (competitorsKnown !== undefined && !Number.isInteger(competitorsKnown)) {
    return { error: "The number of known competitors should be a whole number." };
  }

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        createTender(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            title,
            issuingBody,
            opportunitySourceId,
            submissionDeadline,
            decisionDate: calendarDate(text(formData, "decisionDate")),
            budgetCycle: text(formData, "budgetCycle") || undefined,
            portalReference: text(formData, "portalReference") || undefined,
            scopeOfWork: text(formData, "scopeOfWork") || undefined,
            ...(bidValueMinor === undefined ? {} : { bidValueMinor }),
            ...(competitorsKnown === undefined ? {} : { competitorsKnown }),
            competitorNotes: text(formData, "competitorNotes") || undefined,
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "The tender could not be recorded.", "tenders") };
  }

  revalidatePath("/tenders");
  return { ok: `${title} is in the queue, sorted by how long is left.` };
}

export async function saveTenderDetail(
  _prev: TenderFormState,
  formData: FormData,
): Promise<TenderFormState> {
  const session = await requireSessionWith("contracts:write");

  const tenderId = text(formData, "tenderId");
  if (!tenderId) return { error: "That tender could not be identified." };

  const bidValueMinor = minorUnits(text(formData, "bidValue"));
  if (bidValueMinor === null) return { error: "The bid value should be a number, like 312000.00." };

  const deadline = text(formData, "submissionDeadline");
  if (deadline && !calendarDate(deadline)) return { error: "The deadline is not a calendar date." };

  const competitorsRaw = text(formData, "competitorsKnown");

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      async (tx) => {
        await updateTender(tx, tenderId, {
          title: text(formData, "title") || undefined,
          issuingBody: text(formData, "issuingBody") || undefined,
          ...(deadline ? { submissionDeadline: deadline } : {}),
          decisionDate: calendarDate(text(formData, "decisionDate")) ?? null,
          budgetCycle: text(formData, "budgetCycle") || null,
          portalReference: text(formData, "portalReference") || null,
          scopeOfWork: text(formData, "scopeOfWork") || null,
          competitorNotes: text(formData, "competitorNotes") || null,
          // An empty field means "unknown" and is stored as null. Storing it as
          // zero would say nobody else is bidding, which is a different and
          // much more confident claim than the operator made.
          competitorsKnown: competitorsRaw ? Number(competitorsRaw) : null,
          ...(bidValueMinor === undefined ? {} : { bidValueMinor }),
        });

        // The scope is a list read off the issuer's document, so it is replaced
        // rather than added to — a building the issuer dropped must stop being
        // priced in the pack.
        const propertyIds = formData.getAll("propertyIds").map((v) => String(v)).filter(Boolean);
        await setTenderProperties(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          tenderId,
          propertyIds,
        );
      },
    );
  } catch (error) {
    return { error: userMessage(error, "The tender could not be saved.", "tenders") };
  }

  revalidatePath(`/tenders/${tenderId}`);
  revalidatePath("/tenders");
  return { ok: "Saved." };
}

/** The bid went in. A fact with a date, deliberately not an outcome. */
export async function submitTender(
  _prev: TenderFormState,
  formData: FormData,
): Promise<TenderFormState> {
  const session = await requireSessionWith("contracts:write");

  const tenderId = text(formData, "tenderId");
  const submittedOn = text(formData, "submittedOn");
  if (!tenderId) return { error: "That tender could not be identified." };
  if (!calendarDate(submittedOn)) return { error: "Say which day the bid went in." };

  const bidValueMinor = minorUnits(text(formData, "bidValue"));
  if (bidValueMinor === null) return { error: "The bid value should be a number, like 312000.00." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        markTenderSubmitted(tx, tenderId, {
          submittedOn,
          ...(bidValueMinor === undefined ? {} : { bidValueMinor }),
        }),
    );
  } catch (error) {
    return { error: userMessage(error, "The submission could not be recorded.", "tenders") };
  }

  revalidatePath(`/tenders/${tenderId}`);
  revalidatePath("/tenders");
  return { ok: "Recorded as submitted. It stays in the queue until the issuer decides." };
}

/** `CON-11`: outcome **and** reason. */
export async function closeTender(
  _prev: TenderFormState,
  formData: FormData,
): Promise<TenderFormState> {
  const session = await requireSessionWith("contracts:write");

  const tenderId = text(formData, "tenderId");
  const outcome = text(formData, "outcome");
  if (!tenderId) return { error: "That tender could not be identified." };
  if (!(TENDER_OUTCOMES as readonly string[]).includes(outcome)) {
    return { error: "Choose what happened to the bid." };
  }

  const reasonId = text(formData, "reasonId");

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        recordTenderOutcome(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            tenderId,
            outcome: outcome as TenderOutcome,
            ...(reasonId ? { reasonId } : {}),
            note: text(formData, "note") || undefined,
            decidedOn: calendarDate(text(formData, "decidedOn")),
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "The outcome could not be recorded.", "tenders") };
  }

  revalidatePath(`/tenders/${tenderId}`);
  revalidatePath("/tenders");
  return { ok: "Recorded. It leaves the open queue and stays in the history." };
}
