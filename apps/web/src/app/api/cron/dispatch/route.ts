import { withTenant } from "@meridian/db";
import { activeTenantIds } from "@meridian/db/domain";
import { dispatchPending, stuckNotifications, selectTransport } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * Drain the notification queue. Every 5 minutes.
 *
 * This route is the whole of `TD-4`. The queue, the ledger, the retry
 * classification and the stuck detection were all built and correct — and then
 * the only thing that ever called the dispatcher was two unrelated user
 * actions. A quote emailed at 21:40 sat in `queued` until somebody happened to
 * complete an unrelated job. Notifications that depend on a human doing
 * something else are not a notification system.
 *
 * `selectTransport()` picks the real provider when `RESEND_API_KEY` and
 * `NOTIFY_FROM` are set and the console transport otherwise. The console
 * transport reports success, which means an unconfigured deployment drains the
 * queue into a log and tells nobody — so the response says which transport ran,
 * and `warnings` says it out loud.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return runCron("dispatch", request, async () => {
    const transport = selectTransport();
    const tenants = await activeTenantIds();

    let attempted = 0;
    let sent = 0;
    let failed = 0;
    /** Gave up during *this* run. */
    let abandonedNow = 0;
    /** Sitting in the ledger having given up, from any run. */
    let abandonedTotal = 0;
    /** Claimed and never resolved — a dispatcher that died holding them. */
    let stranded = 0;

    for (const tenantId of tenants) {
      const summary = await dispatchPending(tenantId, { transport });
      attempted += summary.attempted;
      sent += summary.sent;
      failed += summary.failed;
      abandonedNow += summary.abandoned;

      // Asked after dispatching, so a row this run just gave up on is included.
      // The two counts answer different questions and are kept apart: one is
      // "what happened just now", the other is "what is waiting for a human".
      const stuck = await withTenant({ tenantId, actorKind: "system" }, (tx) => stuckNotifications(tx));
      abandonedTotal += stuck.abandoned;
      stranded += stuck.stranded;
    }

    const warnings: string[] = [];

    if (transport.name === "console") {
      // The single most expensive silent failure available in this system: the
      // ledger says "sent", the customer never hears from you, and nobody finds
      // out until they complain.
      warnings.push(
        "No email transport is configured (RESEND_API_KEY / NOTIFY_FROM unset). " +
          "Messages were written to the log and NOT delivered.",
      );
    }
    if (stranded > 0) {
      warnings.push(`${stranded} notification(s) stranded in 'sending' — a dispatcher died mid-flight.`);
    }
    if (abandonedTotal > 0) {
      warnings.push(
        `${abandonedTotal} notification(s) have exhausted their retries and need a human.`,
      );
    }

    return {
      processed: attempted,
      detail: {
        transport: transport.name,
        tenants: tenants.length,
        sent,
        failed,
        abandonedNow,
        abandonedTotal,
        stranded,
      },
      warnings,
    };
  });
}
