import { sql } from "drizzle-orm";
import {
  company,
  DEFAULT_CALENDAR,
  services,
  toDecimalString,
  toMinor,
  UserFacingError,
  type CompanyIdentity,
  type WorkingCalendar,
} from "@meridian/core";
import { db, type TenantScopedTx, type TenantContext } from "../index";

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

// ── Controlled vocabularies (ADM-10) ────────────────────────────────────────
//
// The calendar above decides when work may happen. Everything below decides
// what an operator is allowed to *say* happened, which is the same problem one
// layer up. Two rules hold across all of it:
//
//   1. **Retire, never delete.** Every code here is cited by rows that are
//      already history — a lost lead, a completed visit, an issued quotation.
//      Deleting one either fails on a foreign key or, worse, succeeds and
//      rewrites the past. `isActive` takes it out of the picker and leaves it
//      in the data.
//   2. **The list is enforced where it is used, not where it is displayed.**
//      A vocabulary the code does not check is a suggestion; see
//      `resolveDispositionReason`, which is what `setLeadStage` calls before it
//      will move a lead to `lost`.

// ── Lead disposition reasons (LEAD-6) ───────────────────────────────────────

/** Which stage a reason may be given for. `both` covers either. */
export type DispositionScope = "lost" | "dormant" | "both";

export interface DispositionReasonRow {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly appliesTo: DispositionScope;
  readonly guidance: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  /** How many leads cite it. Retiring a reason nobody used is free; retiring
   *  one behind two hundred leads changes what a report means, so the screen
   *  says the number rather than making the operator guess. */
  readonly leadCount: number;
}

/**
 * A starting set of lost/dormant reasons, as data.
 *
 * Unlike fault codes and rate card prices, these six are near-universal
 * categories rather than anything specific to one business — every service
 * business loses work on price, to a competitor, to silence, to being outside
 * where it operates, because the need went away, or because the buyer wants to
 * revisit it next budget cycle. Naming them is not putting words in an
 * operator's mouth the way a price or a fault description would be; it is the
 * same judgement call `STANDARD_JOB_OUTCOMES` already makes for job outcomes.
 *
 * A fresh install otherwise leaves `lead_disposition_reasons` empty, and
 * `leads_disposition_required` then refuses every `lost` or `dormant` stage
 * change on day one — not because a real reason was missing, but because
 * nobody had typed the vocabulary in yet. `installStandardDispositionReasons`
 * exists so that is one click, not a blocked funnel.
 */
export const STANDARD_DISPOSITION_REASONS: readonly {
  code: string;
  label: string;
  appliesTo: DispositionScope;
  guidance: string;
  sortOrder: number;
}[] = [
  {
    code: "lost_on_price",
    label: "Price too high",
    appliesTo: "lost",
    guidance: "They wanted the work done, just not at this price.",
    sortOrder: 10,
  },
  {
    code: "competitor_won",
    label: "Chose a competitor",
    appliesTo: "lost",
    guidance: "They picked someone else — not necessarily on price.",
    sortOrder: 20,
  },
  {
    code: "no_response",
    label: "Stopped responding",
    appliesTo: "both",
    guidance:
      "Follow-ups went unanswered. Dormant if it is still worth trying again; lost if it has gone quiet for good.",
    sortOrder: 30,
  },
  {
    code: "out_of_area",
    label: "Outside the service area",
    appliesTo: "lost",
    guidance: "The property is somewhere this business does not send technicians.",
    sortOrder: 40,
  },
  {
    code: "work_no_longer_needed",
    label: "Work no longer needed",
    appliesTo: "lost",
    guidance: "The problem went away, was fixed elsewhere, or the plan changed.",
    sortOrder: 50,
  },
  {
    code: "budget_deferred",
    label: "Budget deferred",
    appliesTo: "dormant",
    guidance: "Wants the work, just not until a future budget period.",
    sortOrder: 60,
  },
];

export async function listDispositionReasons(
  tx: TenantScopedTx,
  options?: { stage?: "lost" | "dormant"; activeOnly?: boolean },
): Promise<readonly DispositionReasonRow[]> {
  // Both filters are applied in SQL rather than in JavaScript because the
  // picker on the field side will read this with an index behind it, and a
  // filter that exists only in the caller is a filter the next caller forgets.
  const stage = options?.stage ?? null;
  const activeOnly = options?.activeOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    code: string;
    label: string;
    applies_to: string;
    guidance: string | null;
    sort_order: number;
    is_active: boolean;
    lead_count: string;
  }>(sql`
    select r.id,
           r.code,
           r.label,
           r.applies_to,
           r.guidance,
           r.sort_order,
           r.is_active,
           (select count(*) from leads l where l.disposition_reason_id = r.id) as lead_count
      from lead_disposition_reasons r
     where (${stage}::text is null or r.applies_to in (${stage}, 'both'))
       and (${activeOnly} = false or r.is_active)
     order by r.sort_order, r.label
  `)) as unknown as {
    id: string;
    code: string;
    label: string;
    applies_to: string;
    guidance: string | null;
    sort_order: number;
    is_active: boolean;
    lead_count: string;
  }[];

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    appliesTo: r.applies_to as DispositionScope,
    guidance: r.guidance,
    sortOrder: Number(r.sort_order),
    isActive: r.is_active,
    leadCount: Number(r.lead_count),
  }));
}

