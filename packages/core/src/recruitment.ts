/**
 * Recruitment vocabulary, validation and structured data (M9, `ATS-1`…`ATS-19`).
 *
 * Everything here is shared between three places that must not be allowed to
 * disagree: the public application form, the server action behind it, and the
 * `SECURITY DEFINER` function that actually writes the row. A grade the form
 * offers but the database refuses is a lost applicant with no error anybody
 * ever sees.
 *
 * ── THE TWO RULES THAT SHAPED THIS FILE ─────────────────────────────────────
 *
 * **`ATS-6` — what is never asked.** Date of birth, nationality, ethnicity,
 * religion, marital status, children, gender, photograph, health or disability
 * status, and visa status. None of them appears in a field list, an enum or a
 * schema below, and `PROHIBITED_APPLICANT_FIELDS` names them so the absence is
 * assertable in a test rather than merely true today. Physical requirements are
 * stated in the advert and confirmed with one yes/no about essential functions,
 * which is a job question and not a health question.
 *
 * **`HR-16` — recruitment costs are never recovered from a worker.** Article 6
 * of Federal Decree-Law 33/2021 prohibits charging or collecting recruitment
 * and employment fees from a worker, directly or indirectly. That is expressed
 * here as `RECRUITMENT_COST_BEARER`, a one-element list: the only bearer this
 * system can represent is the employer, so a candidate-payable fee is not a
 * value that fails validation — it is a value that has nowhere to be written.
 * See the `recruitment_costs` CHECK constraint in migration 0014 for the same
 * rule at the database level.
 */

import { z } from "zod";
import { services } from "./catalog";
import { company } from "./company";
import { absoluteUrl, tenant } from "./tenant";

// ── The controlled vocabularies ─────────────────────────────────────────────

/**
 * Grades, lowest to highest (`ATS-3`).
 *
 * Ordered, and the order is load-bearing: a requisition states a minimum grade
 * and the pipeline sorts on it. Storing the label alone would make "is this
 * candidate at or above the grade we advertised" a string comparison.
 */
export const CANDIDATE_GRADES = [
  "helper",
  "technician",
  "senior_technician",
  "charge_hand",
  "supervisor",
] as const;

export type CandidateGrade = (typeof CANDIDATE_GRADES)[number];

export const CANDIDATE_GRADE_LABEL: Readonly<Record<CandidateGrade, string>> = {
  helper: "Helper",
  technician: "Technician",
  senior_technician: "Senior technician",
  charge_hand: "Charge hand",
  supervisor: "Supervisor",
};

/**
 * Experience in bands, not years (`ATS-3`).
 *
 * A number field costs a keyboard switch and a decision ("do I count the two
 * years in Sharjah?"); a band costs one tap and answers the only question the
 * shortlist actually asks. It is also the honest precision: nobody screens on
 * the difference between six and seven years.
 */
export const EXPERIENCE_BANDS = ["under_2", "2_to_5", "5_to_10", "over_10"] as const;

export type ExperienceBand = (typeof EXPERIENCE_BANDS)[number];

export const EXPERIENCE_BAND_LABEL: Readonly<Record<ExperienceBand, string>> = {
  under_2: "Under 2 years",
  "2_to_5": "2–5 years",
  "5_to_10": "5–10 years",
  over_10: "Over 10 years",
};

/** Sort key, so "5–10 years" ranks above "2–5" without parsing the label. */
export const EXPERIENCE_BAND_RANK: Readonly<Record<ExperienceBand, number>> = {
  under_2: 0,
  "2_to_5": 1,
  "5_to_10": 2,
  over_10: 3,
};

/**
 * Where the applicant is now (`ATS-3`).
 *
 * Two values, and deliberately only two. This is not visa status — `ATS-5` is
 * explicit that visa status is asked at the Trade Check stage, applied
 * uniformly to everyone shortlisted, and never on the public form. What this
 * answers is whether a trade test can be booked next week or needs an entry
 * permit first, which is a logistics question with no protected characteristic
 * anywhere near it.
 */
export const CANDIDATE_LOCATIONS = ["in_uae", "outside_uae"] as const;

export type CandidateLocation = (typeof CANDIDATE_LOCATIONS)[number];

export const CANDIDATE_LOCATION_LABEL: Readonly<Record<CandidateLocation, string>> = {
  in_uae: "In the UAE",
  outside_uae: "Outside the UAE",
};

export const AVAILABILITY_OPTIONS = [
  "immediate",
  "two_weeks",
  "one_month",
  "two_months_plus",
] as const;

export type Availability = (typeof AVAILABILITY_OPTIONS)[number];

export const AVAILABILITY_LABEL: Readonly<Record<Availability, string>> = {
  immediate: "Immediately",
  two_weeks: "Within 2 weeks",
  one_month: "1 month notice",
  two_months_plus: "2 months or more",
};

/**
 * Visa and permit status (`ATS-5`).
 *
 * Collected at Trade Check, from every shortlisted candidate, used for permit
 * and timeline planning only. It is in this file because the *values* are
 * shared with the staff form; it is deliberately absent from
 * `applicationSubmissionSchema` below, which is the schema the public form
 * parses against — so the field cannot appear on that form by accident.
 */
