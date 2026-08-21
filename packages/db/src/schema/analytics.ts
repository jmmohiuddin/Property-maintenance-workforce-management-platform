import { pgTable, varchar, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { idCol } from "./_shared";
import { tenants, users } from "./tenancy";

/**
 * The product event stream (`KPI-2`).
 *
 * Written by database triggers, not by application code — `0017_kpi_and_admin`
 * carries the emitters and the argument for putting them there. The same
 * reasoning as `audit_log`: an event an application can forget to emit is an
 * event that will be missing from exactly the week somebody needed it, and
 * unlike a missing audit row a missing event silently changes a denominator.
 *
 * This table is declared here so `drizzle-kit generate` knows it exists. If it
 * were only in the migration, the next generated diff would propose dropping
 * it — which is how a table added by hand disappears three migrations later.
 *
 * ── DELIBERATELY NOT `audit_log` ────────────────────────────────────────────
 *
 * The two look similar and are not interchangeable. `audit_log` answers "who
 * changed this record, and to what" for a regulator, is append-only at the
 * privilege level (UPDATE and DELETE revoked from `meridian_app`), and covers
 * every column of every audited row. This table answers "how is the business
 * doing" for the owner, holds derived measures rather than column diffs, and
 * carries no such guarantee. Reporting off `audit_log` would mean parsing
 * `changed_fields` blobs to reconstruct a funnel; auditing off this table would
 * mean trusting telemetry as evidence. Both are worse than having two tables.
 */
export const productEvents = pgTable(
  "product_events",
  {
    // tenant_id first, so the generic policy loop in sql/rls.sql covers this
    // table the moment it is re-run rather than when somebody remembers.
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Chosen from `PRODUCT_EVENT_NAMES`, never typed at a call site. */
    eventName: varchar("event_name", { length: 48 }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null for anything a scheduler did. A cron run has no actor, and naming
     *  one would put a person against a change they did not make. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorKind: varchar("actor_kind", { length: 16 }).notNull().default("user"),
    entityType: varchar("entity_type", { length: 48 }),
    entityId: uuid("entity_id"),
    /** Measures, statuses, durations and slugs. Never PII — these rows outlive
     *  the records they describe, and a retention purge cannot delete a name it
     *  cannot find. */
    properties: jsonb("properties").notNull().default({}),
  },
  (t) => [
    index("product_events_name_time_idx").on(t.tenantId, t.eventName, t.occurredAt),
    index("product_events_entity_idx").on(t.tenantId, t.entityType, t.entityId, t.occurredAt),
  ],
);
