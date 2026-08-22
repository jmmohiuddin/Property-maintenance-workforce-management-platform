/**
 * Base64, in pure TypeScript.
 *
 * Needed by the upload path (`sync/upload-orchestrator.ts` reads chunks as
 * bytes, but `expo-file-system`'s only synchronous-friendly way to read a
 * slice of a file is `readAsStringAsync({ encoding: "base64", position,
 * length })`) and no dependency on a global `atob`/`btoa` - neither is
 * guaranteed present on Hermes - is worth adding for twenty lines of a
 * fully-specified encoding (RFC 4648).
 */

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REVERSE: Readonly<Record<string, number>> = Object.fromEntries(
  CHARS.split("").map((c, i) => [c, i]),
);

export function base64Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += CHARS[b0 >> 2];
    out += CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : CHARS[b2 & 0x3f];
  }
  return out;
}

export function base64Decode(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = REVERSE[clean[i] as string] ?? 0;
    const c1 = clean[i + 1] !== undefined ? (REVERSE[clean[i + 1] as string] ?? 0) : undefined;
    const c2 = clean[i + 2] !== undefined ? (REVERSE[clean[i + 2] as string] ?? 0) : undefined;
    const c3 = clean[i + 3] !== undefined ? (REVERSE[clean[i + 3] as string] ?? 0) : undefined;

    if (c1 === undefined) break;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 !== undefined) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 !== undefined) bytes.push(((c2 ?? 0) & 0x03) << 6 | c3);
  }
  return Uint8Array.from(bytes);
}
