/**
 * Sealing a job sheet, and everything that changes the moment it is sealed
 * (`FLD-14`) — against a real Postgres and a real object store.
 *
 *   npm run test --workspace=@meridian/docs
 *
 * `job-sheet.test.ts` proves the render and the canonicalisation. This proves
 * the four clauses that only exist once a database is involved: the immutable
 * snapshot, the digest comparison that makes "the sheet that was on screen"
 * enforceable, the lock, and the amendment.
 *
 * Requires the same environment as the `@meridian/db` tests: schema and RLS
 * applied, `npm run db:seed` run. Documents go to a temporary directory that is
 * removed at the end.
 *
 * ── WHAT THIS FILE IS ACTUALLY FOR ──────────────────────────────────────────
 *
 * **A lock nobody has watched refuse is a lock nobody has tested.** Every
 * refusal below reads the record back afterwards and asserts nothing moved. A
 * guard that throws *after* writing would pass a naive "did it throw" test and
 * leave the damage — and the damage here is a job card that changed under a
 * signature, which is exactly the failure the requirement names.
 *
 * **The mismatch path is the requirement, not an edge case.** `FLD-14` asks for
 * the hash of "the exact rendered job sheet that was on screen". Without the
 * comparison, a client could sign a sheet that had already been overtaken by an
 * edit and the stored digest would faithfully record the wrong document. So one
 * section presents a sheet, changes the card underneath it, and asserts that
 * the signature is refused and that nothing at all was written — not the
 * signoff, not the sheet, not the email.
 *
 * **An amendment must leave the original intact.** The last section raises one
 * and re-reads the original's digest, its key, and the bytes in the store.
 *
 * ── WHY THE CLEAN-UP IS ANCHORED TO A PER-RUN TAG ───────────────────────────
 *
 * Every row this file writes carries `RUN` in its reference and every DELETE
 * names ids this run collected. The dev database is shared; an unscoped `LIKE`
 * pattern deleted another suite's live fixtures once and was misdiagnosed as
 * flakiness for hours.
 */

import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import {
  withTenant,
  schema,
  closeConnection,
  getJobCard,
  getSealedJobSheet,
  listJobSheets,
  listJobSheetAmendmentReasons,
  purgeJobSheets,
  recordJobAttachment,
  recordJobMaterial,
  recordVisitLabour,
  recordJobSignature,
  STANDARD_JOB_SHEET_AMENDMENT_REASONS,
} from "@meridian/db";
import { objectStore } from "@meridian/files";
import {
  amendJobSheet,
  presentJobSheet,
  sealJobSheet,
  JOB_SHEET_FORMAT,
} from "@meridian/docs";
import { pdfText } from "./pdf-text";

// Set at module scope, which is early enough: `objectStore()` reads the
// environment when it is first *called*. A test writing into the developer's
// real store would leave sheets behind that the write-once rule then refuses to
// overwrite.
const ROOT = mkdtempSync(join(tmpdir(), "meridian-jobsheet-"));
process.env["FILES_LOCAL_ROOT"] = ROOT;

const TENANT = "11111111-1111-4111-8111-111111111111";
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
function contains(label: string, haystack: string, needle: string): void {
  const ok = haystack.includes(needle);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — "${needle}" is not there`}`);
}

/**
 * Every message in an error's cause chain, joined.
 *
 * A trigger or constraint failure arrives wrapped: Drizzle's own message is
 * only "Failed query: …" and the sentence Postgres raised — the one naming the
 * job sheet — is on `.cause`. A test matching on `.message` alone reports a
 * passing refusal for entirely the wrong reason.
 */
