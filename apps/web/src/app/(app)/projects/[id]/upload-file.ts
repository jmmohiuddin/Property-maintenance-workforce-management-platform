/**
 * Driving `/api/uploads` from a browser.
 *
 * ── WHY THIS EXISTS HERE AND IS THIS SMALL ─────────────────────────────────
 *
 * The transport in `apps/web/src/lib/uploads.ts` is deliberately server-side
 * and chunked: a permit PDF or a snag photograph goes up in parts, each part is
 * idempotent, and the server can always be asked which parts are still missing.
 * Nothing in this application drove it from a browser before — the field app
 * has its own queue and the staff console had no upload screen — so this is the
 * first client, and it is colocated with the only screen that uses it rather
 * than promoted to `lib/` on the strength of one caller.
 *
 * ── WHAT IT ACTUALLY DOES, STATED HONESTLY ─────────────────────────────────
 *
 * It is genuinely chunked and it genuinely resumes *within one attempt*: after
 * a pass over the parts it asks the server what is still missing and sends only
 * that, up to three passes, so a connection that drops halfway through part
 * eleven of twenty does not restart at part one.
 *
 * ── AND IT NOW SURVIVES A PAGE RELOAD ───────────────────────────────────────
 *
 * It used to not. `clientUploadId` is the idempotency key `openUpload` matches
 * on — the reason the server always returns the *same* session for the same id
 * is `§8.3`'s "the dominant real-world failure is request succeeded, response
 * lost, client retries" — but the id was generated fresh with
 * `crypto.randomUUID()` on every call and lived only in a JS variable. A tab
 * reload after part eleven of twenty had gone up did not resume that session;
 * it could not even find it, because the one fact that named it — the id — was
 * gone with the tab. The upload restarted at part one, chunks it had already
 * paid for on hotel or site wifi and all.
 *
 * "Which file is the same file" turned out to have an answer already sitting
 * in this function: `sha256`. It is computed before the server is ever
 * contacted, it is content-addressed rather than name-addressed (a renamed
 * copy of the same photograph is still the same upload; two different files
 * that happen to share a name are not confused with each other), and nothing
 * else needs deriving. So the id is now looked up and stored in
 * `sessionStorage`, keyed by `purpose` and that hash, before the session is
 * opened:
 *
 *  1. The file is chosen, its bytes are hashed, and `sessionStorage` is asked
 *     whether this exact `(purpose, sha256)` pair has a `clientUploadId` on
 *     file from an earlier attempt in this tab.
 *  2. If it does, that id is reused — the `POST` to `/api/uploads` matches the
 *     existing session and comes back with the *true* `missingChunks`, which
 *     after a reload mid-upload is a handful of parts, not twenty.
 *  3. If it does not, a fresh id is generated, exactly as before, and is
 *     stored under that key immediately — before the first byte goes over the
 *     wire — so a reload one second into "opening the upload" still has
 *     something to resume.
 *  4. The entry is removed once the upload completes. A finished session has
 *     nothing left to resume, and clearing it is what stops a second, later
 *     upload of the same bytes for a different purpose from finding a stale
 *     id belonging to an attach that already happened.
 *
 * `sessionStorage`, not `localStorage`: an upload in flight belongs to this
 * tab's attempt at this form, and a stale id surviving into a browser restart
 * days later — to be matched against a session the 48-hour TTL sweep has long
 * since reclaimed — buys nothing (the server just opens a new one, as before)
 * while making the storage key list grow forever. Every access is wrapped in
 * `try`/`catch`: private browsing and a full quota both throw on `setItem`,
 * and the correct behaviour there is exactly the old behaviour — start over —
 * not a thrown error the operator cannot do anything about.
 *
 * The one thing it never does is handle a storage key. The server hands back an
 * upload id and nothing else; `sessionResponse` deliberately omits the key, and
 * the attach actions take the id.
 */

export type BrowserUploadPurpose = "project_permit_document" | "project_snag_photo";

export interface UploadedFile {
  readonly uploadId: string;
  readonly filename: string;
}

async function hexSha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The plain-text refusal these routes answer with, or a fallback. */
async function refusalText(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => "");
  const trimmed = body.trim();
  if (!trimmed) return fallback;
  // The JSON error shapes are not used by these routes, but a proxy in front of
  // them might answer with one, and dumping raw JSON at an operator is worse
  // than the fallback sentence.
  return trimmed.startsWith("{") ? fallback : trimmed;
}

interface SessionBody {
  uploadId: string;
  chunkSize: number;
  chunkCount: number;
  missingChunks: number[];
  status: string;
}

/**
 * Where an in-flight session's `clientUploadId` is kept between a chunk going
 * up and a reload wiping every JS variable that named it. See the file
 * comment above — content-addressed, per tab, best-effort.
 */
const RESUME_KEY_PREFIX = "meridian:upload-resume:";

function resumeKey(purpose: BrowserUploadPurpose, sha256: string): string {
  return `${RESUME_KEY_PREFIX}${purpose}:${sha256}`;
}

