import type { Metadata } from "next";
import {
  tenant,
  services,
  groupedServices,
  CATEGORY_BLURB,
  graph,
  webPageSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, ServiceCard, AnswerBlock } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { hreflangAlternates } from "@/lib/i18n";

// Built from the catalogue rather than written out, because the written-out
// version drifted and became false. It advertised pest control, CCTV,
// smart-home installation, full facility management and contract workforce
// supply -- none of which are on the DET licence, and the first of which
// `/about` simultaneously lists under "What we are not licensed for". This
// string is the meta description, the JSON-LD `description` and
// `primaryAnswer`, and the visible answer block, so the claim was reaching
// search engines and answer engines as structured fact. Deriving it means a
// service that leaves the licence leaves this sentence in the same commit.
const ANSWER = `${tenant.brandName} provides ${services.length} licensed maintenance and technical services across ${tenant.serviceAreas
  .map((a) => a.name)
  .join(", ")}: ${services.map((s) => s.shortName.toLowerCase()).join(", ")}.`;

export const metadata: Metadata = {
  title: "All Services",
  description: ANSWER,
  alternates: { canonical: "/services", languages: hreflangAlternates("/services") },
};

export default function ServicesIndexPage() {
  const groups = groupedServices();

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/services",
            name: `Maintenance Services in ${tenant.address.city}`,
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Services", path: "/services" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            Every trade, under one contractor
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
        </div>
      </section>

      {groups.map((group, i) => (
        <Section key={group.category} tone={i % 2 === 0 ? "default" : "sunken"}>
          <div className="container-page">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-2xl font-semibold md:text-3xl">{group.category}</h2>
              <p className="tnum text-[14px]" style={{ color: "var(--text-muted)" }}>
                {group.items.length} services
              </p>
            </div>
            <p className="prose-body mt-4">{CATEGORY_BLURB[group.category]}</p>
            {/* Placeholder photography removed — WEB-3 / D-5. */}
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {group.items.map((service) => (
                <ServiceCard key={service.slug} service={service} />
              ))}
            </div>
          </div>
        </Section>
      ))}
    </>
  );
}
