/**
 * How figures and dates appear on a document.
 *
 * ── WHY THIS DOES NOT USE `Intl` ────────────────────────────────────────────
 *
 * `formatMoney` in `@meridian/core` groups thousands with
 * `toLocaleString("en-AE")`, which is right for a screen and wrong here. The
 * output of `Intl` depends on the ICU data compiled into the runtime: a Node
 * built with `small-icu` resolves `en-AE` to `en-US`, a different Node version
 * ships a different CLDR release, and a serverless runtime may ship neither.
 * All three produce a *plausible* string, and any of them changing would change
 * the bytes of a rendered invoice and therefore its SHA-256 — the hash that is
 * stored on the row and is the evidence of what was issued.
 *
 * A grouping rule that is four lines of arithmetic cannot drift. So it is four
 * lines of arithmetic.
 *
 * ── WHY THE AED PREFIX IS ON EVERY FIGURE ───────────────────────────────────
 *
 * Design doc §8.2: *money is right-aligned, tabular, always with the AED
 * prefix, always two decimals.* Repeating the currency on every line costs
 * column width and is worth it — a bare `450.00` on a document that also
 * carries an exchange rate is genuinely ambiguous, and the person reading it
 * may be an auditor rather than the customer who agreed the price.
 */

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** `2026-08-12` → `12 Aug 2026`. The PRD's document date format. */
export function documentDate(iso: string | null): string {
  if (!iso) return "";
  const [year, month, day] = iso.split("-");
  const name = MONTHS[Number(month) - 1];
  if (!year || !day || !name) return iso;
  return `${day} ${name} ${year}`;
}

/** Thousands separators, without a locale database. */
function group(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return out;
}

/** `137025` → `1,370.25`. Two decimals always, including on a whole number. */
export function amount(minor: number): string {
  const rounded = Math.round(minor);
  const abs = Math.abs(rounded);
  const body = `${group(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
  return rounded < 0 ? `-${body}` : body;
}

/** `137025` → `AED 1,370.25`. */
export function money(minor: number, currency = "AED"): string {
  return `${currency} ${amount(minor)}`;
}

/**
 * `500` → `5%`, `1250` → `12.5%`.
 *
 * Trailing zeros are trimmed because "5.00%" on a line beside "5%" in the
 * totals block reads as two different rates to somebody scanning quickly.
 */
export function rate(basisPoints: number): string {
  const percent = basisPoints / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2).replace(/0+$/, "")}%`;
}

/**
 * A quantity as it was entered, with trailing zeros removed.
 *
 * `numeric(12,3)` comes back from Postgres as `2.500`, and a document that says
 * a technician spent `2.500` hours on site looks like a machine wrote it.
 * `2.5` is the same number and reads as a person's record of the work.
 */
export function quantity(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes(".")) return trimmed;
  return trimmed.replace(/\.?0+$/, "") || "0";
}

/** Joins the parts that exist, dropping the ones that do not. */
export function joinPresent(parts: readonly (string | null | undefined)[], separator = " · "): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(separator);
}
