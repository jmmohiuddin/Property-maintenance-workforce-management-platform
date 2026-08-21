/**
 * Role-based access control.
 *
 * Two layers, deliberately:
 *
 *   1. A role grants a fixed default set of permissions. Roles are coarse and
 *      there are only ten of them, because a role list that grows with every
 *      customer request stops being comprehensible and therefore stops being
 *      auditable.
 *   2. `memberships.permission_overrides` flips individual permissions on or
 *      off for one person. This exists so a tenant can tighten (or, rarely,
 *      loosen) without us inventing an eleventh role.
 *
 * Deny always wins: an override of `false` cannot be overcome by the role.
 *
 * This is an authorisation layer, NOT the tenant boundary. Tenant isolation is
 * enforced in Postgres (see docs/adr/0003-multi-tenancy.md); RBAC decides what
 * a user may do *within* a tenant they already have access to. Confusing the
 * two is how people end up with an authorisation check as their only defence
 * against cross-tenant reads.
 */

export const PERMISSIONS = [
  "jobs:read",
  "jobs:create",
  "jobs:update",
  "jobs:assign",
  "jobs:close",
  "jobs:delete",
  "quotes:read",
  "quotes:create",
  "quotes:send",
  "quotes:approve",
  "invoices:read",
  "invoices:create",
  "invoices:void",
  "payments:read",
  "payments:record",
  "customers:read",
  "customers:write",
  "properties:read",
  "properties:write",
  "technicians:read",
  "technicians:write",
  // ADM-1 / M10. Employment records, statutory documents and their expiry
  // dates. Separate from technicians:write because the compliance board holds
  // passport and visa data, and a dispatcher who may correct a technician's
  // skill list has no business reading it.
  "workforce:read",
  "workforce:write",
  "contracts:read",
  "contracts:write",
  "reports:read",
  "audit:read",
  "users:manage",
  "settings:write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export type Role =
  | "owner"
  | "admin"
  | "operations_manager"
  | "dispatcher"
  | "supervisor"
  | "technician"
  | "accountant"
  | "sales"
  | "hr"
  | "customer"
  | "readonly";

const ALL = PERMISSIONS;
const READ_ONLY = PERMISSIONS.filter((p) => p.endsWith(":read")) as readonly Permission[];

/**
 * Default grants per role. Written out in full rather than composed from
 * inheritance: a reviewer needs to see exactly what a role can do without
 * resolving a hierarchy in their head, and the duplication is the price.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  owner: ALL,

  admin: ALL.filter((p) => p !== "settings:write"),

  operations_manager: [
    "workforce:read",
    "jobs:read",
    "jobs:create",
    "jobs:update",
    "jobs:assign",
    "jobs:close",
    "quotes:read",
    "quotes:create",
    "customers:read",
    "customers:write",
    "properties:read",
    "properties:write",
    "technicians:read",
    "technicians:write",
    "contracts:read",
    "reports:read",
  ],

  dispatcher: [
    "jobs:read",
    "jobs:create",
    "jobs:update",
    "jobs:assign",
    "customers:read",
    "properties:read",
    "technicians:read",
    "contracts:read",
  ],

  supervisor: [
    "workforce:read",
    "jobs:read",
    "jobs:update",
    "jobs:close",
    "customers:read",
    "properties:read",
    "technicians:read",
  ],

  // Scoped further at the query layer to the technician's own visits. The
  // permission says "may read jobs"; it does not say "may read every job".
  technician: ["jobs:read", "jobs:update", "properties:read"],

  accountant: [
    "jobs:read",
    "quotes:read",
    "invoices:read",
    "invoices:create",
    "invoices:void",
    "payments:read",
    "payments:record",
    "customers:read",
    "contracts:read",
    "reports:read",
  ],

  sales: [
    "jobs:read",
    "quotes:read",
    "quotes:create",
    "quotes:send",
    "customers:read",
    "customers:write",
    "properties:read",
    "properties:write",
    "contracts:read",
    "contracts:write",
  ],

  /**
   * HR. Owns hiring and the statutory document register.
   *
   * Reads jobs and technicians because a compliance block has to be understood
   * in the context of the work it stops, but holds no dispatch or money
   * permissions — filling a role and paying an invoice are different jobs.
   */
  hr: [
    "jobs:read",
    "technicians:read",
    "technicians:write",
    "workforce:read",
    "workforce:write",
    "reports:read",
  ],

  // Portal users. Scoped to their own customer account at the query layer.
  customer: [
    "jobs:read",
    "jobs:create",
    "quotes:read",
    "quotes:approve",
    "invoices:read",
    "properties:read",
    "contracts:read",
  ],

  readonly: READ_ONLY,
};

export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  /** Per-user overrides from `memberships.permission_overrides`. */
  readonly overrides?: Readonly<Record<string, boolean>>;
  /** Set for portal users; scopes queries to one customer account. */
  readonly customerId?: string | undefined;
  /** Set for staff who are also technicians; scopes "own jobs" queries. */
  readonly technicianId?: string | undefined;
}

export function permissionsForRole(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

export function can(principal: Principal, permission: Permission): boolean {
  // An explicit override decides, in either direction. Checked first so a
  // `false` override cannot be overridden by a generous role.
  const override = principal.overrides?.[permission];
  if (override !== undefined) return override;
  return ROLE_PERMISSIONS[principal.role].includes(permission);
}

export function canAll(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => can(principal, p));
}

export function canAny(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => can(principal, p));
}

/** Thrown by `requirePermission`. Callers map it to a 403. */
export class ForbiddenError extends Error {
  readonly permission: Permission;
  constructor(permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

/**
 * Assert a permission. Use at the top of every mutating action rather than
 * relying on the UI having hidden the button - the UI is a convenience, this
 * is the check.
 */
export function requirePermission(principal: Principal, permission: Permission): void {
  if (!can(principal, permission)) throw new ForbiddenError(permission);
}

/** Roles that see the operational application rather than the customer portal. */
export const STAFF_ROLES: readonly Role[] = [
  "owner",
  "admin",
  "operations_manager",
  "dispatcher",
  "supervisor",
  "technician",
  "accountant",
  "sales",
  "readonly",
];

export function isStaff(role: Role): boolean {
  return STAFF_ROLES.includes(role);
}
