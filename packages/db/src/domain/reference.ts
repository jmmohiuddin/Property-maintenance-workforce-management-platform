import { sql } from "drizzle-orm";
import {
  company,
  DEFAULT_CALENDAR,
  type CompanyIdentity,
  type WorkingCalendar,
} from "@meridian/core";
import type { TenantScopedTx, TenantContext } from "../index";

/**
 * Reference data, and the seam where it meets `packages/core` (`ADM-9`, `ADM-10`).
 *
 * ── WHY THE RESOLUTION HAPPENS HERE AND NOT IN CORE ─────────────────────────
 *
 * `packages/core` has zero runtime dependencies. That is not tidiness — it is
 * the property that lets the field app import the same working-calendar rules
 * and the same company identity the web app uses, so a technician's phone and a
 * dispatcher's browser cannot disagree about whether 13:40 on 3 July is legal
 * outdoor working time. A `core` that could read a database would be a `core`
 * the field app could not import.
 *
 * So `core` exposes defaults and takes a `WorkingCalendar` as an optional
 * parameter on every entry point, and this module — which is allowed to know
 * what a database is — resolves the stored values and passes them in. The seam
 * was designed for this; nothing in `core` changes to support it.
 *
 * ── THE RULE FOR UNSET VALUES, RESTATED ─────────────────────────────────────
 *
 * A value that is not configured stays `null` all the way through. Nothing here
 * invents a fallback, a dash or a plausible-looking default. The previous build
 * shipped a live site carrying a licence numbered `DED-000000` and the audit
 * classified it as a legal exposure; a missing fact renders as nothing, which is
 * honest, while an invented one renders as a fact.
 */

// ── Company identity (ADM-9) ────────────────────────────────────────────────

/**
 * The identity fields an administrator may override, stored under
 * `tenants.settings -> 'identity'`.
 *
 * Deliberately a flat record of `string | null` rather than the nested
 * `CompanyIdentity` shape. JSONB written by a form has to be merged key by key,
 * and a nested object makes "the operator cleared the street but not the city"
 * ambiguous in a way a flat map never is.
 */
export const IDENTITY_KEYS = [
  "legalName",
  "tradingName",
  "brandName",
  "licenceNumber",
  "licenceExpiry",
  "crNumber",
  "trn",
  "addressStreet",
  "addressCity",
  "addressRegion",
  "lat",
  "lng",
  "phone",
  "emergencyPhone",
  "whatsapp",
  "email",
] as const;

export type IdentityKey = (typeof IDENTITY_KEYS)[number];

/**
 * What is stored, not what is resolved.
 *
 * Three states per key, and the difference between the last two is the whole
 * point of the type:
 *
 *  * **absent** — never overridden. The configured value wins.
 *  * **a string** — the administrator set this.
 *  * **`null`** — the administrator *cleared* this, on purpose.
 *
 * Collapsing the last two would mean clearing a placeholder TRN in the admin
 * screen silently restored the placeholder from the environment on the next
 * page load, and the operator would have no way to tell.
 */
export type IdentityOverride = Partial<Record<IdentityKey, string | null>>;

export async function loadIdentityOverride(tx: TenantScopedTx): Promise<IdentityOverride> {
  const rows = (await tx.execute<{ identity: unknown }>(sql`
    select coalesce(settings -> 'identity', '{}'::jsonb) as identity from tenants
  `)) as unknown as { identity: unknown }[];

  const raw = rows[0]?.identity;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  // Filtered to the known key set rather than spread wholesale. `settings` is a
  // schemaless column that other features also write to, and a rename or a typo
  // upstream should produce a field that is not overridden rather than a field
  // that is overridden with something unexpected.
  const source = raw as Record<string, unknown>;
  const override: Record<string, string | null> = {};
  for (const key of IDENTITY_KEYS) {
    if (!(key in source)) continue;
    const value = source[key];
    override[key] = typeof value === "string" && value.trim() ? value.trim() : null;
  }
  return override as IdentityOverride;
}

function coordinate(value: string | null | undefined, fallback: number | null): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Configuration, with the stored override on top.
 *
 * ── WHICH ONE WINS, AND WHY ─────────────────────────────────────────────────
 *
 * The stored value wins where it exists; environment configuration fills every
 * key nobody has touched. `ADM-9` describes this the other way round —
 * "environment configuration with a database fallback" — and that order cannot
 * be built: an admin screen whose saved value is silently ignored because a
 * deployment variable outranks it is worse than either ordering on its own,
 * because the operator sees their change accepted and then sees the old value.
 *
 * The case the PRD was protecting is still served. A staging environment has
 * its own database and therefore its own `tenants` row, so it does not inherit
 * production's licence number; and a key nobody has edited in the screen still
 * comes from `COMPANY_*`, which is how a fresh deployment starts out correct.
 *
 * A non-null field of `CompanyIdentity` (legal name, brand name) treats a
 * cleared override as "not set" and falls back, because there is no such thing
 * as a company with no legal name — only a form somebody submitted empty.
 */
