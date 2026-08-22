import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  company,
  services,
  groupedServices,
  emergencyServices,
  areas,
  areasInCity,
  telLink,
  whatsappLink,
  graph,
  webPageSchema,
  faqSchema,
} from "@meridian/core";
import { Section, Eyebrow, ServiceCard, AnswerBlock, CallLink } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, WhatsappLogo, MapPin } from "@phosphor-icons/react/dist/ssr";
import { ELEVATOR_ANSWER_AR, hreflangAlternates, categoryLabelAr, serviceShortNameAr, areaNameAr } from "@/lib/i18n";

export const metadata: Metadata = {
  title: `صيانة العقارات وإدارة المرافق في ${tenant.address.city}`,
  description: ELEVATOR_ANSWER_AR,
  alternates: { canonical: "/ar", languages: hreflangAlternates("/") },
};

/**
 * Home page FAQs, translated. `HOME_FAQS[5]` on the English page enumerates
 * all ten licensed activities by their DET wording ("painting, wallpaper,
 * false ceilings, tiling, ..."); that content is not reproduced here — it is
 * not translated anywhere on `/ar` (see `@/lib/i18n`), and repeating it lives
 * on `/about` in its structural, English-with-notice form instead of as a
 * mixed-language FAQ entry.
 */
const HOME_FAQS_AR = [
  {
    q: "ما الذي تقدّمه شركة صيانة العقارات؟",
    a: `تتولى شركة صيانة العقارات إبقاء المبنى وأنظمته تعمل: السباكة والتكييف والكهرباء والنجارة والتشطيبات والتنظيف، سواء كإصلاحات فردية أو ضمن عقد صيانة مستمر. ${tenant.brandName} مرخّصة لتقديم عشرة من هذه الأنشطة، ولا تقدّم عروض أسعار إلا لما هو مشمول بالترخيص.`,
  },
  {
    q: "ما مدى سرعة الوصول في حالة الطوارئ؟",
    a: "التزامنا في حالات الطوارئ من الفئة الأولى — تسرّب نشط، انقطاع كامل للتبريد، عطل كهربائي — هو الاستجابة خلال 30 إلى 60 دقيقة، على مدار الساعة طوال أيام الأسبوع بما في ذلك العطلات الرسمية. هذا التزام نقيس أنفسنا به في كل مهمة، وليس متوسطًا نذكره فحسب.",
  },
  {
    q: "هل يستحق عقد الصيانة السنوي التكلفة؟",
    a: "يعتمد ذلك على حجم الأعمال التفاعلية التي يولدها العقار أصلًا، والاختبار الصادق هو حسابي وليس إقناعيًا: اجمع عدد طلبات الصيانة في العام الماضي وقارن. يستحق العقد التكلفة عندما كانت الزيارات المجدولة ستمنع بعضها. أما إن كان عقارك جديدًا ولم تحتج لأي طلب صيانة خلال عامين، فالنظام حسب الطلب يناسبك فعليًا أكثر، وسنخبرك بذلك بصراحة.",
  },
  {
    q: "هل تتعاملون مع المطورين العقاريين وجمعيات الملاك؟",
    a: "نعم. تعمل جمعيات الملاك في دبي وفق دورة ميزانية سنوية وعملية طرح إلزامية من ريرا عبر منصة مولاك، لذا يتطلب الفوز بالعمل إدراجكم في قائمة المورّدين المعتمدين قبل موسم الميزانية، مع مستندات ترخيص وتأمين واعتماد سارية. نُصدر تقارير إنجاز اتفاقيات مستوى الخدمة والصيانة الوقائية من سجلات المهام نفسها وليس بإعدادها لاحقًا.",
  },
  {
    q: "ما المناطق التي تغطونها؟",
    // Same first-five-areas construction as the English page, resolved with
    // the Arabic area names where available.
    a: `دبي. وتشمل ${areas
      .slice(0, 5)
      .map((a) => areaNameAr(a.slug, a.name))
      .join("، ")} والمجتمعات المجاورة المدرجة في صفحة المناطق لدينا. نحمل ترخيصًا لبر دبي ولا ندّعي تغطية إمارات لا نملك ترخيصًا للعمل فيها.`,
  },
] as const;

const DISPATCH_STEPS_AR = [
  {
    verb: "تسجيل",
    text: "اتصل، راسلنا عبر واتساب، أو قدّم طلبك عبر الإنترنت. نسجّل العطل والعقار وقيود الوصول في خطوة واحدة، فلا يضطر أحد لشرحها مرتين.",
  },
  {
    verb: "تكليف",
    text: "توجَّه المهمة إلى أقرب فني مؤهل يحمل الشهادة المهنية الصحيحة والسارية، ولديه سعة ضمن نوبته.",
  },
  {
    verb: "تتبّع",
    // Faithful translation of the same claim made on the English page — see
    // the delivery report: this is one of two claims flagged in
    // `docs/architecture/05-roadmap.md` as a sold feature with nothing built
    // behind it (`technician_locations` has no writer anywhere in the
    // codebase). Not mine to fix or quietly soften in translation.
    text: "تصلك رسالة نصية باسم الفني ورابط تتبّع مباشر. بلا نوافذ وصول مدتها أربع ساعات.",
  },
  {
    verb: "إغلاق",
    text: "صور قبل وبعد، والمواد المستخدمة، والعمل المنجز، وتوقيع — كل ذلك في بطاقة المهمة. تصدر الفاتورة فقط وفق ما تم التوقيع عليه.",
  },
] as const;

