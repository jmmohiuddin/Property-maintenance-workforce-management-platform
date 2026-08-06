/**
 * Database access with a mandatory tenant boundary.
 *
 * The only supported way to touch tenant data is `withTenant()`. It opens a
 * transaction, sets `app.tenant_id` as a transaction-local setting, and runs
 * your callback inside it. Postgres RLS policies read that setting, so a query
 * that forgets its `WHERE tenant_id` clause returns nothing rather than
 * returning another tenant's rows.
 *
 * `set_config(..., true)` — the third argument — scopes the setting to the
 * transaction. Without it the value would leak to the next checkout of the same
 * pooled connection, which is the classic way RLS multi-tenancy gets silently
 * defeated.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";
export * from "./domain";
export * from "./schema";

/**
 * Connects as the *application* role, which must NOT be the table owner and
 * must NOT have BYPASSRLS. A superuser connection silently ignores every policy
 * below, so `assertNotBypassingRls()` checks it at boot.
 *
 * Created lazily. Connecting at module load would mean that merely importing
 * this package - which a route bundle can do transitively without ever running
 * a query - requires DATABASE_URL to be set, breaking builds of pages that
 * never touch the database.
 */
let _client: ReturnType<typeof postgres> | undefined;

/**
 * Fallback loader for the monorepo-root .env.
 *
 * Next loads it via next.config.ts, but scripts and tests run under plain tsx
 * with no such hook - so without this, `npm run test` fails at the root with a
 * missing DATABASE_URL and every contributor has to know to source .env by
 * hand. Existing environment variables always win, so real deployment config is
 * never overwritten.
 */
function loadDotEnvOnce(): void {
  if (process.env["DATABASE_URL"]) return;
  try {
    // Required lazily so bundlers never try to follow node:fs into a browser build.
    const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");

    for (const candidate of ["../../.env", "../.env", ".env"]) {
      const path = resolve(process.cwd(), candidate);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        process.env[key] ??= trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      }
      return;
    }
  } catch {
    // No filesystem (edge runtime, browser). The explicit error below is the
    // right failure in that case anyway.
  }
}

function getClient(): ReturnType<typeof postgres> {
  if (_client) return _client;

  loadDotEnvOnce();

  const connectionString = process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
  }

  _client = postgres(connectionString, {
    max: Number(process.env["DATABASE_POOL_MAX"] ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // required when running behind a transaction-mode pooler
  });
  return _client;
}

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  _db ??= drizzle(getClient(), { schema, logger: process.env["NODE_ENV"] === "development" });
  return _db;
}

/**
 * The Drizzle instance. A Proxy so that `db.select(...)` connects on first use
 * rather than on import, while callers still write `db.x` normally.
 */
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});

/**
 * Verify at startup that we are NOT connected as a superuser or a BYPASSRLS
 * role.
 *
 * This is the single most dangerous misconfiguration in this codebase and it
 * fails silently: a superuser connection ignores every RLS policy, so tenant
 * isolation disappears with no error, no log line and no failing test. Every
 * query keeps working - it just returns other tenants' rows too.
 *
 * Called once on boot. In production it throws; in development it warns loudly,
 * so a developer pointing at a superuser DATABASE_URL finds out immediately
 * instead of when a customer does.
 */
export async function assertNotBypassingRls(): Promise<void> {
  const rows = await getClient()<{ rolsuper: boolean; rolbypassrls: boolean; current_user: string }[]>`
    select current_user, rolsuper, rolbypassrls
    from pg_roles where rolname = current_user
  `;
  const row = rows[0];
  if (!row) return;

  if (row.rolsuper || row.rolbypassrls) {
    const message =
      `DATABASE_URL connects as "${row.current_user}", which ` +
      `${row.rolsuper ? "is a SUPERUSER" : "has BYPASSRLS"}. ` +
      `Row-level security is being bypassed and tenant isolation is NOT in effect. ` +
      `Connect as an application role with NOBYPASSRLS (see packages/db/sql/rls.sql).`;

    if (process.env["NODE_ENV"] === "production") throw new Error(message);
    console.error(`\n[db] ${"!".repeat(70)}\n[db] ${message}\n[db] ${"!".repeat(70)}\n`);
  }
}

export type Database = typeof db;
export type TenantScopedTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface TenantContext {
  readonly tenantId: string;
  readonly userId?: string;
  readonly actorKind?: "user" | "system" | "ai" | "customer";
  readonly requestId?: string;
}

/**
 * Runs `fn` inside a transaction bound to one tenant. Everything that reads or
 * writes tenant data goes through here.
 */
export async function withTenant<T>(ctx: TenantContext, fn: (tx: TenantScopedTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true)`);
    await tx.execute(sql`select set_config('app.actor_kind', ${ctx.actorKind ?? "user"}, true)`);
    await tx.execute(sql`select set_config('app.request_id', ${ctx.requestId ?? ""}, true)`);
    return fn(tx);
  });
}

/**
 * Runs `fn` scoped to one tenant AND one customer.
 *
 * For customer-portal requests. On top of the tenant boundary, this sets
 * `app.customer_id`, which restrictive policies on every customer-owned table
 * read (see sql/customer-scope.sql). A portal query that forgets its customer
 * filter therefore returns nothing rather than another customer's invoices -
 * the same safe-failure property the tenant boundary has.
 *
 * Never call this for staff. Staff sessions must leave the GUC unset, which is
 * what makes the dispatch board able to see every customer.
 */
export async function withCustomerScope<T>(
  ctx: TenantContext & { customerId: string },
  fn: (tx: TenantScopedTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${ctx.tenantId}, true)`);
    await tx.execute(sql`select set_config('app.customer_id', ${ctx.customerId}, true)`);
    await tx.execute(sql`select set_config('app.user_id', ${ctx.userId ?? ""}, true)`);
    await tx.execute(sql`select set_config('app.actor_kind', ${ctx.actorKind ?? "customer"}, true)`);
    return fn(tx);
  });
}

/**
 * Escape hatch for genuinely cross-tenant work: login lookup by email, platform
 * admin reporting, migrations. Deliberately awkward to call and deliberately
 * loud, because every use is a place where the tenant boundary does not protect
 * you and a reviewer needs to check the query by hand.
 */
export async function withoutTenantBoundary<T>(reason: string, fn: (database: Database) => Promise<T>): Promise<T> {
  if (process.env["NODE_ENV"] !== "test") {
    console.warn(`[db] cross-tenant query: ${reason}`);
  }
  return fn(db);
}

export async function closeConnection(): Promise<void> {
  await _client?.end({ timeout: 5 });
  _client = undefined;
  _db = undefined;
}
