import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { can } from "@meridian/auth";
import { withTenant, vatReturnPack, vatPeriodOptions, VAT_EXCEPTION_ROWS } from "@meridian/db";
import { formatMoney, tenant } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Card, Metric } from "../dashboard-ui";

export const metadata: Metadata = { title: "VAT return" };
export const dynamic = "force-dynamic";

/**
 * The VAT return pack (`INV-11`).
 *
 * ── WHY THIS SCREEN IS DIFFERENT FROM EVERY OTHER REPORT HERE ───────────────
 *
 * Every other figure in this product informs a decision. These figures get
 * TRANSCRIBED — onto FTA Form VAT 201, inside 28 days of the end of the tax
 * period, by a person who will not check them against the invoices because that
 * is what this page is for. A number that is plausible and wrong here is filed,
 * and a filed number is corrected by a voluntary disclosure with a penalty
 * attached, not by refreshing the page.
 *
 * Three things follow from that, and they are the whole design:
 *
 *  1. **Every box says which box it is.** The reader is looking at a form with
 *     numbered boxes; a table of well-named figures they have to map themselves
 *     is where transcription errors come from.
 *  2. **A box this system cannot produce says so, in the row where the number
 *     would have been.** Leaving it out reads as zero. Boxes 9 to 11 —
 *     recoverable input tax — are the important case: this system records what
 *     the business invoices, not what it is invoiced, so it has no purchase
 *     data at all. A VAT return with a silently missing input side understates
 *     the reclaim and, worse, teaches the preparer that the page is complete.
 *  3. **The working papers are one click away and are not capped.** A figure
 *     nobody can trace back to documents cannot be defended two years later,
 *     which is when it is asked about.
 *
 * ── WHY BOTH PERMISSIONS ────────────────────────────────────────────────────
 *
 * The same pair the accounting export demands, for the same reason. `hr` holds
 * `reports:read` so the hiring figures on the dashboard work, and does not hold
 * `invoices:read`; `operations_manager` holds neither money permission. This
 * page is the tax position of the business, so it is gated on the money
 * permission as well as the reporting one — which leaves `owner`, `admin`,
 * `accountant` and the deliberately read-everything `readonly` role.
 */
