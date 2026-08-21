import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  dueOutcomes,
  markAcknowledged,
  markOutcomeSent,
  outcomeAccountability,
  pendingAcknowledgements,
  purgeExpiredCandidates,
  talentPoolExpiringCertifications,
  talentPoolNeedingReconfirmation,
} from "@meridian/db/domain";
import { enqueue, selectTransport } from "@meridian/notify";
import { applicationStatusUrl, CERTIFICATION_EXPIRY_WINDOW_DAYS } from "@meridian/core";
import { runCron } from "@/lib/cron";

/**
 * The job that keeps `ATS-16`'s promise. Every 15 minutes.
 *
 * ── WHY THE MESSAGES ARE SENT FROM HERE AND NOT FROM THE ACTION ─────────────
 *
 * Two different reasons, one per message:
 *
 *  * **The acknowledgement (`ATS-14`)** cannot be sent from the public
 *    application request, because that request deliberately never opens a
 *    tenant-scoped transaction — the whole submission happens inside a
 *    `SECURITY DEFINER` function so an anonymous caller never carries a
 *    tenant's row-level-security scope. It also should not be: an
 *    acknowledgement fired best-effort from a request is one that vanishes
 *    whenever the process dies between the commit and the enqueue, and the
 *    applicant has no way of knowing it was lost. Swept, it is durable.
 *
 *  * **The outcome (`ATS-15`)** must not be sent from the action that decided
 *    it. The requirement is a minimum one-day delay *so the message can be
 *    cancelled if the decision changes* — and decisions change more often than
 *    anybody plans for: the first choice takes another offer on Tuesday and
 *    Monday's rejection is suddenly the hire. A message dispatched inside the
 *    archive request is a message that cannot be recalled.
 *
 * ── WHAT THIS ROUTE REPORTS EVEN WHEN IT DOES NOTHING ──────────────────────
 *
 * `G14` — applicants receiving an outcome ÷ all applicants — on every run, per
 * tenant, in `detail`, and as a warning the moment anyone is overdue. A number
 * that only exists on a reports page is a number nobody looks at until the
 * quarter ends; a number in the cron ledger is one that shows up in
 * `/api/cron/health` and in the run history.
 *
 * The `unreachable` count is the honest one. An applicant with no email address
 * cannot be told anything at all until an SMS or WhatsApp transport exists
 * (`ATS-14` asks for one first, email second, and only email is wired). Most
 * systems would count those people as satisfied because nothing failed. This
 * one counts them as unreached and says so every fifteen minutes.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return runCron("recruitment", request, async () => {
    const transport = selectTransport();
    const tenants = await activeTenantIds();

    let acknowledged = 0;
    let acknowledgedUnreachable = 0;
    let outcomesSent = 0;
    let outcomesUnreachable = 0;
    let candidatesPurged = 0;
    let poolReconfirmationsDue = 0;
    let poolCertificatesLapsed = 0;
    let poolCertificatesExpiring = 0;
    const poolCertificateNames: string[] = [];
    const orphanedStorageKeys: string[] = [];

    let owedTotal = 0;
    let overdueTotal = 0;
    let unreachableTotal = 0;
    let awaitingHumanTotal = 0;
    let staleActiveTotal = 0;
    let oldestOverdueDays = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      const ctx = { tenantId, actorKind: "system" as const };

      await withTenant(ctx, async (tx) => {
        // ── ATS-14: acknowledge ─────────────────────────────────────────────
        for (const application of await pendingAcknowledgements(tx, 200)) {
          if (application.email) {
            await enqueue(tx, ctx, {
              channel: "email",
              template: "application_received",
              to: application.email,
              subject: { table: "applications", id: application.applicationId },
              payload: {
                candidateFirstName: application.fullName.split(" ")[0] ?? application.fullName,
                roleTitle: application.roleTitle,
                applicationReference: application.reference,
                statusUrl: applicationStatusUrl(application.statusToken),
                outcomeDueAt: application.outcomeDueAt,
              },
            });
            await markAcknowledged(tx, ctx, {
              applicationId: application.applicationId,
              channel: "email",
            });
            acknowledged += 1;
          } else {
            // Phone only, and no SMS transport exists. Marked with a null
            // channel rather than left pending: leaving it pending would make
            // this loop retry the same rows forever and would hide the real
            // problem, which is a missing transport rather than a missing send.
            await markAcknowledged(tx, ctx, {
              applicationId: application.applicationId,
              channel: null,
            });
            acknowledgedUnreachable += 1;
          }
        }

        // ── ATS-15/ATS-16: release outcomes whose window has closed ─────────
        for (const outcome of await dueOutcomes(tx, 200)) {
          if (!outcome.email) {
            // Left unsent on purpose. Stamping `outcome_sent_at` here to keep
            // the queue tidy would close the obligation without discharging it,
            // and the accountability report — the one thing standing between
            // this module and every other ATS — would start lying.
            outcomesUnreachable += 1;
            continue;
          }

          const queued = await enqueue(tx, ctx, {
            channel: "email",
            template: "application_outcome",
            to: outcome.email,
            subject: { table: "applications", id: outcome.applicationId },
            payload: {
              candidateFirstName: outcome.fullName.split(" ")[0] ?? outcome.fullName,
              roleTitle: outcome.roleTitle,
              applicationReference: outcome.reference,
              message: outcome.message,
              statusUrl: applicationStatusUrl(outcome.statusToken),
            },
          });

          await markOutcomeSent(tx, ctx, {
            applicationId: outcome.applicationId,
            channel: "email",
            notificationId: "notificationId" in queued ? queued.notificationId : undefined,
          });
          outcomesSent += 1;
        }

        // ── ATS-13: consent goes stale ──────────────────────────────────────
        poolReconfirmationsDue += (await talentPoolNeedingReconfirmation(tx, 500)).length;

        // ── ATS-13: and so do certificates ──────────────────────────────────
        //
        // Counted here rather than only on /recruitment/pool, and the reason is
        // the same one that put G14 in this ledger. A lapsed ticket is not a
        // thing somebody goes looking for; it is a thing that has to arrive.
        // The screen names them and is where the phone calls get made from —
        // but a screen only alerts the people who open it, and the week nobody
        // opens it is the week a certificate lapses on somebody who is about to
        // be offered a job. So: the cron carries the count and the warning, and
        // the screen carries the names.
        //
        // WHAT IS NOT BUILT, SAID PLAINLY: this does not email anybody. The
        // pattern for that is next door in /api/cron/health — alertRecipients
        // over owner/admin/hr, suppressed with recentlyNotified at 1440 minutes
        // so it sends once a day rather than once every fifteen-minute run —
        // and every piece of it exists except the template. The one template
        // that looks close, `certification_expiring`, is the HR-3 message about
        // an employee: its payload field is literally `technicianName`, and
        // sending it about a pool member would tell an owner that a technician
        // they do not employ has a lapsing ticket. A message that misdescribes
        // who somebody is, is worse than a warning in a ledger. This needs a
        // `talent_pool_certification_expiring` template in packages/notify,
        // which is not this change's to write.
        const expiring = await talentPoolExpiringCertifications(tx);
        for (const certificate of expiring) {
          if (certificate.lapsed) poolCertificatesLapsed += 1;
          else poolCertificatesExpiring += 1;
          if (poolCertificateNames.length < 20) {
            poolCertificateNames.push(
              `${certificate.fullName} (${certificate.scheme}, ${certificate.lapsed ? "lapsed" : "expires"} ${certificate.expiresOn})`,
            );
          }
        }

        // ── ATS-18: retention ───────────────────────────────────────────────
        //
        // Run here as well as being available to /api/cron/retention. The daily
        // route is where it belongs and where the integration should put it;
        // this call is what makes it actually run in the meantime, because an
        // applicant-data purge that exists as an unwired function is the same
        // thing as the policy document TRD §10 warns about.
        const purge = await purgeExpiredCandidates(tx, ctx);
        candidatesPurged += purge.deleted;
        orphanedStorageKeys.push(...purge.orphanedStorageKeys);

        // ── G14 ─────────────────────────────────────────────────────────────
        const g14 = await outcomeAccountability(tx);
        owedTotal += g14.awaiting + g14.overdue;
        overdueTotal += g14.overdue;
        unreachableTotal += g14.unreachable;
        awaitingHumanTotal += g14.awaitingHumanSend;
        staleActiveTotal += g14.staleActive;
        oldestOverdueDays = Math.max(oldestOverdueDays, g14.oldestOverdueDays);
      });
    }

    if (transport.name === "console") {
      warnings.push(
        "No email transport is configured (RESEND_API_KEY / NOTIFY_FROM unset). Applicant " +
          "acknowledgements and outcome messages were written to the log and NOT delivered. " +
          "ATS-16's target is 100% of applicants receiving an outcome; on this deployment it is 0%.",
      );
    }

    if (overdueTotal > 0) {
      warnings.push(
        `${overdueTotal} applicant(s) are past the date they were promised an answer` +
          (oldestOverdueDays > 0 ? `, the oldest by ${oldestOverdueDays} days` : "") +
          `. G14 targets 100%. The named list is on /recruitment.`,
      );
    }

    if (staleActiveTotal > 0) {
      warnings.push(
        `${staleActiveTotal} application(s) are still live and past their promised date — nobody ` +
          "has decided anything about them. This is the state that becomes a silent rejection.",
      );
    }

    if (unreachableTotal + outcomesUnreachable + acknowledgedUnreachable > 0) {
      warnings.push(
        `${unreachableTotal} applicant(s) gave a phone number and no email address, and no SMS or ` +
          "WhatsApp transport exists (ATS-14 asks for that channel first). They cannot be told " +
          "anything by this system. They are counted as unreached, not as satisfied.",
      );
    }

    if (awaitingHumanTotal > 0) {
      // Not a failure. ATS-15 forbids an automated rejection after any human
      // interaction, so these are correctly waiting for a person — but a queue
      // of them that never falls is the same outcome as ghosting.
      warnings.push(
        `${awaitingHumanTotal} outcome message(s) are composed and waiting for a person to send ` +
          "them. Automated rejection is not permitted after a human has spoken to the candidate " +
          "(ATS-15), so this number is expected to be non-zero — but it should always be falling.",
      );
    }

    if (poolCertificatesLapsed + poolCertificatesExpiring > 0) {
      warnings.push(
        `${poolCertificatesLapsed} talent-pool certificate(s) have already lapsed and ` +
          `${poolCertificatesExpiring} lapse within the next ${CERTIFICATION_EXPIRY_WINDOW_DAYS} ` +
          "days. Nobody has been emailed about this — there is no template for it " +
          "yet (see the note in this file). A pool member whose ticket " +
          "has expired is not a prospect, they are a phone call — and under HR-9 an expired " +
          "certificate blocks the dispatch the day after they are hired. The named list is on " +
          "/recruitment/pool: " +
          poolCertificateNames.join("; "),
      );
    }

    if (orphanedStorageKeys.length > 0) {
      warnings.push(
        `${orphanedStorageKeys.length} object-storage key(s) are orphaned by the applicant purge: ` +
          "the rows are gone and nothing in this system can delete from object storage (OPS-6). " +
          "Until lifecycle rules exist those CVs must be removed by hand: " +
          orphanedStorageKeys.slice(0, 20).join(", "),
      );
    }

    return {
      processed: acknowledged + outcomesSent + candidatesPurged,
      detail: {
        transport: transport.name,
        tenants: tenants.length,
        acknowledged,
        acknowledgedUnreachable,
        outcomesSent,
        outcomesUnreachable,
        owedAnOutcome: owedTotal,
        overdue: overdueTotal,
        staleActive: staleActiveTotal,
        unreachable: unreachableTotal,
        awaitingHumanSend: awaitingHumanTotal,
        oldestOverdueDays,
        candidatesPurged,
        orphanedStorageKeys: orphanedStorageKeys.length,
        poolReconfirmationsDue,
        poolCertificatesLapsed,
        poolCertificatesExpiring,
      },
      warnings,
    };
  });
}
