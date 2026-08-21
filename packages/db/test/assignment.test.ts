/**
 * Assignment warnings, the JOB-10 override gate, and outcome capture.
 *
 * Three requirements meet here and all three are enforced in the domain layer
 * rather than in a form, so all three can only be proven against a real
 * database:
 *
 *   * `JOB-8`  availability — on shift, not double-booked, inside the statutory
 *              day and week, against the tenant's own working calendar.
 *   * `JOB-10` an override is refused unless a reason is recorded. The columns
 *              have existed since `0005` and were null in every row ever
 *              written, because the only caller never sent them.
 *   * `JOB-13` / `JOB-14` outcome and fault coding, including the foreign key
 *              `0024` puts behind `jobs.outcome_code`.
 *
 * The checks that matter most are the refusals. A gate that is only asserted
 * from the happy path is a gate nobody has opened.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself.
 */

import { and, eq, sql } from "drizzle-orm";
import { UserFacingError, fromDubai, nextWorkingWindow, startOfDubaiDay, toDubai } from "@meridian/core";
import {
  withTenant,
  activeTenantIds,
  findCandidates,
  assignmentWarnings,
  assignTechnician,
  blockedTechnicians,
  loadWorkingCalendar,
  listTechnicians,
  addFaultCode,
  listFaultCodes,
  recordJobOutcome,
  getJobOutcome,
  schema,
  closeConnection,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";
/** Deliberately obscure so it cannot collide with a seeded skill or service. */
const TEST_SERVICE = "assignment-rig-service";
const TAG = "__TEST assignment";
const REFERENCE_PREFIX = "TSTASSIGN";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/**
 * Runs `fn` and returns how it refused, or null if it did not refuse at all.
 *
 * `userFacing` is part of the assertion rather than a detail. Only
 * `UserFacingError` is safe to render: everything else reaching a screen would
 * be a driver message with the SQL statement and its parameters in it, which is
 * both useless to a dispatcher and a disclosure.
 */
async function refusal(
  fn: () => Promise<unknown>,
): Promise<{ message: string; userFacing: boolean } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      userFacing: error instanceof UserFacingError,
    };
  }
}

/**
 * Remove everything a previous run of this file wrote.
 *
 * Called before the fixtures as well as after them. A suite that only cleans up
 * on the way out leaves its rows behind the first time an assertion throws, and
 * then fails on a unique constraint for ever after — which reads as a broken
 * test rather than as a broken previous run. Matching on the tag rather than on
 * ids is what makes it work without knowing what the last run got as far as.
 */
