import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, corporateTaxPack } from "@meridian/db";
import {
  formatMoney,
  tenant,
  SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END,
  SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR,
  type ReliefStanding,
  type TaxPeriodPosition,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Card, Meter, Metric } from "../dashboard-ui";

export const metadata: Metadata = { title: "Corporate tax" };
export const dynamic = "force-dynamic";

/**
 * The corporate tax support pack (`INV-17`).
 *
 * ── WHY THIS SCREEN EXISTS WHEN THE DASHBOARD ALREADY HAS A METER ───────────
 *
 * The meter on `/reports` answers "how is this year going". That is the right
 * question for a weekly screen and it is not the question Small Business Relief
 * asks. Three properties make the relief different from every other figure in
 * the product:
 *
 *  1. It is tested on **revenue**, not profit. A thin year at AED 3.1m breaches
 *     it; a fat year at AED 2.9m does not.
 *  2. It is **elected annually, in the return**. Nobody is told they crossed
 *     the line. The business finds out when the return is being prepared, which
 *     is months after the last invoice that could have been deferred.
 *  3. **One breach disqualifies every later period, permanently.** There is no
 *     way back and no partial relief.
 *
 * Together those mean a single-period view is not enough: a business that
 * crossed AED 3m in 2026 sees a comfortable green meter every January
 * afterwards. So this screen shows every period on record, in order, and says
 * plainly when the relief has already been lost.
 *
 * ── WHAT THIS SCREEN IS NOT ─────────────────────────────────────────────────
 *
 * A tax return. PRD §6.2: this system feeds an accountant, it does not replace
 * one. Every figure here is a revenue measurement the accountant checks against
 * the invoices — which is why the accounting export sits one click away and
 * every number on this page is reproducible from it.
 */