export function applyIdentityOverride(
  base: CompanyIdentity,
  override: IdentityOverride,
): CompanyIdentity {
  const pick = (key: IdentityKey, fallback: string | null): string | null =>
    key in override ? (override[key] ?? null) : fallback;

  return {
    ...base,
    legalName: pick("legalName", base.legalName) ?? base.legalName,
    tradingName: pick("tradingName", base.tradingName),
    brandName: pick("brandName", base.brandName) ?? base.brandName,

    licenceNumber: pick("licenceNumber", base.licenceNumber),
    licenceExpiry: pick("licenceExpiry", base.licenceExpiry),
    crNumber: pick("crNumber", base.crNumber),
    trn: pick("trn", base.trn),

    address: {
      ...base.address,
      street: pick("addressStreet", base.address.street),
      city: pick("addressCity", base.address.city) ?? base.address.city,
      region: pick("addressRegion", base.address.region) ?? base.address.region,
      lat: coordinate(override["lat"], base.address.lat),
      lng: coordinate(override["lng"], base.address.lng),
    },

    phone: pick("phone", base.phone),
    emergencyPhone: pick("emergencyPhone", base.emergencyPhone),
    // Digits only, exactly as the configured value is normalised, so a wa.me
    // link built from a stored number cannot come out with spaces in it.
    whatsapp: pick("whatsapp", base.whatsapp)?.replace(/[^\d]/g, "") || null,
    email: pick("email", base.email),
  };
}

/** The identity this tenant actually publishes. */
export async function resolveCompanyIdentity(tx: TenantScopedTx): Promise<CompanyIdentity> {
  return applyIdentityOverride(company, await loadIdentityOverride(tx));
}

/**
 * Persist the override, merging rather than replacing.
 *
 * `settings` is shared with other features, so the write targets the `identity`
 * key alone via `jsonb_set`. A whole-column write here would erase whatever the
 * next feature stores beside it, and would do so silently.
 */
export async function saveIdentityOverride(
  tx: TenantScopedTx,
  ctx: TenantContext,
  override: IdentityOverride,
): Promise<void> {
  await tx.execute(sql`
    update tenants
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{identity}', ${JSON.stringify(override)}::jsonb, true)
     where id = ${ctx.tenantId}::uuid
  `);
}

/**
 * Keep the `tenants` row's own name columns in step with the override.
 *
 * `tenants.brand_name` is what the application shell renders in the top-left
 * corner, and `tenants.legal_name` is what a cross-tenant report reads. Leaving
 * them behind would mean the admin screen said one name and every page header
 * said another, which reads as a bug in whichever one the person trusts less.
 */
export async function syncTenantNames(
  tx: TenantScopedTx,
  ctx: TenantContext,
  names: { legalName: string; brandName: string },
): Promise<void> {
  await tx.execute(sql`
    update tenants
       set legal_name = ${names.legalName},
           brand_name = ${names.brandName}
     where id = ${ctx.tenantId}::uuid
  `);
}

// ── The working calendar (ADM-10, JOB-6) ────────────────────────────────────

export interface PublicHolidayRow {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly name: string;
  readonly sourceNote: string | null;
}

export interface RamadanPeriodRow {
  readonly id: string;
  readonly label: string;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly sourceNote: string | null;
}

export interface CalendarSettingsRow {
  readonly weekendDays: readonly number[];
  readonly openMinute: number;
  readonly closeMinute: number;
  readonly minBreakMinutes: number;
  /** False until somebody has saved the screen. Drives the "still default" note. */
  readonly isStored: boolean;
}

export async function listPublicHolidays(
  tx: TenantScopedTx,
): Promise<readonly PublicHolidayRow[]> {
  const rows = (await tx.execute<{
    id: string;
    holiday_date: string;
    name: string;
    source_note: string | null;
  }>(sql`
    select id, to_char(holiday_date, 'YYYY-MM-DD') as holiday_date, name, source_note
      from public_holidays
     order by holiday_date
  `)) as unknown as {
    id: string;
    holiday_date: string;
    name: string;
    source_note: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    date: r.holiday_date,
    name: r.name,
    sourceNote: r.source_note,
  }));
}

export async function listRamadanPeriods(
  tx: TenantScopedTx,
): Promise<readonly RamadanPeriodRow[]> {
  const rows = (await tx.execute<{
    id: string;
    label: string;
    starts_on: string;
    ends_on: string;
    source_note: string | null;
  }>(sql`
    select id,
           label,
           to_char(starts_on, 'YYYY-MM-DD') as starts_on,
           to_char(ends_on, 'YYYY-MM-DD') as ends_on,
           source_note
      from ramadan_periods
     order by starts_on
  `)) as unknown as {
    id: string;
    label: string;
    starts_on: string;
    ends_on: string;
    source_note: string | null;
  }[];

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    startsOn: r.starts_on,
    endsOn: r.ends_on,
    sourceNote: r.source_note,
  }));
}

