-- =============================================================================
-- When an invoice was written off (POR-4).
--
-- ── WHY A COLUMN AND NOT `updated_at` ───────────────────────────────────────
--
-- The customer's statement of account is a chronological ledger: invoices up,
-- credit notes down, payments down. A write-off belongs in it — it is the event
-- that moved the balance — and putting it there requires knowing WHEN it
-- happened.
--
-- `updated_at` cannot answer that. It moves on any later edit: a corrected
-- buyer reference, a re-render of the PDF, a reminder count going up. Filing
-- the write-off row at that date puts it in the wrong place in the ledger, and
-- on a statement a row in the wrong place is not a cosmetic error — it is the
-- running balance being wrong for every row after it.
--
-- ── WHAT THE PORTAL DID BEFORE THIS ─────────────────────────────────────────
--
-- Subtracted the written-off total from the footer while leaving the invoice in
-- the rows, so the last row of the running-balance column and the balance card
-- disagreed by exactly the amount written off. That was the honest half-measure
-- available without this column; it is now the full one.
--
-- ── THE BACKFILL, AND WHY IT USES THE COLUMN THIS FILE ARGUES AGAINST ───────
--
-- Rows written off before this column existed have no better source than
-- `updated_at`, so that is what they get. It is an approximation and it is the
-- last one that will ever be needed: the CHECK below makes the timestamp
-- compulsory from here on, so every future write-off records its own date.
--
-- Deliberately not `created_at` and not `issued_on` — both are knowably wrong
-- (a write-off never happens before the invoice exists), whereas `updated_at`
-- is the last time anybody touched the row, which for a written-off invoice is
-- most often the write-off itself.
-- =============================================================================

ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "written_off_at" timestamptz;
--> statement-breakpoint

UPDATE "invoices"
   SET "written_off_at" = COALESCE("updated_at", "created_at")
 WHERE "status" = 'written_off'
   AND "written_off_at" IS NULL;
--> statement-breakpoint

-- A written-off invoice must carry the date it was written off.
--
-- Held by the database rather than remembered by the application, for the
-- reason `invoices_article59_fields` gives about its own fields: the next
-- caller is a React Native field app reaching these rows through an API
-- (`ADR 0009`), and a rule enforced in one server action is a rule the other
-- client does not have. Nothing writes this status today — `written_off_reason`
-- has been a column with no writer since `0000` — so this constraint is here
-- BEFORE the writer, which is the only time it costs nothing to add.
--
-- VALIDATED, not NOT VALID: the backfill above has just made every existing row
-- satisfy it, so there is no legacy data to grandfather. That is the difference
-- from 0007, which had real issued invoices predating its requirement.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_written_off_date" CHECK (
    "status" <> 'written_off' OR "written_off_at" IS NOT NULL
  );
--> statement-breakpoint

COMMENT ON COLUMN "invoices"."written_off_at" IS
  'When the business stopped pursuing this debt. Its position in the customer statement ledger.';
