"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@meridian/db";
import {
  addAssetCategory,
  addDispositionReason,
  addFaultCode,
  addJobOutcomeCode,
  addPhotoExemptionReason,
  addRateVersion,
  endRate,
  installStandardAssetCategories,
  installStandardJobOutcomes,
  installStandardPhotoExemptionReasons,
  setAssetCategoryActive,
  setDispositionReasonActive,
  setFaultCodeActive,
  setJobOutcomeActive,
  setPhotoExemptionReasonActive,
  writeAuditNote,
  type DispositionScope,
  type FaultCodeKind,
  type RateBand,
  type RateUnit,
} from "@meridian/db/domain";
import { toMinor, UserFacingError } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import type { ReferenceState } from "./actions";

/**
 * The controlled vocabularies (`ADM-10`).
 *
 * Separate from `./actions.ts`, which owns the calendar. The split is by what
 * breaks if the value is wrong rather than by screen: a wrong working week
 * misplaces a visit, whereas a wrong disposition list quietly makes a quarter's
 * funnel report meaningless, and the two deserve to be read separately.
 *
 * `settings:write` throughout, so `owner` only. These lists decide what an
 * operator is permitted to say happened; they are not a preference.
 *
 * ── EVERY AUDIT ACTION NAME FITS IN SIXTEEN CHARACTERS ──────────────────────
 *
 * `audit_log.action` is `varchar(16)`, and the audit insert runs inside the
 * same transaction as the change it records. So a name one character too long
 * does not quietly lose an audit entry — it rolls the edit back and tells the
 * operator their taxonomy change could not be saved, with the real reason only
 * in the server log. Found exactly that way.
 */

function fail(message: string): ReferenceState {
  return { error: message };
}


/**
 * A machine key, from whatever was typed.
 *
 * Codes are what reports group on, so they have to be stable and comparable —
 * "Too expensive", "too expensive " and "Too Expensive" must not become three
 * categories the first time three different people add the same reason.
 */
