-- Phase 1 — the flows that make "run a real week with zero SQL" true.
--
--   SEC-5 / ADM-2   Password reset by emailed single-use token.
--   ADM-1           Staff invitations, so a new coordinator can be onboarded
--                   without an INSERT.
--   SEC-11 / ADM-11 Sliding sessions with an absolute cap.
--
-- The definition of MVP in the PRD is precise and this migration is most of
-- what it needs: *run one real operating week — hire, dispatch, invoice, get
-- paid, stay compliant — without opening a database client.* Today there is no
-- way to create a user, reset a password or unlock an account except with SQL,
-- which is what stops the system being a product rather than a demo.

-- ── Password reset tokens (SEC-5) ───────────────────────────────────────────
--
-- The raw token exists only in the emailed link. The database stores its
-- SHA-256 hash, exactly like sessions do, so a database dump does not yield
-- usable reset links — which would otherwise be an account-takeover primitive
-- for every user at once.
--
-- SHA-256 rather than Argon2, for the same reason as sessions: the token is 32
-- bytes of CSPRNG output with no guessable structure, so there is nothing for a
-- slow hash to protect.
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	-- 30 minutes. Long enough to find the email, short enough that a link
	-- sitting in a shared inbox stops being useful quickly.
	"expires_at" timestamp with time zone NOT NULL,
	-- Set on use. A reset token is single-use: without this, a link forwarded or
	-- recovered from a mailbox stays live until it expires.
	"consumed_at" timestamp with time zone,
	"requested_ip" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Staff invitations (ADM-1) ───────────────────────────────────────────────
--
-- Separate from `password_reset_tokens` on purpose, even though the mechanics
-- rhyme. An invitation carries a role and a tenant and creates a membership on
-- acceptance; a reset does not. Collapsing them into one table with nullable
-- columns would mean the acceptance path has to decide which kind of thing it
-- is holding, and that decision is where privilege-escalation bugs live.
CREATE TABLE "user_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(200) NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"role" "user_role" NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	-- Longer than a reset: an invitation may sit until somebody starts on
	-- Monday. Still bounded, because an unbounded invitation is a permanent
	-- unauthenticated route into the tenant.
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"invited_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_invitations" ADD CONSTRAINT "user_invitations_invited_by_id_users_id_fk" FOREIGN KEY ("invited_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "password_reset_tokens_key" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
-- The sweep: expired and consumed rows are removed by /api/cron/sweep.
CREATE INDEX "password_reset_tokens_expiry_idx" ON "password_reset_tokens" USING btree ("expires_at");--> statement-breakpoint
-- Per-account rate limiting reads this: how many live tokens does this user
-- already have?
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id","created_at");--> statement-breakpoint

CREATE UNIQUE INDEX "user_invitations_key" ON "user_invitations" USING btree ("token_hash");--> statement-breakpoint
-- One live invitation per email per tenant. Re-inviting revokes and reissues
-- rather than stacking, so a revoked invitation cannot be accepted from an
-- older email.
CREATE UNIQUE INDEX "user_invitations_pending_key" ON "user_invitations" USING btree ("tenant_id", lower("email")) WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "user_invitations_tenant_idx" ON "user_invitations" USING btree ("tenant_id","created_at");--> statement-breakpoint

-- ── SEC-11: sliding sessions ────────────────────────────────────────────────
--
-- The session had a fixed 12-hour TTL and no renewal, so staff were signed out
-- mid-shift at hour 12 and lost whatever was in the form they were filling in.
-- Sliding renewal fixes the first half; an absolute cap is what stops "sliding"
-- becoming "never expires", which is how a stolen token becomes permanent.
--
-- Two clocks, and both are enforced: `expires_at` slides forward on activity,
-- `absolute_expires_at` never moves.
ALTER TABLE "sessions" ADD COLUMN "absolute_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint

-- Backfill: existing sessions get an absolute cap derived from when they were
-- created, so no live session becomes immortal at deploy time.
UPDATE "sessions" SET "absolute_expires_at" = "created_at" + interval '24 hours' WHERE "absolute_expires_at" IS NULL;
