import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStore, sha256Hex, assertValidKey } from "@meridian/files";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}

async function refuses(label: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    fail++;
    console.log(`FAIL  ${label} — it was allowed`);
  } catch {
    console.log(`ok    ${label}`);
  }
}

const PDF = new Uint8Array([...[..."%PDF-1.7\n%\xB5\xB5\xB5\xB5\n"].map((c) => c.charCodeAt(0) & 0xff)]);

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "meridian-files-"));
  const store = new LocalFileStore(root);

  // ── Round trip ────────────────────────────────────────────────────────────
  const key = "tenants/t1/documents/tax-invoice/2026/sats-inv-2026-0184.pdf";
  const stored = await store.put({ key, body: PDF, declaredContentType: "application/pdf" });

  check("type comes from the bytes", stored.contentType, "application/pdf");
  check("size recorded", stored.sizeBytes, PDF.length);
  check("hash recorded", stored.sha256, sha256Hex(PDF));

  const read = await store.get(key);
  check("bytes come back identical", read ? sha256Hex(read.body) : "missing", sha256Hex(PDF));
  check("head agrees with get", (await store.head(key))?.sha256, stored.sha256);
  check("absent key is null, not an error", await store.head("tenants/t1/nothing.pdf"), null);

  // ── Write-once (OPS-6) ────────────────────────────────────────────────────
  // The artefact whose hash is on the invoice row must never be replaced by a
  // re-render, because the hash is the evidence of what the customer received.
  await refuses("an existing key cannot be overwritten", () =>
    store.put({ key, body: PDF, declaredContentType: "application/pdf" }),
  );

  // ── SEC-8: the declared type never wins ───────────────────────────────────
  const svg = new Uint8Array([...'<svg onload="fetch(0)">'].map((c) => c.charCodeAt(0)));
  await refuses("an SVG declared as a PDF is refused", () =>
    store.put({ key: "tenants/t1/evil.pdf", body: svg, declaredContentType: "application/pdf" }),
  );
  await refuses("an unrecognised format is refused outright", () =>
    store.put({ key: "tenants/t1/unknown.bin", body: new Uint8Array([1, 2, 3, 4]) }),
  );
  await refuses("a caller that disagrees with its own bytes is refused", () =>
    store.put({ key: "tenants/t1/mismatch.pdf", body: PDF, declaredContentType: "image/png" }),
  );
  await refuses("an empty object is refused", () =>
    store.put({ key: "tenants/t1/empty.pdf", body: new Uint8Array() }),
  );

  // ── Keys are paths, and paths traverse ────────────────────────────────────
  for (const bad of [
    "../../../etc/passwd",
    "tenants/../../secret",
    "/absolute/path.pdf",
    "tenants//double.pdf",
    "Tenants/Uppercase.pdf",
    "tenants/trailing/",
    "",
  ]) {
    let refused = false;
    try {
      assertValidKey(bad);
    } catch {
      refused = true;
    }
    check(`key ${JSON.stringify(bad)} refused`, refused, true);
  }

  // ── Bit-rot is detected on read, not on the auditor's desk ────────────────
  // INV-15 keeps these for seven years. A stored tax document whose bytes have
  // changed is not something to serve quietly.
  const rotKey = "tenants/t1/documents/rot.pdf";
  await store.put({ key: rotKey, body: PDF });
  await writeFile(join(root, rotKey), Buffer.concat([Buffer.from(PDF), Buffer.from("tampered")]));
  await refuses("altered bytes are refused on read", () => store.get(rotKey));

  await rm(root, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? "files/store: all checks passed" : `${fail} FAILING`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
