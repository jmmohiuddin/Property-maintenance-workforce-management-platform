import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  bigint,
  date,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol, timestamps, currencyCol } from "./_shared";
import { tenants, users } from "./tenancy";
import { technicians } from "./workforce";

/**
 * Recruitment — M9, `ATS-1`…`ATS-19`.
 *
 * ── THE SHAPE, AND WHY IT IS THIS SHAPE ─────────────────────────────────────
 *
 * `Candidate 1—N Application` (`ATS-12`). One person, several roles, several
 * years. Every generic ATS that collapses these into one row makes the same two
 * mistakes: applying for a second role overwrites the first application's
 * stage, and re-applying next year either creates a stranger or destroys the
 * history that says we already trade-tested them. Candidate-level facts (name,
 * phone, certificates) live on the person; application-level facts (stage,
 * source, outcome, attachments) live on the application.
 *
 * Three axes on `applications`, kept separate on purpose (TRD §4):
 *
 *   * `current_stage_id` — **where** it is.
 *   * `status`           — **whether** it is live.
 *   * `disposition_reason_code` + `archived_at_stage_id` — **why** and **where**
 *     it ended.
 *
 * `archived_at_stage_id` is the one that looks redundant and is not. Without
 * it, funnel conversion cannot be computed at all — "we lose people at trade
 * check" is unanswerable once the stage pointer has moved — and it cannot be
 * reconstructed afterwards, because the information was never written down.
 *
 * ── WHAT IS DELIBERATELY NOT IN THIS FILE ───────────────────────────────────
 *
 * **No date of birth, nationality, ethnicity, religion, marital status,
 * children, gender, photograph or health field** (`ATS-6`). `over_eighteen` is
 * the only age fact, and it is a boolean rather than a date because a date is a
 * birth date wearing a different name.
 *
 * **No score, rank or rating column** (`ATS-19`). No automated ranking, scoring
 * or auto-rejection. If scoring is ever introduced it needs model version,
 * inputs and output logged per decision from day one — which is a table, a
 * migration and a policy, not a column somebody adds on a Friday.
 *
 * **No worker-payable fee anywhere** (`HR-16`). See `recruitmentCosts` at the
 * bottom of this file: the only representable bearer is the employer, enforced
 * by a database CHECK rather than by a validation message.
 */

// ── ATS-1: the requisition ──────────────────────────────────────────────────

/**
 * An approved vacancy.
 *
 * `public_slug` is what the careers site routes on, and it is separate from the
 * reference for a reason: the reference is an internal identity that must never
 * change, and the slug is a URL that a marketer will absolutely want to change.
 * Sharing one column would mean either an unstable identity or an unchangeable
 * URL.
 *
 * `approved_by_id` and `approved_at` exist because `ATS-1` names an approval
 * state, and an approval state with no record of who granted it is a status
 * badge. A requisition can only be published once both are set — see
 * `publishRequisition` in the domain layer.
 */
