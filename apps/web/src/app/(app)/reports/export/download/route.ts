import { can, isStaff } from "@meridian/auth";
import { withTenant, accountingExport, isAccountingDataset } from "@meridian/db";
import { toCsv, UserFacingError } from "@meridian/core";
import { getSession } from "@/lib/session";
import { refused } from "@/lib/documents";

/**
 * The accounting export, as a file (`INV-16`).
 *
 * ── WHY BOTH PERMISSIONS ────────────────────────────────────────────────────
 *
 * `reports:read` alone is not enough. The HR role holds it — so that the hiring
 * figures on the dashboard work — and does not hold `invoices:read`, because
 * filling a vacancy and reading the customer ledger are different jobs. This
 * route hands over every invoice, every payment and every customer's TRN in one
 * file, so it is gated on the money permission as well as the reporting one.
 * The audience is the `accountant` and `owner` roles, which is exactly who this
 * requirement was written for.
 *
 * ── WHY THE WHOLE FILE IS BUILT BEFORE ANYTHING IS SENT ─────────────────────
 *
 * The obvious shape is a streamed response: hand the client rows as the
 * database produces them, and never hold the export in memory. It is the wrong
 * shape here, for a reason that has nothing to do with size. Every query runs
 * inside `withTenant`, which is a transaction that sets the tenant for row-level
 * security and ends when the callback returns — a body still streaming after
 * that is a body reading with no tenant context, and the export paginates
 * internally, so those reads are real. Building the file inside the transaction
 * keeps the whole export on one consistent snapshot and keeps every read
 * scoped. It also means a failure happens before a single byte is sent, which
 * is the difference between an error page and a half-written set of books.
 *
 * Truncation is defended in the domain layer instead: the export loops until
 * the database returns a short batch, it throws rather than returning a partial
 * set, and every file states its own row count on its last line.
 */

// Node rather than edge: `withTenant` uses the postgres driver. Force-dynamic
// because the response is permission-gated per request and must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return refused(401, "Sign in to download the accounting export.");

  if (!isStaff(session.principal.role)) {
    return refused(403, "The accounting export is not available from the customer portal.");
  }
  if (!can(session.principal, "reports:read") || !can(session.principal, "invoices:read")) {
    return refused(
      403,
      "The accounting export needs both reporting and invoice permissions. Ask the owner or the accountant.",
    );
  }

  const url = new URL(request.url);
  const dataset = url.searchParams.get("dataset") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";

  if (!isAccountingDataset(dataset)) {
    return refused(403, "Unknown export. Choose one from the accounting export page.");
  }

  try {
    const { csv, rowCount } = await withTenant(
      {
        tenantId: session.principal.tenantId,
        userId: session.principal.userId,
        actorKind: "user",
      },
      async (tx) => {
        const exported = await accountingExport(tx, { from, to });
        const table = exported.tables[dataset];
        return { csv: toCsv(table), rowCount: table.rowCount };
      },
    );

    return new Response(
      // A UTF-8 byte-order mark, deliberately — spelled as an escape rather
      // than pasted in, because an invisible character in a source file is one
      // somebody deletes without noticing they have changed anything.
      //
      // Excel on Windows is the program this file is opened in, and without a
      // BOM it decodes the bytes as the system code page — which turns every
      // Arabic customer name into mojibake, silently, in a file somebody is
      // about to reconcile. Modern importers strip the mark; the alternative
      // corrupts a name in every row of every export.
      `\uFEFF${csv}`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${dataset}-${from}-to-${to}.csv"`,
          // The row count in a header as well as in the file, so a proxy or a
          // script fetching this can tell a short file from a quiet month
          // without parsing it.
          "X-Export-Rows": String(rowCount),
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof UserFacingError) {
      return refused(403, error.message);
    }
    // Logged rather than shown: an export that failed halfway is the one thing
    // the reader must not be handed a partial version of.
    console.error("[accounting-export] failed", error);
    return new Response("The export could not be produced. Nothing was written.\n", {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
