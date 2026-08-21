import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  findExpiringCertifications,
  findExpiringEmployeeDocuments,
  findExpiringAccreditations,
  blockedTechnicians,
  alertRecipients,
  recentlyNotified,
  uninvoicedSignedOffJobs,
} from "@meridian/db/domain";
import { ISSUANCE_WINDOW_DAYS, LATE_ISSUANCE_PENALTY } from "@meridian/core";
import { enqueue } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * Expiry sweep. Daily, 06:00 Asia/Dubai.
 *
 * ── WHAT IS CHECKED ─────────────────────────────────────────────────────────
 *
 *  * `HR-5` employee documents — passport, residence visa, Emirates ID, MOHRE
 *    work permit, medical fitness, health insurance. Five of these hard-block
 *    dispatch under `HR-9`, and the penalty for getting it wrong is AED 100,000
 *    to AED 1,000,000 per worker. These are the alerts that matter most.
 *  * `HR-14` company accreditations — including trade licence 930137, which
 *    expires on 23 January 2027 and previously had nothing watching it. An
 *    expired trade licence stops the business rather than inconveniencing it.
 *  * `HR-3` technician trade certifications, which drive the assignment warning.
 *  * Anyone **already blocked**, reported every day until it is fixed. A block
 *    is not a one-off event: it is a state, and a person who cannot be
 *    dispatched is revenue not being earned as well as a compliance exposure.
 *  * `INV-5` the 14-day issuance clock — signed-off jobs with no invoice, from
 *    day 10. TRD §10 names this route as the mechanism for it. The query lived
 *    in `commerce.ts` with nothing calling it, which is the same as not having
 *    it: a rule nothing evaluates is a rule written in a policy document.
 *
 * ── STILL MISSING, AND SAID OUT LOUD ────────────────────────────────────────
 *
 * The WPS payroll countdown (`HR-17`) and contract renewal reminders (`CON-9`)
 * need tables that do not exist yet. The route says so in its own response
 * rather than reporting a clean bill of health it has not earned.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Escalating windows from §12.1: T-90 / T-60 / T-30 / T-7. */
const ALERT_WINDOW_DAYS = 90;

/** Which band a given number of days falls into, for the digest ordering. */
function band(daysRemaining: number): string {
  if (daysRemaining < 0) return "EXPIRED";
  if (daysRemaining <= 7) return "7 days";
  if (daysRemaining <= 30) return "30 days";
  if (daysRemaining <= 60) return "60 days";
  return "90 days";
}