export const VISA_STATUSES = [
  "own_or_spouse_sponsored",
  "employment_transferable",
  "employment_requires_cancellation",
  "outside_uae_entry_permit",
  "visit_visa",
] as const;

export type VisaStatus = (typeof VISA_STATUSES)[number];

export const VISA_STATUS_LABEL: Readonly<Record<VisaStatus, string>> = {
  own_or_spouse_sponsored: "Own visa / spouse-sponsored",
  employment_transferable: "Employment visa — transferable",
  employment_requires_cancellation: "Employment visa — requires cancellation",
  outside_uae_entry_permit: "Outside UAE — requires entry permit",
  visit_visa: "Visit visa, in the UAE",
};

/** Rough planning horizon per status. Never a ranking, never a filter. */
export const VISA_STATUS_PLANNING_NOTE: Readonly<Record<VisaStatus, string>> = {
  own_or_spouse_sponsored: "No sponsorship transfer needed — can usually start soonest.",
  employment_transferable: "Transfer typically ~3 weeks once the offer is signed.",
  employment_requires_cancellation:
    "Current sponsor must cancel first. Allow for the cancellation plus the transfer.",
  outside_uae_entry_permit: "Entry permit, travel and the medical add roughly 6–8 weeks.",
  visit_visa: "Status change inside the country; check the remaining validity before offering.",
};

// ── The pipeline (`ATS-7`) ──────────────────────────────────────────────────

/**
 * Stage *types* — the semantics, as distinct from the label a tenant gives a
 * stage.
 *
 * `site_trial` is a first-class type rather than "assessment, but for trades".
 * It is the trades equivalent of a technical assessment, it is absent from
 * every generic ATS's defaults, and a pipeline that models it as a generic
 * interview cannot answer the one question the stage exists to ask: how many
 * people who looked right on paper could actually do the work.
 */
export const STAGE_TYPES = [
  "applied",
  "screening",
  "trade_check",
  "site_trial",
  "interview",
  "offer",
  "onboarding",
  "hired",
] as const;

export type StageType = (typeof STAGE_TYPES)[number];

export const STAGE_TYPE_LABEL: Readonly<Record<StageType, string>> = {
  applied: "Applied",
  screening: "Screening",
  trade_check: "Trade check",
  site_trial: "Site trial",
  interview: "Interview",
  offer: "Offer",
  onboarding: "Onboarding docs",
  hired: "Hired",
};

/** `ATS-7`. Twelve, and the database CHECK enforces it rather than the UI. */
export const MAX_PIPELINE_STAGES = 12;

/**
 * The pipeline every new requisition starts with (`ATS-7`).
 *
 * Seeded per requisition rather than shared, because a supervisor vacancy and a
 * helper vacancy genuinely do not run the same process — and a pipeline that is
 * global is a pipeline nobody may edit.
 */
export const DEFAULT_PIPELINE: readonly { name: string; stageType: StageType }[] = [
  { name: "Applied", stageType: "applied" },
  { name: "Screening", stageType: "screening" },
  { name: "Trade check", stageType: "trade_check" },
  { name: "Interview / site trial", stageType: "site_trial" },
  { name: "Offer", stageType: "offer" },
  { name: "Onboarding docs", stageType: "onboarding" },
  { name: "Hired", stageType: "hired" },
];

/**
 * Stages at which an automated rejection is permitted (`ATS-15`, `ATS-19`).
 *
 * Only the two before any human has spoken to the candidate. After that a human
 * sends it, because a person who took a morning off to attend a trade test and
 * receives a templated brush-off learns something true about the company.
 */
export const AUTO_OUTCOME_STAGE_TYPES: readonly StageType[] = ["applied", "screening"];

// ── Blocked-on (`ATS-8`) ────────────────────────────────────────────────────

export type BlockedOn = "none" | "candidate" | "us";

/** Deliberately never colour alone: every surface renders this label too. */
export const BLOCKED_ON_LABEL: Readonly<Record<BlockedOn, string>> = {
  none: "Up to date",
  candidate: "Waiting on the candidate",
  us: "Waiting on us",
};

export type BlockedTone = "green" | "amber" | "red";

export const BLOCKED_TONE: Readonly<Record<BlockedOn, BlockedTone>> = {
  none: "green",
  candidate: "amber",
  us: "red",
};

/** The time-in-stage fallback thresholds, in days (`ATS-8`). */
export const BLOCKED_FALLBACK_AMBER_DAYS = 2;
export const BLOCKED_FALLBACK_RED_DAYS = 5;

/**
 * What colour a card is, and why.
 *
 * `ATS-8` calls this the cheapest high-value feature in the module and it is
 * right: in a market where a good AC technician is holding three offers, "who
 * is blocking this" is the only question worth putting on a card.
 *
 * Structured signal first — somebody actually recorded that we are waiting on a
 * certificate. Time-in-stage second, because most of the time nobody recorded
 * anything, and a board that shows green for every card nobody has touched is
 * worse than no board.
 */
