"use server";

import { revalidatePath } from "next/cache";
import { withTenant } from "@meridian/db";
import {
  IDENTITY_KEYS,
  loadIdentityOverride,
  saveIdentityOverride,
  syncTenantNames,
  writeAuditNote,
  type IdentityKey,
  type IdentityOverride,
} from "@meridian/db/domain";
import { company, placeholderSignal, type IdentityFieldKind } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";

/**
 * Company identity, edited rather than deployed (`ADM-9`, resolving `TD-9`).
 *
 * `settings:write`, which only the `owner` role holds — see
 * `packages/auth/src/rbac.ts`. These values appear on every quote, every
 * invoice, every contract and the public site footer; the CR number is there
 * because Cabinet Resolution 107/2022 Article 7 requires it to be (`WEB-14`).
 * That is not a field an operations manager should be able to change by
 * accident, and it is not a field anybody should have to open a database client
 * to change either.
 */

export interface CompanyState {
  readonly error?: string;
  readonly success?: string;
}

function fail(message: string): CompanyState {
  return { error: message };
}

/** Blank submits as `null`, which is a deliberate clear rather than "unchanged". */
function field(formData: FormData, key: IdentityKey): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value ? value : null;
}

const LABEL: Readonly<Record<IdentityKey, string>> = {
  legalName: "Legal name",
  tradingName: "Trading name",
  brandName: "Brand name",
  licenceNumber: "Licence number",
  licenceExpiry: "Licence expiry",
  crNumber: "Commercial Register number",
  trn: "TRN",
  addressStreet: "Street address",
  addressCity: "City",
  addressRegion: "Emirate",
  lat: "Latitude",
  lng: "Longitude",
  phone: "Phone",
  emergencyPhone: "Emergency phone",
  whatsapp: "WhatsApp",
  email: "Email",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What kind of value each field holds, so `placeholderSignal` applies the right
 * test to it.
 *
 * The kinds matter because the tests genuinely differ: a registration
 * identifier has a known shape and known worked examples and can be checked
 * structurally, while a phone number cannot be — every digit pattern is
 * somebody's real number, and an established business buys the round one.
 */
const FIELD_KIND: Readonly<Record<IdentityKey, IdentityFieldKind>> = {
  legalName: "text",
  tradingName: "text",
  brandName: "text",
  licenceNumber: "identifier",
  licenceExpiry: "text",
  crNumber: "identifier",
  trn: "identifier",
  addressStreet: "text",
  addressCity: "text",
  addressRegion: "text",
  lat: "text",
  lng: "text",
  phone: "phone",
  emergencyPhone: "phone",
  whatsapp: "phone",
  email: "email",
};

/**
 * Save the identity override.
 *
 * ── WHY THIS REFUSES PLACEHOLDERS OUTRIGHT ──────────────────────────────────
 *
 * `assertPublishableIdentity()` catches placeholder *configuration* at build
 * time, and it exists because the previous build put a licence numbered
 * `DED-000000` on a live site and the audit classified that as a legal
 * exposure. A value typed into this screen would sail past that check on a
 * running deployment — no build happens — so the same test runs here, at the
 * point of entry, against the same graded signal: `certain` refuses, and
 * `suspected` does not. There is no development exemption for `certain`: this
 * screen is for facts, and a developer who needs a stand-in has `COMPANY_*`.
 */
export async function saveIdentity(
  _prev: CompanyState,
  formData: FormData,
): Promise<CompanyState> {
  const session = await requireSessionWith("settings:write");

  const next: Record<string, string | null> = {};
  for (const key of IDENTITY_KEYS) next[key] = field(formData, key);

  const legalName = next["legalName"];
  if (!legalName) {
    return fail("A legal name is required — it appears on every invoice and contract.");
  }

  // Only `certain` refuses the save. A `suspected` signal — a round phone
  // number, say — is reported on the screen by `identityProblems()` for the
  // operator to check, and must never block: refusing to store something true
  // is a worse failure than showing a warning about something that turns out to
  // be fine, and an operator who cannot save their real number has no way past
  // this screen at all.
  for (const key of IDENTITY_KEYS) {
    const value = next[key];
    if (!value) continue;
    if (placeholderSignal(value, FIELD_KIND[key]) === "certain") {
      return fail(
        `"${value}" cannot be a real ${LABEL[key].toLowerCase()}, so nothing was saved. ` +
          `These values are published on the website and on tax documents — leave the field ` +
          `empty until the real value is known. An empty field states nothing; a placeholder states something false.`,
      );
    }
  }

  const expiry = next["licenceExpiry"];
  if (expiry && !ISO_DATE.test(expiry)) {
    return fail("Licence expiry must be a date.");
  }

  // 15 digits, per Article 59 of the VAT Executive Regulations. A TRN of the
  // wrong length on a tax invoice makes the invoice non-compliant (`INV-3`),
  // and the customer's accounts payable is where that gets discovered.
  const trn = next["trn"];
  if (trn && !/^\d{15}$/.test(trn.replace(/\s/g, ""))) {
    return fail("A TRN is 15 digits. Check it against the FTA certificate before saving.");
  }
  if (trn) next["trn"] = trn.replace(/\s/g, "");

  // Range-checked as well as parsed. These two go into `LocalBusiness` JSON-LD
  // and from there into map results; a swapped pair or a stray digit puts the
  // office somewhere nobody can drive to, and nothing downstream would notice.
  for (const [key, limit] of [["lat", 90], ["lng", 180]] as const) {
    const value = next[key];
    if (!value) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) {
      return fail(`${LABEL[key]} must be a number between -${limit} and ${limit}, or empty.`);
    }
  }

  const override = next as IdentityOverride;

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    const changed = await withTenant(ctx, async (tx) => {
      const before = await loadIdentityOverride(tx);

      // Diffed against what is *resolved* today, not against the stored
      // override alone: a field that has always come from `COMPANY_TRN` and is
      // being set to the same string has not changed, and an audit log full of
      // no-op saves is one nobody reads.
      const changes: Record<string, { old: string | null; new: string | null }> = {};
      for (const key of IDENTITY_KEYS) {
        const previous = key in before ? (before[key] ?? null) : resolvedFromConfig(key);
        const value = override[key] ?? null;
        if (previous !== value) changes[key] = { old: previous, new: value };
      }

      if (Object.keys(changes).length === 0) return changes;

      await saveIdentityOverride(tx, ctx, override);
      // The same fallback `applyIdentityOverride` applies, restated rather than
      // guessed: a cleared brand name resolves to the configured one, so the
      // tenant row has to land on that value too or the shell header and this
      // screen would disagree about what the company is called.
      await syncTenantNames(tx, ctx, {
        legalName,
        brandName: override["brandName"] ?? company.brandName,
      });

      await writeAuditNote(tx, ctx, {
        tableName: "tenants",
        recordId: ctx.tenantId,
        action: "identity_update",
        detail: { changed: changes, changedBy: session.user.email },
      });

      return changes;
    });

    if (Object.keys(changed).length === 0) {
      return { success: "Nothing changed, so nothing was saved." };
    }

    revalidatePath("/admin/company");
    const count = Object.keys(changed).length;
    return { success: `Saved. ${count} ${count === 1 ? "field" : "fields"} changed, and the change is in the audit log.` };
  } catch (error) {
    console.error("[admin] company identity save failed", error);
    return fail("Could not save. Nothing was changed.");
  }
}

/**
 * The configured value behind a key, for the audit diff.
 *
 * Reaches into `company` rather than re-reading `process.env`, so the mapping
 * between a form key and its source lives in exactly one place.
 */
function resolvedFromConfig(key: IdentityKey): string | null {
  switch (key) {
    case "legalName":
      return company.legalName;
    case "tradingName":
      return company.tradingName;
    case "brandName":
      return company.brandName;
    case "licenceNumber":
      return company.licenceNumber;
    case "licenceExpiry":
      return company.licenceExpiry;
    case "crNumber":
      return company.crNumber;
    case "trn":
      return company.trn;
    case "addressStreet":
      return company.address.street;
    case "addressCity":
      return company.address.city;
    case "addressRegion":
      return company.address.region;
    case "lat":
      return company.address.lat === null ? null : String(company.address.lat);
    case "lng":
      return company.address.lng === null ? null : String(company.address.lng);
    case "phone":
      return company.phone;
    case "emergencyPhone":
      return company.emergencyPhone;
    case "whatsapp":
      return company.whatsapp;
    case "email":
      return company.email;
  }
}
