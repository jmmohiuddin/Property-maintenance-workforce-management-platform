/**
 * RBAC unit test.
 *
 *   npm run test --workspace=@meridian/auth
 *
 * No database required. RBAC is a pure function over two tables in `rbac.ts`,
 * and that is precisely why it needs a test: a table nothing asserts against is
 * a table that widens by accident.
 *
 * ── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * Not coverage of every role against every permission — that would be a
 * transcription of `ROLE_PERMISSIONS` into a second file, and a test that
 * restates its subject catches nothing except a typo in itself. It asserts the
 * three things that are actually load-bearing:
 *
 * **1. The DERIVED grants, which nobody writes down.** `owner: ALL`,
 * `admin: ALL minus settings:write` and `readonly: everything ending in :read`
 * are computed, so adding a permission silently changes what three roles can
 * do. That is usually right and occasionally very wrong — `projects:write`
 * reaching `readonly` would be a bug nobody would notice by reading the file,
 * because the file does not mention it.
 *
 * **2. The BOUNDARIES, asserted as whole sets rather than membership.** The
 * checks below say "exactly these roles hold `contracts:write`", not "sales
 * holds it". The difference is the entire point: a membership check passes
 * happily while a fourth role creeps in beside it, and permission models rot by
 * accretion, never by deletion. Asserting the joined set means the next person
 * who widens a boundary has to change this line and say why.
 *
 * **3. The PAIRINGS that make a separation of duties real.** `PRJ-3` splits the
 * milestone in two — a project manager certifies that a stage of work is done,
 * an accountant allocates the sequential tax-invoice number against it — and
 * that split only works if the accountant can actually open the project. This
 * file exists partly because that case was missed: the accountant held
 * `invoices:create` for a screen they could not load, which is a dead end
 * wearing the costume of a separation of duties.
 */

import {
  PERMISSIONS,
  permissionsForRole,
  can,
  canAll,
  canAny,
  isStaff,
  requirePermission,
  ForbiddenError,
  STAFF_ROLES,
  type Permission,
  type Principal,
  type Role,
} from "../src/rbac";

