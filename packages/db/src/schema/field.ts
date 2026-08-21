import {
  pgTable,
  varchar,
  text,
  integer,
  timestamp,
  uuid,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { idCol, timestamps } from "./_shared";
import { tenants, users } from "./tenancy";
import { technicians } from "./workforce";
import { jobs } from "./operations";

/**
 * The field application's server-side tables (`M11`, TRD §8.2–§8.5).
 *
 * Three tables and no more, because the field app is a *client* and almost
 * everything it records already has a table: a photograph is a
 * `job_attachments` row, a part is a `job_materials` row, a status change is a
 * `job_events` row. What did not exist was the transport — how a phone proves
 * who it is, how a mutation that was captured in a basement is recognised the
 * second time it arrives, and what happens when the answer the phone brings
 * back has been overtaken by the office.
 *
 * The rule this file is built around, and the one most easily lost: **nothing
 * here is a second copy of the job model.** `field_mutations` stores what a
 * device *claimed*, not what the system now believes. The claim's effect is
 * written by the same domain function the web action calls, and it is written
 * in the same transaction as the receipt.
 */

/**
 * A registered phone (`SEC-7`).
 *
 * ── WHY THIS IS NOT A ROW IN `sessions` ─────────────────────────────────────
 *
 * A browser session is eight hours idle and twenty-four hours absolute, which
 * is right for a coordinator at a desk and wrong for a technician who spends
 * Thursday in a plant room with no signal. A device that has to re-authenticate
 * to sync is a device that loses a day of work.
 *
 * So the shape is the same and the clocks are not: DB-backed, hashed at rest,
 * revocable by a row update, resolved through one SECURITY DEFINER function
 * that enforces every liveness condition in SQL. What differs is the lifetime
 * — thirty days, rotated on use — and the fact that a device is bound to a
 * `technician_id` as well as a user, so the API can scope every read and write
 * to the technician's own work rather than to the whole tenant.
 *
 * ── REVOCATION, WHICH IS THE POINT ──────────────────────────────────────────
 *
 * A lost phone must be revocable without disabling the person: they are still
 * employed, still on the rota, and will be issued another handset this
 * afternoon. `revoked_at` on this row does exactly that and nothing more — the
 * user's password, sessions, membership and technician record are untouched.
 *
 * The converse also holds and is enforced in `app_auth_resolve_device` rather
 * than here: deactivating the membership, the technician or the tenant kills
 * every device belonging to them, because the resolve function joins all three
 * and requires them live. Revoking a person does not require anybody to
 * remember their handsets.
 */
export const fieldDevices = pgTable(
  "field_devices",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    /** The login the device authenticates as. Its role and overrides apply. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** What the revocation screen calls it: "Yusuf's iPhone". */
    label: varchar("label", { length: 80 }).notNull(),
    /** `ios` | `android`. */
    platform: varchar("platform", { length: 16 }).notNull(),
    appVersion: varchar("app_version", { length: 24 }),
    osVersion: varchar("os_version", { length: 32 }),
    /**
     * SHA-256 of the live token, hex. The raw token exists only on the phone,
     * for the reason `sessions` gives: a database dump must not yield usable
     * credentials.
     */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    tokenIssuedAt: timestamp("token_issued_at", { withTimezone: true }).notNull().defaultNow(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }).notNull(),
    /**
     * The token this one replaced, kept **forever**, and both halves of that
     * matter.
     *
     * Kept *briefly usable* — until `previous_token_grace_until` — because the
     * dominant real-world failure on a mobile network is "request succeeded,
     * response lost". Strict rotation bricks a handset whenever the rotation
     * response is the packet that goes missing, which on a hotel guest network
     * is not rare.
     *
     * Kept *readable after that* because a token presented once its successor
     * has been used and its grace has passed did not come from this phone. That
     * is theft, it is detectable for the price of one more column comparison,
     * and the response is to revoke the device rather than to return a bland
     * 401 that tells nobody anything.
     */
    previousTokenHash: varchar("previous_token_hash", { length: 64 }),
    previousTokenGraceUntil: timestamp("previous_token_grace_until", { withTimezone: true }),
    /** Monotonic. Only ever read by a human asking how often this phone rotated. */
    tokenGeneration: integer("token_generation").notNull().default(1),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastPullAt: timestamp("last_pull_at", { withTimezone: true }),
    /**
     * Device clock minus server clock, in milliseconds, as last measured.
     *
     * Device clocks are wrong, and a support call that begins "the times on
     * this job sheet are nonsense" is answered from this column. Positive means
     * the handset runs fast.
     */
    clockSkewMs: integer("clock_skew_ms"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedById: uuid("revoked_by_id").references(() => users.id, { onDelete: "set null" }),
    revokedReason: varchar("revoked_reason", { length: 160 }),
    ...timestamps,
  },
  (t) => [
    // Unique, and the index the resolve function runs on. Token lookup happens
    // on every field request; a sequential scan here would be the whole API's
    // cost floor.
    uniqueIndex("field_devices_token_key").on(t.tokenHash),
    index("field_devices_prev_token_idx").on(t.previousTokenHash),
    index("field_devices_tech_idx").on(t.tenantId, t.technicianId, t.revokedAt),
  ],
);

