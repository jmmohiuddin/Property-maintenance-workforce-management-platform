import type { Metadata } from "next";
import Link from "next/link";
import { withTenant, listFieldDevices, type FieldDeviceRow } from "@meridian/db";
import { formatDubai } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { RevokeDeviceForm } from "./device-actions";

export const metadata: Metadata = {
  title: "Field devices",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * Field device administration (`SEC-7`).
 *
 * ── THE GAP THIS CLOSES ──────────────────────────────────────────────────────
 *
 * Until this screen, a handset could only revoke itself
 * (`DELETE /api/field/v1/devices/current`) — which is exactly backwards. The
 * one situation revocation actually exists for is the one where nobody has
 * the device in hand to run that request. This is the "I don't have the
 * phone" path.
 *
 * ── WHAT REVOKING DOES, AND DOES NOT, DO ─────────────────────────────────────
 *
 * `revokeFieldDevice` touches this one row and nothing else: not the
 * password, not sessions, not the membership, not the technician record. A
 * lost phone is not a dismissal. The other direction needs no control here at
 * all: deactivating somebody's account already kills every handset they
 * hold, because the device resolver requires their membership, tenant and
 * technician record to all still be live — so there is deliberately no
 * "revoke everything for this person" button on this screen.
 *
 * ── WHY THIS IS HERE AND NOT ON /workforce ───────────────────────────────────
 *
 * `users:manage` — the same permission and the same trust tier as unlocking
 * an account or resetting a second factor on `/admin/users`. See `actions.ts`
 * for the fuller reasoning.
 */

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.trim() !== "" ? v.trim() : undefined;
}

const PLATFORM_LABEL: Readonly<Record<string, string>> = { ios: "iOS", android: "Android" };

export default async function AdminDevicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("users:manage");
  const params = await searchParams;
  const technicianFilter = first(params["technician"]);

  // Fetched unfiltered so the technician picker below can offer everyone who
  // has ever registered a handset, not just whoever the current filter left.
  const allDevices = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listFieldDevices(tx, { includeRevoked: true }),
  );

  const technicians = Array.from(new Map(allDevices.map((d) => [d.technicianId, d.technicianName])).entries()).sort(
    (a, b) => a[1].localeCompare(b[1]),
  );

  const devices = technicianFilter ? allDevices.filter((d) => d.technicianId === technicianFilter) : allDevices;
  const activeCount = allDevices.filter((d) => !d.revokedAt).length;
  const revokedCount = allDevices.length - activeCount;

  return (
    <AppShell session={session} active="admin/devices">
      <div className="container-page py-8">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Field devices</h1>

        <p className="prose-body mt-2 max-w-3xl text-[14px]">
          Every handset registered to the field app, tenant-wide. Revoking one here stops it syncing
          immediately and touches <strong>nothing else</strong> &mdash; not a password, not a session,
          not the technician&apos;s employment. It is the one control to reach for when a phone is
          lost, and nothing more.
        </p>

        <p className="prose-body mt-2 max-w-3xl text-[14px]">
          There is no &ldquo;revoke every device&rdquo; button for somebody leaving, and that is
          deliberate rather than missing: deactivating their account from{" "}
          <Link href="/admin/users" className="underline underline-offset-2" style={{ color: "var(--accent-text)" }}>
            Users
          </Link>{" "}
          already kills every handset they hold, because a device only works while their membership,
          tenant and technician record are all still active.
        </p>

        <dl
          className="mt-6 grid gap-px overflow-hidden rounded border sm:grid-cols-2"
          style={{ backgroundColor: "var(--border-hairline)" }}
        >
          <div className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
            <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Active devices
            </dt>
            <dd className="tnum mt-1 text-3xl font-semibold">{activeCount}</dd>
          </div>
          <div className="p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
            <dt className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              Revoked
            </dt>
            <dd className="tnum mt-1 text-3xl font-semibold">{revokedCount}</dd>
          </div>
        </dl>

        {technicians.length > 1 ? (
          <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="block text-[12px] font-medium" style={{ color: "var(--text-secondary)" }}>
                Technician
              </span>
              <select name="technician" defaultValue={technicianFilter ?? ""} className="mt-1">
                <option value="">Everyone</option>
                {technicians.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="btn btn-secondary">
              Filter
            </button>
            {technicianFilter ? (
              <Link href="/admin/devices" className="text-[13px]" style={{ color: "var(--accent-text)" }}>
                Clear
              </Link>
            ) : null}
          </form>
        ) : null}

        {allDevices.length === 0 ? (
          <div className="mt-8">
            <EmptyState kind="start" title="No handset has ever been registered.">
              <p>
                A technician registers their own device by signing in through the field app with
                their normal password and second factor &mdash; there is nothing to set up here.
                Once a device is registered it appears on this screen, revocable the moment it goes
                missing.
              </p>
            </EmptyState>
          </div>
        ) : devices.length === 0 ? (
          <div className="mt-8">
            <EmptyState kind="filtered" title="No device matches that technician.">
              <p>
                <Link href="/admin/devices" style={{ color: "var(--accent-text)" }}>
                  Clear the filter
                </Link>{" "}
                to see every device.
              </p>
            </EmptyState>
          </div>
        ) : (
          <div className="mt-8 overflow-x-auto rounded border" style={{ backgroundColor: "var(--surface-raised)" }}>
            <table className="w-full min-w-[56rem] border-collapse text-left">
              <thead>
                <tr className="border-b text-[12px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  <th scope="col" className="px-4 py-3 font-medium">Technician</th>
                  <th scope="col" className="px-4 py-3 font-medium">Device</th>
                  <th scope="col" className="px-4 py-3 font-medium">Last seen</th>
                  <th scope="col" className="px-4 py-3 font-medium">Registered</th>
                  <th scope="col" className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <DeviceRow key={d.id} device={d} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function DeviceRow({ device: d }: { device: FieldDeviceRow }) {
  return (
    <tr className="border-b last:border-0 align-top">
      <td className="px-4 py-4 text-[14px] font-medium whitespace-nowrap">{d.technicianName}</td>
      <td className="px-4 py-4">
        <p className="text-[14px]">{d.label}</p>
        <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
          {PLATFORM_LABEL[d.platform] ?? d.platform}
          {d.appVersion ? ` · v${d.appVersion}` : ""}
        </p>
      </td>
      <td className="tnum px-4 py-4 text-[13px] whitespace-nowrap">
        {d.lastSeenAt ? formatDubai(d.lastSeenAt) : "Never synced"}
      </td>
      <td className="tnum px-4 py-4 text-[13px] whitespace-nowrap">{formatDubai(d.registeredAt)}</td>
      <td className="px-4 py-4">
        {d.revokedAt ? (
          <div>
            <p className="text-[13px] font-medium" style={{ color: "var(--text-secondary)" }}>
              Revoked {formatDubai(d.revokedAt)}
              {d.revokedByName ? ` by ${d.revokedByName}` : ""}
            </p>
            {d.revokedReason ? (
              <p className="mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                {d.revokedReason}
              </p>
            ) : null}
          </div>
        ) : (
          <RevokeDeviceForm deviceId={d.id} deviceLabel={d.label} />
        )}
      </td>
    </tr>
  );
}
