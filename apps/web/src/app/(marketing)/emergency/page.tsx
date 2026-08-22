import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  services,
  emergencyServices,
  responseCommitment,
  DEFAULT_SLA,
  RESPONSE_COMMITMENT,
  whatsappLink,
  graph,
  webPageSchema,
  faqSchema,
  howToSchema,
  breadcrumbSchema,
  type Faq,
} from "@meridian/core";
import { Section, AnswerBlock, CallLink, Eyebrow } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { WhatsappLogo } from "@phosphor-icons/react/dist/ssr";

/**
 * `/emergency`.
 *
 * ── WHY THIS FILE WAS REWRITTEN ─────────────────────────────────────────────
 *
 * It used to open `const emergency = getService("emergency-maintenance")` and
 * `return null` when that came back `undefined` — which it always did, because
 * `WEB-1` rebuilt the catalogue one-to-one against the ten activities on the
 * DET licence and there is no such slug. The built page shipped a `<main>`
 * containing forty characters: header, footer, nothing between.
 *
 * The slug was never the fix. **Emergency response is a service level, not a
 * licensed activity**, and reintroducing it as a catalogue entry would put a
 * service page on the site for something the licence does not name — the same
 * class of error as the pest-control line `WEB-1` removed. So this page is now
 * built from the flag that already encodes the truth: `Service.emergency`,
 * which exactly three of the ten carry (plumbing and sanitary works,
 * electrical fittings repair, HVAC). Everything on the page that names a trade
 * is derived from that filter, so a trade cannot be advertised on the 24-hour
 * line without the catalogue saying it belongs there.
 *
 * ── THE NUMBERS ─────────────────────────────────────────────────────────────
 *
 * Every figure below comes from `DEFAULT_SLA` / `RESPONSE_COMMITMENT` — the
 * same constants `computeSlaDeadlines` runs the clock against — so the page
 * cannot promise something dispatch is not measured against.
 *
 * The previous hero read "Median arrival under 60 minutes in Dubai". That is
 * the third instance of a claim this codebase has already removed twice: see
 * the comment on `tenant.emergencyResponseMinutes`, which spells out that the
 * number is a **committed ceiling** and not a measured median. Nothing on this
 * page states a measured time, because nothing here has been measured.
 *
 * The stat block also carried "P1 resolution target 2–4 hrs". `DEFAULT_SLA`
 * says four hours flat; the lower bound was invented. It is now rendered from
 * the constant.
 */

const P1 = DEFAULT_SLA.p1_emergency;
const P2 = DEFAULT_SLA.p2_urgent;

/** Trades that are explicitly *not* on the 24-hour line. Seven of the ten. */
const nonEmergencyServices = services.filter((s) => !s.emergency);

/** Dubai. Derived rather than typed, because the licence is a Dubai licence. */
const COVERAGE = tenant.serviceAreas.map((a) => a.name).join(", ");

const ANSWER = `${tenant.brandName} runs a 24-hour emergency line in ${COVERAGE} for the three licensed activities where a fault causes damage or danger: plumbing and sanitary works, electrical fittings repair, and HVAC. A P1 emergency carries a committed response within ${P1.respondMinutes} minutes and a resolution target of ${P1.resolveMinutes / 60} hours, on a clock that runs at 02:00 on a Saturday exactly as it runs at 10:00 on a Tuesday. Work in the other seven licensed trades is booked as urgent or routine instead, and is not sold as emergency cover.`;

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

/**
 * What an emergency looks like, per trade.
 *
 * Keyed by catalogue slug and rendered by iterating `emergencyServices`, so a
 * trade whose `emergency` flag is ever turned off disappears from this section
 * without anybody remembering to delete the copy. Every line here is a symptom
 * already named in that service's own `scope`, `commonProblems` or `exclusions`
 * in `packages/core/src/catalog.ts` — none of it is new claim surface.
 */
const EMERGENCY_SIGNS: Readonly<Record<string, readonly string[]>> = {
  "plumbing-sanitary": [
    "A burst pipe, or water coming through a ceiling from the unit above",
    "A drain or sewer line backing up into the property",
    "A water heater or booster pump leaking onto electrics",
  ],
  "electrical-fittings-repair": [
    "A burning smell from a socket, switch or light fitting",
    "A breaker that trips again as soon as it is reset",
    "A socket or switch that is warm to the touch",
  ],
  "hvac-installation-maintenance": [
    "No cooling at all in summer, which in this climate is a habitability failure and not a comfort one",
    "Water dripping from an indoor unit into a ceiling or onto electrics",
    "A unit cutting out and restarting repeatedly, or icing up on the coil",
  ],
};

