/**
 * What "Scan or add a part" has to be sure of before it builds a mutation
 * (`FLD-9`).
 *
 * `sync/payloads.ts`'s `appendMaterial` composes the wire payload and trusts
 * its caller for shape; `recordJobMaterial` on the server is where "greater
 * than zero" and "a real `MaterialSource`" are actually enforced. This module
 * is the screen's own check, so a technician who mistypes a quantity finds out
 * before the mutation is queued rather than finding out as a `dead` outbox row
 * hours later - the same reasoning `appendMaterial`'s own doc comment gives for
 * typed builders in general, one layer up.
 *
 * ── WHY THIS IS NOT A BARCODE SCANNER ───────────────────────────────────────
 *
 * `FLD-5`/`FLD-9` allow "scan or add a part", and `expo-camera`'s `CameraView`
 * does support barcode scanning. It is not built here: the parts catalogue
 * `working-set.ts` and `packages/db/src/domain/field.ts` both describe as
 * `notYetAvailable` (`FIELD_WORKING_SET_NOT_YET_AVAILABLE`) means there is no
 * SKU table on the device for a scanned barcode to resolve against - a scanner
 * that reads a code and hands the technician back the digits it read, with
 * nothing to look them up in, is a control that performs scanning without
 * performing lookup. Typed entry, with the SKU field left free-text and
 * `needsOfficeReconciliation` set exactly as `MaterialLine` already documents,
 * is the honest version of this control until the catalogue exists.
 */

import { isMaterialSource, type MaterialSource } from "@meridian/core";

export interface MaterialEntryDraft {
  readonly sku: string;
  readonly description: string;
  /** Free text as typed; validated as a positive decimal below. */
  readonly quantity: string;
  readonly unit: string;
  readonly source: MaterialSource | null;
  readonly serialNumber: string;
}

export const EMPTY_MATERIAL_ENTRY: MaterialEntryDraft = {
  sku: "",
  description: "",
  quantity: "1",
  unit: "ea",
  source: null,
  serialNumber: "",
};

export type MaterialEntryError = "description_required" | "quantity_invalid" | "source_required";

export const MATERIAL_ENTRY_ERROR_MESSAGE: Readonly<Record<MaterialEntryError, string>> = {
  description_required: "Say what the part is.",
  quantity_invalid: "Enter a quantity greater than zero.",
  source_required: "Say where the part came from.",
};

export interface ValidMaterialEntry {
  readonly description: string;
  readonly quantity: string;
  readonly unit: string;
  readonly source: MaterialSource;
  readonly sku: string | null;
  readonly serialNumber: string | null;
}

export type MaterialEntryResult =
  | { readonly ok: true; readonly value: ValidMaterialEntry }
  | { readonly ok: false; readonly errors: readonly MaterialEntryError[] };

/**
 * A quantity is a positive, finite decimal string - `numeric(12,3)` on the
 * server, so this only needs to catch what would otherwise reach it as
 * garbage: empty input, non-numeric text, zero, or negative.
 */
export function isValidQuantity(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0;
}

export function validateMaterialEntry(draft: MaterialEntryDraft): MaterialEntryResult {
  const errors: MaterialEntryError[] = [];

  const description = draft.description.trim();
  if (!description) errors.push("description_required");

  if (!isValidQuantity(draft.quantity)) errors.push("quantity_invalid");

  if (draft.source === null || !isMaterialSource(draft.source)) errors.push("source_required");

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      description,
      quantity: draft.quantity.trim(),
      unit: draft.unit.trim() || "ea",
      // Safe: validated above, and TypeScript cannot see through the push()
      // into `errors` that guarantees it.
      source: draft.source as MaterialSource,
      sku: draft.sku.trim() || null,
      serialNumber: draft.serialNumber.trim() || null,
    },
  };
}
