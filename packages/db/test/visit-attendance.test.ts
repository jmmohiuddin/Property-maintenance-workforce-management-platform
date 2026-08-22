/**
 * The visit follows the job — integration test against real Postgres.
 *
 * `CUST-3`, `EMG-5`, `G11`.
 *
 * ── WHAT THIS FILE IS ACTUALLY FOR ─────────────────────────────────────────
 *
 * `job_visits` rows were written at ASSIGNMENT and nothing ever moved them.
 * `en_route_at` and `arrived_at` have existed since `0000` and, until the
 * change this file guards, the only writers of either column in the whole
 * repository were `seed.ts` and the test suites. Customer live tracking keys
 * on exactly those two columns — in the projection AND in the RESTRICTIVE
 * `customer_scope` policy on `technician_locations` — so the feature was
 * finished, tested, and unable to show a customer anything in production.
 *
 * That is why the load-bearing assertion here is NOT "the visit row changed".
 * It is:
 *
 *   drive `transitionJob` the way the dispatch board and the field sync drive
 *   it, and then, inside a real customer-scoped transaction, the customer can
 *   see their technician moving — and could not a moment earlier.
 *
 * A test that seeded an `en_route` visit by hand would pass against the broken
 * product, which is precisely how this shipped. Nothing below writes
 * `en_route_at`, `arrived_at` or a visit status directly; every one of them is
 * reached by moving a JOB.
 *
 * ── EVERY NEGATIVE HAS A POSITIVE BESIDE IT ────────────────────────────────
 *
 *   * the customer sees nothing before the transition (1) and sees a named
 *     technician with an ETA after it (2, 3)
 *   * the customer can read exactly the positions recorded from the departure
 *     onward, and not the one recorded before it (4) — a count, so a policy
 *     that returned everything and one that returned nothing both fail
 *   * arriving stamps the arrival and does NOT move the departure (6)
 *   * arriving twice keeps the first arrival (7) — paired with the fact that
 *     the job really did move both times (7a)
 *   * completion closes the window against UNCHANGED ping data (8), and the
 *     visit is settled rather than merely hidden (8a)
 *   * a technician's own device advances their own visit (10) and not their
 *     colleague's (10a); the office advances both (12)
 *
 *   npx tsx packages/db/test/visit-attendance.test.ts
 *
 * Requires the schema, sql/ applied in README order, and `npm run db:seed`.
 * Creates its own fixtures, prefixed `__VISITATT`, and removes them.
 */

import { eq, inArray, sql } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  transitionJob,
  declareNoMaterials,
  recordPhotoExemption,
  recordVisitLabour,
  getPortalLiveTracking,
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

const TAG = "__VISITATT";

// One clock read, offset from. Three separate Date.now() calls drift by
// milliseconds mid-setup, and two assertions below sit on a boundary.
const NOW = Date.now();
const MIN = 60_000;
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN);

// Downtown Dubai, and a point about 8 km north-east of it on the way in.
const PROPERTY_POINT = { lat: 25.2048, lng: 55.2708 };
const PING_POINT = { lat: 25.2537, lng: 55.3291 };

