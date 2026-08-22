-- Material provenance: where the part came from, and which one it was.
--
-- ── WHY THIS IS ITS OWN FILE AND NOT AN EDIT TO 0036 ───────────────────────
--
-- It was written into 0036 first, and that was wrong. 0036 had already been
-- applied to the shared development database by the time these two columns
-- were appended to it, so the edit ran on that database only because the new
-- statements were also applied by hand. Any database that had already run
-- 0036 -- another developer's, a review environment -- would never see them:
-- a migration runner records the file as done and does not re-read it.
--
-- The failure that produces is the one 0033's header warns about, in its worse
-- direction. It is not "green locally, red on a clean deploy" but the reverse:
-- CI applies every migration from nothing and passes, while an existing
-- database silently lacks the columns and keeps discarding the data. An
-- applied migration is history. History is appended to, never edited.

-- ── FLD-9: where the part came from, which was being thrown away ───────────
--
-- Routed in from the field stream, and it is a silent data loss rather than a
-- missing feature. The field client sends `source` on every
-- `job_material/append` and `serialNumber` where it has one;
-- apps/field/src/sync/payloads.ts is the authority on that wire and has been
-- proven against a live server. `job_materials` had neither column and
-- `recordJobMaterial()` read neither key, so both values were accepted and
-- discarded. Nothing refused, nothing warned.
--
-- That distinction is the whole reason this ranks above a missing feature. A
-- refusal would have told the technician to try something else. Silent
-- acceptance told them it had worked, which is the one outcome that produces a
-- confident, wrong answer six months later when somebody asks where the part
-- came from -- and FLD-9 exists because that question is what a warranty claim,
-- a supplier dispute and a parts-markup audit all turn on.
--
-- ── WHY BOTH ARE NULLABLE ──────────────────────────────────────────────────
--
-- `source` is required on the wire but nullable in the column, and the two are
-- not in conflict. The web console's own material form has never collected it,
-- and every row already in this table predates the column. NULL therefore means
-- "not recorded" and is the honest value for both. A NOT NULL with a default of
-- van_stock would invent a fact -- it would state, on rows nobody ever asked,
-- that the part came off the van, which is exactly the confident wrong answer
-- this migration exists to stop.
--
-- A serial number is legitimately absent: a metre of cable does not have one.
ALTER TABLE "job_materials" ADD COLUMN "source" varchar(24);--> statement-breakpoint
ALTER TABLE "job_materials" ADD COLUMN "serial_number" varchar(120);--> statement-breakpoint

-- The vocabulary is closed, and it is CHECKed here rather than held in a
-- reference table. The argument is in packages/core/src/work.ts above
-- MaterialSource and it turns on the offline client: the field app's picker is
-- compiled into a binary that may not be updated for weeks, so a row added to a
-- reference table would be a value that client can neither render nor send.
-- That is a picker offering a choice which does not work, which is worse than
-- the free-text fallback a controlled vocabulary is meant to prevent.
--
-- The three values are the field client's own spelling, taken from
-- apps/field/src/domain/job-card.ts rather than chosen here. Conforming to the
-- wire is the point: a fourth spelling invented at this end would recreate the
-- disagreement the missing column already caused once.
--
-- NOT VALID, on 0025's and 0034's reasoning: every row written from here on is
-- checked, and the unvalidated past is left exactly as unvalidated as it was
-- rather than newly re-litigated by a migration that only meant to add a
-- column. Every pre-existing row is NULL in this column in any case, and NULL
-- passes a CHECK, so there is nothing here for a VALIDATE to find.
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_source" CHECK (
	"source" IN ('van_stock', 'purchased', 'customer_supplied')
) NOT VALID;
