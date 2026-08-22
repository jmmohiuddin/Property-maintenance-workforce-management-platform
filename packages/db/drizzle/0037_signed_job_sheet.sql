-- The signed job sheet, and what makes a signature mean something (FLD-14).
--
-- FLD-14 reads: store a SHA-256 hash of the exact rendered job sheet that was
-- on screen at the moment of signing, plus an immutable PDF snapshot of it.
-- After signature the job record is locked; corrections happen only as a new,
-- linked, reason-coded amendment. Written to versioned, immutable object
-- storage. A copy is emailed to the customer immediately.
--
-- ── WHAT EXISTED BEFORE THIS MIGRATION ──────────────────────────────────────
--
-- job_signoffs, since 0000: a signature image key, a printed name, an optional
-- role, a rating and a comment. No hash, no snapshot, no lock, no amendment,
-- no email. The field app says the consequence plainly in its own source: "a
-- signature captured by this app today would prove that somebody drew on a
-- screen and nothing about what they were agreeing to." Its signature screen
-- therefore draws a signature and then refuses to save it, which is the honest
-- behaviour for a system with nowhere to put one.
--
-- ── THE ORDER THE PIECES DEPEND ON EACH OTHER ───────────────────────────────
--
-- A capture surface is the LAST piece, not the first. Adding one before there
-- is a sheet to hash, a lock to amend and a snapshot to amend from would give a
-- client somewhere to write into a system that cannot hold the writes to
-- account. This migration is the bottom of that stack: the sheet's evidential
-- record, the vocabulary an amendment must cite, and the lock as a database
-- rule rather than a convention.
--
-- ── WHY TWO DIGESTS AND NOT ONE ─────────────────────────────────────────────
--
-- The requirement says "the exact rendered job sheet that was ON SCREEN at the
-- moment of signing". The sheet on screen at that moment does not yet contain
-- the signature, so a single hash of the stored PDF would be a hash of a
-- document the signer never saw. Both are therefore recorded:
--
--   * content_sha256 — SHA-256 of the canonical sheet text, the byte sequence
--     apps/field/src/domain/signature.ts calls `canonicalSheet()` and stamps
--     `meridian-jobsheet-v1`. This is the digest the device computes and sends,
--     and the one the server independently re-derives and compares before it
--     accepts a signature. It is the evidential anchor.
--
--   * pdf_sha256 — SHA-256 of the immutable snapshot actually stored, which is
--     that same sheet plus the signature block, and which prints
--     content_sha256 on its own face so the chain is readable without a
--     database.
--
-- The format string is stored beside them rather than assumed. When the
-- canonicalisation changes it becomes v2, and a sheet sealed under v1 is still
-- verifiable because the row says which rules produced its digest.

-- ── The amendment vocabulary ────────────────────────────────────────────────
--
-- Reason-coded, by the requirement's own wording, and tenant-scoped like every
-- other vocabulary here (job_outcome_codes, fault_codes,
-- job_photo_exemption_reasons). Seeded in packages/db/src/seed.ts: a controlled
-- list that ships empty is a picker with nothing in it, and the operator faced
-- with one types the reason into the note field instead -- which is the free
-- text the table exists to prevent.
--
-- The reason a correction to a signed sheet must be coded rather than typed is
-- not tidiness. It is the only way to answer the question the data is for: are
-- sheets being amended because the world changed after the visit, or because
-- one crew's sheets are routinely wrong when the customer signs them.
CREATE TABLE "job_sheet_amendment_reasons" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(48) NOT NULL,
	"label" varchar(120) NOT NULL,
	"description" varchar(400),
	"sort_order" integer DEFAULT 100 NOT NULL,
	-- Retirement, never deletion. An amendment raised last quarter still points
	-- at this row, and rewriting last quarter is not a way to reword a label.
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "job_sheet_amendment_reasons" ADD CONSTRAINT "job_sheet_amendment_reasons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "job_sheet_amendment_reasons_code_key" ON "job_sheet_amendment_reasons" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "job_sheet_amendment_reasons_pick_idx" ON "job_sheet_amendment_reasons" USING btree ("tenant_id","is_active","sort_order");--> statement-breakpoint

