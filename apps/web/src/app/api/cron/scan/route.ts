import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  claimNextDocumentScan,
  parkDocumentScan,
  pendingUploadScans,
  recordScanVerdict,
  recordUploadScan,
  scanBacklog,
  sweepAbandonedUploads,
  uploadPressure,
} from "@meridian/db/domain";
import { imagePipeline, objectStore, virusScanner } from "@meridian/files";
import { runCron } from "@/lib/cron";

/**
 * The virus sweep (`ATS-9`) and media-ingest hygiene (TRD §8.6). Every 10
 * minutes.
 *
 * ── WHY THE SCAN IS A SWEEP AND NOT PART OF THE UPLOAD ─────────────────────
 *
 * `ATS-9` says asynchronous, and it is right to. A public careers form that
 * waits on a virus scan before answering is a form that times out on a phone in
 * a car park, and `ATS-3` makes the CV optional precisely because this workforce
 * is not sitting at a desk. So the upload commits, the row says `pending`, the
 * download route refuses `pending`, and this job is what moves it.
 *
 * ── WHAT MAKES IT SAFE TO RUN TWICE AT ONCE ────────────────────────────────
 *
 * `claimNextDocumentScan` selects `for update skip locked` and then claims with
 * a conditional `scan_claimed_at is null` UPDATE, both inside the transaction
 * that also writes the verdict. A second run never sees a held row; if it
 * somehow did, its claim would match nothing and it would do nothing. A run
 * that dies mid-scan rolls its claim back and the next run picks the document
 * up. At most once, at least once, never twice — the same guarantee, and the
 * same mechanism, as the interview-reminder sweep.
 *
 * One transaction per document rather than one per batch, deliberately: the
 * scan is a network round trip to a daemon, and a transaction held open across
 * fifty of those is a transaction holding fifty row locks for a minute.
 *
 * ── WHAT THIS ROUTE SAYS WHEN IT CANNOT DO ITS JOB ─────────────────────────
 *
 * A deployment with no scanner configured is a legitimate deployment. It is not
 * a deployment that has scanned anything, and this route says so on every run
 * rather than returning a green tick over a queue nobody is draining. The same
 * for HEIC: if the runtime cannot decode it, every HEIC certificate in the
 * system is a file staff cannot open, and that is a sentence in the ledger
 * rather than a mystery on a screen.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * How many documents one invocation will scan.
 *
 * Bounded because the route has a 60-second budget and each scan is a round
 * trip. A backlog larger than this is drained over successive runs and is
 * reported as a backlog, which is the honest behaviour — the alternative is a
 * function that times out halfway and leaves its last claim rolled back every
 * single run.
 */
const SCAN_BUDGET = 40;

