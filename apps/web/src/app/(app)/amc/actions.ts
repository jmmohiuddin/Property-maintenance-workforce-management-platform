"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  activateContract,
  attachContractDocument,
  createContract,
  generateRenewalQuote,
  type EntitlementInput,
} from "@meridian/db";
import {
  BILLING_FREQUENCIES,
  CONTRACT_DOCUMENT_KINDS,
  COVERAGE_TYPES,
  STANDARD_AMC_EXCLUSIONS,
  getService,
  type BillingFrequency,
  type ContractDocumentKind,
  type CoverageType,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

/**
 * Writes for the contracts module (`CON-1`…`CON-10`).
 *
 * Every one of these re-checks `contracts:write` on the server. The pages hide
 * the forms from a role that only has `contracts:read` — a dispatcher, an
 * accountant — but hiding a form is not authorisation, and a `curl` with a
 * session cookie never renders the page at all.
 */

export interface ContractFormState {
  error?: string;
  ok?: string;
}

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/**
 * A calendar day from `<input type="date">`, as an instant at Dubai midnight.
 *
 * Contract terms are `timestamptz` on an existing table, so unlike the employee
 * document register these cannot stay strings. The conversion is pinned to
 * Dubai (+04:00) rather than left to the server's zone: a term entered as
 * 1 January that lands as 31 December on a server running in UTC-5 is a
 * contract that generates its first visit inside the previous year.
 */
function dubaiMidnight(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00+04:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Entitlements arrive as parallel `service[]` / `visits[]` fields.
 *
 * The alternative — a JSON blob in a hidden input — needs JavaScript to build,
 * and this form has to work on a site-office connection with scripting off for
 * the same reason the employment register does.
 */
function readEntitlements(formData: FormData): EntitlementInput[] | null {
  const slugs = formData.getAll("entitlementService").map((v) => String(v).trim());
  const counts = formData.getAll("entitlementVisits").map((v) => String(v).trim());

  const out: EntitlementInput[] = [];
  for (let i = 0; i < slugs.length; i++) {
    const slug = slugs[i];
    if (!slug) continue;

    const service = getService(slug);
    // A slug that is not in the catalogue would produce visits nothing can
    // price, dispatch or report on. Refuse rather than store it.
    if (!service) return null;

    const visits = Number(counts[i] ?? "0");
    if (!Number.isInteger(visits) || visits < 1 || visits > 52) return null;

    out.push({ serviceSlug: slug, label: service.name, visitsPerYear: visits });
  }

  return out;
}

export async function createContractAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const session = await requireSessionWith("contracts:write");

  const name = text(formData, "name");
  const customerId = text(formData, "customerId");
  const coverageType = text(formData, "coverageType") as CoverageType;
  const billingFrequency = text(formData, "billingFrequency") as BillingFrequency;
  const annualValue = text(formData, "annualValue");
  const startsOn = dubaiMidnight(text(formData, "startsOn"));
  const endsOn = dubaiMidnight(text(formData, "endsOn"));
  const propertyIds = formData.getAll("propertyId").map((v) => String(v).trim()).filter(Boolean);
  const discountPercent = Number(text(formData, "discountPercent") || "15");
  const calloutsRaw = text(formData, "calloutsPerYear");

  if (name.length < 2) return { error: "Give the contract a name." };
  if (!customerId) return { error: "Choose the customer this contract is with." };
  if (!COVERAGE_TYPES.includes(coverageType)) return { error: "Choose a contract type." };
  if (!BILLING_FREQUENCIES.includes(billingFrequency)) {
    return { error: "Choose a billing frequency." };
  }
  if (!startsOn || !endsOn) return { error: "Enter a valid start and end date." };
  if (endsOn <= startsOn) return { error: "The contract must end after it starts." };
  if (!/^\d+(\.\d{1,2})?$/.test(annualValue)) {
    return { error: "Enter the annual value as a number, e.g. 42000.00" };
  }
  if (propertyIds.length === 0) {
    return { error: "A contract covers at least one property. Choose the properties it covers." };
  }
  if (!Number.isFinite(discountPercent) || discountPercent < 0 || discountPercent >= 100) {
    return { error: "The out-of-scope discount must be between 0 and 99 percent." };
  }

  const entitlements = readEntitlements(formData);
  if (entitlements === null) {
    return {
      error:
        "Check the entitlements: each one needs a catalogue service and between 1 and 52 visits " +
        "a year.",
    };
  }
  if (entitlements.length === 0) {
    return {
      error:
        "A contract needs at least one entitlement. Without one it generates no visits, and a " +
        "maintenance contract that generates no visits is an invoice with no work behind it.",
    };
  }

  // Standard exclusions unless the operator has unticked them. Ticked by
  // default because the seven in `STANDARD_AMC_EXCLUSIONS` are what every
  // comprehensive AMC in this market carves out — a contract that omits them is
  // not generous, it is mispriced.
  const exclusionCodes = formData
    .getAll("exclusionCode")
    .map((v) => String(v).trim())
    .filter((code) => STANDARD_AMC_EXCLUSIONS.some((e) => e.code === code));

  const callouts = calloutsRaw === "" ? null : Number(calloutsRaw);
  if (callouts !== null && (!Number.isInteger(callouts) || callouts < 0)) {
    return { error: "Callouts per year must be a whole number, or blank for unlimited." };
  }

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        createContract(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            customerId,
            name,
            coverageType,
            startsOn,
            endsOn,
            annualValue,
            billingFrequency,
            discountRateBasisPoints: Math.round(discountPercent * 100),
            calloutsPerYear: callouts,
            propertyIds,
            entitlements,
            exclusionCodes,
          },
        ),
    );

    revalidatePath("/amc");
    return {
      ok:
        `Contract ${result.reference} created as a draft. Activate it to generate the PPM ` +
        "schedule for the full term.",
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The contract could not be created. Check the dates and the customer, and try again.",
        "contracts:create",
      ),
    };
  }
}

