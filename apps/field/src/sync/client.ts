/**
 * The transport.
 *
 * Thin on purpose. Everything that decides anything - what to send, in what
 * order, what a refusal means - lives in `engine.ts` and `conflicts.ts` where
 * it can be tested without a network. This module builds a request, applies a
 * timeout, parses the response, takes a clock reading, and hands over a rotated
 * device token if one came back.
 *
 * ── ERRORS ARE CLASSIFIED, BECAUSE THE RETRY RULES DIFFER ──────────────────
 *
 * `NetworkError`   the request did not arrive. Retry for ever; this is a
 *                  technician in a basement and it is the normal case.
 * `DeviceAuthError` the device is not signed in. Retrying cannot help. Whether
 *                  the stored token must be *destroyed* depends on the code -
 *                  see `clearsStoredToken` below.
 * `ServerError`    5xx. Retry with backoff - the office's problem, not theirs.
 * `RefusedError`   400 `refused`: the domain refused this request and will
 *                  refuse it again. Do not retry; show it.
 * `ProtocolError`  the response is unreadable by this build. Do not retry.
 *
 * Collapsing these into "request failed" is what produces a queue that retries
 * a revoked device eight times and then declares a day's work dead.
 *
 * ── TOKEN ROTATION IS A CORRECTNESS PROBLEM, NOT A DETAIL ──────────────────
 *
 * `_device.ts` rotates a token that has aged, returns the new one in the
 * response body, and keeps the old one working for ten minutes. If the client
 * does not persist the new token the handset falls back on its grace window and
 * then locks itself out - so `onDeviceToken` is called before the response body
 * is handed to the caller, and its failure is not swallowed.
 *
 * **This client has not been run against the real routes.** The shapes are
 * transcribed from them; nothing has exercised them over a network.
 */

import {
  APP_VERSION_HEADER,
  DEVICE_TIME_HEADER,
  MAX_BATCH,
  MUTATIONS_PATH,
  SYNC_PATH,
  UPLOAD_COMPLETE_PATH,
  UPLOAD_INIT_PATH,
  ProtocolError,
  parseErrorEnvelope,
  parseMutationResponse,
  parseSyncResponse,
  parseUploadChunkResponse,
  parseUploadCompleteResponse,
  parseUploadInitResponse,
  uploadChunkPath,
  type DeviceToken,
  type FieldErrorCode,
  type MutationBatchRequest,
  type MutationResponse,
  type SyncResponse,
  type UploadChunkResponse,
  type UploadInitRequest,
  type UploadInitResponse,
  type UploadCompleteResponse,
} from "./protocol";
import { observeSkew, type ClockSources, type SkewObservation } from "../domain/clock";

export class NetworkError extends Error {
  constructor(override readonly cause: unknown) {
    super("No connection to the office.");
    this.name = "NetworkError";
  }
}

export class DeviceAuthError extends Error {
  constructor(
    readonly code: FieldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DeviceAuthError";
  }

  /**
   * A revoked device's token is dead and keeping it means every subsequent
   * request replays a retired credential - which `_device.ts` treats as theft
   * and responds to by revoking again. An *expired* device's token is merely
   * old, and clearing it loses nothing but also gains nothing, so it is left
   * alone and the technician is asked to sign in.
   */
  get clearsStoredToken(): boolean {
    return this.code === "device_revoked";
  }
}

/** The domain refused this specific request. It will refuse it again. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ServerError";
  }
}

export interface FieldApiConfig {
  readonly baseUrl: string;
  /** The device token, or null when this handset has never registered. */
  readonly getDeviceToken: () => Promise<string | null>;
  /** Persist a rotated token. Must not resolve until it is durably stored. */
  readonly onDeviceToken: (token: DeviceToken) => Promise<void>;
  readonly appVersion: string;
  readonly clock: ClockSources;
  /**
   * 30 seconds. Long enough for a genuinely slow cell link to complete a
   * 200-mutation batch, short enough that a captive portal - a hotel wifi that
   * accepts the TCP connection and never answers - does not hold the queue for
   * minutes. Captive portals are the specific failure this defends against;
   * they are common on exactly the sites this app is used on.
   */
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface SyncResult<T> {
  readonly data: T;
  /**
   * The client's own estimate, from the round-trip midpoint. The server also
   * returns its measurement as `clockSkewMs`; both are kept because they
   * disagree usefully - the server's is measured against the header the device
   * sent, so a device lying about its time shows up as agreement between two
   * wrong numbers, and the round-trip estimate does not depend on that header.
   */
  readonly skew: SkewObservation | null;
}

