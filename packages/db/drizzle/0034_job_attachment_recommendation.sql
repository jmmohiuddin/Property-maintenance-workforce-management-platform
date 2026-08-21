-- Admit a sixth job_attachments.kind: photo_recommendation (FLD-12).
--
-- FLD-12 is "a free field with an optional photo that raises a lead" -- the
-- PRD's own words for the highest-value field on the whole form: a technician
-- noticing a failing compressor on an unrelated visit is how maintenance work
-- becomes replacement work. job_note/upsert (packages/db/src/domain/field.ts)
-- has carried the text half since it was built; the photograph had nowhere
-- to land.
--
-- job_attachments.kind accepted five values, enforced by
-- job_attachments_kind (0025) -- photo_before, photo_after, signature,
-- document, video -- and a recommendation photo is none of them. Filing it as
-- document with a caption is the free-text fallback this codebase refuses
-- everywhere else (0025's own CHECK exists for exactly that reason), and
-- recording only the upload id in field_mutations.payload would make the
-- office read the sync ledger to find a recommendation's photo -- a worse,
-- second model of something that belongs in a column.
--
-- Postgres has no ALTER on a CHECK's expression, so the constraint is dropped
-- and recreated with the sixth value rather than widened in place.
--
-- ── WHY THIS STAYS NOT VALID, LIKE 0025 ─────────────────────────────────────
--
-- 0025 added job_attachments_kind as NOT VALID because nothing had written the
-- table yet and there was nothing to lose by leaving pre-existing rows
-- unchecked. That is no longer true of this migration's moment -- rows have
-- been written under the five-value constraint since 0025 shipped -- but it
-- does not follow that this one should validate: a VALIDATE CONSTRAINT here
-- would scan every row ever written to job_attachments, including whatever
-- was inserted before 0025 and was never checked against anything at all. If
-- any of those pre-0025 rows carry a typo'd kind, a validating ALTER blocks
-- this migration on rows this change has nothing to do with. Recreating the
-- constraint NOT VALID keeps the posture 0025 chose: every insert and update
-- from here on is checked against six values instead of five, and the
-- unvalidated past is left exactly as unvalidated as 0025 left it, not newly
-- re-litigated by a migration that only meant to add one value.
ALTER TABLE "job_attachments" DROP CONSTRAINT "job_attachments_kind";--> statement-breakpoint

ALTER TABLE "job_attachments" ADD CONSTRAINT "job_attachments_kind" CHECK (
	"kind" IN ('photo_before', 'photo_after', 'signature', 'document', 'video', 'photo_recommendation')
) NOT VALID;
