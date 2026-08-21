import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  withTenant,
  getPropertyRecord,
  listPropertyAssets,
  listPropertyUnits,
  listAssetCategories,
} from "@meridian/db";
import { PROPERTY_TYPE_LABEL, type PropertyType } from "@meridian/core";
import { can } from "@meridian/auth";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { AddAssetForm } from "./asset-forms";
import { CONDITION_LABEL, readableDay, warrantyNote } from "./asset-display";
import { Buildings, Wrench } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = { title: "Property" };
export const dynamic = "force-dynamic";

const dubaiDate = (d: Date) =>
  d.toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium" });

/**
 * `/properties/[id]` — the property record, and `CON-13`'s asset register.
 *
 * Properties had no page of their own: they were rows inside the customer
 * screen, which is why the register had nowhere to go. Everything a technician
 * needs before travelling — the address, the access instructions, and what
 * plant is on site — is on one page here.
 */
export default async function PropertyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSessionWith("properties:read");
  const { id } = await params;

  const data = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      property: await getPropertyRecord(tx, id),
      assets: await listPropertyAssets(tx, id),
      units: await listPropertyUnits(tx, id),
      // Active kinds only. A retired kind stays on the plant already
      // recorded under it and must not be offered for new plant.
      categories: await listAssetCategories(tx, { activeOnly: true }),
    }),
  );

  if (!data.property) notFound();
  const property = data.property;
  const canWrite = can(session.principal, "properties:write");

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
          <Link href={`/customers/${property.customerId}`} className="hover:underline">
            {property.customerName}
          </Link>
          <span className="mx-2" aria-hidden>
            /
          </span>
          <span style={{ color: "var(--text-secondary)" }}>{property.name}</span>
        </nav>

        <div className="mt-6 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
            {property.name}
            {property.isActive ? "" : " (inactive)"}
          </h1>
          <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
            {PROPERTY_TYPE_LABEL[property.type as PropertyType] ?? property.type}
            {property.area ? ` · ${property.area}` : ""} · {property.city}
          </p>
        </div>

        <p className="prose-body mt-2 text-[14px]">{property.addressLine}</p>

        <dl
          className="mt-6 grid gap-px overflow-hidden rounded border sm:grid-cols-4"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          {[
            { label: "Assets on register", value: String(data.assets.length) },
            { label: "Floors", value: property.floors === null ? "—" : String(property.floors) },
            {
              label: "Units",
              value: property.unitCount === null ? "—" : String(property.unitCount),
            },
            {
              label: "Warranties expired",
              value: String(
                data.assets.filter(
                  (a) => a.warrantyDaysRemaining !== null && a.warrantyDaysRemaining < 0,
                ).length,
              ),
            },
          ].map((s) => (
            <div key={s.label} className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                {s.label}
              </dt>
              <dd className="tnum mt-1 text-2xl font-semibold">{s.value}</dd>
            </div>
          ))}
        </dl>

        {property.accessInstructions ? (
          <section
            className="mt-6 rounded border p-6"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              <Buildings size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
              Getting in
            </h2>
            <p className="prose-body mt-2 text-[14px]">{property.accessInstructions}</p>
          </section>
        ) : null}

        {/* ── CON-13. The asset register ─────────────────────────────────── */}
        <section
          className="mt-6 rounded border p-6"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Wrench size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
            Asset register
          </h2>
          <p className="prose-body mt-2 text-[14px]">
            What plant is on this site, and what has been done to it. A commercial AMC is priced per
            asset and a tender is evaluated on this list, so a building whose register is empty is a
            building that has to be surveyed again before it can be quoted.
          </p>

          {data.assets.length === 0 ? (
            <p className="prose-body mt-4 text-[14px]">
              Nothing registered here yet.
            </p>
          ) : (
            <ul className="mt-5 divide-y rounded border">
              {data.assets.map((a) => {
                const warranty = warrantyNote(a.warrantyExpiresOn, a.warrantyDaysRemaining);
                return (
                  <li key={a.id}>
                    <Link href={`/properties/${property.id}/assets/${a.id}`} className="block p-4">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <p className="text-[14px] font-medium">
                          <span className="tnum">{a.tag}</span> &middot; {a.name}
                        </p>
                        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                          {a.categoryLabel ?? "Kind not recorded"}
                        </span>
                      </div>
                      <p className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {[
                          a.manufacturer && a.model
                            ? `${a.manufacturer} ${a.model}`
                            : (a.manufacturer ?? a.model),
                          a.serialNumber ? `serial ${a.serialNumber}` : null,
                          a.location,
                          a.unitReference ? `unit ${a.unitReference}` : null,
                          a.installedOn ? `installed ${readableDay(a.installedOn)}` : null,
                          CONDITION_LABEL[a.condition] ?? a.condition,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <p
                        className="mt-1 text-[13px]"
                        style={{
                          color: warranty.critical
                            ? "var(--status-critical-text)"
                            : "var(--text-secondary)",
                        }}
                      >
                        {warranty.text} &middot;{" "}
                        {a.jobCount === 0
                          ? "no service history attached"
                          : `${a.jobCount} ${a.jobCount === 1 ? "job" : "jobs"} on record`}
                        {a.nextServiceDueAt ? ` · next PPM ${dubaiDate(a.nextServiceDueAt)}` : ""}
                      </p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}

          {canWrite ? (
            <AddAssetForm
              propertyId={property.id}
              categories={data.categories.map((c) => ({
                id: c.id,
                code: c.code,
                label: c.label,
                defaultPpmIntervalDays: c.defaultPpmIntervalDays,
              }))}
              units={data.units.map((u) => ({ id: u.id, reference: u.reference }))}
            />
          ) : (
            <p className="prose-body mt-4 text-[14px]">
              Your role can read this register but not add to it.
            </p>
          )}
        </section>
      </div>
    </AppShell>
  );
}