/**
 * Put the six standard reasons in place, leaving any local edits alone.
 *
 * `do nothing` rather than `do update`, exactly as `installStandardJobOutcomes`
 * does: an operator who has reworded "Price too high" for their own team should
 * not have that undone by somebody clicking the button again, and the codes —
 * which is what a funnel report groups on — are identical either way.
 */
export async function installStandardDispositionReasons(
  tx: TenantScopedTx,
  ctx: TenantContext,
): Promise<number> {
  let added = 0;
  for (const reason of STANDARD_DISPOSITION_REASONS) {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into lead_disposition_reasons
        (tenant_id, code, label, applies_to, guidance, sort_order)
      values (
        ${ctx.tenantId}::uuid,
        ${reason.code},
        ${reason.label},
        ${reason.appliesTo},
        ${reason.guidance},
        ${reason.sortOrder}
      )
      on conflict (tenant_id, code) do nothing
      returning id
    `)) as unknown as { id: string }[];
    if (inserted.length > 0) added += 1;
  }
  return added;
}

/**
 * The reason a lead may actually be closed with, or nothing.
 *
 * `setLeadStage` calls this before it will write `lost` or `dormant`, and
 * refuses when it returns null. That is `LEAD-6` taken literally: a controlled
 * vocabulary the application does not check is a suggestion, and the reason
 * field is the entire reason the funnel is analytically useful.
 *
 * Three ways to return null, and they are deliberately indistinguishable to the
 * caller: no such reason, retired, or belongs to the other stage. All three
 * mean the same thing at the point of use — this is not a valid answer to this
 * question — and the message the operator sees is better written once by the
 * caller than assembled from a failure code here.
 */
export async function resolveDispositionReason(
  tx: TenantScopedTx,
  reasonId: string,
  stage: "lost" | "dormant",
): Promise<{ id: string; code: string; label: string } | null> {
  const rows = (await tx.execute<{ id: string; code: string; label: string }>(sql`
    select id, code, label
      from lead_disposition_reasons
     where id = ${reasonId}::uuid
       and is_active
       and applies_to in (${stage}, 'both')
     limit 1
  `)) as unknown as { id: string; code: string; label: string }[];

  return rows[0] ?? null;
}

export async function addDispositionReason(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    code: string;
    label: string;
    appliesTo: DispositionScope;
    guidance?: string | null;
    sortOrder?: number;
  },
): Promise<void> {
  // Re-entering an existing code updates it, matching the holiday form above.
  // A silently discarded edit looks identical to a broken form, and the code is
  // the identity here precisely so the label can be corrected.
  await tx.execute(sql`
    insert into lead_disposition_reasons (tenant_id, code, label, applies_to, guidance, sort_order)
    values (
      ${ctx.tenantId}::uuid,
      ${input.code},
      ${input.label},
      ${input.appliesTo},
      ${input.guidance ?? null},
      ${input.sortOrder ?? 100}
    )
    on conflict (tenant_id, code) do update
      set label = excluded.label,
          applies_to = excluded.applies_to,
          guidance = excluded.guidance,
          sort_order = excluded.sort_order,
          is_active = true
  `);
}

/**
 * Take a reason out of the picker, or put it back.
 *
 * There is no delete. A reason cited by a lost lead is part of what that lead
 * means, and the foreign key is `ON DELETE restrict` so the database agrees.
 */
export async function setDispositionReasonActive(
  tx: TenantScopedTx,
  reasonId: string,
  isActive: boolean,
): Promise<void> {
  await tx.execute(sql`
    update lead_disposition_reasons set is_active = ${isActive} where id = ${reasonId}::uuid
  `);
}

// ── Fault codes (JOB-14) ────────────────────────────────────────────────────

export type FaultCodeKind = "symptom" | "cause" | "remedy";

export const FAULT_CODE_KINDS: readonly FaultCodeKind[] = ["symptom", "cause", "remedy"];

export interface FaultCodeRow {
  readonly id: string;
  readonly kind: FaultCodeKind;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  /** Null means every service. */
  readonly serviceSlug: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export async function listFaultCodes(
  tx: TenantScopedTx,
  options?: { kind?: FaultCodeKind; serviceSlug?: string; activeOnly?: boolean },
): Promise<readonly FaultCodeRow[]> {
  const kind = options?.kind ?? null;
  const serviceSlug = options?.serviceSlug ?? null;
  const activeOnly = options?.activeOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    kind: string;
    code: string;
    label: string;
    description: string | null;
    service_slug: string | null;
    sort_order: number;
    is_active: boolean;
  }>(sql`
    select id, kind, code, label, description, service_slug, sort_order, is_active
      from fault_codes
     where (${kind}::text is null or kind = ${kind})
       -- A code with no service applies to every service, so a service filter
       -- has to keep the unscoped ones. Dropping them is how a technician on an
       -- AC job loses "no power at the isolator".
       and (${serviceSlug}::text is null or service_slug is null or service_slug = ${serviceSlug})
       and (${activeOnly} = false or is_active)
     order by kind, sort_order, label
  `)) as unknown as {
    id: string;
    kind: string;
    code: string;
    label: string;
    description: string | null;
    service_slug: string | null;
    sort_order: number;
    is_active: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as FaultCodeKind,
    code: r.code,
    label: r.label,
    description: r.description,
    serviceSlug: r.service_slug,
    sortOrder: Number(r.sort_order),
    isActive: r.is_active,
  }));
}

export async function addFaultCode(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    kind: FaultCodeKind;
    code: string;
    label: string;
    description?: string | null;
    serviceSlug?: string | null;
    sortOrder?: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into fault_codes (tenant_id, kind, code, label, description, service_slug, sort_order)
    values (
      ${ctx.tenantId}::uuid,
      ${input.kind},
      ${input.code},
      ${input.label},
      ${input.description ?? null},
      ${input.serviceSlug ?? null},
      ${input.sortOrder ?? 100}
    )
    on conflict (tenant_id, kind, code) do update
      set label = excluded.label,
          description = excluded.description,
          service_slug = excluded.service_slug,
          sort_order = excluded.sort_order,
          is_active = true
  `);
}

