import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  alertRecipients,
  listExpiringPermits,
  listRetention,
  listUnapprovedSubcontracts,
  markPermitsReminded,
  markRetentionReminded,
  markSubcontractsReminded,
  needsChasing,
  recentlyNotified,
} from "@meridian/db/domain";
import { enqueue } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * The projects chase sweep. Daily, 07:15 Asia/Dubai (`15 3 * * *` UTC).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `PRJ-5` built the retention ledger — two rows per invoice, the split, the
 * two due dates fixed at practical completion — and `listRetention({
 * dueWithinDays })` and `markRetentionReminded` were written for a caller that
 * never appeared. `PRJ-9` built the engagement register with
 * `client_approval_state` defaulting to `pending`, deliberately, so that
 * nothing could be recorded as approved by accident — and then nothing ever
 * read that default. `PRJ-6` records a permit's expiry date and uses it only to
 * refuse a button.
 *
 * All three are the same failure: a state the system knows about and no person
 * is ever told. The requirement puts it best about retention — "retention
 * nobody chases is a gift to the client" — and the subcontract half is worse
 * than a gift, because Dubai Law No. 7 of 2025 requires the employer's PRIOR
 * approval before subcontracting within the contracting sector. An engagement
 * whose `starts_on` has arrived while the approval is still `pending` is not
 * running late on paperwork; it is already the wrong side of a statutory line,
 * and every day it goes unmentioned is a day somebody could have fixed it.
 *
 * ── WHAT IT DOES, IN ORDER, PER TENANT ──────────────────────────────────────
 *
 *  1. **Retention** (`PRJ-5`). `listRetention({ dueWithinDays: 45 })` — held or
 *     due, with a due date, inside the window or already past it. Rows chased
 *     within the last day are dropped by `needsChasing`, so a scheduler that
 *     double-fires does not reset the clock on everything.
 *  2. **Unapproved engagements** (`PRJ-9`). `pending` and `refused`, on
 *     projects that have not closed or been cancelled, least-recently-chased
 *     first so the ones nobody has ever asked about come out of the index in
 *     front of the ones asked about four times.
 *  3. **Required permits about to lapse** (`PRJ-6`), inside 30 days or already
 *     expired.
 *  4. **Send, then mark, inside one transaction.** The `enqueue` and the
 *     `mark…Reminded` write share the `withTenant` transaction, so a send that
 *     is recorded is a send that was queued. Marked-but-not-queued would be a
 *     row that never gets chased again; queued-but-not-marked is merely a
 *     second email tomorrow, which is why the order is this way round.
 *
 * ── WHY TWO MESSAGES AND NOT ONE ────────────────────────────────────────────
 *
 * `retention_release_due` goes to the accountant and the owner: it is money the
 * client is holding, and it is actioned by raising a release invoice.
 * `project_approvals_due` goes to the operations manager and the owner: it is a
 * site about to be stopped or already running unlawfully, and it is actioned by
 * getting a letter or standing a crew down. The permits ride in with the
 * approvals rather than taking a third message, because they reach the same
 * inbox with the same verb. See the reasoning above the two entries in
 * `packages/notify/src/templates.ts`; it is not repeated here.
 *
 * ── WHAT THIS ROUTE MUST NOT DO ─────────────────────────────────────────────
 *
 * **It must never release retention.** `releaseRetention`'s own comment states
 * the rule and it is load-bearing: the system computes the due date and
 * produces the chase list, but the money is returned when a client actually
 * pays it and nothing here observes that. A scheduled release would mark every
 * claim `released` on its due date and replace a chase with a tidy report and
 * an empty bank account — the failure would look exactly like success on every
 * screen in the product.
 *
 * It also does not approve, refuse or expire anything else. It does not set a
 * `client_approval_state` (an approval is a letter from the employer, not an
 * inference from a date), and it does not move a lapsed permit to `expired` —
 * `blockingPermits` already compares the date, so a status written here would
 * be a second answer to a question that already has one, and the second answer
 * is always the stale one.
 *
 * It blocks nothing. The three hard blocks in this system each have a named
 * statutory penalty behind them and each lives at the point of action; a chase
 * list is a warning by construction.
 *
 * ── THE SCHEDULE ────────────────────────────────────────────────────────────
 *
 * `15 3 * * *` UTC, 07:15 in Dubai, on a minute no other job uses. It is third
 * in the existing morning chain — contracts at 05:30 (`30 1`), compliance at
 * 06:00 (`0 2`), this at 07:15 — and last of the three on purpose: an
 * engagement or a permit that changed overnight is picked up by neither of the
 * others, and this route reads state rather than producing it, so it has
 * nothing to hand them. Seven-fifteen is also when an accountant and an
 * operations manager open a mailbox for the first time, which is the only
 * property of a daily digest that decides whether it is read.
 *
 * Nothing is scheduled between 02:00 and 05:30 Dubai on purpose either: the
 * data-retention purge at `0 22` UTC is a long table-wide delete, and putting
 * two full passes over every tenant on the same connection pool at the same
 * minute is the reason the existing jobs are staggered at all.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * How far ahead retention is chased.
 *
 * Forty-five days rather than a week. The action at the other end is not a
 * click — it is raising a release invoice against a practical completion
 * certificate, or evidencing the end of a defects liability period a year after
 * anybody last thought about the project. Six weeks is roughly how long that
 * takes to organise, and a reminder that arrives after the due date has taught
 * the reader the reminder is decorative.
 *
 * Rows already past their due date are inside this window too — `dueWithinDays`
 * is an upper bound, not a range — which is deliberate: the day retention falls
 * due is the day it starts being ignored.
 */
