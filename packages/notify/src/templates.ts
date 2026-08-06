import { tenant, formatMoney, toMinor, absoluteUrl } from "@meridian/core";

/**
 * Notification templates.
 *
 * Typed by payload, so adding a template forces every call site to supply the
 * data it needs and a missing field is a compile error rather than an email
 * that says "Hello undefined".
 *
 * Plain text only, deliberately. HTML email needs a rendering pipeline, inlined
 * CSS and testing across a dozen clients; none of that is the hard part of
 * notifications and none of it should block the pipeline being correct. When
 * HTML is wanted, add a `html` field here - the transport already takes one.
 */

/**
 * A payload date can arrive either way.
 *
 * The caller enqueues a real `Date`, but the payload is stored as JSONB and
 * comes back out of the queue as an ISO string — and the row that is rendered
 * is almost always the one that came back. Rendering used to assume a live
 * `Date` and threw `toLocaleDateString is not a function` on every message
 * carrying a date, which the queue then retried four more times before
 * abandoning. Accepting both is the fix.
 */
export type PayloadDate = Date | string | null;

export type TemplateId =
  | "quote_sent"
  | "job_assigned"
  | "job_completed"
  | "invoice_issued"
  | "request_received";

export interface RenderedMessage {
  readonly subject: string;
  readonly body: string;
}

export interface TemplatePayloads {
  quote_sent: {
    customerName: string;
    quoteReference: string;
    quoteTitle: string;
    /** Decimal string as stored, e.g. "8736.00". */
    total: string;
    currency: string;
    quoteId: string;
    validUntil: PayloadDate;
  };
  job_assigned: {
    technicianName: string;
    jobReference: string;
    jobTitle: string;
    propertyName: string;
    propertyArea: string | null;
    scheduledStart: PayloadDate;
    accessInstructions: string | null;
  };
  job_completed: {
    customerName: string;
    jobReference: string;
    jobTitle: string;
  };
  invoice_issued: {
    customerName: string;
    invoiceReference: string;
    total: string;
    currency: string;
    dueOn: PayloadDate;
  };
  request_received: {
    customerName: string;
    jobReference: string;
    jobTitle: string;
  };
}

function toDate(d: PayloadDate): Date | null {
  if (d === null) return null;
  const value = d instanceof Date ? d : new Date(d);
  return Number.isNaN(value.getTime()) ? null : value;
}

function date(d: PayloadDate): string {
  const value = toDate(d);
  return value
    ? value.toLocaleDateString("en-GB", { timeZone: tenant.timezone, dateStyle: "long" })
    : "to be confirmed";
}

function dateTime(d: PayloadDate): string {
  const value = toDate(d);
  return value
    ? value.toLocaleString("en-GB", { timeZone: tenant.timezone, dateStyle: "medium", timeStyle: "short" })
    : "to be confirmed";
}

const sign = `\n\n--\n${tenant.brandName}\n${tenant.phone} · ${tenant.email}\nEmergencies, 24 hours: ${tenant.emergencyPhone}`;

export const TEMPLATES: {
  [K in TemplateId]: (payload: TemplatePayloads[K]) => RenderedMessage;
} = {
  quote_sent: (p) => ({
    subject: `Quotation ${p.quoteReference} — ${formatMoney(toMinor(p.total), p.currency)}`,
    body:
      `Dear ${p.customerName},\n\n` +
      `Your quotation for "${p.quoteTitle}" is ready.\n\n` +
      `Reference: ${p.quoteReference}\n` +
      `Total: ${formatMoney(toMinor(p.total), p.currency)} including VAT\n` +
      `Valid until: ${date(p.validUntil)}\n\n` +
      `Review the itemised breakdown and approve or decline it here:\n` +
      `${absoluteUrl(`/portal/quotes/${p.quoteId}`)}\n\n` +
      `Anything not covered is listed as an exclusion on the quotation itself. ` +
      `If something looks wrong, reply to this message or call us and we will go through it.` +
      sign,
  }),

  job_assigned: (p) => ({
    subject: `${p.jobReference} — ${p.propertyName}`,
    body:
      `${p.technicianName},\n\n` +
      `You have been assigned ${p.jobReference}.\n\n` +
      `Job: ${p.jobTitle}\n` +
      `Where: ${p.propertyName}${p.propertyArea ? `, ${p.propertyArea}` : ""}\n` +
      `When: ${dateTime(p.scheduledStart)}\n` +
      (p.accessInstructions ? `\nAccess: ${p.accessInstructions}\n` : "") +
      `\nIf you cannot make the slot, tell dispatch now rather than on the day.` +
      sign,
  }),

  job_completed: (p) => ({
    subject: `${p.jobReference} completed`,
    body:
      `Dear ${p.customerName},\n\n` +
      `We have completed "${p.jobTitle}" (${p.jobReference}).\n\n` +
      `The job card, including before and after photographs, is on your account:\n` +
      `${absoluteUrl("/portal")}\n\n` +
      `If anything is not right, tell us within the workmanship warranty period and we will return ` +
      `and put it right at no charge.` +
      sign,
  }),

  invoice_issued: (p) => ({
    subject: `Invoice ${p.invoiceReference} — ${formatMoney(toMinor(p.total), p.currency)}`,
    body:
      `Dear ${p.customerName},\n\n` +
      `Invoice ${p.invoiceReference} for ${formatMoney(toMinor(p.total), p.currency)} is now due ` +
      `on ${date(p.dueOn)}.\n\n` +
      `View it on your account:\n${absoluteUrl("/portal")}\n\n` +
      `This invoice covers work you signed for. If you dispute any line, tell us before the due ` +
      `date and we will hold it while we check.` +
      sign,
  }),

  request_received: (p) => ({
    subject: `We have your request — ${p.jobReference}`,
    body:
      `Dear ${p.customerName},\n\n` +
      `We have logged your request as ${p.jobReference}: "${p.jobTitle}".\n\n` +
      `You can follow its progress here:\n${absoluteUrl("/portal")}\n\n` +
      `If this becomes urgent before we reach you, call ${tenant.emergencyPhone} — that line is ` +
      `answered by a person, 24 hours a day.` +
      sign,
  }),
};

export function render<K extends TemplateId>(
  template: K,
  payload: TemplatePayloads[K],
): RenderedMessage {
  return TEMPLATES[template](payload);
}
