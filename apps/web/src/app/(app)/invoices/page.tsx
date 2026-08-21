import type { Metadata } from "next";
import Link from "next/link";
import {
  withTenant,
  listInvoices,
  arAgeing,
  uninvoicedSignedOffJobs,
  INVOICE_STATUS_LABEL,
} from "@meridian/db";
import { formatMoney, toMinor, ISSUANCE_ALERT_DAYS, LATE_ISSUANCE_PENALTY } from "@meridian/core";
import { Warning } from "@phosphor-icons/react/dist/ssr";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const session = await requireSessionWith("invoices:read");
  const now = new Date();

  const { invoices, ageing, awaitingInvoice } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      invoices: await listInvoices(tx, { now }),
      ageing: await arAgeing(tx, now),
      awaitingInvoice: await uninvoicedSignedOffJobs(tx),
    }),
  );

  // INV-5. Signed-off work has 14 days before the AED 2,500 applies, and the
  // alert fires at day 10 — four days of margin, because raising an invoice
  // needs a person and that person takes leave. The banner leads the page
  // because it is the only thing here with a statutory deadline on it.
  const overdueToInvoice = awaitingInvoice.filter((j) => j.daysSinceSupply >= ISSUANCE_ALERT_DAYS);
  const oldest = overdueToInvoice[0];

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
            <div>
              <p className="text-[14px] font-medium">
                {overdueToInvoice.length} signed-off job
                {overdueToInvoice.length === 1 ? " has" : "s have"} not been invoiced — the oldest is{" "}
                {oldest.daysSinceSupply} days past supply
              </p>
              <p className="mt-1 text-[13px]">
                {LATE_ISSUANCE_PENALTY} {oldest.jobReference} ({oldest.customerName}) must be
                invoiced by {oldest.deadline}.
              </p>
              <ul className="mt-2 space-y-0.5 text-[13px]">
                {overdueToInvoice.slice(0, 5).map((j) => (
                  <li key={j.jobId}>
                    <Link href={`/jobs/${j.jobId}`} className="tnum hover:underline">
                      {j.jobReference}
                    </Link>{" "}
                    — {j.customerName}, day {j.daysSinceSupply} of 14
                  </li>
                ))}
              </ul>
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
            <h2 className="text-lg font-semibold">No invoices yet</h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              Invoices are raised from a job once the customer has signed off the work.
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
      </div>
    </AppShell>
  );
}
