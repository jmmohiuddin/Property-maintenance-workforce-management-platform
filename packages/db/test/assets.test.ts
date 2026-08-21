/**
 * Asset register integration test — `CON-13`.
 *
 * Three claims are worth a test here, and none of them is CRUD:
 *
 *  1. The vocabulary has rows. A controlled-vocabulary table with an empty
 *     picker is worse than a text column, because it looks governed and is not.
 *     This repo has shipped that bug once already.
 *  2. A day is a day. `installed_on` and `warranty_expires_on` go in as
 *     `YYYY-MM-DD` and come back as the same string, and "expired" is decided
 *     by Postgres against `current_date` — not by a JS `Date` that moves the
 *     boundary by the reader's UTC offset and reports an expired warranty as
 *     live for the first four hours of every Dubai day.
 *  3. A register with no path from a job is not a service history. Linking is
 *     tested for what it refuses as much as for what it accepts.
 *
 *   npm run test --workspace=@meridian/db
 *
 * Requires the schema, RLS and `npm run db:seed`. Cleans up after itself.
 */

import { and, eq, ne, inArray } from "drizzle-orm";
import {
  withTenant,
  withCustomerScope,
  createPortalRequest,
  listAssetCategories,
  addAssetCategory,
  setAssetCategoryActive,
  installStandardAssetCategories,
  assetCountsByCategory,
  registerAsset,
  listPropertyAssets,
  getAssetRecord,
  getPropertyRecord,
  listAssetChoices,
  listLinkableJobs,
  linkJobToAsset,
  STANDARD_ASSET_CATEGORIES,
  schema,
  closeConnection,
} from "../src/index";
import { activeTenantIds } from "../src/domain/cron";
import { UserFacingError, dubaiDateKey } from "@meridian/core";
import { testTenantId } from "./_tenant";

const RUN = Date.now().toString(36).toUpperCase().slice(-6);
const DAY_MS = 86_400_000;

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

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

/** A Dubai day offset from today, in the string form the columns store. */
const day = (offsetDays: number) => dubaiDateKey(new Date(Date.now() + offsetDays * DAY_MS));

