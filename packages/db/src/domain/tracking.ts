import { sql } from "drizzle-orm";
import type { TenantScopedTx, TenantContext } from "../index";
import { UserFacingError } from "@meridian/core";

/**
 * `CUST-3` / `EMG-5`. The write half of live technician tracking.
 *
 * ── WHAT THIS FILE IS, AND WHAT IT REFUSES TO BE ────────────────────────────
 *
 * `technician_locations` is the most sensitive table in this schema. It is a
 * continuous record of where an identifiable employee physically was, and the
 * feature built on it shows some of that to a member of the public. So the
 * shape of this file matters more than its size:
 *
 *   * It is the ONLY writer. There is no second path that appends a position,
 *     and there must not be — the read side's guarantees are stated in terms of
 *     the visit record, and a writer that invents its own rules about which
 *     pings exist would undermine them from below.
 *   * It writes a position and NOTHING derived from one. No "current area", no
 *     denormalised distance to a job, no last-seen column on `technicians`.
 *     Every one of those would be a copy of this data outside the retention
 *     rule that governs it (`purgeLocationTraces`, `FLD-16`), and a copy is
 *     what makes a retention window a claim rather than a fact.
 *   * It tells the caller whether the ping it just accepted is CUSTOMER-VISIBLE
 *     (see `sharedWithCustomer` below). That is not a convenience. A feature
 *     that shows a person's location to somebody else and does not tell them
 *     when it is doing so is surveillance, whatever the requirement calls it.
 *
 * ── WHAT IS NOT DECIDED HERE ────────────────────────────────────────────────
 *
 * WHEN a handset captures. That is the device's decision and it belongs in the
 * field application: whether it samples on shift only, what it does at rest,
 * and what the technician is shown while it is running. This function accepts
 * what it is given and records it, and every rule about who may READ it back
 * lives in the RESTRICTIVE `customer_scope` policy on the table in
 * `sql/customer-scope.sql`. Neither of those boundaries is enforced here, and
 * that is deliberate — a check in this function would be one an offline batch,
 * a backfill or the next writer could go around.
 */

// ── Sanity bounds ────────────────────────────────────────────────────────────

/**
 * Reject rather than clamp, and reject the whole ping rather than the field.
 *
 * A latitude of 91 is not a technician slightly off the edge of the world; it
 * is a device sending garbage, and the useful thing to do with garbage is to
 * not have it in the table. Clamping to 90 would store a plausible-looking
 * position in the Arctic and a customer would be shown an ETA derived from it.
 *
 * `(0, 0)` is refused by name. It is Null Island — the value a GPS API returns
 * when it has no fix and the caller did not check — and it is the single most
 * common false position in any location dataset. A technician cannot be there.
 */
function assertPlausible(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new UserFacingError("That position is not a number");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new UserFacingError("That position is not on Earth");
  }
  if (lat === 0 && lng === 0) {
    throw new UserFacingError("That position is a GPS fix that never arrived");
  }
}

export interface TechnicianPing {
  readonly technicianId: string;
  readonly lat: number;
  readonly lng: number;
  /** Degrees clockwise from north. Null when the device is stationary. */
  readonly headingDegrees?: number | null;
  readonly speedKph?: number | null;
  readonly batteryPercent?: number | null;
  /**
   * The device's own capture instant, not the moment the server saw it.
   *
   * This is what makes an offline batch mean anything: forty pings flushed in
   * one request describe forty different moments, and stamping them all with
   * `now()` would draw a van teleporting across the city at the instant it
   * regained signal. It is also the unique key, so a replayed batch collides
   * with itself and inserts nothing.
   */
  readonly recordedAt: Date;
}

export interface TechnicianPingOutcome {
  /** Rows actually inserted. Lower than the batch size means a replay. */
  readonly recorded: number;
  /**
   * Whether these pings are currently readable by a customer, and which one.
   *
   * Answered by asking the same question the RLS policy asks — is there a live
   * `en_route` or `arrived` visit for this technician — so the handset can say
   * "your location is being shared with <customer>" and, just as importantly,
   * stop saying it the moment the visit closes. Null means the position went
   * into the table and no customer can see it.
   *
   * The customer's NAME, not their address or their job: the technician needs
   * to know who is watching, not to be handed the customer record.
   */
  readonly sharedWithCustomer: { readonly customerName: string; readonly visitId: string } | null;
}

