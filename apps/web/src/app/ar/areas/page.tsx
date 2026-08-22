import type { Metadata } from "next";
import Link from "next/link";
import { tenant, groupedAreas, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { Section } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { MapPin } from "@phosphor-icons/react/dist/ssr";
import { hreflangAlternates, areaNameAr } from "@/lib/i18n";

const DESCRIPTION_AR = `تغطي ${tenant.brandName} ${tenant.serviceAreas.reduce((n, a) => n + a.areas.length, 0)} منطقة في ${tenant.address.city}، بفنيين متمركزين في المجتمعات التي يخدمونها بدلًا من الانطلاق من مستودع مركزي واحد.`;

export const metadata: Metadata = {
  title: "المناطق التي نغطيها",
  description: DESCRIPTION_AR,
  alternates: { canonical: "/ar/areas", languages: hreflangAlternates("/areas") },
};

export default function AreasIndexPageAr() {
  const groups = groupedAreas();

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/areas",
            name: "المناطق التي نغطيها",
            description: DESCRIPTION_AR,
            primaryAnswer: DESCRIPTION_AR,
            inLanguage: "ar-AE",
          }),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "المناطق", path: "/ar/areas" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">متمركزون حيث نعمل</h1>
          <p className="prose-body mt-8 text-[17px] md:text-[18px]">{DESCRIPTION_AR}</p>
          <p className="prose-body mt-6">
            لكل منطقة أدناه ملفها الخاص. تختلف أعطال شقة في مرسى دبي عن أعطال فيلا في المرابع العربية، ومعرفة
            ذلك مسبقًا هو معظم سرّ الإصلاح من أول زيارة.
          </p>
        </div>
      </section>

      {groups.map((group, i) => (
        <Section key={group.city.slug} tone={i % 2 === 0 ? "default" : "sunken"}>
          <div className="container-page">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <h2 className="text-2xl font-semibold md:text-3xl">{group.city.name === "Dubai" ? "دبي" : group.city.name}</h2>
              <p className="tnum text-[14px]" style={{ color: "var(--text-muted)" }}>
                {group.items.length} مناطق
              </p>
            </div>

            <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {group.items.map((area) => (
                <Link
                  key={area.slug}
                  href={`/ar/areas/${area.slug}`}
                  className="group flex flex-col justify-between rounded border p-6 transition-colors hover:border-[var(--border-strong)]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  <div>
                    <div className="flex items-start gap-2">
                      <MapPin size={17} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                      <h3 className="text-[17px] font-semibold tracking-tight group-hover:text-[var(--accent-text)]">
                        {areaNameAr(area.slug, area.name)}
                      </h3>
                    </div>
                  </div>
                  <p className="tnum mt-5 text-[13px]" style={{ color: "var(--text-muted)" }} dir="ltr">
                    P1 30–60 min
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
            <h2 className="max-w-2xl text-3xl font-semibold md:text-4xl">منطقتك غير مدرجة؟</h2>
            <p className="prose-body mt-5">
              نغطي مناطق أوسع من {tenant.address.city} مما هو مفصّل هنا. اتصل بنا وسنخبرك بصراحة إن كنا نستطيع
              الوصول إليك.
            </p>
            <Link href="/ar/contact" className="btn btn-primary mt-8">
              تحقق من التغطية
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
