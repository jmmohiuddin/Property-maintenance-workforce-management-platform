import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Implemented here rather than pulled in as a dependency because the whole
 * algorithm is thirty lines of HMAC and the failure modes that matter — clock
 * drift, replay inside a step, constant-time comparison — are decisions we have
 * to make deliberately either way. A dependency would hide them, not remove
 * them.
 *
 * SHA-1 is not a mistake. RFC 6238 permits SHA-256 and SHA-512, but every
 * mainstream authenticator app ignores the `algorithm` parameter in the
 * enrolment URI and assumes SHA-1, so a "stronger" choice here produces codes
 * that simply never match. HMAC-SHA1 is not affected by the collision attacks
 * that retired SHA-1 for signatures, and the secret is 160 bits of CSPRNG
 * output.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One step, so a phone up to 30 seconds out of sync still works. Two would
 * triple the window an intercepted code stays usable in for no real gain —
 * devices that far out of sync are broken, not merely drifting.
 */
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 without padding, which is what authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return output;
}

export function base32Decode(input: string): Buffer {
  // People retype secrets by hand, and apps display them in spaced groups.
  const cleaned = input.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");

  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(output);
}

/** 160 bits, matching the HMAC-SHA1 block the RFC recommends. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Which 30-second step a moment falls in. This is the replay-guard unit. */
export function stepAt(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / STEP_SECONDS);
}

/** The code for a given step. Exported so tests can pin RFC vectors. */
export function codeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);

  const counter = Buffer.alloc(8);
  // JavaScript numbers are exact to 2^53, and the step counter passes 2^32 in
  // the year 6053, so writing the high word from a shift is safe. Doing it with
  // BigInt would be correct too and slower on every login.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const digest = createHmac("sha1", key).update(counter).digest();

  // Dynamic truncation, RFC 4226 §5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export interface VerifyResult {
  readonly ok: boolean;
  /** The step the code belonged to. Store it to refuse a replay. */
  readonly step: number | null;
}

/**
 * Verify a code.
 *
 * `lastUsedStep` is the replay guard and it is not optional in practice: a code
 * stays valid for the whole step, so anyone who reads it over a shoulder — or
 * off a phishing page — can use it again seconds later. Refusing any step at or
 * below the last successful one costs nothing and closes that window.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { at?: Date; lastUsedStep?: number | null } = {},
): VerifyResult {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, step: null };

  const current = stepAt(options.at);

  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset++) {
    const step = current + offset;
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;

    const expected = codeForStep(secret, step);
    // Both are fixed-length ASCII digits, so a timing-safe compare is cheap and
    // removes any argument about leaking a prefix match.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(cleaned))) {
      return { ok: true, step };
    }
  }

  return { ok: false, step: null };
}

/**
 * The enrolment URI an authenticator app scans.
 *
 * The issuer appears twice on purpose: once as a label prefix for apps that
 * only read the label, once as a parameter for apps that read both. Getting
 * this wrong shows the user "Unknown account" in their authenticator, which is
 * how a person ends up deleting the entry that protects their account.
 *
 * `algorithm`, `digits` and `period` are deliberately omitted. SHA-1, six
 * digits and thirty seconds are the defaults every authenticator assumes when
 * the parameters are absent — which is exactly what this implementation uses —
 * so stating them adds forty characters of QR payload and buys nothing. On a
 * long account name those forty characters are the difference between a code
 * that fits and one that does not.
 */
export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const params = new URLSearchParams({ secret: input.secret, issuer: input.issuer });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ── Recovery codes ─────────────────────────────────────────────────────────
 * A second factor that cannot be recovered is a way to lose an account, not a
 * way to protect one. These are the escape hatch, and they are treated as
 * credentials: shown once, stored hashed, single use.
 */

export const RECOVERY_CODE_COUNT = 10;

/**
 * Crockford-style alphabet: no I, L, O, U. Recovery codes get written on paper
 * and typed back by someone who is already locked out and irritated.
 */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  let code = "";
  for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
  // 10 characters of a 32-symbol alphabet is 50 bits — far beyond guessing,
  // and grouped so a person can read it off paper without losing their place.
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/** Normalise before hashing, so casing and the dash cannot cause a false miss. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, "");
}