export default async function CorporateTaxPage() {
  const session = await requireSessionWith("reports:read");

  const pack = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => corporateTaxPack(tx),
  );

  const measuredAt = pack.measuredAt.toLocaleString("en-GB", {
    timeZone: tenant.timezone,
    dateStyle: "long",
    timeStyle: "short",
  });

  const current = pack.current;
  // Newest first on the table: the reader is here about this year, and the
  // history is what they scroll to. The pack itself is ordered oldest first,
  // because the breach has to be carried forward in that direction.
  const history = [...pack.periods].reverse();

  return (
    <AppShell session={session} active="dashboard">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Corporate tax</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {measuredAt}
          </p>
        </div>

        <p className="prose-body mt-2 max-w-2xl text-[14px]">
          Revenue by tax period against the AED 3,000,000 Small Business Relief threshold. Revenue
          is <strong>VAT-exclusive</strong> and net of credit notes, measured on the issue date in{" "}
          {tenant.timezone}. Confirm anything you act on with your accountant — this page reports
          what was invoiced, it does not prepare a return.
        </p>

        <StandingBanner pack={pack} />

        {current ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <Card
              title={`This tax period — ${current.period.period}`}
              subtitle={`${current.period.startsOn} to ${current.period.endsOn}, VAT-exclusive`}
              href="/invoices"
              tone={cardTone(current.standing)}
            >
              <Metric
                label="Revenue so far"
                value={formatMoney(current.period.revenueMinor, pack.currency)}
                note={`${current.period.invoices} invoice${current.period.invoices === 1 ? "" : "s"}, ${current.period.creditNotes} credit note${current.period.creditNotes === 1 ? "" : "s"}`}
                emphasis
              />
              <Metric
                label="Invoiced, before credits"
                value={formatMoney(current.period.invoicedMinor, pack.currency)}
              />
              <Metric
                label="Credited back"
                value={formatMoney(current.period.creditedMinor, pack.currency)}
              />

              <div className="mt-5">
                <p
                  className="text-[12px] font-semibold uppercase tracking-wide"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Small Business Relief line
                </p>
                <div className="mt-2">
                  <Meter
                    value={current.period.revenueMinor}
                    max={current.relief.thresholdMinor}
                    currency={pack.currency}
                    tone={current.relief.state}
                  />
                </div>
                <p className="prose-body mt-3 text-[13px]">
                  {current.relief.headroomMinor >= 0 ? (
                    <>
                      <strong>{formatMoney(current.relief.headroomMinor, pack.currency)}</strong> of
                      headroom before the line.
                    </>
                  ) : (
                    <>
                      <strong style={{ color: "var(--status-critical-text)" }}>
                        {formatMoney(-current.relief.headroomMinor, pack.currency)}
                      </strong>{" "}
                      over the line.
                    </>
                  )}{" "}
                  {current.period.elapsedDays} of {current.period.totalDays} days elapsed.
                </p>
              </div>
            </Card>

            <Card
              title="Where this is heading"
              subtitle="A run rate, not a forecast"
              tone={
                current.projectedRevenueMinor !== null &&
                current.projectedRevenueMinor > SMALL_BUSINESS_RELIEF_THRESHOLD_MINOR
                  ? "warning"
                  : "neutral"
              }
            >
              {/*
                The only forward-looking number in the product, and it is here
                rather than on the dashboard because it is the number that makes
                the alert actionable. "AED 1.9m in April" is a fact nobody can
                act on; "on course for AED 3.2m by December" is a decision about
                whether to defer work or invoice in the next period. It is
                straight-line arithmetic over elapsed days and it says so.
              */}
              <Metric
                label="At this rate, by the end of the period"
                value={
                  current.projectedRevenueMinor === null
                    ? null
                    : formatMoney(current.projectedRevenueMinor, pack.currency)
                }
                note={
                  current.projectedRevenueMinor === null
                    ? current.period.complete
                      ? "The period has ended, so the figure above is the actual."
                      : "Too little of the period has elapsed for a run rate to mean anything."
                    : `Revenue to date divided by ${current.period.elapsedDays} days, over ${current.period.totalDays}. Seasonal work will not follow it.`
                }
                emphasis
              />

              <p className="prose-body mt-4 text-[13px]">
                The relief is <strong>elected annually in the return</strong> and tested on revenue
                rather than profit. Crossing AED 3,000,000 once disqualifies every later period
                permanently, so the only useful moment to know is before the last invoice of the
                period is raised.
              </p>
              {current.relief.registrationRequired ? (
                <p className="mt-3 text-[12px]" style={{ color: "var(--status-warning-text)" }}>
                  Turnover has passed AED 1,000,000. For a natural person or sole establishment that
                  triggers corporate tax registration by 31 March of the following year; registering
                  late is AED 10,000.
                </p>
              ) : null}
              <p className="mt-3 text-[12px]" style={{ color: "var(--text-muted)" }}>
                The scheme itself ends with periods finishing after{" "}
                {SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END}.
              </p>
            </Card>
          </div>
        ) : (
          <p className="prose-body mt-6 text-[14px]">
            No tax period could be resolved for today, which should not happen — report it rather
            than working around it.
          </p>
        )}

        {/* ── Every period on record ────────────────────────────────────── */}
        <h2 className="mt-10 text-[18px] font-semibold tracking-tight">Every period on record</h2>
        <p className="prose-body mt-1 max-w-2xl text-[13px]">
          A period with no invoices appears with a revenue of zero rather than being left out — a
          missing row reads as &ldquo;no data&rdquo; and a zero row reads as &ldquo;no
          revenue&rdquo;, and against a threshold those are different statements.
        </p>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[52rem] border-collapse text-[13px]">
            <caption className="sr-only">
              Revenue by tax period against the AED 3,000,000 Small Business Relief threshold
            </caption>
            <thead>
              <tr style={{ color: "var(--text-secondary)" }}>
                <Th>Period</Th>
                <Th>Dates</Th>
                <Th align="right">Invoiced (excl VAT)</Th>
                <Th align="right">Credited (excl VAT)</Th>
                <Th align="right">Revenue (excl VAT)</Th>
                <Th align="right">Headroom</Th>
                <Th>Relief</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr
                  key={p.period.period}
                  className="border-t"
                  style={{ borderColor: "var(--border-subtle)" }}
                >
                  <Td>
                    <span className="font-semibold">{p.period.period}</span>
                    {p.period.complete ? null : (
                      <span className="ml-2 text-[11px]" style={{ color: "var(--text-muted)" }}>
                        in progress
                      </span>
                    )}
                  </Td>
                  <Td muted>
                    {p.period.startsOn} → {p.period.endsOn}
                  </Td>
                  <Td align="right">{formatMoney(p.period.invoicedMinor, pack.currency)}</Td>
                  <Td align="right">{formatMoney(p.period.creditedMinor, pack.currency)}</Td>
                  <Td align="right">
                    <strong>{formatMoney(p.period.revenueMinor, pack.currency)}</strong>
                  </Td>
                  <Td align="right" muted>
                    {formatMoney(p.relief.headroomMinor, pack.currency)}
                  </Td>
                  <Td>
                    <StandingWord position={p} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8 max-w-2xl">
          <h2 className="text-[14px] font-semibold">What this page assumes</h2>
          <ul className="prose-body mt-2 space-y-1.5 text-[13px]">
            <li>
              The tax period is the <strong>Gregorian calendar year</strong> in {tenant.timezone},
              which is the default. A company with a financial year ending on another date is not
              supported here, which is why every row prints its own start and end dates.
            </li>
            <li>
              Revenue is the tax-exclusive amount on <strong>issued</strong> invoices, less credit
              notes, dated by issue date. Drafts are not counted, because a draft is not a document.
            </li>
            <li>
              Every figure is reproducible from the{" "}
              <Link href="/reports/export" style={{ color: "var(--accent-text)" }}>
                accounting export
              </Link>
              , which is what your accountant should be reconciling against.
            </li>
          </ul>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * The one sentence at the top that decides what the reader does next.
 *
 * Ordered by consequence rather than by recency, the same rule the dashboard's
 * attention panel follows: a disqualification that happened two years ago
 * outranks a comfortable figure today, because the comfortable figure is the
 * thing that would otherwise be believed.
 */
