import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant } from "@meridian/db";
import { getCandidateDetail, getPipelineBoard } from "@meridian/db/domain";
import {
  AVAILABILITY_LABEL,
  CANDIDATE_GRADE_LABEL,
  CANDIDATE_LOCATION_LABEL,
  DISPOSITION_BY_CODE,
  EXPERIENCE_BAND_LABEL,
  HR16_NOTICE,
  PARSE_STATUS_LABEL,
  SCAN_STATUS_LABEL,
  VISA_STATUS_LABEL,
  VISA_STATUS_PLANNING_NOTE,
  applicationStatusUrl,
  getService,
  type Availability,
  type CandidateGrade,
  type CandidateLocation,
  type ExperienceBand,
  type ParseStatus,
  type ScanStatus,
  type VisaStatus,
} from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { CandidatePanels } from "./panels";
import { ArrowLeft, Warning, CheckCircle } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Candidate" };
export const dynamic = "force-dynamic";

/**
 * Candidate detail (wireframe §5.2).
 *
 * Three things on this screen do not appear on a generic ATS's candidate page,
 * and each is here because the requirement is explicit that its absence is what
 * goes wrong:
 *
 *  * **Certificate expiry, prominently, with expired ones called out.**
 *    `ATS-4`: expiry is the field everyone forgets and it is the one that later
 *    blocks a dispatch under `HR-9`. Finding out at the trade-check stage costs
 *    a phone call; finding out on the morning of a job costs the job.
 *  * **Prior applications from the same person.** `ATS-12`: same person, same
 *    role, again, with the previous outcome surfaced — so nobody re-tests
 *    somebody they trade-tested in March, and nobody rejects for a reason that
 *    has since been fixed.
 *  * **Duplicate suggestions.** `ATS-11`: the loose matcher suggests, a human
 *    decides, and nothing is ever deleted by a merge.
 *
 * What is deliberately absent: any score, ranking, rating or match percentage
 * (`ATS-19`). No column holds one and no panel computes one.
 */
