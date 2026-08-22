/**
 * Live technician tracking — integration test against real Postgres.
 *
 * `CUST-3`, `EMG-5`.
 *
 * ── WHAT THIS FILE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * This is the one feature in the product that shows one identifiable person's
 * real-time physical location to another person. The boundary is not "customer
 * A must not see customer B's data" — that is the easy half and it is the half
 * a broken feature passes. The boundary is:
 *
 *   the SAME technician, on the SAME day, is visible to a customer for the
 *   twenty minutes they are driving to that customer, and invisible to the
 *   same customer twenty minutes earlier and twenty minutes later.
 *
 * So every fixture below shares one technician between two customers on
 * purpose. A test that gave each customer their own technician would prove
 * tenant isolation for the third time and would prove nothing about this.
 *
 * ── AND WHY THE POSITIVES ARE LOAD-BEARING ─────────────────────────────────
 *
 * A suite of negatives passes identically against a feature that returns
 * nothing at all, and three people on this project have shipped exactly that.
 * Every negative here is therefore paired with the positive that would fail if
 * the feature were merely broken:
 *
 *   * the right customer DOES see a position mid-visit, with an ETA (2, 3)
 *   * the same customer does NOT see the same technician's morning (4)
 *   * a second customer with a visit booked with the SAME technician sees
 *     nothing while that technician is driving to somebody else (5)
 *   * the moment the visit completes it all disappears, against UNCHANGED ping
 *     data (7) — and the technician's NAME is still there (8), which is what
 *     proves the query machinery still works and only the location went
 *
 *   npx tsx packages/db/test/tracking.test.ts
 *
 * Requires the schema, sql/ applied in README order, and `npm run db:seed`.
 * Creates its own fixtures, prefixed `__TRACKTEST`, and removes them.
 */

import { eq, inArray, sql } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  getPortalLiveTracking,
  getPortalRequestDetail,
  recordTechnicianPing,
  purgeLocationTraces,
  RETENTION_LOCATION_TRACE_DAYS,
  TRACKING_STALE_AFTER_MINUTES,
  applyFieldMutations,
  registerFieldDevice,
  schema,
  closeConnection,
} from "../src/index";
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
function checkBetween(label: string, got: number | null, low: number, high: number): void {
  const ok = got !== null && got >= low && got <= high;
  if (!ok) fail++;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${label}${ok ? ` (${got})` : ` — expected ${low}..${high}, got ${got}`}`,
  );
}
async function checkThrows(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — expected a refusal, the call succeeded`);
  } catch {
    console.log(`ok    ${label}`);
  }
}

const TAG = "__TRACKTEST";

// One clock read, and every fixture offset from it. Three separate `Date.now()`
// calls drift by milliseconds mid-setup, which is invisible until an assertion
// sits within milliseconds of a boundary — and two of the assertions below are
// about exactly where a boundary is.
const NOW = Date.now();
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN);

// Downtown Dubai, and a point about 8 km north-east of it on the way in.
const PROPERTY_POINT = { lat: 25.2048, lng: 55.2708 };
// Digits chosen so they cannot occur by coincidence in a distance or an ETA.
// Assertion 3 searches the serialised projection for them.
const PING_POINT = { lat: 25.2537, lng: 55.3291 };

