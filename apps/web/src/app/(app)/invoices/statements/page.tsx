import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, customerStatement, listCustomers } from "@meridian/db";
import { formatMoney, dubaiDateKey, tenant, UserFacingError } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";

export const metadata: Metadata = { title: "Statement of account" };
export const dynamic = "force-dynamic";

/**
 * The statement of account (`INV-13`).
 *
 * ── WHAT THIS SCREEN IS FOR ─────────────────────────────────────────────────
 *
 * A customer rings up and asks what they owe. This is the answer, in the form
 * the question is actually settled in: every invoice, credit note, payment and
 * write-off in order, with a running balance, so the conversation is about a
 * line rather than about a number. The PDF beside it is what gets attached to
 * the reply.
 *
 * ── WHY THE PERIOD DEFAULTS TO "EVERYTHING" ─────────────────────────────────
 *
 * Because the question is almost always "what do we owe you", not "what
 * happened in March". A statement with a start date has a balance brought
 * forward, and a brought-forward figure is the line customers dispute — so the
 * default is the whole account, where there is nothing to bring forward, and a
 * date range is something you choose when you need one.
 *
 * ── WHY `invoices:read` AND NOT `customers:read` ────────────────────────────
 *
 * This is the customer's money position: what they were charged, what they
 * paid, and what the business gave up chasing. `customers:read` is held by
 * dispatch and by sales, who have no business reading the ledger; `invoices:read`
 * is held by `owner`, `admin`, `accountant` and `readonly`, plus the `customer`
 * portal role — which `requireSessionWith` excludes from every staff screen by
 * checking the role as well as the permission, because a portal user reaching a
 * page that queries through `withTenant` would see every customer's account.
 */
