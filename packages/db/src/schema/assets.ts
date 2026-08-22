import {
  pgTable,
  varchar,
  boolean,
  integer,
  timestamp,
  uuid,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol } from "./_shared";
import { tenants } from "./tenancy";

/**
 * What an asset is *allowed to be* (`CON-13`).
 *
 * The register itself lives in `./crm.ts` next to the properties it hangs off.
 * This is the vocabulary its `category_id` points at, and it is a table for the
 * same reason `fault_codes` and `job_outcome_codes` are tables rather than
 * free-text columns: the question the register exists to answer is asked across
 * rows, not within one.
 *
 * "How many chillers do we maintain, and what does servicing one cost us" is
 * the number a commercial AMC is priced from and the number a tender asks for.
 * A kind typed by hand gives "chiller", "Chiller", "chiler" and "AC plant" for
 * one thing, and that question stops having an answer — permanently, because by
 * the time anyone asks it the history is already written. The PPM interval
 * hangs off the kind for the same reason: a chiller is serviced quarterly and a
 * water tank cleaned twice a year whoever enters it.
 *
 * Retirement is `is_active`, never deletion: a kind still attached to installed
 * plant cannot be removed without rewriting the register.
 *
 * Not yet administrator-editable. `/admin/reference` has a tab per vocabulary
 * and this one has no tab, so today the list is what the seed and migration 0021
 * put there. That is a gap, not a design.
 */
export const assetCategories = pgTable(
  "asset_categories",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: idCol(),
    /** Stable machine key. Reports group on this, so a label can be reworded. */
    code: varchar("code", { length: 32 }).notNull(),
    label: varchar("label", { length: 120 }).notNull(),
    description: varchar("description", { length: 400 }),
    /** Which trade services this kind. Matches a catalogue service slug. */
    serviceSlug: varchar("service_slug", { length: 64 }),
    /**
     * The PPM period an asset of this kind gets when nobody overrides it. Null
     * means the kind has no standard interval and the register asks per asset.
     */
    defaultPpmIntervalDays: integer("default_ppm_interval_days"),
    sortOrder: integer("sort_order").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("asset_categories_code_key").on(t.tenantId, t.code),
    index("asset_categories_pick_idx").on(t.tenantId, t.isActive, t.sortOrder),
  ],
);
