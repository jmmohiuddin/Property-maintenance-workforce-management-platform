import type { Metadata } from "next";
import Link from "next/link";
import {
  tenant,
  services,
  amcServices,
  responseCommitment,
  LICENSED_ACTIVITY_REGISTER,
  COVERAGE_TYPES,
  COVERAGE_TYPE_LABEL,
  COVERAGE_TYPE_DESCRIPTION,
  STANDARD_AMC_EXCLUSIONS,
  BILLING_FREQUENCIES,
  BILLING_FREQUENCY_LABEL,
  RENEWAL_BANDS,
  DEFAULT_PPM_WINDOW_DAYS,
  DEFAULT_MIDDAY_BAN,
  graph,
  webPageSchema,
  faqSchema,
  breadcrumbSchema,
  type Faq,
} from "@meridian/core";
import { Section, AnswerBlock, Eyebrow } from "@/components/ui";
import { FaqList } from "@/components/faq";
import { JsonLd } from "@/components/json-ld";
import { ContractEnquiryForm } from "./contract-enquiry-form";
import { Check, X } from "@phosphor-icons/react/dist/ssr";

/**
 * `/contracts`.
 *
 * ── WHY THIS FILE WAS REWRITTEN ─────────────────────────────────────────────
 *
 * It opened with four lookups — `getService("amc")`, `"facility-management"`,
 * `"building-maintenance"`, `"workforce-supply"` — and every one of them
 * returned `undefined`, so the component hit `if (!amc) return null` and the
 * built page shipped a `<main>` containing forty characters. Two hundred lines
 * of copy never reached a browser.
 *
 * The four dead slugs were not an accident of naming. `WEB-1` rebuilt the
 * catalogue one-to-one against the ten activities on the DET licence, and those
 * four are among the fourteen it deleted. Re-adding them would put the page
 * back on the wrong side of the licence, which is the same failure as the
 * pest-control line — and pest control is listed **by name** on `/about` under
 * "What we are not licensed for".
 *
 * ── WHAT AN AMC ACTUALLY IS ─────────────────────────────────────────────────
 *
 * A **contract type, not a licensed activity**. Three independent things in
 * this repository say so:
 *
 *  1. `LICENSED_ACTIVITY_REGISTER` has ten entries and none of them is an
 *     annual maintenance contract. `catalogueLicenceMismatches()` fails the
 *     build's tests for any service whose `licensedActivity` is not on it, so
 *     an `amc` service could not exist here even if somebody wanted one.
 *  2. `Service.amcEligible` is a **flag on the licensed trades** — six of the
 *     ten carry it. The catalogue's own model is "an AMC is a way of buying
 *     these", not "an AMC is a separate thing".
 *  3. `packages/core/src/contract.ts` and `packages/db/src/domain/contracts.ts`
 *     describe the product exactly that way: a coverage type, per-service
 *     entitlements measured in visits per year, an exclusion set, per-priority
 *     SLA targets, and a PPM planner that turns all of it into dated windows.
 *
 * So the page is built from those constants rather than from prose. Every
 * structural claim below — two coverage models, six contractable trades, seven
 * standard exclusions, ±7-day visit windows, four renewal reminders — is
 * rendered from the value the system runs on, and cannot drift from it.
 *
 * ── WHAT WAS DELETED, AND WHY ───────────────────────────────────────────────
 *
 *  * **The three priced plans.** "AED 1,200 per year", "AED 3,500", "AED 2,500
 *    per month" were invented figures, which is what `WEB-2` exists to remove
 *    and what the `Offer.price` note at the top of `catalog.ts` forbids. The
 *    published rate card is `WEB-16`, generated from the system's own rate card
 *    so the published number and the quoted number cannot diverge.
 *  * **"Pool and pump room checks", "pool chemicals", "landscape irrigation
 *    inspection".** Swimming pool plant is on `/about`'s not-licensed list AND
 *    is a standard AMC exclusion (`pool_plant`). The page was selling, inside a
 *    contract, the exact thing the contract excludes.
 *  * **The "Building & FM" plan** — asset registers, a 24-hour helpdesk,
 *    monthly reporting packs. That is facility management, sold under a licence
 *    that does not carry it.
 *  * **"Unlimited call-outs" in the headline.** Unlimited is a *term available*
 *    (`calloutsPerYear: null`), not a term every contract gets. It is described
 *    below as what it is.
 */