export async function setFaultCodeActive(
  tx: TenantScopedTx,
  faultCodeId: string,
  isActive: boolean,
): Promise<void> {
  await tx.execute(sql`
    update fault_codes set is_active = ${isActive} where id = ${faultCodeId}::uuid
  `);
}

// ── Job outcome codes (JOB-13) ──────────────────────────────────────────────

export interface JobOutcomeRow {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly description: string | null;
  readonly isTerminal: boolean;
  readonly requiresReturnVisit: boolean;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

/**
 * The seven `JOB-13` names, as data.
 *
 * Prescribed by the requirement rather than chosen by the operator, so a tenant
 * starts with them rather than with an empty list — an empty list would mean
 * the first completed job has nothing valid to record, and "nothing valid to
 * record" is how a free-text field gets added back.
 *
 * `no_access` and `customer_not_home` carry `requiresReturnVisit`, which is the
 * requirement's actual point: they are a large share of real visits, they are
 * not failures to be tidied away, and the work is still owed afterwards.
 */
export const STANDARD_JOB_OUTCOMES: readonly {
  code: string;
  label: string;
  description: string;
  isTerminal: boolean;
  requiresReturnVisit: boolean;
  sortOrder: number;
}[] = [
  {
    code: "completed",
    label: "Completed",
    description: "Work finished on this visit. Nothing outstanding.",
    isTerminal: true,
    requiresReturnVisit: false,
    sortOrder: 10,
  },
  {
    code: "partial",
    label: "Partially complete",
    description: "Some of the scope was done; the rest is still owed.",
    isTerminal: false,
    requiresReturnVisit: true,
    sortOrder: 20,
  },
  {
    code: "return_visit_required",
    label: "Return visit required",
    description: "Parts on order, another trade needed, or the work does not fit one visit.",
    isTerminal: false,
    requiresReturnVisit: true,
    sortOrder: 30,
  },
  {
    code: "no_access",
    label: "No access",
    description: "Could not reach the work: no key, no permit, blocked area.",
    isTerminal: false,
    requiresReturnVisit: true,
    sortOrder: 40,
  },
  {
    code: "customer_not_home",
    label: "Customer not home",
    description: "Nobody on site at the agreed time.",
    isTerminal: false,
    requiresReturnVisit: true,
    sortOrder: 50,
  },
  {
    code: "aborted_unsafe",
    label: "Aborted — unsafe",
    description: "Stopped on safety grounds. Records why the visit produced no work.",
    isTerminal: false,
    requiresReturnVisit: true,
    sortOrder: 60,
  },
  {
    code: "quote_required",
    label: "Quote required",
    description: "Scope is larger than the visit; priced rather than carried out.",
    isTerminal: true,
    requiresReturnVisit: false,
    sortOrder: 70,
  },
];

export async function listJobOutcomeCodes(
  tx: TenantScopedTx,
  options?: { activeOnly?: boolean },
): Promise<readonly JobOutcomeRow[]> {
  const activeOnly = options?.activeOnly ?? false;

  const rows = (await tx.execute<{
    id: string;
    code: string;
    label: string;
    description: string | null;
    is_terminal: boolean;
    requires_return_visit: boolean;
    sort_order: number;
    is_active: boolean;
  }>(sql`
    select id, code, label, description, is_terminal, requires_return_visit, sort_order, is_active
      from job_outcome_codes
     where (${activeOnly} = false or is_active)
     order by sort_order, label
  `)) as unknown as {
    id: string;
    code: string;
    label: string;
    description: string | null;
    is_terminal: boolean;
    requires_return_visit: boolean;
    sort_order: number;
    is_active: boolean;
  }[];

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    label: r.label,
    description: r.description,
    isTerminal: r.is_terminal,
    requiresReturnVisit: r.requires_return_visit,
    sortOrder: Number(r.sort_order),
    isActive: r.is_active,
  }));
}

