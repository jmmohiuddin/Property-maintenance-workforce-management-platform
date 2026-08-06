import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  services,
  groupedServices,
  CATEGORY_BLURB,
  emergencyServices,
  areas,
  areasInCity,
  industries,
  telLink,
  whatsappLink,
  graph,
  webPageSchema,
  faqSchema,
} from "@meridian/core";
import { Section, Eyebrow, ServiceCard, AnswerBlock } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, WhatsappLogo, ShieldCheck, MapPin } from "@phosphor-icons/react/dist/ssr";

export const metadata: Metadata = {
  title: `Property Maintenance & Facility Management in ${tenant.address.city}`,
  description: tenant.elevatorAnswer,
  alternates: { canonical: "/" },
};

/** Pulled up to the homepage so the highest-intent questions get FAQ markup. */
const HOME_FAQS = [
  {
    q: "What does a property maintenance company do?",
    a: `A property maintenance company keeps a building and its systems working: plumbing, electrical, air conditioning, carpentry, cleaning and structural upkeep, delivered either as one-off repairs or under an ongoing contract. ${tenant.brandName} covers all of these with directly employed technicians rather than subcontracted labour.`,
  },
  {
    q: "How fast can someone come out for an emergency?",
    a: `Our median arrival time for emergency call-outs inside ${tenant.address.city} is under ${tenant.emergencyResponseMinutes} minutes, 24 hours a day including public holidays. Abu Dhabi and Sharjah are typically attended within 90 minutes. The emergency line is answered by a person, not a callback form.`,
  },
  {
    q: "Is an annual maintenance contract worth it?",
    a: "For most occupied properties, yes. Four AC services alone at ad-hoc rates cost roughly AED 1,000 for a one-bedroom, so a contract from AED 1,200 effectively adds plumbing and electrical inspections plus unlimited free emergency attendance. If your property is new and you have had no call-outs in two years, ad-hoc may genuinely suit you better.",
  },
  {
    q: "Do you work with property developers and owners associations?",
    a: "Yes. Roughly two thirds of our work is contracted through developers, owners associations, property management companies and hotel groups, covering planned maintenance, common areas and MEP plant, with monthly SLA reporting produced from job records rather than written up afterwards.",
  },
  {
    q: "Which areas do you cover?",
    a: `${tenant.serviceAreas.map((a) => a.name).join(", ")}. Within ${tenant.address.city} that includes ${tenant.serviceAreas[0]?.areas.slice(0, 5).join(", ")} and surrounding communities. Emergency cover is available across all listed areas 24 hours a day.`,
  },
  {
    q: "Are your technicians directly employed or subcontracted?",
    a: "Directly employed, on our own UAE labour contracts and visas, with police clearance, uniform and ID. We do not subcontract trade labour. That is what allows us to tell you in advance who is coming and to stand behind the work.",
  },
] as const;

const DISPATCH_STEPS = [
  {
    verb: "Log",
    text: "Call, WhatsApp or submit online. We capture the fault, the property and the access constraints in one pass, so nobody has to explain it twice.",
  },
  {
    verb: "Assign",
    text: "The job routes to the nearest qualified technician with the right trade certification, current and unexpired, and capacity in their shift.",
  },
  {
    verb: "Track",
    text: "You get the technician's name and a live tracking link by SMS. No four-hour arrival windows.",
  },
  {
    verb: "Close",
    text: "Photos before and after, materials used, work carried out and a signature, all on the job card. Invoiced only against what was signed for.",
  },
] as const;

