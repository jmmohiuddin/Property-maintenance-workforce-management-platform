import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, searchCustomers, customerPortfolioTotals } from "@meridian/db";
import { formatMoney } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Buildings, MagnifyingGlass, Warning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Customers" };
export const dynamic = "force-dynamic";

/**
 * The customer list (`LEAD-8`, closing `TD-10` here).
 *
 * This screen read `listCustomers`, which has no `LIMIT` of any kind — every
 * customer, then every open job and every unpaid invoice belonging to them,
 * joined in memory to render twenty rows somebody actually looks at. It works
 * on a seeded database and stops working on a real one, quietly, by getting
 * slower.
 *
 * It now uses the same indexed keyset search the leads list uses, and
 * deliberately the same shape: search and paging state in the query string, one
 * box that matches a name, a phone number or an email, a cursor rather than an
 * offset. Somebody who learns that a phone number works on one screen must not
 * find it silently failing on the other.
 *
 * The totals above the list are a separate aggregate rather than a sum of the
 * page. "Outstanding" that silently means "on this page" is a number somebody
 * would quote to a customer.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("customers:read");

  const params = await searchParams;
  const q = typeof params["q"] === "string" ? params["q"].trim() : "";
  const cursor = typeof params["after"] === "string" ? params["after"] : undefined;
  const showInactive = params["inactive"] === "1";

  // Active accounts by default, as this list has always shown. A search, though,
  // looks across everything: somebody typing a phone number is asking "do we
  // know this person", and answering "no" because the account was deactivated
  // last year is the wrong answer.
  const includeInactive = showInactive || Boolean(q);

  const { page, totals } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      page: await searchCustomers(tx, { q: q || undefined, cursor, limit: 25, includeInactive }),
      totals: await customerPortfolioTotals(tx, { includeInactive }),
    }),
  );

  const customers = page.rows;

  /** Preserve the current filters when building a "next page" link. */
  const pageHref = (after: string | null) => {
    const next = new URLSearchParams();
    if (q) next.set("q", q);
    if (showInactive) next.set("inactive", "1");
    if (after) next.set("after", after);
    const query = next.toString();
    return query ? `/customers?${query}` : "/customers";
  };

  return (
    <AppShell session={session} active="customers">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Customers</h1>
        <p className="prose-body mt-2 text-[14px]">
          Work in flight and money outstanding on the same row, because together they are what
          decides whether the next job gets scheduled or held.
        </p>

        {/* GET, not a server action. The result is a URL, which is the whole
            point: a filtered list can be bookmarked, sent to a colleague and
            reached with the back button. */}
        <form method="get" action="/customers" className="mt-6 flex flex-wrap items-center gap-2">
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
              placeholder="Name, phone or email"
              aria-label="Search customers"
              className="w-full rounded-sm border py-2 pl-9 pr-3 text-[14px] outline-none focus:border-[var(--accent)]"
            />
          </div>
          <label
            className="flex items-center gap-2 text-[13px]"
            style={{ color: "var(--text-secondary)" }}
          >
            <input
              type="checkbox"
              name="inactive"
              value="1"
              defaultChecked={showInactive}
              className="h-4 w-4"
            />
            Include inactive
          </label>
          <button type="submit" className="btn btn-secondary !py-2 text-[14px]">
            Search
          </button>
          {q ? (
            <Link href="/customers" className="text-[13px] underline" style={{ color: "var(--text-muted)" }}>
              Clear
            </Link>
          ) : null}
        </form>

        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-3"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            {
              label: includeInactive ? "Accounts" : "Active accounts",
              value: String(totals.customerCount),
              tone: false,
            },
            { label: "Outstanding", value: formatMoney(totals.outstandingMinor), tone: false },
            {
              label: "Overdue",
              value: formatMoney(totals.overdueMinor),
              tone: totals.overdueMinor > 0,
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

        {totals.overdueCount > 0 ? (
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
              {totals.overdueCount} {totals.overdueCount === 1 ? "account is" : "accounts are"} past
              due:{" "}
              {totals.overdueAccounts
                .map((c) => `${c.name} (${formatMoney(c.overdueMinor, c.currency)})`)
                .join(" · ")}
              {/* The list is capped and the count is not, so say so rather than
                  letting the reader assume the banner is complete. */}
              {totals.overdueCount > totals.overdueAccounts.length
                ? ` — and ${totals.overdueCount - totals.overdueAccounts.length} more`
                : ""}
            </span>
          </p>
        ) : null}

        {customers.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">{q ? "Nothing matched" : "No customers yet"}</h2>
            <p className="prose-body mx-auto mt-2 text-[14px]">
              {q
                ? "No account has that name, phone number or email address. A phone number matches however it is written — the country code and the trunk zero do not matter."
                : "Converting a lead creates the customer, the property and the first job together."}
            </p>
            {q ? null : (
              <Link href="/leads" className="btn btn-secondary mt-5">
                Go to leads
              </Link>
            )}
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
                      {c.isActive ? null : (
                        <span
                          className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                          style={{ backgroundColor: "var(--surface)", color: "var(--text-secondary)" }}
                        >
                          Inactive
                        </span>
                      )}
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

        {page.nextCursor ? (
          <div className="mt-6">
            {/* Keyset, so this is "everything after the last row on this page"
                rather than "skip 25". A customer created while somebody pages
                cannot push a row past the boundary and out of sight. */}
            <Link href={pageHref(page.nextCursor)} className="btn btn-secondary">
              Show older accounts
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
