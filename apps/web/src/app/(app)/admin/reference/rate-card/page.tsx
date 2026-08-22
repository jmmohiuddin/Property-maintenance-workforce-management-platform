import type { Metadata } from "next";
import { withTenant } from "@meridian/db";
import { listRateCard, RATE_BAND_LABEL, RATE_UNIT_LABEL, type RateBand } from "@meridian/db/domain";
import { formatMoney, getService, toDubai } from "@meridian/core";
import { requireSessionWith } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ReferenceTabs } from "../tabs";
import { AddRateForm, InstallRateCardButton, StopRateButton } from "../taxonomy-forms";

export const metadata: Metadata = {
  title: "Rate card",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * `/admin/reference/rate-card` — `QTE-4`, source for `WEB-16`.
 *
 * Shows today's prices. Yesterday's are not deleted and not hidden — they are
 * closed periods on the same code, which is what lets a quotation issued in
 * March still be explained in July. Raising a price is entering a new one from
 * a date, not editing a number, and the form says so rather than pretending an
 * "edit" leaves history intact.
 *
 * The `?on=YYYY-MM-DD` parameter renders the card as it stood on any past day.
 * That is the acceptance test for the whole table: if it cannot answer "what
 * did we charge for this then", it is a price list rather than a rate card.
 */
export default async function RateCardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSessionWith("settings:write");
  const params = await searchParams;

  const requestedDate = typeof params["on"] === "string" ? params["on"] : undefined;
  const onDate = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : undefined;
  const today = isoDate(new Date());

  const rates = await withTenant(
    { tenantId: session.principal.tenantId, userId: session.principal.userId },
    (tx) => listRateCard(tx, onDate ? { onDate } : undefined),
  );

  const services = [...new Set(rates.map((rate) => rate.serviceSlug))].sort();
  const publishedCount = rates.filter((rate) => rate.isPublished).length;

  return (
    <AppShell session={session} active="admin/reference">
      <main id="main" className="container-page py-10">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Rate card</h1>
          <p className="prose-body mt-2 max-w-3xl text-[15px]">
            Standard prices per service, per unit and per rate band, each one dated. Quote lines
            default from here, and the published schedule of rates is drawn from the lines marked
            public.
          </p>
        </header>

        <ReferenceTabs active="/admin/reference/rate-card" />

        {onDate ? (
          <p
            className="mt-6 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--surface-sunken)" }}
          >
            Showing the card as it stood on <span className="tnum font-semibold">{onDate}</span>.
            This is what a quotation issued that day was priced from.
          </p>
        ) : null}

        {rates.length === 0 ? (
          <div
            className="mt-8 rounded-sm p-4 text-[14px]"
            style={{ backgroundColor: "var(--status-warning-wash)" }}
          >
            <p className="font-medium">
              {onDate ? `Nothing was priced on ${onDate}.` : "No rates have been entered."}
            </p>
            <p className="mt-1">
              Until there are, every quotation is priced from memory. Two people quoting the same
              callout differently is the visible symptom; the one that costs money is a price that
              has not moved in three years because nobody could see what it was. It also blocks a
              second thing outright: a tender pack is assembled from this table at the moment it is
              produced, so with nothing priced here, every tender pack refuses to build until at
              least one rate exists. Start with the callout and the hourly rate for the trades that
              get called most, in all four bands — an emergency at 02:00 on a Friday is not the
              standard rate. A starting rate card priced against the ten licensed services — labour
              and a call-out fee for each, out-of-hours and emergency uplifts for the three trades
              that take emergency callouts, and a materials line for the rest — is one click away.
            </p>
            {onDate ? null : (
              <div className="mt-4">
                <InstallRateCardButton label="Add the standard rate card" />
              </div>
            )}
          </div>
        ) : null}

        {services.map((serviceSlug) => {
          const service = getService(serviceSlug);
          const forService = rates.filter((rate) => rate.serviceSlug === serviceSlug);

          return (
            <section key={serviceSlug} className="mt-10">
              <h2 className="text-[15px] font-semibold">{service?.name ?? serviceSlug}</h2>
              <ul className="mt-3 divide-y border-y">
                {forService.map((rate) => (
                  <li key={rate.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                    <div>
                      <p className="text-[14px] font-medium">
                        {rate.label}{" "}
                        <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                          · {RATE_BAND_LABEL[rate.rateBand as RateBand] ?? rate.rateBand}
                        </span>
                        {rate.isPublished ? (
                          <span
                            className="ml-2 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                            style={{
                              backgroundColor: "var(--accent-wash)",
                              color: "var(--accent-text)",
                            }}
                          >
                            published
                          </span>
                        ) : null}
                      </p>
                      {rate.notes ? (
                        <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {rate.notes}
                        </p>
                      ) : null}
                      <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                        {rate.code} · from {rate.effectiveFrom}
                        {rate.effectiveTo ? ` until ${rate.effectiveTo}` : ""}
                        {rate.minQuantity ? ` · minimum ${trimQuantity(rate.minQuantity)}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1.5">
                      <p className="tnum text-[15px] font-semibold">
                        {formatMoney(rate.unitPriceMinor, rate.currency)}{" "}
                        <span className="text-[13px] font-normal" style={{ color: "var(--text-secondary)" }}>
                          {RATE_UNIT_LABEL[rate.unit] ?? rate.unit}
                        </span>
                      </p>
                      {onDate ? null : (
                        <StopRateButton
                          code={rate.code}
                          rateBand={rate.rateBand}
                          label={rate.label}
                          today={today}
                        />
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {rates.length > 0 ? (
          <p className="mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
            {publishedCount === 0
              ? "Nothing is marked for publication, so the public schedule of rates would be empty. A published rate card is one of the few things a visitor can compare you on without calling."
              : `${publishedCount} of ${rates.length} lines are marked for publication.`}
          </p>
        ) : null}

        <div className="mt-8 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
          <h2 className="text-[14px] font-semibold">Add or raise a price</h2>
          <p className="prose-body mt-1 max-w-3xl text-[14px]">
            To change a price, enter it again with the same code and the date it takes effect. The
            old price is kept and ends on that date, so quotations issued under it can still be
            explained. Nothing is overwritten and nothing is lost.
          </p>
          <div className="mt-4">
            <AddRateForm today={today} />
          </div>
        </div>
      </main>
    </AppShell>
  );
}

/**
 * "1.000" → "1".
 *
 * `numeric(12,3)` comes back with its scale intact, and a minimum of "1.000"
 * hours reads as a precision nobody meant. Trimmed as a string rather than
 * parsed to a number, because a quantity that goes through a float on the way
 * to a screen is one that eventually goes through a float on the way to a
 * price.
 */
function trimQuantity(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** `YYYY-MM-DD` in Dubai. A price starting "today" means today here, not in UTC. */
function isoDate(instant: Date): string {
  const t = toDubai(instant);
  return `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}
