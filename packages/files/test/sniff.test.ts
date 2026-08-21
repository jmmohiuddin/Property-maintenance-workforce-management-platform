import { sniffContentType, safeFilename, downloadHeaders } from "@meridian/files";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

// ── The formats this store holds ────────────────────────────────────────────
check("PDF", sniffContentType(bytes(...ascii("%PDF-1.7\n"))), "application/pdf");
check("PNG", sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
check("JPEG", sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
check(
  "WebP",
  sniffContentType(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP"))),
  "image/webp",
);
check("HEIC", sniffContentType(bytes(0, 0, 0, 0x18, ...ascii("ftypheic"))), "image/heic");

// ── Everything else is refused ──────────────────────────────────────────────
// SVG and HTML are the two that matter: both execute script, and both would
// pass any check that trusted a declared MIME type or a file extension.
check("SVG", sniffContentType(bytes(...ascii('<svg xmlns="http://www.w3.org/2000/svg">'))), null);
check("HTML", sniffContentType(bytes(...ascii("<!doctype html><script>"))), null);
check("empty", sniffContentType(bytes()), null);
check("plain text", sniffContentType(bytes(...ascii("hello"))), null);

// A RIFF container that is not WebP. Checking only the first four bytes would
// have let a WAV through as an image.
check("RIFF/WAVE is not WebP", sniffContentType(bytes(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"))), null);

// Truncated signatures must not match on a partial read.
check("truncated PNG", sniffContentType(bytes(0x89, 0x50, 0x4e)), null);

// ── Filenames cannot end the header early ───────────────────────────────────
check("quotes removed", safeFilename('SATS"; drop.pdf', "application/pdf"), "SATS-drop.pdf");
check("newline removed", safeFilename("SATS\r\nSet-Cookie: x.pdf", "application/pdf"), "SATS-Set-Cookie-x.pdf");
check("path removed", safeFilename("../../etc/passwd", "application/pdf"), "etc-passwd.pdf");
check("extension not doubled", safeFilename("SATS-INV-2026-0184.pdf", "application/pdf"), "SATS-INV-2026-0184.pdf");
check("empty stem still names something", safeFilename("///", "application/pdf"), "document.pdf");

// ── Download headers ────────────────────────────────────────────────────────
const headers = downloadHeaders({
  object: { contentType: "application/pdf", sizeBytes: 4096, sha256: "a".repeat(64) },
  filename: "SATS-INV-2026-0184",
});
check("attachment, never inline", headers.get("Content-Disposition")?.startsWith("attachment;"), true);
check("nosniff", headers.get("X-Content-Type-Options"), "nosniff");
check("not shared-cacheable", headers.get("Cache-Control"), "private, no-store, max-age=0");
check("exact type", headers.get("Content-Type"), "application/pdf");
check("etag is the hash", headers.get("ETag"), `"${"a".repeat(64)}"`);

console.log(`\n${fail === 0 ? "files/sniff: all checks passed" : `${fail} FAILING`}`);
process.exit(fail === 0 ? 0 : 1);
