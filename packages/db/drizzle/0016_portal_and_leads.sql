-- Customer portal (`POR-3`, `POR-4`, `POR-5`) and lead nurture (`LEAD-5`,
-- `LEAD-8`, `LEAD-9`).
--
-- Four things, and every one of them exists because the alternative is a
-- silent wrong answer rather than an error:
--
--   1. `customer_notification_preferences` — POR-5's per-event opt-out. A
--      single "email me" boolean is what makes a customer turn everything off
--      to stop one message, and the message they wanted to keep was the quote
--      awaiting their decision.
--   2. `app_phone_key()` and the functional indexes over it — LEAD-5's matcher.
--      "+971 50 123 4567", "050 123 4567" and "00971501234567" are one phone
--      number written three ways, and a duplicate check comparing the stored
--      strings finds none of them.
--   3. Keyset indexes and trigram search — LEAD-8. The requirement says
--      *indexed*, and a search that seq-scans 5,000 leads is a search that
--      works in the demo and stops working in the second year.
--   4. `leads.last_interaction_at` — the nurture clock LEAD-9's log winds, and
--      the column `retention.ts` reports as missing for LEAD-7. It is added
--      here rather than there because a lead's last interaction is a fact the
--      communications log produces; retention only reads it.

-- ── POR-5. Per-event customer notification preferences ──────────────────────
--
-- Absence of a row means opted IN. That is deliberate and it is the direction
-- that fails safely for the *customer*: a request they raised is acknowledged
-- and an invoice they owe is announced without anyone having to switch it on
-- first. Opting out is a row saying so, which is also what makes "who turned
-- this off, and when" answerable.
--
-- Scoped per customer rather than per portal user. The events are facts about
-- the customer's account — an invoice is issued to the account, not to a
-- person — and a per-user table would mean the second building manager silently
-- inherits the first one's choices or silently does not.
CREATE TABLE "customer_notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	-- Constrained, not free text. This value is compared against a template id
	-- in code; a typo in a form post must be a rejected write rather than a
	-- preference row that silently matches nothing and reads as "opted in".
	"event" varchar(40) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_notification_preferences_event" CHECK ("event" IN (
		'request_received',
		'visit_scheduled',
		'technician_en_route',
		'work_complete',
		'quote_awaiting_decision',
		'invoice_issued',
		'payment_received'
	))
);--> statement-breakpoint

ALTER TABLE "customer_notification_preferences"
	ADD CONSTRAINT "customer_notification_preferences_tenant_id_tenants_id_fk"
	FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "customer_notification_preferences"
	ADD CONSTRAINT "customer_notification_preferences_customer_id_customers_id_fk"
	FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "customer_notification_preferences"
	ADD CONSTRAINT "customer_notification_preferences_updated_by_id_users_id_fk"
	FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- One row per customer per event. The upsert in `setCustomerNotificationPreference`
-- depends on this: without it two rapid toggles leave two contradictory rows and
-- which one wins is whichever the planner happens to read first.
CREATE UNIQUE INDEX "customer_notification_prefs_key"
	ON "customer_notification_preferences" USING btree ("tenant_id","customer_id","event");--> statement-breakpoint

