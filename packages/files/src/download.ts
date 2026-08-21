/**
 * Serving a stored object.
 *
 * Every one of these headers is a clause of `SEC-8`, and each is here because
 * of a specific way downloads go wrong:
 *
 *  * `Content-Disposition: attachment` — the file is saved, never rendered in
 *    the tab. A document rendered same-origin is a document whose contents can
 *    reach the page's JavaScript context and the session cookie with it.
 *  * `X-Content-Type-Options: nosniff` — the browser must not second-guess the
 *    declared type. Without it, a browser that decides a file "looks like"
 *    HTML will treat it as HTML.
 *  * `Cache-Control: private, no-store` — the artefact is permission-gated on
 *    every request, so it must not sit in a shared cache where the next
 *    requester's permissions are never checked.
 *  * `Content-Security-Policy: sandbox` — belt and braces for the case where a
 *    future browser or a misconfigured proxy ignores the disposition anyway.
 *
 * The filename carries both the plain and the RFC 5987 encoded form, because
 * the plain one is what old clients read and the encoded one is what carries a
 * non-ASCII reference correctly.
 */

import { safeFilename, type AllowedContentType } from "./sniff";
import type { StoredObject } from "./store";

export function downloadHeaders(input: {
  object: Pick<StoredObject, "contentType" | "sizeBytes" | "sha256">;
  /** Human-meaningful name — usually the document reference. */
  filename: string;
}): Headers {
  const filename = safeFilename(input.filename, input.object.contentType as AllowedContentType);

  return new Headers({
    "Content-Type": input.object.contentType,
    "Content-Length": String(input.object.sizeBytes),
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    // Strong, not weak: the hash covers the exact bytes, so a client holding a
    // matching ETag genuinely holds this artefact and not a re-render of it.
    ETag: `"${input.object.sha256}"`,
  });
}
