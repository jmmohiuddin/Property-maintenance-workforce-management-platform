import { can, isStaff } from "@meridian/auth";
import { withTenant, getProject } from "@meridian/db";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * One of the two photographs on a snag (`PRJ-7`): the defect, or the evidence
 * that closed it.
 *
 * Same argument as the permit route next door, and the same serving path. The
 * slot is in the URL rather than in a query string because it is part of the
 * identity of the thing being fetched — `.../photo/closure` is a different
 * document from `.../photo/photo`, not the same document fetched differently —
 * and because a path segment is what makes an unknown value a 404 rather than
 * a silent fall back to the wrong picture.
 *
 * A snag photograph shows the inside of a client's building, often before it
 * was fit to be seen. It is staff-only for the same reason a job photograph is.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; snagId: string; slot: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to open this photograph.");

  if (!isStaff(session.principal.role)) {
    return refused(403, "Snag photographs are not available outside the office.");
  }
  if (!can(session.principal, "projects:read")) {
    return refused(403, "Your role cannot read project records.");
  }

  const { id, snagId, slot } = await params;
  if (slot !== "photo" && slot !== "closure") {
    return refused(403, "A snag has two photographs: 'photo' and 'closure'.");
  }

  try {
    const project = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) => getProject(tx, id),
    );

    const snag = project?.snags.find((s) => s.id === snagId);
    // Not-found and not-on-this-project are the same answer on purpose.
    if (!snag) return refused(403, "There is no such snag on this project.");

    const key = slot === "closure" ? snag.closurePhotoStorageKey : snag.photoStorageKey;
    if (!key) {
      return refused(
        403,
        slot === "closure"
          ? "This snag has no closure evidence on file."
          : "This snag has no photograph on file.",
      );
    }

    return await serveStoredDocument({
      storageKey: key,
      reference: `snag-${snag.sequence}-${slot}`,
    });
  } catch (error) {
    return documentErrorResponse(error, "project-snag-photo");
  }
}
