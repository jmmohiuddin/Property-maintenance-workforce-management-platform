import type { Metadata } from "next";
import Link from "next/link";
import {
  withCustomerScope,
  listDispatchBoard,
  listQuotes,
  listPortalInvoices,
  listPortalContracts,
  INVOICE_STATUS_LABEL,
} from "@meridian/db";
import { getService, STATUS_LABEL, formatMoney, toMinor, OPEN_STATUSES } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { EmptyState } from "@/components/empty-state";
import { Clock, FileText, Receipt, CheckCircle, ShieldCheck } from "@phosphor-icons/react/dist/ssr";

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
  const { jobs, quotes, invoices, contracts } = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    async (tx) => ({
      jobs: await listDispatchBoard(tx, { statuses: OPEN_STATUSES, limit: 50 }),
      quotes: await listQuotes(tx, { limit: 20 }),
      // `listPortalInvoices`, not `listInvoices`. The staff query returns
      // drafts, and this page rendered them: a draft invoice is a working
      // document whose amount can still change and which has no legal
      // existence, so showing one publishes a figure the business has not
      // committed to. Customer scope made the list safe across customers and
      // did nothing about which of their own rows they should see.
      invoices: await listPortalInvoices(tx, { limit: 20 }),
      // CON-5. Entitlement was visible to staff on the contract page and
      // nowhere else, so a customer on an AMC could not see how many of the
      // visits they had paid for were left. Most customers have no contract and
      // get nothing rendered — see the section below.
      contracts: await listPortalContracts(tx),
    }),
  );

  const awaitingDecision = quotes.filter((q) => q.status === "sent" || q.status === "viewed");
  const unpaid = invoices.filter((i) => i.outstandingMinor > 0);
  // Summed from the row's own `outstandingMinor`, which already nets off credit
  // notes. The previous arithmetic here was total minus paid, so a customer
  // holding a credit note was shown a balance that included money they no
  // longer owed.
  const outstandingMinor = unpaid.reduce((sum, i) => sum + i.outstandingMinor, 0);

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
          {/* POR-3. The dashboard shows open work; this is the way to the rest
              of it, which is the question the phone call was about. */}
          <Link href="/portal/requests" className="mt-2 inline-block text-[13px] font-medium" style={{ color: "var(--accent-text)" }}>
            See every request, including completed ones
          </Link>
          {jobs.length === 0 ? (
            /*
              ADM-12. A GOOD zero, and it has to look like one.

              "Nothing open at the moment." was written for whoever was staring
              at seed data, and to a customer on their first morning it reads
              like a screen that failed to load. Nothing open is the outcome
              they are paying for — everything they asked for is finished — so
              this is `good` and not `start`, and it says what to do next
              anyway, because the next thing is the only reason to come back.
            */
            <div className="mt-3">
              <EmptyState kind="good" title="Nothing is open right now.">
                <p>
                  Every request you have raised has been finished. When something needs attention,
                  raise it above and you will have a reference straight away &mdash; no phone call
                  needed.
                </p>
              </EmptyState>
            </div>
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

        {/* ── CON-5. Your contract, and what is left on it ──────────────────
            Nothing renders when there is no contract. Most customers are not on
            an AMC, and a "Your contract" heading followed by "none" on every
            one of their visits is clutter that trains people to scroll past the
            section — including the customers it was written for. */}
        {contracts.length > 0 ? (
          <section className="mt-10">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <ShieldCheck size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              Your maintenance contract
            </h2>
            <p className="prose-body mt-2 text-[14px]">
              Visits are counted across the whole term of the contract rather than per year.
            </p>
            <ul
              className="mt-4 divide-y rounded border"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {contracts.map((c) => (
                <li key={c.id} className="p-5">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <p className="text-[15px] font-medium">{c.name}</p>
                    <span className="tnum text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {c.reference}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {c.startsOn.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })}
                    {" – "}
                    {c.endsOn.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" })}
                    {c.daysRemaining >= 0
                      ? ` · ${c.daysRemaining} days remaining`
                      : " · this term has ended"}
                  </p>

                  {c.entitlements.length > 0 ? (
                    <dl className="mt-4 space-y-1.5">
                      {c.entitlements.map((e) => (
                        <div key={e.serviceSlug} className="flex flex-wrap justify-between gap-3">
                          <dt className="text-[14px]">{e.label}</dt>
                          <dd
                            className="tnum text-[14px] font-medium"
                            style={
                              e.remaining === 0 ? { color: "var(--accent-text)" } : undefined
                            }
                          >
                            {e.remaining} of {e.entitledForTerm} visits remaining
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}

                  {c.exclusions.length > 0 ? (
                    <div className="mt-4">
                      <p className="text-[13px] font-medium">Not included</p>
                      <ul className="mt-1 space-y-0.5">
                        {c.exclusions.map((x) => (
                          <li key={x.code} className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                            {x.label}
                            {x.description ? ` — ${x.description}` : ""}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        Work outside the contract is always quoted before it is carried out, at the
                        discount agreed in your contract.
                      </p>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── Invoices ───────────────────────────────────────────────────── */}
        <section className="mt-10">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Receipt size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Invoices
          </h2>
          <Link href="/portal/invoices" className="mt-2 inline-block text-[13px] font-medium" style={{ color: "var(--accent-text)" }}>
            All invoices, PDFs and your statement
          </Link>
          {invoices.length === 0 ? (
            /*
              A START zero, deliberately a different kind from the one above.

              An empty invoice list is neither good news nor a hole: it is what
              a new account looks like before the first job is signed off. Both
              zeros rendering identically is what teaches somebody to stop
              reading the section — and neither of them is a `gap`, because
              nothing here is going unrecorded.
            */
            <div className="mt-3">
              <EmptyState kind="start" title="No invoices have been raised yet.">
                <p>
                  An invoice appears here once a job has been completed and signed off. Nothing is
                  owed in the meantime.
                </p>
              </EmptyState>
            </div>
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
                      {i.daysOverdue !== null ? ` · ${i.daysOverdue} days overdue` : ""}
                    </p>
                  </div>
                  <p className="tnum text-[15px] font-semibold">{formatMoney(i.totalMinor, i.currency)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

      </div>
    </PortalShell>
  );
}
