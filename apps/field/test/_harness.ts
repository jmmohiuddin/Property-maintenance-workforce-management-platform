/**
 * A twenty-line test harness, matching the style the rest of the repository
 * uses: plain `tsx` scripts, one line per check, non-zero exit on failure. No
 * test framework, because adding one to a workspace whose dependencies are not
 * installed would mean these tests could not run at all.
 */

let failures = 0;
let checks = 0;

export function check(label: string, ok: boolean, detail?: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? ` - ${detail}` : ""}`);
}

export function equal<T>(label: string, actual: T, expected: T): void {
  const ok = Object.is(actual, expected);
  check(label, ok, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function deepEqual(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  check(label, a === b, `expected ${b}, got ${a}`);
}

export function done(suite: string): void {
  console.log(`\n${suite}: ${checks} checks, ${failures === 0 ? "all passed" : `${failures} FAILING`}`);
  process.exit(failures === 0 ? 0 : 1);
}
