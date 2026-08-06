import type { Channel, DeliveryRequest, DeliveryResult, Transport } from "./transport";
import { ConsoleTransport } from "./transport";

/**
 * A real email transport, over HTTP.
 *
 * HTTP rather than SMTP, and no client library, for one reason each:
 *
 *  - SMTP is a conversation across several round trips on a long-lived socket.
 *    On serverless, where the process is frozen between invocations and may be
 *    discarded at any point, that is the wrong shape - each send pays the
 *    handshake again and a frozen process can strand an open connection.
 *  - `fetch` is in the runtime. A provider SDK would add a dependency, a
 *    release cadence and a supply-chain surface to send one POST.
 *
 * The provider is Resend because its send endpoint is a single JSON POST with
 * a native idempotency header. Swapping it means implementing `Transport`
 * again; nothing outside this file knows which provider is in use.
 */

const ENDPOINT = "https://api.resend.com/emails";

/** A provider that has not answered in this long is not about to. */
const TIMEOUT_MS = 10_000;

export interface ResendConfig {
  readonly apiKey: string;
  /** Must be on a domain verified with the provider, or every send is refused. */
  readonly from: string;
  /** Overridable for tests. */
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

export class ResendTransport implements Transport {
  readonly name = "resend";
  private readonly config: Required<ResendConfig>;

  constructor(config: ResendConfig) {
    // Fail at construction, not at send. A transport built without credentials
    // would otherwise burn all five attempts on every queued notification
    // before anyone noticed the key was missing.
    if (!config.apiKey) throw new Error("ResendTransport: apiKey is required");
    if (!config.from) throw new Error("ResendTransport: from address is required");

    this.config = {
      apiKey: config.apiKey,
      from: config.from,
      endpoint: config.endpoint ?? ENDPOINT,
      timeoutMs: config.timeoutMs ?? TIMEOUT_MS,
    };
  }

  /**
   * Email only, and it says so rather than pretending.
   *
   * Returning true for `sms` would make the dispatcher hand over a message this
   * transport cannot deliver, and the ledger would record a provider failure
   * for something that was never a provider problem. Refusing here produces an
   * accurate row: "transport does not support sms".
   */
  supports(channel: Channel): boolean {
    return channel === "email";
  }

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    let response: Response;

    try {
      response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          // The dispatcher can retry after a timeout it could not distinguish
          // from a failure. Without this, "did it send?" becomes "send it
          // again", and the customer gets the same invoice twice.
          "Idempotency-Key": request.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [request.to],
          subject: request.message.subject,
          text: request.message.body,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      // Network failure, DNS, or our own timeout. None of these tell us the
      // message was rejected, so all of them are worth another attempt.
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: `Network failure: ${message}`, retryable: true };
    }

    if (response.ok) {
      const id = await readMessageId(response);
      return { ok: true, ...(id ? { providerMessageId: `resend:${id}` } : {}) };
    }

    const detail = await readError(response);

    return {
      ok: false,
      error: `HTTP ${response.status}: ${detail}`,
      retryable: isRetryableStatus(response.status),
    };
  }
}

/**
 * Which failures are worth trying again.
 *
 * This is the judgement the retry loop depends on. Retrying a permanently
 * rejected address spends five attempts to reach the same answer and delays the
 * moment the ledger tells the truth; giving up on a rate limit throws away a
 * message that would have gone out fine a minute later.
 *
 *  - 408 / 429  timing, not content. Try again.
 *  - 5xx        the provider's problem, and providers recover.
 *  - other 4xx  a bad key, an unverified sender, a malformed address. Every
 *               retry produces the identical rejection, so stop and surface it.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readMessageId(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { id?: string };
    return body.id;
  } catch {
    // A 2xx with an unreadable body still means it was accepted. Losing the
    // provider id costs traceability, not delivery, so it is not a failure.
    return undefined;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const text = await response.text();
    // Cap it: this goes into the ledger's error column and gets read by a human
    // scanning failures, not by a parser.
    return text.slice(0, 500) || response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Pick a transport from the environment.
 *
 * Defaults to the console transport and says so loudly. A notification system
 * that silently does nothing is worse than none at all: the ledger reads
 * "sent", the customer hears nothing, and the first person to find out is the
 * one complaining that nobody called them back.
 */
export function selectTransport(env: NodeJS.ProcessEnv = process.env): Transport {
  const apiKey = env["RESEND_API_KEY"];
  const from = env["NOTIFY_FROM"];

  if (apiKey && from) return new ResendTransport({ apiKey, from });

  // Half-configured is its own failure mode, and a quiet fallback to console
  // would hide it. Name the missing half.
  if (apiKey || from) {
    console.error(
      `[notify] ${apiKey ? "NOTIFY_FROM" : "RESEND_API_KEY"} is not set, so email cannot be sent. ` +
        "Falling back to the console transport: NOTHING WILL REACH A CUSTOMER.",
    );
  } else if (env["NODE_ENV"] === "production") {
    console.error(
      "[notify] No email provider configured. Falling back to the console transport: " +
        "NOTHING WILL REACH A CUSTOMER. Set RESEND_API_KEY and NOTIFY_FROM.",
    );
  }

  return new ConsoleTransport();
}
