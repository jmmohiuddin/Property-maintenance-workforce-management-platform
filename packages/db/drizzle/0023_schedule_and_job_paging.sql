-- =============================================================================
-- JOB-7 schedule view, and LEAD-8 for jobs.
--
-- Indexes only. No table in this migration is new: job_visits, shifts and
-- leave_requests have existed since 0000 and the schedule is the first screen
-- that reads them together, which is most of what JOB-7 is.
-- =============================================================================

-- ── LEAD-8. Keyset pagination on the jobs list ──────────────────────────────
--
-- The jobs screen called the dispatch board's query with a limit of 300. That
-- is not the first three hundred jobs, it is every job after the three
-- hundredth being unreachable, with nothing on the screen saying so and no
-- second page to reach it by. PRD section 9 puts this tenant at 5,000 jobs a
-- year, so the cap is reached inside year one, and the rows it hides are the
-- oldest — which is precisely what somebody is looking for when they arrive
-- with a reference in their hand.
--
-- Keyset, not OFFSET, for the same two reasons as leads_keyset_idx in 0016: at
-- page 40 an OFFSET query has already read and discarded 39 pages, and a job
-- raised while somebody pages shifts every later page by one, so rows are
-- silently skipped. The cursor is created_at and id together, because
-- created_at is not unique and a tie makes the boundary ambiguous.
--
-- DESC, DESC to match the ORDER BY exactly, so the row-wise comparison in
-- searchJobs can be driven straight off this index.
CREATE INDEX IF NOT EXISTS "jobs_keyset_idx"
  ON "jobs" USING btree ("tenant_id", "created_at" DESC, "id" DESC);--> statement-breakpoint

-- LEAD-8 also asks for search, and both columns somebody actually types into
-- that box are matched with a leading wildcard. A leading wildcard defeats a
-- btree completely, so without these the search is a sequential scan wearing a
-- WHERE clause -- which is the TD-10 finding itself, reintroduced on a new
-- screen. Trigram GIN handles the leading wildcard.
--
-- Reference gets one as well as title. A dispatcher reading a reference off a
-- WhatsApp message types the tail of it far more often than the whole thing,
-- and the unique index on tenant_id and reference cannot serve that.
--
-- pg_trgm was created by 0016 and IF NOT EXISTS makes a re-run a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_title_trgm_idx"
  ON "jobs" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_reference_trgm_idx"
  ON "jobs" USING gin ("reference" gin_trgm_ops);--> statement-breakpoint

-- ── JOB-7. The schedule's range scan ────────────────────────────────────────
--
-- job_visits_tech_window_idx already exists, on tenant_id, technician_id and
-- scheduled_start. That is the right index for one technician's diary and the
-- wrong one for a schedule: the schedule asks for a date range across every
-- technician at once, and with technician_id leading, that is a scan of the
-- whole table per query.
--
-- This one leads with the window, which is the predicate, and carries the
-- technician afterwards so the lane grouping stays index-ordered. The range is
-- written in the query against the raw timestamptz column rather than against
-- the value converted to Dubai time, specifically so this index can drive it;
-- a predicate on the converted expression would not be sargable and this index
-- would sit unused while the query still looked correct.
CREATE INDEX IF NOT EXISTS "job_visits_schedule_idx"
  ON "job_visits" USING btree ("tenant_id", "scheduled_start", "technician_id");--> statement-breakpoint

-- The lane rail asks which open jobs have no live visit at all. That is an
-- anti-join keyed on job_id, and job_visits has no index leading with it -- the
-- sequence unique key starts with tenant_id and job_id, which serves it, but
-- only after the status filter has been applied as a heap check. Narrow index
-- on the two columns the NOT EXISTS actually reads.
CREATE INDEX IF NOT EXISTS "job_visits_job_status_idx"
  ON "job_visits" USING btree ("tenant_id", "job_id", "status");--> statement-breakpoint

-- HR-7 approved leave, read by the schedule for every lane and by
-- rescheduleVisit for one technician on one day. leave_tenant_window_idx
-- covers the first; this covers the second, where technician_id is the
-- selective column and the existing index cannot lead with it.
CREATE INDEX IF NOT EXISTS "leave_tech_window_idx"
  ON "leave_requests" USING btree ("tenant_id", "technician_id", "status", "starts_on", "ends_on");--> statement-breakpoint

-- Planned shifts, read by the schedule as a range across all technicians. Same
-- shape and same reason as job_visits_schedule_idx: shifts_tenant_window_idx
-- leads with starts_at already, so this only adds the technician for grouping.
CREATE INDEX IF NOT EXISTS "shifts_tech_window_idx"
  ON "shifts" USING btree ("tenant_id", "technician_id", "starts_at");
