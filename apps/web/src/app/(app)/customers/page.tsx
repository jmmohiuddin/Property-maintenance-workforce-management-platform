import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listCustomers } from "@meridian/db";
import { formatMoney } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Buildings, Warning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

export default async function CustomersPage() {
  const session = await requireSessionWith("customers:read");

  const customers = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listCustomers(tx),
  );

  const outstandingMinor = customers.reduce((sum, c) => sum + c.outstandingMinor, 0);
  const overdueMinor = customers.reduce((sum, c) => sum + c.overdueMinor, 0);
  const withOverdue = customers.filter((c) => c.overdueMinor > 0);

  return (
    <AppShell session={session} active="customers">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Customers</h1>
        <p className="prose-body mt-2 text-[14px]">
          Work in flight and money outstanding on the same row, because together they are what
          decides whether the next job gets scheduled or held.
        </p>

        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-3"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            { label: "Active accounts", value: String(customers.length), tone: false },
            { label: "Outstanding", value: formatMoney(outstandingMinor), tone: false },
            { label: "Overdue", value: formatMoney(overdueMinor), tone: overdueMinor > 0 },
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

        {withOverdue.length > 0 ? (
          <p
            className="mt-6 flex items-start gap-3 rounded p-4 text-[14px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
          >
            <Warning
              size={17}
              weight="fill"
              aria-hidden
              className="mt-0.5 shrink-0"
              style={{ color: "var(--accent-text)" }}
            />
            <span>
              {withOverdue.length} {withOverdue.length === 1 ? "account is" : "accounts are"} past
              due:{" "}
              {withOverdue
                .map((c) => `${c.name} (${formatMoney(c.overdueMinor, c.currency)})`)
                .join(" · ")}
            </span>
          </p>
        ) : null}

        {customers.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">No customers yet</h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              Converting a lead creates the customer, the property and the first job together.
            </p>
            <Link href="/leads" className="btn btn-secondary mt-5">
              Go to leads
            </Link>
          </div>
        ) : (
          <ul
            className="mt-8 divide-y rounded border"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            {customers.map((c) => (
              <li key={c.id}>
                <Link href={`/customers/${c.id}`} className="block p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <h2 className="text-[16px] font-semibold">{c.name}</h2>
                      <span className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {c.code}
                      </span>
                      {c.industry ? (
                        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                          {c.industry}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-baseline gap-4 text-[13px]">
                      {c.outstandingMinor > 0 ? (
                        <span
                          className="tnum font-semibold"
                          style={{
                            color: c.overdueMinor > 0 ? "var(--accent-text)" : "var(--text-primary)",
                          }}
                        >
                          {formatMoney(c.outstandingMinor, c.currency)} outstanding
                          {c.overdueMinor > 0
                            ? ` · ${formatMoney(c.overdueMinor, c.currency)} overdue`
                            : ""}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>Nothing outstanding</span>
                      )}
                    </div>
                  </div>

                  <p
                    className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Buildings size={14} aria-hidden style={{ color: "var(--text-muted)" }} />
                      {c.propertyCount} {c.propertyCount === 1 ? "property" : "properties"}
                    </span>
                    <span>
                      {c.openJobs} open {c.openJobs === 1 ? "job" : "jobs"}
                    </span>
                    <span>{c.paymentTermsDays}-day terms</span>
                    {c.accountManagerName ? <span>{c.accountManagerName}</span> : null}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}
