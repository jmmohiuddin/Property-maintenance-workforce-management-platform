-- The field application's transport (M11, TRD 8.2 to 8.5).
--
-- Three tables. Not a second job model: a photograph is still a
-- job_attachments row, a part is still a job_materials row, a status change is
-- still a job_events row. What did not exist was the transport -- how a phone
-- proves who it is, how a mutation captured in a basement is recognised the
-- second time it arrives, and what happens when the answer the phone brings
-- back has been overtaken by the office.
--
-- ── WHY THE FIRST TABLE IS NOT A ROW IN sessions ────────────────────────────
--
-- A browser session is eight hours idle and twenty-four hours absolute. That is
-- right for a coordinator at a desk and wrong for a technician who spends
-- Thursday in a plant room with no signal: a device that has to re-authenticate
-- in order to sync is a device that loses a day of work.
--
-- So field_devices keeps every property of sessions that is a security property
-- -- database-backed, hashed at rest, revocable by a row update, resolved
-- through one SECURITY DEFINER function that enforces liveness in SQL -- and
-- changes only the lifetime and the binding. Thirty days, rotated on use, bound
-- to a technician_id as well as a user so the API can scope reads and writes to
-- that technician's own work rather than to the whole tenant.
--
-- Revocation is the point. A lost phone must be revocable without disabling the
-- person, who is still employed and will be issued another handset this
-- afternoon: revoked_at does exactly that and touches nothing else. The
-- converse is enforced in app_auth_resolve_device rather than here --
-- deactivating the membership, the technician or the tenant kills every device
-- belonging to them, so revoking a person does not require anybody to remember
-- their handsets.

CREATE TABLE "field_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	-- The login the device authenticates as. Its role and permission overrides
	-- are what the field API applies; a device is not a privileged actor.
	"user_id" uuid NOT NULL,
	"label" varchar(80) NOT NULL,
	"platform" varchar(16) NOT NULL,
	"app_version" varchar(24),
	"os_version" varchar(32),
	-- SHA-256 hex. The raw token exists only on the phone, for the reason
	-- sessions gives: a database dump must not yield usable credentials.
	"token_hash" varchar(64) NOT NULL,
	"token_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	-- The token this one replaced, kept forever, and both halves of that matter.
	-- Kept briefly usable (until the grace expiry) because the dominant failure
	-- on a mobile network is "request succeeded, response lost", and strict
	-- rotation bricks a handset whenever the rotation response is the packet
	-- that goes missing. Kept readable after that because a token presented once
	-- its successor has been used and its grace has passed did not come from
	-- this phone -- that is theft, it is detectable for one more column
	-- comparison, and the answer is to revoke the device rather than return a
	-- bland 401 that tells nobody anything.
	"previous_token_hash" varchar(64),
	"previous_token_grace_until" timestamp with time zone,
	"token_generation" integer DEFAULT 1 NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_pull_at" timestamp with time zone,
	-- Device clock minus server clock, milliseconds, as last measured. Device
	-- clocks are wrong, and the support call that begins "the times on this job
	-- sheet are nonsense" is answered from this column.
	"clock_skew_ms" integer,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid,
	"revoked_reason" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint

-- ── The server half of the transactional outbox (8.3) ───────────────────────
--
-- One row per mutation a device has ever sent, keyed by the id the device
-- generated before the server had ever seen the record.
--
-- The failure this exists for is not "the network was down". It is "the request
-- succeeded and the response was lost", which is the common case, and whose
-- signature is a retry of work the server has already done. Without a ledger
-- keyed on client_id that retry books the compressor twice, bills the part
-- twice and completes the job twice. No application-level cleverness
-- substitutes for writing down what you have already accepted.
--
-- result is stored so a replay returns the SAME answer, not merely a different
-- success. A device told "accepted, id X" once and "accepted, id Y" the next
-- time has two rows on its conscience and no way to know which the server kept.
--
-- Two clocks, always. recorded_offline_at is what the handset said; received_at
-- is when the server heard it; reports read the second. attendance_events
-- already carries the same pair for the same reason, and this table is where
-- the divergence is measured rather than left invisible.
CREATE TABLE "field_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	-- ULID, generated on the device. Also the idempotency key.
	"client_id" varchar(32) NOT NULL,
	"entity" varchar(32) NOT NULL,
	"op" varchar(24) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- What the device believed the server held. Optimistic concurrency.
	"base_version" varchar(64),
	-- Ordering. A completion record must never arrive before the photograph it
	-- cites, so the photograph's client_id is named here and the completion
	-- waits until that one is accepted.
	"depends_on_client_id" varchar(32),
	"status" varchar(16) NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"conflict_reason" varchar(48),
	-- The device's clock. Never used for a report.
	"recorded_offline_at" timestamp with time zone,
	-- The server's clock. This is the one reports read.
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"clock_skew_ms" integer
);
--> statement-breakpoint

