/**
 * Company identity.
 *
 * `ADM-9`, resolving `TD-9`. The previous build hardcoded a placeholder brand
 * — "Meridian Facilities Management LLC", founded 2014, 62,000 jobs completed,
 * 180+ directly employed technicians, a 94% contract renewal rate, three ISO
 * certificates and AED 10,000,000 of liability cover. None of it was true, all
 * of it was on the public site, and the audit classified publishing it as a
 * legal exposure (`PD-5`).
 *
 * Two changes follow, and they are different changes:
 *
 *  1. **Every unverifiable claim is deleted, not softened.** There is no
 *     "trusted by hundreds" standing in for "62,000 jobs". A statistic with no
 *     evidence behind it is removed; the page is shorter and true.
 *
 *  2. **What remains lives in configuration, not in source.** Identity is data
 *     — it changes when a licence renews, when a TRN is issued, when the office
 *     moves — and a data change should not be a deploy. Staging can run with
 *     different identity, and the values become editable by the `owner` role
 *     when the admin screen lands.
 *
 * ── THE RULE FOR UNSET VALUES ───────────────────────────────────────────────
 *
 * A value that is not configured reads as `null`, and a `null` is **never**
 * rendered as a placeholder, a dash, or an invented default. The caller omits
 * the whole claim. `DED-000000` on a live site is worse than no licence line at
 * all: one is a missing fact, the other is a false one.
 *
 * `missingRequiredFields()` exists so the gap is visible to an operator rather
 * than discovered by a customer reading a quote.
 */

/**
 * The activities the DET licence permits, and therefore the outer boundary of
 * what this company may quote for.
 *
 * §2.2 of the PRD: *the service catalogue in the system is derived from this
 * list and may not exceed it.* Quoting outside the licence is a licensing
 * exposure, so the system is built to make it difficult rather than convenient
 * — the catalogue keys off this union, and `QTE-9` warns on a quote line
 * categorised outside it.
 */
export const LICENSED_ACTIVITIES = [
  "painting",
  "wallpaper",
  "false-ceilings",
  "tiling",
  "plumbing-sanitary",
  "carpentry",
  "electrical-fittings-repair",
  "electromechanical-installation",
  "hvac-installation-maintenance",
  "building-cleaning",
] as const;

export type LicensedActivity = (typeof LICENSED_ACTIVITIES)[number];

/** The four families the ten activities group into. */
export type ServiceFamily = "MEP" | "Fit-out" | "Finishes" | "Soft services";

export interface LicensedActivityRecord {
  readonly key: LicensedActivity;
  /** Wording as it appears on the licence. Do not paraphrase this. */
  readonly licenceWording: string;
  readonly family: ServiceFamily;
}

export const LICENSED_ACTIVITY_REGISTER: readonly LicensedActivityRecord[] = [
  { key: "painting", licenceWording: "Painting", family: "Finishes" },
  { key: "wallpaper", licenceWording: "Wallpaper", family: "Finishes" },
  { key: "false-ceilings", licenceWording: "False ceilings", family: "Fit-out" },
  { key: "tiling", licenceWording: "Tiling", family: "Fit-out" },
  { key: "plumbing-sanitary", licenceWording: "Plumbing & sanitary", family: "MEP" },
  { key: "carpentry", licenceWording: "Carpentry", family: "Fit-out" },
  { key: "electrical-fittings-repair", licenceWording: "Electrical fittings repair", family: "MEP" },
  {
    key: "electromechanical-installation",
    licenceWording: "Electromechanical installation",
    family: "MEP",
  },
  {
    key: "hvac-installation-maintenance",
    licenceWording: "HVAC installation & maintenance",
    family: "MEP",
  },
  { key: "building-cleaning", licenceWording: "Building cleaning", family: "Soft services" },
] as const;

export function licensedActivity(key: LicensedActivity): LicensedActivityRecord {
  const found = LICENSED_ACTIVITY_REGISTER.find((a) => a.key === key);
  // Unreachable while `key` is typed, but the register is data and data gets
  // edited. Failing loudly beats returning undefined into a page template.
  if (!found) throw new Error(`Unknown licensed activity: ${key}`);
  return found;
}

