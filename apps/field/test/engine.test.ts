import { check, equal, deepEqual, done } from "./_harness";
import { applyMutationResponse, planDrain } from "../src/sync/engine";
import type { OutboxRow } from "../src/sync/outbox";
import type { MutationResponse } from "../src/sync/protocol";

function row(overrides: Partial<OutboxRow> & { clientId: string }): OutboxRow {
  return {
    entity: "attendance",
    op: "append",
    jobId: "job-1",
    payload: {},
    baseVersion: null,
    dependsOnClientId: null,
    createdAt: "2026-08-21T09:00:00.000Z",
    createdMonotonic: 0,
    attemptCount: 0,
    nextAttemptAfter: 0,
    status: "pending",
    lastError: null,
    refusalGaps: null,
    serverReceivedAt: null,
    ...overrides,
  };
}

const ids = (rows: readonly OutboxRow[]) => rows.map((r) => r.clientId);

// ── FIFO within an aggregate ────────────────────────────────────────────────

const withinJob = planDrain(
  [
    row({ clientId: "third", createdMonotonic: 300 }),
    row({ clientId: "first", createdMonotonic: 100 }),
    row({ clientId: "second", createdMonotonic: 200 }),
  ],
  1_000,
);
deepEqual("one job's mutations send in creation order", ids(withinJob.batch), ["first", "second", "third"]);

// Ordering keys off the monotonic reading, not the wall clock a technician can change.
const clockChanged = planDrain(
  [
    row({ clientId: "earlier", createdMonotonic: 100, createdAt: "2026-08-21T17:00:00.000Z" }),
    row({ clientId: "later", createdMonotonic: 200, createdAt: "2026-08-21T09:00:00.000Z" }),
  ],
  1_000,
);
deepEqual(
  "a clock changed mid-shift does not reorder the queue",
  ids(clockChanged.batch),
  ["earlier", "later"],
);

// ── One stuck job must not freeze the others ────────────────────────────────

const twoJobs = planDrain(
  [
    row({ clientId: "a1", jobId: "job-1", createdMonotonic: 100, nextAttemptAfter: 99_999 }),
    row({ clientId: "a2", jobId: "job-1", createdMonotonic: 200 }),
    row({ clientId: "b1", jobId: "job-2", createdMonotonic: 300 }),
  ],
  1_000,
);
deepEqual("a backed-off job does not block a different job", ids(twoJobs.batch), ["b1"]);
equal(
  "the blocked head reports why",
  twoJobs.blocked.find((b) => b.clientId === "a1")?.reason,
  "waiting_for_backoff",
);
equal(
  "and its sibling reports that it is behind it",
  twoJobs.blocked.find((b) => b.clientId === "a2")?.reason,
  "behind_a_blocked_sibling",
);

// Rows with no job are each their own aggregate, so one cannot block the next.
const soloRows = planDrain(
  [
    row({ clientId: "s1", jobId: null, createdMonotonic: 100, nextAttemptAfter: 99_999 }),
    row({ clientId: "s2", jobId: null, createdMonotonic: 200 }),
  ],
  1_000,
);
deepEqual("a stuck job-less event does not block another", ids(soloRows.batch), ["s2"]);

// ── Dependencies (TRD §8.3) ─────────────────────────────────────────────────

const photoBeforeParent = planDrain(
  [
    row({ clientId: "photo", entity: "job_attachment", op: "append", createdMonotonic: 100, dependsOnClientId: "event" }),
    row({ clientId: "event", createdMonotonic: 200 }),
  ],
  1_000,
);
check(
  "a photo is not sent before the event it evidences, even though it is older",
  !ids(photoBeforeParent.batch).includes("photo"),
);
equal(
  "the reason names the dependency",
  photoBeforeParent.blocked.find((b) => b.clientId === "photo")?.blockedBy,
  "event",
);

const parentThenChild = planDrain(
  [
    row({ clientId: "event", createdMonotonic: 100 }),
    row({ clientId: "photo", entity: "job_attachment", op: "append", createdMonotonic: 200, dependsOnClientId: "event" }),
  ],
  1_000,
);
deepEqual(
  "a dependency and its dependent travel in one batch, in order",
  ids(parentThenChild.batch),
  ["event", "photo"],
);

const deadParent = planDrain(
  [
    row({ clientId: "event", createdMonotonic: 100, status: "dead" }),
    row({ clientId: "photo", entity: "job_attachment", op: "append", createdMonotonic: 200, dependsOnClientId: "event" }),
  ],
  1_000,
);
equal("a dependent of a dead row is blocked, not orphaned", deadParent.batch.length, 0);
equal(
  "and says the dependency failed",
  deadParent.blocked.find((b) => b.clientId === "photo")?.reason,
  "dependency_failed",
);