export const jobRequisitions = pgTable(
  "job_requisitions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** `REQ-2026-00001`, allocated by `app_next_reference`. */
    reference: varchar("reference", { length: 32 }).notNull(),
    /** The careers-site URL segment. Unique per tenant, mutable. */
    publicSlug: varchar("public_slug", { length: 120 }).notNull(),
    title: varchar("title", { length: 160 }).notNull(),
    /** A catalogue service slug — the same taxonomy dispatch matches on. */
    trade: varchar("trade", { length: 64 }).notNull(),
    grade: varchar("grade", { length: 24 }).notNull().default("technician"),
    headcount: integer("headcount").notNull().default(1),
    contractType: varchar("contract_type", { length: 16 }).notNull().default("full_time"),
    locationCity: varchar("location_city", { length: 80 }).notNull().default("Dubai"),
    locationArea: varchar("location_area", { length: 120 }),
    /**
     * Salary band in fils, both ends or neither.
     *
     * Published in `JobPosting` structured data when set, which makes it a
     * public commitment — so a half-filled band is refused by a CHECK rather
     * than indexed as "from AED 0".
     */
    salaryBandMinMinor: bigint("salary_band_min_minor", { mode: "number" }),
    salaryBandMaxMinor: bigint("salary_band_max_minor", { mode: "number" }),
    currency: currencyCol(),
    minExperienceYears: integer("min_experience_years"),
    /** Scheme names, e.g. `["HVAC Level 2", "Working at height"]`. */
    requiredCertifications: jsonb("required_certifications").notNull().default([]),
    summary: text("summary"),
    responsibilities: text("responsibilities"),
    /**
     * `ATS-6`. Physical requirements are stated **here**, in the advert, and
     * confirmed on the form with one yes/no about essential functions. They are
     * never a health question and there is nowhere on the applicant record to
     * record a health answer.
     */
    physicalRequirements: text("physical_requirements"),
    /**
     * `ATS-12`. How recently a rejection for this role makes a re-application
     * worth a second look before anybody spends time on it.
     *
     * Null means the platform default (`RECRUITMENT_COOLOFF_DEFAULT_DAYS`), 0
     * means no cool-off, and both are real answers rather than two spellings of
     * one. Per requisition because the right number genuinely differs by role:
     * a supervisor vacancy that runs a two-month process should not flag
     * somebody re-applying after six weeks, and a helper vacancy that turns
     * over monthly should.
     *
     * It produces a badge and nothing else. See `applications.cooloffFlag`.
     */
    cooloffDays: integer("cooloff_days"),
    opensAt: timestamp("opens_at", { withTimezone: true }),
    closesAt: timestamp("closes_at", { withTimezone: true }),
    hiringManagerUserId: uuid("hiring_manager_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("job_requisitions_reference_key").on(t.tenantId, t.reference),
    uniqueIndex("job_requisitions_slug_key").on(t.tenantId, t.publicSlug),
    index("job_requisitions_public_idx")
      .on(t.tenantId, t.status, t.closesAt)
      .where(sql`${t.deletedAt} is null`),
    index("job_requisitions_trade_idx").on(t.tenantId, t.trade, t.status),
  ],
);

/**
 * `ATS-7`. The pipeline, per requisition, capped at twelve.
 *
 * Per requisition rather than global because a supervisor vacancy and a helper
 * vacancy genuinely do not run the same process, and a single shared pipeline
 * is one nobody is allowed to edit. Capped because a twenty-stage pipeline is
 * how a board stops fitting on a screen and starts being maintained in a
 * spreadsheet instead.
 *
 * `stage_type` is the semantic and `name` is the label. Reporting groups on the
 * type, so a tenant can rename "Trade check" to "Bench test" without every
 * historical funnel chart splitting in two.
 */
export const requisitionStages = pgTable(
  "requisition_stages",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => jobRequisitions.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    stageType: varchar("stage_type", { length: 24 }).notNull(),
    sequence: integer("sequence").notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("requisition_stages_sequence_key").on(t.requisitionId, t.sequence),
    index("requisition_stages_requisition_idx").on(t.tenantId, t.requisitionId, t.sequence),
  ],
);

// ── ATS-11 / ATS-12 / ATS-18: the person ────────────────────────────────────

/**
 * A candidate is a person, once, however many times they apply.
 *
 * ── THE RETENTION COLUMNS (`ATS-18`) ────────────────────────────────────────
 *
 * `last_interaction_at` and `delete_after` are the pair the nightly purge in
 * `/api/cron/retention` needs, and they are shaped to match
 * `employees.delete_after` exactly — a `date`, nullable, with a partial index
 * on `delete_after is not null`, so the existing job's query plan works the
 * same way on this table as on that one.
 *
 * The default is six months from the last meaningful interaction. The clock is
 * reset by `touchCandidate`, not by any write: a retention sweep that updated
 * `last_interaction_at` would postpone its own deletion forever.
 *
 * `retention_basis` records *why* the row is still here, and it is the column
 * that keeps the three clocks from being confused for one another:
 *
 *   * `pre_contractual` — the default. Federal Decree-Law 45/2021 Article 4
 *     permits processing applicant data without consent for pre-contractual
 *     negotiation. That basis covers the recruitment purpose and **expires with
 *     it**, which is exactly why six months is short.
 *   * `consent` — talent-pool members (`ATS-13`). A different lawful basis,
 *     captured separately, withdrawable, and re-confirmed periodically.
 *   * `employee` — the candidate was hired. `HR-15`'s longer clock takes over
 *     and the employee record, not this row, is what the purge then reasons
 *     about.
 */
