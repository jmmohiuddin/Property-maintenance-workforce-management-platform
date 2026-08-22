"use server";

import { headers } from "next/headers";
import {
  getService,
  tenant,
  RESPONSE_COMMITMENT,
  priorityForUrgency,
  ENQUIRY_PROPERTY_TYPE_LABEL,
} from "@meridian/core";
import {
  resolvePublicTenantId,
  createLeadFromEnquiry,
  enquiryRecipients,
  checkRateLimit,
  type LeadAttribution,
} from "@meridian/db";
import { enqueue, dispatchPending, selectTransport } from "@meridian/notify";
import {
  contractEnquirySchema,
  ENQUIRY_KIND_LABEL,
  ORGANISATION_TYPE_LABEL,
  COVERAGE_CHOICE_LABEL,
  PAYMENT_TERM_LABEL,
} from "./enquiry";

/**
 * `WEB-11` — the contract and tender enquiry path.
 *
 * This is `/quote`'s action with a different question at the front and the same
 * machinery behind it, and the sameness is the point: one lead pipeline, one
 * rate limiter, one duplicate check, one notification template, one transaction
 * that either records the enquiry *and* queues the alert or does neither. The
 * long comments in `quote/actions.ts` explain each of those decisions and are
 * not repeated here — what follows are only the places this path differs.
 *
 * ── THREE PROPERTIES BEHIND ONE VISIT ───────────────────────────────────────
 *
 * A B2B enquiry carries facts the `leads` table has no column for: how many
 * buildings, which trades, what coverage model, what payment terms, which
 * tender and when it closes. Those are composed into the lead's message body
 * rather than dropped, because the alternative is a migration in a package this
 * task is not permitted to touch — and because an operator reading the lead
 * needs them in one place regardless of which columns exist.
 *
 * The one genuinely lossy field is the organisation name. `leads.company_name`
 * exists, but `PublicEnquiry` has no route to it, so it is written into the
 * body and flagged in the delivery report as the single schema change this
 * feature would benefit from.
 */

/**
 * Three submissions per ten minutes, against five on `/quote`.
 *
 * Lower because the genuine behaviour is different: nobody prices three
 * separate portfolios in one sitting. One submission, one correction after a
 * mistyped number, and one more for the person who changed their mind about the
 * trades — three covers it, and it is the smaller number that makes a scripted
 * flood of B2B-shaped spam expensive.
 */
const ENQUIRY_RATE_LIMIT = 3;
const ENQUIRY_RATE_WINDOW_SECONDS = 600;

/**
 * How close a tender deadline has to be before the enquiry stops being a diary
 * entry.
 *
 * Fourteen days is roughly the point at which a bid still has room for a survey
 * visit, a rate build-up and an internal review. Inside it, the enquiry is
 * raised at an urgency whose response commitment is hours rather than days —
 * because a tender answered after it closes is worth precisely nothing, and
 * `CON-11`'s whole design is arranged around that one fact.
 */
const TENDER_URGENT_DAYS = 14;

function clientKey(h: Headers): string {
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || "unknown";
}

function attributionFrom(h: Headers, formData: FormData): LeadAttribution {
  const field = (name: string): string | undefined =>
    String(formData.get(name) ?? "").trim() || undefined;

  let submittedFrom: URL | null = null;
  try {
    const referer = h.get("referer");
    if (referer) submittedFrom = new URL(referer);
  } catch {
    submittedFrom = null;
  }

  const query = (key: string): string | undefined =>
    submittedFrom?.searchParams.get(key)?.trim() || undefined;

  const extra: Record<string, string> = {
    userAgent: h.get("user-agent") ?? "",
    // Recorded in the blob rather than inferred from the landing page later.
    // "Which of our pages produces commercial enquiries" is a different
    // question from "which produces callouts", and it is unanswerable if both
    // arrive looking identical.
    enquiryForm: "contract",
  };
  const gclid = field("gclid") ?? query("gclid");
  if (gclid) extra["gclid"] = gclid.slice(0, 200);

  return {
    channel: "website",
    utmSource: field("utmSource") ?? query("utm_source"),
    utmMedium: field("utmMedium") ?? query("utm_medium"),
    utmCampaign: field("utmCampaign") ?? query("utm_campaign"),
    landingPage:
      field("landingPage") ??
      (submittedFrom ? `${submittedFrom.pathname}${submittedFrom.search}` : undefined),
    referrer: field("referrer"),
    extra,
  };
}

