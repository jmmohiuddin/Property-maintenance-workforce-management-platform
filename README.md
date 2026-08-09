# Meridian Platform

An AI-assisted property maintenance and contract workforce management platform, plus the
answer-engine-optimised public website that feeds it.

**Status: phases 1 and 2 complete and verified.** The whole
commercial loop runs on real data with row-level security active: a public enquiry becomes a lead, a
lead converts to a customer, property and job, the job appears on the dispatch board, a technician is
ranked and assigned, the customer approves a quote in their own portal, raises further requests
there, the work is signed off and invoiced, and every step is written to an audit trail by a database
trigger. Notifications are queued transactionally and retried — but the only transport is a console
one, so **nothing actually reaches a customer until a provider is wired**. The mobile app and AI layer
are designed and scheduled but not implemented. See [docs/architecture/05-roadmap.md](docs/architecture/05-roadmap.md)
for exactly what exists and what does not.

**Live:** <https://meridian-platform-jmmohiuddins-projects.vercel.app> — Vercel, with Postgres on Neon
(`ap-southeast-1`). Serverless functions are pinned to `sin1` in [apps/web/vercel.json](apps/web/vercel.json)
so they sit beside the database rather than crossing an ocean for every query. Sign in with any seeded
account below; the deployed database carries the same demo seed.

---

## Deploying

The application connects as `meridian_app`, never as the database owner. That is the whole security
model, so it survives deployment or it does not exist: the owner role Neon hands you has `BYPASSRLS`,
and connecting as it silently disables every policy in `sql/rls.sql` with no error. After running the
migrations and SQL files against the owner connection, give `meridian_app` a password and point
`DATABASE_URL` at *that* role, through the pooled (`-pooler`) host.

Only four variables belong in the deployment: `DATABASE_URL`, `DATABASE_POOL_MAX`,
`PUBLIC_TENANT_SLUG`, `NEXT_PUBLIC_SITE_URL`. Managed Postgres integrations tend to inject a dozen
more (`PGPASSWORD`, `POSTGRES_URL`, `DATABASE_URL_UNPOOLED`, …), all carrying owner credentials and
none of them read by this codebase — delete them rather than leaving a `BYPASSRLS` connection string
sitting in the runtime environment. `DATABASE_ADMIN_URL` is for migrations and seeding only and must
never be set on the web deployment.

Two deployment-specific notes worth keeping:

- Set `NEXT_PUBLIC_SITE_URL` to the real production domain **before** the build. Every canonical URL,
  the sitemap and all JSON-LD are generated from it at build time, so a wrong value is baked into the
  static output rather than corrected at runtime.
- Store `DATABASE_POOL_MAX` and `PUBLIC_TENANT_SLUG` as plain variables, not "sensitive" ones. Vercel
  withholds sensitive values from the build step, and neither is a secret.

---

## What is here

| Package | What it is | State |
| --- | --- | --- |
| `apps/web` | Public site (60 static routes), operational app, and customer portal | Built, verified in browser |
| `packages/core` | Service catalogue, area data, tenant profile, JSON-LD, exact-decimal money, validation, QR encoder | Built |
| `packages/db` | Schema (31 tables), tenant + customer RLS, audit triggers, job/SLA/commerce/workforce domain, seed | Built, verified against real Postgres |
| `packages/auth` | Argon2id hashing, revocable sessions, 10-role RBAC, TOTP two-factor with recovery codes | Built, verified end to end |
| `packages/notify` | Templates, transactional queue, retry with attempt limits, pluggable transport | Built, verified — console transport only |
| `docs/` | Architecture, ADRs, security model, AEO/GEO playbook, roadmap | Written |

## Quick start

Requires Node 20+ and PostgreSQL 14+.

```bash
npm install && cp .env.example .env
```

Create the database, apply the schema, the security policies and the authentication surface, then
prove the tenant boundary holds:

```bash
createdb meridian_dev && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/drizzle/0000_init.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/drizzle/0001_huge_stardust.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/drizzle/0002_futuristic_joshua_kane.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/rls.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/auth-functions.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/public-functions.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/customer-scope.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/reference.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/mfa-functions.sql && psql -d meridian_dev -v ON_ERROR_STOP=1 -f packages/db/sql/verify-rls.sql
```

That last file runs twelve isolation checks and exits non-zero if any fail. **Run it in CI on every
migration** — it is the gate that matters most in this repo.

Give the application role a password, then load demo data:

