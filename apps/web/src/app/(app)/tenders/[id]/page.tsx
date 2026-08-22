import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, isNull, sql } from "drizzle-orm";
import {
  withTenant,
  getTender,
  listTenderOutcomeReasons,
  tenderPackInputs,
  schema,
} from "@meridian/db";
import {
  formatMoney,
  toDecimalString,
  tenderUrgency,
  tenderDeadlineNote,
  assertTenderPackRenderable,
  tenderPackWarnings,
  TenderPackNotRenderableError,
  TENDER_OUTCOME_LABEL,
  type TenderOutcome,
} from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { TenderDetailForm, SubmitTenderForm, CloseTenderForm } from "../tender-forms";

export const metadata: Metadata = { title: "Tender" };
export const dynamic = "force-dynamic";

/**
 * One tender, and the pack it can produce (`CON-11`, `CON-12`).
 *
 * ── WHY THE PACK'S REFUSAL IS ON THE SCREEN AND NOT ONLY IN THE DOWNLOAD ────
 *
 * The download route refuses with the reasons, which is correct and is three
 * days too late. `CON-12` exists because a bid gets disqualified for evidence
 * nobody checked, and a refusal that only appears when somebody presses the
 * button on the last afternoon has reproduced the problem in software.
 *
 * So this page runs the same gate on load and prints what is missing next to
 * the deadline. It costs one read of the register per page view and it turns
 * "your insurance certificate lapsed" from a discovery into a task with three
 * weeks left to do it in.
 */

function readableDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
  });
}

