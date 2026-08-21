import "server-only";
import {
  withTenant,
  isCustomerNotificationEnabled,
  customerNotificationRecipients,
  recordSuppressedCustomerNotification,
  pendingCustomerNotifications,
  CUSTOMER_NOTIFICATION_TEMPLATE,
  type PendingCustomerNotification,
  type TenantContext,
  type TenantScopedTx,
} from "@meridian/db";
import { enqueue } from "@meridian/notify";

/**
 * Queue the customer notifications `POR-5` requires.
 *
 * ── WHY THIS FILE EXISTS AND IS NOT IN `packages/db` ───────────────────────
 *
 * `packages/notify` imports `packages/db`, so `db` cannot import `notify` to
 * enqueue anything — it would be a cycle. The same inversion `createLeadFromEnquiry`
 * uses for its `onCreated` hook applies here: the database side works out *what*
 * is owed (`pendingCustomerNotifications`), *whether the customer wants it*
 * (`isCustomerNotificationEnabled`) and *who it goes to*
 * (`customerNotificationRecipients`), and this side, which may import both,
 * turns each row into a typed `enqueue`.
 *
 * The switch below is the price of that, and it is worth paying. Because each
 * case names its template through `CUSTOMER_NOTIFICATION_TEMPLATE` — whose
 * values are `as const`, so they keep their literal types — the compiler checks
 * every payload against `TemplatePayloads`. A renamed field is a build failure
 * here rather than an email that says "Hello undefined". A loop over a generic
 * `{template, payload}` pair would compile and produce exactly that.
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
      // The opt-out was applied in SQL — `pendingCustomerNotifications` carries
      // it back as a flag rather than dropping the row, so that a refusal can
      // be recorded instead of silently deferred. Writing it here rather than
      // in the query keeps one writer for both paths; the reasoning for why the
      // refusal has to be written down at all is on the domain function.
      if (item.muted) {
        await recordSuppressedCustomerNotification(
          tx,
          { tenantId, actorKind: "system" },
          {
            event: item.event,
            subjectTable: item.subjectTable,
            subjectId: item.subjectId,
            address: item.recipients[0]?.email ?? "",
          },
        );
        continue;
      }

      if (item.recipients.length === 0) {
        // Counted, not silently skipped. A customer with no contact email is a
        // data gap somebody can fix, and it is invisible unless the sweep says
        // how often it stopped a message going out.
        withoutAddress++;
        continue;
      }

      for (const to of item.recipients) {
        if (await enqueueOne(tx, { tenantId, actorKind: "system" }, item, to.email)) queued++;
      }
    }

    return { queued, withoutAddress };
  });
}

/**
 * Everything a customer notification needs, apart from who it goes to.
 *
 * Identical to what the sweep's candidate query produces, minus the two things
 * the sweep resolves in bulk and an immediate send resolves for itself: who it
 * goes to, and whether the customer wants it. That is on purpose — an immediate
 * send is not a different kind of message, only an earlier one, and making the
 * two paths take the same input is what lets them share the enqueue below
 * rather than drift.
 *
 * `muted` is omitted rather than accepted so that a caller cannot assert it. If
 * a call site could pass `muted: false`, honouring the opt-out would be back to
 * something each site remembers to do.
 */
export type CustomerNotificationInput = Omit<
  PendingCustomerNotification,
  "recipients" | "muted"
>;

export interface CustomerNotificationOutcome {
  /** How many addresses it was queued for. */
  readonly queued: number;
  /** The customer has switched this event off. Nothing was sent, by design. */
  readonly muted: boolean;
}

/**
 * Send one customer notification now, if the customer wants it.
 *
 * ── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 *
 * Three of the seven `POR-5` events are announced the moment they happen as
 * well as by the sweep: the portal acknowledging a request, the jobs screen
 * sending a quote, the jobs screen raising an invoice. Those three called
 * `enqueue` directly. They never read `customer_notification_preferences` at
 * all, so a customer who had switched invoice emails off received every one of
 * them — and permanently, because the ledger row the send wrote is exactly what
 * tells the sweep an invoice has already been announced, so the sweep never
 * revisited it either.
 *
 * Deleting the immediate sends and leaving it to the sweep would have been the
 * smaller change and the wrong one: somebody who has just raised a request
 * wants the acknowledgement while they are still looking at the screen, not on
 * the next cron tick. So they stay, and the two checks they were missing — may
 * we send, and to whom — live in `packages/db` where the sweep reads them too.
 * A new immediate send cannot resolve an address without coming through here,
 * which is what makes honouring the opt-out structural rather than remembered.
 *
 * ── THE LEDGER INTERACTION ─────────────────────────────────────────────────
 *
 * A muted event does not simply return: it records the refusal, through the
 * same writer the sweep uses. That is load-bearing rather than tidy. The sweep
 * decides what is owed by asking what the ledger does not already name, so
 * withholding a message by writing nothing would only defer it — the customer
 * would get the whole muted week in one go the moment they switched the event
 * back on. A mute is a refusal, not a pause. The full reasoning, including why
 * the row cannot block a later genuine event, is on
 * `recordSuppressedCustomerNotification`.
 *
 * Must be called inside the transaction that made the thing being announced
 * (`TRD §7.3`). A notification must not promise something that rolled back.
 */
export async function sendCustomerNotification(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: CustomerNotificationInput,
): Promise<CustomerNotificationOutcome> {
  const recipients =
    (await customerNotificationRecipients(tx, [input.customerId])).get(input.customerId) ?? [];

  if (!(await isCustomerNotificationEnabled(tx, input.customerId, input.event))) {
    await recordSuppressedCustomerNotification(tx, ctx, {
      event: input.event,
      subjectTable: input.subjectTable,
      subjectId: input.subjectId,
      // Resolved even though nothing is being sent, so the ledger can answer
      // "why did they not get it" without a second lookup.
      address: recipients[0]?.email ?? "",
    });
    return { queued: 0, muted: true };
  }

  let queued = 0;
  for (const to of recipients) {
    if (await enqueueOne(tx, ctx, input, to.email)) queued++;
  }

  // `{ queued: 0, muted: false }` is the third state and the caller has to be
  // able to tell it apart: the customer wants this message and we have no
  // address to send it to. Collapsing that into a bare count would have staff
  // telling a customer they opted out when the real problem is a missing email.
  return { queued, muted: false };
}

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
  tx: TenantScopedTx,
  ctx: TenantContext,
  item: CustomerNotificationInput,
  to: string,
): Promise<boolean> {
  const subject = { table: item.subjectTable, id: item.subjectId };

  switch (item.event) {
    case "request_received":
      await enqueue(tx, ctx, {
        channel: "email",
        template: CUSTOMER_NOTIFICATION_TEMPLATE.request_received,
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
        template: CUSTOMER_NOTIFICATION_TEMPLATE.visit_scheduled,
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
        template: CUSTOMER_NOTIFICATION_TEMPLATE.technician_en_route,
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
        template: CUSTOMER_NOTIFICATION_TEMPLATE.work_complete,
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
        template: CUSTOMER_NOTIFICATION_TEMPLATE.quote_awaiting_decision,
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
        template: CUSTOMER_NOTIFICATION_TEMPLATE.invoice_issued,
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
        template: CUSTOMER_NOTIFICATION_TEMPLATE.payment_received,
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
