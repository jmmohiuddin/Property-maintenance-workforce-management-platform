/**
 * Rate limiter integration test.
 *
 * Runs against real Postgres, because every claim worth making about a limiter
 * depends on state the database holds: that a window resets, that concurrent
 * callers cannot both slip under the same last slot, and that the application
 * role cannot reach the counter it is being limited by.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, rls.sql and public-functions.sql.
 */

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db, closeConnection, checkRateLimit, sweepRateLimits } from "../src/index";

/**
 * Fixtures and inspection go through an admin connection, because the
 * application role deliberately cannot read or write this table - that is one
 * of the properties under test. The limiter calls themselves still go through
 * the application role, which is how production reaches it.
 */
const admin = postgres(
  process.env["DATABASE_ADMIN_URL"] ??
    process.env["DATABASE_URL"] ??
    "postgres://localhost:5432/meridian_dev",
  { max: 2 },
);

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/** Namespaced so a run cannot collide with real buckets or a previous run. */
const KEY = `__test:${process.pid}:${Math.floor(Math.random() * 1e9)}`;

async function clear(prefix: string): Promise<void> {
  await admin`delete from rate_limits where bucket like ${prefix + "%"}`;
}

async function hits(bucket: string): Promise<number> {
  const rows = await admin<{ hits: number }[]>`select hits from rate_limits where bucket = ${bucket}`;
  return Number(rows[0]?.hits ?? 0);
}

async function main(): Promise<void> {
  await clear("__test:");

  // ── The limit actually limits ────────────────────────────────────────────
  const bucket = `${KEY}:basic`;
  const results: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    results.push((await checkRateLimit({ bucket, limit: 3, windowSeconds: 60 })).allowed);
  }
  check("the first three are allowed", results.slice(0, 3).join(), "true,true,true");
  check("the fourth and fifth are not", results.slice(3).join(), "false,false");
  check("and every attempt was counted, including the refused ones", await hits(bucket), 5);

  // A refused caller does not get a fresh allowance by waiting inside the same
  // window - the counter keeps climbing rather than decaying.
  const stillBlocked = await checkRateLimit({ bucket, limit: 3, windowSeconds: 60 });
  checkTrue("still refused later in the same window", !stillBlocked.allowed);

  // ── Buckets are independent ──────────────────────────────────────────────
  const other = `${KEY}:other`;
  const otherFirst = await checkRateLimit({ bucket: other, limit: 3, windowSeconds: 60 });
  checkTrue("a different caller is unaffected by someone else's limit", otherFirst.allowed);

  // ── The window resets ────────────────────────────────────────────────────
  // Age the row rather than sleeping: a test that waits out a real window is a
  // test nobody runs.
  const expiring = `${KEY}:window`;
  await checkRateLimit({ bucket: expiring, limit: 1, windowSeconds: 60 });
  const blocked = await checkRateLimit({ bucket: expiring, limit: 1, windowSeconds: 60 });
  checkTrue("second call inside the window is refused", !blocked.allowed);

  await admin`update rate_limits set window_start = now() - interval '2 hours' where bucket = ${expiring}`;
  const afterWindow = await checkRateLimit({ bucket: expiring, limit: 1, windowSeconds: 60 });
  checkTrue("but allowed again once the window has passed", afterWindow.allowed);
  check("and the count restarts rather than resuming", await hits(expiring), 1);

  // ── Concurrency: the race a read-then-write limiter loses ────────────────
  // Ten simultaneous callers against a limit of 4. A limiter that reads, then
  // decides, then writes lets more than four through here. Counting and testing
  // in one statement is what makes this hold.
  const raced = `${KEY}:race`;
  const verdicts = await Promise.all(
    Array.from({ length: 10 }, () =>
      checkRateLimit({ bucket: raced, limit: 4, windowSeconds: 60 }).then((r) => r.allowed),
    ),
  );
  check("exactly four of ten concurrent callers pass", verdicts.filter(Boolean).length, 4);
  check("and all ten were counted", await hits(raced), 10);

  // ── The limited party cannot reach the counter ───────────────────────────
  // A limiter that the limited party can read or reset is theatre. The
  // application role reaches this table only through the definer function.
  let readRefused = false;
  try {
    await db.execute(sql`select count(*) from rate_limits`);
  } catch {
    readRefused = true;
  }
  checkTrue("the application role cannot read rate_limits directly", readRefused);

  let writeRefused = false;
  try {
    await db.execute(sql`delete from rate_limits where bucket = ${raced}`);
  } catch {
    writeRefused = true;
  }
  checkTrue("nor delete its own bucket to reset the count", writeRefused);
  check("and the count is untouched by the attempt", await hits(raced), 10);

  // ── Bad arguments are refused, not silently allowed ──────────────────────
  let rejected = false;
  try {
    await db.execute(sql`select app_public_rate_limit('', 3, 60)`);
  } catch {
    rejected = true;
  }
  checkTrue("an empty bucket key is an error, not a free pass", rejected);

  // ── Housekeeping ─────────────────────────────────────────────────────────
  await admin`update rate_limits set window_start = now() - interval '3 days' where bucket like ${KEY + "%"}`;
  const removed = await sweepRateLimits(86_400);
  checkTrue("the sweep removes stale buckets", removed >= 1);
  check("and leaves none of this run behind", await hits(raced), 0);

  await clear("__test:");

  console.log(fail === 0 ? "\nratelimit: all checks passed" : `\n${fail} check(s) failed`);
  await admin.end({ timeout: 5 });
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeConnection();
  process.exit(1);
});
