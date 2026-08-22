import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import {
  assetCountsByCategory,
  listAssetCategories,
  STANDARD_ASSET_CATEGORIES,
} from "@meridian/db/domain";
import { getService } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ReferenceTabs } from "../tabs";
import { AddAssetKindForm, InstallAssetKindsButton, RetireButton } from "../taxonomy-forms";

export const metadata: Metadata = {
  title: "Asset kinds",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/admin/reference/asset-kinds` — `CON-13`, `ADM-10`.
 *
 * The vocabulary the asset register records plant under. It is a list rather
 * than a text box because the questions it exists to answer are asked across
 * rows — how many chillers are we contracted to maintain, what does servicing
 * one cost, how often does this model fail the same way — and those are the
 * numbers a commercial AMC is priced from and a tender is evaluated on. Four
 * spellings of "chiller" is not untidiness; it is the answer ceasing to exist.
 *
 * And it is administrator-maintained for the reason every other list here is:
 * a vocabulary nobody can extend is worse than free text, because the first
 * unlisted kind gets recorded as the nearest wrong one and the register looks
 * governed while being wrong.
 */
export default async function AssetKindsPage() {
  const session = await requireSessionWith("settings:write");

  const { kinds, counts } = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    async (tx) => ({
      kinds: await listAssetCategories(tx),
      counts: await assetCountsByCategory(tx),
    }),
  );

  const present = new Set(kinds.map((k) => k.code));
  const missingStandard = STANDARD_ASSET_CATEGORIES.filter((k) => !present.has(k.code));
  const activeCount = kinds.filter((k) => k.isActive).length;

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Asset kinds</h1>
          <p className="prose-body mt-2 max-w-3xl text-[15px]">
            What plant the asset register is allowed to record. Add the ones this business actually
            maintains — a cooling tower entered as a pump is worse than no category at all, because
            it is wrong and it looks deliberate.
          </p>
        </header>

        <ReferenceTabs active="/admin/reference/asset-kinds" />

        {activeCount === 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-critical-wash)" }}
          >
            <p className="font-medium">No asset kinds are available.</p>
            <p className="mt-1">
              Nothing can be added to any property&rsquo;s register until there is at least one kind
              to record it as. The seven the requirement names are one click away.
            </p>
            <div className="mt-4">
              <InstallAssetKindsButton label="Add the seven standard kinds" />
            </div>
          </div>
        ) : null}

        {activeCount > 0 && missingStandard.length > 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">
              {missingStandard.length} of the seven standard kinds{" "}
              {missingStandard.length === 1 ? "is" : "are"} missing:{" "}
              {missingStandard.map((k) => k.label).join(", ")}.
            </p>
            <p className="mt-1">
              Adding them back leaves your own wording alone — nothing already here is overwritten.
            </p>
            <div className="mt-4">
              <InstallAssetKindsButton label="Add the missing ones" />
            </div>
          </div>
        ) : null}

        {kinds.length > 0 ? (
          <ul className="mt-8 divide-y border-y">
            {kinds.map((kind) => {
              const registered = counts.get(kind.id) ?? 0;
              return (
                <li
                  key={kind.id}
                  className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                  style={kind.isActive ? undefined : { color: "var(--text-secondary)" }}
                >
                  <div>
                    <p className="text-[14px] font-medium">
                      {/* The space is load-bearing: without it a screen reader
                          reads the label and the badge as one word. */}
                      {kind.label}{" "}
                      {kind.isActive ? null : (
                        <span
                          className="text-[12px] font-normal"
                          style={{ color: "var(--text-muted)" }}
                        >
                          retired
                        </span>
                      )}
                    </p>
                    {kind.description ? (
                      <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                        {kind.description}
                      </p>
                    ) : null}
                    <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {kind.code}
                      {kind.serviceSlug
                        ? ` · ${getService(kind.serviceSlug)?.shortName ?? kind.serviceSlug}`
                        : ""}
                      {kind.defaultPpmIntervalDays
                        ? ` · serviced every ${kind.defaultPpmIntervalDays} days`
                        : " · no standard interval"}
                      {` · ${registered} registered`}
                    </p>
                  </div>
                  <RetireButton
                    kind="assetKind"
                    id={kind.id}
                    label={kind.label}
                    isActive={kind.isActive}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}

        <div
          className="mt-8 rounded border p-5"
          style={{ backgroundColor: "var(--surface-raised)" }}
        >
          <h2 className="text-[14px] font-semibold">Add a kind</h2>
          <p className="prose-body mt-1 max-w-3xl text-[14px]">
            Reusing a code that already exists corrects that kind rather than creating a second one,
            and brings it back if it was retired. Keep the list to plant that is genuinely
            maintained differently — two kinds that mean nearly the same thing get chosen at random,
            and then neither count means anything.
          </p>
          <div className="mt-4">
            <AddAssetKindForm />
          </div>
        </div>

        <p className="mt-10 max-w-3xl text-[13px]" style={{ color: "var(--text-muted)" }}>
          These are what the asset register offers on every property record. Retiring a kind removes
          it from the picker and leaves every asset already registered under it exactly as it is —
          which is why nothing here deletes: the plant is still in the building, and the count it
          contributes to last year&rsquo;s tender still has to reconcile.
        </p>
      </main>
    </AppShell>
  );
}
