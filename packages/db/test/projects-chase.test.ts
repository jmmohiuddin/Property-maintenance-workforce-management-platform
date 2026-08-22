/**
 * The projects chase sweep (`PRJ-5`, `PRJ-6`, `PRJ-9`) — integration test
 * against real Postgres.
 *
 *   npx tsx test/projects-chase.test.ts
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * `projects.test.ts` proves the state is produced correctly: the retention
 * split to the fil, the two due dates, the engagement defaulting to `pending`.
 * This file proves the state is *read back* by something that can tell a person
 * about it, which until now nothing did. Four things, and each one is a way the
 * sweep could look like it works while being useless:
 *
 * **The window.** Retention with a due date inside the chase window comes back;
 * retention with no due date at all does not. A claim whose practical
 * completion has not happened yet has nothing to chase and putting it on the
 * list would train the reader to ignore the list.
 *
 * **The `int4` trap, with a real number.** The fixture withholds AED 25,000,000
 * per release stage — 2,500,000,000 fils, comfortably past `int4`'s
 * 2,147,483,647. A `::int` anywhere in the read path fails on that row rather
 * than on a portfolio nobody has yet. Anything below the overflow point passes
 * against a bug, which is worse than not testing it.
 *
 * **The Law No. 7 line.** An engagement still `pending` whose `starts_on` has
 * passed is reported as already started, an `approved` one is not reported at
 * all, and a `refused` one is — it is the state with no defence, and filtering
 * it out would mean the worst case is the silent one.
 *
 * **Suppression.** Marking a row reminded must actually stop the next sweep
 * picking it up, or the daily job emails the same digest every day and becomes
 * a filter rule.
 *
 * ── WHY EVERY ASSERTION IS ANCHORED TO `TAG` ────────────────────────────────
 *
 * Same rule as `projects.test.ts`. A seeded database has retention, permits and
 * engagements of its own, and other agents are working against this same dev
 * Postgres. Every list read below is filtered to rows this file created, and
 * every cleanup DELETE names the project ids it holds or matches `TAG`.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  addMilestone,
  createProject,
  engageSubcontractor,
  listExpiringPermits,
  listRetention,
  listUnapprovedSubcontracts,
  markMilestoneReached,
  markPermitsReminded,
  markRetentionReminded,
  markSubcontractsReminded,
  needsChasing,
  raiseMilestoneInvoice,
  recordPermit,
  transitionProject,
} from "../src/domain";
import { dubaiDateKey, toMinor } from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const TAG = "PRJCHASE-TEST";
const DAY = 24 * 60 * 60 * 1000;

const day = (offsetMs: number) => dubaiDateKey(new Date(Date.now() + offsetMs));

/** `int4`'s ceiling, in fils. The number this test exists to walk past. */
const INT4_MAX = 2_147_483_647;

/** The chase window the cron route uses for retention. */
const RETENTION_WINDOW_DAYS = 45;
/** And for permits. */
const PERMIT_WINDOW_DAYS = 30;
/** And the per-row suppression window, in hours. */
const SUPPRESSION_HOURS = 20;

