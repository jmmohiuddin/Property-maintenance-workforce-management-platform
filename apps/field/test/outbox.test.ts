import { check, equal, deepEqual, done } from "./_harness";
import {
  afterAccepted,
  afterConflict,
  afterProtocolFailure,
  afterTransportFailure,
  backoffMs,
  markInflight,
  queueHealth,
  recoverInflight,
  retryByHand,
  toOutboundMutation,
  afterDeferred,
  afterRefusal,
  afterRejected,
  kindOf,
  BACKOFF_CAP_MS,
  MAX_ATTEMPTS,
  type OutboxRow,
} from "../src/sync/outbox";

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    clientId: "01HQ0000000000000000000001",
    entity: "attendance",
    op: "append",
    jobId: "job-1",
    payload: { kind: "arrived" },
    baseVersion: null,
    dependsOnClientId: null,
    createdAt: "2026-08-21T09:00:00.000Z",
    createdMonotonic: 100,
    attemptCount: 0,
    nextAttemptAfter: 0,
    status: "pending",
    lastError: null,
    refusalGaps: null,
    serverReceivedAt: null,
    ...overrides,
  };
}

// ── Backoff ─────────────────────────────────────────────────────────────────

equal("full jitter can draw zero", backoffMs(3, () => 0), 0);
equal("the first attempt's ceiling is the base delay", backoffMs(1, () => 1), 2_000);
equal("the second doubles it", backoffMs(2, () => 1), 4_000);
equal("the third doubles again", backoffMs(3, () => 1), 8_000);
equal("the delay is capped", backoffMs(30, () => 1), BACKOFF_CAP_MS);
check("jitter draws below the ceiling", backoffMs(5, () => 0.5) < backoffMs(5, () => 1));

// ── Failure handling ────────────────────────────────────────────────────────

const failedOnce = afterTransportFailure(row(), 10_000, "no connection", () => 1);
equal("a transport failure returns the row to pending", failedOnce.status, "pending");
equal("and charges it one attempt", failedOnce.attemptCount, 1);
equal("and pushes the deadline out by the backoff", failedOnce.nextAttemptAfter, 12_000);

let exhausted = row();
for (let i = 0; i < MAX_ATTEMPTS; i++) {
  exhausted = afterTransportFailure(exhausted, 0, "no connection", () => 0);
}
equal("after the budget is spent the row is dead", exhausted.status, "dead");
equal("and it is dead at exactly the declared attempt count", exhausted.attemptCount, MAX_ATTEMPTS);

const unreadable = afterProtocolFailure(row(), 0, "unknown field");
equal("an unreadable response kills the row immediately", unreadable.status, "dead");
equal("without spending the whole retry budget first", unreadable.attemptCount, 1);

// ── Success and refusal ─────────────────────────────────────────────────────

const accepted = afterAccepted(row(), "2026-08-21T09:04:11.000Z");
equal("an accepted row is done", accepted.status, "done");
equal("and carries the server receipt time", accepted.serverReceivedAt, "2026-08-21T09:04:11.000Z");

const conflicted = afterConflict(row(), "The office cancelled this job.");
equal("a refused row is conflicted, not dead", conflicted.status, "conflicted");
equal("and keeps the message a person will read", conflicted.lastError, "The office cancelled this job.");

// ── Crash recovery ──────────────────────────────────────────────────────────

const midFlight = [markInflight(row()), row({ clientId: "b", status: "done" })];
const recovered = recoverInflight(midFlight, 5_000);
equal("a row left inflight by a crash goes back to pending", recovered[0]?.status, "pending");
equal("without being charged an attempt", recovered[0]?.attemptCount, 0);
equal("it is releasable immediately", recovered[0]?.nextAttemptAfter, 5_000);
equal("a done row is untouched", recovered[1]?.status, "done");

const retried = retryByHand(exhausted, 900);
equal("a hand retry resets the budget", retried.attemptCount, 0);
equal("and makes the row pending again", retried.status, "pending");

// ── FLD-17: the technician-facing summary ───────────────────────────────────

const health = queueHealth(
  [
    row({ clientId: "a", createdMonotonic: 10, createdAt: "2026-08-21T08:00:00.000Z" }),
    row({ clientId: "b", createdMonotonic: 20 }),
    row({ clientId: "c", status: "inflight" }),
    row({ clientId: "d", status: "dead" }),
    row({ clientId: "e", status: "conflicted" }),
    row({ clientId: "g", status: "refused" }),
    row({ clientId: "f", status: "done" }),
  ],
  "2026-08-21T14:02:00.000Z",
);
equal("waiting counts pending and inflight together", health.waiting, 3);
equal("dead is counted separately", health.dead, 1);
equal("so is a conflict the office must settle", health.conflicted, 1);
equal("and so is a job card the technician can finish", health.refused, 1);
equal("the oldest waiting item is identified", health.oldestWaitingAt, "2026-08-21T08:00:00.000Z");
equal(
  "the summary reads the way FLD-17 asks for, and names the three outcomes differently",
  health.summary,
  "3 items waiting · last synced 14:02 · 1 item needs attention · 1 with the office · 1 job card to finish",
);

// ── The three refusal states are three states on purpose ────────────────────

const refused = afterRefusal(row(), "This job card is not complete.", ["after_photo"]);
equal("a JOB-15 refusal is `refused`", refused.status, "refused");
deepEqual("carrying what is outstanding", refused.refusalGaps, ["after_photo"]);
check("it is not queued for another attempt", refused.status !== "pending");
check("and the write is kept rather than dropped", refused.clientId === row().clientId);

const officeConflict = afterConflict(row(), "The office cancelled this job.");
equal("a dispatcher conflict is a different state", officeConflict.status, "conflicted");
equal("and carries no gap list - there is nothing to correct", officeConflict.refusalGaps, null);

const empty = queueHealth([], null);
equal("a device that has never synced says so", empty.summary, "0 items waiting · never synced");

// ── The wire shape ──────────────────────────────────────────────────────────

const wire = toOutboundMutation(row({ dependsOnClientId: "parent" }));
equal("the client id is the idempotency key on the wire", wire.clientId, "01HQ0000000000000000000001");
equal("the device timestamp is sent as recordedOfflineAt", wire.recordedOfflineAt, "2026-08-21T09:00:00.000Z");
equal("the dependency travels with it", wire.dependsOnClientId, "parent");
// jobId is deliberately absent: the server derives it from the payload and
// scopes the write by the technician's own access. The device keeps it locally
// only because the drain planner groups by aggregate root.
check("the local jobId is not sent", !("jobId" in wire));
equal("the kind is the server's closed vocabulary", kindOf(row()), "attendance/append");

// ── The server's other two verdicts ─────────────────────────────────────────

const rejectedRow = afterRejected(row(), "That fault code was retired.");
equal("a rejected row is dead - retrying cannot help", rejectedRow.status, "dead");
equal("and shows the reason", rejectedRow.lastError, "That fault code was retired.");

const deferredRow = afterDeferred(row({ attemptCount: 3 }), 7_000, "01HQ-parent");
equal("a deferred row is pending again", deferredRow.status, "pending");
equal("without being charged an attempt - a deferral is not a failure", deferredRow.attemptCount, 3);
equal("and is releasable now", deferredRow.nextAttemptAfter, 7_000);
check("and names what it waits for", (deferredRow.lastError ?? "").includes("01HQ-parent"));

done("outbox");
