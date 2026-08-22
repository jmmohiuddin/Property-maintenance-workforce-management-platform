import "server-only";
import { sql } from "drizzle-orm";
import { getUpload, type UploadSessionView } from "@meridian/db/domain";
import type { TenantScopedTx } from "@meridian/db";
import { UserFacingError } from "@meridian/core";

/**
 * The field app's half of the upload contract (TRD §8.5, §8.6).
 *
 * ── WHAT IS NOT HERE, AND WHY THAT IS THE POINT ─────────────────────────────
 *
 * No chunking. No assembly. No hashing, no EXIF extraction, no compression, no
 * store write. All of that is `packages/db/src/domain/uploads.ts` and
 * `apps/web/src/lib/uploads.ts`, built by the media agent, and the field routes
 * are a **second door onto those functions** rather than a second
 * implementation of them.
 *
 * The split exists because §8.5 puts media upload on `/api/field/v1` while the
 * transport needs no knowledge of who is calling: the transport is theirs, the
 * door is `SEC-7` device authentication, which is this API's. A second chunking
 * implementation would be a second place for the "missing middle chunk
 * assembles into a valid, permanently truncated JPEG" bug to live, and only one
 * of the two would have the test that catches it.
 *
 * ── WHAT THIS FILE DOES ADD ─────────────────────────────────────────────────
 *
 * The one narrowing the staff routes cannot express: an upload from a handset
 * must be for a job **assigned to that technician**. `authoriseUpload` in
 * `lib/uploads.ts` checks a staff permission, which is the right question for
 * the office and the wrong one here — every technician holds `jobs:update`, so
 * permission alone would let any handset attach a photograph to any job in the
 * tenant. Same distinction as `requireJobForTechnician` in the sync path, and
 * for the same reason: RLS gives the tenant boundary, not this one.
 */

/** What a handset may upload. `candidate_document` is deliberately absent. */
export const FIELD_UPLOAD_PURPOSES = ["job_photo", "job_signature"] as const;
export type FieldUploadPurpose = (typeof FIELD_UPLOAD_PURPOSES)[number];

export function isFieldUploadPurpose(value: string): value is FieldUploadPurpose {
  return (FIELD_UPLOAD_PURPOSES as readonly string[]).includes(value);
}

/**
 * The job exists, and this technician is on it.
 *
 * Identical in shape and message to the sync path's check, on purpose: a device
 * that can tell "no such job" from "not yours" can enumerate the board, and two
 * endpoints that answer that question differently is how one of them ends up
 * being the one people use.
 */
export async function requireJobForDevice(
  tx: TenantScopedTx,
  jobId: string,
  technicianId: string,
): Promise<void> {
  const rows = (await tx.execute<{ id: string }>(sql`
    select j.id
      from jobs j
     where j.id = ${jobId}::uuid
       and j.deleted_at is null
       and exists (
         select 1 from job_visits v
          where v.job_id = j.id and v.technician_id = ${technicianId}::uuid
       )
     limit 1
  `)) as unknown as { id: string }[];

  if (!rows[0]) throw new UserFacingError("That job is not assigned to you.");
}

/**
 * Load an upload session and prove it belongs to this technician's work.
 *
 * The job id is read from the session row's `reference`, never from the
 * request. That is the same reasoning `authoriseExistingUpload` gives for
 * reading the *purpose* from the row: a caller who may finish their own upload
 * must not be able to finish somebody else's by naming a different id.
 */
export async function requireOwnUpload(
  tx: TenantScopedTx,
  sessionId: string,
  technicianId: string,
): Promise<UploadSessionView> {
  // RLS returns nothing for both "no such session" and "another tenant's", so
  // the two are one answer here as well.
  const session = await getUpload(tx, sessionId).catch(() => null);
  if (!session) throw new UserFacingError("There is no such upload.");

  if (!isFieldUploadPurpose(session.purpose)) {
    throw new UserFacingError("This upload was not started from a phone.");
  }
  if (!session.reference) {
    // Every field upload names its job at init. A session without one predates
    // this route or was opened by something else, and finishing it here would
    // attach a file to work nobody has checked.
    throw new UserFacingError("This upload is not attached to a job.");
  }

  await requireJobForDevice(tx, session.reference, technicianId);
  return session;
}
