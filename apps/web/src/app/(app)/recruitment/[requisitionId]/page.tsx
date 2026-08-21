import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@meridian/db";
import { getPipelineBoard, listStaff } from "@meridian/db/domain";
import {
  CANDIDATE_GRADE_LABEL,
  EXPERIENCE_BAND_LABEL,
  REQUISITION_STATUS_LABEL,
  getService,
  type CandidateGrade,
  type ExperienceBand,
  type RequisitionStatus,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { RequisitionControls } from "./requisition-controls";
import { ArrowLeft, Warning } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Pipeline" };
export const dynamic = "force-dynamic";

/**
 * The pipeline board (`ATS-7`, `ATS-8`, wireframe §5.1).
 *
 * ── THE BLOCKED-ON INDICATOR IS THE SCREEN ──────────────────────────────────
 *
 * `ATS-8` calls it "the cheapest high-value feature in the module" and it is
 * right: in a market where a good AC technician is holding three offers, *who
 * is blocking this* is the only question worth putting on a card. Green is up
 * to date, amber is waiting on the candidate, red is waiting on us — and where
 * nobody has recorded anything, time-in-stage stands in, because a board where
 * every untouched card is green is worse than no board at all.
 *
 * **Never colour alone.** Every card carries the words as well as the tone.
 * That is a `D-` accessibility rule here and it is also the practical one: this
 * screen is read on a laptop in a portacabin with the brightness down.
 */
export default async function PipelinePage({
  params,
}: {
  params: Promise<{ requisitionId: string }>;
}) {
  const session = await requireSessionWith("recruitment:read");
  const { requisitionId } = await params;

  const { board, staff } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      board: await getPipelineBoard(tx, requisitionId),
      staff: await listStaff(tx),
    }),
  );

  if (!board) notFound();

  const canWrite = ["owner", "admin", "hr"].includes(session.principal.role);
  const { requisition } = board;

  /*
    `ATS-1`. The name, not the uuid.

    Shown even when it is null, and said in words: a vacancy nobody's name is on
    is the one that stays open for two months because chasing it is nobody's
    job. That is worth a line of text on the screen where it is being chased.
  */
  const hiringManager = requisition.hiringManagerUserId
    ? (staff.find((member) => member.userId === requisition.hiringManagerUserId)?.fullName ??
      "somebody who is no longer on the staff list")
    : null;

  return (
    <AppShell session={session} active="recruitment">
      <div className="container-page py-8">
        <Link
          href="/recruitment"
          className="inline-flex items-center gap-1.5 text-[14px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={15} aria-hidden />
          Recruitment
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-5">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
                {requisition.title}
              </h1>
              <span
                className="rounded-sm px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                style={{
                  backgroundColor:
                    requisition.status === "open" ? "var(--accent-wash)" : "var(--surface-sunken)",
                  color:
                    requisition.status === "open"
                      ? "var(--accent-text)"
                      : "var(--text-secondary)",
                }}
              >
                {REQUISITION_STATUS_LABEL[requisition.status as RequisitionStatus] ??
                  requisition.status}
              </span>
            </div>
            <p className="mt-1.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
              {requisition.reference} ·{" "}
              {getService(requisition.trade)?.shortName ?? requisition.trade} ·{" "}
              {CANDIDATE_GRADE_LABEL[requisition.grade as CandidateGrade] ?? requisition.grade} ·{" "}
              {requisition.headcount}{" "}
              {requisition.headcount === 1 ? "position" : "positions"} · {board.cards.length} live
              {board.cards.length === 1 ? " applicant" : " applicants"}
              {requisition.closesAt
                ? ` · closes ${requisition.closesAt.toLocaleDateString("en-GB", {
                    timeZone: "Asia/Dubai",
                    day: "numeric",
                    month: "short",
                  })}`
                : ""}
            </p>
            <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
              {hiringManager
                ? `Hiring manager: ${hiringManager}`
                : "No hiring manager named — nobody owns chasing this one."}
            </p>
          </div>

          {canWrite ? (
            <RequisitionControls
              requisitionId={requisition.id}
              status={requisition.status}
              approved={requisition.approvedAt !== null}
              publicSlug={requisition.publicSlug}
              liveApplicants={board.cards.length}
            />
          ) : null}
        </div>

        {/* ── ATS-16, on the board itself ──────────────────────────────── */}
        {board.owedAnOutcome > 0 ? (
          <div
            role="status"
            className="mt-6 flex items-start gap-3 rounded-sm p-4"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
          >
            <Warning
              size={18}
              weight="fill"
              aria-hidden
              className="mt-0.5 shrink-0"
              style={{ color: "var(--status-critical-text)" }}
            />
            <p className="text-[14px]">
              <strong>{board.owedAnOutcome}</strong> archived{" "}
              {board.owedAnOutcome === 1 ? "applicant has" : "applicants have"} not been told the
              outcome yet. The full list, with phone numbers, is on{" "}
              <Link href="/recruitment" className="underline">
                the recruitment page
              </Link>
              .
            </p>
          </div>
        ) : null}

        {/* ── The board ────────────────────────────────────────────────── */}
        <div className="mt-8 overflow-x-auto">
          <div
            className="grid min-w-[900px] gap-px rounded border"
            style={{
              gridTemplateColumns: `repeat(${board.stages.length}, minmax(0, 1fr))`,
              backgroundColor: "var(--border-hairline)",
            }}
          >
            {board.stages.map((stage) => {
              const cards = board.cards.filter((card) => card.stageId === stage.id);
              return (
                <section
                  key={stage.id}
                  className="p-3"
                  style={{ backgroundColor: "var(--surface-sunken)" }}
                >
                  <h2 className="px-1 pb-3 text-[12px] font-semibold uppercase tracking-wide">
                    {stage.name}
                    <span className="ml-1.5 font-normal" style={{ color: "var(--text-muted)" }}>
                      ({cards.length})
                    </span>
                  </h2>

                  <ul className="space-y-2">
                    {cards.map((card) => (
                      <li key={card.applicationId}>
                        <Link
                          href={`/recruitment/candidate/${card.applicationId}`}
                          className="block rounded-sm border p-3 transition-colors hover:border-[var(--accent)]"
                          style={{
                            backgroundColor: "var(--surface-raised)",
                            borderLeftWidth: 3,
                            borderLeftColor: toneColour(card.tone),
                          }}
                        >
                          <p className="truncate text-[14px] font-medium">{card.fullName}</p>
                          <p
                            className="mt-0.5 text-[12px]"
                            style={{ color: "var(--text-secondary)" }}
                          >
                            {EXPERIENCE_BAND_LABEL[card.experienceBand as ExperienceBand] ??
                              card.experienceBand}
                            {" · "}
                            {CANDIDATE_GRADE_LABEL[card.grade as CandidateGrade] ?? card.grade}
                          </p>

                          {/*
                            The words, always, next to the colour. A dot alone
                            is a legend somebody has to remember, and half the
                            people reading this screen will not.
                          */}
                          <p
                            className="mt-2 text-[12px] font-medium"
                            style={{ color: toneTextColour(card.tone) }}
                          >
                            {card.blockedOn === "us"
                              ? `Waiting on us · ${card.daysInStage}d`
                              : card.blockedOn === "candidate"
                                ? `Waiting on them · ${card.daysInStage}d`
                                : card.toneLabel}
                          </p>

                          {card.expiredCertifications > 0 ? (
                            <p
                              className="mt-1.5 text-[12px]"
                              style={{ color: "var(--status-critical-text)" }}
                            >
                              {card.expiredCertifications} expired certificate
                              {card.expiredCertifications === 1 ? "" : "s"}
                            </p>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>

        <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
          Green: up to date. Amber: waiting on the candidate. Red: waiting on us — nobody has acted
          and the clock is running. Where nothing structured has been recorded, time in stage stands
          in: under 2 days green, 2–5 amber, 5+ red.
        </p>

        {/* ── Archived, with reasons ───────────────────────────────────── */}
        {board.archivedTotal > 0 ? (
          <section className="mt-12">
            <h2 className="text-[19px] font-semibold">Archived — {board.archivedTotal}</h2>
            <p className="prose-body mt-2 text-[14px]">
              Always with a reason. Free text here would destroy the only output the question was
              asked for — &ldquo;too expensive&rdquo; typed five ways is five categories with one
              person in each.
            </p>
            <ul className="mt-4 flex flex-wrap gap-2">
              {board.archived.map((entry) => (
                <li
                  key={entry.dispositionReasonCode}
                  className="rounded-sm border px-3 py-1.5 text-[13px]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  {entry.label}{" "}
                  <span className="tnum font-semibold">({entry.count})</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </AppShell>
  );
}

/*
 * The design system's own status tokens, not a local palette.
 *
 * They exist in both themes and both are covered by the contrast gate, so an
 * amber card stays legible in dark mode without anybody re-checking. The `-text`
 * variants are the ones that passed against a wash; the bare token is a border
 * colour and is not used for text anywhere below.
 */
function toneColour(tone: "green" | "amber" | "red"): string {
  if (tone === "red") return "var(--status-critical)";
  if (tone === "amber") return "var(--status-warning)";
  return "var(--status-success)";
}

function toneTextColour(tone: "green" | "amber" | "red"): string {
  if (tone === "red") return "var(--status-critical-text)";
  if (tone === "amber") return "var(--status-warning-text)";
  // Green is the quiet state. Rendering it in a success colour would give the
  // most common card on the board the most attention, which is backwards.
  return "var(--text-muted)";
}
