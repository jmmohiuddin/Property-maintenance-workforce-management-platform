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
  graph,
  webPageSchema,
  areaServiceSchema,
  breadcrumbSchema,
  telLink,
  type Service,
} from "@meridian/core";
import { Section, Eyebrow, ServiceCard } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { PendingTranslationNotice } from "@/components/pending-translation";
import { PhoneCall, MapPin } from "@phosphor-icons/react/dist/ssr";
import { hreflangAlternates, areaNameAr, propertyTypeAr } from "@/lib/i18n";

type Params = { slug: string };

/** Same ten slugs as the English area pages — `packages/core/src/areas.ts` is shared. */
export function generateStaticParams(): Params[] {
  return areas.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const area = getArea(slug);
  if (!area) return {};

  const nameAr = areaNameAr(slug, area.name);
  return {
    title: `صيانة عقارات في ${nameAr}`,
    description: area.summary.split(". ")[0] + ".",
    alternates: {
      canonical: `/ar/areas/${area.slug}`,
      languages: hreflangAlternates(`/areas/${area.slug}`),
    },
  };
}

export default async function AreaPageAr({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const area = getArea(slug);
  if (!area) notFound();

  const nameAr = areaNameAr(area.slug, area.name);
  const topServices = area.topServices
    .map((s) => getService(s))
    .filter((s): s is Service => s !== undefined);
  const nearby = nearbyAreas(area.slug);

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: `/areas/${area.slug}`,
            name: `صيانة عقارات في ${nameAr}`,
            description: area.summary,
            primaryAnswer: area.summary,
            inLanguage: "ar-AE",
          }),
          areaServiceSchema(area, topServices),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "المناطق", path: "/ar/areas" },
            { name: nameAr, path: `/ar/areas/${area.slug}` },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-10 pb-16 md:pt-14 md:pb-20">
          <nav aria-label="مسار التصفح" className="text-[13px]" style={{ color: "var(--text-muted)" }}>
            <Link href="/ar" className="hover:underline">
              الرئيسية
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <Link href="/ar/areas" className="hover:underline">
              المناطق
            </Link>
            <span className="mx-2" aria-hidden>
              /
            </span>
            <span style={{ color: "var(--text-secondary)" }}>{nameAr}</span>
          </nav>

          <div className="mt-8 grid gap-12 lg:grid-cols-12 lg:gap-16">
            <div className="lg:col-span-7">
              <Eyebrow>{area.city === "Dubai" ? "دبي" : area.city}</Eyebrow>
              <h1 className="mt-4 text-4xl font-semibold md:text-5xl">صيانة عقارات في {nameAr}</h1>
              <p className="prose-body mt-6 text-[15px]">
                وصف تفصيلي لملف {nameAr} الفني — نوع المباني والأعطال الشائعة فيها — أدناه بالإنجليزية ريثما
                يُترجم رسميًا.
              </p>
              <div className="mt-6">
                <PendingTranslationNotice />
              </div>
              {/* `area.summary` is this page's JSON-LD `description`/
                  `primaryAnswer` (`webPageSchema`, `areaServiceSchema`) —
                  shown visibly here so the claim has a visible counterpart,
                  per the AEO rule in `docs/architecture/06-aeo-geo.md`. */}
              <div dir="ltr" lang="en" style={{ textAlign: "start" }} className="mt-6">
                <p className="prose-body text-[15px]">{area.summary}</p>
              </div>
              <div className="mt-9 flex flex-wrap items-center gap-3">
                <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary" dir="ltr">
                  <PhoneCall size={17} weight="fill" aria-hidden />
                  {tenant.emergencyPhone}
                </a>
                <Link href="/ar/contact" className="btn btn-secondary">
                  تواصل معنا
                </Link>
              </div>
            </div>

            <aside className="rounded border p-6 lg:col-span-5" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[15px] font-semibold">{nameAr} بإيجاز</h2>
              <dl className="mt-5 space-y-4 text-[14px]">
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>استجابة الطوارئ</dt>
                  <dd className="tnum mt-1 text-xl font-semibold" dir="ltr">
                    30–60 دقيقة
                  </dd>
                  <dd className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                    التزام الفئة الأولى، على مدار الساعة
                  </dd>
                </div>
                <div className="border-b pb-4">
                  <dt style={{ color: "var(--text-secondary)" }}>المدينة</dt>
                  <dd className="mt-1 font-medium">{area.city === "Dubai" ? "دبي" : area.city}</dd>
                </div>
                <div>
                  <dt style={{ color: "var(--text-secondary)" }}>أنواع العقارات المشمولة</dt>
                  <dd className="mt-2 flex flex-wrap gap-1.5">
                    {area.propertyTypes.map((p) => (
                      <span key={p} className="rounded-sm border px-2 py-0.5 text-[13px]" style={{ color: "var(--text-secondary)" }}>
                        {propertyTypeAr(p)}
                      </span>
                    ))}
                  </dd>
                </div>
              </dl>
            </aside>
          </div>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">ملف {nameAr} الفني</h2>
          <p className="prose-body mt-4 max-w-2xl">
            طبيعة المباني والأعطال الأكثر شيوعًا في هذه المنطقة تحديدًا، أدناه بالإنجليزية ريثما تُترجم.
          </p>
          <div dir="ltr" lang="en" style={{ textAlign: "start" }} className="mt-8 grid gap-12 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <p className="prose-body">{area.builtEnvironment}</p>
            </div>
            <ul className="space-y-3 lg:col-span-7">
              {area.commonIssues.map((issue) => (
                <li key={issue} className="rounded border p-4 text-[15px]" style={{ backgroundColor: "var(--surface-raised)" }}>
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">الأكثر طلبًا في {nameAr}</h2>
          <p className="prose-body mt-4">جميع {services.length} الخدمات متاحة في {area.city === "Dubai" ? "دبي" : area.city}.</p>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {topServices.map((s) => (
              <ServiceCard key={s.slug} service={s} />
            ))}
          </div>
          <Link href="/ar/services" className="btn btn-secondary mt-8">
            عرض جميع الخدمات
          </Link>
        </div>
      </Section>

      {nearby.length > 0 ? (
        <Section tone="sunken">
          <div className="container-page">
            <h2 className="text-2xl font-semibold md:text-3xl">
              مناطق أخرى مغطاة في {area.city === "Dubai" ? "دبي" : area.city}
            </h2>
            <ul className="mt-8 flex flex-wrap gap-2.5">
              {nearby.map((a) => (
                <li key={a.slug}>
                  <Link
                    href={`/ar/areas/${a.slug}`}
                    className="inline-flex items-center gap-2 rounded-sm border px-3.5 py-2 text-[14px] transition-colors hover:border-[var(--accent)]"
                    style={{ backgroundColor: "var(--surface-raised)" }}
                  >
                    <MapPin size={14} aria-hidden style={{ color: "var(--accent)" }} />
                    {areaNameAr(a.slug, a.name)}
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
