/**
 * `CUST-5` — the monthly property-manager pack. Integration test against real
 * Postgres, run alone:
 *
 *   npx tsx packages/db/test/portal-reports.test.ts
 *
 * ── WHAT THIS FILE IS DEFENDING ─────────────────────────────────────────────
 *
 *  1. **Every figure is a real aggregate, not a capped list's `.length`.**
 *     `outstanding` is seeded with 25 qualifying recommendations against a
 *     page limit of 20, and `total` is asserted to be 25 — the true count —
 *     while `items.length` is asserted to be exactly the 20-row cap. A bug
 *     that summed the shown list would plateau at 20 and this test would
 *     catch it; a suite that only ever seeds fewer rows than the cap could
 *     not.
 *  2. **Dubai's day, not the session's.** Two fixtures sit deliberately on the
 *     UTC/Dubai boundary: a job created at 21:00 UTC on 31 January is 01:00 on
 *     1 February in Dubai and belongs to February; a job closed at 21:30 UTC
 *     on 28 February is 01:30 on 1 March in Dubai and does NOT belong to
 *     February, even though both instants fall on their neighbouring UTC
 *     calendar day. Getting either backwards is exactly the `current_date`
 *     trap the pack is written against. The period itself is computed from a
 *     FIXED instant (`NOW`, `2026-03-15T10:00:00Z`) via the same
 *     `today`/`startOfMonth`/`addMonths` helpers the production code uses,
 *     never from the real wall clock — a fixture built from `current_date`
 *     against a query that reads Dubai's day is flaky for the same reason the
 *     code would be wrong.
 *  3. **The right property manager sees real, hand-computed figures — not
 *     merely that the wrong one sees nothing.** Every section below is
 *     asserted against a number worked out by hand from the fixtures, for
 *     BOTH customers in this tenant. A feature that silently returned an empty
 *     pack for everyone would pass a suite of negatives; it fails this one on
 *     the first positive assertion.
 *  4. **Isolation is proved by amount, not by presence.** Customer B holds its
 *     own contract, job, invoice and job report so that if the new
 *     `contract_visits` policy (or any other) leaked, A's total would be
 *     inflated by B's rows rather than merely "also showing" them — a much
 *     easier bug to hide and the one worth guarding against explicitly.
 *
 * Requires the schema, sql/ applied in README order (this suite is what
 * exercises the new `customer_scope` policy on `contract_visits`), and
 * `npm run db:seed`. Creates its own fixtures, prefixed `__CUSTREPTEST`, and
 * removes them — before the run as well as after, so a previous crash does not
 * poison this one.
 */

import { eq, inArray, like } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  propertyManagerMonthlyPack,
  customersWithMonthlyPack,
  recentlySentMonthlyPack,
  schema,
  closeConnection,
} from "../src/index";
import { testTenantId } from "./_tenant";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "__CUSTREPTEST";

// A fixed instant, never the real wall clock. Dubai (+4) is therefore
// 2026-03-15 14:00 — unambiguously inside March, nowhere near a month
// boundary, so `propertyManagerMonthlyPack`'s period resolves to February
// 2026 (1 Feb 00:00 Dubai up to, but excluding, 1 Mar 00:00 Dubai) every time
// this file runs, regardless of when that is.
const NOW = new Date("2026-03-15T10:00:00Z");

// Well inside the period.
const FEB_EARLY = new Date("2026-02-05T08:00:00Z");
const FEB_MID = new Date("2026-02-15T08:00:00Z");
const FEB_LATE = new Date("2026-02-20T08:00:00Z");

// The boundary the whole file is really about.
//
// 2026-01-31T21:00:00Z is 2026-02-01T01:00 in Dubai — inside February.
const JAN31_LATE_UTC_IS_FEB1_DUBAI = new Date("2026-01-31T21:00:00Z");
// 2026-02-28T21:30:00Z is 2026-03-01T01:30 in Dubai — outside February.
const FEB28_LATE_UTC_IS_MAR1_DUBAI = new Date("2026-02-28T21:30:00Z");

// Outside the period on both clocks, for the "no leakage" control fixtures.
const MARCH_OUTSIDE = new Date("2026-03-05T08:00:00Z");
const JAN_OUTSIDE = new Date("2026-01-10T08:00:00Z");

