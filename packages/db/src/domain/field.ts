import { and, eq, sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import * as schema from "../schema";
import {
  OPEN_STATUSES,
  STATUS_LABEL,
  canTransition,
  UserFacingError,
  certState,
  type JobStatus,
  type MaterialSource,
} from "@meridian/core";
import { transitionJob } from "./jobs";
import { recordJobOutcome } from "./outcomes";
import {
  recordJobAttachment,
  recordJobMaterial,
  declareNoMaterials,
  recordPhotoExemption,
  recordVisitLabour,
  recordJobSignature,
  listPhotoExemptionReasons,
  getJobCard,
  type JobAttachmentKind,
} from "./jobcard";
import { listFaultCodes, listJobOutcomeCodes, listRateCard } from "./reference";
import { writeAuditNote } from "./staff";
import { encodeCursor, decodeCursor } from "./leads";
import { rowDate, requiredRowDate } from "./_rows";

/**
 * The field application's server half: the working set, the sync protocol and
 * the conflict rules (`M11`, TRD §8.2–§8.5, ADR 0004).
 *
 * ── THE ONE RULE THIS FILE EXISTS TO NOT BREAK ──────────────────────────────
 *
 * `JOB-15`'s completion rules are enforced in the domain layer *precisely* so
 * that the field app cannot bypass them. Every mutation this file applies is
 * applied by calling the same function the web action calls — `transitionJob`,
 * `recordJobOutcome`, `recordJobAttachment`, `recordVisitLabour` and the rest.
 * Not one of them is reimplemented here, and none of the tables they own is
 * written directly.
 *
 * That is not a style preference. An endpoint that writes a completed job
 * straight into `jobs` skips `assertJobCardComplete`, and the gate that the
 * whole of `0025` exists to install would then hold for the office and not for
 * the sixty people who actually finish the work. It is the single most likely
 * way this API goes wrong, so it is stated here, at the top, in the file that
 * would have to be edited to do it.
 *
 * ── WHAT SYNC IS, IN ONE PARAGRAPH ──────────────────────────────────────────
 *
 * The server is authoritative. The device holds a bounded, declared subset
 * (§8.2), pulls deltas against a watermark, and pushes mutations that carry an
 * id it generated itself. That client id is the idempotency key, and
 * `field_mutations` is the ledger that makes a replay return the same answer
 * rather than a second compressor. Conflicts are resolved by data class (§8.4),
 * and the one class no rule can decide is queued for a human.
 */

// ── The bounded working set (§8.2) ───────────────────────────────────────────

/**
 * What the device syncs, declared rather than discovered.
 *
 * §8.2 is a list, and the list is the specification: "the device syncs a
 * **declared, bounded** set — never everything". A sync built by adding an
 * entity whenever a screen needs one arrives at "everything" without anybody
 * deciding to, and the cost lands on a technician's storage and on a first
 * sync over hotel wifi.
 *
 * So the manifest is data, `pullWorkingSet` reads it, and adding an entity is
 * an edit to this array — visible in a diff, next to the reason.
 */
export const FIELD_WORKING_SET = [
  { key: "jobs", detail: "this technician's jobs for today and tomorrow, plus any open job assigned to them" },
  { key: "customers", detail: "the customers those jobs belong to" },
  { key: "properties", detail: "the properties and units those jobs are at" },
  { key: "assets", detail: "the plant installed at those properties" },
  { key: "rate_card", detail: "the priced schedule of rates, in force today" },
  { key: "fault_codes", detail: "the symptom, cause and remedy taxonomy" },
  { key: "job_outcome_codes", detail: "the disposition reasons a visit can end with" },
  { key: "photo_exemption_reasons", detail: "why an 'after' photograph may be absent" },
  { key: "certifications", detail: "this technician's own certifications and their expiry state" },
] as const;

export type FieldWorkingSetKey = (typeof FIELD_WORKING_SET)[number]["key"];

/**
 * What is **not** on the device, and the sentence the screen shows instead.
 *
 * §8.2's second paragraph is the half that gets dropped: "Everything else is
 * fetched on demand when online and is explicitly unavailable offline. The
 * screen says so, rather than showing an empty state that looks like 'no
 * data'."
 *
 * An empty list with no explanation is the worst possible answer, because it is
 * indistinguishable from a true one. A technician who opens the invoice for a
 * job and sees nothing concludes there is no invoice, tells the customer so,
 * and is wrong. So the refusal is written down here, as a sentence, and the app
 * renders it in place of the list.
 *
 * These strings are the product's voice on a screen a technician reads standing
 * in a plant room, which is why they say what to do next rather than naming a
 * subsystem.
 */
export const FIELD_UNAVAILABLE_OFFLINE = [
  {
    key: "invoices",
    message: "Invoices and payments are not carried on the phone. Reconnect to look one up.",
  },
  {
    key: "quotes",
    message: "Quotations are not carried on the phone. Reconnect to look one up.",
  },
  {
    key: "customer_history",
    message: "Past jobs at this property are not carried on the phone. Reconnect to read the history.",
  },
  {
    key: "other_technicians",
    message: "Other technicians' work is not carried on the phone. Reconnect to see the board.",
  },
  {
    key: "contracts",
    message: "Contract cover and entitlements are not carried on the phone. Reconnect to check them.",
  },
] as const;

/**
 * Named by §8.2, and not built, because the tables do not exist.
 *
 * ── WHY THIS IS A CONSTANT AND NOT A SILENCE ────────────────────────────────
 *
 * §8.2 asks for "the parts catalogue (whole, but small)" and "PPE and RAMS
 * templates". There is no parts catalogue table in this schema and no PPE or
 * RAMS table either — `rate_card_items` is a schedule of *rates*, which is what
 * the manifest above ships, and it is not a parts list.
 *
 * Inventing two tables inside the sync layer would have put the master data for
 * somebody else's domain behind an endpoint that is only ever read by a phone,
 * which is how a second, worse copy of a catalogue gets created. Leaving them
 * out silently would have made the manifest a document that lies about itself.
 * So they are declared as missing: the pull reports them, the app can say why
 * the parts picker is not there, and whoever builds the catalogue has a
 * one-line list of what the field app is waiting for.
 */
export const FIELD_WORKING_SET_NOT_YET_AVAILABLE = [
  {
    key: "parts_catalogue",
    message: "The parts catalogue is not on this phone yet. Type the part description instead.",
    blockedOn: "No parts/SKU catalogue table exists. `rate_card_items` prices work, not parts.",
  },
  {
    key: "ppe_rams",
    message: "Method statements and PPE lists are not on this phone yet.",
    blockedOn: "No PPE or RAMS template table exists in the schema.",
  },
] as const;

// ── The sync cursor ──────────────────────────────────────────────────────────

/**
 * The nil UUID, used as "no tiebreak".
 *
 * The cursor codec is `leads.ts`'s, reused rather than rewritten — a second
 * base64 encoder for the same opaque string is two things that drift apart, and
 * `jobs.ts` already records that judgement. Its `Cursor` requires an id, and a
 * sync watermark usually has no row to tie-break against. The nil UUID sorts
 * before every generated one, so `(at, nil) < (at, any real row)` is exactly
 * what "everything at or after this instant" means.
 */
const NO_TIEBREAK = "00000000-0000-0000-0000-000000000000";

/**
 * How far behind `now()` a watermark is left when a pull returns everything it
 * found.
 *
 * ── THE BUG THIS PREVENTS, WHICH IS SILENT ──────────────────────────────────
 *
 * `updated_at` is stamped when a statement runs; the row becomes visible when
 * its transaction commits. A transaction that starts at 12:00:00, stamps
 * `updated_at = 12:00:00` and commits at 12:00:03 is invisible to a pull that
 * ran at 12:00:01 and set its watermark to 12:00:01. The row is never sent
 * again, because its `updated_at` is now behind the watermark forever.
 *
 * The failure is a job that simply never appears on a phone, with nothing in
 * any log. Holding the watermark a few seconds behind the clock means such a
 * row is re-sent on the next pull instead of lost. Re-sending is free — the
 * device upserts by primary key — and the cost is that a change is at most this
 * far from arriving. Nothing is delayed by it: rows *newer* than the watermark
 * are still returned immediately, they are merely returned again next time.
 */
const WATERMARK_LAG_MS = 5_000;

/** The largest number of jobs one pull will return. */
const MAX_JOBS_PER_PULL = 200;

interface SyncCursor {
  readonly at: Date;
  readonly id: string;
}

function parseCursor(raw: string | null | undefined): SyncCursor {
  const decoded = decodeCursor(raw);
  if (!decoded) return { at: new Date(0), id: NO_TIEBREAK };
  return { at: decoded.createdAt, id: decoded.id };
}

function formatCursor(cursor: SyncCursor): string {
  return encodeCursor({ createdAt: cursor.at, id: cursor.id });
}

// ── Devices ──────────────────────────────────────────────────────────────────

export interface FieldDeviceRow {
  readonly id: string;
  readonly label: string;
  readonly platform: string;
  readonly appVersion: string | null;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly registeredAt: Date;
  readonly lastSeenAt: Date | null;
  readonly tokenExpiresAt: Date;
  readonly clockSkewMs: number | null;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
  /**
   * Who revoked it. Null both for a device that has never been revoked and
   * for one revoked by a user who has since been deleted — `revoked_by_id`
   * is `ON DELETE SET NULL`, so the reason and the timestamp outlive the
   * name. A revocation nobody can attribute afterwards is still evidence
   * that *something* happened; it just cannot say who did it.
   */
  readonly revokedByName: string | null;
}

const DEVICE_PLATFORMS = ["ios", "android"] as const;

/**
 * Register a handset (`SEC-7`).
 *
 * Runs inside an already-authenticated tenant transaction: the technician signs
 * in on the phone once, with their password and second factor, through the same
 * login the web uses, and the device credential is issued off the back of that
 * session. There is deliberately no path by which a phone acquires a token
 * without a human first proving who they are.
 *
 * The hash and expiry are computed by `packages/auth`, which owns every decision
 * about the secret, and arrive here as values. This function owns the row.
 *
 * Re-registering the same handset is a new row, not an update. Two rows means
 * the old credential is still revocable independently — which is what you want
 * when the reason for re-registering is "I have lost the first phone".
 */
export async function registerFieldDevice(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    technicianId: string;
    userId: string;
    label: string;
    platform: string;
    appVersion?: string | null;
    osVersion?: string | null;
    tokenHash: string;
    tokenExpiresAt: Date;
  },
): Promise<{ id: string }> {
  const label = input.label.trim();
  if (!label) throw new UserFacingError("A device needs a name, so it can be told from the others.");
  if (!DEVICE_PLATFORMS.includes(input.platform as (typeof DEVICE_PLATFORMS)[number])) {
    throw new UserFacingError(`"${input.platform}" is not a platform this app is built for.`);
  }

  // The technician has to exist in this tenant and be active. RLS makes
  // "missing" and "another tenant's" the same answer, which is intended.
  const techRows = await tx
    .select({ id: schema.technicians.id, isActive: schema.technicians.isActive })
    .from(schema.technicians)
    .where(eq(schema.technicians.id, input.technicianId))
    .limit(1);

  const technician = techRows[0];
  if (!technician) throw new UserFacingError("That technician record does not exist here.");
  if (!technician.isActive) {
    throw new UserFacingError("That technician is not active, so a device cannot be registered to them.");
  }

  const inserted = await tx
    .insert(schema.fieldDevices)
    .values({
      tenantId: ctx.tenantId,
      technicianId: input.technicianId,
      userId: input.userId,
      label,
      platform: input.platform,
      appVersion: input.appVersion ?? null,
      osVersion: input.osVersion ?? null,
      tokenHash: input.tokenHash,
      tokenExpiresAt: input.tokenExpiresAt,
    })
    .returning({ id: schema.fieldDevices.id });

  const row = inserted[0];
  if (!row) throw new Error("The device row was not written");

  await writeAuditNote(tx, ctx, {
    tableName: "field_devices",
    recordId: row.id,
    // 10 characters. `audit_log.action` is varchar(16), and a longer literal is
    // a runtime failure on every call rather than on an edge case.
    action: "device_reg",
    detail: { technicianId: input.technicianId, label, platform: input.platform },
  });

  return { id: row.id };
}

