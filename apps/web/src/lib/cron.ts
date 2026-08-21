import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { startRun, finishRun, type CronJob } from "@meridian/db/domain";

/**
 * The shared shape of every scheduled route.
 *
 * ADM-5. Three properties matter and each one is here rather than in the seven
 * route files, because seven copies of an authorisation check is six chances to
 * get it wrong:
 *
 *  1. **Secret-gated.** These routes drain queues, expire records and send
 *     mail. A public URL that does that is a denial-of-service and a spam
 *     cannon with one request.
 *  2. **Self-recording.** Every invocation opens and closes a `cron_runs` row,
 *     including one that throws, so `/api/cron/health` can tell "ran and found
 *     nothing" from "did not run".
 *  3. **Loud on failure.** A route that returns 200 while doing nothing is the
 *     exact failure mode this whole subsystem exists to prevent.
 */

/** Result of an authorisation check, so a caller cannot ignore a refusal. */
type Authorisation = { ok: true } | { ok: false; response: NextResponse };

function constantTimeEquals(a: string, b: string): boolean {
  // Buffer lengths must match before timingSafeEqual, and it throws when they
  // do not. Hashing both sides would hide the length; comparing lengths first
  // leaks only the length of a secret the caller already chose, which is not
  // useful to an attacker who does not know its contents.
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Check the caller is the scheduler.
 *
 * Accepts the secret as `Authorization: Bearer …` (the header Vercel Cron
 * sends) or as `x-cron-secret` for any other scheduler and for curl during a
 * deploy check.
 *
 * A missing `CRON_SECRET` refuses every request, in every environment. The
 * tempting alternative — open in development — is how an unauthenticated cron
 * endpoint reaches production: the guard is never exercised locally, so nobody
 * notices it was never configured. Generate one with `openssl rand -hex 32`.
 */
export function authoriseCron(request: Request): Authorisation {
  const expected = process.env["CRON_SECRET"];

  if (!expected) {
    console.error("[cron] CRON_SECRET is not set; refusing. Generate one with: openssl rand -hex 32");
    return {
      ok: false,
      response: NextResponse.json(
        { error: "Scheduled work is not configured." },
        { status: 503 },
      ),
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const alternate = request.headers.get("x-cron-secret") ?? "";
  const presented = bearer || alternate;

  if (!presented || !constantTimeEquals(presented, expected)) {
    // Deliberately not "wrong secret" — an unauthenticated caller learns
    // nothing about whether the route exists or what it wants.
    return { ok: false, response: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }

  return { ok: true };
}

export interface CronResult {
  /** Counted into `cron_runs.items_processed` and reported in the response. */
  readonly processed: number;
  /** Job-specific counts. Ends up in `cron_runs.detail`. */
  readonly detail?: Record<string, unknown>;
  /**
   * Set when the job completed but found something wrong. The run is still
   * recorded as `ok` — the job did its job — but the response carries the
   * problem so a scheduler with alerting can pick it up.
   */
  readonly warnings?: readonly string[];
}

/**
 * Run one scheduled job with the ledger and error handling around it.
 *
 * The `finally`-shaped structure matters: a route that throws must still close
 * its `cron_runs` row, otherwise health sees a run that started and never ended
 * and cannot distinguish it from a process that is still working.
 */
export async function runCron(
  job: CronJob,
  request: Request,
  work: () => Promise<CronResult>,
): Promise<NextResponse> {
  const auth = authoriseCron(request);
  if (!auth.ok) return auth.response;

  const startedAt = Date.now();
  const runId = await startRun(job);

  try {
    const result = await work();

    await finishRun(runId, {
      outcome: "ok",
      itemsProcessed: result.processed,
      detail: { ...result.detail, ms: Date.now() - startedAt, warnings: result.warnings ?? [] },
    });

    return NextResponse.json({
      job,
      ok: true,
      processed: result.processed,
      ms: Date.now() - startedAt,
      ...(result.detail ?? {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown failure";
    // Full context to the log, where an operator and an error monitor can see
    // it. The response body stays terse: the scheduler is not a user, but the
    // response is still reachable by anyone holding the secret.
    console.error(`[cron:${job}] failed`, error);

    await finishRun(runId, { outcome: "failed", error: message });

    return NextResponse.json({ job, ok: false, error: message }, { status: 500 });
  }
}
