import { pgTable, varchar, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { idCol } from "./_shared";

/**
 * Operational telemetry about the platform itself.
 *
 * Nothing here is tenant data, and that is why `cron_runs` has no `tenant_id`.
 * The generic RLS policy loop in sql/rls.sql keys on the presence of that
 * column, so it skips this table — correctly. A scheduled job runs across the
 * whole database with no tenant context; scoping its own run record to a tenant
 * would be inventing a boundary that does not exist.
 */

/**
 * One row per scheduled run, written by the route itself.
 *
 * The point of this table is `/api/cron/health`: it reads the last finish time
 * per job and alerts when one is overdue. Without it a cron that stops firing
 * is invisible — and a scheduler that fails silently is precisely the failure
 * that scheduled work was introduced to prevent. Monitoring the monitor is the
 * cheap part; leaving it out is what makes everything downstream untrustworthy.
 */
export const cronRuns = pgTable(
  "cron_runs",
  {
    id: idCol(),
    /** Matches the route segment: `dispatch`, `sweep`, `sla`, `health`, … */
    job: varchar("job", { length: 48 }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    /** NULL while running. A row that stays NULL is a crashed or hung run. */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** `running` | `ok` | `failed`. */
    outcome: varchar("outcome", { length: 16 }).notNull().default("running"),
    itemsProcessed: integer("items_processed").notNull().default(0),
    /** Job-specific counts, e.g. `{ breaches: 1, notified: 2 }`. */
    detail: jsonb("detail").notNull().default({}),
    error: text("error"),
  },
  (t) => [
    index("cron_runs_job_started_idx").on(t.job, t.startedAt.desc()),
    index("cron_runs_unfinished_idx").on(t.startedAt).where(sql`${t.finishedAt} is null`),
  ],
);
