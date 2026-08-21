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

/**
 * Statuses that mean "work we still owe this customer".
 *
 * Exported because the paged customer search in `./leads.ts` counts open jobs
 * against the same definition. Two lists would drift, and the first anybody
 * would hear of it is a customer screen whose open-job count disagrees with the
 * one beside it.
 */
export const OPEN_JOB_STATUSES = [
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

/**
 * The portfolio totals that sit above the customer list (`LEAD-8`, `TD-10`).
 *
 * These used to be `customers.reduce(...)` over the whole list, which is only
 * correct while the screen fetches every customer — the thing that had to stop.
 * Summing the page instead would be worse than removing the figure: "AED 4,200
 * outstanding" that silently means "on this page" is a number somebody will
 * quote to a customer.
 *
 * So the total is a total: one aggregate over the invoice ledger, in integer
 * minor units, independent of how the list beneath it is paged.
 *
 * `overdueAccounts` is capped rather than complete, and the count beside it is
 * the honest one. A banner that names eight accounts is read; a banner that
 * names ninety is scrolled past, and building it would put an unbounded list
 * back on the screen this work exists to bound.
 */
export interface PortfolioTotals {
  readonly customerCount: number;
  readonly outstandingMinor: number;
  readonly overdueMinor: number;
  /** How many accounts are past due, in full. */
  readonly overdueCount: number;
  /** The worst of them, largest first. At most `overdueSample` rows. */
  readonly overdueAccounts: readonly {
    readonly id: string;
    readonly name: string;
    readonly overdueMinor: number;
    readonly currency: string;
  }[];
}

export async function customerPortfolioTotals(
  tx: TenantScopedTx,
  opts: { includeInactive?: boolean; now?: Date; overdueSample?: number } = {},
): Promise<PortfolioTotals> {
  const now = (opts.now ?? new Date()).toISOString();
  const sample = Math.min(Math.max(opts.overdueSample ?? 8, 1), 50);
  const activeOnly = opts.includeInactive ? sql`` : sql`and c.is_active`;

  // One expression, defined once and used three times below. The balance rule
  // is per invoice — an overpaid one is not a credit against the next — and
  // writing it out three times is how the overdue figure stops agreeing with
  // the outstanding one.
  const balance = sql`round(greatest(i.total - i.amount_paid, 0) * 100)`;
  const openInvoice = sql`
    i.deleted_at is null and i.status::text in ('issued', 'part_paid', 'overdue')
  `;

  const [totals] = (await tx.execute<{
    customer_count: number;
    outstanding_minor: string;
    overdue_minor: string;
    overdue_count: number;
  }>(sql`
    with balances as (
      select c.id,
             coalesce(sum(${balance}), 0) as outstanding,
             coalesce(sum(case when i.due_on is not null and i.due_on < ${now}::timestamptz
                               then ${balance} else 0 end), 0) as overdue
        from customers c
        left join invoices i on i.customer_id = c.id and ${openInvoice}
       where c.deleted_at is null
         ${activeOnly}
       group by c.id
    )
    select count(*)::int as customer_count,
           coalesce(sum(outstanding), 0) as outstanding_minor,
           coalesce(sum(overdue), 0) as overdue_minor,
           count(*) filter (where overdue > 0)::int as overdue_count
      from balances
  `)) as unknown as {
    customer_count: number;
    outstanding_minor: string;
    overdue_minor: string;
    overdue_count: number;
  }[];

  const worst = (await tx.execute<{
    id: string;
    name: string;
    currency: string;
    overdue_minor: string;
  }>(sql`
    select c.id, c.name, c.currency,
           sum(case when i.due_on is not null and i.due_on < ${now}::timestamptz
                    then ${balance} else 0 end) as overdue_minor
      from customers c
      join invoices i on i.customer_id = c.id and ${openInvoice}
     where c.deleted_at is null
       ${activeOnly}
     group by c.id, c.name, c.currency
    having sum(case when i.due_on is not null and i.due_on < ${now}::timestamptz
                    then ${balance} else 0 end) > 0
     order by overdue_minor desc
     limit ${sample}
  `)) as unknown as { id: string; name: string; currency: string; overdue_minor: string }[];

  return {
    customerCount: Number(totals?.customer_count ?? 0),
    outstandingMinor: Number(totals?.outstanding_minor ?? 0),
    overdueMinor: Number(totals?.overdue_minor ?? 0),
    overdueCount: Number(totals?.overdue_count ?? 0),
    overdueAccounts: worst.map((r) => ({
      id: r.id,
      name: r.name,
      overdueMinor: Number(r.overdue_minor),
      currency: r.currency,
    })),
  };
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

/**
 * One customer's summary, in one query (`TD-10`).
 *
 * This used to be `listCustomers({ includeInactive: true }).find(...)`: every
 * customer in the tenant, every open job and every unpaid invoice belonging to
 * all of them, read and joined in memory to answer a question about a single
 * account. It is the same unbounded read the customer *list* just shed, and
 * leaving the detail screen carrying it while the list is fixed would be an odd
 * place to stop.
 *
 * The counts and balances are correlated subqueries evaluated for this one row,
 * against the same rules `listCustomers` applies — `greatest(…, 0)` per invoice
 * so an overpayment cannot net off another one, and the same three statuses,
 * because written-off debt is not outstanding. The test asserts the two agree
 * rather than trusting that they do.
 *
 * The columns the list does not carry — TRN, credit limit, notes, created —
 * come back in the same round trip instead of a second one.
 */
async function customerSummary(
  tx: TenantScopedTx,
  customerId: string,
  now: Date,
): Promise<
  | (CustomerRow & {
      taxRegistrationNumber: string | null;
      creditLimit: string | null;
      notes: string | null;
      createdAt: Date;
    })
  | null
> {
  // The balance rule, written once and used twice. Two copies is how the
  // overdue figure stops agreeing with the outstanding one it is part of.
  const openInvoice = sql`
    i.customer_id = ${customerId} and i.deleted_at is null
      and i.status::text in ('issued', 'part_paid', 'overdue')
  `;
  const balance = sql`round(greatest(i.total - i.amount_paid, 0) * 100)`;

  const [row] = await tx
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
      taxRegistrationNumber: schema.customers.taxRegistrationNumber,
      creditLimit: schema.customers.creditLimit,
      notes: schema.customers.notes,
      createdAt: schema.customers.createdAt,
      propertyCount: sql<number>`(
        select count(*)::int from properties p
         where p.customer_id = ${customerId} and p.deleted_at is null)`,
      openJobs: sql<number>`(
        select count(*)::int from jobs j
         where j.customer_id = ${customerId} and j.deleted_at is null
           and j.status::text in (${sql.join(OPEN_JOB_STATUSES.map((s) => sql`${s}`), sql`, `)}))`,
      // Numeric, not cast to int: minor units for a large account can pass what
      // an int4 holds, and the failure mode of that cast is an error mid-page
      // rather than a wrong number. Converted in TypeScript instead.
      outstanding: sql<string>`coalesce((
        select sum(${balance}) from invoices i where ${openInvoice}), 0)`,
      overdue: sql<string>`coalesce((
        select sum(${balance}) from invoices i
         where ${openInvoice} and i.due_on is not null and i.due_on < ${now.toISOString()}), 0)`,
    })
    .from(schema.customers)
    .leftJoin(schema.users, eq(schema.users.id, schema.customers.accountManagerId))
    .where(and(eq(schema.customers.id, customerId), isNull(schema.customers.deletedAt)))
    .limit(1);

  if (!row) return null;

  const { outstanding, overdue, ...rest } = row;
  return {
    ...rest,
    propertyCount: Number(rest.propertyCount),
    openJobs: Number(rest.openJobs),
    outstandingMinor: Number(outstanding),
    overdueMinor: Number(overdue),
  };
}

