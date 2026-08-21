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
  | "request_received"
  | "sla_breached"
  | "certification_expiring"
  | "compliance_expiry"
  | "password_reset"
  | "staff_invitation"
  | "cron_unhealthy";

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
  /**
   * JOB-5. The audit's phrase is worth keeping: *the clock exists; the alarm
   * does not.* This is the alarm.
   */
  sla_breached: {
    recipientName: string;
    /** One digest per sweep, not one email per job — see §12.2, "digest, don't drip". */
    breaches: readonly {
      jobReference: string;
      jobTitle: string;
      priority: string;
      kind: "response" | "resolution";
      minutesOverdue: number;
    }[];
  };
  /**
   * The compliance digest (`HR-5`, `HR-9`, `HR-14`).
   *
   * One message, four sections, ordered by consequence: who cannot legally be
   * sent to work, then company accreditations, then employee documents, then
   * trade certifications. Sending four separate emails would put the AED
   * 100,000 item and the driving-licence renewal on equal footing in an inbox.
   */
  compliance_expiry: {
    recipientName: string;
    blocked: readonly { name: string; detail: string; penalty: string | null }[];
    documents: readonly {
      name: string;
      label: string;
      daysRemaining: number;
      band: string;
      blocking: boolean;
    }[];
    accreditations: readonly { name: string; reference: string | null; daysRemaining: number }[];
    certifications: readonly { name: string; certification: string; daysRemaining: number }[];
  };
  certification_expiring: {
    recipientName: string;
    certifications: readonly {
      technicianName: string;
      certification: string;
      daysRemaining: number;
    }[];
  };
  /**
   * SEC-5. Sent for every reset request that produces a token.
   *
   * Note what is NOT here: any indication of whether the address was known.
   * That decision is made before this template is reached — an unknown address
   * results in no message at all, and the *page* says the same thing either
   * way. A "no account found" email would be an enumeration oracle with a
   * delivery receipt.
   */
  password_reset: {
    fullName: string;
    resetUrl: string;
    expiresInMinutes: number;
  };
  /** ADM-1. The invitation that replaces an INSERT. */
  staff_invitation: {
    fullName: string;
    inviterName: string | null;
    roleLabel: string;
    acceptUrl: string;
    expiresInDays: number;
  };
  /**
   * The alert that makes every other scheduled job trustworthy. Without it, a
   * cron that stops firing takes every check that depends on it down silently.
   */
  cron_unhealthy: {
    recipientName: string;
    problems: readonly { job: string; detail: string }[];
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

  // ── Operational alerts ────────────────────────────────────────────────────
  // These go to staff, not customers, so the register changes: no greeting
  // padding, the number first, and the action last. Somebody reads these on a
  // phone while doing something else.

  sla_breached: (p) => ({
    subject:
      p.breaches.length === 1 && p.breaches[0]
        ? `SLA breached — ${p.breaches[0].jobReference}`
        : `${p.breaches.length} jobs past their SLA deadline`,
    body:
      `${p.recipientName},\n\n` +
      `${p.breaches.length === 1 ? "One job is" : `${p.breaches.length} jobs are`} past a deadline.\n\n` +
      p.breaches
        .map(
          (b) =>
            `  ${b.jobReference}  ${b.jobTitle}\n` +
            `    ${b.priority.replace(/_/g, " ")} · ${b.kind === "response" ? "no response yet" : "not resolved"} · ` +
            `${overdue(b.minutesOverdue)} overdue`,
        )
        .join("\n") +
      `\n\nOpen the dispatch board:\n${absoluteUrl("/dispatch")}\n\n` +
      `A response breach means nobody has picked the job up. A resolution breach means someone ` +
      `has it and will not finish in time — those need a different conversation.` +
      sign,
  }),

  compliance_expiry: (p) => ({
    subject:
      p.blocked.length > 0
        ? `URGENT: ${p.blocked.length} technician${p.blocked.length === 1 ? "" : "s"} cannot be dispatched`
        : `Compliance expiries — ${p.documents.length + p.accreditations.length + p.certifications.length} item(s)`,
    body:
      `${p.recipientName},\n` +
      // Consequence order, exactly as the lists on screen are ordered: the item
      // with the highest cost of being ignored comes first.
      (p.blocked.length > 0
        ? `\nCANNOT BE DISPATCHED (${p.blocked.length})\n` +
          p.blocked
            .map((b) => `  ${b.name} — ${b.detail}\n    ${b.penalty ?? ""}`.trimEnd())
            .join("\n") +
          `\n  These technicians are unavailable for work until the document is renewed.\n`
        : "") +
      (p.accreditations.length > 0
        ? `\nCOMPANY ACCREDITATIONS (${p.accreditations.length})\n` +
          p.accreditations
            .map(
              (a) =>
                `  ${a.name}${a.reference ? ` (${a.reference})` : ""} — ${remaining(a.daysRemaining)}`,
            )
            .join("\n") +
          "\n"
        : "") +
      (p.documents.length > 0
        ? `\nEMPLOYEE DOCUMENTS (${p.documents.length})\n` +
          p.documents
            .map(
              (d) =>
                `  ${d.name} — ${d.label} — ${remaining(d.daysRemaining)}` +
                (d.blocking ? "  [blocks dispatch on expiry]" : ""),
            )
            .join("\n") +
          "\n"
        : "") +
      (p.certifications.length > 0
        ? `\nTRADE CERTIFICATIONS (${p.certifications.length})\n` +
          p.certifications
            .map((c) => `  ${c.name} — ${c.certification} — ${remaining(c.daysRemaining)}`)
            .join("\n") +
          "\n"
        : "") +
      `\n${absoluteUrl("/workforce")}` +
      sign,
  }),

  certification_expiring: (p) => ({
    subject: `${p.certifications.length} technician certification${p.certifications.length === 1 ? "" : "s"} expiring`,
    body:
      `${p.recipientName},\n\n` +
      p.certifications
        .map(
          (c) =>
            `  ${c.technicianName} — ${c.certification}\n` +
            `    ${
              c.daysRemaining < 0
                ? `EXPIRED ${Math.abs(c.daysRemaining)} day${Math.abs(c.daysRemaining) === 1 ? "" : "s"} ago`
                : `expires in ${c.daysRemaining} day${c.daysRemaining === 1 ? "" : "s"}`
            }`,
        )
        .join("\n") +
      `\n\nAn expired certification does not stop a dispatch today — it raises a warning the ` +
      `dispatcher must justify in writing. Renew it before that warning becomes a habit.\n\n` +
      `${absoluteUrl("/technicians")}` +
      sign,
  }),

  password_reset: (p) => ({
    subject: `Reset your ${tenant.brandName} password`,
    body:
      `${p.fullName},\n\n` +
      `Somebody asked to reset the password on your account. If that was you, use this link:\n\n` +
      `${p.resetUrl}\n\n` +
      `It works once and expires in ${p.expiresInMinutes} minutes.\n\n` +
      // Told plainly, because a person who did not request this needs to know
      // whether to act. The honest answer is usually "no" — a reset link alone
      // grants nothing — and saying so prevents a panicked call.
      `If it was not you, you do not need to do anything: the link is useless without this ` +
      `mailbox, and your current password still works. Tell us anyway if you get several of ` +
      `these, because that is worth looking at.\n\n` +
      `Signing in with the new password will end any other sessions on your account.` +
      sign,
  }),

  staff_invitation: (p) => ({
    subject: `You have been added to ${tenant.brandName}`,
    body:
      `${p.fullName},\n\n` +
      `${p.inviterName ? `${p.inviterName} has` : "You have been"} set you up with a ` +
      `${tenant.brandName} account as ${p.roleLabel}.\n\n` +
      `Choose a password and sign in here:\n\n${p.acceptUrl}\n\n` +
      `The link expires in ${p.expiresInDays} days. Ask whoever invited you for a new one if it ` +
      `lapses — it is a two-second job at their end.\n\n` +
      `You will be asked to set up two-factor sign-in the first time you sign in. It takes about ` +
      `a minute and you will need it: this account can see customer and employee records.` +
      sign,
  }),

  cron_unhealthy: (p) => ({
    subject: `Scheduled work is not running (${p.problems.length})`,
    body:
      `${p.recipientName},\n\n` +
      `Scheduled jobs have stopped reporting:\n\n` +
      p.problems.map((x) => `  ${x.job} — ${x.detail}`).join("\n") +
      `\n\nThis matters more than it looks. SLA alerts, expiry warnings and the notification ` +
      `queue drain all depend on these running. While one is down, the checks it performs are ` +
      `not happening and nothing else will say so.` +
      sign,
  }),
};

/** "expired 4 days ago" / "expires in 12 days". Negative days read naturally. */
function remaining(days: number): string {
  if (days < 0) {
    const n = Math.abs(days);
    return `EXPIRED ${n} day${n === 1 ? "" : "s"} ago`;
  }
  if (days === 0) return "EXPIRES TODAY";
  return `expires in ${days} day${days === 1 ? "" : "s"}`;
}

/** "1h 17m" — the way a dispatcher says it, not "77 minutes". */
function overdue(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

export function render<K extends TemplateId>(
  template: K,
  payload: TemplatePayloads[K],
): RenderedMessage {
  return TEMPLATES[template](payload);
}
