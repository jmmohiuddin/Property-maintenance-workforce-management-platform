/**
 * Permit documents and snag photographs (`PRJ-6`, `PRJ-7`) — integration test
 * against real Postgres.
 *
 *   npx tsx test/projects-media.test.ts
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * One rule, tested from six directions: **a caller names an upload session, and
 * the server resolves the storage key.** Never the other way round.
 *
 * The distinction is not academic. A storage key is a string, and a function
 * that accepts one has already lost the question of who was allowed to produce
 * it — `uploads/<another tenant>/candidate_document/<uuid>.pdf` is perfectly
 * well-formed, and a permit register that took keys would happily serve that
 * file to anybody who could read the permit. An upload session id is different
 * because the row behind it carries its own provenance: row-level security says
 * whose it is, `purpose` says what it was authorised as, `status` says whether
 * the bytes are all there, and `scan_status` says whether anything has looked
 * at them.
 *
 * So the assertions below are mostly refusals, and the load-bearing one is the
 * **purpose** check: a completed, scanned, entirely legitimate
 * `candidate_document` upload — the kind of thing a recruiter creates every
 * day — must not be attachable to a permit. That check is the difference
 * between a permission that means something and a permission that guards only
 * the conveyor belt. It can genuinely fail: delete the comparison in
 * `resolveUploadedFile` and this suite goes red.
 *
 * The rest: an unfinished upload, an unscanned one and an infected one are all
 * refused; a `skipped` scan is accepted because on a deployment with no scanner
 * configured that is the only state a file can ever reach; the two snag slots
 * do not overwrite each other; and closing a snag does not throw away the
 * closure evidence attached to it a moment earlier.
 *
 * ── WHY EVERY DB ASSERTION IS ITS OWN FIXTURE ──────────────────────────────
 *
 * Same rule as `projects.test.ts`. Everything below is anchored to `TAG` and
 * removed again, and the cleanup proves it worked rather than assuming it.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  attachPermitDocument,
  attachSnagPhoto,
  closeSnag,
  completeUpload,
  createProject,
  getUpload,
  listPermits,
  listSnags,
  openUpload,
  projectVocabularies,
  raiseSnag,
  recordPermit,
  recordUploadScan,
} from "../src/domain";
import type { TenantContext, TenantScopedTx } from "../src/index";
import { UserFacingError } from "@meridian/core";

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
 * Assert that a call is refused, and refused with a message a human wrote.
 *
 * The second half matters as much as the first. A gate that throws the driver's
 * error is a gate whose message is a SQL statement with parameters in it, and
 * this codebase renders only `UserFacingError`.
 */
