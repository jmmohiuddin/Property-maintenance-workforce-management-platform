/**
 * Quote / service request contract.
 *
 * Shared deliberately between the public form, the (future) API route and the
 * jobs table so validation cannot drift between them. The web form and the
 * server both parse against this schema - the client copy is a convenience,
 * the server copy is the one that counts.
 */

import { z } from "zod";
import { services } from "./catalog";

const serviceSlugs = services.map((s) => s.slug) as [string, ...string[]];

export const URGENCY = ["emergency", "today", "this-week", "planning"] as const;
export const PROPERTY_TYPES = [
  "apartment",
  "villa",
  "office",
  "retail",
  "hotel",
  "building",
  "warehouse",
  "other",
] as const;

export const quoteRequestSchema = z.object({
  name: z.string().trim().min(2, "Please enter your name").max(120),
  phone: z
    .string()
    .trim()
    .min(7, "Please enter a contactable phone number")
    .max(24)
    .regex(/^[+0-9\s()-]+$/, "Phone number contains unexpected characters"),
  email: z.email("Please enter a valid email address").max(200).optional().or(z.literal("")),
  serviceSlug: z.enum(serviceSlugs, { error: "Please choose a service" }),
  urgency: z.enum(URGENCY).default("this-week"),
  propertyType: z.enum(PROPERTY_TYPES).default("apartment"),
  city: z.string().trim().min(2).max(80),
  area: z.string().trim().max(120).optional().or(z.literal("")),
  details: z.string().trim().max(4000).optional().or(z.literal("")),
  consent: z.literal(true, { error: "We need your consent to contact you about this request" }),
  /** Honeypot - real users never fill this. Must be empty. */
  company: z.literal("").optional(),
});

export type QuoteRequest = z.infer<typeof quoteRequestSchema>;

export const URGENCY_LABEL: Readonly<Record<(typeof URGENCY)[number], string>> = {
  emergency: "Emergency - right now",
  today: "Today",
  "this-week": "This week",
  planning: "Planning ahead",
};

/**
 * Wording for the public enquiry form.
 *
 * Deliberately separate from the operational `PROPERTY_TYPE_LABEL` in `work.ts`:
 * this list is shorter (no "mixed use" — a member of the public does not think
 * in those terms) and the labels are written for someone describing their own
 * home rather than for a dispatcher reading a record.
 */
export const ENQUIRY_PROPERTY_TYPE_LABEL: Readonly<
  Record<(typeof PROPERTY_TYPES)[number], string>
> = {
  apartment: "Apartment",
  villa: "Villa",
  office: "Office",
  retail: "Retail unit",
  hotel: "Hotel / serviced apartments",
  building: "Whole building",
  warehouse: "Warehouse / industrial",
  other: "Other",
};
