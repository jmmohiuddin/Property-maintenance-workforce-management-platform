/**
 * Email transport test.
 *
 * Runs against a local stub HTTP server rather than the real provider, because
 * the claims worth making here are about how we treat *their* answers - which
 * failures we retry, which we give up on, what we put in the ledger - and those
 * must be checkable without an API key, a verified domain, or a network.
 *
 *   npm run test --workspace=@meridian/notify
 *
 * Needs no database.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ResendTransport, selectTransport } from "../src/email";
import { ConsoleTransport } from "../src/transport";
import type { DeliveryRequest } from "../src/transport";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

interface Captured {
  auth?: string | undefined;
  idempotencyKey?: string | undefined;
  body?: Record<string, unknown>;
}

/** Replies with whatever the current scenario says, and records the request. */
function stub(): {
  server: Server;
  url: Promise<string>;
  captured: Captured;
  set: (status: number, body: string, delayMs?: number) => void;
} {
  const captured: Captured = {};
  let status = 200;
  let payload = JSON.stringify({ id: "msg_abc123" });
  let delay = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      captured.auth = req.headers["authorization"] as string | undefined;
      captured.idempotencyKey = req.headers["idempotency-key"] as string | undefined;
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        captured.body = {};
      }
      const reply = (): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(payload);
      };
      if (delay > 0) setTimeout(reply, delay);
      else reply();
    });
  });

  const url = new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}/emails`);
    });
  });

  return {
    server,
    url,
    captured,
    set: (s, b, d = 0) => {
      status = s;
      payload = b;
      delay = d;
    },
  };
}

const request: DeliveryRequest = {
  channel: "email",
  to: "fatima@baytower.example",
  idempotencyKey: "notif-0001",
  message: { subject: "Quotation QUO-2026-00007", body: "Line one.\nLine two." },
};

async function main(): Promise<void> {
  const s = stub();
  const endpoint = await s.url;
  const make = (): ResendTransport =>
    new ResendTransport({
      apiKey: "re_test_key",
      from: "Meridian <no-reply@meridianfm.example>",
      endpoint,
      timeoutMs: 1_000,
    });

  // ── Configuration is checked at construction, not at send ────────────────
  let refusedNoKey = false;
  try {
    new ResendTransport({ apiKey: "", from: "a@b.example" });
  } catch {
    refusedNoKey = true;
  }
  checkTrue("a transport with no API key is refused up front", refusedNoKey);

  let refusedNoFrom = false;
  try {
    new ResendTransport({ apiKey: "k", from: "" });
  } catch {
    refusedNoFrom = true;
  }
  checkTrue("and so is one with no from address", refusedNoFrom);

  // ── Channels it cannot serve are declined, not attempted ─────────────────
  const t = make();
  checkTrue("it supports email", t.supports("email"));
  checkTrue("but not sms", !t.supports("sms"));
  checkTrue("nor whatsapp", !t.supports("whatsapp"));

  // ── A successful send ────────────────────────────────────────────────────
  s.set(200, JSON.stringify({ id: "msg_abc123" }));
  const ok = await t.send(request);
  checkTrue("a 200 is a success", ok.ok);
  check(
    "and the provider id is recorded, prefixed so it cannot be mistaken for console",
    ok.ok ? ok.providerMessageId : "",
    "resend:msg_abc123",
  );
  check("the API key is sent as a bearer token", s.captured.auth, "Bearer re_test_key");
  check(
    "the idempotency key is the notification id, so a retry cannot double-send",
    s.captured.idempotencyKey,
    "notif-0001",
  );
  check("the subject is passed through", s.captured.body?.["subject"], "Quotation QUO-2026-00007");
  check("the body is passed through as text", s.captured.body?.["text"], "Line one.\nLine two.");
  check(
    "the recipient is sent as a list, which is what the API expects",
    JSON.stringify(s.captured.body?.["to"]),
    JSON.stringify(["fatima@baytower.example"]),
  );

  // ── A 2xx whose body we cannot read is still a success ───────────────────
  s.set(200, "not json at all");
  const okBadBody = await t.send(request);
  checkTrue("an unreadable 2xx body is still a success", okBadBody.ok);
  check(
    "it just has no provider id",
    okBadBody.ok ? okBadBody.providerMessageId : "x",
    undefined,
  );

  // ── Permanent failures stop, rather than burning five attempts ───────────
  for (const [status, label] of [
    [422, "a rejected address (422)"],
    [400, "a malformed request (400)"],
    [401, "a bad API key (401)"],
    [403, "an unverified sender (403)"],
  ] as const) {
    s.set(status, JSON.stringify({ message: "nope" }));
    const r = await t.send(request);
    checkTrue(`${label} fails`, !r.ok);
    checkTrue(`${label} is NOT retried`, !r.ok && !r.retryable);
  }

  // ── Transient failures are retried ───────────────────────────────────────
  for (const [status, label] of [
    [429, "a rate limit (429)"],
    [500, "a provider error (500)"],
    [503, "an outage (503)"],
    [408, "a provider-side timeout (408)"],
  ] as const) {
    s.set(status, JSON.stringify({ message: "later" }));
    const r = await t.send(request);
    checkTrue(`${label} fails`, !r.ok);
    checkTrue(`${label} IS retried`, !r.ok && r.retryable);
  }

  // ── The error text reaches the ledger ────────────────────────────────────
  s.set(422, JSON.stringify({ message: "The from address is not verified" }));
  const detailed = await t.send(request);
  checkTrue(
    "the provider's own words are kept, so a human can act on the failure",
    !detailed.ok && detailed.error.includes("not verified") && detailed.error.includes("422"),
  );

  // ── A hanging provider is abandoned, and that is retryable ───────────────
  s.set(200, JSON.stringify({ id: "slow" }), 2_000); // longer than timeoutMs
  const timedOut = await t.send(request);
  checkTrue("a provider that hangs is a failure", !timedOut.ok);
  checkTrue("and it is retryable — a timeout is not a rejection", !timedOut.ok && timedOut.retryable);

  // ── Selection from the environment ───────────────────────────────────────
  check(
    "with no configuration, the console transport is chosen",
    selectTransport({} as NodeJS.ProcessEnv).name,
    new ConsoleTransport().name,
  );
  check(
    "with both variables set, the real one is chosen",
    selectTransport({ RESEND_API_KEY: "k", NOTIFY_FROM: "a@b.example" } as NodeJS.ProcessEnv).name,
    "resend",
  );
  check(
    "a key with no from address falls back rather than half-working",
    selectTransport({ RESEND_API_KEY: "k" } as NodeJS.ProcessEnv).name,
    new ConsoleTransport().name,
  );
  check(
    "and a from address with no key does too",
    selectTransport({ NOTIFY_FROM: "a@b.example" } as NodeJS.ProcessEnv).name,
    new ConsoleTransport().name,
  );

  s.server.close();
  console.log(fail === 0 ? "\nemail transport: all checks passed" : `\n${fail} check(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
