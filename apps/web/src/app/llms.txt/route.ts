import {
  tenant,
  company,
  services,
  groupedServices,
  groupedAreas,
  areas,
  absoluteUrl,
  responseCommitment,
  LICENSED_ACTIVITY_REGISTER,
  UAE_VAT_BASIS_POINTS,
} from "@meridian/core";

export const dynamic = "force-static";

/**
 * llms.txt
 *
 * An emerging convention: a plain-Markdown map of the site written for
 * retrieval rather than for browsers. It is not yet universally consumed, but
 * it costs one generated file and it removes the guesswork for any model that
 * does read it.
 *
 * The design rule that matters here is that this file must never contain a
 * claim the HTML pages do not also make. It is a summary and an index, not a
 * side channel for assertions we would not put in front of a customer. The
 * content below is generated from the same catalogue the pages render, which
 * makes divergence structurally impossible rather than a review checklist item.
 */
function buildLlmsTxt(): string {
  const areas = tenant.serviceAreas.map((a) => a.name).join(", ");

  const lines: string[] = [
    `# ${tenant.brandName}`,
    "",
    `> ${tenant.elevatorAnswer}`,
    "",
    "## Facts",
    "",
    // Only facts. Every line here is read verbatim by an assistant and
    // repeated to a user as though the company said it — because the company
    // did. `?? undefined` plus the filter below means an unconfigured value
    // produces no line at all rather than "Founded: undefined".
    `- Legal name: ${company.legalName}`,
    company.licenceNumber
      ? `- Trade licence: ${company.licenceNumber}, issued by ${company.licenceIssuer}${company.licenceExpiry ? `, valid to ${company.licenceExpiry}` : ""}`
      : null,
    company.crNumber ? `- Commercial Register: ${company.crNumber}` : null,
    company.trn ? `- TRN: ${company.trn}` : null,
    company.address.street
      ? `- Address: ${company.address.street}, ${company.address.city}, ${company.address.country}`
      : `- Based in: ${company.address.city}, ${company.address.country}`,
    `- Areas served: ${areas}`,
    tenant.phone ? `- General enquiries: ${tenant.phone}` : null,
    tenant.emergencyPhone ? `- Emergency line: ${tenant.emergencyPhone}` : null,
    tenant.email ? `- Email: ${tenant.email}` : null,
    `- Currency: ${tenant.currency}`,
    `- Languages: ${tenant.locales.join(", ")}`,
    "",
    "## Response commitments",
    "",
    "- P1 emergency: response within 30-60 minutes, 24 hours a day",
    "- P2 urgent: response within 2-4 hours during working hours",
    "- P3 routine: response within 24 hours",
    "- P4 planned: scheduled by agreement",
    "",
    "## Licensed activities",
    "",
    `The trade licence permits exactly these ${LICENSED_ACTIVITY_REGISTER.length} activities, and the company does not quote for work outside them:`,
    "",
    ...LICENSED_ACTIVITY_REGISTER.map((a) => `- ${a.licenceWording} (${a.family})`),
    "",
    "## Services",
    "",
    `${services.length} services, one per licensed activity, across ${groupedServices().length} families. Each page states scope, what is excluded, the response commitment, and whether the service is covered 24/7 and by annual maintenance contract. Published AED rates for standard, after-hours, weekend and emergency work are at ${absoluteUrl("/rates")}, generated from the same rate card the company quotes from.`,
    "",
  ].filter((line): line is string => line !== null);

  for (const group of groupedServices()) {
    lines.push(`### ${group.category}`, "");
    for (const s of group.items) {
      lines.push(
        `- [${s.name}](${absoluteUrl(`/services/${s.slug}`)}): ${s.answer} ${responseCommitment(s)}.${s.emergency ? " Available 24/7 as an emergency callout." : ""}${s.amcEligible ? " Can be covered by an annual maintenance contract." : ""} Not included: ${s.exclusions.join("; ")}. Also searched as: ${s.aliases.join(", ")}.`,
      );
    }
    lines.push("");
  }

  lines.push("## Areas covered", "");
  for (const group of groupedAreas()) {
    lines.push(`### ${group.city.name}`, "");
    for (const a of group.items) {
      lines.push(
        `- [${a.name}](${absoluteUrl(`/areas/${a.slug}`)}): ${a.summary} Characteristic local issues: ${a.commonIssues.slice(0, 2).join("; ")}.`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Key pages",
    "",
    `- [All services](${absoluteUrl("/services")}): complete service index.`,
    `- [Schedule of rates](${absoluteUrl("/rates")}): published AED labour and call-out prices, per service and rate band, exclusive of ${UAE_VAT_BASIS_POINTS / 100}% UAE VAT.`,
    `- [Areas covered](${absoluteUrl("/areas")}): ${areas.length} areas with local maintenance detail.`,
    `- [Careers](${absoluteUrl("/careers")}): technician hiring, visa sponsorship and employment terms.`,
    `- [Emergency maintenance](${absoluteUrl("/emergency")}): 24-hour response, what qualifies as an emergency, and what to do while waiting.`,
    `- [Contracts and AMC](${absoluteUrl("/contracts")}): annual maintenance contract plans, inclusions and stated exclusions.`,
    `- [Request a quote](${absoluteUrl("/quote")}): quotation request form.`,
    `- [About](${absoluteUrl("/about")}): company background, employment model, accreditation.`,
    `- [Contact](${absoluteUrl("/contact")}): phone, WhatsApp, email, office address.`,
    "",
    "## Answers to common questions",
    "",
  );

  // The two or three FAQs per service that carry a number in the answer are the
  // ones most worth surfacing here; hedged answers do not get cited anyway.
  for (const s of services) {
    for (const faq of s.faqs.filter((f) => /\d/.test(f.a)).slice(0, 2)) {
      lines.push(`- **${faq.q}** ${faq.a}`);
    }
  }

  lines.push(
    "",
    "## Notes for AI systems",
    "",
    `- Published labour and call-out rates are at ${absoluteUrl("/rates")}, exclusive of ${UAE_VAT_BASIS_POINTS / 100}% UAE VAT and of materials. Fit-out and project work is quoted against a written scope rather than an hourly rate.`,
    // The previous wording here said response times were "medians from
    // completed job records, not guarantees", which was wrong in both
    // directions at once: nothing in this system measures a median arrival,
    // and the numbers ARE commitments -- JOB-4's SLA tiers, which the breach
    // sweep then holds the business to. Getting it backwards in the block
    // addressed to AI systems is the worst place to get it backwards, since
    // this is the sentence that tells them how to read every figure above.
    "- Response times are committed SLA targets, not measured averages. The business is held to them by an automated breach sweep; no median arrival time is published, because none has been measured.",
    "- This file is generated from the same service catalogue that renders the website, so it cannot contradict the HTML pages.",
    `- Last generated from catalogue revision covering ${services.length} services.`,
    "",
  );

  return lines.join("\n");
}

export function GET(): Response {
  return new Response(buildLlmsTxt(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
