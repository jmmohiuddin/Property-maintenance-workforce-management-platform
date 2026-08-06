import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withCustomerScope, getQuoteWithLines, QUOTE_STATUS_LABEL } from "@meridian/db";
import { formatMoney, toMinor } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { QuoteDecision } from "./decision";
import { CheckCircle, XCircle } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Quotation" };
export const dynamic = "force-dynamic";

export default async function PortalQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePortalSession();
  const { id } = await params;

  const quote = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    (tx) => getQuoteWithLines(tx, id),
  );

  // Under customer-scope policies, another customer's quote is simply not
  // visible - so "not found" and "not yours" are indistinguishable here, which
  // is exactly what we want.
  if (!quote) notFound();

  const decided = quote.status === "approved" || quote.status === "rejected";
  const awaiting = quote.status === "sent" || quote.status === "viewed";

  return (
    <PortalShell session={session} active="quotes">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/portal" className="hover:underline">
            Your account
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span className="tnum" style={{ color: "var(--text-secondary)" }}>
            {quote.reference}
          </span>
        </nav>

        <div className="mt-6 max-w-3xl">
          <div className="flex flex-wrap items-center gap-3">
            <span className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
              {quote.reference}
            </span>
            <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              {QUOTE_STATUS_LABEL[quote.status]}
            </span>
          </div>

          <h1 className="mt-3 text-2xl font-semibold tracking-tight md:text-3xl">{quote.title}</h1>

          {quote.validUntil ? (
            <p className="prose-body mt-3 text-[14px]">
              Valid until{" "}
              {quote.validUntil.toLocaleDateString("en-GB", {
                timeZone: "Asia/Dubai",
                dateStyle: "long",
              })}
              .
            </p>
          ) : null}

          {/* ── Lines ──────────────────────────────────────────────────── */}
          <div
            className="mt-8 overflow-x-auto rounded border"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <table className="w-full min-w-[36rem] border-collapse text-left">
              <thead>
                <tr className="border-b text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  <th scope="col" className="px-4 py-3 font-medium">Description</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Qty</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Unit price</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {quote.lines.map((l) => (
                  <tr key={l.position} className="border-b last:border-0">
                    <td className="px-4 py-3 text-[14px]">{l.description}</td>
                    <td className="tnum px-4 py-3 text-right text-[14px]">
                      {Number(l.quantity)} {l.unit}
                    </td>
                    <td className="tnum px-4 py-3 text-right text-[14px]">
                      {formatMoney(toMinor(l.unitPrice), quote.currency)}
                    </td>
                    <td className="tnum px-4 py-3 text-right text-[14px] font-medium">
                      {formatMoney(toMinor(l.lineTotal), quote.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Totals ─────────────────────────────────────────────────── */}
          <dl className="mt-6 ml-auto max-w-xs space-y-2 text-[14px]">
            <div className="flex justify-between">
              <dt style={{ color: "var(--text-secondary)" }}>Subtotal</dt>
              <dd className="tnum">{formatMoney(toMinor(quote.subtotal), quote.currency)}</dd>
            </div>
            {toMinor(quote.discountAmount) > 0 ? (
              <div className="flex justify-between">
                <dt style={{ color: "var(--text-secondary)" }}>Discount</dt>
                <dd className="tnum">-{formatMoney(toMinor(quote.discountAmount), quote.currency)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between">
              <dt style={{ color: "var(--text-secondary)" }}>
                VAT {(quote.taxRateBasisPoints / 100).toFixed(0)}%
              </dt>
              <dd className="tnum">{formatMoney(toMinor(quote.taxAmount), quote.currency)}</dd>
            </div>
            <div className="flex justify-between border-t pt-2 text-[16px] font-semibold">
              <dt>Total</dt>
              <dd className="tnum">{formatMoney(toMinor(quote.total), quote.currency)}</dd>
            </div>
          </dl>

          {quote.notes ? <p className="prose-body mt-8 text-[14px]">{quote.notes}</p> : null}

          {/* ── Decision ───────────────────────────────────────────────── */}
          <div className="mt-10">
            {awaiting ? (
              <QuoteDecision quoteId={quote.id} />
            ) : decided ? (
              <p
                className="flex items-center gap-2 rounded p-4 text-[14px]"
                style={{ backgroundColor: "var(--surface-sunken)" }}
              >
                {quote.status === "approved" ? (
                  <CheckCircle size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
                ) : (
                  <XCircle size={18} weight="fill" aria-hidden style={{ color: "var(--text-muted)" }} />
                )}
                You {quote.status} this quotation. Contact us if you need to change that.
              </p>
            ) : (
              <p className="prose-body text-[14px]">
                This quotation is {QUOTE_STATUS_LABEL[quote.status].toLowerCase()} and is not awaiting
                a decision.
              </p>
            )}
          </div>
        </div>
      </div>
    </PortalShell>
  );
}
