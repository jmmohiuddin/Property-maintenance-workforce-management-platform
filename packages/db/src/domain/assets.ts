import { sql, and, eq, isNull } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import { UserFacingError } from "@meridian/core";
import { rowDate, requiredRowDate } from "./_rows";

/**
 * The asset register — `CON-13`.
 *
 * ── WHAT THIS MODULE IS FOR ─────────────────────────────────────────────────
 *
 * A commercial AMC is priced per asset and a tender is evaluated on the plant
 * list behind it. Until this module existed the `assets` table had no writer,
 * which meant the answer to "what are we contracted to maintain in this
 * building" lived in a spreadsheet on somebody's laptop, and the answer to
 * "what has this chiller cost us" did not exist at all.
 *
 * ── THE PART THAT MAKES IT A REGISTER RATHER THAN A FORM ────────────────────
 *
 * Service history. `jobs.asset_id` has existed since migration 0000 with a
 * foreign key onto `assets`, and nothing has ever written it: no job screen
 * offers an asset, and `domain/jobs.ts` neither reads nor sets the column. A
 * register that no job can point at is a data-entry screen wearing the word
 * "history", so this module supplies the missing half from the asset side —
 * `listLinkableJobs` finds the work already recorded at the property, and
 * `linkJobToAsset` attaches one to the plant it was done on.
 *
 * That is a real path, not the whole path. The job intake screens still do not
 * ask which asset the work is for, so history is attached after the fact rather
 * than captured at the point of work. Closing that means an asset picker on the
 * job form, in code this module does not own.
 *
 * ── DAYS ARE STRINGS HERE, END TO END ───────────────────────────────────────
 *
 * `installedOn` and `warrantyExpiresOn` are `YYYY-MM-DD` strings from the
 * database to the screen and back, never `Date`. They are days, and a day that
 * round-trips through a JS `Date` moves by the reader's UTC offset — which for
 * Dubai means a warranty expiring on 1 July reads as expired on 30 June, or
 * (worse, and this is the direction the bug takes) an expired warranty reads as
 * live for the first four hours of every day. Everything derived from them —
 * days remaining, expired or not — is computed by Postgres against
 * `current_date`, which is the only clock both halves agree on.
 */

// ── The controlled vocabulary (CON-13, following ADM-10) ─────────────────────

export interface StandardAssetCategory {
  readonly code: string;
  readonly label: string;
  readonly description: string;
  readonly serviceSlug: string;
  readonly defaultPpmIntervalDays: number;
  readonly sortOrder: number;
}

/**
 * The seven kinds `CON-13` names, and the authority for them from here on.
 *
 * Prescribed by the requirement rather than chosen per business, which is why
 * these are seeded where the fault codes and disposition reasons are not: a
 * tenant whose picker is empty on day one records a kind that is free text with
 * extra steps, and that cannot be corrected later because the history is
 * already written by the time anyone wants to group by it.
 *
 * The intervals are the cycles this plant is actually maintained on in the UAE
 * — lifts monthly, tanks on the six-month cleaning cycle, boards on an annual
 * thermographic inspection, HVAC quarterly. They prefill the register and can
 * be overridden per asset; nothing enforces them.
 *
 * Migration 0021 carries a copy frozen at migration time, for tenants that
 * existed before this shipped.
 */
