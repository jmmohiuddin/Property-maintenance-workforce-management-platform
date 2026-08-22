/**
 * Tenant / business profile — the facts the public site and its structured
 * data are built from.
 *
 * ── WHAT THIS FILE USED TO BE ───────────────────────────────────────────────
 *
 * A placeholder brand with invented credentials: "Meridian Facilities
 * Management LLC", founded 2014, "62,000+ jobs completed since 2014, across
 * 900+ buildings", "median arrival under 60 min", "180+ directly employed
 * technicians", "94% contract renewal rate", three ISO certificates, AED
 * 10,000,000 of third-party liability cover, and a trade licence numbered
 * `DED-000000`. All of it rendered on a live site. The audit classified it as a
 * legal exposure (`PD-5`), and `WEB-2` is the fix.
 *
 * ── THE RULE APPLIED HERE ───────────────────────────────────────────────────
 *
 * *A claim with no evidence is deleted, not softened.* There is no "trusted by
 * hundreds of buildings" standing in for the job count, and no "fully insured"
 * standing in for the AED 10m figure. `stats`, `certifications` and `social` are
 * now empty arrays, and the pages that rendered them render nothing. The site
 * is shorter and every sentence on it is true.
 *
 * What survives are facts from the licence, and they live in `./company.ts` as
 * configuration rather than as constants here (`ADM-9`). This file composes
 * them into the shape the marketing pages and JSON-LD already consume.
 *
 * ── GEOGRAPHY ───────────────────────────────────────────────────────────────
 *
 * Coverage is Dubai. The previous file claimed Abu Dhabi and Sharjah on a Dubai
 * **mainland** licence, which is precisely the kind of unevidenced claim
 * `WEB-2` removes. `WEB-6` narrows this further — to the areas a dispatcher can
 * actually reach inside the stated response tier — and that needs the owner's
 * answer, not a guess.
 */

import { cities, areasInCity } from "./areas";
import { company, type CompanyIdentity } from "./company";

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

export interface Licence {
  readonly name: string;
  readonly issuer: string;
  readonly ref: string;
  /** ISO date, where known. Drives the expiry warning once HR-14 lands. */
  readonly expires: string | null;
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
  readonly domain: string;
  readonly locale: string;
  readonly locales: readonly string[];
  readonly currency: string;
  readonly currencySymbol: string;
  readonly timezone: string;
  /** Null until configured. Never rendered as a placeholder — see company.ts. */
  readonly phone: string | null;
  readonly whatsapp: string | null;
  readonly emergencyPhone: string | null;
  readonly email: string | null;
  readonly address: {
    readonly street: string | null;
    readonly city: string;
    readonly region: string;
    readonly country: string;
    readonly countryCode: string;
    readonly lat: number | null;
    readonly lng: number | null;
  };
  readonly serviceAreas: readonly ServiceArea[];
  readonly hours: readonly BusinessHours[];
  /**
   * The **committed** emergency response ceiling, in minutes.
   *
   * This is `JOB-4`'s P1 tier — respond within 30 to 60 minutes — not a
   * measured median. The distinction matters: the previous file published a
   * "median arrival time" nobody had measured, which is a claim. A commitment
   * is a promise the business chooses to make and the SLA clock then holds it
   * to, which is a different thing entirely and is defensible.
   */
  readonly emergencyResponseMinutes: number;
  /** Only licences we hold and can evidence. Empty is a valid state. */
  readonly licences: readonly Licence[];
  /**
   * Third-party certifications. **Empty, deliberately.**
   *
   * The three ISO certificates and the insurance figure previously listed here
   * were not held. `HR-14` builds a real company accreditation register with
   * documents and expiry dates; until an entry there is backed by a certificate
   * on file, nothing appears on the public site.
   */
  readonly certifications: readonly string[];
  /** Empty until the accounts exist and have been verified. */
  readonly social: Readonly<Record<string, string>>;
  /**
   * Headline statistics. **Empty, deliberately.**
   *
   * Every number that was here was invented. Real ones become available once
   * `KPI-2` has a quarter of `product_events` behind it — at which point they
   * can be published because they can be evidenced.
   */
  readonly stats: readonly { readonly label: string; readonly value: string; readonly detail: string }[];
}