const CONTRACTABLE = amcServices;
const PROJECT_ONLY = services.filter((s) => !s.amcEligible);
const ACTIVITY_COUNT = LICENSED_ACTIVITY_REGISTER.length;

const ANSWER = `An annual maintenance contract with ${tenant.brandName} is a way of buying our licensed trades on a schedule rather than a separate licensed activity: preventive visits at an agreed frequency across the ${CONTRACTABLE.length} of our ${ACTIVITY_COUNT} licensed activities that recur, plus reactive cover at the response targets written into the contract. Contracts are comprehensive or labour-only, are priced after a site survey rather than from a list, and carry ${STANDARD_AMC_EXCLUSIONS.length} standard exclusions stated in the contract instead of discovered on an invoice.`;

export const metadata: Metadata = {
  title: `Annual Maintenance Contracts in ${tenant.address.city}`,
  description: ANSWER,
  alternates: { canonical: "/contracts" },
};

/** How the contract behaves once signed. Every line traces to a named function. */
const HOW_IT_RUNS = [
  {
    t: "Visits are windows, not appointments",
    d: `Each planned visit is placed with a window of ${DEFAULT_PPM_WINDOW_DAYS} days either side of its target date. A visit missed on Tuesday because of a van breakdown is still on schedule on Thursday, which is the difference between a schedule that survives contact with a year and one that is fiction by March.`,
  },
  {
    t: "Dates respect the UAE working calendar",
    d: `The whole term is planned up front against the calendar your account is configured with — weekends, and the public holidays an administrator has entered. Nothing is scheduled on a date nobody would turn up on.`,
  },
  {
    t: "Nothing outdoor is planned into the midday ban",
    d: `Outdoor work is prohibited between 12:30 and 15:00 from 15 June to 15 September. The planner refuses those slots outright — the penalty is ${DEFAULT_MIDDAY_BAN.penalty}, and a visit placed months in advance costs nothing to place at 09:00 instead.`,
  },
  {
    t: "Work outside the contract is quoted, never absorbed",
    d: "When a job matches an exclusion, or the entitlement for that trade is used up, the system says so and requires a quote at the contract discount you already agreed. It does not quietly swallow the cost and it does not quietly bill you for it.",
  },
  {
    t: "Renewal is warned about, four times",
    d: `Reminders at ${RENEWAL_BANDS.join(", ")} days before expiry, because a 90-day notice is a diary entry and a 7-day notice is a phone call. An expiring contract is a warning, never a block on work.`,
  },
] as const;

/** Terms that are yours to set. Each is a field on the contract record. */
const NEGOTIABLE = [
  { t: "Term", d: "Start and end dates, and whether it renews automatically." },
  {
    t: "Visit frequency",
    d: "Set per trade, in visits per year. Twice a year is the practical minimum for AC in this climate; four is common for units running continuously.",
  },
  {
    t: "Included call-outs",
    d: "A number per year, or unlimited. Both are real terms and the contract says which one you have.",
  },
  {
    t: "Response targets",
    d: "Per priority. A contract's own targets replace the published defaults for your jobs, and the SLA clock then runs on yours.",
  },
  {
    t: "Billing",
    d: BILLING_FREQUENCIES.map((f) => BILLING_FREQUENCY_LABEL[f].toLowerCase()).join(", "),
  },
  { t: "Payment terms", d: "Days from invoice, agreed up front and recorded on the contract." },
] as const;

/**
 * The refusals.
 *
 * On the page rather than in a comment, and phrased the way `/about` phrases
 * its not-licensed list, because a property manager comparing three bids is
 * specifically looking for who will and will not say this.
 */
