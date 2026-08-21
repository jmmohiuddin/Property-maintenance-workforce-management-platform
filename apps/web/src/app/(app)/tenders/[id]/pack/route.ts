import { can, isStaff } from "@meridian/auth";
import { withTenant } from "@meridian/db";
import { TenderPackNotRenderableError } from "@meridian/core";
import { materialiseTenderPack } from "@meridian/docs";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * The tender pack, as a file (`CON-12`).
 *
 * The same shape as the invoice and quotation routes — see the comments there
 * for why a render here is not "render on demand", and why both the role and
 * the permission are checked rather than only the permission.
 *
 * ── WHY THIS ROUTE HANDLES ITS OWN REFUSAL ──────────────────────────────────
 *
 * `documentErrorResponse` in `lib/documents.ts` knows about
 * `InvoiceNotRenderableError` and `QuoteNotRenderableError` and returns their
 * reasons in full with a 409. It does not know about
 * `TenderPackNotRenderableError`, and if this route simply delegated, a refusal
 * would arrive as a generic 500 — "this has been logged" — which is precisely
 * the opposite of what the refusal is for. The list of what is missing or
 * expired *is* the feature.
 *
 * That is handled here rather than by extending `lib/documents.ts`, which is
 * shared with two other routes and belongs to nobody working on tenders. The
 * duplication is eight lines and the alternative is a change to a file other
 * work is editing.
 *
 * ── WHY IT IS NOT IDEMPOTENT IN THE WAY AN INVOICE IS ───────────────────────
 *
 * An invoice PDF is rendered once, ever. A tender pack is rendered once *per
 * business date*, because it is assembled from live data and the whole point is
 * that today's pack reflects today's register. Pressing the button twice in one
 * day returns the same bytes; pressing it again after a licence renewal
 * produces a new dated pack beside the one that was submitted.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download this document.");

  if (!isStaff(session.principal.role)) {
    return refused(403, "A tender pack is an internal artefact and is not served to the portal.");
  }
  if (!can(session.principal, "contracts:read")) {
    return refused(403, "Your role cannot read tenders.");
  }

  const { id } = await params;

  try {
    const pack = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) =>
        materialiseTenderPack(
          tx,
          {
            tenantId: session.principal.tenantId,
            userId: session.principal.userId,
            actorKind: "user",
          },
          id,
        ),
    );

    if (pack.warnings.length > 0) {
      // Logged as well as printed on the document. These are the gaps an
      // evaluator will read, and operations should know a pack went out with
      // them before the issuer asks about it.
      console.warn(
        `[tenders] ${pack.reference} pack assembled with gaps: ${pack.warnings.join(" ")}`,
      );
    }

    return await serveStoredDocument({
      storageKey: pack.storageKey,
      reference: `${pack.reference}-tender-pack`,
    });
  } catch (error) {
    if (error instanceof TenderPackNotRenderableError) {
      return new Response(
        `${error.message}\n\n${error.problems.map((p) => `  - ${p}`).join("\n")}\n`,
        { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } },
      );
    }
    return documentErrorResponse(error, "tender-pack");
  }
}
