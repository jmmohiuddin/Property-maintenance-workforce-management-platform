import type { Metadata } from "next";
import Link from "next/link";
import { tenant, telLink, whatsappLink, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { Section } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, WhatsappLogo, EnvelopeSimple, MapPin, Clock } from "@phosphor-icons/react/dist/ssr";
import { hreflangAlternates } from "@/lib/i18n";

const DESCRIPTION_AR = `تواصل مع ${tenant.brandName} على ${tenant.phone} للاستفسارات العامة، أو ${tenant.emergencyPhone} للطوارئ على مدار الساعة. يقع مكتبنا في ${tenant.address.city}، ويرد على خط الطوارئ شخص حقيقي في أي وقت بما في ذلك العطلات الرسمية.`;

export const metadata: Metadata = {
  title: "اتصل بنا",
  description: DESCRIPTION_AR,
  alternates: { canonical: "/ar/contact", languages: hreflangAlternates("/contact") },
};

const CHANNELS_AR = [
  {
    Icon: PhoneCall,
    label: "الطوارئ، على مدار الساعة",
    value: tenant.emergencyPhone,
    href: telLink(tenant.emergencyPhone),
    note: "يرد شخص حقيقي. يُكلَّف فني أثناء المكالمة نفسها.",
    primary: true,
  },
  {
    Icon: PhoneCall,
    label: "المكتب والاستفسارات العامة",
    value: tenant.phone,
    href: telLink(tenant.phone),
    note: "الأحد إلى الخميس، 08:00 حتى 18:00.",
    primary: false,
  },
  {
    Icon: WhatsappLogo,
    label: "واتساب",
    value: "راسلنا",
    href: whatsappLink(`Hello ${tenant.brandName}, I have a question about your services.`),
    note: "أرسل صورًا للمشكلة، وغالبًا يمكننا تقديم عرض سعر دون معاينة.",
    primary: false,
  },
  {
    Icon: EnvelopeSimple,
    label: "البريد الإلكتروني",
    value: tenant.email,
    href: `mailto:${tenant.email}`,
    note: "العقود والمناقصات واستفسارات الحسابات.",
    primary: false,
  },
] as const;

export default function ContactPageAr() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/contact",
            name: "اتصل بنا",
            description: DESCRIPTION_AR,
            primaryAnswer: DESCRIPTION_AR,
            inLanguage: "ar-AE",
          }),
          breadcrumbSchema([
            { name: "الرئيسية", path: "/ar" },
            { name: "اتصل بنا", path: "/ar/contact" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="text-4xl font-semibold md:text-5xl">اتصل بنا</h1>
          <p className="prose-body mt-6 text-[17px]">أربع طرق للتواصل معنا. خط الطوارئ هو الأسرع، في أي وقت.</p>

          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {CHANNELS_AR.filter((c): c is typeof c & { href: string } => Boolean(c.href)).map((c) => (
              <a
                key={c.label}
                href={c.href}
                className={`rounded p-6 transition-colors ${c.primary ? "border-2" : "border"}`}
                style={{
                  backgroundColor: "var(--surface-raised)",
                  borderColor: c.primary ? "var(--accent)" : undefined,
                }}
              >
                <c.Icon size={20} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
                <p className="mt-3 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {c.label}
                </p>
                <p className="tnum mt-1 text-xl font-semibold" dir="ltr" style={{ textAlign: "start" }}>
                  {c.value}
                </p>
                <p className="prose-body mt-2 text-[14px]">{c.note}</p>
              </a>
            ))}
          </div>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <h2 className="text-2xl font-semibold md:text-3xl">المكتب</h2>
            <address
              className="prose-body mt-5 not-italic text-[16px]"
              dir="ltr"
              style={{ textAlign: "start" }}
            >
              {tenant.legalName}
              <br />
              {tenant.address.street ? (
                <>
                  {tenant.address.street}
                  <br />
                </>
              ) : null}
              {tenant.address.city}
              <br />
              {tenant.address.country}
            </address>

            <dl className="mt-8 space-y-4 text-[15px]">
              <div className="flex gap-3">
                <Clock size={18} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                <div>
                  <dt className="font-medium">ساعات العمل</dt>
                  <dd style={{ color: "var(--text-secondary)" }}>الأحد إلى الخميس، 08:00 حتى 18:00</dd>
                </div>
              </div>
              <div className="flex gap-3">
                <MapPin size={18} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                <div>
                  <dt className="font-medium">المناطق المغطاة</dt>
                  <dd style={{ color: "var(--text-secondary)" }}>
                    {tenant.serviceAreas.map((a) => (a.name === "Dubai" ? "دبي" : a.name)).join("، ")}
                  </dd>
                </div>
              </div>
            </dl>
          </div>

          <div className="lg:col-span-6">
            <h2 className="text-2xl font-semibold md:text-3xl">التراخيص والتسجيلات</h2>
            <dl className="mt-6 divide-y border-y" dir="ltr" style={{ textAlign: "start" }}>
              {tenant.licences.map((l) => (
                <div key={l.ref} className="flex items-baseline justify-between gap-6 py-4">
                  <div>
                    <dt className="text-[15px] font-medium">{l.name}</dt>
                    <dd className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                      {l.issuer}
                    </dd>
                  </div>
                  <dd className="tnum shrink-0 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                    {l.ref}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>
    </>
  );
}
