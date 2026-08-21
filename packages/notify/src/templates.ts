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
  | "lead_created"
  | "sla_breached"
  | "certification_expiring"
  | "compliance_expiry"
  | "invoice_issuance_due"
  | "password_reset"
  | "staff_invitation"
  | "cron_unhealthy"
  // M3. Appended rather than slotted in alphabetically — this list is read as
  // a changelog as much as a union.
  | "contract_renewal_due"
  | "weekly_owner_digest"
  // M8. `POR-5` names seven customer-facing events. Four already had a
  // template — `request_received`, `job_completed`, `quote_sent` and
  // `invoice_issued` — and are reused rather than duplicated: a second
  // "your invoice" template would mean two subject lines for one event and a
  // ledger that cannot tell whether the customer was told once or twice.
  // These are the three that had none.
  | "visit_scheduled"
  | "technician_en_route"
  | "payment_received"
  // M10 / HR-17. §12.1 asks for two distinct WPS messages — "countdown from
  // T-5 days" and "transfer unconfirmed on the 2nd, alarm tone" — and they are
  // one template with an escalation stage rather than two, because the second
  // is the same fact one day later. Two templates would mean two suppression
  // windows, and the alarm arriving on the 2nd would be silenced by the
  // countdown that arrived on the 1st.
  | "wps_payroll_countdown"
  // HR-4 / HR-6 / HR-7 / HR-8. The employment lifecycle digest: contracts that
  // have auto-renewed or are about to, probation about to end, insurance gaps,
  // working-time breaches. Separate from `compliance_expiry` for the same
  // reason `invoice_issuance_due` is — that message is about people who cannot
  // legally be sent to work, and folding a leave balance into it would put both
  // behind one suppression window.
  | "employment_lifecycle"
  // M9. Two templates, and the second is the module's whole reason for existing.
  // `ATS-16` targets 100% of applicants receiving an outcome (`G14`); around 65%
  // never or rarely hear back, and roughly 80% of those say they would not
  // reapply. In a referral-driven trades market that is a supply problem, not a
  // courtesy problem.
  | "application_received"
  | "application_outcome"
  // ATS-14. Interview logistics: the confirmation, and the two reminders.
  //
  // The reminders are ONE template with a window field rather than two, for the
  // same reason `wps_payroll_countdown` is: the 2-hour message is the 24-hour
  // message two-and-twenty hours later, and two templates would be two places
  // for the site address to be wrong in.
  | "interview_scheduled"
  | "interview_reminder"
  // ATS-13. Separate from `certification_expiring`, and it has to be. That one
  // is HR-3's message about an employee and its payload field is literally
  // `technicianName`; sending it about a talent-pool member would tell an owner
  // that a technician they do not employ has a lapsing ticket. A message that
  // misdescribes who somebody is, is worse than no message.
  | "talent_pool_certification_expiring";

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
   * LEAD-2 / LEAD-3, closing PD-3.
   *
   * The enquiry landed, the row was written, and nobody was told. An enquiry
   * that arrives at 21:00 and reaches no one is revenue that never existed —
   * and the whole answer-engine investment exists to produce these.
   */
  lead_created: {
    recipientName: string;
    leadReference: string;
    customerName: string;
    phone: string;
    email: string | null;
    serviceName: string;
    area: string | null;
    urgency: string;
    isEmergency: boolean;
    details: string | null;
    respondWithin: string;
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
  /**
   * The 14-day issuance clock (`INV-5`).
   *
   * Separate from `compliance_expiry` on purpose, and not an extra section
   * inside it. That digest goes to HR and the owner about people who cannot be
   * sent to work; this one goes to the accountant and the owner about AED 2,500
   * per un-issued invoice. Different recipient, different money, different
   * action — folding them together would bury one inside the other, and the
   * suppression window would then silence whichever arrived second.
   */
  invoice_issuance_due: {
    recipientName: string;
    /** 14. Passed in rather than hard-coded so the rule lives in `core` only. */
    windowDays: number;
    /** The statutory penalty, stated as a number. See `LATE_ISSUANCE_PENALTY`. */
    penalty: string;
    supplies: readonly {
      jobId: string;
      jobReference: string;
      jobTitle: string;
      customerName: string;
      /** ISO date, in Dubai. The customer's signature is the moment of supply. */
      supplyDate: string;
      daysSinceSupply: number;
      /** ISO date. The last day an invoice may lawfully be issued. */
      deadline: string;
      /** `breached` means the penalty already applies. */
      state: "approaching" | "breached";
    }[];
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
   * `CON-9`. The renewal ladder: T-90 / T-60 / T-30 / T-7.
   *
   * One message per rung per contract, not a digest, and that is the opposite
   * of the rule everywhere else here. The reason: a renewal is a conversation
   * with one named customer about one number, and it is actioned by forwarding
   * the email to that customer's account manager. A digest of six contracts
   * cannot be forwarded to anybody.
   *
   * "A silently expired AMC is the most expensive failure mode in this business
   * model" is the requirement's own sentence, and it is why `daysRemaining`
   * goes negative rather than the message stopping at expiry.
   */
  contract_renewal_due: {
    recipientName: string;
    contractReference: string;
    contractName: string;
    customerName: string;
    /** 90, 60, 30 or 7. Which rung of the ladder this is. */
    band: number;
    /** Negative means the contract has already expired. */
    daysRemaining: number;
    endsOn: PayloadDate;
    /** Decimal string as stored, e.g. "42000.00". */
    annualValue: string;
    currency: string;
    jobsInTerm: number;
    entitledVisits: number;
    consumedVisits: number;
    utilisationPercent: number;
    autoRenew: boolean;
    contractId: string;
  };
  /**
   * The alert that makes every other scheduled job trustworthy. Without it, a
   * cron that stops firing takes every check that depends on it down silently.
   */
  cron_unhealthy: {
    recipientName: string;
    problems: readonly { job: string; detail: string }[];
  };
  /**
   * The weekly owner digest (`KPI-5`).
   *
   * ── WHY THIS IS A THIRD DIGEST AND NOT A SECTION IN AN EXISTING ONE ───────
   *
   * The same argument that kept `invoice_issuance_due` out of
   * `compliance_expiry`, applied once more. Those two go to HR and to the
   * accountant, about this week's actions; this one goes to the owner, about
   * whether the business is healthy, and it is the only message in the system
   * whose job is to arrive when nothing is wrong. Folding it into either of the
   * others would put both behind one `recentlyNotified` window — and since the
   * window is keyed on template and recipient, the second one to fire would be
   * silently dropped for the rest of the period. An owner who is also on the
   * compliance list would then stop receiving whichever of the two ran second,
   * with no error anywhere.
   *
   * ── WHY EVERY FIGURE IS A PRIMITIVE ──────────────────────────────────────
   *
   * The payload is stored as JSONB and comes back out of the queue as plain
   * JSON, so a `Date` arrives as a string and a class instance arrives as an
   * object literal. Money is passed in integer **minor units** and formatted
   * here, rather than passed pre-formatted: a decimal string that has been
   * through JSON is a decimal string somebody will eventually do arithmetic on.
   */
  weekly_owner_digest: {
    recipientName: string;
    /** "Week to 21 August 2026" — computed by the caller, in Dubai time. */
    periodLabel: string;
    currency: string;
    /** Consequence-ordered. Empty is a valid and good week. */
    attention: readonly { severity: "critical" | "warning"; headline: string; detail: string }[];
    cash: {
      outstandingMinor: number;
      overdueMinor: number;
      currentMinor: number;
      days1to30Minor: number;
      days31to60Minor: number;
      days61PlusMinor: number;
      /** Null when there was no revenue in the window to divide by. */
      dsoDays: number | null;
      dsoTargetDays: number;
    };
    revenue: {
      thisMonthMinor: number;
      lastMonthMinor: number;
      yearToDateMinor: number;
      reliefThresholdMinor: number;
      reliefHeadroomMinor: number;
      reliefState: "clear" | "approaching" | "breached";
      invoicesThisMonth: number;
    };
    work: {
      openJobs: number;
      unassigned: number;
      byPriority: readonly { priority: string; jobs: number; breached: number }[];
      jobsBreachedThisWeek: number;
      deadlinesMissedThisWeek: number;
      breachRatePercent: number | null;
    };
    pipeline: {
      openLeads: number;
      openValueMinor: number;
      newThisWeek: number;
      quotesSent: number;
      quotesApproved: number;
      conversionPercent: number | null;
      quotedValueMinor: number;
      windowDays: number;
    };
    contracts: {
      active: number;
      annualValueMinor: number;
      expiring: readonly { name: string; customerName: string; daysRemaining: number; autoRenew: boolean }[];
      horizonDays: number;
    };
    people: {
      headcount: number;
      deployable: number;
      blocked: number;
      blockedNames: readonly string[];
      documentsExpiring: number;
      documentsExpired: number;
      accreditationsExpiring: number;
      nextExpiryLabel: string | null;
      nextExpiryDays: number | null;
    };
    billing: {
      issuanceBreached: number;
      issuanceApproaching: number;
      sequenceGaps: number;
      invoiceLagDays: number | null;
    };
    /** What the dashboard is specified to show and cannot yet source. */
    gaps: readonly { requirement: string; metric: string; waitingOn: string }[];
    /** Event families with no emitter, so a zero is not read as a fact. */
    uninstrumentedEvents: readonly string[];
  };

  // ── POR-5. Customer status notifications ──────────────────────────────────
  visit_scheduled: {
    customerName: string;
    jobReference: string;
    jobTitle: string;
    technicianName: string | null;
    scheduledStart: PayloadDate;
    scheduledEnd: PayloadDate;
  };
  technician_en_route: {
    customerName: string;
    jobReference: string;
    jobTitle: string;
    technicianName: string | null;
  };
  payment_received: {
    customerName: string;
    invoiceReference: string;
    amount: string;
    currency: string;
    method: string | null;
    receivedAt: PayloadDate;
  };
  /**
   * `HR-17`. The highest-frequency compliance obligation in the business.
   *
   * `consequence` and `headline` are computed by `assessWpsCycle` and passed in
   * rather than derived here. That is the whole design: the escalation ladder —
   * day 5 permits suspended, day 11 fines and downgrade, day 16 automatic
   * labour disputes, day 21 executive orders — has exactly one home, in
   * `packages/core/src/employment.ts`, and a template that restated it would be
   * a second home nothing tests.
   */
  wps_payroll_countdown: {
    recipientName: string;
    /** "August 2026". */
    period: string;
    /** ISO date. The 1st of the month following the wage month. */
    dueOn: string;
    /** Positive before the deadline, negative after it. */
    daysUntilDue: number;
    daysLate: number;
    stage: string;
    severity: "info" | "warning" | "critical" | "alarm";
    /** One line. Becomes the subject. */
    headline: string;
    /** The consequence in force today, as a consequence and not as "risk". */
    consequence: string;
    /** 85. Passed in so the threshold lives in `core` only. */
    thresholdPercent: number;
    /** Basis points of wages due that have been transferred. 8500 is 85%. */
    transferredBasisPoints: number;
    totalDue: string;
    totalTransferred: string;
    currency: string;
    employeeCount: number;
    /** True while the wage-file inputs have not been produced (T-3). */
    fileDue: boolean;
    /** People a transfer would silently leave out. */
    gaps: readonly { name: string; reason: string }[];
  };
  employment_lifecycle: {
    recipientName: string;
    /** Terms the law has already renewed, now recorded. */
    renewed: readonly { name: string; previousEnd: string; startsOn: string; endsOn: string }[];
    contracts: readonly {
      name: string;
      state: string;
      detail: string;
      daysToEnd: number | null;
      problems: readonly string[];
    }[];
    insurance: readonly { name: string; problems: readonly string[] }[];
    hours: readonly { name: string; workedOn: string; detail: string }[];
    /** Non-null when the hours picture is being computed from nothing. */
    hoursWarning: string | null;
  };
  /**
   * `ATS-14`. The immediate acknowledgement.
   *
   * Deliberately not the outcome, and it says so. An acknowledgement that reads
   * like a decision is worse than none, because the applicant stops waiting for
   * the real one. Its job is to hand over three things that between them
   * prevent the follow-up phone call: the reference, the tracking link, and the
   * date by which they will hear.
   */
  application_received: {
    candidateFirstName: string;
    roleTitle: string;
    applicationReference: string;
    statusUrl: string;
    /** The promise, as a date. The same value the confirmation screen showed. */
    outcomeDueAt: PayloadDate;
  };
  /**
   * `ATS-16`. The message this module exists to guarantee gets sent.
   *
   * The body is composed in the domain layer, by `outcomeMessage()` in
   * `packages/core/src/recruitment.ts`, from the disposition reason a recruiter
   * chose. That is deliberate: the reason IS the message, so the feedback is
   * specific — "your working-at-height certificate has expired, renew it and
   * please apply again" — rather than the generic brush-off people screenshot.
   * `ATS-16` notes that this converts a rejection into a later re-application
   * often enough to pay for the feature.
   *
   * This template carries it and says who to reply to. It does not write it.
   */
  application_outcome: {
    candidateFirstName: string;
    roleTitle: string;
    applicationReference: string;
    /** Already composed, and reviewable by a human before it is sent. */
    message: string;
    statusUrl: string;
  };
  /**
   * `ATS-14`. The confirmation, with everything needed to arrive prepared.
   *
   * The four logistics fields are the requirement's own list — site address,
   * parking, PPE, what to bring — and they are four fields rather than one
   * details string because a string is what gets half-filled. Every one of them
   * is nullable, and the renderer omits a heading it has nothing to put under
   * rather than printing "Parking: none specified", which is a sentence that
   * tells somebody standing at a barrier nothing at all.
   */
  interview_scheduled: InterviewLogistics;
  /**
   * `ATS-14`. The same logistics, one day out and two hours out.
   *
   * One template with a `window`, not two templates. The two-hour message is
   * the twenty-four-hour message twenty-two hours later, and splitting them
   * would give the site address two places to be wrong in. The suppression that
   * stops a double send is a column per window on the interview row, not a
   * template name, so nothing is lost by sharing this.
   */
  interview_reminder: InterviewLogistics & {
    window: "24h" | "2h";
  };
  /**
   * `ATS-13`. Talent-pool certificates that have lapsed or are about to.
   *
   * Its own template rather than `certification_expiring`, because that one is
   * about an employee and says so in its payload. Everything here says
   * "candidate", including the sentence explaining why the recipient is being
   * told: an expired ticket does not merely make a pool member a weaker
   * prospect, it means that under `HR-9` they are blocked from dispatch the day
   * after they are hired.
   */
  talent_pool_certification_expiring: {
    recipientName: string;
    members: readonly {
      candidateName: string;
      scheme: string;
      /** ISO date, as stored. Day-valued end to end. */
      expiresOn: string;
      lapsed: boolean;
    }[];
  };
}

/**
 * Shared by the confirmation and the two reminders, so the address, the parking
 * note and the PPE list are described once and cannot disagree between the
 * message that books somebody and the message that reminds them.
 */
export interface InterviewLogistics {
  candidateFirstName: string;
  roleTitle: string;
  applicationReference: string;
  /** `interview` | `site_trial`. Decides what the candidate turns up wearing. */
  kind: "interview" | "site_trial";
  scheduledAt: PayloadDate;
  durationMinutes: number;
  locationName: string;
  locationAddress: string;
  locationArea: string | null;
  locationMapUrl: string | null;
  parkingNotes: string | null;
  ppeRequired: readonly string[];
  bringNotes: string | null;
  contactName: string | null;
  contactPhone: string | null;
  /** The page they already have. Also where the reschedule request lives. */
  statusUrl: string;
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

/**
 * The signature every template ends with.
 *
 * Assembled from the parts that are actually set, rather than interpolated
 * directly. Template interpolation stringifies `null` as the four characters
 * `null`, so the previous one-liner signed a customer's email
 * `null · null` on any deployment where `COMPANY_PHONE` or `COMPANY_EMAIL` was
 * not configured — which is the state this repository ships in, and the state
 * it is in right now. It was spotted in a digest rendered by a process that had
 * not loaded `.env`.
 *
 * This is the same rule `packages/core/src/company.ts` states for the document
 * letterhead and the site footer: **omit what is unset, never print a
 * placeholder for it.** A contact line with a gap reads as incomplete; a
 * contact line containing the word "null" reads as broken, and it goes out over
 * the company's name to a customer.
 */
const sign = (() => {
  const contact = [tenant.phone, tenant.email].filter(Boolean).join(" · ");
  const lines = [tenant.brandName, contact].filter(Boolean);
  if (tenant.emergencyPhone) {
    lines.push(`Emergencies, 24 hours: ${tenant.emergencyPhone}`);
  }
  return `\n\n--\n${lines.join("\n")}`;
})();

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
      // The sentence exists only if there is a number to put in it.
      //
      // Interpolated directly, this read "call null — that line is answered by
      // a person, 24 hours a day" on any deployment without
      // `COMPANY_EMERGENCY_PHONE`. Of every string in this file that is the
      // worst one to get wrong: it goes to a customer who has just reported a
      // problem, and it tells them to call nothing at the moment they are most
      // likely to need to. Omitting the offer is honest; making an
      // unfulfillable one is not.
      (tenant.emergencyPhone
        ? `If this becomes urgent before we reach you, call ${tenant.emergencyPhone} — that line is ` +
          `answered by a person, 24 hours a day.`
        : `If this becomes urgent before we reach you, reply to this message and it will be picked up.`) +
      sign,
  }),

  // ── Operational alerts ────────────────────────────────────────────────────
  // These go to staff, not customers, so the register changes: no greeting
  // padding, the number first, and the action last. Somebody reads these on a
  // phone while doing something else.

  lead_created: (p) => ({
    // The subject carries the decision. Somebody glancing at a phone at 21:00
    // should know whether to open it without opening it.
    subject: p.isEmergency
      ? `EMERGENCY enquiry — ${p.serviceName}${p.area ? `, ${p.area}` : ""} — ${p.phone}`
      : `New enquiry — ${p.serviceName}${p.area ? `, ${p.area}` : ""} — ${p.customerName}`,
    body:
      `${p.recipientName},\n\n` +
      (p.isEmergency
        ? `EMERGENCY enquiry. Call them first and log the outcome afterwards.\n\n`
        : "") +
      // The phone number first, on its own line, before anything else. The
      // action this email exists to cause is a phone call, and everything above
      // the number is delay.
      `  ${p.customerName}\n` +
      `  ${p.phone}${p.email ? `  ·  ${p.email}` : ""}\n\n` +
      `  ${p.serviceName}${p.area ? ` — ${p.area}` : ""}\n` +
      `  ${p.respondWithin}\n` +
      `  Reference ${p.leadReference}\n` +
      (p.details ? `\n  "${p.details}"\n` : "") +
      `\nTriage it here:\n${absoluteUrl("/leads")}\n\n` +
      `Response time is measured from now (G2): under 30 minutes in working hours, ` +
      `under 2 hours outside them.` +
      sign,
  }),

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

  invoice_issuance_due: (p) => {
    // Consequence order, same rule as `compliance_expiry`: the supplies where
    // the penalty has already been incurred go first, and the ones still inside
    // the window follow. A list sorted by date alone puts a job that is one day
    // late above one that is three weeks late whenever it was signed off
    // earlier, which is the wrong thing to read first.
    const breached = p.supplies.filter((s) => s.state === "breached");
    const approaching = p.supplies.filter((s) => s.state === "approaching");

    const line = (s: TemplatePayloads["invoice_issuance_due"]["supplies"][number]): string =>
      `  ${s.jobReference}  ${s.jobTitle}\n` +
      `    ${s.customerName} · supplied ${date(s.supplyDate)} · ` +
      `day ${s.daysSinceSupply} of ${p.windowDays}\n` +
      `    ${s.state === "breached" ? "deadline was" : "invoice by"} ${date(s.deadline)}`;

    return {
      subject:
        breached.length > 0
          ? `URGENT: ${breached.length} supply${breached.length === 1 ? "" : "s"} past the ` +
            `${p.windowDays}-day invoice deadline`
          : `${approaching.length} signed-off job${approaching.length === 1 ? "" : "s"} must be ` +
            `invoiced within ${p.windowDays} days`,
      body:
        `${p.recipientName},\n` +
        (breached.length > 0
          ? `\nPAST THE ${p.windowDays}-DAY LIMIT (${breached.length}) — the penalty already applies\n` +
            breached.map(line).join("\n") +
            `\n  Issue these today. A late tax invoice is still the invoice that must be issued, ` +
            `and the penalty does not increase by waiting — but a second missed month does.\n`
          : "") +
        (approaching.length > 0
          ? `\nSTILL INSIDE THE WINDOW (${approaching.length})\n` +
            approaching.map(line).join("\n") +
            "\n"
          : "") +
        `\n${p.penalty}\n` +
        // The date of supply is the customer's signature, not the day accounts
        // got round to the paperwork. Said here because the recipient will
        // otherwise count from the wrong day and think there is more time.
        `The clock runs from the date of supply — the customer's sign-off — not from when the ` +
        `invoice is raised.\n\n` +
        `${absoluteUrl("/invoices")}` +
        sign,
    };
  },

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

  contract_renewal_due: (p) => {
    const expired = p.daysRemaining < 0;
    // Utilisation is the number the renewal conversation is actually about.
    // Under 60% and the customer is paying for visits they do not use — that is
    // a price objection waiting to happen and it is cheaper to hear it now.
    // Over 100% and we are delivering more than was sold.
    const reading =
      p.entitledVisits === 0
        ? "No entitlement is recorded against this contract, so utilisation cannot be read."
        : p.utilisationPercent < 60
          ? `At ${p.utilisationPercent}% utilisation the customer is paying for visits they are ` +
            `not using. Expect a price conversation; have the completion figure ready.`
          : p.utilisationPercent > 100
            ? `At ${p.utilisationPercent}% utilisation we are delivering more than was sold. ` +
              `This contract is under-priced at its current value.`
            : `Utilisation is ${p.utilisationPercent}%, which is where an AMC should sit.`;

    return {
      subject: expired
        ? `EXPIRED: contract ${p.contractReference} — ${p.customerName}`
        : `Renewal due in ${p.daysRemaining} days — ${p.contractReference} ${p.customerName}`,
      body:
        `${p.recipientName},\n\n` +
        (expired
          ? `Contract ${p.contractReference} (${p.contractName}) for ${p.customerName} EXPIRED ` +
            `on ${date(p.endsOn)} and has not been renewed. Planned visits stopped generating ` +
            `on that date.\n\n`
          : `Contract ${p.contractReference} (${p.contractName}) for ${p.customerName} expires ` +
            `on ${date(p.endsOn)} — ${p.daysRemaining} days. This is the ${p.band}-day ` +
            `reminder.\n\n`) +
        `  Value       ${formatMoney(toMinor(p.annualValue), p.currency)} per year\n` +
        `  Jobs        ${p.jobsInTerm} raised against it this term\n` +
        `  Entitlement ${p.consumedVisits} of ${p.entitledVisits} visits used\n` +
        `  Auto-renew  ${p.autoRenew ? "yes" : "no"}\n\n` +
        `${reading}\n\n` +
        `Open the contract and generate a renewal quote:\n` +
        `${absoluteUrl(`/amc/${p.contractId}`)}\n\n` +
        (p.autoRenew && !expired
          ? "This contract auto-renews, so nothing lapses if it is not actioned — but the value " +
            "rolls over unchanged, which on an under-priced contract is the expensive outcome.\n"
          : "") +
        `A renewal is a warning, not a block: nothing in the system stops working because a ` +
        `contract is near its end. What stops is the planned visits, on the day the term does.` +
        sign,
    };
  },

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

  /**
   * `KPI-5`. The one email the owner reads.
   *
   * The audit's `PD-6` finding — the buyer sees no weekly value — is closed by
   * this message, not by the dashboard, because the dashboard requires somebody
   * to log in and the whole point is that the number arrives whether or not
   * anybody does.
   *
   * ── THREE RULES IT IS WRITTEN UNDER ──────────────────────────────────────
   *
   *  1. **Consequence order, not section order.** What needs the owner comes
   *     first, then money, then work, then people. A message that opens with
   *     "Open jobs: 16" buries a blocked technician under a number nobody acts
   *     on.
   *  2. **Every absent metric is named.** The last section lists what this
   *     email is specified to carry and cannot yet source. An omitted line
   *     reads as "nothing to report"; a named gap reads as "not measured",
   *     which is the true statement.
   *  3. **A quiet week says so explicitly.** "NOTHING NEEDS YOU THIS WEEK"
   *     followed by what was checked, rather than an empty first section — an
   *     absent alert and an unrun check look identical in an inbox.
   *
   * Plain text, like every other template here. It renders identically in a
   * mail client, in a terminal and in a screenshot pasted into WhatsApp, which
   * is how this will actually be read.
   */
  weekly_owner_digest: (p) => {
    const m = (minor: number): string => formatMoney(minor, p.currency);

    /** "AED 13,230.00" right-aligned into a column, so figures compare by eye. */
    const row = (label: string, value: string, note = ""): string =>
      `  ${label.padEnd(20)}${value.padStart(16)}${note ? `  ${note}` : ""}`;

    const verdict = (ok: boolean | null, target: string): string =>
      ok === null ? `(target ${target}) not measured` : ok ? `(target ${target}) OK` : `(target ${target}) MISSED`;

    // Ten segments. Deliberately coarse: this bar exists to show which end of
    // the scale the business is at, and a finer one invites reading a precision
    // off it that the underlying figure does not have.
    const bar = (numerator: number, denominator: number): string => {
      const filled = denominator <= 0 ? 0 : Math.max(0, Math.min(10, Math.round((numerator / denominator) * 10)));
      return "▰".repeat(filled) + "▱".repeat(10 - filled);
    };

    const pct = (n: number, d: number): string => (d <= 0 ? "0%" : `${Math.round((n / d) * 100)}%`);

    const critical = p.attention.filter((a) => a.severity === "critical");

    const attentionBlock =
      p.attention.length === 0
        ? `NOTHING NEEDS YOU THIS WEEK\n` +
          `  No technician is blocked from dispatch, no company accreditation has expired, no\n` +
          `  signed-off job is past its 14-day invoice deadline, and the invoice series has no\n` +
          `  gaps. Those are the four that carry a penalty; they were all checked.\n`
        : `NEEDS YOU (${p.attention.length}${critical.length > 0 ? `, ${critical.length} urgent` : ""})\n` +
          p.attention
            .map(
              (a) =>
                `  ${a.severity === "critical" ? "!!" : " !"} ${a.headline}\n` +
                `     ${a.detail}`,
            )
            .join("\n") +
          "\n";

    const monthDelta =
      p.revenue.lastMonthMinor === 0
        ? p.revenue.thisMonthMinor === 0
          ? "no invoices either month"
          : "nothing invoiced last month, so there is no comparison"
        : `${p.revenue.thisMonthMinor >= p.revenue.lastMonthMinor ? "up" : "down"} ${pct(
            Math.abs(p.revenue.thisMonthMinor - p.revenue.lastMonthMinor),
            p.revenue.lastMonthMinor,
          )} on last month`;

    const reliefNote =
      p.revenue.reliefState === "breached"
        ? `  The line has been crossed. The relief is gone for this period and permanently for\n` +
          `  every later one. Confirm with the accountant before acting on it.`
        : p.revenue.reliefState === "approaching"
          ? `  ${m(p.revenue.reliefHeadroomMinor)} of headroom. Crossing ${m(p.revenue.reliefThresholdMinor)}\n` +
            `  once permanently ends the relief for all later periods — there is still time to\n` +
            `  decide that deliberately rather than discover it in the return.`
          : `  ${m(p.revenue.reliefHeadroomMinor)} of headroom.`;

    return {
      // The subject carries the one thing worth knowing without opening it.
      // "Weekly summary" is a subject line that trains its reader to archive.
      subject:
        critical.length > 0
          ? `${p.periodLabel}: ${critical.length} thing${critical.length === 1 ? "" : "s"} need${critical.length === 1 ? "s" : ""} you — ${critical[0]?.headline ?? ""}`
          : p.attention.length > 0
            ? `${p.periodLabel}: ${p.attention.length} to look at, nothing urgent`
            : `${p.periodLabel}: nothing needs you`,
      body:
        `${p.recipientName},\n\n` +
        `${p.periodLabel}. This is the whole picture in one message; ${absoluteUrl("/reports")}\n` +
        `shows the same figures with links into the records behind them.\n\n` +
        `${attentionBlock}\n` +
        `CASH\n` +
        row("Outstanding", m(p.cash.outstandingMinor)) +
        "\n" +
        row("Overdue", m(p.cash.overdueMinor)) +
        "\n" +
        row("  not yet due", m(p.cash.currentMinor)) +
        "\n" +
        row("  1-30 days", m(p.cash.days1to30Minor)) +
        "\n" +
        row("  31-60 days", m(p.cash.days31to60Minor)) +
        "\n" +
        row("  61+ days", m(p.cash.days61PlusMinor)) +
        "\n" +
        row(
          "DSO",
          p.cash.dsoDays === null ? "not measured" : `${p.cash.dsoDays} days`,
          p.cash.dsoDays === null
            ? "no revenue in the window to divide by"
            : verdict(p.cash.dsoDays <= p.cash.dsoTargetDays, `under ${p.cash.dsoTargetDays} days`),
        ) +
        "\n\n" +
        `REVENUE\n` +
        row("This month", m(p.revenue.thisMonthMinor), `${p.revenue.invoicesThisMonth} invoice${p.revenue.invoicesThisMonth === 1 ? "" : "s"}`) +
        "\n" +
        row("Last month", m(p.revenue.lastMonthMinor), monthDelta) +
        "\n" +
        row("Year to date", m(p.revenue.yearToDateMinor)) +
        "\n\n" +
        `  Small Business Relief line - ${m(p.revenue.reliefThresholdMinor)}\n` +
        `  ${bar(p.revenue.yearToDateMinor, p.revenue.reliefThresholdMinor)}  ` +
        `${m(p.revenue.yearToDateMinor)} of ${m(p.revenue.reliefThresholdMinor)}\n` +
        `${reliefNote}\n` +
        `  Revenue here is tax-exclusive and net of credit notes, which is what the relief is\n` +
        `  tested on. It is not the same figure as the VAT return's box 1.\n\n` +
        `WORK\n` +
        row("Open jobs", `${p.work.openJobs}`, `${p.work.unassigned} unassigned`) +
        "\n" +
        p.work.byPriority
          .map((b) =>
            row(
              `  ${b.priority.replace(/^p(\d)_/, "P$1 ")}`,
              `${b.jobs}`,
              b.breached > 0 ? `${b.breached} past a deadline now` : "",
            ),
          )
          .join("\n") +
        (p.work.byPriority.length > 0 ? "\n" : "") +
        row("Missed a deadline", `${p.work.jobsBreachedThisWeek} jobs`,
          // Both numbers, because they differ whenever a job missed its response
          // AND its resolution deadline, and a reader who sees only the larger
          // one concludes more jobs went wrong than did.
          `${p.work.deadlinesMissedThisWeek} deadline${p.work.deadlinesMissedThisWeek === 1 ? "" : "s"} in total`) +
        "\n" +
        row(
          "Breach rate",
          p.work.breachRatePercent === null ? "not measured" : `${p.work.breachRatePercent}%`,
          p.work.breachRatePercent === null
            ? "no deadline fell inside the week"
            : verdict(p.work.breachRatePercent <= 5, "under 5%"),
        ) +
        "\n\n" +
        `PIPELINE\n` +
        row("Open leads", `${p.pipeline.openLeads}`, `${p.pipeline.newThisWeek} new this week`) +
        "\n" +
        row("Open lead value", m(p.pipeline.openValueMinor)) +
        "\n" +
        row("Quotes out", m(p.pipeline.quotedValueMinor), "sent, not yet decided") +
        "\n" +
        row(
          "Conversion",
          p.pipeline.conversionPercent === null ? "not measured" : `${p.pipeline.conversionPercent}%`,
          p.pipeline.conversionPercent === null
            ? `no quotation was sent in ${p.pipeline.windowDays} days`
            : `${p.pipeline.quotesApproved} of ${p.pipeline.quotesSent} sent in ${p.pipeline.windowDays} days · ` +
              verdict(p.pipeline.conversionPercent >= 50, "50% or better"),
        ) +
        "\n\n" +
        `CONTRACTS\n` +
        row("Active", `${p.contracts.active}`, `${m(p.contracts.annualValueMinor)} a year`) +
        "\n" +
        row("Expiring", `${p.contracts.expiring.length}`, `within ${p.contracts.horizonDays} days`) +
        "\n" +
        (p.contracts.expiring.length > 0
          ? p.contracts.expiring
              .map(
                (c) =>
                  `    ${c.name} - ${c.customerName}\n` +
                  `      ${c.daysRemaining < 0 ? `expired ${Math.abs(c.daysRemaining)} days ago` : `${c.daysRemaining} days left`}` +
                  `${c.autoRenew ? ", renews itself unless cancelled" : ", does NOT auto-renew"}`,
              )
              .join("\n") + "\n"
          : "") +
        "\n" +
        `PEOPLE\n` +
        row("Headcount", `${p.people.headcount}`, `${p.people.deployable} deployable`) +
        "\n" +
        row(
          "Blocked",
          `${p.people.blocked}`,
          p.people.blocked > 0 ? p.people.blockedNames.join(", ") : "nobody",
        ) +
        "\n" +
        row("Documents expiring", `${p.people.documentsExpiring}`, `${p.people.documentsExpired} already expired`) +
        "\n" +
        row("Accreditations", `${p.people.accreditationsExpiring}`, "expiring inside the window") +
        "\n" +
        (p.people.nextExpiryLabel
          ? `  Next: ${p.people.nextExpiryLabel} - ${remaining(p.people.nextExpiryDays ?? 0)}\n`
          : "") +
        "\n" +
        `BILLING RISK\n` +
        row("Past 14-day limit", `${p.billing.issuanceBreached}`, "AED 2,500 each, already incurred") +
        "\n" +
        row("Approaching it", `${p.billing.issuanceApproaching}`, "still inside the window") +
        "\n" +
        row("Invoice series gaps", `${p.billing.sequenceGaps}`, p.billing.sequenceGaps > 0 ? "an FTA audit flag" : "") +
        "\n" +
        row(
          "Invoice lag",
          p.billing.invoiceLagDays === null ? "not measured" : `${p.billing.invoiceLagDays} days`,
          p.billing.invoiceLagDays === null ? "no invoice this year carries a date of supply" : "median, supply to issue",
        ) +
        "\n\n" +
        // The section that stops this email from being trusted more than it has
        // earned. It is last because it is the least urgent, and it is present
        // because a figure that is silently absent gets assumed to be fine.
        `NOT MEASURED (${p.gaps.length})\n` +
        `  This email is specified to carry these and cannot yet source them. They are gaps in\n` +
        `  the software, not zeros in the business.\n` +
        p.gaps.map((g) => `    ${g.metric} (${g.requirement})\n      ${g.waitingOn}`).join("\n") +
        (p.uninstrumentedEvents.length > 0
          ? `\n    No event stream yet for: ${p.uninstrumentedEvents.join(", ")}`
          : "") +
        `\n\n${absoluteUrl("/reports")}` +
        sign,
    };
  },

  // ── POR-5. Customer status notifications ──────────────────────────────────
  //
  // Written to be read on a phone, in one glance, by a building manager who is
  // doing something else. The reference first because it is what they will
  // quote back at us, the fact second, and at most one link. None of them ask
  // for a reply: every one of these events is followed by something the portal
  // can show, and a message that needs answering to be useful is a message that
  // creates work for the person who sent it.
  //
  // Every one of them says how to stop it. An opt-out that has to be hunted for
  // is an opt-out nobody finds, and the customer who cannot find it unsubscribes
  // by marking the address as spam — which costs the deliverability of the
  // quote notifications too.

  visit_scheduled: (p) => ({
    subject: `${p.jobReference} — visit booked`,
    body:
      `Dear ${p.customerName},\n\n` +
      `We have booked a visit for "${p.jobTitle}" (${p.jobReference}).\n\n` +
      `When: ${dateTime(p.scheduledStart)}` +
      (toDate(p.scheduledEnd)
        ? ` until ${toDate(p.scheduledEnd)?.toLocaleTimeString("en-GB", {
            timeZone: tenant.timezone,
            hour: "2-digit",
            minute: "2-digit",
          })}`
        : "") +
      `\n` +
      (p.technicianName ? `Who: ${p.technicianName}\n` : "") +
      `\nIf that window does not work, tell us now rather than on the day — moving it is free ` +
      `until somebody is on the road.\n\n` +
      `${absoluteUrl("/portal/requests")}\n\n` +
      `To stop these: ${absoluteUrl("/portal/notifications")}` +
      sign,
  }),

  technician_en_route: (p) => ({
    subject: `${p.jobReference} — on the way`,
    body:
      `Dear ${p.customerName},\n\n` +
      (p.technicianName ? `${p.technicianName} is` : "Our technician is") +
      ` on the way to you now for "${p.jobTitle}" (${p.jobReference}).\n\n` +
      `Please make sure access is available — a locked plant room or an unbooked lift is the ` +
      `most common reason a visit produces no work.\n\n` +
      `To stop these: ${absoluteUrl("/portal/notifications")}` +
      sign,
  }),

  payment_received: (p) => ({
    subject: `Payment received — ${p.invoiceReference}`,
    body:
      `Dear ${p.customerName},\n\n` +
      `We have received ${formatMoney(toMinor(p.amount), p.currency)} against invoice ` +
      `${p.invoiceReference}` +
      (p.method ? ` by ${p.method.replace(/_/g, " ")}` : "") +
      ` on ${date(p.receivedAt)}.\n\n` +
      `Your statement of account, including anything still outstanding, is here:\n` +
      `${absoluteUrl("/portal/invoices")}\n\n` +
      `To stop these: ${absoluteUrl("/portal/notifications")}` +
      sign,
  }),

  /**
   * `HR-17`. Escalating, and the escalation is the message.
   *
   * A single "payroll is late" email throws away the only information the
   * recipient acts on. The subject carries the stage because it is read on a
   * phone lock screen, and the body leads with the consequence in force today —
   * "no new work permit can be issued" is a decision; "compliance risk" is not.
   */
  wps_payroll_countdown: (p) => ({
    subject:
      p.daysLate > 0
        ? `${p.severity === "alarm" ? "ALARM" : "URGENT"}: ${p.period} wages ${p.daysLate} day${p.daysLate === 1 ? "" : "s"} late — day ${p.daysLate + 1} of the WPS escalation`
        : p.daysUntilDue === 0
          ? `TODAY: ${p.period} wages are due today`
          : `WPS countdown — ${p.period} wages due in ${p.daysUntilDue} day${p.daysUntilDue === 1 ? "" : "s"}`,
    body:
      `${p.recipientName},\n\n` +
      `${p.headline}\n\n` +
      `${p.consequence}\n\n` +
      `Wage month: ${p.period}\n` +
      `Due: ${date(p.dueOn)}\n` +
      `Total wages due: ${formatMoney(toMinor(p.totalDue), p.currency)} across ${p.employeeCount} employee${p.employeeCount === 1 ? "" : "s"}\n` +
      `Transferred: ${formatMoney(toMinor(p.totalTransferred), p.currency)} — ` +
      `${(p.transferredBasisPoints / 100).toFixed(2)}% of wages due, against a ${p.thresholdPercent}% statutory floor\n` +
      (p.fileDue
        ? `\nThe wage file inputs have not been produced. Hours, overtime, absences and deductions are due ` +
          `three days before the deadline so the transfer can be instructed in time.\n`
        : "") +
      (p.gaps.length > 0
        ? `\nA TRANSFER TODAY WOULD NOT REACH ${p.gaps.length} PERSON${p.gaps.length === 1 ? "" : "S"}\n` +
          p.gaps.map((g) => `  ${g.name} — ${g.reason}`).join("\n") +
          `\n  The reason is given per person because the two failures differ: one leaves the wage in the total ` +
          `and unpayable, the other leaves the person out of the total entirely.\n`
        : "") +
      `\n${absoluteUrl("/hr/payroll")}` +
      sign,
  }),

  employment_lifecycle: (p) => ({
    subject:
      p.renewed.length > 0
        ? `${p.renewed.length} employment contract${p.renewed.length === 1 ? "" : "s"} auto-renewed`
        : `Employment lifecycle — ${p.contracts.length + p.insurance.length + p.hours.length} item(s)`,
    body:
      `${p.recipientName},\n` +
      (p.renewed.length > 0
        ? `\nCONTRACTS THAT RENEWED THEMSELVES (${p.renewed.length})\n` +
          p.renewed
            .map(
              (r) =>
                `  ${r.name} — the term ending ${date(r.previousEnd)} was not renewed and work continued, ` +
                `so it renews on the same terms to ${date(r.endsOn)}`,
            )
            .join("\n") +
          `\n  Recorded automatically. This is what the law does whether or not anybody files it; ` +
          `issue a fresh contract if the terms were meant to change.\n`
        : "") +
      (p.contracts.length > 0
        ? `\nCONTRACTS NEEDING ATTENTION (${p.contracts.length})\n` +
          p.contracts
            .map(
              (c) =>
                `  ${c.name} [${c.state.replace(/_/g, " ")}] — ${c.detail}` +
                (c.problems.length > 0 ? `\n    ${c.problems.join("\n    ")}` : ""),
            )
            .join("\n") +
          "\n"
        : "") +
      (p.insurance.length > 0
        ? `\nHEALTH INSURANCE (${p.insurance.length})\n` +
          p.insurance.map((i) => `  ${i.name} — ${i.problems.join(" ")}`).join("\n") +
          `\n  Cover is mandatory in Dubai, employer-funded, and may not be deducted from salary. ` +
          `Penalties run monthly from AED 500 to AED 150,000 and a lapse blocks visa processing.\n`
        : "") +
      (p.hours.length > 0
        ? `\nWORKING-TIME BREACHES (${p.hours.length})\n` +
          p.hours.map((h) => `  ${h.name} — ${date(h.workedOn)} — ${h.detail}`).join("\n") +
          "\n"
        : "") +
      (p.hoursWarning ? `\nNOTE ON THE HOURS ABOVE\n  ${p.hoursWarning}\n` : "") +
      `\n${absoluteUrl("/hr")}` +
      sign,
  }),

  application_received: (p) => ({
    subject: `Application received — ${p.roleTitle} (${p.applicationReference})`,
    body:
      `Hi ${p.candidateFirstName},\n\n` +
      `We have your application for ${p.roleTitle}. This is not a decision — it is us ` +
      `confirming it arrived, and telling you when you will hear.\n\n` +
      `  Reference   ${p.applicationReference}\n` +
      `  You will hear from us by ${date(p.outcomeDueAt)}, whatever the outcome.\n\n` +
      `Check where it has got to at any time. No account, no password:\n${p.statusUrl}\n\n` +
      `If we need anything from you, that page says so.` +
      sign,
  }),

  application_outcome: (p) => ({
    subject: `Your application for ${p.roleTitle} (${p.applicationReference})`,
    body:
      // The decision first and alone. Everything placed above it is padding
      // somebody has to read twice to find the answer in.
      `${p.message}\n\n` +
      `  Reference   ${p.applicationReference}\n\n` +
      `Your application page stays available:\n${p.statusUrl}\n\n` +
      // HR-16, said to the person it protects. A prohibition the worker has
      // never been told about is one they cannot report a breach of.
      `Recruitment, visa and permit costs are ours and are never charged to a worker. ` +
      `If anyone asks you to pay a fee in connection with a job here, tell us.` +
      sign,
  }),

  interview_scheduled: (p) => ({
    subject: `${p.kind === "site_trial" ? "Site trial" : "Interview"} confirmed — ${dateTime(p.scheduledAt)}`,
    body:
      `Hi ${p.candidateFirstName},\n\n` +
      `You are booked in for a ${p.kind === "site_trial" ? "site trial" : "an interview"} for ` +
      `${p.roleTitle}.\n\n` +
      interviewFacts(p) +
      `\nIf that time does not work, say so on your application page and we will move it — ` +
      `there is a button on it. Do not just not come; we would rather rebook you.\n` +
      `${p.statusUrl}` +
      sign,
  }),

  interview_reminder: (p) => ({
    // The window is in the subject line because the subject line is all that is
    // read on a phone at 06:40, and "tomorrow" and "in two hours" are different
    // instructions.
    subject:
      p.window === "2h"
        ? `Today: ${p.kind === "site_trial" ? "site trial" : "interview"} at ${dateTime(p.scheduledAt)}`
        : `Tomorrow: ${p.kind === "site_trial" ? "site trial" : "interview"} at ${dateTime(p.scheduledAt)}`,
    body:
      `Hi ${p.candidateFirstName},\n\n` +
      (p.window === "2h"
        ? `This is the short reminder — you are due at ${dateTime(p.scheduledAt)}, about two hours from now.\n\n`
        : `A reminder that you are due tomorrow, ${dateTime(p.scheduledAt)}.\n\n`) +
      interviewFacts(p) +
      `\nIf something has come up, tell us on your application page rather than not arriving. ` +
      `We would rather move it.\n${p.statusUrl}` +
      sign,
  }),

  talent_pool_certification_expiring: (p) => ({
    subject: `${p.members.length} talent-pool certificate${p.members.length === 1 ? "" : "s"} lapsing`,
    body:
      `${p.recipientName},\n\n` +
      // Who these people are, first and unambiguously. This message is next to
      // one about employees in the same inbox, and the whole reason it is a
      // separate template is that confusing the two is the failure.
      `These are people in the talent pool — candidates, not employees. Nobody here is on a ` +
      `job today.\n\n` +
      p.members
        .map(
          (m) =>
            `  ${m.candidateName} — ${m.scheme}\n` +
            `    ${m.lapsed ? "EXPIRED" : "expires"} ${m.expiresOn}`,
        )
        .join("\n") +
      `\n\nWorth a phone call rather than a filter. A lapsed ticket is usually a renewal ` +
      `somebody has not got round to, and under HR-9 it blocks the dispatch the day after they ` +
      `are hired — so the call is cheaper now than it is then.\n\n` +
      `${absoluteUrl("/recruitment/pool")}` +
      sign,
  }),
};