export function blockedState(input: {
  blockedOn: BlockedOn;
  stageEnteredAt: Date;
  now?: Date;
}): { readonly tone: BlockedTone; readonly label: string; readonly days: number } {
  const now = input.now ?? new Date();
  const days = Math.max(
    0,
    Math.floor((now.getTime() - input.stageEnteredAt.getTime()) / 86_400_000),
  );

  if (input.blockedOn !== "none") {
    return { tone: BLOCKED_TONE[input.blockedOn], label: BLOCKED_ON_LABEL[input.blockedOn], days };
  }

  // The fallback. Note it reports "waiting on us" wording at red, because when
  // nothing has been recorded for five days the thing that has not happened is
  // ours to do.
  if (days >= BLOCKED_FALLBACK_RED_DAYS) {
    return { tone: "red", label: `No activity for ${days} days`, days };
  }
  if (days >= BLOCKED_FALLBACK_AMBER_DAYS) {
    return { tone: "amber", label: `${days} days in stage`, days };
  }
  return { tone: "green", label: days === 0 ? "Today" : `${days} day${days === 1 ? "" : "s"} in stage`, days };
}

// ── Outcomes (`ATS-16`, `ATS-15`) ───────────────────────────────────────────

/**
 * Why an application ended, as a closed list (`ATS-16`, wireframe §5.3).
 *
 * `feedback` is the point of the list. A disposition reason that only feeds a
 * chart is a reason somebody will eventually type freehand; a disposition
 * reason that *writes the message the applicant receives* is one nobody can
 * skip, because skipping it leaves the message empty.
 *
 * "Certifications not current" producing "renew it and please apply again" is
 * the case `ATS-16` names specifically: it converts a rejection into a later
 * re-application often enough to pay for the whole feature.
 */
export const DISPOSITION_REASONS = [
  {
    code: "certification_not_current",
    label: "Certification not current",
    feedback:
      "your trade certificate has expired. Renew it and please do apply again — we hire regularly.",
    autoSendable: true,
    talentPoolCandidate: true,
  },
  {
    code: "insufficient_experience",
    label: "Insufficient experience",
    feedback:
      "we are looking for more hands-on experience in this trade for this particular role. Please apply again as you build it up.",
    autoSendable: true,
    talentPoolCandidate: true,
  },
  {
    code: "salary_expectation",
    label: "Salary expectation above band",
    feedback: "we could not match your salary expectation for this role.",
    autoSendable: false,
    talentPoolCandidate: true,
  },
  {
    code: "visa_timeline",
    label: "Visa situation not workable in time",
    feedback:
      "we need someone who can start sooner than the permit timeline for this role allows. This is about timing, not about you.",
    autoSendable: false,
    talentPoolCandidate: true,
  },
  {
    code: "role_filled",
    label: "Role filled",
    feedback:
      "this role has now been filled. We would genuinely welcome an application for the next one.",
    autoSendable: false,
    talentPoolCandidate: true,
  },
  {
    code: "failed_trade_check",
    label: "Failed trade check",
    feedback: "the trade test did not go the way we needed for this role.",
    autoSendable: false,
    talentPoolCandidate: false,
  },
  {
    code: "candidate_withdrew",
    label: "Candidate withdrew",
    feedback: "you let us know you are no longer available. Thank you for telling us.",
    autoSendable: false,
    talentPoolCandidate: true,
  },
  {
    code: "no_response",
    label: "No response from candidate",
    feedback:
      "we tried to reach you several times and did not hear back, so we have closed this application. Get in touch any time if that was a mistake.",
    autoSendable: false,
    talentPoolCandidate: false,
  },
  {
    code: "other",
    label: "Other (specify)",
    feedback: "we are not moving forward with your application this time.",
    autoSendable: false,
    talentPoolCandidate: false,
  },
] as const;

export type DispositionCode = (typeof DISPOSITION_REASONS)[number]["code"];

export const DISPOSITION_BY_CODE: Readonly<
  Record<string, (typeof DISPOSITION_REASONS)[number]>
> = Object.fromEntries(DISPOSITION_REASONS.map((r) => [r.code, r]));

/**
 * The cancellable window on an automated message (`ATS-15`).
 *
 * Twenty-four hours, minimum, for a rejection. The requirement's own words are
 * that the delay exists *so it can be cancelled if the decision changes*, which
 * happens more often than anyone plans for: the first-choice candidate takes
 * another offer on Tuesday and the person rejected on Monday is suddenly the
 * hire. A message already delivered cannot be taken back.
 *
 * It also makes "never auto-reject within seconds of applying" structural
 * rather than a rule somebody has to remember.
 */
export const OUTCOME_MINIMUM_DELAY_HOURS = 24;

/**
 * What the applicant is promised on the confirmation screen (`ATS-16`).
 *
 * Three working days. This is not a display string: it is the clock that
 * `applications.outcome_due_at` is set from, so the promise on the screen and
 * the number the accountability report measures are the same number. A promise
 * with no counter behind it is the thing this module exists to stop.
 */
