/**
 * Creates and sends a demo quotation so the customer portal has something to
 * decide on. Development convenience only — not part of the seed, because a
 * quote awaiting decision is a state you want to opt into.
 */
import { eq } from "drizzle-orm";
import { withTenant, createQuote, sendQuote, schema, closeConnection } from "../src/index";
import { formatMoney } from "@meridian/core";

const T = "11111111-1111-4111-8111-111111111111";
const ctx = { tenantId: T };

(async () => {
  const job = await withTenant(ctx, async (tx) => {
    const r = await tx
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.reference, "JOB-2026-00009"));
    return r[0];
  });
  if (!job) throw new Error("Seed job JOB-2026-00009 not found. Run npm run db:seed.");

  const q = await withTenant(ctx, (tx) =>
    createQuote(tx, ctx, {
      jobId: job.id,
      title: "Booster pump replacement, Bay Tower",
      lines: [
        { description: "Booster pump, supply", quantity: "1", unit: "ea", unitPrice: "6800.00" },
        { description: "Installation and commissioning", quantity: "6", unit: "hr", unitPrice: "180.00" },
        { description: "Isolation valves and fittings", quantity: "1", unit: "set", unitPrice: "940.00" },
      ],
      discount: "500.00",
      notes:
        "The existing pump is beyond economic repair. Price includes removal and disposal of the old unit.",
    }),
  );

  await withTenant(ctx, (tx) => sendQuote(tx, q.quoteId));
  console.log(`Sent ${q.reference} — ${formatMoney(q.totalMinor)}`);
  await closeConnection();
})();
