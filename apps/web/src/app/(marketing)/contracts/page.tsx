import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  responseCommitment,
  getService,
  graph,
  webPageSchema,
  faqSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, AnswerBlock, Eyebrow } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { Check, X } from "@phosphor-icons/react/dist/ssr";

const amc = getService("amc");
const fm = getService("facility-management");
const bm = getService("building-maintenance");
const ws = getService("workforce-supply");

const ANSWER = amc?.answer ?? "";

export const metadata: Metadata = {
  title: `Annual Maintenance Contracts & Facility Management in ${tenant.address.city}`,
  description: ANSWER,
  alternates: { canonical: "/contracts" },
};

const PLANS = [
  {
    name: "Apartment AMC",
    price: "1,200",
    unit: "per year, 1-bedroom",
    visits: "4 visits",
    for: "Owners and tenants of apartments up to 3 bedrooms.",
    includes: [
      "AC service at every visit",
      "Plumbing and electrical inspection",
      "Unlimited emergency call-outs",
      "Priority dispatch",
    ],
    excludes: ["Parts and materials", "Major plant replacement"],
    featured: false,
  },
  {
    name: "Villa AMC",
    price: "3,500",
    unit: "per year, from",
    visits: "4 to 6 visits",
    for: "Villas and townhouses with multiple AC units and outdoor plant.",
    includes: [
      "All apartment AMC cover",
      "Pool and pump room checks",
      "Water tank cleaning, once a year",
      "Landscape irrigation inspection",
    ],
    excludes: ["Parts and materials", "Pool chemicals"],
    featured: true,
  },
  {
    name: "Building & FM",
    price: "2,500",
    unit: "per month, from",
    visits: "Resident or scheduled team",
    for: "Apartment buildings, offices, retail and mixed-use assets.",
    includes: [
      "Asset register and PPM schedule",
      "24-hour helpdesk with SLA tracking",
      "Common areas and MEP plant",
      "Monthly reporting pack",
    ],
    excludes: ["Capital replacement works", "Third-party statutory inspection fees"],
    featured: false,
  },
] as const;

export default function ContractsPage() {
  if (!amc) return null;
  const contractServices = [amc, bm, fm, ws].filter((s) => s !== undefined);

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/contracts",
            name: `Annual Maintenance Contracts in ${tenant.address.city}`,
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          faqSchema(amc.faqs, "/contracts"),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Contracts & AMC", path: "/contracts" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            Fixed annual fee. Unlimited call-outs.
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
          <div className="mt-9 flex flex-wrap gap-3">
            <Link href="/quote?service=amc" className="btn btn-primary">
              Request a contract quote
            </Link>
            <Link href="/services/amc" className="btn btn-secondary">
              Read the AMC detail
            </Link>
          </div>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">Plans and what they exclude</h2>
          <p className="prose-body mt-4">
            Exclusions are listed on the plan, not buried in clause 14. Everything below is quoted after a
            survey, because pricing a contract without seeing the plant is guesswork.
          </p>

          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`flex flex-col rounded p-8 ${plan.featured ? "border-2" : "border"}`}
                style={{
                  backgroundColor: "var(--surface-raised)",
                  borderColor: plan.featured ? "var(--accent)" : undefined,
                }}
              >
                <h3 className="text-xl font-semibold tracking-tight">{plan.name}</h3>
                <p className="tnum mt-3 text-3xl font-semibold">
                  {tenant.currencySymbol} {plan.price}
                </p>
                <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {plan.unit} &middot; {plan.visits}
                </p>
                <p className="prose-body mt-5 text-[14px]">{plan.for}</p>

                <ul className="mt-6 space-y-2.5 text-[14px]">
                  {plan.includes.map((inc) => (
                    <li key={inc} className="flex items-start gap-2.5">
                      <Check size={16} weight="bold" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                      {inc}
                    </li>
                  ))}
                  {plan.excludes.map((exc) => (
                    <li key={exc} className="flex items-start gap-2.5" style={{ color: "var(--text-muted)" }}>
                      <X size={16} aria-hidden className="mt-0.5 shrink-0" />
                      {exc}
                    </li>
                  ))}
                </ul>

                <Link
                  href={`/quote?service=amc`}
                  className={`btn mt-8 w-full ${plan.featured ? "btn-primary" : "btn-secondary"}`}
                >
                  Request a quote
                </Link>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          <Eyebrow>Contract types</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold md:text-3xl">
            Four ways to contract with us
          </h2>
          <div className="mt-10 grid gap-px overflow-hidden rounded border md:grid-cols-2" style={{ backgroundColor: "var(--border-hairline)" }}>
            {contractServices.map((s) => (
              <Link
                key={s.slug}
                href={`/services/${s.slug}`}
                className="group p-8 transition-colors"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <h3 className="text-lg font-semibold tracking-tight group-hover:text-[var(--accent)]">
                  {s.name}
                </h3>
                <p className="prose-body mt-3 text-[15px]">{s.answer}</p>
                {/* Price removed with the rest of the invented figures; the
                    published rate card (WEB-16) is generated from the system's
                    own rate card so it cannot drift from what is quoted. */}
                <p className="mt-5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                  {responseCommitment(s)}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">Contract questions</h2>
            <p className="prose-body mt-5 text-[15px]">
              Including the one most contractors avoid: whether a contract is actually cheaper for you.
            </p>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={amc.faqs} />
          </div>
        </div>
      </Section>
    </>
  );
}
