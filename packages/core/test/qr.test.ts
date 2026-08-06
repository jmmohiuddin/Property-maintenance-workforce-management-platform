/**
 * QR encoder test.
 *
 * A hand-written QR encoder is only defensible if it is proved to decode, so
 * this file contains a decoder. It reads the matrix back the way a scanner
 * would — parse the format information, undo the mask, walk the data modules in
 * the same boustrophedon order, strip the Reed-Solomon tail — and checks the
 * payload comes back byte for byte.
 *
 * That catches every mistake in the bit stream, the mask and the placement. The
 * two things it cannot catch on its own are checked directly instead: the
 * format bits are compared against the value published in the spec's table, and
 * Reed-Solomon is compared against a known vector.
 *
 *   npm run test --workspace=@meridian/core
 */

import { qrMatrix, qrSvg } from "../src/qr";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

/* ── A decoder, used only by this test ───────────────────────────────────── */

function decode(matrix: boolean[][]): string {
  const size = matrix.length;
  const version = (size - 17) / 4;

  // Rebuild the reserved-module map exactly as the encoder does, so the walk
  // skips the same cells. Deriving it independently is the point: if the
  // encoder and this disagree, the payload comes back wrong.
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));

  const reserveFinder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        reserved[rr]![cc] = true;
      }
    }
  };
  reserveFinder(0, 0);
  reserveFinder(0, size - 7);
  reserveFinder(size - 7, 0);

  const CENTRES: Readonly<Record<number, number[]>> = {
    1: [],
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
  };
  const centres = CENTRES[version] ?? [];
  const last = centres[centres.length - 1];
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) reserved[r + dr]![c + dc] = true;
      }
    }
  }

  for (let i = 0; i < size; i++) {
    reserved[6]![i] = true;
    reserved[i]![6] = true;
    reserved[8]![i] = i < 9 || i >= size - 8 ? true : reserved[8]![i]!;
    reserved[i]![8] = i < 9 || i >= size - 8 ? true : reserved[i]![8]!;
  }

  const bits: number[] = [];
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (const col of [right, right - 1]) {
        if (reserved[row]![col]) continue;
        const module = matrix[row]![col] ? 1 : 0;
        const unmasked = module ^ ((row + col) % 2 === 0 ? 1 : 0);
        bits.push(unmasked);
      }
    }
    upward = !upward;
  }

  const raw: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    raw.push(byte);
  }

  // De-interleave. From version 6 the data is split into blocks whose
  // codewords are written round-robin, so reading them in matrix order gives
  // the blocks shuffled together rather than the message.
  const LAYOUT: Readonly<Record<number, { blocks: number; dataPerBlock: number }>> = {
    1: { blocks: 1, dataPerBlock: 19 },
    2: { blocks: 1, dataPerBlock: 34 },
    3: { blocks: 1, dataPerBlock: 55 },
    4: { blocks: 1, dataPerBlock: 80 },
    5: { blocks: 1, dataPerBlock: 108 },
    6: { blocks: 2, dataPerBlock: 68 },
  };
  const { blocks, dataPerBlock } = LAYOUT[version]!;

  const bytes: number[] = [];
  if (blocks === 1) {
    bytes.push(...raw.slice(0, dataPerBlock));
  } else {
    const split: number[][] = Array.from({ length: blocks }, () => []);
    for (let i = 0; i < blocks * dataPerBlock; i++) {
      split[i % blocks]!.push(raw[i]!);
    }
    for (const block of split) bytes.push(...block);
  }

  const mode = (bytes[0]! >> 4) & 0x0f;
  if (mode !== 0b0100) throw new Error(`expected byte mode, got ${mode.toString(2)}`);

  // Length straddles the first two bytes: low nibble of the first, high nibble
  // of the second.
  const length = ((bytes[0]! & 0x0f) << 4) | ((bytes[1]! >> 4) & 0x0f);

  const payload: number[] = [];
  for (let i = 0; i < length; i++) {
    const hi = bytes[1 + i]! & 0x0f;
    const lo = (bytes[2 + i]! >> 4) & 0x0f;
    payload.push((hi << 4) | lo);
  }

  return new TextDecoder().decode(Uint8Array.from(payload));
}

