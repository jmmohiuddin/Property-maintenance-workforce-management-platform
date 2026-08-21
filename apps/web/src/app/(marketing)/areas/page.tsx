import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  areas,
  groupedAreas,
  graph,
  webPageSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, AnswerBlock } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { MapPin } from "@phosphor-icons/react/dist/ssr";

const ANSWER = `${tenant.brandName} covers ${areas.length} areas across ${tenant.serviceAreas
  .map((a) => a.name)
  .join(", ")}, with technicians based in the communities they serve rather than dispatched from a single depot. Median emergency arrival is ${tenant.emergencyResponseMinutes} minutes inside ${tenant.address.city}.`;

export const metadata: Metadata = {
  title: "Areas We Cover",
  description: ANSWER,
  alternates: { canonical: "/areas" },
};

export default function AreasIndexPage() {
  const groups = groupedAreas();

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/areas",
            name: "Areas We Cover",
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Areas", path: "/areas" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            Based where we work
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
          <p className="prose-body mt-6">
            Every area below has its own maintenance profile. A Marina apartment and a Ranches villa
            fail in different ways, and knowing which before arriving is most of a first-time fix.
          </p>
        </div>
      </section>

      {groups.map((group, i) => (
        <Section key={group.city.slug} tone={i % 2 === 0 ? "default" : "sunken"}>
          <div className="container-page">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div className="flex items-baseline gap-3">
                <h2 className="text-2xl font-semibold md:text-3xl">{group.city.name}</h2>
                {group.city.primary ? (
                  <span
                    className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
                  >
                    Primary
                  </span>
                ) : null}
              </div>
              <p className="tnum text-[14px]" style={{ color: "var(--text-muted)" }}>
                {group.items.length} areas
              </p>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {group.items.map((area) => (
                <Link
                  key={area.slug}
                  href={`/areas/${area.slug}`}
                  className="group flex flex-col justify-between rounded border p-6 transition-colors hover:border-[var(--border-strong)]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <div>
                    <div className="flex items-start gap-2">
                      <MapPin
                        size={17}
                        aria-hidden
                        className="mt-0.5 shrink-0"
                        style={{ color: "var(--accent)" }}
                      />
                      <h3 className="text-[17px] font-semibold tracking-tight group-hover:text-[var(--accent-text)]">
                        {area.name}
                      </h3>
                    </div>
                    <p className="prose-body mt-3 text-[14px]">{area.commonIssues[0]}</p>
                  </div>
                  <p className="tnum mt-5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                    P1 emergency response 30&ndash;60 min
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </Section>
      ))}

      <Section tone="sunken" className="!py-20">
        <div className="container-page">
          <div className="rounded border p-10 md:p-14" style={{ backgroundColor: "var(--surface-raised)" }}>
            <h2 className="max-w-2xl text-3xl font-semibold md:text-4xl">
              Not on the list?
            </h2>
            <p className="prose-body mt-5">
              We cover more of {tenant.serviceAreas.map((a) => a.name).join(", ")} than the areas
              detailed here. Those pages exist where we have enough local history to say something
              useful. Call and we will tell you plainly whether we can reach you.
            </p>
            <Link href="/contact" className="btn btn-primary mt-8">
              Check coverage
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
