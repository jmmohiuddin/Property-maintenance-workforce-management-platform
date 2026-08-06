import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  tenant,
  services,
  getService,
  relatedServices,
  telLink,
  whatsappLink,
  graph,
  serviceSchema,
  faqSchema,
  breadcrumbSchema,
  webPageSchema,
} from "@meridian/core";
import { Section, Eyebrow, ServiceCard, AnswerBlock } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, WhatsappLogo, Check, Warning } from "@phosphor-icons/react/dist/ssr";

type Params = { slug: string };

/** All 24 pages are prerendered at build time. Nothing here needs a request. */
export function generateStaticParams(): Params[] {
  return services.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const service = getService(slug);
  if (!service) return {};

  return {
    title: `${service.name} in ${tenant.address.city}`,
    // The meta description is the `answer`, truncated at a sentence boundary
    // rather than mid-word, because this string is frequently what gets quoted.
    description: service.answer.split(". ")[0] + ".",
    keywords: [...service.aliases, service.name, `${service.shortName} ${tenant.address.city}`],
    alternates: { canonical: `/services/${service.slug}` },
    openGraph: {
      type: "article",
      title: `${service.name} in ${tenant.address.city}`,
      description: service.answer,
      url: `/services/${service.slug}`,
    },
  };
}

export default async function ServicePage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const service = getService(slug);
  if (!service) notFound();

  const related = relatedServices(slug);
  const path = `/services/${service.slug}`;

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path,
            name: `${service.name} in ${tenant.address.city}`,
            description: service.answer,
            primaryAnswer: service.answer,
          }),
          serviceSchema(service),
          faqSchema(service.faqs, path),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Services", path: "/services" },
            { name: service.name, path },
          ]),
        )}
      />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container-page pt-10 pb-16 md:pt-14 md:pb-20">
          <nav aria-label="Breadcrumb" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            <Link href="/" className="hover:underline">
              Home
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <Link href="/services" className="hover:underline">
              Services
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <span style={{ color: "var(--text-secondary)" }}>{service.shortName}</span>
          </nav>

          <div className="mt-8 grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-7">
              <Eyebrow>{service.category}</Eyebrow>
              <h1 className="mt-4 text-4xl font-semibold md:text-5xl">
                {service.name} in {tenant.address.city}
              </h1>

              {/* The answer engines' target paragraph, first thing after H1. */}
              <div className="mt-8">
                <AnswerBlock>{service.answer}</AnswerBlock>
              </div>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href={`/quote?service=${service.slug}`} className="btn btn-primary">
                  Get a quote
                </Link>
                {service.emergency ? (
                  <a href={telLink(tenant.emergencyPhone)} className="btn btn-secondary">
                    <PhoneCall size={17} weight="fill" aria-hidden />
                    24/7 line
                  </a>
                ) : (
                  <a
                    href={whatsappLink(`Hello ${tenant.brandName}, I would like a quote for ${service.name}.`)}
                    className="btn btn-secondary"
                  >
                    <WhatsappLogo size={17} weight="fill" aria-hidden />
                    WhatsApp
                  </a>
                )}
              </div>
            </div>

            <aside className="rounded border p-6 lg:col-span-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[15px] font-semibold">At a glance</h2>
              <dl className="mt-5 space-y-4 text-[14px]">
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>Price from</dt>
                  <dd className="tnum mt-1 text-xl font-semibold">
                    {tenant.currencySymbol} {service.priceFrom.amount}
                  </dd>
                  <dd className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    {service.priceFrom.unit}
                  </dd>
                </div>
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>Response time</dt>
                  <dd className="mt-1 font-medium">{service.responseTime}</dd>
                </div>
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>Emergency cover</dt>
                  <dd className="mt-1 font-medium">
                    {service.emergency ? "Yes, 24 hours a day" : "Scheduled during working hours"}
                  </dd>
                </div>
                <div>
                  <dt style={{ color: "var(--text-secondary)" }}>Covered by AMC</dt>
                  <dd className="mt-1 font-medium">
                    {service.amcEligible ? "Yes, included in contract" : "Quoted separately"}
                  </dd>
                </div>
              </dl>
              <p className="mt-5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                Available across {tenant.serviceAreas.map((a) => a.name).join(", ")}.
              </p>
            </aside>
          </div>
        </div>
      </section>

      {/* ── Scope ──────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-2xl font-semibold md:text-3xl">What the work covers</h2>
            <p className="prose-body mt-4">
              The full scope we carry out under {service.shortName.toLowerCase()}. Anything outside this list
              is quoted separately rather than added to your invoice after the fact.
            </p>
            <img
              src={`https://picsum.photos/seed/meridian-scope-${service.slug}/800/560`}
              alt=""
              loading="lazy"
              width={800}
              height={560}
              className="mt-8 hidden w-full rounded object-cover lg:block"
            />
          </div>
          <ul className="space-y-3 lg:col-span-7">
            {service.scope.map((item) => (
              <li
                key={item}
                className="flex items-start gap-3 rounded border p-4 text-[15px]"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <Check size={17} weight="bold" aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── Symptoms ───────────────────────────────────────────────────── */}
      <Section>
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">What people call us about</h2>
          <p className="prose-body mt-4">
            If any of these describe your situation, you are in the right place. Describing the symptom is
            enough; you do not need to know the cause.
          </p>
          <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {service.commonProblems.map((problem) => (
              <div key={problem} className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                <Warning size={18} aria-hidden style={{ color: "var(--accent)" }} />
                <p className="mt-3 text-[15px] leading-relaxed">{problem}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">
              {service.shortName} questions, answered
            </h2>
            <p className="prose-body mt-5 text-[15px]">
              Straight answers with numbers in them. If the honest answer is that you do not need the work,
              we will say that too.
            </p>
            <Link href={`/quote?service=${service.slug}`} className="btn btn-primary mt-7">
              Get a quote
            </Link>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={service.faqs} />
          </div>
        </div>
      </Section>

      {/* ── Related ────────────────────────────────────────────────────── */}
      {related.length > 0 ? (
        <Section>
          <div className="container-page">
            <h2 className="text-2xl font-semibold md:text-3xl">Often needed alongside</h2>
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((r) => (
                <ServiceCard key={r.slug} service={r} />
              ))}
            </div>
          </div>
        </Section>
      ) : null}
    </>
  );
}
