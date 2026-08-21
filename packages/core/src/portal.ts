import type { JobStatus } from "./work";

/**
 * Vocabularies the portal and the CRM share.
 *
 * Here rather than in `@meridian/db` for the same reason `STATUS_LABEL` is:
 * these lists are read by a form, by a domain function and by a database CHECK
 * constraint, and a list that lives next to only one of the three drifts from
 * the other two silently. The CHECK is the backstop; this is the definition.
 */

// ── POR-5. Customer notification events ──────────────────────────────────────

/**
 * The seven events `POR-5` names, in the order a customer meets them.
 *
 * Ordered deliberately: the opt-out screen renders them in this sequence, which
 * is the life of one request from raising it to paying for it. An alphabetical
 * list would put "invoice issued" second and read as a bill demanding to be
 * paid before anybody has been sent.
 */
export const CUSTOMER_NOTIFICATION_EVENTS = [
  "request_received",
  "visit_scheduled",
  "technician_en_route",
  "work_complete",
  "quote_awaiting_decision",
  "invoice_issued",
  "payment_received",
] as const;

export type CustomerNotificationEvent = (typeof CUSTOMER_NOTIFICATION_EVENTS)[number];

/** Narrowing for anything that arrives from a form post or a query string. */
export function isCustomerNotificationEvent(value: string): value is CustomerNotificationEvent {
  return (CUSTOMER_NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

export const CUSTOMER_NOTIFICATION_EVENT_LABEL: Readonly<Record<CustomerNotificationEvent, string>> =
  {
    request_received: "Request received",
    visit_scheduled: "Visit scheduled",
    technician_en_route: "Technician on the way",
    work_complete: "Work complete",
    quote_awaiting_decision: "Quotation waiting for you",
    invoice_issued: "Invoice issued",
    payment_received: "Payment received",
  };

/**
 * What each message actually says, written for the person deciding whether to
 * keep it.
 *
 * A preferences screen listing seven event names and seven switches asks
 * somebody to guess what they are turning off. These sentences are the screen's
 * real content.
 */
export const CUSTOMER_NOTIFICATION_EVENT_DESCRIPTION: Readonly<
  Record<CustomerNotificationEvent, string>
> = {
  request_received: "We have your request and its reference number.",
  visit_scheduled: "A technician and a time window have been booked.",
  technician_en_route: "Someone is on their way to you now.",
  work_complete: "The work is finished, with what was done.",
  quote_awaiting_decision: "A quotation needs your approval before we can start.",
  invoice_issued: "An invoice has been raised, with the amount and the due date.",
  payment_received: "We have received your payment.",
};

// ── LEAD-9. Communications log ───────────────────────────────────────────────

export const COMMUNICATION_CHANNELS = [
  "call",
  "whatsapp",
  "email",
  "sms",
  "site_visit",
  "meeting",
  "note",
] as const;

export type CommunicationChannel = (typeof COMMUNICATION_CHANNELS)[number];

export function isCommunicationChannel(value: string): value is CommunicationChannel {
  return (COMMUNICATION_CHANNELS as readonly string[]).includes(value);
}

export const COMMUNICATION_CHANNEL_LABEL: Readonly<Record<CommunicationChannel, string>> = {
  call: "Call",
  whatsapp: "WhatsApp",
  email: "Email",
  sms: "SMS",
  site_visit: "Site visit",
  meeting: "Meeting",
  note: "Note",
};

export type CommunicationDirection = "inbound" | "outbound";

/**
 * What came of it.
 *
 * Coded rather than typed for the reason `LEAD-6`'s disposition list exists:
 * "no answer", "No Answer", "n/a" and "didn't pick up" are one outcome written
 * four ways, and the only report anybody wants from a communications log —
 * how many attempts it takes to reach somebody, and which channel reaches them
 * — cannot group them back together afterwards.
 *
 * Short on purpose. `LEAD-9` requires logging to be one click and one sentence;
 * a twenty-item picker is neither.
 */
export const COMMUNICATION_OUTCOMES = [
  "spoke",
  "no_answer",
  "voicemail",
  "wrong_number",
  "site_visit_booked",
  "quote_requested",
  "not_interested",
  "call_back_later",
  "sent",
] as const;

export type CommunicationOutcome = (typeof COMMUNICATION_OUTCOMES)[number];

export function isCommunicationOutcome(value: string): value is CommunicationOutcome {
  return (COMMUNICATION_OUTCOMES as readonly string[]).includes(value);
}

export const COMMUNICATION_OUTCOME_LABEL: Readonly<Record<CommunicationOutcome, string>> = {
  spoke: "Spoke to them",
  no_answer: "No answer",
  voicemail: "Left a voicemail",
  wrong_number: "Wrong number",
  site_visit_booked: "Site visit booked",
  quote_requested: "Asked for a quote",
  not_interested: "Not interested",
  call_back_later: "Call back later",
  sent: "Sent",
};

/**
 * Which outcomes are worth a default follow-up, and how many days out.
 *
 * `LEAD-9`'s "one click plus one sentence" cannot also mean "and now pick a
 * date". An unanswered call that sets no follow-up is a lead that is dropped by
 * accident rather than by decision, so the outcome carries the nudge with it
 * and the operator overrides it only when they want something different.
 *
 * `not_interested` and `wrong_number` deliberately get nothing: chasing those
 * is what makes people stop answering.
 */
export const FOLLOW_UP_DAYS_FOR_OUTCOME: Readonly<Record<CommunicationOutcome, number | null>> = {
  spoke: 3,
  no_answer: 1,
  voicemail: 2,
  wrong_number: null,
  site_visit_booked: 1,
  quote_requested: 2,
  not_interested: null,
  call_back_later: 7,
  sent: 3,
};

// ── LEAD-5. Phone matching ───────────────────────────────────────────────────

/**
 * The comparable part of a phone number.
 *
 * The mirror of `app_phone_key()` in migration 0016, and it must stay one: the
 * database uses the SQL version to build the index and this one decides what to
 * look up in it. A disagreement between them is a matcher that silently finds
 * nothing — no error, no empty-result warning, just a duplicate check that
 * always says "new".
 *
 * What it produces is the **national significant number**: the digits left once
 * the international prefix, the country code and the trunk zero are gone.
 *
 *     +971 50 123 4567   →  501234567     (mobile, 9 digits)
 *     050 123 4567       →  501234567
 *     00971501234567     →  501234567
 *     +971 4 555 0100    →  45550100      (landline, 8 digits)
 *     04 555 0100        →  45550100
 *
 * ── WHY NOT "THE LAST NINE DIGITS" ─────────────────────────────────────────
 *
 * Because that rule works for mobiles and fails silently on landlines, which
 * have an eight-digit subscriber number. Taking nine from the right of
 * "+971 4 555 0100" keeps a digit of the country code, and the key can then
 * never equal the one derived from "04 555 0100" — so every office switchboard
 * becomes its own duplicate-free island. An owners association is exactly the
 * customer whose number is a landline, which makes it the case that matters
 * most rather than an edge one.
 *
 * Fewer than seven digits returns null: that is a fragment somebody typed, and
 * treating it as a key makes every short string match every other one.
 */
export function localPhoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const nsn = raw
    .replace(/\D/g, "")
    .replace(/^00/, "")
    // Safe to strip unconditionally: no UAE national number begins with 971.
    // They start with 5 (mobile) or a 2/3/4/6/7/9 area code.
    .replace(/^971/, "")
    .replace(/^0+/, "");

  return nsn.length < 7 ? null : nsn;
}

/** Lower-cased and trimmed, or null. The email half of the same matcher. */
export function emailKey(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

// ── POR-3. What a status change means to the customer ────────────────────────

/**
 * The job timeline, in the customer's language.
 *
 * `STATUS_LABEL` is written for a dispatcher — "Triaged", "Dispatched",
 * "Work complete" — and those are internal process names. A customer reading
 * "Triaged" learns nothing. Each line here says what happened to *their*
 * request instead.
 *
 * Typed against `JobStatus` rather than `string`, so adding a status to the
 * workflow is a compile error here rather than a blank row on a customer's
 * timeline.
 *
 * `draft` still gets a line, because the map must be total — but a draft job is
 * never shown: `listPortalRequests` excludes it, since a job that has not been
 * raised is not yet a fact about the customer's account.
 */
export const PORTAL_JOB_NARRATIVE: Readonly<Record<JobStatus, string>> = {
  draft: "Being prepared",
  submitted: "Request received",
  triaged: "Reviewed and scheduled for attention",
  scheduled: "Visit scheduled",
  dispatched: "Technician assigned",
  en_route: "Technician on the way",
  on_site: "Technician arrived",
  paused: "Paused — we will come back to you",
  work_complete: "Work completed",
  signed_off: "Signed off",
  invoiced: "Invoiced",
  closed: "Closed",
  cancelled: "Cancelled",
};
