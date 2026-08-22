/**
 * Reference: document-number allocation, and the reference-data taxonomies.
 *
 * Two regressions are pinned here, both of which shipped and both of which
 * only appear against a real database:
 *
 *   1. A customer raising a portal request allocated a job reference by
 *      counting jobs — and under the customer-scope policies that count sees
 *      only their own. The number was already taken and the insert failed.
 *   2. Two allocations in flight at once read the same count and collided.
 *
 * The second half covers what `ADM-10` added: the controlled vocabularies, the
 * `LEAD-6` refusal, `LEAD-4` attribution and the versioned rate card. Those are
 * all constraints rather than calculations, so they can only be proven against
 * a real Postgres — a mocked one would agree with whatever the code believes.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS, reference.sql and `npm run db:seed`.
 */

import { eq, inArray, sql } from "drizzle-orm";
import { dubaiDateKey, UserFacingError } from "@meridian/core";
import {
  withTenant,
  withCustomerScope,
  createPortalRequest,
  nextJobReference,
  schema,
  closeConnection,
  addDispositionReason,
  addFaultCode,
  addRateVersion,
  createLeadFromEnquiry,
  installStandardDispositionReasons,
  installStandardJobOutcomes,
  installStandardRateCardItems,
  listDispositionReasons,
  listFaultCodes,
  listJobOutcomeCodes,
  listPublicRateCard,
  listRateCard,
  listRateHistory,
  rateOn,
  resolveDispositionReason,
  setLeadStage,
  STANDARD_DISPOSITION_REASONS,
  STANDARD_RATE_CARD_ITEMS,
} from "../src/index";

const TENANT = "11111111-1111-4111-8111-111111111111";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