const prunedParent = planDrain(
  [row({ clientId: "photo", entity: "job_attachment", op: "append", dependsOnClientId: "long-gone" })],
  1_000,
);
deepEqual(
  "a dependency whose outbox row was pruned counts as satisfied",
  ids(prunedParent.batch),
  ["photo"],
);

// ── Batch limit ─────────────────────────────────────────────────────────────

const many = planDrain(
  Array.from({ length: 5 }, (_, i) => row({ clientId: `r${i}`, jobId: `job-${i}`, createdMonotonic: i })),
  1_000,
  3,
);
equal("the batch respects its limit", many.batch.length, 3);
equal("the overflow is reported rather than dropped", many.blocked.filter((b) => b.reason === "batch_full").length, 2);

// Everything planned is marked inflight, so a crash mid-send is recoverable.
check("planned rows are marked inflight", many.batch.every((r) => r.status === "inflight"));

// ── Folding the four result lists back ──────────────────────────────────────

const sent = ["a", "b", "c", "d", "e"].map((clientId) => ({
  ...row({ clientId }),
  status: "inflight" as const,
}));

const response: MutationResponse = {
  accepted: [{ clientId: "a", serverReceivedAt: "2026-08-21T09:10:01.000Z", serverId: "server-1", result: {} }],
  conflicts: [
    {
      clientId: "b",
      reason: "job_ended_in_office",
      serverState: { status: "cancelled" },
      detail: "The office cancelled it.",
    },
  ],
  rejected: [{ clientId: "c", message: "That fault code was retired." }],
  deferred: [{ clientId: "d", dependsOn: "some-earlier-row" }],
  serverTime: "2026-08-21T09:10:01.000Z",
  clockSkewMs: 420,
};

const folded = applyMutationResponse(sent, response, 5_000);

equal("an accepted row becomes done", folded.rows[0]?.status, "done");
equal(
  "and takes the receipt time from its own accepted entry",
  folded.rows[0]?.serverReceivedAt,
  "2026-08-21T09:10:01.000Z",
);

equal("a conflicted row becomes conflicted, not dead", folded.rows[1]?.status, "conflicted");
equal("carrying the server's own sentence", folded.rows[1]?.lastError, "The office cancelled it.");

equal("a rejected row with no gaps becomes dead - nothing to correct", folded.rows[2]?.status, "dead");
equal("with the reason a person can read", folded.rows[2]?.lastError, "That fault code was retired.");
equal("and no gap list, because absent is not empty", folded.rows[2]?.refusalGaps, null);

equal("a deferred row goes back to pending", folded.rows[3]?.status, "pending");
equal("without being charged an attempt", folded.rows[3]?.attemptCount, 0);
check(
  "and says what it is waiting for",
  (folded.rows[3]?.lastError ?? "").includes("some-earlier-row"),
);

equal("a row in none of the four lists stays inflight rather than being guessed at", folded.rows[4]?.status, "inflight");
deepEqual("and is reported as unanswered", folded.unanswered, ["e"]);

// Rejected and deferred must not be confused: one is permanent, one is not.
check(
  "rejected is terminal and deferred is not",
  folded.rows[2]?.status === "dead" && folded.rows[3]?.status === "pending",
);

// ── A JOB-15 refusal is a rejection the technician CAN fix ──────────────────
//
// The server puts it in `rejected` with `gaps` attached. Treating it like any
// other rejection would bury a two-minute fix in a dead-letter list.

const gated = applyMutationResponse(
  [{ ...row({ clientId: "card", entity: "job_outcome", op: "record" }), status: "inflight" as const }],
  {
    accepted: [],
    conflicts: [],
    rejected: [
      {
        clientId: "card",
        message: "This job card is not complete.",
        gaps: ["after_photo", "labour"],
      },
    ],
    deferred: [],
    serverTime: "2026-08-21T09:10:01.000Z",
    clockSkewMs: null,
  },
  5_000,
);

equal("a refused completion is `refused`, not `dead`", gated.rows[0]?.status, "refused");
deepEqual("and carries the outstanding conditions", gated.rows[0]?.refusalGaps, ["after_photo", "labour"]);
check(
  "the queued write is kept, so the technician can correct it",
  gated.rows[0]?.clientId === "card",
);
check("and it is not queued for another attempt", gated.rows[0]?.status !== "pending");
deepEqual("nothing is left unanswered", gated.unanswered, []);

done("engine");