export interface CompanyAddress {
  readonly street: string | null;
  readonly city: string;
  readonly region: string;
  readonly country: string;
  readonly countryCode: string;
  /** Geo coordinates for `LocalBusiness` JSON-LD. Null until the office is set. */
  readonly lat: number | null;
  readonly lng: number | null;
}

export interface CompanyIdentity {
  readonly legalName: string;
  /** Trading name, where it differs from the legal name. */
  readonly tradingName: string | null;
  /** What the UI and the site call the company. */
  readonly brandName: string;

  /** DET trade licence number. Legally required on the website (WEB-14). */
  readonly licenceNumber: string | null;
  readonly licenceIssuer: string;
  /** ISO date. Drives the expiry alert once HR-14 lands. */
  readonly licenceExpiry: string | null;

  /**
   * Commercial Register number. Cabinet Resolution 107/2022 Art. 7 obliges the
   * establishment to display this on its website and on all documents and
   * printed material — so this is not merely permitted, it is required.
   */
  readonly crNumber: string | null;

  /** 15-digit VAT registration number. Required on every tax invoice (INV-3). */
  readonly trn: string | null;

  readonly address: CompanyAddress;
  readonly phone: string | null;
  /** The 24-hour line. WEB-4 requires it reachable in one tap from every page. */
  readonly emergencyPhone: string | null;
  /** Digits only, for wa.me links. */
  readonly whatsapp: string | null;
  readonly email: string | null;

  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
}

function env(key: string): string | null {
  const value = process.env[key]?.trim();
  return value ? value : null;
}

/**
 * Known facts come from the licence and are the defaults; everything else must
 * be configured before it can be published.
 *
 * The licence number and expiry are hardcoded defaults rather than blanks
 * because they are *verified*: they come from the licence itself. They remain
 * overridable so a staging environment does not display a real licence number.
 */
export const company: CompanyIdentity = {
  legalName: env("COMPANY_LEGAL_NAME") ?? "Sumon Akon Technical Services",
  tradingName: env("COMPANY_TRADING_NAME"),
  brandName: env("COMPANY_BRAND_NAME") ?? "Sumon Akon Technical Services",

  licenceNumber: env("COMPANY_LICENCE_NUMBER") ?? "930137",
  licenceIssuer: env("COMPANY_LICENCE_ISSUER") ?? "Dubai Department of Economy and Tourism",
  licenceExpiry: env("COMPANY_LICENCE_EXPIRY") ?? "2027-01-23",

  // No default. There is no such thing as a plausible CR number.
  crNumber: env("COMPANY_CR_NUMBER"),
  trn: env("COMPANY_TRN"),

  address: {
    street: env("COMPANY_ADDRESS_STREET"),
    city: env("COMPANY_ADDRESS_CITY") ?? "Dubai",
    region: env("COMPANY_ADDRESS_REGION") ?? "Dubai",
    country: env("COMPANY_ADDRESS_COUNTRY") ?? "United Arab Emirates",
    countryCode: "AE",
    lat: Number.isFinite(Number(env("COMPANY_LAT"))) && env("COMPANY_LAT") ? Number(env("COMPANY_LAT")) : null,
    lng: Number.isFinite(Number(env("COMPANY_LNG"))) && env("COMPANY_LNG") ? Number(env("COMPANY_LNG")) : null,
  },

  phone: env("COMPANY_PHONE"),
  emergencyPhone: env("COMPANY_EMERGENCY_PHONE"),
  whatsapp: env("COMPANY_WHATSAPP")?.replace(/[^\d]/g, "") ?? null,
  email: env("COMPANY_EMAIL"),

  currency: "AED",
  timezone: "Asia/Dubai",
  locale: "en-AE",
};

/**
 * Fields that must be set before the site is fit to publish, with what each one
 * blocks.
 *
 * Surfaced by the admin screen and worth asserting in a launch check. The
 * failure this prevents is the one the audit found: nobody noticed the
 * placeholder identity because nothing ever asked whether it was real.
 */
export interface MissingField {
  readonly field: string;
  readonly envVar: string;
  readonly blocks: string;
}