/**
 * Activate the contract and generate its schedule (`CON-1`, `CON-3`).
 *
 * The two are one action on purpose. A contract marked active with no planned
 * visits looks correct on every screen and produces no work, and nobody would
 * notice until an OA management company asked for a PPM completion report.
 */
export async function activateContractAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const session = await requireSessionWith("contracts:write");
  const contractId = text(formData, "contractId");
  if (!contractId) return { error: "Which contract?" };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        activateContract(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          contractId,
        ),
    );

    revalidatePath(`/amc/${contractId}`);
    revalidatePath("/amc");

    const unplaced =
      result.unplaced.length > 0
        ? ` ${result.unplaced.length} could not be placed inside the term: ${result.unplaced.join("; ")}`
        : "";

    return {
      ok:
        `Active. ${result.created} planned visit(s) generated` +
        (result.skippedExisting > 0 ? `, ${result.skippedExisting} already existed` : "") +
        `.${unplaced}`,
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The schedule could not be generated. Check the contract term and its entitlements.",
        "contracts:activate",
      ),
    };
  }
}

/** `CON-8`. One click, prefilled from actuals rather than from memory. */
export async function generateRenewalQuoteAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const session = await requireSessionWith("contracts:write");
  const contractId = text(formData, "contractId");
  if (!contractId) return { error: "Which contract?" };

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        generateRenewalQuote(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          contractId,
        ),
    );

    revalidatePath(`/amc/${contractId}`);
    revalidatePath("/amc");

    return {
      ok:
        `Draft quotation ${result.reference} created from the contract's own value and ` +
        "utilisation. Review the price before sending it — nothing has been sent to the customer.",
    };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The renewal quote could not be drafted. Open the contract and try again.",
        "contracts:renew",
      ),
    };
  }
}

/** `CON-10`. Versioned, never overwritten — see `attachContractDocument`. */
export async function attachContractDocumentAction(
  _prev: ContractFormState,
  formData: FormData,
): Promise<ContractFormState> {
  const session = await requireSessionWith("contracts:write");

  const contractId = text(formData, "contractId");
  const kind = text(formData, "kind") as ContractDocumentKind;
  const title = text(formData, "title");
  const storageKey = text(formData, "storageKey");

  if (!contractId) return { error: "Which contract?" };
  if (!CONTRACT_DOCUMENT_KINDS.includes(kind)) return { error: "Choose a document type." };
  if (title.length < 2) return { error: "Give the document a title." };
  if (storageKey.length < 2) {
    return {
      error:
        "Enter the storage key for the file. Direct upload from this screen is not built yet — " +
        "the key is recorded so the document is findable, and nothing here pretends the file was " +
        "received.",
    };
  }

  try {
    const result = await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId },
      (tx) =>
        attachContractDocument(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          { contractId, kind, title, storageKey },
        ),
    );

    revalidatePath(`/amc/${contractId}`);
    return { ok: `Attached as version ${result.version}. Earlier versions are kept.` };
  } catch (error) {
    return {
      error: userMessage(
        error,
        "The document could not be attached.",
        "contracts:attach-document",
      ),
    };
  }
}