/**
 * The server half of the transactional outbox (TRD §8.3): one row per mutation
 * a device has ever sent, keyed by the id the device generated.
 *
 * ── WHY THE RECEIPT IS NOT OPTIONAL ─────────────────────────────────────────
 *
 * The failure this exists for is not "the network was down". It is *"the
 * request succeeded and the response was lost"*, which is the common case, and
 * whose signature is a retry of work the server has already done. Without a
 * ledger keyed on `client_id` that retry books the compressor twice, bills the
 * part twice, and completes the job twice. There is no application-level
 * cleverness that substitutes for writing down what you have already accepted.
 *
 * `result` is stored so a replay returns the *same answer*, not merely a
 * different success. A device that retries and is told "accepted, id X" once
 * and "accepted, id Y" the next time has two rows on its conscience and no way
 * to know which one the server kept.
 *
 * ── TWO CLOCKS, ALWAYS ──────────────────────────────────────────────────────
 *
 * `recorded_offline_at` is what the handset said. `received_at` is when the
 * server heard it. Reports read the second. `attendance_events` already carries
 * the same pair for the same reason, and this table is where the divergence is
 * measured — `clock_skew_ms` is the number that makes the correction auditable
 * instead of invisible.
 */
export const fieldMutations = pgTable(
  "field_mutations",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => fieldDevices.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    /** ULID, generated on the device. Also the idempotency key. */
    clientId: varchar("client_id", { length: 32 }).notNull(),
    /** `job_status` | `job_outcome` | `job_attachment` | … */
    entity: varchar("entity", { length: 32 }).notNull(),
    op: varchar("op", { length: 24 }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** What the device believed the server held. Optimistic concurrency. */
    baseVersion: varchar("base_version", { length: 64 }),
    /**
     * Ordering. A completion record must never arrive before the photograph it
     * cites, so the photograph's `client_id` is named here and the completion
     * waits until that one is accepted.
     */
    dependsOnClientId: varchar("depends_on_client_id", { length: 32 }),
    /** `accepted` | `conflict` | `rejected`. Never `pending`: see below. */
    status: varchar("status", { length: 16 }).notNull(),
    /** Replayed verbatim when the same `client_id` arrives again. */
    result: jsonb("result").notNull().default({}),
    conflictReason: varchar("conflict_reason", { length: 48 }),
    /** The device's clock. Never used for a report. */
    recordedOfflineAt: timestamp("recorded_offline_at", { withTimezone: true }),
    /** The server's clock. This is the one reports read. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    clockSkewMs: integer("clock_skew_ms"),
  },
  (t) => [
    // The idempotency guarantee, held by the database rather than remembered by
    // the application. A concurrent double-submit of one `client_id` — two
    // retries racing on a flapping connection — is refused here even though
    // both passed the "have I seen this?" read.
    uniqueIndex("field_mutations_client_key").on(t.tenantId, t.clientId),
    index("field_mutations_device_idx").on(t.tenantId, t.deviceId, t.receivedAt),
    // Dependency resolution reads this the other way round.
    index("field_mutations_depends_idx").on(t.tenantId, t.dependsOnClientId),
  ],
);

/**
 * A sync conflict that a merge rule must not decide (TRD §8.4, ADR 0004).
 *
 * ── WHY THIS IS A TABLE AND NOT AN ERROR CODE ───────────────────────────────
 *
 * Almost every "sync conflict" in field service is self-inflicted by modelling
 * events as mutable state, and §8.4's table dissolves the rest: append-only
 * facts cannot conflict, additive collections union by client id, counters are
 * entries that get summed. What survives is one genuine case, and the ADR names
 * it exactly:
 *
 *   > A technician marking a job complete offline while a dispatcher cancels it
 *   > online is a real conflict that needs a human, not a merge rule.
 *
 * Both parties are right on the facts they hold. The technician did the work;
 * the office did cancel the job. No rule chooses correctly between them, and
 * every rule that tries picks silently — which means the loser's work vanishes
 * with nobody informed. So the conflict is written down, it is unresolved until
 * a person resolves it, and it is queued where the person who can decide is
 * already looking: the dispatch board.
 *
 * `resolved_at` is the whole workflow. A conflict with a null in that column is
 * work nobody has adjudicated, and a count of those is the number the board
 * shows.
 */
export const fieldConflicts = pgTable(
  "field_conflicts",
  {
    id: idCol(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => fieldDevices.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id")
      .notNull()
      .references(() => technicians.id, { onDelete: "cascade" }),
    /** The mutation that could not be applied. Joins back to `field_mutations`. */
    clientId: varchar("client_id", { length: 32 }).notNull(),
    /** `status_conflict` | `illegal_transition` | `text_overwritten`. */
    kind: varchar("kind", { length: 32 }).notNull(),
    /**
     * The sentence the dispatcher reads. Written by the domain layer at the
     * moment the conflict is detected, because that is the only place that
     * knows both sides — reconstructing it on the board would mean the board
     * guessing at what the device meant.
     */
    detail: text("detail").notNull(),
    /** What the technician tried to record, including anything about to be lost. */
    attempted: jsonb("attempted").notNull().default({}),
    /** What the server held instead. */
    serverState: jsonb("server_state").notNull().default({}),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedById: uuid("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    /** `accepted` | `rejected` | `superseded`. */
    resolution: varchar("resolution", { length: 24 }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    // One conflict per mutation. A device retrying a mutation that is already
    // in dispute must not add a second entry to the dispatcher's queue.
    uniqueIndex("field_conflicts_client_key").on(t.tenantId, t.clientId),
    // The board's query: unresolved, oldest first.
    index("field_conflicts_open_idx").on(t.tenantId, t.resolvedAt, t.raisedAt),
    index("field_conflicts_job_idx").on(t.tenantId, t.jobId),
  ],
);