export const OUTCOME_PROMISE_WORKING_DAYS = 3;

// ── `ATS-12`: the cool-off flag ─────────────────────────────────────────────

/**
 * The platform default cool-off window, in days.
 *
 * `ATS-12` asks for a *configurable* flag on re-application within N days of a
 * rejection for the same role. The configuration lives on the requisition
 * (`job_requisitions.cooloff_days`); this is what a requisition that has not
 * set one falls back to.
 *
 * Ninety days, because that is roughly the interval over which the two things
 * that get somebody rejected in this trade actually change: a lapsed
 * certificate gets renewed, and "not enough hands-on experience" stops being
 * true. Shorter and the badge fires on people whose situation is genuinely
 * different; much longer and it fires on people nobody remembers.
 *
 * ── THIS NUMBER EXISTS TWICE AND MUST NOT DISAGREE ──────────────────────────
 *
 * The other copy is the `coalesce` in `app_recruitment_cooloff_days`
 * (`packages/db/sql/public-functions.sql`), which has to be there because the
 * unauthenticated application path never enters TypeScript. Two implementations
 * of one rule is one implementation and one bug waiting, so
 * `packages/db/test/recruitment.test.ts` asserts the two agree rather than
 * trusting that whoever changes one remembers the other.
 */
export const RECRUITMENT_COOLOFF_DEFAULT_DAYS = 90;

/**
 * The sentence the badge carries, wherever it is drawn.
 *
 * Written once so the pipeline card and the candidate page cannot describe the
 * same fact two different ways, and written as a note rather than a verdict:
 * `ATS-19` forbids automated rejection and `ATS-5` forbids automated filtering,
 * so a recruiter reading this is free to conclude nothing at all from it. The
 * copy has to say that, because a badge that reads like an instruction becomes
 * one.
 */