async function refuses(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — expected a refusal, the call succeeded`);
  } catch (error) {
    const userFacing = error instanceof UserFacingError;
    if (!userFacing) fail++;
    console.log(
      `${userFacing ? "ok  " : "FAIL"}  ${label}` +
        (userFacing ? "" : ` — threw ${(error as Error)?.name}, not a UserFacingError`),
    );
  }
}

const TAG = "PRJMEDIA-TEST";

/**
 * A per-run suffix on every `client_upload_id`.
 *
 * `client_upload_id` is unique per tenant, and `openUpload` deliberately
 * *returns the existing session* rather than opening a second one — which is
 * right for a phone retrying on bad wifi and wrong for a test, where a row left
 * behind by a crashed earlier run would be handed back in whatever state it
 * died in and every assertion below would be measuring that. A suffix makes
 * each run's fixtures its own; the sweep at the start of `main` clears anything
 * an earlier run genuinely abandoned, behind an age gate so that a suite
 * running concurrently in another shell is never touched.
 */
const RUN = `${TAG}-${Date.now().toString(36)}`;

/** Every session this run opened, so cleanup deletes those and nothing else. */
const openedSessions: { id: string; tenantId: string }[] = [];

type Verdict = "clean" | "skipped" | "infected" | "pending" | "unfinished";

/**
 * A staged upload in a named state.
 *
 * Built through the real `openUpload` / `completeUpload` / `recordUploadScan`
 * rather than by inserting a row, because the states this test cares about are
 * produced by those three functions and a hand-written row would be a fixture
 * asserting against itself. `completeUpload` only accepts `pending` or
 * `skipped` — the two states a deployment can honestly claim at the moment the
 * object lands — and `clean` and `infected` arrive afterwards through the scan
 * sweep, exactly as `/api/cron/scan` produces them.
 */
async function stagedUpload(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { label: string; purpose: string; verdict: Verdict },
): Promise<string> {
  const clientUploadId = `${RUN}-${input.label}`;
  const { session } = await openUpload(tx, ctx, {
    clientUploadId,
    purpose: input.purpose,
    filename: `${input.label}.pdf`,
    totalBytes: 1024,
    chunkSize: 1024,
    chunkCount: 1,
  });
  openedSessions.push({ id: session.sessionId, tenantId: ctx.tenantId });

  // The one state that is the absence of completion.
  if (input.verdict === "unfinished") return session.sessionId;

  await completeUpload(tx, {
    sessionId: session.sessionId,
    // The same shape `completeStagedUpload` derives, so nothing downstream is
    // reading a key that could not occur in production.
    storageKey: `uploads/${ctx.tenantId}/${input.purpose}/${session.sessionId}.pdf`,
    contentType: "application/pdf",
    sizeBytes: 1024,
    sha256: "0".repeat(64),
    scanStatus: input.verdict === "skipped" ? "skipped" : "pending",
    metadataStripped: true,
    compression: "unchanged",
    processingNote: `${TAG} fixture`,
  });

  if (input.verdict === "clean" || input.verdict === "infected") {
    await recordUploadScan(tx, { sessionId: session.sessionId, scanStatus: input.verdict });
  }

  return session.sessionId;
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx: TenantContext = { tenantId, actorKind: "system" };

  let projectId = "";
  let crossTenantUploadId = "";

  // Anything this suite abandoned before. Anchored to the tag AND to an age
  // gate: two hours is far longer than a run and far shorter than a working
  // day, so a concurrent run's sessions are never in range.
  const swept = (await withTenant(ctx, (tx) =>
    tx.execute<{ id: string }>(sql`
      delete from upload_sessions
       where client_upload_id like ${`${TAG}%`}
         and created_at < now() - interval '2 hours'
      returning id
    `),
  )) as unknown as { id: string }[];
  if (swept.length > 0) {
    console.log(`      swept ${swept.length} upload session(s) left by an earlier crashed run`);
  }

  try {
    // ── A session in the OTHER tenant, opened before ours ─────────────────
    //
    // Opened first so that by the time this tenant tries to cite it, it is a
    // complete, clean, correct-purpose upload in every respect except whose it
    // is. A refusal that only worked because the row was half-built would prove
    // nothing.
    const other = await otherTenantId();
    await withTenant({ tenantId: other, actorKind: "system" }, async (tx) => {
      crossTenantUploadId = await stagedUpload(
        tx,
        { tenantId: other, actorKind: "system" },
        { label: "cross", purpose: "project_permit_document", verdict: "clean" },
      );
    });

    await withTenant(ctx, async (tx) => {
      // ── Fixtures ───────────────────────────────────────────────────────
      const target = (await tx.execute<{ property_id: string; customer_id: string }>(sql`
        select p.id as property_id, p.customer_id
          from properties p
          join customers c on c.id = p.customer_id
         where p.deleted_at is null and c.deleted_at is null
         order by p.created_at
         limit 1
      `)) as unknown as { property_id: string; customer_id: string }[];

      const fixture = target[0];
      if (!fixture) {
        throw new Error("Need at least one customer with a property. Run `npm run db:seed`.");
      }

      const vocab = await projectVocabularies(tx);
      const authority = vocab.permitAuthorities[0];
      const trade = vocab.snagTrades[0];
      if (!authority || !trade) {
        throw new Error("Need seeded permit authorities and snag trades. Run `npm run db:seed`.");
      }

      const created = await createProject(tx, ctx, {
        customerId: fixture.customer_id,
        propertyId: fixture.property_id,
        name: `${TAG} media fixture`,
        contractValue: "100000.00",
      });
      projectId = created.projectId;

      const { permitId } = await recordPermit(tx, ctx, {
        projectId,
        authorityCode: authority.code,
        permitType: `${TAG} fire and life safety approval`,
        status: "applied",
      });

      const { snagId } = await raiseSnag(tx, ctx, {
        projectId,
        locationText: `${TAG} level 12, east wall`,
        tradeCode: trade.code,
        severity: "major",
        description: `${TAG} skirting not fixed`,
      });

      // ── PRJ-6: the happy path ──────────────────────────────────────────
      console.log("\n— PRJ-6: a permit document, resolved from the session and not from the caller —");

      const good = await stagedUpload(tx, ctx, {
        label: "permit-clean",
        purpose: "project_permit_document",
        verdict: "clean",
      });

      const attached = await attachPermitDocument(tx, ctx, { permitId, uploadId: good });
      const goodSession = await getUpload(tx, good);

      check(
        "the key written is the one on the session row, not one the caller chose",
        attached.storageKey,
        goodSession?.storageKey,
      );
      check("nothing was superseded on a first attach", attached.replaced, null);

      const permitsAfter = await listPermits(tx, projectId);
      check(
        "and the register reads it back",
        permitsAfter.find((p) => p.id === permitId)?.documentStorageKey,
        goodSession?.storageKey,
      );

      // ── The security assertion ─────────────────────────────────────────
      console.log("\n— the purpose on the row is what decides, not the caller —");

      // A real recruiter's upload: finished, scanned, clean, and authorised
      // against `recruitment:write` rather than `projects:write`. Nothing about
      // it is malformed. It must still not become a permit.
      const foreign = await stagedUpload(tx, ctx, {
        label: "cv-clean",
        purpose: "candidate_document",
        verdict: "clean",
      });

      await refuses("a candidate document cannot be filed as a permit", () =>
        attachPermitDocument(tx, ctx, { permitId, uploadId: foreign, replace: true }),
      );

      // The two new purposes are not interchangeable with each other either,
      // even though the same permission opens both.
      const snagPurposed = await stagedUpload(tx, ctx, {
        label: "snag-clean",
        purpose: "project_snag_photo",
        verdict: "clean",
      });

      await refuses("nor can a snag photograph, which shares the same permission", () =>
        attachPermitDocument(tx, ctx, { permitId, uploadId: snagPurposed, replace: true }),
      );

      await refuses("and a permit document cannot be filed as a snag photograph", () =>
        attachSnagPhoto(tx, ctx, { snagId, uploadId: good, slot: "photo" }),
      );

      // ── The other three states of a session ────────────────────────────
      console.log("\n— an upload is only attachable when it is finished and looked at —");

      const unfinished = await stagedUpload(tx, ctx, {
        label: "permit-open",
        purpose: "project_permit_document",
        verdict: "unfinished",
      });
      await refuses("an upload still open is refused", () =>
        attachPermitDocument(tx, ctx, { permitId, uploadId: unfinished, replace: true }),
      );

      const unscanned = await stagedUpload(tx, ctx, {
        label: "permit-pending",
        purpose: "project_permit_document",
        verdict: "pending",
      });
      await refuses("an upload the scanner has not reached is refused", () =>
        attachPermitDocument(tx, ctx, { permitId, uploadId: unscanned, replace: true }),
      );

      const infected = await stagedUpload(tx, ctx, {
        label: "permit-infected",
        purpose: "project_permit_document",
        verdict: "infected",
      });
      await refuses("and one that failed the scan is refused", () =>
        attachPermitDocument(tx, ctx, { permitId, uploadId: infected, replace: true }),
      );

      await refuses("an upload id that is not an upload id at all is refused", () =>
        attachPermitDocument(tx, ctx, {
          permitId,
          uploadId: "00000000-0000-0000-0000-000000000000",
          replace: true,
        }),
      );

      // Every refusal above must have left the register exactly as it was.
      const stillGood = await listPermits(tx, projectId);
      check(
        "no refusal moved the document that was already on file",
        stillGood.find((p) => p.id === permitId)?.documentStorageKey,
        goodSession?.storageKey,
      );

      // ── Replacing, and the trail it leaves ─────────────────────────────
      console.log("\n— replacing a document is explicit, and it is recorded —");

      const second = await stagedUpload(tx, ctx, {
        label: "permit-second",
        purpose: "project_permit_document",
        verdict: "skipped",
      });

      await refuses("a second document without asking to replace is refused", () =>
        attachPermitDocument(tx, ctx, { permitId, uploadId: second }),
      );

      // `skipped` is the state every completed upload reaches on a deployment
      // with no scanner configured. Refusing it would not make such a
      // deployment safer; it would make the permit register unusable there.
      const replaced = await attachPermitDocument(tx, ctx, {
        permitId,
        uploadId: second,
        replace: true,
      });
      check(
        "an upload from a deployment with no scanner is accepted",
        (await listPermits(tx, projectId)).find((p) => p.id === permitId)?.documentStorageKey,
        replaced.storageKey,
      );
      check("and the superseded key comes back", replaced.replaced, goodSession?.storageKey);

      const audit = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count
          from audit_log
         where record_id = ${permitId}::uuid
           and action = 'prj_permit_doc'
           and changed_fields ->> 'supersededStorageKey' = ${goodSession?.storageKey ?? ""}
      `)) as unknown as { count: number }[];
      check("the swap is on the audit log with both keys", audit[0]?.count, 1);

      // ── PRJ-7: two slots, independent ──────────────────────────────────
      console.log("\n— PRJ-7: the snag and its closure evidence are two different photographs —");

      const snagPhoto = await stagedUpload(tx, ctx, {
        label: "snag-raise",
        purpose: "project_snag_photo",
        verdict: "clean",
      });
      await attachSnagPhoto(tx, ctx, { snagId, uploadId: snagPhoto, slot: "photo" });

      let snag = (await listSnags(tx, projectId)).find((s) => s.id === snagId);
      check("the snag photograph lands in its own slot", snag?.photoStorageKey, (await getUpload(tx, snagPhoto))?.storageKey);
      check("and the closure slot is untouched", snag?.closurePhotoStorageKey, null);

      const closurePhoto = await stagedUpload(tx, ctx, {
        label: "snag-close",
        purpose: "project_snag_photo",
        verdict: "clean",
      });
      await attachSnagPhoto(tx, ctx, { snagId, uploadId: closurePhoto, slot: "closure" });

      const closureKey = (await getUpload(tx, closurePhoto))?.storageKey;
      snag = (await listSnags(tx, projectId)).find((s) => s.id === snagId);
      check("the closure evidence lands in the other slot", snag?.closurePhotoStorageKey, closureKey);
      check(
        "and does not disturb the photograph of the snag itself",
        snag?.photoStorageKey,
        (await getUpload(tx, snagPhoto))?.storageKey,
      );

      await refuses("a slot that already holds a photograph is not overwritten by accident", () =>
        attachSnagPhoto(tx, ctx, { snagId, uploadId: snagPhoto, slot: "closure" }),
      );

      // ── Attach, then close ─────────────────────────────────────────────
      //
      // The upload is chunked and cannot happen inside a form post, so the
      // evidence is filed before the closure. `closeSnag` used to set
      // `closure_photo_storage_key` to NULL on every call, which threw that
      // evidence away a second after it was attached.
      await closeSnag(tx, ctx, {
        snagId,
        closureNote: `${TAG} skirting refixed and made good`,
      });

      snag = (await listSnags(tx, projectId)).find((s) => s.id === snagId);
      check("closing the snag keeps the evidence attached to it", snag?.closurePhotoStorageKey, closureKey);
      check("and the snag is closed", snag?.status, "closed");

      // ── Cross-tenant ───────────────────────────────────────────────────
      console.log("\n— an upload belonging to another tenant is not an upload —");

      // Not a WHERE clause anywhere in the attach path: `getUpload` runs under
      // `app.tenant_id` and Postgres returns no row, which is the same answer
      // it gives for an id that never existed. The message says the same thing
      // for both, deliberately — telling them apart would confirm that this id
      // is real somewhere else.
      await refuses("a session opened in the other tenant cannot be attached here", () =>
        attachPermitDocument(tx, ctx, {
          permitId,
          uploadId: crossTenantUploadId,
          replace: true,
        }),
      );
      check("and it cannot even be read from here", await getUpload(tx, crossTenantUploadId), null);
    });
  } finally {
    // ── Cleanup, anchored to TAG ───────────────────────────────────────────
    //
    // Only rows this run created. The upload sessions are deleted by the ids
    // this process collected as it opened them — never by a `purpose` or a
    // `status` predicate, which on a shared development database would take
    // somebody else's work with it.
    //
    // `audit_log` rows are deliberately left. DELETE on that table is REVOKED
    // from the application role (see sql/rls.sql — it is append-only by grant,
    // not by convention), and an audit trail a test can erase is not an audit
    // trail.
    console.log("\n— cleanup —");
    await withTenant(ctx, async (tx) => {
      if (projectId) {
        await tx.execute(sql`delete from projects where id = ${projectId}::uuid`);
      }
    });

    for (const session of openedSessions) {
      await withTenant({ tenantId: session.tenantId, actorKind: "system" }, async (tx) => {
        await tx.execute(sql`
          delete from upload_sessions
           where id = ${session.id}::uuid
             and client_upload_id like ${`${RUN}%`}
             and created_at > now() - interval '2 hours'
        `);
      });
    }

    // Counted inside a tenant transaction, in both tenants. The bare `db`
    // handle has no `app.tenant_id` set, and under FORCE ROW LEVEL SECURITY
    // that makes every count zero whether or not the rows are there — a
    // cleanup check that cannot fail is worse than none, because it occupies
    // the place where somebody would otherwise write one.
    let strayProjects = 0;
    let straySessions = 0;

    for (const id of [tenantId, await otherTenantId()]) {
      await withTenant({ tenantId: id, actorKind: "system" }, async (tx) => {
        const projects = (await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from projects where name like ${`${TAG}%`}
        `)) as unknown as { count: number }[];
        strayProjects += Number(projects[0]?.count ?? 0);

        const sessions = (await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from upload_sessions
           where client_upload_id like ${`${RUN}%`}
        `)) as unknown as { count: number }[];
        straySessions += Number(sessions[0]?.count ?? 0);
      });
    }

    check("no test project survived cleanup", strayProjects, 0);
    check("nor any upload session it opened, in either tenant", straySessions, 0);
  }

  console.log(fail === 0 ? "\nAll project media checks passed.\n" : `\n${fail} check(s) FAILED.\n`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
