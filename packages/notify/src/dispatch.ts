import { and, eq, sql, isNull, inArray, desc } from "drizzle-orm";
import { withTenant, schema, type TenantScopedTx, type TenantContext } from "@meridian/db";
import { render, type TemplateId, type TemplatePayloads } from "./templates";
import { ConsoleTransport, type Channel, type Transport, type DeliveryResult } from "./transport";

/**
 * Notification dispatch.
 *
 * Enqueue and send are separate steps, on purpose:
 *
 *  - `enqueue` runs inside the caller's transaction. If the quote insert rolls
 *    back, so does the notification - you never tell a customer about a quote
 *    that does not exist.
 *  - `dispatchPending` runs afterwards, outside that transaction. A provider
 *    timing out must not roll back the business record it was announcing.
 *
 * The `notifications` table is the source of truth for what was attempted, what
 * succeeded and why anything failed.
 */

const MAX_ATTEMPTS = 5;

export interface EnqueueInput<K extends TemplateId> {
  readonly channel: Channel;
  readonly template: K;
  readonly payload: TemplatePayloads[K];
  readonly to: string;
  readonly recipientUserId?: string | undefined;
  /** The record this is about, so the ledger can be traced back. */
  readonly subject?: { table: string; id: string } | undefined;
}

/**
 * Queue a notification. Call inside the transaction that created the thing
 * being announced.
 */
export async function enqueue<K extends TemplateId>(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: EnqueueInput<K>,
): Promise<{ notificationId: string } | { skipped: "no_address" }> {
  // No address is a normal state (a customer with no email), not an error. Skip
  // rather than queue an undeliverable row that will retry five times.
  if (!input.to.trim()) return { skipped: "no_address" };

  const [row] = await tx
    .insert(schema.notifications)
    .values({
      tenantId: ctx.tenantId,
      channel: input.channel,
      template: input.template,
      recipientUserId: input.recipientUserId ?? null,
      recipientAddress: input.to,
      subjectTable: input.subject?.table ?? null,
      subjectId: input.subject?.id ?? null,
      payload: input.payload as Record<string, unknown>,
      status: "queued",
    })
    .returning({ id: schema.notifications.id });

  if (!row) throw new Error("Failed to queue notification");
  return { notificationId: row.id };
}

export interface DispatchSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly abandoned: number;
}

/**
 * Send everything queued for a tenant.
 *
 * Intended to run on a short interval (or immediately after a request, in
 * development). Each notification is claimed by moving it out of `queued`
 * before the provider call, so two workers running at once cannot both send it.
 */
export async function dispatchPending(
  tenantId: string,
  options?: { transport?: Transport; limit?: number },
): Promise<DispatchSummary> {
  const transport = options?.transport ?? new ConsoleTransport();
  const limit = options?.limit ?? 50;

  const claimed = await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    // Claim in one statement. `FOR UPDATE SKIP LOCKED` is what makes two
    // concurrent dispatchers safe: the second one steps over rows the first has
    // taken instead of blocking or double-sending.
    const rows = await tx.execute<{ id: string }>(sql`
      update notifications
         set status = 'sending', attempts = attempts + 1, updated_at = now()
       where id in (
         select id from notifications
          where tenant_id = ${tenantId}
            and status in ('queued', 'failed')
            and attempts < ${MAX_ATTEMPTS}
          order by created_at
          limit ${limit}
          for update skip locked
       )
      returning id
    `);
    return rows as unknown as { id: string }[];
  });

  if (claimed.length === 0) return { attempted: 0, sent: 0, failed: 0, abandoned: 0 };

  let sent = 0;
  let failed = 0;
  let abandoned = 0;

  for (const { id } of claimed) {
    const record = await withTenant({ tenantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.id, id))
        .limit(1);
      return rows[0];
    });
    if (!record) continue;

    if (!transport.supports(record.channel as Channel)) {
      await mark(tenantId, id, {
        status: "failed",
        error: `Transport "${transport.name}" does not support ${record.channel}`,
      });
      failed += 1;
      continue;
    }

    // Everything from here on runs inside a catch. A claimed row sits in
    // `sending`, and the claim query only looks at `queued` and `failed` — so
    // anything that throws between the claim and the mark strands the row
    // permanently, invisible to both the dispatcher and `stuckNotifications`.
    // That is exactly what a template throwing on a malformed payload did.
    // Turning the throw into a recorded failure makes it retryable and visible.
    let result: DeliveryResult;
    try {
      const message = render(
        record.template as TemplateId,
        record.payload as TemplatePayloads[TemplateId],
      );

      result = await transport.send({
        channel: record.channel as Channel,
        to: record.recipientAddress,
        message,
        // Stable across retries, so a provider that dedupes will not send twice
        // when our own retry fires after a provider-side success we never saw.
        idempotencyKey: record.id,
      });
    } catch (error) {
      // Retryable: a bad payload is usually a bug we are about to fix, and the
      // attempt ceiling stops it looping forever either way.
      result = {
        ok: false,
        retryable: true,
        error: error instanceof Error ? error.message : "Unknown dispatch failure",
      };
    }

    if (result.ok) {
      await mark(tenantId, id, { status: "sent", providerMessageId: result.providerMessageId });
      sent += 1;
    } else if (!result.retryable || record.attempts + 1 >= MAX_ATTEMPTS) {
      await mark(tenantId, id, { status: "failed", error: result.error, terminal: true });
      abandoned += 1;
    } else {
      await mark(tenantId, id, { status: "failed", error: result.error });
      failed += 1;
    }
  }

  return { attempted: claimed.length, sent, failed, abandoned };
}

