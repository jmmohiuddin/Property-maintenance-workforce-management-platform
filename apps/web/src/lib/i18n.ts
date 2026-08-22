import { absoluteUrl } from "@meridian/core";

/**
 * Arabic locale support for the public marketing site.
 *
 * Phase 3 roadmap item ("Arabic locale with RTL", `docs/architecture/05-roadmap.md`).
 * Scope is the public marketing site only — see the routing note below and the
 * delivery report for the full reasoning. The operator app `(app)/` stays
 * English-only per `docs/spec-v2/01-product-requirements.md`'s "Native Arabic
 * UI" row ("A full RTL UI is a large, low-return project at ten users"); that
 * row is about the *operator* UI and does not apply here.
 *
 * ── ROUTING ──────────────────────────────────────────────────────────────────
 *
 * Arabic pages live under `app/ar/*` as a literal top-level segment (not a
 * dynamic `[locale]` segment). Two reasons:
 *
 *  1. English stays unprefixed (`/services/plumbing-sanitary`) so the existing,
 *     already-indexed URLs do not change. Only `/ar/*` is new. A `[locale]`
 *     segment would require prefixing English too (`/en/services/...`),
 *     re-URLing thirty pages worth of accumulated SEO for no benefit.
 *  2. `<html lang>`/`dir` ideally lives on the root layout (Next 16.3 ships
 *     `next/root-params` for exactly this), but the root layout at
 *     `apps/web/src/app/layout.tsx` is shared by `(app)`, `(portal)` and
 *     `(marketing)`, and giving `(marketing)` its own root layout means every
 *     branch needs one — which means touching `(app)` and `(portal)`, both
 *     outside this work's territory and both being edited concurrently by
 *     other agents in this session. A literal `app/ar/` segment needs no
 *     `generateStaticParams` for the locale itself and touches nothing outside
 *     `(marketing)`'s sibling tree, at the cost of `lang="ar"`/`dir="rtl"`
 *     living on a wrapper `<div>` in `app/ar/layout.tsx` rather than on
 *     `<html>`. See the delivery report for what that costs in practice and
 *     the follow-up needed to close the gap properly.
 *
 * ── WHAT IS, AND IS NOT, TRANSLATED ─────────────────────────────────────────
 *
 * Three tiers, applied consistently everywhere in `app/ar/`:
 *
 *  1. **Chrome and generic marketing copy** — nav, footer, buttons, section
 *     headings, generic sentences that do not enumerate the licensed
 *     activities verbatim. Translated below, flagged for native review in the
 *     delivery report but shipped.
 *  2. **Common trade vocabulary** — service short names, area names, property
 *     types, service families. Translated below using everyday Gulf Arabic
 *     trade terms, flagged for review, but shipped — these are not the DET
 *     licence wording, they are how a customer would say the word.
 *  3. **Licensed-activity content and legal text** — `Service.name`,
 *     `.answer`, `.scope`, `.exclusions`, `.commonProblems`, `.faqs`,
 *     `LICENSED_ACTIVITY_REGISTER[].licenceWording` (explicitly "do not
 *     paraphrase this" in `company.ts`), `Area.summary` / `.builtEnvironment`
 *     / `.commonIssues`, and the full Privacy/Terms body text. **Not
 *     translated.** Rendered in English, isolated with `dir="ltr" lang="en"`
 *     inside the RTL page, under a visible Arabic notice
 *     (`<PendingTranslationNotice />`) explaining why. A wrong translation of
 *     a DET licence line or a workmanship-warranty clause is a worse outcome
 *     than an honestly-labelled English paragraph on an Arabic page.
 */

