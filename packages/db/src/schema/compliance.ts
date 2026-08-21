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
import { idCol, timestamps } from "./_shared";
import { tenants, users } from "./tenancy";
import { technicians } from "./workforce";

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