export default async function TenderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("contracts:read");
  const canWrite = can(session.principal, "contracts:write");
  const { id } = await params;

  const data = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const tender = await getTender(tx, id);
      if (!tender) return null;

      const reasons = await listTenderOutcomeReasons(tx, { activeOnly: true });

      const properties = await tx
        .select({
          id: schema.properties.id,
          name: schema.properties.name,
          city: schema.properties.city,
          assetCount: sql<number>`(
            select count(*)::int from ${schema.assets}
             where ${schema.assets.propertyId} = ${schema.properties.id}
               and ${schema.assets.deletedAt} is null)`,
        })
        .from(schema.properties)
        .where(and(isNull(schema.properties.deletedAt)))
        .orderBy(schema.properties.name);

      const today = (
        (await tx.execute<{ today: string }>(
          sql`select to_char(current_date, 'YYYY-MM-DD') as today`,
        )) as unknown as { today: string }[]
      )[0]?.today;

      // The same gate the download runs, run here so the answer arrives while
      // there is still time to act on it.
      let packProblems: readonly string[] = [];
      let packWarnings: readonly string[] = [];
      try {
        const inputs = await tenderPackInputs(tx, id);
        packWarnings = tenderPackWarnings(assertTenderPackRenderable(inputs.document));
      } catch (error) {
        if (error instanceof TenderPackNotRenderableError) {
          packProblems = error.problems;
        } else {
          throw error;
        }
      }

      return { tender, reasons, properties, today: today ?? "", packProblems, packWarnings };
    },
  );

  if (!data) notFound();

  const { tender, reasons, properties, today, packProblems, packWarnings } = data;
  const open = tender.outcome === "pending";
  const urgency = tenderUrgency(tender.daysRemaining);

  return (
    <AppShell session={session} active="tenders">
      <div className="container-page py-8">
        <p className="text-[13px]">
          <Link href="/tenders" style={{ color: "var(--accent-text)" }}>
            &larr; Tender queue
          </Link>
        </p>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{tender.title}</h1>
          <p className="tnum text-[13px]" style={{ color: "var(--text-muted)" }}>
            {tender.reference}
          </p>
        </div>

        <p className="mt-2 text-[14px]" style={{ color: "var(--text-secondary)" }}>
          {tender.issuingBody} &middot; {tender.sourceLabel}
          {tender.portalReference ? ` · ${tender.portalReference}` : ""}
        </p>

        <p
          className="mt-3 text-[14px] font-medium"
          style={{
            color:
              urgency === "overdue" || urgency === "critical"
                ? "var(--status-critical-text)"
                : urgency === "soon"
                  ? "var(--status-warning-text)"
                  : "var(--text-secondary)",
          }}
        >
          {open
            ? `Closes ${readableDay(tender.submissionDeadline)} — ${tenderDeadlineNote(tender.daysRemaining).toLowerCase()}`
            : `${TENDER_OUTCOME_LABEL[tender.outcome as TenderOutcome] ?? tender.outcome}${
                tender.outcomeReasonLabel ? ` — ${tender.outcomeReasonLabel}` : ""
              }${tender.decidedOn ? ` on ${readableDay(tender.decidedOn)}` : ""}`}
        </p>
        {tender.outcomeNote ? (
          <p className="prose-body mt-1 text-[13px]">{tender.outcomeNote}</p>
        ) : null}

        {/* ── The pack (CON-12) ───────────────────────────────────────────── */}
        <section
          className="mt-8 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="text-lg font-semibold tracking-tight">Tender pack</h2>
          <p className="prose-body mt-2 max-w-3xl text-[14px]">
            Assembled from live data every time: the scope above, the plant registered at the
            buildings in scope, the rate card in effect today, and the company accreditation
            register with the certificates attached as pages. Nothing here is a stored copy, which
            is why it cannot go out of date &mdash; and why it refuses rather than going out
            incomplete.
          </p>

          {packProblems.length > 0 ? (
            <div
              className="mt-4 rounded border p-4"
              style={{
                backgroundColor: "var(--status-critical-wash)",
                borderColor: "var(--status-critical)",
              }}
            >
              <p className="text-[14px] font-medium" style={{ color: "var(--status-critical-text)" }}>
                This pack will not assemble yet.
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px]">
                {packProblems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              <p className="mt-3 text-[13px]">
                A pack containing a lapsed certificate is worse than one that refuses to build.
                Fix the entries above on the{" "}
                <Link href="/workforce/accreditations" style={{ color: "var(--accent-text)" }}>
                  company accreditation register
                </Link>{" "}
                and this page will say so.
              </p>
            </div>
          ) : (
            <>
              <p className="mt-4">
                <a href={`/tenders/${tender.id}/pack`} className="btn btn-primary">
                  Assemble and download the pack
                </a>
              </p>
              {packWarnings.length > 0 ? (
                <div className="mt-4">
                  <p className="text-[13px] font-medium" style={{ color: "var(--status-warning-text)" }}>
                    What the pack says it does not have:
                  </p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px]">
                    {packWarnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}

          {tender.packs.length > 0 ? (
            <div className="mt-6">
              <p className="text-[13px] font-medium">Packs already assembled</p>
              <ul className="mt-2 space-y-1 text-[12px]" style={{ color: "var(--text-muted)" }}>
                {tender.packs.map((p) => (
                  <li key={p.id} className="tnum">
                    {readableDay(p.preparedOn)} &middot; {p.pageCount} pages &middot; SHA-256{" "}
                    {p.sha256.slice(0, 16)}…
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px]" style={{ color: "var(--text-muted)" }}>
                One pack per day. What was submitted stays reproducible exactly as submitted, even
                after a licence is renewed or a rate moves.
              </p>
            </div>
          ) : null}
        </section>

        {/* ── The facts (CON-11) ──────────────────────────────────────────── */}
        <section className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
            <p className="text-[13px] font-medium">The bid</p>
            <dl className="mt-2 space-y-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
              <div className="flex justify-between gap-4">
                <dt>Bid value</dt>
                <dd className="tnum">
                  {tender.bidValueMinor === null
                    ? "Not set"
                    : formatMoney(tender.bidValueMinor, tender.currency)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Submitted</dt>
                <dd className="tnum">
                  {tender.submittedOn ? readableDay(tender.submittedOn) : "Not yet"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Decision expected</dt>
                <dd className="tnum">
                  {tender.decisionDate ? readableDay(tender.decisionDate) : "Not stated"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Budget cycle</dt>
                <dd>{tender.budgetCycle ?? "Not recorded"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt>Competitors known</dt>
                <dd className="tnum">
                  {tender.competitorsKnown === null ? "Unknown" : tender.competitorsKnown}
                </dd>
              </div>
            </dl>
            {tender.competitorNotes ? (
              <p className="prose-body mt-3 text-[13px]">{tender.competitorNotes}</p>
            ) : null}
          </div>

          <div className="rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
            <p className="text-[13px] font-medium">Buildings in scope</p>
            {tender.properties.length === 0 ? (
              <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                None yet. The pack needs at least one, and the plant registered at it is what an
                evaluator scores.
              </p>
            ) : (
              <ul className="mt-2 space-y-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {tender.properties.map((p) => (
                  <li key={p.propertyId} className="flex justify-between gap-4">
                    <span>{p.name}</span>
                    <span className="tnum">
                      {p.assetCount} asset{p.assetCount === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {canWrite && open ? (
          <>
            <section
              className="mt-8 rounded border p-6"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <h2 className="text-lg font-semibold tracking-tight">Edit the tender</h2>
              <TenderDetailForm
                tenderId={tender.id}
                defaults={{
                  title: tender.title,
                  issuingBody: tender.issuingBody,
                  submissionDeadline: tender.submissionDeadline,
                  decisionDate: tender.decisionDate,
                  budgetCycle: tender.budgetCycle,
                  portalReference: tender.portalReference,
                  scopeOfWork: tender.scopeOfWork,
                  competitorsKnown: tender.competitorsKnown,
                  competitorNotes: tender.competitorNotes,
                  bidValue:
                    tender.bidValueMinor === null ? null : toDecimalString(tender.bidValueMinor),
                }}
                properties={properties.map((p) => ({
                  value: p.id,
                  label: `${p.name} — ${p.city}`,
                  assetCount: Number(p.assetCount),
                }))}
                selectedPropertyIds={tender.properties.map((p) => p.propertyId)}
              />
            </section>

            <section className="mt-8 grid gap-6 sm:grid-cols-2">
              <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h2 className="text-[15px] font-semibold tracking-tight">The bid went in</h2>
                <p className="prose-body mt-1 text-[13px]">
                  A fact with a date, not an outcome. It stays in the queue until the issuer decides.
                </p>
                <SubmitTenderForm tenderId={tender.id} today={today} />
              </div>

              <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h2 className="text-[15px] font-semibold tracking-tight">Record the outcome</h2>
                <p className="prose-body mt-1 text-[13px]">
                  A loss needs a reason. &ldquo;We lost&rdquo; is a number; &ldquo;we lost four to an
                  incomplete submission&rdquo; is the sentence that funds fixing the pack.
                </p>
                <CloseTenderForm
                  tenderId={tender.id}
                  today={today}
                  reasons={reasons.map((r) => ({
                    value: r.id,
                    label: r.label,
                    appliesTo: r.appliesTo,
                  }))}
                />
              </div>
            </section>
          </>
        ) : null}

        {tender.scopeOfWork ? (
          <section className="mt-8">
            <h2 className="text-[15px] font-semibold tracking-tight">Scope of work</h2>
            <p className="prose-body mt-2 max-w-3xl whitespace-pre-wrap text-[14px]">
              {tender.scopeOfWork}
            </p>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}
