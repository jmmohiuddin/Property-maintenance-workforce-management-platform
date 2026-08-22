-- =============================================================================
-- M9 — ATS-12's cool-off flag, and ATS-14's interview logistics.
--
-- Two unrelated-looking things in one migration because they are the two halves
-- of the same gap: the module could record that somebody applied and that
-- somebody was archived, and could record nothing at all about the two events
-- in between that a recruiter actually spends their day on — "we have seen this
-- person before, recently, for this exact role" and "we asked them to come to a
-- site at a time, and they need to know where to stand and what to wear".
--
-- ── 1. THE COOL-OFF FLAG (ATS-12), AND WHAT IT IS STRUCTURALLY NOT ──────────
--
-- ATS-12 asks that a re-application by the same person for the same role
-- surfaces the prior outcome AND a configurable cool-off flag. The prior
-- outcome was already built. This is the flag.
--
-- It is a FLAG THAT INFORMS A HUMAN. It is never an auto-rejection (ATS-19
-- forbids that outright) and never a filter (ATS-5 forbids that outright). The
-- shape below is what makes that structural rather than promised:
--
--   * The columns live on the application that was ALREADY CREATED. The
--     computation in app_public_submit_application runs after the INSERT has
--     returned an id, so there is no ordering in which the flag could have
--     decided whether to write the row. It annotates a row whose existence is
--     already final.
--   * Nothing reads cooloff_flag in a WHERE clause on any creation, matching or
--     offer path. The only readers are staff screens.
--   * app_public_application_status — the applicant's own view — does not
--     return it, and cannot: it builds a fixed jsonb object and the key is not
--     in it. The applicant is not told they were flagged, because being told
--     would make it a decision rather than a note.
--
-- cooloff_of_application_id rather than a bare boolean, matching this schema's
-- existing preference for a traceable reference over an assertion
-- (archived_at_stage_id, merged_into_candidate_id). "Flagged" with nothing to
-- click through to is a red dot a recruiter learns to ignore by the third time;
-- "flagged, and here is the application from 6 March that it refers to" is a
-- fact they can act on. The CHECK below refuses the bare-boolean version.
--
-- ── 2. INTERVIEW LOGISTICS (ATS-14) ─────────────────────────────────────────
--
-- Before this table there was no data model for a scheduled interview or site
-- trial anywhere in the system: no time, no place. "Come to the Al Quoz yard on
-- Tuesday" lived in a WhatsApp thread on one person's phone, which is also
-- where "bring your working-at-height card" lived, which is why the candidate
-- arrives without it.
--
-- The four reminder columns are two pairs, and the split is the point:
--
--   * reminder_24h_at / reminder_2h_at are WHEN the reminder should fire.
--     NULL means the window had already passed when the interview was booked —
--     an interview arranged for three hours from now never had a 24-hour
--     reminder to miss. NULL is the honest way to say that; stamping the sent
--     column would be a claim that a message went out.
--   * reminder_24h_sent_at / reminder_2h_sent_at are the claim. They are
--     written by a conditional UPDATE inside the same transaction that enqueues
--     the message, so an overlapping or retried cron run cannot send twice.
--
-- ── WHY THERE IS NO reschedule_token COLUMN ─────────────────────────────────
--
-- Because the token already exists. applications.status_token is a 64-character
-- unguessable secret held by exactly one person — the candidate whose interview
-- this is — and it already grants them a page about this application. An
-- interview belongs to exactly one application, so a second token would grant a
-- strict subset of what the first grants, to the same holder, for the same
-- purpose. What it would add is a second secret to leak, a second lookup to
-- rate-limit and a second "I lost the link" support call.
--
-- So the reschedule request is a write behind the existing token, through
-- app_public_request_interview_reschedule in sql/public-functions.sql. The
-- candidate asks; a person answers. It writes the two columns below and nothing
-- else — it cannot move the interview, because a candidate silently moving a
-- site trial that a supervisor has blocked two hours out for is not a feature.
--
-- ── AFTER APPLYING ──────────────────────────────────────────────────────────
--
-- interviews carries tenant_id as its first column, so the generic loop in
-- sql/rls.sql picks it up and applies FORCE ROW LEVEL SECURITY plus the tenant
-- policy without a line being written here. Re-run the WHOLE sql/ list in the
-- README's order afterwards — rls.sql ends with a blanket GRANT that later
-- files revoke, so running it alone re-opens rate_limits. verify-rls.sql check
-- 9 fails if the RLS pass is skipped entirely.
-- =============================================================================

