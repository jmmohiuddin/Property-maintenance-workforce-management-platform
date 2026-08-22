import { isStaff } from "@meridian/auth";
import { withCustomerScope, getPortalJobPhoto } from "@meridian/db";
import { objectStore, safeFilename, type AllowedContentType } from "@meridian/files";
import { getSession } from "@/lib/session";
import { refused } from "@/lib/documents";

/**
 * One before-or-after photograph from a job, served to the customer (`POR-9`).
 *
 * ── THE FILE IS THE RISK, AND THIS IS WHERE IT IS HELD ──────────────────────
 *
 * A photograph is an object-storage key. The whole of `POR-9`'s security
 * question is whether that key can ever be in the browser's hands, and the
 * answer here is no: the URL names a job and an attachment ROW, and
 * `getPortalJobPhoto` resolves the key from that row inside a customer-scoped
 * transaction. Nothing in this file constructs a key, accepts one, or logs one.
 *
 * This is the same shape as `(portal)/portal/invoices/[id]/document`, which is
 * the file to read alongside this one. The single line doing the work is the
 * same line: the transaction is opened with `withCustomerScope`, so Postgres
 * applies the RESTRICTIVE policy on `job_attachments` — which scopes through
 * the parent job's `customer_id` — and another customer's photograph is not
 * refused, it is *absent*. The lookup returns null and the answer is 404.
 *
 * ── WHY 404 FOR EVERYTHING ──────────────────────────────────────────────────
 *
 * Not yours, not there, deleted, and "that attachment is a signature rather
 * than a photograph" all produce the same response. A 403 on one of them and a
 * 404 on another turns this route into an existence oracle: a caller walking
 * ids would learn which ones name real rows on somebody else's job. The
 * invoice route makes the same choice for the same reason.
 *
 * ── WHY THIS SERVES INLINE, WHEN EVERY OTHER DOWNLOAD IS AN ATTACHMENT ──────
 *
 * `packages/files/download.ts` sets `Content-Disposition: attachment` on every
 * stored document and gives the reason: a document rendered same-origin is a
 * document whose contents can reach the page's JavaScript context. That reason
 * is about active content — a PDF with embedded JavaScript, an HTML file, an
 * SVG with a `<script>` in it. It does not carry over to a raster image, and
 * applying it here would defeat the requirement: `POR-9` asks for photographs
 * the customer can SEE, and a screen of eight "download" links is the thing
 * they will telephone about rather than the thing that stops them telephoning.
 *
 * What makes inline safe here is that the type is not negotiable:
 *
 *   * The content type comes from `objectStore().get()`, which sniffs it from
 *     the magic bytes on write. It is never the `mime_type` column, which is
 *     whatever an uploader claimed.
 *   * `RENDERABLE` is a three-item allowlist of raster formats. SVG is not on
 *     the store's allowlist at all and could not reach this route if it were
 *     on this one; anything else stored under a photograph row is a data fault
 *     and is reported as one rather than served.
 *   * `nosniff` stops a browser second-guessing the declared type, and the
 *     sandbox CSP neutralises the case where somebody navigates to the URL
 *     directly instead of loading it in an `<img>`.
 *
 * `image/heic` is on the store's allowlist and is what an iPhone produces, but
 * no browser outside Safari renders it. It is served as an attachment rather
 * than as a broken image — the screen reads the same column and offers a
 * download link for those, so the two agree.
 *
 * ── CACHING ─────────────────────────────────────────────────────────────────
 *
 * `private, no-store`. The response is scoped to one customer's session, and a
 * shared cache is a place where the next requester's permissions are never
 * checked. A photograph cached at a CDN is one customer's plant room served to
 * the next caller.
 */

// Node, not edge: the storage driver uses `node:fs`. Force-dynamic because the
// response is per-session and must never be cached at the route level.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The raster formats a browser will render in an `<img>`. */
const RENDERABLE: ReadonlySet<string> = new Set<AllowedContentType>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Renderable, plus the phone format that is a photograph but not renderable. */
const SERVABLE: ReadonlySet<string> = new Set<AllowedContentType>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; photoId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to view this photograph.");

  // Staff are refused rather than served, for the reason the invoice route
  // gives: a staff session has no `customerId`, so `withCustomerScope` has
  // nothing to scope to and every lookup would return nothing. A clear refusal
  // beats a 404 that reads as a missing photograph.
  if (isStaff(session.principal.role)) {
    return refused(403, "Staff open job photographs from the job screen, not the portal.");
  }

  const customerId = session.principal.customerId;
  // A customer-role membership with no customer_id is a misconfiguration, and
  // the one thing that must not happen is falling back to an unscoped read.
  if (!customerId) {
    return refused(403, "This portal account is not linked to a customer record.");
  }

  const { id, photoId } = await params;

  const photo = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId,
      userId: session.principal.userId,
      actorKind: "customer",
    },
    (tx) => getPortalJobPhoto(tx, id, photoId),
  );

  if (!photo) return notThere();

  const stored = await objectStore().get(photo.storageKey);

  if (!stored) {
    // The row says there is a photograph and the store disagrees. An
    // operational fault — most likely a driver pointed at a different root —
    // and it must not be reported as "not found", which would send somebody
    // looking for a deleted photo rather than a missing bucket. The key goes to
    // the server log and never into the response.
    console.error(`[portal-photo] ${photo.storageKey} is on the record but not in the store`);
    return new Response(
      "This photograph is on the job record but the file could not be read. This has been " +
        "logged; the operations team can see the reason.\n",
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  if (!SERVABLE.has(stored.object.contentType)) {
    // A photograph row pointing at a PDF or a Word document. Not a security
    // hole — the store's own allowlist means it cannot be an SVG or an HTML
    // page — but it is a record that is not what it claims to be, and serving
    // it under `photo_after` would be this route lying about its own contents.
    console.error(
      `[portal-photo] attachment ${photo.id} is kind ${photo.kind} but the stored object is ` +
        `${stored.object.contentType}`,
    );
    return new Response(
      "This attachment is recorded as a photograph but the stored file is not an image. " +
        "This has been logged.\n",
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const contentType = stored.object.contentType;
  const inline = RENDERABLE.has(contentType);
  // The job reference and which half of the pair it is, so a saved file still
  // says what it is a photograph of. The caption is deliberately not used: it
  // is free text and this is a filename.
  const filename = safeFilename(`${photo.jobReference}-${photo.kind}`, contentType);

  return new Response(new Uint8Array(stored.body), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(stored.object.sizeBytes),
      "Content-Disposition":
        `${inline ? "inline" : "attachment"}; filename="${filename}"; ` +
        `filename*=UTF-8''${encodeURIComponent(filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store, max-age=0",
      // `sandbox` alone, and not `default-src 'none'` as the document downloads
      // use. When a browser navigates straight to an image URL it wraps the
      // bytes in a synthetic document, and `default-src 'none'` blocks the
      // image inside that document — the header would hide the photograph from
      // the person entitled to it. `sandbox` is the clause that matters anyway:
      // it strips the origin and disables scripting for that navigation.
      "Content-Security-Policy": "sandbox",
      // Strong, not weak: the hash covers the exact bytes.
      ETag: `"${stored.object.sha256}"`,
      Vary: "Cookie",
    },
  });
}

/** Every reason the photograph is not available, said the same way. */
function notThere(): Response {
  return new Response("That photograph is not on your account.\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
