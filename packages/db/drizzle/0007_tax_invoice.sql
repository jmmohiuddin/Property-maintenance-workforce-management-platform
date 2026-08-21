-- Phase 1 — the UAE tax invoice, and the fields a 2027 audit will look for.
--
--   INV-3 / DB-3  Every field Article 59 of the VAT Executive Regulations
--                 requires on a tax invoice, plus the fields PINT AE (UBL 2.1)
--                 will require for Peppol transmission from 1 July 2027.
--   INV-6         Simplified invoices are a RENDERING VARIANT of the row below,
--                 decided from the recipient's TRN and the consideration. There
--                 is deliberately no `is_simplified` column: the route is
--                 abolished when e-invoicing applies, and a column would leave
--                 a dead discriminator on every historical row.
--   INV-7         Tax credit notes, with their own sequential series.
--   DB-4          The recipient's TRN, which is what decides full vs simplified.
--
-- ── WHY THE FIELDS ARE ADDED NOW RATHER THAN IN 2027 ────────────────────────
--
-- PINT AE defines roughly 51 mandatory fields for a standard tax invoice. The
-- ones missing here are missing from every invoice this system has ever
-- written. Adding them in 2027 means either transmitting incomplete historical
-- documents or reconstructing facts — a supplier address, an exchange rate, a
-- date of supply — that nobody recorded at the time and nobody can recover.
-- The column is cheap today and unrecoverable later.
--
-- ── WHY IDENTITY IS SNAPSHOT ONTO THE ROW ───────────────────────────────────
--
-- An invoice is a legal artefact, not a view. If the company moves office, or
-- its TRN is reissued, or a customer is renamed, a reprint of a 2026 invoice
-- must still show what it showed in 2026. Deriving the supplier block from
-- current configuration at render time would silently rewrite every historical
-- document the moment an environment variable changed — and the rewrite would
-- be invisible, because the new value would look perfectly plausible.
--
-- The existing `customer_trn` column already worked this way and was the only
-- part of the identity block that did. This migration extends the snapshot to
-- everything Article 59 names, and renames the column to `recipient_trn` so it
-- sits with the rest of the recipient block rather than reading as a foreign
-- key to the customer record it deliberately is not.

-- ── Customers: the TRN that decides the invoice type (DB-4) ─────────────────
--
-- `customers.trn` already exists, and so does `customers.credit_limit` as
-- numeric(14,2). Neither is re-added here.
--
-- Specifically, no `credit_limit_minor` column is created. A second money
-- column for the same fact, in a different unit, is how an off-by-one-hundred
-- bug gets written: two places to update, two places to read, and nothing that
-- fails when they disagree. The credit limit stays numeric(14,2) at rest like
-- every other amount in this schema and is exposed in minor units by the domain
-- layer, which is where every other amount is converted.
--
-- What is added is the constraint. A TRN is fifteen digits — that is the whole
-- format — and a malformed one on a tax invoice is an Article 59 failure that
-- nobody notices until an auditor reads the document. NOT VALID because a
-- pre-existing row is a data-quality problem to be fixed by a human who knows
-- the real number, not a reason this migration should fail.
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_trn_format" CHECK ("trn" IS NULL OR "trn" ~ '^[0-9]{15}$') NOT VALID;
--> statement-breakpoint

COMMENT ON COLUMN "customers"."trn" IS
  'Recipient VAT registration number, 15 digits. Null means not VAT-registered, which under INV-6 permits a simplified tax invoice at any value.';
--> statement-breakpoint

-- The recipient's address, which Article 59 requires on a full tax invoice and
-- which this schema had nowhere to put.
--
-- Not the property address. For an owners association or a property manager the
-- site is not the billing address, and printing the site address in the "bill
-- to" block would state something untrue about who the counterparty is. It
-- stays null until somebody enters it, and the render check refuses a full
-- invoice without it — which is the same rule the company identity module
-- follows: omit the claim rather than invent a plausible one.
ALTER TABLE "customers"
  ADD COLUMN "billing_address" text,
  ADD COLUMN "billing_city" varchar(80),
  ADD COLUMN "billing_country" varchar(2) DEFAULT 'AE' NOT NULL;
--> statement-breakpoint

-- ── Invoices: Article 59 and PINT AE ────────────────────────────────────────

ALTER TABLE "invoices" RENAME COLUMN "customer_trn" TO "recipient_trn";
--> statement-breakpoint

