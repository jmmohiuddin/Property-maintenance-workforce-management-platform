import { UserFacingError } from "@meridian/core";
import { applyFieldMutations, type FieldMutation } from "@meridian/db/domain";
import { withDevice, readJson, DEVICE_TIME_HEADER } from "../_device";

/**
 * `POST /api/field/v1/mutations` (TRD §8.3, §8.4, §8.5).
 *
 * The push half. A batch of outbox rows drained from the handset, each carrying
 * the id the device generated before the server had ever seen the record.
 *
 * ── THE HEADER, AND WHY THE BODY CARRIES THE KEYS ───────────────────────────
 *
 * §8.5 shows `Idempotency-Key: <client_id>`, which is the right header for a
 * request carrying **one** mutation. A day of queued work is not one mutation —
 * ADR 0004's whole point is that "sync is incremental, so a day of queued work
 * does not take minutes to upload" — and forty round trips over a hotel network
 * is exactly the failure that promise exists to avoid.
 *
 * So the batch is the unit, and every mutation carries its own `client_id` as
 * the idempotency key for its own effect. Deduplication is per mutation and
 * lives in `field_mutations`, so a batch that half-succeeded and was retried
 * applies only its remainder — which is stronger than request-level
 * idempotency, since that would have to choose between replaying everything and
 * replaying nothing.
 *
 * The header is therefore **advisory and unvalidated**. An earlier version of
 * this route refused a single-mutation request whose header did not match the
 * body's `client_id`, on the reasoning that a mismatch is a client bug. It is
 * not: the field client sends a *batch* id there, which is a perfectly
 * defensible reading of a spec written before either side agreed on batching,
 * and the check turned an ambiguity in the specification into a runtime failure
 * on every single-item drain. A header nobody has agreed the meaning of is not
 * something to enforce.
 *
 * ── FIELD NAMES ARE ACCEPTED IN BOTH SPELLINGS ──────────────────────────────
 *
 * Responses are camelCase, which is what `apps/field/src/sync/protocol.ts`
 * speaks and what its deviation list records against §8.5's snake_case — see
 * the sync route for why that divergence is documented rather than churned.
 * On the way *in*, both spellings are accepted. Tolerating a spelling costs
 * nothing and cannot be wrong; refusing one produces a 400 that a technician
 * sees as "sync failed", with no path to a fix from where they are standing.
 *
 * ── WHAT COMES BACK ─────────────────────────────────────────────────────────
 *
 * §8.5 names two lists. There are four, because the device has four different
 * things to do with an outbox row (see `applyFieldMutations`): forget it, wait
 * for a dispatcher, mark it dead and show somebody, or retry it once its
 * dependency lands. Collapsing `rejected` into `conflicts` would tell the
 * client to wait for a human who is never coming; collapsing it into `accepted`
 * would delete the technician's work.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One batch. Large enough for a full shift, small enough to be a fair request. */
const MAX_BATCH = 200;

/** Read a value under either the snake_case or the camelCase spelling. */
function pick(source: Record<string, unknown>, snake: string, camel: string): unknown {
  return source[snake] ?? source[camel];
}

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  // `base_version` arrives as a number from the field client and is stored as
  // text: it is an opaque token to this server, which only ever compares it,
  // so the representation is the client's business and not worth a 400.
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export async function POST(request: Request) {
  return withDevice(request, async ({ tx, ctx, device }) => {
    const body = await readJson(request);
    const raw = body["mutations"];

    if (!Array.isArray(raw)) {
      throw new UserFacingError("This sync did not contain anything to send.");
    }
    if (raw.length > MAX_BATCH) {
      throw new UserFacingError(
        `This phone tried to send ${raw.length} records at once. Send them ${MAX_BATCH} at a time.`,
      );
    }

    const mutations: FieldMutation[] = raw.map((entry) => {
      const m = (entry ?? {}) as Record<string, unknown>;
      const payload = { ...((pick(m, "payload", "payload") ?? {}) as Record<string, unknown>) };

      // The client puts the aggregate root beside the payload rather than
      // inside it — "so the server can order and scope it", which is the right
      // instinct. Folded in here so the handlers have one place to read it
      // from, and only when the payload does not already name one.
      const jobId = asString(pick(m, "job_id", "jobId"));
      if (jobId && !payload["jobId"]) payload["jobId"] = jobId;

      return {
        clientId: asString(pick(m, "client_id", "clientId")) ?? "",
        entity: String(m["entity"] ?? ""),
        op: String(m["op"] ?? ""),
        payload,
        baseVersion: asString(pick(m, "base_version", "baseVersion")),
        dependsOnClientId: asString(pick(m, "depends_on_client_id", "dependsOnClientId")),
        recordedOfflineAt: asString(pick(m, "recorded_offline_at", "recordedOfflineAt")),
      };
    });

    const result = await applyFieldMutations(tx, ctx, {
      deviceId: device.deviceId,
      technicianId: device.technicianId,
      mutations,
      // Header first, then the body. The field client measures its own skew
      // from the round trip and may send neither, in which case no correction
      // is applied and `clockSkewMs` stays null — an uncorrected timestamp
      // has to be identifiable as uncorrected.
      deviceTime:
        request.headers.get(DEVICE_TIME_HEADER) ??
        (typeof body["deviceTime"] === "string"
          ? body["deviceTime"]
          : typeof body["device_time"] === "string"
            ? body["device_time"]
            : null),
    });

    const receivedAt = result.serverTime.toISOString();

    return {
      accepted: result.accepted.map((a) => ({
        clientId: a.clientId,
        // ADR 0004: reports use the server time, so the device is told what the
        // server recorded rather than left believing its own clock.
        serverReceivedAt: receivedAt,
        // The server's id for the row, where the effect produced one. The
        // device needs it to link an upload to the record that cites it.
        serverId: typeof a.result["id"] === "string" ? a.result["id"] : undefined,
        result: a.result,
      })),
      conflicts: result.conflicts.map((c) => ({
        clientId: c.clientId,
        reason: c.reason,
        serverState: c.serverState,
        // Written by the server and shown verbatim when the client cannot
        // classify the reason. A conflict a phone cannot explain is a phone
        // that tells a technician nothing.
        detail: c.detail,
      })),
      rejected: result.rejected,
      deferred: result.deferred,
      serverTime: receivedAt,
      clockSkewMs: result.clockSkewMs,
    };
  });
}