export async function GET(request: Request) {
  return runCron("compliance", request, async () => {
    const tenants = await activeTenantIds();

    let blockedNow = 0;
    let documentsExpiring = 0;
    let documentsExpired = 0;
    let accreditationsExpiring = 0;
    let certificationsExpiring = 0;
    let notified = 0;
    let suppliesApproaching = 0;
    let suppliesBreached = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const blocked = await blockedTechnicians(tx);
        const documents = await findExpiringEmployeeDocuments(tx, ALERT_WINDOW_DAYS);
        const accreditations = await findExpiringAccreditations(tx, ALERT_WINDOW_DAYS);
        const certifications = await findExpiringCertifications(tx, ALERT_WINDOW_DAYS);

        blockedNow += blocked.length;
        documentsExpiring += documents.length;
        documentsExpired += documents.filter((d) => d.daysRemaining < 0).length;
        accreditationsExpiring += accreditations.length;
        certificationsExpiring += certifications.length;

        // Reported every run while the condition holds, not once when it starts.
        // A technician who cannot legally be sent to work is a standing problem,
        // and an alert that fired once last Tuesday has stopped being visible.
        if (blocked.length > 0) {
          warnings.push(
            `${blocked.length} technician(s) cannot be dispatched: ` +
              blocked.map((b) => `${b.technicianName} — ${b.detail}`).join("; "),
          );
        }

        const expiredAccreditations = accreditations.filter((a) => a.daysRemaining < 0);
        if (expiredAccreditations.length > 0) {
          warnings.push(
            `${expiredAccreditations.length} company accreditation(s) have EXPIRED: ` +
              expiredAccreditations.map((a) => a.name).join("; "),
          );
        }

        const nothingToSay =
          blocked.length === 0 &&
          documents.length === 0 &&
          accreditations.length === 0 &&
          certifications.length === 0;

        if (!nothingToSay) {
          // HR and the owner both. HR acts on it; the owner carries the
          // liability, and `KPI-3` puts compliance expiries on their dashboard
          // for the same reason.
          const recipients = await alertRecipients(tx, ["owner", "hr", "operations_manager"]);
          if (recipients.length === 0) {
            console.warn(
              `[cron:compliance] tenant ${tenantId} has compliance alerts and nobody to send them to`,
            );
          }

          for (const recipient of recipients) {
            // Daily job, daily ceiling. It would not spam on its own, but every
            // scheduler double-fires eventually.
            const alreadyTold = await recentlyNotified(tx, {
              template: "compliance_expiry",
              recipientUserId: recipient.userId,
              withinMinutes: 20 * 60,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
              channel: "email",
              template: "compliance_expiry",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: {
                recipientName: recipient.fullName,
                blocked: blocked.map((b) => ({
                  name: b.technicianName,
                  detail: b.detail,
                  penalty: b.penalty,
                })),
                documents: documents.map((d) => ({
                  name: d.employeeName,
                  label: d.label,
                  daysRemaining: d.daysRemaining,
                  band: band(d.daysRemaining),
                  blocking: d.blocking,
                })),
                accreditations: accreditations.map((a) => ({
                  name: a.name,
                  reference: a.referenceNo,
                  daysRemaining: a.daysRemaining,
                })),
                certifications: certifications.map((c) => ({
                  name: c.technicianName,
                  certification: c.certification,
                  daysRemaining: c.daysRemaining,
                })),
              },
            });

            if (!("skipped" in result)) notified += 1;
          }
        }

        // ── INV-5: the 14-day issuance clock ────────────────────────────────
        //
        // A separate digest to a separate recipient set, deliberately, rather
        // than a fifth section inside `compliance_expiry`. That message goes to
        // HR about people who cannot legally be sent to work; this one goes to
        // the accountant about AED 2,500 an invoice. Merging them would put the
        // two behind one suppression window, so whichever fired second would be
        // silently dropped for the rest of the day.
        //
        // `uninvoicedSignedOffJobs` returns every un-invoiced supply, including
        // ones only two days old. Only those at or past `ISSUANCE_ALERT_DAYS`
        // are alertable — the query's own `state` carries that threshold, so it
        // is not re-derived here.
        const supplies = await uninvoicedSignedOffJobs(tx);
        const due = supplies.filter((s) => s.state !== "within_window");
        const breached = due.filter((s) => s.state === "breached");

        suppliesApproaching += due.length - breached.length;
        suppliesBreached += breached.length;

        // Reported every run while it holds, like the blocked technicians
        // above. A supply past day 14 has already incurred the penalty and
        // stays wrong until an invoice exists; an alert that fired once is an
        // alert nobody can still see.
        if (breached.length > 0) {
          warnings.push(
            `${breached.length} signed-off job(s) are past the ${ISSUANCE_WINDOW_DAYS}-day tax ` +
              `invoice deadline (INV-5, AED 2,500 each): ` +
              breached
                .map((s) => `${s.jobReference} — day ${s.daysSinceSupply}, ${s.customerName}`)
                .join("; "),
          );
        }

        if (due.length > 0) {
          // The accountant raises the invoice; the owner carries the penalty.
          // Not routed to HR or operations — an alert that reaches someone who
          // cannot act on it teaches everyone to skim these.
          const billingRecipients = await alertRecipients(tx, ["accountant", "owner"]);
          if (billingRecipients.length === 0) {
            console.warn(
              `[cron:compliance] tenant ${tenantId} has ${due.length} supply(s) approaching the ` +
                `${ISSUANCE_WINDOW_DAYS}-day invoice deadline and no accountant or owner to tell`,
            );
          }

          for (const recipient of billingRecipients) {
            const alreadyTold = await recentlyNotified(tx, {
              template: "invoice_issuance_due",
              recipientUserId: recipient.userId,
              withinMinutes: 20 * 60,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
              channel: "email",
              template: "invoice_issuance_due",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: {
                recipientName: recipient.fullName,
                windowDays: ISSUANCE_WINDOW_DAYS,
                penalty: LATE_ISSUANCE_PENALTY,
                supplies: due.map((s) => ({
                  jobId: s.jobId,
                  jobReference: s.jobReference,
                  jobTitle: s.jobTitle,
                  customerName: s.customerName,
                  supplyDate: s.supplyDate,
                  daysSinceSupply: s.daysSinceSupply,
                  deadline: s.deadline,
                  // Narrowed for the template: `within_window` was filtered out
                  // above, and the payload type says so rather than accepting a
                  // state the renderer has no branch for.
                  state: s.state === "breached" ? ("breached" as const) : ("approaching" as const),
                })),
              },
            });

            if (!("skipped" in result)) notified += 1;
          }
        }
      });
    }

    // Repeated every run on purpose. A gap that is announced once is a gap
    // nobody remembers, and these are the checks with the largest penalties
    // still attached to them.
    warnings.push(
      "Not yet checked: WPS payroll countdown (HR-17) and contract renewal reminders (CON-9). " +
        "Those tables do not exist yet.",
    );

    return {
      processed:
        documentsExpiring +
        accreditationsExpiring +
        certificationsExpiring +
        suppliesApproaching +
        suppliesBreached,
      detail: {
        tenants: tenants.length,
        blocked: blockedNow,
        documentsExpiring,
        documentsExpired,
        accreditationsExpiring,
        certificationsExpiring,
        suppliesApproaching,
        suppliesBreached,
        notified,
        windowDays: ALERT_WINDOW_DAYS,
        issuanceWindowDays: ISSUANCE_WINDOW_DAYS,
      },
      warnings,
    };
  });
}
