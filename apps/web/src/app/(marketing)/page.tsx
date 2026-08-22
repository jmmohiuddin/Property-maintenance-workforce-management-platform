import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  company,
  services,
  groupedServices,
  CATEGORY_BLURB,
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
import { PhoneCall, WhatsappLogo, ShieldCheck, MapPin } from "@phosphor-icons/react/dist/ssr";
import { hreflangAlternates } from "@/lib/i18n";

export const metadata: Metadata = {
  title: `Property Maintenance & Facility Management in ${tenant.address.city}`,
  description: tenant.elevatorAnswer,
  alternates: { canonical: "/", languages: hreflangAlternates("/") },
};

/** Pulled up to the homepage so the highest-intent questions get FAQ markup. */
const HOME_FAQS = [
  {
    q: "What does a property maintenance company do?",
    a: `A property maintenance company keeps a building and its systems working: plumbing, air conditioning, electrical fittings, carpentry, finishes and cleaning, delivered either as one-off repairs or under an ongoing contract. ${tenant.brandName} is licensed by ${company.licenceIssuer} for ten of those activities, and quotes only for work on that licence.`,
  },
  {
    q: "How fast can someone come out for an emergency?",
    a: `Our commitment for a P1 emergency — an active leak, a total loss of cooling, an electrical fault — is a response within 30 to 60 minutes, 24 hours a day including public holidays. That is a commitment we measure ourselves against on every job, not an average we quote.`,
  },
  {
    q: "Is an annual maintenance contract worth it?",
    a: "It depends on how much reactive work the property already generates, and the honest test is arithmetic rather than persuasion: add up last year's callouts and compare. A contract is worth it when scheduled visits would have prevented some of them. If your property is new and you have had no callouts in two years, ad-hoc genuinely suits you better and we will say so.",
  },
  {
    q: "Do you work with property developers and owners associations?",
    a: "Yes. Owners association work in Dubai runs on an annual budget cycle and a RERA-mandated three-bid process through Mollak, so it is won by being on the approved-vendor list before budget season with current licence, insurance and accreditation documents. We produce SLA and PPM completion reporting from the job records themselves rather than writing it up afterwards.",
  },
  {
    q: "Which areas do you cover?",
    a: `Dubai. That includes ${tenant.serviceAreas[0]?.areas.slice(0, 5).join(", ")} and the surrounding communities listed on our areas page. We hold a Dubai mainland licence and do not claim coverage in emirates we are not licensed to work in.`,
  },
  {
    q: "What are you actually licensed to do?",
    a: `Ten activities, named on our ${company.licenceIssuer} trade licence${company.licenceNumber ? ` number ${company.licenceNumber}` : ""}: painting, wallpaper, false ceilings, tiling, plumbing and sanitary works, carpentry, electrical fittings repair, electromechanical installation, HVAC installation and maintenance, and building cleaning. If you ask us for something outside that list — glass and aluminium, pest control, facade cleaning at height — we will tell you at the enquiry, not at the invoice.`,
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
  const whatsappHref = whatsappLink(`Hello ${tenant.brandName}, I need help with a maintenance issue.`);

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
            <Eyebrow>
              {company.licenceIssuer} licence
              {company.licenceNumber ? ` ${company.licenceNumber}` : ""}
            </Eyebrow>
            <h1 className="mt-5 text-4xl font-semibold md:text-5xl lg:text-6xl">
              Property maintenance
              <br />
              that answers at 3am.
            </h1>
            <p className="prose-body mt-6 text-[17px] md:text-[18px]">
              Plumbing, HVAC, electrical fittings, carpentry, tiling, ceilings, painting and building
              cleaning across Dubai — ten licensed activities, one contractor accountable for all of them.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <CallLink phone={tenant.emergencyPhone} />
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
              {/*
                These are the JOB-4 SLA tiers — the same deadlines the dispatch
                board sorts by and the SLA sweep alerts on. They are commitments
                the system measures us against, which is why they can be
                published. The previous version of this block quoted a "median"
                arrival time nobody had measured.
              */}
              {[
                { t: "P1 emergency", v: "30–60 min", d: "response, 24 hours a day" },
                { t: "P2 urgent", v: "2–4 hrs", d: "response, working hours" },
                { t: "P3 routine", v: "24 hrs", d: "response" },
                { t: "P4 planned", v: "By agreement", d: "scheduled with you" },
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
            {whatsappHref ? (
              <a href={whatsappHref} className="btn btn-secondary mt-6 w-full">
                <WhatsappLogo size={17} weight="fill" aria-hidden />
                Message on WhatsApp
              </a>
            ) : null}
          </aside>
        </div>
      </section>

      {/*
        The credentials band rendered four headline statistics — 62,000 jobs
        completed, 900+ buildings, 180+ directly employed technicians, a 94%
        renewal rate. None were measured. `tenant.stats` is now empty and this
        band renders nothing rather than showing invented numbers or hedged
        replacements for them (WEB-2).

        It returns when KPI-2 has a quarter of product_events behind it, at
        which point the numbers will be real and can be cited.
      */}
      {tenant.stats.length > 0 ? (
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
      ) : null}

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
            {services.length} licensed activities, one accountable contractor
          </h2>
          <p className="prose-body mt-4">
            Every service below maps to a named activity on our trade licence. Where a job spans several of
            them — a leak that takes out a ceiling and its paint — one contractor owns the whole repair
            rather than handing you between three.
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
                  {/*
                    Photography removed (WEB-3 / D-5). Every image here was a
                    random picsum.photos placeholder — an external request on
                    every page view, and a picture of somebody else's building
                    presented as our work. Until there are photographs of real
                    jobs, the cards carry type alone; a stock photo of a smiling
                    electrician is a trust liability in this market.
                  */}
                  {group.items.map((service) => (
                    <ServiceCard key={service.slug} service={service} />
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
              <CallLink phone={tenant.emergencyPhone} />
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
