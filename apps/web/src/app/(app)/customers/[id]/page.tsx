import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  listPortalUsers, withTenant, getCustomer, listStaffUsers, listCommunications, listContracts } from "@meridian/db";
import { getService, formatMoney, toMinor, STATUS_LABEL, PROPERTY_TYPE_LABEL, type PropertyType, type JobStatus } from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { TermsPanel, ContactsPanel, AddPropertyForm, PortalAccessPanel } from "./panels";
import { LogCommunicationForm } from "../../leads/log-form";
import { CommunicationTimeline } from "../../leads/communication-timeline";
import { Buildings, ChatCircleText, ShieldCheck, UserCircle, Warning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Customer" };
export const dynamic = "force-dynamic";

const dubaiDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("customers:read");
  const { id } = await params;

  const data = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      detail: await getCustomer(tx, id),
      managers: await listStaffUsers(tx),
      // POR-8 needs more than getCustomer's summary: whether access is
      // currently active, and whether the invitation has been accepted at all.
      // "Invited three weeks ago and never signed in" and "revoked last month"
      // look identical without those, and they need opposite responses.
      portalAccess: await listPortalUsers(tx, id),
      // LEAD-9 is "a log of calls and messages per lead and customer". The
      // domain has taken a customerId since the day it was written and the
      // index for this timeline was created with it; only the screen was
      // missing, so an account's history lived wherever the person who took the
      // call kept their notes.
      communications: await listCommunications(tx, { customerId: id }),
      // CON-5. Entitlement was visible on the contract page and nowhere else,
      // so the question "how many AC visits are left on this account" could
      // only be answered by knowing which contract to open first. Filtered in
      // the query rather than in memory — the whole tenant's contracts is not a
      // read this screen needs.
      contracts: await listContracts(tx, { customerId: id, includeEnded: true }),
    }),
  );

  if (!data.detail) notFound();

  const { customer, contacts, properties, recentJobs, portalUsers } = data.detail;
  const canWriteCustomer = can(session.principal, "customers:write");
  const canWriteProperty = can(session.principal, "properties:write");

  return (
    <AppShell session={session} active="customers">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/customers" className="hover:underline">
            Customers
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span style={{ color: "var(--text-secondary)" }}>{customer.name}</span>
        </nav>

        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{customer.name}</h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {customer.code}
            {customer.taxRegistrationNumber ? ` · TRN ${customer.taxRegistrationNumber}` : ""}
            {` · customer since ${dubaiDate(customer.createdAt)}`}
          </p>
        </div>

        {!customer.isActive ? (
          <p
            role="status"
            className="mt-4 rounded p-3 text-[14px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
          >
            This account is inactive. It stays visible because its jobs and invoices still are.
          </p>
        ) : null}

        <dl
          className="mt-6 grid gap-px overflow-hidden rounded border sm:grid-cols-4"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            { label: "Properties", value: String(customer.propertyCount), tone: false },
            { label: "Open jobs", value: String(customer.openJobs), tone: false },
            {
              label: "Outstanding",
              value: formatMoney(customer.outstandingMinor, customer.currency),
              tone: false,
            },
            {
              label: "Overdue",
              value: formatMoney(customer.overdueMinor, customer.currency),
              tone: customer.overdueMinor > 0,
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

        {customer.overdueMinor > 0 ? (
          <p
            className="mt-4 flex items-start gap-3 rounded p-4 text-[14px]"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--text-primary)" }}
          >
            <Warning
              size={17}
              weight="fill"
              aria-hidden
              className="mt-0.5 shrink-0"
              style={{ color: "var(--accent-text)" }}
            />
            {formatMoney(customer.overdueMinor, customer.currency)} is past its due date on{" "}
            {customer.paymentTermsDays}-day terms. Worth settling before the next job is scheduled.
          </p>
        ) : null}

        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <TermsPanel
            customerId={customer.id}
            billingEmail={customer.billingEmail}
            phone={customer.phone}
            paymentTermsDays={customer.paymentTermsDays}
            creditLimit={customer.creditLimit}
            accountManagerId={customer.accountManagerId}
            notes={customer.notes}
            managers={[...data.managers]}
            canWrite={canWriteCustomer}
          />

          <ContactsPanel
            customerId={customer.id}
            contacts={[...contacts]}
            canWrite={canWriteCustomer}
          />
        </div>

        {/* POR-8. Only for staff who can write the customer: granting portal
            access is granting somebody a login, and it belongs with the other
            things that change who can see this customer's data. */}
        {canWriteCustomer ? (
          <div className="mt-6">
            <PortalAccessPanel
              customerId={customer.id}
              users={data.portalAccess.map((u) => ({
                userId: u.userId,
                fullName: u.fullName,
                email: u.email,
                isActive: u.isActive,
                lastLoginAt: u.lastLoginAt,
                hasPassword: u.hasPassword,
              }))}
              contacts={contacts.map((c) => ({ fullName: c.fullName, email: c.email }))}
            />
          </div>
        ) : null}

        {/* ── Properties ─────────────────────────────────────────────────── */}
        <section
          className="mt-6 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Buildings size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Properties
          </h2>

          {properties.length === 0 ? (
            <p className="prose-body mt-3 text-[14px]">
              No properties yet. A customer with no property cannot have a job raised against it,
              from here or from the portal.
            </p>
          ) : (
            <ul className="mt-5 divide-y rounded border">
              {properties.map((p) => (
                <li key={p.id}>
                  {/* CON-13. The property record is where the asset register
                      lives, so the row that used to be inert is the way in. */}
                  <Link
                    href={`/properties/${p.id}`}
                    className="flex flex-wrap items-baseline justify-between gap-3 p-4"
                  >
                    <div>
                      <p className="text-[14px] font-medium">
                        {p.name}
                        {p.isActive ? "" : " (inactive)"}
                      </p>
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {PROPERTY_TYPE_LABEL[p.type as PropertyType] ?? p.type}
                        {p.area ? ` · ${p.area}` : ""} · {p.city}
                        {p.floors ? ` · ${p.floors} floors` : ""}
                        {p.unitCount ? ` · ${p.unitCount} units` : ""}
                      </p>
                    </div>
                    <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                      {p.openJobs} open {p.openJobs === 1 ? "job" : "jobs"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {canWriteProperty ? <AddPropertyForm customerId={customer.id} /> : null}
        </section>

        {/* ── CON-5. Contracts and what is left on them ──────────────────────
            Rendered only when the account has one. Most customers do not, and
            an empty "Contracts" heading on every record teaches people to skip
            past the section on the records that have one. */}
        {data.contracts.length > 0 ? (
          <section
            className="mt-6 rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <ShieldCheck size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              Contracts and entitlement
            </h2>
            <p className="prose-body mt-2 text-[14px]">
              Visits are counted over the whole term, not per year. Work matching an exclusion is
              quoted at the contract discount rather than absorbed, which happens on the job.
            </p>

            <ul className="mt-5 divide-y rounded border">
              {data.contracts.map((c) => (
                <li key={c.id}>
                  <Link href={`/amc/${c.id}`} className="block p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-[14px] font-medium">
                        {c.name}
                        <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                          {" "}
                          &middot; {c.reference}
                        </span>
                      </p>
                      <span
                        className="text-[13px]"
                        style={{
                          color:
                            c.daysRemaining < 0
                              ? "var(--status-critical-text)"
                              : "var(--text-secondary)",
                        }}
                      >
                        {c.daysRemaining < 0
                          ? `expired ${dubaiDate(c.endsOn)}`
                          : `until ${dubaiDate(c.endsOn)}`}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {c.status} &middot; {formatMoney(toMinor(c.annualValue), c.currency)}/year
                      &middot; {c.propertyCount}{" "}
                      {c.propertyCount === 1 ? "property" : "properties"}
                    </p>

                    {c.entitlements.length === 0 ? (
                      <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        No per-service entitlement recorded on this contract.
                      </p>
                    ) : (
                      <ul className="mt-2 space-y-0.5">
                        {c.entitlements.map((e) => (
                          <li
                            key={e.id}
                            className="tnum text-[13px]"
                            style={{
                              color:
                                e.remaining <= 0
                                  ? "var(--status-critical-text)"
                                  : "var(--text-secondary)",
                            }}
                          >
                            {e.label}: {e.consumedVisits} of {e.entitledForTerm} used
                            {e.remaining <= 0
                              ? " · nothing left, further visits are quotable"
                              : ` · ${e.remaining} left`}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── LEAD-9. Calls and messages ─────────────────────────────────────
            The same form and the same timeline as the lead screen, imported
            rather than copied. The requirement names both sides, and the reason
            it does is that the history has to survive the conversion: an
            account whose log starts on the day the lead was closed has lost the
            three conversations that won the work. */}
        <section
          className="mt-6 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ChatCircleText size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Calls and messages ({data.communications.length})
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            One sentence and one click. Everything logged here stays with the account rather than
            with whoever took the call.
          </p>

          {canWriteCustomer ? (
            <div className="mt-5">
              <LogCommunicationForm customerId={customer.id} />
            </div>
          ) : (
            <p className="prose-body mt-3 text-[14px]">
              Your role can read this history but not add to it.
            </p>
          )}

          <CommunicationTimeline
            entries={data.communications}
            empty="Nothing logged against this account yet."
          />
        </section>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* ── Recent work ──────────────────────────────────────────────── */}
          <section
            className="rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold tracking-tight">Recent work</h2>
            {recentJobs.length === 0 ? (
              <p className="prose-body mt-3 text-[14px]">Nothing yet.</p>
            ) : (
              <ul className="mt-5 divide-y rounded border">
                {recentJobs.map((j) => (
                  <li key={j.id}>
                    <Link href={`/jobs/${j.id}`} className="block p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <p className="text-[14px] font-medium">{j.title}</p>
                        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                          {STATUS_LABEL[j.status as JobStatus] ?? j.status}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        <span className="tnum">{j.reference}</span> · {j.propertyName} ·{" "}
                        {getService(j.serviceSlug)?.shortName ?? j.serviceSlug} ·{" "}
                        {dubaiDate(j.createdAt)}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ── Portal access ────────────────────────────────────────────── */}
          <section
            className="rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <UserCircle size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              Portal access
            </h2>
            <p className="prose-body mt-2 text-[14px]">
              These people can sign in and see this account&rsquo;s jobs, quotes and invoices —
              and nothing belonging to any other customer. Postgres enforces that, not this screen.
            </p>
            {portalUsers.length === 0 ? (
              <p className="mt-5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                Nobody has portal access. Quotes still reach the billing email, but this customer
                cannot approve one without calling.
              </p>
            ) : (
              <ul className="mt-5 divide-y rounded border">
                {portalUsers.map((u) => (
                  <li key={u.id} className="p-4">
                    <p className="text-[14px] font-medium">{u.fullName}</p>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {u.email}
                      {u.lastLoginAt
                        ? ` · last signed in ${dubaiDate(u.lastLoginAt)}`
                        : " · never signed in"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
