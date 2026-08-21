import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withCustomerScope, getPortalRequestDetail, type PortalRequestDetail } from "@meridian/db";
import { getService, PORTAL_JOB_NARRATIVE, type JobStatus } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { ArrowLeft, CheckCircle, DownloadSimple } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Request" };
export const dynamic = "force-dynamic";

/**
 * The statuses at which somebody has been and finished.
 *
 * Used only to choose between two honest sentences when there are no
 * photographs: "none were taken" and "they appear once the visit is finished".
 * `cancelled` is deliberately not here — a cancelled job had no visit, and
 * "no photographs were taken" would be true but would read as an omission.
 */
const WORK_FINISHED: readonly JobStatus[] = ["work_complete", "signed_off", "invoiced", "closed"];

/**
 * The formats a browser will put in an `<img>`.
 *
 * `image/heic` is what an iPhone produces and no browser outside Safari renders
 * it, so it gets a download link rather than a broken image. The route makes
 * the same split from the SNIFFED type; this reads the declared `mime_type`
 * column, which is advisory. A null column takes the `<img>` path, which is the
 * right guess: everything the field app uploads today is a JPEG.
 */
const RENDERABLE_IN_BROWSER: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

  const beforePhotos = request.photos.filter((p) => p.kind === "photo_before");
  const afterPhotos = request.photos.filter((p) => p.kind === "photo_after");

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
        {request.materials.length > 0 || request.materialsNone ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Parts and materials</h2>
            {request.materials.length > 0 ? (
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
            ) : (
              // `JOB-15`'s declared absence, and the reason this section renders
              // at all when there is nothing in it. "No parts were used" is a
              // fact a technician asserted with their name and the time on it —
              // not the same thing as an empty list, which means nobody filled
              // the section in. The customer is entitled to know which it is.
              <p className="prose-body mt-3 text-[14px]">
                No parts or materials were needed for this work.
              </p>
            )}
          </section>
        ) : null}

        {/* ── Evidence ─────────────────────────────────────────────────────
            `POR-9`, and the reason this screen exists. Before and after, side
            by side, is the answer to "what did you actually do" — and it is
            only an answer if the customer can see the pictures. Each `src` is
            an attachment ROW id under this request's own path; the storage key
            never reaches the browser and is resolved server-side by the route.

            Grouped before-then-after rather than in upload order, because the
            pairing is the whole point: two photographs of the same fan coil in
            the order they were taken is an argument, and the same two shuffled
            is a gallery. */}
        <section className="mt-10">
          <h2 className="text-lg font-semibold tracking-tight">Photographs</h2>
          {beforePhotos.length === 0 && afterPhotos.length === 0 ? (
            // Said, not left blank. An empty section reads as "nothing
            // happened", and the three reasons there is nothing here are
            // different things the customer would act on differently.
            //
            // A declared exemption is the best of the three, because it is the
            // technician answering the question rather than the screen guessing
            // at it — which is exactly what `JOB-15` made the reason a coded
            // list for. It is checked first for that reason.
            request.photoExemptions.length > 0 ? (
              <div className="mt-2">
                <p className="prose-body text-[14px]">
                  {request.photoExemptions.length === 1
                    ? "No photograph was taken, and the reason was recorded on the job:"
                    : "No photographs were taken. The reasons were recorded on the job:"}
                </p>
                <ul className="mt-2 space-y-1">
                  {request.photoExemptions.map((e, i) => (
                    <li key={i} className="text-[14px]">
                      {e.reasonLabel}
                      <span className="ml-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {e.declaredAt.toLocaleDateString("en-GB", {
                          timeZone: "Asia/Dubai",
                          dateStyle: "medium",
                        })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="prose-body mt-2 text-[14px]">
                {WORK_FINISHED.includes(request.status)
                  ? "No photographs were taken on this job."
                  : "Photographs are taken on site and appear here once the visit is finished."}
              </p>
            )
          ) : (
            <>
              <p className="prose-body mt-2 text-[14px]">
                Taken on site by the technician who did the work.
              </p>
              {beforePhotos.length > 0 ? (
                <PhotoGroup label="Before" jobId={request.id} photos={beforePhotos} />
              ) : null}
              {afterPhotos.length > 0 ? (
                <PhotoGroup label="After" jobId={request.id} photos={afterPhotos} />
              ) : null}
            </>
          )}
        </section>

        {/* ── Sign-off ─────────────────────────────────────────────────────
            `POR-9` asks for the "signed job sheet", and what is shown is the
            STATEMENT and never the signature image. The reasoning is set out in
            full at `PORTAL_SIGNATURE_POLICY` in the portal domain: a signature
            is the one artefact on a job whose value depends on copies being
            hard to obtain, and publishing it behind a session cookie puts it one
            screenshot away from a completion certificate for work that never
            happened. Nobody looks at their own signature to check that they
            signed — the sentence below answers the question completely. */}
        {request.signoff ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Signed job sheet</h2>
            <p className="prose-body mt-2 text-[14px]">
              {request.signoff.signedByName}
              {request.signoff.signedByRole ? `, ${request.signoff.signedByRole},` : ""} signed for
              this work on{" "}
              {request.signoff.signedAt.toLocaleString("en-GB", {
                timeZone: "Asia/Dubai",
                dateStyle: "medium",
                timeStyle: "short",
              })}
              {request.signoff.satisfactionRating !== null
                ? `, rating it ${request.signoff.satisfactionRating} out of 5`
                : ""}
              .
            </p>
            <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
              The signed sheet is held with this job. Ask us and we will send you a copy.
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

/**
 * One half of the before-and-after pair.
 *
 * ── WHY A PLAIN `<img>` AND NOT `next/image` ────────────────────────────────
 *
 * `next/image` optimises through a shared image pipeline: it rewrites the URL
 * to `/_next/image?url=…` and caches the result on disk keyed by that URL.
 * These photographs are permission-gated per customer on every request, and a
 * cache keyed by URL is a cache whose second reader's permissions are never
 * checked. The route says `Cache-Control: private, no-store` precisely so that
 * nothing between the database and the browser keeps a copy; putting an
 * optimiser in front of it would undo that in one line.
 *
 * The trade is real — no resizing, no format negotiation, and a portal user on
 * a phone (`POR-10`) downloads the full-size photograph. `loading="lazy"` keeps
 * the ones below the fold off the wire until they are wanted, which is most of
 * the benefit for a list of four or six. A thumbnail pipeline is a job for
 * whoever builds the upload side, on the server, where the derivative can be
 * stored as its own key and gated by the same policy.
 */
function PhotoGroup({
  label,
  jobId,
  photos,
}: {
  label: string;
  jobId: string;
  photos: PortalRequestDetail["photos"];
}) {
  return (
    <div className="mt-5">
      <h3 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </h3>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {photos.map((p) => {
          const href = `/portal/requests/${jobId}/photos/${p.id}`;
          // The caption when the technician wrote one; otherwise a description
          // of what the picture is. Never an empty `alt` — a photograph is the
          // evidence on this page, not decoration, so a screen reader that gets
          // nothing here gets nothing of `POR-9`.
          const alt = p.caption ?? `${label} the work was carried out`;

          return (
            <li key={p.id}>
              {RENDERABLE_IN_BROWSER.has(p.mimeType ?? "image/jpeg") ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded border"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <img
                    src={href}
                    alt={alt}
                    loading="lazy"
                    decoding="async"
                    className="aspect-[4/3] w-full object-cover"
                  />
                </a>
              ) : (
                <a
                  href={href}
                  className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1.5 rounded border p-3 text-center"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <DownloadSimple size={20} aria-hidden style={{ color: "var(--accent)" }} />
                  <span className="text-[12px]" style={{ color: "var(--text-secondary)" }}>
                    {/* Said plainly rather than shown broken. This format is
                        what an iPhone shoots and what most browsers refuse. */}
                    Download this photograph
                  </span>
                </a>
              )}
              {p.caption ? <p className="mt-1.5 text-[13px]">{p.caption}</p> : null}
              {p.capturedAt ? (
                <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                  {p.capturedAt.toLocaleString("en-GB", {
                    timeZone: "Asia/Dubai",
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