ALTER TABLE "invoices"
  -- The words that must appear on the document. Article 59 requires the phrase
  -- "Tax Invoice" to be clearly displayed; a credit note carries different
  -- words and its own series. Storing the discriminator rather than inferring
  -- it from which table the renderer happened to read means one document model
  -- can serve both without either of them guessing its own legal identity.
  ADD COLUMN "document_type" varchar(24) DEFAULT 'tax_invoice' NOT NULL,

  -- Date of supply, which Article 59 requires alongside the date of issue
  -- *where they differ*. For a service, supply is the date the work was signed
  -- off, not the date somebody got round to raising the paperwork — and the
  -- 14-day issuance clock in INV-5 runs from this column, not from issued_on.
  ADD COLUMN "supply_date" date,

  -- ── Supplier snapshot ────────────────────────────────────────────────────
  ADD COLUMN "supplier_name" varchar(200),
  ADD COLUMN "supplier_trn" varchar(15),
  ADD COLUMN "supplier_address" text,
  ADD COLUMN "supplier_licence_number" varchar(32),
  ADD COLUMN "supplier_cr_number" varchar(32),
  ADD COLUMN "supplier_phone" varchar(24),
  ADD COLUMN "supplier_email" varchar(200),
  ADD COLUMN "supplier_country" varchar(2) DEFAULT 'AE' NOT NULL,

  -- ── Recipient snapshot ───────────────────────────────────────────────────
  ADD COLUMN "recipient_name" varchar(200),
  ADD COLUMN "recipient_address" text,
  ADD COLUMN "recipient_country" varchar(2) DEFAULT 'AE' NOT NULL,

  -- The tax-exclusive amount after discount — PINT AE BT-109, and the number a
  -- reader checks the VAT line against. Derivable from subtotal minus discount
  -- today, but derivable-today is how a stored total drifts from a printed one
  -- the first time a rounding rule changes. It is what the document said.
  ADD COLUMN "taxable_amount" numeric(14, 2) DEFAULT '0' NOT NULL,

  -- Article 59 requires the exchange rate where any amount originates in a
  -- currency other than AED, together with the source of that rate. Both are
  -- null for the ordinary AED invoice; neither can be reconstructed later,
  -- because the rate that applied on the date of supply is not the rate today.
  ADD COLUMN "source_currency" varchar(3),
  ADD COLUMN "exchange_rate" numeric(18, 6),
  ADD COLUMN "exchange_rate_source" varchar(80),

  -- UNCL5305 tax category. 'S' is standard-rated 5%. Zero-rated ('Z') and
  -- exempt ('E') supplies exist in this trade — exported services, some
  -- residential work — and PINT AE requires the category on the document even
  -- when the rate makes it look redundant.
  ADD COLUMN "tax_category_code" varchar(4) DEFAULT 'S' NOT NULL,

  -- UNCL4461 payment means. '30' is credit transfer, which is how this business
  -- is paid. PINT AE mandatory.
  ADD COLUMN "payment_means_code" varchar(4) DEFAULT '30' NOT NULL,
  ADD COLUMN "payment_terms_days" smallint,

  -- BT-10 / BT-13. An owners association or property manager will not pay an
  -- invoice that does not quote their own reference back at them, and chasing
  -- that by email is a fortnight of DSO per occurrence.
  ADD COLUMN "buyer_reference" varchar(64),
  ADD COLUMN "purchase_order_reference" varchar(64),

  ADD COLUMN "issued_by_id" uuid;
--> statement-breakpoint

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_issued_by_id_users_id_fk"
  FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_supplier_trn_format"
  CHECK ("supplier_trn" IS NULL OR "supplier_trn" ~ '^[0-9]{15}$') NOT VALID;
--> statement-breakpoint

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_recipient_trn_format"
  CHECK ("recipient_trn" IS NULL OR "recipient_trn" ~ '^[0-9]{15}$') NOT VALID;
--> statement-breakpoint

-- An exchange rate without a source currency, or a source currency without a
-- rate, is half of an Article 59 disclosure and reads as an omission to an
-- auditor. They arrive together or not at all.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_exchange_rate_pair"
  CHECK (("source_currency" IS NULL) = ("exchange_rate" IS NULL)) NOT VALID;
--> statement-breakpoint