function reasons(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/** The refusal, or the marker that says nothing was thrown at all. */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "(no error thrown)";
  } catch (error) {
    return reasons(error);
  }
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT, actorKind: "system" as const };

  const createdJobs: string[] = [];
  const createdVisits: string[] = [];
  const createdKeys: string[] = [];
  let technicianId = "";

  // ── Fixtures ──────────────────────────────────────────────────────────────

  const site = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: schema.properties.id,
        customerId: schema.properties.customerId,
        name: schema.properties.name,
      })
      .from(schema.properties)
      .limit(1);
    return rows[0] ?? null;
  });
  if (!site) throw new Error("Seed data missing. Run `npm run db:seed` first.");
  const where = site;

  // This suite's own technician rather than a seeded one, so a parallel suite
  // reading the workforce board sees nothing this file did.
  technicianId = await withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(schema.technicians)
      .values({
        tenantId: TENANT,
        employeeCode: `ZZS-${RUN}`,
        fullName: `__TEST sheet ${RUN}`,
        phone: "+971500000000",
        primaryTrade: "hvac-installation-maintenance",
      })
      .returning({ id: schema.technicians.id });
    if (!row) throw new Error("could not create the test technician");
    return row.id;
  });

  /**
   * A job whose card satisfies `JOB-15` in full.
   *
   * Built through the same domain functions the application calls, not by
   * inserting rows: the sheet is assembled from what `getJobCard` sees, so a
   * fixture that reached the tables by a different route would prove the sheet
   * renders something rather than that it renders the record.
   */
  async function makeCompleteJob(suffix: string): Promise<{ jobId: string; visitId: string }> {
    const ids = await withTenant(ctx, async (tx) => {
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          tenantId: TENANT,
          reference: `ZZS-${RUN}-${suffix}`,
          customerId: where.customerId,
          propertyId: where.id,
          serviceSlug: "hvac-installation-maintenance",
          title: `__TEST job sheet ${RUN} ${suffix}`,
          description: "Split unit in the gym is blowing warm",
          status: "on_site",
          outcomeCode: "completed",
        })
        .returning({ id: schema.jobs.id });
      if (!job) throw new Error("could not create a test job");
      createdJobs.push(job.id);

      const [visit] = await tx
        .insert(schema.jobVisits)
        .values({
          tenantId: TENANT,
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

    await withTenant(ctx, async (tx) => {
      await recordJobAttachment(tx, ctx, {
        jobId: ids.jobId,
        visitId: ids.visitId,
        kind: "photo_after",
        storageKey: `tenants/${TENANT}/jobs/${ids.jobId}/after-${RUN}.jpg`,
        caption: "Repaired flare joint",
      });
      await recordJobMaterial(tx, ctx, {
        jobId: ids.jobId,
        visitId: ids.visitId,
        description: "R410A refrigerant",
        quantity: "2.500",
        unit: "kg",
      });
      await recordVisitLabour(tx, ctx, {
        jobId: ids.jobId,
        visitId: ids.visitId,
        workMinutes: 95,
        travelMinutes: 25,
      });
    });

    return ids;
  }

  // ── The amendment vocabulary is seeded, not empty ─────────────────────────
  //
  // This list is the ONLY legitimate way to correct a signed sheet. A tenant
  // whose picker is empty has a locked card and no way to say it is wrong — at
  // which point somebody edits around the lock or the record stays wrong, and
  // both are worse than the mistake. This repository has shipped the
  // empty-picker bug once already.
  const vocabulary = await withTenant(ctx, (tx) => listJobSheetAmendmentReasons(tx));
  checkTrue(
    "FLD-14: the amendment vocabulary is seeded",
    vocabulary.length >= STANDARD_JOB_SHEET_AMENDMENT_REASONS.length,
  );
  for (const expected of STANDARD_JOB_SHEET_AMENDMENT_REASONS) {
    checkTrue(
      `FLD-14: "${expected.code}" is in the picker`,
      vocabulary.some((r) => r.code === expected.code),
    );
  }

  // ── Presenting a sheet writes nothing ─────────────────────────────────────
  const main1 = await makeCompleteJob("SEAL");

  const presented = await withTenant(ctx, (tx) =>
    presentJobSheet(tx, main1.jobId, { recordedAt: "2026-08-14T11:42:00.000Z" }),
  );

  check("the digest is 64 lower-case hex", /^[0-9a-f]{64}$/.test(presented.contentSha256), true);
  check("the canonical string is stamped with the format", presented.canonical.split("\n")[0], `sheet_format: ${JOB_SHEET_FORMAT}`);
  contains("it carries the job's own materials", presented.canonical, "2.500 kg R410A refrigerant");
  contains("and the labour recorded against the visit", presented.canonical, "labour_minutes: 95");

  check(
    "presenting a sheet seals nothing",
    await withTenant(ctx, (tx) => getSealedJobSheet(tx, main1.jobId)),
    null,
  );
  checkTrue(
    "…and the card is still editable",
    (await refusal(() =>
      withTenant(ctx, (tx) =>
        recordJobMaterial(tx, ctx, {
          jobId: main1.jobId,
          description: "Cable tie",
          quantity: "10",
          unit: "ea",
        }),
      ),
    )) === "(no error thrown)",
  );

  // That edit changed the card, so the digest above no longer describes it.
  // Re-present, and the two must differ — which is the property the mismatch
  // check further down depends on.
  const represented = await withTenant(ctx, (tx) =>
    presentJobSheet(tx, main1.jobId, { recordedAt: "2026-08-14T11:42:00.000Z" }),
  );
  check(
    "a card edit moves the digest",
    represented.contentSha256 === presented.contentSha256,
    false,
  );

  // ── A stale digest is refused, and nothing is written ─────────────────────
  const signoffsBefore = await withTenant(ctx, async (tx) =>
    (
      await tx
        .select({ id: schema.jobSignoffs.id })
        .from(schema.jobSignoffs)
        .where(eq(schema.jobSignoffs.jobId, main1.jobId))
    ).length,
  );

  const stale = await refusal(() =>
    withTenant(ctx, (tx) =>
      sealJobSheet(tx, ctx, {
        jobId: main1.jobId,
        visitId: main1.visitId,
        signedByName: "Amira Khalil",
        signedByRole: "Building manager",
        signerEmail: `amira+${RUN}@example.ae`,
        signatureStorageKey: `tenants/${TENANT}/jobs/${main1.jobId}/sig-${RUN}.png`,
        // The digest from BEFORE the cable tie was added.
        presentedSha256: presented.contentSha256,
        recordedAt: "2026-08-14T11:42:00.000Z",
      }),
    ),
  );

  contains(
    "FLD-14: a signature on a sheet the card has moved past is refused",
    stale,
    "changed between this sheet being shown and it being signed",
  );
  check(
    "…and no signature was written",
    await withTenant(ctx, async (tx) =>
      (
        await tx
          .select({ id: schema.jobSignoffs.id })
          .from(schema.jobSignoffs)
          .where(eq(schema.jobSignoffs.jobId, main1.jobId))
      ).length,
    ),
    signoffsBefore,
  );
  check(
    "…and no sheet was sealed",
    await withTenant(ctx, (tx) => getSealedJobSheet(tx, main1.jobId)),
    null,
  );
  // The whole transaction rolled back, so the message rolled back with it —
  // which is what "enqueued in the same transaction" buys and is the reason the
  // enqueue is not a separate step afterwards.
  check(
    "…and no message was queued",
    await withTenant(ctx, async (tx) =>
      (
        await tx
          .select({ id: schema.notifications.id })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.template, "job_sheet_signed"),
              eq(schema.notifications.recipientAddress, `amira+${RUN}@example.ae`),
            ),
          )
      ).length,
    ),
    0,
  );

  // ── Sealing, with the current digest ──────────────────────────────────────
  const sealed = await withTenant(ctx, (tx) =>
    sealJobSheet(tx, ctx, {
      jobId: main1.jobId,
      visitId: main1.visitId,
      signedByName: "Amira Khalil",
      signedByRole: "Building manager",
      signerEmail: `Amira+${RUN}@Example.AE`,
      signatureStorageKey: `tenants/${TENANT}/jobs/${main1.jobId}/sig-${RUN}.png`,
      satisfactionRating: 5,
      presentedSha256: represented.contentSha256,
      recordedAt: "2026-08-14T11:42:00.000Z",
      deviceSignedAt: new Date("2026-08-14T11:39:00.000Z"),
    }),
  );
  createdKeys.push(sealed.storageKey);

  check("the stored digest is the presented one", sealed.contentSha256, represented.contentSha256);
  check("the copy went somewhere", sealed.copyProblem, null);
  check(
    "the key is under this tenant's job-sheet prefix",
    sealed.storageKey.startsWith(`tenants/${TENANT}/documents/job-sheet/`),
    true,
  );

  const row = await withTenant(ctx, (tx) => getSealedJobSheet(tx, main1.jobId));
  check("the row records the format that produced the digest", row?.sheetFormat, JOB_SHEET_FORMAT);
  check("the row records the content digest", row?.contentSha256, sealed.contentSha256);
  check("the row records the artefact's own digest", row?.pdfSha256, sealed.pdfSha256);
  check("the row records where the artefact is", row?.storageKey, sealed.storageKey);
  check("the row is the original", row?.kind, "original");
  check("…at sequence zero", row?.sequence, 0);
  check("…and it names the signature that sealed it", row?.signoffId, sealed.signoffId);

  // ── The snapshot is real, and it is what the hash covers ──────────────────
  //
  // `objectStore().get` re-hashes on read and throws if the bytes have moved
  // since they were stored, so this assertion is doing two jobs.
  const stored = await objectStore().get(sealed.storageKey);
  check("the artefact is in the store", stored !== null, true);
  check("its recorded hash matches the row", stored?.object.sha256, sealed.pdfSha256);
  check("it is stored as a PDF", stored?.object.contentType, "application/pdf");

  const text = pdfText(stored?.body ?? new Uint8Array());
  contains("the sheet names the job", text, `ZZS-${RUN}-SEAL`);
  contains("the signer is on it", text, "Amira Khalil");
  contains("their relationship to the site is on it", text, "Building manager");
  contains("the content digest is on its face", text, sealed.contentSha256);
  contains("the material is on it", text, "R410A refrigerant");

  // Write-once, at the store. A second `put` on the same key is refused, which
  // is what stops a template change silently replacing a signed sheet.
  const overwrite = await refusal(() =>
    objectStore().put({
      key: sealed.storageKey,
      body: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      declaredContentType: "application/pdf",
    }),
  );
  contains("OPS-6: the stored object cannot be overwritten", overwrite, "write-once");

  // ── The copy, enqueued in the same transaction ────────────────────────────
  const queued = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: schema.notifications.id,
        channel: schema.notifications.channel,
        to: schema.notifications.recipientAddress,
        subjectTable: schema.notifications.subjectTable,
        subjectId: schema.notifications.subjectId,
        payload: schema.notifications.payload,
        status: schema.notifications.status,
      })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.template, "job_sheet_signed"),
          eq(schema.notifications.subjectId, sealed.sheetId),
        ),
      ),
  );

  check("FLD-14: exactly one copy was queued", queued.length, 1);
  check("…by email", queued[0]?.channel, "email");
  check("…queued, not sent behind the transaction's back", queued[0]?.status, "queued");
  check("…against the sheet it is a copy of", queued[0]?.subjectTable, "job_sheets");
  // Lower-cased on the way in. The same address in two cases would otherwise be
  // two recipients in every suppression window and every bounce count.
  check("…to the signer's own address", queued[0]?.to, `amira+${RUN}@example.ae`.toLowerCase());
  check(
    "…carrying the digest, which is the point of sending it now",
    (queued[0]?.payload as Record<string, unknown> | undefined)?.["contentSha256"],
    sealed.contentSha256,
  );

  // ── The lock ──────────────────────────────────────────────────────────────
  //
  // Every write path on the job card, refused, with the record read back each
  // time. The domain layer produces the sentence; `0037`'s triggers are the
  // guarantee behind it.
  const cardBefore = await withTenant(ctx, (tx) => getJobCard(tx, main1.jobId));

  const lockRefusals: [string, string][] = [
    [
      "a photograph",
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordJobAttachment(tx, ctx, {
            jobId: main1.jobId,
            kind: "photo_after",
            storageKey: `tenants/${TENANT}/jobs/${main1.jobId}/late-${RUN}.jpg`,
          }),
        ),
      ),
    ],
    [
      "a part",
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordJobMaterial(tx, ctx, {
            jobId: main1.jobId,
            description: "Late addition",
            quantity: "1",
            unit: "ea",
          }),
        ),
      ),
    ],
    [
      "the time on the tools",
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordVisitLabour(tx, ctx, {
            jobId: main1.jobId,
            visitId: main1.visitId,
            workMinutes: 480,
          }),
        ),
      ),
    ],
    [
      "a second signature",
      await refusal(() =>
        withTenant(ctx, (tx) =>
          recordJobSignature(tx, ctx, {
            jobId: main1.jobId,
            signedByName: "Somebody Else",
            signatureStorageKey: `tenants/${TENANT}/jobs/${main1.jobId}/sig2-${RUN}.png`,
          }),
        ),
      ),
    ],
  ];

  for (const [what, message] of lockRefusals) {
    contains(`FLD-14: after signature, ${what} is refused`, message, "card is locked");
    contains(`…and the refusal names the sheet (${what})`, message, `ZZS-${RUN}-SEAL-JS`);
  }

  const cardAfter = await withTenant(ctx, (tx) => getJobCard(tx, main1.jobId));
  check("…and not one photograph was added", cardAfter.photos.length, cardBefore.photos.length);
  check("…not one part", cardAfter.materials.length, cardBefore.materials.length);
  check("…and the labour is untouched", cardAfter.labourMinutes, cardBefore.labourMinutes);

  // Sealing a second time is refused before anything is rendered or stored.
  const twice = await refusal(() =>
    withTenant(ctx, (tx) =>
      sealJobSheet(tx, ctx, {
        jobId: main1.jobId,
        signedByName: "Amira Khalil",
        signatureStorageKey: `tenants/${TENANT}/jobs/${main1.jobId}/sig3-${RUN}.png`,
        presentedSha256: sealed.contentSha256,
        recordedAt: "2026-08-14T11:42:00.000Z",
      }),
    ),
  );
  contains("FLD-14: a job cannot be signed off twice", twice, "already signed off");

  // ── The row itself is immutable ───────────────────────────────────────────
  const edited = await refusal(() =>
    withTenant(ctx, (tx) =>
      tx
        .update(schema.jobSheets)
        .set({ contentSha256: "0".repeat(64) })
        .where(eq(schema.jobSheets.id, sealed.sheetId)),
    ),
  );
  contains("FLD-14: the sheet row cannot be edited", edited, "cannot be edited");

  const deleted = await refusal(() =>
    withTenant(ctx, (tx) =>
      tx.delete(schema.jobSheets).where(eq(schema.jobSheets.id, sealed.sheetId)),
    ),
  );
  contains("FLD-14: and it cannot be deleted by an ordinary statement", deleted, "cannot be deleted");

  check(
    "…so the digest on file is still the one that was signed",
    (await withTenant(ctx, (tx) => getSealedJobSheet(tx, main1.jobId)))?.contentSha256,
    sealed.contentSha256,
  );

  // ── The amendment ─────────────────────────────────────────────────────────
  const noReason = await refusal(() =>
    withTenant(ctx, (tx) =>
      amendJobSheet(tx, ctx, {
        jobId: main1.jobId,
        reasonCode: `zz_not_a_reason_${RUN.toLowerCase()}`,
        detail: "Anything.",
      }),
    ),
  );
  contains(
    "FLD-14: an amendment reason has to come from the vocabulary",
    noReason,
    "that is what \"reason-coded\" means",
  );

  const noDetail = await refusal(() =>
    withTenant(ctx, (tx) =>
      amendJobSheet(tx, ctx, {
        jobId: main1.jobId,
        reasonCode: "materials_misrecorded",
        detail: "   ",
      }),
    ),
  );
  contains(
    "…and a code alone is not an amendment",
    noDetail,
    "needs a sentence saying what the position actually is",
  );

  const amendment = await withTenant(ctx, (tx) =>
    amendJobSheet(tx, ctx, {
      jobId: main1.jobId,
      reasonCode: "materials_misrecorded",
      detail: `1.8 kg of R410A was charged, not 2.5 kg. Van stock count for run ${RUN} confirms it.`,
    }),
  );
  createdKeys.push(amendment.storageKey);

  check("the amendment is numbered from the original", amendment.reference, `ZZS-${RUN}-SEAL-JS-A1`);
  check(
    "it is a separate artefact",
    amendment.storageKey === sealed.storageKey,
    false,
  );

  const sheets = await withTenant(ctx, (tx) => listJobSheets(tx, main1.jobId));
  check("the job now has two sheets", sheets.length, 2);
  check("…the original first", sheets[0]?.kind, "original");
  check("…the amendment second", sheets[1]?.kind, "amendment");
  check("…linked to the original", sheets[1]?.amendsSheetId, sealed.sheetId);
  check("…carrying its reason code", sheets[1]?.amendmentReasonCode, "materials_misrecorded");
  check("…and the reason in words", sheets[1]?.amendmentReasonLabel, "Parts recorded wrongly");
  check("…and no signature of its own", sheets[1]?.signoffId, null);
  check(
    "…reproducing the original's own recorded-at string, verbatim",
    sheets[1]?.recordedAtText,
    "2026-08-14T11:42:00.000Z",
  );
  // The amendment is built from the same locked record, so its content digest
  // equals the original's. That equality is worth asserting: it is
  // machine-checkable proof that raising an amendment corrected the record's
  // MEANING and did not touch its contents.
  check(
    "…and the same content digest, because nothing on the card moved",
    sheets[1]?.contentSha256,
    sealed.contentSha256,
  );
  check(
    "…while being a different document",
    sheets[1]?.pdfSha256 === sealed.pdfSha256,
    false,
  );

  // The whole point of the amendment mechanism.
  check("FLD-14: the original's digest is unchanged", sheets[0]?.contentSha256, sealed.contentSha256);
  check("…its artefact digest too", sheets[0]?.pdfSha256, sealed.pdfSha256);
  check("…and it still points at the same bytes", sheets[0]?.storageKey, sealed.storageKey);
  const originalStill = await objectStore().get(sealed.storageKey);
  check(
    "…which are still in the store and still hash to what was recorded",
    originalStill?.object.sha256,
    sealed.pdfSha256,
  );

  const amendmentText = pdfText((await objectStore().get(amendment.storageKey))?.body ?? new Uint8Array());
  contains("the amendment says which sheet it corrects", amendmentText, `ZZS-${RUN}-SEAL-JS`);
  contains("…and quotes that sheet's digest", amendmentText, sealed.contentSha256);
  contains("…and carries what the code cannot say", amendmentText, "1.8 kg of R410A was charged");

  // And the card is still locked. An amendment is a second document, never an
  // unlock — that distinction is the whole of the design.
  const afterAmendment = await refusal(() =>
    withTenant(ctx, (tx) =>
      recordJobMaterial(tx, ctx, {
        jobId: main1.jobId,
        description: "Still refused",
        quantity: "1",
        unit: "ea",
      }),
    ),
  );
  contains("FLD-14: an amendment does not unlock the card", afterAmendment, "card is locked");

  // ── A sheet cannot be presented over an unfinished card ───────────────────
  const bare = await withTenant(ctx, async (tx) => {
    const [job] = await tx
      .insert(schema.jobs)
      .values({
        tenantId: TENANT,
        reference: `ZZS-${RUN}-BARE`,
        customerId: site.customerId,
        propertyId: site.id,
        serviceSlug: "hvac-installation-maintenance",
        title: `__TEST bare card ${RUN}`,
        status: "on_site",
      })
      .returning({ id: schema.jobs.id });
    if (!job) throw new Error("could not create the bare job");
    createdJobs.push(job.id);
    return job.id;
  });

  const bareRefusal = await refusal(() => withTenant(ctx, (tx) => presentJobSheet(tx, bare)));
  contains(
    "a sheet is not shown for signature over a card with gaps in it",
    bareRefusal,
    "cannot be completed yet",
  );

  // ── Clean-up: anchored to the ids this run created ───────────────────────
  await withTenant(ctx, async (tx) => {
    for (const jobId of createdJobs) {
      // Sheets first, through the one function that is allowed to. Until they
      // are gone the lock triggers refuse every delete below.
      await purgeJobSheets(tx, { jobId });
    }
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobAttachments).where(inArray(schema.jobAttachments.jobId, createdJobs));
      await tx.delete(schema.jobMaterials).where(inArray(schema.jobMaterials.jobId, createdJobs));
      await tx.delete(schema.jobSignoffs).where(inArray(schema.jobSignoffs.jobId, createdJobs));
      await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, createdJobs));
      await tx
        .delete(schema.notifications)
        .where(
          and(
            eq(schema.notifications.template, "job_sheet_signed"),
            inArray(schema.notifications.subjectId, [sealed.sheetId]),
          ),
        );
    }
    if (createdVisits.length > 0) {
      await tx.delete(schema.jobVisits).where(inArray(schema.jobVisits.id, createdVisits));
    }
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, createdJobs));
    }
    if (technicianId) {
      await tx
        .delete(schema.technicians)
        .where(
          and(eq(schema.technicians.id, technicianId), eq(schema.technicians.tenantId, TENANT)),
        );
    }
  });

  const leftover = await withTenant(ctx, (tx) =>
    tx.select({ id: schema.jobs.id }).from(schema.jobs).where(inArray(schema.jobs.id, createdJobs)),
  );
  check("the test removed everything it created", leftover.length, 0);
  void createdKeys;

  console.log(fail === 0 ? "\nall job sheet sealing checks passed" : `\n${fail} FAILED`);
  await closeConnection();
  await rm(ROOT, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await closeConnection();
  await rm(ROOT, { recursive: true, force: true });
  process.exit(1);
});
