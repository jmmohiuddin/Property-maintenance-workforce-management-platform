/**
 * Catalogue and company-identity unit test.
 *
 * The invariant this file exists to hold: **the service catalogue may not
 * exceed the trade licence.** That is not a style rule. Quoting for work
 * outside the licensed activities is a licensing exposure, and a public page
 * advertising it is the same exposure with a URL attached — which is exactly
 * what the previous 24-service catalogue was, against a ten-activity licence.
 *
 * The second half is the content-truth rule from `WEB-2`, expressed as
 * assertions: unset identity is `null` and never a plausible placeholder, and
 * no fabricated statistic can come back without failing a check first.
 *
 *   npm run test --workspace=@meridian/core
 *
 * No database required.
 */

import {
  services,
  getService,
  groupedServices,
  relatedServices,
  catalogueLicenceMismatches,
  CATEGORY_ORDER,
} from "../src/catalog";
import {
  company,
  LICENSED_ACTIVITIES,
  LICENSED_ACTIVITY_REGISTER,
  missingRequiredFields,
  legalIdentityLine,
  placeholderSignal,
  identityProblems,
  assertPublishableIdentity,
} from "../src/company";
import { tenant } from "../src/tenant";
import { areas, cities } from "../src/areas";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

console.log("\n— the catalogue may not exceed the licence —");

check("the licence permits ten activities", LICENSED_ACTIVITIES.length, 10);
check("the register matches the activity list", LICENSED_ACTIVITY_REGISTER.length, LICENSED_ACTIVITIES.length);

// The load-bearing assertion. `catalogueLicenceMismatches()` checks both
// directions: no service names an activity that is not on the licence, and no
// licensed activity is left without a page (WEB-1 requires one each).
const mismatches = catalogueLicenceMismatches();
for (const problem of mismatches) console.log(`      ${problem}`);
check("no mismatch between catalogue and licence", mismatches.length, 0);

check("one service per licensed activity", services.length, LICENSED_ACTIVITIES.length);

const slugs = new Set(services.map((s) => s.slug));
check("no duplicate service slugs", slugs.size, services.length);

// A dangling `related` slug is how the old catalogue's deletions would have
// leaked into a rendered page as a missing card.
const dangling = services.flatMap((s) => s.related.filter((r) => !slugs.has(r)));
for (const d of dangling) console.log(`      dangling related slug: ${d}`);
check("no dangling related-service references", dangling.length, 0);

checkTrue(
  "every service resolves both ways",
  services.every((s) => getService(s.slug)?.slug === s.slug),
);
checkTrue(
  "relatedServices never returns undefined entries",
  services.every((s) => relatedServices(s).every(Boolean)),
);

const grouped = groupedServices();
check(
  "grouping loses nothing",
  grouped.reduce((n, g) => n + g.items.length, 0),
  services.length,
);
checkTrue(
  "every group is a known family",
  grouped.every((g) => CATEGORY_ORDER.includes(g.category)),
);

console.log("\n— content truth (WEB-2) —");

// Prices were the largest single block of fabrication in the old catalogue.
// There is no `priceFrom` on the Service type any more; this asserts that no
// service object smuggles one back in as an untyped extra property.
const withPrice = services.filter((s) => "priceFrom" in s);
check("no service carries a price", withPrice.length, 0);

check("no headline statistics are published", tenant.stats.length, 0);
check("no accreditations are claimed", tenant.certifications.length, 0);
check("no social accounts are claimed", Object.keys(tenant.social).length, 0);

// The old profile claimed Abu Dhabi and Sharjah coverage on a Dubai mainland
// licence, with a page and a stated arrival time for each area.
check("coverage is one licensed emirate", cities.length, 1);
check("and that emirate is Dubai", cities[0]?.name, "Dubai");
checkTrue("every area page is in Dubai", areas.every((a) => a.city === "Dubai"));

// Every area page must carry substance that is only true of that area,
// otherwise it is a doorway page wearing a place name.
checkTrue("every area states real local issues", areas.every((a) => a.commonIssues.length >= 2));

// The specific fabrications, named, so reintroducing one is a failing test
// rather than a paragraph nobody re-reads.
const corpus = JSON.stringify({ services, tenant, areas }).toLowerCase();
for (const banned of ["62,000", "900+", "180+", "94%", "iso 9001", "iso 45001", "iso 14001", "10,000,000", "ded-000000", "meridian", "picsum"]) {
  check(`the "${banned}" claim stays deleted`, corpus.includes(banned), false);
}

console.log("\n— company identity (ADM-9) —");

check("the licence number is the real one", company.licenceNumber, "930137");
check("the licence expiry is recorded", company.licenceExpiry, "2027-01-23");

// The rule that matters most: an unconfigured value is null, never a
// placeholder that would be rendered as though it were a fact.
for (const [name, value] of [
  ["CR number", company.crNumber],
  ["TRN", company.trn],
] as const) {
  checkTrue(
    `${name} is null or a real value, never a placeholder`,
    value === null || (value.length > 0 && !/^[0X\-\s]+$/i.test(value)),
  );
}

