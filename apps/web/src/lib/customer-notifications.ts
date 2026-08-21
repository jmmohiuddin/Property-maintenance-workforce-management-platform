import "server-only";
import { withTenant, pendingCustomerNotifications, type PendingCustomerNotification } from "@meridian/db";
import { enqueue } from "@meridian/notify";

/**
 * Queue the customer notifications `POR-5` requires.
 *
 * ── WHY THIS FILE EXISTS AND IS NOT IN `packages/db` ───────────────────────
 *
 * `packages/notify` imports `packages/db`, so `db` cannot import `notify` to
 * enqueue anything — it would be a cycle. The same inversion `createLeadFromEnquiry`
 * uses for its `onCreated` hook applies here: the database side works out *what*
 * is owed (`pendingCustomerNotifications`), and this side, which may import both,
 * turns each row into a typed `enqueue`.
 *
 * The switch below is the price of that, and it is worth paying. Because each
 * case names its template literally, the compiler checks every payload against
 * `TemplatePayloads` — a renamed field is a build failure here rather than an
 * email that says "Hello undefined". A loop over a generic `{template, payload}`
 * pair would compile and produce exactly that.
 *
 * ── WHY THE ENQUEUE IS INSIDE THE READ'S TRANSACTION ───────────────────────
 *
 * `pendingCustomerNotifications` decides what is owed by checking what is
 * already in the `notifications` ledger. If the read and the write were in
 * separate transactions, two dispatchers running at once would both see the
 * same gap and both fill it, and the customer would get two of everything.
 * Inside one transaction the ledger row and the decision that produced it
 * commit together.
 */
export async function queueCustomerNotifications(
  tenantId: string,
  options?: { sinceDays?: number; limit?: number },
): Promise<{ queued: number; withoutAddress: number }> {
  return withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    const pending = await pendingCustomerNotifications(tx, options);

    let queued = 0;
    let withoutAddress = 0;

    for (const item of pending) {
      if (item.recipients.length === 0) {
        // Counted, not silently skipped. A customer with no contact email is a
        // data gap somebody can fix, and it is invisible unless the sweep says
        // how often it stopped a message going out.
        withoutAddress++;
        continue;
      }

      for (const to of item.recipients) {
        const result = await enqueueOne(tx, tenantId, item, to.email);
        if (result) queued++;
      }
    }

    return { queued, withoutAddress };
  });
}

type Tx = Parameters<Parameters<typeof withTenant<void>>[1]>[0];

/**
 * One notification, with its template chosen by the event.
 *
 * Four of the seven events reuse a template that already existed rather than
 * getting a near-identical twin. That is not tidiness: `subject_table` plus
 * `template` is the idempotency key the sweep dedupes on, so a second
 * "invoice_issued_v2" template would make every invoice already announced by
 * the jobs screen look un-announced, and every customer would be told twice.
 */
async function enqueueOne(
  tx: Tx,
  tenantId: string,
  item: PendingCustomerNotification,
  to: string,
): Promise<boolean> {
  const ctx = { tenantId, actorKind: "system" as const };
  const subject = { table: item.subjectTable, id: item.subjectId };

  switch (item.event) {
    case "request_received":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "request_received",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          jobReference: item.reference,
          jobTitle: item.title,
        },
      });
      return true;

    case "visit_scheduled":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "visit_scheduled",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          jobReference: item.reference,
          jobTitle: item.title,
          technicianName: item.detail,
          scheduledStart: item.occursAt,
          scheduledEnd: item.occursEndAt,
        },
      });
      return true;

    case "technician_en_route":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "technician_en_route",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          jobReference: item.reference,
          jobTitle: item.title,
          technicianName: item.detail,
        },
      });
      return true;

    case "work_complete":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "job_completed",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          jobReference: item.reference,
          jobTitle: item.title,
        },
      });
      return true;

    case "quote_awaiting_decision":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "quote_sent",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          quoteReference: item.reference,
          quoteTitle: item.title,
          total: item.amount ?? "0",
          currency: item.currency ?? "AED",
          quoteId: item.subjectId,
          validUntil: item.occursEndAt,
        },
      });
      return true;

    case "invoice_issued":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "invoice_issued",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          invoiceReference: item.reference,
          total: item.amount ?? "0",
          currency: item.currency ?? "AED",
          dueOn: item.occursAt,
        },
      });
      return true;

    case "payment_received":
      await enqueue(tx, ctx, {
        channel: "email",
        template: "payment_received",
        to,
        subject,
        payload: {
          customerName: item.customerName,
          invoiceReference: item.reference,
          amount: item.amount ?? "0",
          currency: item.currency ?? "AED",
          method: item.detail,
          receivedAt: item.occursAt,
        },
      });
      return true;

    default: {
      // Exhaustiveness, checked by the compiler. Adding an event to
      // `CUSTOMER_NOTIFICATION_EVENTS` without adding a case here is a build
      // error rather than an event that is collected, offered as a preference
      // and never sent.
      const unreachable: never = item.event;
      console.error(`[customer-notifications] no template for ${String(unreachable)}`);
      return false;
    }
  }
}