export default async function VatReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("invoices:read");
  if (!can(session.principal, "reports:read")) {
    redirect("/denied?permission=reports:read");
  }

  const now = new Date();
  const params = await searchParams;

  // Dubai's day, never the host's. The default period is the quarter the
  // business is living in, which at 01:00 on 1 April in this session's zone is
  // still the quarter that ended yesterday in Dubai.
  const periods = vatPeriodOptions(now);
  const defaultPeriod = periods[0]!;

  const from = readDate(params["from"]) ?? defaultPeriod.from;
  const to = readDate(params["to"]) ?? defaultPeriod.to;
  const backwards = from > to;

  const pack = backwards
    ? null
    : await withTenant(
        { tenantId: session.principal.tenantId, userId: session.principal.userId },
        (tx) => vatReturnPack(tx, { from, to, now }),
      );

  const currency = pack?.currency ?? "AED";
  const amount = (minor: number) => formatMoney(minor, currency);

  const generatedAt = (pack?.generatedAt ?? now).toLocaleString("en-GB", {
    timeZone: tenant.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });

  return (
    <AppShell session={session} active="dashboard">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">VAT return</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {generatedAt}
          </p>
        </div>

        <p className="prose-body mt-2 max-w-2xl text-[14px]">
          The output-tax side of FTA Form VAT 201 for one tax period, with the working papers
          behind it. Supplies are <strong>VAT-exclusive</strong> and net of credit notes issued in
          the same period; every document is dated by its own issue date in {tenant.timezone}, so an
          invoice raised at 23:30 on the last day of the period belongs to that period. Drafts are
          never counted.
        </p>

        {/* GET, so a chosen period is a URL that can be sent to the accountant
            and the page stays a server component. */}
        <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[12px]" style={{ color: "var(--text-secondary)" }}>
            From
            <input
              type="date"
              name="from"
              defaultValue={from}
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
            Update
          </button>
        </form>

        {/*
          The presets, and the sentence under them.

          The FTA assigns the filing frequency in the registration certificate —
          quarterly below AED 150m of annual turnover, monthly above it — and
          this system has never seen that certificate. Offering both and saying
          so is honest; defaulting to one silently would put the wrong three
          months in front of half the businesses that read this.
        */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px]">
          <span style={{ color: "var(--text-secondary)" }}>Quarters:</span>
          {periods
            .filter((p) => p.frequency === "quarterly")
            .slice(0, 5)
            .map((p) => (
              <PeriodLink key={p.label} label={p.label} from={p.from} to={p.to} active={p.from === from && p.to === to} />
            ))}
          <span className="ml-2" style={{ color: "var(--text-secondary)" }}>
            Months:
          </span>
          {periods
            .filter((p) => p.frequency === "monthly")
            .slice(0, 4)
            .map((p) => (
              <PeriodLink key={p.label} label={p.label} from={p.from} to={p.to} active={p.from === from && p.to === to} />
            ))}
        </div>
        <p className="prose-body mt-2 max-w-2xl text-[12px]" style={{ color: "var(--text-muted)" }}>
          Whether you file quarterly or monthly is set by the FTA in your registration certificate,
          not by turnover as calculated here. Pick the period on that certificate.
        </p>

        {backwards ? (
          <p className="mt-6 text-[13px]" style={{ color: "var(--status-critical-text)" }}>
            That period starts after it ends. Nothing was computed — an empty return from a
            backwards range is indistinguishable from a quiet quarter.
          </p>
        ) : null}

        {pack ? (
          <>
            {/* ── The one thing that must be read before anything is filed ── */}
            <div
              role="note"
              aria-label="This pack has no input-tax side"
              className="mt-8 rounded-sm border-l-2 py-3 pl-4"
              style={{
                borderColor: "var(--status-warning)",
                backgroundColor: "var(--surface-raised)",
              }}
            >
              <p className="text-[15px] font-semibold" style={{ color: "var(--status-warning-text)" }}>
                This pack is the output side only. Boxes 9 to 11 are not here.
              </p>
              <p className="prose-body mt-1 max-w-2xl text-[13px]">{pack.inputTax.reason}</p>
              <ul className="prose-body mt-2 max-w-2xl space-y-1 text-[12px]">
                {pack.inputTax.missing.map((line) => (
                  <li key={line}>— {line}</li>
                ))}
              </ul>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-2">
              <Card
                title="Output tax on supplies made in the period"
                subtitle={`${from} to ${to}, box 8's tax column`}
                href={`/reports/vat/download?from=${from}&to=${to}`}
              >
                <Metric label="Output tax due" value={amount(pack.outputTaxMinor)} emphasis />
                <Metric
                  label="Supplies, VAT-exclusive"
                  value={amount(pack.totalSuppliesMinor)}
                  note={`${pack.invoiceCount} invoice${pack.invoiceCount === 1 ? "" : "s"} less ${pack.creditNoteCount} credit note${pack.creditNoteCount === 1 ? "" : "s"} — ${pack.documentCount} document${pack.documentCount === 1 ? "" : "s"} in the working papers`}
                />
                <Metric label="Invoiced before credits" value={amount(pack.invoicedTaxableMinor)} />
                <Metric label="Credited back" value={amount(pack.creditedTaxableMinor)} />
              </Card>

              <Card
                title="From invoiced revenue to declared output tax"
                subtitle="Every step, so the figure can be checked without a calculator"
                tone={pack.taxVarianceMinor === 0 ? "neutral" : "critical"}
              >
                <table className="w-full border-collapse text-[13px]">
                  <caption className="sr-only">
                    The reconciliation from invoiced revenue to declared output tax
                  </caption>
                  <tbody>
                    {pack.reconciliation.map((line) => (
                      <tr key={line.label} className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                        <th scope="row" className="py-2 pr-3 text-left font-normal">
                          <span className={line.declared ? "font-semibold" : undefined}>
                            {line.label}
                          </span>
                          {line.note ? (
                            <span className="block text-[11px]" style={{ color: "var(--text-muted)" }}>
                              {line.note}
                            </span>
                          ) : null}
                        </th>
                        <td className="tnum py-2 text-right align-top">
                          <span className={line.declared ? "font-semibold" : undefined}>
                            {amount(line.amountMinor)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </div>

            {pack.mixedCurrency ? (
              <p className="mt-4 text-[13px]" style={{ color: "var(--status-critical-text)" }}>
                More than one currency was invoiced in this period, so every figure above is a
                mixture of currencies added together. VAT 201 is filed in AED. Do not transcribe
                these figures — resolve the currencies first.
              </p>
            ) : null}

            {/* ── The form, box by box ─────────────────────────────────── */}
            <h2 className="mt-10 text-[18px] font-semibold tracking-tight">
              VAT 201, box by box
            </h2>
            <p className="prose-body mt-1 max-w-2xl text-[13px]">
              A box this system cannot produce says so in the row where the number would have been.
              A missing row reads as a zero, and a zero on a tax return is a statement.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-[13px]">
                <caption className="sr-only">FTA Form VAT 201, box by box</caption>
                <thead>
                  <tr style={{ color: "var(--text-secondary)" }}>
                    <Th>Box</Th>
                    <Th>What the form asks for</Th>
                    <Th align="right">Amount</Th>
                    <Th align="right">VAT</Th>
                  </tr>
                </thead>
                <tbody>
                  <BoxRow box="1" label="Standard-rated supplies" value={amount(pack.standardRatedMinor)} vat={amount(pack.standardRatedTaxMinor)} note="Box 1 is split by emirate on the form. This system records one company address and does not record which fixed establishment made each supply, so it cannot do that split — apportion it yourself if you have establishments in more than one emirate." />
                  <BoxRow box="2" label="Tax refunds to tourists" unavailable="Not applicable to a maintenance contractor, and nothing here records a tourist refund scheme." />
                  <BoxRow box="3" label="Supplies subject to the reverse charge" unavailable="No record of purchases from outside the UAE exists in this system." />
                  <BoxRow box="4" label="Zero-rated supplies" value={amount(pack.zeroRatedMinor)} vat="—" note="Documents whose tax category is Z." />
                  <BoxRow box="5" label="Exempt supplies" value={amount(pack.exemptMinor)} vat="—" note="Documents whose tax category is E." />
                  <BoxRow box="6" label="Goods imported into the UAE" unavailable="No import or customs record exists in this system." />
                  <BoxRow box="7" label="Adjustments to goods imported" unavailable="Follows box 6." />
                  <BoxRow box="8" label="Totals — output" value={amount(pack.totalSuppliesMinor)} vat={amount(pack.outputTaxMinor)} emphasis note="Boxes 1, 4 and 5 together. Boxes 2, 3, 6 and 7 are not included because they are not produced here." />
                  <BoxRow box="9" label="Standard-rated expenses" unavailable="Input tax. See the note at the top — this system holds no purchase data." />
                  <BoxRow box="10" label="Supplies subject to the reverse charge (recoverable)" unavailable="Input tax. Same reason." />
                  <BoxRow box="11" label="Totals — input" unavailable="Input tax. Same reason." />
                  <BoxRow box="12" label="Total value of due tax for the period" unavailable="This is box 8's tax plus boxes 3 and 10, and those are not produced here. If you made no reverse-charge purchases in the period it equals the output tax above — but this system cannot know that, so it does not assert it." />
                  <BoxRow box="13" label="Total value of recoverable tax" unavailable="Input tax. Same reason." />
                  <BoxRow box="14" label="Payable or reclaimable" unavailable="Box 12 less box 13, neither of which is produced here." />
                </tbody>
              </table>
            </div>

            {/* ── Every rate and category actually used ────────────────── */}
            <h2 className="mt-10 text-[18px] font-semibold tracking-tight">
              What was charged, by category and rate
            </h2>
            <p className="prose-body mt-1 max-w-2xl text-[13px]">
              Straight from the documents. A rate appears here because a document carried it, not
              because it is expected — a 0% row under category S is a mistake worth seeing.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[52rem] border-collapse text-[13px]">
                <caption className="sr-only">Supplies by tax category and rate</caption>
                <thead>
                  <tr style={{ color: "var(--text-secondary)" }}>
                    <Th>Category</Th>
                    <Th>Rate</Th>
                    <Th align="right">Invoiced</Th>
                    <Th align="right">Credited</Th>
                    <Th align="right">Net supplies</Th>
                    <Th align="right">Net VAT</Th>
                    <Th align="right">Documents</Th>
                  </tr>
                </thead>
                <tbody>
                  {pack.groups.length === 0 ? (
                    <tr className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
                      <Td colSpan={7} muted>
                        Nothing was issued in this period. That is a zero return, not a missing
                        one — file it.
                      </Td>
                    </tr>
                  ) : (
                    pack.groups.map((g) => (
                      <tr
                        key={`${g.taxCategoryCode}/${g.taxRateBasisPoints}`}
                        className="border-t"
                        style={{ borderColor: "var(--border-subtle)" }}
                      >
                        <Td>
                          <span className="font-semibold">{categoryLabel(g.taxCategoryCode)}</span>
                          <span className="ml-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                            {g.taxCategoryCode}
                          </span>
                        </Td>
                        <Td muted>{ratePercent(g.taxRateBasisPoints)}</Td>
                        <Td align="right">{amount(g.invoicedTaxableMinor)}</Td>
                        <Td align="right">{amount(g.creditedTaxableMinor)}</Td>
                        <Td align="right">
                          <strong>{amount(g.netTaxableMinor)}</strong>
                        </Td>
                        <Td align="right">{amount(g.netTaxMinor)}</Td>
                        <Td align="right" muted>
                          {g.invoices + g.creditNotes}
                        </Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* ── Exceptions ───────────────────────────────────────────── */}
            <h2 className="mt-10 text-[18px] font-semibold tracking-tight">
              Documents to look at before filing
            </h2>
            {pack.exceptionCount === 0 ? (
              <p className="prose-body mt-1 max-w-2xl text-[13px]">
                None. Every document in the period carries tax equal to its own taxable amount at
                its own stated rate, a category consistent with its rate, and a supplier TRN.
              </p>
            ) : (
              <>
                <p className="prose-body mt-1 max-w-2xl text-[13px]">
                  {/*
                    The count is its own aggregate over every match, taken before
                    the limit. A list of twenty under a heading that says twenty
                    is how a period with forty-one problems gets filed.
                  */}
                  Showing {pack.exceptions.length} of {pack.exceptionCount}. These do not
                  necessarily change the figures above — they are documents whose own arithmetic or
                  classification does not hold together, and each one is a question an auditor can
                  ask.
                  {pack.exceptionCount > VAT_EXCEPTION_ROWS ? (
                    <>
                      {" "}
                      The rest are in the{" "}
                      <Link
                        href={`/reports/vat/download?from=${from}&to=${to}`}
                        style={{ color: "var(--accent-text)" }}
                      >
                        working papers
                      </Link>
                      , which carry every document in the period.
                    </>
                  ) : null}
                </p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[52rem] border-collapse text-[13px]">
                    <caption className="sr-only">Documents whose figures do not hold together</caption>
                    <thead>
                      <tr style={{ color: "var(--text-secondary)" }}>
                        <Th>Document</Th>
                        <Th>Issued</Th>
                        <Th>What is wrong</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {pack.exceptions.map((e) => (
                        <tr
                          key={`${e.reference}/${e.kind}`}
                          className="border-t"
                          style={{ borderColor: "var(--border-subtle)" }}
                        >
                          <Td>
                            <span className="font-semibold">{e.reference}</span>
                            <span className="ml-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                              {e.documentType === "credit_note" ? "credit note" : "invoice"}
                            </span>
                          </Td>
                          <Td muted>{e.issueDate}</Td>
                          <Td>{e.detail}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ── The working papers ───────────────────────────────────── */}
            <div className="mt-10 max-w-2xl">
              <h2 className="text-[14px] font-semibold">The working papers</h2>
              <p className="prose-body mt-2 text-[13px]">
                One row per document — {pack.documentCount} of them — with the recorded tax, the tax
                recomputed from that document&rsquo;s own taxable amount and rate, the difference
                between them, and the box each document belongs in. Credit notes carry the sign they
                are applied with, so the columns total to the figures above. It is not capped: the
                query runs to exhaustion and the file states its own row count on its last line.
              </p>
              <p className="mt-3 text-[13px]">
                <a
                  href={`/reports/vat/download?from=${from}&to=${to}`}
                  style={{ color: "var(--accent-text)" }}
                >
                  Download the working papers (CSV) &darr;
                </a>
              </p>
            </div>

            <div className="mt-8 max-w-2xl">
              <h2 className="text-[14px] font-semibold">What this page assumes</h2>
              <ul className="prose-body mt-2 space-y-1.5 text-[13px]">
                <li>
                  The <strong>tax point is the issue date</strong> of the invoice or credit note, in{" "}
                  {tenant.timezone}. Where a supply date differs from the issue date, the date of
                  supply can move the tax point — check anything issued near a period boundary.
                </li>
                <li>
                  The <strong>document&rsquo;s own tax category and rate</strong> decide which box it
                  lands in, not its lines. Nothing in this system produces a mixed-rate invoice, and
                  an invoice whose lines disagree with it appears in the exceptions above rather than
                  being split silently between two boxes.
                </li>
                <li>
                  Every figure is a database aggregate over every matching document, not a total of
                  anything shown on this page. Reproduce them from the{" "}
                  <Link href="/reports/export" style={{ color: "var(--accent-text)" }}>
                    accounting export
                  </Link>{" "}
                  or the working papers.
                </li>
                <li>
                  This page reports what was invoiced. It does not file anything, and it is not
                  advice — the return is signed by the taxable person.
                </li>
              </ul>
            </div>

            <p className="mt-8 text-[13px]">
              <Link href="/reports/tax" style={{ color: "var(--accent-text)" }}>
                Corporate tax and the Small Business Relief line &rarr;
              </Link>
            </p>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

function PeriodLink({
  label,
  from,
  to,
  active,
}: {
  label: string;
  from: string;
  to: string;
  active: boolean;
}) {
  return (
    <Link
      href={`/reports/vat?from=${from}&to=${to}`}
      className="rounded-sm px-2 py-0.5"
      style={
        active
          ? { backgroundColor: "var(--accent)", color: "var(--accent-contrast)" }
          : { color: "var(--accent-text)" }
      }
      aria-current={active ? "true" : undefined}
    >
      {label}
    </Link>
  );
}

/**
 * One box on the form.
 *
 * `unavailable` and a zero amount are different renderings on purpose. The
 * whole failure this page is written against is a preparer reading a blank cell
 * as a nil return.
 */
function BoxRow({
  box,
  label,
  value,
  vat,
  note,
  unavailable,
  emphasis,
}: {
  box: string;
  label: string;
  value?: string;
  vat?: string;
  note?: string;
  unavailable?: string;
  emphasis?: boolean;
}) {
  return (
    <tr className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
      <Td>
        <span className="tnum font-semibold">{box}</span>
      </Td>
      <Td>
        <span className={emphasis ? "font-semibold" : undefined}>{label}</span>
        {note ? (
          <span className="block text-[11px]" style={{ color: "var(--text-muted)" }}>
            {note}
          </span>
        ) : null}
        {unavailable ? (
          <span className="block text-[11px]" style={{ color: "var(--status-warning-text)" }}>
            {unavailable}
          </span>
        ) : null}
      </Td>
      <Td align="right">
        {unavailable ? (
          <span className="text-[12px]" style={{ color: "var(--status-warning-text)" }}>
            not produced here
          </span>
        ) : (
          <span className={emphasis ? "font-semibold" : undefined}>{value}</span>
        )}
      </Td>
      <Td align="right">
        {unavailable ? (
          <span className="text-[12px]" style={{ color: "var(--status-warning-text)" }}>
            not produced here
          </span>
        ) : (
          <span className={emphasis ? "font-semibold" : undefined}>{vat}</span>
        )}
      </Td>
    </tr>
  );
}

function categoryLabel(code: string): string {
  if (code === "S") return "Standard-rated";
  if (code === "Z") return "Zero-rated";
  if (code === "E") return "Exempt";
  return code;
}

/** Basis points as a percentage. Integer arithmetic, never a float divide. */
function ratePercent(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = basisPoints % 100;
  return fraction === 0 ? `${whole}%` : `${whole}.${String(fraction).padStart(2, "0")}%`;
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

/**
 * A date out of the query string, or nothing.
 *
 * Shape-checked rather than trusted, so an edited URL falls back to the default
 * period instead of an error page. The domain function checks it again — a
 * caller's validation is not a substitute for the callee's.
 */
function readDate(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