export default function HomePage() {
  const groups = groupedServices();

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/",
            name: `${tenant.brandName} | Property Maintenance & Facility Management`,
            description: tenant.elevatorAnswer,
            primaryAnswer: tenant.elevatorAnswer,
          }),
          faqSchema(HOME_FAQS, "/"),
        )}
      />

      {/* ── Hero: asymmetric split ─────────────────────────────────────── */}
      <section className="border-b">
        <div className="container-page grid gap-12 pt-16 pb-20 md:pt-24 md:pb-28 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-7">
            <Eyebrow>Operating since {tenant.foundedYear}</Eyebrow>
            <h1 className="mt-5 text-4xl font-semibold md:text-5xl lg:text-6xl">
              Property maintenance
              <br />
              that answers at 3am.
            </h1>
            <p className="prose-body mt-6 text-[17px] md:text-[18px]">
              Licensed plumbers, electricians and HVAC engineers across {tenant.address.city}, Abu Dhabi and
              Sharjah. Directly employed, never subcontracted.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary">
                <PhoneCall size={17} weight="fill" aria-hidden />
                {tenant.emergencyPhone}
              </a>
              <Link href="/quote" className="btn btn-secondary">
                Get a quote
              </Link>
            </div>
          </div>

          <aside
            className="rounded border p-6 lg:col-span-5"
            style={{ backgroundColor: "var(--surface-raised)" }}
          >
            <h2 className="text-[15px] font-semibold">Response commitments</h2>
            <dl className="mt-5 space-y-4">
              {[
                { t: "Emergency call-out", v: `Under ${tenant.emergencyResponseMinutes} min`, d: `median, inside ${tenant.address.city}` },
                { t: "Standard repair", v: "Same day", d: "logged before 15:00" },
                { t: "Quotation", v: "Within 24 hrs", d: "after site survey" },
                { t: "Contract mobilisation", v: "10 working days", d: "asset survey to first visit" },
              ].map((row) => (
                <div key={row.t} className="flex items-baseline justify-between gap-4 border-b pb-4 last:border-0 last:pb-0">
                  <dt className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
                    {row.t}
                  </dt>
                  <dd className="text-right">
                    <span className="tnum block text-[15px] font-semibold">{row.v}</span>
                    <span className="block text-[12px]" style={{ color: "var(--text-muted)" }}>
                      {row.d}
                    </span>
                  </dd>
                </div>
              ))}
            </dl>
            <a
              href={whatsappLink(`Hello ${tenant.brandName}, I need help with a maintenance issue.`)}
              className="btn btn-secondary mt-6 w-full"
            >
              <WhatsappLogo size={17} weight="fill" aria-hidden />
              Message on WhatsApp
            </a>
          </aside>
        </div>
      </section>

      {/* ── Credentials band ───────────────────────────────────────────── */}
      <div className="border-b" style={{ backgroundColor: "var(--surface-sunken)" }}>
        <div className="container-page grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
          {tenant.stats.map((stat) => (
            <div key={stat.label}>
              <p className="tnum text-2xl font-semibold tracking-tight">{stat.value}</p>
              <p className="mt-1 text-[14px] font-medium">{stat.label}</p>
              <p className="text-[13px]" style={{ color: "var(--text-muted)" }}>
                {stat.detail}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* ── The answer block ───────────────────────────────────────────── */}
      <Section className="!py-16 md:!py-20">
        <div className="container-page">
          <AnswerBlock>{tenant.elevatorAnswer}</AnswerBlock>
        </div>
      </Section>

      {/* ── Services by category ───────────────────────────────────────── */}
      <Section tone="sunken" className="!pt-4">
        <div className="container-page">
          <h2 className="text-3xl font-semibold md:text-4xl">
            {services.length} services, one accountable contractor
          </h2>
          <p className="prose-body mt-4">
            Every trade below is delivered by our own staff. Where a job spans several trades, one supervisor
            owns it end to end rather than handing you between contractors.
          </p>

          <div className="mt-14 space-y-14">
            {groups.map((group) => (
              <div key={group.category}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b pb-3">
                  <h3 className="text-xl font-semibold tracking-tight">{group.category}</h3>
                  <p className="text-[14px]" style={{ color: "var(--text-secondary)" }}>
                    {group.items.length} services
                  </p>
                </div>
                <p className="prose-body mt-4 text-[15px]">{CATEGORY_BLURB[group.category]}</p>
                <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {group.items.map((service, i) => (
                    <ServiceCard
                      key={service.slug}
                      service={service}
                      // Photography on the lead card of each group gives the
                      // grid rhythm without turning it into a stock-image wall.
                      image={
                        i === 0
                          ? `https://picsum.photos/seed/meridian-${service.slug}/640/288`
                          : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Emergency band: the one inverse section on the page ────────── */}
      <Section tone="inverse">
        <div className="container-page grid gap-10 lg:grid-cols-12 lg:items-center">
          <div className="lg:col-span-7">
            <h2 className="text-3xl font-semibold md:text-4xl">A person answers. Every time.</h2>
            <p className="mt-5 text-[17px] leading-relaxed" style={{ color: "var(--color-ink-400)" }}>
              No voicemail, no callback form, no overnight queue. The emergency line is staffed 24 hours a
              day, a technician is assigned during the call, and you get their name and a tracking link by
              SMS before you hang up.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary">
                <PhoneCall size={17} weight="fill" aria-hidden />
                {tenant.emergencyPhone}
              </a>
              <Link href="/emergency" className="btn btn-inverse">
                What counts as an emergency
              </Link>
            </div>
          </div>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-3 lg:col-span-5">
            {emergencyServices.map((s) => (
              <li key={s.slug} className="text-[15px]">
                <Link href={`/services/${s.slug}`} className="hover:underline">
                  {s.shortName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── How a job runs ─────────────────────────────────────────────── */}
      <Section>
        <div className="container-page">
          <h2 className="text-3xl font-semibold md:text-4xl">How a job actually runs</h2>
          <div className="mt-12 grid gap-px overflow-hidden rounded border sm:grid-cols-2 lg:grid-cols-4" style={{ backgroundColor: "var(--border-hairline)" }}>
            {DISPATCH_STEPS.map((step) => (
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
            <Eyebrow>Coverage</Eyebrow>
            <h2 className="mt-4 text-3xl font-semibold md:text-4xl">
              Three emirates, one dispatch desk
            </h2>
            <p className="prose-body mt-5">
              Technicians are based across the areas they cover rather than dispatched from a single depot,
              which is the only way a sub-hour response time survives {tenant.address.city} traffic.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/areas" className="btn btn-primary">
                <MapPin size={17} aria-hidden />
                See all {areas.length} areas
              </Link>
              <Link href="/quote" className="btn btn-secondary">
                Get a quote
              </Link>
            </div>
          </div>
          <div className="space-y-8 lg:col-span-7">
            {tenant.serviceAreas.map((area) => (
              <div key={area.name}>
                <div className="flex items-baseline gap-3">
                  <h3 className="text-[17px] font-semibold">{area.name}</h3>
                  {area.primary ? (
                    <span
                      className="rounded-sm px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
                      style={{ backgroundColor: "var(--accent-wash)", color: "var(--accent-text)" }}
                    >
                      Primary
                    </span>
                  ) : null}
                </div>
                <ul className="mt-3 flex flex-wrap gap-2">
                  {areasInCity(area.name).map((a) => (
                    <li key={a.slug}>
                      <Link
                        href={`/areas/${a.slug}`}
                        className="inline-block rounded-sm border px-2.5 py-1 text-[13px] transition-colors hover:border-[var(--accent)]"
                        style={{ backgroundColor: "var(--surface-raised)", color: "var(--text-secondary)" }}
                      >
                        {a.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Contracts ──────────────────────────────────────────────────── */}
      <Section>
        <div className="container-page">
          <h2 className="text-3xl font-semibold md:text-4xl">Contract or call-out</h2>
          <p className="prose-body mt-4">
            Most customers start with a call-out and move to a contract once they can see their own repair
            pattern. Both are priced below, and we will tell you which one your property actually needs.
          </p>
          <div className="mt-12 grid gap-6 lg:grid-cols-2">
            <div className="rounded border p-8" style={{ backgroundColor: "var(--surface-raised)" }}>
              <h3 className="text-xl font-semibold tracking-tight">Pay per call-out</h3>
              <p className="tnum mt-3 text-3xl font-semibold">
                {tenant.currencySymbol} 150
                <span className="ml-2 text-[14px] font-normal" style={{ color: "var(--text-muted)" }}>
                  from, per visit
                </span>
              </p>
              <ul className="prose-body mt-6 space-y-2.5 text-[15px]">
                <li>First 30 minutes of labour included</li>
                <li>Parts quoted and approved before any work starts</li>
                <li>No charge if the fault cannot be resolved and no work is done</li>
                <li>Same-day attendance when logged before 15:00</li>
              </ul>
              <Link href="/quote" className="btn btn-secondary mt-8 w-full">
                Book a call-out
              </Link>
            </div>

            <div
              className="rounded border-2 p-8"
              style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
            >
              <div className="flex items-center gap-2">
                <ShieldCheck size={18} weight="fill" aria-hidden style={{ color: "var(--accent)" }} />
                <h3 className="text-xl font-semibold tracking-tight">Annual maintenance contract</h3>
              </div>
              <p className="tnum mt-3 text-3xl font-semibold">
                {tenant.currencySymbol} 1,200
                <span className="ml-2 text-[14px] font-normal" style={{ color: "var(--text-muted)" }}>
                  from, per year
                </span>
              </p>
              <ul className="prose-body mt-6 space-y-2.5 text-[15px]">
                <li>Four preventive visits, AC serviced at each one</li>
                <li>Unlimited emergency call-outs with no attendance charge</li>
                <li>Priority dispatch ahead of non-contract bookings</li>
                <li>Digital condition report and asset register after every visit</li>
              </ul>
              <Link href="/contracts" className="btn btn-primary mt-8 w-full">
                Compare contract plans
              </Link>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Industries ─────────────────────────────────────────────────── */}
      <Section tone="sunken" className="!py-16">
        <div className="container-page">
          <h2 className="text-2xl font-semibold md:text-3xl">Who we work for</h2>
          <ul className="mt-7 flex flex-wrap gap-2.5">
            {industries.map((industry) => (
              <li key={industry}>
                <Link
                  href={`/industries#${industry.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  className="inline-block rounded-sm border px-3.5 py-2 text-[14px] transition-colors hover:border-[var(--accent)]"
                  style={{ backgroundColor: "var(--surface-raised)" }}
                >
                  {industry}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── FAQ ────────────────────────────────────────────────────────── */}
      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <Eyebrow>Common questions</Eyebrow>
            <h2 className="mt-4 text-3xl font-semibold md:text-4xl">Answered plainly</h2>
            <p className="prose-body mt-5 text-[15px]">
              If the honest answer is that you do not need what we sell, that is what you will get.
            </p>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={HOME_FAQS} />
          </div>
        </div>
      </Section>

      {/* ── Close ──────────────────────────────────────────────────────── */}
      <Section tone="sunken" className="!py-20">
        <div className="container-page">
          <div className="rounded border p-10 md:p-14" style={{ backgroundColor: "var(--surface-raised)" }}>
            <h2 className="max-w-2xl text-3xl font-semibold md:text-4xl">
              Tell us what is broken. We will tell you what it costs.
            </h2>
            <p className="prose-body mt-5">
              Quotations within 24 hours of survey, itemised, with exclusions stated rather than buried.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/quote" className="btn btn-primary">
                Get a quote
              </Link>
              <a href={telLink(tenant.phone)} className="btn btn-secondary">
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