async function main(): Promise<void> {
  // ── Part 1: the suppression predicate, with no database at all ────────────
  console.log("\n— the suppression predicate —");

  const now = new Date("2026-08-22T07:15:00Z");
  checkTrue("a row nobody has ever chased is always due", needsChasing(null, SUPPRESSION_HOURS, now));
  check(
    "a row chased an hour ago is not",
    needsChasing(new Date(now.getTime() - 60 * 60 * 1000), SUPPRESSION_HOURS, now),
    false,
  );
  checkTrue(
    "a row chased yesterday morning is due again",
    needsChasing(new Date(now.getTime() - 25 * 60 * 60 * 1000), SUPPRESSION_HOURS, now),
  );

  // Resolved by slug, not by taking whichever tenant sorts first. See
  // ./_tenant.ts — the tenant that sorts first is the deliberately-empty one.
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  let completedProjectId = "";
  let openProjectId = "";
  const invoiceIds: string[] = [];
  const subcontractorIds: string[] = [];

  try {
    await withTenant(ctx, async (tx) => {
      // ── Fixtures ───────────────────────────────────────────────────────
      const targets = (await tx.execute<{ property_id: string; customer_id: string }>(sql`
        select p.id as property_id, p.customer_id
          from properties p
          join customers c on c.id = p.customer_id
         where p.deleted_at is null and c.deleted_at is null
         order by p.created_at
         limit 1
      `)) as unknown as { property_id: string; customer_id: string }[];

      const target = targets[0];
      if (!target) {
        throw new Error("Need at least one customer with a property. Run `npm run db:seed`.");
      }

      // ── PRJ-5: retention that is chaseable, and retention that is not ───
      console.log("\n— PRJ-5: what belongs on the chase list —");

      // AED 1,000,000,000 at 5% withholds AED 50,000,000, split into two
      // release stages of AED 25,000,000 each — 2,500,000,000 fils per row.
      // Deliberately absurd for a fit-out, and deliberately past `int4`: this
      // is the fixture that fails if anything in the read path casts a
      // minor-unit amount to `::int`.
      const completed = await createProject(tx, ctx, {
        customerId: target.customer_id,
        propertyId: target.property_id,
        name: `${TAG} tower handover, retention due`,
        contractValue: "1000000000.00",
        startsOn: day(-200 * DAY),
        retentionBasisPoints: 500,
        defectsLiabilityDays: 365,
      });
      completedProjectId = completed.projectId;

      const milestone = await addMilestone(tx, ctx, {
        projectId: completedProjectId,
        name: "Final account",
        value: "1000000000.00",
        triggerKind: "client_sign_off",
      });
      await markMilestoneReached(tx, ctx, { milestoneId: milestone.milestoneId });
      const raised = await raiseMilestoneInvoice(tx, ctx, {
        milestoneId: milestone.milestoneId,
      });
      invoiceIds.push(raised.invoiceId);

      // A second project, invoiced but never completed. Its retention rows have
      // no due date — practical completion is what fixes the clock — and they
      // must not appear on a chase list. This is the check that stops the sweep
      // asking an accountant to claim money that is not owed yet.
      const open = await createProject(tx, ctx, {
        customerId: target.customer_id,
        propertyId: target.property_id,
        name: `${TAG} fit-out still running, retention held`,
        contractValue: "480000.00",
        startsOn: day(-30 * DAY),
        retentionBasisPoints: 500,
      });
      openProjectId = open.projectId;

      const openMilestone = await addMilestone(tx, ctx, {
        projectId: openProjectId,
        name: "Mobilisation, 30%",
        value: "144000.00",
        triggerKind: "client_sign_off",
      });
      await markMilestoneReached(tx, ctx, { milestoneId: openMilestone.milestoneId });
      const openRaised = await raiseMilestoneInvoice(tx, ctx, {
        milestoneId: openMilestone.milestoneId,
      });
      invoiceIds.push(openRaised.invoiceId);

      // Straight through the status machine. No required permits exist on this
      // project yet, so the `PRJ-6` gate has nothing to refuse, and no snags
      // exist, so the `PRJ-7` gate has nothing to refuse either. The permits
      // that this file cares about are added afterwards, below.
      await transitionProject(tx, ctx, { projectId: completedProjectId, to: "awarded" });
      await transitionProject(tx, ctx, { projectId: completedProjectId, to: "mobilising" });
      await transitionProject(tx, ctx, { projectId: completedProjectId, to: "on_site" });
      const handover = await transitionProject(tx, ctx, {
        projectId: completedProjectId,
        to: "practical_completion",
        practicalCompletionOn: day(0),
      });
      check("practical completion dates both retention rows", handover.retentionDated, 2);

      const chaseable = (await listRetention(tx, { dueWithinDays: RETENTION_WINDOW_DAYS })).filter(
        (r) => r.projectName.startsWith(TAG),
      );

      check(
        "one retention row is inside the chase window, not two and not four",
        chaseable.length,
        1,
      );

      const claim = chaseable[0];
      check(
        "and it is the practical-completion half, the one that fell due today",
        claim?.stage,
        "practical_completion",
      );
      check("due today", claim?.daysToDue, 0);
      check("with the invoice it was withheld from named", claim?.invoiceReference, raised.reference);

      // The whole point of the fixture. AED 25,000,000 is 2,500,000,000 fils.
      check(
        "the amount survives as minor units past int4",
        claim?.amountMinor,
        toMinor("25000000.00"),
      );
      checkTrue(
        "which is genuinely past the int4 ceiling this would have overflowed at",
        (claim?.amountMinor ?? 0) > INT4_MAX,
      );

      // The defects-liability half is dated 365 days out and is correctly
      // outside a 45-day window; the open project's two rows have no due date
      // at all. Both absences are asserted by name rather than by the count
      // above, because a count of one can be right for the wrong reason.
      const everything = (await listRetention(tx, {})).filter((r) =>
        r.projectName.startsWith(TAG),
      );
      check("the tagged projects hold four retention rows in total", everything.length, 4);
      check(
        "two of which have no due date, because they were never completed",
        everything.filter((r) => r.dueOn === null).length,
        2,
      );
      checkTrue(
        "and none of the undated ones reached the chase list",
        !chaseable.some((r) => r.dueOn === null),
      );

      // ── PRJ-5: marking, and the suppression it buys ─────────────────────
      console.log("\n— PRJ-5: a claim that has been chased is not chased again today —");

      if (!claim) throw new Error("no chaseable retention row — the fixture did not take");

      checkTrue("a claim nobody has chased is due a chase", needsChasing(claim.lastRemindedAt, SUPPRESSION_HOURS));
      check("marking it reminded reports one row", await markRetentionReminded(tx, [claim.id]), 1);
      check("and marking nothing is not an error", await markRetentionReminded(tx, []), 0);

      const afterMark = (await listRetention(tx, { dueWithinDays: RETENTION_WINDOW_DAYS })).filter(
        (r) => r.projectName.startsWith(TAG),
      );
      const marked = afterMark[0];
      checkTrue("the timestamp is stamped on the row", marked?.lastRemindedAt !== null);
      check(
        "so the next sweep the same morning passes over it",
        needsChasing(marked?.lastRemindedAt ?? null, SUPPRESSION_HOURS),
        false,
      );

      // ── PRJ-9: the Law No. 7 of 2025 line ───────────────────────────────
      console.log("\n— PRJ-9: engagements without the employer's prior approval —");

      // `PRJ-9` is an ENGAGEMENT against `HR-19`'s register, not a second
      // register. The organisations are inserted into that table rather than
      // read from it, because the seed does not yet write one; removed again in
      // cleanup.
      const subNames = [
        `${TAG} MEP Contracting LLC`,
        `${TAG} Joinery Works LLC`,
        `${TAG} Facade Specialists LLC`,
      ];
      for (const name of subNames) {
        const rows = (await tx.execute<{ id: string }>(sql`
          insert into subcontractors (tenant_id, name, kind, status)
          values (${tenantId}::uuid, ${name}, 'subcontractor', 'approved')
          returning id
        `)) as unknown as { id: string }[];
        const id = rows[0]?.id;
        if (!id) throw new Error(`could not create the subcontractor fixture ${name}`);
        subcontractorIds.push(id);
      }

      const [pendingSubId, approvedSubId, refusedSubId] = subcontractorIds;
      if (!pendingSubId || !approvedSubId || !refusedSubId) {
        throw new Error("subcontractor fixtures did not take");
      }

      // Pending, and it started ten days ago. This is the row the sweep exists
      // for: the approval cannot be prior any more.
      const started = await engageSubcontractor(tx, ctx, {
        projectId: completedProjectId,
        subcontractorId: pendingSubId,
        scope: `${TAG} MEP first and second fix`,
        value: "180000.00",
        startsOn: day(-10 * DAY),
      });

      // Approved. Nothing to chase, and it must not be on the list at all.
      await engageSubcontractor(tx, ctx, {
        projectId: completedProjectId,
        subcontractorId: approvedSubId,
        scope: `${TAG} joinery package`,
        value: "95000.00",
        clientApprovalState: "approved",
        clientApprovedOn: day(-40 * DAY),
        clientApprovalReference: `${TAG}-APPROVAL-1`,
        startsOn: day(-30 * DAY),
      });

      // Refused, and still on the project. Rarer and strictly worse.
      await engageSubcontractor(tx, ctx, {
        projectId: completedProjectId,
        subcontractorId: refusedSubId,
        scope: `${TAG} facade cladding`,
        value: "260000.00",
        clientApprovalState: "refused",
        startsOn: day(20 * DAY),
      });

      const unapproved = (await listUnapprovedSubcontracts(tx, {})).filter((s) =>
        s.projectName.startsWith(TAG),
      );

      check("two engagements need chasing, not three", unapproved.length, 2);
      checkTrue(
        "the approved one is not on the list",
        !unapproved.some((s) => s.subcontractorName.includes("Joinery")),
      );

      const late = unapproved.find((s) => s.id === started.subcontractId);
      checkTrue("the pending engagement is reported", late !== undefined);
      checkTrue(
        "and reported as already past the Law No. 7 line, because its start date has gone",
        late?.alreadyStarted === true,
      );
      check("ten days past it", late?.daysSinceStart, 10);
      check("with its committed value intact as minor units", late?.valueMinor, toMinor("180000.00"));
      check("and the project it is on", late?.projectReference, completed.reference);

      const refusedRow = unapproved.find((s) => s.approvalState === "refused");
      checkTrue("the refused engagement is reported too", refusedRow !== undefined);
      check(
        "but not as already started — its start date is three weeks out",
        refusedRow?.alreadyStarted,
        false,
      );

      // ── PRJ-9: marking, ordering, and suppression ───────────────────────
      console.log("\n— PRJ-9: chased once, not chased again today —");

      check(
        "marking the late engagement reports one row",
        await markSubcontractsReminded(tx, [started.subcontractId]),
        1,
      );
      check("and marking nothing is not an error", await markSubcontractsReminded(tx, []), 0);

      const afterSubMark = (
        await listUnapprovedSubcontracts(tx, { notRemindedWithinHours: SUPPRESSION_HOURS })
      ).filter((s) => s.projectName.startsWith(TAG));

      check("the next sweep sees only the one nobody has asked about", afterSubMark.length, 1);
      check(
        "and it is the refused one, not the one just chased",
        afterSubMark[0]?.approvalState,
        "refused",
      );

      // Least-recently-chased first, NULLs first — the order the new index
      // exists to serve. With the window lifted both come back, and the one
      // never chased must lead.
      const ordered = (await listUnapprovedSubcontracts(tx, {})).filter((s) =>
        s.projectName.startsWith(TAG),
      );
      check("with no window, both come back", ordered.length, 2);
      check(
        "least-recently-chased first, so the never-asked one leads",
        ordered[0]?.lastRemindedAt,
        null,
      );

      // ── PRJ-6: permits about to lapse ───────────────────────────────────
      console.log("\n— PRJ-6: a required permit about to lapse —");

      // Added after practical completion deliberately: adding an unapproved
      // required permit before `on_site` would have been refused by the gate,
      // and that gate is `projects.test.ts`'s subject, not this file's.
      const lapsing = await recordPermit(tx, ctx, {
        projectId: completedProjectId,
        authorityCode: "dcd",
        permitType: `${TAG} fire and life safety approval`,
        isRequired: true,
        status: "approved",
        approvedOn: day(-300 * DAY),
        expiresOn: day(10 * DAY),
        referenceNumber: `${TAG}-DCD-1`,
      });
      // Well outside the window.
      await recordPermit(tx, ctx, {
        projectId: completedProjectId,
        authorityCode: "dcd",
        permitType: `${TAG} annual fire alarm certificate`,
        isRequired: true,
        status: "approved",
        approvedOn: day(-30 * DAY),
        expiresOn: day(200 * DAY),
      });
      // Inside the window, and not required. It blocks nothing, so chasing it
      // would be an item with no consequence on a list read for consequences.
      await recordPermit(tx, ctx, {
        projectId: completedProjectId,
        authorityCode: "building_management",
        permitType: `${TAG} lift booking`,
        isRequired: false,
        status: "approved",
        approvedOn: day(-2 * DAY),
        expiresOn: day(5 * DAY),
      });

      const expiring = (
        await listExpiringPermits(tx, { withinDays: PERMIT_WINDOW_DAYS })
      ).filter((q) => q.permitType.startsWith(TAG));

      check("one permit is inside the 30-day window", expiring.length, 1);
      check("and it is the one lapsing in ten days", expiring[0]?.id, lapsing.permitId);
      check("counted as ten days remaining", expiring[0]?.daysRemaining, 10);
      checkTrue(
        "the one expiring in 200 days is not on the list",
        !expiring.some((q) => q.permitType.includes("annual fire alarm")),
      );
      checkTrue(
        "nor the optional one, which blocks nothing",
        !expiring.some((q) => q.permitType.includes("lift booking")),
      );

      check("marking it reminded reports one row", await markPermitsReminded(tx, [lapsing.permitId]), 1);
      check("and marking nothing is not an error", await markPermitsReminded(tx, []), 0);

      const afterPermitMark = (
        await listExpiringPermits(tx, {
          withinDays: PERMIT_WINDOW_DAYS,
          notRemindedWithinHours: SUPPRESSION_HOURS,
        })
      ).filter((q) => q.permitType.startsWith(TAG));
      check("and the next sweep the same morning passes over it", afterPermitMark.length, 0);
    });

    // ── Cross-tenant isolation ─────────────────────────────────────────────
    //
    // Not a WHERE clause. `withTenant` sets `app.tenant_id` and Postgres does
    // the rest. A chase sweep runs per tenant in a loop, so a read that leaked
    // would put one client's retention in another client's email.
    console.log("\n— tenant isolation —");
    const other = await otherTenantId();
    await withTenant({ tenantId: other, actorKind: "system" }, async (tx) => {
      const seenRetention = (await listRetention(tx, { dueWithinDays: RETENTION_WINDOW_DAYS })).filter(
        (r) => r.projectName.startsWith(TAG),
      );
      check("the other tenant sees none of this retention", seenRetention.length, 0);

      const seenSubs = (await listUnapprovedSubcontracts(tx, {})).filter((s) =>
        s.projectName.startsWith(TAG),
      );
      check("nor any of the unapproved engagements", seenSubs.length, 0);

      const seenPermits = (await listExpiringPermits(tx, { withinDays: PERMIT_WINDOW_DAYS })).filter(
        (q) => q.permitType.startsWith(TAG),
      );
      check("nor the lapsing permit", seenPermits.length, 0);
    });
  } finally {
    // ── Cleanup, anchored to TAG ───────────────────────────────────────────
    //
    // Order matters for exactly one reason: `project_retention.invoice_id` is
    // ON DELETE RESTRICT, so the retention rows go before the invoices they
    // claim against. Permits, engagements and costs cascade from `projects`;
    // the `subcontractors` rows reference the engagements with ON DELETE
    // RESTRICT and therefore go last.
    //
    // Every statement names an id this run created or matches `TAG`, with an
    // age gate on the tag-matched ones. This database is shared with other
    // agents and a broad DELETE here would take their fixtures with it.
    console.log("\n— cleanup —");
    await withTenant(ctx, async (tx) => {
      for (const id of [completedProjectId, openProjectId].filter(Boolean)) {
        await tx.execute(sql`delete from project_retention where project_id = ${id}::uuid`);
        await tx.execute(sql`delete from projects where id = ${id}::uuid`);
      }
      for (const id of invoiceIds) {
        await tx.execute(sql`delete from invoice_lines where invoice_id = ${id}::uuid`);
        await tx.execute(sql`delete from invoices where id = ${id}::uuid`);
      }
      for (const id of subcontractorIds) {
        await tx.execute(sql`delete from subcontractors where id = ${id}::uuid`);
      }
    });

    // ── WHY THESE THREE COUNTS RUN INSIDE withTenant AND NOT ON `db` ────────
    //
    // Every table below is FORCE ROW LEVEL SECURITY, policied on
    // `app_current_tenant()`. Outside a tenant transaction `app.tenant_id` is
    // unset, so a count taken on the bare `db` handle matches zero rows
    // whether or not the cleanup above actually worked — a check that cannot
    // fail. Same trap `_tenant.ts` documents for `otherTenantId`, and the one
    // `projects.test.ts` found sitting under a table still holding fixtures.
    const survivors = await withTenant(ctx, async (tx) => {
      const leftovers = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from projects
         where name like ${`${TAG}%`}
           and created_at > now() - interval '1 day'
      `)) as unknown as { count: number }[];

      const straySubs = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from subcontractors
         where name like ${`${TAG}%`}
           and created_at > now() - interval '1 day'
      `)) as unknown as { count: number }[];

      const strayInvoices = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from invoices
         where id = any(${sql`array[${sql.join(
           [
             ...invoiceIds.map((id) => sql`${id}`),
             sql`'00000000-0000-0000-0000-000000000000'`,
           ],
           sql`, `,
         )}]::uuid[]`})
      `)) as unknown as { count: number }[];

      return {
        projects: leftovers[0]?.count,
        subcontractors: straySubs[0]?.count,
        invoices: strayInvoices[0]?.count,
      };
    });

    check("no test project survived cleanup", survivors.projects, 0);
    check("nor any subcontractor fixture", survivors.subcontractors, 0);
    check("and no invoice it raised survived either", survivors.invoices, 0);
  }

  console.log(fail === 0 ? "\nAll project chase checks passed.\n" : `\n${fail} check(s) FAILED.\n`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