export const STANDARD_ASSET_CATEGORIES: readonly StandardAssetCategory[] = [
  {
    code: "chiller",
    label: "Chiller",
    description: "Central cooling plant. The single most expensive item on most AMCs.",
    serviceSlug: "hvac-installation-maintenance",
    defaultPpmIntervalDays: 90,
    sortOrder: 10,
  },
  {
    code: "split_unit",
    label: "Split unit",
    description: "Wall, ducted or cassette split serving one space.",
    serviceSlug: "hvac-installation-maintenance",
    defaultPpmIntervalDays: 90,
    sortOrder: 20,
  },
  {
    code: "fcu",
    label: "Fan coil unit (FCU)",
    description: "Chilled-water terminal unit. Usually one per apartment or zone.",
    serviceSlug: "hvac-installation-maintenance",
    defaultPpmIntervalDays: 90,
    sortOrder: 30,
  },
  {
    code: "pump",
    label: "Pump",
    description: "Water, booster, drainage, chilled-water or fire pump.",
    serviceSlug: "electromechanical-installation",
    defaultPpmIntervalDays: 180,
    sortOrder: 40,
  },
  {
    code: "water_tank",
    label: "Water tank",
    description: "Potable or storage tank. Cleaning and testing is on a six-month cycle.",
    serviceSlug: "building-cleaning",
    defaultPpmIntervalDays: 180,
    sortOrder: 50,
  },
  {
    code: "distribution_board",
    label: "Distribution board (DB)",
    description: "Main or sub distribution board, including its thermographic inspection.",
    serviceSlug: "electrical-fittings-repair",
    defaultPpmIntervalDays: 365,
    sortOrder: 60,
  },
  {
    code: "lift",
    label: "Lift",
    description: "Passenger or goods lift. Inspected monthly and by a third party annually.",
    serviceSlug: "electromechanical-installation",
    defaultPpmIntervalDays: 30,
    sortOrder: 70,
  },
] as const;

export interface AssetCategoryRow {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly serviceSlug: string | null;
  readonly defaultPpmIntervalDays: number | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

/**
 * The vocabulary.
 *
 * `activeOnly` for a picker, everything for the administration screen — the
 * same split `listJobOutcomeCodes` makes, for the same reason: a retired kind
 * has to disappear from the picker and stay visible to the person deciding
 * whether to bring it back.
 */
export async function listAssetCategories(
  tx: TenantScopedTx,
  options?: { activeOnly?: boolean },
): Promise<readonly AssetCategoryRow[]> {
  const activeOnly = options?.activeOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    code: string;
    label: string;
    description: string | null;
    service_slug: string | null;
    default_ppm_interval_days: number | null;
    sort_order: number;
    is_active: boolean;
  }>(sql`
    select id, code, label, description, service_slug, default_ppm_interval_days,
           sort_order, is_active
      from asset_categories
     where (${activeOnly} = false or is_active)
     order by sort_order, label
  `)) as unknown as {
    id: string;
    code: string;
    label: string;
    description: string | null;
    service_slug: string | null;
    default_ppm_interval_days: number | null;
    sort_order: number;
    is_active: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    serviceSlug: r.service_slug,
    defaultPpmIntervalDays: r.default_ppm_interval_days,
    sortOrder: Number(r.sort_order),
    isActive: r.is_active,
  }));
}

/**
 * Add a kind, or correct one that exists (`ADM-10`).
 *
 * Upsert on the code rather than insert, so re-entering a retired kind brings
 * it back with its history intact instead of failing on the unique index and
 * telling the operator the kind both does and does not exist.
 */
export async function addAssetCategory(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    code: string;
    label: string;
    description?: string | null;
    serviceSlug?: string | null;
    defaultPpmIntervalDays?: number | null;
    sortOrder?: number;
  },
): Promise<void> {
  if (input.defaultPpmIntervalDays !== null && input.defaultPpmIntervalDays !== undefined) {
    if (!Number.isInteger(input.defaultPpmIntervalDays) || input.defaultPpmIntervalDays <= 0) {
      throw new UserFacingError("A service interval is a whole number of days above zero.");
    }
  }

  await tx.execute(sql`
    insert into asset_categories
      (tenant_id, code, label, description, service_slug, default_ppm_interval_days, sort_order)
    values (
      ${ctx.tenantId}::uuid,
      ${input.code},
      ${input.label},
      ${input.description ?? null},
      ${input.serviceSlug ?? null},
      ${input.defaultPpmIntervalDays ?? null},
      ${input.sortOrder ?? 100}
    )
    on conflict (tenant_id, code) do update
      set label = excluded.label,
          description = excluded.description,
          service_slug = excluded.service_slug,
          default_ppm_interval_days = excluded.default_ppm_interval_days,
          sort_order = excluded.sort_order,
          is_active = true,
          updated_at = now()
  `);
}

