import { can, isStaff } from "@meridian/auth";
import { withTenant, getJobCard } from "@meridian/db";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * One photograph from a job card (`JOB-15`).
 *
 * ── WHY A ROUTE RATHER THAN AN `<img src>` ──────────────────────────────────
 *
 * `SEC-8` requires private storage with no public URLs, and `packages/files`
 * holds that property by construction: its `ObjectStore` interface has no
 * `url()` method, so there is nothing a template could embed. Bytes reach a
 * browser only through a server that has already checked the requester, which
 * is what this is. The response carries `Content-Disposition: attachment` from
 * `downloadHeaders`, so the job card links rather than renders — a job
 * photograph is evidence to open, not decoration.
 *
 * ── WHY THE JOB ID IN THE PATH IS NOT THE AUTHORISATION ─────────────────────
 *
 * The attachment is looked up through the job card of the job named in the
 * path, and a photograph filed against a different job simply is not in that
 * list. So a caller cannot pair somebody else's attachment id with a job they
 * can read; row-level security scopes both to this tenant, and the membership
 * of the one in the other does the rest.
 */

// Node, not edge: the storage driver uses `node:fs`. Force-dynamic because the
// response is permission-gated per request and must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to open this photograph.");

  // Both checks, not one. The invoice route next door carries the scar: a
  // `customer` role holds `jobs:read` so the portal works, every query runs
  // through `withTenant`, which scopes to the tenant and NOT to a customer, and
  // so the permission alone once served any customer's invoice. A job
  // photograph shows the inside of somebody's property.
  if (!isStaff(session.principal.role)) {
    return refused(403, "Job photographs are not available outside the office.");
  }
  if (!can(session.principal, "jobs:read")) {
    return refused(403, "Your role cannot read job records.");
  }

  const { id, attachmentId } = await params;

  try {
    const card = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) => getJobCard(tx, id),
    );

    const photo = card.photos.find((p) => p.id === attachmentId);
    // Not found and not-on-this-job are the same answer on purpose:
    // distinguishing them would confirm that an attachment id exists elsewhere.
    if (!photo) return refused(403, "There is no such photograph on this job.");

    return await serveStoredDocument({
      storageKey: photo.storageKey,
      reference: photo.caption?.trim() || `${photo.kind}-${photo.id}`,
    });
  } catch (error) {
    return documentErrorResponse(error, "job-photo");
  }
}
