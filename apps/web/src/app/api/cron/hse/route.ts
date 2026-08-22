import { withTenant } from "@meridian/db";
import {
  activeTenantIds,
  alertRecipients,
  listPpeIssues,
  listRams,
  openInjuryNotifications,
  recentlyNotified,
  ropeAccessTickets,
} from "@meridian/db/domain";
import { enqueue } from "@meridian/notify";
import {
  today,
  formatDay,
  INJURY_CAUSE_LABEL,
  INJURY_SEVERITY_LABEL,
  MOHRE_INJURY_NOTIFICATION_HOURS,
  PPE_ITEM_LABEL,
  PPE_REPLACEMENT_WARN_DAYS,
  RAMS_REVIEW_WARN_DAYS,
} from "@meridian/core";
import { runCron } from "@/lib/cron";

/**
 * The health, safety and environment sweep. Hourly, at :20 past.
 *
 * ── WHY THIS IS HOURLY WHEN EVERY OTHER COMPLIANCE JOB IS NIGHTLY ───────────
 *
 * `HR-11`. A work injury or occupational disease has to reach MOHRE inside 48
 * hours. The nightly `compliance` job would get two attempts at that window and
 * could be up to twenty-four hours late on each — so the last band, the twelve
 * hours before the establishment is actually in breach, would be skipped
 * routinely rather than occasionally. A clock that only tells you about a
 * deadline after it has passed is a report, not a clock.
 *
 * The `HR-12` clocks are day-valued and would have been happy nightly. They ride
 * here anyway rather than being wired into the compliance route, because they
 * are the same subject, the same recipients and the same board — and their
 * suppression window is a day, so an hourly job sends them once a day like any
 * other digest.
 *
 * ── WHAT IT DOES, IN ORDER, PER TENANT ──────────────────────────────────────
 *
 *  1. **The injury clock** (`HR-11`). `openInjuryNotifications` returns every
 *     record still owed to MOHRE or an insurer, oldest first, each carrying
 *     `assessInjuryNotification`'s stage and consequence. One email per record
 *     rather than a digest — see below.
 *  2. **RAMS falling out of review** (`HR-12`), inside 30 days or already past.
 *  3. **PPE due for replacement** (`HR-12`), same window.
 *  4. **Rope-access tickets** (`HR-12` / IRATA), expired or expiring.
 *
 * 2, 3 and 4 are warnings on the response and on the board. They are not emails
 * of their own: an expiring IRATA ticket already goes out through
 * `certification_expiring` from the nightly compliance sweep, and a second
 * message about the same certificate from a second job is how people learn to
 * filter both.
 *
 * ── ONE EMAIL PER INJURY, NOT A DIGEST ──────────────────────────────────────
 *
 * The opposite call from every other sweep in this application, and it is
 * deliberate. A digest is right when the reader's action is to work through a
 * list — retention claims, expiring documents. Here the reader's action is to
 * make one phone call about one person, and the record's own deadline is
 * different from every other record's, because each clock started when that
 * injury happened. A digest would carry four different countdowns in one body
 * and land in one suppression window, so the one with six hours left would be
 * silenced by the one with thirty.
 *
 * The suppression window is keyed on the record's own urgency for the same
 * reason the WPS ladder tightens its ceiling in an alarm state.
 *
 * ── WHAT THIS ROUTE MUST NOT DO ─────────────────────────────────────────────
 *
 * **It must never mark anything notified.** MOHRE is notified by a person
 * making a submission, and nothing here observes that. A job that stamped
 * `mohre_notified_at` on its own would replace a live statutory obligation with
 * a tidy screen and no notification — the failure would look exactly like
 * success everywhere in the product, which is the same argument
 * `releaseRetention` makes about the money.
 *
 * **It blocks nothing.** The one thing this system must never do is make
 * recording an injury expensive; a register people stop writing in is the
 * failure the obligation exists to prevent. The full argument is on
 * `assessInjuryNotification` in `packages/core`.
 *
 * ── THE SCHEDULE ────────────────────────────────────────────────────────────
 *
 * `20 * * * *`, hourly at twenty past, on a minute no other job uses. Not on
 * the hour, where `sweep` already runs — two full passes over every tenant on
 * the same connection pool at the same minute is the reason the existing jobs
 * are staggered at all.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** How far ahead a rope-access ticket is worth mentioning. */
const CERT_WINDOW_DAYS = 60;

/**
 * How long one recipient goes without hearing about the same injury again.
 *
 * Two ceilings, because the window is 48 hours long. Twelve hours is roughly
 * four messages across the whole window — enough to be a countdown rather than
 * a notice. Two hours applies once the record is in its final band or already
 * overdue: at that point the message is the alarm tone §12.1 describes, and a
 * twelve-hour silence would let the entire final band pass with one email in
 * it.
 */
