/**
 * The virus-scanner seam (`ATS-9`, TRD §8.6).
 *
 * ── WHAT WAS HERE BEFORE ────────────────────────────────────────────────────
 *
 * `candidate_documents.scan_status` has been a CHECK-constrained column with
 * four honest states since migration 0014, the download route re-derives its
 * gate from the row on every request, and the candidate screen labels every
 * file with its status. All of that was real. What was not real was the
 * scanner: the only writer was the public CV upload, it hardcoded `skipped`,
 * nothing ever wrote `pending`, and no code path anywhere moved a row from
 * `pending` to `clean` or `infected`. A state machine with no engine behind it.
 *
 * ── WHY CLAMAV AND NOT A SCANNING API ───────────────────────────────────────
 *
 * The files this gate protects are applicant CVs. `OPEN-2` — where this
 * system's data is allowed to live — is open, and `INFRA-1` requires electronic
 * records to be retained in the UAE. Posting a CV to a third-party scanning
 * API would send a named person's phone number, employment history and
 * certificate numbers to a jurisdiction nobody has chosen yet, and would settle
 * OPEN-2 by accident, in the direction that is hardest to reverse. A daemon the
 * deployment runs itself keeps the bytes inside the deployment.
 *
 * ── WHY THIS IS AN INTERFACE AND NOT A FUNCTION ─────────────────────────────
 *
 * ClamAV is not present in CI and is not present on a developer's laptop, and a
 * test suite that needs a daemon running is a test suite that gets skipped. So
 * the shape here is the one the object store already uses: an interface, one
 * real driver, and an explicit *not configured* state that says so out loud
 * rather than degrading into a quiet "assume it's fine". The tests drive the
 * interface with a scanner they control, and drive the ClamAV wire protocol
 * itself through pure functions that need no socket — see `clamav.ts` and
 * `test/scan.test.ts`.
 *
 * ── WHY `skipped` SURVIVES ──────────────────────────────────────────────────
 *
 * A deployment with no scanner is a legitimate deployment; it is just one that
 * has not scanned anything. `skipped` is that statement, it is downloadable,
 * and every screen that shows it says "Not virus-scanned". The state this
 * module refuses to allow is a file that *looks* scanned and was not.
 */

import { ClamAvScanner } from "./clamav";

/** What a scanner concluded about one file. */
export type ScanVerdict =
  | { readonly status: "clean" }
  /** `signature` is the scanner's own name for what it found; kept for the row. */
  | { readonly status: "infected"; readonly signature: string };

export interface VirusScanner {
  /** Recorded on the document row, so "what scanned this" survives a redeploy. */
  readonly name: string;
  /** Resolves with a verdict, or throws. A throw means "no verdict", never "clean". */
  scan(bytes: Uint8Array): Promise<ScanVerdict>;
}

/**
 * Whether this deployment can scan, and if not, why not.
 *
 * A discriminated union rather than `VirusScanner | null`, because the reason
 * is the part callers need: the cron ledger prints it, and "no scanner" with no
 * explanation is a support ticket.
 */
export type ScannerState =
  | { readonly configured: true; readonly scanner: VirusScanner }
  | { readonly configured: false; readonly reason: string };

let _override: VirusScanner | undefined;
let _cached: ScannerState | undefined;

/**
 * The configured scanner.
 *
 * `CLAMAV_HOST` (with optional `CLAMAV_PORT`, default 3310) selects the TCP
 * driver; `CLAMAV_SOCKET` selects the same driver over a unix socket, which is
 * what a sidecar container normally offers. Neither set means no scanner, and
 * that is reported rather than guessed at.
 *
 * Deliberately *not* defaulting to localhost:3310. A default that silently
 * points at a port nothing is listening on turns "no scanner configured" —
 * which is a true and actionable statement — into "the scanner is down", which
 * is a false one, and every upload then sits `pending` and undownloadable with
 * no explanation anybody can act on.
 */
export function virusScanner(): ScannerState {
  if (_override) return { configured: true, scanner: _override };
  if (_cached) return _cached;

  const socket = process.env["CLAMAV_SOCKET"]?.trim();
  const host = process.env["CLAMAV_HOST"]?.trim();

  if (!socket && !host) {
    _cached = {
      configured: false,
      reason:
        "No virus scanner is configured (CLAMAV_HOST or CLAMAV_SOCKET unset). Uploaded files " +
        "are recorded as `skipped` — nobody scanned them — and are labelled that way wherever " +
        "they appear. ATS-9 asks for asynchronous scanning; this deployment does not do it.",
    };
    return _cached;
  }

  const port = Number(process.env["CLAMAV_PORT"]?.trim() || "3310");
  if (!socket && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    _cached = {
      configured: false,
      reason: `CLAMAV_PORT is ${JSON.stringify(process.env["CLAMAV_PORT"])}, which is not a port number.`,
    };
    return _cached;
  }

  _cached = {
    configured: true,
    scanner: socket ? new ClamAvScanner({ socketPath: socket }) : new ClamAvScanner({ host: host!, port }),
  };
  return _cached;
}

/** Tests and scripts that want a scanner they control. `undefined` restores env resolution. */
export function setVirusScanner(scanner: VirusScanner | undefined): void {
  _override = scanner;
  _cached = undefined;
}

/**
 * A scanner that refuses to answer.
 *
 * Not a stub for production and not a default: it exists so a test can prove
 * that a failing scanner leaves a document `pending` rather than nudging it to
 * `clean`, which is the failure mode that would make the whole gate decorative.
 */
export class UnavailableScanner implements VirusScanner {
  readonly name = "unavailable";
  constructor(private readonly message = "The scanner did not answer") {}
  scan(): Promise<ScanVerdict> {
    return Promise.reject(new Error(this.message));
  }
}