async function main(): Promise<void> {
  const tenantId = await testTenantId();
  const ctx = { tenantId, actorKind: "system" as const };

  const createdAssets: string[] = [];
  const createdJobs: string[] = [];
  const createdProperties: string[] = [];
  const createdCategories: string[] = [];

  // ── The vocabulary exists ────────────────────────────────────────────────
  const categories = await withTenant(ctx, (tx) => listAssetCategories(tx));
  checkTrue(
    "CON-13: the asset-kind vocabulary is seeded, not empty",
    categories.length >= STANDARD_ASSET_CATEGORIES.length,
  );
  for (const expected of STANDARD_ASSET_CATEGORIES) {
    checkTrue(
      `CON-13: "${expected.code}" is in the picker`,
      categories.some((c) => c.code === expected.code),
    );
  }
  const chiller = categories.find((c) => c.code === "chiller");
  const lift = categories.find((c) => c.code === "lift");
  check("a chiller carries its standard PPM interval", chiller?.defaultPpmIntervalDays, 90);
  check("a lift is monthly, not quarterly", lift?.defaultPpmIntervalDays, 30);
  if (!chiller || !lift) throw new Error("the seeded vocabulary is missing kinds this test needs");

  // ── The vocabulary is administrator-maintained (ADM-10) ──────────────────
  //
  // A controlled vocabulary nobody can extend is worse than free text: the
  // first unlisted kind gets recorded as the nearest wrong one, and the
  // register looks governed while being wrong. These are the paths
  // /admin/reference/asset-kinds drives.
  const reinstalled = await withTenant(ctx, (tx) => installStandardAssetCategories(tx, ctx));
  check(
    "installing the standard kinds again adds nothing and overwrites nothing",
    reinstalled,
    0,
  );

  const testKindCode = `zz_kind_${RUN}`.toLowerCase();
  await withTenant(ctx, (tx) =>
    addAssetCategory(tx, ctx, {
      code: testKindCode,
      label: `__TEST cooling tower ${RUN}`,
      description: "Added the way an administrator adds one.",
      serviceSlug: "hvac-installation-maintenance",
      defaultPpmIntervalDays: 120,
      sortOrder: 900,
    }),
  );
  const added = (await withTenant(ctx, (tx) => listAssetCategories(tx))).find(
    (c) => c.code === testKindCode,
  );
  checkTrue("an administrator can add a kind the requirement does not name", added !== undefined);
  check("and it carries the interval that was entered", added?.defaultPpmIntervalDays, 120);
  if (!added) throw new Error("the added kind did not come back");
  createdCategories.push(added.id);

  checkTrue(
    "a new kind is offered by the register's picker",
    (await withTenant(ctx, (tx) => listAssetCategories(tx, { activeOnly: true }))).some(
      (c) => c.id === added.id,
    ),
  );

  checkTrue(
    "an interval of zero days is refused rather than stored",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          addAssetCategory(tx, ctx, {
            code: `${testKindCode}_bad`,
            label: "__TEST bad interval",
            defaultPpmIntervalDays: 0,
          }),
        ),
      )
    ).includes("above zero"),
  );

  // Retirement, not deletion — `assets.category_id` is ON DELETE RESTRICT, and
  // plant already registered under a kind has to keep it.
  await withTenant(ctx, (tx) => setAssetCategoryActive(tx, added.id, false));
  checkTrue(
    "a retired kind disappears from the picker",
    !(await withTenant(ctx, (tx) => listAssetCategories(tx, { activeOnly: true }))).some(
      (c) => c.id === added.id,
    ),
  );
  const retiredRow = (await withTenant(ctx, (tx) => listAssetCategories(tx))).find(
    (c) => c.id === added.id,
  );
  check("and stays visible to the administrator, marked retired", retiredRow?.isActive, false);

  await withTenant(ctx, (tx) => setAssetCategoryActive(tx, added.id, true));
  checkTrue(
    "and restoring it puts it back in the picker",
    (await withTenant(ctx, (tx) => listAssetCategories(tx, { activeOnly: true }))).some(
      (c) => c.id === added.id,
    ),
  );

  // ── Two properties, so "wrong building" can be proven ────────────────────
  const properties = await withTenant(ctx, (tx) =>
    tx
      .select({
        id: schema.properties.id,
        customerId: schema.properties.customerId,
        name: schema.properties.name,
      })
      .from(schema.properties)
      .limit(2),
  );
  const site = properties[0];
  const otherSite = properties[1];
  if (!site || !otherSite) throw new Error("this test needs two seeded properties");

  const record = await withTenant(ctx, (tx) => getPropertyRecord(tx, site.id));
  check("the property record resolves", record?.id, site.id);
  checkTrue("and carries the customer it belongs to", record?.customerName !== undefined);

  // ── Registering ──────────────────────────────────────────────────────────
  const installedOn = day(-800);
  const warrantyExpiresOn = day(30);

  const asset = await withTenant(ctx, (tx) =>
    registerAsset(tx, ctx, {
      propertyId: site.id,
      categoryId: chiller.id,
      tag: `ZZ-CH-${RUN}`,
      name: "__TEST chiller",
      manufacturer: "Carrier",
      model: "30XA-1002",
      serialNumber: `SER-${RUN}`,
      location: "Roof plant room",
      installedOn,
      warrantyExpiresOn,
    }),
  );
  createdAssets.push(asset.id);

  const register = await withTenant(ctx, (tx) => listPropertyAssets(tx, site.id));
  const mine = register.find((a) => a.id === asset.id);
  checkTrue("the asset appears on its property's register", mine !== undefined);
  check("it carries its kind's label, not a typed-in one", mine?.categoryLabel, "Chiller");
  check("the tag is normalised to upper case", mine?.tag, `ZZ-CH-${RUN}`);
  check(
    "the PPM interval defaults to the kind's",
    mine?.ppmIntervalDays,
    chiller.defaultPpmIntervalDays,
  );

  // ── The day columns ──────────────────────────────────────────────────────
  check("the install date reads back as the day it was written", mine?.installedOn, installedOn);
  check("and so does the warranty expiry", mine?.warrantyExpiresOn, warrantyExpiresOn);
  check("days remaining is counted by Postgres, not by a JS Date", mine?.warrantyDaysRemaining, 30);

  // The one that matters. A warranty that ran out yesterday must never read as
  // live: through a `timestamptz` column and a JS `Date` it does, for the first
  // four hours of every Dubai day, and the error authorises a repair the
  // manufacturer will refuse to pay for.
  const expired = await withTenant(ctx, (tx) =>
    registerAsset(tx, ctx, {
      propertyId: site.id,
      categoryId: lift.id,
      tag: `ZZ-LIFT-${RUN}`,
      name: "__TEST lift, warranty gone",
      installedOn: day(-2000),
      warrantyExpiresOn: day(-1),
    }),
  );
  createdAssets.push(expired.id);

  const expiredRow = (await withTenant(ctx, (tx) => listPropertyAssets(tx, site.id))).find(
    (a) => a.id === expired.id,
  );
  check("a warranty that ended yesterday reads as expired", expiredRow?.warrantyDaysRemaining, -1);
  check("and its expiry date is the day it was given", expiredRow?.warrantyExpiresOn, day(-1));

  // ── What registering refuses ─────────────────────────────────────────────
  check(
    "a warranty cannot expire before the plant was installed",
    await refusal(() =>
      withTenant(ctx, (tx) =>
        registerAsset(tx, ctx, {
          propertyId: site.id,
          categoryId: chiller.id,
          tag: `ZZ-BAD1-${RUN}`,
          name: "__TEST",
          installedOn: day(0),
          warrantyExpiresOn: day(-10),
        }),
      ),
    ),
    "The warranty cannot expire before the asset was installed.",
  );

  checkTrue(
    "a date that is not YYYY-MM-DD is refused rather than coerced",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          registerAsset(tx, ctx, {
            propertyId: site.id,
            categoryId: chiller.id,
            tag: `ZZ-BAD2-${RUN}`,
            name: "__TEST",
            installedOn: "01/07/2026",
          }),
        ),
      )
    ).includes("YYYY-MM-DD"),
  );

  checkTrue(
    "an asset tag cannot be reused, even at another site",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          registerAsset(tx, ctx, {
            propertyId: otherSite.id,
            categoryId: chiller.id,
            tag: `ZZ-CH-${RUN}`,
            name: "__TEST duplicate tag",
          }),
        ),
      )
    ).includes("already in use"),
  );

  checkTrue(
    "an asset cannot be registered without a kind",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          registerAsset(tx, ctx, {
            propertyId: site.id,
            categoryId: "00000000-0000-4000-8000-000000000000",
            tag: `ZZ-BAD3-${RUN}`,
            name: "__TEST no kind",
          }),
        ),
      )
    ).includes("kind"),
  );

  // The count the administration screen shows next to each kind, so a retire
  // decision is made against how much plant is recorded under it.
  const counts = await withTenant(ctx, (tx) => assetCountsByCategory(tx));
  checkTrue(
    "the kind counts how much plant is registered under it",
    (counts.get(chiller.id) ?? 0) >= 1,
  );

  // Retiring a kind must close it to NEW plant while leaving the old alone.
  await withTenant(ctx, (tx) => setAssetCategoryActive(tx, added.id, false));
  checkTrue(
    "a retired kind cannot take new plant",
    (
      await refusal(() =>
        withTenant(ctx, (tx) =>
          registerAsset(tx, ctx, {
            propertyId: site.id,
            categoryId: added.id,
            tag: `ZZ-RETIRED-${RUN}`,
            name: "__TEST against a retired kind",
          }),
        ),
      )
    ).includes("retired"),
  );

  // ── Service history ──────────────────────────────────────────────────────
  const fresh = await withTenant(ctx, (tx) => getAssetRecord(tx, asset.id));
  check("a newly registered asset has no history yet", fresh?.history.length, 0);
  check("and says so honestly rather than counting nothing as one", fresh?.asset.jobCount, 0);

  // Two jobs of this test's own, so no seeded row is mutated: one at this
  // property, one at another. `completed_at` on the first is what the PPM
  // recalculation reads.
  const completedAt = new Date(Date.now() - 5 * DAY_MS);
  const jobs = await withTenant(ctx, (tx) =>
    tx
      .insert(schema.jobs)
      .values([
        {
          tenantId,
          reference: `ZZ-ASSET-${RUN}-1`,
          customerId: site.customerId,
          propertyId: site.id,
          serviceSlug: "hvac-installation-maintenance",
          title: "__TEST chiller quarterly service",
          status: "closed" as const,
          completedAt,
        },
        {
          tenantId,
          reference: `ZZ-ASSET-${RUN}-2`,
          customerId: otherSite.customerId,
          propertyId: otherSite.id,
          serviceSlug: "hvac-installation-maintenance",
          title: "__TEST job at a different building",
          status: "submitted" as const,
        },
      ])
      .returning({ id: schema.jobs.id, reference: schema.jobs.reference }),
  );
  const here = jobs.find((j) => j.reference.endsWith("-1"));
  const elsewhere = jobs.find((j) => j.reference.endsWith("-2"));
  for (const j of jobs) createdJobs.push(j.id);
  if (!here || !elsewhere) throw new Error("failed to create the test jobs");

  const linkable = await withTenant(ctx, (tx) => listLinkableJobs(tx, site.id));
  checkTrue(
    "an unattached job at this property is offered for linking",
    linkable.some((j) => j.id === here.id),
  );
  checkTrue(
    "a job at another property is not",
    !linkable.some((j) => j.id === elsewhere.id),
  );

  const linked = await withTenant(ctx, (tx) =>
    linkJobToAsset(tx, ctx, { assetId: asset.id, jobId: here.id }),
  );
  check("linking reports the job it attached", linked.reference, `ZZ-ASSET-${RUN}-1`);

  const withHistory = await withTenant(ctx, (tx) => getAssetRecord(tx, asset.id));
  check("CON-13: the job now appears in the asset's service history", withHistory?.history.length, 1);
  check("with the reference a technician would quote", withHistory?.history[0]?.reference, `ZZ-ASSET-${RUN}-1`);
  check("and the count on the register agrees", withHistory?.asset.jobCount, 1);
  check(
    "last serviced is taken from when the work finished, not from now",
    withHistory?.asset.lastServicedAt?.toISOString(),
    completedAt.toISOString(),
  );
  checkTrue(
    "and the next PPM falls due one interval after that",
    Math.round(
      ((withHistory?.asset.nextServiceDueAt?.getTime() ?? 0) - completedAt.getTime()) / DAY_MS,
    ) === chiller.defaultPpmIntervalDays,
  );

  checkTrue(
    "a linked job is no longer offered for linking",
    !(await withTenant(ctx, (tx) => listLinkableJobs(tx, site.id))).some((j) => j.id === here.id),
  );

  checkTrue(
    "the same job cannot be attached twice",
    (
      await refusal(() =>
        withTenant(ctx, (tx) => linkJobToAsset(tx, ctx, { assetId: asset.id, jobId: here.id })),
      )
    ).includes("already on this asset"),
  );

  check(
    "a job raised at another property cannot be attached to this asset",
    await refusal(() =>
      withTenant(ctx, (tx) => linkJobToAsset(tx, ctx, { assetId: asset.id, jobId: elsewhere.id })),
    ),
    "That asset and that job are at different properties.",
  );

  checkTrue(
    "a job already on one asset cannot be silently moved to another",
    (
      await refusal(() =>
        withTenant(ctx, (tx) => linkJobToAsset(tx, ctx, { assetId: expired.id, jobId: here.id })),
      )
    ).includes("already attached to another asset"),
  );

  // ── CON-13 at intake, not after the fact ─────────────────────────────────
  //
  // Everything above attaches history from the asset side, which is the
  // correction path. This is the point-of-work path: the customer reporting the
  // fault names the equipment, and the job arrives already carrying it.
  //
  // A second building ON THE SAME ACCOUNT, so that "wrong property" is proven
  // by the property rule rather than by customer scope refusing to see the row
  // at all — two different refusals that would otherwise look identical.
  const [annex] = await withTenant(ctx, (tx) =>
    tx
      .insert(schema.properties)
      .values({
        tenantId,
        customerId: site.customerId,
        name: `__TEST annex ${RUN}`,
        type: "other" as const,
        addressLine: "__TEST annex address",
        city: "Dubai",
      })
      .returning({ id: schema.properties.id }),
  );
  if (!annex) throw new Error("failed to create the second property");
  createdProperties.push(annex.id);

  const annexAsset = await withTenant(ctx, (tx) =>
    registerAsset(tx, ctx, {
      propertyId: annex.id,
      categoryId: chiller.id,
      tag: `ZZ-ANNEX-${RUN}`,
      name: "__TEST annex chiller",
    }),
  );
  createdAssets.push(annexAsset.id);

  const portalCtx = { tenantId, customerId: site.customerId, actorKind: "customer" as const };

  const choices = await withCustomerScope(portalCtx, (tx) => listAssetChoices(tx, [site.id]));
  checkTrue(
    "the intake picker offers the plant registered at that property",
    choices.some((c) => c.id === asset.id),
  );
  checkTrue(
    "and not plant in the other building on the same account",
    !choices.some((c) => c.id === annexAsset.id),
  );
  check(
    "asking for no properties asks the database nothing",
    (await withCustomerScope(portalCtx, (tx) => listAssetChoices(tx, []))).length,
    0,
  );

  // The `assets` policy added to sql/customer-scope.sql. Until the intake
  // picker existed, no portal query touched the table and it carried tenant
  // isolation only — which is "every machine in every building in the tenant"
  // to a portal session, not "nothing", for the reason that file sets out at
  // length about `job_visits`.
  const [stranger] = await withTenant(ctx, (tx) =>
    tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(ne(schema.customers.id, site.customerId))
      .limit(1),
  );
  if (stranger) {
    check(
      "another customer in the same tenant sees none of this plant",
      (
        await withCustomerScope(
          { tenantId, customerId: stranger.id, actorKind: "customer" as const },
          (tx) => listAssetChoices(tx, [site.id]),
        )
      ).length,
      0,
    );
  } else {
    console.log("skip  customer scope not proven — this tenant has only one customer");
  }

  const raised = await withCustomerScope(portalCtx, (tx) =>
    createPortalRequest(
      tx,
      { tenantId, customerId: site.customerId },
      {
        propertyId: site.id,
        serviceSlug: "hvac-installation-maintenance",
        title: `__TEST the chiller is short cycling ${RUN}`,
        requestedPriority: "p3_standard",
        assetId: asset.id,
      },
    ),
  );
  createdJobs.push(raised.jobId);
  check("intake names the equipment it attached", raised.assetName, "__TEST chiller");

  const afterIntake = await withTenant(ctx, (tx) => getAssetRecord(tx, asset.id));
  checkTrue(
    "CON-13: a request raised in the portal arrives already on the asset's history",
    (afterIntake?.history ?? []).some((h) => h.jobId === raised.jobId),
  );
  check("and the register's count agrees", afterIntake?.asset.jobCount, 2);

  // The regression that matters. `last_serviced_at` is recomputed from
  // max(completed_at) of the linked jobs, not from now() — so attaching an
  // OPEN job must not reset the PPM clock to today and hide an overdue service.
  check(
    "attaching an open job does not move the last-serviced date",
    afterIntake?.asset.lastServicedAt?.toISOString(),
    completedAt.toISOString(),
  );
  checkTrue(
    "and the next service still falls due one interval after the work that was actually done",
    Math.round(
      ((afterIntake?.asset.nextServiceDueAt?.getTime() ?? 0) - completedAt.getTime()) / DAY_MS,
    ) === chiller.defaultPpmIntervalDays,
  );

  const wrongBuilding = `__TEST wrong building ${RUN}`;
  check(
    "a request cannot name plant from a different building",
    await refusal(() =>
      withCustomerScope(portalCtx, (tx) =>
        createPortalRequest(
          tx,
          { tenantId, customerId: site.customerId },
          {
            propertyId: site.id,
            serviceSlug: "hvac-installation-maintenance",
            title: wrongBuilding,
            requestedPriority: "p3_standard",
            assetId: annexAsset.id,
          },
        ),
      ),
    ),
    "That asset and that job are at different properties.",
  );
  check(
    "and the refusal takes the job with it rather than leaving one badly linked",
    (
      await withTenant(ctx, (tx) =>
        tx
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(eq(schema.jobs.title, wrongBuilding)),
      )
    ).length,
    0,
  );

  // ── The tenant boundary ──────────────────────────────────────────────────
  //
  // Through `activeTenantIds()`, a SECURITY DEFINER enumerator, and NOT through
  // `otherTenantId()` in ./_tenant: that helper selects from `tenants` on the
  // plain handle, outside a tenant transaction, where the policy is
  // `id = app_current_tenant()` and the setting is unset — so it returns null
  // whether or not a second tenant exists, and this check would report itself
  // as skipped on every run for ever.
  const other = (await activeTenantIds()).find((id) => id !== tenantId) ?? null;
  if (other) {
    const acrossCtx = { tenantId: other, actorKind: "system" as const };
    const across = await withTenant(acrossCtx, (tx) => getAssetRecord(tx, asset.id));
    check("the same asset id resolves to nothing under another tenant", across, null);
    const acrossRegister = await withTenant(acrossCtx, (tx) => listPropertyAssets(tx, site.id));
    check("and the property's register is empty there too", acrossRegister.length, 0);
    const acrossCategories = await withTenant(acrossCtx, (tx) => listAssetCategories(tx));
    checkTrue(
      "while that tenant still has its own seeded vocabulary",
      acrossCategories.length >= STANDARD_ASSET_CATEGORIES.length,
    );
  } else {
    console.log("skip  RLS isolation not proven — only one tenant exists in this database");
  }

  // ── Clean-up ─────────────────────────────────────────────────────────────
  await withTenant(ctx, async (tx) => {
    if (createdJobs.length > 0) {
      await tx.delete(schema.jobs).where(inArray(schema.jobs.id, createdJobs));
    }
    if (createdAssets.length > 0) {
      await tx.delete(schema.assets).where(inArray(schema.assets.id, createdAssets));
    }
    // After the assets, which reference it: the FK is ON DELETE RESTRICT.
    if (createdCategories.length > 0) {
      await tx
        .delete(schema.assetCategories)
        .where(inArray(schema.assetCategories.id, createdCategories));
    }
    // Last: the jobs and the assets above both point at it.
    if (createdProperties.length > 0) {
      await tx.delete(schema.properties).where(inArray(schema.properties.id, createdProperties));
    }
  });

  const leftover = await withTenant(ctx, (tx) =>
    tx
      .select({ id: schema.assets.id })
      .from(schema.assets)
      .where(and(eq(schema.assets.tenantId, tenantId), inArray(schema.assets.id, createdAssets))),
  );
  check("the test removed everything it created", leftover.length, 0);

  console.log(fail === 0 ? "\nassets: all checks passed" : `\n${fail} check(s) failed`);
  await closeConnection();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await closeConnection();
  process.exit(1);
});