function normaliseCode(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function context() {
  const session = await requireSessionWith("settings:write");
  return {
    session,
    ctx: {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    },
  };
}

// ── Lead disposition reasons (LEAD-6) ───────────────────────────────────────

export async function addDisposition(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const label = String(formData.get("label") ?? "").trim();
  const rawCode = String(formData.get("code") ?? "").trim();
  const appliesTo = String(formData.get("appliesTo") ?? "both");
  const guidance = String(formData.get("guidance") ?? "").trim() || null;
  const sortOrder = Number(String(formData.get("sortOrder") ?? "100"));

  if (!label) return fail("Name the reason as an operator would say it out loud.");
  if (appliesTo !== "lost" && appliesTo !== "dormant" && appliesTo !== "both") {
    return fail("Choose whether this reason applies to lost, dormant, or both.");
  }

  // Derived from the label when nobody supplies one, which is the normal case.
  // The code only has to be stable, and asking every operator to invent one is
  // how the field ends up holding the label again.
  const code = normaliseCode(rawCode || label);
  if (!code) return fail("That name has no letters or numbers in it to build a code from.");

  try {
    await withTenant(ctx, async (tx) => {
      await addDispositionReason(tx, ctx, {
        code,
        label,
        appliesTo: appliesTo as DispositionScope,
        guidance,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "lead_disposition_reasons",
        action: "reason_set",
        detail: { code, label, appliesTo, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] add disposition reason failed", error);
    return fail("Could not save that reason.");
  }

  revalidatePath("/admin/reference/dispositions");
  revalidatePath("/leads");
  return { success: `“${label}” is now on the list, as ${code}.` };
}

export async function toggleDisposition(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that reason");
  // The button posts the state it wants, not a toggle. A toggle computed from
  // what the page was showing does the wrong thing when two tabs are open.
  const activate = String(formData.get("activate") ?? "") === "true";
  if (!id) return fail("No reason selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await setDispositionReasonActive(tx, id, activate);
      await writeAuditNote(tx, ctx, {
        tableName: "lead_disposition_reasons",
        recordId: id,
        action: activate ? "reason_restored" : "reason_retired",
        detail: { reason: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] toggle disposition reason failed", error);
    return fail("Could not change that reason.");
  }

  revalidatePath("/admin/reference/dispositions");
  revalidatePath("/leads");
  return {
    success: activate
      ? `“${label}” is back on the list.`
      : `“${label}” is retired. Leads already closed with it keep it.`,
  };
}

// ── Fault codes (JOB-14) ────────────────────────────────────────────────────

export async function addFault(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const kind = String(formData.get("kind") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const rawCode = String(formData.get("code") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const serviceSlug = String(formData.get("serviceSlug") ?? "").trim() || null;
  const sortOrder = Number(String(formData.get("sortOrder") ?? "100"));

  if (kind !== "symptom" && kind !== "cause" && kind !== "remedy") {
    return fail("Choose symptom, cause or remedy.");
  }
  if (!label) return fail("Name the code in the words a technician would use on site.");

  const code = normaliseCode(rawCode || label);
  if (!code) return fail("That name has no letters or numbers in it to build a code from.");

  try {
    await withTenant(ctx, async (tx) => {
      await addFaultCode(tx, ctx, {
        kind: kind as FaultCodeKind,
        code,
        label,
        description,
        serviceSlug,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "fault_codes",
        action: "fault_set",
        detail: { kind, code, label, serviceSlug, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] add fault code failed", error);
    return fail("Could not save that code.");
  }

  revalidatePath("/admin/reference/fault-codes");
  return { success: `${kind} “${label}” saved as ${code}.` };
}

export async function toggleFault(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that code");
  const activate = String(formData.get("activate") ?? "") === "true";
  if (!id) return fail("No code selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await setFaultCodeActive(tx, id, activate);
      await writeAuditNote(tx, ctx, {
        tableName: "fault_codes",
        recordId: id,
        action: activate ? "fault_restored" : "fault_retired",
        detail: { code: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] toggle fault code failed", error);
    return fail("Could not change that code.");
  }

  revalidatePath("/admin/reference/fault-codes");
  return { success: activate ? `“${label}” is back in use.` : `“${label}” is retired.` };
}

// ── Job outcome codes (JOB-13) ──────────────────────────────────────────────

export async function installOutcomes(
  _prev: ReferenceState,
  _formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  let added = 0;
  try {
    await withTenant(ctx, async (tx) => {
      added = await installStandardJobOutcomes(tx, ctx);
      await writeAuditNote(tx, ctx, {
        tableName: "job_outcome_codes",
        action: "outcomes_added",
        detail: { added, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] install standard outcomes failed", error);
    return fail("Could not add the standard outcomes.");
  }

  revalidatePath("/admin/reference/outcomes");
  return {
    success:
      added === 0
        ? "Every standard outcome was already here. Nothing was changed or overwritten."
        : `${added} standard ${added === 1 ? "outcome" : "outcomes"} added. Existing wording was left alone.`,
  };
}

export async function addOutcome(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const label = String(formData.get("label") ?? "").trim();
  const rawCode = String(formData.get("code") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const requiresReturnVisit = formData.get("requiresReturnVisit") === "on";
  const sortOrder = Number(String(formData.get("sortOrder") ?? "100"));

  if (!label) return fail("Name the outcome as a technician would report it.");
  const code = normaliseCode(rawCode || label).slice(0, 32);
  if (!code) return fail("That name has no letters or numbers in it to build a code from.");

  try {
    await withTenant(ctx, async (tx) => {
      await addJobOutcomeCode(tx, ctx, {
        code,
        label,
        description,
        // An outcome that owes a return visit has not ended the job, and the
        // two answers are never independent — asking twice would only create
        // the chance of a contradiction.
        isTerminal: !requiresReturnVisit,
        requiresReturnVisit,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "job_outcome_codes",
        action: "outcome_set",
        detail: { code, label, requiresReturnVisit, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] add job outcome failed", error);
    return fail("Could not save that outcome.");
  }

  revalidatePath("/admin/reference/outcomes");
  return { success: `“${label}” saved as ${code}.` };
}

export async function toggleOutcome(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that outcome");
  const activate = String(formData.get("activate") ?? "") === "true";
  if (!id) return fail("No outcome selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await setJobOutcomeActive(tx, id, activate);
      await writeAuditNote(tx, ctx, {
        tableName: "job_outcome_codes",
        recordId: id,
        action: activate ? "outcome_restored" : "outcome_retired",
        detail: { outcome: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] toggle job outcome failed", error);
    return fail("Could not change that outcome.");
  }

  revalidatePath("/admin/reference/outcomes");
  return { success: activate ? `“${label}” is back in use.` : `“${label}” is retired.` };
}

// ── Asset kinds (CON-13) ────────────────────────────────────────────────────

/**
 * The asset register's vocabulary.
 *
 * The list this maintains is the one the AMC price and the tender answer are
 * grouped by — "how many chillers are we contracted to maintain" is a count of
 * rows carrying one of these kinds. Until this screen existed the list was
 * whatever the migration seeded, which meant the first cooling tower somebody
 * had to record went in as a pump, and that is worse than free text: it is
 * wrong and it looks governed.
 */
export async function installAssetKinds(
  _prev: ReferenceState,
  _formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  let added = 0;
  try {
    await withTenant(ctx, async (tx) => {
      added = await installStandardAssetCategories(tx, ctx);
      await writeAuditNote(tx, ctx, {
        tableName: "asset_categories",
        action: "kinds_added",
        detail: { added, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] install standard asset kinds failed", error);
    return fail("Could not add the standard asset kinds.");
  }

  revalidatePath("/admin/reference/asset-kinds");
  return {
    success:
      added === 0
        ? "Every standard kind was already here. Nothing was changed or overwritten."
        : `${added} standard ${added === 1 ? "kind" : "kinds"} added. Existing wording was left alone.`,
  };
}

export async function addAssetKind(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const label = String(formData.get("label") ?? "").trim();
  const rawCode = String(formData.get("code") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const serviceSlug = String(formData.get("serviceSlug") ?? "").trim() || null;
  const rawInterval = String(formData.get("defaultPpmIntervalDays") ?? "").trim();
  const sortOrder = Number(String(formData.get("sortOrder") ?? "100"));

  if (!label) return fail("Name the kind as a technician would say it on site.");

  // `asset_categories.code` is varchar(32), same as the outcome codes.
  const code = normaliseCode(rawCode || label).slice(0, 32);
  if (!code) return fail("That name has no letters or numbers in it to build a code from.");

  let defaultPpmIntervalDays: number | null = null;
  if (rawInterval) {
    const parsed = Number(rawInterval);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return fail("A service interval is a whole number of days, such as 90 or 365.");
    }
    defaultPpmIntervalDays = parsed;
  }

  try {
    await withTenant(ctx, async (tx) => {
      await addAssetCategory(tx, ctx, {
        code,
        label,
        description,
        serviceSlug,
        defaultPpmIntervalDays,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "asset_categories",
        action: "kind_set",
        detail: { code, label, serviceSlug, defaultPpmIntervalDays, changedBy: session.user.email },
      });
    });
  } catch (error) {
    if (error instanceof UserFacingError) return fail(error.message);
    console.error("[admin] add asset kind failed", error);
    return fail("Could not save that kind.");
  }

  revalidatePath("/admin/reference/asset-kinds");
  return { success: `“${label}” saved as ${code}.` };
}

export async function toggleAssetKind(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that kind");
  const activate = String(formData.get("activate") ?? "") === "true";
  if (!id) return fail("No kind selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await setAssetCategoryActive(tx, id, activate);
      await writeAuditNote(tx, ctx, {
        tableName: "asset_categories",
        recordId: id,
        action: activate ? "kind_restored" : "kind_retired",
        detail: { kind: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] toggle asset kind failed", error);
    return fail("Could not change that kind.");
  }

  revalidatePath("/admin/reference/asset-kinds");
  return {
    success: activate
      ? `“${label}” is back on the list.`
      : `“${label}” is retired. Plant already registered under it keeps it.`,
  };
}

// ── Rate card (QTE-4) ───────────────────────────────────────────────────────

/**
 * "1,250.50" → 125050 fils, or null.
 *
 * Parsed through `toMinor`, which never puts the value through a float. A price
 * that arrives a fil out of a form is a quotation an accountant will not sign
 * off, and this is the only place in the screen where a decimal exists at all.
 */
function priceToMinor(value: string): number | null {
  const cleaned = value.trim().replace(/,/g, "");
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(cleaned)) return null;
  return toMinor(cleaned);
}

export async function addRate(_prev: ReferenceState, formData: FormData): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const label = String(formData.get("label") ?? "").trim();
  const rawCode = String(formData.get("code") ?? "").trim();
  const serviceSlug = String(formData.get("serviceSlug") ?? "").trim();
  const unit = String(formData.get("unit") ?? "");
  const rateBand = String(formData.get("rateBand") ?? "standard");
  const price = String(formData.get("unitPrice") ?? "");
  const minQuantity = String(formData.get("minQuantity") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const isPublished = formData.get("isPublished") === "on";
  const effectiveFrom = String(formData.get("effectiveFrom") ?? "").trim();

  if (!label) return fail("Name the line as it should read on a quotation.");
  if (!serviceSlug) return fail("Pick the service this rate belongs to.");
  if (!unit) return fail("Pick a unit.");
  if (!ISO_DATE.test(effectiveFrom)) return fail("Pick the date this price starts.");

  const unitPriceMinor = priceToMinor(price);
  if (unitPriceMinor === null) {
    return fail("Enter the price in dirhams and fils, such as 250 or 250.50.");
  }
  if (minQuantity !== null && !/^\d{1,8}(\.\d{1,3})?$/.test(minQuantity)) {
    return fail("A minimum quantity is a number, such as 1 or 2.5.");
  }

  const code = normaliseCode(rawCode || `${serviceSlug}-${label}`);
  if (!code) return fail("That name has no letters or numbers in it to build a code from.");

  try {
    await withTenant(ctx, async (tx) => {
      await addRateVersion(tx, ctx, {
        code,
        serviceSlug,
        label,
        unit: unit as RateUnit,
        rateBand: rateBand as RateBand,
        unitPriceMinor,
        minQuantity,
        notes,
        isPublished,
        effectiveFrom,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "rate_card_items",
        action: "rate_added",
        detail: {
          code,
          rateBand,
          unitPriceMinor,
          effectiveFrom,
          isPublished,
          changedBy: session.user.email,
        },
      });
    });
  } catch (error) {
    // A `UserFacingError` here is the backdating refusal, and it names dates the
    // operator can act on. Anything else is ours and stays in the log.
    if (error instanceof UserFacingError) return fail(error.message);
    console.error("[admin] add rate failed", error);
    return fail("Could not save that price.");
  }

  revalidatePath("/admin/reference/rate-card");
  return {
    success: `“${label}” priced from ${effectiveFrom}. The previous price now ends on that date and stays readable.`,
  };
}

export async function stopRate(_prev: ReferenceState, formData: FormData): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const code = String(formData.get("code") ?? "");
  const rateBand = String(formData.get("rateBand") ?? "standard");
  const label = String(formData.get("label") ?? "that rate");
  const endsOn = String(formData.get("endsOn") ?? "").trim();

  if (!code) return fail("No rate selected.");
  if (!ISO_DATE.test(endsOn)) return fail("Pick the date this rate stops applying.");

  try {
    await withTenant(ctx, async (tx) => {
      await endRate(tx, code, rateBand as RateBand, endsOn);
      await writeAuditNote(tx, ctx, {
        tableName: "rate_card_items",
        action: "rate_ended",
        detail: { code, rateBand, endsOn, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] end rate failed", error);
    return fail("Could not end that rate.");
  }

  revalidatePath("/admin/reference/rate-card");
  return {
    success: `“${label}” stops applying on ${endsOn}. Quotations issued before then still show what they were priced from.`,
  };
}

// ── Photo exemption reasons (JOB-15) ────────────────────────────────────────

export async function installPhotoExemptions(
  _prev: ReferenceState,
  _formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  let added = 0;
  try {
    await withTenant(ctx, async (tx) => {
      added = await installStandardPhotoExemptionReasons(tx, ctx);
      await writeAuditNote(tx, ctx, {
        tableName: "job_photo_exemption_reasons",
        // 13 characters. See the note at the top of this file.
        action: "exempts_added",
        detail: { added, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] install standard photo exemption reasons failed", error);
    return fail("Could not add the standard reasons.");
  }

  revalidatePath("/admin/reference/photo-exemptions");
  return {
    success:
      added === 0
        ? "Every standard reason was already here. Nothing was changed or overwritten."
        : `${added} standard ${added === 1 ? "reason" : "reasons"} added. Existing wording was left alone.`,
  };
}

export async function addPhotoExemption(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();

  const label = String(formData.get("label") ?? "").trim();
  const rawCode = String(formData.get("code") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const sortOrder = Number(String(formData.get("sortOrder") ?? "100"));

  if (!label) return fail("Name the reason as a technician would give it.");
  const code = normaliseCode(rawCode || label);
  if (!code) return fail("That name has no letters or numbers in it to build a code from.");

  try {
    await withTenant(ctx, async (tx) => {
      await addPhotoExemptionReason(tx, ctx, {
        code,
        label,
        description,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 100,
      });
      await writeAuditNote(tx, ctx, {
        tableName: "job_photo_exemption_reasons",
        // 10 characters.
        action: "exempt_set",
        detail: { code, label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] add photo exemption reason failed", error);
    return fail("Could not save that reason.");
  }

  revalidatePath("/admin/reference/photo-exemptions");
  return { success: `“${label}” saved as ${code}.` };
}

export async function togglePhotoExemption(
  _prev: ReferenceState,
  formData: FormData,
): Promise<ReferenceState> {
  const { session, ctx } = await context();
  const id = String(formData.get("id") ?? "");
  const label = String(formData.get("label") ?? "that reason");
  const activate = String(formData.get("activate") ?? "") === "true";
  if (!id) return fail("No reason selected.");

  try {
    await withTenant(ctx, async (tx) => {
      await setPhotoExemptionReasonActive(tx, id, activate);
      await writeAuditNote(tx, ctx, {
        tableName: "job_photo_exemption_reasons",
        recordId: id,
        // 15 and 14 characters.
        action: activate ? "exempt_restored" : "exempt_retired",
        detail: { reason: label, changedBy: session.user.email },
      });
    });
  } catch (error) {
    console.error("[admin] toggle photo exemption reason failed", error);
    return fail("Could not change that reason.");
  }

  revalidatePath("/admin/reference/photo-exemptions");
  return {
    success: activate
      ? `“${label}” is back in the picker.`
      : `“${label}” is retired. Every job already exempted for it still shows it.`,
  };
}