/**
 * Replace a device's token, keeping the old one alive for a grace window.
 *
 * The window is why this is an UPDATE of two columns rather than one. See
 * `packages/auth/src/device.ts` for the argument: strict rotation strands a
 * handset whenever the rotation response is the packet that goes missing, and
 * the replaced hash is kept afterwards so that presenting it late is
 * identifiable as theft rather than as an unknown token.
 */
export async function rotateFieldDeviceToken(
  tx: TenantScopedTx,
  input: { deviceId: string; tokenHash: string; tokenExpiresAt: Date; graceUntil: Date },
): Promise<void> {
  await tx.execute(sql`
    update field_devices
       set previous_token_hash = token_hash,
           previous_token_grace_until = ${input.graceUntil.toISOString()}::timestamptz,
           token_hash = ${input.tokenHash},
           token_issued_at = now(),
           token_expires_at = ${input.tokenExpiresAt.toISOString()}::timestamptz,
           token_generation = token_generation + 1,
           updated_at = now()
     where id = ${input.deviceId}::uuid
       and revoked_at is null
  `);
}

/**
 * Revoke one handset (`SEC-7`).
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
 *
 * It does not touch the user, the membership, the technician record, the
 * password or any browser session. A lost phone is not a dismissal: the person
 * is still employed, still on tomorrow's rota, and will be handed another
 * handset this afternoon. An administrator who has to disable somebody in order
 * to kill their device will, sooner or later, decline to do it at four o'clock
 * on a Thursday — and the phone stays live.
 *
 * The other direction needs no code at all and is worth knowing about:
 * deactivating the membership, the technician or the tenant kills every device
 * belonging to them, because `app_auth_resolve_device` joins all three and
 * requires them live. Revoking a person does not require anybody to remember
 * their handsets.
 */
export async function revokeFieldDevice(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { deviceId: string; reason: string },
): Promise<{ revoked: boolean }> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new UserFacingError("Say why the device is being revoked — lost, replaced, or returned.");
  }

  const updated = await tx
    .update(schema.fieldDevices)
    .set({
      revokedAt: new Date(),
      revokedById: ctx.userId ?? null,
      revokedReason: reason.slice(0, 160),
      updatedAt: new Date(),
    })
    .where(and(eq(schema.fieldDevices.id, input.deviceId), sql`revoked_at is null`))
    .returning({ id: schema.fieldDevices.id });

  const row = updated[0];
  if (!row) return { revoked: false };

  await writeAuditNote(tx, ctx, {
    tableName: "field_devices",
    recordId: row.id,
    // 10 characters.
    action: "device_rev",
    detail: { reason },
  });

  return { revoked: true };
}

/**
 * Record that a device was heard from, and how far its clock is out.
 *
 * ── WHY THE SKEW IS STORED RATHER THAN CORRECTED AND FORGOTTEN ──────────────
 *
 * ADR 0004: "device clocks are wrong". The correction applied to captured
 * timestamps is only defensible if the number it was made with survives, so a
 * support call about a job sheet whose times look impossible can be answered
 * with "that handset was running eleven minutes fast" rather than with a guess.
 */
export async function touchFieldDevice(
  tx: TenantScopedTx,
  input: { deviceId: string; clockSkewMs?: number | null; appVersion?: string | null; pulled?: boolean },
): Promise<void> {
  const skew =
    input.clockSkewMs === null || input.clockSkewMs === undefined || !Number.isFinite(input.clockSkewMs)
      ? null
      : Math.trunc(input.clockSkewMs);

  await tx.execute(sql`
    update field_devices
       set last_seen_at = now(),
           last_pull_at = case when ${input.pulled ?? false} then now() else last_pull_at end,
           clock_skew_ms = coalesce(${skew}::int, clock_skew_ms),
           app_version = coalesce(${input.appVersion ?? null}, app_version),
           updated_at = now()
     where id = ${input.deviceId}::uuid
  `);
}

/** Every handset in the tenant, for the revocation screen. Revoked ones last. */
export async function listFieldDevices(
  tx: TenantScopedTx,
  options?: { technicianId?: string; includeRevoked?: boolean },
): Promise<readonly FieldDeviceRow[]> {
  const technicianId = options?.technicianId ?? null;
  const includeRevoked = options?.includeRevoked ?? true;

  interface Row extends Record<string, unknown> {
    id: string;
    label: string;
    platform: string;
    app_version: string | null;
    technician_id: string;
    technician_name: string;
    // Timestamps from `execute` are strings. See _rows.ts.
    registered_at: string;
    last_seen_at: string | null;
    token_expires_at: string;
    clock_skew_ms: number | null;
    revoked_at: string | null;
    revoked_reason: string | null;
    revoked_by_name: string | null;
  }

  const rows = (await tx.execute<Row>(sql`
    select d.id,
           d.label,
           d.platform,
           d.app_version,
           d.technician_id,
           t.full_name as technician_name,
           d.registered_at,
           d.last_seen_at,
           d.token_expires_at,
           d.clock_skew_ms,
           d.revoked_at,
           d.revoked_reason,
           u.full_name as revoked_by_name
      from field_devices d
      join technicians t on t.id = d.technician_id
      left join users u on u.id = d.revoked_by_id
     where d.deleted_at is null
       and (${technicianId}::uuid is null or d.technician_id = ${technicianId}::uuid)
       and (${includeRevoked} = true or d.revoked_at is null)
     order by (d.revoked_at is not null), d.last_seen_at desc nulls last, d.registered_at desc
  `)) as unknown as Row[];

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    platform: r.platform,
    appVersion: r.app_version,
    technicianId: r.technician_id,
    technicianName: r.technician_name,
    registeredAt: requiredRowDate(r.registered_at),
    lastSeenAt: rowDate(r.last_seen_at),
    tokenExpiresAt: requiredRowDate(r.token_expires_at),
    clockSkewMs: r.clock_skew_ms === null ? null : Number(r.clock_skew_ms),
    revokedAt: rowDate(r.revoked_at),
    revokedReason: r.revoked_reason,
    revokedByName: r.revoked_by_name,
  }));
}

// ── Pull (§8.3) ──────────────────────────────────────────────────────────────

export interface FieldJob {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: JobStatus;
  readonly statusLabel: string;
  readonly priority: string;
  readonly serviceSlug: string;
  readonly isOutdoor: boolean;
  readonly customerId: string;
  readonly propertyId: string;
  readonly unitId: string | null;
  readonly assetId: string | null;
  readonly scheduledFor: Date | null;
  readonly respondByAt: Date | null;
  readonly resolveByAt: Date | null;
  readonly outcomeCode: string | null;
  readonly visitId: string | null;
  readonly visitStatus: string | null;
  readonly visitScheduledStart: Date | null;
  readonly visitScheduledEnd: Date | null;
  /**
   * What this job's card is still missing (`JOB-15`), server-computed.
   *
   * ── WHY THE DEVICE IS TOLD RATHER THAN LEFT TO WORK IT OUT ─────────────────
   *
   * The gate is `assertJobCardComplete`, and the whole design point of putting
   * it in the domain layer is that one rule decides. A phone that reimplements
   * "do I have an after photograph, materials and labour" will drift from that
   * rule the first time the rule changes — and the failure is the worst shape
   * available: the technician's screen says the job is ready, they press
   * complete standing in a plant room with no signal, and the refusal arrives
   * hours later when the queue drains.
   *
   * Sending the server's own `gaps` list makes "the client thinks it is ready
   * and the server disagrees" unrepresentable. It is the same list
   * `getJobCard` gives the web job-card panel.
   *
   * Null, not `[]`, when the job is not in a state where completion is on the
   * table. An empty array means "nothing is missing, this job can be
   * completed", and saying that about a job that is still `dispatched` would
   * put a live complete button on a job nobody has arrived at.
   */
  readonly gaps: readonly string[] | null;
  readonly updatedAt: Date;
}

export interface FieldCustomer {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly updatedAt: Date;
}

export interface FieldProperty {
  readonly id: string;
  readonly customerId: string;
  readonly name: string;
  readonly addressLine: string;
  readonly area: string | null;
  readonly city: string;
  readonly lat: number | null;
  readonly lng: number | null;
  /** Gate codes, parking, escort requirements. The reason this syncs at all. */
  readonly accessInstructions: string | null;
  readonly updatedAt: Date;
}

export interface FieldAsset {
  readonly id: string;
  readonly propertyId: string;
  readonly tag: string;
  readonly name: string;
  readonly location: string | null;
  readonly manufacturer: string | null;
  readonly model: string | null;
  readonly serialNumber: string | null;
  readonly serviceSlug: string | null;
  readonly condition: string;
  readonly updatedAt: Date;
}

export interface FieldCertification {
  readonly id: string;
  readonly name: string;
  readonly issuer: string | null;
  /** Day-valued, kept as YYYY-MM-DD end to end. */
  readonly expiresOn: string | null;
  readonly state: string;
}

export interface FieldSyncPage {
  /**
   * The server's clock, so the device can detect and report its own divergence
   * rather than silently recording a wrong timestamp (§8.5).
   */
  readonly serverTime: Date;
  readonly nextCursor: string;
  /** True when this pull hit its page cap and the device should pull again now. */
  readonly truncated: boolean;
  /** True when the device sent no cursor: this is a first, complete sync. */
  readonly complete: boolean;
  readonly jobs: readonly FieldJob[];
  readonly customers: readonly FieldCustomer[];
  readonly properties: readonly FieldProperty[];
  readonly assets: readonly FieldAsset[];
  readonly certifications: readonly FieldCertification[];
  /**
   * Reference data, sent whole or not at all. Null means "unchanged since your
   * cursor, keep what you have" — which is different from an empty list, and
   * conflating the two would blank a technician's fault-code picker.
   */
  readonly taxonomies: {
    readonly faultCodes: readonly unknown[];
    readonly outcomeCodes: readonly unknown[];
    readonly photoExemptionReasons: readonly unknown[];
    readonly rateCard: readonly unknown[];
  } | null;
  /**
   * The authoritative membership of the working set: every job id in scope,
   * changed or not.
   *
   * Without it a job reassigned to somebody else stays on the phone forever,
   * because it is no longer selected by any delta and there is nothing to say
   * so. A tombstone table would be the heavyweight answer; sending a few dozen
   * uuids on every pull is the bounded one, and it is only bounded because the
   * working set is (§8.2). The device deletes anything not named here.
   */
  readonly scope: { readonly jobIds: readonly string[] };
  readonly unavailableOffline: typeof FIELD_UNAVAILABLE_OFFLINE;
  readonly notYetAvailable: typeof FIELD_WORKING_SET_NOT_YET_AVAILABLE;
}

