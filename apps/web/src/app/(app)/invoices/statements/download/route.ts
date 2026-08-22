import { can, isStaff } from "@meridian/auth";
import { withTenant, customerStatement } from "@meridian/db";
import { UserFacingError } from "@meridian/core";
import { renderStatement } from "@meridian/docs";
import { getSession } from "@/lib/session";
import { refused, documentErrorResponse } from "@/lib/documents";

/**
 * The statement of account, as a PDF to attach to an email (`INV-13`).
 *
 * ── WHY THIS IS RENDERED AND NOT STORED ─────────────────────────────────────
 *
 * Every other financial PDF in this system is materialised once and kept, and
 * `packages/docs/src/issue.ts` explains why: an invoice is a legal artefact and
 * its bytes must not change after it has been sent. A statement is the opposite
 * kind of object. It has no sequential number, it creates no liability, it is a
 * report ABOUT documents, and reissuing it next week with a later closing date
 * is the normal thing to do rather than a correction. Storing one would put a
 * stale balance in object storage under a name that looks authoritative, and
 * somebody would send it.
 *
 * The render is deterministic all the same: the same account and the same
 * closing date produce byte-identical output, so a customer holding last
 * month's copy can be given the same file again.
 *
 * ── PERMISSION ──────────────────────────────────────────────────────────────
 *
 * `invoices:read`, plus the staff check. This is one customer's ledger — what
 * they were charged, what they paid, what was written off — so it sits with the
 * money permission rather than with `customers:read`, which dispatch and sales
 * both hold. A portal session is refused outright: the customer's own statement
 * is `/portal`, which is scoped by customer-scope RLS rather than by an argument
 * in a query string.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download a statement of account.");

  if (!isStaff(session.principal.role)) {
    // Deliberately not "use the portal instead of this URL". A portal user must
    // not learn that a statement exists for an account id they guessed.
    return refused(403, "Your own account is on the portal home page.");
  }
  if (!can(session.principal, "invoices:read")) {
    return refused(
      403,
      "A statement of account needs invoice permission. Ask the owner or the accountant.",
    );
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("customer") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const fromParam = url.searchParams.get("from");
  const from = fromParam && fromParam !== "" ? fromParam : null;

  if (!/^[0-9a-fA-F-]{36}$/.test(customerId)) {
    return refused(403, "Choose an account on the statement page.");
  }

  try {
    const document = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      async (tx) => {
        const statement = await customerStatement(tx, { customerId, from, to });
        return renderStatement(statement);
      },
    );

    return new Response(new Uint8Array(document.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${document.filename.replace(/[^A-Za-z0-9._-]+/g, "-")}"`,
        // The hash of what was sent, so a copy in somebody's inbox can be
        // matched against a copy produced later. Not stored on any row — a
        // statement is not evidential the way an invoice is.
        "X-Document-Sha256": document.sha256,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof UserFacingError) {
      return refused(403, error.message);
    }
    return documentErrorResponse(error, "statement");
  }
}