const NOT_SOLD = [
  {
    t: "Facility management",
    d: "Integrated FM — helpdesk, asset lifecycle, vendor management, statutory compliance across a whole building — is not on our trade licence. We are one of the contractors an FM provider manages, not the provider.",
  },
  {
    t: "Building maintenance as a single wrapper",
    d: `We maintain buildings, but only through the ${ACTIVITY_COUNT} activities named on the licence. A contract from us lists those trades. It does not say "all maintenance", because that would be a promise the licence does not support.`,
  },
  {
    t: "Manpower and workforce supply",
    d: "Placing our staff under someone else's day-to-day direction is a separate licensed activity and we do not hold it. Our technicians work our jobs, under our supervision.",
  },
  {
    t: "The trades on our exclusions list",
    d: "Swimming pool plant, waterproofing, facade and rope-access cleaning, and anything touching the incoming electrical supply, meter or main distribution board. Each is either off the licence or needs an accreditation we do not hold.",
  },
] as const;

const FAQS: readonly Faq[] = [
  {
    q: "Is an annual maintenance contract itself a licensed activity?",
    a: `No, and it is worth being precise about it. Our trade licence names ${ACTIVITY_COUNT} activities and "maintenance contract" is not one of them — an AMC is a commercial arrangement for buying those activities on a schedule. That is why this page lists which trades a contract can carry rather than selling "maintenance" as a thing in itself.`,
  },
  {
    q: "What is the difference between comprehensive and labour-only?",
    a: `Exactly one thing, and it is the thing that decides what an AMC costs: who carries parts risk. ${COVERAGE_TYPE_DESCRIPTION.comprehensive} ${COVERAGE_TYPE_DESCRIPTION.labour_only} Visit frequency, response targets and discount are negotiable on either.`,
  },
  {
    q: "What is always excluded?",
    a: `${STANDARD_AMC_EXCLUSIONS.map((e) => e.label.toLowerCase()).join(", ")}. These are not a house preference — they are what every comprehensive AMC in this market carves out, because each is a component whose replacement cost exceeds a year of contract value. A contract that omits them is not generous, it is mispriced, and you will meet the difference at the first failure.`,
  },
  {
    q: "What happens when a job is not covered?",
    a: "You get a quote at the contract discount, before the work. The system makes the coverage decision explicitly — covered, excluded, entitlement used up, or a service the contract never carried — and an uncovered job cannot be closed as contract work. The failure this prevents is not fraud, it is kindness: a technician who does the decent thing, nobody raises a quote, and at renewal the margin is a mystery.",
  },
  {
    q: "Are the visit dates fixed?",
    a: `They are windows: a target date with ${DEFAULT_PPM_WINDOW_DAYS} days either side, generated for the whole term when the contract is activated. Dates avoid weekends and the public holidays configured for the year, and outdoor visits are never placed inside the summer midday ban between 12:30 and 15:00 from 15 June to 15 September.`,
  },
  {
    q: "Do you provide facility management, or supply staff to our own FM team?",
    a: "No to both. Integrated facility management and manpower supply are separate licensed activities and we do not hold them. We are one of the trade contractors an FM provider or an owners association appoints, and that is what our contract says.",
  },
  {
    q: "How is a contract priced?",
    a: "After a survey. Pricing a portfolio without seeing the plant is guesswork, and a number quoted before the survey only ever moves in one direction afterwards. There is no contract price list on this page because a contract price is not a list price — it is a function of the plant, the visit frequency and the coverage model, and any three of those change it. The quotation itemises labour and materials, and states the exclusions on the document rather than saving them for an invoice.",
  },
  {
    q: "Can you bid a tender?",
    a: "Yes, if the scope is inside our licence. Send it through the form on this page with the closing date — a bid queue is ordered by deadline and nothing else, so the date is the field that matters most. We will tell you before the deadline whether we are bidding, rather than going quiet.",
  },
];

