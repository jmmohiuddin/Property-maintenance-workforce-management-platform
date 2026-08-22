import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  alertRecipients,
  recentlyNotified,
  ownerDashboard,
  productEventReport,
  PRODUCT_EVENT_NAMES,
} from "@meridian/db/domain";
import { DASHBOARD_GOALS, DASHBOARD_HORIZON_DAYS, tenant } from "@meridian/core";
import { enqueue } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * The weekly owner digest (`KPI-5`). Sundays, 09:00 Asia/Dubai.
 *
 * Phase 2's definition of done is one sentence: *the owner reads one weekly
 * email that answers "is the business healthy".* This route is that sentence.
 *
 * ── WHY THIS IS A THIRD EMAIL, NOT A SECTION IN AN EXISTING ONE ─────────────
 *
 * `/api/cron/compliance` already sends two digests to overlapping recipient
 * lists, and it sends them as two on purpose: `recentlyNotified` is keyed on
 * (template, recipient, window), so two payloads behind one template key means
 * whichever fires second is silently suppressed for the rest of the day. The
 * owner is on both of those lists. Adding this as a third section to either
 * would put the weekly business summary behind a daily compliance window and
 * lose it, with no error anywhere.
 *
 * So: its own template key, its own window, its own route, its own entry in
 * `CRON_JOBS`.
 *
 * ── WHY THE WINDOW IS SIX DAYS AND NOT SEVEN ────────────────────────────────
 *
 * A weekly job that runs an hour early after a scheduler restart would be
 * suppressed by a seven-day window, and the owner would silently lose a week.
 * Six days is short enough to survive that and long enough that a double-fire
 * on the same morning sends one email.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** One alert per recipient per six days. See the note above. */
const SUPPRESSION_MINUTES = 6 * 24 * 60;

/** "Week to 21 August 2026", in Dubai, because that is where the reader is. */
function periodLabel(now: Date): string {
  return `Week to ${now.toLocaleDateString("en-GB", {
    timeZone: tenant.timezone,
    dateStyle: "long",
  })}`;
}

