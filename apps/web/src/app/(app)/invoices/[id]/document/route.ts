import { can, isStaff } from "@meridian/auth";
import { withTenant } from "@meridian/db";
import { materialiseInvoiceDocument } from "@meridian/docs";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * The tax invoice, as a file (`INV-3`, `INV-6`).
 *
 * ── WHY THIS MAY RENDER, AND WHY THAT IS NOT "RENDER ON DEMAND" ─────────────
 *
 * TRD §7.6 is explicit that a financial document is never re-rendered on
 * demand, because the artefact has to be stable even if a template changes.
 * This route honours that and is still allowed to produce one: it renders only
 * when the row carries **no** key, stores the bytes, writes the key and hash,
 * and every request after that serves the stored file. So a given invoice is
 * rendered at most once in its life, whoever asks first.
 *
 * That matters because invoices exist that were raised before any of this code
 * did. The alternative — refusing to serve them until somebody runs a backfill
 * — would leave an accountant looking at an invoice they cannot produce a copy
 * of, which is the problem, not a step towards fixing it.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 *
 * Staff only, holding `invoices:read`. The customer-portal path to the same
 * artefact is a different concern with a different scoping mechanism
 * (`withCustomerScope`) and is not built here.
 */

// Node, not edge: the renderer and the local storage driver use `node:crypto`
// and `node:fs`. Force-dynamic because the response is permission-gated per
// request and must never be cached at the route level.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download this document.");

  // Both checks, not one. A `customer` role holds `jobs:read` so that the
  // portal works; every query below runs through `withTenant`, which scopes to
  // the tenant and NOT to a customer, so a portal user reaching this route
  // would be able to fetch any customer's invoice. Permission alone is not the
  // boundary here — the role has to be checked too.
  if (!isStaff(session.principal.role)) {
    return refused(403, "This document is downloaded from the customer portal, not from here.");
  }
  if (!can(session.principal, "invoices:read")) {
    return refused(403, "Your role cannot read invoices.");
  }

  const { id } = await params;

  try {
    const document = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      (tx) => materialiseInvoiceDocument(tx, id),
    );

    // Logged rather than shown, because the person downloading an invoice
    // cannot fix a font that has no Arabic glyphs. It belongs in front of
    // whoever picks up `INV-14`.
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
    return documentErrorResponse(error, "invoice");
  }
}
