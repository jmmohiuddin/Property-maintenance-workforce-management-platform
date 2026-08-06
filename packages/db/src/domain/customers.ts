import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import * as schema from "../schema";
import { toMinor, UserFacingError, type PropertyType } from "@meridian/core";

export { PROPERTY_TYPE_LABEL, type PropertyType } from "@meridian/core";
import type { TenantScopedTx, TenantContext } from "../index";

/**
 * The customer account, as operations and accounts need to see it.
 *
 * Everything about a customer already exists somewhere in this system — jobs
 * under properties, quotes and invoices under the customer, contacts beside
 * them. What did not exist was one place to answer the question a manager
 * actually asks before a call: *how is this account doing?* That means work in
 * flight and money outstanding on the same screen, because those two facts
 * together are what decides whether the next job gets scheduled or held.
 */

export interface CustomerRow {
  id: string;
  code: string;
  name: string;
  isCompany: boolean;
  industry: string | null;
  billingEmail: string | null;
  phone: string | null;
  paymentTermsDays: number;
  currency: string;
  isActive: boolean;
  accountManagerId: string | null;
  accountManagerName: string | null;
  propertyCount: number;
  openJobs: number;
  /** Minor units. Issued and part-paid invoices, never written-off ones. */
  outstandingMinor: number;
  /** Minor units of the outstanding balance that is past its due date. */
  overdueMinor: number;
}

/** Statuses that mean "work we still owe this customer". */
const OPEN_JOB_STATUSES = [
  "submitted",
  "triaged",
  "scheduled",
  "dispatched",
  "en_route",
  "on_site",
  "paused",
  "work_complete",
] as const;

