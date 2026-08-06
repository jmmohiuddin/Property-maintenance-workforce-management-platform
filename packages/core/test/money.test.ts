import {
  toMinor,
  toDecimalString,
  lineTotalMinor,
  computeTotals,
  formatMoney,
  UAE_VAT_BASIS_POINTS,
} from "@meridian/core";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}

// ── Parsing and rendering round-trip ────────────────────────────────────────
check("parse '150.00'", toMinor("150.00"), 15000);
check("parse '0.05'", toMinor("0.05"), 5);
check("parse '1250.5' (one decimal)", toMinor("1250.5"), 125050);
check("parse '-42.75'", toMinor("-42.75"), -4275);
check("render 15000", toDecimalString(15000), "150.00");
check("render 5", toDecimalString(5), "0.05");
check("render -4275", toDecimalString(-4275), "-42.75");

// The classic float failure. 0.1 + 0.2 !== 0.3 in IEEE 754.
check(
  "0.10 + 0.20 is exactly 0.30",
  toDecimalString(toMinor("0.10") + toMinor("0.20")),
  "0.30",
);

// ── Fractional quantities (m², hours) ───────────────────────────────────────
check("2.5 m² at AED 45.00", lineTotalMinor({ quantity: "2.5", unitPriceMinor: 4500 }), 11250);
check("0.333 at AED 100.00", lineTotalMinor({ quantity: "0.333", unitPriceMinor: 10000 }), 3330);
check("1 at AED 150.00", lineTotalMinor({ quantity: "1", unitPriceMinor: 15000 }), 15000);

// ── Totals with VAT ─────────────────────────────────────────────────────────
const simple = computeTotals({
  lines: [
    { quantity: "1", unitPriceMinor: 15000 }, // 150.00 call-out
    { quantity: "2.5", unitPriceMinor: 4500 }, // 112.50 materials
  ],
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});
check("subtotal 262.50", toDecimalString(simple.subtotalMinor), "262.50");
check("VAT at 5% = 13.13", toDecimalString(simple.taxMinor), "13.13");
check("total 275.63", toDecimalString(simple.totalMinor), "275.63");

// Tax must be charged on the discounted amount, not the list price. Getting
// this backwards overstates the tax the business has to remit.
const discounted = computeTotals({
  lines: [{ quantity: "1", unitPriceMinor: 100000 }], // 1000.00
  discountMinor: 10000, // 100.00
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});
check("discounted subtotal 1000.00", toDecimalString(discounted.subtotalMinor), "1000.00");
check("VAT on 900, not 1000", toDecimalString(discounted.taxMinor), "45.00");
check("discounted total 945.00", toDecimalString(discounted.totalMinor), "945.00");

// A discount larger than the subtotal must not produce a negative invoice.
const overDiscount = computeTotals({
  lines: [{ quantity: "1", unitPriceMinor: 5000 }],
  discountMinor: 999999,
  taxRateBasisPoints: UAE_VAT_BASIS_POINTS,
});
check("discount is capped at subtotal", toDecimalString(overDiscount.totalMinor), "0.00");

// ── The sum of the lines must equal the total a customer recomputes ─────────
const many = Array.from({ length: 37 }, () => ({ quantity: "1.333", unitPriceMinor: 999 }));
const totals = computeTotals({ lines: many, taxRateBasisPoints: 0 });
const byHand = many.reduce((s, l) => s + lineTotalMinor(l), 0);
check("37 fractional lines sum exactly", totals.subtotalMinor, byHand);

// ── Formatting ──────────────────────────────────────────────────────────────
check("format 1250000", formatMoney(1250000), "AED 12,500.00");
check("format 5", formatMoney(5), "AED 0.05");

console.log(`\n${fail === 0 ? "money: all checks passed" : `${fail} FAILING`}`);
process.exit(fail === 0 ? 0 : 1);