function buildLicences(identity: CompanyIdentity): readonly Licence[] {
  // One entry, and only when the number is actually configured. A licence list
  // is a trust surface: an unverifiable entry costs more than an empty list.
  if (!identity.licenceNumber) return [];
  return [
    {
      name: "Professional / services trade licence",
      issuer: identity.licenceIssuer,
      ref: identity.licenceNumber,
      expires: identity.licenceExpiry,
    },
  ];
}

export const tenant: TenantProfile = {
  legalName: company.legalName,
  brandName: company.brandName,
  tagline: "Licensed multi-trade maintenance and fit-out in Dubai.",
  elevatorAnswer:
    "A Dubai mainland technical services contractor licensed for painting, wallpaper, false ceilings, tiling, plumbing and sanitary works, carpentry, electrical fittings repair, electromechanical installation, HVAC installation and maintenance, and building cleaning — working for villas, apartments, commercial units and buildings on annual maintenance contracts, reactive callouts and fit-out projects.",
  domain: process.env["NEXT_PUBLIC_SITE_URL"] ?? "http://localhost:3000",
  locale: company.locale,
  // `locales` drives `ContactPoint.availableLanguage` in JSON-LD — a claim
  // about which languages a caller is actually served in, not about the
  // website's UI. Left at English only because nobody has confirmed which
  // languages the phone line is staffed in; changing it is a staffing fact to
  // verify, not a copy change. It is intentionally not read by the website's
  // language plumbing.
  //
  // The *public marketing site* separately ships an Arabic RTL locale under
  // `/ar` (Phase 3 roadmap item, see `docs/architecture/05-roadmap.md` and
  // `apps/web/src/lib/i18n.ts`) — a subset of pages, with licensed-activity
  // content and legal text left in English pending professional translation.
  // Each `/ar` page sets its own `inLanguage: "ar-AE"` in `webPageSchema` /
  // `websiteSchema` rather than reading this field. §6.2 / the "Native Arabic
  // UI" row in `01-product-requirements.md` still holds for the *operator*
  // app: that scoping was always about `(app)`, not the public site, and
  // `(app)` stays English-only.
  locales: ["en"],
  currency: company.currency,
  currencySymbol: company.currency,
  timezone: company.timezone,
  phone: company.phone,
  whatsapp: company.whatsapp,
  emergencyPhone: company.emergencyPhone,
  email: company.email,
  address: company.address,
  serviceAreas: derivedServiceAreas,
  hours: [
    {
      // The emergency line is 24/7 (`WEB-4`). Office hours are a separate,
      // configurable thing that belongs in the working calendar (`JOB-6`,
      // `ADM-10`) rather than being asserted here — `OPEN-8` is the question.
      days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      opens: "00:00",
      closes: "23:59",
    },
  ],
  emergencyResponseMinutes: 60,
  licences: buildLicences(company),
  certifications: [],
  social: {},
  stats: [],
} as const;

/** Absolute URL helper - JSON-LD and sitemaps must never emit relative URLs. */
export function absoluteUrl(path = "/"): string {
  const base = (process.env["NEXT_PUBLIC_SITE_URL"] ?? tenant.domain).replace(/\/$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Null when there is no number configured, so the caller omits the link. */
export function whatsappLink(message: string): string | null {
  if (!tenant.whatsapp) return null;
  return `https://wa.me/${tenant.whatsapp}?text=${encodeURIComponent(message)}`;
}

/**
 * `tel:` href, or `undefined` when there is no number.
 *
 * `undefined` rather than `null` so it drops out of JSX props cleanly. Note
 * that an anchor with no href and an empty label is a dead control — where the
 * number is also the visible label, use `<CallLink>`, which renders nothing at
 * all instead.
 */
export function telLink(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  return `tel:${phone.replace(/[^\d+]/g, "")}`;
}
