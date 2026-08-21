-- Phase 0 — Stabilise.
--
-- Three changes, all from the v2.0 specification set:
--
--   DB-1    users.failed_login_count varchar(8) -> integer. It has always been
--           an integer that happened to be stored as text and cast on every
--           read; the cast is an off-by-type bug waiting for a value the
--           application did not write.
--   SEC-4   users.locked_until. Lockout is currently permanent and can only be
--           cleared with a database client, while the UI promises "temporarily
--           locked". This column is the mechanism that makes the copy true.
--   ADM-5   cron_runs. Every scheduled route records its own run here, and
--           /api/cron/health reads the table to detect a cron that stopped
--           firing. A scheduler that fails silently is the failure the whole
--           scheduled-work section exists to prevent, so the scheduler is
--           itself monitored.

-- ── DB-1 ────────────────────────────────────────────────────────────────────
-- USING clause carries existing values across. Empty string and NULL both
-- become 0 rather than failing the migration on a row nobody remembers writing.
ALTER TABLE "users"
  ALTER COLUMN "failed_login_count" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "failed_login_count" TYPE integer
  USING COALESCE(NULLIF("failed_login_count", '')::integer, 0);
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "failed_login_count" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "users"
  ALTER COLUMN "failed_login_count" SET NOT NULL;
--> statement-breakpoint

-- ── SEC-4 ───────────────────────────────────────────────────────────────────
ALTER TABLE "users" ADD COLUMN "locked_until" timestamp with time zone;
--> statement-breakpoint

-- ── ADM-5 ───────────────────────────────────────────────────────────────────
-- No tenant_id, deliberately. This is operational telemetry about the process,
-- not business data: job name, timings, counts and an error string. The generic
-- RLS policy loop in sql/rls.sql keys on the presence of a tenant_id column and
-- therefore skips this table, which is correct — there is nothing here to
-- isolate, and a cron running across the whole database has no tenant context
-- to be scoped to.
CREATE TABLE "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" varchar(48) NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" varchar(16) NOT NULL DEFAULT 'running',
	"items_processed" integer DEFAULT 0 NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
-- /api/cron/health asks "when did each job last finish?" — one index answers it.
CREATE INDEX "cron_runs_job_started_idx" ON "cron_runs" USING btree ("job","started_at" DESC);
--> statement-breakpoint
-- The stuck-run sweep asks "what started and never finished?".
CREATE INDEX "cron_runs_unfinished_idx" ON "cron_runs" USING btree ("started_at") WHERE "finished_at" IS NULL;
