import { Fragment } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getInvoiceDocument,
  invoiceSequenceGaps,
  listCreditNotes,
  INVOICE_STATUS_LABEL,
  CREDIT_REASON_LABEL,
} from "@meridian/db";
import {
  formatMoney,
  toMinor,
  complianceChecklist,
  variantRationale,
  documentTitle,
  dubaiDateKey,
  type ChecklistItem,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { PaymentPanel, CreditNotePanel } from "./invoice-actions";
import { CheckCircle, Warning, Circle } from "@phosphor-icons/react/dist/ssr";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: `Invoice ${id.slice(0, 8)}` };
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    dateStyle: "medium",
  });
}

/**
 * The compliance panel.
 *
 * Three states, not two. A missing Article 59 field is a failure; PINT AE
 * readiness is genuinely not required until 1 July 2027 and is shown as
 * pending. Colouring the second one red would teach people to ignore the first,
 * which is the specific way compliance dashboards stop working.
 */
function ChecklistRow({ item }: { item: ChecklistItem }) {
  const icon =
    item.state === "ok" ? (
      <CheckCircle size={14} weight="fill" aria-hidden style={{ color: "var(--status-success-text)" }} />
    ) : item.state === "missing" ? (
      <Warning size={14} weight="fill" aria-hidden style={{ color: "var(--status-critical-text)" }} />
    ) : (
      <Circle size={14} aria-hidden style={{ color: "var(--text-muted)" }} />
    );

  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span>
        {/* The state is in the word as well as the mark. A document screen gets
            photocopied, printed and read on a phone in sunlight, and status
            carried by colour alone survives none of those. */}
        <span className="text-[13px]">{item.label}</span>
        <span className="sr-only">
          {item.state === "ok" ? " — satisfied" : item.state === "missing" ? " — not satisfied" : " — pending"}
        </span>
        {item.detail ? (
          <span className="mt-0.5 block text-[12px]" style={{ color: "var(--text-muted)" }}>
            {item.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("invoices:read");
  const { id } = await params;
  const today = dubaiDateKey(new Date());

  const data = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const invoice = await getInvoiceDocument(tx, id);
      if (!invoice) return null;

      // The gap report is per series and per year, so it is read from the
      // invoice's own year rather than from today's — reopening a 2026 invoice
      // in 2027 must still check the series it belongs to.
      const year = Number(invoice.document.reference.split("-")[1]) || new Date().getFullYear();
      const sequence = await invoiceSequenceGaps(tx, { year });
      const creditNotes = await listCreditNotes(tx, { invoiceId: id });

      return { invoice, sequence, creditNotes };
    },
  );

  // RLS makes "does not exist" and "belongs to another tenant" indistinguishable
  // here, which is exactly the intended behaviour.
  if (!data) notFound();

  const { invoice, sequence, creditNotes } = data;
  const doc = invoice.document;

  const ownSequence = Number(doc.reference.slice(-5));
  const gapBefore = sequence.gaps.some((g) => g.sequence < ownSequence);

  const checklist = complianceChecklist(doc, {
    variant: invoice.variant,
    sequenceGapBefore: gapBefore,
    asOf: today,
  });
  const failing = checklist.filter((i) => i.state === "missing");

  const creditedTotalMinor = invoice.creditedMinor;
  const creditableMinor = Math.max(0, doc.totalMinor - creditedTotalMinor);

  // Lines are grouped by the job that produced them, because a disputed line is
  // answered by opening the job it came from.
  const groups = new Map<string, typeof doc.lines>();
  for (const line of doc.lines) {
    const key = line.jobReference ?? "";
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }

  return (
    <AppShell session={session} active="invoices">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/invoices" className="hover:underline">
            Invoices
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span className="tnum">{doc.reference}</span>
        </nav>

        <header className="mt-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="tnum text-2xl font-semibold tracking-tight md:text-3xl">{doc.reference}</h1>
            <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              {INVOICE_STATUS_LABEL[invoice.status]}
            </span>
          </div>

          <p className="prose-body mt-2 text-[14px]">
            {doc.recipient.name ?? "Recipient not recorded"}
            {doc.recipient.trn ? (
              <>
                {" · "}
                <span className="tnum">TRN {doc.recipient.trn}</span>
              </>
            ) : null}
          </p>

          <p className="tnum mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {documentTitle(doc.documentType)} · Issued {formatDate(doc.issueDate)} · Supply{" "}
            {formatDate(doc.supplyDate)} · Due {formatDate(doc.dueDate ?? null)}
          </p>

          <p className="mt-2 text-[13px]" style={{ color: "var(--text-secondary)" }}>
            {variantRationale({
              variant: invoice.variant,
              recipientTrn: doc.recipient.trn,
              totalMinor: doc.totalMinor,
            })}
          </p>

          {failing.length > 0 ? (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded border p-3 text-[13px]"
              style={{
                backgroundColor: "var(--status-critical-wash)",
                borderColor: "var(--status-critical)",
                color: "var(--status-critical-text)",
              }}
            >
              <Warning size={15} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
              <span>
                {failing.length} mandatory field
                {failing.length === 1 ? "" : "s"} missing. This document cannot be rendered as a tax
                invoice until they are fixed — issuing an incomplete one is an Article 59 failure
                carrying AED 2,500 per document.
              </span>
            </p>
          ) : null}
        </header>

        <div className="mt-8 grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          {/* ── Lines and compliance ───────────────────────────────────── */}
          <div className="space-y-8">
            <section>
              <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Lines
              </h2>
              <div
                className="mt-3 overflow-x-auto rounded border"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <table className="w-full min-w-[36rem] border-collapse text-left">
                  <thead>
                    <tr
                      className="border-b text-[12px] uppercase tracking-wide"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <th scope="col" className="px-4 py-3 font-medium">Description</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Qty</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Unit price</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">VAT</th>
                      <th scope="col" className="px-4 py-3 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...groups.entries()].map(([jobReference, lines]) => (
                      <Fragment key={`group-${jobReference}`}>
                        {jobReference ? (
                          <tr className="border-b">
                            <th
                              scope="colgroup"
                              colSpan={5}
                              className="tnum px-4 py-2 text-left text-[12px] font-medium"
                              style={{ color: "var(--text-secondary)" }}
                            >
                              {jobReference}
                            </th>
                          </tr>
                        ) : null}
                        {lines.map((line) => (
                          <tr key={`${jobReference}-${line.position}`} className="border-b last:border-0">
                            <td className="px-4 py-3 text-[14px]">{line.description}</td>
                            <td className="tnum px-4 py-3 text-right text-[13px]">
                              {line.quantity} {line.unit}
                            </td>
                            <td className="tnum px-4 py-3 text-right text-[13px]">
                              {formatMoney(line.unitPriceMinor, doc.currency)}
                            </td>
                            <td className="tnum px-4 py-3 text-right text-[13px]">
                              {line.taxMinor === null ? (
                                <span style={{ color: "var(--status-critical-text)" }}>not captured</span>
                              ) : (
                                formatMoney(line.taxMinor, doc.currency)
                              )}
                            </td>
                            <td className="tnum px-4 py-3 text-right text-[14px]">
                              {formatMoney(line.lineTotalMinor, doc.currency)}
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Compliance
              </h2>
              <ul className="mt-2 divide-y rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
                {checklist.map((item) => (
                  <ChecklistRow key={item.key} item={item} />
                ))}
              </ul>
            </section>

            {creditNotes.length > 0 ? (
              <section>
                <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  Credit notes
                </h2>
                <ul className="mt-2 space-y-2">
                  {creditNotes.map((n) => (
                    <li
                      key={n.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 rounded border p-3 text-[13px]"
                      style={{ backgroundColor: "var(--surface-raised)" }}
                    >
                      <span className="tnum font-medium">{n.reference}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {CREDIT_REASON_LABEL[n.reason]}
                        {n.reasonDetail ? ` — ${n.reasonDetail}` : ""}
                      </span>
                      <span className="tnum">−{formatMoney(toMinor(n.total), n.currency)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          {/* ── Totals, payment, actions ───────────────────────────────── */}
          <div className="space-y-6">
            <section className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Totals
              </h2>
              <dl className="mt-3 space-y-1.5 text-[14px]">
                <div className="flex justify-between">
                  <dt style={{ color: "var(--text-secondary)" }}>Subtotal</dt>
                  <dd className="tnum">{formatMoney(doc.subtotalMinor, doc.currency)}</dd>
                </div>
                {doc.discountMinor > 0 ? (
                  <div className="flex justify-between">
                    <dt style={{ color: "var(--text-secondary)" }}>Discount</dt>
                    <dd className="tnum">−{formatMoney(doc.discountMinor, doc.currency)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between border-t pt-1.5">
                  <dt style={{ color: "var(--text-secondary)" }}>Net</dt>
                  <dd className="tnum">{formatMoney(doc.taxableMinor, doc.currency)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt style={{ color: "var(--text-secondary)" }}>
                    VAT {(doc.taxRateBasisPoints / 100).toFixed(0)}%
                  </dt>
                  <dd className="tnum">{formatMoney(doc.taxMinor, doc.currency)}</dd>
                </div>
                <div className="flex justify-between border-t pt-1.5 font-semibold">
                  <dt>Total</dt>
                  <dd className="tnum">{formatMoney(doc.totalMinor, doc.currency)}</dd>
                </div>
              </dl>
              <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                VAT is applied after the discount, because VAT is due on what the customer actually
                pays. Held in integer minor units throughout and proven to the fils by tests.
              </p>
            </section>

            <section className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Payment
              </h2>
              <dl className="mt-3 space-y-1.5 text-[14px]">
                <div className="flex justify-between">
                  <dt style={{ color: "var(--text-secondary)" }}>Received</dt>
                  <dd className="tnum">{formatMoney(invoice.amountPaidMinor, doc.currency)}</dd>
                </div>
                {creditedTotalMinor > 0 ? (
                  <div className="flex justify-between">
                    <dt style={{ color: "var(--text-secondary)" }}>Credited</dt>
                    <dd className="tnum">−{formatMoney(creditedTotalMinor, doc.currency)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between font-semibold">
                  <dt>Outstanding</dt>
                  <dd className="tnum">{formatMoney(invoice.outstandingMinor, doc.currency)}</dd>
                </div>
              </dl>

              {can(session.principal, "invoices:create") ? (
                <PaymentPanel
                  invoiceId={invoice.invoiceId}
                  outstandingMinor={invoice.outstandingMinor}
                  currency={doc.currency}
                />
              ) : null}
            </section>

            {can(session.principal, "invoices:void") ? (
              <section className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  Correct this invoice
                </h2>
                <p className="prose-body mt-2 text-[13px]">
                  Any reduction in output tax — a return, a discount agreed after issue, a
                  cancellation, a correction — needs a tax credit note within 14 days, referencing
                  this invoice.
                </p>
                <CreditNotePanel
                  invoiceId={invoice.invoiceId}
                  invoiceReference={doc.reference}
                  creditableMinor={creditableMinor}
                  currency={doc.currency}
                />
              </section>
            ) : null}

            <section className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[12px] font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                Supplier on this document
              </h2>
              {/* Read from the invoice row, not from configuration. A reprint of
                  a 2026 invoice has to show the 2026 identity even after the
                  office moves or the TRN is reissued. */}
              <address className="mt-2 space-y-0.5 text-[13px] not-italic" style={{ color: "var(--text-secondary)" }}>
                <div>{doc.supplier.name ?? "Not recorded"}</div>
                {doc.supplier.address ? <div>{doc.supplier.address}</div> : null}
                {doc.supplier.trn ? <div className="tnum">TRN {doc.supplier.trn}</div> : null}
                {doc.supplier.licenceNumber ? (
                  <div className="tnum">DET licence {doc.supplier.licenceNumber}</div>
                ) : null}
                {doc.supplier.crNumber ? <div className="tnum">CR {doc.supplier.crNumber}</div> : null}
              </address>
              <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                {invoice.pdfStorageKey
                  ? "The rendered PDF is stored, not re-rendered on demand — the artefact must be stable even if the template changes."
                  : "No PDF has been rendered for this invoice yet."}
              </p>
            </section>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
