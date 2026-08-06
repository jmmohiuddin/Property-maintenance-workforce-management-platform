/**
 * MFA integration test.
 *
 * Drives the real flow against a real, seeded Postgres: enrol, sign in with a
 * password and get a challenge rather than a session, verify a code, and check
 * every way the challenge is supposed to refuse. The claims that matter here
 * are the negative ones — a code cannot be replayed, a challenge cannot be
 * reused, guesses run out — and none of them can be checked without the
 * database, because the state they depend on lives there.
 *
 *   npm run test --workspace=@meridian/auth
 *
 * Requires the schema, rls.sql, auth-functions.sql, mfa-functions.sql and
 * `npm run db:seed`. Restores the account it borrows.
 */

import { eq, sql } from "drizzle-orm";
import { withTenant, schema, db, closeConnection } from "@meridian/db";
import { login } from "../src/login";
import { completeMfaChallenge, beginMfaChallenge } from "../src/mfa";
import { confirmEnrolment, disableMfa, getMfaStatus, startEnrolment } from "../src/enrolment";
import { codeForStep, stepAt } from "../src/totp";
import { resolveSession } from "../src/session";

const TENANT = "11111111-1111-4111-8111-111111111111";
const EMAIL = "yusuf@meridianfm.example";
const PASSWORD = "MeridianDev2026!";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/**
 * Resolve the user id the way the application does.
 *
 * A plain `select ... from users` returns nothing here, and that is RLS working
 * as designed: with no tenant GUC set there is no row to see. Going through
 * `app_auth_lookup` is the same path login takes.
 */
async function userId(): Promise<string> {
  const rows = (await db.execute<{ user_id: string }>(
    sql`select user_id from app_auth_lookup(${EMAIL})`,
  )) as unknown as { user_id: string }[];
  const id = rows[0]?.user_id;
  if (!id) throw new Error("Seed data missing. Run `npm run db:seed` first.");
  return id;
}

/**
 * Leave the borrowed account exactly as the seed made it.
 *
 * Run at both ends. Only running it at the end is not enough: a run that fails
 * part way leaves MFA enabled, and the next run then fails on its first
 * assertion for a reason that has nothing to do with the code being tested.
 */
async function restore(ctx: { tenantId: string; userId: string }): Promise<void> {
  await withTenant({ ...ctx, actorKind: "user" }, async (tx) => {
    await tx
      .update(schema.users)
      .set({ mfaSecret: null, mfaEnabledAt: null, mfaLastStep: null })
      .where(eq(schema.users.id, ctx.userId));
    await tx
      .delete(schema.userRecoveryCodes)
      .where(eq(schema.userRecoveryCodes.userId, ctx.userId));
    await tx.delete(schema.mfaChallenges).where(eq(schema.mfaChallenges.userId, ctx.userId));
  });
}