-- ── LEAD-5. Duplicate detection ─────────────────────────────────────────────
--
-- The matcher compares the **national significant number**: the digits left
-- after the international prefix, the country code and the trunk zero are
-- removed. Written out, the three ways one UAE number reaches this system are
--
--     +971 50 123 4567   →  501234567
--     050 123 4567       →  501234567
--     00971501234567     →  501234567
--
-- and the same for a landline, which is one digit shorter:
--
--     +971 4 555 0100    →  45550100
--     04 555 0100        →  45550100
--
-- ── WHY NOT "THE LAST NINE DIGITS" ─────────────────────────────────────────
--
-- Because that is the rule for mobiles only, and it fails silently on
-- landlines. A UAE mobile subscriber number is nine digits (5XXXXXXXX) and a
-- landline is eight (4XXXXXXX), so taking a fixed nine from the right of
-- "+971 4 555 0100" keeps a digit of the country code and produces a key that
-- can never equal the one derived from "04 555 0100". Every office switchboard
-- in the database would be its own duplicate-free island — and an owners
-- association is exactly the customer whose number is a landline.
--
-- Stripping is ordered and each step is separate: the "00" international
-- prefix, then the 971 country code, then any trunk zeros. `971` is safe to
-- remove because no UAE national number begins with it — they start with 5
-- (mobile) or a 2/3/4/6/7/9 area code.
--
-- IMMUTABLE because a functional index requires it, and it genuinely is: the
-- output depends on nothing but the input. STRICT so a null phone costs no
-- function call and indexes as null rather than as an empty key that matches
-- everything.
--
-- NOTE FOR ANYONE CHANGING THIS: the indexes below are built on its output, so
-- an edit needs `REINDEX` on every one of them. A changed definition with stale
-- indexes is a matcher that finds nothing and reports no error.
CREATE OR REPLACE FUNCTION app_phone_key(raw text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
	SELECT CASE
		-- Under seven digits is not a phone number, it is a fragment somebody
		-- typed. Returning it would make every short string a match for every
		-- other short string ending the same way.
		WHEN length(d.nsn) < 7 THEN NULL
		ELSE d.nsn
	END
	FROM (
		SELECT ltrim(
		         regexp_replace(
		           regexp_replace(
		             regexp_replace(raw, '\D', '', 'g'),
		           '^00', ''),
		         '^971', ''),
		       '0') AS nsn
	) d
$$;--> statement-breakpoint

-- An existing customer this enquiry appears to be from. Set by the strict
-- matcher (phone AND email), suggested by the loose one.
--
-- Deliberately NOT `converted_customer_id`: that column means "this lead became
-- this customer and the lead is won", and writing a match into it would move
-- revenue into the won column for an enquiry nobody has spoken to yet.
ALTER TABLE "leads" ADD COLUMN "matched_customer_id" uuid;--> statement-breakpoint

-- The earlier lead this one repeats. The duplicate row is kept rather than
-- rejected: an enquiry that arrives twice is still an enquiry, and a form that
-- silently swallows the second submission is indistinguishable from a form that
-- is broken.
ALTER TABLE "leads" ADD COLUMN "duplicate_of_lead_id" uuid;--> statement-breakpoint

ALTER TABLE "leads"
	ADD CONSTRAINT "leads_matched_customer_fk"
	FOREIGN KEY ("matched_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "leads"
	ADD CONSTRAINT "leads_duplicate_of_fk"
	FOREIGN KEY ("duplicate_of_lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- A lead cannot be a duplicate of itself. Cheap to enforce, and the recursive
-- walk in `resolveDuplicateChain` would otherwise never terminate.
ALTER TABLE "leads"
	ADD CONSTRAINT "leads_duplicate_not_self" CHECK ("duplicate_of_lead_id" IS DISTINCT FROM "id");--> statement-breakpoint

CREATE INDEX "leads_phone_key_idx" ON "leads" USING btree ("tenant_id", app_phone_key("phone"));--> statement-breakpoint
CREATE INDEX "leads_email_key_idx" ON "leads" USING btree ("tenant_id", lower("email"));--> statement-breakpoint
CREATE INDEX "customers_phone_key_idx" ON "customers" USING btree ("tenant_id", app_phone_key("phone"));--> statement-breakpoint
CREATE INDEX "customers_email_key_idx" ON "customers" USING btree ("tenant_id", lower("billing_email"));--> statement-breakpoint
CREATE INDEX "customer_contacts_phone_key_idx" ON "customer_contacts" USING btree ("tenant_id", app_phone_key("phone"));--> statement-breakpoint
CREATE INDEX "customer_contacts_email_key_idx" ON "customer_contacts" USING btree ("tenant_id", lower("email"));--> statement-breakpoint

-- ── LEAD-8. Search and keyset pagination ────────────────────────────────────
--
-- Keyset, not OFFSET. At page 40 an OFFSET query has already read and thrown
-- away 39 pages, and — the part that actually bites — a row inserted while
-- somebody pages shifts every later page by one, so records are silently
-- skipped. The cursor is `(created_at, id)`, and `id` is in it because
-- `created_at` is not unique: two leads recorded in the same millisecond
-- would make the boundary ambiguous and one of them would never be returned.
CREATE INDEX "leads_keyset_idx" ON "leads" USING btree ("tenant_id", "created_at" DESC, "id" DESC);--> statement-breakpoint
CREATE INDEX "customers_keyset_idx" ON "customers" USING btree ("tenant_id", "created_at" DESC, "id" DESC);--> statement-breakpoint

-- Trigram search on the name. `ILIKE '%rashid%'` cannot use a btree index at
-- all — the leading wildcard defeats it — so without this the "search" is a
-- sequential scan wearing a WHERE clause, which is exactly what `TD-10` is.
--
-- pg_trgm is a standard contrib module, present on stock Postgres and on Neon.
-- `IF NOT EXISTS` so a re-run is a no-op.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "leads_name_trgm_idx" ON "leads" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "customers_name_trgm_idx" ON "customers" USING gin ("name" gin_trgm_ops);--> statement-breakpoint

-- ── LEAD-9 / LEAD-7. The nurture clock ──────────────────────────────────────
--
-- When anybody last actually touched this lead — a call logged, a WhatsApp
-- sent, a stage moved. Distinct from `updated_at`, which a bulk backfill or a
-- schema migration moves without anybody having spoken to anyone, and distinct
-- from `next_follow_up_at`, which is an intention rather than a fact.
--
-- `retention.ts` reports that `leads` has no `last_interaction_at` and that
-- LEAD-7's retention clock therefore cannot start. This is that column. It is
-- added by the nurture work because the communications log is what maintains
-- it; retention only reads it.
ALTER TABLE "leads" ADD COLUMN "last_interaction_at" timestamp with time zone;--> statement-breakpoint

-- Backfilled from `created_at`, not from `updated_at`. The enquiry arriving IS
-- an interaction — it is the first one — whereas `updated_at` on an untouched
-- lead may have moved for reasons that involved no human at all, and a
-- retention clock started from that would be wrong in the direction of keeping
-- personal data longer than it should.
UPDATE "leads" SET "last_interaction_at" = "created_at" WHERE "last_interaction_at" IS NULL;--> statement-breakpoint

ALTER TABLE "leads" ALTER COLUMN "last_interaction_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "last_interaction_at" SET NOT NULL;--> statement-breakpoint

-- The nurture sweep's query: leads in an open stage, oldest interaction first.
CREATE INDEX "leads_interaction_idx" ON "leads" USING btree ("tenant_id", "stage", "last_interaction_at");--> statement-breakpoint

-- The disposition report reads closed leads by reason over a window.
CREATE INDEX "leads_disposition_idx"
	ON "leads" USING btree ("tenant_id", "disposition_reason_id", "created_at");--> statement-breakpoint

-- ── LEAD-9. What a logged communication is allowed to say ───────────────────
--
-- `communications` has existed since 0000 and nothing has ever written to it.
-- The one field it was missing is the one the requirement names last and that
-- the report needs first: *outcome*. "Called Ahmed" and "Called Ahmed, no
-- answer, trying again Sunday" are the same row without it, and only the second
-- tells anybody whether to call again.
--
-- Coded rather than typed, for the same reason `lead_disposition_reasons`
-- exists: a follow-up report cannot group "no answer", "No Answer", "n/a" and
-- "didn't pick up".
ALTER TABLE "communications" ADD COLUMN "outcome" varchar(32);--> statement-breakpoint

ALTER TABLE "communications"
	ADD CONSTRAINT "communications_outcome" CHECK ("outcome" IS NULL OR "outcome" IN (
		'spoke',
		'no_answer',
		'voicemail',
		'wrong_number',
		'site_visit_booked',
		'quote_requested',
		'not_interested',
		'call_back_later',
		'sent'
	));--> statement-breakpoint

-- A communication must be about something. Every one of the three foreign keys
-- being null is a row that can never be found again and quietly inflates
-- whatever counts it.
ALTER TABLE "communications"
	ADD CONSTRAINT "communications_has_subject" CHECK (
		"lead_id" IS NOT NULL OR "customer_id" IS NOT NULL OR "job_id" IS NOT NULL
	);--> statement-breakpoint

-- The timeline query on both detail screens: newest touch first.
CREATE INDEX "communications_lead_time_idx"
	ON "communications" USING btree ("tenant_id", "lead_id", "occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "communications_customer_time_idx"
	ON "communications" USING btree ("tenant_id", "customer_id", "occurred_at" DESC);
--> statement-breakpoint

-- ── POR-5. The sweep's idempotency lookup ───────────────────────────────────
--
-- `pendingCustomerNotifications` asks, for every candidate event, whether the
-- ledger already holds a notification with that template naming that subject.
-- The existing `notifications_subject_idx` is keyed on
-- (tenant_id, subject_table, subject_id) and cannot serve it — the predicate is
-- on `template`, which is not in that index at all.
--
-- Without this the check degrades to a scan of `notifications` per candidate,
-- on a table that only grows, inside a job that runs every five minutes. It
-- would work for months and then stop working, which is the failure mode worth
-- spending one index on.
CREATE INDEX "notifications_subject_template_idx"
	ON "notifications" USING btree ("subject_id", "template");