export interface ContractEnquiryState {
  status: "idle" | "success" | "error";
  message?: string;
  errors?: Record<string, string>;
  reference?: string;
}

/** Whole days from today to an ISO day string. Negative when already past. */
function daysUntil(isoDay: string): number {
  const then = Date.parse(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(then)) return Number.POSITIVE_INFINITY;
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((then - todayUtc) / (24 * 60 * 60 * 1000));
}

/**
 * Everything the lead row has no column for, as a block an operator can read.
 *
 * Labelled lines rather than prose, because this is the first thing somebody
 * sees when they open the lead and it has to survive being skimmed.
 */
function composeBody(input: ReturnType<typeof contractEnquirySchema.parse>): string {
  const lines: string[] = [
    `${ENQUIRY_KIND_LABEL[input.enquiryKind]} enquiry`,
    `Organisation: ${input.organisation} (${ORGANISATION_TYPE_LABEL[input.organisationType]})`,
  ];

  if (input.role) lines.push(`Contact role: ${input.role}`);

  lines.push(
    `Portfolio: ${input.propertyCount} × ${ENQUIRY_PROPERTY_TYPE_LABEL[input.propertyType]}`,
    `Trades in scope: ${input.serviceSlugs
      .map((slug) => getService(slug)?.name ?? slug)
      .join(", ")}`,
    `Coverage preference: ${COVERAGE_CHOICE_LABEL[input.coverage]}`,
    `Payment terms sought: ${PAYMENT_TERM_LABEL[input.paymentTermsDays]}`,
  );

  if (input.tenderReference) lines.push(`Tender reference: ${input.tenderReference}`);
  if (input.submissionDeadline) {
    const days = daysUntil(input.submissionDeadline);
    lines.push(
      `Submission deadline: ${input.submissionDeadline} (${days} day${days === 1 ? "" : "s"} away)`,
    );
  }

  if (input.details) lines.push("", input.details);

  return lines.join("\n");
}

/**
 * Public contract / tender enquiry.
 *
 * Creates a `lead`, not a contract and not a tender. The reason is the one
 * `/quote` gives for not creating a job, one step further along: a tender row
 * needs an issuing body, an opportunity source and a submission deadline that
 * somebody has read off the actual document, and a `contract` needs a customer,
 * properties and priced entitlements. A web form has an assertion from a
 * stranger. Operations qualifies it and raises the real record, which is where
 * a real tender and a real contract come from.
 */
