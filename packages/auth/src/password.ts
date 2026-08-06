import { hash, verify } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id` from @node-rs/argon2 is an ambient const enum, which
 * `verbatimModuleSyntax` will not let us reference. The numeric value is part
 * of that library's public API and is stable, so it is inlined here with the
 * mapping recorded: 0 = Argon2d, 1 = Argon2i, 2 = Argon2id.
 */
const ARGON2ID = 2;

/**
 * Argon2id password hashing.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's Argon2id baseline:
 * 19 MiB memory, 2 iterations, parallelism 1. Memory cost is what makes GPU
 * cracking expensive, so it is the parameter to raise first if you raise any.
 *
 * These values are recorded here rather than left to library defaults because a
 * library default change would silently alter the security property, and because
 * the numbers need to be reviewable.
 */
const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }
  return hash(plaintext, OPTIONS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash: a corrupted or
 * legacy-format row should fail the login, not crash the login endpoint for
 * everyone. The failure is still visible because the caller records the failed
 * attempt.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Constant-ish-time dummy verification.
 *
 * Called when no user exists for a submitted email, so that "unknown address"
 * and "wrong password" take comparable time. Without it, response timing
 * enumerates which email addresses hold accounts.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Q0hBTkdFTUVDSEFOR0VNRUNIQU5HRU1FQ0hB";

export async function fakeVerify(plaintext: string): Promise<void> {
  await verifyPassword(plaintext, DUMMY_HASH);
}