async function main(): Promise<void> {
  const uid = await userId();
  const ctx = { tenantId: TENANT, userId: uid };

  await restore(ctx);

  // ── Enrolment is two steps, and step one writes nothing ──────────────────
  const { secret, uri } = startEnrolment({ issuer: "Meridian", account: EMAIL });
  checkTrue("the enrolment URI carries the secret", uri.includes(secret));

  const untouched = await getMfaStatus(ctx);
  checkTrue("starting enrolment does not enable anything", !untouched.enabled);

  let wrongCodeRefused = false;
  try {
    await confirmEnrolment({ ...ctx, secret, code: "000000" });
  } catch {
    wrongCodeRefused = true;
  }
  checkTrue("confirming with a wrong code is refused", wrongCodeRefused);
  checkTrue("and still leaves the account alone", !(await getMfaStatus(ctx)).enabled);

  // ── Enrol for real ───────────────────────────────────────────────────────
  const { recoveryCodes } = await confirmEnrolment({
    ...ctx,
    secret,
    code: codeForStep(secret, stepAt()),
  });

  const enrolled = await getMfaStatus(ctx);
  checkTrue("a correct code enables it", enrolled.enabled);
  check("a full set of recovery codes is issued", recoveryCodes.length, 10);
  check("and they are all live", enrolled.recoveryCodesRemaining, 10);

  const stored = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ hash: schema.userRecoveryCodes.codeHash })
      .from(schema.userRecoveryCodes)
      .where(eq(schema.userRecoveryCodes.userId, uid));
    return rows.map((r) => r.hash);
  });
  checkTrue(
    "recovery codes are stored hashed, never in the clear",
    recoveryCodes.every((c) => !stored.includes(c)),
  );

  // ── Password alone no longer produces a session ──────────────────────────
  const first = await login({ email: EMAIL, password: PASSWORD });
  checkTrue("login now returns a challenge, not a session", !first.ok);
  if (first.ok) throw new Error("expected a challenge");
  check("and says why", first.reason, "mfa_required");
  if (first.reason !== "mfa_required") throw new Error("expected mfa_required");

  checkTrue("the challenge token is not a session token", (await resolveSession(first.challenge.token)) === null);

  // ── A wrong code does not let you in ─────────────────────────────────────
  const wrong = await completeMfaChallenge({ token: first.challenge.token, code: "000000" });
  checkTrue("a wrong code is refused", !wrong.ok);

  // ── The right code does ──────────────────────────────────────────────────
  // A step later than enrolment used. That is not test convenience: the code
  // that confirmed enrolment is recorded as spent, so replaying it seconds
  // later is refused — which is the guard working, and worth stating.
  const step = stepAt() + 1;
  const at = new Date(step * 30_000);

  const enrolmentCodeReplayed = await completeMfaChallenge({
    token: first.challenge.token,
    code: codeForStep(secret, stepAt()),
  });
  checkTrue(
    "the code that confirmed enrolment cannot be reused to sign in",
    !enrolmentCodeReplayed.ok,
  );

  const ok = await completeMfaChallenge({
    token: first.challenge.token,
    code: codeForStep(secret, step),
    at,
  });
  checkTrue("the right code completes the login", ok.ok);
  if (!ok.ok) throw new Error("expected a session");

  const session = await resolveSession(ok.session.token);
  checkTrue("and the session it hands back actually resolves", session !== null);
  check("to the right user", session?.user.email, EMAIL);

  // ── Single use, both ways ────────────────────────────────────────────────
  const replayChallenge = await completeMfaChallenge({
    token: first.challenge.token,
    code: codeForStep(secret, step),
    at,
  });
  checkTrue("the same challenge cannot be completed twice", !replayChallenge.ok);

  // A fresh challenge, same code: the replay guard must refuse it even though
  // the code is still within its 30-second window. This is the check that
  // stops a shoulder-surfed code being used a second time.
  const second = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  const replayCode = await completeMfaChallenge({
    token: second.token,
    code: codeForStep(secret, step),
    at,
  });
  checkTrue("a code cannot be replayed on a fresh challenge either", !replayCode.ok);

  // The next step's code works, so the guard blocks replay without blocking use.
  const advanced = await completeMfaChallenge({
    token: second.token,
    code: codeForStep(secret, step + 1),
    at: new Date((step + 1) * 30_000),
  });
  checkTrue("but the next code still works", advanced.ok);

  // ── Guessing runs out ────────────────────────────────────────────────────
  const guessable = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  let lastReason = "";
  for (let i = 0; i < 6; i++) {
    const attempt = await completeMfaChallenge({ token: guessable.token, code: "111111" });
    if (!attempt.ok) lastReason = attempt.reason;
  }
  check("guesses are capped", lastReason, "too_many_attempts");

  const afterCap = await completeMfaChallenge({
    token: guessable.token,
    code: codeForStep(secret, stepAt() + 5),
    at: new Date((stepAt() + 5) * 30_000),
  });
  checkTrue("and a correct code cannot revive a burnt challenge", !afterCap.ok);

  // ── An expired challenge is refused ──────────────────────────────────────
  const expiring = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  // Ageing the row has to go through a tenant-scoped connection: the own-row
  // policy on `mfa_challenges` means an UPDATE with no user GUC set matches
  // nothing at all. That the first attempt at this silently updated zero rows
  // is the policy working.
  await withTenant({ ...ctx, actorKind: "user" }, async (tx) => {
    await tx
      .update(schema.mfaChallenges)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.mfaChallenges.userId, uid));
  });
  const expired = await completeMfaChallenge({
    token: expiring.token,
    code: codeForStep(secret, stepAt() + 10),
    at: new Date((stepAt() + 10) * 30_000),
  });
  checkTrue("an expired challenge is refused", !expired.ok);
  if (!expired.ok) check("and says so", expired.reason, "expired");

  // ── A recovery code works, once ──────────────────────────────────────────
  const recoveryChallenge = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  const recovered = await completeMfaChallenge({
    token: recoveryChallenge.token,
    code: recoveryCodes[0]!,
  });
  checkTrue("a recovery code completes the login", recovered.ok);
  if (recovered.ok) {
    check("and reports how many are left", recovered.recoveryCodesRemaining, 9);
  }

  const reuse = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  const reused = await completeMfaChallenge({
    token: reuse.token,
    code: recoveryCodes[0]!,
  });
  checkTrue("the same recovery code cannot be used again", !reused.ok);

  // A lower-case, unspaced version of a live code still works: people retype
  // these off paper while already locked out.
  const messy = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  const messyResult = await completeMfaChallenge({
    token: messy.token,
    code: recoveryCodes[1]!.toLowerCase().replace("-", " "),
  });
  checkTrue("a retyped recovery code is tolerated", messyResult.ok);

  // ── Turning it off ───────────────────────────────────────────────────────
  let offRefused = false;
  try {
    await disableMfa({ ...ctx, code: "000000" });
  } catch {
    offRefused = true;
  }
  checkTrue("it cannot be turned off without a code", offRefused);
  checkTrue("so it is still on", (await getMfaStatus(ctx)).enabled);

  await withTenant(ctx, async (tx) => {
    // Move the guard back so a fresh code in the real window is accepted.
    await tx.update(schema.users).set({ mfaLastStep: null }).where(eq(schema.users.id, uid));
  });
  // Two live sessions: the one doing the disabling, and one somebody else
  // holds. Only the second should die.
  const mine = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  const mineDone = await completeMfaChallenge({
    token: mine.token,
    code: codeForStep(secret, stepAt() + 30),
    at: new Date((stepAt() + 30) * 30_000),
  });
  if (!mineDone.ok) throw new Error("expected a session for the disable step");
  const mineResolved = await resolveSession(mineDone.session.token);

  const theirs = await beginMfaChallenge({ userId: uid, tenantId: TENANT });
  const theirsDone = await completeMfaChallenge({
    token: theirs.token,
    code: codeForStep(secret, stepAt() + 31),
    at: new Date((stepAt() + 31) * 30_000),
  });
  if (!theirsDone.ok) throw new Error("expected a second session");

  await withTenant(ctx, async (tx) => {
    await tx.update(schema.users).set({ mfaLastStep: null }).where(eq(schema.users.id, uid));
  });
  await disableMfa({
    ...ctx,
    code: codeForStep(secret, stepAt()),
    currentSessionId: mineResolved?.sessionId,
  });

  checkTrue(
    "the session that turned it off survives",
    (await resolveSession(mineDone.session.token)) !== null,
  );
  checkTrue(
    "but every other session is revoked",
    (await resolveSession(theirsDone.session.token)) === null,
  );

  const off = await getMfaStatus(ctx);
  checkTrue("a correct code turns it off", !off.enabled);
  check("and the recovery codes go with it", off.recoveryCodesRemaining, 0);

  const plain = await login({ email: EMAIL, password: PASSWORD });
  checkTrue("password-only login works again once it is off", plain.ok);

  // ── Restore ──────────────────────────────────────────────────────────────
  await restore(ctx);
  await withTenant({ ...ctx, actorKind: "user" }, async (tx) => {
    await tx.delete(schema.sessions).where(eq(schema.sessions.userId, uid));
  });

  console.log(fail === 0 ? "\nmfa: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