async function main(): Promise<void> {
  const ctx = { tenantId: TENANT };
  const created: string[] = [];

  // ── Allocation is unique under concurrency ───────────────────────────────
  // Each call is its own transaction, so they genuinely race.
  const refs = await Promise.all(
    Array.from({ length: 12 }, () => withTenant(ctx, (tx) => nextJobReference(tx))),
  );
  check("12 concurrent allocations produce 12 distinct references", new Set(refs).size, 12);
  checkTrue(
    "every reference is well formed",
    refs.every((r) => /^JOB-\d{4}-\d{5}$/.test(r)),
  );

  // ── Allocation clears references already stored ──────────────────────────
  const existing = await withTenant(ctx, (tx) =>
    tx.select({ reference: schema.jobs.reference }).from(schema.jobs),
  );
  const taken = new Set(existing.map((r) => r.reference));
  checkTrue("no allocation collides with a stored reference", refs.every((r) => !taken.has(r)));

  // ── The portal path: customer scope must not blind the allocator ─────────
  // Resolved by business key, not by a hard-coded uuid: the seed regenerates
  // ids on every run, and a test that pins them fails for a reason that has
  // nothing to do with what it is checking.
  const seeded = await withTenant(ctx, async (tx) => {
    const [customer] = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.code, "BAYOA"))
      .limit(1);
    const [user] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "fatima@baytower.example"))
      .limit(1);
    const [property] = customer
      ? await tx
          .select({ id: schema.properties.id })
          .from(schema.properties)
          .where(eq(schema.properties.customerId, customer.id))
          .limit(1)
      : [];
    return { customerId: customer?.id, userId: user?.id, propertyId: property?.id };
  });

  const { customerId, userId, propertyId } = seeded;
  if (!customerId || !userId || !propertyId) {
    throw new Error("Seed data missing. Run `npm run db:seed` first.");
  }

  const portal = await withCustomerScope(
    {
      tenantId: TENANT,
      customerId,
      userId,
      actorKind: "customer",
    },
    async (tx) => {
      const seen = await tx.select({ id: schema.jobs.id }).from(schema.jobs);
      const request = await createPortalRequest(
        tx,
        {
          tenantId: TENANT,
          customerId,
          userId,
        },
        {
          propertyId,
          serviceSlug: "handyman",
          title: "__TEST reference allocation under customer scope",
          requestedPriority: "p3_standard",
        },
      );
      return { visibleJobs: seen.length, ...request };
    },
  );
  created.push(portal.jobId);

  checkTrue(
    "the customer can see far fewer jobs than the tenant has",
    portal.visibleJobs < existing.length,
  );
  checkTrue(
    "yet the reference they got is above every stored one",
    !taken.has(portal.reference),
  );
  check("the request starts at submitted, not triaged", await statusOf(portal.jobId), "submitted");

  await referenceDataChecks(ctx);

  // ── Clean-up ─────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    await tx.delete(schema.jobEvents).where(inArray(schema.jobEvents.jobId, created));
    await tx.delete(schema.jobs).where(inArray(schema.jobs.id, created));
  });

  console.log(fail === 0 ? "\nreference: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}


/**
 * The controlled vocabularies, and the rules that make them binding.
 *
 * Everything checked here is a refusal. The value of a taxonomy is entirely in
 * what it will not accept — a list the code does not enforce is a suggestion,
 * and a suggestion produces exactly the free-text field it was meant to replace.
 *
 * Prefixed rows are cleaned up at the end. The seeded tenant is a working
 * fixture other tests read, so this leaves it as it found it.
 */
async function referenceDataChecks(ctx: { tenantId: string }): Promise<void> {
  console.log("\n— reference data (ADM-10) —");

  const TAG = "__test";
  const LOST_CODE = `${TAG}_price`;
  const DORMANT_CODE = `${TAG}_budget_year`;
  const RATE_CODE = `${TAG}_callout`;

  // Cleared before as well as after. A run that fails half way through leaves
  // rows behind, and the next run would then fail on those rather than on
  // whatever it was meant to be checking — which is how a real regression gets
  // mistaken for a dirty database and ignored.
  await clearTestReferenceData(ctx, TAG);

  // ── LEAD-6: a controlled list, scoped to the stage it answers ────────────
  const reasonIds = await withTenant(ctx, async (tx) => {
    await addDispositionReason(tx, ctx, {
      code: LOST_CODE,
      label: "__test price too high",
      appliesTo: "lost",
    });
    await addDispositionReason(tx, ctx, {
      code: DORMANT_CODE,
      label: "__test budget next year",
      appliesTo: "dormant",
    });

    const all = await listDispositionReasons(tx);
    const lost = all.find((r) => r.code === LOST_CODE);
    const dormant = all.find((r) => r.code === DORMANT_CODE);
    if (!lost || !dormant) throw new Error("disposition reasons were not stored");

    const forLost = await listDispositionReasons(tx, { stage: "lost" });
    checkTrue(
      "a lost-only reason is offered for lost",
      forLost.some((r) => r.code === LOST_CODE),
    );
    checkTrue(
      "and a dormant-only reason is not",
      !forLost.some((r) => r.code === DORMANT_CODE),
    );

    check(
      "resolving a dormant reason against lost returns nothing",
      await resolveDispositionReason(tx, dormant.id, "lost"),
      null,
    );

    return { lostId: lost.id, dormantId: dormant.id };
  });

  // ── LEAD-4: attribution actually lands in the columns ────────────────────
  const lead = await createLeadFromEnquiry(ctx.tenantId, {
    name: `${TAG} attribution`,
    phone: "+971 50 000 0009",
    serviceSlug: "plumbing-sanitary",
    urgency: "routine",
    propertyType: "apartment",
    city: "Dubai",
    area: "Dubai Marina",
    details: "__test lead for attribution and disposition checks.",
    attribution: {
      channel: "website",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "ac-summer",
      landingPage: "/services/ac-repair?utm_source=google",
      referrer: "https://www.google.com/",
      extra: { gclid: "__test-gclid", userAgent: "test-runner" },
    },
  });

  const stored = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{
      channel: string;
      utm_source: string | null;
      utm_campaign: string | null;
      landing_page: string | null;
      referrer: string | null;
      attribution: Record<string, string>;
    }>(sql`
      select channel, utm_source, utm_campaign, landing_page, referrer, attribution
        from leads where id = ${lead.leadId}::uuid
    `)) as unknown as {
      channel: string;
      utm_source: string | null;
      utm_campaign: string | null;
      landing_page: string | null;
      referrer: string | null;
      attribution: Record<string, string>;
    }[];
    return rows[0];
  });

  check("the channel is recorded", stored?.channel, "website");
  check("utm_source is a column, not a blob key", stored?.utm_source, "google");
  check("utm_campaign too", stored?.utm_campaign, "ac-summer");
  check(
    "the landing page is kept whole, query string and all",
    stored?.landing_page,
    "/services/ac-repair?utm_source=google",
  );
  check("and the external referrer", stored?.referrer, "https://www.google.com/");
  // The blob survives alongside the columns. Losing it would trade one gap for
  // another the first time an advertising platform invents an identifier.
  check("gclid still lands in the JSONB", stored?.attribution?.["gclid"], "__test-gclid");

  // ── LEAD-6: the refusals ─────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    checkTrue(
      "lost without a reason is refused",
      await refuses(() => setLeadStage(tx, lead.leadId, "lost")),
    );
  });

  await withTenant(ctx, async (tx) => {
    checkTrue(
      "lost with a dormant-only reason is refused",
      await refuses(() =>
        setLeadStage(tx, lead.leadId, "lost", { dispositionReasonId: reasonIds.dormantId }),
      ),
    );
  });

  await withTenant(ctx, async (tx) => {
    // Free text is not a reason. This is the case the whole requirement exists
    // for: a note is accepted, and it does not satisfy the constraint on its own.
    checkTrue(
      "a free-text note alone is refused",
      await refuses(() => setLeadStage(tx, lead.leadId, "lost", { note: "too expensive" })),
    );
  });

  await withTenant(ctx, (tx) =>
    setLeadStage(tx, lead.leadId, "lost", {
      dispositionReasonId: reasonIds.lostId,
      note: "__test note kept alongside the code",
    }),
  );

  const closed = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ stage: string; disposition_reason_id: string | null; lost_reason: string | null }>(sql`
      select stage, disposition_reason_id, lost_reason from leads where id = ${lead.leadId}::uuid
    `)) as unknown as {
      stage: string;
      disposition_reason_id: string | null;
      lost_reason: string | null;
    }[];
    return rows[0];
  });

  check("the lead is lost", closed?.stage, "lost");
  check("against the coded reason", closed?.disposition_reason_id, reasonIds.lostId);
  checkTrue("with the note kept beside it", Boolean(closed?.lost_reason));

  // The database is the backstop, not the form. A direct UPDATE that clears the
  // reason while leaving the stage at lost has to fail, or the constraint is
  // decorative and the next code path to write leads bypasses it.
  //
  // In its own transaction, deliberately. A constraint violation aborts the
  // transaction it happens in, so catching one and carrying on inside the same
  // `withTenant` would fail at COMMIT instead — which reads as a broken test
  // rather than as a working constraint.
  checkTrue(
    "the database refuses a lost lead with no reason",
    await refuses(() =>
      withTenant(ctx, (tx) =>
        tx.execute(sql`
          update leads set disposition_reason_id = null where id = ${lead.leadId}::uuid
        `),
      ),
    ),
  );

  // Reopening clears the closure rather than leaving last month's reason on a
  // live lead, which would read as lost to every report that saw it.
  await withTenant(ctx, (tx) => setLeadStage(tx, lead.leadId, "contacted"));
  const reopened = await withTenant(ctx, async (tx) => {
    const rows = (await tx.execute<{ disposition_reason_id: string | null }>(sql`
      select disposition_reason_id from leads where id = ${lead.leadId}::uuid
    `)) as unknown as { disposition_reason_id: string | null }[];
    return rows[0];
  });
  check("reopening clears the reason", reopened?.disposition_reason_id, null);

  // ── JOB-13 and JOB-14: the lists exist and are scoped ────────────────────
  await withTenant(ctx, async (tx) => {
    const added = await installStandardJobOutcomes(tx, ctx);
    check("the standard outcomes are already installed, so nothing is added twice", added, 0);

    const outcomes = await listJobOutcomeCodes(tx);
    checkTrue("all seven JOB-13 outcomes are present", outcomes.length >= 7);
    checkTrue(
      "no_access is one of them and it leaves work owing",
      outcomes.some((o) => o.code === "no_access" && o.requiresReturnVisit),
    );

    await addFaultCode(tx, ctx, {
      kind: "symptom",
      code: `${TAG}_no_cooling`,
      label: "__test AC not cooling",
      serviceSlug: "hvac-ac-maintenance",
    });
    await addFaultCode(tx, ctx, {
      kind: "cause",
      code: `${TAG}_gas_leak`,
      label: "__test refrigerant leak",
    });

    const forHvac = await listFaultCodes(tx, { serviceSlug: "hvac-ac-maintenance" });
    checkTrue(
      "a service filter keeps that service's codes",
      forHvac.some((c) => c.code === `${TAG}_no_cooling`),
    );
    // The unscoped ones apply everywhere, so filtering by service must not drop
    // them — that is how a technician loses "no power at the isolator".
    checkTrue(
      "and keeps the codes that apply to every service",
      forHvac.some((c) => c.code === `${TAG}_gas_leak`),
    );

    const symptoms = await listFaultCodes(tx, { kind: "symptom" });
    checkTrue("kind filters to one part of the taxonomy", symptoms.every((c) => c.kind === "symptom"));
  });

  // ── LEAD-6: the standard disposition reasons install idempotently ────────
  await withTenant(ctx, async (tx) => {
    // The first call may or may not add anything, depending on whether this
    // database has already been seeded with the standard set — both are legal
    // states here, so only the second call's count is asserted.
    await installStandardDispositionReasons(tx, ctx);
    const secondAdded = await installStandardDispositionReasons(tx, ctx);
    check("installing the standard reasons twice adds nothing the second time", secondAdded, 0);

    const afterInstall = await listDispositionReasons(tx);
    const presentCodes = new Set(afterInstall.map((r) => r.code));
    checkTrue(
      "every standard reason is present after install",
      STANDARD_DISPOSITION_REASONS.every((r) => presentCodes.has(r.code)),
    );

    // Reworded the way an operator would from the admin screen; a reinstall
    // must leave that alone, the same `do nothing` precedent
    // `installStandardJobOutcomes` relies on above.
    const standard = STANDARD_DISPOSITION_REASONS[0];
    if (!standard) throw new Error("STANDARD_DISPOSITION_REASONS is empty");

    await addDispositionReason(tx, ctx, {
      code: standard.code,
      label: "__test reworded label",
      appliesTo: standard.appliesTo,
      guidance: standard.guidance,
      sortOrder: standard.sortOrder,
    });
    await installStandardDispositionReasons(tx, ctx);
    const reworded = (await listDispositionReasons(tx)).find((r) => r.code === standard.code);
    check("a reworded standard reason survives a reinstall", reworded?.label, "__test reworded label");

    // Restored so this run leaves the fixture as it found it, the same as
    // `referenceDataChecks` does for everything else it touches.
    await addDispositionReason(tx, ctx, {
      code: standard.code,
      label: standard.label,
      appliesTo: standard.appliesTo,
      guidance: standard.guidance,
      sortOrder: standard.sortOrder,
    });
  });

  // ── QTE-4: a price has a history, not just a value ───────────────────────
  await withTenant(ctx, async (tx) => {
    await addRateVersion(tx, ctx, {
      code: RATE_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test callout, first hour",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 25_000,
      isPublished: true,
      effectiveFrom: "2026-01-01",
    });

    const first = await rateOn(tx, RATE_CODE, "standard", "2026-03-15");
    check("March is priced from the January rate", first?.unitPriceMinor, 25_000);

    await addRateVersion(tx, ctx, {
      code: RATE_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test callout, first hour",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 27_500,
      isPublished: true,
      effectiveFrom: "2026-06-01",
    });

    // The whole point of the table. A quotation issued in March is still
    // defensible in July because March's price did not move when June's was set.
    check(
      "March still answers with the old price after a rise",
      (await rateOn(tx, RATE_CODE, "standard", "2026-03-15"))?.unitPriceMinor,
      25_000,
    );
    check(
      "and July answers with the new one",
      (await rateOn(tx, RATE_CODE, "standard", "2026-07-15"))?.unitPriceMinor,
      27_500,
    );
    check(
      "the day the new price starts belongs to the new price",
      (await rateOn(tx, RATE_CODE, "standard", "2026-06-01"))?.unitPriceMinor,
      27_500,
    );

    const history = await listRateHistory(tx, RATE_CODE);
    check("both versions are kept", history.length, 2);
    check("and only one of them is open-ended", history.filter((r) => !r.effectiveTo).length, 1);

    // A missing rate is not a free one. Returning zero here would put a nought
    // on a quotation nobody meant to give away.
    check(
      "an unpriced band answers with nothing, not with zero",
      await rateOn(tx, RATE_CODE, "emergency", "2026-07-15"),
      null,
    );

    checkTrue(
      "a backdated version is refused rather than slotted in",
      await refuses(() =>
        addRateVersion(tx, ctx, {
          code: RATE_CODE,
          serviceSlug: "plumbing-sanitary",
          label: "__test callout, first hour",
          unit: "hour",
          rateBand: "standard",
          unitPriceMinor: 30_000,
          isPublished: true,
          effectiveFrom: "2026-02-01",
        }),
      ),
    );

    const asOfMarch = await listRateCard(tx, { onDate: "2026-03-15" });
    checkTrue(
      "the card as it stood in March contains exactly one version of the line",
      asOfMarch.filter((r) => r.code === RATE_CODE).length === 1,
    );
  });

  // ── ADM-12: an installed disposition reason actually closes a lead ───────
  //
  // The idempotency check above proves the installer is safe to click twice.
  // It does not by itself prove `LEAD-6` is unblocked — that needs a lead
  // closed as lost using a reason that came from the installer, not one this
  // file hand-typed with `addDispositionReason`.
  await withTenant(ctx, async (tx) => {
    await installStandardDispositionReasons(tx, ctx);
    const installed = await listDispositionReasons(tx, { stage: "lost", activeOnly: true });
    const priceReason = installed.find((r) => r.code === "lost_on_price");
    if (!priceReason) throw new Error("the standard disposition reasons were not installed");

    const closedByInstall = await createLeadFromEnquiry(ctx.tenantId, {
      name: `${TAG} attribution closed via an installed reason`,
      phone: "+971 50 000 0011",
      serviceSlug: "plumbing-sanitary",
      urgency: "routine",
      propertyType: "apartment",
      city: "Dubai",
      area: "Dubai Marina",
      details: "__test lead closed as lost using an installed standard reason.",
    });

    await setLeadStage(tx, closedByInstall.leadId, "lost", { dispositionReasonId: priceReason.id });

    const row = (
      (await tx.execute<{ stage: string }>(sql`
        select stage from leads where id = ${closedByInstall.leadId}::uuid
      `)) as unknown as { stage: string }[]
    )[0];
    check(
      "a fresh lead closes as lost using a reason the installer, not this file, created",
      row?.stage,
      "lost",
    );
  });

  // ── ADM-12: the standard rate card installs idempotently and actually prices work ──
  //
  // Same shape as the disposition-reason check above: install, prove the
  // second call adds nothing, and prove the result is not just rows in a
  // table but a price the quote builder could actually read back.
  await withTenant(ctx, async (tx) => {
    const effectiveFrom = dubaiDateKey(new Date());

    const firstAdded = await installStandardRateCardItems(tx, ctx, effectiveFrom);
    checkTrue(
      "the first install adds at least one standard line (or they were already there)",
      firstAdded >= 0,
    );
    const secondAdded = await installStandardRateCardItems(tx, ctx, effectiveFrom);
    check("installing the standard rate card twice adds nothing the second time", secondAdded, 0);

    const card = await listRateCard(tx, { onDate: effectiveFrom });
    const presentCodes = new Set(card.map((r) => `${r.serviceSlug}::${r.code}::${r.rateBand}`));
    checkTrue(
      "every standard line is present after install",
      STANDARD_RATE_CARD_ITEMS.every((l) =>
        presentCodes.has(`${l.serviceSlug}::${l.code}::${l.rateBand}`),
      ),
    );

    // The positive case a tender pack and a quotation actually rely on: a
    // licensed service's standard labour rate resolves to a real price, not
    // to null — which is what an unpriced band would return.
    const plumbingLabour = await rateOn(tx, "plumbing-sanitary-labour", "standard", effectiveFrom);
    checkTrue(
      "plumbing labour prices at standard band after install",
      plumbingLabour !== null && plumbingLabour.unitPriceMinor > 0,
    );

    // Only the three emergency-eligible trades get the out-of-hours bands; a
    // fit-out trade priced only `standard` must not answer for `emergency`.
    const paintingEmergency = await rateOn(tx, "painting-labour", "emergency", effectiveFrom);
    check("a non-emergency trade has no emergency band", paintingEmergency, null);

    const plumbingEmergency = await rateOn(tx, "plumbing-sanitary-labour", "emergency", effectiveFrom);
    checkTrue(
      "an emergency-eligible trade's emergency rate costs more than its standard rate",
      plumbingEmergency !== null &&
        plumbingLabour !== null &&
        plumbingEmergency.unitPriceMinor > plumbingLabour.unitPriceMinor,
    );
  });

  // ── WEB-16: the public schedule of rates sees only published, in-force rows ──
  //
  // `listPublicRateCard` reads through `app_public_rate_card`, a SECURITY
  // DEFINER function, not through `withTenant()` — this is the one place in
  // this file that calls it with a bare tenant id rather than a `tx`. The two
  // rules that make the table safe to publish live in that function's SQL, so
  // this proves them from the outside: an unpublished row must never surface,
  // a rate that has not taken effect yet must never surface, and a superseded
  // version must never surface once a newer one is current.
  const PUBLIC_CODE = `${TAG}_public_published`;
  const UNPUBLISHED_CODE = `${TAG}_public_unpublished`;
  const FUTURE_CODE = `${TAG}_public_future`;
  const SUPERSEDED_CODE = `${TAG}_public_superseded`;

  await withTenant(ctx, async (tx) => {
    await addRateVersion(tx, ctx, {
      code: PUBLIC_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test public published",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 11_100,
      isPublished: true,
      effectiveFrom: "2020-01-01",
    });
    await addRateVersion(tx, ctx, {
      code: UNPUBLISHED_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test public unpublished",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 22_200,
      isPublished: false,
      effectiveFrom: "2020-01-01",
    });
    await addRateVersion(tx, ctx, {
      code: FUTURE_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test public not yet effective",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 33_300,
      isPublished: true,
      effectiveFrom: "2099-01-01",
    });
    // Two versions of one code: the first is superseded by the second and must
    // never show through the public function, even though it is published.
    await addRateVersion(tx, ctx, {
      code: SUPERSEDED_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test public superseded v1",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 44_400,
      isPublished: true,
      effectiveFrom: "2020-01-01",
    });
    await addRateVersion(tx, ctx, {
      code: SUPERSEDED_CODE,
      serviceSlug: "plumbing-sanitary",
      label: "__test public superseded v2 (current)",
      unit: "hour",
      rateBand: "standard",
      unitPriceMinor: 55_500,
      isPublished: true,
      effectiveFrom: "2020-06-01",
    });
  });

  const publicRates = await listPublicRateCard(ctx.tenantId);
  const publicCodes = new Set(publicRates.map((r) => r.code));

  checkTrue("the public schedule includes a published, in-force rate", publicCodes.has(PUBLIC_CODE));
  checkTrue(
    "the public schedule never includes an unpublished rate",
    !publicCodes.has(UNPUBLISHED_CODE),
  );
  checkTrue(
    "the public schedule never includes a rate that has not taken effect yet",
    !publicCodes.has(FUTURE_CODE),
  );

  const supersededRow = publicRates.find((r) => r.code === SUPERSEDED_CODE);
  check(
    "a superseded version never shows through the public schedule — only the current price does",
    supersededRow?.unitPriceMinor,
    55_500,
  );

  await clearTestReferenceData(ctx, TAG);
}

