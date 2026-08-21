import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTenant, getAssetRecord, listLinkableJobs } from "@meridian/db";
import { getService, STATUS_LABEL, type JobStatus } from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { AttachJobForm } from "../../asset-forms";
import { CONDITION_LABEL, readableDay, warrantyNote } from "../../asset-display";
import { ClockCounterClockwise, Wrench } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Asset" };
export const dynamic = "force-dynamic";

const dubaiDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

/**
 * One asset, and what has been done to it — `CON-13`.
 *
 * The history is the jobs carrying this asset's id. It is empty until something
 * attaches one, and it says so in those words rather than showing a blank list:
 * "no work recorded" and "work recorded elsewhere" are different facts and only
 * one of them is about the plant.
 */
export default async function AssetPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const session = await requireSessionWith("properties:read");
  const { id, assetId } = await params;

  const data = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      record: await getAssetRecord(tx, assetId),
      linkable: await listLinkableJobs(tx, id),
    }),
  );

  // The asset id and the property in the URL have to agree, or the breadcrumb
  // would lead somewhere the asset is not.
  if (!data.record || data.record.propertyId !== id) notFound();

  const { asset, propertyName, history } = data.record;
  const warranty = warrantyNote(asset.warrantyExpiresOn, asset.warrantyDaysRemaining);
  const canWrite = can(session.principal, "properties:write");

  const facts: { label: string; value: string }[] = [
    { label: "Kind", value: asset.categoryLabel ?? "Not recorded" },
    { label: "Make", value: asset.manufacturer ?? "—" },
    { label: "Model", value: asset.model ?? "—" },
    { label: "Serial number", value: asset.serialNumber ?? "—" },
    { label: "Location", value: asset.location ?? "—" },
    { label: "Unit", value: asset.unitReference ?? "Serves the whole property" },
    {
      label: "Installed",
      value: asset.installedOn ? readableDay(asset.installedOn) : "Not recorded",
    },
    {
      label: "Warranty expiry",
      value: asset.warrantyExpiresOn ? readableDay(asset.warrantyExpiresOn) : "Not recorded",
    },
    { label: "Condition", value: CONDITION_LABEL[asset.condition] ?? asset.condition },
    {
      label: "PPM interval",
      value: asset.ppmIntervalDays ? `${asset.ppmIntervalDays} days` : "Not set",
    },
    {
      label: "Last serviced",
      value: asset.lastServicedAt ? dubaiDate(asset.lastServicedAt) : "No completed work recorded",
    },
    {
      label: "Next PPM due",
      value: asset.nextServiceDueAt ? dubaiDate(asset.nextServiceDueAt) : "Not scheduled",
    },
  ];

  return (
    <AppShell session={session} active="customers">
      <div className="container-page py-8">
        <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
          <Link href="/customers" className="hover:underline">
            Customers
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <Link href={`/properties/${id}`} className="hover:underline">
            {propertyName}
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span style={{ color: "var(--text-secondary)" }}>{asset.tag}</span>
        </nav>

        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight md:text-3xl">
            <Wrench size={22} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            {asset.name}
          </h1>
          <p className="tnum text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {asset.tag}
          </p>
        </div>

        <p
          className="mt-3 rounded p-3 text-[14px]"
          style={{
            backgroundColor: warranty.critical ? "var(--accent-wash)" : "var(--surface-raised)",
            color: warranty.critical ? "var(--accent-text)" : "var(--text-secondary)",
          }}
        >
          {warranty.text}
        </p>

        <dl
          className="mt-6 grid gap-px overflow-hidden rounded border sm:grid-cols-3"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {facts.map((f) => (
            <div key={f.label} className="p-4" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {f.label}
              </dt>
              <dd className="mt-1 text-[14px] font-medium">{f.value}</dd>
            </div>
          ))}
        </dl>

        {/* ── Service history ────────────────────────────────────────────── */}
        <section
          className="mt-6 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ClockCounterClockwise
              size={18}
              weight="fill"
              aria-hidden
              style={{ color: "var(--accent)" }}
            />
            Service history ({history.length})
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            The jobs recorded against this asset. This is what turns a plant list into reliability
            evidence — how often this unit has failed, and what it has cost to keep running.
          </p>

          {history.length === 0 ? (
            <p className="prose-body mt-4 text-[14px]">
              No work has been attached to this asset yet. A request raised in the customer portal
              can name the equipment it is about, and arrives here already attached; anything raised
              before this asset was registered, or raised without naming it, is attached by hand
              below.
            </p>
          ) : (
            <ul className="mt-5 divide-y rounded border">
              {history.map((h) => (
                <li key={h.jobId}>
                  <Link href={`/jobs/${h.jobId}`} className="block p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <p className="text-[14px] font-medium">{h.title}</p>
                      <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {STATUS_LABEL[h.status as JobStatus] ?? h.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                      <span className="tnum">{h.reference}</span> ·{" "}
                      {getService(h.serviceSlug)?.shortName ?? h.serviceSlug} ·{" "}
                      {h.completedAt
                        ? `completed ${dubaiDate(h.completedAt)}`
                        : h.scheduledFor
                          ? `scheduled ${dubaiDate(h.scheduledFor)}`
                          : `raised ${dubaiDate(h.createdAt)}`}
                      {h.outcomeCode ? ` · ${h.outcomeCode}` : ""}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {canWrite ? (
            <AttachJobForm
              propertyId={id}
              assetId={asset.id}
              jobs={data.linkable.map((j) => ({
                id: j.id,
                reference: j.reference,
                title: j.title,
              }))}
            />
          ) : null}
        </section>
      </div>
    </AppShell>
  );
}
