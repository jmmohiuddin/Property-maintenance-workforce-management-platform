import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  services,
  groupedServices,
  emergencyServices,
  RESPONSE_COMMITMENT,
  UAE_VAT_BASIS_POINTS,
  formatMoney,
  toDecimalString,
  today,
  graph,
  webPageSchema,
  breadcrumbSchema,
  faqSchema,
  rateCardSchema,
  type Faq,
} from "@meridian/core";
import {
  RATE_BANDS,
  RATE_BAND_LABEL,
  RATE_UNIT_LABEL,
  type RateBand,
  type PublicRateCardRow,
} from "@meridian/db/domain";
import { Section, AnswerBlock } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { hreflangAlternates } from "@/lib/i18n";
import { publishedRateCard } from "./rate-card";

/**
 * `/rates` — `WEB-16`, the published schedule of rates.
 *
 * Tonight's PRD audit names this the single highest-leverage AEO asset
 * available, and it is a rendering job rather than a content job: every row on
 * this page is `rate_card_items` (`QTE-4`), filtered to `is_published` and to
 * what is in force *today, in Dubai* — both checked in SQL, in
 * `app_public_rate_card` (`packages/db/sql/public-functions.sql`), not here.
 * Nothing on this page is hand-typed; a price changed in
 * `/admin/reference/rate-card` moves here on the next request.
 *
 * Rendered `force-dynamic`, like the careers pages that share its "public page
 * reading live tenant data through a SECURITY DEFINER function" shape — a
 * dated price table has no business being cached into a static build.
 */
export const dynamic = "force-dynamic";

const VAT_PERCENT = UAE_VAT_BASIS_POINTS / 100;

const ANSWER = `${tenant.brandName} publishes its Dubai rate card here: hourly labour and call-out prices in AED for each of its ${services.length} licensed services, in up to four rate bands — standard, after hours, weekend and emergency — read directly from the same rate card the company quotes from, not a separate "from" price. Rates exclude ${VAT_PERCENT}% UAE VAT.`;

export const metadata: Metadata = {
  title: "Schedule of Rates",
  description: ANSWER,
  alternates: { canonical: "/rates", languages: hreflangAlternates("/rates") },
};

/** Sort order within one service: canonical band order, labour before call-out. */
function bandRank(band: RateBand): number {
  const i = RATE_BANDS.indexOf(band);
  return i === -1 ? RATE_BANDS.length : i;
}

function codeRank(code: string): number {
  if (code.endsWith("-labour")) return 0;
  if (code.endsWith("-callout")) return 1;
  return 2;
}

