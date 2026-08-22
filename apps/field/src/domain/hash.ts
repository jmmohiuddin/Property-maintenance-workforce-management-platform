/**
 * SHA-256, in pure TypeScript.
 *
 * ── WHY THIS EXISTS INSTEAD OF `expo-crypto` ────────────────────────────────
 *
 * `domain/signature.ts` needs a `SignatureDigest` - "SHA-256 of the exact
 * rendered job sheet" - and until now nothing in this workspace could produce
 * one: `expo-crypto` is not a dependency, and `SignatureScreen` refused to save
 * a signature over it rather than write a `sheet_digest` that was a placeholder
 * (see the note at the top of that file, and `job_signoffs.sheet_digest` in
 * `db/schema.ts`, which is a required column precisely because a hash that is
 * sometimes absent is worse than an honest gap).
 *
 * Adding a native module is the ordinary way to get SHA-256 on a phone, and it
 * was deliberately not done here: this session has no simulator to prove a new
 * native dependency links, and a hashing bug that only shows up on-device is
 * the worst possible place for one. SHA-256 is a closed, fully-specified
 * algorithm (FIPS 180-4) with published test vectors, which makes a pure
 * implementation something this session genuinely *can* verify - `test/hash.
 * test.ts` checks it against four of them, including the two-block case, which
 * is the one most likely to expose a padding bug.
 *
 * This is portable TypeScript with no RN import, so it is covered by the root
 * typecheck and the root test run, not only by the native half.
 */

const K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * The message schedule and compression rounds, unrolled to a straight
 * implementation of FIPS 180-4 §6.2. Nothing here is an optimisation over the
 * textbook algorithm - clarity is worth more than speed for a function that
 * signs a job sheet once per visit, not once per frame.
 */
export function sha256(message: Uint8Array): Uint8Array {
  const bitLen = message.length * 8;
  // Message + 0x80 + zero padding + 8-byte big-endian bit length, total a
  // multiple of 64 bytes.
  const withLength = message.length + 1 + 8;
  const totalLen = withLength + ((64 - (withLength % 64)) % 64);
  const padded = new Uint8Array(totalLen);
  padded.set(message);
  padded[message.length] = 0x80;

  const view = new DataView(padded.buffer);
  // `bitLen` fits in 32 bits for anything this app will ever hash (a job
  // sheet is at most a few kilobytes of text); the high word is always zero.
  view.setUint32(totalLen - 8, 0, false);
  view.setUint32(totalLen - 4, bitLen >>> 0, false);

  let [h0, h1, h2, h3, h4, h5, h6, h7] = H0;
  const w = new Uint32Array(64);

  for (let chunkStart = 0; chunkStart < totalLen; chunkStart += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(chunkStart + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const wi15 = w[i - 15] as number;
      const wi2 = w[i - 2] as number;
      const s0 = rotr(wi15, 7) ^ rotr(wi15, 18) ^ (wi15 >>> 3);
      const s1 = rotr(wi2, 17) ^ rotr(wi2, 19) ^ (wi2 >>> 10);
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) >>> 0;
    }

    let a = h0 as number, b = h1 as number, c = h2 as number, d = h3 as number;
    let e = h4 as number, f = h5 as number, g = h6 as number, h = h7 as number;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (K[i] as number) + (w[i] as number)) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 as number) + a; h1 = (h1 as number) + b; h2 = (h2 as number) + c; h3 = (h3 as number) + d;
    h4 = (h4 as number) + e; h5 = (h5 as number) + f; h6 = (h6 as number) + g; h7 = (h7 as number) + h;
    h0 >>>= 0; h1 >>>= 0; h2 >>>= 0; h3 >>>= 0; h4 >>>= 0; h5 >>>= 0; h6 >>>= 0; h7 >>>= 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, i) => outView.setUint32(i * 4, word as number, false));
  return out;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number;
    out += HEX[(byte >> 4) & 0xf];
    out += HEX[byte & 0xf];
  }
  return out;
}

/**
 * A minimal, dependency-free UTF-8 encoder.
 *
 * `TextEncoder` is not reliably global on every Hermes build this app might
 * ship on, and the whole point of this module is not needing a runtime API
 * that might be missing. This handles the full range including surrogate
 * pairs (emoji, rare CJK) via `codePointAt`.
 */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i) as number;
    if (code > 0xffff) i++; // consumed the low surrogate too
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/** A `SignatureDigest` (see `domain/signature.ts`), backed by this module. */
export async function sha256OfCanonicalSheet(canonical: string): Promise<string> {
  return sha256Hex(utf8Encode(canonical));
}
