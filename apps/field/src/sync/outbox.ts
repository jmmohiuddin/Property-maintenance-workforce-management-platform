/**
 * The transactional outbox (TRD §8.3).
 *
 * ```
 * Local mutation
 *   ├─ write domain row          ─┐
 *   └─ write outbox row          ─┴─ same SQLite transaction
 *                                    (survives the app being killed mid-save)
 * ```
 *
 * ── WHY THE SAME TRANSACTION IS THE WHOLE POINT ────────────────────────────
 *
 * Two writes that are not atomic have two failure modes and both are bad. A
 * domain row without an outbox row is work that will never sync and that the
 * technician believes is saved - the silent loss the product cannot survive. An
 * outbox row without a domain row is a mutation describing a record that does
 * not exist locally, which the app cannot render, retry meaningfully, or
 * explain.
 *
 * A process being killed between two writes is not hypothetical on a phone.
 * iOS terminates backgrounded apps without warning, and the moment it is most
 * likely to is the moment a camera-heavy app comes back to the foreground -
 * i.e. exactly after a technician photographs something.
 *
 * This module is the **pure half**: the row shape, the state machine, the
 * retry arithmetic and the ordering rules, none of which touch SQLite. The
 * WatermelonDB writer that puts it in a transaction is
 * `src/db/watermelon.ts`, which is React Native code and is not typechecked by
 * the root gate. **The atomicity claim above is therefore a claim about code
 * that this session could not execute.** See the report.
 */

import { mutationKind, type FieldMutationKind, type MutationEntity, type MutationOp, type OutboundMutation } from "./protocol";

/**
 * TRD names four states. This adds a fifth, `conflicted`, and the reason is
 * `FLD-17`: *"A silently stuck queue is worse than a visible error."*
 *
 * TRD names four states. This has six, and each extra one exists because the
 * server returns a verdict the other five would misrepresent - `FLD-17`:
 * *"A silently stuck queue is worse than a visible error."*
 *
 *   `dead`        we gave up after N attempts. A transport failure, or a
 *                 response this build cannot read.
 *   `conflicted`  the server understood it and **a dispatcher must decide** -
 *                 the office closed the job while the technician was offline.
 *                 Nothing the technician can do about it from a plant room.
 *   `refused`     the server understood it and **the technician can fix it**:
 *                 the `JOB-15` gate, with the outstanding conditions attached.
 *
 * Folding `refused` into `dead` would put a correctable job card in the same
 * bucket as a flaky connection. Folding it into `conflicted` would send the
 * technician to call the office about something they can finish themselves in
 * two minutes. The three verdicts need three different sentences on screen and
 * three different next actions, so they are three states.
 */
export type OutboxStatus = "pending" | "inflight" | "done" | "dead" | "conflicted" | "refused";

export interface OutboxRow {
  readonly clientId: string;
  readonly entity: MutationEntity;
  readonly op: MutationOp;
  readonly jobId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * An ISO timestamp, not an integer - the server's `FieldMutation.baseVersion`
   * is `string | null`. Null for anything append-only, which cannot be stale.
   */
  readonly baseVersion: string | null;
  readonly dependsOnClientId: string | null;
  /** Device wall-clock at creation, ISO-8601. Sent as `recorded_offline_at`. */
  readonly createdAt: string;
  /** Monotonic reading at creation - the ordering key that a clock change cannot break. */
  readonly createdMonotonic: number;
  readonly attemptCount: number;
  /** Monotonic deadline, not wall-clock: a clock change must not release the whole queue. */
  readonly nextAttemptAfter: number;
  readonly status: OutboxStatus;
  /** Set on `dead`, `conflicted` or `refused`. What the technician is shown. */
  readonly lastError: string | null;
  /**
   * The server's `JOB-15` gap codes, on a `refused` completion. Null on every
   * other state and on a refusal that was not the completion gate - **absent
   * is not empty**, because an empty list would mean the card is complete.
   */
  readonly refusalGaps: readonly string[] | null;
  /** Set from the mutation response. ADR 0004's server receipt time. */
  readonly serverReceivedAt: string | null;
}

export function toOutboundMutation(row: OutboxRow): OutboundMutation {
  return {
    clientId: row.clientId,
    entity: row.entity,
    op: row.op,
    payload: row.payload,
    baseVersion: row.baseVersion,
    dependsOnClientId: row.dependsOnClientId,
    recordedOfflineAt: row.createdAt,
  };
}

