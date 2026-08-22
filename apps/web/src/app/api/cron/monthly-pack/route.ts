import { withTenant, withCustomerScope } from "@meridian/db";
import {
  activeTenantIds,
  customersWithMonthlyPack,
  recentlySentMonthlyPack,
  customerNotificationRecipients,
  customerAccountName,
  propertyManagerMonthlyPack,
} from "@meridian/db/domain";
import { tenant } from "@meridian/core";
import { enqueue } from "@meridian/notify";
import { runCron } from "@/lib/cron";

/**
 * `CUST-5`. The monthly reporting pack for property managers. First of the
 * month, 09:00 Asia/Dubai (`0 5 1 * *` UTC — the same hour `weekly-digest`
 * uses, for the same reason: this account is read as a human's inbox at the
 * start of the working day, not as a machine's queue).
 *
 * Sold on the contracts marketing page as a contract benefit; this route,
 * `propertyManagerMonthlyPack` in `packages/db` and `/portal/reports` are what
 * is actually behind it.
 *
 * ── WHY THE FIGURES ARE BUILT UNDER `withCustomerScope`, INSIDE A LOOP OPENED
 *    UNDER `withTenant` ──────────────────────────────────────────────────────
 *
 * Two different questions need two different scopes:
 *
 *  * "Which customers hold a contract, and who do we email" is a staff
 *    question — it reads across every customer in the tenant, which a
 *    customer-scoped transaction cannot do by construction (that is the whole
 *    point of the restrictive policies in `customer-scope.sql`). It runs under
 *    `withTenant`.
 *  * "What are THIS customer's figures" must not be answered by an
 *    application-code filter — that is exactly the pattern the customer-scope
 *    model exists to make unnecessary, and unnecessary is not the same as
 *    optional. So each pack is built by re-entering the tenant under
 *    `withCustomerScope` for that one customer, the same call
 *    `/portal/reports` makes for a logged-in session. A bug that forgot to
 *    scope here would produce an EMPTY pack for the wrong customer, never
 *    another customer's figures.
 *
 * The dedup check has to sit in the staff-scoped loop rather than inside the
 * customer-scoped block: `notifications` carries no `customer_id` column, so
 * the customer-scope backstop in `customer-scope.sql` closes it to portal
 * reads entirely, and a read under `withCustomerScope` would see nothing —
 * not "nothing sent yet", just nothing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TEMPLATE = "property_manager_monthly_pack" as const;

/** See `recentlySentMonthlyPack` for why this is 27 rather than 30. */
const SUPPRESSION_DAYS = 27;

function periodLabel(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    timeZone: tenant.timezone,
    month: "long",
    year: "numeric",
  });
}

export async function GET(request: Request) {
  return runCron("monthly-pack", request, async () => {
    const now = new Date();
    const tenants = await activeTenantIds();

    let notified = 0;
    let noRecipient = 0;
    let suppressed = 0;
    let customersConsidered = 0;

    const warnings: string[] = [];

    for (const tenantId of tenants) {
      await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
        const customerIds = await customersWithMonthlyPack(tx);
        if (customerIds.length === 0) return;

        customersConsidered += customerIds.length;

        const recipientsByCustomer = await customerNotificationRecipients(tx, customerIds);

        for (const customerId of customerIds) {
          const recipients = recipientsByCustomer.get(customerId) ?? [];
          if (recipients.length === 0) {
            noRecipient += 1;
            continue;
          }

          const alreadySent = await recentlySentMonthlyPack(tx, {
            template: TEMPLATE,
            customerId,
            withinDays: SUPPRESSION_DAYS,
          });
          if (alreadySent) {
            suppressed += 1;
            continue;
          }

          const [pack, customerName] = await Promise.all([
            withCustomerScope({ tenantId, customerId, actorKind: "system" }, (scopedTx) =>
              propertyManagerMonthlyPack(scopedTx, { tenantId, customerId, actorKind: "system" }, { now }),
            ),
            customerAccountName(tx, customerId),
          ]);

          for (const recipient of recipients) {
            const result = await enqueue(
              tx,
              { tenantId, actorKind: "system" },
              {
                channel: "email",
                template: TEMPLATE,
                to: recipient.email,
                subject: { table: "customers", id: customerId },
                payload: {
                  recipientName: recipient.name,
                  customerName: customerName ?? "your account",
                  currency: pack.spend.currency,
                  periodLabel: periodLabel(pack.period.startsOn),
                  jobs: { ...pack.jobs },
                  sla: { ...pack.sla },
                  ppm: { ...pack.ppm },
                  outstanding: {
                    total: pack.outstanding.total,
                    truncated: pack.outstanding.truncated,
                    items: pack.outstanding.items.map((i) => ({ ...i })),
                  },
                  spend: {
                    invoicedMinor: pack.spend.invoicedMinor,
                    invoiceCount: pack.spend.invoiceCount,
                  },
                },
              },
            );

            if (!("skipped" in result)) notified += 1;
          }
        }
      });
    }

    return {
      processed: notified,
      detail: {
        tenants: tenants.length,
        customersConsidered,
        notified,
        suppressed,
        noRecipient,
        suppressionDays: SUPPRESSION_DAYS,
      },
      warnings,
    };
  });
}