export const candidates = pgTable(
  "candidates",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    /** The primary identifier in this market (`ATS-3`). Always present. */
    phone: varchar("phone", { length: 24 }).notNull(),
    /**
     * `ATS-11`. Last nine digits, computed by the database.
     *
     * A generated column rather than an application-maintained one, because the
     * loose duplicate matcher is only as good as its worst writer: an importer
     * or a bulk action that forgets to populate it produces a candidate who
     * matches nobody, silently, and duplicate detection that fails silently is
     * worse than none.
     */
    phoneLocalDigits: varchar("phone_local_digits", { length: 9 }).generatedAlwaysAs(
      sql`right(regexp_replace(phone, '[^0-9]', '', 'g'), 9)`,
    ),
    email: varchar("email", { length: 200 }),
    primaryTrade: varchar("primary_trade", { length: 64 }).notNull(),
    grade: varchar("grade", { length: 24 }).notNull().default("technician"),
    experienceBand: varchar("experience_band", { length: 16 }).notNull(),
    /** `in_uae` | `outside_uae`. Logistics, never a screen (`ATS-5`). */
    currentLocation: varchar("current_location", { length: 16 }).notNull(),
    currentArea: varchar("current_area", { length: 120 }),
    hasDrivingLicence: boolean("has_driving_licence").notNull().default(false),
    /** `ATS-6`: the only age fact this system holds. Never a birth date. */
    overEighteen: boolean("over_eighteen").notNull().default(true),
    /**
     * `ATS-5`. Captured at Trade Check, from everyone shortlisted, used for
     * permit and timeline planning only. Null until then, and the public
     * application path has no argument that can set it.
     */
    visaStatus: varchar("visa_status", { length: 40 }),
    visaCurrentSponsor: varchar("visa_current_sponsor", { length: 160 }),
    /** Free-text recruiter notes. Never a score (`ATS-19`). */
    notes: text("notes"),
    /**
     * `ATS-11`. The older profile wins a merge; this points at the survivor.
     * Nothing is deleted by a merge — the merged row stays, pointing here, and
     * both activity feeds remain readable.
     */
    mergedIntoCandidateId: uuid("merged_into_candidate_id"),
    /** `ATS-17`. Set when the conversion runs, and it changes the clock. */
    convertedTechnicianId: uuid("converted_technician_id").references(() => technicians.id, {
      onDelete: "set null",
    }),

    // ── Retention (ATS-18) ──────────────────────────────────────────────────
    lastInteractionAt: timestamp("last_interaction_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** `pre_contractual` | `consent` | `employee`. */
    retentionBasis: varchar("retention_basis", { length: 24 }).notNull().default("pre_contractual"),
    /** Same shape as `employees.delete_after`, so one purge job serves both. */
    deleteAfter: date("delete_after"),
    ...timestamps,
  },
  (t) => [
    // DB-8. The two duplicate-detection lookups, both indexed, both by tenant.
    index("candidates_phone_local_idx").on(t.tenantId, t.phoneLocalDigits),
    index("candidates_email_idx").on(t.tenantId, sql`lower(${t.email})`),
    index("candidates_trade_idx").on(t.tenantId, t.primaryTrade, t.grade),
    // The purge's predicate, and nothing else. Partial so the index stays small
    // on a table where most live rows have a null date.
    index("candidates_retention_idx").on(t.deleteAfter).where(sql`${t.deleteAfter} is not null`),
  ],
);

/**
 * `ATS-4`. Certifications as structured records, never a text blob.
 *
 * `{scheme, certificate_no, level, issuing_body, issued_on, expires_on,
 * evidence}` — the shape the requirement names, and `expires_on` is the one
 * that matters. It is the field everyone forgets and the one that later blocks
 * a dispatch under `HR-9`, at which point the certificate is on file, unusable,
 * and nobody can say when it lapsed.
 *
 * ── WHY THIS IS NOT `technician_certifications` ─────────────────────────────
 *
 * `ATS-4` says the certification is modelled once, on the person, spanning ATS
 * and field operations. That is the right model and this is the honest
 * approximation of it: `technician_certifications` is keyed on `technician_id`
 * and is load-bearing for dispatch refusal today, so unifying the two is a
 * refactor of the dispatch path rather than a recruitment feature.
 *
 * What is guaranteed instead is that nothing is re-keyed: `hireCandidate`
 * copies every row here into `technician_certifications` with its expiry
 * intact, in the same transaction that creates the technician. The columns are
 * deliberately named to line up field-for-field so that copy is a mapping and
 * not a translation.
 */