/**
 * Remove every fixture this file creates, before the run as well as after it.
 *
 * A suite that only tidies at the end cannot be run twice after it crashes
 * once: the second attempt dies in fixture setup on a unique constraint and
 * says nothing about the thing being tested.
 *
 * Everything hanging off a job — visits, events, materials, declarations,
 * attachments — is ON DELETE CASCADE from `jobs`, so deleting the jobs is
 * enough and is also the only order that works: `job_visits.technician_id` is
 * ON DELETE RESTRICT, so the technicians cannot go first.
 *
 * Location traces carry no tag of their own, so they are deleted by the
 * technician ids this file created, which are tagged. That is why the
 * technicians are created here rather than borrowed from the seed.
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
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, jobIds));
    }
    if (technicianIds.length > 0) {
      await tx.delete(schema.technicians).where(inArray(schema.technicians.id, technicianIds));
    }
    if (customerIds.length > 0) {
      await tx.delete(schema.properties).where(inArray(schema.properties.customerId, customerIds));
      await tx.delete(schema.customers).where(inArray(schema.customers.id, customerIds));
    }
    // `audit_log` is deliberately not cleaned up: the application role holds no
    // DELETE on it by design, and `verify-rls.sql` check 8 keeps it that way.
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId };

  await purge(tenantId);

  /** One visit row, read back by id. Never "the newest" — see MEMORY. */
  const visitRow = async (id: string) =>
    withTenant(ctx, async (tx) => {
      const [row] = await tx
        .select({
          status: schema.jobVisits.status,
          enRouteAt: schema.jobVisits.enRouteAt,
          arrivedAt: schema.jobVisits.arrivedAt,
          completedAt: schema.jobVisits.completedAt,
        })
        .from(schema.jobVisits)
        .where(eq(schema.jobVisits.id, id));
      if (!row) throw new Error(`visit ${id} vanished`);
      return row;
    });

  const jobStatus = async (id: string) =>
    withTenant(ctx, async (tx) => {
      const [row] = await tx
        .select({ status: schema.jobs.status })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, id));
      return row?.status ?? null;
    });

  // ── Fixtures ────────────────────────────────────────────────────────────
  const ids = await withTenant(ctx, async (tx) => {
    // Borrowed, not created: `users` is not tenant-scoped and every other
    // suite here borrows one for the same reason. It is only ever used as the
    // login side of `technicians.user_id`, to exercise the branch that resolves
    // "who is speaking" from `ctx.userId` alone.
    const [user] = await tx.select({ id: schema.users.id }).from(schema.users).limit(1);
    if (!user) throw new Error("the seed has no users; run `npm run db:seed`");

    const [customer] = await tx
      .insert(schema.customers)
      .values({
        tenantId,
        code: `${TAG}-C`,
        name: `${TAG} Customer`,
        phone: "+971509990401",
        billingEmail: "c@visitatt.invalid",
      })
      .returning({ id: schema.customers.id });
    if (!customer) throw new Error("could not create the fixture customer");

    const [property] = await tx
      .insert(schema.properties)
      .values({
        tenantId,
        customerId: customer.id,
        name: `${TAG} Alpha Tower`,
        addressLine: "1 Test Street",
        city: "Dubai",
        lat: PROPERTY_POINT.lat,
        lng: PROPERTY_POINT.lng,
      })
      .returning({ id: schema.properties.id });
    if (!property) throw new Error("could not create the fixture property");

    const technician = async (suffix: string, userId: string | null) => {
      const [row] = await tx
        .insert(schema.technicians)
        .values({
          tenantId,
          employeeCode: `${TAG}-T${suffix}`,
          fullName: `${TAG} Technician ${suffix}`,
          phone: `+97150888040${suffix}`,
          primaryTrade: "handyman",
          userId,
        })
        .returning({ id: schema.technicians.id });
      if (!row) throw new Error("could not create a fixture technician");
      return row.id;
    };

    // T1 carries the login. T2 never does, so an assertion that T2's visit
    // stayed put cannot pass by accident through the user join.
    const techOne = await technician("1", user.id);
    const techTwo = await technician("2", null);

    const job = async (suffix: string) => {
      const [row] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `${TAG}-J-${suffix}`,
          customerId: customer.id,
          propertyId: property.id,
          serviceSlug: "handyman",
          title: `${TAG} job ${suffix}`,
          // Where `assignTechnician` leaves a job it has just staffed, and the
          // only status from which `en_route` is legal.
          status: "dispatched",
          source: "customer_portal",
        })
        .returning({ id: schema.jobs.id });
      if (!row) throw new Error("could not create a fixture job");
      return row.id;
    };

    /**
     * A visit exactly as `assignTechnician` writes one: status `assigned`,
     * `dispatched_at` set, both attendance stamps null.
     *
     * Written directly rather than through `assignTechnician` so that the
     * `JOB-8` availability and `HR-9` certification rules — which have their
     * own suite — cannot make this file red for a reason that has nothing to
     * do with attendance. The row is the row that function produces; what is
     * under test is what happens to it afterwards.
     */
    const visit = async (
      jobId: string,
      technicianId: string,
      sequence: number,
      status: "assigned" | "superseded" = "assigned",
    ) => {
      const [row] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId,
          jobId,
          technicianId,
          sequence,
          status,
          scheduledStart: at(-30),
          scheduledEnd: at(-150),
          dispatchedAt: at(60),
        })
        .returning({ id: schema.jobVisits.id });
      if (!row) throw new Error("could not create a fixture visit");
      return row.id;
    };

    const jobSolo = await job("SOLO");
    const jobCrewDevice = await job("CREWD");
    const jobCrewUser = await job("CREWU");
    const jobCrewOffice = await job("CREWO");
    const jobBare = await job("BARE");
    const jobRetired = await job("RETIRED");
    const jobKilled = await job("KILLED");
    const jobKilledPlan = await job("KPLAN");

    return {
      userId: user.id,
      customerId: customer.id,
      techOne,
      techTwo,
      jobSolo,
      visitSolo: await visit(jobSolo, techOne, 1),
      jobCrewDevice,
      crewDeviceMine: await visit(jobCrewDevice, techOne, 1),
      crewDeviceTheirs: await visit(jobCrewDevice, techTwo, 2),
      jobCrewUser,
      crewUserMine: await visit(jobCrewUser, techOne, 1),
      crewUserTheirs: await visit(jobCrewUser, techTwo, 2),
      jobCrewOffice,
      crewOfficeOne: await visit(jobCrewOffice, techOne, 1),
      crewOfficeTwo: await visit(jobCrewOffice, techTwo, 2),
      jobBare,
      jobRetired,
      // A plan a reassignment replaced. Nobody travelled on it and nothing may
      // ever stamp it with an attendance.
      retiredVisit: await visit(jobRetired, techTwo, 1, "superseded"),
      jobKilled,
      killedVisit: await visit(jobKilled, techOne, 1),
      jobKilledPlan,
      killedPlanVisit: await visit(jobKilledPlan, techTwo, 1),
    };
  });

  const scope = { tenantId, customerId: ids.customerId };

  const tracking = async (jobId: string) =>
    withCustomerScope(scope, (tx) => getPortalLiveTracking(tx, jobId));

  /** How many of this technician's positions the customer can actually reach. */
  const visibleTraces = async (technicianId: string): Promise<number> =>
    withCustomerScope(scope, async (tx) => {
      const rows = (await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from technician_locations where technician_id = ${technicianId}
      `)) as unknown as { n: string }[];
      return Number(rows[0]?.n ?? "0");
    });

  // ── 1. Before the transition, the customer sees nothing ─────────────────
  //
  // The paired negative. It is worth stating because it is what the whole
  // product looked like before this change, for every job, for ever.
  console.log("\n── 1. Before departure");
  check("1. an assigned visit shows the customer no tracking", await tracking(ids.jobSolo), null);

  // A position recorded BEFORE the technician set off for this customer. It
  // exists so that assertion 4 is a real count and not a tautology.
  await withTenant(ctx, (tx) =>
    tx.insert(schema.technicianLocations).values({
      tenantId,
      technicianId: ids.techOne,
      lat: 25.11,
      lng: 55.19,
      recordedAt: at(30),
    }),
  );
  check("   and cannot read the technician's earlier morning either", await visibleTraces(ids.techOne), 0);

  // ── 2–4. THE POINT OF THIS FILE ─────────────────────────────────────────
  //
  // One call to `transitionJob` — the same function the dispatch board action
  // and the field sync handler both call — and the feature comes alive.
  console.log("\n── 2–4. Driving the JOB makes live tracking work");

  await withTenant(ctx, (tx) =>
    transitionJob(tx, ctx, { jobId: ids.jobSolo, to: "en_route", note: `${TAG} departure` }),
  );

  // Recorded after the departure, which is what the policy's interval half
  // requires. The device would send this from the road.
  await withTenant(ctx, (tx) =>
    tx.insert(schema.technicianLocations).values({
      tenantId,
      technicianId: ids.techOne,
      lat: PING_POINT.lat,
      lng: PING_POINT.lng,
      recordedAt: new Date(),
    }),
  );

  const live = await tracking(ids.jobSolo);
  checkTrue("2. the customer now gets live tracking, from a job transition alone", live !== null);
  check("   state is travelling", live?.state, "travelling");
  check("   the technician is named", live?.technicianName, `${TAG} Technician 1`);
  check("   not stale", live?.stale, false);
  checkBetween("3. a road-adjusted distance is derived", live?.distanceKm ?? null, 6, 16);
  checkBetween("   an ETA in minutes is derived", live?.etaMinutes ?? null, 10, 45);

  // The RESTRICTIVE policy, not the projection. A count rather than a boolean:
  // a policy that returned nothing fails on the 1, and one that returned
  // everything fails because the pre-departure position is still not theirs.
  check("4. the customer can read the positions from the departure onward, and only those", await visibleTraces(ids.techOne), 1);

  const soloEnRoute = await visitRow(ids.visitSolo);
  check("5. and the visit itself records the departure", soloEnRoute.status, "en_route");
  checkTrue("   with en_route_at stamped rather than left null", soloEnRoute.enRouteAt !== null);
  check("   and nothing has claimed an arrival yet", soloEnRoute.arrivedAt, null);

  // ── 6–7. Arrival, and arriving twice ────────────────────────────────────
  console.log("\n── 6–7. Arrival is stamped once");

  await withTenant(ctx, (tx) => transitionJob(tx, ctx, { jobId: ids.jobSolo, to: "on_site" }));
  const soloArrived = await visitRow(ids.visitSolo);
  check("6. arriving moves the visit to arrived", soloArrived.status, "arrived");
  checkTrue("   and stamps arrived_at", soloArrived.arrivedAt !== null);
  check(
    "   without moving the departure it already recorded",
    soloArrived.enRouteAt?.getTime(),
    soloEnRoute.enRouteAt?.getTime(),
  );
  check("   the customer's view follows to on site", (await tracking(ids.jobSolo))?.state, "on_site");

  // `on_site -> paused -> on_site` is a legal walk and it arrives twice for
  // real. The field sync also replays mutations. Either way the FIRST arrival
  // is the true one, and a second stamp would quietly rewrite how long the job
  // took.
  await withTenant(ctx, async (tx) => {
    await transitionJob(tx, ctx, { jobId: ids.jobSolo, to: "paused", note: `${TAG} parts` });
    await transitionJob(tx, ctx, { jobId: ids.jobSolo, to: "on_site", note: `${TAG} resumed` });
  });
  const soloAgain = await visitRow(ids.visitSolo);
  check("7. arriving a second time does not move arrived_at", soloAgain.arrivedAt?.getTime(), soloArrived.arrivedAt?.getTime());
  // The positive beside it: the job really did move both times, so assertion 7
  // is not passing because nothing happened.
  check("7a. and the job really did travel through paused and back", await jobStatus(ids.jobSolo), "on_site");

  // ── 8. Completion settles the visit and closes the window ───────────────
  console.log("\n── 8. Completion settles the attendance");

  const tracesBeforeCompletion = await visibleTraces(ids.techOne);

  await withTenant(ctx, async (tx) => {
    // `JOB-15`'s three gaps, so the completion gate on `transitionJob` lets the
    // job through. Not the subject of this file — `jobcard.test.ts` owns that —
    // but it has to be satisfied to reach the settle.
    await recordPhotoExemption(tx, ctx, { jobId: ids.jobSolo, reasonCode: "nothing_visible" });
    await declareNoMaterials(tx, ctx, { jobId: ids.jobSolo });
    await recordVisitLabour(tx, ctx, { jobId: ids.jobSolo, visitId: ids.visitSolo, workMinutes: 75 });
    await transitionJob(tx, ctx, { jobId: ids.jobSolo, to: "work_complete" });
  });

  const soloDone = await visitRow(ids.visitSolo);
  check("8. completing the job settles the attended visit", soloDone.status, "completed");
  checkTrue("   and stamps completed_at", soloDone.completedAt !== null);
  check("8a. the customer's live tracking stops", await tracking(ids.jobSolo), null);
  // Against UNCHANGED ping data: nothing was deleted, the window closed.
  check("   with the position rows still there before it", tracesBeforeCompletion, 1);
  check("   and no longer readable by the customer", await visibleTraces(ids.techOne), 0);

  // Reopening does not resurrect a settled visit. A second attendance is a
  // second visit, raised through `assignTechnician` — the same answer
  // `rescheduleVisit` gives a dispatcher who tries to move a finished one.
  await withTenant(ctx, (tx) => transitionJob(tx, ctx, { jobId: ids.jobSolo, to: "on_site" }));
  check("9. reopening the job does not reopen the settled visit", (await visitRow(ids.visitSolo)).status, "completed");
  check("   though the job itself did reopen", await jobStatus(ids.jobSolo), "on_site");

  // ── 10–12. Which visit, on a two-person job ─────────────────────────────
  console.log("\n── 10–12. Whose attendance is recorded");

  // The field sync's path: it authenticated the device to a technician and
  // says so. Only that technician's visit may be stamped — the colleague may
  // still be in the depot, and stamping them would start sharing a second
  // employee's live position with the customer.
  await withTenant(ctx, (tx) =>
    transitionJob(tx, ctx, {
      jobId: ids.jobCrewDevice,
      to: "en_route",
      actorTechnicianId: ids.techOne,
    }),
  );
  check("10. a technician's own device advances their own visit", (await visitRow(ids.crewDeviceMine)).status, "en_route");
  check("10a. and does not advance their colleague's", (await visitRow(ids.crewDeviceTheirs)).status, "assigned");
  check("   nor stamp a colleague's departure", (await visitRow(ids.crewDeviceTheirs)).enRouteAt, null);

  // The same narrowing, resolved from `ctx.userId` alone — a technician who
  // has a staff login and drove this from the web app.
  const asTechnician = { tenantId, userId: ids.userId };
  await withTenant(asTechnician, (tx) =>
    transitionJob(tx, asTechnician, { jobId: ids.jobCrewUser, to: "en_route" }),
  );
  check("11. a technician acting as themselves is recognised from their login", (await visitRow(ids.crewUserMine)).status, "en_route");
  check("11a. and their colleague is still untouched", (await visitRow(ids.crewUserTheirs)).status, "assigned");

  // The office. No technician on the context at all, so the statement is about
  // the job and it covers the whole crew.
  await withTenant(ctx, (tx) => transitionJob(tx, ctx, { jobId: ids.jobCrewOffice, to: "en_route" }));
  check("12. the office moving the job advances the whole crew", (await visitRow(ids.crewOfficeOne)).status, "en_route");
  check("   both of them", (await visitRow(ids.crewOfficeTwo)).status, "en_route");

  // ── 13–14. None, and retired ────────────────────────────────────────────
  console.log("\n── 13–14. No visit, and a visit that must never be stamped");

  // `triaged -> dispatched -> en_route` is a legal walk with no assignment on
  // it. Refusing here would break job movement to protect a record that is not
  // required to exist.
  await withTenant(ctx, (tx) => transitionJob(tx, ctx, { jobId: ids.jobBare, to: "en_route" }));
  check("13. a job with no visit at all still moves", await jobStatus(ids.jobBare), "en_route");

  await withTenant(ctx, (tx) => transitionJob(tx, ctx, { jobId: ids.jobRetired, to: "en_route" }));
  const retired = await visitRow(ids.retiredVisit);
  check("14. a superseded visit is never given an attendance", retired.status, "superseded");
  check("   and no departure is stamped on it", retired.enRouteAt, null);
  check("   though the job moved anyway", await jobStatus(ids.jobRetired), "en_route");

  // ── 15–16. Cancellation ends an attendance; it does not invent one ──────
  console.log("\n── 15–16. Cancellation");

  await withTenant(ctx, async (tx) => {
    await transitionJob(tx, ctx, { jobId: ids.jobKilled, to: "en_route" });
    await transitionJob(tx, ctx, { jobId: ids.jobKilled, to: "cancelled", note: `${TAG} called off` });
  });
  check("15. cancelling a job the technician had set off for aborts the visit", (await visitRow(ids.killedVisit)).status, "aborted");
  checkTrue("   and keeps the journey it recorded", (await visitRow(ids.killedVisit)).enRouteAt !== null);
  check("15a. so the customer stops seeing them", await tracking(ids.jobKilled), null);

  // The other half, and the one that would be wrong to tidy: nobody travelled,
  // so "aborted" would claim an attendance in order to close a row.
  await withTenant(ctx, (tx) =>
    transitionJob(tx, ctx, { jobId: ids.jobKilledPlan, to: "cancelled", note: `${TAG} called off` }),
  );
  check("16. cancelling a job nobody set off for leaves the plan as a plan", (await visitRow(ids.killedPlanVisit)).status, "assigned");

  await purge(tenantId);

  console.log(fail === 0 ? "\nall visit-attendance checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
