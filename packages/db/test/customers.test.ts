/**
 * Customer account integration test.
 *
 * The interesting claims here are arithmetic and boundary ones, not CRUD:
 * outstanding money is summed in integer minor units from the same invoice rows
 * the ledger uses, written-off debt is excluded, overdue is a subset of
 * outstanding, and the terms form cannot be pushed past what a contract allows.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself.
 */

import { eq, inArray } from "drizzle-orm";
import {
  withTenant,
  listCustomers,
  getCustomer,
  listStaffUsers,
  updateCustomerTerms,
  addContact,
  removeContact,
  addProperty,
  createInvoiceFromJob,
  recordPayment,
  schema,
  closeConnection,
} from "../src/index";
import { toMinor, formatMoney } from "@meridian/core";

const TENANT = "11111111-1111-4111-8111-111111111111";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };
  const createdProperties: string[] = [];
  const createdContacts: string[] = [];
  const createdInvoices: string[] = [];

  // ── The roster ───────────────────────────────────────────────────────────
  const customers = await withTenant(ctx, (tx) => listCustomers(tx));
  checkTrue("the tenant has customers", customers.length > 0);
  checkTrue(
    "every account carries its property count",
    customers.every((c) => Number.isInteger(c.propertyCount)),
  );
  checkTrue(
    "overdue is never more than outstanding",
    customers.every((c) => c.overdueMinor <= c.outstandingMinor),
  );

  const subject = customers.find((c) => c.code === "BAYOA");
  if (!subject) throw new Error("Seed data missing. Run `npm run db:seed` first.");

  // ── Outstanding money agrees with the invoice rows it came from ──────────
  const invoiceTruth = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        status: schema.invoices.status,
        total: schema.invoices.total,
        amountPaid: schema.invoices.amountPaid,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.customerId, subject.id));

    return rows
      .filter((r) => ["issued", "part_paid", "overdue"].includes(r.status))
      .reduce((sum, r) => sum + Math.max(0, toMinor(r.total) - toMinor(r.amountPaid)), 0);
  });
  check("outstanding matches the ledger exactly", subject.outstandingMinor, invoiceTruth);

  // ── A payment moves the number, and by the right amount ──────────────────
  const signedOff = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "signed_off"))
      .limit(1);
    return rows[0]?.id ?? null;
  });

  if (signedOff) {
    const invoice = await withTenant(ctx, (tx) =>
      createInvoiceFromJob(tx, ctx, {
        jobId: signedOff,
        lines: [
          { description: "__TEST customer balance line", quantity: "1", unit: "job", unitPrice: "1000" },
        ],
      }),
    );
    createdInvoices.push(invoice.invoiceId);

    const owner = await withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({ customerId: schema.invoices.customerId })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, invoice.invoiceId));
      return rows[0]?.customerId ?? null;
    });

    const before = customers.find((c) => c.id === owner)?.outstandingMinor ?? 0;
    const afterIssue = (await withTenant(ctx, (tx) => listCustomers(tx))).find(
      (c) => c.id === owner,
    );
    check(
      "issuing an invoice raises outstanding by its total",
      (afterIssue?.outstandingMinor ?? 0) - before,
      invoice.totalMinor,
    );

    // Part-pay it: the balance must drop by exactly what was paid, no rounding.
    await withTenant(ctx, (tx) =>
      recordPayment(tx, ctx, { invoiceId: invoice.invoiceId, amount: "500.00", method: "bank_transfer" }),
    );
    const afterPayment = (await withTenant(ctx, (tx) => listCustomers(tx))).find(
      (c) => c.id === owner,
    );
    check(
      "a part payment reduces outstanding by exactly the amount paid",
      (afterIssue?.outstandingMinor ?? 0) - (afterPayment?.outstandingMinor ?? 0),
      50_000,
    );
    check("and the remainder formats exactly", formatMoney(invoice.totalMinor - 50_000), "AED 550.00");
  }

  // ── Detail assembles from the same numbers ───────────────────────────────
  const detail = await withTenant(ctx, (tx) => getCustomer(tx, subject.id));
  checkTrue("detail loads", detail !== null);
  check("detail agrees with the list on property count", detail?.customer.propertyCount, subject.propertyCount);
  checkTrue("detail lists the properties it counted", detail?.properties.length === subject.propertyCount);
  checkTrue(
    "portal users are resolved",
    (detail?.portalUsers ?? []).some((u) => u.email === "fatima@baytower.example"),
  );

  // ── Staff list excludes customer-portal users ────────────────────────────
  const staff = await withTenant(ctx, (tx) => listStaffUsers(tx));
  checkTrue("staff list is not empty", staff.length > 0);
  checkTrue(
    "a customer-portal user is never offered as an account manager",
    !staff.some((s) => s.fullName === "Fatima Suleiman"),
  );

  // ── Terms are bounded ────────────────────────────────────────────────────
  const rejected = await withTenant(ctx, async (tx) => {
    try {
      await updateCustomerTerms(tx, ctx, { customerId: subject.id, paymentTermsDays: 365 });
      return false;
    } catch {
      return true;
    }
  });
  checkTrue("terms beyond 180 days are refused", rejected);

  const negative = await withTenant(ctx, async (tx) => {
    try {
      await updateCustomerTerms(tx, ctx, { customerId: subject.id, paymentTermsDays: -5 });
      return false;
    } catch {
      return true;
    }
  });
  checkTrue("negative terms are refused", negative);

  await withTenant(ctx, (tx) =>
    updateCustomerTerms(tx, ctx, {
      customerId: subject.id,
      paymentTermsDays: 45,
      billingEmail: "accounts@bayoa.example",
    }),
  );
  const reterm = await withTenant(ctx, (tx) => getCustomer(tx, subject.id));
  check("valid terms are saved", reterm?.customer.paymentTermsDays, 45);

  // Restore the seeded value so a later run of another suite is unsurprised.
  await withTenant(ctx, (tx) =>
    updateCustomerTerms(tx, ctx, {
      customerId: subject.id,
      paymentTermsDays: subject.paymentTermsDays,
      billingEmail: subject.billingEmail ?? undefined,
    }),
  );

  // ── Contacts: exactly one primary ────────────────────────────────────────
  const first = await withTenant(ctx, (tx) =>
    addContact(tx, ctx, {
      customerId: subject.id,
      fullName: "__TEST Primary One",
      email: "one@example.invalid",
      isPrimary: true,
    }),
  );
  createdContacts.push(first.id);

  const second = await withTenant(ctx, (tx) =>
    addContact(tx, ctx, {
      customerId: subject.id,
      fullName: "__TEST Primary Two",
      email: "two@example.invalid",
      isPrimary: true,
    }),
  );
  createdContacts.push(second.id);

  const afterContacts = await withTenant(ctx, (tx) => getCustomer(tx, subject.id));
  const primaries = (afterContacts?.contacts ?? []).filter((c) => c.isPrimary);
  check("promoting a second primary demotes the first", primaries.length, 1);
  check("and the newest one holds it", primaries[0]?.fullName, "__TEST Primary Two");

  const noDetails = await withTenant(ctx, async (tx) => {
    try {
      await addContact(tx, ctx, { customerId: subject.id, fullName: "__TEST Unreachable" });
      return false;
    } catch {
      return true;
    }
  });
  checkTrue("a contact with no email and no phone is refused", noDetails);

  // ── Properties: coordinates are all-or-nothing ───────────────────────────
  const halfPosition = await withTenant(ctx, async (tx) => {
    try {
      await addProperty(tx, ctx, {
        customerId: subject.id,
        name: "__TEST Half Position",
        type: "building",
        addressLine: "Somewhere in Dubai",
        city: "Dubai",
        lat: 25.1,
      });
      return false;
    } catch {
      return true;
    }
  });
  checkTrue("a latitude without a longitude is refused", halfPosition);

  const outOfRange = await withTenant(ctx, async (tx) => {
    try {
      await addProperty(tx, ctx, {
        customerId: subject.id,
        name: "__TEST Off World",
        type: "building",
        addressLine: "Somewhere in Dubai",
        city: "Dubai",
        lat: 125,
        lng: 55,
      });
      return false;
    } catch {
      return true;
    }
  });
  checkTrue("an impossible latitude is refused", outOfRange);

  const property = await withTenant(ctx, (tx) =>
    addProperty(tx, ctx, {
      customerId: subject.id,
      name: "__TEST Tower",
      type: "building",
      addressLine: "Plot 1, Business Bay",
      area: "Business Bay",
      city: "Dubai",
      lat: 25.187,
      lng: 55.264,
      floors: 12,
    }),
  );
  createdProperties.push(property.id);

  const afterProperty = await withTenant(ctx, (tx) => getCustomer(tx, subject.id));
  check(
    "adding a property raises the count",
    afterProperty?.customer.propertyCount,
    subject.propertyCount + 1,
  );
  checkTrue(
    "and the new property starts with no open work",
    afterProperty?.properties.find((p) => p.name === "__TEST Tower")?.openJobs === 0,
  );

  // ── Clean-up ─────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    for (const id of createdContacts) await removeContact(tx, id);
    if (createdProperties.length > 0) {
      await tx.delete(schema.properties).where(inArray(schema.properties.id, createdProperties));
    }
    if (createdInvoices.length > 0) {
      await tx.delete(schema.payments).where(inArray(schema.payments.invoiceId, createdInvoices));
      await tx
        .delete(schema.invoiceLines)
        .where(inArray(schema.invoiceLines.invoiceId, createdInvoices));
      await tx.delete(schema.invoices).where(inArray(schema.invoices.id, createdInvoices));
    }
  });

  console.log(fail === 0 ? "\ncustomers: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
