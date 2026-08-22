/**
 * Development seed.
 *
 * Runs against DATABASE_ADMIN_URL (the superuser), not the application role.
 * That is deliberate and it mirrors production: seeding and migrating are
 * administrative operations that legitimately need to write across tenants,
 * while the application connects as a NOBYPASSRLS role and never can.
 *
 *   npm run db:seed
 *
 * Two tenants are created on purpose. A single-tenant seed cannot demonstrate
 * that isolation works - you need a second tenant's data present to prove the
 * first tenant cannot see it.
 */

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { hash } from "@node-rs/argon2";
import * as schema from "./schema";
import { STANDARD_DISPOSITION_REASONS, STANDARD_JOB_OUTCOMES } from "./domain/reference";
import {
  STANDARD_JOB_SHEET_AMENDMENT_REASONS,
  STANDARD_PHOTO_EXEMPTION_REASONS,
  purgeJobSheets,
} from "./domain/jobcard";
// M3 (`CON-13`). Same reasoning as the HR import below: a separate statement,
// because several streams are editing this file at once.
import { and, eq } from "drizzle-orm";
import { STANDARD_ASSET_CATEGORIES } from "./domain/assets";
// M3 (`CON-11`). A separate import statement for the same reason the one above
// is: these vocabularies belong to the tender module and importing them through
// the package barrel would drag the whole domain layer into the seed.
import {
  STANDARD_TENDER_SOURCES,
  STANDARD_TENDER_OUTCOME_REASONS,
} from "./domain/tenders";
// M5 (`PRJ-6`, `PRJ-7`). A separate import statement for the same reason the
// M3 and M10 ones above are separate: several streams are editing this file,
// and a whole added line merges where an edited line inside a list does not.
import { STANDARD_PERMIT_AUTHORITIES, STANDARD_SNAG_TRADES } from "@meridian/core";
import { dubaiDateKey } from "@meridian/core";
import {
  computeSlaDeadlines,
  company,
  planPpmVisits,
  exclusionDefinition,
  STANDARD_AMC_EXCLUSIONS,
  DEFAULT_PIPELINE,
  type JobPriority,
} from "@meridian/core";

// M10 (`HR-4`, `HR-6`, `HR-7`, `HR-8`, `HR-17`). A separate import statement
// rather than extra names on the one above, deliberately: several streams are
// editing this file, and a whole added line merges where an edited line inside
// an existing list does not.
import {
  today,
  addDays,
  addMonths,
  startOfMonth,
  toDecimalString,
  hourlyBasicMinor,
  overtimeAmountMinor,
  PAY_BAND_BASIS_POINTS,
} from "@meridian/core";

// The db package loads the root .env on first connect; do the same here so
// `npm run db:seed` works without the caller sourcing it by hand.
import "./index";

const adminUrl =
  process.env["DATABASE_ADMIN_URL"] ?? process.env["DATABASE_URL"] ?? "postgres://localhost:5432/meridian_dev";

const client = postgres(adminUrl, { max: 1 });
const db = drizzle(client, { schema });

const DEV_PASSWORD = "MeridianDev2026!";
const ARGON2ID = 2;

/** Deterministic ids so re-seeding is idempotent and links stay stable. */
const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}
function ahead(ms: number): Date {
  return new Date(Date.now() + ms);
}

