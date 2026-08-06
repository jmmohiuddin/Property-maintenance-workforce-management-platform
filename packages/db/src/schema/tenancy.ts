import {
  pgTable,
  varchar,
  text,
  bigint,
  boolean,
  integer,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol, timestamps, userRole } from "./_shared";

/**
 * A tenant is one maintenance company operating on the platform. It is the root
 * of every RLS policy — nothing except this table and `users` is readable
 * without a tenant context set on the connection.
 */
export const tenants = pgTable(
  "tenants",
  {
    id: idCol(),
    slug: varchar("slug", { length: 64 }).notNull(),
    legalName: varchar("legal_name", { length: 200 }).notNull(),
    brandName: varchar("brand_name", { length: 120 }).notNull(),
    /** Custom domain for the tenant's public site, if they run one. */
    domain: varchar("domain", { length: 200 }),
    countryCode: varchar("country_code", { length: 2 }).notNull().default("AE"),
    defaultCurrency: varchar("default_currency", { length: 3 }).notNull().default("AED"),
    timezone: varchar("timezone", { length: 64 }).notNull().default("Asia/Dubai"),
    /** Brand, SLA defaults, feature flags, working hours. Schema-validated in app code. */
    settings: jsonb("settings").notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("tenants_slug_key").on(t.slug), uniqueIndex("tenants_domain_key").on(t.domain)],
);

/**
 * Users are global (one person can work for two tenants, and customers may hold
 * accounts with several providers). Tenant binding lives in `memberships`.
 */
export const users = pgTable(
  "users",
  {
    id: idCol(),
    email: varchar("email", { length: 200 }).notNull(),
    phone: varchar("phone", { length: 24 }),
    fullName: varchar("full_name", { length: 160 }).notNull(),
    avatarUrl: text("avatar_url"),
    locale: varchar("locale", { length: 8 }).notNull().default("en"),
    passwordHash: text("password_hash"),
    mfaEnabledAt: timestamp("mfa_enabled_at", { withTimezone: true }),
    mfaSecret: text("mfa_secret"),
    /**
     * The last TOTP step this user successfully authenticated with.
     *
     * A code stays valid for its whole 30-second step, so without this a code
     * read over a shoulder — or captured by a phishing page — can be replayed
     * seconds later. Refusing any step at or below this one closes that window.
     */
    mfaLastStep: bigint("mfa_last_step", { mode: "number" }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Consecutive failures; reset on success. Drives lockout. */
    failedLoginCount: varchar("failed_login_count", { length: 8 }).notNull().default("0"),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_key").on(t.email), index("users_phone_idx").on(t.phone)],
);

/** Which tenant a user belongs to, and with what role. */
export const memberships = pgTable(
  "memberships",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRole("role").notNull().default("readonly"),
    /**
     * Fine-grained overrides on top of the role, e.g. {"jobs:delete": false}.
     * Roles are the default; this exists so a tenant can tighten without us
     * inventing a new role for every combination.
     */
    permissionOverrides: jsonb("permission_overrides").notNull().default({}),
    /** Set when the membership is a customer-portal login rather than staff. */
    customerId: uuid("customer_id"),
    isActive: boolean("is_active").notNull().default(true),
    invitedAt: timestamp("invited_at", { withTimezone: true }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("memberships_tenant_user_key").on(t.tenantId, t.userId),
    index("memberships_tenant_role_idx").on(t.tenantId, t.role),
    index("memberships_customer_idx").on(t.customerId),
  ],
);

/** Refresh/session records so a compromised device can be revoked individually. */
export const sessions = pgTable(
  "sessions",
  {
    id: idCol(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 45 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_key").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/**
 * Per-tenant document-number allocator.
 *
 * Counting existing rows to derive the next reference has two failure modes
 * that both bite in production. Two simultaneous inserts read the same count
 * and collide on the unique index; and under the customer-scope policies a
 * portal user counts only *their own* jobs, so the number they get has already
 * been used by someone else in the same tenant.
 *
 * A counter row makes allocation a single atomic UPDATE, and the allocator
 * runs SECURITY DEFINER so the customer restriction cannot blind it. See
 * `sql/reference.sql`.
 */
export const referenceCounters = pgTable(
  "reference_counters",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** "JOB", "QUO", "INV". */
    prefix: varchar("prefix", { length: 8 }).notNull(),
    year: integer("year").notNull(),
    lastValue: integer("last_value").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("reference_counters_key").on(t.tenantId, t.prefix, t.year)],
);

/**
 * Rate-limit buckets for unauthenticated endpoints.
 *
 * Deliberately has no `tenant_id`. The public quote form is rate limited before
 * a tenant is resolved - and an attacker must not be able to get a fresh
 * allowance by aiming at a different tenant, which is exactly what keying this
 * per tenant would hand them.
 *
 * In-process counters are not an option: every serverless invocation is its own
 * process, so an in-memory limit resets on each request and limits nothing. The
 * counter has to live somewhere shared, and the database is already shared.
 *
 * Written only by `app_public_rate_limit()`. RLS is enabled with no policy, so
 * the application role cannot read or write it directly even though the blanket
 * grant in rls.sql names it.
 */
export const rateLimits = pgTable("rate_limits", {
  /** Opaque, caller-composed: "quote:<ip>". Never a bare user input. */
  bucket: varchar("bucket", { length: 200 }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
  hits: integer("hits").notNull().default(0),
});

/**
 * A login that has passed the password but not yet the second factor.
 *
 * Deliberately not a session with a flag on it: a half-authenticated row in
 * `sessions` is one forgotten `WHERE` away from being treated as a real login.
 * A separate table with its own short life and its own attempt counter cannot
 * be mistaken for a session by any query that does not name it.
 *
 * The raw token lives only in the client cookie; the hash is stored, exactly
 * as sessions do it.
 */
export const mfaChallenges = pgTable(
  "mfa_challenges",
  {
    id: idCol(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** Wrong codes on this challenge. A handful, then it is dead. */
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("mfa_challenges_token_key").on(t.tokenHash),
    index("mfa_challenges_expiry_idx").on(t.expiresAt),
  ],
);

/**
 * Single-use recovery codes.
 *
 * Stored as SHA-256 hashes rather than Argon2, for the same reason session
 * tokens are: these are 50 bits of CSPRNG output with no structure to guess at,
 * so there is nothing for a slow hash to buy, and the check runs while someone
 * locked out of their account is waiting.
 */
export const userRecoveryCodes = pgTable(
  "user_recovery_codes",
  {
    id: idCol(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("user_recovery_codes_key").on(t.userId, t.codeHash),
    index("user_recovery_codes_user_idx").on(t.userId, t.usedAt),
  ],
);
