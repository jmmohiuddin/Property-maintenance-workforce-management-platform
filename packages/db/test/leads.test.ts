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
import {
  createLeadFromEnquiry,
  convertLeadToJob,
  convertCustomerCandidates,
  enquiryRecipients,
  findDuplicateMatches,
  logCommunication,
  listCommunications,
  searchLeads,
  searchCustomers,
  listCustomers,
  customerPortfolioTotals,
  getCustomer,
  encodeCursor,
  decodeCursor,
  setLeadStage,
  setLeadFollowUp,
  leadDispositionReport,
  leadNurtureQueue,
} from "../src/domain";
import { localPhoneKey } from "@meridian/core";
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
  // `like`, not `=`. The duplicate-detection and pagination checks below create
  // leads named `${TAG}-…`, and a cleanup keyed on the exact name would leave
  // every one of them behind — where the next run would find them as duplicates
  // and report a failure that is entirely the previous run's fault.
  await admin`delete from communications where body like ${TAG + "%"}`;

  // Conversion writes a customer, a property and a job in one transaction, and
  // they have to come back out in the opposite order: both foreign keys onto
  // `customers` are ON DELETE RESTRICT, deliberately, so that an account with
  // work filed against it cannot quietly disappear. `job_events` cascades.
  //
  // Matched on the name as well as the code, because a customer created by
  // converting a lead takes its code from the lead's name — `LEADNOTI-1234`,
  // which no `TAG%` pattern would ever find.
  const mine = TAG + "%";
  await admin`delete from invoices where reference like ${mine}`;
  await admin`
    delete from jobs
     where customer_id in (select id from customers where name like ${mine} or code like ${mine})`;
  await admin`
    delete from properties
     where customer_id in (select id from customers where name like ${mine} or code like ${mine})`;
  await admin`delete from leads where name like ${mine}`;
  await admin`delete from lead_disposition_reasons where code like ${"__test_" + "%"}`;
  await admin`delete from customers where name like ${mine} or code like ${mine}`;
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


  // ═════════════════════════════════════════════════════════════════════════
  // LEAD-5 — duplicate detection
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n— duplicate detection (LEAD-5) —");

  // The emergency enquiry above reused the first one's phone AND email, which
  // is the strict tier. Nothing in that call asked for a duplicate check; it
  // happens because `createLeadFromEnquiry` runs the matcher on every insert.
  checkTrue(
    "a repeat enquiry is auto-linked to the earlier lead",
    urgent.duplicates.autoLinkLeadId === created.leadId,
  );

  const linkedRow = (await admin<{ duplicate_of_lead_id: string | null }[]>`
    select duplicate_of_lead_id from leads where id = ${urgent.leadId}::uuid
  `)[0];
  check(
    "and the pointer is written to the row, not only reported",
    linkedRow?.duplicate_of_lead_id,
    created.leadId,
  );

  // The SQL matcher and the TypeScript one must agree, because the index is
  // built on the first and the lookup value comes from the second. A
  // disagreement is a matcher that silently finds nothing.
  const phoneForms = ["+971 50 000 0001", "050 000 0001", "00971500000001", "0500000001"];
  const keys = await withTenant({ tenantId }, async (tx) => {
    const out: (string | null)[] = [];
    for (const form of phoneForms) {
      const rows = (await tx.execute<{ k: string | null }>(
        sql`select app_phone_key(${form}) as k`,
      )) as unknown as { k: string | null }[];
      out.push(rows[0]?.k ?? null);
    }
    return out;
  });
  checkTrue(
    "app_phone_key normalises every way a UAE mobile is written",
    keys.every((k) => k === keys[0] && k !== null),
  );
  checkTrue(
    "and the TypeScript mirror agrees with it",
    phoneForms.every((form) => localPhoneKey(form) === keys[0]),
  );

  const shortKey = await withTenant({ tenantId }, async (tx) => {
    const rows = (await tx.execute<{ k: string | null }>(
      sql`select app_phone_key('12345') as k`,
    )) as unknown as { k: string | null }[];
    return rows[0]?.k ?? null;
  });
  check("a fragment is not a phone key", shortKey, null);
  check("and the mirror says the same", localPhoneKey("12345"), null);

  // ── Landlines ─────────────────────────────────────────────────────────────
  //
  // The eight-digit case, which migration 0016 argues for at length and which
  // nothing above exercises. A UAE mobile has a nine-digit national number and
  // a landline has eight, so a matcher built on "the last nine digits" works
  // for one and silently fails for the other — and an owners association, the
  // customer most likely to enquire twice about the same building, answers on a
  // landline.
  const landlineForms = ["+971 4 555 0100", "04 555 0100", "0097145550100", "971 4 555 0100"];
  const landlineKeys = await withTenant({ tenantId }, async (tx) => {
    const out: (string | null)[] = [];
    for (const form of landlineForms) {
      const rows = (await tx.execute<{ k: string | null }>(
        sql`select app_phone_key(${form}) as k`,
      )) as unknown as { k: string | null }[];
      out.push(rows[0]?.k ?? null);
    }
    return out;
  });
  checkTrue(
    "app_phone_key normalises every way a UAE landline is written",
    landlineKeys.every((k) => k === "45550100"),
  );
  checkTrue(
    "and the TypeScript mirror agrees with it on landlines too",
    landlineForms.every((form) => localPhoneKey(form) === "45550100"),
  );

  // Why the function is written the way it is, stated as an assertion rather
  // than as a comment: the rule it replaced turns one landline into two keys.
  const naiveLastNine = (raw: string) => raw.replace(/\D/g, "").slice(-9);
  checkTrue(
    "where the last-nine rule would have split that landline in two",
    naiveLastNine("+971 4 555 0100") !== naiveLastNine("04 555 0100"),
  );

  const mixedKeys = await withTenant({ tenantId }, async (tx) => {
    const rows = (await tx.execute<{ landline: string | null; mobile: string | null }>(sql`
      select app_phone_key('04 555 0100') as landline,
             app_phone_key('054 555 0100') as mobile
    `)) as unknown as { landline: string | null; mobile: string | null }[];
    return rows[0];
  });
  checkTrue(
    "a landline and a mobile never collapse to the same key",
    Boolean(mixedKeys?.landline) &&
      Boolean(mixedKeys?.mobile) &&
      mixedKeys?.landline !== mixedKeys?.mobile,
  );

  // A loose match: same phone, different email. It must be reported and must
  // NOT be auto-linked — a switchboard number is shared by everybody in the
  // building, and linking on it alone merges unrelated enquiries.
  const loose = await createLeadFromEnquiry(
    tenantId,
    {
      ...enquiry,
      name: `${TAG}-LOOSE`,
      email: "someone-else@example.invalid",
      details: "Same number, different person.",
    },
    { onCreated: async () => {} },
  );

  checkTrue("a phone-only match is reported", loose.duplicates.matches.length > 0);
  check("but is not auto-linked", loose.duplicates.autoLinkLeadId, null);
  checkTrue(
    "and is not marked strict",
    loose.duplicates.matches.every((m) => !m.isStrict),
  );

  const noSignal = await withTenant({ tenantId }, (tx) =>
    findDuplicateMatches(tx, { phone: null, email: null }),
  );
  check("an enquiry with no contact details matches nothing", noSignal.matches.length, 0);

  // ═════════════════════════════════════════════════════════════════════════
  // LEAD-5 at the point of conversion
  //
  // The matcher ran on create and nowhere else, so a lead the strict tier had
  // already tied to an existing customer — pointer written, badge on the
  // screen — produced a second customer for the same person the moment
  // somebody pressed Convert. Everything below is about the one action that
  // creates a customer asking the check that already existed.
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n— converting a lead we already have (LEAD-5, LEAD-7) —");

  const convertPhone = "+971 50 777 0001";
  const convertEmail = "convert-strict@example.invalid";

  const existingCustomerId = await withTenant({ tenantId }, async (tx) => {
    const rows = (await tx.execute<{ id: string }>(sql`
      insert into customers (tenant_id, code, name, phone, billing_email)
      values (${tenantId}::uuid, ${TAG + "-CONV"}, ${TAG + " Existing Account"},
              ${convertPhone}, ${convertEmail})
      returning id
    `)) as unknown as { id: string }[];
    return rows[0]?.id ?? "";
  });

  /** How many accounts carry this number. The duplicate, counted. */
  const accountsOnThatNumber = async (): Promise<number> =>
    (
      await admin<{ count: number }[]>`
        select count(*)::int as count from customers
         where tenant_id = ${tenantId}::uuid
           and app_phone_key(phone) = app_phone_key(${convertPhone})
      `
    )[0]?.count ?? 0;

  check("the fixture starts as one account", await accountsOnThatNumber(), 1);

  const strictLead = await createLeadFromEnquiry(
    tenantId,
    {
      ...enquiry,
      name: `${TAG}-CONV-STRICT`,
      phone: convertPhone,
      email: convertEmail,
      details: "Same phone and same email as an account we already have.",
    },
    { onCreated: async () => {} },
  );

  check(
    "the strict tier ties the enquiry to that account on arrival",
    strictLead.duplicates.autoLinkCustomerId,
    existingCustomerId,
  );

  // A silent duplicate and a silent reuse are the same mistake in opposite
  // directions, so conversion does neither: it refuses until a person has said
  // which account the work belongs to.
  let refusedConvert = false;
  try {
    await withTenant({ tenantId, actorKind: "user" }, (tx) =>
      convertLeadToJob(
        tx,
        { tenantId },
        {
          leadId: strictLead.leadId,
          propertyName: `${TAG} Tower`,
          addressLine: "1 Test Street, Dubai Marina",
          priority: "p3_standard",
          title: `${TAG} convert with no answer`,
        },
      ),
    );
  } catch {
    refusedConvert = true;
  }

  checkTrue("converting it without an answer is refused", refusedConvert);
  check("and no second account was created", await accountsOnThatNumber(), 1);

  const reused = await withTenant({ tenantId, actorKind: "user" }, (tx) =>
    convertLeadToJob(
      tx,
      { tenantId },
      {
        leadId: strictLead.leadId,
        customerId: existingCustomerId,
        propertyName: `${TAG} Tower`,
        addressLine: "1 Test Street, Dubai Marina",
        priority: "p3_standard",
        title: `${TAG} converted onto the existing account`,
      },
    ),
  );

  check("answering with the matched account reuses it", reused.customerId, existingCustomerId);
  // Reported, not inferred. The caller has to be able to say on screen which
  // account the job went to, and "created" and "reused" look identical from an
  // id alone.
  check("and reports that nothing new was created", reused.customerCreated, false);
  check("so there is still one account on that number", await accountsOnThatNumber(), 1);

  const convertedRow = (
    await admin<{ customer_id: string; converted_customer_id: string | null }[]>`
      select j.customer_id, l.converted_customer_id
        from jobs j
        join leads l on l.id = ${strictLead.leadId}::uuid
       where j.id = ${reused.jobId}::uuid
    `
  )[0];
  check("the job is filed under it", convertedRow?.customer_id, existingCustomerId);
  check("and so is the lead", convertedRow?.converted_customer_id, existingCustomerId);

  // ── The loose tier, which suggests and nothing more ──────────────────────
  //
  // Same switchboard number, a different person on it. Blocking this would
  // cost somebody the job; auto-linking it would file their work under a
  // stranger's account.
  const looseConvert = await createLeadFromEnquiry(
    tenantId,
    {
      ...enquiry,
      name: `${TAG}-CONV-LOOSE`,
      phone: convertPhone,
      email: "someone-else-entirely@example.invalid",
      details: "Same switchboard, different person.",
    },
    { onCreated: async () => {} },
  );

  check("a phone-only match is not auto-linked", looseConvert.duplicates.autoLinkCustomerId, null);

  const looseCandidates = await withTenant({ tenantId }, (tx) =>
    convertCustomerCandidates(tx, looseConvert.leadId),
  );
  checkTrue(
    "the account is still offered to the operator",
    looseCandidates.some((c) => c.customerId === existingCustomerId),
  );
  checkTrue(
    "but nothing about it blocks the conversion",
    looseCandidates.every((c) => !c.isStrict && !c.isLinked),
  );

  const looseResult = await withTenant({ tenantId, actorKind: "user" }, (tx) =>
    convertLeadToJob(
      tx,
      { tenantId },
      {
        leadId: looseConvert.leadId,
        propertyName: `${TAG} Tower B`,
        addressLine: "2 Test Street, Dubai Marina",
        priority: "p3_standard",
        title: `${TAG} converted from a loose match`,
      },
    ),
  );

  check("so a loose match converts into a new customer", looseResult.customerCreated, true);
  checkTrue("which is not the matched account", looseResult.customerId !== existingCustomerId);
  check("leaving two accounts on that number, by decision", await accountsOnThatNumber(), 2);

  // ── And the ordinary case, unchanged ─────────────────────────────────────
  const freshLead = await createLeadFromEnquiry(
    tenantId,
    {
      ...enquiry,
      name: `${TAG}-CONV-NEW`,
      phone: "+971 50 777 0009",
      email: "convert-fresh@example.invalid",
      details: "Nobody we have ever heard from.",
    },
    { onCreated: async () => {} },
  );

  const freshCandidates = await withTenant({ tenantId }, (tx) =>
    convertCustomerCandidates(tx, freshLead.leadId),
  );
  check("an enquiry matching nothing offers no account", freshCandidates.length, 0);

  const freshResult = await withTenant({ tenantId, actorKind: "user" }, (tx) =>
    convertLeadToJob(
      tx,
      { tenantId },
      {
        leadId: freshLead.leadId,
        propertyName: `${TAG} Villa`,
        addressLine: "3 Test Street, Jumeirah",
        priority: "p3_standard",
        title: `${TAG} converted with no match at all`,
      },
    ),
  );

  check("and converts by creating one, as it always did", freshResult.customerCreated, true);
  checkTrue("with the customer named after the enquiry", freshResult.customerName === `${TAG}-CONV-NEW`);

  // ═════════════════════════════════════════════════════════════════════════
  // LEAD-9 — the communications log
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n— communications log (LEAD-9) —");

  const before = (await admin<{ last_interaction_at: Date }[]>`
    select last_interaction_at from leads where id = ${created.leadId}::uuid
  `)[0];

  await withTenant({ tenantId }, (tx) =>
    logCommunication(
      tx,
      { tenantId },
      {
        leadId: created.leadId,
        channel: "call",
        body: `${TAG} called, no answer, trying again`,
        outcome: "no_answer",
      },
    ),
  );

  const after = (await admin<{ last_interaction_at: Date; next_follow_up_at: Date | null }[]>`
    select last_interaction_at, next_follow_up_at from leads where id = ${created.leadId}::uuid
  `)[0];

  checkTrue(
    "logging a call winds the nurture clock",
    Boolean(before && after && after.last_interaction_at.getTime() > before.last_interaction_at.getTime()),
  );
  // `no_answer` is worth one day, from FOLLOW_UP_DAYS_FOR_OUTCOME. The point is
  // not the number but that the operator did not have to supply one: a call
  // logged with no next step is a lead dropped by accident.
  checkTrue(
    "and sets a follow-up from the outcome without being asked",
    Boolean(after?.next_follow_up_at && after.next_follow_up_at.getTime() > Date.now()),
  );

  const log = await withTenant({ tenantId }, (tx) =>
    listCommunications(tx, { leadId: created.leadId }),
  );
  check("the log reads back", log.length, 1);
  check("with its outcome", log[0]?.outcome, "no_answer");

  // The duplicate carries the original's history. That is what makes linking
  // worth anything: the second enquiry arrives knowing what was said the first
  // time.
  const inherited = await withTenant({ tenantId }, (tx) =>
    listCommunications(tx, { leadId: urgent.leadId }),
  );
  check("and a linked duplicate inherits it", inherited.length, 1);

  let refusedEmpty = false;
  try {
    await withTenant({ tenantId }, (tx) =>
      logCommunication(tx, { tenantId }, { leadId: created.leadId, channel: "call", body: "   " }),
    );
  } catch {
    refusedEmpty = true;
  }
  checkTrue("an empty sentence is refused", refusedEmpty);

  // ═════════════════════════════════════════════════════════════════════════
  // LEAD-8 — search and keyset pagination
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n— search and pagination (LEAD-8) —");

  // Six more leads, so paging has something to page.
  const pageLeadIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    pageLeadIds.push(
      (await createLeadFromEnquiry(
        tenantId,
        {
          ...enquiry,
          name: `${TAG}-PAGE-${i}`,
          phone: `+9715099900${i}0`,
          email: `page-${i}@example.invalid`,
        },
        { onCreated: async () => {} },
      )).leadId,
    );
  }

  const roundTrip = decodeCursor(
    encodeCursor({ createdAt: new Date("2026-03-04T05:06:07.000Z"), id: created.leadId }),
  );
  checkTrue(
    "a cursor survives the round trip",
    roundTrip?.id === created.leadId &&
      roundTrip?.createdAt.toISOString() === "2026-03-04T05:06:07.000Z",
  );
  // Stale, bookmarked and hostile cursors all take the same path: the first
  // page, not a 500.
  check("a malformed cursor decodes to null", decodeCursor("not-a-cursor"), null);
  check("and so does an empty one", decodeCursor(""), null);

  const pages = await withTenant({ tenantId }, async (tx) => {
    const collected: string[] = [];
    let cursor: string | undefined;
    let guard = 0;

    do {
      const page = await searchLeads(tx, { q: TAG, limit: 3, cursor });
      collected.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor && ++guard < 20);

    return collected;
  });

  checkTrue("paging returns every matching lead", pages.length >= 9);
  check("and never the same row twice", new Set(pages).size, pages.length);

  const byPhone = await withTenant({ tenantId }, (tx) =>
    // Written the national way; stored the international way. This is the
    // search that used to return nothing.
    searchLeads(tx, { q: "050 000 0001", limit: 10 }),
  );
  checkTrue("searching a phone number in a different format finds it", byPhone.rows.length > 0);

  const byEmail = await withTenant({ tenantId }, (tx) =>
    searchLeads(tx, { q: "LEAD-TEST@EXAMPLE.INVALID", limit: 10 }),
  );
  checkTrue("searching an email ignores case", byEmail.rows.length > 0);

  // The same box over the customer list. `LEAD-8` names both, and the value is
  // that they behave identically — somebody who learns that a phone number
  // works on one screen must not find it silently failing on the other.
  const customerId = await withTenant({ tenantId }, async (tx) => {
    const rows = (await tx.execute<{ id: string }>(sql`
      insert into customers (tenant_id, code, name, phone, billing_email)
      values (${tenantId}::uuid, ${TAG + "-C"}, ${TAG + " Search Target"},
              '+971 4 555 0100', 'search-target@example.invalid')
      returning id
    `)) as unknown as { id: string }[];
    return rows[0]?.id ?? "";
  });

  const customerByName = await withTenant({ tenantId }, (tx) =>
    searchCustomers(tx, { q: "Search Target", limit: 10 }),
  );
  checkTrue(
    "customers are searchable by a fragment of the name",
    customerByName.rows.some((c) => c.id === customerId),
  );

  const customerByPhone = await withTenant({ tenantId }, (tx) =>
    searchCustomers(tx, { q: "04 555 0100", limit: 10 }),
  );
  checkTrue(
    "and by a phone number written another way",
    customerByPhone.rows.some((c) => c.id === customerId),
  );

  const customerPaged = await withTenant({ tenantId }, (tx) =>
    searchCustomers(tx, { limit: 1 }),
  );
  check("the customer list pages one at a time when asked", customerPaged.rows.length, 1);
  checkTrue("and offers a cursor for the next page", customerPaged.nextCursor !== null);

  // ── The paged query against the one it replaces (TD-10) ──────────────────
  //
  // `listCustomers` reads every customer and every unpaid invoice and adds the
  // balances up in JavaScript, which is the unbounded read that had to go. The
  // paged query does the same arithmetic in SQL, so the only thing worth
  // asserting is that it gets the same answer — a faster screen showing a
  // different number to the ledger would be a worse outcome than the slow one.
  //
  // Both are given the same `now`, because "overdue" is a comparison against it
  // and two clock readings a millisecond apart can disagree about an invoice.
  // Money to add up. Without it both sides of the comparison below are zero,
  // and two queries that agree on nothing prove nothing. One invoice past its
  // due date and one not yet due, against the account created above: 1,000.00
  // with 250.00 paid, and 500.00 outstanding in full.
  await admin`
    insert into invoices (tenant_id, reference, customer_id, status, issued_on, due_on, subtotal, total, amount_paid)
    values (${tenantId}::uuid, ${TAG + "-INV-OVERDUE"}, ${existingCustomerId}::uuid, 'issued',
            now() - interval '35 days', now() - interval '5 days', 1000.00, 1000.00, 250.00),
           (${tenantId}::uuid, ${TAG + "-INV-CURRENT"}, ${existingCustomerId}::uuid, 'issued',
            now() - interval '2 days', now() + interval '10 days', 500.00, 500.00, 0)`;

  const asOf = new Date();
  const [legacy, totals] = await withTenant({ tenantId }, async (tx) => [
    await listCustomers(tx, { now: asOf }),
    await customerPortfolioTotals(tx, { now: asOf }),
  ]);

  check("the portfolio total counts the same accounts", totals?.customerCount, legacy?.length);
  check(
    "and owes the same money",
    totals?.outstandingMinor,
    (legacy ?? []).reduce((sum, c) => sum + c.outstandingMinor, 0),
  );
  check(
    "and is overdue by the same amount",
    totals?.overdueMinor,
    (legacy ?? []).reduce((sum, c) => sum + c.overdueMinor, 0),
  );
  check(
    "with the right number of accounts behind that figure",
    totals?.overdueCount,
    (legacy ?? []).filter((c) => c.overdueMinor > 0).length,
  );

  // Per row, the same check. `sum()` in Postgres returns a string through this
  // driver, so a missing `Number()` here would be silent string concatenation
  // on the screen rather than an error anywhere.
  const legacyById = new Map((legacy ?? []).map((c) => [c.id, c]));
  const pagedRows = await withTenant({ tenantId }, (tx) =>
    searchCustomers(tx, { limit: 100, now: asOf }),
  );

  // The detail screen against the list row, for the same account (TD-10).
  //
  // `getCustomer` used to read every customer in the tenant and `.find()` one of
  // them, so its figures agreed with the list by construction. It now runs its
  // own single-row query, which means "they agree" has stopped being a tautology
  // and started being a claim — so it is asserted rather than assumed.
  const detail = await withTenant({ tenantId }, (tx) =>
    getCustomer(tx, existingCustomerId, asOf),
  );
  const listRow = legacyById.get(existingCustomerId);
  check("the detail screen agrees with the list on what is outstanding",
    detail?.customer.outstandingMinor, listRow?.outstandingMinor);
  check("and on what is overdue", detail?.customer.overdueMinor, listRow?.overdueMinor);
  check("and on open jobs", detail?.customer.openJobs, listRow?.openJobs);
  check("and on properties", detail?.customer.propertyCount, listRow?.propertyCount);
  check("and still carries the columns only it selects", detail?.customer.code, listRow?.code);
  checkTrue("with a real created date rather than a string", detail?.customer.createdAt instanceof Date);

  const withInvoices = pagedRows.rows.find((r) => r.id === existingCustomerId);
  // 1,000.00 less 250.00 paid, plus 500.00 untouched. Stated as the number
  // rather than as an agreement between two queries, because both of them
  // reading the same column wrongly would still agree.
  check("the balance on a row is the sum of what is unpaid", withInvoices?.outstandingMinor, 125_000);
  check("and only the part past its due date is overdue", withInvoices?.overdueMinor, 75_000);

  checkTrue(
    "every paged row carries the same balances as the unpaged one",
    pagedRows.rows.every((r) => {
      const was = legacyById.get(r.id);
      return (
        was === undefined ||
        (r.outstandingMinor === was.outstandingMinor &&
          r.overdueMinor === was.overdueMinor &&
          r.openJobs === was.openJobs &&
          r.propertyCount === was.propertyCount)
      );
    }),
  );

  // ═════════════════════════════════════════════════════════════════════════
  // The disposition report (LEAD-6, LEAD-9)
  // ═════════════════════════════════════════════════════════════════════════

  console.log("\n— disposition reporting —");

  const reasonId = await withTenant({ tenantId }, async (tx) => {
    const rows = (await tx.execute<{ id: string }>(sql`
      insert into lead_disposition_reasons (tenant_id, code, label, applies_to, sort_order)
      values (${tenantId}::uuid, '__test_price', 'Too expensive', 'lost', 10)
      returning id
    `)) as unknown as { id: string }[];
    return rows[0]?.id ?? "";
  });

  let refusedFreeText = false;
  try {
    await withTenant({ tenantId }, (tx) => setLeadStage(tx, loose.leadId, "lost"));
  } catch {
    refusedFreeText = true;
  }
  checkTrue("closing a lead with no coded reason is refused", refusedFreeText);

  await withTenant({ tenantId }, (tx) =>
    setLeadStage(tx, loose.leadId, "lost", { dispositionReasonId: reasonId, note: "Went elsewhere" }),
  );

  const report = await withTenant({ tenantId }, (tx) => leadDispositionReport(tx, { days: 1 }));
  const priceRow = report.lostReasons.find((r) => r.code === "__test_price");
  checkTrue("the reason appears in the report", Boolean(priceRow));
  check("with the lead counted against it", priceRow?.leads, 1);
  check("no closure is missing its reason", report.unreasoned, 0);

  // Both nurture buckets, set up explicitly. Every lead created above arrives
  // with a follow-up 24 hours out, so with no arrangement the queue is
  // correctly empty — and an assertion that passed against that would be
  // asserting nothing.
  const overdueLead = pageLeadIds[0];
  const coldLead = pageLeadIds[1];
  if (overdueLead && coldLead) {
    await withTenant({ tenantId }, async (tx) => {
      // A promise made and not kept.
      await setLeadFollowUp(tx, overdueLead, new Date(Date.now() - 3 * 86_400_000));
      // And the worse case: no promise at all, so nothing is ever overdue and
      // the lead is invisible to every report that looks for a missed date.
      await setLeadFollowUp(tx, coldLead, null);
    });
  }

  const queue = await withTenant({ tenantId }, (tx) =>
    // `now` a minute ahead so a lead whose last interaction is *this instant*
    // is already past a zero-day threshold. Otherwise the comparison is
    // `now < now`, which is false, and the check would depend on how long the
    // preceding statements took.
    leadNurtureQueue(tx, { coldAfterDays: 0, now: new Date(Date.now() + 60_000) }),
  );

  checkTrue(
    "the nurture queue finds a lead whose follow-up date has passed",
    queue.overdue.some((l) => l.id === overdueLead),
  );
  checkTrue(
    "and one going cold with no follow-up set at all",
    queue.goingCold.some((l) => l.id === coldLead),
  );
  checkTrue(
    "and never lists a lead already linked as a duplicate",
    [...queue.goingCold, ...queue.overdue].every((l) => l.id !== urgent.leadId),
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