-- The database's share of INV-3.
--
-- The full refusal lives in `packages/core/src/invoice.ts`, because TRD §10 puts
-- it there: the render refuses on a missing mandatory field, which catches the
-- fields the database cannot judge (is the supplier TRN configured at all?) and
-- reports every one of them at once instead of the first. This constraint is the
-- narrower guarantee — that a row which claims to be an issued tax invoice
-- carries the facts that can only be known at the moment of issue.
--
-- Two deliberate holes:
--
--   * `supplier_trn` is NOT required here. The business's TRN is configuration
--     (OPEN-7 is still open), and a database that refuses to store an invoice
--     until an environment variable is set is a database that stops the office
--     working. Rendering refuses instead — which is the right place, because a
--     document that is never printed is never issued.
--   * Rows issued before this migration are exempt by date. They could not have
--     carried these fields, and back-filling a supplier address onto a 2026
--     invoice would be inventing a fact rather than recording one. NOT VALID
--     alone would not be enough: it still checks rows on UPDATE, so recording a
--     payment against a historical invoice would fail.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_article59_fields" CHECK (
    "status" = 'draft'
    OR "issued_on" IS NULL
    OR "issued_on" < TIMESTAMPTZ '2026-08-21 00:00:00+04'
    OR (
      "supply_date" IS NOT NULL
      AND "supplier_name" IS NOT NULL
      AND "recipient_name" IS NOT NULL
    )
  ) NOT VALID;
--> statement-breakpoint

-- INV-5's query asks "which signed-off jobs have no invoice", which is an
-- anti-join on job_id. Without this it is a sequential scan over every invoice
-- the tenant has ever raised, run daily and growing forever.
CREATE INDEX "invoices_job_idx" ON "invoices" ("tenant_id", "job_id") WHERE "job_id" IS NOT NULL;
--> statement-breakpoint

-- INV-4's gap report and the VAT return pack both read the issued series in
-- reference order.
CREATE INDEX "invoices_series_idx" ON "invoices" ("tenant_id", "document_type", "reference");
--> statement-breakpoint

-- ── Invoice lines: per-line tax, in AED (Article 59) ────────────────────────
--
-- Article 59 requires quantity, unit price, tax rate and **tax amount in AED**
-- per line. The existing table stopped at the line total, which means every
-- invoice this system has issued omitted a mandatory field on every line.
--
-- The new money columns are NULLABLE ON PURPOSE and are not back-filled.
-- Apportioning a document-level discount and its VAT across the lines of a
-- historical invoice would produce numbers that were never on the document —
-- plausible ones, which is worse than none. A null reads as "this invoice
-- predates per-line tax capture", and the render check in core refuses it,
-- which is the truthful outcome. A default of '0.00' would instead assert that
-- no tax was charged.
ALTER TABLE "invoice_lines"
  ADD COLUMN "discount_amount" numeric(14, 2),
  ADD COLUMN "net_amount" numeric(14, 2),
  ADD COLUMN "tax_rate_basis_points" integer,
  ADD COLUMN "tax_amount" numeric(14, 2),
  ADD COLUMN "tax_category_code" varchar(4) DEFAULT 'S' NOT NULL,

  -- UN/ECE Recommendation 20 code for the unit. PINT AE will not accept "m2"
  -- or "ea"; it wants 'MTK' and 'H87'. The human-readable `unit` stays, because
  -- that is what the customer reads, and the code is what the ASP reads.
  ADD COLUMN "unit_code" varchar(8),

  -- Which job this line billed. The invoice screen groups lines by job, and a
  -- disputed line is answered by opening the job it came from.
  ADD COLUMN "job_id" uuid;
--> statement-breakpoint

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_job_id_jobs_id_fk"
  FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE set null;
--> statement-breakpoint

