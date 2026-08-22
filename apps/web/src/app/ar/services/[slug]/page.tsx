import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  tenant,
  company,
  services,
  getService,
  relatedServices,
  responseCommitment,
  licensedActivity,
  graph,
  serviceSchema,
  faqSchema,
  breadcrumbSchema,
  webPageSchema,
} from "@meridian/core";
import { Section, Eyebrow, ServiceCard, CallLink } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { PendingTranslationNotice } from "@/components/pending-translation";
import { Check, Warning } from "@phosphor-icons/react/dist/ssr";
import { hreflangAlternates, serviceShortNameAr } from "@/lib/i18n";

type Params = { slug: string };

/**
 * Same ten slugs as the English catalogue — `packages/core/src/catalog.ts` is
 * the single source of truth for both locales.
 */
export function generateStaticParams(): Params[] {
  return services.map((s) => ({ slug: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const service = getService(slug);
  if (!service) return {};

  const shortAr = serviceShortNameAr(slug, service.shortName);
  return {
    title: `${shortAr} في ${tenant.address.city}`,
    description: service.answer.split(". ")[0] + ".",
    alternates: {
      canonical: `/ar/services/${service.slug}`,
      languages: hreflangAlternates(`/services/${service.slug}`),
    },
  };
}

export default async function ServicePageAr({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const service = getService(slug);
  if (!service) notFound();

  const related = relatedServices(service);
  const shortAr = serviceShortNameAr(service.slug, service.shortName);

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: `/services/${service.slug}`,
            name: `${shortAr} في ${tenant.address.city}`,
            description: service.answer,
            primaryAnswer: service.answer,
            inLanguage: "ar-AE",
          }),
          serviceSchema(service),
          faqSchema(service.faqs, `/services/${service.slug}`),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "الخدمات", path: "/ar/services" },
            { name: shortAr, path: `/ar/services/${service.slug}` },
          ]),
        )}
      />

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container-page pt-10 pb-16 md:pt-14 md:pb-20">
          <nav aria-label="مسار التصفح" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            <Link href="/ar" className="hover:underline">
              الرئيسية
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <Link href="/ar/services" className="hover:underline">
              الخدمات
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <span style={{ color: "var(--text-secondary)" }}>{shortAr}</span>
          </nav>

          <div className="mt-8 grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-7">
              <Eyebrow>نشاط مرخّص</Eyebrow>
              <h1 className="mt-4 text-4xl font-semibold md:text-5xl">
                {shortAr} في {tenant.address.city}
              </h1>
              <p className="prose-body mt-6 text-[15px]">
                التفاصيل الكاملة لهذه الخدمة — الوصف، نطاق العمل، الأسئلة الشائعة — أدناه بالإنجليزية ريثما
                تُترجم رسميًا.
              </p>
              <div className="mt-6">
                <PendingTranslationNotice />
              </div>

              <div className="mt-9 flex flex-wrap items-center gap-3">
                <Link href="/ar/contact" className="btn btn-primary">
                  تواصل معنا
                </Link>
                {service.emergency ? (
                  <CallLink phone={tenant.emergencyPhone} label="خط 24/7" className="btn btn-secondary" />
                ) : null}
              </div>
            </div>

            <aside className="rounded border p-6 lg:col-span-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[15px] font-semibold">نظرة سريعة</h2>
              <dl className="mt-5 space-y-4 text-[14px]">
                {company.licenceNumber ? (
                  <div className="border-b pb-4">
                    <dt style={{ color: "var(--text-secondary)" }}>مرخّص لهذا العمل</dt>
                    <dd className="mt-1 font-medium" dir="ltr" style={{ textAlign: "start" }}>
                      {licensedActivity(service.licensedActivity).licenceWording}
                    </dd>
                    <dd className="tnum text-[13px]" style={{ color: "var(--text-muted)" }} dir="ltr">
                      {company.licenceIssuer} — {company.licenceNumber}
                    </dd>
                  </div>
                ) : null}
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>وقت الاستجابة</dt>
                  <dd className="mt-1 font-medium" dir="ltr" style={{ textAlign: "start" }}>
                    {responseCommitment(service)}
                  </dd>
                </div>
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>تغطية الطوارئ</dt>
                  <dd className="mt-1 font-medium">{service.emergency ? "نعم، على مدار الساعة" : "بالجدولة خلال ساعات العمل"}</dd>
                </div>
                <div>
                  <dt style={{ color: "var(--text-secondary)" }}>مشمولة بعقد الصيانة السنوي</dt>
                  <dd className="mt-1 font-medium">{service.amcEligible ? "نعم، ضمن العقد" : "تُسعّر بشكل منفصل"}</dd>
                </div>
              </dl>
            </aside>
          </div>
        </div>
      </section>

      {/* ── Scope, exclusions, common problems, FAQ — see the delivery report:
          this is licensed-activity content and stays in English pending
          professional translation. ── */}
      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">نطاق العمل والتفاصيل الفنية</h2>
          <p className="prose-body mt-4 max-w-2xl">
            التفاصيل الكاملة — نطاق العمل، الاستثناءات، الأعطال الشائعة، والأسئلة المتكررة — أدناه بالإنجليزية
            ريثما تُترجم رسميًا. اتصل بنا وسنشرحها لك مباشرة بالعربية.
          </p>
          <div className="mt-6 max-w-2xl">
            <PendingTranslationNotice />
          </div>

          {/*
            `service.answer` is the `description`/`primaryAnswer` this page's
            JSON-LD carries (`serviceSchema`, `webPageSchema`) — shown here,
            visibly, in English, so the structured-data claim has a visible
            counterpart on the page per the AEO rule in
            `docs/architecture/06-aeo-geo.md` ("never mark up a claim the page
            does not also state in visible text"). Not translated, for the
            same reason as the rest of this section.
          */}
          <div dir="ltr" lang="en" style={{ textAlign: "start" }} className="mt-8 max-w-2xl">
            <p className="prose-body text-[15px]">{service.answer}</p>
          </div>

          <div dir="ltr" lang="en" style={{ textAlign: "start" }} className="mt-10">
            <div className="grid gap-12 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <h3 className="text-[15px] font-semibold" style={{ color: "var(--text-secondary)" }}>
                  What the work covers
                </h3>
                {service.exclusions.length > 0 ? (
                  <div className="mt-6 rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                    <h4 className="text-[14px] font-semibold">Not included</h4>
                    <ul className="mt-3 space-y-2 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                      {service.exclusions.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
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
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">ما الذي يتصل الناس بشأنه</h2>
          <div dir="ltr" lang="en" style={{ textAlign: "start" }} className="mt-8 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {service.commonProblems.map((problem) => (
              <div key={problem} className="rounded border p-5" style={{ backgroundColor: "var(--surface-raised)" }}>
                <Warning size={18} aria-hidden style={{ color: "var(--accent)" }} />
                <p className="mt-3 text-[15px] leading-relaxed">{problem}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">أسئلة عن {shortAr}</h2>
            <p className="prose-body mt-5 text-[15px]">
              الأسئلة أدناه بالإنجليزية ريثما تُترجم. تواصل معنا للحصول على إجابات بالعربية مباشرة.
            </p>
            <Link href="/ar/contact" className="btn btn-primary mt-7">
              تواصل معنا
            </Link>
          </div>
          <div className="lg:col-span-8" dir="ltr" lang="en" style={{ textAlign: "start" }}>
            <FaqList faqs={service.faqs} />
          </div>
        </div>
      </Section>

      {related.length > 0 ? (
        <Section>
          <div className="container-page">
            <h2 className="text-2xl font-semibold md:text-3xl">غالبًا ما تُطلب معها</h2>
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
