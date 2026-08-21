/**
 * Tender pipeline and pack inputs — `CON-11`, `CON-12`.
 *
 * Four claims are worth a test here, and none of them is CRUD:
 *
 *  1. **The queue is deadline-driven.** `CON-11` says *sorted by days until
 *     deadline, always*, and the way that requirement dies is somebody adding a
 *     "newest first" option. So the test proves the order for a set of tenders
 *     deliberately created in the wrong one, and proves that an overdue tender
 *     sorts to the top rather than dropping off.
 *  2. **A day is a day.** The deadline goes in as `YYYY-MM-DD` and comes back
 *     as the same string, and "how many days left" is decided by Postgres
 *     against `current_date` — not by a JS `Date` that moves the boundary by
 *     the reader's UTC offset and reports a tender as closing a day early.
 *  3. **The pack is assembled from live data.** Change the register, and the
 *     next set of pack inputs changes with it — that is the whole of `CON-12`'s
 *     "so it is always current", and the only way to prove it is to move
 *     something and read it back.
 *  4. **The pack refuses.** Expire the insurance certificate and the pack will
 *     not build, naming what lapsed. A pack containing a lapsed certificate is
 *     worse than one that refuses.
 *
 *   npx tsx test/tenders.test.ts
 *
 * Requires the schema, RLS and migration 0030. Creates its own fixtures rather
 * than leaning on the seed, and cleans up everything it made.
 */

import { eq, inArray, sql } from "drizzle-orm";
import {
  withTenant,
  createTender,
  updateTender,
  setTenderProperties,
  markTenderSubmitted,
  recordTenderOutcome,
  tenderQueue,
  getTender,
  tenderPackInputs,
  listTenderSources,
  listTenderOutcomeReasons,
  installStandardTenderVocabularies,
  STANDARD_TENDER_SOURCES,
  STANDARD_TENDER_OUTCOME_REASONS,
  registerAsset,
  addRateVersion,
  recordAccreditation,
  listAssetCategories,
  schema,
  closeConnection,
} from "../src/index";
import {
  UserFacingError,
  assertTenderPackRenderable,
  tenderPackWarnings,
  TenderPackNotRenderableError,
  tenderUrgency,
  tenderDeadlineNote,
} from "@meridian/core";
import { testTenantId, otherTenantId } from "./_tenant";

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const TAG = `__TEST ${RUN}`;

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
 * Every message in an error's cause chain, joined.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose own message is
 * only "Failed query: ..." — the constraint name that says *why* Postgres
 * refused is on `.cause`. Asserting against the outer message alone silently
 * matches nothing, so the check fails while the database is behaving perfectly,
 * or passes for a reason nobody intended. Borrowed from `jobcard.test.ts`,
 * which is where this was worked out.
 */
function messageChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" | ");
}

/**
 * Run a statement that the database itself should refuse, and return the whole
 * cause chain.
 *
 * Each attempt gets its own transaction on purpose: a failed statement aborts
 * the one it ran in, so a second attempt in the same `withTenant` would fail
 * with "current transaction is aborted" and every constraint after the first
 * would appear to hold whether or not it exists.
 */
async function constraintRefusal(statement: ReturnType<typeof sql>): Promise<string> {
  try {
    await withTenant(constraintCtx, (tx) => tx.execute(statement));
    return "(no error thrown)";
  } catch (error) {
    return messageChain(error);
  }
}

let constraintCtx = { tenantId: "", actorKind: "system" as const };

/** The message, or the marker that says nothing was thrown at all. */
async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "(no error thrown)";
  } catch (error) {
    if (error instanceof UserFacingError) return error.message;
    throw error;
  }
}

/**
 * A day offset from *the database's* today, as the string the columns store.
 *
 * Anchored to `current_date` read once at the start of the run, not to
 * `new Date()`. The first version of this helper used the UTC day and the
 * "five days out" check failed with 4 — because `current_date` follows the
 * database server's timezone, and on a machine east of UTC late in the evening
 * the server's day is already tomorrow.
 *
 * That is the same one-day slip the whole feature is arranged to prevent,
 * arriving through the test's own clock. The production code never has this
 * problem: every day count in `domain/tenders.ts` is `date - current_date`
 * computed inside Postgres, so there is exactly one clock. The fix here is to
 * make the test use that clock too rather than to widen the assertion, which
 * would have hidden a genuine off-by-one in the queue just as effectively.
 */
let dayBase = 0;

