import { can, isStaff } from "@meridian/auth";
import { withTenant, getProject } from "@meridian/db";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * The permit itself (`PRJ-6`, "documents attached").
 *
 * ── WHY A ROUTE, AND NOT THE KEY ON THE PAGE ────────────────────────────────
 *
 * `SEC-8` requires private storage with no public URLs, and `packages/files`
 * holds that by construction: its `ObjectStore` interface has no `url()`
 * method, so there is nothing for a template to embed. A storage key is not a
 * URL and must never reach the browser — it is an internal name whose only
 * protection is that nobody outside the server knows it, and a key rendered
 * into HTML is a key in every screenshot, bug report and browser history from
 * then on. The register links here instead, and this asks who is calling.
 *
 * The same serving path as invoices, quotations, tender packs, candidate
 * documents and job photographs — `serveStoredDocument`, which is where
 * `SEC-8`'s response rules live. Not a second one, because a second serving
 * path is a second place for `Content-Disposition: attachment` to be forgotten.
 *
 * ── WHY THE PROJECT ID IN THE PATH IS NOT THE AUTHORISATION ─────────────────
 *
 * The permit is looked up through the project named in the path, so a permit
 * filed against a different project simply is not in that list. Row-level
 * security scopes both to this tenant; the membership of one in the other does
 * the rest. Pairing somebody else's permit id with a project you can read gets
 * the same answer as an id that does not exist.
 *
 * Nothing here re-checks the virus scan, and that is deliberate rather than an
 * omission: `attachPermitDocument` refuses to write the key at all unless the
 * scan has passed, so a key on this row is one that already cleared it.
 */

// Node, not edge: the storage driver uses `node:fs`. Force-dynamic because the
// response is permission-gated per request and must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; permitId: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to open this permit.");

  // Both checks, not one. A `customer` role holds several read permissions so
  // that the portal works, and `withTenant` scopes to the tenant rather than to
  // a customer — so the permission alone would serve one client's Civil Defence
  // approval to another's portal login.
  if (!isStaff(session.principal.role)) {
    return refused(403, "Permit documents are not available outside the office.");
  }
  if (!can(session.principal, "projects:read")) {
    return refused(403, "Your role cannot read project records.");
  }

  const { id, permitId } = await params;

  try {
    const project = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) => getProject(tx, id),
    );

    const permit = project?.permits.find((p) => p.id === permitId);
    if (!permit) return refused(403, "There is no such permit on this project.");

    if (!permit.documentStorageKey) {
      return refused(
        403,
        "No document has been attached to this permit. An approval nobody can produce is an " +
          "approval that will be asked for again at the gate.",
      );
    }

    return await serveStoredDocument({
      storageKey: permit.documentStorageKey,
      // What the file is called when it lands in somebody's downloads folder.
      // The permit's own reference number where there is one, because that is
      // what an inspector asks for.
      reference: permit.referenceNumber?.trim() || `${permit.authorityCode}-${permit.permitType}`,
    });
  } catch (error) {
    return documentErrorResponse(error, "project-permit");
  }
}
