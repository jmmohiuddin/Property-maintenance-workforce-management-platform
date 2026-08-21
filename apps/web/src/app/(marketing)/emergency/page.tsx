import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  getService,
  emergencyServices,
  telLink,
  whatsappLink,
  graph,
  webPageSchema,
  faqSchema,
  howToSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, AnswerBlock, CallLink } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, WhatsappLogo } from "@phosphor-icons/react/dist/ssr";

const emergency = getService("emergency-maintenance");

const ANSWER = emergency?.answer ?? "";

export const metadata: Metadata = {
  title: `24 Hour Emergency Maintenance in ${tenant.address.city}`,
  description: ANSWER,
  alternates: { canonical: "/emergency" },
};

/**
 * HowTo markup on this page is genuinely useful rather than decorative: "what
 * do I do while I wait" is a real query, and it is the kind of procedural
 * answer generative engines reach for.
 */
const WHILE_YOU_WAIT = [
  {
    name: "Isolate the water",
    text: "For a leak or burst pipe, close the main stopcock. In UAE apartments it is usually inside the kitchen or bathroom service duct, behind an access panel. Turn it clockwise until it stops.",
  },
  {
    name: "Kill the power to the affected area",
    text: "If water is anywhere near electrics, switch off the relevant circuit at the distribution board rather than the main switch, so lighting elsewhere stays on. Do not touch a wet fitting.",
  },
  {
    name: "Contain and protect",
    text: "Move furniture and electronics clear, and put towels or a container under the leak. Photograph the damage before you clean up, because insurers and building management will both ask.",
  },
  {
    name: "Tell building security",
    text: "If you are in a tower, notify security or the FM desk so they can grant our technician access and check the units below yours for spreading damage.",
  },
] as const;

export default function EmergencyPage() {
  const urgentWhatsapp = whatsappLink("URGENT: I have a maintenance emergency and need help now.");
  if (!emergency) return null;

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/emergency",
            name: `24 Hour Emergency Maintenance in ${tenant.address.city}`,
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          faqSchema(emergency.faqs, "/emergency"),
          howToSchema({
            name: "What to do while waiting for an emergency maintenance technician",
            description:
              "Four steps to limit damage between reporting a maintenance emergency and the technician arriving.",
            path: "/emergency",
            totalTime: "PT5M",
            steps: WHILE_YOU_WAIT,
          }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Emergency", path: "/emergency" },
          ]),
        )}
      />

      <Section tone="inverse" className="!pt-16 !pb-20">
        <div className="container-page grid gap-12 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7">
            <h1 className="text-4xl font-semibold md:text-5xl">
              Emergency maintenance,
              <br />
              24 hours a day.
            </h1>
            <p className="mt-6 text-[18px] leading-relaxed" style={{ color: "var(--color-ink-400)" }}>
              Median arrival under {tenant.emergencyResponseMinutes} minutes in {tenant.address.city}. The
              line is answered by a person.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <CallLink phone={tenant.emergencyPhone} className="btn btn-primary !text-[17px] !py-4 !px-7" />
              {urgentWhatsapp ? (
                <a href={urgentWhatsapp} className="btn btn-inverse">
                  <WhatsappLogo size={17} weight="fill" aria-hidden />
                  WhatsApp
                </a>
              ) : null}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-6 lg:col-span-5">
            {/*
              The SLA tiers, which are commitments the system enforces (JOB-4),
              replacing the previous block: an unmeasured Dubai median, coverage
              promises for two emirates this Dubai mainland licence does not
              cover, and an invented AED 250 callout fee.
            */}
            {[
              { t: "P1 emergency response", v: "30–60 min" },
              { t: "P1 resolution target", v: "2–4 hrs" },
              { t: "P2 urgent response", v: "2–4 hrs" },
              { t: "Coverage", v: "Dubai, 24/7" },
            ].map((row) => (
              <div key={row.t}>
                <dt className="text-[14px]" style={{ color: "var(--color-ink-500)" }}>
                  {row.t}
                </dt>
                <dd className="tnum mt-1 text-2xl font-semibold">{row.v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section className="!py-16">
        <div className="container-page">
          <AnswerBlock>{ANSWER}</AnswerBlock>
        </div>
      </Section>

      <Section tone="sunken" className="!pt-4">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">What counts as an emergency</h2>
          <p className="prose-body mt-4">
            Anything causing active damage, making a property unsafe, or leaving it uninhabitable or
            unsecured. If you are unsure, call and we will tell you honestly whether it can wait until
            morning at standard rates.
          </p>
          <ul className="mt-10 grid gap-3 md:grid-cols-2">
            {emergency.scope.map((item) => (
              <li
                key={item}
                className="rounded border p-4 text-[15px]"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">While you wait</h2>
            <p className="prose-body mt-5 text-[15px]">
              Four things that limit the damage between your call and our arrival. Stop at any point that
              feels unsafe.
            </p>
          </div>
          <ol className="lg:col-span-8">
            {WHILE_YOU_WAIT.map((step, i) => (
              <li key={step.name} className="flex gap-5 border-b py-6 first:pt-0 last:border-0">
                <span
                  aria-hidden
                  className="tnum shrink-0 text-[15px] font-semibold"
                  style={{ color: "var(--accent-text)" }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-[17px] font-semibold">{step.name}</h3>
                  <p className="prose-body mt-2 text-[15px]">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">Trades on emergency call</h2>
          <ul className="mt-8 flex flex-wrap gap-2.5">
            {emergencyServices.map((s) => (
              <li key={s.slug}>
                <Link
                  href={`/services/${s.slug}`}
                  className="inline-block rounded-sm border px-3.5 py-2 text-[14px] transition-colors hover:border-[var(--accent)]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  {s.shortName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">Emergency questions</h2>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={emergency.faqs} />
          </div>
        </div>
      </Section>
    </>
  );
}