```bash
psql -d meridian_dev -c "ALTER ROLE meridian_app WITH PASSWORD 'meridian_dev_only';" && npm run db:seed
```

Run everything:

```bash
npm run dev
```

The public site is at `/`. Sign in at `/login` — the seed prints seven accounts, all with the
password `MeridianDev2026!`. Two are worth trying specifically:

- `hana@gulfpropertycare.example` — a different **tenant**. Same dispatch board, none of the first
  tenant's jobs.
- `fatima@baytower.example` — a **customer portal** user. Sees only Bay Tower's jobs, quotes and
  invoices, and every staff route bounces her back to the portal.

Both boundaries are enforced by Postgres, not by a `WHERE` clause.

For a quotation awaiting a customer decision:

```bash
npx tsx packages/db/scripts/demo-quote.ts
```

> **`DATABASE_URL` must not be a superuser.** A superuser connection silently ignores every RLS
> policy, so tenant isolation disappears with no error and no failing test. `packages/db` checks the
> live connection at boot: it throws in production and prints a loud banner in development. Seeds and
> migrations use the separate `DATABASE_ADMIN_URL`.

Run all checks (types across every workspace, the transition-graph tests, and the WCAG contrast
gate):

```bash
npm run check
```

## The three decisions worth knowing before reading the code

**1. Both boundaries live in the database, not the application.**
Every tenant-scoped table has forced row-level security keyed on a transaction-local
`app.tenant_id`. A query that forgets its `WHERE tenant_id` clause returns zero rows instead of
another tenant's data. The application connects as a role with `NOBYPASSRLS` that does not own the
tables. A second, *restrictive* layer keyed on `app.customer_id` scopes portal sessions to one
customer on top of that, so a forgotten filter in the portal returns nothing rather than another
customer's invoices. Rationale and the alternatives rejected:
[docs/adr/0003-multi-tenancy.md](docs/adr/0003-multi-tenancy.md).

**2. The service catalogue is one file, and everything reads from it.**
[`packages/core/src/catalog.ts`](packages/core/src/catalog.ts) is the single source of truth for
marketing pages, `Service` and `FAQPage` structured data, `llms.txt`, the sitemap, the quote form's
service picker and (later) the job taxonomy the dispatcher schedules against. Adding a service is
one object; it appears everywhere automatically and cannot drift out of sync with the structured
data. This is what makes the AEO claims structurally true rather than a review checklist.

**3. The website is statically rendered, deliberately.**
Many AI crawlers do not execute JavaScript. Anything an answer engine needs to read has to be in
the HTML response, so structured data, FAQ answers and the per-page answer paragraph are all
server-rendered. The FAQ uses native `<details>` rather than a JS accordion for the same reason.

## Documentation

| Document | Read it when |
| --- | --- |
| [**Product & Technical Master Document**](docs/master/00-README.md) | **Start here.** The post-hoc product/engineering audit and single source of truth: PRD, design spec, technical architecture, debt registers, risk register, backlog, roadmap. Where it disagrees with any older document, it wins. |
| [Assumptions](docs/product/00-assumptions.md) | Before anything else. Several defaults are guesses that need confirming. |
| [Personas and user stories](docs/product/01-personas-and-stories.md) | Deciding what to build next |
| [System architecture](docs/architecture/01-system-architecture.md) | Understanding how the pieces fit |
| [Data model](docs/architecture/02-data-model.md) | Working on the schema |
| [Security model](docs/architecture/03-security.md) | Any change touching auth, tenancy or PII |
| [Data lifecycle](docs/architecture/04-data-lifecycle.md) | Working on telemetry, GPS or retention |
| [Roadmap](docs/architecture/05-roadmap.md) | Planning, or wondering whether something exists yet |
| [AEO/GEO playbook](docs/architecture/06-aeo-geo.md) | Writing content or touching structured data |
| [Launch checklist](docs/ops/03-launch-checklist.md) | Before the site goes live |
| [ADRs](docs/adr/) | Wondering why a decision was made |

## Verification status

Claims in this README that have been executed rather than asserted:

- `npm run typecheck` passes across all six workspaces; `npm run test` passes 216 checks across ten suites
- `npm run check:contrast` passes 36/36 token pairings at WCAG AA
- `next build` produces 66 routes: 24 prerendered service pages, 19 area pages, the rest static or dynamic
- Schema applied to PostgreSQL 16; all 12 RLS isolation checks pass
- JSON-LD parsed and validated across 10 blocks on 9 pages, 0 invalid
- Quote form submitted end to end in a browser: success path and validation-failure path both confirmed
- Full internal link crawl from `/`: 59 URLs, zero dead links
- `/sitemap.xml` returns 53 URLs; `/privacy` and `/terms` correctly noindex and excluded
- Login verified end to end in a browser; session cookie confirmed `httpOnly` (invisible to JS)
- **Tenant isolation verified through the running application**: signed in as tenant 2, the dispatch
  board shows 1 job and none of tenant 1's 13 — enforced by Postgres, not by a query filter
- All seven `app_auth_*` functions granted only to `meridian_app`; audit confirms no `SECURITY
  DEFINER` function is missing a pinned `search_path`
- Unauthenticated app routes 307 to `/login`
- **Full operational loop driven in a browser**: public quote form → lead in the database → converted
  to customer, property and job in one transaction → technician ranked (0.8 km scored 4, Abu Dhabi
  122.6 km scored 123) → assigned → job moved Triaged → Dispatched → En route, each step in the
  timeline with its reason
- Status transition graph unit-tested: illegal moves rejected, terminal states are dead ends, every
  status reachable (`npm run test`)
- Audit trail confirmed written by the database trigger, not by application code
- **Money arithmetic unit-tested**: integer minor units end to end, `0.10 + 0.20` is exactly `0.30`,
  VAT charged on the discounted amount, 37 fractional lines sum exactly, discount capped at subtotal
- **Commerce integration-tested against real Postgres** (24 checks): quote totals exact, raw approval
  token never stored, single-use, re-send and double-decide both rejected, invoicing an unsigned job
  refused, part/full payment status derived from amounts, negative payment rejected
- **Customer boundary proven through the running app**: the portal user sees 3 of the tenant's 13
  jobs, cannot read another customer's quote or its prices, cannot pay against their invoice, and is
  redirected away from `/dispatch`, `/jobs`, `/leads` and `/invoices`

- **TOTP checked against all six RFC 6238 test vectors**, including the one past a 32-bit counter.
  A self-consistent implementation that disagrees with the RFC produces codes no authenticator app
  will ever match, and nothing but the vectors catches that
- **Two-factor flow integration-tested end to end** (32 checks): enrolment writes nothing until a
  live code proves the app holds the secret, a password alone yields a challenge rather than a
  session, a code cannot be replayed within its step or on a fresh challenge, a challenge cannot be
  completed twice, guesses are capped, an expired challenge is refused, recovery codes work once and
  tolerate being retyped in lower case, and turning it off keeps the current session while revoking
  every other one
- **The QR encoder is proved by decoding it back** — the test contains a decoder that reads the
  matrix the way a scanner would, and the format bits are compared against the value published in
  ISO/IEC 18004 Table C.1
- **Customer accounts integration-tested** (23 checks): outstanding balance matches the invoice rows
  it came from to the fil, a part payment moves it by exactly the amount paid, written-off debt is
  excluded, promoting a second primary contact demotes the first, and coordinates are all-or-nothing
- **Reference allocation integration-tested**: 12 concurrent allocations produce 12 distinct
  references, and a portal customer who can see only a handful of the tenant's jobs still gets a
  number above every stored one — the bug that made the first customer-raised request fail
- **Notification pipeline integration-tested** (27 checks): queued inside the caller's transaction,
  never sent twice, empty address skipped rather than failed, transient failure retried with the
  attempt count rising, recovery after failure, non-retryable failure abandoned, abandoned rows never
  retried, a date that round-tripped through JSONB still renders, and a template that throws is
  recorded as a retryable failure rather than stranded mid-flight
- **Workforce integration-tested against real Postgres** (17 checks): signing off a skill makes a
  technician a dispatch candidate and withdrawing it removes them, re-signing re-grades instead of
  duplicating, out-of-range proficiency rejected, a lapsed mandatory certification removes the
  candidate *and* reports why, removing it restores them
- **Portal request loop driven end to end**: a customer raises a request against their own property,
  it lands on the dispatch board as a triageable job, and a `request_received` message is queued in
  the same transaction

Not yet verified, because it needs a deployed environment: Core Web Vitals and real crawler
behaviour. **Not real: message delivery.** `ConsoleTransport` is the only transport, so every
"emailed" in the UI means "queued and printed". Not built at all: everything in the roadmap from
phase 3 onward.