/** "1.000" -> "1". `numeric(12,3)` keeps its scale; a public page should not. */
function trimQuantity(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

function faqsFor(): readonly Faq[] {
  const eligible = emergencyServices.map((s) => s.shortName.toLowerCase()).join(", ");
  return [
    {
      q: "Do these prices include VAT?",
      a: `No. Every rate on this page is shown exclusive of ${VAT_PERCENT}% UAE VAT, which is added when the work is invoiced.`,
    },
    {
      q: "Are materials included in the price?",
      a: "No. The labour and call-out rates cover the visit, diagnosis and labour. Materials bought in for a job are charged at cost plus a materials-handling line, which is deliberately not published here because it depends on what the job actually needs.",
    },
    {
      q: "What qualifies for the emergency rate?",
      a: eligible
        ? `The emergency band applies to ${eligible}, once the callout is raised and accepted as a P1 emergency. ${RESPONSE_COMMITMENT.p1_emergency}. Call and describe the fault; we will tell you at that point whether it qualifies.`
        : `The emergency band applies once a callout is raised and accepted as a P1 emergency. ${RESPONSE_COMMITMENT.p1_emergency}.`,
    },
    {
      q: "Do these prices change?",
      a: "Yes. Every line on this page is dated, and this page always shows what is in force today. A written quotation issued to you locks in the rate for that job even if the published rate changes afterwards.",
    },
  ];
}

export default async function RatesPage() {
  const rates = await publishedRateCard();
  const faqs = faqsFor();

  const byService = new Map<string, PublicRateCardRow[]>();
  for (const row of rates) {
    const list = byService.get(row.serviceSlug) ?? [];
    list.push(row);
    byService.set(row.serviceSlug, list);
  }
  for (const list of byService.values()) {
    list.sort((a, b) => bandRank(a.rateBand) - bandRank(b.rateBand) || codeRank(a.code) - codeRank(b.code));
  }

  const groups = groupedServices()
    .map((g) => ({ ...g, items: g.items.filter((s) => byService.has(s.slug)) }))
    .filter((g) => g.items.length > 0);

  const publishedOn = today();

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/rates",
            name: "Schedule of Rates",
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Rates", path: "/rates" },
          ]),
          faqSchema(faqs, "/rates"),
          rateCardSchema(
            rates.map((r) => ({
              serviceSlug: r.serviceSlug,
              label: r.label,
              unit: RATE_UNIT_LABEL[r.unit] ?? r.unit,
              // Integer minor units to the decimal string the database itself
              // uses, never a float division — see `packages/core/src/money.ts`.
              priceAed: toDecimalString(r.unitPriceMinor),
            })),
          ),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            The rates we actually charge
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
          <p className="tnum mt-6 text-[13px]" style={{ color: "var(--text-muted)" }}>
            In force on {publishedOn}. Rates are dated — this page always shows today's, never a
            superseded or not-yet-effective one.
          </p>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">How to read this table</h2>
          <div className="prose-body mt-6 grid gap-6 text-[15px] md:grid-cols-2">
            <p>
              <strong>Standard</strong> is the rate during a normal working call. <strong>After hours</strong>{" "}
              and <strong>weekend</strong> are uplifts over the standard rate for the trades that take
              out-of-hours work. <strong>Emergency</strong> is the highest band, and only applies to a
              callout raised and accepted as a P1 emergency — see the FAQ below for exactly which trades
              and what that commitment is.
            </p>
            <p>
              Labour is priced per hour; a call-out fee covers the visit and the diagnosis. Materials
              bought in for the job are charged at cost plus a materials-handling line, which is not
              published because it depends on what the job needs. All prices exclude {VAT_PERCENT}% UAE
              VAT, added at invoicing.
            </p>
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          {rates.length === 0 ? (
            <div
              className="rounded p-6 text-[15px]"
              style={{ backgroundColor: "var(--surface-sunken)" }}
            >
              <p>
                Nothing is published on the rate card at the moment. Call or send a WhatsApp message and
                we will quote the job directly — every price we give you is written down and comes from
                the same rate card this page reads from.
              </p>
              <Link href="/quote" className="btn btn-primary mt-6">
                Get a quote
              </Link>
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.category} className="mb-14 last:mb-0">
                <h2 className="text-[13px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                  {group.category}
                </h2>
                {group.items.map((service) => {
                  const rows = byService.get(service.slug) ?? [];
                  return (
                    <div key={service.slug} className="mt-6">
                      <h3 className="text-[17px] font-semibold">
                        <Link href={`/services/${service.slug}`} className="hover:text-[var(--accent-text)]">
                          {service.name}
                        </Link>
                      </h3>
                      <ul className="mt-3 divide-y border-y">
                        {rows.map((rate) => (
                          <li
                            key={`${rate.code}::${rate.rateBand}`}
                            className="flex flex-wrap items-baseline justify-between gap-3 py-3"
                          >
                            <div>
                              <p className="text-[14px] font-medium">
                                {rate.label}{" "}
                                <span className="font-normal" style={{ color: "var(--text-secondary)" }}>
                                  · {RATE_BAND_LABEL[rate.rateBand] ?? rate.rateBand}
                                </span>
                              </p>
                              {rate.notes ? (
                                <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                                  {rate.notes}
                                </p>
                              ) : null}
                              {rate.minQuantity ? (
                                <p className="tnum mt-0.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
                                  Minimum {trimQuantity(rate.minQuantity)}
                                </p>
                              ) : null}
                            </div>
                            <p className="tnum shrink-0 text-[15px] font-semibold">
                              {formatMoney(rate.unitPriceMinor, rate.currency)}{" "}
                              <span className="text-[13px] font-normal" style={{ color: "var(--text-secondary)" }}>
                                {RATE_UNIT_LABEL[rate.unit] ?? rate.unit}
                              </span>
                            </p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h2 className="text-2xl font-semibold md:text-3xl">Questions about pricing</h2>
            <FaqList faqs={faqs} className="mt-6" />
          </div>
          <aside className="lg:col-span-5">
            <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[15px] font-semibold">Not listed here?</h2>
              <p className="prose-body mt-3 text-[14px]">
                Fit-out and project work — full re-piping, false-ceiling installation across a unit,
                whole-villa painting — is quoted against a written scope rather than an hourly rate,
                because the quantity varies by job. Ask for a survey and a written quotation.
              </p>
              <Link href="/quote" className="btn btn-primary mt-6">
                Get a quote
              </Link>
            </div>
          </aside>
        </div>
      </Section>
    </>
  );
}
