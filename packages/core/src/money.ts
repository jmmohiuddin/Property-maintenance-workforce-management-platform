/**
 * Money.
 *
 * Amounts are handled as integer **minor units** (fils, cents) and only ever
 * converted to a decimal string at the database boundary. No float touches a
 * total at any point.
 *
 * This is not pedantry. `0.1 + 0.2 !== 0.3` in IEEE 754, and a quotation whose
 * total is off by a fil is a quotation an accountant will not sign off. Storing
 * `numeric(14,2)` in Postgres protects the value at rest; this protects the
 * arithmetic that produces it.
 *
 * Drizzle returns `numeric` as a string, so the round trip is
 * string -> minor units -> arithmetic -> string, never string -> number.
 */

/** Parse a `numeric(14,2)` string (or a plain decimal) into minor units. */
export function toMinor(decimal: string | number): number {
  const s = typeof decimal === "number" ? decimal.toFixed(2) : decimal.trim();
  if (s === "") return 0;

  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  // Pad or truncate to exactly two decimal places without going through a float.
  const cents = (frac + "00").slice(0, 2);
  const value = Number(whole) * 100 + Number(cents);
  return negative ? -value : value;
}

/** Render minor units as the `numeric(14,2)` string the database expects. */
export function toDecimalString(minor: number): string {
  const rounded = Math.round(minor);
  const negative = rounded < 0;
  const abs = Math.abs(rounded);
  return `${negative ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Human-readable, e.g. "AED 1,250.00". */
export function formatMoney(minor: number, currency = "AED"): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toLocaleString("en-AE");
  return `${negative ? "-" : ""}${currency} ${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export interface LineInput {
  /** Decimal string, e.g. "2.500". Supports fractional quantities (m², hours). */
  readonly quantity: string;
  /** Unit price in minor units. */
  readonly unitPriceMinor: number;
}

/**
 * Line total, in minor units.
 *
 * Quantity carries up to three decimals (m², hours), so it is scaled by 1000
 * and divided back out, with a single rounding step at the end. Rounding once
 * per line rather than accumulating fractional fils is what keeps the sum of
 * the lines equal to the total a customer can recompute by hand.
 */
export function lineTotalMinor(line: LineInput): number {
  const qtyThousandths = Math.round(toMinorScaled(line.quantity, 3));
  return Math.round((qtyThousandths * line.unitPriceMinor) / 1000);
}

function toMinorScaled(decimal: string, places: number): number {
  const s = decimal.trim();
  if (s === "") return 0;
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  const scaled = (frac + "0".repeat(places)).slice(0, places);
  const value = Number(whole) * 10 ** places + Number(scaled);
  return negative ? -value : value;
}

export interface DocumentTotals {
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
}

/**
 * Totals for a quote or invoice.
 *
 * Tax is applied AFTER the discount, which is the normal treatment: VAT is due
 * on what the customer actually pays, not on the pre-discount list price.
 * Getting this the wrong way round overstates the tax and understates the
 * business's margin.
 */
export function computeTotals(input: {
  lines: readonly LineInput[];
  discountMinor?: number;
  /** Basis points, so 500 = 5.00%. Integer, so no float creeps in. */
  taxRateBasisPoints: number;
}): DocumentTotals {
  const subtotalMinor = input.lines.reduce((sum, l) => sum + lineTotalMinor(l), 0);
  const discountMinor = Math.min(input.discountMinor ?? 0, subtotalMinor);
  const taxable = subtotalMinor - discountMinor;
  const taxMinor = Math.round((taxable * input.taxRateBasisPoints) / 10_000);

  return {
    subtotalMinor,
    discountMinor,
    taxMinor,
    totalMinor: taxable + taxMinor,
  };
}

/** UAE VAT, in basis points. */
export const UAE_VAT_BASIS_POINTS = 500;
