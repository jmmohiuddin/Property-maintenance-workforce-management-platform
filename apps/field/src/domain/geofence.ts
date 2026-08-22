/**
 * Deciding `withinGeofence` for a clock event (`TECH-8`).
 *
 * ── THE SERVER TRUSTS THE DEVICE HERE, WHICH IS UNUSUAL ─────────────────────
 *
 * `attendance_events.within_geofence` (`packages/db/src/schema/workforce.ts`)
 * is a plain nullable boolean column with no site reference anywhere on the
 * table - its own comment is "False when the position falls outside the site
 * geofence", and nowhere does the schema say which site. `recordFieldAttendance`
 * (`packages/db/src/domain/field.ts`, ~line 1816) takes `withinGeofence`
 * straight out of the mutation payload and stores it verbatim; it does not
 * recompute it against a stored geofence of its own. So this decision is made
 * once, on the device, at the moment of the event, and the office receives the
 * device's answer rather than a server-checked fact - worth knowing before
 * anyone leans on this column in a dispute.
 *
 * ── WHICH SITE, WHEN ATTENDANCE HAS NO JOB OF ITS OWN ───────────────────────
 *
 * `attendance/append` carries no required job or property - `payloads.test.ts`
 * asserts exactly that ("a shift event belongs to no job") - because
 * `shift_in` / `shift_out` / `break_start` / `break_end` are day-level events,
 * not per-visit ones. So there is no single authoritative "the" property to
 * check against, the way a photograph has "the" job it was taken on. What the
 * device does have is the working set: the properties of the jobs assigned to
 * this technician today (`working-set.ts`), already the only properties the
 * local `properties` table holds. `evaluateGeofence` below checks the captured
 * point against all of them and answers true if it falls within radius of
 * *any* one - a technician clocking in standing at whichever of today's jobs
 * they went to first reads as within geofence; a technician clocking in from
 * home, nowhere near any of them, reads as outside it.
 *
 * `null` - unknown - is a third, deliberate answer, produced by two different
 * situations that must not collapse into `false`: no position was captured
 * (permission refused, or no fix), or none of today's properties carry
 * coordinates to compare against (a property synced before it had a geocode,
 * say). `false` says "recorded, and not near a job property"; `null` says
 * "not evaluated", and a payroll report reading this column needs to be able
 * to tell those apart.
 */

export interface GeofencePoint {
  readonly lat: number;
  readonly lng: number;
}

export interface GeofenceSite {
  readonly lat: number | null;
  readonly lng: number | null;
}

/**
 * A generous radius, not a tight one, and that is deliberate: this feeds an
 * attendance record a payroll dispute may be argued from, not an access
 * control - nothing in `recordFieldAttendance` refuses a clock event for
 * being outside it. A false "outside geofence" (a wide site, a 15-metre GPS
 * fix at the edge of a car park) costs an unfair mark against a technician who
 * did nothing wrong; a false "inside" costs nothing. Tune from real devices
 * once there are any to measure - this number is a starting judgement, not a
 * measurement.
 */
export const GEOFENCE_RADIUS_METRES = 250;

const EARTH_RADIUS_METRES = 6_371_000;

/** Great-circle distance between two points, in metres (haversine). */
export function haversineMetres(a: GeofencePoint, b: GeofencePoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_METRES * c;
}

/**
 * `null` means unknown and is never coerced to `false`. See the header for
 * the two situations that produce it: no captured point, or no site with
 * usable coordinates.
 */
export function evaluateGeofence(
  point: GeofencePoint | null,
  sites: readonly GeofenceSite[],
  radiusMetres: number = GEOFENCE_RADIUS_METRES,
): boolean | null {
  if (!point) return null;
  const usable: GeofencePoint[] = [];
  for (const site of sites) {
    if (site.lat !== null && site.lng !== null) usable.push({ lat: site.lat, lng: site.lng });
  }
  if (usable.length === 0) return null;
  return usable.some((site) => haversineMetres(point, site) <= radiusMetres);
}
