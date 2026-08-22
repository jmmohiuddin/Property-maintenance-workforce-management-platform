import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@meridian/auth";
import { withTenant, accountingExport, ACCOUNTING_EXPORT_DATASETS } from "@meridian/db";
import { dubaiDateKey, formatMoney, tenant, LEDGER_ACCOUNTS } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = { title: "Accounting export" };
export const dynamic = "force-dynamic";

/**
 * The accounting export (`INV-16`, closing `MB-017`).
 *
 * ── "EXPORT, DON'T REPLACE" ─────────────────────────────────────────────────
 *
 * PRD §6.2 lists a full general ledger under what this product will never
 * build: *this system feeds an accountant; it does not replace one.* This page
 * is the feeding. It produces the four things the accountant asked for —
 * invoices, credit notes, payments, receivables — plus a double-entry journal
 * that imports into their ledger, and it stops there. There is no trial
 * balance, no P&L and no expense side, because this system is not the system of
 * record for any of them and a half-populated trial balance invites being
 * trusted as a complete one.
 *
 * ── WHY THE COUNTS ARE ON THE SCREEN BEFORE THE DOWNLOAD ────────────────────
 *
 * Silent truncation is the failure this whole feature is written against, and
 * its signature is a perfectly well-formed file that stops early. Nothing about
 * a tidy CSV says the two hundredth row was the last one the query was willing
 * to return. So the row count is computed the same way the file is, shown here,
 * written into the file's last line and returned in a response header. A short
 * file is then visibly short in three places instead of being discovered nine
 * months later by an accountant whose ledger is out by one invoice.
 */
