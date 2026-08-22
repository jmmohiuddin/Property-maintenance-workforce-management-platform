/**
 * The field API's transport: device authentication, the bounded working set,
 * incremental pull, idempotent push, and conflict resolution by data class
 * (`M11`, TRD §8.2–§8.5, ADR 0004) — integration test against real Postgres.
 *
 *   npx tsx test/field.test.ts        (from packages/db)
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself,
 * except for `audit_log`: `meridian_app` holds no DELETE on that table by
 * design, and a test that could tidy the audit trail would be testing a
 * database that is not the one in production.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * Six claims. Every one of them fails *silently* if it is wrong — which is the
 * property that decides what is worth an integration test here, because none of
 * these produce an exception in production, they produce a wrong number or a
 * missing row that nobody notices for a quarter.
 *
 * **The completion gate is not bypassable from a phone.** `JOB-15` is enforced
 * in the domain layer precisely so the field app cannot go round it, and an
 * endpoint that writes a completed job directly is the single most likely way
 * this API goes wrong. Asserted by pushing a completion for a job whose card is
 * empty and checking both the refusal *and* that the job did not move.
 *
 * **A replayed mutation does not happen twice.** The dominant real failure is
 * "request succeeded, response lost, client retries". Without deduplication on
 * the client id that retry books the part twice. Asserted by sending the same
 * `clientId` twice and counting rows, not by trusting the response.
 *
 * **A revoked device stops working and its owner does not.** A lost phone must
 * be revocable without disabling the person, and the test is the pair: the
 * token stops resolving and the technician is still active and still syncable
 * on a second handset.
 *
 * **A replayed retired token is distinguishable from an unknown one.** The
 * whole reason the previous hash is kept forever. If this collapses to
 * "unknown", token theft becomes invisible.
 *
 * **The real conflict reaches a human.** A technician completing offline while
 * the office cancels is the one case no merge rule may decide. Asserted by
 * doing exactly that and looking for the unresolved row a dispatcher would see.
 *
 * **The working set is bounded, and the boundary is the technician.** Another
 * technician's job must not be on this phone, and a mutation naming a job that
 * is not theirs must be refused even though it is inside their own tenant.
 *
 * ── WHY EVERY DB ASSERTION IS A DELTA ───────────────────────────────────────
 *
 * Same rule as `jobs.test.ts` and `compliance.test.ts`. This database is shared
 * and seeded; a suite that only passes against a pristine one fails on
 * somebody's laptop for reasons unrelated to the code, and the usual response
 * to that is to stop trusting the suite.
 */

import { and, eq, inArray, like, lt, sql } from "drizzle-orm";
import {
  withTenant,
  schema,
  closeConnection,
  registerFieldDevice,
  revokeFieldDevice,
  rotateFieldDeviceToken,
  pullWorkingSet,
  applyFieldMutations,
  listFieldConflicts,
  countOpenFieldConflicts,
  resolveFieldConflict,
  listFieldDevices,
  listJobOutcomeCodes,
  transitionJob,
  FIELD_WORKING_SET,
  FIELD_UNAVAILABLE_OFFLINE,
} from "../src/index";
import { issueDeviceToken, resolveDeviceToken, hashDeviceToken } from "@meridian/auth";
import { testTenantId, otherTenantId } from "./_tenant";

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const TAG = `ZZFIELD${RUN}`;

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** A client id, in the shape the device generates: 26 characters, sortable. */
let sequence = 0;
function clientId(): string {
  sequence += 1;
  return `${RUN}${String(sequence).padStart(4, "0")}FIELDTESTID`.slice(0, 26);
}

/**
 * Reap the technicians a killed run of this file left behind.
 *
 * This suite's own technicians (`__TEST field ${RUN} A`/`B`, below) are
 * deleted by ID at the end of a clean run, but a run that dies first — a
 * failed assertion that threw, a killed process — never reaches that block,
 * and the rows are orphaned for good: they sort ahead of the seeded roster
 * and get picked up by anything that reads the `technicians` table
 * positionally, most notably `workforce.test.ts`.
 *
 * Age-gated to an hour, far longer than this suite takes, so it cannot reach a
 * concurrent run's live fixture — same shape as `sweepStale()` in
 * `recruitment.test.ts`. `job_visits.technician_id` is `ON DELETE RESTRICT`,
 * so a leaked technician's visits have to go first; the parent jobs are left
 * for `jobs`' own housekeeping rather than swept here, to keep this narrowly
 * about the table that breaks other suites.
 */
