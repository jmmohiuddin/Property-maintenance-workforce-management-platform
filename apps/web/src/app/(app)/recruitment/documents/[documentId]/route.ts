import { can, isStaff } from "@meridian/auth";
import { withTenant } from "@meridian/db";
import { getCandidateDocumentForDownload } from "@meridian/db/domain";
import { isDownloadable, SCAN_STATUS_LABEL } from "@meridian/core";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * A candidate's CV or certificate evidence, as a file (`ATS-9`).
 *
 * ── WHY THE ROUTE IS FLAT AND NOT NESTED UNDER THE APPLICATION ──────────────
 *
 * `candidate_documents.application_id` is nullable. A file belongs to a
 * candidate; it arrived *with* an application, or it did not — somebody in the
 * talent pool with no live application still has a CV. A route shaped
 * `/recruitment/candidate/[applicationId]/documents/[documentId]` would be
 * unable to address those files at all, and would invite the mistake of
 * treating the application id in the path as the authorisation. It is not: the
 * document id is a uuid, globally unique, and row-level security is what scopes
 * it to this tenant.
 *
 * ── WHY THE GATE IS RE-DERIVED HERE ─────────────────────────────────────────
 *
 * The candidate screen hides the link when the scan has not finished, and that
 * is a courtesy, not a control — this URL can be typed. So the scan status is
 * read again, from the row, on every request, and `isDownloadable` — the same
 * function the screen's `downloadable` flag comes from — decides. Nothing about
 * the gate is accepted as an input; there is no query parameter to pass.
 *
 * ── WHY NOT `requireSessionWith()` ──────────────────────────────────────────
 *
 * It composes exactly these checks, and it redirects. A browser following a
 * redirect from a download link saves the login page or the `/denied` HTML *as
 * the file*, and the recruiter opens what looks like a corrupt CV instead of
 * seeing that they were refused. Status codes and plain text, as in
 * `lib/documents.ts`.
 */

// Node, not edge: the storage driver uses `node:fs`. Force-dynamic because the
// response is permission-gated per request and must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download this document.");

  // Both checks, not one, and the order matters less than the fact that there
  // are two. The invoice route next door carries the scar: a `customer` role
  // holds `jobs:read` so the portal works, every query runs through
  // `withTenant`, which scopes to the tenant and NOT to a customer, and so the
  // permission alone once served any customer's invoice.
  //
  // Today no non-staff role holds `recruitment:read`, so the role check below
  // is defensive rather than load-bearing. It is written anyway, because the
  // thing that made the invoice bug possible was a permission grant made
  // elsewhere, later, for an unrelated reason — and a CV holds a phone number,
  // certificate numbers and an employment history.
  if (!isStaff(session.principal.role)) {
    return refused(403, "Candidate documents are not available outside the office.");
  }
  if (!can(session.principal, "recruitment:read")) {
    return refused(403, "Your role cannot read candidate records.");
  }

  const { documentId } = await params;

  try {
    const document = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) => getCandidateDocumentForDownload(tx, documentId),
    );

    // Not found and not-in-this-tenant are the same answer on purpose: RLS
    // returns no row for either, and distinguishing them would confirm that a
    // document id exists somewhere else.
    if (!document) return refused(403, "There is no such document.");

    if (!isDownloadable(document.scanStatus)) {
      // 409, matching the precedent in `lib/documents.ts`: the request is
      // well-formed and the resource is genuinely not in a state to be handed
      // over. The status is named, because "blocked" without a reason is a
      // recruiter opening a support ticket.
      return new Response(
        `This file cannot be downloaded yet: ${SCAN_STATUS_LABEL[document.scanStatus]}.\n\n` +
          "ATS-9 gates candidate downloads on the virus scan. A file whose scan has not " +
          "finished is a file nobody knows anything about; a file that failed is one nobody " +
          "should open.\n",
        { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }

    return await serveStoredDocument({
      storageKey: document.storageKey,
      // The applicant's own filename where there is one. `safeFilename` in
      // `packages/files` sanitises it and fixes the extension to the sniffed
      // content type, so a name that arrived from a public form cannot decide
      // what the browser thinks it is saving.
      reference: document.filename ?? `${document.kind}-${document.documentId}`,
    });
  } catch (error) {
    return documentErrorResponse(error, "recruitment-document");
  }
}