function StandingBanner({
  pack,
}: {
  pack: { current: TaxPeriodPosition | null; reliefPermanentlyLost: boolean; currency: string };
}) {
  const current = pack.current;
  if (!current) return null;

  if (current.standing === "disqualified") {
    return (
      <Banner tone="critical" title={`The relief was lost in ${current.disqualifyingPeriod}.`}>
        Revenue crossed AED 3,000,000 in {current.disqualifyingPeriod}, and one breach disqualifies
        every later period permanently. This period is under the line and that does not restore it.
        Do not elect Small Business Relief in the return without confirming that period with your
        accountant.
      </Banner>
    );
  }

  if (current.standing === "breached") {
    return (
      <Banner tone="critical" title="The AED 3,000,000 line has been crossed this period.">
        The relief is gone for {current.period.period} and permanently for every period after it.
        Confirm the figure against the invoices before acting on it — it is computed from issued
        invoices net of credit notes, and a mis-dated invoice moves it.
      </Banner>
    );
  }

  if (current.standing === "unavailable") {
    return (
      <Banner tone="neutral" title="Small Business Relief no longer applies to this period.">
        The scheme covers periods ending on or before {SMALL_BUSINESS_RELIEF_FINAL_PERIOD_END}.
      </Banner>
    );
  }

  if (current.standing === "approaching") {
    return (
      <Banner tone="warning" title="Revenue is approaching the AED 3,000,000 line.">
        {formatMoney(current.relief.headroomMinor, pack.currency)} of headroom, with{" "}
        {current.period.totalDays - current.period.elapsedDays} days of the period left. There is
        still time to decide deliberately — defer work, invoice in the next period, or accept the
        loss of relief knowingly — rather than discover it when the return is prepared.
      </Banner>
    );
  }

  return null;
}

function Banner({
  tone,
  title,
  children,
}: {
  tone: "critical" | "warning" | "neutral";
  title: string;
  children: React.ReactNode;
}) {
  const border =
    tone === "critical"
      ? "var(--status-critical)"
      : tone === "warning"
        ? "var(--status-warning)"
        : "var(--border-strong)";
  const text =
    tone === "critical"
      ? "var(--status-critical-text)"
      : tone === "warning"
        ? "var(--status-warning-text)"
        : "var(--text-primary)";

  return (
    <div
      role="note"
      aria-label={title}
      className="mt-6 rounded-sm border-l-2 py-3 pl-4"
      style={{ borderColor: border, backgroundColor: "var(--surface-raised)" }}
    >
      <p className="text-[15px] font-semibold" style={{ color: text }}>
        {title}
      </p>
      <p className="prose-body mt-1 max-w-2xl text-[13px]">{children}</p>
    </div>
  );
}

/**
 * The standing, as a word.
 *
 * Never as a colour alone. This screen gets printed and forwarded to an
 * accountant, and "disqualified" has to survive a monochrome printer.
 */
function StandingWord({ position }: { position: TaxPeriodPosition }) {
  const label: Record<ReliefStanding, string> = {
    available: "Eligible",
    approaching: "Close to the line",
    breached: "Breached",
    disqualified: `Lost in ${position.disqualifyingPeriod ?? "an earlier period"}`,
    unavailable: "Scheme ended",
  };

  const colour: Record<ReliefStanding, string> = {
    available: "var(--status-success-text)",
    approaching: "var(--status-warning-text)",
    breached: "var(--status-critical-text)",
    disqualified: "var(--status-critical-text)",
    unavailable: "var(--text-muted)",
  };

  return (
    <span className="text-[12px] font-semibold" style={{ color: colour[position.standing] }}>
      {label[position.standing]}
    </span>
  );
}

function cardTone(standing: ReliefStanding): "neutral" | "critical" | "warning" {
  if (standing === "breached" || standing === "disqualified") return "critical";
  if (standing === "approaching") return "warning";
  return "neutral";
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
}: {
  children: React.ReactNode;
  align?: "right";
  muted?: boolean;
}) {
  return (
    <td
      className={`py-2 ${align === "right" ? "tnum text-right" : "text-left"}`}
      style={muted ? { color: "var(--text-muted)" } : undefined}
    >
      {children}
    </td>
  );
}
