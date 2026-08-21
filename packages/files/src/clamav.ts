/**
 * ClamAV, over clamd's INSTREAM command.
 *
 * ── WHY INSTREAM AND NOT `SCAN <path>` ──────────────────────────────────────
 *
 * `SCAN` hands clamd a filesystem path and requires the daemon to be able to
 * read it. That is true for a daemon on the same box as the local file store
 * and false for every other arrangement — a sidecar container, a separate node,
 * or the S3 driver that lands when `OPEN-2` is answered. INSTREAM pushes the
 * bytes down the socket instead, so the scanner never needs to share a
 * filesystem with the store and the same code works in all four cases.
 *
 * ── THE PROTOCOL, BECAUSE IT IS EASY TO GET SUBTLY WRONG ────────────────────
 *
 *   → "zINSTREAM\0"                      the `z` prefix asks for NUL-terminated
 *                                        replies rather than newline-terminated
 *   → <uint32 be length><chunk bytes>    repeated
 *   → <uint32 be 0>                      end of stream
 *   ← "stream: OK\0"
 *     "stream: <Signature> FOUND\0"
 *     "<something> ERROR\0"
 *
 * The length prefix is big-endian and unsigned, and a chunk longer than
 * clamd's `StreamMaxLength` makes the daemon reply `INSTREAM size limit
 * exceeded. ERROR` and close — which is an error and NOT a clean verdict, and
 * is the single most important line in `parseClamdReply` below.
 *
 * ── WHY THE FRAMING AND THE PARSING ARE PURE FUNCTIONS ──────────────────────
 *
 * ClamAV is not installed in CI and will not be installed on a laptop. Every
 * part of this that can be wrong without a socket — the frame layout, the
 * big-endian length, the terminator, and above all the reading of a reply — is
 * exported and tested directly. What is left untested by the suite is the
 * socket plumbing itself, which is the part a running daemon would exercise and
 * the part that fails loudly rather than silently.
 */

import { connect, type Socket } from "node:net";
import type { ScanVerdict, VirusScanner } from "./scan";

/**
 * 64 KB per frame.
 *
 * Comfortably under clamd's default `StreamMaxLength` of 25 MB for the whole
 * stream, and small enough that a frame is never the thing that trips the
 * daemon's per-read buffer.
 */
export const CLAMD_CHUNK_BYTES = 64 * 1024;

/** How long to wait for a verdict before giving up. A verdict is not a clean. */
export const CLAMD_TIMEOUT_MS = 30_000;

/**
 * The bytes to write for one INSTREAM scan, framed.
 *
 * Returned as a single buffer rather than a generator because the largest
 * object this store will ever hold is 25 MB (`MAX_OBJECT_BYTES`), which is
 * already in memory by the time anything calls this — streaming the framing
 * while holding the whole payload would be ceremony with no benefit.
 */
export function encodeInstream(bytes: Uint8Array, chunkBytes = CLAMD_CHUNK_BYTES): Uint8Array {
  if (chunkBytes < 1) throw new Error("INSTREAM chunk size must be positive");

  const frames = Math.ceil(bytes.length / chunkBytes);
  // command + (4-byte length per frame) + payload + 4-byte terminator
  const command = Buffer.from("zINSTREAM\0", "ascii");
  const out = Buffer.allocUnsafe(command.length + frames * 4 + bytes.length + 4);

  let at = command.copy(out, 0);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const length = Math.min(chunkBytes, bytes.length - offset);
    out.writeUInt32BE(length, at);
    at += 4;
    at += Buffer.from(bytes.buffer, bytes.byteOffset + offset, length).copy(out, at);
  }
  out.writeUInt32BE(0, at);

  return new Uint8Array(out);
}

/**
 * Read clamd's answer.
 *
 * ── THE LINE THAT MATTERS ───────────────────────────────────────────────────
 *
 * Anything that is not exactly "OK" or "… FOUND" throws. It is tempting to
 * treat an unrecognised reply as clean — the file is probably fine, the scan
 * probably worked — and that instinct is exactly how a scan gate becomes
 * decorative. `INSTREAM size limit exceeded. ERROR` is the concrete case: the
 * file was too large for the daemon, so it was *never scanned*, and a caller
 * that read that as clean would wave through precisely the oversized payloads
 * an attacker would choose.
 *
 * A throw here leaves the document `pending` and undownloadable, which is the
 * correct outcome for a file nobody knows anything about.
 */
export function parseClamdReply(raw: string): ScanVerdict {
  const reply = raw.replace(/\0+$/, "").trim();

  if (reply === "") throw new Error("clamd closed the connection without a verdict");

  if (/\bERROR$/.test(reply)) {
    throw new Error(`clamd refused to scan: ${reply}`);
  }

  // "stream: OK" — the prefix is the stream name and is not always "stream".
  if (/\bOK$/.test(reply)) return { status: "clean" };

  const found = /^(?:.*?:\s*)?(.+?)\s+FOUND$/.exec(reply);
  if (found?.[1]) return { status: "infected", signature: found[1] };

  throw new Error(`clamd said something this client does not understand: ${JSON.stringify(reply)}`);
}

export interface ClamAvAddress {
  readonly host?: string;
  readonly port?: number;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
}

export class ClamAvScanner implements VirusScanner {
  readonly name: string;

  constructor(private readonly address: ClamAvAddress) {
    this.name = address.socketPath
      ? `clamav(${address.socketPath})`
      : `clamav(${address.host}:${address.port ?? 3310})`;
  }

  scan(bytes: Uint8Array): Promise<ScanVerdict> {
    const timeoutMs = this.address.timeoutMs ?? CLAMD_TIMEOUT_MS;

    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket: Socket = this.address.socketPath
        ? connect({ path: this.address.socketPath })
        : connect({ host: this.address.host ?? "127.0.0.1", port: this.address.port ?? 3310 });

      let reply = "";
      let settled = false;

      // One exit, so a late `error` after a verdict cannot reject a promise
      // that already resolved and take the process down with it.
      const finish = (error: Error | null, verdict?: ScanVerdict): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(verdict!);
      };

      socket.setTimeout(timeoutMs);
      socket.on("timeout", () =>
        finish(new Error(`clamd did not answer within ${timeoutMs}ms — no verdict, not a clean file`)),
      );
      socket.on("error", (error) => finish(error));
      socket.on("data", (buffer: Buffer) => {
        reply += buffer.toString("utf8");
        // clamd replies once and the `z` prefix guarantees a NUL terminator, so
        // this is the whole answer rather than the first packet of it.
        if (reply.includes("\0")) {
          try {
            finish(null, parseClamdReply(reply));
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      socket.on("close", () => {
        if (!settled) finish(new Error("clamd closed the connection without a verdict"));
      });

      socket.on("connect", () => {
        socket.write(encodeInstream(bytes));
      });
    });
  }
}

/**
 * The EICAR test string, verbatim.
 *
 * Not malware — it is the industry's agreed harmless file that every scanner
 * reports as infected, and it is the only way to prove end to end that a real
 * daemon is wired up correctly without going near a real sample. Exported so a
 * deployment check can push it through a live scanner; the test suite uses it
 * only through a scanner it controls.
 */
export const EICAR_TEST_STRING =
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
