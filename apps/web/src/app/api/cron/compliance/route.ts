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
  findExpiringContracts,
  renewalNoticeSent,
  recordRenewalNotice,
  // HR-17 and the employment lifecycle. Appended, not slotted in.
  currentWageCycle,
  unsettledWageCycles,
  prepareWageFile,
  wageFileGaps,
  autoRenewExpiredContracts,
  contractAlerts,
  healthInsuranceGaps,
  workingHoursExceptions,
  hoursSourceWarning,
  findExpiringSubcontractorObligations,
} from "@meridian/db/domain";
import { ISSUANCE_WINDOW_DAYS, LATE_ISSUANCE_PENALTY } from "@meridian/core";
import {
  today,
  addDays,
  toDecimalString,
  WPS_MINIMUM_TRANSFER_PERCENT,
  WPS_FILE_LEAD_DAYS,
  tenant,
} from "@meridian/core";
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
 *  * `CON-9` contract renewal reminders at T-90 / T-60 / T-30 / T-7, and any
 *    AMC that has already expired unrenewed. The requirement's own sentence is
 *    that "a silently expired AMC is the most expensive failure mode in this
 *    business model", and until M3 this route said in its own response that the
 *    tables did not exist. They do now, and this is the check.
 *
 *  * `HR-17` the WPS payroll countdown. Wages for the previous month are due on
 *    the **1st**, with at least 85% of total wages due transferred by then, and
 *    the escalation past it is what this check exists for: day 5 new work
 *    permits suspended, day 11 fines and a category downgrade, day 16 automatic
 *    labour-dispute registration, day 21 executive orders and possible travel
 *    bans. Alerts run from T-5 and the wage file is produced at T-3. This route
 *    previously said in its own response that the tables did not exist; they do,
 *    and this is the check that closes that sentence.
 *  * `HR-4` contract auto-renewal. A fixed-term contract that ran past its end
 *    date while the worker kept working **has renewed on the same terms**, by
 *    operation of law. The sweep records the term the law has already created,
 *    so the record says "renewed" rather than "expired" — which is the thing
 *    the requirement says people get wrong.
 *  * `HR-6`, `HR-7`, `HR-8` — health insurance gaps, probation and renewal
 *    windows, and working-time breaches, as one weekly-shaped digest.
 *  * `HR-19` subcontractor obligations — trade licences, liability and workmen's
 *    compensation cover, individual work permits, and the subcontractor's own
 *    accreditations, all on the subcontractor register. "Responsibility for
 *    site compliance does not transfer with the work", so an expired
 *    subcontractor licence is our exposure, not only theirs, and it rides in
 *    the same digest HR and the owner already read.
 *
 * ── FOUR LADDERS, ONE ROUTE, THREE MESSAGES ─────────────────────────────────
 *
 * Documents, accreditations, certifications and subcontractor obligations
 * share one digest because they share a recipient (HR and the owner) and an
 * action (renew a piece of paper). The issuance clock is its own message to
 * the accountant. Renewals are their own message again, one per contract,
 * because a renewal is a conversation with one named customer that gets
 * forwarded to their account manager — and a digest of six contracts cannot be
 * forwarded to anybody.
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
    let subcontractorsExpiring = 0;
    let notified = 0;
    let suppliesApproaching = 0;
    let suppliesBreached = 0;
    let renewalsDue = 0;
    let renewalsExpired = 0;
    let renewalNoticesSent = 0;
    let wpsStage = "not_due";
    let wpsDaysLate = 0;
    let wpsFilesPrepared = 0;
    let wpsUnsettled = 0;
    let contractsAutoRenewed = 0;
    let contractsNeedingAttention = 0;
    let insuranceGaps = 0;
    let hoursBreaches = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        // Computed once per tenant, in Dubai, and threaded through every
        // expiry sweep below rather than left to each one's own `today()`
        // default — so a single run reads one "today", not four calls that
        // could in principle straddle a midnight rollover between them.
        const now = today();
        const blocked = await blockedTechnicians(tx, now);
        const documents = await findExpiringEmployeeDocuments(tx, ALERT_WINDOW_DAYS, now);
        const accreditations = await findExpiringAccreditations(tx, ALERT_WINDOW_DAYS, now);
        const certifications = await findExpiringCertifications(tx, ALERT_WINDOW_DAYS, now);
        const subcontractors = await findExpiringSubcontractorObligations(tx, ALERT_WINDOW_DAYS, now);

        blockedNow += blocked.length;
        documentsExpiring += documents.length;
        documentsExpired += documents.filter((d) => d.daysRemaining < 0).length;
        accreditationsExpiring += accreditations.length;
        certificationsExpiring += certifications.length;
        subcontractorsExpiring += subcontractors.length;

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

        // HR-19: responsibility for site compliance does not transfer with the
        // work, so a lapsed subcontractor licence is our exposure and gets the
        // same standing-problem treatment as the blocked-technician warning
        // above — reported every run while it holds.
        const expiredSubcontractors = subcontractors.filter((s) => s.daysRemaining < 0);
        if (expiredSubcontractors.length > 0) {
          warnings.push(
            `${expiredSubcontractors.length} subcontractor obligation(s) have EXPIRED: ` +
              expiredSubcontractors
                .map((s) => `${s.subcontractorName} — ${s.label}`)
                .join("; "),
          );
        }

        const nothingToSay =
          blocked.length === 0 &&
          documents.length === 0 &&
          accreditations.length === 0 &&
          certifications.length === 0 &&
          subcontractors.length === 0;

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
                subcontractors: subcontractors.map((s) => ({
                  subcontractorName: s.subcontractorName,
                  label: s.label,
                  subject: s.subject,
                  daysRemaining: s.daysRemaining,
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

        // ── CON-9: contract renewal reminders ───────────────────────────────
        //
        // The requirement's own sentence: "a silently expired AMC is the most
        // expensive failure mode in this business model." Until M3 this route
        // reported in its own response that the tables did not exist. They do.
        //
        // One email per contract per rung, not a digest, and that is the
        // opposite of the rule for everything above. A renewal is a
        // conversation with one named customer about one number, and the way it
        // gets actioned is by forwarding the email to that customer's account
        // manager — a digest of six contracts cannot be forwarded to anybody.
        //
        // Idempotency is the notice ledger, not the notification queue's time
        // window. `recentlyNotified` is a ceiling on frequency; it cannot tell
        // a 60-day notice from a 30-day one, so a time-based gate would send
        // the same rung twice or skip the next one depending only on timing.
        // `renewalNoticeSent` records which rung was reached.
        const renewals = await findExpiringContracts(tx);
        renewalsDue += renewals.length;
        renewalsExpired += renewals.filter((c) => c.daysRemaining < 0).length;

        if (renewals.length > 0) {
          // The owner carries the commercial consequence; sales does the
          // renewing. Not routed to HR or operations — an alert that reaches
          // someone who cannot act on it teaches everyone to skim these.
          const renewalRecipients = await alertRecipients(tx, ["owner", "sales", "admin"]);
          if (renewalRecipients.length === 0) {
            console.warn(
              `[cron:compliance] tenant ${tenantId} has ${renewals.length} contract(s) due ` +
                `renewal and no owner, sales or admin to tell`,
            );
          }

          for (const contract of renewals) {
            // `band` is non-null for everything `findExpiringContracts`
            // returns — it filters on exactly that — but the type does not know
            // it, and asserting would be the one place this file lied.
            const band = contract.band;
            if (band === null) continue;

            for (const recipient of renewalRecipients) {
              const already = await renewalNoticeSent(tx, {
                contractId: contract.contractId,
                band,
                recipientUserId: recipient.userId,
              });
              if (already) continue;

              const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
                channel: "email",
                template: "contract_renewal_due",
                to: recipient.email,
                recipientUserId: recipient.userId,
                payload: {
                  recipientName: recipient.fullName,
                  contractReference: contract.reference,
                  contractName: contract.name,
                  customerName: contract.customerName,
                  band,
                  daysRemaining: contract.daysRemaining,
                  endsOn: contract.endsOn,
                  annualValue: contract.annualValue,
                  currency: contract.currency,
                  jobsInTerm: contract.jobsInTerm,
                  entitledVisits: contract.entitledVisits,
                  consumedVisits: contract.consumedVisits,
                  utilisationPercent: contract.utilisationPercent,
                  autoRenew: contract.autoRenew,
                  contractId: contract.contractId,
                },
              });

              // Recorded only when something was actually enqueued. Writing the
              // ledger row on a skip would mark the rung sent and guarantee the
              // customer is never chased at that distance again.
              if (!("skipped" in result)) {
                await recordRenewalNotice(tx, { tenantId }, {
                  contractId: contract.contractId,
                  band,
                  recipientUserId: recipient.userId,
                });
                renewalNoticesSent += 1;
                notified += 1;
              }
            }
          }
        }

        // Reported every run while it holds, like the blocked technicians
        // above. An expired AMC is a standing state — planned visits stopped
        // generating the day the term ended — and it stays wrong until somebody
        // renews or closes it. A warning, never a block: the three hard blocks
        // in this system each have a statutory penalty behind them, and this
        // one has a commercial consequence.
        const lapsed = renewals.filter((c) => c.daysRemaining < 0);
        if (lapsed.length > 0) {
          warnings.push(
            `${lapsed.length} contract(s) have EXPIRED without renewal and are generating no ` +
              `planned visits: ` +
              lapsed
                .map((c) => `${c.reference} — ${c.customerName}, ${-c.daysRemaining} day(s) ago`)
                .join("; "),
          );
        }

        // ═══════════════════════════════════════════════════════════════════
        // HR-17: the WPS payroll countdown
        // ═══════════════════════════════════════════════════════════════════
        //
        // The highest-frequency compliance obligation in the business, and the
        // one this route reported as unchecked until now.
        //
        // ── WHY THIS IS NOT A HARD BLOCK ──────────────────────────────────
        //
        // There are exactly three hard blocks in this system and each stops a
        // dispatch: an expired blocking document, an expired work permit, the
        // summer midday ban. Late wages do not become a fourth, and the reason
        // is causal rather than squeamish. Those three stop an act that is
        // itself unlawful at the moment it happens — sending someone to work
        // who may not work, or at an hour when nobody may. Late wages make no
        // worker unlawful to deploy. What day 5 suspends is *new work-permit
        // issuance*, at MOHRE, not existing employment. Blocking dispatch on
        // unpaid wages would stop lawful, already-permitted work in order to
        // punish a payment failure — removing the revenue that pays the wages,
        // which makes the violation worse — and it would be routed around
        // inside a day, after which nothing would be recorded at all.
        //
        // So the escalation earns escalating ALERTS that name the specific
        // consequence in force today, and a warning on the onboarding screen
        // when permit issuance is actually suspended. `assessWpsCycle` carries
        // the full argument.
        //
        // `now` was already computed once, above, when the expiry sweeps ran.
        const wages = await currentWageCycle(tx, { tenantId }, now);
        const unsettled = await unsettledWageCycles(tx, now);
        wpsUnsettled += unsettled.length;

        // ── T-3: produce the wage file inputs ─────────────────────────────
        //
        // `HR-17` requires hours, overtime, absences and deductions by T-3 so
        // the transfer can be instructed before the 1st. Done by the job rather
        // than by a person pressing a button, because the failure mode of "a
        // person presses a button" is that the person is on leave on the 29th.
        // Idempotent: re-running upserts the same lines.
        const gaps = await wageFileGaps(tx);
        if (
          wages.assessment.daysUntilDue <= WPS_FILE_LEAD_DAYS &&
          wages.assessment.stage !== "settled" &&
          wages.filePreparedOn === null
        ) {
          await prepareWageFile(tx, { tenantId }, wages.id, now);
          wpsFilesPrepared += 1;
        }

        // Re-read AFTER any preparation, and assess from here on out. Reading
        // the pre-preparation snapshot reported a tenant that owes nobody
        // anything as twenty days late: with no wage file yet, "AED 0 due" is
        // indistinguishable from "nothing worked out yet", and only the second
        // of those is an alarm. Preparing the file is what tells them apart.
        const cycle = await currentWageCycle(tx, { tenantId }, now);

        // The worst live cycle, not the current one. On 3 September, August's
        // wages being two days late matters less than June's being 64 — and a
        // route that only ever looked at the current month would never mention
        // June again after 1 July.
        //
        // Filtered on `alerting`, not on `daysLate`. A month nobody was owed
        // anything for still has a days-past-the-deadline count; it is simply
        // not a violation, and ranking on the raw number reports it as one.
        const alertingCycles = [cycle, ...unsettled.filter((u) => u.id !== cycle.id)].filter(
          (c) => c.assessment.alerting,
        );
        for (const c of alertingCycles) {
          if (c.assessment.daysLate > wpsDaysLate) {
            wpsDaysLate = c.assessment.daysLate;
            wpsStage = c.assessment.stage;
          }
        }
        if (wpsDaysLate === 0 && wpsStage === "not_due") wpsStage = cycle.assessment.stage;

        for (const live of alertingCycles) {
          // Owner and accountant. §12.1 routes the countdown to exactly those
          // two: one instructs the transfer, the other carries the liability.
          // Not HR — HR cannot move money, and an alert that reaches someone
          // who cannot act on it teaches everyone to skim these.
          const payrollRecipients = await alertRecipients(tx, ["owner", "accountant"]);
          if (payrollRecipients.length === 0) {
            console.warn(
              `[cron:compliance] tenant ${tenantId} has a WPS deadline in ` +
                `${live.assessment.daysUntilDue} day(s) and no owner or accountant to tell`,
            );
          }

          for (const recipient of payrollRecipients) {
            // One a day at the outer edge, but the alarm states get a much
            // tighter ceiling: on the 2nd this is the message §12.1 describes
            // as "alarm tone", and a six-hour window means it lands again the
            // same day if the transfer still has not been confirmed.
            const ceilingMinutes = live.assessment.severity === "alarm" ? 6 * 60 : 20 * 60;
            const alreadyTold = await recentlyNotified(tx, {
              template: "wps_payroll_countdown",
              recipientUserId: recipient.userId,
              withinMinutes: ceilingMinutes,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
              channel: "email",
              template: "wps_payroll_countdown",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: {
                recipientName: recipient.fullName,
                period: live.assessment.label,
                dueOn: live.dueOn,
                daysUntilDue: live.assessment.daysUntilDue,
                daysLate: live.assessment.daysLate,
                stage: live.assessment.stage,
                severity: live.assessment.severity,
                headline: live.assessment.headline,
                consequence: live.assessment.consequence,
                thresholdPercent: WPS_MINIMUM_TRANSFER_PERCENT,
                transferredBasisPoints: live.assessment.transferredBasisPoints,
                totalDue: toDecimalString(live.totalDueMinor),
                totalTransferred: toDecimalString(live.totalTransferredMinor),
                currency: tenant.currency,
                employeeCount: live.employeeCount,
                fileDue: live.assessment.fileDue,
                gaps: gaps.map((g) => ({ name: g.fullName, reason: g.reason })),
              },
            });

            if (!("skipped" in result)) notified += 1;
          }
        }

        // Reported every run while it holds, like the blocked technicians. A
        // wage cycle that went unpaid in June does not stop being unpaid
        // because July's countdown started, and the ladder is still climbing.
        for (const late of alertingCycles) {
          if (late.assessment.daysLate === 0) continue;
          warnings.push(
            `WPS (HR-17): ${late.assessment.label} wages are ${late.assessment.daysLate} day(s) late — ` +
              `day ${late.assessment.daysLate + 1} of the escalation. ${late.assessment.consequence}`,
          );
        }

        if (gaps.length > 0) {
          warnings.push(
            `${gaps.length} active employee(s) would not be reached by a WPS transfer today: ` +
              gaps.map((g) => g.fullName).join("; "),
          );
        }

        // ═══════════════════════════════════════════════════════════════════
        // HR-4: record the renewals the law has already performed
        // ═══════════════════════════════════════════════════════════════════
        //
        // Before the digest, deliberately: the sweep writes the renewed terms,
        // and `contractAlerts` below then reports the *current* state rather
        // than reporting a lapse the same run has already resolved.
        const autoRenewed = await autoRenewExpiredContracts(tx, { tenantId }, now);
        contractsAutoRenewed += autoRenewed.length;

        if (autoRenewed.length > 0) {
          warnings.push(
            `${autoRenewed.length} employment contract(s) auto-renewed on the same terms because work ` +
              `continued past the end date (HR-4): ` +
              autoRenewed.map((r) => `${r.fullName} — now to ${r.endsOn}`).join("; "),
          );
        }

        // ═══════════════════════════════════════════════════════════════════
        // HR-4 / HR-6 / HR-7 / HR-8: the employment lifecycle digest
        // ═══════════════════════════════════════════════════════════════════
        //
        // Its own message, to HR and the owner. Deliberately not a section
        // inside `compliance_expiry`: that one is about people who cannot
        // legally be sent to work today, and merging a probation end date into
        // it would put both behind one suppression window — after which
        // whichever fired second would be silently dropped for the day.
        const lifecycleContracts = await contractAlerts(tx, now);
        const insurance = await healthInsuranceGaps(tx);
        const hours = await workingHoursExceptions(tx, { from: addDays(now, -7), to: now });
        const hoursWarning = await hoursSourceWarning(tx);

        contractsNeedingAttention += lifecycleContracts.length;
        insuranceGaps += insurance.length;
        hoursBreaches += hours.length;

        if (
          autoRenewed.length > 0 ||
          lifecycleContracts.length > 0 ||
          insurance.length > 0 ||
          hours.length > 0
        ) {
          const hrRecipients = await alertRecipients(tx, ["owner", "hr", "operations_manager"]);
          for (const recipient of hrRecipients) {
            const alreadyTold = await recentlyNotified(tx, {
              template: "employment_lifecycle",
              recipientUserId: recipient.userId,
              withinMinutes: 20 * 60,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
              channel: "email",
              template: "employment_lifecycle",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: {
                recipientName: recipient.fullName,
                renewed: autoRenewed.map((r) => ({
                  name: r.fullName,
                  previousEnd: r.previousEnd,
                  startsOn: r.startsOn,
                  endsOn: r.endsOn,
                })),
                contracts: lifecycleContracts.map((c) => ({
                  name: c.fullName,
                  state: c.state,
                  detail: c.detail,
                  daysToEnd: c.daysToEnd,
                  problems: c.problems,
                })),
                insurance: insurance.map((i) => ({ name: i.fullName, problems: i.problems })),
                hours: hours.map((h) => ({
                  name: h.fullName,
                  workedOn: h.workedOn,
                  detail: h.detail,
                })),
                hoursWarning,
              },
            });

            if (!("skipped" in result)) notified += 1;
          }
        }

        // Said out loud rather than left as a clean bill of health the check has
        // not earned. `HR-8` computes the daily and weekly maxima from
        // clock-in/out, which arrives with the field app; until then the only
        // hours this route knows about are hand-entered overtime, so an empty
        // exception list means nothing is being measured.
        if (hoursWarning) warnings.push(`HR-8/HR-10: ${hoursWarning}`);
      });
    }

    return {
      processed:
        documentsExpiring +
        accreditationsExpiring +
        certificationsExpiring +
        subcontractorsExpiring +
        suppliesApproaching +
        suppliesBreached +
        renewalsDue +
        contractsAutoRenewed +
        contractsNeedingAttention +
        insuranceGaps +
        hoursBreaches,
      detail: {
        tenants: tenants.length,
        blocked: blockedNow,
        documentsExpiring,
        documentsExpired,
        accreditationsExpiring,
        certificationsExpiring,
        subcontractorsExpiring,
        suppliesApproaching,
        suppliesBreached,
        renewalsDue,
        renewalsExpired,
        renewalNoticesSent,
        // HR-17. The stage is reported, not a boolean: "late" and "day 11,
        // fines and a category downgrade" are different operational facts and
        // the response is the only place a scheduler with alerting can read
        // either of them.
        wpsStage,
        wpsDaysLate,
        wpsUnsettled,
        wpsFilesPrepared,
        wpsThresholdPercent: WPS_MINIMUM_TRANSFER_PERCENT,
        contractsAutoRenewed,
        contractsNeedingAttention,
        insuranceGaps,
        hoursBreaches,
        notified,
        windowDays: ALERT_WINDOW_DAYS,
        issuanceWindowDays: ISSUANCE_WINDOW_DAYS,
      },
      warnings,
    };
  });
}
