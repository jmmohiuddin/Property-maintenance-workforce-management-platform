import type { Metadata } from "next";
import Link from "next/link";
import { withCustomerScope, listPortalRequests } from "@meridian/db";
import { getService, PORTAL_JOB_NARRATIVE, TERMINAL_STATUSES } from "@meridian/core";
import { requirePortalSession } from "@/lib/session";
import { PortalShell } from "@/components/portal-shell";
import { Camera, CaretRight, Clock } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Your requests" };
export const dynamic = "force-dynamic";

/**
 * Request history (`POR-3`, closing `PD-8` and `FR-7.3`).
 *
 * The portal could show open work and nothing else, and that is what it did:
 * the dashboard lists `OPEN_STATUSES` and a request disappears the moment it
 * closes. The effect is that "what happened to the thing I reported in March"
 * is a phone call — which is the deflection this screen exists to remove.
 *
 * Open work first, then history, in one list rather than two tabs. A building
 * manager checking on a job does not know whether the system considers it open.
 */
export default async function PortalRequestsPage() {
  const session = await requirePortalSession();

  const requests = await withCustomerScope(
    {
      tenantId: session.principal.tenantId,
      customerId: session.customerId,
      userId: session.principal.userId,
    },
    (tx) => listPortalRequests(tx, { limit: 100 }),
  );

  const open = requests.filter((r) => !TERMINAL_STATUSES.includes(r.status));
  const closed = requests.filter((r) => TERMINAL_STATUSES.includes(r.status));

  return (
    <PortalShell session={session} active="requests">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Your requests</h1>
        <p className="prose-body mt-2 text-[14px]">
          Everything you have raised with us, newest first.
        </p>

        <Link href="/portal/request" className="btn btn-primary mt-6">
          Raise a request
        </Link>

        {requests.length === 0 ? (
          <div
            className="mt-8 rounded border p-12 text-center"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-lg font-semibold">Nothing yet</h2>
            <p className="prose-body mx-auto mt-2 max-w-[46ch] text-[14px]">
              Raise a request here and you will get a reference straight away — no phone call
              needed.
            </p>
          </div>
        ) : null}

        {open.length > 0 ? (
          <section className="mt-10">
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <Clock size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              In progress ({open.length})
            </h2>
            <RequestList requests={open} />
          </section>
        ) : null}

        {closed.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-lg font-semibold tracking-tight">Completed</h2>
            <RequestList requests={closed} />
          </section>
        ) : null}
      </div>
    </PortalShell>
  );
}

function RequestList({
  requests,
}: {
  requests: Awaited<ReturnType<typeof listPortalRequests>>;
}) {
  return (
    <ul className="mt-4 divide-y rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
      {requests.map((r) => (
        <li key={r.id}>
          {/* One tap target for the whole row. Portal users are on phones
              (`POR-10`), and a link wrapped around the reference alone is a
              12px target next to 300px of dead space. */}
          <Link href={`/portal/requests/${r.id}`} className="flex items-start gap-3 p-5">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="text-[15px] font-medium">{r.title}</p>
                <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  {PORTAL_JOB_NARRATIVE[r.status]}
                </span>
              </div>
              <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                <span className="tnum">{r.reference}</span> &middot; {r.propertyName}
                {r.propertyArea ? `, ${r.propertyArea}` : ""} &middot;{" "}
                {getService(r.serviceSlug)?.shortName ?? r.serviceSlug}
              </p>
              {r.visitStart ? (
                <p className="mt-1 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                  {r.technicianName ? `${r.technicianName}, ` : ""}
                  {formatWindow(r.visitStart, r.visitEnd)}
                </p>
              ) : null}
              {r.photoCount > 0 ? (
                <p
                  className="mt-1 flex items-center gap-1.5 text-[12px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  <Camera size={14} aria-hidden />
                  {r.photoCount} photo{r.photoCount === 1 ? "" : "s"}
                </p>
              ) : null}
            </div>
            <CaretRight size={16} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--text-muted)" }} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * "15 Aug, 15:00–17:00", or just the start when there is no end.
 *
 * Dubai time explicitly, on every date in the portal. The server runs in UTC
 * and the customer does not, and a visit window rendered an hour early is the
 * one formatting mistake in this product that puts somebody on a doorstep at
 * the wrong time.
 */
function formatWindow(start: Date, end: Date | null): string {
  const day = start.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });
  const from = start.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
  });
  if (!end) return `${day}, ${from}`;
  const to = end.toLocaleTimeString("en-GB", {
    timeZone: "Asia/Dubai",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${day}, ${from}–${to}`;
}