export function missingRequiredFields(identity: CompanyIdentity = company): readonly MissingField[] {
  const missing: MissingField[] = [];

  if (!identity.phone) {
    missing.push({
      field: "Phone",
      envVar: "COMPANY_PHONE",
      blocks: "Contact routes, JSON-LD, every document footer",
    });
  }
  if (!identity.emergencyPhone) {
    missing.push({
      field: "Emergency phone",
      envVar: "COMPANY_EMERGENCY_PHONE",
      blocks: "WEB-4 — the 24-hour path that must work when the database does not",
    });
  }
  if (!identity.email) {
    missing.push({
      field: "Email",
      envVar: "COMPANY_EMAIL",
      blocks: "Contact routes and notification reply-to",
    });
  }
  if (!identity.address.street) {
    missing.push({
      field: "Street address",
      envVar: "COMPANY_ADDRESS_STREET",
      blocks: "LocalBusiness JSON-LD, Google Business Profile (WEB-15), tax invoices (INV-3)",
    });
  }
  if (!identity.crNumber) {
    missing.push({
      field: "Commercial Register number",
      envVar: "COMPANY_CR_NUMBER",
      blocks: "WEB-14 — legally required on the website and on all printed material",
    });
  }
  if (!identity.trn) {
    missing.push({
      field: "TRN",
      envVar: "COMPANY_TRN",
      blocks: "INV-3 — a tax invoice cannot be issued without it (OPEN-7)",
    });
  }
  if (identity.address.lat === null || identity.address.lng === null) {
    missing.push({
      field: "Geo coordinates",
      envVar: "COMPANY_LAT / COMPANY_LNG",
      blocks: "LocalBusiness JSON-LD geo block (WEB-7)",
    });
  }

  return missing;
}

/**
 * One line of legal identity, for a page footer or a document.
 *
 * Omits whatever is not configured rather than printing a placeholder. That is
 * the entire content-truth rule in one function: an incomplete line is fine, an
 * invented one is not.
 */
export function legalIdentityLine(identity: CompanyIdentity = company): string {
  const parts = [identity.legalName];
  if (identity.licenceNumber) parts.push(`DET licence ${identity.licenceNumber}`);
  if (identity.crNumber) parts.push(`CR ${identity.crNumber}`);
  if (identity.trn) parts.push(`TRN ${identity.trn}`);
  return parts.join(" · ");
}

/** `tel:` href, or null when there is no number to call. */
export function telHref(phone: string | null): string | null {
  return phone ? `tel:${phone.replace(/[^\d+]/g, "")}` : null;
}

export function whatsappHref(message: string, identity: CompanyIdentity = company): string | null {
  if (!identity.whatsapp) return null;
  return `https://wa.me/${identity.whatsapp}?text=${encodeURIComponent(message)}`;
}

// ── Placeholder detection ────────────────────────────────────────────────────

/**
 * How sure are we that a value is a placeholder rather than a fact?
 *
 * ── WHY THIS IS TWO TIERS AND NOT A BOOLEAN ─────────────────────────────────
 *
 * The first version of this returned a boolean, treated every signal as equally
 * strong, and flagged any value containing four consecutive zeros. That rule
 * rejects a real UAE TRN — they are 15 digits and commonly end `...00003` — and
 * a perfectly ordinary Dubai landline, because businesses buy round numbers.
 *
 * `assertPublishableIdentity()` **throws in production**. So the guard built to
 * stop placeholders reaching a live site would instead have blocked a
 * legitimate deploy the first time somebody entered their real TRN, and the
 * only way past it would have been `ALLOW_PLACEHOLDER_IDENTITY=1` — which
 * switches off the checks that actually matter. A false positive here is not,
 * as the original comment claimed, "one environment variable rewritten
 * slightly". It is a broken deploy whose documented workaround is to disable
 * the protection.
 *
 * So signals are graded:
 *
 *  * **`certain`** — the value cannot be real. An RFC 2606 reserved domain, a
 *    literal placeholder word, an identifier that is one repeated digit, the
 *    FTA's own worked-example TRN. These block a production deploy.
 *  * **`suspected`** — the value looks like a stand-in but could be genuine.
 *    A run of zeros in a phone number is the whole of this tier. These are
 *    reported to an operator and never block anything.
 *
 * The asymmetry is deliberate: refusing to publish something true is a worse
 * failure than surfacing a warning about something that turns out to be fine.
 */
export type PlaceholderConfidence = "certain" | "suspected";