const INJURY_SUPPRESSION_MINUTES = 12 * 60;
const INJURY_ALARM_SUPPRESSION_MINUTES = 2 * 60;

export async function GET(request: Request): Promise<Response> {
  return runCron("hse", request, async () => {
    const tenants = await activeTenantIds();

    let injuriesOpen = 0;
    let injuriesOverdue = 0;
    let policeOutstanding = 0;
    let ramsDue = 0;
    let ramsLapsed = 0;
    let ppeDue = 0;
    let ppeLapsed = 0;
    let ticketsExpiring = 0;
    let ticketsExpired = 0;
    let notified = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const ctx = { tenantId, actorKind: "system" as const };
        // One instant for the whole tenant's pass, so every countdown in one
        // run is measured from the same moment. Reading the clock per record
        // would let two records a millisecond apart report different hours
        // remaining, which is exactly the kind of one-off that gets diagnosed
        // as a code bug an hour later.
        const now = new Date();
        // Dubai's day, for the day-valued clocks below. NOT `current_date` —
        // the Postgres session here runs at Asia/Dhaka, two hours ahead, so for
        // roughly two hours in every twenty-four it is a day out.
        const day = today(now);

        // ── HR-11: the 48-hour clock ────────────────────────────────────────
        const open = await openInjuryNotifications(tx, now);
        injuriesOpen += open.length;

        for (const injury of open) {
          const overdue = injury.assessment.overdue;
          if (overdue) injuriesOverdue += 1;
          if (injury.policeReportOutstanding) policeOutstanding += 1;

          // Owner, HR and the operations manager. HR makes the MOHRE
          // submission, the owner carries the liability, and the operations
          // manager is who actually knows what happened on site — the three
          // people who between them can complete the notification. Not the
          // accountant: an alert reaching somebody who cannot act on it teaches
          // everyone to skim these.
          const recipients = await alertRecipients(tx, ["owner", "hr", "operations_manager"]);
          if (recipients.length === 0) {
            console.warn(
              `[cron:hse] tenant ${tenantId} has injury ${injury.reference} with ` +
                `${injury.assessment.hoursRemaining} hour(s) on the MOHRE clock and nobody to tell`,
            );
          }

          const ceiling =
            injury.assessment.severity === "alarm"
              ? INJURY_ALARM_SUPPRESSION_MINUTES
              : INJURY_SUPPRESSION_MINUTES;

          for (const recipient of recipients) {
            const alreadyTold = await recentlyNotified(tx, {
              // Keyed on the template and the recipient, like every other
              // suppression check in this codebase. That means a second injury
              // inside the window is suppressed by the first — accepted
              // deliberately, because the alternative is a per-record ledger
              // table and because two injuries in twelve hours is a phone call
              // rather than an email problem. The board shows both regardless.
              template: "work_injury_notification",
              recipientUserId: recipient.userId,
              withinMinutes: ceiling,
            });
            if (alreadyTold) continue;

            const result = await enqueue(tx, ctx, {
              channel: "email",
              template: "work_injury_notification",
              to: recipient.email,
              recipientUserId: recipient.userId,
              subject: { table: "work_injuries", id: injury.id },
              payload: {
                recipientName: recipient.fullName,
                reference: injury.reference,
                // Null only after the HR-15 purge has severed the link, which
                // cannot have happened to a record still inside its 48-hour
                // window — but the type admits it, and "an employee" is what
                // the alert would otherwise say.
                employeeName: injury.employeeName ?? injury.employeeNo ?? "an employee",
                kind: injury.kind,
                cause: INJURY_CAUSE_LABEL[injury.cause] ?? injury.cause,
                severity: INJURY_SEVERITY_LABEL[injury.severity] ?? injury.severity,
                occurredAt: injury.occurredAt.toISOString(),
                occurredOn: formatDay(injury.occurredOn),
                dueAt: injury.assessment.dueAt.toISOString(),
                stage: injury.assessment.stage,
                severityTone: injury.assessment.severity,
                hoursRemaining: injury.assessment.hoursRemaining,
                hoursLate: injury.assessment.hoursLate,
                windowHours: MOHRE_INJURY_NOTIFICATION_HOURS,
                mohreNotified: injury.assessment.mohreNotified,
                insurerNotified: injury.assessment.insurerNotified,
                policeReportOutstanding: injury.policeReportOutstanding,
                headline: injury.assessment.headline,
                consequence: injury.assessment.consequence,
              },
            });

            if (!("skipped" in result)) notified += 1;
          }
        }

        // Reported every run while it holds, like the blocked technicians in
        // the compliance sweep. An unnotified injury is a standing state and it
        // stays wrong until somebody makes the submission.
        const overdueRecords = open.filter(
          (i) => i.assessment.overdue,
        );
        if (overdueRecords.length > 0) {
          warnings.push(
            `HR-11: ${overdueRecords.length} work injury notification(s) are past the ` +
              `${MOHRE_INJURY_NOTIFICATION_HOURS}-hour MOHRE window: ` +
              overdueRecords
                .map((i) => `${i.reference} — ${i.assessment.hoursLate} hour(s) overdue`)
                .join("; "),
          );
        }

        const police = open.filter((i) => i.policeReportOutstanding);
        if (police.length > 0) {
          warnings.push(
            `HR-11: ${police.length} injury record(s) are police-reportable with no police ` +
              `reference recorded. That obligation is immediate and has no countdown behind it: ` +
              police.map((i) => `${i.reference} (${i.severity})`).join("; "),
          );
        }

        // ── HR-12: RAMS falling out of review ───────────────────────────────
        const rams = await listRams(tx, {
          withinDays: RAMS_REVIEW_WARN_DAYS,
          approvedOnly: true,
          now: day,
        });
        const ramsOut = rams.filter((r) => (r.daysToReview ?? 0) < 0);
        ramsDue += rams.length;
        ramsLapsed += ramsOut.length;

        if (ramsOut.length > 0) {
          warnings.push(
            `HR-12: ${ramsOut.length} risk assessment(s) are past their review date and still ` +
              `approved for use: ` +
              ramsOut
                .map((r) => `${r.reference} ${r.title} — ${Math.abs(r.daysToReview ?? 0)} day(s) ago`)
                .join("; "),
          );
        }

        // ── HR-12: PPE due for replacement ──────────────────────────────────
        const ppe = await listPpeIssues(tx, { withinDays: PPE_REPLACEMENT_WARN_DAYS, now: day });
        const ppeOut = ppe.filter((p) => (p.daysToReplacement ?? 0) < 0);
        ppeDue += ppe.length;
        ppeLapsed += ppeOut.length;

        if (ppeOut.length > 0) {
          warnings.push(
            `HR-12: ${ppeOut.length} item(s) of PPE are past their replacement date and still on ` +
              `issue: ` +
              ppeOut
                .map(
                  (p) =>
                    `${p.employeeName} — ${PPE_ITEM_LABEL[p.itemKind] ?? p.itemKind}, ` +
                    `${Math.abs(p.daysToReplacement ?? 0)} day(s) ago`,
                )
                .join("; "),
          );
        }

        // ── HR-12: rope access ──────────────────────────────────────────────
        //
        // Read here and reported here; NOT emailed here. An expiring
        // certification already goes out through `certification_expiring` from
        // the nightly compliance sweep, and the assignment gate already refuses
        // to pass an expired one without a recorded reason. A second message
        // from a second job about the same certificate is how people learn to
        // filter both.
        const tickets = await ropeAccessTickets(tx, { now: day });
        const expired = tickets.filter((t) => (t.daysRemaining ?? 1) < 0);
        const expiring = tickets.filter(
          (t) => t.daysRemaining !== null && t.daysRemaining >= 0 && t.daysRemaining <= CERT_WINDOW_DAYS,
        );
        ticketsExpired += expired.length;
        ticketsExpiring += expiring.length;

        if (expired.length > 0) {
          warnings.push(
            `HR-12: ${expired.length} rope-access ticket(s) have expired. Assignment to a ` +
              `rope-access service already requires a recorded override for these, and is not ` +
              `blocked outright — see ropeAccessTickets for why: ` +
              expired
                .map((t) => `${t.technicianName} — ${t.name}, expired ${t.expiresOn ?? "on an unrecorded date"}`)
                .join("; "),
          );
        }

        const noExpiry = tickets.filter((t) => t.expiresOn === null);
        if (noExpiry.length > 0) {
          // A ticket with no expiry date is invisible to the assignment gate,
          // which only ever looks at rows where `expires_on` is not null. It
          // reads on a board as a certification somebody holds; to the control
          // it does not exist at all.
          warnings.push(
            `HR-12: ${noExpiry.length} rope-access ticket(s) have no expiry date recorded, so the ` +
              `assignment gate cannot see them at all: ` +
              noExpiry.map((t) => `${t.technicianName} — ${t.name}`).join("; "),
          );
        }
      });
    }

    return {
      processed: injuriesOpen + ramsDue + ppeDue + ticketsExpiring + ticketsExpired,
      detail: {
        tenants: tenants.length,
        injuriesOpen,
        injuriesOverdue,
        policeOutstanding,
        ramsDue,
        ramsLapsed,
        ppeDue,
        ppeLapsed,
        ticketsExpiring,
        ticketsExpired,
        notified,
        windowHours: MOHRE_INJURY_NOTIFICATION_HOURS,
      },
      warnings,
    };
  });
}
