import { withTenant } from "@meridian/db";
import {
  cronHealth,
  strandedRuns,
  activeTenantIds,
  alertRecipients,
  recentlyNotified,
} from "@meridian/db/domain";
import { enqueue } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * The meta-check. Every 5 minutes.
 *
 * This is the route that makes the other four trustworthy. Every check in this
 * system now depends on a scheduler firing — SLA alerts, expiry warnings, the
 * notification drain — and a scheduler that stops is invisible by construction:
 * nothing runs, so nothing complains. The absence of an alert looks exactly
 * like everything being fine.
 *
 * So the schedule is monitored by the same mechanism as everything else. Each
 * job records its runs in `cron_runs`; this route reads that table, compares
 * each job's last completed run against its allowance, and raises an alert on
 * anything overdue.
 *
 * It also reports its own health, deliberately. If this route stops, the
 * external uptime monitor on this URL (`KPI-4`) is the last line — which is why
 * it returns a non-200 when something is wrong rather than a cheerful 200 with
 * a problem buried in the body. An uptime monitor reads the status code.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  return runCron("health", request, async () => {
    const jobs = await cronHealth();
    const stranded = await strandedRuns();

    // `health` is excluded from its own overdue check: this run is what would
    // clear it, and it has not been recorded yet. Reporting itself as overdue
    // on every invocation would be a permanent false alarm.
    const problems: { job: string; detail: string }[] = jobs
      .filter((j) => j.job !== "health" && j.overdue)
      .map((j) => ({
        // Widened to `string` so the stranded-runs entry below, which is not
        // about one named job, can join the same list.
        job: j.job as string,
        detail: j.neverRan
          ? "has never completed a run — check the scheduler is configured and CRON_SECRET is set"
          : `last completed ${j.minutesSince} minutes ago (outcome: ${j.lastOutcome ?? "unknown"})`,
      }));

    if (stranded > 0) {
      problems.push({
        job: "any",
        detail: `${stranded} run(s) started and never finished — a route crashed or timed out`,
      });
    }

    let notified = 0;

    if (problems.length > 0) {
      const tenants = await activeTenantIds();
      for (const tenantId of tenants) {
        await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
          const recipients = await alertRecipients(tx, ["owner", "admin"]);
          for (const recipient of recipients) {
            const alreadyTold = await recentlyNotified(tx, {
              template: "cron_unhealthy",
              recipientUserId: recipient.userId,
              withinMinutes: 60,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
              channel: "email",
              template: "cron_unhealthy",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: { recipientName: recipient.fullName, problems },
            });
            if (!("skipped" in result)) notified += 1;
          }
        });
      }

      // A caveat worth being honest about: if `dispatch` is the job that has
      // stopped, this alert is queued into a queue that nobody is draining. The
      // uptime monitor on this endpoint is what covers that case, which is why
      // the status code below matters more than the email.
      console.error("[cron:health] scheduled work is unhealthy", problems);
    }

    // Thrown rather than returned, so `runCron` records the run as failed and
    // the response carries a 500. An uptime monitor watching this URL is the
    // outermost check in the system and it reads status codes, not JSON.
    if (problems.length > 0) {
      const error = new Error(
        problems.map((p) => `${p.job}: ${p.detail}`).join("; "),
      );
      (error as Error & { notified?: number }).notified = notified;
      throw error;
    }

    return {
      processed: jobs.length,
      detail: {
        jobs: jobs.map((j) => ({
          job: j.job,
          lastFinishedAt: j.lastFinishedAt,
          minutesSince: j.minutesSince,
          outcome: j.lastOutcome,
        })),
        stranded,
      },
    };
  });
}
