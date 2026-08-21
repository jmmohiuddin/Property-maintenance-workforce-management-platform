import { authoriseExistingUpload, completeStagedUpload, sessionResponse } from "@/lib/uploads";

/**
 * Assemble, process and store (TRD §8.5 `uploads/complete`).
 *
 * §8.5 says this call "triggers scan + EXIF extraction", and it does both — the
 * EXIF here and now, into columns, and the scan by handing the finished object
 * to `/api/cron/scan` as `pending`. `ATS-9` wants the scan asynchronous, and it
 * is right to: a request that waits on a virus daemon is a request that times
 * out on a phone in a car park.
 *
 * Safe to call twice. A completed session returns itself rather than storing a
 * second object — see `completeStagedUpload` for why the store write sits
 * outside the transaction and how a retried write recognises its own bytes.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const { uploadId } = await params;
  const auth = await authoriseExistingUpload(uploadId);
  if (!auth.ok) return auth.response;

  const outcome = await completeStagedUpload(auth.ctx, uploadId);
  if (!outcome.ok) return outcome.response;

  return sessionResponse(outcome.result.session);
}
