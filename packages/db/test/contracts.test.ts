/**
 * Contracts and AMC (`CON-1`…`CON-10`) — integration test against real Postgres.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires a seeded database. Cleans up everything it creates.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * Two things, and the first is the one that matters.
 *
 * **The planner cannot place a visit somewhere illegal.** A PPM schedule is
 * generated once, months ahead, for a whole year, and then acted on by people
 * who will not re-check the date. If it puts an outdoor visit at 13:00 on
 * 1 July the penalty is AED 5,000 per worker capped at AED 50,000 plus a
 * company classification downgrade, and nobody finds out until an inspector
 * does. So the calendar assertions below run over an entire generated year
 * against a calendar with real public holidays in it, not over one hand-picked
 * date.
 *
 * **Out-of-scope work cannot be absorbed.** `CON-6` is the single mechanism
 * that stops a comprehensive AMC becoming a loss, and the failure it prevents
 * is not fraud — it is a technician doing the decent thing with a seized
 * compressor while nobody raises a quote. The test proves the refusal produces
 * a quote at the contract discount, with VAT applied after it.
 *
 * ── WHY EVERY DB ASSERTION IS A DELTA ───────────────────────────────────────
 *
 * Same rule as `compliance.test.ts`. A suite that only passes against a
 * pristine database fails on somebody's laptop for reasons that have nothing to
 * do with the code, and the usual response to that is to stop trusting the
 * suite. Everything below measures the change its own fixtures cause.
 */

