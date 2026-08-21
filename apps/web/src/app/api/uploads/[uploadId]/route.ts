import { abortUpload } from "@meridian/db/domain";
import { authoriseExistingUpload, inTenant, sessionResponse, uploadRefusal } from "@/lib/uploads";

/**
 * Where an upload has got to, and giving up on one.
 *
 * `GET` is the resumption call: after a dropped connection the client asks what
 * is still missing and sends only that. It is the reason a 12 MB photograph
 * survives a link that never once stays up long enough to carry it.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const { uploadId } = await params;
  const auth = await authoriseExistingUpload(uploadId);
  if (!auth.ok) return auth.response;

  return sessionResponse(auth.session!);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ uploadId: string }> },
): Promise<Response> {
  const { uploadId } = await params;
  const auth = await authoriseExistingUpload(uploadId);
  if (!auth.ok) return auth.response;

  const aborted = await inTenant(auth.ctx, (tx) =>
    abortUpload(tx, uploadId, "Abandoned by the client."),
  );

  // Aborting an upload that was already finished is not an error — it is a
  // client that gave up before it saw the completion it had already earned.
  return uploadRefusal(aborted ? 200 : 409, aborted ? "Upload abandoned." : "This upload is not open.");
}
