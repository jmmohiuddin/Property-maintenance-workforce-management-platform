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
  statusCritical: "#e11d48",
  statusCriticalText: "#9f1239",
  statusCriticalWash: "#ffe4e9",
  statusBlocked: "#4f46e5",
  statusBlockedText: "#3730a3",
  statusBlockedWash: "#e6e6fb",
  statusWarningText: "#92400e",
  statusWarningWash: "#fdf0d5",
  statusSuccessText: "#15803d",
  statusSuccessWash: "#dcfce7",
  statusInfoText: "#1d4ed8",
  statusInfoWash: "#dbeafe",
  statusNeutralText: "#46566a",
  statusNeutralWash: "#eef1f4",
  focusRing: "#c1450d",
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
  statusCritical: "#fb7185",
  statusCriticalText: "#fb7185",
  statusCriticalWash: "#3d1220",
  statusBlocked: "#a5b4fc",
  statusBlockedText: "#a5b4fc",
  statusBlockedWash: "#1e1b4b",
  statusWarningText: "#fbbf24",
  statusWarningWash: "#3a2a08",
  statusSuccessText: "#4ade80",
  statusSuccessWash: "#0c2f1a",
  statusInfoText: "#93c5fd",
  statusInfoWash: "#14264d",
  statusNeutralText: "#94a3b4",
  statusNeutralWash: "#1b222b",
  focusRing: "#ef7434",
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

/** Hue angle in degrees, 0-360. */
function hue(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;

  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;

  return ((h * 60) % 360 + 360) % 360;
}

/** Shortest angular distance between two hues, 0-180. */
function hueSeparation(a, b) {
  const diff = Math.abs(hue(a) - hue(b)) % 360;
  return diff > 180 ? 360 - diff : diff;
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

  // D-7. Status tokens carry compliance copy — a penalty in AED — so they are
  // held to the body threshold, not the large-text one.
  cases.push([`${name}: critical text on its wash`, t.statusCriticalText, t.statusCriticalWash, AA_BODY]);
  cases.push([`${name}: critical text on raised`, t.statusCriticalText, t.raised, AA_BODY]);
  cases.push([`${name}: critical fill against raised`, t.statusCritical, t.raised, AA_LARGE]);
  cases.push([`${name}: blocked text on its wash`, t.statusBlockedText, t.statusBlockedWash, AA_BODY]);
  cases.push([`${name}: blocked text on raised`, t.statusBlockedText, t.raised, AA_BODY]);
  cases.push([`${name}: blocked fill against raised`, t.statusBlocked, t.raised, AA_LARGE]);

  for (const [status, text, wash] of [
    ["warning", t.statusWarningText, t.statusWarningWash],
    ["success", t.statusSuccessText, t.statusSuccessWash],
    ["info", t.statusInfoText, t.statusInfoWash],
    ["neutral", t.statusNeutralText, t.statusNeutralWash],
  ]) {
    cases.push([`${name}: ${status} text on its wash`, text, wash, AA_BODY]);
    cases.push([`${name}: ${status} text on raised`, text, t.raised, AA_BODY]);
  }

  // A11Y-3. The focus ring is a non-text indicator, so 3:1 — but against every
  // surface it can appear on, because a ring that vanishes on one background is
  // a ring that fails exactly where somebody is lost.
  for (const [sName, surface] of surfaces) {
    cases.push([`${name}: focus ring against ${sName}`, t.focusRing, surface, AA_LARGE]);
  }

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

/*
 * D-7, checked properly.
 *
 * "Impossible" must not look like "urgent" — a dispatcher under time pressure
 * should never have to read carefully to tell a hard block from an urgent item.
 *
 * The measure is HUE separation, not contrast ratio. Contrast ratio compares
 * lightness, and two colours can be near-identical in luminance while being
 * completely different hues — which is exactly the case here, and is why the
 * first version of this check failed a pairing that is in fact obviously
 * distinguishable. Measuring the wrong quantity precisely is still measuring
 * the wrong quantity.
 *
 * 60 degrees is roughly the point at which two saturated colours stop being
 * describable by the same word.
 */
const HUE_MIN_SEPARATION = 60;

for (const [name, t] of [["light", LIGHT], ["dark", DARK]]) {
  const separation = hueSeparation(t.statusBlocked, t.statusCritical);
  const ok = separation >= HUE_MIN_SEPARATION;
  if (!ok) failed++;
  console.log(
    `${ok ? "  ok  " : "  FAIL"}  ${separation.toFixed(0).padStart(5)}\u00b0  (min ${HUE_MIN_SEPARATION}\u00b0)  ${name}: blocked hue is distinct from critical`,
  );
}

const total = cases.length + 2;
console.log(
  `\n${total - failed}/${total} checks pass${failed ? ` - ${failed} FAILING` : ". "}`,
);

process.exit(failed > 0 ? 1 : 0);