/**
 * Record one or more positions for a technician.
 *
 * Runs on a STAFF transaction (`withTenant`). A portal session cannot reach
 * this: the policy's write check is the staff test, so the insert would be
 * refused by the database even if a route were wired to it by mistake.
 *
 * Idempotent by natural key — see the unique index in `0039`. A batch the
 * device sends twice records the same rows once, and `recorded` reports the
 * difference so a sync log can tell a replay from a fresh flush.
 */
export async function recordTechnicianPing(
  tx: TenantScopedTx,
  ctx: TenantContext,
  pings: readonly TechnicianPing[],
): Promise<TechnicianPingOutcome> {
  if (pings.length === 0) return { recorded: 0, sharedWithCustomer: null };

  const technicianIds = new Set(pings.map((p) => p.technicianId));
  if (technicianIds.size !== 1) {
    // One device, one technician. A mixed batch would make the visibility
    // answer below meaningless, and there is no legitimate caller that has one.
    throw new UserFacingError("A batch of positions must be for one technician");
  }
  const technicianId = pings[0]!.technicianId;

  for (const ping of pings) assertPlausible(ping.lat, ping.lng);

  const values = pings.map(
    (p) => sql`(
      ${ctx.tenantId}::uuid,
      ${p.technicianId}::uuid,
      ${p.lat}::double precision,
      ${p.lng}::double precision,
      ${p.headingDegrees ?? null}::integer,
      ${p.speedKph ?? null}::integer,
      ${p.batteryPercent ?? null}::smallint,
      ${p.recordedAt.toISOString()}::timestamptz
    )`,
  );

  const inserted = (await tx.execute<{ id: string }>(sql`
    insert into technician_locations
      (tenant_id, technician_id, lat, lng, heading_degrees, speed_kph, battery_percent, recorded_at)
    values ${sql.join(values, sql`, `)}
    on conflict (tenant_id, technician_id, recorded_at) do nothing
    returning id
  `)) as unknown as { id: string }[];

  return {
    recorded: inserted.length,
    sharedWithCustomer: await currentTrackingAudience(tx, technicianId),
  };
}

/**
 * Who, if anyone, can see this technician's position right now.
 *
 * ── WHY THIS RESTATES THE POLICY INSTEAD OF READING IT ──────────────────────
 *
 * It cannot read it. This runs on a staff transaction, where
 * `app_current_customer()` is unset and the `customer_scope` policy on
 * `technician_locations` is therefore satisfied by every row — which is correct
 * for staff and useless for answering "is a customer watching". So the state
 * half of the policy (a live `en_route` or `arrived` visit) is asked here
 * directly, of `job_visits`, which is the table the policy asks about too.
 *
 * The interval half — the ping timestamps — is deliberately NOT restated. It
 * answers a different question: the policy decides which of the rows already in
 * the table a customer may read, and this decides whether the technician is
 * currently inside a window at all. Restating it would mean answering "is
 * anyone watching" with "were they watching the row you just wrote", which is
 * the same answer only by coincidence and would go wrong for the first ping of
 * a visit.
 *
 * Ordered by `en_route_at` and limited to one. Two live visits for the same
 * technician is a dispatch mistake rather than a state to model, and the
 * earliest one is the one they are actually on.
 */
async function currentTrackingAudience(
  tx: TenantScopedTx,
  technicianId: string,
): Promise<{ customerName: string; visitId: string } | null> {
  const rows = (await tx.execute<{ visit_id: string; customer_name: string }>(sql`
    select v.id as visit_id, c.name as customer_name
      from job_visits v
      join jobs j on j.id = v.job_id and j.deleted_at is null
      join customers c on c.id = j.customer_id
     where v.technician_id = ${technicianId}
       and v.status in ('en_route', 'arrived')
       and v.en_route_at is not null
       and v.en_route_at > now() - interval '12 hours'
     order by v.en_route_at asc
     limit 1
  `)) as unknown as { visit_id: string; customer_name: string }[];

  const row = rows[0];
  return row ? { customerName: row.customer_name, visitId: row.visit_id } : null;
}
