# ADR 0003: Tenant isolation via Postgres row-level security

**Status:** Accepted · **Date:** 2026-08-06

## Context

The platform is multi-tenant: several maintenance companies share one database. A
cross-tenant data leak is the most severe failure this system can have, and the most likely cause is
mundane — one query missing its `WHERE tenant_id` clause.

We needed to choose where the tenant boundary lives.

## Options considered

**A. Database per tenant.** Strongest isolation. Rejected: migrations across hundreds of databases,
connection-pool explosion, and cross-tenant reporting becomes a data pipeline. The operational cost
is real and arrives immediately; the isolation benefit over option C is marginal once RLS is forced.

**B. Schema per tenant.** Middle ground. Rejected: `search_path` manipulation is its own footgun,
and it has most of A's migration pain with less of its isolation.

**C. Shared schema + application-level filtering.** Simplest. Rejected outright: the boundary is
then "every developer remembers every time", which is not a boundary. One missed clause in one query
is a breach.

**D. Shared schema + forced Postgres RLS.** Chosen.

## Decision

Shared tables with `tenant_id`, `ENABLE` *and* `FORCE ROW LEVEL SECURITY`, and a policy filtering on
a transaction-local `app.tenant_id` GUC. The application connects as `meridian_app`, which does not
own the tables and has `NOBYPASSRLS`.

`withTenant(ctx, fn)` in [`packages/db/src/index.ts`](../../packages/db/src/index.ts) is the only
supported entry point: it opens a transaction, sets the GUC transaction-locally, and runs the
callback.

## Consequences

**Good.** A query missing its `WHERE tenant_id` returns zero rows rather than another tenant's data.
The boundary is enforced by the database for every client — the app, a psql session, a future
reporting tool. Adding a table with a `tenant_id` column and re-running `rls.sql` covers it
automatically.

**Bad.** Every tenant-scoped query must run inside `withTenant()`, which is a discipline the codebase
has to hold. Policies add a small per-query planning cost. And cross-tenant operations — login by
email, platform admin — need the deliberately awkward `withoutTenantBoundary()` escape hatch, which
is a real hole that has to stay narrow.

**Non-obvious.** `FORCE` is load-bearing. Without it, policies are skipped for the table owner, so a
deployment that connects as the owner silently loses all isolation with no error. Likewise the third
argument to `set_config(..., true)`: without it, the tenant value survives on a pooled connection
into the next request.

## Verification

Ten checks in [`sql/verify-rls.sql`](../../packages/db/sql/verify-rls.sql), all passing against
PostgreSQL 16, covering read, write, update, delete, context switching, unprotected tables, and the
`BYPASSRLS` attribute. Run in CI on every migration.

Two real bugs in the append-only audit log were caught by these checks during development. That is
the argument for this ADR having an executable test rather than a review checklist.
