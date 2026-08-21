/**
 * schema.org JSON-LD builders.
 *
 * Emitted server-side into every page. Answer engines and AI crawlers read this
 * instead of guessing at the DOM, so it is the highest-leverage AEO surface we
 * control. Rules we hold to:
 *
 *  - `@id` on every entity, so the graph links rather than repeating itself.
 *    A crawler that resolves `Organization` once should see the same node
 *    referenced from every Service and every FAQ.
 *  - Absolute URLs only. Relative URLs silently break off-site consumers.
 *  - Never mark up a claim the page does not also state in visible text.
 *    Invisible-only structured data is a manual-action risk and, more
 *    practically, a model that cannot corroborate the claim will not cite it.
 */

import { tenant, absoluteUrl } from "./tenant";
import type { Service, Faq } from "./catalog";
import type { Area } from "./areas";
import { cities } from "./areas";

type Json = Record<string, unknown>;

const ORG_ID = absoluteUrl("/#organization");
const SITE_ID = absoluteUrl("/#website");

export function organizationSchema(): Json {
  return {
    "@type": ["Organization", "LocalBusiness", "HomeAndConstructionBusiness"],
    "@id": ORG_ID,
    name: tenant.brandName,
    legalName: tenant.legalName,
    description: tenant.elevatorAnswer,
    url: absoluteUrl("/"),
    // `?? undefined`, never `null` and never a placeholder. `graph()`
    // serialises with JSON.stringify, which drops undefined properties
    // entirely — so an unconfigured fact becomes an absent property rather than
    // a null or an invented value. Structured data is a claim made to a search
    // engine in machine-readable form; a wrong one is worse than a missing one.
    telephone: tenant.phone ?? undefined,
    email: tenant.email ?? undefined,
    // `foundingDate` and `numberOfEmployees` are deliberately absent. The
    // previous values — founded 2014, "180+" employees — were invented, and
    // WEB-2 deletes an unevidenced claim rather than softening it.
    currenciesAccepted: tenant.currency,
    paymentAccepted: "Cash, Bank Transfer, Cheque",
    address: {
      "@type": "PostalAddress",
      streetAddress: tenant.address.street ?? undefined,
      addressLocality: tenant.address.city,
      addressRegion: tenant.address.region,
      addressCountry: tenant.address.countryCode,
    },
    ...(tenant.address.lat !== null && tenant.address.lng !== null
      ? {
          geo: {
            "@type": "GeoCoordinates",
            latitude: tenant.address.lat,
            longitude: tenant.address.lng,
          },
        }
      : {}),
    openingHoursSpecification: tenant.hours.map((h) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: h.days,
      opens: h.opens,
      closes: h.closes,
    })),
    areaServed: tenant.serviceAreas.map((a) => ({
      "@type": "City",
      name: a.name,
      containsPlace: a.areas.map((n) => ({ "@type": "Place", name: n })),
    })),
    hasCredential: tenant.licences.map((l) => ({
      "@type": "EducationalOccupationalCredential",
      name: l.name,
      recognizedBy: { "@type": "Organization", name: l.issuer },
      identifier: l.ref,
    })),
    knowsAbout: tenant.certifications,
    sameAs: Object.values(tenant.social),
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        telephone: tenant.phone,
        email: tenant.email,
        availableLanguage: tenant.locales,
        areaServed: tenant.serviceAreas.map((a) => a.name),
      },
      {
        "@type": "ContactPoint",
        contactType: "emergency",
        telephone: tenant.emergencyPhone,
        availableLanguage: tenant.locales,
        hoursAvailable: {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
          opens: "00:00",
          closes: "23:59",
        },
      },
    ],
  };
}

export function websiteSchema(): Json {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    url: absoluteUrl("/"),
    name: tenant.brandName,
    description: tenant.elevatorAnswer,
    publisher: { "@id": ORG_ID },
    inLanguage: tenant.locale,
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: absoluteUrl("/search?q={search_term_string}") },
      "query-input": "required name=search_term_string",
    },
  };
}

