import type { Metadata } from "next";
import { tenant, getService, telLink, graph, webPageSchema, breadcrumbSchema } from "@meridian/core";
import { QuoteForm } from "@/components/quote-form";
import { JsonLd } from "@/components/json-ld";
import { PhoneCall, Clock, ShieldCheck, Receipt } from "@phosphor-icons/react/dist/ssr";

const ANSWER = `Request a maintenance quotation from ${tenant.brandName} by choosing a service and describing the problem. Quotations are issued within 24 hours of a site survey, itemised by labour and materials, with exclusions stated on the quote. Emergencies are dispatched immediately rather than quoted.`;

export const metadata: Metadata = {
  title: "Request a Quote",
  description: ANSWER,
  alternates: { canonical: "/quote" },
};

const ASSURANCES = [
  { Icon: Clock, t: "Quotation within 24 hours", d: "Counted from the site survey, not from your enquiry." },
  { Icon: Receipt, t: "Itemised, not a lump sum", d: "Labour and materials shown separately so you can compare." },
  { Icon: ShieldCheck, t: "Exclusions stated upfront", d: "What is not covered appears on the quote, not in a later invoice." },
] as const;

export default async function QuotePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = typeof params["service"] === "string" ? params["service"] : undefined;
  const service = requested ? getService(requested) : undefined;

  return (
    <>
      <JsonLd
        json={graph(
          webPageSchema({
            path: "/quote",
            name: "Request a Quote",
            description: ANSWER,
            primaryAnswer: ANSWER,
          }),
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Request a quote", path: "/quote" },
          ]),
        )}
      />

      <div className="container-page grid gap-12 py-14 md:py-20 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-5">
          <h1 className="text-4xl font-semibold md:text-5xl">
            {service ? `Quote for ${service.shortName.toLowerCase()}` : "Request a quote"}
          </h1>
          <p className="prose-body mt-6 text-[17px]">
            {service
              ? service.tagline
              : "Tell us what needs doing and where. We will come back with a written, itemised quotation."}
          </p>

          <dl className="mt-10 space-y-6">
            {ASSURANCES.map(({ Icon, t, d }) => (
              <div key={t} className="flex gap-4">
                <Icon size={20} aria-hidden className="mt-0.5 shrink-0" style={{ color: "var(--accent)" }} />
                <div>
                  <dt className="text-[15px] font-semibold">{t}</dt>
                  <dd className="prose-body mt-1 text-[14px]">{d}</dd>
                </div>
              </div>
            ))}
          </dl>

          <div className="mt-10 rounded border p-6" style={{ backgroundColor: "var(--surface-sunken)" }}>
            <h2 className="text-[15px] font-semibold">Is it an emergency?</h2>
            <p className="prose-body mt-2 text-[14px]">
              Do not use the form. Call the 24-hour line and a technician is assigned during the call.
            </p>
            <a href={telLink(tenant.emergencyPhone)} className="btn btn-primary mt-4">
              <PhoneCall size={17} weight="fill" aria-hidden />
              {tenant.emergencyPhone}
            </a>
          </div>
        </div>

        <div className="lg:col-span-7">
          <QuoteForm defaultService={service?.slug} />
        </div>
      </div>
    </>
  );
}
