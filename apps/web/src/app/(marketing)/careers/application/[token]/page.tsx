import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  BLOCKED_ON_LABEL,
  INTERVIEW_KIND_LABEL,
  telLink,
  tenant,
  whatsappLink,
  type BlockedOn,
  type InterviewKind,
} from "@meridian/core";
import { applicationStatusByToken } from "@meridian/db/domain";
import { RescheduleForm } from "./reschedule-form";
import { CheckCircle, Circle, Warning, WhatsappLogo } from "@phosphor-icons/react/dist/ssr";

/**
 * The applicant's own view (`ATS-16`, wireframe §2.5).
 *
 * ── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 *
 * *"Exists because the single thing applicants care about most is being told
 * the outcome at all."* Around 65% of applicants never or rarely hear back, and
 * roughly 80% of those say they would not reapply — which in a referral-driven
 * trades market is a supply problem rather than a courtesy problem.
 *
 * The obligation is discharged by the outcome message. This page is what makes
 * the wait bearable in the meantime, at any hour, without a phone call to an
 * office that is closed. It also mirrors the internal blocked-on indicator
 * (`ATS-8`): if we are waiting on the candidate for a certificate, the
 * candidate is the one person who can fix that, and they are the last person
 * most systems tell.
 *
 * ── WHY THERE IS NO ACCOUNT ─────────────────────────────────────────────────
 *
 * An account is a password a tradesperson will not create for one application,
 * and a password nobody creates is a status page nobody reads. One random
 * 64-character token, one application, read-only. The token is checked by a
 * `SECURITY DEFINER` function that returns exactly one row and nothing about
 * anyone else.
 *
 * `noindex`, because the URL is the credential.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your application",
  robots: { index: false, follow: false },
};

export default async function ApplicationStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const application = await applicationStatusByToken(token);

  // A wrong or expired token is a 404 and not "no application found". The
  // second phrasing confirms that the token space is real and worth probing.
  if (!application) notFound();

  const appliedAt = new Date(application.appliedAt);
  const outcomeSent = application.outcomeSentAt ? new Date(application.outcomeSentAt) : null;
  const outcomeDue = new Date(application.outcomeDueAt);
  const whatsapp = whatsappLink(`Hello, I am asking about application ${application.reference}.`);
  const interview = application.interview;

  return (
    <div className="container-page max-w-2xl py-12 md:py-16">
      <p className="text-[14px]" style={{ color: "var(--text-muted)" }}>
        <Link href="/careers" className="underline">
          Careers
        </Link>
      </p>

      <h1 className="mt-4 text-3xl font-semibold tracking-tight">{application.roleTitle}</h1>
      <p className="tnum mt-2 text-[16px]" style={{ color: "var(--text-secondary)" }}>
        {application.reference} · applied{" "}
        {appliedAt.toLocaleDateString("en-GB", {
          timeZone: "Asia/Dubai",
          day: "numeric",
          month: "long",
          year: "numeric",
        })}
      </p>

      {/* ── The outcome, when there is one ───────────────────────────────── */}
      {outcomeSent && application.outcomeMessage ? (
        <div
          className="mt-9 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="text-[19px] font-semibold">
            {application.status === "hired" ? "You got the job" : "Our decision"}
          </h2>
          <p className="prose-body mt-3 text-[16px]">{application.outcomeMessage}</p>
          <p className="mt-4 text-[13px]" style={{ color: "var(--text-muted)" }}>
            Sent{" "}
            {outcomeSent.toLocaleDateString("en-GB", {
              timeZone: "Asia/Dubai",
              day: "numeric",
              month: "long",
            })}
          </p>
        </div>
      ) : (
        /*
         * The promise, restated. Not "we will be in touch" — a date. It is the
         * same `outcome_due_at` the accountability report measures against, so
         * what this page tells the applicant and what the company is held to
         * are the same fact rather than two that can drift.
         */
        <div
          className="mt-9 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="text-[19px] font-semibold">You will hear from us by</h2>
          <p className="mt-2 text-[18px] font-medium">
            {outcomeDue.toLocaleDateString("en-GB", {
              timeZone: "Asia/Dubai",
              weekday: "long",
              day: "numeric",
              month: "long",
            })}
          </p>
          <p className="prose-body mt-2 text-[15px]">
            Whatever the outcome. If it is a no, we will tell you why — it is usually something you
            can do something about.
          </p>
        </div>
      )}

      {/* ── ATS-14: where to be, and what to bring ───────────────────────── */}
      {interview ? (
        <section
          className="mt-6 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="text-[19px] font-semibold">
            Your {INTERVIEW_KIND_LABEL[interview.kind as InterviewKind]?.toLowerCase() ??
              "interview"}
          </h2>
          <p className="mt-2 text-[18px] font-medium">
            {new Date(interview.scheduledAt).toLocaleString("en-GB", {
              timeZone: "Asia/Dubai",
              weekday: "long",
              day: "numeric",
              month: "long",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          <p className="mt-1 text-[14px]" style={{ color: "var(--text-secondary)" }}>
            Allow about {interview.durationMinutes} minutes.
          </p>

          <dl className="mt-5 space-y-3 text-[15px]">
            <div>
              <dt className="font-medium">Where</dt>
              <dd className="prose-body mt-0.5">
                {interview.locationName}
                <br />
                {interview.locationAddress}
                {interview.locationArea ? `, ${interview.locationArea}` : ""}
                {interview.locationMapUrl ? (
                  <>
                    <br />
                    <a href={interview.locationMapUrl} className="underline">
                      Open the map
                    </a>
                  </>
                ) : null}
              </dd>
            </div>

            {interview.contactName || interview.contactPhone ? (
              <div>
                <dt className="font-medium">Ask for</dt>
                <dd className="prose-body mt-0.5">
                  {interview.contactName}
                  {interview.contactName && interview.contactPhone ? " — " : ""}
                  {interview.contactPhone ? (
                    <a href={telLink(interview.contactPhone)} className="underline">
                      {interview.contactPhone}
                    </a>
                  ) : null}
                </dd>
              </div>
            ) : null}

            {/*
              Headings with nothing under them are omitted rather than filled
              with "none specified". A parking heading that says nothing tells
              somebody sitting at a barrier that the question was asked and
              then abandoned.
            */}
            {interview.parkingNotes ? (
              <div>
                <dt className="font-medium">Parking</dt>
                <dd className="prose-body mt-0.5">{interview.parkingNotes}</dd>
              </div>
            ) : null}

            {interview.ppeRequired.length > 0 ? (
              <div>
                <dt className="font-medium">Wear</dt>
                <dd className="prose-body mt-0.5">{interview.ppeRequired.join(", ")}</dd>
              </div>
            ) : null}

            {interview.bringNotes ? (
              <div>
                <dt className="font-medium">Bring</dt>
                <dd className="prose-body mt-0.5">{interview.bringNotes}</dd>
              </div>
            ) : null}
          </dl>

          {interview.rescheduleRequestedAt ? (
            <p role="status" className="prose-body mt-5 text-[15px]">
              You have asked us to move this. Somebody will come back to you with a new time — do
              not travel to the original one until you hear from us.
            </p>
          ) : (
            <RescheduleForm token={token} />
          )}
        </section>
      ) : null}

      {/* ── ATS-8, mirrored to the candidate ─────────────────────────────── */}
      {application.status === "active" && application.blockedOn === "candidate" ? (
        <div
          role="status"
          className="mt-6 flex items-start gap-3 rounded-sm p-5"
          style={{ backgroundColor: "var(--status-warning-wash)" }}
        >
          <Warning size={19} weight="fill" aria-hidden className="mt-0.5 shrink-0" />
          <div>
            <p className="text-[16px] font-semibold">We need something from you</p>
            <p className="prose-body mt-1.5 text-[15px]">
              {application.blockedNote ??
                "We are waiting on something from you before we can move this forward."}
            </p>
            {whatsapp ? (
              <a href={whatsapp} className="btn btn-primary mt-4">
                <WhatsappLogo size={16} weight="fill" aria-hidden />
                Send it on WhatsApp
              </a>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* ── Where it has got to ──────────────────────────────────────────── */}
      <section className="mt-10">
        <h2 className="text-[19px] font-semibold">Progress</h2>
        <ol className="mt-5 space-y-0">
          {application.stages.map((stage, index) => {
            const isCurrent = stage.sequence === application.currentStageSequence;
            const isLast = index === application.stages.length - 1;

            return (
              <li key={stage.sequence} className="flex gap-3.5">
                <div className="flex flex-col items-center">
                  {stage.reached ? (
                    <CheckCircle
                      size={20}
                      weight="fill"
                      aria-hidden
                      style={{ color: "var(--accent)" }}
                    />
                  ) : (
                    <Circle size={20} aria-hidden style={{ color: "var(--border-strong)" }} />
                  )}
                  {!isLast ? (
                    <span
                      aria-hidden
                      className="w-px flex-1"
                      style={{
                        minHeight: 26,
                        backgroundColor: stage.reached
                          ? "var(--accent)"
                          : "var(--border-hairline)",
                      }}
                    />
                  ) : null}
                </div>
                <div className="pb-6">
                  <p
                    className="text-[16px]"
                    style={{
                      fontWeight: isCurrent ? 600 : 400,
                      color: stage.reached ? "var(--text-primary)" : "var(--text-muted)",
                    }}
                  >
                    {stage.name}
                  </p>
                  {isCurrent && application.status === "active" ? (
                    <p className="mt-0.5 text-[14px]" style={{ color: "var(--accent-text)" }}>
                      You are here
                      {application.blockedOn !== "none"
                        ? ` — ${BLOCKED_ON_LABEL[application.blockedOn as BlockedOn].toLowerCase()}`
                        : ""}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="mt-8 border-t pt-7">
        <p className="prose-body text-[15px]">
          Questions? Message us on WhatsApp or call {tenant.phone}. Quote {application.reference}.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          {whatsapp ? (
            <a href={whatsapp} className="btn btn-secondary">
              <WhatsappLogo size={16} weight="fill" aria-hidden />
              WhatsApp
            </a>
          ) : null}
          {tenant.phone ? (
            <a href={telLink(tenant.phone)} className="btn btn-secondary">
              {tenant.phone}
            </a>
          ) : null}
        </div>
        <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
          We never ask you to pay anything. Recruitment, visa and permit costs are ours by law and
          are never taken from a worker&rsquo;s salary. If anyone asks you for a fee in connection
          with a job here, tell us.
        </p>
      </div>
    </div>
  );
}
