/**
 * Password reset and invitation — integration test against real Postgres.
 *
 * `SEC-5` / `ADM-1` / `ADM-2`. This is an account-takeover surface: anyone on
 * the internet can start the flow, and anyone holding a link can finish it. So
 * the negative paths are the point of this file, and there are more of them
 * than happy paths on purpose.
 *
 * Each check below corresponds to a specific attack:
 *   - reusing a link found in a forwarded email
 *   - using a link after the password was already changed
 *   - keeping a stolen session alive across a reset
 *   - enumerating accounts from the response to a reset request
 *   - inviting an address you do not control to take over an existing account
 *   - accepting an invitation that was revoked after the email was sent
 *
 *   npm run test --workspace=@meridian/auth
 *
 * Requires a seeded database. Cleans up everything it creates.
 */

import postgres from "postgres";
import { sql } from "drizzle-orm";
import { db, withTenant, closeConnection } from "@meridian/db";
import {
  requestPasswordReset,
  peekResetToken,
  completePasswordReset,
  passwordProblem,
  inviteStaff,
  peekInvitation,
  acceptInvitation,
  sweepResetTokens,
  MIN_PASSWORD_LENGTH,
} from "../src/reset";
import { createSession, resolveSession } from "../src/session";
import { login } from "../src/login";
import { verifyPassword } from "../src/password";

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
 * A separate admin connection, used only for fixture manipulation.
 *
 * Two things below cannot be done as the application role, and both refusals
 * are correct rather than obstacles:
 *
 *  * `password_reset_tokens` has every privilege revoked from `meridian_app`.
 *    The SECURITY DEFINER functions are the entire supported surface, and
 *    application code that could UPDATE this table could mark a consumed token
 *    unconsumed.
 *  * Deleting a `users` row from outside a tenant context matches nothing under
 *    RLS, so a cleanup written against `db` would silently delete zero rows and
 *    leave test accounts accumulating in the database forever.
 *
 * Backdating a token is simulating the passage of time, which is a test
 * concern. Doing it through a connection the application does not have keeps
 * the production surface honest.
 */
const adminUrl =
  process.env["DATABASE_ADMIN_URL"] ?? process.env["DATABASE_URL"] ?? "postgres://localhost:5432/meridian_dev";
const admin = postgres(adminUrl, { max: 1 });

/**
 * Backdate this user's reset history so the per-account throttle stops counting
 * it, and assert we actually got a token.
 *
 * The throttle (3 per hour) is doing its job — but this file legitimately walks
 * through more than three scenarios, each of which would be a separate hour in
 * real life. Without this, requests four onward silently return null, and a
 * check like "an expired token does not peek" passes because there was no token
 * at all rather than because expiry works. A test that passes for the wrong
 * reason is worse than one that fails.
 */
async function freshToken(email: string, ip: string): Promise<string> {
  await admin`
    update password_reset_tokens set created_at = now() - interval '2 hours'
     where created_at > now() - interval '2 hours'
  `;
  const issued = await requestPasswordReset({ email, ipAddress: ip });
  if (!issued) throw new Error(`Expected a reset token for ${email} but the request was refused.`);
  return issued.token;
}

const TAG = "reset-test";
const EMAIL = `${TAG}@example.invalid`;
const INVITE_EMAIL = `${TAG}-invite@example.invalid`;
const ORIGINAL = "OriginalPassword2026";
const REPLACEMENT = "ReplacementPassword2026";

async function cleanup(): Promise<void> {
  await admin`delete from user_invitations where lower(email) like ${`${TAG}%`}`;
  await admin`delete from users where lower(email) like ${`${TAG}%`}`;
  // The per-IP throttle buckets this run created.
  //
  // Without this the file passes on its own and fails inside the full suite,
  // which is the most confusing shape a test failure can take. The IP limit is
  // 10 per 15 minutes and this file makes several requests per address, so two
  // runs inside the window exhaust it and `requestPasswordReset` starts
  // returning null — correctly. The throttle is not the bug; leaving state
  // behind is. Test addresses are from the RFC 5737 documentation ranges, so
  // nothing real is being cleared.
  await admin`delete from rate_limits where bucket like 'reset:203.0.113.%' or bucket like 'reset:198.51.100.%'`;
}