let fail = 0;
function check(label: string, got: unknown, expected: unknown): void {
  const ok = got === expected;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${ok ? "" : ` — expected ${expected}, got ${got}`}`);
}
function checkTrue(label: string, got: boolean): void {
  check(label, got, true);
}

const ALL_ROLES: readonly Role[] = [
  "owner",
  "admin",
  "operations_manager",
  "dispatcher",
  "supervisor",
  "technician",
  "accountant",
  "sales",
  "hr",
  "customer",
  "readonly",
];

const has = (role: Role, permission: string): boolean =>
  (permissionsForRole(role) as readonly string[]).includes(permission);

/**
 * Every role holding a permission, as one comma-joined string.
 *
 * A set rather than a membership test, deliberately. `checkTrue(has("sales",
 * "contracts:write"))` stays green while three more roles quietly acquire it;
 * this fails, and the failure message names the intruder.
 */
const holders = (permission: string): string =>
  ALL_ROLES.filter((r) => has(r, permission)).join(",");

function main(): void {
  // ── The permission list itself ───────────────────────────────────────────
  console.log("\n— the permission list —");

  const unique = new Set<string>(PERMISSIONS);
  check("no permission is listed twice", unique.size, PERMISSIONS.length);
  checkTrue(
    "every permission is namespaced `subject:verb`",
    PERMISSIONS.every((p) => /^[a-z_]+:[a-z_]+$/.test(p)),
  );

  // ── The derived grants ───────────────────────────────────────────────────
  //
  // These three are computed from PERMISSIONS, so they move whenever the list
  // does — which is exactly why they are asserted rather than assumed.
  console.log("\n— grants nobody writes down —");

  check("owner holds every permission", permissionsForRole("owner").length, PERMISSIONS.length);
  check(
    "admin holds every permission except settings:write",
    permissionsForRole("admin").length,
    PERMISSIONS.length - 1,
  );
  check("and that one exception is settings:write", has("admin", "settings:write"), false);

  const readOnlyCount = PERMISSIONS.filter((p) => p.endsWith(":read")).length;
  check("readonly holds exactly the :read permissions", permissionsForRole("readonly").length, readOnlyCount);
  checkTrue(
    "so readonly can write NOTHING, whatever is added to the list later",
    permissionsForRole("readonly").every((p) => p.endsWith(":read")),
  );

  // ── The boundaries, as whole sets ────────────────────────────────────────
  console.log("\n— boundaries —");

  // Sales owns the commercial relationship on an AMC. An operations manager
  // reads that term sheet and does not write it, and that is deliberate rather
  // than an oversight — see the M5 note in rbac.ts.
  check("contracts:write is owner, admin and sales — and nobody else", holders("contracts:write"), "owner,admin,sales");

  // M5. A project is a piece of work, not a commercial relationship, so it has
  // its own pair rather than borrowing the contract's. Widening contracts:write
  // to reach it would have moved the boundary above as a side effect.
  check(
    "projects:write is owner, admin, operations_manager and sales",
    holders("projects:write"),
    "owner,admin,operations_manager,sales",
  );
  check(
    "projects:read adds the accountant and readonly on top of those",
    holders("projects:read"),
    "owner,admin,operations_manager,accountant,sales,readonly",
  );

  // The money boundary. A dispatcher who can raise an invoice is a segregation
  // failure, not a convenience.
  check("invoices:create is owner, admin and accountant", holders("invoices:create"), "owner,admin,accountant");
  check("users:manage is owner and admin", holders("users:manage"), "owner,admin");
  check("settings:write is the owner alone", holders("settings:write"), "owner");

  // ── The pairings that make a split real ──────────────────────────────────
  console.log("\n— separations of duties —");

  // PRJ-3. Certifying a stage of work and allocating a sequential tax-invoice
  // number are different acts by different people. Both halves have to be
  // reachable by the person who performs them, or the split is a dead end.
  checkTrue(
    "the accountant can open a project AND raise its invoice",
    has("accountant", "projects:read") && has("accountant", "invoices:create"),
  );
  checkTrue(
    "and cannot certify the milestone they are invoicing",
    !has("accountant", "projects:write"),
  );
  checkTrue(
    "the operations manager can certify it and cannot allocate the number",
    has("operations_manager", "projects:write") && !has("operations_manager", "invoices:create"),
  );

  // ── Roles that must not reach things ─────────────────────────────────────
  console.log("\n— what the field cannot do —");

  for (const role of ["dispatcher", "technician", "supervisor"] as Role[]) {
    checkTrue(`${role} holds no :write on money or projects`,
      !has(role, "invoices:create") && !has(role, "projects:write") && !has(role, "contracts:write"));
  }
  // Scoped further at the query layer to their own customer account. The
  // permission says "may read jobs"; it does not say "may read every job".
  checkTrue(
    "a portal customer reaches no project screen at all",
    !has("customer", "projects:read") && !has("customer", "projects:write"),
  );

  // ── Overrides ────────────────────────────────────────────────────────────
  console.log("\n— per-user overrides —");

  const base: Principal = { userId: "u", tenantId: "t", role: "dispatcher" };

  check("a role that lacks a permission is refused", can(base, "invoices:create"), false);
  check(
    "an override of true grants it",
    can({ ...base, overrides: { "invoices:create": true } }, "invoices:create"),
    true,
  );
  // Deny always wins. An override of false cannot be overcome by a generous
  // role, which is what makes tightening possible without an eleventh role.
  check(
    "an override of false REFUSES a permission the role grants",
    can({ userId: "u", tenantId: "t", role: "owner", overrides: { "users:manage": false } }, "users:manage"),
    false,
  );
  check(
    "an unrelated override does not disturb the role's other grants",
    can({ ...base, overrides: { "invoices:create": true } }, "jobs:assign"),
    true,
  );

  // ── canAll / canAny ──────────────────────────────────────────────────────
  const accountant: Principal = { userId: "u", tenantId: "t", role: "accountant" };
  const milestonePair: readonly Permission[] = ["projects:read", "invoices:create"];

  checkTrue("canAll is true when every permission is held", canAll(accountant, milestonePair));
  check(
    "canAll is false when one is missing",
    canAll(accountant, ["projects:read", "projects:write"]),
    false,
  );
  checkTrue("canAny is true when one is held", canAny(accountant, ["projects:write", "projects:read"]));
  check("canAny over an empty list is false", canAny(accountant, []), false);
  checkTrue("canAll over an empty list is vacuously true", canAll(accountant, []));

  // ── requirePermission ────────────────────────────────────────────────────
  let threw: unknown = null;
  try {
    requirePermission(base, "settings:write");
  } catch (error) {
    threw = error;
  }
  checkTrue("requirePermission throws ForbiddenError", threw instanceof ForbiddenError);
  check(
    "and names the permission, so a 403 can say which",
    (threw as ForbiddenError)?.permission,
    "settings:write",
  );

  // ── Staff versus portal ──────────────────────────────────────────────────
  console.log("\n— staff versus portal —");

  // `hr` was missing from STAFF_ROLES once, which made the role unusable rather
  // than merely limited: every staff screen bounced to /portal and then to
  // /denied. Asserted as a set for the same reason the boundaries above are.
  check(
    "every role except customer is staff",
    STAFF_ROLES.slice().sort().join(","),
    ALL_ROLES.filter((r) => r !== "customer").slice().sort().join(","),
  );
  check("a portal customer is not staff", isStaff("customer"), false);

  console.log(fail === 0 ? "\nrbac: all checks passed" : `\n${fail} check(s) failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
