# ADR 0001: Frontend and backend stack

**Status:** Accepted · **Date:** 2026-08-06

## Context

Greenfield build with two very different surfaces: a public marketing site that must be crawlable by
answer engines, and an operational application with real-time dispatch and an offline mobile client.

## Decision

**Next.js 16 (App Router) + React 19, statically prerendered for the marketing site.**

The crawlability requirement decides this. Many AI crawlers do not execute JavaScript, so any
structured data, FAQ answer or extractable answer paragraph that only exists after hydration is
invisible to them. A client-rendered SPA fails the primary requirement of the project outright.
React Server Components additionally keep shipped JS near zero on content pages.

**Tailwind v4 with CSS custom properties for semantic tokens.**

Components reference `--surface` and `--text-muted`, not raw palette values, so dark mode is one
override block rather than a `dark:` variant on every utility. Contrast is verified by
[a script](../../apps/web/scripts/check-contrast.mjs) rather than by review, because colour pairings
are the one design decision with an objectively correct answer.

**PostgreSQL 16 + Drizzle ORM.**

Postgres is chosen for RLS specifically (see [ADR 0003](0003-multi-tenancy.md)). Drizzle over Prisma
because it is SQL-first, which makes `set_config` and raw policy interaction natural; Prisma's
abstraction layer fights the transaction-local session-variable pattern that RLS depends on.

**Zod 4 for validation, shared across client, server action and API.**

One schema means client and server validation cannot drift.

**TypeScript 7 across all workspaces.**

Note that TS 7 does not auto-discover ambient `@types` the way TS 5 did, so Node-only packages
declare `"types": ["node"]` explicitly. Recorded because it cost time to diagnose.

**npm workspaces, not a heavier monorepo tool.**

Three packages does not justify Turborepo or Nx. Revisit at ten.

## Rejected

- **Remix / TanStack Start** — comparable, but Next's static prerendering and metadata API are the
  most mature for the crawlability requirement, and that is the requirement that matters most here.
- **Astro** — arguably better for the marketing site alone, but the platform needs a real application
  framework and one stack across both surfaces is worth more than a marginal marketing-site win.
- **Supabase / Firebase** — faster to start, but the tenant boundary is the core security property of
  this system and it should not depend on a vendor's policy layer.
- **A CMS** — deferred to phase 3. Content in typed TypeScript gives type safety and makes structured
  data impossible to desync from page copy, which is worth more than editor convenience until
  non-engineers need to publish.

## Consequences

Static generation means content changes require a rebuild. At 24 service pages this is seconds; if
the catalogue grows past a few hundred pages, move to ISR.

Semantic CSS tokens mean some inline `style` attributes where a Tailwind arbitrary value would need
the token anyway. Accepted for the dark-mode simplification it buys.