async function purge(tenantId: string, technicianId: string | null): Promise<void> {
  await withTenant({ tenantId }, async (tx) => {
    const jobs = (await tx.execute<{ id: string }>(sql`
      select id from jobs where reference like ${`${REFERENCE_PREFIX}-%`}
    `)) as unknown as { id: string }[];

    for (const job of jobs) {
      await tx.execute(sql`delete from job_fault_codes where job_id = ${job.id}::uuid`);
      await tx.execute(sql`delete from job_events where job_id = ${job.id}::uuid`);
      await tx.execute(sql`delete from job_visits where job_id = ${job.id}::uuid`);
      await tx.execute(sql`update jobs set outcome_code = null where id = ${job.id}::uuid`);
      await tx.execute(sql`delete from jobs where id = ${job.id}::uuid`);
    }

    await tx.execute(sql`delete from fault_codes where code like ${`${REFERENCE_PREFIX}-%`}`);
    await tx.execute(sql`delete from technician_certifications where name = ${`${TAG} permit`}`);
    if (technicianId) {
      await tx.execute(sql`
        delete from technician_skills
         where technician_id = ${technicianId}::uuid and service_slug = ${TEST_SERVICE}
      `);
    }
  });
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };

  // ── Fixtures ─────────────────────────────────────────────────────────────
  //
  // The subject must not be compliance-blocked: a blocked technician is
  // excluded before any of this runs, which is correct behaviour and would make
  // every assertion below vacuous.
  const roster = await withTenant(ctx, (tx) => listTechnicians(tx));
  const blockedIds = new Set((await withTenant(ctx, (tx) => blockedTechnicians(tx))).map((b) => b.technicianId));
  const subject = roster.find((t) => !blockedIds.has(t.id));
  if (!subject) {
    throw new Error(
      roster.length === 0
        ? "Seed data missing. Run `npm run db:seed` first."
        : "Every technician is compliance-blocked, so none can be a candidate.",
    );
  }

  await purge(TENANT, subject.id);

  const fixture = await withTenant(ctx, async (tx) => {
    const customer = (await tx.select({ id: schema.customers.id }).from(schema.customers).limit(1))[0];
    const property = (
      await tx
        .select({ id: schema.properties.id, lat: schema.properties.lat, lng: schema.properties.lng, city: schema.properties.city })
        .from(schema.properties)
        .limit(1)
    )[0];
    const user = (await tx.select({ id: schema.users.id }).from(schema.users).limit(1))[0];
    if (!customer || !property || !user) throw new Error("Seed data missing. Run `npm run db:seed`.");

    await tx.insert(schema.technicianSkills).values({
      tenantId: TENANT,
      technicianId: subject.id,
      serviceSlug: TEST_SERVICE,
      proficiency: 4,
      verifiedById: user.id,
    });

    const [assignable] = await tx
      .insert(schema.jobs)
      .values({
        tenantId: TENANT,
        reference: `${REFERENCE_PREFIX}-1`,
        customerId: customer.id,
        propertyId: property.id,
        serviceSlug: TEST_SERVICE,
        title: `${TAG} assignable`,
        status: "triaged",
      })
      .returning({ id: schema.jobs.id });

    const [onSite] = await tx
      .insert(schema.jobs)
      .values({
        tenantId: TENANT,
        reference: `${REFERENCE_PREFIX}-2`,
        customerId: customer.id,
        propertyId: property.id,
        serviceSlug: TEST_SERVICE,
        title: `${TAG} on site`,
        status: "on_site",
      })
      .returning({ id: schema.jobs.id });

    if (!assignable || !onSite) throw new Error("Could not create the job fixtures");
    return { property, assignableJobId: assignable.id, onSiteJobId: onSite.id };
  });

  const property = { lat: fixture.property.lat, lng: fixture.property.lng, city: fixture.property.city };
  const calendar = await withTenant(ctx, (tx) => loadWorkingCalendar(tx));

  // The window every assertion below is made against: the moment the working
  // day opens, three days out.
  //
  // Anchored to midnight and then advanced rather than taken from "now plus
  // three days", because "now" is whenever the suite happens to run. Starting
  // from an arbitrary time of day would put the window against the close on
  // some runs and not others, and a test that depends on the wall clock fails
  // for a reason that has nothing to do with the code.
  const workingStart = nextWorkingWindow(startOfDubaiDay(new Date(Date.now() + 3 * DAY)), {
    calendar,
  });
  const workingEnd = new Date(workingStart.getTime() + 2 * HOUR);

  // ── A clean candidate is one click ───────────────────────────────────────
  console.log("\n— a technician with the skill and nothing wrong —");

  const clean = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property, from: workingStart, to: workingEnd, calendar }),
  );
  checkTrue(
    "the skilled technician is offered",
    clean.candidates.some((c) => c.technicianId === subject.id),
  );
  checkTrue("and needs no override", clean.warned.length === 0);

  // ── JOB-8: outside working hours warns, and does not gate ────────────────
  //
  // The distinction the whole design rests on. A P1 emergency at 03:00 is
  // answered 24/7 by `JOB-4`; demanding a typed justification for every night
  // callout is the over-blocking that gets a control worked around, and a
  // workaround is invisible.
  console.log("\n— 03:00 is outside the working day, and that is a note, not a gate —");

  const openDay = toDubai(workingStart);
  const night = fromDubai(openDay.year, openDay.month, openDay.day, 2 * 60);
  const nightWarnings = (
    await withTenant(ctx, (tx) =>
      assignmentWarnings(tx, {
        technicianIds: [subject.id],
        serviceSlug: TEST_SERVICE,
        from: night,
        to: new Date(night.getTime() + HOUR),
        calendar,
      }),
    )
  ).get(subject.id);
  const outside = (nightWarnings ?? []).find((w) => w.type === "outside_working_hours");
  checkTrue("a window before the working day warns", outside !== undefined);
  check("and the warning does not demand a reason", outside?.requiresOverride, false);

  // ── HR-9 / JOB-9: an expiring certification moves the candidate ──────────
  console.log("\n— a certificate that lapses in twelve days —");

  const certId = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.technicianCertifications)
      .values({
        tenantId: TENANT,
        technicianId: subject.id,
        name: `${TAG} permit`,
        expiresOn: new Date(Date.now() + 12 * DAY),
        requiredForServices: [TEST_SERVICE],
      })
      .returning({ id: schema.technicianCertifications.id });
    return row?.id ?? null;
  });
  if (!certId) throw new Error("Could not create the certification fixture");

  const warned = await withTenant(ctx, (tx) =>
    findCandidates(tx, { serviceSlug: TEST_SERVICE, property, from: workingStart, to: workingEnd, calendar }),
  );
  checkTrue(
    "the technician is no longer a one-click candidate",
    !warned.candidates.some((c) => c.technicianId === subject.id),
  );
  const warnedCandidate = warned.warned.find((c) => c.technicianId === subject.id);
  checkTrue("they are offered against a warning instead", warnedCandidate !== undefined);
  checkTrue(
    "and the warning names the certificate",
    warnedCandidate?.warnings.some(
      (w) => w.type === "certification_expiring" && w.detail.includes(`${TAG} permit`),
    ) === true,
  );

  // ── JOB-10: the gate ─────────────────────────────────────────────────────
  //
  // This is the check the docstring on `assignTechnician` used to promise and
  // nothing performed. Every refusal below returned a visit id before this
  // work: the override columns were accepted, written as null, and no caller
  // ever passed one.
  console.log("\n— assigning past the warning without a reason —");

  const silent = await refusal(() =>
    withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: fixture.assignableJobId,
        technicianId: subject.id,
        scheduledStart: workingStart,
        scheduledEnd: workingEnd,
        calendar,
      }),
    ),
  );
  checkTrue("a silent override is refused", silent !== null);
  checkTrue("and the refusal is safe to show a dispatcher", silent?.userFacing === true);
  checkTrue("and asks for a reason", (silent?.message ?? "").includes("recorded reason"));
  checkTrue("and names the warning", (silent?.message ?? "").includes(`${TAG} permit`));

  const tooShort = await refusal(() =>
    withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: fixture.assignableJobId,
        technicianId: subject.id,
        scheduledStart: workingStart,
        scheduledEnd: workingEnd,
        overrideWarningType: "certification_expiring",
        overrideReason: "ok",
        calendar,
      }),
    ),
  );
  checkTrue("a two-character reason is refused", tooShort !== null);

  const staleType = await refusal(() =>
    withTenant(ctx, (tx) =>
      assignTechnician(tx, ctx, {
        jobId: fixture.assignableJobId,
        technicianId: subject.id,
        scheduledStart: workingStart,
        scheduledEnd: workingEnd,
        // The dispatcher was looking at something that is not what is wrong.
        overrideWarningType: "on_leave",
        overrideReason: "Renewal is booked for Thursday and nobody else is within 40 km",
        calendar,
      }),
    ),
  );
  checkTrue("acknowledging a warning that is not current is refused", staleType !== null);
  checkTrue(
    "and says the panel is out of date",
    (staleType?.message ?? "").includes("changed since the panel was drawn"),
  );

  console.log("\n— assigning past the warning with one —");

  const REASON = "Renewal is booked for Thursday and nobody else is within 40 km";
  const assigned = await withTenant(ctx, (tx) =>
    assignTechnician(tx, ctx, {
      jobId: fixture.assignableJobId,
      technicianId: subject.id,
      scheduledStart: workingStart,
      scheduledEnd: workingEnd,
      overrideWarningType: "certification_expiring",
      overrideReason: REASON,
      calendar,
    }),
  );
  checkTrue("the assignment is taken", assigned.visitId.length > 0);
  check("and reports what was overridden", assigned.overrode[0]?.type, "certification_expiring");

  const visitRow = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        type: schema.jobVisits.overrideWarningType,
        reason: schema.jobVisits.overrideReason,
      })
      .from(schema.jobVisits)
      .where(eq(schema.jobVisits.id, assigned.visitId))
      .limit(1);
    return rows[0] ?? null;
  });
  check("the warning type is on the visit", visitRow?.type, "certification_expiring");
  check("and so is the reason", visitRow?.reason, REASON);

  // ── JOB-8: already booked, and the statutory day ─────────────────────────
  console.log("\n— the diary conflicts JOB-8 asks for —");

  const afterBooking = (
    await withTenant(ctx, (tx) =>
      assignmentWarnings(tx, {
        technicianIds: [subject.id],
        serviceSlug: TEST_SERVICE,
        from: workingStart,
        to: workingEnd,
        calendar,
      }),
    )
  ).get(subject.id);
  checkTrue(
    "the visit just created is a clash",
    (afterBooking ?? []).some((w) => w.type === "double_booked"),
  );
  checkTrue(
    "and the clash demands a reason",
    (afterBooking ?? []).find((w) => w.type === "double_booked")?.requiresOverride === true,
  );

  const longDay = (
    await withTenant(ctx, (tx) =>
      assignmentWarnings(tx, {
        technicianIds: [subject.id],
        serviceSlug: TEST_SERVICE,
        from: workingStart,
        to: new Date(workingStart.getTime() + 9 * HOUR),
        calendar,
      }),
    )
  ).get(subject.id);
  checkTrue(
    "a nine-hour booking trips the statutory eight-hour day",
    (longDay ?? []).some((w) => w.type === "daily_hours_exceeded"),
  );

  // ── JOB-13: the outcome ──────────────────────────────────────────────────
  console.log("\n— recording what happened (JOB-13) —");

  const bogus = await refusal(() =>
    withTenant(ctx, (tx) =>
      recordJobOutcome(tx, ctx, { jobId: fixture.onSiteJobId, outcomeCode: "sort-of-done" }),
    ),
  );
  checkTrue("an outcome outside the controlled list is refused", bogus !== null);
  checkTrue("and readably", bogus?.userFacing === true);
  checkTrue(
    "and points at the screen that maintains it",
    (bogus?.message ?? "").includes("Reference data"),
  );

  const completed = await withTenant(ctx, (tx) =>
    recordJobOutcome(tx, ctx, {
      jobId: fixture.onSiteJobId,
      outcomeCode: "no_access",
      note: `${TAG} nobody on site`,
    }),
  );
  check("the outcome is recorded", completed.outcomeCode, "no_access");
  checkTrue("and it is one that leaves work owing", completed.requiresReturnVisit);
  checkTrue("and the job moved to work complete in the same transaction", completed.transitioned);

  const afterOutcome = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: schema.jobs.status, outcome: schema.jobs.outcomeCode })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, fixture.onSiteJobId))
      .limit(1);
    return rows[0] ?? null;
  });
  check("the job carries the code", afterOutcome?.outcome, "no_access");
  check("and the status", afterOutcome?.status, "work_complete");

  // The database agrees, independently of the application. `0024` puts a
  // composite foreign key behind the column; without it the check above only
  // proves that this code path validates, and every other write path does not.
  const fkRefusal = await refusal(() =>
    withTenant(ctx, (tx) =>
      tx.execute(sql`
        update jobs set outcome_code = 'invented-by-hand' where id = ${fixture.onSiteJobId}::uuid
      `),
    ),
  );
  checkTrue("the database refuses an outcome code that is not in the list", fkRefusal !== null);

  // ── JOB-14: the three-part taxonomy ──────────────────────────────────────
  console.log("\n— coding the fault (JOB-14) —");

  await withTenant(ctx, async (tx) => {
    await addFaultCode(tx, ctx, {
      kind: "symptom",
      code: `${REFERENCE_PREFIX}-sym`,
      label: `${TAG} no cooling`,
      serviceSlug: TEST_SERVICE,
    });
    await addFaultCode(tx, ctx, {
      kind: "cause",
      code: `${REFERENCE_PREFIX}-cause`,
      label: `${TAG} blocked filter`,
      serviceSlug: TEST_SERVICE,
    });
    await addFaultCode(tx, ctx, {
      kind: "remedy",
      code: `${REFERENCE_PREFIX}-rem`,
      label: `${TAG} filter replaced`,
      serviceSlug: TEST_SERVICE,
    });
  });

  const codes = await withTenant(ctx, (tx) => listFaultCodes(tx, { serviceSlug: TEST_SERVICE }));
  const symptom = codes.find((c) => c.code === `${REFERENCE_PREFIX}-sym`);
  const cause = codes.find((c) => c.code === `${REFERENCE_PREFIX}-cause`);
  const remedy = codes.find((c) => c.code === `${REFERENCE_PREFIX}-rem`);
  if (!symptom || !cause || !remedy) throw new Error("Could not create the fault code fixtures");

  const wrongKind = await refusal(() =>
    withTenant(ctx, (tx) =>
      recordJobOutcome(tx, ctx, {
        jobId: fixture.onSiteJobId,
        outcomeCode: "completed",
        // A remedy filed as a cause is silent nonsense in every later query: it
        // groups, it charts, and it is wrong.
        causeCodeId: remedy.id,
      }),
    ),
  );
  checkTrue("a remedy recorded as a cause is refused", wrongKind !== null);
  checkTrue(
    "and says which is which",
    (wrongKind?.message ?? "").includes("is a remedy, not a cause"),
  );

  await withTenant(ctx, (tx) =>
    recordJobOutcome(tx, ctx, {
      jobId: fixture.onSiteJobId,
      outcomeCode: "completed",
      symptomCodeId: symptom.id,
      causeCodeId: cause.id,
      remedyCodeId: remedy.id,
    }),
  );

  const capture = await withTenant(ctx, (tx) => getJobOutcome(tx, fixture.onSiteJobId));
  check("the outcome was corrected", capture.outcomeCode, "completed");
  check("all three parts are recorded", capture.faultCodes.length, 3);
  checkTrue(
    "and each is the right kind",
    ["symptom", "cause", "remedy"].every((k) => capture.faultCodes.some((f) => f.kind === k)),
  );

  // Re-recording is a correction, not an accumulation. Two causes on one job
  // reads as a two-fault job to every report that counts them.
  await withTenant(ctx, (tx) =>
    recordJobOutcome(tx, ctx, {
      jobId: fixture.onSiteJobId,
      outcomeCode: "completed",
      symptomCodeId: symptom.id,
    }),
  );
  const rerecorded = await withTenant(ctx, (tx) => getJobOutcome(tx, fixture.onSiteJobId));
  check("re-recording replaces rather than accumulates", rerecorded.faultCodes.length, 1);

  // ── The tenant boundary ──────────────────────────────────────────────────
  //
  // Asserted through `activeTenantIds()` and only when a second tenant really
  // exists, so this cannot print as a skip while claiming to have run.
  console.log("\n— a fault code from another tenant is not recordable —");

  const otherTenantId = (await activeTenantIds()).find((id) => id !== TENANT) ?? null;
  if (!otherTenantId) {
    fail++;
    console.log("FAIL  no second tenant, so cross-tenant isolation was not proven — run db:seed");
  } else {
    const otherCtx = { tenantId: otherTenantId };
    await withTenant(otherCtx, (tx) =>
      addFaultCode(tx, otherCtx, {
        kind: "cause",
        code: `${REFERENCE_PREFIX}-foreign`,
        label: `${TAG} foreign cause`,
      }),
    );
    const foreign = (
      await withTenant(otherCtx, (tx) => listFaultCodes(tx, { kind: "cause" }))
    ).find((c) => c.code === `${REFERENCE_PREFIX}-foreign`);
    checkTrue("the fixture exists in the other tenant", foreign !== undefined);

    if (foreign) {
      const crossed = await refusal(() =>
        withTenant(ctx, (tx) =>
          recordJobOutcome(tx, ctx, {
            jobId: fixture.onSiteJobId,
            outcomeCode: "completed",
            causeCodeId: foreign.id,
          }),
        ),
      );
      checkTrue("and cannot be recorded from this one", crossed !== null);
      checkTrue(
        "because RLS makes it invisible rather than forbidden",
        (crossed?.message ?? "").includes("no longer exists"),
      );
    }

    await withTenant(otherCtx, (tx) =>
      tx.execute(sql`delete from fault_codes where code = ${`${REFERENCE_PREFIX}-foreign`}`),
    );
  }

  // ── Clean-up: nothing this test wrote should outlive it ──────────────────
  await purge(TENANT, subject.id);

  console.log(fail === 0 ? "\nall assignment checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});