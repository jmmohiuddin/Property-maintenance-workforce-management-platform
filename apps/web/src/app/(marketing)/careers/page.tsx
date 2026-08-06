import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  services,
  whatsappLink,
  graph,
  webPageSchema,
  faqSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, Eyebrow, AnswerBlock } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { EnvelopeSimple, WhatsappLogo } from "@phosphor-icons/react/dist/ssr";

const careersEmail = `careers@${tenant.domain.replace(/^https?:\/\//, "")}`;

const ANSWER = `${tenant.legalName} employs ${tenant.employeeCount} technicians directly on UAE labour contracts and visas, across ${services.length} trades including plumbing, electrical, HVAC, carpentry and cleaning. We do not subcontract trade labour, and we sponsor visas, provide medical insurance and pay through WPS.`;

export const metadata: Metadata = {
  title: "Careers",
  description: ANSWER,
  alternates: { canonical: "/careers" },
};

const WHAT_WE_OFFER = [
  {
    title: "Directly employed, not supplied",
    body: "You are on our labour contract and our visa, not passed between agencies. That means end-of-service accrual, annual leave and medical insurance are ours to provide, and they are.",
  },
  {
    title: "Paid on time, through WPS",
    body: "Salaries are paid through the Wage Protection System on a fixed date. If we are ever late, we tell you before payday rather than after.",
  },
  {
    title: "Tools, uniform and PPE provided",
    body: "You do not buy your own tools or safety equipment. If something is worn out or unsafe, it gets replaced.",
  },
  {
    title: "Training toward certification",
    body: "We pay for trade certification and renewal where it applies to your work. A lapsed certificate stops you being dispatched, so keeping it current is our problem as much as yours.",
  },
  {
    title: "Accommodation and transport",
    body: "Company accommodation and transport to site are provided for technicians who need them.",
  },
  {
    title: "Real progression",
    body: "Technician to senior technician to supervisor is a route people here have actually taken, not a line in a job advert.",
  },
] as const;

const FAQS = [
  {
    q: "Do you sponsor visas?",
    a: `Yes. ${tenant.legalName} sponsors UAE employment visas for technicians we hire, and covers the cost of the visa, medical and Emirates ID. You are employed by us directly, not by a labour supply agency.`,
  },
  {
    q: "Do I need to already be in the UAE to apply?",
    a: "No. We hire both from inside the UAE and from overseas. Candidates already holding a transferable visa can usually start sooner, but it is not a requirement.",
  },
  {
    q: "What trades are you usually hiring for?",
    a: "Most consistently plumbers, electricians and HVAC technicians, since those carry the highest job volume. We also hire carpenters, painters, cleaners, helpers and supervisors as contracts require.",
  },
  {
    q: "Will I be trade tested?",
    a: "Yes, by one of our own supervisors rather than by a form. We would rather find out on a bench than on a customer's property, and it also means an experienced candidate without formal papers is not filtered out.",
  },
] as const;

export default function CareersPage() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/careers",
            name: "Careers",
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          faqSchema(FAQS, "/careers"),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Careers", path: "/careers" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <Eyebrow>Careers</Eyebrow>
          <h1 className="mt-4 max-w-3xl text-4xl font-semibold md:text-5xl">
            We employ our technicians. That is the job offer.
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href={`mailto:${careersEmail}`} className="btn btn-primary">
              <EnvelopeSimple size={17} weight="fill" aria-hidden />
              Send your CV
            </a>
            <a
              href={whatsappLink("Hello, I would like to apply for a technician role.")}
              className="btn btn-secondary"
            >
              <WhatsappLogo size={17} weight="fill" aria-hidden />
              Apply on WhatsApp
            </a>
          </div>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">What you get</h2>
          <p className="prose-body mt-4">
            Much of this is legally required and routinely not provided. We list it because in this
            industry it is a differentiator, which is itself the problem.
          </p>
          <div
            className="mt-10 grid gap-px overflow-hidden rounded border md:grid-cols-2 lg:grid-cols-3"
            style={{ backgroundColor: "var(--border-hairline)" }}
          >
            {WHAT_WE_OFFER.map((item) => (
              <div key={item.title} className="p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h3 className="text-[17px] font-semibold tracking-tight">{item.title}</h3>
                <p className="prose-body mt-2.5 text-[14px]">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <h2 className="text-2xl font-semibold md:text-3xl">How to apply</h2>
            <p className="prose-body mt-5">
              There is no application portal. Send a CV, or message us on WhatsApp with your trade and
              years of experience. If there is a fit we will arrange a trade test with a supervisor.
            </p>
            <p className="prose-body mt-4 text-[15px]">
              We reply to every application, including the ones we turn down. Being left waiting is the
              most common complaint people have about applying for trade work, and it costs nothing to
              fix.
            </p>
            <a href={`mailto:${careersEmail}`} className="btn btn-primary mt-8">
              <EnvelopeSimple size={17} weight="fill" aria-hidden />
              Send your CV
            </a>
          </div>
          <div className="lg:col-span-7">
            <FaqList faqs={FAQS} />
          </div>
        </div>
      </Section>

      <Section tone="sunken" className="!py-16">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">Trades we hire</h2>
          <ul className="mt-7 flex flex-wrap gap-2.5">
            {services
              .filter((s) => s.category === "MEP" || s.category === "Fit-out & Finishing" || s.category === "Cleaning & Hygiene")
              .map((s) => (
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
    </>
  );
}
