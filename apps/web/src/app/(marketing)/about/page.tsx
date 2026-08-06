import type { Metadata } from "next";
import Link from "next/link";
import { tenant, services, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { Section, AnswerBlock } from "@/components/ui";
import { JsonLd } from "@/components/json-ld";

const ANSWER = `${tenant.legalName} is a ${tenant.address.city}-based property maintenance and facility management contractor founded in ${tenant.foundedYear}, employing ${tenant.employeeCount} technicians directly across ${services.length} trades, licensed by Dubai Department of Economy & Tourism and registered with DEWA for electrical works.`;

export const metadata: Metadata = {
  title: "About",
  description: ANSWER,
  alternates: { canonical: "/about" },
};

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
            Directly employed. That is the whole model.
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
        </div>
      </section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-7">
            <h2 className="text-2xl font-semibold md:text-3xl">Why it matters who employs the technician</h2>
            <div className="prose-body mt-6 space-y-4 text-[16px]">
              <p>
                Most maintenance companies in the UAE subcontract trade labour. It is cheaper, it scales
                faster, and it means the company quoting you has no control over who actually arrives at
                your door, what their certification status is, or whether they will still be available when
                the same fault recurs in four months.
              </p>
              <p>
                We employ our technicians on our own labour contracts and visas, run WPS payroll, and carry
                the medical insurance, workmen&apos;s compensation and end-of-service liability that goes
                with that. It costs more. It is also the only structure under which we can tell you in
                advance who is coming, hold someone accountable for the standard of work, and send the same
                person back to a property they already know.
              </p>
              <p>
                The trade-off is honest: on a single small job, a subcontracting competitor will often be
                cheaper. Across a maintenance contract, where the same faults recur and site knowledge
                compounds, they usually are not.
              </p>
            </div>
          </div>

          <aside className="lg:col-span-5">
            <img
              src="https://picsum.photos/seed/meridian-team-technicians/800/1000"
              alt=""
              loading="lazy"
              width={800}
              height={1000}
              className="w-full rounded object-cover"
            />
          </aside>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">By the numbers</h2>
          <dl className="mt-10 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {tenant.stats.map((stat) => (
              <div key={stat.label} className="border-t pt-5">
                <dt className="text-[14px] font-medium">{stat.label}</dt>
                <dd className="tnum mt-2 text-3xl font-semibold tracking-tight">{stat.value}</dd>
                <dd className="mt-1 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {stat.detail}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-2">
          <div>
            <h2 className="text-2xl font-semibold md:text-3xl">Accreditation</h2>
            <ul className="prose-body mt-6 space-y-3 text-[15px]">
              {tenant.certifications.map((c) => (
                <li key={c} className="border-b pb-3">
                  {c}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-2xl font-semibold md:text-3xl">Licences</h2>
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
            <Link href="/quote" className="btn btn-primary mt-9">
              Get a quote
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
