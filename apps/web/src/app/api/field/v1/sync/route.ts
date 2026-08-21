import { pullWorkingSet, FIELD_WORKING_SET } from "@meridian/db/domain";
import { withDevice } from "../_device";

/**
 * `GET /api/field/v1/sync?cursor=<watermark>` (TRD §8.2, §8.3, §8.5).
 *
 * The pull half of the protocol. Returns the declared working set — this
 * technician's jobs for today and tomorrow plus anything of theirs still open,
 * the customers, properties and plant those touch, the taxonomies, the rate
 * card and their own certifications — filtered to what has changed since the
 * cursor the device sends back.
 *
 * ── THE KEYS ARE camelCase, AND §8.5 SPELLS THEM snake_case ─────────────────
 *
 * §8.5 writes `{ …, next_cursor, server_time }`. This route sends `nextCursor`
 * and `serverTime`, and the difference is recorded here rather than left for
 * somebody to discover with a parse failure.
 *
 * It is not the spelling that was reasoned about — it is the spelling both
 * halves of the protocol already speak. `apps/field/src/sync/protocol.ts` is
 * transcribed from these handlers and lists the divergence as its first
 * deviation from the specification. Changing it now would cost a second round
 * of churn across a client that has already conformed, in exchange for nothing
 * a technician could notice. The record is what matters, and the record is
 * accurate on both sides.
 *
 * On the way *in*, both spellings are accepted. Tolerating a spelling costs
 * nothing and cannot be wrong; refusing one is a 400 that a technician reads as
 * "sync failed", with no path to a fix from where they are standing.
 *
 * The record bodies inside each collection keep the domain layer's own field
 * names. The client stores them opaquely and reads what it knows, so
 * enumerating them on the wire would put a second copy of the schema somewhere
 * that cannot be migrated.
 *
 * ── WHY `serverTime` IS IN THE RESPONSE ─────────────────────────────────────
 *
 * §8.5 states it plainly: "so the device can detect and report clock divergence
 * rather than silently recording a wrong timestamp". The field client measures
 * its skew from this value and its own send and receive instants, which is a
 * better measurement than a header could give because it brackets the round
 * trip.
 *
 * ── WHY `taxonomies` IS OMITTED RATHER THAN SENT EMPTY ──────────────────────
 *
 * Absent means "unchanged since your cursor, keep what you have". An empty
 * object would mean "there are none", and a client that took the second reading
 * of the first would blank a technician's fault-code picker mid-shift. Omitting
 * the key is the only spelling of "no news" that cannot be misread as "no
 * data", and it is what every other collection in this response does too.
 *
 * ── AND WHY THE RESPONSE NAMES WHAT IT DOES NOT CARRY ───────────────────────
 *
 * `unavailableOffline` and `notYetAvailable` are lists of things the phone
 * does *not* hold, each with the sentence the screen shows. §8.2's second half
 * asks for exactly this: an empty state that looks like "no data" is worse than
 * a refusal, because a technician who opens the invoice for a job and sees
 * nothing concludes there is no invoice and tells the customer so.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request) {
  return withDevice(request, async ({ tx, device }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const horizonRaw = url.searchParams.get("horizonDays");
    const horizonDays = horizonRaw === null ? undefined : Number(horizonRaw);

    const page = await pullWorkingSet(tx, {
      technicianId: device.technicianId,
      cursor,
      ...(horizonDays !== undefined && Number.isFinite(horizonDays) ? { horizonDays } : {}),
    });

    return {
      serverTime: page.serverTime.toISOString(),
      nextCursor: page.nextCursor,
      // A truncated pull means the device should come straight back rather than
      // waiting for its next scheduled sync. Saying so is cheaper than making
      // the client infer it from a full page.
      truncated: page.truncated,
      complete: page.complete,
      jobs: page.jobs,
      customers: page.customers,
      properties: page.properties,
      assets: page.assets,
      certifications: page.certifications,
      ...(page.taxonomies
        ? {
            taxonomies: {
              faultCodes: page.taxonomies.faultCodes,
              outcomeCodes: page.taxonomies.outcomeCodes,
              photoExemptionReasons: page.taxonomies.photoExemptionReasons,
              rateCard: page.taxonomies.rateCard,
            },
          }
        : {}),
      /**
       * The authoritative membership of the working set, not a tombstone list.
       *
       * A delta protocol cannot express deletion — "absent from a delta" and
       * "unchanged" are the same thing — so something has to say what has
       * fallen out. Sending every id in scope on every pull says it without a
       * tombstone table, without a retention policy for tombstones, and
       * without the failure mode where a device offline longer than the
       * tombstone window silently keeps a job it should have dropped. It is
       * only affordable because the working set is bounded (§8.2), which is
       * the same property everything else here depends on.
       *
       * The client computes its removals as "what I hold, minus this".
       */
      scope: page.scope,
      manifest: FIELD_WORKING_SET,
      unavailableOffline: page.unavailableOffline,
      notYetAvailable: page.notYetAvailable,
      device: { id: device.deviceId, label: device.label, technicianId: device.technicianId },
    };
  });
}
