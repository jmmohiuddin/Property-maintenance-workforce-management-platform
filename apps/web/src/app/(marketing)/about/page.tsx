import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  company,
  services,
  LICENSED_ACTIVITY_REGISTER,
  graph,
  webPageSchema,
  breadcrumbSchema,
} from "@meridian/core";
import { Section, AnswerBlock } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";

/**
 * About.
 *
 * `WEB-2` hit this page harder than any other, because it was where the
 * fabrications were concentrated: a founding year, a headcount, a claim of DEWA
 * electrical registration, three ISO certificates, AED 10,000,000 of liability
 * cover, four headline statistics, and a stock photograph of somebody else's
 * technicians standing in for our team.
 *
 * The page that replaces it makes one claim, and it is checkable in about
 * thirty seconds: here is the licence, here is its number, here are the ten
 * activities on it, and here is what is deliberately not on it. In a market
 * where every contractor's About page asserts scale, a page that tells you the
 * boundary of what the company may legally do is both more useful and more
 * persuasive — and, unlike the previous version, survives being checked.
 */
const ANSWER = `${company.legalName} is a Dubai mainland technical services contractor licensed by the ${company.licenceIssuer}${
  company.licenceNumber ? ` under trade licence ${company.licenceNumber}` : ""
} for ten activities: painting, wallpaper, false ceilings, tiling, plumbing and sanitary works, carpentry, electrical fittings repair, electromechanical installation, HVAC installation and maintenance, and building cleaning. It works across Dubai on annual maintenance contracts, reactive callouts and fit-out projects.`;

export const metadata: Metadata = {
  title: "About",
  description: ANSWER,
  alternates: { canonical: "/about" },
};

/** Work we are asked for and are not licensed to do. Naming it is the point. */
const NOT_LICENSED = [
  "Glass and aluminium work",
  "Pest control",
  "Facade and rope-access cleaning",
  "Work on the electrical supply, meter or main distribution board",
  "Swimming pool plant",
  "Structural and civil works",
] as const;

export default function AboutPage() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({ path: "/about", name: "About", description: ANSWER, primaryAnswer: ANSWER }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "About", path: "/about" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            Ten licensed activities. Nothing outside them.
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
        </div>
      </section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h2 className="text-2xl font-semibold md:text-3xl">Why the licence is the whole story</h2>
            <div className="prose-body mt-6 space-y-4 text-[16px]">
              <p>
                A Dubai trade licence names the activities a company may carry out. Ours names ten. That
                list is not marketing copy — it is the legal boundary of the business, and quoting outside
                it is a licensing exposure rather than a stretch.
              </p>
              <p>
                So we publish it, and we build the system around it. Our service catalogue is derived from
                the licence and cannot exceed it. When a quote line is categorised outside the licensed
                activities, the person writing it gets a warning and has to say why. If you ask us for
                something on the second list below, you will hear so at the enquiry rather than at the
                invoice.
              </p>
              <p>
                The trade-off is honest. A contractor who says yes to everything is easier to deal with for
                exactly as long as nothing goes wrong. Ours is a shorter list, and every item on it is one
                we can be held to.
              </p>
            </div>
          </div>

          {/*
            The aside previously held a stock photograph of technicians who do
            not work here. WEB-3 removes placeholder imagery, and until there are
            photographs of real jobs the space carries the licensed-activity list
            instead — which is the more useful thing to put in front of someone
            deciding whether to call.
          */}
          <aside className="lg:col-span-5">
            <div className="rounded border p-6" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h2 className="text-[15px] font-semibold">Licensed activities</h2>
              <ul className="mt-4 space-y-2 text-[14px]">
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
                {services.length} service pages, one per activity.
              </p>
            </div>
          </aside>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold md:text-3xl">What we are not licensed for</h2>
            <p className="prose-body mt-4">
              Asked for regularly, and refused. Where we can point you at somebody who holds the right
              licence, we will.
            </p>
            <ul className="prose-body mt-6 space-y-3 text-[15px]">
              {NOT_LICENSED.map((item) => (
                <li key={item} className="border-b pb-3">
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h2 className="text-2xl font-semibold md:text-3xl">Licence</h2>
            {tenant.licences.length > 0 ? (
              <dl className="mt-6 divide-y border-y">
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
                    {l.expires ? (
                      <dd className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                        Valid to{" "}
                        {new Date(l.expires).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "long",
                          year: "numeric",
                        })}
                      </dd>
                    ) : null}
                  </div>
                ))}
              </dl>
            ) : null}

            {/*
              A single accreditation register (HR-14) will hold DEWA enrolment,
              Dubai Municipality classification, ISO certificates and insurance
              policies, each with a document and an expiry date. Nothing appears
              here until there is a certificate on file behind it — the previous
              version of this page listed four we do not hold.
            */}
            <p className="prose-body mt-8 text-[15px]">
              Other accreditations — DEWA contractor enrolment, insurance cover, third-party certification —
              are listed here only once the certificate is on file and in date. Ask and we will send the
              current documents.
            </p>

            <Link href="/quote" className="btn btn-primary mt-9">
              Get a quote
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