/**
 * What kind of value this is, because the tests differ.
 *
 * A registration identifier is checked structurally — it has a known shape and
 * known worked examples. A phone number cannot be checked structurally at all,
 * because every digit pattern is a real number somewhere.
 */
export type IdentityFieldKind = "identifier" | "phone" | "email" | "text";

/** RFC 2606 and RFC 6761 reserve these. Nothing behind them is ever real. */
const RESERVED_DOMAIN = /\b(example|test|invalid|localhost)\.(com|org|net|ae|test|local)\b/;

/** Words nobody puts in a real company record. */
const PLACEHOLDER_WORD =
  /\b(placeholder|dummy|sample|lorem|ipsum|changeme|change[-_ ]?me|tbd|to[-_ ]?be[-_ ]?confirmed|your[-_ ]?company|acme|xxx+)\b/;

/**
 * The Federal Tax Authority's worked example, which turns up in copied
 * templates and in every article explaining what a TRN looks like. A real
 * registration will never be this.
 */
const FTA_EXAMPLE_TRN = "100000000000003";

export function placeholderSignal(
  value: string | null,
  kind: IdentityFieldKind = "text",
): PlaceholderConfidence | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v) return null;

  if (RESERVED_DOMAIN.test(v)) return "certain";
  if (PLACEHOLDER_WORD.test(v)) return "certain";

  const digits = v.replace(/\D/g, "");

  if (kind === "identifier") {
    if (v === FTA_EXAMPLE_TRN) return "certain";
    // One repeated digit — 0000000, 1111111, 9999999. A registration authority
    // does not issue these, and they are what somebody types to get past a
    // required field.
    if (digits.length >= 4 && /^(\d)\1+$/.test(digits)) return "certain";
    // Straight runs, ascending or descending: 12345678, 987654321.
    if (digits.length >= 6 && (isRun(digits, 1) || isRun(digits, -1))) return "certain";
    return null;
  }

  if (kind === "phone") {
    // Deliberately never `certain`. +971 4 380 0000 is a real landline, and
    // round numbers are exactly what an established business buys.
    if (digits.length >= 6 && /^(\d)\1+$/.test(digits.slice(-7))) return "suspected";
    if (/0{6,}/.test(digits)) return "suspected";
    return null;
  }

  return null;
}

function isRun(digits: string, step: 1 | -1): boolean {
  for (let i = 1; i < digits.length; i++) {
    const previous = digits.charCodeAt(i - 1);
    if (digits.charCodeAt(i) !== previous + step) return false;
  }
  return true;
}

/**
 * Retained for callers that only want a yes/no.
 *
 * Answers "is this certainly a placeholder", not "does this look a bit odd" —
 * so it cannot reintroduce the false positive that made a real TRN unpublishable.
 */
export function looksLikePlaceholder(
  value: string | null,
  kind: IdentityFieldKind = "text",
): boolean {
  return placeholderSignal(value, kind) === "certain";
}

export interface IdentityProblem {
  readonly field: string;
  readonly envVar: string;
  readonly reason: "missing" | "placeholder";
  /**
   * Only meaningful when `reason` is "placeholder".
   *
   * `certain` blocks a production deploy; `suspected` is reported and never
   * blocks. See `placeholderSignal` for why that distinction exists.
   */
  readonly confidence?: PlaceholderConfidence;
  readonly blocks: string;
}

/**
 * Everything wrong with the configured identity: unset values and placeholder
 * values, in one list.
 *
 * `missingRequiredFields()` answers "what is not set". This answers the
 * question that actually matters before a launch — "what would we publish that
 * is not true" — and it treats a plausible-looking placeholder as the more
 * dangerous of the two, because a blank renders as nothing while a placeholder
 * renders as a fact.
 */
