import { check, equal, deepEqual, done } from "./_harness";
import { EMPTY_MATERIAL_ENTRY, isValidQuantity, validateMaterialEntry } from "../src/domain/material-entry";
import { appendMaterial } from "../src/sync/payloads";
import { isKnownMutationKind, mutationKind } from "../src/sync/protocol";

// ── Quantity parsing ─────────────────────────────────────────────────────────

check("a positive integer is valid", isValidQuantity("3"));
check("a positive decimal is valid", isValidQuantity("2.5"));
check("whitespace-padded is valid", isValidQuantity("  4  "));
check("zero is not valid", !isValidQuantity("0"));
check("a negative number is not valid", !isValidQuantity("-1"));
check("empty text is not valid", !isValidQuantity(""));
check("whitespace-only text is not valid", !isValidQuantity("   "));
check("non-numeric text is not valid", !isValidQuantity("two"));
check("Infinity is not valid", !isValidQuantity("Infinity"));

// ── Full entry validation ────────────────────────────────────────────────────

const blank = validateMaterialEntry(EMPTY_MATERIAL_ENTRY);
check("a blank draft is rejected", !blank.ok);
if (!blank.ok) {
  deepEqual("a blank draft is missing description and source", [...blank.errors].sort(), [
    "description_required",
    "source_required",
  ]);
}

const noSource = validateMaterialEntry({ ...EMPTY_MATERIAL_ENTRY, description: "Contactor", source: null });
check("no source chosen is rejected", !noSource.ok);
if (!noSource.ok) deepEqual("missing exactly source_required", [...noSource.errors], ["source_required"]);

const badQuantity = validateMaterialEntry({
  ...EMPTY_MATERIAL_ENTRY,
  description: "Contactor",
  quantity: "0",
  source: "van_stock",
});
check("a zero quantity is rejected", !badQuantity.ok);

const valid = validateMaterialEntry({
  sku: "  ",
  description: "  25A contactor  ",
  quantity: "2",
  unit: "  ",
  source: "purchased",
  serialNumber: "  SN-42  ",
});
check("a fully filled-in entry is accepted", valid.ok);
if (valid.ok) {
  equal("description is trimmed", valid.value.description, "25A contactor");
  equal("an all-whitespace unit falls back to 'ea'", valid.value.unit, "ea");
  equal("an all-whitespace sku becomes null, not empty string", valid.value.sku, null);
  equal("serial number is trimmed", valid.value.serialNumber, "SN-42");
  equal("source passes through", valid.value.source, "purchased");
}

// ── What it feeds into is a real, recognised mutation ───────────────────────

if (valid.ok) {
  const spec = appendMaterial({
    jobId: "job-1",
    description: valid.value.description,
    quantity: valid.value.quantity,
    unit: valid.value.unit,
    source: valid.value.source,
    sku: valid.value.sku,
    serialNumber: valid.value.serialNumber,
  });
  check(
    "the built mutation is job_material/append, which the server accepts",
    isKnownMutationKind(spec.entity, spec.op) && mutationKind(spec.entity, spec.op) === "job_material/append",
  );
  equal("no baseVersion on an append-only mutation", spec.baseVersion, null);
  deepEqual("payload carries the validated fields", spec.payload, {
    jobId: "job-1",
    description: "25A contactor",
    quantity: "2",
    unit: "ea",
    source: "purchased",
    serialNumber: "SN-42",
  });
}

done("material-entry");
