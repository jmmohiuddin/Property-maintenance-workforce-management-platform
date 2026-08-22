/**
 * The virus scanner, without a virus scanner.
 *
 * ClamAV is not installed in CI and will not be on a developer's laptop, so the
 * suite is built around that fact rather than around wishing it away. Two
 * things are proven here:
 *
 *  1. **The wire protocol**, directly. Framing and reply-reading are pure
 *    functions, and the reply-reading is where the dangerous mistake lives —
 *    an unrecognised answer must never be read as "clean".
 *  2. **The seam**, through a scanner the test controls, including the case
 *    that matters most: a scanner that fails produces no verdict at all rather
 *    than a favourable one.
 *
 * What is deliberately not proven: that a socket connects. That is the part a
 * running daemon exercises, and it is the part that fails loudly.
 */

import { deflateSync } from "node:zlib";
import {
  EICAR_TEST_STRING,
  UnavailableScanner,
  encodeInstream,
  parseClamdReply,
  setVirusScanner,
  virusScanner,
  type ScanVerdict,
  type VirusScanner,
} from "@meridian/files";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: unknown): void {
  check(label, got, true);
}
async function refuses(label: string, fn: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — it was allowed`);
  } catch {
    console.log(`ok    ${label}`);
  }
}

async function main(): Promise<void> {
  // ── The INSTREAM framing ──────────────────────────────────────────────────
  // clamd reads a big-endian uint32 length before each chunk and a zero-length
  // frame as the terminator. Every one of those three facts is somewhere a
  // client goes wrong silently: little-endian lengths make the daemon wait
  // forever, a missing terminator makes it hang, and a length that counts
  // itself desynchronises the whole stream.
  const framed = encodeInstream(new Uint8Array([1, 2, 3, 4, 5]), 2);
  const text = Buffer.from(framed).toString("latin1");

  checkTrue("the command opens the stream and asks for NUL-terminated replies", text.startsWith("zINSTREAM\0"));
  // "zINSTREAM\0" is 10 bytes; then 3 frames (2+2+1 bytes) each with a 4-byte
  // header, then the 4-byte terminator.
  check("framed length is command + headers + payload + terminator", framed.length, 10 + 3 * 4 + 5 + 4);
  check("the first frame declares 2 bytes, big-endian", Buffer.from(framed).readUInt32BE(10), 2);
  // Third frame header: 10 for the command, then two frames of 4 + 2 bytes.
  check("the last frame is short, not padded", Buffer.from(framed).readUInt32BE(10 + 6 + 6), 1);
  check("the stream ends with a zero-length frame", Buffer.from(framed).readUInt32BE(framed.length - 4), 0);

  // A file that divides exactly must not gain an extra empty frame before the
  // terminator — clamd treats the first zero-length frame as the end.
  const exact = encodeInstream(new Uint8Array([1, 2, 3, 4]), 2);
  check("an exactly-divisible payload is two frames, not three", exact.length, 10 + 2 * 4 + 4 + 4);

  // ── Reading the reply ─────────────────────────────────────────────────────
  check("OK is clean", parseClamdReply("stream: OK\0").status, "clean");

  const infected = parseClamdReply("stream: Eicar-Signature FOUND\0");
  check("FOUND is infected", infected.status, "infected");
  check(
    "the signature is kept for the row",
    infected.status === "infected" ? infected.signature : null,
    "Eicar-Signature",
  );

  // THE line. `INSTREAM size limit exceeded` means the daemon never looked at
  // the file — reading it as clean would wave through exactly the oversized
  // payload an attacker would choose, and the gate would be decorative.
  await refuses("a size-limit ERROR is not a clean verdict", () =>
    parseClamdReply("INSTREAM size limit exceeded. ERROR\0"),
  );
  await refuses("any other ERROR is not a clean verdict", () => parseClamdReply("Can't open file. ERROR\0"));
  await refuses("an empty reply is not a clean verdict", () => parseClamdReply("\0"));
  await refuses("an unrecognised reply is not a clean verdict", () => parseClamdReply("PONG\0"));

  // ── The seam ──────────────────────────────────────────────────────────────
  // A scanner the test controls, standing in for a daemon. This is what every
  // sweep test upstream uses, and it is why none of them needs a socket.
  class FakeClamd implements VirusScanner {
    readonly name = "fake-clamd";
    scan(bytes: Uint8Array): Promise<ScanVerdict> {
      const body = Buffer.from(bytes).toString("latin1");
      return Promise.resolve(
        body.includes(EICAR_TEST_STRING)
          ? { status: "infected", signature: "Eicar-Test-Signature" }
          : { status: "clean" },
      );
    }
  }

  setVirusScanner(new FakeClamd());
  const configured = virusScanner();
  checkTrue("a configured deployment reports itself configured", configured.configured);

  if (configured.configured) {
    const clean = await configured.scanner.scan(Buffer.from("%PDF-1.7\n"));
    check("an ordinary file is clean", clean.status, "clean");

    const eicar = await configured.scanner.scan(Buffer.from(EICAR_TEST_STRING, "latin1"));
    check("EICAR is caught", eicar.status, "infected");
    check(
      "and named",
      eicar.status === "infected" ? eicar.signature : null,
      "Eicar-Test-Signature",
    );

    // The EICAR string inside a compressed archive is what a real daemon
    // catches and a byte-comparison does not. Asserted against the fake only to
    // record the boundary of what this suite can and cannot prove: recursive
    // archive scanning is clamd's job and is not tested here.
    const zipped = deflateSync(Buffer.from(EICAR_TEST_STRING, "latin1"));
    const throughFake = await configured.scanner.scan(zipped);
    check(
      "the fake cannot see inside an archive — only a real daemon can",
      throughFake.status,
      "clean",
    );
  }

  // ── A scanner that fails gives no verdict ─────────────────────────────────
  setVirusScanner(new UnavailableScanner("connection refused"));
  const broken = virusScanner();
  checkTrue("a broken scanner still reports as configured", broken.configured);
  if (broken.configured) {
    await refuses("a scanner that cannot answer throws rather than passing the file", () =>
      broken.scanner.scan(Buffer.from("%PDF-1.7\n")),
    );
  }

  // ── No scanner configured ─────────────────────────────────────────────────
  setVirusScanner(undefined);
  const host = process.env["CLAMAV_HOST"];
  const socket = process.env["CLAMAV_SOCKET"];
  delete process.env["CLAMAV_HOST"];
  delete process.env["CLAMAV_SOCKET"];

  const absent = virusScanner();
  check("with nothing configured, there is no scanner", absent.configured, false);
  checkTrue(
    "and the reason names the variables that would configure one",
    !absent.configured && absent.reason.includes("CLAMAV_HOST"),
  );
  checkTrue(
    "and says plainly that this deployment does not scan",
    !absent.configured && absent.reason.includes("does not do it"),
  );

  if (host !== undefined) process.env["CLAMAV_HOST"] = host;
  if (socket !== undefined) process.env["CLAMAV_SOCKET"] = socket;

  console.log(`\n${fail === 0 ? "files/scan: all checks passed" : `${fail} FAILING`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
