import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  searchInvoices,
  arAgeing,
  uninvoicedSignedOffJobs,
  INVOICE_STATUS_LABEL,
} from "@meridian/db";
import {
  formatMoney,
  toMinor,
  ISSUANCE_ALERT_DAYS,
  ISSUANCE_WINDOW_DAYS,
  LATE_ISSUANCE_PENALTY,
} from "@meridian/core";
import { MagnifyingGlass, Warning } from "@phosphor-icons/react/dist/ssr";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

/**
 * `LEAD-8`. Search and paging state live in the query string, the same way the
 * lead and customer lists do — so a filtered list is a URL somebody can send to
 * a colleague, the back button works, and the page stays a server component
 * running one indexed query.
 */
export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("invoices:read");
  const now = new Date();

  const params = await searchParams;
  const q = typeof params["q"] === "string" ? params["q"].trim() : "";
  const cursor = typeof params["after"] === "string" ? params["after"] : undefined;

  const { page, ageing, awaitingInvoice } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      page: await searchInvoices(tx, { q: q || undefined, cursor, limit: 25, now }),
      // Its own aggregate over every open invoice, deliberately not a sum of
      // the page above. The tiles have to keep saying what the business is owed
      // no matter which page of the table is on screen.
      ageing: await arAgeing(tx, now),
      awaitingInvoice: await uninvoicedSignedOffJobs(tx),
    }),
  );

  const invoices = page.rows;

  /** Preserve the search term when building a "next page" link. */
  const pageHref = (after: string | null) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (after) next.set("after", after);
    const query = next.toString();
    return query ? `/invoices?${query}` : "/invoices";
  };

  // INV-5, wireframes §7.2. Signed-off work has 14 days before the AED 2,500
  // applies, and the alert fires at day 10 — four days of margin, because
  // raising an invoice needs a person and that person takes leave.
  //
  // The banner leads the page, above AR ageing, because consequence order puts
  // money at risk first: an unpaid invoice is money that is late, an un-issued
  // one is money plus a penalty. Ordered oldest-first, which is the order the
  // query returns and also the order they must be dealt with.
  const overdueToInvoice = awaitingInvoice.filter((j) => j.daysSinceSupply >= ISSUANCE_ALERT_DAYS);
  const breached = overdueToInvoice.filter((j) => j.state === "breached");
  const oldest = overdueToInvoice[0];

  // The clock is computed on plain calendar dates in Dubai, so the deadline
  // arrives as an ISO string rather than a Date. Rendered the way every other
  // date on this page is, because "2026-08-31" in a sentence reads as a serial
  // number and a reader has to stop and parse it.
  const deadlineDate = (iso: string): string =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
      timeZone: "UTC",
      dateStyle: "medium",
    });

  const buckets = [
    { label: "Current", value: ageing.currentMinor, tone: false },
    { label: "1–30 days", value: ageing.days1to30Minor, tone: false },
    { label: "31–60 days", value: ageing.days31to60Minor, tone: ageing.days31to60Minor > 0 },
    { label: "61+ days", value: ageing.days61PlusMinor, tone: ageing.days61PlusMinor > 0 },
  ];

  return (
    <AppShell session={session} active="invoices">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Invoices</h1>
        <p className="prose-body mt-2 text-[14px]">
          Receivables aged from each invoice&apos;s due date, computed live rather than from a status
          column that drifts when a nightly job stops running.
        </p>

        {/* GET, not a server action, and not a filter over a fetched array.
            The term goes to the database, which is the only place that can see
            past the first page. */}
        <form method="get" action="/invoices" className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[16rem] flex-1">
            <MagnifyingGlass
              size={16}
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2"
              style={{ color: "var(--text-muted)" }}
            />
            <input
              type="search"
              name="q"
              defaultValue={q}
              placeholder="Invoice reference or customer"
              aria-label="Search invoices"
              className="w-full rounded-sm border py-2 pl-9 pr-3 text-[14px] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <button type="submit" className="btn btn-secondary !py-2 text-[14px]">
            Search
          </button>
          {q ? (
            <Link href="/invoices" className="text-[13px] underline" style={{ color: "var(--text-muted)" }}>
              Clear
            </Link>
          ) : null}
        </form>

        {oldest ? (
          <div
            role="alert"
            className="mt-6 flex items-start gap-3 rounded border p-4"
            style={{
              backgroundColor: "var(--status-critical-wash)",
              borderColor: "var(--status-critical)",
              color: "var(--status-critical-text)",
            }}
          >
            <Warning size={16} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide">Action needed</p>
              <p className="mt-1 text-[14px] font-medium">
                {overdueToInvoice.length} signed-off job
                {overdueToInvoice.length === 1 ? " has" : "s have"} not been invoiced — the oldest is
                day {oldest.daysSinceSupply} of {ISSUANCE_WINDOW_DAYS}
                {breached.length > 0
                  ? `, and ${breached.length} ${breached.length === 1 ? "is" : "are"} already past the limit`
                  : ""}
              </p>
              {/* The rule and the number, in that order and in one sentence.
                  A compliance banner that says "action needed" without naming
                  the statute or the amount is asking for a favour. */}
              <p className="mt-1 text-[13px]">{LATE_ISSUANCE_PENALTY}</p>
              <ul className="mt-2 space-y-0.5 text-[13px]">
                {overdueToInvoice.slice(0, 5).map((j) => (
                  <li key={j.jobId}>
                    <Link href={`/jobs/${j.jobId}`} className="tnum font-medium hover:underline">
                      {j.jobReference}
                    </Link>{" "}
                    — {j.customerName} · day {j.daysSinceSupply} of {ISSUANCE_WINDOW_DAYS} ·{" "}
                    {j.state === "breached"
                      ? `deadline was ${deadlineDate(j.deadline)}`
                      : `invoice by ${deadlineDate(j.deadline)}`}
                  </li>
                ))}
              </ul>
              {overdueToInvoice.length > 5 ? (
                <p className="mt-1 text-[13px]">
                  … and {overdueToInvoice.length - 5} more.
                </p>
              ) : null}
              {/* Deliberately the oldest job rather than a "raise invoices"
                  bulk action. There is no bulk flow, and a button that opens a
                  list the reader is already looking at is a button that teaches
                  them the banner does nothing. */}
              <p className="mt-3 text-[13px]">
                <Link href={`/jobs/${oldest.jobId}`} className="font-medium underline">
                  Raise the invoice for {oldest.jobReference} →
                </Link>
              </p>
            </div>
          </div>
        ) : null}

        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-2 lg:grid-cols-4"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {buckets.map((b) => (
            <div key={b.label} className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {b.label}
              </dt>
              <dd
                className="tnum mt-1 text-xl font-semibold"
                style={b.tone ? { color: "var(--accent-text)" } : undefined}
              >
                {formatMoney(b.value)}
              </dd>
            </div>
          ))}
        </dl>

        <p className="tnum mt-4 text-[14px]" style={{ color: "var(--text-secondary)" }}>
          Total outstanding: <strong>{formatMoney(ageing.totalOutstandingMinor)}</strong>
        </p>

        {invoices.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">
              {q ? "Nothing matched" : cursor ? "No more invoices" : "No invoices yet"}
            </h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              {q
                ? "No invoice has that reference, and no customer has that name."
                : cursor
                  ? "This is the end of the list. A cursor from an old link can also land here."
                  : "Invoices are raised from a job once the customer has signed off the work."}
            </p>
          </div>
        ) : (
          <div className="mt-8 overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            <table className="w-full min-w-[52rem] border-collapse text-left">
              <thead>
                <tr className="border-b text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  <th scope="col" className="px-4 py-3 font-medium">Reference</th>
                  <th scope="col" className="px-4 py-3 font-medium">Customer</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                  <th scope="col" className="px-4 py-3 font-medium">Due</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Total</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => {
                  const outstanding = toMinor(i.total) - toMinor(i.amountPaid);
                  const overdue = i.daysUntilDue !== null && i.daysUntilDue < 0 && outstanding > 0;
                  return (
                    <tr key={i.id} className="border-b last:border-0">
                      <td className="tnum px-4 py-3 text-[13px]">
                        <Link href={`/invoices/${i.id}`} className="hover:underline">
                          {i.reference}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-[14px]">{i.customerName}</td>
                      <td className="px-4 py-3 text-[13px]">{INVOICE_STATUS_LABEL[i.status]}</td>
                      <td className="px-4 py-3 text-[13px]">
                        {i.dueOn
                          ? i.dueOn.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })
                          : "—"}
                        {overdue ? (
                          <span className="ml-2 font-medium" style={{ color: "var(--accent-text)" }}>
                            {Math.abs(i.daysUntilDue!)}d late
                          </span>
                        ) : null}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-[14px]">
                        {formatMoney(toMinor(i.total), i.currency)}
                      </td>
                      <td className="tnum px-4 py-3 text-right text-[14px] font-medium">
                        {outstanding > 0 ? formatMoney(outstanding, i.currency) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {page.nextCursor ? (
          <div className="mt-6">
            {/* Keyset, so this is "everything after the last row on this page"
                rather than "skip 25". An invoice raised while somebody pages
                cannot push a row past the boundary and out of sight — which is
                what the old flat limit of 200 did to every invoice behind it. */}
            <Link href={pageHref(page.nextCursor)} className="btn btn-secondary">
              Show older invoices
            </Link>
          </div>
        ) : null}

        {cursor ? (
          <p className="mt-4 text-[13px]">
            <Link href={pageHref(null)} className="underline" style={{ color: "var(--text-muted)" }}>
              Back to the newest
            </Link>
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}
