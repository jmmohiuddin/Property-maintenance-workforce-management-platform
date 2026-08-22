import "server-only";
import { downloadHeaders, objectStore } from "@meridian/files";
import { InvoiceNotRenderableError, QuoteNotRenderableError } from "@meridian/core";

/**
 * Serving a stored document.
 *
 * Shared by the invoice and quotation download routes so that `SEC-8`'s
 * response rules are held in one place. Every header comes from
 * `downloadHeaders` in `packages/files`; nothing here adds to them, because a
 * route that assembles its own is a route that will one day omit
 * `Content-Disposition: attachment`.
 *
 * ── WHY THESE ROUTES RETURN STATUS CODES AND NOT REDIRECTS ──────────────────
 *
 * `requireSessionWith()` redirects a caller without permission to `/denied`,
 * which is right for a page — the usual cause is a role that legitimately does
 * not include that screen, and the person needs to know where they *can* go. It
 * is wrong here. A browser following a redirect from a download link saves the
 * `/denied` HTML as `SATS-INV-2026-0184.pdf`, and the operator opens a file
 * that looks like a corrupt invoice rather than seeing that they were refused.
 */

/** The stored bytes, as an attachment. */
export async function serveStoredDocument(input: {
  storageKey: string;
  reference: string;
}): Promise<Response> {
  const stored = await objectStore().get(input.storageKey);

  if (!stored) {
    // The row says there is an artefact and the store disagrees. That is a
    // real operational fault — most likely a driver pointed at a different
    // root — and it must not be reported as "not found", which would send
    // somebody looking for a missing invoice rather than a missing bucket.
    console.error(`[documents] ${input.storageKey} is on the record but not in the store`);
    return new Response(
      "This document's record points at a stored file that is not there. Check FILES_LOCAL_ROOT.",
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  return new Response(new Uint8Array(stored.body), {
    headers: downloadHeaders({ object: stored.object, filename: input.reference }),
  });
}

/**
 * What a failed download is allowed to say.
 *
 * A refusal to render is not an error to swallow: it is the operator's list of
 * what is missing, and it is the whole point of `assertRenderable`. So it is
 * returned in full, with a 409 — the request was well-formed and the document
 * is genuinely not in a state to be produced. Everything else follows
 * `lib/errors.ts`: logged where operations can see it, and replaced with a
 * sentence that says what to do next.
 */
export function documentErrorResponse(error: unknown, context: string): Response {
  if (error instanceof InvoiceNotRenderableError || error instanceof QuoteNotRenderableError) {
    return new Response(`${error.message}\n\n${error.problems.map((p) => `  - ${p}`).join("\n")}\n`, {
      status: 409,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  console.error(`[documents:${context}]`, error);
  return new Response(
    "The document could not be produced. This has been logged; the operations team can see the reason.",
    { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}

/** 401 and 403 as plain text, for the reason given at the top of this file. */
export function refused(status: 401 | 403, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