/**
 * Retire or restore a kind.
 *
 * Never a delete. `assets.category_id` is ON DELETE RESTRICT and the plant
 * already recorded under a kind is the reason: removing it would either fail or
 * rewrite the register, and both are worse than a picker with one fewer option.
 */
export async function setAssetCategoryActive(
  tx: TenantScopedTx,
  categoryId: string,
  isActive: boolean,
): Promise<void> {
  await tx.execute(sql`
    update asset_categories
       set is_active = ${isActive}, updated_at = now()
     where id = ${categoryId}::uuid
  `);
}

/**
 * Put the seven kinds `CON-13` names into a tenant that is missing some.
 *
 * `do nothing` on conflict, so an operator's own wording for a kind they
 * already have survives — this adds what is absent and overwrites nothing.
 * Returns how many were actually inserted, counted from `returning` rather than
 * from a driver's row count, because reporting seven added when none were is
 * the failure mode of a screen like this.
 */
export async function installStandardAssetCategories(
  tx: TenantScopedTx,
  ctx: TenantContext,
): Promise<number> {
  let added = 0;
  for (const kind of STANDARD_ASSET_CATEGORIES) {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into asset_categories
        (tenant_id, code, label, description, service_slug, default_ppm_interval_days, sort_order)
      values (
        ${ctx.tenantId}::uuid,
        ${kind.code},
        ${kind.label},
        ${kind.description},
        ${kind.serviceSlug},
        ${kind.defaultPpmIntervalDays},
        ${kind.sortOrder}
      )
      on conflict (tenant_id, code) do nothing
      returning id
    `)) as unknown as { id: string }[];
    if (inserted.length > 0) added += 1;
  }
  return added;
}

/** How much plant is recorded under each kind. What a retire decision needs. */
export async function assetCountsByCategory(
  tx: TenantScopedTx,
): Promise<ReadonlyMap<string, number>> {
  const rows = (await tx.execute<{ category_id: string | null; total: number }>(sql`
    select category_id, count(*)::int as total
      from assets
     where deleted_at is null
     group by category_id
  `)) as unknown as { category_id: string | null; total: number }[];

  const counts = new Map<string, number>();
  for (const r of rows) if (r.category_id) counts.set(r.category_id, r.total);
  return counts;
}

// ── The property the register hangs off ──────────────────────────────────────

export interface PropertyRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly addressLine: string;
  readonly area: string | null;
  readonly city: string;
  readonly floors: number | null;
  readonly unitCount: number | null;
  readonly accessInstructions: string | null;
  readonly isActive: boolean;
  readonly customerId: string;
  readonly customerName: string;
}

/**
 * The property header the register is shown under.
 *
 * Properties had no record of their own before this: they were rows inside the
 * customer screen, which is why `CON-13` had nowhere to live.
 */
export async function getPropertyRecord(
  tx: TenantScopedTx,
  propertyId: string,
): Promise<PropertyRecord | null> {
  const rows = (await tx.execute<{
    id: string;
    name: string;
    type: string;
    address_line: string;
    area: string | null;
    city: string;
    floors: number | null;
    unit_count: number | null;
    access_instructions: string | null;
    is_active: boolean;
    customer_id: string;
    customer_name: string;
  }>(sql`
    select p.id, p.name, p.type, p.address_line, p.area, p.city, p.floors,
           p.unit_count, p.access_instructions, p.is_active,
           c.id as customer_id, c.name as customer_name
      from properties p
      join customers c on c.id = p.customer_id
     where p.id = ${propertyId} and p.deleted_at is null
  `)) as unknown as {
    id: string;
    name: string;
    type: string;
    address_line: string;
    area: string | null;
    city: string;
    floors: number | null;
    unit_count: number | null;
    access_instructions: string | null;
    is_active: boolean;
    customer_id: string;
    customer_name: string;
  }[];

  const r = rows[0];
  if (!r) return null;

  return {
    id: r.id,
    name: r.name,
    type: r.type,
    addressLine: r.address_line,
    area: r.area,
    city: r.city,
    floors: r.floors,
    unitCount: r.unit_count,
    accessInstructions: r.access_instructions,
    isActive: r.is_active,
    customerId: r.customer_id,
    customerName: r.customer_name,
  };
}

export interface PropertyUnitRow {
  readonly id: string;
  readonly reference: string;
  readonly floor: string | null;
}

/** The units an asset can be pinned to. An FCU serves a flat; a chiller does not. */
export async function listPropertyUnits(
  tx: TenantScopedTx,
  propertyId: string,
): Promise<readonly PropertyUnitRow[]> {
  const rows = await tx
    .select({
      id: schema.propertyUnits.id,
      reference: schema.propertyUnits.reference,
      floor: schema.propertyUnits.floor,
    })
    .from(schema.propertyUnits)
    .where(eq(schema.propertyUnits.propertyId, propertyId))
    .orderBy(schema.propertyUnits.reference);

  return rows;
}

// ── Reading the register ─────────────────────────────────────────────────────

export interface AssetRow {
  readonly id: string;
  readonly tag: string;
  readonly name: string;
  readonly categoryCode: string | null;
  readonly categoryLabel: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly location: string | null;
  readonly unitReference: string | null;
  readonly condition: string;
  /** `YYYY-MM-DD`, never a Date. See the module note. */
  readonly installedOn: string | null;
  readonly warrantyExpiresOn: string | null;
  /**
   * Negative once the warranty has run out, null when none was recorded.
   * Computed by Postgres against `current_date`, so it does not depend on the
   * clock or the offset of whatever machine rendered the page.
   */
  readonly warrantyDaysRemaining: number | null;
  readonly ppmIntervalDays: number | null;
  readonly lastServicedAt: Date | null;
  readonly nextServiceDueAt: Date | null;
  /** Jobs pointing at this asset. Zero means no history has been attached yet. */
  readonly jobCount: number;
}

type AssetRawRow = {
  id: string;
  tag: string;
  name: string;
  category_code: string | null;
  category_label: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  location: string | null;
  unit_reference: string | null;
  condition: string;
  installed_on: string | null;
  warranty_expires_on: string | null;
  warranty_days_remaining: number | null;
  ppm_interval_days: number | null;
  // Timestamps from a raw query arrive as strings, not Dates. See ./_rows.ts.
  last_serviced_at: string | null;
  next_service_due_at: string | null;
  job_count: number;
};

/** `::text` on the day columns, so the value that arrives is the day that was stored. */
const ASSET_COLUMNS = sql`
  a.id, a.tag, a.name,
  cat.code as category_code, cat.label as category_label,
  a.manufacturer, a.model, a.serial_number, a.location,
  u.reference as unit_reference,
  a.condition,
  a.installed_on::text as installed_on,
  a.warranty_expires_on::text as warranty_expires_on,
  (a.warranty_expires_on - current_date)::int as warranty_days_remaining,
  a.ppm_interval_days, a.last_serviced_at, a.next_service_due_at,
  (select count(*)::int from jobs j
    where j.asset_id = a.id and j.deleted_at is null) as job_count
`;

function toAssetRow(r: AssetRawRow): AssetRow {
  return {
    id: r.id,
    tag: r.tag,
    name: r.name,
    categoryCode: r.category_code,
    categoryLabel: r.category_label,
    manufacturer: r.manufacturer,
    model: r.model,
    serialNumber: r.serial_number,
    location: r.location,
    unitReference: r.unit_reference,
    condition: r.condition,
    installedOn: r.installed_on,
    warrantyExpiresOn: r.warranty_expires_on,
    warrantyDaysRemaining: r.warranty_days_remaining,
    ppmIntervalDays: r.ppm_interval_days,
    lastServicedAt: rowDate(r.last_serviced_at),
    nextServiceDueAt: rowDate(r.next_service_due_at),
    jobCount: r.job_count,
  };
}

/** Every asset registered at one property, newest plant last. */
export async function listPropertyAssets(
  tx: TenantScopedTx,
  propertyId: string,
): Promise<readonly AssetRow[]> {
  const rows = (await tx.execute<AssetRawRow>(sql`
    select ${ASSET_COLUMNS}
      from assets a
      left join asset_categories cat on cat.id = a.category_id
      left join property_units u on u.id = a.unit_id
     where a.property_id = ${propertyId} and a.deleted_at is null
     order by cat.sort_order nulls last, a.tag
  `)) as unknown as AssetRawRow[];

  return rows.map(toAssetRow);
}

export interface AssetServiceVisit {
  readonly jobId: string;
  readonly reference: string;
  readonly title: string;
  readonly status: string;
  readonly serviceSlug: string;
  readonly outcomeCode: string | null;
  readonly scheduledFor: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
}

export interface AssetRecord {
  readonly asset: AssetRow;
  readonly propertyId: string;
  readonly propertyName: string;
  readonly customerId: string;
  /** `CON-13`'s service history: the jobs done against this asset. */
  readonly history: readonly AssetServiceVisit[];
}

/** One asset, with the work recorded against it. */
export async function getAssetRecord(
  tx: TenantScopedTx,
  assetId: string,
): Promise<AssetRecord | null> {
  const rows = (await tx.execute<
    AssetRawRow & { property_id: string; property_name: string; customer_id: string }
  >(sql`
    select ${ASSET_COLUMNS},
           p.id as property_id, p.name as property_name, p.customer_id
      from assets a
      join properties p on p.id = a.property_id
      left join asset_categories cat on cat.id = a.category_id
      left join property_units u on u.id = a.unit_id
     where a.id = ${assetId} and a.deleted_at is null
  `)) as unknown as (AssetRawRow & {
    property_id: string;
    property_name: string;
    customer_id: string;
  })[];

  const r = rows[0];
  if (!r) return null;

  const history = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    status: string;
    service_slug: string;
    outcome_code: string | null;
    scheduled_for: string | null;
    completed_at: string | null;
    created_at: string;
  }>(sql`
    select id, reference, title, status, service_slug, outcome_code,
           scheduled_for, completed_at, created_at
      from jobs
     where asset_id = ${assetId} and deleted_at is null
     order by coalesce(completed_at, scheduled_for, created_at) desc
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    status: string;
    service_slug: string;
    outcome_code: string | null;
    scheduled_for: string | null;
    completed_at: string | null;
    created_at: string;
  }[];

  return {
    asset: toAssetRow(r),
    propertyId: r.property_id,
    propertyName: r.property_name,
    customerId: r.customer_id,
    history: history.map((h) => ({
      jobId: h.id,
      reference: h.reference,
      title: h.title,
      status: h.status,
      serviceSlug: h.service_slug,
      outcomeCode: h.outcome_code,
      scheduledFor: rowDate(h.scheduled_for),
      completedAt: rowDate(h.completed_at),
      createdAt: requiredRowDate(h.created_at),
    })),
  };
}