export async function loadCalendarSettings(tx: TenantScopedTx): Promise<CalendarSettingsRow> {
  const rows = (await tx.execute<{
    weekend_days: number[];
    open_minute: number;
    close_minute: number;
    min_break_minutes: number;
  }>(sql`
    select weekend_days, open_minute, close_minute, min_break_minutes
      from calendar_settings
     limit 1
  `)) as unknown as {
    weekend_days: number[];
    open_minute: number;
    close_minute: number;
    min_break_minutes: number;
  }[];

  const row = rows[0];
  if (!row) {
    return {
      weekendDays: DEFAULT_CALENDAR.weekend,
      openMinute: DEFAULT_CALENDAR.openMinute,
      closeMinute: DEFAULT_CALENDAR.closeMinute,
      minBreakMinutes: DEFAULT_CALENDAR.minBreakMinutes,
      isStored: false,
    };
  }

  return {
    weekendDays: row.weekend_days.map(Number),
    openMinute: Number(row.open_minute),
    closeMinute: Number(row.close_minute),
    minBreakMinutes: Number(row.min_break_minutes),
    isStored: true,
  };
}

/**
 * The calendar this tenant actually works to.
 *
 * Note what is *not* read from the database: `middayBan`, the Ramadan
 * reduction, and the statutory maxima all come from `DEFAULT_CALENDAR`. They
 * have no columns, so this function could not read them if it wanted to — which
 * is the point. The midday ban carries AED 5,000 per worker and is a hard block
 * in `checkOutdoorWork`; a hard block that a form post can switch off is a
 * warning wearing a costume.
 */
export async function loadWorkingCalendar(tx: TenantScopedTx): Promise<WorkingCalendar> {
  const [settings, holidays, ramadan] = await Promise.all([
    loadCalendarSettings(tx),
    listPublicHolidays(tx),
    listRamadanPeriods(tx),
  ]);

  const publicHolidayMap: Record<string, string> = {};
  for (const holiday of holidays) publicHolidayMap[holiday.date] = holiday.name;

  return {
    ...DEFAULT_CALENDAR,
    weekend: settings.weekendDays,
    openMinute: settings.openMinute,
    closeMinute: settings.closeMinute,
    minBreakMinutes: settings.minBreakMinutes,
    publicHolidays: publicHolidayMap,
    ramadanPeriods: ramadan.map((r) => [r.startsOn, r.endsOn] as const),
  };
}

export async function saveCalendarSettings(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    weekendDays: readonly number[];
    openMinute: number;
    closeMinute: number;
    minBreakMinutes: number;
  },
): Promise<void> {
  // Upsert rather than insert-then-update: the first save of a tenant that has
  // been running on the defaults has no row to update, and two administrators
  // saving the screen at the same moment must not collide on the primary key.
  await tx.execute(sql`
    insert into calendar_settings (tenant_id, weekend_days, open_minute, close_minute, min_break_minutes)
    values (
      ${ctx.tenantId}::uuid,
      ${`{${input.weekendDays.join(",")}}`}::smallint[],
      ${input.openMinute},
      ${input.closeMinute},
      ${input.minBreakMinutes}
    )
    on conflict (tenant_id) do update
      set weekend_days = excluded.weekend_days,
          open_minute = excluded.open_minute,
          close_minute = excluded.close_minute,
          min_break_minutes = excluded.min_break_minutes
  `);
}

export async function addPublicHoliday(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { date: string; name: string; sourceNote?: string | null },
): Promise<void> {
  // `do update` rather than `do nothing`: re-entering a date the administrator
  // already has is almost always a correction to the name, and silently
  // discarding it would look like the form did not work.
  await tx.execute(sql`
    insert into public_holidays (tenant_id, holiday_date, name, source_note)
    values (${ctx.tenantId}::uuid, ${input.date}::date, ${input.name}, ${input.sourceNote ?? null})
    on conflict (tenant_id, holiday_date) do update
      set name = excluded.name,
          source_note = excluded.source_note
  `);
}

export async function deletePublicHoliday(tx: TenantScopedTx, id: string): Promise<void> {
  // No tenant clause: RLS supplies it, and adding one here would suggest the
  // WHERE is the boundary. The row is invisible outside its tenant, so this
  // deletes nothing rather than deleting somebody else's holiday.
  await tx.execute(sql`delete from public_holidays where id = ${id}::uuid`);
}

export async function addRamadanPeriod(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { label: string; startsOn: string; endsOn: string; sourceNote?: string | null },
): Promise<void> {
  await tx.execute(sql`
    insert into ramadan_periods (tenant_id, label, starts_on, ends_on, source_note)
    values (
      ${ctx.tenantId}::uuid,
      ${input.label},
      ${input.startsOn}::date,
      ${input.endsOn}::date,
      ${input.sourceNote ?? null}
    )
    on conflict (tenant_id, starts_on) do update
      set label = excluded.label,
          ends_on = excluded.ends_on,
          source_note = excluded.source_note
  `);
}

export async function deleteRamadanPeriod(tx: TenantScopedTx, id: string): Promise<void> {
  await tx.execute(sql`delete from ramadan_periods where id = ${id}::uuid`);
}