async function main(): Promise<void> {
  console.log(`Seeding ${adminUrl.replace(/:[^:@]*@/, ":***@")}`);

  // Order matters: children before parents. Anything added to the schema that
  // references a seeded row has to be listed here, or the clear-down fails on a
  // foreign key. Commerce tables come first because they reference both jobs
  // and customers.
  console.log("  clearing existing data");

  // FLD-14. Before everything below, and through its own function rather than
  // the loop, because `0037` refuses a DELETE on `job_sheets` unless the
  // transaction has said it means to purge — and a seed run that took a signed
  // job sheet with it by accident is exactly what that refusal is for.
  //
  // It has to go first for a second reason: a sealed sheet locks the job card,
  // and the triggers `0037` puts on `job_attachments`, `job_materials`,
  // `job_card_declarations`, `job_fault_codes` and `job_signoffs` refuse every
  // write — deletes included — while one exists. Clearing the sheets is what
  // unlocks the rest of this list.
  await db.transaction(async (tx) => {
    await purgeJobSheets(tx);
  });

  for (const table of [
    // Counters go first: a stale counter would keep allocating above the
    // references this seed writes, which is harmless but makes the seeded
    // data confusing to read.
    schema.referenceCounters,
    // M5. Before `invoices`, and that ordering is load-bearing rather than
    // tidy: `project_retention.invoice_id` is ON DELETE RESTRICT, so deleting
    // an invoice with retention held against it fails outright. It is restrict
    // on purpose — retention is a claim on a specific document, and a claim
    // whose document has vanished is a balance nobody can evidence.
    //
    // Also before `customers`, which `projects.customer_id` restricts against,
    // and before `subcontractors`, which `project_subcontracts` restricts
    // against. Everything else here cascades from `projects` or from `tenants`
    // and is named anyway, because this file's rule is that anything it writes
    // is listed — `credit_notes` is the precedent for what happens otherwise.
    schema.projectCosts,
    schema.projectRetention,
    schema.projectSubcontracts,
    schema.projectSnags,
    schema.snagTrades,
    schema.projectPermits,
    schema.permitAuthorities,
    schema.projectMilestones,
    schema.projectPhaseJobs,
    schema.projectPhases,
    schema.projects,
    schema.labourCostRates,
    // Credit notes before invoices, because a credit note references the
    // invoice it corrects (Article 60) and that reference is the whole point of
    // the document. Omitting these two made `db:seed` fail on a foreign key for
    // anyone whose database had ever had a credit note raised in it — which is
    // to say, anyone who had exercised the feature.
    schema.creditNoteLines,
    schema.creditNotes,
    schema.payments,
    schema.invoiceLines,
    schema.invoices,
    schema.quoteLines,
    schema.quotes,
    // M3 (`CON-11`, `CON-12`). Children before parents: a pack references the
    // tender it was assembled for, and the tender references both vocabularies
    // with ON DELETE restrict — which does not cascade at all, so leaving the
    // vocabularies out of this list would fail the clear-down on a foreign key
    // the moment anybody had recorded a tender. `credit_notes` is the precedent
    // and it is why this file names everything it writes.
    schema.tenderPacks,
    schema.tenderProperties,
    schema.tenders,
    schema.tenderOutcomeReasons,
    schema.tenderOpportunitySources,
    // M3. Children of `contracts` before it. They all cascade, so deleting the
    // parent alone would work — but this file's own rule is that anything
    // referencing a seeded row is listed, and relying on a cascade here would
    // make the next addition that does not cascade fail confusingly.
    schema.contractRenewalNotices,
    schema.contractDocuments,
    schema.contractExclusions,
    schema.contractEntitlements,
    schema.contractTerms,
    schema.contractVisits,
    schema.contractProperties,
    schema.contracts,
    schema.communications,
    schema.leads,
    // After `leads`, which references it. `leads.disposition_reason_id` is ON
    // DELETE restrict against this table, which does not cascade at all, so
    // clearing it before the leads that cite it would fail the clear-down on a
    // foreign key the moment anybody had closed a lead. `credit_notes` is the
    // precedent, and it is why this file names everything it writes.
    schema.leadDispositionReasons,
    // Before the jobs and visits it hangs off. It cascades from both, so the
    // clear-down would work without it — but this file's rule is that anything
    // referencing a seeded row is named, and its reference to `fault_codes` is
    // ON DELETE restrict, which does not cascade at all.
    schema.jobFaultCodes,
    // JOB-15. Before the jobs and visits it hangs off, and before the reason
    // vocabulary it cites — that reference is ON DELETE restrict, which does
    // not cascade at all, so leaving it out would fail the clear-down here.
    schema.jobCardDeclarations,
    // FLD-14. After `job_sheets`, which is purged above and which references
    // this vocabulary ON DELETE restrict — that does not cascade at all, so
    // listing it here without the purge above would fail the clear-down the
    // first time anybody had amended a sheet. `credit_notes` is the precedent.
    schema.jobSheetAmendmentReasons,
    schema.jobEvents,
    schema.jobVisits,
    schema.jobReports,
    schema.jobMaterials,
    schema.jobAttachments,
    schema.jobSignoffs,
    schema.jobs,
    // After `job_card_declarations`, which references it. It cascades from
    // `tenants` and would be cleared anyway; it is named because this file's
    // rule is that everything it writes is listed.
    schema.jobPhotoExemptionReasons,
    // M10, children first. Every one of these cascades from `tenants`, which is
    // last in this list — so the clear-down would work without them. They are
    // named anyway, because this file's rule is that anything it writes is
    // listed, and the next addition that does NOT cascade would otherwise fail
    // here confusingly. `credit_notes` is the precedent: it was missing, it did
    // not cascade, and `db:seed` broke for everyone who had ever raised one.
    schema.salaryDeductions,
    schema.wagePayments,
    schema.wageCycles,
    schema.overtimeRecords,
    schema.leaveBalances,
    schema.employmentContractTerms,
    // HR-13/HR-19, before the `employees` rows they hang off.
    // `subcontractor_workers` cascades from its supplier, and is named anyway
    // because this file's rule is that everything it writes is listed.
    schema.gratuitySettlements,
    schema.subcontractorWorkers,
    schema.subcontractors,
    schema.employeeDocuments,
    // Before `technicians`: `employees.technician_id` is ON DELETE SET NULL, so
    // deleting technicians first would leave employment records behind with a
    // null link — rows that no longer block a dispatch and are invisible to
    // every query in `domain/compliance.ts`.
    schema.employees,
    schema.leaveRequests,
    schema.technicianSkills,
    schema.technicians,
    schema.assets,
    // After `assets`, which references it. `asset_categories` cascades from
    // `tenants` and would be cleared anyway; it is named because this file's
    // rule is that everything it writes is listed, and the next addition that
    // does not cascade would otherwise fail here confusingly.
    schema.assetCategories,
    schema.propertyUnits,
    schema.properties,
    schema.customerContacts,
    schema.customers,
    schema.sessions,
    schema.memberships,
    schema.users,
    schema.tenants,
  ]) {
    await db.delete(table);
  }

  const passwordHash = await hash(DEV_PASSWORD, {
    algorithm: ARGON2ID,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  // ── Tenants ────────────────────────────────────────────────────────────────
  await db.insert(schema.tenants).values([
    {
      id: T1,
      // The operating company's identity comes from configuration (`ADM-9`),
      // so the seeded tenant row matches what the site and the documents show.
      // A tenant row saying one thing while the footer says another is the
      // small inconsistency that becomes "which name is the real one?" on an
      // invoice.
      slug: process.env["PUBLIC_TENANT_SLUG"] ?? "meridian",
      legalName: company.legalName,
      brandName: company.brandName,
      countryCode: "AE",
      defaultCurrency: "AED",
      timezone: "Asia/Dubai",
    },
    {
      id: T2,
      slug: "gulf-property-care",
      legalName: "Gulf Property Care LLC",
      brandName: "Gulf Property Care",
      countryCode: "AE",
      defaultCurrency: "AED",
      timezone: "Asia/Dubai",
    },
  ]);

  // ── Users and memberships ──────────────────────────────────────────────────
  const staff = [
    { email: "omar@meridianfm.example", name: "Omar Al Suwaidi", role: "owner" as const },
    { email: "rania@meridianfm.example", name: "Rania Haddad", role: "operations_manager" as const },
    { email: "yusuf@meridianfm.example", name: "Yusuf Karim", role: "dispatcher" as const },
    { email: "priya@meridianfm.example", name: "Priya Nair", role: "accountant" as const },
    { email: "bilal@meridianfm.example", name: "Bilal Chaudhry", role: "technician" as const },
    // M9. The `hr` role existed in the RBAC table and had no account, which is
    // why nobody noticed it had been left out of STAFF_ROLES and could not
    // reach a single screen. It owns /recruitment and /workforce.
    { email: "layla@meridianfm.example", name: "Layla Mansour", role: "hr" as const },
  ];

  const userIds = new Map<string, string>();
  for (const s of staff) {
    const [row] = await db
      .insert(schema.users)
      .values({ email: s.email, fullName: s.name, passwordHash, emailVerifiedAt: new Date() })
      .returning({ id: schema.users.id });
    if (!row) throw new Error(`failed to insert user ${s.email}`);
    userIds.set(s.email, row.id);
    await db.insert(schema.memberships).values({
      tenantId: T1,
      userId: row.id,
      role: s.role,
      acceptedAt: new Date(),
    });
  }

  // Second tenant's user. Same password, different tenant - used to prove that
  // logging in as this user cannot see tenant 1's jobs.
  const [otherUser] = await db
    .insert(schema.users)
    .values({
      email: "hana@gulfpropertycare.example",
      fullName: "Hana Al Zaabi",
      passwordHash,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!otherUser) throw new Error("failed to insert second-tenant user");
  await db.insert(schema.memberships).values({
    tenantId: T2,
    userId: otherUser.id,
    role: "owner",
    acceptedAt: new Date(),
  });

  // A customer-portal user, bound to one customer. Exists in the seed because
  // the portal's whole security property is that this account can see BAYOA's
  // records and nothing else - which cannot be demonstrated without it.
  const [portalUser] = await db
    .insert(schema.users)
    .values({
      email: "fatima@baytower.example",
      fullName: "Fatima Suleiman",
      passwordHash,
      emailVerifiedAt: new Date(),
    })
    .returning({ id: schema.users.id });
  if (!portalUser) throw new Error("failed to insert portal user");
  userIds.set("fatima@baytower.example", portalUser.id);

  console.log(`  ${staff.length + 2} users`);

  // ── Technicians ────────────────────────────────────────────────────────────
  const technicianSpecs = [
    { code: "T-001", name: "Bilal Chaudhry", trade: "hvac-ac-maintenance", grade: "senior_technician", city: "Dubai", lat: 25.076, lng: 55.139, user: "bilal@meridianfm.example" },
    { code: "T-002", name: "Ganesh Pillai", trade: "plumbing", grade: "technician", city: "Dubai", lat: 25.187, lng: 55.276 },
    { code: "T-003", name: "Arun Verma", trade: "electrical", grade: "senior_technician", city: "Dubai", lat: 25.204, lng: 55.271 },
    { code: "T-004", name: "Mahmoud Fathy", trade: "hvac-ac-maintenance", grade: "technician", city: "Dubai", lat: 25.113, lng: 55.201 },
    { code: "T-005", name: "Rajesh Kumar", trade: "plumbing", grade: "supervisor", city: "Dubai", lat: 25.267, lng: 55.311 },
    { code: "T-006", name: "Imran Sheikh", trade: "carpentry", grade: "technician", city: "Dubai", lat: 25.045, lng: 55.220 },
    { code: "T-007", name: "Noor Abbas", trade: "cleaning", grade: "technician", city: "Sharjah", lat: 25.346, lng: 55.421 },
    { code: "T-008", name: "Vikram Singh", trade: "electrical", grade: "technician", city: "Abu Dhabi", lat: 24.454, lng: 54.377 },
  ];

  const techIds = new Map<string, string>();
  for (const t of technicianSpecs) {
    const [row] = await db
      .insert(schema.technicians)
      .values({
        tenantId: T1,
        employeeCode: t.code,
        fullName: t.name,
        phone: `+9715${String(1000000 + technicianSpecs.indexOf(t) * 13457).slice(0, 7)}`,
        primaryTrade: t.trade,
        grade: t.grade,
        employment: "direct",
        baseCity: t.city,
        baseLat: t.lat,
        baseLng: t.lng,
        hourlyCost: "45.00",
        hourlyCharge: "120.00",
        userId: t.user ? (userIds.get(t.user) ?? null) : null,
        joinedOn: ago(400 * DAY),
      })
      .returning({ id: schema.technicians.id });
    if (!row) throw new Error(`failed to insert technician ${t.code}`);
    techIds.set(t.code, row.id);

    await db.insert(schema.technicianSkills).values({
      tenantId: T1,
      technicianId: row.id,
      serviceSlug: t.trade,
      proficiency: t.grade === "supervisor" ? 5 : t.grade === "senior_technician" ? 4 : 3,
      verifiedAt: ago(300 * DAY),
    });
    // Most technicians can also take handyman work. That is what makes the
    // dispatch matcher interesting rather than a lookup on primary trade.
    await db.insert(schema.technicianSkills).values({
      tenantId: T1,
      technicianId: row.id,
      serviceSlug: "handyman",
      proficiency: 3,
      verifiedAt: ago(300 * DAY),
    });
  }
  console.log(`  ${technicianSpecs.length} technicians`);

  // ── Customers and properties ───────────────────────────────────────────────
  const customerSpecs = [
    { code: "ACME", name: "Marasi Developments", industry: "Property developer", terms: 45 },
    { code: "BAYOA", name: "Bay Tower Owners Association", industry: "Owners association", terms: 30 },
    { code: "SERAI", name: "Serai Hotel Group", industry: "Hotels & hospitality", terms: 30 },
    { code: "PRIV", name: "S. Rahman", industry: "Private individual", terms: 0, isCompany: false },
  ];

  const customerIds = new Map<string, string>();
  for (const c of customerSpecs) {
    const [row] = await db
      .insert(schema.customers)
      .values({
        tenantId: T1,
        code: c.code,
        name: c.name,
        industry: c.industry,
        isCompany: c.isCompany ?? true,
        paymentTermsDays: c.terms,
        billingEmail: `accounts@${c.code.toLowerCase()}.example`,
        accountManagerId: userIds.get("rania@meridianfm.example") ?? null,
      })
      .returning({ id: schema.customers.id });
    if (!row) throw new Error(`failed to insert customer ${c.code}`);
    customerIds.set(c.code, row.id);
  }

  const propertySpecs = [
    { key: "bay-tower", customer: "BAYOA", name: "Bay Tower", type: "building" as const, area: "Business Bay", city: "Dubai", lat: 25.187, lng: 55.264, floors: 34, units: 220 },
    { key: "marina-heights", customer: "ACME", name: "Marina Heights", type: "building" as const, area: "Dubai Marina", city: "Dubai", lat: 25.076, lng: 55.139, floors: 41, units: 310 },
    { key: "serai-downtown", customer: "SERAI", name: "Serai Downtown", type: "hotel" as const, area: "Downtown Dubai", city: "Dubai", lat: 25.197, lng: 55.274, floors: 22, units: 180 },
    { key: "ranches-villa", customer: "PRIV", name: "Villa 42, Al Mahra", type: "villa" as const, area: "Arabian Ranches", city: "Dubai", lat: 25.052, lng: 55.269, floors: 2, units: 1 },
    { key: "jlt-office", customer: "ACME", name: "Cluster K Office Floor 12", type: "office" as const, area: "Jumeirah Lakes Towers", city: "Dubai", lat: 25.069, lng: 55.141, floors: 1, units: 1 },
  ];

  const propertyIds = new Map<string, string>();
  for (const p of propertySpecs) {
    const [row] = await db
      .insert(schema.properties)
      .values({
        tenantId: T1,
        customerId: customerIds.get(p.customer)!,
        name: p.name,
        type: p.type,
        addressLine: `${p.name}, ${p.area}`,
        area: p.area,
        city: p.city,
        lat: p.lat,
        lng: p.lng,
        floors: p.floors,
        unitCount: p.units,
        accessInstructions:
          p.type === "building"
            ? "Report to security desk in the main lobby. Contractor pass required, photo ID held at desk."
            : p.type === "hotel"
              ? "Service entrance on the north side. Loading bay access between 06:00 and 10:00 only."
              : "Gate code 4417. Park on the driveway, not the street.",
      })
      .returning({ id: schema.properties.id });
    if (!row) throw new Error(`failed to insert property ${p.key}`);
    propertyIds.set(p.key, row.id);
  }
  await db.insert(schema.memberships).values({
    tenantId: T1,
    userId: userIds.get("fatima@baytower.example")!,
    role: "customer",
    customerId: customerIds.get("BAYOA")!,
    acceptedAt: new Date(),
  });

  console.log(`  ${customerSpecs.length} customers, ${propertySpecs.length} properties`);

  // ── Jobs ───────────────────────────────────────────────────────────────────
  // Spread across statuses and, importantly, across SLA states: some breached,
  // some at risk, some comfortably on track. A board where everything is green
  // demonstrates nothing.
  const jobSpecs: {
    ref: string;
    property: string;
    customer: string;
    service: string;
    title: string;
    priority: JobPriority;
    status: string;
    createdAgo: number;
    tech?: string;
    completedAgo?: number;
  }[] = [
    { ref: "JOB-2026-00001", property: "bay-tower", customer: "BAYOA", service: "plumbing", title: "Water leaking through ceiling of unit 1204 from riser above", priority: "p1_emergency", status: "on_site", createdAgo: 3 * HOUR, tech: "T-002" },
    { ref: "JOB-2026-00002", property: "marina-heights", customer: "ACME", service: "hvac-ac-maintenance", title: "No cooling on floors 28 to 34, chilled water valve suspected", priority: "p1_emergency", status: "dispatched", createdAgo: 5 * HOUR, tech: "T-001" },
    { ref: "JOB-2026-00003", property: "serai-downtown", customer: "SERAI", service: "electrical", title: "Kitchen distribution board tripping on load, restaurant service affected", priority: "p1_emergency", status: "triaged", createdAgo: 90 * MINUTE },
    { ref: "JOB-2026-00004", property: "bay-tower", customer: "BAYOA", service: "hvac-ac-maintenance", title: "FCU drain overflow staining corridor ceiling, floor 9", priority: "p2_urgent", status: "en_route", createdAgo: 6 * HOUR, tech: "T-004" },
    { ref: "JOB-2026-00005", property: "ranches-villa", customer: "PRIV", service: "hvac-ac-maintenance", title: "Ducted AC uneven cooling between bedrooms", priority: "p3_standard", status: "scheduled", createdAgo: 20 * HOUR },
    { ref: "JOB-2026-00006", property: "jlt-office", customer: "ACME", service: "electrical", title: "Six workstations without power after desk move", priority: "p2_urgent", status: "submitted", createdAgo: 26 * HOUR },
    { ref: "JOB-2026-00007", property: "marina-heights", customer: "ACME", service: "glass-aluminium", title: "Sliding balcony door seized, unit 2810", priority: "p3_standard", status: "paused", createdAgo: 4 * DAY },
    { ref: "JOB-2026-00008", property: "serai-downtown", customer: "SERAI", service: "deep-cleaning", title: "Post-refurbishment deep clean, floors 4 and 5", priority: "p4_planned", status: "scheduled", createdAgo: 2 * DAY },
    { ref: "JOB-2026-00009", property: "bay-tower", customer: "BAYOA", service: "plumbing", title: "Booster pump cycling frequently, pressure loss on upper floors", priority: "p2_urgent", status: "work_complete", createdAgo: 30 * HOUR, tech: "T-005", completedAgo: 2 * HOUR },
    { ref: "JOB-2026-00010", property: "ranches-villa", customer: "PRIV", service: "carpentry", title: "Wardrobe doors misaligned in master bedroom", priority: "p4_planned", status: "triaged", createdAgo: 3 * DAY },
    { ref: "JOB-2026-00011", property: "jlt-office", customer: "ACME", service: "hvac-ac-maintenance", title: "Quarterly AC service, 14 cassette units", priority: "p4_planned", status: "scheduled", createdAgo: 5 * DAY },
    { ref: "JOB-2026-00012", property: "marina-heights", customer: "ACME", service: "plumbing", title: "Blocked drain serving units 1401 to 1406", priority: "p2_urgent", status: "dispatched", createdAgo: 22 * HOUR, tech: "T-002" },
    { ref: "JOB-2026-00013", property: "serai-downtown", customer: "SERAI", service: "pest-control", title: "Cockroach activity reported in back-of-house corridor", priority: "p2_urgent", status: "submitted", createdAgo: 30 * HOUR },
    { ref: "JOB-2026-00014", property: "bay-tower", customer: "BAYOA", service: "cleaning", title: "Lobby and lift car deep clean before AGM", priority: "p3_standard", status: "signed_off", createdAgo: 6 * DAY, tech: "T-007", completedAgo: 4 * DAY },
    { ref: "JOB-2026-00015", property: "ranches-villa", customer: "PRIV", service: "electrical", title: "RCD tripping when pool pump starts", priority: "p2_urgent", status: "closed", createdAgo: 12 * DAY, tech: "T-003", completedAgo: 11 * DAY },
  ];

  let visitSeq = 0;
  for (const j of jobSpecs) {
    const createdAt = ago(j.createdAgo);
    const { respondByAt, resolveByAt } = computeSlaDeadlines(j.priority, createdAt);
    const completedAt = j.completedAgo ? ago(j.completedAgo) : null;

    const [job] = await db
      .insert(schema.jobs)
      .values({
        tenantId: T1,
        reference: j.ref,
        customerId: customerIds.get(j.customer)!,
        propertyId: propertyIds.get(j.property)!,
        serviceSlug: j.service,
        title: j.title,
        status: j.status as never,
        priority: j.priority,
        source: "phone",
        createdAt,
        updatedAt: createdAt,
        respondByAt,
        resolveByAt,
        completedAt,
        closedAt: j.status === "closed" ? completedAt : null,
        currency: "AED",
        createdById: userIds.get("rania@meridianfm.example") ?? null,
      })
      .returning({ id: schema.jobs.id });
    if (!job) throw new Error(`failed to insert job ${j.ref}`);

    await db.insert(schema.jobEvents).values({
      tenantId: T1,
      jobId: job.id,
      fromStatus: null,
      toStatus: "submitted",
      note: "Logged by operations",
      actorId: userIds.get("rania@meridianfm.example") ?? null,
      actorKind: "user",
      occurredAt: createdAt,
    });

    if (j.tech) {
      visitSeq += 1;
      await db.insert(schema.jobVisits).values({
        tenantId: T1,
        jobId: job.id,
        technicianId: techIds.get(j.tech)!,
        sequence: 1,
        status:
          j.status === "on_site"
            ? "arrived"
            : j.status === "en_route"
              ? "en_route"
              : completedAt
                ? "completed"
                : "assigned",
        scheduledStart: new Date(createdAt.getTime() + HOUR),
        scheduledEnd: new Date(createdAt.getTime() + 3 * HOUR),
        dispatchedAt: new Date(createdAt.getTime() + 20 * MINUTE),
        arrivedAt: ["on_site", "work_complete", "signed_off", "closed"].includes(j.status)
          ? new Date(createdAt.getTime() + 55 * MINUTE)
          : null,
        completedAt,
        assignmentMethod: "manual",
        assignedById: userIds.get("yusuf@meridianfm.example") ?? null,
      });
    }
  }
  console.log(`  ${jobSpecs.length} jobs, ${visitSeq} visits`);

  // ── Second tenant: enough to prove isolation ───────────────────────────────
  const [otherCustomer] = await db
    .insert(schema.customers)
    .values({ tenantId: T2, code: "GPC-1", name: "Corniche Residences OA" })
    .returning({ id: schema.customers.id });
  if (!otherCustomer) throw new Error("failed to insert second-tenant customer");

  const [otherProperty] = await db
    .insert(schema.properties)
    .values({
      tenantId: T2,
      customerId: otherCustomer.id,
      name: "Corniche Residences",
      type: "building",
      addressLine: "Corniche Road",
      area: "Al Majaz",
      city: "Sharjah",
    })
    .returning({ id: schema.properties.id });
  if (!otherProperty) throw new Error("failed to insert second-tenant property");

  const otherCreated = ago(2 * HOUR);
  const otherSla = computeSlaDeadlines("p1_emergency", otherCreated);
  await db.insert(schema.jobs).values({
    tenantId: T2,
    reference: "GPC-2026-00001",
    customerId: otherCustomer.id,
    propertyId: otherProperty.id,
    serviceSlug: "plumbing",
    title: "TENANT 2 ONLY - this job must never appear in a Meridian query",
    status: "triaged",
    priority: "p1_emergency",
    createdAt: otherCreated,
    updatedAt: otherCreated,
    respondByAt: otherSla.respondByAt,
    resolveByAt: otherSla.resolveByAt,
  });
  console.log("  tenant 2: 1 customer, 1 property, 1 job");

  // ── The controlled vocabulary every tenant starts with (JOB-13) ───────────
  //
  // Seeded rather than left to the administrator, because this one list is not
  // a matter of local preference: `no_access` and `parts_required` are the
  // outcomes worth counting, and a tenant whose picker is empty on day one gets
  // a free-text note instead — which is the exact failure the table exists to
  // prevent, and it cannot be retrofitted once the history is written.
  //
  // Fault codes and the rate card have no standard list on purpose: what
  // "no cooling" is diagnosed as and what a callout is priced at are genuinely
  // per-business, and inventing either would be putting words — or a price —
  // in an operator's mouth. Disposition reasons are seeded below despite living
  // in the same admin section, because the judgement call is different: the six
  // reasons a lead is lost or parked are near-universal categories, the same
  // way the seven `JOB-13` outcomes are, not an invented specific.
  //
  // `do nothing` on conflict so re-seeding an existing database is a no-op and
  // an administrator's edits to a label survive it.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.jobOutcomeCodes)
      .values(
        STANDARD_JOB_OUTCOMES.map((o) => ({
          tenantId,
          code: o.code,
          label: o.label,
          description: o.description,
          isTerminal: o.isTerminal,
          requiresReturnVisit: o.requiresReturnVisit,
          sortOrder: o.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(`  ${STANDARD_JOB_OUTCOMES.length} standard job outcomes per tenant`);

  // ── The controlled vocabulary every tenant starts with (LEAD-6) ───────────
  //
  // Seeded for the same reason the outcomes above are: `leads_disposition_
  // required` refuses `lost` or `dormant` without a coded reason, so a tenant
  // whose picker is empty on day one cannot close a single lead — not because a
  // real reason was missing, but because nobody had typed the vocabulary in
  // yet. `do nothing` on conflict, so re-seeding leaves an edited label alone.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.leadDispositionReasons)
      .values(
        STANDARD_DISPOSITION_REASONS.map((r) => ({
          tenantId,
          code: r.code,
          label: r.label,
          appliesTo: r.appliesTo,
          guidance: r.guidance,
          sortOrder: r.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(`  ${STANDARD_DISPOSITION_REASONS.length} standard disposition reasons per tenant`);

  // ── Why an "after" photo may be missing (JOB-15) ──────────────────────────
  //
  // Seeded for the same reason the outcomes above are, and with more at stake:
  // this list is the alternative to a required photograph, so a tenant whose
  // picker is empty on day one has a completion gate with no legitimate way
  // past it. The technician then either cannot close a job with nothing to
  // photograph, or somebody widens the gate — and a gate widened once stays
  // widened. `on conflict do nothing`, so re-seeding leaves an edited label be.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.jobPhotoExemptionReasons)
      .values(
        STANDARD_PHOTO_EXEMPTION_REASONS.map((r) => ({
          tenantId,
          code: r.code,
          label: r.label,
          description: r.description,
          sortOrder: r.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(
    `  ${STANDARD_PHOTO_EXEMPTION_REASONS.length} photo exemption reasons per tenant`,
  );

  // ── Why a signed job sheet may be amended (FLD-14) ────────────────────────
  //
  // Seeded for the same reason, and with the same thing at stake: this list is
  // the ONLY way to correct a signed sheet. A tenant whose picker is empty on
  // day one has a locked job card and no legitimate way to state that it is
  // wrong — at which point somebody either edits around the lock or the record
  // stays wrong, and both of those are worse than the mistake being corrected.
  // `on conflict do nothing`, so re-seeding leaves an edited label be.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.jobSheetAmendmentReasons)
      .values(
        STANDARD_JOB_SHEET_AMENDMENT_REASONS.map((r) => ({
          tenantId,
          code: r.code,
          label: r.label,
          description: r.description,
          sortOrder: r.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(
    `  ${STANDARD_JOB_SHEET_AMENDMENT_REASONS.length} job sheet amendment reasons per tenant`,
  );

  // ── The project vocabularies (PRJ-6, PRJ-7) ──────────────────────────────
  //
  // Seeded for the same reason the job outcomes above are. A permit authority
  // typed by hand gives "DM", "Dubai Municipality" and "Dubai Muncipality" for
  // one body, and "which authority is holding this project up" stops having an
  // answer — permanently, because by the time anyone asks it the history is
  // already written. The snag trades carry a catalogue slug wherever the trade
  // is one this business sells, so "who has the most open snags" and "who do we
  // send" are the same answer.
  //
  // `on conflict do nothing`, so re-seeding leaves an operator's edits alone.
  //
  // `labour_cost_rates` (PRJ-8) is deliberately NOT seeded, and the omission is
  // a decision rather than an oversight — the same one this file already makes
  // for the rate card and the fault codes. A fully-loaded hourly cost is
  // genuinely per-business, and a plausible-looking invented figure is worse
  // than an empty table: a project margin computed from somebody else's wage
  // assumptions is a number that gets believed. `recordCost` accepts an hourly
  // cost directly, so an empty rate card blocks nothing.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.permitAuthorities)
      .values(
        STANDARD_PERMIT_AUTHORITIES.map((a) => ({
          tenantId,
          code: a.code,
          label: a.label,
          description: a.description,
          sortOrder: a.sortOrder,
        })),
      )
      .onConflictDoNothing();

    await db
      .insert(schema.snagTrades)
      .values(
        STANDARD_SNAG_TRADES.map((t) => ({
          tenantId,
          code: t.code,
          label: t.label,
          serviceSlug: t.serviceSlug,
          sortOrder: t.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(
    `  ${STANDARD_PERMIT_AUTHORITIES.length} permit authorities and ` +
      `${STANDARD_SNAG_TRADES.length} snag trades per tenant`,
  );

  // ── The asset register (CON-13) ───────────────────────────────────────────
  //
  // The kinds are seeded for the same reason the job outcomes above are: the
  // seven are written into the requirement rather than chosen per business, and
  // a picker that is empty on day one is a picker whose first entry everybody
  // chooses. `on conflict do nothing`, so re-seeding leaves an operator's edits
  // to a label alone.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.assetCategories)
      .values(
        STANDARD_ASSET_CATEGORIES.map((c) => ({
          tenantId,
          code: c.code,
          label: c.label,
          description: c.description,
          serviceSlug: c.serviceSlug,
          defaultPpmIntervalDays: c.defaultPpmIntervalDays,
          sortOrder: c.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }

  // ── The tender vocabularies (CON-11) ──────────────────────────────────────
  //
  // Seeded for the same reason the asset kinds above are: the four channels are
  // written into the requirement rather than chosen per business, and a picker
  // that is empty on day one is a picker whose first entry everybody chooses.
  // The outcome reasons matter for a second reason — "why did we lose" answered
  // in free text is a question with no answer at the end of the year, and two
  // of the reasons on the list ("incomplete submission", "missing
  // accreditation") are the ones CON-12's pack exists to drive to zero, so they
  // have to be countable.
  //
  // `on conflict do nothing`, so re-seeding leaves an operator's edits alone.
  for (const tenantId of [T1, T2]) {
    await db
      .insert(schema.tenderOpportunitySources)
      .values(
        STANDARD_TENDER_SOURCES.map((v) => ({
          tenantId,
          code: v.code,
          label: v.label,
          description: v.description,
          sortOrder: v.sortOrder,
        })),
      )
      .onConflictDoNothing();

    await db
      .insert(schema.tenderOutcomeReasons)
      .values(
        STANDARD_TENDER_OUTCOME_REASONS.map((v) => ({
          tenantId,
          code: v.code,
          label: v.label,
          description: v.description,
          appliesTo: v.appliesTo,
          sortOrder: v.sortOrder,
        })),
      )
      .onConflictDoNothing();
  }
  console.log(
    `  ${STANDARD_TENDER_SOURCES.length} tender opportunity sources and ` +
      `${STANDARD_TENDER_OUTCOME_REASONS.length} outcome reasons per tenant`,
  );

  const categoryIds = new Map<string, string>();
  for (const row of await db
    .select({ id: schema.assetCategories.id, code: schema.assetCategories.code })
    .from(schema.assetCategories)
    .where(eq(schema.assetCategories.tenantId, T1))) {
    categoryIds.set(row.code, row.id);
  }

  // Plant on the seeded buildings. Not decoration: an empty register cannot
  // show that a warranty state is computed rather than typed, and three of
  // these exist specifically to put the three states on the screen at once —
  // one warranty long expired, one expiring inside the month, one with years
  // left. Day-valued columns are `YYYY-MM-DD` strings, never Dates; a warranty
  // that round-trips through a Date arrives a day early in Dubai.
  const day = (offsetMs: number) => dubaiDateKey(new Date(Date.now() + offsetMs));

  const assetSpecs = [
    { tag: "BT-CH-01", property: "bay-tower", category: "chiller", name: "Chiller 1, main plant room", make: "Carrier", model: "30XA-1002", serial: "CAR-30XA-118842", location: "Roof plant room, north", installed: -6 * 365 * DAY, warranty: -400 * DAY, condition: "fair" as const, servicedAgo: 40 * DAY },
    { tag: "BT-CH-02", property: "bay-tower", category: "chiller", name: "Chiller 2, main plant room", make: "Carrier", model: "30XA-1002", serial: "CAR-30XA-118843", location: "Roof plant room, north", installed: -6 * 365 * DAY, warranty: -400 * DAY, condition: "good" as const, servicedAgo: 40 * DAY },
    { tag: "BT-PUMP-01", property: "bay-tower", category: "pump", name: "Domestic booster pump set", make: "Grundfos", model: "Hydro MPC-E 3", serial: "GF-HMPC-77120", location: "Basement 2, pump room", installed: -3 * 365 * DAY, warranty: 21 * DAY, condition: "good" as const },
    { tag: "BT-TANK-01", property: "bay-tower", category: "water_tank", name: "Potable water tank, sector A", make: "Fibrelite", model: "GRP 40m3", serial: null, location: "Basement 2, tank room", installed: -8 * 365 * DAY, warranty: null, condition: "fair" as const },
    { tag: "BT-LIFT-01", property: "bay-tower", category: "lift", name: "Passenger lift 1 (low rise)", make: "Otis", model: "Gen2 Premier", serial: "OT-G2P-44190", location: "Core A", installed: -6 * 365 * DAY, warranty: -1000 * DAY, condition: "good" as const },
    { tag: "BT-FCU-0904", property: "bay-tower", category: "fcu", name: "FCU serving corridor, floor 9", make: "Zamil", model: "FCU-600", serial: "ZAM-600-90412", location: "Floor 9 riser cupboard", installed: -6 * 365 * DAY, warranty: -900 * DAY, condition: "poor" as const },
    { tag: "MH-CH-01", property: "marina-heights", category: "chiller", name: "Chiller 1, high-rise loop", make: "York", model: "YVAA-0517", serial: "YRK-YVAA-20881", location: "Level 42 plant room", installed: -2 * 365 * DAY, warranty: 500 * DAY, condition: "new" as const },
    { tag: "MH-DB-28", property: "marina-heights", category: "distribution_board", name: "Sub-main DB, floors 28 to 34", make: "Schneider", model: "Prisma iPM", serial: "SCH-IPM-51203", location: "Floor 28 electrical room", installed: -2 * 365 * DAY, warranty: 500 * DAY, condition: "good" as const },
    { tag: "SD-DB-K1", property: "serai-downtown", category: "distribution_board", name: "Kitchen distribution board", make: "ABB", model: "TwinLine N", serial: "ABB-TLN-90455", location: "Back of house, level 1", installed: -9 * 365 * DAY, warranty: null, condition: "poor" as const },
    { tag: "RV-SPLIT-01", property: "ranches-villa", category: "split_unit", name: "Ducted split, first floor", make: "Daikin", model: "FDMF-60", serial: "DK-FDMF-33018", location: "First floor ceiling void", installed: -400 * DAY, warranty: 330 * DAY, condition: "good" as const },
  ];

  const assetIds = new Map<string, string>();
  for (const a of assetSpecs) {
    const categoryId = categoryIds.get(a.category);
    if (!categoryId) throw new Error(`no asset category seeded for ${a.category}`);
    const lastServiced = a.servicedAgo ? ago(a.servicedAgo) : null;
    const [row] = await db
      .insert(schema.assets)
      .values({
        tenantId: T1,
        propertyId: propertyIds.get(a.property)!,
        categoryId,
        tag: a.tag,
        name: a.name,
        manufacturer: a.make,
        model: a.model,
        serialNumber: a.serial,
        location: a.location,
        installedOn: day(a.installed),
        warrantyExpiresOn: a.warranty === null ? null : day(a.warranty),
        condition: a.condition,
        ppmIntervalDays:
          STANDARD_ASSET_CATEGORIES.find((c) => c.code === a.category)?.defaultPpmIntervalDays ??
          null,
        lastServicedAt: lastServiced,
      })
      .returning({ id: schema.assets.id });
    if (!row) throw new Error(`failed to insert asset ${a.tag}`);
    assetIds.set(a.tag, row.id);
  }

  // Three of the seeded jobs are attached to the plant they were done on, so
  // the service history on those assets is a history rather than an empty
  // heading. `jobs.asset_id` has existed since 0000 and nothing has ever
  // written it — see `domain/assets.ts` for what that means and what is still
  // missing.
  const jobToAsset: [string, string][] = [
    ["JOB-2026-00009", "BT-PUMP-01"],
    ["JOB-2026-00004", "BT-FCU-0904"],
    ["JOB-2026-00002", "MH-CH-01"],
    ["JOB-2026-00003", "SD-DB-K1"],
  ];
  for (const [reference, tag] of jobToAsset) {
    await db
      .update(schema.jobs)
      .set({ assetId: assetIds.get(tag)! })
      .where(and(eq(schema.jobs.tenantId, T1), eq(schema.jobs.reference, reference)));
  }
  console.log(
    `  ${STANDARD_ASSET_CATEGORIES.length} asset kinds per tenant, ${assetSpecs.length} assets, ${jobToAsset.length} jobs attached to plant`,
  );


  // ── M3: contracts and AMC (CON-1 … CON-10) ────────────────────────────────
  //
  // The `contracts` table has existed since migration 0000 and has never had a
  // row in it — the TRD calls that "the largest single gap between the schema
  // and the product". Two contracts are seeded, and the second one is the point:
  //
  //   * Bay Tower, mid-term and healthy, so the entitlement meters, the PPM
  //     schedule and the completion figure all have something real to show.
  //   * Marina Heights, expiring in 45 days, so the renewal pipeline (`CON-8`)
  //     and the reminder ladder (`CON-9`) are exercised rather than rendered
  //     empty. A renewal screen that is always empty is a screen nobody checks.
  //
  // The visit dates come from `planPpmVisits` — the same pure planner the
  // domain layer uses — rather than from hand-written dates. Seeded data that
  // was placed by a different rule than production data is seeded data that
  // hides the bug it was supposed to reveal.
  const contractSpecs = [
    {
      reference: `CON-${new Date().getFullYear()}-00001`,
      customer: "BAYOA",
      name: "Bay Tower — comprehensive AMC",
      properties: ["bay-tower"],
      coverageType: "comprehensive",
      startsOn: ago(200 * DAY),
      endsOn: ahead(165 * DAY),
      annualValue: "42000.00",
      billingFrequency: "quarterly",
      discountBp: 1500,
      calloutsPerYear: null,
      entitlements: [
        { serviceSlug: "hvac-installation-maintenance", label: "AC service", visitsPerYear: 4, consumed: 2 },
        { serviceSlug: "plumbing-sanitary", label: "Plumbing inspection", visitsPerYear: 2, consumed: 1 },
      ],
    },
    {
      reference: `CON-${new Date().getFullYear()}-00002`,
      customer: "ACME",
      name: "Marina Heights — labour-only AMC",
      properties: ["marina-heights", "jlt-office"],
      coverageType: "labour_only",
      startsOn: ago(320 * DAY),
      endsOn: ahead(45 * DAY),
      annualValue: "68500.00",
      billingFrequency: "monthly",
      discountBp: 1000,
      calloutsPerYear: 12,
      entitlements: [
        { serviceSlug: "hvac-installation-maintenance", label: "AC service", visitsPerYear: 4, consumed: 3 },
        { serviceSlug: "electrical-fittings-repair", label: "Electrical inspection", visitsPerYear: 2, consumed: 2 },
      ],
    },
  ] as const;

  let seededVisits = 0;
  for (const spec of contractSpecs) {
    const [contract] = await db
      .insert(schema.contracts)
      .values({
        tenantId: T1,
        reference: spec.reference,
        customerId: customerIds.get(spec.customer)!,
        name: spec.name,
        kind: "amc",
        status: "active",
        startsOn: spec.startsOn,
        endsOn: spec.endsOn,
        annualValue: spec.annualValue,
        billingFrequency: spec.billingFrequency,
        visitsPerYear: spec.entitlements.reduce((sum, e) => sum + e.visitsPerYear, 0),
        coveredServices: spec.entitlements.map((e) => e.serviceSlug),
        exclusions: STANDARD_AMC_EXCLUSIONS.map((e) => ({
          code: e.code,
          label: e.label,
          description: e.description,
        })),
        // A negotiated four-hour response on the AMC, which is the seam
        // `computeSlaDeadlines` has always had and nothing was using: contract
        // targets override the default per priority.
        slaTargets: { p2_urgent: { respondMinutes: 240, resolveMinutes: 24 * 60 } },
        autoRenew: false,
        ownerId: userIds.get("rania@meridianfm.example") ?? null,
      })
      .returning({ id: schema.contracts.id });
    if (!contract) throw new Error(`failed to insert contract ${spec.reference}`);

    await db.insert(schema.contractTerms).values({
      tenantId: T1,
      contractId: contract.id,
      coverageType: spec.coverageType,
      paymentTermsDays: 30,
      discountRateBasisPoints: spec.discountBp,
      calloutsPerYear: spec.calloutsPerYear,
      ppmLeadTimeDays: 21,
      ppmWindowDays: 7,
      ppmGeneratedThrough: spec.endsOn,
      activatedAt: spec.startsOn,
    });

    await db.insert(schema.contractProperties).values(
      spec.properties.map((key) => ({
        tenantId: T1,
        contractId: contract.id,
        propertyId: propertyIds.get(key)!,
      })),
    );

    await db.insert(schema.contractEntitlements).values(
      spec.entitlements.map((e) => ({
        tenantId: T1,
        contractId: contract.id,
        serviceSlug: e.serviceSlug,
        label: e.label,
        visitsPerYear: e.visitsPerYear,
        consumedVisits: e.consumed,
      })),
    );

    await db.insert(schema.contractExclusions).values(
      STANDARD_AMC_EXCLUSIONS.map((e) => ({
        tenantId: T1,
        contractId: contract.id,
        code: e.code,
        label: e.label,
        description: exclusionDefinition(e.code)?.description ?? null,
        isStandard: true,
      })),
    );

    // No calendar argument, so `DEFAULT_CALENDAR` applies — weekends and the
    // summer midday ban, and an empty public-holiday list. That is honest for a
    // seed: the holidays are `ADM-10` reference data an administrator enters,
    // and inventing them here would produce a schedule the running system
    // disagrees with the moment the real list is loaded.
    const plan = planPpmVisits({
      termStart: spec.startsOn,
      termEnd: spec.endsOn,
      properties: spec.properties.map((key) => propertyIds.get(key)!),
      entitlements: spec.entitlements.map((e) => ({
        serviceSlug: e.serviceSlug,
        visitsPerYear: e.visitsPerYear,
      })),
      windowDays: 7,
    });

    if (plan.visits.length > 0) {
      await db.insert(schema.contractVisits).values(
        plan.visits.map((v) => ({
          tenantId: T1,
          contractId: contract.id,
          propertyId: v.propertyId,
          dueOn: v.dueOn,
          serviceSlug: v.serviceSlug,
          // Anything whose window closed before today reads as completed; the
          // rest stay planned. A seed where every past visit is still "planned"
          // would report 0% PPM completion on a healthy contract.
          status: v.windowEnd < new Date() ? "completed" : "planned",
        })),
      );
      seededVisits += plan.visits.length;
    }
  }
  console.log(`  ${contractSpecs.length} contracts, ${seededVisits} planned visits`);

  // ── M9 recruitment (ATS-1, ATS-7, ATS-16) ─────────────────────────────────
  //
  // One open vacancy with the standard pipeline, and five applicants spread
  // across it — including, deliberately, one archived applicant who has NOT
  // been told the outcome and is two days past the date they were promised one.
  //
  // That last row is the point of the seed. A recruitment board where everybody
  // has been answered demonstrates nothing: `ATS-16`'s target is 100% and the
  // whole module exists because the number is normally around 35%. The screen
  // has to be seen with somebody on it.
  {
    const [requisition] = await db
      .insert(schema.jobRequisitions)
      .values({
        tenantId: T1,
        reference: `REQ-${new Date().getFullYear()}-00001`,
        publicSlug: "ac-technician",
        title: "AC Technician",
        trade: "hvac-installation-maintenance",
        grade: "technician",
        headcount: 2,
        contractType: "full_time",
        locationCity: "Dubai",
        locationArea: "Business Bay",
        minExperienceYears: 2,
        requiredCertifications: ["HVAC Level 2", "Working at height"],
        salaryBandMinMinor: 320000,
        salaryBandMaxMinor: 420000,
        summary:
          "Split units, FCUs and ducted systems across managed residential and commercial buildings. Direct employment on a UAE labour contract, salary paid through WPS, tools and PPE provided.",
        responsibilities:
          "Planned maintenance visits and reactive callouts. Fault diagnosis, gas charging, coil and filter work, and commissioning on fit-out projects.",
        // ATS-6. Stated in the advert, which is what makes the single yes/no
        // question on the application form legitimate.
        physicalRequirements:
          "Working at height, lifting to 25 kg, and outdoor work in summer conditions.",
        status: "open",
        approvedById: userIds.get("omar@meridianfm.example") ?? null,
        approvedAt: ago(30 * DAY),
        opensAt: ago(21 * DAY),
        publishedAt: ago(21 * DAY),
        closesAt: ahead(10 * DAY),
        hiringManagerUserId: userIds.get("yusuf@meridianfm.example") ?? null,
      })
      .returning({ id: schema.jobRequisitions.id });

    if (!requisition) throw new Error("failed to insert the seeded requisition");

    const stageRows = await db
      .insert(schema.requisitionStages)
      .values(
        DEFAULT_PIPELINE.map((stage, index) => ({
          tenantId: T1,
          requisitionId: requisition.id,
          name: stage.name,
          stageType: stage.stageType,
          sequence: index + 1,
        })),
      )
      .returning({ id: schema.requisitionStages.id, sequence: schema.requisitionStages.sequence });

    const stageAt = (sequence: number): string => {
      const found = stageRows.find((s) => s.sequence === sequence);
      if (!found) throw new Error(`no seeded stage at sequence ${sequence}`);
      return found.id;
    };

    const applicantSpecs = [
      {
        name: "Rajesh Kumar",
        phone: "+971 50 411 8827",
        email: "rajesh.kumar@example.com",
        grade: "technician",
        band: "5_to_10",
        stage: 1,
        stageDays: 1,
        blockedOn: "none" as const,
        blockedNote: null,
        certificate: { scheme: "HVAC Level 2", expires: "2028-03-31" },
      },
      {
        name: "Suresh Pillai",
        phone: "+971 55 902 4471",
        email: "suresh.p@example.com",
        grade: "senior_technician",
        band: "over_10",
        stage: 2,
        stageDays: 1,
        blockedOn: "us" as const,
        blockedNote: "Screening call not yet made",
        certificate: { scheme: "HVAC Level 2", expires: "2029-06-30" },
      },
      {
        // Red on the board: waiting on us, four days, nobody has acted. This is
        // the card ATS-8 was written for.
        name: "Imran Sheikh",
        phone: "0503347781",
        email: null,
        grade: "technician",
        band: "2_to_5",
        stage: 3,
        stageDays: 4,
        blockedOn: "us" as const,
        blockedNote: "Trade test not booked",
        // Expired, on purpose. HR-9 blocks a dispatch to height work on this,
        // and finding out here costs a phone call rather than a job.
        certificate: { scheme: "Working at height", expires: "2026-06-30" },
      },
      {
        name: "Mohammed Farid",
        phone: "+971 52 118 6690",
        email: "m.farid@example.com",
        grade: "charge_hand",
        band: "over_10",
        stage: 4,
        stageDays: 1,
        blockedOn: "candidate" as const,
        blockedNote: "Waiting on a photo of the height certificate",
        certificate: { scheme: "HVAC Level 2", expires: "2027-11-30" },
      },
    ];

    let applicationSeq = 0;
    for (const spec of applicantSpecs) {
      applicationSeq += 1;
      const appliedAt = ago((spec.stageDays + 6) * DAY);

      const [candidate] = await db
        .insert(schema.candidates)
        .values({
          tenantId: T1,
          fullName: spec.name,
          phone: spec.phone,
          email: spec.email,
          primaryTrade: "hvac-installation-maintenance",
          grade: spec.grade,
          experienceBand: spec.band,
          currentLocation: "in_uae",
          hasDrivingLicence: true,
          lastInteractionAt: ago(spec.stageDays * DAY),
          retentionBasis: "pre_contractual",
          // ATS-18. Six months from the last interaction.
          deleteAfter: new Date(Date.now() + 180 * DAY).toISOString().slice(0, 10),
        })
        .returning({ id: schema.candidates.id });

      if (!candidate) throw new Error(`failed to insert candidate ${spec.name}`);

      await db.insert(schema.candidateCertifications).values({
        tenantId: T1,
        candidateId: candidate.id,
        scheme: spec.certificate.scheme,
        certificateNo: `HV-${4400 + applicationSeq}`,
        issuingBody: "City & Guilds",
        expiresOn: spec.certificate.expires,
      });

      const [application] = await db
        .insert(schema.applications)
        .values({
          tenantId: T1,
          reference: `APP-${new Date().getFullYear()}-${String(applicationSeq).padStart(5, "0")}`,
          candidateId: candidate.id,
          requisitionId: requisition.id,
          currentStageId: stageAt(spec.stage),
          stageEnteredAt: ago(spec.stageDays * DAY),
          status: "active",
          availability: "immediate",
          essentialFunctions: "yes",
          source: "careers_site",
          appliedAt,
          acknowledgedAt: appliedAt,
          outcomeDueAt: new Date(appliedAt.getTime() + 3 * DAY),
          blockedOn: spec.blockedOn,
          blockedNote: spec.blockedNote,
          blockedSince: spec.blockedOn === "none" ? null : ago(spec.stageDays * DAY),
          statusToken: `seed${applicationSeq}`.padEnd(64, "0"),
        })
        .returning({ id: schema.applications.id });

      if (!application) throw new Error(`failed to insert application for ${spec.name}`);

      await db.insert(schema.applicationEvents).values({
        tenantId: T1,
        applicationId: application.id,
        eventType: "applied",
        toStageId: stageAt(1),
        note: "Applied on the careers site",
        actorKind: "candidate",
        occurredAt: appliedAt,
      });
    }

    // The one that matters: archived, with a reason, with the message composed
    // — and never sent. Two days past the promise. This is what the "owed an
    // outcome" panel on /recruitment exists to show, and a seed in which it is
    // empty would let the panel ship untested and unread.
    {
      applicationSeq += 1;
      const appliedAt = ago(12 * DAY);

      const [candidate] = await db
        .insert(schema.candidates)
        .values({
          tenantId: T1,
          fullName: "Anwar Hossain",
          phone: "+971 56 330 1145",
          email: "anwar.h@example.com",
          primaryTrade: "hvac-installation-maintenance",
          grade: "helper",
          experienceBand: "under_2",
          currentLocation: "in_uae",
          lastInteractionAt: ago(5 * DAY),
          retentionBasis: "pre_contractual",
          deleteAfter: new Date(Date.now() + 180 * DAY).toISOString().slice(0, 10),
        })
        .returning({ id: schema.candidates.id });

      if (!candidate) throw new Error("failed to insert the owed-an-outcome candidate");

      await db.insert(schema.applications).values({
        tenantId: T1,
        reference: `APP-${new Date().getFullYear()}-${String(applicationSeq).padStart(5, "0")}`,
        candidateId: candidate.id,
        requisitionId: requisition.id,
        currentStageId: stageAt(2),
        stageEnteredAt: ago(9 * DAY),
        status: "archived",
        dispositionReasonCode: "insufficient_experience",
        archivedAtStageId: stageAt(2),
        archivedAt: ago(5 * DAY),
        availability: "immediate",
        essentialFunctions: "yes",
        source: "careers_site",
        appliedAt,
        acknowledgedAt: appliedAt,
        outcomeDueAt: ago(2 * DAY),
        outcomeMessage:
          "Hi Anwar, thank you for applying for AC Technician. We are not moving forward this time — we are looking for more hands-on experience in this trade for this particular role. Please apply again as you build it up.",
        // Deliberately null. The message exists; nobody has sent it.
        outcomeScheduledAt: null,
        outcomeSentAt: null,
        statusToken: `seed${applicationSeq}`.padEnd(64, "0"),
      });
    }

    console.log(`  1 open vacancy, ${applicationSeq} applicants (1 owed an outcome)`);
  }
  // ══════════════════════════════════════════════════════════════════════════
  // M10 — the employment lifecycle
  // `HR-4` contracts · `HR-5` documents · `HR-6` insurance · `HR-7` leave
  // `HR-8` hours · `HR-17` wage protection
  // ══════════════════════════════════════════════════════════════════════════
  //
  // ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────
  //
  // Without it a fresh seed has no employment records, and the compliance board
  // then reports on an empty set. That is not a neutral state: "0 technicians
  // blocked from dispatch" reads as safety when what it actually means is that
  // nothing is being measured. `/workforce` says so in its own empty state —
  // *"Nobody is blocked, because nobody is being checked"* — but a board that
  // has to explain why it is empty is a board nobody trusts on the first day.
  //
  // ── NOBODY IS SEEDED INTO A VIOLATION ────────────────────────────────────
  //
  // Every blocking document below is in date, every health policy is the tier
  // the wage requires, and the live wage cycle is transferred on time. A fresh
  // install that opens on a red board teaches the reader that red is the normal
  // colour, and the next real block is then invisible. What IS seeded is the
  // band *before* a problem: one Emirates ID inside 30 days, one inside 90, one
  // probation period ending. Those render every section populated without
  // asserting that this company is in breach of anything.
  {
    // Calendar days, as strings. A permit expires on a *day*, not an instant;
    // see the header of `packages/core/src/employment.ts` for why these never
    // become `Date`s on the way to a `date` column.
    const now = today();
    const day = (offset: number) => addDays(now, offset);

    // The live wage cycle is last month's wages, due on the 1st of this month —
    // `wpsCycleFor()` computes exactly this, and the seed has to agree with it
    // or the board opens a second cycle for the same month on first render.
    const liveDueOn = startOfMonth(now);
    const livePeriod = addMonths(liveDueOn, -1);
    const priorDueOn = livePeriod;
    const priorPeriod = addMonths(livePeriod, -1);

    const employeeSpecs = [
      {
        no: "E-001",
        tech: "T-001",
        name: "Bilal Chaudhry",
        basicMinor: 720_000,
        allowances: { housing: "2000.00" },
        serviceDays: 400,
        // Well inside its term. `assessContract` reports `active`.
        contractEndsInDays: 240,
        probationEndsInDays: null,
        // A senior technician on AED 9,200 total is above the AED 4,000
        // Essential Benefits threshold, so a standard plan is what the law asks
        // for. `requiredHealthPlan` is what decides this, not this comment.
        plan: "standard" as const,
        insurer: "Daman",
        policyNo: "DHA-2026-114872",
        premiumMinor: 420_000,
        // Every one in date. Nobody starts blocked.
        docs: {
          work_permit: 400,
          residence_visa: 500,
          emirates_id: 600,
          medical_fitness: 210,
          health_insurance: 300,
        },
        // 90 minutes at +25% inside the live wage month, so the wage file has a
        // non-zero overtime column. Deliberately under the two-hour daily cap —
        // a breach on a fresh install is a false alarm.
        overtimeMinutes: 90,
        carriedOverLeaveDays: 5,
        // HR-18, leg one and leg two. A charge hand on AED 9,200 with a
        // technical diploma passes all three legs of the skilled test, so this
        // is the tenant's entire Emiratisation denominator: one.
        iscoMajorGroup: 3,
        postSecondaryCertificate: true,
      },
      {
        no: "E-002",
        tech: "T-002",
        name: "Ganesh Pillai",
        basicMinor: 340_000,
        allowances: { transport: "300.00" },
        serviceDays: 120,
        contractEndsInDays: 610,
        // On probation. Six months maximum, non-extendable, 14 days' notice —
        // a normal state with a deadline attached, which is what makes it worth
        // rendering. 165 days from a start 120 days ago is inside the cap, and
        // the CHECK constraint on the table enforces that independently.
        probationEndsInDays: 45,
        // AED 3,700 total is below the threshold, so this one legally requires
        // an Essential Benefits Plan and not a standard one.
        plan: "essential_benefits" as const,
        insurer: "Daman",
        policyNo: "DHA-2026-114873",
        premiumMinor: 96_000,
        docs: {
          work_permit: 250,
          residence_visa: 400,
          // THE expiring document. Inside 30 days, so the "renew, or somebody
          // stops being deployable" section has a row in it — and not expired,
          // so nothing is blocked.
          emirates_id: 21,
          medical_fitness: 150,
          health_insurance: 180,
        },
        overtimeMinutes: 0,
        carriedOverLeaveDays: 0,
        // Craft and related trades, no post-secondary certificate, AED 3,700 a
        // month. Outside the denominator on all three legs at once, which is
        // the ordinary case in this business and the reason total headcount is
        // not the number Emiratisation is measured against.
        iscoMajorGroup: 7,
        postSecondaryCertificate: false,
      },
      {
        no: "E-003",
        tech: "T-003",
        name: "Arun Verma",
        basicMinor: 600_000,
        allowances: { housing: "1500.00" },
        serviceDays: 400,
        contractEndsInDays: 120,
        probationEndsInDays: null,
        plan: "standard" as const,
        insurer: "Oman Insurance",
        policyNo: "DHA-2026-114874",
        premiumMinor: 390_000,
        docs: {
          work_permit: 350,
          residence_visa: 450,
          emirates_id: 550,
          // Inside 90 but outside 30, so the "between 31 and 90 days" band is
          // populated too. That band is where a renewal is still cheap and
          // unhurried, and a board that only ever shows the urgent one trains
          // people to act late.
          medical_fitness: 75,
          health_insurance: 250,
        },
        overtimeMinutes: 0,
        carriedOverLeaveDays: 0,
        // Deliberately unrecorded, both of them. `classifySkilledEmployee`
        // returns `unknown` rather than guessing, and `assessEmiratisation`
        // counts the unknowns into the UPPER bound of the skilled range — so a
        // fresh install opens showing "1-2 skilled" and a named reason, which
        // is the honest answer and is what the screen exists to say. Seeding
        // this as a definite value would demonstrate the wrong behaviour.
        iscoMajorGroup: null,
        postSecondaryCertificate: null,
      },
    ];

    interface SeededLine {
      readonly employeeId: string;
      readonly basicMinor: number;
      readonly allowancesMinor: number;
      readonly overtimeMinor: number;
      readonly deductionsMinor: number;
      readonly netMinor: number;
      readonly overtimeMinutes: number;
    }
    const lines: SeededLine[] = [];

    for (const e of employeeSpecs) {
      const technicianId = techIds.get(e.tech) ?? null;
      const serviceStart = day(-e.serviceDays);

      const [employee] = await db
        .insert(schema.employees)
        .values({
          tenantId: T1,
          technicianId,
          employeeNo: e.no,
          fullName: e.name,
          contractType: "fixed_term",
          contractStart: serviceStart,
          contractEnd: day(e.contractEndsInDays),
          probationEnd: e.probationEndsInDays === null ? null : day(e.probationEndsInDays),
          noticePeriodDays: 30,
          basicSalaryMinor: e.basicMinor,
          allowances: e.allowances,
          iscoMajorGroup: e.iscoMajorGroup,
          postSecondaryCertificate: e.postSecondaryCertificate,
          mohrePersonCode: `MOHRE-${e.no}`,
          // Without an IBAN a wage line cannot be transferred, and
          // `wageFileGaps` reports that as the failure that looks like
          // compliance. Every seeded employee has one, so the board opens clean.
          wpsIban: `AE07033123456789012345${e.no.slice(-1)}`,
          status: "active",
          healthPlan: e.plan,
          healthInsurer: e.insurer,
          healthPolicyNo: e.policyNo,
          // An employer cost, recorded so the renewal is not reconstructed from
          // memory. It is not a deduction and cannot become one:
          // `salary_deductions.kind` has no insurance value in its positive list.
          healthPremium: toDecimalString(e.premiumMinor),
        })
        .returning({ id: schema.employees.id });
      if (!employee) throw new Error(`failed to insert employee ${e.no}`);

      // ── HR-5: the five documents that decide deployability ──────────────
      await db.insert(schema.employeeDocuments).values(
        Object.entries(e.docs).map(([kind, inDays]) => ({
          tenantId: T1,
          employeeId: employee.id,
          kind,
          referenceNo: `${kind.toUpperCase().slice(0, 3)}-${e.no}`,
          issuedAt: day(-720),
          expiresAt: day(inDays),
          // Derived from the kind, never an input — the same rule
          // `recordEmployeeDocument` follows. A seed that flagged these by hand
          // could quietly downgrade a work permit to a warning.
          blocking: ["work_permit", "residence_visa", "emirates_id", "medical_fitness", "health_insurance"].includes(kind),
          verifiedAt: ago(30 * DAY),
        })),
      );

      // ── HR-4: the contract term as a row ────────────────────────────────
      await db.insert(schema.employmentContractTerms).values({
        tenantId: T1,
        employeeId: employee.id,
        sequence: 1,
        startsOn: serviceStart,
        endsOn: day(e.contractEndsInDays),
        probationEndsOn: e.probationEndsInDays === null ? null : day(e.probationEndsInDays),
        noticePeriodDays: 30,
        basicSalary: toDecimalString(e.basicMinor),
        allowances: e.allowances,
        workingPattern: "Sun–Thu 08:00–17:00, 1h break",
        origin: "signed",
        status: "active",
      });

      // ── HR-8: overtime, by band, priced from the basic salary ───────────
      let overtimeMinor = 0;
      if (e.overtimeMinutes > 0) {
        const hourly = hourlyBasicMinor(e.basicMinor);
        overtimeMinor = overtimeAmountMinor(hourly, e.overtimeMinutes, "overtime");
        await db.insert(schema.overtimeRecords).values({
          tenantId: T1,
          employeeId: employee.id,
          // Inside the live wage month, so it lands in that cycle's file.
          workedOn: addDays(livePeriod, 12),
          band: "overtime",
          minutes: e.overtimeMinutes,
          // Stored on the row rather than looked up at read time: statutory
          // rates change, and a historic entry must keep saying what it was
          // actually paid at.
          multiplierBasisPoints: PAY_BAND_BASIS_POINTS.overtime,
          hourlyRate: toDecimalString(hourly),
          amount: toDecimalString(overtimeMinor),
          source: "manual",
          approvedAt: ago(20 * DAY),
        });
      }

      // ── HR-7: carry-over, which is the only thing a table can know ──────
      if (e.carriedOverLeaveDays > 0) {
        await db.insert(schema.leaveBalances).values({
          tenantId: T1,
          employeeId: employee.id,
          // The service ANNIVERSARY, which is what `leaveSummary` measures
          // against — not the service start. Writing against the wrong one
          // saves a row nothing ever reads and the balance never moves.
          leaveYearStart: addMonths(serviceStart, Math.floor(e.serviceDays / 365) * 12),
          carriedOverDays: e.carriedOverLeaveDays,
          adjustmentDays: 0,
          reason: "Carried forward from the previous leave year under company policy.",
        });
      }

      const allowancesMinor = Object.values(e.allowances).reduce(
        (sum, v) => sum + Math.round(Number(v) * 100),
        0,
      );
      const deductionsMinor = e.no === "E-003" ? 20_000 : 0;

      // ── One lawful deduction, to show the closed list is not empty ──────
      //
      // A salary-advance repayment, which IS permitted. The point of seeding one
      // is that the list it comes from contains no insurance premium and no visa
      // cost — `HR-6` and `HR-16` are enforced by a CHECK constraint, and a
      // reader who never sees a legitimate deduction cannot tell a closed list
      // from an unused feature.
      if (deductionsMinor > 0) {
        await db.insert(schema.salaryDeductions).values({
          tenantId: T1,
          employeeId: employee.id,
          kind: "salary_advance_repayment",
          amount: toDecimalString(deductionsMinor),
          reason: "Third instalment of a four-month salary advance agreed in writing.",
          authorisedById: userIds.get("priya@meridianfm.example") ?? null,
          appliesOn: addDays(livePeriod, 15),
        });
      }

      lines.push({
        employeeId: employee.id,
        basicMinor: e.basicMinor,
        allowancesMinor,
        overtimeMinor,
        deductionsMinor,
        netMinor: e.basicMinor + allowancesMinor + overtimeMinor - deductionsMinor,
        overtimeMinutes: e.overtimeMinutes,
      });

      // ── HR-7: approved leave, with more than a month's notice ───────────
      if (technicianId && e.no === "E-001") {
        await db.insert(schema.leaveRequests).values({
          tenantId: T1,
          technicianId,
          kind: "annual",
          // 45 days out. `checkLeaveNotice` needs 30, so this reads as
          // sufficient — leave imposed at shorter notice is unlawful, and only
          // the record of when it was asked for distinguishes the two.
          startsOn: ahead(45 * DAY),
          endsOn: ahead(54 * DAY),
          status: "approved",
          reason: "Annual leave, family travel.",
          approvedById: userIds.get("rania@meridianfm.example") ?? null,
          approvedAt: ago(2 * DAY),
        });
      }
    }

    const liveTotalMinor = lines.reduce((sum, l) => sum + l.netMinor, 0);

    // ── HR-17: the wage cycles ────────────────────────────────────────────
    //
    // The live cycle is transferred **on the deadline**, at 100%. That is a
    // choice and it is the whole reason this block is safe to ship: today's
    // date decides how late an untransferred cycle is, so a seed that left it
    // open would put a fresh install anywhere from "due in 5 days" to "day 21,
    // executive orders" depending only on which day somebody ran `db:seed`.
    // Confirming on `due_on` is day-of-month independent and always reads as
    // compliant.
    const priorTotalMinor = liveTotalMinor - 6_250;
    const cycleRows = await db
      .insert(schema.wageCycles)
      .values([
      {
        tenantId: T1,
        periodMonth: priorPeriod,
        dueOn: priorDueOn,
        totalDue: toDecimalString(priorTotalMinor),
        totalTransferred: toDecimalString(priorTotalMinor),
        employeeCount: lines.length,
        paidEmployeeCount: lines.length,
        filePreparedOn: addDays(priorDueOn, -3),
        confirmedOn: priorDueOn,
        transferReference: "SIF-2026-0001",
        confirmedById: userIds.get("priya@meridianfm.example") ?? null,
        status: "closed",
        // Deliberately no `wage_payments` lines. History answers "have we ever
        // been late", which is the question a MOHRE inspection asks; it does
        // not need a per-person breakdown, and seeding one for every month back
        // would be noise pretending to be data.
        note: "Closed. Retained under the seven-year financial floor, not the two-year HR clock.",
      },
      {
        tenantId: T1,
        periodMonth: livePeriod,
        dueOn: liveDueOn,
        totalDue: toDecimalString(liveTotalMinor),
        totalTransferred: toDecimalString(liveTotalMinor),
        employeeCount: lines.length,
        paidEmployeeCount: lines.length,
        // Produced at T-3, which is what `HR-17` requires and what the cron
        // does unattended.
        filePreparedOn: addDays(liveDueOn, -3),
        confirmedOn: liveDueOn,
        transferReference: "SIF-2026-0002",
        confirmedById: userIds.get("priya@meridianfm.example") ?? null,
        status: "transferred",
      },
      ])
      .returning({ id: schema.wageCycles.id, periodMonth: schema.wageCycles.periodMonth });

    const liveCycle = cycleRows.find((c) => c.periodMonth === livePeriod);
    if (!liveCycle) throw new Error("failed to read back the live wage cycle");

    await db.insert(schema.wagePayments).values(
      lines.map((l) => ({
        tenantId: T1,
        wageCycleId: liveCycle.id,
        employeeId: l.employeeId,
        basic: toDecimalString(l.basicMinor),
        allowances: toDecimalString(l.allowancesMinor),
        overtime: toDecimalString(l.overtimeMinor),
        deductions: toDecimalString(l.deductionsMinor),
        net: toDecimalString(l.netMinor),
        overtimeMinutes: l.overtimeMinutes,
        absenceDays: 0,
        leaveDays: 0,
        paid: true,
        paidOn: liveDueOn,
      })),
    );

    // ── HR-19: one manpower supplier, with its paperwork ─────────────────
    //
    // Same rule as the employee documents above: seeded in the band BEFORE a
    // problem, not inside one. The liability policy at 75 days puts a row in
    // the 90-day sweep so the section is populated on a fresh install; nothing
    // is expired, because a seed that opens in breach trains everybody to
    // ignore the colour.
    //
    // The workers are here rather than as `technicians` deliberately. A
    // supplied worker is not an employee and must not be one — that would put
    // them in the payroll, the WPS wage file, the gratuity liability and the
    // Emiratisation denominator, four places they do not belong.
    const [supplier] = await db
      .insert(schema.subcontractors)
      .values({
        tenantId: T1,
        name: "Gulf Skilled Manpower LLC",
        kind: "manpower_supplier",
        tradeSlug: "electrical",
        contactName: "Rakesh Menon",
        contactPhone: "+971 4 555 0198",
        contactEmail: "ops@gulfskilled.example",
        tradeLicenceNo: "CR-742118",
        tradeLicenceExpiresOn: day(310),
        liabilityInsurer: "Oman Insurance",
        liabilityPolicyNo: "TPL-2026-88431",
        liabilityExpiresOn: day(75),
        workmenCompInsurer: "Daman",
        workmenCompPolicyNo: "WC-2026-11902",
        workmenCompExpiresOn: day(240),
        // Dubai Law No. 7 of 2025 requires prior approval to subcontract.
        approvalReference: "DM-SUB-2026-0417",
        // Fifteen digits, the same TRN_PATTERN a tax invoice enforces. Their
        // invoices to us carry it, and INV-6 decides full-versus-simplified on
        // exactly that basis.
        taxRegistrationNumber: "100482913600003",
        // The free-form tail: third-party certifications we neither issue nor
        // renew. Both in date, and the nearer one at 130 days is deliberately
        // OUTSIDE the 90-day sweep — a fresh install should not open with an
        // amber row it cannot act on.
        accreditations: [
          { name: "IRATA rope access — Level 3 supervisor", issuer: "IRATA International", expiresOn: day(130) },
          { name: "ISO 45001 occupational health and safety", issuer: "EIAC", expiresOn: day(500) },
        ],
        status: "approved",
        note: "Two electricians on the Bay Tower riser upgrade.",
      })
      .returning({ id: schema.subcontractors.id });
    if (!supplier) throw new Error("failed to insert the manpower supplier");

    await db.insert(schema.subcontractorWorkers).values([
      {
        tenantId: T1,
        subcontractorId: supplier.id,
        fullName: "Sanjay Raut",
        tradeSlug: "electrical",
        workPermitNo: "WP-4471182",
        workPermitExpiresOn: day(410),
        verifiedById: userIds.get("rania@meridianfm.example") ?? null,
        verifiedAt: ago(11 * DAY),
      },
      {
        tenantId: T1,
        subcontractorId: supplier.id,
        fullName: "Imran Sheikh",
        tradeSlug: "electrical",
        workPermitNo: "WP-4471183",
        // Inside the 90-day sweep. A permit is not a warning at 88 days; it is
        // the point at which a renewal is still cheap and unhurried.
        workPermitExpiresOn: day(88),
        verifiedById: userIds.get("rania@meridianfm.example") ?? null,
        verifiedAt: ago(11 * DAY),
      },
    ]);

    console.log(
      `  ${employeeSpecs.length} employment records, ${employeeSpecs.length * 5} statutory documents, ` +
        `2 wage cycles (live one transferred on time), 1 document expiring inside 30 days, ` +
        `1 manpower supplier with 2 permit-verified workers`,
    );
  }

  console.log(`\nDone. Sign in with any of:`);
  for (const s of staff) console.log(`  ${s.email.padEnd(32)} ${s.role}`);
  console.log(`  ${"fatima@baytower.example".padEnd(32)} customer portal (Bay Tower OA)`);
  console.log(`  ${"hana@gulfpropertycare.example".padEnd(32)} owner (tenant 2)`);
  console.log(`\nPassword for all: ${DEV_PASSWORD}\n`);

  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  await client.end();
  process.exit(1);
});
