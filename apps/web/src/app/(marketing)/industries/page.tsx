import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  industries,
  servicesForIndustry,
  graph,
  webPageSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, AnswerBlock } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";

const ANSWER = `${tenant.brandName} works for ${industries.length} distinct client types including property developers, owners associations, facility management companies, hotels, commercial offices, retail, residential communities and industrial sites, delivering both single call-outs and multi-year maintenance contracts.`;

export const metadata: Metadata = {
  title: "Industries We Serve",
  description: ANSWER,
  alternates: { canonical: "/industries" },
};

const anchor = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export default function IndustriesPage() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/industries",
            name: "Industries We Serve",
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Industries", path: "/industries" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            Built for buildings people depend on
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
        </div>
      </section>

      <Section>
        <div className="container-page space-y-16">
          {industries.map((industry) => {
            const matched = servicesForIndustry(industry);
            return (
              <div key={industry} id={anchor(industry)} className="scroll-mt-24">
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b pb-3">
                  <h2 className="text-2xl font-semibold tracking-tight">{industry}</h2>
                  <p className="tnum text-[14px]" style={{ color: "var(--text-muted)" }}>
                    {matched.length} services
                  </p>
                </div>
                <ul className="mt-6 flex flex-wrap gap-2.5">
                  {matched.map((s) => (
                    <li key={s.slug}>
                      <Link
                        href={`/services/${s.slug}`}
                        className="inline-block rounded-sm border px-3 py-1.5 text-[14px] transition-colors hover:border-[var(--accent)]"
                        style={{ backgroundColor: "var(--surface-raised)", color: "var(--text-secondary)" }}
                      >
                        {s.shortName}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </Section>

      <Section tone="sunken" className="!py-20">
        <div className="container-page">
          <div className="rounded border p-10 md:p-14" style={{ backgroundColor: "var(--surface-raised)" }}>
            <h2 className="max-w-2xl text-3xl font-semibold md:text-4xl">
              Managing a portfolio rather than a property?
            </h2>
            <p className="prose-body mt-5">
              Multi-site contracts are surveyed and priced per asset, with one account manager and one
              monthly reporting pack across every building.
            </p>
            <Link href="/quote?service=facility-management" className="btn btn-primary mt-8">
              Request a portfolio survey
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
