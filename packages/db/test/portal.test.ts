/**
 * Customer-portal scoping — integration test against real Postgres.
 *
 * `POR-1`, `POR-3`, `POR-4`, `POR-5`.
 *
 * ── WHAT THIS TEST IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * Not "does the portal show the customer their jobs". The claim that matters,
 * and the only one worth a test, is the NEGATIVE one: customer A must not see
 * customer B's row. A test proving A sees A's own data proves nothing at all —
 * it passes identically against a query with no customer filter, which is
 * precisely the bug being guarded against.
 *
 * Two real defects of this exact shape shipped in this area: `credit_notes` and
 * `credit_note_lines` arrived with no RESTRICTIVE policy, so a portal session
 * could read every customer's credit notes; and a staff download route was
 * nearly gated on permission alone, which a `customer` role holds. Both were
 * caught by reading code. This file is the version that fails loudly instead.
 *
 * So every table the portal can reach is checked twice: once that the owner
 * sees their row, and once that the neighbour does not. The second assertion is
 * the test.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, sql/ applied in README order, and `npm run db:seed`.
 * Creates its own fixtures, prefixed `__PORTALTEST`, and removes them.
 */

import { and, eq, inArray, like, sql } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  listPortalRequests,
  getPortalRequestDetail,
  listPortalInvoices,
  portalStatement,
  getPortalInvoiceRef,
  customerNotificationSettings,
  setCustomerNotificationPreference,
  isCustomerNotificationEnabled,
  customerNotificationRecipients,
  customerAccountName,
  recordSuppressedCustomerNotification,
  pendingCustomerNotifications,
  getQuoteForNotification,
  getInvoiceForNotification,
  schema,
  closeConnection,
  type CustomerNotificationSubjectTable,
} from "../src/index";
import { CUSTOMER_NOTIFICATION_EVENTS, type CustomerNotificationEvent } from "@meridian/core";
import { testTenantId } from "./_tenant";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "__PORTALTEST";

/**
 * Remove every fixture this file creates.
 *
 * Called before the run as well as after it. A test that only tidies up at the
 * end is a test that cannot be run twice after it crashes once — the second
 * attempt fails on a unique constraint, in the fixture setup, with an error
 * that says nothing about the thing being tested. The rule is that a test must
 * not depend on state another test left, and its own previous crash is the
 * case that actually bites.
 *
 * Ids are resolved first and the deletes are keyed on them, rather than every
 * statement carrying its own `like` pattern. One list of ids is one thing to
 * get right; eleven patterns is eleven chances to write one that matches real
 * data.
 */