const OPEN_STATUS_LIST = sql.join(
  OPEN_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/**
 * The declared working set, incrementally (§8.2, §8.3).
 *
 * ── HOW THE SCOPE IS BOUNDED ────────────────────────────────────────────────
 *
 * A job is in scope when this technician has a visit on it AND either the visit
 * is scheduled today or tomorrow, or the job is still open. The second clause
 * is what §8.2 means by "any job in an open state assigned to them": a job
 * paused on a part that arrives Thursday must stay on the phone, and it has no
 * visit inside the horizon.
 *
 * The day boundary is a **Dubai** day boundary, computed in Postgres. A visit
 * at 00:30 Dubai is 20:30 the previous day in UTC, and bucketing it in
 * JavaScript drops it out of "today" for exactly the people who start early.
 * `jobs.ts` learned this on the schedule query; the same trap is here.
 *
 * ── WHY THE HORIZON IS AN ARGUMENT AND THE DEFAULT IS TWO DAYS ──────────────
 *
 * §8.2 says today and tomorrow. ADR 0004's sync design says seven. §8.2 is the
 * later document and this one wins, so the default is two days — but the
 * argument exists because the right answer for a PPM crew on a week-long
 * shutdown is genuinely different, and the alternative to a parameter is
 * somebody editing a constant in a hurry.
 */
export async function pullWorkingSet(
  tx: TenantScopedTx,
  input: {
    technicianId: string;
    cursor?: string | null;
    /** Days beyond today. 1 gives today and tomorrow. */
    horizonDays?: number;
    limit?: number;
  },
): Promise<FieldSyncPage> {
  const cursor = parseCursor(input.cursor);
  const complete = !input.cursor;
  const horizonDays = Math.max(0, Math.min(14, input.horizonDays ?? 1));
  const limit = Math.max(1, Math.min(MAX_JOBS_PER_PULL, input.limit ?? MAX_JOBS_PER_PULL));
  const cursorIso = cursor.at.toISOString();

  const serverTimeRows = (await tx.execute<{ now: string }>(
    sql`select now()::text as now`,
  )) as unknown as { now: string }[];
  const serverTime = requiredRowDate(serverTimeRows[0]?.now ?? null);

  // The scope subquery, written once and reused. Every entity below is derived
  // from it, so there is exactly one definition of "in the working set" and a
  // widening cannot happen to one entity and not another.
  const scopeSql = sql`
    select distinct j.id
      from jobs j
      join job_visits v on v.job_id = j.id
     where v.technician_id = ${input.technicianId}::uuid
       -- A visit a reassignment replaced (0040) is not this technician's work.
       -- Without this the job stays on the handset of the person it was taken
       -- off, for as long as it stays open -- and the sync is the only thing
       -- that ever tells them what they are on, so they would go to it.
       and v.status <> 'superseded'
       and j.deleted_at is null
       and (
         (
           v.scheduled_start is not null
           and (v.scheduled_start at time zone 'Asia/Dubai')::date
               between (now() at time zone 'Asia/Dubai')::date
                   and ((now() at time zone 'Asia/Dubai')::date + ${horizonDays}::int)
         )
         or j.status in (${OPEN_STATUS_LIST})
       )
  `;

  interface JobRow extends Record<string, unknown> {
    id: string;
    reference: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    service_slug: string;
    is_outdoor: boolean;
    customer_id: string;
    property_id: string;
    unit_id: string | null;
    asset_id: string | null;
    scheduled_for: string | null;
    respond_by_at: string | null;
    resolve_by_at: string | null;
    outcome_code: string | null;
    visit_id: string | null;
    visit_status: string | null;
    visit_scheduled_start: string | null;
    visit_scheduled_end: string | null;
    updated_at: string;
  }

  const jobRows = (await tx.execute<JobRow>(sql`
    with scope as (${scopeSql})
    select j.id,
           j.reference,
           j.title,
           j.description,
           j.status::text as status,
           j.priority::text as priority,
           j.service_slug,
           j.is_outdoor,
           j.customer_id,
           j.property_id,
           j.unit_id,
           j.asset_id,
           j.scheduled_for,
           j.respond_by_at,
           j.resolve_by_at,
           j.outcome_code,
           v.id as visit_id,
           v.status::text as visit_status,
           v.scheduled_start as visit_scheduled_start,
           v.scheduled_end as visit_scheduled_end,
           j.updated_at
      from jobs j
      join scope s on s.id = j.id
      -- The technician's own latest visit on the job. LATERAL rather than a
      -- join, because a multi-visit job (JOB-12) would otherwise produce one
      -- row per visit and the device would hold the job twice.
      left join lateral (
        select v2.id, v2.status, v2.scheduled_start, v2.scheduled_end
          from job_visits v2
         where v2.job_id = j.id
           and v2.technician_id = ${input.technicianId}::uuid
           -- Same exclusion as the scope above, and it has to be the same or
           -- the two disagree: a technician still holding a job through a
           -- second, live visit would otherwise be handed the retired one's id
           -- as visitId, and every mutation the device sent would name it.
           -- (No backticks in a comment inside a template literal -- one of
           -- them terminates the string and breaks the workspace elsewhere.)
           and v2.status <> 'superseded'
         order by v2.sequence desc
         limit 1
      ) v on true
     where (j.updated_at, j.id) > (${cursorIso}::timestamptz, ${cursor.id}::uuid)
     order by j.updated_at, j.id
     limit ${limit + 1}
  `)) as unknown as JobRow[];

  const truncated = jobRows.length > limit;
  const jobPage = truncated ? jobRows.slice(0, limit) : jobRows;

  // Only for jobs where completion is actually on the table. `getJobCard` is
  // several queries; running it for every job in the working set would multiply
  // the cost of a sync by the size of the set to answer a question that is
  // meaningless for a job nobody has arrived at yet. In practice a technician
  // has one job on site at a time.
  const COMPLETABLE: readonly JobStatus[] = ["on_site", "work_complete"];

  const jobs: FieldJob[] = jobPage.map((r) => ({
    id: r.id,
    reference: r.reference,
    title: r.title,
    description: r.description,
    status: r.status as JobStatus,
    statusLabel: STATUS_LABEL[r.status as JobStatus],
    priority: r.priority,
    serviceSlug: r.service_slug,
    isOutdoor: r.is_outdoor,
    customerId: r.customer_id,
    propertyId: r.property_id,
    unitId: r.unit_id,
    assetId: r.asset_id,
    scheduledFor: rowDate(r.scheduled_for),
    respondByAt: rowDate(r.respond_by_at),
    resolveByAt: rowDate(r.resolve_by_at),
    outcomeCode: r.outcome_code,
    visitId: r.visit_id,
    visitStatus: r.visit_status,
    visitScheduledStart: rowDate(r.visit_scheduled_start),
    visitScheduledEnd: rowDate(r.visit_scheduled_end),
    gaps: null,
    updatedAt: requiredRowDate(r.updated_at),
  }));

  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    if (!job || !COMPLETABLE.includes(job.status)) continue;
    jobs[i] = { ...job, gaps: (await getJobCard(tx, job.id)).gaps };
  }

  // The related entities are filtered on the plain watermark rather than the
  // keyset. They are bounded by the job scope — a handful of customers, a
  // handful of properties — so paging them would be machinery with nothing to
  // do, and re-sending one is a device-side upsert by primary key.
  interface CustomerRow extends Record<string, unknown> {
    id: string;
    name: string;
    phone: string | null;
    updated_at: string;
  }
  const customerRows = (await tx.execute<CustomerRow>(sql`
    with scope as (${scopeSql})
    select distinct c.id, c.name, c.phone, c.updated_at
      from customers c
     where c.id in (select j.customer_id from jobs j join scope s on s.id = j.id)
       and c.updated_at > ${cursorIso}::timestamptz
  `)) as unknown as CustomerRow[];

  interface PropertyRow extends Record<string, unknown> {
    id: string;
    customer_id: string;
    name: string;
    address_line: string;
    area: string | null;
    city: string;
    lat: number | null;
    lng: number | null;
    access_instructions: string | null;
    updated_at: string;
  }
  const propertyRows = (await tx.execute<PropertyRow>(sql`
    with scope as (${scopeSql})
    select distinct p.id, p.customer_id, p.name, p.address_line, p.area, p.city,
           p.lat, p.lng, p.access_instructions, p.updated_at
      from properties p
     where p.id in (select j.property_id from jobs j join scope s on s.id = j.id)
       and p.updated_at > ${cursorIso}::timestamptz
  `)) as unknown as PropertyRow[];

  interface AssetRow extends Record<string, unknown> {
    id: string;
    property_id: string;
    tag: string;
    name: string;
    location: string | null;
    manufacturer: string | null;
    model: string | null;
    serial_number: string | null;
    service_slug: string | null;
    condition: string;
    updated_at: string;
  }
  // Every asset at those properties, not only the one the job names: a
  // technician sent to a plant room for one chiller routinely finds the fault
  // is on the next one along, and cannot record it against plant the phone has
  // never heard of.
  const assetRows = (await tx.execute<AssetRow>(sql`
    with scope as (${scopeSql})
    select distinct a.id, a.property_id, a.tag, a.name, a.location, a.manufacturer,
           a.model, a.serial_number, a.service_slug, a.condition::text as condition, a.updated_at
      from assets a
     where a.property_id in (select j.property_id from jobs j join scope s on s.id = j.id)
       and a.deleted_at is null
       and a.updated_at > ${cursorIso}::timestamptz
  `)) as unknown as AssetRow[];

  interface CertRow extends Record<string, unknown> {
    id: string;
    name: string;
    issuer: string | null;
    expires_on: string | null;
  }
  const certRows = (await tx.execute<CertRow>(sql`
    select id, name, issuer, to_char(expires_on, 'YYYY-MM-DD') as expires_on
      from technician_certifications
     where technician_id = ${input.technicianId}::uuid
       and deleted_at is null
       and updated_at > ${cursorIso}::timestamptz
     order by expires_on nulls last
  `)) as unknown as CertRow[];

  // Reference data: whole, or not at all. Small enough that a delta would be
  // machinery for nothing, and the "not at all" case is why `taxonomies` is
  // nullable — an empty object here would blank the pickers on the phone.
  const changedRows = (await tx.execute<{ changed: boolean }>(sql`
    select (
      exists (select 1 from fault_codes where updated_at > ${cursorIso}::timestamptz)
      or exists (select 1 from job_outcome_codes where updated_at > ${cursorIso}::timestamptz)
      or exists (select 1 from job_photo_exemption_reasons where updated_at > ${cursorIso}::timestamptz)
      or exists (select 1 from rate_card_items where updated_at > ${cursorIso}::timestamptz)
    ) as changed
  `)) as unknown as { changed: boolean }[];

  // Read through the existing domain functions rather than re-querying these
  // tables. Their filtering rules — a fault code with no service applies to
  // every service, a rate is the version in force today — are the answer to
  // questions this file has no business re-deriving.
  const taxonomies = changedRows[0]?.changed
    ? {
        faultCodes: await listFaultCodes(tx, { activeOnly: true }),
        outcomeCodes: await listJobOutcomeCodes(tx, { activeOnly: true }),
        photoExemptionReasons: await listPhotoExemptionReasons(tx, { activeOnly: true }),
        rateCard: await listRateCard(tx),
      }
    : null;

  const scopeRows = (await tx.execute<{ id: string }>(sql`
    with scope as (${scopeSql})
    select id from scope
  `)) as unknown as { id: string }[];

  // Truncated: the watermark is the last row actually returned, so nothing
  // between it and `now()` is skipped. Complete: the watermark is held behind
  // the clock by the lag, so a transaction that stamps early and commits late
  // is re-sent rather than lost. The two cases are not interchangeable and
  // getting them the wrong way round loses rows in one and loops in the other.
  const lastJob = jobs[jobs.length - 1];
  const nextCursor =
    truncated && lastJob
      ? formatCursor({ at: lastJob.updatedAt, id: lastJob.id })
      : formatCursor({ at: new Date(serverTime.getTime() - WATERMARK_LAG_MS), id: NO_TIEBREAK });

  return {
    serverTime,
    nextCursor,
    truncated,
    complete,
    jobs,
    customers: customerRows.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      updatedAt: requiredRowDate(r.updated_at),
    })),
    properties: propertyRows.map((r) => ({
      id: r.id,
      customerId: r.customer_id,
      name: r.name,
      addressLine: r.address_line,
      area: r.area,
      city: r.city,
      lat: r.lat === null ? null : Number(r.lat),
      lng: r.lng === null ? null : Number(r.lng),
      accessInstructions: r.access_instructions,
      updatedAt: requiredRowDate(r.updated_at),
    })),
    assets: assetRows.map((r) => ({
      id: r.id,
      propertyId: r.property_id,
      tag: r.tag,
      name: r.name,
      location: r.location,
      manufacturer: r.manufacturer,
      model: r.model,
      serialNumber: r.serial_number,
      serviceSlug: r.service_slug,
      condition: r.condition,
      updatedAt: requiredRowDate(r.updated_at),
    })),
    certifications: certRows.map((r) => ({
      id: r.id,
      name: r.name,
      issuer: r.issuer,
      // Day-valued, and kept as YYYY-MM-DD end to end. Round-tripping it
      // through a Date would move an expiry across midnight for any reader in
      // a negative offset, and this is the value that decides whether somebody
      // may be dispatched.
      expiresOn: r.expires_on,
      state: certState(r.expires_on ? new Date(`${r.expires_on}T00:00:00Z`) : null, serverTime),
    })),
    taxonomies,
    scope: { jobIds: scopeRows.map((r) => r.id) },
    unavailableOffline: FIELD_UNAVAILABLE_OFFLINE,
    notYetAvailable: FIELD_WORKING_SET_NOT_YET_AVAILABLE,
  };
}