export async function listCustomers(
  tx: TenantScopedTx,
  opts: { includeInactive?: boolean; now?: Date } = {},
): Promise<CustomerRow[]> {
  const now = opts.now ?? new Date();

  const rows = await tx
    .select({
      id: schema.customers.id,
      code: schema.customers.code,
      name: schema.customers.name,
      isCompany: schema.customers.isCompany,
      industry: schema.customers.industry,
      billingEmail: schema.customers.billingEmail,
      phone: schema.customers.phone,
      paymentTermsDays: schema.customers.paymentTermsDays,
      currency: schema.customers.currency,
      isActive: schema.customers.isActive,
      accountManagerId: schema.customers.accountManagerId,
      accountManagerName: schema.users.fullName,
    })
    .from(schema.customers)
    .leftJoin(schema.users, eq(schema.users.id, schema.customers.accountManagerId))
    .where(
      opts.includeInactive
        ? isNull(schema.customers.deletedAt)
        : and(isNull(schema.customers.deletedAt), eq(schema.customers.isActive, true)),
    )
    .orderBy(asc(schema.customers.name));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);

  const [properties, jobs, invoices] = await Promise.all([
    tx
      .select({
        customerId: schema.properties.customerId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.properties)
      .where(and(inArray(schema.properties.customerId, ids), isNull(schema.properties.deletedAt)))
      .groupBy(schema.properties.customerId),
    tx
      .select({
        customerId: schema.jobs.customerId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.jobs)
      .where(
        and(
          inArray(schema.jobs.customerId, ids),
          inArray(schema.jobs.status, [...OPEN_JOB_STATUSES]),
          isNull(schema.jobs.deletedAt),
        ),
      )
      .groupBy(schema.jobs.customerId),
    tx
      .select({
        customerId: schema.invoices.customerId,
        total: schema.invoices.total,
        amountPaid: schema.invoices.amountPaid,
        dueOn: schema.invoices.dueOn,
      })
      .from(schema.invoices)
      .where(
        and(
          inArray(schema.invoices.customerId, ids),
          // Written-off debt is not outstanding: showing it would make every
          // ageing figure disagree with the ledger it came from.
          inArray(schema.invoices.status, ["issued", "part_paid", "overdue"]),
          isNull(schema.invoices.deletedAt),
        ),
      ),
  ]);

  const propertyBy = new Map(properties.map((p) => [p.customerId, p.count]));
  const jobBy = new Map(jobs.map((j) => [j.customerId, j.count]));

  const outstandingBy = new Map<string, { outstanding: number; overdue: number }>();
  for (const inv of invoices) {
    // Integer minor units throughout: a balance summed from floats drifts, and
    // this number is read next to the ledger.
    const balance = toMinor(inv.total) - toMinor(inv.amountPaid);
    if (balance <= 0) continue;
    const entry = outstandingBy.get(inv.customerId) ?? { outstanding: 0, overdue: 0 };
    entry.outstanding += balance;
    if (inv.dueOn && inv.dueOn < now) entry.overdue += balance;
    outstandingBy.set(inv.customerId, entry);
  }

  return rows.map((r) => ({
    ...r,
    propertyCount: propertyBy.get(r.id) ?? 0,
    openJobs: jobBy.get(r.id) ?? 0,
    outstandingMinor: outstandingBy.get(r.id)?.outstanding ?? 0,
    overdueMinor: outstandingBy.get(r.id)?.overdue ?? 0,
  }));
}

export interface CustomerDetail {
  customer: CustomerRow & {
    taxRegistrationNumber: string | null;
    creditLimit: string | null;
    notes: string | null;
    createdAt: Date;
  };
  contacts: {
    id: string;
    fullName: string;
    role: string | null;
    email: string | null;
    phone: string | null;
    isPrimary: boolean;
    notifyOnJobs: boolean;
  }[];
  properties: {
    id: string;
    name: string;
    type: string;
    area: string | null;
    city: string;
    floors: number | null;
    unitCount: number | null;
    isActive: boolean;
    openJobs: number;
  }[];
  recentJobs: {
    id: string;
    reference: string;
    title: string;
    status: string;
    priority: string;
    serviceSlug: string;
    propertyName: string;
    createdAt: Date;
  }[];
  /** Portal users who can sign in against this account. */
  portalUsers: { id: string; fullName: string; email: string; lastLoginAt: Date | null }[];
}

export async function getCustomer(
  tx: TenantScopedTx,
  customerId: string,
  now = new Date(),
): Promise<CustomerDetail | null> {
  const summary = (await listCustomers(tx, { includeInactive: true, now })).find(
    (c) => c.id === customerId,
  );
  if (!summary) return null;

  const [extra] = await tx
    .select({
      taxRegistrationNumber: schema.customers.taxRegistrationNumber,
      creditLimit: schema.customers.creditLimit,
      notes: schema.customers.notes,
      createdAt: schema.customers.createdAt,
    })
    .from(schema.customers)
    .where(eq(schema.customers.id, customerId))
    .limit(1);

  if (!extra) return null;

  const [contacts, properties, recentJobs, portalUsers] = await Promise.all([
    tx
      .select({
        id: schema.customerContacts.id,
        fullName: schema.customerContacts.fullName,
        role: schema.customerContacts.role,
        email: schema.customerContacts.email,
        phone: schema.customerContacts.phone,
        isPrimary: schema.customerContacts.isPrimary,
        notifyOnJobs: schema.customerContacts.notifyOnJobs,
      })
      .from(schema.customerContacts)
      .where(eq(schema.customerContacts.customerId, customerId))
      .orderBy(desc(schema.customerContacts.isPrimary), asc(schema.customerContacts.fullName)),
    tx
      .select({
        id: schema.properties.id,
        name: schema.properties.name,
        type: schema.properties.type,
        area: schema.properties.area,
        city: schema.properties.city,
        floors: schema.properties.floors,
        unitCount: schema.properties.unitCount,
        isActive: schema.properties.isActive,
      })
      .from(schema.properties)
      .where(and(eq(schema.properties.customerId, customerId), isNull(schema.properties.deletedAt)))
      .orderBy(asc(schema.properties.name)),
    tx
      .select({
        id: schema.jobs.id,
        reference: schema.jobs.reference,
        title: schema.jobs.title,
        status: schema.jobs.status,
        priority: schema.jobs.priority,
        serviceSlug: schema.jobs.serviceSlug,
        propertyName: schema.properties.name,
        createdAt: schema.jobs.createdAt,
      })
      .from(schema.jobs)
      .innerJoin(schema.properties, eq(schema.properties.id, schema.jobs.propertyId))
      .where(and(eq(schema.jobs.customerId, customerId), isNull(schema.jobs.deletedAt)))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(15),
    tx
      .select({
        id: schema.users.id,
        fullName: schema.users.fullName,
        email: schema.users.email,
        lastLoginAt: schema.users.lastLoginAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(eq(schema.memberships.customerId, customerId))
      .orderBy(asc(schema.users.fullName)),
  ]);

  const openByProperty = await tx
    .select({
      propertyId: schema.jobs.propertyId,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.jobs)
    .where(
      and(
        eq(schema.jobs.customerId, customerId),
        inArray(schema.jobs.status, [...OPEN_JOB_STATUSES]),
        isNull(schema.jobs.deletedAt),
      ),
    )
    .groupBy(schema.jobs.propertyId);

  const openBy = new Map(openByProperty.map((p) => [p.propertyId, p.count]));

  return {
    customer: { ...summary, ...extra },
    contacts,
    properties: properties.map((p) => ({ ...p, openJobs: openBy.get(p.id) ?? 0 })),
    recentJobs,
    portalUsers,
  };
}

/**
 * Edit the commercial terms of an account.
 *
 * Deliberately narrow: name, code and the customer's own identity are not
 * editable here. Renaming an account that appears on issued invoices is a
 * different operation with different consequences, and quietly allowing it
 * from the same form is how a tax invoice ends up disagreeing with the record
 * it was raised against.
 */
export async function updateCustomerTerms(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    customerId: string;
    billingEmail?: string | undefined;
    phone?: string | undefined;
    paymentTermsDays: number;
    creditLimit?: string | undefined;
    accountManagerId?: string | null | undefined;
    notes?: string | undefined;
  },
): Promise<void> {
  if (!Number.isInteger(input.paymentTermsDays) || input.paymentTermsDays < 0) {
    throw new UserFacingError("Payment terms must be a whole number of days.");
  }
  if (input.paymentTermsDays > 180) {
    throw new UserFacingError(
      "Payment terms above 180 days need a signed contract variation, not a form.",
    );
  }

  const updated = await tx
    .update(schema.customers)
    .set({
      billingEmail: input.billingEmail ?? null,
      phone: input.phone ?? null,
      paymentTermsDays: input.paymentTermsDays,
      creditLimit: input.creditLimit ?? null,
      ...(input.accountManagerId !== undefined ? { accountManagerId: input.accountManagerId } : {}),
      notes: input.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(schema.customers.id, input.customerId))
    .returning({ id: schema.customers.id });

  // Zero rows under RLS means the customer belongs to another tenant, which is
  // indistinguishable from not existing — and should stay that way.
  if (updated.length === 0) throw new UserFacingError("That customer is not on your account.");

  void ctx;
}

export async function addContact(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    customerId: string;
    fullName: string;
    role?: string | undefined;
    email?: string | undefined;
    phone?: string | undefined;
    isPrimary?: boolean;
    notifyOnJobs?: boolean;
  },
): Promise<{ id: string }> {
  if (input.fullName.trim().length < 2) {
    throw new UserFacingError("Give the contact a name.");
  }
  if (!input.email && !input.phone) {
    throw new UserFacingError("A contact needs an email address or a phone number to be useful.");
  }

  // Exactly one primary. Demoting the incumbent in the same transaction means
  // the two writes cannot disagree.
  if (input.isPrimary) {
    await tx
      .update(schema.customerContacts)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(schema.customerContacts.customerId, input.customerId),
          eq(schema.customerContacts.isPrimary, true),
        ),
      );
  }

  const [row] = await tx
    .insert(schema.customerContacts)
    .values({
      tenantId: ctx.tenantId,
      customerId: input.customerId,
      fullName: input.fullName.trim(),
      role: input.role ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      isPrimary: input.isPrimary ?? false,
      notifyOnJobs: input.notifyOnJobs ?? true,
    })
    .returning({ id: schema.customerContacts.id });

  if (!row) throw new UserFacingError("Could not add the contact.");
  return row;
}

export async function removeContact(tx: TenantScopedTx, contactId: string): Promise<void> {
  await tx.delete(schema.customerContacts).where(eq(schema.customerContacts.id, contactId));
}

/**
 * Add a property to an existing account.
 *
 * Coordinates are optional but consequential: without them the dispatch
 * optimiser cannot rank by travel distance and falls back to matching on city,
 * so the screen says so rather than treating them as a nicety.
 */
export async function addProperty(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    customerId: string;
    name: string;
    type: PropertyType;
    addressLine: string;
    area?: string | undefined;
    city: string;
    lat?: number | undefined;
    lng?: number | undefined;
    accessInstructions?: string | undefined;
    floors?: number | undefined;
    unitCount?: number | undefined;
  },
): Promise<{ id: string }> {
  if (input.name.trim().length < 2) throw new UserFacingError("Give the property a name.");
  if (input.addressLine.trim().length < 4) throw new UserFacingError("An address is required.");
  if (input.city.trim().length < 2) throw new UserFacingError("A city is required.");

  if ((input.lat === undefined) !== (input.lng === undefined)) {
    throw new UserFacingError("Give both a latitude and a longitude, or neither.");
  }
  if (input.lat !== undefined && (input.lat < -90 || input.lat > 90)) {
    throw new UserFacingError("Latitude must be between -90 and 90.");
  }
  if (input.lng !== undefined && (input.lng < -180 || input.lng > 180)) {
    throw new UserFacingError("Longitude must be between -180 and 180.");
  }

  const [row] = await tx
    .insert(schema.properties)
    .values({
      tenantId: ctx.tenantId,
      customerId: input.customerId,
      name: input.name.trim(),
      type: input.type,
      addressLine: input.addressLine.trim(),
      area: input.area ?? null,
      city: input.city.trim(),
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      accessInstructions: input.accessInstructions ?? null,
      floors: input.floors ?? null,
      unitCount: input.unitCount ?? null,
    })
    .returning({ id: schema.properties.id });

  if (!row) throw new UserFacingError("Could not add the property.");
  return row;
}

/**
 * Staff who can own an account.
 *
 * Customer-portal users are excluded: they have a membership scoped to a
 * customer, and offering one as an account manager would be offering to make a
 * customer responsible for themselves.
 */
export async function listStaffUsers(
  tx: TenantScopedTx,
): Promise<{ id: string; fullName: string; role: string }[]> {
  return tx
    .select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      role: schema.memberships.role,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(isNull(schema.memberships.customerId), eq(schema.memberships.isActive, true)))
    .orderBy(asc(schema.users.fullName));
}
