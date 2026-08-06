import type { Metadata } from "next";
import Link from "next/link";
import {
  withCustomerScope,
  listDispatchBoard,
  listQuotes,
  listInvoices,
  INVOICE_STATUS_LABEL,
} from "@meridian/db";
import { getService, STATUS_LABEL, formatMoney, toMinor, OPEN_STATUSES } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { Clock, FileText, Receipt, CheckCircle } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePortalSession();
  const params = await searchParams;
  const raised = typeof params["raised"] === "string" ? params["raised"] : undefined;

  // Every read goes through withCustomerScope, so Postgres restricts these rows
  // to this customer. A forgotten filter here returns nothing rather than
  // another customer's records.
  const { jobs, quotes, invoices } = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    async (tx) => ({
      jobs: await listDispatchBoard(tx, { statuses: OPEN_STATUSES, limit: 50 }),
      quotes: await listQuotes(tx, { limit: 20 }),
      invoices: await listInvoices(tx, { limit: 20 }),
    }),
  );

  const awaitingDecision = quotes.filter((q) => q.status === "sent" || q.status === "viewed");
  const unpaid = invoices.filter((i) => i.status !== "paid" && i.status !== "written_off");
  const outstandingMinor = unpaid.reduce(
    (sum, i) => sum + (toMinor(i.total) - toMinor(i.amountPaid)),
    0,
  );

  return (
    <PortalShell session={session} active="portal">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          {session.tenant.brandName}
        </h1>
        <p className="prose-body mt-2 text-[14px]">
          Everything we are doing for you, and everything waiting on you.
        </p>

        {raised ? (
          <p
            role="status"
            className="mt-6 flex items-start gap-3 rounded p-4 text-[14px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
          >
            <CheckCircle size={17} weight="fill" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent-text)" }} />
            Request <strong className="tnum">{raised}</strong> is logged. We will triage it and come
            back to you.
          </p>
        ) : null}

        <Link href="/portal/request" className="btn btn-primary mt-6">
          Raise a request
        </Link>

        <dl
          className="mt-8 grid gap-px overflow-hidden rounded border sm:grid-cols-3"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            { label: "Open jobs", value: String(jobs.length), tone: false },
            { label: "Quotes awaiting you", value: String(awaitingDecision.length), tone: awaitingDecision.length > 0 },
            { label: "Outstanding", value: formatMoney(outstandingMinor), tone: outstandingMinor > 0 },
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

        {/* ── Quotes awaiting a decision ─────────────────────────────────── */}
        {awaitingDecision.length > 0 ? (
          <section className="mt-10">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <FileText size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              Waiting for your decision
            </h2>
            <ul className="mt-4 space-y-3">
              {awaitingDecision.map((q) => (
                <li key={q.id}>
                  <Link
                    href={`/portal/quotes/${q.id}`}
                    className="block rounded border-2 p-5 transition-colors"
                    style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-[15px] font-medium">{q.title}</p>
                      <p className="tnum text-[15px] font-semibold">{formatMoney(toMinor(q.total), q.currency)}</p>
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {q.reference}
                      {q.validUntil
                        ? ` · valid until ${q.validUntil.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })}`
                        : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── Open jobs ──────────────────────────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Clock size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Work in progress
          </h2>
          {jobs.length === 0 ? (
            <p className="prose-body mt-3 text-[14px]">Nothing open at the moment.</p>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {jobs.map((j) => (
                <li key={j.id} className="p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <p className="text-[15px] font-medium">{j.title}</p>
                    <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {STATUS_LABEL[j.status]}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {j.reference} &middot; {j.propertyName}
                    {j.propertyArea ? `, ${j.propertyArea}` : ""} &middot;{" "}
                    {getService(j.serviceSlug)?.shortName ?? j.serviceSlug}
                    {j.technicianName ? ` · ${j.technicianName} assigned` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Invoices ───────────────────────────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Receipt size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Invoices
          </h2>
          {invoices.length === 0 ? (
            <p className="prose-body mt-3 text-[14px]">No invoices yet.</p>
          ) : (
            <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
              {invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap items-baseline justify-between gap-3 p-5">
                  <div>
                    <p className="tnum text-[15px] font-medium">{i.reference}</p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {INVOICE_STATUS_LABEL[i.status]}
                      {i.dueOn
                        ? ` · due ${i.dueOn.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })}`
                        : ""}
                      {i.daysUntilDue !== null && i.daysUntilDue < 0 && i.status !== "paid"
                        ? ` · ${Math.abs(i.daysUntilDue)} days overdue`
                        : ""}
                    </p>
                  </div>
                  <p className="tnum text-[15px] font-semibold">{formatMoney(toMinor(i.total), i.currency)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>
    </PortalShell>
  );
}