// ── Push (§8.3, §8.4) ────────────────────────────────────────────────────────

/**
 * Every mutation the field app may send, as `entity/op`.
 *
 * The list is closed, and that is the point: an unrecognised pair is rejected
 * rather than routed somewhere plausible. Each one names the domain function it
 * calls, and every one of those is the function the web action calls too — the
 * two exceptions are marked and explained where they are implemented.
 */
export const FIELD_MUTATION_KINDS = [
  "job_status/transition", // transitionJob
  "job_outcome/record", // recordJobOutcome  (enforces JOB-15)
  "job_attachment/append", // recordJobAttachment
  "job_material/append", // recordJobMaterial
  "job_material/declare_none", // declareNoMaterials
  "job_photo/exempt", // recordPhotoExemption
  "visit_labour/record", // recordVisitLabour
  "job_signature/record", // recordJobSignature
  "job_note/upsert", // this file — see recordFieldJobNote
  "attendance/append", // this file — see recordFieldAttendance
] as const;

export type FieldMutationKind = (typeof FIELD_MUTATION_KINDS)[number];

export interface FieldMutation {
  /** ULID generated on the device, before the server has seen the record. */
  readonly clientId: string;
  readonly entity: string;
  readonly op: string;
  readonly payload: Record<string, unknown>;
  /** What the device believed the server held. Optimistic concurrency. */
  readonly baseVersion?: string | null;
  /** Must be accepted before this one is applied. */
  readonly dependsOnClientId?: string | null;
  /** The device's own clock, as ISO. Never trusted for a report. */
  readonly recordedOfflineAt?: string | null;
}

export interface FieldConflictReport {
  readonly clientId: string;
  readonly reason: string;
  readonly serverState: Record<string, unknown>;
  /** The sentence the technician's phone shows. */
  readonly detail: string;
}

export interface FieldMutationResult {
  /** Applied, or already applied. Either way the device may forget it. */
  readonly accepted: readonly { clientId: string; result: Record<string, unknown> }[];
  /** A human has to decide. Queued on the dispatch board (§8.4). */
  readonly conflicts: readonly FieldConflictReport[];
  /** Will never succeed. The device marks these `dead` and shows them. */
  readonly rejected: readonly {
    clientId: string;
    message: string;
    /**
     * The server-computed `JOB-15` gaps, when the refusal was the completion
     * gate. Structured, because a sentence is something to show and a list is
     * something to act on — the phone routes the technician to the missing
     * section rather than making them re-read a paragraph in a plant room.
     *
     * Absent on every other kind of refusal, and absent is not empty: an empty
     * array would mean "nothing is missing", which is never true of a rejected
     * completion.
     */
    gaps?: readonly string[];
  }[];
  /** Their dependency has not arrived yet. The device retries. */
  readonly deferred: readonly { clientId: string; dependsOn: string }[];
  readonly serverTime: Date;
  /** Device clock minus server clock, as measured on this request. */
  readonly clockSkewMs: number | null;
}

/** Statuses from which the office has ended the job. */
const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["closed", "cancelled"];

/**
 * The only statuses a handset may drive directly, and the most important list
 * in this file.
 *
 * ── THE UNGUARDED DOOR THIS CLOSES ──────────────────────────────────────────
 *
 * `JOB-15`'s completion gate lives in `recordJobOutcome`, which calls
 * `assertJobCardComplete` before it moves a job to `work_complete`. It does
 * **not** live in `transitionJob`. `transitionJob(to: "work_complete")` is a
 * legal transition from `on_site` and it checks nothing about the job card.
 *
 * Today no caller in the web application reaches `work_complete` that way, so
 * the hole is theoretical there. It would not have stayed theoretical here.
 * This file's status handler calls `transitionJob`, so a device sending
 * `job_status/transition` with `to: "work_complete"` would have completed jobs
 * with no after photograph, no materials answer and no labour — silently, at
 * scale, from the one client that is hardest to observe. That is precisely the
 * failure `JOB-15` exists to prevent, arriving through the door it does not
 * cover.
 *
 * So completion is not reachable from this entity at all. It has exactly one
 * route in — `job_outcome/record` — and that route calls the function that
 * holds the gate. A technician's phone drives travel and arrival; finishing the
 * work is a job card, not a status change.
 *
 * The list is an allow-list rather than a `work_complete` special case on
 * purpose. `signed_off`, `invoiced`, `closed` and `cancelled` are office
 * decisions, and enumerating what a device *may* do means a status added to the
 * graph later is closed to handsets until somebody decides otherwise — the
 * opposite of how this hole was created.
 */
const DEVICE_DRIVABLE_STATUSES: readonly JobStatus[] = ["en_route", "on_site", "paused"];

/** Where a completion has to go instead. Named in the refusal, not just refused. */
const COMPLETION_MUTATION = "job_outcome/record";

/**
 * The job exists in this tenant **and this technician is on it**.
 *
 * ── WHY RLS IS NOT ENOUGH HERE, AND THIS IS NOT BELT-AND-BRACES ─────────────
 *
 * The tenant boundary is enforced in Postgres and is not in question. What it
 * does not express is the *other* boundary §8.5 states: "the field app is a
 * client, not a privileged actor, and its access is bounded by the technician's
 * own row-level scope." A device that guesses a job id from its own tenant
 * would otherwise be able to complete somebody else's work — inside the
 * boundary, so nothing refuses it.
 *
 * Every mutation that names a job goes through here first. There is no second
 * route into the handlers below.
 */
async function requireJobForTechnician(
  tx: TenantScopedTx,
  jobId: string,
  technicianId: string,
): Promise<{ status: JobStatus }> {
  const rows = (await tx.execute<{ status: string }>(sql`
    select j.status::text as status
      from jobs j
     where j.id = ${jobId}::uuid
       and j.deleted_at is null
       and exists (
         select 1 from job_visits v
          where v.job_id = j.id and v.technician_id = ${technicianId}::uuid
       )
     limit 1
  `)) as unknown as { status: string }[];

  const row = rows[0];
  if (!row) {
    // Deliberately one message for "no such job", "another tenant's job" and
    // "not yours". A device that can tell those apart can enumerate the board.
    throw new UserFacingError("That job is not assigned to you.");
  }
  return { status: row.status as JobStatus };
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new UserFacingError(`This record is missing "${key}" and cannot be filed.`);
  }
  return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalInteger(payload: Record<string, unknown>, key: string): number | null {
  const value = payload[key];
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new UserFacingError(`"${key}" is not a number.`);
  return Math.trunc(n);
}

/**
 * Turn a device timestamp into a server-timebase one.
 *
 * ── WHY THE CORRECTION IS APPLIED AND THE RAW VALUE KEPT ────────────────────
 *
 * ADR 0004 is explicit that reports use server time, and equally explicit that
 * offline capture is the whole point — so the moment a photograph was taken
 * genuinely is a device-clock fact and there is no server observation of it.
 * The only honest reconciliation is to shift it by the divergence measured on
 * the same request: a handset eleven minutes fast produces a `captured_at`
 * eleven minutes early, which is wrong on every report that puts a photograph
 * next to an arrival time.
 *
 * The raw claim survives in `field_mutations.payload` and the number used to
 * correct it in `field_mutations.clock_skew_ms`, so the arithmetic can be
 * undone by anybody who needs to argue with it. A correction whose input is not
 * recorded is a fabrication.
 */
function toServerTime(deviceIso: string | null, skewMs: number | null): Date | null {
  if (!deviceIso) return null;
  const parsed = new Date(deviceIso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getTime() - (skewMs ?? 0));
}

interface HandlerContext {
  readonly tx: TenantScopedTx;
  readonly ctx: TenantContext;
  readonly technicianId: string;
  readonly deviceId: string;
  readonly clientId: string;
  readonly skewMs: number | null;
  readonly recordedOfflineAt: Date | null;
  readonly baseVersion: string | null;
}

type HandlerOutcome =
  | { readonly kind: "accepted"; readonly result: Record<string, unknown> }
  | {
      readonly kind: "conflict";
      readonly jobId: string;
      readonly conflictKind: string;
      readonly reason: string;
      readonly detail: string;
      readonly attempted: Record<string, unknown>;
      readonly serverState: Record<string, unknown>;
    };

