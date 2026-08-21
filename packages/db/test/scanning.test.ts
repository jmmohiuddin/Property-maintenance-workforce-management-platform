/**
 * The virus-scan gate and the upload transport, against real Postgres.
 *
 *   npm run test --workspace=@meridian/db
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM recruitment.test.ts ────────────────
 *
 * That suite already proves the *gate*: `isDownloadable` refuses `pending` and
 * `infected`, and the download lookup returns the status the row holds. What it
 * could not prove is that anything ever moves a row — because until now nothing
 * did. The only writer hardcoded `skipped`, no code path anywhere wrote
 * `pending`, and no code path took a row out of it.
 *
 * So what is proven here is the engine: that a claim is exclusive, that a
 * verdict is written, that a scanner which fails leaves the file refused rather
 * than nudging it towards clean, and that the row a deployment with no scanner
 * writes says so in words.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * The scanner itself. `packages/db` does not depend on `@meridian/files` and
 * this file does not import it — the ClamAV wire protocol, the "no scanner
 * configured" state and its reason are proven in
 * `packages/files/test/scan.test.ts`, without a daemon. What crosses the seam
 * into this file is a verdict, so a verdict is what the fake below produces.
 *
 * ── ISOLATION ───────────────────────────────────────────────────────────────
 *
 * Every row this file writes carries `RUN`, and every DELETE is anchored to it.
 * An unscoped `LIKE 'zz-test-%'` is correct on one laptop and destructive the
 * moment two runs overlap: it deletes the other run's live fixtures, which then
 * fails somewhere unrelated and gets diagnosed as flakiness.
 */

import { createHash } from "node:crypto";
import postgres from "postgres";
import { isDownloadable, type ScanStatus } from "@meridian/core";
import { closeConnection, withTenant } from "../src/index";
import {
  abortUpload,
  attachCandidateDocument,
  claimNextDocumentScan,
  completeUpload,
  getCandidateDocumentForDownload,
  getUpload,
  openUpload,
  parkDocumentScan,
  readUploadChunks,
  receiveChunk,
  recordScanVerdict,
  scanBacklog,
  sweepAbandonedUploads,
  uploadPressure,
} from "../src/domain";
import { testTenantId } from "./_tenant";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: unknown): void {
  check(label, got, true);
}

