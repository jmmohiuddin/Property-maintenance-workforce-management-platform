import { pgTable, varchar, text, timestamp, uuid, jsonb, index, boolean, integer } from "drizzle-orm/pg-core";
import { idCol, timestamps } from "./_shared";
import { tenants, users } from "./tenancy";

/**
 * Append-only audit trail. Written by a Postgres trigger rather than
 * application code, because an audit log that the application can forget to
 * write is not an audit log. No UPDATE or DELETE grant exists on this table for
 * the application role — see sql/rls.sql.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    tableName: varchar("table_name", { length: 64 }).notNull(),
    recordId: uuid("record_id"),
    /** "insert" | "update" | "delete" */
    action: varchar("action", { length: 16 }).notNull(),
    /** Only the columns that actually changed, old and new. */
    changedFields: jsonb("changed_fields"),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorKind: varchar("actor_kind", { length: 16 }).notNull().default("user"),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: text("user_agent"),
    requestId: varchar("request_id", { length: 64 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_tenant_time_idx").on(t.tenantId, t.occurredAt),
    index("audit_log_record_idx").on(t.tableName, t.recordId),
    index("audit_log_actor_idx").on(t.actorId, t.occurredAt),
  ],
);

/**
 * Every AI call that influenced a business record. Kept because "the system
 * quoted the wrong price" needs to be answerable six months later, and because
 * cost-per-tenant is otherwise invisible.
 */
export const aiInteractions = pgTable(
  "ai_interactions",
  {
    id: idCol(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    /** "triage" | "quote_draft" | "dispatch_score" | "report_summary" | "receptionist" | … */
    capability: varchar("capability", { length: 48 }).notNull(),
    model: varchar("model", { length: 64 }).notNull(),
    /** Hash rather than the prompt itself — prompts can carry customer PII. */
    promptHash: varchar("prompt_hash", { length: 64 }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    costMicros: integer("cost_micros"),
    /** The record this call produced or modified. */
    subjectTable: varchar("subject_table", { length: 64 }),
    subjectId: uuid("subject_id"),
    /** Did a human accept the AI's output unchanged? Null until reviewed. */
    acceptedByHuman: boolean("accepted_by_human"),
    reviewedById: uuid("reviewed_by_id").references(() => users.id, { onDelete: "set null" }),
    /** Model's own confidence where it reports one, 0–10000 basis points. */
    confidenceBasisPoints: integer("confidence_basis_points"),
    error: text("error"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ai_interactions_tenant_cap_idx").on(t.tenantId, t.capability, t.occurredAt),
    index("ai_interactions_subject_idx").on(t.subjectTable, t.subjectId),
  ],
);

/** Outbound notification ledger — one row per delivery attempt per channel. */
export const notifications = pgTable(
  "notifications",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** "email" | "sms" | "whatsapp" | "push" | "in_app" */
    channel: varchar("channel", { length: 16 }).notNull(),
    template: varchar("template", { length: 64 }).notNull(),
    recipientUserId: uuid("recipient_user_id").references(() => users.id, { onDelete: "cascade" }),
    recipientAddress: varchar("recipient_address", { length: 200 }).notNull(),
    subjectTable: varchar("subject_table", { length: 64 }),
    subjectId: uuid("subject_id"),
    payload: jsonb("payload").notNull().default({}),
    /** "queued" | "sent" | "delivered" | "failed" | "bounced" */
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    providerMessageId: varchar("provider_message_id", { length: 120 }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("notifications_status_idx").on(t.tenantId, t.status, t.createdAt),
    index("notifications_subject_idx").on(t.tenantId, t.subjectTable, t.subjectId),
  ],
);
