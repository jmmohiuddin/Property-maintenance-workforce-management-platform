import { z } from "zod";
import {
  services,
  amcServices,
  PROPERTY_TYPES,
  COVERAGE_TYPES,
  TENDER_SOURCE_CODES,
} from "@meridian/core";

/**
 * `WEB-11` — the contract and tender enquiry contract.
 *
 * ── WHY THIS IS NOT `quoteRequestSchema` ────────────────────────────────────
 *
 * A homeowner's callout and a portfolio enquiry are different shapes, and
 * flattening them into one form loses the fields that decide what happens next.
 * `/quote` asks *what is broken and where*. A property manager, an OA managing
 * agent or a main contractor is asking about **buildings, a scope, a tender
 * deadline and payment terms** — none of which `quoteRequestSchema` has a place
 * for, and three of which decide whether the enquiry is worth a survey visit
 * this week or a diary note for next budget season.
 *
 * What is deliberately *shared* is the destination: this submits through
 * `createLeadFromEnquiry`, exactly as `/quote` does, so there is one lead
 * pipeline with one set of stages, one duplicate check and one notification
 * template. A second intake path with its own table would be the mistake
 * `packages/db/src/domain/tenders.ts` opens by refusing to make.
 *
 * ── WHERE THE VOCABULARIES COME FROM ────────────────────────────────────────
 *
 * `TENDER_SOURCE_CODES` is `CON-11`'s four channels, reused rather than
 * reinvented so a web enquiry lands describing itself in the same words the
 * tender pipeline uses. `COVERAGE_TYPES` and the service list are the same
 * constants the contract builder writes against, which is what stops the
 * public form offering a shape the system cannot record.
 *
 * The whole file is client-safe on purpose: `@meridian/db` pulls the Postgres
 * driver into the browser bundle and fails the build (see the note on
 * `CONTRACT_DOCUMENT_KINDS`), so the vocabularies the form renders must come
 * from `@meridian/core`.
 */

const allSlugs = services.map((s) => s.slug) as [string, ...string[]];
const amcSlugs = new Set(amcServices.map((s) => s.slug));

export const ENQUIRY_KINDS = ["amc", "tender"] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];

export const ENQUIRY_KIND_LABEL: Readonly<Record<EnquiryKind, string>> = {
  amc: "Annual maintenance contract",
  tender: "Tender or RFP",
};

export const ENQUIRY_KIND_HINT: Readonly<Record<EnquiryKind, string>> = {
  amc: "You want scheduled maintenance for a property or a portfolio, priced after a survey.",
  tender: "You are running a bid process and need a submission against a published scope and deadline.",
};

/**
 * Who is asking. `CON-11`'s four channels plus `other`.
 *
 * `other` is added here and nowhere else: the tender pipeline's picker is a
 * controlled vocabulary because the question it answers is asked across rows,
 * but a public form that refuses a main contractor or a hotel operator because
 * they are none of the four would simply lose the enquiry. It maps to a note in
 * the lead body, not to a fifth channel.
 */
export const ORGANISATION_TYPES = [...TENDER_SOURCE_CODES, "other"] as const;
export type OrganisationType = (typeof ORGANISATION_TYPES)[number];

export const ORGANISATION_TYPE_LABEL: Readonly<Record<OrganisationType, string>> = {
  oa_management_company: "Owners Association management company",
  developer: "Developer",
  property_manager: "Property manager or landlord's agent",
  government_esupply: "Government or semi-government procurement",
  other: "Something else — contractor, hotel, retailer, occupier",
};

/** Coverage preference, plus the honest fourth answer. */
export const COVERAGE_CHOICES = [...COVERAGE_TYPES, "undecided"] as const;
export type CoverageChoice = (typeof COVERAGE_CHOICES)[number];

export const COVERAGE_CHOICE_LABEL: Readonly<Record<CoverageChoice, string>> = {
  comprehensive: "Comprehensive — labour, parts and consumables",
  labour_only: "Labour only — parts quoted separately",
  undecided: "Not decided — advise us",
};