export default function HomePageAr() {
  const groups = groupedServices();
  const whatsappHref = whatsappLink(`Hello ${tenant.brandName}, I need help with a maintenance issue.`);

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/",
            name: `${tenant.brandName} | صيانة العقارات وإدارة المرافق`,
            description: ELEVATOR_ANSWER_AR,
            primaryAnswer: ELEVATOR_ANSWER_AR,
            inLanguage: "ar-AE",
          }),
          faqSchema(HOME_FAQS_AR, "/ar"),
        )}
      />

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="border-b">
        <div className="container-page grid gap-12 pt-16 pb-20 md:pt-24 md:pb-28 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <Eyebrow>
              <span dir="ltr" style={{ unicodeBidi: "isolate" }}>
                {company.licenceIssuer}
                {company.licenceNumber ? ` ${company.licenceNumber}` : ""}
              </span>
            </Eyebrow>
            <h1 className="mt-5 text-4xl font-semibold md:text-5xl lg:text-6xl">
              صيانة عقارات
              <br />
              تستجيب في الثالثة فجرًا.
            </h1>
            <p className="prose-body mt-6 text-[17px] md:text-[18px]">
              سباكة وتكييف وكهرباء ونجارة وتبليط وأسقف معلقة ودهانات وتنظيف مبانٍ في جميع أنحاء دبي — عشرة أنشطة
              مرخصة، ومقاول واحد مسؤول عنها جميعًا.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <CallLink phone={tenant.emergencyPhone} />
              <Link href="/ar/contact" className="btn btn-secondary">
                تواصل معنا
              </Link>
            </div>
          </div>

          <aside
            className="rounded border p-6 lg:col-span-5"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-[15px] font-semibold">التزامات وقت الاستجابة</h2>
            <dl className="mt-5 space-y-4">
              {[
                { t: "طوارئ (P1)", v: "30–60 دقيقة", d: "استجابة، على مدار الساعة" },
                { t: "عاجل (P2)", v: "2–4 ساعات", d: "استجابة، خلال ساعات العمل" },
                { t: "روتيني (P3)", v: "24 ساعة", d: "استجابة" },
                { t: "مخطط له (P4)", v: "حسب الاتفاق", d: "يُجدول معك" },
              ].map((row) => (
                <div
                  key={row.t}
                  className="flex items-baseline justify-between gap-4 border-b pb-4 last:border-0 last:pb-0"
                >
                  <dt className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
                    {row.t}
                  </dt>
                  <dd className="text-end">
                    <span className="tnum block text-[15px] font-semibold" dir="ltr">
                      {row.v}
                    </span>
                    <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {row.d}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            {whatsappHref ? (
              <a href={whatsappHref} className="btn btn-secondary mt-6 w-full">
                <WhatsappLogo size={17} weight="fill" aria-hidden />
                راسلنا عبر واتساب
              </a>
            ) : null}
          </aside>
        </div>
      </section>

      {/* ── Answer block ───────────────────────────────────────────────── */}
      <Section className="!py-16 md:!py-20">
        <div className="container-page">
          <AnswerBlock>{ELEVATOR_ANSWER_AR}</AnswerBlock>
        </div>
      </Section>

      {/* ── Services by category ──────────────────────────────────────── */}
      <Section tone="sunken" className="!pt-4">
        <div className="container-page">
          <h2 className="text-3xl font-semibold md:text-4xl">
            {services.length} أنشطة مرخصة، ومقاول واحد مسؤول عنها
          </h2>
          <p className="prose-body mt-4">
            كل خدمة أدناه مرتبطة بنشاط مسمّى على رخصتنا التجارية. وحين تتداخل مهمة بين عدة أنشطة — كتسرّب يتلف
            سقفًا ودهانه — يتولى مقاول واحد الإصلاح كاملًا بدلًا من تنقّلك بين ثلاثة.
          </p>

          <div className="mt-14 space-y-14">
            {groups.map((group) => (
              <div key={group.category}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b pb-3">
                  <h3 className="text-xl font-semibold tracking-tight">{categoryLabelAr(group.category)}</h3>
                  <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
                    {group.items.length} خدمات
                  </p>
                </div>
                <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((service) => (
                    <ServiceCard key={service.slug} service={service} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="prose-body mt-6 text-[13px]">
            أسماء الخدمات وتفاصيلها معروضة أدناه بالإنجليزية — وهي صيغة الترخيص التجاري — ريثما تُعتمد ترجمتها
            العربية الرسمية.
          </p>
        </div>
      </Section>

      {/* ── Emergency band ─────────────────────────────────────────────── */}
      <Section tone="inverse">
        <div className="container-page grid gap-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7">
            <h2 className="text-3xl font-semibold md:text-4xl">شخص حقيقي يرد. في كل مرة.</h2>
            <p className="mt-5 text-[17px] leading-relaxed" style={{ color: "var(--color-ink-400)" }}>
              بلا بريد صوتي، بلا نموذج معاودة اتصال، بلا قائمة انتظار ليلية. خط الطوارئ يعمل على مدار الساعة، ويُكلَّف
              فني أثناء المكالمة نفسها، وتصلك رسالة نصية باسمه ورابط تتبّع قبل إنهاء المكالمة.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <CallLink phone={tenant.emergencyPhone} />
              <Link href="/ar" className="btn btn-inverse">
                ما الذي يُعد حالة طارئة
              </Link>
            </div>
          </div>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-3 lg:col-span-5">
            {emergencyServices.map((s) => (
              <li key={s.slug} className="text-[15px]">
                <Link href={`/ar/services/${s.slug}`} className="hover:underline">
                  {serviceShortNameAr(s.slug, s.shortName)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── How a job runs ─────────────────────────────────────────────── */}
      <Section>
        <div className="container-page">
          <h2 className="text-3xl font-semibold md:text-4xl">كيف تسير المهمة فعليًا</h2>
          <div
            className="mt-12 grid gap-px overflow-hidden rounded border sm:grid-cols-2 lg:grid-cols-4"
            style={{ backgroundColor: "var(--border-hairline)" }}
          >
            {DISPATCH_STEPS_AR.map((step) => (
              <div key={step.verb} className="p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h3 className="text-lg font-semibold tracking-tight" style={{ color: "var(--accent-text)" }}>
                  {step.verb}
                </h3>
                <p className="prose-body mt-2.5 text-[14px]">{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Coverage ───────────────────────────────────────────────────── */}
      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <Eyebrow>التغطية</Eyebrow>
            <h2 className="mt-4 text-3xl font-semibold md:text-4xl">مكتب إرسال واحد لكل المناطق</h2>
            <p className="prose-body mt-5">
              يتمركز الفنيون في المناطق التي يخدمونها بدلًا من الانطلاق من مستودع مركزي واحد، وهذه هي الطريقة
              الوحيدة التي يصمد بها زمن استجابة أقل من ساعة أمام ازدحام {tenant.address.city}.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/ar/areas" className="btn btn-primary">
                <MapPin size={17} aria-hidden />
                عرض جميع المناطق ({areas.length})
              </Link>
              <Link href="/ar/contact" className="btn btn-secondary">
                تواصل معنا
              </Link>
            </div>
          </div>
          <div className="space-y-8 lg:col-span-7">
            {tenant.serviceAreas.map((area) => (
              <div key={area.name}>
                <div className="flex items-baseline gap-3">
                  <h3 className="text-[17px] font-semibold">{area.name === "Dubai" ? "دبي" : area.name}</h3>
                </div>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {areasInCity(area.name).map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={`/ar/areas/${a.slug}`}
                        className="inline-block rounded-sm border px-2.5 py-1 text-[13px] transition-colors hover:border-[var(--accent)]"
                        style={{ backgroundColor: "var(--surface-raised)", color: "var(--text-secondary)" }}
                      >
                        {areaNameAr(a.slug, a.name)}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <Eyebrow>أسئلة شائعة</Eyebrow>
            <h2 className="mt-4 text-3xl font-semibold md:text-4xl">إجابات واضحة</h2>
            <p className="prose-body mt-5 text-[15px]">
              إن كانت الإجابة الصادقة أنك لا تحتاج ما نقدّمه، فهذا ما ستسمعه منا.
            </p>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={HOME_FAQS_AR} />
          </div>
        </div>
      </Section>

      {/* ── Close ──────────────────────────────────────────────────────── */}
      <Section tone="sunken" className="!py-20">
        <div className="container-page">
          <div className="rounded border p-10 md:p-14" style={{ backgroundColor: "var(--surface-raised)" }}>
            <h2 className="max-w-2xl text-3xl font-semibold md:text-4xl">أخبرنا ما هو العطل. سنخبرك بتكلفته.</h2>
            <p className="prose-body mt-5">عروض أسعار خلال 24 ساعة من المعاينة، مفصّلة، مع ذكر الاستثناءات صراحة.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/ar/contact" className="btn btn-primary">
                تواصل معنا
              </Link>
              <a href={telLink(tenant.phone)} className="btn btn-secondary" dir="ltr">
                <PhoneCall size={17} aria-hidden />
                {tenant.phone}
              </a>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