/**
 * `entity/op` as the server's closed vocabulary spells it.
 *
 * `jobId` is deliberately **not** on the wire: the server derives it from the
 * payload and scopes the write by the technician's own row-level access. The
 * device keeps it locally because the drain planner groups by aggregate root,
 * which is a client-side ordering concern the server has no part in.
 */
export function kindOf(row: OutboxRow): FieldMutationKind {
  return mutationKind(row.entity, row.op) as FieldMutationKind;
}

/**
 * The server deferred this row: its dependency has not arrived yet.
 *
 * Back to `pending` **without charging an attempt**. A deferral is not a
 * failure - it is the server saying "correct, but not yet", and spending the
 * retry budget on it would kill a photo whose parent event is simply later in
 * the queue.
 */
export function afterDeferred(row: OutboxRow, monotonicNow: number, dependsOn: string): OutboxRow {
  return {
    ...row,
    status: "pending",
    nextAttemptAfter: monotonicNow,
    lastError: `Waiting for ${dependsOn} to reach the office first.`,
  };
}

/**
 * The server rejected this row: it will never succeed.
 *
 * Straight to `dead`, visibly. Retrying a deterministic rejection is how a
 * queue looks busy for a week while achieving nothing.
 */
export function afterRejected(row: OutboxRow, message: string): OutboxRow {
  return { ...row, status: "dead", lastError: message };
}

// ── Retry arithmetic ────────────────────────────────────────────────────────

/**
 * Exponential backoff with full jitter, capped (TRD §8.3).
 *
 * The jitter is not decoration. A crew of eight technicians leaves a site
 * together, eight phones regain signal within a second of each other, and
 * unjittered backoff has all eight retrying in lockstep for ever - the
 * thundering herd, aimed at an endpoint that is already the one that failed.
 *
 * Full jitter (a uniform draw over `[0, backoff]`) rather than the half-jitter
 * variant, because the failure being defended against here is synchronised
 * clients rather than a slow server, and full jitter spreads them furthest.
 *
 * The cap is 15 minutes: long enough that a phone in a dead zone is not
 * burning battery on radio wake-ups, short enough that a technician who walks
 * outside sees the queue move without opening the app and forcing it. The base
 * is 2 seconds, so the sequence is roughly 2s, 4s, 8s ... 15m, 15m.
 */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_CAP_MS = 15 * 60_000;

/**
 * Eight attempts, spanning roughly an hour and a half.
 *
 * The number is a judgement about what "give up" should mean. Too low and a
 * genuine two-hour outage buries a day's work in the dead letter list, where
 * it needs a person. Too high and a mutation the server will never accept
 * hides at the back of the queue for a day before anyone is told. Eight puts
 * the give-up point inside the same shift, which is the property that matters:
 * the technician who created the record is still at work when they are told.
 */
export const MAX_ATTEMPTS = 8;

export function backoffMs(attemptCount: number, random: () => number = Math.random): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1));
  return Math.round(random() * exponential);
}

// ── State transitions ───────────────────────────────────────────────────────

/**
 * A transport failure. The row goes back to `pending` with a later deadline,
 * or to `dead` once it has run out of attempts.
 */
export function afterTransportFailure(
  row: OutboxRow,
  monotonicNow: number,
  error: string,
  random: () => number = Math.random,
): OutboxRow {
  const attemptCount = row.attemptCount + 1;
  if (attemptCount >= MAX_ATTEMPTS) {
    return { ...row, attemptCount, status: "dead", lastError: error, nextAttemptAfter: monotonicNow };
  }
  return {
    ...row,
    attemptCount,
    status: "pending",
    lastError: error,
    nextAttemptAfter: monotonicNow + backoffMs(attemptCount, random),
  };
}

/**
 * A protocol failure - the server answered in a shape this build cannot read.
 *
 * Straight to `dead`, without consuming the retry budget one attempt at a
 * time. Repeating a request whose response is unparseable produces the same
 * unparseable response, and the only fix is a new build of the app; spending
 * eight attempts and ninety minutes to discover that helps nobody.
 */
export function afterProtocolFailure(row: OutboxRow, monotonicNow: number, error: string): OutboxRow {
  return {
    ...row,
    attemptCount: row.attemptCount + 1,
    status: "dead",
    lastError: error,
    nextAttemptAfter: monotonicNow,
  };
}

