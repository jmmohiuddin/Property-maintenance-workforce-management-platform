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
 * It does **not** survive a page reload. Resumption across a reload needs the
 * `clientUploadId` to outlive the page — the id is the idempotency key, and
 * without the same one the server correctly opens a second session — and that
 * means persisting it against the file's identity in `sessionStorage`. That is
 * a real feature with real edge cases (which file is "the same" file?) and it
 * is not built. A reload starts the upload again.
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

  // The idempotency key. Generated before the server is involved, exactly as
  // the field app's device does — a retried init returns the same session
  // rather than opening a second one.
  const clientUploadId = crypto.randomUUID();

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

  return { uploadId, filename: file.name };
}