export default async function AccountingExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("invoices:read");
  // Both permissions, the same pair the download route enforces. The HR role
  // holds `reports:read` without `invoices:read`; the manager role holds
  // neither of the money permissions. This file is the customer ledger.
  if (!can(session.principal, "reports:read")) {
    redirect("/denied?permission=reports:read");
  }

  const params = await searchParams;
  const today = dubaiDateKey(new Date());
  const defaultFrom = `${today.slice(0, 4)}-01-01`;

  const from = readDate(params["from"]) ?? defaultFrom;
  const to = readDate(params["to"]) ?? today;
  const backwards = from > to;

  const exported = backwards
    ? null
    : await withTenant(
        { tenantId: session.principal.tenantId, userId: session.principal.userId },
        (tx) => accountingExport(tx, { from, to }),
      );

  const href = (dataset: string) =>
    `/reports/export/download?dataset=${dataset}&from=${from}&to=${to}`;

  return (
    <AppShell session={session} active="dashboard">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Accounting export</h1>

        <p className="prose-body mt-2 max-w-2xl text-[14px]">
          Everything your accountant needs to post this period, as CSV. Amounts are in{" "}
          {exported?.currency ?? "AED"} and every money column says whether it is{" "}
          <strong>VAT-inclusive</strong> or <strong>VAT-exclusive</strong>. Dates are the local date
          in {tenant.timezone}. Drafts are never exported — a draft is not a document.
        </p>

        {/* GET, so a chosen range is a URL somebody can send to the accountant,
            the back button works, and the page stays a server component. */}
        <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            From
            <input
              type="date"
              name="from"
              defaultValue={from}
              className="rounded-sm border px-2 py-1.5 text-[13px]"
              style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--surface-raised)" }}
            />
          </label>
          <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            To
            <input
              type="date"
              name="to"
              defaultValue={to}
              className="rounded-sm border px-2 py-1.5 text-[13px]"
              style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--surface-raised)" }}
            />
          </label>
          <button
            type="submit"
            className="rounded-sm px-3 py-1.5 text-[13px] font-medium"
            style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
          >
            Update
          </button>
        </form>

        {backwards ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--status-critical-text)" }}>
            That range starts after it ends. Nothing was exported — an empty file from a backwards
            range is indistinguishable from a quiet quarter.
          </p>
        ) : null}

        {exported ? (
          <>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[44rem] border-collapse text-[13px]">
                <caption className="sr-only">The files in this export and their row counts</caption>
                <thead>
                  <tr style={{ color: "var(--text-secondary)" }}>
                    <th scope="col" className="pb-2 text-left text-[11px] font-semibold uppercase tracking-wide">
                      File
                    </th>
                    <th scope="col" className="pb-2 text-left text-[11px] font-semibold uppercase tracking-wide">
                      Covers
                    </th>
                    <th scope="col" className="pb-2 text-right text-[11px] font-semibold uppercase tracking-wide">
                      Rows
                    </th>
                    <th scope="col" className="pb-2 text-right text-[11px] font-semibold uppercase tracking-wide">
                      Download
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ACCOUNTING_EXPORT_DATASETS.map((dataset) => {
                    const table = exported.tables[dataset];
                    return (
                      <tr key={dataset} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                        <td className="py-2.5 font-medium">{table.name}.csv</td>
                        <td className="py-2.5" style={{ color: "var(--text-muted)" }}>
                          {table.title}
                        </td>
                        <td className="tnum py-2.5 text-right">{table.rowCount}</td>
                        <td className="py-2.5 text-right">
                          {table.rowCount === 0 ? (
                            <span style={{ color: "var(--text-muted)" }}>nothing in range</span>
                          ) : (
                            <a href={href(dataset)} style={{ color: "var(--accent-text)" }}>
                              Download &darr;
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* The one machine-checkable property of the whole export. An
                accounting package rejects an unbalanced journal outright, so it
                is checked here rather than discovered on import. */}
            <p
              className="mt-4 text-[13px]"
              style={{
                color: exported.journalBalance.balanced
                  ? "var(--status-success-text)"
                  : "var(--status-critical-text)",
              }}
            >
              {exported.journalBalance.balanced ? (
                <>
                  The journal balances:{" "}
                  {formatMoney(exported.journalBalance.debitMinor, exported.currency)} of debits
                  against the same in credits.
                </>
              ) : (
                <>
                  The journal does not balance —{" "}
                  {formatMoney(exported.journalBalance.debitMinor, exported.currency)} of debits
                  against {formatMoney(exported.journalBalance.creditMinor, exported.currency)} of
                  credits. Do not import it; report this.
                </>
              )}
            </p>
          </>
        ) : null}

        {/* ── What the accountant needs to be told ──────────────────────── */}
        <div className="mt-10 grid gap-6 lg:grid-cols-2">
          <section>
            <h2 className="text-[14px] font-semibold">Which file is which</h2>
            <ul className="prose-body mt-2 space-y-2 text-[13px]">
              <li>
                <strong>invoices, credit_notes, payments, receivables</strong> are listings — one row
                per document, every field it carries. These are what you check a figure against.
              </li>
              <li>
                <strong>journal</strong> is the import — one row per posting, account code and name,
                debit and credit in separate columns. That is the shape Xero, QuickBooks Online, Zoho
                Books and Tally all accept. A listing cannot be posted to a ledger and a journal
                cannot be reconciled against a document, which is why both are here.
              </li>
              <li>
                <strong>receivables</strong> is the position <em>today</em>, not as at the end of the
                range. Reconstructing a past AR balance would need write-off and credit history the
                system does not keep dated, and a wrong period-end balance is worse than a clearly
                labelled current one. The file&rsquo;s title carries the date.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-[14px] font-semibold">The account codes are placeholders</h2>
            <p className="prose-body mt-2 text-[13px]">
              This system has never seen your chart of accounts, so the journal is written against
              the conventional block layout below and the account <em>name</em> travels beside every
              code so you can remap by reading rather than guessing. Remapping on import is a step
              you already perform; inventing a mapping table here would be wrong the first time you
              renumbered anything.
            </p>
            <ul className="mt-3 space-y-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
              {Object.values(LEDGER_ACCOUNTS).map((account) => (
                <li key={account.code} className="tnum">
                  <strong>{account.code}</strong> &nbsp;{account.name}
                </li>
              ))}
            </ul>
            <p className="prose-body mt-3 text-[13px]">
              Receipts post to bank and receivables only. The output tax was accounted for when the
              invoice was issued, and posting it again on the receipt would double the VAT return.
            </p>
          </section>
        </div>

        <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
          <Link href="/reports/vat" style={{ color: "var(--accent-text)" }}>
            The VAT return pack, and its working papers &rarr;
          </Link>
          <Link href="/reports/tax" style={{ color: "var(--accent-text)" }}>
            Corporate tax and the Small Business Relief line &rarr;
          </Link>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * A date out of the query string, or nothing.
 *
 * Shape-checked here rather than trusted, so a pasted or edited URL produces
 * the default range instead of an error page — and so the value handed to the
 * domain layer is one it will accept. The domain function checks it again; a
 * caller's validation is not a substitute for the callee's.
 */
function readDate(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
