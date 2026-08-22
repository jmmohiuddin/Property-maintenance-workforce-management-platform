import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  bigint,
  date,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, timestamps, money } from "./_shared";
import { tenants, users } from "./tenancy";
import { technicians } from "./workforce";
import { jobs } from "./operations";

/**
 * Workforce compliance.
 *
 * `HR-5`, `HR-9`, `HR-14`. This is the module that most justifies building the
 * system: deploying a worker without a valid permit carries **AED 100,000 to
 * AED 1,000,000** since the 2024 amendment to Article 60 of the Labour Law,
 * multiplied by headcount in fictitious-employment cases. Target `G15` — zero
 * dispatches to a technician with a lapsed permit, visa, Emirates ID, medical
 * fitness certificate or health insurance — is enforced by system behaviour
 * rather than by reporting, because reporting tells you about it afterwards.
 */

/**
 * The employment record, which extends `technicians` rather than replacing it.
 *
 * A technician may exist without an employee record. That is not an oversight:
 * subcontracted and manpower-supplied labour is real in this market, the
 * company's obligations differ, and a model that forces every technician to be
 * an employee would make the distinction unrepresentable — at which point
 * somebody records a subcontractor as an employee and the payroll numbers stop
 * meaning anything.
 */
export const employees = pgTable(
  "employees",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id").references(() => technicians.id, { onDelete: "set null" }),
    employeeNo: varchar("employee_no", { length: 32 }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    /**
     * UAE private-sector contracts are fixed-term only since Federal
     * Decree-Law 33/2021. The three-year cap was removed in 2022, and a
     * contract continued past its end date auto-renews on the same terms.
     */
    contractType: varchar("contract_type", { length: 24 }).notNull().default("fixed_term"),
    contractStart: date("contract_start"),
    contractEnd: date("contract_end"),
    /** Maximum six months, non-extendable. */
    probationEnd: date("probation_end"),
    noticePeriodDays: integer("notice_period_days").notNull().default(30),
    /**
     * Basic salary in fils, kept apart from allowances deliberately.
     *
     * Gratuity accrues on basic pay only, excluding housing, transport,
     * utilities and furniture (`HR-13`). Storing one combined "salary" would
     * silently inflate every end-of-service calculation, and the error would
     * only surface at termination, when it is a payment dispute.
     */
    basicSalaryMinor: bigint("basic_salary_minor", { mode: "number" }),
    allowances: jsonb("allowances").notNull().default({}),
    mohrePersonCode: varchar("mohre_person_code", { length: 32 }),
    wpsIban: varchar("wps_iban", { length: 34 }),
    /**
     * Health insurance, the parts that are not an expiry date (`HR-6`).
     *
     * Cover is mandatory in Dubai under Law No. 11 of 2013, is employer-funded,
     * and the premium may not be deducted from salary. Workers earning under
     * AED 4,000 a month require an Essential Benefits Plan specifically, so the
     * plan tier has to be knowable — a policy that exists but is the wrong tier
     * is non-compliant in exactly the same way as no policy at all.
     *
     * ── WHY THERE IS NO EXPIRY COLUMN HERE ──────────────────────────────────
     *
     * `health_insurance` is already one of the five `HR-9` blocking document
     * kinds in `employee_documents`, with an expiry date that hard-blocks
     * dispatch when it lapses. A second expiry on this table would be a second
     * source of truth, and the one that is wrong would inevitably be the one
     * somebody reads. The document is the expiry; these columns are the cover.
     */
    healthPlan: varchar("health_plan", { length: 24 }),
    healthInsurer: varchar("health_insurer", { length: 120 }),
    healthPolicyNo: varchar("health_policy_no", { length: 64 }),
    /**
     * Annual premium, an **employer cost**. It exists so the cost is visible in
     * one place and never has to be reconstructed at renewal. It is not, and
     * must never become, a salary deduction: `salary_deductions.kind` has a
     * CHECK constraint that makes recording it as one impossible.
     */
    healthPremium: money("health_premium"),
    /**
     * ISCO-08 occupational major group, 1–9. The first leg of `HR-18`.
     *
     * ── WHY NULLABLE, AND WHY THAT IS THE IMPORTANT PART ────────────────────
     *
     * Emiratisation targets apply at 50 or more **skilled** employees, and
     * "skilled" is a conjunction: ISCO major group 1–5, **and** a
     * post-secondary certificate, **and** at least AED 4,000 a month. The wage
     * is already here; these two columns are the other two legs.
     *
     * Null means nobody has recorded it, and `classifySkilledEmployee` treats
     * that as `unknown` rather than as unskilled. NOT NULL with a default would
     * have to invent a group for every existing employee, and every invented
     * group would be indistinguishable from one somebody chose — which is how
     * an establishment discovers it crossed the threshold a quarter ago.
     * `assessEmiratisation` counts the unknowns into the upper bound, so a
     * missing fact reads as "this may already have been crossed" instead of as
     * a reassuring low number.
     */
    iscoMajorGroup: smallint("isco_major_group"),
    /** Second leg of `HR-18`. Null is "not recorded", not "no". */
    postSecondaryCertificate: boolean("post_secondary_certificate"),
    status: varchar("status", { length: 24 }).notNull().default("active"),
    terminatedAt: timestamp("terminated_at", { withTimezone: true }),
    /** `HR-15` — 2 years post-termination minimum. Purged by a job, not a policy. */
    deleteAfter: date("delete_after"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("employees_tenant_no_key").on(t.tenantId, t.employeeNo),
    index("employees_technician_idx").on(t.tenantId, t.technicianId),
    index("employees_retention_idx").on(t.deleteAfter).where(sql`${t.deleteAfter} is not null`),
    // The Emiratisation denominator's exact predicate. The skilled count is
    // recomputed on every render of the HR board and on every compliance cron
    // run; without this it is a sequential scan of the whole establishment.
    index("employees_skilled_idx")
      .on(t.tenantId, t.iscoMajorGroup, t.postSecondaryCertificate)
      .where(sql`${t.status} = 'active' and ${t.deletedAt} is null`),
  ],
);

/**
 * Document kinds, and which of them stop a dispatch.
 *
 * `blocking` is a column rather than a constant so an administrator can change
 * it without a deploy — but these are the defaults, and the five that block are
 * the five named in `HR-9`.
 */
export const EMPLOYEE_DOCUMENT_KINDS = [
  "passport",
  "residence_visa",
  "emirates_id",
  "work_permit",
  "medical_fitness",
  "health_insurance",
  "driving_licence",
  "other",
] as const;

export type EmployeeDocumentKind = (typeof EMPLOYEE_DOCUMENT_KINDS)[number];

/** The five whose expiry is a wall rather than a sign. */
export const BLOCKING_DOCUMENT_KINDS: readonly EmployeeDocumentKind[] = [
  "work_permit",
  "residence_visa",
  "emirates_id",
  "medical_fitness",
  "health_insurance",
];

export const EMPLOYEE_DOCUMENT_LABEL: Readonly<Record<EmployeeDocumentKind, string>> = {
  passport: "Passport",
  residence_visa: "Residence visa",
  emirates_id: "Emirates ID",
  work_permit: "MOHRE work permit",
  medical_fitness: "Medical fitness certificate",
  health_insurance: "Health insurance",
  driving_licence: "Driving licence",
  other: "Other document",
};

export const employeeDocuments = pgTable(
  "employee_documents",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    referenceNo: varchar("reference_no", { length: 64 }),
    issuedAt: date("issued_at"),
    expiresAt: date("expires_at"),
    storageKey: text("storage_key"),
    /**
     * The column that makes `HR-9` enforceable in one query rather than as a
     * special case per document type.
     *
     * Defaults to `false`. A new document kind is a warning until somebody
     * decides it is a wall, and the design rule is that adding a hard block
     * requires naming the statutory penalty it prevents.
     */
    blocking: boolean("blocking").notNull().default(false),
    verifiedById: uuid("verified_by_id").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("employee_documents_blocking_expiry_idx")
      .on(t.tenantId, t.expiresAt)
      .where(sql`${t.blocking} and ${t.deletedAt} is null`),
    index("employee_documents_employee_idx").on(t.tenantId, t.employeeId),
    uniqueIndex("employee_documents_kind_key")
      .on(t.employeeId, t.kind)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const ACCREDITATION_KINDS = [
  "trade_licence",
  "dewa_enrolment",
  "dm_classification",
  "iso_cert",
  "liability_insurance",
  "workmen_comp",
  "worker_protection",
  "other",
] as const;

export type AccreditationKind = (typeof ACCREDITATION_KINDS)[number];

export const ACCREDITATION_LABEL: Readonly<Record<AccreditationKind, string>> = {
  trade_licence: "Trade licence",
  dewa_enrolment: "DEWA contractor enrolment",
  dm_classification: "Dubai Municipality contractor classification",
  iso_cert: "ISO certificate",
  liability_insurance: "Third-party liability insurance",
  workmen_comp: "Workmen's compensation cover",
  worker_protection: "Workers Protection Programme / bank guarantee",
  other: "Other accreditation",
};

/**
 * Company-level accreditations (`HR-14`), distinct from individual
 * certifications because they belong to the establishment.
 *
 * This is also where the public site's credibility comes from. The previous
 * build listed three ISO certificates and an insurance figure the company did
 * not hold; the rule now is that nothing is published until there is a row here
 * with a document and an in-date expiry behind it. Feeds `CON-12`, the tender
 * pack, so the pack is assembled live and is never stale.
 */
export const companyAccreditations = pgTable(
  "company_accreditations",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    referenceNo: varchar("reference_no", { length: 64 }),
    issuingBody: varchar("issuing_body", { length: 160 }),
    /** DEWA enrolment is graded Platinum/Gold/Silver/Bronze on past performance. */
    grade: varchar("grade", { length: 32 }),
    issuedAt: date("issued_at"),
    expiresAt: date("expires_at"),
    storageKey: text("storage_key"),
    renewalOwnerUserId: uuid("renewal_owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    tenderPackInclude: boolean("tender_pack_include").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("company_accreditations_expiry_idx").on(t.tenantId, t.expiresAt)],
);

// ═══════════════════════════════════════════════════════════════════════════
// HR-11 — The work injury register
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Work injuries and occupational diseases, and whether MOHRE was told in time.
 *
 * Article 37 of Federal Decree-Law No. 33 of 2021 obliges the employer to
 * notify the competent authorities of a work injury or occupational disease and
 * to bear the cost of treatment; its Implementing Regulation obliges the
 * employer to keep a register of them. This is that register, and
 * `MOHRE_INJURY_NOTIFICATION_HOURS` in `packages/core` is the clock over it.
 *
 * This is a maintenance company. Technicians work at height, on live fittings,
 * in plant rooms and with refrigerant, so the register will be used.
 *
 * ── WHAT IS DELIBERATELY NOT COLLECTED ──────────────────────────────────────
 *
 * This table holds **health information about identifiable people**, so the
 * rule applied to every column was: does the statutory register or a MOHRE
 * notification need it? If not, it is not here.
 *
 * Not here, and each for a stated reason:
 *
 *   * **Diagnosis, treatment, medication, hospital, treating doctor.** A
 *     notification is made from the medical report; it does not require the
 *     employer to hold a copy of it, and an employer's database is the wrong
 *     place for a clinical record. `medical_report_key` is a pointer to a file
 *     in object storage under the same access control as every other employee
 *     document — the register knows a report exists, not what it says.
 *   * **Body part injured.** It is health data about the person and it changes
 *     nothing anybody does here. `cause` is the field a risk assessment is
 *     rewritten against, and it is about the work rather than about the body.
 *   * **Nationality, and anything else about who the person is.** The same
 *     decision `employees` already made: it is a protected characteristic and
 *     nothing in this obligation turns on it.
 *   * **Fitness-to-return and medical restrictions.** Genuinely useful to a
 *     dispatcher and genuinely a medical opinion about a person. Left out
 *     rather than guessed at — if it is added later it needs its own access
 *     decision, not a column smuggled in beside a cause code.
 *
 * ── THE EMPLOYEE LINK IS `set null`, AND THAT IS THE RETENTION DESIGN ───────
 *
 * Every other child of `employees` in this schema cascades, because the HR-15
 * purge only fires seven years after termination and everything downstream of
 * it is a payroll record with the same seven-year floor.
 *
 * An injury record is not. An occupational disease can be diagnosed a decade
 * after the exposure, and a compensation claim can be brought long after the
 * employment ended — so a register that vanished with the employee would be
 * destroying the evidence in the dispute it exists to settle. Equally, keeping
 * a named person's health information for ever is exactly what the HR-15 clock
 * exists to prevent.
 *
 * `on delete set null` is what satisfies both. When the employee is purged the
 * injury row survives as a register entry and an OSH statistic, and the link to
 * the person is severed by the purge itself. `work_injuries` is also in
 * `RETENTION_PROTECTED_TABLES` so nothing deletes the row directly.
 *
 * `employee_no` is frozen onto the row and survives the purge. That is a
 * judgement call and it is the only one on this table: it is a pseudonymous
 * internal reference rather than a name, it maps to nothing once `employees` is
 * gone, and `purgeExpiredEmployees` already writes exactly this value into the
 * audit log — so the choice here is not whether it survives a purge but whether
 * the surviving register entry can be tied to the audit row that recorded the
 * purge. Without it, it cannot.
 */
export const workInjuries = pgTable(
  "work_injuries",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** `INJ-2026-00001`, from `app_next_reference`. The register's serial. */
    reference: varchar("reference", { length: 32 }).notNull(),
    /** Severed by the HR-15 purge rather than cascading. See above. */
    employeeId: uuid("employee_id").references(() => employees.id, { onDelete: "set null" }),
    /** Frozen. Survives the purge that nulls `employee_id`. */
    employeeNo: varchar("employee_no", { length: 32 }),
    /** `work_injury` or `occupational_disease`. Article 37 covers both. */
    kind: varchar("kind", { length: 24 }).notNull().default("work_injury"),
    /** The incident instant. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /**
     * Dubai's calendar day for `occurred_at`, stored rather than derived.
     *
     * `at time zone 'Asia/Dubai'` is STABLE, not IMMUTABLE, so Postgres will
     * not have it in a generated column — and deriving it at read time from
     * whatever timezone the session happens to carry is the eight-times-repeated
     * defect in this repository. A night-shift injury at 01:00 Dubai is 21:00
     * UTC the previous evening; filing it under the wrong day puts it in the
     * wrong month of the register and, on the last day of a month, in the wrong
     * year.
     *
     * Written by `recordWorkInjury` from the Dubai key, never by a default.
     */
    occurredOn: date("occurred_on").notNull(),
    /**
     * When the employer learned of it. The 48-hour clock starts HERE.
     *
     * Equal to `occurred_at` for an injury somebody witnessed. Later for an
     * occupational disease, which arrives as a diagnosis — and a clock started
     * at an exposure ten years ago would report every such record as an
     * immediate statutory breach on the day it was entered, which would teach
     * everybody to stop entering them.
     */
    becameKnownAt: timestamp("became_known_at", { withTimezone: true }).notNull(),
    severity: varchar("severity", { length: 24 }).notNull(),
    cause: varchar("cause", { length: 32 }).notNull(),
    /** Where it happened, in words. The job below carries the property. */
    location: varchar("location", { length: 200 }),
    /** The work being done. Null for an occupational disease, and often null. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** What happened. About the work, not about the body. */
    description: text("description").notNull(),
    /** Whole days of work lost. Null while it is not yet known. */
    daysLost: integer("days_lost"),
    /** The statutory notification. Null is the state the alarm is about. */
    mohreNotifiedAt: timestamp("mohre_notified_at", { withTimezone: true }),
    mohreReference: varchar("mohre_reference", { length: 64 }),
    /**
     * Contractual rather than statutory, and it can cost more.
     *
     * A workmen's compensation policy typically voids cover on late notice, so
     * an unnotified insurer keeps the record alerting even after MOHRE has been
     * told — but it does not drive the statutory stage, because it is not a
     * statutory obligation and conflating the two would misdescribe a breach.
     */
    insurerNotifiedAt: timestamp("insurer_notified_at", { withTimezone: true }),
    insurerClaimReference: varchar("insurer_claim_reference", { length: 64 }),
    /**
     * The police report, where there is one. **No countdown behind it.**
     *
     * A serious injury or a death must be reported to the police immediately,
     * and "immediately" is not a countdown. A 48-hour bar next to this field
     * would read as permission to wait two days, so the record carries a
     * standing warning for the two severities instead — see
     * `POLICE_REPORTABLE_SEVERITIES`.
     */
    policeReference: varchar("police_reference", { length: 64 }),
    /** A pointer, not a copy. The register knows a report exists. */
    medicalReportKey: text("medical_report_key"),
    /** The join to `HR-12`: what was changed so it does not happen again. */
    investigationCompletedOn: date("investigation_completed_on"),
    correctiveAction: text("corrective_action"),
    /** The RAMS that was rewritten as a result, where one was. */
    ramsId: uuid("rams_id"),
    recordedById: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("work_injuries_reference_key").on(t.tenantId, t.reference),
    // The hourly clock's exact predicate: records MOHRE has not been told
    // about. Partial, because the answer is almost always "none" and a full
    // scan of a register that only grows would be the whole cost of the job.
    index("work_injuries_unnotified_idx")
      .on(t.tenantId, t.becameKnownAt)
      .where(sql`${t.mohreNotifiedAt} is null and ${t.deletedAt} is null`),
    index("work_injuries_employee_idx").on(t.tenantId, t.employeeId),
    // The register, in date order. Dubai's day, which is why the column exists.
    index("work_injuries_day_idx").on(t.tenantId, t.occurredOn),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// HR-12 — HSE records
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Risk assessments and method statements, and when each falls out of review.
 *
 * ── WHY A REVIEW DATE IS THE POINT OF THIS TABLE ────────────────────────────
 *
 * A RAMS pack that exists is not evidence of anything; a RAMS pack that was
 * reviewed against how the work is actually being done is. The failure mode is
 * a document approved in 2023, still being briefed in toolbox talks in 2026,
 * describing a method nobody uses — and an inspector reads that as proof that
 * nobody was assessing anything, which is worse than having no document.
 *
 * So `review_due_on` is the column with the index on it, and the hourly HSE job
 * reads it against **Dubai's day**, not the session's.
 *
 * `hazards` is jsonb — `[{ hazard, control, residualRisk }]` — for the reason
 * `subcontractors.accreditations` is: the set is open-ended, we do not control
 * it, and a `kind` vocabulary would either reject a real hazard or grow an
 * `other` bucket that swallowed most of them. Unlike that column, nothing here
 * carries a date, so there is no second clock hiding inside the JSON.
 */
export const hseRams = pgTable(
  "hse_rams",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    reference: varchar("reference", { length: 32 }).notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    kind: varchar("kind", { length: 24 }).notNull().default("rams"),
    /** The trade or activity it covers, e.g. `electrical`, `hvac`. */
    tradeSlug: varchar("trade_slug", { length: 64 }),
    /** The service it is mandatory for, where it is job-specific. */
    serviceSlug: varchar("service_slug", { length: 64 }),
    /** Set where the pack was written for one job rather than for an activity. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** 1, 2, 3 … A revision is a new version, never an edit in place. */
    version: integer("version").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("draft"),
    approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedOn: date("approved_on"),
    /** The clock. Compared against Dubai's day, everywhere. */
    reviewDueOn: date("review_due_on"),
    hazards: jsonb("hazards").notNull().default([]),
    storageKey: text("storage_key"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("hse_rams_reference_key").on(t.tenantId, t.reference),
    // The sweep's exact predicate: live packs with a review date.
    index("hse_rams_review_idx")
      .on(t.tenantId, t.reviewDueOn)
      .where(sql`${t.status} = 'approved' and ${t.deletedAt} is null`),
    index("hse_rams_trade_idx").on(t.tenantId, t.tradeSlug),
  ],
);

/**
 * A toolbox talk that was actually given, on a day, to named people.
 *
 * The attendance is the record. A talk with no attendees is a plan, and the
 * question an inspector asks after an incident is "was this person briefed",
 * which a topic and a date cannot answer.
 */
export const toolboxTalks = pgTable(
  "toolbox_talks",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Dubai's day. Written from the Dubai key, never from `current_date`. */
    heldOn: date("held_on").notNull(),
    topic: varchar("topic", { length: 200 }).notNull(),
    /** The pack this talk briefed, where it briefed one. */
    ramsId: uuid("rams_id").references(() => hseRams.id, { onDelete: "set null" }),
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    presentedById: uuid("presented_by_id").references(() => users.id, { onDelete: "set null" }),
    /** For a talk given by somebody without a login — a site supervisor. */
    presenterName: varchar("presenter_name", { length: 160 }),
    durationMinutes: integer("duration_minutes"),
    storageKey: text("storage_key"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("toolbox_talks_day_idx").on(t.tenantId, t.heldOn),
    index("toolbox_talks_rams_idx").on(t.tenantId, t.ramsId),
  ],
);

/**
 * Who was at one talk.
 *
 * `on delete cascade` from the employee, unlike `work_injuries` above, and the
 * difference is the point: an attendance record is ordinary personal data with
 * no statutory life beyond the employment, so it goes with the HR-15 purge. An
 * injury record is evidence in a claim that outlives it. Two children of the
 * same table with two different retention answers, because they are two
 * different kinds of fact.
 */
export const toolboxTalkAttendees = pgTable(
  "toolbox_talk_attendees",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    toolboxTalkId: uuid("toolbox_talk_id")
      .notNull()
      .references(() => toolboxTalks.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    /** Where the attendance sheet was signed. Null means somebody ticked a box. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("toolbox_talk_attendee_key").on(t.toolboxTalkId, t.employeeId),
    index("toolbox_talk_attendee_employee_idx").on(t.tenantId, t.employeeId),
  ],
);

/**
 * PPE issued to one person, and when it is due to be replaced.
 *
 * ── THERE IS NO COST COLUMN, AND THERE MUST NOT BE ──────────────────────────
 *
 * PPE is provided at the employer's expense. `LAWFUL_DEDUCTION_KINDS` is a
 * positive list with a CHECK constraint behind it, so recovering PPE from a
 * wage is already unrepresentable — but a cost column here would be the first
 * step towards somebody entering it as `damage_recovery`, which the list does
 * admit. The register records that the equipment was issued; what it cost is a
 * purchasing question and it lives with purchasing.
 *
 * `size` is the one field that is arguably personal, and it is here because
 * reissuing boots or a harness in the wrong size is how somebody ends up not
 * wearing them. It is not a body measurement and it is not health data.
 */
export const ppeIssues = pgTable(
  "ppe_issues",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employeeId: uuid("employee_id")
      .notNull()
      .references(() => employees.id, { onDelete: "cascade" }),
    itemKind: varchar("item_kind", { length: 24 }).notNull(),
    /** The actual thing, e.g. "Petzl Avao harness". Free text on purpose. */
    itemDescription: varchar("item_description", { length: 160 }),
    size: varchar("size", { length: 24 }),
    quantity: integer("quantity").notNull().default(1),
    /** Dubai's day. */
    issuedOn: date("issued_on").notNull(),
    /**
     * The clock. Fall-arrest equipment in particular has a shelf life and an
     * inspection interval, and a harness past its date is a harness that has to
     * come out of service whether or not it looks fine.
     */
    replaceDueOn: date("replace_due_on"),
    /** The signature on the issue sheet. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    issuedById: uuid("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when it comes back, so it stops appearing on the replacement list. */
    returnedOn: date("returned_on"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("ppe_issues_employee_idx").on(t.tenantId, t.employeeId),
    // The sweep's exact predicate: issued, not returned, with a date on it.
    index("ppe_issues_replacement_idx")
      .on(t.tenantId, t.replaceDueOn)
      .where(sql`${t.returnedOn} is null and ${t.deletedAt} is null`),
  ],
);