export default function ContractsPage() {
  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/contracts",
            name: `Annual Maintenance Contracts in ${tenant.address.city}`,
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          faqSchema(FAQS, "/contracts"),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Contracts & AMC", path: "/contracts" },
          ]),
        )}
      />

      <section className="border-b">
        <div className="container-page pt-14 pb-16 md:pt-20 md:pb-20">
          <h1 className="max-w-3xl text-4xl font-semibold md:text-5xl">
            Priced after a survey. Exclusions on page one.
          </h1>
          <div className="mt-8">
            <AnswerBlock>{ANSWER}</AnswerBlock>
          </div>
          <div className="mt-9 flex flex-wrap gap-3">
            <a href="#enquiry" className="btn btn-primary">
              Start a contract or tender enquiry
            </a>
            <Link href="/services" className="btn btn-secondary">
              See the {ACTIVITY_COUNT} licensed activities
            </Link>
          </div>
        </div>
      </section>

      <Section tone="sunken">
        <div className="container-page">
          <Eyebrow>Coverage</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold md:text-3xl">Two models, and one difference</h2>
          <p className="prose-body mt-4 max-w-2xl">
            They differ in exactly one thing, and it is the thing that decides whether a contract is
            worth having: who carries parts risk. Everything else is negotiable on either.
          </p>

          <div className="mt-10 grid gap-6 lg:grid-cols-2">
            {COVERAGE_TYPES.map((c) => (
              <div
                key={c}
                className="rounded border p-8"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <h3 className="text-xl font-semibold tracking-tight">{COVERAGE_TYPE_LABEL[c]}</h3>
                <p className="prose-body mt-3 text-[15px]">{COVERAGE_TYPE_DESCRIPTION[c]}</p>
              </div>
            ))}
          </div>

          <h3 className="mt-14 text-xl font-semibold">Terms you set</h3>
          <dl className="mt-6 grid gap-x-10 gap-y-5 md:grid-cols-2">
            {NEGOTIABLE.map((n) => (
              <div key={n.t} className="border-b pb-4">
                <dt className="text-[15px] font-semibold">{n.t}</dt>
                <dd className="prose-body mt-1.5 text-[14px]">{n.d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          <Eyebrow>Scope</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold md:text-3xl">
            {CONTRACTABLE.length} trades a contract can carry
          </h2>
          <p className="prose-body mt-4 max-w-2xl">
            An entitlement is set per trade, in visits per year, and the schedule is generated from it.
            These are the licensed activities that recur; the rest are built once and quoted as
            projects.
          </p>

          <div
            className="mt-10 grid gap-px overflow-hidden rounded border md:grid-cols-2"
            style={{ backgroundColor: "var(--border-hairline)" }}
          >
            {CONTRACTABLE.map((s) => (
              <Link
                key={s.slug}
                href={`/services/${s.slug}`}
                className="group p-8 transition-colors"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <h3 className="text-lg font-semibold tracking-tight group-hover:text-[var(--accent)]">
                  {s.name}
                </h3>
                <p className="prose-body mt-3 text-[15px]">{s.tagline}</p>
                {/* Price removed with the rest of the invented figures; the
                    published rate card (WEB-16) is generated from the system's
                    own rate card so it cannot drift from what is quoted. */}
                <p className="mt-5 text-[14px]" style={{ color: "var(--text-secondary)" }}>
                  {responseCommitment(s)}
                </p>
              </Link>
            ))}
          </div>

          <p className="prose-body mt-8 text-[15px]">
            Not on a contract, and quoted per project instead:{" "}
            {PROJECT_ONLY.map((s, i) => (
              <span key={s.slug}>
                {i > 0 ? ", " : ""}
                <Link href={`/services/${s.slug}`} className="underline underline-offset-4">
                  {s.shortName.toLowerCase()}
                </Link>
              </span>
            ))}
            . A false ceiling is built once, not serviced quarterly, and putting it inside an annual
            fee would mean charging you every year for a thing that happens once.
          </p>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <Eyebrow>Exclusions</Eyebrow>
            <h2 className="mt-4 text-2xl font-semibold md:text-3xl">
              What no contract covers, said now
            </h2>
            <p className="prose-body mt-5 text-[15px]">
              These {STANDARD_AMC_EXCLUSIONS.length} are written into the contract as coded terms
              rather than a prose annexe, which is what makes them enforceable in both directions: the
              same list the salesperson showed you is the list the technician's screen checks against
              on site. Excluded work is quoted at your contract discount — it is never absorbed and
              never billed at full rate.
            </p>
          </div>
          <ul className="lg:col-span-8">
            {STANDARD_AMC_EXCLUSIONS.map((e) => (
              <li key={e.code} className="flex gap-4 border-b py-5 first:pt-0 last:border-0">
                <X size={17} aria-hidden className="mt-1 shrink-0" style={{ color: "var(--text-muted)" }} />
                <div>
                  <h3 className="text-[16px] font-semibold">{e.label}</h3>
                  <p className="prose-body mt-1.5 text-[15px]">{e.description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section>
        <div className="container-page">
          <Eyebrow>Once it is signed</Eyebrow>
          <h2 className="mt-4 text-2xl font-semibold md:text-3xl">How the contract actually runs</h2>
          <ul className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {HOW_IT_RUNS.map((h) => (
              <li
                key={h.t}
                className="rounded border p-7"
                style={{ backgroundColor: "var(--surface-raised)" }}
              >
                <Check size={18} weight="bold" aria-hidden style={{ color: "var(--accent)" }} />
                <h3 className="mt-4 text-[17px] font-semibold tracking-tight">{h.t}</h3>
                <p className="prose-body mt-2.5 text-[14px]">{h.d}</p>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <Eyebrow>Refusals</Eyebrow>
            <h2 className="mt-4 text-2xl font-semibold md:text-3xl">What we will not contract for</h2>
            <p className="prose-body mt-5 text-[15px]">
              Asked for regularly, and refused. Where we can point you at somebody who holds the right
              licence, we will. The full list is on{" "}
              <Link href="/about" className="underline underline-offset-4">
                our about page
              </Link>
              .
            </p>
          </div>
          <dl className="lg:col-span-8">
            {NOT_SOLD.map((n) => (
              <div key={n.t} className="border-b py-5 first:pt-0 last:border-0">
                <dt className="text-[16px] font-semibold">{n.t}</dt>
                <dd className="prose-body mt-1.5 text-[15px]">{n.d}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* The anchor lives on a wrapper rather than on `Section`, which takes no
          `id` — and giving it one would mean editing a shared component to
          serve one page. */}
      <div id="enquiry" style={{ scrollMarginTop: "5rem" }}>
        <Section>
        <div className="container-page grid gap-12 lg:grid-cols-12 lg:gap-16">
          <div className="lg:col-span-5">
            <Eyebrow>Enquiry</Eyebrow>
            <h2 className="mt-4 text-2xl font-semibold md:text-3xl">
              Contract and tender enquiries
            </h2>
            <p className="prose-body mt-5">
              For a portfolio, a building, or a bid you are running. It asks about buildings, scope,
              terms and deadlines, because those are what decide whether we can help — a form built for
              a homeowner's leaking tap cannot ask any of them.
            </p>
            <ul className="prose-body mt-8 space-y-4 text-[15px]">
              <li className="border-b pb-4">
                <strong className="font-semibold">A survey before a price.</strong> Every contract is
                quoted after seeing the plant.
              </li>
              <li className="border-b pb-4">
                <strong className="font-semibold">A tender gets an answer either way.</strong> If we
                are not bidding, you hear that before your deadline rather than after it.
              </li>
              <li className="border-b pb-4">
                <strong className="font-semibold">One trade or one line missing is a no.</strong> If
                your scope includes work outside our licence, we will say which part and why.
              </li>
            </ul>
            <p className="prose-body mt-8 text-[14px]">
              A single property with a single fault is better served by{" "}
              <Link href="/quote" className="underline underline-offset-4">
                the quote form
              </Link>
              , and something failing right now belongs on{" "}
              <Link href="/emergency" className="underline underline-offset-4">
                the emergency page
              </Link>
              .
            </p>
          </div>
          <div className="lg:col-span-7">
            <ContractEnquiryForm />
          </div>
        </div>
        </Section>
      </div>

      <Section tone="sunken">
        <div className="container-page grid gap-12 lg:grid-cols-12">
          <div className="lg:col-span-4">
            <h2 className="text-2xl font-semibold md:text-3xl">Contract questions</h2>
            <p className="prose-body mt-5 text-[15px]">
              Starting with the one most contractors would rather not answer: whether an annual
              maintenance contract is a licensed activity at all.
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
