import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  tenant,
  areas,
  getArea,
  nearbyAreas,
  services,
  getService,
  telLink,
  graph,
  webPageSchema,
  areaServiceSchema,
  faqSchema,
  breadcrumbSchema,
  type Service,
} from "@meridian/core";
import { Section, Eyebrow, ServiceCard, AnswerBlock } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, Wrench, MapPin } from "@phosphor-icons/react/dist/ssr";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return areas.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const area = getArea(slug);
  if (!area) return {};

  return {
    title: `Property Maintenance in ${area.name}, ${area.city}`,
    description: area.summary.split(". ")[0] + ".",
    keywords: [
      `maintenance ${area.name}`,
      `plumber ${area.name}`,
      `electrician ${area.name}`,
      `AC repair ${area.name}`,
      `handyman ${area.name}`,
    ],
    alternates: { canonical: `/areas/${area.slug}` },
    openGraph: {
      type: "article",
      title: `Property Maintenance in ${area.name}`,
      description: area.summary,
      url: `/areas/${area.slug}`,
    },
  };
}

export default async function AreaPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const area = getArea(slug);
  if (!area) notFound();

  const path = `/areas/${area.slug}`;
  const topServices = area.topServices
    .map((s) => getService(s))
    .filter((s): s is Service => s !== undefined);
  const nearby = nearbyAreas(area.slug);

  // Area-specific FAQs. Generated from this area's own data, so the answers
  // differ meaningfully between areas rather than being a template fill.
  const faqs = [
    {
      q: `How quickly can you reach ${area.name}?`,
      // The commitment, not an invented median. Identical in every area we
      // travel to, because it is the SLA tier the job is raised at (JOB-4) and
      // the same deadline the dispatch board and the SLA sweep measure.
      a: `${area.name} is inside our Dubai service area, so the standard commitments apply: a P1 emergency — an active leak, total loss of cooling, an electrical fault — gets a response within 30 to 60 minutes, 24 hours a day including public holidays. Urgent work is 2 to 4 hours in working hours and routine work is within 24 hours.`,
    },
    {
      q: `What maintenance problems are most common in ${area.name}?`,
      a: `${area.commonIssues[0]}. ${area.commonIssues[1]}. These are characteristic of ${area.name} specifically: ${area.builtEnvironment.charAt(0).toLowerCase()}${area.builtEnvironment.slice(1)}`,
    },
    {
      q: `Do you offer annual maintenance contracts in ${area.name}?`,
      // No prices. Every figure in the previous version of this answer was
      // invented; WEB-16 publishes a real schedule of rates generated from the
      // rate card, and until it exists this answer describes the shape of a
      // contract rather than pretending to a price.
      a: `Yes, across ${area.city}. A contract sets out which services are covered, how many scheduled visits a year each one gets, what your callout entitlement is, and — in writing — what is excluded. It is priced from the property, its assets and the visit schedule, so we survey before quoting rather than quoting from a table.`,
    },
  ] as const;

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path,
            name: `Property Maintenance in ${area.name}, ${area.city}`,
            description: area.summary,
            primaryAnswer: area.summary,
          }),
          areaServiceSchema(area, topServices),
          faqSchema(faqs, path),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Areas", path: "/areas" },
            { name: area.name, path },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-10 pb-16 md:pt-14 md:pb-20">
          <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            <Link href="/" className="hover:underline">
              Home
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <Link href="/areas" className="hover:underline">
              Areas
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <span style={{ color: "var(--text-secondary)" }}>{area.name}</span>
          </nav>

          <div className="mt-8 grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-7">
              <Eyebrow>{area.city}</Eyebrow>
              <h1 className="mt-4 text-4xl font-semibold md:text-5xl">
                Property maintenance in {area.name}
              </h1>
              <div className="mt-8">
                <AnswerBlock>{area.summary}</AnswerBlock>
              </div>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary">
                  <PhoneCall size={17} weight="fill" aria-hidden />
                  {tenant.emergencyPhone}
                </a>
                <Link href="/quote" className="btn btn-secondary">
                  Get a quote
                </Link>
              </div>
            </div>

            <aside
              className="rounded border p-6 lg:col-span-5"
              style={{ backgroundColor: "var(--surface-raised)" }}
            >
              <h2 className="text-[15px] font-semibold">{area.name} at a glance</h2>
              <dl className="mt-5 space-y-4 text-[14px]">
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>Emergency response</dt>
                  <dd className="tnum mt-1 text-xl font-semibold">30&ndash;60 min</dd>
                  <dd className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    P1 commitment, 24/7
                  </dd>
                </div>
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>City</dt>
                  <dd className="mt-1 font-medium">{area.city}</dd>
                </div>
                <div>
                  <dt style={{ color: "var(--text-secondary)" }}>Property types covered</dt>
                  <dd className="mt-2 flex flex-wrap gap-1.5">
                    {area.propertyTypes.map((p) => (
                      <span
                        key={p}
                        className="rounded-sm border px-2 py-0.5 text-[13px]"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {p}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
            </aside>
          </div>
        </div>
      </section>

      {/* ── What the building stock is like ────────────────────────────── */}
      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-2xl font-semibold md:text-3xl">
              What we see in {area.name}
            </h2>
            <p className="prose-body mt-5">{area.builtEnvironment}</p>
            <p className="prose-body mt-4 text-[15px]">
              The faults listed here are the ones this area produces more than others. If your problem
              is on the list, we have almost certainly seen it on your street.
            </p>
          </div>
          <ul className="space-y-3 lg:col-span-7">
            {area.commonIssues.map((issue) => (
              <li
                key={issue}
                className="flex items-start gap-3 rounded border p-4 text-[15px]"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <Wrench
                  size={17}
                  aria-hidden
                  className="mt-0.5 shrink-0"
                  style={{ color: "var(--accent)" }}
                />
                {issue}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── Most requested services here ───────────────────────────────── */}
      <Section>
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">Most requested in {area.name}</h2>
          <p className="prose-body mt-4">
            Ordered by what customers here actually call about. All {services.length} services are
            available across {area.city}.
          </p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {topServices.map((s) => (
              <ServiceCard key={s.slug} service={s} />
            ))}
          </div>
          <Link href="/services" className="btn btn-secondary mt-8">
            See all services
          </Link>
        </div>
      </Section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">{area.name} questions</h2>
            <Link href="/quote" className="btn btn-primary mt-7">
              Get a quote
            </Link>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={faqs} />
          </div>
        </div>
      </Section>

      {/* ── Nearby ─────────────────────────────────────────────────────── */}
      {nearby.length > 0 ? (
        <Section>
          <div className="container-page">
            <h2 className="text-2xl font-semibold md:text-3xl">Also covered in {area.city}</h2>
            <ul className="mt-8 flex flex-wrap gap-2.5">
              {nearby.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/areas/${a.slug}`}
                    className="inline-flex items-center gap-2 rounded-sm border px-3.5 py-2 text-[14px] transition-colors hover:border-[var(--accent)]"
                    style={{ backgroundColor: "var(--surface-raised)" }}
                  >
                    <MapPin size={14} aria-hidden style={{ color: "var(--accent)" }} />
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}
    </>
  );
}
