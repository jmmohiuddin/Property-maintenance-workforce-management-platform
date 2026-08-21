/**
 * The sync runner: the loop that ties the pure planner to the database and the
 * network.
 *
 * **NOT TYPECHECKED BY THE ROOT GATE, AND NOT EXECUTED IN THIS SESSION.**
 * Everything it decides was moved into `engine.ts`, `outbox.ts` and
 * `conflicts.ts`, which are both typechecked and unit-tested. What is left
 * here - the ordering of the database calls, the error funnel, the scheduling -
 * is untested and unrun.
 *
 * ── ONE RUNNER, NEVER TWO ──────────────────────────────────────────────────
 *
 * `isRunning` is not a nicety. Two concurrent drains would both load the same
 * pending rows, both mark them inflight, and both send them - which idempotency
 * makes harmless on the server and does not make harmless on the device, where
 * the second drain's response fold overwrites the first's. The guard is a
 * plain boolean because the runner is single-threaded JavaScript; there is no
 * lock to take.
 */

import type { Database } from "@nozbe/watermelondb";

import { loadOutbox, persistOutbox } from "../db/watermelon";
import { applyMutationResponse, planDrain } from "../sync/engine";
import { afterProtocolFailure, afterTransportFailure, kindOf, queueHealth, recoverInflight } from "../sync/outbox";
import type { OutboxRow } from "../sync/outbox";
import { toOutboundMutation } from "../sync/outbox";
import { DeviceAuthError, NetworkError, RefusedError, ServerError, type FieldApiClient } from "../sync/client";
import { ProtocolError } from "../sync/protocol";
import { classifyConflict } from "../sync/conflicts";
import type { ClockSources, SkewObservation } from "../domain/clock";
import { newClientId } from "../domain/ids";

export interface SyncStatus {
  readonly running: boolean;
  readonly lastSyncedAt: string | null;
  readonly lastError: string | null;
  readonly skew: SkewObservation | null;
  readonly summary: string;
  readonly needsSignIn: boolean;
  /** Job cards the office sent back, which the technician can finish. */
  readonly refused: number;
}

export class SyncRunner {
  private isRunning = false;
  private lastSyncedAt: string | null = null;
  private lastError: string | null = null;
  private skew: SkewObservation | null = null;
  private needsSignIn = false;
  private listeners = new Set<(status: SyncStatus) => void>();

  constructor(
    private readonly database: Database,
    private readonly api: FieldApiClient,
    private readonly clock: ClockSources,
  ) {}

  subscribe(listener: (status: SyncStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status([]));
    return () => this.listeners.delete(listener);
  }

  /**
   * Called once at startup, before anything else.
   *
   * Rows left `inflight` by a process the operating system killed go back to
   * `pending`. This is the recovery that makes "queued writes survive a kill"
   * true, and it is safe precisely because every mutation carries its client
   * id as an idempotency key.
   */
  async recover(): Promise<void> {
    const rows = await loadOutbox(this.database);
    await persistOutbox(this.database, recoverInflight(rows, this.clock.monotonic()));
    this.emit(await loadOutbox(this.database));
  }

  /**
   * One drain pass. Returns when there is nothing more it can send *now* -
   * either the queue is empty, or everything left is waiting on backoff, a
   * dependency, or a person.
   *
   * Loops rather than sending one batch, because a technician walking out of a
   * basement with 180 queued items should not need six taps to clear them.
   * The loop terminates because every pass either sends rows (which leave
   * `pending`) or plans an empty batch.
   */
  async drain(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      for (;;) {
        const rows = await loadOutbox(this.database);
        const plan = planDrain(rows, this.clock.monotonic());
        if (plan.batch.length === 0) break;

        await persistOutbox(this.database, plan.batch);
        const settled = await this.sendBatch(plan.batch);
        await persistOutbox(this.database, settled);

        // Nothing settled means the whole batch failed transport; stop rather
        // than spin. The backoff deadlines the failure handler set are what
        // release it later. `refused` and `conflicted` count as settled - they
        // are answers, and the rows stay put until a person acts on them.
        if (settled.every((row) => row.status === "pending" || row.status === "dead")) break;
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = messageFor(error);
      if (error instanceof DeviceAuthError) this.needsSignIn = true;
    } finally {
      this.isRunning = false;
      this.emit(await loadOutbox(this.database));
    }
  }

