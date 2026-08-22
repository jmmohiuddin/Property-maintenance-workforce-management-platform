import type { Metadata } from "next";
import Link from "next/link";
import { tenant, services, LICENSED_ACTIVITY_REGISTER, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { Section } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { PendingTranslationNotice } from "@/components/pending-translation";
import { hreflangAlternates } from "@/lib/i18n";

const TITLE_AR = "عشرة أنشطة مرخصة. لا شيء خارجها.";
const DESCRIPTION_AR =
  "شركة صيانة عقارات في دبي، مرخّصة من دائرة الاقتصاد والسياحة بدبي لعشرة أنشطة فنية، تعمل عبر عقود صيانة سنوية وأعمال طارئة ومشاريع تشطيب في جميع أنحاء دبي.";

export const metadata: Metadata = {
  title: "من نحن",
  description: DESCRIPTION_AR,
  alternates: { canonical: "/ar/about", languages: hreflangAlternates("/about") },
};

export default function AboutPageAr() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/about",
            name: "من نحن",
            description: DESCRIPTION_AR,
            primaryAnswer: DESCRIPTION_AR,
            inLanguage: "ar-AE",
          }),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "من نحن", path: "/ar/about" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">{TITLE_AR}</h1>
          <p className="prose-body mt-8 text-[17px] md:text-[18px]">{DESCRIPTION_AR}</p>
        </div>
      </section>

      <Section>
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">لماذا الترخيص هو القصة كاملة</h2>
          <div className="prose-body mt-6 max-w-3xl space-y-4 text-[16px]">
            <p>
              تحدّد الرخصة التجارية في دبي الأنشطة التي يجوز للشركة القيام بها. رخصتنا تسمّي عشرة أنشطة. هذه
              القائمة ليست نصًا تسويقيًا — بل الحدود القانونية للنشاط، وتقديم عرض سعر خارجها يُعد مخالفة ترخيص
              وليس مجرد تجاوز بسيط.
            </p>
            <p>
              لذلك ننشرها، ونبني النظام حولها. كتالوج خدماتنا مشتق من الرخصة ولا يتجاوزها. إن طلبتَ منا عملًا
              من القائمة الثانية أدناه، ستسمع ذلك عند الاستفسار وليس عند الفاتورة.
            </p>
          </div>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <aside className="lg:col-span-7">
            <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[15px] font-semibold">الأنشطة المرخصة</h2>
              <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                معروضة كما وردت حرفيًا على الرخصة التجارية — بالإنجليزية، دون أي إعادة صياغة.
              </p>
              <div className="mt-4">
                <PendingTranslationNotice dense />
              </div>
              <ul className="mt-4 space-y-2 text-[14px]" dir="ltr" style={{ textAlign: "start" }}>
                {LICENSED_ACTIVITY_REGISTER.map((a) => (
                  <li key={a.key} className="flex items-baseline justify-between gap-4 border-b pb-2 last:border-0">
                    <span>{a.licenceWording}</span>
                    <span className="shrink-0 text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {a.family}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[13px]" style={{ color: "var(--text-muted)" }}>
                {services.length} صفحة خدمة، صفحة واحدة لكل نشاط.
              </p>
            </div>
          </aside>

          <div className="lg:col-span-5">
            <h2 className="text-2xl font-semibold md:text-3xl">الرخصة</h2>
            {tenant.licences.length > 0 ? (
              <dl className="mt-6 divide-y border-y" dir="ltr" style={{ textAlign: "start" }}>
                {tenant.licences.map((l) => (
                  <div key={l.ref} className="py-4">
                    <div className="flex items-baseline justify-between gap-6">
                      <div>
                        <dt className="text-[15px] font-medium">{l.name}</dt>
                        <dd className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                          {l.issuer}
                        </dd>
                      </div>
                      <dd className="tnum shrink-0 text-[14px] font-medium">{l.ref}</dd>
                    </div>
                  </div>
                ))}
              </dl>
            ) : null}
            <p className="prose-body mt-8 text-[15px]">
              اعتمادات أخرى — تسجيل هيئة كهرباء ومياه دبي، وثائق التأمين، الشهادات من جهات خارجية — تُدرج هنا فقط
              حين تتوفر الوثيقة سارية المفعول. اطلب وسنرسل لك المستندات الحالية.
            </p>
            <Link href="/ar/contact" className="btn btn-primary mt-9">
              تواصل معنا
            </Link>
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">ما لسنا مرخّصين له</h2>
          <p className="prose-body mt-4 max-w-2xl">
            أعمال يُطلب منا القيام بها بانتظام، ونعتذر عنها. حيث يمكننا توجيهك لمن يحمل الترخيص الصحيح، نفعل ذلك.
          </p>
          <ul className="prose-body mt-6 max-w-2xl space-y-3 text-[15px]">
            {[
              "أعمال الزجاج والألمنيوم",
              "مكافحة الآفات",
              "تنظيف الواجهات والعمل بالحبال المعلّقة",
              "العمل على مصدر التيار الكهربائي أو العداد أو لوحة التوزيع الرئيسية",
              "معدات حمامات السباحة",
              "الأعمال الإنشائية والمدنية",
            ].map((item) => (
              <li key={item} className="border-b pb-3">
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>
    </>
  );
}
