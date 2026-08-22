-- The two columns that make the projects chase sweep safe to run every day.
--
-- `M5` finishes with a scheduled sweep -- `/api/cron/projects` -- that chases
-- the three things in this module nobody is otherwise reminded of: retention
-- that has fallen due (`PRJ-5`), a permit about to expire under a project
-- that is on site (`PRJ-6`), and a subcontractor engagement working without
-- the employer's prior approval (`PRJ-9`, Dubai Law No. 7 of 2025).
--
-- ── WHY A TIMESTAMP AND NOT A LADDER ────────────────────────────────────────
--
-- `project_retention.last_reminded_at` already exists and 0029's note beside it
-- states the rule these two columns follow: a chase is the same message to the
-- same person until the thing is dealt with, so what matters is only "have we
-- asked recently", which one timestamp answers. That is the opposite of
-- `contract_renewal_notices`, which is a ladder of four *different* messages at
-- T-90/T-60/T-30/T-7 and therefore needs a row per rung.
--
-- The column is what makes the sweep idempotent in the only sense that counts.
-- Re-running it cannot double-charge anything -- it writes no money -- but it
-- can send the same accounts contact the same email at 06:00 every morning
-- forever, and a daily email nobody can stop is an email everybody filters,
-- which is indistinguishable from the sweep not existing. Suppression is not a
-- politeness here; it is the thing that keeps the alert readable.
--
-- ── WHY NULLABLE, WITH NO DEFAULT ───────────────────────────────────────────
--
-- NULL means "never asked", and it must sort first in the chase list. A
-- DEFAULT now() would silently mark every engagement already in the register as
-- having been chased today -- on the day this migration runs, the entire
-- backlog the sweep exists to surface would be suppressed for a full window,
-- and it would look like the feature works.

-- ── PRJ-6: the permit that expires while the project is on site ─────────────
--
-- The register's on-site gate already treats an *expired* approved permit as
-- blocking -- that comparison is a `YYYY-MM-DD` string comparison the whole way
-- down, and `projects.test.ts` pins it with a permit that expired yesterday.
-- What has been missing is anyone finding out before the expiry rather than
-- after: a fit-out permit lapsing mid-project does not stop the site, it stops
-- the *next* status transition, so it is discovered by an operations manager
-- who cannot understand why the button is refusing them.
ALTER TABLE "project_permits" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint

-- ── PRJ-9: the engagement working without the employer's approval ──────────
--
-- 0033's note on `client_approval_state` explains why the approval lives on the
-- engagement and not on the organisation, and why it defaults to 'pending'
-- rather than 'not_required'. The consequence of that default is this column:
-- an engagement created in a hurry sits at 'pending' indefinitely, the crew
-- turns up, and the state that was supposed to be a gate becomes a field
-- nobody looked at again. Law No. 7 of 2025 requires the approval *prior* to
-- subcontracting, so an engagement whose start date has arrived while still
-- 'pending' is not a reminder -- it is already the wrong side of the line, and
-- the sweep reports it every run while that stays true.
ALTER TABLE "project_subcontracts" ADD COLUMN "last_reminded_at" timestamp with time zone;--> statement-breakpoint

-- The chase list's own index: which engagements are unapproved, least recently
-- asked about first. `last_reminded_at` is the third column rather than the
-- second because the sweep filters on the state and *orders* by the timestamp,
-- and NULLS FIRST on an ascending btree is the default -- so "never asked"
-- comes off the front of the index without a sort.
CREATE INDEX "project_subcontracts_approval_idx"
	ON "project_subcontracts" USING btree ("tenant_id","client_approval_state","last_reminded_at");