  private async sendBatch(batch: readonly OutboxRow[]): Promise<OutboxRow[]> {
    const now = this.clock.monotonic();
    try {
      const result = await this.api.push(newClientId(), batch.map(toOutboundMutation));
      this.skew = result.skew;
      this.lastSyncedAt = result.data.serverTime;

      const folded = applyMutationResponse(batch, result.data, now);

      // Classify every refusal so the screen has something to say. The verdict
      // is not acted on here - `conflicted` rows are surfaced, and the
      // technician or the office resolves them.
      // A refused completion is the one rejection the technician can act on.
      // The row is already `refused` with its gaps attached; this only logs it,
      // because the job card screen reads the gaps from the outbox row itself.
      for (const rejection of result.data.rejected) {
        if (rejection.gaps?.length) {
          console.warn(`[field] job card refused, outstanding: ${rejection.gaps.join(", ")}`);
        }
      }

      for (const conflict of result.data.conflicts) {
        const row = batch.find((r) => r.clientId === conflict.clientId);
        if (!row) continue;
        const verdict = classifyConflict({
          kind: kindOf(row),
          reason: conflict.reason,
          detail: conflict.detail,
        });
        console.warn(`[field] ${kindOf(row)} refused: ${verdict.action} - ${verdict.message}`);
      }

      return [...folded.rows];
    } catch (error) {
      if (error instanceof ProtocolError) {
        return batch.map((row) => afterProtocolFailure(row, now, error.message));
      }
      if (error instanceof DeviceAuthError) {
        // Not a per-row failure: the device is signed out and every row would
        // fail identically. Rows go back to pending with no attempt charged, so
        // a day's work is not consumed by an expired token.
        this.needsSignIn = true;
        return batch.map((row) => ({ ...row, status: "pending" as const, nextAttemptAfter: now }));
      }
      if (error instanceof RefusedError) {
        // The office refused the request itself - an oversized batch, or a body
        // it could not read. Retrying is pointless and the reason must be seen.
        return batch.map((row) => afterProtocolFailure(row, now, error.message));
      }
      if (error instanceof NetworkError || error instanceof ServerError) {
        return batch.map((row) => afterTransportFailure(row, now, messageFor(error)));
      }
      throw error;
    }
  }

  private status(rows: readonly OutboxRow[]): SyncStatus {
    const health = queueHealth(rows, this.lastSyncedAt);
    return {
      running: this.isRunning,
      lastSyncedAt: this.lastSyncedAt,
      lastError: this.lastError,
      skew: this.skew,
      summary: health.summary,
      needsSignIn: this.needsSignIn,
      refused: health.refused,
    };
  }

  private emit(rows: readonly OutboxRow[]): void {
    const status = this.status(rows);
    for (const listener of this.listeners) listener(status);
  }
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * **The pull half is not implemented.**
 *
 * `FieldApiClient.pull()` exists and parses a sync response; nothing applies
 * that response to the local database. Writing it requires knowing the exact
 * column names the server sends for jobs, customers, properties, assets, parts,
 * taxonomies and certifications - and `apps/web/src/app/api/field/**` did not
 * exist when this was written, so any mapping written here would be a guess
 * that compiles.
 *
 * A guess that compiles is worse than a gap that does not, so this is a gap
 * that does not. It is the first thing the next session should build, against
 * the real route handlers.
 */
export function applySyncResponse(): never {
  throw new Error(
    "The download half of sync is not implemented. The field API's response shape is not yet known; " +
      "see the note in sync-runner.ts.",
  );
}