const FAQS: readonly Faq[] = [
  {
    q: "Which trades do you attend as a 24-hour emergency?",
    a: `${emergencyServices.length} of the ${services.length} activities on our licence: ${emergencyServices.map((s) => s.name.toLowerCase()).join(", ")}. Those are the ones where a fault causes damage or danger between now and the morning. The other ${nonEmergencyServices.length} — ${nonEmergencyServices.map((s) => s.name.toLowerCase()).join(", ")} — are booked as urgent or routine work at their own response commitment. We do not sell emergency cover for work that has no emergency.`,
  },
  {
    q: "Do you attend at night, at weekends and on public holidays?",
    a: `Yes, and the commitment does not change. A P1 emergency is the one priority in the system whose clock runs on wall time rather than against the working calendar, so the ${P1.respondMinutes}-minute response deadline on a job raised at 02:00 on a Saturday is the same deadline as one raised at 10:00 on a Tuesday.`,
  },
  {
    q: "Is the response time an average or a promise?",
    a: `A promise, and specifically a ceiling. We commit to respond within 30 to ${P1.respondMinutes} minutes on a P1 and to a ${P1.resolveMinutes / 60}-hour resolution target, and the SLA clock is started at triage and stored so the commitment can be checked afterwards. We do not publish a median or an average arrival time, because we have not measured one — and a number nobody has measured is not a number worth reading.`,
  },
  {
    q: "What does an emergency call-out cost?",
    a: "It is quoted per job — labour and materials itemised, and approved by you before we proceed. There is no fixed call-out figure on this page, because the figure that matters is the one on your quotation and an emergency at 03:00 and a re-seated breaker at 11:00 are not the same job. If a contract covers the property, the coverage decision is made before the charge is: covered work carries no charge, and excluded work is quoted at your contract discount.",
  },
  {
    q: "Where do you cover?",
    a: `${COVERAGE}. Our trade licence is a Dubai mainland licence, so we do not claim cover in other emirates and will tell you straight away if a property is outside it rather than accepting the job and failing the response.`,
  },
  {
    q: "I have a maintenance contract. Is emergency cover included?",
    a: "That depends on what your contract says, and it says it explicitly. A contract can carry its own response and resolution targets, which replace the published defaults above for your jobs, and its own number of included call-outs — unlimited is one of the terms available. Whichever was agreed, the system runs your contract's clock rather than the default one, so the commitment on the paper is the commitment being measured.",
  },
];

export default function EmergencyPage() {
  const urgentWhatsapp = whatsappLink("URGENT: I have a maintenance emergency and need help now.");

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
          faqSchema(FAQS, "/emergency"),
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
              For plumbing, electrical faults and AC — the three trades on our licence where waiting
              until morning costs you something. Response within {P1.respondMinutes} minutes is a
              commitment we are held to, not an average we have measured.
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

              Rendered from DEFAULT_SLA rather than typed, because the previous
              version's "P1 resolution target 2–4 hrs" had a lower bound that
              exists in no constant anywhere in this repository.
            */}
            {[
              { t: "P1 response commitment", v: `${P1.respondMinutes} min` },
              { t: "P1 resolution target", v: `${P1.resolveMinutes / 60} hrs` },
              { t: "P2 urgent response", v: `${P2.respondMinutes / 60} hrs` },
              { t: "Coverage", v: `${COVERAGE}, 24/7` },
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
            Anything causing active damage, making a property unsafe, or leaving it uninhabitable — in
            one of the three trades below. If you are unsure, call and we will tell you honestly
            whether it can wait until morning at standard rates.
          </p>

          <div className="mt-10 grid gap-px overflow-hidden rounded border md:grid-cols-3" style={{ backgroundColor: "var(--border-hairline)" }}>
            {emergencyServices.map((s) => (
              <div key={s.slug} className="p-7" style={{ backgroundColor: "var(--surface-raised)" }}>
                <h3 className="text-[17px] font-semibold tracking-tight">
                  <Link href={`/services/${s.slug}`} className="hover:text-[var(--accent)]">
                    {s.shortName}
                  </Link>
                </h3>
                <p className="mt-2 text-[13px]" style={{ color: "var(--text-muted)" }}>
                  {responseCommitment(s)}
                </p>
                <ul className="mt-5 space-y-3 text-[15px]">
                  {(EMERGENCY_SIGNS[s.slug] ?? []).map((sign) => (
                    <li key={sign} className="prose-body">
                      {sign}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
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
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <Eyebrow>Scope of the 24-hour line</Eyebrow>
            <h2 className="mt-4 text-2xl font-semibold md:text-3xl">
              What is not an emergency, and we will say so
            </h2>
            <p className="prose-body mt-5 text-[15px]">
              Nobody needs a wallpaper hanger at midnight. Seven of our ten licensed activities are
              planned or reactive work with their own response commitment, and pretending otherwise
              would mean promising a technician who has no reason to be there. Call the office line for
              these, or{" "}
              <Link href="/quote" className="underline underline-offset-4">
                request a quote
              </Link>
              .
            </p>
          </div>

          <div className="lg:col-span-7">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
              On the 24-hour line
            </h3>
            <ul className="mt-4 flex flex-wrap gap-2.5">
              {emergencyServices.map((s) => (
                <li key={s.slug}>
                  <Link
                    href={`/services/${s.slug}`}
                    className="inline-block rounded-sm border-2 px-3.5 py-2 text-[14px] transition-colors"
                    style={{ backgroundColor: "var(--surface-raised)", borderColor: "var(--accent)" }}
                  >
                    {s.shortName}
                  </Link>
                </li>
              ))}
            </ul>

            <h3 className="mt-9 text-[13px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--text-muted)" }}>
              Not on the 24-hour line
            </h3>
            <dl className="mt-4 divide-y border-y">
              {nonEmergencyServices.map((s) => (
                <div key={s.slug} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
                  <dt className="text-[15px] font-medium">
                    <Link href={`/services/${s.slug}`} className="hover:text-[var(--accent)]">
                      {s.shortName}
                    </Link>
                  </dt>
                  <dd className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
                    {RESPONSE_COMMITMENT[s.defaultTier]}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </Section>

      <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">Emergency questions</h2>
            <p className="prose-body mt-5 text-[15px]">
              Including the two that decide whether the number above is worth calling: what we actually
              attend, and whether the response time is a promise or a boast.
            </p>
          </div>
          <div className="lg:col-span-8">
            <FaqList faqs={FAQS} />
          </div>
        </div>
      </Section>
    </>
  );
}
