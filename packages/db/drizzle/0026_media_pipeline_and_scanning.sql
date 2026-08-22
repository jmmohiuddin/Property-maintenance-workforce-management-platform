-- The media pipeline and real virus scanning (TRD 8.5/8.6, ATS-9).
--
-- Two things arrive here, and they are one thing: bytes coming in from a phone
-- on a bad connection, and something actually looking at those bytes before a
-- person opens them.
--
-- -- WHAT WAS ACTUALLY WRONG WITH SCANNING --------------------------------
--
-- candidate_documents.scan_status has existed since 0014 as a CHECK-constrained
-- column with four honest states, the download route re-derives its gate from
-- the row on every request, and the candidate screen labels every file. All of
-- that was real. The scanner was not. The only writer was the public CV upload
-- and it wrote 'skipped' unconditionally; nothing ever wrote 'pending' and no
-- code path anywhere moved a row out of it. A state machine with no engine.
--
-- The column added below is what makes an asynchronous sweep safe to run twice
-- at once. It is the same shape as interviews.reminder_24h_sent_at, and it is
-- there for the same reason: the sweep claims a row with a conditional UPDATE
-- that only matches while the column is null, so two overlapping runs serialise
-- on the row and the loser matches nothing and does nothing. A run that dies
-- mid-scan rolls its claim back with its transaction and the next run picks the
-- document up.
--
-- It also carries a second meaning, deliberately: claimed AND still pending is
-- a document the sweep could not finish -- the stored object was missing, say.
-- Those rows stay undownloadable, stop being retried forever, and are counted
-- separately by /api/cron/scan so a person can see them. The alternative was to
-- park them in 'skipped', which is the deployment statement "nobody scanned
-- this because there is no scanner" and would have been a lie about a specific
-- file.

-- Every statement in this file is guarded, so it can be applied against a
-- database at any point between "nothing here yet" and "already fully applied".
-- That is not tidiness: a migration that exists in the tree but has not been
-- applied is WORSE than one that does not exist, because the drizzle schema
-- already believes in the column and every consumer of packages/db then fails
-- on a column Postgres does not have. Being able to re-run this without
-- thinking is what makes "just apply it" a safe instruction to give.

ALTER TABLE "candidate_documents"
  ADD COLUMN IF NOT EXISTS "scan_claimed_at" timestamp with time zone;--> statement-breakpoint

-- The sweep's own query: pending, unclaimed, oldest first. Without it the sweep
-- sequentially scans candidate_documents every run for the rest of time, and
-- the existing (tenant_id, scan_status) index does not help because the
-- selective part of the predicate is the null claim.
CREATE INDEX IF NOT EXISTS "candidate_documents_unclaimed_idx"
  ON "candidate_documents" ("tenant_id", "uploaded_at")
  WHERE "scan_claimed_at" IS NULL;--> statement-breakpoint