export default async function CandidatePage({
  params,
}: {
  params: Promise<{ applicationId: string }>;
}) {
  const session = await requireSessionWith("recruitment:read");
  const { applicationId } = await params;

  const { candidate, board } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => {
      const detail = await getCandidateDetail(tx, applicationId);
      return {
        candidate: detail,
        board: detail ? await getPipelineBoard(tx, detail.requisitionId) : null,
      };
    },
  );

  if (!candidate) notFound();

  const canWrite = ["owner", "admin", "hr"].includes(session.principal.role);
  const disposition = candidate.dispositionReasonCode
    ? DISPOSITION_BY_CODE[candidate.dispositionReasonCode]
    : undefined;

  return (
    <AppShell session={session} active="recruitment">
      <div className="container-page py-8">
        <Link
          href={`/recruitment/${candidate.requisitionId}`}
          className="inline-flex items-center gap-1.5 text-[14px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={15} aria-hidden />
          Pipeline
        </Link>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
              {candidate.fullName}
            </h1>
            <p className="mt-1.5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
              {getService(candidate.primaryTrade)?.shortName ?? candidate.primaryTrade}
              {" · "}
              {CANDIDATE_GRADE_LABEL[candidate.grade as CandidateGrade] ?? candidate.grade}
              {" · "}
              {EXPERIENCE_BAND_LABEL[candidate.experienceBand as ExperienceBand] ??
                candidate.experienceBand}
              {" · "}
              {CANDIDATE_LOCATION_LABEL[candidate.currentLocation as CandidateLocation] ??
                candidate.currentLocation}
              {" · "}
              {candidate.phone}
              {candidate.email ? ` · ${candidate.email}` : ""}
            </p>
            <p className="tnum mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
              {candidate.reference} · {candidate.roleTitle} ·{" "}
              {candidate.stageName ?? "no stage"} for {daysSince(candidate.stageEnteredAt)} days
              {candidate.availability
                ? ` · available ${(
                    AVAILABILITY_LABEL[candidate.availability as Availability] ??
                    candidate.availability
                  ).toLowerCase()}`
                : ""}
            </p>
          </div>

          <div className="text-right">
            <p
              className="text-[14px] font-semibold"
              style={{
                color:
                  candidate.tone === "red"
                    ? "var(--status-critical-text)"
                    : "var(--text-primary)",
              }}
            >
              {candidate.blockedOn === "us"
                ? `Waiting on us — ${daysSince(candidate.stageEnteredAt)} days`
                : candidate.blockedOn === "candidate"
                  ? "Waiting on the candidate"
                  : candidate.toneLabel}
            </p>
            {candidate.blockedNote ? (
              <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {candidate.blockedNote}
              </p>
            ) : null}
          </div>
        </div>

        {/* ── ATS-6: what the essential-functions answer means ──────────── */}
        {candidate.essentialFunctions === "discuss" ? (
          <div
            className="mt-6 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--surface-sunken)" }}
          >
            This candidate asked to discuss the physical requirements of the role. That is a
            conversation about reasonable adjustment, not a disqualification, and it is not a health
            disclosure — no health information is held on an applicant record. Any medical
            assessment happens after a conditional offer, as part of the statutory visa medical.
          </div>
        ) : null}

        {/* ── ATS-16: where the outcome stands ─────────────────────────── */}
        <OutcomeBanner candidate={candidate} />

        <div className="mt-8 grid gap-10 lg:grid-cols-12">
          {/* ── Left: the record ───────────────────────────────────────── */}
          <div className="space-y-10 lg:col-span-7">
            <section>
              <h2 className="text-[17px] font-semibold">Certifications</h2>
              {candidate.certifications.length === 0 ? (
                <p className="prose-body mt-2 text-[14px]">
                  None recorded. That is not a red flag in this trade — a trade test with a
                  supervisor is the check that matters, and a papers-only filter loses good people.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {candidate.certifications.map((certification) => (
                    <li
                      key={certification.id}
                      className="flex flex-wrap items-start justify-between gap-3 rounded border p-4"
                      style={{
                        backgroundColor: "var(--surface-raised)",
                        borderColor: certification.expired ? "var(--status-critical)" : undefined,
                      }}
                    >
                      <div>
                        <p className="text-[15px] font-medium">{certification.scheme}</p>
                        <p
                          className="mt-0.5 text-[13px]"
                          style={{ color: "var(--text-secondary)" }}
                        >
                          {certification.certificateNo ?? "no number given"}
                          {certification.issuingBody ? ` · ${certification.issuingBody}` : ""}
                          {certification.verifiedAt ? " · verified" : " · not yet verified"}
                        </p>
                      </div>
                      <p
                        className="tnum text-[14px] font-medium"
                        style={{
                          color: certification.expired
                            ? "var(--status-critical-text)"
                            : "var(--text-primary)",
                        }}
                      >
                        {certification.expired ? "EXPIRED " : "Expires "}
                        {certification.expiresOn.toLocaleDateString("en-GB", {
                          timeZone: "Asia/Dubai",
                          month: "short",
                          year: "numeric",
                        })}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              {candidate.certifications.some((c) => c.expired) ? (
                <p className="mt-3 text-[13px]" style={{ color: "var(--status-critical-text)" }}>
                  An expired certificate blocks a dispatch to work that requires it (HR-9). Renewing
                  it before an offer is cheaper than discovering it on the morning of a job.
                </p>
              ) : null}
            </section>

            <section>
              <h2 className="text-[17px] font-semibold">Documents</h2>
              {candidate.documents.length === 0 ? (
                <p className="prose-body mt-2 text-[14px]">
                  No CV, and the form does not require one. Many good tradespeople have none, and a
                  CV-mandatory form filters them out silently — which is the worst kind of filter,
                  because it produces no rejection anybody can measure.
                </p>
              ) : (
                <ul className="mt-3 space-y-2">
                  {candidate.documents.map((document) => (
                    <li
                      key={document.id}
                      className="rounded border p-4"
                      style={{ backgroundColor: "var(--surface-raised)" }}
                    >
                      <p className="text-[15px] font-medium">
                        {document.filename ?? document.kind}
                      </p>
                      <p className="mt-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {SCAN_STATUS_LABEL[document.scanStatus as ScanStatus]} ·{" "}
                        {PARSE_STATUS_LABEL[document.parseStatus as ParseStatus] ??
                          document.parseStatus}{" "}
                        · {Math.round(document.sizeBytes / 1024)} KB
                      </p>
                      {/*
                        `ATS-9`. Downloads are gated on scan status. No virus
                        scanner is contracted for this deployment, so files are
                        recorded as `skipped` — explicitly unscanned rather than
                        stuck pending — and that is said here every time, next
                        to a link that works. The warning is not a substitute
                        for the link and the link is not a reason to drop the
                        warning: a file somebody can open is exactly the file
                        they need telling about.
                      */}
                      {document.scanStatus === "skipped" ? (
                        <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                          Not virus-scanned: no scanner is configured for this deployment. Treat it
                          as untrusted, and never forward it by email.
                        </p>
                      ) : null}
                      {document.downloadable ? (
                        /*
                          A plain link, not a button or a client component. The
                          route sets `Content-Disposition: attachment`, so the
                          browser saves the file rather than navigating to it,
                          and the same route re-checks the scan status — this
                          link is a convenience, never the gate.
                        */
                        <a
                          href={`/recruitment/documents/${document.id}`}
                          className="mt-2 inline-block text-[13px] font-medium hover:underline"
                          style={{ color: "var(--accent-text)" }}
                        >
                          Download {document.filename ?? document.kind}
                        </a>
                      ) : (
                        <p
                          className="mt-2 text-[13px]"
                          style={{ color: "var(--status-critical-text)" }}
                        >
                          Download blocked until the scan completes (SEC-8).
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* ── ATS-12 ─────────────────────────────────────────────── */}
            {candidate.priorApplications.length > 0 ? (
              <section>
                <h2 className="text-[17px] font-semibold">
                  Applied before — {candidate.priorApplications.length}{" "}
                  {candidate.priorApplications.length === 1 ? "time" : "times"}
                </h2>
                <p className="prose-body mt-2 text-[14px]">
                  Surfaced here rather than buried, so nobody re-tests somebody who was tested in
                  March and nobody rejects again for a reason that has since been fixed.
                </p>
                <ul className="mt-3 space-y-2">
                  {candidate.priorApplications.map((prior) => (
                    <li
                      key={prior.reference}
                      className="rounded border p-4 text-[14px]"
                      style={{ backgroundColor: "var(--surface-raised)" }}
                    >
                      <span className="font-medium">{prior.roleTitle}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {" · "}
                        {prior.appliedAt.toLocaleDateString("en-GB", {
                          timeZone: "Asia/Dubai",
                          month: "long",
                          year: "numeric",
                        })}
                        {" · "}
                        {prior.status}
                        {prior.dispositionReasonCode
                          ? ` — ${
                              DISPOSITION_BY_CODE[prior.dispositionReasonCode]?.label ??
                              prior.dispositionReasonCode
                            }`
                          : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* ── ATS-5 ──────────────────────────────────────────────── */}
            <section>
              <h2 className="text-[17px] font-semibold">Visa and permit</h2>
              <p className="prose-body mt-2 text-[14px]">
                Asked at the Trade Check stage, of every shortlisted candidate, uniformly. Never on
                the public form, never a filter, and used only to plan the permit and the start
                date.
              </p>
              {candidate.visaStatus ? (
                <div
                  className="mt-3 rounded border p-4"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <p className="text-[15px] font-medium">
                    {VISA_STATUS_LABEL[candidate.visaStatus as VisaStatus] ?? candidate.visaStatus}
                  </p>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {VISA_STATUS_PLANNING_NOTE[candidate.visaStatus as VisaStatus]}
                    {candidate.visaCurrentSponsor
                      ? ` Current sponsor: ${candidate.visaCurrentSponsor}.`
                      : ""}
                  </p>
                </div>
              ) : null}
            </section>

            {/* ── ATS-11 ─────────────────────────────────────────────── */}
            {candidate.duplicates.length > 0 ? (
              <section>
                <h2 className="text-[17px] font-semibold">Possibly the same person</h2>
                <p className="prose-body mt-2 text-[14px]">
                  Matched loosely — phone (compared on local digits, ignoring the country code) or
                  email. A suggestion, never a link: merging two brothers who share a phone is
                  expensive to undo and easy not to notice. The older profile survives a merge, and
                  nothing is deleted.
                </p>
                <ul className="mt-3 space-y-2">
                  {candidate.duplicates.map((duplicate) => (
                    <li
                      key={duplicate.candidateId}
                      className="rounded border p-4 text-[14px]"
                      style={{ backgroundColor: "var(--surface-raised)" }}
                    >
                      <span className="font-medium">{duplicate.fullName}</span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {" · "}
                        {duplicate.phone}
                        {duplicate.email ? ` · ${duplicate.email}` : ""}
                        {" · matched on "}
                        {duplicate.matchedOn}
                        {" · "}
                        {duplicate.applications} application
                        {duplicate.applications === 1 ? "" : "s"}
                        {" · first seen "}
                        {duplicate.createdAt.toLocaleDateString("en-GB", {
                          timeZone: "Asia/Dubai",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {/* ── The feed ───────────────────────────────────────────── */}
            <section>
              <h2 className="text-[17px] font-semibold">Activity</h2>
              <ol className="mt-3 space-y-2">
                {candidate.events.map((event) => (
                  <li key={event.id} className="flex gap-4 text-[14px]">
                    <span
                      className="tnum w-[120px] shrink-0"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {event.occurredAt.toLocaleString("en-GB", {
                        timeZone: "Asia/Dubai",
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <span>
                      {event.eventType.replace(/_/g, " ")}
                      {event.note ? (
                        <span style={{ color: "var(--text-secondary)" }}> — {event.note}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          </div>

          {/* ── Right: what to do next ─────────────────────────────────── */}
          <div className="lg:col-span-5">
            {canWrite ? (
              <CandidatePanels
                applicationId={candidate.applicationId}
                candidateId={candidate.candidateId}
                candidateFirstName={candidate.fullName.split(" ")[0] ?? candidate.fullName}
                candidateEmail={candidate.email}
                reference={candidate.reference}
                roleTitle={candidate.roleTitle}
                statusToken={candidate.statusToken}
                status={candidate.status}
                currentStageId={candidate.stageId}
                stageType={candidate.stageType}
                blockedOn={candidate.blockedOn}
                visaStatus={candidate.visaStatus}
                outcomeMessage={candidate.outcomeMessage}
                outcomeScheduledAt={candidate.outcomeScheduledAt?.toISOString() ?? null}
                outcomeSentAt={candidate.outcomeSentAt?.toISOString() ?? null}
                stages={board?.stages ?? []}
              />
            ) : (
              <p className="prose-body text-[14px]">
                Your role can read this pipeline but not change it.
              </p>
            )}

            <p
              className="mt-8 rounded-sm p-4 text-[13px]"
              style={{ backgroundColor: "var(--surface-sunken)" }}
            >
              {HR16_NOTICE}
            </p>

            <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
              This candidate&rsquo;s own view:{" "}
              <span className="break-all">{applicationStatusUrl(candidate.statusToken)}</span>. They
              see the same stage and the same blocked-on state you do.
            </p>

            {disposition ? (
              <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
                Archived as &ldquo;{disposition.label}&rdquo;.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function daysSince(date: Date): number {
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86_400_000));
}

/**
 * Where the outcome stands, in one line, at the top.
 *
 * Four distinct states, and each one needs a different thing from the reader:
 * sent (nothing), scheduled (a chance to cancel), composed-and-waiting (press
 * send), or archived with nothing scheduled at all (the failure).
 */
function OutcomeBanner({
  candidate,
}: {
  candidate: {
    status: string;
    outcomeSentAt: Date | null;
    outcomeScheduledAt: Date | null;
    outcomeMessage: string | null;
    outcomeDueAt: Date;
  };
}) {
  if (candidate.outcomeSentAt) {
    return (
      <div
        className="mt-6 flex items-start gap-3 rounded-sm p-4 text-[14px]"
        style={{ backgroundColor: "var(--surface-sunken)" }}
      >
        <CheckCircle
          size={18}
          weight="fill"
          aria-hidden
          className="mt-0.5 shrink-0"
          style={{ color: "var(--accent)" }}
        />
        <span>
          Outcome sent{" "}
          {candidate.outcomeSentAt.toLocaleDateString("en-GB", {
            timeZone: "Asia/Dubai",
            day: "numeric",
            month: "long",
          })}
          . This applicant has been told.
        </span>
      </div>
    );
  }

  if (candidate.status === "active") {
    const overdue = candidate.outcomeDueAt.getTime() < Date.now();
    return (
      <div
        className="mt-6 flex items-start gap-3 rounded-sm p-4 text-[14px]"
        style={{
          backgroundColor: overdue ? "var(--status-critical-wash)" : "var(--surface-sunken)",
        }}
      >
        {overdue ? (
          <Warning
            size={18}
            weight="fill"
            aria-hidden
            className="mt-0.5 shrink-0"
            style={{ color: "var(--status-critical-text)" }}
          />
        ) : null}
        <span>
          {overdue ? "Past the date this applicant was promised an answer — " : "Promised an answer by "}
          {candidate.outcomeDueAt.toLocaleDateString("en-GB", {
            timeZone: "Asia/Dubai",
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
          .{overdue ? " Decide, or tell them where it stands." : ""}
        </span>
      </div>
    );
  }

  return (
    <div
      className="mt-6 flex items-start gap-3 rounded-sm p-4 text-[14px]"
      style={{
        backgroundColor: candidate.outcomeScheduledAt
          ? "var(--surface-sunken)"
          : "var(--status-critical-wash)",
      }}
    >
      <Warning
        size={18}
        weight="fill"
        aria-hidden
        className="mt-0.5 shrink-0"
        style={{
          color: candidate.outcomeScheduledAt
            ? "var(--text-secondary)"
            : "var(--status-critical-text)",
        }}
      />
      <span>
        {candidate.outcomeScheduledAt
          ? `Outcome message goes out ${candidate.outcomeScheduledAt.toLocaleString("en-GB", {
              timeZone: "Asia/Dubai",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}. Cancellable until then (ATS-15).`
          : candidate.outcomeMessage
            ? "The outcome message is written and waiting for a person to send it. An automated rejection is not permitted after a human has spoken to this candidate (ATS-15)."
            : "Archived with no outcome message. This applicant has not been told anything, and stays on the owed list until they are."}
      </span>
    </div>
  );
}