/**
 * Move a job's status, replayed as an ordered event against `job_events`
 * (§8.4, ADR 0004).
 *
 * ── THE THREE CASES, AND WHY ONLY ONE OF THEM IS A CONFLICT ─────────────────
 *
 * 1. **The server already holds the status the device is asking for.** The
 *    request succeeded and the response was lost; this is the commonest thing
 *    that happens on a mobile network. Accept, write nothing, and let the
 *    device forget it. Writing a second `job_events` row here would put a
 *    duplicate transition in the audit trail for a transition that happened
 *    once.
 *
 * 2. **The transition is legal from where the server is.** The office moved the
 *    job on while the technician was underground; the event log replays cleanly
 *    from the current status. Apply it. `transitionJob` writes the event row in
 *    the same transaction as the status, which is what keeps the two from ever
 *    disagreeing.
 *
 * 3. **The job has been closed or cancelled.** This is ADR 0004's named case
 *    and the only real conflict in the whole protocol: the technician did the
 *    work and the office did cancel the job, and both are right about the facts
 *    they hold. Server-authoritative means the office's status stands — but
 *    "stands" is not "the technician's afternoon is deleted". The attempt is
 *    written to `field_conflicts`, unresolved, and surfaces where a dispatcher
 *    can call the technician. That is what "needs a human, not a merge rule"
 *    requires, and a rule that silently dropped it would be indistinguishable
 *    from one that worked.
 *
 * An illegal transition that is *not* terminal — on_site arriving for a job the
 * office has put back to `triaged` — is also queued rather than rejected. The
 * device is not wrong; it is stale, and a technician who is told "no" by a
 * phone with no signal has no way to find out why.
 */
async function handleStatusTransition(h: HandlerContext, payload: Record<string, unknown>): Promise<HandlerOutcome> {
  const jobId = requireString(payload, "jobId");
  const to = requireString(payload, "to") as JobStatus;

  // Before anything is read, and certainly before `transitionJob` is called.
  // See `DEVICE_DRIVABLE_STATUSES`: this is the check that keeps `JOB-15`'s
  // gate in front of every completion the field app can cause.
  if (!DEVICE_DRIVABLE_STATUSES.includes(to)) {
    if (to === "work_complete") {
      throw new UserFacingError(
        "A job is finished by filling in its job card, not by changing its status. " +
          "Record the outcome, the parts and the time on the tools, and the job completes itself.",
      );
    }
    throw new UserFacingError(
      `"${STATUS_LABEL[to] ?? to}" is set by the office, not from the job. ` +
        "Call the coordinator if this job needs to move there.",
    );
  }

  const { status: current } = await requireJobForTechnician(h.tx, jobId, h.technicianId);

  if (current === to) {
    return { kind: "accepted", result: { jobId, status: current, noop: true } };
  }

  if (!canTransition(current, to)) {
    const terminal = TERMINAL_JOB_STATUSES.includes(current);
    return {
      kind: "conflict",
      jobId,
      conflictKind: terminal ? "status_conflict" : "illegal_transition",
      reason: terminal ? "job_ended_in_office" : "status_moved_on",
      detail: terminal
        ? `${STATUS_LABEL[current]} in the office while the technician was recording ` +
          `"${STATUS_LABEL[to]}" on site. The work may have been done after the job was ` +
          `${current === "cancelled" ? "cancelled" : "closed"} — call the technician before ` +
          `deciding what to bill.`
        : `The technician's phone recorded "${STATUS_LABEL[to]}" against a job that is now ` +
          `${STATUS_LABEL[current]}. The device was offline and is working from an older ` +
          `picture of this job.`,
      attempted: { to, at: h.recordedOfflineAt?.toISOString() ?? null, baseVersion: h.baseVersion },
      serverState: { status: current },
    };
  }

  const note = optionalString(payload, "note");
  await transitionJob(h.tx, h.ctx, {
    jobId,
    to,
    // The offline capture time goes in the note rather than in `occurred_at`,
    // which stays the server's clock. A status history whose instants come from
    // sixty different handsets does not sort.
    note: h.recordedOfflineAt
      ? `${note ? `${note} — ` : ""}recorded on the device at ${h.recordedOfflineAt.toISOString()}`
      : note ?? undefined,
  });

  return { kind: "accepted", result: { jobId, status: to } };
}

/**
 * Record the outcome and complete the work — through `recordJobOutcome`, which
 * is where `JOB-15` lives.
 *
 * The terminal-status check happens *before* the call and not instead of it.
 * `recordJobOutcome` would refuse a cancelled job with a perfectly good
 * sentence, but a refusal is the wrong shape for this case: it tells the device
 * "no" and leaves the dispatcher unaware that a technician spent an afternoon
 * on a job the office had killed. §8.4 says that is a conflict, so it is raised
 * as one, and every other refusal `recordJobOutcome` makes — a retired code, a
 * job card with no photograph — is passed through untouched, because those are
 * things the technician can fix.
 */
async function handleOutcome(h: HandlerContext, payload: Record<string, unknown>): Promise<HandlerOutcome> {
  const jobId = requireString(payload, "jobId");
  const { status: current } = await requireJobForTechnician(h.tx, jobId, h.technicianId);

  if (TERMINAL_JOB_STATUSES.includes(current)) {
    return {
      kind: "conflict",
      jobId,
      conflictKind: "status_conflict",
      reason: "job_ended_in_office",
      detail:
        `A completed job card arrived from the technician's phone for a job that was ` +
        `${current} in the office. The work appears to have been done. Decide whether to ` +
        `reopen the job or write the visit off, and tell the technician which.`,
      attempted: {
        outcomeCode: optionalString(payload, "outcomeCode"),
        at: h.recordedOfflineAt?.toISOString() ?? null,
      },
      serverState: { status: current },
    };
  }

  const result = await recordJobOutcome(h.tx, h.ctx, {
    jobId,
    outcomeCode: requireString(payload, "outcomeCode"),
    symptomCodeId: optionalString(payload, "symptomCodeId"),
    causeCodeId: optionalString(payload, "causeCodeId"),
    remedyCodeId: optionalString(payload, "remedyCodeId"),
    visitId: optionalString(payload, "visitId"),
    note: optionalString(payload, "note"),
    completeWork: payload["completeWork"] !== false,
  });

  return { kind: "accepted", result: { ...result } };
}

/**
 * Turn an upload id into the key, type and EXIF the pipeline produced.
 *
 * Three conditions, and each one is a different way the same mistake lands:
 *
 *   * **It is this technician's upload, for this job.** `upload_sessions.reference`
 *     holds the job the upload was opened against, checked at
 *     `/uploads/init`. Reading it back here rather than trusting the mutation
 *     means a device cannot cite somebody else's upload against its own job.
 *   * **It is finished.** An `open` session has no storage key and no scanned
 *     bytes; filing it would put a job card in front of a customer citing a
 *     photograph that does not exist yet.
 *   * **It is a photograph or a signature.** A handset has no business filing a
 *     candidate document against a job.
 */
async function resolveDeviceUpload(
  tx: TenantScopedTx,
  input: { uploadId: string; jobId: string; technicianId: string },
): Promise<{
  sessionId: string;
  storageKey: string;
  contentType: string | null;
  sizeBytes: number | null;
  capturedAt: Date | null;
  capturedLat: number | null;
  capturedLon: number | null;
}> {
  interface Row extends Record<string, unknown> {
    id: string;
    purpose: string;
    reference: string | null;
    status: string;
    storage_key: string | null;
    content_type: string | null;
    size_bytes: number | null;
    captured_at: string | null;
    captured_lat: string | null;
    captured_lon: string | null;
  }

  const rows = (await tx.execute<Row>(sql`
    select s.id, s.purpose, s.reference, s.status, s.storage_key, s.content_type,
           s.size_bytes, s.captured_at, s.captured_lat, s.captured_lon
      from upload_sessions s
     where s.id = ${input.uploadId}::uuid
     limit 1
  `)) as unknown as Row[];

  const row = rows[0];
  // RLS makes "no such upload" and "another tenant's" the same answer, and the
  // ownership checks below deliberately give the same one again.
  if (!row) throw new UserFacingError("That upload is not on file.");

  if (row.purpose !== "job_photo" && row.purpose !== "job_signature") {
    throw new UserFacingError("That upload is not a job photograph or a signature.");
  }
  if (row.reference !== input.jobId) {
    throw new UserFacingError("That upload was not started for this job.");
  }
  if (row.status !== "complete" || !row.storage_key) {
    throw new UserFacingError(
      "That photograph has not finished uploading yet. It will be filed once the last part arrives.",
    );
  }

  // Belt on the ownership: the job named by the upload must still be this
  // technician's. A reassignment between init and completion is rare and is
  // exactly the case where filing it anyway would be wrong.
  await requireJobForTechnician(tx, input.jobId, input.technicianId);

  return {
    sessionId: row.id,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    capturedAt: rowDate(row.captured_at),
    // `numeric` arrives as a string. Parsed here, at the edge, exactly once.
    capturedLat: row.captured_lat === null ? null : Number(row.captured_lat),
    capturedLon: row.captured_lon === null ? null : Number(row.captured_lon),
  };
}

/**
 * The append-only classes (§8.4, row one): a photograph, a part, an hour, a
 * signature.
 *
 * "The biggest single design win available", and it is entirely free here: two
 * devices appending to a job cannot conflict, and a retry of an append is
 * caught by the `client_id` ledger before it ever reaches one of these. There
 * is no merge rule because there is nothing to merge — which is why this
 * function is a switch and not an algorithm.
 */