async function mark(
  tenantId: string,
  id: string,
  outcome: {
    status: "sent" | "failed";
    providerMessageId?: string | undefined;
    error?: string | undefined;
    terminal?: boolean;
  },
): Promise<void> {
  await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
    await tx
      .update(schema.notifications)
      .set({
        status: outcome.status,
        providerMessageId: outcome.providerMessageId ?? null,
        lastError: outcome.error ?? null,
        sentAt: outcome.status === "sent" ? new Date() : null,
        updatedAt: new Date(),
        // A terminal failure is parked at the attempt ceiling so the claim
        // query stops picking it up. It stays in the ledger to be investigated.
        ...(outcome.terminal ? { attempts: MAX_ATTEMPTS } : {}),
      })
      .where(eq(schema.notifications.id, id));
  });
}

/** Ledger view, for an admin screen or for debugging a "we never got it" report. */
export async function listNotifications(
  tx: TenantScopedTx,
  options?: { limit?: number; statuses?: readonly string[] },
): Promise<
  readonly {
    id: string;
    channel: string;
    template: string;
    recipientAddress: string;
    status: string;
    attempts: number;
    lastError: string | null;
    sentAt: Date | null;
    createdAt: Date;
  }[]
> {
  return tx
    .select({
      id: schema.notifications.id,
      channel: schema.notifications.channel,
      template: schema.notifications.template,
      recipientAddress: schema.notifications.recipientAddress,
      status: schema.notifications.status,
      attempts: schema.notifications.attempts,
      lastError: schema.notifications.lastError,
      sentAt: schema.notifications.sentAt,
      createdAt: schema.notifications.createdAt,
    })
    .from(schema.notifications)
    .where(
      options?.statuses
        ? and(
            isNull(schema.notifications.deletedAt),
            inArray(schema.notifications.status, [...options.statuses]),
          )
        : isNull(schema.notifications.deletedAt),
    )
    .orderBy(desc(schema.notifications.createdAt))
    .limit(options?.limit ?? 100);
}

/**
 * How long a row may sit in `sending` before we call it stranded.
 *
 * A real provider call is seconds. Anything past this means the dispatcher
 * died mid-flight, and nothing will ever pick the row up again on its own.
 */
export const SENDING_STALE_MINUTES = 15;

export interface StuckSummary {
  /** Tried MAX_ATTEMPTS times and given up. Someone must look at these. */
  readonly abandoned: number;
  /** Claimed but never resolved — a dispatcher that died holding them. */
  readonly stranded: number;
}

/**
 * Notifications that will never send on their own. What an ops dashboard
 * should alert on.
 *
 * Counting only abandoned rows was not enough: a dispatcher killed between the
 * claim and the mark leaves the row in `sending`, where the claim query cannot
 * see it and this function did not count it. Silent, permanent, and the
 * customer is simply never told.
 */
export async function stuckNotifications(tx: TenantScopedTx): Promise<StuckSummary> {
  const rows = await tx
    .select({
      abandoned: sql<number>`count(*) filter (
        where ${schema.notifications.status} = 'failed'
          and ${schema.notifications.attempts} >= ${MAX_ATTEMPTS}
      )::int`,
      stranded: sql<number>`count(*) filter (
        where ${schema.notifications.status} = 'sending'
          and ${schema.notifications.updatedAt} < now() - (${SENDING_STALE_MINUTES} || ' minutes')::interval
      )::int`,
    })
    .from(schema.notifications);

  return { abandoned: rows[0]?.abandoned ?? 0, stranded: rows[0]?.stranded ?? 0 };
}