export function afterAccepted(row: OutboxRow, serverReceivedAt: string): OutboxRow {
  return { ...row, status: "done", serverReceivedAt, lastError: null };
}

export function afterConflict(row: OutboxRow, message: string): OutboxRow {
  return { ...row, status: "conflicted", lastError: message };
}

/**
 * The `JOB-15` gate refused this completion.
 *
 * **The queued write is kept, not dropped and not retried.** Retrying is
 * pointless - the answer is deterministic and will not change until the
 * technician adds the missing photograph. Dropping it would lose the work.
 * So it sits in `refused` carrying the gaps, the job card reopens on them, and
 * fixing one mints a new mutation.
 */
export function afterRefusal(
  row: OutboxRow,
  message: string,
  gaps: readonly string[] | null,
): OutboxRow {
  return { ...row, status: "refused", lastError: message, refusalGaps: gaps };
}

export function markInflight(row: OutboxRow): OutboxRow {
  return { ...row, status: "inflight" };
}

/**
 * Recover rows left `inflight` by a process that died mid-request.
 *
 * Called once at startup. Everything `inflight` goes back to `pending`,
 * unconditionally: the app cannot know whether the request reached the server,
 * and it does not need to, because `client_id` is the idempotency key and a
 * duplicate send is defined to be harmless. That is the whole reason
 * idempotency keys are non-negotiable in TRD §8.3 - *"the dominant real-world
 * failure is request succeeded, response lost, client retries"* - and a
 * crashed app is the same failure with a longer gap.
 *
 * The attempt count is **not** incremented. The attempt was never completed,
 * and charging the row for it would let a crash loop kill a technician's work.
 */
export function recoverInflight(rows: readonly OutboxRow[], monotonicNow: number): OutboxRow[] {
  return rows.map((row) =>
    row.status === "inflight" ? { ...row, status: "pending" as const, nextAttemptAfter: monotonicNow } : row,
  );
}

/** A technician retrying a dead row by hand. Resets the budget; keeps the history. */
export function retryByHand(row: OutboxRow, monotonicNow: number): OutboxRow {
  return { ...row, status: "pending", attemptCount: 0, nextAttemptAfter: monotonicNow };
}

// ── Queue health, for FLD-17 ────────────────────────────────────────────────

export interface QueueHealth {
  readonly waiting: number;
  readonly dead: number;
  readonly conflicted: number;
  /** Job cards the office sent back, which the technician can finish. */
  readonly refused: number;
  /** Device wall-clock ISO of the oldest item still waiting. Null when empty. */
  readonly oldestWaitingAt: string | null;
  /** What the technician sees: "3 items waiting · last synced 14:02". */
  readonly summary: string;
}

export function queueHealth(rows: readonly OutboxRow[], lastSyncedAt: string | null): QueueHealth {
  const waiting = rows.filter((r) => r.status === "pending" || r.status === "inflight");
  const dead = rows.filter((r) => r.status === "dead").length;
  const conflicted = rows.filter((r) => r.status === "conflicted").length;
  const refused = rows.filter((r) => r.status === "refused").length;

  const oldest = waiting.reduce<OutboxRow | null>(
    (acc, r) => (acc === null || r.createdMonotonic < acc.createdMonotonic ? r : acc),
    null,
  );

  const parts: string[] = [];
  parts.push(waiting.length === 1 ? "1 item waiting" : `${waiting.length} items waiting`);
  if (lastSyncedAt) parts.push(`last synced ${lastSyncedAt.slice(11, 16)}`);
  else parts.push("never synced");
  if (dead > 0) parts.push(dead === 1 ? "1 item needs attention" : `${dead} items need attention`);
  if (conflicted > 0) parts.push(conflicted === 1 ? "1 with the office" : `${conflicted} with the office`);
  // Phrased as work rather than as an error: this is a job card the technician
  // can finish, and "1 refused" reads like something that went wrong.
  if (refused > 0) parts.push(refused === 1 ? "1 job card to finish" : `${refused} job cards to finish`);

  return {
    waiting: waiting.length,
    dead,
    conflicted,
    refused,
    oldestWaitingAt: oldest?.createdAt ?? null,
    summary: parts.join(" · "),
  };
}
