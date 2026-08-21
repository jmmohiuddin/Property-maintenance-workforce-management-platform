import type { Metadata } from "next";
import Link from "next/link";
import { tenant, telLink, whatsappLink, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { Section } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, WhatsappLogo, EnvelopeSimple, MapPin, Clock } from "@phosphor-icons/react/dist/ssr";

const ANSWER = `Contact ${tenant.brandName} on ${tenant.phone} for general enquiries or ${tenant.emergencyPhone} for 24-hour emergencies. The office is at ${tenant.address.street}, ${tenant.address.city}, and the emergency line is answered by a person at any hour including public holidays.`;

export const metadata: Metadata = {
  title: "Contact",
  description: ANSWER,
  alternates: { canonical: "/contact" },
};

const CHANNELS = [
  {
    Icon: PhoneCall,
    label: "Emergency, 24 hours",
    value: tenant.emergencyPhone,
    href: telLink(tenant.emergencyPhone),
    note: "Answered by a person. Technician assigned on the call.",
    primary: true,
  },
  {
    Icon: PhoneCall,
    label: "Office and general enquiries",
    value: tenant.phone,
    href: telLink(tenant.phone),
    note: "Sunday to Thursday, 08:00 to 18:00.",
    primary: false,
  },
  {
    Icon: WhatsappLogo,
    label: "WhatsApp",
    value: "Message us",
    href: whatsappLink(`Hello ${tenant.brandName}, I have a question about your services.`),
    note: "Send photos of the problem and we can often quote without a survey.",
    primary: false,
  },
  {
    Icon: EnvelopeSimple,
    label: "Email",
    value: tenant.email,
    href: `mailto:${tenant.email}`,
    note: "Contracts, tenders and account queries.",
    primary: false,
  },
] as const;

export default function ContactPage() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({ path: "/contact", name: "Contact", description: ANSWER, primaryAnswer: ANSWER }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Contact", path: "/contact" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="text-4xl font-semibold md:text-5xl">Contact</h1>
          <p className="prose-body mt-6 text-[17px]">
            Four ways to reach us. The emergency line is the fastest, at any hour.
          </p>

          <div className="mt-12 grid gap-4 md:grid-cols-2">
            {/*
              A channel whose href is undefined has no number behind it yet, and
              a card that looks clickable and is not is worse than an absent one.
            */}
            {CHANNELS.filter((c): c is typeof c & { href: string } => Boolean(c.href)).map((c) => (
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
                <p className="tnum mt-1 text-xl font-semibold">{c.value}</p>
                <p className="prose-body mt-2 text-[14px]">{c.note}</p>
              </a>
            ))}
          </div>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-6">
            <h2 className="text-2xl font-semibold md:text-3xl">Office</h2>
            <address className="prose-body mt-5 not-italic text-[16px]">
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
                  <dt className="font-medium">Office hours</dt>
                  <dd style={{ color: "var(--text-secondary)" }}>Sunday to Thursday, 08:00 to 18:00</dd>
                </div>
              </div>
              <div className="flex gap-3">
                <MapPin size={18} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                <div>
                  <dt className="font-medium">Areas covered</dt>
                  <dd style={{ color: "var(--text-secondary)" }}>
                    {tenant.serviceAreas.map((a) => a.name).join(", ")}
                  </dd>
                </div>
              </div>
            </dl>

            <Link href="/quote" className="btn btn-primary mt-9">
              Request a quote instead
            </Link>
          </div>

          <div className="lg:col-span-6">
            <h2 className="text-2xl font-semibold md:text-3xl">Licences and registrations</h2>
            <dl className="mt-6 divide-y border-y">
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
