import { isStaff } from "@meridian/auth";
import { withCustomerScope, getPortalInvoiceRef } from "@meridian/db";
import { materialiseInvoiceDocument } from "@meridian/docs";
import { getSession } from "@/lib/session";
import { documentErrorResponse, refused, serveStoredDocument } from "@/lib/documents";

/**
 * The customer's copy of a tax invoice (`POR-4`).
 *
 * ── THIS IS THE "DIFFERENT MECHANISM" THE STAFF ROUTE REFERS TO ────────────
 *
 * `(app)/invoices/[id]/document` refuses portal users outright, with the note
 * that the portal path "is a different concern with a different scoping
 * mechanism (`withCustomerScope`) and is not built here". This is it, and the
 * difference is one line: the transaction is opened with `withCustomerScope`
 * rather than `withTenant`.
 *
 * That single line is doing all of the work. Under `withTenant`, an authenticated
 * portal user could pass any invoice id in the tenant and get the PDF, because
 * the `customer` role holds the read permissions the portal needs and RLS scopes
 * to the tenant and not to the customer. Under `withCustomerScope`, Postgres
 * applies the RESTRICTIVE policy on `invoices`: another customer's invoice is
 * not refused, it is *absent*, so the lookup below returns null and the answer
 * is 404. There is no `WHERE customer_id = ?` in this file to forget.
 *
 * ── WHY IT MAY STILL RENDER ───────────────────────────────────────────────
 *
 * Same reasoning as the staff route, and the same guarantee: it renders only
 * when the row carries no key, then stores the bytes and writes the key and
 * hash, so a given invoice is rendered at most once in its life whoever asks
 * first. Refusing to serve pre-pipeline invoices would leave a customer looking
 * at an invoice they cannot get a copy of — which is the problem `POR-4` is
 * about, not a step towards fixing it.
 *
 * The render runs in the same customer-scoped transaction, so the write-back
 * cannot touch a row the policy hides either.
 *
 * ── STATUS CODES, NOT REDIRECTS ───────────────────────────────────────────
 *
 * As `lib/documents.ts` explains: a browser following a redirect from a
 * download link saves the login page as `SATS-INV-2026-0184.pdf`, and the
 * customer opens what looks like a corrupt invoice rather than seeing that they
 * were signed out.
 */

// Node, not edge: the renderer and the storage driver use `node:crypto` and
// `node:fs`. Force-dynamic because the response is scoped per request and must
// never be cached at the route level — a cached PDF is one customer's invoice
// served to the next caller.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download this invoice.");

  // Staff are sent to their own route rather than served here. Not because it
  // would leak anything — it would not; it would fail — but because a staff
  // session has no `customerId`, so `withCustomerScope` has nothing to scope
  // to and every lookup would return nothing. A clear refusal beats a 404 that
  // reads as a missing invoice.
  if (isStaff(session.principal.role)) {
    return refused(403, "Staff download invoices from the invoice screen, not the portal.");
  }

  const customerId = session.principal.customerId;
  // A customer-role membership with no customer_id is a misconfiguration, and
  // the one thing that must not happen is falling back to an unscoped read.
  if (!customerId) {
    return refused(403, "This portal account is not linked to a customer record.");
  }

  const { id } = await params;

  try {
    const document = await withCustomerScope(
      {
        tenantId: session.principal.tenantId,
        customerId,
        userId: session.principal.userId,
        actorKind: "customer",
      },
      async (tx) => {
        // Checked before rendering, for two separate reasons. Invisible means
        // it belongs to somebody else — that is the security boundary, and it
        // is enforced by the policy rather than by this call. Draft means it
        // exists and is not issued: a working document with no legal standing,
        // which the list also hides. A link that is merely not rendered is a
        // link somebody can still type.
        const ref = await getPortalInvoiceRef(tx, id);
        if (!ref) return null;

        return materialiseInvoiceDocument(tx, id);
      },
    );

    if (!document) {
      // 404 and not 403, and plain text for the reason `lib/documents.ts`
      // gives. Under customer scope the row is genuinely not there, and saying
      // "forbidden" would confirm that the id names an invoice on somebody
      // else's account.
      return new Response("That invoice is not on your account.\n", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (document.substitutedCharacters.length > 0) {
      // Logged, not shown. The customer cannot fix a font with no Arabic
      // glyphs, and this belongs in front of whoever picks up `INV-14`.
      console.warn(
        `[documents] ${document.reference} contains characters the document font cannot set ` +
          `(${document.substitutedCharacters.join(" ")}). They were replaced with "?".`,
      );
    }

    return await serveStoredDocument({
      storageKey: document.storageKey,
      reference: document.reference,
    });
  } catch (error) {
    return documentErrorResponse(error, "portal-invoice");
  }
}
