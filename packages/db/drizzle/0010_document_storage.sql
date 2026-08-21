-- DB-2 / TD-14 — the rendered document, and the hash that makes it evidence.
--
-- `invoices.pdf_storage_key` has existed since 0000 and nothing has ever
-- written to it. This migration gives it a companion hash, gives quotes the
-- same pair, and makes the pair immutable once set.
--
-- ── WHY THE HASH IS A COLUMN AND NOT A DERIVED VALUE ────────────────────────
--
-- TRD §7.6: rendered documents are written to object storage and the key kept
-- on the record — *never re-rendered on demand for a financial document,
-- because the artefact must be stable even if a template changes.* The stored
-- hash is what makes that claim checkable. Without it, "this is the invoice we
-- issued" rests on the object store having returned the right bytes, which is
-- exactly the thing nobody can verify after the fact. With it, anyone holding
-- the file can run `shasum -a 256` and compare.
--
-- ── WHY BOTH COLUMNS OR NEITHER ─────────────────────────────────────────────
--
-- A key with no hash is an artefact nobody can verify; a hash with no key is a
-- claim about a file that cannot be fetched. Both states are the result of a
-- half-completed write, and both look fine on a screen. The check constraint
-- makes the half-completed write fail at the point it happens rather than
-- surfacing as a puzzle during an audit.
ALTER TABLE "quotes" ADD COLUMN "pdf_storage_key" text;
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "pdf_sha256" char(64);
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "pdf_rendered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pdf_sha256" char(64);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "pdf_rendered_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "pdf_sha256" char(64);
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD COLUMN "pdf_rendered_at" timestamp with time zone;
--> statement-breakpoint

-- Lowercase hex, 64 characters. Written as a constraint rather than trusted to
-- the application because there are three tables and there will be more once
-- job sheets (`FLD-14`) and statements (`INV-13`) are stored, and a format rule
-- enforced in five places is a format rule enforced in four.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pdf_sha256_hex" CHECK ("pdf_sha256" IS NULL OR "pdf_sha256" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_sha256_hex" CHECK ("pdf_sha256" IS NULL OR "pdf_sha256" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_pdf_sha256_hex" CHECK ("pdf_sha256" IS NULL OR "pdf_sha256" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint

-- NOT VALID on invoices and credit notes: rows written before this migration
-- may carry a key with no hash, and there is no way to produce the hash for
-- them because the artefact was never stored in the first place. Validating
-- would fail the migration on exactly the historical data this column exists to
-- start fixing. New and updated rows are checked; the old ones are visible as
-- an un-rendered document on the screen, which is the honest state.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_pdf_key_and_hash" CHECK (("pdf_storage_key" IS NULL) = ("pdf_sha256" IS NULL));
--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_key_and_hash" CHECK (("pdf_storage_key" IS NULL) = ("pdf_sha256" IS NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "credit_notes" ADD CONSTRAINT "credit_notes_pdf_key_and_hash" CHECK (("pdf_storage_key" IS NULL) = ("pdf_sha256" IS NULL)) NOT VALID;
--> statement-breakpoint

-- ── OPS-6: the artefact is write-once ──────────────────────────────────────
--
-- Object storage refuses to overwrite a key, so the *bytes* are already safe.
-- This closes the other half: the row must not be re-pointed at a different
-- artefact, and the hash must not be edited to match one.
--
-- The failure this prevents is not malice. It is a well-meant "re-render the
-- invoices, the template has been fixed" script, run against a table where
-- several of those invoices are already in a customer's accounting system and
-- one of them is in a tax return. Correcting an issued tax invoice needs a
-- credit note and a second document (`INV-7`); it does not need a new PDF at
-- the same reference.
--
-- A retention purge deletes the row and the object together. It must never
-- blank these columns, which is why NULL is not an accepted new value either.
CREATE OR REPLACE FUNCTION app_document_artefact_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pdf_storage_key IS NOT NULL AND NEW.pdf_storage_key IS DISTINCT FROM OLD.pdf_storage_key THEN
    RAISE EXCEPTION
      'The stored document for % is write-once (OPS-6). Issue a correcting document rather than replacing this one.',
      OLD.reference
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.pdf_sha256 IS NOT NULL AND NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256 THEN
    RAISE EXCEPTION
      'The document hash for % is write-once (OPS-6). It is the evidence of what was issued.',
      OLD.reference
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER quotes_artefact_immutable BEFORE UPDATE ON "quotes"
  FOR EACH ROW EXECUTE FUNCTION app_document_artefact_immutable();
--> statement-breakpoint
CREATE TRIGGER invoices_artefact_immutable BEFORE UPDATE ON "invoices"
  FOR EACH ROW EXECUTE FUNCTION app_document_artefact_immutable();
--> statement-breakpoint
CREATE TRIGGER credit_notes_artefact_immutable BEFORE UPDATE ON "credit_notes"
  FOR EACH ROW EXECUTE FUNCTION app_document_artefact_immutable();
--> statement-breakpoint

-- The screens that list documents awaiting a render, and the download route's
-- lookup. Partial, because the interesting rows are the ones with no artefact
-- yet and that set shrinks to nothing as the backlog clears.
CREATE INDEX "quotes_unrendered_idx" ON "quotes" ("tenant_id", "status") WHERE "pdf_storage_key" IS NULL;
--> statement-breakpoint
CREATE INDEX "invoices_unrendered_idx" ON "invoices" ("tenant_id", "status") WHERE "pdf_storage_key" IS NULL;
