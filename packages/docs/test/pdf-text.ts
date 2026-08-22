import { inflateSync } from "node:zlib";

/**
 * Text back out of a PDF.
 *
 * pdf-lib Flate-compresses its content streams and writes strings as hex rather
 * than as literals, so drawn text is not visible in the raw bytes — a naive
 * search would report every field missing, or worse, pass on an empty page.
 * Each stream is inflated and the operand of every text-showing operator
 * decoded.
 *
 * This lives in its own module because two test files need it and a copy in
 * each is a copy that gets fixed in one of them.
 */
export function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const marker = /stream\r?\n/g;
  let out = "";
  let match: RegExpExecArray | null;

  while ((match = marker.exec(raw)) !== null) {
    const start = match.index + match[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;

    let body: string;
    try {
      body = inflateSync(Buffer.from(raw.slice(start, end), "latin1")).toString("latin1");
    } catch {
      continue; // Not a Flate stream.
    }

    for (const showing of body.matchAll(/(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\()])*\))\s*(?:Tj|TJ|'|")/g)) {
      const token = showing[1] ?? "";
      if (token.startsWith("<")) {
        const hex = token.slice(1, -1).replace(/\s+/g, "");
        for (let i = 0; i + 1 < hex.length; i += 2) {
          out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
      } else {
        out += token
          .slice(1, -1)
          .replace(/\\([nrtbf()\\])/g, (_, c: string) =>
            ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c] ?? c,
          );
      }
      out += "\n";
    }
  }

  return out;
}