-- ── ATS-12: the configurable window ─────────────────────────────────────────
--
-- Per requisition, because the answer genuinely differs by role: a supervisor
-- vacancy that runs a two-month process should not flag somebody re-applying
-- after six weeks, and a helper vacancy that turns over monthly should.
--
-- NULL means "use the platform default", which is RECRUITMENT_COOLOFF_DEFAULT_DAYS
-- in packages/core/src/recruitment.ts and the coalesce in
-- app_recruitment_cooloff_days. Those two numbers must agree, and
-- packages/db/test/recruitment.test.ts asserts they do rather than trusting it.
--
-- 0 means no cool-off at all, and it is a real value rather than a way of
-- spelling NULL: a tenant that wants re-application never flagged should be
-- able to say so, and have it survive a change to the default.
ALTER TABLE "job_requisitions" ADD COLUMN "cooloff_days" integer;--> statement-breakpoint

ALTER TABLE "job_requisitions"
	ADD CONSTRAINT "job_requisitions_cooloff_days_nonneg"
	CHECK ("cooloff_days" IS NULL OR "cooloff_days" >= 0);
--> statement-breakpoint

-- ── ATS-12: the annotation, on the application that already exists ──────────
ALTER TABLE "applications" ADD COLUMN "cooloff_flag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "cooloff_of_application_id" uuid;--> statement-breakpoint

ALTER TABLE "applications"
	ADD CONSTRAINT "applications_cooloff_of_fk"
	FOREIGN KEY ("cooloff_of_application_id") REFERENCES "applications"("id") ON DELETE set null;
--> statement-breakpoint

-- A flag with nothing to point at is the bare boolean this design rejected.
-- Refused here rather than in the writer, because the writer is one of several
-- things that could set it and this is the rule that has to hold for all of
-- them.
ALTER TABLE "applications"
	ADD CONSTRAINT "applications_cooloff_needs_referent"
	CHECK ("cooloff_flag" = false OR "cooloff_of_application_id" IS NOT NULL);
--> statement-breakpoint

-- The staff-screen predicate and nothing else. Partial, because on any real
-- pipeline almost every row is false.
CREATE INDEX "applications_cooloff_idx"
	ON "applications" ("tenant_id", "requisition_id")
	WHERE "cooloff_flag";
--> statement-breakpoint

