import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withCustomerScope, getPortalRequestDetail } from "@meridian/db";
import { getService, PORTAL_JOB_NARRATIVE } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { ArrowLeft, CheckCircle } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Request" };
export const dynamic = "force-dynamic";

/**
 * One request, with its evidence (`POR-3`; `POR-9`'s photographs where they
 * exist).
 *
 * This is the deflection mechanism the PRD describes: it answers "what did you
 * actually do" before it is asked. The timeline is the part that does most of
 * that work — not because the customer reads every line, but because seeing
 * that 14:48 "on the way" and 15:06 "arrived" were recorded settles the
 * question of whether anybody came.
 */
export default async function PortalRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePortalSession();
  const { id } = await params;

  const request = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    (tx) => getPortalRequestDetail(tx, id),
  );

  // 404 for another customer's request, exactly as for one that does not
  // exist. The row is invisible inside customer scope, so this branch is the
  // only outcome available — and it is the right one: distinguishing the two
  // would confirm that a given id exists on somebody else's account.
  if (!request) notFound();

  return (
    <PortalShell session={session} active="requests">
      <div className="container-page py-8">
        <Link
          href="/portal/requests"
          className="inline-flex items-center gap-1.5 text-[13px]"
          style={{ color: "var(--text-secondary)" }}
        >
          <ArrowLeft size={14} aria-hidden />
          All requests
        </Link>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{request.title}</h1>
          <span
            className="rounded-sm px-2 py-1 text-[12px] font-semibold"
            style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
          >
            {PORTAL_JOB_NARRATIVE[request.status]}
          </span>
        </div>

        <p className="mt-2 text-[14px]" style={{ color: "var(--text-secondary)" }}>
          <span className="tnum">{request.reference}</span> &middot; {request.propertyName}
          {request.propertyArea ? `, ${request.propertyArea}` : ""} &middot;{" "}
          {getService(request.serviceSlug)?.shortName ?? request.serviceSlug}
        </p>

        {request.description ? (
          <p className="prose-body mt-4 text-[14px]">{request.description}</p>
        ) : null}

        {/* ── Timeline ─────────────────────────────────────────────────────
            Status and time only. `job_events.note` is staff free text and is
            deliberately not read here — there is no way to sanitise a field
            written by somebody who believed it was internal. */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight">What has happened</h2>
          <ol className="mt-4 space-y-3">
            {request.timeline.map((event, i) => (
              <li key={`${event.status}-${i}`} className="flex items-baseline gap-3">
                <span
                  aria-hidden
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{
                    backgroundColor:
                      i === request.timeline.length - 1 ? "var(--accent)" : "var(--border-strong)",
                  }}
                />
                <span className="tnum shrink-0 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {event.occurredAt.toLocaleString("en-GB", {
                    timeZone: "Asia/Dubai",
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </span>
                <span className="text-[14px]">{PORTAL_JOB_NARRATIVE[event.status]}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Visits ───────────────────────────────────────────────────── */}
        {request.visits.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Visits</h2>
            <ul
              className="mt-4 divide-y rounded border"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              {request.visits.map((v) => (
                <li key={v.id} className="p-5">
                  <p className="text-[15px] font-medium">{v.technicianName}</p>
                  <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {v.scheduledStart
                      ? `Booked ${v.scheduledStart.toLocaleString("en-GB", {
                          timeZone: "Asia/Dubai",
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}`
                      : "Not yet scheduled"}
                    {v.arrivedAt
                      ? ` · arrived ${v.arrivedAt.toLocaleTimeString("en-GB", {
                          timeZone: "Asia/Dubai",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : ""}
                    {v.completedAt
                      ? ` · finished ${v.completedAt.toLocaleTimeString("en-GB", {
                          timeZone: "Asia/Dubai",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}`
                      : ""}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── What was done ────────────────────────────────────────────── */}
        {request.workCarriedOut.length > 0 || request.outcome ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">What was done</h2>
            {request.outcome ? (
              <p
                className="mt-3 inline-flex items-center gap-2 rounded-sm px-2 py-1 text-[13px] font-medium"
                style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
              >
                <CheckCircle size={15} weight="fill" aria-hidden />
                {request.outcome}
              </p>
            ) : null}
            {request.workCarriedOut.map((text, i) => (
              <p key={i} className="prose-body mt-3 text-[14px]">
                {text}
              </p>
            ))}
            {request.recommendations.length > 0 ? (
              <div className="mt-5 rounded border p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
                <p className="text-[13px] font-semibold">We also recommend</p>
                {request.recommendations.map((text, i) => (
                  <p key={i} className="prose-body mt-1.5 text-[14px]">
                    {text}
                  </p>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ── Materials ────────────────────────────────────────────────────
            What was used, without what it cost. `POR-3` asks for the work; the
            price belongs on the invoice, and `unit_cost` is what the part cost
            the business, which is nobody's business but the business's. */}
        {request.materials.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Parts and materials</h2>
            <ul className="mt-3 space-y-1">
              {request.materials.map((m, i) => (
                <li key={i} className="text-[14px]">
                  {m.description}{" "}
                  <span className="tnum" style={{ color: "var(--text-muted)" }}>
                    &times;{Number(m.quantity)} {m.unit}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── Evidence ─────────────────────────────────────────────────────
            `POR-9` is a Phase 3 item and the file-serving path for attachments
            is not built here — `packages/files` and the upload pipeline belong
            to another workstream. What this screen does is tell the customer the
            photographs exist and are on the record, which is most of the
            deflection value, rather than rendering a broken image. */}
        {request.photos.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Photographs</h2>
            <p className="prose-body mt-2 text-[14px]">
              {request.photos.length} photograph{request.photos.length === 1 ? " was" : "s were"}{" "}
              taken on site and {request.photos.length === 1 ? "is" : "are"} held with this job.
              Ask us and we will send {request.photos.length === 1 ? "it" : "them"} across.
            </p>
            <ul className="mt-3 space-y-1">
              {request.photos.map((p) => (
                <li key={p.id} className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {p.kind === "photo_before" ? "Before" : "After"}
                  {p.caption ? ` — ${p.caption}` : ""}
                  {p.capturedAt
                    ? ` · ${p.capturedAt.toLocaleString("en-GB", {
                        timeZone: "Asia/Dubai",
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}`
                    : ""}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ── Sign-off ─────────────────────────────────────────────────── */}
        {request.signoff ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Signed off</h2>
            <p className="prose-body mt-2 text-[14px]">
              {request.signoff.signedByName} signed this off on{" "}
              {request.signoff.signedAt.toLocaleString("en-GB", {
                timeZone: "Asia/Dubai",
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {request.signoff.satisfactionRating !== null
                ? `, rating the work ${request.signoff.satisfactionRating} out of 5`
                : ""}
              .
            </p>
          </section>
        ) : null}

        <div className="mt-12">
          <Link href="/portal/request" className="btn btn-secondary">
            Raise a related request
          </Link>
        </div>
      </div>
    </PortalShell>
  );
}
