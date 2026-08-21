/**
 * Lead capture and notification — integration test against real Postgres.
 *
 * `LEAD-2` and `LEAD-3`, closing `PD-3`. This is one of the five clauses in the
 * PRD's definition of done for Phase 1: *a new lead emails the operations
 * manager within five minutes.*
 *
 * The failure being tested for is not a crash. Before this, the lead was
 * written correctly and nobody was told — the enquiry existed and the process
 * stopped. An enquiry that arrives at 21:00 and reaches no one is revenue that
 * never existed, and every answer-engine page on the public site exists to
 * produce exactly these.
 *
 * The property that matters most is atomicity. The notification is enqueued in
 * the same transaction as the lead, so the two commit together: a notification
 * cannot promise an enquiry that rolled back, and — the direction that actually
 * bites — an enquiry cannot be recorded without an alert queued for it.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires a seeded database. Cleans up everything it creates.
 */

import postgres from "postgres";
import { sql } from "drizzle-orm";
import { db, withTenant, closeConnection } from "../src/index";
import { createLeadFromEnquiry, enquiryRecipients } from "../src/domain";
import { testTenantId } from "./_tenant";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "LEAD-NOTIFY-TEST";

/**
 * Admin connection, for fixture cleanup only.
 *
 * Deleting a `leads` row from outside a tenant context matches nothing under
 * RLS, so a cleanup written against `db` would silently remove zero rows and
 * leave test data accumulating. That refusal is correct; the test just needs a
 * connection the application does not have.
 */
const admin = postgres(
  process.env["DATABASE_ADMIN_URL"] ?? process.env["DATABASE_URL"] ?? "postgres://localhost:5432/meridian_dev",
  { max: 1 },
);

async function cleanup(): Promise<void> {
  await admin`delete from notifications where payload->>'customerName' = ${TAG}`;
  await admin`delete from leads where name = ${TAG}`;
}

async function main(): Promise<void> {
  await cleanup();

  // Resolved by slug rather than by ordering. See ./_tenant.ts.
  const slug = process.env["PUBLIC_TENANT_SLUG"] ?? "meridian";
  const tenantId = await testTenantId(slug);

  console.log("\n— routing (LEAD-3) —");

  const [routine, emergency] = await withTenant({ tenantId, actorKind: "system" }, async (tx) => [
    await enquiryRecipients(tx, false),
    await enquiryRecipients(tx, true),
  ]);

  if ((routine?.length ?? 0) === 0) {
    // A tenant with nobody to route to is a valid state — a fresh deployment
    // looks exactly like this — so say what is missing rather than reporting it
    // as a failure of the code under test.
    throw new Error(
      `Tenant "${slug}" has no active operations manager or dispatcher, so there is nothing to ` +
        `route an enquiry to. Seed the database, or invite one from /admin/users.`,
    );
  }
  checkTrue("a routine enquiry has somebody to go to", (routine?.length ?? 0) > 0);
  // LEAD-3: the difference between "somebody will pick this up" and "somebody
  // must pick this up now" has to exist in who is woken, not only in a flag.
  checkTrue(
    "an emergency reaches at least as many people",
    (emergency?.length ?? 0) >= (routine?.length ?? 0),
  );

  console.log("\n— a routine enquiry —");

  const enquiry = {
    name: TAG,
    phone: "+971 50 000 0001",
    email: "lead-test@example.invalid",
    serviceSlug: "plumbing-sanitary",
    urgency: "routine",
    propertyType: "apartment",
    city: "Dubai",
    area: "Dubai Marina",
    details: "Slow drain in the kitchen.",
  };

  let enqueued = 0;
  const created = await createLeadFromEnquiry(tenantId, enquiry, {
    onCreated: async (tx, lead) => {
      // Mirrors what the quote action does, without importing notify (which
      // imports db, so a db test importing notify would be a cycle). What is
      // being proven here is that the hook runs INSIDE the transaction and can
      // see the lead — which is the whole point of the inversion.
      const rows = (await tx.execute<{ id: string }>(sql`
        select id from leads where id = ${lead.leadId}::uuid
      `)) as unknown as { id: string }[];
      checkTrue("the hook can see the uncommitted lead", rows.length === 1);

      const to = await enquiryRecipients(tx, lead.isEmergency);
      for (const recipient of to) {
        await tx.execute(sql`
          insert into notifications (tenant_id, channel, template, recipient_user_id, recipient_address, subject_table, subject_id, payload, status)
          values (${tenantId}::uuid, 'email', 'lead_created', ${recipient.userId}::uuid, ${recipient.email},
                  'leads', ${lead.leadId}::uuid,
                  ${JSON.stringify({ customerName: TAG, leadReference: lead.reference })}::jsonb, 'queued')
        `);
        enqueued += 1;
      }
    },
  });

  checkTrue("the lead is created", Boolean(created.leadId));
  checkTrue("with a human-quotable reference", created.reference.startsWith("ENQ-"));
  check("and the recipient count is reported back", created.recipients, routine?.length ?? 0);
  check("one notification per recipient", enqueued, routine?.length ?? 0);

  const queued = (await admin<{ count: number }[]>`
    select count(*)::int as count from notifications
     where subject_id = ${created.leadId}::uuid and template = 'lead_created'
  `)[0];
  check("the notifications committed with the lead", queued?.count, routine?.length ?? 0);

  console.log("\n— atomicity —");

  // THE property. A hook that throws must take the lead with it: an enquiry
  // recorded with no alert is the exact failure this work exists to fix, so a
  // half-committed version of it must not be reachable.
  let rolledBack = false;
  try {
    await createLeadFromEnquiry(
      tenantId,
      { ...enquiry, details: "This one must not survive." },
      {
        onCreated: async () => {
          throw new Error("simulated notification failure");
        },
      },
    );
  } catch {
    rolledBack = true;
  }

  checkTrue("a failing notification hook throws", rolledBack);

  const survivors = (await admin<{ count: number }[]>`
    select count(*)::int as count from leads
     where name = ${TAG} and message = 'This one must not survive.'
  `)[0];
  check("and the lead rolled back with it", survivors?.count, 0);

  const stillOne = (await admin<{ count: number }[]>`
    select count(*)::int as count from leads where name = ${TAG}
  `)[0];
  check("leaving only the successful one", stillOne?.count, 1);

  console.log("\n— an emergency (LEAD-3) —");

  const urgent = await createLeadFromEnquiry(
    tenantId,
    { ...enquiry, urgency: "emergency", details: "Water coming through the ceiling." },
    { onCreated: async () => {} },
  );

  check("an emergency reaches the wider list", urgent.recipients, emergency?.length ?? 0);

  // An emergency needs looking at now, not on the next follow-up sweep.
  const followUp = (await admin<{ next_follow_up_at: Date }[]>`
    select next_follow_up_at from leads where id = ${urgent.leadId}::uuid
  `)[0];
  checkTrue(
    "and is due for follow-up immediately",
    followUp !== undefined && followUp.next_follow_up_at.getTime() <= Date.now() + 1000,
  );

  await cleanup();

  console.log(fail === 0 ? "\nleads: all checks passed.\n" : `\n${fail} check(s) failed.\n`);
  await admin.end({ timeout: 5 });
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("leads test failed to run:", error);
  await cleanup().catch(() => {});
  await admin.end({ timeout: 5 }).catch(() => {});
  await closeConnection();
  process.exit(1);
});
