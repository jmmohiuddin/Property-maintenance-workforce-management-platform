import type { Metadata } from "next";
import { tenant, groupedServices, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { Section, ServiceCard } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { hreflangAlternates, categoryLabelAr } from "@/lib/i18n";

const DESCRIPTION_AR = `تقدّم ${tenant.brandName} عشرة أنشطة صيانة وأعمال فنية مرخّصة في ${tenant.address.city}: السباكة، الكهرباء، التكييف، الأعمال الكهروميكانيكية، الأسقف المعلقة، التبليط، النجارة، الدهانات، ورق الجدران، وتنظيف المباني — إلى جانب عقود الصيانة السنوية.`;

export const metadata: Metadata = {
  title: "جميع الخدمات",
  description: DESCRIPTION_AR,
  alternates: { canonical: "/ar/services", languages: hreflangAlternates("/services") },
};

export default function ServicesIndexPageAr() {
  const groups = groupedServices();

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/services",
            name: `خدمات الصيانة في ${tenant.address.city}`,
            description: DESCRIPTION_AR,
            primaryAnswer: DESCRIPTION_AR,
            inLanguage: "ar-AE",
          }),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "الخدمات", path: "/ar/services" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">كل الحرف، تحت مقاول واحد</h1>
          <p className="prose-body mt-8 text-[17px] md:text-[18px]">{DESCRIPTION_AR}</p>
          <p className="prose-body mt-4 text-[13px]">
            أسماء الخدمات وتفاصيلها الكاملة أدناه معروضة بالإنجليزية — وهي صيغة الترخيص التجاري — ريثما تُعتمد
            ترجمتها العربية الرسمية.
          </p>
        </div>
      </section>

      {groups.map((group, i) => (
        <Section key={group.category} tone={i % 2 === 0 ? "default" : "sunken"}>
          <div className="container-page">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-2xl font-semibold md:text-3xl">{categoryLabelAr(group.category)}</h2>
              <p className="tnum text-[14px]" style={{ color: "var(--text-muted)" }}>
                {group.items.length} خدمات
              </p>
            </div>
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