export const candidateCertifications = pgTable(
  "candidate_certifications",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    scheme: varchar("scheme", { length: 120 }).notNull(),
    certificateNo: varchar("certificate_no", { length: 80 }),
    level: varchar("level", { length: 40 }),
    issuingBody: varchar("issuing_body", { length: 160 }),
    issuedOn: date("issued_on"),
    /** THE field. Not null, because a certificate with no expiry is a claim. */
    expiresOn: date("expires_on").notNull(),
    /** Object-storage key for the photograph of the card. */
    evidenceStorageKey: text("evidence_storage_key"),
    verifiedById: uuid("verified_by_id").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("candidate_certifications_candidate_idx").on(t.tenantId, t.candidateId),
    index("candidate_certifications_expiry_idx").on(t.tenantId, t.expiresOn),
  ],
);

/**
 * `ATS-9`. Uploaded files, with the scan gate on the row rather than in a
 * route.
 *
 * `scan_status` is a column and not an inference, because "has this been
 * scanned" must survive a page reload, a second server and a redeploy. The
 * download path refuses anything that is not `clean` or `skipped`, and
 * `skipped` means a deployment has explicitly stated it has no scanner — not
 * that one was tried and gave up.
 *
 * `sha256` is stored per upload so the same CV arriving twice is recognisable,
 * and so a file can be shown to be the one that was uploaded.
 */