-- ── The sheets themselves ───────────────────────────────────────────────────
--
-- One table for the original and its amendments, with a kind discriminator and
-- a self-reference, the way job_card_declarations holds two kinds of assertion
-- in one table. They are the same object: a rendered sheet, hashed, stored
-- once, never edited. What differs is that an amendment names the sheet it
-- corrects and the reason it exists, and that only the original carries a
-- signature.
--
-- An amendment NEVER rewrites the sheet it corrects and never unlocks the job
-- card. The original and its hash stand; the amendment is a second document
-- that says what was wrong and what the position actually is. That is the only
-- shape in which "corrections happen only as a new, linked, reason-coded
-- amendment" is true rather than aspirational -- an unlock-edit-reseal cycle
-- would leave the original artefact evidencing a state the business no longer
-- claims, which is the mutable job sheet the requirement exists to forbid.
CREATE TABLE "job_sheets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	-- Which visit's work this sheet is of, where the job took several. Null on
	-- a single-visit job, which has no choice to make.
	"visit_id" uuid,
	-- 'original' | 'amendment'.
	"kind" varchar(16) NOT NULL,
	-- Human-quotable and unique within the tenant, so an operator holding a
	-- printed sheet can find the row without a database: SATS-JOB-2026-0042-JS
	-- for the original, -A1, -A2 for amendments.
	"reference" varchar(64) NOT NULL,
	-- 0 for the original, 1..n for amendments. Gives the amendments a defined
	-- order without depending on a timestamp two of them could share.
	"sequence" integer NOT NULL,
	-- The signature that sealed this sheet. Present on the original and only on
	-- the original: an amendment is the company correcting its own record, not
	-- the customer signing a second time.
	"signoff_id" uuid,
	-- Which canonicalisation produced content_sha256. Stored, never assumed --
	-- see the header.
	"sheet_format" varchar(32) DEFAULT 'meridian-jobsheet-v1' NOT NULL,
	-- The digest of the sheet text the signer was shown.
	"content_sha256" char(64) NOT NULL,
	-- The immutable snapshot: where it is, and what it hashes to.
	"storage_key" text NOT NULL,
	"pdf_sha256" char(64) NOT NULL,
	-- The date the PDF's own metadata is pinned to. A Dubai calendar date, not
	-- a wall clock: the stored hash is only evidence if the same sheet renders
	-- to the same bytes, and a creation timestamp taken from the clock makes
	-- every re-render a different file.
	"business_date" date NOT NULL,
	-- The canonical sheet's `recorded_offline_at` line, verbatim.
	--
	-- TEXT, not a timestamp, and stored rather than derived. Every other input
	-- to the digest can be re-read from the record; this one cannot. A handset
	-- sends the device clock reading it actually displayed to the technician --
	-- ADR 0004 keeps both clocks precisely because device clocks are wrong and
	-- users change them -- so the value that went into the hash is the device's
	-- string, not anything the server would compute.
	--
	-- Without this column the stored digest is unverifiable on exactly the path
	-- that matters most: nobody could re-derive the canonical string a technician
	-- captured in a basement, which makes the hash a number with nothing to
	-- compare it against. Kept as text so it is reproduced byte for byte; parsing
	-- and re-formatting it would change the bytes and therefore the digest.
	"recorded_at_text" varchar(64) NOT NULL,
	-- The sheet this one corrects. Only ever set on an amendment.
	"amends_sheet_id" uuid,
	"amendment_reason_code" varchar(48),
	-- What the code does not say. Beside it, never instead of it -- the same
	-- rule job_card_declarations.note holds.
	"amendment_detail" text,
	"sealed_by_id" uuid,
	"sealed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_sheets_kind" CHECK ("kind" IN ('original', 'amendment')),
	-- A hex digest, lower case, both of them. A column that will be compared
	-- for equality against a digest computed elsewhere cannot afford to hold
	-- one in upper case and one in lower.
	CONSTRAINT "job_sheets_content_sha256_hex" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_sheets_pdf_sha256_hex" CHECK ("pdf_sha256" ~ '^[0-9a-f]{64}$'),
	-- The two kinds, each fully specified. Written as one constraint per side
	-- rather than a single OR so the error names which half was violated.
	CONSTRAINT "job_sheets_original_shape" CHECK (
		"kind" <> 'original' OR (
			"signoff_id" IS NOT NULL
			AND "amends_sheet_id" IS NULL
			AND "amendment_reason_code" IS NULL
			AND "sequence" = 0
		)
	),
	CONSTRAINT "job_sheets_amendment_shape" CHECK (
		"kind" <> 'amendment' OR (
			"signoff_id" IS NULL
			AND "amends_sheet_id" IS NOT NULL
			AND "amendment_reason_code" IS NOT NULL
			AND "sequence" > 0
		)
	)
);
--> statement-breakpoint

ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- RESTRICT, not CASCADE. The signature is the reason the sheet is evidence;
-- deleting it out from under the sheet would leave an artefact whose hash
-- nobody can attribute to anybody.
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_signoff_id_job_signoffs_id_fk" FOREIGN KEY ("signoff_id") REFERENCES "public"."job_signoffs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_amends_sheet_id_job_sheets_id_fk" FOREIGN KEY ("amends_sheet_id") REFERENCES "public"."job_sheets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_sealed_by_id_users_id_fk" FOREIGN KEY ("sealed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- The composite reference, not the code alone. Two tenants may both define a
-- reason called wrong_parts and they are different rows; a single-column
-- reference would let one company's amendment cite another company's
-- vocabulary. ON DELETE restrict, matching how every other vocabulary here is
-- referenced: a reason cited by a sealed amendment cannot be deleted without
-- rewriting the amendment, so the list is deactivated instead.
ALTER TABLE "job_sheets" ADD CONSTRAINT "job_sheets_amendment_reason_fk"
	FOREIGN KEY ("tenant_id", "amendment_reason_code")
	REFERENCES "public"."job_sheet_amendment_reasons"("tenant_id", "code")
	ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint

-- One signed original per job. This is the lock's own foundation: "is this job
-- sealed" has to be a question with one answer, and two originals would make
-- the lock depend on which one a query happened to find first.
CREATE UNIQUE INDEX "job_sheets_one_original" ON "job_sheets" USING btree ("tenant_id","job_id") WHERE "kind" = 'original';--> statement-breakpoint
CREATE UNIQUE INDEX "job_sheets_reference_key" ON "job_sheets" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "job_sheets_sequence_key" ON "job_sheets" USING btree ("tenant_id","job_id","sequence");--> statement-breakpoint
CREATE INDEX "job_sheets_job_idx" ON "job_sheets" USING btree ("tenant_id","job_id","sequence");--> statement-breakpoint
-- The verification path: given a digest from a printed sheet or a dispute,
-- find the row.
CREATE INDEX "job_sheets_content_digest_idx" ON "job_sheets" USING btree ("tenant_id","content_sha256");--> statement-breakpoint

-- ── The sheet row is write-once, in full ────────────────────────────────────
--
-- 0010 made the document columns on quotes, invoices and credit notes
-- immutable while leaving the rest of the row editable, because those rows
-- carry a status that legitimately moves after the document is produced. A job
-- sheet row has no such part: every column on it describes the artefact, and
-- there is no field on it a later event should change. So the whole row is
-- frozen rather than three columns of it.
--
-- DELETE is refused too, which 0010 did not need to do -- a retention purge
-- deletes an invoice and its object together. It is refused here because a
-- signed job sheet is the record of what a customer agreed to, and the
-- correction mechanism this migration builds is an amendment, not a deletion.
--
-- ── THE ONE DOOR OUT, AND WHY IT IS A DOOR RATHER THAN A HOLE ──────────────
--
-- Two things legitimately delete these rows and neither is a correction: the
-- development seed, which clears the database before it writes fixtures, and a
-- retention purge that will one day age out closed jobs and their objects
-- together. A trigger with no way past it would make db:seed fail for everybody
-- the first time anyone exercised this feature -- which is what happened with
-- credit_notes and the clear-down list -- and would leave the retention work
-- with no route except dropping the trigger, which nobody would put back.
--
-- So DELETE is permitted when the caller has said, in the same transaction,
-- that it means to purge: SET LOCAL app.job_sheet_purge = 'on'. That is not a
-- security boundary and is not offered as one -- anything that can delete can
-- set a GUC. It is the difference between a deliberate act and an accident, and
-- the accident is the failure this trigger exists to prevent: a well-meant
-- "tidy up the test data" statement taking a signed job sheet with it. UPDATE
-- has no such door, because nothing legitimately edits one of these rows.
CREATE OR REPLACE FUNCTION app_job_sheet_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF current_setting('app.job_sheet_purge', true) = 'on' THEN
			RETURN OLD;
		END IF;
		RAISE EXCEPTION
			'Job sheet % cannot be deleted (FLD-14). A signed sheet is corrected by a linked amendment, never by removing it. A retention purge sets app.job_sheet_purge and says so.',
			OLD.reference
			USING ERRCODE = 'restrict_violation';
	END IF;

	RAISE EXCEPTION
		'Job sheet % cannot be edited (FLD-14). Its SHA-256 is the evidence of what was signed; raise a reason-coded amendment instead.',
		OLD.reference
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_sheets_immutable BEFORE UPDATE OR DELETE ON "job_sheets"
	FOR EACH ROW EXECUTE FUNCTION app_job_sheet_immutable();--> statement-breakpoint