export async function submitContractEnquiry(
  _prev: ContractEnquiryState,
  formData: FormData,
): Promise<ContractEnquiryState> {
  const raw = {
    name: String(formData.get("name") ?? ""),
    organisation: String(formData.get("organisation") ?? ""),
    role: String(formData.get("role") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    email: String(formData.get("email") ?? ""),
    enquiryKind: String(formData.get("enquiryKind") ?? "amc"),
    organisationType: String(formData.get("organisationType") ?? "property_manager"),
    propertyCount: String(formData.get("propertyCount") ?? ""),
    propertyType: String(formData.get("propertyType") ?? "building"),
    city: String(formData.get("city") ?? ""),
    area: String(formData.get("area") ?? ""),
    serviceSlugs: formData.getAll("serviceSlugs").map(String),
    coverage: String(formData.get("coverage") ?? "undecided"),
    paymentTermsDays: String(formData.get("paymentTermsDays") ?? ""),
    tenderReference: String(formData.get("tenderReference") ?? ""),
    submissionDeadline: String(formData.get("submissionDeadline") ?? ""),
    details: String(formData.get("details") ?? ""),
    consent: formData.get("consent") === "on",
    website: String(formData.get("website") ?? ""),
  };

  // Honeypot. Return the success shape so a bot learns nothing from the
  // difference between a rejection and an acceptance.
  if (raw.website !== "") {
    return { status: "success", reference: "ENQ-000000" };
  }

  const parsed = contractEnquirySchema.safeParse(raw);

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
    console.error("[contract-enquiry] PUBLIC_TENANT_SLUG is not set; cannot route this enquiry");
    return {
      status: "error",
      message: `Something went wrong on our side. Please email ${tenant.email ?? "us"} and we will pick it up from there.`,
    };
  }

  const h = await headers();

  const limit = await checkRateLimit({
    bucket: `contract-enquiry:${clientKey(h)}`,
    limit: ENQUIRY_RATE_LIMIT,
    windowSeconds: ENQUIRY_RATE_WINDOW_SECONDS,
  });

  if (!limit.allowed) {
    console.warn("[contract-enquiry] rate limit reached", { key: clientKey(h) });
    return {
      status: "error",
      message: `We have received several enquiries from you already. Please email ${tenant.email ?? tenant.phone} and we will reply to that thread instead.`,
    };
  }

  const data = parsed.data;

  /**
   * The urgency this lead is raised at, and therefore the response commitment
   * quoted back to the sender.
   *
   * A tender closing inside a fortnight is the only thing on this form with a
   * hard external deadline, so it is the only thing that lifts the priority.
   * Everything else is a commercial conversation that deserves a same-day
   * acknowledgement, not a P1 dispatch — this form is explicitly not the
   * emergency path, and the page says so next to it.
   */
  const deadlineDays = data.submissionDeadline ? daysUntil(data.submissionDeadline) : null;
  const urgency =
    deadlineDays !== null && deadlineDays <= TENDER_URGENT_DAYS ? "today" : "this-week";

  // The catalogue slug the lead row is filed against. A contract enquiry names
  // several trades and the column holds one, so the first selected is used and
  // the full list lives in the body. Filed rather than left null because
  // `/leads` groups by service, and a row with no service is invisible there.
  const primarySlug = data.serviceSlugs[0]!;
  const primaryService = getService(primarySlug);

  try {
    const tenantId = await resolvePublicTenantId(slug);
    if (!tenantId) throw new Error(`No active tenant with slug "${slug}"`);

    const body = composeBody(data);

    const { reference } = await createLeadFromEnquiry(
      tenantId,
      {
        name: data.name,
        phone: data.phone,
        email: data.email,
        serviceSlug: primarySlug,
        urgency,
        propertyType: data.propertyType,
        city: data.city,
        area: data.area || undefined,
        details: body,
        attribution: attributionFrom(h, formData),
      },
      {
        onCreated: async (tx, lead) => {
          const to = await enquiryRecipients(tx, lead.isEmergency);

          for (const recipient of to) {
            await enqueue(
              tx,
              { tenantId, actorKind: "system" },
              {
                channel: "email",
                template: "lead_created",
                to: recipient.email,
                recipientUserId: recipient.userId,
                subject: { table: "leads", id: lead.leadId },
                payload: {
                  recipientName: recipient.fullName,
                  leadReference: lead.reference,
                  // The organisation, not the individual. An alert that reads
                  // "Aisha Khan" when the enquiry is from a managing agent for
                  // eleven towers buries the only fact that decides who picks
                  // it up.
                  customerName: `${data.organisation} — ${data.name}`,
                  phone: data.phone,
                  email: data.email,
                  serviceName: `${ENQUIRY_KIND_LABEL[data.enquiryKind]}: ${primaryService?.name ?? primarySlug}`,
                  area: data.area || null,
                  urgency,
                  isEmergency: lead.isEmergency,
                  details: body,
                  respondWithin: RESPONSE_COMMITMENT[priorityForUrgency(urgency)],
                },
              },
            );
          }
        },
      },
    );

    console.info("[contract-enquiry] lead recorded", {
      reference,
      kind: data.enquiryKind,
      organisationType: data.organisationType,
      properties: data.propertyCount,
      trades: data.serviceSlugs.length,
      urgency,
    });

    void dispatchPending(tenantId, { transport: selectTransport() }).catch((error) => {
      console.error("[contract-enquiry] immediate dispatch failed; the cron will retry", error);
    });

    return {
      status: "success",
      reference,
      message:
        data.enquiryKind === "tender"
          ? "We will confirm whether we are bidding, and what we need from the pack, before your deadline. If the deadline is tight, call us as well as sending this."
          : "We will come back to you to arrange a survey. A contract is priced after seeing the plant, not before.",
    };
  } catch (error) {
    console.error("[contract-enquiry] failed to record lead", error);
    return {
      status: "error",
      message: `We could not record your enquiry just now. Please call ${tenant.phone} or email ${tenant.email ?? "us"} and we will take the details that way.`,
    };
  }
}
