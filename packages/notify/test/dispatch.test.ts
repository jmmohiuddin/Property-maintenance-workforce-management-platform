/**
 * Notification pipeline integration test, against real Postgres.
 *
 * Exercises the paths that only matter when things go wrong: retry, terminal
 * failure, and the claim that stops two dispatchers double-sending. Those are
 * the parts a happy-path smoke test never reaches, and the parts that decide
 * whether a customer gets told twice or not at all.
 */

import { eq, inArray } from "drizzle-orm";
import { withTenant, schema, closeConnection } from "@meridian/db";
import {
  enqueue,
  dispatchPending,
  ConsoleTransport,
  FailingTransport,
  render,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ctx = { tenantId: TENANT };

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const ids: string[] = [];

async function queueOne(to = "test@example.invalid"): Promise<string> {
  const result = await withTenant(ctx, (tx) =>
    enqueue(tx, ctx, {
      channel: "email",
      template: "request_received",
      to,
      payload: { customerName: "Test", jobReference: "JOB-TEST", jobTitle: "Pipeline test" },
    }),
  );
  if (!("notificationId" in result)) throw new Error("expected a queued notification");
  ids.push(result.notificationId);
  return result.notificationId;
}

async function statusOf(id: string) {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({
        status: schema.notifications.status,
        attempts: schema.notifications.attempts,
        lastError: schema.notifications.lastError,
        providerMessageId: schema.notifications.providerMessageId,
        sentAt: schema.notifications.sentAt,
      })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, id));
    return rows[0];
  });
}

async function clearQueue(): Promise<void> {
  // Park anything already queued so counts in this test are about this test.
  await withTenant(ctx, async (tx) => {
    await tx
      .update(schema.notifications)
      .set({ status: "sent", sentAt: new Date() })
      .where(inArray(schema.notifications.status, ["queued", "failed", "sending"]));
  });
}

