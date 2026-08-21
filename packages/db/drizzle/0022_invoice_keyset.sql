-- ── LEAD-8. The invoice list gets a second page ─────────────────────────────
--
-- listInvoices was a flat LIMIT 200 with no cursor, which is not "the newest
-- two hundred invoices" but "every invoice after the two hundredth cannot be
-- reached", and nothing on the screen said so. searchInvoices replaces it with
-- the same keyset cursor the lead and customer lists already use. These are the
-- indexes that make it an index scan instead of a sort of the whole table.
--
-- The sort key is coalesce(issued_on, created_at), not issued_on. A draft has
-- no issue date, and a row-wise comparison against a null column yields null
-- rather than true — so a cursor on issued_on alone would drop every draft from
-- the second page onward, which is the bug being fixed here wearing a different
-- hat. Coalescing gives every invoice a key that exists. The index has to be on
-- the identical expression or the planner will not use it for the ORDER BY.
CREATE INDEX "invoices_keyset_idx"
    ON "invoices" USING btree ("tenant_id", (coalesce("issued_on", "created_at")) DESC, "id" DESC);--> statement-breakpoint

-- The search box matches an invoice reference or a customer name. Names are
-- already covered by customers_name_trgm_idx from 0016; the reference is not,
-- and ILIKE '%INV-2026%' cannot use a btree index at all — the leading wildcard
-- defeats it. pg_trgm is created by 0016; IF NOT EXISTS so a re-run is a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "invoices_reference_trgm_idx"
    ON "invoices" USING gin ("reference" gin_trgm_ops);
