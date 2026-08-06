"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  updateCustomerTerms,
  addContact,
  removeContact,
  addProperty,
} from "@meridian/db";
import { PROPERTY_TYPE_LABEL, type PropertyType } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { userMessage } from "@/lib/errors";

export interface CustomerState {
  error?: string;
  ok?: string;
}

/** Derived from the label map, so the two can never drift apart. */
const PROPERTY_TYPES = Object.keys(PROPERTY_TYPE_LABEL) as PropertyType[];

/** An empty numeric field is "not given", which is different from zero. */
function optionalNumber(value: FormDataEntryValue | null): number | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalText(value: FormDataEntryValue | null): string | undefined {
  const raw = String(value ?? "").trim();
  return raw || undefined;
}

export async function saveTerms(
  _prev: CustomerState,
  formData: FormData,
): Promise<CustomerState> {
  const session = await requireSessionWith("customers:write");

  const customerId = String(formData.get("customerId") ?? "");
  if (!customerId) return { error: "Missing customer." };

  const paymentTermsDays = optionalNumber(formData.get("paymentTermsDays"));
  if (paymentTermsDays === undefined) return { error: "Payment terms are required." };

  const accountManagerRaw = String(formData.get("accountManagerId") ?? "");

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        updateCustomerTerms(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            customerId,
            billingEmail: optionalText(formData.get("billingEmail")),
            phone: optionalText(formData.get("phone")),
            paymentTermsDays,
            creditLimit: optionalText(formData.get("creditLimit")),
            // "" means "nobody", which has to be distinguishable from "unchanged".
            accountManagerId: accountManagerRaw === "" ? null : accountManagerRaw,
            notes: optionalText(formData.get("notes")),
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not save the account terms.", "customers") };
  }

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");
  return { ok: "Account terms saved." };
}

export async function createContact(
  _prev: CustomerState,
  formData: FormData,
): Promise<CustomerState> {
  const session = await requireSessionWith("customers:write");

  const customerId = String(formData.get("customerId") ?? "");
  const fullName = String(formData.get("fullName") ?? "").trim();
  if (!customerId) return { error: "Missing customer." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        addContact(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            customerId,
            fullName,
            role: optionalText(formData.get("role")),
            email: optionalText(formData.get("email")),
            phone: optionalText(formData.get("phone")),
            isPrimary: formData.get("isPrimary") === "on",
            notifyOnJobs: formData.get("notifyOnJobs") === "on",
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not add the contact.", "customers") };
  }

  revalidatePath(`/customers/${customerId}`);
  return { ok: `${fullName} added.` };
}

export async function deleteContact(
  _prev: CustomerState,
  formData: FormData,
): Promise<CustomerState> {
  const session = await requireSessionWith("customers:write");

  const contactId = String(formData.get("contactId") ?? "");
  const customerId = String(formData.get("customerId") ?? "");
  if (!contactId) return { error: "Missing contact." };

  await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
    (tx) => removeContact(tx, contactId),
  );

  revalidatePath(`/customers/${customerId}`);
  return { ok: "Contact removed." };
}

export async function createProperty(
  _prev: CustomerState,
  formData: FormData,
): Promise<CustomerState> {
  const session = await requireSessionWith("properties:write");

  const customerId = String(formData.get("customerId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const typeRaw = String(formData.get("type") ?? "apartment");
  const type = (PROPERTY_TYPES as readonly string[]).includes(typeRaw)
    ? (typeRaw as PropertyType)
    : "apartment";

  if (!customerId) return { error: "Missing customer." };

  try {
    await withTenant(
      { tenantId: session.principal.tenantId, userId: session.principal.userId, actorKind: "user" },
      (tx) =>
        addProperty(
          tx,
          { tenantId: session.principal.tenantId, userId: session.principal.userId },
          {
            customerId,
            name,
            type,
            addressLine: String(formData.get("addressLine") ?? ""),
            area: optionalText(formData.get("area")),
            city: String(formData.get("city") ?? ""),
            lat: optionalNumber(formData.get("lat")),
            lng: optionalNumber(formData.get("lng")),
            accessInstructions: optionalText(formData.get("accessInstructions")),
            floors: optionalNumber(formData.get("floors")),
            unitCount: optionalNumber(formData.get("unitCount")),
          },
        ),
    );
  } catch (error) {
    return { error: userMessage(error, "Could not add the property.", "customers") };
  }

  revalidatePath(`/customers/${customerId}`);
  revalidatePath("/customers");
  return { ok: `${name} added.` };
}
