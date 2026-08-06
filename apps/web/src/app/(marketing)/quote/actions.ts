"use server";

import { headers } from "next/headers";
import { quoteRequestSchema, getService, tenant } from "@meridian/core";
import { resolvePublicTenantId, createLeadFromEnquiry, checkRateLimit } from "@meridian/db";

/**
 * Five submissions per ten minutes from one address.
 *
 * Set from what a genuine visitor does, not from what feels safe: someone
 * pricing a leak, a callout and an AC service in one sitting is three, and a
 * mistyped phone number costs a retry. Five leaves room for that and still
 * turns a scripted flood into a trickle. Both numbers are here rather than
 * inline so the reasoning survives the next person who wants to change them.
 */
const QUOTE_RATE_LIMIT = 5;
const QUOTE_RATE_WINDOW_SECONDS = 600;

/**
 * The address to attribute a submission to.
 *
 * `x-forwarded-for` is a client-controllable header and is trusted only because
 * this deployment terminates TLS at a proxy that overwrites it. The left-most
 * entry is the client; the rest are proxies. Behind a different proxy, or none,
 * this must be revisited - a spoofable key means an attacker simply rotates it.
 */
function clientKey(h: Headers): string {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || "unknown";
}

export interface QuoteFormState {
  status: "idle" | "success" | "error";
  message?: string;
  /** Field-level messages keyed by input name, rendered under each input. */
  errors?: Record<string, string>;
  reference?: string;
}

/**
 * Public quote request.
 *
 * Server-side validation is the one that counts. The client parses the same zod
 * schema for instant feedback, but this runs regardless of whether the browser
 * executed any JavaScript at all.
 *
 * Creates a `lead`, not a job. A job needs a customer and a property, and a web
 * form has neither - it has a name, a number and a description of a problem.
 * Manufacturing a customer record per submission would fill the customer list
 * with duplicates and tyre-kickers. Operations qualifies the lead and converts
 * it, which is where a real customer and property come from. See
 * packages/db/src/domain/leads.ts.
 */
export async function submitQuoteRequest(
  _prev: QuoteFormState,
  formData: FormData,
): Promise<QuoteFormState> {
  const raw = {
    name: String(formData.get("name") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    serviceSlug: String(formData.get("serviceSlug") ?? ""),
    urgency: String(formData.get("urgency") ?? "this-week"),
    propertyType: String(formData.get("propertyType") ?? "apartment"),
    city: String(formData.get("city") ?? ""),
    area: String(formData.get("area") ?? ""),
    details: String(formData.get("details") ?? ""),
    consent: formData.get("consent") === "on",
    company: String(formData.get("company") ?? ""),
  };

  // Honeypot. Bots fill every field they find; humans never see this one.
  // Return the success shape so a bot learns nothing from the difference.
  if (raw.company !== "") {
    return { status: "success", reference: "REQ-000000" };
  }

  const parsed = quoteRequestSchema.safeParse(raw);

  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      errors[key] ??= issue.message;
    }
    return { status: "error", message: "Please check the highlighted fields.", errors };
  }

  const slug = process.env["PUBLIC_TENANT_SLUG"];
  if (!slug) {
    console.error("[quote] PUBLIC_TENANT_SLUG is not set; cannot route this enquiry");
    return {
      status: "error",
      message: `Something went wrong on our side. Please call ${tenant.phone} and we will take the details over the phone.`,
    };
  }

  const h = await headers();

  // Counted here rather than at the top of the action on purpose. Validation
  // costs no I/O, so rejecting a malformed payload before this point means a
  // flood of junk never reaches the database at all - and a visitor who
  // mistypes their phone number does not spend an attempt on it. What is being
  // limited is the expensive path: the one that writes a row.
  const limit = await checkRateLimit({
    bucket: `quote:${clientKey(h)}`,
    limit: QUOTE_RATE_LIMIT,
    windowSeconds: QUOTE_RATE_WINDOW_SECONDS,
  });

  if (!limit.allowed) {
    console.warn("[quote] rate limit reached", { key: clientKey(h) });
    return {
      status: "error",
      // No counts, no window, no "try again in N minutes". Someone probing the
      // limit learns nothing, and a real person who has genuinely sent five
      // enquiries in ten minutes needs a phone number, not arithmetic.
      message: `We have received several requests from you already. If something is urgent, please call ${tenant.emergencyPhone} and we will deal with it straight away.`,
    };
  }

  try {
    const tenantId = await resolvePublicTenantId(slug);
    if (!tenantId) throw new Error(`No active tenant with slug "${slug}"`);

    const { reference } = await createLeadFromEnquiry(tenantId, {
      name: parsed.data.name,
      phone: parsed.data.phone,
      email: parsed.data.email || undefined,
      serviceSlug: parsed.data.serviceSlug,
      urgency: parsed.data.urgency,
      propertyType: parsed.data.propertyType,
      city: parsed.data.city,
      area: parsed.data.area || undefined,
      details: parsed.data.details || undefined,
      attribution: {
        referrer: h.get("referer") ?? "",
        userAgent: h.get("user-agent") ?? "",
      },
    });

    const isEmergency = parsed.data.urgency === "emergency";
    const service = getService(parsed.data.serviceSlug);

    console.info("[quote] lead recorded", {
      reference,
      service: service?.slug,
      urgency: parsed.data.urgency,
      city: parsed.data.city,
    });

    return {
      status: "success",
      reference,
      message: isEmergency
        ? `This is flagged as an emergency and is at the top of our queue. If you have not heard from us within 10 minutes, call ${tenant.emergencyPhone} directly.`
        : "We will come back to you with a quotation within 24 hours.",
    };
  } catch (error) {
    // Never lose an enquiry silently. If the database is unreachable the
    // customer must still be told how to reach a human.
    console.error("[quote] failed to record lead", error);
    return {
      status: "error",
      message: `We could not record your request just now. Please call ${tenant.phone}, or ${tenant.emergencyPhone} if it is urgent.`,
    };
  }
}
