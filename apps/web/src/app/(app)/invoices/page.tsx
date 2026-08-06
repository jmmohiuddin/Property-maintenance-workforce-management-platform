import type { Metadata } from "next";
import { withTenant, listInvoices, arAgeing, INVOICE_STATUS_LABEL } from "@meridian/db";
import { formatMoney, toMinor } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = { title: "Invoices" };
export const dynamic = "force-dynamic";

export default async function InvoicesPage() {
  const session = await requireSessionWith("invoices:read");
  const now = new Date();

  const { invoices, ageing } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      invoices: await listInvoices(tx, { now }),
      ageing: await arAgeing(tx, now),
    }),
  );

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
                      <td className="tnum px-4 py-3 text-[13px]">{i.reference}</td>
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
