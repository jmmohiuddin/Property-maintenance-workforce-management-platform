import "server-only";
import { UserFacingError } from "@meridian/core";

/**
 * Decide what a failed action is allowed to say.
 *
 * The first version of the portal request form rendered `error.message`
 * straight from the catch block. When reference allocation collided, the
 * customer was shown the full INSERT statement with every parameter in it —
 * useless to them, and a disclosure of the schema to anyone who could make it
 * fail. Only errors the domain deliberately wrote for a human are rendered;
 * everything else is logged where operations can see it and replaced with a
 * sentence that says what to do next.
 */
export function userMessage(error: unknown, fallback: string, context?: string): string {
  if (error instanceof UserFacingError) return error.message;

  console.error(`[action:${context ?? "unknown"}]`, error);
  return fallback;
}