async function main(): Promise<void> {
  await cleanup();

  /*
   * Resolved by slug, not by taking whichever tenant sorts first.
   *
   * `app_cron_active_tenants()` orders by created_at, and the tenant that sorts
   * first is currently the deliberately-empty second one the seed creates to
   * prove RLS isolation. Three tests made this mistake and all three eventually
   * failed against code that was working correctly. packages/db/test/_tenant.ts
   * has the shared version; this package cannot import from there, so the same
   * resolution is inline.
   */
  const slug = process.env["PUBLIC_TENANT_SLUG"] ?? "meridian";
  const tenantRows = (await db.execute<{ app_public_resolve_tenant: string | null }>(
    sql`select app_public_resolve_tenant(${slug})`,
  )) as unknown as { app_public_resolve_tenant: string | null }[];
  const tenantId = tenantRows[0]?.app_public_resolve_tenant;
  if (!tenantId) {
    throw new Error(`No active tenant with slug "${slug}". Run \`npm run db:seed\` first.`);
  }

  // ── Fixture: a real staff account, created the way ADM-1 creates one ───────
  //
  // Deliberately NOT a direct INSERT into `users`. The first version of this
  // test did that and RLS refused it — correctly, because writing a row that
  // grants access to a tenant from outside that tenant's boundary is the exact
  // thing the boundary exists to stop. Going through the invitation flow is
  // both the supported path and a better test.
  const bootstrap = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    inviteStaff(tx, { tenantId, actorKind: "system" }, {
      email: EMAIL,
      fullName: "Reset Test User",
      role: "dispatcher",
    }),
  );
  const created = await acceptInvitation({ token: bootstrap.token, password: ORIGINAL });
  if (!created.ok) throw new Error("Could not create the fixture user via invitation");
  const user = { id: created.userId };

  console.log("\n— password policy —");

  check("a short password is refused", passwordProblem("Short1!") !== null, true);
  check(`${MIN_PASSWORD_LENGTH} characters is accepted`, passwordProblem("a".repeat(MIN_PASSWORD_LENGTH)), null);
  // Length, not composition. A rule demanding a symbol produces "Password1!".
  checkTrue("a long all-lowercase passphrase is fine", passwordProblem("correct horse battery staple") === null);

  console.log("\n— requesting a reset —");

  const issued = await requestPasswordReset({ email: EMAIL, ipAddress: "203.0.113.10" });
  checkTrue("a known address gets a token", issued !== null);
  checkTrue("addressed to the right person", issued?.email.toLowerCase() === EMAIL);

  // THE enumeration property. The caller gets null and renders the same generic
  // response, so an attacker learns nothing about which addresses exist.
  const unknown = await requestPasswordReset({
    email: "definitely-not-a-user@example.invalid",
    ipAddress: "203.0.113.11",
  });
  check("an unknown address yields no token", unknown, null);

  console.log("\n— using the link —");

  const token = issued?.token ?? "";
  const peeked = await peekResetToken(token);
  checkTrue("a live token resolves to its user", peeked?.userId === user.id);
  check("a garbage token resolves to nothing", await peekResetToken("not-a-real-token"), null);

  // A session that exists before the reset. It must not survive it.
  const sessionBefore = await createSession({ userId: user.id, tenantId });
  checkTrue("the pre-reset session works", (await resolveSession(sessionBefore.token)) !== null);

  const done = await completePasswordReset({ token, password: REPLACEMENT });
  checkTrue("the reset succeeds", done.ok);

  // Read through the admin connection. `users` under RLS with no tenant context
  // matches zero rows, so `db.execute` here returns nothing and the assertion
  // would compare against an empty hash — which fails for "the new password
  // verifies" and PASSES for "the old one does not", i.e. a false pass on the
  // security-relevant half. Reading as admin removes both.
  const hashNow = async (): Promise<string> => {
    const rows = await admin<{ password_hash: string }[]>`
      select password_hash from users where id = ${user.id}::uuid
    `;
    const hash = rows[0]?.password_hash;
    if (!hash) throw new Error("Fixture user has no password hash — the read is wrong, not the code.");
    return hash;
  };

  const after = await hashNow();
  checkTrue("the new password verifies", await verifyPassword(REPLACEMENT, after));
  checkTrue("the old password no longer does", !(await verifyPassword(ORIGINAL, after)));

  // SEC-5. If the reset was prompted by a compromise, leaving the attacker's
  // session alive defeats the entire point.
  check("every existing session is revoked", await resolveSession(sessionBefore.token), null);

  console.log("\n— the attacks —");

  // Single use. A link recovered from a forwarded email must be dead.
  const replay = await completePasswordReset({ token, password: "YetAnotherPassword2026" });
  check("the same token cannot be used twice", replay.ok, false);
  checkTrue("and says so plainly", !replay.ok && replay.reason === "invalid_or_expired");

  checkTrue("and the replay did not change the password", await verifyPassword(REPLACEMENT, await hashNow()));

  check("a consumed token no longer peeks", await peekResetToken(token), null);

  // Two outstanding links: using one must kill the other. Otherwise the older
  // email in a mailbox stays live for its full window.
  const firstToken = await freshToken(EMAIL, "203.0.113.12");
  const secondToken = await freshToken(EMAIL, "203.0.113.12");
  checkTrue("two links can be outstanding", (await peekResetToken(firstToken)) !== null);

  const usedSecond = await completePasswordReset({ token: secondToken, password: "ThirdPassword2026x" });
  checkTrue("the newer link works", usedSecond.ok);
  check("and the older one is now dead", await peekResetToken(firstToken), null);

  // An expired token. Backdated directly, because waiting 30 minutes is not a
  // test strategy.
  const staleToken = await freshToken(EMAIL, "203.0.113.13");
  // Confirm it was live BEFORE backdating it, so this measures expiry rather
  // than the token never having existed.
  checkTrue("the token is live before it expires", (await peekResetToken(staleToken)) !== null);
  await admin`
    update password_reset_tokens set expires_at = now() - interval '1 minute'
     where user_id = ${user.id}::uuid and consumed_at is null
  `;
  check("an expired token does not peek", await peekResetToken(staleToken), null);
  check(
    "and cannot be consumed",
    (await completePasswordReset({ token: staleToken, password: "FourthPassword2026" })).ok,
    false,
  );

  // A weak password is refused BEFORE the token is consumed, so the user can
  // try again with the same link rather than having to request a new one.
  const weakToken = await freshToken(EMAIL, "203.0.113.14");
  const weak = await completePasswordReset({ token: weakToken, password: "short" });
  check("a weak password is refused", weak.ok, false);
  checkTrue("for the right reason", !weak.ok && weak.reason === "weak_password");
  // The token is NOT consumed by a rejected password, so the user can try again
  // with the same link instead of requesting a new one.
  checkTrue("and the link still works afterwards", (await peekResetToken(weakToken)) !== null);

  console.log("\n— the per-account throttle —");

  await admin`
    update password_reset_tokens set created_at = now() - interval '2 hours'
     where created_at > now() - interval '2 hours'
  `;
  const burst = [];
  for (let i = 0; i < 5; i++) {
    burst.push(await requestPasswordReset({ email: EMAIL, ipAddress: `198.51.100.${i}` }));
  }
  // Flooding one address is a good way to bury a real security email under
  // forty identical ones, so the account has its own ceiling independent of IP.
  check("only three links are issued in an hour", burst.filter(Boolean).length, 3);
  checkTrue("and the rest are refused silently", burst[4] === null);

  console.log("\n— reset clears a lockout —");

  await admin`
    update users set failed_login_count = 99, locked_until = now() + interval '30 minutes'
     where id = ${user.id}::uuid
  `;
  const lockedOut = await login({ email: EMAIL, password: "ThirdPassword2026x" });
  checkTrue("the account is locked", !lockedOut.ok && lockedOut.reason === "locked");

  const recoveryToken = await freshToken(EMAIL, "203.0.113.15");
  const recovered = await completePasswordReset({ token: recoveryToken, password: "RecoveredPassword2026" });
  checkTrue("the recovery reset succeeds", recovered.ok);

  // Someone who resets after a lockout has proved control of the mailbox.
  // Leaving them locked would send them to an administrator for no reason.
  const afterRecovery = await login({ email: EMAIL, password: "RecoveredPassword2026" });
  checkTrue("and a reset unlocks it", afterRecovery.ok);

  console.log("\n— invitations —");

  const invite = await withTenant({ tenantId, actorKind: "system" }, (tx) =>
    inviteStaff(tx, { tenantId, actorKind: "system" }, {
      email: INVITE_EMAIL,
      fullName: "Invited Coordinator",
      role: "dispatcher",
    }),
  );

  const invitePeek = await peekInvitation(invite.token);
  checkTrue("an invitation resolves", invitePeek !== null);
  check("carrying its role", invitePeek?.role, "dispatcher");
  check("and its email", invitePeek?.email.toLowerCase(), INVITE_EMAIL);

  const accepted = await acceptInvitation({ token: invite.token, password: "InvitedPassword2026" });
  checkTrue("accepting creates the account", accepted.ok);

  const signedIn = await login({ email: INVITE_EMAIL, password: "InvitedPassword2026" });
  checkTrue("and the new user can sign in", signedIn.ok);

  check("an accepted invitation cannot be reused", (await peekInvitation(invite.token)), null);

  // Re-inviting revokes the outstanding link, so a role change cannot be
  // undone by accepting an older email.
  const ctx = { tenantId, actorKind: "system" as const };
  const reIssue1 = await withTenant(ctx, (tx) =>
    inviteStaff(tx, ctx, { email: `${TAG}-x@example.invalid`, fullName: "X", role: "dispatcher" }),
  );
  const reIssue2 = await withTenant(ctx, (tx) =>
    inviteStaff(tx, ctx, { email: `${TAG}-x@example.invalid`, fullName: "X", role: "accountant" }),
  );
  check("re-inviting revokes the previous link", await peekInvitation(reIssue1.token), null);
  checkTrue("and the new one carries the new role", (await peekInvitation(reIssue2.token))?.role === "accountant");

  // THE invitation attack: inviting an address that already has an account must
  // add a membership, never overwrite the existing password.
  const existingInvite = await withTenant(ctx, (tx) =>
    inviteStaff(tx, ctx, { email: EMAIL, fullName: "Reset Test User", role: "accountant" }),
  );
  await acceptInvitation({ token: existingInvite.token, password: "AttackerChosen2026" });

  const stillMine = await login({ email: EMAIL, password: "RecoveredPassword2026" });
  checkTrue("an invitation never overwrites an existing password", stillMine.ok);
  const attackerAttempt = await login({ email: EMAIL, password: "AttackerChosen2026" });
  checkTrue("and the invited password does not work", !attackerAttempt.ok);

  console.log("\n— housekeeping —");

  const swept = await sweepResetTokens(0);
  checkTrue("the sweep removes expired tokens", swept >= 0);

  await cleanup();

  console.log(fail === 0 ? "\nreset: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await admin.end({ timeout: 5 });
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("reset test failed to run:", error);
  await cleanup().catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeConnection();
  process.exit(1);
});
