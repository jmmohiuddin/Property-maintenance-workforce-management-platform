/**
 * The drain planner.
 *
 * TRD §8.3: *"FIFO per aggregate root, dependency-aware."* Those are two
 * separate rules and the interesting behaviour is where they meet.
 *
 * ── FIFO PER AGGREGATE, NOT FIFO OVERALL ───────────────────────────────────
 *
 * Within one job, order is meaning: an arrival before a start before a
 * completion. Across two jobs, order is nothing - job A's completion has no
 * relationship to job B's photo. A single global FIFO would give the ordering
 * guarantee for free and pay for it with head-of-line blocking: one job stuck
 * behind a refused mutation freezes the entire day's queue, and a technician
 * who did nine good jobs and one contested one syncs none of them.
 *
 * So the plan is per-aggregate: within a job, strictly in creation order, and
 * a blockage stops that job only. This is the single most consequential
 * decision in the module and it is the one worth re-reading if the queue ever
 * behaves surprisingly.
 *
 * ── DEPENDENCIES CROSS AGGREGATES; ORDERING DOES NOT ───────────────────────
 *
 * `depends_on_client_id` is explicit and is honoured wherever it points. TRD
 * §8.3: *"a completion record must never arrive before the evidence it
 * cites."* A photo upload depends on the job event it evidences, and that
 * dependency holds even if the two are in different aggregates.
 *
 * ── WHAT THIS MODULE IS NOT ────────────────────────────────────────────────
 *
 * It is a **planner**, not a driver. It takes rows and a clock and returns
 * what to send; it performs no I/O, owns no timers and holds no state. That is
 * what makes the ordering rules testable without a network, a device or a
 * simulator - `test/engine.test.ts` exercises every branch below in
 * milliseconds. The thing that actually sends is `client.ts`, and the thing
 * that schedules it is `src/app/` - neither of which was exercised in this
 * session.
 */

import type { OutboxRow } from "./outbox";
import { afterAccepted, afterConflict, afterDeferred, afterRefusal, afterRejected, markInflight } from "./outbox";
import type { MutationResponse } from "./protocol";

/** How many mutations go in one request. */
/**
 * 200 - `MAX_BATCH` in the mutations route, which refuses an oversized batch
 * outright rather than truncating it. Sending more would lose the whole
 * request and show the technician "sync failed" for a reason that is entirely
 * the app's fault.
 */
export const DRAIN_BATCH_LIMIT = 200;

export type BlockReason =
  | "waiting_for_backoff"
  | "dependency_not_synced"
  | "dependency_failed"
  | "behind_a_blocked_sibling"
  | "batch_full";

export interface BlockedRow {
  readonly clientId: string;
  readonly reason: BlockReason;
  /** For `FLD-17`'s office view: which row is holding this one up. */
  readonly blockedBy: string | null;
}

export interface DrainPlan {
  /** In send order. Dependencies precede dependents. */
  readonly batch: readonly OutboxRow[];
  readonly blocked: readonly BlockedRow[];
}

/**
 * Rows whose aggregate a blockage should not escape.
 *
 * A row with no `jobId` - an attendance event that belongs to the shift rather
 * than to a job - is its own aggregate of one. Grouping them all under a
 * shared "null" key would let one stuck clock-in block every subsequent one,
 * which is the head-of-line failure this design exists to avoid.
 */
function aggregateKey(row: OutboxRow): string {
  return row.jobId ?? `solo:${row.clientId}`;
}

export function planDrain(
  rows: readonly OutboxRow[],
  monotonicNow: number,
  limit: number = DRAIN_BATCH_LIMIT,
): DrainPlan {
  const byClientId = new Map(rows.map((r) => [r.clientId, r]));
  const batch: OutboxRow[] = [];
  const blocked: BlockedRow[] = [];
  const included = new Set<string>();

  // Group, then order within each group by the monotonic creation reading.
  // Sorting by `createdAt` would sort by a clock the technician is allowed to
  // change, which is precisely the ordering bug clock.ts exists to prevent.
  const groups = new Map<string, OutboxRow[]>();
  for (const row of rows) {
    if (row.status !== "pending") continue;
    const key = aggregateKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.createdMonotonic - b.createdMonotonic);
  }

  // Aggregates are considered in the order their oldest row was created, so a
  // long queue drains oldest-work-first rather than in map-iteration order.
  const orderedGroups = [...groups.values()].sort(
    (a, b) => (a[0]?.createdMonotonic ?? 0) - (b[0]?.createdMonotonic ?? 0),
  );

  for (const group of orderedGroups) {
    let groupBlocked = false;

    for (const row of group) {
      if (groupBlocked) {
        blocked.push({ clientId: row.clientId, reason: "behind_a_blocked_sibling", blockedBy: null });
        continue;
      }

      if (row.nextAttemptAfter > monotonicNow) {
        blocked.push({ clientId: row.clientId, reason: "waiting_for_backoff", blockedBy: null });
        groupBlocked = true;
        continue;
      }

      const dependency = row.dependsOnClientId;
      if (dependency !== null) {
        const parent = byClientId.get(dependency);

        // An unknown dependency is treated as satisfied. It means the parent
        // was accepted and its outbox row has already been pruned, which is
        // the normal end state - blocking on a row that no longer exists would
        // strand the child for ever.
        if (parent && parent.status !== "done") {
          if (parent.status === "dead" || parent.status === "conflicted") {
            blocked.push({ clientId: row.clientId, reason: "dependency_failed", blockedBy: dependency });
          } else if (!included.has(dependency)) {
            blocked.push({ clientId: row.clientId, reason: "dependency_not_synced", blockedBy: dependency });
          } else {
            // The parent is in this same batch, ahead of this row. Allowed:
            // the server applies a batch in the order it is given.
            pushRow(row);
            continue;
          }
          groupBlocked = true;
          continue;
        }
      }

      pushRow(row);
    }
  }

  function pushRow(row: OutboxRow): void {
    if (batch.length >= limit) {
      blocked.push({ clientId: row.clientId, reason: "batch_full", blockedBy: null });
      return;
    }
    batch.push(markInflight(row));
    included.add(row.clientId);
  }

  return { batch, blocked };
}

