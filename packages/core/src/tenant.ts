/**
 * Tenant / business profile.
 *
 * Every fact an answer engine needs about the operating company lives here and
 * nowhere else. Page copy, JSON-LD, llms.txt, sitemap and the booking flow all
 * read from this object, so rebranding or launching a new city is a data edit
 * rather than a find-and-replace across the codebase.
 *
 * ASSUMPTION (documented in docs/product/00-assumptions.md): the service mix
 * (AMC contracts, gypsum & false ceiling, glass & aluminium, facility
 * management) points at a GCC market, so the defaults below are Dubai/UAE in
 * AED. Change this one file to retarget.
 */

import { cities, areasInCity } from "./areas";

export interface ServiceArea {
  /** City or emirate name as customers search for it. */
  readonly name: string;
  /** Neighbourhoods / communities - these become long-tail landing pages. */
  readonly areas: readonly string[];
  readonly primary: boolean;
}

/**
 * Derived from areas.ts rather than restated here. The coverage list and the
 * area landing pages must never disagree about where we operate, and the only
 * reliable way to guarantee that is for one to be computed from the other.
 */
const derivedServiceAreas: readonly ServiceArea[] = cities.map((city) => ({
  name: city.name,
  primary: city.primary,
  areas: areasInCity(city.name).map((a) => a.name),
}));

export interface BusinessHours {
  readonly days: readonly string[];
  readonly opens: string;
  readonly closes: string;
}

export interface TenantProfile {
  readonly legalName: string;
  readonly brandName: string;
  readonly tagline: string;
  /**
   * The single-sentence answer to "what does this company do?".
   * Answer engines quote this verbatim - keep it factual, no adjectives.
   */
  readonly elevatorAnswer: string;
  readonly foundedYear: number;
  readonly employeeCount: string;
  readonly domain: string;
  readonly locale: string;
  readonly locales: readonly string[];
  readonly currency: string;
  readonly currencySymbol: string;
  readonly timezone: string;
  readonly phone: string;
  readonly whatsapp: string;
  readonly emergencyPhone: string;
  readonly email: string;
  readonly address: {
    readonly street: string;
    readonly city: string;
    readonly region: string;
    readonly postalCode: string;
    readonly country: string;
    readonly countryCode: string;
    readonly lat: number;
    readonly lng: number;
  };
  readonly serviceAreas: readonly ServiceArea[];
  readonly hours: readonly BusinessHours[];
  readonly emergencyResponseMinutes: number;
  readonly licences: readonly { readonly name: string; readonly issuer: string; readonly ref: string }[];
  readonly certifications: readonly string[];
  readonly social: Readonly<Record<string, string>>;
  readonly stats: readonly { readonly label: string; readonly value: string; readonly detail: string }[];
}

export const tenant: TenantProfile = {
  legalName: "Meridian Facilities Management LLC",
  brandName: "Meridian Facilities",
  tagline: "Property maintenance, staffed and answered around the clock.",
  elevatorAnswer:
    "Meridian Facilities is a property maintenance and contract workforce company that supplies licensed plumbers, electricians, HVAC engineers, carpenters and cleaning crews to residential communities, commercial buildings, hotels and developers, on both emergency call-out and annual maintenance contracts.",
  foundedYear: 2014,
  employeeCount: "180+",
  domain: "https://meridianfm.example",
  locale: "en-AE",
  locales: ["en", "ar", "hi", "ur"],
  currency: "AED",
  currencySymbol: "AED",
  timezone: "Asia/Dubai",
  phone: "+971 4 000 0000",
  whatsapp: "97140000000",
  emergencyPhone: "+971 800 000 000",
  email: "service@meridianfm.example",
  address: {
    street: "Office 1204, Business Bay Tower",
    city: "Dubai",
    region: "Dubai",
    postalCode: "00000",
    country: "United Arab Emirates",
    countryCode: "AE",
    lat: 25.1857,
    lng: 55.2766,
  },
  serviceAreas: derivedServiceAreas,
  hours: [
    {
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      opens: "00:00",
      closes: "23:59",
    },
  ],
  emergencyResponseMinutes: 60,
  licences: [
    { name: "Commercial Trade Licence", issuer: "Dubai Department of Economy & Tourism", ref: "DED-000000" },
    { name: "Electrical Contractor Registration", issuer: "DEWA", ref: "DEWA-EC-0000" },
    { name: "Pest Control Permit", issuer: "Dubai Municipality", ref: "DM-PC-0000" },
  ],
  certifications: [
    "ISO 9001:2015 - Quality Management",
    "ISO 45001:2018 - Occupational Health & Safety",
    "ISO 14001:2015 - Environmental Management",
    "Dubai Municipality approved contractor",
    "Third-party public liability insured to AED 10,000,000",
  ],
  social: {
    linkedin: "https://www.linkedin.com/company/meridian-fm",
    instagram: "https://www.instagram.com/meridianfm",
    facebook: "https://www.facebook.com/meridianfm",
  },
  stats: [
    { label: "Jobs completed", value: "62,000+", detail: "since 2014, across 900+ buildings" },
    { label: "Emergency response", value: "under 60 min", detail: "median arrival time inside Dubai" },
    { label: "Directly employed technicians", value: "180+", detail: "no subcontracted labour" },
    { label: "Contract renewal rate", value: "94%", detail: "annual maintenance contracts, 2025" },
  ],
} as const;

/** Absolute URL helper - JSON-LD and sitemaps must never emit relative URLs. */
export function absoluteUrl(path = "/"): string {
  const base = (process.env["NEXT_PUBLIC_SITE_URL"] ?? tenant.domain).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function whatsappLink(message: string): string {
  return `https://wa.me/${tenant.whatsapp}?text=${encodeURIComponent(message)}`;
}

export function telLink(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