export async function GET(request: Request) {
  return runCron("weekly-digest", request, async () => {
    const now = new Date();
    const tenants = await activeTenantIds();

    let notified = 0;
    let noRecipient = 0;
    let suppressed = 0;
    let criticalItems = 0;
    let eventsInWindow = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const dashboard = await ownerDashboard(tx, { now });
        const events = await productEventReport(tx, { days: 7 });

        eventsInWindow += events.total;
        criticalItems += dashboard.attention.filter((a) => a.severity === "critical").length;

        /*
         * Only the owner, and only the owner.
         *
         * `alertRecipients` routes by role rather than by a configured address
         * list, for the reason it was written: an address list emails a former
         * employee the first time somebody leaves. This digest is the owner's
         * view of the whole business — cash, revenue against a tax threshold,
         * headcount — and sending it to operations or HR would put the P&L in
         * front of people whose screens deliberately do not show it.
         */
        const recipients = await alertRecipients(tx, ["owner"]);

        if (recipients.length === 0) {
          noRecipient += 1;
          // Louder than a console line, because this is the requirement
          // failing rather than a quiet week: the one email Phase 2 is measured
          // by has nobody to go to.
          warnings.push(
            `Tenant ${tenantId} has no active user with the owner role, so the weekly digest ` +
              `reached nobody. KPI-5 is not met for this tenant until one exists.`,
          );
          return;
        }

        for (const recipient of recipients) {
          const alreadyTold = await recentlyNotified(tx, {
            template: "weekly_owner_digest",
            recipientUserId: recipient.userId,
            withinMinutes: SUPPRESSION_MINUTES,
          });
          if (alreadyTold) {
            suppressed += 1;
            continue;
          }

          const result = await enqueue(tx, { tenantId, actorKind: "system" }, {
            channel: "email",
            template: "weekly_owner_digest",
            to: recipient.email,
            recipientUserId: recipient.userId,
            payload: {
              recipientName: recipient.fullName,
              periodLabel: periodLabel(now),
              currency: dashboard.revenue.currency,
              attention: dashboard.attention.map((a) => ({
                severity: a.severity,
                headline: a.headline,
                detail: a.detail,
              })),
              cash: {
                outstandingMinor: dashboard.cash.outstandingMinor,
                overdueMinor: dashboard.cash.overdueMinor,
                currentMinor: dashboard.cash.currentMinor,
                days1to30Minor: dashboard.cash.days1to30Minor,
                days31to60Minor: dashboard.cash.days31to60Minor,
                days61PlusMinor: dashboard.cash.days61PlusMinor,
                dsoDays: dashboard.cash.dsoDays,
                dsoTargetDays: DASHBOARD_GOALS["dsoDays"]!.target,
              },
              revenue: {
                thisMonthMinor: dashboard.revenue.thisMonthMinor,
                lastMonthMinor: dashboard.revenue.lastMonthMinor,
                yearToDateMinor: dashboard.revenue.yearToDateMinor,
                reliefThresholdMinor: dashboard.revenue.relief.thresholdMinor,
                reliefHeadroomMinor: dashboard.revenue.relief.headroomMinor,
                reliefState: dashboard.revenue.relief.state,
                invoicesThisMonth: dashboard.revenue.invoicesThisMonth,
              },
              work: {
                openJobs: dashboard.work.openJobs,
                unassigned: dashboard.work.unassigned,
                byPriority: dashboard.work.byPriority.map((b) => ({ ...b })),
                jobsBreachedThisWeek: dashboard.work.jobsBreachedThisWeek,
                deadlinesMissedThisWeek: dashboard.work.deadlinesMissedThisWeek,
                breachRatePercent: dashboard.work.breachRatePercent,
              },
              pipeline: {
                openLeads: dashboard.pipeline.openLeads,
                openValueMinor: dashboard.pipeline.openValueMinor,
                newThisWeek: dashboard.pipeline.newThisWeek,
                quotesSent: dashboard.pipeline.quotesSent,
                quotesApproved: dashboard.pipeline.quotesApproved,
                conversionPercent: dashboard.pipeline.conversionPercent,
                quotedValueMinor: dashboard.pipeline.quotedValueMinor,
                windowDays: dashboard.pipeline.windowDays,
              },
              contracts: {
                active: dashboard.contracts.active,
                annualValueMinor: dashboard.contracts.annualValueMinor,
                expiring: dashboard.contracts.expiringWithinHorizon.map((c) => ({
                  name: c.name,
                  customerName: c.customerName,
                  daysRemaining: c.daysRemaining,
                  autoRenew: c.autoRenew,
                })),
                horizonDays: DASHBOARD_HORIZON_DAYS,
              },
              people: {
                headcount: dashboard.compliance.headcount,
                deployable: dashboard.compliance.deployable,
                blocked: dashboard.compliance.blocked,
                blockedNames: dashboard.compliance.blockedNames,
                documentsExpiring: dashboard.compliance.documentsExpiring,
                documentsExpired: dashboard.compliance.documentsExpired,
                accreditationsExpiring: dashboard.compliance.accreditationsExpiring,
                nextExpiryLabel: dashboard.compliance.nextExpiry?.label ?? null,
                nextExpiryDays: dashboard.compliance.nextExpiry?.daysRemaining ?? null,
              },
              billing: {
                issuanceBreached: dashboard.billing.issuanceBreached,
                issuanceApproaching: dashboard.billing.issuanceApproaching,
                sequenceGaps: dashboard.billing.sequenceGaps,
                invoiceLagDays: dashboard.billing.invoiceLagDays,
              },
              gaps: dashboard.gaps.map((g) => ({ ...g })),
              // Named in the email, not omitted from it. A reader who sees no
              // portal numbers assumes the portal is quiet; the true statement
              // is that portal actions are not instrumented yet.
              uninstrumentedEvents: events.uninstrumented.map((e) => e.name),
            },
          });

          if (!("skipped" in result)) notified += 1;
        }
      });
    }

    // Repeated every run, like the compliance route's. A gap announced once is
    // a gap nobody remembers, and these decide whether the email the owner is
    // reading is the whole picture or most of it.
    const uninstrumented = PRODUCT_EVENT_NAMES.filter((e) => e.emitter === "none");
    warnings.push(
      `${uninstrumented.length} event families have no emitter (` +
        `${uninstrumented.map((e) => e.name).join(", ")}), so any metric derived from them is ` +
        `reported as a named gap rather than as a zero.`,
    );

    return {
      processed: notified,
      detail: {
        tenants: tenants.length,
        notified,
        suppressed,
        noRecipient,
        criticalItems,
        eventsInWindow,
        suppressionMinutes: SUPPRESSION_MINUTES,
      },
      warnings,
    };
  });
}
