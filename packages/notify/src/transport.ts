import type { RenderedMessage } from "./templates";

/**
 * Transports.
 *
 * A transport does exactly one thing: hand a rendered message to a provider and
 * report what happened. It does not decide whether to send, does not retry, and
 * does not touch the ledger - all of that is the dispatcher's job, so that
 * swapping providers cannot change delivery semantics.
 *
 * ⚠️ NO REAL PROVIDER IS WIRED UP.
 *
 * The default is `ConsoleTransport`, which logs and reports success. That is
 * deliberate and it is stated loudly here, in the ledger, and in the launch
 * checklist, because a notification system that silently does nothing is worse
 * than none at all: the ledger says "sent", the customer never hears from you,
 * and nobody finds out until they complain.
 *
 * To go live, implement this interface against a provider and pass it to
 * `dispatchPending`. The pipeline around it needs no changes.
 */

export type Channel = "email" | "sms" | "whatsapp" | "push" | "in_app";

export interface DeliveryRequest {
  readonly channel: Channel;
  readonly to: string;
  readonly message: RenderedMessage;
  /** Stable per notification. Providers that support it should use it to dedupe. */
  readonly idempotencyKey: string;
}

export type DeliveryResult =
  | { readonly ok: true; readonly providerMessageId?: string | undefined }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };

export interface Transport {
  readonly name: string;
  supports(channel: Channel): boolean;
  send(request: DeliveryRequest): Promise<DeliveryResult>;
}

/**
 * Logs instead of sending. The default, and the only transport in the repo.
 *
 * Reports success so the pipeline can be exercised end to end, and stamps the
 * provider id with a `console:` prefix so a ledger row can never be mistaken
 * for real delivery.
 */
export class ConsoleTransport implements Transport {
  readonly name = "console";

  supports(): boolean {
    return true;
  }

  async send(request: DeliveryRequest): Promise<DeliveryResult> {
    console.info(
      [
        "",
        "┌─ NOTIFICATION (not actually sent) ─────────────────────────────",
        `│ channel : ${request.channel}`,
        `│ to      : ${request.to}`,
        `│ subject : ${request.message.subject}`,
        "├────────────────────────────────────────────────────────────────",
        ...request.message.body.split("\n").map((l) => `│ ${l}`),
        "└────────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
    return { ok: true, providerMessageId: `console:${request.idempotencyKey}` };
  }
}

/**
 * Fails everything. For tests that need to exercise the retry and failure
 * paths without waiting on a real provider timing out.
 */
export class FailingTransport implements Transport {
  readonly name = "failing";
  constructor(private readonly retryable = true) {}
  supports(): boolean {
    return true;
  }
  async send(): Promise<DeliveryResult> {
    return { ok: false, error: "Simulated provider failure", retryable: this.retryable };
  }
}