/**
 * Fold a mutation response back into the rows that were sent.
 *
 * The server returns **four** lists and each needs opposite handling - which is
 * why it returns four rather than the two TRD §8.5 shows:
 *
 *   `accepted`  applied, or already applied. Either way the device may forget
 *               it. Each entry carries its own `serverReceivedAt`, which is
 *               what ADR 0004 means by the server receipt time.
 *
 *               **Do not sort by it.** Every mutation in a request is applied
 *               in one transaction and Postgres `now()` is the transaction
 *               start time, so the value is identical for every row in a
 *               batch. It records when, not in what order. The ordering
 *               guarantee is the array order this module produced, which the
 *               server applies in sequence - and that is the only honest
 *               source for "which of these two happened first".
 *   `conflicts` a human has to decide. Surfaced, never retried.
 *   `rejected`  will never succeed **as sent**. Two sub-cases, and conflating
 *               them is the mistake this branch exists to avoid: a rejection
 *               carrying `gaps` is the `JOB-15` gate, which the technician can
 *               fix, so it goes to `refused` with the gaps attached and the job
 *               card reopens on them. Everything else is `dead`.
 *   `deferred`  its dependency has not landed. Retried, **without** charging an
 *               attempt, because it is not a failure.
 *
 * Rows in none of the four are **left `inflight`**, not silently marked done
 * and not marked failed. A server that omits a clientId it was sent is a server
 * this client does not understand, and the startup recovery in
 * `recoverInflight` will re-send it - which is safe, because the clientId is
 * the idempotency key. Guessing either way would be more dangerous: guessing
 * "done" loses work.
 */
export function applyMutationResponse(
  sent: readonly OutboxRow[],
  response: MutationResponse,
  monotonicNow: number,
): { readonly rows: readonly OutboxRow[]; readonly unanswered: readonly string[] } {
  const accepted = new Map(response.accepted.map((a) => [a.clientId, a]));
  const conflicts = new Map(response.conflicts.map((c) => [c.clientId, c]));
  const rejected = new Map(response.rejected.map((r) => [r.clientId, r]));
  const deferred = new Map(response.deferred.map((d) => [d.clientId, d]));

  const rows = sent.map((row) => {
    const ok = accepted.get(row.clientId);
    // The server's own receipt time for this record, not the batch envelope's.
    // They are in fact the same instant - one transaction, one `now()` - but
    // reading the field means a future server that stamps them individually is
    // believed rather than overridden.
    if (ok) return afterAccepted(row, ok.serverReceivedAt);

    const conflict = conflicts.get(row.clientId);
    if (conflict) return afterConflict(row, conflict.detail);

    const reject = rejected.get(row.clientId);
    if (reject) {
      // `gaps` present means the completion gate refused it and named what is
      // outstanding. Absent means something else did, and there is nothing for
      // the technician to correct - see the note above.
      return reject.gaps && reject.gaps.length > 0
        ? afterRefusal(row, reject.message, reject.gaps)
        : afterRejected(row, reject.message);
    }

    const defer = deferred.get(row.clientId);
    if (defer) return afterDeferred(row, monotonicNow, defer.dependsOn);

    return row;
  });

  const unanswered = sent
    .filter(
      (row) =>
        !accepted.has(row.clientId) &&
        !conflicts.has(row.clientId) &&
        !rejected.has(row.clientId) &&
        !deferred.has(row.clientId),
    )
    .map((row) => row.clientId);

  return { rows, unanswered };
}