-- ── FLD-13's fields on the signature row ────────────────────────────────────
--
-- Only the three FLD-14 cannot work without. The copy has to go somewhere, so
-- the signer's email is captured at the pad rather than assumed to be the
-- customer's billing address -- the person signing at a site is frequently not
-- the person the invoices go to, and emailing the sheet to the wrong one is
-- both useless as a contemporaneous copy and a disclosure.
--
-- The consent statement is stored as version AND text. Storing the version
-- alone keeps the record small and makes it unreadable without a lookup table
-- that will itself change; storing the text makes the row self-describing,
-- which is what a document produced in a dispute two years from now needs.
-- Both, because the version is what reports group on and the text is what the
-- sheet prints and therefore what the hash covers.
ALTER TABLE "job_signoffs" ADD COLUMN "signer_email" varchar(200);--> statement-breakpoint
ALTER TABLE "job_signoffs" ADD COLUMN "consent_version" varchar(48);--> statement-breakpoint
ALTER TABLE "job_signoffs" ADD COLUMN "consent_text" text;--> statement-breakpoint

-- ── The lock, as a database rule (FLD-14) ───────────────────────────────────
--
-- "After signature the job record is locked."
--
-- The domain layer refuses first and refuses with a sentence a technician can
-- act on, which is where the rule belongs for anyone who reads the code. This
-- is the backstop, and it is here for the reason JOB-15's gate ended up on
-- transitionJob itself: a rule enforced in one caller is a rule with as many
-- holes as there are other callers, and the field app reaches these same rows
-- through an API rather than through the screen the rule was written next to.
--
-- Scope: the tables whose rows are the content of the sealed sheet. Change any
-- of them and the stored hash stops describing the record, which is precisely
-- the mutable-job-sheet failure FLD-14 names.
--
-- job_visits is deliberately NOT frozen wholesale -- only its two labour
-- columns. A visit row carries a status machine that legitimately keeps moving
-- after a sheet is signed, and freezing the whole row would break the visit
-- lifecycle to protect two integers.
--
-- Every one of these triggers is inert on every row in every existing
-- database: nothing is sealed until a job_sheets row of kind 'original'
-- exists, and this migration creates the first one that can.
CREATE OR REPLACE FUNCTION app_job_card_sealed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	target uuid;
	sheet_reference text;