-- ── A conflict a merge rule must not decide (8.4, ADR 0004) ─────────────────
--
-- Almost every sync conflict in field service is self-inflicted by modelling
-- events as mutable state, and 8.4's table dissolves the rest: append-only
-- facts cannot conflict, additive collections union by client id, counters are
-- entries that get summed. What survives is one genuine case, which ADR 0004
-- names exactly -- a technician marking a job complete offline while a
-- dispatcher cancels it online.
--
-- Both parties are right about the facts they hold. The technician did the
-- work; the office did cancel the job. No rule chooses correctly between them,
-- and every rule that tries picks silently -- which means the loser's work
-- vanishes with nobody informed. So the conflict is written down, stays
-- unresolved until a person resolves it, and is queued where the person who can
-- decide is already looking.
--
-- resolved_at is the whole workflow: a null in that column is work nobody has
-- adjudicated, and a count of those is the number the dispatch board shows.
CREATE TABLE "field_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"client_id" varchar(32) NOT NULL,
	"kind" varchar(32) NOT NULL,
	-- The sentence the dispatcher reads, written by the domain layer at the
	-- moment of detection, because that is the only place that knows both sides.
	"detail" text NOT NULL,
	"attempted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"server_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_id" uuid,
	"resolution" varchar(24),
	"resolution_note" text
);
--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- Every parent cascades except the two that name a member of staff, which set
-- null: a device revoked by an administrator who later leaves the company is
-- still revoked, and a conflict adjudicated by a departed dispatcher is still
-- adjudicated. Losing the name is acceptable; losing the decision is not.
ALTER TABLE "field_devices" ADD CONSTRAINT "field_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_devices" ADD CONSTRAINT "field_devices_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_devices" ADD CONSTRAINT "field_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_devices" ADD CONSTRAINT "field_devices_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "field_mutations" ADD CONSTRAINT "field_mutations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mutations" ADD CONSTRAINT "field_mutations_device_id_field_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."field_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_mutations" ADD CONSTRAINT "field_mutations_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "field_conflicts" ADD CONSTRAINT "field_conflicts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_conflicts" ADD CONSTRAINT "field_conflicts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_conflicts" ADD CONSTRAINT "field_conflicts_device_id_field_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."field_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_conflicts" ADD CONSTRAINT "field_conflicts_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_conflicts" ADD CONSTRAINT "field_conflicts_resolved_by_id_users_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────

-- Token lookup happens on every field request, and it happens before a tenant
-- is known, so it cannot be narrowed by tenant_id. Unique and global.
CREATE UNIQUE INDEX "field_devices_token_key" ON "field_devices" USING btree ("token_hash");--> statement-breakpoint
-- The grace and reuse lookup. Its own index rather than an OR against the one
-- above, because a two-branch UNION ALL of index scans is what the resolve
-- function runs and an OR would give it a sequential scan.
CREATE INDEX "field_devices_prev_token_idx" ON "field_devices" USING btree ("previous_token_hash");--> statement-breakpoint
CREATE INDEX "field_devices_tech_idx" ON "field_devices" USING btree ("tenant_id","technician_id","revoked_at");--> statement-breakpoint

-- The idempotency guarantee, held by the database rather than remembered by the
-- application. Two retries racing on a flapping connection both pass the "have
-- I seen this?" read; only one of them gets past this index.
CREATE UNIQUE INDEX "field_mutations_client_key" ON "field_mutations" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "field_mutations_device_idx" ON "field_mutations" USING btree ("tenant_id","device_id","received_at");--> statement-breakpoint
CREATE INDEX "field_mutations_depends_idx" ON "field_mutations" USING btree ("tenant_id","depends_on_client_id");--> statement-breakpoint

-- One conflict per mutation. A device retrying a mutation already in dispute
-- must not add a second entry to the dispatcher's queue.
CREATE UNIQUE INDEX "field_conflicts_client_key" ON "field_conflicts" USING btree ("tenant_id","client_id");--> statement-breakpoint
-- The board's query: unresolved, oldest first.
CREATE INDEX "field_conflicts_open_idx" ON "field_conflicts" USING btree ("tenant_id","resolved_at","raised_at");--> statement-breakpoint
CREATE INDEX "field_conflicts_job_idx" ON "field_conflicts" USING btree ("tenant_id","job_id");--> statement-breakpoint

-- ── Constraints the application must not be the only thing enforcing ────────

-- A mutation receipt records an outcome. There is no `pending` state, and that
-- is deliberate: the receipt is written in the same transaction as the effect,
-- so a row exists only once the server has decided. A `pending` value would be
-- a row claiming a decision was in flight, which after a crash is
-- indistinguishable from one that was lost -- exactly the ambiguity the ledger
-- exists to remove.
ALTER TABLE "field_mutations" ADD CONSTRAINT "field_mutations_status_check"
	CHECK ("status" IN ('accepted', 'conflict', 'rejected'));--> statement-breakpoint

-- A conflict is resolved, or it is not. Half a resolution -- a timestamp with
-- no verdict, or a verdict with no timestamp -- would make the board's
-- "unresolved" count depend on which column it happened to test.
ALTER TABLE "field_conflicts" ADD CONSTRAINT "field_conflicts_resolution_check"
	CHECK (
		("resolved_at" IS NULL AND "resolution" IS NULL)
		OR ("resolved_at" IS NOT NULL AND "resolution" IN ('accepted', 'rejected', 'superseded'))
	);--> statement-breakpoint

-- A grace window without a token to apply it to, or a superseded token with no
-- window, are both states the rotation code cannot produce and neither of which
-- the resolve function reads sensibly. Refused here so a future writer finds
-- out at the INSERT rather than in a support call about a bricked handset.
ALTER TABLE "field_devices" ADD CONSTRAINT "field_devices_previous_token_check"
	CHECK (
		("previous_token_hash" IS NULL AND "previous_token_grace_until" IS NULL)
		OR ("previous_token_hash" IS NOT NULL AND "previous_token_grace_until" IS NOT NULL)
	);