async function main(): Promise<void> {
  await clearQueue();

  // ── Templates render before anything touches a provider ───────────────────
  const msg = render("quote_sent", {
    customerName: "Bay Tower Owners Association",
    quoteReference: "QUO-2026-00001",
    quoteTitle: "Booster pump replacement",
    total: "8736.00",
    currency: "AED",
    quoteId: "abc",
    validUntil: new Date("2026-09-05"),
  });
  checkTrue("quote template shows the money", msg.subject.includes("8,736.00"));
  checkTrue("quote template links to the portal", msg.body.includes("/portal/quotes/abc"));
  checkTrue("every message carries the emergency number", msg.body.includes("Emergencies"));

  // ── Happy path ────────────────────────────────────────────────────────────
  const okId = await queueOne();
  check("queued", (await statusOf(okId))?.status, "queued");

  const first = await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  check("one attempted", first.attempted, 1);
  check("one sent", first.sent, 1);

  const afterSend = await statusOf(okId);
  check("marked sent", afterSend?.status, "sent");
  checkTrue("sentAt stamped", afterSend?.sentAt !== null);
  checkTrue(
    "console transport is identifiable in the ledger",
    afterSend?.providerMessageId?.startsWith("console:") === true,
  );

  // A second run must not re-send it. This is the check that stops a customer
  // being emailed on every cron tick.
  const second = await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  check("nothing left to send", second.attempted, 0);

  // ── A date survives the round trip through JSONB ──────────────────────────
  // The regression this pins: `enqueue` takes a real Date, but the payload is
  // stored as JSONB and comes back as an ISO string. Rendering assumed a live
  // Date and threw on every message carrying one — invoices, quotes and
  // assignments all did — and the queue then burned four retries before
  // abandoning. Rendering a *stored* row is the only way to catch it; rendering
  // the in-memory payload, as the template check above does, always passes.
  const datedId = await withTenant(ctx, async (tx) => {
    const result = await enqueue(tx, ctx, {
      channel: "email",
      template: "invoice_issued",
      to: "dated@example.invalid",
      payload: {
        customerName: "Bay Tower Owners Association",
        invoiceReference: "INV-TEST-0001",
        total: "2520.00",
        currency: "AED",
        dueOn: new Date("2026-09-05T00:00:00Z"),
      },
    });
    if (!("notificationId" in result)) throw new Error("expected a queued notification");
    ids.push(result.notificationId);
    return result.notificationId;
  });

  const storedPayload = await withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ payload: schema.notifications.payload })
      .from(schema.notifications)
      .where(eq(schema.notifications.id, datedId));
    return rows[0]?.payload as Record<string, unknown> | undefined;
  });
  checkTrue(
    "the stored date is a string, not a Date",
    typeof storedPayload?.["dueOn"] === "string",
  );

  const rendered = render("invoice_issued", storedPayload as never);
  checkTrue("a round-tripped date still renders", rendered.body.includes("5 September 2026"));

  const dated = await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  check("the dated message sends on the first attempt", dated.sent, 1);
  check("and is not left failed", (await statusOf(datedId))?.status, "sent");

  // ── A throwing template fails the row rather than stranding it ────────────
  // Before this, a render that threw left the row in `sending` — a status the
  // claim query does not look at — so it was never retried and never reported.
  // The customer simply never heard, and nothing anywhere said so.
  const brokenId = await withTenant(ctx, async (tx) => {
    const result = await enqueue(tx, ctx, {
      channel: "email",
      template: "invoice_issued",
      to: "broken@example.invalid",
      // `total` missing entirely: rendering will throw on it.
      payload: { customerName: "Test" } as never,
    });
    if (!("notificationId" in result)) throw new Error("expected a queued notification");
    ids.push(result.notificationId);
    return result.notificationId;
  });

  const broken = await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  check("a throwing template counts as a failure, not a send", broken.sent, 0);
  const afterBroken = await statusOf(brokenId);
  check("and the row is failed, not left in sending", afterBroken?.status, "failed");
  checkTrue("with the reason recorded", (afterBroken?.lastError ?? "").length > 0);

  const retryBroken = await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  checkTrue("and it is picked up again rather than orphaned", retryBroken.attempted > 0);

  // ── Missing address is skipped, not queued ────────────────────────────────
  const skipped = await withTenant(ctx, (tx) =>
    enqueue(tx, ctx, {
      channel: "email",
      template: "request_received",
      to: "   ",
      payload: { customerName: "x", jobReference: "y", jobTitle: "z" },
    }),
  );
  checkTrue("empty address is skipped rather than queued", "skipped" in skipped);

  // ── Retryable failure ─────────────────────────────────────────────────────
  const retryId = await queueOne("retry@example.invalid");
  await dispatchPending(TENANT, { transport: new FailingTransport(true) });
  const afterFail = await statusOf(retryId);
  check("retryable failure is marked failed", afterFail?.status, "failed");
  check("attempt counted", afterFail?.attempts, 1);
  checkTrue("error recorded", (afterFail?.lastError?.length ?? 0) > 0);

  // A failed-but-retryable row is picked up again.
  await dispatchPending(TENANT, { transport: new FailingTransport(true) });
  check("retried", (await statusOf(retryId))?.attempts, 2);

  // ...and eventually recovers if the provider does.
  await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  check("recovers once the provider does", (await statusOf(retryId))?.status, "sent");

  // ── Non-retryable failure is abandoned immediately ────────────────────────
  const hardId = await queueOne("hard@example.invalid");
  const hard = await dispatchPending(TENANT, { transport: new FailingTransport(false) });
  check("abandoned on the first attempt", hard.abandoned, 1);

  const afterHard = await statusOf(hardId);
  check("parked at the attempt ceiling", afterHard?.attempts, 5);

  // Parked rows must not be retried forever.
  const afterPark = await dispatchPending(TENANT, { transport: new ConsoleTransport() });
  check("a parked notification is not picked up again", afterPark.attempted, 0);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    await tx.delete(schema.notifications).where(inArray(schema.notifications.id, ids));
  });

  console.log(`\n${fail === 0 ? "notifications: all checks passed" : `${fail} FAILING`}`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