async function purge(tenantId: string): Promise<void> {
  await withTenant({ tenantId }, async (tx) => {
    const idsOf = async (table: string, column: string) => {
      const rows = (await tx.execute<{ id: string }>(
        sql`select id from ${sql.raw(table)} where ${sql.raw(column)} like ${TAG + "%"}`,
      )) as unknown as { id: string }[];
      return rows.map((r) => r.id);
    };

    const customerIds = await idsOf("customers", "code");
    const jobIds = await idsOf("jobs", "reference");
    const invoiceIds = await idsOf("invoices", "reference");
    const quoteIds = await idsOf("quotes", "reference");

    // Keyed on the subjects rather than on the recipient address, because the
    // suppression rows this file now provokes carry the customer's own billing
    // email — the address the message would have gone to — not a marker.
    const subjectIds = [...jobIds, ...invoiceIds, ...quoteIds];
    if (subjectIds.length > 0) {
      await tx
        .delete(schema.notifications)
        .where(inArray(schema.notifications.subjectId, subjectIds));
    }
    await tx
      .delete(schema.notifications)
      .where(eq(schema.notifications.recipientAddress, "ledger@portaltest.invalid"));

    if (quoteIds.length > 0) {
      await tx.delete(schema.quotes).where(inArray(schema.quotes.id, quoteIds));
    }
    if (jobIds.length > 0) {
      await tx.delete(schema.jobReports).where(inArray(schema.jobReports.jobId, jobIds));
      await tx.delete(schema.jobAttachments).where(inArray(schema.jobAttachments.jobId, jobIds));
      await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.jobId, jobIds));
      await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, jobIds));
    }
    if (invoiceIds.length > 0) {
      await tx.delete(schema.creditNotes).where(inArray(schema.creditNotes.invoiceId, invoiceIds));
      await tx.delete(schema.payments).where(inArray(schema.payments.invoiceId, invoiceIds));
      await tx.delete(schema.invoices).where(inArray(schema.invoices.id, invoiceIds));
    }
    if (jobIds.length > 0) {
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    }
    await tx.delete(schema.leads).where(like(schema.leads.name, `${TAG}%`));

    if (customerIds.length > 0) {
      await tx
        .delete(schema.customerNotificationPreferences)
        .where(inArray(schema.customerNotificationPreferences.customerId, customerIds));
      await tx
        .delete(schema.communications)
        .where(inArray(schema.communications.customerId, customerIds));
      await tx.delete(schema.properties).where(inArray(schema.properties.customerId, customerIds));
      await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    }
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId };

  // Anything a previous crashed run left behind.
  await purge(tenantId);

  // ── Fixtures: two customers in ONE tenant ────────────────────────────────
  //
  // One tenant, deliberately. Cross-tenant isolation is already proven by
  // verify-rls.sql and is a different boundary; the failure this file is about
  // happens entirely inside a single tenant, between two of its customers,
  // where every RLS policy on `tenant_id` passes.
  const ids = await withTenant(ctx, async (tx) => {
    const [customerA] = await tx
      .insert(schema.customers)
      .values({
        tenantId,
        code: `${TAG}-A`,
        name: `${TAG} Alpha Owners Association`,
        phone: "+971501110001",
        billingEmail: "alpha@portaltest.invalid",
      })
      .returning({ id: schema.customers.id });

    const [customerB] = await tx
      .insert(schema.customers)
      .values({
        tenantId,
        code: `${TAG}-B`,
        name: `${TAG} Beta Property Management`,
        phone: "+971502220002",
        billingEmail: "beta@portaltest.invalid",
      })
      .returning({ id: schema.customers.id });

    if (!customerA || !customerB) throw new Error("could not create the fixture customers");

    const property = async (customerId: string, name: string) => {
      const [row] = await tx
        .insert(schema.properties)
        .values({ tenantId, customerId, name, addressLine: "1 Test Street", city: "Dubai" })
        .returning({ id: schema.properties.id });
      if (!row) throw new Error("could not create a fixture property");
      return row.id;
    };

    const propertyA = await property(customerA.id, `${TAG} Alpha Tower`);
    const propertyB = await property(customerB.id, `${TAG} Beta Villas`);

    const job = async (customerId: string, propertyId: string, suffix: string, status: "submitted" | "closed") => {
      const [row] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `${TAG}-J-${suffix}`,
          customerId,
          propertyId,
          serviceSlug: "handyman",
          title: `${TAG} job ${suffix}`,
          status,
          source: "customer_portal",
          completedAt: status === "closed" ? new Date() : null,
        })
        .returning({ id: schema.jobs.id });
      if (!row) throw new Error("could not create a fixture job");

      await tx.insert(schema.jobEvents).values({
        tenantId,
        jobId: row.id,
        fromStatus: null,
        toStatus: status,
        // Deliberately the kind of note that must never reach a customer. The
        // timeline projection is asserted below to exclude it.
        note: "INTERNAL: third callout, check the warranty position before quoting",
        actorKind: "user",
      });

      return row.id;
    };

    const jobA = await job(customerA.id, propertyA, "A1", "submitted");
    const jobAclosed = await job(customerA.id, propertyA, "A2", "closed");
    const jobB = await job(customerB.id, propertyB, "B1", "submitted");

    const invoice = async (
      customerId: string,
      suffix: string,
      status: "draft" | "issued",
      total: string,
    ) => {
      const [row] = await tx
        .insert(schema.invoices)
        .values({
          tenantId,
          reference: `${TAG}-INV-${suffix}`,
          customerId,
          status,
          issuedOn: status === "issued" ? new Date() : null,
          dueOn: status === "issued" ? new Date(Date.now() + 30 * 86_400_000) : null,
          // `invoices_article59_fields` refuses an invoice issued from today
          // onwards without a date of supply and both party names. That check
          // is the point of the tax-invoice work, so the fixture satisfies it
          // rather than working around it.
          supplyDate: new Date().toISOString().slice(0, 10),
          supplierName: `${TAG} Supplier`,
          recipientName: `${TAG} Recipient`,
          subtotal: total,
          total,
        })
        .returning({ id: schema.invoices.id });
      if (!row) throw new Error("could not create a fixture invoice");
      return row.id;
    };

    const invoiceA = await invoice(customerA.id, "A1", "issued", "1000.00");
    // `amount_paid` is the maintained figure every other query in this codebase
    // reads — `recordPayment` writes it alongside the `payments` row. Inserting
    // the payment without it would leave the fixture in a state the application
    // never produces, and the test would then be asserting against a
    // half-recorded payment rather than against the domain.
    await tx
      .update(schema.invoices)
      .set({ amountPaid: "250.00", status: "part_paid" })
      .where(eq(schema.invoices.id, invoiceA));
    const invoiceAdraft = await invoice(customerA.id, "A2", "draft", "500.00");
    const invoiceB = await invoice(customerB.id, "B1", "issued", "7777.00");

    await tx.insert(schema.payments).values({
      tenantId,
      invoiceId: invoiceA,
      amount: "250.00",
      method: "bank_transfer",
      receivedAt: new Date(),
    });

    await tx.insert(schema.creditNotes).values({
      tenantId,
      reference: `${TAG}-CN-A1`,
      invoiceId: invoiceA,
      customerId: customerA.id,
      reason: "correction",
      issuedOn: new Date(),
      subtotal: "100.00",
      total: "100.00",
    });

    // Credit note for B, so the "A cannot see it" assertion has something to
    // fail on. This is the exact table that shipped without a policy.
    await tx.insert(schema.creditNotes).values({
      tenantId,
      reference: `${TAG}-CN-B1`,
      invoiceId: invoiceB,
      customerId: customerB.id,
      reason: "correction",
      issuedOn: new Date(),
      subtotal: "50.00",
      total: "50.00",
    });

    // A technician and a visit for each job, so the new RESTRICTIVE policy on
    // `job_visits` has both a row to show and a row to hide.
    const technicians = await tx
      .select({ id: schema.technicians.id })
      .from(schema.technicians)
      .limit(1);
    const technicianId = technicians[0]?.id ?? null;

    if (technicianId) {
      for (const [jobId, seq] of [
        [jobA, 1],
        [jobB, 1],
      ] as const) {
        await tx.insert(schema.jobVisits).values({
          tenantId,
          jobId,
          technicianId,
          sequence: seq,
          status: "assigned",
          scheduledStart: new Date(Date.now() + 86_400_000),
          scheduledEnd: new Date(Date.now() + 90_000_000),
          assignmentScore: 0.91,
          assignmentReason: "INTERNAL scoring detail",
        });
      }
    }

    await tx.insert(schema.jobAttachments).values([
      { tenantId, jobId: jobA, kind: "photo_after", storageKey: `${TAG}/a.jpg` },
      { tenantId, jobId: jobB, kind: "photo_after", storageKey: `${TAG}/b.jpg` },
    ]);

    await tx.insert(schema.jobReports).values([
      { tenantId, jobId: jobA, workCarriedOut: "Replaced the run capacitor." },
      { tenantId, jobId: jobB, workCarriedOut: "SHOULD NOT BE VISIBLE TO A" },
    ]);

    // An unapproved AI summary on A's own job. The projection must prefer the
    // human-written text over it.
    await tx.insert(schema.jobReports).values({
      tenantId,
      jobId: jobAclosed,
      workCarriedOut: "Cleared the condensate drain.",
      aiSummary: "UNAPPROVED MACHINE TEXT",
    });

    // A lead, so the "portal sessions see no leads" assertion has something to
    // fail on. Asserting zero against an empty table proves nothing.
    await tx.insert(schema.leads).values({
      tenantId,
      name: `${TAG} Someone Else`,
      phone: "+971503330003",
      email: "someone.else@portaltest.invalid",
      stage: "new",
    });

    await tx.insert(schema.communications).values({
      tenantId,
      customerId: customerA.id,
      channel: "call",
      direction: "outbound",
      body: "INTERNAL: chased about the overdue invoice, they were rude",
    });

    // Two contacts on B, one flagged for job notifications and one not. This is
    // what makes the recipient assertions mean anything: with no contacts
    // anywhere, every path falls back to the billing email and the four rules
    // that used to disagree all look identical.
    await tx.insert(schema.customerContacts).values([
      {
        tenantId,
        customerId: customerB.id,
        fullName: `${TAG} Facilities Manager`,
        email: "facilities@portaltest.invalid",
        notifyOnJobs: true,
      },
      {
        tenantId,
        customerId: customerB.id,
        fullName: `${TAG} Accounts Clerk`,
        email: "accounts@portaltest.invalid",
        // Asked not to be told about jobs. The negative that proves the flag is
        // read rather than every contact being swept up.
        notifyOnJobs: false,
      },
    ]);

    // A sent quote each, so `quote_awaiting_decision` — one of the three events
    // the jobs screen also announces immediately — has something real to be
    // routed for. Status `sent` because that is what `sendQuoteAction` leaves
    // behind at the moment it enqueues.
    const quote = async (customerId: string, jobId: string, suffix: string) => {
      const [row] = await tx
        .insert(schema.quotes)
        .values({
          tenantId,
          reference: `${TAG}-Q-${suffix}`,
          customerId,
          jobId,
          title: `${TAG} quotation ${suffix}`,
          status: "sent",
          subtotal: "2000.00",
          total: "2100.00",
          sentAt: new Date(),
          validUntil: new Date(Date.now() + 14 * 86_400_000),
        })
        .returning({ id: schema.quotes.id });
      if (!row) throw new Error("could not create a fixture quote");
      return row.id;
    };

    const quoteA = await quote(customerA.id, jobA, "A1");
    const quoteB = await quote(customerB.id, jobB, "B1");

    return {
      customerA: customerA.id,
      customerB: customerB.id,
      jobA,
      jobAclosed,
      jobB,
      invoiceA,
      invoiceAdraft,
      invoiceB,
      quoteA,
      quoteB,
      technicianId,
    };
  });

  const asA = <T>(fn: Parameters<typeof withCustomerScope<T>>[1]) =>
    withCustomerScope({ tenantId, customerId: ids.customerA }, fn);

  // ═══════════════════════════════════════════════════════════════════════
  // POR-3 — request history and detail
  // ═══════════════════════════════════════════════════════════════════════

  const requests = await asA((tx) => listPortalRequests(tx, { limit: 100 }));
  const mine = requests.filter((r) => r.reference.startsWith(TAG));

  check("A sees both of its own requests", mine.length, 2);
  checkTrue(
    "including the closed one — history, not only open work",
    mine.some((r) => r.status === "closed"),
  );

  // THE NEGATIVE. Without the customer-scope policy this returns B's job too.
  check(
    "A does not see customer B's request",
    mine.filter((r) => r.reference === `${TAG}-J-B1`).length,
    0,
  );

  const detail = await asA((tx) => getPortalRequestDetail(tx, ids.jobA));
  checkTrue("A can open its own request", detail !== null);
  checkTrue(
    "the visit window is on the detail (POR-3)",
    (detail?.visits.length ?? 0) === (ids.technicianId ? 1 : 0),
  );
  checkTrue(
    "the timeline carries no internal note",
    JSON.stringify(detail?.timeline ?? []).includes("INTERNAL") === false,
  );
  checkTrue(
    "an unapproved AI summary is never shown as the work done",
    JSON.stringify(
      (await asA((tx) => getPortalRequestDetail(tx, ids.jobAclosed)))?.workCarriedOut ?? [],
    ).includes("UNAPPROVED") === false,
  );

  // THE NEGATIVE.
  const foreignDetail = await asA((tx) => getPortalRequestDetail(tx, ids.jobB));
  check("A cannot open customer B's request by id", foreignDetail, null);

  // ═══════════════════════════════════════════════════════════════════════
  // POR-4 — invoices, statement, document reference
  // ═══════════════════════════════════════════════════════════════════════

  const invoices = await asA((tx) => listPortalInvoices(tx, { limit: 100 }));
  const myInvoices = invoices.filter((i) => i.reference.startsWith(TAG));

  check("A sees its issued invoice", myInvoices.length, 1);
  check(
    "and not its own draft — a draft has no legal existence",
    myInvoices.filter((i) => i.reference === `${TAG}-INV-A2`).length,
    0,
  );
  // THE NEGATIVE.
  check(
    "A does not see customer B's invoice",
    myInvoices.filter((i) => i.reference === `${TAG}-INV-B1`).length,
    0,
  );

  const invoiceA = myInvoices[0];
  check("the credit note is netted off the outstanding figure", invoiceA?.creditedMinor, 10_000);
  check("outstanding is total less paid less credited", invoiceA?.outstandingMinor, 65_000);

  const refMine = await asA((tx) => getPortalInvoiceRef(tx, ids.invoiceA));
  checkTrue("A can resolve its own invoice for download", refMine !== null);

  const refDraft = await asA((tx) => getPortalInvoiceRef(tx, ids.invoiceAdraft));
  check("a draft is refused even by direct id", refDraft, null);

  // THE NEGATIVE, and the one that matters most: this is the download route.
  const refForeign = await asA((tx) => getPortalInvoiceRef(tx, ids.invoiceB));
  check("A cannot resolve customer B's invoice for download", refForeign, null);

  const statement = await asA((tx) => portalStatement(tx));
  const statementRefs = statement.entries.map((e) => e.reference);
  checkTrue(
    "the statement contains A's invoice, payment and credit note",
    statementRefs.filter((r) => r === `${TAG}-INV-A1`).length === 2 &&
      statementRefs.includes(`${TAG}-CN-A1`),
  );
  // THE NEGATIVE — `credit_notes` is the table that shipped unprotected.
  check(
    "the statement contains nothing of customer B's",
    statementRefs.filter((r) => r === `${TAG}-INV-B1` || r === `${TAG}-CN-B1`).length,
    0,
  );
  // Exact figures, not a self-consistency check. The totals now come from their
  // own aggregate rather than from summing the entry list — which is the whole
  // point, since the entry list is capped — so "the totals agree with the
  // entries" would no longer be testing the thing that can break.
  //
  // Customer A's account: one AED 1,000.00 invoice, one AED 100.00 credit note,
  // one AED 250.00 payment.
  check("the statement's invoiced total", statement.invoicedMinor, 100_000);
  check("its credited total", statement.creditedMinor, 10_000);
  check("its paid total", statement.paidMinor, 25_000);
  check("and the balance that follows", statement.balanceMinor, 65_000);
  check("nothing was truncated at this size", statement.truncated, false);

  // ═══════════════════════════════════════════════════════════════════════
  // The policies themselves, read raw.
  //
  // The queries above go through projections that filter by job id, so they
  // would pass even with no policy at all. These read the tables directly, with
  // no application-level filter, which is exactly what a future careless query
  // will do — and is the only way to prove the RESTRICTIVE policies exist.
  // ═══════════════════════════════════════════════════════════════════════

  const rawCounts = await asA(async (tx) => {
    const one = async (table: string) => {
      const rows = (await tx.execute<{ n: string }>(
        sql`select count(*) as n from ${sql.raw(table)}`,
      )) as unknown as { n: string }[];
      return Number(rows[0]?.n ?? -1);
    };

    return {
      visits: await one("job_visits"),
      attachments: await one("job_attachments"),
      reports: await one("job_reports"),
      leads: await one("leads"),
      communications: await one("communications"),
      creditNotes: await one("credit_notes"),
    };
  });

  // Counted against the tenant total rather than against a constant: the seed
  // and other tests both put rows in these tables, so "A sees fewer than exist"
  // is the assertion that survives a shared database.
  const tenantCounts = await withTenant(ctx, async (tx) => {
    const one = async (table: string) => {
      const rows = (await tx.execute<{ n: string }>(
        sql`select count(*) as n from ${sql.raw(table)}`,
      )) as unknown as { n: string }[];
      return Number(rows[0]?.n ?? -1);
    };
    return {
      visits: await one("job_visits"),
      attachments: await one("job_attachments"),
      reports: await one("job_reports"),
      leads: await one("leads"),
      communications: await one("communications"),
      creditNotes: await one("credit_notes"),
    };
  });

  checkTrue(
    `job_visits: A sees ${rawCounts.visits} of the tenant's ${tenantCounts.visits}`,
    rawCounts.visits < tenantCounts.visits,
  );
  checkTrue(
    `job_attachments: A sees ${rawCounts.attachments} of ${tenantCounts.attachments}`,
    rawCounts.attachments < tenantCounts.attachments,
  );
  checkTrue(
    `job_reports: A sees ${rawCounts.reports} of ${tenantCounts.reports}`,
    rawCounts.reports < tenantCounts.reports,
  );
  checkTrue(
    `credit_notes: A sees ${rawCounts.creditNotes} of ${tenantCounts.creditNotes}`,
    rawCounts.creditNotes < tenantCounts.creditNotes,
  );

  // Staff-only tables are closed outright, not narrowed. `leads` holds other
  // people's enquiries and `communications` holds what staff wrote about this
  // customer; neither has a customer-facing reading.
  check("leads are invisible to a portal session", rawCounts.leads, 0);
  checkTrue("the tenant does have leads to hide", tenantCounts.leads > 0);
  check("communications are invisible to a portal session", rawCounts.communications, 0);
  checkTrue("the tenant does have communications to hide", tenantCounts.communications > 0);

  // ═══════════════════════════════════════════════════════════════════════
  // POR-5 — notification preferences
  // ═══════════════════════════════════════════════════════════════════════

  const defaults = await asA((tx) => customerNotificationSettings(tx, ids.customerA));
  check("every event has a setting", defaults.length, 7);
  checkTrue("and all of them default to on", defaults.every((s) => s.isEnabled));

  await asA((tx) =>
    setCustomerNotificationPreference(
      tx,
      { tenantId, customerId: ids.customerA },
      { event: "technician_en_route", isEnabled: false },
    ),
  );

  const afterOptOut = await asA((tx) => customerNotificationSettings(tx, ids.customerA));
  check(
    "the opt-out is recorded",
    afterOptOut.find((s) => s.event === "technician_en_route")?.isEnabled,
    false,
  );
  check(
    "and nothing else moved",
    afterOptOut.filter((s) => !s.isEnabled).length,
    1,
  );

  // Idempotent: a second toggle must update the row rather than insert a
  // second contradictory one.
  await asA((tx) =>
    setCustomerNotificationPreference(
      tx,
      { tenantId, customerId: ids.customerA },
      { event: "technician_en_route", isEnabled: true },
    ),
  );
  const prefRows = await withTenant(ctx, (tx) =>
    tx
      .select({ id: schema.customerNotificationPreferences.id })
      .from(schema.customerNotificationPreferences)
      .where(eq(schema.customerNotificationPreferences.customerId, ids.customerA)),
  );
  check("toggling twice leaves one row, not two", prefRows.length, 1);

  // THE NEGATIVE. A tampered customerId must be refused by the policy's WITH
  // CHECK, not by application code — there is none to refuse it.
  let writeRefused = false;
  try {
    await asA((tx) =>
      setCustomerNotificationPreference(
        tx,
        { tenantId, customerId: ids.customerB },
        { event: "invoice_issued", isEnabled: false },
      ),
    );
  } catch {
    writeRefused = true;
  }
  checkTrue("A cannot write a preference for customer B", writeRefused);

  const leakedPref = await withTenant(ctx, (tx) =>
    tx
      .select({ id: schema.customerNotificationPreferences.id })
      .from(schema.customerNotificationPreferences)
      .where(eq(schema.customerNotificationPreferences.customerId, ids.customerB)),
  );
  check("and no row for B was written", leakedPref.length, 0);

  // ═══════════════════════════════════════════════════════════════════════
  // POR-5 — the opt-out and the recipient rule, on BOTH paths
  // ═══════════════════════════════════════════════════════════════════════
  //
  // WHY THIS BLOCK EXISTS. The opt-out was enforced in the sweep's SQL and only
  // there, and the only test was a sweep test, so it passed while three of the
  // seven events — request received, quote sent, invoice issued — went out from
  // server actions that never read the preferences at all. Worse than
  // redundant: the ledger row the immediate send wrote made the subject look
  // settled, so the sweep never revisited it. An opted-out customer received
  // every invoice email, permanently, and every test was green.
  //
  // The same three actions each had their own recipient rule too — billing
  // email from the quote and invoice detail reads, the logged-in user's address
  // from the portal form — while the sweep resolved the contacts flagged
  // `notify_on_jobs`. Same class of defect, quieter.
  //
  // WHAT CAN AND CANNOT BE ASSERTED HERE. `sendCustomerNotification` and the
  // three server actions are `apps/web` code: "server-only", above this package
  // in the dependency graph, and with no test runner of their own. This file
  // cannot import them and does not pretend to. What it asserts is every piece
  // they are now built from — the row-level opt-out check, the shared recipient
  // resolution, the customer id the actions feed into the check, and the fact
  // that the sweep's set-based filter and the row-level check give the same
  // answer. The gap that remains is the wiring itself, and it is stated plainly
  // rather than papered over.

  // ── The row-level check the immediate sends call ─────────────────────────
  const enabled = (customerId: string, event: CustomerNotificationEvent) =>
    withTenant(ctx, (tx) => isCustomerNotificationEnabled(tx, customerId, event));

  /** Ledger rows for a subject. What went out, and what deliberately did not. */
  const ledgerFor = (template: string, subjectId: string) =>
    withTenant(ctx, (tx) =>
      tx
        .select({ status: schema.notifications.status, to: schema.notifications.recipientAddress })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.template, template),
            eq(schema.notifications.subjectId, subjectId),
          ),
        ),
    );

  check(
    "a customer who has never chosen is opted IN, not out",
    await enabled(ids.customerB, "invoice_issued"),
    true,
  );

  await asA((tx) =>
    setCustomerNotificationPreference(
      tx,
      { tenantId, customerId: ids.customerA },
      { event: "invoice_issued", isEnabled: false },
    ),
  );

  check(
    "and the immediate send is told when they have opted out",
    await enabled(ids.customerA, "invoice_issued"),
    false,
  );
  check(
    "one event at a time — muting invoices does not mute quotations",
    await enabled(ids.customerA, "quote_awaiting_decision"),
    true,
  );
  check(
    "nor does it mute the same event for another customer",
    await enabled(ids.customerB, "invoice_issued"),
    true,
  );

  // ── THE ANTI-DRIFT ASSERTION ─────────────────────────────────────────────
  //
  // There are two readers of `customer_notification_preferences`: the muted CTE
  // in `pendingCustomerNotifications`, which is the right shape for a sweep
  // over many customers, and `isCustomerNotificationEnabled`, which is the
  // right shape for one immediate send. Two readers is a standing invitation to
  // disagree, and the thing most likely to make them disagree is the default —
  // absence of a row means opted IN, and the first reader to treat it as "off"
  // silently stops messages nobody asked to stop.
  //
  // So they are pinned to each other, in both directions: for every candidate
  // the sweep returns, its `muted` flag must be exactly the negation of what
  // the row check says. The sweep no longer drops muted rows — it flags them,
  // so that the caller can record the refusal — which is what makes the
  // stronger two-way assertion possible.
  const sweepBefore = await withTenant(ctx, (tx) =>
    pendingCustomerNotifications(tx, { limit: 500 }),
  );

  let drift = 0;
  for (const item of sweepBefore) {
    const rowSays = await enabled(item.customerId, item.event);
    if (item.muted === rowSays) drift++;
  }
  check("the sweep's flag and the row check never disagree", drift, 0);
  checkTrue(
    "and the sweep is not trivially empty, which would make that vacuous",
    sweepBefore.length > 0,
  );
  // The default, across the whole vocabulary rather than the one event in play.
  // A customer who has never touched the switches must be opted IN to all seven
  // — this is the assertion that catches somebody reading a missing row as off.
  let wrongDefault = 0;
  for (const event of CUSTOMER_NOTIFICATION_EVENTS) {
    if (!(await enabled(ids.customerB, event))) wrongDefault++;
  }
  check("a customer with no preferences is opted in to all seven", wrongDefault, 0);

  checkTrue(
    "A's muted invoice is offered but flagged, not dropped",
    sweepBefore.some(
      (p) => p.customerId === ids.customerA && p.event === "invoice_issued" && p.muted,
    ),
  );
  checkTrue(
    "while B's, which nobody muted, is offered unflagged",
    sweepBefore.some(
      (p) => p.customerId === ids.customerB && p.event === "invoice_issued" && !p.muted,
    ),
  );

  // ── THE RECIPIENT RULE, WHICH ALL FOUR PATHS NOW SHARE ───────────────────
  //
  // The quote and invoice actions emailed `customers.billing_email` straight
  // from their detail reads, so this contact — flagged to be notified — was
  // told about B's quotes by the cron sweep and never by the jobs screen that
  // sent them. That is the bug the shared function closes.
  const recipientsOf = async (customerId: string) =>
    (await withTenant(ctx, (tx) => customerNotificationRecipients(tx, [customerId]))).get(
      customerId,
    ) ?? [];

  const forBeta = await recipientsOf(ids.customerB);
  check("a notify-flagged contact is a recipient", forBeta.length, 1);
  check(
    "and it is the flagged one, not the account's billing address",
    forBeta[0]?.email,
    "facilities@portaltest.invalid",
  );
  checkTrue(
    "the contact who asked not to be notified is not one",
    forBeta.every((r) => r.email !== "accounts@portaltest.invalid"),
  );

  const forAlpha = await recipientsOf(ids.customerA);
  check(
    "an account with no contacts at all falls back to its billing email",
    forAlpha[0]?.email,
    "alpha@portaltest.invalid",
  );

  // The sweep resolves the same list, in bulk, through the same function. If
  // these ever diverge the two paths are emailing different people again.
  const sweptForB = sweepBefore.find((p) => p.customerId === ids.customerB);
  if (sweptForB) {
    check(
      "the sweep's bulk resolution matches the single-customer one",
      JSON.stringify(sweptForB.recipients),
      JSON.stringify(forBeta),
    );
  }

  check("and the account name is the account's, not a contact's", await withTenant(ctx, (tx) =>
    customerAccountName(tx, ids.customerB),
  ), `${TAG} Beta Property Management`);

  // ── THE CUSTOMER ID THE ACTIONS FEED INTO THE CHECK ──────────────────────
  //
  // `sendQuoteAction` and `raiseInvoiceAction` hold a quote or invoice id and
  // nothing else; the customer whose preference is consulted comes from these
  // two reads. A wrong id here would check the wrong customer's preference and
  // the opt-out would silently fail — the same defect, one layer down — so it
  // is asserted rather than assumed. Imported from `commerce` deliberately:
  // this is a POR-5 claim about them, not a commerce claim.
  const quoteDetail = await withTenant(ctx, (tx) => getQuoteForNotification(tx, ids.quoteB));
  check(
    "the quote read names the customer the quote belongs to",
    quoteDetail?.customerId,
    ids.customerB,
  );
  const invoiceDetail = await withTenant(ctx, (tx) =>
    getInvoiceForNotification(tx, ids.invoiceA),
  );
  check(
    "and the invoice read names the customer the invoice belongs to",
    invoiceDetail?.customerId,
    ids.customerA,
  );

  // ── A MUTE IS A REFUSAL, NOT A PAUSE ─────────────────────────────────────
  //
  // THE ASSERTION THIS SECTION EXISTS FOR, and it is the one that was decided
  // the other way first and changed on purpose. An event raised while the
  // customer was muted must NEVER be sent, not even if they opt back in the
  // next day.
  //
  // Withholding the message by writing nothing does not achieve that. The sweep
  // works out what is owed by asking what the ledger does not already name, so
  // a message that leaves no trace is merely deferred: it stays owed for the
  // whole lookback window, and lifting the mute on the Friday delivers the
  // week's worth of invoices the customer said no to on the Monday. That burst
  // of back-dated email is precisely the experience that teaches people their
  // preference controls do not work.
  //
  // So a refusal is recorded, and this is what pins it. If anyone flips this
  // back in either direction, these checks fail loudly.
  const suppressAsTheCallerWould = (
    event: CustomerNotificationEvent,
    subjectTable: CustomerNotificationSubjectTable,
    subjectId: string,
    address: string,
  ) =>
    withTenant({ ...ctx, actorKind: "system" }, (tx) =>
      recordSuppressedCustomerNotification(tx, ctx, { event, subjectTable, subjectId, address }),
    );

  await suppressAsTheCallerWould(
    "invoice_issued",
    "invoices",
    ids.invoiceA,
    "alpha@portaltest.invalid",
  );

  const suppression = await ledgerFor("invoice_issued", ids.invoiceA);
  check("withholding a message writes exactly one ledger row", suppression.length, 1);
  check(
    "and it says suppressed — a status the dispatcher never claims",
    suppression[0]?.status,
    "suppressed",
  );
  check(
    "recording the address it would have gone to, so the ledger can answer why",
    suppression[0]?.to,
    "alpha@portaltest.invalid",
  );

  const afterSuppression = await withTenant(ctx, (tx) =>
    pendingCustomerNotifications(tx, { limit: 500 }),
  );
  check(
    "the withheld invoice is no longer offered to the sweep",
    afterSuppression.filter((p) => p.subjectId === ids.invoiceA).length,
    0,
  );

  // THE POINT OF THE WHOLE EXERCISE.
  await asA((tx) =>
    setCustomerNotificationPreference(
      tx,
      { tenantId, customerId: ids.customerA },
      { event: "invoice_issued", isEnabled: true },
    ),
  );
  check(
    "the row check agrees the customer wants invoices again",
    await enabled(ids.customerA, "invoice_issued"),
    true,
  );

  const afterOptingBackIn = await withTenant(ctx, (tx) =>
    pendingCustomerNotifications(tx, { limit: 500 }),
  );
  check(
    "but opting back in does NOT deliver what was withheld while muted",
    afterOptingBackIn.filter((p) => p.subjectId === ids.invoiceA).length,
    0,
  );

  // THE OPPOSITE BUG, WHICH THIS MUST NOT BE. A suppression settles the subject
  // it names and nothing else. B's invoice shares the template and was never
  // muted, so it must still be owed — a marker that quietly swallowed every
  // invoice notification would pass every check above and fail this one.
  checkTrue(
    "a suppression for one subject does not block another under the same template",
    afterOptingBackIn.some((p) => p.subjectId === ids.invoiceB && p.event === "invoice_issued"),
  );
  // And a genuinely new event for the same customer is unaffected: the key is
  // (template, subject), so a different template over the same subject id is a
  // different question. A's invoice is also the subject of its own payment.
  checkTrue(
    "nor a different event about the same customer",
    afterOptingBackIn.some((p) => p.customerId === ids.customerA && p.event !== "invoice_issued"),
  );

  // Idempotent. Two sweeps racing, or a retry, must not stack up markers.
  await suppressAsTheCallerWould(
    "invoice_issued",
    "invoices",
    ids.invoiceA,
    "alpha@portaltest.invalid",
  );
  check(
    "recording the same refusal twice leaves one row, not two",
    (await ledgerFor("invoice_issued", ids.invoiceA)).length,
    1,
  );

  // ── The sweep ────────────────────────────────────────────────────────────
  //
  // Run as the system, inside `withTenant`: it is a tenant-wide job, not a
  // portal read, and it has to see every customer to work at all.
  await asA((tx) =>
    setCustomerNotificationPreference(
      tx,
      { tenantId, customerId: ids.customerA },
      { event: "request_received", isEnabled: false },
    ),
  );

  const pending = await withTenant(ctx, (tx) => pendingCustomerNotifications(tx, { limit: 500 }));
  const forA = pending.filter((p) => p.customerId === ids.customerA);
  const forB = pending.filter((p) => p.customerId === ids.customerB);

  checkTrue("the sweep finds work for both customers", forA.length > 0 && forB.length > 0);
  // Honoured as a flag, not an omission. Every one of A's request candidates
  // comes back muted, which is what lets the caller record the refusal instead
  // of leaving the subject owed and deliverable on the next opt-in.
  const aRequests = forA.filter((p) => p.event === "request_received");
  checkTrue("A has request candidates to rule on at all", aRequests.length > 0);
  check(
    "and every one of them is flagged as A's opt-out",
    aRequests.filter((p) => !p.muted).length,
    0,
  );
  checkTrue(
    "while B, who has not opted out, still gets theirs unflagged",
    forB.some((p) => p.event === "request_received" && !p.muted),
  );
  checkTrue(
    "the recipient resolves to the billing email when there are no contacts",
    forA.every((p) => p.recipients.every((r) => r.email.endsWith("@portaltest.invalid"))),
  );
  // Idempotency. Writing a ledger row for one of them must remove it from the
  // next sweep — this is what stops the customer being emailed twice when the
  // action that caused the change already enqueued its own notification.
  const first = forB[0];
  if (first) {
    await withTenant(ctx, (tx) =>
      tx.insert(schema.notifications).values({
        tenantId,
        channel: "email",
        template: TEMPLATE_FOR[first.event] ?? first.event,
        recipientAddress: "ledger@portaltest.invalid",
        subjectTable: first.subjectTable,
        subjectId: first.subjectId,
        status: "sent",
      }),
    );

    const second = await withTenant(ctx, (tx) => pendingCustomerNotifications(tx, { limit: 500 }));
    check(
      "an event already in the ledger is not queued again",
      second.filter((p) => p.subjectId === first.subjectId && p.event === first.event).length,
      0,
    );
  }

  await purge(tenantId);

  console.log(fail === 0 ? "\nportal: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

/**
 * The template each event is queued under.
 *
 * A copy of the mapping in `apps/web/src/lib/customer-notifications.ts`, and it
 * is a copy on purpose: the test asserts the idempotency key the *application*
 * uses, so importing the application's mapping would make the test agree with
 * itself rather than with the thing it is checking.
 */
const TEMPLATE_FOR: Record<string, string> = {
  request_received: "request_received",
  visit_scheduled: "visit_scheduled",
  technician_en_route: "technician_en_route",
  work_complete: "job_completed",
  quote_awaiting_decision: "quote_sent",
  invoice_issued: "invoice_issued",
  payment_received: "payment_received",
};

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
