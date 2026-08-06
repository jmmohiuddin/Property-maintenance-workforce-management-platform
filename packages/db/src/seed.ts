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
import { computeSlaDeadlines, type JobPriority } from "@meridian/core";

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
  for (const table of [
    // Counters go first: a stale counter would keep allocating above the
    // references this seed writes, which is harmless but makes the seeded
    // data confusing to read.
    schema.referenceCounters,
    schema.payments,
    schema.invoiceLines,
    schema.invoices,
    schema.quoteLines,
    schema.quotes,
    schema.contractVisits,
    schema.contractProperties,
    schema.contracts,
    schema.communications,
    schema.leads,
    schema.jobEvents,
    schema.jobVisits,
    schema.jobReports,
    schema.jobMaterials,
    schema.jobAttachments,
    schema.jobSignoffs,
    schema.jobs,
    schema.technicianSkills,
    schema.technicians,
    schema.assets,
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
      slug: "meridian",
      legalName: "Meridian Facilities Management LLC",
      brandName: "Meridian Facilities",
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