// ── Writing the register ─────────────────────────────────────────────────────

export interface RegisterAssetInput {
  readonly propertyId: string;
  readonly categoryId: string;
  readonly tag: string;
  readonly name: string;
  readonly unitId?: string | undefined;
  readonly manufacturer?: string | undefined;
  readonly model?: string | undefined;
  readonly serialNumber?: string | undefined;
  readonly location?: string | undefined;
  /** `YYYY-MM-DD`. Anything else is refused rather than coerced. */
  readonly installedOn?: string | undefined;
  readonly warrantyExpiresOn?: string | undefined;
  readonly condition?: "new" | "good" | "fair" | "poor" | "end_of_life" | undefined;
  /** Null or absent takes the category's default. */
  readonly ppmIntervalDays?: number | undefined;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(value: string | undefined, field: string): string | null {
  if (value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  if (!DAY_PATTERN.test(trimmed)) {
    throw new UserFacingError(`${field} must be a date in YYYY-MM-DD form.`);
  }
  return trimmed;
}

/**
 * Register one asset against a property.
 *
 * The tag is the identity a technician reads off the plant — CH-01, LIFT-2 —
 * and it is unique per tenant, not per property. That is deliberate: an asset
 * tag that means two things in two buildings is an asset tag nobody trusts on a
 * job card.
 */
export async function registerAsset(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: RegisterAssetInput,
): Promise<{ id: string }> {
  const tag = input.tag.trim().toUpperCase();
  const name = input.name.trim();

  if (tag.length < 2) throw new UserFacingError("Give the asset a tag — the label on the plant.");
  if (name.length < 2) throw new UserFacingError("Give the asset a name.");

  const installedOn = requireDay(input.installedOn, "Install date");
  const warrantyExpiresOn = requireDay(input.warrantyExpiresOn, "Warranty expiry");
  if (installedOn && warrantyExpiresOn && warrantyExpiresOn < installedOn) {
    // String comparison, and it is exact: YYYY-MM-DD sorts as it reads.
    throw new UserFacingError("The warranty cannot expire before the asset was installed.");
  }

  if (input.ppmIntervalDays !== undefined && input.ppmIntervalDays <= 0) {
    throw new UserFacingError("A PPM interval is a number of days greater than zero.");
  }

  // The property has to exist in this tenant. RLS makes another tenant's
  // property invisible here, so a foreign id fails this check rather than
  // silently attaching plant to a building somebody else owns.
  const [property] = await tx
    .select({ id: schema.properties.id })
    .from(schema.properties)
    .where(and(eq(schema.properties.id, input.propertyId), isNull(schema.properties.deletedAt)))
    .limit(1);
  if (!property) throw new UserFacingError("That property no longer exists.");

  const [category] = await tx
    .select({
      id: schema.assetCategories.id,
      defaultPpmIntervalDays: schema.assetCategories.defaultPpmIntervalDays,
      isActive: schema.assetCategories.isActive,
    })
    .from(schema.assetCategories)
    .where(eq(schema.assetCategories.id, input.categoryId))
    .limit(1);
  if (!category) throw new UserFacingError("Choose what kind of asset this is.");
  if (!category.isActive) throw new UserFacingError("That asset kind has been retired.");

  if (input.unitId) {
    const [unit] = await tx
      .select({ id: schema.propertyUnits.id })
      .from(schema.propertyUnits)
      .where(
        and(
          eq(schema.propertyUnits.id, input.unitId),
          eq(schema.propertyUnits.propertyId, input.propertyId),
        ),
      )
      .limit(1);
    if (!unit) throw new UserFacingError("That unit is not part of this property.");
  }

  const [duplicate] = await tx
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(and(eq(schema.assets.tag, tag), isNull(schema.assets.deletedAt)))
    .limit(1);
  if (duplicate) {
    throw new UserFacingError(`Asset tag ${tag} is already in use. Tags are unique across sites.`);
  }

  const [row] = await tx
    .insert(schema.assets)
    .values({
      tenantId: ctx.tenantId,
      propertyId: input.propertyId,
      unitId: input.unitId ?? null,
      categoryId: category.id,
      tag,
      name,
      manufacturer: input.manufacturer?.trim() || null,
      model: input.model?.trim() || null,
      serialNumber: input.serialNumber?.trim() || null,
      location: input.location?.trim() || null,
      installedOn,
      warrantyExpiresOn,
      condition: input.condition ?? "good",
      ppmIntervalDays: input.ppmIntervalDays ?? category.defaultPpmIntervalDays,
    })
    .returning({ id: schema.assets.id });

  if (!row) throw new UserFacingError("Could not register that asset.");
  return row;
}

// ── The path from a job to an asset ──────────────────────────────────────────

export interface LinkableJob {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly status: string;
  readonly createdAt: Date;
}

/**
 * Jobs at this property that are not yet attached to any asset.
 *
 * Deliberately excludes jobs already linked elsewhere: moving a job from one
 * asset to another is a correction, and a correction that looks like an
 * ordinary "add" is how one chiller's history quietly becomes another's.
 */
export async function listLinkableJobs(
  tx: TenantScopedTx,
  propertyId: string,
  limit = 50,
): Promise<readonly LinkableJob[]> {
  const rows = (await tx.execute<{
    id: string;
    reference: string;
    title: string;
    status: string;
    created_at: string;
  }>(sql`
    select id, reference, title, status, created_at
      from jobs
     where property_id = ${propertyId}
       and asset_id is null
       and deleted_at is null
     order by created_at desc
     limit ${limit}
  `)) as unknown as {
    id: string;
    reference: string;
    title: string;
    status: string;
    created_at: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    status: r.status,
    createdAt: requiredRowDate(r.created_at),
  }));
}

