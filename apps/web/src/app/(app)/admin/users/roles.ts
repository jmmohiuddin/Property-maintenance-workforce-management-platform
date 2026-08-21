/**
 * Role vocabulary for the admin screen.
 *
 * A plain module rather than part of `actions.ts`, because a `"use server"`
 * file may only export async functions — every export from one becomes a
 * callable server endpoint, so a constant exported alongside them is a build
 * error rather than a style problem. Splitting the data out is the fix, and it
 * is the better shape anyway: the label map is read by client components that
 * have no business importing the action module.
 */

/**
 * Roles an administrator may assign from this screen.
 *
 * `customer` is absent deliberately. Portal access is granted from the customer
 * record (`POR-8`), where the person is attached to a specific customer
 * account — a `customer` membership with no `customer_id` would be a portal
 * login scoped to nothing, which `requirePortalSession` refuses anyway.
 *
 * Checked server-side on every submission. A `<select>` is a suggestion; a form
 * post is whatever the sender chose to put in it.
 */
export const ASSIGNABLE_ROLES = [
  "owner",
  "admin",
  "operations_manager",
  "dispatcher",
  "supervisor",
  "technician",
  "accountant",
  "sales",
  "hr",
  "readonly",
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Role names as a person would say them, not as the enum spells them. */
export const ROLE_LABEL: Readonly<Record<string, string>> = {
  owner: "Owner",
  admin: "Administrator",
  operations_manager: "Operations manager",
  dispatcher: "Dispatcher",
  supervisor: "Supervisor",
  technician: "Technician",
  accountant: "Accountant",
  sales: "Sales",
  hr: "HR",
  customer: "Customer (portal)",
  readonly: "Read-only",
};

export const ASSIGNABLE_ROLE_OPTIONS = ASSIGNABLE_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABEL[role] ?? role,
}));

export function isAssignableRole(value: string): value is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(value);
}

/**
 * Is this role managed from THIS screen?
 *
 * `customer` is not. Portal access belongs to the customer record (`POR-8`),
 * where the person is attached to a specific customer account.
 *
 * This matters more than it looks. A `<select>` whose `defaultValue` is not
 * among its options does not show a blank — it silently displays the FIRST
 * option. So a portal user rendered with the staff role picker appeared to be
 * an "Owner", and submitting that form without touching it would have promoted
 * a customer contact to owner of the tenant. Found by looking at the screen
 * with real seed data in it, which is the argument for doing that.
 */
export function isManagedHere(role: string): boolean {
  return isAssignableRole(role);
}
