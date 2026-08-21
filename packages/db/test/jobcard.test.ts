/**
 * The job card gate — `JOB-15` — integration test against real Postgres.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself,
 * except for `audit_log`: `meridian_app` holds no DELETE on that table by
 * design, and a test that could tidy the audit trail would be testing a
 * database that is not the one in production.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * **A guard nobody has watched refuse is a guard nobody has tested.** The first
 * and largest section satisfies three of `JOB-15`'s four conditions at a time
 * and leaves the fourth unmet, three times over, and asserts the completion is
 * refused each time and that the job is still `on_site` afterwards. A gate that
 * throws *after* writing the outcome would pass a naive "did it throw" test and
 * still leave the damage, so the job's own state is read back every time.
 *
 * **"Explicitly none" is a fact, not an absence.** An empty `job_materials`
 * cannot tell "no parts were fitted" from "nobody filled this in", and that
 * distinction is the whole of the clause. So the declaration is asserted to
 * close the gap, a recorded part is asserted to withdraw the declaration, and
 * the two are asserted never to stand together.
 *
 * **"Reason-coded" means coded.** The exemption is refused for a code that is
 * not in the tenant's vocabulary and for one that has been retired, because a
 * vocabulary that accepts anything is a text column wearing a table's clothes.
 *
 * **Zero is a real answer and null is not.** A `no_access` visit spent no time
 * on the tools, and demanding a positive number would collect a fabricated one.
 * Recorded-zero closes the labour gap; never-recorded does not.
 *
 * ── WHY THE CLEAN-UP IS ANCHORED TO A PER-RUN TAG ───────────────────────────
 *
 * Every row this file writes carries `RUN` in its reference, and every DELETE
 * names ids this run collected. An unscoped `LIKE` pattern deleted another
 * suite's live fixtures once and was misdiagnosed as flakiness for hours.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  withTenant,
  schema,
  closeConnection,
  getJobCard,
  assertJobCardComplete,
  recordJobAttachment,
  recordJobMaterial,
  declareNoMaterials,
  recordPhotoExemption,
  recordVisitLabour,
  recordJobSignature,
  listPhotoExemptionReasons,
  addPhotoExemptionReason,
  setPhotoExemptionReasonActive,
  recordJobOutcome,
  STANDARD_PHOTO_EXEMPTION_REASONS,
  JOB_ATTACHMENT_KINDS,
} from "../src/index";
import { UserFacingError } from "@meridian/core";
import { testTenantId, otherTenantId } from "./_tenant";

const RUN = Date.now().toString(36).slice(-6).toUpperCase();

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
 * Every message in an error's cause chain, joined.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose own message is
 * only "Failed query: ..." — the constraint name that says *why* Postgres
 * refused is on `.cause`. Asserting against the outer message alone silently
 * matches nothing, which is how a check can pass for the wrong reason or fail
 * for no reason at all.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/** The message, or the marker that says nothing was thrown at all. */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "(no error thrown)";
  } catch (error) {
    if (error instanceof UserFacingError) return error.message;
    throw error;
  }
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  const createdJobs: string[] = [];
  const createdVisits: string[] = [];
  let technicianId = "";

  // ── Fixtures ─────────────────────────────────────────────────────────────

  const found = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ id: schema.properties.id, customerId: schema.properties.customerId })
      .from(schema.properties)
      .limit(1);
    return rows[0] ?? null;
  });
  if (!found) throw new Error("Seed data missing. Run `npm run db:seed` first.");
  const site = found;

  // This suite's own technician rather than a seeded one, so a parallel suite
  // reading the workforce board sees nothing this file did.
  technicianId = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.technicians)
      .values({
        tenantId,
        employeeCode: `ZZC-${RUN}`,
        fullName: `__TEST jobcard ${RUN}`,
        phone: "+971500000000",
        primaryTrade: "hvac-installation-maintenance",
      })
      .returning({ id: schema.technicians.id });
    if (!row) throw new Error("could not create the test technician");
    return row.id;
  });

  /** One job on site, with one visit, ready to be completed. */
  async function makeJob(suffix: string): Promise<{ jobId: string; visitId: string }> {
    return withTenant(ctx, async (tx) => {
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          tenantId,
          reference: `ZZC-${RUN}-${suffix}`,
          customerId: site.customerId,
          propertyId: site.id,
          serviceSlug: "hvac-installation-maintenance",
          title: `__TEST job card ${RUN} ${suffix}`,
          status: "on_site",
        })
        .returning({ id: schema.jobs.id });
      if (!job) throw new Error("could not create a test job");
      createdJobs.push(job.id);

      const [visit] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId,
          jobId: job.id,
          technicianId,
          sequence: 1,
          status: "arrived",
        })
        .returning({ id: schema.jobVisits.id });
      if (!visit) throw new Error("could not create a test visit");
      createdVisits.push(visit.id);

      return { jobId: job.id, visitId: visit.id };
    });
  }

  /** The status the job is actually in, read back from the row. */
  async function statusOf(jobId: string): Promise<string> {
    return withTenant(ctx, async (tx) => {
      const rows = await tx
        .select({ status: schema.jobs.status, outcomeCode: schema.jobs.outcomeCode })
        .from(schema.jobs)
        .where(eq(schema.jobs.id, jobId))
        .limit(1);
      return `${rows[0]?.status ?? "gone"}/${rows[0]?.outcomeCode ?? "no-outcome"}`;
    });
  }

  async function complete(jobId: string): Promise<string> {
    return refusal(() =>
      withTenant(ctx, (tx) =>
        recordJobOutcome(tx, ctx, { jobId, outcomeCode: "completed", note: `run ${RUN}` }),
      ),
    );
  }

  // ── The vocabulary has rows ──────────────────────────────────────────────
  //
  // A controlled-vocabulary table with an empty picker is worse than a text
  // column, because it looks governed and is not — and this list is the only
  // legitimate way past the photograph requirement, so an empty one turns the
  // gate into a wall. This repository has shipped the empty-picker bug once
  // already.
  const reasons = await withTenant(ctx, (tx) => listPhotoExemptionReasons(tx));
  checkTrue(
    "JOB-15: the photo exemption vocabulary is seeded, not empty",
    reasons.length >= STANDARD_PHOTO_EXEMPTION_REASONS.length,
  );
  for (const expected of STANDARD_PHOTO_EXEMPTION_REASONS) {
    checkTrue(`JOB-15: "${expected.code}" is in the picker`, reasons.some((r) => r.code === expected.code));
  }

  // ── An empty job card names all three gaps ───────────────────────────────
  const bare = await makeJob("BARE");
  const bareCard = await withTenant(ctx, (tx) => getJobCard(tx, bare.jobId));
  check("a job with nothing recorded has three gaps", bareCard.gaps.length, 3);
  checkTrue("…the after photograph", bareCard.gaps.includes("after_photo"));
  checkTrue("…the materials", bareCard.gaps.includes("materials"));
  checkTrue("…the labour", bareCard.gaps.includes("labour"));
  check("…and no labour total at all, rather than zero", bareCard.labourMinutes, null);

  const bareRefusal = await complete(bare.jobId);
  checkTrue(
    "JOB-15: a job with an empty card cannot be completed",
    bareRefusal.includes("cannot be completed yet"),
  );
  checkTrue("…and the refusal names every gap, not the first one", [
    "photograph",
    "parts",
    "tools",
  ].every((word) => bareRefusal.includes(word)));
  check(
    "…and nothing was written: still on site, still no outcome",
    await statusOf(bare.jobId),
    "on_site/no-outcome",
  );

  // ── Three satisfied, one missing: the photograph ─────────────────────────
  //
  // This is the shape that matters. A gate that only refuses the empty card
  // would pass every test above and still let a job through with no photograph,
  // which is the condition most often skipped in the field.
  const noPhoto = await makeJob("NOPHOTO");
  await withTenant(ctx, (tx) => declareNoMaterials(tx, ctx, { jobId: noPhoto.jobId }));
  await withTenant(ctx, (tx) =>
    recordVisitLabour(tx, ctx, { jobId: noPhoto.jobId, visitId: noPhoto.visitId, workMinutes: 75 }),
  );
  const noPhotoCard = await withTenant(ctx, (tx) => getJobCard(tx, noPhoto.jobId));
  check("with materials and labour recorded, one gap is left", noPhotoCard.gaps.length, 1);
  check("…and it is the photograph", noPhotoCard.gaps[0], "after_photo");

  const photoRefusal = await complete(noPhoto.jobId);
  checkTrue(
    "JOB-15: three of four is still a refusal — no after photograph",
    photoRefusal.includes("after") && photoRefusal.includes("photograph"),
  );
  checkTrue(
    "…and the refusal does not mention the two that are satisfied",
    !photoRefusal.includes("parts") && !photoRefusal.includes("tools"),
  );
  check("…and the job did not move", await statusOf(noPhoto.jobId), "on_site/no-outcome");

  // ── FLD-12: a recommendation photo is not an after photo ─────────────────
  //
  // `photo_recommendation` (`0034`) is a sixth kind precisely so a technician
  // flagging a failing compressor on an unrelated visit has somewhere to file
  // the photo — but it is a sales observation, not evidence the work on THIS
  // job was done, and `JOB-15`'s gate must keep reading `photo_after` only.
  // A job whose sole photograph is a recommendation stays exactly as
  // unphotographed as a job with none at all.
  checkTrue(
    "the sixth kind is in the vocabulary the domain layer accepts",
    (JOB_ATTACHMENT_KINDS as readonly string[]).includes("photo_recommendation"),
  );
  const recoOnly = await makeJob("RECOONLY");
  await withTenant(ctx, (tx) =>
    recordJobAttachment(tx, ctx, {
      jobId: recoOnly.jobId,
      visitId: recoOnly.visitId,
      kind: "photo_recommendation",
      storageKey: `jobs/${recoOnly.jobId}/reco-${RUN}.jpg`,
      mimeType: "image/jpeg",
      caption: `__TEST outdoor unit failing ${RUN}`,
    }),
  );
  await withTenant(ctx, (tx) => declareNoMaterials(tx, ctx, { jobId: recoOnly.jobId }));
  await withTenant(ctx, (tx) =>
    recordVisitLabour(tx, ctx, { jobId: recoOnly.jobId, visitId: recoOnly.visitId, workMinutes: 30 }),
  );
  const recoOnlyCard = await withTenant(ctx, (tx) => getJobCard(tx, recoOnly.jobId));
  check("a recommendation photo does not count toward the after-photo total", recoOnlyCard.afterPhotoCount, 0);
  checkTrue(
    "…so the after-photo gap is still open with everything else satisfied",
    recoOnlyCard.gaps.length === 1 && recoOnlyCard.gaps[0] === "after_photo",
  );
  const recoOnlyRefusal = await complete(recoOnly.jobId);
  checkTrue(
    "JOB-15: a job whose only photograph is a recommendation is still refused completion",
    recoOnlyRefusal.includes("after") && recoOnlyRefusal.includes("photograph"),
  );
  check("…and the job did not move", await statusOf(recoOnly.jobId), "on_site/no-outcome");

  // ── Three satisfied, one missing: the materials ──────────────────────────
  const noParts = await makeJob("NOPARTS");
  await withTenant(ctx, (tx) =>
    recordJobAttachment(tx, ctx, {
      jobId: noParts.jobId,
      visitId: noParts.visitId,
      kind: "photo_after",
      storageKey: `jobs/${noParts.jobId}/after-${RUN}.jpg`,
      mimeType: "image/jpeg",
      sizeBytes: 1234,
      caption: `__TEST ${RUN}`,
    }),
  );
  await withTenant(ctx, (tx) =>
    recordVisitLabour(tx, ctx, { jobId: noParts.jobId, visitId: noParts.visitId, workMinutes: 40 }),
  );
  const partsRefusal = await complete(noParts.jobId);
  checkTrue(
    "JOB-15: an unfilled materials section is a refusal, not a blank",
    partsRefusal.includes("parts used"),
  );
  check("…and the job did not move", await statusOf(noParts.jobId), "on_site/no-outcome");

  // ── Three satisfied, one missing: the labour ─────────────────────────────
  const noTime = await makeJob("NOTIME");
  await withTenant(ctx, (tx) =>
    recordJobAttachment(tx, ctx, {
      jobId: noTime.jobId,
      visitId: noTime.visitId,
      kind: "photo_after",
      storageKey: `jobs/${noTime.jobId}/after-${RUN}.jpg`,
      mimeType: "image/jpeg",
    }),
  );
  await withTenant(ctx, (tx) =>
    recordJobMaterial(tx, ctx, {
      jobId: noTime.jobId,
      visitId: noTime.visitId,
      description: `__TEST capacitor ${RUN}`,
      quantity: "2",
      unit: "ea",
      unitCostMinor: 4500,
    }),
  );
  const timeRefusal = await complete(noTime.jobId);
  checkTrue("JOB-15: no labour time is a refusal", timeRefusal.includes("time on the tools"));
  check("…and the job did not move", await statusOf(noTime.jobId), "on_site/no-outcome");

  // Zero is a legal answer: a visit that never reached the work spent no time
  // on the tools, and demanding a positive number would collect an invented one.
  await withTenant(ctx, (tx) =>
    recordVisitLabour(tx, ctx, { jobId: noTime.jobId, visitId: noTime.visitId, workMinutes: 0 }),
  );
  const zeroCard = await withTenant(ctx, (tx) => getJobCard(tx, noTime.jobId));
  check("a recorded zero closes the labour gap", zeroCard.gaps.length, 0);
  check("…and reads back as zero rather than as nothing", zeroCard.labourMinutes, 0);

  // ── All four: the job completes ──────────────────────────────────────────
  const completed = await complete(noTime.jobId);
  check("…so nothing was thrown", completed, "(no error thrown)");
  check(
    "JOB-15: a complete card completes the job",
    await statusOf(noTime.jobId),
    "work_complete/completed",
  );

  // ── "Explicitly none" is a fact, not an absence ──────────────────────────
  const none = await makeJob("NONE");
  const beforeDeclaring = await withTenant(ctx, (tx) => getJobCard(tx, none.jobId));
  checkTrue(
    "an empty materials list is a gap, because it cannot say why it is empty",
    beforeDeclaring.gaps.includes("materials"),
  );
  await withTenant(ctx, (tx) =>
    declareNoMaterials(tx, ctx, { jobId: none.jobId, note: `nothing fitted, run ${RUN}` }),
  );
  const declared = await withTenant(ctx, (tx) => getJobCard(tx, none.jobId));
  checkTrue("declaring none closes the gap", !declared.gaps.includes("materials"));
  checkTrue("…and it is on file as something somebody said", declared.materialsNone !== null);
  check("…with their note beside it", declared.materialsNone?.note, `nothing fitted, run ${RUN}`);

  // Declaring twice is one row, not two. The unique index in 0025 holds it.
  await withTenant(ctx, (tx) => declareNoMaterials(tx, ctx, { jobId: none.jobId }));
  const declaredTwice = await withTenant(ctx, (tx) =>
    tx
      .select({ id: schema.jobCardDeclarations.id })
      .from(schema.jobCardDeclarations)
      .where(
        and(
          eq(schema.jobCardDeclarations.jobId, none.jobId),
          eq(schema.jobCardDeclarations.kind, "materials_none"),
        ),
      ),
  );
  check("declaring none twice records it once", declaredTwice.length, 1);

  // A part recorded afterwards withdraws the declaration, rather than standing
  // beside it. Both on file would be a job card that says a compressor was
  // fitted and that nothing was.
  await withTenant(ctx, (tx) =>
    recordJobMaterial(tx, ctx, {
      jobId: none.jobId,
      description: `__TEST gas R410a ${RUN}`,
      quantity: "1.5",
      unit: "kg",
    }),
  );
  const afterPart = await withTenant(ctx, (tx) => getJobCard(tx, none.jobId));
  check("recording a part withdraws the none declaration", afterPart.materialsNone, null);
  check("…and the part is on the card", afterPart.materials.length, 1);
  check("…with the quantity as a decimal string, not a float", afterPart.materials[0]?.quantity, "1.500");

  checkTrue(
    "a job with parts on it cannot also be declared as using none",
    (
      await refusal(() => withTenant(ctx, (tx) => declareNoMaterials(tx, ctx, { jobId: none.jobId })))
    ).includes("cannot also be declared"),
  );

  // ── "Reason-coded" means coded ───────────────────────────────────────────
  const exempt = await makeJob("EXEMPT");
  checkTrue(
    "an exemption reason that is not in the vocabulary is refused",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordPhotoExemption(tx, ctx, { jobId: exempt.jobId, reasonCode: "forgot" }),
        ),
      )
    ).includes("reason-coded"),
  );

  await withTenant(ctx, (tx) =>
    recordPhotoExemption(tx, ctx, {
      jobId: exempt.jobId,
      reasonCode: "nothing_visible",
      note: `sealed unit, run ${RUN}`,
    }),
  );
  const exemptCard = await withTenant(ctx, (tx) => getJobCard(tx, exempt.jobId));
  checkTrue("a coded exemption closes the photograph gap", !exemptCard.gaps.includes("after_photo"));
  check(
    "…and renders as the label, not the code",
    exemptCard.photoExemption?.reasonLabel,
    "Nothing visible to photograph",
  );

  // A retired reason leaves the picker and stays in the data — the exemption
  // recorded above must still render, and a new one must be refused.
  await withTenant(ctx, (tx) =>
    tx
      .update(schema.jobPhotoExemptionReasons)
      .set({ isActive: false })
      .where(eq(schema.jobPhotoExemptionReasons.code, "unsafe_to_photograph")),
  );
  const retiredRefusal = await refusal(() =>
    withTenant(ctx, (tx) =>
      recordPhotoExemption(tx, ctx, {
        jobId: bare.jobId,
        reasonCode: "unsafe_to_photograph",
      }),
    ),
  );
  checkTrue("a retired reason cannot be used on new work", retiredRefusal.includes("retired"));
  await withTenant(ctx, (tx) =>
    tx
      .update(schema.jobPhotoExemptionReasons)
      .set({ isActive: true })
      .where(eq(schema.jobPhotoExemptionReasons.code, "unsafe_to_photograph")),
  );

  // An exemption is from a missing photograph. With one on file there is
  // nothing to exempt, and offering it anyway would let a job carry both.
  await withTenant(ctx, (tx) =>
    recordJobAttachment(tx, ctx, {
      jobId: exempt.jobId,
      kind: "photo_after",
      storageKey: `jobs/${exempt.jobId}/after-${RUN}.png`,
    }),
  );
  checkTrue(
    "a job that has an after photograph cannot also be exempted from having one",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordPhotoExemption(tx, ctx, { jobId: exempt.jobId, reasonCode: "customer_refused" }),
        ),
      )
    ).includes("nothing to exempt"),
  );

  // ── The vocabulary is editable, and retirement is the only removal ───────
  //
  // ADM-10: a controlled list nobody can extend means the first unlisted case
  // gets recorded as the nearest wrong one, which is worse for analysis than
  // free text would have been. These exercise what the admin screen calls.
  const ownCode = `zz_run_${RUN.toLowerCase()}`;
  await withTenant(ctx, (tx) =>
    addPhotoExemptionReason(tx, ctx, {
      code: ownCode,
      label: `__TEST roof hatch sealed ${RUN}`,
      description: "A business-specific reason the standard five do not cover.",
      sortOrder: 900,
    }),
  );
  const withOwn = await withTenant(ctx, (tx) => listPhotoExemptionReasons(tx));
  checkTrue(
    "ADM-10: an administrator's own reason joins the picker",
    withOwn.some((r) => r.code === ownCode),
  );

  // Adding the same code again rewords it rather than failing, which is how an
  // administrator corrects a label — the `on conflict do update` path.
  await withTenant(ctx, (tx) =>
    addPhotoExemptionReason(tx, ctx, { code: ownCode, label: `__TEST reworded ${RUN}` }),
  );
  const reworded = (await withTenant(ctx, (tx) => listPhotoExemptionReasons(tx))).find(
    (r) => r.code === ownCode,
  );
  check("…and re-adding it rewords rather than duplicating", reworded?.label, `__TEST reworded ${RUN}`);

  const ownId = reworded?.id ?? "";
  await withTenant(ctx, (tx) => setPhotoExemptionReasonActive(tx, ownId, false));
  const afterRetire = await withTenant(ctx, (tx) => listPhotoExemptionReasons(tx));
  const afterRetireAll = await withTenant(ctx, (tx) =>
    listPhotoExemptionReasons(tx, { activeOnly: false }),
  );
  checkTrue(
    "retiring takes it out of the picker",
    !afterRetire.some((r) => r.code === ownCode),
  );
  checkTrue(
    "…while the admin screen can still see it, to restore it",
    afterRetireAll.some((r) => r.code === ownCode),
  );
  await withTenant(ctx, (tx) => setPhotoExemptionReasonActive(tx, ownId, true));

  // The claim the admin screen makes in prose — "there is no delete and there
  // is deliberately nowhere to add one" — is a database constraint, so it is
  // asserted as one. A reason cited by a completed job cannot be removed.
  const cited = await makeJob("CITED");
  await withTenant(ctx, (tx) =>
    recordPhotoExemption(tx, ctx, { jobId: cited.jobId, reasonCode: ownCode }),
  );
  let deleteRefusal = "(no error thrown)";
  try {
    await withTenant(ctx, (tx) =>
      tx.execute(sql`delete from job_photo_exemption_reasons where id = ${ownId}::uuid`),
    );
  } catch (error) {
    deleteRefusal = messageChain(error);
  }
  checkTrue(
    "JOB-15: a reason cited by a job cannot be deleted, only retired",
    deleteRefusal.includes("job_card_declarations_reason_code_fk"),
  );

  // ── Nothing is filed against the wrong job ───────────────────────────────
  checkTrue(
    "a visit from another job cannot carry this job's labour",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordVisitLabour(tx, ctx, {
            jobId: exempt.jobId,
            visitId: bare.visitId,
            workMinutes: 30,
          }),
        ),
      )
    ).includes("does not belong to this job"),
  );
  checkTrue(
    "…nor its materials",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordJobMaterial(tx, ctx, {
            jobId: exempt.jobId,
            visitId: bare.visitId,
            description: `__TEST wrong visit ${RUN}`,
            quantity: "1",
          }),
        ),
      )
    ).includes("does not belong to this job"),
  );

  // ── The signature: recorded, and deliberately not gated on ───────────────
  //
  // `JOB-15` lists four conditions and a signature is not one of them. A fifth
  // condition invented here would mean a technician who cannot find anybody to
  // sign — an empty villa, a night shift in a plant room — could not close the
  // job at all.
  const signed = await makeJob("SIGNED");
  await withTenant(ctx, (tx) =>
    recordJobSignature(tx, ctx, {
      jobId: signed.jobId,
      visitId: signed.visitId,
      signedByName: `__TEST tenant ${RUN}`,
      signedByRole: "Building manager",
      signatureStorageKey: `jobs/${signed.jobId}/signature-${RUN}.png`,
      satisfactionRating: 4,
    }),
  );
  const signedCard = await withTenant(ctx, (tx) => getJobCard(tx, signed.jobId));
  check("a signature is recorded", signedCard.signature?.signedByName, `__TEST tenant ${RUN}`);
  check("…with the rating the customer gave", signedCard.signature?.satisfactionRating, 4);
  check("…and it does not close any of the four gaps", signedCard.gaps.length, 3);
  checkTrue(
    "a rating outside one to five is refused",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordJobSignature(tx, ctx, {
            jobId: signed.jobId,
            signedByName: `__TEST ${RUN}`,
            signatureStorageKey: `jobs/${signed.jobId}/sig2-${RUN}.png`,
            satisfactionRating: 9,
          }),
        ),
      )
    ).includes("one to five"),
  );

  // ── The audit trail records who filled the card in ───────────────────────
  //
  // Filtered on the payload rather than by taking the newest row.
  // `audit_log.occurred_at` is the transaction timestamp and the table has no
  // sequence, so rows written together record no order between them.
  const audited = (await withTenant(ctx, (tx) =>
    tx.execute<{ action: string }>(sql`
      select action from audit_log
       where table_name in ('job_materials', 'job_visits', 'job_card_declarations')
         and changed_fields ->> 'jobId' = ${noTime.jobId}
    `),
  )) as unknown as { action: string }[];
  const actions = new Set(audited.map((r) => r.action));
  checkTrue("the material write is audited", actions.has("material"));
  checkTrue("the labour write is audited", actions.has("labour"));
  checkTrue(
    "every audit action fits audit_log.action, which is varchar(16)",
    [...actions].every((a) => a.length <= 16),
  );

  // ── The tenant boundary ──────────────────────────────────────────────────
  //
  // `otherTenantId()` throws rather than returning null, so this check cannot
  // silently skip — which is what it did for three other suites before the
  // helper was fixed.
  const other = await otherTenantId();
  const acrossCtx = { tenantId: other, actorKind: "system" as const };
  const across = await withTenant(acrossCtx, (tx) => getJobCard(tx, exempt.jobId));
  check("the same job id shows no photographs under another tenant", across.photos.length, 0);
  check("…no materials", across.materials.length, 0);
  check("…no exemption", across.photoExemption, null);
  check("…and therefore all three gaps", across.gaps.length, 3);
  checkTrue(
    "…while that tenant still has its own seeded exemption vocabulary",
    (await withTenant(acrossCtx, (tx) => listPhotoExemptionReasons(tx))).length >=
      STANDARD_PHOTO_EXEMPTION_REASONS.length,
  );
  checkTrue(
    "…so the gate refuses that job id from there, seeing an empty card",
    (
      await refusal(() =>
        withTenant(acrossCtx, (tx) => assertJobCardComplete(tx, exempt.jobId)),
      )
    ).includes("cannot be completed yet"),
  );

  // ── Clean-up: anchored to the ids this run created ───────────────────────
  await withTenant(ctx, async (tx) => {
    if (createdJobs.length > 0) {
      await tx
        .delete(schema.jobCardDeclarations)
        .where(inArray(schema.jobCardDeclarations.jobId, createdJobs));
      await tx.delete(schema.jobAttachments).where(inArray(schema.jobAttachments.jobId, createdJobs));
      await tx.delete(schema.jobMaterials).where(inArray(schema.jobMaterials.jobId, createdJobs));
      await tx.delete(schema.jobSignoffs).where(inArray(schema.jobSignoffs.jobId, createdJobs));
      await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, createdJobs));
    }
    if (createdVisits.length > 0) {
      await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.id, createdVisits));
    }
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, createdJobs));
    }
    // After the declarations above, which cite it: that foreign key is
    // ON DELETE restrict, which is the point of the check further up. Anchored
    // to this run's code, never a LIKE pattern over the whole table.
    await tx
      .delete(schema.jobPhotoExemptionReasons)
      .where(eq(schema.jobPhotoExemptionReasons.code, `zz_run_${RUN.toLowerCase()}`));
    if (technicianId) {
      await tx
        .delete(schema.technicians)
        .where(
          and(eq(schema.technicians.id, technicianId), eq(schema.technicians.tenantId, tenantId)),
        );
    }
  });

  const leftover = await withTenant(ctx, (tx) =>
    tx.select({ id: schema.jobs.id }).from(schema.jobs).where(inArray(schema.jobs.id, createdJobs)),
  );
  check("the test removed everything it created", leftover.length, 0);

  console.log(fail === 0 ? "\njobcard: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