export function identityProblems(identity: CompanyIdentity = company): readonly IdentityProblem[] {
  const problems: IdentityProblem[] = missingRequiredFields(identity).map((m) => ({
    field: m.field,
    envVar: m.envVar,
    reason: "missing" as const,
    blocks: m.blocks,
  }));

  // Each field is tested with the rules appropriate to its kind. A TRN is
  // checked structurally; a phone number cannot be, because every digit pattern
  // is somebody's real number.
  const checked: readonly (readonly [string, string, string | null, IdentityFieldKind])[] = [
    ["Legal name", "COMPANY_LEGAL_NAME", identity.legalName, "text"],
    ["Licence number", "COMPANY_LICENCE_NUMBER", identity.licenceNumber, "identifier"],
    ["Commercial Register number", "COMPANY_CR_NUMBER", identity.crNumber, "identifier"],
    ["TRN", "COMPANY_TRN", identity.trn, "identifier"],
    ["Phone", "COMPANY_PHONE", identity.phone, "phone"],
    ["Emergency phone", "COMPANY_EMERGENCY_PHONE", identity.emergencyPhone, "phone"],
    ["WhatsApp", "COMPANY_WHATSAPP", identity.whatsapp, "phone"],
    ["Email", "COMPANY_EMAIL", identity.email, "email"],
    ["Street address", "COMPANY_ADDRESS_STREET", identity.address.street, "text"],
  ];

  for (const [field, envVar, value, kind] of checked) {
    const confidence = placeholderSignal(value, kind);
    if (!confidence) continue;

    problems.push({
      field,
      envVar,
      reason: "placeholder",
      confidence,
      blocks:
        confidence === "certain"
          ? `"${value}" cannot be a real value and would be published as fact`
          : `"${value}" looks like a stand-in. Check it, but it may be genuine — round numbers are real.`,
    });
  }

  return problems;
}

/**
 * Refuse to build or run in production with placeholder identity.
 *
 * Called from the root layout, so it runs during prerender and on the first
 * render of any page — rather than waiting for somebody to scroll to a footer
 * and notice a licence number of all zeros, which is exactly how the previous
 * placeholder brand survived to a live site.
 *
 * ── THE THREE CASES ─────────────────────────────────────────────────────────
 *
 *  * **Development.** Warns loudly and continues. Placeholders are how the site
 *    renders at all before the real facts arrive, so blocking here would just
 *    mean nobody could work.
 *
 *  * **Production build or runtime.** Throws, failing the deploy with the exact
 *    list of offending variables. Failing the build is the *good* failure: it
 *    happens in a pipeline, in front of an engineer, instead of in front of a
 *    customer reading a quote.
 *
 *  * **`ALLOW_PLACEHOLDER_IDENTITY=1`.** Downgrades the throw to a warning, for
 *    local production builds and for CI, which legitimately have no real
 *    identity and are testing that the build works rather than shipping it.
 *
 * That last flag is the whole safety property. Bypassing this guard on a real
 * deployment requires somebody to deliberately set a variable named
 * `ALLOW_PLACEHOLDER_IDENTITY` in the production environment — which is a thing
 * a person does on purpose and can be asked about, not a thing that happens by
 * forgetting.
 *
 * A *missing* value is not fatal: it renders as nothing, which is honest, and
 * `missingRequiredFields()` already reports it. Only a value that would be
 * published as a fact and is not one stops the deploy.
 */
export function assertPublishableIdentity(identity: CompanyIdentity = company): void {
  // Only `certain` blocks. A `suspected` value — a phone number full of round
  // digits, say — is reported by `identityProblems()` for an operator to check
  // and must never stop a deploy: refusing to publish something true is a worse
  // failure than warning about something that turns out to be fine.
  const placeholders = identityProblems(identity).filter(
    (p) => p.reason === "placeholder" && p.confidence === "certain",
  );
  if (placeholders.length === 0) return;

  const detail = placeholders.map((p) => `  ${p.field} (${p.envVar}) — ${p.blocks}`).join("\n");
  const message =
    `Company identity contains ${placeholders.length} placeholder value(s):\n${detail}\n` +
    `Publishing these would put false statements on a public site and on tax documents. ` +
    `Set the real values (see .env.example) before deploying, or set ` +
    `ALLOW_PLACEHOLDER_IDENTITY=1 if this is a local build or CI.`;

  const bypassed = process.env["ALLOW_PLACEHOLDER_IDENTITY"] === "1";
  const isProduction = process.env["NODE_ENV"] === "production";

  if (isProduction && !bypassed) throw new Error(message);

  console.warn(`\n[identity] ${"!".repeat(70)}\n[identity] ${message}\n[identity] ${"!".repeat(70)}\n`);
}