export async function getCustomer(
  tx: TenantScopedTx,
  customerId: string,
  now = new Date(),
): Promise<CustomerDetail | null> {
  const summary = await customerSummary(tx, customerId, now);
  if (!summary) return null;

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
    customer: summary,
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

// ── Portal access (POR-8) ────────────────────────────────────────────────────

export interface PortalUser {
  readonly userId: string;
  readonly membershipId: string;
  readonly fullName: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly lastLoginAt: Date | null;
  readonly hasPassword: boolean;
}

/**
 * Who can sign in to the portal on this customer's behalf.
 *
 * `POR-8`. Granting, revoking and re-inviting portal access previously required
 * SQL — which meant that in practice it never happened, and the portal that
 * exists to deflect phone calls was reachable by almost nobody.
 *
 * A portal membership is a `customer` role WITH a `customer_id`. Both halves
 * matter: the role keeps them out of the staff application, and the
 * `customer_id` is what `withCustomerScope()` sets so the RESTRICTIVE policies
 * narrow every query to this customer's rows. A `customer` membership with a
 * null `customer_id` would be a portal login scoped to nothing, which
 * `requirePortalSession` refuses rather than rendering an empty portal.
 */
export async function listPortalUsers(
  tx: TenantScopedTx,
  customerId: string,
): Promise<readonly PortalUser[]> {
  const rows = (await tx.execute<{
    user_id: string;
    membership_id: string;
    full_name: string;
    email: string;
    is_active: boolean;
    last_login_at: Date | string | null;
    has_password: boolean;
  }>(sql`
    select u.id as user_id,
           m.id as membership_id,
           u.full_name,
           u.email,
           m.is_active,
           u.last_login_at,
           (u.password_hash is not null) as has_password
      from memberships m
      join users u on u.id = m.user_id
     where m.customer_id = ${customerId}::uuid
       and u.deleted_at is null
     order by u.full_name
  `)) as unknown as {
    user_id: string;
    membership_id: string;
    full_name: string;
    email: string;
    is_active: boolean;
    last_login_at: Date | string | null;
    has_password: boolean;
  }[];

  return rows.map((r) => ({
    userId: r.user_id,
    membershipId: r.membership_id,
    fullName: r.full_name,
    email: r.email,
    isActive: r.is_active,
    lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
    hasPassword: r.has_password,
  }));
}

/**
 * Turn portal access on or off for one person.
 *
 * Revoking deactivates the membership and kills their sessions in the same
 * transaction. Without the second half, somebody whose access is withdrawn at
 * 09:00 keeps reading this customer's invoices until their session expires —
 * which is the entire window a revocation is meant to close.
 *
 * Deactivation rather than deletion, for the same reason as staff: a portal
 * user has approved quotes and raised requests, and those records name them.
 */
export async function setPortalAccess(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { userId: string; customerId: string; isActive: boolean },
): Promise<void> {
  await tx.execute(sql`
    update memberships
       set is_active = ${input.isActive}, updated_at = now()
     where user_id = ${input.userId}::uuid
       and customer_id = ${input.customerId}::uuid
       and tenant_id = ${ctx.tenantId}::uuid
  `);

  if (!input.isActive) {
    await tx.execute(sql`
      update sessions
         set revoked_at = now()
       where user_id = ${input.userId}::uuid
         and tenant_id = ${ctx.tenantId}::uuid
         and revoked_at is null
    `);
  }
}
