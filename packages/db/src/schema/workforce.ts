import {
  pgTable,
  varchar,
  text,
  boolean,
  integer,
  smallint,
  timestamp,
  uuid,
  jsonb,
  doublePrecision,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol, timestamps, money, currencyCol, employmentType, attendanceKind } from "./_shared";
import { tenants, users } from "./tenancy";
import { customers, properties } from "./crm";

/**
 * A technician is a person who does field work. Separate from `users` because
 * not every technician needs a login (some are supplied labour on a client
 * site) and technician-specific fields would otherwise pollute the auth table.
 */
export const technicians = pgTable(
  "technicians",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    employeeCode: varchar("employee_code", { length: 32 }).notNull(),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    phone: varchar("phone", { length: 24 }).notNull(),
    email: varchar("email", { length: 200 }),
    photoUrl: text("photo_url"),
    employment: employmentType("employment").notNull().default("direct"),
    /** Primary trade — matches a catalogue service slug. */
    primaryTrade: varchar("primary_trade", { length: 64 }).notNull(),
    /** Grade drives both dispatch preference and charge-out rate. */
    grade: varchar("grade", { length: 24 }).notNull().default("technician"),
    supervisorId: uuid("supervisor_id"),
    /** Where the technician starts and ends their day — the routing origin. */
    baseLat: doublePrecision("base_lat"),
    baseLng: doublePrecision("base_lng"),
    baseCity: varchar("base_city", { length: 80 }),
    hourlyCost: money("hourly_cost"),
    hourlyCharge: money("hourly_charge"),
    currency: currencyCol(),
    /** Deployed full-time to a client under a workforce-supply contract. */
    deployedCustomerId: uuid("deployed_customer_id").references(() => customers.id, { onDelete: "set null" }),
    deployedPropertyId: uuid("deployed_property_id").references(() => properties.id, { onDelete: "set null" }),
    visaExpiresOn: timestamp("visa_expires_on", { withTimezone: true }),
    joinedOn: timestamp("joined_on", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("technicians_tenant_code_key").on(t.tenantId, t.employeeCode),
    index("technicians_tenant_trade_idx").on(t.tenantId, t.primaryTrade, t.isActive),
    index("technicians_deployed_idx").on(t.tenantId, t.deployedCustomerId),
  ],
);

/**
 * Skills a technician can be dispatched against. Kept separate from
 * `primary_trade` because the dispatch engine matches on ANY qualifying skill —
 * a plumber who is also certified for pumps should be reachable for both.
 */
export const technicianSkills = pgTable(
  "technician_skills",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    serviceSlug: varchar("service_slug", { length: 64 }).notNull(),
    /** 1 trainee … 5 expert. Dispatch prefers the lowest grade that qualifies. */
    proficiency: smallint("proficiency").notNull().default(3),
    verifiedById: uuid("verified_by_id").references(() => users.id, { onDelete: "set null" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("technician_skills_key").on(t.tenantId, t.technicianId, t.serviceSlug),
    index("technician_skills_lookup_idx").on(t.tenantId, t.serviceSlug, t.proficiency),
  ],
);

/**
 * Certifications with expiry. Dispatch must refuse to assign a technician whose
 * required certification has lapsed — that is a liability question, not a
 * preference, so expiry is indexed and checked at assignment time.
 */
export const technicianCertifications = pgTable(
  "technician_certifications",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    issuer: varchar("issuer", { length: 160 }),
    reference: varchar("reference", { length: 80 }),
    documentUrl: text("document_url"),
    issuedOn: timestamp("issued_on", { withTimezone: true }),
    expiresOn: timestamp("expires_on", { withTimezone: true }),
    /** Service slugs this certification is mandatory for. */
    requiredForServices: jsonb("required_for_services").notNull().default([]),
    ...timestamps,
  },
  (t) => [
    index("tech_certs_technician_idx").on(t.tenantId, t.technicianId),
    index("tech_certs_expiry_idx").on(t.tenantId, t.expiresOn),
  ],
);

/** Planned working pattern. The dispatcher's capacity picture starts here. */
export const shifts = pgTable(
  "shifts",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    /** "standard" | "night" | "on_call" | "overtime" */
    kind: varchar("kind", { length: 24 }).notNull().default("standard"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [index("shifts_tenant_window_idx").on(t.tenantId, t.startsAt, t.endsAt)],
);

/** Approved absence. Dispatch treats these as hard unavailability. */
export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 32 }).notNull().default("annual"),
    startsOn: timestamp("starts_on", { withTimezone: true }).notNull(),
    endsOn: timestamp("ends_on", { withTimezone: true }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    reason: text("reason"),
    approvedById: uuid("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("leave_tenant_window_idx").on(t.tenantId, t.startsOn, t.endsOn, t.status)],
);

/**
 * Raw attendance events rather than computed hours. Storing the events means a
 * payroll dispute can always be reconstructed; derived totals live in views.
 */
export const attendanceEvents = pgTable(
  "attendance_events",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    kind: attendanceKind("kind").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** Metres between the reported position and the expected site. */
    accuracyMetres: integer("accuracy_metres"),
    /** False when the position falls outside the site geofence. */
    withinGeofence: boolean("within_geofence"),
    /** Set when the event was queued offline and synced later. */
    recordedOfflineAt: timestamp("recorded_offline_at", { withTimezone: true }),
    deviceId: varchar("device_id", { length: 80 }),
    ...timestamps,
  },
  (t) => [index("attendance_tech_time_idx").on(t.tenantId, t.technicianId, t.occurredAt)],
);

/** Point-in-time technician position, for live tracking and nearest-tech lookup. */
export const technicianLocations = pgTable(
  "technician_locations",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    lat: doublePrecision("lat").notNull(),
    lng: doublePrecision("lng").notNull(),
    headingDegrees: integer("heading_degrees"),
    speedKph: integer("speed_kph"),
    batteryPercent: smallint("battery_percent"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("tech_locations_latest_idx").on(t.tenantId, t.technicianId, t.recordedAt),
    // High-churn table: partition or roll off to cold storage beyond 30 days.
    // See docs/architecture/04-data-lifecycle.md.
  ],
);

/** Per-period performance snapshot used by dashboards and commission runs. */
export const technicianPerformance = pgTable(
  "technician_performance",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    jobsCompleted: integer("jobs_completed").notNull().default(0),
    firstTimeFixCount: integer("first_time_fix_count").notNull().default(0),
    revisitCount: integer("revisit_count").notNull().default(0),
    /** Basis points (8500 = 85.00%) — avoids float drift in reports. */
    slaMetBasisPoints: integer("sla_met_basis_points"),
    avgRatingBasisPoints: integer("avg_rating_basis_points"),
    billableMinutes: integer("billable_minutes").notNull().default(0),
    travelMinutes: integer("travel_minutes").notNull().default(0),
    revenueGenerated: money("revenue_generated"),
    currency: currencyCol(),
    ...timestamps,
  },
  (t) => [uniqueIndex("tech_perf_period_key").on(t.tenantId, t.technicianId, t.periodStart, t.periodEnd)],
);
