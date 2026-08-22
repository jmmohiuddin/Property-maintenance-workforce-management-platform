import { can, isStaff } from "@meridian/auth";
import { withTenant, vatWorkingPapers } from "@meridian/db";
import { toCsv, UserFacingError } from "@meridian/core";
import { getSession } from "@/lib/session";
import { refused } from "@/lib/documents";

/**
 * The VAT working papers, as a file (`INV-11`).
 *
 * ── WHY THE WORKING PAPERS ARE A SEPARATE DOWNLOAD ──────────────────────────
 *
 * The pack on screen is what gets transcribed onto the form. This is what
 * defends it. An FTA assessment arrives eighteen months after the filing and
 * asks how a figure was arrived at, and the only useful answer is the list of
 * documents behind it with the arithmetic shown. So the file carries, per
 * document, the recorded tax AND the tax recomputed from that document's own
 * taxable amount and rate, with the difference between them — which means the
 * reconciliation on the screen can be rebuilt from the file alone, by somebody
 * who never had access to this system.
 *
 * ── WHY BOTH PERMISSIONS ────────────────────────────────────────────────────
 *
 * The same pair as the accounting export, and the same reasoning: this file
 * hands over every invoice, every credit note and every customer TRN for the
 * period. `hr` holds `reports:read` and not `invoices:read`; the operations
 * manager holds neither. The audience is `accountant`, `owner` and `admin`.
 *
 * ── WHY THE FILE IS BUILT BEFORE ANYTHING IS SENT ───────────────────────────
 *
 * Identical to the accounting export's reasoning, and it is not stylistic.
 * `withTenant` is a transaction that sets the tenant for row-level security and
 * ends when the callback returns; the working papers paginate internally, so a
 * body still streaming after that would be reading with no tenant context.
 * Building it inside the transaction keeps every read scoped and on one
 * snapshot, and means a failure happens before a byte is sent.
 */

// Node rather than edge: `withTenant` uses the postgres driver. Force-dynamic
// because the response is permission-gated per request and must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download the VAT working papers.");

  if (!isStaff(session.principal.role)) {
    return refused(403, "The VAT working papers are not available from the customer portal.");
  }
  if (!can(session.principal, "reports:read") || !can(session.principal, "invoices:read")) {
    return refused(
      403,
      "The VAT working papers need both reporting and invoice permissions. Ask the owner or the accountant.",
    );
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";

  try {
    const { csv, rowCount } = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      async (tx) => {
        const table = await vatWorkingPapers(tx, { from, to });
        return { csv: toCsv(table), rowCount: table.rowCount };
      },
    );

    return new Response(
      // A UTF-8 byte-order mark, spelled as an escape rather than pasted in —
      // an invisible character in a source file is one somebody deletes without
      // noticing they have changed anything. Excel on Windows decodes
      // a mark-less file as the system code page, which turns an Arabic customer
      // name into mojibake in a file somebody is about to reconcile.
      `\uFEFF${csv}`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="vat-working-papers-${from}-to-${to}.csv"`,
          // The row count in a header as well as in the file, so a script
          // fetching this can tell a short file from a quiet quarter.
          "X-Export-Rows": String(rowCount),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof UserFacingError) {
      return refused(403, error.message);
    }
    // Logged rather than shown. Working papers that failed halfway are the one
    // thing the reader must not be handed a partial version of.
    console.error("[vat-working-papers] failed", error);
    return new Response("The working papers could not be produced. Nothing was written.\n", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