async function handleAppend(
  h: HandlerContext,
  entity: string,
  op: string,
  payload: Record<string, unknown>,
): Promise<HandlerOutcome> {
  const jobId = requireString(payload, "jobId");
  await requireJobForTechnician(h.tx, jobId, h.technicianId);

  switch (`${entity}/${op}`) {
    case "job_attachment/append": {
      // The device names the UPLOAD, and the server resolves the key.
      //
      // ── WHY A HANDSET MAY NOT NAME A STORAGE KEY ───────────────────────────
      //
      // An earlier version of this took `storageKey` straight from the payload,
      // which meant a device could file an attachment against its own job
      // pointing at *any* object in the tenant — a candidate's passport scan, a
      // signed contract — and the job would then render it to the customer.
      // Nothing in `recordJobAttachment` could have caught that: a key is a
      // string, and by the time it arrives the question of who was allowed to
      // produce it is already lost.
      //
      // So the only thing a device may cite is an upload it completed, and the
      // key comes from that row. `SEC-8`'s rule that a key is not a link cuts
      // both ways: the upload route never hands one out, and this one never
      // accepts one.
      const upload = await resolveDeviceUpload(h.tx, {
        uploadId: requireString(payload, "uploadId"),
        jobId,
        technicianId: h.technicianId,
      });

      const attachment = await recordJobAttachment(h.tx, h.ctx, {
        jobId,
        visitId: optionalString(payload, "visitId"),
        kind: requireString(payload, "kind") as JobAttachmentKind,
        storageKey: upload.storageKey,
        // From the finished object rather than from the device's claim about
        // it. The pipeline sniffed the bytes; the phone only guessed.
        mimeType: upload.contentType,
        sizeBytes: upload.sizeBytes,
        caption: optionalString(payload, "caption"),
        // The pipeline extracted EXIF into columns (§8.6) precisely so this is
        // not the device's word. Falls back to the corrected device clock only
        // when the image carried no timestamp of its own.
        capturedAt:
          upload.capturedAt ?? toServerTime(optionalString(payload, "capturedAt"), h.skewMs),
        capturedLat: upload.capturedLat,
        capturedLng: upload.capturedLon,
      });
      return { kind: "accepted", result: { ...attachment, uploadId: upload.sessionId } };
    }

    case "job_material/append": {
      const material = await recordJobMaterial(h.tx, h.ctx, {
        jobId,
        visitId: optionalString(payload, "visitId"),
        sku: optionalString(payload, "sku"),
        description: requireString(payload, "description"),
        // A decimal string, because `numeric(12,3)` is not a float. Passed
        // through untouched: parsing it here would be the rounding this
        // codebase spends a lot of effort not doing.
        quantity: requireString(payload, "quantity"),
        unit: optionalString(payload, "unit") ?? "ea",
        unitCostMinor: optionalInteger(payload, "unitCostMinor"),
        unitPriceMinor: optionalInteger(payload, "unitPriceMinor"),
        isBillable: payload["isBillable"] !== false,
        // `FLD-9`. Both of these were on the wire and read by nothing: the
        // client sent them, `job_materials` had no column, and the line was
        // accepted with the provenance discarded. Nothing refused and nothing
        // warned, which is the worst shape the loss could take — a refusal
        // would have told the technician to try something else.
        //
        // Read with `optionalString` rather than `requireString`, even though
        // `source` is required on the wire. A sync mutation was committed on
        // the device before it was ever sent, so refusing one here does not
        // undo it; it strands the queue behind a line that can never be
        // accepted. An older client that predates the field's own picker
        // records "not recorded", which is true, and `recordJobMaterial`
        // still refuses a value that is present and wrong.
        source: optionalString(payload, "source") as MaterialSource | null,
        serialNumber: optionalString(payload, "serialNumber"),
      });
      return { kind: "accepted", result: { ...material } };
    }

    case "job_material/declare_none": {
      await declareNoMaterials(h.tx, h.ctx, {
        jobId,
        visitId: optionalString(payload, "visitId"),
        note: optionalString(payload, "note"),
      });
      return { kind: "accepted", result: { jobId, declared: "materials_none" } };
    }

    case "job_photo/exempt": {
      const exemption = await recordPhotoExemption(h.tx, h.ctx, {
        jobId,
        visitId: optionalString(payload, "visitId"),
        reasonCode: requireString(payload, "reasonCode"),
        note: optionalString(payload, "note"),
      });
      return { kind: "accepted", result: { ...exemption } };
    }

    case "visit_labour/record": {
      const workMinutes = optionalInteger(payload, "workMinutes");
      if (workMinutes === null) throw new UserFacingError("Time on the tools is missing from this record.");
      await recordVisitLabour(h.tx, h.ctx, {
        jobId,
        visitId: requireString(payload, "visitId"),
        workMinutes,
        travelMinutes: optionalInteger(payload, "travelMinutes"),
      });
      return { kind: "accepted", result: { jobId, workMinutes } };
    }

    case "job_signature/record": {
      // Same rule as the photograph above, and it matters more here: a
      // signature is the evidence a job was accepted, and one citing a key the
      // device chose would be evidence of nothing.
      const signatureUpload = await resolveDeviceUpload(h.tx, {
        uploadId: requireString(payload, "uploadId"),
        jobId,
        technicianId: h.technicianId,
      });

      const signature = await recordJobSignature(h.tx, h.ctx, {
        jobId,
        visitId: optionalString(payload, "visitId"),
        signedByName: requireString(payload, "signedByName"),
        signedByRole: optionalString(payload, "signedByRole"),
        signatureStorageKey: signatureUpload.storageKey,
        satisfactionRating: optionalInteger(payload, "satisfactionRating"),
        comments: optionalString(payload, "comments"),
      });
      return { kind: "accepted", result: { ...signature, uploadId: signatureUpload.sessionId } };
    }

    default:
      throw new UserFacingError(`"${entity}/${op}" is not something this app records.`);
  }
}

/**
 * The technician's written account of the visit — free-text scalars, §8.4 row
 * four: **last-write-wins on server receipt, with the loser preserved and
 * surfaced.**
 *
 * ── WHY THIS WRITER LIVES HERE AND NOT IN `jobcard.ts` ──────────────────────
 *
 * `job_reports` has had no writer and no reader anywhere in this repository
 * since `0000`. The job-card work owns attachments, materials, labour and
 * signatures — not this table — so building it there would have been editing
 * somebody else's file for a row they are not adding. It is written here
 * because the field app is the only thing that produces it, and this comment is
 * the marker: **if a web job-card panel ever needs to save a report, it should
 * call this function rather than write a second one.**
 *
 * ── WHAT "THE LOSER IS PRESERVED" ACTUALLY MEANS ────────────────────────────
 *
 * The arriving write always wins, because it arrived later — that is what
 * last-write-wins on *server receipt* means, and it is the right way round: the
 * technician typing in a plant room is the one whose account this is.
 *
 * What must never happen is the other half being deleted with nobody told. If
 * the row has changed since the version the device was working from, the text
 * being overwritten goes into `field_conflicts` — carrying the whole superseded
 * value, not a summary — and appears on the board. "Never silently discard a
 * technician's typing" is a requirement about *silence*, and the loser here is
 * usually whatever the office typed while the phone was underground.
 *
 * Per field, not per row. A technician who fills in "work carried out" while a
 * supervisor adds a recommendation must not wipe the recommendation, and would
 * if this replaced the row wholesale.
 *
 * ── `recommendationUploadId`, AND WHY IT IS FILED HERE AND NOT AS AN APPEND ─
 *
 * `FLD-12` is "a free field with an optional photo that raises a lead" — the
 * text has had a server home since this function was written
 * (`job_reports.recommendation`); the photograph had nowhere to land until
 * `0034` gave `job_attachments.kind` a sixth value, `photo_recommendation`.
 *
 * The upload is resolved and filed with `recordJobAttachment` in the SAME
 * function call — the same savepoint — as the note write below, before either
 * branch touches `job_reports`. That is what makes the association causal
 * rather than coincidental: a client that sent `job_attachment/append` with
 * `kind: "photo_recommendation"` as a second, separate mutation would leave
 * the office to guess which recommendation a photograph belongs to from
 * nothing but its timestamp. Filing it here means there is only ever one way
 * a `photo_recommendation` attachment gets written, and it always has a note
 * beside it. `resolveDeviceUpload` applies its usual three checks — this
 * technician's upload, for this job, finished — exactly as `job_attachment/
 * append` does; a device gets no shortcut around them for citing a
 * recommendation photo instead of an after photo.
 */
async function handleJobNote(h: HandlerContext, payload: Record<string, unknown>): Promise<HandlerOutcome> {
  const jobId = requireString(payload, "jobId");
  await requireJobForTechnician(h.tx, jobId, h.technicianId);
  const visitId = optionalString(payload, "visitId");
  const recommendationUploadId = optionalString(payload, "recommendationUploadId");

  const fields = ["faultFound", "workCarriedOut", "recommendation", "rawNotes"] as const;
  const incoming: Partial<Record<(typeof fields)[number], string>> = {};
  for (const field of fields) {
    const value = optionalString(payload, field);
    if (value !== null) incoming[field] = value;
  }
  if (Object.keys(incoming).length === 0 && !recommendationUploadId) {
    throw new UserFacingError("There is nothing written in this report to save.");
  }

  // Filed before either branch below writes `job_reports`, and never guarded
  // by `serverChanged`: JOB-15 gates on `photo_after`, never on this kind
  // (`getJobCard` in `jobcard.ts` reads that filter), so there is no
  // completion outcome riding on whether this succeeds — only the lead. A
  // bad or borrowed uploadId throws `UserFacingError`, the savepoint this
  // mutation runs in rolls back, and the note write below never happens
  // either — a technician does not lose their typed recommendation to a
  // stale upload id, they are asked to resend both together.
  let recommendationAttachmentId: string | null = null;
  if (recommendationUploadId) {
    const upload = await resolveDeviceUpload(h.tx, {
      uploadId: recommendationUploadId,
      jobId,
      technicianId: h.technicianId,
    });
    const attachment = await recordJobAttachment(h.tx, h.ctx, {
      jobId,
      visitId,
      kind: "photo_recommendation",
      storageKey: upload.storageKey,
      mimeType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      capturedAt: upload.capturedAt,
      capturedLat: upload.capturedLat,
      capturedLng: upload.capturedLon,
    });
    recommendationAttachmentId = attachment.id;
  }

  interface ReportRow extends Record<string, unknown> {
    id: string;
    fault_found: string | null;
    work_carried_out: string | null;
    recommendation: string | null;
    raw_notes: string | null;
    updated_at: string;
  }

  const existingRows = (await tx_selectReport(h.tx, jobId, visitId)) as ReportRow[];
  const existing = existingRows[0];

  if (!existing) {
    const inserted = await h.tx
      .insert(schema.jobReports)
      .values({
        tenantId: h.ctx.tenantId,
        jobId,
        visitId,
        faultFound: incoming.faultFound ?? null,
        workCarriedOut: incoming.workCarriedOut ?? null,
        recommendation: incoming.recommendation ?? null,
        rawNotes: incoming.rawNotes ?? null,
      })
      .returning({ id: schema.jobReports.id });

    const row = inserted[0];
    if (!row) throw new Error("The job report row was not written");
    return {
      kind: "accepted",
      result: { id: row.id, jobId, created: true, recommendationAttachmentId },
    };
  }

  // The device tells us which version it was editing. Anything newer on the
  // server is a change the phone never saw, and overwriting it is the loss this
  // clause exists to make visible.
  const base = h.baseVersion ? new Date(h.baseVersion) : null;
  const serverChanged =
    base !== null && !Number.isNaN(base.getTime()) && requiredRowDate(existing.updated_at) > base;

  const superseded: Record<string, unknown> = {};
  if (serverChanged) {
    const current: Record<string, string | null> = {
      faultFound: existing.fault_found,
      workCarriedOut: existing.work_carried_out,
      recommendation: existing.recommendation,
      rawNotes: existing.raw_notes,
    };
    for (const field of fields) {
      const before = current[field];
      // Only a field this write actually replaces, and only where there was
      // something there. Recording an unchanged field as "lost" would fill the
      // dispatcher's queue with entries nobody needs to read.
      if (incoming[field] !== undefined && before && before !== incoming[field]) {
        superseded[field] = before;
      }
    }
  }

  await h.tx
    .update(schema.jobReports)
    .set({
      ...(incoming.faultFound !== undefined ? { faultFound: incoming.faultFound } : {}),
      ...(incoming.workCarriedOut !== undefined ? { workCarriedOut: incoming.workCarriedOut } : {}),
      ...(incoming.recommendation !== undefined ? { recommendation: incoming.recommendation } : {}),
      ...(incoming.rawNotes !== undefined ? { rawNotes: incoming.rawNotes } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.jobReports.id, existing.id));

  if (Object.keys(superseded).length > 0) {
    return {
      kind: "conflict",
      jobId,
      conflictKind: "text_overwritten",
      reason: "text_overwritten",
      detail:
        `The technician's phone saved a job report over text that had been changed in the ` +
        `office since the phone last synced. The technician's version is now the one on ` +
        `file; what it replaced is recorded here so it is not lost.`,
      attempted: { ...incoming },
      serverState: { superseded, reportId: existing.id, recommendationAttachmentId },
    };
  }

  return {
    kind: "accepted",
    result: { id: existing.id, jobId, created: false, recommendationAttachmentId },
  };
}

/** The report for this job and visit, newest first. */
async function tx_selectReport(
  tx: TenantScopedTx,
  jobId: string,
  visitId: string | null,
): Promise<Record<string, unknown>[]> {
  return (await tx.execute(sql`
    select id, fault_found, work_carried_out, recommendation, raw_notes, updated_at
      from job_reports
     where job_id = ${jobId}::uuid
       and (${visitId}::uuid is null or visit_id = ${visitId}::uuid)
       and deleted_at is null
     order by updated_at desc
     limit 1
  `)) as unknown as Record<string, unknown>[];
}

/**
 * Clocking in and out from the phone.
 *
 * ── WHY THIS WRITER LIVES HERE ──────────────────────────────────────────────
 *
 * `attendance_events` has had no writer anywhere in this repository, and the
 * column that makes it interesting — `recorded_offline_at` — was added
 * specifically for this path: ADR 0004 names it as the reason the column
 * exists. The field app is the only thing that produces these rows today.
 *
 * If an office attendance screen is ever built it should call this function
 * rather than insert its own row, for the reason every other duplicate in this
 * codebase was written down: two writers means two sets of rules about which
 * clock a payroll dispute is argued from.
 *
 * `occurred_at` is the **corrected** device time and `recorded_offline_at` is
 * the raw claim. Both are kept, deliberately: the first is what a report sums,
 * the second is what a technician disputing a report points at.
 */
export async function recordFieldAttendance(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    technicianId: string;
    kind: string;
    /** The device's own clock. Corrected before it becomes `occurred_at`. */
    occurredAt: Date;
    recordedOfflineAt: Date | null;
    lat?: number | null;
    lng?: number | null;
    accuracyMetres?: number | null;
    withinGeofence?: boolean | null;
    deviceId: string;
  },
): Promise<{ id: string }> {
  const kinds = ["shift_in", "shift_out", "break_start", "break_end"];
  if (!kinds.includes(input.kind)) {
    throw new UserFacingError(`"${input.kind}" is not a kind of attendance event this system records.`);
  }

  const inserted = await tx
    .insert(schema.attendanceEvents)
    .values({
      tenantId: ctx.tenantId,
      technicianId: input.technicianId,
      kind: input.kind as "shift_in" | "shift_out" | "break_start" | "break_end",
      occurredAt: input.occurredAt,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      accuracyMetres: input.accuracyMetres ?? null,
      withinGeofence: input.withinGeofence ?? null,
      recordedOfflineAt: input.recordedOfflineAt,
      deviceId: input.deviceId,
    })
    .returning({ id: schema.attendanceEvents.id });

  const row = inserted[0];
  if (!row) throw new Error("The attendance row was not written");

  await writeAuditNote(tx, ctx, {
    tableName: "attendance_events",
    recordId: row.id,
    // 10 characters. `audit_log.action` is varchar(16).
    action: "attendance",
    detail: { technicianId: input.technicianId, kind: input.kind, deviceId: input.deviceId },
  });

  return { id: row.id };
}

