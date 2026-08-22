import { NextResponse } from "next/server";
import type { TenantContext } from "@meridian/db";
import { UserFacingError } from "@meridian/core";
import { completeStagedUpload } from "@/lib/uploads";
import { withDevice, readJson, fieldError } from "../../_device";
import { requireOwnUpload } from "../_upload";

/**
 * `POST /api/field/v1/uploads/complete` (TRD §8.5, §8.6).
 *
 * Assemble, verify, extract EXIF into columns, compress, strip metadata, store,
 * and queue the virus scan — none of which happens here. Every one of those
 * steps is `completeStagedUpload` in `lib/uploads.ts`, and the order they
 * happen in is the specification: verify the parts before storing, because a
 * missing middle chunk assembles into a perfectly valid, permanently truncated
 * JPEG that nothing downstream would ever question; extract EXIF before
 * stripping it, because the compression step destroys it, which is exactly what
 * makes it worthless as evidence and exactly why it belongs in a column
 * (§8.6).
 *
 * ── WHY THIS ROUTE IS FLAT AND THE STAFF ONE IS NESTED ──────────────────────
 *
 * §8.5 names `POST /api/field/v1/uploads/complete` with no id in the path, and
 * the field client is written against that. The staff equivalent is
 * `/api/uploads/{id}/complete`. Both call the same function; the id arrives in
 * the body here and in the path there. Making the field app use the staff
 * spelling would have been a change to a spec-conformant client for no reason
 * other than symmetry.
 *
 * ── WHY THE SCAN IS NOT WAITED FOR ──────────────────────────────────────────
 *
 * The finished object is handed to `/api/cron/scan` as `pending`. A request
 * that blocks on a virus daemon is a request that times out on a phone in a car
 * park — and the technician has already left the site by the time it would
 * finish. `scanStatus` comes back in the response so the app never presents an
 * unscanned photograph as cleared.
 *
 * Safe to call twice: a completed session returns itself rather than storing a
 * second object.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  // Two phases, and they cannot share one transaction. `completeStagedUpload`
  // opens its own, and deliberately performs the object-store write *outside*
  // it: objects are write-once (`OPS-6`), so a `put()` inside a transaction
  // that then rolls back leaves an unreferenced object at a key that can never
  // be rewritten, and every retry afterwards fails forever.
  //
  // So `withDevice` is used for the authenticated ownership check, and the
  // completion runs after it with the context that check produced.
  let authorised: { ctx: TenantContext; uploadId: string } | null = null;

  const refusal = await withDevice(request, async ({ tx, ctx, device }) => {
    const body = await readJson(request);
    const uploadId = String(body["uploadId"] ?? body["upload_id"] ?? "").trim();
    if (!uploadId) throw new UserFacingError("This request did not say which upload to finish.");

    await requireOwnUpload(tx, uploadId, device.technicianId);
    authorised = { ctx, uploadId };
    return { authorised: true };
  });

  // `withDevice` answered instead of the handler — an unknown token, a revoked
  // device, an upload that is not this technician's. Its response is the answer.
  if (!authorised) return refusal;

  const { ctx, uploadId } = authorised as { ctx: TenantContext; uploadId: string };
  const outcome = await completeStagedUpload(ctx, uploadId);

  if (!outcome.ok) {
    // `completeStagedUpload` answers in plain text, which is right for the
    // staff routes and wrong for a client that parses JSON and shows the
    // message to a technician. Translated rather than forwarded.
    const detail = await outcome.response.text().catch(() => "");
    return fieldError(
      "upload_refused",
      detail.trim() || "This upload could not be finished. The phone will try again.",
      outcome.response.status,
    );
  }

  const { session } = outcome.result;

  // `storageKey` is deliberately absent, exactly as `sessionResponse` omits it:
  // `SEC-8` has no public URLs and no route hands out a location. The device
  // cites the upload by its id when it files the attachment mutation, and the
  // sync layer resolves the key server-side.
  return NextResponse.json({
    uploadId: session.sessionId,
    clientUploadId: session.clientUploadId,
    status: session.status,
    contentType: session.contentType,
    sizeBytes: session.sizeBytes,
    sha256: session.sha256,
    // Never assumed clean. The app must not present an unscanned photograph as
    // cleared, so the state travels with the response.
    scanStatus: session.scanStatus,
    capturedAt: session.capturedAt,
    capturedLat: session.capturedLat,
    capturedLon: session.capturedLon,
    orientation: session.orientation,
    metadataStripped: session.metadataStripped,
    compression: session.compression,
    note: session.processingNote,
    serverReceivedAt: new Date().toISOString(),
  });
}