/**
 * Put the seven standard outcomes in place, leaving any local edits alone.
 *
 * `do nothing` rather than `do update`: an operator who has reworded "Customer
 * not home" for their own dispatchers should not have that undone by somebody
 * clicking a restore button, and the codes — which is what reports group on —
 * are identical either way.
 */
export async function installStandardJobOutcomes(
  tx: TenantScopedTx,
  ctx: TenantContext,
): Promise<number> {
  let added = 0;
  for (const outcome of STANDARD_JOB_OUTCOMES) {
    // `returning` rather than a row count, because how a driver reports "rows
    // affected" varies and a wrong number here would tell the operator seven
    // outcomes were installed when none were.
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into job_outcome_codes
        (tenant_id, code, label, description, is_terminal, requires_return_visit, sort_order)
      values (
        ${ctx.tenantId}::uuid,
        ${outcome.code},
        ${outcome.label},
        ${outcome.description},
        ${outcome.isTerminal},
        ${outcome.requiresReturnVisit},
        ${outcome.sortOrder}
      )
      on conflict (tenant_id, code) do nothing
      returning id
    `)) as unknown as { id: string }[];
    if (inserted.length > 0) added += 1;
  }
  return added;
}

export async function addJobOutcomeCode(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    code: string;
    label: string;
    description?: string | null;
    isTerminal: boolean;
    requiresReturnVisit: boolean;
    sortOrder?: number;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into job_outcome_codes
      (tenant_id, code, label, description, is_terminal, requires_return_visit, sort_order)
    values (
      ${ctx.tenantId}::uuid,
      ${input.code},
      ${input.label},
      ${input.description ?? null},
      ${input.isTerminal},
      ${input.requiresReturnVisit},
      ${input.sortOrder ?? 100}
    )
    on conflict (tenant_id, code) do update
      set label = excluded.label,
          description = excluded.description,
          is_terminal = excluded.is_terminal,
          requires_return_visit = excluded.requires_return_visit,
          sort_order = excluded.sort_order,
          is_active = true
  `);
}

export async function setJobOutcomeActive(
  tx: TenantScopedTx,
  outcomeId: string,
  isActive: boolean,
): Promise<void> {
  await tx.execute(sql`
    update job_outcome_codes set is_active = ${isActive} where id = ${outcomeId}::uuid
  `);
}

// ── Rate card (QTE-4, WEB-16) ───────────────────────────────────────────────

export type RateBand = "standard" | "after_hours" | "emergency" | "weekend";

export const RATE_BANDS: readonly RateBand[] = [
  "standard",
  "after_hours",
  "emergency",
  "weekend",
];

export const RATE_BAND_LABEL: Readonly<Record<RateBand, string>> = {
  standard: "Standard",
  after_hours: "After hours",
  emergency: "Emergency",
  weekend: "Weekend",
};

/** The units a rate may be quoted in. Closed, because the quote builder
 *  multiplies by them and "hr" beside "hour" is both an arithmetic hazard and a
 *  published rate card that reads as though nobody checked it. */
export const RATE_UNITS = [
  "hour",
  "visit",
  "point",
  "item",
  "m2",
  "metre",
  "day",
  "month",
] as const;

export type RateUnit = (typeof RATE_UNITS)[number];

export const RATE_UNIT_LABEL: Readonly<Record<RateUnit, string>> = {
  hour: "per hour",
  visit: "per visit",
  point: "per point",
  item: "per item",
  m2: "per m²",
  metre: "per metre",
  day: "per day",
  month: "per month",
};

