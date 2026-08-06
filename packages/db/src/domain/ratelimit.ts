import { sql } from "drizzle-orm";
import { db } from "../index";

/**
 * Rate limiting for unauthenticated endpoints.
 *
 * The counter lives in Postgres rather than in the process, because every
 * serverless invocation is a fresh process: an in-memory counter resets on each
 * request and therefore limits nothing at all. See sql/public-functions.sql for
 * the function this calls and why the whole count-and-test is one statement.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /**
   * True when the limiter itself could not be consulted. The caller decides
   * what to do; this type exists so that "allowed because we checked" and
   * "allowed because we could not check" are not the same value.
   */
  readonly degraded: boolean;
}

/**
 * Count one hit against `bucket` and report whether it is still under `limit`.
 *
 * Fails **open**, and that is a considered choice rather than laziness. The
 * only realistic reason this throws is the database being unreachable - and
 * every caller's next step is a database write that will then fail anyway, so
 * refusing here would convert a database outage into a second, more confusing
 * failure without preventing a single unwanted row. The degraded flag is
 * returned so the caller can log it rather than discover it in a support
 * ticket.
 */
export async function checkRateLimit(input: {
  bucket: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitDecision> {
  // Bucket keys are composed from untrusted input (an IP header), so they are
  // length-capped here as well as in the column: an oversized key would throw
  // on insert and take the endpoint down with it.
  const bucket = input.bucket.slice(0, 200);

  try {
    const rows = (await db.execute<{ allowed: boolean }>(
      sql`select app_public_rate_limit(${bucket}, ${input.limit}, ${input.windowSeconds}) as allowed`,
    )) as unknown as { allowed: boolean }[];

    return { allowed: rows[0]?.allowed !== false, degraded: false };
  } catch (error) {
    console.error("[ratelimit] could not consult the limiter; allowing the request", error);
    return { allowed: true, degraded: true };
  }
}

/**
 * Delete buckets whose window ended long ago. Nothing else removes them, and
 * one row per distinct caller grows without limit otherwise.
 */
export async function sweepRateLimits(olderThanSeconds = 86_400): Promise<number> {
  const rows = (await db.execute<{ removed: number }>(
    sql`select app_public_rate_limit_sweep(${olderThanSeconds}) as removed`,
  )) as unknown as { removed: number }[];
  return Number(rows[0]?.removed ?? 0);
}
