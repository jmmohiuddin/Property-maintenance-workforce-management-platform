import { absoluteUrl } from "@meridian/core";
import { can, isStaff } from "@meridian/auth";
import { withTenant } from "@meridian/db";
import { materialiseQuoteDocument } from "@meridian/docs";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * The quotation, as a file (`QTE-3`).
 *
 * The same shape as the invoice route and for the same reasons — see the
 * comments there for why a render here is not "render on demand", and why
 * both the role and the permission are checked.
 *
 * ── WHY A QUOTE IS STORED AT ALL ────────────────────────────────────────────
 *
 * A quotation is not a tax document and carries no statutory retention. It is
 * stored anyway because of what happens next: the customer accepts it in the
 * portal (`POR-8`), and from that moment the document is the record of what
 * they agreed to. Re-rendering it later from live configuration would quietly
 * restate the offer in the present tense — a price list that has moved, a
 * licence number that has been renewed — and the version the customer accepted
 * would no longer exist anywhere.
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
    return refused(403, "This quotation is read in the customer portal, not from here.");
  }
  if (!can(session.principal, "quotes:read")) {
    return refused(403, "Your role cannot read quotations.");
  }

  const { id } = await params;

  try {
    const document = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) =>
        materialiseQuoteDocument(tx, id, {
          // The link is printed on the document, so it has to be absolute — a
          // customer reading a PDF has no origin to resolve `/portal` against.
          acceptUrl: absoluteUrl(`/portal/quotes/${id}`),
        }),
    );

    if (document.substitutedCharacters.length > 0) {
      console.warn(
        `[documents] ${document.reference} contains characters the document font cannot set ` +
          `(${document.substitutedCharacters.join(" ")}). They were replaced with "?". ` +
          `An embedded font is INV-14.`,
      );
    }

    return await serveStoredDocument({
      storageKey: document.storageKey,
      reference: document.reference,
    });
  } catch (error) {
    return documentErrorResponse(error, "quote");
  }
}