export class FieldApiClient {
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: FieldApiConfig) {
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.doFetch = config.fetchImpl ?? fetch;
  }

  async pull(cursor: string | null): Promise<SyncResult<SyncResponse>> {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const { raw, sent, received } = await this.request("GET", `${SYNC_PATH}${query}`, undefined);
    const data = parseSyncResponse(raw);
    if (data.deviceToken) await this.config.onDeviceToken(data.deviceToken);
    return { data, skew: this.skewFrom(sent, received, data.serverTime) };
  }

  /**
   * Push a batch.
   *
   * The batch cap is enforced here as well as on the server. The server refuses
   * an oversized batch outright rather than truncating it, so a client that
   * sends 300 rows loses the whole request - and the technician sees "sync
   * failed" for a reason that is entirely the app's fault.
   */
  async push(
    batchId: string,
    mutations: MutationBatchRequest["mutations"],
  ): Promise<SyncResult<MutationResponse>> {
    if (mutations.length > MAX_BATCH) {
      throw new RefusedError(
        `This app tried to send ${mutations.length} records at once; the office accepts ${MAX_BATCH}.`,
      );
    }

    // `Idempotency-Key` is **advisory and unvalidated**: the real key is the
    // per-mutation `clientId`, deduplicated in `field_mutations` on
    // `(tenant_id, client_id)`. An earlier version of this client sent the
    // header only on a single-mutation request, to dodge a server check that
    // refused a header/body mismatch. That check has been removed - it turned a
    // specification ambiguity into a runtime failure on every single-item
    // drain - so a batch id goes on every request and identifies the *request*,
    // which is what the header is for.
    const { raw, sent, received } = await this.request("POST", MUTATIONS_PATH, { mutations }, {
      "Idempotency-Key": batchId,
    });

    const data = parseMutationResponse(raw);
    if (data.deviceToken) await this.config.onDeviceToken(data.deviceToken);
    return { data, skew: this.skewFrom(sent, received, data.serverTime) };
  }

  /**
   * Open (or resume) an upload.
   *
   * Idempotent on `clientUploadId`: a retried init returns the same upload
   * with `reused: true` and, more usefully, a `receivedChunks` list that is
   * **recounted rather than remembered**. Resumption after a dead battery
   * therefore costs the chunks actually lost rather than the file.
   */
  async initUpload(request: UploadInitRequest): Promise<UploadInitResponse> {
    const { raw } = await this.request("POST", UPLOAD_INIT_PATH, request, {
      "Idempotency-Key": request.clientUploadId,
    });
    return parseUploadInitResponse(raw);
  }

  /**
   * Send one chunk.
   *
   * ── THE `sameOrigin` BRANCH IS A CREDENTIAL DECISION ───────────────────────
   *
   * A presigned URL points at a third-party storage host and **must not**
   * carry the device token - sending it there would leak the handset's
   * credential to somebody else's server. These chunk URLs are not presigned:
   * chunks are stored as `bytea` rows because `ObjectStore.put()` sniffs
   * content and would refuse the middle 512 KB of a JPEG, so there is nothing
   * to presign a URL to, and the request goes to this server and **must**
   * carry the token.
   *
   * Both are correct and the difference is invisible in the URL, which is why
   * the server sends `sameOrigin` rather than leaving it to be inferred. The
   * flag is honoured here and never assumed either way.
   */
  async putChunk(input: {
    readonly uploadId: string;
    readonly index: number;
    readonly bytes: ArrayBuffer | Uint8Array;
    readonly url?: string;
    readonly sameOrigin: boolean;
  }): Promise<UploadChunkResponse> {
    const path = uploadChunkPath(input.uploadId, input.index);

    if (!input.sameOrigin && input.url) {
      // A genuine presigned URL: absolute, no token, no JSON body.
      await this.putPresigned(input.url, input.bytes);
      return {
        uploadId: input.uploadId,
        chunkIndex: input.index,
        duplicate: false,
        receivedChunks: [],
        chunkCount: 0,
        complete: false,
      };
    }

    const token = await this.config.getDeviceToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.doFetch(`${this.config.baseUrl}${path}`, {
        method: "PUT",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/octet-stream",
          [APP_VERSION_HEADER]: this.config.appVersion,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: input.bytes as BodyInit,
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(error);
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 401 || response.status === 403) {
      const envelope = parseErrorEnvelope(await safeJson(response));
      throw new DeviceAuthError(envelope.code, envelope.message);
    }
    if (!response.ok) {
      const envelope = parseErrorEnvelope(await safeJson(response));
      throw new ServerError(response.status, envelope.message);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new ProtocolError(path, `response was not JSON (${String(error)})`);
    }
    return parseUploadChunkResponse(raw, path);
  }

  /**
   * Finish the upload.
   *
   * The response is where the device **stops guessing**: `contentType` was
   * sniffed from the bytes, and `capturedAt`, the coordinates and
   * `orientation` were extracted from the image's own EXIF into columns. The
   * phone's values are ignored, which is correct - it only ever guessed.
   *
   * `scanStatus` comes back `pending`. Nothing may present an unscanned
   * photograph as cleared.
   */
  async completeUpload(uploadId: string): Promise<UploadCompleteResponse> {
    const { raw } = await this.request("POST", UPLOAD_COMPLETE_PATH, { uploadId }, {
      "Idempotency-Key": uploadId,
    });
    return parseUploadCompleteResponse(raw);
  }

  /**
   * PUT to a genuine presigned URL. **Deliberately carries no device token.**
   *
   * Unused today - every chunk URL the server issues is `sameOrigin` - and
   * kept because the storage arrangement is the kind that changes, and the
   * moment it does, the credential rule has to already be written down.
   */
  private async putPresigned(url: string, bytes: ArrayBuffer | Uint8Array): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.doFetch(url, {
        method: "PUT",
        body: bytes as BodyInit,
        signal: controller.signal,
      });
      if (!response.ok) throw new ServerError(response.status, "A photo chunk could not be uploaded.");
    } catch (error) {
      if (error instanceof ServerError) throw error;
      throw new NetworkError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ raw: unknown; sent: number; received: number }> {
    const token = await this.config.getDeviceToken();
    const sent = this.config.clock.now();

    const headers: Record<string, string> = {
      Accept: "application/json",
      // The server stores the divergence between this and its own clock, so a
      // support call about impossible timestamps has an answer. Sent on every
      // request, not only on sync.
      [DEVICE_TIME_HEADER]: new Date(sent).toISOString(),
      [APP_VERSION_HEADER]: this.config.appVersion,
      ...extraHeaders,
    };
    // `Authorization: Bearer` is the form to keep; the legacy
    // `x-field-device-token` header also works and is not sent.
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.doFetch(`${this.config.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new NetworkError(error);
    } finally {
      clearTimeout(timer);
    }

    const received = this.config.clock.now();

    if (!response.ok) {
      const envelope = parseErrorEnvelope(await safeJson(response));
      if (response.status === 401 || response.status === 403) {
        throw new DeviceAuthError(envelope.code, envelope.message);
      }
      if (response.status === 400 && envelope.code === "refused") {
        throw new RefusedError(envelope.message);
      }
      throw new ServerError(response.status, envelope.message);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch (error) {
      throw new ProtocolError(path, `response was not JSON (${String(error)})`);
    }

    return { raw, sent, received };
  }

  private skewFrom(sent: number, received: number, serverTime: string): SkewObservation | null {
    const parsed = Date.parse(serverTime);
    if (Number.isNaN(parsed)) return null;
    return observeSkew({
      requestSentAtDevice: sent,
      responseReceivedAtDevice: received,
      serverTime: parsed,
    });
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