async function handleAttendance(h: HandlerContext, payload: Record<string, unknown>): Promise<HandlerOutcome> {
  const deviceIso = optionalString(payload, "occurredAt");
  const corrected = toServerTime(deviceIso, h.skewMs);
  if (!corrected) throw new UserFacingError("This attendance record has no usable time on it.");

  const result = await recordFieldAttendance(h.tx, h.ctx, {
    technicianId: h.technicianId,
    kind: requireString(payload, "kind"),
    occurredAt: corrected,
    recordedOfflineAt: deviceIso ? new Date(deviceIso) : null,
    lat: payload["lat"] === undefined || payload["lat"] === null ? null : Number(payload["lat"]),
    lng: payload["lng"] === undefined || payload["lng"] === null ? null : Number(payload["lng"]),
    accuracyMetres: optionalInteger(payload, "accuracyMetres"),
    withinGeofence: typeof payload["withinGeofence"] === "boolean" ? payload["withinGeofence"] : null,
    deviceId: h.deviceId,
  });

  return { kind: "accepted", result: { ...result } };
}

/**
 * Apply a batch of mutations from one device (§8.3).
 *
 * ── THE FOUR OUTCOMES, AND WHY THERE ARE FOUR ───────────────────────────────
 *
 * §8.5 shows two — `accepted` and `conflicts` — and two is not enough for a
 * client that has to decide what to do with the row still sitting in its
 * outbox. The device needs to know whether to forget it, retry it, show it to a
 * human, or stop trying:
 *
 *   accepted   applied, or already applied. Delete the outbox row.
 *   conflicts  a person has to decide. Stop retrying; a dispatcher has it.
 *   rejected   will never succeed — a retired outcome code, a job card with no
 *              photograph. Mark it `dead` and SHOW IT (§8.3 is explicit about
 *              that: a dead outbox row that is invisible is lost work).
 *   deferred   its dependency has not been accepted yet. Retry.
 *
 * ── WHY EACH MUTATION GETS A SAVEPOINT ──────────────────────────────────────
 *
 * A failed statement aborts the whole Postgres transaction, not just itself. A
 * batch of forty mutations where the seventh names a retired fault code would
 * therefore lose the other thirty-nine, and the device would replay all forty
 * on the next attempt and fail in the same place forever. The savepoint makes
 * one bad mutation cost exactly one mutation.
 *
 * The receipt is written **after** the savepoint is released or rolled back,
 * but inside the outer transaction — so the ledger entry and the effect it
 * describes commit together. A receipt that could outlive its own effect would
 * be worse than no receipt: the retry that would have fixed it is exactly what
 * the receipt suppresses.
 */
export async function applyFieldMutations(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    deviceId: string;
    technicianId: string;
    mutations: readonly FieldMutation[];
    /** The device's clock at the moment it sent this batch. */
    deviceTime?: string | null;
  },
): Promise<FieldMutationResult> {
  const serverTimeRows = (await tx.execute<{ now: string }>(
    sql`select now()::text as now`,
  )) as unknown as { now: string }[];
  const serverTime = requiredRowDate(serverTimeRows[0]?.now ?? null);

  // Measured once per request, from the envelope rather than from any single
  // record: a batch drained after a shift contains timestamps from across the
  // day, and the divergence being corrected for is the handset's, not each
  // row's.
  let skewMs: number | null = null;
  if (input.deviceTime) {
    const deviceNow = new Date(input.deviceTime);
    if (!Number.isNaN(deviceNow.getTime())) {
      skewMs = deviceNow.getTime() - serverTime.getTime();
    }
  }

  const accepted: { clientId: string; result: Record<string, unknown> }[] = [];
  const conflicts: FieldConflictReport[] = [];
  const rejected: { clientId: string; message: string; gaps?: readonly string[] }[] = [];
  const deferred: { clientId: string; dependsOn: string }[] = [];

  // Accepted within this batch, so a photograph and the completion citing it
  // can arrive in one request. Without it the pair would take two round trips
  // for no reason, which on a bad connection is two chances to fail.
  const acceptedHere = new Set<string>();

  for (let index = 0; index < input.mutations.length; index += 1) {
    const mutation = input.mutations[index];
    if (!mutation) continue;

    const clientId = typeof mutation.clientId === "string" ? mutation.clientId.trim() : "";
    if (!clientId || clientId.length > 32) {
      rejected.push({ clientId: clientId || `#${index}`, message: "This record has no usable client id." });
      continue;
    }

    // ── Idempotency, first and before anything else ─────────────────────────
    //
    // The dominant failure is "request succeeded, response lost, client
    // retries". Re-executing here books the part twice. Replaying the STORED
    // result rather than a fresh success is the other half: a device told
    // "accepted, id X" once and "accepted, id Y" the next time has two rows on
    // its conscience and no way to know which the server kept.
    const priorRows = (await tx.execute<{ status: string; result: unknown; conflict_reason: string | null }>(sql`
      select status, result, conflict_reason
        from field_mutations
       where client_id = ${clientId}
       limit 1
    `)) as unknown as { status: string; result: unknown; conflict_reason: string | null }[];

    const prior = priorRows[0];
    if (prior) {
      if (prior.status === "accepted") {
        acceptedHere.add(clientId);
        accepted.push({ clientId, result: (prior.result as Record<string, unknown>) ?? {} });
      } else if (prior.status === "conflict") {
        const stored = (prior.result as Record<string, unknown>) ?? {};
        conflicts.push({
          clientId,
          reason: prior.conflict_reason ?? "conflict",
          serverState: (stored["serverState"] as Record<string, unknown>) ?? {},
          detail: typeof stored["detail"] === "string" ? stored["detail"] : "This record is with the office.",
        });
      } else {
        const stored = (prior.result as Record<string, unknown>) ?? {};
        rejected.push({
          clientId,
          message: typeof stored["message"] === "string" ? stored["message"] : "This record cannot be filed.",
        });
      }
      continue;
    }

    // ── Ordering ────────────────────────────────────────────────────────────
    //
    // §8.3: "a completion record must never arrive before the evidence it
    // cites." A dependency that is not yet accepted defers the mutation and
    // writes NO receipt, so the device may retry it — a receipt here would
    // permanently suppress a mutation that was only early.
    const dependsOn = mutation.dependsOnClientId?.trim() || null;
    if (dependsOn && !acceptedHere.has(dependsOn)) {
      const depRows = (await tx.execute<{ status: string }>(sql`
        select status from field_mutations where client_id = ${dependsOn} limit 1
      `)) as unknown as { status: string }[];
      if (depRows[0]?.status !== "accepted") {
        deferred.push({ clientId, dependsOn });
        continue;
      }
    }

    const kind = `${mutation.entity}/${mutation.op}`;
    const payload = (mutation.payload ?? {}) as Record<string, unknown>;
    const recordedOfflineAt = mutation.recordedOfflineAt ? new Date(mutation.recordedOfflineAt) : null;
    const handlerContext: HandlerContext = {
      tx,
      ctx,
      technicianId: input.technicianId,
      deviceId: input.deviceId,
      clientId,
      skewMs,
      recordedOfflineAt:
        recordedOfflineAt && !Number.isNaN(recordedOfflineAt.getTime()) ? recordedOfflineAt : null,
      baseVersion: mutation.baseVersion?.trim() || null,
    };

    // Generated here, never from input. `sql.raw` is what issues it, and a
    // savepoint name is an identifier that cannot be parameterised.
    const savepoint = `field_mut_${index}`;
    await tx.execute(sql.raw(`savepoint ${savepoint}`));

    let outcome: HandlerOutcome | null = null;
    let failure: string | null = null;

    try {
      switch (kind) {
        case "job_status/transition":
          outcome = await handleStatusTransition(handlerContext, payload);
          break;
        case "job_outcome/record":
          outcome = await handleOutcome(handlerContext, payload);
          break;
        case "job_note/upsert":
          outcome = await handleJobNote(handlerContext, payload);
          break;
        case "attendance/append":
          outcome = await handleAttendance(handlerContext, payload);
          break;
        default:
          outcome = await handleAppend(handlerContext, mutation.entity, mutation.op, payload);
      }
      await tx.execute(sql.raw(`release savepoint ${savepoint}`));
    } catch (error) {
      await tx.execute(sql.raw(`rollback to savepoint ${savepoint}`));
      // Only a message the domain deliberately wrote for a human reaches the
      // handset. Everything else is logged where operations can see it and
      // replaced, exactly as `apps/web/src/lib/errors.ts` does it for actions:
      // a driver error rendered on a phone in a plant room helps nobody and
      // discloses the schema.
      if (error instanceof UserFacingError) {
        failure = error.message;
      } else {
        console.error(`[field] mutation ${clientId} (${kind}) failed`, error);
        failure = "This record could not be filed. The office has been sent the details.";
      }
    }

    if (failure !== null) {
      // A completion refused by `JOB-15` is the one rejection the device can do
      // something about, so it comes back as data and not only as prose.
      //
      // Read here rather than inside the handler because the handler's
      // savepoint has already rolled back — this is a fresh read of what the
      // job card actually holds, which is the same list `getJobCard` gives the
      // web panel. The screen and the gate therefore read one source, and a
      // phone that says "ready" about a job the server refuses is not
      // representable.
      //
      // Wrapped in its own guard: a failure computing the gaps must not replace
      // the refusal the technician needs to see with a different error.
      let gaps: readonly string[] | undefined;
      if (mutation.entity === "job_outcome" && typeof payload["jobId"] === "string") {
        try {
          gaps = (await getJobCard(tx, payload["jobId"])).gaps;
        } catch (error) {
          console.error(`[field] could not read job card gaps for ${clientId}`, error);
        }
      }

      rejected.push({ clientId, message: failure, ...(gaps?.length ? { gaps } : {}) });
      await writeReceipt(tx, ctx, {
        deviceId: input.deviceId,
        technicianId: input.technicianId,
        mutation,
        clientId,
        status: "rejected",
        result: { message: failure, ...(gaps?.length ? { gaps } : {}) },
        conflictReason: null,
        recordedOfflineAt: handlerContext.recordedOfflineAt,
        skewMs,
      });
      continue;
    }

    if (outcome && outcome.kind === "conflict") {
      await raiseFieldConflict(tx, ctx, {
        jobId: outcome.jobId,
        deviceId: input.deviceId,
        technicianId: input.technicianId,
        clientId,
        kind: outcome.conflictKind,
        detail: outcome.detail,
        attempted: outcome.attempted,
        serverState: outcome.serverState,
      });

      conflicts.push({
        clientId,
        reason: outcome.reason,
        serverState: outcome.serverState,
        detail: outcome.detail,
      });

      await writeReceipt(tx, ctx, {
        deviceId: input.deviceId,
        technicianId: input.technicianId,
        mutation,
        clientId,
        status: "conflict",
        result: { detail: outcome.detail, serverState: outcome.serverState },
        conflictReason: outcome.reason.slice(0, 48),
        recordedOfflineAt: handlerContext.recordedOfflineAt,
        skewMs,
      });
      continue;
    }

    if (outcome) {
      acceptedHere.add(clientId);
      accepted.push({ clientId, result: outcome.result });
      await writeReceipt(tx, ctx, {
        deviceId: input.deviceId,
        technicianId: input.technicianId,
        mutation,
        clientId,
        status: "accepted",
        result: outcome.result,
        conflictReason: null,
        recordedOfflineAt: handlerContext.recordedOfflineAt,
        skewMs,
      });
    }
  }

  return { accepted, conflicts, rejected, deferred, serverTime, clockSkewMs: skewMs };
}