export const locales = ["en", "ar"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

// ── Route parity ─────────────────────────────────────────────────────────────

/**
 * English (unprefixed) paths that have a real `/ar` counterpart.
 *
 * Deliberately NOT every marketing route. `/contracts` and `/emergency` are
 * excluded because both currently render no content at all in English —
 * `getService("amc")` and `getService("emergency-maintenance")` return
 * `undefined` against the current ten-item catalogue (`packages/core/src/catalog.ts`
 * has no service with either slug — see `contracts/page.tsx:17-22` and
 * `emergency/page.tsx:20-22`, both of which `return null` before rendering
 * anything). That is a pre-existing defect, not a translation gap, and is
 * called out in full in the delivery report. Translating a blank page is not
 * meaningful work, and shipping `/ar/contracts` while `/contracts` itself is
 * broken would make the Arabic site look more complete than the English one it
 * is supposed to mirror. `/quote` and `/careers/*` are excluded as an explicit
 * scope decision — see the report.
 */
const AR_STATIC_PATHS = new Set(["/", "/about", "/contact", "/privacy", "/terms"]);

/** Prefixes whose every slug has an Arabic counterpart (all ten services, all ten areas). */
const AR_PREFIXES = ["/services", "/areas"];

/** True if the given English (unprefixed) path has a matching page under `/ar`. */
export function hasArabicCounterpart(enPath: string): boolean {
  const path = enPath === "" ? "/" : enPath;
  if (AR_STATIC_PATHS.has(path)) return true;
  return AR_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** English path → its `/ar` counterpart, or `/ar` itself when there is none. */
export function toArabicPath(enPath: string): string {
  return hasArabicCounterpart(enPath) ? `/ar${enPath === "/" ? "" : enPath}` : "/ar";
}

/** `/ar/...` path → its English counterpart, or `/` when there is none. */
export function toEnglishPath(arPath: string): string {
  const stripped = arPath === "/ar" ? "/" : arPath.replace(/^\/ar/, "") || "/";
  return hasArabicCounterpart(stripped) ? stripped : "/";
}

/**
 * `alternates.languages` for a page's `Metadata` export. Returns `undefined`
 * for a path with no Arabic counterpart, so the caller spreads it in without a
 * conditional at every call site — `next.js` drops an `undefined` metadata key
 * cleanly.
 */
export function hreflangAlternates(enPath: string): Record<string, string> | undefined {
  if (!hasArabicCounterpart(enPath)) return undefined;
  return {
    "en-AE": absoluteUrl(enPath),
    "ar-AE": absoluteUrl(toArabicPath(enPath)),
    "x-default": absoluteUrl(enPath),
  };
}

// ── Chrome dictionary ────────────────────────────────────────────────────────
//
// Everyday UI Arabic — navigation, buttons, generic section headings. Not
// licence wording, not legal text. Reviewed for sense by the author (an LLM,
// not a certified translator); flagged in the delivery report as needing a
// native-speaker pass before this is treated as final, as is everything in
// this file.

export const t = {
  nav: {
    services: "الخدمات",
    contracts: "العقود والصيانة السنوية",
    emergency: "الطوارئ",
    about: "من نحن",
    contact: "اتصل بنا",
    areas: "المناطق التي نغطيها",
    quote: "اطلب عرض سعر",
    getQuote: "اطلب عرض سعر",
    openMenu: "فتح القائمة",
    primaryNav: "التنقل الرئيسي",
    mobileNav: "قائمة الجوال",
    home: "الرئيسية",
    switchToEnglish: "English",
    breadcrumb: "مسار التصفح",
    legalNav: "روابط قانونية",
    careers: "الوظائف",
    privacy: "سياسة الخصوصية",
    terms: "الشروط والأحكام",
    moreServices: "خدمات أخرى",
    areasCovered: "المناطق المغطاة",
  },
  common: {
    emergencyLine: "خط الطوارئ، على مدار الساعة",
    messageWhatsapp: "راسلنا عبر واتساب",
    seeAllServices: "عرض جميع الخدمات",
    seeAllAreas: (n: number) => `عرض جميع المناطق (${n})`,
    licence: (issuer: string, number: string) => `ترخيص ${issuer} رقم ${number}`,
    commercialRegister: "السجل التجاري",
    trn: "الرقم الضريبي (TRN)",
    responseCommitments: "التزامات وقت الاستجابة",
    servicesCount: (n: number) => `${n} نشاطًا مرخصًا`,
    checkCoverage: "تحقق من التغطية",
  },
} as const;

/**
 * Category (service family) labels. Common trade groupings, not licence
 * wording — the DET licence names the ten individual activities, not these
 * four groupings, so this is ordinary marketing paraphrase.
 */
export const CATEGORY_LABEL_AR: Record<string, string> = {
  MEP: "الأعمال الميكانيكية والكهربائية والسباكة",
  "Fit-out": "أعمال التشطيب والتجهيز",
  Finishes: "أعمال الدهانات والتشطيبات النهائية",
  "Soft services": "الخدمات المساندة",
};

/**
 * Service short names — the label used in nav, footer, chips and cards.
 * Everyday trade vocabulary, not the DET licence wording (that lives in
 * `LICENSED_ACTIVITY_REGISTER[].licenceWording`, which `company.ts` says not
 * to paraphrase, and which this file does not translate).
 *
 * Keyed by `Service.slug`. NEEDS REVIEW: every entry.
 */
export const SERVICE_SHORT_NAME_AR: Record<string, string> = {
  "plumbing-sanitary": "السباكة",
  "electrical-fittings-repair": "إصلاحات كهربائية",
  "hvac-installation-maintenance": "التكييف",
  "electromechanical-installation": "الأعمال الكهروميكانيكية",
  "false-ceilings": "الأسقف المعلقة",
  tiling: "التبليط",
  carpentry: "النجارة",
  painting: "الدهانات",
  wallpaper: "ورق الجدران",
  "building-cleaning": "تنظيف المباني",
};

/**
 * Area (neighbourhood) names. These are established Dubai place names with
 * common Arabic-media usage, not invented translations — but real-estate and
 * government sources sometimes differ on the exact form (e.g. Emaar's own
 * Arabic branding for some communities), so treat every entry as NEEDS REVIEW
 * against the developer/RTA's official Arabic name before publishing.
 *
 * Keyed by `Area.slug`.
 */
export const AREA_NAME_AR: Record<string, string> = {
  "business-bay": "الخليج التجاري",
  "downtown-dubai": "وسط مدينة دبي",
  "dubai-marina": "مرسى دبي",
  "jumeirah-lakes-towers": "أبراج بحيرات الجميرا",
  "palm-jumeirah": "نخلة الجميرا",
  "arabian-ranches": "المرابع العربية",
  "dubai-hills-estate": "روابي دبي",
  deira: "ديرة",
  "al-barsha": "البرشاء",
  "jumeirah-village-circle": "قرية جميرا الدائرية",
};

/** Property type words used on area pages. Common nouns, high confidence. */
export const PROPERTY_TYPE_AR: Record<string, string> = {
  Apartments: "شقق",
  Offices: "مكاتب",
  "Retail units": "وحدات تجارية",
  "Mixed-use towers": "أبراج متعددة الاستخدام",
  Penthouses: "بنتهاوس",
  "Serviced apartments": "شقق فندقية",
  "Whole buildings": "مبانٍ كاملة",
  Villas: "فلل",
  "Beachfront properties": "عقارات على الشاطئ",
  Townhouses: "تاون هاوس",
  "Commercial units": "وحدات تجارية",
};

export function propertyTypeAr(en: string): string {
  return PROPERTY_TYPE_AR[en] ?? en;
}

export function areaNameAr(slug: string, fallbackEn: string): string {
  return AREA_NAME_AR[slug] ?? fallbackEn;
}

export function serviceShortNameAr(slug: string, fallbackEn: string): string {
  return SERVICE_SHORT_NAME_AR[slug] ?? fallbackEn;
}

export function categoryLabelAr(en: string): string {
  return CATEGORY_LABEL_AR[en] ?? en;
}

/**
 * A generic, non-licence-wording Arabic description of what the business does,
 * for the homepage hero / meta description / JSON-LD description. Written
 * fresh rather than translated line-for-line from `tenant.elevatorAnswer`,
 * because that string enumerates all ten licensed activities by their DET
 * wording — translating it 1:1 would put an unreviewed Arabic rendering of
 * licence terminology into `<meta description>` and JSON-LD, which is exactly
 * what this file avoids. NEEDS REVIEW.
 */
export const ELEVATOR_ANSWER_AR =
  "مقاول صيانة عقارات في دبي، يقدّم خدمات السباكة والكهرباء والتكييف والنجارة والدهانات والتبليط والأسقف المعلقة وورق الجدران وتنظيف المباني، للفلل والشقق والوحدات التجارية والمباني، عبر عقود صيانة سنوية وأعمال طارئة وتنفيذ مشاريع التشطيب.";