export interface RateCardRow {
  readonly id: string;
  readonly code: string;
  readonly serviceSlug: string;
  readonly label: string;
  readonly unit: RateUnit;
  readonly rateBand: RateBand;
  /** Integer minor units — fils. Never a float, never a decimal number. */
  readonly unitPriceMinor: number;
  readonly currency: string;
  /** Minor units are wrong for a quantity; this is a decimal string or null. */
  readonly minQuantity: string | null;
  readonly notes: string | null;
  readonly isPublished: boolean;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

function toRateRow(r: {
  id: string;
  code: string;
  service_slug: string;
  label: string;
  unit: string;
  rate_band: string;
  unit_price: string;
  currency: string;
  min_quantity: string | null;
  notes: string | null;
  is_published: boolean;
  effective_from: string;
  effective_to: string | null;
}): RateCardRow {
  return {
    id: r.id,
    code: r.code,
    serviceSlug: r.service_slug,
    label: r.label,
    unit: r.unit as RateUnit,
    rateBand: r.rate_band as RateBand,
    // The one conversion that matters. `numeric` arrives as a string and is
    // parsed to integer fils here, at the edge, so nothing downstream is ever
    // handed a float to add up. See packages/core/src/money.ts.
    unitPriceMinor: toMinor(r.unit_price),
    currency: r.currency,
    minQuantity: r.min_quantity,
    notes: r.notes,
    isPublished: r.is_published,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

type RateCardSqlRow = Parameters<typeof toRateRow>[0];

/**
 * The rate card as it stood on a given day.
 *
 * `onDate` defaults to today, and passing a past date is the whole point of the
 * table: "what did we charge for this in March" has to be answerable in July,
 * or a quotation cannot be defended once a price has moved. The half-open
 * period means a rate ending on the day the next one starts applies to neither
 * day twice.
 */
export async function listRateCard(
  tx: TenantScopedTx,
  options?: { onDate?: string; publishedOnly?: boolean; serviceSlug?: string },
): Promise<readonly RateCardRow[]> {
  const onDate = options?.onDate ?? null;
  const publishedOnly = options?.publishedOnly ?? false;
  const serviceSlug = options?.serviceSlug ?? null;

  const rows = (await tx.execute<RateCardSqlRow>(sql`
    with as_of as (select coalesce(${onDate}::date, current_date) as d)
    select r.id,
           r.code,
           r.service_slug,
           r.label,
           r.unit,
           r.rate_band,
           r.unit_price,
           r.currency,
           r.min_quantity,
           r.notes,
           r.is_published,
           to_char(r.effective_from, 'YYYY-MM-DD') as effective_from,
           to_char(r.effective_to, 'YYYY-MM-DD') as effective_to
      from rate_card_items r, as_of
     where r.effective_from <= as_of.d
       and (r.effective_to is null or r.effective_to > as_of.d)
       and (${publishedOnly} = false or r.is_published)
       and (${serviceSlug}::text is null or r.service_slug = ${serviceSlug})
     order by r.service_slug, r.code, r.rate_band
  `)) as unknown as RateCardSqlRow[];

  return rows.map(toRateRow);
}

/** Every version of one priced thing, newest first. The audit answer. */
export async function listRateHistory(
  tx: TenantScopedTx,
  code: string,
): Promise<readonly RateCardRow[]> {
  const rows = (await tx.execute<RateCardSqlRow>(sql`
    select id,
           code,
           service_slug,
           label,
           unit,
           rate_band,
           unit_price,
           currency,
           min_quantity,
           notes,
           is_published,
           to_char(effective_from, 'YYYY-MM-DD') as effective_from,
           to_char(effective_to, 'YYYY-MM-DD') as effective_to
      from rate_card_items
     where code = ${code}
     order by rate_band, effective_from desc
  `)) as unknown as RateCardSqlRow[];

  return rows.map(toRateRow);
}

/** One published, in-force line, as an unauthenticated visitor may see it. */
export interface PublicRateCardRow {
  readonly code: string;
  readonly serviceSlug: string;
  readonly label: string;
  readonly unit: RateUnit;
  readonly rateBand: RateBand;
  /** Integer minor units — fils. Never a float. */
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly minQuantity: string | null;
  readonly notes: string | null;
  readonly effectiveFrom: string;
}

// A type alias, not an `interface`: `db.execute<T>` constrains `T` to
// `Record<string, unknown>`, and only an object type literal gets the implicit
// index signature that satisfies that constraint — an `interface` never does,
// even when structurally identical. `RateCardSqlRow` above is a type alias
// (`Parameters<typeof toRateRow>[0]`) for the same reason.
type PublicRateCardSqlRow = {
  code: string;
  service_slug: string;
  label: string;
  unit: string;
  rate_band: string;
  unit_price: string;
  currency: string;
  min_quantity: string | null;
  notes: string | null;
  effective_from: string;
};

/**
 * The published schedule of rates (`WEB-16`), for the public marketing site.
 *
 * Takes a bare `tenantId` rather than a `TenantScopedTx`, and goes through
 * `app_public_rate_card` — a `SECURITY DEFINER` function, not `withTenant()` —
 * on purpose. A public page's request never has a session, and there is no
 * reason to hand an unauthenticated request the tenant's full row-level-
 * security scope merely to read ten prices; see
 * `resolvePublicTenantId`/`listPublicRoles` for the same pattern. The
 * `is_published` filter and the "in force today, in Dubai" date check both live
 * inside the SQL function, so this can only ever return what is safe to
 * publish — never checked in this file, and never checked in the component
 * that renders it.
 */
export async function listPublicRateCard(tenantId: string): Promise<readonly PublicRateCardRow[]> {
  const rows = (await db.execute<PublicRateCardSqlRow>(
    sql`select * from app_public_rate_card(${tenantId}::uuid)`,
  )) as unknown as PublicRateCardSqlRow[];

  return rows.map((r) => ({
    code: r.code,
    serviceSlug: r.service_slug,
    label: r.label,
    unit: r.unit as RateUnit,
    rateBand: r.rate_band as RateBand,
    unitPriceMinor: toMinor(r.unit_price),
    currency: r.currency,
    minQuantity: r.min_quantity,
    notes: r.notes,
    effectiveFrom: r.effective_from,
  }));
}

/**
 * Price one thing on one day, in minor units.
 *
 * What the quote builder will call. Returns null rather than zero when nothing
 * was priced then — a missing rate and a free line are different facts, and
 * collapsing them puts a zero on a quotation nobody meant to give away.
 */
export async function rateOn(
  tx: TenantScopedTx,
  code: string,
  rateBand: RateBand,
  onDate?: string,
): Promise<RateCardRow | null> {
  const rows = (await tx.execute<RateCardSqlRow>(sql`
    with as_of as (select coalesce(${onDate ?? null}::date, current_date) as d)
    select r.id,
           r.code,
           r.service_slug,
           r.label,
           r.unit,
           r.rate_band,
           r.unit_price,
           r.currency,
           r.min_quantity,
           r.notes,
           r.is_published,
           to_char(r.effective_from, 'YYYY-MM-DD') as effective_from,
           to_char(r.effective_to, 'YYYY-MM-DD') as effective_to
      from rate_card_items r, as_of
     where r.code = ${code}
       and r.rate_band = ${rateBand}
       and r.effective_from <= as_of.d
       and (r.effective_to is null or r.effective_to > as_of.d)
     limit 1
  `)) as unknown as RateCardSqlRow[];

  const row = rows[0];
  return row ? toRateRow(row) : null;
}

/**
 * Add a price, closing the one it replaces.
 *
 * ── WHY THE CLOSE AND THE INSERT ARE ONE CALL ───────────────────────────────
 *
 * Because the alternative is a screen that lets somebody insert the new price
 * and forget to end the old one, and the gist exclusion constraint would then
 * refuse the insert with a message about `daterange` that means nothing to a
 * person putting up their hourly rate. Doing both here means the constraint is
 * a safety net rather than the user interface.
 *
 * A backdated version is refused rather than fitted in. Slotting a price in
 * behind one that has already been quoted from would silently change what past
 * quotations claim to be based on, and there is no correct answer to "which
 * one did we actually use" once two of them cover the same day.
 */
export async function addRateVersion(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    code: string;
    serviceSlug: string;
    label: string;
    unit: RateUnit;
    rateBand: RateBand;
    unitPriceMinor: number;
    minQuantity?: string | null;
    notes?: string | null;
    isPublished: boolean;
    effectiveFrom: string;
  },
): Promise<void> {
  const current = (await tx.execute<{ id: string; effective_from: string }>(sql`
    select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from
      from rate_card_items
     where code = ${input.code}
       and rate_band = ${input.rateBand}
       and effective_to is null
     limit 1
  `)) as unknown as { id: string; effective_from: string }[];

  const open = current[0];
  if (open) {
    if (open.effective_from >= input.effectiveFrom) {
      throw new UserFacingError(
        `The current ${RATE_BAND_LABEL[input.rateBand].toLowerCase()} price for ${input.code} ` +
          `already runs from ${open.effective_from}. A new price has to start after that — ` +
          `correct the existing one instead if the date was wrong.`,
      );
    }
    await tx.execute(sql`
      update rate_card_items
         set effective_to = ${input.effectiveFrom}::date
       where id = ${open.id}::uuid
    `);
  }

  await tx.execute(sql`
    insert into rate_card_items
      (tenant_id, code, service_slug, label, unit, rate_band, unit_price,
       min_quantity, notes, is_published, effective_from)
    values (
      ${ctx.tenantId}::uuid,
      ${input.code},
      ${input.serviceSlug},
      ${input.label},
      ${input.unit},
      ${input.rateBand},
      ${toDecimalString(input.unitPriceMinor)}::numeric,
      ${input.minQuantity ?? null},
      ${input.notes ?? null},
      ${input.isPublished},
      ${input.effectiveFrom}::date
    )
  `);
}

/**
 * Stop charging for something from a given date.
 *
 * An end date, not a delete: the quotations issued while it was live still cite
 * it, and a rate card with a hole where a line used to be cannot explain them.
 */
export async function endRate(
  tx: TenantScopedTx,
  code: string,
  rateBand: RateBand,
  endsOn: string,
): Promise<void> {
  await tx.execute(sql`
    update rate_card_items
       set effective_to = ${endsOn}::date
     where code = ${code}
       and rate_band = ${rateBand}
       and effective_to is null
       and effective_from < ${endsOn}::date
  `);
}

/**
 * A starting rate card, priced against the ten licensed services (`ADM-12`).
 *
 * `rate_card_items` is otherwise empty on a fresh install, and a tender pack
 * (`packages/db/sql/customer-scope.sql`) and the published schedule of rates
 * (`WEB-16`) both refuse to build with nothing priced. `installStandardRateCardItems`
 * exists so a new tenant can get past that in one click, the same way
 * `installStandardJobOutcomes` and `installStandardDispositionReasons` do.
 *
 * Built *from* `services` rather than as a hand-typed list, on purpose: the
 * comment at the top of `catalog.ts` says the DET licence permits exactly ten
 * activities and that quoting outside it is a licensing exposure. Deriving the
 * rate card from the same array means a service that is ever removed from the
 * licence disappears from here too, automatically, rather than leaving a priced
 * line for work the company is no longer licensed to do.
 *
 * ── WHAT EACH LINE IS ───────────────────────────────────────────────────────
 *
 *  - Labour, per hour: the trade's hourly rate. Every service gets one.
 *  - Call-out, per visit: covers the visit and the diagnosis; labour and
 *    materials are additional lines. Every service gets one.
 *  - Materials — handling and markup, per visit: `rate_card_items.unit_price`
 *    is money, not a percentage, and the schema has no unit for "per cent" —
 *    so rather than store a number that would misread as fifteen dirhams on
 *    the rate card page, this is priced as a flat AED amount added when
 *    materials are bought in for the job. A judgement call: a business that
 *    prices materials as a straight percentage of cost will want to change
 *    the number, and once a quoting engine exists this may want its own field
 *    rather than living on the rate card at all.
 *
 * Only the three services the catalogue marks `emergency: true` — plumbing,
 * electrical repair, HVAC — get the three out-of-hours bands (`after_hours`,
 * `weekend`, `emergency`) on top of `standard`, at 1.5x for after-hours and
 * weekend work and 2x for a true emergency dispatch. The other seven are
 * project or scheduled work (fit-out, finishes, cleaning) and are priced
 * `standard` only; nothing stops an operator adding an after-hours line for
 * one of them by hand if their business actually needs it.
 *
 * Labour and call-out lines are marked for publication — every band, not only
 * `standard`. `WEB-16`'s schedule of rates is the place a customer finds out
 * what a 2am call costs before they make it, and an uplift a customer only
 * meets on the invoice is what generates the argument the schedule exists to
 * prevent. The materials line is the one exception and is not published,
 * matching this screen's own guidance that "work bought in at cost normally
 * stays off" the public schedule.
 *
 * Note that the four bands of a trade share one `code` and differ by
 * `rate_band`; that is deliberate and is the shape `rateOn(code, band, date)`
 * reads. It is not four competing definitions of the same rate.
 */
interface StandardRateLine {
  readonly code: string;
  readonly serviceSlug: string;
  readonly label: string;
  readonly unit: RateUnit;
  readonly rateBand: RateBand;
  /** A decimal AED string, e.g. `"120.00"` — never a float. */
  readonly unitPriceAed: string;
  readonly minQuantity: string | null;
  readonly notes: string | null;
  readonly isPublished: boolean;
}

const STANDARD_LABOUR_RATE_AED: Readonly<Record<string, string>> = {
  "plumbing-sanitary": "120.00",
  "electrical-fittings-repair": "130.00",
  "hvac-installation-maintenance": "150.00",
  "electromechanical-installation": "160.00",
  "false-ceilings": "90.00",
  tiling: "90.00",
  carpentry: "100.00",
  painting: "80.00",
  wallpaper: "85.00",
  "building-cleaning": "45.00",
};

const STANDARD_CALLOUT_FEE_AED: Readonly<Record<string, string>> = {
  "plumbing-sanitary": "150.00",
  "electrical-fittings-repair": "150.00",
  "hvac-installation-maintenance": "180.00",
  "electromechanical-installation": "200.00",
  "false-ceilings": "150.00",
  tiling: "150.00",
  carpentry: "150.00",
  painting: "120.00",
  wallpaper: "120.00",
  "building-cleaning": "100.00",
};

const STANDARD_MATERIALS_HANDLING_AED: Readonly<Record<string, string>> = {
  "plumbing-sanitary": "30.00",
  "electrical-fittings-repair": "30.00",
  "hvac-installation-maintenance": "40.00",
  "electromechanical-installation": "50.00",
  "false-ceilings": "50.00",
  tiling: "50.00",
  carpentry: "40.00",
  painting: "30.00",
  wallpaper: "30.00",
  "building-cleaning": "15.00",
};

/** Out-of-hours uplift over the standard rate. `standard` itself is 1x. */
const BAND_MULTIPLIER: Readonly<Partial<Record<RateBand, number>>> = {
  after_hours: 1.5,
  weekend: 1.5,
  emergency: 2,
};

function bandPriceAed(standardAed: string, band: RateBand): string {
  const multiplier = BAND_MULTIPLIER[band];
  if (!multiplier) return standardAed;
  // Two decimal places, computed once here rather than carried as a float
  // anywhere else — this is the only place an AED amount is ever multiplied.
  return (Number(standardAed) * multiplier).toFixed(2);
}

export const STANDARD_RATE_CARD_ITEMS: readonly StandardRateLine[] = (() => {
  const lines: StandardRateLine[] = [];

  for (const service of services) {
    const labourAed = STANDARD_LABOUR_RATE_AED[service.slug];
    const calloutAed = STANDARD_CALLOUT_FEE_AED[service.slug];
    const materialsAed = STANDARD_MATERIALS_HANDLING_AED[service.slug];
    // Guards catalogue drift: a service added to `catalog.ts` without a price
    // here is skipped rather than installed at AED 0, which would be a real
    // (wrong) price rather than a missing one.
    if (!labourAed || !calloutAed || !materialsAed) continue;

    const bands: readonly RateBand[] = service.emergency
      ? ["standard", "after_hours", "weekend", "emergency"]
      : ["standard"];

    for (const band of bands) {
      const bandSuffix = band === "standard" ? "" : ` — ${RATE_BAND_LABEL[band]}`;

      lines.push({
        code: `${service.slug}-labour`,
        serviceSlug: service.slug,
        label: `${service.shortName} labour${bandSuffix}`,
        unit: "hour",
        rateBand: band,
        unitPriceAed: bandPriceAed(labourAed, band),
        minQuantity: "1",
        notes:
          band === "standard"
            ? null
            : `${RATE_BAND_LABEL[band]} uplift over the standard hourly rate.`,
        isPublished: true,
      });

      lines.push({
        code: `${service.slug}-callout`,
        serviceSlug: service.slug,
        label: `${service.shortName} call-out${bandSuffix}`,
        unit: "visit",
        rateBand: band,
        unitPriceAed: bandPriceAed(calloutAed, band),
        minQuantity: null,
        notes:
          band === "standard"
            ? "Covers the visit and the diagnosis. Labour and materials are additional."
            : `${RATE_BAND_LABEL[band]} uplift over the standard call-out fee.`,
        isPublished: true,
      });
    }

    lines.push({
      code: `${service.slug}-materials`,
      serviceSlug: service.slug,
      label: `${service.shortName} materials — handling and markup`,
      unit: "visit",
      rateBand: "standard",
      unitPriceAed: materialsAed,
      minQuantity: null,
      notes:
        "A flat amount added when materials are bought in for the job, on top of " +
        "their cost. Not published on the public schedule of rates.",
      isPublished: false,
    });
  }

  return lines;
})();

/**
 * Put the standard rate card in place, leaving any price an operator has
 * already entered alone.
 *
 * Unlike the other `install*` helpers, `rate_card_items` has no unique index
 * to hang an `on conflict do nothing` off — a code and a band can legitimately
 * repeat across time, that is the whole point of the table. So "already here"
 * is checked explicitly: a currently-open row (`effective_to is null`) for the
 * same code and band means a price already exists, and it is left exactly as
 * it is, priced or not. Running this twice adds nothing the second time.
 */
export async function installStandardRateCardItems(
  tx: TenantScopedTx,
  ctx: TenantContext,
  effectiveFrom: string,
): Promise<number> {
  let added = 0;
  for (const line of STANDARD_RATE_CARD_ITEMS) {
    const existing = (await tx.execute<{ id: string }>(sql`
      select id
        from rate_card_items
       where tenant_id = ${ctx.tenantId}::uuid
         and code = ${line.code}
         and rate_band = ${line.rateBand}
         and effective_to is null
       limit 1
    `)) as unknown as { id: string }[];
    if (existing.length > 0) continue;

    await tx.execute(sql`
      insert into rate_card_items
        (tenant_id, code, service_slug, label, unit, rate_band, unit_price,
         min_quantity, notes, is_published, effective_from)
      values (
        ${ctx.tenantId}::uuid,
        ${line.code},
        ${line.serviceSlug},
        ${line.label},
        ${line.unit},
        ${line.rateBand},
        ${line.unitPriceAed}::numeric,
        ${line.minQuantity},
        ${line.notes},
        ${line.isPublished},
        ${effectiveFrom}::date
      )
    `);
    added += 1;
  }
  return added;
}