BEGIN
	-- Branched rather than COALESCE(NEW.job_id, OLD.job_id): in PL/pgSQL, NEW is
	-- unassigned in a DELETE trigger and OLD is unassigned in an INSERT one, and
	-- reading either raises before the COALESCE is ever evaluated.
	IF TG_OP = 'DELETE' THEN
		target := OLD.job_id;
	ELSE
		target := NEW.job_id;
	END IF;

	SELECT s.reference INTO sheet_reference
	  FROM public.job_sheets s
	 WHERE s.job_id = target
	   AND s.kind = 'original'
	 LIMIT 1;

	IF sheet_reference IS NULL THEN
		IF TG_OP = 'DELETE' THEN
			RETURN OLD;
		END IF;
		RETURN NEW;
	END IF;

	RAISE EXCEPTION
		'This job was signed off on job sheet % and its card is locked (FLD-14). Record a reason-coded amendment instead of changing what was signed.',
		sheet_reference
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_attachments_sealed BEFORE INSERT OR UPDATE OR DELETE ON "job_attachments"
	FOR EACH ROW EXECUTE FUNCTION app_job_card_sealed();--> statement-breakpoint
CREATE TRIGGER job_materials_sealed BEFORE INSERT OR UPDATE OR DELETE ON "job_materials"
	FOR EACH ROW EXECUTE FUNCTION app_job_card_sealed();--> statement-breakpoint
CREATE TRIGGER job_card_declarations_sealed BEFORE INSERT OR UPDATE OR DELETE ON "job_card_declarations"
	FOR EACH ROW EXECUTE FUNCTION app_job_card_sealed();--> statement-breakpoint
CREATE TRIGGER job_fault_codes_sealed BEFORE INSERT OR UPDATE OR DELETE ON "job_fault_codes"
	FOR EACH ROW EXECUTE FUNCTION app_job_card_sealed();--> statement-breakpoint

-- A second signature on a job that already has a sealed sheet. Refused, and
-- for the same reason as the rest: the sheet names one signer and one moment,
-- and a second signoff row would make "who signed this job" a question with
-- two answers and no way to tell which the hash belongs to.
CREATE TRIGGER job_signoffs_sealed BEFORE INSERT OR UPDATE OR DELETE ON "job_signoffs"
	FOR EACH ROW EXECUTE FUNCTION app_job_card_sealed();--> statement-breakpoint

-- The labour half. Its own function because it fires only when the two costed
-- integers move, and because the message should say which columns were
-- refused rather than leaving the caller to guess.
CREATE OR REPLACE FUNCTION app_job_visit_labour_sealed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
	sheet_reference text;
BEGIN
	IF NEW.work_minutes IS NOT DISTINCT FROM OLD.work_minutes
	   AND NEW.travel_minutes IS NOT DISTINCT FROM OLD.travel_minutes THEN
		RETURN NEW;
	END IF;

	SELECT s.reference INTO sheet_reference
	  FROM public.job_sheets s
	 WHERE s.job_id = NEW.job_id
	   AND s.kind = 'original'
	 LIMIT 1;

	IF sheet_reference IS NULL THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION
		'The time recorded against this visit was signed for on job sheet % and is locked (FLD-14). Record a reason-coded amendment instead.',
		sheet_reference
		USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER job_visits_labour_sealed BEFORE UPDATE ON "job_visits"
	FOR EACH ROW EXECUTE FUNCTION app_job_visit_labour_sealed();
