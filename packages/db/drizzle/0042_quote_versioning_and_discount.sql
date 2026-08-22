-- QTE-10 / QTE-5: a revision has somewhere to point, and a contract discount
-- has somewhere to say where it came from.
--
-- ── QTE-10 ───────────────────────────────────────────────────────────────
--
-- `quotes.supersedes_quote_id` has existed since `0000_init` and nothing has
-- ever written it — there was no `reviseQuote`. The column needs no new type
-- (it is already a bare `uuid`, deliberately unconstrained by an FK: the
-- history it points into is quotes, and a quote is soft-deleted, never hard
-- deleted, so the reference stays resolvable). What it lacked is an index —
-- every other chain-walk in this schema (`renewed_from_contract_id` and
-- friends) is unindexed too until something reads it backwards, and this one
-- will be read backwards the first time an operator asks "what did version 1
-- say". Added now rather than after the first slow query.
--
-- ── QTE-5 ────────────────────────────────────────────────────────────────
--
-- `discount_amount` has always been able to hold a contract's negotiated rate
-- — `quoteOutOfScopeWork` (`CON-6`) has been doing exactly that since it
-- shipped, folding the number into `discount_amount` and describing it in
-- free-text `notes`. What was missing is a structured answer to "is this
-- number a contract rate or something an operator typed", which a customer
-- statement, a margin report and a dispute all need answered the same way
-- every time — a sentence buried in `notes` is not queryable and is not
-- guaranteed to survive a future edit to that field for an unrelated reason.
--
-- `discount_basis_points` and `discount_source` are the structured half.
-- Both nullable: most quotes carry no contract at all, and of those that do,
-- an operator can still override with a manual figure — recorded as no
-- source, which is itself informative (see `commerce.ts`, `createQuote`).
ALTER TABLE "quotes" ADD COLUMN "discount_basis_points" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "discount_source" varchar(160);--> statement-breakpoint

-- Same range as `contract_terms.discount_rate_basis_points` (`0013`): basis
-- points are parts of 10,000, and 10,000 itself (a 100% discount) would zero
-- every line, which `CON-6`'s own constraint already treats as out of range.
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_discount_range_check"
	CHECK ("discount_basis_points" IS NULL OR ("discount_basis_points" >= 0 AND "discount_basis_points" < 10000));--> statement-breakpoint

CREATE INDEX "quotes_supersedes_idx" ON "quotes" USING btree ("tenant_id","supersedes_quote_id");
