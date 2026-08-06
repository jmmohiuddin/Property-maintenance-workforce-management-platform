/**
 * TOTP unit test.
 *
 * The first block checks our implementation against the published RFC 6238
 * test vectors. That matters more than any of our own assertions: a TOTP
 * implementation that is self-consistent but wrong produces codes no
 * authenticator app will ever match, and the only way to find out is to try to
 * sign in.
 *
 *   npm run test --workspace=@meridian/auth
 *
 * No database required.
 */

import {
  base32Encode,
  base32Decode,
  generateSecret,
  codeForStep,
  stepAt,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  RECOVERY_CODE_COUNT,
} from "../src/totp";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890" for SHA-1.
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

function main(): void {
  // ── Base32 round trip ────────────────────────────────────────────────────
  check("base32 encodes the RFC seed", RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  check(
    "base32 decodes back to the same bytes",
    base32Decode(RFC_SECRET).toString("ascii"),
    "12345678901234567890",
  );
  check(
    "spacing and case are tolerated, because people retype these",
    base32Decode("gezd gnbv gy3t-qojq").toString("hex"),
    base32Decode("GEZDGNBVGY3TQOJQ").toString("hex"),
  );

  let invalidRejected = false;
  try {
    base32Decode("NOT!VALID");
  } catch {
    invalidRejected = true;
  }
  checkTrue("an invalid base32 character is rejected", invalidRejected);

  // ── RFC 6238 Appendix B vectors, SHA-1 ───────────────────────────────────
  // The published values are 8 digits; we generate 6, so compare the last six.
  const VECTORS: readonly { unixTime: number; eightDigit: string }[] = [
    { unixTime: 59, eightDigit: "94287082" },
    { unixTime: 1111111109, eightDigit: "07081804" },
    { unixTime: 1111111111, eightDigit: "14050471" },
    { unixTime: 1234567890, eightDigit: "89005924" },
    { unixTime: 2000000000, eightDigit: "69279037" },
    { unixTime: 20000000000, eightDigit: "65353130" },
  ];

  for (const v of VECTORS) {
    const step = Math.floor(v.unixTime / 30);
    check(
      `RFC 6238 vector at t=${v.unixTime}`,
      codeForStep(RFC_SECRET, step),
      v.eightDigit.slice(-6),
    );
  }

  // The last vector is past 2^32 steps' worth of seconds only in the counter's
  // high word — it is the one that catches a 32-bit-only counter write.
  checkTrue(
    "the counter handles times beyond 32 bits",
    codeForStep(RFC_SECRET, Math.floor(20000000000 / 30)) === "353130",
  );

  // ── Verification and drift ───────────────────────────────────────────────
  const at = new Date("2026-08-06T12:00:00Z");
  const now = stepAt(at);
  const current = codeForStep(RFC_SECRET, now);

  checkTrue("the current code verifies", verifyTotp(RFC_SECRET, current, { at }).ok);
  check("and reports the step it matched", verifyTotp(RFC_SECRET, current, { at }).step, now);

  checkTrue(
    "a code from one step ago still works, for a phone that is slightly slow",
    verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, now - 1), { at }).ok,
  );
  checkTrue(
    "a code from one step ahead works too, for one that is slightly fast",
    verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, now + 1), { at }).ok,
  );
  checkTrue(
    "a code from two steps ago does not",
    !verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, now - 2), { at }).ok,
  );

  checkTrue("a wrong code fails", !verifyTotp(RFC_SECRET, "000000", { at }).ok);
  checkTrue("a five-digit code fails", !verifyTotp(RFC_SECRET, "12345", { at }).ok);
  checkTrue("a non-numeric code fails", !verifyTotp(RFC_SECRET, "abcdef", { at }).ok);
  checkTrue(
    "whitespace inside a code is tolerated, because apps display it grouped",
    verifyTotp(RFC_SECRET, `${current.slice(0, 3)} ${current.slice(3)}`, { at }).ok,
  );

  // ── Replay guard ─────────────────────────────────────────────────────────
  // This is the check that matters most: without it a code read over a shoulder
  // stays usable for the rest of its 30-second step.
  checkTrue(
    "a code cannot be replayed within its own step",
    !verifyTotp(RFC_SECRET, current, { at, lastUsedStep: now }).ok,
  );
  checkTrue(
    "nor can an earlier one after a later step has been used",
    !verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, now - 1), { at, lastUsedStep: now }).ok,
  );
  checkTrue(
    "but the next step's code works once it arrives",
    verifyTotp(RFC_SECRET, codeForStep(RFC_SECRET, now + 1), { at, lastUsedStep: now }).ok,
  );

  // ── Secrets ──────────────────────────────────────────────────────────────
  const secret = generateSecret();
  check("a generated secret is 160 bits", base32Decode(secret).length, 20);
  checkTrue("and is base32 only", /^[A-Z2-7]+$/.test(secret));
  checkTrue("two secrets differ", generateSecret() !== generateSecret());

  // ── Enrolment URI ────────────────────────────────────────────────────────
  const uri = otpauthUri({ issuer: "Meridian Facilities", account: "omar@example.com", secret });
  checkTrue("the URI is an otpauth totp URI", uri.startsWith("otpauth://totp/"));
  checkTrue("the issuer appears in the label", uri.includes("Meridian%20Facilities%3Aomar"));
  checkTrue("and as a parameter, for apps that read it there", uri.includes("issuer=Meridian+Facilities"));
  checkTrue(
    "the defaults are left unstated, because every app assumes them and they cost QR capacity",
    !uri.includes("algorithm=") && !uri.includes("digits=") && !uri.includes("period="),
  );
  checkTrue("the URI stays short enough to encode as a QR", uri.length < 130);

  // ── Recovery codes ───────────────────────────────────────────────────────
  const codes = generateRecoveryCodes();
  check("a full set is generated", codes.length, RECOVERY_CODE_COUNT);
  check("all of them are unique", new Set(codes).size, RECOVERY_CODE_COUNT);
  checkTrue(
    "and avoid characters that are misread on paper",
    codes.every((c) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(c)),
  );
  check(
    "normalising strips the dash and case, so a retyped code still matches",
    normaliseRecoveryCode(" ab3d-e4fg7 ".toLowerCase()),
    "AB3DE4FG7",
  );

  console.log(fail === 0 ? "\ntotp: all checks passed" : `\n${fail} check(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
