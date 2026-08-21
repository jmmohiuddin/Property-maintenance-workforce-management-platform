import { withTenant } from "@meridian/db";
import { activeTenantIds, sweepRateLimits, sweepExpiredSessions, expireStaleQuotes } from "@meridian/db/domain";
import { sweepResetTokens } from "@meridian/auth";
import { runCron } from "@/lib/cron";

/**
 * Housekeeping. Hourly.
 *
 * Three jobs that each grow a problem quietly rather than failing loudly:
 *
 *  * **Rate-limit buckets.** One row per distinct caller, and nothing ever
 *    removed them. The sweep function was written during the original build and
 *    then never called by anything, which is the pattern this whole route file
 *    exists to fix.
 *  * **Expired sessions.** Already unusable — `app_auth_resolve_session`
 *    refuses them — so this is table hygiene rather than security.
 *  * **Stale quotes** (QTE-2). The `expired` status existed but nothing enforced
 *    it, so a quote could be approved months after its validity date at a price
 *    that no longer covered the work.
 *  * **Spent password-reset tokens** (SEC-5). Already unusable, so hygiene
 *    rather than security — but an unbounded table of hashed tokens is still an
 *    unbounded table.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return runCron("sweep", request, async () => {
    const rateLimits = await sweepRateLimits();
    const sessions = await sweepExpiredSessions();
    // Consumed and long-expired reset tokens. Already unusable — the SQL
    // function refuses them — so this is table hygiene, like the sessions above.
    const resetTokens = await sweepResetTokens();

    let quotes = 0;
    const tenants = await activeTenantIds();
    for (const tenantId of tenants) {
      quotes += await withTenant({ tenantId, actorKind: "system" }, (tx) => expireStaleQuotes(tx));
    }

    return {
      processed: rateLimits + sessions + quotes + resetTokens,
      detail: { rateLimits, sessions, resetTokens, quotesExpired: quotes, tenants: tenants.length },
    };
  });
}