async function purge(tenantId: string): Promise<void> {
  await withTenant({ tenantId }, async (tx) => {
    const customers = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(like(schema.customers.code, `${TAG}%`));
    const customerIds = customers.map((c) => c.id);

    const jobs = customerIds.length
      ? await tx.select({ id: schema.jobs.id }).from(schema.jobs).where(inArray(schema.jobs.customerId, customerIds))
      : [];
    const jobIds = jobs.map((j) => j.id);

    const invoices = customerIds.length
      ? await tx
          .select({ id: schema.invoices.id })
          .from(schema.invoices)
          .where(inArray(schema.invoices.customerId, customerIds))
      : [];
    const invoiceIds = invoices.map((i) => i.id);

    const contracts = customerIds.length
      ? await tx
          .select({ id: schema.contracts.id })
          .from(schema.contracts)
          .where(inArray(schema.contracts.customerId, customerIds))
      : [];
    const contractIds = contracts.map((c) => c.id);

    if (customerIds.length > 0) {
      await tx.delete(schema.notifications).where(inArray(schema.notifications.subjectId, customerIds));
    }
    if (jobIds.length > 0) {
      await tx.delete(schema.jobReports).where(inArray(schema.jobReports.jobId, jobIds));
    }
    if (contractIds.length > 0) {
      await tx.delete(schema.contractVisits).where(inArray(schema.contractVisits.contractId, contractIds));
    }
    if (invoiceIds.length > 0) {
      await tx.delete(schema.creditNotes).where(inArray(schema.creditNotes.invoiceId, invoiceIds));
      await tx.delete(schema.invoices).where(inArray(schema.invoices.id, invoiceIds));
    }
    if (jobIds.length > 0) {
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    }
    if (contractIds.length > 0) {
      await tx.delete(schema.contracts).where(inArray(schema.contracts.id, contractIds));
    }
    if (customerIds.length > 0) {
      await tx.delete(schema.properties).where(inArray(schema.properties.customerId, customerIds));
      await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    }
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId };

  await purge(tenantId);

  const {
    customerA,
    customerB,
    expectedA,
    expectedB,
  } = await withTenant(ctx, async (tx) => {
    const [custA] = await tx
      .insert(schema.customers)
      .values({
        tenantId,
        code: `${TAG}-A`,
        name: `${TAG} Alpha Owners Association`,
        phone: "+971501110011",
        billingEmail: "alpha@custreptest.invalid",
      })
      .returning({ id: schema.customers.id });
    const [custB] = await tx
      .insert(schema.customers)
      .values({
        tenantId,
        code: `${TAG}-B`,
        name: `${TAG} Beta Property Management`,
        phone: "+971501110022",
        billingEmail: "beta@custreptest.invalid",
      })
      .returning({ id: schema.customers.id });
    if (!custA || !custB) throw new Error("could not create fixture customers");

    const property = async (customerId: string, name: string): Promise<string> => {
      const [row] = await tx
        .insert(schema.properties)
        .values({ tenantId, customerId, name, addressLine: "1 Test Street", city: "Dubai" })
        .returning({ id: schema.properties.id });
      if (!row) throw new Error("could not create a fixture property");
      return row.id;
    };
    const propertyA = await property(custA.id, `${TAG} Alpha Tower`);
    const propertyB = await property(custB.id, `${TAG} Beta Villas`);

    const job = async (input: {
      customerId: string;
      propertyId: string;
      suffix: string;
      status: "submitted" | "closed" | "cancelled";
      createdAt: Date;
      closedAt?: Date | null;
      respondByAt?: Date | null;
      firstResponseAt?: Date | null;
      resolveByAt?: Date | null;
      completedAt?: Date | null;
    }): Promise<string> => {
      const [row] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `${TAG}-J-${input.suffix}`,
          customerId: input.customerId,
          propertyId: input.propertyId,
          serviceSlug: "handyman",
          title: `${TAG} job ${input.suffix}`,
          status: input.status,
          source: "customer_portal",
          createdAt: input.createdAt,
          closedAt: input.closedAt ?? null,
          respondByAt: input.respondByAt ?? null,
          firstResponseAt: input.firstResponseAt ?? null,
          resolveByAt: input.resolveByAt ?? null,
          completedAt: input.completedAt ?? null,
        })
        .returning({ id: schema.jobs.id });
      if (!row) throw new Error("could not create a fixture job");
      return row.id;
    };

    // ── Customer A: jobs raised/closed, including the two Dubai-boundary cases ──
    // J1: raised in January, closed inside February — counts as CLOSED only.
    const jA1 = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A1",
      status: "closed",
      createdAt: JAN_OUTSIDE,
      closedAt: FEB_MID,
    });
    // J2: created 21:00 UTC on 31 Jan == 01:00 Dubai on 1 Feb — RAISED in Feb.
    const jA2 = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A2",
      status: "submitted",
      createdAt: JAN31_LATE_UTC_IS_FEB1_DUBAI,
    });
    // J3: raised inside Feb, closed 21:30 UTC on 28 Feb == 01:30 Dubai on 1 Mar
    // — RAISED in Feb, but NOT counted as closed-in-February.
    const jA3 = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A3",
      status: "closed",
      createdAt: FEB_MID,
      closedAt: FEB28_LATE_UTC_IS_MAR1_DUBAI,
    });
    // J4: raised inside Feb, still open — RAISED and RAISED-STILL-OPEN.
    const jA4 = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A4",
      status: "submitted",
      createdAt: FEB_LATE,
    });
    // J5: raised and cancelled inside Feb — RAISED and CANCELLED, not CLOSED.
    const jA5 = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A5",
      status: "cancelled",
      createdAt: FEB_MID,
      closedAt: FEB_LATE,
    });
    // J6: entirely outside the period — the "no leakage" control.
    await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A6",
      status: "closed",
      createdAt: MARCH_OUTSIDE,
      closedAt: MARCH_OUTSIDE,
    });

    // ── Customer A: SLA deadlines ──────────────────────────────────────────
    // Response met.
    await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-SLA-R-MET",
      status: "closed",
      createdAt: FEB_EARLY,
      respondByAt: new Date("2026-02-12T12:00:00Z"),
      firstResponseAt: new Date("2026-02-12T10:00:00Z"),
    });
    // Response missed (no first response recorded at all).
    await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-SLA-R-MISS",
      status: "submitted",
      createdAt: FEB_EARLY,
      respondByAt: new Date("2026-02-18T12:00:00Z"),
      firstResponseAt: null,
    });
    // Resolution met.
    await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-SLA-X-MET",
      status: "closed",
      createdAt: FEB_EARLY,
      resolveByAt: new Date("2026-02-14T12:00:00Z"),
      completedAt: new Date("2026-02-14T09:00:00Z"),
    });
    // Resolution missed (completed a day late).
    await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-SLA-X-MISS",
      status: "closed",
      createdAt: FEB_EARLY,
      resolveByAt: new Date("2026-02-22T12:00:00Z"),
      completedAt: new Date("2026-02-23T12:00:00Z"),
    });
    // Control: deadline outside the period entirely — must not be counted.
    await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-SLA-OUTSIDE",
      status: "closed",
      createdAt: MARCH_OUTSIDE,
      respondByAt: MARCH_OUTSIDE,
      firstResponseAt: MARCH_OUTSIDE,
      resolveByAt: MARCH_OUTSIDE,
      completedAt: MARCH_OUTSIDE,
    });

    // ── Customer A: the PPM schedule ───────────────────────────────────────
    const [contractA] = await tx
      .insert(schema.contracts)
      .values({
        tenantId,
        customerId: custA.id,
        reference: `${TAG}-CON-A`,
        name: `${TAG} Alpha AMC`,
        status: "active",
        startsOn: new Date("2025-01-01T00:00:00Z"),
        endsOn: new Date("2027-01-01T00:00:00Z"),
      })
      .returning({ id: schema.contracts.id });
    if (!contractA) throw new Error("could not create fixture contract A");

    const visit = async (input: {
      contractId: string;
      propertyId: string;
      suffix: string;
      dueOn: Date;
      status: "planned" | "generated" | "completed" | "skipped";
    }): Promise<void> => {
      await tx.insert(schema.contractVisits).values({
        tenantId,
        contractId: input.contractId,
        propertyId: input.propertyId,
        dueOn: input.dueOn,
        serviceSlug: `${TAG.toLowerCase()}-visit-${input.suffix}`,
        status: input.status,
      });
    };

    await visit({ contractId: contractA.id, propertyId: propertyA, suffix: "1", dueOn: FEB_EARLY, status: "completed" });
    await visit({ contractId: contractA.id, propertyId: propertyA, suffix: "2", dueOn: FEB_LATE, status: "generated" });
    // Dubai-boundary due date: 2026-01-31T22:00:00Z == 2026-02-01T02:00 Dubai — DUE in Feb.
    await visit({
      contractId: contractA.id,
      propertyId: propertyA,
      suffix: "3",
      dueOn: new Date("2026-01-31T22:00:00Z"),
      status: "planned",
    });
    // Control: due outside the period — must not be counted.
    await visit({ contractId: contractA.id, propertyId: propertyA, suffix: "4", dueOn: MARCH_OUTSIDE, status: "completed" });

    // ── Customer A: outstanding recommendations, including the capped-list case ──
    const openJobForReports = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-REPORTS-OPEN",
      status: "submitted",
      createdAt: FEB_EARLY,
    });
    const closedJobForReports = await job({
      customerId: custA.id,
      propertyId: propertyA,
      suffix: "A-REPORTS-CLOSED",
      status: "closed",
      createdAt: FEB_EARLY,
      closedAt: FEB_EARLY,
    });

    const OUTSTANDING_SEEDED = 25; // more than the 20-row page limit
    for (let i = 0; i < OUTSTANDING_SEEDED; i++) {
      await tx.insert(schema.jobReports).values({
        tenantId,
        jobId: openJobForReports,
        followUpRequired: true,
        recommendation: `${TAG} follow-up recommendation ${i}`,
        createdAt: new Date(FEB_MID.getTime() + i * 60_000),
      });
    }
    // Control: same shape, but the job is CLOSED — must not be counted as outstanding.
    await tx.insert(schema.jobReports).values({
      tenantId,
      jobId: closedJobForReports,
      followUpRequired: true,
      recommendation: `${TAG} recommendation on a closed job`,
      createdAt: FEB_MID,
    });
    // Control: not flagged for follow-up — must not be counted.
    await tx.insert(schema.jobReports).values({
      tenantId,
      jobId: openJobForReports,
      followUpRequired: false,
      recommendation: `${TAG} no follow-up needed`,
      createdAt: FEB_MID,
    });
    // Control: outside the period — must not be counted.
    await tx.insert(schema.jobReports).values({
      tenantId,
      jobId: openJobForReports,
      followUpRequired: true,
      recommendation: `${TAG} recommendation from outside the period`,
      createdAt: MARCH_OUTSIDE,
    });

    // ── Customer A: spend ───────────────────────────────────────────────────
    const invoice = async (input: {
      customerId: string;
      suffix: string;
      status: "draft" | "issued";
      issuedOn: Date | null;
      total: string;
    }): Promise<string> => {
      const [row] = await tx
        .insert(schema.invoices)
        .values({
          tenantId,
          reference: `${TAG}-INV-${input.suffix}`,
          customerId: input.customerId,
          status: input.status,
          issuedOn: input.issuedOn,
          subtotal: input.total,
          total: input.total,
        })
        .returning({ id: schema.invoices.id });
      if (!row) throw new Error("could not create a fixture invoice");
      return row.id;
    };

    const invA1 = await invoice({ customerId: custA.id, suffix: "A1", status: "issued", issuedOn: FEB_EARLY, total: "1000.00" });
    await invoice({ customerId: custA.id, suffix: "A2", status: "issued", issuedOn: FEB_LATE, total: "500.00" });
    // Control: draft — never spend, regardless of date.
    await invoice({ customerId: custA.id, suffix: "A3", status: "draft", issuedOn: null, total: "999.00" });
    // Control: outside the period.
    await invoice({ customerId: custA.id, suffix: "A4", status: "issued", issuedOn: MARCH_OUTSIDE, total: "9999.00" });

    await tx.insert(schema.creditNotes).values({
      tenantId,
      reference: `${TAG}-CN-A1`,
      invoiceId: invA1,
      customerId: custA.id,
      reason: "correction",
      issuedOn: FEB_EARLY,
      subtotal: "100.00",
      total: "100.00",
    });
    // Control credit note outside the period — must not net off February's total.
    await tx.insert(schema.creditNotes).values({
      tenantId,
      reference: `${TAG}-CN-A2`,
      invoiceId: invA1,
      customerId: custA.id,
      reason: "correction",
      issuedOn: MARCH_OUTSIDE,
      subtotal: "77.00",
      total: "77.00",
    });

    // ── Customer B: a small, independent set of fixtures ────────────────────
    // Its whole purpose is to prove A's totals are not inflated by B's rows —
    // amount, not merely presence.
    await job({
      customerId: custB.id,
      propertyId: propertyB,
      suffix: "B1",
      status: "closed",
      createdAt: FEB_EARLY,
      closedAt: FEB_MID,
    });

    const [contractB] = await tx
      .insert(schema.contracts)
      .values({
        tenantId,
        customerId: custB.id,
        reference: `${TAG}-CON-B`,
        name: `${TAG} Beta AMC`,
        status: "active",
        startsOn: new Date("2025-01-01T00:00:00Z"),
        endsOn: new Date("2027-01-01T00:00:00Z"),
      })
      .returning({ id: schema.contracts.id });
    if (!contractB) throw new Error("could not create fixture contract B");
    await visit({ contractId: contractB.id, propertyId: propertyB, suffix: "B1", dueOn: FEB_EARLY, status: "completed" });

    await invoice({ customerId: custB.id, suffix: "B1", status: "issued", issuedOn: FEB_EARLY, total: "222.00" });

    return {
      customerA: { id: custA.id },
      customerB: { id: custB.id },
      expectedA: {
        // `jobsSummary` counts every job on the account created/closed in the
        // period, not only the five `jA*` fixtures built to exercise it — so
        // the four SLA-only jobs and the two report-only jobs below, all
        // created inside February, count too. That is deliberate: it is the
        // same query the SLA and outstanding-recommendation sections read, and
        // a hand count that only tracked jA* would silently stop catching a
        // regression the moment this file's own fixtures grew.
        //
        // Raised (10): jA2, jA3, jA4, jA5, A-SLA-R-MET, A-SLA-R-MISS,
        // A-SLA-X-MET, A-SLA-X-MISS, A-REPORTS-OPEN, A-REPORTS-CLOSED.
        raised: 10,
        // Closed (2): jA1 (closed_at inside Feb) and A-REPORTS-CLOSED (closed,
        // closed_at = FEB_EARLY). jA3's close falls in Dubai March and does
        // not count; the four SLA-only jobs never had closed_at set.
        closed: 2,
        cancelled: 1, // jA5
        // Still open (4): jA2, jA4, A-SLA-R-MISS (submitted), A-REPORTS-OPEN.
        raisedStillOpen: 4,
        responseDeadlines: 2,
        responseMet: 1,
        resolutionDeadlines: 2,
        resolutionMet: 1,
        visitsDue: 3,
        visitsCompleted: 1,
        outstandingTotal: 25,
        outstandingShown: 20,
        invoicedMinor: (1000_00 + 500_00 - 100_00),
        invoiceCount: 2,
      },
      expectedB: {
        raised: 1,
        closed: 1,
        visitsDue: 1,
        visitsCompleted: 1,
        invoicedMinor: 222_00,
        invoiceCount: 1,
      },
      jobsForReference: { jA1, jA2, jA3, jA4, jA5 },
    };
  });

  // ── The pack, for the customer whose figures were hand-computed ──────────
  const packA = await withCustomerScope({ tenantId, customerId: customerA.id }, (tx) =>
    propertyManagerMonthlyPack(tx, { tenantId, customerId: customerA.id }, { now: NOW }),
  );

  console.log(`\n${TAG} — customer A pack, period ${packA.period.label} (${packA.period.startsOn} – ${packA.period.endsOn})\n`);

  check("A period label", packA.period.label, "February 2026");
  check("A period starts", packA.period.startsOn, "2026-02-01");
  check("A period ends", packA.period.endsOn, "2026-03-01");

  check("A jobs.raised", packA.jobs.raised, expectedA.raised);
  check("A jobs.closed", packA.jobs.closed, expectedA.closed);
  check("A jobs.cancelled", packA.jobs.cancelled, expectedA.cancelled);
  check("A jobs.raisedStillOpen", packA.jobs.raisedStillOpen, expectedA.raisedStillOpen);

  check("A sla.responseDeadlines", packA.sla.responseDeadlines, expectedA.responseDeadlines);
  check("A sla.responseMet", packA.sla.responseMet, expectedA.responseMet);
  check("A sla.responseMetPercent", packA.sla.responseMetPercent, 50);
  check("A sla.resolutionDeadlines", packA.sla.resolutionDeadlines, expectedA.resolutionDeadlines);
  check("A sla.resolutionMet", packA.sla.resolutionMet, expectedA.resolutionMet);
  check("A sla.resolutionMetPercent", packA.sla.resolutionMetPercent, 50);

  check("A ppm.visitsDue", packA.ppm.visitsDue, expectedA.visitsDue);
  check("A ppm.visitsCompleted", packA.ppm.visitsCompleted, expectedA.visitsCompleted);
  check("A ppm.completionPercent", packA.ppm.completionPercent, 33);

  // ── The capped-list assertion this file exists to make ───────────────────
  check("A outstanding.total (TRUE count, not capped)", packA.outstanding.total, expectedA.outstandingTotal);
  check("A outstanding.items.length (the page limit)", packA.outstanding.items.length, expectedA.outstandingShown);
  checkTrue("A outstanding.truncated", packA.outstanding.truncated);
  checkTrue(
    "A outstanding.total is strictly greater than items shown (the plateau bug this guards against)",
    packA.outstanding.total > packA.outstanding.items.length,
  );

  check("A spend.invoicedMinor", packA.spend.invoicedMinor, expectedA.invoicedMinor);
  check("A spend.invoiceCount", packA.spend.invoiceCount, expectedA.invoiceCount);
  check("A spend.currency", packA.spend.currency, "AED");

  // ── The same, for customer B — a second real positive, not a negative ────
  const packB = await withCustomerScope({ tenantId, customerId: customerB.id }, (tx) =>
    propertyManagerMonthlyPack(tx, { tenantId, customerId: customerB.id }, { now: NOW }),
  );

  check("B jobs.raised", packB.jobs.raised, expectedB.raised);
  check("B jobs.closed", packB.jobs.closed, expectedB.closed);
  check("B ppm.visitsDue", packB.ppm.visitsDue, expectedB.visitsDue);
  check("B ppm.visitsCompleted", packB.ppm.visitsCompleted, expectedB.visitsCompleted);
  check("B spend.invoicedMinor", packB.spend.invoicedMinor, expectedB.invoicedMinor);
  check("B spend.invoiceCount", packB.spend.invoiceCount, expectedB.invoiceCount);

  // ── Isolation by AMOUNT: B's rows must not have inflated A's totals ──────
  //
  // Both are already asserted equal to their own hand-computed totals above.
  // Restated here as an explicit inequality against the SUM, because that is
  // the shape a leaking RLS policy actually produces — A's figure would not go
  // to some obviously-wrong value, it would go to exactly A-plus-B.
  checkTrue(
    "A's invoiced total is not A's-plus-B's (the shape a leaking policy would produce)",
    packA.spend.invoicedMinor !== expectedA.invoicedMinor + expectedB.invoicedMinor,
  );
  checkTrue(
    "A's PPM visitsDue is not A's-plus-B's",
    packA.ppm.visitsDue !== expectedA.visitsDue + expectedB.visitsDue,
  );
  checkTrue(
    "A's jobs.raised is not A's-plus-B's",
    packA.jobs.raised !== expectedA.raised + expectedB.raised,
  );

  // ── The staff-side helpers the cron route uses ────────────────────────────
  const eligible = await withTenant(ctx, (tx) => customersWithMonthlyPack(tx));
  checkTrue("customersWithMonthlyPack includes customer A", eligible.includes(customerA.id));
  checkTrue("customersWithMonthlyPack includes customer B", eligible.includes(customerB.id));

  await withTenant(ctx, async (tx) => {
    const before = await recentlySentMonthlyPack(tx, {
      template: "property_manager_monthly_pack",
      customerId: customerA.id,
      withinDays: 27,
    });
    checkTrue("recentlySentMonthlyPack is false before anything is sent", before === false);

    await tx.insert(schema.notifications).values({
      tenantId,
      channel: "email",
      template: "property_manager_monthly_pack",
      recipientAddress: "alpha@custreptest.invalid",
      subjectTable: "customers",
      subjectId: customerA.id,
      payload: {},
      status: "queued",
    });

    const after = await recentlySentMonthlyPack(tx, {
      template: "property_manager_monthly_pack",
      customerId: customerA.id,
      withinDays: 27,
    });
    checkTrue("recentlySentMonthlyPack is true just after sending", after === true);

    const otherCustomer = await recentlySentMonthlyPack(tx, {
      template: "property_manager_monthly_pack",
      customerId: customerB.id,
      withinDays: 27,
    });
    checkTrue("recentlySentMonthlyPack is false for a different customer", otherCustomer === false);
  });

  await purge(tenantId);
  await closeConnection();

  console.log(`\n${TAG}: ${fail === 0 ? "ALL PASSED" : `${fail} FAILED`}\n`);
  if (fail > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await closeConnection();
  process.exit(1);
});
