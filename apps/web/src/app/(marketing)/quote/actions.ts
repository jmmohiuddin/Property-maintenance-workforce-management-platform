"use server";

import { headers } from "next/headers";
import { quoteRequestSchema, getService, tenant } from "@meridian/core";
import { resolvePublicTenantId, createLeadFromEnquiry } from "@meridian/db";

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

  try {
    const tenantId = await resolvePublicTenantId(slug);
    if (!tenantId) throw new Error(`No active tenant with slug "${slug}"`);

    const h = await headers();

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