-- ── ATS-14: the interview ───────────────────────────────────────────────────
CREATE TABLE "interviews" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	-- A site trial is not an interview and the candidate needs to know which
	-- one they are coming to: one wants a shirt, the other wants boots and a
	-- hard hat. Same table because the logistics are identical.
	"kind" varchar(24) DEFAULT 'interview' NOT NULL,
	"status" varchar(16) DEFAULT 'scheduled' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	-- ATS-14 names these four by name: where, parking, PPE, what to bring.
	-- Columns rather than one free-text "details" blob, because a blob is what
	-- gets half-filled: the person typing it remembers the address and forgets
	-- the hard hat, and nothing anywhere says a field is missing.
	"location_name" varchar(160) NOT NULL,
	"location_address" text NOT NULL,
	"location_area" varchar(120),
	"location_map_url" text,
	"parking_notes" text,
	-- A list, so the confirmation and the reminder render the same items in the
	-- same order and a site that requires a harness cannot have it lost in a
	-- sentence.
	"ppe_required" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bring_notes" text,
	-- Who to ask for on arrival, and the number to call when the gate is shut.
	-- The single most common reason a trade candidate turns around and leaves.
	"contact_name" varchar(160),
	"contact_phone" varchar(24),
	"confirmation_sent_at" timestamp with time zone,
	"confirmation_notification_id" uuid,
	-- When each reminder is due. NULL means the window had already passed when
	-- the interview was booked, which is a state and not a failure.
	"reminder_24h_at" timestamp with time zone,
	"reminder_24h_sent_at" timestamp with time zone,
	"reminder_2h_at" timestamp with time zone,
	"reminder_2h_sent_at" timestamp with time zone,
	-- Written by the candidate through app_public_request_interview_reschedule,
	-- behind the application status token. A request, never a move.
	"reschedule_requested_at" timestamp with time zone,
	"reschedule_request_note" varchar(400),
	"rescheduled_count" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" varchar(200),
	"scheduled_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "interviews_kind" CHECK ("kind" IN ('interview', 'site_trial')),
	CONSTRAINT "interviews_status" CHECK ("status" IN ('scheduled', 'cancelled', 'completed')),
	-- Fifteen minutes to ten hours. A zero-minute interview is a typo and a
	-- three-day one is a date range wearing the wrong column.
	CONSTRAINT "interviews_duration" CHECK ("duration_minutes" BETWEEN 15 AND 600),
	-- An address that is present but empty is the same missing address with an
	-- extra step, and the candidate finds out at the roundabout.
	CONSTRAINT "interviews_address_present" CHECK (btrim("location_address") <> ''),
	CONSTRAINT "interviews_location_present" CHECK (btrim("location_name") <> ''),
	CONSTRAINT "interviews_ppe_is_list" CHECK (jsonb_typeof("ppe_required") = 'array'),
	-- A reminder cannot have been sent for a window that was never due. This is
	-- the constraint that keeps the pair honest: without it, "sent" could be
	-- stamped to quieten the queue and the row would claim a message that never
	-- existed.
	CONSTRAINT "interviews_24h_sent_needs_due"
		CHECK ("reminder_24h_sent_at" IS NULL OR "reminder_24h_at" IS NOT NULL),
	CONSTRAINT "interviews_2h_sent_needs_due"
		CHECK ("reminder_2h_sent_at" IS NULL OR "reminder_2h_at" IS NOT NULL),
	CONSTRAINT "interviews_cancelled_has_time"
		CHECK ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL)
);
--> statement-breakpoint

ALTER TABLE "interviews"
	ADD CONSTRAINT "interviews_tenant_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "interviews"
	ADD CONSTRAINT "interviews_application_fk"
	FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "interviews"
	ADD CONSTRAINT "interviews_scheduled_by_fk"
	FOREIGN KEY ("scheduled_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint

CREATE INDEX "interviews_application_idx"
	ON "interviews" ("tenant_id", "application_id", "scheduled_at");
--> statement-breakpoint

-- The two cron predicates, each its own partial index, because the sweep runs
-- every fifteen minutes for ever and on a table where all but a handful of rows
-- are already sent or already past.
CREATE INDEX "interviews_reminder_24h_idx"
	ON "interviews" ("reminder_24h_at")
	WHERE "status" = 'scheduled'
	  AND "reminder_24h_at" IS NOT NULL
	  AND "reminder_24h_sent_at" IS NULL
	  AND "deleted_at" IS NULL;
--> statement-breakpoint

CREATE INDEX "interviews_reminder_2h_idx"
	ON "interviews" ("reminder_2h_at")
	WHERE "status" = 'scheduled'
	  AND "reminder_2h_at" IS NOT NULL
	  AND "reminder_2h_sent_at" IS NULL
	  AND "deleted_at" IS NULL;
--> statement-breakpoint

-- A candidate who has asked to move an interview and been answered by nobody is
-- the ATS-8 failure with a date attached to it. Indexed so the ask can be a
-- list on a screen rather than a thing somebody notices.
CREATE INDEX "interviews_reschedule_requested_idx"
	ON "interviews" ("tenant_id", "reschedule_requested_at")
	WHERE "reschedule_requested_at" IS NOT NULL;