/**
 * The logistics block, rendered once for the confirmation and both reminders.
 *
 * Headings with nothing under them are omitted rather than filled with "none
 * specified". A parking heading that says nothing is worse than no parking
 * heading: it tells somebody sitting at a barrier that the question was asked
 * and abandoned.
 */
function interviewFacts(p: InterviewLogistics): string {
  const lines = [
    `  When        ${dateTime(p.scheduledAt)} (allow about ${p.durationMinutes} minutes)`,
    `  Where       ${p.locationName}`,
    `              ${p.locationAddress}${p.locationArea ? `, ${p.locationArea}` : ""}`,
  ];

  if (p.locationMapUrl) lines.push(`              ${p.locationMapUrl}`);
  if (p.contactName || p.contactPhone) {
    lines.push(
      `  Ask for     ${[p.contactName, p.contactPhone].filter(Boolean).join(" — ")}`,
    );
  }
  if (p.parkingNotes) lines.push(`  Parking     ${p.parkingNotes}`);
  if (p.ppeRequired.length > 0) lines.push(`  Wear        ${p.ppeRequired.join(", ")}`);
  if (p.bringNotes) lines.push(`  Bring       ${p.bringNotes}`);

  lines.push(`  Reference   ${p.applicationReference}`);

  return lines.join("\n") + "\n";
}

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