async function writeReceipt(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    deviceId: string;
    technicianId: string;
    mutation: FieldMutation;
    clientId: string;
    status: "accepted" | "conflict" | "rejected";
    result: Record<string, unknown>;
    conflictReason: string | null;
    recordedOfflineAt: Date | null;
    skewMs: number | null;
  },
): Promise<void> {
  await tx.insert(schema.fieldMutations).values({
    tenantId: ctx.tenantId,
    deviceId: input.deviceId,
    technicianId: input.technicianId,
    clientId: input.clientId,
    entity: String(input.mutation.entity).slice(0, 32),
    op: String(input.mutation.op).slice(0, 24),
    payload: input.mutation.payload ?? {},
    baseVersion: input.mutation.baseVersion?.slice(0, 64) ?? null,
    dependsOnClientId: input.mutation.dependsOnClientId?.slice(0, 32) ?? null,
    status: input.status,
    result: input.result,
    conflictReason: input.conflictReason,
    recordedOfflineAt: input.recordedOfflineAt,
    clockSkewMs: input.skewMs,
  });
}

// ── The conflict queue (§8.4) ────────────────────────────────────────────────

async function raiseFieldConflict(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: {
    jobId: string;
    deviceId: string;
    technicianId: string;
    clientId: string;
    kind: string;
    detail: string;
    attempted: Record<string, unknown>;
    serverState: Record<string, unknown>;
  },
): Promise<void> {
  await tx
    .insert(schema.fieldConflicts)
    .values({
      tenantId: ctx.tenantId,
      jobId: input.jobId,
      deviceId: input.deviceId,
      technicianId: input.technicianId,
      clientId: input.clientId,
      kind: input.kind.slice(0, 32),
      detail: input.detail,
      attempted: input.attempted,
      serverState: input.serverState,
    })
    // A device retrying a mutation already in dispute must not queue a second
    // entry for the dispatcher. The unique index is what makes this idempotent
    // rather than a rule remembered here.
    .onConflictDoNothing();

  await writeAuditNote(tx, ctx, {
    tableName: "field_conflicts",
    recordId: input.jobId,
    // 8 characters. `audit_log.action` is varchar(16).
    action: "conflict",
    detail: { clientId: input.clientId, kind: input.kind, technicianId: input.technicianId },
  });
}

export interface FieldConflictRow {
  readonly id: string;
  readonly jobId: string;
  readonly jobReference: string;
  readonly jobTitle: string;
  readonly jobStatus: JobStatus;
  readonly technicianId: string;
  readonly technicianName: string;
  readonly deviceLabel: string;
  readonly clientId: string;
  readonly kind: string;
  readonly detail: string;
  readonly attempted: Record<string, unknown>;
  readonly serverState: Record<string, unknown>;
  readonly raisedAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolution: string | null;
}

/**
 * The dispatcher's queue (§8.4).
 *
 * ── WHY THIS IS A LIST AND NOT A NOTIFICATION ───────────────────────────────
 *
 * A conflict is not an alert; it is unfinished work. An email is read once,
 * possibly by somebody on leave, and then the state of the world is that
 * everyone assumes somebody dealt with it. A queue with a count on the board
 * stays wrong until it is made right, which is the property this needs — the
 * technician's afternoon is on the other end of it.
 *
 * Unresolved first, oldest first inside that: the conflict that has been
 * waiting longest is the one where somebody is still holding a phone wondering
 * why their job card has not gone through.
 */
export async function listFieldConflicts(
  tx: TenantScopedTx,
  options?: { unresolvedOnly?: boolean; jobId?: string; limit?: number },
): Promise<readonly FieldConflictRow[]> {
  const unresolvedOnly = options?.unresolvedOnly ?? true;
  const jobId = options?.jobId ?? null;
  const limit = Math.max(1, Math.min(200, options?.limit ?? 50));

  interface Row extends Record<string, unknown> {
    id: string;
    job_id: string;
    job_reference: string;
    job_title: string;
    job_status: string;
    technician_id: string;
    technician_name: string;
    device_label: string;
    client_id: string;
    kind: string;
    detail: string;
    attempted: Record<string, unknown> | null;
    server_state: Record<string, unknown> | null;
    raised_at: string;
    resolved_at: string | null;
    resolution: string | null;
  }

  const rows = (await tx.execute<Row>(sql`
    select c.id,
           c.job_id,
           j.reference as job_reference,
           j.title as job_title,
           j.status::text as job_status,
           c.technician_id,
           t.full_name as technician_name,
           d.label as device_label,
           c.client_id,
           c.kind,
           c.detail,
           c.attempted,
           c.server_state,
           c.raised_at,
           c.resolved_at,
           c.resolution
      from field_conflicts c
      join jobs j on j.id = c.job_id
      join technicians t on t.id = c.technician_id
      join field_devices d on d.id = c.device_id
     where (${unresolvedOnly} = false or c.resolved_at is null)
       and (${jobId}::uuid is null or c.job_id = ${jobId}::uuid)
     order by (c.resolved_at is null) desc, c.raised_at
     limit ${limit}
  `)) as unknown as Row[];

  return rows.map((r) => ({
    id: r.id,
    jobId: r.job_id,
    jobReference: r.job_reference,
    jobTitle: r.job_title,
    jobStatus: r.job_status as JobStatus,
    technicianId: r.technician_id,
    technicianName: r.technician_name,
    deviceLabel: r.device_label,
    clientId: r.client_id,
    kind: r.kind,
    detail: r.detail,
    attempted: r.attempted ?? {},
    serverState: r.server_state ?? {},
    raisedAt: requiredRowDate(r.raised_at),
    resolvedAt: rowDate(r.resolved_at),
    resolution: r.resolution,
  }));
}

/** How many conflicts are waiting for somebody. The number on the board. */
export async function countOpenFieldConflicts(tx: TenantScopedTx): Promise<number> {
  const rows = (await tx.execute<{ open: number }>(sql`
    select count(*)::int as open from field_conflicts where resolved_at is null
  `)) as unknown as { open: number }[];
  return Number(rows[0]?.open ?? 0);
}

/**
 * Close a conflict.
 *
 * ── WHY THIS RECORDS A VERDICT AND DOES NOT ACT ON IT ───────────────────────
 *
 * Resolving says what a person decided; it does not reopen the job, write the
 * outcome or bill the visit. Those are ordinary operations with their own rules
 * — `transitionJob` refuses an illegal reopen, `recordJobOutcome` enforces
 * `JOB-15` — and routing them through a conflict resolver would be a second
 * path into them with none of the checks. The dispatcher resolves the conflict
 * *and* does the work, on the same screen, through the same functions
 * everything else uses.
 */
export async function resolveFieldConflict(
  tx: TenantScopedTx,
  ctx: TenantContext,
  input: { conflictId: string; resolution: "accepted" | "rejected" | "superseded"; note?: string | null },
): Promise<{ resolved: boolean }> {
  if (!["accepted", "rejected", "superseded"].includes(input.resolution)) {
    throw new UserFacingError("A conflict is resolved as accepted, rejected or superseded.");
  }

  const updated = await tx
    .update(schema.fieldConflicts)
    .set({
      resolvedAt: new Date(),
      resolvedById: ctx.userId ?? null,
      resolution: input.resolution,
      resolutionNote: input.note?.trim() || null,
    })
    .where(and(eq(schema.fieldConflicts.id, input.conflictId), sql`resolved_at is null`))
    .returning({ id: schema.fieldConflicts.id });

  const row = updated[0];
  if (!row) return { resolved: false };

  await writeAuditNote(tx, ctx, {
    tableName: "field_conflicts",
    recordId: row.id,
    // 8 characters.
    action: "conflict",
    detail: { resolution: input.resolution, note: input.note ?? null },
  });

  return { resolved: true };
}
