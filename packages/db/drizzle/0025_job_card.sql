-- The job card, enforced (JOB-15).
--
-- JOB-15 reads: a job cannot be marked complete without an outcome code, at
-- least one after photo (or an explicit reason-coded exemption), materials
-- recorded or explicitly none, and labour time -- enforced in the domain layer,
-- not the UI.
--
-- 0024 built the outcome half. The other three conditions were not enforced
-- anywhere, and the tables they would be enforced against have been in the
-- schema since 0000 with nothing writing to them: job_attachments was
-- referenced by one domain file and no web code, job_materials the same,
-- job_signoffs by nothing at all.
--
-- ── WHAT THIS MIGRATION ADDS, AND WHY EACH PIECE IS NEEDED ──────────────────
--
-- Two of the four conditions can be satisfied by rows in tables that already
-- exist: a photo is a job_attachments row with kind photo_after, and labour is
-- job_visits.work_minutes, an integer column that has been there since 0000 and
-- that nothing has ever set. Those need no schema at all, only write paths.
--
-- The other two need somewhere to record an assertion rather than a record, and
-- there was nowhere:
--
--   * "materials explicitly none" cannot be represented by an empty
--     job_materials. No rows means either that no parts were fitted or that
--     nobody filled the section in, and those two have opposite meanings for
--     job costing, for stock reordering and for a warranty argument six months
--     later. The clause exists precisely to tell them apart.
--
--   * "an explicit reason-coded exemption" is a controlled vocabulary by the
--     requirement's own wording. A text box collects "n/a", "-", "camera" and
--     "no photo needed" for the same situation, and nobody can then answer the
--     question this data is for: are photos missing because some work is
--     genuinely unphotographable, or because one crew has learnt that typing
--     anything gets them past the gate.

-- ── The exemption vocabulary ────────────────────────────────────────────────
--
-- Tenant-scoped like every other vocabulary here, so a company can reword a
-- label without changing what reports group on, and retire an entry without
-- rewriting the jobs that cite it. Seeded in packages/db/src/seed.ts: a
-- controlled list that ships empty is a picker with nothing in it, and an
-- operator faced with one writes the reason into the note field instead --
-- which is the free text the table exists to prevent.
CREATE TABLE "job_photo_exemption_reasons" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(48) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	"sort_order" integer DEFAULT 100 NOT NULL,
	-- Retirement, never deletion. A completed job still points at this row.
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "job_photo_exemption_reasons" ADD CONSTRAINT "job_photo_exemption_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "job_photo_exemption_reasons_code_key" ON "job_photo_exemption_reasons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "job_photo_exemption_reasons_pick_idx" ON "job_photo_exemption_reasons" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint

-- ── The declarations ────────────────────────────────────────────────────────
--
-- One table with a kind discriminator rather than two, the way job_fault_codes
-- carries symptom, cause and remedy in one table rather than three. Both rows
-- are the same shape: somebody asserting an absence, with their name and the
-- time on it.
CREATE TABLE "job_card_declarations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	-- Null for a single-visit job, which has no choice to make.
	"visit_id" uuid,
	"kind" varchar(16) NOT NULL,
	-- Only ever set on a photo_exempt row. A materials_none declaration has no
	-- reason to give: no parts were used is the whole of it.
	"reason_code" varchar(48),
	-- What the code does not say. Beside it, never instead of it.
	"note" text,
	"declared_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_card_declarations_kind" CHECK ("kind" IN ('materials_none', 'photo_exempt')),
	-- The two halves of the requirement's word "explicit". A photo exemption
	-- without a code is the free-text exemption JOB-15 refuses; a reason code on
	-- a materials declaration would be a value no picker offered.
	CONSTRAINT "job_card_declarations_reason" CHECK (
		("kind" = 'photo_exempt' AND "reason_code" IS NOT NULL)
		OR ("kind" = 'materials_none' AND "reason_code" IS NULL)
	)
);
--> statement-breakpoint

ALTER TABLE "job_card_declarations" ADD CONSTRAINT "job_card_declarations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_declarations" ADD CONSTRAINT "job_card_declarations_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_declarations" ADD CONSTRAINT "job_card_declarations_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_declarations" ADD CONSTRAINT "job_card_declarations_declared_by_id_users_id_fk" FOREIGN KEY ("declared_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- The composite reference, not the code alone. Two tenants may both define a
-- reason called sealed_unit and they are different rows; a single-column
-- reference would let one company's job cite another company's vocabulary.
-- ON DELETE restrict, matching how fault_codes and lead_disposition_reasons are
-- referenced: a reason cited by last quarter's work cannot be deleted without
-- rewriting last quarter, so the list is deactivated instead.
ALTER TABLE "job_card_declarations" ADD CONSTRAINT "job_card_declarations_reason_code_fk"
	FOREIGN KEY ("tenant_id", "reason_code")
	REFERENCES "public"."job_photo_exemption_reasons"("tenant_id", "code")
	ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint

CREATE INDEX "job_card_declarations_job_idx" ON "job_card_declarations" USING btree ("tenant_id","job_id");--> statement-breakpoint

-- One declaration of each kind per job, per visit. The coalesce is what makes
-- the rule apply to the job-level declaration too: a null visit is one bucket
-- rather than an exemption. Without it a form submitted twice records that no
-- materials were used twice, and a count of exempted jobs then depends on how
-- many times somebody pressed save.
CREATE UNIQUE INDEX "job_card_declarations_one_per_kind" ON "job_card_declarations"
	USING btree ("tenant_id","job_id", (COALESCE("visit_id", '00000000-0000-0000-0000-000000000000'::uuid)), "kind");--> statement-breakpoint

-- ── The attachment kind, constrained at last ────────────────────────────────
--
-- job_attachments.kind has been an unconstrained varchar(24) since 0000 with
-- the five legal values written in a comment. That was harmless while nothing
-- wrote the table. It stops being harmless the moment a gate reads it: the
-- completion check asks whether a row exists with kind photo_after, and a typo
-- or a client sending photo-after would defeat the check silently, which is
-- worse than not having it -- the job completes, the gate reports itself as
-- satisfied, and no photo is on file.
--
-- NOT VALID, for the reason 0024 gives on jobs_outcome_code_fk: every insert
-- and update from here on is verified, and any row written before there was a
-- rule is left alone rather than blocking the migration or being rewritten to
-- a guess.
ALTER TABLE "job_attachments" ADD CONSTRAINT "job_attachments_kind" CHECK (
	"kind" IN ('photo_before', 'photo_after', 'signature', 'document', 'video')
) NOT VALID;
