"use server";

import { revalidatePath } from "next/cache";
import {
  withTenant,
  updateCustomerTerms,
  addContact,
  removeContact,
  addProperty,
  setPortalAccess,
  writeAuditNote,
} from "@meridian/db";
import { PROPERTY_TYPE_LABEL, absoluteUrl, type PropertyType } from "@meridian/core";
import { inviteStaff, INVITE_TTL_MS } from "@meridian/auth";
import { enqueue, dispatchPending, selectTransport } from "@meridian/notify";
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

// ── Portal access (POR-8) ────────────────────────────────────────────────────

/**
 * Grant portal access to a customer contact.
 *
 * `POR-8`. Granting, revoking and re-inviting portal access previously required
 * SQL, which meant in practice it never happened — and a portal built to
 * deflect phone calls was reachable by almost nobody. `G9` targets 60% of
 * customer interactions moving into the portal by month six, which is
 * unreachable if getting an account into somebody's hands is an engineering
 * ticket.
 *
 * The invitation carries the customer id, so acceptance produces a `customer`
 * membership scoped to exactly this customer. Both halves matter: the role
 * keeps them out of the staff application, and the customer id is what
 * `withCustomerScope()` sets so the RESTRICTIVE policies narrow every query.
 * That scoping is enforced in the database, not here — which is why a portal
 * user cannot see another customer's invoices even if this code were wrong.
 */
export async function grantPortalAccess(
  _prev: CustomerState,
  formData: FormData,
): Promise<CustomerState> {
  const session = await requireSessionWith("customers:write");

  const customerId = String(formData.get("customerId") ?? "");
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("fullName") ?? "").trim();

  if (!customerId) return { error: "No customer selected." };
  if (!email || !email.includes("@")) return { error: "Enter a valid email address." };
  if (!fullName) return { error: "Enter their name — it appears on the invitation." };

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      const issued = await inviteStaff(tx, ctx, {
        email,
        fullName,
        role: "customer",
        customerId,
      });

      await writeAuditNote(tx, ctx, {
        tableName: "user_invitations",
        recordId: customerId,
        action: "grant_portal_access",
        detail: { email, customerId, grantedBy: session.user.email },
      });

      // Enqueued in the same transaction as the invitation, so an email cannot
      // promise access that rolled back.
      await enqueue(tx, ctx, {
        channel: "email",
        template: "staff_invitation",
        to: email,
        payload: {
          fullName,
          inviterName: session.user.fullName,
          roleLabel: "customer portal access",
          acceptUrl: absoluteUrl(`/invite/${issued.token}`),
          expiresInDays: Math.round(INVITE_TTL_MS / 86_400_000),
        },
      });
    });

    await dispatchPending(session.principal.tenantId, { transport: selectTransport() });
  } catch (error) {
    return { error: userMessage(error, "Could not send that invitation.") };
  }

  revalidatePath(`/customers/${customerId}`);
  return { ok: `Portal invitation sent to ${email}.` };
}

/** Turn portal access on or off for somebody who already has an account. */
export async function togglePortalAccess(
  _prev: CustomerState,
  formData: FormData,
): Promise<CustomerState> {
  const session = await requireSessionWith("customers:write");

  const customerId = String(formData.get("customerId") ?? "");
  const userId = String(formData.get("userId") ?? "");
  const isActive = String(formData.get("isActive") ?? "") === "true";

  if (!customerId || !userId) return { error: "No portal user selected." };

  try {
    const ctx = {
      tenantId: session.principal.tenantId,
      userId: session.principal.userId,
      actorKind: "user" as const,
    };

    await withTenant(ctx, async (tx) => {
      await setPortalAccess(tx, ctx, { userId, customerId, isActive });
      await writeAuditNote(tx, ctx, {
        tableName: "memberships",
        recordId: userId,
        action: isActive ? "portal_access_restored" : "portal_access_revoked",
        detail: { customerId, changedBy: session.user.email },
      });
    });
  } catch (error) {
    return { error: userMessage(error, "Could not change that access.") };
  }

  revalidatePath(`/customers/${customerId}`);
  return {
    ok: isActive
      ? "Portal access restored."
      : "Portal access revoked and every session signed out.",
  };
}