/**
 * Remove every fixture this file creates.
 *
 * Before the run as well as after it: a suite that only tidies up at the end
 * cannot be run twice after it crashes once, and the second attempt fails in
 * the fixture setup with an error about a unique constraint that says nothing
 * about the thing being tested.
 *
 * Location traces carry no tag of their own — the table is a stream of
 * positions and has no column to put one in — so they are deleted by the
 * technician ids this file created, which are tagged. That is also why the
 * technicians are created here rather than borrowed from the seed: deleting
 * traces by a seeded technician's id would delete another suite's fixtures.
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
    const technicianIds = await idsOf("technicians", "employee_code");

    if (technicianIds.length > 0) {
      await tx
        .delete(schema.technicianLocations)
        .where(inArray(schema.technicianLocations.technicianId, technicianIds));
    }
    if (jobIds.length > 0) {
      await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.jobId, jobIds));
      await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, jobIds));
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    }
    if (technicianIds.length > 0) {
      await tx.delete(schema.technicians).where(inArray(schema.technicians.id, technicianIds));
    }
    if (customerIds.length > 0) {
      await tx.delete(schema.properties).where(inArray(schema.properties.customerId, customerIds));
      await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    }
    // `audit_log` is deliberately NOT cleaned up. The retention purge that
    // assertion 15 provokes writes one summary row, and the application role
    // holds no DELETE on that table — by design, and `verify-rls.sql` check 8
    // is what keeps it that way. A test that wants to tidy an append-only
    // ledger is a test asking for the wrong thing.
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId };

  await purge(tenantId);

  // ── Fixtures: ONE tenant, two customers, one shared technician ───────────
  const ids = await withTenant(ctx, async (tx) => {
    const customer = async (suffix: string) => {
      const [row] = await tx
        .insert(schema.customers)
        .values({
          tenantId,
          code: `${TAG}-${suffix}`,
          name: `${TAG} ${suffix}`,
          phone: `+9715099900${suffix === "A" ? "01" : "02"}`,
          billingEmail: `${suffix.toLowerCase()}@tracktest.invalid`,
        })
        .returning({ id: schema.customers.id });
      if (!row) throw new Error("could not create a fixture customer");
      return row.id;
    };

    const property = async (customerId: string, name: string, point: { lat: number; lng: number } | null) => {
      const [row] = await tx
        .insert(schema.properties)
        .values({
          tenantId,
          customerId,
          name,
          addressLine: "1 Test Street",
          city: "Dubai",
          lat: point?.lat ?? null,
          lng: point?.lng ?? null,
        })
        .returning({ id: schema.properties.id });
      if (!row) throw new Error("could not create a fixture property");
      return row.id;
    };

    const technician = async (suffix: string) => {
      const [row] = await tx
        .insert(schema.technicians)
        .values({
          tenantId,
          employeeCode: `${TAG}-T${suffix}`,
          fullName: `${TAG} Technician ${suffix}`,
          phone: `+9715088800${suffix}`,
          primaryTrade: "handyman",
        })
        .returning({ id: schema.technicians.id });
      if (!row) throw new Error("could not create a fixture technician");
      return row.id;
    };

    const job = async (customerId: string, propertyId: string, suffix: string) => {
      const [row] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `${TAG}-J-${suffix}`,
          customerId,
          propertyId,
          serviceSlug: "handyman",
          title: `${TAG} job ${suffix}`,
          status: "en_route",
          source: "customer_portal",
        })
        .returning({ id: schema.jobs.id });
      if (!row) throw new Error("could not create a fixture job");
      return row.id;
    };

    const visit = async (
      jobId: string,
      technicianId: string,
      status: "assigned" | "en_route" | "arrived" | "completed",
      enRouteAt: Date | null,
    ) => {
      const [row] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId,
          jobId,
          technicianId,
          sequence: 1,
          status,
          enRouteAt,
        })
        .returning({ id: schema.jobVisits.id });
      if (!row) throw new Error("could not create a fixture visit");
      return row.id;
    };

    const customerA = await customer("A");
    const customerB = await customer("B");
    const propertyA = await property(customerA, `${TAG} Alpha Tower`, PROPERTY_POINT);
    const propertyB = await property(customerB, `${TAG} Beta Villas`, PROPERTY_POINT);

    // ONE technician, shared. This is the whole design of the fixture set.
    const techShared = await technician("1");
    // A second, for the stuck-visit ceiling — it needs its own live window and
    // would otherwise collide with the shared technician's.
    const techStuck = await technician("2");

    const jobA = await job(customerA, propertyA, "A1");
    const jobB = await job(customerB, propertyB, "B1");
    const jobStuck = await job(customerA, propertyA, "A2");

    // A is live: set off five minutes ago.
    const visitA = await visit(jobA, techShared, "en_route", at(5));
    // B has the SAME technician booked, and they have not set off for B.
    const visitB = await visit(jobB, techShared, "assigned", null);
    // A2 is the forgotten record: arrived twenty hours ago and never closed.
    await visit(jobStuck, techStuck, "arrived", at(20 * 60));

    // ── Pings ───────────────────────────────────────────────────────────
    // Three for the shared technician. Identified throughout by their exact
    // `recorded_at`, which this file chose, never by position in a result set.
    await tx.insert(schema.technicianLocations).values([
      // The morning: an hour ago, before the technician set off for A.
      { tenantId, technicianId: techShared, lat: 25.11, lng: 55.19, recordedAt: at(60) },
      { tenantId, technicianId: techShared, lat: 25.24, lng: 55.32, recordedAt: at(2) },
      // The newest, and the one the projection must pick.
      {
        tenantId,
        technicianId: techShared,
        lat: PING_POINT.lat,
        lng: PING_POINT.lng,
        recordedAt: at(0.5),
      },
    ]);
    // Fresh ping for the stuck technician: inside no window, because the
    // window closed twelve hours after they set off.
    await tx.insert(schema.technicianLocations).values({
      tenantId,
      technicianId: techStuck,
      lat: 25.3,
      lng: 55.4,
      recordedAt: at(2),
    });

    return { customerA, customerB, techShared, techStuck, jobA, jobB, jobStuck, visitA, visitB };
  });

  const scopeA = { tenantId, customerId: ids.customerA };
  const scopeB = { tenantId, customerId: ids.customerB };

  /** How many of this technician's positions the session can actually reach. */
  const visibleTraces = async (
    scope: { tenantId: string; customerId: string },
    technicianId: string,
  ): Promise<number> =>
    withCustomerScope(scope, async (tx) => {
      const rows = (await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from technician_locations where technician_id = ${technicianId}
      `)) as unknown as { n: string }[];
      return Number(rows[0]?.n ?? "0");
    });

  console.log("\n── 1–3. The right customer, during the visit (the load-bearing positives)");

  const liveA = await withCustomerScope(scopeA, (tx) => getPortalLiveTracking(tx, ids.jobA));

  checkTrue("1. customer A gets live tracking while their technician is en route", liveA !== null);
  check("   state is travelling", liveA?.state, "travelling");
  check("   the technician is named", liveA?.technicianName, `${TAG} Technician 1`);
  check("   not stale", liveA?.stale, false);
  checkBetween("2. a road-adjusted distance is derived", liveA?.distanceKm ?? null, 6, 16);
  checkBetween("   an ETA in minutes is derived", liveA?.etaMinutes ?? null, 10, 45);
  check(
    "   from the NEWEST ping, not an older one",
    liveA?.lastSeenAt?.getTime(),
    at(0.5).getTime(),
  );

  // ── 3. The assertion this projection exists to keep true ────────────────
  //
  // No coordinate, in any form, at any precision. Written against the
  // SERIALISED projection rather than against named fields on purpose: a field
  // check only guards the fields somebody thought to name, and the thing being
  // guarded against is a future edit that adds a new one. This fails whatever
  // it is called and whatever shape it arrives in.
  const wire = JSON.stringify(liveA);
  checkTrue("3. no latitude reaches the client, under any field name", !wire.includes("25.25"));
  checkTrue("   no longitude reaches the client either", !wire.includes("55.32") && !wire.includes("55.33"));
  checkTrue(
    "   nor does the exact captured position",
    !wire.includes(String(PING_POINT.lat)) && !wire.includes(String(PING_POINT.lng)),
  );
  // And the proof that this is a withholding rather than an absence: the raw
  // coordinates ARE readable to this session, and the projection dropped them.
  const rawPoint = await withCustomerScope(scopeA, async (tx) => {
    const rows = (await tx.execute<{ lat: number }>(sql`
      select lat from technician_locations
       where technician_id = ${ids.techShared} order by recorded_at desc limit 1
    `)) as unknown as { lat: number }[];
    return rows[0]?.lat ?? null;
  });
  check("   although the row the projection read carries one", rawPoint, PING_POINT.lat);

  console.log("\n── 4. Not before: the same technician's morning is unreachable");

  // Two of the three pings are inside the window (2 minutes ago, 30 seconds
  // ago); the hour-old one is not. Asserted as a count AND by identity, because
  // a count alone would pass if the wrong two were visible.
  check("4. customer A sees exactly the two in-window positions", await visibleTraces(scopeA, ids.techShared), 2);

  const earlyVisibleToA = await withCustomerScope(scopeA, async (tx) => {
    const rows = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from technician_locations
       where technician_id = ${ids.techShared} and recorded_at = ${at(60).toISOString()}::timestamptz
    `)) as unknown as { n: string }[];
    return Number(rows[0]?.n ?? "0");
  });
  check("   the position from before they set off is ABSENT", earlyVisibleToA, 0);

  const earlyExistsForStaff = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from technician_locations
       where technician_id = ${ids.techShared} and recorded_at = ${at(60).toISOString()}::timestamptz
    `)) as unknown as { n: string }[];
    return Number(rows[0]?.n ?? "0");
  });
  // The pair that makes the assertion above mean something: the row exists, it
  // is simply not this customer's. Without this, "absent" is indistinguishable
  // from "the fixture never inserted it".
  check("   and it DOES exist — staff can see it, the customer cannot", earlyExistsForStaff, 1);

  console.log("\n── 5–6. Not somebody else's: the same technician, a different customer");

  check("5. customer B sees none of that technician's positions", await visibleTraces(scopeB, ids.techShared), 0);
  check(
    "   and gets no tracking for their own job with them",
    await withCustomerScope(scopeB, (tx) => getPortalLiveTracking(tx, ids.jobB)),
    null,
  );
  check(
    "6. customer B cannot reach customer A's job at all",
    await withCustomerScope(scopeB, (tx) => getPortalLiveTracking(tx, ids.jobA)),
    null,
  );

  console.log("\n── 7–8. Not after: completing the visit closes the window retroactively");

  await withTenant(ctx, async (tx) => {
    await tx
      .update(schema.jobVisits)
      .set({ status: "completed", completedAt: at(0.1) })
      .where(eq(schema.jobVisits.id, ids.visitA));
  });

  // NOT ONE PING WAS TOUCHED. The rows are byte-identical to the ones assertion
  // 1 read, and they are now unreachable.
  check("7. customer A now sees zero positions, against unchanged ping data", await visibleTraces(scopeA, ids.techShared), 0);
  check(
    "   and tracking is gone",
    await withCustomerScope(scopeA, (tx) => getPortalLiveTracking(tx, ids.jobA)),
    null,
  );

  const detailAfter = await withCustomerScope(scopeA, (tx) => getPortalRequestDetail(tx, ids.jobA));
  // The guard against "the feature returns nothing at all". If the customer
  // could no longer see the visit or the technician's name either, assertion 7
  // would be passing for the wrong reason.
  check("8. the technician's NAME is still on the request afterwards", detailAfter?.visits[0]?.technicianName, `${TAG} Technician 1`);
  check("   and the visit itself is still there", detailAfter?.visits.length, 1);

  console.log("\n── 9. On site: the visit is live and the position is withheld anyway");

  await withTenant(ctx, async (tx) => {
    await tx
      .update(schema.jobVisits)
      .set({ status: "arrived", completedAt: null })
      .where(eq(schema.jobVisits.id, ids.visitA));
  });

  const onSite = await withCustomerScope(scopeA, (tx) => getPortalLiveTracking(tx, ids.jobA));
  check("9. state is on_site", onSite?.state, "on_site");
  check("   no distance is returned", onSite?.distanceKm, null);
  check("   nor an ETA", onSite?.etaMinutes, null);
  // And the withholding is a DECISION, not an absence of data: the rows are
  // right there and readable. Without this the assertions above would pass on a
  // policy that had simply closed the table.
  check("   the rows are readable — the projection is what withholds them", await visibleTraces(scopeA, ids.techShared), 2);

  console.log("\n── 10. Stale: a handset that has gone quiet is not a live position");

  await withTenant(ctx, async (tx) => {
    await tx
      .update(schema.jobVisits)
      .set({ status: "en_route", enRouteAt: at(40) })
      .where(eq(schema.jobVisits.id, ids.visitA));
    // Push every ping out past the staleness horizon without moving it out of
    // the visit window, which now opens forty minutes ago.
    await tx.execute(sql`
      update technician_locations
         set recorded_at = recorded_at - interval '25 minutes'
       where technician_id = ${ids.techShared}
         and recorded_at > ${at(10).toISOString()}::timestamptz
    `);
  });

  const staleA = await withCustomerScope(scopeA, (tx) => getPortalLiveTracking(tx, ids.jobA));
  checkTrue(`10. a position older than ${TRACKING_STALE_AFTER_MINUTES} minutes is marked stale`, staleA?.stale === true);
  check("   and nothing is derived from it — no distance", staleA?.distanceKm, null);
  check("   and no ETA", staleA?.etaMinutes, null);
  // But the age IS reported. "We last heard from them at 14:12" is honest;
  // silence is not.
  checkTrue("   while still saying when contact was last made", staleA?.lastSeenAt !== null);

  console.log("\n── 11. The twelve-hour ceiling on a visit nobody closed");

  check(
    "11. a visit stuck on arrived for twenty hours exposes nothing",
    await visibleTraces(scopeA, ids.techStuck),
    0,
  );
  const stuck = await withCustomerScope(scopeA, (tx) => getPortalLiveTracking(tx, ids.jobStuck));
  // The visit is still live so the shell is still returned — the customer is
  // told somebody is on site, which is what the record says. What they are not
  // given is a day and a half of positions.
  check("   the visit still reports as on site", stuck?.state, "on_site");
  check("   with nothing behind it", stuck?.lastSeenAt, null);

  console.log("\n── 12–14. The write path");

  await withTenant(ctx, async (tx) => {
    await tx
      .update(schema.jobVisits)
      .set({ status: "en_route", enRouteAt: at(5) })
      .where(eq(schema.jobVisits.id, ids.visitA));
  });

  const batch = [
    { technicianId: ids.techShared, lat: 25.26, lng: 55.34, recordedAt: at(0.3), speedKph: 44 },
    { technicianId: ids.techShared, lat: 25.259, lng: 55.339, recordedAt: at(0.2), speedKph: 41 },
  ];

  const first = await withTenant(ctx, (tx) => recordTechnicianPing(tx, ctx, batch));
  check("12. a batch of two positions records two rows", first.recorded, 2);
  check(
    "   and the technician is told who can see them",
    first.sharedWithCustomer?.customerName,
    `${TAG} A`,
  );

  const replay = await withTenant(ctx, (tx) => recordTechnicianPing(tx, ctx, batch));
  check("13. the same batch replayed records nothing (offline flush is idempotent)", replay.recorded, 0);

  await withTenant(ctx, async (tx) => {
    await tx
      .update(schema.jobVisits)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.jobVisits.id, ids.visitA));
  });
  const afterClose = await withTenant(ctx, (tx) =>
    recordTechnicianPing(tx, ctx, [
      { technicianId: ids.techShared, lat: 25.27, lng: 55.35, recordedAt: at(-1) },
    ]),
  );
  check("   once the visit closes, the handset is told nobody is watching", afterClose.sharedWithCustomer, null);

  await checkThrows("14. a position at Null Island is refused", () =>
    withTenant(ctx, (tx) =>
      recordTechnicianPing(tx, ctx, [{ technicianId: ids.techShared, lat: 0, lng: 0, recordedAt: new Date() }]),
    ),
  );
  await checkThrows("   a latitude off the planet is refused", () =>
    withTenant(ctx, (tx) =>
      recordTechnicianPing(tx, ctx, [{ technicianId: ids.techShared, lat: 91, lng: 55, recordedAt: new Date() }]),
    ),
  );
  await checkThrows("   and a portal session cannot write a position at all", () =>
    withCustomerScope(scopeA, (tx) =>
      tx.execute(sql`
        insert into technician_locations (tenant_id, technician_id, lat, lng, recorded_at)
        values (${tenantId}::uuid, ${ids.techShared}::uuid, 25.2, 55.3, now())
      `),
    ),
  );

  console.log("\n── 15. Consistent with FLD-16 retention");

  const before = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from technician_locations where technician_id = ${ids.techShared}
    `)) as unknown as { n: string }[];
    return Number(rows[0]?.n ?? "0");
  });
  const outcome = await withTenant(ctx, (tx) => purgeLocationTraces(tx, ctx));
  const after = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: string }>(sql`
      select count(*)::text as n from technician_locations where technician_id = ${ids.techShared}
    `)) as unknown as { n: string }[];
    return Number(rows[0]?.n ?? "0");
  });
  check(`15. the ${RETENTION_LOCATION_TRACE_DAYS}-day purge leaves today's traces alone`, after, before);
  check("   and reports against the same rule", outcome.rule, "FLD-16");

  // Now the other direction: a trace older than the window goes, and tracking
  // never wanted it. The two features do not fight over this table.
  await withTenant(ctx, async (tx) => {
    await tx.insert(schema.technicianLocations).values({
      tenantId,
      technicianId: ids.techShared,
      lat: 25.1,
      lng: 55.1,
      recordedAt: at((RETENTION_LOCATION_TRACE_DAYS + 1) * 24 * 60),
    });
  });
  const purged = await withTenant(ctx, (tx) => purgeLocationTraces(tx, ctx));
  checkTrue("   while a trace past the window is purged", purged.deleted >= 1);

  console.log("\n── 16. FLD-16's producer: the field app's own mutations, end to end");

  // Every section above drives `recordTechnicianPing` directly, which is the
  // right way to test the READ side and the write function's own rules. None
  // of it proves the thing `FLD-16` was actually about: that BEFORE this
  // change, nothing anywhere called `recordTechnicianPing` outside its own
  // test, so a real handset produced no rows and this whole file was
  // exercising a function nobody could reach.
  //
  // So this drives it the other way: a status transition and a location
  // batch, submitted exactly as `apps/web/src/app/api/field/v1/mutations/
  // route.ts` submits them for a real handset - through `applyFieldMutations`
  // - and then asks the SAME question section 1 asked, of a customer session
  // that has seen none of the domain functions above by name.
  //
  // A dedicated technician, customer and property, entirely separate from
  // `techShared`'s: that fixture already carries a live `en_route` visit by
  // this point in the file (section 10 left it that way), and
  // `currentTrackingAudience` picks the EARLIEST live visit when a technician
  // has two - reusing `techShared` here would silently assert against the
  // wrong job the moment that ordering did not go this test's way.

  const producerIds = await withTenant(ctx, async (tx) => {
    const [customer] = await tx
      .insert(schema.customers)
      .values({
        tenantId,
        code: `${TAG}-PROD`,
        name: `${TAG} Producer Co`,
        phone: "+971509990099",
        billingEmail: "prod@tracktest.invalid",
      })
      .returning({ id: schema.customers.id });
    if (!customer) throw new Error("could not create the producer-test customer");

    const [property] = await tx
      .insert(schema.properties)
      .values({
        tenantId,
        customerId: customer.id,
        name: `${TAG} Producer Site`,
        addressLine: "1 Test Street",
        city: "Dubai",
        lat: PROPERTY_POINT.lat,
        lng: PROPERTY_POINT.lng,
      })
      .returning({ id: schema.properties.id });
    if (!property) throw new Error("could not create the producer-test property");

    const [technician] = await tx
      .insert(schema.technicians)
      .values({
        tenantId,
        employeeCode: `${TAG}-TPROD`,
        fullName: `${TAG} Technician Producer`,
        phone: "+971508880088",
        primaryTrade: "handyman",
      })
      .returning({ id: schema.technicians.id });
    if (!technician) throw new Error("could not create the producer-test technician");

    // `dispatched` / `assigned` - the real starting point, so the mutation
    // below is a genuine transition and not a same-status no-op the way an
    // `en_route`-seeded fixture would make it.
    const [job] = await tx
      .insert(schema.jobs)
      .values({
        tenantId,
        reference: `${TAG}-J-PROD`,
        customerId: customer.id,
        propertyId: property.id,
        serviceSlug: "handyman",
        title: `${TAG} producer job`,
        status: "dispatched",
        source: "customer_portal",
      })
      .returning({ id: schema.jobs.id });
    if (!job) throw new Error("could not create the producer-test job");

    await tx.insert(schema.jobVisits).values({
      tenantId,
      jobId: job.id,
      technicianId: technician.id,
      sequence: 1,
      status: "assigned",
    });

    const userRow = (await tx.execute<{ user_id: string }>(sql`
      select user_id from memberships where is_active limit 1
    `)) as unknown as { user_id: string }[];
    const userId = userRow[0]?.user_id;
    if (!userId) throw new Error("Seed data missing a membership. Run `npm run db:seed`.");

    return { customerId: customer.id, technicianId: technician.id, jobId: job.id, userId };
  });

  const device = await withTenant({ ...ctx, userId: producerIds.userId }, async (tx) =>
    registerFieldDevice(tx, { tenantId, userId: producerIds.userId }, {
      technicianId: producerIds.technicianId,
      userId: producerIds.userId,
      label: `${TAG} producer handset`,
      platform: "ios",
      tokenHash: "f".repeat(64),
      tokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }),
  );

  const producerScope = { tenantId, customerId: producerIds.customerId };

  check(
    "16a. before the phone sends anything, the customer sees no position and no tracking",
    await withCustomerScope(producerScope, (tx) => getPortalLiveTracking(tx, producerIds.jobId)),
    null,
  );

  // The button `JobCardScreen`'s "On my way" drives - `job_status/transition`.
  const setOff = await withTenant({ tenantId, userId: producerIds.userId }, (tx) =>
    applyFieldMutations(tx, { tenantId, userId: producerIds.userId }, {
      deviceId: device.id,
      technicianId: producerIds.technicianId,
      mutations: [
        {
          clientId: "TRACKTESTPRODSETOFF001",
          entity: "job_status",
          op: "transition",
          payload: { jobId: producerIds.jobId, to: "en_route" },
        },
      ],
    }),
  );
  check("16b. the field app's own status mutation is accepted", setOff.accepted.length, 1);

  // What `LocationSharingTracker` sends once the watch reports a fix.
  const pinged = await withTenant({ tenantId, userId: producerIds.userId }, (tx) =>
    applyFieldMutations(tx, { tenantId, userId: producerIds.userId }, {
      deviceId: device.id,
      technicianId: producerIds.technicianId,
      mutations: [
        {
          clientId: "TRACKTESTPRODPING00001",
          entity: "technician_location",
          op: "append",
          payload: { pings: [{ lat: PING_POINT.lat, lng: PING_POINT.lng, recordedAt: new Date().toISOString() }] },
        },
      ],
    }),
  );
  check("16c. the field app's own location mutation is accepted", pinged.accepted.length, 1);
  check(
    "   and it tells the technician who is watching",
    (pinged.accepted[0]?.result["sharedWithCustomer"] as { customerName: string } | null)?.customerName,
    `${TAG} Producer Co`,
  );

  // ── 16d. THE assertion this whole section exists for ─────────────────────
  const producerTracking = await withCustomerScope(producerScope, (tx) =>
    getPortalLiveTracking(tx, producerIds.jobId),
  );
  checkTrue(
    "16d. the customer can now see live tracking, produced entirely by the field app's own mutations",
    producerTracking !== null,
  );
  check("   in the travelling state", producerTracking?.state, "travelling");
  check("   naming the right technician", producerTracking?.technicianName, `${TAG} Technician Producer`);
  // The load-bearing part of 16d: `state: "travelling"` is a property of the
  // VISIT alone (`job_visits.status = 'en_route'`) and would read the same
  // even if the field app's location mutation never landed a single row — see
  // section 11's `stuck` fixture, which is `on_site` with nothing behind it.
  // `lastSeenAt` is what actually depends on a ping having been recorded, so
  // it is the assertion that fails if `handleLocationPing`'s wiring is
  // removed, not merely one that happens to still pass.
  checkTrue("   with a real position behind it, not just a live visit", producerTracking?.lastSeenAt !== null);
  checkBetween("   and a distance derived from that position", producerTracking?.distanceKm ?? null, 0, 50);

  await purge(tenantId);
  await closeConnection();

  console.log(`\n${fail === 0 ? "all checks passed" : `${fail} CHECK(S) FAILED`}`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