const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`;
const RUN_SUFFIX = `%${RUN}`;

const admin = postgres(
  process.env["DATABASE_ADMIN_URL"] ?? process.env["DATABASE_URL"] ?? "postgres://localhost:5432/meridian_dev",
  { max: 2, onnotice: () => {} },
);

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The EICAR test string.
 *
 * Harmless by design — it is the industry's agreed stand-in for a real sample,
 * which every scanner reports as infected and no scanner has to be fed anything
 * dangerous to exercise.
 */
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

type Verdict = { status: "clean" } | { status: "infected"; signature: string };

/** Standing in for clamd. What crosses the seam is a verdict; this produces one. */
function fakeScan(contents: string): Verdict {
  return contents.includes(EICAR)
    ? { status: "infected", signature: "Eicar-Test-Signature" }
    : { status: "clean" };
}

async function cleanup(): Promise<void> {
  await admin`delete from upload_sessions where client_upload_id like ${`${RUN}%`}`;
  await admin`delete from candidate_documents where filename like ${RUN_SUFFIX}`;
  await admin`delete from candidates where full_name like ${RUN_SUFFIX}`;
}

/**
 * Reap fixtures from runs that were killed before they could clean up.
 *
 * Age-gated at an hour, which is far longer than this suite takes and therefore
 * cannot reach a concurrent run's live rows. Without it, a killed run's tag is
 * one nothing will ever match again and the rows accumulate for ever.
 */
async function sweepStale(): Promise<void> {
  await admin`delete from upload_sessions where client_upload_id like 'zzscan%' and created_at < now() - interval '1 hour'`;
  await admin`delete from candidate_documents where filename like 'zz-scan-%' and created_at < now() - interval '1 hour'`;
  await admin`delete from candidates where full_name like 'ZZScan%' and created_at < now() - interval '1 hour'`;
}

async function main(): Promise<void> {
  await sweepStale();
  await cleanup();

  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  const [candidate] = await admin`
    insert into candidates (tenant_id, full_name, phone, primary_trade, experience_band, current_location)
    values (${tenantId}::uuid, ${`ZZScan Candidate ${RUN}`}, ${`+971 50 000 ${RUN.slice(-4)}`},
            'electrical', '2_to_5', 'in_uae')
    returning id
  `;
  const candidateId = String(candidate?.["id"]);

  /** Attach a document as the upload path now does, and return its id. */
  async function attach(name: string, scanStatus: ScanStatus): Promise<string> {
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.7\n${name}\n`, "latin1"));
    const attached = await withTenant(ctx, (tx) =>
      attachCandidateDocument(tx, ctx, {
        candidateId,
        kind: "cv",
        storageKey: `candidates/${candidateId}/zz-scan-${name}-${RUN}.pdf`,
        filename: `zz-scan-${name}-${RUN}`,
        contentType: "application/pdf",
        sizeBytes: bytes.length,
        sha256: sha256Hex(bytes),
        scanStatus,
      }),
    );
    return attached.documentId;
  }

  // ── A file arrives, and nobody has looked at it yet ───────────────────────
  //
  // `pending` is what `storeCv` writes on a deployment with a scanner. Before
  // this wave it wrote `skipped` unconditionally and nothing ever wrote
  // `pending` at all, which is why this assertion could not previously exist.
  const pendingId = await attach("clean", "pending");

  const beforeScan = await withTenant(ctx, (tx) => getCandidateDocumentForDownload(tx, pendingId));
  check("a newly-uploaded file is pending", beforeScan?.scanStatus, "pending");
  // The download route's own gate, applied to the row the route would fetch:
  // `apps/web/.../recruitment/documents/[documentId]/route.ts` calls exactly
  // these two functions in exactly this order and returns 409 on a false.
  check(
    "and the download route's own gate refuses it",
    isDownloadable((beforeScan?.scanStatus ?? "clean") as ScanStatus),
    false,
  );

  // ── The sweep claims it, scans it, and writes a verdict ──────────────────
  const swept = await withTenant(ctx, async (tx) => {
    const claimed = await claimNextDocumentScan(tx);
    if (!claimed) return null;
    const verdict = fakeScan("an ordinary CV");
    await recordScanVerdict(tx, ctx, {
      documentId: claimed.documentId,
      applicationId: claimed.applicationId,
      status: verdict.status,
      note: `fake-clamd: ${verdict.status === "infected" ? verdict.signature : "clean"}`,
    });
    return claimed;
  });

  check("the sweep claimed the pending document", swept?.documentId, pendingId);

  const afterScan = await withTenant(ctx, (tx) => getCandidateDocumentForDownload(tx, pendingId));
  check("and moved it to clean", afterScan?.scanStatus, "clean");
  checkTrue(
    "so the download route now hands it over",
    isDownloadable((afterScan?.scanStatus ?? "pending") as ScanStatus),
  );

  // ── An infected file ─────────────────────────────────────────────────────
  const suspectId = await attach("eicar", "pending");

  await withTenant(ctx, async (tx) => {
    const claimed = await claimNextDocumentScan(tx);
    const verdict = fakeScan(EICAR);
    await recordScanVerdict(tx, ctx, {
      documentId: claimed!.documentId,
      applicationId: claimed!.applicationId,
      status: verdict.status,
      note: verdict.status === "infected" ? `fake-clamd: ${verdict.signature}` : "fake-clamd: clean",
    });
  });

  const flagged = await withTenant(ctx, (tx) => getCandidateDocumentForDownload(tx, suspectId));
  check("a file carrying EICAR is recorded infected", flagged?.scanStatus, "infected");
  check(
    "and the download route refuses it",
    isDownloadable((flagged?.scanStatus ?? "clean") as ScanStatus),
    false,
  );

  const [note] = await admin`
    select scanner_note, scanned_at from candidate_documents where id = ${suspectId}::uuid
  `;
  check("the signature is kept on the row", note?.["scanner_note"], "fake-clamd: Eicar-Test-Signature");
  checkTrue("and the scan is stamped", note?.["scanned_at"] !== null);

  // ── Two sweeps at once ───────────────────────────────────────────────────
  //
  // The property that makes the cron safe to double-fire. Both runs select
  // `for update skip locked` and then claim with a conditional UPDATE; the
  // second must come away with nothing rather than scanning the same file twice
  // — or, worse, writing a second verdict over the first.
  const raceId = await attach("race", "pending");

  const hold = async (): Promise<string | null> =>
    withTenant(ctx, async (tx) => {
      const claimed = await claimNextDocumentScan(tx);
      // Held deliberately: the row lock lives for the life of the transaction,
      // so the other run has to make its decision while this one still has it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (claimed) {
        await recordScanVerdict(tx, ctx, {
          documentId: claimed.documentId,
          applicationId: claimed.applicationId,
          status: "clean",
          note: "fake-clamd: clean",
        });
      }
      return claimed?.documentId ?? null;
    });

  const [first, second] = await Promise.all([hold(), hold()]);
  check("exactly one of two concurrent sweeps claims the document", [first, second].filter((id) => id === raceId).length, 1);
  check("the other comes away with nothing", [first, second].filter((id) => id === null).length, 1);

  // ── A scanner that cannot answer ─────────────────────────────────────────
  //
  // The failure mode that would make the whole gate decorative: a scan that
  // errors must leave the file refused, never nudge it towards clean.
  const brokenId = await attach("broken", "pending");

  let threw = false;
  try {
    await withTenant(ctx, async (tx) => {
      const claimed = await claimNextDocumentScan(tx);
      check("the failing sweep did claim the document first", claimed?.documentId, brokenId);
      // The daemon is not answering. The transaction unwinds and takes the
      // claim with it.
      throw new Error("connection refused");
    });
  } catch {
    threw = true;
  }

  checkTrue("a scanner that cannot answer aborts the sweep", threw);

  const [afterFailure] = await admin`
    select scan_status, scan_claimed_at from candidate_documents where id = ${brokenId}::uuid
  `;
  check("the document is still pending, not clean", afterFailure?.["scan_status"], "pending");
  check("and the claim rolled back with the transaction", afterFailure?.["scan_claimed_at"], null);
  // ── A row whose file is gone ─────────────────────────────────────────────
  //
  // Which is what makes it retryable: the next run finds it exactly as before,
  // claims it — and this time the object it cites is not in the store, so there
  // is nothing to scan. It is parked rather than moved to `skipped`: `skipped`
  // is the deployment-level statement "there is no scanner here", and this
  // file's problem is its own. Calling it skipped would make it downloadable on
  // the strength of a lie.
  //
  // Note that this claim *commits*, unlike the rolled-back one above. That is
  // the whole mechanism: claimed-and-still-pending is a third state, and it is
  // what stops the sweep picking the same broken row first on every run.
  const parkedRun = await withTenant(ctx, async (tx) => {
    const claimed = await claimNextDocumentScan(tx);
    if (!claimed) return null;
    await parkDocumentScan(tx, {
      documentId: claimed.documentId,
      note: "The stored object is missing; nothing was scanned.",
    });
    return claimed.documentId;
  });
  check("the next run picks it up again", parkedRun, brokenId);

  const [parked] = await admin`
    select scan_status, scan_claimed_at, scanner_note from candidate_documents where id = ${brokenId}::uuid
  `;
  check("a parked document stays pending", parked?.["scan_status"], "pending");
  checkTrue("with the claim committed, unlike a rolled-back one", parked?.["scan_claimed_at"] !== null);
  check("and the note says what happened", parked?.["scanner_note"], "The stored object is missing; nothing was scanned.");
  check(
    "and it stays refused, because nobody knows anything about the file",
    isDownloadable((parked?.["scan_status"] ?? "clean") as ScanStatus),
    false,
  );
  const afterPark = await withTenant(ctx, (tx) => claimNextDocumentScan(tx));
  check("and it is not claimed again, so the sweep cannot livelock behind it", afterPark, null);

  const backlog = await withTenant(ctx, (tx) => scanBacklog(tx));
  checkTrue("the backlog counts it as stalled rather than as waiting", backlog.stalled >= 1);
  checkTrue("and the ledger can report an infected count", backlog.infected >= 1);

  // ── A deployment with no scanner ─────────────────────────────────────────
  //
  // The other half of ATS-9. `skipped` must stay reachable and must say what it
  // means, so a deployment that has not scanned anything is describable rather
  // than silently indistinguishable from one that has. Which branch `storeCv`
  // takes is decided by `virusScanner().configured`, proven in the files suite;
  // this is the row that branch writes.
  const unscannedId = await attach("none", "skipped");

  const [described] = await admin`
    select scan_status, scanner_note from candidate_documents where id = ${unscannedId}::uuid
  `;
  check("an upload with no scanner is recorded skipped, not pending", described?.["scan_status"], "skipped");
  check(
    "and the row says why, in words a recruiter can read",
    described?.["scanner_note"],
    "No antivirus provider is configured for this deployment",
  );
  checkTrue(
    "skipped stays downloadable — it is a deployment state, not an unknown one",
    isDownloadable("skipped"),
  );

  // A default sweep leaves it alone: on a deployment with no scanner there is
  // nothing to do with it, and churning it would be work that changes nothing.
  check("the ordinary pass does not touch a skipped file", await withTenant(ctx, (tx) => claimNextDocumentScan(tx)), null);

  // The second pass exists for exactly this file: the day a scanner is
  // configured, everything that arrived before it is still unscanned and
  // nothing else would ever go back for it.
  const rescan = await withTenant(ctx, (tx) => claimNextDocumentScan(tx, true));
  check("once a scanner exists, a skipped file is re-scannable", rescan?.documentId, unscannedId);
  check("and it is recognisable as a re-scan", rescan?.previousStatus, "skipped");

  // ── The upload transport ─────────────────────────────────────────────────
  const clientUploadId = `${RUN}-photo`;
  const payload = new Uint8Array(150_000);
  for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
  const chunkSize = 64 * 1024;
  const chunkCount = Math.ceil(payload.length / chunkSize);

  const opened = await withTenant(ctx, (tx) =>
    openUpload(tx, ctx, {
      clientUploadId,
      purpose: "job_photo",
      reference: `zz-scan-${RUN}`,
      filename: "site.jpg",
      totalBytes: payload.length,
      chunkSize,
      chunkCount,
      declaredSha256: sha256Hex(payload),
    }),
  );
  check("opening an upload gives it the right number of parts", opened.session.chunkCount, chunkCount);
  check("and nothing has arrived yet", opened.session.receivedChunks, 0);

  // §8.3: request succeeded, response lost, client retries. The retry must find
  // the same session, not open a second one.
  const reopened = await withTenant(ctx, (tx) =>
    openUpload(tx, ctx, {
      clientUploadId,
      purpose: "job_photo",
      totalBytes: payload.length,
      chunkSize,
      chunkCount,
    }),
  );
  checkTrue("a retried init returns the same session", reopened.reused);
  check("with the same id", reopened.session.sessionId, opened.session.sessionId);

  const sessionId = opened.session.sessionId;
  for (let index = 0; index < chunkCount; index++) {
    const start = index * chunkSize;
    const bytes = payload.subarray(start, Math.min(start + chunkSize, payload.length));
    await withTenant(ctx, (tx) =>
      receiveChunk(tx, ctx, { sessionId, chunkIndex: index, bytes, sha256: sha256Hex(bytes) }),
    );
  }

  // The counter is recounted from the rows, not incremented. An increment
  // drifts on the first resend, and a drifted counter is a session that reports
  // itself complete while a chunk is missing.
  const resent = await withTenant(ctx, (tx) => {
    const bytes = payload.subarray(0, chunkSize);
    return receiveChunk(tx, ctx, { sessionId, chunkIndex: 0, bytes, sha256: sha256Hex(bytes) });
  });
  checkTrue("a resent chunk is recognised as a duplicate", resent.duplicate);
  check("and does not inflate the count", resent.received, chunkCount);
  checkTrue("the session is complete", resent.complete);

  const parts = await withTenant(ctx, (tx) => readUploadChunks(tx, sessionId));
  check("every part comes back", parts.length, chunkCount);
  const rebuilt = new Uint8Array(payload.length);
  let at = 0;
  for (const part of parts) {
    rebuilt.set(part.bytes, at);
    at += part.bytes.length;
  }
  check("and the bytes survive the round trip through Postgres", sha256Hex(rebuilt), sha256Hex(payload));

  const finished = await withTenant(ctx, (tx) =>
    completeUpload(tx, {
      sessionId,
      storageKey: `uploads/${tenantId}/job_photo/${sessionId}.jpg`,
      contentType: "image/jpeg",
      sizeBytes: payload.length,
      sha256: sha256Hex(payload),
      scanStatus: "pending",
      capturedLat: 25.1972,
      capturedLon: 55.2744,
      orientation: 6,
      metadataStripped: true,
      compression: "recompressed",
      processingNote: "test",
    }),
  );
  check("completion records the object", finished?.status, "complete");
  check("with the coordinates in a column, per §8.6", finished?.capturedLat, "25.197200");
  checkTrue("and states that the file itself was cleaned", finished?.metadataStripped);
  check("and the object is waiting on a scan", finished?.scanStatus, "pending");

  const afterComplete = await withTenant(ctx, (tx) => readUploadChunks(tx, sessionId));
  check("the staged parts are released once the object is stored", afterComplete.length, 0);

  const twice = await withTenant(ctx, (tx) =>
    completeUpload(tx, {
      sessionId,
      storageKey: "uploads/second/attempt.jpg",
      contentType: "image/jpeg",
      sizeBytes: 1,
      sha256: "0".repeat(64),
      scanStatus: "pending",
      metadataStripped: false,
      compression: "unchanged",
      processingNote: "should not happen",
    }),
  );
  check("completing twice does nothing the second time", twice, null);
  const unchanged = await withTenant(ctx, (tx) => getUpload(tx, sessionId));
  check("and the first object is still the one on record", unchanged?.sizeBytes, payload.length);

  // ── Abandoned uploads ────────────────────────────────────────────────────
  const abandoned = await withTenant(ctx, (tx) =>
    openUpload(tx, ctx, {
      clientUploadId: `${RUN}-abandoned`,
      purpose: "job_photo",
      totalBytes: chunkSize * 2,
      chunkSize,
      chunkCount: 2,
      ttlHours: 1,
    }),
  );
  const orphan = payload.subarray(0, chunkSize);
  await withTenant(ctx, (tx) =>
    receiveChunk(tx, ctx, {
      sessionId: abandoned.session.sessionId,
      chunkIndex: 0,
      bytes: orphan,
      sha256: sha256Hex(orphan),
    }),
  );

  const pressure = await withTenant(ctx, (tx) => uploadPressure(tx));
  checkTrue("an unfinished upload shows as pressure on the database", pressure.bytesStaged >= chunkSize);

  // Aged past its expiry rather than waiting an hour.
  await admin`update upload_sessions set expires_at = now() - interval '1 minute' where id = ${abandoned.session.sessionId}::uuid`;

  const reclaimed = await withTenant(ctx, (tx) => sweepAbandonedUploads(tx));
  checkTrue("the sweep reclaims it", reclaimed.abandoned >= 1);
  checkTrue("and reports the bytes it freed", reclaimed.bytesReclaimed >= chunkSize);

  const sweptSession = await withTenant(ctx, (tx) => getUpload(tx, abandoned.session.sessionId));
  check("the session survives, so the failure is still countable", sweptSession?.status, "aborted");
  check(
    "but its chunks are gone",
    (await withTenant(ctx, (tx) => readUploadChunks(tx, abandoned.session.sessionId))).length,
    0,
  );

  const abortAgain = await withTenant(ctx, (tx) => abortUpload(tx, abandoned.session.sessionId, "again"));
  check("aborting an already-aborted upload changes nothing", abortAgain, false);

  // ── Tenant isolation ─────────────────────────────────────────────────────
  //
  // The tables are new, so the blanket policy loop in sql/rls.sql has to have
  // covered them. It runs over every table carrying a tenant_id, and this is
  // the assertion that it did.
  for (const table of ["upload_sessions", "upload_chunks"]) {
    const [policy] = await admin`
      select c.relrowsecurity, c.relforcerowsecurity,
             exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'tenant_isolation') as scoped
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = ${table}
    `;
    checkTrue(`${table} has row-level security`, policy?.["relrowsecurity"]);
    checkTrue(`${table} forces it, so the owner connection cannot slip past`, policy?.["relforcerowsecurity"]);
    checkTrue(`${table} carries the tenant_isolation policy`, policy?.["scoped"]);
  }

  const acrossTenants = await withTenant(
    { tenantId: "00000000-0000-0000-0000-000000000000", actorKind: "system" as const },
    (tx) => getUpload(tx, sessionId),
  );
  check("an upload does not resolve under another tenant", acrossTenants, null);

  await cleanup();
  await admin.end();
  await closeConnection();

  console.log(`\n${fail === 0 ? "db/scanning: all checks passed" : `${fail} FAILING`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error: unknown) => {
  console.error(error);
  await cleanup().catch(() => {});
  await admin.end().catch(() => {});
  await closeConnection().catch(() => {});
  process.exit(1);
});