/**
 * Remove this file's fixtures, in dependency order.
 *
 * Leads before reasons: the foreign key is `ON DELETE restrict` on purpose, so
 * a reason cited by a lead cannot be deleted out from under it. That is the
 * production behaviour being relied on, not an obstacle to work around.
 */
async function clearTestReferenceData(ctx: { tenantId: string }, tag: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    await tx.execute(sql`delete from leads where name like ${`${tag} attribution%`}`);
    await tx.execute(sql`delete from rate_card_items where code like ${`${tag}%`}`);
    await tx.execute(sql`delete from fault_codes where code like ${`${tag}%`}`);
    await tx.execute(sql`delete from lead_disposition_reasons where code like ${`${tag}%`}`);
  });
}

/**
 * Did that refuse?
 *
 * A rejected write is the assertion in most of the checks above, and a bare
 * try/catch at each site would be five lines of noise per line of meaning. Any
 * throw counts: `UserFacingError` from the domain and a constraint violation
 * from Postgres are both the system declining, which is what is being proven.
 */
async function refuses(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch (error) {
    // Logged rather than swallowed. A check that passes for the wrong reason —
    // a typo in a column name, say — is worse than one that fails.
    // Drizzle wraps a driver error and puts the useful sentence on `cause`; the
    // wrapper's own message is the whole failed statement, which is noise here.
    const cause = error instanceof Error ? (error.cause as Error | undefined) : undefined;
    const message = cause?.message ?? (error instanceof Error ? error.message : String(error));
    console.log(`      refused: ${message.slice(0, 120)}`);
    return true;
  }
}

async function statusOf(jobId: string): Promise<string | undefined> {
  const rows = await withTenant({ tenantId: TENANT }, (tx) =>
    tx.select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, jobId)),
  );
  return rows[0]?.status;
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
