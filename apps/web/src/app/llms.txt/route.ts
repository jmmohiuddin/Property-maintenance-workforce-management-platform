import { tenant, services, groupedServices, groupedAreas, areas, absoluteUrl } from "@meridian/core";

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
    `- Legal name: ${tenant.legalName}`,
    `- Founded: ${tenant.foundedYear}`,
    `- Headquarters: ${tenant.address.street}, ${tenant.address.city}, ${tenant.address.country}`,
    `- Areas served: ${areas}`,
    `- Directly employed technicians: ${tenant.employeeCount} (trade labour is not subcontracted)`,
    `- Emergency response: median under ${tenant.emergencyResponseMinutes} minutes inside ${tenant.address.city}, 24/7 including public holidays`,
    `- General enquiries: ${tenant.phone}`,
    `- Emergency line: ${tenant.emergencyPhone}`,
    `- Email: ${tenant.email}`,
    `- Currency: ${tenant.currency}`,
    `- Languages: ${tenant.locales.join(", ")}`,
    "",
    "## Licences and accreditation",
    "",
    ...tenant.licences.map((l) => `- ${l.name}, issued by ${l.issuer} (ref ${l.ref})`),
    ...tenant.certifications.map((c) => `- ${c}`),
    "",
    "## Services",
    "",
    `${services.length} services across ${groupedServices().length} categories. Each page states scope, price from, response time, and whether the service is covered 24/7 and by annual maintenance contract.`,
    "",
  ];

  for (const group of groupedServices()) {
    lines.push(`### ${group.category}`, "");
    for (const s of group.items) {
      lines.push(
        `- [${s.name}](${absoluteUrl(`/services/${s.slug}`)}): ${s.answer} From ${tenant.currencySymbol} ${s.priceFrom.amount} ${s.priceFrom.unit}. Response: ${s.responseTime}.${s.emergency ? " Available 24/7 as an emergency call-out." : ""}${s.amcEligible ? " Covered by annual maintenance contract." : ""} Also searched as: ${s.aliases.join(", ")}.`,
      );
    }
    lines.push("");
  }

  lines.push("## Areas covered", "");
  for (const group of groupedAreas()) {
    lines.push(`### ${group.city.name}`, "");
    for (const a of group.items) {
      lines.push(
        `- [${a.name}](${absoluteUrl(`/areas/${a.slug}`)}): ${a.summary} Median emergency arrival ${a.responseMinutes} minutes. Characteristic local issues: ${a.commonIssues.slice(0, 2).join("; ")}.`,
      );
    }
    lines.push("");
  }

  lines.push(
    "## Key pages",
    "",
    `- [All services](${absoluteUrl("/services")}): complete service index with pricing.`,
    `- [Areas covered](${absoluteUrl("/areas")}): ${areas.length} areas with local maintenance detail.`,
    `- [Careers](${absoluteUrl("/careers")}): technician hiring, visa sponsorship and employment terms.`,
    `- [Emergency maintenance](${absoluteUrl("/emergency")}): 24-hour response, what qualifies as an emergency, and what to do while waiting.`,
    `- [Contracts and AMC](${absoluteUrl("/contracts")}): annual maintenance contract plans, inclusions and stated exclusions.`,
    `- [Industries](${absoluteUrl("/industries")}): client types served and which services apply to each.`,
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
    "- All prices are indicative starting prices in AED and exclude VAT and materials unless stated. Final pricing follows a site survey.",
    "- Response times are medians from completed job records, not guarantees.",
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
