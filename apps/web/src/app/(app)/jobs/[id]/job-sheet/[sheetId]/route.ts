import { can, isStaff } from "@meridian/auth";
import { withTenant, listJobSheets } from "@meridian/db";
import { presentJobSheet } from "@meridian/docs";
import { downloadHeaders } from "@meridian/files";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * A job sheet: the sealed one, an amendment, or the sheet as it would be
 * presented for signature (`FLD-14`).
 *
 * ── WHY `preview` IS A DIFFERENT KIND OF THING ──────────────────────────────
 *
 * `/preview` renders the unsigned sheet on demand and stores nothing. That is
 * the opposite of every other document route here, which serves bytes written
 * once and kept — and the difference is the point. A sheet that has not been
 * signed is not an artefact, it is a view of a record that is still changing,
 * and storing one would produce a bucket full of near-identical drafts that
 * somebody would eventually mistake for evidence.
 *
 * The moment it stops changing is the moment it is signed, and that is the only
 * moment anything is written.
 *
 * A sealed sheet, by contrast, is never re-rendered. The row carries the key
 * and the store carries the bytes, and `objectStore().get` re-hashes on read —
 * so a sheet whose bytes have drifted since they were stored fails here rather
 * than being served with a straight face.
 *
 * ── WHY THE JOB ID IN THE PATH IS NOT THE AUTHORISATION ─────────────────────
 *
 * The sheet is looked up through the sheets of the job named in the path, and a
 * sheet belonging to another job simply is not in that list. Row-level security
 * scopes both to this tenant; the membership of the one in the other does the
 * rest. The same argument the photograph route makes next door.
 */

// Node, not edge: the storage driver and the PDF writer both use Node APIs.
// Force-dynamic because the response is permission-gated per request and a
// preview describes a record that is still moving.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; sheetId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to open this job sheet.");

  // Both checks, not one. A `customer` role holds `jobs:read` so the portal
  // works, and `withTenant` scopes to the tenant and not to a customer — so the
  // permission alone would once have served any customer's job sheet. The
  // portal's own copy is `POR-9`'s work and goes through a customer-scoped
  // path; this route is the office's.
  if (!isStaff(session.principal.role)) {
    return refused(403, "Job sheets are not available outside the office.");
  }
  if (!can(session.principal, "jobs:read")) {
    return refused(403, "Your role cannot read job records.");
  }

  const { id, sheetId } = await params;
  const ctx = {
    tenantId: session.principal.tenantId,
    userId: session.principal.userId,
    actorKind: "user" as const,
  };

  try {
    if (sheetId === "preview") {
      const presented = await withTenant(ctx, (tx) => presentJobSheet(tx, id));
      return new Response(new Uint8Array(presented.bytes), {
        headers: downloadHeaders({
          object: {
            contentType: "application/pdf",
            sizeBytes: presented.bytes.length,
            // The digest of these BYTES, not the content digest. The ETag has
            // to mean "you already hold this exact response" — and the content
            // digest is deliberately stable across renders that differ, so
            // using it here would let a client keep a body it no longer has.
            sha256: presented.pdfSha256,
          },
          // Named as a draft on the face of the filename as well as on the
          // page. An operator with both files open should never have to look
          // inside to tell which one the customer signed.
          filename: `${presented.reference}-unsigned`,
        }),
      });
    }

    const sheets = await withTenant(ctx, (tx) => listJobSheets(tx, id));
    const sheet = sheets.find((s) => s.id === sheetId);
    // Not found and not-on-this-job are the same answer on purpose:
    // distinguishing them would confirm that a sheet id exists elsewhere.
    if (!sheet) return refused(403, "There is no such job sheet on this job.");

    return await serveStoredDocument({
      storageKey: sheet.storageKey,
      reference: sheet.reference,
    });
  } catch (error) {
    return documentErrorResponse(error, "job-sheet");
  }
}
