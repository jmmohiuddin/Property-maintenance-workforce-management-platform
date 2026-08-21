/**
 * Projects (`PRJ-1`…`PRJ-9`) — integration test against real Postgres.
 *
 *   npx tsx test/projects.test.ts
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * Four things, and they are the four places a fit-out contractor loses money or
 * gets stopped:
 *
 * **The permit gate.** A project cannot go on site while a permit flagged
 * required is not approved — including one that is approved and has *expired*,
 * which is the case an operator glances at, reads the word "Approved", and
 * stops reading. That comparison is between `YYYY-MM-DD` strings the whole way
 * down; the assertion below uses a permit that expired yesterday, because a
 * value round-tripped through a JS `Date` reports it as still valid for as many
 * hours as the reader's offset.
 *
 * **The completion gate.** Practical completion cannot be recorded with an open
 * critical snag. It certifies that the premises can be occupied and used, and a
 * critical snag is by definition the opposite.
 *
 * **One milestone, one invoice.** `PRJ-3`'s whole point is that an invoice can
 * be raised with no job behind it — and the moment that is true, the guard that
 * stops it being raised twice has to be somewhere else. A tax invoice cannot be
 * deleted, only credited.
 *
 * **Retention arithmetic to the fil.** Two rows per invoice, summing exactly to
 * the withheld amount, taken from the tax-exclusive value, with the odd fil
 * landing in the half that comes back a year later — because that is the half
 * nobody chases.
 *
 * ── WHY EVERY DB ASSERTION IS A DELTA OR ITS OWN FIXTURE ────────────────────
 *
 * Same rule as `contracts.test.ts` and `compliance.test.ts`. A suite that only
 * passes against a pristine database fails on somebody's laptop for reasons
 * that have nothing to do with the code, and the usual response is to stop
 * trusting the suite. Everything below is anchored to `TAG`.
 */

import { sql } from "drizzle-orm";
import { withTenant, closeConnection, db } from "../src/index";
import { testTenantId, otherTenantId } from "./_tenant";
import {
  addMilestone,
  addPhase,
  closeSnag,
  createProject,
  decideVariation,
  engageSubcontractor,
  getProject,
  listProjects,
  listRetention,
  markMilestoneReached,
  projectCompletionPercent,
  projectFinancials,
  raiseMilestoneInvoice,
  raiseSnag,
  raiseVariation,
  recordCost,
  recordPermit,
  releaseRetention,
  setPermitStatus,
  setPhaseProgress,
  transitionProject,
} from "../src/domain";
import {
  blockingPermits,
  canTransitionProject,
  criticalSnagsBlockingCompletion,
  defectsLiabilityEnd,
  dubaiDateKey,
  milestoneTriggerMet,
  phaseWeightGap,
  projectMargin,
  retentionSplit,
  toMinor,
  weightedCompletionPercent,
  UserFacingError,
} from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/**
 * Assert that a call is refused, and refused with a message a human wrote.
 *
 * The second half matters as much as the first. A gate that throws the driver's
 * error is a gate whose message is a SQL statement with parameters in it, and
 * this codebase renders only `UserFacingError`.
 */
