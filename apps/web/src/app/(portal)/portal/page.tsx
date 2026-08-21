import type { Metadata } from "next";
import Link from "next/link";
import {
  withCustomerScope,
  listPortalRequests,
  countJobs,
  listQuotes,
  countQuotes,
  QUOTE_AWAITING_DECISION,
  listPortalInvoices,
  portalStatement,
  listPortalContracts,
  INVOICE_STATUS_LABEL,
} from "@meridian/db";
import {
  getService,
  PORTAL_JOB_NARRATIVE,
  formatMoney,
  toMinor,
  OPEN_STATUSES,
} from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { EmptyState } from "@/components/empty-state";
import { Clock, FileText, Receipt, CheckCircle, ShieldCheck } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

/**
 * How many open requests the dashboard card shows before deferring to the list.
 *
 * A summary card, not a list — the full one is `/portal/requests`, one link
 * away. Deliberately small: a building manager with forty things open needs the
 * shape of it here and the whole of it there.
 */
const OPEN_SHOWN = 8;

/** The same treatment for the other two lists: a summary, and a way to the rest. */
const AWAITING_SHOWN = 5;
const INVOICES_SHOWN = 8;

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
  const { jobs, openJobs, quotes, awaitingQuotes, invoices, statement, contracts } = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    async (tx) => ({
      // `listPortalRequests`, not `listDispatchBoard`, for the same reason the
      // invoices below are the portal query and not the staff one.
      //
      // Customer scope made the board safe ACROSS customers — RLS refuses
      // another account's rows and that is verified. It says nothing about
      // which of a customer's OWN columns belong in front of them, and the
      // board is a dispatcher's projection: `priority`, `respondByAt`,
      // `resolveByAt` and a computed `sla` breach state. None of that is a
      // promise made to the customer. An internal target missed is an
      // operational fact, and publishing it turns every busy week into a
      // contractual conversation about a number nobody agreed to. The board
      // also does not exclude `draft` — harmless while the caller passes
      // OPEN_STATUSES, and exactly the kind of thing that stops being harmless
      // when somebody widens the filter.
      //
      // `listPortalRequests` is the read written for this audience, and using
      // it here also ends a smaller inconsistency: this page said "Work
      // complete" in the internal vocabulary while /portal/requests said what
      // that means to a customer, for the same job on the same morning.
      jobs: await listPortalRequests(tx, { statuses: OPEN_STATUSES, limit: OPEN_SHOWN }),
      // The headline figure, counted rather than measured. `jobs.length` above
      // is a page size: a customer with nine open requests would have read "8"
      // and had no way to tell. This is the trap `LEAD-8` names, and the
      // dispatch board, the customers page and the owner dashboard have each
      // been fixed for it — the portal was the last one holding it.
      openJobs: await countJobs(tx, { statuses: OPEN_STATUSES }),
      // Filtered in SQL, not in the array below. `listQuotes` is newest-first
      // across every status — including `draft`, which is ours and unfinished —
      // so reading a page and filtering it answers "how many are awaiting a
      // decision among the twenty most recent", which goes wrong long before
      // twenty: a run of recent approved and rejected quotes pushes the waiting
      // ones off, and the customer is shown none while two sit with them.
      quotes: await listQuotes(tx, {
        statuses: QUOTE_AWAITING_DECISION,
        limit: AWAITING_SHOWN,
      }),
      awaitingQuotes: await countQuotes(tx, { statuses: QUOTE_AWAITING_DECISION }),
      // `listPortalInvoices`, not `listInvoices`. The staff query returns
      // drafts, and this page rendered them: a draft invoice is a working
      // document whose amount can still change and which has no legal
      // existence, so showing one publishes a figure the business has not
      // committed to. Customer scope made the list safe across customers and
      // did nothing about which of their own rows they should see.
      //
      // One more than the page renders. There is no invoice-count aggregate and
      // this does not need one: fetching N+1 and rendering N is an exact answer
      // to the only question the footer asks — is there more than this.
      invoices: await listPortalInvoices(tx, { limit: INVOICES_SHOWN + 1 }),
      // POR-4. The balance, from the aggregate that computes it over every row
      // rather than from the page above.
      //
      // `limit: 0` deliberately: `portalStatement` returns a capped ledger AND a
      // separate total, and only the total is wanted here. Asking for no
      // entries costs one aggregate and no rows. The ledger itself is
      // /portal/invoices, which is where a customer goes to ask how the number
      // was arrived at — and it is the same number, because it comes from the
      // same query.
      statement: await portalStatement(tx, { limit: 0 }),
      // CON-5. Entitlement was visible to staff on the contract page and
      // nowhere else, so a customer on an AMC could not see how many of the
      // visits they had paid for were left. Most customers have no contract and
      // get nothing rendered — see the section below.
      contracts: await listPortalContracts(tx),
    }),
  );

  /*
    ── NO ARITHMETIC OVER A PAGE ON THIS SCREEN ────────────────────────────────

    Every figure below is either a database aggregate or a length that is
    honestly labelled as a page. The balance used to be
    `invoices.filter(...).reduce(...)` over a 20-row list, and the direction it
    failed in is the reason this was worth changing: a customer with more than
    twenty invoices was shown LESS than they owed, and an understated bill in
    the customer's favour is not questioned by the customer. It is found by an
    accountant, months later, as a dispute.

    `balanceMinor` is invoiced − credited − paid computed over every row, and it
    is the same number /portal/invoices prints at the foot of the statement, so
    the two screens cannot disagree.
  */
  const balanceMinor = statement.balanceMinor;
  // A credit balance is a real state — an overpayment, or a credit note larger
  // than what it was raised against — and "Outstanding: −AED 500" is not how to
  // say it. The sign moves into the label; the figure stays a figure.
  const inCredit = balanceMinor < 0;

  // The +1 probe from the read above, unrendered. `invoices` holds at most
  // INVOICES_SHOWN + 1, so this is "there is more", exactly, without a count.
  const invoicesShown = invoices.slice(0, INVOICES_SHOWN);
  const moreInvoices = invoices.length > invoicesShown.length;

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
            { label: "Open jobs", value: String(openJobs), tone: false },
            { label: "Quotes awaiting you", value: String(awaitingQuotes), tone: awaitingQuotes > 0 },
            {
              label: inCredit ? "In credit" : "Outstanding",
              value: formatMoney(Math.abs(balanceMinor), statement.currency),
              tone: balanceMinor > 0,
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

        {/* ── Quotes awaiting a decision ─────────────────────────────────── */}
        {awaitingQuotes > 0 ? (
          <section className="mt-10">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <FileText size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              Waiting for your decision
            </h2>
            {/* Keyed off the count, not the list. A customer with more quotes
                waiting than fit here is told so rather than left to assume the
                five in front of them are all of them. */}
            {awaitingQuotes > quotes.length ? (
              <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                Showing the {quotes.length} most recent of{" "}
                <span className="tnum">{awaitingQuotes}</span> waiting on you.
              </p>
            ) : null}
            <ul className="mt-4 space-y-3">
              {quotes.map((q) => (
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
              of it, which is the question the phone call was about.

              When the card is short of the total it says so in the same breath,
              rather than presenting eight rows as the whole account. A cap is
              the right shape for a summary; a silent one is not. */}
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {openJobs > jobs.length ? (
              <>
                Showing the {jobs.length} most recent of{" "}
                <span className="tnum">{openJobs}</span> open.{" "}
              </>
            ) : null}
            <Link
              href="/portal/requests"
              className="font-medium"
              style={{ color: "var(--accent-text)" }}
            >
              See every request, including completed ones
            </Link>
          </p>
          {openJobs === 0 ? (
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
                <li key={j.id}>
                  {/* One tap target for the whole row, as on /portal/requests.
                      POR-10: these rows are read on phones. */}
                  <Link href={`/portal/requests/${j.id}`} className="block p-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-[15px] font-medium">{j.title}</p>
                      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {/* The customer's vocabulary, not the dispatcher's. */}
                        {PORTAL_JOB_NARRATIVE[j.status]}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      <span className="tnum">{j.reference}</span> &middot; {j.propertyName}
                      {j.propertyArea ? `, ${j.propertyArea}` : ""} &middot;{" "}
                      {getService(j.serviceSlug)?.shortName ?? j.serviceSlug}
                      {j.technicianName ? ` · ${j.technicianName} assigned` : ""}
                    </p>
                  </Link>
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
          {/* Same treatment as the two lists above: say when this is a summary
              rather than the whole account. There is no invoice-count aggregate
              to quote a total from, and this does not need one — the +1 probe
              on the read answers "is there more", which is the only claim made
              here. */}
          <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {moreInvoices ? `Showing the ${invoicesShown.length} most recent. ` : ""}
            <Link
              href="/portal/invoices"
              className="font-medium"
              style={{ color: "var(--accent-text)" }}
            >
              All invoices, PDFs and your statement
            </Link>
          </p>
          {invoicesShown.length === 0 ? (
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
              {invoicesShown.map((i) => (
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
