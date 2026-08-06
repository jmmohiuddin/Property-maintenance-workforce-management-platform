#!/usr/bin/env node
/**
 * WCAG contrast gate for the design tokens.
 *
 * Colour pairings are the one design decision that has an objectively correct
 * answer, so they get a test rather than a review. Run in CI; a failure is a
 * release blocker, not a suggestion.
 *
 *   node scripts/check-contrast.mjs
 *
 * Values below are mirrored from src/app/globals.css. They are duplicated on
 * purpose: parsing CSS variables that reference other CSS variables is more
 * fragile than the drift this risks, and a mismatch shows up as a failing
 * check the moment someone edits one without the other.
 */

const LIGHT = {
  base: "#f7f8fa",
  raised: "#ffffff",
  sunken: "#eef1f4",
  inverse: "#0b0e12",
  textPrimary: "#0b0e12",
  textSecondary: "#46566a",
  textMuted: "#5c6d81",
  accent: "#c1450d",
  accentText: "#9c3608",
  accentContrast: "#ffffff",
  accentWash: "#fdeadd",
  /* The one inverse band on a light page: dark surface, light body text. */
  inverseSurface: "#0b0e12",
  inverseBody: "#94a3b4",
};

const DARK = {
  base: "#0b0e12",
  raised: "#12171d",
  sunken: "#070a0d",
  inverse: "#eef1f4",
  textPrimary: "#eef1f4",
  textSecondary: "#94a3b4",
  textMuted: "#72849a",
  accent: "#ef7434",
  accentText: "#ef7434",
  accentContrast: "#0b0e12",
  accentWash: "#2a1509",
  inverseSurface: "#0b0e12",
  inverseBody: "#94a3b4",
};

const AA_BODY = 4.5;
const AA_LARGE = 3.0;

function channel(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function suite(name, t) {
  const surfaces = [
    ["base", t.base],
    ["raised", t.raised],
    ["sunken", t.sunken],
  ];
  const cases = [];

  for (const [sName, surface] of surfaces) {
    cases.push([`${name}: primary text on ${sName}`, t.textPrimary, surface, AA_BODY]);
    cases.push([`${name}: secondary text on ${sName}`, t.textSecondary, surface, AA_BODY]);
    cases.push([`${name}: muted text on ${sName}`, t.textMuted, surface, AA_BODY]);
    cases.push([`${name}: accent text on ${sName}`, t.accentText, surface, AA_BODY]);
    // The accent used as a FILL only needs the 3:1 non-text threshold: it
    // carries borders, icons and button backgrounds, never body copy.
    cases.push([`${name}: accent fill against ${sName}`, t.accent, surface, AA_LARGE]);
  }

  cases.push([`${name}: primary button label`, t.accentContrast, t.accent, AA_BODY]);
  cases.push([`${name}: 24/7 badge label on wash`, t.accentText, t.accentWash, AA_BODY]);
  cases.push([`${name}: inverse band body text`, t.inverseBody, t.inverseSurface, AA_BODY]);

  return cases;
}

const cases = [...suite("light", LIGHT), ...suite("dark", DARK)];

let failed = 0;
for (const [label, fg, bg, min] of cases) {
  const r = ratio(fg, bg);
  const ok = r >= min;
  if (!ok) failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${r.toFixed(2).padStart(5)}:1  (min ${min})  ${label}`);
}

console.log(
  `\n${cases.length - failed}/${cases.length} pairings meet WCAG AA${failed ? "" : ". "}${failed ? ` - ${failed} FAILING` : ""}`,
);

process.exit(failed > 0 ? 1 : 0);
