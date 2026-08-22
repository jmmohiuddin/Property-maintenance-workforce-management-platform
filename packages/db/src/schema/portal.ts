import { pgTable, varchar, boolean, timestamp, uuid, uniqueIndex } from "drizzle-orm/pg-core";
import { idCol } from "./_shared";
import { tenants, users } from "./tenancy";
import { customers } from "./crm";

/**
 * Per-event notification opt-out for the customer portal (`POR-5`).
 *
 * ── WHY A ROW PER EVENT AND NOT A BOOLEAN ON `customers` ────────────────────
 *
 * The requirement names seven distinct events, and they are not one preference:
 * "technician en route" is worth a message the moment it happens and is worth
 * nothing an hour later, while "invoice issued" matters to whoever pays and to
 * nobody else. A single "email me about jobs" switch is what makes a customer
 * turn everything off to stop the one message they did not want — and the one
 * they silently lose is the quote awaiting their decision, which is the message
 * the business most needed them to read.
 *
 * ── ABSENCE MEANS OPTED IN ──────────────────────────────────────────────────
 *
 * There is no row until somebody opts out. That keeps the default in one place
 * (this table's absence) rather than in a backfill that has to run for every
 * customer that ever existed, and it makes the stored data mean something
 * specific: every row here is a choice a person made, with a timestamp and a
 * user against it.
 *
 * Scoped to the customer rather than to the portal user, because the events are
 * facts about the account. An invoice is issued to the account; a second
 * building manager joining should not silently start from a different set of
 * preferences than the first.
 */
export const customerNotificationPreferences = pgTable(
  "customer_notification_preferences",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    /** One of `CUSTOMER_NOTIFICATION_EVENTS`, checked in the database too. */
    event: varchar("event", { length: 40 }).notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    /** Who changed it. A preference nobody can attribute is a preference
     *  somebody will later insist they never set. */
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("customer_notification_prefs_key").on(t.tenantId, t.customerId, t.event)],
);
