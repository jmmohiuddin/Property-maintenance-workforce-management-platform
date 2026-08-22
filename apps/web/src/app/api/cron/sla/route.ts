import { withTenant } from "@meridian/db";
import { activeTenantIds, findSlaBreaches, alertRecipients, recentlyNotified } from "@meridian/db/domain";
import { enqueue } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * SLA breach detection. Every 10 minutes.
 *
 * `JOB-5`. The deadlines were computed at job creation from the priority and
 * written to `respond_by_at` and `resolve_by_at`, the dispatch board sorted by
 * them, and then nothing ever looked at them again once the tab was closed. The
 * audit's phrase for it is the right one: *the clock exists; the alarm does
 * not.*
 *
 * Two design choices worth stating, both from §12.2 of the PRD:
 *
 *  * **One digest per sweep, not one email per job.** A ten-minute cron that
 *    emails per breach turns a bad morning into forty emails, and forty emails
 *    is a filter rule.
 *  * **Enqueued, not sent.** This route puts messages in the queue and stops.
 *    `/api/cron/dispatch` delivers them. Keeping detection and delivery apart
 *    means a provider outage delays the alert instead of losing the detection.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return runCron("sla", request, async () => {
    const tenants = await activeTenantIds();

    let breaches = 0;
    let notified = 0;
    let suppressed = 0;

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const found = await findSlaBreaches(tx);
        if (found.length === 0) return;

        breaches += found.length;

        const recipients = await alertRecipients(tx, ["owner", "operations_manager"]);
        if (recipients.length === 0) {
          // Worth its own log line. A breach nobody can be told about is a
          // detection that achieves nothing, and the cause is almost always a
          // deployment with no staff accounts rather than a code fault.
          console.warn(`[cron:sla] ${found.length} breach(es) in tenant ${tenantId} with no owner or operations manager to notify`);
          return;
        }

        for (const recipient of recipients) {
          // A job that breached at 09:00 is still breaching at 09:10. Without
          // this the same digest arrives six times an hour, and six identical
          // emails an hour is a filter rule — after which the alert reaches
          // nobody. The breach stays visible on the dispatch board throughout;
          // it is the *email* that is rate limited, not the detection.
          const alreadyTold = await recentlyNotified(tx, {
            template: "sla_breached",
            recipientUserId: recipient.userId,
            withinMinutes: 60,
          });
          if (alreadyTold) {
            suppressed += 1;
            continue;
          }

          const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
            channel: "email",
            template: "sla_breached",
            to: recipient.email,
            recipientUserId: recipient.userId,
            payload: {
              recipientName: recipient.fullName,
              breaches: found.map((b) => ({
                jobReference: b.reference,
                jobTitle: b.title,
                priority: b.priority,
                kind: b.kind,
                minutesOverdue: b.minutesOverdue,
              })),
            },
          });

          if (!("skipped" in result)) notified += 1;
        }
      });
    }

    return {
      processed: breaches,
      detail: { tenants: tenants.length, breaches, notified, suppressed },
      // Surfaced in the response as well as the queue, so a scheduler with its
      // own alerting sees the number without reading the database.
      warnings: breaches > 0 ? [`${breaches} job(s) past an SLA deadline.`] : [],
    };
  });
}