export async function GET(request: Request) {
  return runCron("scan", request, async () => {
    const scanner = virusScanner();
    const pipeline = await imagePipeline();
    const tenants = await activeTenantIds();
    const store = objectStore();

    let scanned = 0;
    let clean = 0;
    let infected = 0;
    let rescanned = 0;
    let parked = 0;
    let uploadsScanned = 0;
    let uploadsInfected = 0;
    let abandonedUploads = 0;
    let bytesReclaimed = 0;

    let pendingTotal = 0;
    let stalledTotal = 0;
    let skippedTotal = 0;
    let infectedTotal = 0;
    let oldestPendingMinutes = 0;
    let openUploads = 0;
    let stagedBytes = 0;

    const infectedFiles: string[] = [];
    const warnings: string[] = [];

    for (const tenantId of tenants) {
      const ctx = { tenantId, actorKind: "system" as const };

      // ── The sweep proper ──────────────────────────────────────────────────
      if (scanner.configured) {
        // Two passes. The first drains `pending`, which is somebody waiting.
        // The second re-scans `skipped` — files that arrived before a scanner
        // existed, which nothing else would ever go back for — and only once
        // the first pass has run dry.
        for (const includeSkipped of [false, true]) {
          while (scanned < SCAN_BUDGET) {
            const done = await withTenant(ctx, async (tx) => {
              const claimed = await claimNextDocumentScan(tx, includeSkipped);
              if (!claimed) return false;

              const stored = await store.get(claimed.storageKey).catch(() => null);

              if (!stored) {
                // The row cites an object that is not there. Left `pending` and
                // therefore undownloadable, which is correct — nobody knows
                // anything about this file — but the claim stays committed so
                // the sweep stops picking it first on every run and livelocking
                // behind it. Counted and named below.
                await parkDocumentScan(tx, {
                  documentId: claimed.documentId,
                  note: "The stored object is missing; nothing was scanned. Needs a person.",
                });
                parked += 1;
                return true;
              }

              const verdict = await scanner.scanner.scan(stored.body);

              await recordScanVerdict(tx, ctx, {
                documentId: claimed.documentId,
                applicationId: claimed.applicationId,
                status: verdict.status,
                note:
                  verdict.status === "infected"
                    ? `${scanner.scanner.name}: ${verdict.signature}`
                    : `${scanner.scanner.name}: clean`,
              });

              scanned += 1;
              if (claimed.previousStatus === "skipped") rescanned += 1;
              if (verdict.status === "infected") {
                infected += 1;
                if (infectedFiles.length < 20) {
                  infectedFiles.push(
                    `${claimed.filename ?? claimed.documentId} (${claimed.kind}, ${verdict.signature})`,
                  );
                }
              } else {
                clean += 1;
              }
              return true;
            });

            if (!done) break;
          }
        }

        // The same gate over uploaded media. Job photos and signatures come
        // from a technician's own phone rather than from the public internet,
        // which lowers the risk and does not remove it — a device is a device.
        for (const upload of await withTenant(ctx, (tx) => pendingUploadScans(tx, SCAN_BUDGET))) {
          const stored = await store.get(upload.storageKey).catch(() => null);
          if (!stored) continue;

          const verdict = await scanner.scanner.scan(stored.body);
          const recorded = await withTenant(ctx, (tx) =>
            recordUploadScan(tx, { sessionId: upload.sessionId, scanStatus: verdict.status }),
          );

          if (recorded) {
            uploadsScanned += 1;
            if (verdict.status === "infected") uploadsInfected += 1;
          }
        }
      }

      // ── Hygiene, which runs whether or not a scanner exists ───────────────
      //
      // An abandoned upload is a pile of chunk bytes in Postgres that nothing
      // will ever come back for — and, until it is assembled, bytes nothing has
      // scanned either. Reclaiming them belongs to the job that owns unscanned
      // bytes, which is this one.
      await withTenant(ctx, async (tx) => {
        const swept = await sweepAbandonedUploads(tx);
        abandonedUploads += swept.abandoned;
        bytesReclaimed += swept.bytesReclaimed;

        const backlog = await scanBacklog(tx);
        pendingTotal += backlog.pending;
        stalledTotal += backlog.stalled;
        skippedTotal += backlog.skipped;
        infectedTotal += backlog.infected;
        oldestPendingMinutes = Math.max(oldestPendingMinutes, backlog.oldestPendingMinutes);

        const pressure = await uploadPressure(tx);
        openUploads += pressure.open;
        stagedBytes += pressure.bytesStaged;
      });
    }

    // ── What this deployment cannot do, said every run ────────────────────
    if (!scanner.configured) {
      warnings.push(
        `${scanner.reason} ${pendingTotal} candidate document(s) are sitting at "pending" and ` +
          "cannot be downloaded by anybody until something scans them — set CLAMAV_HOST or " +
          "CLAMAV_SOCKET, or accept that this deployment stores files nobody has looked at.",
      );
    }

    if (infected > 0 || infectedTotal > 0) {
      warnings.push(
        `${infected} file(s) failed the virus scan on this run; ${infectedTotal} infected file(s) ` +
          "are on record. They are blocked from download and are never attached to outbound " +
          `staff email. ${infectedFiles.join("; ")}`,
      );
    }

    if (parked > 0 || stalledTotal > 0) {
      warnings.push(
        `${stalledTotal} document(s) were claimed by this sweep and could not be scanned — the ` +
          "stored object is missing. They stay undownloadable, which is right, and they will not " +
          "be retried: clearing scan_claimed_at puts one back in the queue once somebody has " +
          "worked out where the file went.",
      );
    }

    if (oldestPendingMinutes > 60 && scanner.configured) {
      warnings.push(
        `The oldest unscanned document has been waiting ${oldestPendingMinutes} minutes. The ` +
          `sweep scans at most ${SCAN_BUDGET} per run; a backlog this old means either the ` +
          "daemon is slow or it is not answering.",
      );
    }

    if (!pipeline.available) {
      warnings.push(pipeline.reason);
    } else if (!pipeline.heicDecode) {
      warnings.push(
        `${pipeline.note} Certificates photographed on an iPhone arrive as HEIC, and a file the ` +
          "office cannot open is the same as a file that was never sent.",
      );
    }

    return {
      processed: scanned + uploadsScanned + abandonedUploads,
      detail: {
        scanner: scanner.configured ? scanner.scanner.name : "none",
        imageProcessor: pipeline.available ? pipeline.processor.name : "none",
        heicConversion: pipeline.available && pipeline.heicDecode,
        tenants: tenants.length,
        documentsScanned: scanned,
        clean,
        infected,
        rescannedAfterSkip: rescanned,
        parked,
        uploadsScanned,
        uploadsInfected,
        backlogPending: pendingTotal,
        backlogStalled: stalledTotal,
        backlogSkipped: skippedTotal,
        infectedOnRecord: infectedTotal,
        oldestPendingMinutes,
        openUploads,
        stagedBytes,
        abandonedUploads,
        bytesReclaimed,
      },
      warnings,
    };
  });
}