export function serviceSchema(service: Service): Json {
  return {
    "@type": "Service",
    "@id": absoluteUrl(`/services/${service.slug}#service`),
    name: service.name,
    alternateName: service.aliases,
    serviceType: service.name,
    category: service.family,
    description: service.answer,
    url: absoluteUrl(`/services/${service.slug}`),
    provider: { "@id": ORG_ID },
    areaServed: tenant.serviceAreas.map((a) => ({ "@type": "City", name: a.name })),
    hoursAvailable: service.emergency
      ? {
          "@type": "OpeningHoursSpecification",
          dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
          opens: "00:00",
          closes: "23:59",
        }
      : undefined,
    // An Offer with no `price`. The catalogue publishes no prices, because the
    // ones it used to publish were invented (see catalog.ts). Emitting a made-up
    // `price` here would be the same fabrication, made to Google in a format it
    // treats as a factual assertion and may show in a result.
    //
    // WEB-16 adds a published AED schedule of rates generated from the system's
    // own rate card; when that lands, `priceSpecification` belongs here and will
    // be true by construction.
    offers: {
      "@type": "Offer",
      priceCurrency: tenant.currency,
      availability: "https://schema.org/InStock",
      url: absoluteUrl(`/quote?service=${service.slug}`),
    },
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: `${service.name} — scope of work`,
      itemListElement: service.scope.map((item, i) => ({
        "@type": "Offer",
        position: i + 1,
        itemOffered: { "@type": "Service", name: item },
      })),
    },
  };
}

/**
 * An area page describes the same business serving a specific place, so it emits
 * a `Service` scoped to that area rather than a second `LocalBusiness`. Minting
 * a LocalBusiness per neighbourhood would claim physical premises we do not have
 * there, which is both false and a well-known local-spam signal.
 */
export function areaServiceSchema(area: Area, servicesOffered: readonly Service[]): Json {
  const city = cities.find((c) => c.name === area.city);

  return {
    "@type": "Service",
    "@id": absoluteUrl(`/areas/${area.slug}#service`),
    name: `Property maintenance in ${area.name}`,
    description: area.summary,
    url: absoluteUrl(`/areas/${area.slug}`),
    provider: { "@id": ORG_ID },
    serviceType: "Property maintenance",
    areaServed: {
      "@type": "Place",
      name: area.name,
      address: {
        "@type": "PostalAddress",
        addressLocality: area.city,
        addressRegion: area.city,
        addressCountry: tenant.address.countryCode,
      },
      ...(city ? { geo: { "@type": "GeoCoordinates", latitude: city.lat, longitude: city.lng } } : {}),
    },
    hoursAvailable: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      opens: "00:00",
      closes: "23:59",
    },
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: `Services available in ${area.name}`,
      itemListElement: servicesOffered.map((s, i) => ({
        "@type": "Offer",
        position: i + 1,
        priceCurrency: tenant.currency,
        itemOffered: {
          "@type": "Service",
          name: s.name,
          url: absoluteUrl(`/services/${s.slug}`),
        },
      })),
    },
  };
}

export function faqSchema(faqs: readonly Faq[], pagePath: string): Json {
  return {
    "@type": "FAQPage",
    "@id": absoluteUrl(`${pagePath}#faq`),
    isPartOf: { "@id": SITE_ID },
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function breadcrumbSchema(trail: readonly { name: string; path: string }[]): Json {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((t, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: t.name,
      item: absoluteUrl(t.path),
    })),
  };
}

export function howToSchema(input: {
  name: string;
  description: string;
  path: string;
  steps: readonly { name: string; text: string }[];
  totalTime?: string;
}): Json {
  return {
    "@type": "HowTo",
    "@id": absoluteUrl(`${input.path}#howto`),
    name: input.name,
    description: input.description,
    totalTime: input.totalTime,
    step: input.steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.name,
      text: s.text,
    })),
  };
}

export function webPageSchema(input: {
  path: string;
  name: string;
  description: string;
  /** The one-paragraph answer this page exists to give. */
  primaryAnswer?: string;
}): Json {
  return {
    "@type": "WebPage",
    "@id": absoluteUrl(`${input.path}#webpage`),
    url: absoluteUrl(input.path),
    name: input.name,
    description: input.description,
    isPartOf: { "@id": SITE_ID },
    about: { "@id": ORG_ID },
    inLanguage: tenant.locale,
    ...(input.primaryAnswer
      ? { mainContentOfPage: { "@type": "WebPageElement", text: input.primaryAnswer } }
      : {}),
  };
}

/**
 * Wraps nodes into a single `@graph`. One script tag per page beats several
 * disconnected ones — it lets crawlers resolve `@id` references in one pass.
 */
export function graph(...nodes: Json[]): string {
  return JSON.stringify(
    { "@context": "https://schema.org", "@graph": nodes.filter(Boolean) },
    (_k, v) => (v === undefined ? undefined : v),
  );
}