export const candidateDocuments = pgTable(
  "candidate_documents",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    /** Which application it arrived with, when it arrived with one. */
    applicationId: uuid("application_id"),
    /** `cv` | `certificate` | `other`. No `id` kind: no identity documents pre-offer. */
    kind: varchar("kind", { length: 24 }).notNull(),
    storageKey: text("storage_key").notNull(),
    filename: varchar("filename", { length: 200 }),
    contentType: varchar("content_type", { length: 80 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: varchar("sha256", { length: 64 }).notNull(),
    scanStatus: varchar("scan_status", { length: 16 }).notNull().default("pending"),
    /**
     * When the asynchronous sweep took this row, and the reason two overlapping
     * sweeps cannot both scan it. Claim and verdict happen in one transaction,
     * so a run that dies mid-scan rolls this back and the next run picks the
     * document up.
     *
     * Claimed *and* still `pending` is the third meaning, and it is deliberate:
     * a document the sweep could not finish — the stored object was missing —
     * stays undownloadable, stops being retried forever, and is counted
     * separately by `/api/cron/scan` so a person can look at it.
     */
    scanClaimedAt: timestamp("scan_claimed_at", { withTimezone: true }),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    scannerNote: varchar("scanner_note", { length: 200 }),
    /** `ATS-10`. Failure is ordinary; the original file is retained regardless. */
    parseStatus: varchar("parse_status", { length: 16 }).notNull().default("not_attempted"),
    parserVersion: varchar("parser_version", { length: 40 }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [
    index("candidate_documents_candidate_idx").on(t.tenantId, t.candidateId),
    index("candidate_documents_scan_idx").on(t.tenantId, t.scanStatus),
    index("candidate_documents_unclaimed_idx").on(t.tenantId, t.uploadedAt),
  ],
);

// ── ATS-12 / ATS-16: the application ────────────────────────────────────────

/**
 * One person applying for one role, once.
 *
 * ── THE OUTCOME COLUMNS ARE THE POINT OF THIS TABLE ─────────────────────────
 *
 * `ATS-16` — every applicant receives an outcome, target 100% (`G14`). Around
 * 65% of applicants never or rarely hear back, and roughly 80% say they would
 * not reapply to a company that ghosted them; in a referral-driven trades
 * market that compounds directly into hiring cost.
 *
 * The failure mode is not that recruiters are careless. It is that "we did not
 * send this person an outcome" is, in every ATS that was not built to prevent
 * it, **not a state the system can see**. Nothing is written when nothing
 * happens, so nothing can be queried, so nothing can be reported, so it depends
 * on somebody remembering.
 *
 * These five columns make the absence visible:
 *
 *   * `outcome_due_at` — set at insert, from the promise the applicant was
 *     shown on the confirmation screen. The screen and the counter read the
 *     same number.
 *   * `outcome_scheduled_at` / `outcome_message` — the message is composed when
 *     the decision is made, and sits in a cancellable window (`ATS-15`).
 *   * `outcome_cancelled_at` — the window being used.
 *   * `outcome_sent_at` — the only column that closes the obligation.
 *
 * So "owed an outcome" is `status <> 'active' and outcome_sent_at is null`, and
 * "overdue" adds `outcome_due_at < now()`. Both are one index scan, both appear
 * on the pipeline screen, and neither depends on anybody remembering anything.
 */
export const applications = pgTable(
  "applications",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** `APP-2026-00412`, allocated by `app_next_reference`. */
    reference: varchar("reference", { length: 32 }).notNull(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    requisitionId: uuid("requisition_id")
      .notNull()
      .references(() => jobRequisitions.id, { onDelete: "restrict" }),

    // ── Where ───────────────────────────────────────────────────────────────
    currentStageId: uuid("current_stage_id").references(() => requisitionStages.id, {
      onDelete: "set null",
    }),
    stageEnteredAt: timestamp("stage_entered_at", { withTimezone: true }).notNull().defaultNow(),

    // ── Whether ─────────────────────────────────────────────────────────────
    /** `active` | `archived` | `hired`. */
    status: varchar("status", { length: 16 }).notNull().default("active"),

    // ── Why, and where it died ──────────────────────────────────────────────
    dispositionReasonCode: varchar("disposition_reason_code", { length: 48 }),
    dispositionNote: text("disposition_note"),
    /**
     * The stage the application was in when it ended.
     *
     * Looks redundant next to `current_stage_id` and is not: funnel conversion
     * is unanswerable without it, and it cannot be reconstructed later because
     * the fact was never recorded anywhere else.
     */
    archivedAtStageId: uuid("archived_at_stage_id").references(() => requisitionStages.id, {
      onDelete: "set null",
    }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    // ── ATS-8: who is blocking this ─────────────────────────────────────────
    /** `none` | `candidate` | `us`. Falls back to time-in-stage when `none`. */
    blockedOn: varchar("blocked_on", { length: 16 }).notNull().default("none"),
    blockedNote: varchar("blocked_note", { length: 200 }),
    blockedSince: timestamp("blocked_since", { withTimezone: true }),

    // ── What they told us ───────────────────────────────────────────────────
    availability: varchar("availability", { length: 24 }),
    /** `yes` | `discuss` — a job question, never a health question (`ATS-6`). */
    essentialFunctions: varchar("essential_functions", { length: 16 }),
    source: varchar("source", { length: 32 }).notNull().default("careers_site"),

    // ── ATS-16: the outcome obligation ──────────────────────────────────────
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    /** Immediate acknowledgement (`ATS-14`). Distinct from the outcome. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    /** The promise, as a timestamp. Set at insert, never null. */
    outcomeDueAt: timestamp("outcome_due_at", { withTimezone: true }).notNull(),
    /** When the composed message becomes sendable — `ATS-15`'s delay. */
    outcomeScheduledAt: timestamp("outcome_scheduled_at", { withTimezone: true }),
    outcomeMessage: text("outcome_message"),
    outcomeChannel: varchar("outcome_channel", { length: 16 }),
    outcomeCancelledAt: timestamp("outcome_cancelled_at", { withTimezone: true }),
    /** The only column that discharges the obligation. */
    outcomeSentAt: timestamp("outcome_sent_at", { withTimezone: true }),
    outcomeNotificationId: uuid("outcome_notification_id"),

    /**
     * The applicant's own tracking link (`/careers/application/<token>`).
     *
     * A random token and no account, because an account is a password a
     * tradesperson will not create for one application. Unique, unguessable,
     * and it grants read access to exactly one application.
     */
    statusToken: varchar("status_token", { length: 64 }).notNull(),

    // ── ATS-12: the cool-off flag ───────────────────────────────────────────
    /**
     * Set when this application arrived within the requisition's cool-off
     * window of a *rejection* for the same role.
     *
     * ── THIS IS A NOTE FOR A HUMAN AND CANNOT BECOME ANYTHING ELSE ──────────
     *
     * `ATS-19` forbids automated rejection and `ATS-5` forbids automated
     * filtering, so the design has to make those impossible rather than
     * discouraged. Three properties do that, and all three are structural:
     *
     *   * It is computed in `app_public_submit_application` **after** the
     *     `INSERT` has already returned an id. There is no ordering in which it
     *     could have decided whether to create the application, because the
     *     application exists before the flag is calculated.
     *   * Nothing in the creation, matching or offer path reads it. It appears
     *     in no `WHERE` clause outside a staff screen.
     *   * `app_public_application_status` does not return it. The applicant is
     *     never told, because telling them would make it a decision.
     *
     * A recruiter who sees the badge is free to conclude nothing at all from
     * it. That is the whole intended behaviour.
     */
    cooloffFlag: boolean("cooloff_flag").notNull().default(false),
    /**
     * The prior application the flag refers to.
     *
     * A reference and not a bare boolean, matching `archivedAtStageId` and
     * `mergedIntoCandidateId`: "flagged" with nothing to click through to is a
     * red dot that gets ignored by the third time, and a CHECK refuses the flag
     * without it.
     *
     * A withdrawal is deliberately never the referent. The candidate deciding
     * they were no longer available is not a rejection, and a badge implying we
     * turned them down would misdescribe to staff what actually happened.
     */
    cooloffOfApplicationId: uuid("cooloff_of_application_id"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("applications_reference_key").on(t.tenantId, t.reference),
    uniqueIndex("applications_status_token_key").on(t.statusToken),
    /**
     * `ATS-12`. One live application per person per role.
     *
     * Partial, so re-applying after an archived attempt is permitted — which is
     * the behaviour `ATS-12` asks for, with the prior outcome surfaced rather
     * than the new application refused.
     */
    uniqueIndex("applications_live_key")
      .on(t.candidateId, t.requisitionId)
      .where(sql`${t.status} = 'active'`),
    index("applications_pipeline_idx").on(t.tenantId, t.requisitionId, t.status, t.currentStageId),
    index("applications_candidate_idx").on(t.tenantId, t.candidateId),
    /**
     * The `ATS-16` index. Covers the whole accountability query: closed
     * applications with no outcome sent, oldest first.
     */
    index("applications_outcome_owed_idx")
      .on(t.tenantId, t.outcomeDueAt)
      .where(sql`${t.outcomeSentAt} is null`),
    // `ATS-12`. Partial, because on a real pipeline almost every row is false.
    index("applications_cooloff_idx").on(t.tenantId, t.requisitionId).where(sql`${t.cooloffFlag}`),
  ],
);

/**
 * The activity feed (`ATS-11`, wireframe §5.2).
 *
 * Every stage change, message, upload and merge lands here. `ATS-11` requires
 * that nothing is ever destroyed by a merge — "everything lands in the activity
 * feed" — which only holds if the feed is written by the same transaction that
 * does the thing, so every domain function here writes its event inline rather
 * than relying on a trigger it might not be covered by.
 */
export const applicationEvents = pgTable(
  "application_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /** `applied` | `stage_changed` | `message_sent` | `document_added` | … */
    eventType: varchar("event_type", { length: 32 }).notNull(),
    fromStageId: uuid("from_stage_id"),
    toStageId: uuid("to_stage_id"),
    note: text("note"),
    payload: jsonb("payload").notNull().default({}),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** `user` | `candidate` | `system`. */
    actorKind: varchar("actor_kind", { length: 16 }).notNull().default("user"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("application_events_application_idx").on(t.tenantId, t.applicationId, t.occurredAt)],
);

// ── ATS-14: the interview, and where to stand ───────────────────────────────

/**
 * A scheduled interview or site trial, with the logistics on the row.
 *
 * ── WHY THIS TABLE EXISTS AT ALL ────────────────────────────────────────────
 *
 * Until it did, nothing in this system recorded that a candidate had been asked
 * to come anywhere: no time, no place, no record that a message was sent. The
 * arrangement lived in a WhatsApp thread on one person's phone, which is also
 * where "bring your working-at-height card" lived — which is why the candidate
 * turns up without it and the trade check is rebooked.
 *
 * `ATS-14` names four things the confirmation must carry: the site address,
 * parking, PPE and what to bring. They are four columns and not one details
 * blob, because a blob is what gets half-filled. The person typing it remembers
 * the address, forgets the hard hat, and nothing anywhere says a field is
 * missing.
 *
 * ── THE FOUR REMINDER COLUMNS ARE TWO PAIRS ─────────────────────────────────
 *
 *   * `reminder24hAt` / `reminder2hAt` — **when** each reminder is due. Null
 *     means the window had already passed when the interview was booked: an
 *     interview arranged for three hours from now never had a 24-hour reminder
 *     to miss. Null says that honestly; stamping the sent column to keep the
 *     queue tidy would claim a message that never existed, and a CHECK refuses
 *     it.
 *   * `reminder24hSentAt` / `reminder2hSentAt` — the claim. Written by a
 *     conditional `UPDATE ... WHERE ... IS NULL` in the same transaction that
 *     enqueues the message, so two overlapping cron runs cannot both send.
 *
 * ── AND WHY THERE IS NO RESCHEDULE TOKEN ────────────────────────────────────
 *
 * `applications.statusToken` already is one. It is 64 unguessable characters
 * held by exactly one person — the candidate whose interview this is — and an
 * interview belongs to exactly one application, so a second token would grant a
 * strict subset of the first, to the same holder, for the same purpose. What it
 * would add is a second secret to leak and a second lost-link support call.
 *
 * So `rescheduleRequestedAt` is written through
 * `app_public_request_interview_reschedule`, behind that existing token. It
 * records an ask and never moves anything: a candidate silently moving a site
 * trial a supervisor has blocked two hours out for is not a feature.
 */
export const interviews = pgTable(
  "interviews",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    /**
     * `interview` | `site_trial`.
     *
     * One table, because the logistics are identical. Two values, because the
     * candidate needs to know which one they are coming to: one wants a shirt,
     * the other wants boots and a hard hat.
     */
    kind: varchar("kind", { length: 24 }).notNull().default("interview"),
    /** `scheduled` | `cancelled` | `completed`. */
    status: varchar("status", { length: 16 }).notNull().default("scheduled"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    durationMinutes: integer("duration_minutes").notNull().default(60),
    locationName: varchar("location_name", { length: 160 }).notNull(),
    locationAddress: text("location_address").notNull(),
    locationArea: varchar("location_area", { length: 120 }),
    locationMapUrl: text("location_map_url"),
    parkingNotes: text("parking_notes"),
    /** A list, so the confirmation and the reminder render the same items. */
    ppeRequired: jsonb("ppe_required").notNull().default([]),
    bringNotes: text("bring_notes"),
    /**
     * Who to ask for, and the number to call when the gate is shut. The single
     * most common reason a trade candidate turns around and goes home.
     */
    contactName: varchar("contact_name", { length: 160 }),
    contactPhone: varchar("contact_phone", { length: 24 }),
    confirmationSentAt: timestamp("confirmation_sent_at", { withTimezone: true }),
    confirmationNotificationId: uuid("confirmation_notification_id"),
    reminder24hAt: timestamp("reminder_24h_at", { withTimezone: true }),
    reminder24hSentAt: timestamp("reminder_24h_sent_at", { withTimezone: true }),
    reminder2hAt: timestamp("reminder_2h_at", { withTimezone: true }),
    reminder2hSentAt: timestamp("reminder_2h_sent_at", { withTimezone: true }),
    /** The candidate's ask, behind the application's own status token. */
    rescheduleRequestedAt: timestamp("reschedule_requested_at", { withTimezone: true }),
    rescheduleRequestNote: varchar("reschedule_request_note", { length: 400 }),
    rescheduledCount: integer("rescheduled_count").notNull().default(0),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancellationReason: varchar("cancellation_reason", { length: 200 }),
    scheduledById: uuid("scheduled_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("interviews_application_idx").on(t.tenantId, t.applicationId, t.scheduledAt),
    // The two cron predicates, each its own partial index. The sweep runs every
    // fifteen minutes for ever, on a table where all but a handful of rows are
    // already sent or already past.
    index("interviews_reminder_24h_idx")
      .on(t.reminder24hAt)
      .where(
        sql`${t.status} = 'scheduled' and ${t.reminder24hAt} is not null and ${t.reminder24hSentAt} is null and ${t.deletedAt} is null`,
      ),
    index("interviews_reminder_2h_idx")
      .on(t.reminder2hAt)
      .where(
        sql`${t.status} = 'scheduled' and ${t.reminder2hAt} is not null and ${t.reminder2hSentAt} is null and ${t.deletedAt} is null`,
      ),
    index("interviews_reschedule_requested_idx")
      .on(t.tenantId, t.rescheduleRequestedAt)
      .where(sql`${t.rescheduleRequestedAt} is not null`),
  ],
);

/**
 * `ATS-13`. The talent pool, which is a different thing from the pipeline.
 *
 * A candidate is *in a pool* — by trade, by area, by certification status — not
 * *in a stage*. Modelling it as a pipeline stage is the mistake that makes a
 * pool useless: it puts people who are not being considered for anything into a
 * column that is supposed to represent live work.
 *
 * Its own lawful basis, and this table is where that basis lives.
 * `consent_captured_at` is the timestamp the consent was given, and
 * `reconfirm_due_at` is what stops the pool rotting: a tradesperson's
 * availability and certification validity go stale in weeks, so a pool nobody
 * re-confirms is a list of people who have all found other work.
 */
export const talentPoolMembers = pgTable(
  "talent_pool_members",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    candidateId: uuid("candidate_id")
      .notNull()
      .references(() => candidates.id, { onDelete: "cascade" }),
    /** Usually the trade slug. A person can sit in several pools. */
    poolKey: varchar("pool_key", { length: 64 }).notNull(),
    /** Not null. There is no way to add somebody without recording consent. */
    consentCapturedAt: timestamp("consent_captured_at", { withTimezone: true }).notNull(),
    /** Where the consent came from: `application_form` | `staff_recorded`. */
    consentSource: varchar("consent_source", { length: 32 }).notNull(),
    consentWithdrawnAt: timestamp("consent_withdrawn_at", { withTimezone: true }),
    reconfirmDueAt: timestamp("reconfirm_due_at", { withTimezone: true }).notNull(),
    reconfirmedAt: timestamp("reconfirmed_at", { withTimezone: true }),
    /** `ATS-13`: archived from a late stage means a strong prospect. */
    addedReason: varchar("added_reason", { length: 48 }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("talent_pool_members_key").on(t.candidateId, t.poolKey),
    index("talent_pool_members_pool_idx").on(t.tenantId, t.poolKey, t.reconfirmDueAt),
  ],
);

/**
 * `HR-16`. Hiring costs, and the reason this table looks the way it does.
 *
 * Article 6 of Federal Decree-Law 33/2021 prohibits charging or collecting
 * recruitment and employment fees from a worker, directly or indirectly. The
 * PRD asks for that to be structurally impossible rather than validated.
 *
 * So: there is no `charged_to_worker` column, no `recoverable` flag, no
 * `deduct_from_salary` amount and no `worker` value anywhere. `borne_by` exists
 * and accepts exactly one value, `employer`, enforced by a CHECK constraint in
 * migration 0014. A worker-borne recruitment cost is not a row that fails
 * validation; it is a row that cannot be written by any path — an importer, a
 * bulk action, a future integration, or a direct SQL statement typed during an
 * incident.
 *
 * The column is kept rather than dropped precisely *because* it is single
 * valued. A table with no bearer column asserts nothing; this one asserts, in
 * the schema, in a form a reviewer and the database both check, that the
 * employer pays.
 */
export const recruitmentCosts = pgTable(
  "recruitment_costs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    requisitionId: uuid("requisition_id").references(() => jobRequisitions.id, {
      onDelete: "set null",
    }),
    candidateId: uuid("candidate_id").references(() => candidates.id, { onDelete: "set null" }),
    kind: varchar("kind", { length: 32 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
    currency: currencyCol(),
    /** CHECK-ed to `'employer'`. There is no second permitted value. */
    borneBy: varchar("borne_by", { length: 16 }).notNull().default("employer"),
    incurredOn: date("incurred_on").notNull(),
    note: text("note"),
    recordedById: uuid("recorded_by_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("recruitment_costs_requisition_idx").on(t.tenantId, t.requisitionId),
    index("recruitment_costs_candidate_idx").on(t.tenantId, t.candidateId),
  ],
);
