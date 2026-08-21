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

// ── ATS-9's office formats ──────────────────────────────────────────────────
check("RTF", sniffContentType(bytes(...ascii("{\\rtf1\\ansi"))), "application/rtf");

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const utf16 = (s: string): number[] => [...s].flatMap((c) => [c.charCodeAt(0), 0]);

check(
  "legacy .doc — compound file carrying Word's own stream",
  sniffContentType(bytes(...CFB, ...new Array(120).fill(0), ...utf16("WordDocument"))),
  "application/msword",
);
// The header alone is not the answer. A spreadsheet and an Outlook message use
// the identical container, and calling one of those `application/msword` would
// hand a recruiter a file that opens as something other than what it says.
check(
  "a compound file with no Word stream is refused",
  sniffContentType(bytes(...CFB, ...new Array(120).fill(0), ...utf16("Workbook"))),
  null,
);

/**
 * A minimal STORED (uncompressed) ZIP, built by hand.
 *
 * Real archives from Word are deflated, but the sniffer reads only the central
 * directory — names, lengths and offsets — and never the entry data, so a
 * stored archive exercises exactly the code that runs. Building it here rather
 * than checking in a binary fixture keeps what is being tested readable.
 */
function zip(entries: readonly string[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const u16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
  const u32 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];

  for (const name of entries) {
    const offset = local.length;
    const body = ascii("x");
    const nameBytes = ascii(name);
    local.push(
      ...ascii("PK\x03\x04"), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(body.length), ...u32(body.length),
      ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...body,
    );
    central.push(
      ...ascii("PK\x01\x02"), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(body.length), ...u32(body.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset), ...nameBytes,
    );
  }

  return new Uint8Array([
    ...local, ...central,
    ...ascii("PK\x05\x06"), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(local.length), ...u16(0),
  ]);
}

check(
  "docx — an OPC package with a Word part",
  sniffContentType(zip(["[Content_Types].xml", "word/document.xml", "docProps/app.xml"])),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
);
check(
  "xlsx is not a Word document",
  sniffContentType(zip(["[Content_Types].xml", "xl/workbook.xml"])),
  null,
);
check("a plain ZIP is refused", sniffContentType(zip(["notes.txt", "run.sh"])), null);
// A JAR is a ZIP whose first bytes are identical. Nothing distinguishes it from
// a docx except the directory, which is the reason the directory is read.
check("a JAR is refused", sniffContentType(zip(["META-INF/MANIFEST.MF", "Main.class"])), null);
check("a truncated ZIP with no end record is refused", sniffContentType(bytes(0x50, 0x4b, 0x03, 0x04, 0, 0)), null);

// ── .txt is refused, deliberately and permanently ───────────────────────────
// ATS-9 names it. It has no header, so accepting it means believing the
// browser — and every one of these is "plain text" to a sniffer.
for (const [label, content] of [
  ["a CV as plain text", "Ahmed Hassan\nElectrician, 8 years\n"],
  ["an HTML page", "<!doctype html><script>fetch('/api')</script>"],
  ["a shell script", "#!/bin/sh\nrm -rf /\n"],
] as const) {
  check(`.txt: ${label} is refused`, sniffContentType(bytes(...ascii(content))), null);
}

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