import { sql } from "drizzle-orm";
import { withTenant, withCustomerScope, closeConnection } from "../src/index";
import { testTenantId } from "./_tenant";
import {
  activateContract,
  attachContractDocument,
  checkContractScope,
  createContract,
  dueContractVisits,
  findExpiringContracts,
  generatePpmSchedule,
  generateRenewalQuote,
  listContractDocuments,
  materialisePpmJobs,
  ppmCompliance,
  quoteOutOfScopeWork,
  recordRenewalNotice,
  reconcileContractVisits,
  addPublicHoliday,
  loadWorkingCalendar,
  renewalNoticeSent,
  renewalPipeline,
  getContract,
  jobContractScope,
  listContracts,
  listPortalContracts,
} from "../src/domain";
import {
  DEFAULT_CALENDAR,
  computeSlaDeadlines,
  decideScope,
  dubaiDateKey,
  planPpmVisits,
  ppmCalendarViolations,
  renewalBand,
  toMinor,
  visitsForTerm,
  type WorkingCalendar,
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

const TAG = "CONTRACT-TEST";
const DAY = 24 * 60 * 60 * 1000;

// ── Part 1: the planner, with no database at all ─────────────────────────────

/**
 * A calendar with holidays in it.
 *
 * `DEFAULT_CALENDAR` ships with an EMPTY public-holiday list on purpose — a
 * hardcoded list goes stale in January — so testing against it would prove the
 * planner avoids weekends and say nothing at all about holidays. These are the
 * announced 2026 UAE dates plus a deliberately long Eid run, because a single
 * holiday can be dodged by luck and a five-day run cannot.
 */
const CALENDAR_WITH_HOLIDAYS: WorkingCalendar = {
  ...DEFAULT_CALENDAR,
  publicHolidays: {
    "2026-01-01": "New Year's Day",
    "2026-03-19": "Eid al-Fitr",
    "2026-03-20": "Eid al-Fitr",
    "2026-03-21": "Eid al-Fitr",
    "2026-03-22": "Eid al-Fitr",
    "2026-03-23": "Eid al-Fitr",
    "2026-05-26": "Arafat Day",
    "2026-05-27": "Eid al-Adha",
    "2026-05-28": "Eid al-Adha",
    "2026-07-16": "Islamic New Year",
    "2026-08-25": "Prophet's birthday",
    "2026-12-01": "Commemoration Day",
    "2026-12-02": "National Day",
    "2026-12-03": "National Day",
  },
};

function testPlanner(): void {
  console.log("\n— CON-3: the PPM planner —");

  const termStart = new Date("2026-01-01T00:00:00+04:00");
  const termEnd = new Date("2026-12-31T00:00:00+04:00");

  const plan = planPpmVisits({
    termStart,
    termEnd,
    properties: ["property-a", "property-b"],
    entitlements: [
      { serviceSlug: "hvac-installation-maintenance", visitsPerYear: 12 },
      { serviceSlug: "plumbing-sanitary", visitsPerYear: 4 },
      { serviceSlug: "building-cleaning", visitsPerYear: 2 },
    ],
    calendar: CALENDAR_WITH_HOLIDAYS,
  });

  const expected = 2 * (visitsForTerm(12, 364) + visitsForTerm(4, 364) + visitsForTerm(2, 364));
  check("a year of PPM produces the entitled number of visits", plan.visits.length, expected);
  check("and nothing was left unplaced", plan.unplaced.length, 0);

  // THE assertion this file exists for. Not one date — every date.
  const violations = ppmCalendarViolations(plan.visits, CALENDAR_WITH_HOLIDAYS);
  if (violations.length > 0) {
    for (const v of violations) {
      console.log(`      ${dubaiDateKey(v.dueOn)} ${v.serviceSlug} — ${v.reason}`);
    }
  }
  check(
    "no planned visit lands on a holiday, a weekend, or inside the midday ban",
    violations.length,
    0,
  );

  checkTrue(
    "every visit is inside the term",
    plan.visits.every((v) => v.dueOn >= termStart && v.dueOn <= termEnd),
  );

  // Snapping only moves dates forward, so two adjacent targets can collide on a
  // long holiday run. The planner tracks the last placed date per property and
  // service for exactly that reason; this is the assertion that would have
  // caught it being dropped.
  const keys = plan.visits.map((v) => `${v.propertyId}|${v.serviceSlug}|${dubaiDateKey(v.dueOn)}`);
  check("no two visits for one property and service share a date", new Set(keys).size, keys.length);

  checkTrue(
    "windows straddle the target date",
    plan.visits.every((v) => v.windowStart < v.dueOn && v.windowEnd > v.dueOn),
  );

  // A one-month term at four visits a year owes one, not zero. Flooring would
  // silently under-deliver on every short or extended term.
  check("a 30-day term at 4 visits a year owes 1", visitsForTerm(4, 30), 1);
  check("an 18-month term at 4 visits a year owes 6", visitsForTerm(4, 547), 6);

  // A term that starts inside the ban season, so the first target is a date the
  // planner has to move rather than one it happens to be handed.
  const summer = planPpmVisits({
    termStart: new Date("2026-06-15T00:00:00+04:00"),
    termEnd: new Date("2026-09-15T00:00:00+04:00"),
    properties: ["roof"],
    entitlements: [{ serviceSlug: "building-cleaning", visitsPerYear: 24 }],
    calendar: CALENDAR_WITH_HOLIDAYS,
  });
  check(
    "a summer-only term places no visit inside the midday ban",
    ppmCalendarViolations(summer.visits, CALENDAR_WITH_HOLIDAYS).length,
    0,
  );
  checkTrue("and it placed some", summer.visits.length > 0);
}

// ── Part 2: the pure rules ───────────────────────────────────────────────────

function testRenewalLadder(): void {
  console.log("\n— CON-9: the reminder ladder —");

  check("95 days out is before the ladder starts", renewalBand(95), null);
  check("90 days out is the T-90 rung", renewalBand(90), 90);
  check("61 days out is still T-90", renewalBand(61), 90);
  check("45 days out gets T-60, not a skipped rung", renewalBand(45), 60);
  check("30 days out is T-30", renewalBand(30), 30);
  check("7 days out is T-7", renewalBand(7), 7);
  // The most urgent case must not return null, or nothing ever fires on it.
  check("an expired contract is still on the T-7 rung", renewalBand(-40), 7);
}

function testScopeDecision(): void {
  console.log("\n— CON-6: the scope decision —");

  const base = {
    coverageType: "comprehensive" as const,
    coveredServices: ["hvac-installation-maintenance"],
    exclusionCodes: ["compressor_replacement", "fan_motor_replacement"],
    discountBasisPoints: 1500,
  };

  const covered = decideScope({
    ...base,
    serviceSlug: "hvac-installation-maintenance",
    entitlementRemaining: 2,
  });
  check("a covered service with entitlement left is covered", covered.verdict, "covered");
  check("and needs no quote", covered.requiresQuote, false);
  // Zero, not the contract rate. A discount on nothing is a number that would
  // eventually be multiplied by something.
  check("and carries no discount", covered.discountBasisPoints, 0);

  const excluded = decideScope({
    ...base,
    serviceSlug: "hvac-installation-maintenance",
    matchedExclusionCodes: ["compressor_replacement"],
    entitlementRemaining: 2,
  });
  check("an exclusion beats remaining entitlement", excluded.verdict, "excluded");
  check("and requires a quote", excluded.requiresQuote, true);
  check("at the contract discount", excluded.discountBasisPoints, 1500);

  // An exclusion code the contract does not carry excludes nothing, however
  // standard it is on other contracts.
  const notOnThisContract = decideScope({
    ...base,
    serviceSlug: "hvac-installation-maintenance",
    matchedExclusionCodes: ["waterproofing"],
    entitlementRemaining: 2,
  });
  check(
    "an exclusion this contract does not carry does not exclude",
    notOnThisContract.verdict,
    "covered",
  );

  const exhausted = decideScope({
    ...base,
    serviceSlug: "hvac-installation-maintenance",
    entitlementRemaining: 0,
  });
  check("a used-up entitlement is quotable, not free", exhausted.verdict, "entitlement_exhausted");
  check("and quotable at the discount", exhausted.discountBasisPoints, 1500);

  const unlimited = decideScope({
    ...base,
    serviceSlug: "hvac-installation-maintenance",
    entitlementRemaining: null,
  });
  check("null entitlement means unlimited, not zero", unlimited.verdict, "covered");

  const notCovered = decideScope({ ...base, serviceSlug: "tiling", entitlementRemaining: 4 });
  check("a service outside the contract is not covered", notCovered.verdict, "not_covered");

  const parts = decideScope({
    ...base,
    coverageType: "labour_only",
    serviceSlug: "hvac-installation-maintenance",
    requiresParts: true,
    entitlementRemaining: 4,
  });
  check("parts on a labour-only contract are billable", parts.verdict, "parts_not_covered");

  const labourOnlyNoParts = decideScope({
    ...base,
    coverageType: "labour_only",
    serviceSlug: "hvac-installation-maintenance",
    requiresParts: false,
    entitlementRemaining: 4,
  });
  check("labour on a labour-only contract is covered", labourOnlyNoParts.verdict, "covered");
}

// ── Part 3: against real Postgres ────────────────────────────────────────────

async function main(): Promise<void> {
  testPlanner();
  testRenewalLadder();
  testScopeDecision();

  // Resolved by slug, not by taking whichever tenant sorts first. See
  // ./_tenant.ts — the tenant that sorts first is the deliberately-empty one.
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  let contractId = "";
  const quoteIds: string[] = [];

  /**
   * Every visit `materialisePpmJobs` turned into a job, including ones that do
   * not belong to this test's contract.
   *
   * That function is tenant-wide by design — the cron calls it with no filter —
   * so calling it here also materialises whatever the seed left due. Recording
   * only this contract's jobs would leave the seeded ones raised, and the next
   * run of the contracts cron would then find nothing to do and report a zero
   * that means "already done", not "nothing due". Cleanup puts every one of
   * them back.
   */
  const materialisedAll: { visitId: string; jobId: string }[] = [];

  /**
   * Public holidays this test inserts into the tenant's own reference data
   * (`ADM-10`), and removes again in cleanup.
   *
   * Chosen rather than invented: they are the exact dates the planner would
   * otherwise have picked for this contract, computed below and then declared
   * holidays. A holiday on a random date proves nothing — the planner would
   * never have gone near it — so the only way to know the tenant's calendar is
   * load-bearing is to block the dates it actually wanted.
   */
  const TEST_HOLIDAYS: { date: string; name: string }[] = [];

  /** Jobs this test inserted directly, rather than through materialisation. */
  const jobIdsToPurge: string[] = [];

  /**
   * The customer this test's contract belongs to, and one that it does not.
   *
   * Captured out here because the `CON-5` portal assertions have to run AFTER
   * the transaction above commits: `withCustomerScope` opens its own
   * transaction and cannot see uncommitted rows, and the whole point of those
   * assertions is that Postgres does the scoping rather than a WHERE clause.
   *
   * The second customer is another one in the SAME tenant, deliberately — not
   * another tenant. Tenant isolation is `rls.sql`'s job and is verified there;
   * what `customer-scope.sql` adds is the boundary between two customers who
   * are both legitimately inside this tenant, and only a same-tenant pair
   * exercises it.
   */
  let contractCustomerId = "";
  let otherCustomerId = "";

  try {
    await withTenant(ctx, async (tx) => {
      // ── Fixtures ─────────────────────────────────────────────────────────
      const targets = (await tx.execute<{
        property_id: string;
        customer_id: string;
        property_name: string;
      }>(sql`
        select p.id as property_id, p.customer_id, p.name as property_name
          from properties p
          join customers c on c.id = p.customer_id
         where p.deleted_at is null and c.deleted_at is null
         order by p.created_at
         limit 2
      `)) as unknown as { property_id: string; customer_id: string; property_name: string }[];

      const target = targets[0];
      if (!target) {
        throw new Error("Need at least one customer with a property. Run `npm run db:seed`.");
      }

      const otherCustomerProperty = targets.find((t) => t.customer_id !== target.customer_id);

      console.log("\n— baseline —");
      const contractsBefore = (await renewalPipeline(tx, 3650)).length;
      const complianceBefore = (await ppmCompliance(tx)).length;
      console.log(`      baseline: ${contractsBefore} contract(s) in the pipeline`);

      // ── CON-1 / CON-2: create ────────────────────────────────────────────
      console.log("\n— CON-1, CON-2: creating a contract —");

      // Started 100 days ago so some visits are already inside their 21-day
      // lead time. A contract starting today would generate nothing due, and
      // the CON-4 assertions below would pass vacuously.
      const startsOn = new Date(Date.now() - 100 * DAY);
      const endsOn = new Date(Date.now() + 265 * DAY);

      const ENTITLEMENTS = [
        { serviceSlug: "hvac-installation-maintenance", label: "AC service", visitsPerYear: 4 },
        { serviceSlug: "plumbing-sanitary", label: "Plumbing inspection", visitsPerYear: 2 },
      ] as const;

      // ── Make the tenant's holiday list load-bearing ──────────────────────
      //
      // Run the planner once against the tenant's CURRENT calendar to find the
      // dates it wants, then declare those dates public holidays. Generation
      // below therefore has to route around them, and the stored-row assertion
      // afterwards is checking a real avoidance rather than a coincidence.
      //
      // This also exercises the whole chain the production path uses —
      // `public_holidays` → `loadWorkingCalendar` → `planPpmVisits` → the rows
      // — which is the part a pure-function test cannot reach. `ADM-10` exists
      // precisely so an administrator can enter this year's Eid dates without a
      // deploy, and a schedule that ignored them would be the failure that
      // makes the whole feature untrustworthy.
      const beforeHolidays = planPpmVisits({
        termStart: startsOn,
        termEnd: endsOn,
        properties: [target.property_id],
        entitlements: ENTITLEMENTS.map((e) => ({
          serviceSlug: e.serviceSlug,
          visitsPerYear: e.visitsPerYear,
        })),
        calendar: await loadWorkingCalendar(tx),
      });

      for (const visit of beforeHolidays.visits) {
        TEST_HOLIDAYS.push({
          date: dubaiDateKey(visit.dueOn),
          name: `${TAG} synthetic holiday`,
        });
      }
      for (const holiday of TEST_HOLIDAYS) {
        await addPublicHoliday(tx, ctx, { date: holiday.date, name: holiday.name });
      }
      checkTrue("every date the planner wanted is now a holiday", TEST_HOLIDAYS.length > 0);

      const created = await createContract(tx, ctx, {
        customerId: target.customer_id,
        name: `${TAG} comprehensive AMC`,
        coverageType: "comprehensive",
        startsOn,
        endsOn,
        annualValue: "42000.00",
        billingFrequency: "quarterly",
        discountRateBasisPoints: 1500,
        calloutsPerYear: null,
        propertyIds: [target.property_id],
        entitlements: ENTITLEMENTS.map((e) => ({ ...e })),
        exclusionCodes: ["compressor_replacement", "fan_motor_replacement", "waterproofing"],
        // The seam `computeSlaDeadlines` has always had and nothing was using.
        // Asserted below against the job it produces.
        slaTargets: { p4_planned: { respondMinutes: 60, resolveMinutes: 240 } },
      });

      contractId = created.contractId;
      checkTrue("the contract got a CON reference", /^CON-\d{4}-\d{5}$/.test(created.reference));

      const detail = await getContract(tx, contractId);
      checkTrue("and it reads back", detail !== null);
      check("with both entitlements", detail?.entitlements.length, 2);
      check("and three exclusions", detail?.exclusions.length, 3);
      check("as a draft", detail?.status, "draft");
      // 4 visits a year over a 365-day term is 4; the screen shows the term
      // figure, not the annual one, or a two-year contract reads as exhausted
      // halfway through.
      check(
        "entitlement is measured over the term, not per year",
        detail?.entitlements.find((e) => e.serviceSlug === "hvac-installation-maintenance")
          ?.entitledForTerm,
        4,
      );

      // A property belonging to a different customer must be refused. RLS
      // proves it is this tenant's; nothing else proves whose it is.
      if (otherCustomerProperty) {
        let refused = false;
        try {
          await tx.transaction(async (inner) => {
            await createContract(inner, ctx, {
              customerId: target.customer_id,
              name: `${TAG} should not exist`,
              coverageType: "comprehensive",
              startsOn,
              endsOn,
              annualValue: "1000.00",
              billingFrequency: "annually",
              propertyIds: [otherCustomerProperty.property_id],
              entitlements: [
                { serviceSlug: "plumbing-sanitary", label: "Plumbing", visitsPerYear: 1 },
              ],
            });
          });
        } catch {
          refused = true;
        }
        checkTrue("a property belonging to another customer is REFUSED", refused);
      } else {
        console.log("      skipped: only one customer has properties in this database");
      }

      // ── CON-3: activation generates the schedule ─────────────────────────
      console.log("\n— CON-3: activation generates the schedule —");

      const generated = await activateContract(tx, ctx, contractId);
      checkTrue("activation generated visits", generated.created > 0);
      check("and nothing was unplaceable", generated.unplaced.length, 0);

      const afterActivation = await getContract(tx, contractId);
      check("the contract is now active", afterActivation?.status, "active");
      check("with a schedule", afterActivation?.visits.length, generated.created);

      // Re-running must not double-book. A scheduler that fires twice and an
      // operator who clicks twice are the same event to this function.
      const again = await generatePpmSchedule(tx, ctx, contractId);
      check("regenerating creates nothing new", again.created, 0);
      check("and recognises every existing visit", again.skippedExisting, generated.created);

      // ── The calendar guarantee, on the rows that were actually written ───
      //
      // The year-long assertion at the top of this file is a pure-function
      // test: it proves the PLANNER returns compliant dates. It cannot prove
      // the writer stores the dates it was given, and that gap is exactly where
      // a midday-ban breach would hide — AED 5,000 per worker, capped at AED
      // 50,000, plus a classification downgrade.
      //
      // So this reads back from `contract_visits` and checks the stored
      // timestamps. Two details make it mean something rather than pass
      // vacuously:
      //
      //   1. The holidays above were inserted into `public_holidays` BEFORE
      //      activation, so `generatePpmSchedule` loaded them through
      //      `loadWorkingCalendar` and had to route around them. Without that,
      //      a tenant with no holiday reference data has nothing to avoid and
      //      the holiday half of this assertion proves nothing.
      //   2. It is checked against the calendar the generator actually used —
      //      re-loaded from the database here, not `DEFAULT_CALENDAR`. Checking
      //      compliant rows against an empty holiday list would pass no matter
      //      what was stored.
      const generatorCalendar = await loadWorkingCalendar(tx);
      checkTrue(
        "the tenant's calendar really does carry the holidays",
        Object.keys(generatorCalendar.publicHolidays).length >= TEST_HOLIDAYS.length,
      );

      const stored = (await tx.execute<{ due_on: Date | string; service_slug: string }>(sql`
        select due_on, coalesce(service_slug, '') as service_slug
          from contract_visits
         where contract_id = ${contractId} and deleted_at is null
      `)) as unknown as { due_on: Date | string; service_slug: string }[];

      checkTrue("there are stored rows to check", stored.length > 0);

      const storedViolations = ppmCalendarViolations(
        stored.map((r) => ({ dueOn: new Date(r.due_on), serviceSlug: r.service_slug })),
        generatorCalendar,
      );
      if (storedViolations.length > 0) {
        for (const v of storedViolations) {
          console.log(`      ${dubaiDateKey(v.dueOn)} ${v.serviceSlug} — ${v.reason}`);
        }
      }
      check(
        "no STORED visit falls on a holiday, a weekend, or inside the midday ban",
        storedViolations.length,
        0,
      );

      // And prove the holidays were load-bearing rather than coincidentally
      // avoided: no stored date may equal one of them.
      const storedDays = new Set(stored.map((r) => dubaiDateKey(new Date(r.due_on))));
      check(
        "and none of them landed on a date the tenant marked a holiday",
        TEST_HOLIDAYS.filter((h) => storedDays.has(h.date)).length,
        0,
      );

      // ── CON-4: a planned visit becomes a job ─────────────────────────────
      console.log("\n— CON-4: a planned visit becomes a job —");

      const due = await dueContractVisits(tx);
      const ourDue = due.filter((d) => d.contractId === contractId);
      checkTrue("some visits are inside their lead time", ourDue.length > 0);

      const materialisedBefore = Date.now();
      const materialised = await materialisePpmJobs(tx, ctx);
      const ours = materialised.filter((m) => ourDue.some((d) => d.visitId === m.visitId));
      check("each due visit produced one job", ours.length, ourDue.length);
      for (const m of materialised) materialisedAll.push({ visitId: m.visitId, jobId: m.jobId });

      const firstJobId = ours[0]?.jobId;
      if (!firstJobId) throw new Error("No job was materialised; the CON-4 assertions cannot run.");

      const jobRows = (await tx.execute<{
        source: string;
        priority: string;
        is_contract_covered: boolean;
        contract_id: string | null;
        respond_by_at: Date | string | null;
      }>(sql`
        select source::text as source, priority::text as priority, is_contract_covered,
               contract_id, respond_by_at
          from jobs where id = ${firstJobId}
      `)) as unknown as {
        source: string;
        priority: string;
        is_contract_covered: boolean;
        contract_id: string | null;
        respond_by_at: Date | string | null;
      }[];

      const job = jobRows[0];
      check("the job is marked as contract work", job?.source, "contract_ppm");
      check("and is not separately billable", job?.is_contract_covered, true);
      check("and points at the contract", job?.contract_id, contractId);
      check("at planned priority", job?.priority, "p4_planned");

      // The contract negotiated a 60-minute response for planned work; the
      // default for `p4_planned` is seven days. Compared against the default
      // computed for the same instant rather than against a fixed number of
      // days — both are counted in WORKING minutes, so a run on a Friday
      // evening legitimately lands on Monday and a fixed threshold would fail
      // for a reason that has nothing to do with the code.
      //
      // This is the assertion for the seam the requirement names:
      // `computeSlaDeadlines` has taken contract targets as a parameter since
      // `JOB-3` and nothing was passing them, so a contract that had negotiated
      // a faster response was still judged by the default.
      const respondBy = job?.respond_by_at ? new Date(job.respond_by_at).getTime() : 0;
      const defaultDeadline = computeSlaDeadlines(
        "p4_planned",
        new Date(materialisedBefore),
      ).respondByAt.getTime();
      checkTrue(
        "the contract's own SLA target was applied, not the default",
        respondBy > 0 && respondBy < defaultDeadline - DAY,
      );

      // Idempotent: the visit now has a job, so it is no longer due.
      const dueAfter = (await dueContractVisits(tx)).filter((d) => d.contractId === contractId);
      check("a visit that became a job is no longer due", dueAfter.length, 0);

      // ── CON-5: entitlement consumption ──────────────────────────────────
      console.log("\n— CON-5: completing a visit consumes entitlement —");

      const beforeConsumption = await getContract(tx, contractId);
      const acBefore =
        beforeConsumption?.entitlements.find(
          (e) => e.serviceSlug === "hvac-installation-maintenance",
        )?.consumedVisits ?? 0;

      // Complete whichever of our jobs is the AC one.
      const acVisit = ourDue.find((d) => d.serviceSlug === "hvac-installation-maintenance");
      const acJob = acVisit ? ours.find((m) => m.visitId === acVisit.visitId) : undefined;

      if (acJob) {
        await tx.execute(sql`
          update jobs set status = 'work_complete', completed_at = now()
           where id = ${acJob.jobId}
        `);

        const reconciled = await reconcileContractVisits(tx);
        checkTrue("the sweep saw at least one completion", reconciled.completed >= 1);

        const afterConsumption = await getContract(tx, contractId);
        const acAfter =
          afterConsumption?.entitlements.find(
            (e) => e.serviceSlug === "hvac-installation-maintenance",
          )?.consumedVisits ?? 0;
        check("the AC entitlement decremented by exactly one", acAfter, acBefore + 1);

        const visitStatus = afterConsumption?.visits.find((v) => v.id === acJob.visitId)?.status;
        check("and the visit reads as done", visitStatus, "completed");

        // Re-running must not decrement again. The visit is `completed` now, so
        // the sweep's own WHERE clause excludes it.
        await reconcileContractVisits(tx);
        const afterSecondSweep = await getContract(tx, contractId);
        check(
          "a second sweep does not double-decrement",
          afterSecondSweep?.entitlements.find(
            (e) => e.serviceSlug === "hvac-installation-maintenance",
          )?.consumedVisits,
          acBefore + 1,
        );
      } else {
        console.log("      skipped: no AC visit was inside the lead time this run");
      }

      // ── CON-2: callout consumption is derived, not counted ──────────────
      console.log("\n— CON-2: callout consumption —");

      // There is no `consumed_callouts` column. A callout is any job against
      // the contract the PPM schedule did not raise, which is derivable from
      // `jobs` — so this asserts the derivation against rows, including the
      // case a stored counter gets wrong without being decremented by hand.
      const calloutBefore = (await getContract(tx, contractId))?.consumedCallouts ?? -1;
      check("no callouts yet — every job so far came from the schedule", calloutBefore, 0);

      const calloutJobs = (await tx.execute<{ id: string }>(sql`
        insert into jobs (tenant_id, reference, customer_id, property_id, service_slug, title,
                          status, priority, source, contract_id, is_contract_covered)
        values
          (${tenantId}::uuid, ${`${TAG}-CALLOUT-1`}, ${target.customer_id}::uuid,
           ${target.property_id}::uuid, 'plumbing-sanitary', ${`${TAG} leak callout`},
           'triaged', 'p2_urgent', 'phone', ${contractId}::uuid, true),
          (${tenantId}::uuid, ${`${TAG}-CALLOUT-2`}, ${target.customer_id}::uuid,
           ${target.property_id}::uuid, 'plumbing-sanitary', ${`${TAG} called-off callout`},
           'cancelled', 'p2_urgent', 'phone', ${contractId}::uuid, true)
        returning id
      `)) as unknown as { id: string }[];
      for (const j of calloutJobs) jobIdsToPurge.push(j.id);

      const calloutAfter = (await getContract(tx, contractId))?.consumedCallouts ?? -1;
      check("a phone job against the contract consumes a callout", calloutAfter, 1);
      // The case the stored counter could not have got right: a callout that was
      // called off was never consumed, and nothing decremented anything.
      check("but a cancelled one does not", calloutAfter, calloutBefore + 1);

      const unlimited = await getContract(tx, contractId);
      check("this contract is unlimited, so there is no term ceiling", unlimited?.calloutsForTerm, null);

      // ── CON-6: out of scope raises a quote ──────────────────────────────
      console.log("\n— CON-6: out-of-scope work raises a quote —");

      const scopeCovered = await checkContractScope(tx, contractId, {
        serviceSlug: "hvac-installation-maintenance",
      });
      check("routine AC work is covered", scopeCovered.verdict, "covered");

      const scopeExcluded = await checkContractScope(tx, contractId, {
        serviceSlug: "hvac-installation-maintenance",
        matchedExclusionCodes: ["compressor_replacement"],
      });
      check("a compressor replacement is excluded", scopeExcluded.verdict, "excluded");
      check("and quotable at 15%", scopeExcluded.discountBasisPoints, 1500);

      const scopeOutside = await checkContractScope(tx, contractId, { serviceSlug: "tiling" });
      check("tiling is not covered by this contract", scopeOutside.verdict, "not_covered");

      // The quote itself. 2,000.00 at 15% off is 1,700.00; VAT at 5% is 85.00,
      // total 1,785.00. VAT AFTER the discount — the other order overstates the
      // tax and understates the margin.
      const quote = await quoteOutOfScopeWork(tx, ctx, {
        contractId,
        jobId: firstJobId,
        title: `${TAG} compressor replacement`,
        lines: [
          { description: "Compressor, 3 ton", quantity: "1", unit: "ea", unitPrice: "2000.00" },
        ],
        scope: {
          serviceSlug: "hvac-installation-maintenance",
          matchedExclusionCodes: ["compressor_replacement"],
        },
      });
      quoteIds.push(quote.quoteId);

      check("the quote totals 1,785.00 — VAT after discount", quote.totalMinor, toMinor("1785.00"));

      const quoteRows = (await tx.execute<{
        subtotal: string;
        discount_amount: string;
        tax_amount: string;
      }>(sql`
        select subtotal, discount_amount, tax_amount from quotes where id = ${quote.quoteId}
      `)) as unknown as { subtotal: string; discount_amount: string; tax_amount: string }[];
      check("subtotal is the pre-discount price", quoteRows[0]?.subtotal, "2000.00");
      check("the contract discount is recorded", quoteRows[0]?.discount_amount, "300.00");
      check("and VAT is 5% of the discounted amount", quoteRows[0]?.tax_amount, "85.00");

      // The job must stop being contract-covered, or the invoice run skips it
      // and the work is absorbed after all — which is the exact outcome CON-6
      // exists to prevent.
      const jobAfterQuote = (await tx.execute<{
        is_contract_covered: boolean;
        requires_quote_approval: boolean;
        quote_id: string | null;
      }>(sql`
        select is_contract_covered, requires_quote_approval, quote_id
          from jobs where id = ${firstJobId}
      `)) as unknown as {
        is_contract_covered: boolean;
        requires_quote_approval: boolean;
        quote_id: string | null;
      }[];
      check(
        "the quoted job is no longer contract-covered",
        jobAfterQuote[0]?.is_contract_covered,
        false,
      );
      check("and needs approval", jobAfterQuote[0]?.requires_quote_approval, true);

      // Quoting covered work would bill the customer twice for one entitlement.
      let refusedCoveredQuote = false;
      try {
        await tx.transaction(async (inner) => {
          await quoteOutOfScopeWork(inner, ctx, {
            contractId,
            jobId: firstJobId,
            title: `${TAG} should be refused`,
            lines: [{ description: "Routine service", quantity: "1", unit: "ea", unitPrice: "100.00" }],
            scope: { serviceSlug: "hvac-installation-maintenance" },
          });
        });
      } catch {
        refusedCoveredQuote = true;
      }
      checkTrue("quoting work the contract covers is REFUSED", refusedCoveredQuote);

      // ── CON-6: the scope check has an entry point ───────────────────────
      //
      // `checkContractScope` shipped correct and unreachable — nothing in the
      // application called it, so the mechanism that stops work being absorbed
      // could not fire. `jobContractScope` is what the job detail page renders
      // from, on every contract job and with nobody pressing anything, so these
      // assertions are about the automatic half: the verdict a page can state
      // before a technician has said a word.
      console.log("\n— CON-6: the automatic scope check —");

      const autoScope = await jobContractScope(tx, firstJobId);
      checkTrue("a contract job resolves its contract", autoScope !== null);
      check("and reports the reference the banner shows", autoScope?.contractReference, created.reference);
      check("with the coverage type the panel branches on", autoScope?.coverageType, "comprehensive");
      // The exclusions offered are THIS contract's three, not the standard
      // catalogue. A code the contract does not carry cannot change the
      // verdict, so offering it would be a control that does nothing.
      check("it offers this contract's own exclusions", autoScope?.exclusions.length, 3);
      checkTrue(
        "and only ones the contract actually carries",
        (autoScope?.exclusions ?? []).every((e) =>
          ["compressor_replacement", "fan_motor_replacement", "waterproofing"].includes(e.code),
        ),
      );
      // `firstJobId` was quoted above, but the verdict is about coverage and
      // entitlement, not about whether somebody already raised a quote.
      checkTrue(
        "the verdict is one decideScope produces",
        ["covered", "excluded", "entitlement_exhausted", "not_covered", "parts_not_covered"].includes(
          autoScope?.decision.verdict ?? "",
        ),
      );

      // The other half of "reachable": a job with no contract must produce no
      // banner at all rather than an empty or a wrong one. Most jobs are this.
      const plainJobs = (await tx.execute<{ id: string }>(sql`
        select id from jobs
         where contract_id is null and deleted_at is null
         limit 1
      `)) as unknown as { id: string }[];
      const plainJobId = plainJobs[0]?.id;
      checkTrue("the seed has a job that is not contract work", plainJobId !== undefined);
      if (plainJobId) {
        check("a job with no contract has no scope", await jobContractScope(tx, plainJobId), null);
      }

      // ── CON-5: the customer record's filter ─────────────────────────────
      console.log("\n— CON-5: contracts by customer —");

      contractCustomerId = target.customer_id;
      otherCustomerId = otherCustomerProperty?.customer_id ?? "";

      const mineOnly = await listContracts(tx, {
        customerId: contractCustomerId,
        includeEnded: true,
      });
      checkTrue("the customer's own contract is in the filtered list", mineOnly.some((c) => c.id === contractId));
      checkTrue(
        "and every row belongs to that customer",
        mineOnly.every((c) => c.customerId === contractCustomerId),
      );
      // The entitlement travels with the row. Without it the customer record
      // would have to call getContract once per contract to answer CON-5.
      const mineRow = mineOnly.find((c) => c.id === contractId);
      check("the row carries its entitlements", mineRow?.entitlements.length, 2);
      check(
        "measured over the term, like every other entitlement figure",
        mineRow?.entitlements.find((e) => e.serviceSlug === "hvac-installation-maintenance")
          ?.entitledForTerm,
        4,
      );

      checkTrue("the seed has a second customer to scope against", otherCustomerId !== "");
      if (otherCustomerId) {
        const theirs = await listContracts(tx, { customerId: otherCustomerId, includeEnded: true });
        checkTrue(
          "another customer's filtered list does not contain it",
          !theirs.some((c) => c.id === contractId),
        );
      }

      // ── CON-7: PPM compliance ───────────────────────────────────────────
      console.log("\n— CON-7: PPM compliance —");

      const compliance = await ppmCompliance(tx, { contractId });
      const mine = compliance[0];
      checkTrue("the contract appears in the compliance view", mine !== undefined);
      checkTrue("its scheduled count matches the schedule", (mine?.scheduled ?? 0) > 0);
      checkTrue(
        "completion is a percentage of what was due, not of the whole term",
        (mine?.percent ?? -1) >= 0 && (mine?.percent ?? 101) <= 100,
      );
      checkTrue(
        "the aggregate view still lists every contract it did before, plus this one",
        (await ppmCompliance(tx)).length >= complianceBefore + 1,
      );

      // ── CON-8 / CON-9: renewal ──────────────────────────────────────────
      console.log("\n— CON-8, CON-9: renewal —");

      // 265 days out, so it must NOT be in the 90-day pipeline yet. A pipeline
      // that includes everything is a pipeline nobody reads.
      const pipeline = await renewalPipeline(tx);
      checkTrue(
        "a contract 265 days out is not in the 90-day pipeline",
        !pipeline.some((p) => p.contractId === contractId),
      );

      const widePipeline = await renewalPipeline(tx, 3650);
      const entry = widePipeline.find((p) => p.contractId === contractId);
      checkTrue("but it is there on a wider window", entry !== undefined);
      // The PPM jobs plus the one live callout. The cancelled callout is
      // excluded, by the same rule the callout count uses — a renewal priced on
      // work that was called off overstates what was delivered.
      check("with its job count, cancelled work excluded", entry?.jobsInTerm, ours.length + 1);
      check("and its entitlement total over the term", entry?.entitledVisits, 6);

      // Move the end date inside the ladder and confirm the reminder fires.
      await tx.execute(sql`
        update contracts set ends_on = now() + interval '45 days' where id = ${contractId}
      `);

      const expiring = await findExpiringContracts(tx);
      const dueRenewal = expiring.find((c) => c.contractId === contractId);
      checkTrue("45 days out, the contract is due a reminder", dueRenewal !== undefined);
      check("on the T-60 rung", dueRenewal?.band, 60);

      // The idempotency guarantee behind CON-9. A time window cannot tell a
      // 60-day notice from a 30-day one; the ledger can.
      const userRows = (await tx.execute<{ id: string }>(sql`
        select u.id from users u
          join memberships m on m.user_id = u.id
         where m.tenant_id = ${tenantId}::uuid and m.is_active
         limit 1
      `)) as unknown as { id: string }[];
      const recipientUserId = userRows[0]?.id;

      if (recipientUserId) {
        check(
          "nothing has been sent yet",
          await renewalNoticeSent(tx, { contractId, band: 60, recipientUserId }),
          false,
        );
        await recordRenewalNotice(tx, { tenantId }, { contractId, band: 60, recipientUserId });
        check(
          "the T-60 rung is now recorded",
          await renewalNoticeSent(tx, { contractId, band: 60, recipientUserId }),
          true,
        );
        // Recording twice must not throw — schedulers double-fire.
        await recordRenewalNotice(tx, { tenantId }, { contractId, band: 60, recipientUserId });
        check(
          "the T-30 rung is still unsent",
          await renewalNoticeSent(tx, { contractId, band: 30, recipientUserId }),
          false,
        );
      } else {
        console.log("      skipped: this tenant has no active member to notify");
      }

      const renewal = await generateRenewalQuote(tx, ctx, contractId);
      quoteIds.push(renewal.quoteId);
      check(
        "the renewal quote is the contract value plus VAT",
        renewal.totalMinor,
        toMinor("44100.00"),
      );

      const renewalNotes = (await tx.execute<{ notes: string | null }>(sql`
        select notes from quotes where id = ${renewal.quoteId}
      `)) as unknown as { notes: string | null }[];
      checkTrue(
        "and it carries the actuals it was priced from",
        (renewalNotes[0]?.notes ?? "").includes("utilisation"),
      );

      // ── CON-10: documents ───────────────────────────────────────────────
      console.log("\n— CON-10: documents are versioned —");

      const v1 = await attachContractDocument(tx, ctx, {
        contractId,
        kind: "signed_contract",
        title: `${TAG} signed contract`,
        storageKey: "contracts/test/signed-v1.pdf",
      });
      check("the first attachment is version 1", v1.version, 1);

      const v2 = await attachContractDocument(tx, ctx, {
        contractId,
        kind: "signed_contract",
        title: `${TAG} signed contract, countersigned`,
        storageKey: "contracts/test/signed-v2.pdf",
      });
      check("re-attaching the same kind is version 2", v2.version, 2);

      const documents = await listContractDocuments(tx, contractId);
      check("both versions are kept", documents.length, 2);
      check(
        "and only the latest is current",
        documents.filter((d) => d.isCurrent).length,
        1,
      );
      check(
        "the current one is version 2",
        documents.find((d) => d.isCurrent)?.version,
        2,
      );
    });

    // ── CON-5: what the customer paying for it can see ────────────────────
    //
    // Outside the transaction above, deliberately: `withCustomerScope` opens
    // its own, so these run against committed rows and against the RESTRICTIVE
    // policies rather than against anything this file filtered by hand. Not one
    // query below carries a `customer_id =` predicate — that is the property
    // being asserted. If the policy were missing, the "another customer"
    // assertions would fail rather than passing on an application filter.
    console.log("\n— CON-5: the portal —");

    // What the office sees, read now rather than earlier: the CON-9 assertions
    // above move `ends_on` to 45 days out, and entitlement is scaled to the
    // term, so a figure captured before that would be measuring a term the
    // contract no longer has.
    const staffView = await withTenant(ctx, (tx) => getContract(tx, contractId));
    const staffAcEntitlement = staffView?.entitlements.find(
      (e) => e.serviceSlug === "hvac-installation-maintenance",
    );
    checkTrue("the office has an AC entitlement to compare against", staffAcEntitlement !== undefined);

    await withCustomerScope({ tenantId, customerId: contractCustomerId }, async (tx) => {
      const mine = await listPortalContracts(tx);
      const ours = mine.find((c) => c.id === contractId);
      checkTrue("the customer sees their own contract", ours !== undefined);
      check("with both entitlements on it", ours?.entitlements.length, 2);
      const portalAc = ours?.entitlements.find(
        (e) => e.serviceSlug === "hvac-installation-maintenance",
      );
      // The invariant that matters is not a literal, it is agreement: the
      // customer and the office must be quoting each other the same number, or
      // the renewal conversation starts with two figures.
      check(
        "the customer's entitlement matches the office's, over the term",
        portalAc?.entitledForTerm,
        staffAcEntitlement?.entitledForTerm,
      );
      check(
        "and so does consumption",
        portalAc?.consumedVisits,
        staffAcEntitlement?.consumedVisits,
      );

      // Objects with a label and a sentence, not codes. `contracts.exclusions`
      // is the customer-facing list precisely because it carries the prose;
      // reading it as an array of strings produced an empty list on every
      // contract and was caught here rather than in the browser.
      checkTrue(
        "and the carve-outs written for them, from the contract header",
        (ours?.exclusions.length ?? 0) > 0,
      );
      checkTrue(
        "each one carrying the sentence written for a customer, not a code",
        (ours?.exclusions ?? []).every((x) => x.label !== "" && x.label !== x.code),
      );

      // The entitlement table is open to them, which is the policy this work
      // added. Asserted directly rather than only through the read above, so a
      // future query that stops using `listPortalContracts` still has the
      // boundary tested.
      const ownEntitlements = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from contract_entitlements where contract_id = ${contractId}
      `)) as unknown as { count: number }[];
      check("the entitlement rows are readable", ownEntitlements[0]?.count, 2);

      // And these stay shut. `contract_terms` carries the discount rate and the
      // payment terms — the position an out-of-scope quote is priced from —
      // and `contract_exclusions` exists for CON-6 machine matching, not for
      // reading. Neither is named by CON-5.
      const terms = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from contract_terms
      `)) as unknown as { count: number }[];
      check("the commercial terms behind it stay closed", terms[0]?.count, 0);

      const exclusionRows = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from contract_exclusions
      `)) as unknown as { count: number }[];
      check("and so does the machine-matching exclusion table", exclusionRows[0]?.count, 0);
    });

    if (otherCustomerId) {
      await withCustomerScope({ tenantId, customerId: otherCustomerId }, async (tx) => {
        const theirs = await listPortalContracts(tx);
        checkTrue(
          "another customer in the same tenant does not see this contract",
          !theirs.some((c) => c.id === contractId),
        );

        const strayEntitlements = (await tx.execute<{ count: number }>(sql`
          select count(*)::int as count from contract_entitlements where contract_id = ${contractId}
        `)) as unknown as { count: number }[];
        check(
          "nor its entitlements, asked for by id",
          strayEntitlements[0]?.count,
          0,
        );
      });
    }
  } finally {
    // ── Cleanup ───────────────────────────────────────────────────────────
    //
    // In a `finally`, so a failed assertion does not leave a contract behind
    // that makes the next run's deltas wrong. Deleting the contract cascades
    // its terms, entitlements, exclusions, visits, documents and notices;
    // `contract_visits.job_id` is ON DELETE SET NULL on the job side, so the
    // jobs and quotes have to go explicitly.
    await withTenant({ tenantId, actorKind: "system" }, async (tx) => {
      for (const quoteId of quoteIds) {
        await tx.execute(sql`delete from quote_lines where quote_id = ${quoteId}`);
        await tx.execute(sql`delete from quotes where id = ${quoteId}`);
      }

      // Visits belonging to contracts this test did not create go back to
      // `planned` with no job, so the next run — and the next cron — sees the
      // same state this one did.
      for (const { visitId, jobId } of materialisedAll) {
        await tx.execute(sql`
          update contract_visits set status = 'planned', job_id = null, updated_at = now()
           where id = ${visitId}
        `);
        await tx.execute(sql`delete from job_events where job_id = ${jobId}`);
        await tx.execute(sql`delete from quote_lines where quote_id in (
          select id from quotes where job_id = ${jobId}
        )`);
        await tx.execute(sql`delete from quotes where job_id = ${jobId}`);
        await tx.execute(sql`delete from jobs where id = ${jobId}`);
      }

      for (const jobId of jobIdsToPurge) {
        await tx.execute(sql`delete from job_events where job_id = ${jobId}`);
        await tx.execute(sql`delete from jobs where id = ${jobId}`);
      }

      if (contractId) {
        await tx.execute(sql`delete from contracts where id = ${contractId}`);
      }

      // The synthetic holidays are tenant reference data, not test fixtures the
      // schema will cascade away. Leaving them would silently move every PPM
      // date every other test and every seed generates afterwards.
      for (const holiday of TEST_HOLIDAYS) {
        await tx.execute(sql`
          delete from public_holidays where holiday_date = ${holiday.date}::date and name = ${holiday.name}
        `);
      }
    });

    // Notifications are not written by anything in this file — the CON-9 email
    // is enqueued by the cron route, not by the domain layer — so there is
    // nothing to sweep there. Said out loud rather than left as an assumption.
    //
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
        select count(*)::int as count from contracts where name like ${`${TAG}%`}
      `)) as unknown as { count: number }[];

      const strayJobs = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from jobs
         where id = any(${sql`array[${sql.join(
           [...materialisedAll.map((m) => sql`${m.jobId}`), sql`'00000000-0000-0000-0000-000000000000'`],
           sql`, `,
         )}]::uuid[]`})
      `)) as unknown as { count: number }[];

      const strayHolidays = (await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from public_holidays where name like ${`${TAG}%`}
      `)) as unknown as { count: number }[];

      return {
        contracts: leftovers[0]?.count,
        jobs: strayJobs[0]?.count,
        holidays: strayHolidays[0]?.count,
      };
    });

    check("no test contract survived cleanup", survivors.contracts, 0);
    check("and no job it raised survived either", survivors.jobs, 0);
    check("and the synthetic holidays are gone", survivors.holidays, 0);
  }

  console.log(fail === 0 ? "\nAll contract checks passed.\n" : `\n${fail} check(s) FAILED.\n`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
