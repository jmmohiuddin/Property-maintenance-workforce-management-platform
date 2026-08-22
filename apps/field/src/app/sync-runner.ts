/**
 * The sync runner: the loop that ties the pure planner to the database and the
 * network.
 *
 * **NOT TYPECHECKED BY THE ROOT GATE, AND NOT EXECUTED IN THIS SESSION.**
 * Everything it decides was moved into `engine.ts`, `outbox.ts`,
 * `conflicts.ts` and `download.ts`, which are both typechecked and
 * unit-tested. What is left here - the ordering of the database calls, the
 * error funnel, the scheduling - is untested and unrun.
 *
 * ── BOTH HALVES ARE HERE NOW ───────────────────────────────────────────────
 *
 * `drain()` sends the outbox; `pull()` fetches the working set and writes it.
 * They share the `isRunning` guard, so they take turns rather than racing: a
 * pull that landed a job's server state while a drain was folding a response
 * onto the same row would give two writers to one record, and the one that
 * wrote second would win for no reason anybody chose.
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

import { applySyncPlan, loadOutbox, persistOutbox, readDeviceHoldings, readPullCursor } from "../db/watermelon";
import { applyMutationResponse, planDrain } from "../sync/engine";
import { afterProtocolFailure, afterTransportFailure, kindOf, queueHealth, recoverInflight } from "../sync/outbox";
import type { OutboxRow } from "../sync/outbox";
import { toOutboundMutation } from "../sync/outbox";
import { DeviceAuthError, NetworkError, RefusedError, ServerError, type FieldApiClient } from "../sync/client";
import { ProtocolError, type SyncResponse } from "../sync/protocol";
import { SyncApplyError, planSyncApply, type SyncPlan } from "../sync/download";
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

  /**
   * One pull pass: fetch the delta, write it, advance the cursor.
   *
   * Loops while the server says `truncated`, because a truncated page means the
   * pull hit its cap and the rest of the working set is one request away -
   * making the device wait for its next scheduled sync to see the job it is
   * standing outside would be the app choosing to be wrong for fifteen minutes.
   * The loop is bounded rather than trusting `truncated` to stop: a server that
   * never clears the flag would otherwise spin a phone's radio flat, and a cap
   * turns that into a slow sync instead of a dead battery.
   *
   * `SyncApplyError` is recorded and not retried, for the same reason
   * `ProtocolError` is not: it is deterministic, so a retry loop would look
   * busy for a week and achieve nothing (`FLD-17`).
   */
  async pull(maxPages = 20): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      for (let page = 0; page < maxPages; page += 1) {
        const cursor = await readPullCursor(this.database);
        const result = await this.api.pull(cursor);
        this.signedIn();
        this.skew = result.skew;

        const holdings = await readDeviceHoldings(this.database);
        const plan = planSyncApply(result.data, holdings);
        await applySyncPlan(this.database, plan);

        // Only after the batch committed. `lastSyncedAt` is the server's own
        // clock, not this phone's, which is the whole two-clock discipline.
        this.lastSyncedAt = plan.serverTime;

        for (const anomaly of plan.anomalies) console.warn(`[field] ${anomaly}`);
        for (const jobId of plan.retainedForUnsyncedWork) {
          // Not an error. The office no longer considers this job the
          // technician's, and the phone is keeping it until their work reaches
          // the office - which is the correct order of those two facts.
          console.warn(`[field] job ${jobId} left the working set but still has queued work; kept`);
        }

        if (!plan.truncated) break;
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = messageFor(error);
      if (error instanceof DeviceAuthError) this.needsSignIn = true;
      if (error instanceof SyncApplyError || error instanceof ProtocolError) {
        console.error("[field] the office sent a sync response this build could not store", error);
      }
    } finally {
      this.isRunning = false;
      this.emit(await loadOutbox(this.database));
    }
  }

  private async sendBatch(batch: readonly OutboxRow[]): Promise<OutboxRow[]> {
    const now = this.clock.monotonic();
    try {
      const result = await this.api.push(newClientId(), batch.map(toOutboundMutation));
      this.signedIn();
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

  /**
   * A device-authenticated request came back. The device is signed in.
   *
   * ── WHY THIS IS CALLED AT THE RESPONSE AND NOT AT THE END OF THE PASS ──────
   *
   * `needsSignIn` used to latch: it was set on the first `DeviceAuthError` and
   * nothing ever cleared it, so a runner that had seen one 401 kept the
   * sign-in gate shut for the rest of the process - including while holding a
   * freshly registered token that worked. The screen said "sign in" and
   * signing in changed nothing, which is the worst shape a gate can take.
   *
   * The clearing condition has to be *proof*, not optimism, and a 200 from a
   * route behind `withDevice()` is exactly that: the server resolved this
   * handset's token and ran the handler. `pull()` and `push()` throw
   * `DeviceAuthError` on 401 and 403, so reaching the line after either of
   * them means the credential was accepted.
   *
   * It is therefore called at the response and not in `drain()`'s `finally`,
   * because a drain with an empty queue makes no request at all - clearing the
   * flag there would be the runner declaring itself signed in on the strength
   * of having done nothing.
   */
  private signedIn(): void {
    this.needsSignIn = false;
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
 * Apply one pull to the local database.
 *
 * Two steps and one transaction. `planSyncApply` is pure - it reads the parsed
 * response and the two facts about what the device already holds, decides every
 * column value and every removal, and refuses the whole pull if any of it is
 * unstorable. `applySyncPlan` then performs that plan in a single WatermelonDB
 * batch, cursor included, so a pull either becomes true in full or does not
 * happen at all.
 *
 * The ordering is not cosmetic: the holdings are read before the plan is built
 * and the removals are computed from them, so a job that acquired queued work
 * between the two would be at risk. Nothing can, because both live inside one
 * synchronous stretch of a single-threaded runtime with no user interaction in
 * between - but the guard in `planRemovals` is what makes it safe rather than
 * lucky, and it is the same guard `evictionDecision` applies.
 */
export async function applySyncResponse(
  database: Database,
  response: SyncResponse,
): Promise<SyncPlan> {
  const holdings = await readDeviceHoldings(database);
  const plan = planSyncApply(response, holdings);
  await applySyncPlan(database, plan);
  return plan;
}
