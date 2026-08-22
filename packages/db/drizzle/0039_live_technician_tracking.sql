-- CUST-3 / EMG-5: make a location ping idempotent.
--
-- ── WHAT WAS MISSING, AND WHY IT ONLY MATTERS NOW ──────────────────────────
--
-- `technician_locations` has existed since 0000 and, until this change, had
-- zero writers anywhere in the repository. The only code that touched it was
-- `purgeLocationTraces` -- a nightly delete of rows nothing had ever inserted.
-- So nothing about it had ever been exercised, including the question this
-- file answers.
--
-- The writer that is arriving is a handset, and a handset is offline half the
-- time. `ADR 0004` and the sync protocol in `packages/db/src/domain/field.ts`
-- are unambiguous about what that implies: every mutation the device sends
-- carries an id the device generated, and a replayed batch must produce the
-- same server state rather than a second row. That is true of a job material
-- and a photograph, and it is true of a position ping -- a van that drives
-- through a tunnel and flushes its queue twice on the other side would
-- otherwise insert every ping in the queue twice.
--
-- Duplicated pings do not break the customer-facing read: the newest row is
-- the same row either way. They break the table, which is already the one
-- flagged in the schema as growing without bound from ordinary use, and they
-- break it in the least visible way possible -- gradually, in a table nobody
-- looks at, on the days the network was worst.
--
-- ── WHY A UNIQUE INDEX AND NOT A CLIENT-ID LEDGER ──────────────────────────
--
-- `field_mutations` is the general idempotency mechanism and it stores one row
-- per mutation forever. That is right for forty job cards a day and wrong for
-- a ping every thirty seconds per van: the ledger would outgrow the data it
-- was protecting. A position is naturally keyed by who and when, so the
-- natural key is the idempotency key, and `ON CONFLICT DO NOTHING` on it costs
-- nothing and stores nothing.
--
-- Two genuine pings from one technician cannot share a `recorded_at`:
-- timestamps here are microsecond precision and the column is the device's own
-- capture instant, not an insertion time.
--
-- ── WHY THE EXISTING INDEX IS REPLACED RATHER THAN JOINED BY A SECOND ──────
--
-- `tech_locations_latest_idx` already covers exactly these three columns in
-- exactly this order, for the "latest ping for this technician" query. A
-- unique btree over the same columns answers that query identically, so
-- keeping both would pay for a second index on the highest-churn table in the
-- schema in exchange for nothing.
--
-- The dedupe below is a no-op on every database that exists today -- the table
-- has never had a writer -- and is here so this file cannot fail halfway on a
-- database that somehow does have rows. A migration that aborts partway is the
-- state 0033 and `verify-rls.sql` check 14 were both written about.
DELETE FROM "technician_locations" a
 USING "technician_locations" b
 WHERE a."id" > b."id"
   AND a."tenant_id" = b."tenant_id"
   AND a."technician_id" = b."technician_id"
   AND a."recorded_at" = b."recorded_at";--> statement-breakpoint
DROP INDEX IF EXISTS "tech_locations_latest_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "tech_locations_latest_idx" ON "technician_locations" USING btree ("tenant_id","technician_id","recorded_at");
