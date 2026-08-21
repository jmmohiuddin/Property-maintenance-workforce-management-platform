import type { Metadata } from "next";
import { withCustomerScope, listPortalInvoices, portalStatement, INVOICE_STATUS_LABEL } from "@meridian/db";
import { formatMoney } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { DownloadSimple, Receipt, Warning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

/**
 * Invoices and the statement of account (`POR-4`).
 *
 * The requirement's justification is the whole design brief: *stops finance
 * emailing PDFs*. So the download is on every row, the balance is the first
 * number on the page, and the statement below is the thing an accounts
 * department actually asks for when they call — invoices, credit notes and
 * payments in one ledger, with a balance that reconciles.
 *
 * Drafts are absent, and that is enforced in `listPortalInvoices` rather than
 * filtered here: a draft invoice is a working document with no legal existence,
 * and publishing one commits the business to a number it has not agreed.
 */
export default async function PortalInvoicesPage() {
  const session = await requirePortalSession();

  const { invoices, statement } = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    async (tx) => ({
      invoices: await listPortalInvoices(tx, { limit: 100 }),
      statement: await portalStatement(tx),
    }),
  );

  // Summed from the invoice rows rather than taken from the statement, because
  // each row already knows its own outstanding amount net of its own credit
  // notes and payments. Deriving one overdue figure from the statement's three
  // account-wide totals would be an approximation, and an approximate overdue
  // number is the one figure on this page somebody pays against.
  const overdueMinor = invoices
    .filter((i) => i.daysOverdue !== null)
    .reduce((sum, i) => sum + i.outstandingMinor, 0);

  return (
    <PortalShell session={session} active="invoices">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Invoices</h1>
        <p className="prose-body mt-2 text-[14px]">
          Every invoice raised on your account, with its PDF and your statement.
        </p>

        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-3"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            {
              label: "Balance",
              value: formatMoney(statement.balanceMinor, statement.currency),
              tone: statement.balanceMinor > 0,
            },
            {
              label: "Overdue",
              value: formatMoney(overdueMinor, statement.currency),
              tone: overdueMinor > 0,
            },
            {
              label: "Paid to date",
              value: formatMoney(statement.paidMinor, statement.currency),
              tone: false,
            },
          ].map((s) => (
            <div key={s.label} className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {s.label}
              </dt>
              <dd
                className="tnum mt-1 text-2xl font-semibold"
                style={s.tone ? { color: "var(--accent-text)" } : undefined}
              >
                {s.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* ── Invoices ─────────────────────────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Receipt size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Invoices
          </h2>

          {invoices.length === 0 ? (
            <p className="prose-body mt-3 text-[14px]">No invoices have been raised yet.</p>
          ) : (
            <ul
              className="mt-4 divide-y rounded border"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 p-5">
                  <div className="min-w-0">
                    <p className="tnum text-[15px] font-medium">{i.reference}</p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {INVOICE_STATUS_LABEL[i.status]}
                      {i.issuedOn
                        ? ` · issued ${i.issuedOn.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })}`
                        : ""}
                      {i.dueOn
                        ? ` · due ${i.dueOn.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })}`
                        : ""}
                      {i.jobReference ? ` · ${i.jobReference}` : ""}
                    </p>
                    {i.daysOverdue !== null ? (
                      <p
                        className="mt-1.5 inline-flex items-center gap-1.5 text-[13px] font-medium"
                        style={{ color: "var(--danger, #b42318)" }}
                      >
                        <Warning size={14} weight="fill" aria-hidden />
                        {i.daysOverdue} day{i.daysOverdue === 1 ? "" : "s"} overdue
                      </p>
                    ) : null}
                    {i.creditedMinor > 0 ? (
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {formatMoney(i.creditedMinor, i.currency)} credited
                      </p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="tnum text-[15px] font-semibold">
                      {formatMoney(i.totalMinor, i.currency)}
                    </p>
                    {i.outstandingMinor > 0 && i.outstandingMinor !== i.totalMinor ? (
                      <p className="tnum mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {formatMoney(i.outstandingMinor, i.currency)} outstanding
                      </p>
                    ) : null}
                    {/*
                      A plain anchor, not a Link: this navigates to a route
                      handler that returns a file with Content-Disposition,
                      which the client router cannot handle. `download` is
                      advisory — the header is what decides.

                      Rendered only when the artefact exists. An invoice raised
                      before the document pipeline existed has no stored PDF, and
                      a link that returns a 409 explaining that to a customer is
                      worse than no link: they cannot act on it either way.
                    */}
                    {i.hasDocument ? (
                      <a
                        href={`/portal/invoices/${i.id}/document`}
                        className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium"
                        style={{ color: "var(--accent-text)" }}
                      >
                        <DownloadSimple size={15} aria-hidden />
                        PDF
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Statement of account ─────────────────────────────────────── */}
        {statement.entries.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Statement of account</h2>
            <p className="prose-body mt-2 text-[14px]">
              Everything that has moved your balance, oldest first.
              {statement.truncated
                ? " Only the earliest entries are listed; the totals above cover the whole account."
                : ""}
            </p>

            {/* Its own horizontal scroller. A four-column table on a 375px
                phone must scroll inside this box and never make the page
                scroll sideways. */}
            <div className="mt-4 overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              <table className="w-full min-w-[34rem] text-[14px]">
                <thead>
                  <tr style={{ color: "var(--text-secondary)" }}>
                    <th scope="col" className="p-3 text-left text-[13px] font-medium">Date</th>
                    <th scope="col" className="p-3 text-left text-[13px] font-medium">Document</th>
                    <th scope="col" className="p-3 text-right text-[13px] font-medium">Amount</th>
                    <th scope="col" className="p-3 text-right text-[13px] font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {runningBalance(statement.entries).map((row) => (
                    <tr key={`${row.entry.kind}-${row.entry.reference}-${row.entry.occurredAt.getTime()}`} className="border-t">
                      <td className="tnum p-3 whitespace-nowrap">
                        {row.entry.occurredAt.toLocaleDateString("en-GB", {
                          timeZone: "Asia/Dubai",
                          dateStyle: "medium",
                        })}
                      </td>
                      <td className="p-3">
                        <span className="tnum">{row.entry.reference}</span>
                        <span className="ml-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                          {KIND_LABEL[row.entry.kind]}
                          {row.entry.detail ? ` · ${row.entry.detail.replace(/_/g, " ")}` : ""}
                        </span>
                      </td>
                      <td className="tnum p-3 text-right">
                        {row.entry.amountMinor < 0 ? "−" : ""}
                        {formatMoney(Math.abs(row.entry.amountMinor), statement.currency)}
                      </td>
                      <td className="tnum p-3 text-right font-medium">
                        {formatMoney(row.balanceMinor, statement.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </div>
    </PortalShell>
  );
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  invoice: "Invoice",
  credit_note: "Credit note",
  payment: "Payment",
};

/**
 * Add the running balance to each row.
 *
 * Done here rather than in SQL because it is a presentation of the same
 * entries the domain already returned, and computing it in the query would mean
 * a window function whose result the footer would then have to agree with. One
 * pass over one array cannot disagree with itself.
 */
function runningBalance<T extends { amountMinor: number }>(
  entries: readonly T[],
): { entry: T; balanceMinor: number }[] {
  let balance = 0;
  return entries.map((entry) => {
    balance += entry.amountMinor;
    return { entry, balanceMinor: balance };
  });
}