// The legal line omits what is unset rather than printing a gap.
const line = legalIdentityLine();
checkTrue("the legal identity line always names the company", line.startsWith(company.legalName));
check("and omits the TRN when unset", line.includes("TRN"), company.trn !== null);

// This is informational rather than a failure: an unconfigured deployment is a
// normal state during development, and the list is what tells an operator what
// is still missing before launch.
const missing = missingRequiredFields();
console.log(`\n      ${missing.length} identity field(s) still unset:`);
for (const m of missing) console.log(`        ${m.field} (${m.envVar}) — blocks ${m.blocks}`);

console.log("\n— placeholder detection must not reject real values —");

// THE regression this section exists for. The first version of
// `looksLikePlaceholder` flagged any value containing four consecutive zeros,
// which rejects a real UAE TRN (15 digits, commonly ending ...00003) and an
// ordinary Dubai landline. Because `assertPublishableIdentity` throws in
// production, that would have blocked a legitimate deploy — and the documented
// workaround, ALLOW_PLACEHOLDER_IDENTITY=1, disables the checks that matter.
for (const trn of ["100123456700003", "100474123400003", "100987654300003", "104123456789012"]) {
  check(`a real TRN (${trn}) is accepted`, placeholderSignal(trn, "identifier"), null);
}

for (const phone of ["+971 4 380 0000", "+971 4 501 2000", "+971 50 123 4567", "+971 4 000 1234"]) {
  checkTrue(
    `a real number (${phone}) never blocks a deploy`,
    placeholderSignal(phone, "phone") !== "certain",
  );
}

console.log("\n— but it must still catch the real thing —");

// Certain: blocks a production deploy.
check("the FTA worked-example TRN", placeholderSignal("100000000000003", "identifier"), "certain");
check("an all-zero registration number", placeholderSignal("0000000", "identifier"), "certain");
check("an all-nine registration number", placeholderSignal("99999999", "identifier"), "certain");
check("a sequential registration number", placeholderSignal("12345678", "identifier"), "certain");
check("an RFC 2606 reserved domain", placeholderSignal("service@example.com", "email"), "certain");
check("a literal placeholder word", placeholderSignal("Office 000, Placeholder Tower", "text"), "certain");
check("changeme", placeholderSignal("changeme", "text"), "certain");

// Suspected: reported to an operator, never blocks.
check("an all-zero phone is suspected, not certain", placeholderSignal("+971 4 000 0000", "phone"), "suspected");

// The dev placeholders in .env.example must still be caught, or the guard is
// decorative in exactly the setup it was written for.
const devIdentity = {
  ...company,
  crNumber: "0000000",
  trn: "100000000000003",
  email: "service@example.com",
  address: { ...company.address, street: "Office 000, Placeholder Tower, Business Bay" },
};
const certain = identityProblems(devIdentity).filter((p) => p.confidence === "certain");
checkTrue("the shipped dev placeholders are still caught", certain.length >= 4);

let threw = false;
const previousEnv = process.env["NODE_ENV"];
const previousBypass = process.env["ALLOW_PLACEHOLDER_IDENTITY"];
try {
  process.env["NODE_ENV"] = "production";
  delete process.env["ALLOW_PLACEHOLDER_IDENTITY"];
  assertPublishableIdentity(devIdentity);
} catch {
  threw = true;
} finally {
  if (previousEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = previousEnv;
  if (previousBypass !== undefined) process.env["ALLOW_PLACEHOLDER_IDENTITY"] = previousBypass;
}
checkTrue("and they still refuse a production deploy", threw);

// The other direction, which is the whole point of the fix: a real identity
// deploys, and is not held hostage by a heuristic.
let realThrew = false;
const realIdentity = {
  ...company,
  legalName: "Sumon Akon Technical Services",
  crNumber: "1102345",
  trn: "100474123400003",
  email: "service@sats.ae",
  phone: "+971 4 380 0000",
  emergencyPhone: "+971 50 780 0000",
  whatsapp: "971507800000",
  address: { ...company.address, street: "Office 1204, Bay Square Building 3, Business Bay", lat: 25.18, lng: 55.27 },
};
try {
  process.env["NODE_ENV"] = "production";
  delete process.env["ALLOW_PLACEHOLDER_IDENTITY"];
  assertPublishableIdentity(realIdentity);
} catch {
  realThrew = true;
} finally {
  if (previousEnv === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = previousEnv;
  if (previousBypass !== undefined) process.env["ALLOW_PLACEHOLDER_IDENTITY"] = previousBypass;
}
check("a real identity deploys without a bypass flag", realThrew, false);

console.log(fail === 0 ? "\nAll catalogue checks passed.\n" : `\n${fail} check(s) failed.\n`);
process.exit(fail === 0 ? 0 : 1);