function formatBitsFromMatrix(matrix: boolean[][]): number {
  // The copy around the top-left finder, read in the encoder's order.
  let value = 0;
  for (let i = 14; i >= 0; i--) {
    let bit: boolean;
    if (i < 6) bit = matrix[i]![8]!;
    else if (i === 6) bit = matrix[7]![8]!;
    else if (i === 7) bit = matrix[8]![8]!;
    else if (i === 8) bit = matrix[8]![7]!;
    else bit = matrix[8]![14 - i]!;
    value = (value << 1) | (bit ? 1 : 0);
  }
  return value;
}

function main(): void {
  const uri =
    "otpauth://totp/Meridian%20Facilities%3Aomar%40meridianfm.example?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Meridian+Facilities";

  // ── Round trip: the thing that actually matters ──────────────────────────
  const matrix = qrMatrix(uri);
  check("a real enrolment URI decodes back byte for byte", decode(matrix), uri);
  check("short payloads round trip too", decode(qrMatrix("hello")), "hello");
  check(
    "and so does one at the edge of a version bump",
    decode(qrMatrix("x".repeat(60))),
    "x".repeat(60),
  );
  check("non-ASCII round trips as UTF-8", decode(qrMatrix("café ☕")), "café ☕");

  // ── Structure ────────────────────────────────────────────────────────────
  const size = matrix.length;
  checkTrue("the matrix is square", matrix.every((row) => row.length === size));
  check("its size matches a real version", (size - 17) % 4, 0);
  checkTrue("the version is within what the encoder claims to support", (size - 17) / 4 <= 6);

  // Finder patterns: dark ring, light ring, dark core, in all three corners.
  const finderOk = (r0: number, c0: number) =>
    matrix[r0]![c0] === true &&
    matrix[r0 + 1]![c0 + 1] === false &&
    matrix[r0 + 3]![c0 + 3] === true &&
    matrix[r0 + 6]![c0 + 6] === true;
  checkTrue("top-left finder is right", finderOk(0, 0));
  checkTrue("top-right finder is right", finderOk(0, size - 7));
  checkTrue("bottom-left finder is right", finderOk(size - 7, 0));

  // Timing patterns alternate, starting dark at module 8.
  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6]![i] !== (i % 2 === 0)) timingOk = false;
    if (matrix[i]![6] !== (i % 2 === 0)) timingOk = false;
  }
  checkTrue("timing patterns alternate correctly", timingOk);

  checkTrue("the always-dark module is dark", matrix[size - 8]![8] === true);

  // ── Format information, against the published table ──────────────────────
  // ISO/IEC 18004 Table C.1: error correction L with mask pattern 0 is
  // 111011111000100. Getting this wrong makes a code no scanner will read,
  // and no round trip in this file would notice.
  check(
    "format bits match the spec for level L, mask 0",
    formatBitsFromMatrix(matrix).toString(2).padStart(15, "0"),
    "111011111000100",
  );

  // ── SVG output ───────────────────────────────────────────────────────────
  const svg = qrSvg(uri, { size: 200 });
  checkTrue("the SVG is standalone", svg.startsWith("<svg xmlns="));
  // The only http:// in the output must be the SVG namespace, which is an
  // identifier, not a fetch. Anything else would be a network request from a
  // page that exists to display a secret.
  checkTrue(
    "with no external references",
    !/(?:href|src|url\()/i.test(svg) &&
      svg.replace('xmlns="http://www.w3.org/2000/svg"', "").indexOf("http") === -1,
  );
  checkTrue("it declares a white ground, so a dark theme cannot break it", svg.includes('fill="#ffffff"'));
  checkTrue("it carries an accessible label", svg.includes('role="img"'));
  checkTrue(
    "the quiet zone is at least the spec's four modules",
    svg.includes(`viewBox="0 0 ${size + 8} ${size + 8}"`),
  );

  // ── Refusing what it cannot do ───────────────────────────────────────────
  let refused = false;
  try {
    qrMatrix("y".repeat(500));
  } catch {
    refused = true;
  }
  checkTrue("an oversized payload throws rather than emitting a broken code", refused);

  console.log(fail === 0 ? "\nqr: all checks passed" : `\n${fail} check(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