/**
 * The id a previous attempt at this exact `(purpose, sha256)` left behind, if
 * `sessionStorage` still has it and still allows reading it.
 *
 * Never throws. A private-browsing tab or a full quota is not this function's
 * problem to report — it is indistinguishable from "no earlier attempt", which
 * is the same fallback the pre-fix code always took.
 */
function loadResumeId(purpose: BrowserUploadPurpose, sha256: string): string | null {
  try {
    return sessionStorage.getItem(resumeKey(purpose, sha256));
  } catch {
    return null;
  }
}

/** Remember this attempt's id, before the first byte is sent. Best-effort. */
function saveResumeId(purpose: BrowserUploadPurpose, sha256: string, clientUploadId: string): void {
  try {
    sessionStorage.setItem(resumeKey(purpose, sha256), clientUploadId);
  } catch {
    // Nothing to resume into if this fails; the upload still proceeds, it
    // just cannot survive a reload — exactly today's behaviour.
  }
}

/** Forget it once there is nothing left to resume. Best-effort. */
function clearResumeId(purpose: BrowserUploadPurpose, sha256: string): void {
  try {
    sessionStorage.removeItem(resumeKey(purpose, sha256));
  } catch {
    // Leaving a stale entry behind costs nothing worse than the id it always
    // held: a finished session, which `openUpload` only ever hands back as-is.
  }
}

export async function uploadFile(input: {
  file: File;
  purpose: BrowserUploadPurpose;
  reference?: string;
  /** Called with a sentence fit to put on the screen, e.g. "sending part 3 of 9". */
  onPhase?: (phase: string) => void;
}): Promise<UploadedFile> {
  const { file, purpose } = input;
  const say = input.onPhase ?? (() => {});

  say("reading the file");
  const buffer = await file.arrayBuffer();
  const sha256 = await hexSha256(buffer);
  const bytes = new Uint8Array(buffer);

  // The idempotency key. `loadResumeId` recovers the one a previous attempt at
  // this exact `(purpose, sha256)` pair left in `sessionStorage`, so a page
  // reload mid-upload reopens the *same* session on the server instead of a
  // second one; only when there is nothing to recover is a fresh id generated,
  // exactly as the field app's device does. Stored again immediately either
  // way — a reload one line from now must find it too.
  const clientUploadId = loadResumeId(purpose, sha256) ?? crypto.randomUUID();
  saveResumeId(purpose, sha256, clientUploadId);

  say("opening the upload");
  const opened = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": clientUploadId },
    body: JSON.stringify({
      clientUploadId,
      purpose,
      filename: file.name,
      reference: input.reference ?? null,
      totalBytes: bytes.length,
      sha256,
    }),
  });

  if (!opened.ok) {
    throw new Error(await refusalText(opened, "The upload could not be started."));
  }

  let session = (await opened.json()) as SessionBody;
  const uploadId = session.uploadId;

  // Three passes. Each one sends what the server says is missing and then asks
  // again; a part that failed on pass one is retried on pass two, and a file
  // that is still incomplete after three is a connection problem the operator
  // needs to be told about rather than a loop to keep spinning in.
  for (let pass = 0; pass < 3 && session.missingChunks.length > 0; pass++) {
    const missing = session.missingChunks;

    for (const [n, index] of missing.entries()) {
      say(`sending part ${n + 1} of ${missing.length}`);
      const start = index * session.chunkSize;
      const slice = bytes.subarray(start, Math.min(start + session.chunkSize, bytes.length));

      const sent = await fetch(`/api/uploads/${uploadId}/chunks/${index}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        // A copy, because `subarray` is a view onto the whole file and some
        // fetch implementations would send the entire backing buffer.
        body: new Uint8Array(slice),
      });

      // Not thrown: the next pass asks the server what is still missing and
      // resends it, which is the entire reason the parts are addressable.
      if (!sent.ok && pass === 2) {
        throw new Error(await refusalText(sent, `Part ${index + 1} would not send.`));
      }
    }

    say("checking what arrived");
    const checked = await fetch(`/api/uploads/${uploadId}`, { cache: "no-store" });
    if (!checked.ok) {
      throw new Error(await refusalText(checked, "The upload could not be checked."));
    }
    session = (await checked.json()) as SessionBody;
  }

  if (session.missingChunks.length > 0) {
    throw new Error(
      `${session.missingChunks.length} part(s) of this file never arrived. The upload was not ` +
        "completed — nothing half-uploaded is attached to anything.",
    );
  }

  say("finishing");
  const completed = await fetch(`/api/uploads/${uploadId}/complete`, { method: "POST" });
  if (!completed.ok) {
    throw new Error(await refusalText(completed, "The upload could not be completed."));
  }

  // Nothing left to resume. Left in place, a finished session's id would only
  // ever be handed back as itself — harmless — but clearing it is what stops
  // it outliving its purpose in a tab that goes on to upload other files.
  clearResumeId(purpose, sha256);

  return { uploadId, filename: file.name };
}