export default async function StatementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("invoices:read");
  const now = new Date();

  const params = await searchParams;
  const customerId = typeof params["customer"] === "string" ? params["customer"] : "";
  const from = readDate(params["from"]);
  // Dubai's day, never the host's. At 01:00 on the first of the month in this
  // session's timezone it is still the last day of the previous month in Dubai,
  // and a statement dated a day into the future would show movements the
  // customer has not been told about.
  const to = readDate(params["to"]) ?? dubaiDateKey(now);

  const { customers, statement, problem } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const customers = await listCustomers(tx, { now });
      if (!customerId) return { customers, statement: null, problem: null };
      try {
        return {
          customers,
          statement: await customerStatement(tx, { customerId, from, to, now }),
          problem: null,
        };
      } catch (error) {
        // A refusal here is information, not a failure: the range is backwards,
        // or the account has more movements than a statement may silently drop.
        // Both are things the reader fixes, so both are shown rather than logged.
        if (error instanceof UserFacingError) {
          return { customers, statement: null, problem: error.message };
        }
        throw error;
      }
    },
  );

  const currency = statement?.currency ?? "AED";
  const amount = (minor: number) => formatMoney(minor, currency);
  const inCredit = (statement?.closingBalanceMinor ?? 0) < 0;

  const downloadHref = () => {
    const q = new URLSearchParams({ customer: customerId, to });
    if (from) q.set("from", from);
    return `/invoices/statements/download?${q.toString()}`;
  };

  return (
    <AppShell session={session} active="invoices">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            Statement of account
          </h1>
          <Link href="/invoices" className="text-[13px]" style={{ color: "var(--accent-text)" }}>
            &larr; Invoices
          </Link>
        </div>

        <p className="prose-body mt-2 max-w-2xl text-[14px]">
          Every invoice, credit note, payment and write-off on one account, in the order they
          happened, with a running balance. Dated in {tenant.timezone}. Drafts are never shown — a
          draft has not been issued and is not owed.
        </p>

        {/* GET, so a prepared statement is a URL somebody can send to a
            colleague and the page stays a server component. */}
        <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            Account
            <select
              name="customer"
              defaultValue={customerId}
              className="rounded-sm border px-2 py-1.5 text-[13px]"
              style={{ borderColor: "var(--border-strong)", backgroundColor: "var(--surface-raised)" }}
            >
              <option value="">Choose a customer</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            From (optional)
            <input
              type="date"
              name="from"
              defaultValue={from ?? ""}
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
            Prepare
          </button>
        </form>

        <p className="prose-body mt-2 max-w-2xl text-[12px]" style={{ color: "var(--text-muted)" }}>
          Leave <em>From</em> empty for the whole account, which is what a customer asking &ldquo;what
          do we owe you&rdquo; means. A start date adds a balance brought forward, and that line is
          the one that gets disputed.
        </p>

        {problem ? (
          <p className="mt-6 text-[13px]" style={{ color: "var(--status-critical-text)" }}>
            {problem}
          </p>
        ) : null}

        {statement ? (
          <>
            <div className="mt-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div>
                <h2 className="text-[18px] font-semibold tracking-tight">
                  {statement.customer.name}
                </h2>
                <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {statement.customer.code}
                  {statement.customer.trn ? ` · TRN ${statement.customer.trn}` : ""}
                  {` · ${statement.customer.paymentTermsDays} day terms`}
                  {statement.customer.billingEmail ? ` · ${statement.customer.billingEmail}` : ""}
                </p>
              </div>
              <a
                href={downloadHref()}
                className="rounded-sm px-3 py-1.5 text-[13px] font-medium"
                style={{ backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }}
              >
                Download the PDF to send &darr;
              </a>
            </div>

            {/* ── The four figures and the balance ─────────────────────── */}
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Tile label="Brought forward" value={amount(statement.openingBalanceMinor)} />
              <Tile label="Invoiced" value={amount(statement.invoicedMinor)} />
              <Tile label="Credited" value={amount(statement.creditedMinor)} />
              <Tile label="Paid" value={amount(statement.paidMinor)} />
              <Tile
                label={inCredit ? "In their favour" : "Balance due"}
                value={amount(Math.abs(statement.closingBalanceMinor))}
                emphasis
              />
            </div>
            {statement.writtenOffMinor !== 0 ? (
              <p className="prose-body mt-3 max-w-2xl text-[13px]">
                <strong>{amount(statement.writtenOffMinor)}</strong> of this account was written off
                and is no longer being pursued. It is a line in the ledger below rather than a
                silent adjustment, so the running balance ends exactly on the figure above.
              </p>
            ) : null}

            {/* ── The ledger ───────────────────────────────────────────── */}
            <div className="mt-8 overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-[13px]">
                <caption className="sr-only">
                  Every movement on this account, oldest first, with a running balance
                </caption>
                <thead>
                  <tr style={{ color: "var(--text-secondary)" }}>
                    <Th>Document</Th>
                    <Th>Date</Th>
                    <Th align="right">Charges</Th>
                    <Th align="right">Credits</Th>
                    <Th align="right">Balance</Th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                    <Td>
                      <span className="font-semibold">
                        {statement.from ? "Balance brought forward" : "Opening balance"}
                      </span>
                    </Td>
                    <Td muted>{statement.from ?? "—"}</Td>
                    <Td align="right" muted>
                      —
                    </Td>
                    <Td align="right" muted>
                      —
                    </Td>
                    <Td align="right">{amount(statement.openingBalanceMinor)}</Td>
                  </tr>
                  {statement.entries.map((e, i) => (
                    <tr
                      key={`${e.kind}-${e.reference}-${i}`}
                      className="border-t"
                      style={{ borderColor: "var(--border-subtle)" }}
                    >
                      <Td>
                        <span className="font-semibold">{e.reference}</span>
                        <span className="ml-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                          {KIND_LABEL[e.kind]}
                          {e.kind === "credit_note" && e.detail ? ` · ${e.detail}` : ""}
                          {e.kind === "payment" && e.detail ? ` · ${e.detail.replace(/_/g, " ")}` : ""}
                        </span>
                      </Td>
                      <Td muted>{e.occurredOn}</Td>
                      <Td align="right">{e.amountMinor > 0 ? amount(e.amountMinor) : ""}</Td>
                      <Td align="right">{e.amountMinor < 0 ? amount(-e.amountMinor) : ""}</Td>
                      <Td align="right">{amount(e.balanceMinor)}</Td>
                    </tr>
                  ))}
                  {statement.entries.length === 0 ? (
                    <tr className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                      <Td colSpan={5} muted>
                        Nothing moved on this account in that period. That is a real answer, not a
                        missing one.
                      </Td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <p className="prose-body mt-3 max-w-2xl text-[12px]" style={{ color: "var(--text-muted)" }}>
              {/*
                Not "showing N of M". There is no M: this ledger is complete by
                construction, and beyond two thousand movements the domain
                function refuses rather than truncating — because a statement
                that quietly omits movements is a demand for the wrong amount.
              */}
              Every movement in the period is listed; this table is never
              truncated. The totals above come from their own database aggregates rather than from
              this table, and the running balance ends on the same figure — two routes to one
              number, which is what makes a missing row detectable.
            </p>

            {/* ── Ageing ───────────────────────────────────────────────── */}
            {statement.ageing.totalMinor > 0 ? (
              <>
                <h3 className="mt-8 text-[14px] font-semibold">
                  How this balance is aged, as at {statement.to}
                </h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Tile label="Not yet due" value={amount(statement.ageing.currentMinor)} />
                  <Tile label="1–30 days" value={amount(statement.ageing.days1to30Minor)} />
                  <Tile label="31–60 days" value={amount(statement.ageing.days31to60Minor)} />
                  <Tile label="Over 60 days" value={amount(statement.ageing.days61PlusMinor)} />
                </div>
                <p className="prose-body mt-3 max-w-2xl text-[13px]">
                  {statement.oldestOverdue ? (
                    <>
                      Oldest overdue: <strong>{statement.oldestOverdue.reference}</strong>, due{" "}
                      {statement.oldestOverdue.dueOn}, {statement.oldestOverdue.daysOverdue} day
                      {statement.oldestOverdue.daysOverdue === 1 ? "" : "s"} ago.
                    </>
                  ) : (
                    "Nothing on this account is past its due date."
                  )}{" "}
                  Aged from the dated payments and credit notes rather than from today&rsquo;s
                  position, so a statement reissued for a past date ages the way it did then.
                </p>
              </>
            ) : null}
          </>
        ) : problem === null && customerId === "" ? (
          <p className="prose-body mt-8 max-w-2xl text-[14px]" style={{ color: "var(--text-muted)" }}>
            Choose an account above.
          </p>
        ) : null}
      </div>
    </AppShell>
  );
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  invoice: "tax invoice",
  credit_note: "credit note",
  payment: "payment received",
  write_off: "written off",
};

function Tile({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div
      className="rounded-sm border p-3"
      style={{
        borderColor: emphasis ? "var(--border-strong)" : "var(--border-subtle)",
        backgroundColor: "var(--surface-raised)",
      }}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
        {label}
      </p>
      <p className={`tnum mt-1 ${emphasis ? "text-[18px] font-semibold" : "text-[15px]"}`}>{value}</p>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: "right" }) {
  return (
    <th
      scope="col"
      className={`pb-2 text-[11px] font-semibold uppercase tracking-wide ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  align,
  muted,
  colSpan,
}: {
  children: React.ReactNode;
  align?: "right";
  muted?: boolean;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`py-2 ${align === "right" ? "tnum text-right" : "text-left"}`}
      style={muted ? { color: "var(--text-muted)" } : undefined}
    >
      {children}
    </td>
  );
}

function readDate(value: string | string[] | undefined): string | null {
  if (typeof value !== "string" || value === "") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
