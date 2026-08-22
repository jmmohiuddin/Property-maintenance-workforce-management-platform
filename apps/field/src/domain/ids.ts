/**
 * Client-generated identifiers.
 *
 * TRD §8.3: *"Client-generated IDs are non-negotiable. A technician must be
 * able to create a job note offline, attach four photos to it, and reference
 * it, before the server has ever seen it. The server accepts the client ID;
 * the client never waits for a server ID."*
 *
 * ULID rather than UUIDv4 for one reason that matters to this app: ULIDs sort
 * lexicographically by creation time. The outbox drains FIFO per aggregate
 * root, and `ORDER BY client_id` is that order for free - no separate sequence
 * column that can disagree with the ID, and no dependence on a device clock
 * that is allowed to be wrong (the ordering only has to be *consistent* on one
 * device, which it is even if that device thinks it is 1997).
 *
 * The same value is the idempotency key. That is deliberate: one identifier for
 * "this thing the technician made" means there is no way to retry a mutation
 * under a different key, which is the mechanism by which duplicate job
 * completions and double-billed parts happen.
 */

/** Crockford base32, excluding I, L, O and U so a human can read one aloud. */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

export type RandomBytes = (length: number) => Uint8Array;

/**
 * The default entropy source, in preference order.
 *
 * ── WHAT THE FALLBACK COSTS, STATED RATHER THAN HIDDEN ─────────────────────
 *
 * React Native's JSC has no `crypto.getRandomValues` unless a polyfill is
 * installed; Hermes on recent React Native does. When neither is present this
 * falls back to `Math.random`, which is NOT cryptographically random.
 *
 * For this use that is a collision-probability question, not a security one -
 * nothing authenticates on a ULID, and the server scopes every mutation by the
 * technician's own row-level access regardless of what ID arrives. But 80 bits
 * of `Math.random` on a device whose PRNG is seeded predictably is materially
 * weaker than 80 bits of CSPRNG, and two devices seeded alike could in
 * principle mint the same ID in the same millisecond.
 *
 * `hasStrongRandomness()` exists so the app can say so on the diagnostics
 * screen rather than implying a guarantee it does not have.
 */
const cryptoRef: { getRandomValues?: (a: Uint8Array) => Uint8Array } | undefined =
  (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;

export function hasStrongRandomness(): boolean {
  return typeof cryptoRef?.getRandomValues === "function";
}

export const defaultRandomBytes: RandomBytes = (length) => {
  const out = new Uint8Array(length);
  if (typeof cryptoRef?.getRandomValues === "function") {
    cryptoRef.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < length; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
};

function encodeTime(now: number): string {
  let time = Math.floor(now);
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = time % 32;
    out = ENCODING[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeRandom(random: RandomBytes): string {
  const bytes = random(RANDOM_LEN);
  let out = "";
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[(bytes[i] ?? 0) % 32];
  return out;
}

/**
 * A monotonic ULID factory.
 *
 * Two ULIDs minted in the same millisecond would otherwise sort arbitrarily,
 * and "arbitrarily" is not good enough when the ordering decides whether a
 * photo's parent job event was sent first. Within a millisecond the random
 * component is incremented instead of redrawn, which is the standard ULID
 * monotonic rule.
 *
 * A clock that goes backwards - a technician changing the device time, or NTP
 * stepping it - is handled by clamping to the last timestamp seen. IDs stay
 * ordered by the order they were *created*, which is the only ordering the
 * outbox needs, and `clock.ts` is what reports the skew to the office.
 */
export function createUlidFactory(random: RandomBytes = defaultRandomBytes): () => string {
  let lastTime = -1;
  let lastRandom = "";

  return function ulid(): string {
    const now = Date.now();
    if (now <= lastTime && lastRandom !== "") {
      lastRandom = incrementBase32(lastRandom, random);
      return encodeTime(lastTime) + lastRandom;
    }
    lastTime = now;
    lastRandom = encodeRandom(random);
    return encodeTime(lastTime) + lastRandom;
  };
}

/** Increment a Crockford-base32 string by one, redrawing on overflow. */
function incrementBase32(s: string, random: RandomBytes): string {
  const chars = s.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = ENCODING.indexOf(chars[i] ?? "0");
    if (index < ENCODING.length - 1) {
      chars[i] = ENCODING[index + 1] as string;
      return chars.join("");
    }
    chars[i] = ENCODING[0] as string;
  }
  // All-Z: the 80-bit space rolled over inside one millisecond, which needs
  // 2^80 IDs. Unreachable in practice; redrawing is the honest answer anyway.
  return encodeRandom(random);
}

/** The process-wide factory. One per device is the point of monotonicity. */
export const newClientId = createUlidFactory();

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isClientId(value: string): boolean {
  return ULID_PATTERN.test(value);
}

/** The creation time encoded in a ULID, as reported by the device that made it. */
export function clientIdTime(id: string): number | null {
  if (!isClientId(id)) return null;
  let time = 0;
  for (let i = 0; i < TIME_LEN; i++) {
    const index = ENCODING.indexOf(id[i] ?? "");
    if (index < 0) return null;
    time = time * 32 + index;
  }
  return time;
}