const RETENTION_WINDOW_DAYS = 45;

/**
 * How far ahead a required permit is chased.
 *
 * Thirty days, because that is roughly the shortest turnaround for a renewal
 * from any of the authorities in `permit_authorities`, and a warning that
 * arrives with less notice than the renewal takes is a warning that only tells
 * somebody they are already too late.
 */
const PERMIT_WINDOW_DAYS = 30;

/**
 * A row is not chased twice within this many hours.
 *
 * Twenty hours, matching the `recentlyNotified` ceiling used by the compliance
 * sweep, and the two are not redundant. This one gates the *rows*: without it a
 * scheduler that fires twice would re-stamp `last_reminded_at` on everything and
 * the "least recently chased" ordering would lose the only thing it orders by.
 * `recentlyNotified` gates the *recipient*: without it, a tenant whose row set
 * changed by a single entry overnight would be emailed twice about the rest.
 */
const CHASE_SUPPRESSION_HOURS = 20;

export async function GET(request: Request) {
  return runCron("projects", request, async () => {
    const tenants = await activeTenantIds();

    let retentionChased = 0;
    let retentionOverdue = 0;
    let retentionMinor = 0;
    let subcontractsChased = 0;
    let subcontractsStarted = 0;
    let subcontractsRefused = 0;
    let permitsChased = 0;
    let permitsLapsed = 0;
    let notified = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const ctx = { tenantId, actorKind: "system" as const };
        const now = new Date();

        // ── PRJ-5: retention ────────────────────────────────────────────────
        //
        // `listRetention` is also the ledger the project screen reads, so it
        // carries no chase window of its own — filtering it here with
        // `needsChasing` is the same predicate the other two queries apply in
        // SQL, written once in the domain module so they cannot drift.
        const retention = (await listRetention(tx, { dueWithinDays: RETENTION_WINDOW_DAYS }))
          .filter((r) => needsChasing(r.lastRemindedAt, CHASE_SUPPRESSION_HOURS, now))
          // `dueWithinDays` guarantees a non-null due date; the type does not
          // know it, and narrowing here is cheaper than asserting.
          .filter((r) => r.dueOn !== null && r.daysToDue !== null);

        const dueMinor = retention.reduce((sum, r) => sum + r.amountMinor, 0);
        const overdue = retention.filter((r) => (r.daysToDue ?? 0) < 0);

        retentionChased += retention.length;
        retentionOverdue += overdue.length;
        retentionMinor += dueMinor;

        if (overdue.length > 0) {
          // Reported every run while the condition holds, like the blocked
          // technicians in the compliance sweep. Retention past its due date is
          // a standing state, not an event, and it stays wrong until somebody
          // invoices for it.
          warnings.push(
            `${overdue.length} retention claim(s) are past their due date and unreleased ` +
              `(PRJ-5): ` +
              overdue
                .map(
                  (r) =>
                    `${r.projectReference} — ${r.customerName}, ${Math.abs(r.daysToDue ?? 0)} ` +
                    `day(s) overdue`,
                )
                .join("; "),
          );
        }

        if (retention.length > 0) {
          // The accountant raises the release invoice; the owner carries the
          // cash. Not routed to operations or HR — an alert that reaches
          // someone who cannot act on it teaches everyone to skim these.
          const moneyRecipients = await alertRecipients(tx, ["accountant", "owner"]);
          if (moneyRecipients.length === 0) {
            console.warn(
              `[cron:projects] tenant ${tenantId} has ${retention.length} retention claim(s) ` +
                `falling due and no accountant or owner to tell`,
            );
          }

          let queued = false;

          for (const recipient of moneyRecipients) {
            const alreadyTold = await recentlyNotified(tx, {
              template: "retention_release_due",
              recipientUserId: recipient.userId,
              withinMinutes: CHASE_SUPPRESSION_HOURS * 60,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, ctx, {
              channel: "email",
              template: "retention_release_due",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: {
                recipientName: recipient.fullName,
                currency: "AED",
                totalMinor: dueMinor,
                entries: retention.map((r) => ({
                  projectReference: r.projectReference,
                  projectName: r.projectName,
                  customerName: r.customerName,
                  invoiceReference: r.invoiceReference,
                  stage:
                    r.stage === "practical_completion"
                      ? ("practical_completion" as const)
                      : ("defects_liability" as const),
                  amountMinor: r.amountMinor,
                  // Narrowed above. `dueOn` and `daysToDue` are non-null for
                  // everything `dueWithinDays` returns.
                  dueOn: r.dueOn ?? "",
                  daysToDue: r.daysToDue ?? 0,
                })),
              },
            });

            if (!("skipped" in result)) {
              notified += 1;
              queued = true;
            }
          }

          // Marked only when something was actually queued, and in the same
          // transaction as the enqueue. Stamping `last_reminded_at` on a run
          // that reached nobody would silence the row for the next twenty hours
          // on the strength of an email that does not exist.
          if (queued) await markRetentionReminded(tx, retention.map((r) => r.id));
        }

        // ── PRJ-9 and PRJ-6: approvals and permits ──────────────────────────
        const subcontracts = await listUnapprovedSubcontracts(tx, {
          notRemindedWithinHours: CHASE_SUPPRESSION_HOURS,
        });
        const permits = await listExpiringPermits(tx, {
          withinDays: PERMIT_WINDOW_DAYS,
          notRemindedWithinHours: CHASE_SUPPRESSION_HOURS,
        });

        const started = subcontracts.filter(
          (s) => s.approvalState === "pending" && s.alreadyStarted,
        );
        const refused = subcontracts.filter((s) => s.approvalState === "refused");
        const lapsed = permits.filter((q) => q.daysRemaining < 0);

        subcontractsChased += subcontracts.length;
        subcontractsStarted += started.length;
        subcontractsRefused += refused.length;
        permitsChased += permits.length;
        permitsLapsed += lapsed.length;

        if (started.length > 0 || refused.length > 0) {
          warnings.push(
            `${started.length + refused.length} subcontract engagement(s) are on site without ` +
              `the employer's approval (PRJ-9, Dubai Law No. 7 of 2025 requires it in advance): ` +
              [...refused, ...started]
                .map(
                  (s) =>
                    `${s.projectReference} — ${s.subcontractorName} (${s.approvalState}` +
                    (s.daysSinceStart === null
                      ? ""
                      : `, started ${s.daysSinceStart} day(s) ago`) +
                    `)`,
                )
                .join("; "),
          );
        }

        if (lapsed.length > 0) {
          warnings.push(
            `${lapsed.length} required permit(s) have expired and are blocking work (PRJ-6): ` +
              lapsed
                .map((q) => `${q.projectReference} — ${q.permitType}, ${q.authorityLabel}`)
                .join("; "),
          );
        }

        if (subcontracts.length > 0 || permits.length > 0) {
          // Operations gets the crew off site or the letter signed; the owner
          // carries the exposure. Admin is not on this list: the approval is a
          // commercial conversation with the employer, not filing.
          const siteRecipients = await alertRecipients(tx, ["operations_manager", "owner"]);
          if (siteRecipients.length === 0) {
            console.warn(
              `[cron:projects] tenant ${tenantId} has ${subcontracts.length} unapproved ` +
                `subcontract(s) and ${permits.length} expiring permit(s), and no operations ` +
                `manager or owner to tell`,
            );
          }

          let queued = false;

          for (const recipient of siteRecipients) {
            const alreadyTold = await recentlyNotified(tx, {
              template: "project_approvals_due",
              recipientUserId: recipient.userId,
              withinMinutes: CHASE_SUPPRESSION_HOURS * 60,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, ctx, {
              channel: "email",
              template: "project_approvals_due",
              to: recipient.email,
              recipientUserId: recipient.userId,
              payload: {
                recipientName: recipient.fullName,
                currency: "AED",
                subcontracts: subcontracts.map((s) => ({
                  projectReference: s.projectReference,
                  projectName: s.projectName,
                  subcontractorName: s.subcontractorName,
                  scope: s.scope,
                  valueMinor: s.valueMinor,
                  // The query returns only these two states. Narrowed for the
                  // template rather than asserted, so a widened query is a
                  // compile error here instead of a message with no branch.
                  approvalState:
                    s.approvalState === "refused" ? ("refused" as const) : ("pending" as const),
                  startsOn: s.startsOn,
                  alreadyStarted: s.alreadyStarted,
                  daysSinceStart: s.daysSinceStart,
                })),
                permits: permits.map((q) => ({
                  projectReference: q.projectReference,
                  projectName: q.projectName,
                  authorityLabel: q.authorityLabel,
                  permitType: q.permitType,
                  referenceNumber: q.referenceNumber,
                  expiresOn: q.expiresOn,
                  daysRemaining: q.daysRemaining,
                })),
              },
            });

            if (!("skipped" in result)) {
              notified += 1;
              queued = true;
            }
          }

          if (queued) {
            await markSubcontractsReminded(tx, subcontracts.map((s) => s.id));
            await markPermitsReminded(tx, permits.map((q) => q.id));
          }
        }
      });
    }

    return {
      processed: retentionChased + subcontractsChased + permitsChased,
      detail: {
        tenants: tenants.length,
        retentionChased,
        retentionOverdue,
        retentionMinor,
        retentionWindowDays: RETENTION_WINDOW_DAYS,
        subcontractsChased,
        subcontractsStartedWithoutApproval: subcontractsStarted,
        subcontractsRefused,
        permitsChased,
        permitsLapsed,
        permitWindowDays: PERMIT_WINDOW_DAYS,
        notified,
      },
      warnings,
    };
  });
}