async function refuses(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — expected a refusal, the call succeeded`);
  } catch (error) {
    const userFacing = error instanceof UserFacingError;
    if (!userFacing) fail++;
    console.log(
      `${userFacing ? "ok  " : "FAIL"}  ${label}` +
        (userFacing ? "" : ` — threw ${(error as Error)?.name}, not a UserFacingError`),
    );
  }
}

const TAG = "PROJECT-TEST";
const DAY = 24 * 60 * 60 * 1000;

const day = (offsetMs: number) => dubaiDateKey(new Date(Date.now() + offsetMs));

// ── Part 1: the rules, with no database at all ───────────────────────────────

function testStatusMachine(): void {
  console.log("\n— PRJ-1: the project status machine —");

  checkTrue("quoted → awarded is legal", canTransitionProject("quoted", "awarded"));
  checkTrue("a lost tender: quoted → cancelled", canTransitionProject("quoted", "cancelled"));
  check("quoted → on_site skips mobilising", canTransitionProject("quoted", "on_site"), false);

  // Both directions. A snag inspection that finds structural work outstanding
  // sends the project back on site, and a machine that cannot express that gets
  // worked around by recording practical completion early.
  checkTrue("on_site → snagging", canTransitionProject("on_site", "snagging"));
  checkTrue("and snagging → on_site, back again", canTransitionProject("snagging", "on_site"));

  // Practical completion hands the premises over. What happens after it is a
  // dispute or a claim, not a cancellation.
  check(
    "practical completion cannot be cancelled",
    canTransitionProject("practical_completion", "cancelled"),
    false,
  );
  check(
    "and cannot be reversed to snagging",
    canTransitionProject("practical_completion", "snagging"),
    false,
  );
  checkTrue(
    "it goes only to defects liability",
    canTransitionProject("practical_completion", "defects_liability"),
  );
  check("closed is terminal", canTransitionProject("closed", "on_site"), false);
}

function testWeightedCompletion(): void {
  console.log("\n— PRJ-2: weighted completion —");

  // The failure this prevents: four of eight phases done reported as 50%, when
  // the four done are the small ones.
  const phases = [
    { weightBasisPoints: 6000, percentComplete: 100 },
    { weightBasisPoints: 4000, percentComplete: 0 },
  ];
  check("60% of the weight complete reads 60, not 50", weightedCompletionPercent(phases), 60);

  check(
    "a project with no phases is not 0% complete, it is unplanned",
    weightedCompletionPercent([]),
    null,
  );
  check(
    "weights that only reach 7,500 are reported as a 2,500 gap",
    phaseWeightGap([{ weightBasisPoints: 5000 }, { weightBasisPoints: 2500 }]),
    2500,
  );
}

function testRetentionArithmetic(): void {
  console.log("\n— PRJ-5: retention arithmetic —");

  // AED 100,000 net at 5%.
  const split = retentionSplit(10_000_000, 500);
  check("5% of AED 100,000 is AED 5,000", split.totalMinor, 500_000);
  check("half at practical completion", split.practicalCompletionMinor, 250_000);
  check("half at end of defects liability", split.defectsLiabilityMinor, 250_000);
  check(
    "and the two halves sum to the whole, exactly",
    split.practicalCompletionMinor + split.defectsLiabilityMinor,
    split.totalMinor,
  );

  // An odd number of fils. The remainder goes to the SECOND release, because a
  // stray fil in the half that comes back a year later is the one nobody
  // chases — so it is the half that must not be short.
  const odd = retentionSplit(10_101, 500);
  check("an odd withholding still sums exactly", odd.practicalCompletionMinor + odd.defectsLiabilityMinor, odd.totalMinor);
  checkTrue(
    "with the odd fil in the defects-liability half",
    odd.defectsLiabilityMinor >= odd.practicalCompletionMinor,
  );

  // The cap is not cosmetic: a percentage typed where basis points were meant
  // would withhold a hundred times too much from every invoice on the project.
  check("a 5000 basis-point rate is clamped to 10%", retentionSplit(10_000_000, 5000).totalMinor, 1_000_000);

  // Day arithmetic on plain calendar dates. Through a JS Date this shifts by
  // the local offset, and for a retention release the shift reports money that
  // fell due today as not yet due.
  check(
    "twelve months after 2026-03-01 is 2027-03-01",
    defectsLiabilityEnd("2026-03-01", 365),
    "2027-03-01",
  );
  check("a leap year is still counted in days", defectsLiabilityEnd("2028-02-28", 1), "2028-02-29");
}

function testGates(): void {
  console.log("\n— PRJ-6, PRJ-7: the two gates —");

  const today = "2026-08-22";
  const permits = [
    { isRequired: true, status: "approved" as const, expiresOn: "2027-01-01", label: "current" },
    { isRequired: false, status: "not_applied" as const, expiresOn: null, label: "optional" },
    // The one that reads as safe. Approved — and expired yesterday.
    { isRequired: true, status: "approved" as const, expiresOn: "2026-08-21", label: "lapsed" },
    { isRequired: true, status: "applied" as const, expiresOn: null, label: "pending" },
  ];

  const blocking = blockingPermits(permits, today);
  check("two permits block, not one", blocking.length, 2);
  checkTrue(
    "an APPROVED permit that expired yesterday still blocks",
    blocking.some((p) => p.label === "lapsed"),
  );
  checkTrue(
    "an optional permit never blocks",
    !blocking.some((p) => p.label === "optional"),
  );

  const snags = [
    { severity: "critical" as const, status: "open" as const },
    { severity: "critical" as const, status: "closed" as const },
    { severity: "major" as const, status: "open" as const },
    { severity: "critical" as const, status: "in_progress" as const },
  ];
  const blockingSnags = criticalSnagsBlockingCompletion(snags);
  check("two critical snags are still owed", blockingSnags.length, 2);
  // Deliberately drawn at critical. A rule demanding an empty list gets worked
  // around by downgrading everything to minor, which destroys the only field
  // that made the list worth keeping.
  checkTrue(
    "an open MAJOR snag does not stop handover",
    !blockingSnags.some((s) => s.severity !== "critical"),
  );
}

function testMarginAndTriggers(): void {
  console.log("\n— PRJ-3, PRJ-8: triggers and margin —");

  check(
    "a client sign-off is not something a query can decide",
    milestoneTriggerMet(
      { kind: "client_sign_off", triggerOn: null, triggerPercent: null },
      { today: "2026-08-22", percentComplete: 100 },
    ),
    null,
  );
  check(
    "a dated milestone whose date has passed is met",
    milestoneTriggerMet(
      { kind: "date", triggerOn: "2026-08-01", triggerPercent: null },
      { today: "2026-08-22", percentComplete: null },
    ),
    true,
  );
  check(
    "a 60% milestone on a project at 40% is not",
    milestoneTriggerMet(
      { kind: "percent_complete", triggerOn: null, triggerPercent: 60 },
      { today: "2026-08-22", percentComplete: 40 },
    ),
    false,
  );

  const margin = projectMargin({
    contractValueMinor: 50_000_000, // AED 500,000
    approvedVariationMinor: 5_000_000,
    unapprovedVariationMinor: 3_000_000,
    actualCostMinor: 30_000_000,
    committedCostMinor: 10_000_000,
  });
  check("approved variations are revenue", margin.revenueMinor, 55_000_000);
  // Both of these make the number look WORSE than the alternative, and both
  // are correct: a variation nobody approved may never be paid for, and a
  // subcontract signed is money gone whether or not the invoice has arrived.
  check("unapproved ones are not", margin.unapprovedVariationMinor, 3_000_000);
  check("committed cost counts against the margin", margin.marginMinor, 15_000_000);
  check("which is 27.27%", margin.marginBasisPoints, 2727);
  check("a project with no value has no margin percentage", projectMargin({
    contractValueMinor: 0,
    approvedVariationMinor: 0,
    unapprovedVariationMinor: 0,
    actualCostMinor: 0,
    committedCostMinor: 0,
  }).marginBasisPoints, null);
}

// ── Part 2: against the database ─────────────────────────────────────────────

async function main(): Promise<void> {
  testStatusMachine();
  testWeightedCompletion();
  testRetentionArithmetic();
  testGates();
  testMarginAndTriggers();

  // Resolved by slug, not by taking whichever tenant sorts first. See
  // ./_tenant.ts — the tenant that sorts first is the deliberately-empty one.
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  let projectId = "";
  let milestoneInvoiceId = "";
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
         limit 2
      `)) as unknown as { property_id: string; customer_id: string }[];

      const target = targets[0];
      if (!target) {
        throw new Error("Need at least one customer with a property. Run `npm run db:seed`.");
      }
      const foreignProperty = targets.find((t) => t.customer_id !== target.customer_id);

      console.log("\n— baseline —");
      const projectsBefore = (await listProjects(tx)).length;
      console.log(`      baseline: ${projectsBefore} project(s)`);

      // ── PRJ-1: create ──────────────────────────────────────────────────
      console.log("\n— PRJ-1: the container —");

      const created = await createProject(tx, ctx, {
        customerId: target.customer_id,
        propertyId: target.property_id,
        name: `${TAG} Level 12 office fit-out`,
        scope: "Strip-out, partitions, MEP, joinery, flooring and handover.",
        contractValue: "480000.00",
        startsOn: day(-30 * DAY),
        targetCompletionOn: day(60 * DAY),
        retentionBasisPoints: 500,
        defectsLiabilityDays: 365,
      });
      projectId = created.projectId;

      checkTrue("a project gets a PRJ reference", created.reference.startsWith("PRJ-"));
      check("and starts quoted, never mid-machine", (await getProject(tx, projectId))?.status, "quoted");

      // RLS guarantees the property is this tenant's. It says nothing about
      // whose it is inside the tenant, and a project against another customer's
      // building would raise jobs there and invoice the wrong party for them.
      if (foreignProperty) {
        await refuses("a property belonging to another customer is refused", () =>
          createProject(tx, ctx, {
            customerId: target.customer_id,
            propertyId: foreignProperty.property_id,
            name: `${TAG} wrong building`,
            contractValue: "1000.00",
          }),
        );
      }

      await refuses("a 50% retention rate is refused as a mistyped percentage", () =>
        createProject(tx, ctx, {
          customerId: target.customer_id,
          name: `${TAG} bad retention`,
          contractValue: "1000.00",
          retentionBasisPoints: 5000,
        }),
      );

      await refuses("an illegal transition is refused", () =>
        transitionProject(tx, ctx, { projectId, to: "practical_completion" }),
      );

      await transitionProject(tx, ctx, { projectId, to: "awarded" });
      await transitionProject(tx, ctx, { projectId, to: "mobilising" });

      // ── PRJ-6: the permit gate ─────────────────────────────────────────
      console.log("\n— PRJ-6: a project cannot go on site without its permits —");

      const dcd = await recordPermit(tx, ctx, {
        projectId,
        authorityCode: "dcd",
        permitType: "Fire and life safety approval",
        isRequired: true,
        status: "applied",
        appliedOn: day(-20 * DAY),
      });
      // Not required, and never approved. It must not block anything.
      await recordPermit(tx, ctx, {
        projectId,
        authorityCode: "building_management",
        permitType: "Lift booking",
        isRequired: false,
        status: "not_applied",
      });

      await refuses("on_site is refused while a required permit is unapproved", () =>
        transitionProject(tx, ctx, { projectId, to: "on_site" }),
      );

      // Approved, and expired YESTERDAY. This is the case that reads as safe:
      // an operator sees "Approved" and stops reading. It is also the exact
      // comparison a Date round-trip breaks.
      await setPermitStatus(tx, ctx, {
        permitId: dcd.permitId,
        status: "approved",
        approvedOn: day(-400 * DAY),
        expiresOn: day(-1 * DAY),
        referenceNumber: `${TAG}-DCD-1`,
      });

      await refuses("and refused again when that permit is approved but EXPIRED", () =>
        transitionProject(tx, ctx, { projectId, to: "on_site" }),
      );

      await setPermitStatus(tx, ctx, {
        permitId: dcd.permitId,
        status: "approved",
        approvedOn: day(-20 * DAY),
        expiresOn: day(120 * DAY),
      });

      const onSite = await transitionProject(tx, ctx, { projectId, to: "on_site" });
      check("with a current approval it goes on site", onSite.to, "on_site");

      // ── PRJ-2: phases ──────────────────────────────────────────────────
      console.log("\n— PRJ-2: phases and their weights —");

      const strip = await addPhase(tx, ctx, {
        projectId,
        name: "Strip-out",
        weightBasisPoints: 2000,
        plannedStartOn: day(-30 * DAY),
        plannedEndOn: day(-10 * DAY),
      });
      const mep = await addPhase(tx, ctx, {
        projectId,
        name: "MEP first fix",
        weightBasisPoints: 5000,
        plannedStartOn: day(-10 * DAY),
        plannedEndOn: day(30 * DAY),
        dependsOnPhaseId: strip.phaseId,
      });
      await addPhase(tx, ctx, { projectId, name: "Finishes and handover", weightBasisPoints: 3000 });

      check("phases are sequenced by the database, not the caller", mep.sequence, 2);
      await refuses("a phase cannot end before it starts", () =>
        addPhase(tx, ctx, {
          projectId,
          name: "Backwards",
          plannedStartOn: day(10 * DAY),
          plannedEndOn: day(5 * DAY),
        }),
      );

      await setPhaseProgress(tx, ctx, { phaseId: strip.phaseId, percentComplete: 100 });
      await setPhaseProgress(tx, ctx, { phaseId: mep.phaseId, percentComplete: 40 });

      // 20% at 100 plus 50% at 40 is 40. Counting phases would say 33.
      check("completion is weighted, not counted", await projectCompletionPercent(tx, projectId), 40);

      // ── PRJ-4: variations ──────────────────────────────────────────────
      console.log("\n— PRJ-4: variations, and the unapproved total —");

      const addition = await raiseVariation(tx, ctx, {
        projectId,
        title: `${TAG} additional power to server room`,
        value: "18500.00",
        instructedBy: "Client's project manager, on site",
        instructedOn: day(-5 * DAY),
        programmeImpactDays: 3,
      });
      const omission = await raiseVariation(tx, ctx, {
        projectId,
        title: `${TAG} carpet omitted from reception`,
        value: "-6200.00",
      });
      await raiseVariation(tx, ctx, {
        projectId,
        title: `${TAG} extra joinery, not yet approved`,
        value: "9000.00",
      });

      checkTrue("a variation gets a VO reference", addition.reference.startsWith("VO-"));
      await refuses("a zero-value variation is a note, not a variation", () =>
        raiseVariation(tx, ctx, { projectId, title: `${TAG} nothing`, value: "0.00" }),
      );

      await decideVariation(tx, ctx, { variationId: addition.variationId, to: "submitted" });
      await decideVariation(tx, ctx, {
        variationId: addition.variationId,
        to: "approved",
        clientReference: "CL-VO-118",
      });
      await decideVariation(tx, ctx, { variationId: omission.variationId, to: "submitted" });
      await decideVariation(tx, ctx, { variationId: omission.variationId, to: "approved" });

      await refuses("an approved variation cannot be un-approved", () =>
        decideVariation(tx, ctx, { variationId: addition.variationId, to: "rejected" }),
      );

      const afterVariations = await projectFinancials(tx, projectId);
      // 480,000 + 18,500 - 6,200 = 492,300.
      check(
        "approved variations move the revenue, omissions included",
        afterVariations.margin.revenueMinor,
        toMinor("492300.00"),
      );
      check(
        "the unapproved one is totalled separately, not silently included",
        afterVariations.margin.unapprovedVariationMinor,
        toMinor("9000.00"),
      );

      // ── PRJ-3 and PRJ-5: the milestone invoice and its retention ───────
      console.log("\n— PRJ-3, PRJ-5: a reached milestone raises an invoice —");

      const mobilisation = await addMilestone(tx, ctx, {
        projectId,
        name: "Mobilisation, 30%",
        value: "144000.00",
        triggerKind: "client_sign_off",
      });
      const future = await addMilestone(tx, ctx, {
        projectId,
        name: "Second fix, on date",
        value: "100000.00",
        triggerKind: "date",
        triggerOn: day(90 * DAY),
      });

      await refuses("a date-triggered milestone needs its date", () =>
        addMilestone(tx, ctx, {
          projectId,
          name: "No date",
          value: "1000.00",
          triggerKind: "date",
        }),
      );
      await refuses("a milestone cannot be invoiced before it is reached", () =>
        raiseMilestoneInvoice(tx, ctx, { milestoneId: mobilisation.milestoneId }),
      );
      await refuses("and a dated milestone whose date has not arrived is refused", () =>
        markMilestoneReached(tx, ctx, { milestoneId: future.milestoneId }),
      );

      await markMilestoneReached(tx, ctx, {
        milestoneId: mobilisation.milestoneId,
        note: "Signed mobilisation certificate received from the consultant.",
      });

      const raised = await raiseMilestoneInvoice(tx, ctx, {
        milestoneId: mobilisation.milestoneId,
      });
      milestoneInvoiceId = raised.invoiceId;
      invoiceIds.push(raised.invoiceId);

      checkTrue("the invoice gets an INV reference", raised.reference.startsWith("INV-"));
      // 144,000 net + 5% VAT = 151,200.
      check("with VAT applied to the milestone value", raised.totalMinor, toMinor("151200.00"));

      const invoiceRow = (await tx.execute<{
        job_id: string | null;
        status: string;
        taxable_amount: string;
        tax_amount: string;
        line_sum: string;
        line_tax_sum: string;
      }>(sql`
        select i.job_id,
               i.status,
               i.taxable_amount::text as taxable_amount,
               i.tax_amount::text as tax_amount,
               coalesce((select sum(l.net_amount) from invoice_lines l where l.invoice_id = i.id), 0)::text as line_sum,
               coalesce((select sum(l.tax_amount) from invoice_lines l where l.invoice_id = i.id), 0)::text as line_tax_sum
          from invoices i
         where i.id = ${raised.invoiceId}::uuid
      `)) as unknown as {
        job_id: string | null;
        status: string;
        taxable_amount: string;
        tax_amount: string;
        line_sum: string;
        line_tax_sum: string;
      }[];

      const invoice = invoiceRow[0];
      // This is the sentence PRJ-3 exists for: a real tax invoice, issued, with
      // no job behind it. `createInvoiceFromJob` cannot produce this row.
      check("the invoice has NO job behind it", invoice?.job_id, null);
      check("and is issued, not drafted — a number allocated is a number used", invoice?.status, "issued");
      check(
        "the lines sum to the document net, to the fil",
        toMinor(invoice?.line_sum ?? "0"),
        toMinor(invoice?.taxable_amount ?? "0"),
      );
      check(
        "and the line tax sums to the document tax",
        toMinor(invoice?.line_tax_sum ?? "0"),
        toMinor(invoice?.tax_amount ?? "0"),
      );

      // A tax invoice cannot be deleted, only credited, so the second click has
      // to stop before a reference is allocated.
      await refuses("the same milestone cannot be invoiced twice", () =>
        raiseMilestoneInvoice(tx, ctx, { milestoneId: mobilisation.milestoneId }),
      );

      // Retention: 5% of the TAX-EXCLUSIVE 144,000 is 7,200, in two rows.
      const retention = await listRetention(tx, { projectId });
      check("retention is withheld as two rows, one per release stage", retention.length, 2);
      check(
        "totalling 5% of the net, not of the gross",
        retention.reduce((sum, r) => sum + r.amountMinor, 0),
        toMinor("7200.00"),
      );
      check("withheld against this invoice", raised.retentionWithheldMinor, toMinor("7200.00"));
      checkTrue(
        "and with no due date, because practical completion has not happened",
        retention.every((r) => r.dueOn === null && r.status === "held"),
      );

      const heldRow = retention[0];
      if (heldRow) {
        await refuses("retention with no due date cannot be released", () =>
          releaseRetention(tx, ctx, { retentionId: heldRow.id }),
        );
      }

      // ── PRJ-7: the completion gate ─────────────────────────────────────
      console.log("\n— PRJ-7: practical completion and the snag list —");

      const critical = await raiseSnag(tx, ctx, {
        projectId,
        locationText: "Level 12, riser 3",
        tradeCode: "fire_safety",
        severity: "critical",
        description: `${TAG} smoke detector head missing, zone not covered`,
        targetOn: day(3 * DAY),
      });
      await raiseSnag(tx, ctx, {
        projectId,
        locationText: "Level 12, meeting room 2",
        tradeCode: "painting",
        severity: "minor",
        description: `${TAG} paint scuff to east wall`,
      });

      check("snags are sequenced within the project", critical.sequence, 1);
      await refuses("a snag with an unknown trade is refused", () =>
        raiseSnag(tx, ctx, {
          projectId,
          locationText: "Somewhere",
          tradeCode: "not-a-trade",
          severity: "minor",
          description: `${TAG} nowhere`,
        }),
      );

      await transitionProject(tx, ctx, { projectId, to: "snagging" });
      await refuses("practical completion is refused with an open critical snag", () =>
        transitionProject(tx, ctx, { projectId, to: "practical_completion" }),
      );

      await refuses("and a snag cannot be closed with no evidence", () =>
        closeSnag(tx, ctx, { snagId: critical.snagId, closureNote: "" }),
      );

      await closeSnag(tx, ctx, {
        snagId: critical.snagId,
        closureNote: "Detector head fitted and zone tested with the consultant present.",
        closurePhotoStorageKey: `${TAG}/snag-1-closed.jpg`,
      });

      const completionOn = day(0);
      const completed = await transitionProject(tx, ctx, {
        projectId,
        to: "practical_completion",
        practicalCompletionOn: completionOn,
      });
      check("with the critical snag closed, it completes", completed.to, "practical_completion");
      // The minor snag is still open, and that is correct: practical completion
      // has never meant an empty snag list.
      check("and dated both retention rows in doing so", completed.retentionDated, 2);

      const dated = await listRetention(tx, { projectId });
      const pc = dated.find((r) => r.stage === "practical_completion");
      const dlp = dated.find((r) => r.stage === "defects_liability");
      check("the first half falls due at practical completion", pc?.dueOn, completionOn);
      check("the second twelve months later", dlp?.dueOn, defectsLiabilityEnd(completionOn, 365));
      check("the first is due for chasing now", pc?.status, "due");
      check("the second is still held", dlp?.status, "held");

      if (pc) {
        const released = await releaseRetention(tx, ctx, {
          retentionId: pc.id,
          note: "Released against the practical completion certificate.",
        });
        check("releasing the first half returns half the withholding", released.amountMinor, toMinor("3600.00"));
        await refuses("and it cannot be released twice", () =>
          releaseRetention(tx, ctx, { retentionId: pc.id }),
        );
      }

      // ── PRJ-8 / PRJ-9: cost, commitment and margin ─────────────────────
      console.log("\n— PRJ-8, PRJ-9: cost, commitment and the live margin —");

      // `PRJ-9` is an ENGAGEMENT against `HR-19`'s register, not a second
      // register. The fixture is inserted into that table rather than read from
      // it, because the seed does not yet write one and a check that skips is
      // worse than no check — it occupies the place where somebody would
      // otherwise write one. Removed again in cleanup.
      const subRows = (await tx.execute<{ id: string }>(sql`
        insert into subcontractors (tenant_id, name, kind, trade_slug, status)
        values (${tenantId}::uuid, ${`${TAG} MEP Contracting LLC`}, 'subcontractor',
                'electromechanical-installation', 'approved')
        returning id
      `)) as unknown as { id: string }[];

      const subcontractorId = subRows[0]?.id;
      if (!subcontractorId) throw new Error("could not create the subcontractor fixture");
      subcontractorIds.push(subcontractorId);

      const engaged = await engageSubcontractor(tx, ctx, {
        projectId,
        subcontractorId,
        scope: `${TAG} MEP first and second fix`,
        value: "180000.00",
        startsOn: day(-10 * DAY),
      });
      const committedMinor = engaged.committedMinor;
      check("a subcontract commits its value immediately", committedMinor, toMinor("180000.00"));
      // Law No. 7 of 2025 requires the employer's prior approval. A field that
      // defaults to "not required" is a field that is always "not required".
      const approvalRows = (await tx.execute<{ client_approval_state: string }>(sql`
        select client_approval_state from project_subcontracts where id = ${engaged.subcontractId}::uuid
      `)) as unknown as { client_approval_state: string }[];
      check(
        "and defaults to awaiting the client's approval, never to not-required",
        approvalRows[0]?.client_approval_state,
        "pending",
      );

      // Hours × a captured hourly cost. Integer throughout, so the same
      // timesheet recomputed gives the same figure.
      const labour = await recordCost(tx, ctx, {
        projectId,
        category: "labour",
        description: `${TAG} site labour, week 3`,
        quantity: "184.500",
        unit: "hour",
        unitCost: "32.50",
      });
      check("184.5 hours at AED 32.50 is AED 5,996.25", labour.amountMinor, toMinor("5996.25"));

      await recordCost(tx, ctx, {
        projectId,
        category: "materials",
        description: `${TAG} partition track and board`,
        quantity: "1",
        unitCost: "42000.00",
      });

      await refuses("a cost with no rate and no rate card is refused", () =>
        recordCost(tx, ctx, {
          projectId,
          category: "labour",
          description: `${TAG} unpriced`,
          quantity: "8",
          labourRateCode: "no-such-grade",
        }),
      );

      const financials = await projectFinancials(tx, projectId);
      const expectedActual = toMinor("5996.25") + toMinor("42000.00");
      check("actual cost is the sum of what was spent", financials.margin.actualCostMinor, expectedActual);
      check("committed cost is reported apart from it", financials.margin.committedCostMinor, committedMinor);
      check(
        "and the margin counts both against revenue",
        financials.margin.marginMinor,
        toMinor("492300.00") - expectedActual - committedMinor,
      );
      check("the invoiced total is the milestone invoice, gross", financials.invoicedMinor, toMinor("151200.00"));
      check("retention still held is the second half", financials.retentionHeldMinor, toMinor("3600.00"));

      // ── The board ──────────────────────────────────────────────────────
      console.log("\n— the board reads it back in one query —");

      const board = await listProjects(tx);
      check("the project is on the board", board.length, projectsBefore + 1);
      const row = board.find((p) => p.id === projectId);
      check("with its weighted completion", row?.percentComplete, 40);
      check("its unapproved variation total", row?.unapprovedVariationMinor, toMinor("9000.00"));
      check("no critical snags left open", row?.openCriticalSnags, 0);
      check("and no blocking permits", row?.blockingPermits, 0);

      const detail = await getProject(tx, projectId);
      check("the detail screen loads phases", detail?.phases.length, 3);
      check("milestones", detail?.milestones.length, 2);
      check("variations", detail?.variations.length, 3);
      check("permits", detail?.permits.length, 2);
      check("snags", detail?.snags.length, 2);
      check("and retention", detail?.retention.length, 2);
    });

    // ── Cross-tenant isolation ─────────────────────────────────────────────
    //
    // Not a WHERE clause. `withTenant` sets `app.tenant_id` and Postgres does
    // the rest; the second tenant sees nothing at all, including the row this
    // test just committed.
    console.log("\n— tenant isolation —");
    const other = await otherTenantId();
    await withTenant({ tenantId: other, actorKind: "system" }, async (tx) => {
      const seen = (await listProjects(tx)).filter((p) => p.name.startsWith(TAG));
      check("the other tenant sees none of this project", seen.length, 0);
      check("and cannot load it by id", await getProject(tx, projectId), null);

      const retentionSeen = await listRetention(tx, { projectId });
      check("nor its retention ledger", retentionSeen.length, 0);
    });
  } finally {
    // ── Cleanup, anchored to TAG ───────────────────────────────────────────
    //
    // Order matters for exactly one reason: `project_retention.invoice_id` is
    // ON DELETE RESTRICT, so the retention rows have to go before the invoice
    // they claim against. Everything else cascades from `projects`.
    console.log("\n— cleanup —");
    await withTenant(ctx, async (tx) => {
      if (projectId) {
        await tx.execute(sql`delete from project_retention where project_id = ${projectId}::uuid`);
        await tx.execute(sql`delete from projects where id = ${projectId}::uuid`);
      }
      for (const id of invoiceIds) {
        await tx.execute(sql`delete from invoice_lines where invoice_id = ${id}::uuid`);
        await tx.execute(sql`delete from invoices where id = ${id}::uuid`);
      }
      // After the project, whose `project_subcontracts` rows reference these
      // with ON DELETE RESTRICT.
      for (const id of subcontractorIds) {
        await tx.execute(sql`delete from subcontractors where id = ${id}::uuid`);
      }
    });

    const leftovers = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from projects where name like ${`${TAG}%`}
    `)) as unknown as { count: number }[];
    check("no test project survived cleanup", leftovers[0]?.count, 0);

    const strayInvoices = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from invoices
       where id = any(${sql`array[${sql.join(
         [
           ...invoiceIds.map((id) => sql`${id}`),
           sql`'00000000-0000-0000-0000-000000000000'`,
         ],
         sql`, `,
       )}]::uuid[]`})
    `)) as unknown as { count: number }[];
    check("and no invoice it raised survived either", strayInvoices[0]?.count, 0);

    const straySubs = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from subcontractors where name like ${`${TAG}%`}
    `)) as unknown as { count: number }[];
    check("nor the subcontractor fixture", straySubs[0]?.count, 0);

    const strayRetention = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from project_retention
       where invoice_id = ${milestoneInvoiceId || "00000000-0000-0000-0000-000000000000"}::uuid
    `)) as unknown as { count: number }[];
    check("nor any retention claim against it", strayRetention[0]?.count, 0);
  }

  console.log(fail === 0 ? "\nAll project checks passed.\n" : `\n${fail} check(s) FAILED.\n`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