function day(offset: number): string {
  return new Date(dayBase + offset * 86_400_000).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };
  constraintCtx = ctx;

  const todayRows = (await withTenant(ctx, (tx) =>
    tx.execute<{ today: string }>(sql`select to_char(current_date, 'YYYY-MM-DD') as today`),
  )) as unknown as { today: string }[];
  const today = todayRows[0]?.today;
  if (!today) throw new Error("could not read the database's current date");
  dayBase = Date.parse(`${today}T00:00:00.000Z`);

  const createdTenders: string[] = [];
  const createdAssets: string[] = [];
  const createdProperties: string[] = [];
  const createdRateCodes: string[] = [];
  const createdAccreditations: string[] = [];

  try {
    // ── The vocabularies exist ─────────────────────────────────────────────
    //
    // A controlled-vocabulary table with an empty picker is worse than a text
    // column, because it looks governed and is not. This repo has shipped that
    // bug once already.
    const sources = await withTenant(ctx, (tx) => listTenderSources(tx, { activeOnly: true }));
    checkTrue(
      "CON-11: the opportunity-source vocabulary is seeded, not empty",
      sources.length >= STANDARD_TENDER_SOURCES.length,
    );
    for (const expected of STANDARD_TENDER_SOURCES) {
      checkTrue(
        `CON-11: "${expected.code}" is in the picker`,
        sources.some((s) => s.code === expected.code),
      );
    }

    const reinstalled = await withTenant(ctx, (tx) =>
      installStandardTenderVocabularies(tx, { tenantId }),
    );
    check("installing the standard vocabularies again writes nothing", reinstalled, 0);

    const lostReasons = await withTenant(ctx, (tx) =>
      listTenderOutcomeReasons(tx, { for: "lost", activeOnly: true }),
    );
    const wonReasons = await withTenant(ctx, (tx) =>
      listTenderOutcomeReasons(tx, { for: "won", activeOnly: true }),
    );
    checkTrue(
      "CON-11: a loss can be attributed to an incomplete pack",
      lostReasons.some((r) => r.code === "incomplete_pack"),
    );
    checkTrue(
      "a losing reason is not offered as an explanation for a win",
      !wonReasons.some((r) => r.code === "incomplete_pack"),
    );
    checkTrue(
      'a "both" reason appears under either outcome',
      wonReasons.some((r) => r.code === "price") && lostReasons.some((r) => r.code === "price"),
    );
    check(
      "the whole list is there for the administration screen",
      (await withTenant(ctx, (tx) => listTenderOutcomeReasons(tx))).length >=
        STANDARD_TENDER_OUTCOME_REASONS.length,
      true,
    );

    const oaSource = sources.find((s) => s.code === "oa_management_company");
    if (!oaSource) throw new Error("the seeded vocabulary is missing the channel this test needs");

    // ── A tender needs a real deadline ─────────────────────────────────────
    check(
      "CON-11: a deadline that is not a calendar date is refused",
      await refusal(() =>
        withTenant(ctx, (tx) =>
          createTender(tx, ctx, {
            title: `${TAG} bad date`,
            issuingBody: "Nowhere OA",
            opportunitySourceId: oaSource.id,
            submissionDeadline: "18/09/2026",
          }),
        ),
      ),
      "The submission deadline must be a calendar date, as YYYY-MM-DD.",
    );

    check(
      "a date that matches the pattern and is not a day is refused, not coerced",
      await refusal(() =>
        withTenant(ctx, (tx) =>
          createTender(tx, ctx, {
            title: `${TAG} impossible date`,
            issuingBody: "Nowhere OA",
            opportunitySourceId: oaSource.id,
            submissionDeadline: "2026-02-31",
          }),
        ),
      ),
      "2026-02-31 is not a real date.",
    );

    checkTrue(
      "a decision date before the deadline is refused",
      (
        await refusal(() =>
          withTenant(ctx, (tx) =>
            createTender(tx, ctx, {
              title: `${TAG} backwards`,
              issuingBody: "Nowhere OA",
              opportunitySourceId: oaSource.id,
              submissionDeadline: day(30),
              decisionDate: day(10),
            }),
          ),
        )
      ).includes("before the submission deadline"),
    );

    // ── The queue, created deliberately out of order ───────────────────────
    //
    // Recorded newest-deadline first, so a queue that fell back to created_at
    // or to insertion order would produce exactly the reverse of what CON-11
    // asks for and the ordering check below would catch it.
    const spec = [
      { label: "far", deadline: day(60) },
      { label: "soon", deadline: day(5) },
      { label: "overdue", deadline: day(-9) },
      { label: "middle", deadline: day(25) },
    ] as const;

    const ids = new Map<string, string>();
    for (const s of spec) {
      const created = await withTenant(ctx, (tx) =>
        createTender(tx, ctx, {
          title: `${TAG} ${s.label}`,
          issuingBody: `${s.label} management company`,
          opportunitySourceId: oaSource.id,
          submissionDeadline: s.deadline,
          budgetCycle: "2027",
        }),
      );
      createdTenders.push(created.id);
      ids.set(s.label, created.id);
      checkTrue(
        `a tender reference was allocated for the ${s.label} one`,
        /^TND-\d{4}-\d{5}$/.test(created.reference),
      );
    }

    const queue = (await withTenant(ctx, (tx) => tenderQueue(tx))).filter((t) =>
      t.title.startsWith(TAG),
    );

    check("CON-11: every open tender is in the queue", queue.length, 4);
    check(
      "CON-11: the queue is sorted by days until deadline, always",
      queue.map((t) => t.title.replace(`${TAG} `, "")).join(","),
      "overdue,soon,middle,far",
    );
    checkTrue(
      "CON-11: an overdue tender is at the top, not dropped quietly",
      queue[0]?.daysRemaining !== undefined && queue[0].daysRemaining < 0,
    );

    // The day arithmetic, done by Postgres and read back.
    const soon = queue.find((t) => t.title.endsWith("soon"));
    check("days remaining is computed against current_date, not a JS clock", soon?.daysRemaining, 5);
    check("the deadline is the string that went in", soon?.submissionDeadline, day(5));
    check("five days out reads as critical", tenderUrgency(soon?.daysRemaining ?? 0), "critical");
    check("and says so in words", tenderDeadlineNote(5), "5 days left");
    check("an overdue tender does not read as -9 days left", tenderDeadlineNote(-9), "Closed 9 days ago");

    // ── Outcome and reason (CON-11) ────────────────────────────────────────
    const overdueId = ids.get("overdue");
    const soonId = ids.get("soon");
    const farId = ids.get("far");
    if (!overdueId || !soonId || !farId) throw new Error("fixtures did not come back");

    checkTrue(
      "CON-11: a lost tender cannot be recorded without a reason",
      (
        await refusal(() =>
          withTenant(ctx, (tx) =>
            recordTenderOutcome(tx, ctx, { tenderId: overdueId, outcome: "lost" }),
          ),
        )
      ).includes("needs a reason"),
    );

    const lateReason = lostReasons.find((r) => r.code === "late_submission");
    if (!lateReason) throw new Error("the seeded reasons are missing late_submission");

    checkTrue(
      "a losing reason cannot be used to explain a win",
      (
        await refusal(() =>
          withTenant(ctx, (tx) =>
            recordTenderOutcome(tx, ctx, {
              tenderId: overdueId,
              outcome: "won",
              reasonId: lateReason.id,
            }),
          ),
        )
      ).includes("not a won one"),
    );

    await withTenant(ctx, (tx) =>
      recordTenderOutcome(tx, ctx, {
        tenderId: overdueId,
        outcome: "lost",
        reasonId: lateReason.id,
        note: `${TAG} closed before the pack was ready`,
        decidedOn: day(-2),
      }),
    );

    const afterOutcome = (await withTenant(ctx, (tx) => tenderQueue(tx))).filter((t) =>
      t.title.startsWith(TAG),
    );
    check("a decided tender leaves the open queue", afterOutcome.length, 3);
    check(
      "and the queue is still deadline-ordered without it",
      afterOutcome.map((t) => t.title.replace(`${TAG} `, "")).join(","),
      "soon,middle,far",
    );

    const withClosed = (await withTenant(ctx, (tx) => tenderQueue(tx, { includeClosed: true }))).filter(
      (t) => t.title.startsWith(TAG),
    );
    check("asking for the closed ones brings them back", withClosed.length, 4);
    check(
      "and they sort after the open ones, still by deadline",
      withClosed.map((t) => t.title.replace(`${TAG} `, "")).join(","),
      "soon,middle,far,overdue",
    );
    check(
      "CON-11: the loss carries its reason",
      withClosed.find((t) => t.title.endsWith("overdue"))?.outcomeReasonLabel,
      "Submitted late",
    );

    checkTrue(
      "a decided tender cannot then be marked submitted",
      (
        await refusal(() =>
          withTenant(ctx, (tx) => markTenderSubmitted(tx, overdueId, { submittedOn: day(-10) })),
        )
      ).includes("already recorded as Lost"),
    );

    // Submission is a fact with its own date, not an outcome.
    await withTenant(ctx, (tx) =>
      markTenderSubmitted(tx, soonId, { submittedOn: day(-1), bidValueMinor: 31_200_000 }),
    );
    const submitted = await withTenant(ctx, (tx) => getTender(tx, soonId));
    check("CON-11: the submission date is recorded", submitted?.submittedOn, day(-1));
    check("and does not change the outcome", submitted?.outcome, "pending");
    check("CON-11: the bid value is stored in minor units", submitted?.bidValueMinor, 31_200_000);

    // ── The database refuses too, not only the domain layer ────────────────
    //
    // Every refusal above came from `domain/tenders.ts`, which is the friendly
    // one: it explains itself and the screen shows the sentence. These check
    // the constraints underneath, reached by raw SQL that goes round the domain
    // layer entirely — because that is the path that matters. A tender is most
    // likely to be edited by hand during an incident, or by a feature written
    // next year that forgets to call `recordTenderOutcome`, and a rule that
    // lives only in TypeScript is a rule that is not there on either occasion.
    //
    // Asserted against the CAUSE CHAIN, never `error.message`: Drizzle's own
    // message is "Failed query: ..." and the constraint name is one level down.
    const middleId = ids.get("middle");
    if (!middleId) throw new Error("fixtures did not come back");

    checkTrue(
      "CON-11: the database refuses a lost tender with no reason",
      (
        await constraintRefusal(
          sql`update tenders set outcome = 'lost', outcome_reason_id = null where id = ${middleId}::uuid`,
        )
      ).includes("tenders_loss_needs_reason"),
    );

    checkTrue(
      "the database refuses a decision date before the closing date",
      (
        await constraintRefusal(
          sql`update tenders set decision_date = submission_deadline - 1 where id = ${middleId}::uuid`,
        )
      ).includes("tenders_decision_after_deadline"),
    );

    checkTrue(
      "the database refuses an outcome that is not one of the five",
      (
        await constraintRefusal(
          sql`update tenders set outcome = 'shortlisted' where id = ${middleId}::uuid`,
        )
      ).includes("tenders_outcome"),
    );

    checkTrue(
      "a negative competitor count is refused; unknown is null, not -1",
      (
        await constraintRefusal(
          sql`update tenders set competitors_known = -1 where id = ${middleId}::uuid`,
        )
      ).includes("tenders_competitors_non_negative"),
    );

    checkTrue(
      "an outcome reason must apply to won, lost or both",
      (
        await constraintRefusal(
          sql`update tender_outcome_reasons set applies_to = 'maybe' where code = 'price'`,
        )
      ).includes("tender_outcome_reasons_applies_to"),
    );

    // And the tender came through all of that untouched — every one of those
    // statements was rolled back, so `middle` is still exactly where the queue
    // left it. A constraint check that silently mutated its fixture would make
    // every assertion after it read the wrong row.
    const untouched = await withTenant(ctx, (tx) => getTender(tx, middleId));
    check("the refused statements changed nothing", untouched?.outcome, "pending");
    check("and left the decision date alone", untouched?.decisionDate, null);

    // ── Fixtures for the pack ──────────────────────────────────────────────
    const [customer] = await withTenant(ctx, (tx) =>
      tx.select({ id: schema.customers.id }).from(schema.customers).limit(1),
    );
    if (!customer) throw new Error("no customer in this tenant — run `npm run db:seed`");

    const [property] = await withTenant(ctx, (tx) =>
      tx
        .insert(schema.properties)
        .values({
          tenantId,
          customerId: customer.id,
          name: `${TAG} tender tower`,
          type: "building" as const,
          addressLine: `${TAG} Sheikh Zayed Road`,
          area: "Business Bay",
          city: "Dubai",
        })
        .returning({ id: schema.properties.id }),
    );
    if (!property) throw new Error("failed to create the tender's property");
    createdProperties.push(property.id);

    const categories = await withTenant(ctx, (tx) => listAssetCategories(tx, { activeOnly: true }));
    const chiller = categories.find((c) => c.code === "chiller");
    if (!chiller) throw new Error("the asset vocabulary is missing chillers — apply migration 0021");

    const asset = await withTenant(ctx, (tx) =>
      registerAsset(tx, ctx, {
        propertyId: property.id,
        categoryId: chiller.id,
        tag: `${RUN}-CH-01`,
        name: "Chiller 1, main plant room",
        manufacturer: "Carrier",
        model: "30XA-1002",
        serialNumber: `CAR-${RUN}`,
        location: "Roof plant room",
        installedOn: day(-2000),
        ppmIntervalDays: 90,
      }),
    );
    createdAssets.push(asset.id);

    const rateCode = `ZZ-TND-${RUN}`;
    await withTenant(ctx, (tx) =>
      addRateVersion(tx, ctx, {
        code: rateCode,
        serviceSlug: "hvac-installation-maintenance",
        label: `${TAG} chiller PPM visit`,
        unit: "visit",
        rateBand: "standard",
        unitPriceMinor: 185_000,
        isPublished: false,
        effectiveFrom: day(-30),
      }),
    );
    createdRateCodes.push(rateCode);

    for (const a of [
      { kind: "trade_licence" as const, name: `${TAG} DET trade licence`, expiresAt: day(200) },
      { kind: "dewa_enrolment" as const, name: `${TAG} DEWA enrolment`, expiresAt: day(300) },
      { kind: "liability_insurance" as const, name: `${TAG} liability policy`, expiresAt: day(150) },
      { kind: "workmen_comp" as const, name: `${TAG} workmen's compensation`, expiresAt: day(150) },
    ]) {
      const row = await withTenant(ctx, (tx) =>
        recordAccreditation(tx, { tenantId }, {
          kind: a.kind,
          name: a.name,
          issuingBody: "__TEST issuer",
          expiresAt: a.expiresAt,
        }),
      );
      createdAccreditations.push(row.id);
    }

    // Every one of them has a storage key, which is what the pack attaches.
    // Set here rather than through a domain function because uploading a file
    // is `packages/files`' job and this suite does not touch object storage —
    // `packages/docs/test/tender-pack.test.ts` covers what happens to the bytes.
    await withTenant(ctx, (tx) =>
      tx
        .update(schema.companyAccreditations)
        .set({ storageKey: `tenants/${tenantId.toLowerCase()}/test/${RUN.toLowerCase()}.pdf` })
        .where(inArray(schema.companyAccreditations.id, createdAccreditations)),
    );

    await withTenant(ctx, (tx) =>
      updateTender(tx, farId, {
        scopeOfWork: `${TAG} planned preventive maintenance for all MEP plant, twelve months.`,
      }),
    );
    const scoped = await withTenant(ctx, (tx) =>
      setTenderProperties(tx, ctx, farId, [property.id]),
    );
    check("the tender is scoped to one building", scoped, 1);

    // A property from another tenant is refused rather than silently attached.
    const otherId = await otherTenantId();
    const [foreign] = await withTenant({ tenantId: otherId, actorKind: "system" }, (tx) =>
      tx.select({ id: schema.properties.id }).from(schema.properties).limit(1),
    );
    if (foreign) {
      checkTrue(
        "a building belonging to another tenant cannot be put in scope",
        (
          await refusal(() =>
            withTenant(ctx, (tx) => setTenderProperties(tx, ctx, farId, [foreign.id])),
          )
        ).includes("not in this tenant's property register"),
      );
      // The refusing call cleared the scope before it checked; put it back.
      await withTenant(ctx, (tx) => setTenderProperties(tx, ctx, farId, [property.id]));
    } else {
      console.log("ok    (the second tenant has no property to test the boundary with)");
    }

    // ── The pack's inputs, read live (CON-12) ──────────────────────────────
    const inputs = await withTenant(ctx, (tx) => tenderPackInputs(tx, farId));

    check("CON-12: the pack date is a calendar day", /^\d{4}-\d{2}-\d{2}$/.test(inputs.preparedOn), true);
    checkTrue(
      "CON-12: the plant list is read from the asset register",
      inputs.document.assets.some((a) => a.serialNumber === `CAR-${RUN}`),
    );
    check(
      "CON-13: the asset's PPM interval comes through",
      inputs.document.assets.find((a) => a.serialNumber === `CAR-${RUN}`)?.ppmIntervalDays,
      90,
    );
    checkTrue(
      "CON-12: the schedule of rates is read from the rate card",
      inputs.document.rates.some((r) => r.code === rateCode && r.unitPriceMinor === 185_000),
    );
    checkTrue(
      "CON-12: the accreditations are read from the register (HR-14)",
      inputs.document.accreditations.some((a) => a.name === `${TAG} DET trade licence`),
    );
    checkTrue(
      "and each one carries whether there is a certificate behind it",
      inputs.document.accreditations
        .filter((a) => a.name.startsWith(TAG))
        .every((a) => a.hasDocument),
    );
    check(
      "CON-12: the evidence list names the file to attach for each",
      inputs.evidence.filter((e) => e.name.startsWith(TAG)).length,
      4,
    );

    // It assembles.
    const validated = assertTenderPackRenderable(inputs.document);
    check("CON-12: a complete pack passes the gate", validated.reference, inputs.document.reference);
    checkTrue(
      "and holding no ISO certificate is warned about rather than invented",
      tenderPackWarnings(validated).some((w) => w.includes("No ISO certification")),
    );

    // ── It is assembled from live data, so live data changes it ────────────
    //
    // The whole of "assembled from the company accreditation register so it is
    // always current". Expire the insurance certificate, ask again, and the
    // pack must refuse — with no cache anywhere to keep the old answer alive.
    const insurance = createdAccreditations[2];
    if (!insurance) throw new Error("the insurance fixture did not come back");

    await withTenant(ctx, (tx) =>
      tx
        .update(schema.companyAccreditations)
        .set({ expiresAt: day(-3) })
        .where(eq(schema.companyAccreditations.id, insurance)),
    );

    const stale = await withTenant(ctx, (tx) => tenderPackInputs(tx, farId));
    let refusedFor: readonly string[] = [];
    try {
      assertTenderPackRenderable(stale.document);
      fail++;
      console.log("FAIL  CON-12: it assembled a pack around a lapsed insurance certificate");
    } catch (error) {
      if (!(error instanceof TenderPackNotRenderableError)) throw error;
      refusedFor = error.problems;
      console.log("ok    CON-12: the pack refuses once the insurance certificate lapses");
    }
    checkTrue(
      "and names the policy that lapsed",
      refusedFor.some((p) => p.includes(`${TAG} liability policy`)),
    );
    checkTrue(
      "and says a lapsed certificate is worse than a refusal",
      refusedFor.some((p) => p.includes("worse than one that refuses to build")),
    );

    // Renew it, and the pack builds again — from the same query, no cache.
    await withTenant(ctx, (tx) =>
      tx
        .update(schema.companyAccreditations)
        .set({ expiresAt: day(400) })
        .where(eq(schema.companyAccreditations.id, insurance)),
    );
    const renewed = await withTenant(ctx, (tx) => tenderPackInputs(tx, farId));
    check(
      "CON-12: renewing it on the register is all it takes",
      assertTenderPackRenderable(renewed.document).reference,
      inputs.document.reference,
    );

    // ── Cross-tenant isolation ─────────────────────────────────────────────
    const acrossTheBoundary = await withTenant({ tenantId: otherId, actorKind: "system" }, (tx) =>
      tenderQueue(tx, { includeClosed: true }),
    );
    check(
      "another tenant sees none of these tenders",
      acrossTheBoundary.filter((t) => t.title.startsWith(TAG)).length,
      0,
    );
    check(
      "and cannot read one by id",
      await withTenant({ tenantId: otherId, actorKind: "system" }, (tx) => getTender(tx, farId)),
      null,
    );
  } finally {
    // Anchored to this run's tag, never to a broad predicate. A cleanup that
    // deletes "every tender" would take another agent's fixtures with it.
    await withTenant(ctx, async (tx) => {
      if (createdTenders.length > 0) {
        await tx.delete(schema.tenderProperties).where(
          inArray(schema.tenderProperties.tenderId, createdTenders),
        );
        await tx.delete(schema.tenders).where(inArray(schema.tenders.id, createdTenders));
      }
      if (createdAccreditations.length > 0) {
        await tx
          .delete(schema.companyAccreditations)
          .where(inArray(schema.companyAccreditations.id, createdAccreditations));
      }
      if (createdRateCodes.length > 0) {
        await tx
          .delete(schema.rateCardItems)
          .where(inArray(schema.rateCardItems.code, createdRateCodes));
      }
      if (createdAssets.length > 0) {
        await tx.delete(schema.assets).where(inArray(schema.assets.id, createdAssets));
      }
      if (createdProperties.length > 0) {
        await tx.delete(schema.properties).where(inArray(schema.properties.id, createdProperties));
      }
    });
  }

  console.log(fail === 0 ? "\nAll tender checks passed." : `\n${fail} check(s) failed.`);
  await closeConnection();
  if (fail > 0) process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