/**
 * Attach a job to the asset the work was done on.
 *
 * ── WHY THIS WRITES `jobs` FROM THE ASSET SIDE ──────────────────────────────
 *
 * `jobs.asset_id` is the only link between a register and a history, and
 * nothing has ever set it — the job intake screens do not ask. Until they do,
 * the history has to be attachable from the asset, or `CON-13`'s "service
 * history" is a heading over an empty list on every asset for ever.
 *
 * The job must already belong to this property: an asset is fixed to a
 * building, so a job somewhere else was not done on it, and accepting one would
 * put a visit into a history that a tender is later priced from.
 *
 * `last_serviced_at` and `next_service_due_at` are recomputed from the jobs
 * that are actually linked and actually finished, rather than being set to now.
 * They are the columns the PPM due list reads, and a due date derived from when
 * somebody happened to press a button is a due date that drifts.
 */
export async function linkJobToAsset(
  tx: TenantScopedTx,
  _ctx: TenantContext,
  input: { assetId: string; jobId: string },
): Promise<{ reference: string }> {
  const [asset] = await tx
    .select({ id: schema.assets.id, propertyId: schema.assets.propertyId })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, input.assetId), isNull(schema.assets.deletedAt)))
    .limit(1);
  if (!asset) throw new UserFacingError("That asset no longer exists.");

  const rows = (await tx.execute<{
    id: string;
    reference: string;
    property_id: string;
    asset_id: string | null;
  }>(sql`
    select id, reference, property_id, asset_id
      from jobs
     where id = ${input.jobId} and deleted_at is null
  `)) as unknown as {
    id: string;
    reference: string;
    property_id: string;
    asset_id: string | null;
  }[];

  const job = rows[0];
  if (!job) throw new UserFacingError("That job no longer exists.");
  if (job.property_id !== asset.propertyId) {
    throw new UserFacingError("That job was raised at a different property.");
  }
  if (job.asset_id === input.assetId) {
    throw new UserFacingError(`${job.reference} is already on this asset's history.`);
  }
  if (job.asset_id) {
    throw new UserFacingError(
      `${job.reference} is already attached to another asset. Detach it there first.`,
    );
  }

  await tx.execute(sql`
    update jobs set asset_id = ${input.assetId}, updated_at = now()
     where id = ${input.jobId}
  `);

  // Recomputed from what is linked, not from now. `completed_at` is set when the
  // work finished, so an asset serviced in March that is recorded in June still
  // falls due from March.
  await tx.execute(sql`
    update assets a
       set last_serviced_at = h.last_completed,
           next_service_due_at = case
             when a.ppm_interval_days is null then a.next_service_due_at
             else h.last_completed + make_interval(days => a.ppm_interval_days)
           end,
           updated_at = now()
      from (
        select max(completed_at) as last_completed
          from jobs
         where asset_id = ${input.assetId} and deleted_at is null
      ) h
     where a.id = ${input.assetId} and h.last_completed is not null
  `);

  return { reference: job.reference };
}
