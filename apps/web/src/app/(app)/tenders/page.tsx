import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, tenderQueue, listTenderSources } from "@meridian/db";
import {
  formatMoney,
  tenderUrgency,
  tenderDeadlineNote,
  TENDER_OUTCOME_LABEL,
  type TenderOutcome,
  type TenderUrgency,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { RecordTenderPanel } from "./tender-forms";

export const metadata: Metadata = { title: "Tenders" };
export const dynamic = "force-dynamic";

/**
 * The tender queue (`CON-11`).
 *
 * ── WHY THERE IS NO SORT CONTROL ON THIS PAGE ───────────────────────────────
 *
 * `CON-11`: *deadline-driven, not stage-driven — a tender queue sorts by days
 * until deadline, always.* Every other list in this application offers a sort,
 * and this one deliberately does not, because the sort people would reach for
 * is "newest first" — which buries a tender closing on Thursday under three
 * recorded yesterday. `tenderQueue` takes no sort argument either, so the
 * absence is structural rather than a decision this page made.
 *
 * An overdue tender sits at the top with its days negative and stays there
 * until somebody records what happened to it. It does not quietly drop off:
 * the point of the queue is that a missed deadline is visible, and a missed
 * deadline that disappears is the failure the queue exists to prevent.
 */

const URGENCY_STYLE: Readonly<Record<TenderUrgency, { colour: string; background: string }>> = {
  overdue: { colour: "var(--status-critical-text)", background: "var(--status-critical-wash)" },
  critical: { colour: "var(--status-critical-text)", background: "var(--status-critical-wash)" },
  soon: { colour: "var(--status-warning-text)", background: "var(--status-warning-wash)" },
  ahead: { colour: "var(--text-secondary)", background: "var(--surface-sunken)" },
};

function DeadlineChip({ daysRemaining }: { daysRemaining: number }) {
  const urgency = tenderUrgency(daysRemaining);
  const style = URGENCY_STYLE[urgency];

  return (
    <span
      className="tnum inline-flex items-center rounded-sm px-2 py-0.5 text-[12px] font-medium"
      style={{ color: style.colour, backgroundColor: style.background }}
    >
      {tenderDeadlineNote(daysRemaining)}
    </span>
  );
}

/** `2026-09-18` reads as a database row; `18 Sep 2026` reads as a deadline. */
function readableDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
  });
}

export default async function TendersPage({
  searchParams,
}: {
  searchParams: Promise<{ history?: string }>;
}) {
  const session = await requireSessionWith("contracts:read");
  const canWrite = can(session.principal, "contracts:write");
  const showHistory = (await searchParams).history === "1";

  const [queue, sources] = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => [
      await tenderQueue(tx, { includeClosed: showHistory }),
      await listTenderSources(tx, { activeOnly: true }),
    ],
  );

  const open = queue.filter((t) => t.outcome === "pending");
  const overdue = open.filter((t) => t.daysRemaining < 0);
  const critical = open.filter((t) => t.daysRemaining >= 0 && t.daysRemaining <= 7);

  return (
    <AppShell session={session} active="tenders">
      <div className="container-page py-8">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Tenders</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {open.length} open
            {overdue.length > 0 ? ` · ${overdue.length} past the closing date` : ""}
            {critical.length > 0 ? ` · ${critical.length} closing within a week` : ""}
          </p>
        </div>

        <p className="prose-body mt-2 max-w-3xl text-[14px]">
          Sorted by how many days are left, always. A tender is not a lead: nothing anybody does
          moves the closing date, and a bid finished the day after is worth nothing. An overdue
          tender stays at the top of this list until somebody records what happened to it.
        </p>

        {queue.length === 0 ? (
          <div
            className="mt-8 rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <p className="text-[14px] font-medium">No tenders are recorded.</p>
            <p className="prose-body mt-2 text-[14px]">
              OA work is won by being on an approved-vendor list before budget season. Record the
              next invitation here the day it arrives &mdash; the deadline is the only field that
              cannot wait.
            </p>
          </div>
        ) : (
          <ul
            className="mt-8 divide-y rounded border"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            {queue.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 p-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium">
                    <Link href={`/tenders/${t.id}`} style={{ color: "var(--accent-text)" }}>
                      {t.title}
                    </Link>
                    <span className="tnum font-normal" style={{ color: "var(--text-muted)" }}>
                      {" "}
                      &middot; {t.reference}
                    </span>
                  </p>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    {t.issuingBody} &middot; {t.sourceLabel}
                    {t.budgetCycle ? ` · budget cycle ${t.budgetCycle}` : ""}
                    {t.propertyCount > 0
                      ? ` · ${t.propertyCount} building${t.propertyCount === 1 ? "" : "s"}`
                      : " · no buildings in scope yet"}
                  </p>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                    Closes {readableDay(t.submissionDeadline)}
                    {t.submittedOn ? ` · submitted ${readableDay(t.submittedOn)}` : " · not yet submitted"}
                    {t.packPreparedOn ? ` · pack assembled ${readableDay(t.packPreparedOn)}` : ""}
                  </p>
                </div>

                <div className="flex flex-col items-end gap-1.5">
                  {t.outcome === "pending" ? (
                    <DeadlineChip daysRemaining={t.daysRemaining} />
                  ) : (
                    <span className="text-[12px] font-medium">
                      {TENDER_OUTCOME_LABEL[t.outcome as TenderOutcome] ?? t.outcome}
                      {t.outcomeReasonLabel ? ` — ${t.outcomeReasonLabel}` : ""}
                    </span>
                  )}
                  {t.bidValueMinor !== null ? (
                    <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                      Bid {formatMoney(t.bidValueMinor, t.currency)}
                    </span>
                  ) : null}
                  {t.competitorsKnown !== null ? (
                    <span className="tnum text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {t.competitorsKnown} other bidder{t.competitorsKnown === 1 ? "" : "s"} known
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-4 text-[13px]">
          <Link
            href={showHistory ? "/tenders" : "/tenders?history=1"}
            style={{ color: "var(--accent-text)" }}
          >
            {showHistory ? "Show only open tenders" : "Show decided tenders too"}
          </Link>
        </p>

        {canWrite ? (
          <div className="mt-10">
            <RecordTenderPanel
              sources={sources.map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
        ) : (
          <p className="mt-10 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Your role can read the tender queue but not add to it.
          </p>
        )}
      </div>
    </AppShell>
  );
}