export function cooloffBadgeLabel(input: {
  priorArchivedAt: Date;
  windowDays: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const days = Math.max(
    0,
    Math.floor((now.getTime() - input.priorArchivedAt.getTime()) / 86_400_000),
  );
  const ago = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `Applied for this role before and was not taken forward ${ago} — inside this role's ${input.windowDays}-day cool-off. Worth a look before you spend time on it; it decides nothing.`;
}

/**
 * Compose the message an applicant actually receives.
 *
 * Named, specific and short. The generic version — "we have decided to proceed
 * with other candidates" — is the one people screenshot.
 */
export function outcomeMessage(input: {
  candidateFirstName: string;
  roleTitle: string;
  dispositionCode: string;
  extraNote?: string | undefined;
}): string {
  const reason = DISPOSITION_BY_CODE[input.dispositionCode];
  const feedback = reason?.feedback ?? "we are not moving forward with your application this time.";
  const note = input.extraNote?.trim();

  return [
    `Hi ${input.candidateFirstName}, thank you for applying for ${input.roleTitle} at ${company.brandName}.`,
    `We are not moving forward this time — ${feedback}`,
    note,
  ]
    .filter(Boolean)
    .join(" ");
}

// ── `ATS-6`: the fields that are never collected ────────────────────────────

/**
 * Named so their absence is testable.
 *
 * `packages/db/test/recruitment.test.ts` asserts that no column on any
 * recruitment table matches any of these. A rule that only exists as a
 * paragraph in a requirements document is a rule the fourteenth migration
 * breaks by accident.
 */
export const PROHIBITED_APPLICANT_FIELDS = [
  "date_of_birth",
  "dob",
  "birth_date",
  "age",
  "nationality",
  "ethnicity",
  "race",
  "religion",
  "marital_status",
  "children",
  "dependants",
  "gender",
  "sex",
  "photo",
  "photograph",
  "health",
  "disability",
  "medical",
  "pregnancy",
] as const;

/**
 * `ATS-19`. No automated ranking, scoring or auto-rejection.
 *
 * Also asserted structurally, for the same reason: this is cheap to honour now
 * and very expensive to unwind once a chart somewhere depends on the number.
 */
export const PROHIBITED_SCORING_FIELDS = [
  "score",
  "ranking",
  "rank",
  "rating",
  "match_percent",
  "ai_score",
  "fit_score",
] as const;

/**
 * `HR-16`. The only party that may ever bear a recruitment cost.
 *
 * A one-element list, on purpose. Validation that *rejects* a worker-payable
 * fee still requires a field to put one in, and a field that exists is a field
 * a future importer, bulk action or integration can write to without passing
 * through the validator. The bearer column in `recruitment_costs` is CHECK-ed
 * against exactly this value, so there is no representable row in which a
 * worker pays.
 */
export const RECRUITMENT_COST_BEARER = ["employer"] as const;

export type RecruitmentCostBearer = (typeof RECRUITMENT_COST_BEARER)[number];

/** Cost categories that are the employer's by law, listed so they are named. */
export const RECRUITMENT_COST_KINDS = [
  "agency_fee",
  "visa_and_permit",
  "medical",
  "emirates_id",
  "travel",
  "advertising",
  "other",
] as const;

export type RecruitmentCostKind = (typeof RECRUITMENT_COST_KINDS)[number];

export const RECRUITMENT_COST_KIND_LABEL: Readonly<Record<RecruitmentCostKind, string>> = {
  agency_fee: "Agency / sourcing fee",
  visa_and_permit: "Visa and work permit",
  medical: "Medical fitness",
  emirates_id: "Emirates ID",
  travel: "Travel to the UAE",
  advertising: "Advertising the role",
  other: "Other hiring cost",
};

/**
 * The sentence shown wherever money and a worker appear on the same screen.
 *
 * Article 6 of Federal Decree-Law 33/2021. Written out rather than referenced
 * so the person reading the screen learns the rule, not the requirement number.
 */
export const HR16_NOTICE =
  "Recruitment, visa and permit costs are the employer's. They may never be charged to, deducted from or recovered from a worker, directly or indirectly (Article 6, Federal Decree-Law 33/2021). This system has no field in which to record a worker-borne recruitment cost.";

// ── Duplicate matching (`ATS-11`) ───────────────────────────────────────────

/**
 * The last nine digits of a phone number, for duplicate detection.
 *
 * `+971 50 123 4567`, `0501234567` and `971501234567` are one person applying
 * three times, and a naive equality check finds none of them. Nine digits is
 * the UAE subscriber number without the country code and without the trunk
 * zero, which is the longest suffix all three forms share.
 *
 * Mirrored exactly by the `phone_local_digits` generated column in migration
 * 0014 — the database computes it so an insert that bypasses this function
 * still gets a matchable value, and the two definitions are kept identical on
 * purpose. Changing one without the other silently stops finding duplicates.
 */
export function phoneLocalDigits(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.slice(-9);
}

/** Case- and whitespace-insensitive, because an email is neither. */
export function normaliseEmail(email: string | null | undefined): string | null {
  const trimmed = email?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

// ── Validation ──────────────────────────────────────────────────────────────

const serviceSlugs = services.map((s) => s.slug) as [string, ...string[]];

/**
 * One certificate as the public form collects it (`ATS-4`).
 *
 * `expiresOn` is required whenever a certificate is claimed, and that is the
 * whole reason this is a structured record rather than a text box. Expiry is
 * the field everyone forgets, and the day it matters is the day a dispatch is
 * refused under `HR-9` — by which point the certificate is on file, unusable,
 * and nobody knows when it lapsed.
 */
export const certificateClaimSchema = z.object({
  scheme: z.string().trim().min(2, "Which certificate is this?").max(120),
  certificateNo: z.string().trim().max(80).optional().or(z.literal("")),
  level: z.string().trim().max(40).optional().or(z.literal("")),
  issuingBody: z.string().trim().max(160).optional().or(z.literal("")),
  /** `YYYY-MM`. A month is all anyone reads off a trade card. */
  expiresOn: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Enter the expiry as month and year"),
});

export type CertificateClaim = z.infer<typeof certificateClaimSchema>;

/**
 * The public application (`ATS-3`).
 *
 * ── EVERY FIELD, AND WHAT IT COSTS ──────────────────────────────────────────
 *
 * The constraint is three minutes on a phone, one thumb, and roughly 60% of
 * applicants abandoning on length. So the budget is counted in *typed* fields,
 * not in fields:
 *
 *   Typed:  name, phone.                                    ← two, and that is
 *   Tapped: trade (pre-filled from the role), grade,           the whole budget
 *           experience, where you are, essential functions,
 *           availability, driving licence, talent pool.
 *   Optional: email, certificates, CV.
 *
 * `email` is optional and `phone` is required, which is the inversion this
 * market needs: phone is the primary identifier and the channel that actually
 * gets read (`ATS-14`). A form that requires an email address loses people who
 * have one and never check it.
 *
 * `cv` is optional with a structured fallback, per `ATS-3`. Many good
 * tradespeople have no CV, and a CV-mandatory form filters them out silently —
 * the worst kind of filter, because it produces no rejection to measure.
 *
 * `essentialFunctions` is a job question with two answers, one of which is
 * "I'd like to discuss it". It is never a health question and never a filter;
 * `ATS-6` puts any medical assessment after a conditional offer, in the
 * employee record, as part of the statutory visa medical.
 */
export const applicationSubmissionSchema = z.object({
  /** The requisition being applied to, by public slug. */
  roleSlug: z.string().trim().min(1).max(120),

  fullName: z.string().trim().min(2, "Please enter your name").max(160),
  phone: z
    .string()
    .trim()
    .min(7, "We need a number we can reach you on")
    .max(24)
    .regex(/^[+0-9\s()-]+$/, "Phone number contains unexpected characters"),
  email: z.email("Please check this email address").max(200).optional().or(z.literal("")),

  trade: z.enum(serviceSlugs, { error: "Please choose your trade" }),
  grade: z.enum(CANDIDATE_GRADES, { error: "Please choose your grade" }),
  experienceBand: z.enum(EXPERIENCE_BANDS, { error: "Please choose your experience" }),
  currentLocation: z.enum(CANDIDATE_LOCATIONS, { error: "Please tell us where you are now" }),
  availability: z.enum(AVAILABILITY_OPTIONS, { error: "Please tell us when you could start" }),

  hasDrivingLicence: z.boolean().default(false),

  /**
   * `ATS-6`, and the wording matters as much as the field.
   *
   * "Yes" or "I'd like to discuss" — never "no", because "no" invites a
   * decision on the form rather than a conversation, and the requirement is
   * that the question is about the essential functions of the job with or
   * without reasonable adjustment.
   */
  essentialFunctions: z.enum(["yes", "discuss"], {
    error: "Please answer the question about the essential functions of this role",
  }),

  /** Over 18 is the only age question permitted (`ATS-6`). Never a birth date. */
  overEighteen: z.literal(true, {
    error: "We can only accept applications from people aged 18 or over",
  }),

  certificates: z.array(certificateClaimSchema).max(6).default([]),

  /**
   * `ATS-13`. Its own lawful basis, captured separately and explicitly.
   *
   * Unticked by default and never bundled with the application itself: the
   * application is processed under the pre-contractual negotiation exception
   * (Federal Decree-Law 45/2021, Article 4), which expires with the
   * recruitment purpose. Keeping the details afterwards is a different purpose
   * and needs consent, so it gets a different tick box.
   */
  talentPoolConsent: z.boolean().default(false),

  /** Honeypot. Bots fill every field they can see; nobody else sees this one. */
  company: z.literal("").optional(),
});

export type ApplicationSubmission = z.infer<typeof applicationSubmissionSchema>;

/**
 * CV upload limits (`ATS-9`).
 *
 * 10 MB for a CV, 20 MB for certificate evidence — the evidence is a
 * photograph of a laminated card taken on a phone, and phone cameras produce
 * larger files than word processors do.
 */
export const CV_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_MAX_BYTES = 20 * 1024 * 1024;

export type ScanStatus = "pending" | "clean" | "infected" | "skipped";

export const SCAN_STATUS_LABEL: Readonly<Record<ScanStatus, string>> = {
  pending: "Scanning…",
  clean: "Scanned — clean",
  infected: "Blocked — failed virus scan",
  skipped: "Not virus-scanned",
};

/**
 * May this file be handed to a human?
 *
 * `ATS-9` gates downloads on scan status. `skipped` is permitted because it is
 * an explicit deployment state — no scanner is configured — rather than an
 * unknown one, and it is surfaced with a warning wherever it appears. `pending`
 * is refused: a file whose scan has not finished is a file nobody knows about.
 *
 * Flagged files are never attached to outbound staff email under any status.
 */
export function isDownloadable(status: ScanStatus): boolean {
  return status === "clean" || status === "skipped";
}

// ── The talent pool (`ATS-13`) ──────────────────────────────────────────────

/**
 * How long a pool consent stands before somebody has to ask again.
 *
 * Ninety days, and it is a short clock on purpose. A tradesperson's
 * availability and certificate validity go stale in weeks, so a pool nobody
 * re-confirms is not a warm list — it is a list of people who have all found
 * other work, held past the point the consent covered.
 *
 * The public submission path sets the same interval in SQL
 * (`app_public_submit_application`, in sql/public-functions.sql), which this
 * constant cannot reach. Changing one means changing the other.
 */
export const TALENT_POOL_RECONFIRM_DAYS = 90;

/**
 * The window "expiring soon" means, for a certificate.
 *
 * Forty-five days is long enough to renew a ticket without paying for haste and
 * short enough that the list is a morning's calls rather than a report.
 */
export const CERTIFICATION_EXPIRY_WINDOW_DAYS = 45;

/**
 * How the pool can be filtered.
 *
 * These are the only two axes worth having — trade and whether the person's
 * ticket is still good — because they are the two questions somebody staffing a
 * job actually asks. There is no relevance score and no ranking (`ATS-19`);
 * the list is ordered by consequence and a human reads it.
 */
export const TALENT_POOL_CERT_FILTERS = ["any", "lapsed", "expiring", "valid", "none"] as const;

export type TalentPoolCertFilter = (typeof TALENT_POOL_CERT_FILTERS)[number];

export const TALENT_POOL_CERT_FILTER_LABEL: Readonly<Record<TalentPoolCertFilter, string>> = {
  any: "Any certification status",
  lapsed: "Has a lapsed certificate",
  expiring: `Expiring within ${CERTIFICATION_EXPIRY_WINDOW_DAYS} days`,
  valid: "All certificates in date",
  none: "No certificate recorded",
};

export function isTalentPoolCertFilter(value: string): value is TalentPoolCertFilter {
  return (TALENT_POOL_CERT_FILTERS as readonly string[]).includes(value);
}

/**
 * What a re-confirmation needs (`ATS-13`).
 *
 * A person, a pool, and optionally a line about the call. Nothing about
 * availability or rate, because this records one fact — that the candidate was
 * asked again and said yes — and a form that collects five things is a form
 * somebody skips when they are holding a phone.
 */
export const talentPoolReconfirmSchema = z.object({
  candidateId: z.uuid("Pick somebody in the pool"),
  poolKey: z.string().trim().min(1).max(64),
  note: z.string().trim().max(280).optional().or(z.literal("")),
});

/**
 * What a withdrawal needs (`ATS-13`).
 *
 * The reason is optional and always will be. Somebody exercising the right to
 * withdraw consent does not have to justify it, and a required field here would
 * turn a right into a negotiation.
 */
export const talentPoolWithdrawSchema = z.object({
  candidateId: z.uuid("Pick somebody in the pool"),
  poolKey: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(280).optional().or(z.literal("")),
});

// ── `ATS-14`: interview logistics ───────────────────────────────────────────

export const INTERVIEW_KINDS = ["interview", "site_trial"] as const;
export type InterviewKind = (typeof INTERVIEW_KINDS)[number];

/**
 * Two values, because the candidate needs to know which one they are coming to.
 * One wants a shirt; the other wants boots, a hard hat and a full day.
 */
export const INTERVIEW_KIND_LABEL: Readonly<Record<InterviewKind, string>> = {
  interview: "Interview",
  site_trial: "Site trial",
};

export const INTERVIEW_STATUSES = ["scheduled", "cancelled", "completed"] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

/**
 * The two reminder windows `ATS-14` asks for, as hours before the interview.
 *
 * Two and not one, and the second is the one that works. A day out is when a
 * person can still move their other job around; two hours out is when they
 * actually set off, and it is the message that turns a no-show into an arrival.
 *
 * `key` is what the database columns and the template payload are named after,
 * so the three cannot drift apart.
 */
export const INTERVIEW_REMINDERS = [
  { key: "24h", hoursBefore: 24, label: "Tomorrow" },
  { key: "2h", hoursBefore: 2, label: "In about two hours" },
] as const;

export type InterviewReminderWindow = (typeof INTERVIEW_REMINDERS)[number]["key"];

/**
 * The PPE a Dubai maintenance site actually asks for at a gate.
 *
 * A suggested list on the scheduling form rather than free text, for the same
 * reason the disposition reasons are a list: "hi-vis" typed five ways is five
 * requirements, and the one a candidate does not recognise is the one they turn
 * up without. The column is a JSON array, so a site with an unusual requirement
 * can still carry it — this is the fast path, not the whole vocabulary.
 */
export const INTERVIEW_PPE_OPTIONS = [
  "Safety boots",
  "Hard hat",
  "Hi-vis vest",
  "Safety glasses",
  "Gloves",
  "Long sleeves and trousers",
] as const;

/**
 * What scheduling an interview needs (`ATS-14`).
 *
 * The address is required and cannot be blank, and that is the one strictness
 * worth having here: an address that is present but empty is the same missing
 * address with an extra step, and the candidate finds out at the roundabout.
 * Everything else is optional because a site with no parking problem should not
 * have to invent a parking note.
 */
export const interviewScheduleSchema = z.object({
  applicationId: z.uuid("Pick an application"),
  kind: z.enum(INTERVIEW_KINDS),
  /** Local Dubai wall-clock, as the browser's datetime-local control gives it. */
  scheduledAt: z.string().trim().min(1, "Say when they should come"),
  durationMinutes: z.coerce.number().int().min(15).max(600).default(60),
  locationName: z.string().trim().min(1, "Name the site or the office").max(160),
  locationAddress: z.string().trim().min(1, "They cannot find an empty address").max(2000),
  locationArea: z.string().trim().max(120).optional().or(z.literal("")),
  locationMapUrl: z.string().trim().max(2000).optional().or(z.literal("")),
  parkingNotes: z.string().trim().max(2000).optional().or(z.literal("")),
  ppeRequired: z.array(z.string().trim().min(1).max(80)).max(12).default([]),
  bringNotes: z.string().trim().max(2000).optional().or(z.literal("")),
  contactName: z.string().trim().max(160).optional().or(z.literal("")),
  contactPhone: z.string().trim().max(24).optional().or(z.literal("")),
});

/**
 * What the candidate's reschedule request needs (`ATS-14`).
 *
 * A note and nothing else. It is a request, not a move: the token behind it
 * identifies the application, and a candidate silently moving a site trial that
 * a supervisor has blocked two hours out for is not a feature. The note is
 * optional because somebody whose shift changed should not have to compose a
 * paragraph to say so at eleven at night.
 */
export const interviewRescheduleRequestSchema = z.object({
  note: z.string().trim().max(400).optional().or(z.literal("")),
});

export type ParseStatus = "not_attempted" | "parsed" | "failed" | "unsupported";

/**
 * `ATS-10`. Parse failure is a first-class state, not an error path.
 *
 * Trades CVs are frequently photographs of a printed sheet. A parser that
 * treats failure as exceptional produces a queue of exceptions nobody works
 * through; one that treats it as ordinary produces a form somebody fills in by
 * hand in ninety seconds. The original file is retained either way, always, so
 * a better parser can be run over it later — which is what `parser_version` is
 * for.
 */
export const PARSE_STATUS_LABEL: Readonly<Record<ParseStatus, string>> = {
  not_attempted: "Not parsed",
  parsed: "Parsed — confirm the fields",
  failed: "Parse failed — enter by hand",
  unsupported: "Cannot be parsed",
};

// ── Requisitions (`ATS-1`, `ATS-2`) ─────────────────────────────────────────

export const REQUISITION_STATUSES = [
  "draft",
  "pending_approval",
  "open",
  "on_hold",
  "filled",
  "cancelled",
] as const;

export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

export const REQUISITION_STATUS_LABEL: Readonly<Record<RequisitionStatus, string>> = {
  draft: "Draft",
  pending_approval: "Awaiting approval",
  open: "Open",
  on_hold: "On hold",
  filled: "Filled",
  cancelled: "Cancelled",
};

/** Only an open requisition is on the public careers site. */
export const PUBLIC_REQUISITION_STATUSES: readonly RequisitionStatus[] = ["open"];

export const CONTRACT_TYPES = ["full_time", "part_time", "temporary"] as const;

export type ContractType = (typeof CONTRACT_TYPES)[number];

export const CONTRACT_TYPE_LABEL: Readonly<Record<ContractType, string>> = {
  full_time: "Full-time",
  part_time: "Part-time",
  temporary: "Temporary",
};

/** schema.org employmentType values, keyed by ours. */
const SCHEMA_EMPLOYMENT_TYPE: Readonly<Record<ContractType, string>> = {
  full_time: "FULL_TIME",
  part_time: "PART_TIME",
  temporary: "TEMPORARY",
};

export interface PublicRequisition {
  readonly slug: string;
  readonly title: string;
  readonly trade: string;
  readonly grade: CandidateGrade;
  readonly contractType: ContractType;
  readonly headcount: number;
  readonly city: string;
  readonly area: string | null;
  readonly minExperienceYears: number | null;
  readonly summary: string | null;
  readonly responsibilities: string | null;
  /**
   * `ATS-6`. Stated in the advert, which is the only place physical
   * requirements belong — the form asks one yes/no about them and never asks
   * about health.
   */
  readonly physicalRequirements: string | null;
  readonly requiredCertifications: readonly string[];
  readonly salaryMinMinor: number | null;
  readonly salaryMaxMinor: number | null;
  readonly currency: string;
  readonly opensAt: Date | null;
  readonly closesAt: Date | null;
}

/**
 * `JobPosting` structured data (`ATS-2`, `WEB-7`).
 *
 * This is what puts an open role into Google Jobs and makes it citable by an
 * assistant answering "who is hiring AC technicians in Dubai". It is also the
 * one place on the public site where a salary can be published, so it is
 * omitted rather than guessed when no band is set: a `baseSalary` of zero is
 * worse than no `baseSalary`, because it is indexed.
 *
 * `directApply` is true and it is a factual claim: the application form is on
 * this site and completes here, with no redirect to a third-party portal.
 */
export function jobPostingSchema(role: PublicRequisition): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@type": "JobPosting",
    "@id": absoluteUrl(`/careers/${role.slug}#posting`),
    title: role.title,
    description: [role.summary, role.responsibilities, role.physicalRequirements]
      .filter(Boolean)
      .join("\n\n"),
    identifier: {
      "@type": "PropertyValue",
      name: company.legalName,
      value: role.slug,
    },
    hiringOrganization: {
      "@type": "Organization",
      name: company.legalName,
      url: absoluteUrl("/"),
    },
    employmentType: SCHEMA_EMPLOYMENT_TYPE[role.contractType],
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: role.city,
        addressRegion: role.area ?? undefined,
        addressCountry: "AE",
      },
    },
    totalJobOpenings: role.headcount,
    directApply: true,
    url: absoluteUrl(`/careers/${role.slug}`),
  };

  if (role.opensAt) node["datePosted"] = role.opensAt.toISOString().slice(0, 10);
  if (role.closesAt) node["validThrough"] = role.closesAt.toISOString();

  if (role.minExperienceYears !== null) {
    node["experienceRequirements"] = {
      "@type": "OccupationalExperienceRequirements",
      monthsOfExperience: role.minExperienceYears * 12,
    };
  }

  if (role.requiredCertifications.length > 0) {
    node["qualifications"] = role.requiredCertifications.join(", ");
  }

  // Only when a real band exists. A published salary is a commitment, and an
  // indexed wrong one is a commitment made by accident.
  if (role.salaryMinMinor !== null && role.salaryMaxMinor !== null) {
    node["baseSalary"] = {
      "@type": "MonetaryAmount",
      currency: role.currency,
      value: {
        "@type": "QuantitativeValue",
        minValue: role.salaryMinMinor / 100,
        maxValue: role.salaryMaxMinor / 100,
        unitText: "MONTH",
      },
    };
  }

  return node;
}

/** Where an applicant tracks their own application, no account required. */
export function applicationStatusUrl(token: string): string {
  return absoluteUrl(`/careers/application/${token}`);
}

/** The careers contact channel, for the "questions?" line on every surface. */
export const CAREERS_WHATSAPP = tenant.whatsapp;