/**
 * Payment terms, as buckets rather than a free number.
 *
 * A portfolio enquiry almost always arrives with a standard term attached, and
 * the four below are the ones that actually appear. A free-text field here
 * produces "60 days from invoice date subject to certification" and nothing a
 * commercial conversation can start from.
 */
export const PAYMENT_TERM_CHOICES = ["", "30", "45", "60", "90"] as const;

export const PAYMENT_TERM_LABEL: Readonly<Record<(typeof PAYMENT_TERM_CHOICES)[number], string>> = {
  "": "Not specified",
  "30": "30 days",
  "45": "45 days",
  "60": "60 days",
  "90": "90 days",
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const contractEnquirySchema = z
  .object({
    name: z.string().trim().min(2, "Please enter your name").max(120),
    organisation: z.string().trim().min(2, "Please enter the organisation you are asking for").max(200),
    role: z.string().trim().max(120).optional().or(z.literal("")),
    phone: z
      .string()
      .trim()
      .min(7, "Please enter a contactable phone number")
      .max(24)
      .regex(/^[+0-9\s()-]+$/, "Phone number contains unexpected characters"),
    // Required here, unlike on `/quote`. A tender response and a contract
    // proposal are documents, and a document needs somewhere to be sent.
    email: z.email("Please enter an email address we can send documents to").max(200),
    enquiryKind: z.enum(ENQUIRY_KINDS, { error: "Please choose what kind of enquiry this is" }),
    organisationType: z.enum(ORGANISATION_TYPES, { error: "Please tell us what kind of organisation this is" }),
    propertyCount: z.coerce
      .number({ error: "Please enter how many properties are in scope" })
      .int("Please enter a whole number of properties")
      .min(1, "Please enter how many properties are in scope")
      .max(2000, "Please call us — a portfolio this size needs a conversation, not a form"),
    propertyType: z.enum(PROPERTY_TYPES),
    city: z.string().trim().min(2).max(80),
    area: z.string().trim().max(120).optional().or(z.literal("")),
    serviceSlugs: z
      .array(z.enum(allSlugs))
      .min(1, "Please choose at least one trade")
      .max(services.length),
    coverage: z.enum(COVERAGE_CHOICES).default("undecided"),
    paymentTermsDays: z.enum(PAYMENT_TERM_CHOICES).default(""),
    tenderReference: z.string().trim().max(64).optional().or(z.literal("")),
    submissionDeadline: z
      .string()
      .trim()
      .regex(ISO_DAY, "Please give the deadline as a date")
      .optional()
      .or(z.literal("")),
    details: z.string().trim().max(4000).optional().or(z.literal("")),
    consent: z.literal(true, { error: "We need your consent to contact you about this enquiry" }),
    /** Honeypot — real users never fill this. Must be empty. */
    website: z.literal("").optional(),
  })
  .superRefine((value, ctx) => {
    /**
     * An AMC can only carry the trades the catalogue marks `amcEligible`.
     *
     * This is the licensing rule made into a validation rather than a
     * disclaimer. Six of the ten activities can sit inside a maintenance
     * contract; the other four are project work — a false ceiling is built
     * once, not serviced quarterly — and accepting a contract enquiry naming
     * them would mean answering it with a contract the system cannot express.
     */
    if (value.enquiryKind === "amc") {
      const projectOnly = value.serviceSlugs.filter((slug) => !amcSlugs.has(slug));
      if (projectOnly.length > 0) {
        const names = projectOnly
          .map((slug) => services.find((s) => s.slug === slug)?.shortName ?? slug)
          .join(", ");
        ctx.addIssue({
          code: "custom",
          path: ["serviceSlugs"],
          message: `${names} is project work rather than contract work. Choose "Tender or RFP", or ask for it as a separate quote.`,
        });
      }
    }

    // A tender without a closing date cannot be queued, and a queue is the
    // whole of `CON-11`. Asked for here rather than chased by email later.
    if (value.enquiryKind === "tender" && !value.submissionDeadline) {
      ctx.addIssue({
        code: "custom",
        path: ["submissionDeadline"],
        message: "Please give the submission deadline — it is what decides where this sits in the queue.",
      });
    }
  });

export type ContractEnquiry = z.infer<typeof contractEnquirySchema>;