-- ── Tax credit notes (INV-7) ────────────────────────────────────────────────
--
-- A separate table rather than a negative row in `invoices`, and the reason is
-- narrow: every existing query over `invoices` — AR ageing, the overdue sweep,
-- the reminder cron, the gap report over the INV series — assumes each row is
-- money owed to the business. A negative-signed second document type would
-- change what all of them mean, silently, and the first symptom would be an
-- ageing report that no longer reconciles.
--
-- This is not in tension with INV-6's "never a second object". That rule is
-- about the simplified invoice, which is the *same document* rendered with
-- fewer fields and which disappears in 2027. A credit note is a different legal
-- document with its own mandatory series and its own 14-day clock. Both tables
-- feed one document model in `packages/core/src/invoice.ts`, so there is still
-- exactly one renderer and one validation schema.
CREATE TABLE "credit_notes" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	-- Its own series, allocated by app_next_reference with the 'CRN' prefix.
	-- Sharing the INV series would put gaps in it, and a gap in the invoice
	-- sequence is an FTA audit flag (INV-4).
	"reference" varchar(32) NOT NULL,
	"document_type" varchar(24) DEFAULT 'tax_credit_note' NOT NULL,
	-- Article 60 requires the credit note to reference the original invoice.
	-- ON DELETE restrict, not cascade: deleting an invoice out from under its
	-- credit note would leave a document referencing nothing.
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'issued' NOT NULL,
	-- return | discount | cancellation | correction. The reason is mandatory
	-- because "output tax was reduced" without a cause is precisely the entry an
	-- auditor asks about, and reconstructing it two years later is guesswork.
	"reason" varchar(32) NOT NULL,
	"reason_detail" text,
	"issued_on" timestamp with time zone,
	-- The date of the event being credited. The 14-day clock runs from here,
	-- exactly as it does for an invoice.
	"supply_date" date,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"taxable_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_rate_basis_points" integer DEFAULT 500 NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	-- Positive, like the invoice it credits. The sign lives in the document
	-- type, not in the number: a stored negative would be double-negated the
	-- first time somebody wrote `total - credited` and would look right.
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"source_currency" varchar(3),
	"exchange_rate" numeric(18, 6),
	"exchange_rate_source" varchar(80),
	"tax_category_code" varchar(4) DEFAULT 'S' NOT NULL,
	"supplier_name" varchar(200),
	"supplier_trn" varchar(15),
	"supplier_address" text,
	"supplier_licence_number" varchar(32),
	"supplier_cr_number" varchar(32),
	"supplier_phone" varchar(24),
	"supplier_email" varchar(200),
	"supplier_country" varchar(2) DEFAULT 'AE' NOT NULL,
	"recipient_name" varchar(200),
	"recipient_trn" varchar(15),
	"recipient_address" text,
	"recipient_country" varchar(2) DEFAULT 'AE' NOT NULL,
	"pdf_storage_key" text,
	"issued_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

CREATE TABLE "credit_note_lines" (
	"tenant_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"position" smallint DEFAULT 1 NOT NULL,
	"service_slug" varchar(64),
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" varchar(24) DEFAULT 'ea' NOT NULL,
	"unit_code" varchar(8),
	"unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"net_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_rate_basis_points" integer DEFAULT 500 NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_category_code" varchar(4) DEFAULT 'S' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_invoice_id_invoices_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_issued_by_id_users_id_fk"
  FOREIGN KEY ("issued_by_id") REFERENCES "users"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_reason_known"
  CHECK ("reason" IN ('return', 'discount', 'cancellation', 'correction'));
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_supplier_trn_format"
  CHECK ("supplier_trn" IS NULL OR "supplier_trn" ~ '^[0-9]{15}$');
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_recipient_trn_format"
  CHECK ("recipient_trn" IS NULL OR "recipient_trn" ~ '^[0-9]{15}$');
--> statement-breakpoint
ALTER TABLE "credit_notes"
  ADD CONSTRAINT "credit_notes_exchange_rate_pair"
  CHECK (("source_currency" IS NULL) = ("exchange_rate" IS NULL));
--> statement-breakpoint

ALTER TABLE "credit_note_lines"
  ADD CONSTRAINT "credit_note_lines_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "credit_note_lines"
  ADD CONSTRAINT "credit_note_lines_credit_note_id_credit_notes_id_fk"
  FOREIGN KEY ("credit_note_id") REFERENCES "credit_notes"("id") ON DELETE cascade;
--> statement-breakpoint

CREATE UNIQUE INDEX "credit_notes_tenant_reference_key" ON "credit_notes" ("tenant_id", "reference");
--> statement-breakpoint
CREATE INDEX "credit_notes_invoice_idx" ON "credit_notes" ("tenant_id", "invoice_id");
--> statement-breakpoint
CREATE INDEX "credit_notes_customer_idx" ON "credit_notes" ("tenant_id", "customer_id", "issued_on");
--> statement-breakpoint
CREATE INDEX "credit_note_lines_note_idx" ON "credit_note_lines" ("tenant_id", "credit_note_id", "position");
--> statement-breakpoint

-- RLS is NOT configured here. `sql/rls.sql` applies the same policy shape to
-- every table carrying a tenant_id, so re-running it after this migration
-- covers both new tables — which is also why `tenant_id` is the first column
-- rather than an afterthought halfway down.