-- -- RESUMABLE UPLOADS (TRD 8.5, 8.6) -------------------------------------
--
-- ADR 0004: photos and signatures "upload separately from record sync, queued,
-- resumable, and heavily compressed. A day of job photos over a hotel's guest
-- wifi is the realistic worst case." A 12 MB photo in a single POST over that
-- link is a coin toss, and losing it means starting again -- so the twentieth
-- attempt is no likelier to finish than the first.
--
-- -- WHY THIS IS TWO TABLES AND NOT A DIRECTORY OF PART FILES ---------------
--
-- The obvious implementation stages each chunk as an object in the store. It
-- cannot work here, and the reason is a property worth keeping: ObjectStore.put
-- sniffs the content type from the bytes and refuses anything outside its
-- allowlist. The middle 512 KB of a JPEG is not a JPEG. Staging chunks would
-- have meant a second write path that skips the sniffer -- which is the one
-- hole the whole SEC-8 design is shaped to avoid -- so the parts live here
-- instead, and only the assembled file, sniffed and hashed, reaches the store.
--
-- The cost is honest and bounded: chunk bytes sit in Postgres for as long as an
-- upload is in flight, capped by MAX_OBJECT_BYTES at 25 MB per session, and
-- /api/cron/scan deletes the rows of anything abandoned past its expiry.
--
-- -- WHY THE CLIENT'S ID IS THE IDEMPOTENCY KEY ---------------------------
--
-- TRD 8.3, verbatim: "the dominant real-world failure is request succeeded,
-- response lost, client retries." A technician's phone that opened a session
-- and never saw the reply must be able to ask again and get the same session
-- back, not a second one -- otherwise a day on bad wifi leaves forty abandoned
-- half-uploads and one photo. client_upload_id is the ULID the device
-- generated before it had any server at all, and the unique index below is what
-- makes retrying free.
CREATE TABLE IF NOT EXISTS "upload_sessions" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- ULID from the device. Also the Idempotency-Key header on the init call.
	"client_upload_id" varchar(64) NOT NULL,
	-- What this upload is for, as the client sees it. Deliberately opaque
	-- transport-level vocabulary: this table owns getting the bytes here, and
	-- the domain tables that cite the finished object own what it means.
	"purpose" varchar(32) NOT NULL,
	-- The caller's own handle for the thing being illustrated -- a job's client
	-- id, an application reference. Never resolved or joined here; handed back
	-- on completion so the caller can attach the result.
	"reference" varchar(120),
	"filename" varchar(200),
	"total_bytes" integer NOT NULL,
	"chunk_size" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	-- What the client says the finished file hashes to, when it knows. Checked
	-- at assembly. A mismatch is a corrupt upload and is refused rather than
	-- stored, because a photo that is silently truncated is worse than one that
	-- visibly failed: FLD-14 makes the signed record immutable, and a corrupt
	-- image inside it is corrupt forever.
	"declared_sha256" varchar(64),
	"received_chunks" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	-- Everything below is null until the session completes.
	"storage_key" text,
	"content_type" varchar(80),
	"size_bytes" integer,
	"sha256" varchar(64),
	"scan_status" varchar(16) DEFAULT 'pending' NOT NULL,
	-- TRD 8.6: "extract EXIF ... to structured columns", because EXIF is
	-- fragile -- resizing rewrites it, pipelines drop it, and no query can reach
	-- it. If the evidential value of a job photo is "taken here, then", that has
	-- to live in a column. numeric(9,6) is roughly 11 cm at the equator, which
	-- is finer than any phone GPS.
	"captured_at" timestamp with time zone,
	"captured_lat" numeric(9, 6),
	"captured_lon" numeric(9, 6),
	"orientation" smallint,
	-- And 8.6's other half: the coordinates come out of the file before it is
	-- stored, because embedded GPS in a domestic job photo leaks the customer's
	-- home address to everyone the photo is forwarded to. False here on a stored
	-- image means this system could not clean it -- HEIC, chiefly -- and that is
	-- a fact somebody needs to be able to query for.
	"metadata_stripped" boolean DEFAULT false NOT NULL,
	-- 'unchanged' | 'recompressed' | 'converted' | 'unconverted' | 'unavailable'
	"compression" varchar(16),
	"processing_note" varchar(400),
	"created_by_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "upload_sessions_status" CHECK (
		"status" IN ('open', 'complete', 'aborted', 'failed')
	),
	-- The same four states as candidate_documents, and the same meanings. A
	-- separate CHECK rather than a shared enum because the two tables are on
	-- different release schedules and a shared type is a shared migration.
	CONSTRAINT "upload_sessions_scan_status" CHECK (
		"scan_status" IN ('pending', 'clean', 'infected', 'skipped')
	),
	CONSTRAINT "upload_sessions_sizes" CHECK (
		"total_bytes" > 0 AND "chunk_size" > 0 AND "chunk_count" > 0
	)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "upload_chunks" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"bytes" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_chunks_index" CHECK ("chunk_index" >= 0),
	CONSTRAINT "upload_chunks_size" CHECK ("size_bytes" > 0)
);
--> statement-breakpoint

DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_tenant_id_tenants_id_fk') THEN
		ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_sessions_created_by_id_users_id_fk') THEN
		ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_chunks_tenant_id_tenants_id_fk') THEN
		ALTER TABLE "upload_chunks" ADD CONSTRAINT "upload_chunks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint

-- ON DELETE cascade: the chunks are scaffolding for one session and have no
-- meaning without it. Deleting the session is how an abandoned upload is
-- reclaimed, and leaving orphaned bytea rows behind would defeat the point.
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'upload_chunks_session_id_upload_sessions_id_fk') THEN
		ALTER TABLE "upload_chunks" ADD CONSTRAINT "upload_chunks_session_id_upload_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint

-- The idempotency key, enforced. A retried init returns the existing session.
CREATE UNIQUE INDEX IF NOT EXISTS "upload_sessions_client_idx" ON "upload_sessions" ("tenant_id", "client_upload_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_sessions_open_idx" ON "upload_sessions" ("tenant_id", "status", "expires_at");--> statement-breakpoint

-- The same-chunk-twice guarantee, in the database rather than in a handler. A
-- client that retried a chunk it never saw acknowledged is normal, and the
-- receive path relies on this index to turn the second copy into a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "upload_chunks_part_idx" ON "upload_chunks" ("session_id", "chunk_index");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_chunks_session_idx" ON "upload_chunks" ("tenant_id", "session_id");