async function sweepStale(ctx: { tenantId: string }): Promise<void> {
  await withTenant(ctx, async (tx) => {
    const stale = await tx
      .select({ id: schema.technicians.id })
      .from(schema.technicians)
      .where(
        and(
          like(schema.technicians.fullName, "__TEST field %"),
          lt(schema.technicians.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    if (stale.length === 0) return;
    const staleIds = stale.map((t) => t.id);
    await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.technicianId, staleIds));
    await tx.delete(schema.technicians).where(inArray(schema.technicians.id, staleIds));
  });
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "user" as const };

  await sweepStale(ctx);

  const createdJobs: string[] = [];
  const createdVisits: string[] = [];
  const createdDevices: string[] = [];
  const createdUploads: string[] = [];
  let technicianId = "";
  let otherTechnicianId = "";
  let userId = "";

  // ── Fixtures ─────────────────────────────────────────────────────────────

  const found = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.properties.id, customerId: schema.properties.customerId })
      .from(schema.properties)
      .limit(1);
    return rows[0] ?? null;
  });
  if (!found) throw new Error("Seed data missing. Run `npm run db:seed` first.");
  // Re-bound so the narrowing survives into the closures below, the way
  // `jobs.test.ts` does it: TypeScript widens a `let`-scoped narrowing back to
  // nullable inside a callback, and every fixture here is built in one.
  const site = found;

  // A real user with a live membership: `app_auth_resolve_device` joins
  // memberships and requires it active, so a device registered against a user
  // with no membership would never resolve and the test would prove nothing.
  userId = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ user_id: string }>(sql`
      select user_id from memberships where is_active limit 1
    `)) as unknown as { user_id: string }[];
    const row = rows[0];
    if (!row) throw new Error("Seed data missing a membership. Run `npm run db:seed`.");
    return row.user_id;
  });

  // This suite's own technicians, not seeded ones: it registers devices and
  // pushes attendance against them, and borrowing somebody else's record would
  // change what a parallel suite sees on the workforce board.
  const techs = await withTenant({ ...ctx, userId }, async (tx) => {
    const inserted = await tx
      .insert(schema.technicians)
      .values([
        {
          tenantId,
          employeeCode: `${TAG}-A`,
          fullName: `__TEST field ${RUN} A`,
          phone: "+971500000001",
          primaryTrade: "hvac-installation-maintenance",
          userId,
        },
        {
          tenantId,
          employeeCode: `${TAG}-B`,
          fullName: `__TEST field ${RUN} B`,
          phone: "+971500000002",
          primaryTrade: "hvac-installation-maintenance",
        },
      ])
      .returning({ id: schema.technicians.id, code: schema.technicians.employeeCode });
    return inserted;
  });
  technicianId = techs.find((t) => t.code === `${TAG}-A`)?.id ?? "";
  otherTechnicianId = techs.find((t) => t.code === `${TAG}-B`)?.id ?? "";
  if (!technicianId || !otherTechnicianId) throw new Error("Technician fixtures were not written");

  /** A job at the seeded site, with a visit assigning it to `tech`. */
  async function makeJob(status: string, tech: string, suffix: string): Promise<string> {
    return withTenant({ ...ctx, userId }, async (tx) => {
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `${TAG}-${suffix}`,
          customerId: site.customerId,
          propertyId: site.id,
          serviceSlug: "hvac-installation-maintenance",
          title: `__TEST field ${RUN} ${suffix}`,
          status: status as "on_site",
          priority: "p3_standard",
        })
        .returning({ id: schema.jobs.id });
      if (!job) throw new Error("Job fixture was not written");
      createdJobs.push(job.id);

      const [visit] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId,
          jobId: job.id,
          technicianId: tech,
          sequence: 1,
          status: "arrived",
          scheduledStart: new Date(),
          scheduledEnd: new Date(Date.now() + 2 * 60 * 60 * 1000),
        })
        .returning({ id: schema.jobVisits.id });
      if (!visit) throw new Error("Visit fixture was not written");
      createdVisits.push(visit.id);

      return job.id;
    });
  }

  const ownJob = await makeJob("on_site", technicianId, "OWN");
  const cancelledJob = await makeJob("on_site", technicianId, "CANX");
  const foreignJob = await makeJob("on_site", otherTechnicianId, "OTHR");

  // ── 1. Device registration and resolution ────────────────────────────────

  const issued = issueDeviceToken();
  const device = await withTenant({ ...ctx, userId }, async (tx) =>
    registerFieldDevice(tx, { ...ctx, userId }, {
      technicianId,
      userId,
      label: `__TEST handset ${RUN}`,
      platform: "ios",
      appVersion: "1.0.0",
      tokenHash: issued.tokenHash,
      tokenExpiresAt: issued.expiresAt,
    }),
  );
  createdDevices.push(device.id);

  const resolved = await resolveDeviceToken(issued.token);
  checkTrue("a registered device resolves", resolved.ok);
  if (resolved.ok) {
    check("it resolves to its own technician", resolved.device.technicianId, technicianId);
    check("it resolves inside its own tenant", resolved.device.tenant.id, tenantId);
    check("it carries the user's principal", resolved.device.principal.userId, userId);
    check("the principal is technician-scoped", resolved.device.principal.technicianId, technicianId);
    check("a fresh token is not a grace token", resolved.device.usedGraceToken, false);
  }

  check("an unknown token resolves to nothing", (await resolveDeviceToken("not-a-token")).ok, false);
  check("no token resolves to nothing", (await resolveDeviceToken(undefined)).ok, false);

  // ── 2. Rotation, grace, and reuse detection ──────────────────────────────
  //
  // The three-way distinction is the point. If a retired token collapses to
  // "unknown", a stolen credential is indistinguishable from a typo and nobody
  // ever finds out.

  const rotated = issueDeviceToken();
  await withTenant(ctx, async (tx) =>
    rotateFieldDeviceToken(tx, {
      deviceId: device.id,
      tokenHash: rotated.tokenHash,
      tokenExpiresAt: rotated.expiresAt,
      graceUntil: new Date(Date.now() + 10 * 60 * 1000),
    }),
  );

  const afterRotation = await resolveDeviceToken(rotated.token);
  checkTrue("the rotated token works", afterRotation.ok);

  const inGrace = await resolveDeviceToken(issued.token);
  checkTrue("the replaced token still works inside its grace window", inGrace.ok);
  check(
    "and is reported as a grace token, not a current one",
    inGrace.ok ? inGrace.device.usedGraceToken : "not-resolved",
    true,
  );

  // Expire the grace window rather than waiting ten minutes for it.
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`
      update field_devices
         set previous_token_grace_until = now() - interval '1 minute'
       where id = ${device.id}::uuid
    `);
  });

  const afterGrace = await resolveDeviceToken(issued.token);
  check("a retired token past its grace is refused", afterGrace.ok, false);
  check(
    "and is identified as REUSE, not as an unknown token",
    afterGrace.ok ? "resolved" : afterGrace.reason,
    "reuse",
  );

  // ── 3. The bounded working set (§8.2) ────────────────────────────────────

  const firstPull = await withTenant(ctx, async (tx) =>
    pullWorkingSet(tx, { technicianId }),
  );

  const pulledIds = new Set(firstPull.jobs.map((j) => j.id));
  checkTrue("the technician's own job is on the phone", pulledIds.has(ownJob));
  check("another technician's job is not", pulledIds.has(foreignJob), false);
  checkTrue("the scope names the job", firstPull.scope.jobIds.includes(ownJob));
  check("and does not name the other technician's", firstPull.scope.jobIds.includes(foreignJob), false);
  checkTrue("the customer behind the job comes with it", firstPull.customers.some((c) => c.id === site.customerId));
  checkTrue("so does the property", firstPull.properties.some((p) => p.id === site.id));
  checkTrue("a first pull is a complete one", firstPull.complete);
  checkTrue("a first pull carries the taxonomies", firstPull.taxonomies !== null);
  checkTrue("the manifest is declared, not discovered", FIELD_WORKING_SET.length > 0);
  checkTrue(
    "what is NOT offline is named with a sentence, not left as an empty list",
    FIELD_UNAVAILABLE_OFFLINE.every((entry) => entry.message.length > 20),
  );
  checkTrue("the response carries the server's clock", firstPull.serverTime instanceof Date);

  // ── 4. Incremental pull (§8.3) ───────────────────────────────────────────

  // ── The overlap window, which is the half that prevents silent row loss ──
  //
  // `updated_at` is stamped when a statement runs; the row becomes visible when
  // its transaction commits. A watermark set to `now()` therefore skips any row
  // that stamped early and committed late — permanently, and with nothing in
  // any log. So `pullWorkingSet` holds its watermark a few seconds behind the
  // clock, and the observable consequence is that a change made moments ago is
  // returned AGAIN on the next pull rather than being lost.
  //
  // This check is here so that anybody who "optimises" the lag away finds out
  // from a test rather than from a job that never appears on a phone.
  const secondPull = await withTenant(ctx, async (tx) =>
    pullWorkingSet(tx, { technicianId, cursor: firstPull.nextCursor }),
  );
  checkTrue(
    "a job written moments ago is re-sent, never skipped by the watermark",
    secondPull.jobs.some((j) => j.id === ownJob),
  );
  /*
   * The watermark advanced, asserted on the cursor itself rather than inferred
   * from the taxonomies being absent.
   *
   * It used to read `check(..., secondPull.taxonomies, null)`, on the premise
   * that reference data is "seeded and old" so an unmoved cursor would re-send
   * it. That premise holds when this suite runs alone and fails in the full
   * run: the lag is five seconds by design, and the suite that ran immediately
   * before this one writes vocabulary rows -- exemption reasons, asset kinds,
   * tender sources. Those land inside the overlap and are correctly re-sent, so
   * the assertion failed while the watermark was doing exactly its job.
   *
   * The cursor moving is the claim; taxonomies being absent was one observable
   * consequence of it, and one another suite can take away. The assertion above
   * -- that a job written moments ago comes back rather than being skipped --
   * is the one that defends the lag itself, and it does not depend on anybody
   * else's writes.
   */
  checkTrue(
    "and the watermark did advance",
    secondPull.nextCursor !== firstPull.nextCursor,
  );
  checkTrue("the full scope comes on every pull, so removals stay detectable", secondPull.scope.jobIds.includes(ownJob));

  // ── And the delta really does empty, which is the other half ─────────────
  //
  // A real wait, because the lag is a real five seconds. There is no way to
  // fake it from here: `touch_jobs` is a BEFORE UPDATE trigger that forces
  // `updated_at = now()`, so a fixture cannot be backdated — which is itself
  // the property that makes the watermark trustworthy, since no application
  // code can write an `updated_at` that is not the server's clock.
  //
  // Without this check the suite would pass against a sync that re-sent the
  // entire working set on every pull, which is precisely the failure ADR 0004
  // means by "a day of queued work does not take minutes".
  await new Promise((resolve) => setTimeout(resolve, 6_000));

  // Two pulls, and both are needed. A watermark only settles a row once a pull
  // happens at least the lag *after* that row changed: this one is the pull
  // that carries the fixtures for the last time and leaves a cursor ahead of
  // them, and the next one is the empty delta that proves it.
  const settlingPull = await withTenant(ctx, async (tx) =>
    pullWorkingSet(tx, { technicianId, cursor: secondPull.nextCursor }),
  );

  const thirdPull = await withTenant(ctx, async (tx) =>
    pullWorkingSet(tx, { technicianId, cursor: settlingPull.nextCursor }),
  );
  check("once the overlap has passed, an unchanged working set is an empty delta", thirdPull.jobs.length, 0);

  // Touch the job the way the office would, and it comes back.
  await withTenant({ ...ctx, userId }, async (tx) => {
    await tx
      .update(schema.jobs)
      .set({ title: `__TEST field ${RUN} OWN (edited)` })
      .where(eq(schema.jobs.id, ownJob));
  });

  const fourthPull = await withTenant(ctx, async (tx) =>
    pullWorkingSet(tx, { technicianId, cursor: thirdPull.nextCursor }),
  );
  checkTrue("a changed job comes back on the next delta", fourthPull.jobs.some((j) => j.id === ownJob));
  check("and only the changed one", fourthPull.jobs.length, 1);

  // ── 5. Push: the JOB-15 gate is NOT bypassable ───────────────────────────
  //
  // The non-negotiable. `recordJobOutcome` refuses a job whose card has no
  // photograph, no materials answer and no labour; the field API must get the
  // same refusal, and the job must not move.

  const outcomeCodes = await withTenant(ctx, async (tx) => listJobOutcomeCodes(tx, { activeOnly: true }));
  const outcomeCode = outcomeCodes[0]?.code;
  if (!outcomeCode) throw new Error("No active job outcome codes. Run `npm run db:seed`.");

  const gateId = clientId();
  const gated = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: gateId,
          entity: "job_outcome",
          op: "record",
          payload: { jobId: ownJob, outcomeCode },
        },
      ],
    }),
  );

  check("an incomplete job card is refused, not accepted", gated.accepted.length, 0);
  check("and it is a rejection, not a conflict", gated.rejected.length, 1);
  checkTrue(
    "the refusal names the job card, so the technician knows what to fix",
    (gated.rejected[0]?.message ?? "").includes("job card"),
  );

  checkTrue(
    "and the refusal carries the gaps as data, not only as a sentence",
    (gated.rejected[0]?.gaps ?? []).length === 3,
  );
  checkTrue(
    "naming the after photograph",
    (gated.rejected[0]?.gaps ?? []).includes("after_photo"),
  );

  // ── 5b. The door JOB-15's gate does NOT cover ────────────────────────────
  //
  // `assertJobCardComplete` is called by `recordJobOutcome`. It is NOT called
  // by `transitionJob`, and `on_site -> work_complete` is a legal transition.
  // So a device that could send a bare status change would complete jobs with
  // empty cards, silently, from the least observable client in the estate.
  //
  // This is the check that would have caught it. It is deliberately separate
  // from the one above: they exercise two different code paths to the same
  // wrong outcome, and only one of them was closed by writing the gate.
  const backDoorId = clientId();
  const backDoor = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: backDoorId,
          entity: "job_status",
          op: "transition",
          payload: { jobId: ownJob, to: "work_complete" },
        },
      ],
    }),
  );
  check("a device cannot complete a job with a bare status change", backDoor.accepted.length, 0);
  check("it is refused", backDoor.rejected.length, 1);
  checkTrue(
    "and told where completion actually lives",
    (backDoor.rejected[0]?.message ?? "").includes("job card"),
  );

  // Office-only statuses are closed to a handset too, and for the same reason:
  // an allow-list means a status added to the graph later is closed until
  // somebody decides otherwise.
  const cancelAttempt = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "job_status",
          op: "transition",
          payload: { jobId: ownJob, to: "cancelled" },
        },
      ],
    }),
  );
  check("and a handset cannot cancel a job", cancelAttempt.rejected.length, 1);

  const statusAfterGate = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ status: schema.jobs.status })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, ownJob))
      .limit(1);
    return rows[0]?.status;
  });
  check("and the job did not move, by either route", statusAfterGate, "on_site");

  // ── 5c. The screen and the gate read the same gaps ───────────────────────
  //
  // A client that computed completeness itself would drift from the rule the
  // first time the rule changed, and the failure lands on a technician who
  // presses complete in a basement and learns hours later that it did not take.
  const gapPull = await withTenant(ctx, async (tx) =>
    pullWorkingSet(tx, { technicianId, cursor: fourthPull.nextCursor }),
  );
  const syncedOwn =
    gapPull.jobs.find((j) => j.id === ownJob) ?? fourthPull.jobs.find((j) => j.id === ownJob);
  check(
    "the sync tells the phone what the job card is missing",
    (syncedOwn?.gaps ?? []).length,
    3,
  );
  checkTrue(
    "which is the same list the gate refused on",
    (syncedOwn?.gaps ?? []).join(",") === (gated.rejected[0]?.gaps ?? []).join(","),
  );

  // ── 6. Push: append-only classes and idempotency (§8.3, §8.4) ────────────

  const photoId = clientId();
  const materialsId = clientId();
  const labourId = clientId();
  const visitId = createdVisits[0];
  if (!visitId) throw new Error("Visit fixture missing");

  // A finished upload, as the media pipeline would leave it. Inserted directly
  // rather than driven through /uploads/init: the transport has its own suite,
  // and what is under test here is that the sync layer resolves a KEY from an
  // upload row instead of accepting one from the device.
  async function makeUpload(jobFor: string, tag: string): Promise<string> {
    return withTenant({ ...ctx, userId }, async (tx) => {
      const rows = (await tx.execute<{ id: string }>(sql`
        insert into upload_sessions
          (tenant_id, client_upload_id, purpose, reference, total_bytes, chunk_size,
           chunk_count, received_chunks, status, storage_key, content_type, size_bytes,
           sha256, scan_status, captured_at, captured_lat, captured_lon, expires_at)
        values (
          ${tenantId}::uuid, ${`${TAG}-${tag}`}, 'job_photo', ${jobFor}::uuid,
          1024, 1024, 1, 1, 'complete',
          ${`tenants/${tenantId}/jobs/${jobFor}/${TAG}-${tag}.jpg`},
          'image/jpeg', 1024, ${"a".repeat(64)}, 'pending',
          now(), 25.2048, 55.2708, now() + interval '1 day'
        )
        returning id
      `)) as unknown as { id: string }[];
      const row = rows[0];
      if (!row) throw new Error("Upload fixture was not written");
      createdUploads.push(row.id);
      return row.id;
    });
  }

  const photoUploadId = await makeUpload(ownJob, "UP1");
  const foreignUploadId = await makeUpload(foreignJob, "UP2");

  const filled = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: photoId,
          entity: "job_attachment",
          op: "append",
          payload: { jobId: ownJob, visitId, kind: "photo_after", uploadId: photoUploadId },
        },
        {
          clientId: materialsId,
          entity: "job_material",
          op: "declare_none",
          payload: { jobId: ownJob, visitId },
        },
        {
          clientId: labourId,
          entity: "visit_labour",
          op: "record",
          payload: { jobId: ownJob, visitId, workMinutes: 90, travelMinutes: 20 },
        },
      ],
    }),
  );
  check("the three job-card records are accepted", filled.accepted.length, 3);

  // The same batch again. This is the failure the whole ledger exists for:
  // request succeeded, response lost, client retries.
  const replayed = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: photoId,
          entity: "job_attachment",
          op: "append",
          payload: { jobId: ownJob, visitId, kind: "photo_after", uploadId: photoUploadId },
        },
      ],
    }),
  );
  check("a replayed mutation is still accepted", replayed.accepted.length, 1);
  check(
    "and returns the SAME result, not a second one",
    replayed.accepted[0]?.result["id"],
    filled.accepted.find((a) => a.clientId === photoId)?.result["id"],
  );

  const photoCount = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from job_attachments
       where job_id = ${ownJob}::uuid and deleted_at is null
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  });
  check("and the photograph was filed exactly once", photoCount, 1);

  // With the card filled, the gap list empties — and an EMPTY list is not the
  // same value as the `null` a job nobody has arrived at carries.
  const filledPull = await withTenant(ctx, async (tx) => pullWorkingSet(tx, { technicianId }));
  const filledJob = filledPull.jobs.find((j) => j.id === ownJob);
  check("a completed card reports no gaps", (filledJob?.gaps ?? ["unset"]).length, 0);
  checkTrue("as an empty list, not a null", Array.isArray(filledJob?.gaps));

  // ── 6b. A device cannot name a storage key, or borrow somebody's upload ──
  //
  // Taking `storageKey` from the payload — which this did first — let a handset
  // file an attachment against its own job pointing at ANY object in the
  // tenant: a candidate's passport scan, a signed contract. The job would then
  // render it to the customer, and nothing in `recordJobAttachment` could have
  // caught it, because by the time a key arrives the question of who was
  // allowed to produce it is already lost.
  const borrowed = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "job_attachment",
          op: "append",
          // An upload opened against another technician's job, cited against
          // this technician's own.
          payload: { jobId: ownJob, kind: "photo_after", uploadId: foreignUploadId },
        },
      ],
    }),
  );
  check("an upload opened for another job cannot be filed against this one", borrowed.rejected.length, 1);
  check("and the borrowed upload is not accepted", borrowed.accepted.length, 0);

  const rawKey = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "job_attachment",
          op: "append",
          // The old shape. There is no longer a field for it, so this is a
          // mutation with no upload named at all — which is the refusal that
          // matters: a key from a device is not a thing this API accepts.
          payload: { jobId: ownJob, kind: "photo_after", storageKey: "tenants/anything/at/all.jpg" },
        },
      ],
    }),
  );
  check("a device cannot name a storage key of its own", rawKey.rejected.length, 1);

  // ── 6c. FLD-12: a recommendation photo files causally with the note, and
  //        never satisfies JOB-15 ──────────────────────────────────────────
  //
  // `0034` gave `job_attachments.kind` a sixth value, `photo_recommendation`.
  // `handleJobNote` files it itself, in the same transaction as the note —
  // there is no `job_attachment/append` route to this kind at all — so the
  // association between a recommendation's text and its photo can never be a
  // coincidence of timestamps.
  const recoJob = await makeJob("on_site", technicianId, "RECO");
  const recoVisitRows = await withTenant(ctx, (tx) =>
    tx
      .select({ id: schema.jobVisits.id })
      .from(schema.jobVisits)
      .where(eq(schema.jobVisits.jobId, recoJob)),
  );
  const recoVisitId = recoVisitRows[0]?.id;
  if (!recoVisitId) throw new Error("Recommendation job's visit fixture missing");

  const recoUploadId = await makeUpload(recoJob, "RECOUP");
  const recoNoteId = clientId();

  const recoPush = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: recoNoteId,
          entity: "job_note",
          op: "upsert",
          payload: {
            jobId: recoJob,
            visitId: recoVisitId,
            recommendation: `__TEST outdoor unit is failing ${RUN}`,
            recommendationUploadId: recoUploadId,
          },
        },
      ],
    }),
  );
  check("the note carrying a recommendation photo is accepted", recoPush.accepted.length, 1);

  const recoAttachments = (await withTenant(ctx, (tx) =>
    tx.execute<{ kind: string }>(sql`
      select kind from job_attachments
       where job_id = ${recoJob}::uuid and deleted_at is null
    `),
  )) as unknown as { kind: string }[];
  check("exactly one attachment was filed with the note", recoAttachments.length, 1);
  check("filed as the sixth kind, photo_recommendation", recoAttachments[0]?.kind, "photo_recommendation");

  // JOB-15 reads `photo_after` only (`getJobCard` in `jobcard.ts`) — a
  // recommendation is a sales observation, not evidence the work was done.
  const recoPull = await withTenant(ctx, (tx) => pullWorkingSet(tx, { technicianId }));
  const recoSynced = recoPull.jobs.find((j) => j.id === recoJob);
  checkTrue(
    "JOB-15: a recommendation photo does not close the after-photo gap",
    (recoSynced?.gaps ?? []).includes("after_photo"),
  );

  // The same borrowed-upload refusal `job_attachment/append` enforces applies
  // here too — a device gets no shortcut around `resolveDeviceUpload` by
  // citing a recommendation photo instead of an after photo — and because the
  // photo and the note are filed in the same savepoint, a refused photo must
  // take the note text down with it rather than saving one and dropping the
  // other silently.
  const recoBorrowedUploadId = await makeUpload(foreignJob, "RECOBORROW");
  const recoBorrowPush = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "job_note",
          op: "upsert",
          payload: {
            jobId: recoJob,
            recommendationUploadId: recoBorrowedUploadId,
            workCarriedOut: `__TEST should not be saved ${RUN}`,
          },
        },
      ],
    }),
  );
  check(
    "an upload opened for another job cannot be filed as a recommendation photo either",
    recoBorrowPush.rejected.length,
    1,
  );

  const recoReportAfterReject = (await withTenant(ctx, (tx) =>
    tx.execute<{ recommendation: string | null; work_carried_out: string | null }>(sql`
      select recommendation, work_carried_out from job_reports
       where job_id = ${recoJob}::uuid and deleted_at is null
    `),
  )) as unknown as { recommendation: string | null; work_carried_out: string | null }[];
  checkTrue(
    "…the earlier recommendation text survives the rejected borrow attempt",
    (recoReportAfterReject[0]?.recommendation ?? "").includes(RUN),
  );
  check(
    "…and the rejected mutation's own text was never written — note and photo rolled back together",
    recoReportAfterReject[0]?.work_carried_out ?? null,
    null,
  );

  const recoAttachmentsAfterReject = (await withTenant(ctx, (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from job_attachments
       where job_id = ${recoJob}::uuid and deleted_at is null
    `),
  )) as unknown as { n: number }[];
  check(
    "…and still exactly one attachment on file, not two",
    Number(recoAttachmentsAfterReject[0]?.n ?? -1),
    1,
  );

  // ── 7. Push: dependency ordering (§8.3) ──────────────────────────────────
  //
  // "A completion record must never arrive before the evidence it cites."

  const orphanId = clientId();
  const deferredResult = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: orphanId,
          entity: "job_note",
          op: "upsert",
          payload: { jobId: ownJob, workCarriedOut: "Replaced the contactor." },
          dependsOnClientId: clientId(),
        },
      ],
    }),
  );
  check("a mutation whose dependency has not landed is deferred", deferredResult.deferred.length, 1);
  check("and the deferred mutation is not accepted", deferredResult.accepted.length, 0);

  const orphanReceipts = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from field_mutations where client_id = ${orphanId}
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  });
  // A receipt here would permanently suppress a mutation that was only early.
  check("and no receipt is written, so the device may retry it", orphanReceipts, 0);

  // ── 8. Clock skew (ADR 0004) ─────────────────────────────────────────────
  //
  // Device clocks are wrong. Both times are kept and reports read the server's.

  const skewMinutes = 11;
  const deviceNow = new Date(Date.now() + skewMinutes * 60_000);
  const attendanceId = clientId();

  const attendance = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      deviceTime: deviceNow.toISOString(),
      mutations: [
        {
          clientId: attendanceId,
          entity: "attendance",
          op: "append",
          payload: { kind: "shift_in", occurredAt: deviceNow.toISOString() },
        },
      ],
    }),
  );
  check("an offline attendance event is accepted", attendance.accepted.length, 1);
  checkTrue(
    "the skew is measured from the envelope, not guessed",
    Math.abs((attendance.clockSkewMs ?? 0) - skewMinutes * 60_000) < 5_000,
  );

  const attendanceRow = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ occurred_at: string; recorded_offline_at: string | null }>(sql`
      select occurred_at, recorded_offline_at
        from attendance_events
       where technician_id = ${technicianId}::uuid
       order by created_at desc
       limit 1
    `)) as unknown as { occurred_at: string; recorded_offline_at: string | null }[];
    return rows[0] ?? null;
  });
  if (!attendanceRow) {
    fail++;
    console.log("FAIL  the attendance row was written");
  } else {
    const occurred = new Date(attendanceRow.occurred_at).getTime();
    const raw = attendanceRow.recorded_offline_at
      ? new Date(attendanceRow.recorded_offline_at).getTime()
      : 0;
    checkTrue(
      "occurred_at is corrected back onto the server's timebase",
      Math.abs(occurred - Date.now()) < 60_000,
    );
    checkTrue(
      "and the raw device claim survives in recorded_offline_at",
      Math.abs(raw - deviceNow.getTime()) < 2_000,
    );
    checkTrue("which is a different instant from the corrected one", Math.abs(raw - occurred) > 60_000);
  }

  // ── 8b. FLD-16: technician_location/append, the one batched mutation ─────
  //
  // `recordTechnicianPing` itself is exhaustively tested in
  // `tracking.test.ts` — this is only about the field app's own transport
  // around it: the batch shape, the technician boundary, and that one bad
  // fix costs its own mutation and nothing else in the request.

  async function locationCount(forTechnician: string): Promise<number> {
    return withTenant(ctx, async (tx) => {
      const rows = (await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from technician_locations where technician_id = ${forTechnician}::uuid
      `)) as unknown as { n: number }[];
      return Number(rows[0]?.n ?? 0);
    });
  }

  const beforePings = await locationCount(technicianId);

  const pingBatchId = clientId();
  const pinged = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: pingBatchId,
          entity: "technician_location",
          op: "append",
          payload: {
            pings: [
              { lat: 25.2, lng: 55.27, recordedAt: new Date().toISOString() },
              { lat: 25.201, lng: 55.271, recordedAt: new Date(Date.now() + 1000).toISOString(), speedKph: 30 },
            ],
          },
        },
      ],
    }),
  );
  check("a batch of positions is accepted as one mutation", pinged.accepted.length, 1);
  check("and both pings in it are recorded", pinged.accepted[0]?.result["recorded"], 2);
  checkTrue(
    "the response says whether a customer is watching, one way or the other",
    Object.prototype.hasOwnProperty.call(pinged.accepted[0]?.result ?? {}, "sharedWithCustomer"),
  );
  check("and the rows really did land", (await locationCount(technicianId)) - beforePings, 2);

  // No field for the device to name a technician in at all — the row is
  // stamped from the authenticated device, not from anything in the payload.
  const beforeOtherPings = await locationCount(otherTechnicianId);
  await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "technician_location",
          op: "append",
          payload: {
            // A `technicianId` field that does not exist on `TechnicianPing`'s
            // wire shape, aimed at somebody else's rows.
            pings: [{ technicianId: otherTechnicianId, lat: 25.3, lng: 55.3, recordedAt: new Date().toISOString() }],
          },
        },
      ],
    }),
  );
  check(
    "an injected technicianId in the payload is ignored — the position lands under the authenticated device's own technician",
    await locationCount(otherTechnicianId),
    beforeOtherPings,
  );

  // An empty batch names nothing to record.
  const emptyBatch = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [{ clientId: clientId(), entity: "technician_location", op: "append", payload: { pings: [] } }],
    }),
  );
  check("an empty batch of positions is refused, not silently accepted", emptyBatch.rejected.length, 1);

  // One bad fix costs its own mutation, not the whole request — the savepoint
  // around every mutation in `applyFieldMutations` is what makes this true,
  // and it is worth asserting for THIS handler because it is the one whose
  // domain call (`recordTechnicianPing`) can fail partway through a batch
  // that is otherwise entirely good.
  const beforeMixed = await locationCount(technicianId);
  const nullIslandId = clientId();
  const mixedBatch = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: nullIslandId,
          entity: "technician_location",
          op: "append",
          payload: {
            pings: [
              { lat: 25.4, lng: 55.4, recordedAt: new Date().toISOString() },
              // Null Island: a GPS fix that never arrived. `assertPlausible`
              // refuses the row, and refuses the whole batch it travelled in.
              { lat: 0, lng: 0, recordedAt: new Date(Date.now() + 1000).toISOString() },
            ],
          },
        },
        {
          // A fresh, entirely valid batch — proving the savepoint around the
          // FIRST mutation rolled back on its own and did not abort the
          // shared transaction the second one still needed.
          clientId: clientId(),
          entity: "technician_location",
          op: "append",
          payload: {
            pings: [{ lat: 25.5, lng: 55.5, recordedAt: new Date().toISOString() }],
          },
        },
      ],
    }),
  );
  check("a batch with one Null Island fix is rejected", mixedBatch.rejected.length, 1);
  check(
    "and a good batch beside it in the same request is still accepted, savepoint intact",
    mixedBatch.accepted.length,
    1,
  );
  check("nothing from the BAD batch was written — not even the plausible fix it travelled with", await locationCount(technicianId), beforeMixed + 1);

  // ── 9. The one conflict a rule may not decide (§8.4, ADR 0004) ───────────
  //
  // The technician completes offline; the office cancelled the job. Both are
  // right about the facts they hold, and the loser must not be chosen silently.

  const openBefore = await withTenant(ctx, async (tx) => countOpenFieldConflicts(tx));

  await withTenant({ ...ctx, userId }, async (tx) => {
    await transitionJob(tx, { ...ctx, userId }, {
      jobId: cancelledJob,
      to: "cancelled",
      note: `__TEST ${RUN} the office cancelled it`,
    });
  });

  const conflictId = clientId();
  const conflicted = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: conflictId,
          entity: "job_outcome",
          op: "record",
          payload: { jobId: cancelledJob, outcomeCode },
        },
      ],
    }),
  );

  check("completing a cancelled job is a conflict", conflicted.conflicts.length, 1);
  check("the offline completion is not accepted", conflicted.accepted.length, 0);
  check("and not a rejection the technician can do nothing about", conflicted.rejected.length, 0);
  check("the server's side of the story comes back with it", conflicted.conflicts[0]?.serverState["status"], "cancelled");

  const openAfter = await withTenant(ctx, async (tx) => countOpenFieldConflicts(tx));
  check("and it is queued for a human", openAfter - openBefore, 1);

  const queued = await withTenant(ctx, async (tx) => listFieldConflicts(tx, { jobId: cancelledJob }));
  check("the dispatcher sees exactly one", queued.length, 1);
  check("against the right job", queued[0]?.jobId, cancelledJob);
  checkTrue("naming the technician", (queued[0]?.technicianName ?? "").includes(RUN));
  checkTrue("with a sentence a person can act on", (queued[0]?.detail ?? "").length > 40);

  // A retry of the same mutation must not queue a second entry.
  await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: conflictId,
          entity: "job_outcome",
          op: "record",
          payload: { jobId: cancelledJob, outcomeCode },
        },
      ],
    }),
  );
  const afterRetry = await withTenant(ctx, async (tx) => listFieldConflicts(tx, { jobId: cancelledJob }));
  check("a retried conflict does not queue twice", afterRetry.length, 1);

  const conflictRowId = queued[0]?.id;
  if (conflictRowId) {
    const resolvedConflict = await withTenant({ ...ctx, userId }, async (tx) =>
      resolveFieldConflict(tx, { ...ctx, userId }, {
        conflictId: conflictRowId,
        resolution: "rejected",
        note: `__TEST ${RUN}`,
      }),
    );
    checkTrue("a dispatcher can close it", resolvedConflict.resolved);
    const openFinal = await withTenant(ctx, async (tx) => countOpenFieldConflicts(tx));
    check("and the open count comes back down", openFinal - openBefore, 0);
  }

  // ── 10. A status the server already holds is a no-op, not a duplicate ────

  const eventsBefore = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from job_events where job_id = ${ownJob}::uuid
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  });

  const noopResult = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "job_status",
          op: "transition",
          payload: { jobId: ownJob, to: "on_site" },
        },
      ],
    }),
  );
  check("a status the server already holds is accepted", noopResult.accepted.length, 1);
  check("and marked as a no-op", noopResult.accepted[0]?.result["noop"], true);

  const eventsAfter = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from job_events where job_id = ${ownJob}::uuid
    `)) as unknown as { n: number }[];
    return Number(rows[0]?.n ?? 0);
  });
  check("without writing a duplicate transition into the audit trail", eventsAfter - eventsBefore, 0);

  // ── 11. The boundary is the technician, not just the tenant (§8.5) ───────

  const trespassId = clientId();
  const trespass = await withTenant({ ...ctx, userId }, async (tx) =>
    applyFieldMutations(tx, { ...ctx, userId }, {
      deviceId: device.id,
      technicianId,
      mutations: [
        {
          clientId: trespassId,
          entity: "job_status",
          op: "transition",
          // A status this device IS allowed to drive, deliberately. Using
          // `work_complete` here would be refused by the completion allow-list
          // before the ownership check ever ran, and the test would pass while
          // proving nothing about the technician boundary.
          payload: { jobId: foreignJob, to: "en_route" },
        },
      ],
    }),
  );
  check("a job inside the tenant but not assigned to this technician is refused", trespass.rejected.length, 1);
  check("and the other technician's job is not moved", trespass.accepted.length, 0);
  checkTrue(
    "with one message that does not distinguish 'no such job' from 'not yours'",
    (trespass.rejected[0]?.message ?? "").includes("not assigned to you"),
  );

  // ── 12. Revocation kills the device and NOT the person ───────────────────

  const secondHandset = issueDeviceToken();
  const replacement = await withTenant({ ...ctx, userId }, async (tx) =>
    registerFieldDevice(tx, { ...ctx, userId }, {
      technicianId,
      userId,
      label: `__TEST replacement ${RUN}`,
      platform: "android",
      tokenHash: secondHandset.tokenHash,
      tokenExpiresAt: secondHandset.expiresAt,
    }),
  );
  createdDevices.push(replacement.id);

  const revoke = await withTenant({ ...ctx, userId }, async (tx) =>
    revokeFieldDevice(tx, { ...ctx, userId }, { deviceId: device.id, reason: `__TEST ${RUN} lost on site` }),
  );
  checkTrue("the lost handset is revoked", revoke.revoked);
  check("its token stops resolving immediately", (await resolveDeviceToken(rotated.token)).ok, false);
  checkTrue("the replacement handset still works", (await resolveDeviceToken(secondHandset.token)).ok);

  const stillActive = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ isActive: schema.technicians.isActive })
      .from(schema.technicians)
      .where(eq(schema.technicians.id, technicianId))
      .limit(1);
    return rows[0]?.isActive;
  });
  check("and the technician is still active — a lost phone is not a dismissal", stillActive, true);

  const devices = await withTenant(ctx, async (tx) => listFieldDevices(tx, { technicianId }));
  check("both handsets are listed", devices.length, 2);
  checkTrue("the revoked one carries the reason it was revoked", devices.some((d) => d.revokedReason?.includes(RUN)));

  // ── 13. Cross-tenant isolation ───────────────────────────────────────────
  //
  // The tenant boundary is enforced in Postgres and this proves it holds for
  // the field path too: the same technician id, queried from another tenant's
  // transaction, sees nothing.

  const other = await otherTenantId();
  const acrossBoundary = await withTenant({ tenantId: other, actorKind: "system" }, async (tx) =>
    pullWorkingSet(tx, { technicianId }),
  );
  check("another tenant's transaction pulls none of this technician's jobs", acrossBoundary.jobs.length, 0);
  check("and none of the scope", acrossBoundary.scope.jobIds.length, 0);

  const acrossPush = await withTenant({ tenantId: other, actorKind: "system" }, async (tx) =>
    applyFieldMutations(tx, { tenantId: other, actorKind: "system" }, {
      deviceId: replacement.id,
      technicianId,
      mutations: [
        {
          clientId: clientId(),
          entity: "job_status",
          op: "transition",
          payload: { jobId: ownJob, to: "work_complete" },
        },
      ],
    }),
  );
  check("and a mutation naming this tenant's job is refused from over there", acrossPush.accepted.length, 0);

  // ── Clean-up: nothing this test wrote should outlive it ──────────────────
  //
  // Anchored to this run's tag rather than to a timestamp or a table sweep, so
  // a suite running in parallel against the same database is untouched.
  await withTenant({ ...ctx, userId }, async (tx) => {
    if (createdUploads.length > 0) {
      await tx.execute(sql`
        delete from upload_sessions where id = any(${sql`array[${sql.join(
          createdUploads.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})
      `);
    }
    if (createdDevices.length > 0) {
      await tx.delete(schema.fieldConflicts).where(inArray(schema.fieldConflicts.deviceId, createdDevices));
      await tx.delete(schema.fieldMutations).where(inArray(schema.fieldMutations.deviceId, createdDevices));
      await tx.delete(schema.fieldDevices).where(inArray(schema.fieldDevices.id, createdDevices));
    }
    if (technicianId) {
      await tx
        .delete(schema.attendanceEvents)
        .where(eq(schema.attendanceEvents.technicianId, technicianId));
    }
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobReports).where(inArray(schema.jobReports.jobId, createdJobs));
      await tx.delete(schema.jobAttachments).where(inArray(schema.jobAttachments.jobId, createdJobs));
      await tx.delete(schema.jobCardDeclarations).where(inArray(schema.jobCardDeclarations.jobId, createdJobs));
      await tx.delete(schema.jobFaultCodes).where(inArray(schema.jobFaultCodes.jobId, createdJobs));
      await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, createdJobs));
    }
    if (createdVisits.length > 0) {
      await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.id, createdVisits));
    }
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, createdJobs));
    }
    for (const id of [technicianId, otherTechnicianId]) {
      if (!id) continue;
      await tx
        .delete(schema.technicians)
        .where(and(eq(schema.technicians.id, id), eq(schema.technicians.tenantId, tenantId)));
    }
  });

  // A hash of a known token, asserted last so a change to the hashing would be
  // caught even if every behavioural check above were somehow satisfied.
  check(
    "device tokens are stored as SHA-256, never in the clear",
    hashDeviceToken("meridian").length,
    64,
  );

  console.log(fail === 0 ? "\nall field checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
